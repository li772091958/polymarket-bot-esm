import { Effect } from 'effect';
import { createClient, RedisClientType } from 'redis';

export default class RedisService {
  private static instance: RedisService;
  private client: RedisClientType;
  private connectPromise: Promise<RedisClientType>;

  private constructor() {
    this.client = createClient({
      socket: {
        host: '127.0.0.1',
        port: 6379,
        reconnectStrategy: (retries: number) => {
          if (retries > 20) return new Error('❌ Redis reconnect failed');
          return Math.min(retries * 50, 2000);
        },
      },
    });

    this.client.on('connect', () => {
      // logger.info('✅ Redis Connected');
    });

    this.client.on('error', (err: any) => {
      console.error('❌ Redis Error:', err);
    });

    this.connectPromise = this.client.connect().then(() => this.client);
  }

  public static getInstance(): RedisService {
    if (!RedisService.instance) {
      RedisService.instance = new RedisService();
    }
    return RedisService.instance;
  }

  private ensureConnected() {
    return Effect.tryPromise({
      try: () => this.connectPromise,
      catch: cause => (cause instanceof Error ? cause : new Error(String(cause))),
    });
  }

  // ================= String =================

  public set(key: string, value: unknown, ttlSeconds?: number) {
    return this.ensureConnected().pipe(
      Effect.flatMap(client =>
        Effect.tryPromise({
          try: async () => {
            const strValue = typeof value === 'string' ? value : JSON.stringify(value);

            if (ttlSeconds) {
              await client.set(key, strValue, {
                EX: ttlSeconds,
              });
              return;
            }

            await client.set(key, strValue);
          },
          catch: cause => (cause instanceof Error ? cause : new Error(String(cause))),
        })
      )
    );
  }

  public get<T>(key: string) {
    return this.ensureConnected().pipe(
      Effect.flatMap(client =>
        Effect.tryPromise({
          try: async () => {
            const data = await client.get(key);
            if (!data) return null;

            try {
              return JSON.parse(data) as T;
            } catch {
              return data as unknown as T;
            }
          },
          catch: cause => (cause instanceof Error ? cause : new Error(String(cause))),
        })
      )
    );
  }

  public setIfNotExists(key: string, value: string, ttlSeconds: number) {
    return this.ensureConnected().pipe(
      Effect.flatMap(client =>
        Effect.tryPromise({
          try: async () => {
            const result = await client.set(key, value, {
              EX: ttlSeconds,
              NX: true,
            });

            return result === 'OK';
          },
          catch: cause => (cause instanceof Error ? cause : new Error(String(cause))),
        })
      )
    );
  }

  public del(key: string) {
    return this.ensureConnected().pipe(
      Effect.flatMap(client =>
        Effect.tryPromise({
          try: async () => {
            await client.del(key);
          },
          catch: cause => (cause instanceof Error ? cause : new Error(String(cause))),
        })
      )
    );
  }

  // ================= Set =================

  public sadd(key: string, members: string | string[]) {
    return this.ensureConnected().pipe(
      Effect.flatMap(client =>
        Effect.tryPromise({
          try: async () => {
            const args = Array.isArray(members) ? members : [members];
            if (args.length === 0) return 0;
            return await client.sAdd(key, args);
          },
          catch: cause => (cause instanceof Error ? cause : new Error(String(cause))),
        })
      )
    );
  }

  public smembers(key: string) {
    return this.ensureConnected().pipe(
      Effect.flatMap(client =>
        Effect.tryPromise({
          try: () => client.sMembers(key),
          catch: cause => (cause instanceof Error ? cause : new Error(String(cause))),
        })
      )
    );
  }

  public sismember(key: string, member: string) {
    return this.ensureConnected().pipe(
      Effect.flatMap(client =>
        Effect.tryPromise({
          try: async () => Boolean(await client.sIsMember(key, member)),
          catch: cause => (cause instanceof Error ? cause : new Error(String(cause))),
        })
      )
    );
  }

  public srem(key: string, member: string) {
    return this.ensureConnected().pipe(
      Effect.flatMap(client =>
        Effect.tryPromise({
          try: () => client.sRem(key, member),
          catch: cause => (cause instanceof Error ? cause : new Error(String(cause))),
        })
      )
    );
  }

  public scard(key: string) {
    return this.ensureConnected().pipe(
      Effect.flatMap(client =>
        Effect.tryPromise({
          try: () => client.sCard(key),
          catch: cause => (cause instanceof Error ? cause : new Error(String(cause))),
        })
      )
    );
  }

  public expire(key: string, ttlSeconds: number) {
    return this.ensureConnected().pipe(
      Effect.flatMap(client =>
        Effect.tryPromise({
          try: async () => Boolean(await client.expire(key, ttlSeconds)),
          catch: cause => (cause instanceof Error ? cause : new Error(String(cause))),
        })
      )
    );
  }
}
