import 'dotenv/config';
import { Effect } from 'effect';
import { runCashoutCycle } from '../cashout.js';
import RedisService from '../middleware/RedisService.js';
import { closeLogger } from '../middleware/logger.js';

async function main() {
  let exitCode = 0;

  try {
    await Effect.runPromise(runCashoutCycle);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Failed to run cashout:', message);
    exitCode = 1;
  } finally {
    await RedisService.closeInstance();
    await closeLogger();
    process.exit(exitCode);
  }
}

main();
