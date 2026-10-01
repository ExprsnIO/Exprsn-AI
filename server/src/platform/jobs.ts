import { hostname } from 'node:os';
import { ulid } from 'ulid';
import type { Logger } from 'pino';
import { Queue, Worker } from 'bullmq';
import { json, type Db } from '../db/knex.js';
import { isUniqueViolation } from '../audit/chain.js';
import { TOPICS, type Bus } from './bus.js';
import { activeSpan, SpanKind, type Tracer } from '../observability/tracing.js';

export const JOB_STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'preempted'] as const;
export type JobState = (typeof JOB_STATES)[number];

export interface JobRow {
  id: string;
  tenant_id: string;
  type: string;
  state: JobState;
  payload: Record<string, unknown>;
  result: unknown;
  error: string | null;
  progress: number;
  message: string | null;
  attempts: number;
  max_attempts: number;
  created_by: string | null;
  dedupe_key: string | null;
  worker: string | null;
  run_at: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface JobContext {
  job: JobRow;
  /** Reports progress (0–100) and an optional message; persisted and pushed to the submitter's sockets. */
  progress(pct: number, message?: string): Promise<void>;
  /** Aborted when the job is cancelled or times out. */
  signal: AbortSignal;
  log: Logger;
}

export type JobHandler = (payload: Record<string, unknown>, ctx: JobContext) => Promise<unknown>;

interface Registration {
  handler: JobHandler;
  timeoutMs: number;
}

export interface EnqueueInput {
  tenantId: string;
  type: string;
  payload?: Record<string, unknown>;
  createdBy?: string | null;
  runAt?: number;
  /** Jobs with the same key are enqueued once; the existing job is returned. */
  dedupeKey?: string;
  maxAttempts?: number;
}

export interface JobProgressEvent {
  id: string;
  tenantId: string;
  createdBy: string | null;
  type: string;
  state: JobState;
  progress: number;
  message: string | null;
  error: string | null;
}

const fromRow = (r: Record<string, unknown>): JobRow => ({
  id: String(r.id),
  tenant_id: String(r.tenant_id),
  type: String(r.type),
  state: r.state as JobState,
  payload: json<Record<string, unknown>>(r.payload, {}),
  result: json<unknown>(r.result, null),
  error: (r.error as string | null) ?? null,
  progress: Number(r.progress),
  message: (r.message as string | null) ?? null,
  attempts: Number(r.attempts),
  max_attempts: Number(r.max_attempts),
  created_by: (r.created_by as string | null) ?? null,
  dedupe_key: (r.dedupe_key as string | null) ?? null,
  worker: (r.worker as string | null) ?? null,
  run_at: Number(r.run_at),
  created_at: Number(r.created_at),
  started_at: r.started_at == null ? null : Number(r.started_at),
  finished_at: r.finished_at == null ? null : Number(r.finished_at)
});

/**
 * Durable jobs. The `jobs` table is the source of truth for state and progress in both modes:
 *   - db:     workers poll the table and claim a job with a conditional update (single node, no Redis)
 *   - bullmq: BullMQ (Redis) dispatches job ids to workers on any instance; the claim is the same update
 * Failed attempts are retried with exponential backoff up to max_attempts. A job whose worker died is
 * returned to the queue once its lock expires.
 */
export class JobQueue {
  private readonly handlers = new Map<string, Registration>();
  private readonly running = new Map<string, AbortController>();
  private readonly workerId = `${hostname()}:${process.pid}`;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private readonly offCancel: () => void;
  /** B-1401: when set, each job runs in a span that joins the trace of the request that queued it. */
  tracer: Tracer | null = null;
  /**
   * B-1403: asked before every claim; a reason (the schema handshake found the database newer than this build) means
   * this instance takes no jobs. The jobs stay queued for an up-to-date instance.
   */
  gate: (() => string | null) | null = null;

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    private readonly bus: Bus,
    private readonly opts: { mode: 'db' | 'bullmq'; redisUrl?: string; pollMs: number; concurrency: number }
  ) {
    this.offCancel = bus.on<{ id: string }>(TOPICS.jobCancel, ({ id }) => this.running.get(id)?.abort(new Error('cancelled')));
  }

  get mode(): 'db' | 'bullmq' {
    return this.opts.mode;
  }

  register(type: string, handler: JobHandler, opts: { timeoutMs?: number } = {}): void {
    this.handlers.set(type, { handler, timeoutMs: opts.timeoutMs ?? 10 * 60_000 });
  }

  async enqueue(input: EnqueueInput): Promise<JobRow> {
    const t = Date.now();
    const row = {
      id: ulid(),
      tenant_id: input.tenantId,
      type: input.type,
      state: 'queued',
      payload: JSON.stringify(input.payload ?? {}),
      progress: 0,
      attempts: 0,
      max_attempts: input.maxAttempts ?? 3,
      created_by: input.createdBy ?? null,
      dedupe_key: input.dedupeKey ?? null,
      run_at: input.runAt ?? t,
      created_at: t,
      // B-1401: the job's spans join the trace that queued it (only when that trace is recorded).
      trace_parent: activeSpan()?.traceparent ?? null
    };
    try {
      await this.db('jobs').insert(row);
    } catch (err) {
      if (input.dedupeKey && isUniqueViolation(err)) return fromRow(await this.db('jobs').where({ dedupe_key: input.dedupeKey }).first());
      throw err;
    }
    await this.dispatch(row.id, row.run_at);
    this.emit(fromRow(row));
    return fromRow(row);
  }

  private async dispatch(id: string, runAt: number, attempt = 0): Promise<void> {
    if (this.queue) await this.queue.add('job', { id }, { jobId: `${id}-${attempt}`, delay: Math.max(0, runAt - Date.now()), removeOnComplete: true, removeOnFail: true });
  }

  async get(tenantId: string, id: string): Promise<JobRow | undefined> {
    const r = await this.db('jobs').where({ tenant_id: tenantId, id }).first();
    return r ? fromRow(r) : undefined;
  }

  async list(tenantId: string, opts: { limit?: number; type?: string; createdBy?: string } = {}): Promise<JobRow[]> {
    const q = this.db('jobs').where({ tenant_id: tenantId });
    if (opts.type) q.andWhere({ type: opts.type });
    if (opts.createdBy) q.andWhere({ created_by: opts.createdBy });
    return (await q.orderBy('created_at', 'desc').limit(Math.min(opts.limit ?? 50, 500))).map(fromRow);
  }

  async cancel(tenantId: string, id: string): Promise<JobRow | undefined> {
    const job = await this.get(tenantId, id);
    if (!job) return undefined;
    if (job.state === 'queued') {
      await this.db('jobs').where({ id, state: 'queued' }).update({ state: 'cancelled', finished_at: Date.now(), message: 'Cancelled before it started' });
    } else if (job.state === 'running') {
      this.bus.publish(TOPICS.jobCancel, { id });
    }
    const after = (await this.get(tenantId, id))!;
    this.emit(after);
    return after;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (this.opts.mode === 'bullmq' && this.opts.redisUrl) {
      const connection = { url: this.opts.redisUrl };
      this.queue = new Queue('exprsn-jobs', { connection });
      this.worker = new Worker('exprsn-jobs', async (j) => this.claimAndRun(String((j.data as { id: string }).id)), { connection, concurrency: this.opts.concurrency });
      this.worker.on('error', (err) => this.log.warn({ err: err.message }, 'bullmq worker error'));
    }
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.recoverStale();
        // In BullMQ mode the (slower) poll only catches jobs whose dispatch was lost, for example when Redis restarted.
        await this.pollOnce();
      } catch (err) {
        this.log.warn({ err }, 'job poll failed');
      }
      if (!this.stopped) this.timer = setTimeout(tick, this.opts.mode === 'db' ? this.opts.pollMs : Math.max(this.opts.pollMs, 30_000));
    };
    this.timer = setTimeout(tick, 10);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const c of this.running.values()) c.abort(new Error('shutting down'));
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
    this.worker = null;
    this.queue = null;
    this.offCancel();
  }

  /** Claims and runs due jobs until none are left (or `max` ran). Used by the poller and by tests. */
  async runDue(max = 100): Promise<number> {
    let n = 0;
    while (n < max) {
      const ran = await this.pollOnce(1);
      if (!ran) break;
      n += ran;
    }
    return n;
  }

  private async pollOnce(limit = this.opts.concurrency - this.running.size): Promise<number> {
    if (limit <= 0) return 0;
    if (this.gate?.()) return 0;
    const types = [...this.handlers.keys()];
    if (!types.length) return 0;
    const due = await this.db('jobs').where({ state: 'queued' }).whereIn('type', types).andWhere('run_at', '<=', Date.now()).orderBy('run_at').limit(limit).select('id');
    let ran = 0;
    await Promise.all(
      due.map(async (d: { id: string }) => {
        if (await this.claimAndRun(d.id)) ran++;
      })
    );
    return ran;
  }

  private async recoverStale(): Promise<void> {
    const stale = await this.db('jobs').where({ state: 'running' }).andWhere('locked_until', '<', Date.now()).select('id', 'attempts', 'max_attempts');
    for (const s of stale as { id: string; attempts: number; max_attempts: number }[]) {
      const retry = Number(s.attempts) < Number(s.max_attempts);
      await this.db('jobs')
        .where({ id: s.id, state: 'running' })
        .andWhere('locked_until', '<', Date.now())
        .update(retry ? { state: 'queued', run_at: Date.now(), worker: null, message: 'Worker stopped responding; retrying' } : { state: 'failed', finished_at: Date.now(), error: 'Worker stopped responding' });
      if (retry) await this.dispatch(s.id, Date.now(), Number(s.attempts));
    }
  }

  /** Returns true when this worker claimed and ran the job. */
  private async claimAndRun(id: string): Promise<boolean> {
    if (this.gate?.()) return false;
    const row = await this.db('jobs').where({ id }).first();
    if (!row) return false;
    const reg = this.handlers.get(String(row.type));
    if (!reg) return false;
    const t = Date.now();
    const claimed = await this.db('jobs')
      .where({ id, state: 'queued' })
      .andWhere('run_at', '<=', t)
      .update({ state: 'running', worker: this.workerId, started_at: t, attempts: Number(row.attempts) + 1, locked_until: t + reg.timeoutMs + 30_000, message: null });
    if (claimed !== 1) return false;
    const job = fromRow({ ...row, state: 'running', attempts: Number(row.attempts) + 1, started_at: t });
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(new Error(`timed out after ${reg.timeoutMs} ms`)), reg.timeoutMs);
    this.running.set(id, ac);
    this.emit(job);
    const log = this.log.child({ job: id, type: job.type, tenant: job.tenant_id });
    const span = this.tracer?.startRoot(`job ${job.type}`, SpanKind.CONSUMER, { traceparent: (row.trace_parent as string | null | undefined) ?? null, attributes: { 'exprsn.job.type': job.type, 'exprsn.job.id': id, 'exprsn.job.attempt': job.attempts } });
    try {
      const ctx: JobContext = {
        job,
        signal: ac.signal,
        log,
        progress: async (pct, message) => {
          job.progress = Math.max(0, Math.min(100, Math.round(pct)));
          job.message = message?.slice(0, 300) ?? job.message;
          await this.db('jobs').where({ id }).update({ progress: job.progress, message: job.message });
          this.emit(job);
        }
      };
      const result = await Promise.race([
        this.tracer ? this.tracer.run(span, () => reg.handler(job.payload, ctx)) : reg.handler(job.payload, ctx),
        new Promise<never>((_, reject) => ac.signal.addEventListener('abort', () => reject(ac.signal.reason as Error), { once: true }))
      ]);
      await this.db('jobs').where({ id }).update({ state: 'succeeded', progress: 100, result: JSON.stringify(result ?? null), finished_at: Date.now(), locked_until: null });
      Object.assign(job, { state: 'succeeded', progress: 100 });
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      const cancelled = ac.signal.aborted && /cancel/.test(String((ac.signal.reason as Error)?.message));
      const shutdown = ac.signal.aborted && /shutting down/.test(String((ac.signal.reason as Error)?.message));
      if (cancelled) {
        await this.db('jobs').where({ id }).update({ state: 'cancelled', finished_at: Date.now(), locked_until: null, message: 'Cancelled' });
        Object.assign(job, { state: 'cancelled' });
      } else if (shutdown) {
        await this.db('jobs').where({ id }).update({ state: 'queued', run_at: Date.now(), locked_until: null, worker: null, attempts: job.attempts - 1, message: 'Preempted by shutdown; will resume' });
        Object.assign(job, { state: 'queued' });
      } else if (job.attempts < job.max_attempts) {
        const runAt = Date.now() + 1000 * 2 ** job.attempts;
        await this.db('jobs').where({ id }).update({ state: 'queued', run_at: runAt, locked_until: null, worker: null, error: message.slice(0, 1000), message: `Attempt ${job.attempts} failed; retrying` });
        await this.dispatch(id, runAt, job.attempts);
        Object.assign(job, { state: 'queued' });
      } else {
        log.warn({ err: message }, 'job failed');
        await this.db('jobs').where({ id }).update({ state: 'failed', error: message.slice(0, 1000), finished_at: Date.now(), locked_until: null });
        Object.assign(job, { state: 'failed', error: message });
      }
    } finally {
      clearTimeout(timeout);
      this.running.delete(id);
      if (span) {
        span.setAttribute('exprsn.job.outcome', job.state);
        if (job.state === 'succeeded') span.ok();
        else if (job.state === 'failed' || job.state === 'queued') span.fail(job.state === 'failed' ? 'JobFailed' : 'JobRetried');
        span.end();
      }
      this.emit(job);
    }
    return true;
  }

  private emit(job: JobRow): void {
    const e: JobProgressEvent = { id: job.id, tenantId: job.tenant_id, createdBy: job.created_by, type: job.type, state: job.state, progress: job.progress, message: job.message, error: job.state === 'failed' ? job.error : null };
    this.bus.emitLocal(TOPICS.jobProgress, e);
  }
}

/**
 * Enqueues recurring jobs. Each tick uses a dedupe key per time bucket, so however many instances run the
 * scheduler, each bucket's job is enqueued once.
 */
export class Scheduler {
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly jobs: JobQueue,
    private readonly log: Logger
  ) {}

  every(name: string, everyMs: number, targets: () => Promise<{ tenantId: string; payload?: Record<string, unknown>; key?: string }[]>, type = name): void {
    if (everyMs <= 0) return;
    const tick = async () => {
      try {
        const bucket = Math.floor(Date.now() / everyMs);
        for (const t of await targets()) {
          await this.jobs.enqueue({ tenantId: t.tenantId, type, payload: t.payload ?? {}, dedupeKey: `${name}:${t.key ?? t.tenantId}:${bucket}`, maxAttempts: 1 });
        }
      } catch (err) {
        this.log.warn({ err, schedule: name }, 'scheduled enqueue failed');
      }
    };
    const timer = setInterval(() => void tick(), Math.min(everyMs, 60_000));
    timer.unref();
    this.timers.push(timer);
    void tick();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
  }
}
