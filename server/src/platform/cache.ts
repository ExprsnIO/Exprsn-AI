import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import client from 'prom-client';
import type { Registry } from 'prom-client';
import type { Logger } from 'pino';
import { TOPICS, type Bus } from './bus.js';

/*
 * The tenant-scoped read-through cache (B-2102), in place of exprsn-platform's prefetch service. A value is cached
 * under (tenant, namespace, key) for the TTL of its tier; a miss runs the loader once (concurrent misses on one
 * instance share it). Invalidation is by key or by namespace, and travels on the bus, so a change on one instance
 * clears the entry on every other:
 *
 * - memory store (one process each): every instance applies the bus event to its own map.
 * - Redis store (`REDIS_URL`, shared): the instance that invalidates deletes the key (or bumps the namespace's
 *   generation, which every key of the namespace includes) in Redis; the bus event is then only informational.
 *
 * A store error never fails a read: the loader answers instead and `exprsn_cache_errors_total` counts it. Values are
 * JSON. Cache metadata and ids, not tenant content: values sit in Redis unsealed (docs/security.md).
 */

export type CacheTier = 'short' | 'medium' | 'long';

export interface CacheInvalidation {
  tenantId: string;
  ns: string;
  /** One key; the whole namespace when absent. */
  key?: string;
}

export interface CacheStore {
  readonly kind: 'memory' | 'redis';
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  del(key: string): Promise<void>;
  /** The namespace generation (0 until first bumped). */
  generation(key: string): Promise<number>;
  bump(key: string): Promise<number>;
  close(): Promise<void>;
}

/** An LRU map with expiries; generations never expire (they are a few bytes per namespace in use). */
export class MemoryCacheStore implements CacheStore {
  readonly kind = 'memory' as const;
  private readonly map = new Map<string, { value: string; expires: number }>();
  private readonly gens = new Map<string, number>();

  constructor(private readonly maxEntries = 10_000) {}

  async get(key: string): Promise<string | null> {
    const e = this.map.get(key);
    if (!e) return null;
    if (e.expires <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    // Least recently used goes first: re-insert on a hit.
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  async del(key: string): Promise<void> {
    this.map.delete(key);
  }

  async generation(key: string): Promise<number> {
    return this.gens.get(key) ?? 0;
  }

  async bump(key: string): Promise<number> {
    const n = (this.gens.get(key) ?? 0) + 1;
    this.gens.set(key, n);
    return n;
  }

  get size(): number {
    return this.map.size;
  }

  async close(): Promise<void> {
    this.map.clear();
  }
}

export class RedisCacheStore implements CacheStore {
  readonly kind = 'redis' as const;
  private readonly redis: Redis;

  constructor(url: string, log?: Pick<Logger, 'warn'>) {
    // Fail fast: a cache read that waits on a dead Redis is slower than the loader it was meant to spare.
    this.redis = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 1, connectTimeout: 2000, commandTimeout: 1000 });
    this.redis.on('error', (err) => log?.warn({ err: err.message }, 'cache redis error'));
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.redis.set(key, value, 'PX', ttlMs);
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async generation(key: string): Promise<number> {
    return Number((await this.redis.get(key)) ?? 0);
  }

  async bump(key: string): Promise<number> {
    return this.redis.incr(key);
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}

export interface CacheOptions {
  ttlSeconds: Record<CacheTier, number>;
  /** Prefix of every key in a shared store. */
  prefix?: string;
}

const NS = /^[a-z][a-z0-9.-]{0,63}$/;

export class TenantCache {
  readonly requests: client.Counter<'ns' | 'result'>;
  readonly invalidations: client.Counter<'ns' | 'source'>;
  readonly errors: client.Counter<'op'>;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly offs: (() => void)[] = [];
  private readonly prefix: string;
  /** This cache, so it skips its own invalidations when the bus hands them back. */
  private readonly origin = randomBytes(8).toString('hex');

  constructor(
    readonly store: CacheStore,
    private readonly bus: Bus,
    registry: Registry,
    private readonly o: CacheOptions,
    private readonly log?: Pick<Logger, 'warn'>
  ) {
    this.prefix = o.prefix ?? 'exprsn:cache';
    const counter = <L extends string>(name: string, help: string, labelNames: L[]) => (registry.getSingleMetric(name) as client.Counter<L> | undefined) ?? new client.Counter({ name, help, labelNames, registers: [registry] });
    this.requests = counter('exprsn_cache_requests_total', 'Cache reads by namespace and result (hit or miss)', ['ns', 'result']);
    this.invalidations = counter('exprsn_cache_invalidations_total', 'Cache invalidations by namespace and source (local or bus)', ['ns', 'source']);
    this.errors = counter('exprsn_cache_errors_total', 'Cache store errors (the loader answered instead)', ['op']);
    // Other instances' invalidations: a memory store applies them; a shared store already has.
    this.offs.push(
      bus.on<CacheInvalidation & { from?: string }>(TOPICS.cacheInvalidate, (e) => {
        if (!e || typeof e.tenantId !== 'string' || typeof e.ns !== 'string' || e.from === this.origin) return;
        if (this.store.kind === 'memory') return this.apply(e, 'bus');
      })
    );
  }

  ttlMs(tier: CacheTier): number {
    return this.o.ttlSeconds[tier] * 1000;
  }

  private genKey(tenantId: string, ns: string): string {
    return `${this.prefix}:gen:${tenantId}:${ns}`;
  }

  private async fullKey(tenantId: string, ns: string, key: string): Promise<string> {
    const gen = await this.store.generation(this.genKey(tenantId, ns));
    return `${this.prefix}:${tenantId}:${ns}:${gen}:${key}`;
  }

  /** The cached value, or the loader's (stored for the tier's TTL). `undefined` from the loader is not cached. */
  async get<T>(tenantId: string, ns: string, key: string, tier: CacheTier, load: () => Promise<T>): Promise<T> {
    if (!NS.test(ns)) throw new Error(`Bad cache namespace ${ns}`);
    let full: string;
    try {
      full = await this.fullKey(tenantId, ns, key);
      const hit = await this.store.get(full);
      if (hit != null) {
        this.requests.inc({ ns, result: 'hit' });
        return JSON.parse(hit) as T;
      }
    } catch (err) {
      this.errors.inc({ op: 'get' });
      this.log?.warn({ err: (err as Error).message, ns }, 'cache read failed; loading');
      this.requests.inc({ ns, result: 'miss' });
      return load();
    }
    this.requests.inc({ ns, result: 'miss' });
    const running = this.inflight.get(full);
    if (running) return running as Promise<T>;
    const p = (async () => {
      const value = await load();
      if (value !== undefined) {
        try {
          await this.store.set(full, JSON.stringify(value), this.ttlMs(tier));
        } catch (err) {
          this.errors.inc({ op: 'set' });
          this.log?.warn({ err: (err as Error).message, ns }, 'cache write failed');
        }
      }
      return value;
    })();
    this.inflight.set(full, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(full);
    }
  }

  /** Clears a key (or the namespace) here and, through the bus, on every other instance. */
  async invalidate(e: CacheInvalidation): Promise<void> {
    await this.apply(e, 'local');
    this.bus.publish(TOPICS.cacheInvalidate, { tenantId: e.tenantId, ns: e.ns, ...(e.key != null ? { key: e.key } : {}), from: this.origin });
  }

  /**
   * Invalidates on a bus topic: `map` turns each payload into the entries to clear. Topics published to every
   * instance clear each instance's own store; set `broadcast` for local-only topics (`emitLocal`), which then
   * publish the invalidation themselves.
   */
  invalidateOn<T>(topic: string, map: (payload: T) => CacheInvalidation[] | null, opts: { broadcast?: boolean } = {}): () => void {
    const off = this.bus.on<T>(topic, async (payload) => {
      for (const e of map(payload) ?? []) await (opts.broadcast ? this.invalidate(e) : this.apply(e, 'bus'));
    });
    this.offs.push(off);
    return off;
  }

  private async apply(e: CacheInvalidation, source: 'local' | 'bus'): Promise<void> {
    this.invalidations.inc({ ns: e.ns, source });
    try {
      if (e.key != null) await this.store.del(await this.fullKey(e.tenantId, e.ns, e.key));
      else await this.store.bump(this.genKey(e.tenantId, e.ns));
    } catch (err) {
      this.errors.inc({ op: 'invalidate' });
      this.log?.warn({ err: (err as Error).message, ns: e.ns }, 'cache invalidation failed');
    }
  }

  async close(): Promise<void> {
    for (const off of this.offs.splice(0)) off();
    await this.store.close();
  }
}

export function createCacheStore(kind: 'auto' | 'memory' | 'redis', redisUrl: string | undefined, maxEntries: number, log?: Pick<Logger, 'warn'>): CacheStore {
  if (kind === 'redis' || (kind === 'auto' && redisUrl)) {
    if (!redisUrl) throw new Error('CACHE_STORE=redis needs REDIS_URL');
    return new RedisCacheStore(redisUrl, log);
  }
  return new MemoryCacheStore(maxEntries);
}
