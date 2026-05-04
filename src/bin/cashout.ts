import 'dotenv/config';
import { Effect } from 'effect';
import { runCashoutCycle } from '../cashout.js';

Effect.runPromise(runCashoutCycle).catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Failed to run cashout:', message);
  process.exitCode = 1;
});
