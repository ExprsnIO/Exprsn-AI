import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom, isUniqueViolation, type AuditActor } from '../audit/chain.js';
import { clears, isLabel, type Label } from '../authz/labels.js';
import { isRole, rolesGranting, type Permission } from '../authz/permissions.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { flagFromRow, flagRef } from '../guardrails/flags.js';
import { workspacesFor } from '../http/middleware.js';
import { badRequest, conflict, forbidden, notFound } from '../http/problem.js';
import { appealFrom, appealRef } from '../moderation/service.js';
import { channelFrom, sessionFrom } from '../channels/service.js';
import type { Services } from '../services.js';
import { addBusiness, businessHoursSchema, businessMs, type BusinessHours } from './hours.js';

/*
 * Sprint 46 (B-134): SLA timers and assignment routing for the customer-service channels and the review queues.
 *
 * Queue types, each read through an adapter over its own tables and assigned through its own path:
 *
 * | Type | Items | Timer starts | First response | Resolved | Paused | Assigned through |
 * | --- | --- | --- | --- | --- | --- | --- |
 * | `channel-session` | escalated sessions | `escalated_at` | first message by a person | closed | a person answered, until the customer writes | `ChannelService.assignSession` |
 * | `flag` | open flags (not those of held writes) | created | first reviewer action | decided | never | `FlagService.assignTo` |
 * | `held-write` | writes held for review | created | first reviewer action on its flag | decided | never | its flag, `FlagService.assignTo` |
 * | `appeal` | pending and reviewing appeals | filed | review started | decided | never | `ModerationService.assignAppeal` |
 *
 * A policy (`sla_policies`) applies per tenant, queue type and scope (a channel id, a moderation queue id, a held
 * write's kind, an appeal's kind; `*` for the whole type; the most specific wins). Its targets count only business
 * hours (`hours.ts`). Timers are computed from each item's own timestamps on every read and by the scheduled tick
 * (`sla.tick`, per tenant), which also fires the warn and breach actions (notify, raise priority, escalate), each
 * claimed once per item with one conditional update on `sla_timers`, and routes unassigned items by the queue's rule
 * (`routing_rules`): round-robin, least-loaded (open items per assignee) or skills (`user_skills` matched against the
 * item's tags), skipping people whose presence is away or offline, with a fallback. Nothing is assigned by writing a
 * domain's table here: the domain's own path audits it and tells the person.
 */

export const QUEUE_TYPES = ['channel-session', 'flag', 'held-write', 'appeal'] as const;
export type QueueType = (typeof QUEUE_TYPES)[number];
export const ROUTING_MODES = ['manual', 'round-robin', 'least-loaded', 'skills'] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];
export const SLA_TICK = 'sla.tick';
const TICK_MS = 60_000;
const ROUTING_ACTOR = 'sla-routing';
const PRIORITIES = ['normal', 'high', 'urgent'] as const;
type Priority = (typeof PRIORITIES)[number];

/** Each domain's own permissions: its manage permission changes its policies and rules, its review permission reads. */
export const QUEUE_PERMS: Record<QueueType, { manage: Permission; review: Permission; route: string }> = {
  'channel-session': { manage: 'channels:manage', review: 'channels:review', route: 'channels' },
  flag: { manage: 'moderation:manage', review: 'flags:review', route: 'flags' },
  'held-write': { manage: 'moderation:manage', review: 'moderation:review', route: 'moderation' },
  appeal: { manage: 'moderation:manage', review: 'moderation:review', route: 'moderation' }
};

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
export const slaActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('notify'), role: z.string().max(63).optional() }).strict(),
  z.object({ kind: z.literal('priority'), to: z.enum(['high', 'urgent']) }).strict(),
  z.object({ kind: z.literal('escalate'), role: z.string().max(63).optional(), user: id26.optional() }).strict()
]);
export type SlaAction = z.infer<typeof slaActionSchema>;
const scopeKey = z.string().trim().min(1).max(63).regex(/^[A-Za-z0-9*][A-Za-z0-9_.:-]*$/, 'a channel or queue id, a kind, or *');

export const policyInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    queueType: z.enum(QUEUE_TYPES),
    scope: scopeKey.default('*'),
    firstResponseMinutes: z.number().int().min(1).max(525_600).nullable().default(null),
    resolutionMinutes: z.number().int().min(1).max(525_600).nullable().default(null),
    warnPercent: z.number().int().min(1).max(99).default(80),
    hours: businessHoursSchema.nullable().default(null),
    pauseOnCustomer: z.boolean().default(true),
    onWarn: z.array(slaActionSchema).max(5).default([{ kind: 'notify' }]),
    onBreach: z.array(slaActionSchema).max(5).default([{ kind: 'notify' }]),
    enabled: z.boolean().default(true)
  })
  .strict();
export type PolicyInput = z.infer<typeof policyInput>;

export const routingInput = z
  .object({
    queueType: z.enum(QUEUE_TYPES),
    scope: scopeKey.default('*'),
    mode: z.enum(ROUTING_MODES),
    pool: z.object({ role: z.string().max(63).optional(), users: z.array(id26).max(200).optional() }).strict().default({}),
    fallback: z.discriminatedUnion('kind', [z.object({ kind: z.literal('queue') }).strict(), z.object({ kind: z.literal('any') }).strict(), z.object({ kind: z.literal('user'), userId: id26 }).strict()]).default({ kind: 'queue' }),
    skipUnavailable: z.boolean().default(true),
    enabled: z.boolean().default(true)
  })
  .strict();
export type RoutingInput = z.infer<typeof routingInput>;

interface PolicyRow {
  id: string;
  tenant_id: string;
  name: string;
  queue_type: QueueType;
  scope_key: string;
  first_response_minutes: number | null;
  resolution_minutes: number | null;
  warn_percent: number;
  hours: BusinessHours | null;
  pause_on_customer: boolean;
  on_warn: SlaAction[];
  on_breach: SlaAction[];
  enabled: boolean;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

interface RuleRow {
  id: string;
  tenant_id: string;
  queue_type: QueueType;
  scope_key: string;
  mode: RoutingMode;
  pool: { role?: string; users?: string[] };
  fallback: RoutingInput['fallback'];
  skip_unavailable: boolean;
  cursor: string | null;
  enabled: boolean;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

interface TimerRow {
  id: string;
  tenant_id: string;
  queue_type: QueueType;
  item_id: string;
  scope_key: string;
  policy_id: string | null;
  started_at: number;
  first_response_due: number | null;
  first_response_at: number | null;
  resolution_due: number | null;
  resolved_at: number | null;
  first_response_met: boolean | null;
  resolution_met: boolean | null;
  fr_warned_at: number | null;
  fr_breached_at: number | null;
  res_warned_at: number | null;
  res_breached_at: number | null;
  priority: Priority;
  escalated_at: number | null;
  assignee: string | null;
  routed_at: number | null;
  updated_at: number;
}

/** One item of a queue, as its adapter reads it. */
export interface SlaItem {
  type: QueueType;
  id: string;
  tenantId: string;
  workspaceId: string | null;
  label: Label;
  scope: string;
  title: string;
  startedAt: number;
  firstResponseAt: number | null;
  resolvedAt: number | null;
  /** Waiting on the customer: [from, to], `to` null while it still waits. */
  pauses: [number, number | null][];
  assignee: string | null;
  tags: string[];
}

interface Adapter {
  open(tenantId: string): Promise<SlaItem[]>;
  get(tenantId: string, id: string): Promise<SlaItem | null>;
  /** People the item may be given to (already filtered by permission, clearance and workspace). */
  eligible(item: SlaItem): Promise<string[]>;
  /** Assigns through the domain's own path. */
  assign(item: SlaItem, to: string, why: string): Promise<void>;
}

const n = (v: unknown): number | null => (v == null ? null : Number(v));
const b = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true';
const policyFrom = (r: Record<string, unknown>): PolicyRow => ({ ...(r as unknown as PolicyRow), first_response_minutes: n(r.first_response_minutes), resolution_minutes: n(r.resolution_minutes), warn_percent: Number(r.warn_percent), hours: json<BusinessHours | null>(r.hours, null), pause_on_customer: b(r.pause_on_customer), on_warn: json<SlaAction[]>(r.on_warn, []), on_breach: json<SlaAction[]>(r.on_breach, []), enabled: b(r.enabled), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
const ruleFrom = (r: Record<string, unknown>): RuleRow => ({ ...(r as unknown as RuleRow), pool: json<RuleRow['pool']>(r.pool, {}), fallback: json<RuleRow['fallback']>(r.fallback, { kind: 'queue' }), skip_unavailable: b(r.skip_unavailable), enabled: b(r.enabled), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
const timerFrom = (r: Record<string, unknown>): TimerRow => ({
  ...(r as unknown as TimerRow),
  started_at: Number(r.started_at),
  first_response_due: n(r.first_response_due),
  first_response_at: n(r.first_response_at),
  resolution_due: n(r.resolution_due),
  resolved_at: n(r.resolved_at),
  first_response_met: r.first_response_met == null ? null : b(r.first_response_met),
  resolution_met: r.resolution_met == null ? null : b(r.resolution_met),
  fr_warned_at: n(r.fr_warned_at),
  fr_breached_at: n(r.fr_breached_at),
  res_warned_at: n(r.res_warned_at),
  res_breached_at: n(r.res_breached_at),
  escalated_at: n(r.escalated_at),
  routed_at: n(r.routed_at),
  updated_at: Number(r.updated_at),
  priority: (PRIORITIES as readonly string[]).includes(String(r.priority)) ? (r.priority as Priority) : 'normal'
});

export const policyView = (p: PolicyRow) => ({ id: p.id, name: p.name, queueType: p.queue_type, scope: p.scope_key, firstResponseMinutes: p.first_response_minutes, resolutionMinutes: p.resolution_minutes, warnPercent: p.warn_percent, hours: p.hours, pauseOnCustomer: p.pause_on_customer, onWarn: p.on_warn, onBreach: p.on_breach, enabled: p.enabled, createdBy: p.created_by, createdAt: p.created_at, updatedAt: p.updated_at });
export const ruleView = (r: RuleRow) => ({ id: r.id, queueType: r.queue_type, scope: r.scope_key, mode: r.mode, pool: r.pool, fallback: r.fallback, skipUnavailable: r.skip_unavailable, enabled: r.enabled, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at });

/** The timer of one target. `leftMs` is open time left (negative once breached); `fraction` the share used. */
export interface TargetState {
  targetMs: number;
  dueAt: number | null;
  at: number | null;
  met: boolean | null;
  breached: boolean;
  warning: boolean;
  paused: boolean;
  leftMs: number;
  fraction: number;
}

export interface SlaState {
  policyId: string;
  policy: string;
  state: 'ok' | 'warning' | 'breached' | 'paused' | 'met';
  firstResponse: TargetState | null;
  resolution: TargetState | null;
  /** The next due time of a running target, for sorting. */
  dueAt: number | null;
  leftMs: number | null;
}

/** Open time spent waiting on the customer between `from` and `to`. */
function pausedMs(item: SlaItem, to: number, hours: BusinessHours | null): number {
  let total = 0;
  for (const [a, z] of item.pauses) total += businessMs(Math.max(a, item.startedAt), Math.min(z ?? to, to), hours);
  return total;
}

/** The SLA state of an item under a policy at `now` (pure; the tick and every read use it). */
export function evaluate(item: SlaItem, p: Pick<PolicyRow, 'id' | 'name' | 'first_response_minutes' | 'resolution_minutes' | 'warn_percent' | 'hours' | 'pause_on_customer'>, now: number): SlaState {
  const warn = p.warn_percent / 100;
  let fr: TargetState | null = null;
  if (p.first_response_minutes) {
    const target = p.first_response_minutes * 60_000;
    const end = item.firstResponseAt ?? item.resolvedAt ?? now;
    const used = businessMs(item.startedAt, end, p.hours);
    const due = addBusiness(item.startedAt, target, p.hours);
    const done = item.firstResponseAt != null || item.resolvedAt != null;
    fr = { targetMs: target, dueAt: due, at: item.firstResponseAt, met: done ? used <= target : null, breached: used > target, warning: !done && used <= target && used >= target * warn, paused: false, leftMs: target - used, fraction: used / target };
  }
  let res: TargetState | null = null;
  if (p.resolution_minutes) {
    const target = p.resolution_minutes * 60_000;
    const end = item.resolvedAt ?? now;
    const pausedNow = p.pause_on_customer && item.resolvedAt == null && item.pauses.some(([, z]) => z == null);
    const paused = p.pause_on_customer ? pausedMs(item, end, p.hours) : 0;
    const used = businessMs(item.startedAt, end, p.hours) - paused;
    const done = item.resolvedAt != null;
    res = { targetMs: target, dueAt: pausedNow ? null : addBusiness(item.startedAt, target + paused, p.hours), at: item.resolvedAt, met: done ? used <= target : null, breached: used > target, warning: !done && used <= target && used >= target * warn, paused: pausedNow, leftMs: target - used, fraction: used / target };
  }
  const targets = [fr, res].filter((t): t is TargetState => !!t);
  const running = targets.filter((t) => t.met == null);
  const state: SlaState['state'] = targets.some((t) => t.breached) ? 'breached' : running.some((t) => t.warning) ? 'warning' : running.length && running.every((t) => t.paused) ? 'paused' : running.length ? 'ok' : 'met';
  const live = running.filter((t) => !t.paused);
  const next = live.length ? live.reduce((a, c) => (c.leftMs < a.leftMs ? c : a)) : null;
  return { policyId: p.id, policy: p.name, state, firstResponse: fr, resolution: res, dueAt: next?.dueAt ?? null, leftMs: next?.leftMs ?? null };
}

/** The most specific enabled row for a scope: the scope's own, else the queue type's `*`. */
function match<T extends { scope_key: string; enabled: boolean }>(rows: T[], scope: string): T | null {
  return rows.find((r) => r.enabled && r.scope_key === scope) ?? rows.find((r) => r.enabled && r.scope_key === '*') ?? null;
}

export class SlaService {
  private readonly adapters: Record<QueueType, Adapter>;

  constructor(private readonly s: () => Services) {
    this.adapters = { 'channel-session': this.sessionAdapter(), flag: this.flagAdapter(), 'held-write': this.heldAdapter(), appeal: this.appealAdapter() };
  }

  private get db() {
    return this.s().db;
  }

  registerJobs(): void {
    this.s().jobs.register(SLA_TICK, async (p, ctx) => this.tick(String(p.tenantId ?? ctx.job.tenant_id)), { timeoutMs: 5 * 60_000 });
  }

  schedule(): void {
    const s = this.s();
    s.scheduler.every(SLA_TICK, TICK_MS, async () => (await s.tenants.list()).filter((t) => t.state === 'active').map((t) => ({ tenantId: t.id, payload: { tenantId: t.id } })));
  }

  // ---------- permissions ----------

  /** Refuses a principal without the queue type's permission (`manage` or `review`). */
  assertPerm(p: Principal, type: QueueType, what: 'manage' | 'review'): void {
    const perm = QUEUE_PERMS[type][what];
    if (!effectivePermissions(p).has(perm)) throw forbidden(`${what === 'manage' ? 'Changing' : 'Reading'} ${type} SLAs and routing needs ${perm}.`, { step: 'permission', action: perm });
  }

  readableTypes(p: Principal): QueueType[] {
    const held = effectivePermissions(p);
    return QUEUE_TYPES.filter((t) => held.has(QUEUE_PERMS[t].review) || held.has(QUEUE_PERMS[t].manage));
  }

  private async audit(actor: AuditActor, tenantId: string, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>, label: Label = 'internal', traceId?: string | null): Promise<void> {
    await this.s().audit.append({ tenantId, action, kind: actor.user ? 'admin' : 'system', actor, target, ...(detail ? { detail } : {}), label, traceId: traceId ?? null });
  }

  private checkActions(list: SlaAction[]): void {
    for (const a of list) {
      if ((a.kind === 'notify' || a.kind === 'escalate') && a.role && !isRole(a.role)) throw badRequest(`There is no role ${a.role}.`);
      if (a.kind === 'escalate' && !a.role && !a.user) throw badRequest('An escalation names the role or the person it goes to.');
      if (a.kind === 'escalate' && a.role && a.user) throw badRequest('Escalate to a role or to a person, not both.');
    }
  }

  // ---------- policies ----------

  async policies(p: Principal, type?: QueueType) {
    const types = type ? [type] : this.readableTypes(p);
    if (type && !this.readableTypes(p).includes(type)) this.assertPerm(p, type, 'review');
    if (!types.length) return [];
    const rows = ((await this.db('sla_policies').where({ tenant_id: p.tenantId }).whereIn('queue_type', types).orderBy('queue_type').orderBy('scope_key')) as Record<string, unknown>[]).map(policyFrom);
    return rows.map(policyView);
  }

  private async policyRow(tenantId: string, id: string): Promise<PolicyRow> {
    const r = await this.db('sla_policies').where({ tenant_id: tenantId, id }).first();
    if (!r) throw notFound('SLA policy');
    return policyFrom(r);
  }

  async savePolicy(p: Principal, ip: string | null, id: string | null, input: PolicyInput, traceId?: string | null) {
    this.assertPerm(p, input.queueType, 'manage');
    if (!input.firstResponseMinutes && !input.resolutionMinutes) throw badRequest('A policy needs a first-response or a resolution target, or both.');
    this.checkActions([...input.onWarn, ...input.onBreach]);
    const t = Date.now();
    const fields = { name: input.name, queue_type: input.queueType, scope_key: input.scope, first_response_minutes: input.firstResponseMinutes, resolution_minutes: input.resolutionMinutes, warn_percent: input.warnPercent, hours: input.hours ? JSON.stringify(input.hours) : null, pause_on_customer: input.pauseOnCustomer, on_warn: JSON.stringify(input.onWarn), on_breach: JSON.stringify(input.onBreach), enabled: input.enabled, updated_at: t };
    let rowId = id;
    try {
      if (id) {
        const before = await this.policyRow(p.tenantId, id);
        this.assertPerm(p, before.queue_type, 'manage');
        await this.db('sla_policies').where({ tenant_id: p.tenantId, id }).update(fields);
      } else {
        rowId = ulid();
        await this.db('sla_policies').insert({ id: rowId, tenant_id: p.tenantId, created_by: p.userId, created_at: t, ...fields });
      }
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A ${input.queueType} policy for ${input.scope === '*' ? 'the whole queue' : input.scope} exists already; change that one.`);
      throw err;
    }
    const after = await this.policyRow(p.tenantId, rowId!);
    await this.audit(actorFrom(p, ip), p.tenantId, id ? 'sla.policy.updated' : 'sla.policy.created', { policy: after.id, queueType: after.queue_type, scope: after.scope_key }, { name: after.name, firstResponseMinutes: after.first_response_minutes, resolutionMinutes: after.resolution_minutes, warnPercent: after.warn_percent, businessHours: !!after.hours, pauseOnCustomer: after.pause_on_customer, onWarn: after.on_warn.map((a) => a.kind), onBreach: after.on_breach.map((a) => a.kind), enabled: after.enabled }, 'internal', traceId);
    return policyView(after);
  }

  async deletePolicy(p: Principal, ip: string | null, id: string, traceId?: string | null): Promise<void> {
    const row = await this.policyRow(p.tenantId, id);
    this.assertPerm(p, row.queue_type, 'manage');
    await this.db('sla_policies').where({ id: row.id }).delete();
    await this.audit(actorFrom(p, ip), p.tenantId, 'sla.policy.deleted', { policy: row.id, queueType: row.queue_type, scope: row.scope_key }, { name: row.name }, 'internal', traceId);
  }

  // ---------- routing rules ----------

  async rules(p: Principal, type?: QueueType) {
    if (type && !this.readableTypes(p).includes(type)) this.assertPerm(p, type, 'review');
    const types = type ? [type] : this.readableTypes(p);
    if (!types.length) return [];
    return ((await this.db('routing_rules').where({ tenant_id: p.tenantId }).whereIn('queue_type', types).orderBy('queue_type').orderBy('scope_key')) as Record<string, unknown>[]).map(ruleFrom).map(ruleView);
  }

  /** Sets the routing rule of a queue type and scope (one per pair). */
  async saveRule(p: Principal, ip: string | null, input: RoutingInput, traceId?: string | null) {
    this.assertPerm(p, input.queueType, 'manage');
    if (input.pool.role && !isRole(input.pool.role)) throw badRequest(`There is no role ${input.pool.role}.`);
    if (input.pool.role && input.pool.users?.length) throw badRequest('A pool is a role or a list of people, not both.');
    const t = Date.now();
    const before = (await this.db('routing_rules').where({ tenant_id: p.tenantId, queue_type: input.queueType, scope_key: input.scope }).first()) as Record<string, unknown> | undefined;
    const fields = { mode: input.mode, pool: JSON.stringify(input.pool), fallback: JSON.stringify(input.fallback), skip_unavailable: input.skipUnavailable, enabled: input.enabled, updated_at: t };
    if (before) await this.db('routing_rules').where({ id: before.id }).update(fields);
    else {
      try {
        await this.db('routing_rules').insert({ id: ulid(), tenant_id: p.tenantId, queue_type: input.queueType, scope_key: input.scope, cursor: null, created_by: p.userId, created_at: t, ...fields });
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('Someone set this rule a moment ago; reload it.');
        throw err;
      }
    }
    const row = ruleFrom((await this.db('routing_rules').where({ tenant_id: p.tenantId, queue_type: input.queueType, scope_key: input.scope }).first()) as Record<string, unknown>);
    await this.audit(actorFrom(p, ip), p.tenantId, 'sla.routing.updated', { rule: row.id, queueType: row.queue_type, scope: row.scope_key }, { mode: row.mode, pool: row.pool.role ? { role: row.pool.role } : { users: row.pool.users?.length ?? 0 }, fallback: row.fallback.kind, skipUnavailable: row.skip_unavailable, enabled: row.enabled, before: before ? String(before.mode) : null }, 'internal', traceId);
    return ruleView(row);
  }

  async deleteRule(p: Principal, ip: string | null, id: string, traceId?: string | null): Promise<void> {
    const r = await this.db('routing_rules').where({ tenant_id: p.tenantId, id }).first();
    if (!r) throw notFound('Routing rule');
    const row = ruleFrom(r);
    this.assertPerm(p, row.queue_type, 'manage');
    await this.db('routing_rules').where({ id: row.id }).delete();
    await this.audit(actorFrom(p, ip), p.tenantId, 'sla.routing.deleted', { rule: row.id, queueType: row.queue_type, scope: row.scope_key }, { mode: row.mode }, 'internal', traceId);
  }

  // ---------- skills ----------

  /** Skill tags of the tenant's active people (one row per person with any). */
  async skills(tenantId: string) {
    const rows = (await this.db('user_skills as k').join('users as u', 'u.id', 'k.user_id').where({ 'k.tenant_id': tenantId, 'u.state': 'active' }).orderBy('u.display_name').orderBy('k.skill').select('k.user_id', 'k.skill', 'u.display_name', 'u.username')) as { user_id: string; skill: string; display_name: string | null; username: string }[];
    const out = new Map<string, { userId: string; name: string; skills: string[] }>();
    for (const r of rows) {
      const e = out.get(r.user_id) ?? { userId: r.user_id, name: r.display_name || r.username, skills: [] };
      e.skills.push(r.skill);
      out.set(r.user_id, e);
    }
    return [...out.values()];
  }

  async setSkills(p: Principal, ip: string | null, userId: string, skills: string[], traceId?: string | null) {
    const u = (await this.db('users').where({ tenant_id: p.tenantId, id: userId }).first('id', 'display_name', 'username')) as { id: string; display_name: string | null; username: string } | undefined;
    if (!u) throw notFound('User');
    const list = [...new Set(skills.map((x) => x.trim().toLowerCase()).filter(Boolean))].sort();
    const before = ((await this.db('user_skills').where({ tenant_id: p.tenantId, user_id: u.id }).select('skill')) as { skill: string }[]).map((r) => r.skill).sort();
    const t = Date.now();
    await this.db.transaction(async (trx) => {
      await trx('user_skills').where({ tenant_id: p.tenantId, user_id: u.id }).delete();
      if (list.length) await trx('user_skills').insert(list.map((skill) => ({ tenant_id: p.tenantId, user_id: u.id, skill, created_by: p.userId, created_at: t })));
    });
    await this.audit(actorFrom(p, ip), p.tenantId, 'sla.skills.updated', { user: u.id }, { added: list.filter((x) => !before.includes(x)), removed: before.filter((x) => !list.includes(x)) }, 'internal', traceId);
    return { userId: u.id, name: u.display_name || u.username, skills: list };
  }

  // ---------- reading ----------

  private async policiesOf(tenantId: string, type: QueueType): Promise<PolicyRow[]> {
    return ((await this.db('sla_policies').where({ tenant_id: tenantId, queue_type: type, enabled: true })) as Record<string, unknown>[]).map(policyFrom);
  }

  private async rulesOf(tenantId: string, type: QueueType): Promise<RuleRow[]> {
    return ((await this.db('routing_rules').where({ tenant_id: tenantId, queue_type: type, enabled: true })) as Record<string, unknown>[]).map(ruleFrom);
  }

  private async visibleTo(p: Principal): Promise<(item: SlaItem) => boolean> {
    const ws = new Set((await workspacesFor(this.s(), p)).map((w) => w.id));
    return (i) => clears(p.clearance, i.label) && (!i.workspaceId || ws.has(i.workspaceId));
  }

  /**
   * The open items of a queue type the caller may see, each with its SLA state, priority and assignee. `filter`
   * narrows to items `breaching-soon` (in their warning band or past a target) or `breached`.
   */
  async items(p: Principal, type: QueueType, q: { filter?: 'breaching-soon' | 'breached' | undefined; scope?: string | undefined } = {}) {
    this.assertPerm(p, type, 'review');
    const now = Date.now();
    const see = await this.visibleTo(p);
    const items = (await this.adapters[type].open(p.tenantId)).filter(see).filter((i) => !q.scope || i.scope === q.scope);
    const policies = await this.policiesOf(p.tenantId, type);
    const timers = await this.timersOf(type, items.map((i) => i.id));
    const out = items.map((i) => {
      const pol = match(policies, i.scope);
      const sla = pol ? evaluate(i, pol, now) : null;
      const tm = timers.get(i.id);
      return { type, id: i.id, title: i.title, scope: i.scope, label: i.label, workspaceId: i.workspaceId, assignee: i.assignee, tags: i.tags, startedAt: i.startedAt, priority: tm?.priority ?? 'normal', escalatedAt: tm?.escalated_at ?? null, routedAt: tm?.routed_at ?? null, sla };
    });
    const filtered = q.filter === 'breached' ? out.filter((x) => x.sla?.state === 'breached') : q.filter === 'breaching-soon' ? out.filter((x) => x.sla?.state === 'breached' || x.sla?.state === 'warning') : out;
    const rank = { urgent: 0, high: 1, normal: 2 } as const;
    filtered.sort((a, c) => rank[a.priority] - rank[c.priority] || (a.sla?.leftMs ?? Infinity) - (c.sla?.leftMs ?? Infinity));
    return { items: filtered, counts: { open: out.length, withSla: out.filter((x) => x.sla).length, warning: out.filter((x) => x.sla?.state === 'warning').length, breached: out.filter((x) => x.sla?.state === 'breached').length, paused: out.filter((x) => x.sla?.state === 'paused').length } };
  }

  /** One item's SLA state (404 when the caller may not see it). */
  async item(p: Principal, type: QueueType, id: string) {
    this.assertPerm(p, type, 'review');
    const i = await this.adapters[type].get(p.tenantId, id);
    if (!i || !(await this.visibleTo(p))(i)) throw notFound('Item');
    const pol = match(await this.policiesOf(p.tenantId, type), i.scope);
    const tm = (await this.timersOf(type, [i.id])).get(i.id);
    return { type, id: i.id, title: i.title, scope: i.scope, assignee: i.assignee, tags: i.tags, startedAt: i.startedAt, firstResponseAt: i.firstResponseAt, resolvedAt: i.resolvedAt, pauses: i.pauses, priority: tm?.priority ?? 'normal', escalatedAt: tm?.escalated_at ?? null, sla: pol ? evaluate(i, pol, Date.now()) : null };
  }

  /**
   * Per-scope statistics over the last `days`: items resolved under a policy, the share that met each target, the
   * average first response (wall-clock), and the open items now with their warning and breached counts.
   */
  async stats(p: Principal, type: QueueType, days = 30) {
    this.assertPerm(p, type, 'review');
    const since = Date.now() - days * 86_400_000;
    const rows = ((await this.db('sla_timers').where({ tenant_id: p.tenantId, queue_type: type }).whereNotNull('resolved_at').andWhere('resolved_at', '>=', since).limit(20_000)) as Record<string, unknown>[]).map(timerFrom);
    const open = (await this.items(p, type)).items;
    const scopes = new Map<string, { scope: string; resolved: number; resolutionMet: number; resolutionCounted: number; firstResponseMet: number; firstResponseCounted: number; firstResponseTotalMs: number; firstResponses: number; breached: number; open: number; warning: number; breachedNow: number }>();
    const of = (scope: string) => {
      let e = scopes.get(scope);
      if (!e) scopes.set(scope, (e = { scope, resolved: 0, resolutionMet: 0, resolutionCounted: 0, firstResponseMet: 0, firstResponseCounted: 0, firstResponseTotalMs: 0, firstResponses: 0, breached: 0, open: 0, warning: 0, breachedNow: 0 }));
      return e;
    };
    for (const r of rows) {
      const e = of(r.scope_key);
      e.resolved++;
      if (r.resolution_met != null) {
        e.resolutionCounted++;
        if (r.resolution_met) e.resolutionMet++;
      }
      if (r.first_response_met != null) {
        e.firstResponseCounted++;
        if (r.first_response_met) e.firstResponseMet++;
      }
      if (r.first_response_at != null) {
        e.firstResponses++;
        e.firstResponseTotalMs += r.first_response_at - r.started_at;
      }
      if (r.resolution_met === false || r.first_response_met === false) e.breached++;
    }
    for (const i of open) {
      const e = of(i.scope);
      e.open++;
      if (i.sla?.state === 'warning') e.warning++;
      if (i.sla?.state === 'breached') e.breachedNow++;
    }
    const pct = (a: number, c: number) => (c ? Math.round((a / c) * 1000) / 10 : null);
    const list = [...scopes.values()].map((e) => ({ scope: e.scope, resolved: e.resolved, resolutionMetPercent: pct(e.resolutionMet, e.resolutionCounted), firstResponseMetPercent: pct(e.firstResponseMet, e.firstResponseCounted), averageFirstResponseMs: e.firstResponses ? Math.round(e.firstResponseTotalMs / e.firstResponses) : null, breached: e.breached, open: e.open, warning: e.warning, breachedNow: e.breachedNow }));
    const all = list.reduce((a, x) => ({ resolved: a.resolved + x.resolved, open: a.open + x.open, breached: a.breached + x.breached }), { resolved: 0, open: 0, breached: 0 });
    const met = rows.filter((r) => r.resolution_met != null);
    const frs = rows.filter((r) => r.first_response_at != null);
    return { type, days, scopes: list, total: { ...all, resolutionMetPercent: pct(met.filter((r) => r.resolution_met).length, met.length), averageFirstResponseMs: frs.length ? Math.round(frs.reduce((a, r) => a + (r.first_response_at! - r.started_at), 0) / frs.length) : null } };
  }

  private async timersOf(type: QueueType, ids: string[]): Promise<Map<string, TimerRow>> {
    const out = new Map<string, TimerRow>();
    for (let i = 0; i < ids.length; i += 500) for (const r of (await this.db('sla_timers').where({ queue_type: type }).whereIn('item_id', ids.slice(i, i + 500))) as Record<string, unknown>[]) out.set(String(r.item_id), timerFrom(r));
    return out;
  }

  // ---------- the tick ----------

  /** Evaluates every open item under a policy, fires warn and breach actions once, routes, and closes finished timers. */
  async tick(tenantId: string, now = Date.now()): Promise<{ tracked: number; warned: number; breached: number; routed: number; closed: number }> {
    const out = { tracked: 0, warned: 0, breached: 0, routed: 0, closed: 0 };
    for (const type of QUEUE_TYPES) {
      const policies = await this.policiesOf(tenantId, type);
      const rules = (await this.rulesOf(tenantId, type)).filter((r) => r.mode !== 'manual');
      const openTimers = ((await this.db('sla_timers').where({ tenant_id: tenantId, queue_type: type }).whereNull('resolved_at').select('item_id')) as { item_id: string }[]).map((r) => r.item_id);
      if (!policies.length && !rules.length && !openTimers.length) continue;
      const adapter = this.adapters[type];
      const items = await adapter.open(tenantId);
      const load = new Map<string, number>();
      for (const i of items) if (i.assignee) load.set(i.assignee, (load.get(i.assignee) ?? 0) + 1);
      for (const item of items) {
        try {
          const rule = match(rules, item.scope);
          if (rule && !item.assignee) {
            const to = await this.route(item, rule, load);
            if (to) {
              out.routed++;
              item.assignee = to;
            }
          }
          const policy = match(policies, item.scope);
          if (policy) {
            const r = await this.track(item, policy, load, now);
            out.tracked++;
            out.warned += r.warned;
            out.breached += r.breached;
          }
        } catch (err) {
          this.s().log.warn({ err, type, item: item.id }, 'sla evaluation failed');
        }
      }
      const live = new Set(items.map((i) => i.id));
      for (const id of openTimers.filter((x) => !live.has(x))) {
        if (await this.close(tenantId, type, id, policies, now)) out.closed++;
      }
    }
    return out;
  }

  /** A finished item's timer keeps its outcome for the statistics. */
  private async close(tenantId: string, type: QueueType, id: string, policies: PolicyRow[], now: number): Promise<boolean> {
    const item = await this.adapters[type].get(tenantId, id);
    const tm = (await this.timersOf(type, [id])).get(id);
    if (!tm) return false;
    const resolvedAt = item?.resolvedAt ?? now;
    const pol = policies.find((x) => x.id === tm.policy_id) ?? (item ? match(policies, item.scope) : null);
    const st = item && pol ? evaluate({ ...item, resolvedAt }, pol, now) : null;
    const n = await this.db('sla_timers').where({ id: tm.id }).whereNull('resolved_at').update({ resolved_at: resolvedAt, first_response_at: item?.firstResponseAt ?? tm.first_response_at, first_response_met: st?.firstResponse?.met ?? tm.first_response_met ?? null, resolution_met: st?.resolution?.met ?? null, updated_at: now });
    return n === 1;
  }

  private async track(item: SlaItem, policy: PolicyRow, load: Map<string, number>, now: number): Promise<{ warned: number; breached: number }> {
    const st = evaluate(item, policy, now);
    let tm = (await this.timersOf(item.type, [item.id])).get(item.id);
    const patch = { policy_id: policy.id, scope_key: item.scope, started_at: item.startedAt, first_response_due: st.firstResponse?.dueAt ?? null, first_response_at: item.firstResponseAt, resolution_due: st.resolution?.dueAt ?? null, first_response_met: st.firstResponse?.met ?? null, assignee: item.assignee, updated_at: now };
    if (!tm) {
      try {
        await this.db('sla_timers').insert({ id: ulid(), tenant_id: item.tenantId, queue_type: item.type, item_id: item.id, priority: 'normal', ...patch });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
      tm = (await this.timersOf(item.type, [item.id])).get(item.id)!;
    } else await this.db('sla_timers').where({ id: tm.id }).update(patch);
    const out = { warned: 0, breached: 0 };
    const phases: { target: TargetState | null; name: 'first response' | 'resolution'; warn: 'fr_warned_at' | 'res_warned_at'; breach: 'fr_breached_at' | 'res_breached_at' }[] = [
      { target: st.firstResponse, name: 'first response', warn: 'fr_warned_at', breach: 'fr_breached_at' },
      { target: st.resolution, name: 'resolution', warn: 'res_warned_at', breach: 'res_breached_at' }
    ];
    for (const ph of phases) {
      const t = ph.target;
      if (!t || t.met != null || t.paused) continue;
      if (t.breached) {
        // Claimed once across instances; a late tick does not also send the warning.
        const n = await this.db('sla_timers').where({ id: tm.id }).whereNull(ph.breach).update({ [ph.breach]: now, [ph.warn]: tm[ph.warn] ?? now });
        if (n === 1) {
          out.breached++;
          await this.fire(item, tm, policy, policy.on_breach, 'breach', ph.name, t, load);
        }
      } else if (t.warning) {
        const n = await this.db('sla_timers').where({ id: tm.id }).whereNull(ph.warn).update({ [ph.warn]: now });
        if (n === 1) {
          out.warned++;
          await this.fire(item, tm, policy, policy.on_warn, 'warn', ph.name, t, load);
        }
      }
    }
    return out;
  }

  private async fire(item: SlaItem, tm: TimerRow, policy: PolicyRow, actions: SlaAction[], phase: 'warn' | 'breach', target: string, t: TargetState, load: Map<string, number>): Promise<void> {
    const s = this.s();
    const done: Record<string, unknown>[] = [];
    const left = Math.round(Math.abs(t.leftMs) / 60_000);
    const title = phase === 'warn' ? `${item.title} is close to its ${target} target` : `${item.title} passed its ${target} target`;
    const body = phase === 'warn' ? `${left} min of business time left under ${policy.name}.` : `${left} min over, under ${policy.name}.`;
    for (const a of actions) {
      try {
        if (a.kind === 'notify') {
          const ids = new Set<string>(item.assignee ? [item.assignee] : (await this.adapters[item.type].eligible(item)).slice(0, 50));
          if (a.role) for (const u of await s.notifications.usersWithRoles(item.tenantId, [a.role])) ids.add(u);
          if (ids.size) await s.notifications.notify({ tenantId: item.tenantId, userIds: [...ids], kind: 'sla', title, body, route: this.routeOf(item), label: item.label, email: phase === 'breach' });
          done.push({ kind: 'notify', to: ids.size });
        } else if (a.kind === 'priority') {
          const rank = (x: Priority) => PRIORITIES.indexOf(x);
          const now = (await this.timersOf(item.type, [item.id])).get(item.id)?.priority ?? tm.priority;
          if (rank(a.to) > rank(now)) await this.db('sla_timers').where({ id: tm.id }).update({ priority: a.to });
          done.push({ kind: 'priority', to: a.to });
        } else {
          const to = await this.escalationTarget(item, a, load);
          if (to && to !== item.assignee) {
            await this.adapters[item.type].assign(item, to, `${target} ${phase === 'warn' ? 'nearly due' : 'overdue'} under ${policy.name}`);
            load.set(to, (load.get(to) ?? 0) + 1);
            item.assignee = to;
            await this.db('sla_timers').where({ id: tm.id }).update({ escalated_at: Date.now(), assignee: to });
          }
          done.push({ kind: 'escalate', to: to ?? null, ...(a.role ? { role: a.role } : {}) });
        }
      } catch (err) {
        done.push({ kind: a.kind, error: (err as Error).message.slice(0, 200) });
      }
    }
    await this.audit({ service: 'sla' }, item.tenantId, phase === 'warn' ? 'sla.item.warned' : 'sla.item.breached', { queueType: item.type, item: item.id, ref: item.title, policy: policy.id }, { target, leftMs: t.leftMs, actions: done }, item.label);
  }

  private routeOf(item: SlaItem): string {
    if (item.type === 'flag') return `flags?id=${item.title}`;
    if (item.type === 'appeal') return `moderation?appeal=${item.title}`;
    if (item.type === 'held-write') return 'moderation?tab=queues';
    return `channels?id=${item.scope}&session=${item.id}`;
  }

  private async escalationTarget(item: SlaItem, a: Extract<SlaAction, { kind: 'escalate' }>, load: Map<string, number>): Promise<string | null> {
    const eligible = await this.adapters[item.type].eligible(item);
    if (a.user) return eligible.includes(a.user) ? a.user : null;
    const holders = new Set(await this.s().notifications.usersWithRoles(item.tenantId, [a.role!]));
    const pool = eligible.filter((u) => holders.has(u) && u !== item.assignee);
    const free = await this.available(item.tenantId, pool);
    return this.leastLoaded(free.length ? free : pool, load);
  }

  private leastLoaded(ids: string[], load: Map<string, number>): string | null {
    let best: string | null = null;
    for (const id of [...ids].sort()) if (best == null || (load.get(id) ?? 0) < (load.get(best) ?? 0)) best = id;
    return best;
  }

  /** People whose presence is neither away nor offline. */
  private async available(tenantId: string, ids: string[]): Promise<string[]> {
    if (!ids.length) return [];
    const st = await this.s().presence.effective(tenantId, ids);
    return ids.filter((u) => {
      const x = st.get(u);
      return x !== 'away' && x !== 'offline';
    });
  }

  /** Picks an assignee for an unassigned item by its queue's rule, and assigns it through the domain. */
  async route(item: SlaItem, rule: RuleRow, load: Map<string, number>): Promise<string | null> {
    const s = this.s();
    let pool = await this.adapters[item.type].eligible(item);
    if (rule.pool.role) {
      const holders = new Set(await s.notifications.usersWithRoles(item.tenantId, [rule.pool.role]));
      pool = pool.filter((u) => holders.has(u));
    } else if (rule.pool.users?.length) pool = pool.filter((u) => rule.pool.users!.includes(u));
    const eligible = pool;
    const free = rule.skip_unavailable ? await this.available(item.tenantId, pool) : pool;
    const skipped = pool.length - free.length;
    let to: string | null = null;
    let how: string = rule.mode;
    let matched: string[] = [];
    if (rule.mode === 'least-loaded') to = this.leastLoaded(free, load);
    else if (rule.mode === 'round-robin') to = await this.nextInTurn(rule, free);
    else if (rule.mode === 'skills') {
      const tags = new Set(item.tags.map((t) => t.toLowerCase()));
      const rows = free.length ? ((await s.db('user_skills').where({ tenant_id: item.tenantId }).whereIn('user_id', free).select('user_id', 'skill')) as { user_id: string; skill: string }[]) : [];
      const score = new Map<string, string[]>();
      for (const r of rows) if (tags.has(r.skill)) score.set(r.user_id, [...(score.get(r.user_id) ?? []), r.skill]);
      const top = Math.max(0, ...[...score.values()].map((v) => v.length));
      if (top > 0) {
        const best = [...score.entries()].filter(([, v]) => v.length === top).map(([u]) => u);
        to = this.leastLoaded(best, load);
        matched = score.get(to!) ?? [];
      }
    }
    if (!to) {
      if (rule.fallback.kind === 'any') {
        to = this.leastLoaded(free, load);
        how = `${rule.mode}, fallback least-loaded`;
      } else if (rule.fallback.kind === 'user' && eligible.includes(rule.fallback.userId)) {
        to = rule.fallback.userId;
        how = `${rule.mode}, fallback person`;
      }
    }
    if (!to) return null;
    await this.adapters[item.type].assign(item, to, `routed (${how}${matched.length ? `, skills ${matched.join(', ')}` : ''})`);
    load.set(to, (load.get(to) ?? 0) + 1);
    await this.db('sla_timers').where({ queue_type: item.type, item_id: item.id }).update({ routed_at: Date.now(), assignee: to });
    await this.audit({ service: 'sla' }, item.tenantId, 'sla.item.routed', { queueType: item.type, item: item.id, ref: item.title, rule: rule.id }, { mode: how, to, skills: matched, skippedUnavailable: skipped, pool: eligible.length }, item.label);
    return to;
  }

  /** Round-robin: the next person after the cursor, claimed with a conditional update so two instances take turns. */
  private async nextInTurn(rule: RuleRow, free: string[]): Promise<string | null> {
    if (!free.length) return null;
    const order = [...free].sort();
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = ((await this.db('routing_rules').where({ id: rule.id }).first('cursor')) as { cursor: string | null } | undefined)?.cursor ?? null;
      const next = order.find((u) => cur == null || u > cur) ?? order[0]!;
      const q = this.db('routing_rules').where({ id: rule.id });
      const n = await (cur == null ? q.whereNull('cursor') : q.where({ cursor: cur })).update({ cursor: next });
      if (n === 1) return next;
    }
    return null;
  }

  // ---------- adapters ----------

  /** Active people holding a permission, cleared for a label, who may act in a workspace (or all, without one). */
  private async reviewersWith(tenantId: string, perm: Permission, label: Label, workspaceId: string | null): Promise<string[]> {
    const db = this.db;
    const rows = (await db('users as u').join('user_roles as r', 'r.user_id', 'u.id').where({ 'u.tenant_id': tenantId, 'u.state': 'active' }).whereIn('r.role', rolesGranting(perm, tenantId)).distinct('u.id', 'u.clearance')) as { id: string; clearance: string }[];
    let ids = rows.filter((u) => isLabel(u.clearance) && clears(u.clearance, label)).map((u) => u.id);
    if (workspaceId) {
      const ws = await this.s().tenants.workspace(tenantId, workspaceId);
      if (ws?.visibility !== 'tenant') {
        const members = new Set(((await db('workspace_members').where({ workspace_id: workspaceId }).select('user_id')) as { user_id: string }[]).map((r) => r.user_id));
        const admins = new Set(((await db('user_roles').whereIn('user_id', ids).whereIn('role', rolesGranting('tenant:manage', tenantId)).select('user_id')) as { user_id: string }[]).map((r) => r.user_id));
        ids = ids.filter((u) => members.has(u) || admins.has(u));
      }
    }
    return ids.sort();
  }

  /** The first action a person took on each flag (anything but its creation). */
  private async firstTouch(flagIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (let i = 0; i < flagIds.length; i += 500) {
      const rows = (await this.db('guard_flag_events').whereIn('flag_id', flagIds.slice(i, i + 500)).whereNotNull('actor').whereNot({ actor: ROUTING_ACTOR }).whereNotIn('action', ['created', 'breached']).groupBy('flag_id').select('flag_id').min({ at: 'created_at' })) as { flag_id: string; at: number | string }[];
      for (const r of rows) out.set(r.flag_id, Number(r.at));
    }
    return out;
  }

  private flagItem(r: Record<string, unknown>, touched: Map<string, number>): SlaItem {
    const f = flagFromRow(r);
    return { type: 'flag', id: f.id, tenantId: f.tenant_id, workspaceId: f.workspace_id, label: f.label, scope: f.queue_id ?? '*', title: flagRef(f), startedAt: f.created_at, firstResponseAt: touched.get(f.id) ?? null, resolvedAt: f.decided_at, pauses: [], assignee: f.assignee, tags: [f.severity, f.checkpoint, f.kind, ...(f.rule_name ? [`rule:${f.rule_name.toLowerCase()}`] : [])] };
  }

  private async assignFlag(tenantId: string, flagId: string, to: string, why: string): Promise<void> {
    const s = this.s();
    const f = flagFromRow((await s.db('guard_flags').where({ tenant_id: tenantId, id: flagId }).first()) as Record<string, unknown>);
    const u = (await s.db('users').where({ id: to }).first('display_name', 'username')) as { display_name: string | null; username: string } | undefined;
    const after = await s.guard.flags.assignTo(f, ROUTING_ACTOR, { id: to, name: u?.display_name || u?.username || to });
    // assignTo records the event; the person is told here, as the reviewers' own reassign does.
    await s.notifications.notify({ tenantId, userIds: [to], kind: 'flag', title: `Flag ${flagRef(after)} was assigned to you`, body: `${after.severity} severity; ${why}`, route: `flags?id=${flagRef(after)}`, label: after.label, email: after.severity === 'high' });
  }

  private flagAdapter(): Adapter {
    const open = async (tenantId: string) => {
      const rows = (await this.db('guard_flags').where({ tenant_id: tenantId, state: 'open' }).andWhere((q) => q.whereNull('source_kind').orWhereNot({ source_kind: 'held-write' })).orderBy('created_at').limit(2000)) as Record<string, unknown>[];
      const touched = await this.firstTouch(rows.map((r) => String(r.id)));
      return rows.map((r) => this.flagItem(r, touched));
    };
    return {
      open,
      get: async (tenantId, id) => {
        const r = (await this.db('guard_flags').where({ tenant_id: tenantId, id }).first()) as Record<string, unknown> | undefined;
        return r ? this.flagItem(r, await this.firstTouch([id])) : null;
      },
      eligible: (i) => this.reviewersWith(i.tenantId, 'flags:review', i.label, i.workspaceId),
      assign: (i, to, why) => this.assignFlag(i.tenantId, i.id, to, why)
    };
  }

  private async heldItems(tenantId: string, where: Record<string, unknown>): Promise<SlaItem[]> {
    const rows = (await this.db('held_writes').where({ tenant_id: tenantId, reason: 'review', ...where }).orderBy('created_at').limit(2000)) as Record<string, unknown>[];
    const flagIds = rows.map((r) => r.flag_id).filter((x): x is string => typeof x === 'string');
    const flags = new Map<string, Record<string, unknown>>();
    for (let i = 0; i < flagIds.length; i += 500) for (const f of (await this.db('guard_flags').whereIn('id', flagIds.slice(i, i + 500)).select('id', 'assignee', 'number')) as Record<string, unknown>[]) flags.set(String(f.id), f);
    const touched = await this.firstTouch(flagIds);
    return rows.map((r) => {
      const f = r.flag_id ? flags.get(String(r.flag_id)) : undefined;
      return { type: 'held-write' as const, id: String(r.id), tenantId, workspaceId: (r.workspace_id as string | null) ?? null, label: isLabel(r.label) ? r.label : 'internal', scope: String(r.kind), title: f ? `F-${Number(f.number)}` : `held ${String(r.id).slice(-6)}`, startedAt: Number(r.created_at), firstResponseAt: r.flag_id ? (touched.get(String(r.flag_id)) ?? null) : null, resolvedAt: n(r.decided_at), pauses: [], assignee: (f?.assignee as string | null) ?? null, tags: [String(r.kind), ...(r.rule_name ? [`rule:${String(r.rule_name).toLowerCase()}`] : [])] };
    });
  }

  private heldAdapter(): Adapter {
    return {
      open: (tenantId) => this.heldItems(tenantId, { state: 'held' }),
      get: async (tenantId, id) => (await this.heldItems(tenantId, { id }))[0] ?? null,
      eligible: (i) => this.reviewersWith(i.tenantId, 'moderation:review', i.label, i.workspaceId),
      assign: async (i, to, why) => {
        const h = (await this.db('held_writes').where({ tenant_id: i.tenantId, id: i.id }).first('flag_id')) as { flag_id: string | null } | undefined;
        if (!h?.flag_id) throw conflict('This held write has no review flag to assign.');
        await this.assignFlag(i.tenantId, h.flag_id, to, why);
      }
    };
  }

  private appealItem(r: Record<string, unknown>): SlaItem {
    const a = appealFrom(r);
    return { type: 'appeal', id: a.id, tenantId: a.tenant_id, workspaceId: a.workspace_id, label: a.label, scope: a.kind, title: appealRef(a), startedAt: a.created_at, firstResponseAt: a.reviewed_at, resolvedAt: a.decided_at, pauses: [], assignee: (r.assignee_id as string | null) ?? (a.state === 'reviewing' ? a.reviewer_id : null), tags: [a.kind] };
  }

  private appealAdapter(): Adapter {
    return {
      open: async (tenantId) => ((await this.db('moderation_appeals').where({ tenant_id: tenantId }).whereIn('state', ['pending', 'reviewing']).orderBy('created_at').limit(2000)) as Record<string, unknown>[]).map((r) => this.appealItem(r)),
      get: async (tenantId, id) => {
        const r = (await this.db('moderation_appeals').where({ tenant_id: tenantId, id }).first()) as Record<string, unknown> | undefined;
        return r ? this.appealItem(r) : null;
      },
      eligible: async (i) => {
        const a = (await this.db('moderation_appeals').where({ id: i.id }).first('user_id')) as { user_id: string } | undefined;
        return (await this.reviewersWith(i.tenantId, 'moderation:review', i.label, i.workspaceId)).filter((u) => u !== a?.user_id);
      },
      assign: async (i, to) => {
        await this.s().moderation.assignAppeal({ tenantId: i.tenantId, principal: null, actor: { service: 'sla' } }, i.id, to);
      }
    };
  }

  private async sessionItems(tenantId: string, rows: Record<string, unknown>[]): Promise<SlaItem[]> {
    if (!rows.length) return [];
    const sessions = rows.map(sessionFrom);
    const channelIds = [...new Set(sessions.map((x) => x.channel_id))];
    const channels = new Map(((await this.db('channels').whereIn('id', channelIds)) as Record<string, unknown>[]).map((r) => [String(r.id), channelFrom(r)]));
    const msgs = new Map<string, { role: string; created_at: number }[]>();
    for (let i = 0; i < sessions.length; i += 200) {
      const part = (await this.db('channel_messages').whereIn('session_id', sessions.slice(i, i + 200).map((x) => x.id)).whereIn('role', ['customer', 'agent']).whereNot({ state: 'hidden' }).orderBy('seq').select('session_id', 'role', 'created_at')) as { session_id: string; role: string; created_at: number | string }[];
      for (const m of part) msgs.set(m.session_id, [...(msgs.get(m.session_id) ?? []), { role: m.role, created_at: Number(m.created_at) }]);
    }
    return sessions.map((x) => {
      const c = channels.get(x.channel_id);
      const start = x.escalated_at ?? x.created_at;
      const after = (msgs.get(x.id) ?? []).filter((m) => m.created_at >= start);
      const first = after.find((m) => m.role === 'agent')?.created_at ?? null;
      // Waiting on the customer: from a person's answer until the customer writes again.
      const pauses: [number, number | null][] = [];
      let since: number | null = null;
      for (const m of after) {
        if (m.role === 'agent' && since == null) since = m.created_at;
        else if (m.role === 'customer' && since != null) {
          pauses.push([since, m.created_at]);
          since = null;
        }
      }
      if (since != null) pauses.push([since, x.state === 'closed' ? (x.closed_at ?? null) : null]);
      return { type: 'channel-session' as const, id: x.id, tenantId, workspaceId: x.workspace_id, label: x.label, scope: x.channel_id, title: `${c?.name ?? 'Channel'} ${x.id.slice(-6)}`, startedAt: start, firstResponseAt: first, resolvedAt: x.state === 'closed' || x.state === 'hidden' ? (x.closed_at ?? x.updated_at) : null, pauses, assignee: x.assignee_id ?? null, tags: [`channel:${(c?.name ?? '').toLowerCase()}`, c?.kind ?? 'chat', 'channel'] };
    });
  }

  private sessionAdapter(): Adapter {
    return {
      open: async (tenantId) => this.sessionItems(tenantId, (await this.db('channel_sessions').where({ tenant_id: tenantId, state: 'escalated' }).orderBy('escalated_at').limit(2000)) as Record<string, unknown>[]),
      get: async (tenantId, id) => {
        const r = (await this.db('channel_sessions').where({ tenant_id: tenantId, id }).first()) as Record<string, unknown> | undefined;
        return r ? ((await this.sessionItems(tenantId, [r]))[0] ?? null) : null;
      },
      eligible: async (i) => {
        const c = await this.s().channels.row(i.tenantId, i.scope);
        return c ? (await this.s().channels.reviewerIds(c)).sort() : [];
      },
      assign: async (i, to, why) => {
        await this.s().channels.assignSession({ service: 'sla' }, i.tenantId, i.id, to, { why });
      }
    };
  }
}

