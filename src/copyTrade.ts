import { OrderType, Side, type TickSize } from '@polymarket/clob-client-v2';
import { Effect } from 'effect';
import logger from './middleware/logger.js';
import notify, { simpleObjectToMarkdown } from './middleware/notify.js';
import { ApiError, cbc, getMarketPrice, getPositions } from './polymarket/api.js';
import { Position } from './types.js';
import { parseTrade, wsUser, type TradeEvent } from './wsInstance.js';

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
  filter?: (positions: Position[]) => Position[];
  /**
   * 跟单额度(USDC) = clamp(目标仓位 initialValue * coefficient, minAmount, maxAmount)
   */
  minAmount: number;
  maxAmount: number;
  coefficient: number;
  dryRun?: boolean;
  opposite?: boolean;
}

interface CopyStrategyNameCache {
  nickname: string;
  createdAt: number;
}

// 跟单轮询间隔，Effect.sleep 支持 human-readable duration。
const LOOP_INTERVAL = '30 seconds';
// 市价买单允许多付的滑点，实际挂单价 = 当前价 + 该滑点，上限仍会被限制。
const DEFAULT_MARKET_ORDER_SLIPPAGE = 0.03;
// 全局模拟交易开关，开启后只打日志，不真实下单。
const DRY_RUN = ['1', 'true', 'yes', 'on'].includes((process.env.DRY_RUN || '').toLowerCase());
// 小于该金额的剩余额度不再发起买入。
const MIN_MARKET_BUY_AMOUNT = 1;
// Polymarket 市价买单实际下单的最低金额，留出精度/价格取整缓冲避免被折成 $0.99。
const MIN_MARKET_BUY_ORDER_AMOUNT = 1.1;
// 剩余额度超过该值但不足最低买入额时，向上补到最低下单金额。
const MIN_MARKET_BUY_ROUND_UP_AMOUNT = 0.6;
// 低于该价格的仓位不跟，避免低流动性/极端赔率标的。
const MIN_ALLOWED_MARKET_BUY_PRICE = 0.2;
// 高于该价格的仓位不跟，避免接近结算的一边倒标的。
const MAX_ALLOWED_MARKET_BUY_PRICE = 0.92;
// 卖出后短期内不重新买回同一 asset 的记忆时间。
const SOLD_ASSET_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;
// 已记录策略名但尚未同步成持仓的缓存保留时间，防止缓存无界增长。
const PENDING_COPY_STRATEGY_RETENTION_MS = 30 * 60 * 1000;

let myPosMap = new Map<string, Position>();
let prevRunMyPosMap = new Map<string, Position>();
const soldAssetMap = new Map<string, number>();
const confirmedBoughtValueMap = new Map<string, number>();
const copyStrategyNameByAssetMap = new Map<string, CopyStrategyNameCache>();
const cacheTradedOrderIdSet = new Set<string>();
let copyTradeWsStarted = false;

const DEFAULT_STRATEGY_FILTER = (positions: Position[]) =>
  positions.filter(
    v =>
      v.initialValue > 300 &&
      v.avgPrice < 0.92 &&
      v.avgPrice > 0.2 &&
      v.curPrice < 0.92 &&
      v.curPrice > 0.2
  );

// 跟单策略，每个聪明钱都不一样
const STRATEGY: StrategyConfig[] = [
  {
    enable: true,
    address: '0xd3b034d7bfb2473fb252d0414646d9786bac329e',
    nickname: 'Sunshine.Smile',
    minAmount: 1,
    maxAmount: 10,
    coefficient: 1 / 1000,
  },
];

const getStrategyName = (strategy: StrategyConfig) => strategy.nickname || strategy.address;

const assertValidAmountConfig = (strategy: StrategyConfig) => {
  const strategyName = getStrategyName(strategy);
  const entries = {
    minAmount: strategy.minAmount,
    maxAmount: strategy.maxAmount,
    coefficient: strategy.coefficient,
  };

  for (const [key, value] of Object.entries(entries)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${strategyName} strategy requires a positive finite ${key}`);
    }
  }

  if (strategy.minAmount > strategy.maxAmount) {
    throw new Error(`${strategyName} strategy requires minAmount <= maxAmount`);
  }
};

const resolveOrderAmount = (strategy: StrategyConfig, position: Position) => {
  assertValidAmountConfig(strategy);

  const rawAmount = position.initialValue * strategy.coefficient;
  const clampedAmount = Math.min(strategy.maxAmount, Math.max(strategy.minAmount, rawAmount));
  return Number(clampedAmount.toFixed(2));
};

const resolvePositionFilter = (strategy: StrategyConfig) =>
  strategy.filter ?? DEFAULT_STRATEGY_FILTER;

const toOppositePosition = (position: Position) =>
  position.oppositeAsset
    ? {
        ...position,
        asset: position.oppositeAsset,
        outcome: position.oppositeOutcome || `Opposite of ${position.outcome}`,
        curPrice: Number((1 - position.curPrice).toFixed(4)),
      }
    : undefined;

const resolveFilterPosition = (strategy: StrategyConfig, position: Position) =>
  strategy.opposite ? (toOppositePosition(position) ?? position) : position;

const passesDefaultFilter = (position: Position) => DEFAULT_STRATEGY_FILTER([position]).length > 0;

const getTargetPositions = (strategy: StrategyConfig, positions: Position[]) => {
  const filteredPositions = resolvePositionFilter(strategy)(positions);
  if (strategy.filter) return filteredPositions;

  return filteredPositions.filter(position =>
    passesDefaultFilter(resolveFilterPosition(strategy, position))
  );
};

const rememberCopyStrategyName = (asset: string, strategy: StrategyConfig, now = Date.now()) => {
  if (!copyStrategyNameByAssetMap.has(asset)) {
    copyStrategyNameByAssetMap.set(asset, {
      nickname: getStrategyName(strategy),
      createdAt: now,
    });
  }
};

const getCopyStrategyName = (asset: string) =>
  copyStrategyNameByAssetMap.get(asset)?.nickname || '未知策略';

const pruneCopyStrategyNames = (currentAssets: Set<string>, now = Date.now()) => {
  for (const [asset, cache] of copyStrategyNameByAssetMap.entries()) {
    if (currentAssets.has(asset)) continue;
    if (now - cache.createdAt <= PENDING_COPY_STRATEGY_RETENTION_MS) continue;

    copyStrategyNameByAssetMap.delete(asset);
  }
};

const resolveWorstPrice = (marketPrice: number) => {
  const rawPrice = marketPrice + DEFAULT_MARKET_ORDER_SLIPPAGE;
  return Math.min(0.99, Math.max(0.01, Number(rawPrice.toFixed(3))));
};

const resolveCopyPosition = (strategy: StrategyConfig, position: Position) => {
  if (!strategy.opposite) return Effect.succeed(position);

  const oppositePosition = toOppositePosition(position);
  if (!oppositePosition) {
    return Effect.fail(
      new ApiError({
        message: 'Missing opposite asset for reverse copy-trade',
        url: `opposite-asset:${position.asset}`,
      })
    );
  }

  return Effect.succeed(oppositePosition);
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

const parseFiniteNumber = (value: string | number) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

const addConfirmedBoughtValue = (asset: string, value: number) => {
  if (value <= 0) return;
  confirmedBoughtValueMap.set(asset, (confirmedBoughtValueMap.get(asset) || 0) + value);
};

const pruneTradeOrderCache = () => {
  if (cacheTradedOrderIdSet.size <= 20) return;

  const latestOrderId = Array.from(cacheTradedOrderIdSet).pop();
  cacheTradedOrderIdSet.clear();
  if (latestOrderId) cacheTradedOrderIdSet.add(latestOrderId);
};

const fetchMarketBuyPrice = (position: Position) =>
  getMarketPrice({
    token_id: position.asset,
    side: 'BUY',
  }).pipe(
    Effect.flatMap(({ price }) => {
      const marketPrice = Number(price);

      return Number.isFinite(marketPrice)
        ? Effect.succeed(marketPrice)
        : Effect.fail(
            new ApiError({
              message: `Invalid market price: ${String(price)}`,
              url: `market-price:${position.asset}`,
            })
          );
    })
  );

const postMarketBuyOrder = (
  strategy: StrategyConfig,
  position: Position,
  amount: number,
  marketPrice: number
) =>
  DRY_RUN || strategy.dryRun
    ? logger.info(`${getStrategyName(strategy)} 模拟买进: `, {
        strategy: getStrategyName(strategy),
        title: position.title,
        outcome: position.outcome,
        tokenId: position.asset,
        amount,
        marketPrice,
      })
    : Effect.tryPromise({
        try: async () => {
          const marketInfo = await cbc.getClobMarketInfo(position.conditionId);
          const order = {
            tokenID: position.asset,
            side: Side.BUY,
            amount,
            price: resolveWorstPrice(marketPrice),
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
      });

const syncMyPositionsBeforeRun = Effect.gen(function* () {
  const now = Date.now();
  pruneSoldAssets(now);

  const positions = yield* getPositions({
    user: process.env.FUNDER,
    limit: 500,
  });
  const currentPosMap = new Map(positions.map(position => [position.asset, position]));
  const currentAssets = new Set(currentPosMap.keys());

  for (const [asset, previous] of prevRunMyPosMap.entries()) {
    if (!currentPosMap.has(asset)) {
      markSoldAsset(asset, now);
    }
  }
  pruneCopyStrategyNames(currentAssets, now);

  myPosMap = currentPosMap;
  prevRunMyPosMap = new Map(currentPosMap);
  for (const position of positions) {
    confirmedBoughtValueMap.delete(position.asset);
  }

  return positions;
});

const resolveRemainingAmount = (
  strategy: StrategyConfig,
  sourcePosition: Position,
  copyPosition: Position
) => {
  const configuredAmount = resolveOrderAmount(strategy, sourcePosition);
  const filledAmount = Math.max(
    myPosMap.get(copyPosition.asset)?.initialValue ?? 0,
    confirmedBoughtValueMap.get(copyPosition.asset) ?? 0
  );
  let remainingAmount = Number((configuredAmount - filledAmount).toFixed(2));

  if (remainingAmount > MIN_MARKET_BUY_ROUND_UP_AMOUNT && remainingAmount < MIN_MARKET_BUY_AMOUNT) {
    remainingAmount = MIN_MARKET_BUY_ORDER_AMOUNT;
  } else if (
    remainingAmount >= MIN_MARKET_BUY_AMOUNT &&
    remainingAmount < MIN_MARKET_BUY_ORDER_AMOUNT
  ) {
    remainingAmount = MIN_MARKET_BUY_ORDER_AMOUNT;
  }

  return Math.max(0, remainingAmount);
};

const processPosition = (strategy: StrategyConfig, position: Position) =>
  Effect.gen(function* () {
    const copyPosition = yield* resolveCopyPosition(strategy, position);

    if (hasSoldAsset(copyPosition.asset)) return;

    const configuredAmount = resolveOrderAmount(strategy, position);
    if (configuredAmount <= 0) return;

    const remainingAmount = resolveRemainingAmount(strategy, position, copyPosition);

    if (remainingAmount < MIN_MARKET_BUY_AMOUNT) return;

    const marketPrice = yield* fetchMarketBuyPrice(copyPosition);
    if (marketPrice < MIN_ALLOWED_MARKET_BUY_PRICE || marketPrice > MAX_ALLOWED_MARKET_BUY_PRICE) {
      return;
    }

    rememberCopyStrategyName(copyPosition.asset, strategy);
    yield* postMarketBuyOrder(strategy, copyPosition, remainingAmount, marketPrice);
  });

const processPositionSafely = (strategy: StrategyConfig, position: Position) =>
  processPosition(strategy, position).pipe(
    Effect.catchTag('ApiError', error =>
      logger
        .error('Copy-trade order failed', {
          strategy: getStrategyName(strategy),
          title: position.title,
          outcome: position.outcome,
          tokenId: position.asset,
          message: error.message,
          status: error.status,
          url: error.url,
        })
        .pipe(Effect.asVoid)
    )
  );

const runStrategy = (strategy: StrategyConfig) =>
  Effect.gen(function* () {
    if (!strategy.enable) {
      return;
    }

    const allPositions = yield* getPositions({
      user: strategy.address,
      limit: 500,
    });
    const targetPositions = getTargetPositions(strategy, allPositions);

    for (const position of targetPositions) {
      yield* processPositionSafely(strategy, position);
    }
  }).pipe(Effect.catchTag('ApiError', () => Effect.void));

const startCopyTradeWsListener = Effect.sync(() => {
  if (copyTradeWsStarted) return;
  copyTradeWsStarted = true;

  wsUser.on('data', event => {
    const message = Array.isArray(event) ? event : [event];

    for (const item of message) {
      const tradeEvent = item as Partial<TradeEvent>;
      if (tradeEvent?.event_type !== 'trade') continue;

      const trade = parseTrade(tradeEvent as TradeEvent);
      if (!trade) continue;

      if (!cacheTradedOrderIdSet.has(trade.order_id)) {
        const type =
          trade.side === 'BUY' ? '买进' : parseFiniteNumber(trade.price) < 0.98 ? '止损' : '收米';
        const nickname = getCopyStrategyName(trade.asset_id);
        const amount = `$${(parseFiniteNumber(trade.size) * parseFiniteNumber(trade.price)).toFixed(
          1
        )}`;
        const title = `${nickname} ${type} ${amount}`;
        const desp = simpleObjectToMarkdown({
          strategy: nickname,
          ...trade,
        } as unknown as Record<string, unknown>);

        cacheTradedOrderIdSet.add(trade.order_id);
        pruneTradeOrderCache();

        void Effect.runPromise(
          logger.info(`${nickname} ${type}:`, trade).pipe(
            Effect.zipRight(
              notify(title, desp).pipe(
                Effect.catchAll(error =>
                  logger
                    .error('消息推送失败: ', {
                      type,
                      orderId: trade.order_id,
                      assetId: trade.asset_id,
                      message: error.message,
                    })
                    .pipe(Effect.asVoid)
                )
              )
            )
          )
        );
      }

      if (trade.side === 'SELL') {
        markSoldAsset(trade.asset_id);
        confirmedBoughtValueMap.delete(trade.asset_id);
        myPosMap.delete(trade.asset_id);
        copyStrategyNameByAssetMap.delete(trade.asset_id);
      }

      if (trade.side === 'BUY') {
        addConfirmedBoughtValue(
          trade.asset_id,
          parseFiniteNumber(trade.size) * parseFiniteNumber(trade.price)
        );
      }
    }
  });

  wsUser.run();
});

export const runCopyTradeCycle = syncMyPositionsBeforeRun.pipe(
  Effect.zipRight(
    Effect.forEach(STRATEGY, runStrategy, {
      concurrency: 1,
      discard: true,
    })
  ),
  Effect.catchTag('ApiError', () => Effect.void)
);

export const runCopyTradeLoop = startCopyTradeWsListener.pipe(
  Effect.zipRight(
    Effect.forever(runCopyTradeCycle.pipe(Effect.zipRight(Effect.sleep(LOOP_INTERVAL))))
  )
);
