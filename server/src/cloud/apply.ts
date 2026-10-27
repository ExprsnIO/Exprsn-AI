import { hostname } from 'node:os';
import { HttpProblem } from '../http/problem.js';
import { ServiceUrlRefused } from '../platform/egress.js';
import type { Services } from '../services.js';
import { defaultSecretBroker, vmInstallCheck, type SecretBroker } from './compute.js';
import { cloudAudit, type CloudAuditAction, type CloudAuditActor } from './audit.js';
import type { DeploymentContext } from './deployments.js';
import { depsOf, type DesiredResource, type Deployment, type GraphResource, type JournalEntry, type ObservedResource, type OperationStep, type Plan, type PlanStep, type ResourceState } from './graph.js';
import { idempotencyKey, isDone, journalId } from './journal.js';
import { fieldChanges } from './planner.js';
import { CloudProviderError, CloudUnsupported, type OperationHandle, type OperationResult, type ResourceOperation, type ResourceRef } from './providers/types.js';
import type { Provider } from './types.js';
import { CloudVerify } from './verify.js';
import { resolveSpec } from './value-from.js';
import { cloudPlaneMetrics } from './cloud-metrics.js';
import { GpuQuotas } from './gpu-quotas.js';

/*
 * 1.9.99-final, Sprint 57 (B-10104): the apply worker (`cloud.apply`), the poller of operations nobody is following
 * (`cloud.poll`) and, through `CloudVerify`, verify (`cloud.verify`). `s.cloud.engine`.
 *
 * - One apply per deployment at a time: the job takes the deployment's lease (held by the job id, renewed while it
 *   runs). A job resumed on another instance after a crash has the same id and takes the lease over; any other apply
 *   waits until the lease is released or runs out.
 * - The plan's steps run in two phases: deletions (deletes and the delete half of replaces) with dependents first,
 *   then creates, updates and the create half of replaces with dependencies first; within a phase a step starts as
 *   soon as what it waits for is done, at most `parallelism` at a time. A failed step stops new steps from starting;
 *   the steps in flight finish.
 * - Every step is journalled (`cloud/journal.ts`) before the provider call (`started`), with the operation's handle
 *   when the provider answers with one (`pending`), and when it ends. Resuming reads the journal: a done step is
 *   skipped, a pending one is polled from its stored handle (never created again), a started or failed one is run
 *   again with the same idempotency key, and the adapter's `find` adopts what a lost response already made.
 * - Long-running operations are polled with the provider's wait (capped), progress through `ctx.progress`. Cancel
 *   stops after the steps in flight; operations still pending are left to `cloud.poll`.
 * - Every provider call passes `hooks.beforeCall` and `hooks.afterCall`: the lifecycle work wires the per-account
 *   limiter and the circuit breaker there (B-10108); a `CloudProviderError` with `retryAfterSeconds` from the hook
 *   waits and retries like a throttled call.
 * - Every resource created is written with the journal step and the audit entry that created it (B-10701).
 */

export interface ProviderCallInfo {
  deploymentId: string;
  accountId: string;
  provider: Provider;
  op: ResourceOperation | 'find';
  type: string;
  key: string;
  planId: string | null;
}

/** Sprint 58: a follow-up of an apply that ended; answering true on success means it queued what comes next instead of verify. */
export type ApplyFollowUp = (e: { deployment: Deployment; plan: Plan; state: 'applied' | 'failed' | 'cancelled' | 'refused'; run: RunContext }) => Promise<boolean> | boolean;

export interface EngineHooks {
  /** Before every provider call the engine makes; throw to refuse it (a `CloudProviderError` with `retryAfterSeconds` waits and retries). */
  beforeCall?: (c: ProviderCallInfo) => Promise<void> | void;
  /** After every provider call, with how it went. */
  afterCall?: (c: ProviderCallInfo, outcome: { ok: boolean; ms: number; error?: unknown }) => Promise<void> | void;
  /** Tests: after the provider answered and before the journal records it (where a crash loses the response). */
  afterResponse?: (c: ProviderCallInfo) => Promise<void> | void;
  /**
   * Sprint 58 (B-10204, B-10205): the secret broker adapters reach through `CallContext.secrets` (values for the
   * platform's own secret store, single-use wrapped tokens for a VM's first boot); `defaultSecretBroker` in
   * `cloud/compute.ts` unless replaced.
   */
  secrets?: SecretBroker;
}

export interface EngineOptions {
  /** Steps running at once within a phase. */
  parallelism: number;
  /** How long a lease lasts without renewal (renewed every third of it). */
  leaseMs: number;
  /** How long one long-running operation is polled before the step fails. */
  maxPollMs: number;
  /** The longest wait between two polls, whatever the provider asks. */
  pollWaitCapMs: number;
  /** Attempts of one step on retryable failures (throttling, 5xx, transport errors). */
  stepAttempts: number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** This instance, as the journal records it. */
  worker: string;
}

export interface RunContext {
  jobId: string;
  /** A hard stop (shutdown, timeout, a crash in tests): in-flight work stops at once and nothing more is journalled. */
  signal?: AbortSignal;
  /** Cancel: no new step starts; steps in flight finish. */
  cancelled?: () => boolean;
  progress?: (pct: number, message?: string) => Promise<void>;
  /** The person who applied (the job's creator), named in the audit entries. */
  onBehalfOf?: string | null;
  approvedProtected?: string[];
}

export type StepResult = { outcome: 'done' | 'failed' | 'skipped' | 'cancelled' | 'pending'; providerId?: string | null; error?: string };

export interface ApplyOutcome {
  planId: string;
  state: 'applied' | 'failed' | 'cancelled' | 'refused';
  steps: { key: string; step: OperationStep | 'noop'; outcome: StepResult['outcome']; providerId?: string | null; error?: string }[];
  /** The most steps that ran at once. */
  maxInFlight: number;
  error?: string;
}

/** Thrown when the run must stop at once (no journal row for the step in flight). */
export class HardStop extends Error {
  constructor(reason: unknown) {
    super(`stopped: ${String((reason as Error)?.message ?? reason ?? 'aborted')}`);
  }
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new HardStop(signal.reason));
    const t = setTimeout(resolve, ms);
    t.unref?.();
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(new HardStop(signal.reason))), { once: true });
  });

/** Whether a failure is worth another attempt of the step, and after how long. */
export function retryPolicy(err: unknown, attempt: number): { retry: boolean; waitMs: number } {
  const backoff = Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1));
  if (err instanceof CloudUnsupported || err instanceof ServiceUrlRefused) return { retry: false, waitMs: 0 };
  if (err instanceof CloudProviderError) {
    if (err.retryAfterSeconds != null) return { retry: true, waitMs: err.retryAfterSeconds * 1000 };
    return { retry: err.status === 429 || err.status >= 500 || err.status === 0, waitMs: backoff };
  }
  if (err instanceof HttpProblem) return { retry: err.status === 429 || err.status >= 500, waitMs: backoff };
  return { retry: true, waitMs: backoff };
}
const requestIdOf = (err: unknown) => (err instanceof CloudProviderError ? err.requestId : null);
const stateOf = (o: ObservedResource | null): ResourceState => (o ? (o.state === 'ready' ? 'ready' : o.state) : 'missing');
const refOf = (r: Pick<GraphResource, 'type' | 'providerId' | 'region' | 'locator'>): ResourceRef => ({ type: r.type, providerId: r.providerId!, region: r.region, ...(r.locator ? { locator: r.locator } : {}) });

/** One run over a deployment: the apply of a plan, or the settling of pending operations. */
class Run {
  readonly latest = new Map<string, JournalEntry>();
  readonly networkIds = new Map<string, string | null>();
  readonly rows = new Map<string, GraphResource>();
  inFlight = 0;
  maxInFlight = 0;
  done = 0;

  constructor(
    private readonly engine: CloudEngine,
    private readonly s: Services,
    readonly d: Deployment,
    readonly plan: Plan | null,
    readonly c: DeploymentContext,
    readonly run: RunContext,
    readonly total: number
  ) {}

  get actor(): CloudAuditActor {
    return { service: 'cloud.apply', onBehalfOf: this.run.onBehalfOf ?? null, jobId: this.run.jobId };
  }

  async load(): Promise<void> {
    if (this.plan) for (const [k, e] of await this.s.cloud.journal.latest(this.plan.id)) this.latest.set(k, e);
    for (const r of await this.s.cloud.deployments.resources(this.d.id)) {
      this.rows.set(r.key, r);
      this.networkIds.set(r.key, r.providerId);
    }
  }

  stopIfHard(): void {
    if (this.run.signal?.aborted) throw new HardStop(this.run.signal.reason);
  }

  private info(op: ProviderCallInfo['op'], step: Pick<PlanStep, 'key' | 'type'>): ProviderCallInfo {
    return { deploymentId: this.d.id, accountId: this.c.account.id, provider: this.c.account.provider, op, type: step.type, key: step.key, planId: this.plan?.id ?? null };
  }

  /** One provider call through the hooks; a hard stop after the answer loses it, as a crash would. */
  async call<T>(info: ProviderCallInfo, fn: () => Promise<T>): Promise<T> {
    this.stopIfHard();
    const hooks = this.engine.hooks;
    await hooks.beforeCall?.(info);
    const t = Date.now();
    try {
      const out = await fn();
      await hooks.afterCall?.(info, { ok: true, ms: Date.now() - t });
      await hooks.afterResponse?.(info);
      this.stopIfHard();
      return out;
    } catch (err) {
      if (this.run.signal?.aborted) throw new HardStop(this.run.signal.reason);
      if (!(err instanceof HardStop)) await hooks.afterCall?.(info, { ok: false, ms: Date.now() - t, error: err });
      throw err;
    }
  }

  private async journal(step: Pick<PlanStep, 'key'>, kind: OperationStep, e: Partial<JournalEntry> & Pick<JournalEntry, 'state' | 'attempt'>): Promise<JournalEntry> {
    this.stopIfHard();
    const key = idempotencyKey(this.d.id, this.plan?.id ?? null, step.key, kind);
    const row = await this.s.cloud.journal.append({ deploymentId: this.d.id, planId: this.plan?.id ?? null, resourceKey: step.key, step: kind, idempotencyKey: key, jobId: this.run.jobId, worker: this.engine.options.worker, ...e });
    this.latest.set(`${step.key}|${kind}`, row);
    return row;
  }

  private desiredOf(key: string): DesiredResource | null {
    return this.plan?.desired.find((r) => r.key === key) ?? this.rows.get(key)?.desired ?? null;
  }

  private async progress(message: string): Promise<void> {
    if (this.total > 0) await this.run.progress?.(Math.min(99, Math.round((this.done / this.total) * 100)), message.slice(0, 300));
  }

  /** Runs one step of the plan (or resumes it from the journal). */
  async step(kind: OperationStep, step: PlanStep): Promise<StepResult> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      const r = await this.stepInner(kind, step);
      if (r.outcome === 'done') {
        this.done++;
        await this.progress(`${step.key}: ${kind} done`);
      }
      return r;
    } finally {
      this.inFlight--;
    }
  }

  private async stepInner(kind: OperationStep, step: PlanStep): Promise<StepResult> {
    const last = this.latest.get(`${step.key}|${kind}`);
    if (isDone(last)) {
      if (last!.providerId && (kind === 'create' || kind === 'replace.create')) this.networkIds.set(step.key, last!.providerId);
      return { outcome: 'done', providerId: last!.providerId };
    }
    if (last?.state === 'pending' && last.handle) return this.follow(kind, step, last.handle, last.attempt);
    const opts = this.engine.options;
    let attempt = last?.attempt ?? 0;
    for (;;) {
      attempt++;
      const ikey = idempotencyKey(this.d.id, this.plan?.id ?? null, step.key, kind);
      const isCreate = kind === 'create' || kind === 'replace.create';
      await this.journal(step, kind, { state: 'started', attempt, ...(isCreate ? { clientToken: ikey } : {}), providerId: step.providerId });
      try {
        const res = await this.invoke(kind, step, ikey);
        if (res === null) return this.finish(kind, step, null, { attempt });
        if (res.done) return this.finish(kind, step, res.resource, { attempt, adopted: !!res.adopted, requestId: res.requestId ?? null });
        const providerId = res.resource?.providerId ?? res.operation.ref.providerId;
        await this.journal(step, kind, { state: 'pending', attempt, handle: res.operation, providerId, providerRequestId: res.requestId ?? null });
        if (isCreate) {
          const desired = this.desiredOf(step.key)!;
          await this.s.cloud.deployments.upsertResource(this.d.id, desired, step.region, { providerId, observed: res.resource ?? null, state: 'creating' });
          this.networkIds.set(step.key, providerId);
        }
        return this.follow(kind, step, res.operation, attempt);
      } catch (err) {
        if (err instanceof HardStop) throw err;
        const policy = retryPolicy(err, attempt);
        await this.journal(step, kind, { state: 'failed', attempt, error: errText(err), providerRequestId: requestIdOf(err) });
        if (policy.retry && attempt < opts.stepAttempts && !this.run.cancelled?.()) {
          await opts.sleep(policy.waitMs, this.run.signal).catch((e) => {
            throw e instanceof HardStop ? e : new HardStop(e);
          });
          continue;
        }
        await this.auditResource('cloud.resource.failed', step, kind, null, { requestId: requestIdOf(err), detail: { error: errText(err), attempt } });
        return { outcome: 'failed', error: errText(err) };
      }
    }
  }

  /** The provider call of a step; null when there is nothing to call (a delete of what never existed). */
  private async invoke(kind: OperationStep, step: PlanStep, ikey: string): Promise<OperationResult | null> {
    const p = this.c.provider;
    const row = this.rows.get(step.key);
    const ctx = this.c.ctx(step.region, this.run.signal);
    if (kind === 'delete' || kind === 'replace.delete') {
      const pid = row?.providerId ?? step.providerId;
      if (!pid || !row) return null;
      return this.call(this.info('delete', step), () => p.delete(ctx, refOf({ ...row, providerId: pid })));
    }
    const desired = this.desiredOf(step.key)!;
    // B-10206 (Sprint 58): a DNS record's `valueFrom` is filled in from its source's address as this apply stored it.
    const spec = resolveSpec(this.s.cloud.deployments.specFor(this.d, this.c.account, desired, ikey, this.networkIds), desired, this.rows, this.c.account.provider);
    if (kind === 'update') {
      const pid = this.networkIds.get(step.key) ?? row?.providerId ?? step.providerId;
      if (!pid) throw new CloudProviderError(`${step.key} has no provider id to update.`, this.c.account.provider, 409, 'no_provider_id');
      return this.call(this.info('update', step), () => p.update(ctx, refOf({ type: step.type, providerId: pid, region: step.region, locator: row?.locator ?? null }), spec));
    }
    // Sprint 60 (B-10405): a GPU node group or VM refused for capacity is created with the next allowed type or zone.
    if ((desired.type === 'node_group' || desired.type === 'vm') && (desired.spec as { role?: string }).role === 'gpu') {
      return GpuQuotas.withFallback(spec, (attempt) => this.call(this.info('create', step), () => p.create(ctx, attempt)), async (from, to, err) => {
        desired.spec = { ...desired.spec, size: to.size, ...(to.zone ? { zone: to.zone } : {}) };
        await this.auditResource('cloud.gpu.capacity.fallback', step, kind, null, { requestId: requestIdOf(err), detail: { from, to, error: errText(err) } });
      });
    }
    return this.call(this.info('create', step), () => p.create(ctx, spec));
  }

  /** Polls a long-running operation from its handle until it settles (or the step's poll budget ends). */
  async follow(kind: OperationStep, step: Pick<PlanStep, 'key' | 'type' | 'region' | 'providerId'>, handle: OperationHandle, attempt: number): Promise<StepResult> {
    const opts = this.engine.options;
    const deadline = (handle.startedAt || Date.now()) + opts.maxPollMs;
    const ctx = this.c.ctx(step.region, this.run.signal);
    for (;;) {
      this.stopIfHard();
      if (this.run.cancelled?.()) return { outcome: 'pending', providerId: handle.ref.providerId };
      let r;
      try {
        r = await this.call(this.info('poll', step), () => this.c.provider.poll(ctx, handle));
      } catch (err) {
        if (err instanceof HardStop) throw err;
        const policy = retryPolicy(err, attempt);
        if (!policy.retry || Date.now() > deadline) {
          await this.journal(step, kind, { state: 'failed', attempt, error: errText(err), handle, providerId: handle.ref.providerId, providerRequestId: requestIdOf(err) });
          return { outcome: 'failed', error: errText(err) };
        }
        await opts.sleep(Math.min(policy.waitMs, opts.pollWaitCapMs), this.run.signal);
        continue;
      }
      if (r.state === 'succeeded') {
        let o = r.resource;
        if (!o && kind !== 'delete' && kind !== 'replace.delete') o = await this.call(this.info('describe', step), () => this.c.provider.describe(ctx, handle.ref));
        return this.finish(kind, { ...step, providerId: handle.ref.providerId } as PlanStep, o, { attempt, handle });
      }
      if (r.state === 'failed') {
        await this.journal(step, kind, { state: 'failed', attempt, error: `${r.error}${r.code ? ` (${r.code})` : ''}`, handle, providerId: handle.ref.providerId });
        await this.auditResource('cloud.resource.failed', step, kind, handle.ref.providerId, { detail: { error: r.error, code: r.code ?? null } });
        return { outcome: 'failed', error: r.error };
      }
      if (Date.now() > deadline) {
        await this.journal(step, kind, { state: 'failed', attempt, error: `Still pending after ${Math.round(opts.maxPollMs / 60_000)} minutes.`, handle, providerId: handle.ref.providerId });
        return { outcome: 'failed', error: 'timed out waiting for the provider' };
      }
      if (r.progress != null) await this.run.progress?.(Math.min(99, Math.round((this.done / Math.max(1, this.total)) * 100)), `${step.key}: ${Math.round(r.progress)}%`);
      await opts.sleep(Math.min(Math.max(0, r.waitMs), opts.pollWaitCapMs), this.run.signal);
    }
  }

  private async auditResource(action: CloudAuditAction, step: Pick<PlanStep, 'key' | 'type'>, kind: OperationStep, providerId: string | null, o: { operationId?: string; requestId?: string | null; detail?: Record<string, unknown> } = {}) {
    return cloudAudit(this.s, {
      tenantId: this.d.tenantId,
      action,
      actor: this.actor,
      deploymentId: this.d.id,
      deploymentName: this.d.name,
      planId: this.plan?.id ?? null,
      resource: { key: step.key, type: step.type, providerId },
      operationId: o.operationId ?? null,
      providerRequestId: o.requestId ?? null,
      label: this.d.label,
      detail: { step: kind, ...(o.detail ?? {}) }
    });
  }

  /** Records a finished step: the audit entry, the journal row naming it, and the graph row naming both. */
  private async finish(kind: OperationStep, step: PlanStep, observed: ObservedResource | null, meta: { attempt: number; adopted?: boolean; requestId?: string | null; handle?: OperationHandle }): Promise<StepResult> {
    const deployments = this.s.cloud.deployments;
    const opId = journalId();
    const row = this.rows.get(step.key);
    if (kind === 'delete' || kind === 'replace.delete') {
      const pid = row?.providerId ?? step.providerId ?? null;
      const audit = await this.auditResource('cloud.resource.deleted', step, kind, pid, { operationId: opId, requestId: meta.requestId ?? null, detail: kind === 'replace.delete' ? { replaced: true } : {} });
      await this.journal(step, kind, { id: opId, state: 'succeeded', attempt: meta.attempt, providerId: pid, providerRequestId: meta.requestId ?? null, auditId: audit.id, ...(meta.handle ? { handle: meta.handle } : {}) });
      if (row) {
        if (kind === 'delete') await deployments.storeObserved(this.d.id, row, null, { state: 'deleted' });
        else await deployments.upsertResource(this.d.id, row.desired, row.region, { providerId: null, observed: null, state: 'planned' });
        const fresh = await deployments.resource(this.d.id, step.key);
        if (fresh) this.rows.set(step.key, fresh);
      }
      this.networkIds.set(step.key, null);
      return { outcome: 'done', providerId: pid };
    }
    const desired = this.desiredOf(step.key);
    if (!desired) {
      await this.journal(step, kind, { id: opId, state: 'succeeded', attempt: meta.attempt, providerId: observed?.providerId ?? meta.handle?.ref.providerId ?? null, providerRequestId: meta.requestId ?? null, ...(meta.handle ? { handle: meta.handle } : {}) });
      return { outcome: 'done', providerId: observed?.providerId ?? null };
    }
    const pid = observed?.providerId ?? meta.handle?.ref.providerId ?? step.providerId ?? null;
    const isCreate = kind === 'create' || kind === 'replace.create';
    const action: CloudAuditAction = kind === 'update' ? 'cloud.resource.updated' : kind === 'replace.create' ? 'cloud.resource.replaced' : meta.adopted ? 'cloud.resource.adopted' : 'cloud.resource.created';
    const spec = deployments.specFor(this.d, this.c.account, desired, idempotencyKey(this.d.id, this.plan?.id ?? null, step.key, kind), this.networkIds);
    const audit = await this.auditResource(action, step, kind, pid, { operationId: opId, requestId: meta.requestId ?? null, detail: { attempt: meta.attempt, ...(meta.adopted ? { adopted: true } : {}), ...(isCreate ? { tags: spec.tags } : {}) } });
    await this.journal(step, kind, { id: opId, state: meta.adopted ? 'adopted' : 'succeeded', attempt: meta.attempt, providerId: pid, providerRequestId: meta.requestId ?? null, auditId: audit.id, ...(meta.handle ? { handle: meta.handle } : {}) });
    const updated = await deployments.upsertResource(this.d.id, desired, step.region, {
      providerId: pid,
      observed,
      state: stateOf(observed),
      tags: spec.tags,
      ...(observed?.locator ? { locator: observed.locator } : {}),
      ...(isCreate ? { createdByOperation: opId, createdByAudit: audit.id } : {})
    });
    await deployments.bump(this.d.id);
    this.rows.set(step.key, updated);
    this.networkIds.set(step.key, pid);
    // A create that adopted what an earlier attempt made brings it to the desired spec when it differs.
    if (isCreate && meta.adopted && observed && this.c.provider.supports(step.type, 'update') === 'built') {
      const rest = fieldChanges(desired, step.region, null, observed).filter((c) => !c.forcesReplace);
      if (rest.length) return this.step('update', { ...step, providerId: pid, action: 'update', changes: rest });
    }
    return { outcome: 'done', providerId: pid };
  }
}

export class CloudEngine {
  options: EngineOptions = {
    parallelism: 4,
    leaseMs: 120_000,
    maxPollMs: 60 * 60_000,
    pollWaitCapMs: 30_000,
    stepAttempts: 4,
    sleep: defaultSleep,
    worker: `${hostname()}:${process.pid}`
  };
  hooks: EngineHooks;
  readonly verifier: CloudVerify;
  /** Sprint 58 (B-10203, B-10207): what runs when an apply ends (`cloud/releases.ts` registers the release and the upgrade). */
  readonly followUps: ApplyFollowUp[] = [];

  constructor(private readonly s: () => Services) {
    this.verifier = new CloudVerify(s);
    // Sprint 60 (B-10401): the broker also mints a GPU VM's single-use enrolment token at create time.
    this.hooks = { secrets: { ...defaultSecretBroker(s, 900, (d, b) => s().cloud.dataTier?.intercept(d, b) ?? Promise.resolve(null)), enrol: async (d, pool, key) => (await s().cloud.gpuPools?.nodes.enrolForVm(d, pool, key)) ?? null } };
    // B-10204: an app VM whose installer refused its release fails verify.
    this.verifier.register(vmInstallCheck);
  }

  registerJobs(): void {
    const s = this.s();
    s.jobs.register(
      'cloud.apply',
      async (p, ctx) => {
        const hard = new AbortController();
        let cancelled = false;
        ctx.signal.addEventListener('abort', () => (/cancel/i.test(String((ctx.signal.reason as Error)?.message ?? '')) ? (cancelled = true) : hard.abort(ctx.signal.reason)), { once: true });
        return this.apply(String(p.planId), { jobId: ctx.job.id, signal: hard.signal, cancelled: () => cancelled, progress: ctx.progress, onBehalfOf: ctx.job.created_by, approvedProtected: Array.isArray(p.approvedProtected) ? p.approvedProtected.map(String) : [] });
      },
      { timeoutMs: 6 * 60 * 60_000 }
    );
    s.jobs.register('cloud.poll', async (p, ctx) => this.pollPending(String(p.deploymentId), { jobId: ctx.job.id, signal: ctx.signal, progress: ctx.progress, onBehalfOf: ctx.job.created_by }), { timeoutMs: 2 * 60 * 60_000 });
    s.jobs.register('cloud.verify', async (p, ctx) => this.verifier.run(String(p.deploymentId), { jobId: ctx.job.id, onBehalfOf: ctx.job.created_by, signal: ctx.signal }), { timeoutMs: 15 * 60_000 });
  }

  /** Keeps a lease alive while `fn` runs; a lost lease stops the run. */
  private async leased<T>(deploymentId: string, holder: string, run: RunContext, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const deployments = this.s().cloud.deployments;
    const lost = new AbortController();
    const outer = run.signal;
    const onAbort = () => lost.abort(outer!.reason);
    outer?.addEventListener('abort', onAbort, { once: true });
    const timer = setInterval(() => {
      void deployments.renewLease(deploymentId, holder, this.options.leaseMs).then((ok) => {
        if (!ok) lost.abort(new Error('the lease was lost'));
      }, () => undefined);
    }, Math.max(1000, Math.floor(this.options.leaseMs / 3)));
    timer.unref?.();
    try {
      return await fn(lost.signal);
    } finally {
      clearInterval(timer);
      outer?.removeEventListener('abort', onAbort);
    }
  }

  /** Applies a plan the route queued (or resumes it from the journal). */
  async apply(planId: string, run: RunContext): Promise<ApplyOutcome> {
    const s = this.s();
    const plans = s.cloud.plans;
    const deployments = s.cloud.deployments;
    const plan = await plans.load(planId);
    const refused = (error: string): ApplyOutcome => ({ planId, state: 'refused', steps: [], maxInFlight: 0, error });
    if (!plan) return refused('no such plan');
    if (plan.state === 'applied') return { planId, state: 'applied', steps: [], maxInFlight: 0 };
    if (plan.state !== 'applying') return refused(`the plan is ${plan.state}`);
    if (plan.applyJobId && plan.applyJobId !== run.jobId) return refused('another job applies this plan');
    const d = await deployments.get(plan.deploymentId);
    if (!d) return refused('no such deployment');
    if (!(await deployments.acquireLease(d.id, run.jobId, this.options.leaseMs))) throw new Error(`apply_in_progress: another apply holds ${d.name}'s lease; this one waits and retries.`);
    // B-10702: the apply duration, from this run taking the lease to its end (a resumed apply counts the resumed run).
    const startedAt = Date.now();
    const timed = (state: ApplyOutcome['state']) => cloudPlaneMetrics(s.metrics.registry).applyEnded(d.provider, state, (Date.now() - startedAt) / 1000);
    let released = false;
    const release = async () => {
      if (!released) await deployments.releaseLease(d.id, run.jobId);
      released = true;
    };
    try {
      return await this.leased(d.id, run.jobId, run, async (signal) => {
        const r: RunContext = { ...run, signal };
        let c: DeploymentContext;
        try {
          c = await deployments.context(d, 'deploy');
        } catch (err) {
          await this.endApply(d, plan, r, 'failed', `No credential: ${errText(err)}`, []);
          timed('failed');
          await release();
          return { planId, state: 'failed', steps: [], maxInFlight: 0, error: errText(err) } satisfies ApplyOutcome;
        }
        const work = plan.steps.filter((x) => x.action !== 'noop');
        const runner = new Run(this, s, d, plan, c, r, work.length + work.filter((x) => x.action === 'replace').length);
        await runner.load();
        const outcome = await this.walkPlan(runner, plan);
        if (outcome.state !== 'refused') await this.endApply(d, plan, r, outcome.state, outcome.error ?? null, outcome.steps);
        if (outcome.state !== 'refused') timed(outcome.state);
        await release();
        return outcome;
      });
    } catch (err) {
      // A hard stop (shutdown, timeout, a crash): the lease stays with this job id, so its retry resumes here.
      if (err instanceof HardStop) throw err;
      await release().catch(() => undefined);
      throw err;
    }
  }

  private async walkPlan(runner: Run, plan: Plan): Promise<ApplyOutcome> {
    const rows = runner.rows;
    const steps: ApplyOutcome['steps'] = [];
    const record = (key: string, step: OperationStep | 'noop', r: StepResult) => steps.push({ key, step, outcome: r.outcome, ...(r.providerId !== undefined ? { providerId: r.providerId } : {}), ...(r.error ? { error: r.error } : {}) });
    // Phase 1: deletions, dependents first.
    const phase1 = plan.steps.filter((x) => x.action === 'delete' || x.action === 'replace');
    const inPhase1 = new Set(phase1.map((x) => x.key));
    const dependents = (key: string) => [...rows.values()].filter((r) => depsOf({ dependsOn: r.dependsOn, ...(r.desired.network ? { network: r.desired.network } : {}) }).includes(key)).map((r) => r.key);
    const one = await this.walk(
      runner,
      phase1.map((x) => ({ id: x.key, waitFor: dependents(x.key).filter((k) => inPhase1.has(k) && k !== x.key), run: () => runner.step(x.action === 'replace' ? 'replace.delete' : 'delete', x) }))
    );
    for (const x of phase1) record(x.key, x.action === 'replace' ? 'replace.delete' : 'delete', one.get(x.key) ?? { outcome: 'skipped' });
    const failed1 = [...one.values()].find((r) => r.outcome === 'failed');
    if (failed1 || runner.run.cancelled?.()) return this.outcome(runner, plan, steps, failed1 ? 'failed' : 'cancelled', failed1?.error);
    // Phase 2: creates, updates and the create half of replaces, dependencies first.
    const phase2 = plan.steps.filter((x) => x.action === 'create' || x.action === 'update' || x.action === 'replace');
    const inPhase2 = new Set(phase2.map((x) => x.key));
    const two = await this.walk(
      runner,
      phase2.map((x) => ({ id: x.key, waitFor: x.dependsOn.filter((k) => inPhase2.has(k)), run: () => runner.step(x.action === 'replace' ? 'replace.create' : x.action === 'update' ? 'update' : 'create', x) }))
    );
    for (const x of phase2) record(x.key, x.action === 'replace' ? 'replace.create' : (x.action as OperationStep), two.get(x.key) ?? { outcome: 'skipped' });
    for (const x of plan.steps.filter((y) => y.action === 'noop')) record(x.key, 'noop', { outcome: 'done', providerId: x.providerId });
    const failed2 = [...two.values()].find((r) => r.outcome === 'failed');
    const pending = [...two.values()].some((r) => r.outcome === 'pending');
    return this.outcome(runner, plan, steps, failed2 ? 'failed' : runner.run.cancelled?.() || pending ? 'cancelled' : 'applied', failed2?.error);
  }

  private outcome(runner: Run, plan: Plan, steps: ApplyOutcome['steps'], state: ApplyOutcome['state'], error?: string): ApplyOutcome {
    return { planId: plan.id, state, steps, maxInFlight: runner.maxInFlight, ...(error ? { error } : {}) };
  }

  /** Runs nodes as their dependencies finish, at most `parallelism` at once; a failure or cancel starts nothing new. */
  private async walk(runner: Run, nodes: { id: string; waitFor: string[]; run: () => Promise<StepResult> }[]): Promise<Map<string, StepResult>> {
    const results = new Map<string, StepResult>();
    const running = new Map<string, Promise<void>>();
    const queue = [...nodes];
    let hard: unknown = null;
    let stop = false;
    while (queue.length || running.size) {
      if (!stop && !hard && !runner.run.cancelled?.()) {
        for (const n of [...queue]) {
          if (running.size >= this.options.parallelism) break;
          if (n.waitFor.some((w) => !results.has(w))) continue;
          queue.splice(queue.indexOf(n), 1);
          if (n.waitFor.some((w) => results.get(w)!.outcome !== 'done')) {
            results.set(n.id, { outcome: 'skipped', error: 'a step it waits for did not finish' });
            continue;
          }
          running.set(
            n.id,
            n
              .run()
              .then((r) => void results.set(n.id, r))
              .catch((err) => {
                if (err instanceof HardStop) hard ??= err;
                results.set(n.id, { outcome: 'failed', error: errText(err) });
              })
              .finally(() => running.delete(n.id))
          );
        }
      }
      if (!running.size) break;
      await Promise.race(running.values());
      if ([...results.values()].some((r) => r.outcome === 'failed')) stop = true;
    }
    if (hard) throw hard;
    for (const n of queue) if (!results.has(n.id)) results.set(n.id, { outcome: runner.run.cancelled?.() ? 'cancelled' : 'skipped' });
    return results;
  }

  private async endApply(d: Deployment, plan: Plan, run: RunContext, state: ApplyOutcome['state'], error: string | null, steps: ApplyOutcome['steps']): Promise<void> {
    const s = this.s();
    const summary = await s.cloud.journal.summary(plan.id);
    const actor: CloudAuditActor = { service: 'cloud.apply', onBehalfOf: run.onBehalfOf ?? null, jobId: run.jobId };
    const counts = steps.reduce<Record<string, number>>((acc, x) => ((acc[`${x.step}:${x.outcome}`] = (acc[`${x.step}:${x.outcome}`] ?? 0) + 1), acc), {});
    if (state === 'applied') {
      await s.cloud.plans.setState(plan.id, 'applied', null, { appliedAt: Date.now() });
      // A destroy round (B-10107) leaves the deployment to the destroy, which goes on or ends it; nothing is verified.
      const destroying = plan.purpose === 'destroy';
      await s.cloud.deployments.setState(d.id, destroying ? 'destroying' : 'applied', { health: 'unknown' });
      await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.apply.succeeded', actor, deploymentId: d.id, deploymentName: d.name, planId: plan.id, label: d.label, detail: { hash: plan.hash, steps: counts, journal: summary } });
      // Sprint 58 (B-10203, B-10207): a follow-up may take over what comes next (a Kubernetes release is installed
      // first and verified after it; an upgrade plan starts the upgrade), else verify is queued.
      const followed = await this.followUp(d, plan, state, run);
      if (!destroying && !followed) await s.jobs.enqueue({ tenantId: d.tenantId, type: 'cloud.verify', payload: { deploymentId: d.id, planId: plan.id }, createdBy: run.onBehalfOf ?? null, dedupeKey: `cloud.verify:${plan.id}`, maxAttempts: 2 });
      return;
    } else if (state === 'cancelled') {
      await s.cloud.plans.setState(plan.id, 'cancelled', 'Cancelled; the steps in flight finished.');
      await s.cloud.deployments.setState(d.id, 'failed');
      await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.apply.cancelled', actor, deploymentId: d.id, deploymentName: d.name, planId: plan.id, label: d.label, detail: { hash: plan.hash, steps: counts, journal: summary } });
      if ((await s.cloud.journal.pending(d.id)).length) await s.jobs.enqueue({ tenantId: d.tenantId, type: 'cloud.poll', payload: { deploymentId: d.id }, createdBy: run.onBehalfOf ?? null, dedupeKey: `cloud.poll:${d.id}:${plan.id}`, maxAttempts: 3 });
    } else {
      await s.cloud.plans.setState(plan.id, 'failed', (error ?? 'failed').slice(0, 500));
      await s.cloud.deployments.setState(d.id, 'failed');
      await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.apply.failed', actor, deploymentId: d.id, deploymentName: d.name, planId: plan.id, label: d.label, detail: { hash: plan.hash, error, steps: counts, journal: summary, rollback: 'offered' } });
    }
    await this.followUp(d, plan, state, run);
  }

  /** Runs the registered follow-ups of an apply that ended; true when one took over what comes next. */
  private async followUp(d: Deployment, plan: Plan, state: ApplyOutcome['state'], run: RunContext): Promise<boolean> {
    let took = false;
    for (const f of this.followUps) {
      try {
        if (await f({ deployment: d, plan, state, run })) took = true;
      } catch (err) {
        this.s().log.warn({ err, plan: plan.id }, 'cloud apply follow-up failed');
      }
    }
    return took;
  }

  /**
   * Settles the operations of a deployment that are still pending with nobody polling them (after a cancel, a failed
   * apply, a destroy): polls each from its stored handle and journals how it ended. Skipped while an apply holds the
   * lease (it polls its own).
   */
  async pollPending(deploymentId: string, run: RunContext): Promise<{ settled: number; pending: number; skipped?: string }> {
    const s = this.s();
    const deployments = s.cloud.deployments;
    const d = await deployments.get(deploymentId);
    if (!d) return { settled: 0, pending: 0, skipped: 'no such deployment' };
    const holder = `poll:${run.jobId}`;
    if (!(await deployments.acquireLease(d.id, holder, this.options.leaseMs))) return { settled: 0, pending: 0, skipped: 'an apply holds the lease' };
    try {
      return await this.leased(d.id, holder, run, async (signal) => {
        const entries = await s.cloud.journal.pending(d.id);
        if (!entries.length) return { settled: 0, pending: 0 };
        const c = await deployments.context(d, 'deploy');
        let settled = 0;
        let pending = 0;
        const byPlan = new Map<string | null, JournalEntry[]>();
        for (const e of entries) byPlan.set(e.planId, [...(byPlan.get(e.planId) ?? []), e]);
        for (const [planId, list] of byPlan) {
          const plan = planId ? await s.cloud.plans.load(planId) : null;
          const runner = new Run(this, s, d, plan, c, { ...run, signal }, list.length);
          await runner.load();
          for (const e of list) {
            const row = runner.rows.get(e.resourceKey);
            const step = { key: e.resourceKey, type: e.handle!.type, region: row?.region ?? e.handle!.ref.region ?? d.region, providerId: e.providerId };
            const r = await runner.follow(e.step, step, e.handle!, e.attempt);
            if (r.outcome === 'pending') pending++;
            else settled++;
          }
        }
        return { settled, pending };
      });
    } finally {
      await deployments.releaseLease(d.id, holder);
    }
  }
}

const errText = (err: unknown) => String((err as Error)?.message ?? err).slice(0, 1000);
