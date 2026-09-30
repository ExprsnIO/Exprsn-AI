import { Redis } from 'ioredis';
import type { Logger } from 'pino';

/** The state of one fixed-window counter after a hit. */
export interface CounterState {
  /** Hits in the current window, this one included. */
  count: number;
  /** Milliseconds until the window ends and the counter starts again. */
  resetMs: number;
}

/**
 * Fixed-window counters shared by the rate limits, the failed-credential throttle and the authorisation denial cap.
 * `hit` adds `cost` (0 reads the counter without changing it) and returns the window's total.
 */
export interface CounterStore {
  readonly kind: 'memory' | 'redis';
  hit(key: string, windowMs: number, cost?: number): Promise<CounterState>;
  close(): Promise<void>;
}

/** Counters in this process: exact for one instance, per instance when there are several. */
export class MemoryCounterStore implements CounterStore {
  readonly kind = 'memory' as const;
  private readonly windows = new Map<string, { count: number; ends: number }>();
  private sweeps = 0;

  async hit(key: string, windowMs: number, cost = 1): Promise<CounterState> {
    return this.hitSync(key, windowMs, cost);
  }

  hitSync(key: string, windowMs: number, cost = 1): CounterState {
    const now = Date.now();
    // Expired windows are dropped now and then, so a scan of many keys cannot grow the map without bound.
    if (++this.sweeps % 1000 === 0) for (const [k, w] of this.windows) if (w.ends <= now) this.windows.delete(k);
    let w = this.windows.get(key);
    if (!w || w.ends <= now) {
      w = { count: 0, ends: now + windowMs };
      this.windows.set(key, w);
    }
    w.count += cost;
    return { count: w.count, resetMs: w.ends - now };
  }

  async close(): Promise<void> {
    this.windows.clear();
  }
}

/**
 * One atomic script per hit: increment, start the window's expiry on the first hit (or when a key somehow has none),
 * and return the count with the time left. INCRBY and PEXPIRE run together, so two instances can never both see a
 * fresh window or leave a counter without an expiry.
 */
export const HIT_SCRIPT = `
local c = redis.call('INCRBY', KEYS[1], ARGV[2])
local t = redis.call('PTTL', KEYS[1])
if t < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  t = tonumber(ARGV[1])
end
return {c, t}
`;

interface ScriptRedis {
  hitCounter(key: string, windowMs: number, cost: number): Promise<[number, number]>;
}

/**
 * Counters in Redis, shared by every instance. When Redis fails, the hit is counted in memory instead: the limit
 * still applies (per instance) rather than letting the request through uncounted.
 */
export class RedisCounterStore implements CounterStore {
  readonly kind = 'redis' as const;
  private readonly redis: Redis;
  private readonly fallback = new MemoryCounterStore();
  private warned = 0;

  constructor(
    redis: Redis | string,
    private readonly log?: Pick<Logger, 'warn'>,
    private readonly prefix = 'exprsn:rl:'
  ) {
    this.redis = typeof redis === 'string' ? new Redis(redis, { lazyConnect: false, maxRetriesPerRequest: 1, enableOfflineQueue: false }) : redis;
    this.redis.on('error', () => undefined);
    this.redis.defineCommand('hitCounter', { numberOfKeys: 1, lua: HIT_SCRIPT });
  }

  async hit(key: string, windowMs: number, cost = 1): Promise<CounterState> {
    try {
      const [count, ttl] = await (this.redis as unknown as ScriptRedis).hitCounter(this.prefix + key, Math.max(1, Math.round(windowMs)), cost);
      return { count: Number(count), resetMs: Number(ttl) };
    } catch (err) {
      // At most one warning a minute, so an outage does not flood the log.
      if (Date.now() - this.warned > 60_000) {
        this.warned = Date.now();
        this.log?.warn({ err: (err as Error).message }, 'rate-limit counters: Redis unavailable, counting in memory');
      }
      return this.fallback.hitSync(key, windowMs, cost);
    }
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}

export function createCounterStore(redisUrl: string | undefined, log?: Pick<Logger, 'warn'>): CounterStore {
  return redisUrl ? new RedisCounterStore(redisUrl, log) : new MemoryCounterStore();
}

/** A limit of `points` hits per `windowMs` on top of a counter store. */
export class Limiter {
  constructor(
    private readonly store: CounterStore,
    readonly name: string,
    readonly points: number,
    readonly windowMs: number
  ) {}

  /** Counts a hit; `allowed` is false once the window holds more than `points`. */
  async consume(key: string, cost = 1): Promise<CounterState & { allowed: boolean }> {
    const r = await this.store.hit(`${this.name}:${key}`, this.windowMs, cost);
    return { ...r, allowed: r.count <= this.points };
  }

  /** Whether the key is already over its limit, without counting a hit. */
  async blocked(key: string): Promise<CounterState & { blocked: boolean }> {
    const r = await this.store.hit(`${this.name}:${key}`, this.windowMs, 0);
    return { ...r, blocked: r.count >= this.points };
  }
}
