import { createHash } from 'node:crypto';
import type { Label } from '../authz/labels.js';
import { badRequest } from '../http/problem.js';
import { RESOURCE_TYPES, type ObservedResource, type OperationHandle, type ResourceType, type Support } from './providers/types.js';
import type { AccountScope, Provider } from './types.js';

export type { ObservedResource } from './providers/types.js';

/*
 * 1.9.99-final, Sprint 57 (B-10102, B-10103): the resource graph of a deployment, as the planner, the apply worker,
 * verify (this work) and drift, destroy, rollback and the orphan sweep (the lifecycle work) share it.
 *
 * - A `DesiredResource` is one node of the graph a deployment spec renders to (`renderGraph(spec)`, the deployment
 *   spec work): its key, type, the type's props (`spec`, as `PropsByType` in `providers/types.ts`), its dependencies,
 *   its protection flag and region.
 * - A `GraphResource` is what the graph keeps per resource (`cloud_resources`): the desired spec, the observed state
 *   (`ObservedResource`, as the adapter reports it), the provider id, dependencies, protection, tags, and the journal
 *   step and audit entry that created it (B-10701).
 * - A `Plan` is the desired graph against the observed one: one `PlanStep` per resource with its action and field-level
 *   changes (`planner.ts`).
 * - A `JournalEntry` is one row of the append-only operation journal (`journal.ts`).
 *
 * This file holds the types and the pure graph functions (validation, dependency order); the services are
 * `CloudDeployments` (`deployments.ts`), `CloudPlans` (`planner.ts`) and `CloudEngine` (`apply.ts`).
 */

// ---------- the desired graph ----------

/** A logical key: lower case letters, digits and dashes, starting with a letter; unique within a deployment. */
export const RESOURCE_KEY = /^[a-z][a-z0-9-]{0,62}$/;

export interface DesiredResource {
  key: string;
  type: ResourceType;
  /** The type's props (`PropsByType` in `providers/types.ts`): `{ cidr }` for a network, `{ ingress }` for a firewall... */
  spec: Record<string, unknown>;
  /** Keys this resource needs to exist first (created before it, deleted after it). */
  dependsOn: string[];
  /** A protected resource (a database, a bucket with data) is never deleted or replaced by an apply (B-10107: destroy needs a snapshot and dual control). */
  protect: boolean;
  /** The region; null means the deployment's region. Checked with `assertRegionAllows`. */
  region: string | null;
  /** The provider's logical name (`ResourceSpec.name`); default the key. */
  name?: string;
  /** The key of the network this resource lives in (its provider id becomes `ResourceSpec.parent.networkId`); implies a dependency. */
  network?: string;
  /** Tags beyond the ones every resource gets (`exprsn:managed`, `account`, `deployment`, `tenant`). */
  tags?: { workspace?: string; pool?: string };
}

// ---------- deployments ----------

export const DEPLOYMENT_STATES = ['draft', 'planned', 'applying', 'applied', 'ready', 'degraded', 'failed', 'destroying', 'destroyed'] as const;
/**
 * `draft`: created, never planned. `planned`: has an open plan. `applying`: an apply holds the lease. `applied`: the
 * last apply finished, verify has not answered yet. `ready`: verified. `degraded`: the last verify failed (rollback is
 * offered). `failed`: the last apply failed. `destroying`, `destroyed`: the lifecycle work's destroy (B-10107).
 */
export type DeploymentState = (typeof DEPLOYMENT_STATES)[number];
export type DeploymentHealth = 'unknown' | 'healthy' | 'degraded';

/** Where a deployed app answers, for the readiness checks (`verify.ts`); set by the platform deployment (B-102). */
export interface DeploymentEndpoints {
  /** The app's public URL (`/readyz` is read there). */
  publicUrl?: string;
  /** The name its TLS certificate must be valid for (default the public URL's host). */
  tlsName?: string;
  /** True when the deployment runs the app (its readiness is then required for `ready`). */
  app?: boolean;
  /** True when the deployment runs Redis: the app's `/readyz` must then report it reachable. */
  redis?: boolean;
}

export interface Deployment {
  id: string;
  /** The tenant that owns it (a platform deployment: the tenant of the admin who created it, the platform tenant). */
  tenantId: string;
  /** The account's scope: `platform` deployments also need `platform:manage` to change. */
  scope: AccountScope;
  accountId: string;
  provider: Provider;
  /** Lower case, unique within the tenant; the `exprsn:deployment` tag. */
  name: string;
  region: string;
  /** The highest label of data the deployment holds; `assertRegionAllows` checks every region against it. */
  label: Label;
  description: string | null;
  state: DeploymentState;
  health: DeploymentHealth;
  /** The deployment spec it was rendered from (the deployment spec work, B-10201), or null. */
  spec: Record<string, unknown> | null;
  /**
   * Sprint 62 (B-10209): `onprem` for an existing install registered for its front door only (no compute; its spec's
   * `kind`, `cloud/onprem.ts`), else `cloud`.
   */
  kind?: 'cloud' | 'onprem';
  endpoints: DeploymentEndpoints;
  /** Bumped whenever the observed state of any resource changes; a plan made at another version is stale. */
  observedVersion: number;
  currentPlanId: string | null;
  verify: VerifyReport | null;
  /** The apply holding the deployment's lease (one apply per deployment at a time), or null. */
  lease: { holder: string; until: number } | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

// ---------- the graph ----------

export const RESOURCE_STATES = ['planned', 'creating', 'ready', 'updating', 'deleting', 'deleted', 'failed', 'missing'] as const;
/** `missing`: it has a provider id but the provider no longer reports it. `deleted`: an apply or destroy removed it (kept for the trail). */
export type ResourceState = (typeof RESOURCE_STATES)[number];

export interface GraphResource {
  id: string;
  deploymentId: string;
  key: string;
  type: ResourceType;
  region: string;
  providerId: string | null;
  /** Provider locators (a DNS zone, a resource group), as `ResourceRef.locator`. */
  locator: Record<string, string> | null;
  /** The desired resource as last planned and applied. */
  desired: DesiredResource;
  /** What the provider reported at the last refresh, or null (never seen, or gone). */
  observed: ObservedResource | null;
  /** sha256 of the observed state's canonical JSON, or `missing`. */
  observedHash: string | null;
  observedAt: number | null;
  dependsOn: string[];
  protect: boolean;
  /** The `exprsn:*` tags it carries (or, for providers without tags, that the journal keeps for it). */
  tags: Record<string, string>;
  state: ResourceState;
  /** B-10701: the journal step (`cloud_operations.id`) and the audit entry that created (or adopted) it. */
  createdByOperation: string | null;
  createdByAudit: string | null;
  /** The desired and observed state at the last passing verify: what a rollback returns to (B-10107). */
  lastVerified: { desired: DesiredResource; observed: ObservedResource | null; at: number } | null;
  createdAt: number;
  updatedAt: number;
}

// ---------- plans ----------

export const PLAN_ACTIONS = ['create', 'update', 'replace', 'delete', 'noop'] as const;
export type PlanAction = (typeof PLAN_ACTIONS)[number];

export interface FieldChange {
  /** A dotted path into the spec (`cidr`, `ingress`, `values`), or `region`, `network`, `name`. */
  path: string;
  before: unknown;
  after: unknown;
  /** The provider cannot change it in place: the resource is replaced. */
  forcesReplace: boolean;
}

export interface PlanStep {
  key: string;
  action: PlanAction;
  changes: FieldChange[];
  /** Why: the reason for each replace (the field that forces it, a replaced network), a create of a missing resource, a delete. */
  reason?: string;
  type: ResourceType;
  region: string;
  protect: boolean;
  dependsOn: string[];
  /** The provider id the step acts on (update, replace, delete), or null. */
  providerId: string | null;
  /** A create that will adopt a resource an earlier attempt already made (found by the adapter's `find`). */
  adopts?: boolean;
  /** Set when the adapter does not drive this type or operation (`not_yet` or `unsupported`): shown as unavailable, never as an error. */
  unavailable?: { support: Exclude<Support, 'built'>; reason: string };
  /** A delete or replace of a protected resource: an apply refuses it (B-10107's destroy handles it). */
  blocked?: string;
}

/**
 * `apply`: from a desired graph. `revert`: back to the stored desired state (drift). `destroy`: everything deleted.
 * `rollback`: to the last verified state. `upgrade` (Sprint 58, B-10207): a new release by image digest; its graph
 * is the current one (nothing at the provider changes), and applying it starts the upgrade (`cloud/upgrades.ts`).
 */
export const PLAN_PURPOSES = ['apply', 'revert', 'destroy', 'rollback', 'upgrade'] as const;
export type PlanPurpose = (typeof PLAN_PURPOSES)[number];

export const PLAN_STATES = ['open', 'applying', 'applied', 'failed', 'stale', 'expired', 'cancelled'] as const;
export type PlanState = (typeof PLAN_STATES)[number];

/** What `estimatePlan` answers (the price catalogue, B-10601, `cloud/prices.ts`). */
export interface PlanEstimate {
  /** The deployment's monthly cost after the plan. */
  monthly: number;
  /** The change the plan makes to it. */
  delta: number;
  currency?: string;
  prices: unknown[];
}

/** The optional estimate hook on `s.cloud` (set by `cloud/prices.ts`); until it exists plans carry `estimate: null`. */
export type EstimatePlanFn = (plan: Plan) => Promise<PlanEstimate | null> | PlanEstimate | null;

export interface Plan {
  id: string;
  deploymentId: string;
  tenantId: string;
  /** sha256 over the plan's content; apply accepts only this hash, while the plan is open and current. */
  hash: string;
  purpose: PlanPurpose;
  desired: DesiredResource[];
  /** In the order an apply runs them: deletions in reverse dependency order, then the rest in dependency order. */
  steps: PlanStep[];
  summary: Record<PlanAction, number>;
  estimate: PlanEstimate | null;
  /** The deployment's observed version and digest when the plan was made. */
  observedVersion: number;
  observedDigest: string;
  state: PlanState;
  /** False when a step is unavailable or blocked; `blockers` says which. */
  applicable: boolean;
  blockers: string[];
  createdBy: string | null;
  createdAt: number;
  expiresAt: number;
  appliedAt: number | null;
  applyJobId: string | null;
  /** Why it was refused or ended (stale, expired, failed), or null. */
  note: string | null;
}

// ---------- the journal ----------

export const OPERATION_STEPS = ['create', 'update', 'delete', 'replace.delete', 'replace.create', 'poll', 'refresh', 'verify'] as const;
export type OperationStep = (typeof OPERATION_STEPS)[number];

/** `started`: the call is about to be made. `pending`: the provider answered with an operation to poll (`handle`). `succeeded`, `adopted` (a create found what an earlier attempt made), `failed`, `cancelled`. */
export const OPERATION_STATES = ['started', 'pending', 'succeeded', 'adopted', 'failed', 'cancelled'] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

export interface JournalEntry {
  id: string;
  deploymentId: string;
  planId: string | null;
  resourceKey: string;
  step: OperationStep;
  /** Stable across every attempt of one step (`ResourceSpec.idempotencyKey`). */
  idempotencyKey: string;
  /** What was sent as the provider's client token, where it takes one. */
  clientToken: string | null;
  providerRequestId: string | null;
  attempt: number;
  state: OperationState;
  error: string | null;
  /** A long-running operation to poll (plain JSON, any instance resumes it). */
  handle: OperationHandle | null;
  providerId: string | null;
  /** B-10701: the audit entry the step wrote, when it wrote one. */
  auditId: string | null;
  /** The job and instance that wrote the row. */
  jobId: string | null;
  worker: string | null;
  at: number;
}

// ---------- verify (B-10105) ----------

export type CheckStatus = 'pass' | 'fail' | 'unknown' | 'skipped';

export interface ReadinessResult {
  id: string;
  /** The resource key it is about, or null for the deployment. */
  key: string | null;
  status: CheckStatus;
  detail: string;
}

export interface VerifyReport {
  at: number;
  ok: boolean;
  /** One per resource (its observed state is ready and matches the desired spec). */
  resources: ReadinessResult[];
  /** The deployment's checks (the app's `/readyz`, database and Redis from the app, the TLS chain, pools). */
  checks: ReadinessResult[];
  /** Offered when verify failed after an apply (the lifecycle work's rollback, B-10107). */
  rollback: { offered: boolean; reason: string | null };
}

// ---------- pure graph functions ----------

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** JSON with object keys sorted, for hashes. */
export function canonical(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}

export const hashOf = (v: unknown): string => sha256(canonical(v));

/** Every dependency of a desired resource: `dependsOn` plus its network. */
export const depsOf = (r: Pick<DesiredResource, 'dependsOn' | 'network'>): string[] => [...new Set([...(r.dependsOn ?? []), ...(r.network ? [r.network] : [])])];

/** Normalises and checks a desired graph: keys, types, dependencies that exist, no cycles. Throws 400. */
export function validateGraph(input: DesiredResource[]): DesiredResource[] {
  if (input.length > 500) throw badRequest('A deployment graph holds at most 500 resources.');
  const seen = new Set<string>();
  const out = input.map((r) => {
    if (!RESOURCE_KEY.test(r.key)) throw badRequest(`${JSON.stringify(r.key)} is not a resource key: lower case letters, digits and dashes, starting with a letter.`, { reason: 'bad_key' });
    if (seen.has(r.key)) throw badRequest(`The resource key ${r.key} is used twice.`, { reason: 'duplicate_key' });
    seen.add(r.key);
    if (!(RESOURCE_TYPES as readonly string[]).includes(r.type)) throw badRequest(`${r.key}: ${String(r.type)} is not a resource type.`, { reason: 'bad_type' });
    if (r.name != null && !RESOURCE_KEY.test(r.name)) throw badRequest(`${r.key}: the name must be lower case letters, digits and dashes.`, { reason: 'bad_name' });
    return { key: r.key, type: r.type, spec: r.spec ?? {}, dependsOn: [...new Set(r.dependsOn ?? [])], protect: !!r.protect, region: r.region ?? null, ...(r.name ? { name: r.name } : {}), ...(r.network ? { network: r.network } : {}), ...(r.tags ? { tags: r.tags } : {}) };
  });
  for (const r of out) {
    for (const d of depsOf(r)) {
      if (d === r.key) throw badRequest(`${r.key} depends on itself.`, { reason: 'cycle' });
      if (!seen.has(d)) throw badRequest(`${r.key} depends on ${d}, which is not in the graph.`, { reason: 'unknown_dependency' });
    }
  }
  dependencyOrder(out);
  return out;
}

/** Topological order (dependencies first; ties by key, so the order is stable). Throws 400 on a cycle. */
export function dependencyOrder<T extends Pick<DesiredResource, 'key' | 'dependsOn' | 'network'>>(nodes: T[]): T[] {
  const by = new Map(nodes.map((n) => [n.key, n]));
  const state = new Map<string, 1 | 2>();
  const out: T[] = [];
  const visit = (n: T, path: string[]) => {
    const st = state.get(n.key);
    if (st === 2) return;
    if (st === 1) throw badRequest(`The graph has a cycle: ${[...path, n.key].join(' → ')}.`, { reason: 'cycle' });
    state.set(n.key, 1);
    for (const d of depsOf(n).sort()) {
      const dn = by.get(d);
      if (dn) visit(dn, [...path, n.key]);
    }
    state.set(n.key, 2);
    out.push(n);
  };
  for (const n of [...nodes].sort((a, b) => a.key.localeCompare(b.key))) visit(n, []);
  return out;
}

/** Reverse dependency order: dependents first (what a destroy walks). */
export const reverseDependencyOrder = <T extends Pick<DesiredResource, 'key' | 'dependsOn' | 'network'>>(nodes: T[]): T[] => dependencyOrder(nodes).reverse();
