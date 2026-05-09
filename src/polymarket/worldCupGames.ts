import { Effect } from 'effect';
import RedisService from '../middleware/RedisService.js';
import type { GammaEvent } from '../types.js';
import { getEvents } from './api.js';

const WORLD_CUP_SERIES_SLUG = 'soccer-fifwc';
const WORLD_CUP_GAMES_INDEX_KEY = 'polymarket:worldcup:games:v1';
const WORLD_CUP_GAMES_INDEX_TTL_SECONDS = 24 * 60 * 60;

export type WorldCupGameIndexEntry = {
  slug: string;
  title: string;
  startTime?: string;
  endDate?: string;
  eventDate?: string;
  teamNames: string[];
  teamAbbreviations: string[];
  searchText: string;
};

function eventStartTime(event: Partial<Pick<GammaEvent, 'startTime' | 'endDate' | 'eventDate' | 'startDate'>>) {
  const raw = event.startTime || event.endDate || event.eventDate || event.startDate;
  const time = raw ? Date.parse(raw) : 0;
  return Number.isFinite(time) ? time : 0;
}

function buildSearchText(event: GammaEvent) {
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

function toIndexEntry(event: GammaEvent): WorldCupGameIndexEntry {
  return {
    slug: event.slug,
    title: event.title,
    startTime: event.startTime,
    endDate: event.endDate,
    eventDate: event.eventDate,
    teamNames: event.teams?.map(team => team.name).filter(Boolean) || [],
    teamAbbreviations: event.teams?.map(team => team.abbreviation || '').filter(Boolean) || [],
    searchText: buildSearchText(event),
  };
}

async function fetchWorldCupGameIndex() {
  const events = await Effect.runPromise(
    getEvents({
      active: true,
      closed: false,
      archived: false,
      limit: 500,
      order: 'endDate',
      ascending: true,
      series_slug: WORLD_CUP_SERIES_SLUG,
    })
  );

  return events
    .filter(event => event.active !== false && event.closed !== true)
    .map(toIndexEntry)
    .sort((a, b) => eventStartTime(a) - eventStartTime(b));
}

export async function refreshWorldCupGameIndex() {
  const redis = RedisService.getInstance();
  const index = await fetchWorldCupGameIndex();

  await Effect.runPromise(redis.set(WORLD_CUP_GAMES_INDEX_KEY, index, WORLD_CUP_GAMES_INDEX_TTL_SECONDS));
  return index;
}

export async function getWorldCupGameIndex({ refresh = false } = {}) {
  const redis = RedisService.getInstance();

  if (!refresh) {
    const cached = await Effect.runPromise(
      redis.get<WorldCupGameIndexEntry[]>(WORLD_CUP_GAMES_INDEX_KEY).pipe(
        Effect.catchAll(() => Effect.succeed(null))
      )
    );

    if (cached?.length) return cached;
  }

  return refreshWorldCupGameIndex();
}

export async function findWorldCupGameEvents({
  teamAliases,
  teamAliasGroups,
  limit,
  refresh,
}: {
  teamAliases: string[];
  teamAliasGroups?: string[][];
  limit: number;
  refresh?: boolean;
}) {
  const index = await getWorldCupGameIndex({ refresh });
  const normalizedAliases = teamAliases
    .map(alias => alias.trim().toLowerCase())
    .filter(alias => alias.length >= 2);
  const normalizedGroups = (teamAliasGroups || [])
    .map(group => group.map(alias => alias.trim().toLowerCase()).filter(alias => alias.length >= 2))
    .filter(group => group.length > 0);

  const matchedIndex = index
    .filter(entry =>
      normalizedGroups.length > 0
        ? normalizedGroups.every(group => group.some(alias => entry.searchText.includes(alias)))
        : normalizedAliases.length === 0 ||
          normalizedAliases.some(alias => entry.searchText.includes(alias))
    )
    .sort((a, b) => eventStartTime(a) - eventStartTime(b))
    .slice(0, limit);

  const details = await Promise.all(
    matchedIndex.map(async entry => {
      const [event] = await Effect.runPromise(
        getEvents({
          slug: entry.slug,
        })
      );

      return event;
    })
  );

  return details.filter(Boolean);
}
