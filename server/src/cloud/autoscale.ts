import { createHash, type X509Certificate } from 'node:crypto';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { Label } from '../authz/labels.js';
import type { ColdStart, PoolActivity } from '../gateway/gateway.js';
import type { ModelRow, PoolRow } from '../gateway/repo.js';
import { conflict, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import type { CloudActor } from './accounts.js';
import { cloudAudit, type CloudAuditActor } from './audit.js';
import { autoscaleMetrics } from './cloud-metrics.js';
import type { GpuPoolLink } from './gpu-pools.js';
import { idempotencyKey } from './journal.js';
import { CloudProviderError } from './providers/types.js';
import type { Provider } from './types.js';

/*
 * 1.9.99-final, Sprint 60 (B-10402, B-10403, B-10406, B-10605): scale-to-zero, autoscale, spot capacity and idle GPU
 * savings for gateway pools that run on cloud GPU node groups, `s.cloud.autoscale` (migration 158).
 *
 * - A scale policy per pool: minimum, maximum and desired nodes, the idle minutes, the queue depth per node that adds
 *   a node, the longest cold wait, the capacity (`on_demand`, or `spot` with an on-demand fallback). The node group is
 *   found through the GPU pools link (`cloud/gpu-pools.ts`, `linkFor`), else through the policy's own deployment and
 *   resource key.
 * - The gateway asks `coldStart` when a pool has no instance for a request: the node group is scaled to at least one
 *   node and the request waits in the queue with the estimate (the median of the recorded boot-to-healthy timings), or
 *   takes the profile's fallback when the estimate exceeds its wait (`Gateway.awaitCold`).
 * - `tick` (every 30 s on every server, and in tests by hand): scale down to the minimum after the idle minutes with
 *   no slot lease, queue or cold waiter on any server (`last_lease_at` is shared through the policy row); scale up by
 *   one node when the queue reaches `queue_depth` waiting requests per node; record when a scale-up became healthy.
 * - Budgets (open decision 10): a scale-up counts as adding cost and is refused while the account's hard stop is
 *   engaged without an override; a scale-down is always allowed.
 * - Spot: a spot pool's node group is created with spot capacity (EC2 Spot through `capacityType: SPOT`, Azure Spot
 *   through `scaleSetPriority: Spot`); DigitalOcean offers on-demand only. When the spot group cannot grow (a capacity
 *   error) the on-demand sibling (`<key>-od`) grows instead. Interruption notices posted by the node (`interruption`)
 *   drain the instance through `Gateway.preempt` before the provider reclaims it.
 * - Savings: every idle scale-down opens an interval in `cloud_gpu_savings` (the nodes it took away); a scale-up
 *   closes it. Saved hours × the on-demand hourly price is the month's estimated saving per pool.
 *
 * Without migration 158 nothing here runs: the gateway serves cloud pools as before and the routes answer 503.
 */

export const AUTOSCALE_TABLES = ['cloud_scale_policies', 'cloud_scale_events', 'cloud_interruptions', 'cloud_gpu_savings'] as const;
export const CAPACITIES = ['on_demand', 'spot'] as const;
export type Capacity = (typeof CAPACITIES)[number];
export const SCALE_REASONS = ['idle', 'queue', 'cold', 'manual', 'interruption', 'fallback'] as const;
export type ScaleReason = (typeof SCALE_REASONS)[number];
export const INTERRUPTION_KINDS = ['ec2_interruption', 'ec2_rebalance', 'azure_preempt'] as const;
export type InterruptionKind = (typeof INTERRUPTION_KINDS)[number];

/** Without a recorded boot-to-healthy timing, a cold start is estimated at four minutes. */
export const DEFAULT_COLD_START_MS = 4 * 60_000;
/** Running leases on a node with a notice are moved this long before the provider reclaims it. */
export const MOVE_MARGIN_MS = 20_000;
const TICK_MS = 30_000;
const RECHECK_MS = 30_000;

export const autoscaleMissing = () => new HttpProblem(503, 'Not installed', 'Autoscale needs the database migration 158_cloud_autoscale, which has not been applied.', { extensions: { reason: 'migration_pending' } });

export const policySchema = z
  .object({
    min: z.number().int().min(0).max(64),
    max: z.number().int().min(1).max(64),
    idleMinutes: z.number().int().min(1).max(24 * 60).default(15),
    queueDepth: z.number().int().min(1).max(100).default(2),
    maxColdWaitMinutes: z.number().int().min(1).max(60).default(10),
    capacity: z.enum(CAPACITIES).default('on_demand'),
    onDemandFallback: z.boolean().default(true),
    /** Without a GPU pools link: the deployment and node group key the pool runs on. */
    deploymentId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).optional(),
    resourceKey: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/).optional()
  })
  .strict()
  .refine((p) => p.max >= p.min, { message: 'max must be at least min', path: ['max'] });

export const desiredSchema = z.object({ desired: z.number().int().min(0).max(64), reason: z.string().trim().max(300).optional() }).strict();

export const noticeSchema = z
  .object({
    kind: z.enum(INTERRUPTION_KINDS),
    /** The provider's event id (Azure `EventId`) or notice time; one notice is recorded once. */
    eventId: z.string().trim().min(1).max(100).optional(),
    /** When the provider reclaims the node (EC2 `instance-action` time, Azure `NotBefore`), ms or ISO. */
    reclaimAt: z.union([z.number().int().positive(), z.string().datetime()]).optional(),
    detail: z.string().trim().max(500).optional()
  })
  .strict();

export interface ScalePolicy {
  poolId: string;
  deploymentId: string | null;
  resourceKey: string | null;
  min: number;
  max: number;
  desired: number;
  idleMinutes: number;
  queueDepth: number;
  maxColdWaitMs: number;
  capacity: Capacity;
  onDemandFallback: boolean;
  capacityNow: Capacity;
  /** A spot pool's nodes on its on-demand sibling (`<key>-od`); the rest run on the spot group. */
  odNodes: number;
  lastLeaseAt: number | null;
  scaledAt: number | null;
  updatedAt: number;
}

function policyFrom(r: Record<string, unknown>): ScalePolicy {
  const n = (v: unknown) => (v == null ? null : Number(v));
  return {
    poolId: String(r.pool_id),
    deploymentId: (r.deployment_id as string | null) ?? null,
    resourceKey: (r.resource_key as string | null) ?? null,
    min: Number(r.min),
    max: Number(r.max),
    desired: Number(r.desired),
    idleMinutes: Number(r.idle_minutes),
    queueDepth: Number(r.queue_depth),
    maxColdWaitMs: Number(r.max_cold_wait_ms),
    capacity: String(r.capacity) as Capacity,
    onDemandFallback: !!r.on_demand_fallback,
    capacityNow: String(r.capacity_now) as Capacity,
    odNodes: Number(r.od_nodes ?? 0),
    lastLeaseAt: n(r.last_lease_at),
    scaledAt: n(r.scaled_at),
    updatedAt: Number(r.updated_at)
  };
}

/** The node group a pool scales: the provider, the deployment's account and region, the graph key, the node size. */
export interface ScaleTarget {
  poolId: string;
  link: GpuPoolLink | null;
  deploymentId: string;
  accountId: string;
  tenantId: string;
  provider: Provider;
  region: string;
  resourceKey: string;
  /** The node's instance type or size (`g5.xlarge`, `Standard_NV36ads_A10_v5`, `gpu-h100x1-80gb`). */
  size: string;
  /** The node group's own limits (the spec's), which the provider call keeps. */
  groupMin: number;
  groupMax: number;
}

/** Changes a node group's size at the provider. The real one calls the adapter; tests may set a fake. */
export interface NodeScaler {
  setDesired(s: Services, t: ScaleTarget, key: string, desired: number): Promise<{ requestId: string | null }>;
}

/** A spot group that could not grow for want of capacity (the on-demand sibling grows instead). */
export function isCapacityError(err: unknown): boolean {
  const text = err instanceof CloudProviderError ? `${err.code ?? ''} ${err.message}` : err instanceof Error ? err.message : '';
  return /InsufficientInstanceCapacity|SpotMaxPriceTooLow|MaxSpotInstanceCountExceeded|UnfulfillableCapacity|SkuNotAvailable|OverconstrainedAllocationRequest|AllocationFailed|capacity/i.test(text);
}

/** The adapter's update of the node group: its `count` (desired size) within the group's own min and max, journaled. */
export class ProviderScaler implements NodeScaler {
  async setDesired(s: Services, t: ScaleTarget, key: string, desired: number): Promise<{ requestId: string | null }> {
    const d = await s.cloud.deployments.get(t.deploymentId);
    if (!d) throw notFound('Deployment');
    const row = await s.cloud.deployments.resource(d.id, key);
    if (!row || !row.providerId) throw conflict(`${key} has not been created in ${d.name}; apply the deployment first.`);
    if (row.type !== 'node_group') throw conflict(`${key} is a ${row.type}; only node groups scale here (GPU VM pools scale by plan).`);
    const c = await s.cloud.deployments.context(d, 'deploy');
    const own = row.desired.spec as { min?: number; max?: number };
    const spec = { ...row.desired.spec, min: Number(own.min ?? 0), max: Math.max(Number(own.max ?? t.groupMax), desired), count: desired, gatewayScaled: true };
    const ikey = idempotencyKey(d.id, null, key, 'update');
    const opKey = `${ikey}-${Date.now().toString(36)}`;
    const journal = (state: 'started' | 'succeeded' | 'failed', extra: { error?: string; providerRequestId?: string | null } = {}) =>
      s.cloud.journal.append({ deploymentId: d.id, planId: null, resourceKey: key, step: 'update', idempotencyKey: opKey, attempt: 1, state, providerId: row.providerId, ...(extra.error ? { error: extra.error } : {}), ...(extra.providerRequestId ? { providerRequestId: extra.providerRequestId } : {}) }).catch(() => undefined);
    await journal('started');
    try {
      const out = await c.provider.update(c.ctx(row.region), { type: 'node_group', providerId: row.providerId, region: row.region, locator: row.locator ?? null } as Parameters<typeof c.provider.update>[1], s.cloud.deployments.specFor(d, c.account, { ...row.desired, spec }, ikey, new Map()));
      await journal('succeeded', { providerRequestId: out.requestId ?? null });
      return { requestId: out.requestId ?? null };
    } catch (err) {
      await journal('failed', { error: (err as Error).message, providerRequestId: err instanceof CloudProviderError ? err.requestId : null });
      throw err;
    }
  }
}

export interface ScaleResult {
  outcome: 'applied' | 'refused' | 'failed' | 'unchanged';
  from: number;
  to: number;
  capacity: Capacity;
  message: string;
}

type Actor = CloudActor | { service: string; onBehalfOf?: string | null };
const SYSTEM: Actor = { service: 'autoscale' };
const actorName = (a: Actor) => ('principal' in a ? a.principal.username : a.service);
const auditActor = (a: Actor): CloudAuditActor => ('principal' in a ? { principal: a.principal, ip: a.ip, ...(a.traceId ? { traceId: a.traceId } : {}) } : { service: a.service, onBehalfOf: a.onBehalfOf ?? null });
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m]! : Math.round((a[m - 1]! + a[m]!) / 2);
};
export const monthBounds = (month: string): [number, number] => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return [Date.UTC(y, m - 1, 1), Date.UTC(y, m, 1)];
};
export const monthOfTs = (t: number) => new Date(t).toISOString().slice(0, 7);
const nodeSku = (provider: Provider, size: string) => (provider === 'aws' ? `ec2:${size}` : provider === 'azure' ? `vm:${size}` : `droplet:${size}`);

export interface PoolSavings {
  poolId: string;
  month: string;
  provider: Provider;
  sku: string;
  hours: number;
  priceHourly: number | null;
  currency: string;
  priceSource: string | null;
  saving: number | null;
  intervals: number;
}

export class CloudAutoscale {
  /** The provider call; tests replace it with a fake. */
  scaler: NodeScaler = new ProviderScaler();
  private schema: { ok: boolean; at: number } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly s: () => Services) {}

  async installed(): Promise<boolean> {
    const t = Date.now();
    if (this.schema && (this.schema.ok || t - this.schema.at < RECHECK_MS)) return this.schema.ok;
    let ok = true;
    try {
      for (const name of AUTOSCALE_TABLES) if (!(await this.s().db.schema.hasTable(name))) ok = false;
    } catch {
      ok = false;
    }
    this.schema = { ok, at: t };
    return ok;
  }

  resetSchemaCache(): void {
    this.schema = null;
  }

  async need(): Promise<void> {
    if (!(await this.installed())) throw autoscaleMissing();
  }

  private get db() {
    return this.s().db;
  }

  /** Sets the gateway hooks; the tick runs every 30 s on this server (`index.ts`). */
  attach(): void {
    const g = this.s().gateway;
    g.cloudHooks = { coldStart: (pools, model, label) => this.coldStart(pools, model, label) };
  }

  start(): void {
    if (this.timer) return;
    this.attach();
    const run = () => void this.tick().catch((err: Error) => this.s().log.warn({ err: err.message }, 'autoscale tick failed'));
    this.timer = setInterval(run, TICK_MS);
    this.timer.unref();
    run();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---------- policies ----------

  async policy(poolId: string): Promise<ScalePolicy | null> {
    if (!(await this.installed())) return null;
    const r = await this.db('cloud_scale_policies').where({ pool_id: poolId }).first();
    return r ? policyFrom(r as Record<string, unknown>) : null;
  }

  async policies(): Promise<ScalePolicy[]> {
    if (!(await this.installed())) return [];
    return ((await this.db('cloud_scale_policies').select()) as Record<string, unknown>[]).map(policyFrom);
  }

  /** The node group a pool runs on, or null (an on-prem pool, or no link and no key on the policy). */
  async target(poolId: string, p?: ScalePolicy | null): Promise<ScaleTarget | null> {
    const s = this.s();
    const policy = p === undefined ? await this.policy(poolId) : p;
    const link = (await s.cloud.gpuPools?.linkFor(poolId).catch(() => null)) ?? null;
    const deploymentId = link?.deploymentId ?? policy?.deploymentId ?? null;
    const key = link?.resourceKey ?? policy?.resourceKey ?? null;
    if (!deploymentId || !key) return null;
    const d = await s.cloud.deployments.get(deploymentId).catch(() => null);
    if (!d) return null;
    const row = await s.cloud.deployments.resource(d.id, key).catch(() => null);
    const spec = (row?.desired.spec ?? {}) as Record<string, unknown>;
    return {
      poolId,
      link,
      deploymentId: d.id,
      accountId: d.accountId,
      tenantId: link?.tenantId ?? d.tenantId,
      provider: d.provider,
      region: row?.region ?? d.region,
      resourceKey: key,
      size: link?.instanceType ?? String(spec.size ?? ''),
      groupMin: link?.min ?? Number(spec.min ?? 0),
      groupMax: link?.max ?? Number(spec.max ?? policy?.max ?? 1)
    };
  }

  /** Creates or changes a pool's scale policy (Pools card: size controls, idle timer, spot), audited. */
  async setPolicy(a: CloudActor, poolId: string, input: z.infer<typeof policySchema>): Promise<ScalePolicy> {
    await this.need();
    const s = this.s();
    const pool = await s.gateway.repo.pool(poolId);
    if (!pool) throw notFound('Pool');
    const before = await this.policy(poolId);
    const link = (await s.cloud.gpuPools?.linkFor(poolId).catch(() => null)) ?? null;
    if (!link && !(input.deploymentId && input.resourceKey) && !(before?.deploymentId && before.resourceKey)) throw new HttpProblem(422, 'Not a cloud pool', `${pool.name} has no cloud GPU node group: link it from a deployment's GPU pool, or name the deployment and its node group.`, { extensions: { reason: 'not_cloud' } });
    if (link && input.max > link.max) throw new HttpProblem(422, 'Out of range', `The node group allows at most ${link.max} nodes (its deployment spec); raise it there first.`, { extensions: { reason: 'out_of_range' } });
    const draft: ScalePolicy = { ...(before ?? ({} as ScalePolicy)), poolId, deploymentId: input.deploymentId ?? before?.deploymentId ?? null, resourceKey: input.resourceKey ?? before?.resourceKey ?? null } as ScalePolicy;
    const t = await this.target(poolId, draft);
    if (!t) throw new HttpProblem(422, 'Not a cloud pool', 'The deployment or its node group was not found.', { extensions: { reason: 'not_cloud' } });
    if (input.capacity === 'spot' && t.provider === 'digitalocean') throw new HttpProblem(422, 'Not offered', 'DigitalOcean offers on-demand GPU capacity only; spot is not available there.', { extensions: { reason: 'spot_unavailable' } });
    if (input.capacity === 'spot' && t.provider === 'cloudflare') throw new HttpProblem(422, 'Not offered', 'Cloudflare runs no GPU pools.', { extensions: { reason: 'spot_unavailable' } });
    const now = Date.now();
    const desired = Math.min(input.max, Math.max(input.min, before?.desired ?? link?.desired ?? input.min));
    const row = {
      pool_id: poolId,
      deployment_id: draft.deploymentId,
      resource_key: draft.resourceKey,
      min: input.min,
      max: input.max,
      desired,
      idle_minutes: input.idleMinutes,
      queue_depth: input.queueDepth,
      max_cold_wait_ms: input.maxColdWaitMinutes * 60_000,
      capacity: input.capacity,
      on_demand_fallback: input.onDemandFallback,
      capacity_now: before && before.capacity === input.capacity ? before.capacityNow : input.capacity,
      updated_by: a.principal.userId,
      updated_at: now
    };
    if (before) await this.db('cloud_scale_policies').where({ pool_id: poolId }).update(row);
    else await this.db('cloud_scale_policies').insert({ ...row, last_lease_at: null, scaled_at: null, created_at: now });
    s.gateway.cloudPools.add(poolId);
    await cloudAudit(s, {
      tenantId: a.principal.tenantId,
      action: before ? 'cloud.pool.autoscale.updated' : 'cloud.pool.autoscale.set',
      actor: auditActor(a),
      deploymentId: t.deploymentId,
      resource: { key: t.resourceKey, type: 'node_group' },
      detail: { pool: poolId, name: pool.name, min: input.min, max: input.max, idleMinutes: input.idleMinutes, queueDepth: input.queueDepth, capacity: input.capacity, onDemandFallback: input.onDemandFallback, ...(before ? { before: { min: before.min, max: before.max, idleMinutes: before.idleMinutes, capacity: before.capacity } } : {}) }
    });
    const p = (await this.policy(poolId))!;
    // A desired size outside the new range moves into it now (a lower max scales down at once).
    if (before && before.desired !== desired) await this.apply(a, p, before.desired, desired, 'manual').catch(() => undefined);
    return (await this.policy(poolId))!;
  }

  /** The policy of a linked pool, made with the link's limits and the defaults when it has none yet. */
  async ensurePolicy(link: GpuPoolLink): Promise<ScalePolicy> {
    await this.need();
    if (!link.gatewayPoolId) throw conflict(`The GPU pool ${link.poolName} has no gateway pool yet.`);
    const have = await this.policy(link.gatewayPoolId);
    if (have) return have;
    const now = Date.now();
    await this.db('cloud_scale_policies')
      .insert({ pool_id: link.gatewayPoolId, deployment_id: link.deploymentId, resource_key: link.resourceKey, min: link.min, max: link.max, desired: Math.min(link.max, Math.max(link.min, link.desired ?? link.min)), capacity: 'on_demand', capacity_now: 'on_demand', on_demand_fallback: true, created_at: now, updated_at: now })
      .catch(() => undefined);
    this.s().gateway.cloudPools.add(link.gatewayPoolId);
    return (await this.policy(link.gatewayPoolId))!;
  }

  /** `s.cloud.gpuPools.setDesired`: a link's size, by a person (refusals as problems) or a service. */
  async scaleLink(a: Actor, link: GpuPoolLink, desired: number): Promise<ScaleResult> {
    const p = await this.ensurePolicy(link);
    if ('principal' in a) return this.scaleTo(a, p.poolId, desired);
    return this.scale(a, p.poolId, desired, 'manual');
  }

  // ---------- scaling ----------

  /** A person's scale from Pools: within min and max, refused past the hard stop (409 budget_exceeded), audited. */
  async scaleTo(a: CloudActor, poolId: string, desired: number, note?: string): Promise<ScaleResult> {
    await this.need();
    const p = await this.policy(poolId);
    if (!p) throw new HttpProblem(409, 'Conflict', 'This pool has no autoscale policy; set one first.', { extensions: { reason: 'no_policy' } });
    if (desired < p.min || desired > p.max) throw new HttpProblem(422, 'Out of range', `The desired size must be between ${p.min} and ${p.max}.`, { extensions: { reason: 'out_of_range' } });
    const r = await this.scale(a, poolId, desired, 'manual', note);
    if (r.outcome === 'refused') throw new HttpProblem(409, 'Budget exceeded', r.message, { extensions: { reason: 'budget_exceeded' } });
    if (r.outcome === 'failed') throw new HttpProblem(502, 'Provider error', r.message, { extensions: { reason: 'provider_failed' } });
    return r;
  }

  /** One scale decision, serialised per pool across this server. */
  async scale(a: Actor, poolId: string, to: number, reason: ScaleReason, note?: string): Promise<ScaleResult> {
    const prev = this.locks.get(poolId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(async () => {
      const p = await this.policy(poolId);
      if (!p) return { outcome: 'unchanged', from: 0, to, capacity: 'on_demand', message: 'No policy.' } as ScaleResult;
      const want = Math.min(p.max, Math.max(p.min, to));
      return this.apply(a, p, p.desired, want, reason, note);
    });
    this.locks.set(poolId, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(poolId) === run) this.locks.delete(poolId);
    }
  }

  private async apply(a: Actor, p: ScalePolicy, from: number, to: number, reason: ScaleReason, note?: string): Promise<ScaleResult> {
    const s = this.s();
    const now = Date.now();
    if (from === to) return { outcome: 'unchanged', from, to, capacity: p.capacityNow, message: `Already at ${to} nodes.` };
    const t = await this.target(p.poolId, p);
    const event = async (outcome: ScaleResult['outcome'], capacity: Capacity, detail: string | null) => {
      await this.db('cloud_scale_events').insert({ id: ulid(), pool_id: p.poolId, from_size: from, to_size: to, reason, outcome, capacity, actor: actorName(a).slice(0, 100), detail: detail?.slice(0, 2000) ?? null, requested_at: now, healthy_at: null });
    };
    const audit = (action: `cloud.${string}`, detail: Record<string, unknown>, requestId?: string | null) =>
      cloudAudit(s, {
        tenantId: 'principal' in a ? a.principal.tenantId : (t?.tenantId ?? ''),
        action,
        actor: auditActor(a),
        deploymentId: t?.deploymentId ?? null,
        resource: t ? { key: t.resourceKey, type: 'node_group' } : null,
        ...(requestId ? { providerRequestId: requestId } : {}),
        detail: { pool: p.poolId, from, to, reason, ...(note ? { note } : {}), ...detail }
      }).catch((err: Error) => s.log.warn({ err: err.message }, 'autoscale audit failed'));
    if (!t) {
      await event('failed', p.capacityNow, 'The pool has no node group.');
      return { outcome: 'failed', from, to, capacity: p.capacityNow, message: 'The pool has no node group.' };
    }
    if (to > from) {
      const decision = await s.cloud.budgets.decideScale(t.accountId, { key: t.resourceKey, from, to, min: p.min, max: p.max }).catch(() => null);
      if (decision?.refused) {
        await event('refused', p.capacityNow, decision.message);
        await audit('cloud.pool.scale.refused', { budget: decision.status });
        autoscaleMetrics(s.metrics.registry).scale('up', reason, 'refused');
        return { outcome: 'refused', from, to, capacity: p.capacityNow, message: decision.message };
      }
    }
    // A spot pool: `desired − odNodes` run on the spot group, `odNodes` on its on-demand sibling (`<key>-od`). A
    // scale-up grows the spot group, or the sibling when spot capacity runs out (or the pool is falling back); a
    // scale-down shrinks the sibling first, and the pool returns to spot once the sibling is empty.
    let capacity: Capacity = p.capacity === 'spot' ? p.capacityNow : 'on_demand';
    let od = p.capacity === 'spot' ? p.odNodes : 0;
    const odKey = `${t.resourceKey}-od`;
    let requestId: string | null = null;
    try {
      if (p.capacity !== 'spot') requestId = (await this.scaler.setDesired(s, t, t.resourceKey, to)).requestId;
      else if (to > from) {
        const grow = async () => {
          od += to - from;
          capacity = 'on_demand';
          requestId = (await this.scaler.setDesired(s, t, odKey, od)).requestId;
        };
        if (capacity === 'on_demand') await grow();
        else {
          try {
            requestId = (await this.scaler.setDesired(s, t, t.resourceKey, to - od)).requestId;
          } catch (err) {
            if (!(p.onDemandFallback && isCapacityError(err))) throw err;
            s.log.warn({ pool: p.poolId, err: (err as Error).message }, 'no spot capacity; the on-demand node group grows instead');
            await grow();
            await audit('cloud.pool.capacity.fallback', { capacity: 'on_demand', error: (err as Error).message.slice(0, 300) }, requestId);
          }
        }
      } else {
        const cut = Math.min(od, from - to);
        if (cut > 0) requestId = (await this.scaler.setDesired(s, t, odKey, od - cut)).requestId;
        od -= cut;
        if (from - to - cut > 0) requestId = (await this.scaler.setDesired(s, t, t.resourceKey, to - od)).requestId;
        if (od === 0) capacity = 'spot';
      }
    } catch (err) {
      const msg = (err as Error).message.slice(0, 500);
      await event('failed', capacity, msg);
      await audit('cloud.pool.scale.failed', { error: msg }, err instanceof CloudProviderError ? err.requestId : null);
      autoscaleMetrics(s.metrics.registry).scale(to > from ? 'up' : 'down', reason, 'failed');
      return { outcome: 'failed', from, to, capacity, message: msg };
    }
    await this.db('cloud_scale_policies').where({ pool_id: p.poolId }).update({ desired: to, capacity_now: capacity, od_nodes: od, scaled_at: now, updated_at: now });
    if (t.link) await this.db('cloud_gpu_pool_links').where({ id: t.link.id }).update({ desired_nodes: to, updated_at: now }).catch(() => undefined);
    await event('applied', capacity, note ?? null);
    // The savings ledger: an idle scale-down opens an interval; any scale-up closes the open ones.
    if (to > from) await this.db('cloud_gpu_savings').where({ pool_id: p.poolId }).whereNull('to_at').update({ to_at: now });
    else if (reason === 'idle' || reason === 'manual') await this.db('cloud_gpu_savings').insert({ id: ulid(), pool_id: p.poolId, provider: t.provider, region: t.region, sku: nodeSku(t.provider, t.size).slice(0, 120), nodes: from - to, from_at: now, to_at: null });
    await audit('cloud.pool.scaled', { capacity }, requestId);
    autoscaleMetrics(s.metrics.registry).scale(to > from ? 'up' : 'down', reason, 'applied');
    return { outcome: 'applied', from, to, capacity, message: `Scaled from ${from} to ${to} nodes.` };
  }

  // ---------- cold starts ----------

  /** The cold-start estimate: the median of the pool's recorded boot-to-healthy timings (the last ten). */
  async estimateMs(poolId: string): Promise<{ ms: number; samples: number; source: 'boot_timings' | 'scale_events' | 'default' }> {
    const s = this.s();
    const link = (await s.cloud.gpuPools?.linkFor(poolId).catch(() => null)) ?? null;
    if (link) {
      try {
        const rows = (await this.db('cloud_gpu_boot_timings').where({ link_id: link.id }).whereNotNull('seconds').orderBy('booted_at', 'desc').limit(10).select('seconds')) as { seconds: number }[];
        const m = median(rows.map((r) => Number(r.seconds) * 1000));
        if (m != null) return { ms: m, samples: rows.length, source: 'boot_timings' };
      } catch {
        /* migration 157 missing */
      }
    }
    const ev = (await this.db('cloud_scale_events').where({ pool_id: poolId, outcome: 'applied', from_size: 0 }).whereNotNull('healthy_at').orderBy('requested_at', 'desc').limit(10).select('requested_at', 'healthy_at')) as { requested_at: number; healthy_at: number }[];
    const m = median(ev.map((r) => Number(r.healthy_at) - Number(r.requested_at)));
    if (m != null) return { ms: m, samples: ev.length, source: 'scale_events' };
    return { ms: DEFAULT_COLD_START_MS, samples: 0, source: 'default' };
  }

  /** The gateway's question for a pool with no instance (see `Gateway.awaitCold`). */
  async coldStart(pools: PoolRow[], _model: ModelRow, _label: Label): Promise<ColdStart | null> {
    if (!(await this.installed())) return null;
    let refused: ColdStart | null = null;
    for (const pool of pools) {
      const p = await this.policy(pool.id);
      if (!p || p.max < 1) continue;
      const est = await this.estimateMs(pool.id);
      const pending = (await this.db('cloud_scale_events').where({ pool_id: pool.id, outcome: 'applied' }).whereRaw('to_size > from_size').whereNull('healthy_at').orderBy('requested_at', 'desc').first()) as { requested_at: number } | undefined;
      if (p.desired >= 1 && pending && Date.now() - Number(pending.requested_at) < Math.max(est.ms * 3, p.maxColdWaitMs)) {
        return { poolId: pool.id, estimateMs: Math.max(5_000, est.ms - (Date.now() - Number(pending.requested_at))), maxWaitMs: p.maxColdWaitMs };
      }
      const r = await this.scale(SYSTEM, pool.id, Math.max(1, p.min, p.desired >= 1 ? p.desired : 1), 'cold');
      if (r.outcome === 'refused' || r.outcome === 'failed') {
        refused ??= { poolId: pool.id, estimateMs: est.ms, maxWaitMs: p.maxColdWaitMs, refused: r.message };
        continue;
      }
      if (r.outcome === 'unchanged' && p.desired >= 1) {
        // Nodes are asked for but none answers: wait for them as for a fresh start.
        return { poolId: pool.id, estimateMs: est.ms, maxWaitMs: p.maxColdWaitMs };
      }
      return { poolId: pool.id, estimateMs: est.ms, maxWaitMs: p.maxColdWaitMs };
    }
    return refused;
  }

  // ---------- the tick ----------

  /** One round: shared lease times, healthy scale-ups, scale-up on queue depth, scale-down after the idle minutes. */
  async tick(now = Date.now()): Promise<{ up: string[]; down: string[] }> {
    const out = { up: [] as string[], down: [] as string[] };
    if (!(await this.installed())) return out;
    const s = this.s();
    const acts = new Map<string, PoolActivity>(s.gateway.poolActivity().map((a) => [a.poolId, a]));
    for (const p of await this.policies()) {
      s.gateway.cloudPools.add(p.poolId);
      const act = acts.get(p.poolId);
      const busy = !!act && (act.inflight > 0 || act.queued > 0 || act.coldWaiting > 0);
      const local = busy ? now : (act?.lastLeaseAt ?? null);
      const last = Math.max(local ?? 0, p.lastLeaseAt ?? 0) || null;
      if (last && last !== p.lastLeaseAt) await this.db('cloud_scale_policies').where({ pool_id: p.poolId }).where((q) => q.whereNull('last_lease_at').orWhere('last_lease_at', '<', last)).update({ last_lease_at: last });
      if (act && act.healthy > 0) await this.db('cloud_scale_events').where({ pool_id: p.poolId, outcome: 'applied' }).whereRaw('to_size > from_size').whereNull('healthy_at').update({ healthy_at: now });
      const waiting = (act?.queued ?? 0) + (act?.coldWaiting ?? 0);
      if (waiting > 0 && p.desired < p.max && waiting >= p.queueDepth * Math.max(1, p.desired)) {
        const booting = await this.db('cloud_scale_events').where({ pool_id: p.poolId, outcome: 'applied' }).whereRaw('to_size > from_size').whereNull('healthy_at').where('requested_at', '>', now - p.maxColdWaitMs).first();
        if (!booting) {
          const r = await this.scale(SYSTEM, p.poolId, p.desired + 1, 'queue');
          if (r.outcome === 'applied') out.up.push(p.poolId);
        }
        continue;
      }
      if (!busy && p.desired > p.min) {
        const since = Math.max(last ?? 0, p.scaledAt ?? 0);
        if (now - since >= p.idleMinutes * 60_000) {
          const r = await this.scale(SYSTEM, p.poolId, p.min, 'idle');
          if (r.outcome === 'applied') out.down.push(p.poolId);
        }
      }
    }
    await this.settleInterruptions(now);
    return out;
  }

  // ---------- spot interruptions ----------

  /** The instance whose node certificate a request presents (the node-side watcher's mTLS channel), or null. */
  async instanceForCertificate(cert: X509Certificate | string): Promise<string | null> {
    const fp = typeof cert === 'string' ? cert.replace(/:/g, '').toLowerCase() : createHash('sha256').update(cert.raw).digest('hex');
    if (!/^[0-9a-f]{64}$/.test(fp)) return null;
    try {
      const c = (await this.db('pki_certificates').where({ fingerprint: fp }).first('id', 'state', 'not_after')) as { id: string; state: string; not_after: number } | undefined;
      if (!c || c.state !== 'valid' || Number(c.not_after) < Date.now()) return null;
      // Only a certificate issued at enrolment to a node of the pool its instance is in (not the gateway's, not another pool's).
      const e = (await this.db('cloud_gpu_enrolments as e').join('cloud_gpu_pool_links as l', 'l.id', 'e.link_id').join('instances as i', 'i.id', 'e.instance_id').where('e.certificate_id', c.id).whereRaw('i.pool_id = l.gateway_pool_id').first('e.instance_id')) as { instance_id: string } | undefined;
      return e?.instance_id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * An interruption notice from a node: recorded once, then the instance is drained through the gateway before the
   * provider reclaims it (running leases finish until `MOVE_MARGIN_MS` before; the rest are moved). For the EC2
   * two-minute notice and Azure `Preempt`, the pool asks for a replacement node (spot, or on-demand when the pool
   * falls back), under the budget's hard stop. The rebalance recommendation drains without a deadline.
   */
  async interruption(instanceId: string, input: z.infer<typeof noticeSchema>, opts: { now?: number; wait?: boolean } = {}): Promise<{ id: string; duplicate: boolean; state: string; running: number; finished: number; moved: number; deadlineAt: number | null }> {
    await this.need();
    const now = opts.now ?? Date.now();
    const s = this.s();
    const inst = await s.gateway.repo.instance(instanceId);
    if (!inst) throw notFound('Instance');
    const p = await this.policy(inst.pool_id);
    const t = p ? await this.target(inst.pool_id, p) : null;
    if (!p || !t) throw new HttpProblem(409, 'Conflict', `${inst.name} is not in a cloud GPU pool with an autoscale policy.`, { extensions: { reason: 'not_cloud' } });
    const wantProvider = input.kind === 'azure_preempt' ? 'azure' : 'aws';
    if (t.provider !== wantProvider) throw new HttpProblem(422, 'Wrong provider', t.provider === 'digitalocean' ? 'DigitalOcean offers on-demand capacity only and sends no interruption notices.' : `A ${input.kind} notice cannot come from a ${t.provider} node.`, { extensions: { reason: 'wrong_provider' } });
    const reclaim = input.reclaimAt == null ? null : typeof input.reclaimAt === 'number' ? input.reclaimAt : Date.parse(input.reclaimAt);
    // The EC2 notice comes two minutes ahead; Azure Preempt at least 30 s ahead (NotBefore).
    const reclaimAt = input.kind === 'ec2_rebalance' ? null : (reclaim ?? now + (input.kind === 'ec2_interruption' ? 120_000 : 30_000));
    const eventKey = (input.eventId ?? (reclaimAt ? String(reclaimAt) : `${input.kind}-${Math.floor(now / 600_000)}`)).slice(0, 100);
    const existing = (await this.db('cloud_interruptions').where({ instance_id: instanceId, kind: input.kind, event_key: eventKey }).first()) as Record<string, unknown> | undefined;
    if (existing) return { id: String(existing.id), duplicate: true, state: String(existing.state), running: 0, finished: Number(existing.finished), moved: Number(existing.moved), deadlineAt: reclaimAt ? reclaimAt - MOVE_MARGIN_MS : null };
    // B-10803: the event key is the node's to choose, so a node cannot ask for a replacement again and again with new
    // keys: while one reclaim notice for the instance is open (draining or drained), a further one is the same event
    // (a rebalance recommendation is followed by the real notice, never the other way round).
    let open = this.db('cloud_interruptions').where({ instance_id: instanceId }).whereIn('state', ['draining', 'drained']);
    if (input.kind !== 'ec2_rebalance') open = open.whereNot({ kind: 'ec2_rebalance' });
    const already = (await open.orderBy('notice_at', 'desc').first()) as Record<string, unknown> | undefined;
    if (already) return { id: String(already.id), duplicate: true, state: String(already.state), running: 0, finished: Number(already.finished), moved: Number(already.moved), deadlineAt: already.reclaim_at == null ? null : Number(already.reclaim_at) - MOVE_MARGIN_MS };
    const id = ulid();
    await this.db('cloud_interruptions').insert({ id, pool_id: inst.pool_id, instance_id: instanceId, provider: t.provider, kind: input.kind, event_key: eventKey, notice_at: now, reclaim_at: reclaimAt, drained_at: null, finished: 0, moved: 0, state: 'draining', detail: input.detail ?? null });
    autoscaleMetrics(s.metrics.registry).interruption(t.provider, input.kind);
    await cloudAudit(s, { tenantId: t.tenantId, action: 'cloud.pool.interruption', actor: { service: 'node-watcher' }, deploymentId: t.deploymentId, resource: { key: t.resourceKey, type: 'node_group' }, detail: { pool: inst.pool_id, instance: instanceId, name: inst.name, kind: input.kind, reclaimAt } }).catch(() => undefined);
    // A replacement node for a reclaimed one, asked for at once so it boots while this one drains.
    if (input.kind !== 'ec2_rebalance') {
      // A spot pool that falls back gets its replacement on demand; the provider replaces the reclaimed spot node
      // itself, and the extra node goes with the next idle scale-down.
      if (p.capacity === 'spot' && p.onDemandFallback) await this.db('cloud_scale_policies').where({ pool_id: p.poolId }).update({ capacity_now: 'on_demand' });
      if (p.desired < p.max) void this.scale(SYSTEM, p.poolId, p.desired + 1, p.capacity === 'spot' && p.onDemandFallback ? 'fallback' : 'interruption').catch(() => undefined);
    }
    const deadlineAt = reclaimAt ? reclaimAt - MOVE_MARGIN_MS : null;
    const drain = this.drain(id, inst.pool_id, instanceId, input.kind, t, reclaimAt, deadlineAt);
    if (opts.wait === false) {
      // The node's watcher gets its answer at once; the drain goes on here (the instance is already marked draining).
      void drain.catch((err: Error) => s.log.warn({ instance: instanceId, err: err.message }, 'interruption drain failed'));
      await s.gateway.repo.updateInstance(instanceId, { state: 'draining' });
      return { id, duplicate: false, state: 'draining', running: 0, finished: 0, moved: 0, deadlineAt };
    }
    const drained = await drain;
    return { id, duplicate: false, state: 'drained', ...drained, deadlineAt };
  }

  private async drain(id: string, poolId: string, instanceId: string, kind: InterruptionKind, t: ScaleTarget, reclaimAt: number | null, deadlineAt: number | null): Promise<{ running: number; finished: number; moved: number }> {
    const s = this.s();
    const drained = await s.gateway.preempt(instanceId, deadlineAt);
    await this.db('cloud_interruptions').where({ id }).update({ state: 'drained', drained_at: Date.now(), finished: drained.finished, moved: drained.moved });
    await cloudAudit(s, { tenantId: t.tenantId, action: 'cloud.pool.drained', actor: { service: 'node-watcher' }, deploymentId: t.deploymentId, resource: { key: t.resourceKey, type: 'node_group' }, detail: { pool: poolId, instance: instanceId, kind, ...drained, beforeReclaim: reclaimAt ? Date.now() < reclaimAt : null } }).catch(() => undefined);
    return drained;
  }

  /** Drained instances past their reclaim time, or gone, are marked reclaimed. */
  private async settleInterruptions(now: number): Promise<void> {
    const rows = (await this.db('cloud_interruptions').where({ state: 'drained' }).select('id', 'instance_id', 'reclaim_at')) as { id: string; instance_id: string; reclaim_at: number | null }[];
    for (const r of rows) {
      const inst = await this.s().gateway.repo.instance(r.instance_id);
      if (!inst || (r.reclaim_at != null && now > Number(r.reclaim_at))) await this.db('cloud_interruptions').where({ id: r.id }).update({ state: 'reclaimed' });
    }
  }

  async interruptions(poolId: string, limit = 10): Promise<Record<string, unknown>[]> {
    if (!(await this.installed())) return [];
    const rows = (await this.db('cloud_interruptions').where({ pool_id: poolId }).orderBy('notice_at', 'desc').limit(limit)) as Record<string, unknown>[];
    return rows.map((r) => ({ id: r.id, instanceId: r.instance_id, provider: r.provider, kind: r.kind, noticeAt: Number(r.notice_at), reclaimAt: r.reclaim_at == null ? null : Number(r.reclaim_at), drainedAt: r.drained_at == null ? null : Number(r.drained_at), finished: Number(r.finished), moved: Number(r.moved), state: r.state }));
  }

  // ---------- savings (B-10605) ----------

  /** The pool's on-demand hourly price: the GPU pools link's, else the price catalogue's (cache and sheet only). */
  async onDemandPrice(t: ScaleTarget): Promise<{ price: number | null; currency: string; source: string | null }> {
    if (t.link?.priceHourly != null) return { price: t.link.priceHourly, currency: t.link.currency ?? 'USD', source: 'gpu_pool_link' };
    const s = this.s();
    const p = await s.cloud.prices?.lookup(t.provider, t.region, nodeSku(t.provider, t.size), 'hour', { account: null, currency: 'USD', fetch: false }).catch(() => null);
    return p ? { price: p.price, currency: p.currency, source: p.source } : { price: null, currency: 'USD', source: null };
  }

  /** Scaled-down node-hours in a month (UTC) per pool, and their estimated saving at the on-demand price. */
  async savings(month = monthOfTs(Date.now()), opts: { poolId?: string; now?: number } = {}): Promise<PoolSavings[]> {
    if (!(await this.installed())) return [];
    const now = opts.now ?? Date.now();
    const [start, end] = monthBounds(month);
    const q = this.db('cloud_gpu_savings').where('from_at', '<', end).where((w) => w.whereNull('to_at').orWhere('to_at', '>', start));
    if (opts.poolId) q.where({ pool_id: opts.poolId });
    const rows = (await q.select()) as { pool_id: string; provider: string; sku: string; nodes: number; from_at: number; to_at: number | null }[];
    const by = new Map<string, { provider: Provider; sku: string; hours: number; intervals: number }>();
    for (const r of rows) {
      const from = Math.max(start, Number(r.from_at));
      const to = Math.min(end, r.to_at == null ? now : Number(r.to_at), now);
      if (to <= from) continue;
      const e = by.get(r.pool_id) ?? { provider: r.provider as Provider, sku: r.sku, hours: 0, intervals: 0 };
      e.hours += (Number(r.nodes) * (to - from)) / 3_600_000;
      e.intervals++;
      by.set(r.pool_id, e);
    }
    const out: PoolSavings[] = [];
    for (const [poolId, e] of by) {
      const t = await this.target(poolId);
      const price = t ? await this.onDemandPrice(t) : { price: null, currency: 'USD', source: null };
      const hours = Math.round(e.hours * 1000) / 1000;
      out.push({ poolId, month, provider: e.provider, sku: e.sku, hours, priceHourly: price.price, currency: price.currency, priceSource: price.source, saving: price.price == null ? null : Math.round(hours * price.price * 100) / 100, intervals: e.intervals });
    }
    return out.sort((a, b) => a.poolId.localeCompare(b.poolId));
  }

  // ---------- the Pools card ----------

  /** What the Pools screen's cloud node group card shows for a pool (null: not a cloud pool). */
  async card(poolId: string): Promise<Record<string, unknown> | null> {
    if (!(await this.installed())) return null;
    const p = await this.policy(poolId);
    const link = (await this.s().cloud.gpuPools?.linkFor(poolId).catch(() => null)) ?? null;
    if (!p && !link) return null;
    const t = await this.target(poolId, p);
    const price = t ? await this.onDemandPrice(t) : { price: null, currency: 'USD', source: null };
    const act = this.s().gateway.poolActivity().find((a) => a.poolId === poolId);
    const busy = !!act && (act.inflight > 0 || act.queued > 0 || act.coldWaiting > 0);
    const desired = p?.desired ?? link?.desired ?? 0;
    const since = Math.max(p?.lastLeaseAt ?? 0, act?.lastLeaseAt ?? 0, p?.scaledAt ?? 0);
    const idleEndsAt = p && !busy && desired > p.min ? since + p.idleMinutes * 60_000 : null;
    const events = ((await this.db('cloud_scale_events').where({ pool_id: poolId }).orderBy('requested_at', 'desc').limit(8)) as Record<string, unknown>[]).map((e) => ({ from: Number(e.from_size), to: Number(e.to_size), reason: e.reason, outcome: e.outcome, capacity: e.capacity, actor: e.actor, detail: e.detail, at: Number(e.requested_at), healthyAt: e.healthy_at == null ? null : Number(e.healthy_at) }));
    const est = await this.estimateMs(poolId);
    const [saved] = await this.savings(monthOfTs(Date.now()), { poolId });
    return {
      poolId,
      policy: p,
      link: link ? { id: link.id, deploymentId: link.deploymentId, provider: link.provider, poolName: link.poolName, instanceType: link.instanceType, min: link.min, max: link.max, state: link.state } : null,
      provider: t?.provider ?? link?.provider ?? null,
      region: t?.region ?? null,
      size: t?.size ?? null,
      deploymentId: t?.deploymentId ?? null,
      resourceKey: t?.resourceKey ?? null,
      desired,
      healthy: act?.healthy ?? 0,
      inflight: act?.inflight ?? 0,
      queued: (act?.queued ?? 0) + (act?.coldWaiting ?? 0),
      priceHourly: price.price,
      currency: price.currency,
      costPerHour: price.price == null ? null : Math.round(price.price * desired * 10000) / 10000,
      idle: { busy, lastLeaseAt: since || null, endsAt: idleEndsAt },
      spot: { capacity: p?.capacity ?? 'on_demand', now: p?.capacityNow ?? 'on_demand', fallback: p?.onDemandFallback ?? true, offered: (t?.provider ?? link?.provider) !== 'digitalocean' },
      coldStart: est,
      savings: saved ?? null,
      events,
      interruptions: await this.interruptions(poolId, 5)
    };
  }
}
