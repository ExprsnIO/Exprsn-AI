import { GpuQuotas } from './gpu-quotas.js';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { conflict, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import type { CloudActor } from './accounts.js';
import { cloudAudit } from './audit.js';
import { publicDataProblems } from './network.js';
import { followSources, resolveForDiff, withValueSources } from './value-from.js';
import { computeProblems } from './compute.js';
import { databaseProblems, deletionBlock } from './databases.js';
import { cacheProblems } from './caches.js';
import type { Refresh } from './deployments.js';
import {
  dependencyOrder,
  depsOf,
  hashOf,
  PLAN_ACTIONS,
  RESOURCE_KEY,
  reverseDependencyOrder,
  validateGraph,
  type DesiredResource,
  type Deployment,
  type FieldChange,
  type GraphResource,
  type ObservedResource,
  type Plan,
  type PlanAction,
  type PlanEstimate,
  type PlanPurpose,
  type PlanState,
  type PlanStep
} from './graph.js';
import { RESOURCE_TYPES, type ResourceOperation, type ResourceType, type Support } from './providers/types.js';
import type { CloudFeature } from './types.js';

/*
 * 1.9.99-final, Sprint 57 (B-10103): `s.cloud.plans`. A plan is the desired graph against what the provider reports:
 * per resource create, update, replace, delete or no-op, with field-level changes, the reason for each replace, and
 * the cost delta from the price catalogue (`s.cloud.estimatePlan`, B-10601; null until it exists).
 *
 * - Making a plan refreshes the observed state first (`CloudDeployments.refresh`), so it is planned against the
 *   provider, not against what the graph last saw. Types or operations an adapter does not drive are shown as
 *   unavailable (and make the plan inapplicable), never as an error (B-10101).
 * - A plan is stored with its hash and expires after 60 minutes or when the observed state changes (the deployment's
 *   `observedVersion` moves on). `apply(actor, id, hash)` accepts only the open, unexpired plan's hash, reads the
 *   provider once more, and refuses with 409 `plan_stale` (and a fresh plan) when anything changed out of band.
 * - Steps are ordered as the apply runs them: deletions (deletes and the delete half of replaces) in reverse
 *   dependency order, then creates, updates and the create half of replaces in dependency order.
 * - A delete or replace of a protected resource is `blocked`: an apply refuses it. The lifecycle work's destroy
 *   (B-10107) takes the snapshot and the second admin's approval, then applies with `approvedProtected`.
 */

export const PLAN_TTL_MS = 60 * 60_000;

/** Fields a provider cannot change in place, per type: changing one replaces the resource. Region, name and network always do. */
export const REPLACE_FIELDS: Partial<Record<ResourceType, readonly string[]>> = {
  network: ['cidr'],
  subnet: ['cidr', 'zone'],
  bucket: ['bucketName', 'locationHint'],
  dns_record: ['zone', 'record', 'recordType', 'zoneGroup'],
  vm: ['image'],
  // Sprint 59 (B-10301): a managed database's engine, major version and AWS service are chosen at create.
  database: ['engine', 'version', 'service'],
  cache: ['engine'],
  kubernetes_cluster: ['version'],
  tunnel: []
};

// ---------- input ----------

const propsSchema = z.record(z.string().max(60), z.unknown());
export const desiredResourceSchema = z
  .object({
    key: z.string().regex(RESOURCE_KEY, 'lower case letters, digits and dashes, starting with a letter'),
    type: z.enum(RESOURCE_TYPES),
    spec: propsSchema.default({}),
    dependsOn: z.array(z.string().regex(RESOURCE_KEY)).max(50).default([]),
    protect: z.boolean().default(false),
    region: z.string().trim().min(1).max(40).nullable().default(null),
    name: z.string().regex(RESOURCE_KEY).optional(),
    network: z.string().regex(RESOURCE_KEY).optional(),
    tags: z.object({ workspace: z.string().max(63).optional(), pool: z.string().max(63).optional() }).strict().optional()
  })
  .strict();
export const createPlanSchema = z.object({ desired: z.array(desiredResourceSchema).max(500) }).strict();
export const applyPlanSchema = z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/, 'a plan hash') }).strict();

// ---------- the diff (pure) ----------

const isObj = (v: unknown): v is Record<string, unknown> => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * Whether the observed value satisfies the desired one: objects by the desired keys the provider reports (a key the
 * provider does not report cannot be compared and is left out), arrays as multisets, scalars by their string form.
 */
export function satisfies(desired: unknown, observed: unknown): boolean {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    if (!Array.isArray(observed) || observed.length !== desired.length) return false;
    const left = [...observed];
    for (const d of desired) {
      const i = left.findIndex((o) => satisfies(d, o));
      if (i < 0) return false;
      left.splice(i, 1);
    }
    return true;
  }
  if (isObj(desired)) {
    if (!isObj(observed)) return false;
    return Object.entries(desired).every(([k, v]) => v === undefined || observed[k] === undefined || satisfies(v, observed[k]));
  }
  if (desired === null) return observed == null;
  return String(desired) === String(observed);
}

/**
 * Sprint 58: firewall rules compare as what they allow, one (protocol, ports, source) at a time, so a provider that
 * keeps a rule's sources apart (EC2 permissions per range) or together reports the same rules as equal.
 */
export function sameRules(desired: unknown, observed: unknown): boolean {
  if (!Array.isArray(desired) || !Array.isArray(observed)) return false;
  const flat = (rules: unknown[]) => new Set(rules.flatMap((r) => {
    const x = (r ?? {}) as { protocol?: string; ports?: string; sources?: string[] };
    const ports = x.protocol === 'icmp' || x.protocol === 'all' ? '' : (x.ports ?? 'all');
    return (x.sources ?? []).map((src) => `${x.protocol}|${ports}|${src}`);
  }));
  const a = flat(desired);
  const b = flat(observed);
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/** Field-level changes from what the provider reports (or, for a new resource, from nothing) to the desired spec. */
export function fieldChanges(want: DesiredResource, wantRegion: string, current: Pick<GraphResource, 'desired' | 'region'> | null, observed: ObservedResource | null): FieldChange[] {
  const replace = new Set(REPLACE_FIELDS[want.type] ?? []);
  const out: FieldChange[] = [];
  if (!observed) {
    for (const [k, v] of Object.entries(want.spec)) if (v !== undefined) out.push({ path: k, before: null, after: v, forcesReplace: false });
    return out;
  }
  for (const [k, v] of Object.entries(want.spec)) {
    if (v === undefined || observed.props[k] === undefined) continue;
    // Sprint 60 (B-10405): a GPU node group or VM running a size its capacity fallback allows satisfies the spec.
    if (k === 'size' && Array.isArray((want.spec.capacity as { sizes?: unknown } | undefined)?.sizes) && ((want.spec.capacity as { sizes: unknown[] }).sizes).includes(observed.props[k])) continue;
    if (!(k === 'ingress' && sameRules(v, observed.props[k])) && !satisfies(v, observed.props[k])) out.push({ path: k, before: observed.props[k], after: v, forcesReplace: replace.has(k) });
  }
  if (current) {
    if (current.region !== wantRegion) out.push({ path: 'region', before: current.region, after: wantRegion, forcesReplace: true });
    const nameBefore = current.desired.name ?? current.desired.key;
    const nameAfter = want.name ?? want.key;
    if (nameBefore !== nameAfter) out.push({ path: 'name', before: nameBefore, after: nameAfter, forcesReplace: true });
    if ((current.desired.network ?? null) !== (want.network ?? null)) out.push({ path: 'network', before: current.desired.network ?? null, after: want.network ?? null, forcesReplace: true });
  }
  return out;
}

export interface DiffInput {
  desired: DesiredResource[];
  current: GraphResource[];
  /** The observed state of each graph resource with a provider id (null: gone). */
  observed: Map<string, ObservedResource | null>;
  /** What `find` found for desired resources not created yet. */
  found: Map<string, ObservedResource>;
  /** The deployment's region (for resources with `region: null`). */
  region: string;
  supports: (type: ResourceType, op?: ResourceOperation) => Support;
}

const unavailableReason = (type: ResourceType, op: string, support: Exclude<Support, 'built'>) =>
  support === 'not_yet' ? `This build does not ${op} ${type.replace(/_/g, ' ')} resources on this provider yet.` : `The provider offers no ${type.replace(/_/g, ' ')}.`;

/** The plan's steps: desired against observed, in the order an apply runs them. */
export function diffGraph(input: DiffInput): PlanStep[] {
  const cur = new Map(input.current.map((r) => [r.key, r]));
  const wanted = new Map(input.desired.map((r) => [r.key, r]));
  const steps = new Map<string, PlanStep>();
  const fresh = new Set<string>(); // replaced or (re)created: dependents living in them are replaced too

  for (const want of dependencyOrder(input.desired)) {
    const region = want.region ?? input.region;
    const row = cur.get(want.key);
    const base = { key: want.key, type: want.type, region, protect: want.protect, dependsOn: depsOf(want), providerId: row?.providerId ?? null };
    const create = input.supports(want.type, 'create');
    let step: PlanStep;
    if (!row || !row.providerId) {
      const f = input.found.get(want.key);
      step = { ...base, action: 'create', changes: fieldChanges(want, region, null, null) };
      if (f) Object.assign(step, { adopts: true, providerId: f.providerId, reason: `A resource an earlier attempt made (${f.providerId}) will be adopted, not created again.` });
      if (create !== 'built') step.unavailable = { support: create, reason: unavailableReason(want.type, 'create', create) };
      fresh.add(want.key);
    } else {
      const o = input.observed.has(want.key) ? (input.observed.get(want.key) ?? null) : row.observed;
      if (!o) {
        step = { ...base, action: 'create', changes: fieldChanges(want, region, null, null), reason: `${row.providerId} is gone from the provider (deleted out of band); it is created again.` };
        if (create !== 'built') step.unavailable = { support: create, reason: unavailableReason(want.type, 'create', create) };
        fresh.add(want.key);
      } else {
        const changes = fieldChanges(want, region, row, o);
        const forced = changes.filter((c) => c.forcesReplace);
        const parent = want.network && fresh.has(want.network) && cur.get(want.network)?.providerId ? want.network : null;
        const update = input.supports(want.type, 'update');
        if (forced.length || parent || o.state === 'failed') {
          const reason = forced.length ? `${forced.map((c) => c.path).join(', ')} cannot be changed in place.` : parent ? `Its network ${parent} is replaced.` : `It failed at the provider (${o.state}).`;
          step = { ...base, action: 'replace', changes, reason };
        } else if (changes.length && update !== 'built') {
          step = { ...base, action: 'replace', changes, reason: `The provider cannot update ${want.type.replace(/_/g, ' ')} resources in place here (${update === 'not_yet' ? 'not built yet' : 'unsupported'}).` };
        } else {
          step = { ...base, action: changes.length ? 'update' : 'noop', changes };
        }
        if (step.action === 'replace') {
          fresh.add(want.key);
          if (create !== 'built') step.unavailable = { support: create, reason: unavailableReason(want.type, 'create', create) };
          if (want.protect) step.blocked = `${want.key} is protected: replacing it would delete it. Destroy takes a snapshot and a second admin's approval first.`;
        }
        // B-10307 (Sprint 59): a database with deletion protection (on by default) is never replaced by a plan, and its protection is not turned off by one.
        const dbBlock = step.action === 'replace' || step.action === 'update' ? deletionBlock(step.action, { ...row, observed: o }, want) : null;
        if (dbBlock && !step.blocked) step.blocked = dbBlock;
      }
    }
    steps.set(want.key, step);
  }

  const deletes: PlanStep[] = [];
  for (const row of reverseDependencyOrder(input.current.map((r) => ({ ...r, network: r.desired.network })))) {
    if (wanted.has(row.key)) continue;
    const del = input.supports(row.type, 'delete');
    const step: PlanStep = { key: row.key, type: row.type, region: row.region, protect: row.protect, dependsOn: row.dependsOn, providerId: row.providerId, action: 'delete', changes: [], reason: 'No longer in the desired graph.' };
    if (row.providerId && del !== 'built') step.unavailable = { support: del, reason: unavailableReason(row.type, 'delete', del) };
    if (row.protect) step.blocked = `${row.key} is protected: deleting it needs a snapshot and a second admin's approval (destroy).`;
    // B-10307 (Sprint 59): every database with deletion protection, whatever the graph's flag says.
    const dbBlock = row.providerId ? deletionBlock('delete', row) : null;
    if (dbBlock && !step.blocked) step.blocked = dbBlock;
    deletes.push(step);
  }

  // Deletions first (dependents before what they depend on); the apply runs the delete half of replaces with them.
  return [...deletes, ...dependencyOrder(input.desired).map((r) => steps.get(r.key)!)];
}

export function summarise(steps: PlanStep[]): Record<PlanAction, number> {
  const out = Object.fromEntries(PLAN_ACTIONS.map((a) => [a, 0])) as Record<PlanAction, number>;
  for (const s of steps) out[s.action]++;
  return out;
}

function planFrom(r: Record<string, unknown>): Plan {
  return {
    id: String(r.id),
    deploymentId: String(r.deployment_id),
    tenantId: String(r.tenant_id),
    hash: String(r.hash),
    purpose: r.purpose as PlanPurpose,
    desired: json<DesiredResource[]>(r.desired, []),
    steps: json<PlanStep[]>(r.steps, []),
    summary: json<Record<PlanAction, number>>(r.summary, summarise([])),
    estimate: json<PlanEstimate | null>(r.estimate, null),
    observedVersion: Number(r.observed_version),
    observedDigest: String(r.observed_digest),
    state: r.state as PlanState,
    applicable: !!r.applicable,
    blockers: json<string[]>(r.blockers, []),
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
    appliedAt: r.applied_at == null ? null : Number(r.applied_at),
    applyJobId: (r.apply_job_id as string | null) ?? null,
    note: (r.note as string | null) ?? null
  };
}

/** The plan's hash: everything it says, so a changed plan cannot be applied with an old hash. */
export const planHash = (p: Pick<Plan, 'id' | 'deploymentId' | 'purpose' | 'desired' | 'steps' | 'estimate' | 'observedVersion' | 'observedDigest' | 'createdAt' | 'expiresAt'>): string =>
  hashOf({ id: p.id, deploymentId: p.deploymentId, purpose: p.purpose, desired: p.desired, steps: p.steps, estimate: p.estimate, observedVersion: p.observedVersion, observedDigest: p.observedDigest, createdAt: p.createdAt, expiresAt: p.expiresAt });

const featureFor = (d: Deployment): CloudFeature => (d.provider === 'cloudflare' ? 'frontdoor' : 'deploy');

export interface CreatePlanOptions {
  purpose?: PlanPurpose;
  /** A refresh already made (the stale check reuses it). */
  refresh?: Refresh;
}

export interface ApplyOptions {
  /** Keys of protected resources a second admin approved deleting (and whose snapshot exists): the lifecycle work's destroy. */
  approvedProtected?: string[];
}

export class CloudPlans {
  constructor(private readonly s: () => Services) {}

  private get deployments() {
    return this.s().cloud.deployments;
  }

  async get(id: string): Promise<Plan | null> {
    await this.deployments.need();
    const r = await this.s().db('cloud_plans').where({ id }).first();
    return r ? this.current(planFrom(r as Record<string, unknown>)) : null;
  }

  /** A plan as it stands now: an open plan past its expiry is `expired`, one made at an older observed version `stale`. */
  private async current(p: Plan, d?: Deployment | null): Promise<Plan> {
    if (p.state !== 'open') return p;
    if (Date.now() > p.expiresAt) return this.end(p, 'expired', 'The plan expired after 60 minutes; make a new one.');
    const dep = d ?? (await this.deployments.get(p.deploymentId));
    if (dep && dep.observedVersion !== p.observedVersion) return this.end(p, 'stale', 'The observed state changed after the plan was made; make a new one.');
    return p;
  }

  private async end(p: Plan, state: PlanState, note: string): Promise<Plan> {
    await this.s().db('cloud_plans').where({ id: p.id, state: p.state }).update({ state, note });
    return { ...p, state, note };
  }

  async getFor(principal: Principal, deploymentId: string, id: string): Promise<Plan> {
    await this.deployments.getFor(principal, deploymentId);
    const p = await this.get(id);
    if (!p || p.deploymentId !== deploymentId) throw notFound('Plan');
    return p;
  }

  async list(principal: Principal, deploymentId: string, limit = 50): Promise<Plan[]> {
    const d = await this.deployments.getFor(principal, deploymentId);
    const rows = (await this.s().db('cloud_plans').where({ deployment_id: deploymentId }).orderBy('created_at', 'desc').limit(Math.min(limit, 200))) as Record<string, unknown>[];
    return Promise.all(rows.map((r) => this.current(planFrom(r), d)));
  }

  /**
   * Plans a desired graph for a deployment: checks every region against the account's allow-list and ceilings
   * before any provider call, refreshes the observed state, diffs, estimates, stores the plan with its hash.
   */
  async create(a: CloudActor, deploymentId: string, desiredInput: DesiredResource[], opts: CreatePlanOptions = {}): Promise<Plan> {
    const s = this.s();
    const d = await this.deployments.getFor(a.principal, deploymentId);
    this.deployments.assertCanDeploy(a.principal, d);
    if (d.state === 'destroyed') throw conflict(`${d.name} is destroyed.`);
    const purpose = opts.purpose ?? 'apply';
    // B-10206 (Sprint 58): a record whose value comes from another resource is ordered after that resource.
    const desired = validateGraph(withValueSources(desiredInput));
    const account = await s.cloud.accounts.get(d.accountId);
    if (!account) throw conflict(`The account of ${d.name} no longer exists.`);
    for (const region of new Set([d.region, ...desired.map((r) => r.region ?? d.region)])) {
      await s.cloud.accounts.assertRegionAllows(account, region, d.label, { tenantId: d.tenantId, use: 'deploy' });
    }
    if (purpose !== 'destroy') s.cloud.accounts.assertFeature(account, featureFor(d));
    const context = await this.deployments.context(d, 'read');
    const refresh = opts.refresh ?? (await this.deployments.refresh(d, { desired, context }));
    const current = await this.deployments.resources(d.id);
    // B-10206: `valueFrom` records are compared with their source's observed address, and follow a source the plan (re)creates.
    const steps = followSources(diffGraph({ desired: resolveForDiff(desired, current), current, observed: refresh.observed, found: refresh.found, region: d.region, supports: (t, op) => context.provider.supports(t, op) }), desired);
    const blockers = [
      ...steps.filter((x) => x.unavailable).map((x) => `${x.key}: ${x.unavailable!.reason}`),
      ...steps.filter((x) => x.blocked).map((x) => `${x.key}: ${x.blocked}`),
      // B-10202: no data resource with a public address, whoever wrote the graph (not only the spec route).
      ...publicDataProblems(desired),
      // B-10204, B-10205 (Sprint 58): no DATA_KEY or other secret inline, a pinned release, IMDSv2 with hop limit 1.
      ...computeProblems(desired),
      // B-10305 (Sprint 59): a cache BullMQ and the bus cannot use (cluster mode, an evicting policy, no TLS) is refused with the reason.
      ...cacheProblems(desired),
      // B-10301, B-10303 (Sprint 59): a database's engine, version, size and extensions the provider offers; a missing extension is named.
      ...databaseProblems(desired, d.provider)
    ];
    const createdAt = Date.now();
    const plan: Plan = {
      id: ulid(),
      deploymentId: d.id,
      tenantId: d.tenantId,
      hash: '',
      purpose,
      desired,
      steps,
      summary: summarise(steps),
      estimate: null,
      observedVersion: refresh.version,
      observedDigest: refresh.digest,
      state: 'open',
      applicable: blockers.length === 0,
      blockers,
      createdBy: a.principal.userId,
      createdAt,
      expiresAt: createdAt + PLAN_TTL_MS,
      appliedAt: null,
      applyJobId: null,
      note: null
    };
    let estimateNote: string | null = null;
    if (s.cloud.estimatePlan) {
      try {
        plan.estimate = (await s.cloud.estimatePlan(plan)) ?? null;
      } catch (err) {
        estimateNote = `The estimate failed: ${String((err as Error).message ?? err).slice(0, 200)}`;
      }
    }
    // B-10602 (Sprint 58): past the budget's hard stop, a plan that adds monthly cost is refused (`budget_exceeded`).
    // Sprint 60 (B-10405): a plan that creates or grows a GPU node group or VM past the account's GPU quota is refused here.
    if (purpose !== 'destroy' && s.cloud.gpuPools?.quotas) {
      const q = await s.cloud.gpuPools.quotas.check(context, steps, desired, current).catch((err: unknown) => ({ findings: [], notes: [`The GPU quota check failed: ${String((err as Error).message ?? err).slice(0, 200)}`] }));
      for (const f of q.findings) blockers.push(GpuQuotas.message(f));
      if (q.findings.length) plan.applicable = false;
      if (q.notes.length) estimateNote = [estimateNote, ...q.notes].filter(Boolean).join(' ');
    }
    const budget = purpose === 'destroy' ? null : await s.cloud.budgets?.decide(plan, d).catch(() => null);
    if (budget?.refused) {
      blockers.push(budget.message);
      plan.applicable = false;
    }
    plan.hash = planHash(plan);
    if (estimateNote) plan.note = estimateNote;
    await s.db('cloud_plans').insert({
      id: plan.id,
      deployment_id: plan.deploymentId,
      tenant_id: plan.tenantId,
      hash: plan.hash,
      purpose,
      desired: JSON.stringify(desired),
      steps: JSON.stringify(steps),
      summary: JSON.stringify(plan.summary),
      estimate: plan.estimate ? JSON.stringify(plan.estimate) : null,
      observed_version: plan.observedVersion,
      observed_digest: plan.observedDigest,
      state: 'open',
      applicable: plan.applicable,
      blockers: JSON.stringify(blockers),
      note: plan.note,
      created_by: plan.createdBy,
      applied_by: null,
      apply_job_id: null,
      created_at: createdAt,
      expires_at: plan.expiresAt,
      applied_at: null
    });
    if (d.state === 'draft' || d.state === 'planned') await this.deployments.setState(d.id, 'planned', { currentPlanId: plan.id });
    await cloudAudit(s, {
      tenantId: d.tenantId,
      action: 'cloud.plan.created',
      actor: a,
      deploymentId: d.id,
      deploymentName: d.name,
      planId: plan.id,
      label: d.label,
      detail: { hash: plan.hash, purpose, summary: plan.summary, applicable: plan.applicable, blockers: blockers.slice(0, 20), estimate: plan.estimate ? { monthly: plan.estimate.monthly, delta: plan.estimate.delta, currency: plan.estimate.currency ?? null } : null, observedVersion: plan.observedVersion }
    });
    return plan;
  }

  /** A plan back to the stored desired state (drift's revert, B-10106). */
  async revert(a: CloudActor, deploymentId: string): Promise<Plan> {
    return this.create(a, deploymentId, await this.deployments.desiredGraph(deploymentId), { purpose: 'revert' });
  }

  /** A plan that deletes every resource in reverse dependency order (destroy, B-10107); protected ones are blocked until approved. */
  async destroyAll(a: CloudActor, deploymentId: string): Promise<Plan> {
    return this.create(a, deploymentId, [], { purpose: 'destroy' });
  }

  /** A plan back to the state of the last passing verify (rollback, B-10107); resources added since are deleted. */
  async rollbackToVerified(a: CloudActor, deploymentId: string): Promise<Plan> {
    const verified = await this.deployments.lastVerified(deploymentId);
    if (!verified.size) throw conflict('The deployment was never verified, so there is no state to roll back to.');
    return this.create(a, deploymentId, [...verified.values()].map((v) => v.desired), { purpose: 'rollback' });
  }

  /**
   * Applies an open plan by its hash: refuses an expired, stale, inapplicable or already applied plan, or one whose
   * deployment another apply holds; reads the provider again and refuses with 409 `plan_stale` (offering a fresh plan)
   * when anything changed; then queues `cloud.apply`.
   */
  async apply(a: CloudActor, id: string, hash: string, opts: ApplyOptions = {}): Promise<{ plan: Plan; jobId: string }> {
    const s = this.s();
    await this.deployments.need();
    const raw = await s.db('cloud_plans').where({ id }).first();
    if (!raw) throw notFound('Plan');
    const d = await this.deployments.getFor(a.principal, String(raw.deployment_id));
    this.deployments.assertCanDeploy(a.principal, d);
    let plan = await this.current(planFrom(raw as Record<string, unknown>), d);
    const refuse = async (status: number, reason: string, detail: string, extensions: Record<string, unknown> = {}) => {
      await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.plan.refused', actor: a, deploymentId: d.id, deploymentName: d.name, planId: plan.id, detail: { reason, hash: plan.hash } });
      return new HttpProblem(status, status === 409 ? 'Conflict' : 'Bad request', detail, { extensions: { reason, plan: plan.id, ...extensions } });
    };
    if (hash !== plan.hash) throw await refuse(409, 'plan_hash_mismatch', 'That hash is not this plan\'s; review the plan again and apply it by its hash.');
    if (plan.state === 'expired') throw await refuse(409, 'plan_expired', 'The plan expired after 60 minutes; make a new one.');
    if (plan.state !== 'open' && plan.state !== 'stale') throw await refuse(409, 'plan_not_open', `The plan is ${plan.state}; only an open plan can be applied.`);
    // B-10602 (Sprint 58): the budget is asked again at apply, so an override approved since lets the same plan through.
    if (plan.purpose !== 'destroy') {
      const budget = await s.cloud.budgets?.decide(plan, d).catch(() => null);
      if (budget?.refused) throw await refuse(409, 'budget_exceeded', budget.message.replace(/^budget_exceeded: /, ''), { budget: budget.status, costReasons: budget.reasons });
    }
    const approved = new Set(opts.approvedProtected ?? []);
    const blockers = [...plan.steps.filter((x) => x.unavailable).map((x) => `${x.key}: ${x.unavailable!.reason}`), ...plan.steps.filter((x) => x.blocked && !approved.has(x.key)).map((x) => `${x.key}: ${x.blocked}`)];
    // Sprint 58: the graph checks the plan was refused on (public data, inline secrets, an unpinned release) hold at apply too.
    blockers.push(...publicDataProblems(plan.desired), ...computeProblems(plan.desired), ...cacheProblems(plan.desired), ...databaseProblems(plan.desired, d.provider));
    if (blockers.length) throw await refuse(409, 'plan_unavailable', 'The plan has steps that cannot be applied.', { blockers });
    const lease = this.deployments.leaseOf(d);
    if (lease) throw await refuse(409, 'apply_in_progress', `Another apply (${lease.holder}) is working on ${d.name}; one apply per deployment runs at a time.`);
    // The out-of-band check: what the provider reports now against what the plan was made from.
    let refresh: Refresh | null = null;
    if (plan.state === 'open') {
      const context = await this.deployments.context(d, 'read');
      refresh = await this.deployments.refresh(d, { desired: plan.desired, context });
      if (refresh.digest !== plan.observedDigest || refresh.version !== plan.observedVersion) plan = await this.end(plan, 'stale', 'A resource changed out of band after the plan was made.');
    }
    if (plan.state === 'stale') {
      const fresh = await this.create(a, d.id, plan.desired, { purpose: plan.purpose, ...(refresh ? { refresh } : {}) });
      throw await refuse(409, 'plan_stale', 'A resource changed after the plan was made, so it was not applied. Review the fresh plan and apply it by its hash.', { freshPlan: { id: fresh.id, hash: fresh.hash, summary: fresh.summary, expiresAt: fresh.expiresAt } });
    }
    const n = await s.db('cloud_plans').where({ id: plan.id, state: 'open' }).update({ state: 'applying', applied_by: a.principal.userId });
    if (n !== 1) throw await refuse(409, 'plan_not_open', 'The plan is already being applied.');
    const job = await s.jobs.enqueue({ tenantId: d.tenantId, type: 'cloud.apply', payload: { planId: plan.id, deploymentId: d.id, approvedProtected: [...approved] }, createdBy: a.principal.userId, dedupeKey: `cloud.apply:${plan.id}`, maxAttempts: 5 });
    await s.db('cloud_plans').where({ id: plan.id }).update({ apply_job_id: job.id });
    await this.deployments.setState(d.id, 'applying', { currentPlanId: plan.id });
    await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.apply.started', actor: a, deploymentId: d.id, deploymentName: d.name, planId: plan.id, label: d.label, detail: { hash: plan.hash, job: job.id, purpose: plan.purpose, summary: plan.summary, approvedProtected: [...approved] } });
    return { plan: { ...plan, state: 'applying', applyJobId: job.id }, jobId: job.id };
  }

  /** Sets a plan's state (the apply worker's). */
  async setState(id: string, state: PlanState, note: string | null = null, extra: { appliedAt?: number } = {}): Promise<void> {
    await this.s().db('cloud_plans').where({ id }).update({ state, ...(note != null ? { note } : {}), ...(extra.appliedAt ? { applied_at: extra.appliedAt } : {}) });
  }

  /** The raw row (the apply worker reads a plan in any state). */
  async load(id: string): Promise<Plan | null> {
    const r = await this.s().db('cloud_plans').where({ id }).first();
    return r ? planFrom(r as Record<string, unknown>) : null;
  }
}
