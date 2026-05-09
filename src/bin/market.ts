import 'dotenv/config';
import RedisService from '../middleware/RedisService.js';
import {
  findLatestUpDownMarket,
  inferUpDownAsset,
  inferUpDownInterval,
  type UpDownAsset,
  type UpDownInterval,
} from '../polymarket/marketSearch.js';

type ParsedArgs = {
  asset?: UpDownAsset;
  interval?: UpDownInterval;
  json: boolean;
  text: string;
};

function usage(message?: string) {
  return [
    'Usage:',
    '  npm run market -- --asset btc --interval 5m [--json]',
    '  npm run market -- "BTC 最近一次 5分钟 涨跌市场" [--json]',
    message ? `\n${message}` : '',
  ].join('\n');
}

function parseAsset(raw: string | undefined): UpDownAsset | undefined {
  if (!raw) return undefined;
  const value = raw.toLowerCase();
  if (value === 'btc' || value === 'eth' || value === 'sol' || value === 'xrp') return value;
  return inferUpDownAsset(value);
}

function parseInterval(raw: string | undefined): UpDownInterval | undefined {
  if (!raw) return undefined;
  const value = raw.toLowerCase();
  if (value === '5m' || value === '15m') return value;
  return inferUpDownInterval(value);
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { json: false, text: '' };
  const textParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--json') {
      parsed.json = true;
      continue;
    }

    if (arg === '--asset') {
      parsed.asset = parseAsset(args[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--interval') {
      parsed.interval = parseInterval(args[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    textParts.push(arg);
  }

  parsed.text = textParts.join(' ').trim();
  parsed.asset ??= inferUpDownAsset(parsed.text);
  parsed.interval ??= inferUpDownInterval(parsed.text);

  if (!parsed.asset) throw new Error('Missing asset, supported: btc, eth, sol, xrp');
  if (!parsed.interval) throw new Error('Missing interval, supported: 5m, 15m');

  return parsed;
}

function formatError(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  return error.stack || error.message;
}

async function main() {
  let exitCode = 0;

  try {
    const parsed = parseArgs(process.argv.slice(2));
    const market = await findLatestUpDownMarket({
      asset: parsed.asset!,
      interval: parsed.interval!,
    });

    if (!market) {
      throw new Error(`No active ${parsed.asset} up/down ${parsed.interval} market found`);
    }

    const result = {
      question: market.question || market.title,
      slug: market.slug,
      conditionId: market.conditionId,
      endDate: market.endDate,
      startDate: market.startDate,
      negativeRisk: market.negRisk,
      outcomes: market.outcomes,
      clobTokenIds: market.clobTokenIds,
    };

    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.table(result);
    }
  } catch (error) {
    console.error(usage(formatError(error)));
    exitCode = 1;
  } finally {
    await RedisService.closeInstance();
    process.exit(exitCode);
  }
}

main();

