import { AssetType, OrderType, Side, type TickSize } from '@polymarket/clob-client-v2';
import { createReadStream, existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect } from 'effect';
import { runCashoutCycle } from '../src/cashout.js';
import {
  getComboPositions,
  getWorldCupComboEvents,
  placeOfficialComboOrder,
  requestOfficialComboQuote,
} from '../src/polymarket/combo.js';
import { ApiError, cbc, getActivityFresh, getPositions } from '../src/polymarket/api.js';
import type { ActivitySearchParams, Position, Trade } from '../src/types.js';
import { wsMarket } from '../src/wsInstance.js';

const DEFAULT_PORT = 3000;
const POSITIONS_REFRESH_MS = 60_000;
const USDC_DECIMALS = 1_000_000;

// activity 查询参数边界值，与上游 data-api 对齐。
const ACTIVITY_DEFAULT_LIMIT = 100;
const ACTIVITY_MAX_LIMIT = 500;
const ACTIVITY_ALLOWED_TYPES = [
  'TRADE',
  'SPLIT',
  'MERGE',
  'REDEEM',
  'REWARD',
  'CONVERSION',
] as const;
type ActivityType = (typeof ACTIVITY_ALLOWED_TYPES)[number];
const ACTIVITY_ALLOWED_SIDES = ['BUY', 'SELL'] as const;
type ActivitySide = (typeof ACTIVITY_ALLOWED_SIDES)[number];

type LivePosition = Position & {
  livePrice: number;
  liveCurrentValue: number;
  livePnl: number;
  livePnlRate: number;
  priceSource: 'ws' | 'api';
};

type ServerEvent =
  | { type: 'snapshot'; payload: DashboardSnapshot }
  | { type: 'prices'; payload: Record<string, number> }
  | { type: 'status'; payload: { message: string; level?: 'info' | 'error' } };

type DashboardSnapshot = {
  updatedAt: string;
  availableBalance: number;
  positionValue: number;
  totalAssetValue: number;
  positionCount: number;
  positions: LivePosition[];
};

type PriceUpdates = Record<string, number | null>;

const clients = new Set<ServerResponse>();
let positions: Position[] = [];
const livePrices = new Map<string, number>();
let availableBalance = 0;
let lastUpdatedAt = '';
let refreshTimer: NodeJS.Timeout | null = null;
let refreshing: Promise<void> | null = null;

function parseClobUsdcAmount(raw: string | number) {
  const amount = Number(raw);
  if (!Number.isFinite(amount)) return 0;
  return amount / USDC_DECIMALS;
}

function toFiniteNumber(value: unknown, fallback = 0) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function enrichPosition(position: Position): LivePosition {
  const apiPrice = toFiniteNumber(position.curPrice);
  const livePrice = livePrices.get(position.asset) ?? apiPrice;
  const size = toFiniteNumber(position.size);
  const initialValue = toFiniteNumber(position.initialValue);
  const liveCurrentValue = size * livePrice;
  const livePnl = liveCurrentValue - initialValue;
  const livePnlRate = initialValue > 0 ? livePnl / initialValue : 0;

  return {
    ...position,
    livePrice,
    liveCurrentValue,
    livePnl,
    livePnlRate,
    priceSource: livePrices.has(position.asset) ? 'ws' : 'api',
  };
}

function getLivePositions() {
  return positions.map(enrichPosition).sort((a, b) => b.liveCurrentValue - a.liveCurrentValue);
}

function getSnapshot(): DashboardSnapshot {
  const livePositions = getLivePositions();
  const positionValue = livePositions.reduce((sum, position) => sum + position.liveCurrentValue, 0);

  return {
    updatedAt: lastUpdatedAt,
    availableBalance,
    positionValue,
    totalAssetValue: availableBalance + positionValue,
    positionCount: livePositions.length,
    positions: livePositions,
  };
}

function sendEvent(response: ServerResponse, event: ServerEvent) {
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event.payload)}\n\n`);
}

function broadcast(event: ServerEvent) {
  for (const client of clients) {
    sendEvent(client, event);
  }
}

function broadcastSnapshot() {
  broadcast({ type: 'snapshot', payload: getSnapshot() });
}

function syncSubscriptions(nextPositions: Position[]) {
  const nextAssets = nextPositions.map(position => position.asset);
  const currentAssets = new Set(positions.map(position => position.asset));
  const nextAssetSet = new Set(nextAssets);

  wsMarket.addAssets(nextAssets);
  wsMarket.removeAssets([...currentAssets].filter(asset => !nextAssetSet.has(asset)));
}

async function refreshPositions() {
  if (refreshing) return refreshing;

  refreshing = (async () => {
    const user = process.env.FUNDER;
    if (!user) throw new Error('Missing FUNDER env');

    const [balanceAllowance, nextPositions] = await Promise.all([
      cbc.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }),
      Effect.runPromise(getPositions({ user, limit: 500 })),
    ]);

    availableBalance = parseClobUsdcAmount(balanceAllowance.balance);
    syncSubscriptions(nextPositions);
    positions = nextPositions.filter(position => position.curPrice > 0.01);
    lastUpdatedAt = new Date().toISOString();
    broadcastSnapshot();
  })().finally(() => {
    refreshing = null;
  });

  return refreshing;
}

function findPosition(asset: string) {
  return positions.find(position => position.asset === asset);
}

async function sellPosition(asset: string) {
  await refreshPositions();
  const position = findPosition(asset);
  if (!position) throw new Error(`Position not found: ${asset}`);

  const marketInfo = await cbc.getClobMarketInfo(position.conditionId);
  const size = toFiniteNumber(position.size);
  if (size <= 0) throw new Error(`Invalid position size: ${position.size}`);

  const marketPrice = await cbc.calculateMarketPrice(
    position.asset,
    Side.SELL,
    size,
    OrderType.FOK
  );
  const response = await cbc.createAndPostMarketOrder(
    {
      tokenID: position.asset,
      side: Side.SELL,
      amount: size,
      orderType: OrderType.FOK,
    },
    {
      tickSize: String(marketInfo.mts) as TickSize,
      negRisk: position.negativeRisk,
    },
    OrderType.FOK
  );

  await refreshPositions();

  return {
    asset,
    title: position.title,
    outcome: position.outcome,
    size,
    marketPrice,
    response,
  };
}

function parseActivityTypes(value: string | null): ActivityType[] | undefined {
  if (!value) return undefined;
  const allowed = new Set<string>(ACTIVITY_ALLOWED_TYPES);
  const types = value
    .split(',')
    .map(item => item.trim().toUpperCase())
    .filter((item): item is ActivityType => Boolean(item) && allowed.has(item));
  return types.length > 0 ? types : undefined;
}

function parseActivitySide(value: string | null): ActivitySide | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toUpperCase();
  return ACTIVITY_ALLOWED_SIDES.includes(normalized as ActivitySide)
    ? (normalized as ActivitySide)
    : undefined;
}

async function fetchActivity(query: URLSearchParams) {
  const user = process.env.FUNDER;
  if (!user) throw new Error('Missing FUNDER env');

  const rawLimit = Number(query.get('limit') ?? ACTIVITY_DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), ACTIVITY_MAX_LIMIT)
      : ACTIVITY_DEFAULT_LIMIT;

  const rawOffset = Number(query.get('offset') ?? 0);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

  const type = parseActivityTypes(query.get('type'));
  const side = parseActivitySide(query.get('side'));

  const params: ActivitySearchParams = {
    user,
    limit,
    offset,
    sortBy: 'TIMESTAMP',
    sortDirection: 'DESC',
  };
  if (type) params.type = type;
  if (side) params.side = side;

  const items = await Effect.runPromise(getActivityFresh(params));
  return {
    user,
    limit,
    offset,
    items: items as Trade[],
    hasMore: items.length === limit,
  };
}

function readAsset(record: Record<string, unknown>) {
  return typeof record.asset_id === 'string'
    ? record.asset_id
    : typeof record.asset === 'string'
      ? record.asset
      : undefined;
}

function readNumber(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function readBestBid(bids: unknown) {
  if (!Array.isArray(bids)) return undefined;

  return bids
    .map(bid => readNumber((bid as Record<string, unknown>).price))
    .filter((price): price is number => price !== undefined)
    .sort((a, b) => b - a)[0];
}

function collectPriceUpdates(message: unknown, prices: PriceUpdates = {}) {
  if (Array.isArray(message)) {
    for (const item of message) collectPriceUpdates(item, prices);
    return prices;
  }

  if (!message || typeof message !== 'object') return prices;
  const record = message as Record<string, unknown>;

  if (Array.isArray(record.changes)) {
    collectPriceUpdates(record.changes, prices);
  }

  const asset = readAsset(record);
  if (!asset) return prices;

  if (Array.isArray(record.bids)) {
    prices[asset] = readBestBid(record.bids) ?? null;
    return prices;
  }

  const explicitBestBid = readNumber(record.best_bid ?? record.bestBid);
  if (explicitBestBid !== undefined) {
    prices[asset] = explicitBestBid;
    return prices;
  }

  // For incremental book changes, only BUY-side prices are usable as the
  // mark-to-sell value for a held outcome token. SELL-side prices can be near
  // 1.0 for the ask and must not be shown as the held asset's current price.
  const side = String(record.side || '').toUpperCase();
  const price = readNumber(record.price);
  if (side === 'BUY' && price !== undefined) {
    prices[asset] = price;
  }

  return prices;
}

function handleMarketMessage(message: unknown) {
  const updates = collectPriceUpdates(message);
  const entries = Object.entries(updates).filter(([asset]) =>
    positions.some(position => position.asset === asset)
  );
  if (entries.length === 0) return;

  for (const [asset, price] of entries) {
    if (price === null) {
      livePrices.delete(asset);
    } else {
      livePrices.set(asset, price);
    }
  }

  broadcast({
    type: 'prices',
    payload: Object.fromEntries(
      entries.filter((entry): entry is [string, number] => entry[1] !== null)
    ),
  });
  broadcastSnapshot();
}

function json(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

async function readRequestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? JSON.parse(body) : {};
}

async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL) {
  if (request.method === 'GET' && url.pathname === '/api/summary') {
    await refreshPositions();
    const snapshot = getSnapshot();
    return json(response, 200, {
      updatedAt: snapshot.updatedAt,
      availableBalance: snapshot.availableBalance,
      positionValue: snapshot.positionValue,
      totalAssetValue: snapshot.totalAssetValue,
      positionCount: snapshot.positionCount,
    });
  }

  if (request.method === 'GET' && url.pathname === '/api/positions') {
    await refreshPositions();
    return json(response, 200, getSnapshot());
  }

  if (request.method === 'GET' && url.pathname === '/api/combo/markets') {
    const events = await getWorldCupComboEvents();
    return json(response, 200, { events });
  }

  if (request.method === 'GET' && url.pathname === '/api/combo/positions') {
    const positions = await getComboPositions();
    return json(response, 200, positions);
  }

  if (request.method === 'POST' && url.pathname === '/api/combo/quote') {
    const body = (await readRequestBody(request)) as { legs?: unknown[]; amount?: number };
    const quote = await requestOfficialComboQuote({
      legs: (body.legs || []) as never,
      amount: Number(body.amount),
    });
    return json(response, 200, { ok: true, quote });
  }

  if (request.method === 'POST' && url.pathname === '/api/combo/order') {
    const body = (await readRequestBody(request)) as {
      legs?: unknown[];
      amount?: number;
      quote?: unknown;
    };
    const result = await placeOfficialComboOrder({
      legs: (body.legs || []) as never,
      amount: Number(body.amount),
      quote: body.quote,
    });
    const positions = await getComboPositions().catch(() => ({ combos: [] }));
    return json(response, 200, { ok: true, result, positions });
  }

  if (request.method === 'GET' && url.pathname === '/api/activity') {
    const result = await fetchActivity(url.searchParams);
    return json(response, 200, result);
  }

  if (request.method === 'POST' && url.pathname === '/api/cashout') {
    await Effect.runPromise(runCashoutCycle);
    await refreshPositions();
    return json(response, 200, { ok: true, snapshot: getSnapshot() });
  }

  const sellMatch = url.pathname.match(/^\/api\/positions\/([^/]+)\/sell$/);
  if (request.method === 'POST' && sellMatch) {
    await readRequestBody(request);
    const result = await sellPosition(decodeURIComponent(sellMatch[1]!));
    return json(response, 200, { ok: true, result, snapshot: getSnapshot() });
  }

  return json(response, 404, { error: 'Not found' });
}

function handleEvents(response: ServerResponse) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  response.write('\n');
  clients.add(response);
  sendEvent(response, { type: 'snapshot', payload: getSnapshot() });

  response.on('close', () => {
    clients.delete(response);
  });
}

function contentType(filePath: string) {
  switch (extname(filePath)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

function getPublicDir() {
  const sourceDir = join(process.cwd(), 'web', 'public');
  if (existsSync(sourceDir)) return sourceDir;

  return join(fileURLToPath(new URL('.', import.meta.url)), 'public');
}

function serveStatic(request: IncomingMessage, response: ServerResponse, url: URL) {
  const publicDir = getPublicDir();
  const requestedPath =
    url.pathname === '/' ? '/index.html' : url.pathname === '/combo' ? '/combo.html' : url.pathname;
  const safePath = normalize(decodeURIComponent(requestedPath)).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(publicDir, safePath);

  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    json(response, 404, { error: 'Not found' });
    return;
  }

  response.writeHead(200, { 'content-type': contentType(filePath) });
  createReadStream(filePath).pipe(response);
}

function formatError(error: unknown) {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function startWebServer(port = Number(process.env.PORT || DEFAULT_PORT)) {
  wsMarket.on('data', handleMarketMessage);
  wsMarket.on('ws_error', error => {
    broadcast({ type: 'status', payload: { level: 'error', message: error.message } });
  });
  wsMarket.run();

  void refreshPositions().catch(error => {
    broadcast({ type: 'status', payload: { level: 'error', message: formatError(error) } });
  });
  refreshTimer = setInterval(() => {
    void refreshPositions().catch(error => {
      broadcast({ type: 'status', payload: { level: 'error', message: formatError(error) } });
    });
  }, POSITIONS_REFRESH_MS);

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

      if (url.pathname === '/events') {
        handleEvents(response);
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        try {
          await handleApi(request, response, url);
        } catch (error) {
          json(response, 500, { error: formatError(error) });
        }
        return;
      }

      serveStatic(request, response, url);
    })();
  });

  server.listen(port, () => {
    console.log(`Web dashboard listening on http://localhost:${port}`);
  });

  server.on('close', () => {
    if (refreshTimer) clearInterval(refreshTimer);
    wsMarket.off('data', handleMarketMessage);
  });

  return server;
}

export const startWebServerEffect = Effect.async<void, never>(resume => {
  startWebServer();
  resume(Effect.never);
});
