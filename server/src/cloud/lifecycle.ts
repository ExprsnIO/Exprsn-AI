import type { Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import { CloudDestroys } from './destroy.js';
import { CloudDrift, LifecycleSchema } from './drift.js';
import { CloudOrphans } from './orphans.js';
import { CloudChangeTrail } from './change-trail.js';

/*
 * 1.9.99-final, Sprint 57 (B-10106 to B-10108): `s.cloud.lifecycle`, what happens to a deployment after its apply:
 * drift (`drift.ts`), destroy and rollback (`destroy.ts`) and the orphan sweep (`orphans.ts`). The rate limits,
 * retries, breaker and their metrics (B-10108) are in the transport every adapter call goes through
 * (`providers/transport.ts`, `limits-metrics.ts`), so the apply worker's calls are covered without hooks of their own.
 *
 * Jobs: `cloud.drift` (scheduled, per deployment), `cloud.destroy` (the rounds of a destroy), `cloud.rollback` (after
 * a failed apply), `cloud.orphans` (scheduled, per account). Nothing runs and nothing is called until a deployment
 * exists; without migration 149 the schedules queue nothing.
 */
export class CloudLifecycle {
  readonly schema: LifecycleSchema;
  readonly drift: CloudDrift;
  readonly destroys: CloudDestroys;
  readonly orphans: CloudOrphans;
  /** Sprint 62 (B-10703): who changed a drifted resource, from CloudTrail, the Activity Log or Cloudflare's audit logs. */
  readonly trail: CloudChangeTrail;
  private listening: (() => void) | null = null;
  private readonly following = new Set<Promise<void>>();

  constructor(private readonly s: () => Services) {
    this.schema = new LifecycleSchema(s);
    this.drift = new CloudDrift(s, this.schema);
    this.destroys = new CloudDestroys(s, this.schema);
    this.orphans = new CloudOrphans(s, this.schema);
    this.trail = new CloudChangeTrail(s);
  }

  installed(): Promise<boolean> {
    return this.schema.installed();
  }

  registerJobs(): void {
    const s = this.s();
    this.destroys.options.autoRollback = s.cfg.CLOUD_AUTO_ROLLBACK;
    s.jobs.register('cloud.drift', async (p, ctx) => {
      const out = await this.drift.run(String(p.deploymentId), { signal: ctx.signal });
      await ctx.progress(100, 'checked' in out ? `${String(out.checked)} resources read, ${String(out.fresh)} new findings` : String(out.skipped ?? ''));
      return out;
    }, { timeoutMs: 30 * 60_000 });
    s.jobs.register('cloud.destroy', async (p, ctx) => this.destroys.run(String(p.destroyId), { jobId: ctx.job.id, signal: ctx.signal, progress: ctx.progress }), { timeoutMs: 3 * 60 * 60_000 });
    s.jobs.register('cloud.rollback', async (p, ctx) => this.destroys.runRollback(String(p.deploymentId), p.failedPlan ? String(p.failedPlan) : null, ctx.job.created_by), { timeoutMs: 10 * 60_000 });
    s.jobs.register('cloud.orphans', async (p) => this.orphans.run(String(p.accountId)), { timeoutMs: 30 * 60_000 });
    // A destroy round's apply ended, or an apply failed: the destroy goes on, or the rollback is queued.
    this.listening ??= s.audit.onAppend((e) => {
      if (!e.action.startsWith('cloud.apply.')) return;
      const p = this.destroys.onAudit(e).catch((err: unknown) => s.log.warn({ err, action: e.action }, 'cloud lifecycle follow-up failed'));
      this.following.add(p);
      void p.finally(() => this.following.delete(p));
    });
  }

  /** Waits for the follow-ups of applies that ended (tests; shutdown). */
  async idle(): Promise<void> {
    while (this.following.size) await Promise.all([...this.following]);
  }

  schedule(scheduler: Scheduler): void {
    const cfg = this.s().cfg;
    this.drift.schedule(scheduler, cfg.CLOUD_DRIFT_MINUTES);
    this.orphans.schedule(scheduler, cfg.CLOUD_ORPHAN_SWEEP_HOURS);
  }
}
