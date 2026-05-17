import { AssetType } from '@polymarket/clob-client-v2';
import { Effect } from 'effect';
import RedisService from './middleware/RedisService.js';
import { cbc, getPositions } from './polymarket/api.js';
import type { Position } from './types.js';

const USDC_DECIMALS = 1_000_000;
const DEFAULT_RETRY_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

export const DAILY_PROFIT_SNAPSHOT_KEY_PREFIX = 'polymarket:profit:daily-snapshot:v1';
export const LATEST_PROFIT_SNAPSHOT_KEY = 'polymarket:profit:latest-snapshot:v1';

export type AssetSnapshot = {
  date: string;
  createdAt: string;
  user: string;
  availableBalance: number;
  positionValue: number;
  totalAssetValue: number;
  positionCount: number;
};

export type ProfitReport = {
  date: string;
  baseline: AssetSnapshot;
  current: AssetSnapshot;
  profit: number;
  profitRate: number;
};

type RetryOptions = {
  attempts?: number;
  delayMs?: number;
};

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry<T>(
  label: string,
  action: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_RETRY_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_RETRY_DELAY_MS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      await sleep(delayMs * attempt);
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${label} failed after ${attempts} attempts: ${message}`);
}

function formatDateInTimeZone(date: Date, timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseClobUsdcAmount(raw: string | number) {
  const amount = Number(raw);
  if (!Number.isFinite(amount)) {
    throw new Error(`Invalid CLOB balance amount: ${raw}`);
  }

  return amount / USDC_DECIMALS;
}

function sumPositionValue(positions: Position[]) {
  return positions.reduce((sum, position) => sum + Number(position.currentValue || 0), 0);
}

export function dailyProfitSnapshotKey(date: string) {
  return `${DAILY_PROFIT_SNAPSHOT_KEY_PREFIX}:${date}`;
}

export function getTodayString(now = new Date(), timeZone = process.env.PROFIT_TIME_ZONE) {
  return formatDateInTimeZone(now, timeZone || DEFAULT_TIME_ZONE);
}

export async function collectAssetSnapshot(
  options: { date?: string; user?: string; retry?: RetryOptions } = {}
): Promise<AssetSnapshot> {
  const user = options.user || process.env.FUNDER;
  if (!user) throw new Error('Missing FUNDER env');

  return withRetry(
    'Collect asset snapshot',
    async () => {
      const [balanceAllowance, positions] = await Promise.all([
        cbc.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }),
        Effect.runPromise(getPositions({ user, limit: 500 })),
      ]);

      const availableBalance = parseClobUsdcAmount(balanceAllowance.balance);
      const positionValue = sumPositionValue(positions);

      return {
        date: options.date || getTodayString(),
        createdAt: new Date().toISOString(),
        user,
        availableBalance,
        positionValue,
        totalAssetValue: availableBalance + positionValue,
        positionCount: positions.length,
      };
    },
    options.retry
  );
}

export async function saveDailyProfitSnapshot(snapshot: AssetSnapshot) {
  const redis = RedisService.getInstance();
  const key = dailyProfitSnapshotKey(snapshot.date);

  await Effect.runPromise(redis.set(key, snapshot));
  await Effect.runPromise(redis.set(LATEST_PROFIT_SNAPSHOT_KEY, snapshot));

  return { key, snapshot };
}

export async function createDailyProfitSnapshot(
  options: { date?: string; user?: string; retry?: RetryOptions } = {}
) {
  const snapshot = await collectAssetSnapshot(options);
  return saveDailyProfitSnapshot(snapshot);
}

export async function getDailyProfitSnapshot(date = getTodayString()) {
  const redis = RedisService.getInstance();
  return Effect.runPromise(redis.get<AssetSnapshot>(dailyProfitSnapshotKey(date)));
}

export async function calculateTodayProfit(
  options: { date?: string; user?: string; retry?: RetryOptions } = {}
): Promise<ProfitReport> {
  const date = options.date || getTodayString();
  const baseline = await getDailyProfitSnapshot(date);

  if (!baseline) {
    throw new Error(`Missing daily asset snapshot for ${date}. Run: npm run profit -- --snapshot`);
  }

  const current = await collectAssetSnapshot({
    date,
    user: options.user || baseline.user,
    retry: options.retry,
  });
  const profit = current.totalAssetValue - baseline.totalAssetValue;
  const profitRate = baseline.totalAssetValue > 0 ? profit / baseline.totalAssetValue : 0;

  return {
    date,
    baseline,
    current,
    profit,
    profitRate,
  };
}
