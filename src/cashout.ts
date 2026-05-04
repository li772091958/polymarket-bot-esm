import { OrderType, Side, type TickSize } from '@polymarket/clob-client-v2';
import { ApiError, cbc, getPositions } from './polymarket/api.js';
import { redeemPosition } from './polymarket/relayer.js';
import { Position } from './types.js';

const LOOP_INTERVAL_MS = 15 * 60 * 1000;
const CASHOUT_PRICE_THRESHOLD = 0.98;
const CASHOUT_SELL_PRICE = 0.999;
const MIN_CASHOUT_SELL_SIZE = 5;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const toApiError = (cause: unknown, url: string) =>
  new ApiError({
    message: cause instanceof Error ? cause.message : String(cause),
    url,
  });

const redeem = async (position: Position) => {
  try {
    await redeemPosition(position);
  } catch (cause) {
    throw toApiError(cause, `redeem:${position.conditionId}`);
  }
};

const postCashoutSellOrder = async (position: Position) => {
  try {
    const marketInfo = await cbc.getClobMarketInfo(position.conditionId);

    return await cbc.createAndPostOrder(
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
  } catch (cause) {
    throw toApiError(cause, `cashout-sell:${position.asset}`);
  }
};

const processPosition = async (position: Position) => {
  try {
    if (position.redeemable) {
      await redeem(position);
      return;
    }

    if (position.size >= MIN_CASHOUT_SELL_SIZE && position.curPrice > CASHOUT_PRICE_THRESHOLD) {
      await postCashoutSellOrder(position);
    }
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
  }
};

export const runCashoutCycle = async () => {
  try {
    const positions = await getPositions({ user: process.env.FUNDER });

    for (const position of positions) {
      await processPosition(position);
    }
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
  }
};

export const runCashoutLoop = async () => {
  while (true) {
    await runCashoutCycle();
    await sleep(LOOP_INTERVAL_MS);
  }
};
