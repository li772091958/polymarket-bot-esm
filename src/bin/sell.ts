import 'dotenv/config';
import { Effect } from 'effect';
import { runSell } from '../sell.js';
import RedisService from '../middleware/RedisService.js';

function parseArgs(args: string[]) {
  let keyword: string | undefined;
  let price: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '-p') {
      const rawPrice = args[index + 1];
      if (!rawPrice) {
        throw new Error('Missing price after -p');
      }

      const parsedPrice = Number(rawPrice);
      if (!Number.isFinite(parsedPrice) || parsedPrice <= 0 || parsedPrice >= 1) {
        throw new Error(`Invalid price: ${rawPrice}`);
      }

      price = parsedPrice;
      index += 1;
      continue;
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (keyword) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    keyword = arg;
  }

  if (!keyword) {
    throw new Error('Missing asset-or-title');
  }

  return { keyword, price };
}

async function main() {
  let exitCode = 0;
  let parsed: ReturnType<typeof parseArgs>;

  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Usage: npm run sell <asset-or-title> [-p price]\n${message}`);
    process.exit(1);
  }

  try {
    await Effect.runPromise(runSell(parsed.keyword, { price: parsed.price }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Failed to sell position:', message);
    exitCode = 1;
  } finally {
    await RedisService.closeInstance();
    process.exit(exitCode);
  }
}

main();
