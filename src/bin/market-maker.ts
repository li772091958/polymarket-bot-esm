import 'dotenv/config';
import RedisService from '../middleware/RedisService.js';
import { closeLogger } from '../middleware/logger.js';
import { runWorldCupWinnerMarketMaker, type MarketMakerConfig } from '../marketMaker.js';

function parseArgs(args: string[]) {
  const parsed: Partial<MarketMakerConfig> = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }

    if (arg === '--once') {
      parsed.once = true;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return parsed;
}

function usage(message?: string) {
  return [
    'Usage:',
    '  npm run market-maker',
    '  npm run market-maker -- --dry-run --once',
    'Configure token/amount at the top of src/marketMaker.ts.',
    message ? `\n${message}` : '',
  ].join('\n');
}

function formatError(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  return error.stack || error.message;
}

async function main() {
  let exitCode = 0;

  try {
    const options = parseArgs(process.argv.slice(2));
    await runWorldCupWinnerMarketMaker(options);
  } catch (error) {
    console.error(usage(formatError(error)));
    exitCode = 1;
  } finally {
    await RedisService.closeInstance();
    await closeLogger();
    process.exit(exitCode);
  }
}

main();
