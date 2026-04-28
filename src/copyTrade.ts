import { OrderType, Side, type TickSize } from '@polymarket/clob-client-v2';
import { Effect } from 'effect';
import logger from './middleware/logger.js';
import notify, { simpleObjectToMarkdown } from './middleware/notify.js';
import { ApiError, cbc, getPositions } from './polymarket/api.js';
import { Position } from './types.js';

interface StrategyConfig {
  enable: boolean;
  nickname?: string;
  des?: string;
  address: string;
  /**
   * 持仓过滤器
   * @param positions
   * @returns
   */
  filter: (positions: Position[]) => Position[];
  /**
   * 跟单额度(USDC)
   */
  amount: number | ((position: Position) => number);
  dryRun?: boolean;
}

const LOOP_INTERVAL = '1 minute';
const DEFAULT_MARKET_ORDER_SLIPPAGE = 0.03;
const DRY_RUN = ['1', 'true', 'yes', 'on'].includes((process.env.DRY_RUN || '').toLowerCase());
const MIN_MARKET_BUY_AMOUNT = 1;
const MIN_MARKET_BUY_ROUND_UP_AMOUNT = 0.6;
const SOLD_ASSET_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

let myPosMap = new Map<string, Position>();
let prevRunMyPosMap = new Map<string, Position>();
const soldAssetMap = new Map<string, number>();

// 跟单策略，每个聪明钱都不一样
const STRATEGY: StrategyConfig[] = [
  {
    enable: true,
    address: '0x183f8b17cfb09c9115d068b2da3033b54f4c85e3',
    nickname: 'BetsAusmAudimax',
    filter: ps =>
      ps.filter(
        v =>
          v.initialValue > 300 &&
          v.avgPrice < 0.92 &&
          v.avgPrice > 0.2 &&
          v.curPrice < 0.92 &&
          v.curPrice > 0.2
      ),
    amount: (pos: Position) => {
      let result = parseFloat((pos.initialValue / 1000).toFixed(2));
      result = Math.min(10, Math.max(1, result));
      return result;
    },
    dryRun: false,
  },
];

const getStrategyName = (strategy: StrategyConfig) => strategy.nickname || strategy.address;

const resolveOrderAmount = (strategy: StrategyConfig, position: Position) =>
  typeof strategy.amount === 'function' ? strategy.amount(position) : strategy.amount;

const resolveWorstPrice = (position: Position) => {
  const rawPrice = position.curPrice + DEFAULT_MARKET_ORDER_SLIPPAGE;
  return Math.min(0.99, Math.max(0.01, Number(rawPrice.toFixed(3))));
};

const pruneSoldAssets = (now = Date.now()) => {
  for (const [asset, soldAt] of soldAssetMap.entries()) {
    if (now - soldAt > SOLD_ASSET_RETENTION_MS) {
      soldAssetMap.delete(asset);
    }
  }
};

const markSoldAsset = (asset: string, now = Date.now()) => {
  soldAssetMap.set(asset, now);
};

const hasSoldAsset = (asset: string, now = Date.now()) => {
  const soldAt = soldAssetMap.get(asset);
  if (!soldAt) return false;

  if (now - soldAt > SOLD_ASSET_RETENTION_MS) {
    soldAssetMap.delete(asset);
    return false;
  }

  return true;
};

const buildOrderDetail = (strategy: StrategyConfig, position: Position, amount: number) => ({
  strategy: getStrategyName(strategy),
  title: position.title,
  slug: position.slug,
  outcome: position.outcome,
  tokenID: position.asset,
  side: 'BUY',
  amount,
  price: resolveWorstPrice(position),
});

const postMarketBuyOrder = (strategy: StrategyConfig, position: Position, amount: number) =>
  DRY_RUN || strategy.dryRun
    ? logger.info('模拟交易: ', {
        strategy: getStrategyName(strategy),
        title: position.title,
        outcome: position.outcome,
        tokenId: position.asset,
        amount,
      })
    : Effect.tryPromise({
        try: async () => {
          const marketInfo = await cbc.getClobMarketInfo(position.conditionId);
          const order = {
            tokenID: position.asset,
            side: Side.BUY,
            amount,
            price: resolveWorstPrice(position),
            userUSDCBalance: amount,
          };

          return cbc.createAndPostMarketOrder(
            order,
            {
              tickSize: String(marketInfo.mts) as TickSize,
              negRisk: position.negativeRisk,
            },
            OrderType.FOK
          );
        },
        catch: cause =>
          new ApiError({
            message: cause instanceof Error ? cause.message : String(cause),
            url: `market-order:${position.asset}`,
          }),
      })
        .pipe(
          Effect.tap(() =>
            logger.info('买进: ', {
              strategy: getStrategyName(strategy),
              title: position.title,
              outcome: position.outcome,
              tokenId: position.asset,
              amount,
            })
          )
        )
        .pipe(
          Effect.tap(result => {
            if (!result?.success) return Effect.void;

            const desp = [
              '## 订单详情',
              simpleObjectToMarkdown(buildOrderDetail(strategy, position, amount)),
              '## 返回结果',
              simpleObjectToMarkdown(result as Record<string, unknown>),
            ].join('\n');

            return notify('带我赚钱', desp).pipe(
              Effect.catchAll(error =>
                logger
                  .error('消息推送失败: ', {
                    strategy: getStrategyName(strategy),
                    title: position.title,
                    outcome: position.outcome,
                    message: error.message,
                  })
                  .pipe(Effect.asVoid)
              )
            );
          })
        );

const syncMyPositionsBeforeRun = Effect.gen(function* () {
  const now = Date.now();
  pruneSoldAssets(now);

  const positions = yield* getPositions({
    user: process.env.FUNDER,
    limit: 500,
  });
  const currentPosMap = new Map(positions.map(position => [position.asset, position]));

  for (const [asset, previous] of prevRunMyPosMap.entries()) {
    if (!currentPosMap.has(asset)) {
      markSoldAsset(asset, now);
    }
  }

  myPosMap = currentPosMap;
  prevRunMyPosMap = new Map(currentPosMap);

  return positions;
});

const resolveRemainingAmount = (strategy: StrategyConfig, position: Position) => {
  const configuredAmount = resolveOrderAmount(strategy, position);
  const filledAmount = myPosMap.get(position.asset)?.initialValue ?? 0;
  let remainingAmount = Number((configuredAmount - filledAmount).toFixed(2));

  if (remainingAmount > MIN_MARKET_BUY_ROUND_UP_AMOUNT && remainingAmount < MIN_MARKET_BUY_AMOUNT) {
    remainingAmount = MIN_MARKET_BUY_AMOUNT;
  }

  return Math.max(0, remainingAmount);
};

const processPosition = (strategy: StrategyConfig, position: Position) =>
  Effect.gen(function* () {
    if (hasSoldAsset(position.asset)) {
      return;
    }

    const configuredAmount = resolveOrderAmount(strategy, position);
    if (configuredAmount <= 0) return;

    const remainingAmount = resolveRemainingAmount(strategy, position);

    if (remainingAmount < MIN_MARKET_BUY_AMOUNT) return;

    yield* postMarketBuyOrder(strategy, position, remainingAmount);
  });

const runStrategy = (strategy: StrategyConfig) =>
  Effect.gen(function* () {
    if (!strategy.enable) {
      return;
    }

    const allPositions = yield* getPositions({
      user: strategy.address,
      limit: 500,
    });
    const targetPositions = strategy.filter(allPositions);

    for (const position of targetPositions) {
      yield* processPosition(strategy, position).pipe(
        Effect.catchTag('ApiError', error =>
          logger
            .error('Copy-trade order failed', {
              strategy: getStrategyName(strategy),
              title: position.title,
              outcome: position.outcome,
              message: error.message,
              status: error.status,
              url: error.url,
            })
            .pipe(Effect.asVoid)
        )
      );
    }
  }).pipe(
    Effect.catchTag('ApiError', error =>
      logger
        .error('获取目标仓位失败: ', {
          strategy: getStrategyName(strategy),
          message: error.message,
          status: error.status,
          url: error.url,
        })
        .pipe(Effect.asVoid)
    )
  );

export const runCopyTradeCycle = syncMyPositionsBeforeRun.pipe(
  Effect.zipRight(
    Effect.forEach(STRATEGY, runStrategy, {
      concurrency: 1,
      discard: true,
    })
  ),
  Effect.catchTag('ApiError', error =>
    logger
      .error('同步自己仓位失败: ', {
        message: error.message,
        status: error.status,
        url: error.url,
      })
      .pipe(Effect.asVoid)
  )
);

export const runCopyTradeLoop = Effect.forever(
  runCopyTradeCycle.pipe(Effect.zipRight(Effect.sleep(LOOP_INTERVAL)))
);
