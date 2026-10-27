import { ulid } from 'ulid';
import { z } from 'zod';
import type { AuditEvent } from '../audit/chain.js';
import { authorize, type Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { loadPrincipal } from '../http/middleware.js';
import type { Services } from '../services.js';
import type { CloudActor } from './accounts.js';
import { cloudAudit } from './audit.js';
import type { DeploymentContext } from './deployments.js';
import type { LifecycleSchema } from './drift.js';
import { depsOf, type DesiredResource, type Deployment, type GraphResource, type Plan } from './graph.js';
import type { ResourceRef, SnapshotResult } from './providers/types.js';

/*
 * 1.9.99-final, Sprint 57 (B-10107): destroy and rollback. `s.cloud.lifecycle.destroys`.
 *
 * Destroy (`POST .../destroy`, then the job `cloud.destroy`, in rounds):
 *
 * - Every resource is deleted in reverse dependency order by the apply worker, through destroy plans
 *   (`s.cloud.plans`, purpose `destroy`): each round's desired graph is what must stay for now, so the planner deletes
 *   the rest, dependents first.
 * - A protected resource (the graph's `protect` flag, and every database) stays, with everything it depends on, until
 *   a second cloud admin approves deleting it (`POST .../destroy/protected/:key/approve`, a recent sign-in, never the
 *   person who asked for the destroy; a platform deployment also needs `platform:manage`). The rest of the
 *   deployment is deleted at once; the destroy then waits (`waiting`) and tells the cloud admins.
 * - Before an approved protected resource is deleted, its final snapshot is taken through the adapter's `snapshot`
 *   hook and followed until it exists; only then does the next round delete it (with `approvedProtected`). Where the
 *   adapter has no snapshot for the type, approving is refused with the reason (`snapshot_unsupported`), and the
 *   resource stays until its protection is removed from the desired graph.
 * - A round runs as an ordinary `cloud.apply` of its plan; when that apply ends, the destroy continues (an audit
 *   listener on `cloud.apply.*` queues the next `cloud.destroy`). The last round leaves the deployment `destroyed`.
 *   Rejecting an approval or cancelling a waiting destroy ends it; what was deleted stays deleted.
 *
 * Rollback: a failed apply of a deployment that passed verify before rolls its replaceable resources back to the
 * last verified state (`cloud.rollback`, queued by the listener on `cloud.apply.failed`, on behalf of the person who
 * applied): every resource that is not protected returns to its desired spec at the last passing verify, resources
 * added since are deleted, protected ones are left as they are. `POST .../rollback` does the same by hand.
 */

export const DESTROY_STATES = ['running', 'waiting', 'finished', 'failed', 'cancelled'] as const;
export type DestroyState = (typeof DESTROY_STATES)[number];

export interface ProtectedEntry {
  key: string;
  type: GraphResource['type'];
  providerId: string;
  snapshot: { state: 'none' | 'pending' | 'taken' | 'failed' | 'unsupported'; reason: string | null; name: string | null; id: string | null; at: number | null; pending?: SnapshotResult | null };
  approval: { state: 'pending' | 'approved' | 'rejected'; by: string | null; at: number | null; note: string | null };
  /** Deleted by a round. */
  deleted: boolean;
}

export interface DestroyRequest {
  id: string;
  deploymentId: string;
  tenantId: string;
  state: DestroyState;
  reason: string | null;
  requestedBy: string;
  actingUser: string;
  protected: ProtectedEntry[];
  rounds: { planId: string; jobId: string | null; at: number }[];
  jobId: string | null;
  note: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export const destroySchema = z.object({ reason: z.string().trim().max(500).optional() }).strict();
export const approvalSchema = z.object({ note: z.string().trim().max(500).optional() }).strict();

const LIVE: readonly DestroyState[] = ['running', 'waiting'];
const isProtected = (r: Pick<GraphResource, 'protect' | 'type'>) => r.protect || r.type === 'database';

function destroyFrom(r: Record<string, unknown>): DestroyRequest {
  return {
    id: String(r.id),
    deploymentId: String(r.deployment_id),
    tenantId: String(r.tenant_id),
    state: r.state as DestroyState,
    reason: (r.reason as string | null) ?? null,
    requestedBy: String(r.requested_by),
    actingUser: String(r.acting_user),
    protected: json<ProtectedEntry[]>(r.protected, []),
    rounds: json(r.rounds, []),
    jobId: (r.job_id as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    finishedAt: r.finished_at == null ? null : Number(r.finished_at)
  };
}

const stamp = (t = Date.now()) => new Date(t).toISOString().replace(/[-:T]/g, '').slice(0, 12);

export interface DestroyOptions {
  /** How long one snapshot is followed before the destroy fails. */
  maxSnapshotMs: number;
  /** The longest wait between two looks at a snapshot. */
  snapshotWaitCapMs: number;
  /** A failed apply of a verified deployment is rolled back on its own. */
  autoRollback: boolean;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(resolve, ms);
    t.unref?.();
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason ?? new Error('aborted'))), { once: true });
  });

export class CloudDestroys {
  options: DestroyOptions = { maxSnapshotMs: 2 * 60 * 60_000, snapshotWaitCapMs: 30_000, autoRollback: true, sleep: defaultSleep };

  constructor(
    private readonly s: () => Services,
    private readonly schema: LifecycleSchema
  ) {}

  private get deployments() {
    return this.s().cloud.deployments;
  }

  // ---------- reads ----------

  async get(id: string): Promise<DestroyRequest | null> {
    const r = await this.s().db('cloud_destroys').where({ id }).first();
    return r ? destroyFrom(r as Record<string, unknown>) : null;
  }

  /** The deployment's destroys, newest first. */
  async list(p: Principal, deploymentId: string): Promise<DestroyRequest[]> {
    await this.schema.need();
    await this.deployments.getFor(p, deploymentId);
    return ((await this.s().db('cloud_destroys').where({ deployment_id: deploymentId }).orderBy('created_at', 'desc').limit(50)) as Record<string, unknown>[]).map(destroyFrom);
  }

  async current(deploymentId: string): Promise<DestroyRequest | null> {
    const r = await this.s().db('cloud_destroys').where({ deployment_id: deploymentId }).whereIn('state', LIVE as string[]).orderBy('created_at', 'desc').first();
    return r ? destroyFrom(r as Record<string, unknown>) : null;
  }

  private async save(d: DestroyRequest, patch: Partial<Pick<DestroyRequest, 'state' | 'actingUser' | 'protected' | 'rounds' | 'jobId' | 'note' | 'finishedAt'>>): Promise<DestroyRequest> {
    const row: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.state) row.state = patch.state;
    if (patch.actingUser) row.acting_user = patch.actingUser;
    if (patch.protected) row.protected = JSON.stringify(patch.protected);
    if (patch.rounds) row.rounds = JSON.stringify(patch.rounds);
    if (patch.jobId !== undefined) row.job_id = patch.jobId;
    if (patch.note !== undefined) row.note = patch.note?.slice(0, 1000) ?? null;
    if (patch.finishedAt !== undefined) row.finished_at = patch.finishedAt;
    await this.s().db('cloud_destroys').where({ id: d.id }).update(row);
    return (await this.get(d.id))!;
  }

  // ---------- asking, approving ----------

  async request(a: CloudActor, deploymentId: string, input: z.infer<typeof destroySchema> = {}): Promise<{ destroy: DestroyRequest; jobId: string }> {
    await this.schema.need();
    const s = this.s();
    const d = await this.deployments.getFor(a.principal, deploymentId);
    this.deployments.assertCanDeploy(a.principal, d);
    if (d.state === 'destroyed') throw conflict(`${d.name} is already destroyed.`);
    if (await this.current(d.id)) throw new HttpProblem(409, 'Conflict', `A destroy of ${d.name} is already under way.`, { extensions: { reason: 'destroy_in_progress' } });
    const lease = this.deployments.leaseOf(d);
    if (lease) throw new HttpProblem(409, 'Conflict', `An apply (${lease.holder}) is working on ${d.name}; destroy it once that has finished.`, { extensions: { reason: 'apply_in_progress' } });
    const provider = s.cloud.providers.providerFor(d.provider);
    const rows = await this.deployments.resources(d.id);
    const prot: ProtectedEntry[] = rows
      .filter((r) => isProtected(r) && r.providerId)
      .map((r) => {
        const why = provider.snapshotSupport ? provider.snapshotSupport(r.type) : 'This adapter takes no snapshots.';
        return { key: r.key, type: r.type, providerId: r.providerId!, snapshot: { state: why ? 'unsupported' : 'none', reason: why, name: null, id: null, at: null }, approval: { state: 'pending', by: null, at: null, note: null }, deleted: false };
      });
    const id = ulid();
    const now = Date.now();
    await s.db('cloud_destroys').insert({ id, deployment_id: d.id, tenant_id: d.tenantId, state: 'running', reason: input.reason ?? null, requested_by: a.principal.userId, acting_user: a.principal.userId, protected: JSON.stringify(prot), rounds: '[]', job_id: null, note: null, created_at: now, updated_at: now, finished_at: null });
    await this.deployments.setState(d.id, 'destroying');
    await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.destroy.requested', actor: a, deploymentId: d.id, deploymentName: d.name, label: d.label, detail: { destroy: id, reason: input.reason ?? null, resources: rows.filter((r) => r.providerId).length, protected: prot.map((x) => ({ key: x.key, type: x.type, snapshot: x.snapshot.state })) } });
    const jobId = await this.queue(d, id, a.principal.userId, 'start');
    return { destroy: (await this.get(id))!, jobId };
  }

  private async queue(d: Pick<Deployment, 'tenantId'>, destroyId: string, by: string | null, step: string): Promise<string> {
    const job = await this.s().jobs.enqueue({ tenantId: d.tenantId, type: 'cloud.destroy', payload: { destroyId }, createdBy: by, dedupeKey: `cloud.destroy:${destroyId}:${step}`, maxAttempts: 5 });
    await this.s().db('cloud_destroys').where({ id: destroyId }).update({ job_id: job.id });
    return job.id;
  }

  private async live(a: CloudActor, deploymentId: string, destroyId: string): Promise<{ d: Deployment; x: DestroyRequest }> {
    await this.schema.need();
    const d = await this.deployments.getFor(a.principal, deploymentId);
    const x = await this.get(destroyId);
    if (!x || x.deploymentId !== d.id) throw notFound('Destroy');
    return { d, x };
  }

  /** A second cloud admin approves deleting a protected resource (dual control); its final snapshot is taken first. */
  async approve(a: CloudActor, deploymentId: string, destroyId: string, key: string, note: string | null): Promise<{ destroy: DestroyRequest; jobId: string | null }> {
    const { d, x } = await this.live(a, deploymentId, destroyId);
    this.deployments.assertCanDeploy(a.principal, d);
    if (!authorize(a.principal, 'cloud:admin').allow) throw forbidden('Approving the deletion of a protected resource needs cloud:admin.', { step: 'role', action: 'cloud:admin' });
    if (!LIVE.includes(x.state)) throw conflict(`The destroy is ${x.state}.`);
    if (x.requestedBy === a.principal.userId) throw forbidden('A second cloud admin approves deleting a protected resource; the person who asked for the destroy cannot.', { step: 'dual_control' });
    const entry = x.protected.find((p) => p.key === key);
    if (!entry) throw notFound('Protected resource');
    if (entry.approval.state !== 'pending') throw conflict(`Deleting ${key} was already ${entry.approval.state}.`);
    if (entry.snapshot.state === 'unsupported') throw new HttpProblem(409, 'Conflict', `${key} cannot be deleted: ${entry.snapshot.reason}`, { extensions: { reason: 'snapshot_unsupported', key } });
    entry.approval = { state: 'approved', by: a.principal.userId, at: Date.now(), note };
    const saved = await this.save(x, { protected: x.protected, actingUser: a.principal.userId, ...(x.state === 'waiting' ? { state: 'running' } : {}) });
    await cloudAudit(this.s(), { tenantId: d.tenantId, action: 'cloud.destroy.approved', actor: a, deploymentId: d.id, deploymentName: d.name, resource: { key, type: entry.type, providerId: entry.providerId }, label: d.label, detail: { destroy: x.id, note, requestedBy: x.requestedBy } });
    const jobId = x.state === 'waiting' ? await this.queue(d, x.id, a.principal.userId, `approve:${key}`) : null;
    return { destroy: saved, jobId };
  }

  /** Refusing to delete a protected resource ends the destroy; it and what it needs stay. */
  async reject(a: CloudActor, deploymentId: string, destroyId: string, key: string, note: string | null): Promise<DestroyRequest> {
    const { d, x } = await this.live(a, deploymentId, destroyId);
    this.deployments.assertCanDeploy(a.principal, d);
    if (!authorize(a.principal, 'cloud:admin').allow) throw forbidden('Deciding on a protected resource needs cloud:admin.', { step: 'role', action: 'cloud:admin' });
    if (!LIVE.includes(x.state)) throw conflict(`The destroy is ${x.state}.`);
    const entry = x.protected.find((p) => p.key === key);
    if (!entry) throw notFound('Protected resource');
    if (entry.approval.state !== 'pending') throw conflict(`Deleting ${key} was already ${entry.approval.state}.`);
    entry.approval = { state: 'rejected', by: a.principal.userId, at: Date.now(), note };
    const out = await this.end(d, x, 'cancelled', `Deleting ${key} was refused${note ? `: ${note}` : ''}; it and what it depends on are kept.`, a, { protected: x.protected });
    await cloudAudit(this.s(), { tenantId: d.tenantId, action: 'cloud.destroy.rejected', actor: a, deploymentId: d.id, deploymentName: d.name, resource: { key, type: entry.type, providerId: entry.providerId }, label: d.label, detail: { destroy: x.id, note } });
    return out;
  }

  /** Cancels a destroy that waits for approvals (a running round finishes first). */
  async cancel(a: CloudActor, deploymentId: string, destroyId: string): Promise<DestroyRequest> {
    const { d, x } = await this.live(a, deploymentId, destroyId);
    this.deployments.assertCanDeploy(a.principal, d);
    if (x.state !== 'waiting') throw conflict(x.state === 'running' ? 'A round of the destroy is running; cancel it once it waits for an approval.' : `The destroy is ${x.state}.`);
    return this.end(d, x, 'cancelled', 'Cancelled while waiting for approvals; what was deleted stays deleted.', a);
  }

  private async end(d: Deployment, x: DestroyRequest, state: Exclude<DestroyState, 'running' | 'waiting'>, note: string, actor: CloudActor | null, extra: Partial<Pick<DestroyRequest, 'protected'>> = {}): Promise<DestroyRequest> {
    const s = this.s();
    const out = await this.save(x, { state, note, finishedAt: Date.now(), ...extra });
    await this.deployments.setState(d.id, state === 'finished' ? 'destroyed' : 'failed', state === 'finished' ? { health: 'unknown', currentPlanId: null } : {});
    await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.destroy.finished', actor: actor ?? { service: 'cloud.destroy', onBehalfOf: x.actingUser }, deploymentId: d.id, deploymentName: d.name, label: d.label, detail: { destroy: x.id, state, note, rounds: out.rounds.map((r) => r.planId), protected: out.protected.map((p) => ({ key: p.key, approval: p.approval.state, snapshot: p.snapshot.state, snapshotId: p.snapshot.id, deleted: p.deleted })) } });
    return out;
  }

  // ---------- the job ----------

  /** Keys that stay this round: protected resources not yet approved and snapshotted, and everything they depend on. */
  private keep(rows: GraphResource[], x: DestroyRequest): Set<string> {
    const by = new Map(rows.map((r) => [r.key, r]));
    const ready = new Set(x.protected.filter((p) => p.approval.state === 'approved' && p.snapshot.state === 'taken').map((p) => p.key));
    const keep = new Set<string>();
    const add = (k: string) => {
      if (keep.has(k) || !by.has(k)) return;
      keep.add(k);
      const r = by.get(k)!;
      for (const dep of depsOf({ dependsOn: r.dependsOn, ...(r.desired.network ? { network: r.desired.network } : {}) })) add(dep);
    };
    for (const r of rows) if (isProtected(r) && r.providerId && !ready.has(r.key)) add(r.key);
    return keep;
  }

  /** The person a round runs as (the requester, then each approver): their account as it stands now. */
  private async actor(x: DestroyRequest): Promise<CloudActor> {
    const p = await loadPrincipal(this.s(), x.tenantId, x.actingUser, {});
    if (!p) throw new HttpProblem(409, 'Conflict', 'The person the destroy acts for is no longer active; ask for the destroy again.', { extensions: { reason: 'actor_inactive' } });
    return { principal: p, ip: null };
  }

  /** `cloud.destroy`: snapshots of approved protected resources, then the next round, or the end. */
  async run(destroyId: string, ctx: { jobId: string; signal?: AbortSignal; progress?: (pct: number, message?: string) => Promise<void> }): Promise<Record<string, unknown>> {
    if (!(await this.schema.installed())) return { skipped: 'migration 149_cloud_lifecycle is not applied' };
    const s = this.s();
    let x = await this.get(destroyId);
    if (!x) return { skipped: 'no such destroy' };
    if (x.state !== 'running') return { skipped: `the destroy is ${x.state}` };
    const d = (await this.deployments.get(x.deploymentId))!;
    // A round in flight: wait for its apply to end (the listener queues this job again then).
    const last = x.rounds.at(-1);
    if (last) {
      const plan = await s.cloud.plans.load(last.planId);
      if (plan && (plan.state === 'applying' || plan.state === 'open')) return { waiting: 'apply', plan: plan.id };
      if (plan && plan.state !== 'applied') {
        await this.end(d, x, 'failed', `The destroy round ${plan.id} ended ${plan.state}${plan.note ? `: ${plan.note}` : ''}. Ask for the destroy again to continue.`, null);
        return { state: 'failed', plan: plan.id };
      }
    }
    const rows = await this.deployments.resources(d.id);
    // Protected resources a round deleted.
    let changed = false;
    for (const p of x.protected) {
      const row = rows.find((r) => r.key === p.key);
      if (!p.deleted && !row) {
        p.deleted = true;
        changed = true;
      }
    }
    if (changed) x = await this.save(x, { protected: x.protected });
    // Final snapshots of approved protected resources.
    const todo = x.protected.filter((p) => p.approval.state === 'approved' && !p.deleted && (p.snapshot.state === 'none' || p.snapshot.state === 'pending'));
    if (todo.length) {
      const actor = await this.actor(x);
      const c = await this.deployments.context(d, 'deploy');
      for (const p of todo) {
        const row = rows.find((r) => r.key === p.key);
        if (!row) continue;
        const out = await this.snapshot(d, c, row, p, x, ctx);
        x = (await this.get(x.id))!;
        if (out.state === 'failed') {
          await this.end(d, x, 'failed', `The final snapshot of ${p.key} failed: ${out.error ?? 'no detail'}. It was not deleted.`, null);
          return { state: 'failed', key: p.key };
        }
        await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.destroy.snapshot', actor: { service: 'cloud.destroy', onBehalfOf: actor.principal.userId, jobId: ctx.jobId }, deploymentId: d.id, deploymentName: d.name, resource: { key: p.key, type: p.type, providerId: p.providerId }, label: d.label, ...(out.requestId ? { providerRequestId: out.requestId } : {}), detail: { destroy: x.id, snapshot: out.snapshotId, name: out.name } });
      }
    }
    const fresh = await this.deployments.resources(d.id);
    const keep = this.keep(fresh, x);
    const doomed = fresh.filter((r) => !keep.has(r.key));
    if (doomed.length) {
      const actor = await this.actor(x);
      const approved = x.protected.filter((p) => p.approval.state === 'approved' && p.snapshot.state === 'taken').map((p) => p.key);
      const desired: DesiredResource[] = fresh.filter((r) => keep.has(r.key)).map((r) => r.desired);
      let plan: Plan;
      try {
        plan = await s.cloud.plans.create(actor, d.id, desired, { purpose: 'destroy' });
        const { jobId } = await s.cloud.plans.apply(actor, plan.id, plan.hash, { approvedProtected: approved });
        await this.save(x, { rounds: [...x.rounds, { planId: plan.id, jobId, at: Date.now() }] });
        await ctx.progress?.(50, `Deleting ${doomed.length} resource${doomed.length === 1 ? '' : 's'}${keep.size ? `; ${keep.size} kept until approved` : ''}.`);
        return { round: plan.id, job: jobId, deleting: doomed.map((r) => r.key), keeping: [...keep] };
      } catch (err) {
        // A plan the provider or the account refuses: retried by the job (apply_in_progress), else the destroy fails.
        if (err instanceof HttpProblem && err.status === 409 && (err.extensions?.reason === 'apply_in_progress' || err.extensions?.reason === 'plan_stale')) throw err;
        await this.end(d, x, 'failed', `The destroy could not plan its next round: ${(err as Error).message}`.slice(0, 900), null);
        return { state: 'failed', error: (err as Error).message };
      }
    }
    const pending = x.protected.filter((p) => !p.deleted && fresh.some((r) => r.key === p.key));
    if (!pending.length) {
      await this.end(d, x, 'finished', 'Every resource was deleted.', null);
      return { state: 'finished' };
    }
    await this.save(x, { state: 'waiting', note: `Waiting for a second cloud admin to approve deleting ${pending.map((p) => p.key).join(', ')}.` });
    await this.tellApprovers(d, x, pending);
    return { state: 'waiting', protected: pending.map((p) => p.key) };
  }

  private async snapshot(d: Deployment, c: DeploymentContext, row: GraphResource, p: ProtectedEntry, x: DestroyRequest, ctx: { signal?: AbortSignal }): Promise<SnapshotResult> {
    const provider = c.provider;
    if (!provider.snapshot || !provider.snapshotStatus) return { state: 'failed', name: '', snapshotId: null, error: provider.snapshotSupport?.(row.type) ?? 'This adapter takes no snapshots.' };
    const ref: ResourceRef = { type: row.type, providerId: row.providerId!, region: row.region, ...(row.locator ? { locator: row.locator } : {}) };
    const callCtx = c.ctx(row.region, ctx.signal);
    const store = async (r: SnapshotResult) => {
      const fresh = (await this.get(x.id))!;
      const e = fresh.protected.find((q) => q.key === p.key)!;
      e.snapshot = { state: r.state === 'done' ? 'taken' : r.state === 'failed' ? 'failed' : 'pending', reason: r.error ?? null, name: r.name || null, id: r.snapshotId, at: r.state === 'done' ? Date.now() : null, pending: r.state === 'pending' ? r : null };
      await this.save(fresh, { protected: fresh.protected });
    };
    let r: SnapshotResult;
    try {
      r = p.snapshot.state === 'pending' && p.snapshot.pending ? p.snapshot.pending : await provider.snapshot(callCtx, ref, `exprsn-${d.name}-${p.key}-final-${stamp()}`.slice(0, 120), { purpose: 'final' });
      await store(r);
      const until = Date.now() + this.options.maxSnapshotMs;
      while (r.state === 'pending') {
        if (Date.now() > until) {
          r = { ...r, state: 'failed', error: 'The snapshot did not finish in time.' };
          break;
        }
        await this.options.sleep(Math.min(this.options.snapshotWaitCapMs, r.waitMs ?? 3000), ctx.signal);
        r = await provider.snapshotStatus(callCtx, ref, r);
        await store(r);
      }
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      r = { state: 'failed', name: p.snapshot.name ?? '', snapshotId: null, error: String((err as Error).message ?? err).slice(0, 300) };
    }
    await store(r);
    return r;
  }

  private async tellApprovers(d: Deployment, x: DestroyRequest, pending: ProtectedEntry[]): Promise<void> {
    const s = this.s();
    const userIds = (await s.cloud.accounts.cloudAdmins(d.tenantId, d.scope === 'platform')).filter((u) => u !== x.requestedBy);
    if (!userIds.length) return;
    const blocked = pending.filter((p) => p.snapshot.state === 'unsupported');
    await s.notifications
      .notify({ tenantId: d.tenantId, userIds, kind: 'cloud.destroy', title: `Destroying ${d.name} waits for you`, body: `Deleting the protected ${pending.map((p) => p.key).join(', ')} needs a second cloud admin's approval; a final snapshot is taken first.${blocked.length ? ` ${blocked.map((p) => p.key).join(', ')} cannot be snapshotted and stay until their protection is removed.` : ''}`.slice(0, 300), route: 'deployments', label: 'internal' })
      .catch((err: unknown) => s.log.warn({ err }, 'cloud destroy notice failed'));
  }

  // ---------- rollback ----------

  /** A plan back to the last verified state for the resources that are not protected, applied at once when it can be. */
  async rollback(a: CloudActor, deploymentId: string, opts: { auto?: boolean; failedPlan?: string | null } = {}): Promise<{ plan: Plan; jobId: string | null }> {
    const s = this.s();
    const d = await this.deployments.getFor(a.principal, deploymentId);
    this.deployments.assertCanDeploy(a.principal, d);
    if (d.state === 'destroying' || d.state === 'destroyed') throw conflict(`${d.name} is ${d.state}.`);
    const all = await this.deployments.resources(d.id, { includeDeleted: true });
    if (!all.some((r) => r.lastVerified)) throw new HttpProblem(409, 'Conflict', 'The deployment was never verified, so there is no state to roll back to.', { extensions: { reason: 'never_verified' } });
    const live = all.filter((r) => r.state !== 'deleted');
    const desired = new Map<string, DesiredResource>();
    // Protected resources stay as they are, with what they need.
    const keepWithDeps = (r: GraphResource) => {
      if (desired.has(r.key)) return;
      desired.set(r.key, r.desired);
      for (const k of depsOf(r.desired)) {
        const dep = live.find((x) => x.key === k);
        if (dep) keepWithDeps(dep);
      }
    };
    for (const r of all) if (r.lastVerified && !isProtected(r) && !desired.has(r.key)) desired.set(r.key, r.lastVerified.desired);
    for (const r of live) if (isProtected(r)) keepWithDeps(r);
    // A verified resource may depend on one that was not verified (and so is deleted): it keeps its current spec.
    const graph = [...desired.values()].filter((r) => depsOf(r).every((k) => desired.has(k)));
    const plan = await s.cloud.plans.create(a, d.id, graph, { purpose: 'rollback' });
    let jobId: string | null = null;
    if (plan.applicable && plan.steps.some((x) => x.action !== 'noop')) jobId = (await s.cloud.plans.apply(a, plan.id, plan.hash)).jobId;
    await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.rollback.started', actor: a, deploymentId: d.id, deploymentName: d.name, planId: plan.id, label: d.label, detail: { auto: !!opts.auto, failedPlan: opts.failedPlan ?? null, job: jobId, summary: plan.summary, applicable: plan.applicable, blockers: plan.blockers.slice(0, 20) } });
    return { plan, jobId };
  }

  /** `cloud.rollback`: the automatic rollback after a failed apply, as the person who applied. */
  async runRollback(deploymentId: string, failedPlan: string | null, userId: string | null): Promise<Record<string, unknown>> {
    const d = await this.deployments.get(deploymentId);
    if (!d) return { skipped: 'no such deployment' };
    if (!userId) return { skipped: 'nobody to act for' };
    const p = await loadPrincipal(this.s(), d.tenantId, userId, {});
    if (!p) return { skipped: 'the person who applied is no longer active' };
    try {
      const out = await this.rollback({ principal: p, ip: null }, deploymentId, { auto: true, failedPlan });
      return { plan: out.plan.id, job: out.jobId, summary: out.plan.summary };
    } catch (err) {
      if (err instanceof HttpProblem && err.status === 409 && err.extensions?.reason === 'apply_in_progress') throw err; // the job tries again
      if (err instanceof HttpProblem) return { skipped: err.message };
      throw err;
    }
  }

  // ---------- following applies ----------

  /** The audit listener: a destroy round's apply ended → the destroy goes on; a failed apply → the rollback. */
  async onAudit(e: AuditEvent): Promise<void> {
    if (!e.action.startsWith('cloud.apply.') || e.action === 'cloud.apply.started') return;
    const target = (e.target ?? {}) as Record<string, unknown>;
    const planId = typeof target.plan === 'string' ? target.plan : null;
    const deploymentId = typeof target.deployment === 'string' ? target.deployment : null;
    if (!planId || !deploymentId || !(await this.schema.installed())) return;
    const s = this.s();
    const x = await this.current(deploymentId);
    if (x && x.rounds.some((r) => r.planId === planId)) {
      await this.queue({ tenantId: x.tenantId }, x.id, x.actingUser, `after:${planId}`);
      return;
    }
    const plan = await s.cloud.plans.load(planId);
    if (!plan) return;
    if (plan.purpose === 'rollback') {
      const d = await this.deployments.get(deploymentId);
      if (d) await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.rollback.finished', actor: { service: 'cloud.rollback' }, deploymentId: d.id, deploymentName: d.name, planId, label: d.label, detail: { outcome: e.action.slice('cloud.apply.'.length) } });
      return;
    }
    if (e.action !== 'cloud.apply.failed' || plan.purpose !== 'apply' || !this.options.autoRollback) return;
    const all = await this.deployments.resources(deploymentId, { includeDeleted: true });
    if (!all.some((r) => r.lastVerified)) return;
    const actor = (e.actor ?? {}) as { user?: string };
    await s.jobs.enqueue({ tenantId: plan.tenantId, type: 'cloud.rollback', payload: { deploymentId, failedPlan: planId }, createdBy: actor.user ?? plan.createdBy, dedupeKey: `cloud.rollback:${planId}`, maxAttempts: 3 });
  }
}
