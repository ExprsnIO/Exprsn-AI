import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { monthBounds } from '../src/cloud/autoscale.js';
import { adminClient, cloudPool, cloudWorld, SHEET_PRICE, type CloudPoolWorld } from './cloud-autoscale-helpers.js';

/*
 * 1.9.99-final, Sprint 60 (B-10605): idle GPU savings. Every idle (or manual) scale-down opens an interval in the
 * savings ledger with the nodes it took away; a scale-up closes it. A pool's saving for a month is its scaled-down
 * node-hours in that month times its on-demand hourly price (the price sheet's, no API call).
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const HOUR = 3_600_000;

describe('idle GPU savings (B-10605)', () => {
  let w: CloudPoolWorld;
  beforeEach(async () => {
    w = await cloudWorld();
  });
  afterEach(async () => {
    await w.close();
  });

  it('the savings report for a pool equals its scaled-down hours times its on-demand price', async () => {
    await cloudPool(w, 'digitalocean', { min: 0, max: 2, desired: 2 });
    const a = w.h.s.cloud.autoscale;
    // Idle: 2 → 0 opens an interval of two nodes; it is moved back to a fixed place in October for the arithmetic.
    await w.h.s.db('cloud_scale_policies').where({ pool_id: w.pool.id }).update({ last_lease_at: Date.now() - HOUR, scaled_at: Date.now() - HOUR });
    expect((await a.tick()).down).toEqual([w.pool.id]);
    const [start] = monthBounds('2026-10');
    await w.h.s.db('cloud_gpu_savings').where({ pool_id: w.pool.id }).update({ from_at: start + 10 * HOUR, to_at: start + 20 * HOUR });
    // A second interval: one node away for 5.5 hours, the last ones crossing into November (only October counts).
    await w.h.s.db('cloud_gpu_savings').insert({ id: '01JSAVE0000000000000000001', pool_id: w.pool.id, provider: 'digitalocean', region: 'fra1', sku: 'droplet:gpu-h100x1-80gb', nodes: 1, from_at: monthBounds('2026-11')[0] - 5.5 * HOUR, to_at: monthBounds('2026-11')[0] + 3 * HOUR });
    const [row] = await a.savings('2026-10', { now: monthBounds('2026-12')[0] });
    const hours = 2 * 10 + 1 * 5.5;
    expect(row).toMatchObject({ poolId: w.pool.id, month: '2026-10', provider: 'digitalocean', sku: 'droplet:gpu-h100x1-80gb', hours, priceHourly: SHEET_PRICE.digitalocean, currency: 'USD', priceSource: 'price-sheet', intervals: 2 });
    expect(row!.saving).toBeCloseTo(hours * SHEET_PRICE.digitalocean, 2);
    // November counts its three hours.
    expect((await a.savings('2026-11', { now: monthBounds('2026-12')[0] }))[0]).toMatchObject({ hours: 3 });
    // The route reports it per pool by name (finops:read or cloud:read).
    const admin = await adminClient(w, 'finops');
    const res = await admin.agent.get('/api/admin/cloud/gpu-savings?month=2026-10').expect(200);
    // (to now: the part of an interval still ahead of the clock does not count yet)
    expect(res.body.pools[0]).toMatchObject({ pool: 'gpu', hours: (await a.savings('2026-10'))[0]!.hours });
    await admin.agent.get('/api/admin/cloud/gpu-savings?month=2026-13').expect(400);
  });

  it('a scale-up closes the open interval; an open one counts up to now', async () => {
    await cloudPool(w, 'aws', { min: 0, max: 2, desired: 1 });
    const a = w.h.s.cloud.autoscale;
    expect(await a.scaleTo(w.admin, w.pool.id, 0)).toMatchObject({ outcome: 'applied' });
    const open = await w.h.s.db('cloud_gpu_savings').where({ pool_id: w.pool.id }).first();
    expect(open).toMatchObject({ nodes: 1, to_at: null, sku: 'ec2:g5.xlarge' });
    await w.h.s.db('cloud_gpu_savings').where({ id: open.id }).update({ from_at: Date.now() - 2 * HOUR });
    const now = Date.now();
    const [live] = await a.savings(new Date(now).toISOString().slice(0, 7), { now });
    // Two hours at most (a month boundary in the last two hours counts less).
    expect(live!.hours).toBeLessThanOrEqual(2.001);
    expect(live!.saving).toBeCloseTo(live!.hours * SHEET_PRICE.aws, 2);
    await a.scaleTo(w.admin, w.pool.id, 1);
    expect((await w.h.s.db('cloud_gpu_savings').where({ id: open.id }).first()).to_at).toBeGreaterThan(0);
    // The metric reads the same ledger.
    const text = await w.h.s.metrics.registry.metrics();
    expect(text).toMatch(/exprsn_cloud_gpu_saved_hours\{provider="aws"\} [0-9.]+/);
  });
});
