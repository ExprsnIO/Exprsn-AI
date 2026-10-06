import { json } from '../db/knex.js';
import { actorFrom, isUniqueViolation } from '../audit/chain.js';
import type { Principal } from '../authz/policy.js';
import { authorize } from '../authz/policy.js';
import { clears, type Label } from '../authz/labels.js';
import { conflict, forbidden, notFound } from '../http/problem.js';
import { isCacheNamespace } from '../platform/cache.js';
import type { JobRow, JobState, ScheduleEntry } from '../platform/jobs.js';
import { ModerationService } from '../moderation/service.js';
import type { Services } from '../services.js';
import { audit, type OpsActor } from './common.js';

/*
 * 1.6.0 (B-4203): Jobs and queues. Everything here reads the one `jobs` table, the `JobQueue`'s registrations, the
 * `Scheduler`'s schedules and the tenant cache; nothing has a queue of its own.
 *
 * Who sees what (Q9): a holder of `platform:manage` (a system admin) sees every tenant's jobs, with an optional tenant
 * filter; anyone else allowed on the screen (`tenant:manage`) sees their own tenant's. Pausing a job type and running
 * or pausing a schedule act on every tenant, so they need `platform:manage` (the route says so). Payloads are listed by
 * key only: a value can carry ids that are tenant content.
 */

export const DOMAINS = ['Knowledge', 'Chat and agents', 'Media and images', 'Moderation and files', 'Channels and webhooks', 'Platform operations', 'PKI and vault', 'Identity', 'Apps and workflows', 'Social', 'Training', 'Models and guardrails'] as const;

const DOMAIN_OF: [RegExp, (typeof DOMAINS)[number]][] = [
  [/^(knowledge|memory)\b/, 'Knowledge'],
  [/^(agent|agents|chat|conversation|openai|evals|script|scripts|prompts)\b/, 'Chat and agents'],
  [/^(media|image|images)\b/, 'Media and images'],
  [/^(moderation|file|files|attachment|guard)\b/, 'Moderation and files'],
  [/^(channels|webhook|webhooks)\b/, 'Channels and webhooks'],
  [/^(pki|vault|leases|rotation)\b/, 'PKI and vault'],
  [/^(directory|users|federation|identity|access|authz|signup)\b/, 'Identity'],
  [/^(apps|plugin|plugins|workflow|workflows)\b/, 'Apps and workflows'],
  [/^(feed|feeds|group|groups|social|messaging|messages|atproto|firehose|pds|calendar|contacts|dav|people|presence)\b/, 'Social'],
  [/^(training|classifier)\b/, 'Training'],
  [/^(model|models|pool|pools|guardrails|imports)\b/, 'Models and guardrails']
];

export const domainOf = (type: string): string => DOMAIN_OF.find(([re]) => re.test(type))?.[1] ?? 'Platform operations';

/** What a job type does, in the board's words, for the types whose purpose is not obvious from the name. */
const TYPE_INFO: Record<string, string> = {
  'webhook.deliver': 'Delivers one event to one outbound webhook: a signed body, retried with backoff; repeated failures open the target\'s breaker.',
  'knowledge.index': 'Chunks and embeds documents of one knowledge base through the gateway; text sealed, vectors in the vector store.',
  'knowledge.sync': 'Pulls one source (S3, Git, a database view, a web crawl) and queues indexing for what changed.',
  'knowledge.sync-due': 'Queues a sync for every knowledge source whose schedule is due.',
  'media.process': 'Runs one preset (transcode, transcribe, frames) on a media asset in the sandbox; outputs stay in the blob store.',
  'image.generate': 'One image request on the image backend, safety-checked before it is stored.',
  'agent.run': 'One agent run: tool calls through the registry, approvals as checkpoints, memory written back at the end.',
  'file.scan': 'Type check and malware scan of a new file version in quarantine; nothing is readable before it passes.',
  'attachment.scan': 'The same check for chat and message attachments.',
  'channels.send': 'Sends one released reply to the customer over SMTP; a bounce is recorded once.',
  'channels.imap-poll': 'Polls one email channel\'s mailbox and threads new mail by Message-ID.',
  'channels.reply': 'Drafts the answer for a customer session through the channel\'s profile; a hold keeps it for review.',
  'pki.crl': 'Publishes a numbered CRL for each live issuer, signed by the issuer\'s key.',
  'pki.acme.validate': 'Validates an ACME challenge (http-01 or dns-01) and finalises the order.',
  'ops.backup.create': 'Writes a consistent backup of the database (and, when configured, the blob store) to the backup store.',
  'ops.backup.watch': 'Raises a platform alert when the last backup is older than PLATFORM_BACKUP_RPO_MINUTES.',
  'training.tick': 'Advances every training job: windows, pre-emption, checkpoints reported by the worker, packaging.',
  'plugin.invoke': 'Runs one plugin for one event: declarative actions, or a script handler in the sandbox with a scoped token.',
  'apps.import': 'Imports CSV rows into an entity, with a dry-run report first.',
  'users.import': 'A CSV of users, memberships and group mappings, with a dry run that changes nothing.',
  'directory.sync': 'Links directory users and groups into the users table for one tenant.',
  'audit.checkpoint': 'Writes a signed checkpoint of the tenant\'s audit chain, so a verification can start from it.',
  'guardrails.sweep': 'Escalates flags past their timers and expires holds.',
  'chat.retention': 'Applies the tenant, workspace and user retention rules to conversations.',
  'chat.sweep': 'Finishes streams whose lease expired, so a client can resume from any instance.',
  'memory.purge': 'Removes memories past their retention and ones their owner deleted.',
  'zones.health': 'Checks every zone endpoint and marks unhealthy members.',
  'zones.cluster.drift': 'Compares each NetworkPolicy in the cluster with what was applied; drift is audited.',
  'files.purge': 'Deletes trashed files past their retention, and their blobs.',
  'mcp.poll': 'Re-reads the tool lists of every MCP server and marks the ones that changed.'
};

/** What sets each schedule's period, when a setting does. */
const SCHEDULE_SETTING: Record<string, string> = {
  'audit.checkpoint': 'AUDIT_CHECKPOINT_MINUTES', 'directory.sync': 'DIRECTORY_SYNC_MINUTES', 'mcp.poll': 'MCP_POLL_MINUTES', 'chat.retention': 'CHAT_RETENTION_SWEEP_MINUTES',
  'training.tick': 'TRAINING_TICK_SECONDS', 'zones.health': 'ZONE_HEALTH_MINUTES', 'zones.cluster.drift': 'ZONES_APPLY_DRIFT_MINUTES', 'ops.backup.create': 'PLATFORM_BACKUP_MINUTES',
  'ops.backup.drill': 'PLATFORM_DRILL_MINUTES', 'ops.mirror.check': 'PLATFORM_MIRROR_CHECK_MINUTES', 'ops.cert.sweep': 'ACME_CHECK_MINUTES', 'federation.metadata': 'FEDERATION_METADATA_REFRESH_HOURS',
  'billing.close': 'BILLING_CLOSE_MINUTES', 'agents.schedules': 'AGENT_SCHEDULE_TICK_SECONDS', 'apps.schedules': 'APPS_SCHEDULE_TICK_SECONDS', 'pki.crl': 'PKI_CRL_MINUTES',
  'pki.expiry': 'PKI_EXPIRY_SWEEP_MINUTES', 'files.purge': 'FILES_PURGE_MINUTES', 'channels.imap-poll': 'CHANNELS_IMAP_POLL_SECONDS', 'channels.retention': 'CHANNELS_RETENTION_SWEEP_MINUTES',
  'workflow.schedules': 'WORKFLOW_SCHEDULE_TICK_SECONDS', 'imports.harvest-due': 'IMPORT_HARVEST_TICK_MINUTES', 'imports.bundle-match': 'IMPORT_BUNDLE_POLL_MINUTES'
};

/** The tenant cache's namespaces that the server reads (B-2102), so they are listed before their first read. */
export const CACHE_NAMESPACES: { ns: string; tier: 'short' | 'medium' | 'long'; description: string }[] = [
  { ns: 'plugins', tier: 'medium', description: 'The tenant\'s enabled plugins and the events they subscribe to.' },
  { ns: 'sanctions', tier: 'short', description: 'Whether a user is under a sign-in sanction (warn, suspend, ban).' },
  { ns: 'workflow-triggers', tier: 'medium', description: 'The tenant\'s published event triggers of workflows.' }
];

/** Which tenants a request covers: every tenant (with an optional filter) for a system admin, else the caller's. */
export interface JobScope {
  all: boolean;
  tenantId: string | null;
}

export const isPlatformAdmin = (p: Principal): boolean => authorize(p, 'platform:manage').allow;

/** The scope a principal may read, given an optional tenant filter (Q9). Another tenant's filter is refused. */
export function scopeFor(p: Principal, tenant?: string): JobScope {
  if (isPlatformAdmin(p)) return { all: !tenant, tenantId: tenant ?? null };
  if (tenant && tenant !== p.tenantId) throw forbidden('Only a system admin sees another tenant\'s jobs.', { step: 'role' });
  return { all: false, tenantId: p.tenantId };
}

const traceIdOf = (traceparent: unknown): string | null => {
  const m = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(String(traceparent ?? ''));
  return m ? m[1]! : null;
};

const pctile = (sorted: number[], q: number): number | null => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : null);

export interface JobFilters {
  state?: JobState;
  type?: string;
  windowMs?: number;
  q?: string;
  limit?: number;
}

const by = (p: Principal, ip: string | null, traceId?: string): OpsActor => ({ tenantId: p.tenantId, actor: actorFrom(p, ip), userId: p.userId, traceId: traceId ?? null });

export class JobsAdmin {
  constructor(private readonly s: () => Services) {}

  private scoped<T extends { where: (...a: never[]) => T }>(q: T, scope: JobScope, column = 'tenant_id'): T {
    if (!scope.all && scope.tenantId) (q as unknown as { where: (c: string, v: string) => void }).where(column, scope.tenantId);
    return q;
  }

  private async names(tenantIds: string[], userIds: string[], workspaceIds: string[]) {
    const db = this.s().db;
    const uniq = (a: string[]) => [...new Set(a.filter(Boolean))];
    const [t, u, w] = await Promise.all([
      uniq(tenantIds).length ? db('tenants').whereIn('id', uniq(tenantIds)).select('id', 'name') : [],
      uniq(userIds).length ? db('users').whereIn('id', uniq(userIds)).select('id', 'display_name as name') : [],
      uniq(workspaceIds).length ? db('workspaces').whereIn('id', uniq(workspaceIds)).select('id', 'name') : []
    ]);
    const m = (rows: { id: string; name: string }[]) => new Map(rows.map((r) => [r.id, r.name]));
    return { tenants: m(t as { id: string; name: string }[]), users: m(u as { id: string; name: string }[]), workspaces: m(w as { id: string; name: string }[]) };
  }

  private async views(rows: Record<string, unknown>[]) {
    const payloads = rows.map((r) => json<Record<string, unknown>>(r.payload, {}));
    const ws = payloads.map((p) => (typeof p.workspaceId === 'string' ? p.workspaceId : ''));
    const n = await this.names(rows.map((r) => String(r.tenant_id)), rows.map((r) => String(r.created_by ?? '')), ws);
    return rows.map((r, i) => {
      const started = r.started_at == null ? null : Number(r.started_at);
      const finished = r.finished_at == null ? null : Number(r.finished_at);
      const state = String(r.state) as JobState;
      return {
        id: String(r.id), type: String(r.type), domain: domainOf(String(r.type)),
        tenantId: String(r.tenant_id), tenantName: n.tenants.get(String(r.tenant_id)) ?? null,
        workspaceId: ws[i] || null, workspaceName: ws[i] ? (n.workspaces.get(ws[i]!) ?? null) : null,
        state, progress: Number(r.progress), attempts: Number(r.attempts), maxAttempts: Number(r.max_attempts),
        createdAt: Number(r.created_at), runAt: Number(r.run_at), startedAt: started, finishedAt: finished,
        durationMs: started == null ? null : (finished ?? (state === 'running' ? Date.now() : started)) - started,
        node: (r.worker as string | null) ?? null, message: (r.message as string | null) ?? null, error: (r.error as string | null) ?? null,
        payloadKeys: Object.keys(payloads[i]!).sort(), traceId: traceIdOf(r.trace_parent),
        createdBy: (r.created_by as string | null) ?? null, createdByName: r.created_by ? (n.users.get(String(r.created_by)) ?? null) : null
      };
    });
  }

  // ---------- Queues ----------

  async queues(scope: JobScope) {
    const s = this.s();
    const now = Date.now();
    const since = now - 24 * 3600_000;
    const live = (await this.scoped(s.db('jobs').whereIn('state', ['queued', 'running']), scope).groupBy('type', 'state').select('type', 'state').count({ n: '*' }).min({ oldest: 'created_at' })) as { type: string; state: string; n: number | string; oldest: number | string | null }[];
    const day = (await this.scoped(s.db('jobs').where('created_at', '>=', since), scope).orderBy('created_at', 'desc').limit(50_000).select('type', 'state', 'created_at', 'started_at', 'finished_at')) as { type: string; state: string; created_at: number | string; started_at: number | string | null; finished_at: number | string | null }[];
    const paused = new Map(((await s.db('job_type_pauses').select()) as { type: string; reason: string | null; paused_by: string | null; paused_at: number | string }[]).map((r) => [r.type, r]));
    const registered = new Map(s.jobs.types().map((t) => [t.type, t.timeoutMs]));
    const types = new Set<string>([...registered.keys(), ...live.map((r) => r.type), ...paused.keys()]);
    const names = await this.names([], [...paused.values()].map((p) => p.paused_by ?? ''), []);
    const items = [...types].sort().map((type) => {
      const q = live.find((r) => r.type === type && r.state === 'queued');
      const run = live.find((r) => r.type === type && r.state === 'running');
      const mine = day.filter((d) => d.type === type);
      const durations = mine.filter((d) => d.state === 'succeeded' && d.started_at != null && d.finished_at != null).map((d) => Number(d.finished_at) - Number(d.started_at)).sort((a, b) => a - b);
      const series = Array.from({ length: 8 }, (_, k) => mine.filter((d) => Number(d.created_at) >= since + k * 3 * 3600_000 && Number(d.created_at) < since + (k + 1) * 3 * 3600_000).length);
      const p = paused.get(type);
      return {
        type, domain: domainOf(type), description: TYPE_INFO[type] ?? null, registered: registered.has(type),
        queued: Number(q?.n ?? 0), running: Number(run?.n ?? 0), oldestQueuedAt: q?.oldest != null ? Number(q.oldest) : null,
        failed24h: mine.filter((d) => d.state === 'failed').length, succeeded24h: durations.length,
        p50Ms: pctile(durations, 0.5), p95Ms: pctile(durations, 0.95), series,
        timeoutMs: registered.get(type) ?? null, paused: !!p,
        pause: p ? { reason: p.reason, by: p.paused_by, byName: p.paused_by ? (names.users.get(p.paused_by) ?? null) : null, at: Number(p.paused_at) } : null
      };
    });
    const instances = await s.instances.list();
    const claiming = instances.filter((i) => i.state === 'ready' && i.runtime?.workersEnabled !== false);
    return {
      backend: s.jobs.mode, concurrency: s.jobs.concurrency, items,
      instances: { total: instances.filter((i) => i.state !== 'not answering').length, claiming: claiming.length, notClaiming: instances.filter((i) => i.state === 'not ready' || i.state === 'draining').map((i) => ({ id: i.id, state: i.state, reason: i.state === 'draining' ? 'draining' : i.schema.state === 'behind' ? (i.schema.detail ?? 'behind the schema') : 'not ready' })) }
    };
  }

  async pauseType(p: Principal, type: string, reason: string | null, ip: string | null, traceId?: string) {
    const s = this.s();
    if (!s.jobs.types().some((t) => t.type === type)) throw notFound('Job type');
    try {
      await s.db('job_type_pauses').insert({ type, reason, paused_by: p.userId, paused_at: Date.now() });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('That job type is already paused.');
      throw err;
    }
    s.jobs.setPaused([...((await s.db('job_type_pauses').select('type')) as { type: string }[]).map((r) => r.type)]);
    const queued = await s.db('jobs').where({ type, state: 'queued' }).count({ n: '*' }).first();
    await audit(s, by(p, ip, traceId), 'jobs.type.paused', { type }, { reason, queued: Number((queued as { n?: number | string } | undefined)?.n ?? 0) }, 'admin');
  }

  async resumeType(p: Principal, type: string, ip: string | null, traceId?: string) {
    const s = this.s();
    const n = await s.db('job_type_pauses').where({ type }).delete();
    if (!n) throw conflict('That job type is not paused.');
    s.jobs.setPaused([...((await s.db('job_type_pauses').select('type')) as { type: string }[]).map((r) => r.type)]);
    await audit(s, by(p, ip, traceId), 'jobs.type.resumed', { type }, undefined, 'admin');
  }

  // ---------- Jobs ----------

  async list(scope: JobScope, f: JobFilters) {
    const s = this.s();
    const q = this.scoped(s.db('jobs'), scope);
    if (f.state) q.andWhere({ state: f.state });
    if (f.type) q.andWhere({ type: f.type });
    if (f.windowMs) q.andWhere('created_at', '>=', Date.now() - f.windowMs);
    if (f.q) {
      const needle = f.q.toLowerCase();
      // Ids are ULIDs (upper case); trace ids are hex inside the traceparent.
      q.andWhere((w) => w.where({ id: f.q!.toUpperCase() }).orWhere('trace_parent', 'like', `%-${needle}-%`));
    }
    const rows = (await q.orderBy('created_at', 'desc').limit(Math.min(f.limit ?? 200, 500))) as Record<string, unknown>[];
    const counts = (await this.scoped(s.db('jobs').whereIn('state', ['queued', 'running', 'failed']), scope).andWhere((w) => (f.windowMs ? w.where('created_at', '>=', Date.now() - f.windowMs).orWhereIn('state', ['queued', 'running']) : w)).groupBy('state').select('state').count({ n: '*' })) as { state: string; n: number | string }[];
    const c = (st: string) => Number(counts.find((x) => x.state === st)?.n ?? 0);
    return { items: await this.views(rows), counts: { queued: c('queued'), running: c('running'), failed: c('failed') }, tracing: s.tracer.enabled };
  }

  private async row(scope: JobScope, id: string): Promise<Record<string, unknown>> {
    const r = (await this.scoped(this.s().db('jobs').where({ id }), scope).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Job');
    return r;
  }

  async get(scope: JobScope, id: string) {
    const r = await this.row(scope, id);
    const [v] = await this.views([r]);
    const timeline: { title: string; text?: string; at: number; tone: string }[] = [{ title: 'queued', at: v!.createdAt, tone: '' }];
    if (v!.startedAt) timeline.push({ title: `claimed by ${v!.node ?? 'a worker'}`, text: `attempt ${v!.attempts} of ${v!.maxAttempts}`, at: v!.startedAt, tone: 'info' });
    if (v!.state === 'running' && v!.message) timeline.push({ title: `progress ${v!.progress} %`, text: v!.message, at: Date.now(), tone: 'accent' });
    if (v!.state === 'queued' && v!.attempts > 0) timeline.push({ title: `attempt ${v!.attempts} failed; retrying`, ...(v!.error ? { text: v!.error } : {}), at: v!.runAt, tone: 'warn' });
    if (v!.finishedAt) timeline.push({ title: v!.state, ...(v!.error && v!.state === 'failed' ? { text: v!.error } : v!.message ? { text: v!.message } : {}), at: v!.finishedAt, tone: v!.state === 'succeeded' ? 'ok' : v!.state === 'failed' ? 'danger' : 'warn' });
    return { ...v!, timeline };
  }

  async cancel(p: Principal, scope: JobScope, id: string, reason: string | null, ip: string | null, traceId?: string) {
    const s = this.s();
    const r = await this.row(scope, id);
    if (r.state !== 'queued' && r.state !== 'running') throw conflict('Only a queued or running job can be cancelled.');
    await s.jobs.cancel(String(r.tenant_id), id);
    await audit(s, by(p, ip, traceId), 'jobs.cancelled', { job: id, tenant: String(r.tenant_id) }, { type: String(r.type), state: String(r.state), reason }, 'admin');
    return this.get(scope, id);
  }

  async retry(p: Principal, scope: JobScope, id: string, ip: string | null, traceId?: string) {
    const s = this.s();
    const r = await this.row(scope, id);
    const after = await s.jobs.requeue(String(r.tenant_id), id, `Queued again by ${p.displayName || p.username}`);
    if (!after) throw conflict('Only a failed, cancelled or preempted job can be queued again.');
    await audit(s, by(p, ip, traceId), 'jobs.retried', { job: id, tenant: String(r.tenant_id) }, { type: String(r.type), from: String(r.state), attempts: Number(r.attempts) }, 'admin');
    return this.get(scope, id);
  }

  /** Queues again every failed job in the scope (of one type, when given) that failed in the window. */
  async retryFailed(p: Principal, scope: JobScope, f: { type?: string; windowMs: number }, ip: string | null, traceId?: string) {
    const s = this.s();
    const q = this.scoped(s.db('jobs').where({ state: 'failed' }).andWhere('created_at', '>=', Date.now() - f.windowMs), scope);
    if (f.type) q.andWhere({ type: f.type });
    const rows = (await q.orderBy('created_at').limit(500).select('id', 'tenant_id', 'type')) as { id: string; tenant_id: string; type: string }[];
    let n = 0;
    const who = `Queued again by ${p.displayName || p.username}`;
    for (const r of rows) if (await s.jobs.requeue(r.tenant_id, r.id, who)) n++;
    if (n) await audit(s, by(p, ip, traceId), 'jobs.retried', { type: f.type ?? null, scope: scope.all ? 'all tenants' : scope.tenantId }, { count: n, types: [...new Set(rows.map((r) => r.type))].sort() }, 'admin');
    return { retried: n };
  }

  // ---------- Schedules ----------

  private async scheduleView(e: ScheduleEntry, paused: Map<string, { reason: string | null; paused_by: string | null; paused_at: number | string }>) {
    const s = this.s();
    const runs = (await s.db('jobs').where({ type: e.type }).andWhere('dedupe_key', '>=', `${e.name}:`).andWhere('dedupe_key', '<', `${e.name}:￿`).orderBy('created_at', 'desc').limit(5).select('id', 'state', 'message', 'error', 'created_at', 'started_at', 'finished_at', 'dedupe_key')) as Record<string, unknown>[];
    const targets: { tenantId: string; key?: string }[] = await e.targets().catch(() => []);
    const platform = targets.some((t) => t.key === 'platform' || t.key === 'all');
    const now = Date.now();
    const p = paused.get(e.name);
    const view = (r: Record<string, unknown>) => ({
      job: String(r.id), state: String(r.state), at: Number(r.created_at), manual: /:now:\d+$/.test(String(r.dedupe_key)),
      result: r.state === 'failed' ? ((r.error as string | null) ?? 'failed') : ((r.message as string | null) ?? String(r.state)),
      durationMs: r.started_at != null && r.finished_at != null ? Number(r.finished_at) - Number(r.started_at) : null
    });
    return {
      name: e.name, type: e.type, everyMs: e.everyMs, setting: SCHEDULE_SETTING[e.name] ?? null, description: TYPE_INFO[e.name] ?? TYPE_INFO[e.type] ?? null,
      targets: platform ? 'platform' : `${targets.length} tenant${targets.length === 1 ? '' : 's'}`, targetCount: targets.length,
      nextAt: p ? null : (Math.floor(now / e.everyMs) + 1) * e.everyMs,
      paused: !!p, pause: p ? { reason: p.reason, by: p.paused_by, at: Number(p.paused_at) } : null,
      last: runs[0] ? view(runs[0]) : null, runs: runs.map(view)
    };
  }

  private async pausedSchedules() {
    return new Map(((await this.s().db('schedule_pauses').select()) as { name: string; reason: string | null; paused_by: string | null; paused_at: number | string }[]).map((r) => [r.name, r]));
  }

  async schedules() {
    const paused = await this.pausedSchedules();
    const items = [];
    for (const e of this.s().scheduler.list()) items.push(await this.scheduleView(e, paused));
    return { items };
  }

  /** The next `n` schedules to run, for the Overview. */
  async nextSchedules(n: number) {
    const { items } = await this.schedules();
    return { total: items.length, items: items.filter((i) => !i.paused).sort((a, b) => a.nextAt! - b.nextAt!).slice(0, n) };
  }

  private entry(name: string): ScheduleEntry {
    const e = this.s().scheduler.get(name);
    if (!e) throw notFound('Schedule');
    return e;
  }

  async runSchedule(p: Principal, name: string, ip: string | null, traceId?: string) {
    const s = this.s();
    this.entry(name);
    const jobs = await s.scheduler.runNow(name, p.userId);
    await audit(s, by(p, ip, traceId), 'jobs.schedule.run', { schedule: name }, { jobs: jobs.length }, 'admin');
    return { queued: jobs.length, jobs: jobs.map((j: JobRow) => j.id) };
  }

  async pauseSchedule(p: Principal, name: string, reason: string | null, ip: string | null, traceId?: string) {
    const s = this.s();
    this.entry(name);
    try {
      await s.db('schedule_pauses').insert({ name, reason, paused_by: p.userId, paused_at: Date.now() });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('That schedule is already paused.');
      throw err;
    }
    await audit(s, by(p, ip, traceId), 'jobs.schedule.paused', { schedule: name }, { reason }, 'admin');
  }

  async resumeSchedule(p: Principal, name: string, ip: string | null, traceId?: string) {
    const s = this.s();
    this.entry(name);
    const n = await s.db('schedule_pauses').where({ name }).delete();
    if (!n) throw conflict('That schedule is not paused.');
    await audit(s, by(p, ip, traceId), 'jobs.schedule.resumed', { schedule: name }, undefined, 'admin');
  }

  // ---------- Dead letters ----------

  /**
   * The work that gave up, from the domains that keep a dead-letter queue: the moderation jobs (B-1905, needs
   * `moderation:manage`) and the workflow runs of the caller's workspace (B-3904, needs `workflows:manage`, within
   * clearance). Always the caller's own tenant: redriving runs as the caller.
   */
  async deadLetters(p: Principal) {
    const s = this.s();
    const items: { source: 'moderation' | 'workflow'; id: string; item: string; reason: string | null; attempts: number | null; firstFailedAt: number; lastFailedAt: number; redrivesAs: string; link: { route: string; params: Record<string, string> } }[] = [];
    const sources: string[] = [];
    if (authorize(p, 'moderation:manage').allow) {
      sources.push('moderation');
      for (const d of await s.moderation.deadLetters(p.tenantId, 'open')) items.push({ source: 'moderation', id: d.id, item: `job ${d.jobId}, ${d.type}`, reason: d.error, attempts: d.attempts, firstFailedAt: d.failedAt, lastFailedAt: d.failedAt, redrivesAs: d.type, link: { route: 'moderation', params: { tab: 'deadletters' } } });
    }
    if (authorize(p, 'workflows:manage').allow) {
      sources.push('workflow');
      for (const d of await s.workflowDeadLetters.list(p, { state: 'open' })) items.push({ source: 'workflow', id: d.id, item: `${d.workflow ?? d.workflowId}, run ${d.runId}${d.nodeId ? `, step ${d.nodeId}` : ''}`, reason: d.error, attempts: null, firstFailedAt: d.failedAt, lastFailedAt: d.failedAt, redrivesAs: 'workflow run', link: { route: 'workflows', params: { id: d.workflowId } } });
    }
    items.sort((a, b) => b.lastFailedAt - a.lastFailedAt);
    return { items, sources };
  }

  async redrive(p: Principal, source: 'moderation' | 'workflow', id: string, ip: string | null, traceId?: string) {
    const s = this.s();
    if (source === 'moderation') {
      if (!authorize(p, 'moderation:manage').allow) throw forbidden('Redriving a moderation job needs moderation:manage.', { step: 'role' });
      const r = await s.moderation.redrive({ ...ModerationService.ctxFor(p, ip, traceId), principal: p }, id);
      return { source, id, jobId: r.jobId, runId: null };
    }
    if (!authorize(p, 'workflows:manage').allow) throw forbidden('Redriving a workflow run needs workflows:manage.', { step: 'role' });
    const r = await s.workflowDeadLetters.redrive(p, id, { ip, ...(traceId ? { traceId } : {}) });
    return { source, id, jobId: null, runId: r.redriveRunId };
  }

  async discard(p: Principal, source: 'moderation' | 'workflow', id: string, reason: string, ip: string | null, traceId?: string) {
    const s = this.s();
    const perm = source === 'moderation' ? 'moderation:manage' : 'workflows:manage';
    if (!authorize(p, perm).allow) throw forbidden(`Discarding needs ${perm}.`, { step: 'role' });
    const table = source === 'moderation' ? 'moderation_dead_letters' : 'workflow_dead_letters';
    const r = (await s.db(table).where({ tenant_id: p.tenantId, id }).first()) as Record<string, unknown> | undefined;
    if (!r || (source === 'workflow' && !clears(p.clearance, r.label as Label))) throw notFound('Dead letter');
    if (source === 'workflow') await s.workflowDeadLetters.list(p, { state: 'open' }).then((l) => { if (!l.some((d) => d.id === id)) throw notFound('Dead letter'); });
    const n = await s.db(table).where({ id, state: 'open' }).update({ state: 'discarded' });
    if (!n) throw conflict('That dead letter was already redriven or discarded.');
    await audit(s, by(p, ip, traceId), 'jobs.deadletter.discarded', { source, deadLetter: id }, { reason, type: source === 'moderation' ? String(r.type) : 'workflow run', error: ((r.error as string | null) ?? '').slice(0, 300) || null }, 'admin');
  }

  // ---------- Cache ----------

  async cache(p: Principal) {
    const s = this.s();
    const known = new Map(CACHE_NAMESPACES.map((n) => [n.ns, n]));
    const all = [...new Set([...known.keys(), ...s.cache.namespaces()])].sort();
    const stats = await s.cache.stats(p.tenantId, all);
    const instances = (await s.instances.list()).filter((i) => i.state !== 'not answering').length;
    return {
      store: s.cache.store.kind, instances, ttlSeconds: { short: s.cfg.CACHE_TTL_SHORT_SECONDS, medium: s.cfg.CACHE_TTL_MEDIUM_SECONDS, long: s.cfg.CACHE_TTL_LONG_SECONDS }, maxEntries: s.cfg.CACHE_MAX_ENTRIES,
      items: stats.map((x) => ({ ...x, tier: x.tier ?? known.get(x.ns)?.tier ?? null, description: known.get(x.ns)?.description ?? null }))
    };
  }

  async invalidate(p: Principal, ns: string, ip: string | null, traceId?: string) {
    const s = this.s();
    if (!isCacheNamespace(ns) || !(CACHE_NAMESPACES.some((n) => n.ns === ns) || s.cache.namespaces().includes(ns))) throw notFound('Cache namespace');
    await s.cache.invalidate({ tenantId: p.tenantId, ns });
    await audit(s, by(p, ip, traceId), 'jobs.cache.invalidated', { namespace: ns }, { store: s.cache.store.kind }, 'admin');
  }
}

