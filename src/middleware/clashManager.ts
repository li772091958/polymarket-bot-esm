import axios, { type AxiosInstance } from 'axios';
import { Effect } from 'effect';
import logger from './logger.js';

type ClashGroupResponse = {
  all?: string[];
  now?: string;
};

type ClashDelayResponse = {
  delay?: number;
};

type ClashProvidersResponse = {
  providers?: Record<string, unknown>;
};

type ClashConfig = {
  apiUrl: string;
  secret: string;
  groupName: string;
  nodeKeyword: string;
  checkIntervalMs: number;
  healthyDelayMs: number;
  targetDelayMs: number;
  delayTestUrl: string;
  delayTimeoutMs: number;
};

const toError = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)));

const parsePositiveNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const resolveConfig = (): ClashConfig | null => {
  if (
    !['1', 'true', 'yes', 'on'].includes((process.env.ENABLE_CLASH_MANAGER || '').toLowerCase())
  ) {
    return null;
  }

  const apiUrl = process.env.CLASH_API_URL;
  if (!apiUrl) return null;

  return {
    apiUrl,
    secret: process.env.CLASH_SECRET || '',
    groupName: process.env.CLASH_GROUP || '🔰 手动选择',
    nodeKeyword: process.env.CLASH_NODE_KEYWORD || '香港',
    checkIntervalMs: parsePositiveNumber(process.env.CLASH_CHECK_INTERVAL_MS, 10 * 60 * 1000),
    healthyDelayMs: parsePositiveNumber(process.env.CLASH_HEALTHY_DELAY_MS, 1000),
    targetDelayMs: parsePositiveNumber(process.env.CLASH_TARGET_DELAY_MS, 200),
    delayTestUrl: process.env.CLASH_DELAY_TEST_URL || 'http://www.gstatic.com/generate_204',
    delayTimeoutMs: parsePositiveNumber(process.env.CLASH_DELAY_TIMEOUT_MS, 2000),
  };
};

export class ClashManager {
  private readonly client: AxiosInstance;

  constructor(private readonly config: ClashConfig) {
    this.client = axios.create({
      baseURL: config.apiUrl,
      headers: config.secret ? { Authorization: `Bearer ${config.secret}` } : undefined,
      proxy: false,
      timeout: config.delayTimeoutMs + 1000,
    });
  }

  private getProxies() {
    return Effect.tryPromise({
      try: async () => {
        const res = await this.client.get<ClashGroupResponse>(
          `/proxies/${encodeURIComponent(this.config.groupName)}`
        );

        return {
          all: res.data.all || [],
          now: res.data.now || '',
        };
      },
      catch: toError,
    });
  }

  private switchNode(nodeName: string) {
    return Effect.tryPromise({
      try: () =>
        this.client.put(`/proxies/${encodeURIComponent(this.config.groupName)}`, {
          name: nodeName,
        }),
      catch: toError,
    }).pipe(Effect.asVoid);
  }

  private checkLatency(nodeName: string) {
    return Effect.tryPromise({
      try: async () => {
        const res = await this.client.get<ClashDelayResponse>(
          `/proxies/${encodeURIComponent(nodeName)}/delay`,
          {
            params: {
              timeout: this.config.delayTimeoutMs,
              url: this.config.delayTestUrl,
            },
          }
        );

        return Number(res.data.delay ?? Infinity);
      },
      catch: () => new Error('Clash node latency check failed'),
    }).pipe(Effect.catchAll(() => Effect.succeed(Infinity)));
  }

  private findFastestNode(nodes: string[]) {
    return Effect.gen(this, function* () {
      let fastestNode = '';
      let minDelay = Infinity;

      for (const node of nodes.filter(item => item.includes(this.config.nodeKeyword))) {
        const delay = yield* this.checkLatency(node);
        if (delay < minDelay) {
          minDelay = delay;
          fastestNode = node;
        }

        if (delay < this.config.targetDelayMs) break;
      }

      return { fastestNode, minDelay };
    });
  }

  public update() {
    return Effect.tryPromise({
      try: () => this.client.put('/providers/proxies/default', {}),
      catch: toError,
    }).pipe(Effect.map(response => response.status));
  }

  public debugProviders() {
    return Effect.tryPromise({
      try: async () => {
        const res = await this.client.get<ClashProvidersResponse>('/providers/proxies');
        return res.data.providers || {};
      },
      catch: toError,
    });
  }

  public checkAndSwitchOnce() {
    return Effect.gen(this, function* () {
      const proxies = yield* this.getProxies();
      if (!proxies.now || proxies.all.length === 0) return;

      const currentDelay = yield* this.checkLatency(proxies.now);
      if (currentDelay < this.config.healthyDelayMs) return;

      const { fastestNode, minDelay } = yield* this.findFastestNode(proxies.all);
      if (!fastestNode || !Number.isFinite(minDelay)) return;

      yield* this.switchNode(fastestNode);
    }).pipe(
      Effect.catchAll(error =>
        logger
          .error('Clash 健康检查失败: ', {
            message: error.message,
            group: this.config.groupName,
          })
          .pipe(Effect.asVoid)
      )
    );
  }

  public runLoop() {
    return logger
      .info('开启 Clash 代理健康检查', {
        group: this.config.groupName,
        keyword: this.config.nodeKeyword,
        intervalMs: this.config.checkIntervalMs,
      })
      .pipe(
        Effect.zipRight(
          Effect.forever(
            this.checkAndSwitchOnce().pipe(
              Effect.zipRight(Effect.sleep(this.config.checkIntervalMs))
            )
          )
        )
      );
  }
}

export const autoCheckAndSwitchProxyNode = Effect.gen(function* () {
  const config = resolveConfig();
  if (!config) return;

  yield* new ClashManager(config).runLoop();
});
