import { ulid } from 'ulid';
import { json, type Db } from '../db/knex.js';
import { clears, isLabel, type Label } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { permissionsFor } from '../authz/permissions.js';
import { isUniqueViolation } from '../audit/chain.js';
import { conflict, forbidden, notFound } from '../http/problem.js';
import { TOPICS, type Bus } from '../platform/bus.js';
import type { DataKeys } from '../platform/datakeys.js';
import type { Notifications } from '../platform/notifications.js';
import { SEVERITY_SLA_MINUTES } from './rules.js';

export type Severity = 'high' | 'medium' | 'low';
export type FlagKind = 'rule' | 'fail-open' | 'report' | 'reviewer';
export type EscalationLevel = 'workspace' | 'tenant' | 'platform';

export interface FlagRow {
  id: string;
  tenant_id: string;
  number: number;
  workspace_id: string | null;
  kind: FlagKind;
  checkpoint: string;
  rule_id: string | null;
  rule_name: string;
  set_id: string | null;
  set_name: string | null;
  set_version: number | null;
  stage: 'enforce' | 'shadow';
  action: string | null;
  severity: Severity;
  label: Label;
  excerpt: string | null;
  note: string | null;
  actor: { user?: string | null; name?: string | null; via?: string | null } | null;
  source_kind: string | null;
  source_id: string | null;
  conversation_id: string | null;
  state: 'open' | 'confirmed' | 'dismissed';
  assignee: string | null;
  escalated_to: EscalationLevel | null;
  sla_minutes: number;
  due_at: number;
  breach_notified_at: number | null;
  decided_by: string | null;
  decided_at: number | null;
  reason: string | null;
  eval_set: string | null;
  created_at: number;
}

export interface NewFlag {
  tenantId: string;
  workspaceId: string | null;
  kind: FlagKind;
  checkpoint: string;
  ruleId?: string | null;
  ruleName: string;
  setId?: string | null;
  setName?: string | null;
  setVersion?: number | null;
  stage?: 'enforce' | 'shadow';
  action?: string | null;
  severity: Severity;
  label: Label;
  /** The inspected text and the span to highlight; stored sealed as a window around the span. */
  text?: string | null;
  span?: [number, number] | null;
  note?: string | null;
  actor?: FlagRow['actor'];
  source?: { kind: string; id: string } | null;
  conversationId?: string | null;
}

const num = (v: unknown) => (v == null ? null : Number(v));
const fromRow = (r: Record<string, unknown>): FlagRow => ({
  ...(r as unknown as FlagRow),
  number: Number(r.number),
  set_version: num(r.set_version) as number | null,
  actor: json<FlagRow['actor']>(r.actor, null),
  sla_minutes: Number(r.sla_minutes),
  due_at: Number(r.due_at),
  breach_notified_at: num(r.breach_notified_at),
  decided_at: num(r.decided_at),
  created_at: Number(r.created_at)
});

export const flagRef = (f: Pick<FlagRow, 'number'>) => `F-${f.number}`;
const WINDOW = 240;

/**
 * The flag queue. Flags come from rules whose action is `flag`, from fail-open decisions, from a sample of shadow
 * findings, and from people (a user reporting an answer, a reviewer). Each has a timer from its severity; a reviewer
 * below the flag's label sees it redacted and can only reassign it. Decisions are events (the last 24 hours show on
 * an empty queue); confirmed flags become eval cases, dismissals count as false positives against their rule.
 */
export class FlagService {
  constructor(
    private readonly db: Db,
    private readonly keys: DataKeys,
    private readonly bus: Bus,
    private readonly notifications: Notifications
  ) {}

  async create(input: NewFlag): Promise<FlagRow> {
    const id = ulid();
    const t = Date.now();
    const sla = SEVERITY_SLA_MINUTES[input.severity];
    let excerpt: string | null = null;
    if (input.text) {
      const [s, e] = input.span ?? [0, Math.min(input.text.length, WINDOW * 2)];
      const window = { before: input.text.slice(Math.max(0, s - WINDOW), s), span: input.text.slice(s, e).slice(0, 2000), after: input.text.slice(e, e + WINDOW), clippedBefore: s > WINDOW, clippedAfter: e + WINDOW < input.text.length };
      excerpt = await this.keys.seal(input.tenantId, JSON.stringify(window), `flag:${id}`);
    }
    const base = {
      id,
      tenant_id: input.tenantId,
      workspace_id: input.workspaceId,
      kind: input.kind,
      checkpoint: input.checkpoint,
      rule_id: input.ruleId ?? null,
      rule_name: input.ruleName.slice(0, 200),
      set_id: input.setId ?? null,
      set_name: input.setName?.slice(0, 200) ?? null,
      set_version: input.setVersion ?? null,
      stage: input.stage ?? 'enforce',
      action: input.action ?? null,
      severity: input.severity,
      label: input.label,
      excerpt,
      note: input.note?.slice(0, 1000) ?? null,
      actor: input.actor ? JSON.stringify(input.actor) : null,
      source_kind: input.source?.kind ?? null,
      source_id: input.source?.id ?? null,
      conversation_id: input.conversationId ?? (input.source?.kind === 'conversation' ? input.source.id : null),
      state: 'open',
      assignee: null,
      escalated_to: null,
      sla_minutes: sla,
      due_at: t + sla * 60_000,
      breach_notified_at: null,
      decided_by: null,
      decided_at: null,
      reason: null,
      eval_set: null,
      created_at: t
    };
    // Numbers are per tenant (F-1, F-2…); a concurrent insert takes the next one.
    for (let attempt = 0; ; attempt++) {
      const max = ((await this.db('guard_flags').where({ tenant_id: input.tenantId }).max({ n: 'number' }).first()) as { n: number | null } | undefined)?.n ?? 0;
      try {
        await this.db('guard_flags').insert({ ...base, number: Number(max) + 1 });
        break;
      } catch (err) {
        if (!isUniqueViolation(err) || attempt >= 5) throw err;
      }
    }
    const row = fromRow((await this.db('guard_flags').where({ id }).first()) as Record<string, unknown>);
    await this.event(row, 'created', input.actor?.user ?? null, null);
    return row;
  }

  async get(tenantId: string, ref: string): Promise<FlagRow> {
    const m = /^F-(\d+)$/i.exec(ref);
    const r = await this.db('guard_flags').where({ tenant_id: tenantId }).andWhere(m ? { number: Number(m[1]) } : { id: ref }).first();
    if (!r) throw notFound('Flag');
    return fromRow(r);
  }

  private async event(f: FlagRow, action: string, actor: string | null, note: string | null): Promise<void> {
    const eventId = ulid();
    await this.db('guard_flag_events').insert({ id: eventId, tenant_id: f.tenant_id, flag_id: f.id, action, actor, note: note?.slice(0, 500) ?? null, created_at: Date.now() });
    // Outbound webhooks (Sprint 13): the fact of the change, never the flagged text.
    this.bus.emitLocal(TOPICS.integrationEvent, { tenantId: f.tenant_id, type: `flag.${action}`, label: f.label, id: `flag-event:${eventId}`, data: { flag: flagRef(f), id: f.id, action, severity: f.severity, checkpoint: f.checkpoint } });
    // Only the fact of a change goes over the socket; reviewers fetch the flag through the API, redacted for them.
    this.bus.publish(TOPICS.poolState, { tenantId: f.tenant_id, perm: 'flags:review', event: 'flags.changed', data: { id: f.id, ref: flagRef(f), action, severity: f.severity } });
  }

  /** The flag as a reviewer may see it: above their clearance, rule, actor, note and conversation are withheld. */
  view(f: FlagRow, p: Principal) {
    const hidden = !clears(p.clearance, f.label);
    return {
      id: f.id,
      ref: flagRef(f),
      kind: f.kind,
      checkpoint: f.checkpoint,
      severity: f.severity,
      label: f.label,
      state: f.state,
      stage: f.stage,
      action: f.action,
      restricted: hidden,
      rule: hidden ? null : f.rule_name,
      ruleId: hidden ? null : f.rule_id,
      setId: hidden ? null : f.set_id,
      setName: f.set_name,
      setVersion: f.set_version,
      actor: hidden ? null : f.actor,
      note: hidden ? null : f.note,
      conversationId: hidden ? null : f.conversation_id,
      workspaceId: f.workspace_id,
      assignee: f.assignee,
      escalatedTo: f.escalated_to,
      slaMinutes: f.sla_minutes,
      dueAt: f.due_at,
      createdAt: f.created_at,
      decidedBy: f.decided_by,
      decidedAt: f.decided_at,
      reason: hidden ? null : f.reason,
      evalSet: f.eval_set
    };
  }

  /** One flag with its excerpt (opened, unless above the reviewer's clearance) and the rule's decision history. */
  async detail(p: Principal, ref: string, workspaces: string[]) {
    const f = await this.visible(p, ref, workspaces);
    const v = this.view(f, p);
    const excerpt = !v.restricted && f.excerpt ? json<{ before: string; span: string; after: string } | null>(await this.keys.open(f.tenant_id, f.excerpt, `flag:${f.id}`), null) : null;
    const prior = f.rule_id ? await this.prior(f.tenant_id, f.rule_id, f.id) : { confirmed: 0, dismissed: 0 };
    const own = !v.restricted && f.conversation_id ? !!(await this.db('conversations').where({ id: f.conversation_id, user_id: p.userId }).first('id')) : false;
    const history = ((await this.db('guard_flag_events').where({ flag_id: f.id }).orderBy('created_at')) as { action: string; actor: string | null; note: string | null; created_at: number }[]).map((e) => ({ action: e.action, actor: e.actor, note: v.restricted ? null : e.note, at: Number(e.created_at) }));
    return { ...v, excerpt, prior: v.restricted ? null : prior, ownConversation: own, history };
  }

  private async prior(tenantId: string, ruleId: string, except: string) {
    const rows = (await this.db('guard_flags').where({ tenant_id: tenantId, rule_id: ruleId }).whereNot({ id: except }).whereIn('state', ['confirmed', 'dismissed']).groupBy('state').select('state').count({ n: '*' })) as { state: string; n: number | string }[];
    const n = (s: string) => Number(rows.find((r) => r.state === s)?.n ?? 0);
    return { confirmed: n('confirmed'), dismissed: n('dismissed') };
  }

  /** False-positive rate of a rule from reviewers' decisions: dismissed over decided. */
  async falsePositives(tenantId: string, setId: string, ruleId: string): Promise<{ confirmed: number; dismissed: number; rate: number | null }> {
    const rows = (await this.db('guard_flags').where({ tenant_id: tenantId, set_id: setId, rule_id: ruleId }).whereIn('state', ['confirmed', 'dismissed']).groupBy('state').select('state').count({ n: '*' })) as { state: string; n: number | string }[];
    const confirmed = Number(rows.find((r) => r.state === 'confirmed')?.n ?? 0);
    const dismissed = Number(rows.find((r) => r.state === 'dismissed')?.n ?? 0);
    return { confirmed, dismissed, rate: confirmed + dismissed ? dismissed / (confirmed + dismissed) : null };
  }

  async openShadowFlags(tenantId: string, setId: string, ruleId: string): Promise<number> {
    const r = (await this.db('guard_flags').where({ tenant_id: tenantId, set_id: setId, rule_id: ruleId, stage: 'shadow', state: 'open' }).count({ n: '*' }).first()) as { n: number | string } | undefined;
    return Number(r?.n ?? 0);
  }

  /** Who sees a flag in their queue: its workspace (or none), not assigned elsewhere, and escalations only to their level. */
  private reviewable(f: FlagRow, p: Principal, workspaces: string[]): boolean {
    if (f.workspace_id && !workspaces.includes(f.workspace_id)) return false;
    if (f.assignee && f.assignee !== p.userId) return false;
    if (f.escalated_to && f.assignee !== p.userId) {
      const perms = effectivePermissions(p);
      if (f.escalated_to === 'platform' ? !perms.has('platform:manage') : !perms.has('guardrails:manage')) return false;
    }
    return true;
  }

  private async visible(p: Principal, ref: string, workspaces: string[]): Promise<FlagRow> {
    const f = await this.get(p.tenantId, ref);
    if (f.workspace_id && !workspaces.includes(f.workspace_id)) throw notFound('Flag');
    return f;
  }

  /** The open queue for the current workspace (flags without one included), and counts for the other workspaces. */
  async queue(p: Principal, workspaces: string[]) {
    const rows = ((await this.db('guard_flags').where({ tenant_id: p.tenantId, state: 'open' }).orderBy('created_at').limit(2000)) as Record<string, unknown>[]).map(fromRow);
    const mine = rows.filter((f) => this.reviewable(f, p, workspaces));
    const here = mine.filter((f) => !f.workspace_id || !p.workspaceId || f.workspace_id === p.workspaceId);
    const now = Date.now();
    return { items: here.map((f) => this.view(f, p)), open: here.length, overdue: here.filter((f) => f.due_at < now).length, otherWorkspaces: mine.length - here.length };
  }

  /** Decisions of the last hours (confirm, dismiss, escalate, reassign) on flags the reviewer may see. */
  async decisions(p: Principal, workspaces: string[], hours = 24) {
    const rows = (await this.db('guard_flag_events as e').join('guard_flags as f', 'f.id', 'e.flag_id').where('e.tenant_id', p.tenantId).whereIn('e.action', ['confirmed', 'dismissed', 'escalated', 'reassigned']).andWhere('e.created_at', '>=', Date.now() - hours * 3_600_000).orderBy('e.created_at', 'desc').limit(200).select('e.action', 'e.actor', 'e.created_at', 'f.id', 'f.number', 'f.rule_name', 'f.label', 'f.workspace_id')) as { action: string; actor: string | null; created_at: number; id: string; number: number; rule_name: string; label: Label; workspace_id: string | null }[];
    const names = await this.names(rows.map((r) => r.actor));
    return rows
      .filter((r) => !r.workspace_id || workspaces.includes(r.workspace_id))
      .map((r) => ({ id: r.id, ref: `F-${r.number}`, rule: clears(p.clearance, r.label) ? r.rule_name : 'Restricted item', action: r.action, by: r.actor ? (names.get(r.actor) ?? null) : null, at: Number(r.created_at) }));
  }

  private async names(ids: (string | null)[]): Promise<Map<string, string>> {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    if (!list.length) return new Map();
    return new Map(((await this.db('users').whereIn('id', list).select('id', 'display_name')) as { id: string; display_name: string }[]).map((u) => [u.id, u.display_name]));
  }

  private async openFor(p: Principal, ref: string, workspaces: string[]): Promise<FlagRow> {
    const f = await this.visible(p, ref, workspaces);
    if (f.state !== 'open') throw conflict(`${flagRef(f)} was already ${f.state}.`);
    return f;
  }

  private cleared(p: Principal, f: FlagRow): void {
    if (!clears(p.clearance, f.label)) throw forbidden(`${flagRef(f)} is labelled ${f.label}, above your clearance of ${p.clearance}. The only action is to reassign it to a reviewer cleared for ${f.label}.`, { step: 'clearance' });
  }

  async decide(p: Principal, ref: string, workspaces: string[], decision: 'confirmed' | 'dismissed', reason: string | null): Promise<FlagRow> {
    const f = await this.openFor(p, ref, workspaces);
    this.cleared(p, f);
    const t = Date.now();
    const evalSet = decision === 'confirmed' ? (f.rule_id ?? 'user-report') : null;
    await this.db('guard_flags').where({ id: f.id, state: 'open' }).update({ state: decision, decided_by: p.userId, decided_at: t, reason: reason?.slice(0, 500) ?? null, ...(evalSet && !f.eval_set ? { eval_set: evalSet } : {}) });
    const after = { ...f, state: decision, decided_by: p.userId, decided_at: t, reason, eval_set: f.eval_set ?? evalSet };
    await this.event(after, decision, p.userId, reason);
    return after;
  }

  /** The flagged text, for eval cases (never above the caller's clearance). */
  async flaggedText(p: Principal, f: FlagRow): Promise<string | null> {
    this.cleared(p, f);
    if (!f.excerpt) return null;
    const x = json<{ before: string; span: string; after: string } | null>(await this.keys.open(f.tenant_id, f.excerpt, `flag:${f.id}`), null);
    return x ? x.before + x.span + x.after : null;
  }

  async markEval(p: Principal, f: FlagRow, evalSet: string): Promise<void> {
    await this.db('guard_flags').where({ id: f.id }).update({ eval_set: evalSet });
    await this.event(f, 'eval', p.userId, evalSet);
  }

  /** Moves the flag up a level with a fresh 60-minute timer and notifies whoever reviews at that level. */
  async escalate(p: Principal, ref: string, workspaces: string[], to: EscalationLevel, note: string | null): Promise<FlagRow> {
    const f = await this.openFor(p, ref, workspaces);
    this.cleared(p, f);
    const due = Date.now() + 60 * 60_000;
    await this.db('guard_flags').where({ id: f.id }).update({ escalated_to: to, assignee: null, due_at: due, sla_minutes: 60, breach_notified_at: null });
    const after = { ...f, escalated_to: to, assignee: null, due_at: due, sla_minutes: 60 };
    await this.event(after, 'escalated', p.userId, note ? `${to}: ${note}` : to);
    const users = to === 'platform' ? await this.withRoles(null, ['system-admin']) : await this.withRoles(f.tenant_id, ['guardrail-admin']);
    for (const [tenantId, ids] of users) {
      await this.notifications.notify({ tenantId, userIds: ids.filter((u) => u !== p.userId), kind: 'flag', title: `Flag ${flagRef(f)} escalated to you`, body: `${f.severity} severity, 60 min timer`, route: `flags?id=${flagRef(f)}`, label: f.label, email: f.severity === 'high' });
    }
    return after;
  }

  /** Active users (of a tenant, or of any tenant) holding one of the roles, grouped by tenant. */
  private async withRoles(tenantId: string | null, roles: string[]): Promise<Map<string, string[]>> {
    const q = this.db('users as u').join('user_roles as r', 'r.user_id', 'u.id').where('u.state', 'active').whereIn('r.role', roles).distinct('u.id', 'u.tenant_id');
    if (tenantId) q.andWhere('u.tenant_id', tenantId);
    const out = new Map<string, string[]>();
    for (const r of (await q) as { id: string; tenant_id: string }[]) out.set(r.tenant_id, [...(out.get(r.tenant_id) ?? []), r.id]);
    return out;
  }

  /** Reviewers a flag can go to: active, in the tenant, holding flags:review and cleared for its label. */
  async reviewers(p: Principal, ref: string, workspaces: string[]) {
    const f = await this.visible(p, ref, workspaces);
    const users = (await this.db('users').where({ tenant_id: p.tenantId, state: 'active' }).select('id', 'display_name', 'username', 'clearance')) as { id: string; display_name: string; username: string; clearance: string }[];
    const roles = (await this.db('user_roles').whereIn('user_id', users.map((u) => u.id)).select('user_id', 'role')) as { user_id: string; role: string }[];
    return users
      .filter((u) => u.id !== p.userId && isLabel(u.clearance) && clears(u.clearance, f.label) && permissionsFor(roles.filter((r) => r.user_id === u.id).map((r) => r.role)).has('flags:review'))
      .map((u) => ({ id: u.id, name: u.display_name, username: u.username, clearance: u.clearance, roles: roles.filter((r) => r.user_id === u.id).map((r) => r.role) }));
  }

  /** Hands the flag to another reviewer cleared for it. Allowed above the caller's own clearance: it is the only action there. */
  async reassign(p: Principal, ref: string, workspaces: string[], userId: string): Promise<{ flag: FlagRow; to: { id: string; name: string } }> {
    const f = await this.openFor(p, ref, workspaces);
    const to = (await this.reviewers(p, ref, workspaces)).find((u) => u.id === userId);
    if (!to) throw forbidden(`That person is not a reviewer cleared for ${f.label}.`, { step: 'clearance' });
    await this.db('guard_flags').where({ id: f.id }).update({ assignee: to.id });
    const after = { ...f, assignee: to.id };
    await this.event(after, 'reassigned', p.userId, to.name);
    await this.notifications.notify({ tenantId: f.tenant_id, userIds: [to.id], kind: 'flag', title: `Flag ${flagRef(f)} was assigned to you`, body: `${f.severity} severity`, route: `flags?id=${flagRef(f)}`, label: f.label, email: f.severity === 'high' });
    return { flag: after, to: { id: to.id, name: to.name } };
  }

  /**
   * Overdue flags: each is reported once to the tenant's guardrail admins (the reviewers' queues already sort them
   * first), recorded as a `breached` event.
   */
  async sweep(tenantId: string): Promise<number> {
    const now = Date.now();
    const rows = ((await this.db('guard_flags').where({ tenant_id: tenantId, state: 'open' }).andWhere('due_at', '<', now).whereNull('breach_notified_at').limit(200)) as Record<string, unknown>[]).map(fromRow);
    if (!rows.length) return 0;
    const admins = (await this.withRoles(tenantId, ['guardrail-admin'])).get(tenantId) ?? [];
    for (const f of rows) {
      await this.db('guard_flags').where({ id: f.id }).update({ breach_notified_at: now });
      await this.event(f, 'breached', null, `${Math.round((now - f.due_at) / 60_000)} min past its ${f.sla_minutes} min timer`);
      await this.notifications.notify({ tenantId, userIds: admins, kind: 'flag', title: `Flag ${flagRef(f)} is past its ${f.sla_minutes} min timer`, body: `${f.severity} severity`, route: `flags?id=${flagRef(f)}`, label: f.label, email: f.severity === 'high' });
    }
    return rows.length;
  }
}
