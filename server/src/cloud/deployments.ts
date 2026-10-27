import { ulid } from 'ulid';
import { z } from 'zod';
import { LABELS, type Label } from '../authz/labels.js';
import { authorize, type Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import type { CloudActor } from './accounts.js';
import { cloudAudit } from './audit.js';
import {
  hashOf,
  type DesiredResource,
  type Deployment,
  type DeploymentEndpoints,
  type DeploymentHealth,
  type DeploymentState,
  type GraphResource,
  type ObservedResource,
  type ResourceState
} from './graph.js';
import { CloudProviderError, type CallContext, type CloudProvider, type ResourceSpec } from './providers/types.js';
import { cloudTags } from './tags.js';
import type { CloudAccount, CredentialPurpose } from './types.js';
import { providerProblem } from './validate.js';
import { brokerFor } from './compute.js';

/*
 * 1.9.99-final, Sprint 57 (B-10102): `s.cloud.deployments`, the deployments and their resource graphs.
 *
 * - A deployment lives on one cloud account (its scope is the account's: a platform deployment is seen like a platform
 *   account and changed only by someone who also holds `platform:manage`).
 * - Its graph (`cloud_resources`) keeps, per resource key, the desired resource, the observed state and its hash, the
 *   provider id, dependencies, protection, tags and state. `refresh` reads every resource from the provider (through
 *   the adapters only) and stores what changed; any change bumps the deployment's `observedVersion`, which makes every
 *   plan made before it stale.
 * - The lease (`lease_holder`, `lease_until`) lets one apply at a time work on a deployment (B-10104).
 *
 * Needs migration 148_cloud_journal; until it is applied every read answers 503 `migration_pending`.
 */

const SCHEMA_RECHECK_MS = 30_000;
const TABLES = ['cloud_deployments', 'cloud_resources', 'cloud_plans', 'cloud_operations'] as const;

export const deploymentsMissing = () => new HttpProblem(503, 'Not installed', 'Cloud deployments need the database migration 148_cloud_journal, which has not been applied.', { extensions: { reason: 'migration_pending' } });
export const componentMissing = (what: string) => new HttpProblem(503, 'Not available', `${what} is not available in this build.`, { extensions: { reason: 'cloud_component_missing' } });

export const deploymentName = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/, 'lower case letters, digits and dashes, starting with a letter');

export const endpointsSchema = z
  .object({
    publicUrl: z.string().url().max(500).optional(),
    tlsName: z.string().max(253).optional(),
    app: z.boolean().optional(),
    redis: z.boolean().optional()
  })
  .strict();

export const createDeploymentSchema = z
  .object({
    name: deploymentName,
    accountId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an account id'),
    region: z.string().trim().min(1).max(40).optional(),
    label: z.enum(LABELS).optional(),
    description: z.string().trim().max(500).optional(),
    spec: z.record(z.string(), z.unknown()).optional(),
    endpoints: endpointsSchema.optional()
  })
  .strict();
export type CreateDeploymentInput = z.infer<typeof createDeploymentSchema>;

function deploymentFrom(r: Record<string, unknown>): Deployment {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    scope: r.scope === 'platform' ? 'platform' : 'tenant',
    accountId: String(r.account_id),
    provider: r.provider as Deployment['provider'],
    name: String(r.name),
    region: String(r.region),
    label: r.label as Label,
    description: (r.description as string | null) ?? null,
    state: r.state as DeploymentState,
    health: r.health as DeploymentHealth,
    spec: json<Record<string, unknown> | null>(r.spec, null),
    // Sprint 62 (B-10209): an on-prem install registered for its front door (`cloud/onprem.ts`).
    kind: json<Record<string, unknown> | null>(r.spec, null)?.kind === 'onprem' ? 'onprem' : 'cloud',
    endpoints: json<DeploymentEndpoints>(r.endpoints, {}),
    observedVersion: Number(r.observed_version ?? 0),
    currentPlanId: (r.current_plan_id as string | null) ?? null,
    verify: json(r.verify, null),
    lease: r.lease_holder ? { holder: String(r.lease_holder), until: Number(r.lease_until ?? 0) } : null,
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at)
  };
}

function resourceFrom(r: Record<string, unknown>): GraphResource {
  const desired = json<DesiredResource>(r.desired, { key: String(r.key), type: r.type as DesiredResource['type'], spec: {}, dependsOn: [], protect: false, region: null });
  return {
    id: String(r.id),
    deploymentId: String(r.deployment_id),
    key: String(r.key),
    type: r.type as GraphResource['type'],
    region: String(r.region),
    providerId: (r.provider_id as string | null) ?? null,
    locator: json<Record<string, string> | null>(r.locator, null),
    desired,
    observed: json<ObservedResource | null>(r.observed, null),
    observedHash: (r.observed_hash as string | null) ?? null,
    observedAt: r.observed_at == null ? null : Number(r.observed_at),
    dependsOn: json<string[]>(r.depends_on, []),
    protect: !!r.protect,
    tags: json<Record<string, string>>(r.tags, {}),
    state: r.state as ResourceState,
    createdByOperation: (r.created_op as string | null) ?? null,
    createdByAudit: (r.created_audit as string | null) ?? null,
    lastVerified: json(r.last_verified, null),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at)
  };
}

/**
 * The logical name the adapter derives the provider's name from: the resource's `name`, else `<deployment>-<key>`,
 * so two deployments on one account never share a name (the adapters' `find` looks resources up by it).
 */
export const providerName = (d: Pick<Deployment, 'name'>, r: Pick<DesiredResource, 'key' | 'name'>): string => r.name ?? `${d.name}-${r.key}`.slice(0, 63).replace(/-+$/, '');

/** The observed state's hash: what the planner and the stale check compare. */
export const observedHash = (o: ObservedResource | null): string => (o ? hashOf({ providerId: o.providerId, state: o.state, props: o.props, tags: o.tags, region: o.region ?? null }) : 'missing');

const stateOf = (o: ObservedResource | null): ResourceState => (o ? (o.state === 'ready' ? 'ready' : o.state) : 'missing');

/** What a refresh found: the observed state per graph resource, what `find` found for resources not created yet, and the digest a plan keeps. */
export interface Refresh {
  version: number;
  digest: string;
  observed: Map<string, ObservedResource | null>;
  found: Map<string, ObservedResource>;
  changed: string[];
}

/** A provider call context for a deployment: the account, a credential bought for the purpose, the adapter. */
export interface DeploymentContext {
  account: CloudAccount;
  provider: CloudProvider;
  cred: CallContext['cred'];
  ctx(region?: string, signal?: AbortSignal): CallContext;
}

export class CloudDeployments {
  private schema: { ok: boolean; at: number } | null = null;

  constructor(private readonly s: () => Services) {}

  async installed(): Promise<boolean> {
    const t = Date.now();
    if (this.schema && (this.schema.ok || t - this.schema.at < SCHEMA_RECHECK_MS)) return this.schema.ok;
    let ok = true;
    try {
      for (const name of TABLES) if (!(await this.s().db.schema.hasTable(name))) ok = false;
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
    if (!(await this.installed())) throw deploymentsMissing();
  }

  // ---------- who sees and changes what ----------

  isPlatformAdmin(p: Principal): boolean {
    return authorize(p, 'platform:manage').allow;
  }

  canSee(p: Principal, d: Pick<Deployment, 'scope' | 'tenantId'>): boolean {
    if (this.isPlatformAdmin(p)) return true;
    if (d.scope === 'platform') return p.tenantSlug === this.s().cfg.DEFAULT_TENANT || d.tenantId === p.tenantId;
    return d.tenantId === p.tenantId;
  }

  /** Changing a deployment (plans, apply, verify): `cloud:deploy` (checked by the route), and for a platform deployment `platform:manage`. */
  assertCanDeploy(p: Principal, d: Pick<Deployment, 'scope' | 'tenantId' | 'name'>): void {
    if (!authorize(p, 'cloud:deploy').allow) throw forbidden('Changing a deployment needs cloud:deploy.', { step: 'role', action: 'cloud:deploy' });
    if (d.scope === 'platform') {
      if (!this.isPlatformAdmin(p)) throw forbidden(`${d.name} is a platform deployment; changing it also needs platform:manage.`, { step: 'role', action: 'platform:manage' });
    } else if (d.tenantId !== p.tenantId) {
      throw forbidden('This deployment belongs to another tenant.', { step: 'tenant' });
    }
  }

  // ---------- reads ----------

  async get(id: string): Promise<Deployment | null> {
    await this.need();
    const r = await this.s().db('cloud_deployments').where({ id }).first();
    return r ? deploymentFrom(r as Record<string, unknown>) : null;
  }

  async getFor(p: Principal, id: string): Promise<Deployment> {
    const d = await this.get(id);
    if (!d || !this.canSee(p, d)) throw notFound('Deployment');
    return d;
  }

  async list(p: Principal, opts: { accountId?: string; state?: DeploymentState; kind?: 'cloud' | 'onprem' } = {}): Promise<Deployment[]> {
    await this.need();
    let q = this.s().db('cloud_deployments');
    if (opts.accountId) q = q.where({ account_id: opts.accountId });
    if (opts.state) q = q.where({ state: opts.state });
    const rows = (await q.orderBy('created_at', 'desc').limit(500)) as Record<string, unknown>[];
    return rows.map(deploymentFrom).filter((d) => this.canSee(p, d) && (!opts.kind || d.kind === opts.kind));
  }

  /** The graph's resources (without the deleted ones unless asked). */
  async resources(deploymentId: string, opts: { includeDeleted?: boolean } = {}): Promise<GraphResource[]> {
    await this.need();
    const rows = (await this.s().db('cloud_resources').where({ deployment_id: deploymentId }).orderBy('key', 'asc')) as Record<string, unknown>[];
    return rows.map(resourceFrom).filter((r) => opts.includeDeleted || r.state !== 'deleted');
  }

  async resource(deploymentId: string, key: string): Promise<GraphResource | null> {
    const r = await this.s().db('cloud_resources').where({ deployment_id: deploymentId, key }).first();
    return r ? resourceFrom(r as Record<string, unknown>) : null;
  }

  /** The desired graph as it stands (what a revert plans back to; the lifecycle work's drift and rollback use it). */
  async desiredGraph(deploymentId: string): Promise<DesiredResource[]> {
    return (await this.resources(deploymentId)).map((r) => r.desired);
  }

  /** The desired and observed state of each resource at the last passing verify (what a rollback returns to). */
  async lastVerified(deploymentId: string): Promise<Map<string, NonNullable<GraphResource['lastVerified']>>> {
    const out = new Map<string, NonNullable<GraphResource['lastVerified']>>();
    for (const r of await this.resources(deploymentId)) if (r.lastVerified) out.set(r.key, r.lastVerified);
    return out;
  }

  /** The graph for the console: the resources and the dependency edges. */
  async graph(p: Principal, id: string): Promise<{ deployment: Deployment; resources: GraphResource[]; edges: { from: string; to: string }[] }> {
    const deployment = await this.getFor(p, id);
    const resources = await this.resources(id);
    const edges = resources.flatMap((r) => r.dependsOn.map((d) => ({ from: d, to: r.key })));
    return { deployment, resources, edges };
  }

  // ---------- changes ----------

  async create(a: CloudActor, input: CreateDeploymentInput): Promise<Deployment> {
    await this.need();
    const s = this.s();
    const p = a.principal;
    const account = await s.cloud.accounts.getFor(p, input.accountId);
    const scope = account.scope;
    this.assertCanDeploy(p, { scope, tenantId: account.tenantId ?? p.tenantId, name: input.name });
    if (account.state === 'pending' || account.state === 'disabled') throw conflict(`${account.name} is ${account.state}; a deployment needs an active account.`);
    const region = input.region ?? account.defaultRegion;
    if (!region) throw new HttpProblem(400, 'Bad request', `${account.name} has no default region; name one.`);
    const label = input.label ?? 'internal';
    await s.cloud.accounts.assertRegionAllows(account, region, label, { tenantId: p.tenantId, use: 'deploy' });
    if (await s.db('cloud_deployments').where({ tenant_id: p.tenantId, name: input.name }).first()) throw conflict(`A deployment named ${input.name} already exists.`);
    const id = ulid();
    const now = Date.now();
    await s.db('cloud_deployments').insert({
      id,
      tenant_id: p.tenantId,
      scope,
      account_id: account.id,
      provider: account.provider,
      name: input.name,
      region,
      label,
      description: input.description ?? null,
      state: 'draft',
      health: 'unknown',
      spec: input.spec ? JSON.stringify(input.spec) : null,
      endpoints: JSON.stringify(input.endpoints ?? {}),
      observed_version: 0,
      current_plan_id: null,
      lease_holder: null,
      lease_until: null,
      verify: null,
      verified_at: null,
      created_by: p.userId,
      created_at: now,
      updated_at: now
    });
    await cloudAudit(s, { tenantId: p.tenantId, action: 'cloud.deployment.created', actor: a, deploymentId: id, deploymentName: input.name, label, detail: { account: account.id, accountName: account.name, provider: account.provider, scope, region } });
    return (await this.get(id))!;
  }

  /** Where the deployed app answers (the platform deployment sets it once it knows; B-102). */
  async setEndpoints(a: CloudActor, id: string, endpoints: DeploymentEndpoints): Promise<Deployment> {
    const d = await this.getFor(a.principal, id);
    this.assertCanDeploy(a.principal, d);
    const e = endpointsSchema.parse(endpoints);
    await this.s().db('cloud_deployments').where({ id }).update({ endpoints: JSON.stringify(e), updated_at: Date.now() });
    await cloudAudit(this.s(), { tenantId: d.tenantId, action: 'cloud.deployment.updated', actor: a, deploymentId: id, deploymentName: d.name, detail: { endpoints: e } });
    return (await this.get(id))!;
  }

  /** Sets the state (and health, and the current plan) without an audit entry: the caller writes the event. */
  async setState(id: string, state: DeploymentState, extra: { health?: DeploymentHealth; currentPlanId?: string | null; verify?: unknown } = {}): Promise<void> {
    const patch: Record<string, unknown> = { state, updated_at: Date.now() };
    if (extra.health) patch.health = extra.health;
    if (extra.currentPlanId !== undefined) patch.current_plan_id = extra.currentPlanId;
    if (extra.verify !== undefined) Object.assign(patch, { verify: JSON.stringify(extra.verify), verified_at: Date.now() });
    await this.s().db('cloud_deployments').where({ id }).update(patch);
  }

  // ---------- the lease (B-10104: one apply per deployment at a time) ----------

  /** Takes the lease when it is free, expired, or already this holder's. */
  async acquireLease(id: string, holder: string, ms: number): Promise<boolean> {
    const now = Date.now();
    const n = await this.s()
      .db('cloud_deployments')
      .where({ id })
      .andWhere((q) => q.whereNull('lease_holder').orWhere('lease_until', '<', now).orWhere({ lease_holder: holder }))
      .update({ lease_holder: holder, lease_until: now + ms });
    return n === 1;
  }

  async renewLease(id: string, holder: string, ms: number): Promise<boolean> {
    const n = await this.s().db('cloud_deployments').where({ id, lease_holder: holder }).update({ lease_until: Date.now() + ms });
    return n === 1;
  }

  async releaseLease(id: string, holder: string): Promise<void> {
    await this.s().db('cloud_deployments').where({ id, lease_holder: holder }).update({ lease_holder: null, lease_until: null });
  }

  /** The live lease, or null when there is none or it ran out. */
  leaseOf(d: Deployment): Deployment['lease'] {
    return d.lease && d.lease.until > Date.now() ? d.lease : null;
  }

  // ---------- provider context, refresh ----------

  /** The account, an adapter and a credential bought for the purpose (`read` for refresh and verify, `deploy` for apply). */
  async context(d: Deployment, purpose: CredentialPurpose): Promise<DeploymentContext> {
    const s = this.s();
    const account = await s.cloud.accounts.get(d.accountId);
    if (!account) throw conflict(`The account of ${d.name} no longer exists.`);
    if (account.state === 'disabled' || account.state === 'pending') throw conflict(`${account.name} is ${account.state}; nothing is called on it.`);
    const credentials = s.cloud.credentials;
    if (!credentials) throw componentMissing('Cloud credentials');
    const provider = s.cloud.providers.providerFor(account.provider);
    let cred: CallContext['cred'];
    try {
      cred = (await credentials.for(account, purpose)) as CallContext['cred'];
    } catch (err) {
      throw err instanceof HttpProblem ? err : providerProblem(account, err);
    }
    // Sprint 58: the engine's secret broker, bound to this deployment (values reach the provider, never the graph).
    const secrets = brokerFor(s.cloud.engine?.hooks.secrets, d);
    return { account, provider, cred, ctx: (region, signal) => ({ account, cred, ...(region ? { region } : {}), ...(signal ? { signal } : {}), ...(secrets ? { secrets } : {}) }) };
  }

  /** The adapter's spec for a desired resource (tags, the parent network's provider id). */
  specFor(d: Deployment, account: CloudAccount, r: DesiredResource, idempotencyKey: string, networkIds: Map<string, string | null>): ResourceSpec {
    const tags = cloudTags({ account: account.name, deployment: d.name, tenant: d.scope === 'tenant' ? d.tenantId : null, workspace: r.tags?.workspace ?? null, pool: r.tags?.pool ?? null });
    const networkId = r.network ? networkIds.get(r.network) : undefined;
    // Sprint 58: the provider ids of what it depends on, by key (props name other resources by key).
    const refs = Object.fromEntries((r.dependsOn ?? []).map((k) => [k, networkIds.get(k)] as const).filter((e): e is [string, string] => !!e[1]));
    const parent = { ...(networkId ? { networkId } : {}), ...(Object.keys(refs).length ? { refs } : {}) };
    return { type: r.type, name: providerName(d, r), idempotencyKey, tags, region: r.region ?? d.region, ...(Object.keys(parent).length ? { parent } : {}), props: r.spec as ResourceSpec['props'] };
  }

  /**
   * Reads every resource of the graph from the provider (`describe` by provider id; `find` for desired resources not
   * created yet, which an earlier lost attempt may have made), stores what changed (bumping `observedVersion`) and
   * returns the digest a plan keeps. Provider failures answer 502 or 429 (`providerProblem`).
   */
  async refresh(d: Deployment, opts: { desired?: DesiredResource[]; signal?: AbortSignal; context?: DeploymentContext } = {}): Promise<Refresh> {
    const c = opts.context ?? (await this.context(d, 'read'));
    const rows = await this.resources(d.id);
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const networkIds = new Map(rows.map((r) => [r.key, r.providerId]));
    const observed = new Map<string, ObservedResource | null>();
    const found = new Map<string, ObservedResource>();
    const changed: string[] = [];
    try {
      for (const r of rows) {
        if (!r.providerId) continue;
        if (c.provider.supports(r.type, 'describe') !== 'built') {
          observed.set(r.key, r.observed);
          continue;
        }
        const o = await c.provider.describe(c.ctx(r.region, opts.signal), { type: r.type, providerId: r.providerId, region: r.region, ...(r.locator ? { locator: r.locator } : {}) });
        observed.set(r.key, o);
        if (await this.storeObserved(d.id, r, o, { bump: false })) changed.push(r.key);
      }
      for (const want of opts.desired ?? []) {
        const row = byKey.get(want.key);
        if (row?.providerId) continue;
        if (c.provider.supports(want.type, 'describe') !== 'built' || c.provider.supports(want.type, 'create') !== 'built') continue;
        const f = await c.provider.find(c.ctx(want.region ?? d.region, opts.signal), this.specFor(d, c.account, want, 'refresh', networkIds));
        if (f) found.set(want.key, f);
      }
    } catch (err) {
      if (err instanceof CloudProviderError || !(err instanceof HttpProblem)) throw providerProblem(c.account, err);
      throw err;
    }
    let version = d.observedVersion;
    if (changed.length) {
      await this.s().db('cloud_deployments').where({ id: d.id }).increment('observed_version', 1);
      version = Number((await this.s().db('cloud_deployments').where({ id: d.id }).first('observed_version'))?.observed_version ?? version + 1);
    }
    return { version, digest: this.digest(rows, observed, found), observed, found, changed };
  }

  /** The digest of what a refresh saw (per key: the provider id and the observed hash), in key order. */
  digest(rows: GraphResource[], observed: Map<string, ObservedResource | null>, found: Map<string, ObservedResource>): string {
    const parts: unknown[] = [];
    for (const r of [...rows].sort((a, b) => a.key.localeCompare(b.key))) {
      parts.push({ key: r.key, providerId: r.providerId, observed: r.providerId ? observedHash(observed.has(r.key) ? (observed.get(r.key) ?? null) : r.observed) : null });
    }
    for (const [key, o] of [...found.entries()].sort((a, b) => a[0].localeCompare(b[0]))) parts.push({ key, found: o.providerId, observed: observedHash(o) });
    return hashOf(parts);
  }

  /**
   * Stores a resource's observed state when its hash changed; true when it did. With `bump` (the default) the
   * deployment's observed version moves on too (the apply worker and the lifecycle work store through this).
   */
  async storeObserved(deploymentId: string, r: Pick<GraphResource, 'id' | 'observedHash' | 'state'>, o: ObservedResource | null, opts: { bump?: boolean; state?: ResourceState } = {}): Promise<boolean> {
    const hash = observedHash(o);
    const state = opts.state ?? (r.state === 'deleted' ? 'deleted' : stateOf(o));
    if (hash === r.observedHash && state === r.state) return false;
    await this.s().db('cloud_resources').where({ id: r.id }).update({ observed: o ? JSON.stringify(o) : null, observed_hash: hash, observed_at: Date.now(), state, updated_at: Date.now() });
    if (opts.bump !== false) await this.bump(deploymentId);
    return true;
  }

  async bump(deploymentId: string): Promise<void> {
    await this.s().db('cloud_deployments').where({ id: deploymentId }).increment('observed_version', 1);
  }

  /** Inserts or updates a resource row (the apply worker's writes). */
  async upsertResource(deploymentId: string, desired: DesiredResource, region: string, patch: Partial<{ providerId: string | null; locator: Record<string, string> | null; observed: ObservedResource | null; state: ResourceState; tags: Record<string, string>; createdByOperation: string; createdByAudit: string }>): Promise<GraphResource> {
    const db = this.s().db;
    const now = Date.now();
    const existing = await this.resource(deploymentId, desired.key);
    const row: Record<string, unknown> = { desired: JSON.stringify(desired), type: desired.type, region, depends_on: JSON.stringify(desired.dependsOn), protect: desired.protect, updated_at: now };
    if (patch.providerId !== undefined) row.provider_id = patch.providerId;
    if (patch.locator !== undefined) row.locator = patch.locator ? JSON.stringify(patch.locator) : null;
    if (patch.observed !== undefined) Object.assign(row, { observed: patch.observed ? JSON.stringify(patch.observed) : null, observed_hash: observedHash(patch.observed), observed_at: now });
    if (patch.state) row.state = patch.state;
    if (patch.tags) row.tags = JSON.stringify(patch.tags);
    if (patch.createdByOperation) row.created_op = patch.createdByOperation;
    if (patch.createdByAudit) row.created_audit = patch.createdByAudit;
    if (existing) {
      await db('cloud_resources').where({ id: existing.id }).update(row);
    } else {
      await db('cloud_resources').insert({ id: ulid(), deployment_id: deploymentId, key: desired.key, provider_id: null, locator: null, observed: null, observed_hash: null, observed_at: null, tags: '{}', state: 'planned', created_op: null, created_audit: null, last_verified: null, created_at: now, ...row });
    }
    return (await this.resource(deploymentId, desired.key))!;
  }

  /** Records the state at a passing verify for each resource (what a rollback returns to). */
  async markVerified(deploymentId: string, at = Date.now()): Promise<void> {
    for (const r of await this.resources(deploymentId)) {
      await this.s().db('cloud_resources').where({ id: r.id }).update({ last_verified: JSON.stringify({ desired: r.desired, observed: r.observed, at }) });
    }
  }
}
