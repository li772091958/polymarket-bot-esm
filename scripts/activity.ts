import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { Effect } from 'effect';
import { getActivity, getLeaderboard, getMarkets } from '../src/polymarket/api.js';
import RedisService from '../src/middleware/RedisService.js';
import type { Market, Trade } from '../src/types.js';

function envNumber(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const ONE_DAY_SECONDS = 24 * 60 * 60;
const LEADERBOARD_USERS = envNumber('ACTIVITY_LEADERBOARD_USERS', 500);
const LEADERBOARD_PAGE_SIZE = envNumber('ACTIVITY_LEADERBOARD_PAGE_SIZE', 50);
const ACTIVITY_PAGE_SIZE = envNumber('ACTIVITY_PAGE_SIZE', 1000);
const MAX_HISTORICAL_ACTIVITY_OFFSET = 3000;
const MAX_ACTIVITY_OFFSET = Math.min(
  envNumber('ACTIVITY_MAX_ACTIVITY_OFFSET', MAX_HISTORICAL_ACTIVITY_OFFSET),
  MAX_HISTORICAL_ACTIVITY_OFFSET
);
const MARKET_BATCH_SIZE = envNumber('ACTIVITY_MARKET_BATCH_SIZE', 40);
const MIN_TRADE_USDC = 10;
const MAX_BUY_PRICE = 0.96;
const MIN_MARKETS = 30;
const MAX_MARKETS = 120;
const OUTPUT_LIMIT = envNumber('ACTIVITY_OUTPUT_LIMIT', 50);

type WalletResult = {
  address: string;
  marketCount: number;
  cost: number;
  pnl: number;
  pnlRate: number;
};

type AssetPosition = {
  asset: string;
  size: number;
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const clearProgressLine = () => process.stdout.write(`\r${''.padEnd(140, ' ')}\r`);

function formatIndex(index: number) {
  return index.toString().padStart(3, '0');
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatProgressLine(props: {
  index: number;
  user: string;
  pricedPositions: number;
  positionCount: number;
  activityCount: number;
  cost: number;
  pnl: number;
  pnlRate: number;
  success: number;
  failed: number;
}) {
  return `${formatIndex(props.index)} ${props.user} ${props.pricedPositions}/${
    props.positionCount
  }/${props.activityCount} 成本${props.cost.toFixed(0)}  累计收益${props.pnl.toFixed(
    2
  )}(${formatPercent(props.pnlRate)}) 成功${props.success} 失败${props.failed}`;
}

function renderProgress(line: string) {
  process.stdout.write(`\r${line.padEnd(140, ' ')}`);
}

function formatError(error: any) {
  const parts = [];
  if (error?.status) parts.push(`status=${error.status}`);
  if (error?.url) parts.push(`url=${error.url}`);
  if (error?.message) parts.push(`message=${error.message}`);
  if (parts.length) return parts.join(' ');
  return String(error);
}

async function runEffect<T>(
  effect: Effect.Effect<T, unknown, never>,
  fallback: T,
  label = 'request'
) {
  try {
    return await Effect.runPromise(effect);
  } catch (error: any) {
    console.error(`[http] ${label} failed: ${formatError(error)}`);
    return fallback;
  }
}

async function runEffectWithRetry<T>(
  effectFactory: () => Effect.Effect<T, unknown, never>,
  fallback: T,
  label = 'request',
  retries = 3
) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await Effect.runPromise(effectFactory());
    } catch (error: any) {
      console.error(`[http] ${label} attempt ${attempt}/${retries} failed: ${formatError(error)}`);
      if (attempt < retries) {
        await sleep(500 * attempt);
      }
    }
  }

  return fallback;
}

function getWindow() {
  const end = Math.round(new Date().setHours(0, 0, 0, 0) / 1000);
  return {
    start: end - 7 * ONE_DAY_SECONDS,
    end,
  };
}

function parseJsonArray(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function tokenPricesFromMarket(market: Market) {
  const tokens = parseJsonArray(market.clobTokenIds);
  const prices = parseJsonArray(market.outcomePrices);
  const result = new Map<string, number>();

  tokens.forEach((token, index) => {
    const price = Number(prices[index]);
    if (token && Number.isFinite(price)) {
      result.set(token, price);
    }
  });

  return result;
}

function uniq<T>(items: T[]) {
  return Array.from(new Set(items));
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function getLeaderboardUsers(limit = LEADERBOARD_USERS) {
  const users = new Set<string>();
  let offset = 0;

  while (users.size < limit) {
    const page = await runEffect(
      getLeaderboard({
        category: 'SPORTS',
        timePeriod: 'WEEK',
        limit: LEADERBOARD_PAGE_SIZE,
        offset,
      }),
      [],
      `leaderboard offset=${offset}`
    );

    page.forEach(item => {
      if (item.proxyWallet) users.add(item.proxyWallet);
    });

    if (page.length < LEADERBOARD_PAGE_SIZE) break;
    offset += LEADERBOARD_PAGE_SIZE;
    await sleep(300);
  }

  return Array.from(users).slice(0, limit);
}

async function getUserBuyTrades(
  user: string,
  index: number,
  total: number,
  start: number,
  end: number
) {
  const trades: Trade[] = [];
  let offset = 0;

  while (offset <= MAX_ACTIVITY_OFFSET) {
    const page = await runEffect(
      getActivity({
        user,
        type: ['TRADE'],
        side: 'BUY',
        limit: ACTIVITY_PAGE_SIZE,
        offset,
        start,
        end,
      }),
      [],
      `activity user=${user} offset=${offset}`
    );

    trades.push(...page);
    if (page.length < ACTIVITY_PAGE_SIZE) break;

    offset += ACTIVITY_PAGE_SIZE;
    await sleep(150);
  }

  return trades;
}

async function getTokenPrices(tokenIds: string[]) {
  const prices = new Map<string, number>();

  for (const tokenBatch of chunk(uniq(tokenIds), MARKET_BATCH_SIZE)) {
    const marketGroups = [];

    for (const closed of [true, false]) {
      marketGroups.push(
        await runEffectWithRetry(
          () =>
            getMarkets({
              clob_token_ids: tokenBatch,
              closed,
              limit: tokenBatch.length,
            }),
          [],
          `markets closed=${closed} tokens=${tokenBatch.length}`
        )
      );
      await sleep(150);
    }

    marketGroups.flat().forEach(market => {
      for (const [token, price] of tokenPricesFromMarket(market)) {
        prices.set(token, price);
      }
    });

    await sleep(250);
  }

  return prices;
}

function summarizePositions(trades: Trade[]) {
  const positions = new Map<string, AssetPosition>();

  for (const trade of trades) {
    const current = positions.get(trade.asset);
    if (current) {
      current.size += trade.size;
    } else {
      positions.set(trade.asset, {
        asset: trade.asset,
        size: trade.size,
      });
    }
  }

  return Array.from(positions.values());
}

async function analyzeUser(user: string, index: number, total: number, start: number, end: number) {
  const activityTrades = await getUserBuyTrades(user, index, total, start, end);
  const trades = activityTrades.filter(
    trade => trade.usdcSize >= MIN_TRADE_USDC && trade.price <= MAX_BUY_PRICE
  );
  const marketCount = uniq(trades.map(trade => trade.conditionId || trade.slug)).length;

  if (marketCount < MIN_MARKETS || marketCount > MAX_MARKETS) {
    clearProgressLine();
    return;
  }

  const positions = summarizePositions(trades);
  const prices = await getTokenPrices(positions.map(position => position.asset));
  const cost = trades.reduce((sum, trade) => sum + trade.usdcSize, 0);
  let currentValue = 0;
  let pricedPositions = 0;
  let success = 0;
  let failed = 0;

  for (const position of positions) {
    const price = prices.get(position.asset);
    if (price === undefined) {
      clearProgressLine();
      return;
    }

    currentValue += position.size * price;
    pricedPositions += 1;
    if (price > 0.99) success += 1;
    if (price < 0.01) failed += 1;

    const pnl = currentValue - cost;
    const pnlRate = cost > 0 ? pnl / cost : 0;
    renderProgress(
      formatProgressLine({
        index,
        user,
        pricedPositions,
        positionCount: positions.length,
        activityCount: activityTrades.length,
        cost,
        pnl,
        pnlRate,
        success,
        failed,
      })
    );
  }

  if (cost <= 0) return;

  const pnl = currentValue - cost;
  const pnlRate = pnl / cost;
  renderProgress(
    formatProgressLine({
      index,
      user,
      pricedPositions,
      positionCount: positions.length,
      activityCount: activityTrades.length,
      cost,
      pnl,
      pnlRate,
      success,
      failed,
    })
  );
  process.stdout.write('\n');

  return {
    address: user,
    marketCount,
    cost,
    pnl,
    pnlRate,
  };
}

function csvEscape(value: string | number) {
  const text = typeof value === 'number' ? String(value) : value;
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

async function writeCsv(rows: WalletResult[]) {
  const outDir = path.join(process.cwd(), 'out');
  const outFile = path.join(outDir, 'sports-activity-week.csv');
  const header = ['address', 'marketCount', 'cost', 'pnl', 'pnlRate'];
  const lines = rows.map(row =>
    [
      row.address,
      row.marketCount,
      row.cost.toFixed(2),
      row.pnl.toFixed(2),
      (row.pnlRate * 100).toFixed(2) + '%',
    ]
      .map(csvEscape)
      .join(',')
  );

  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(outFile, [header.join(','), ...lines].join('\n') + '\n');
  return outFile;
}

async function main() {
  const { start, end } = getWindow();
  const users = await getLeaderboardUsers();
  const results: WalletResult[] = [];

  console.log(`Users: ${users.length}, window: ${start} -> ${end}`);

  for (let i = 0; i < users.length; i++) {
    const result = await analyzeUser(users[i]!, i + 1, users.length, start, end);
    if (result) results.push(result);
    await sleep((i + 1) % 50 === 0 ? 3_000 : 300);
  }

  const top = results.sort((a, b) => b.pnlRate - a.pnlRate).slice(0, OUTPUT_LIMIT);
  const outFile = await writeCsv(top);
  console.log(`\nWrote ${top.length} rows to ${outFile}`);
}

main()
  .catch(error => {
    console.error(error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await RedisService.closeInstance();
  });
