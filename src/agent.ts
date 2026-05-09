import 'dotenv/config';
import { OrderType, Side, type TickSize } from '@polymarket/clob-client-v2';
import { Effect } from 'effect';
import type { Hex } from 'viem';
import RedisService from './middleware/RedisService.js';
import { ApiError, cbc, getMarketBySlug, getMarketPrice, getMarkets, getPositions } from './polymarket/api.js';
import {
  findLatestUpDownMarket,
  findWorldCupWinnerMarket,
  inferWorldCupTeamAliases,
  inferWorldCupTeamMatches,
  inferUpDownAsset,
  inferUpDownInterval,
  inferTagId,
} from './polymarket/marketSearch.js';
import { WORLD_CUP_TEAM_MARKETS } from './polymarket/generated/marketConstants.js';
import { findWorldCupGameEvents, refreshWorldCupGameIndex } from './polymarket/worldCupGames.js';
import { mergePosition, redeemPosition, splitPosition } from './polymarket/relayer.js';
import { runSell } from './sell.js';
import type { Market, Position } from './types.js';
import type { GammaEvent } from './types.js';

type CliOptions = {
  execute: boolean;
  yes: boolean;
  json: boolean;
  clobPrices: boolean;
  text: string;
};

type OutcomeQuote = {
  market: Market;
  outcome: string;
  tokenId: string;
  gammaPrice?: number;
  buyPrice?: number;
  sellPrice?: number;
};

type TradeIntent = {
  side: 'BUY' | 'SELL';
  target: string;
  amount?: number;
  orderKind?: 'market' | 'limit';
  price?: number;
};

const originalConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  originalConsoleError(...args.map(sanitizeLogArg));
};

const CN_DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

const CN_SMALL_UNITS: Record<string, number> = {
  十: 10,
  百: 100,
  千: 1000,
};

const CN_BIG_UNITS: Record<string, number> = {
  万: 10_000,
  亿: 100_000_000,
};

const TRANSLATIONS: Record<string, string> = {
  世界杯: 'world cup',
  德国: 'germany',
  墨西哥: 'mexico',
  南非: 'south africa',
  英国: 'england',
  英格兰: 'england',
  美国: 'usa',
  法国: 'france',
  巴西: 'brazil',
  阿根廷: 'argentina',
  西班牙: 'spain',
  葡萄牙: 'portugal',
  意大利: 'italy',
  荷兰: 'netherlands',
  胜负平: 'win draw',
  让分: 'spread handicap',
  大小球: 'total over under',
  大球: 'over',
  小球: 'under',
  赢: 'win',
  胜: 'win',
  平: 'draw',
};

const WORLD_CUP_TEAM_ZH_OVERRIDES: Record<string, string> = {
  algeria: '阿尔及利亚',
  'bosnia-herzegovina': '波黑',
  'bosnia and herzegovina': '波黑',
  'cape verde': '佛得角',
  'congo dr': '刚果民主共和国',
  'dr congo': '刚果民主共和国',
  "côte d'ivoire": '科特迪瓦',
  'cote d ivoire': '科特迪瓦',
  'ivory coast': '科特迪瓦',
  'curaçao': '库拉索',
  curacao: '库拉索',
  czechia: '捷克',
  haiti: '海地',
  iraq: '伊拉克',
  jordan: '约旦',
  'new zealand': '新西兰',
  norway: '挪威',
  panama: '巴拿马',
  paraguay: '巴拉圭',
  scotland: '苏格兰',
  'south africa': '南非',
  'south korea': '韩国',
  'korea republic': '韩国',
  sweden: '瑞典',
  switzerland: '瑞士',
  tunisia: '突尼斯',
  türkiye: '土耳其',
  turkey: '土耳其',
  'united states': '美国',
  usa: '美国',
  uruguay: '乌拉圭',
  uzbekistan: '乌兹别克斯坦',
};

const WORLD_CUP_TEAM_ZH = new Map<string, string>(
  Object.entries(WORLD_CUP_TEAM_ZH_OVERRIDES)
);

for (const team of WORLD_CUP_TEAM_MARKETS) {
  const zh = team.aliases.find(alias => /[\u4e00-\u9fff]/.test(alias));
  if (!zh) continue;

  WORLD_CUP_TEAM_ZH.set(team.country.toLowerCase(), zh);
  for (const alias of team.aliases) {
    WORLD_CUP_TEAM_ZH.set(alias.toLowerCase(), zh);
  }
}

const STOP_TERMS = new Set([
  'i',
  'me',
  'my',
  'the',
  'a',
  'an',
  'to',
  'for',
  'of',
  'and',
  'or',
  'buy',
  'sell',
  'market',
  'limit',
  'win',
  'wins',
  'odds',
  'price',
  'prices',
  'query',
  'search',
  'look',
  'all',
]);

function parseArgs(args: string[]): CliOptions {
  const textParts: string[] = [];
  const options = { execute: false, yes: false, json: false, clobPrices: false, text: '' };

  for (const arg of args) {
    if (arg === '--execute') {
      options.execute = true;
      continue;
    }
    if (arg === '--yes' || arg === '-y') {
      options.yes = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--clob-prices') {
      options.clobPrices = true;
      continue;
    }
    textParts.push(arg);
  }

  options.text = textParts.join(' ').trim();
  if (!options.text) {
    throw new Error('Usage: npm run agent -- "<自然语言指令>" [--execute --yes] [--json]');
  }

  return options;
}

function translateText(text: string) {
  let translated = text.toLowerCase();
  for (const [from, to] of Object.entries(TRANSLATIONS)) {
    translated = translated.replaceAll(from, ` ${to} `);
  }
  return translated;
}

function tokenize(text: string) {
  return Array.from(
    new Set(
      translateText(text)
        .replace(/[^a-z0-9.\u4e00-\u9fa5]+/gi, ' ')
        .split(/\s+/)
        .map(term => term.trim().toLowerCase())
        .filter(term => term.length > 1 && !STOP_TERMS.has(term))
    )
  );
}

function parseJsonArray(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return value.split(',').map(item => item.trim()).filter(Boolean);
  }
}

function parseNumberWithUnit(raw: string) {
  const match = raw.match(/([0-9]+(?:\.[0-9]+)?)(千万|百万|万|亿|k|m)?/i);
  if (!match) return undefined;

  const base = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  if (!Number.isFinite(base)) return undefined;
  if (unit === '亿') return base * 100_000_000;
  if (unit === '千万') return base * 10_000_000;
  if (unit === '百万' || unit === 'm') return base * 1_000_000;
  if (unit === '万') return base * 10_000;
  if (unit === 'k') return base * 1_000;
  return base;
}

function parseChineseNumber(raw: string) {
  let result = 0;
  let section = 0;
  let number = 0;
  let seen = false;

  for (const char of raw) {
    if (char in CN_DIGITS) {
      number = CN_DIGITS[char];
      seen = true;
      continue;
    }
    if (char in CN_SMALL_UNITS) {
      section += (number || 1) * CN_SMALL_UNITS[char];
      number = 0;
      seen = true;
      continue;
    }
    if (char in CN_BIG_UNITS) {
      result += (section + number || 1) * CN_BIG_UNITS[char];
      section = 0;
      number = 0;
      seen = true;
    }
  }

  return seen ? result + section + number : undefined;
}

function extractAmount(text: string) {
  const explicit = text.match(/([0-9]+(?:\.[0-9]+)?)(?:\s*(u|usdc|美元|美金))/i);
  if (explicit) return parseNumberWithUnit(explicit[1]);

  const actionAmount = text.match(/(?:使用|用|买|卖|赎回|拆分|合并|split|merge|redeem)\s*([0-9]+(?:\.[0-9]+)?(?:千万|百万|万|亿|k|m)?)/i);
  if (actionAmount) return parseNumberWithUnit(actionAmount[1]);

  const numeric = text.match(/(?:\$|usdc|买|卖|赎回|拆分|合并|split|merge|redeem)?\s*([0-9]+(?:\.[0-9]+)?(?:千万|百万|万|亿|k|m)?)/i);
  if (numeric) return parseNumberWithUnit(numeric[1]);

  const chinese = text.match(/[零一二两三四五六七八九十百千万亿]+/);
  return chinese ? parseChineseNumber(chinese[0]) : undefined;
}

function extractLimitPrice(text: string) {
  const match = text.match(/(?:限价|价格|price|@|以)\s*([0](?:\.\d+)?|1(?:\.0+)?)/i);
  if (!match) return undefined;

  const price = Number(match[1]);
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return undefined;
  return price;
}

function stripTradeWords(text: string) {
  return text
    .replace(/--\w+/g, ' ')
    .replace(/[0-9]+(?:\.[0-9]+)?(?:千万|百万|万|亿|k|m)?\s*(?:u|usdc|美元|美金)\b/gi, ' ')
    .replace(/(?:\$|usdc)\s*[0-9]+(?:\.[0-9]+)?(?:千万|百万|万|亿|k|m)?/gi, ' ')
    .replace(/(?:使用|用|买|卖|赎回|拆分|合并|split|merge|redeem)\s*[0-9]+(?:\.[0-9]+)?(?:千万|百万|万|亿|k|m)?/gi, ' ')
    .replace(/[零一二两三四五六七八九十百千万亿]+/g, ' ')
    .replace(/(?:我|全部|全仓|所有|买入|买|卖出|卖|市价|限价|价格|price|以|usdc|赎回|拆分|分拆|合并|merge|split|redeem|cashout|看一下|查询|赔率|市场|仓位|持仓|现在|当前)/gi, ' ')
    .replace(/@\s*(?:0(?:\.\d+)?|1(?:\.0+)?)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferIntent(text: string) {
  const lower = text.toLowerCase();
  if (isWorldCupQuery(text) && /更新|刷新|同步|update|refresh|sync/.test(lower) && /缓存|索引|index|cache/.test(lower)) {
    return 'sync-worldcup-games';
  }
  if (/仓位|持仓|position/.test(lower)) return 'positions';
  if (/买|buy/.test(lower)) return 'buy';
  if (/卖|sell/.test(lower)) return 'sell';
  if (/赎回|redeem|cashout/.test(lower)) return 'redeem';
  if (/拆分|分拆|split/.test(lower)) return 'split';
  if (/合并|merge/.test(lower)) return 'merge';
  return 'markets';
}

function parseTradeIntent(text: string, side: 'BUY' | 'SELL'): TradeIntent {
  const price = extractLimitPrice(text);
  const orderKind = /市价|market/i.test(text) ? 'market' : price ? 'limit' : undefined;

  return {
    side,
    amount: extractAmount(text),
    orderKind,
    price,
    target: stripTradeWords(text),
  };
}

function marketText(market: Market) {
  return [
    market.title,
    market.question,
    market.subtitle,
    market.slug,
    getMarketEventSlug(market),
    market.events?.map(event => [
      event.title,
      event.slug,
      event.description,
      event.seriesSlug,
      event.series?.map((series: { title?: string; slug?: string }) => `${series.title || ''} ${series.slug || ''}`).join(' '),
      event.teams?.map((team: { name?: string; abbreviation?: string }) => `${team.name || ''} ${team.abbreviation || ''}`).join(' '),
    ].filter(Boolean).join(' ')).join(' '),
    market.tags?.map(tag => tag.label).join(' '),
    parseJsonArray(market.outcomes).join(' '),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function getMarketEventSlug(market: Market) {
  const maybeEventSlug = (market as Market & { eventSlug?: string }).eventSlug;
  return maybeEventSlug || market.events?.[0]?.slug || '';
}

function scoreMarket(market: Market, terms: string[]) {
  const text = marketText(market);
  let score = 0;
  for (const term of terms) {
    if (text.includes(term)) score += 3;
  }
  score += Math.log10(Number(market.volumeNum || market.volume || 0) + 1);
  score += Math.log10(Number(market.liquidityNum || market.liquidity || 0) + 1) / 2;
  return score;
}

function isRecentMatchQuery(query: string) {
  return /最近|下一场|比赛|match|game/i.test(query);
}

function isAllMatchesQuery(query: string) {
  return /所有|全部|各个|all|every/i.test(query);
}

function isWorldCupGameQuery(query: string) {
  const lower = query.toLowerCase();
  return isWorldCupQuery(query) && (
    /比赛|小组赛|盘口|胜负平|让分|大小球|最近|下一场|所有|全部|各个/.test(lower) ||
    lower.includes('match') ||
    lower.includes('game') ||
    lower.includes('moneyline') ||
    lower.includes('spread') ||
    lower.includes('total')
  );
}

function marketMatchesQuery(market: Market, terms: string[]) {
  const text = marketText(market);
  return terms.every(term => text.includes(term));
}

function isWorldCupQuery(query: string) {
  const lower = query.toLowerCase();
  return lower.includes('world cup') || lower.includes('世界杯') || lower.includes('fifa');
}

function marketMatchesRecentQuery(market: Market, query: string, teamAliases: string[]) {
  const text = marketText(market);
  const hasTeam =
    teamAliases.length === 0 ||
    teamAliases.some(alias => /^[a-z\s-]+$/.test(alias) && text.includes(alias));
  const hasWorldCup = !isWorldCupQuery(query) || text.includes('world cup') || text.includes('fifa');

  return hasTeam && hasWorldCup;
}

function eventText(event: GammaEvent) {
  return [
    event.title,
    event.slug,
    event.description,
    event.seriesSlug,
    event.series?.map(series => `${series.title || ''} ${series.slug || ''}`).join(' '),
    event.tags?.map(tag => `${tag.label || ''} ${tag.slug || ''}`).join(' '),
    event.teams?.map(team => `${team.name || ''} ${team.abbreviation || ''}`).join(' '),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function eventStartTime(event: GammaEvent) {
  const raw = event.startTime || event.endDate || event.eventDate || event.startDate;
  const time = raw ? Date.parse(raw) : 0;
  return Number.isFinite(time) ? time : 0;
}

function compactEventForMarket(event: GammaEvent) {
  const { markets: _markets, ...compact } = event;
  return compact;
}

function teamNameZh(teamName: string) {
  return WORLD_CUP_TEAM_ZH.get(teamName.toLowerCase()) || teamName;
}

function eventTitleZh(market: Market) {
  const event = market.events?.[0];
  const teams = event?.teams as { name?: string }[] | undefined;
  if (teams?.length) {
    return teams
      .map(team => team.name ? `${teamNameZh(team.name)}(${team.name})` : undefined)
      .filter(Boolean)
      .join(' vs. ');
  }

  const title = event?.title || '';
  return Array.from(WORLD_CUP_TEAM_ZH.entries())
    .sort((a, b) => b[0].length - a[0].length)
    .reduce((value, [english, zh]) => value.replace(new RegExp(english, 'gi'), `${zh}($&)`), title);
}

function marketTitleZh(market: Market) {
  const title = market.question || market.title;
  const winner = title.match(/^Will (.+) win the 2026 FIFA World Cup\??$/i);
  if (winner) return `${teamNameZh(winner[1])}(${winner[1]}) 夺冠`;

  const win = title.match(/^Will (.+) win on (\d{4}-\d{2}-\d{2})\?$/i);
  if (win) return `${teamNameZh(win[1])}(${win[1]}) 胜 - ${win[2]}`;

  const draw = title.match(/^Will (.+) vs\. (.+) end in a draw\?$/i);
  if (draw) {
    return `${teamNameZh(draw[1])}(${draw[1]}) vs. ${teamNameZh(draw[2])}(${draw[2]}) 平局`;
  }

  return title;
}

function attachEventToMarkets(event: GammaEvent) {
  const compactEvent = compactEventForMarket(event);
  return (event.markets || [])
    .filter(market => market.active !== false && market.closed !== true)
    .map(market => ({
      ...market,
      events: [compactEvent],
      tags: market.tags || event.tags || [],
      gameStartTime: market.gameStartTime || event.startTime || event.endDate,
    }));
}

async function searchWorldCupGameMarkets(query: string) {
  if (!isWorldCupGameQuery(query)) return [];

  const teamMatches = inferWorldCupTeamMatches(query);
  const teamAliases = inferWorldCupTeamAliases(query)
    .filter(alias => alias.length >= 2)
    .map(alias => alias.toLowerCase());
  const terms = tokenize(query).filter(term => !['world', 'cup', 'fifa', '比赛', '小组赛', '盘口', '相关', '价格'].includes(term));
  const includeAllMatches = isAllMatchesQuery(query);
  const eventLimit = teamAliases.length > 0 ? (includeAllMatches ? 24 : 8) : 24;
  const events = await findWorldCupGameEvents({
    teamAliases,
    teamAliasGroups: teamMatches.map(team => team.aliases),
    limit: eventLimit,
  });

  const now = Date.now();
  const scoredEvents = events
    .map(event => {
      const text = eventText(event);
      const teamScore = teamAliases.reduce((score, alias) => score + (text.includes(alias) ? 20 : 0), 0);
      const termScore = terms.reduce((score, term) => score + (text.includes(term) ? 4 : 0), 0);
      const start = eventStartTime(event);
      const futurePenalty = start >= now ? (start - now) / (1000 * 60 * 60 * 24 * 365) : 1000;

      return {
        event,
        teamScore,
        score: teamScore + termScore + Math.log10(Number(event.volume || 0) + 1) - futurePenalty,
      };
    })
    .filter(item => teamAliases.length === 0 || item.teamScore > 0)
    .sort((a, b) => {
      if (isRecentMatchQuery(query)) {
        return (
          b.teamScore - a.teamScore ||
          eventStartTime(a.event) - eventStartTime(b.event) ||
          b.score - a.score
        );
      }
      return b.score - a.score;
    });

  const selectedEvents = scoredEvents
    .slice(0, teamAliases.length > 0 ? (includeAllMatches ? 24 : 1) : 6)
    .map(item => item.event);
  return selectedEvents.flatMap(attachEventToMarkets).slice(0, includeAllMatches ? 120 : 24);
}

async function searchMarkets(query: string) {
  const upDownMarket = await findFastUpDownMarket(query);
  if (upDownMarket) return [upDownMarket];

  const worldCupWinnerMarket = await findWorldCupWinnerMarket(query);
  if (worldCupWinnerMarket) return [worldCupWinnerMarket];

  const worldCupGameMarkets = await searchWorldCupGameMarkets(query);
  if (worldCupGameMarkets.length > 0 || isWorldCupGameQuery(query)) return worldCupGameMarkets;

  const terms = tokenize(query);
  const tagId = inferTagId(query);
  const worldCupTeamAliases = inferWorldCupTeamAliases(query);
  const queryTerms = uniqueTerms([
    ...terms,
    ...worldCupTeamAliases.filter(alias => /^[a-z\s-]+$/.test(alias)),
  ]).filter(term => !['world', 'cup', 'fifa', '最近', '一场', '比赛', '相关', '价格'].includes(term));
  const useRecentOrder = isRecentMatchQuery(query);
  const markets = await Effect.runPromise(
    getMarkets({
      active: true,
      closed: false,
      limit: 500,
      order: useRecentOrder ? 'startDate' : 'volumeNum',
      ascending: false,
      include_tag: true,
      ...(tagId ? { tag_id: tagId } : {}),
    })
  );

  const scopedMarkets =
    useRecentOrder
      ? markets.filter(market => marketMatchesRecentQuery(market, query, worldCupTeamAliases))
      : markets;

  const scored = scopedMarkets
    .map(market => ({ market, score: scoreMarket(market, queryTerms.length ? queryTerms : terms) }))
    .filter(item => item.score > 0)
    .sort((a, b) =>
      useRecentOrder
        ? Number(Date.parse(b.market.gameStartTime || b.market.endDate || b.market.startDate || '')) -
          Number(Date.parse(a.market.gameStartTime || a.market.endDate || a.market.startDate || ''))
        : b.score - a.score
    );

  const top = scored.at(0);
  if (!top) return [];

  const eventSlug = getMarketEventSlug(top.market);
  const eventMarkets = eventSlug
    ? markets.filter(market => getMarketEventSlug(market) === eventSlug)
    : scored.slice(0, 12).map(item => item.market);

  return eventMarkets
    .map(market => ({ market, score: scoreMarket(market, terms) }))
    .sort((a, b) => b.score - a.score || Number(b.market.volumeNum || 0) - Number(a.market.volumeNum || 0))
    .slice(0, 24)
    .map(item => item.market);
}

async function findFastUpDownMarket(text: string) {
  const asset = inferUpDownAsset(text);
  const interval = inferUpDownInterval(text);
  const lower = text.toLowerCase();
  const looksLikeUpDown =
    Boolean(asset && interval) &&
    (/涨跌|up.?down|up or down|涨|跌/.test(lower) || lower.includes(`${asset}-updown`));

  if (!looksLikeUpDown || !asset || !interval) return undefined;

  return findLatestUpDownMarket({ asset, interval });
}

async function safeMarketPrice(tokenId: string, side: 'BUY' | 'SELL') {
  try {
    const result = await Effect.runPromise(getMarketPrice({ token_id: tokenId, side }));
    const price = Number(result.price);
    return Number.isFinite(price) ? price : undefined;
  } catch {
    return undefined;
  }
}

async function quoteMarket(market: Market): Promise<OutcomeQuote[]> {
  const outcomes = parseJsonArray(market.outcomes);
  const tokenIds = parseJsonArray(market.clobTokenIds);
  const gammaPrices = parseJsonArray(market.outcomePrices).map(Number);

  return Promise.all(
    outcomes.map(async (outcome, index) => {
      const tokenId = tokenIds[index];
      const [buyPrice, sellPrice] = tokenId
        ? await Promise.all([safeMarketPrice(tokenId, 'BUY'), safeMarketPrice(tokenId, 'SELL')])
        : [undefined, undefined];

      return {
        market,
        outcome,
        tokenId,
        gammaPrice: Number.isFinite(gammaPrices[index]) ? gammaPrices[index] : undefined,
        buyPrice,
        sellPrice,
      };
    })
  );
}

function uniqueTerms(terms: string[]) {
  return Array.from(new Set(terms.map(term => term.trim().toLowerCase()).filter(Boolean)));
}

async function quoteMarketFromGamma(market: Market): Promise<OutcomeQuote[]> {
  const outcomes = parseJsonArray(market.outcomes);
  const tokenIds = parseJsonArray(market.clobTokenIds);
  const gammaPrices = parseJsonArray(market.outcomePrices).map(Number);

  return outcomes.map((outcome, index) => ({
    market,
    outcome,
    tokenId: tokenIds[index],
    gammaPrice: Number.isFinite(gammaPrices[index]) ? gammaPrices[index] : undefined,
  }));
}

async function showMarkets(text: string, options: CliOptions) {
  const markets = await searchMarkets(text);
  const rows = (
    await Promise.all(markets.map(market => (options.clobPrices ? quoteMarket(market) : quoteMarketFromGamma(market))))
  ).flat();

  if (rows.length === 0) {
    return { type: 'markets', message: '没有找到匹配市场。可以换成英文队名、赛事 slug，或加上更具体的球队/赛事名。' };
  }

  return {
    type: 'markets',
    count: rows.length,
    rows: rows.map(row => ({
      title: row.market.question || row.market.title,
      titleZh: marketTitleZh(row.market),
      eventTitle: row.market.events?.[0]?.title,
      eventTitleZh: eventTitleZh(row.market),
      outcome: row.outcome,
      tokenId: row.tokenId,
      buyPrice: row.buyPrice,
      sellPrice: row.sellPrice,
      gammaPrice: row.gammaPrice,
      volume: row.market.volumeNum ?? row.market.volume,
      liquidity: row.market.liquidityNum ?? row.market.liquidity,
      slug: row.market.slug,
      endDate: row.market.endDate,
    })),
  };
}

async function showPositions() {
  const positions = await Effect.runPromise(getPositions({ user: process.env.FUNDER, limit: 500 }));
  const totals = positions.reduce(
    (acc, position) => {
      acc.initialValue += Number(position.initialValue || 0);
      acc.currentValue += Number(position.currentValue || 0);
      acc.cashPnl += Number(position.cashPnl || 0);
      acc.realizedPnl += Number(position.realizedPnl || 0);
      return acc;
    },
    { initialValue: 0, currentValue: 0, cashPnl: 0, realizedPnl: 0 }
  );

  return {
    type: 'positions',
    totals: {
      ...totals,
      totalPnl: totals.cashPnl + totals.realizedPnl,
    },
    rows: positions.map(position => ({
      title: position.title,
      outcome: position.outcome,
      size: position.size,
      avgPrice: position.avgPrice,
      curPrice: position.curPrice,
      initialValue: position.initialValue,
      currentValue: position.currentValue,
      cashPnl: position.cashPnl,
      realizedPnl: position.realizedPnl,
      redeemable: position.redeemable,
      mergeable: position.mergeable,
      asset: position.asset,
      slug: position.slug,
    })),
  };
}

async function findOutcome(target: string) {
  const bareWorldCupWinQuote = await findBareWorldCupTeamWinQuote(target);
  if (bareWorldCupWinQuote) return [bareWorldCupWinQuote];

  const exactMarket = await findExactMarketTarget(target);
  const markets = exactMarket ? [exactMarket] : await searchMarkets(target);
  const terms = tokenize(target);
  const quotes = (await Promise.all(markets.map(quoteMarket))).flat();

  return quotes
    .map(quote => {
      const text = `${marketText(quote.market)} ${quote.outcome}`.toLowerCase();
      const outcome = translateText(quote.outcome).toLowerCase();
      const score = terms.reduce((sum, term) => {
        if (outcome.includes(term)) return sum + 10;
        if (text.includes(term)) return sum + 2;
        return sum;
      }, 0);
      return { quote, score };
    })
    .filter(item => item.score > 0 && item.quote.tokenId)
    .sort((a, b) => b.score - a.score)
    .map(item => item.quote);
}

function extractSlugTarget(target: string) {
  return target
    .split(/\s+/)
    .map(part => part.trim())
    .find(part => /^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(part));
}

async function findExactMarketTarget(target: string) {
  const slug = extractSlugTarget(target);
  if (!slug) return undefined;

  try {
    return await Effect.runPromise(getMarketBySlug(slug));
  } catch {
    return undefined;
  }
}

function isBareWorldCupTeamWinTarget(target: string) {
  const lower = target.toLowerCase();
  return (
    inferWorldCupTeamMatches(target).length === 1 &&
    /赢|胜|win/.test(lower) &&
    !isWorldCupQuery(target) &&
    !/夺冠|冠军|champion|winner|vs|vs\.|对阵|对|和|against/.test(lower)
  );
}

async function findBareWorldCupTeamWinQuote(target: string) {
  if (!isBareWorldCupTeamWinTarget(target)) return undefined;

  const [team] = inferWorldCupTeamMatches(target);
  const markets = await searchWorldCupGameMarkets(`世界杯 ${team.country} 最近一场比赛`);
  const quotes = (await Promise.all(markets.map(quoteMarketFromGamma))).flat();

  return quotes.find(quote => {
    const title = (quote.market.question || quote.market.title || '').toLowerCase();
    const isTeamWinMarket =
      title.startsWith('will ') &&
      title.includes(' win on ') &&
      team.aliases.some(alias => title.includes(alias));

    return isTeamWinMarket && quote.outcome.toLowerCase() === 'yes' && quote.tokenId;
  });
}

function quotePreview(quote: OutcomeQuote) {
  return {
    title: quote.market.question || quote.market.title,
    titleZh: marketTitleZh(quote.market),
    eventTitle: quote.market.events?.[0]?.title,
    eventTitleZh: eventTitleZh(quote.market),
    outcome: quote.outcome,
    gammaPrice: quote.gammaPrice,
    tokenId: quote.tokenId,
    slug: quote.market.slug,
    endDate: quote.market.endDate,
  };
}

async function buy(intent: TradeIntent, options: CliOptions) {
  const bareWorldCupWinQuote = await findBareWorldCupTeamWinQuote(intent.target);

  if (bareWorldCupWinQuote && (!intent.amount || intent.amount <= 0 || !intent.orderKind)) {
    return {
      type: 'needs-input',
      message: '已按最近一场世界杯比赛匹配到该国家获胜市场。请确认买入金额，以及市价买入或限价价格后再下单。',
      matched: quotePreview(bareWorldCupWinQuote),
      required: {
        amount: !intent.amount || intent.amount <= 0,
        orderKindOrPrice: !intent.orderKind,
      },
    };
  }

  if (!intent.amount || intent.amount <= 0) {
    return { type: 'needs-input', message: '需要明确买入金额，例如“买 10 USDC 德国赢”。' };
  }
  if (!intent.orderKind) {
    return { type: 'needs-input', message: '请确认是市价买入，还是给出限价价格买入，例如“市价买入”或“限价 0.42 买入”。' };
  }

  const [quote, second] = await findOutcome(intent.target);
  if (!quote) {
    return { type: 'needs-input', message: `未找到可下单的目标市场/结果: ${intent.target}` };
  }
  if (second && second.market.conditionId !== quote.market.conditionId && !options.execute) {
    return {
      type: 'needs-input',
      message: '匹配到多个候选，请补充 market slug 或更完整的结果名称。',
      candidates: [quote, second].map(item => ({
        title: item.market.question || item.market.title,
        titleZh: marketTitleZh(item.market),
        eventTitleZh: eventTitleZh(item.market),
        outcome: item.outcome,
        slug: item.market.slug,
        tokenId: item.tokenId,
      })),
    };
  }

  const marketInfo = await cbc.getClobMarketInfo(quote.market.conditionId);

  if (intent.orderKind === 'market') {
    const marketPrice = await cbc.calculateMarketPrice(
      quote.tokenId,
      Side.BUY,
      intent.amount,
      OrderType.FOK
    );
    const plan = {
      type: 'buy-plan',
      orderKind: 'market',
      title: quote.market.question || quote.market.title,
      outcome: quote.outcome,
      tokenId: quote.tokenId,
      amount: intent.amount,
      estimatedMarketPrice: marketPrice,
      executeCommand: `npm run agent -- --execute --yes "${intent.amount} USDC 市价买入 ${quote.market.slug} ${quote.outcome}"`,
    };

    if (!options.execute || !options.yes) return plan;

    const response = await cbc.createAndPostMarketOrder(
      {
        tokenID: quote.tokenId,
        side: Side.BUY,
        amount: intent.amount,
        orderType: OrderType.FOK,
      },
      {
        tickSize: String(marketInfo.mts) as TickSize,
        negRisk: marketInfo.nr ?? quote.market.negRisk,
      },
      OrderType.FOK
    );

    return { ...plan, type: 'buy-executed', response };
  }

  if (!intent.price) {
    return { type: 'needs-input', message: '限价买入需要明确价格，例如“限价 0.42 买 10 USDC 德国赢”。' };
  }

  const size = Number((intent.amount / intent.price).toFixed(2));
  const plan = {
    type: 'buy-plan',
    orderKind: 'limit',
    title: quote.market.question || quote.market.title,
    outcome: quote.outcome,
    tokenId: quote.tokenId,
    usdcAmount: intent.amount,
    price: intent.price,
    size,
    executeCommand: `npm run agent -- --execute --yes "${intent.amount} USDC 限价 ${intent.price} 买入 ${quote.market.slug} ${quote.outcome}"`,
  };

  if (!options.execute || !options.yes) return plan;

  const response = await cbc.createAndPostOrder(
    {
      tokenID: quote.tokenId,
      side: Side.BUY,
      price: intent.price,
      size,
    },
    {
      tickSize: String(marketInfo.mts) as TickSize,
      negRisk: marketInfo.nr ?? quote.market.negRisk,
    },
    OrderType.GTC
  );

  return { ...plan, type: 'buy-executed', response };
}

async function findPosition(keyword: string) {
  const query = keyword.trim().toLowerCase();
  const positions = await Effect.runPromise(getPositions({ user: process.env.FUNDER, limit: 500 }));
  const matches = positions.filter(position => {
    const text = [position.asset, position.title, position.outcome, position.slug, position.eventSlug]
      .join(' ')
      .toLowerCase();
    return text.includes(query) || tokenize(keyword).some(term => translateText(text).includes(term));
  });

  return matches;
}

async function sell(intent: TradeIntent, options: CliOptions) {
  if (!intent.target) {
    return { type: 'needs-input', message: '需要说明要卖出的仓位，例如“德国赢这个仓位全部市价卖出”。' };
  }
  if (!intent.orderKind) {
    return { type: 'needs-input', message: '请确认是市价卖出，还是给出限价价格卖出。' };
  }

  const matches = await findPosition(intent.target);
  if (matches.length === 0) {
    return { type: 'needs-input', message: `未找到匹配持仓: ${intent.target}` };
  }
  if (matches.length > 1) {
    return {
      type: 'needs-input',
      message: '匹配到多个持仓，请补充 asset id 或更完整标题。',
      candidates: matches.slice(0, 10).map(position => ({
        title: position.title,
        outcome: position.outcome,
        size: position.size,
        curPrice: position.curPrice,
        asset: position.asset,
      })),
    };
  }

  const position = matches[0];
  const plan: Record<string, unknown> = {
    type: 'sell-plan',
    orderKind: intent.orderKind,
    title: position.title,
    outcome: position.outcome,
    asset: position.asset,
    size: position.size,
    currentPrice: position.curPrice,
  };

  if (intent.orderKind === 'market') {
    plan.estimatedMarketPrice = await cbc.calculateMarketPrice(
      position.asset,
      Side.SELL,
      position.size,
      OrderType.FOK
    );
  } else {
    plan.price = intent.price;
  }

  if (!options.execute || !options.yes) return plan;

  const result = await Effect.runPromise(runSell(position.asset, { price: intent.price }));
  return { ...plan, type: 'sell-executed', response: result.response };
}

async function splitOrMerge(text: string, options: CliOptions, mode: 'split' | 'merge') {
  const amount = extractAmount(text);
  const target = stripTradeWords(text);
  const fastMarket = await findFastUpDownMarket(text);

  if (!amount || (!target && !fastMarket)) {
    return { type: 'needs-input', message: `${mode} 需要目标市场和金额，例如“拆分 <slug> 10”。` };
  }

  const [market] = fastMarket ? [fastMarket] : await searchMarkets(target);
  if (!market?.conditionId) {
    return { type: 'needs-input', message: `未找到市场: ${target}` };
  }

  const plan = {
    type: `${mode}-plan`,
    title: market.question || market.title,
    slug: market.slug,
    conditionId: market.conditionId,
    negativeRisk: market.negRisk,
    amount,
  };

  if (!options.execute || !options.yes) return plan;

  const fn = mode === 'split' ? splitPosition : mergePosition;
  const response = await fn({
    conditionId: market.conditionId as Hex,
    amount,
    negativeRisk: market.negRisk,
  });

  return { ...plan, type: `${mode}-executed`, response };
}

async function redeem(text: string, options: CliOptions) {
  const target = stripTradeWords(text);
  const positions = target
    ? (await findPosition(target)).filter(position => position.redeemable)
    : (await Effect.runPromise(getPositions({ user: process.env.FUNDER, redeemable: true, limit: 500 })));

  if (positions.length === 0) {
    return { type: 'redeem-plan', message: '没有找到可赎回仓位。' };
  }

  const plan = {
    type: 'redeem-plan',
    count: positions.length,
    positions: positions.map(position => ({
      title: position.title,
      outcome: position.outcome,
      size: position.size,
      currentValue: position.currentValue,
      conditionId: position.conditionId,
      asset: position.asset,
    })),
  };

  if (!options.execute || !options.yes) return plan;

  const responses = [];
  for (const position of positions) {
    responses.push(await redeemPosition(position));
  }

  return { ...plan, type: 'redeem-executed', responses };
}

async function syncWorldCupGames() {
  const index = await refreshWorldCupGameIndex();

  return {
    type: 'worldcup-games-cache',
    cached: index.length,
    key: 'polymarket:worldcup:games:v1',
    first: index[0],
    last: index.at(-1),
  };
}

function printResult(result: unknown, json: boolean) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (typeof result === 'object' && result && 'message' in result) {
    console.log((result as { message: string }).message);
  }
  if (typeof result === 'object' && result && 'totals' in result) {
    console.log('Totals:');
    console.table((result as { totals: unknown }).totals);
  }
  if (typeof result === 'object' && result && 'rows' in result) {
    console.table((result as { rows: unknown[] }).rows);
    return;
  }
  if (typeof result === 'object' && result && 'positions' in result) {
    console.table((result as { positions: unknown[] }).positions);
  }
  if (typeof result === 'object' && result && 'candidates' in result) {
    console.table((result as { candidates: unknown[] }).candidates);
  }
  console.dir(result, { depth: null });
}

function redactSensitiveText(raw: string) {
  return raw
    .replace(/("?(?:POLY_API_KEY|POLY_PASSPHRASE|POLY_SIGNATURE|POLY_ADDRESS|PRIVATE_KEY|CLOB_SECRET|CLOB_API_KEY|CLOB_PASS_PHRASE)"?\s*:\s*)"[^"]+"/gi, '$1"[REDACTED]"')
    .replace(/((?:POLY_API_KEY|POLY_PASSPHRASE|POLY_SIGNATURE|POLY_ADDRESS|PRIVATE_KEY|CLOB_SECRET|CLOB_API_KEY|CLOB_PASS_PHRASE)=)[^\s,}]+/gi, '$1[REDACTED]');
}

function sanitizeLogArg(arg: unknown) {
  if (typeof arg === 'string') return redactSensitiveText(arg);
  if (arg instanceof Error) return redactSensitiveText(arg.message);

  try {
    return redactSensitiveText(JSON.stringify(arg));
  } catch {
    return '[Unserializable error]';
  }
}

function sanitizeErrorMessage(error: unknown) {
  const raw =
    error instanceof ApiError || error instanceof Error
      ? error.message
      : String(error);

  return redactSensitiveText(raw);
}

async function main() {
  let exitCode = 0;
  try {
    const options = parseArgs(process.argv.slice(2));
    const intent = inferIntent(options.text);
    let result: unknown;

    if (intent === 'positions') result = await showPositions();
    else if (intent === 'buy') result = await buy(parseTradeIntent(options.text, 'BUY'), options);
    else if (intent === 'sell') result = await sell(parseTradeIntent(options.text, 'SELL'), options);
    else if (intent === 'split') result = await splitOrMerge(options.text, options, 'split');
    else if (intent === 'merge') result = await splitOrMerge(options.text, options, 'merge');
    else if (intent === 'redeem') result = await redeem(options.text, options);
    else if (intent === 'sync-worldcup-games') result = await syncWorldCupGames();
    else result = await showMarkets(options.text, options);

    printResult(result, options.json);
  } catch (error) {
    console.error(sanitizeErrorMessage(error));
    exitCode = 1;
  } finally {
    await RedisService.closeInstance();
    process.exit(exitCode);
  }
}

main();
