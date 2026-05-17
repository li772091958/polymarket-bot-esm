import { Effect } from 'effect';
import logger from './middleware/logger.js';
import {
  createDailyProfitSnapshot,
  getDailyProfitSnapshot,
  getTodayString,
} from './profit.js';

const CHECK_INTERVAL = '30 seconds';
const DEFAULT_TIME_ZONE = 'Asia/Shanghai';
const SNAPSHOT_WINDOW_MINUTES = 5;

function getTimeParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function isMidnightSnapshotWindow(date = new Date()) {
  const timeZone = process.env.PROFIT_TIME_ZONE || DEFAULT_TIME_ZONE;
  const { hour, minute } = getTimeParts(date, timeZone);
  return hour === 0 && minute < SNAPSHOT_WINDOW_MINUTES;
}

function formatError(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  return error.stack || error.message;
}

const runSnapshotIfNeeded = Effect.gen(function* () {
  if (!isMidnightSnapshotWindow()) return;

  const date = getTodayString();
  const existing = yield* Effect.tryPromise(() => getDailyProfitSnapshot(date));

  if (existing) return;

  yield* Effect.tryPromise(() => createDailyProfitSnapshot({ date }));
});

export const runDailyProfitSnapshotLoop = Effect.forever(
  runSnapshotIfNeeded.pipe(
    Effect.catchAll(error => logger.error('Daily profit snapshot failed', formatError(error))),
    Effect.zipRight(Effect.sleep(CHECK_INTERVAL))
  )
);
