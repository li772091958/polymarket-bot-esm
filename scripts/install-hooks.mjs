#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

const hookPath = join(root, '.git', 'hooks', 'pre-commit');
const hookContent = `#!/bin/sh

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1

PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
export PATH

if command -v npm >/dev/null 2>&1; then
  NPM_BIN="npm"
elif [ -x /usr/local/bin/npm ]; then
  NPM_BIN="/usr/local/bin/npm"
else
  echo "npm not found; cannot run sensitive information check." >&2
  exit 1
fi

"$NPM_BIN" run check:secrets
`;

mkdirSync(dirname(hookPath), { recursive: true });
writeFileSync(hookPath, hookContent, { mode: 0o755 });
chmodSync(hookPath, 0o755);

console.log(`Installed pre-commit hook: ${hookPath}`);
