import { Effect } from 'effect';
import { getMarketBySlug, getMarkets } from './api.js';
import type { Market } from '../types.js';
import {
  POLYMARKET_TAG_ALIASES,
  WORLD_CUP_TEAM_MARKETS,
} from './generated/marketConstants.js';

export type UpDownAsset = 'btc' | 'eth' | 'sol' | 'xrp';
export type UpDownInterval = '5m' | '15m';

const ASSET_NAMES: Record<UpDownAsset, string> = {
  btc: 'Bitcoin',
  eth: 'Ethereum',
  sol: 'Solana',
  xrp: 'XRP',
};

const ASSET_ALIASES: Record<string, UpDownAsset> = {
  btc: 'btc',
  bitcoin: 'btc',
  比特币: 'btc',
  eth: 'eth',
  ethereum: 'eth',
  以太坊: 'eth',
  sol: 'sol',
  solana: 'sol',
  xrp: 'xrp',
  瑞波: 'xrp',
};

const WORLD_CUP_EXTRA_TEAM_ALIASES: Record<string, string[]> = {
  Algeria: ['阿尔及利亚'],
  'Bosnia-Herzegovina': ['波黑', 'bosnia and herzegovina'],
  'Cape Verde': ['佛得角'],
  'Congo DR': ['刚果民主共和国', 'dr congo'],
  Curaçao: ['库拉索', 'curacao'],
  Czechia: ['捷克'],
  Haiti: ['海地'],
  Iraq: ['伊拉克'],
  'Ivory Coast': ['科特迪瓦', "côte d'ivoire", 'cote d ivoire'],
  Jordan: ['约旦'],
  'New Zealand': ['新西兰'],
  Norway: ['挪威'],
  Panama: ['巴拿马'],
  Paraguay: ['巴拉圭'],
  Scotland: ['苏格兰'],
  'South Africa': ['南非'],
  'South Korea': ['韩国', 'korea republic'],
  Sweden: ['瑞典'],
  Switzerland: ['瑞士'],
  Tunisia: ['突尼斯'],
  Türkiye: ['土耳其', 'turkey'],
  'United States': ['美国', 'usa'],
  Uruguay: ['乌拉圭'],
  Uzbekistan: ['乌兹别克斯坦'],
};

const BROAD_WORLD_CUP_ALIASES = new Set([
  'africa',
  'arabia',
  'cape',
  'coast',
  'dr',
  'ivory',
  'new',
  'south',
  'verde',
]);

function worldCupTeamAliases(team: { country: string; aliases: string[] }) {
  return [
    team.country.toLowerCase(),
    ...team.aliases,
    ...(WORLD_CUP_EXTRA_TEAM_ALIASES[team.country] || []),
  ]
    .map(alias => alias.toLowerCase())
    .filter(alias => !BROAD_WORLD_CUP_ALIASES.has(alias));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textMatchesAlias(text: string, alias: string) {
  if (/[\u4e00-\u9fff]/.test(alias)) return text.includes(alias);
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(alias)}($|[^a-z0-9])`, 'i').test(text);
}

export function inferUpDownAsset(text: string): UpDownAsset | undefined {
  const lower = text.toLowerCase();

  for (const [alias, asset] of Object.entries(ASSET_ALIASES)) {
    if (lower.includes(alias)) return asset;
  }

  return undefined;
}

export function inferUpDownInterval(text: string): UpDownInterval | undefined {
  const lower = text.toLowerCase();

  if (/5\s*(m|min|minute|分钟)/i.test(lower)) return '5m';
  if (/15\s*(m|min|minute|分钟)/i.test(lower)) return '15m';

  return undefined;
}

export function inferTagId(text: string): number | undefined {
  const lower = text.toLowerCase();
  const entries = Object.entries(POLYMARKET_TAG_ALIASES)
    .filter(([alias]) => alias.length >= 2 && lower.includes(alias))
    .sort((a, b) => b[0].length - a[0].length);

  return entries[0]?.[1];
}

export function inferWorldCupWinnerMarket(text: string) {
  const lower = text.toLowerCase();
  const isWinnerQuery =
    lower.includes('夺冠') ||
    lower.includes('冠军') ||
    lower.includes('win the 2026 fifa world cup') ||
    lower.includes('win world cup');

  if (!isWinnerQuery) return undefined;

  return WORLD_CUP_TEAM_MARKETS.find(team =>
    worldCupTeamAliases(team).some(alias => alias.length >= 2 && textMatchesAlias(lower, alias))
  );
}

export function inferWorldCupTeamAliases(text: string) {
  const lower = text.toLowerCase();

  return WORLD_CUP_TEAM_MARKETS.filter(team =>
    worldCupTeamAliases(team).some(alias => alias.length >= 2 && textMatchesAlias(lower, alias))
  ).flatMap(worldCupTeamAliases);
}

export function inferWorldCupTeamMatches(text: string) {
  const lower = text.toLowerCase();

  return WORLD_CUP_TEAM_MARKETS.filter(team =>
    worldCupTeamAliases(team).some(alias => alias.length >= 2 && textMatchesAlias(lower, alias))
  ).map(team => ({
    country: team.country,
    aliases: worldCupTeamAliases(team),
  }));
}

const toTime = (value: string | undefined) => {
  const time = value ? Date.parse(value) : 0;
  return Number.isFinite(time) ? time : 0;
};

export async function findLatestUpDownMarket({
  asset,
  interval,
}: {
  asset: UpDownAsset;
  interval: UpDownInterval;
}): Promise<Market | undefined> {
  const markets = await Effect.runPromise(
    getMarkets({
      active: true,
      closed: false,
      limit: 500,
      order: 'startDate',
      ascending: false,
      include_tag: true,
    })
  );

  const slugPrefix = `${asset}-updown-${interval}-`;
  const assetName = ASSET_NAMES[asset].toLowerCase();
  const intervalMinutes = interval.replace('m', '');

  return markets
    .filter(market => {
      const question = (market.question || market.title || '').toLowerCase();
      const slug = market.slug.toLowerCase();

      return (
        slug.startsWith(slugPrefix) ||
        (question.includes(assetName) &&
          question.includes('up or down') &&
          question.includes(`${intervalMinutes}am`) === false &&
          question.includes(`${intervalMinutes}:`) === false &&
          question.includes(intervalMinutes))
      );
    })
    .sort(
      (a, b) =>
        toTime(b.endDate || b.gameStartTime) - toTime(a.endDate || a.gameStartTime) ||
        toTime(b.startDate) - toTime(a.startDate)
    )[0];
}

export async function findWorldCupWinnerMarket(text: string) {
  const indexed = inferWorldCupWinnerMarket(text);
  if (!indexed) return undefined;

  return Effect.runPromise(getMarketBySlug(indexed.slug));
}
