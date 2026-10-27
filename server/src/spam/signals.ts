import { isIP } from 'node:net';
import type { CounterStore } from '../platform/ratelimit.js';

/*
 * 1.9.0, Sprint 50 (B-159): rate signals. Sliding windows per account, per IP range (/24 for IPv4, /56 for IPv6) and
 * per tenant, over the surfaces where people write, kept as counters in the rate limiter's store (`s.counters`: Redis
 * when REDIS_URL is set, so every instance counts together, memory otherwise).
 *
 * A window is the sliding-window counter of two fixed buckets: the count in the current bucket plus the previous
 * bucket's count weighted by how much of it still lies inside the window. Each bucket is one counter key named by its
 * index, so a hit is one INCRBY and a read is two (cost 0) on the store's own atomic script; a bucket expires two
 * windows after it starts.
 */

export const SURFACES = ['post', 'comment', 'message', 'follow', 'invite', 'report', 'signup', 'signin_failed', 'firehose'] as const;
export type Surface = (typeof SURFACES)[number];
export const SCOPES = ['account', 'ip', 'tenant'] as const;
export type Scope = (typeof SCOPES)[number];

/** Surfaces where a person writes content (the ones a response can slow, hold or limit). */
export const CONTENT_SURFACES: readonly Surface[] = ['post', 'comment', 'message'];
/** Surfaces a response may slow or limit (content, and the ways of reaching people). */
export const GATED_SURFACES: readonly Surface[] = ['post', 'comment', 'message', 'follow', 'invite'];

/**
 * The range an address counts in: `a.b.c.0/24` for IPv4 (and IPv4-mapped IPv6), the first 56 bits for IPv6
 * (`2001:db8:12:3400::/56`). Null for anything that is not an address.
 */
export function ipRange(ip: string | null | undefined): string | null {
  if (!ip) return null;
  let a = ip.trim();
  if (a.startsWith('[') && a.includes(']')) a = a.slice(1, a.indexOf(']'));
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(a);
  if (mapped) a = mapped[1]!;
  const kind = isIP(a);
  if (kind === 4) {
    const p = a.split('.');
    return `${p[0]}.${p[1]}.${p[2]}.0/24`;
  }
  if (kind !== 6) return null;
  const groups = expand6(a);
  if (!groups) return null;
  // 56 bits: three groups and the high byte of the fourth.
  const fourth = (groups[3]! & 0xff00).toString(16);
  return `${groups.slice(0, 3).map((g) => g.toString(16)).join(':')}:${fourth}::/56`;
}

function expand6(a: string): number[] | null {
  let s = a.toLowerCase();
  // An embedded IPv4 tail (::1.2.3.4) becomes two groups.
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const n = v4.slice(1).map(Number);
    s = s.slice(0, v4.index) + (((n[0]! << 8) | n[1]!).toString(16) + ':' + ((n[2]! << 8) | n[3]!).toString(16));
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : null;
  const fill = t ? 8 - h.length - t.length : 0;
  if (fill < 0 || (!t && h.length !== 8)) return null;
  const all = [...h, ...Array<string>(fill).fill('0'), ...(t ?? [])];
  const out = all.map((g) => parseInt(g || '0', 16));
  return out.length === 8 && out.every((g) => Number.isFinite(g) && g >= 0 && g <= 0xffff) ? out : null;
}

/** Resolves with `fallback` when `p` takes longer than `ms` (the work itself carries on, unobserved). */
export function timeBox<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(fallback);
      }
    );
  });
}

export class SlidingWindows {
  constructor(
    private readonly store: CounterStore,
    private readonly now: () => number = Date.now,
    private readonly prefix = 'spam:'
  ) {}

  private keys(key: string, windowMs: number): { cur: string; prev: string; frac: number } {
    const t = this.now();
    const idx = Math.floor(t / windowMs);
    return { cur: `${this.prefix}${key}:${windowMs}:${idx}`, prev: `${this.prefix}${key}:${windowMs}:${idx - 1}`, frac: (t - idx * windowMs) / windowMs };
  }

  /** Adds `cost` hits and returns the sliding count over the last `windowMs`, these included. */
  async add(key: string, windowMs: number, cost = 1): Promise<number> {
    const k = this.keys(key, windowMs);
    const [cur, prev] = await Promise.all([this.store.hit(k.cur, windowMs * 2, cost), this.store.hit(k.prev, windowMs * 2, 0)]);
    return estimate(cur.count, prev.count, k.frac);
  }

  /** The sliding count over the last `windowMs`, without counting anything. */
  async read(key: string, windowMs: number): Promise<number> {
    const k = this.keys(key, windowMs);
    const [cur, prev] = await Promise.all([this.store.hit(k.cur, windowMs * 2, 0), this.store.hit(k.prev, windowMs * 2, 0)]);
    return estimate(cur.count, prev.count, k.frac);
  }
}

const estimate = (cur: number, prev: number, frac: number): number => Math.round((cur + prev * (1 - frac)) * 100) / 100;

/** The counter key of a surface's window for one scope. */
export function windowKey(tenantId: string, surface: Surface, scope: Scope, subject: string): string {
  return `${tenantId}:${surface}:${scope}:${subject}`;
}
