import axios from 'axios';
import { Effect } from 'effect';
import { getPositions } from './api.js';

const COMBO_MARKETS_BASE_URL = process.env.COMBO_MARKETS_BASE_URL || 'https://combos-rfq-api.polymarket.com';
const COMBO_QUOTE_URL = process.env.COMBO_QUOTE_URL;
const COMBO_ORDER_URL = process.env.COMBO_ORDER_URL;
const COMBO_POSITIONS_URL = process.env.COMBO_POSITIONS_URL || 'https://data-api.polymarket.com/v1/positions/combos';
const WORLD_CUP_WINDOW_BEFORE_MS = 2 * 60 * 60 * 1000;
const WORLD_CUP_WINDOW_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_EVENTS = 6;
const MAX_LEGS = 5;

export type ComboMarket = {
  id: string;
  condition_id: string;
  position_ids: string[];
  slug: string;
  title: string;
  outcomes: string[];
  outcome_prices: string[];
  image?: string;
  volume?: number;
  tags?: string[];
};

export type ComboLegInput = {
  marketId: string;
  conditionId: string;
  positionId: string;
  outcomeIndex: number;
  outcome: string;
};

export type ComboEvent = {
  id: string;
  title: string;
  startsAt: string;
  markets: ComboMarket[];
};

type ComboMarketsResponse = {
  markets?: ComboMarket[];
  next_cursor?: string | null;
};

function asArray<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function slugDate(slug: string) {
  const match = slug.match(/(20\d{2})-(\d{2})-(\d{2})/);
  if (!match) return undefined;
  const time = Date.parse(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  return Number.isFinite(time) ? new Date(time) : undefined;
}

function normalizeWorldCupTitle(title: string) {
  return title
    .replace(/^Will\s+/i, '')
    .replace(/\s+win(?:\s+on\s+20\d{2}-\d{2}-\d{2})?\??$/i, '')
    .replace(/\s+vs\s+/i, ' vs ')
    .trim();
}

function eventKey(market: ComboMarket) {
  const date = slugDate(market.slug)?.toISOString().slice(0, 10) || 'unknown-date';
  const slugWithoutOutcome = market.slug.replace(/-(yes|no)$/i, '').replace(/-[a-z]{2,4}$/i, '');
  const prefix = slugWithoutOutcome.replace(/-20\d{2}-\d{2}-\d{2}.*/, '');
  return `${prefix}-${date}`;
}

function isWorldCupMarket(market: ComboMarket) {
  const haystack = [market.slug, market.title, ...asArray(market.tags)].join(' ').toLowerCase();
  return haystack.includes('world-cup') || haystack.includes('fifa') || haystack.includes('fifwc');
}

function isInWindow(market: ComboMarket, now = Date.now()) {
  const date = slugDate(market.slug);
  if (!date) return false;
  const time = date.getTime();
  return time >= now - WORLD_CUP_WINDOW_BEFORE_MS && time <= now + WORLD_CUP_WINDOW_AFTER_MS;
}

async function fetchComboMarketPage(cursor?: string) {
  const response = await axios.get<ComboMarketsResponse>(`${COMBO_MARKETS_BASE_URL}/v1/rfq/combo-markets`, {
    params: { limit: 100, ...(cursor ? { cursor } : {}) },
    timeout: 12_000,
  });
  return response.data;
}

export async function getWorldCupComboEvents(now = Date.now()): Promise<ComboEvent[]> {
  const collected: ComboMarket[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < 8; page += 1) {
    const data = await fetchComboMarketPage(cursor);
    collected.push(...asArray(data.markets));
    if (!data.next_cursor) break;
    cursor = data.next_cursor;
  }

  const grouped = new Map<string, ComboEvent>();
  for (const market of collected.filter(market => isWorldCupMarket(market) && isInWindow(market, now))) {
    const date = slugDate(market.slug);
    if (!date) continue;
    const key = eventKey(market);
    const existing = grouped.get(key);
    if (existing) {
      existing.markets.push(market);
    } else {
      grouped.set(key, {
        id: key,
        title: normalizeWorldCupTitle(market.title) || market.title,
        startsAt: date.toISOString(),
        markets: [market],
      });
    }
  }

  return [...grouped.values()]
    .map(event => ({
      ...event,
      markets: event.markets.sort((a, b) => (b.volume || 0) - (a.volume || 0)),
    }))
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    .slice(0, MAX_EVENTS);
}

function validateLegs(legs: ComboLegInput[]) {
  if (!Array.isArray(legs) || legs.length < 2) throw new Error('串关至少需要选择 2 腿');
  if (legs.length > MAX_LEGS) throw new Error(`串关最多支持 ${MAX_LEGS} 腿`);
  const conditionIds = new Set(legs.map(leg => leg.conditionId));
  if (conditionIds.size !== legs.length) throw new Error('同一个市场只能选择一个结果');
}

function authHeaders() {
  return {
    ...(process.env.COMBO_API_BEARER_TOKEN ? { authorization: `Bearer ${process.env.COMBO_API_BEARER_TOKEN}` } : {}),
    ...(process.env.COMBO_PARTICIPANT_ID ? { 'x-participant-id': process.env.COMBO_PARTICIPANT_ID } : {}),
  };
}

export async function requestOfficialComboQuote({ legs, amount }: { legs: ComboLegInput[]; amount: number }) {
  validateLegs(legs);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('请输入有效下注金额');
  if (!COMBO_QUOTE_URL) throw new Error('Missing COMBO_QUOTE_URL env for official combo quote service');

  const response = await axios.post(
    COMBO_QUOTE_URL,
    { legs, amount_usdc: amount, side: 'YES', direction: 'BUY' },
    { headers: authHeaders(), timeout: 30_000 }
  );
  return response.data;
}

export async function placeOfficialComboOrder({ legs, amount, quote }: { legs: ComboLegInput[]; amount: number; quote: unknown }) {
  validateLegs(legs);
  if (!COMBO_ORDER_URL) throw new Error('Missing COMBO_ORDER_URL env for official combo order service');

  const response = await axios.post(
    COMBO_ORDER_URL,
    { legs, amount_usdc: amount, quote, side: 'YES', direction: 'BUY' },
    { headers: authHeaders(), timeout: 60_000 }
  );
  return response.data;
}

export async function getComboPositions(user = process.env.FUNDER) {
  if (!user) throw new Error('Missing FUNDER env');

  try {
    const response = await axios.get(COMBO_POSITIONS_URL, {
      params: { user, limit: 50 },
      timeout: 12_000,
    });
    return response.data;
  } catch {
    const fallback = await Effect.runPromise(getPositions({ user, limit: 500 }));
    return { combos: fallback.filter(position => position.title.toLowerCase().includes('combo')) };
  }
}
