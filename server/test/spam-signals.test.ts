/*
 * 1.9.0, Sprint 50 (B-159): rate signals. Sliding windows over the rate limiter's counter store, per account, per IP
 * range (/24, /56) and per tenant; one store shared by several service instances counts together; a slow store
 * never holds up a request (recording returns at once, the gate gives up after its time box).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryCounterStore, type CounterState, type CounterStore } from '../src/platform/ratelimit.js';
import { SpamService } from '../src/spam/service.js';
import { ipRange, SlidingWindows, timeBox, windowKey } from '../src/spam/signals.js';
import type { Harness } from './helpers.js';
import { clock, person, spamHarness } from './spam-helpers.js';

describe('sliding windows (fixed clock)', () => {
  it('counts the current bucket and the weighted part of the previous one', async () => {
    const c = clock(Date.UTC(2026, 9, 18, 12, 0, 0));
    const w = new SlidingWindows(new MemoryCounterStore(), c.now);
    const W = 60_000;
    // The clock starts on a bucket boundary: five hits in the first bucket.
    for (let i = 0; i < 5; i++) await w.add('k', W);
    expect(await w.read('k', W)).toBe(5);
    // Half way into the next bucket: the previous bucket counts half (5 × 0.5), plus two new hits.
    c.add(W + W / 2);
    await w.add('k', W);
    expect(await w.add('k', W)).toBe(4.5);
    // A quarter into the bucket after: the previous (2 hits) counts three quarters, the first is gone.
    c.add(W - W / 2 + W / 4);
    expect(await w.read('k', W)).toBe(1.5);
    // Two whole windows later nothing is left.
    c.add(2 * W);
    expect(await w.read('k', W)).toBe(0);
  });

  it('keeps windows of different lengths and keys apart, and reads without counting', async () => {
    const c = clock();
    const w = new SlidingWindows(new MemoryCounterStore(), c.now);
    await w.add('a', 60_000, 3);
    await w.add('a', 600_000);
    await w.add('b', 60_000);
    expect(await w.read('a', 60_000)).toBe(3);
    expect(await w.read('a', 600_000)).toBe(1);
    expect(await w.read('b', 60_000)).toBe(1);
    expect(await w.read('a', 60_000)).toBe(3);
  });
});

describe('IP ranges', () => {
  it('groups IPv4 by /24 and IPv6 by /56', () => {
    expect(ipRange('203.0.113.7')).toBe('203.0.113.0/24');
    expect(ipRange('203.0.113.250')).toBe('203.0.113.0/24');
    expect(ipRange('203.0.114.1')).toBe('203.0.114.0/24');
    expect(ipRange('::ffff:198.51.100.9')).toBe('198.51.100.0/24');
    expect(ipRange('2001:db8:abcd:1234::1')).toBe('2001:db8:abcd:1200::/56');
    expect(ipRange('2001:db8:abcd:12ff:ffff::9')).toBe('2001:db8:abcd:1200::/56');
    expect(ipRange('2001:db8:abcd:1300::1')).toBe('2001:db8:abcd:1300::/56');
    expect(ipRange('[2001:db8::1]')).toBe('2001:db8:0:0::/56');
    expect(ipRange('fe80::1%en0')).toBe('fe80:0:0:0::/56');
    expect(ipRange('::1')).toBe('0:0:0:0::/56');
    expect(ipRange('not an address')).toBeNull();
    expect(ipRange(null)).toBeNull();
  });
});

describe('time box', () => {
  it('answers the fallback when the work is slow or fails', async () => {
    expect(await timeBox(new Promise<number>(() => undefined), 20, -1)).toBe(-1);
    expect(await timeBox(Promise.reject(new Error('no')), 20, -1)).toBe(-1);
    expect(await timeBox(Promise.resolve(7), 20, -1)).toBe(7);
  });
});

describe('rate signals in the service', () => {
  let h: Harness;
  let admin: Awaited<ReturnType<typeof person>>;
  let alice: Awaited<ReturnType<typeof person>>;

  beforeAll(async () => {
    h = await spamHarness();
    admin = await person(h, 'sig-admin', ['tenant-admin']);
    alice = await person(h, 'sig-alice');
  });
  afterAll(async () => h.close());

  it('does nothing until a tenant saves a policy', async () => {
    const c = clock();
    const store = new MemoryCounterStore();
    const svc = new SpamService(() => h.s, { now: c.now, store });
    expect(await svc.observe({ tenantId: h.tenantId, surface: 'post', userId: alice.id, ip: '203.0.113.5', text: 'hello there' })).toBeNull();
    expect(await svc.windows.read(windowKey(h.tenantId, 'post', 'tenant', '*'), 600_000)).toBe(0);
  });

  it('counts per account, per IP range and per tenant, against the surface thresholds', async () => {
    const c = clock();
    const store = new MemoryCounterStore();
    const svc = new SpamService(() => h.s, { now: c.now, store });
    await svc.savePolicy(admin.p, { enabled: true, surfaces: { follow: { account: 3, ip: 4, tenant: 100, windowSeconds: 600 } } });
    let last = null;
    for (let i = 0; i < 5; i++) last = await svc.observe({ tenantId: h.tenantId, surface: 'follow', userId: alice.id, ip: `198.51.100.${10 + i}`, recipient: `target-${i}` });
    expect(await svc.windows.read(windowKey(h.tenantId, 'follow', 'account', alice.id), 600_000)).toBe(5);
    expect(await svc.windows.read(windowKey(h.tenantId, 'follow', 'ip', '198.51.100.0/24'), 600_000)).toBe(5);
    expect(await svc.windows.read(windowKey(h.tenantId, 'follow', 'tenant', '*'), 600_000)).toBe(5);
    const signals = last!.reasons.map((r) => r.signal).sort();
    expect(signals).toEqual(['rate.follow.account', 'rate.follow.ip']);
    expect(last!.reasons.find((r) => r.signal === 'rate.follow.account')).toMatchObject({ value: 5, threshold: 3 });
    expect(last!.mode).toBe('shadow');
    expect(last!.applied).toBeNull();
    // A failed sign-in has no account: its IP range is the subject.
    const f = await svc.observe({ tenantId: h.tenantId, surface: 'signin_failed', ip: '192.0.2.44' });
    expect(f?.account).toBe('ip:192.0.2.0/24');
  });

  it('shares the counts between two service instances on one store', async () => {
    const c = clock();
    const store = new MemoryCounterStore();
    const a = new SpamService(() => h.s, { now: c.now, store });
    const b = new SpamService(() => h.s, { now: c.now, store });
    await a.savePolicy(admin.p, { enabled: true, surfaces: { report: { account: 4 } } });
    const bob = await person(h, 'sig-bob');
    const seen = [];
    for (let i = 0; i < 6; i++) seen.push(await (i % 2 ? a : b).observe({ tenantId: h.tenantId, surface: 'report', userId: bob.id }));
    expect(await a.windows.read(windowKey(h.tenantId, 'report', 'account', bob.id), 600_000)).toBe(6);
    expect(await b.windows.read(windowKey(h.tenantId, 'report', 'account', bob.id), 600_000)).toBe(6);
    // The fifth event, whichever instance took it, is the first past the threshold of 4.
    expect(seen.map((o) => o!.reasons.some((r) => r.signal === 'rate.report.account'))).toEqual([false, false, false, false, true, true]);
  });

  it('never holds up a request when the store is slow', async () => {
    class StuckStore implements CounterStore {
      readonly kind = 'memory' as const;
      hits = 0;
      hit(): Promise<CounterState> {
        this.hits++;
        return new Promise(() => undefined);
      }
      async close(): Promise<void> {}
    }
    const store = new StuckStore();
    const svc = new SpamService(() => h.s, { store, recordTimeoutMs: 100, gateTimeoutMs: 50 });
    await svc.savePolicy(admin.p, { enabled: true, surfaces: { post: { mode: 'enforce' } } });
    // Recording returns at once and the event is dropped once its time box passes.
    const t0 = performance.now();
    svc.record({ tenantId: h.tenantId, surface: 'post', userId: alice.id, ip: '203.0.113.9', text: 'one two three four five six' });
    expect(performance.now() - t0).toBeLessThan(20);
    await svc.settle();
    expect(svc.dropped).toBe(1);
    // The gate, with a response active (so it must ask the store), lets the write through after its time box.
    const now = Date.now();
    await h.s.db('spam_responses').insert({ id: '01JZZZZZZZZZZZZZZZZZZZZZZZ', tenant_id: h.tenantId, user_id: alice.id, surface: 'post', kind: 'limit', state: 'active', score: 80, reasons: '[]', sanction_id: null, flag_id: null, starts_at: now, ends_at: now + 3_600_000, created_at: now });
    const t1 = performance.now();
    expect(await svc.gate(alice.p, 'post')).toEqual({ hold: null });
    expect(performance.now() - t1).toBeLessThan(1000);
    expect(store.hits).toBeGreaterThan(0);
    await h.s.db('spam_responses').where({ id: '01JZZZZZZZZZZZZZZZZZZZZZZZ' }).delete();
    await svc.savePolicy(admin.p, { surfaces: { post: { mode: 'shadow' } } });
  });
});
