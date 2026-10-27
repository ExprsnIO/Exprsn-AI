import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { conflict, HttpProblem, notFound } from '../http/problem.js';
import type { Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import type { CloudActor } from './accounts.js';
import { cloudAudit } from './audit.js';
import type { DeploymentContext } from './deployments.js';
import { RESOURCE_KEY, type DesiredResource, type Deployment, type GraphResource, type ObservedResource, type Plan } from './graph.js';
import { fieldChanges } from './planner.js';
import { CloudProviderError, type ResourceType } from './providers/types.js';
import { providerProblem } from './validate.js';
import { cloudPlaneMetrics } from './cloud-metrics.js';
import type { ChangedBy, ChangeTrail } from './change-trail.js';

/*
 * 1.9.99-final, Sprint 57 (B-10106): drift. The scheduled `cloud.drift` (every CLOUD_DRIFT_MINUTES, one job per
 * deployment with resources) reads every managed resource from the provider, through the adapters only, and records
 * three kinds of finding:
 *
 * - `field`: a field of the desired spec the provider reports differently (an inbound rule added by hand to a
 *   firewall is drift of `ingress`), compared as the planner compares (`fieldChanges`);
 * - `missing`: the provider no longer reports a resource the graph holds;
 * - `unmanaged`: a resource the graph does not hold inside a managed group: inside one of the deployment's networks
 *   (subnets, firewalls and machines whose network is a managed one) or tagged `exprsn:deployment=<name>`.
 *
 * Each finding is decided once: `revert` makes a plan back to the desired graph (`s.cloud.plans`, purpose `revert`;
 * an unmanaged resource is taken into the graph and the plan deletes it) and, when asked, applies it; `adopt` makes
 * the observed state the desired one (the field's value, a missing resource leaving the graph, an unmanaged one
 * joining it); `ignore` keeps that field (or that resource) out of later runs. A finding no longer seen is
 * `resolved`. New findings are told to the deployment's owners (who created it and the cloud admins) and written to
 * the audit chain (`cloud.drift.detected`); decisions as `cloud.drift.decided`.
 *
 * Needs migration 149_cloud_lifecycle; until it is applied the routes answer 503 and the schedule queues nothing.
 */

export const DRIFT_KINDS = ['field', 'missing', 'unmanaged'] as const;
export type DriftKind = (typeof DRIFT_KINDS)[number];
export const DRIFT_STATES = ['open', 'reverted', 'adopted', 'ignored', 'resolved'] as const;
export type DriftState = (typeof DRIFT_STATES)[number];
export const DRIFT_DECISIONS = ['revert', 'adopt', 'ignore'] as const;
export type DriftDecision = (typeof DRIFT_DECISIONS)[number];

export interface DriftFinding {
  id: string;
  deploymentId: string;
  tenantId: string;
  kind: DriftKind;
  /** The graph's key (field and missing findings), or null (unmanaged). */
  key: string | null;
  type: ResourceType;
  providerId: string | null;
  /** The field (`ingress`, `cidr`...) of a field finding, '' otherwise. */
  path: string;
  desired: unknown;
  observed: unknown;
  detail: string | null;
  state: DriftState;
  decidedBy: string | null;
  decidedAt: number | null;
  note: string | null;
  planId: string | null;
  firstSeen: number;
  lastSeen: number;
  /**
   * Sprint 62 (B-10703): who changed the resource and when, from the provider's trail (`cloud/change-trail.ts`); set
   * on the findings `findings()` answers, null until a lookup found the change.
   */
  changedBy?: ChangedBy | null;
  trail?: ChangeTrail;
}

export const decideSchema = z
  .object({
    decision: z.enum(DRIFT_DECISIONS),
    note: z.string().trim().max(500).optional(),
    /** revert: also apply the plan now (otherwise it waits to be applied by its hash). */
    apply: z.boolean().optional()
  })
  .strict();

const TABLES = ['cloud_drift_findings', 'cloud_destroys', 'cloud_orphans'] as const;
const SCHEMA_RECHECK_MS = 30_000;
const MIN = 60_000;

export const lifecycleMissing = () => new HttpProblem(503, 'Not installed', 'Drift, destroy and orphans need the database migration 149_cloud_lifecycle, which has not been applied.', { extensions: { reason: 'migration_pending' } });

/** Whether migration 149 is applied, re-checked every 30 s while it is not. */
export class LifecycleSchema {
  private state: { ok: boolean; at: number } | null = null;
  constructor(private readonly s: () => Services) {}
  async installed(): Promise<boolean> {
    const t = Date.now();
    if (this.state && (this.state.ok || t - this.state.at < SCHEMA_RECHECK_MS)) return this.state.ok;
    let ok = true;
    try {
      for (const name of TABLES) if (!(await this.s().db.schema.hasTable(name))) ok = false;
    } catch {
      ok = false;
    }
    this.state = { ok, at: t };
    return ok;
  }
  reset(): void {
    this.state = null;
  }
  async need(): Promise<void> {
    if (!(await this.installed())) throw lifecycleMissing();
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const fingerprint = (kind: DriftKind, a: string, b = '') => sha(`${kind}|${a}|${b}`);

function findingFrom(r: Record<string, unknown>): DriftFinding {
  return {
    id: String(r.id),
    deploymentId: String(r.deployment_id),
    tenantId: String(r.tenant_id),
    kind: r.kind as DriftKind,
    key: (r.resource_key as string | null) ?? null,
    type: r.resource_type as ResourceType,
    providerId: (r.provider_id as string | null) ?? null,
    path: String(r.path ?? ''),
    desired: json(r.desired, null),
    observed: json(r.observed, null),
    detail: (r.detail as string | null) ?? null,
    state: r.state as DriftState,
    decidedBy: (r.decided_by as string | null) ?? null,
    decidedAt: r.decided_at == null ? null : Number(r.decided_at),
    note: (r.decision_note as string | null) ?? null,
    planId: (r.plan_id as string | null) ?? null,
    firstSeen: Number(r.first_seen),
    lastSeen: Number(r.last_seen)
  };
}

interface Seen {
  kind: DriftKind;
  key: string | null;
  type: ResourceType;
  providerId: string | null;
  path: string;
  desired: unknown;
  observed: unknown;
  detail: string;
  fingerprint: string;
}

/** Types that live inside a network, and so count as unmanaged when found in a managed one. */
const IN_NETWORK: readonly ResourceType[] = ['subnet', 'firewall', 'vm', 'database', 'cache', 'load_balancer', 'node_group'];
/** Types listed by their `exprsn:deployment` tag (DNS records need their zone, so they are not swept). */
const TAGGED: readonly ResourceType[] = ['network', 'subnet', 'firewall', 'bucket', 'vm', 'tunnel', 'kubernetes_cluster', 'node_group', 'container_service', 'database', 'cache', 'load_balancer', 'secret'];

const networkOf = (o: ObservedResource): string | null => o.locator?.networkId ?? (typeof o.props.networkId === 'string' ? o.props.networkId : null);
/** What every provider makes in a network by itself (the AWS default security group). */
const builtIn = (provider: string, o: ObservedResource) => provider === 'aws' && o.type === 'firewall' && o.name === 'default';

/** A graph key for an adopted resource, from its name: lower case, unique in the deployment. */
export function keyFor(name: string, taken: Set<string>): string {
  let base = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 50);
  if (!RESOURCE_KEY.test(base)) base = `adopted-${sha(name).slice(0, 8)}`;
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base}-${i}`;
  return key;
}

export class CloudDrift {
  constructor(
    private readonly s: () => Services,
    private readonly schema: LifecycleSchema
  ) {}

  private get deployments() {
    return this.s().cloud.deployments;
  }

  // ---------- reads ----------

  async findings(p: Principal, deploymentId: string, opts: { state?: DriftState } = {}): Promise<DriftFinding[]> {
    await this.schema.need();
    await this.deployments.getFor(p, deploymentId);
    let q = this.s().db('cloud_drift_findings').where({ deployment_id: deploymentId });
    if (opts.state) q = q.andWhere({ state: opts.state });
    const list = ((await q.orderBy('first_seen', 'desc').limit(500)) as Record<string, unknown>[]).map(findingFrom);
    // Sprint 62 (B-10703): each finding's "changed by" from the change trail's cache (nothing is called here).
    const trail = this.s().cloud.lifecycle?.trail;
    return trail ? trail.decorate(list) : list;
  }

  async finding(id: string): Promise<DriftFinding | null> {
    const r = await this.s().db('cloud_drift_findings').where({ id }).first();
    return r ? findingFrom(r as Record<string, unknown>) : null;
  }

  // ---------- detection ----------

  /** Reads every managed resource of a deployment and records what drifted. Provider failures answer 502 or 429. */
  async detect(d: Deployment, opts: { signal?: AbortSignal; context?: DeploymentContext } = {}): Promise<{ checked: number; open: DriftFinding[]; fresh: DriftFinding[]; resolved: number }> {
    await this.schema.need();
    const s = this.s();
    const c = opts.context ?? (await this.deployments.context(d, 'read'));
    const rows = await this.deployments.resources(d.id);
    const live = rows.filter((r) => r.providerId && r.state !== 'planned');
    const ignored = new Set(((await s.db('cloud_drift_findings').where({ deployment_id: d.id, state: 'ignored' }).select('fingerprint')) as { fingerprint: string }[]).map((r) => r.fingerprint));
    const seen: Seen[] = [];
    let changed = false;
    let checked = 0;
    try {
      for (const r of live) {
        if (c.provider.supports(r.type, 'describe') !== 'built') continue;
        const o = await c.provider.describe(c.ctx(r.region, opts.signal), { type: r.type, providerId: r.providerId!, region: r.region, ...(r.locator ? { locator: r.locator } : {}) });
        checked++;
        if (await this.deployments.storeObserved(d.id, r, o, { bump: false })) changed = true;
        if (!o) {
          seen.push({ kind: 'missing', key: r.key, type: r.type, providerId: r.providerId, path: '', desired: r.desired.spec, observed: null, detail: `${r.providerId} is no longer reported by the provider.`, fingerprint: fingerprint('missing', r.key, r.providerId!) });
          continue;
        }
        const desired = r.desired;
        for (const ch of fieldChanges(desired, r.region, r, o)) {
          if (!(ch.path in desired.spec)) continue; // region, name and network are the graph's own, not the provider's
          seen.push({ kind: 'field', key: r.key, type: r.type, providerId: r.providerId, path: ch.path, desired: ch.after, observed: ch.before, detail: `${ch.path} differs from the desired spec${ch.forcesReplace ? ' (reverting it replaces the resource)' : ''}.`, fingerprint: fingerprint('field', r.key, ch.path) });
        }
      }
      // Unmanaged resources inside the managed groups.
      const known = await this.knownIds(d.accountId);
      const listed = new Map<string, ObservedResource>();
      const why = new Map<string, string>();
      const networks = live.filter((r) => r.type === 'network');
      const tryList = async (type: ResourceType, filter: Parameters<typeof c.provider.list>[2]) => {
        if (c.provider.supports(type, 'list') !== 'built') return [] as ObservedResource[];
        try {
          return await c.provider.list(c.ctx(undefined, opts.signal), type, filter);
        } catch (err) {
          if (err instanceof CloudProviderError && err.status === 400) return []; // a list this provider cannot make (a zone needed)
          // Sprint 62 (B-10209): a Cloudflare token scoped to the front door (an on-prem install's) lists no R2 or Containers.
          if (err instanceof CloudProviderError && err.status === 403 && c.account.provider === 'cloudflare') return [];
          throw err;
        }
      };
      for (const net of networks) {
        for (const type of IN_NETWORK) {
          for (const o of await tryList(type, { networkId: net.providerId! })) {
            if (networkOf(o) !== net.providerId || known.has(o.providerId) || builtIn(c.account.provider, o)) continue;
            listed.set(`${o.type}|${o.providerId}`, o);
            why.set(`${o.type}|${o.providerId}`, `Inside the managed network ${net.key}, but not in the graph.`);
          }
        }
      }
      for (const type of TAGGED) {
        for (const o of await tryList(type, { managedOnly: true })) {
          if (o.tags['exprsn:deployment'] !== d.name || known.has(o.providerId)) continue;
          if (!listed.has(`${o.type}|${o.providerId}`)) why.set(`${o.type}|${o.providerId}`, `Tagged exprsn:deployment=${d.name}, but not in the graph.`);
          listed.set(`${o.type}|${o.providerId}`, o);
        }
      }
      for (const [k, o] of listed) seen.push({ kind: 'unmanaged', key: null, type: o.type, providerId: o.providerId, path: '', desired: null, observed: o, detail: why.get(k) ?? 'Not in the graph.', fingerprint: fingerprint('unmanaged', o.type, o.providerId) });
    } catch (err) {
      if (err instanceof HttpProblem) throw err;
      throw providerProblem(c.account, err);
    }
    if (changed) await this.deployments.bump(d.id);
    const out = await this.record(d, seen.filter((x) => !ignored.has(x.fingerprint)), checked);
    // Sprint 62 (B-10703): who changed what, for the open findings only, in a bounded window; never fails the run.
    const trail = s.cloud.lifecycle?.trail;
    if (trail && out.open.length) await trail.lookup(d, out.open, c).catch((err: unknown) => s.log.warn({ err, deployment: d.id }, 'cloud change trail failed'));
    return out;
  }

  /** Provider ids every graph of the account holds (a resource another deployment manages is not unmanaged here). */
  private async knownIds(accountId: string): Promise<Set<string>> {
    const rows = (await this.s().db('cloud_resources as r').join('cloud_deployments as d', 'd.id', 'r.deployment_id').where('d.account_id', accountId).whereNot('r.state', 'deleted').whereNotNull('r.provider_id').select('r.provider_id')) as { provider_id: string }[];
    return new Set(rows.map((r) => r.provider_id));
  }

  private async record(d: Deployment, seen: Seen[], checked: number): Promise<{ checked: number; open: DriftFinding[]; fresh: DriftFinding[]; resolved: number }> {
    const s = this.s();
    const now = Date.now();
    const raw = (await s.db('cloud_drift_findings').where({ deployment_id: d.id, state: 'open' })) as Record<string, unknown>[];
    const open = raw.map(findingFrom);
    const byPrint = new Map(raw.map((r, i) => [String(r.fingerprint), open[i]!]));
    const fresh: DriftFinding[] = [];
    const still = new Set<string>();
    for (const x of seen) {
      const have = byPrint.get(x.fingerprint);
      if (have) {
        still.add(have.id);
        await s.db('cloud_drift_findings').where({ id: have.id }).update({ last_seen: now, observed: JSON.stringify(x.observed ?? null), desired: JSON.stringify(x.desired ?? null), detail: x.detail.slice(0, 500) });
        continue;
      }
      const id = ulid();
      await s.db('cloud_drift_findings').insert({ id, deployment_id: d.id, tenant_id: d.tenantId, kind: x.kind, resource_key: x.key, resource_type: x.type, provider_id: x.providerId, path: x.path, fingerprint: x.fingerprint, desired: JSON.stringify(x.desired ?? null), observed: JSON.stringify(x.observed ?? null), detail: x.detail.slice(0, 500), state: 'open', decided_by: null, decided_at: null, decision_note: null, plan_id: null, first_seen: now, last_seen: now });
      fresh.push((await this.finding(id))!);
      still.add(id);
    }
    const gone = open.filter((f) => !still.has(f.id));
    if (gone.length) await s.db('cloud_drift_findings').whereIn('id', gone.map((f) => f.id)).update({ state: 'resolved', decided_at: now, decision_note: 'No longer seen at the provider.' });
    // B-10702: new findings by kind.
    const metrics = cloudPlaneMetrics(s.metrics.registry);
    for (const k of new Set(fresh.map((f) => f.kind))) metrics.driftDetected(k, fresh.filter((f) => f.kind === k).length);
    if (fresh.length) {
      await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.drift.detected', actor: { service: 'cloud.drift' }, deploymentId: d.id, deploymentName: d.name, label: d.label, detail: { findings: fresh.map((f) => ({ id: f.id, kind: f.kind, key: f.key, type: f.type, providerId: f.providerId, path: f.path })).slice(0, 50), checked } });
      await this.tell(d, fresh);
    }
    const now2 = ((await s.db('cloud_drift_findings').where({ deployment_id: d.id, state: 'open' }).orderBy('first_seen', 'desc')) as Record<string, unknown>[]).map(findingFrom);
    return { checked, open: now2, fresh, resolved: gone.length };
  }

  /** The owners of a deployment: who created it, and the cloud admins of its tenant (a platform one: those who also hold platform:manage). */
  async owners(d: Deployment): Promise<string[]> {
    const admins = await this.s().cloud.accounts.cloudAdmins(d.tenantId, d.scope === 'platform');
    return [...new Set([...(d.createdBy ? [d.createdBy] : []), ...admins])];
  }

  private async tell(d: Deployment, fresh: DriftFinding[]): Promise<void> {
    const s = this.s();
    const userIds = await this.owners(d);
    if (!userIds.length) return;
    const by = (k: DriftKind) => fresh.filter((f) => f.kind === k).length;
    const parts = [by('field') && `${by('field')} changed field${by('field') === 1 ? '' : 's'}`, by('missing') && `${by('missing')} missing`, by('unmanaged') && `${by('unmanaged')} unmanaged`].filter(Boolean).join(', ');
    const first = fresh[0]!;
    const what = first.kind === 'field' ? `${first.key}: ${first.path}` : first.kind === 'missing' ? `${first.key} is missing` : `${first.type} ${first.providerId} is not managed`;
    await s.notifications
      .notify({ tenantId: d.tenantId, userIds, kind: 'cloud.drift', title: `Drift in ${d.name}`, body: `${parts} (${what}${fresh.length > 1 ? ', and more' : ''}). Revert, adopt or ignore each finding.`.slice(0, 300), route: 'deployments', label: 'internal' })
      .catch((err: unknown) => s.log.warn({ err }, 'cloud drift notice failed'));
  }

  // ---------- decisions ----------

  async decide(a: CloudActor, deploymentId: string, findingId: string, input: z.infer<typeof decideSchema>): Promise<{ finding: DriftFinding; plan: Plan | null; jobId: string | null }> {
    await this.schema.need();
    const s = this.s();
    const d = await this.deployments.getFor(a.principal, deploymentId);
    this.deployments.assertCanDeploy(a.principal, d);
    const f = await this.finding(findingId);
    if (!f || f.deploymentId !== d.id) throw notFound('Finding');
    if (f.state !== 'open') throw conflict(`The finding is ${f.state}; only an open finding is decided.`);
    let plan: Plan | null = null;
    let jobId: string | null = null;
    const rows = await this.deployments.resources(d.id);
    const row = f.key ? rows.find((r) => r.key === f.key) ?? null : null;
    if ((f.kind === 'field' || f.kind === 'missing') && !row) throw conflict(`${f.key} is no longer in the graph; run drift again.`);
    let adoptedKey: string | null = null;
    if (input.decision === 'revert') {
      if (f.kind === 'unmanaged') {
        // Taken into the graph, so the planner deletes it (deleting what is not in the desired graph is a revert).
        adoptedKey = (await this.adoptUnmanaged(d, f, rows)).key;
        const desired = (await this.deployments.desiredGraph(d.id)).filter((r) => r.key !== adoptedKey);
        plan = await s.cloud.plans.create(a, d.id, desired, { purpose: 'revert' });
      } else {
        plan = await s.cloud.plans.revert(a, d.id);
      }
      if (input.apply) {
        if (!plan.applicable) throw conflict(`The revert plan cannot be applied: ${plan.blockers.join('; ')}`);
        jobId = (await s.cloud.plans.apply(a, plan.id, plan.hash)).jobId;
      }
    } else if (input.decision === 'adopt') {
      if (f.kind === 'field') {
        const desired: DesiredResource = { ...row!.desired, spec: { ...row!.desired.spec, [f.path]: f.observed } };
        await this.deployments.upsertResource(d.id, desired, row!.region, {});
      } else if (f.kind === 'missing') {
        await this.deployments.upsertResource(d.id, row!.desired, row!.region, { state: 'deleted', observed: null });
      } else {
        adoptedKey = (await this.adoptUnmanaged(d, f, rows)).key;
      }
      await this.deployments.bump(d.id);
    }
    const state: DriftState = input.decision === 'revert' ? 'reverted' : input.decision === 'adopt' ? 'adopted' : 'ignored';
    await s.db('cloud_drift_findings').where({ id: f.id, state: 'open' }).update({ state, decided_by: a.principal.userId, decided_at: Date.now(), decision_note: input.note ?? null, plan_id: plan?.id ?? null });
    await cloudAudit(s, {
      tenantId: d.tenantId,
      action: 'cloud.drift.decided',
      actor: a,
      deploymentId: d.id,
      deploymentName: d.name,
      resource: { key: f.key ?? adoptedKey ?? '-', type: f.type, providerId: f.providerId },
      planId: plan?.id ?? null,
      label: d.label,
      detail: { finding: f.id, kind: f.kind, path: f.path, decision: input.decision, note: input.note ?? null, applied: !!jobId, ...(adoptedKey ? { adoptedAs: adoptedKey } : {}) }
    });
    return { finding: (await this.finding(f.id))!, plan, jobId };
  }

  /** Takes an unmanaged resource into the graph with its observed state as the desired one. */
  private async adoptUnmanaged(d: Deployment, f: DriftFinding, rows: GraphResource[]): Promise<GraphResource> {
    const o = f.observed as ObservedResource;
    const taken = new Set(rows.map((r) => r.key));
    const all = await this.deployments.resources(d.id, { includeDeleted: true });
    for (const r of all) taken.add(r.key);
    const key = keyFor(o.name || `${o.type}-${o.providerId}`, taken);
    const net = networkOf(o);
    const netRow = net ? rows.find((r) => r.type === 'network' && r.providerId === net) : undefined;
    const desired: DesiredResource = { key, type: o.type, spec: { ...o.props }, dependsOn: [], protect: false, region: o.region ?? null, ...(netRow ? { network: netRow.key } : {}) };
    return this.deployments.upsertResource(d.id, desired, o.region ?? d.region, { providerId: o.providerId, locator: o.locator ?? null, observed: o, state: o.state === 'ready' ? 'ready' : o.state, tags: o.tags });
  }

  // ---------- the job and its schedule ----------

  /** `cloud.drift` for one deployment. */
  async run(deploymentId: string, opts: { signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
    if (!(await this.schema.installed())) return { skipped: 'migration 149_cloud_lifecycle is not applied' };
    const d = await this.deployments.get(deploymentId);
    if (!d) return { skipped: 'no such deployment' };
    if (['draft', 'planned', 'destroying', 'destroyed'].includes(d.state)) return { skipped: `the deployment is ${d.state}` };
    if (this.deployments.leaseOf(d)) return { skipped: 'an apply is working on it' };
    if (await this.s().cloud.lifecycle.destroys.current(d.id)) return { skipped: 'it is being destroyed' };
    const out = await this.detect(d, opts.signal ? { signal: opts.signal } : {});
    return { checked: out.checked, open: out.open.length, fresh: out.fresh.length, resolved: out.resolved };
  }

  /** The deployments the schedule checks: those with live resources and no destroy under way. */
  async targets(): Promise<{ tenantId: string; payload: Record<string, unknown>; key: string }[]> {
    if (!(await this.schema.installed()) || !(await this.deployments.installed())) return [];
    const rows = (await this.s().db('cloud_deployments').whereIn('state', ['applying', 'applied', 'ready', 'degraded', 'failed']).select('id', 'tenant_id').limit(5000)) as { id: string; tenant_id: string }[];
    return rows.map((r) => ({ tenantId: r.tenant_id, payload: { deploymentId: r.id }, key: r.id }));
  }

  schedule(scheduler: Scheduler, minutes: number): void {
    if (minutes > 0) scheduler.every('cloud.drift', minutes * MIN, () => this.targets());
  }
}
