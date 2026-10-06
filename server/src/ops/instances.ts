import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { json } from '../db/knex.js';
import { conflict, notFound } from '../http/problem.js';
import { TOPICS, type Bus } from '../platform/bus.js';
import type { Services } from '../services.js';
import { audit, type OpsActor } from './common.js';

/*
 * 1.6.0 (B-4202): the server instances, for the Overview screen. Every server process writes one row of
 * `platform_instances` at start and then every `heartbeatMs`: what its `/readyz` answered (the same checks), its
 * schema handshake, the jobs it has claimed, its sockets, its rate-limit store, its tracing counters and its last NTP
 * offset. An instance whose beat is older than three intervals is shown as not answering; a clean shutdown removes its
 * row.
 *
 * Drain (Q14: from the console, with a confirm and a recent sign-in): an administrator sets `drain` on the row and
 * publishes `TOPICS.instanceDrain`; the instance itself takes it from the bus at once, or from its row at the next beat.
 * A draining instance claims no jobs (the job queue's gate), answers `/readyz` with 503 and `checks.shutdown`
 * "draining" so a load balancer sends it nothing new, and finishes what it has. Nothing is restarted from the console;
 * a restart (a new process, a new row) ends the drain.
 */

export type InstanceState = 'ready' | 'not ready' | 'draining' | 'not answering';

export interface InstanceRuntime {
  rateLimit: { kind: 'memory' | 'redis'; degraded: boolean; since: number | null; detail: string | null };
  tracing: { enabled: boolean; exported: number; dropped: number; failed: number };
  ntpOffsetMs: number | null;
  jobQueue: 'db' | 'bullmq';
  concurrency: number;
  workersEnabled: boolean;
}

export interface InstanceView {
  id: string;
  node: string;
  pid: number;
  role: string;
  version: string;
  state: InstanceState;
  checks: Record<string, string>;
  schema: { state: string | null; detail: string | null };
  jobsClaimed: number;
  sockets: number;
  runtime: InstanceRuntime;
  drain: boolean;
  drainedBy: string | null;
  drainedAt: number | null;
  startedAt: number;
  heartbeatAt: number;
  self: boolean;
}

let cachedVersion: string | null = null;
/** The server's version: npm's when it started the process, else the package file beside the build. */
export function serverVersion(): string {
  if (process.env.npm_package_version) return process.env.npm_package_version;
  if (cachedVersion) return cachedVersion;
  try {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
    cachedVersion = String((JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version ?? 'unknown');
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}

/**
 * What `/readyz` answers: the database reachable and fully migrated, the schema handshake, KMS and blob store
 * answering, and not shutting down or draining. Shared by the readiness route and the heartbeat.
 */
export async function readiness(s: Services, shuttingDown: boolean): Promise<{ ok: boolean; checks: Record<string, string> }> {
  const checks: Record<string, string> = {};
  const draining = s.instances.draining;
  let ok = !shuttingDown && !draining;
  checks.shutdown = shuttingDown || draining ? 'draining' : 'ok';
  try {
    await s.db.raw('select 1');
    checks.database = 'ok';
    // Sprint 22 (B-1403): the schema handshake. An instance older than the database says so and is not ready.
    const st = await s.schema.check();
    checks.migrations = st.pending.length ? `${st.pending.length} pending` : 'ok';
    checks.schema = st.state === 'behind' ? `behind: ${st.reason}` : 'ok';
    if (st.state !== 'current') ok = false;
  } catch (err) {
    s.log.warn({ err: (err as Error).message }, 'readiness: database unavailable');
    checks.database = 'unavailable';
    ok = false;
  }
  // Without the KMS nothing sealed opens; without the blob store exports, attachments and checkpoints fail.
  const [kms, blobs] = await Promise.all([s.kms.health(), s.blobs.health()]);
  if (!kms.ok) s.log.warn({ detail: kms.detail }, 'readiness: KMS unavailable');
  if (!blobs.ok) s.log.warn({ detail: blobs.detail }, 'readiness: blob store unavailable');
  checks.kms = kms.ok ? 'ok' : 'unavailable';
  checks.blobs = blobs.ok ? 'ok' : 'unavailable';
  if (!kms.ok || !blobs.ok) ok = false;
  return { ok, checks };
}

const fromRow = (r: Record<string, unknown>, self: string, staleMs: number): InstanceView => {
  const heartbeatAt = Number(r.heartbeat_at);
  const stale = Date.now() - heartbeatAt > staleMs;
  return {
    id: String(r.id),
    node: String(r.node),
    pid: Number(r.pid),
    role: String(r.role),
    version: String(r.version),
    state: stale ? 'not answering' : (String(r.state) as InstanceState),
    checks: json<Record<string, string>>(r.checks, {}),
    schema: { state: (r.schema_state as string | null) ?? null, detail: (r.schema_detail as string | null) ?? null },
    jobsClaimed: Number(r.jobs_claimed),
    sockets: Number(r.sockets),
    runtime: json<InstanceRuntime>(r.runtime, {} as InstanceRuntime),
    drain: !!r.drain,
    drainedBy: (r.drained_by as string | null) ?? null,
    drainedAt: r.drained_at == null ? null : Number(r.drained_at),
    startedAt: Number(r.started_at),
    heartbeatAt,
    self: String(r.id) === self
  };
};

export class InstanceRegistry {
  /** This process. The job queue's worker id, so the Jobs screen's Node column names the same instance. */
  readonly id: string;
  readonly startedAt = Date.now();
  /** Set by the realtime layer: the sockets connected to this instance. */
  sockets: (() => number) | null = null;
  /** Set when an administrator drained this instance. */
  draining = false;
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private readonly off: () => void;

  constructor(
    private readonly s: () => Services,
    bus: Bus,
    private readonly o: { heartbeatMs: number; id: string }
  ) {
    this.id = o.id;
    this.off = bus.on<{ id?: string }>(TOPICS.instanceDrain, (e) => {
      if (e?.id !== this.id || this.draining) return;
      this.draining = true;
      this.s().log.warn({ instance: this.id }, 'drained by an administrator: no new jobs, readiness answers 503');
      void this.beat().catch(() => undefined);
    });
  }

  get heartbeatMs(): number {
    return this.o.heartbeatMs;
  }

  /** Why the job queue must not claim here, or null (composed with the schema handshake's refusal). */
  drainReason(): string | null {
    return this.draining ? 'This instance is draining.' : null;
  }

  start(): void {
    if (this.timer || this.o.heartbeatMs <= 0) return;
    const tick = () => void this.beat().catch((err: unknown) => this.s().log.warn({ err }, 'instance heartbeat failed'));
    tick();
    this.timer = setInterval(tick, this.o.heartbeatMs);
    this.timer.unref();
  }

  /** Stops the beat and removes this instance's row (it is gone, not silent). */
  async stop(): Promise<void> {
    this.stopping = true;
    this.off();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.s().db('platform_instances').where({ id: this.id }).delete().catch(() => undefined);
  }

  private runtime(): InstanceRuntime {
    const s = this.s();
    const rl = s.counters.health?.() ?? null;
    return {
      rateLimit: { kind: s.counters.kind, degraded: !!rl?.degraded, since: rl?.since ?? null, detail: rl?.detail ?? null },
      tracing: { enabled: s.tracer.enabled, exported: s.tracer.stats.exported, dropped: s.tracer.stats.dropped, failed: s.tracer.stats.failed },
      ntpOffsetMs: s.ops.lastClockOffsetMs,
      jobQueue: s.jobs.mode,
      concurrency: s.jobs.concurrency,
      workersEnabled: s.cfg.WORKERS_ENABLED
    };
  }

  /** Writes this instance's row: its readiness, schema, work and runtime; and reads back whether it was drained. */
  async beat(): Promise<void> {
    if (this.stopping) return;
    const s = this.s();
    const { ok, checks } = await readiness(s, false);
    const st = s.schema.current;
    const now = Date.now();
    const row = {
      node: hostname().slice(0, 200),
      pid: process.pid,
      role: s.cfg.WORKERS_ENABLED ? 'api, jobs' : 'api',
      version: serverVersion().slice(0, 40),
      checks: JSON.stringify(checks),
      runtime: JSON.stringify(this.runtime()),
      schema_state: st?.state ?? null,
      schema_detail: st?.state === 'behind' ? (st.reason ?? 'behind').slice(0, 500) : null,
      jobs_claimed: s.jobs.runningCount,
      sockets: this.sockets?.() ?? 0,
      heartbeat_at: now
    };
    const existing = (await s.db('platform_instances').where({ id: this.id }).first('drain')) as { drain: boolean | number } | undefined;
    if (existing?.drain) this.draining = true;
    const state = this.draining ? 'draining' : ok ? 'ready' : 'not ready';
    if (existing) await s.db('platform_instances').where({ id: this.id }).update({ ...row, state });
    else {
      try {
        await s.db('platform_instances').insert({ id: this.id, ...row, state, drain: false, drained_by: null, drained_at: null, started_at: this.startedAt });
      } catch {
        await s.db('platform_instances').where({ id: this.id }).update({ ...row, state });
      }
    }
    // Rows of instances that went away a day ago or more.
    await s.db('platform_instances').where('heartbeat_at', '<', now - 24 * 3600_000).delete();
  }

  /** Every instance, this one first, then by when it started. */
  async list(): Promise<InstanceView[]> {
    const rows = (await this.s().db('platform_instances').orderBy('started_at')) as Record<string, unknown>[];
    const views = rows.map((r) => fromRow(r, this.id, this.o.heartbeatMs * 3 + 5_000));
    return [...views.filter((v) => v.self), ...views.filter((v) => !v.self)];
  }

  async get(id: string): Promise<InstanceView | undefined> {
    return (await this.list()).find((v) => v.id === id);
  }

  /** Drains an instance (Q14). Audited `platform.instance.drained`; a second drain is refused. */
  async drain(by: OpsActor, id: string): Promise<InstanceView> {
    const s = this.s();
    const inst = await this.get(id);
    if (!inst) throw notFound('Instance');
    if (inst.state === 'not answering') throw conflict('That instance is not answering; there is nothing to drain.');
    const t = Date.now();
    const n = await s.db('platform_instances').where({ id }).andWhere((w) => w.where({ drain: false }).orWhereNull('drain')).update({ drain: true, drained_by: by.userId, drained_at: t, state: 'draining' });
    if (!n) throw conflict('That instance is already draining.');
    if (id === this.id) this.draining = true;
    s.bus.publish(TOPICS.instanceDrain, { id });
    await audit(s, by, 'platform.instance.drained', { instance: id }, { node: inst.node, pid: inst.pid, jobsClaimed: inst.jobsClaimed, sockets: inst.sockets }, 'admin');
    return (await this.get(id))!;
  }
}
