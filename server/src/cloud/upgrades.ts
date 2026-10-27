import { ulid } from 'ulid';
import { z } from 'zod';
import { authorize, type Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import type { CloudActor } from './accounts.js';
import { cloudAudit, type CloudAuditActor } from './audit.js';
import { RELEASE_NAME, RELEASE_NAMESPACE, RELEASE_SECRET, secretKeysFor, splitImage } from './chart-values.js';
import type { DesiredResource, Deployment, GraphResource, Plan } from './graph.js';
import type { KubeObject } from './kube.js';
import type { ResourceRef, SnapshotResult } from './providers/types.js';
import type { CloudReleases, ReleaseRecord } from './releases.js';
import { IMAGE_BY_DIGEST, type DeploymentSpec } from './spec.js';

/*
 * 1.9.99-final, Sprint 58 (B-10207): upgrades of a Kubernetes deployment to a new release by image digest, and the
 * database snapshots taken before them. `s.cloud.releases.upgrades`.
 *
 * Planning (`POST .../upgrades`) refuses before anything changes when the deployment has no release, the digest is
 * the running one, another upgrade is open, or no database snapshot can be taken first: a provisioned database is
 * snapshotted through the adapter's snapshot hook (since Sprint 59, B-10307, the database adapters': an RDS or Aurora
 * manual snapshot, an Azure on-demand backup, a DigitalOcean restore point); a database the deployment does not manage (data mode existing or on-prem) needs the
 * operator's own backup, named by reference (`externalBackup`). The upgrade is approved like any change: a plan with
 * the purpose `upgrade` (the current graph, so nothing at the provider changes), applied by its hash, which also puts
 * it behind the planner's checks (lease, staleness, the budgets' hard stop).
 *
 * When that plan has applied, `cloud.upgrade` runs the steps, each recorded on the upgrade:
 *
 *   1. snapshot       the database's snapshot, followed until it exists (or the operator's backup, recorded)
 *   2. migrate_check  `migrate --check` in the cluster as a Job with the new image: pending migrations that only
 *                     expand (exit 0 or 2) go on; destructive ones (3) or a database newer than the image (4) stop
 *                     the upgrade before anything is rolled (`blocked`), since running pods of the old release would
 *                     break
 *   3. rollout        `helm upgrade` to the new digest: the chart's migrate hook Job, then a rolling update (a new
 *                     pod ready before an old one goes, with Redis; `--wait`)
 *   4. verify         the deployment's readiness checks (the app's `/readyz` at its public URL among them)
 *   5. rollback       only when the rollout or verify failed: `helm rollback` to the previous revision, with no
 *                     manual step, then verify again. The database is never rolled back here: its snapshot is listed
 *                     for restore, and a restore needs one cloud admin to ask and another to approve.
 */

export const UPGRADE_STATES = ['planned', 'running', 'succeeded', 'rolled_back', 'blocked', 'failed', 'expired'] as const;
export type UpgradeState = (typeof UPGRADE_STATES)[number];
export type UpgradeStepId = 'snapshot' | 'migrate_check' | 'rollout' | 'verify' | 'rollback';

export interface UpgradeStep {
  id: UpgradeStepId;
  state: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  detail: string | null;
  at: number | null;
}

export interface Upgrade {
  id: string;
  deploymentId: string;
  tenantId: string;
  planId: string;
  fromDigest: string;
  toDigest: string;
  repository: string;
  state: UpgradeState;
  steps: UpgradeStep[];
  snapshotId: string | null;
  backup: { ref: string; note: string | null } | null;
  note: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export interface RestoreState {
  state: 'requested' | 'approved' | 'restoring' | 'restored' | 'rejected' | 'failed';
  requestedBy: string;
  requestedAt: number;
  note: string | null;
  decidedBy: string | null;
  decidedAt: number | null;
  decisionNote: string | null;
  error: string | null;
}

export interface Snapshot {
  id: string;
  deploymentId: string;
  tenantId: string;
  upgradeId: string | null;
  kind: 'provider' | 'external';
  resourceKey: string | null;
  resourceType: string | null;
  providerId: string | null;
  name: string;
  snapshotRef: string | null;
  state: 'pending' | 'available' | 'failed';
  restore: RestoreState | null;
  error: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  /** Whether a restore may be asked for now. */
  restorable: boolean;
}

export const upgradeSchema = z
  .object({
    /** The new image, by digest (`registry/repository@sha256:...`); or only its digest, keeping the repository. */
    image: z.string().max(400).regex(IMAGE_BY_DIGEST, 'an image pinned by digest (registry/repository@sha256:...)').optional(),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/, 'sha256:<64 hex>').optional(),
    /** For a database this deployment does not manage: the operator's own backup, taken before asking. */
    externalBackup: z.object({ ref: z.string().trim().min(1).max(300), note: z.string().trim().max(500).optional() }).strict().optional()
  })
  .strict()
  .refine((v) => !!v.image !== !!v.imageDigest, 'Give the new image (image) or its digest (imageDigest), not both.');
export const upgradeApplySchema = z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/, 'a plan hash') }).strict();
export const restoreSchema = z.object({ note: z.string().trim().max(500).optional() }).strict();

const STEP_IDS: UpgradeStepId[] = ['snapshot', 'migrate_check', 'rollout', 'verify'];

function upgradeFrom(r: Record<string, unknown>): Upgrade {
  return {
    id: String(r.id),
    deploymentId: String(r.deployment_id),
    tenantId: String(r.tenant_id),
    planId: String(r.plan_id),
    fromDigest: String(r.from_digest),
    toDigest: String(r.to_digest),
    repository: String(r.repository),
    state: r.state as UpgradeState,
    steps: json<UpgradeStep[]>(r.steps, []),
    snapshotId: (r.snapshot_id as string | null) ?? null,
    backup: json<Upgrade['backup']>(r.backup, null),
    note: (r.note as string | null) ?? null,
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    finishedAt: r.finished_at == null ? null : Number(r.finished_at)
  };
}

function snapshotFrom(r: Record<string, unknown>): Snapshot {
  const restore = json<RestoreState | null>(r.restore, null);
  const kind = r.kind as Snapshot['kind'];
  const state = r.state as Snapshot['state'];
  return {
    id: String(r.id),
    deploymentId: String(r.deployment_id),
    tenantId: String(r.tenant_id),
    upgradeId: (r.upgrade_id as string | null) ?? null,
    kind,
    resourceKey: (r.resource_key as string | null) ?? null,
    resourceType: (r.resource_type as string | null) ?? null,
    providerId: (r.provider_id as string | null) ?? null,
    name: String(r.name),
    snapshotRef: (r.snapshot_ref as string | null) ?? null,
    state,
    restore,
    error: (r.error as string | null) ?? null,
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    restorable: kind === 'provider' && state === 'available' && (!restore || ['rejected', 'failed', 'restored'].includes(restore.state))
  };
}

export interface UpgradeOptions {
  /** How long a snapshot is followed before the upgrade fails. */
  maxSnapshotMs: number;
  snapshotWaitMs: number;
  /** Reads of the migrate check Job before it counts as stuck. */
  checkPolls: number;
  checkWaitMs: number;
  sleep: (ms: number) => Promise<void>;
}

const stamp = (t = Date.now()) => new Date(t).toISOString().replace(/[-:T]/g, '').slice(0, 12);
const isDatabase = (r: GraphResource) => r.type === 'database' && !!r.providerId && r.state !== 'deleted';

export class CloudUpgrades {
  options: UpgradeOptions = { maxSnapshotMs: 2 * 60 * 60_000, snapshotWaitMs: 30_000, checkPolls: 120, checkWaitMs: 5000, sleep: (ms) => new Promise((r) => setTimeout(r, ms).unref?.()) };

  constructor(
    private readonly s: () => Services,
    private readonly releases: CloudReleases
  ) {}

  registerJobs(): void {
    const s = this.s();
    s.jobs.register('cloud.upgrade', async (p, ctx) => this.run(String(p.upgradeId), { jobId: ctx.job.id, onBehalfOf: ctx.job.created_by }), { timeoutMs: 3 * 60 * 60_000 });
    s.jobs.register('cloud.snapshot.restore', async (p, ctx) => this.runRestore(String(p.snapshotId), { jobId: ctx.job.id, onBehalfOf: ctx.job.created_by }), { timeoutMs: 3 * 60 * 60_000 });
  }

  private get deployments() {
    return this.s().cloud.deployments;
  }

  // ---------- reads ----------

  async get(id: string): Promise<Upgrade | null> {
    const r = await this.s().db('cloud_upgrades').where({ id }).first();
    return r ? upgradeFrom(r as Record<string, unknown>) : null;
  }

  async getFor(p: Principal, deploymentId: string, id: string): Promise<Upgrade> {
    await this.releases.need();
    await this.deployments.getFor(p, deploymentId);
    const u = await this.get(id);
    if (!u || u.deploymentId !== deploymentId) throw notFound('Upgrade');
    return u;
  }

  async list(p: Principal, deploymentId: string): Promise<Upgrade[]> {
    await this.releases.need();
    await this.deployments.getFor(p, deploymentId);
    return ((await this.s().db('cloud_upgrades').where({ deployment_id: deploymentId }).orderBy('created_at', 'desc').limit(50)) as Record<string, unknown>[]).map(upgradeFrom);
  }

  async snapshot(id: string): Promise<Snapshot | null> {
    const r = await this.s().db('cloud_snapshots').where({ id }).first();
    return r ? snapshotFrom(r as Record<string, unknown>) : null;
  }

  async snapshots(p: Principal, deploymentId: string): Promise<Snapshot[]> {
    await this.releases.need();
    await this.deployments.getFor(p, deploymentId);
    return ((await this.s().db('cloud_snapshots').where({ deployment_id: deploymentId }).orderBy('created_at', 'desc').limit(100)) as Record<string, unknown>[]).map(snapshotFrom);
  }

  private async save(u: Upgrade, patch: Partial<Pick<Upgrade, 'state' | 'steps' | 'snapshotId' | 'note' | 'finishedAt'>>): Promise<Upgrade> {
    const t = Date.now();
    await this.s().db('cloud_upgrades').where({ id: u.id }).update({ ...(patch.state ? { state: patch.state } : {}), ...(patch.steps ? { steps: JSON.stringify(patch.steps) } : {}), ...(patch.snapshotId !== undefined ? { snapshot_id: patch.snapshotId } : {}), ...(patch.note !== undefined ? { note: patch.note?.slice(0, 1000) ?? null } : {}), ...(patch.finishedAt !== undefined ? { finished_at: patch.finishedAt } : {}), updated_at: t });
    return { ...u, ...patch, updatedAt: t };
  }

  private async step(u: Upgrade, id: UpgradeStepId, state: UpgradeStep['state'], detail: string | null): Promise<Upgrade> {
    const steps = u.steps.some((x) => x.id === id) ? u.steps.map((x) => (x.id === id ? { ...x, state, detail: detail?.slice(0, 500) ?? null, at: Date.now() } : x)) : [...u.steps, { id, state, detail: detail?.slice(0, 500) ?? null, at: Date.now() }];
    return this.save(u, { steps });
  }

  // ---------- planning ----------

  /** How the database is snapshotted before an upgrade, or why it cannot be (409, before anything changes). */
  private async snapshotSource(d: Deployment, spec: DeploymentSpec, backup: Upgrade['backup']): Promise<{ kind: 'provider'; row: GraphResource } | { kind: 'external' }> {
    const db = (await this.deployments.resources(d.id)).find(isDatabase);
    if (db) {
      const c = await this.deployments.context(d, 'read');
      const why = c.provider.snapshotSupport ? c.provider.snapshotSupport('database') : 'This adapter takes no snapshots.';
      if (why) throw new HttpProblem(409, 'Conflict', `The upgrade needs a database snapshot first, and none can be taken: ${why}`, { extensions: { reason: 'snapshot_unsupported', key: db.key } });
      return { kind: 'provider', row: db };
    }
    if (spec.data.mode === 'provision') throw new HttpProblem(409, 'Conflict', 'The upgrade needs a database snapshot first, and none can be taken: the provisioned database has not been created yet (apply the deployment first).', { extensions: { reason: 'snapshot_unsupported' } });
    if (!backup) throw new HttpProblem(409, 'Conflict', `The database is not managed by this deployment (data mode ${spec.data.mode}), so Exprsn-AI cannot snapshot it. Take a backup with your own tooling first and name it in externalBackup.ref.`, { extensions: { reason: 'snapshot_unavailable' } });
    return { kind: 'external' };
  }

  /** Plans an upgrade to a new image digest: refused before anything changes when it cannot go ahead. */
  async plan(a: CloudActor, deploymentId: string, input: z.infer<typeof upgradeSchema>): Promise<{ upgrade: Upgrade; plan: Plan }> {
    const s = this.s();
    await this.releases.need();
    const d = await this.deployments.getFor(a.principal, deploymentId);
    this.deployments.assertCanDeploy(a.principal, d);
    if (d.state === 'destroying' || d.state === 'destroyed') throw conflict(`${d.name} is ${d.state}.`);
    if ((d.spec as { compute?: { shape?: string } } | null)?.compute?.shape !== 'kubernetes') throw new HttpProblem(409, 'Conflict', 'Upgrades by image digest are built for Kubernetes deployments; VM and container deployments upgrade with their targets (B-10204, B-10205).', { extensions: { reason: 'upgrade_unsupported' } });
    const spec = this.releases.specOf(d);
    const current = await this.releases.current(d.id);
    if (!current) throw new HttpProblem(409, 'Conflict', `${d.name} has no release yet; apply it first.`, { extensions: { reason: 'no_release' } });
    const to = input.image ? splitImage(input.image) : { repository: current.repository, digest: input.imageDigest! };
    if (to.digest === current.digest && to.repository === current.repository) throw new HttpProblem(409, 'Conflict', `${d.name} already runs ${to.digest}.`, { extensions: { reason: 'same_release' } });
    const open = await s.db('cloud_upgrades').where({ deployment_id: d.id }).whereIn('state', ['planned', 'running']).first('id');
    if (open) throw new HttpProblem(409, 'Conflict', 'Another upgrade of this deployment is open; finish or let it expire first.', { extensions: { reason: 'upgrade_in_progress', upgrade: (open as { id: string }).id } });
    const backup = input.externalBackup ? { ref: input.externalBackup.ref, note: input.externalBackup.note ?? null } : null;
    const source = await this.snapshotSource(d, spec, backup);
    // The plan: the current graph with the new image noted on the cluster (nothing at the provider changes).
    const desired: DesiredResource[] = (await this.deployments.desiredGraph(d.id)).map((r) => (r.type === 'kubernetes_cluster' ? { ...r, spec: { ...r.spec, helm: { ...((r.spec.helm as Record<string, unknown>) ?? {}), image: `${to.repository}@${to.digest}` } } } : r));
    const plan = await s.cloud.plans.create(a, d.id, desired, { purpose: 'upgrade' });
    const changes = plan.steps.filter((x) => x.action !== 'noop');
    if (!plan.applicable || changes.length) {
      throw new HttpProblem(409, 'Conflict', changes.length ? `The deployment's resources differ from their desired state (${changes.map((x) => `${x.key}: ${x.action}`).join(', ')}); apply or revert that first, then upgrade.` : `The upgrade plan cannot be applied: ${plan.blockers.join('; ')}`, { extensions: { reason: 'infrastructure_differs', plan: plan.id, summary: plan.summary } });
    }
    const t = Date.now();
    const steps: UpgradeStep[] = STEP_IDS.map((id) => ({ id, state: 'pending', detail: id === 'snapshot' ? (source.kind === 'external' ? `The operator's backup ${backup!.ref}.` : `A snapshot of ${source.row.key}.`) : null, at: null }));
    const u: Upgrade = { id: ulid(), deploymentId: d.id, tenantId: d.tenantId, planId: plan.id, fromDigest: current.digest, toDigest: to.digest, repository: to.repository, state: 'planned', steps, snapshotId: null, backup, note: null, createdBy: a.principal.userId, createdAt: t, updatedAt: t, finishedAt: null };
    await s.db('cloud_upgrades').insert({ id: u.id, deployment_id: d.id, tenant_id: d.tenantId, plan_id: plan.id, from_digest: u.fromDigest, to_digest: u.toDigest, repository: u.repository, state: 'planned', steps: JSON.stringify(steps), snapshot_id: null, backup: backup ? JSON.stringify(backup) : null, note: null, created_by: u.createdBy, created_at: t, updated_at: t, finished_at: null });
    await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.upgrade.planned', actor: a, deploymentId: d.id, deploymentName: d.name, planId: plan.id, label: d.label, detail: { upgrade: u.id, from: `${current.repository}@${current.digest}`, to: `${to.repository}@${to.digest}`, snapshot: source.kind, ...(backup ? { backup: backup.ref } : {}) } });
    return { upgrade: u, plan };
  }

  /** Applies the upgrade's plan by its hash; the upgrade runs when that apply has finished. */
  async apply(a: CloudActor, deploymentId: string, upgradeId: string, hash: string): Promise<{ upgrade: Upgrade; jobId: string }> {
    const u = await this.getFor(a.principal, deploymentId, upgradeId);
    if (u.state !== 'planned') throw conflict(`The upgrade is ${u.state}.`);
    const out = await this.s().cloud.plans.apply(a, u.planId, hash);
    return { upgrade: await this.save(u, { state: 'running' }), jobId: out.jobId };
  }

  /** The engine's follow-up: the upgrade plan applied → `cloud.upgrade`; it failed → the upgrade failed. */
  async afterApply(d: Deployment, plan: Plan, state: string, by: string | null): Promise<boolean> {
    const s = this.s();
    const r = await s.db('cloud_upgrades').where({ plan_id: plan.id }).first();
    if (!r) return false;
    const u = upgradeFrom(r as Record<string, unknown>);
    if (state !== 'applied') {
      await this.save(u, { state: 'failed', note: `The upgrade's plan was ${state}; nothing was upgraded.`, finishedAt: Date.now() });
      return false;
    }
    await s.jobs.enqueue({ tenantId: d.tenantId, type: 'cloud.upgrade', payload: { upgradeId: u.id }, createdBy: by ?? u.createdBy, dedupeKey: `cloud.upgrade:${u.id}`, maxAttempts: 1 });
    return true;
  }

  // ---------- the run ----------

  /** Holds the deployment's lease while `fn` runs (no apply runs beside an upgrade's changes). */
  private async leased<T>(d: Deployment, holder: string, fn: () => Promise<T>): Promise<T> {
    const deployments = this.deployments;
    const ms = this.s().cloud.engine.options.leaseMs;
    if (!(await deployments.acquireLease(d.id, holder, ms))) throw new Error(`apply_in_progress: another apply holds ${d.name}'s lease; the upgrade waits.`);
    const timer = setInterval(() => void deployments.renewLease(d.id, holder, ms).catch(() => undefined), Math.max(1000, Math.floor(ms / 3)));
    timer.unref?.();
    try {
      return await fn();
    } finally {
      clearInterval(timer);
      await deployments.releaseLease(d.id, holder);
    }
  }

  /** `cloud.upgrade`: snapshot, migrate check, rolling update, verify; the app rolls back on its own when verify fails. */
  async run(upgradeId: string, run: { jobId: string; onBehalfOf?: string | null }): Promise<Record<string, unknown>> {
    const s = this.s();
    let u = await this.get(upgradeId);
    if (!u) return { skipped: 'no such upgrade' };
    if (u.state !== 'running' && u.state !== 'planned') return { skipped: `the upgrade is ${u.state}` };
    const d = await this.deployments.get(u.deploymentId);
    if (!d) return { skipped: 'no such deployment' };
    const actor: CloudAuditActor = { service: 'cloud.upgrade', onBehalfOf: run.onBehalfOf ?? null, jobId: run.jobId };
    const by = run.onBehalfOf ?? u.createdBy;
    const spec = this.releases.specOf(d);
    const from = await this.releases.current(d.id);
    if (!from) return this.finish(u, d, actor, 'failed', 'The deployment has no release to upgrade.');
    u = await this.save(u, { state: 'running' });
    await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.upgrade.started', actor, deploymentId: d.id, deploymentName: d.name, planId: u.planId, label: d.label, detail: { upgrade: u.id, from: from.digest, to: u.toDigest } });
    const holder = `upgrade:${run.jobId}`;
    const to = { repository: u.repository, digest: u.toDigest };
    let rolled = null as ReleaseRecord | null;
    let rolloutError = null as string | null;
    try {
      await this.leased(d, holder, async () => {
        // 1. The database snapshot, before anything changes.
        u = await this.step(u!, 'snapshot', 'running', null);
        const snap = await this.takeSnapshot(d, u!, by);
        u = await this.save(u!, { snapshotId: snap.id });
        if (snap.state !== 'available') throw new StepFailed('snapshot', `The snapshot failed: ${snap.error ?? 'unknown'}; nothing was upgraded.`);
        u = await this.step(u!, 'snapshot', 'done', snap.kind === 'external' ? `The operator's backup ${snap.snapshotRef} (recorded).` : `${snap.name} (${snap.snapshotRef}).`);
        await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.upgrade.snapshot', actor, deploymentId: d.id, deploymentName: d.name, label: d.label, detail: { upgrade: u!.id, snapshot: snap.id, kind: snap.kind, ref: snap.snapshotRef } });
        // 2. migrate --check with the new image.
        u = await this.step(u!, 'migrate_check', 'running', null);
        const check = await this.migrateCheck(d, spec, to, u!.id);
        if (!check.ok) throw new StepFailed('migrate_check', check.detail, check.blocked);
        u = await this.step(u!, 'migrate_check', 'done', check.detail);
        // 3. The rolling update.
        u = await this.step(u!, 'rollout', 'running', null);
        try {
          rolled = await this.releases.deploy(d, spec, to, { reason: 'upgrade', upgradeId: u!.id, by, actor });
          u = await this.step(u!, 'rollout', 'done', `Revision ${rolled.revision} on ${to.digest}.`);
        } catch (err) {
          rolloutError = String((err as Error).message ?? err).slice(0, 500);
          u = await this.step(u!, 'rollout', 'failed', rolloutError);
        }
      });
    } catch (err) {
      if (err instanceof StepFailed) {
        u = await this.step(u!, err.stepId, 'failed', err.message);
        return this.finish(u!, d, actor, err.blocked ? 'blocked' : 'failed', err.message);
      }
      throw err;
    }
    // 4. Verify (with no lease held: verify reads the provider and the app).
    let ok = false;
    if (!rolloutError) {
      u = await this.step(u!, 'verify', 'running', null);
      const report = await s.cloud.engine.verifier.run(d.id, { jobId: run.jobId, onBehalfOf: by });
      ok = report.ok;
      const failing = [...report.resources, ...report.checks].filter((c) => c.status === 'fail' || c.status === 'unknown').map((c) => `${c.key ?? c.id}: ${c.detail}`);
      u = await this.step(u!, 'verify', ok ? 'done' : 'failed', ok ? 'Every check passed.' : failing.slice(0, 3).join(' '));
    } else u = await this.step(u!, 'verify', 'skipped', 'The rolling update failed.');
    if (ok) return this.finish(u!, d, actor, 'succeeded', null);
    // 5. The app tier rolls back by itself; the database stays as it is, its snapshot listed for restore.
    u = await this.step(u!, 'rollback', 'running', null);
    try {
      const back = await this.leased(d, holder, () => this.releases.rollbackTo(d, from, { upgradeId: u!.id, by, actor }));
      const again = await s.cloud.engine.verifier.run(d.id, { jobId: run.jobId, onBehalfOf: by });
      u = await this.step(u!, 'rollback', 'done', `Back on ${from.digest} (revision ${back.revision}); verify ${again.ok ? 'passed' : 'still fails'}.`);
      const note = `${rolloutError ? `The rolling update failed (${rolloutError.slice(0, 200)})` : 'Verify failed after the upgrade'}; the app is back on ${from.digest}. The database was not rolled back: its snapshot ${u!.snapshotId ?? ''} is listed for restore (two cloud admins).`;
      return this.finish(u!, d, actor, 'rolled_back', note, { restoredRevision: back.revision, verifyAfterRollback: again.ok });
    } catch (err) {
      u = await this.step(u!, 'rollback', 'failed', String((err as Error).message ?? err));
      return this.finish(u!, d, actor, 'failed', `The automatic rollback failed: ${String((err as Error).message ?? err).slice(0, 300)}`);
    }
  }

  private async finish(u: Upgrade, d: Deployment, actor: CloudAuditActor, state: UpgradeState, note: string | null, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const saved = await this.save(u, { state, note, finishedAt: Date.now() });
    const action = state === 'succeeded' ? 'cloud.upgrade.succeeded' : state === 'rolled_back' ? 'cloud.upgrade.rolled_back' : state === 'blocked' ? 'cloud.upgrade.blocked' : 'cloud.upgrade.failed';
    await cloudAudit(this.s(), { tenantId: d.tenantId, action, actor, deploymentId: d.id, deploymentName: d.name, planId: u.planId, label: d.label, detail: { upgrade: u.id, from: u.fromDigest, to: u.toDigest, snapshot: u.snapshotId, note, ...extra } });
    return { state: saved.state, upgrade: u.id, snapshot: u.snapshotId, note, ...extra };
  }

  /** The snapshot before an upgrade: through the adapter's hook, or the operator's backup recorded. */
  private async takeSnapshot(d: Deployment, u: Upgrade, by: string | null): Promise<Snapshot> {
    const s = this.s();
    const t = Date.now();
    const id = ulid();
    const base = { id, deployment_id: d.id, tenant_id: d.tenantId, upgrade_id: u.id, pending: null, restore: null, error: null, created_by: by, created_at: t, updated_at: t };
    if (u.backup) {
      await s.db('cloud_snapshots').insert({ ...base, kind: 'external', resource_key: null, resource_type: 'database', provider_id: null, name: `${d.name}-pre-upgrade-${stamp(t)}`, snapshot_ref: u.backup.ref, state: 'available' });
      return (await this.snapshot(id))!;
    }
    const spec = this.releases.specOf(d);
    const source = await this.snapshotSource(d, spec, null);
    if (source.kind !== 'provider') throw new StepFailed('snapshot', 'No database snapshot can be taken.');
    const row = source.row;
    const c = await this.deployments.context(d, 'deploy');
    const ref: ResourceRef = { type: row.type, providerId: row.providerId!, region: row.region, ...(row.locator ? { locator: row.locator } : {}) };
    const name = `exprsn-${d.name}-${row.key}-pre-upgrade-${stamp(t)}`.slice(0, 200);
    await s.db('cloud_snapshots').insert({ ...base, kind: 'provider', resource_key: row.key, resource_type: row.type, provider_id: row.providerId, name, snapshot_ref: null, state: 'pending' });
    const store = async (r: SnapshotResult) => s.db('cloud_snapshots').where({ id }).update({ state: r.state === 'done' ? 'available' : r.state === 'failed' ? 'failed' : 'pending', snapshot_ref: r.snapshotId, pending: r.state === 'pending' ? JSON.stringify(r) : null, error: r.error ?? null, updated_at: Date.now() });
    try {
      // B-10307 (Sprint 59): the database adapter's own snapshot (RDS manual snapshot, Azure on-demand backup, a DigitalOcean restore point).
      let r = await c.provider.snapshot!(c.ctx(row.region), ref, name, { purpose: 'upgrade' });
      const deadline = Date.now() + this.options.maxSnapshotMs;
      await store(r);
      while (r.state === 'pending') {
        if (Date.now() > deadline) {
          r = { ...r, state: 'failed', error: 'The snapshot did not finish in time.' };
          break;
        }
        await this.options.sleep(Math.min(r.waitMs ?? this.options.snapshotWaitMs, this.options.snapshotWaitMs));
        r = await c.provider.snapshotStatus!(c.ctx(row.region), ref, r);
        await store(r);
      }
      await store(r);
    } catch (err) {
      await s.db('cloud_snapshots').where({ id }).update({ state: 'failed', error: String((err as Error).message ?? err).slice(0, 1000), updated_at: Date.now() });
    }
    return (await this.snapshot(id))!;
  }

  /** `migrate --check` with the new image, as a Job in the cluster; its exit code decides. */
  private async migrateCheck(d: Deployment, spec: DeploymentSpec, image: { repository: string; digest: string }, upgradeId: string): Promise<{ ok: boolean; blocked: boolean; detail: string }> {
    const session = await this.releases.session(d);
    const name = `${RELEASE_NAME}-migrate-check-${upgradeId.slice(-8).toLowerCase()}`;
    const keys = ['session_secret', ...secretKeysFor(spec), 'database_url', ...(spec.data.mode === 'existing' && spec.data.redisUrlRef ? ['redis_url'] : [])];
    const job: KubeObject = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name, namespace: RELEASE_NAMESPACE, labels: { 'app.kubernetes.io/name': 'exprsn-ai', 'app.kubernetes.io/instance': RELEASE_NAME, 'app.kubernetes.io/component': 'migrate-check', 'app.kubernetes.io/managed-by': 'exprsn-ai' } },
      spec: {
        backoffLimit: 0,
        activeDeadlineSeconds: 600,
        ttlSecondsAfterFinished: 900,
        template: {
          metadata: { labels: { 'app.kubernetes.io/name': 'exprsn-ai', 'app.kubernetes.io/instance': RELEASE_NAME, 'app.kubernetes.io/component': 'migrate-check', 'exprsn.ai/zone': spec.zones.app } },
          spec: {
            restartPolicy: 'Never',
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            nodeSelector: { 'exprsn.ai/role': 'app' },
            securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
            containers: [
              {
                name: 'migrate-check',
                image: `${image.repository}@${image.digest}`,
                command: ['/usr/bin/tini', '--', 'node', 'server/dist/cli.js', 'migrate', '--check'],
                envFrom: [{ configMapRef: { name: RELEASE_NAME } }],
                env: keys.map((k) => ({ name: `${k.toUpperCase()}_FILE`, value: `/run/secrets/${k}` })),
                securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, capabilities: { drop: ['ALL'] } },
                volumeMounts: [{ name: 'secrets', mountPath: '/run/secrets', readOnly: true }, { name: 'tmp', mountPath: '/tmp' }],
                resources: { requests: { cpu: '100m', memory: '192Mi' }, limits: { memory: '512Mi' } }
              }
            ],
            volumes: [{ name: 'secrets', secret: { secretName: RELEASE_SECRET, defaultMode: 0o440, items: keys.map((k) => ({ key: k, path: k })) } }, { name: 'tmp', emptyDir: { sizeLimit: '64Mi' } }]
          }
        }
      }
    };
    const path = `/apis/batch/v1/namespaces/${RELEASE_NAMESPACE}/jobs/${name}`;
    await session.kube.apply(job);
    try {
      for (let i = 0; i < this.options.checkPolls; i++) {
        const j = await session.kube.get<{ status?: { succeeded?: number; failed?: number } }>(path);
        if (j?.status?.succeeded || j?.status?.failed) {
          const pods = await session.kube.jobPods(RELEASE_NAMESPACE, name);
          const code = pods.map((p) => p.status?.containerStatuses?.[0]?.state?.terminated?.exitCode).find((c) => c != null) ?? (j.status.succeeded ? 0 : null);
          if (code === 0) return { ok: true, blocked: false, detail: 'The database is up to date for the new release.' };
          if (code === 2) return { ok: true, blocked: false, detail: 'Pending migrations only expand the schema: the running pods keep working while they run.' };
          if (code === 3) return { ok: false, blocked: true, detail: 'The new release has destructive migrations: a rolling update would break the running pods. Upgrade in a maintenance window (stop the old release first).' };
          if (code === 4) return { ok: false, blocked: true, detail: 'The database is newer than the new release (a downgrade): refused.' };
          return { ok: false, blocked: false, detail: `migrate --check failed (exit ${code ?? 'unknown'}).` };
        }
        await this.options.sleep(this.options.checkWaitMs);
      }
      return { ok: false, blocked: false, detail: 'migrate --check did not finish in time.' };
    } finally {
      await session.kube.remove(path).catch(() => undefined);
    }
  }

  // ---------- restoring a snapshot (dual control) ----------

  private async live(p: Principal, deploymentId: string, snapshotId: string): Promise<{ d: Deployment; x: Snapshot }> {
    await this.releases.need();
    const d = await this.deployments.getFor(p, deploymentId);
    const x = await this.snapshot(snapshotId);
    if (!x || x.deploymentId !== d.id) throw notFound('Snapshot');
    return { d, x };
  }

  private async saveRestore(x: Snapshot, restore: RestoreState): Promise<Snapshot> {
    await this.s().db('cloud_snapshots').where({ id: x.id }).update({ restore: JSON.stringify(restore), updated_at: Date.now() });
    return (await this.snapshot(x.id))!;
  }

  /** One cloud admin asks for a restore; another approves it before anything is restored. */
  async requestRestore(a: CloudActor, deploymentId: string, snapshotId: string, note: string | null): Promise<Snapshot> {
    const { d, x } = await this.live(a.principal, deploymentId, snapshotId);
    this.deployments.assertCanDeploy(a.principal, d);
    if (x.kind === 'external') throw new HttpProblem(409, 'Conflict', `${x.snapshotRef} is the operator's own backup: restore it with the tooling that made it.`, { extensions: { reason: 'restore_external' } });
    if (!x.restorable) throw new HttpProblem(409, 'Conflict', x.state !== 'available' ? `The snapshot is ${x.state}.` : `A restore of this snapshot is already ${x.restore?.state}.`, { extensions: { reason: 'not_restorable' } });
    const saved = await this.saveRestore(x, { state: 'requested', requestedBy: a.principal.userId, requestedAt: Date.now(), note, decidedBy: null, decidedAt: null, decisionNote: null, error: null });
    await cloudAudit(this.s(), { tenantId: d.tenantId, action: 'cloud.snapshot.restore.requested', actor: a, deploymentId: d.id, deploymentName: d.name, resource: { key: x.resourceKey ?? 'db', type: x.resourceType ?? 'database', providerId: x.providerId }, label: d.label, detail: { snapshot: x.id, ref: x.snapshotRef, note } });
    const s = this.s();
    const userIds = (await s.cloud.accounts.cloudAdmins(d.tenantId, d.scope === 'platform')).filter((u) => u !== a.principal.userId);
    if (userIds.length) await s.notifications.notify({ tenantId: d.tenantId, userIds, kind: 'cloud.restore', title: `Restoring ${d.name}'s database waits for you`, body: `A restore of ${x.name} needs a second cloud admin's approval; it replaces the database's data.`, route: 'deployments', label: 'internal' }).catch((err: unknown) => s.log.warn({ err }, 'cloud restore notice failed'));
    return saved;
  }

  async approveRestore(a: CloudActor, deploymentId: string, snapshotId: string, note: string | null): Promise<{ snapshot: Snapshot; jobId: string }> {
    const { d, x } = await this.live(a.principal, deploymentId, snapshotId);
    this.deployments.assertCanDeploy(a.principal, d);
    if (!authorize(a.principal, 'cloud:admin').allow) throw forbidden('Approving a database restore needs cloud:admin.', { step: 'role', action: 'cloud:admin' });
    if (x.restore?.state !== 'requested') throw conflict(x.restore ? `The restore is ${x.restore.state}.` : 'No restore of this snapshot was asked for.');
    if (x.restore.requestedBy === a.principal.userId) throw forbidden('A second cloud admin approves a database restore; the person who asked for it cannot.', { step: 'dual_control' });
    const saved = await this.saveRestore(x, { ...x.restore, state: 'approved', decidedBy: a.principal.userId, decidedAt: Date.now(), decisionNote: note });
    await cloudAudit(this.s(), { tenantId: d.tenantId, action: 'cloud.snapshot.restore.approved', actor: a, deploymentId: d.id, deploymentName: d.name, resource: { key: x.resourceKey ?? 'db', type: x.resourceType ?? 'database', providerId: x.providerId }, label: d.label, detail: { snapshot: x.id, requestedBy: x.restore.requestedBy, note } });
    const job = await this.s().jobs.enqueue({ tenantId: d.tenantId, type: 'cloud.snapshot.restore', payload: { snapshotId: x.id }, createdBy: a.principal.userId, dedupeKey: `cloud.snapshot.restore:${x.id}:${saved.restore!.decidedAt}`, maxAttempts: 1 });
    return { snapshot: saved, jobId: job.id };
  }

  async rejectRestore(a: CloudActor, deploymentId: string, snapshotId: string, note: string | null): Promise<Snapshot> {
    const { d, x } = await this.live(a.principal, deploymentId, snapshotId);
    this.deployments.assertCanDeploy(a.principal, d);
    if (!authorize(a.principal, 'cloud:admin').allow) throw forbidden('Refusing a database restore needs cloud:admin.', { step: 'role', action: 'cloud:admin' });
    if (x.restore?.state !== 'requested') throw conflict(x.restore ? `The restore is ${x.restore.state}.` : 'No restore of this snapshot was asked for.');
    const saved = await this.saveRestore(x, { ...x.restore, state: 'rejected', decidedBy: a.principal.userId, decidedAt: Date.now(), decisionNote: note });
    await cloudAudit(this.s(), { tenantId: d.tenantId, action: 'cloud.snapshot.restore.rejected', actor: a, deploymentId: d.id, deploymentName: d.name, resource: { key: x.resourceKey ?? 'db', type: x.resourceType ?? 'database', providerId: x.providerId }, label: d.label, detail: { snapshot: x.id, note } });
    return saved;
  }

  /** `cloud.snapshot.restore`: the approved restore, through the adapter's hook. */
  async runRestore(snapshotId: string, run: { jobId: string; onBehalfOf?: string | null }): Promise<Record<string, unknown>> {
    const s = this.s();
    const x = await this.snapshot(snapshotId);
    if (!x || x.restore?.state !== 'approved') return { skipped: 'no approved restore' };
    const d = await this.deployments.get(x.deploymentId);
    if (!d) return { skipped: 'no such deployment' };
    const actor: CloudAuditActor = { service: 'cloud.snapshot.restore', onBehalfOf: run.onBehalfOf ?? null, jobId: run.jobId };
    const row = x.resourceKey ? await this.deployments.resource(d.id, x.resourceKey) : null;
    let restore: RestoreState = { ...x.restore, state: 'restoring' };
    await this.saveRestore(x, restore);
    try {
      if (!row?.providerId || !x.snapshotRef) throw new Error('The database or the snapshot is gone.');
      const c = await this.deployments.context(d, 'deploy');
      if (!c.provider.restoreSnapshot) throw new Error(`This build cannot restore a database snapshot on ${d.provider}.`);
      const ref: ResourceRef = { type: row.type, providerId: row.providerId, region: row.region, ...(row.locator ? { locator: row.locator } : {}) };
      let r = await c.provider.restoreSnapshot(c.ctx(row.region), ref, x.snapshotRef);
      const deadline = Date.now() + this.options.maxSnapshotMs;
      while (r.state === 'pending' && Date.now() < deadline && c.provider.snapshotStatus) {
        await this.options.sleep(Math.min(r.waitMs ?? this.options.snapshotWaitMs, this.options.snapshotWaitMs));
        r = await c.provider.snapshotStatus(c.ctx(row.region), ref, r);
      }
      if (r.state !== 'done') throw new Error(r.error ?? 'The restore did not finish.');
      // B-10307 (Sprint 59): a managed database restores to a new instance, which joins the graph (protected) beside the old one.
      const restoredTo = r.restoredId && row.type === 'database' ? await s.cloud.databases.adoptRestored(d, row, r.restoredId, x.snapshotRef) : null;
      restore = { ...restore, state: 'restored', error: null };
      await this.saveRestore(x, restore);
      await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.snapshot.restored', actor, deploymentId: d.id, deploymentName: d.name, resource: { key: row.key, type: row.type, providerId: row.providerId }, label: d.label, detail: { snapshot: x.id, ref: x.snapshotRef, requestedBy: x.restore.requestedBy, approvedBy: x.restore.decidedBy, ...(restoredTo ? { restoredTo } : {}) } });
      return { state: 'restored', snapshot: x.id, ...(restoredTo ? { restoredTo } : {}) };
    } catch (err) {
      restore = { ...restore, state: 'failed', error: String((err as Error).message ?? err).slice(0, 500) };
      await this.saveRestore(x, restore);
      await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.snapshot.restore.failed', actor, deploymentId: d.id, deploymentName: d.name, label: d.label, detail: { snapshot: x.id, error: restore.error } });
      return { state: 'failed', error: restore.error };
    }
  }
}

class StepFailed extends Error {
  constructor(
    readonly stepId: UpgradeStepId,
    message: string,
    readonly blocked = false
  ) {
    super(message);
  }
}
