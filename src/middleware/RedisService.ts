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
    return this.connectPromise;
  }

  // ================= String =================

  public async set(key: string, value: unknown, ttlSeconds?: number) {
    const client = await this.ensureConnected();
    const strValue = typeof value === 'string' ? value : JSON.stringify(value);

    if (ttlSeconds) {
      await client.set(key, strValue, {
        EX: ttlSeconds,
      });
      return;
    }

    await client.set(key, strValue);
  }

  public async get<T>(key: string) {
    const client = await this.ensureConnected();
    const data = await client.get(key);
    if (!data) return null;

    try {
      return JSON.parse(data) as T;
    } catch {
      return data as unknown as T;
    }
  }

  public async setIfNotExists(key: string, value: string, ttlSeconds: number) {
    const client = await this.ensureConnected();
    const result = await client.set(key, value, {
      EX: ttlSeconds,
      NX: true,
    });

    return result === 'OK';
  }

  public async del(key: string) {
    const client = await this.ensureConnected();
    await client.del(key);
  }

  // ================= Set =================

  public async sadd(key: string, members: string | string[]) {
    const client = await this.ensureConnected();
    const args = Array.isArray(members) ? members : [members];
    if (args.length === 0) return 0;
    return await client.sAdd(key, args);
  }

  public async smembers(key: string) {
    const client = await this.ensureConnected();
    return client.sMembers(key);
  }

  public async sismember(key: string, member: string) {
    const client = await this.ensureConnected();
    return Boolean(await client.sIsMember(key, member));
  }

  public async srem(key: string, member: string) {
    const client = await this.ensureConnected();
    return client.sRem(key, member);
  }

  public async scard(key: string) {
    const client = await this.ensureConnected();
    return client.sCard(key);
  }

  public async expire(key: string, ttlSeconds: number) {
    const client = await this.ensureConnected();
    return Boolean(await client.expire(key, ttlSeconds));
  }
}
