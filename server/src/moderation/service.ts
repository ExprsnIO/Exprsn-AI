import { createHash, randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import { json } from '../db/knex.js';
import { actorFrom, isUniqueViolation, type AuditActor } from '../audit/chain.js';
import { clears, isLabel, type Label } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { rolesRequireMfa } from '../authz/permissions.js';
import { flagFromRow, flagRef, type EscalationLevel, type FlagRow, type Severity } from '../guardrails/flags.js';
import { actionRank } from '../guardrails/rules.js';
import type { Checkpoint, GuardDecision, GuardFinding } from '../guardrails/types.js';
import { workspacesFor } from '../http/middleware.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { checkServiceUrl, servicePolicy, ServiceUrlRefused } from '../platform/egress.js';
import { TOPICS } from '../platform/bus.js';
import type { JobProgressEvent } from '../platform/jobs.js';
import { EXTERNAL_ZONE, isPrivateCidr } from '../zones/spec.js';
import type { Services } from '../services.js';
import { HttpModerationProviders, type ModerationProviderClient, type ProviderKind } from './providers.js';
import { sanctionRefusal, type Blocking } from './refusal.js';
import { objectHash, ObjectRegistry, registerBuiltInTypes, sourceIdFor, type ModeratedObject } from './registry.js';

/*
 * Moderation actions and appeals (Sprint 26, B-1901 to B-1907), built on the guardrails rather than beside them:
 *
 * - check (B-1901): any object goes through the guardrail engine at a checkpoint; a verdict of flag or worse files one
 *   flag per object (a second check of the same object finds the open flag, and a dismissed one is not raised again
 *   for the same text), and a block hides the object when its type can be hidden.
 * - reports (B-1902): anyone who can see an object reports it into its own workspace's queue, through the registry.
 * - actions and appeals (B-1903): a reviewer hides an object from its flag; its owner appeals; an upheld appeal
 *   restores the object, reopens the flag and negates the AT-Protocol labels made from it.
 * - sanctions (B-1904): warn, suspend or ban, enforced when a session is made and on every request, ended by a job.
 * - routed queues (B-1905): a new flag goes to the first matching queue, whose SLA escalates it; moderation jobs that
 *   fail for good land in a dead-letter queue that a manager redrives.
 * - external providers (B-1906): off by default, only in a zone with egress, in shadow or enforce mode.
 * - notices (B-1907): every decision, sanction and appeal tells the person concerned, by notification and email.
 */

export const PROVIDER_JOB = 'moderation.provider';
export const SWEEP_JOB = 'moderation.sweep';
const SANCTIONS_NS = 'sanctions';
const MAX_BATCH = 100;

export type SanctionKind = 'warn' | 'suspend' | 'ban';

export interface ModCtx {
  tenantId: string;
  principal: Principal | null;
  actor: AuditActor;
  traceId?: string | null;
}

export interface CheckInput {
  type: string;
  id: string;
  text?: string | undefined;
  workspaceId?: string | null | undefined;
  label?: Label | undefined;
  checkpoint?: Checkpoint | undefined;
  /** An at:// URI (or DID) to label from the verdict through the tenant's labeler (B-1610). */
  subject?: string | undefined;
  /** Hide the object on a block (default true). */
  apply?: boolean | undefined;
}

interface ObjectRow {
  id: string;
  tenant_id: string;
  object_type: string;
  object_id: string;
  object_hash: string;
  workspace_id: string | null;
  content_hash: string | null;
  flag_id: string | null;
  generation: number;
  last_action: string | null;
  checks: number;
  updated_at: number;
}

export interface ActionRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  object_type: string;
  object_id: string;
  object_hash: string;
  owner_id: string | null;
  flag_id: string | null;
  action: 'hide';
  prev_state: string | null;
  state: 'applied' | 'reversed';
  source: 'reviewer' | 'guardrail' | 'provider';
  created_by: string | null;
  reason: string | null;
  created_at: number;
  reversed_by: string | null;
  reversed_at: number | null;
  appeal_id: string | null;
}

export interface AppealRow {
  id: string;
  tenant_id: string;
  number: number;
  workspace_id: string | null;
  kind: 'action' | 'sanction';
  action_id: string | null;
  sanction_id: string | null;
  flag_id: string | null;
  label: Label;
  user_id: string;
  filed_by: string;
  statement: string;
  state: 'pending' | 'reviewing' | 'upheld' | 'denied';
  reviewer_id: string | null;
  decision_note: string | null;
  created_at: number;
  reviewed_at: number | null;
  decided_at: number | null;
}

export interface SanctionRow {
  id: string;
  tenant_id: string;
  user_id: string;
  kind: SanctionKind;
  reason: string;
  flag_id: string | null;
  state: 'active' | 'expired' | 'lifted' | 'reversed';
  starts_at: number;
  ends_at: number | null;
  created_by: string;
  created_at: number;
  ended_by: string | null;
  ended_at: number | null;
  end_reason: string | null;
}

export interface QueueRow {
  id: string;
  tenant_id: string;
  name: string;
  workspace_id: string | null;
  rules: string[] | null;
  labels: Label[] | null;
  kinds: string[] | null;
  priority: number;
  sla_minutes: number;
  escalate_to: EscalationLevel;
  escalation_sla_minutes: number;
  enabled: boolean;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface ProviderRow {
  id: string;
  tenant_id: string;
  name: string;
  kind: ProviderKind;
  url: string;
  secret: string | null;
  zone: string;
  mode: 'shadow' | 'enforce';
  enabled: boolean;
  object_types: string[] | null;
  threshold: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const bool = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 't' || v === 'true';
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const objectFrom = (r: Record<string, unknown>): ObjectRow => ({ ...(r as unknown as ObjectRow), generation: num(r.generation), checks: num(r.checks), updated_at: num(r.updated_at) });
const actionFrom = (r: Record<string, unknown>): ActionRow => ({ ...(r as unknown as ActionRow), created_at: num(r.created_at), reversed_at: numOrNull(r.reversed_at) });
const appealFrom = (r: Record<string, unknown>): AppealRow => ({ ...(r as unknown as AppealRow), number: num(r.number), created_at: num(r.created_at), reviewed_at: numOrNull(r.reviewed_at), decided_at: numOrNull(r.decided_at) });
const sanctionFrom = (r: Record<string, unknown>): SanctionRow => ({ ...(r as unknown as SanctionRow), starts_at: num(r.starts_at), ends_at: numOrNull(r.ends_at), created_at: num(r.created_at), ended_at: numOrNull(r.ended_at) });
const queueFrom = (r: Record<string, unknown>): QueueRow => ({ ...(r as unknown as QueueRow), rules: json<string[] | null>(r.rules, null), labels: json<Label[] | null>(r.labels, null), kinds: json<string[] | null>(r.kinds, null), priority: num(r.priority), sla_minutes: num(r.sla_minutes), escalation_sla_minutes: num(r.escalation_sla_minutes), enabled: bool(r.enabled), created_at: num(r.created_at), updated_at: num(r.updated_at) });
const providerFrom = (r: Record<string, unknown>): ProviderRow => ({ ...(r as unknown as ProviderRow), enabled: bool(r.enabled), object_types: json<string[] | null>(r.object_types, null), threshold: Number(r.threshold), created_at: num(r.created_at), updated_at: num(r.updated_at) });

export const appealRef = (a: Pick<AppealRow, 'number'>) => `A-${a.number}`;

const SEVERITY_FOR: Partial<Record<GuardDecision['action'], Severity>> = { block: 'high', 'require-approval': 'high', redact: 'medium', flag: 'medium' };
const STRENGTH: Record<SanctionKind, number> = { warn: 0, suspend: 1, ban: 2 };

export class ModerationService {
  readonly registry = new ObjectRegistry();
  private client: ModerationProviderClient | null;
  private started = false;

  constructor(
    private readonly s: () => Services,
    providers?: ModerationProviderClient
  ) {
    this.client = providers ?? null;
  }

  /** The external provider client (made on first use, so it reads the configuration once services exist). */
  get providers(): ModerationProviderClient {
    return (this.client ??= new HttpModerationProviders(() => servicePolicy(this.s().cfg), this.s().cfg.MODERATION_PROVIDER_TIMEOUT_MS));
  }

  // ---------- wiring ----------

  /** Registers the built-in object types, the jobs, the routing hook, the dead-letter listener and the sign-in gate. */
  init(): void {
    if (this.started) return;
    this.started = true;
    const s = this.s();
    registerBuiltInTypes(this.registry, { db: s.db, keys: s.keys });
    s.jobs.register(PROVIDER_JOB, (p, ctx) => this.providerJob(ctx.job.tenant_id, p), { timeoutMs: 2 * 60_000 });
    s.jobs.register(SWEEP_JOB, async (p, ctx) => this.sweep(String(p.tenantId ?? ctx.job.tenant_id)));
    s.guard.flags.createdListeners.push((f) => this.route(f).catch((err: unknown) => s.log.warn({ err, flag: f.id }, 'routing a flag to a review queue failed')));
    // B-1905: a moderation job that failed its last attempt goes to the dead-letter queue (on the instance that ran it).
    s.bus.on<JobProgressEvent>(TOPICS.jobProgress, (e) => {
      if (e.state !== 'failed' || !e.type.startsWith('moderation.') || e.type === SWEEP_JOB) return;
      void this.deadLetter(e).catch((err: unknown) => s.log.warn({ err, job: e.id }, 'recording a dead letter failed'));
    });
    // B-1904: no session is made for a suspended or banned user, whichever way they sign in.
    s.sessions.admit = (tenantId, userId) => this.assertAdmitted(tenantId, userId);
  }

  schedule(): void {
    const s = this.s();
    s.scheduler.every(SWEEP_JOB, s.cfg.MODERATION_SWEEP_SECONDS * 1000, async () => (await s.tenants.list()).filter((t) => t.state === 'active').map((t) => ({ tenantId: t.id, payload: { tenantId: t.id } })));
  }

  async close(): Promise<void> {
    await this.client?.close();
  }

  private async audit(ctx: ModCtx, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>, label?: Label): Promise<void> {
    await this.s().audit.append({ tenantId: ctx.tenantId, action, kind: ctx.principal ? 'admin' : 'system', actor: ctx.actor, target, ...(detail ? { detail } : {}), ...(label ? { label } : {}), traceId: ctx.traceId ?? null });
  }

  static ctxFor(p: Principal, ip: string | null, traceId?: string | null): ModCtx {
    return { tenantId: p.tenantId, principal: p, actor: actorFrom(p, ip), traceId: traceId ?? null };
  }

  private systemCtx(tenantId: string, service = 'moderation'): ModCtx {
    return { tenantId, principal: null, actor: { service } };
  }

  // ---------- objects ----------

  private async workspaces(p: Principal | null): Promise<string[] | null> {
    return p ? (await workspacesFor(this.s(), p)).map((w) => w.id) : null;
  }

  /** The object as the registry knows it (404 for an unknown object, or one outside the caller's workspaces). */
  private async resolve(ctx: ModCtx, type: string, id: string): Promise<ModeratedObject> {
    const h = this.registry.get(type);
    if (!h) throw new HttpProblem(422, 'Unknown object type', `Nothing registers objects of type ${type}. Known types: ${this.registry.list().map((x) => x.type).join(', ')}.`, { extensions: { step: 'type' } });
    const o = await h.resolve(ctx.tenantId, id);
    if (!o) throw notFound('Object');
    const ws = await this.workspaces(ctx.principal);
    if (ws && o.workspaceId && !ws.includes(o.workspaceId)) throw notFound('Object');
    return o;
  }

  private async objectRow(tenantId: string, type: string, id: string, workspaceId: string | null): Promise<ObjectRow> {
    const hash = objectHash(type, id);
    const existing = await this.s().db('moderation_objects').where({ tenant_id: tenantId, object_hash: hash }).first();
    if (existing) return objectFrom(existing);
    const t = Date.now();
    try {
      await this.s().db('moderation_objects').insert({ id: ulid(), tenant_id: tenantId, object_type: type, object_id: id, object_hash: hash, workspace_id: workspaceId, content_hash: null, flag_id: null, generation: 0, last_action: null, checks: 0, created_at: t, updated_at: t });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
    return objectFrom(await this.s().db('moderation_objects').where({ tenant_id: tenantId, object_hash: hash }).first());
  }

  /**
   * The one flag an object has (B-1901). An open flag is reused; a dismissed one is not raised again while the text is
   * the same. A new flag is claimed by moving the row's generation, so two checks at once make one flag between them.
   */
  private async flagFor(row: ObjectRow, contentHash: string | null, make: () => Promise<FlagRow>): Promise<{ flag: FlagRow; created: boolean }> {
    const s = this.s();
    for (let attempt = 0; attempt < 100; attempt++) {
      const cur = objectFrom(await s.db('moderation_objects').where({ id: row.id }).first());
      if (cur.flag_id === 'PENDING' && Date.now() - cur.updated_at < 30_000) {
        await sleep(15);
        continue;
      }
      if (cur.flag_id && cur.flag_id !== 'PENDING') {
        const f = await s.guard.flags.get(cur.tenant_id, cur.flag_id).catch(() => null);
        if (f && (f.state === 'open' || (f.state === 'dismissed' && contentHash && cur.content_hash === contentHash))) return { flag: f, created: false };
      }
      const n = await s.db('moderation_objects').where({ id: cur.id, generation: cur.generation }).update({ generation: cur.generation + 1, flag_id: 'PENDING', updated_at: Date.now() });
      if (!n) continue;
      try {
        const flag = await make();
        await s.db('moderation_objects').where({ id: cur.id }).update({ flag_id: flag.id, updated_at: Date.now() });
        return { flag, created: true };
      } catch (err) {
        await s.db('moderation_objects').where({ id: cur.id, flag_id: 'PENDING' }).update({ flag_id: cur.flag_id, updated_at: Date.now() });
        throw err;
      }
    }
    throw conflict('The object is being flagged by another check; try again.');
  }

  // ---------- B-1901: checks ----------

  /** Runs the moderation check on one object: the guardrail verdict, the object's one flag, and a hide on a block. */
  async check(ctx: ModCtx, input: CheckInput) {
    const s = this.s();
    const h = this.registry.get(input.type);
    let obj: ModeratedObject;
    let text: string;
    if (h) {
      obj = await this.resolve(ctx, input.type, input.id);
      if (ctx.principal && !clears(ctx.principal.clearance, obj.label)) throw notFound('Object');
      text = input.text ?? (h.text ? await h.text(obj) : '');
    } else {
      if (input.text == null) throw new HttpProblem(422, 'Text needed', `Nothing registers objects of type ${input.type}, so give the text to check.`, { extensions: { step: 'text' } });
      const ws = await this.workspaces(ctx.principal);
      const workspaceId = input.workspaceId === undefined ? (ctx.principal?.workspaceId ?? null) : input.workspaceId;
      if (ws && workspaceId && !ws.includes(workspaceId)) throw notFound('Workspace');
      const label = input.label ?? 'internal';
      if (ctx.principal && !clears(ctx.principal.clearance, label)) throw forbidden(`The object is labelled ${label}, above your clearance.`, { step: 'clearance' });
      obj = { type: input.type, id: input.id, tenantId: ctx.tenantId, workspaceId, label, ownerId: null, state: null };
      text = input.text;
    }
    const checkpoint = input.checkpoint ?? 'user-input';
    const decision = await s.guardrails.check({ tenantId: ctx.tenantId, workspaceId: obj.workspaceId, checkpoint, text, label: obj.label, ...(ctx.principal ? { principal: ctx.principal } : {}), source: { kind: input.type, id: sourceIdFor(input.type, input.id) }, meta: { moderation: true, objectType: input.type, via: 'moderation', ...(obj.conversationId ? { conversationId: obj.conversationId } : {}) } });
    const contentHash = sha(text);
    const row = await this.objectRow(ctx.tenantId, input.type, input.id, obj.workspaceId);
    let flag: FlagRow | null = null;
    let created = false;
    let action: ActionRow | null = null;
    if (actionRank(decision.action) >= actionRank('flag')) {
      const top = topFinding(decision);
      const out = await this.flagFor(row, contentHash, () =>
        s.guard.flags.create({
          tenantId: ctx.tenantId,
          workspaceId: obj.workspaceId,
          kind: 'rule',
          checkpoint,
          ruleId: top?.ruleId ?? null,
          ruleName: top ? top.ruleName : 'Moderation check',
          setId: top?.setId ?? null,
          action: decision.action,
          severity: SEVERITY_FOR[decision.action] ?? 'medium',
          label: obj.label,
          text,
          span: top?.span ?? null,
          note: `Moderation check of ${input.type} ${input.id.slice(0, 200)}${top?.detail ? `: ${top.detail}` : ''}.`,
          actor: { user: ctx.principal?.userId ?? null, name: ctx.principal?.displayName ?? null, via: 'moderation' },
          source: { kind: input.type, id: sourceIdFor(input.type, input.id) },
          conversationId: obj.conversationId ?? null
        })
      );
      flag = out.flag;
      created = out.created;
      if (decision.action === 'block' && input.apply !== false && h?.hide && obj.state !== 'hidden') {
        action = await this.applyHide(ctx, obj, flag, 'guardrail', decision.reason ?? 'Blocked by a guardrail rule').catch(() => null);
      }
    }
    await s.db('moderation_objects').where({ id: row.id }).update({ content_hash: contentHash, last_action: decision.action, checks: row.checks + 1, updated_at: Date.now() });
    if (created) await this.audit(ctx, 'moderation.flagged', { object: input.type, id: input.id.slice(0, 200), flag: flagRef(flag!) }, { verdict: decision.action, checkpoint }, obj.label);
    let labels: string[] = [];
    let labelError: string | null = null;
    if (input.subject && actionRank(decision.action) >= actionRank('warn')) {
      try {
        labels = (await s.atproto.labelDecision({ tenantId: ctx.tenantId, userId: ctx.principal?.userId ?? null, actor: ctx.actor, traceId: ctx.traceId ?? null }, ctx.tenantId, input.subject, decision, { flagId: flag?.id ?? null })).map((l) => l.label.val);
      } catch (err) {
        labelError = (err as Error).message.slice(0, 300);
      }
    }
    const providers = await this.queueProviders(ctx, obj, text, checkpoint, input.subject ?? null);
    return {
      object: { type: input.type, id: input.id, workspaceId: obj.workspaceId, label: obj.label, registered: !!h },
      verdict: { action: decision.action, reason: decision.reason ?? null, findings: decision.findings.filter((f) => f.stage === 'enforce' || !ctx.principal || effectivePermissions(ctx.principal).has('guardrails:manage')) },
      flag: flag ? { id: flag.id, ref: flagRef(flag), state: flag.state, severity: flag.severity, queueId: flag.queue_id ?? null, dueAt: flag.due_at, created } : null,
      action: action ? actionView(action) : null,
      labels,
      ...(labelError ? { labelError } : {}),
      providers
    };
  }

  /** B-1901: up to 100 checks in order; one failing item does not stop the rest. */
  async batch(ctx: ModCtx, items: CheckInput[]) {
    if (items.length > MAX_BATCH) throw new HttpProblem(413, 'Too many items', `A batch holds at most ${MAX_BATCH} objects.`);
    const out: Record<string, unknown>[] = [];
    for (const it of items) {
      try {
        out.push({ ok: true, ...(await this.check(ctx, it)) });
      } catch (err) {
        if (!(err instanceof HttpProblem)) throw err;
        out.push({ ok: false, object: { type: it.type, id: it.id }, status: err.status, detail: err.message });
      }
    }
    return { items: out, flagged: out.filter((x) => x.flag).length };
  }

  // ---------- B-1903: actions on objects ----------

  private async applyHide(ctx: ModCtx, obj: ModeratedObject, flag: FlagRow | null, source: ActionRow['source'], reason: string): Promise<ActionRow> {
    const s = this.s();
    const h = this.registry.get(obj.type);
    if (!h?.hide) throw conflict(`Objects of type ${obj.type} cannot be hidden.`);
    const hash = objectHash(obj.type, obj.id);
    const prev = await h.hide(obj);
    if (!prev) {
      const live = await s.db('moderation_actions').where({ tenant_id: obj.tenantId, object_hash: hash, state: 'applied', action: 'hide' }).orderBy('created_at', 'desc').first();
      if (live) return actionFrom(live);
      throw conflict(`This ${obj.type} is ${obj.state ?? 'unavailable'} and cannot be hidden now.`);
    }
    const row: ActionRow = { id: ulid(), tenant_id: obj.tenantId, workspace_id: obj.workspaceId, object_type: obj.type, object_id: obj.id, object_hash: hash, owner_id: obj.ownerId, flag_id: flag?.id ?? null, action: 'hide', prev_state: prev, state: 'applied', source, created_by: ctx.principal?.userId ?? null, reason: reason.slice(0, 500), created_at: Date.now(), reversed_by: null, reversed_at: null, appeal_id: null };
    await s.db('moderation_actions').insert(row);
    await this.audit(ctx, 'moderation.action.applied', { action: row.id, object: obj.type, id: obj.id.slice(0, 200), ...(flag ? { flag: flagRef(flag) } : {}) }, { kind: 'hide', source, prevState: prev, owner: obj.ownerId }, obj.label);
    if (obj.ownerId) await this.notice(obj.tenantId, obj.ownerId, { event: `Something of yours was hidden: a ${typeName(obj.type)}`, detail: `Reason: ${row.reason}`, next: 'If you think this is wrong, appeal it from the moderation section of the API (POST /api/moderation/appeals with this action id: ' + row.id + ').', route: 'settings' });
    return row;
  }

  /** The object a flag points at, through the registry (flags from other sources have none). */
  private async objectOfFlag(tenantId: string, f: FlagRow): Promise<ModeratedObject | null> {
    if (!f.source_kind || !f.source_id) return null;
    const h = this.registry.get(f.source_kind);
    if (!h) return null;
    let id = f.source_id;
    if (id.startsWith('h:')) {
      const o = (await this.s().db('moderation_objects').where({ tenant_id: tenantId, object_hash: id.slice(2) }).first('object_id')) as { object_id: string } | undefined;
      if (!o) return null;
      id = o.object_id;
    }
    return h.resolve(tenantId, id);
  }

  /** A reviewer hides the object behind a flag (confirming the flag when it is still open). */
  async actOnFlag(ctx: ModCtx & { principal: Principal }, ref: string, reason: string) {
    const s = this.s();
    const p = ctx.principal;
    const ws = (await this.workspaces(p))!;
    const f = await s.guard.flags.get(p.tenantId, ref);
    if (f.workspace_id && !ws.includes(f.workspace_id)) throw notFound('Flag');
    if (!clears(p.clearance, f.label)) throw forbidden(`${flagRef(f)} is labelled ${f.label}, above your clearance of ${p.clearance}.`, { step: 'clearance' });
    if (f.kind === 'hold') throw conflict(`${flagRef(f)} holds an answer; approve or reject it.`);
    const obj = await this.objectOfFlag(p.tenantId, f);
    if (!obj) throw conflict(`${flagRef(f)} does not point at an object moderation can act on.`);
    let flag = f;
    if (f.state === 'open') flag = await s.guard.flags.decide(p, f.id, ws, 'confirmed', reason);
    else if (f.state !== 'confirmed') throw conflict(`${flagRef(f)} was ${f.state}; only an open or confirmed flag leads to an action.`);
    const action = await this.applyHide(ctx, obj, flag, 'reviewer', reason);
    return { flag: s.guard.flags.view(flag, p), action: actionView(action) };
  }

  /**
   * 1.5.0 (B-2905): an admin takes an object down directly, without a flag (an AT-Protocol repo hosted by the PDS).
   * The action is recorded and audited as a reviewer's is, and its owner is told and may appeal it (B-1903).
   */
  async takeDown(ctx: ModCtx & { principal: Principal }, type: string, id: string, reason: string) {
    const obj = await this.resolve(ctx, type, id);
    return actionView(await this.applyHide(ctx, obj, null, 'reviewer', reason));
  }

  /** 1.5.0 (B-2905): an admin reverses an action outside an appeal; the object's state is put back. */
  async reverse(ctx: ModCtx & { principal: Principal }, actionId: string, reason: string) {
    const s = this.s();
    const r = await s.db('moderation_actions').where({ tenant_id: ctx.tenantId, id: actionId }).first();
    if (!r) throw notFound('Action');
    const action = actionFrom(r);
    if (action.state !== 'applied') throw conflict('This action was already reversed.');
    const h = this.registry.get(action.object_type);
    const obj = h ? await h.resolve(action.tenant_id, action.object_id) : null;
    const restored = !!(obj && h?.restore && action.prev_state && (await h.restore(obj, action.prev_state)));
    const at = Date.now();
    await s.db('moderation_actions').where({ id: action.id, state: 'applied' }).update({ state: 'reversed', reversed_by: ctx.principal.userId, reversed_at: at });
    await this.audit(ctx, 'moderation.action.reversed', { action: action.id, object: action.object_type, id: action.object_id.slice(0, 200) }, { restored, prevState: action.prev_state, reason: reason.slice(0, 500) }, obj?.label);
    return { action: actionView({ ...action, state: 'reversed', reversed_by: ctx.principal.userId, reversed_at: at }), restored };
  }

  async actions(p: Principal, q: { type?: string | undefined; id?: string | undefined; ownerId?: string | undefined }) {
    const ws = (await this.workspaces(p))!;
    const qb = this.s().db('moderation_actions').where({ tenant_id: p.tenantId });
    if (q.type && q.id) qb.andWhere({ object_hash: objectHash(q.type, q.id) });
    if (q.ownerId) qb.andWhere({ owner_id: q.ownerId });
    const rows = ((await qb.orderBy('created_at', 'desc').limit(200)) as Record<string, unknown>[]).map(actionFrom);
    return rows.filter((a) => !a.workspace_id || ws.includes(a.workspace_id)).map(actionView);
  }

  // ---------- B-1902: reports ----------

  async report(ctx: ModCtx & { principal: Principal }, input: { type: string; id: string; reason: string; note?: string | undefined; severity: Severity }) {
    const s = this.s();
    const p = ctx.principal;
    const h = this.registry.get(input.type);
    const obj = await this.resolve(ctx, input.type, input.id);
    const ws = (await this.workspaces(p))!;
    if (!(await h!.canRead(p, obj, ws))) throw notFound('Object');
    const hash = objectHash(input.type, input.id);
    // The same person reporting the same object again, while their flag is open, gets that flag back.
    const prior = (await s.db('moderation_reports as r').join('guard_flags as f', 'f.id', 'r.flag_id').where({ 'r.tenant_id': p.tenantId, 'r.object_hash': hash, 'r.reporter_id': p.userId, 'f.state': 'open' }).first('f.id')) as { id: string } | undefined;
    if (prior) {
      const f = await s.guard.flags.get(p.tenantId, prior.id);
      return { duplicate: true, flag: { id: f.id, ref: flagRef(f), severity: f.severity, dueAt: f.due_at, workspaceId: f.workspace_id, queueId: f.queue_id ?? null } };
    }
    const text = h!.text ? await h!.text(obj) : '';
    const reviewer = effectivePermissions(p).has('flags:review');
    const f = await s.guard.flags.create({ tenantId: p.tenantId, workspaceId: obj.workspaceId, kind: reviewer ? 'reviewer' : 'report', checkpoint: 'user-report', ruleName: `Reported ${typeName(input.type)}`, severity: input.severity, label: obj.label, text: text || null, note: `Reporter chose "${input.reason}".${input.note ? ` ${input.note}` : ''}`, actor: { user: p.userId, name: `Reported by ${p.displayName}`, via: 'moderation' }, source: { kind: input.type, id: sourceIdFor(input.type, input.id) }, conversationId: obj.conversationId ?? null });
    await s.db('moderation_reports').insert({ id: ulid(), tenant_id: p.tenantId, reporter_id: p.userId, object_type: input.type, object_id: input.id, object_hash: hash, workspace_id: obj.workspaceId, flag_id: f.id, reason: input.reason.slice(0, 200), created_at: Date.now() });
    await this.audit(ctx, 'moderation.reported', { object: input.type, id: input.id.slice(0, 200), flag: flagRef(f) }, { reason: input.reason, severity: input.severity, workspace: obj.workspaceId }, obj.label);
    return { duplicate: false, flag: { id: f.id, ref: flagRef(f), severity: f.severity, dueAt: f.due_at, workspaceId: f.workspace_id, queueId: f.queue_id ?? null } };
  }

  // ---------- B-1903: appeals ----------

  async appeal(ctx: ModCtx & { principal: Principal }, input: { actionId?: string | undefined; sanctionId?: string | undefined; statement: string; forUserId?: string | undefined }) {
    const s = this.s();
    const p = ctx.principal;
    if (!!input.actionId === !!input.sanctionId) throw new HttpProblem(400, 'Invalid request', 'Appeal either an action (actionId) or a sanction (sanctionId).');
    // A reviewer may record an appeal for someone who cannot sign in (a suspended or banned user).
    if (input.forUserId && input.forUserId !== p.userId && !effectivePermissions(p).has('moderation:review')) throw forbidden('Only a moderation reviewer records an appeal for someone else.', { step: 'permission' });
    const appellant = input.forUserId ?? p.userId;
    let row: Pick<AppealRow, 'kind' | 'action_id' | 'sanction_id' | 'flag_id' | 'workspace_id' | 'label'>;
    if (input.actionId) {
      const a = await s.db('moderation_actions').where({ tenant_id: p.tenantId, id: input.actionId }).first();
      if (!a) throw notFound('Action');
      const action = actionFrom(a);
      if (action.owner_id !== appellant) throw notFound('Action');
      if (action.state !== 'applied') throw conflict('That action was already reversed.');
      const flag = action.flag_id ? await s.guard.flags.get(p.tenantId, action.flag_id).catch(() => null) : null;
      row = { kind: 'action', action_id: action.id, sanction_id: null, flag_id: action.flag_id, workspace_id: action.workspace_id, label: flag?.label ?? 'internal' };
    } else {
      const r = await s.db('moderation_sanctions').where({ tenant_id: p.tenantId, id: input.sanctionId }).first();
      if (!r) throw notFound('Sanction');
      const sanction = sanctionFrom(r);
      if (sanction.user_id !== appellant) throw notFound('Sanction');
      if (sanction.state !== 'active') throw conflict(`That sanction is ${sanction.state}.`);
      const flag = sanction.flag_id ? await s.guard.flags.get(p.tenantId, sanction.flag_id).catch(() => null) : null;
      row = { kind: 'sanction', action_id: null, sanction_id: sanction.id, flag_id: sanction.flag_id, workspace_id: null, label: flag?.label ?? 'internal' };
    }
    const open = await s.db('moderation_appeals').where({ tenant_id: p.tenantId, ...(row.action_id ? { action_id: row.action_id } : { sanction_id: row.sanction_id }) }).whereIn('state', ['pending', 'reviewing']).first('id');
    if (open) throw conflict('An appeal of this is already waiting for review.');
    const id = ulid();
    const base = { id, tenant_id: p.tenantId, ...row, user_id: appellant, filed_by: p.userId, statement: await s.keys.seal(p.tenantId, input.statement, `appeal:${id}`), state: 'pending', reviewer_id: null, decision_note: null, created_at: Date.now(), reviewed_at: null, decided_at: null };
    for (let attempt = 0; ; attempt++) {
      const max = ((await s.db('moderation_appeals').where({ tenant_id: p.tenantId }).max({ n: 'number' }).first()) as { n: number | null } | undefined)?.n ?? 0;
      try {
        await s.db('moderation_appeals').insert({ ...base, number: Number(max) + 1 });
        break;
      } catch (err) {
        if (!isUniqueViolation(err) || attempt >= 5) throw err;
      }
    }
    const a = appealFrom(await s.db('moderation_appeals').where({ id }).first());
    await this.audit(ctx, 'moderation.appeal.submitted', { appeal: appealRef(a), kind: a.kind, ...(a.action_id ? { action: a.action_id } : { sanction: a.sanction_id }) }, { appellant, onBehalf: appellant !== p.userId }, a.label);
    s.bus.publish(TOPICS.poolState, { tenantId: a.tenant_id, perm: 'moderation:review', event: 'moderation.appeals.changed', data: { id: a.id, ref: appealRef(a), state: a.state } });
    await this.notice(a.tenant_id, appellant, { event: `Your appeal ${appealRef(a)} was received`, detail: `It asks to reverse ${a.kind === 'action' ? 'an action on something of yours' : 'a sanction on your account'}.`, next: 'A reviewer who took no part in the decision will look at it; you will be told the outcome.', route: 'settings' });
    return this.appealView(a, p);
  }

  async appealView(a: AppealRow, p: Principal, withStatement = true) {
    const hidden = !clears(p.clearance, a.label) && a.user_id !== p.userId;
    const statement = withStatement && !hidden ? await this.s().keys.open(a.tenant_id, a.statement, `appeal:${a.id}`) : null;
    return { id: a.id, ref: appealRef(a), kind: a.kind, actionId: a.action_id, sanctionId: a.sanction_id, flagId: a.flag_id, workspaceId: a.workspace_id, label: a.label, restricted: hidden, userId: a.user_id, filedBy: a.filed_by, statement, state: a.state, reviewerId: a.reviewer_id, decisionNote: hidden ? null : a.decision_note, createdAt: a.created_at, reviewedAt: a.reviewed_at, decidedAt: a.decided_at };
  }

  private async loadAppeal(p: Principal, ref: string): Promise<AppealRow> {
    const m = /^A-(\d+)$/i.exec(ref);
    const r = await this.s().db('moderation_appeals').where({ tenant_id: p.tenantId }).andWhere(m ? { number: Number(m[1]) } : { id: ref }).first();
    if (!r) throw notFound('Appeal');
    return appealFrom(r);
  }

  /** The appeals a reviewer may see: in their workspaces (or none), newest first. */
  async appeals(p: Principal, state?: AppealRow['state']) {
    const ws = (await this.workspaces(p))!;
    const q = this.s().db('moderation_appeals').where({ tenant_id: p.tenantId });
    if (state) q.andWhere({ state });
    const rows = ((await q.orderBy('created_at', 'desc').limit(500)) as Record<string, unknown>[]).map(appealFrom).filter((a) => !a.workspace_id || ws.includes(a.workspace_id));
    return Promise.all(rows.map((a) => this.appealView(a, p, false)));
  }

  async appealFor(p: Principal, ref: string) {
    const a = await this.loadAppeal(p, ref);
    const reviewer = effectivePermissions(p).has('moderation:review');
    const ws = (await this.workspaces(p))!;
    if (a.user_id !== p.userId && !(reviewer && (!a.workspace_id || ws.includes(a.workspace_id)))) throw notFound('Appeal');
    return this.appealView(a, p);
  }

  /** Who took the decision under appeal: they may not review it (nor may the appellant). */
  private async decidedBy(a: AppealRow): Promise<string | null> {
    const s = this.s();
    if (a.action_id) return ((await s.db('moderation_actions').where({ id: a.action_id }).first('created_by')) as { created_by: string | null } | undefined)?.created_by ?? null;
    return ((await s.db('moderation_sanctions').where({ id: a.sanction_id }).first('created_by')) as { created_by: string | null } | undefined)?.created_by ?? null;
  }

  private async reviewable(p: Principal, a: AppealRow): Promise<void> {
    const ws = (await this.workspaces(p))!;
    if (a.workspace_id && !ws.includes(a.workspace_id)) throw notFound('Appeal');
    if (a.user_id === p.userId) throw forbidden('You cannot review your own appeal.', { step: 'independence' });
    if ((await this.decidedBy(a)) === p.userId) throw forbidden('You took the decision under appeal; another reviewer decides it.', { step: 'independence' });
    if (!clears(p.clearance, a.label)) throw forbidden(`${appealRef(a)} is labelled ${a.label}, above your clearance of ${p.clearance}.`, { step: 'clearance' });
  }

  async startReview(ctx: ModCtx & { principal: Principal }, ref: string) {
    const p = ctx.principal;
    const a = await this.loadAppeal(p, ref);
    await this.reviewable(p, a);
    if (a.state !== 'pending') throw conflict(`${appealRef(a)} is ${a.state}.`);
    const t = Date.now();
    const n = await this.s().db('moderation_appeals').where({ id: a.id, state: 'pending' }).update({ state: 'reviewing', reviewer_id: p.userId, reviewed_at: t });
    if (!n) throw conflict(`${appealRef(a)} was taken by another reviewer.`);
    await this.audit(ctx, 'moderation.appeal.reviewing', { appeal: appealRef(a) }, undefined, a.label);
    return this.appealView({ ...a, state: 'reviewing', reviewer_id: p.userId, reviewed_at: t }, p);
  }

  /**
   * Decides an appeal. Upheld: an action is reversed (the object restored), its flag reopened and the AT-Protocol
   * labels made from that flag negated; a sanction is reversed (the user can sign in again). Every step is audited.
   */
  async decideAppeal(ctx: ModCtx & { principal: Principal }, ref: string, decision: 'upheld' | 'denied', note: string | null) {
    const s = this.s();
    const p = ctx.principal;
    const a = await this.loadAppeal(p, ref);
    await this.reviewable(p, a);
    if (a.state !== 'pending' && a.state !== 'reviewing') throw conflict(`${appealRef(a)} was already ${a.state}.`);
    if (a.state === 'reviewing' && a.reviewer_id !== p.userId) throw conflict(`${appealRef(a)} is being reviewed by someone else.`);
    const t = Date.now();
    const n = await s.db('moderation_appeals').where({ id: a.id }).whereIn('state', ['pending', 'reviewing']).update({ state: decision, reviewer_id: p.userId, decision_note: note?.slice(0, 1000) ?? null, decided_at: t, reviewed_at: a.reviewed_at ?? t });
    if (!n) throw conflict(`${appealRef(a)} was decided meanwhile.`);
    const after: AppealRow = { ...a, state: decision, reviewer_id: p.userId, decision_note: note, decided_at: t };
    const effects: Record<string, unknown> = {};
    if (decision === 'upheld') {
      if (a.action_id) Object.assign(effects, await this.reverseAction(ctx, a));
      if (a.sanction_id) Object.assign(effects, await this.endSanction(ctx, a.sanction_id, 'reversed', `Appeal ${appealRef(a)} upheld`));
    }
    await this.audit(ctx, `moderation.appeal.${decision}`, { appeal: appealRef(a), kind: a.kind, ...(a.action_id ? { action: a.action_id } : { sanction: a.sanction_id }) }, { note: note ?? null, ...effects }, a.label);
    s.bus.publish(TOPICS.poolState, { tenantId: a.tenant_id, perm: 'moderation:review', event: 'moderation.appeals.changed', data: { id: a.id, ref: appealRef(a), state: decision } });
    await this.notice(a.tenant_id, a.user_id, decision === 'upheld' ? { event: `Your appeal ${appealRef(a)} was upheld`, detail: a.kind === 'action' ? 'What was hidden is visible again.' : 'The sanction on your account is withdrawn.', next: note ? `The reviewer wrote: ${note}` : 'Nothing more is needed from you.', route: 'settings' } : { event: `Your appeal ${appealRef(a)} was not upheld`, detail: 'The decision stands.', next: note ? `The reviewer wrote: ${note}` : 'Ask an administrator if you need more detail.', route: 'settings' });
    return { appeal: await this.appealView(after, p), effects };
  }

  private async reverseAction(ctx: ModCtx & { principal: Principal }, a: AppealRow): Promise<Record<string, unknown>> {
    const s = this.s();
    const p = ctx.principal;
    const action = actionFrom(await s.db('moderation_actions').where({ id: a.action_id }).first());
    let restored = false;
    if (action.state === 'applied') {
      const h = this.registry.get(action.object_type);
      const obj = h ? await h.resolve(action.tenant_id, action.object_id) : null;
      if (obj && h?.restore && action.prev_state) restored = await h.restore(obj, action.prev_state);
      await s.db('moderation_actions').where({ id: action.id, state: 'applied' }).update({ state: 'reversed', reversed_by: p.userId, reversed_at: Date.now(), appeal_id: a.id });
      await this.audit(ctx, 'moderation.action.reversed', { action: action.id, object: action.object_type, id: action.object_id.slice(0, 200), appeal: appealRef(a) }, { restored, prevState: action.prev_state }, a.label);
    }
    let flagReopened: string | null = null;
    let labelsNegated: string[] = [];
    if (action.flag_id) {
      const f = await s.guard.flags.get(p.tenantId, action.flag_id).catch(() => null);
      if (f) {
        const queue = f.queue_id ? await this.queue(p.tenantId, f.queue_id).catch(() => null) : null;
        if (f.state !== 'open') {
          await s.guard.flags.reopen(f, p.userId, `Appeal ${appealRef(a)} upheld`, queue?.sla_minutes);
          flagReopened = flagRef(f);
        }
        try {
          labelsNegated = (await s.atproto.negateForFlag({ tenantId: p.tenantId, userId: p.userId, actor: ctx.actor, traceId: ctx.traceId ?? null }, p.tenantId, f.id, `appeal ${appealRef(a)} upheld`)).map((l) => l.label.val);
        } catch (err) {
          s.log.warn({ err, flag: f.id }, 'negating the labels of an upheld appeal failed');
        }
      }
    }
    return { restored, flagReopened, labelsNegated };
  }

  // ---------- B-1904: sanctions ----------

  /** The sanction keeping a user out right now, if any (cached per user; ended sanctions clear the entry). */
  async blocking(tenantId: string, userId: string): Promise<Blocking | null> {
    const s = this.s();
    const b = await s.cache.get<Blocking | null>(tenantId, SANCTIONS_NS, userId, 'short', async () => {
      const rows = ((await s.db('moderation_sanctions').where({ tenant_id: tenantId, user_id: userId, state: 'active' }).whereIn('kind', ['suspend', 'ban'])) as Record<string, unknown>[]).map(sanctionFrom).filter((r) => r.ends_at == null || r.ends_at > Date.now());
      if (!rows.length) return null;
      const top = rows.sort((x, y) => STRENGTH[y.kind] - STRENGTH[x.kind] || (y.ends_at ?? Infinity) - (x.ends_at ?? Infinity))[0]!;
      return { id: top.id, kind: top.kind as Blocking['kind'], endsAt: top.ends_at };
    });
    if (b && b.endsAt != null && b.endsAt <= Date.now()) return null;
    return b;
  }

  private async assertAdmitted(tenantId: string, userId: string): Promise<void> {
    const b = await this.blocking(tenantId, userId);
    if (!b) return;
    await this.audit(this.systemCtx(tenantId), 'moderation.signin.refused', { user: userId, sanction: b.id }, { kind: b.kind, until: b.endsAt });
    throw sanctionRefusal(b);
  }

  private async invalidate(tenantId: string, userId: string): Promise<void> {
    await this.s().cache.invalidate({ tenantId, ns: SANCTIONS_NS, key: userId });
  }

  async sanction(ctx: ModCtx & { principal: Principal }, input: { userId: string; kind: SanctionKind; durationMinutes?: number | undefined; reason: string; flag?: string | undefined }) {
    const s = this.s();
    const p = ctx.principal;
    if (input.userId === p.userId) throw forbidden('You cannot sanction yourself.', { step: 'self' });
    const user = await s.users.get(p.tenantId, input.userId);
    if (!user) throw notFound('User');
    const targetRoles = await s.users.roleIds(user.id);
    // Admins are sanctioned only by a tenant admin, a system admin only by a system admin.
    if (targetRoles.includes('system-admin') && !p.roles.includes('system-admin')) throw forbidden('Only a system admin sanctions a system admin.', { step: 'role' });
    if (rolesRequireMfa(targetRoles, p.tenantId) && !effectivePermissions(p).has('tenant:manage')) throw forbidden('Sanctioning an administrator needs a tenant admin.', { step: 'role' });
    if (input.kind === 'suspend' && !input.durationMinutes) throw new HttpProblem(400, 'Invalid request', 'A suspension needs a duration (durationMinutes).');
    const flag = input.flag ? await s.guard.flags.get(p.tenantId, input.flag) : null;
    const t = Date.now();
    const row: SanctionRow = { id: ulid(), tenant_id: p.tenantId, user_id: user.id, kind: input.kind, reason: input.reason.slice(0, 1000), flag_id: flag?.id ?? null, state: 'active', starts_at: t, ends_at: input.kind === 'warn' ? (input.durationMinutes ? t + input.durationMinutes * 60_000 : null) : input.durationMinutes ? t + input.durationMinutes * 60_000 : null, created_by: p.userId, created_at: t, ended_by: null, ended_at: null, end_reason: null };
    await s.db('moderation_sanctions').insert(row);
    let sessionsRevoked = 0;
    if (input.kind !== 'warn') {
      await this.invalidate(p.tenantId, user.id);
      // Open sessions end now (their sockets close over the bus); API keys and tokens are refused per request.
      sessionsRevoked = await s.sessions.revokeAllForUser(user.id);
    }
    await this.audit(ctx, 'moderation.sanction.created', { sanction: row.id, user: user.id, username: user.username, ...(flag ? { flag: flagRef(flag) } : {}) }, { kind: row.kind, endsAt: row.ends_at, reason: row.reason, sessionsRevoked }, flag?.label);
    const until = row.ends_at ? new Date(row.ends_at).toISOString() : null;
    await this.notice(p.tenantId, user.id, {
      event: row.kind === 'warn' ? 'Your account received a warning' : row.kind === 'suspend' ? `Your account is suspended until ${until}` : `Your account is banned${until ? ` until ${until}` : ''}`,
      detail: `Reason: ${row.reason}`,
      next: row.kind === 'warn' ? `You can appeal it (sanction ${row.id}).` : `You cannot sign in${until ? ' until then' : ''}. To appeal, reply to an administrator of your organisation quoting sanction ${row.id}; a reviewer records the appeal for you.`,
      route: 'settings'
    });
    return { ...sanctionView(row), sessionsRevoked };
  }

  async sanctions(p: Principal, q: { userId?: string | undefined; state?: SanctionRow['state'] | undefined }) {
    const qb = this.s().db('moderation_sanctions').where({ tenant_id: p.tenantId });
    if (q.userId) qb.andWhere({ user_id: q.userId });
    if (q.state) qb.andWhere({ state: q.state });
    return ((await qb.orderBy('created_at', 'desc').limit(500)) as Record<string, unknown>[]).map(sanctionFrom).map(sanctionView);
  }

  async lift(ctx: ModCtx & { principal: Principal }, id: string, reason: string | null) {
    const r = await this.s().db('moderation_sanctions').where({ tenant_id: ctx.tenantId, id }).first();
    if (!r) throw notFound('Sanction');
    if (sanctionFrom(r).state !== 'active') throw conflict(`That sanction is ${sanctionFrom(r).state}.`);
    await this.endSanction(ctx, id, 'lifted', reason ?? 'Lifted by a moderator');
    return sanctionView(sanctionFrom(await this.s().db('moderation_sanctions').where({ id }).first()));
  }

  private async endSanction(ctx: ModCtx, id: string, state: 'lifted' | 'reversed' | 'expired', reason: string): Promise<Record<string, unknown>> {
    const s = this.s();
    const row = sanctionFrom(await s.db('moderation_sanctions').where({ id }).first());
    const n = await s.db('moderation_sanctions').where({ id, state: 'active' }).update({ state, ended_by: ctx.principal?.userId ?? null, ended_at: Date.now(), end_reason: reason.slice(0, 500) });
    if (!n) return { sanctionEnded: false };
    await this.invalidate(row.tenant_id, row.user_id);
    await this.audit(ctx, `moderation.sanction.${state}`, { sanction: row.id, user: row.user_id }, { kind: row.kind, reason });
    if (state !== 'reversed') await this.notice(row.tenant_id, row.user_id, { event: row.kind === 'warn' ? 'A warning on your account ended' : `The ${row.kind === 'ban' ? 'ban' : 'suspension'} of your account ${state === 'expired' ? 'has ended' : 'was lifted'}`, detail: row.kind === 'warn' ? 'Nothing more is needed from you.' : 'You can sign in again.', next: state === 'lifted' ? `Reason: ${reason}` : 'Nothing more is needed from you.', route: 'settings' });
    return { sanctionEnded: true };
  }

  /** What the signed-in person sees of moderation: their sanctions, actions on their objects and their appeals. */
  async mine(p: Principal) {
    const s = this.s();
    const sanctions = ((await s.db('moderation_sanctions').where({ tenant_id: p.tenantId, user_id: p.userId }).orderBy('created_at', 'desc').limit(100)) as Record<string, unknown>[]).map(sanctionFrom).map(sanctionView);
    const actions = ((await s.db('moderation_actions').where({ tenant_id: p.tenantId, owner_id: p.userId }).orderBy('created_at', 'desc').limit(100)) as Record<string, unknown>[]).map(actionFrom).map(actionView);
    const appeals = await Promise.all(((await s.db('moderation_appeals').where({ tenant_id: p.tenantId, user_id: p.userId }).orderBy('created_at', 'desc').limit(100)) as Record<string, unknown>[]).map(appealFrom).map((a) => this.appealView(a, p)));
    return { sanctions, actions, appeals };
  }

  // ---------- B-1905: routed queues, SLA and the dead-letter queue ----------

  async queues(tenantId: string): Promise<QueueRow[]> {
    return ((await this.s().db('moderation_queues').where({ tenant_id: tenantId }).orderBy([{ column: 'priority' }, { column: 'name' }])) as Record<string, unknown>[]).map(queueFrom);
  }

  async queue(tenantId: string, id: string): Promise<QueueRow> {
    const r = await this.s().db('moderation_queues').where({ tenant_id: tenantId, id }).first();
    if (!r) throw notFound('Queue');
    return queueFrom(r);
  }

  async saveQueue(ctx: ModCtx & { principal: Principal }, id: string | null, input: { name: string; workspaceId?: string | null | undefined; rules?: string[] | null | undefined; labels?: Label[] | null | undefined; kinds?: string[] | null | undefined; priority?: number | undefined; slaMinutes: number; escalateTo: EscalationLevel; escalationSlaMinutes?: number | undefined; enabled?: boolean | undefined }) {
    const s = this.s();
    const p = ctx.principal;
    if (input.workspaceId) {
      const ws = (await this.workspaces(p))!;
      if (!ws.includes(input.workspaceId)) throw notFound('Workspace');
    }
    if (input.escalateTo === 'platform' && !effectivePermissions(p).has('platform:manage') && !effectivePermissions(p).has('tenant:manage')) throw forbidden('Escalating to the platform needs a tenant admin.', { step: 'permission' });
    const t = Date.now();
    const creating = !id;
    const fields = { name: input.name, workspace_id: input.workspaceId ?? null, rules: input.rules?.length ? JSON.stringify(input.rules) : null, labels: input.labels?.length ? JSON.stringify(input.labels) : null, kinds: input.kinds?.length ? JSON.stringify(input.kinds) : null, priority: input.priority ?? 100, sla_minutes: input.slaMinutes, escalate_to: input.escalateTo, escalation_sla_minutes: input.escalationSlaMinutes ?? 60, enabled: input.enabled ?? true, updated_at: t };
    try {
      if (id) {
        await this.queue(p.tenantId, id);
        await s.db('moderation_queues').where({ tenant_id: p.tenantId, id }).update(fields);
      } else {
        id = ulid();
        await s.db('moderation_queues').insert({ id, tenant_id: p.tenantId, ...fields, created_by: p.userId, created_at: t });
      }
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A queue named ${input.name} already exists.`);
      throw err;
    }
    const q = await this.queue(p.tenantId, id);
    await this.audit(ctx, creating ? 'moderation.queue.created' : 'moderation.queue.updated', { queue: q.id, name: q.name }, { workspace: q.workspace_id, rules: q.rules, labels: q.labels, kinds: q.kinds, priority: q.priority, slaMinutes: q.sla_minutes, escalateTo: q.escalate_to, enabled: q.enabled });
    return q;
  }

  async deleteQueue(ctx: ModCtx & { principal: Principal }, id: string): Promise<void> {
    const q = await this.queue(ctx.tenantId, id);
    await this.s().db('moderation_queues').where({ id: q.id }).delete();
    await this.s().db('guard_flags').where({ tenant_id: ctx.tenantId, queue_id: q.id }).update({ queue_id: null });
    await this.audit(ctx, 'moderation.queue.deleted', { queue: q.id, name: q.name });
  }

  /** Routes a new flag to the first enabled queue it matches (by priority), whose SLA then sets its timer. */
  async route(f: FlagRow): Promise<void> {
    const q = (await this.queues(f.tenant_id)).find((x) => x.enabled && matches(x, f));
    if (!q) return;
    await this.s().db('guard_flags').where({ id: f.id }).update({ queue_id: q.id, sla_minutes: q.sla_minutes, due_at: f.created_at + q.sla_minutes * 60_000 });
  }

  /** A queue's open flags as the reviewer may see them, with its counts. */
  async queueFlags(p: Principal, id: string) {
    const s = this.s();
    const q = await this.queue(p.tenantId, id);
    const ws = (await this.workspaces(p))!;
    const rows = ((await s.db('guard_flags').where({ tenant_id: p.tenantId, queue_id: q.id, state: 'open' }).orderBy('due_at').limit(1000)) as Record<string, unknown>[]).map(flagFromRow).filter((f) => s.guard.flags.reviewable(f, p, ws));
    const now = Date.now();
    return { queue: queueView(q), open: rows.length, overdue: rows.filter((f) => f.due_at < now).length, escalated: rows.filter((f) => f.escalated_to).length, items: rows.map((f) => {
      const v = s.guard.flags.view(f, p);
      // 1.5.0 (B-3405): the object the flag points at, so the console can name it and offer "Hide object" only when a
      // registered type can be hidden (withheld above the reviewer's clearance, like the rest of the flag).
      const h = f.source_kind ? this.registry.get(f.source_kind) : undefined;
      const object = v.restricted || !f.source_kind || !f.source_id ? null : { type: f.source_kind, id: f.source_id, hideable: !!h?.hide && f.kind !== 'hold' };
      return { ...v, queueId: f.queue_id ?? null, escalatedAt: f.escalated_at ?? null, object };
    }) };
  }

  /** The sweep (B-1904, B-1905): routed flags past their SLA escalate; sanctions past their end expire. */
  async sweep(tenantId: string): Promise<{ escalated: number; expired: number }> {
    const s = this.s();
    const now = Date.now();
    const queues = new Map((await this.queues(tenantId)).map((q) => [q.id, q]));
    let escalated = 0;
    if (queues.size) {
      const due = ((await s.db('guard_flags').where({ tenant_id: tenantId, state: 'open' }).whereNotNull('queue_id').whereNull('escalated_to').andWhere('due_at', '<', now).limit(200)) as Record<string, unknown>[]).map(flagFromRow);
      for (const f of due) {
        const q = queues.get(f.queue_id!);
        if (!q) continue;
        const after = await s.guard.flags.escalateBySystem(f, q.escalate_to, q.escalation_sla_minutes, `past its ${q.sla_minutes} min timer in ${q.name}`);
        if (after === f) continue;
        escalated++;
        await this.audit(this.systemCtx(tenantId), 'moderation.queue.escalated', { flag: flagRef(f), queue: q.id, name: q.name }, { to: q.escalate_to, overdueMinutes: Math.round((now - f.due_at) / 60_000) }, f.label);
      }
    }
    const ending = ((await s.db('moderation_sanctions').where({ tenant_id: tenantId, state: 'active' }).whereNotNull('ends_at').andWhere('ends_at', '<=', now).limit(200)) as Record<string, unknown>[]).map(sanctionFrom);
    for (const r of ending) await this.endSanction(this.systemCtx(tenantId), r.id, 'expired', 'Its duration ended');
    return { escalated, expired: ending.length };
  }

  private async deadLetter(e: JobProgressEvent): Promise<void> {
    const s = this.s();
    const job = (await s.db('jobs').where({ id: e.id }).first()) as Record<string, unknown> | undefined;
    if (!job) return;
    try {
      await s.db('moderation_dead_letters').insert({ id: ulid(), tenant_id: e.tenantId, job_id: e.id, type: e.type, payload: typeof job.payload === 'string' ? job.payload : JSON.stringify(job.payload ?? {}), error: (e.error ?? '').slice(0, 1000) || null, attempts: Number(job.attempts ?? 0), state: 'open', failed_at: Date.now(), redriven_by: null, redriven_at: null, redrive_job_id: null });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      return;
    }
    await this.audit(this.systemCtx(e.tenantId), 'moderation.job.dead_lettered', { job: e.id, type: e.type }, { error: (e.error ?? '').slice(0, 300), attempts: Number(job.attempts ?? 0) });
  }

  async deadLetters(tenantId: string, state?: 'open' | 'redriven') {
    const q = this.s().db('moderation_dead_letters').where({ tenant_id: tenantId });
    if (state) q.andWhere({ state });
    return ((await q.orderBy('failed_at', 'desc').limit(500)) as Record<string, unknown>[]).map(deadLetterView);
  }

  async redrive(ctx: ModCtx & { principal: Principal }, id: string) {
    const s = this.s();
    const r = (await s.db('moderation_dead_letters').where({ tenant_id: ctx.tenantId, id }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Dead letter');
    if (r.state !== 'open') throw conflict('That job was already redriven.');
    const job = await s.jobs.enqueue({ tenantId: ctx.tenantId, type: String(r.type), payload: json<Record<string, unknown>>(r.payload, {}), createdBy: ctx.principal.userId, maxAttempts: 3 });
    const n = await s.db('moderation_dead_letters').where({ id, state: 'open' }).update({ state: 'redriven', redriven_by: ctx.principal.userId, redriven_at: Date.now(), redrive_job_id: job.id });
    if (!n) throw conflict('That job was already redriven.');
    await this.audit(ctx, 'moderation.job.redriven', { deadLetter: id, job: String(r.job_id), type: String(r.type) }, { newJob: job.id });
    return { ...deadLetterView({ ...r, state: 'redriven', redriven_by: ctx.principal.userId, redriven_at: Date.now(), redrive_job_id: job.id }), jobId: job.id };
  }

  // ---------- B-1906: external providers ----------

  /** Whether a zone reaches outside the site: an allow-list with a public range or the external zone in it. */
  async zoneHasEgress(zone: string): Promise<{ ok: boolean; why?: string }> {
    const s = this.s();
    if (s.cfg.ZONES_AIR_GAPPED) return { ok: false, why: 'This deployment is air-gapped (ZONES_AIR_GAPPED): no zone has egress.' };
    const zones = await s.zones.current();
    const z = zones.get(zone);
    if (!z) return { ok: false, why: `Zone ${zone} is not defined.` };
    if (z.spec.egress.mode !== 'allow-list') return { ok: false, why: `Zone ${zone} denies egress.` };
    const out = z.spec.egress.allow.some((t) => (t.kind === 'cidr' && !isPrivateCidr(t.cidr)) || (t.kind === 'zone' && (t.zone === EXTERNAL_ZONE || zones.get(t.zone)?.spec.trust === 'external')));
    return out ? { ok: true } : { ok: false, why: `Zone ${zone} only reaches other zones and private ranges.` };
  }

  private async assertProviderAllowed(zone: string): Promise<void> {
    if (!this.s().cfg.MODERATION_EXTERNAL_PROVIDERS) throw forbidden('External moderation providers are off (MODERATION_EXTERNAL_PROVIDERS). Content would leave the site; an operator turns them on.', { step: 'disabled' });
    const z = await this.zoneHasEgress(zone);
    if (!z.ok) throw forbidden(`An external provider runs only in a zone with egress. ${z.why ?? ''}`.trim(), { step: 'zone', zone });
  }

  async providerList(tenantId: string): Promise<ProviderRow[]> {
    return ((await this.s().db('moderation_providers').where({ tenant_id: tenantId }).orderBy('name')) as Record<string, unknown>[]).map(providerFrom);
  }

  async provider(tenantId: string, id: string): Promise<ProviderRow> {
    const r = await this.s().db('moderation_providers').where({ tenant_id: tenantId, id }).first();
    if (!r) throw notFound('Provider');
    return providerFrom(r);
  }

  async saveProvider(ctx: ModCtx & { principal: Principal }, id: string | null, input: { name?: string | undefined; kind?: ProviderKind | undefined; url?: string | undefined; secret?: string | null | undefined; zone?: string | undefined; mode?: 'shadow' | 'enforce' | undefined; enabled?: boolean | undefined; objectTypes?: string[] | null | undefined; threshold?: number | undefined }) {
    const s = this.s();
    const p = ctx.principal;
    const before = id ? await this.provider(p.tenantId, id) : null;
    const zone = input.zone ?? before?.zone;
    if (!zone) throw new HttpProblem(400, 'Invalid request', 'Name the zone the provider is reached from.');
    await this.assertProviderAllowed(zone);
    const url = input.url ?? before?.url;
    if (!url) throw new HttpProblem(400, 'Invalid request', 'Give the provider URL.');
    if (input.url) {
      try {
        await checkServiceUrl(input.url, servicePolicy(s.cfg));
      } catch (err) {
        if (err instanceof ServiceUrlRefused) throw new HttpProblem(422, 'Address refused', err.message, { extensions: { step: 'url' } });
        throw err;
      }
    }
    const t = Date.now();
    const rowId = id ?? ulid();
    const fields: Record<string, unknown> = { updated_at: t, zone, url };
    if (input.name !== undefined) fields.name = input.name;
    if (input.kind !== undefined) fields.kind = input.kind;
    if (input.mode !== undefined) fields.mode = input.mode;
    if (input.enabled !== undefined) fields.enabled = input.enabled;
    if (input.objectTypes !== undefined) fields.object_types = input.objectTypes?.length ? JSON.stringify(input.objectTypes) : null;
    if (input.threshold !== undefined) fields.threshold = input.threshold;
    if (input.secret !== undefined) fields.secret = input.secret ? await s.keys.seal(p.tenantId, input.secret, `modprov:${rowId}`) : null;
    try {
      if (before) await s.db('moderation_providers').where({ id: before.id }).update(fields);
      else await s.db('moderation_providers').insert({ id: rowId, tenant_id: p.tenantId, name: input.name, kind: input.kind ?? 'json', mode: input.mode ?? 'shadow', enabled: input.enabled ?? false, object_types: null, threshold: 0.5, secret: null, ...fields, created_by: p.userId, created_at: t });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A provider named ${input.name} already exists.`);
      throw err;
    }
    const after = await this.provider(p.tenantId, rowId);
    await this.audit(ctx, before ? 'moderation.provider.updated' : 'moderation.provider.created', { provider: after.id, name: after.name }, { kind: after.kind, host: new URL(after.url).host, zone: after.zone, mode: after.mode, enabled: after.enabled, objectTypes: after.object_types, threshold: after.threshold, secretChanged: input.secret !== undefined });
    return after;
  }

  async deleteProvider(ctx: ModCtx & { principal: Principal }, id: string): Promise<void> {
    const pr = await this.provider(ctx.tenantId, id);
    await this.s().db('moderation_providers').where({ id: pr.id }).delete();
    await this.audit(ctx, 'moderation.provider.deleted', { provider: pr.id, name: pr.name });
  }

  async verdicts(tenantId: string, providerId: string) {
    const pr = await this.provider(tenantId, providerId);
    const rows = (await this.s().db('moderation_provider_verdicts').where({ tenant_id: tenantId, provider_id: pr.id }).orderBy('created_at', 'desc').limit(200)) as Record<string, unknown>[];
    return rows.map((r) => ({ id: String(r.id), objectType: String(r.object_type), objectId: String(r.object_id), mode: String(r.mode), flagged: bool(r.flagged), categories: json<string[]>(r.categories, []), score: r.score == null ? null : Number(r.score), acted: bool(r.acted), flagId: (r.flag_id as string | null) ?? null, latencyMs: numOrNull(r.latency_ms), createdAt: num(r.created_at) }));
  }

  /** Queues a provider job for each enabled provider that takes this type (only when providers are on). */
  private async queueProviders(ctx: ModCtx, obj: ModeratedObject, text: string, checkpoint: Checkpoint, subject: string | null): Promise<{ id: string; mode: string; jobId: string }[]> {
    const s = this.s();
    if (!s.cfg.MODERATION_EXTERNAL_PROVIDERS || !text) return [];
    const list = (await this.providerList(ctx.tenantId)).filter((p) => p.enabled && (!p.object_types || p.object_types.includes(obj.type)));
    const out: { id: string; mode: string; jobId: string }[] = [];
    for (const pr of list) {
      const nonce = randomBytes(12).toString('hex');
      const sealed = await s.keys.seal(ctx.tenantId, text, `modjob:${nonce}`);
      const job = await s.jobs.enqueue({ tenantId: ctx.tenantId, type: PROVIDER_JOB, payload: { providerId: pr.id, objectType: obj.type, objectId: obj.id, workspaceId: obj.workspaceId, label: obj.label, checkpoint, subject, nonce, sealed }, createdBy: ctx.principal?.userId ?? null, maxAttempts: 3 });
      out.push({ id: pr.id, mode: pr.mode, jobId: job.id });
    }
    return out;
  }

  /**
   * One provider call. Shadow: the verdict is recorded and nothing else happens. Enforce: a flagged verdict files (or
   * reuses) the object's flag and hides it when its type can be hidden. A failed call throws, so the job retries and
   * then lands in the dead-letter queue.
   */
  private async providerJob(tenantId: string, p: Record<string, unknown>): Promise<unknown> {
    const s = this.s();
    const pr = (await s.db('moderation_providers').where({ tenant_id: tenantId, id: String(p.providerId ?? '') }).first()) as Record<string, unknown> | undefined;
    if (!pr) return { skipped: 'the provider was removed' };
    const provider = providerFrom(pr);
    if (!provider.enabled || !s.cfg.MODERATION_EXTERNAL_PROVIDERS) return { skipped: 'the provider is off' };
    const zone = await this.zoneHasEgress(provider.zone);
    if (!zone.ok) return { skipped: zone.why };
    const type = String(p.objectType);
    const id = String(p.objectId);
    const text = await s.keys.open(tenantId, String(p.sealed), `modjob:${String(p.nonce)}`);
    const secret = provider.secret ? await s.keys.open(tenantId, provider.secret, `modprov:${provider.id}`) : null;
    const t0 = Date.now();
    const v = await this.providers.classify({ kind: provider.kind, url: provider.url, secret, text, objectType: type, threshold: provider.threshold });
    const latency = Date.now() - t0;
    const verdictId = ulid();
    let flagId: string | null = null;
    let acted = false;
    const ctx = this.systemCtx(tenantId, `moderation-provider:${provider.name}`);
    if (provider.mode === 'enforce' && v.flagged) {
      const h = this.registry.get(type);
      const obj: ModeratedObject = (h ? await h.resolve(tenantId, id) : null) ?? { type, id, tenantId, workspaceId: (p.workspaceId as string | null) ?? null, label: isLabel(p.label) ? p.label : 'internal', ownerId: null, state: null };
      const row = await this.objectRow(tenantId, type, id, obj.workspaceId);
      const checkpoint = (typeof p.checkpoint === 'string' ? p.checkpoint : 'user-input') as Checkpoint;
      const { flag } = await this.flagFor(row, sha(text), () => s.guard.flags.create({ tenantId, workspaceId: obj.workspaceId, kind: 'rule', checkpoint, ruleName: `Provider ${provider.name}`, action: 'block', severity: 'high', label: obj.label, text, note: `External provider ${provider.name} flagged this${v.categories.length ? ` (${v.categories.join(', ')})` : ''}${v.score != null ? `, score ${v.score.toFixed(2)}` : ''}.`, actor: { user: null, name: `Provider ${provider.name}`, via: 'moderation' }, source: { kind: type, id: sourceIdFor(type, id) }, conversationId: obj.conversationId ?? null }));
      flagId = flag.id;
      acted = true;
      if (h?.hide && obj.state !== 'hidden') await this.applyHide(ctx, obj, flag, 'provider', `Flagged by the external provider ${provider.name}`).catch(() => null);
      await this.audit(ctx, 'moderation.provider.enforced', { provider: provider.id, object: type, id: id.slice(0, 200), flag: flagRef(flag) }, { categories: v.categories, score: v.score }, obj.label);
    }
    await s.db('moderation_provider_verdicts').insert({ id: verdictId, tenant_id: tenantId, provider_id: provider.id, object_type: type, object_id: id, object_hash: objectHash(type, id), mode: provider.mode, flagged: v.flagged, categories: JSON.stringify(v.categories), score: v.score, acted, flag_id: flagId, latency_ms: latency, created_at: Date.now() });
    return { verdict: verdictId, mode: provider.mode, flagged: v.flagged, acted };
  }

  // ---------- B-1907: notices ----------

  private async notice(tenantId: string, userId: string, n: { event: string; detail: string; next: string; route: string }): Promise<void> {
    const s = this.s();
    try {
      await s.notifications.notify({ tenantId, userIds: [userId], kind: 'moderation', title: n.event, body: n.detail, route: n.route, label: 'internal', emailTemplate: { name: 'moderation-notice', vars: { event: n.event, detail: n.detail, next: n.next, time: new Date().toISOString() } } });
    } catch (err) {
      s.log.warn({ err, user: userId }, 'moderation notice not sent');
    }
  }
}

function topFinding(d: GuardDecision): GuardFinding | undefined {
  return d.findings.filter((f) => f.stage === 'enforce').sort((a, b) => actionRank(b.action) - actionRank(a.action))[0];
}

function matches(q: QueueRow, f: FlagRow): boolean {
  if (q.workspace_id && q.workspace_id !== f.workspace_id) return false;
  if (q.rules && !q.rules.some((r) => r === f.rule_id || r === f.rule_name)) return false;
  if (q.labels && !q.labels.includes(f.label)) return false;
  if (q.kinds && !q.kinds.some((k) => k === f.kind || k === f.source_kind || k === f.checkpoint)) return false;
  return true;
}

const typeName = (t: string) => t.replace(/-/g, ' ');

export const actionView = (a: ActionRow) => ({ id: a.id, objectType: a.object_type, objectId: a.object_id, workspaceId: a.workspace_id, ownerId: a.owner_id, flagId: a.flag_id, action: a.action, state: a.state, source: a.source, createdBy: a.created_by, reason: a.reason, createdAt: a.created_at, reversedBy: a.reversed_by, reversedAt: a.reversed_at, appealId: a.appeal_id });

export const sanctionView = (r: SanctionRow) => ({ id: r.id, userId: r.user_id, kind: r.kind, reason: r.reason, flagId: r.flag_id, state: r.state, startsAt: r.starts_at, endsAt: r.ends_at, createdBy: r.created_by, createdAt: r.created_at, endedBy: r.ended_by, endedAt: r.ended_at, endReason: r.end_reason });

export const queueView = (q: QueueRow) => ({ id: q.id, name: q.name, workspaceId: q.workspace_id, rules: q.rules, labels: q.labels, kinds: q.kinds, priority: q.priority, slaMinutes: q.sla_minutes, escalateTo: q.escalate_to, escalationSlaMinutes: q.escalation_sla_minutes, enabled: q.enabled, createdAt: q.created_at, updatedAt: q.updated_at });

export const providerView = (p: ProviderRow) => ({ id: p.id, name: p.name, kind: p.kind, url: p.url, hasSecret: !!p.secret, zone: p.zone, mode: p.mode, enabled: p.enabled, objectTypes: p.object_types, threshold: p.threshold, createdAt: p.created_at, updatedAt: p.updated_at });

const deadLetterView = (r: Record<string, unknown>) => ({ id: String(r.id), jobId: String(r.job_id), type: String(r.type), error: (r.error as string | null) ?? null, attempts: num(r.attempts), state: String(r.state), failedAt: num(r.failed_at), redrivenBy: (r.redriven_by as string | null) ?? null, redrivenAt: numOrNull(r.redriven_at), redriveJobId: (r.redrive_job_id as string | null) ?? null });

