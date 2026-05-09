import 'dotenv/config';
import { Effect } from 'effect';
import type { Hex } from 'viem';
import RedisService from '../middleware/RedisService.js';
import { cbc, getMarketBySlug } from '../polymarket/api.js';
import { mergePosition } from '../polymarket/relayer.js';

type MergeMode = 'slug' | 'condition';

type ParsedArgs = {
  mode: MergeMode;
  identifier: string;
  amount: number;
};

const CONDITION_ID_PATTERN = /^0x[a-fA-F0-9]{64}$/;

function usage(message?: string) {
  return [
    'Usage:',
    '  npm run merge -s <slug> <amount>',
    '  npm run merge -c <conditionId> <amount>',
    '  npm run merge -- -s <slug> <amount>',
    '  npm run merge -- -c <conditionId> <amount>',
    message ? `\n${message}` : '',
  ].join('\n');
}

function parseAmount(rawAmount: string | undefined) {
  if (!rawAmount) throw new Error('Missing amount');

  const amount = Number(rawAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Invalid amount: ${rawAmount}`);
  }

  return amount;
}

function inferMode(identifier: string): MergeMode {
  return CONDITION_ID_PATTERN.test(identifier) ? 'condition' : 'slug';
}

function parseArgs(args: string[]): ParsedArgs {
  let mode: MergeMode | undefined;
  let identifier: string | undefined;
  let amount: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '-s' || arg === '--slug') {
      mode = 'slug';
      identifier = args[index + 1];
      index += 1;
      continue;
    }

    if (arg === '-c' || arg === '--condition') {
      mode = 'condition';
      identifier = args[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (!identifier) {
      identifier = arg;
      continue;
    }

    if (amount === undefined) {
      amount = parseAmount(arg);
      continue;
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!identifier) throw new Error('Missing slug-or-conditionId');
  if (amount === undefined) amount = parseAmount(args.at(-1));

  return {
    mode: mode ?? inferMode(identifier),
    identifier,
    amount,
  };
}

function formatError(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  return error.stack || error.message;
}

async function resolveMergeTarget({ mode, identifier }: ParsedArgs) {
  if (mode === 'slug') {
    const market = await Effect.runPromise(getMarketBySlug(identifier));

    if (!market.conditionId) {
      throw new Error(`Market slug did not return conditionId: ${identifier}`);
    }

    return {
      conditionId: market.conditionId as Hex,
      negativeRisk: market.negRisk,
      title: market.question || market.title,
      slug: market.slug,
    };
  }

  if (!CONDITION_ID_PATTERN.test(identifier)) {
    throw new Error(`Invalid conditionId: ${identifier}`);
  }

  const marketInfo = await cbc.getClobMarketInfo(identifier);
  return {
    conditionId: identifier as Hex,
    negativeRisk: marketInfo.nr ?? false,
    title: identifier,
    slug: '',
  };
}

async function main() {
  let exitCode = 0;
  let parsed: ParsedArgs;

  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(usage(message));
    process.exit(1);
  }

  try {
    const target = await resolveMergeTarget(parsed);
    const result = await mergePosition({
      conditionId: target.conditionId,
      amount: parsed.amount,
      negativeRisk: target.negativeRisk,
    });

    console.log('Merge success:');
    console.table({
      mode: parsed.mode,
      identifier: parsed.identifier,
      title: target.title,
      slug: target.slug,
      conditionId: target.conditionId,
      amount: parsed.amount,
      negativeRisk: target.negativeRisk,
      transactionID: result.transactionID,
      transactionHash: result.transactionHash,
      state: result.state,
    });
  } catch (error) {
    console.error('Failed to merge market:', formatError(error));
    exitCode = 1;
  } finally {
    await RedisService.closeInstance();
    process.exit(exitCode);
  }
}

main();

