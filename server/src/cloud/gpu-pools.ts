import { json } from '../db/knex.js';
import { HttpProblem } from '../http/problem.js';
import type { Services } from '../services.js';
import type { CloudActor } from './accounts.js';
import { GpuPoolNodes } from './gpu-enrol.js';
import { GpuQuotas } from './gpu-quotas.js';
import type { Provider } from './types.js';

/*
 * 1.9.99-final, Sprint 60 (B-10401, B-10404, B-10405): cloud GPU node groups and GPU VMs as gateway pools,
 * `s.cloud.gpuPools`.
 *
 * The link: every GPU pool of a deployment spec (`spec.gpuPools[]`) is one row of `cloud_gpu_pool_links` (migration
 * 157), tying the graph resource that runs its nodes (an EKS managed node group, an AKS or DOKS GPU node pool, or the
 * pool's GPU VMs on EC2, Azure or DigitalOcean) to the gateway pool its nodes join. The link carries what the Pools
 * screen and the metrics need: the provider id, the instance type running now, min / max / desired nodes, the price
 * per node hour, the warm-up source, and the PKI profiles the nodes' certificates come from.
 *
 * For other modules (the scale-to-zero and autoscale work, B-10402, B-10406, builds on this):
 *   - `linkFor(poolId)`           the link of a gateway pool, or null (an on-prem pool has none)
 *   - `nodeGroupsFor(deploymentId)` the links of a deployment
 *   - `setDesired(actor, linkId, desired)` the size change hook; B-10402 implements it (here: 501 until then)
 *
 * Nothing here runs until someone plans a GPU node group: every reader answers empty without the migration, and the
 * apply follow-up returns at once for a deployment without GPU pools.
 */

export type GpuLinkKind = 'node_group' | 'vm';
export type GpuLinkState = 'pending' | 'active' | 'pki_missing' | 'removed';
export type WarmupSource = 'mirror' | 'snapshot';

export interface GpuWarmup {
  source: WarmupSource;
  /** A pre-seeded volume snapshot holding the models (`source: snapshot`). */
  snapshotId?: string | null;
  /** The model mirror's base URL the node pulls from (`source: mirror`), from Platform › Mirrors (kind `models`). */
  mirror?: string | null;
}

export interface GpuPoolLink {
  id: string;
  tenantId: string;
  deploymentId: string;
  provider: Provider;
  /** The spec's GPU pool name. */
  poolName: string;
  /** The graph key of the node group, or the key prefix of the pool's VMs (`gpu-<pool>-`). */
  resourceKey: string;
  kind: GpuLinkKind;
  /** The node group's provider id (null for VMs and until it exists). */
  providerId: string | null;
  /** The gateway pool its nodes join (made with the link). */
  gatewayPoolId: string | null;
  gpu: string;
  /** The instance type running now (after a capacity fallback, the one that had capacity). */
  instanceType: string;
  /** The allowed instance types in order of preference, and the allowed zones (B-10405's fallback). */
  instanceTypes: string[];
  zones: string[];
  min: number;
  max: number;
  /** The size asked for last (null: the node group's own, or the VM count rendered). */
  desired: number | null;
  /** Price per node hour, from the price catalogue (null when none is known). */
  priceHourly: number | null;
  currency: string | null;
  serverProfileId: string | null;
  clientProfileId: string | null;
  clientCertId: string | null;
  warmup: GpuWarmup;
  state: GpuLinkState;
  stateDetail: string | null;
  createdAt: number;
  updatedAt: number;
}

export const GPU_POOL_TABLES = ['cloud_gpu_pool_links', 'cloud_gpu_enrolments', 'cloud_gpu_boot_timings'] as const;

export const gpuPoolsMissing = () => new HttpProblem(503, 'Not installed', 'GPU pools need the database migration 157_cloud_gpu_pools, which has not been applied.', { extensions: { reason: 'migration_pending' } });

export function linkFrom(r: Record<string, unknown>): GpuPoolLink {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    deploymentId: String(r.deployment_id),
    provider: String(r.provider) as Provider,
    poolName: String(r.pool_name),
    resourceKey: String(r.resource_key),
    kind: String(r.kind) as GpuLinkKind,
    providerId: (r.provider_id as string | null) ?? null,
    gatewayPoolId: (r.gateway_pool_id as string | null) ?? null,
    gpu: String(r.gpu),
    instanceType: String(r.instance_type),
    instanceTypes: json<string[]>(r.instance_types, []),
    zones: json<string[]>(r.zones, []),
    min: Number(r.min_nodes),
    max: Number(r.max_nodes),
    desired: r.desired_nodes == null ? null : Number(r.desired_nodes),
    priceHourly: r.price_hourly == null ? null : Number(r.price_hourly),
    currency: (r.currency as string | null) ?? null,
    serverProfileId: (r.server_profile_id as string | null) ?? null,
    clientProfileId: (r.client_profile_id as string | null) ?? null,
    clientCertId: (r.client_cert_id as string | null) ?? null,
    warmup: json<GpuWarmup>(r.warmup, { source: 'mirror' }),
    state: String(r.state) as GpuLinkState,
    stateDetail: (r.state_detail as string | null) ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at)
  };
}

const RECHECK_MS = 30_000;

export class CloudGpuPools {
  private schemaState: { ok: boolean; at: number } | null = null;

  /** B-10401, B-10404: links, enrolment, the gateway's client identities, warm-up and boot timings (`cloud/gpu-enrol.ts`). */
  readonly nodes: GpuPoolNodes;
  /** B-10405: GPU quotas at plan time and the capacity fallback at apply (`cloud/gpu-quotas.ts`). */
  readonly quotas: GpuQuotas;

  constructor(protected readonly s: () => Services) {
    this.nodes = new GpuPoolNodes(s, this);
    this.quotas = new GpuQuotas(s);
  }

  // ---------- schema ----------

  async installed(): Promise<boolean> {
    const t = Date.now();
    if (this.schemaState && (this.schemaState.ok || t - this.schemaState.at < RECHECK_MS)) return this.schemaState.ok;
    let ok = true;
    try {
      for (const name of GPU_POOL_TABLES) if (!(await this.s().db.schema.hasTable(name))) ok = false;
    } catch {
      ok = false;
    }
    this.schemaState = { ok, at: t };
    return ok;
  }

  reset(): void {
    this.schemaState = null;
  }

  async need(): Promise<void> {
    if (!(await this.installed())) throw gpuPoolsMissing();
  }

  // ---------- the link (what B-10402 and the Pools card read) ----------

  async get(id: string): Promise<GpuPoolLink | null> {
    if (!(await this.installed())) return null;
    const r = await this.s().db('cloud_gpu_pool_links').where({ id }).first();
    return r ? linkFrom(r as Record<string, unknown>) : null;
  }

  /** The link of a gateway pool, or null (an on-prem pool, or no migration). */
  async linkFor(poolId: string): Promise<GpuPoolLink | null> {
    if (!(await this.installed())) return null;
    const r = await this.s().db('cloud_gpu_pool_links').where({ gateway_pool_id: poolId }).whereNot({ state: 'removed' }).first();
    return r ? linkFrom(r as Record<string, unknown>) : null;
  }

  /** Every GPU pool link of a deployment (node groups and VM pools), in pool-name order. */
  async nodeGroupsFor(deploymentId: string): Promise<GpuPoolLink[]> {
    if (!(await this.installed())) return [];
    return ((await this.s().db('cloud_gpu_pool_links').where({ deployment_id: deploymentId }).whereNot({ state: 'removed' }).orderBy('pool_name')) as Record<string, unknown>[]).map(linkFrom);
  }

  /** Every live link (the metrics and the reconcile job). */
  async all(): Promise<GpuPoolLink[]> {
    if (!(await this.installed())) return [];
    return ((await this.s().db('cloud_gpu_pool_links').whereNot({ state: 'removed' }).orderBy('created_at')) as Record<string, unknown>[]).map(linkFrom);
  }

  /**
   * B-10402 (scale-to-zero and autoscale) changes a node group's desired size through here: it plans and applies the
   * node group's new `count` within `min`..`max`, under the budget's hard stop, and records `desired` on the link.
   * Built by B-10402: the autoscaler (`cloud/autoscale.ts`, `scaleLink`) makes the provider call, journals and audits
   * it, and refuses a scale-up past the budget's hard stop (409 `budget_exceeded`).
   */
  async setDesired(actor: CloudActor | { service: string; onBehalfOf?: string | null }, linkId: string, desired: number): Promise<GpuPoolLink> {
    const link = await this.get(linkId);
    if (!link) throw new HttpProblem(404, 'Not found', 'GPU pool link not found.');
    if (!Number.isInteger(desired) || desired < link.min || desired > link.max) throw new HttpProblem(422, 'Out of range', `The desired size must be between ${link.min} and ${link.max}.`, { extensions: { reason: 'out_of_range' } });
    await this.s().cloud.autoscale.scaleLink(actor, link, desired);
    return (await this.get(linkId)) ?? link;
  }
}
