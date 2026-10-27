import { ulid } from 'ulid';
import { actorFrom } from '../audit/chain.js';
import { clears, isLabel } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { flagFromRow, flagRef, type FlagRow } from '../guardrails/flags.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { appealFrom, appealRef, ModerationService, type AppealRow } from '../moderation/service.js';
import type { ModeratedObject } from '../moderation/registry.js';
import type { Services } from '../services.js';
import { can } from './roles.js';
import { EVENT_OBJECT, GROUP_OBJECT, POST_OBJECT, type Access, type Ctx, type GroupRow } from './service.js';

/*
 * 1.7.0 (B-9706, GRP-16): a group's moderators act on the cases about their group's content.
 *
 * A case is a flag whose object is the group, one of its posts or one of its events (a report through B-1902, or a
 * moderation check). It stays a flag of the tenant: the tenant's reviewers see it in their queues as before. What this
 * adds is the group's side of it:
 *
 * - a new case is told to the group's owners and moderators (never to the reporter or to whose content it is);
 * - a moderator confirms or dismisses it, hides the object (through the moderation service, so the action is a
 *   moderation action its owner may appeal and evidence keeps), warns its author, or suspends or bans them in the
 *   group (through `GroupBans`, the one implementation of both);
 * - a case can be assigned to one of the group's moderators;
 * - an appeal of an action taken on the group's content is told to the group's moderators, and one of them who took no
 *   part in the decision decides it.
 *
 * Reach. A moderator reaches the cases of the groups in which their acting role has the `cases` right: their group, and
 * a channel they moderate (a group's owners act as owners of its channels). Nothing of the tenant's other flags is
 * shown or decided here. Nobody decides a case about their own content, and the moderation service refuses the
 * appellant and whoever took the decision as reviewers of an appeal. Every decision is audited.
 */

export const CASE_ACTIONS = ['confirm', 'dismiss', 'hide', 'warn', 'suspend', 'ban'] as const;
export type CaseAction = (typeof CASE_ACTIONS)[number];
export const CASE_LIMITS = { note: 500 } as const;

interface CaseActionRow {
  id: string;
  tenant_id: string;
  group_id: string;
  flag_id: string;
  action: CaseAction | 'assign';
  target_user: string | null;
  moderation_action_id: string | null;
  ban_id: string | null;
  note: string | null;
  created_by: string;
  created_at: number;
}

interface Case {
  flag: FlagRow;
  group: GroupRow;
  access: Access;
  object: ModeratedObject | null;
}

// Read when called, not when this module loads: `service.ts` imports this file and is not evaluated yet then.
const isGroupType = (type: string) => type === GROUP_OBJECT || type === POST_OBJECT || type === EVENT_OBJECT;
const modCtx = (ctx: Ctx) => ({ ...ModerationService.ctxFor(ctx.p, ctx.ip, ctx.traceId), principal: ctx.p });

export class GroupCases {
  private started = false;

  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  /** New cases and new appeals are told to the group's moderators. */
  init(): void {
    if (this.started) return;
    this.started = true;
    const s = this.s();
    s.guard.flags.createdListeners.push((f) => this.raised(f).catch((err: unknown) => s.log.warn({ err, flag: f.id }, 'telling a group’s moderators of a case failed')));
    s.moderation.appealListeners.push((a) => this.appealed(a));
  }

  // ---------- which group a flag or an action belongs to ----------

  private async groupIdOf(tenantId: string, type: string | null, id: string | null): Promise<string | null> {
    if (!type || !id || !isGroupType(type)) return null;
    if (type === GROUP_OBJECT) return id;
    const r = (await this.db(type === POST_OBJECT ? 'group_posts' : 'group_events').where({ tenant_id: tenantId, id }).first('group_id')) as { group_id: string } | undefined;
    return r?.group_id ?? null;
  }

  /** The groups of `id`'s tree (itself and its channels) whose cases the caller may see. */
  private async reach(p: Principal, id: string): Promise<Map<string, Access>> {
    const s = this.s();
    const out = new Map<string, Access>();
    const top = await s.groups.accessOrNull(p, id);
    if (!top) throw notFound('Group');
    const ws = await s.groups.workspaceIds(p);
    const channels = top.group.parent_id ? [] : ((await this.db('social_groups').where({ parent_id: id }).whereNot({ state: 'deleted' }).select('id')) as { id: string }[]).map((r) => r.id);
    for (const gid of [id, ...channels]) {
      const a = gid === id ? top : await s.groups.accessOrNull(p, gid, ws);
      if (a?.read && can(a, 'cases')) out.set(gid, a);
    }
    // Nothing in reach: answer as the `cases` right of the group itself does (403 for a reader, 404 otherwise).
    if (!out.size) await s.groups.require(p, id, 'cases', { reading: true });
    return out;
  }

  /** The flags on the content of these groups, as a query. */
  private flagsOf(tenantId: string, groupIds: string[]) {
    const posts = this.db('group_posts').whereIn('group_id', groupIds).select('id');
    const events = this.db('group_events').whereIn('group_id', groupIds).select('id');
    return this.db('guard_flags')
      .where({ tenant_id: tenantId })
      .andWhere((q) => q.where((q1) => q1.where({ source_kind: GROUP_OBJECT }).whereIn('source_id', groupIds)).orWhere((q2) => q2.where({ source_kind: POST_OBJECT }).whereIn('source_id', posts)).orWhere((q3) => q3.where({ source_kind: EVENT_OBJECT }).whereIn('source_id', events)));
  }

  private async names(tenantId: string, ids: (string | null)[]): Promise<Map<string, string>> {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    const rows = list.length ? ((await this.db('users').where({ tenant_id: tenantId }).whereIn('id', list).select('id', 'display_name', 'username')) as { id: string; display_name: string | null; username: string }[]) : [];
    return new Map(rows.map((u) => [u.id, u.display_name || u.username]));
  }

  private async objectOf(f: FlagRow): Promise<ModeratedObject | null> {
    const h = f.source_kind ? this.s().moderation.registry.get(f.source_kind) : undefined;
    return h && f.source_id ? h.resolve(f.tenant_id, f.source_id) : null;
  }

  /** One case of the group's tree, for a caller who may act on it (404 outside their reach or above their clearance). */
  private async load(p: Principal, id: string, ref: string): Promise<Case> {
    const s = this.s();
    const reach = await this.reach(p, id);
    const f = await s.guard.flags.get(p.tenantId, ref);
    const gid = await this.groupIdOf(p.tenantId, f.source_kind, f.source_id);
    const access = gid ? reach.get(gid) : undefined;
    if (!access || !clears(p.clearance, f.label)) throw notFound('Case');
    return { flag: f, group: access.group, access, object: await this.objectOf(f) };
  }

  // ---------- reading ----------

  /** The cases of the group and of the channels the caller moderates, newest first. */
  async list(p: Principal, id: string, state?: string) {
    const reach = await this.reach(p, id);
    const ids = [...reach.keys()];
    const rows = ((await this.flagsOf(p.tenantId, ids).modify((q) => (state ? q.andWhere({ state }) : q)).orderBy('created_at', 'desc').limit(200)) as Record<string, unknown>[]).map(flagFromRow).filter((f) => clears(p.clearance, isLabel(f.label) ? f.label : 'restricted'));
    const names = await this.names(p.tenantId, rows.map((f) => f.assignee));
    const out = [];
    for (const f of rows) {
      const gid = await this.groupIdOf(p.tenantId, f.source_kind, f.source_id);
      if (!gid || !reach.has(gid)) continue;
      const h = f.source_kind ? this.s().moderation.registry.get(f.source_kind) : undefined;
      out.push({ id: f.id, ref: flagRef(f), kind: f.kind, state: f.state, severity: f.severity, objectType: f.source_kind, objectId: f.source_id, label: f.label, ruleName: f.rule_name, dueAt: f.due_at, createdAt: f.created_at, groupId: gid, groupName: reach.get(gid)!.group.name, assignee: f.assignee, assigneeName: f.assignee ? (names.get(f.assignee) ?? null) : null, hideable: !!h?.hide && f.kind !== 'hold' });
    }
    return out;
  }

  /** One case: the flag with its excerpt, the object it is about, and what the group's moderators did with it. */
  async detail(p: Principal, id: string, ref: string) {
    const s = this.s();
    const c = await this.load(p, id, ref);
    const flag = await s.guard.flags.detail(p, c.flag.id, [c.group.workspace_id]);
    const history = ((await this.db('group_case_actions').where({ tenant_id: p.tenantId, flag_id: c.flag.id }).orderBy('created_at')) as CaseActionRow[]).map((r) => ({ ...r, created_at: Number(r.created_at) }));
    const names = await this.names(p.tenantId, [c.object?.ownerId ?? null, c.flag.assignee, ...history.flatMap((h) => [h.created_by, h.target_user])]);
    const h = c.flag.source_kind ? s.moderation.registry.get(c.flag.source_kind) : undefined;
    return {
      ...flag,
      groupId: c.group.id,
      groupName: c.group.name,
      assigneeName: c.flag.assignee ? (names.get(c.flag.assignee) ?? null) : null,
      object: c.object ? { type: c.object.type, id: c.object.id, state: c.object.state, ownerId: c.object.ownerId, ownerName: c.object.ownerId ? (names.get(c.object.ownerId) ?? null) : null, hideable: !!h?.hide && c.flag.kind !== 'hold' } : null,
      // Nobody decides a case about their own content.
      own: c.object?.ownerId === p.userId,
      actions: await Promise.all(history.map(async (r) => ({ id: r.id, action: r.action, by: r.created_by, byName: names.get(r.created_by) ?? null, userId: r.target_user, userName: r.target_user ? (names.get(r.target_user) ?? null) : null, moderationActionId: r.moderation_action_id, banId: r.ban_id, note: r.note ? ((await s.keys.open(r.tenant_id, r.note, `group-case:${r.id}`)) ?? null) : null, at: r.created_at })))
    };
  }

  /** The group's owners and moderators a case may be assigned to (cleared for it, let in now). */
  async moderators(p: Principal, id: string, ref: string) {
    const c = await this.load(p, id, ref);
    const ids = await this.assignable(c);
    const names = await this.names(p.tenantId, ids);
    return ids.map((u) => ({ userId: u, name: names.get(u) ?? null }));
  }

  private async assignable(c: Case): Promise<string[]> {
    const s = this.s();
    const mods = await s.groups.membersWithAccess(c.group, 'cases');
    if (!mods.length) return [];
    const rows = (await this.db('users').where({ tenant_id: c.group.tenant_id }).whereIn('id', mods).select('id', 'clearance')) as { id: string; clearance: string }[];
    return rows.filter((u) => isLabel(u.clearance) && clears(u.clearance, c.flag.label) && u.id !== c.object?.ownerId).map((u) => u.id);
  }

  // ---------- acting ----------

  private async record(c: Case, by: string, action: CaseActionRow['action'], x: { target?: string | null; moderationActionId?: string | null; banId?: string | null; note?: string | null }): Promise<string> {
    const s = this.s();
    const id = ulid();
    await this.db('group_case_actions').insert({ id, tenant_id: c.group.tenant_id, group_id: c.group.id, flag_id: c.flag.id, action, target_user: x.target ?? null, moderation_action_id: x.moderationActionId ?? null, ban_id: x.banId ?? null, note: x.note ? await s.keys.seal(c.group.tenant_id, x.note, `group-case:${id}`) : null, created_by: by, created_at: Date.now() });
    return id;
  }

  /** What a moderator wrote to the person, screened before it is sent or kept. */
  private async screen(p: Principal, g: GroupRow, text: string): Promise<string> {
    const d = await this.s().guardrails.check({ tenantId: g.tenant_id, workspaceId: g.workspace_id, checkpoint: 'user-input', text, label: g.label, principal: p, source: { kind: GROUP_OBJECT, id: g.id }, meta: { objectType: GROUP_OBJECT, field: 'case-note', group: g.id } });
    if (d.action === 'block' || d.action === 'require-approval') throw new HttpProblem(422, 'Blocked by guardrails', d.reason ?? 'The note was blocked by a guardrail rule.', { extensions: { step: 'guardrails', action: d.action, field: 'note' } });
    return d.action === 'redact' ? d.text : text;
  }

  /**
   * Acts on a case. `confirm` and `dismiss` decide the flag. `hide` hides the object (a moderation action its owner is
   * told of and may appeal). `warn` tells the author what the moderator wrote. `suspend` and `ban` go through the
   * group's bans, in the group the content is in. The last four confirm a flag that is still open.
   */
  async act(ctx: Ctx, id: string, ref: string, input: { action: CaseAction; note?: string | null | undefined; days?: number | null | undefined }) {
    const s = this.s();
    const p = ctx.p;
    const c = await this.load(p, id, ref);
    const { flag: f, group: g } = c;
    if (g.state === 'archived') throw conflict('The group is archived; it is read only.');
    if (f.kind === 'hold') throw conflict(`${flagRef(f)} holds something for review; accept or reject it from the held items.`);
    if (c.object?.ownerId === p.userId) throw forbidden('This case is about your own content; another moderator decides it.', { step: 'independence' });
    if (f.assignee && f.assignee !== p.userId && !can(c.access, 'roles')) throw new HttpProblem(409, 'Assigned', `${flagRef(f)} is assigned to another moderator; an owner reassigns it.`, { extensions: { step: 'assignee' } });
    const ws = [g.workspace_id];
    const owner = c.object?.ownerId ?? null;
    const note = input.note?.trim() ? input.note.trim() : null;
    const confirm = async (reason: string): Promise<FlagRow> => (f.state === 'open' ? s.guard.flags.decide(p, f.id, ws, 'confirmed', reason) : f);
    let after: FlagRow;
    let moderationActionId: string | null = null;
    let banId: string | null = null;
    const detail: Record<string, unknown> = {};
    // What is kept with the case: the note as it was sent (a ban's reason is kept with the ban).
    let kept = note;
    if (input.action === 'confirm' || input.action === 'dismiss') {
      if (f.state !== 'open') throw conflict(`${flagRef(f)} was already ${f.state}.`);
      after = await s.guard.flags.decide(p, f.id, ws, input.action === 'confirm' ? 'confirmed' : 'dismissed', note);
    } else if (input.action === 'hide') {
      if (f.state !== 'open' && f.state !== 'confirmed') throw conflict(`${flagRef(f)} was ${f.state}; only an open or confirmed case leads to an action.`);
      const out = await s.moderation.actOnFlag(modCtx(ctx), f.id, note ?? `Hidden by a moderator of ${g.name}`);
      moderationActionId = out.action.id;
      after = await s.guard.flags.get(p.tenantId, f.id);
    } else {
      if (f.state !== 'open' && f.state !== 'confirmed') throw conflict(`${flagRef(f)} was ${f.state}; only an open or confirmed case leads to an action.`);
      if (!owner) throw conflict('Nobody is recorded as the author of this; there is no one to act on.');
      if (input.action === 'warn') {
        if (!note) throw badRequest('A warning says what it is about: give a note for the person.');
        const text = await this.screen(p, g, note);
        after = await confirm('Warned by a moderator of the group');
        if ((await s.groups.eligible(g, owner)).ok) await s.notifications.notify({ tenantId: g.tenant_id, userIds: [owner], kind: 'group.case', title: `A moderator of ${g.name} warned you`, body: text, route: `groups?id=${g.id}`, label: g.label });
        kept = text;
      } else {
        if (input.action === 'suspend' && !input.days) throw badRequest('A suspension has a length in days.');
        // The one implementation of both (B-9701): its rules on owners, moderators and what already stands apply.
        const ban = await s.groups.bans.create(ctx, g.id, { userId: owner, kind: input.action, days: input.days ?? null, reason: note });
        banId = ban.id;
        detail.expiresAt = ban.expiresAt;
        after = await confirm(input.action === 'ban' ? 'Banned from the group' : 'Suspended from the group');
      }
    }
    const rowId = await this.record(c, p.userId, input.action, { target: owner, moderationActionId, banId, note: input.action === 'suspend' || input.action === 'ban' ? null : kept });
    await s.audit.append({ tenantId: g.tenant_id, action: `group.case.${input.action}`, kind: 'admin', actor: actorFrom(p, ctx.ip), target: { group: g.id, flag: flagRef(f), case: rowId, ...(owner ? { user: owner } : {}) }, label: f.label, detail: { object: f.source_kind, id: f.source_id, flagState: after.state, ...(moderationActionId ? { moderationAction: moderationActionId } : {}), ...(banId ? { ban: banId } : {}), hasNote: !!note, ...detail }, traceId: ctx.traceId ?? null });
    return this.detail(p, id, f.id);
  }

  /** Assigns an open case to one of the group's moderators, or back to all of them with `null`. */
  async assign(ctx: Ctx, id: string, ref: string, userId: string | null) {
    const s = this.s();
    const p = ctx.p;
    const c = await this.load(p, id, ref);
    if (c.flag.state !== 'open') throw conflict(`${flagRef(c.flag)} was already ${c.flag.state}.`);
    if (c.flag.assignee && c.flag.assignee !== p.userId && !can(c.access, 'roles')) throw forbidden('Only an owner takes a case from the moderator it is assigned to.', { step: 'group-role' });
    let to: { id: string; name: string } | null = null;
    if (userId) {
      if (userId === c.object?.ownerId) throw forbidden('A case is not assigned to the person whose content it is about.', { step: 'independence' });
      if (!(await this.assignable(c)).includes(userId)) throw new HttpProblem(422, 'Not a moderator', 'A case goes to an owner or a moderator of the group who is cleared for it.', { extensions: { step: 'assignee' } });
      to = { id: userId, name: (await this.names(p.tenantId, [userId])).get(userId) ?? 'A moderator' };
    }
    await s.guard.flags.assignTo(c.flag, p.userId, to);
    const rowId = await this.record(c, p.userId, 'assign', { target: userId });
    await s.audit.append({ tenantId: c.group.tenant_id, action: 'group.case.assigned', kind: 'admin', actor: actorFrom(p, ctx.ip), target: { group: c.group.id, flag: flagRef(c.flag), case: rowId, ...(userId ? { user: userId } : {}) }, label: c.flag.label, detail: { before: c.flag.assignee, after: userId }, traceId: ctx.traceId ?? null });
    if (to && to.id !== p.userId) await s.notifications.notify({ tenantId: c.group.tenant_id, userIds: [to.id], kind: 'group.case', title: `A case in ${c.group.name} was assigned to you`, body: `${flagRef(c.flag)}, ${c.flag.severity} severity`, route: `groups?id=${c.group.id}`, label: c.flag.label });
    return this.detail(p, id, c.flag.id);
  }

  // ---------- telling the moderators ----------

  /** A new flag on a group's content: its owners and moderators are told, except the reporter and the author. */
  private async raised(f: FlagRow): Promise<void> {
    const s = this.s();
    if (f.kind === 'hold') return; // held posts have their own queue and notice (B-9402)
    const gid = await this.groupIdOf(f.tenant_id, f.source_kind, f.source_id);
    if (!gid) return;
    const g = await s.groups.row(f.tenant_id, gid);
    if (!g || g.state === 'deleted') return;
    const obj = await this.objectOf(f);
    const to = (await this.cleared(f, await s.groups.membersWithAccess(g, 'cases'))).filter((u) => u !== f.actor?.user && u !== obj?.ownerId);
    if (to.length) await s.notifications.notify({ tenantId: g.tenant_id, userIds: to, kind: 'group.case', title: `A case was opened in ${g.name}`, body: `${flagRef(f)}, ${f.severity} severity`, route: `groups?id=${g.id}`, label: f.label });
  }

  private async cleared(f: Pick<FlagRow, 'tenant_id' | 'label'>, userIds: string[]): Promise<string[]> {
    if (!userIds.length) return [];
    const rows = (await this.db('users').where({ tenant_id: f.tenant_id }).whereIn('id', userIds).select('id', 'clearance')) as { id: string; clearance: string }[];
    return rows.filter((u) => isLabel(u.clearance) && clears(u.clearance, f.label)).map((u) => u.id);
  }

  /** The group an appeal's action was taken in (null for sanctions and for actions on anything else). */
  private async groupOfAppeal(a: AppealRow): Promise<{ group: GroupRow; decidedBy: string | null } | null> {
    const s = this.s();
    if (!a.action_id) return null;
    const action = await s.moderation.actionRow(a.tenant_id, a.action_id);
    if (!action) return null;
    const gid = await this.groupIdOf(a.tenant_id, action.object_type, action.object_id);
    const g = gid ? await s.groups.row(a.tenant_id, gid) : null;
    return g && g.state !== 'deleted' ? { group: g, decidedBy: action.created_by } : null;
  }

  /** An appeal of an action on a group's content is told to its moderators, except the appellant and the decider. */
  private async appealed(a: AppealRow): Promise<void> {
    const s = this.s();
    const x = await this.groupOfAppeal(a);
    if (!x) return;
    const to = (await this.cleared(a, await s.groups.membersWithAccess(x.group, 'cases'))).filter((u) => u !== a.user_id && u !== x.decidedBy);
    if (to.length) await s.notifications.notify({ tenantId: a.tenant_id, userIds: to, kind: 'group.case', title: `An appeal waits in ${x.group.name}`, body: `${appealRef(a)}: a moderator who took no part in the decision decides it.`, route: `groups?id=${x.group.id}`, label: a.label });
  }

  // ---------- appeals ----------

  /** The appeals of actions taken on the content of the groups in the caller's reach. */
  async appeals(p: Principal, id: string, state?: AppealRow['state']) {
    const s = this.s();
    const reach = await this.reach(p, id);
    const rows = ((await this.db('moderation_appeals').where({ tenant_id: p.tenantId, kind: 'action' }).modify((q) => (state ? q.andWhere({ state }) : q)).orderBy('created_at', 'desc').limit(500)) as Record<string, unknown>[]).map(appealFrom);
    const out = [];
    for (const a of rows) {
      const x = await this.groupOfAppeal(a);
      if (!x || !reach.has(x.group.id)) continue;
      // Who may decide it: not the appellant, not whoever took the decision.
      out.push({ ...(await s.moderation.appealView(a, p, false)), groupId: x.group.id, groupName: x.group.name, decidable: a.user_id !== p.userId && x.decidedBy !== p.userId && clears(p.clearance, a.label) && (a.state === 'pending' || (a.state === 'reviewing' && a.reviewer_id === p.userId)) });
    }
    return out;
  }

  private async appealInReach(p: Principal, id: string, ref: string): Promise<{ appeal: AppealRow; group: GroupRow }> {
    const reach = await this.reach(p, id);
    const a = await this.s().moderation.appealRow(p.tenantId, ref);
    const x = await this.groupOfAppeal(a);
    if (!x || !reach.has(x.group.id)) throw notFound('Appeal');
    return { appeal: a, group: x.group };
  }

  /** One appeal with its statement (the moderation service withholds it above the caller's clearance). */
  async appeal(p: Principal, id: string, ref: string) {
    const { appeal, group } = await this.appealInReach(p, id, ref);
    return { ...(await this.s().moderation.appealView(appeal, p)), groupId: group.id, groupName: group.name };
  }

  /** A moderator takes an appeal for review. The moderation service refuses the appellant and the decider. */
  async reviewAppeal(ctx: Ctx, id: string, ref: string) {
    const { appeal, group } = await this.appealInReach(ctx.p, id, ref);
    const out = await this.s().moderation.startReview(modCtx(ctx), appeal.id);
    return { ...out, groupId: group.id, groupName: group.name };
  }

  /** A moderator decides an appeal: upheld puts the object back and reopens the case. */
  async decideAppeal(ctx: Ctx, id: string, ref: string, decision: 'upheld' | 'denied', note: string | null) {
    const s = this.s();
    const { appeal, group } = await this.appealInReach(ctx.p, id, ref);
    const out = await s.moderation.decideAppeal(modCtx(ctx), appeal.id, decision, note);
    await s.audit.append({ tenantId: group.tenant_id, action: `group.case.appeal.${decision}`, kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target: { group: group.id, appeal: appealRef(appeal), user: appeal.user_id }, label: appeal.label, detail: { action: appeal.action_id, ...out.effects }, traceId: ctx.traceId ?? null });
    return { ...out, groupId: group.id, groupName: group.name };
  }
}

