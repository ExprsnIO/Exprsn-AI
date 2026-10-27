import { ulid } from 'ulid';
import { actorFrom } from '../audit/chain.js';
import { clears, isLabel, type Label } from '../authz/labels.js';
import { rolesGranting } from '../authz/permissions.js';
import type { Principal } from '../authz/policy.js';
import { flagRef, type FlagRow } from '../guardrails/flags.js';
import type { GuardDecision, GuardFinding } from '../guardrails/types.js';
import { loadPrincipal, workspacesFor } from '../http/middleware.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';

/*
 * 1.7.0, Sprint 41 (B-9401 to B-9404): held writes. A message, an edit, a group post or a feed comment that the
 * `user-input` guardrail holds is no longer refused. It waits, seen by its sender only as "held for review", for one
 * of two things:
 *
 * - `review`: a rule asked for a reviewer (`require-approval` in enforce). A hold flag is filed in the review queue
 *   (routed to a moderation queue like any flag). A reviewer other than the sender accepts it, which delivers it with
 *   its original time, or rejects it, which tells the sender.
 * - `unavailable`: every finding that held it is a model-backed rule that could not run (the guard model or a
 *   classifier is down, and the rule fails closed). No flag is filed. The re-screen job checks it again every
 *   HELD_RESCREEN_SECONDS as its sender and, on a fresh verdict, delivers it, refuses it, or turns it into a `review`
 *   hold. Nothing leaves this state without a fresh verdict; after HELD_OUTAGE_EXPIRE_HOURS it is refused.
 *
 * A new feed post a rule holds for a reviewer keeps its own queue entry from 1.4.0 (B-2704, a flag on the post itself);
 * it comes here, as `feed-post`, only when the hold is from a check that could not run.
 *
 * A `block` verdict still refuses at once. Each domain registers a handler for its kinds: it makes the write live
 * (compare-and-set on its own table), discards it, re-screens it and gives the reviewer its context. The row here
 * moves once from `held` (compare-and-set), so a concurrent accept, re-screen and withdraw deliver at most once.
 *
 * Bounds, so an outage or a flood cannot pile up silently: one author has at most HELD_MAX_PER_AUTHOR waiting, a
 * tenant at most HELD_OUTAGE_MAX_PER_TENANT waiting on an unavailable check; past either, the write is refused with
 * a 422 as before 1.7.0. The first outage hold in an hour tells the tenant's reviewers, and the count shows on the
 * Moderation screen (`GET /api/moderation/held/summary`).
 */

export const HELD_WRITE = 'held-write';
export const HELD_RESCREEN_JOB = 'moderation.held.rescreen';
export const HELD_PURGE_JOB = 'moderation.held.purge';

export const HELD_KINDS = ['dm-message', 'dm-edit', 'group-post', 'feed-comment', 'feed-post', 'feed-post-edit'] as const;
export type HeldKind = (typeof HELD_KINDS)[number];
export type HeldReason = 'review' | 'unavailable';
export type HeldState = 'held' | 'delivered' | 'rejected' | 'withdrawn';

export interface HeldRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  kind: HeldKind;
  object_id: string;
  scope_id: string;
  author_id: string;
  label: Label;
  body: string | null;
  reason: HeldReason;
  state: HeldState;
  rule_name: string | null;
  flag_id: string | null;
  attempts: number;
  screened_at: number | null;
  decided_by: string | null;
  decided_at: number | null;
  note: string | null;
  created_at: number;
}

/** What a domain says about one of its held writes, for a reviewer. */
export interface HeldContext {
  /** Where it was written, in words ("A direct conversation", "The group Robotics"). */
  place: string;
  /** The console route of that place, for the sender's notices. */
  route: string;
  /** What surrounds it, oldest first: the reviewer sees the text only of entries at or below their clearance. */
  items: { id: string; authorId: string; authorName: string | null; text: string | null; label: Label; createdAt: number }[];
}

export interface HeldHandler {
  kinds: readonly HeldKind[];
  /** The held text (opened): the object's own for a new write, the row's for an edit. */
  text(h: HeldRow): Promise<string | null>;
  /**
   * Makes the write live, exactly once (a compare-and-set on the domain's own row). `text` is what to store when the
   * re-screen redacted it; null keeps the held text. Returns false when the object is gone or no longer waits.
   */
  deliver(h: HeldRow, text: string | null): Promise<boolean>;
  /** Removes what waited: a rejected new write stays for its sender as rejected, a withdrawn one is deleted. */
  discard(h: HeldRow, why: 'rejected' | 'withdrawn'): Promise<void>;
  /** Screens the held text again as its author. Null when the place it was written in is gone or closed to them. */
  rescreen(h: HeldRow, author: Principal, text: string): Promise<GuardDecision | null>;
  context(h: HeldRow): Promise<HeldContext>;
}

const KIND_WORDS: Record<HeldKind, string> = { 'dm-message': 'message', 'dm-edit': 'edit of a message', 'group-post': 'group post', 'feed-comment': 'comment', 'feed-post': 'post', 'feed-post-edit': 'edit of a post' };

const heldFrom = (r: Record<string, unknown>): HeldRow => ({ ...(r as unknown as HeldRow), label: isLabel(r.label) ? r.label : 'internal', attempts: Number(r.attempts ?? 0), screened_at: r.screened_at == null ? null : Number(r.screened_at), decided_at: r.decided_at == null ? null : Number(r.decided_at), created_at: Number(r.created_at) });

const enforcedHolds = (d: GuardDecision): GuardFinding[] => d.findings.filter((f) => f.stage === 'enforce' && f.action === 'require-approval');
const unavailable = (f: GuardFinding): boolean => !!f.detail?.startsWith('unavailable:');

/**
 * Why a `require-approval` verdict may wait: `review` when a rule that ran asked for a reviewer, `unavailable` when
 * only checks that could not run held it. Null for any other verdict.
 */
export function holdReason(d: GuardDecision): HeldReason | null {
  if (d.action !== 'require-approval') return null;
  const holds = enforcedHolds(d);
  if (!holds.length) return null;
  return holds.some((f) => !unavailable(f)) ? 'review' : 'unavailable';
}

/** The 422 a write gets when the guardrail refuses it (a block, or a hold that may not wait). */
export function refusal(d: GuardDecision, what: string, step = 'guardrails'): HttpProblem {
  const rules = [...new Set(d.findings.filter((f) => f.stage === 'enforce' && f.action === d.action).map((f) => f.ruleName))];
  return new HttpProblem(422, d.action === 'block' ? 'Blocked by guardrails' : 'Held by guardrails', d.reason ?? `The ${what} was refused by a guardrail rule.`, { extensions: { step, action: d.action, rules } });
}

export interface HoldInput {
  p: Principal;
  ip: string | null;
  traceId?: string | null | undefined;
  kind: HeldKind;
  objectId: string;
  scopeId: string;
  workspaceId: string | null;
  label: Label;
  /** The screened text, as it will be delivered. */
  text: string;
  /** Sealed here for an edit; a new write keeps its text in its own row. */
  storeText: boolean;
  decision: GuardDecision;
  via: string;
}

export class HeldWrites {
  private readonly handlers = new Map<HeldKind, HeldHandler>();

  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  register(h: HeldHandler): void {
    for (const k of h.kinds) this.handlers.set(k, h);
  }

  private handler(kind: HeldKind): HeldHandler {
    const h = this.handlers.get(kind);
    if (!h) throw new Error(`No handler for held ${kind}`);
    return h;
  }

  registerJobs(): void {
    const s = this.s();
    s.jobs.register(HELD_RESCREEN_JOB, async (payload) => this.rescreen(String(payload.tenantId)));
    s.jobs.register(HELD_PURGE_JOB, async (payload) => this.purge(String(payload.tenantId)));
  }

  schedule(): void {
    const s = this.s();
    // Only tenants with something waiting on an unavailable check get a re-screen job.
    s.scheduler.every(HELD_RESCREEN_JOB, s.cfg.HELD_RESCREEN_SECONDS * 1000, async () => {
      const rows = (await this.db('held_writes').where({ state: 'held', reason: 'unavailable' }).distinct('tenant_id')) as { tenant_id: string }[];
      return rows.map((r) => ({ tenantId: r.tenant_id, payload: { tenantId: r.tenant_id } }));
    });
    s.scheduler.every(HELD_PURGE_JOB, 6 * 3_600_000, async () => (await s.tenants.list()).filter((t) => t.state === 'active').map((t) => ({ tenantId: t.id, payload: { tenantId: t.id } })));
  }

  private async count(q: { tenant_id: string; state: HeldState; reason?: HeldReason; author_id?: string }): Promise<number> {
    return Number(((await this.db('held_writes').where(q).count({ n: '*' }).first()) as { n: number | string } | undefined)?.n ?? 0);
  }

  /** Is an edit of this object waiting? (One at a time: a second edit is refused until the first is decided.) */
  async pendingFor(objectId: string, kind: HeldKind): Promise<HeldRow | null> {
    const r = await this.db('held_writes').where({ object_id: objectId, kind, state: 'held' }).first();
    return r ? heldFrom(r) : null;
  }

  /** The waiting rows of these objects, for the sender's own view. */
  async waiting(tenantId: string, objectIds: string[]): Promise<Map<string, HeldRow>> {
    const out = new Map<string, HeldRow>();
    for (let i = 0; i < objectIds.length; i += 500) {
      const rows = ((await this.db('held_writes').where({ tenant_id: tenantId }).whereIn('object_id', objectIds.slice(i, i + 500)).whereIn('state', ['held', 'rejected']).orderBy('created_at')) as Record<string, unknown>[]).map(heldFrom);
      for (const r of rows) if (r.state === 'held' || !out.has(r.object_id)) out.set(r.object_id, r);
    }
    return out;
  }

  /** What the sender is shown about a waiting or refused write of theirs. */
  senderView(h: HeldRow) {
    return { id: h.id, kind: h.kind, state: h.state, reason: h.reason, note: h.state === 'rejected' ? h.note : null, since: h.created_at };
  }

  /**
   * Files a held write. Refuses (422, as before 1.7.0) when the author or the tenant has too many waiting. The caller
   * has already stored a new object in the state `held`; on a refusal here it removes that row again.
   */
  async hold(x: HoldInput): Promise<HeldRow> {
    const s = this.s();
    const reason = holdReason(x.decision);
    if (!reason) throw refusal(x.decision, KIND_WORDS[x.kind]);
    const mine = await this.count({ tenant_id: x.p.tenantId, state: 'held', author_id: x.p.userId });
    if (mine >= s.cfg.HELD_MAX_PER_AUTHOR) throw new HttpProblem(422, 'Held by guardrails', `${x.decision.reason ?? `The ${KIND_WORDS[x.kind]} needs a review.`} You already have ${mine} waiting for review; withdraw one or wait for a decision.`, { extensions: { step: 'held-queue-full', action: 'require-approval' } });
    let firstOfOutage = false;
    if (reason === 'unavailable') {
      const waiting = await this.count({ tenant_id: x.p.tenantId, state: 'held', reason: 'unavailable' });
      if (waiting >= s.cfg.HELD_OUTAGE_MAX_PER_TENANT) throw new HttpProblem(422, 'Held by guardrails', x.decision.reason ?? 'A guardrail check could not run, and too many messages already wait for it. Try again later.', { extensions: { step: 'held-queue-full', action: 'require-approval' } });
      const recent = await this.db('held_writes').where({ tenant_id: x.p.tenantId, reason: 'unavailable' }).andWhere('created_at', '>', Date.now() - 3_600_000).first('id');
      firstOfOutage = !recent;
    }
    const f = enforcedHolds(x.decision).find((y) => (reason === 'review' ? !unavailable(y) : true));
    const id = ulid();
    const row: HeldRow = { id, tenant_id: x.p.tenantId, workspace_id: x.workspaceId, kind: x.kind, object_id: x.objectId, scope_id: x.scopeId, author_id: x.p.userId, label: x.label, body: x.storeText ? await s.keys.seal(x.p.tenantId, x.text, `held-write:${id}`) : null, reason, state: 'held', rule_name: f?.ruleName ?? null, flag_id: null, attempts: 0, screened_at: null, decided_by: null, decided_at: null, note: null, created_at: Date.now() };
    await this.db('held_writes').insert(row);
    let flag: FlagRow | null = null;
    if (reason === 'review') flag = await this.fileFlag(row, x.text, x.decision, { user: x.p.userId, name: x.p.displayName, via: x.via });
    await s.audit.append({ tenantId: row.tenant_id, action: 'moderation.held.created', kind: 'admin', actor: actorFrom(x.p, x.ip), target: { held: id, kind: x.kind, object: x.objectId, scope: x.scopeId, ...(flag ? { flag: flagRef(flag) } : {}) }, label: x.label, detail: { reason, rule: f?.ruleName ?? null, length: x.text.length }, traceId: x.traceId ?? null });
    if (firstOfOutage) await this.tellReviewers(row);
    return row;
  }

  private async fileFlag(row: HeldRow, text: string, d: GuardDecision, actor: { user: string; name: string; via: string }): Promise<FlagRow> {
    const f = enforcedHolds(d).find((y) => !unavailable(y));
    const flag = await this.s().guard.flags.create({
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      kind: 'hold',
      checkpoint: 'user-input',
      ruleId: f?.ruleId ?? null,
      ruleName: f?.ruleName ?? 'Held for review',
      setId: f?.setId ?? null,
      stage: 'enforce',
      action: 'require-approval',
      severity: 'medium',
      label: row.label,
      text,
      span: f?.span ?? null,
      note: d.reason ?? `A guardrail held this ${KIND_WORDS[row.kind]} for review before it is delivered.`,
      actor,
      source: { kind: HELD_WRITE, id: row.id }
    });
    await this.db('held_writes').where({ id: row.id }).update({ flag_id: flag.id });
    row.flag_id = flag.id;
    return flag;
  }

  /** The people who review flags in the tenant, told once an hour that writes wait on a check that cannot run. */
  private async tellReviewers(row: HeldRow): Promise<void> {
    const s = this.s();
    try {
      const roles = [...new Set([...rolesGranting('flags:review', row.tenant_id), ...rolesGranting('moderation:review', row.tenant_id)])];
      const users = ((await this.db('user_roles as r').join('users as u', 'u.id', 'r.user_id').where({ 'u.tenant_id': row.tenant_id, 'u.state': 'active' }).whereIn('r.role', roles).distinct('u.id')) as { id: string }[]).map((u) => u.id).filter((u) => u !== row.author_id);
      await s.notifications.notify({ tenantId: row.tenant_id, userIds: users, kind: 'moderation', title: 'Messages are waiting on a guardrail check that cannot run', body: `${row.rule_name ?? 'A model-backed rule'} did not answer, so what people send is held, not refused. It is checked again by itself when the check answers; nothing is released without a verdict.`, route: 'moderation?tab=held', label: 'internal' });
    } catch (err) {
      s.log.warn({ err, tenant: row.tenant_id }, 'reviewers were not told of held writes');
    }
  }

  async row(tenantId: string, id: string): Promise<HeldRow | null> {
    const r = await this.db('held_writes').where({ tenant_id: tenantId, id }).first();
    return r ? heldFrom(r) : null;
  }

  /** A held write the reviewer may see: in their workspaces (a direct conversation has none), never their own. */
  private async visible(p: Principal, id: string): Promise<{ h: HeldRow; ws: string[] }> {
    const h = await this.row(p.tenantId, id);
    const ws = (await workspacesFor(this.s(), p)).map((w) => w.id);
    if (!h || (h.workspace_id && !ws.includes(h.workspace_id))) throw notFound('Held item');
    return { h, ws };
  }

  private async flagsOf(rows: HeldRow[]) {
    const ids = rows.flatMap((r) => (r.flag_id ? [r.flag_id] : []));
    return new Map(((ids.length ? await this.db('guard_flags').whereIn('id', ids).select('id', 'number', 'state', 'queue_id') : []) as { id: string; number: number; state: string; queue_id: string | null }[]).map((f) => [f.id, f]));
  }

  private async names(tenantId: string, ids: string[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids)];
    return new Map(((uniq.length ? await this.db('users').where({ tenant_id: tenantId }).whereIn('id', uniq).select('id', 'display_name') : []) as { id: string; display_name: string }[]).map((u) => [u.id, u.display_name]));
  }

  private view(h: HeldRow, flags: Awaited<ReturnType<HeldWrites['flagsOf']>>, names: Map<string, string>, p: Principal) {
    const f = h.flag_id ? flags.get(h.flag_id) : undefined;
    const restricted = !clears(p.clearance, h.label);
    return {
      id: h.id,
      kind: h.kind,
      what: KIND_WORDS[h.kind],
      state: h.state,
      reason: h.reason,
      label: h.label,
      restricted,
      workspaceId: h.workspace_id,
      objectId: h.object_id,
      scopeId: h.scope_id,
      authorId: restricted ? null : h.author_id,
      authorName: restricted ? null : (names.get(h.author_id) ?? null),
      own: h.author_id === p.userId,
      rule: restricted ? null : h.rule_name,
      flag: f ? { id: f.id, ref: flagRef(f), state: f.state, queueId: f.queue_id } : null,
      attempts: h.attempts,
      screenedAt: h.screened_at,
      decidedBy: h.decided_by,
      decidedAt: h.decided_at,
      note: restricted ? null : h.note,
      createdAt: h.created_at
    };
  }

  /** Held writes in the reviewer's workspaces, oldest first (`held` by default). */
  async list(p: Principal, q: { state?: HeldState | 'all' | undefined; reason?: HeldReason | undefined } = {}) {
    const ws = (await workspacesFor(this.s(), p)).map((w) => w.id);
    const state = q.state ?? 'held';
    const qb = this.db('held_writes').where({ tenant_id: p.tenantId }).andWhere((w) => w.whereNull('workspace_id').orWhereIn('workspace_id', ws.length ? ws : ['-']));
    if (state !== 'all') qb.andWhere({ state });
    if (q.reason) qb.andWhere({ reason: q.reason });
    const rows = ((await qb.orderBy('created_at', state === 'held' ? 'asc' : 'desc').limit(500)) as Record<string, unknown>[]).map(heldFrom);
    const [flags, names] = await Promise.all([this.flagsOf(rows), this.names(p.tenantId, rows.map((r) => r.author_id))]);
    return rows.map((h) => this.view(h, flags, names, p));
  }

  /** The caller's own writes that wait or were refused, newest first (for their notices and the console). */
  async mine(p: Principal) {
    const rows = ((await this.db('held_writes').where({ tenant_id: p.tenantId, author_id: p.userId }).whereIn('state', ['held', 'rejected']).orderBy('created_at', 'desc').limit(200)) as Record<string, unknown>[]).map(heldFrom);
    const out = [];
    for (const h of rows) {
      const ctx = await this.handler(h.kind).context(h).catch(() => null);
      out.push({ ...this.senderView(h), what: KIND_WORDS[h.kind], objectId: h.object_id, scopeId: h.scope_id, label: h.label, route: ctx?.route ?? null, place: ctx?.place ?? null, decidedAt: h.decided_at });
    }
    return out;
  }

  /** How much waits, for the Moderation screen: a pile from an outage must be visible. */
  async summary(p: Principal) {
    const s = this.s();
    const ws = (await workspacesFor(s, p)).map((w) => w.id);
    const rows = (await this.db('held_writes').where({ tenant_id: p.tenantId, state: 'held' }).andWhere((w) => w.whereNull('workspace_id').orWhereIn('workspace_id', ws.length ? ws : ['-'])).groupBy('reason').select('reason').count({ n: '*' }).min({ oldest: 'created_at' })) as { reason: HeldReason; n: number | string; oldest: number | string | null }[];
    const of = (r: HeldReason) => rows.find((x) => x.reason === r);
    const outage = of('unavailable');
    return {
      review: Number(of('review')?.n ?? 0),
      unavailable: Number(outage?.n ?? 0),
      oldestUnavailableAt: outage?.oldest == null ? null : Number(outage.oldest),
      limits: { perAuthor: s.cfg.HELD_MAX_PER_AUTHOR, unavailablePerTenant: s.cfg.HELD_OUTAGE_MAX_PER_TENANT, rescreenSeconds: s.cfg.HELD_RESCREEN_SECONDS, expireHours: s.cfg.HELD_OUTAGE_EXPIRE_HOURS }
    };
  }

  /** One held write with its text and what surrounds it, each at the reviewer's clearance. */
  async detail(p: Principal, id: string) {
    const { h } = await this.visible(p, id);
    const [flags, names] = await Promise.all([this.flagsOf([h]), this.names(p.tenantId, [h.author_id])]);
    const v = this.view(h, flags, names, p);
    if (v.restricted) return { ...v, text: null, context: null };
    const handler = this.handler(h.kind);
    const ctx = await handler.context(h);
    return { ...v, text: h.state === 'held' ? await handler.text(h) : null, context: { place: ctx.place, items: ctx.items.map((i) => (clears(p.clearance, i.label) ? { ...i, restricted: false } : { ...i, text: null, authorName: null, restricted: true })) } };
  }

  /** The held text, for the flag's detail on the Flags screen. */
  async heldText(tenantId: string, id: string): Promise<{ conversationId: string; state: string; content: string } | null> {
    const h = await this.row(tenantId, id);
    if (!h) return null;
    return { conversationId: '', state: h.state, content: h.state === 'held' ? ((await this.handler(h.kind).text(h)) ?? '') : '' };
  }

  /** A reviewer's decision from the Moderation screen: through the flag queue, so the hold flag records it. */
  async decide(p: Principal, id: string, decision: 'accept' | 'reject', reason: string | null, ctx: { ip: string | null; traceId: string | null }) {
    const { h, ws } = await this.visible(p, id);
    if (h.state !== 'held') throw conflict(`It was already ${h.state}.`);
    if (h.reason !== 'review' || !h.flag_id) throw conflict('This waits on a guardrail check that could not run. It is checked again by itself; a reviewer does not release it.');
    const f = (await this.db('guard_flags').where({ id: h.flag_id }).first('number')) as { number: number } | undefined;
    if (!f) throw conflict('Its flag is gone.');
    let state: HeldState = h.state;
    const flag = await this.s().guard.flags.decideHold(p, `F-${f.number}`, ws, decision === 'accept' ? 'approved' : 'rejected', reason, async () => {
      state = (await this.resolve(p, h.id, decision === 'accept' ? 'approved' : 'rejected', reason, ctx)).state;
    });
    return { id: h.id, state, flag: { id: flag.id, ref: flagRef(flag), state: flag.state } };
  }

  /**
   * Applies a reviewer's decision (also from the Flags screen's decide route). The sender does not decide on their own
   * write. Compare-and-set on `held`, so one decision lands and the write is delivered once.
   */
  async resolve(p: Principal, id: string, decision: 'approved' | 'rejected', reason: string | null, ctx: { ip?: string | null; traceId?: string | null } = {}): Promise<{ id: string; state: HeldState }> {
    const s = this.s();
    const h = await this.row(p.tenantId, id);
    if (!h) throw notFound('Held item');
    if (h.author_id === p.userId) throw forbidden('You cannot decide on what you wrote yourself.', { step: 'dual-control' });
    if (!clears(p.clearance, h.label)) throw forbidden(`It is labelled ${h.label}, above your clearance.`, { step: 'clearance' });
    if (h.state !== 'held') throw conflict(`It was already ${h.state}.`);
    const out = decision === 'approved' ? await this.release(h, null, p.userId, reason) : await this.refuse(h, p.userId, reason ?? 'A reviewer rejected it.');
    await s.audit.append({ tenantId: h.tenant_id, action: `moderation.held.${out}`, kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { held: h.id, kind: h.kind, object: h.object_id, scope: h.scope_id }, label: h.label, detail: { reason: reason ?? null, by: 'reviewer', author: h.author_id }, traceId: ctx.traceId ?? null });
    return { id: h.id, state: out };
  }

  /** `held` to `delivered`, then the domain makes it live. A write whose place is gone ends as rejected. */
  private async release(h: HeldRow, text: string | null, by: string | null, note: string | null): Promise<HeldState> {
    const t = Date.now();
    const n = await this.db('held_writes').where({ id: h.id, state: 'held' }).update({ state: 'delivered', decided_by: by, decided_at: t, note: note?.slice(0, 500) ?? null });
    if (!n) throw conflict(`It was already ${(await this.row(h.tenant_id, h.id))?.state ?? 'decided'}.`);
    let live: boolean;
    try {
      live = await this.handler(h.kind).deliver(h, text);
    } catch (err) {
      // Nothing was delivered: it waits again, and the reviewer (or the next re-screen) sees why.
      await this.db('held_writes').where({ id: h.id, state: 'delivered' }).update({ state: 'held', decided_by: null, decided_at: null, note: null });
      throw err;
    }
    if (!live) {
      await this.db('held_writes').where({ id: h.id }).update({ state: 'rejected', body: null, note: 'What it was written in or about is gone.' });
      await this.handler(h.kind).discard(h, 'rejected').catch(() => undefined);
      return 'rejected';
    }
    await this.db('held_writes').where({ id: h.id }).update({ body: null });
    if (by) await this.tellSender(h, `Your ${KIND_WORDS[h.kind]} was reviewed and delivered`, null);
    return 'delivered';
  }

  private async refuse(h: HeldRow, by: string | null, note: string): Promise<HeldState> {
    const n = await this.db('held_writes').where({ id: h.id, state: 'held' }).update({ state: 'rejected', decided_by: by, decided_at: Date.now(), note: note.slice(0, 500), body: null });
    if (!n) throw conflict(`It was already ${(await this.row(h.tenant_id, h.id))?.state ?? 'decided'}.`);
    await this.handler(h.kind).discard(h, 'rejected');
    await this.tellSender(h, `Your ${KIND_WORDS[h.kind]} was not delivered`, note);
    return 'rejected';
  }

  private async tellSender(h: HeldRow, title: string, body: string | null): Promise<void> {
    const s = this.s();
    try {
      const ctx = await this.handler(h.kind).context(h).catch(() => null);
      await s.notifications.notify({ tenantId: h.tenant_id, userIds: [h.author_id], kind: 'moderation', title, ...(body ? { body } : {}), ...(ctx ? { route: ctx.route } : {}), label: h.label });
    } catch (err) {
      s.log.warn({ err, held: h.id }, 'the sender of a held write was not told');
    }
  }

  /** The system closes a hold flag nobody decided (a withdrawal, or the object went away). */
  private async closeFlag(h: HeldRow, note: string): Promise<void> {
    if (!h.flag_id) return;
    const f = await this.s().guard.flags.get(h.tenant_id, h.flag_id).catch(() => null);
    if (f) await this.s().guard.flags.closeHold(f, note);
  }

  /** The sender takes back what waits: it is removed and its flag closed. */
  async withdraw(ctx: { p: Principal; ip: string | null; traceId?: string | null | undefined }, id: string): Promise<{ id: string; state: HeldState }> {
    const h = await this.row(ctx.p.tenantId, id);
    if (!h || h.author_id !== ctx.p.userId) throw notFound('Held item');
    if (h.state !== 'held') throw conflict(`It was already ${h.state}.`);
    await this.drop(h, 'Withdrawn by its sender.');
    await this.s().audit.append({ tenantId: h.tenant_id, action: 'moderation.held.withdrawn', kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target: { held: h.id, kind: h.kind, object: h.object_id, scope: h.scope_id }, label: h.label, detail: { by: 'author' }, traceId: ctx.traceId ?? null });
    return { id: h.id, state: 'withdrawn' };
  }

  private async drop(h: HeldRow, note: string): Promise<boolean> {
    const n = await this.db('held_writes').where({ id: h.id, state: 'held' }).update({ state: 'withdrawn', decided_at: Date.now(), note, body: null });
    if (!n) return false;
    await this.handler(h.kind).discard(h, 'withdrawn');
    await this.closeFlag(h, note);
    return true;
  }

  /** The sender's waiting write for this object, to withdraw it by the object's id. */
  async withdrawFor(ctx: { p: Principal; ip: string | null; traceId?: string | null | undefined }, objectId: string, kind: HeldKind): Promise<boolean> {
    const h = await this.pendingFor(objectId, kind);
    if (!h || h.author_id !== ctx.p.userId) return false;
    await this.withdraw(ctx, h.id);
    return true;
  }

  /** What waited on objects that went away (a deleted message, post, conversation or group): withdrawn, flags closed. */
  async dropWhere(tenantId: string, where: { objectIds?: string[]; scopeId?: string }, note: string): Promise<number> {
    const qb = this.db('held_writes').where({ tenant_id: tenantId, state: 'held' });
    if (where.scopeId) qb.andWhere({ scope_id: where.scopeId });
    if (where.objectIds) {
      if (!where.objectIds.length) return 0;
      qb.whereIn('object_id', where.objectIds.slice(0, 5000));
    }
    const rows = ((await qb.limit(5000)) as Record<string, unknown>[]).map(heldFrom);
    let n = 0;
    for (const h of rows) if (await this.drop(h, note)) n++;
    return n;
  }

  /**
   * The re-screen (B-9403): what waits on a check that could not run is screened again as its sender. A fresh verdict
   * decides it; while the check still cannot run the rest of the tenant's pile is left for the next round.
   */
  async rescreen(tenantId: string): Promise<{ delivered: number; rejected: number; review: number; waiting: number; expired: number }> {
    const s = this.s();
    const out = { delivered: 0, rejected: 0, review: 0, waiting: 0, expired: 0 };
    const rows = ((await this.db('held_writes').where({ tenant_id: tenantId, state: 'held', reason: 'unavailable' }).orderBy('created_at').limit(200)) as Record<string, unknown>[]).map(heldFrom);
    const expireBefore = Date.now() - s.cfg.HELD_OUTAGE_EXPIRE_HOURS * 3_600_000;
    const system = { service: 'moderation.held' };
    const audit = (h: HeldRow, action: string, detail: Record<string, unknown>) => s.audit.append({ tenantId, action, kind: 'system', actor: system, target: { held: h.id, kind: h.kind, object: h.object_id, scope: h.scope_id }, label: h.label, detail: { by: 'rescreen', author: h.author_id, ...detail } });
    let down = false;
    for (const h of rows) {
      try {
        if (h.created_at < expireBefore) {
          await this.refuse(h, null, `The check it waited for did not answer within ${s.cfg.HELD_OUTAGE_EXPIRE_HOURS} hours, so it was not delivered. Send it again.`);
          await audit(h, 'moderation.held.rejected', { expired: true });
          out.expired++;
          continue;
        }
        if (down) {
          out.waiting++;
          continue;
        }
        const handler = this.handler(h.kind);
        const user = (await this.db('users').where({ tenant_id: tenantId, id: h.author_id }).first('state')) as { state: string } | undefined;
        const author = user?.state === 'active' ? await loadPrincipal(s, tenantId, h.author_id, {}) : null;
        const text = author ? await handler.text(h) : null;
        const d = author && text != null ? await handler.rescreen(h, author, text) : null;
        if (!d) {
          await this.refuse(h, null, 'What it was written in is gone, or you can no longer write there.');
          await audit(h, 'moderation.held.rejected', { gone: true });
          out.rejected++;
          continue;
        }
        const reason = holdReason(d);
        if (reason === 'unavailable') {
          await this.db('held_writes').where({ id: h.id, state: 'held' }).update({ attempts: h.attempts + 1, screened_at: Date.now() });
          down = true;
          out.waiting++;
          continue;
        }
        if (d.action === 'block' || (d.action === 'require-approval' && !reason)) {
          await this.refuse(h, null, d.reason ?? 'A guardrail rule refused it.');
          await audit(h, 'moderation.held.rejected', { action: d.action });
          out.rejected++;
          continue;
        }
        if (reason === 'review') {
          // A rule that could run now asks for a reviewer: the same row waits on, with a flag.
          const n = await this.db('held_writes').where({ id: h.id, state: 'held', reason: 'unavailable' }).update({ reason: 'review', attempts: h.attempts + 1, screened_at: Date.now(), rule_name: enforcedHolds(d).find((y) => !unavailable(y))?.ruleName ?? h.rule_name });
          if (n) {
            const who = (await this.names(tenantId, [h.author_id])).get(h.author_id) ?? 'Someone';
            const flag = await this.fileFlag({ ...h, reason: 'review' }, text!, d, { user: h.author_id, name: who, via: 'moderation.held' });
            await audit(h, 'moderation.held.review', { flag: flagRef(flag) });
            out.review++;
          }
          continue;
        }
        const state = await this.release(h, d.action === 'redact' ? d.text : null, null, 'Checked again when the guardrail answered.');
        await audit(h, `moderation.held.${state}`, { action: d.action });
        if (state === 'delivered') out.delivered++;
        else out.rejected++;
      } catch (err) {
        // Decided by someone else meanwhile (a withdrawal), or a fault of this one write: the others go on.
        s.log.warn({ err, held: h.id }, 'a held write was not re-screened');
      }
    }
    return out;
  }

  /** Decided rows go HELD_KEEP_DAYS after their decision, with the rejected objects only their sender could see. */
  async purge(tenantId: string): Promise<{ deleted: number }> {
    const before = Date.now() - this.s().cfg.HELD_KEEP_DAYS * 86_400_000;
    const rows = ((await this.db('held_writes').where({ tenant_id: tenantId }).whereNot({ state: 'held' }).andWhere('decided_at', '<', before).limit(2000)) as Record<string, unknown>[]).map(heldFrom);
    // 1.7.0 (B-9504): what a legal hold on its case (the hold flag) keeps waits for the release, recorded once.
    const heldFlags = await this.s().evidence.heldFlags(tenantId);
    let kept = 0;
    for (const h of rows) {
      const hold = h.flag_id ? heldFlags.get(h.flag_id) : undefined;
      if (hold) {
        kept++;
        await this.s().evidence.recordSkip(tenantId, 'held-write', h.id, HELD_PURGE_JOB, { reason: 'legal-hold', ref: hold });
        continue;
      }
      if (h.state === 'rejected') await this.handler(h.kind).discard(h, 'withdrawn').catch(() => undefined);
      await this.db('held_writes').where({ id: h.id }).delete();
    }
    return { deleted: rows.length - kept };
  }
}
