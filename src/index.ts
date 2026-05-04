import 'dotenv/config';
import { runCashoutLoop } from './cashout.js';
import { runCopyTradeLoop } from './copyTrade.js';
import { autoCheckAndSwitchProxyNode } from './middleware/clashManager.js';

void Promise.all([
  autoCheckAndSwitchProxyNode(),
  runCopyTradeLoop(),
  runCashoutLoop(),
]);
