import { ulid } from 'ulid';
import { actorFrom, PLATFORM_TENANT } from '../audit/chain.js';
import { clears, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { hmac } from '../crypto/index.js';
import { json } from '../db/knex.js';
import { flagRef } from '../guardrails/flags.js';
import { workspacesFor } from '../http/middleware.js';
import { conflict, HttpProblem, notFound } from '../http/problem.js';
import type { Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import type { FormRow } from './forms.js';
import type { Values } from './schema.js';
import type { AppRow, AppService, EntityRow } from './service.js';

/*
 * 1.6.0 (B-4701): held form values. A public form submission with a value the `user-input` guardrail holds for review
 * (a `require-approval` rule in enforce) is no longer refused: its screened values are sealed with the tenant key and
 * kept as a held submission, with a hold flag in the review queue (routed to a moderation queue like any flag). The
 * submitter is told it will be reviewed. A reviewer reads the values (within their workspaces and clearance) and
 * accepts the submission, which writes the record exactly as an unheld submission would (by no one, `source: form`,
 * through the entity's own validation), or rejects it. The values are dropped at the decision either way; the decided
 * row is deleted APPS_HELD_KEEP_DAYS later. At most APPS_HELD_MAX_PER_FORM wait per form: past that, a held value is
 * refused as before 1.6.0, so a flood of held submissions cannot grow the queue without bound.
 */

export const HELD_OBJECT = 'app-form-submission';
export const HELD_PURGE_JOB = 'apps.held.purge';

export interface HeldField {
  field: string;
  ruleId: string;
  ruleName: string;
  setId: string | null;
  reason: string | null;
}

export interface HoldRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  app_id: string;
  entity_id: string;
  form_id: string;
  label: Label;
  values_sealed: string | null;
  held_fields: HeldField[];
  dropped: number;
  state: 'held' | 'accepted' | 'rejected';
  flag_id: string | null;
  record_id: string | null;
  ip_hash: string | null;
  decided_by: string | null;
  decided_at: number | null;
  reason: string | null;
  created_at: number;
}

const holdFrom = (r: Record<string, unknown>): HoldRow => ({ ...(r as unknown as HoldRow), held_fields: json<HeldField[]>(r.held_fields, []), dropped: Number(r.dropped ?? 0), decided_at: r.decided_at == null ? null : Number(r.decided_at), created_at: Number(r.created_at) });

export class HeldSubmissions {
  constructor(
    private readonly s: () => Services,
    private readonly apps: AppService
  ) {}

  private get db() {
    return this.s().db;
  }

  registerJobs(): void {
    this.s().jobs.register(HELD_PURGE_JOB, async () => this.purge());
  }

  schedule(scheduler: Scheduler): void {
    scheduler.every(HELD_PURGE_JOB, 6 * 3_600_000, async () => [{ tenantId: PLATFORM_TENANT, key: 'all' }]);
  }

  /** Files a held submission and its hold flag. Refuses (422, as before 1.6.0) when the form's queue is full. */
  async hold(x: { app: AppRow; entity: EntityRow; form: FormRow; values: Values; dropped: number; held: HeldField[]; ip: string | null; traceId: string | null }): Promise<HoldRow> {
    const s = this.s();
    const max = s.cfg.APPS_HELD_MAX_PER_FORM;
    const waiting = Number(((await this.db('app_form_holds').where({ form_id: x.form.id, state: 'held' }).count({ n: '*' }).first()) as { n: number | string } | undefined)?.n ?? 0);
    const first = x.held[0]!;
    if (waiting >= max) throw new HttpProblem(422, 'Submission refused', `The submission was refused by the content rules${first.reason ? `: ${first.reason}` : '.'}`, { extensions: { field: first.field, step: 'held-queue-full' } });
    const id = ulid();
    const t = Date.now();
    const row: HoldRow = { id, tenant_id: x.app.tenant_id, workspace_id: x.app.workspace_id, app_id: x.app.id, entity_id: x.entity.id, form_id: x.form.id, label: x.entity.label, values_sealed: await s.keys.seal(x.app.tenant_id, JSON.stringify(x.values), `app-form-hold:${id}`), held_fields: x.held, dropped: x.dropped, state: 'held', flag_id: null, record_id: null, ip_hash: x.ip ? hmac(s.cfg.SESSION_SECRET, `app-form-hold-ip:${x.ip}`) : null, decided_by: null, decided_at: null, reason: null, created_at: t };
    await this.db('app_form_holds').insert({ ...row, held_fields: JSON.stringify(row.held_fields) });
    const text = x.held.map((h) => `${h.field}: ${String(x.values[h.field] ?? '')}`).join('\n');
    const flag = await s.guard.flags.create({
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      kind: 'hold',
      checkpoint: 'user-input',
      ruleId: first.ruleId,
      ruleName: first.ruleName,
      setId: first.setId,
      stage: 'enforce',
      action: 'require-approval',
      severity: 'medium',
      label: row.label,
      text,
      note: `A public submission to the form ${x.form.title} waits for review: ${x.held.map((h) => h.field).join(', ')} ${x.held.length === 1 ? 'was' : 'were'} held${first.reason ? ` (${first.reason})` : ''}. Accepting it writes the record.`,
      actor: { name: 'Public form', via: 'apps.forms' },
      source: { kind: HELD_OBJECT, id }
    });
    await this.db('app_form_holds').where({ id }).update({ flag_id: flag.id });
    row.flag_id = flag.id;
    await s.audit.append({ tenantId: row.tenant_id, action: 'app.form.held', kind: 'system', actor: { service: 'apps.forms', ...(x.ip ? { ip: x.ip } : {}) }, target: { app: x.app.id, form: x.form.id, held: id, flag: flagRef(flag) }, label: row.label, detail: { public: true, fields: Object.keys(x.values), held: x.held.map((h) => ({ field: h.field, rule: h.ruleName })), dropped: x.dropped }, traceId: x.traceId });
    return row;
  }

  private async row(tenantId: string, id: string): Promise<HoldRow | null> {
    const r = await this.db('app_form_holds').where({ tenant_id: tenantId, id }).first();
    return r ? holdFrom(r) : null;
  }

  /** A held submission the reviewer may see (their workspaces, their clearance), or 404. */
  private async visible(p: Principal, id: string): Promise<{ h: HoldRow; ws: string[] }> {
    const h = await this.row(p.tenantId, id);
    const ws = (await workspacesFor(this.s(), p)).map((w) => w.id);
    if (!h || (h.workspace_id && !ws.includes(h.workspace_id)) || !clears(p.clearance, h.label)) throw notFound('Held submission');
    return { h, ws };
  }

  private async names(rows: HoldRow[]) {
    const apps = new Map(((rows.length ? await this.db('apps').whereIn('id', [...new Set(rows.map((r) => r.app_id))]).select('id', 'name', 'title') : []) as { id: string; name: string; title: string }[]).map((a) => [a.id, a]));
    const forms = new Map(((rows.length ? await this.db('app_forms').whereIn('id', [...new Set(rows.map((r) => r.form_id))]).select('id', 'name', 'title') : []) as { id: string; name: string; title: string }[]).map((f) => [f.id, f]));
    const flags = new Map(((rows.some((r) => r.flag_id) ? await this.db('guard_flags').whereIn('id', rows.flatMap((r) => (r.flag_id ? [r.flag_id] : []))).select('id', 'number', 'state', 'queue_id') : []) as { id: string; number: number; state: string; queue_id: string | null }[]).map((f) => [f.id, f]));
    return { apps, forms, flags };
  }

  private view(h: HoldRow, n: Awaited<ReturnType<HeldSubmissions['names']>>) {
    const f = h.flag_id ? n.flags.get(h.flag_id) : undefined;
    return {
      id: h.id,
      state: h.state,
      label: h.label,
      workspaceId: h.workspace_id,
      app: { id: h.app_id, name: n.apps.get(h.app_id)?.name ?? null, title: n.apps.get(h.app_id)?.title ?? null },
      form: { id: h.form_id, name: n.forms.get(h.form_id)?.name ?? null, title: n.forms.get(h.form_id)?.title ?? null },
      held: h.held_fields.map((x) => ({ field: x.field, rule: x.ruleName, reason: x.reason })),
      dropped: h.dropped,
      flag: f ? { id: f.id, ref: flagRef(f), state: f.state, queueId: f.queue_id } : null,
      recordId: h.record_id,
      decidedBy: h.decided_by,
      decidedAt: h.decided_at,
      reason: h.reason,
      createdAt: h.created_at
    };
  }

  /** Held submissions in the reviewer's workspaces and clearance, oldest first (`held` by default). */
  async list(p: Principal, state: HoldRow['state'] | 'all' = 'held') {
    const ws = (await workspacesFor(this.s(), p)).map((w) => w.id);
    const q = this.db('app_form_holds').where({ tenant_id: p.tenantId }).andWhere((w) => w.whereNull('workspace_id').orWhereIn('workspace_id', ws.length ? ws : ['-']));
    if (state !== 'all') q.andWhere({ state });
    const rows = ((await q.orderBy('created_at', state === 'held' ? 'asc' : 'desc').limit(500)) as Record<string, unknown>[]).map(holdFrom).filter((h) => clears(p.clearance, h.label));
    const n = await this.names(rows);
    return rows.map((h) => this.view(h, n));
  }

  /** One held submission with its values (while it waits). */
  async detail(p: Principal, id: string) {
    const { h } = await this.visible(p, id);
    const values = h.values_sealed ? (JSON.parse(await this.s().keys.open(h.tenant_id, h.values_sealed, `app-form-hold:${h.id}`)) as Values) : null;
    return { ...this.view(h, await this.names([h])), values };
  }

  /** The held values as text, for the flag's detail on the Flags screen. */
  async heldText(tenantId: string, id: string): Promise<{ conversationId: string; state: string; content: string } | null> {
    const h = await this.row(tenantId, id);
    if (!h) return null;
    if (!h.values_sealed) return { conversationId: '', state: h.state, content: '' };
    const values = JSON.parse(await this.s().keys.open(h.tenant_id, h.values_sealed, `app-form-hold:${h.id}`)) as Values;
    return { conversationId: '', state: h.state, content: Object.entries(values).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n') };
  }

  /** A reviewer's decision from the Moderation screen: through the flag queue, so the hold flag records it. */
  async decide(p: Principal, id: string, decision: 'accept' | 'reject', reason: string | null, ctx: { ip: string | null; traceId: string | null }) {
    const { h, ws } = await this.visible(p, id);
    if (h.state !== 'held') throw conflict(`The submission was already ${h.state}.`);
    if (!h.flag_id) throw conflict('The submission has no flag to decide.');
    const f = (await this.db('guard_flags').where({ id: h.flag_id }).first('number')) as { number: number } | undefined;
    if (!f) throw conflict('The submission\'s flag is gone.');
    let out: { recordId: string | null; state: HoldRow['state'] } = { recordId: null, state: h.state };
    const flag = await this.s().guard.flags.decideHold(p, `F-${f.number}`, ws, decision === 'accept' ? 'approved' : 'rejected', reason, async () => {
      out = await this.resolve(p, h.id, decision === 'accept' ? 'approved' : 'rejected', reason, ctx);
    });
    return { ...out, flag: { id: flag.id, ref: flagRef(flag), state: flag.state } };
  }

  /**
   * Applies a decision (also from the Flags screen's decide route for `app-form-submission` flags). Compare-and-set on
   * `held`, so only one decision lands; an accepted submission whose record the entity refuses (a unique value taken
   * meanwhile, a field removed) goes back to `held` and the reviewer sees why.
   */
  async resolve(p: Principal, id: string, decision: 'approved' | 'rejected', reason: string | null, ctx: { ip?: string | null; traceId?: string | null } = {}): Promise<{ recordId: string | null; state: HoldRow['state'] }> {
    const s = this.s();
    const h = await this.row(p.tenantId, id);
    if (!h) throw notFound('Held submission');
    const t = Date.now();
    const state = decision === 'approved' ? 'accepted' : 'rejected';
    const n = await this.db('app_form_holds').where({ id: h.id, state: 'held' }).update({ state, decided_by: p.userId, decided_at: t, reason: reason?.slice(0, 500) ?? null });
    if (!n) throw conflict(`The submission was already ${(await this.row(p.tenantId, id))?.state ?? 'decided'}.`);
    let recordId: string | null = null;
    if (state === 'accepted') {
      try {
        const app = await this.apps.appById(h.tenant_id, h.app_id);
        const entity = await this.apps.entityById(h.tenant_id, h.entity_id);
        if (!app || !entity) throw conflict('The form\'s app or entity no longer exists; reject the submission instead.');
        const values = JSON.parse(await s.keys.open(h.tenant_id, h.values_sealed!, `app-form-hold:${h.id}`)) as Values;
        recordId = (await this.apps.createRecord({ principal: null, source: 'form', service: 'apps.forms', ip: null, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) }, app, entity, { values })).id;
      } catch (err) {
        await this.db('app_form_holds').where({ id: h.id }).update({ state: 'held', decided_by: null, decided_at: null, reason: null });
        throw err;
      }
    }
    await this.db('app_form_holds').where({ id: h.id }).update({ values_sealed: null, record_id: recordId });
    await s.audit.append({ tenantId: h.tenant_id, action: `app.form.held.${state}`, kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { app: h.app_id, form: h.form_id, held: h.id, ...(recordId ? { record: recordId } : {}) }, label: h.label, detail: { reason: reason ?? null, fields: h.held_fields.map((x) => x.field) }, traceId: ctx.traceId ?? null });
    return { recordId, state };
  }

  /** Deletes decided submissions APPS_HELD_KEEP_DAYS after their decision. */
  async purge(): Promise<{ deleted: number }> {
    const before = Date.now() - this.s().cfg.APPS_HELD_KEEP_DAYS * 86_400_000;
    const deleted = await this.db('app_form_holds').whereNot({ state: 'held' }).andWhere('decided_at', '<', before).delete();
    return { deleted: Number(deleted) };
  }
}
