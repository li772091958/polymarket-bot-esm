import { OrderType, Side, type TickSize } from '@polymarket/clob-client-v2';
import { Effect } from 'effect';
import logger from './middleware/logger.js';
import { cbc, getPositions } from './polymarket/api.js';
import type { Position } from './types.js';
import { parseTrade, wsMarket, wsUser, type TradeEvent } from './wsInstance.js';

// === Single-token market making config ===
// Fill this token ID before running live. Leaving it empty makes the strategy idle.
const MARKET_MAKER_TOKEN_ID =
  '108233603819467706476318984012158651931658302669301887462181073562758483842092';
const BUY_NOTIONAL_USDC = 20;
const CHECK_INTERVAL_MS = 20_000;
const REPRICE_FROM_LEVEL = 4;
const DRY_RUN = false;

type ManagedSide = 'BUY' | 'SELL';

export type MarketMakerConfig = {
  dryRun: boolean;
  once: boolean;
};

type PriceLevel = {
  price: number;
  size: number;
};

type OrderBookLevels = {
  bids: PriceLevel[];
  asks: PriceLevel[];
  tickSize: TickSize;
  negRisk: boolean;
};

type ManagedOrder = {
  id: string;
  side: ManagedSide;
  price: number;
  size: number;
};

type MarketMakerState = {
  buy?: ManagedOrder;
  sell?: ManagedOrder;
  busy: boolean;
  lastBook?: OrderBookLevels;
  market?: string;
  startedWs: boolean;
  debounceTimer?: NodeJS.Timeout;
  interval?: NodeJS.Timeout;
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const parseNumber = (value: string | number | undefined) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const roundDown = (value: number, decimals: number) =>
  Math.floor(value * 10 ** decimals) / 10 ** decimals;

const isValidPrice = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value > 0 && value < 1;

const samePrice = (a: number, b: number) => Math.abs(a - b) < 0.000_000_1;

const formatError = (error: unknown) => {
  if (!(error instanceof Error)) return String(error);
  return error.stack || error.message;
};

const extractOrderId = (response: any) =>
  String(response?.orderID || response?.orderId || response?.id || response?.order?.id || '');

function levelsFromOrders(orders: { price: string; size: string }[], side: ManagedSide) {
  const sizeByPrice = new Map<number, number>();

  for (const order of orders) {
    const price = parseNumber(order.price);
    const size = parseNumber(order.size);
    if (!isValidPrice(price) || size <= 0) continue;
    sizeByPrice.set(price, (sizeByPrice.get(price) || 0) + size);
  }

  return Array.from(sizeByPrice.entries())
    .map(([price, size]) => ({ price, size }))
    .sort((a, b) => (side === 'BUY' ? b.price - a.price : a.price - b.price));
}

async function fetchBook(): Promise<OrderBookLevels> {
  const book = await cbc.getOrderBook(MARKET_MAKER_TOKEN_ID);

  return {
    bids: levelsFromOrders(book.bids, 'BUY'),
    asks: levelsFromOrders(book.asks, 'SELL'),
    tickSize: String(book.tick_size) as TickSize,
    negRisk: book.neg_risk,
  };
}

function targetPrice(book: OrderBookLevels, side: ManagedSide) {
  return side === 'BUY' ? book.bids[1]?.price : book.asks[1]?.price;
}

function orderLevel(book: OrderBookLevels, order: ManagedOrder) {
  const levels = order.side === 'BUY' ? book.bids : book.asks;
  const index = levels.findIndex(level => samePrice(level.price, order.price));
  return index >= 0 ? index + 1 : Number.POSITIVE_INFINITY;
}

function shouldReprice(book: OrderBookLevels, order: ManagedOrder) {
  const level = orderLevel(book, order);
  return level >= REPRICE_FROM_LEVEL;
}

function buySizeAt(price: number) {
  return Math.floor(BUY_NOTIONAL_USDC / price);
}

function buyOrderHasTargetSize(order: ManagedOrder) {
  return order.size === buySizeAt(order.price);
}

function positionSize(positions: Position[]) {
  return positions
    .filter(position => position.asset === MARKET_MAKER_TOKEN_ID)
    .reduce((sum, position) => sum + Number(position.size || 0), 0);
}

function toManagedOrder(order: any): ManagedOrder {
  const originalSize = parseNumber(order.original_size);
  const matchedSize = parseNumber(order.size_matched);
  return {
    id: String(order.id),
    side: order.side,
    price: parseNumber(order.price),
    size: Math.max(0, originalSize - matchedSize),
  };
}

async function cancelOrder(order: ManagedOrder, config: MarketMakerConfig) {
  if (config.dryRun) {
    return;
  }

  await cbc.cancelOrder({ orderID: order.id });
}

function assertPostResponse(response: any, side: ManagedSide) {
  if (response?.success === false) {
    throw new Error(`${side} order rejected: ${response.errorMsg || JSON.stringify(response)}`);
  }

  const id = extractOrderId(response);
  if (!id) {
    throw new Error(`${side} order response missing order id: ${JSON.stringify(response)}`);
  }

  return id;
}

async function postBuy(book: OrderBookLevels, config: MarketMakerConfig) {
  const price = targetPrice(book, 'BUY');
  if (!isValidPrice(price)) {
    return undefined;
  }

  const size = buySizeAt(price);
  if (size <= 0) {
    return undefined;
  }

  if (config.dryRun) {
    const order = {
      id: `dry-buy-${Date.now()}`,
      side: 'BUY',
      price,
      size,
    } satisfies ManagedOrder;
    return order;
  }

  const response = await cbc.createAndPostOrder(
    {
      tokenID: MARKET_MAKER_TOKEN_ID,
      side: Side.BUY,
      price,
      size,
    },
    {
      tickSize: book.tickSize,
      negRisk: book.negRisk,
    },
    OrderType.GTC,
    true
  );
  const order = {
    id: assertPostResponse(response, 'BUY'),
    side: 'BUY',
    price,
    size,
  } satisfies ManagedOrder;
  await Effect.runPromise(logger.info('[market-maker] posted buy', order));
  return order;
}

async function postSell(book: OrderBookLevels, size: number, config: MarketMakerConfig) {
  const price = targetPrice(book, 'SELL');
  if (!isValidPrice(price)) {
    return undefined;
  }

  const sellSize = roundDown(size, 2);
  if (sellSize <= 0) {
    return undefined;
  }

  if (config.dryRun) {
    const order = {
      id: `dry-sell-${Date.now()}`,
      side: 'SELL',
      price,
      size: sellSize,
    } satisfies ManagedOrder;

    return order;
  }

  const response = await cbc.createAndPostOrder(
    {
      tokenID: MARKET_MAKER_TOKEN_ID,
      side: Side.SELL,
      price,
      size: sellSize,
    },
    {
      tickSize: book.tickSize,
      negRisk: book.negRisk,
    },
    OrderType.GTC,
    true
  );
  const order = {
    id: assertPostResponse(response, 'SELL'),
    side: 'SELL',
    price,
    size: sellSize,
  } satisfies ManagedOrder;
  await Effect.runPromise(logger.info('[market-maker] posted sell', order));
  return order;
}

async function syncOpenOrders(state: MarketMakerState, config: MarketMakerConfig) {
  const openOrders = config.dryRun
    ? []
    : await cbc.getOpenOrders({ asset_id: MARKET_MAKER_TOKEN_ID });

  const buys = openOrders.filter(order => order.side === 'BUY').map(toManagedOrder);
  const sells = openOrders.filter(order => order.side === 'SELL').map(toManagedOrder);

  for (const order of buys.slice(1)) {
    await cancelOrder(order, config);
  }
  for (const order of sells.slice(1)) {
    await cancelOrder(order, config);
  }

  state.buy = buys[0];
  state.sell = sells[0];
}

async function ensureBuy(
  state: MarketMakerState,
  book: OrderBookLevels,
  config: MarketMakerConfig
) {
  if (!state.buy) {
    state.buy = await postBuy(book, config);
    return;
  }

  if (shouldReprice(book, state.buy) || !buyOrderHasTargetSize(state.buy)) {
    await cancelOrder(state.buy, config);
    state.buy = await postBuy(book, config);
  }
}

async function ensureSell(
  state: MarketMakerState,
  book: OrderBookLevels,
  config: MarketMakerConfig
) {
  const positions = config.dryRun
    ? []
    : await Effect.runPromise(getPositions({ user: process.env.FUNDER, limit: 500 }));
  const size = positionSize(positions);

  if (size <= 0) {
    if (state.sell) {
      await cancelOrder(state.sell, config);
      state.sell = undefined;
    }
    return;
  }

  if (!state.sell) {
    state.sell = await postSell(book, size, config);
    return;
  }

  if (shouldReprice(book, state.sell) || Math.abs(state.sell.size - roundDown(size, 2)) >= 0.01) {
    await cancelOrder(state.sell, config);
    state.sell = await postSell(book, size, config);
  }
}

async function reconcile(state: MarketMakerState, config: MarketMakerConfig, reason: string) {
  if (state.busy) return;
  state.busy = true;

  try {
    const book = await fetchBook();
    state.lastBook = book;
    await syncOpenOrders(state, config);
    await ensureSell(state, book, config);
    await ensureBuy(state, book, config);
  } catch (error) {
  } finally {
    state.busy = false;
  }
}

function scheduleReconcile(
  state: MarketMakerState,
  config: MarketMakerConfig,
  reason: string,
  delayMs = 250
) {
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => {
    void reconcile(state, config, reason);
  }, delayMs);
}

function isTargetMarketEvent(event: unknown) {
  const item = event as Record<string, any>;
  if (!item || typeof item !== 'object') return false;
  const assetId = item.asset_id || item.assetId;
  if (assetId === MARKET_MAKER_TOKEN_ID) return true;

  if (Array.isArray(item.asset_ids) && item.asset_ids.includes(MARKET_MAKER_TOKEN_ID)) return true;
  if (Array.isArray(item.assets_ids) && item.assets_ids.includes(MARKET_MAKER_TOKEN_ID))
    return true;
  if (Array.isArray(item.changes)) {
    return item.changes.some(
      (change: Record<string, any>) => (change.asset_id || change.assetId) === MARKET_MAKER_TOKEN_ID
    );
  }

  return false;
}

function startWs(state: MarketMakerState, config: MarketMakerConfig) {
  if (state.startedWs) return;
  state.startedWs = true;

  wsMarket.addAssets([MARKET_MAKER_TOKEN_ID]);
  wsMarket.on('data', event => {
    const events = Array.isArray(event) ? event : [event];
    if (events.some(isTargetMarketEvent)) {
      scheduleReconcile(state, config, 'market-ws');
    }
  });
  wsMarket.on('connected', () => {
    scheduleReconcile(state, config, 'market-ws-connected');
  });
  wsMarket.on('ws_error', error => {});
  wsMarket.run();

  wsUser.on('data', event => {
    const events = Array.isArray(event) ? event : [event];

    for (const item of events) {
      const tradeEvent = item as Partial<TradeEvent>;
      if (tradeEvent?.event_type !== 'trade') continue;

      const trade = parseTrade(tradeEvent as TradeEvent);
      if (!trade || trade.asset_id !== MARKET_MAKER_TOKEN_ID) continue;

      void Effect.runPromise(logger.info('[market-maker] trade detected', trade));
      scheduleReconcile(state, config, 'user-trade', 0);
    }
  });
  wsUser.on('connected', () => {});
  wsUser.on('ws_error', error => {
    void Effect.runPromise(logger.error('[market-maker] user websocket error', formatError(error)));
  });
  wsUser.run();
}

export async function runWorldCupWinnerMarketMaker(options: Partial<MarketMakerConfig> = {}) {
  const config: MarketMakerConfig = {
    dryRun: DRY_RUN,
    once: false,
    ...options,
  };

  if (!MARKET_MAKER_TOKEN_ID.trim()) {
    if (config.once) return;
    while (true) {
      await sleep(60_000);
    }
  }

  const state: MarketMakerState = {
    busy: false,
    startedWs: false,
  };

  startWs(state, config);
  await reconcile(state, config, 'startup');
  if (config.once) return;

  state.interval = setInterval(() => {
    void reconcile(state, config, 'interval');
  }, CHECK_INTERVAL_MS);

  while (true) {
    await sleep(60_000);
  }
}
