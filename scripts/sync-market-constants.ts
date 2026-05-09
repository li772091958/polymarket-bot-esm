import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axiosInstance from '../src/middleware/axios.js';
import RedisService from '../src/middleware/RedisService.js';

type GammaTag = {
  id: string | number;
  label: string;
  slug: string;
};

type GammaMarket = {
  question?: string;
  title?: string;
  slug: string;
  conditionId: string;
  outcomes?: string;
  clobTokenIds?: string;
  tags?: GammaTag[];
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_OUTPUT = path.join(ROOT, 'src/polymarket/generated/marketConstants.ts');
const SKILL_OUTPUT = path.join(
  ROOT,
  '.codex/skills/polymarket-operator/references/market-constants.json'
);

const WORLD_CUP_WINNER_PATTERN = /^Will (.+) win the 2026 FIFA World Cup\?$/i;

const CN_ALIASES: Record<string, string[]> = {
  Argentina: ['阿根廷'],
  Australia: ['澳大利亚'],
  Austria: ['奥地利'],
  Belgium: ['比利时'],
  Brazil: ['巴西'],
  Canada: ['加拿大'],
  Colombia: ['哥伦比亚'],
  Croatia: ['克罗地亚'],
  Ecuador: ['厄瓜多尔'],
  Egypt: ['埃及'],
  England: ['英格兰', '英国'],
  France: ['法国'],
  Germany: ['德国'],
  Ghana: ['加纳'],
  Iran: ['伊朗'],
  Japan: ['日本'],
  Mexico: ['墨西哥'],
  Morocco: ['摩洛哥'],
  Netherlands: ['荷兰'],
  Portugal: ['葡萄牙'],
  Qatar: ['卡塔尔'],
  'Saudi Arabia': ['沙特', '沙特阿拉伯'],
  Senegal: ['塞内加尔'],
  Spain: ['西班牙'],
  Switzerland: ['瑞士'],
  Tunisia: ['突尼斯'],
  Uruguay: ['乌拉圭'],
  USA: ['美国'],
};

function parseJsonArray(value: string | undefined): string[] {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return value.split(',').map(item => item.trim()).filter(Boolean);
  }
}

function normalizeAlias(value: string) {
  return value.trim().toLowerCase();
}

function unique<T>(items: T[]) {
  return Array.from(new Set(items));
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function getWithRetry<T>(url: string, params: Record<string, unknown>, attempts = 4) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await axiosInstance.get<T>(url, {
        baseURL: 'https://gamma-api.polymarket.com',
        params,
      });
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await sleep(300 * attempt);
    }
  }

  throw lastError;
}

function toTagConstant(tag: GammaTag) {
  return {
    id: Number(tag.id),
    label: tag.label,
    slug: tag.slug,
  };
}

async function fetchAllTags() {
  const tags: GammaTag[] = [];
  const limit = 300;

  for (let offset = 0; offset < 30_000; offset += limit) {
    const response = await getWithRetry<GammaTag[]>('/tags', { limit, offset });

    tags.push(...response.data);

    if (response.data.length < limit) break;
  }

  const byId = new Map<number, ReturnType<typeof toTagConstant>>();

  for (const tag of tags) {
    const constant = toTagConstant(tag);
    if (Number.isFinite(constant.id) && constant.label && constant.slug) {
      byId.set(constant.id, constant);
    }
  }

  return Array.from(byId.values())
    .map(toTagConstant)
    .sort((a, b) => a.label.localeCompare(b.label));
}

async function fetchWorldCupWinnerMarkets() {
  const response = await getWithRetry<GammaMarket[]>('/markets', {
    active: true,
    closed: false,
    limit: 500,
    order: 'volumeNum',
    ascending: false,
    include_tag: true,
  });

  return response.data.filter(market =>
    WORLD_CUP_WINNER_PATTERN.test(market.question || market.title || '')
  );
}

function buildTagAliases(tags: Awaited<ReturnType<typeof fetchAllTags>>) {
  return Object.fromEntries(
    tags.flatMap(tag => [
      [normalizeAlias(tag.label), tag.id],
      [normalizeAlias(tag.slug), tag.id],
    ])
  );
}

function buildWorldCupTeamMarkets(markets: GammaMarket[]) {
  return markets
    .map(market => {
      const title = market.question || market.title || '';
      const country = title.match(WORLD_CUP_WINNER_PATTERN)?.[1];
      const outcomes = parseJsonArray(market.outcomes);
      const tokenIds = parseJsonArray(market.clobTokenIds);
      const yesIndex = outcomes.findIndex(outcome => outcome.toLowerCase() === 'yes');
      const noIndex = outcomes.findIndex(outcome => outcome.toLowerCase() === 'no');

      if (!country || yesIndex < 0 || noIndex < 0) return undefined;

      return {
        country,
        aliases: unique([country, ...country.split(/\s+/), ...(CN_ALIASES[country] ?? [])]).map(
          normalizeAlias
        ),
        slug: market.slug,
        conditionId: market.conditionId,
        yesTokenId: tokenIds[yesIndex] || '',
        noTokenId: tokenIds[noIndex] || '',
        tagIds: unique((market.tags ?? []).map(tag => Number(tag.id)).filter(Number.isFinite)),
      };
    })
    .filter((market): market is NonNullable<typeof market> => Boolean(market))
    .sort((a, b) => a.country.localeCompare(b.country));
}

function buildWorldCupTags(markets: GammaMarket[]) {
  const byId = new Map<number, { id: number; label: string; slug: string }>();

  for (const market of markets) {
    for (const tag of market.tags ?? []) {
      const constant = toTagConstant(tag);
      if (Number.isFinite(constant.id)) byId.set(constant.id, constant);
    }
  }

  return Array.from(byId.values()).sort((a, b) => a.label.localeCompare(b.label));
}

function toTs(data: {
  generatedAt: string;
  tags: Awaited<ReturnType<typeof fetchAllTags>>;
  tagAliases: Record<string, number>;
  worldCupTags: ReturnType<typeof buildWorldCupTags>;
  worldCupTeamMarkets: ReturnType<typeof buildWorldCupTeamMarkets>;
}) {
  return `export type PolymarketTagConstant = {
  id: number;
  label: string;
  slug: string;
};

export type WorldCupTeamMarketConstant = {
  country: string;
  aliases: string[];
  slug: string;
  conditionId: string;
  yesTokenId: string;
  noTokenId: string;
  tagIds: number[];
};

export const GENERATED_AT = ${JSON.stringify(data.generatedAt)};

export const POLYMARKET_TAGS: PolymarketTagConstant[] = ${JSON.stringify(data.tags, null, 2)};

export const POLYMARKET_TAG_ALIASES: Record<string, number> = ${JSON.stringify(
    data.tagAliases,
    null,
    2
  )};

export const WORLD_CUP_TAGS: PolymarketTagConstant[] = ${JSON.stringify(
    data.worldCupTags,
    null,
    2
  )};

export const WORLD_CUP_TEAM_MARKETS: WorldCupTeamMarketConstant[] = ${JSON.stringify(
    data.worldCupTeamMarkets,
    null,
    2
)};
`;
}

async function main() {
  const [tags, worldCupMarkets] = await Promise.all([fetchAllTags(), fetchWorldCupWinnerMarkets()]);
  const generatedAt = new Date().toISOString();
  const data = {
    generatedAt,
    tags,
    tagAliases: buildTagAliases(tags),
    worldCupTags: buildWorldCupTags(worldCupMarkets),
    worldCupTeamMarkets: buildWorldCupTeamMarkets(worldCupMarkets),
  };

  await mkdir(path.dirname(SRC_OUTPUT), { recursive: true });
  await mkdir(path.dirname(SKILL_OUTPUT), { recursive: true });
  await writeFile(SRC_OUTPUT, toTs(data));
  await writeFile(SKILL_OUTPUT, `${JSON.stringify(data, null, 2)}\n`);

  console.table({
    tags: data.tags.length,
    worldCupTags: data.worldCupTags.length,
    worldCupTeamMarkets: data.worldCupTeamMarkets.length,
    generatedAt,
  });
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  })
  .finally(() => RedisService.closeInstance());
