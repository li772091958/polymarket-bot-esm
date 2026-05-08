import { ClobClient } from '@polymarket/clob-client-v2';
import 'dotenv/config';
import { Wallet } from '@ethersproject/wallet';
import type { AxiosResponse } from 'axios';
import { Context, Data, Effect, Layer, Schedule } from 'effect';
import RedisService from '../middleware/RedisService.js';
import axiosInstance from '../middleware/axios.js';
import {
  ActivitySearchParams,
  LeaderboardSearchParams,
  Market,
  MarketPrice,
  MarketPriceSearchParams,
  MarketSearchProps,
  Position,
  PositionSearchParams,
  Trade,
  TraderLeaderboardEntry,
} from '../types.js';

const builderCode = process.env.POLY_BUILDER_CODE;

export const cbc = new ClobClient({
  host: process.env.CLOB_HOST!,
  chain: 137,
  signer: new Wallet(process.env.PRIVATE_KEY!),
  creds: {
    key: `${process.env.CLOB_API_KEY}`,
    secret: `${process.env.CLOB_SECRET}`,
    passphrase: `${process.env.CLOB_PASS_PHRASE}`,
  },
  signatureType: 1,
  funderAddress: process.env.FUNDER,
  throwOnError: true,
  ...(builderCode ? { builderConfig: { builderCode } } : {}),
});

export class ApiError extends Data.TaggedError('ApiError')<{
  readonly message: string;
  readonly status?: number;
  readonly url?: string;
  readonly attempt?: number;
}> {}

type RedisServiceShape = {
  get: <T>(key: string) => Effect.Effect<T | null, Error>;
  set: (key: string, value: unknown, expireSeconds: number) => Effect.Effect<void, Error>;
};

type HttpClientShape = {
  get: <T>(url: string) => Effect.Effect<AxiosResponse<T>, ApiError>;
};

type ConfigShape = {
  baseUrl: (api: 'gamma-api' | 'data-api' | 'clob') => string;
};

export class Redis extends Context.Tag('Redis')<Redis, RedisServiceShape>() {}
export class HttpClient extends Context.Tag('HttpClient')<HttpClient, HttpClientShape>() {}
export class Config extends Context.Tag('Config')<Config, ConfigShape>() {}

export interface DataApiProps {
  path: string;
  cacheExpired?: number;
  api: 'gamma-api' | 'data-api' | 'clob';
}

function resolvePath(path: string, params: Record<string, any>) {
  const usedKeys = new Set<string>();
  const pathParams: Record<string, any> = {};

  const finalPath = path.replace(/:([a-zA-Z0-9_]+)/g, (_, key) => {
    if (!(key in params)) {
      throw new Error(`Missing path param: ${key}`);
    }

    usedKeys.add(key);
    pathParams[key] = params[key];
    return encodeURIComponent(params[key]);
  });

  const restParams: Record<string, any> = {};
  for (const key in params) {
    if (!usedKeys.has(key)) {
      restParams[key] = params[key];
    }
  }

  return {
    finalPath,
    pathParams,
    query: restParams,
  };
}

function buildHttpCacheKey(pathTemplate: string, pathParams: Record<string, any>, search: string) {
  let cachePath = pathTemplate;
  const hasPathParams = Object.keys(pathParams).length > 0;

  for (const [key, value] of Object.entries(pathParams)) {
    cachePath = cachePath.replace(`:${key}`, String(value));
  }

  if (hasPathParams) {
    cachePath = cachePath.replace(/\/([^/]+)$/, ':$1');
  }

  if (search) {
    return `httpcache:${cachePath}:${search}`;
  }

  return `httpcache:${cachePath}`;
}

function objToSearchString(
  obj: Record<string, unknown>,
  defaultProps: Record<string, unknown> = {}
) {
  return new URLSearchParams(
    Object.entries({
      ...defaultProps,
      ...obj,
    }).flatMap(([key, value]) =>
      Array.isArray(value)
        ? value.map(item => [key, String(item)] as [string, string])
        : [[key, String(value ?? '')] as [string, string]]
    )
  ).toString();
}

function is502Error(error: { status?: number; message: string }) {
  return error.status === 502 || error.message.includes('502');
}

function resolvePathEffect(path: string, params: Record<string, any>) {
  return Effect.try({
    try: () => resolvePath(path, params),
    catch: cause =>
      new ApiError({
        message: cause instanceof Error ? cause.message : String(cause),
        url: path,
      }),
  });
}

function retryPolicy() {
  return Schedule.exponential('300 millis').pipe(
    Schedule.intersect(Schedule.recurs(3)),
    Schedule.whileInput((error: ApiError) => is502Error(error))
  );
}

function requestWithRetry<T>(url: string): Effect.Effect<T, ApiError, HttpClient> {
  return HttpClient.pipe(
    Effect.flatMap(http =>
      http.get<T>(url).pipe(
        Effect.retry(retryPolicy()),
        Effect.timeoutFail({
          duration: 10_000,
          onTimeout: () =>
            new ApiError({
              message: 'HTTP request timed out after 10000ms',
              url,
            }),
        }),
        Effect.flatMap(response =>
          response.status === 200
            ? Effect.succeed(response.data)
            : Effect.fail(
                new ApiError({
                  message: `Unexpected response status: ${response.status}`,
                  status: response.status,
                  url,
                })
              )
        )
      )
    )
  );
}

export function createDataApi<TParams = any, TResponse = any>({
  path,
  cacheExpired = 0,
  api = 'data-api',
}: DataApiProps) {
  return (
    params: TParams = {} as TParams
  ): Effect.Effect<TResponse, ApiError, Redis | HttpClient | Config> =>
    Effect.gen(function* () {
      const redis = yield* Redis;
      const config = yield* Config;

      const { finalPath, pathParams, query } = yield* resolvePathEffect(
        path,
        params as Record<string, any>
      );
      const search = objToSearchString(query);
      const key = buildHttpCacheKey(path, pathParams, search);

      if (cacheExpired > 0) {
        const cached = yield* redis.get<TResponse>(key).pipe(
          Effect.catchAll(() => Effect.succeed(null))
        );

        if (cached !== null) {
          return cached;
        }
      }

      const baseUrl = config.baseUrl(api);
      const url = search ? `${baseUrl}${finalPath}?${search}` : `${baseUrl}${finalPath}`;
      const data = yield* requestWithRetry<TResponse>(url);

      if (cacheExpired > 0) {
        yield* redis.set(key, data, cacheExpired).pipe(
          Effect.ignore
        );
      }

      return data;
    });
}

const RedisLive = Layer.effect(
  Redis,
  Effect.sync((): RedisServiceShape => {
    const redis = RedisService.getInstance();

    return {
      get: key => redis.get(key),
      set: (key, value, expireSeconds) => redis.set(key, value, expireSeconds),
    };
  })
);

const HttpClientLive = Layer.succeed(HttpClient, {
  get: <T>(url: string) =>
    Effect.tryPromise({
      try: () => axiosInstance.get<T>(url),
      catch: (cause: any) => {
        const responseMessage =
          typeof cause?.response?.data === 'string'
            ? cause.response.data
            : cause?.response?.data?.error || cause?.response?.data?.message;
        const message = responseMessage
          ? `${cause?.message || 'HTTP request failed'}: ${responseMessage}`
          : cause?.message || 'HTTP request failed';

        return new ApiError({
          message,
          status: cause?.response?.status,
          url,
        });
      },
    }),
});

const ConfigLive = Layer.succeed(Config, {
  baseUrl: (api: 'gamma-api' | 'data-api' | 'clob') => {
    if (api === 'gamma-api') return 'https://gamma-api.polymarket.com';
    if (api === 'data-api') return 'https://data-api.polymarket.com';
    return process.env.CLOB_HOST || 'https://clob.polymarket.com';
  },
});

export const DataApiLive = Layer.mergeAll(RedisLive, HttpClientLive, ConfigLive);

export const getMarketsEffect = createDataApi<MarketSearchProps, Market[]>({
  api: 'gamma-api',
  path: '/markets',
  cacheExpired: 60,
});

export const getMarketBySlugEffect = createDataApi<{ slug: string }, Market>({
  api: 'gamma-api',
  path: '/markets/slug/:slug',
  cacheExpired: 60,
});

export const getPositionsEffect = createDataApi<PositionSearchParams, Position[]>({
  api: 'data-api',
  path: '/positions',
});

export const getActivityEffect = createDataApi<ActivitySearchParams, Trade[]>({
  api: 'data-api',
  path: '/activity',
  cacheExpired: 3 * 24 * 60 * 60,
});

export const getLeaderboardEffect = createDataApi<
  LeaderboardSearchParams,
  TraderLeaderboardEntry[]
>({
  api: 'data-api',
  path: '/v1/leaderboard',
  cacheExpired: 60 * 60,
});

export const getMarketPriceEffect = createDataApi<MarketPriceSearchParams, MarketPrice>({
  api: 'clob',
  path: '/price',
});

export const getMarkets = (params: MarketSearchProps) =>
  getMarketsEffect(params).pipe(Effect.provide(DataApiLive));

export const getMarketBySlug = (slug: string) =>
  getMarketBySlugEffect({ slug }).pipe(Effect.provide(DataApiLive));

export const getPositions = (params: PositionSearchParams) =>
  getPositionsEffect(params).pipe(Effect.provide(DataApiLive));

export const getActivity = (params: ActivitySearchParams) =>
  getActivityEffect(params).pipe(Effect.provide(DataApiLive));

export const getLeaderboard = (params: LeaderboardSearchParams) =>
  getLeaderboardEffect(params).pipe(Effect.provide(DataApiLive));

export const getMarketPrice = (params: MarketPriceSearchParams) =>
  getMarketPriceEffect(params).pipe(Effect.provide(DataApiLive));
