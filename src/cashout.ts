import { OrderType, Side, type TickSize } from '@polymarket/clob-client-v2';
import { Effect } from 'effect';
import { ApiError, cbc, getPositions } from './polymarket/api.js';
import { redeemPosition } from './polymarket/relayer.js';
import { Position } from './types.js';

const LOOP_INTERVAL = '15 minutes';
const CASHOUT_PRICE_THRESHOLD = 0.98;
const CASHOUT_SELL_PRICE = 0.999;
const MIN_CASHOUT_SELL_SIZE = 5;

const redeem = (position: Position) =>
  Effect.tryPromise({
    try: () => redeemPosition(position),
    catch: cause =>
      new ApiError({
        message: cause instanceof Error ? cause.message : String(cause),
        url: `redeem:${position.conditionId}`,
      }),
  });

const postCashoutSellOrder = (position: Position) =>
  Effect.tryPromise({
    try: async () => {
      const marketInfo = await cbc.getClobMarketInfo(position.conditionId);

      return cbc.createAndPostOrder(
        {
          tokenID: position.asset,
          side: Side.SELL,
          price: CASHOUT_SELL_PRICE,
          size: position.size,
        },
        {
          tickSize: String(marketInfo.mts) as TickSize,
          negRisk: position.negativeRisk,
        },
        OrderType.GTC
      );
    },
    catch: cause =>
      new ApiError({
        message: cause instanceof Error ? cause.message : String(cause),
        url: `cashout-sell:${position.asset}`,
      }),
  });

const processPosition = (position: Position) =>
  Effect.gen(function* () {
    if (position.redeemable) {
      yield* redeem(position);
      return;
    }

    if (position.size >= MIN_CASHOUT_SELL_SIZE && position.curPrice > CASHOUT_PRICE_THRESHOLD) {
      yield* postCashoutSellOrder(position);
    }
  }).pipe(Effect.catchTag('ApiError', () => Effect.void));

export const runCashoutCycle = Effect.gen(function* () {
  const positions = yield* getPositions({ user: process.env.FUNDER });

  yield* Effect.forEach(positions, processPosition, {
    concurrency: 1,
    discard: true,
  });
}).pipe(Effect.catchTag('ApiError', () => Effect.void));

export const runCashoutLoop = Effect.forever(
  runCashoutCycle.pipe(Effect.zipRight(Effect.sleep(LOOP_INTERVAL)))
);
