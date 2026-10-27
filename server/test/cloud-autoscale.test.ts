import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueueTimeout } from '../src/gateway/gateway.js';
import type { ProfileRow } from '../src/gateway/repo.js';
import { HttpProblem } from '../src/http/problem.js';
import { adminClient, cloudPool, cloudWorld, sleep, type CloudPoolWorld } from './cloud-autoscale-helpers.js';
import { localUser, login } from './helpers.js';

/*
 * 1.9.99-final, Sprint 60 (B-10402, B-10406): scale-to-zero and autoscale of a cloud GPU pool. The node group lives on
 * an in-memory provider; a "node" is the fake Ollama behind the pool's instance, which the fake cloud turns on a
 * boot time after a scale-up from zero and off when the group goes to zero. No real cloud is called.
 */

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

const HOUR = 3_600_000;
const later = (ms: number) => Date.now() + ms;

describe('scale-to-zero and autoscale (B-10402)', () => {
  let w: CloudPoolWorld;
  beforeEach(async () => {
    w = await cloudWorld();
  });
  afterEach(async () => {
    await w.close();
  });

  const cloudOf = () => w.clouds.digitalocean;
  const desired = async () => Number((await w.h.s.db('cloud_scale_policies').where({ pool_id: w.pool.id }).first()).desired);

  it('scales to zero after the idle minutes with no slot leases, never while a lease runs', async () => {
    await cloudPool(w, 'digitalocean', { min: 0, max: 2, desired: 1, idleMinutes: 15 });
    const g = w.h.s.gateway;
    const a = w.h.s.cloud.autoscale;
    // A lease taken now: the pool is busy, so even an hour later nothing scales down while it runs.
    const r = await g.resolve(w.h.tenantId, 'general');
    const lease = await g.acquire(r.profile, r.model, 'internal', { signal: new AbortController().signal });
    expect(await a.tick(later(HOUR))).toEqual({ up: [], down: [] });
    expect(await desired()).toBe(1);
    lease.release(null);
    // Fourteen minutes after the last lease: not yet; past fifteen: down to the minimum, zero.
    await w.h.s.db('cloud_scale_policies').where({ pool_id: w.pool.id }).update({ last_lease_at: Date.now(), scaled_at: Date.now() - HOUR });
    expect((await a.tick(later(14 * 60_000))).down).toEqual([]);
    expect((await a.tick(later(16 * 60_000))).down).toEqual([w.pool.id]);
    expect(await desired()).toBe(0);
    expect(cloudOf().updates.at(-1)).toMatchObject({ count: 0 });
    const ev = await w.h.s.db('cloud_scale_events').where({ pool_id: w.pool.id, outcome: 'applied' }).orderBy('requested_at', 'desc').first();
    expect(ev).toMatchObject({ from_size: 1, to_size: 0, reason: 'idle' });
    // Audited, and the provider call is in the deployment's journal.
    const audit = await w.h.s.db('audit_events').where({ action: 'cloud.pool.scaled' }).orderBy('seq', 'desc').first();
    expect(JSON.parse(audit.detail)).toMatchObject({ pool: w.pool.id, from: 1, to: 0, reason: 'idle' });
    expect(await w.h.s.db('cloud_operations').where({ resource_key: 'gpu-pool', step: 'update', state: 'succeeded' }).first()).toBeTruthy();
  });

  it('a chat on a scaled-to-zero pool answers after the cold start (no fallback: it waits in the queue)', async () => {
    await cloudPool(w, 'digitalocean', { min: 0, max: 2, desired: 0 });
    await w.h.s.gateway.repo.updateInstance(w.instanceId, { state: 'disabled' });
    await w.h.s.gateway.pollAll();
    const m = await adminClient(w, 'mem');
    const sent = await m.agent.post('/api/chat').set('x-csrf-token', m.csrf).send({ content: 'Hello', profile: 'general' }).expect(202);
    const done = await settle(w, sent.body.messageId);
    expect(done.state).toBe('complete');
    expect(done.profile_name).toBe('general');
    expect(await desired()).toBe(1);
    const ev = await w.h.s.db('cloud_scale_events').where({ pool_id: w.pool.id, reason: 'cold' }).first();
    expect(ev).toMatchObject({ from_size: 0, to_size: 1, outcome: 'applied' });
    // The next tick records when the started node answered healthy: a boot-to-healthy timing for the estimate.
    await w.h.s.cloud.autoscale.tick();
    expect((await w.h.s.db('cloud_scale_events').where({ id: ev.id }).first()).healthy_at).toBeGreaterThan(0);
    expect((await w.h.s.cloud.autoscale.estimateMs(w.pool.id)).source).toBe('scale_events');
  });

  it('a chat on a scaled-to-zero pool answers from the fallback when the cold-start estimate exceeds the wait', async () => {
    await cloudPool(w, 'digitalocean', { min: 0, max: 2, desired: 0 });
    // The fallback profile runs on another (on-prem) pool, with its own instance.
    const repo = w.h.s.gateway.repo;
    const onprem = await repo.createPool({ name: 'onprem', accelerator: 'cuda', zone: 'inference', labelCeiling: 'confidential' });
    await repo.createInstance({ poolId: onprem.id, name: 'onprem-1', url: w.ollama.url, deploy: 'docker', settings: { parallel: 2 } });
    await repo.place(w.profile.model_id!, onprem.id, 'warm', 'x');
    const backup: ProfileRow = { ...w.profile, id: 'BACKUP'.padEnd(26, '0'), name: 'backup', display_name: 'Backup', pool_id: onprem.id, fallback: null };
    await repo.createProfile(backup);
    await repo.updateProfile(w.h.tenantId, w.profile.id, { fallback: { profileId: backup.id, afterQueueWaitMs: 2000 } });
    await repo.updateInstance(w.instanceId, { state: 'disabled' });
    await w.h.s.gateway.pollAll();
    // No timing recorded: the estimate is the default four minutes, longer than the two-second wait.
    expect((await w.h.s.cloud.autoscale.estimateMs(w.pool.id)).ms).toBe(4 * 60_000);
    const m = await adminClient(w, 'mem2');
    const sent = await m.agent.post('/api/chat').set('x-csrf-token', m.csrf).send({ content: 'Hello', profile: 'general' }).expect(202);
    const done = await settle(w, sent.body.messageId);
    expect(done.state).toBe('complete');
    expect(done.profile_name).toBe('backup');
    // The node was still asked for, so the next request finds it.
    expect(await desired()).toBe(1);

    // With a recorded boot of under a second, the same request waits for the node instead of falling back.
    await w.h.s.db('cloud_scale_events').insert({ id: '01JZZZZZZZZZZZZZZZZZZZZZZZ', pool_id: w.pool.id, from_size: 0, to_size: 1, reason: 'cold', outcome: 'applied', capacity: 'on_demand', actor: 'autoscale', detail: null, requested_at: Date.now() - 10_000, healthy_at: Date.now() - 9_400 });
    await w.h.s.db('cloud_scale_events').where({ healthy_at: null }).update({ healthy_at: Date.now() - 1 });
    await repo.updateInstance(w.instanceId, { state: 'disabled' });
    await w.h.s.db('cloud_scale_policies').where({ pool_id: w.pool.id }).update({ desired: 0 });
    await w.h.s.gateway.pollAll();
    const g = w.h.s.gateway;
    const r = await g.resolve(w.h.tenantId, 'general');
    const got = await g.acquireFollowing(r, 'internal', { signal: new AbortController().signal }, (id) => g.resolve(w.h.tenantId, id));
    expect(got.resolved.profile.name).toBe('general');
    expect(got.lease.instance.id).toBe(w.instanceId);
    got.lease.release(null);
  });

  it('scales up by one node when the queue reaches the queue depth per node, within the maximum', async () => {
    await cloudPool(w, 'digitalocean', { min: 0, max: 2, desired: 1, queueDepth: 2 });
    const g = w.h.s.gateway;
    await g.repo.updateInstance(w.instanceId, { settings: { parallel: 1 } });
    await g.pollAll();
    const r = await g.resolve(w.h.tenantId, 'general');
    const ac = new AbortController();
    const first = await g.acquire(r.profile, r.model, 'internal', { signal: ac.signal });
    const waiting = [0, 1].map(() => g.acquire(r.profile, r.model, 'internal', { signal: ac.signal, waitMs: 30_000 }).catch(() => null));
    await sleep(50);
    expect(g.poolActivity().find((x) => x.poolId === w.pool.id)).toMatchObject({ inflight: 1, queued: 2 });
    expect((await w.h.s.cloud.autoscale.tick()).up).toEqual([w.pool.id]);
    expect(await desired()).toBe(2);
    expect((await w.h.s.db('cloud_scale_events').where({ reason: 'queue' }).first())).toMatchObject({ from_size: 1, to_size: 2 });
    // At the maximum: no further scale-up however long the queue.
    await w.h.s.db('cloud_scale_events').update({ healthy_at: Date.now() });
    expect((await w.h.s.cloud.autoscale.tick()).up).toEqual([]);
    expect(await desired()).toBe(2);
    first.release(null);
    for (const l of await Promise.all(waiting)) l?.release(null);
    ac.abort();
  });

  it('respects the minimum and the maximum, and the console route scales to zero, audited', async () => {
    await cloudPool(w, 'digitalocean', { min: 1, max: 2, desired: 1 });
    const a = w.h.s.cloud.autoscale;
    // The idle scale-down stops at the minimum of one.
    await w.h.s.db('cloud_scale_policies').where({ pool_id: w.pool.id }).update({ desired: 2, last_lease_at: Date.now() - 2 * HOUR, scaled_at: Date.now() - 2 * HOUR });
    expect((await a.tick()).down).toEqual([w.pool.id]);
    expect(await desired()).toBe(1);
    expect((await a.tick()).down).toEqual([]);
    await expect(a.scaleTo(w.admin, w.pool.id, 3)).rejects.toMatchObject({ status: 422 });
    await expect(a.scaleTo(w.admin, w.pool.id, 0)).rejects.toMatchObject({ status: 422 });
    // Lower the minimum from the card, then scale to zero through the route.
    const admin = await adminClient(w, 'poolsadmin');
    const put = await admin.agent.put(`/api/admin/pools/${w.pool.id}/autoscale`).set('x-csrf-token', admin.csrf).send({ min: 0, max: 2, idleMinutes: 20, capacity: 'on_demand' }).expect(200);
    expect(put.body.policy).toMatchObject({ min: 0, max: 2, idleMinutes: 20 });
    const res = await admin.agent.post(`/api/admin/pools/${w.pool.id}/scale`).set('x-csrf-token', admin.csrf).send({ desired: 0, reason: 'Night' }).expect(200);
    expect(res.body).toMatchObject({ outcome: 'applied', from: 1, to: 0 });
    expect(res.body.card).toMatchObject({ desired: 0, costPerHour: 0 });
    expect(w.clouds.digitalocean.updates.at(-1)).toMatchObject({ count: 0 });
    const audit = await w.h.s.db('audit_events').where({ action: 'cloud.pool.scaled' }).orderBy('seq', 'desc').first();
    expect(JSON.parse(audit.detail)).toMatchObject({ pool: w.pool.id, from: 1, to: 0, reason: 'manual', note: 'Night' });
    expect(JSON.parse(audit.actor)).toMatchObject({ username: 'poolsadmin' });
    // The cards route lists the pool; a member cannot scale.
    const cards = await admin.agent.get('/api/admin/pools/cloud').expect(200);
    expect(cards.body.cards[w.pool.id]).toMatchObject({ provider: 'digitalocean', spot: { offered: false } });
    await localUser(w.h, 'nobody', ['member'], 'internal');
    const m = await login(w.h, 'nobody');
    await m.agent.post(`/api/admin/pools/${w.pool.id}/scale`).set('x-csrf-token', m.csrf).send({ desired: 1 }).expect(403);
  });

  it('the hard stop refuses a scale-up (manual and automatic) and always allows a scale-down', async () => {
    const { account } = await cloudPool(w, 'digitalocean', { min: 0, max: 3, desired: 1 });
    await w.h.s.cloud.budgets.set(w.admin, account.id, { amount: 100, hardStop: 'actual' });
    w.spend.actual = 150;
    w.spend.forecastAmount = 150;
    const a = w.h.s.cloud.autoscale;
    const err = await a.scaleTo(w.admin, w.pool.id, 2).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpProblem);
    expect(err).toMatchObject({ status: 409, extensions: { reason: 'budget_exceeded' } });
    expect((err as HttpProblem).detail).toMatch(/budget_exceeded/);
    expect(await desired()).toBe(1);
    expect(await w.h.s.db('cloud_scale_events').where({ outcome: 'refused' }).first()).toMatchObject({ from_size: 1, to_size: 2 });
    expect(await w.h.s.db('audit_events').where({ action: 'cloud.pool.scale.refused' }).first()).toBeTruthy();
    // Scaling down is always allowed past the hard stop.
    expect(await a.scaleTo(w.admin, w.pool.id, 0)).toMatchObject({ outcome: 'applied', to: 0 });
    // A cold start past the hard stop: no node starts; with no fallback the request fails with the reason.
    await w.h.s.gateway.repo.updateInstance(w.instanceId, { state: 'disabled' });
    await w.h.s.gateway.pollAll();
    const g = w.h.s.gateway;
    const r = await g.resolve(w.h.tenantId, 'general');
    const cold = await g.acquire(r.profile, r.model, 'internal', { signal: new AbortController().signal }).catch((e: unknown) => e);
    expect(cold).toMatchObject({ status: 503, extensions: { reason: 'cold_start_refused' } });
    // With a fallback's wait it ends at once as a queue timeout, so the fallback serves.
    expect(await g.acquire(r.profile, r.model, 'internal', { signal: new AbortController().signal, waitMs: 5000 }).catch((e: unknown) => e)).toBeInstanceOf(QueueTimeout);
    expect(await desired()).toBe(0);
  });

  it('without migration 158 the routes answer 503 and the gateway serves the pool as before', async () => {
    await w.h.s.db.schema.dropTable('cloud_gpu_savings');
    w.h.s.cloud.autoscale.resetSchemaCache();
    const admin = await adminClient(w, 'poolsadmin2');
    expect((await admin.agent.get('/api/admin/pools/cloud').expect(200)).body).toEqual({ installed: false, cards: {} });
    await admin.agent.get('/api/admin/cloud/gpu-savings').expect(503);
    expect(await w.h.s.cloud.autoscale.tick()).toEqual({ up: [], down: [] });
    const g = w.h.s.gateway;
    const r = await g.resolve(w.h.tenantId, 'general');
    const lease = await g.acquire(r.profile, r.model, 'internal', { signal: new AbortController().signal });
    expect(lease.preempted).toBeUndefined();
    lease.release(null);
  });
});

/** Waits for an answer to finish and returns its message row. */
async function settle(w: CloudPoolWorld, messageId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 300; i++) {
    const m = (await w.h.s.db('messages').where({ id: messageId }).first()) as Record<string, unknown>;
    if (m && !['queued', 'streaming'].includes(String(m.state))) return m;
    await sleep(50);
  }
  throw new Error('the answer did not finish');
}
