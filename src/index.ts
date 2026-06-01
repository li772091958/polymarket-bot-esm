import { Effect } from 'effect';
import 'dotenv/config';
import { runCashoutLoop } from './cashout.js';
import { runCopyTradeLoop } from './copyTrade.js';
import { autoCheckAndSwitchProxyNode } from './middleware/clashManager.js';
import { runDailyProfitSnapshotLoop } from './profitScheduler.js';
import { startWebServerEffect } from '../web/server.js';

void Effect.runPromise(
  Effect.all(
    [
      autoCheckAndSwitchProxyNode,
      runCopyTradeLoop,
      runCashoutLoop,
      runDailyProfitSnapshotLoop,
      startWebServerEffect,
    ],
    {
      concurrency: 'unbounded',
      discard: true,
    }
  )
);
