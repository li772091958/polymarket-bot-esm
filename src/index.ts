import { Effect } from 'effect';
import 'dotenv/config';
import { runCashoutLoop } from './cashout.js';
import { runCopyTradeLoop } from './copyTrade.js';
import { autoCheckAndSwitchProxyNode } from './middleware/clashManager.js';

void Effect.runPromise(
  Effect.all([autoCheckAndSwitchProxyNode, runCopyTradeLoop, runCashoutLoop], {
    concurrency: 'unbounded',
    discard: true,
  })
);
