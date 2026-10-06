import { AsyncLocalStorage } from 'node:async_hooks';
import client from 'prom-client';
import { ulid } from 'ulid';
import { randomToken, sha256 } from '../crypto/index.js';
import { json } from '../db/knex.js';
import { authorize } from '../authz/policy.js';
import { clears, isLabel, labelRank, type Label } from '../authz/labels.js';
import { isUniqueViolation, type AuditEvent } from '../audit/chain.js';
import { forbidden, HttpProblem, notFound } from '../http/problem.js';
import { loadPrincipal, workspacesFor } from '../http/middleware.js';
import { HostRefused } from '../mcp/hosts.js';
import { TOPICS, type IntegrationEvent } from '../platform/bus.js';
import type { JobProgressEvent } from '../platform/jobs.js';
import { Limiter } from '../platform/ratelimit.js';
import { RunnerUnavailable, type RunResult } from '../scripts/runner.js';
import type { Services } from '../services.js';
import { auditData, matchesEvent } from '../webhooks/service.js';
import { ACTION_CAPABILITY, ACTION_WITH, type Manifest } from './manifest.js';
import { domainCall, isDomainCall } from './broker-calls.js';
import { handlerProgram, isCall, isDone } from './sandbox.js';
import type { PluginRow } from './service.js';

/*
 * Plugins that run (1.4.0, Sprint 25): the dispatcher, declarative actions (B-2003) and the broker script handlers
 * call through (B-2004). After exprsn-platform's plugin host (a hook bus with capability-gated actions and a
 * worker-thread sandbox whose host proxies every call), re-built on this server's pieces: events come from the same
 * sources as webhooks (the audit chain, job states, flags and approvals), each delivery to a plugin is a row and a
 * `plugin.invoke` job, actions go through the existing services, and handlers run in the script sandbox.
 *
 * Fan-out is bounded:
 * - per plugin, `PLUGIN_RATE_PER_MINUTE` invocations a minute (events past it are dropped, counted in
 *   `exprsn_plugin_dropped_total{reason="rate"}` and audited once a window as `plugin.throttled`);
 * - per plugin, `PLUGIN_CONCURRENCY` invocations running at once across instances (the rest wait as queued jobs);
 * - per handler run, `PLUGIN_MAX_CALLS` brokered calls and the sandbox's time and memory limits.
 *
 * Loops (the rule, also in docs/security.md): every effect of a plugin carries the chain of plugins that caused it.
 * An event caused by a chain is never delivered to a plugin already in that chain (so a plugin's own actions never
 * trigger it again, directly or through other plugins), and is dropped once the chain is `PLUGIN_MAX_DEPTH` plugins
 * long. The chain follows the work: it is carried in-process while an invocation runs (an AsyncLocalStorage, which
 * covers the audit entries, flags and approvals its actions cause), in the invocation row across the job queue, and
 * in a workflow run's trigger (`plugin:<chain>`) for runs a plugin started. Job states of plugin and webhook
 * deliveries are never delivered to plugins. What leaves the platform (a webhook receiver that calls the API back) is
 * not traced; the rate limit bounds it.
 */

/** The chain of plugins (ids, oldest first) the work in progress was caused by. */
export interface PluginCause {
  chain: string[];
}

export const pluginCause = new AsyncLocalStorage<PluginCause>();

/** Platform calls a handler may make, and the capability each needs. Declarative actions are the first six. */
export const CALL_CAPABILITY: Record<string, string> = {
  ...ACTION_CAPABILITY,
  'records.read': 'read:records',
  'records.write': 'write:records',
  'files.read': 'read:files',
  'groups.read': 'read:groups',
  'posts.write': 'write:posts'
};
// B-3904 (1.5.0): the domain calls (records, files, groups, posts) are live; they answered 501 in 1.4.0.

export interface EventEnvelope {
  id: string;
  type: string;
  tenant: string;
  label: Label;
  createdAt: string;
  data: Record<string, unknown>;
}

interface InvocationRow {
  id: string;
  tenant_id: string;
  plugin_id: string;
  event_type: string;
  event_id: string;
  label: Label;
  event_sealed: string;
  chain: string[];
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  attempts: number;
  job_id: string | null;
  outcome: unknown;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const invFromRow = (r: Record<string, unknown>): InvocationRow => ({ ...(r as unknown as InvocationRow), chain: json<string[]>(r.chain, []), outcome: json<unknown>(r.outcome, null), attempts: Number(r.attempts ?? 0), created_at: Number(r.created_at), started_at: num(r.started_at), finished_at: num(r.finished_at) });

export const invocationView = (i: InvocationRow) => ({
  id: i.id,
  event: i.event_type,
  eventId: i.event_id,
  label: i.label,
  state: i.state,
  attempts: i.attempts,
  chain: i.chain,
  outcome: i.outcome,
  error: i.error,
  jobId: i.job_id,
  createdAt: i.created_at,
  startedAt: i.started_at,
  finishedAt: i.finished_at
});

/** Fills `{{event.type}}`, `{{event.data.flag}}`, `{{config.channel}}` from the event and the install's config. */
export function render(template: string, scope: Record<string, unknown>, max = 2000): string {
  return template
    .replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_m, path: string) => {
      let v: unknown = scope;
      for (const k of path.split('.')) v = v != null && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
      return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v as string | number | boolean);
    })
    .slice(0, max);
}

const plain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What an action or call runs with. */
interface ActContext {
  plugin: PluginRow;
  invocation: InvocationRow;
  event: EventEnvelope;
  config: Record<string, unknown>;
  /** Delivery ids within the invocation (webhook calls). */
  seq: { n: number };
}

export class PluginRuntime {
  private readonly offs: (() => void)[] = [];
  private limiterInstance: Limiter | null = null;
  readonly invocations: client.Counter<'result'>;
  readonly dropped: client.Counter<'reason'>;
  readonly calls: client.Counter<'api' | 'status'>;

  constructor(
    private readonly s: () => Services,
    reg: client.Registry
  ) {
    const counter = <T extends string>(name: string, help: string, labelNames: T[]) => (reg.getSingleMetric(name) as client.Counter<T> | undefined) ?? new client.Counter({ name, help, labelNames, registers: [reg] });
    this.invocations = counter('exprsn_plugin_invocations_total', 'Plugin invocations by result', ['result']);
    this.dropped = counter('exprsn_plugin_dropped_total', 'Events not delivered to a plugin, by reason (rate, depth, loop)', ['reason']);
    this.calls = counter('exprsn_plugin_calls_total', 'Brokered platform calls from plugin handlers, by API and status', ['api', 'status']);
  }

  /** Invocations a minute per plugin, in the shared counter store (one limit across instances with Redis). */
  private get limiter(): Limiter {
    return (this.limiterInstance ??= new Limiter(this.s().counters, 'plugin', this.s().cfg.PLUGIN_RATE_PER_MINUTE, 60_000));
  }

  registerJobs(): void {
    const s = this.s();
    s.jobs.register('plugin.invoke', (p, ctx) => this.invoke(String(p.invocationId), ctx.signal), { timeoutMs: (s.cfg.PLUGIN_SCRIPT_TIMEOUT_SECONDS + 120) * 1000 });
  }

  /** Subscribes to the event sources on this instance, as the webhook fan-out does: each fires where it happens. */
  listen(): void {
    const s = this.s();
    const swallow = (p: Promise<unknown>) => void p.catch((err: unknown) => s.log.warn({ err }, 'plugin fan-out failed'));
    this.offs.push(
      s.audit.onAppend((e) => swallow(this.offer(e.tenant_id, e.action, e.label, `audit:${e.id}`, auditData(e), e))),
      s.bus.on<JobProgressEvent>(TOPICS.jobProgress, (e) => {
        if (!['succeeded', 'failed', 'cancelled'].includes(e.state)) return;
        // The plugin and webhook deliveries themselves are never events for plugins: they would feed back.
        if (e.type.startsWith('plugin.') || e.type.startsWith('webhook.')) return;
        swallow(this.offer(e.tenantId, `job.${e.state}`, 'internal', `job:${e.id}:${e.state}`, { id: e.id, type: e.type, state: e.state, error: e.error }));
      }),
      s.bus.on<IntegrationEvent>(TOPICS.integrationEvent, (e) => swallow(this.offer(e.tenantId, e.type, e.label, e.id, e.data)))
    );
  }

  close(): void {
    for (const off of this.offs.splice(0)) off();
  }

  // ---------- fan-out ----------

  /**
   * Delivers an event to every enabled plugin of the tenant that subscribes to it at this label (and, for a
   * declarative plugin, has an action for it), within the loop rule and the rate limit: one invocation row and one
   * `plugin.invoke` job each. Returns the number queued.
   */
  async offer(tenantId: string, type: string, label: Label, eventId: string, data: Record<string, unknown>, audit?: AuditEvent): Promise<number> {
    if (tenantId === 'platform') return 0;
    const cause = pluginCause.getStore();
    const s = this.s();
    const enabled = await s.plugins.enabled(tenantId);
    if (!enabled.length) return 0;
    const want = enabled.filter((p) => matchesEvent(p.events, type) && labelRank(label) <= labelRank(p.maxLabel) && (p.kind !== 'declarative' || p.actionOn.some((on) => on == null || matchesEvent([on], type))));
    if (!want.length) return 0;
    let chain = cause?.chain ?? [];
    if (!cause) {
      const byKey = audit?.actor.service?.startsWith('plugin:') ? enabled.find((p) => `plugin:${p.key}` === audit.actor.service) : undefined;
      chain = byKey ? [byKey.id] : await this.workflowChain(tenantId, type, data);
    }
    if (chain.length >= s.cfg.PLUGIN_MAX_DEPTH) {
      this.dropped.inc({ reason: 'depth' }, want.length);
      return 0;
    }
    const envelope: EventEnvelope = { id: eventId, type, tenant: tenantId, label, createdAt: new Date().toISOString(), data };
    let n = 0;
    for (const p of want) {
      if (chain.includes(p.id)) {
        this.dropped.inc({ reason: 'loop' });
        continue;
      }
      const r = await this.limiter.consume(`${tenantId}:${p.id}`);
      if (!r.allowed) {
        this.dropped.inc({ reason: 'rate' });
        // Audited once a window, as the plugin's own effect (so it cannot trigger the plugin again).
        if (r.count === this.limiter.points + 1) {
          await pluginCause.run({ chain: [...chain, p.id] }, () => s.audit.append({ tenantId, action: 'plugin.throttled', kind: 'system', actor: { service: 'plugins' }, target: { plugin: p.id, key: p.key }, label: 'internal', detail: { perMinute: this.limiter.points, event: type, resetMs: r.resetMs } }));
        }
        continue;
      }
      if (await this.enqueue(tenantId, p.id, envelope, chain)) n++;
    }
    return n;
  }

  /** The chain behind an event about a workflow run that a plugin started (its trigger is `plugin:<chain>`). */
  private async workflowChain(tenantId: string, type: string, data: Record<string, unknown>): Promise<string[]> {
    const db = this.s().db;
    let run: { trigger: string } | undefined;
    const target = plain(data.target) ? data.target : null;
    const runId = typeof target?.run === 'string' ? target.run : typeof data.run === 'string' && data.kind === 'workflow' ? data.run : null;
    if (runId && (type.startsWith('workflow.') || type === 'approval.requested')) run = (await db('workflow_runs').where({ tenant_id: tenantId, id: runId }).first('trigger')) as typeof run;
    else if (type.startsWith('job.') && data.type === 'workflow.run' && typeof data.id === 'string') run = (await db('workflow_runs').where({ tenant_id: tenantId, job_id: data.id }).first('trigger')) as typeof run;
    return run?.trigger.startsWith('plugin:') ? run.trigger.slice('plugin:'.length).split(',').filter(Boolean) : [];
  }

  private async enqueue(tenantId: string, pluginId: string, e: EventEnvelope, chain: string[]): Promise<boolean> {
    const s = this.s();
    const id = ulid();
    try {
      await s.db('plugin_invocations').insert({ id, tenant_id: tenantId, plugin_id: pluginId, event_type: e.type.slice(0, 120), event_id: e.id.slice(0, 120), label: e.label, event_sealed: await s.keys.seal(tenantId, JSON.stringify(e), `plugin-invocation:${id}`), chain: JSON.stringify(chain), state: 'queued', attempts: 0, job_id: null, outcome: null, error: null, created_at: Date.now(), started_at: null, finished_at: null });
    } catch (err) {
      if (isUniqueViolation(err)) return false; // already delivered to this plugin (another instance saw it too)
      throw err;
    }
    await this.schedule(tenantId, id, Date.now());
    return true;
  }

  private async schedule(tenantId: string, invocationId: string, runAt: number): Promise<void> {
    const job = await this.s().jobs.enqueue({ tenantId, type: 'plugin.invoke', payload: { invocationId }, runAt, maxAttempts: 1 });
    await this.s().db('plugin_invocations').where({ id: invocationId }).update({ job_id: job.id });
  }

  // ---------- invocation ----------

  private async pluginRow(tenantId: string, id: string): Promise<PluginRow | null> {
    const r = await this.s().db('plugins').where({ tenant_id: tenantId, id }).first();
    return r ? this.s().plugins.fromRow(r) : null;
  }

  /** The `plugin.invoke` job: claims a concurrency slot, then runs the plugin's actions or its handler. */
  async invoke(invocationId: string, signal: AbortSignal): Promise<unknown> {
    const s = this.s();
    const raw = await s.db('plugin_invocations').where({ id: invocationId }).first();
    if (!raw) return { skipped: 'invocation removed' };
    const inv = invFromRow(raw);
    if (inv.state !== 'queued') return { skipped: `invocation is ${inv.state}` };
    const p = await this.pluginRow(inv.tenant_id, inv.plugin_id);
    if (!p || p.state !== 'enabled') {
      await s.db('plugin_invocations').where({ id: inv.id, state: 'queued' }).update({ state: 'cancelled', error: 'The plugin is no longer enabled.', finished_at: Date.now() });
      this.invocations.inc({ result: 'cancelled' });
      return { cancelled: 'plugin not enabled' };
    }
    const t = Date.now();
    const claimed = await s.db('plugin_invocations').where({ id: inv.id, state: 'queued' }).update({ state: 'running', started_at: t, attempts: inv.attempts + 1 });
    if (claimed !== 1) return { skipped: 'claimed elsewhere' };
    // The concurrency bound: take the slot, then look; over the limit, give it back and wait (across instances).
    // An invocation left running by an instance that stopped stops counting once it is past the job's time limit.
    const stale = t - (s.cfg.PLUGIN_SCRIPT_TIMEOUT_SECONDS + 120) * 1000;
    const running = Number(((await s.db('plugin_invocations').where({ plugin_id: p.id, state: 'running' }).andWhere('started_at', '>', stale).count({ n: '*' }).first()) as { n: number | string }).n);
    if (running > s.cfg.PLUGIN_CONCURRENCY) {
      await s.db('plugin_invocations').where({ id: inv.id, state: 'running' }).update({ state: 'queued', started_at: null });
      await this.schedule(inv.tenant_id, inv.id, Date.now() + 250 + Math.floor(Math.random() * 750));
      return { deferred: `${running - 1} invocations of ${p.plugin_key} running` };
    }
    let outcome: unknown = null;
    let error: string | null;
    try {
      const event = JSON.parse(await s.keys.open(inv.tenant_id, inv.event_sealed, `plugin-invocation:${inv.id}`)) as EventEnvelope;
      const config = p.config_sealed ? (JSON.parse(await s.keys.open(inv.tenant_id, p.config_sealed, `plugin-config:${p.id}`)) as Record<string, unknown>) : {};
      const ctx: ActContext = { plugin: p, invocation: inv, event, config, seq: { n: 0 } };
      // Everything the plugin does from here carries its chain (the loop rule).
      const r = await pluginCause.run({ chain: [...inv.chain, p.id] }, () => (p.kind === 'script' ? this.runHandler(ctx, signal) : this.runActions(ctx)));
      outcome = r.outcome;
      error = r.error;
    } catch (err) {
      error = (err as Error).message;
    }
    const state = error ? 'failed' : 'succeeded';
    await s.db('plugin_invocations').where({ id: inv.id }).update({ state, outcome: outcome == null ? null : JSON.stringify(outcome).slice(0, 60_000), error: error?.slice(0, 1000) ?? null, finished_at: Date.now() });
    this.invocations.inc({ result: state });
    if (error) s.log.info({ plugin: p.plugin_key, invocation: inv.id, err: error }, 'plugin invocation failed');
    return { state, ...(error ? { error } : {}) };
  }

  /** B-2003: the declarative actions for this event (or a webhook plugin's delivery), each gated by its capability. */
  private async runActions(ctx: ActContext): Promise<{ outcome: unknown; error: string | null }> {
    const m = ctx.plugin.manifest;
    const actions: NonNullable<Manifest['actions']> = m.kind === 'webhook' ? [{ type: 'webhook', with: { url: m.webhook!.url } }] : (m.actions ?? []).filter((a) => !a.on || matchesEvent([a.on], ctx.event.type));
    const out: Record<string, unknown>[] = [];
    let failed = 0;
    for (const a of actions) {
      try {
        const r = await this.perform(ctx, a.type, a.with ?? {}, 'action');
        out.push({ type: a.type, ok: true, ...(plain(r) ? r : {}) });
      } catch (err) {
        failed++;
        const e = err as Error;
        out.push({ type: a.type, ok: false, ...(e instanceof HttpProblem ? { status: e.status } : {}), error: e.message.slice(0, 300) });
      }
    }
    return { outcome: { actions: out }, error: failed ? `${failed} of ${actions.length} actions failed or were refused` : null };
  }

  /**
   * One action or brokered call: the capability check (an ungranted one is refused with 403 and audited as
   * `plugin.action.refused` or `plugin.call.refused`), then the effect through the existing service.
   */
  private async perform(ctx: ActContext, api: string, args: Record<string, unknown>, via: 'action' | 'call', grants = ctx.plugin.granted): Promise<Record<string, unknown> | null> {
    const s = this.s();
    const p = ctx.plugin;
    const cap = CALL_CAPABILITY[api];
    if (!cap) throw notFound(`Platform call ${api.slice(0, 60)}`);
    if (!grants.includes(cap)) {
      await s.audit.append({ tenantId: p.tenant_id, action: via === 'action' ? 'plugin.action.refused' : 'plugin.call.refused', kind: 'system', actor: { service: `plugin:${p.plugin_key}` }, target: { plugin: p.id, key: p.plugin_key, invocation: ctx.invocation.id }, label: 'internal', detail: { [via]: api, capability: cap, granted: grants, event: ctx.event.type } });
      throw forbidden(`${p.plugin_key} is not granted ${cap}, which ${via === 'action' ? `a ${api} action` : `the ${api} call`} needs.`, { step: 'capability', capability: cap });
    }
    if (isDomainCall(api)) return domainCall(s, p, api, args, ctx.event.label);
    const schema = ACTION_WITH[api];
    if (schema) {
      const parsed = schema.safeParse(args);
      if (!parsed.success) throw new HttpProblem(400, 'Invalid request', `${api}: ${parsed.error.issues[0]?.message ?? 'invalid arguments'}`, { extensions: { errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
    }
    const scope = { event: ctx.event, config: ctx.config, plugin: { key: p.plugin_key, name: p.name, version: p.version } };
    const str = (v: unknown, fallback: string, max = 2000) => render(typeof v === 'string' ? v : fallback, scope, max);
    const label = ctx.event.label;
    switch (api) {
      case 'log': {
        const level = args.level === 'warn' || args.level === 'error' ? args.level : 'info';
        await this.log(p, ctx.invocation.id, level, str(args.message, `${ctx.event.type} received`, 4000));
        return null;
      }
      case 'audit': {
        const detail: Record<string, unknown> = { message: str(args.message, `${p.plugin_key} saw ${ctx.event.type}`, 500), event: ctx.event.type, eventId: ctx.event.id };
        if (plain(args.detail)) for (const [k, v] of Object.entries(args.detail).slice(0, 20)) detail[`x_${k.slice(0, 40)}`] = typeof v === 'string' ? render(v, scope, 500) : v;
        const e = await s.audit.append({ tenantId: p.tenant_id, action: 'plugin.audited', kind: 'system', actor: { service: `plugin:${p.plugin_key}` }, target: { plugin: p.id, key: p.plugin_key }, label, detail });
        return { seq: e.seq };
      }
      case 'notify': {
        const roles = Array.isArray(args.roles) ? args.roles.map(String) : [];
        const users = Array.isArray(args.users) ? args.users.map(String) : [];
        const ids = new Set([...users, ...(await s.notifications.usersWithRoles(p.tenant_id, roles.length || !users.length ? (roles.length ? roles : ['tenant-admin']) : []))]);
        // Only active users of the tenant cleared for the event's label are told about it.
        const rows = ids.size ? ((await s.db('users').where({ tenant_id: p.tenant_id, state: 'active' }).whereIn('id', [...ids]).select('id', 'clearance')) as { id: string; clearance: string }[]) : [];
        const to = rows.filter((u) => isLabel(u.clearance) && clears(u.clearance, label)).map((u) => u.id);
        const body = str(args.body, '', 1000);
        const sent = await s.notifications.notify({ tenantId: p.tenant_id, userIds: to, kind: 'plugin', title: str(args.title, `${p.name}: ${ctx.event.type}`, 200), ...(body ? { body } : {}), label });
        return { notified: sent.length };
      }
      case 'flag': {
        const severity = args.severity === 'high' || args.severity === 'medium' ? args.severity : 'low';
        const f = await s.guard.flags.create({ tenantId: p.tenant_id, workspaceId: null, kind: 'report', checkpoint: 'plugin', ruleName: `Plugin ${p.name}`.slice(0, 200), severity, label, note: str(args.reason, `Raised by ${p.plugin_key} on ${ctx.event.type}`, 1000), actor: { name: `plugin ${p.plugin_key}`, via: 'plugin' }, source: { kind: 'plugin', id: p.id } });
        return { flag: `F-${f.number}` };
      }
      case 'webhook': {
        const url = typeof args.url === 'string' ? args.url : typeof ctx.config.webhookUrl === 'string' ? ctx.config.webhookUrl : p.manifest.webhook?.url;
        if (!url) throw new HttpProblem(422, 'No endpoint', `${p.plugin_key} has no webhook endpoint: give with.url in the manifest or webhookUrl in its configuration.`);
        let w;
        try {
          w = await s.webhooks.managed(p.tenant_id, p.plugin_key, url, p.max_label);
        } catch (err) {
          if (err instanceof HostRefused) throw new HttpProblem(422, 'Endpoint refused', `The endpoint is refused by the outbound host rules: ${err.message}`);
          throw err;
        }
        const data = via === 'call' && plain(args.data) ? args.data : ctx.event.data;
        const d = await s.webhooks.sendTo(w, ctx.event.type, label, `plugin:${ctx.invocation.id}:${++ctx.seq.n}`, data);
        return { webhook: w.id, delivery: d?.id ?? null };
      }
      case 'workflow':
        return this.startWorkflow(ctx, args);
      default:
        throw notFound(`Platform call ${api}`);
    }
  }

  /**
   * B-2003 `call:workflow`: starts a published workflow of the tenant as the user who installed the plugin (who must
   * still be active and allowed to run workflows), at no more than the plugin's label. The run's trigger is
   * `plugin:<chain>`, so the events of the run carry the chain (the loop rule).
   */
  private async startWorkflow(ctx: ActContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const s = this.s();
    const p = ctx.plugin;
    if (!p.installed_by) throw forbidden(`${p.plugin_key} was installed from the command line; a plugin starts workflows as the user who installed it.`, { step: 'role' });
    const who = await loadPrincipal(s, p.tenant_id, p.installed_by, {});
    if (!who) throw forbidden(`The user who installed ${p.plugin_key} is no longer active.`, { step: 'role' });
    if (!authorize(who, 'agents:run').allow) throw forbidden(`The user who installed ${p.plugin_key} may no longer run workflows.`, { step: 'role' });
    who.clearance = labelRank(who.clearance) < labelRank(p.max_label) ? who.clearance : p.max_label;
    who.workspaceId = null;
    if (typeof args.workspace === 'string') {
      if (!(await workspacesFor(s, who)).some((w) => w.id === args.workspace)) throw forbidden('The installer is not a member of that workspace.', { step: 'role' });
      who.workspaceId = args.workspace;
    }
    const input = { ...(plain(args.input) ? args.input : {}), ...(args.includeEvent ? { event: ctx.event } : {}) };
    const chain = pluginCause.getStore()?.chain ?? [...ctx.invocation.chain, p.id];
    const run = await s.workflows.start(who, String(args.workflow), { input, dry: false, trigger: `plugin:${chain.join(',')}` });
    await s.audit.append({ tenantId: p.tenant_id, action: 'workflow.run.started', kind: 'system', actor: { service: `plugin:${p.plugin_key}`, user: p.installed_by }, target: { workflow: run.workflow_id, run: run.id }, label: run.label, detail: { version: run.version, plugin: p.plugin_key, event: ctx.event.type } });
    return { run: run.id };
  }

  /** Appends to the plugin's own log (sealed: messages may quote the event). */
  async log(p: Pick<PluginRow, 'id' | 'tenant_id'>, invocationId: string | null, level: 'info' | 'warn' | 'error', message: string): Promise<void> {
    const s = this.s();
    const id = ulid();
    await s.db('plugin_logs').insert({ id, tenant_id: p.tenant_id, plugin_id: p.id, invocation_id: invocationId, level, message_sealed: await s.keys.seal(p.tenant_id, message.slice(0, 16_000), `plugin-log:${id}`), created_at: Date.now() });
  }

  // ---------- script handlers (B-2004) ----------

  /**
   * Runs a script plugin's handler in the sandbox with the event, a scoped token and the broker on its stdin and
   * stdout. The token is made for this invocation, lives for the handler's time limit, carries the grants as they
   * are now, and is revoked when the handler ends.
   */
  private async runHandler(ctx: ActContext, signal: AbortSignal): Promise<{ outcome: unknown; error: string | null }> {
    const s = this.s();
    const p = ctx.plugin;
    const script = p.manifest.script!;
    const runner = s.scripts.runner;
    if (!runner.session) throw new RunnerUnavailable(`The script sandbox (${runner.name}) cannot run plugin handlers.`);
    const { token, id: tokenId } = await this.issueToken(p, ctx.invocation.id);
    const calls: { api: string; status: number }[] = [];
    let done: { result?: unknown; error?: string; status?: number | null } | null = null;
    let res: RunResult;
    try {
      const hello = { t: 'hello', token, event: ctx.event, config: ctx.config, plugin: { key: p.plugin_key, version: p.version }, maxCalls: s.cfg.PLUGIN_MAX_CALLS };
      res = await runner.session(
        { id: ctx.invocation.id, language: script.language ?? 'javascript', source: handlerProgram(script.language ?? 'javascript', script.source, script.entry), stdin: JSON.stringify(hello), limits: { timeoutSeconds: s.cfg.PLUGIN_SCRIPT_TIMEOUT_SECONDS, memoryMb: s.cfg.PLUGIN_SCRIPT_MEMORY_MB, cpus: 1, pids: 64, outputKb: 64 } },
        async (msg) => {
          if (isCall(msg)) {
            const r = await this.brokerCall(String(msg.token), String(msg.api), plain(msg.args) ? msg.args : {}, ctx);
            calls.push({ api: String(msg.api).slice(0, 60), status: r.status });
            return { t: 'result', id: msg.id, ...r };
          }
          if (isDone(msg)) done = msg;
          return null;
        },
        signal
      );
    } finally {
      await s.db('plugin_tokens').where({ id: tokenId }).update({ revoked_at: Date.now() });
    }
    const finished = done as { result?: unknown; error?: string; status?: number | null } | null;
    const text = [res.stdout.trim(), res.stderr.trim()].filter(Boolean).join('\n');
    if (text) await this.log(p, ctx.invocation.id, res.exitCode === 0 ? 'info' : 'error', text);
    if (finished && finished.result !== undefined && finished.result !== null) await this.log(p, ctx.invocation.id, 'info', `returned ${JSON.stringify(finished.result).slice(0, 4000)}`);
    const outcome = { calls, exitCode: res.exitCode, timedOut: res.timedOut, durationMs: res.durationMs, returned: finished != null && !finished.error };
    const error = res.timedOut ? `The handler stopped at its ${s.cfg.PLUGIN_SCRIPT_TIMEOUT_SECONDS} s limit.` : finished?.error ? `The handler failed: ${finished.error}` : res.exitCode !== 0 ? `The handler exited with ${res.exitCode}.` : !finished ? 'The handler ended without returning.' : null;
    return { outcome, error };
  }

  private async issueToken(p: PluginRow, invocationId: string): Promise<{ token: string; id: string }> {
    const s = this.s();
    const token = `xpt_${randomToken(32)}`;
    const id = ulid();
    const t = Date.now();
    await s.db('plugin_tokens').insert({ id, tenant_id: p.tenant_id, plugin_id: p.id, invocation_id: invocationId, token_hash: sha256(token), grants: JSON.stringify(p.granted), calls: 0, expires_at: t + (s.cfg.PLUGIN_SCRIPT_TIMEOUT_SECONDS + 30) * 1000, revoked_at: null, created_at: t });
    return { token, id };
  }

  /**
   * The broker (B-2004): one platform call from a handler, with its scoped token. The token must be live (not
   * expired, not revoked, within `PLUGIN_MAX_CALLS`), its plugin still enabled, and the call's capability in both the
   * token's grants and the plugin's grants now (a grant withdrawn mid-run takes effect at once). An ungranted call
   * is 403 and audited. Used by the sandbox channel and by `POST /plugin-broker/v1/calls/:api`.
   */
  async brokerCall(token: string, api: string, args: Record<string, unknown>, known?: ActContext): Promise<{ status: number; body?: unknown; detail?: string }> {
    const s = this.s();
    const answer = (status: number, detail: string) => {
      this.calls.inc({ api: CALL_CAPABILITY[api] ? api : 'unknown', status: String(status) });
      return { status, detail };
    };
    const row = (await s.db('plugin_tokens').where({ token_hash: sha256(String(token)) }).first()) as Record<string, unknown> | undefined;
    if (!row || row.revoked_at != null || Number(row.expires_at) < Date.now()) return answer(401, 'The plugin token is not valid (unknown, expired or revoked).');
    const tenantId = String(row.tenant_id);
    const p = await this.pluginRow(tenantId, String(row.plugin_id));
    if (!p || p.state !== 'enabled') return answer(403, 'The plugin is no longer enabled.');
    const n = await s.db('plugin_tokens').where({ id: String(row.id) }).andWhere('calls', '<', s.cfg.PLUGIN_MAX_CALLS).increment('calls', 1);
    if (n !== 1) return answer(429, `A handler run may make ${s.cfg.PLUGIN_MAX_CALLS} platform calls (PLUGIN_MAX_CALLS).`);
    const tokenGrants = json<string[]>(row.grants, []);
    const grants = p.granted.filter((g) => tokenGrants.includes(g));
    let ctx = known;
    if (!ctx || ctx.invocation.id !== row.invocation_id) {
      const inv = await s.db('plugin_invocations').where({ id: String(row.invocation_id) }).first();
      if (!inv) return answer(401, 'The plugin token is not valid (its invocation is gone).');
      const i = invFromRow(inv);
      ctx = { plugin: p, invocation: i, event: JSON.parse(await s.keys.open(tenantId, i.event_sealed, `plugin-invocation:${i.id}`)) as EventEnvelope, config: p.config_sealed ? (JSON.parse(await s.keys.open(tenantId, p.config_sealed, `plugin-config:${p.id}`)) as Record<string, unknown>) : {}, seq: { n: 1000 } };
    } else ctx = { ...ctx, plugin: p };
    const c = ctx;
    try {
      const body = await pluginCause.run({ chain: [...c.invocation.chain, p.id] }, () => this.perform(c, api, args, 'call', grants));
      this.calls.inc({ api, status: '200' });
      return { status: 200, body: body ?? {} };
    } catch (err) {
      if (err instanceof HttpProblem) return answer(err.status, err.message);
      s.log.warn({ plugin: p.plugin_key, api, err: (err as Error).message }, 'brokered plugin call failed');
      return answer(500, `The ${api} call failed: ${(err as Error).message.slice(0, 300)}`);
    }
  }

  // ---------- reads ----------

  async invocationsOf(tenantId: string, pluginId: string, opts: { limit?: number; state?: string } = {}) {
    const q = this.s().db('plugin_invocations').where({ tenant_id: tenantId, plugin_id: pluginId });
    if (opts.state) q.andWhere({ state: opts.state });
    return ((await q.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(Math.min(opts.limit ?? 50, 200))) as Record<string, unknown>[]).map(invFromRow).map(invocationView);
  }

  async logsOf(tenantId: string, pluginId: string, opts: { limit?: number; invocation?: string } = {}) {
    const s = this.s();
    const q = s.db('plugin_logs').where({ tenant_id: tenantId, plugin_id: pluginId });
    if (opts.invocation) q.andWhere({ invocation_id: opts.invocation });
    const rows = (await q.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(Math.min(opts.limit ?? 100, 500))) as { id: string; invocation_id: string | null; level: string; message_sealed: string; created_at: number }[];
    return Promise.all(rows.map(async (r) => ({ id: r.id, invocationId: r.invocation_id, level: r.level, message: await s.keys.open(tenantId, r.message_sealed, `plugin-log:${r.id}`), at: Number(r.created_at) })));
  }
}

