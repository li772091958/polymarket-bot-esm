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
   * 跟单额度(USDC)
   */
  amount?: number | ((position: Position) => number);
  dryRun?: boolean;
}

interface CopyStrategyNameCache {
  nickname: string;
  createdAt: number;
}

// 跟单轮询间隔，Effect.sleep 支持 human-readable duration。
const LOOP_INTERVAL = '1 minute';
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
// 临时排除已结算/已赎回但目标钱包仍显示持仓的 token，避免反复尝试无效买入。
const EXCLUDED_COPY_BUY_ASSETS = new Set([
  '50874144013607039471889595967151844694106457173650258171240313664286862843480',
]);

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

const DEFAULT_STRATEGY_AMOUNT = (pos: Position) => {
  let result = parseFloat((pos.initialValue / 1000).toFixed(2));
  result = Math.min(10, Math.max(1, result));
  return result;
};

// 跟单策略，每个聪明钱都不一样
const STRATEGY: StrategyConfig[] = [
  {
    enable: true,
    address: '0x183f8b17cfb09c9115d068b2da3033b54f4c85e3',
    nickname: 'BetsAusmAudimax',
    // amount: 1,
    // dryRun: true,
  },
  {
    enable: true,
    address: '0x9b1e0334569aa1768a07705a859686aad58e82c9',
    nickname: 'FullPicks1',
    amount: (pos: Position) => {
      let result = parseFloat((pos.initialValue / 4000).toFixed(2));
      result = Math.min(10, Math.max(1, result));
      return result;
    },
  },
];

const getStrategyName = (strategy: StrategyConfig) => strategy.nickname || strategy.address;

const resolveOrderAmount = (strategy: StrategyConfig, position: Position) =>
  typeof strategy.amount === 'function'
    ? strategy.amount(position)
    : (strategy.amount ?? DEFAULT_STRATEGY_AMOUNT(position));

const resolvePositionFilter = (strategy: StrategyConfig) =>
  strategy.filter ?? DEFAULT_STRATEGY_FILTER;

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

const isExcludedCopyBuyAsset = (asset: string) => EXCLUDED_COPY_BUY_ASSETS.has(asset);

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

const shouldBuyAtMarketPrice = (position: Position) =>
  fetchMarketBuyPrice(position).pipe(
    Effect.map(
      marketPrice =>
        marketPrice >= MIN_ALLOWED_MARKET_BUY_PRICE && marketPrice <= MAX_ALLOWED_MARKET_BUY_PRICE
    )
  );

const postMarketBuyOrder = (strategy: StrategyConfig, position: Position, amount: number) =>
  DRY_RUN || strategy.dryRun
    ? logger.info(`${getStrategyName(strategy)} 模拟买进: `, {
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

const resolveRemainingAmount = (strategy: StrategyConfig, position: Position) => {
  const configuredAmount = resolveOrderAmount(strategy, position);
  const filledAmount = Math.max(
    myPosMap.get(position.asset)?.initialValue ?? 0,
    confirmedBoughtValueMap.get(position.asset) ?? 0
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
    if (hasSoldAsset(position.asset)) return;
    if (isExcludedCopyBuyAsset(position.asset)) return;

    const configuredAmount = resolveOrderAmount(strategy, position);
    if (configuredAmount <= 0) return;

    const remainingAmount = resolveRemainingAmount(strategy, position);

    if (remainingAmount < MIN_MARKET_BUY_AMOUNT) return;

    const shouldBuy = yield* shouldBuyAtMarketPrice(position);
    if (!shouldBuy) return;

    rememberCopyStrategyName(position.asset, strategy);
    yield* postMarketBuyOrder(strategy, position, remainingAmount);
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
    const targetPositions = resolvePositionFilter(strategy)(allPositions);

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

  wsUser.on('ws_error', error => {
    const message = error instanceof Error ? error.message : String(error);
    void Effect.runPromise(logger.error('WS user channel error: ', { message }));
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
