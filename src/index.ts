import { Effect } from 'effect';
import 'dotenv/config';
import { runCopyTradeLoop } from './copyTrade.js';

void Effect.runPromise(runCopyTradeLoop);
