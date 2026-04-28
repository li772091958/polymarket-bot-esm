import { Effect } from 'effect';
import 'dotenv/config';
import { runCashoutLoop } from './cashout.js';
import { runCopyTradeLoop } from './copyTrade.js';

void Effect.runPromise(
  Effect.all([runCopyTradeLoop, runCashoutLoop], {
    concurrency: 'unbounded',
    discard: true,
  })
);
