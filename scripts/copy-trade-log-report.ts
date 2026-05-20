import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import axiosInstance from '../src/middleware/axios.js';

type BuyLogPayload = {
  order_id?: string;
  asset_id?: string;
  size?: string | number;
  price?: string | number;
  side?: string;
};

type DetailRow = {
  strategy: string;
  assetId: string;
  costPrice: number;
  currentPrice: number | undefined;
  shares: number;
  cost: number;
  profit: number;
};

type SummaryRow = {
  strategy: string;
  totalProfit: number;
  successCount: number;
  failureCount: number;
};

const DEFAULT_LOG_DIR = path.join(process.cwd(), 'logs');
const DEFAULT_OUT_DIR = path.join(process.cwd(), 'out');
const DETAIL_FILE = process.env.COPY_TRADE_LOG_DETAIL_CSV || 'copy-trade-log-report.csv';
const SUMMARY_FILE = process.env.COPY_TRADE_LOG_SUMMARY_CSV || 'copy-trade-log-summary.csv';
const MARKET_BATCH_SIZE = Number(process.env.COPY_TRADE_LOG_MARKET_BATCH_SIZE || 40);
const PRICE_DELAY_MS = Number(process.env.COPY_TRADE_LOG_PRICE_DELAY_MS || 80);
const MARKET_RETRIES = Number(process.env.COPY_TRADE_LOG_MARKET_RETRIES || 3);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function stripAnsi(text: string) {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function parseFiniteNumber(value: unknown) {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function unique<T>(items: T[]) {
  return Array.from(new Set(items));
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function listLogFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async entry => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return listLogFiles(fullPath);
      if (entry.isFile() && entry.name.endsWith('.log')) return [fullPath];
      return [];
    })
  );

  return files.flat().sort();
}

function parseJsonFromLine<T>(line: string) {
  const start = line.indexOf('{');
  const end = line.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return undefined;

  try {
    return JSON.parse(line.slice(start, end + 1)) as T;
  } catch {
    return undefined;
  }
}

function parseBuyLine(line: string): DetailRow | undefined {
  if (!line.includes('买进:') || line.includes('模拟买进')) return undefined;

  const match = line.match(/\]\s*(.*?)\s+买进:\s*\{/);
  const payload = parseJsonFromLine<BuyLogPayload>(line);
  if (!match || !payload?.asset_id) return undefined;

  const shares = parseFiniteNumber(payload.size);
  const buyPrice = parseFiniteNumber(payload.price);
  if (shares === undefined || buyPrice === undefined) return undefined;

  return {
    strategy: match[1].trim() || '未知策略',
    assetId: payload.asset_id,
    costPrice: buyPrice,
    currentPrice: undefined,
    shares,
    cost: shares * buyPrice,
    profit: 0,
  };
}

async function parseLogs(logDir: string) {
  const files = await listLogFiles(logDir);
  const rows: DetailRow[] = [];
  const seenOrderIds = new Set<string>();

  for (const file of files) {
    const content = await fs.readFile(file, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = stripAnsi(rawLine);
      if (!line.trim()) continue;

      if (line.includes('买进:') && !line.includes('模拟买进')) {
        const payload = parseJsonFromLine<BuyLogPayload>(line);
        if (payload?.order_id) {
          if (seenOrderIds.has(payload.order_id)) continue;
          seenOrderIds.add(payload.order_id);
        }

        const row = parseBuyLine(line);
        if (row) rows.push(row);
        continue;
      }

    }
  }

  return rows;
}

function parseStringArray(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value.map(String);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

type GammaMarketPriceRecord = {
  clobTokenIds?: string | string[];
  outcomePrices?: string | string[];
};

async function fetchGammaMarketsByTokenIds(tokenIds: string[], closed: boolean) {
  const host = process.env.GAMMA_HOST || 'https://gamma-api.polymarket.com';
  const params = new URLSearchParams({
    closed: String(closed),
    limit: String(tokenIds.length),
  });

  for (const tokenId of tokenIds) {
    params.append('clob_token_ids', tokenId);
  }

  const response = await axiosInstance.get<GammaMarketPriceRecord[]>(`${host}/markets?${params}`);
  return response.data;
}

async function fetchGammaMarketsBatch(tokenIds: string[], closed: boolean): Promise<GammaMarketPriceRecord[]> {
  for (let attempt = 1; attempt <= MARKET_RETRIES; attempt++) {
    try {
      return await fetchGammaMarketsByTokenIds(tokenIds, closed);
    } catch (error) {
      if (attempt < MARKET_RETRIES) {
        await sleep(250 * attempt);
        continue;
      }

      if (tokenIds.length === 1) {
        console.error(
          `[gamma] markets by clob_token_ids failed closed=${closed} token=${tokenIds[0]}: ${formatError(
            error
          )}`
        );
        return [];
      }

      const middle = Math.ceil(tokenIds.length / 2);
      const left = await fetchGammaMarketsBatch(tokenIds.slice(0, middle), closed);
      await sleep(PRICE_DELAY_MS);
      const right = await fetchGammaMarketsBatch(tokenIds.slice(middle), closed);
      return [...left, ...right];
    }
  }

  return [];
}

async function fetchGammaPrices(assetIds: string[]) {
  const prices = new Map<string, number>();

  for (const batch of chunk(unique(assetIds), MARKET_BATCH_SIZE)) {
    for (const closed of [false, true]) {
      const markets = await fetchGammaMarketsBatch(batch, closed);

      for (const market of markets) {
        const tokens = parseStringArray(market.clobTokenIds);
        const outcomePrices = parseStringArray(market.outcomePrices);
        tokens.forEach((token, index) => {
          const price = parseFiniteNumber(outcomePrices[index]);
          if (token && price !== undefined) prices.set(token, price);
        });
      }

      await sleep(PRICE_DELAY_MS);
    }
  }

  return prices;
}

async function resolveCurrentPrices(assetIds: string[]) {
  return fetchGammaPrices(assetIds);
}

function applyPrices(rows: DetailRow[], prices: Map<string, number>) {
  for (const row of rows) {
    row.currentPrice = prices.get(row.assetId);
    row.profit =
      row.currentPrice !== undefined ? row.shares * row.currentPrice - row.cost : 0;
  }
}

function summarize(rows: DetailRow[]) {
  const summaries = new Map<string, SummaryRow>();

  for (const row of rows) {
    const current =
      summaries.get(row.strategy) ||
      ({
        strategy: row.strategy,
        totalProfit: 0,
        successCount: 0,
        failureCount: 0,
      } satisfies SummaryRow);

    current.totalProfit += row.profit;
    if (row.currentPrice === 1) current.successCount += 1;
    if (row.currentPrice === 0) current.failureCount += 1;

    summaries.set(row.strategy, current);
  }

  return Array.from(summaries.values()).sort((a, b) => a.strategy.localeCompare(b.strategy));
}

function csvEscape(value: string | number | undefined) {
  if (value === undefined) return '';
  const text = typeof value === 'number' ? String(value) : value;
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function formatMoney(value: number) {
  return value.toFixed(4);
}

async function writeCsv(outDir: string, rows: DetailRow[], summaries: SummaryRow[]) {
  await fs.mkdir(outDir, { recursive: true });

  const detailHeader = ['跟单策略名称', '资产id', '成本价', '当前价', '份额', '成本', '利润'];
  const detailLines = rows.map(row =>
    [
      row.strategy,
      row.assetId,
      row.costPrice.toFixed(4),
      row.currentPrice === undefined ? undefined : row.currentPrice.toFixed(4),
      row.shares.toFixed(6),
      formatMoney(row.cost),
      formatMoney(row.profit),
    ]
      .map(csvEscape)
      .join(',')
  );

  const summaryHeader = ['跟单策略名称', '总利润', '成功次数', '失败次数'];
  const summaryLines = summaries.map(row =>
    [row.strategy, formatMoney(row.totalProfit), row.successCount, row.failureCount]
      .map(csvEscape)
      .join(',')
  );

  const detailPath = path.join(outDir, DETAIL_FILE);
  const summaryPath = path.join(outDir, SUMMARY_FILE);

  await fs.writeFile(detailPath, [detailHeader.join(','), ...detailLines].join('\n') + '\n');
  await fs.writeFile(summaryPath, [summaryHeader.join(','), ...summaryLines].join('\n') + '\n');

  return { detailPath, summaryPath };
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  const logDir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_LOG_DIR;
  const outDir = process.argv[3] ? path.resolve(process.argv[3]) : DEFAULT_OUT_DIR;

  const rows = await parseLogs(logDir);
  const assetIds = unique(rows.map(row => row.assetId));

  console.log(`解析日志: ${logDir}`);
  console.log(`记录数: ${rows.length}, 资产数: ${assetIds.length}`);

  const prices = await resolveCurrentPrices(assetIds);
  applyPrices(rows, prices);

  rows.sort((a, b) => a.strategy.localeCompare(b.strategy) || a.assetId.localeCompare(b.assetId));
  const summaries = summarize(rows);
  const { detailPath, summaryPath } = await writeCsv(outDir, rows, summaries);

  console.log(`明细 CSV: ${detailPath}`);
  console.log(`汇总 CSV: ${summaryPath}`);
  for (const summary of summaries) {
    console.log(
      `${summary.strategy}: 利润 ${formatMoney(summary.totalProfit)}, 成功 ${
        summary.successCount
      }, 失败 ${summary.failureCount}`
    );
  }
}

main().catch(error => {
  console.error(formatError(error));
  process.exitCode = 1;
});
