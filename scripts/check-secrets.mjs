#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const BLOCKED_ENV_FILE_RE = /^\.env(?:\..*)?$/;
const ALLOWED_ENV_FILE_RE = /^\.env\.(?:example|exmple)$/;
const SKIPPED_PATH_RE = /^(?:node_modules|dist)\/|(?:^|\/)(?:package-lock\.json|yarn\.lock)$/;
const ALLOW_PRAGMA_RE = /\b(?:allow-secret|pragma:\s*allow-secret)\b/i;

const VALUE_PLACEHOLDER_RE =
  /^(?:|["']?(?:xxx+|your[_-]?[a-z0-9_-]*|example|sample|placeholder|changeme|change_me|todo|none|null|undefined|dummy|test|redacted|<[^>]+>|\$\{[^}]+})["']?)$/i;

const ENV_SECRET_ASSIGNMENT_RE =
  /^\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|TOKEN|API_KEY|PRIVATE_KEY|PASSPHRASE|PASSWORD|MNEMONIC|SEED)[A-Z0-9_]*\s*=\s*["']?([^"'\s#]{8,})["']?/i;

const OBJECT_SECRET_ASSIGNMENT_RE =
  /\b(?:secret|token|apiKey|api_key|privateKey|private_key|passphrase|password|mnemonic|seed)\b\s*:\s*["'`]([^"'`]{8,})["'`]/i;

const RULES = [
  {
    name: 'private key block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
  {
    name: 'github token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  },
  {
    name: 'openai api key',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/,
  },
  {
    name: 'aws access key',
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  },
  {
    name: 'jwt token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    name: 'ethereum private key',
    pattern: /\b0x[a-fA-F0-9]{64}\b/,
  },
];

const runGit = args =>
  execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const getStagedFiles = () => {
  const output = runGit(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']);
  return output.split('\0').filter(Boolean);
};

const getStagedContent = file => {
  try {
    return runGit(['show', `:${file}`]);
  } catch {
    return '';
  }
};

const isBinary = content => content.includes('\0');

const lineIsAllowed = line => ALLOW_PRAGMA_RE.test(line);

const isPlaceholderValue = value => VALUE_PLACEHOLDER_RE.test(value.trim());

const scanLine = (file, line, lineNumber) => {
  if (lineIsAllowed(line)) return [];

  const findings = [];
  const assignment =
    line.includes('process.env')
      ? null
      : line.match(ENV_SECRET_ASSIGNMENT_RE) || line.match(OBJECT_SECRET_ASSIGNMENT_RE);
  if (assignment && !isPlaceholderValue(assignment[1] || '')) {
    findings.push({
      file,
      lineNumber,
      rule: 'secret-like assignment',
    });
  }

  for (const rule of RULES) {
    if (rule.pattern.test(line)) {
      findings.push({
        file,
        lineNumber,
        rule: rule.name,
      });
    }
  }

  return findings;
};

const scanFile = file => {
  if (SKIPPED_PATH_RE.test(file)) return [];

  if (BLOCKED_ENV_FILE_RE.test(file) && !ALLOWED_ENV_FILE_RE.test(file)) {
    return [
      {
        file,
        lineNumber: 1,
        rule: 'blocked env file',
      },
    ];
  }

  const content = getStagedContent(file);
  if (!content || isBinary(content)) return [];

  return content
    .split(/\r?\n/)
    .flatMap((line, index) => scanLine(file, line, index + 1));
};

const findings = getStagedFiles().flatMap(scanFile);

if (findings.length > 0) {
  console.error('Sensitive information check failed. Commit blocked.');
  console.error('');

  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.lineNumber} ${finding.rule}`);
  }

  console.error('');
  console.error('Remove the secret, or add "allow-secret" on the line only after manual review.');
  process.exit(1);
}

console.log('Sensitive information check passed.');
