import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Preempted, type Lease } from '../src/gateway/gateway.js';
import { cloudPool, cloudWorld, sleep, type CloudPoolWorld } from './cloud-autoscale-helpers.js';

/*
 * 1.9.99-final, Sprint 60 (B-10403): spot and preemptible capacity. A simulated interruption notice (the EC2
 * two-minute notice, the EC2 rebalance recommendation, Azure Scheduled Events `Preempt`) drains the instance through
 * the gateway before the provider reclaims it: no new lease is placed there, waiting requests go to another instance,
 * running ones finish or are moved off at the deadline. The spot group falls back to its on-demand sibling when spot
 * capacity runs out; DigitalOcean is on-demand only. The provider is in memory; no real cloud is called.
 */

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

describe('spot capacity and interruption notices (B-10403)', () => {
  let w: CloudPoolWorld;
  beforeEach(async () => {
    w = await cloudWorld();
  });
  afterEach(async () => {
    await w.close();
  });

  /** A second instance in the pool (another node), on the same fake Ollama. */
  const secondNode = async () => {
    const i = await w.h.s.gateway.repo.createInstance({ poolId: w.pool.id, name: 'gpu-2', url: w.ollama.url, deploy: 'docker', settings: { parallel: 4 } });
    await w.h.s.gateway.pollAll();
    return i.id;
  };
  const lease = async (): Promise<Lease> => {
    const g = w.h.s.gateway;
    const r = await g.resolve(w.h.tenantId, 'general');
    return g.acquire(r.profile, r.model, 'internal', { signal: new AbortController().signal });
  };

  it('an EC2 two-minute notice drains the instance before it is reclaimed: running leases finish, new ones go elsewhere', async () => {
    await cloudPool(w, 'aws', { min: 0, max: 3, desired: 2, purchase: 'spot' });
    const other = await secondNode();
    const g = w.h.s.gateway;
    // Pin the first lease to the noticed node: the other instance is full for a moment.
    await g.repo.updateInstance(other, { settings: { parallel: 1 } });
    await g.pollAll();
    const held = await lease();
    const running = held.instance.id === w.instanceId ? held : await lease();
    const noticed = running.instance.id;
    expect(running.preempted).toBeInstanceOf(AbortSignal);
    const reclaimAt = Date.now() + 120_000;
    const drain = w.h.s.cloud.autoscale.interruption(noticed, { kind: 'ec2_interruption', reclaimAt, eventId: 'i-0abc-1' });
    await sleep(100);
    expect((await g.repo.instance(noticed))!.state).toBe('draining');
    // No new lease on the noticed node.
    if (held !== running) held.release(null);
    const next = await lease();
    expect(next.instance.id).not.toBe(noticed);
    next.release(null);
    // The running lease finishes in time; the drain ends well before the reclaim.
    running.release(null);
    const out = await drain;
    expect(out).toMatchObject({ duplicate: false, state: 'drained', running: 1, finished: 1, moved: 0 });
    const row = await w.h.s.db('cloud_interruptions').where({ id: out.id }).first();
    expect(row).toMatchObject({ kind: 'ec2_interruption', state: 'drained', provider: 'aws' });
    expect(Number(row.drained_at)).toBeLessThan(reclaimAt);
    // The same notice posted again is recorded once.
    expect(await w.h.s.cloud.autoscale.interruption(noticed, { kind: 'ec2_interruption', reclaimAt, eventId: 'i-0abc-1' })).toMatchObject({ duplicate: true, id: out.id });
    // B-10803: the node picks the event id, so a new one for the same instance while its notice is open is the same event (no second replacement).
    expect(await w.h.s.cloud.autoscale.interruption(noticed, { kind: 'ec2_interruption', reclaimAt, eventId: 'i-0abc-2' })).toMatchObject({ duplicate: true, id: out.id });
    // A spot pool with the fallback asks the on-demand group for the replacement.
    await sleep(100);
    expect(w.clouds.aws.updates.some((u) => u.providerId.endsWith('gpu-pool-od') && u.count === 1)).toBe(true);
    const audit = await w.h.s.db('audit_events').where({ action: 'cloud.pool.drained' }).first();
    expect(JSON.parse(audit.detail)).toMatchObject({ instance: noticed, beforeReclaim: true });
  });

  it('a lease still running at the deadline is moved off before the node is reclaimed', async () => {
    await cloudPool(w, 'azure', { min: 0, max: 2, desired: 1, purchase: 'spot' });
    const running = await lease();
    let aborted: unknown = null;
    running.preempted!.addEventListener('abort', () => (aborted = running.preempted!.reason));
    // Azure Preempt: NotBefore is at least 30 s ahead; here 21 s, so the 20 s margin moves it at once.
    const reclaimAt = Date.now() + 21_000;
    const t0 = Date.now();
    const out = await w.h.s.cloud.autoscale.interruption(running.instance.id, { kind: 'azure_preempt', eventId: 'E1F2', reclaimAt: new Date(reclaimAt).toISOString() });
    expect(out).toMatchObject({ running: 1, moved: 1, finished: 0 });
    expect(Date.now()).toBeLessThan(reclaimAt);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(aborted).toBeInstanceOf(Preempted);
    running.release(null);
    expect((await w.h.s.db('cloud_interruptions').where({ id: out.id }).first()).moved).toBe(1);
  });

  it('a chat answer streaming on a reclaimed node is moved and resumes on another instance', async () => {
    await cloudPool(w, 'aws', { min: 0, max: 3, desired: 2, purchase: 'spot' });
    await secondNode();
    const { adminClient } = await import('./cloud-autoscale-helpers.js');
    const m = await adminClient(w, 'chatter');
    let release!: () => void;
    w.ollama.hold = new Promise((r) => (release = r));
    const sent = await m.agent.post('/api/chat').set('x-csrf-token', m.csrf).send({ content: 'Hello', profile: 'general' }).expect(202);
    let row: Record<string, unknown> | undefined;
    for (let i = 0; i < 100 && !row?.instance_id; i++) {
      await sleep(30);
      row = await w.h.s.db('messages').where({ id: sent.body.messageId }).first();
    }
    const first = String(row!.instance_id);
    // The notice: reclaimed 20.5 s from now, so the 20 s margin moves the answer at once.
    const out = await w.h.s.cloud.autoscale.interruption(first, { kind: 'ec2_interruption', reclaimAt: Date.now() + 20_500 });
    expect(out.moved).toBe(1);
    w.ollama.hold = null;
    release();
    let done: Record<string, unknown> | undefined;
    for (let i = 0; i < 200; i++) {
      done = await w.h.s.db('messages').where({ id: sent.body.messageId }).first();
      if (done && done.state === 'complete') break;
      await sleep(50);
    }
    expect(done).toMatchObject({ state: 'complete' });
    expect(done!.instance_id).not.toBe(first);
  });

  it('the EC2 rebalance recommendation drains without a deadline; the node route needs the node certificate', async () => {
    await cloudPool(w, 'aws', { min: 0, max: 2, desired: 1, purchase: 'spot' });
    const out = await w.h.s.cloud.autoscale.interruption(w.instanceId, { kind: 'ec2_rebalance' });
    expect(out).toMatchObject({ state: 'drained', deadlineAt: null, running: 0 });
    expect((await w.h.s.gateway.repo.instance(w.instanceId))!.state).toBe('draining');
    // No replacement for a recommendation (the node is not reclaimed yet).
    expect(await w.h.s.db('cloud_scale_events').where({ reason: 'fallback' }).first()).toBeUndefined();
    // Without a node certificate the channel refuses.
    const { default: request } = await import('supertest');
    await request(w.h.app).post('/cloud/v1/nodes/interruptions').send({ kind: 'ec2_interruption' }).expect(401);
    // A per-address limit: 60 notices a minute, then 429.
    for (let i = 1; i < 60; i++) await request(w.h.app).post('/cloud/v1/nodes/interruptions').send({ kind: 'ec2_interruption' }).expect(401);
    await request(w.h.app).post('/cloud/v1/nodes/interruptions').send({ kind: 'ec2_interruption' }).expect(429);
  });

  it('a certificate maps to its instance only when it was issued at enrolment to a node of that instance\'s pool', async () => {
    const { deployment } = await cloudPool(w, 'aws', { min: 0, max: 2, desired: 1 });
    const db = w.h.s.db;
    const fp = 'ab'.repeat(32);
    const now = Date.now();
    await db('pki_certificates').insert({ id: '01JCERT0000000000000000000', tenant_id: w.h.tenantId, issuer_id: '01JISSUER00000000000000000', profile_id: null, serial: '01', common_name: 'gpu-node', sans: '[]', key_type: 'ec-p256', not_before: now - 1000, not_after: now + 86_400_000, certificate_pem: 'x', fingerprint: fp, state: 'valid', created_at: now });
    const link = (poolId: string) => ({ id: '01JLINK0000000000000000000', tenant_id: w.h.tenantId, deployment_id: deployment.id, provider: 'aws', pool_name: 'gpu', resource_key: 'gpu-pool', kind: 'node_group', provider_id: null, gateway_pool_id: poolId, gpu: 'h100', instance_type: 'g5.xlarge', instance_types: '[]', zones: '[]', min_nodes: 0, max_nodes: 2, desired_nodes: 1, price_hourly: null, currency: null, server_profile_id: null, client_profile_id: null, client_cert_id: null, client_key_sealed: null, warmup: '{"source":"mirror"}', state: 'active', state_detail: null, created_at: now, updated_at: now });
    await db('cloud_gpu_pool_links').insert(link('01JOTHERPOOL00000000000000'));
    await db('cloud_gpu_enrolments').insert({ id: '01JENROL000000000000000000', link_id: '01JLINK0000000000000000000', token_hash: 'c'.repeat(64), node: 'ip-10-0-0-1', address: null, expires_at: now + 1000, used_at: now, instance_id: w.instanceId, certificate_id: '01JCERT0000000000000000000', created_by: null, created_at: now });
    // Issued to a node of another pool: refused.
    expect(await w.h.s.cloud.autoscale.instanceForCertificate(fp)).toBeNull();
    await db('cloud_gpu_pool_links').update({ gateway_pool_id: w.pool.id });
    expect(await w.h.s.cloud.autoscale.instanceForCertificate(fp.match(/../g)!.join(':').toUpperCase())).toBe(w.instanceId);
    // Revoked: refused.
    await db('pki_certificates').where({ fingerprint: fp }).update({ state: 'revoked' });
    expect(await w.h.s.cloud.autoscale.instanceForCertificate(fp)).toBeNull();
  });

  it('falls back to on-demand nodes when spot capacity runs out', async () => {
    await cloudPool(w, 'azure', { min: 0, max: 3, desired: 0, purchase: 'spot' });
    w.clouds.azure.noSpot = true;
    const r = await w.h.s.cloud.autoscale.scaleTo(w.admin, w.pool.id, 1);
    expect(r).toMatchObject({ outcome: 'applied', capacity: 'on_demand', to: 1 });
    expect(w.clouds.azure.updates.at(-1)).toMatchObject({ count: 1, purchase: 'on_demand' });
    expect(w.clouds.azure.updates.at(-1)!.providerId).toMatch(/gpu-pool-od$/);
    expect((await w.h.s.db('cloud_scale_policies').where({ pool_id: w.pool.id }).first()).capacity_now).toBe('on_demand');
    expect(await w.h.s.db('audit_events').where({ action: 'cloud.pool.capacity.fallback' }).first()).toBeTruthy();
    // Back to zero returns the pool to spot for the next scale-up.
    await w.h.s.cloud.autoscale.scaleTo(w.admin, w.pool.id, 0);
    expect((await w.h.s.db('cloud_scale_policies').where({ pool_id: w.pool.id }).first()).capacity_now).toBe('spot');
    w.clouds.azure.noSpot = false;
    expect(await w.h.s.cloud.autoscale.scaleTo(w.admin, w.pool.id, 1)).toMatchObject({ capacity: 'spot' });
    expect(w.clouds.azure.updates.at(-1)).toMatchObject({ count: 1, purchase: 'spot' });
  });

  it('DigitalOcean offers on-demand only: no spot policy, no interruption notice', async () => {
    await cloudPool(w, 'digitalocean', { min: 0, max: 2, desired: 1 });
    const p = (await w.h.s.cloud.autoscale.policy(w.pool.id))!;
    await expect(w.h.s.cloud.autoscale.setPolicy(w.admin, w.pool.id, { min: 0, max: 2, idleMinutes: 15, queueDepth: 2, maxColdWaitMinutes: 10, capacity: 'spot', onDemandFallback: true, deploymentId: p.deploymentId!, resourceKey: p.resourceKey! })).rejects.toMatchObject({ status: 422, extensions: { reason: 'spot_unavailable' } });
    await expect(w.h.s.cloud.autoscale.interruption(w.instanceId, { kind: 'ec2_interruption' })).rejects.toMatchObject({ status: 422, extensions: { reason: 'wrong_provider' } });
    // The deployment spec refuses a spot GPU pool on DigitalOcean too.
    const { deploymentSpecSchema, validateSpec } = await import('../src/cloud/spec.js');
    const spec = deploymentSpecSchema.parse({ name: 'dospot', target: { provider: 'digitalocean', accountId: w.accounts.digitalocean!.id, region: 'fra1' }, compute: { shape: 'kubernetes', size: 'small' }, frontDoor: { kind: 'acme', hostname: 'ai.example.com', zone: 'example.com' }, gpuPools: [{ name: 'g', gpu: 'h100', purchase: 'spot' }] });
    const v = await validateSpec(w.h.s, w.admin.principal, spec);
    expect(v.problems).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'gpuPools.0.purchase', check: 'offer' })]));
  });
});
