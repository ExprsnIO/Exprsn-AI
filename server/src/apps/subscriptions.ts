import { ulid } from 'ulid';
import { fetch } from 'undici';
import { z } from 'zod';
import { actorFrom, isUniqueViolation, PLATFORM_TENANT } from '../audit/chain.js';
import { clears, LABELS, labelRank, type Label } from '../authz/labels.js';
import { authorize, effectivePermissions, type Principal } from '../authz/policy.js';
import { randomToken, sha256 } from '../crypto/index.js';
import { json } from '../db/knex.js';
import { loadPrincipal } from '../http/middleware.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { tenantHostProblem } from '../integrations/hosts.js';
import { checkUrl, guardedAgent, HostRefused, parseAllowList } from '../mcp/hosts.js';
import type { JobContext, Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import { mac, macMatches } from '../vault/keyring.js';
import { signBody } from '../webhooks/service.js';
import { buildPreset, checkTimeZone, describeSchedule, nextRunOrNull, nextRuns, ScheduleError, scheduleProblem, SCHEDULE_PRESETS, presetView } from '../workflows/schedules.js';
import type { Actor, AppRow, AppService } from './service.js';

/*
 * 1.8.0, Sprint 44 (B-124): scheduled delivery of an app's views, reports, dashboards and records.
 *
 * A subscription names one object (`kind` and `id`, in an app), a format (XLSX, PDF, CSV or HTML), the object's
 * parameters and filters, a schedule (the workflow schedule model: a cron or a preset's cron read in an IANA zone,
 * `workflows/schedules.ts` `nextRun`), destinations and options:
 *
 * - email: the subscriber, and other people of the tenant a designer adds (`apps:design` on the app), each rendered
 *   as themselves, never with the subscriber's data; a file larger than APPS_DELIVERY_ATTACH_MAX_BYTES is not
 *   attached: a copy goes to the recipient's own file store ("Deliveries" in the app's workspace) and the email links
 *   to it (opening it needs a sign-in). Each email carries a signed unsubscribe link (and List-Unsubscribe headers)
 *   that stops only that recipient's copies;
 * - the file store: a folder the subscriber may write to (`files:write`, a member of its workspace), as the subscriber;
 * - a webhook: HMAC (the subscription's own secret, sealed, shown once) or Ed25519 (the tenant's webhook key) over
 *   `<timestamp>.<body>`, only to a host on the tenant's list of allowed hosts (an empty list allows none here), within
 *   the operator's rules, at or below the destination's label; adding one needs `webhooks:manage`;
 * - options: only when there are rows, only when the render changed since that recipient's last delivery (SHA-256 of
 *   the bytes), and a message.
 *
 * Every run renders through `s.appExports.render(principal, …)` as the recipient (the subscriber for the file store
 * and the webhook) and re-checks, before it renders, that the person is active, holds `records:read`, sees the app and
 * may read the object at its label; the render applies the reader's grant, clearance and, for objects over saved
 * connection queries, the connection query right. Someone who cannot read gets nothing, and the history says why.
 *
 * Runs: the `apps.subscriptions` tick claims each due time with one conditional update of `next_run_at` (one instance
 * runs it), writes a run row (unique per due time) and queues `apps.subscription.deliver`, tried
 * APPS_DELIVERY_MAX_ATTEMPTS times with the queue's backoff; a retry skips what was already delivered. After
 * APPS_DELIVERY_PAUSE_AFTER failed runs in a row the subscription pauses and its owner is told. The history keeps the
 * time, destination, recipient, rows, size and outcome of each delivery, never the content (the file-store copy is the
 * only one). Audited `app.subscription.*` and `app.delivery.*`.
 */

export const DELIVERY_FORMATS = ['xlsx', 'pdf', 'csv', 'html'] as const;
export const SUBSCRIBABLE_KINDS = ['view', 'report', 'dashboard', 'records'] as const;
export type DeliveryFormat = (typeof DELIVERY_FORMATS)[number];
export type SubscribableKind = (typeof SUBSCRIBABLE_KINDS)[number];

/** What a render is asked for (Sprint 44, B-123: `s.appExports.render`). */
export interface RenderRequest {
  kind: SubscribableKind;
  id: string;
  params: Record<string, unknown>;
  filters: unknown[];
  format: DeliveryFormat;
}

/** What a render returns. `label` is optional: the render's own label when it knows one, else the subscription's. */
export interface RenderResult {
  filename: string;
  contentType: string;
  bytes: Buffer | Uint8Array;
  rows: number;
  truncated: boolean;
  label?: Label;
}

export interface AppExportsLike {
  render(principal: Principal, req: RenderRequest): Promise<RenderResult>;
}

const id26 = z.string().length(26);
const MAX_SPEC_CHARS = 16_000;
const MAX_PER_OWNER = 50;
const MAX_OTHERS = 50;

const presetValues = z.object({ n: z.number().int().optional(), minute: z.number().int().optional(), hour: z.number().int().optional(), hour2: z.number().int().optional(), day: z.number().int().optional(), dow: z.number().int().optional() }).strict();

export const deliveryScheduleSchema = z
  .object({
    preset: z.string().trim().min(1).max(60).optional(),
    values: presetValues.optional(),
    cron: z.string().trim().min(1).max(120).optional(),
    timezone: z.string().trim().min(1).max(64).default('UTC')
  })
  .strict()
  .refine((b) => !!b.cron !== !!b.preset, 'Give a cron expression or a preset, not both');

const optionsSchema = z
  .object({
    onlyIfRows: z.boolean().default(false),
    onlyIfChanged: z.boolean().default(false),
    message: z.string().trim().max(1000).default('')
  })
  .strict();

const webhookUrl = z.string().trim().max(2000).refine((u) => /^https?:\/\//i.test(u), 'must start with http:// or https://');

export const subscriptionInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    /** The app, by id or name. */
    app: z.string().min(1).max(63),
    kind: z.enum(SUBSCRIBABLE_KINDS),
    /** The view, report or dashboard id; for `records`, the entity's id or name. */
    id: z.string().min(1).max(64),
    format: z.enum(DELIVERY_FORMATS),
    /** A report's parameters (as the export takes them: scalars, at most 10). */
    params: z.record(z.string().max(63), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).refine((v) => Object.keys(v).length <= 10, 'at most 10 parameters').default({}),
    /** Filters added to the object's own (each a records filter; a dashboard's first entry is its filter values). */
    filters: z.array(z.unknown()).max(30).default([]),
    schedule: deliveryScheduleSchema,
    destinations: z
      .object({
        email: z.object({ self: z.boolean().default(true), others: z.array(z.string().trim().min(1).max(100)).max(MAX_OTHERS).default([]) }).strict().default({ self: true, others: [] }),
        file: z.object({ folderId: id26 }).strict().nullable().default(null),
        webhook: z.object({ url: webhookUrl, signing: z.enum(['hmac', 'ed25519']).default('hmac'), maxLabel: z.enum(LABELS).default('internal') }).strict().nullable().default(null)
      })
      .strict(),
    options: optionsSchema.default({ onlyIfRows: false, onlyIfChanged: false, message: '' })
  })
  .strict();
export type SubscriptionInput = z.infer<typeof subscriptionInputSchema>;

export const subscriptionPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    format: z.enum(DELIVERY_FORMATS).optional(),
    schedule: deliveryScheduleSchema.optional(),
    options: optionsSchema.partial().strict().optional(),
    state: z.enum(['active', 'paused']).optional()
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to change');

interface Spec {
  name: string;
  params: Record<string, unknown>;
  filters: unknown[];
  options: z.infer<typeof optionsSchema>;
  folderId: string | null;
  webhook: { url: string; signing: 'hmac' | 'ed25519'; maxLabel: Label } | null;
  values: Record<string, number> | null;
}

interface SubRow {
  id: string;
  tenant_id: string;
  app_id: string;
  owner_id: string;
  kind: SubscribableKind;
  object_id: string;
  entity_id: string | null;
  label: Label;
  format: DeliveryFormat;
  cron: string;
  preset: string | null;
  timezone: string;
  spec: string;
  webhook_secret: string | null;
  state: 'active' | 'paused';
  paused_reason: string | null;
  failures: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_outcome: string | null;
  last_problem: string | null;
  created_at: number;
  updated_at: number;
}

interface RecipientRow {
  subscription_id: string;
  user_id: string;
  tenant_id: string;
  role: 'owner' | 'other';
  email: boolean;
  unsubscribed_at: number | null;
  last_hash: string | null;
}

type Destination = 'email' | 'file' | 'webhook';
const DELIVERED = new Set(['sent', 'linked']);

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const subFrom = (r: Record<string, unknown>): SubRow => ({ ...(r as unknown as SubRow), failures: Number(r.failures ?? 0), next_run_at: num(r.next_run_at), last_run_at: num(r.last_run_at), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
const rcptFrom = (r: Record<string, unknown>): RecipientRow => ({ ...(r as unknown as RecipientRow), email: !!r.email, unsubscribed_at: num(r.unsubscribed_at) });
const specAad = (id: string) => `app-subscription:${id}`;
const secretAad = (id: string) => `app-subscription-secret:${id}`;
const short = (s: string) => s.replace(/\s+/g, ' ').slice(0, 300);
const messageOf = (err: unknown) => (err instanceof HttpProblem ? (err.detail ?? err.title) : err instanceof Error ? err.message : String(err));

/** A failure a retry would not cure (no right, no address, a refused host): recorded, never retried. */
class Permanent extends Error {}

/** A render or access refusal: the recipient gets nothing. */
const isDenial = (err: unknown) => err instanceof HttpProblem && [401, 403, 404].includes(err.status);

const sizeText = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : n >= 1000 ? `${Math.round(n / 1000)} kB` : `${n} bytes`);

/** The cron a schedule input names, checked: a known zone, a schedule that runs, and runs far enough apart. */
export function cronOf(input: z.infer<typeof deliveryScheduleSchema>, minIntervalMs: number): { cron: string; timezone: string; preset: string | null; values: Record<string, number> | null } {
  try {
    checkTimeZone(input.timezone);
    const values = input.values ? (Object.fromEntries(Object.entries(input.values).filter(([, v]) => v !== undefined)) as Record<string, number>) : null;
    const cron = input.preset ? buildPreset(input.preset, values ?? {}) : input.cron!;
    const problem = scheduleProblem(cron, input.timezone);
    if (problem) throw new ScheduleError(problem);
    const runs = nextRuns(cron, input.timezone, 6);
    for (let i = 1; i < runs.length; i++) {
      if (runs[i]! - runs[i - 1]! < minIntervalMs) throw new ScheduleError(`Deliveries are at least ${Math.round(minIntervalMs / 60_000)} minutes apart (APPS_DELIVERY_MIN_INTERVAL_MINUTES); this schedule runs more often.`);
    }
    return { cron, timezone: input.timezone, preset: input.preset ?? null, values: input.preset ? values : null };
  } catch (err) {
    if (err instanceof ScheduleError) throw new HttpProblem(422, 'Schedule not valid', err.message);
    throw err;
  }
}

export interface DeliveryOptions {
  attachMaxBytes: number;
  maxAttempts: number;
  pauseAfter: number;
  minIntervalMs: number;
}

export class AppSubscriptions {
  constructor(
    private readonly s: () => Services,
    private readonly apps: AppService
  ) {}

  /** The limits, from the configuration (read when used: the services are built after this object). */
  get o(): DeliveryOptions {
    const c = this.s().cfg;
    return { attachMaxBytes: c.APPS_DELIVERY_ATTACH_MAX_BYTES, maxAttempts: c.APPS_DELIVERY_MAX_ATTEMPTS, pauseAfter: c.APPS_DELIVERY_PAUSE_AFTER, minIntervalMs: c.APPS_DELIVERY_MIN_INTERVAL_MINUTES * 60_000 };
  }

  private get db() {
    return this.s().db;
  }

  /** The renderer of Sprint 44 (B-123), when this build has it. */
  exports(): AppExportsLike | null {
    const x = (this.s() as unknown as { appExports?: Partial<AppExportsLike> }).appExports;
    return x && typeof x.render === 'function' ? (x as AppExportsLike) : null;
  }

  private requireExports(): AppExportsLike {
    const x = this.exports();
    if (!x) throw new HttpProblem(503, 'Not available', 'Rendering views, reports and dashboards for delivery is not available on this server yet (s.appExports.render, Sprint 44 B-123).');
    return x;
  }

  registerJobs(): void {
    const jobs = this.s().jobs;
    jobs.register('apps.subscriptions', async () => this.tick(), { timeoutMs: 10 * 60_000 });
    jobs.register('apps.subscription.deliver', (p, ctx) => this.deliver(String(p.runId), ctx), { timeoutMs: 15 * 60_000 });
  }

  schedule(scheduler: Scheduler, everyMs: number): void {
    scheduler.every('apps.subscriptions', everyMs, async () => [{ tenantId: PLATFORM_TENANT, key: 'all' }]);
  }

  private audit(actor: Actor, tenantId: string, action: string, target: Record<string, unknown>, label: Label, detail?: Record<string, unknown>) {
    return this.s().audit.append({ tenantId, action, kind: actor.principal ? 'admin' : 'system', actor: actor.principal ? actorFrom(actor.principal, actor.ip ?? null) : { service: actor.service ?? 'apps.subscriptions' }, target, label, ...(detail ? { detail } : {}), traceId: actor.traceId ?? null });
  }

  private systemAudit(tenantId: string, action: string, sub: SubRow, detail: Record<string, unknown>, user?: string) {
    return this.s().audit.append({ tenantId, action, kind: 'system', actor: { service: 'apps.subscriptions', ...(user ? { user } : {}) }, target: { subscription: sub.id, app: sub.app_id }, label: sub.label, detail });
  }

  private async openSpec(r: SubRow): Promise<Spec> {
    const d = json<Partial<Spec>>(await this.s().keys.open(r.tenant_id, r.spec, specAad(r.id)), {});
    return { name: String(d.name ?? ''), params: d.params ?? {}, filters: d.filters ?? [], options: optionsSchema.parse(d.options ?? {}), folderId: d.folderId ?? null, webhook: d.webhook ?? null, values: d.values ?? null };
  }

  private sealSpec(tenantId: string, id: string, spec: Spec): Promise<string> {
    return this.s().keys.seal(tenantId, JSON.stringify(spec), specAad(id));
  }

  private isAdmin(p: Principal): boolean {
    return effectivePermissions(p).has('tenant:manage');
  }

  // ---------- access ----------

  /**
   * Why `p` may not have the object now, or null. Re-run before every render: active (the caller passes a loaded
   * principal), `records:read`, the app visible, and the view or entity readable at its label. The render applies the
   * rest (the reader's grant, clearance of the content, the connection query right).
   */
  private async refusal(p: Principal, sub: Pick<SubRow, 'tenant_id' | 'app_id' | 'kind' | 'object_id' | 'entity_id' | 'label'>): Promise<string | null> {
    if (!authorize(p, 'records:read').allow) return 'They no longer hold records:read.';
    let app: AppRow;
    try {
      app = await this.apps.app(p, sub.app_id);
    } catch {
      return 'They can no longer see the app.';
    }
    if (app.workspace_id) p.workspaceId = app.workspace_id;
    if (sub.kind === 'view') {
      const v = (await this.db('app_views').where({ tenant_id: sub.tenant_id, id: sub.object_id }).first()) as { owner_id: string; shared: unknown; label: Label; app_id: string } | undefined;
      if (!v || v.app_id !== app.id) return 'The view no longer exists.';
      if (v.owner_id !== p.userId && !v.shared) return 'The view is private to its owner.';
      if (!clears(p.clearance, v.label)) return `The view is ${v.label}; their clearance is ${p.clearance}.`;
    } else if (sub.kind === 'records') {
      const e = await this.apps.entityById(sub.tenant_id, sub.object_id);
      if (!e || e.app_id !== app.id) return 'The entity no longer exists.';
      if (!clears(p.clearance, e.label)) return `The records are ${e.label}; their clearance is ${p.clearance}.`;
    }
    return null;
  }

  /** The object a new subscription names, checked as its subscriber: its id, entity and label. */
  private async resolveObject(p: Principal, input: SubscriptionInput): Promise<{ app: AppRow; objectId: string; entityId: string | null; label: Label }> {
    const app = await this.apps.app(p, input.app);
    if (app.workspace_id) p.workspaceId = app.workspace_id;
    if (input.kind === 'view') {
      const v = (await this.db('app_views').where({ tenant_id: p.tenantId, id: input.id }).first()) as { app_id: string; entity_id: string; label: Label } | undefined;
      if (!v || v.app_id !== app.id) throw notFound('View');
      const why = await this.refusal(p, { tenant_id: p.tenantId, app_id: app.id, kind: 'view', object_id: input.id, entity_id: v.entity_id, label: v.label });
      if (why) throw (why.startsWith('The view is private') ? notFound('View') : forbidden(why.replace(/^They|their/g, (m) => (m === 'They' ? 'You' : 'your')), { step: 'clearance' }));
      return { app, objectId: input.id, entityId: v.entity_id, label: v.label };
    }
    if (input.kind === 'records') {
      const { entity } = await this.apps.resolve(p, app.id, input.id);
      if (!clears(p.clearance, entity.label)) throw forbidden(`The records are ${entity.label}; your clearance is ${p.clearance}.`, { step: 'clearance' });
      return { app, objectId: entity.id, entityId: entity.id, label: entity.label };
    }
    // Reports and dashboards: the renderer decides who may read them; a check render as the subscriber now.
    const out = await this.requireExports().render(p, { kind: input.kind, id: input.id, params: input.params, filters: input.filters, format: input.format });
    return { app, objectId: input.id, entityId: null, label: out.label && labelRank(out.label) <= labelRank(app.label) ? out.label : app.label };
  }

  // ---------- subscriptions ----------

  private async view(viewer: Principal, r: SubRow, o: { secret?: string } = {}) {
    const spec = await this.openSpec(r);
    const rcpts = ((await this.db('app_subscription_recipients').where({ subscription_id: r.id })) as Record<string, unknown>[]).map(rcptFrom);
    const users = rcpts.length ? ((await this.db('users').where({ tenant_id: r.tenant_id }).whereIn('id', rcpts.map((x) => x.user_id)).select('id', 'username', 'display_name')) as { id: string; username: string; display_name: string }[]) : [];
    const who = new Map(users.map((u) => [u.id, u]));
    const app = await this.apps.appById(r.tenant_id, r.app_id);
    const owner = rcpts.find((x) => x.role === 'owner');
    const mine = r.owner_id === viewer.userId;
    const full = mine || this.isAdmin(viewer);
    const me = rcpts.find((x) => x.user_id === viewer.userId);
    const host = (() => {
      try {
        return spec.webhook ? new URL(spec.webhook.url).host : null;
      } catch {
        return null;
      }
    })();
    const base = {
      id: r.id,
      name: spec.name,
      app: app ? { id: app.id, name: app.name, title: app.title } : { id: r.app_id, name: null, title: null },
      kind: r.kind,
      objectId: r.object_id,
      entityId: r.entity_id,
      label: r.label,
      format: r.format,
      schedule: { cron: r.cron, preset: r.preset, values: spec.values, timezone: r.timezone, description: describeSchedule(r.cron, r.timezone) },
      state: r.state,
      pausedReason: r.paused_reason,
      nextRunAt: r.next_run_at,
      lastRunAt: r.last_run_at,
      lastOutcome: r.last_outcome,
      owner: { id: r.owner_id, name: who.get(r.owner_id)?.display_name ?? null, username: who.get(r.owner_id)?.username ?? null },
      mine,
      receiving: me ? me.email && me.unsubscribed_at == null : false,
      unsubscribed: me ? me.unsubscribed_at != null : false,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    };
    if (!full) return base;
    return {
      ...base,
      failures: r.failures,
      lastProblem: r.last_problem,
      params: spec.params,
      filters: spec.filters,
      options: spec.options,
      destinations: {
        email: {
          self: !!owner?.email,
          selfUnsubscribed: owner?.unsubscribed_at != null,
          others: rcpts.filter((x) => x.role === 'other').map((x) => ({ id: x.user_id, name: who.get(x.user_id)?.display_name ?? null, username: who.get(x.user_id)?.username ?? null, unsubscribed: x.unsubscribed_at != null }))
        },
        file: spec.folderId ? { folderId: spec.folderId } : null,
        webhook: spec.webhook ? { host, signing: spec.webhook.signing, maxLabel: spec.webhook.maxLabel } : null
      },
      ...(o.secret ? { webhookSecret: o.secret } : {})
    };
  }

  private async row(tenantId: string, id: string): Promise<SubRow | undefined> {
    const r = await this.db('app_subscriptions').where({ tenant_id: tenantId, id }).first();
    return r ? subFrom(r) : undefined;
  }

  /** A subscription the caller may see: theirs, one they receive, or (an admin) any in the tenant within clearance. */
  private async visible(p: Principal, id: string): Promise<SubRow> {
    const r = await this.row(p.tenantId, id);
    if (!r) throw notFound('Subscription');
    if (r.owner_id === p.userId) return r;
    if (this.isAdmin(p) && clears(p.clearance, r.label)) return r;
    const me = await this.db('app_subscription_recipients').where({ subscription_id: id, user_id: p.userId }).first();
    if (me) return r;
    throw notFound('Subscription');
  }

  async get(p: Principal, id: string) {
    return this.view(p, await this.visible(p, id));
  }

  /** The caller's own subscriptions and those that deliver to them. */
  async mine(p: Principal) {
    const own = ((await this.db('app_subscriptions').where({ tenant_id: p.tenantId, owner_id: p.userId }).orderBy('created_at', 'desc')) as Record<string, unknown>[]).map(subFrom);
    const ids = ((await this.db('app_subscription_recipients').where({ tenant_id: p.tenantId, user_id: p.userId, role: 'other' }).select('subscription_id')) as { subscription_id: string }[]).map((x) => x.subscription_id);
    const received = ids.length ? ((await this.db('app_subscriptions').where({ tenant_id: p.tenantId }).whereIn('id', ids).orderBy('created_at', 'desc')) as Record<string, unknown>[]).map(subFrom) : [];
    return { subscriptions: await Promise.all(own.map((r) => this.view(p, r))), received: await Promise.all(received.map((r) => this.view(p, r))) };
  }

  /** Every subscription in the tenant at labels the admin's clearance clears (`tenant:manage`). */
  async all(p: Principal, q: { state?: 'active' | 'paused'; app?: string } = {}) {
    const query = this.db('app_subscriptions').where({ tenant_id: p.tenantId }).whereIn('label', LABELS.filter((l) => clears(p.clearance, l)));
    if (q.state) query.andWhere({ state: q.state });
    if (q.app) query.andWhere({ app_id: q.app });
    const rows = ((await query.orderBy('created_at', 'desc').limit(500)) as Record<string, unknown>[]).map(subFrom);
    return { subscriptions: await Promise.all(rows.map((r) => this.view(p, r))) };
  }

  /** Schedule presets, formats and limits for the Subscribe dialog. */
  options() {
    return { presets: SCHEDULE_PRESETS.map(presetView), formats: DELIVERY_FORMATS, kinds: SUBSCRIBABLE_KINDS, attachMaxBytes: this.o.attachMaxBytes, minIntervalMinutes: Math.round(this.o.minIntervalMs / 60_000), emailEnabled: this.s().notifications.emailEnabled, renderAvailable: !!this.exports() };
  }

  /** The next runs of a schedule, checked as a subscription's would be. */
  preview(input: z.infer<typeof deliveryScheduleSchema>, count = 5) {
    const c = cronOf(input, this.o.minIntervalMs);
    const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: c.timezone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
    return { cron: c.cron, timezone: c.timezone, description: describeSchedule(c.cron, c.timezone), runs: nextRuns(c.cron, c.timezone, count).map((at) => ({ at, iso: new Date(at).toISOString(), local: fmt.format(new Date(at)) })) };
  }

  private async resolveUsers(p: Principal, refs: string[]): Promise<string[]> {
    const out = new Set<string>();
    for (const ref of refs) {
      const u = (ref.length === 26 ? await this.s().users.get(p.tenantId, ref) : undefined) ?? (await this.s().users.byUsername(p.tenantId, ref));
      if (!u || u.state !== 'active') throw badRequest(`There is no active person ${ref.slice(0, 60)} in this tenant.`);
      if (u.id !== p.userId) out.add(u.id);
    }
    return [...out];
  }

  /** Why a webhook address may not receive deliveries, or null: the tenant's list must name it, within the operator's rules. */
  private async webhookRefusal(tenantId: string, url: string): Promise<string | null> {
    const s = this.s();
    const tenantAllow = await s.integrations.allowList(tenantId);
    if (!tenantAllow) return "This tenant has no allowed hosts: a delivery webhook goes only to a host on the tenant's list (Admin, Integrations).";
    try {
      const checked = await checkUrl(url, parseAllowList(s.webhooks.o.allowedHosts));
      return tenantHostProblem(checked.host, checked.addresses, tenantAllow);
    } catch (err) {
      return err instanceof HostRefused ? err.message : `The address cannot be reached: ${(err as Error).message}`;
    }
  }

  async create(actor: Actor & { principal: Principal }, input: SubscriptionInput) {
    const p = actor.principal;
    const s = this.s();
    if (JSON.stringify({ params: input.params, filters: input.filters }).length > MAX_SPEC_CHARS) throw badRequest(`The parameters and filters are more than ${MAX_SPEC_CHARS} characters.`);
    const d = input.destinations;
    if (!d.email.self && !d.email.others.length && !d.file && !d.webhook) throw badRequest('Choose at least one destination: email, a folder in the file store or a webhook.');
    const count = Number(((await this.db('app_subscriptions').where({ tenant_id: p.tenantId, owner_id: p.userId }).count({ n: '*' })) as { n: number | string }[])[0]?.n ?? 0);
    if (count >= MAX_PER_OWNER) throw conflict(`You have ${MAX_PER_OWNER} subscriptions, the most one person may have; delete one first.`);
    const sched = cronOf(input.schedule, this.o.minIntervalMs);
    const obj = await this.resolveObject(p, input);
    // Other recipients: a designer of the app, cleared for it (each still gets only their own render).
    let others: string[] = [];
    if (d.email.others.length) {
      if (!effectivePermissions(p).has('apps:design')) throw forbidden('Sending to other people needs apps:design on the app; each of them gets their own render.', { step: 'role' });
      await this.apps.designable(p, obj.app.id);
      others = await this.resolveUsers(p, d.email.others);
    }
    if (d.file) {
      if (!authorize(p, 'files:write').allow) throw forbidden('Delivering to the file store needs files:write.', { step: 'role' });
      await s.files.folder(p, d.file.folderId);
    }
    let secret: string | null = null;
    if (d.webhook) {
      if (!effectivePermissions(p).has('webhooks:manage')) throw forbidden('A webhook destination needs webhooks:manage (the integrations right).', { step: 'role' });
      if (labelRank(obj.label) > labelRank(d.webhook.maxLabel)) throw badRequest(`The ${input.kind} is ${obj.label}; this webhook may carry data up to ${d.webhook.maxLabel}.`);
      const why = await this.webhookRefusal(p.tenantId, d.webhook.url);
      if (why) throw forbidden(why, { step: 'allowed-hosts' });
      if (d.webhook.signing === 'hmac') secret = randomToken(32);
    }
    const id = ulid();
    const t = Date.now();
    const spec: Spec = { name: input.name, params: input.params, filters: input.filters, options: input.options, folderId: d.file?.folderId ?? null, webhook: d.webhook ?? null, values: sched.values };
    const row = {
      id,
      tenant_id: p.tenantId,
      app_id: obj.app.id,
      owner_id: p.userId,
      kind: input.kind,
      object_id: obj.objectId,
      entity_id: obj.entityId,
      label: obj.label,
      format: input.format,
      cron: sched.cron,
      preset: sched.preset,
      timezone: sched.timezone,
      spec: await this.sealSpec(p.tenantId, id, spec),
      webhook_secret: secret ? await s.keys.seal(p.tenantId, secret, secretAad(id)) : null,
      state: 'active',
      paused_reason: null,
      failures: 0,
      next_run_at: nextRunOrNull(sched.cron, t, sched.timezone),
      last_run_at: null,
      last_outcome: null,
      last_problem: null,
      created_at: t,
      updated_at: t
    };
    await this.db.transaction(async (trx) => {
      await trx('app_subscriptions').insert(row);
      await trx('app_subscription_recipients').insert([
        { subscription_id: id, user_id: p.userId, tenant_id: p.tenantId, role: 'owner', email: d.email.self, unsubscribed_at: null, last_hash: null, created_at: t },
        ...others.map((u) => ({ subscription_id: id, user_id: u, tenant_id: p.tenantId, role: 'other', email: true, unsubscribed_at: null, last_hash: null, created_at: t }))
      ]);
    });
    await this.audit(actor, p.tenantId, 'app.subscription.created', { subscription: id, app: obj.app.id }, obj.label, { kind: input.kind, object: obj.objectId, format: input.format, cron: sched.cron, timezone: sched.timezone, email: d.email.self, others: others.length, file: !!d.file, webhook: d.webhook ? { host: new URL(d.webhook.url).host, signing: d.webhook.signing } : null, onlyIfRows: input.options.onlyIfRows, onlyIfChanged: input.options.onlyIfChanged });
    return this.view(p, subFrom(row), secret ? { secret } : {});
  }

  /** The owner changes the subscription; an admin may only pause it. Resuming re-checks the object as the owner. */
  async update(actor: Actor & { principal: Principal }, id: string, patch: z.infer<typeof subscriptionPatchSchema>) {
    const p = actor.principal;
    const r = await this.visible(p, id);
    const owner = r.owner_id === p.userId;
    if (!owner) {
      const onlyPause = Object.keys(patch).length === 1 && patch.state === 'paused';
      if (!this.isAdmin(p) || !onlyPause) throw forbidden('Only the owner changes a subscription; a tenant admin may pause or delete it.', { step: 'owner' });
    }
    const spec = await this.openSpec(r);
    const t = Date.now();
    const upd: Record<string, unknown> = { updated_at: t };
    if (patch.name) spec.name = patch.name;
    if (patch.options) spec.options = { ...spec.options, ...Object.fromEntries(Object.entries(patch.options).filter(([, v]) => v !== undefined)) };
    if (patch.format) upd.format = patch.format;
    let cron = r.cron;
    let tz = r.timezone;
    if (patch.schedule) {
      const c = cronOf(patch.schedule, this.o.minIntervalMs);
      cron = c.cron;
      tz = c.timezone;
      Object.assign(upd, { cron, timezone: tz, preset: c.preset });
      spec.values = c.values;
    }
    let state = r.state;
    if (patch.state && patch.state !== r.state) {
      state = patch.state;
      if (state === 'active') {
        const why = await this.refusal(p, r);
        if (why) throw forbidden(why.replace(/^They|their/g, (m) => (m === 'They' ? 'You' : 'your')), { step: 'access' });
        Object.assign(upd, { state, paused_reason: null, failures: 0 });
      } else Object.assign(upd, { state, paused_reason: owner ? 'Paused by its owner.' : 'Paused by a tenant admin.', next_run_at: null });
    }
    if (state === 'active' && (patch.schedule || patch.state === 'active')) upd.next_run_at = nextRunOrNull(cron, t, tz);
    if (patch.name || patch.options || patch.schedule) upd.spec = await this.sealSpec(r.tenant_id, r.id, spec);
    await this.db('app_subscriptions').where({ id: r.id }).update(upd);
    const action = patch.state && patch.state !== r.state ? (patch.state === 'paused' ? 'app.subscription.paused' : 'app.subscription.resumed') : 'app.subscription.updated';
    await this.audit(actor, r.tenant_id, action, { subscription: r.id, app: r.app_id }, r.label, { changed: Object.keys(patch), ...(patch.schedule ? { cron, timezone: tz } : {}), ...(owner ? {} : { owner: r.owner_id }) });
    return this.view(p, { ...r, ...(upd as Partial<SubRow>) });
  }

  async remove(actor: Actor & { principal: Principal }, id: string): Promise<void> {
    const p = actor.principal;
    const r = await this.visible(p, id);
    if (r.owner_id !== p.userId && !this.isAdmin(p)) throw forbidden('Only the owner or a tenant admin deletes a subscription; you can unsubscribe from your copies instead.', { step: 'owner' });
    await this.db.transaction(async (trx) => {
      await trx('app_subscription_recipients').where({ subscription_id: r.id }).delete();
      await trx('app_subscriptions').where({ id: r.id }).delete();
    });
    // The history stays (no content in it); runs not yet delivered find no subscription and stop.
    await this.audit(actor, r.tenant_id, 'app.subscription.deleted', { subscription: r.id, app: r.app_id }, r.label, r.owner_id === p.userId ? {} : { owner: r.owner_id });
  }

  /** The delivery history: time, destination, recipient, rows, size and outcome. */
  async deliveries(p: Principal, id: string, limit = 100) {
    const r = await this.visible(p, id);
    const full = r.owner_id === p.userId || this.isAdmin(p);
    const q = this.db('app_subscription_deliveries').where({ subscription_id: r.id });
    if (!full) q.andWhere({ recipient_id: p.userId, destination: 'email' });
    const rows = (await q.orderBy('created_at', 'desc').limit(Math.min(500, limit))) as Record<string, unknown>[];
    const ids = [...new Set(rows.map((x) => x.recipient_id).filter(Boolean) as string[])];
    const users = ids.length ? ((await this.db('users').where({ tenant_id: r.tenant_id }).whereIn('id', ids).select('id', 'display_name')) as { id: string; display_name: string }[]) : [];
    const name = new Map(users.map((u) => [u.id, u.display_name]));
    return {
      deliveries: rows.map((x) => ({ id: String(x.id), run: String(x.run_id), at: Number(x.created_at), destination: x.destination as Destination, recipient: x.recipient_id ? { id: String(x.recipient_id), name: name.get(String(x.recipient_id)) ?? null } : null, outcome: String(x.outcome), reason: (x.reason as string | null) ?? null, rows: num(x.row_count), bytes: num(x.bytes), truncated: !!x.truncated, fileId: (x.file_id as string | null) ?? null, statusCode: num(x.status_code) }))
    };
  }

  /** One run now, as at its times (the owner's; it re-checks everything a scheduled run does). */
  async runNow(actor: Actor & { principal: Principal }, id: string) {
    const p = actor.principal;
    const r = await this.visible(p, id);
    if (r.owner_id !== p.userId) throw forbidden('Only the owner runs a subscription now.', { step: 'owner' });
    if (r.state !== 'active') throw conflict('The subscription is paused; resume it first.');
    this.requireExports();
    const run = await this.queueRun(r, Date.now(), 'manual');
    await this.audit(actor, r.tenant_id, 'app.subscription.run', { subscription: r.id, app: r.app_id }, r.label, { run: run.id });
    return { run: run.id, jobId: run.jobId };
  }

  // ---------- unsubscribing ----------

  private unsubscribeToken(subId: string, userId: string): string {
    return `v1.${subId}.${userId}.${mac(this.s().sysKeys.key('link'), `app-unsubscribe:v1:${subId}:${userId}`).slice(0, 40)}`;
  }

  unsubscribeUrl(subId: string, userId: string): string {
    return `${this.s().cfg.PUBLIC_URL.replace(/\/+$/, '')}/api/public/app-subscriptions/unsubscribe?t=${encodeURIComponent(this.unsubscribeToken(subId, userId))}`;
  }

  /** The subscription and person a signed unsubscribe link names, or null when the signature does not match. */
  readToken(token: string): { subscriptionId: string; userId: string } | null {
    const m = /^v1\.([0-9A-HJKMNP-TV-Z]{26})\.([0-9A-HJKMNP-TV-Z]{26})\.([0-9a-f]{40})$/.exec(token);
    if (!m) return null;
    return macMatches(this.s().sysKeys.key('link'), `app-unsubscribe:v1:${m[1]!}:${m[2]!}`, m[3]!, 40) ? { subscriptionId: m[1]!, userId: m[2]! } : null;
  }

  /** What an unsubscribe link would stop, without changing anything (the GET of the link). */
  async describeToken(token: string): Promise<{ name: string; already: boolean } | null> {
    const t = this.readToken(token);
    if (!t) return null;
    const rc = await this.db('app_subscription_recipients').where({ subscription_id: t.subscriptionId, user_id: t.userId }).first();
    const r = (await this.db('app_subscriptions').where({ id: t.subscriptionId }).first()) as Record<string, unknown> | undefined;
    if (!rc || !r) return null;
    return { name: (await this.openSpec(subFrom(r))).name, already: rc.unsubscribed_at != null };
  }

  /** Stops one person's email copies of one subscription; the owner's other destinations and other people's copies go on. */
  async unsubscribe(subscriptionId: string, userId: string, via: 'link' | 'console', actor?: Actor & { principal: Principal }): Promise<boolean> {
    const r = (await this.db('app_subscriptions').where({ id: subscriptionId }).first()) as Record<string, unknown> | undefined;
    if (!r) return false;
    const sub = subFrom(r);
    const n = await this.db('app_subscription_recipients').where({ subscription_id: subscriptionId, user_id: userId }).whereNull('unsubscribed_at').update({ unsubscribed_at: Date.now() });
    if (!n) return false;
    if (actor) await this.audit(actor, sub.tenant_id, 'app.subscription.unsubscribed', { subscription: sub.id, app: sub.app_id }, sub.label, { via, user: userId });
    else await this.systemAudit(sub.tenant_id, 'app.subscription.unsubscribed', sub, { via, user: userId }, userId);
    return true;
  }

  async unsubscribeByToken(token: string): Promise<'done' | 'already' | 'invalid'> {
    const t = this.readToken(token);
    if (!t) return 'invalid';
    const rc = await this.db('app_subscription_recipients').where({ subscription_id: t.subscriptionId, user_id: t.userId }).first();
    if (!rc) return 'invalid';
    if (rc.unsubscribed_at != null) return 'already';
    return (await this.unsubscribe(t.subscriptionId, t.userId, 'link')) ? 'done' : 'already';
  }

  /** The signed-in recipient stops their own copies (the console's Unsubscribe). */
  async unsubscribeSelf(actor: Actor & { principal: Principal }, id: string) {
    const p = actor.principal;
    const r = await this.visible(p, id);
    const rc = await this.db('app_subscription_recipients').where({ subscription_id: r.id, user_id: p.userId }).first();
    if (!rc) throw notFound('Subscription');
    await this.unsubscribe(r.id, p.userId, 'console', actor);
    return this.view(p, r);
  }

  // ---------- runs ----------

  private async queueRun(r: SubRow, dueAt: number, trigger: 'schedule' | 'manual'): Promise<{ id: string; jobId: string | null }> {
    const id = ulid();
    try {
      await this.db('app_subscription_runs').insert({ id, tenant_id: r.tenant_id, subscription_id: r.id, due_at: dueAt, started_by: trigger, state: 'queued', attempts: 0, job_id: null, problem: null, created_at: Date.now(), finished_at: null });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const ex = (await this.db('app_subscription_runs').where({ subscription_id: r.id, due_at: dueAt }).first()) as { id: string; job_id: string | null };
      return { id: ex.id, jobId: ex.job_id };
    }
    const job = await this.s().jobs.enqueue({ tenantId: r.tenant_id, type: 'apps.subscription.deliver', payload: { runId: id }, createdBy: r.owner_id, dedupeKey: `app-subscription:${id}`, maxAttempts: this.o.maxAttempts });
    await this.db('app_subscription_runs').where({ id }).update({ job_id: job.id });
    return { id, jobId: job.id };
  }

  /** Due subscriptions; each due time is claimed with one conditional update, so one instance queues its run. */
  async tick(now = Date.now()): Promise<{ queued: number; paused: number }> {
    const due = ((await this.db('app_subscriptions').where({ state: 'active' }).whereNotNull('next_run_at').andWhere('next_run_at', '<=', now).orderBy('next_run_at').limit(200)) as Record<string, unknown>[]).map(subFrom);
    let queued = 0;
    let paused = 0;
    for (const r of due) {
      const next = nextRunOrNull(r.cron, now, r.timezone);
      const claimed = await this.db('app_subscriptions').where({ id: r.id, next_run_at: r.next_run_at, state: 'active' }).update(next == null ? { next_run_at: null, state: 'paused', paused_reason: 'The schedule no longer runs (its time zone may be gone).', updated_at: now } : { next_run_at: next, updated_at: now });
      if (!claimed) continue;
      if (next == null) paused++;
      await this.queueRun(r, r.next_run_at!, 'schedule');
      queued++;
    }
    return { queued, paused };
  }

  private async record(run: { id: string; tenant_id: string; subscription_id: string }, d: { destination: Destination; recipient: string | null; outcome: string; reason?: string | null; rows?: number | null; bytes?: number | null; truncated?: boolean; fileId?: string | null; status?: number | null }): Promise<void> {
    await this.db('app_subscription_deliveries').insert({ id: ulid(), tenant_id: run.tenant_id, subscription_id: run.subscription_id, run_id: run.id, destination: d.destination, recipient_id: d.recipient, outcome: d.outcome, reason: d.reason ? short(d.reason) : null, row_count: d.rows ?? null, bytes: d.bytes ?? null, truncated: !!d.truncated, file_id: d.fileId ?? null, status_code: d.status ?? null, created_at: Date.now() });
  }

  /** The `apps.subscription.deliver` job: one attempt at a run; a retry skips what an earlier attempt delivered. */
  async deliver(runId: string, ctx?: JobContext): Promise<{ sent: number; skipped: number; denied: number; failed: number }> {
    const s = this.s();
    const run = (await this.db('app_subscription_runs').where({ id: runId }).first()) as { id: string; tenant_id: string; subscription_id: string; due_at: number; started_by: string; state: string } | undefined;
    const none = { sent: 0, skipped: 0, denied: 0, failed: 0 };
    if (!run || ['succeeded', 'failed', 'skipped'].includes(run.state)) return none;
    const finish = (state: string, problem: string | null) => this.db('app_subscription_runs').where({ id: run.id }).update({ state, problem: problem ? short(problem) : null, finished_at: Date.now() });
    const r = await this.row(run.tenant_id, run.subscription_id);
    if (!r || r.state !== 'active') {
      await finish('skipped', r ? 'The subscription is paused.' : 'The subscription was deleted.');
      return none;
    }
    const attempt = ctx?.job.attempts ?? 1;
    const final = !ctx || attempt >= ctx.job.max_attempts;
    await this.db('app_subscription_runs').where({ id: run.id }).update({ state: 'running', attempts: attempt });
    const spec = await this.openSpec(r);
    const app = await this.apps.appById(r.tenant_id, r.app_id);
    const done = new Map<string, { file_id: string | null }>();
    for (const x of (await this.db('app_subscription_deliveries').where({ run_id: run.id })) as { destination: string; recipient_id: string | null; outcome: string; file_id: string | null }[]) {
      if (DELIVERED.has(x.outcome) || x.outcome.startsWith('skipped') || x.outcome === 'denied') done.set(`${x.destination}:${x.recipient_id ?? ''}`, { file_id: x.file_id });
    }
    const rcpts = ((await this.db('app_subscription_recipients').where({ subscription_id: r.id })) as Record<string, unknown>[]).map(rcptFrom);
    const ownerName = (await s.users.get(r.tenant_id, r.owner_id))?.display_name ?? 'The owner';
    const plan: { rc: RecipientRow; dests: Destination[] }[] = [];
    for (const rc of rcpts.sort((a, b) => (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : 0))) {
      const dests: Destination[] = [];
      if (rc.role === 'owner') {
        if (spec.folderId) dests.push('file');
        if (spec.webhook) dests.push('webhook');
      }
      if (rc.email && rc.unsubscribed_at == null) dests.push('email');
      if (dests.length) plan.push({ rc, dests });
    }
    const tally = { sent: 0, skipped: 0, denied: 0, failed: 0 };
    const transient: string[] = [];
    const problems: string[] = [];
    const st = { ownerRefused: null as string | null };
    const exportsApi = this.exports();
    for (const { rc, dests } of plan) {
      const todo = dests.filter((d) => !done.has(`${d}:${rc.user_id}`));
      if (!todo.length) continue;
      const deny = async (why: string) => {
        for (const d of todo) await this.record(run, { destination: d, recipient: rc.user_id, outcome: 'denied', reason: why });
        tally.denied += todo.length;
        if (rc.role === 'owner') st.ownerRefused = why;
        problems.push(rc.role === 'owner' ? `The owner gets nothing: ${why}` : `A recipient gets nothing: ${why}`);
        await this.systemAudit(r.tenant_id, 'app.delivery.denied', r, { run: run.id, recipient: rc.user_id, destinations: todo, reason: short(why) });
      };
      const p = await loadPrincipal(s, r.tenant_id, rc.user_id, {});
      if (!p) {
        await deny('They are no longer an active account.');
        continue;
      }
      const why = await this.refusal(p, r);
      if (why) {
        await deny(why);
        continue;
      }
      if (!exportsApi) {
        const msg = 'Rendering for delivery is not available on this server yet (s.appExports.render).';
        for (const d of todo) await this.record(run, { destination: d, recipient: rc.user_id, outcome: 'failed', reason: msg });
        tally.failed += todo.length;
        transient.push(msg);
        continue;
      }
      let out: RenderResult;
      try {
        out = await exportsApi.render(p, { kind: r.kind, id: r.object_id, params: spec.params, filters: spec.filters, format: r.format });
      } catch (err) {
        if (isDenial(err)) {
          await deny(messageOf(err));
          continue;
        }
        const msg = `The render failed: ${messageOf(err)}`;
        // A request the renderer cannot serve (a format a dashboard has not, a bad filter, not installed) is not retried.
        const permanent = err instanceof HttpProblem && [400, 409, 413, 422, 501].includes(err.status);
        for (const d of todo) await this.record(run, { destination: d, recipient: rc.user_id, outcome: 'failed', reason: permanent || final ? msg : `${msg} (attempt ${attempt}; will retry)` });
        tally.failed += todo.length;
        if (permanent) problems.push(`${rc.role === 'owner' ? '' : 'A recipient: '}${msg}`);
        else transient.push(msg);
        continue;
      }
      const bytes = Buffer.from(out.bytes);
      const hash = sha256(bytes);
      const meta = { rows: out.rows, bytes: bytes.length, truncated: !!out.truncated };
      if (spec.options.onlyIfRows && out.rows === 0) {
        for (const d of todo) await this.record(run, { destination: d, recipient: rc.user_id, outcome: 'skipped-empty', reason: 'No rows; the subscription sends only when there are rows.', ...meta });
        tally.skipped += todo.length;
        continue;
      }
      if (spec.options.onlyIfChanged && rc.last_hash === hash) {
        for (const d of todo) await this.record(run, { destination: d, recipient: rc.user_id, outcome: 'skipped-unchanged', reason: 'Unchanged since the last delivery.', ...meta });
        tally.skipped += todo.length;
        continue;
      }
      let fileId: string | null = done.get(`file:${rc.user_id}`)?.file_id ?? null;
      let allOk = true;
      for (const d of todo) {
        try {
          if (d === 'file') {
            fileId = await this.toFile(p, r, spec, out, bytes, run.due_at);
            await this.record(run, { destination: 'file', recipient: rc.user_id, outcome: 'sent', fileId, ...meta });
          } else if (d === 'webhook') {
            const status = await this.toWebhook(p, r, spec, out, bytes, run, fileId);
            await this.record(run, { destination: 'webhook', recipient: rc.user_id, outcome: 'sent', status, fileId, ...meta });
          } else {
            const res = await this.toEmail(p, r, spec, app, out, bytes, run.due_at, rc.role === 'owner' ? 'you' : ownerName, rc.role === 'owner' ? fileId : null);
            await this.record(run, { destination: 'email', recipient: rc.user_id, outcome: res.linked ? 'linked' : 'sent', fileId: res.fileId, ...meta });
          }
          tally.sent++;
        } catch (err) {
          allOk = false;
          tally.failed++;
          const msg = messageOf(err);
          const permanent = err instanceof Permanent || isDenial(err);
          await this.record(run, { destination: d, recipient: rc.user_id, outcome: 'failed', reason: permanent || final ? msg : `${msg} (attempt ${attempt}; will retry)`, ...meta, ...(err instanceof WebhookError ? { status: err.status } : {}) });
          if (permanent) problems.push(`${rc.role === 'owner' ? '' : 'A recipient: '}${d === 'email' ? 'Email' : d === 'file' ? 'The file store' : 'The webhook'}: ${msg}`);
          else transient.push(msg);
        }
      }
      if (allOk) await this.db('app_subscription_recipients').where({ subscription_id: r.id, user_id: rc.user_id }).update({ last_hash: hash });
    }
    if (transient.length && !final) {
      await this.db('app_subscription_runs').where({ id: run.id }).update({ state: 'retrying', problem: short(transient[0]!) });
      throw new Error(`Delivery attempt ${attempt} failed: ${transient[0]}`);
    }
    const failedRun = transient.length > 0 || st.ownerRefused != null || problems.some((x) => !x.startsWith('A recipient'));
    const problem = transient[0] ?? problems[0] ?? null;
    const t = Date.now();
    if (failedRun) {
      const failures = r.failures + 1;
      const pause = failures >= this.o.pauseAfter;
      await this.db('app_subscriptions').where({ id: r.id }).update({ failures, last_run_at: t, last_outcome: 'failed', last_problem: problem ? short(problem) : null, updated_at: t, ...(pause ? { state: 'paused', paused_reason: short(`Paused after ${failures} failed runs in a row. Last: ${problem ?? 'unknown'}`), next_run_at: null } : {}) });
      await finish('failed', problem);
      await this.systemAudit(r.tenant_id, 'app.delivery.failed', r, { run: run.id, attempts: attempt, failures, problem: problem ? short(problem) : null, ...tally });
      if (pause) {
        await this.systemAudit(r.tenant_id, 'app.subscription.paused', r, { reason: 'failures', failures });
        await s.notifications.notify({ tenantId: r.tenant_id, userIds: [r.owner_id], kind: 'app.subscription.paused', title: `Delivery paused: ${spec.name}`.slice(0, 200), body: `It failed ${failures} times in a row and will not run again until you resume it. Last problem: ${problem ?? 'unknown'}`, route: `app-subscriptions?id=${r.id}`, label: r.label, email: true });
      }
    } else {
      const outcome = tally.sent ? 'sent' : tally.skipped ? 'skipped' : tally.denied ? 'denied' : 'nothing';
      await this.db('app_subscriptions').where({ id: r.id }).update({ failures: 0, last_run_at: t, last_outcome: outcome, last_problem: problem ? short(problem) : null, updated_at: t });
      await finish(tally.sent ? 'succeeded' : 'skipped', problem);
      await this.systemAudit(r.tenant_id, tally.sent ? 'app.delivery.sent' : 'app.delivery.skipped', r, { run: run.id, trigger: run.started_by, attempts: attempt, ...tally });
    }
    if (transient.length) throw new Error(`Delivery failed after ${attempt} attempts: ${transient[0]}`);
    return tally;
  }

  // ---------- destinations ----------

  private stampedName(filename: string, at: number, tz: string): string {
    const w = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at));
    const part = (k: string) => w.find((x) => x.type === k)?.value ?? '';
    const stamp = `${part('year')}-${part('month')}-${part('day')} ${part('hour')}${part('minute')}`;
    // eslint-disable-next-line no-control-regex -- control characters are what a file name must not carry
    const clean = filename.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim() || 'delivery';
    const dot = clean.lastIndexOf('.');
    const [base, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, ''];
    return `${base.slice(0, 180)} ${stamp}${ext.slice(0, 10)}`;
  }

  private async upload(p: Principal, input: { workspaceId?: string | null; folderId?: string | null; name: string; label: Label; type: string }, bytes: Buffer): Promise<string> {
    const files = this.s().files;
    const body = (async function* () {
      yield bytes;
    })();
    try {
      const { file } = await files.upload(p, { workspaceId: input.workspaceId ?? null, folderId: input.folderId ?? null, name: input.name, label: input.label, declaredType: input.type, declaredBytes: bytes.length }, body);
      return file.id;
    } catch (err) {
      if (err instanceof HttpProblem && err.status === 409) {
        const again = (async function* () {
          yield bytes;
        })();
        const dot = input.name.lastIndexOf('.');
        const name = dot > 0 ? `${input.name.slice(0, dot)} (${ulid().slice(-6)})${input.name.slice(dot)}` : `${input.name} (${ulid().slice(-6)})`;
        const { file } = await files.upload(p, { workspaceId: input.workspaceId ?? null, folderId: input.folderId ?? null, name, label: input.label, declaredType: input.type, declaredBytes: bytes.length }, again);
        return file.id;
      }
      if (err instanceof HttpProblem && err.status < 500) throw new Permanent(messageOf(err));
      throw err;
    }
  }

  private async toFile(p: Principal, r: SubRow, spec: Spec, out: RenderResult, bytes: Buffer, at: number): Promise<string> {
    if (!authorize(p, 'files:write').allow) throw new Permanent('The owner no longer holds files:write.');
    try {
      await this.s().files.folder(p, spec.folderId!);
    } catch {
      throw new Permanent('The folder is gone or the owner can no longer reach it.');
    }
    return this.upload(p, { folderId: spec.folderId, name: this.stampedName(out.filename, at, r.timezone), label: out.label ?? r.label, type: out.contentType }, bytes);
  }

  /** A copy in the recipient's own file store ("Deliveries" in the app's workspace), for a file too big to attach. */
  private async linkCopy(p: Principal, r: SubRow, out: RenderResult, bytes: Buffer, at: number): Promise<string> {
    const files = this.s().files;
    if (!authorize(p, 'files:write').allow) throw new Permanent(`The file is ${sizeText(bytes.length)}, more than can be attached, and the recipient cannot write to the file store for a link.`);
    const app = await this.apps.appById(r.tenant_id, r.app_id);
    let ws;
    try {
      ws = await files.workspaceFor(p, app?.workspace_id ?? null);
    } catch {
      throw new Permanent(`The file is ${sizeText(bytes.length)}, more than can be attached, and the recipient has no workspace in the file store for a link.`);
    }
    const existing = ((await this.db('file_folders').where({ tenant_id: r.tenant_id, workspace_id: ws.id }).whereNull('parent_id').whereNull('trashed_at').select('id', 'name')) as { id: string; name: string }[]).find((f) => f.name.toLowerCase() === 'deliveries');
    let folderId = existing?.id;
    if (!folderId) {
      try {
        folderId = (await files.createFolder(p, { workspaceId: ws.id, parentId: null, name: 'Deliveries' })).id;
      } catch (err) {
        throw new Permanent(`No folder for the link copy: ${messageOf(err)}`);
      }
    }
    return this.upload(p, { folderId, name: this.stampedName(out.filename, at, r.timezone), label: out.label ?? r.label, type: out.contentType }, bytes);
  }

  private async toEmail(p: Principal, r: SubRow, spec: Spec, app: AppRow | undefined, out: RenderResult, bytes: Buffer, at: number, owner: string, ownerCopy: string | null): Promise<{ linked: boolean; fileId: string | null }> {
    const s = this.s();
    const user = await s.users.get(r.tenant_id, p.userId);
    if (!user?.email) throw new Permanent('The recipient has no email address.');
    if (!s.notifications.emailEnabled) throw new Permanent('Email is not configured on this server (SMTP_URL).');
    const when = new Intl.DateTimeFormat('en-GB', { timeZone: r.timezone, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).format(new Date(at));
    const what = r.kind === 'records' ? 'records' : r.kind;
    const intro = `Your ${what} delivery from ${app?.title ?? 'an app'}, rendered for you as of ${when}: ${out.rows} row${out.rows === 1 ? '' : 's'}${out.truncated ? ' (cut off at the export limit)' : ''}.`;
    let link = '';
    let fileId: string | null = null;
    const attach = bytes.length <= this.o.attachMaxBytes;
    if (!attach) {
      fileId = ownerCopy ?? (await this.linkCopy(p, r, out, bytes, at));
      link = s.notifications.consoleUrl(`files?file=${fileId}`);
    }
    const unsubscribe = this.unsubscribeUrl(r.id, p.userId);
    const sent = await s.notifications.sendWithAttachments(
      user.email,
      'app-delivery',
      {
        name: user.display_name,
        title: `${spec.name}: ${when}`,
        intro,
        message: spec.options.message ? `${owner === 'you' ? 'Your note' : `A note from ${owner}`}: ${spec.options.message}` : '',
        content: attach ? `Attached: ${out.filename} (${sizeText(bytes.length)}).` : `The file is ${sizeText(bytes.length)}, more than the ${sizeText(this.o.attachMaxBytes)} that can be attached. A copy is in your file store; sign in to open it:`,
        link,
        owner,
        unsubscribeLink: unsubscribe
      },
      { attachments: attach ? [{ filename: out.filename, content: bytes, contentType: out.contentType }] : [], headers: { 'List-Unsubscribe': `<${unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } }
    );
    if (!sent) throw new Permanent('Email is not configured on this server (SMTP_URL).');
    return { linked: !attach, fileId };
  }

  private async toWebhook(p: Principal, r: SubRow, spec: Spec, out: RenderResult, bytes: Buffer, run: { id: string; due_at: number }, fileId: string | null): Promise<number> {
    const s = this.s();
    const hook = spec.webhook!;
    if (!effectivePermissions(p).has('webhooks:manage')) throw new Permanent('The owner no longer holds webhooks:manage.');
    if (labelRank(out.label ?? r.label) > labelRank(hook.maxLabel)) throw new Permanent(`The render is ${out.label ?? r.label}; the webhook may carry data up to ${hook.maxLabel}.`);
    const operatorAllow = parseAllowList(s.webhooks.o.allowedHosts);
    const tenantAllow = await s.integrations.allowList(r.tenant_id);
    if (!tenantAllow) throw new Permanent("This tenant has no allowed hosts: a delivery webhook goes only to a host on the tenant's list.");
    const inline = bytes.length <= this.o.attachMaxBytes;
    const body = JSON.stringify({
      type: 'app.delivery',
      subscription: { id: r.id, name: spec.name },
      run: { id: run.id, dueAt: new Date(run.due_at).toISOString() },
      object: { kind: r.kind, id: r.object_id, app: r.app_id },
      file: { filename: out.filename, contentType: out.contentType, size: bytes.length, sha256: sha256(bytes), rows: out.rows, truncated: !!out.truncated, label: out.label ?? r.label },
      content: inline ? bytes.toString('base64') : null,
      ...(inline ? {} : { tooLarge: true, fileId })
    });
    const ts = Math.floor(Date.now() / 1000);
    let signature: Record<string, string>;
    if (hook.signing === 'ed25519') {
      const { signature: sig, kid } = await s.webhooks.edSign(r.tenant_id, Buffer.from(`${ts}.${body}`));
      signature = { 'x-exprsn-signature-ed25519': sig.toString('base64'), 'x-exprsn-key-id': kid };
    } else {
      if (!r.webhook_secret) throw new Permanent('The webhook secret is missing.');
      signature = { 'x-exprsn-signature': signBody(await s.keys.open(r.tenant_id, r.webhook_secret, secretAad(r.id)), ts, body) };
    }
    const agent = guardedAgent(operatorAllow, s.webhooks.o.timeoutMs, (host, addrs) => tenantHostProblem(host, addrs, tenantAllow));
    try {
      const checked = await checkUrl(hook.url, operatorAllow);
      const refused = tenantHostProblem(checked.host, checked.addresses, tenantAllow);
      if (refused) throw new HostRefused(refused);
      const res = await fetch(hook.url, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json', 'user-agent': 'exprsn-ai-deliveries', 'x-exprsn-event': 'app.delivery', 'x-exprsn-timestamp': String(ts), 'x-exprsn-delivery-id': run.id, ...signature },
        dispatcher: agent,
        redirect: 'manual',
        signal: AbortSignal.timeout(s.webhooks.o.timeoutMs)
      });
      await res.body?.cancel().catch(() => undefined);
      if (res.status >= 200 && res.status < 300) return res.status;
      const msg = `The endpoint answered ${res.status}.`;
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) throw new WebhookError(msg, res.status, true);
      throw new WebhookError(msg, res.status, false);
    } catch (err) {
      if (err instanceof WebhookError) {
        if (err.permanent) throw new Permanent(err.message);
        throw err;
      }
      const e = err as Error & { cause?: Error };
      const refusal = e instanceof HostRefused ? e : e.cause instanceof HostRefused ? e.cause : null;
      if (refusal) throw new Permanent(`Refused: ${refusal.message}`);
      throw new Error(e.name === 'TimeoutError' ? `No answer within ${s.webhooks.o.timeoutMs} ms.` : `The request failed: ${(e.cause ?? e).message}`, { cause: err });
    } finally {
      await agent.close().catch(() => undefined);
    }
  }
}

class WebhookError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly permanent: boolean
  ) {
    super(message);
  }
}
