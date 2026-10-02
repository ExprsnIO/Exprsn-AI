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
  /**
   * B-1407: whether shared counting is degraded (Redis configured but not answering, so each instance counts on its
   * own), since when, and why. Stores without a shared backend are never degraded.
   */
  health?(): CounterHealth;
}

export interface CounterHealth {
  degraded: boolean;
  since: number | null;
  detail: string | null;
  /** Hits counted in memory because Redis failed, since start. */
  fallbacks: number;
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
  private degradedSince: number | null = null;
  private lastError: string | null = null;
  private fallbacks = 0;
  private probeTimer: NodeJS.Timeout | null = null;

  constructor(
    redis: Redis | string,
    private readonly log?: Pick<Logger, 'warn'>,
    private readonly prefix = 'exprsn:rl:'
  ) {
    this.redis = typeof redis === 'string' ? new Redis(redis, { lazyConnect: false, maxRetriesPerRequest: 1, enableOfflineQueue: false }) : redis;
    this.redis.on('error', () => undefined);
    this.redis.on('ready', () => void (this.everReady = true));
    if (this.redis.status === 'ready') this.everReady = true;
    this.redis.defineCommand('hitCounter', { numberOfKeys: 1, lua: HIT_SCRIPT });
  }

  /** Whether Redis has answered once. Until then a hit waits briefly for the first connection (see firstConnect). */
  private everReady = false;
  /** Hits wait for the first connection only this soon after start, so a Redis that is down from the start costs nothing later. */
  private readonly waitUntil = Date.now() + 5_000;

  /**
   * The offline queue is off so that an outage falls back to memory at once instead of queueing hits. That also
   * refused every hit sent before the first connection was ready, so each instance counted its first requests (and
   * a new store all of them) in memory. In the first seconds after start, before Redis has answered once, a hit
   * waits up to `ms` for it; after that, or once Redis has answered, hits never wait.
   */
  private firstConnect(ms = 250): Promise<void> {
    if (this.everReady || Date.now() > this.waitUntil || this.redis.status === 'ready' || this.redis.status === 'end') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.redis.off('ready', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.redis.once('ready', done);
    });
  }

  async hit(key: string, windowMs: number, cost = 1): Promise<CounterState> {
    await this.firstConnect();
    try {
      const [count, ttl] = await (this.redis as unknown as ScriptRedis).hitCounter(this.prefix + key, Math.max(1, Math.round(windowMs)), cost);
      this.recovered();
      return { count: Number(count), resetMs: Number(ttl) };
    } catch (err) {
      this.fallbacks++;
      this.degrade(err as Error, false); // the warning below covers hits
      // At most one warning a minute, so an outage does not flood the log.
      if (Date.now() - this.warned > 60_000) {
        this.warned = Date.now();
        this.log?.warn({ err: (err as Error).message }, 'rate-limit counters: Redis unavailable, counting in memory');
      }
      return this.fallback.hitSync(key, windowMs, cost);
    }
  }

  health(): CounterHealth {
    return { degraded: this.degradedSince !== null, since: this.degradedSince, detail: this.degradedSince !== null ? this.lastError : null, fallbacks: this.fallbacks };
  }

  private degrade(err: Error, log: boolean): void {
    this.lastError = (err.message || 'Redis did not answer').slice(0, 200);
    if (this.degradedSince === null) {
      this.degradedSince = Date.now();
      if (log) this.log?.warn({ err: this.lastError }, 'rate-limit counters: Redis unavailable, limits now count per instance');
    }
  }

  private recovered(): void {
    if (this.degradedSince === null) return;
    this.log?.warn({ since: this.degradedSince }, 'rate-limit counters: Redis answers again, limits are shared');
    this.degradedSince = null;
    this.lastError = null;
  }

  /** One PING: notices an outage (or its end) without waiting for traffic. */
  async probe(): Promise<boolean> {
    try {
      await this.redis.ping();
      this.recovered();
      return true;
    } catch (err) {
      this.degrade(err as Error, true);
      return false;
    }
  }

  /** B-1407: probes every `everyMs`, so the Platform warning appears within a minute of Redis stopping. */
  startProbe(everyMs: number): void {
    if (this.probeTimer) return;
    this.probeTimer = setInterval(() => void this.probe(), everyMs);
    this.probeTimer.unref();
  }

  async close(): Promise<void> {
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
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
