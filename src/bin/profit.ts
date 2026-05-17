import 'dotenv/config';
import RedisService from '../middleware/RedisService.js';
import {
  calculateTodayProfit,
  createDailyProfitSnapshot,
  getTodayString,
  type AssetSnapshot,
  type ProfitReport,
} from '../profit.js';

type ParsedArgs = {
  mode: 'report' | 'snapshot';
  json: boolean;
  help: boolean;
  date?: string;
};

function usage(message?: string) {
  return [
    'Usage:',
    '  npm run profit',
    '  npm run profit -- --json',
    '  npm run profit -- --snapshot',
    '  npm run profit -- --snapshot --date YYYY-MM-DD',
    message ? `\n${message}` : '',
  ].join('\n');
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { mode: 'report', json: false, help: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--snapshot') {
      parsed.mode = 'snapshot';
      continue;
    }

    if (arg === '--json') {
      parsed.json = true;
      continue;
    }

    if (arg === '-h' || arg === '--help') {
      parsed.help = true;
      continue;
    }

    if (arg === '--date') {
      parsed.date = args[index + 1];
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  if (parsed.date && !/^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) {
    throw new Error(`Invalid date: ${parsed.date}`);
  }

  return parsed;
}

function formatMoney(value: number) {
  return value.toFixed(2);
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function snapshotRow(snapshot: AssetSnapshot) {
  return {
    date: snapshot.date,
    createdAt: snapshot.createdAt,
    availableBalance: formatMoney(snapshot.availableBalance),
    positionValue: formatMoney(snapshot.positionValue),
    totalAssetValue: formatMoney(snapshot.totalAssetValue),
    positionCount: snapshot.positionCount,
  };
}

function printSnapshot(snapshot: AssetSnapshot, key: string) {
  console.log(`Saved snapshot: ${key}`);
  console.table(snapshotRow(snapshot));
}

function printReport(report: ProfitReport) {
  console.table({
    date: report.date,
    baselineAt: report.baseline.createdAt,
    currentAt: report.current.createdAt,
    baselineTotal: formatMoney(report.baseline.totalAssetValue),
    currentTotal: formatMoney(report.current.totalAssetValue),
    profit: formatMoney(report.profit),
    profitRate: formatPercent(report.profitRate),
    availableBalance: formatMoney(report.current.availableBalance),
    positionValue: formatMoney(report.current.positionValue),
    positionCount: report.current.positionCount,
  });
}

function formatError(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  return error.stack || error.message;
}

async function main() {
  let exitCode = 0;

  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.help) {
      console.log(usage());
      return;
    }

    const date = parsed.date || getTodayString();

    if (parsed.mode === 'snapshot') {
      const result = await createDailyProfitSnapshot({ date });
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printSnapshot(result.snapshot, result.key);
      }
      return;
    }

    const report = await calculateTodayProfit({ date });
    if (parsed.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printReport(report);
    }
  } catch (error) {
    console.error(usage(formatError(error)));
    exitCode = 1;
  } finally {
    await RedisService.closeInstance();
    process.exit(exitCode);
  }
}

main();
