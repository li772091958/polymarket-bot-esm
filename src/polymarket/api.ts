import { ClobClient } from '@polymarket/clob-client-v2';
import 'dotenv/config';
import { Wallet } from '@ethersproject/wallet';
import RedisService from '../middleware/RedisService.js';
import logger from '../middleware/logger.js';
import axiosInstance from '../middleware/axios.js';
import {
  Market,
  MarketPrice,
  MarketPriceSearchParams,
  MarketSearchProps,
  Position,
  PositionSearchParams,
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

export class ApiError extends Error {
  readonly status?: number;
  readonly url?: string;
  readonly attempt?: number;

  constructor({
    message,
    status,
    url,
    attempt,
  }: {
    message: string;
    status?: number;
    url?: string;
    attempt?: number;
  }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.url = url;
    this.attempt = attempt;
  }
}

export interface DataApiProps {
  path: string;
  cacheExpired?: number;
  api: 'gamma-api' | 'data-api' | 'clob';
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

function getBaseUrl(api: 'gamma-api' | 'data-api' | 'clob') {
  if (api === 'gamma-api') return 'https://gamma-api.polymarket.com';
  if (api === 'data-api') return 'https://data-api.polymarket.com';
  return process.env.CLOB_HOST || 'https://clob.polymarket.com';
}

async function withTimeout<T>(promise: Promise<T>, ms: number, url: string) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ApiError({
            message: `HTTP request timed out after ${ms}ms`,
            url,
          })
        ),
      ms
    );
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function requestOnce<T>(url: string) {
  try {
    const response = await withTimeout(axiosInstance.get<T>(url), 10_000, url);

    if (response.status !== 200) {
      throw new ApiError({
        message: `Unexpected response status: ${response.status}`,
        status: response.status,
        url,
      });
    }

    return response.data;
  } catch (cause: any) {
    if (cause instanceof ApiError) throw cause;

    throw new ApiError({
      message: cause?.message || 'HTTP request failed',
      status: cause?.response?.status,
      url,
    });
  }
}

async function requestWithRetry<T>(url: string) {
  const maxRetries = 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await requestOnce<T>(url);
    } catch (error) {
      if (
        error instanceof ApiError &&
        is502Error(error) &&
        attempt < maxRetries
      ) {
        await sleep(300 * 2 ** attempt);
        continue;
      }

      throw error;
    }
  }

  throw new ApiError({
    message: 'HTTP request failed after retries',
    url,
  });
}

export function createDataApi<TParams = any, TResponse = any>({
  path,
  cacheExpired = 0,
  api = 'data-api',
}: DataApiProps) {
  return async (params: TParams = {} as TParams) => {
    let resolvedPath: ReturnType<typeof resolvePath>;
    try {
      resolvedPath = resolvePath(path, params as Record<string, any>);
    } catch (cause) {
      throw new ApiError({
        message: cause instanceof Error ? cause.message : String(cause),
        url: path,
      });
    }

    const { finalPath, pathParams, query } = resolvedPath;
    const search = objToSearchString(query);
    const key = buildHttpCacheKey(path, pathParams, search);
    const redis = RedisService.getInstance();

    if (cacheExpired > 0) {
      try {
        const cached = await redis.get<TResponse>(key);
        if (cached !== null) {
          logger.info('Cache hit', { key });
          return cached;
        }
      } catch (error) {
        logger.error('Failed to read cache', {
          key,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const baseUrl = getBaseUrl(api);
    const url = search ? `${baseUrl}${finalPath}?${search}` : `${baseUrl}${finalPath}`;
    const data = await requestWithRetry<TResponse>(url);

    if (cacheExpired > 0) {
      try {
        await redis.set(key, data, cacheExpired);
      } catch (error) {
        logger.error('Failed to write cache', {
          key,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return data;
  };
}

export const getMarkets = createDataApi<MarketSearchProps, Market[]>({
  api: 'gamma-api',
  path: '/markets',
  cacheExpired: 60,
});

export const getPositions = createDataApi<PositionSearchParams, Position[]>({
  api: 'data-api',
  path: '/positions',
});

export const getMarketPrice = createDataApi<MarketPriceSearchParams, MarketPrice>({
  api: 'clob',
  path: '/price',
});
