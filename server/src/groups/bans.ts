import { ulid } from 'ulid';
import type { Knex } from 'knex';
import { actorFrom, isUniqueViolation } from '../audit/chain.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import { can, covers, isStaff, ownsGroup } from './roles.js';
import { GROUP_OBJECT, type Ctx, type GroupRow } from './service.js';

/*
 * 1.7.0 (B-9701, GRP-8): banning and suspending a person in a group.
 *
 * - A ban removes the member from the group and its channels, withdraws what was pending for them (requests and
 *   invitations) and keeps them out by every way in: an open join, a request to join, an invitation, an invite link
 *   and the acceptance of anything pending. It stands until its time passes or a moderator lifts it; without a time it
 *   stands until lifted. Someone who is not a member can be banned too, before they ask.
 * - A suspension keeps the membership and takes its effect away for a time: the member reads and does in the group
 *   what a non-member may, is not told of what happens in it, and gets the membership back unchanged when the time
 *   passes. Leaving does not end it: it keeps them out like a ban until then.
 *
 * Either one in a group also holds in its channels. One stands per person and group at a time (`active_key`). The
 * reason is what a moderator wrote: it passes the `user-input` guardrail, is kept sealed and is read by the group's
 * moderators only. Owners are not banned or suspended: an owner is made a moderator or member first.
 */

export const BAN_KINDS = ['ban', 'suspend'] as const;
export type BanKind = (typeof BAN_KINDS)[number];
export const BAN_LIMITS = { reason: 500, days: 3650, suspendDays: 365 } as const;

export interface BanRow {
  id: string;
  tenant_id: string;
  group_id: string;
  user_id: string;
  kind: BanKind;
  reason: string | null;
  active_key: string | null;
  created_by: string;
  created_at: number;
  expires_at: number | null;
  lifted_by: string | null;
  lifted_at: number | null;
}

const from = (r: Record<string, unknown>): BanRow => ({ ...(r as unknown as BanRow), created_at: Number(r.created_at), expires_at: r.expires_at == null ? null : Number(r.expires_at), lifted_at: r.lifted_at == null ? null : Number(r.lifted_at) });
const stateOf = (r: BanRow, now = Date.now()): 'active' | 'lifted' | 'ended' => (r.lifted_at ? 'lifted' : r.active_key && (r.expires_at == null || r.expires_at > now) ? 'active' : 'ended');
const keyOf = (groupId: string, userId: string) => `${groupId}:${userId}`;
const until = (r: Pick<BanRow, 'expires_at'>) => (r.expires_at == null ? 'until it is lifted' : `until ${new Date(r.expires_at).toISOString().slice(0, 16).replace('T', ' ')} UTC`);

/** What the person themselves is shown of it: the kind and when it ends, never the reason. */
export const standingView = (r: BanRow | null) => (r ? { kind: r.kind, until: r.expires_at } : null);

export class GroupBans {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  /** Bans and suspensions standing now, as a query other queries filter with. */
  private standing(db: Knex | Knex.Transaction = this.db) {
    return db('group_bans').whereNotNull('active_key').andWhere((q) => q.whereNull('expires_at').orWhere('expires_at', '>', Date.now()));
  }

  /** The ban or suspension standing against the person in this group itself. One past its time is ended on the way. */
  async active(groupId: string, userId: string, db: Knex | Knex.Transaction = this.db): Promise<BanRow | null> {
    const r = await db('group_bans').where({ active_key: keyOf(groupId, userId) }).first();
    if (!r) return null;
    const row = from(r);
    if (row.expires_at != null && row.expires_at <= Date.now()) {
      await db('group_bans').where({ id: row.id }).whereNotNull('active_key').update({ active_key: null });
      return null;
    }
    return row;
  }

  /** In the group or, for a channel, in its group: what keeps the person out now. */
  async barred(g: Pick<GroupRow, 'id' | 'parent_id'>, userId: string, db: Knex | Knex.Transaction = this.db): Promise<BanRow | null> {
    return (await this.active(g.id, userId, db)) ?? (g.parent_id ? await this.active(g.parent_id, userId, db) : null);
  }

  /** Refuses while a ban or suspension stands. `self`: the person is asking; otherwise someone acts for them. */
  async assertNone(g: Pick<GroupRow, 'id' | 'parent_id' | 'name'>, userId: string, who: 'self' | 'other', db?: Knex | Knex.Transaction): Promise<void> {
    const b = await this.barred(g, userId, db);
    if (!b) return;
    const what = b.kind === 'ban' ? 'banned from' : 'suspended from';
    if (who === 'self') throw forbidden(`You are ${what} ${g.name} ${until(b)}.`, { step: 'ban', kind: b.kind, until: b.expires_at });
    throw new HttpProblem(409, b.kind === 'ban' ? 'Banned' : 'Suspended', `This person is ${what} ${g.name} ${until(b)}. Lift it first.`, { extensions: { step: 'ban', kind: b.kind, until: b.expires_at, ban: b.id } });
  }

  /** The groups (and their channels) in which a ban or suspension stands against the person. */
  async groupsBarred(tenantId: string, userId: string): Promise<Set<string>> {
    const ids = ((await this.standing().andWhere({ tenant_id: tenantId, user_id: userId }).select('group_id')) as { group_id: string }[]).map((r) => r.group_id);
    if (!ids.length) return new Set();
    const channels = ((await this.db('social_groups').whereIn('parent_id', ids).select('id')) as { id: string }[]).map((r) => r.id);
    return new Set([...ids, ...channels]);
  }

  /** Of these people, the ones a ban or suspension stands against in this group (not its parent). */
  async usersBarred(groupId: string, userIds: string[]): Promise<Set<string>> {
    if (!userIds.length) return new Set();
    return new Set(((await this.standing().andWhere({ group_id: groupId }).whereIn('user_id', userIds).select('user_id')) as { user_id: string }[]).map((r) => r.user_id));
  }

  /** The people barred in the group or its parent, as a subquery of user ids. */
  barredUsersQuery(g: Pick<GroupRow, 'id' | 'parent_id'>) {
    return this.standing().whereIn('group_id', g.parent_id ? [g.id, g.parent_id] : [g.id]).select('user_id');
  }

  private async view(r: BanRow, names: Map<string, string>, withReason: boolean) {
    const reason = withReason && r.reason ? ((await this.s().keys.open(r.tenant_id, r.reason, `group-ban:${r.id}`)) ?? null) : null;
    return { id: r.id, groupId: r.group_id, userId: r.user_id, userName: names.get(r.user_id) ?? null, kind: r.kind, state: stateOf(r), reason, createdBy: r.created_by, createdByName: names.get(r.created_by) ?? null, createdAt: r.created_at, expiresAt: r.expires_at, liftedBy: r.lifted_by, liftedAt: r.lifted_at };
  }

  private async names(tenantId: string, ids: string[]): Promise<Map<string, string>> {
    const rows = ids.length ? ((await this.db('users').where({ tenant_id: tenantId }).whereIn('id', [...new Set(ids)]).select('id', 'display_name', 'username')) as { id: string; display_name: string | null; username: string }[]) : [];
    return new Map(rows.map((u) => [u.id, u.display_name || u.username]));
  }

  /** The group's bans and suspensions, the standing ones by default (moderators). */
  async list(ctx: Ctx, id: string, state: 'active' | 'all' = 'active') {
    await this.s().groups.require(ctx.p, id, 'remove-members', { reading: true });
    const q = state === 'active' ? this.standing().andWhere({ group_id: id }) : this.db('group_bans').where({ group_id: id });
    const rows = ((await q.orderBy('created_at', 'desc').limit(500)) as Record<string, unknown>[]).map(from);
    const names = await this.names(ctx.p.tenantId, rows.flatMap((r) => [r.user_id, r.created_by]));
    return Promise.all(rows.map((r) => this.view(r, names, true)));
  }

  /**
   * Bans or suspends. Moderators act on members and on people outside the group; an owner (or `groups:manage`) also
   * on moderators. `days` is how long it stands; a ban without it stands until lifted.
   */
  async create(ctx: Ctx, id: string, input: { userId: string; kind: BanKind; days?: number | null | undefined; reason?: string | null | undefined }) {
    const s = this.s();
    const p = ctx.p;
    const a = await s.groups.require(p, id, 'remove-members');
    const g = a.group;
    if (input.userId === p.userId) throw badRequest('You cannot ban or suspend yourself; leave the group instead.');
    if (!(await this.db('users').where({ tenant_id: g.tenant_id, id: input.userId }).first('id'))) throw notFound('User');
    const m = await s.groups.member(g.id, input.userId);
    // B-9705: by the member's rights, not the tier's name. An owner is never barred; barring someone who holds more
    // than a member takes the right `roles` and never reaches a member who holds a right the caller does not.
    const held = m ? await s.groups.roles.rightsOf(g.id, m) : null;
    if (ownsGroup(held)) throw conflict('An owner is not banned or suspended; make them a moderator or a member first.');
    if (held && isStaff(held) && (!can(a, 'roles') || !covers(a.rights, held))) throw forbidden('Only an owner bans or suspends a moderator.', { step: 'group-role' });
    if (input.kind === 'suspend') {
      if (!m) throw conflict('Only a member is suspended; ban someone who is not a member.');
      if (!input.days) throw badRequest('A suspension has a length in days.');
      if (input.days > BAN_LIMITS.suspendDays) throw badRequest(`A suspension lasts at most ${BAN_LIMITS.suspendDays} days; ban for longer.`);
    }
    const banId = ulid();
    let reason: string | null = null;
    if (input.reason) {
      const d = await s.guardrails.check({ tenantId: g.tenant_id, workspaceId: g.workspace_id, checkpoint: 'user-input', text: input.reason, label: g.label, principal: p, source: { kind: GROUP_OBJECT, id: g.id }, meta: { objectType: GROUP_OBJECT, field: 'ban-reason', group: g.id } });
      if (d.action === 'block' || d.action === 'require-approval') throw new HttpProblem(422, 'Blocked by guardrails', d.reason ?? 'The reason was blocked by a guardrail rule.', { extensions: { step: 'guardrails', action: d.action, field: 'reason' } });
      reason = await s.keys.seal(g.tenant_id, d.action === 'redact' ? d.text : input.reason, `group-ban:${banId}`);
    }
    const now = Date.now();
    const row: BanRow = { id: banId, tenant_id: g.tenant_id, group_id: g.id, user_id: input.userId, kind: input.kind, reason, active_key: keyOf(g.id, input.userId), created_by: p.userId, created_at: now, expires_at: input.days ? now + Math.round(input.days * 86_400_000) : null, lifted_by: null, lifted_at: null };
    // One stands at a time. One past its time is ended by `active`, which makes room.
    const standing = await this.active(g.id, input.userId);
    if (standing) throw new HttpProblem(409, 'Conflict', `This person is already ${standing.kind === 'ban' ? 'banned' : 'suspended'} ${until(standing)}. Lift it first.`, { extensions: { step: 'ban', ban: standing.id } });
    // The channels the ban or suspension reaches (none for a channel's own).
    const channels = g.parent_id ? [] : ((await this.db('social_groups').where({ parent_id: g.id }).whereNot({ state: 'deleted' }).select('id')) as { id: string }[]).map((r) => r.id);
    const all = [g.id, ...channels];
    let removed = 0;
    let withdrawn = 0;
    try {
      await this.db.transaction(async (trx) => {
        await trx('group_bans').insert(row);
        if (input.kind === 'ban') {
          removed = await trx('group_members').whereIn('group_id', all).andWhere({ user_id: input.userId }).delete();
          withdrawn = await trx('group_requests').whereIn('group_id', all).andWhere({ user_id: input.userId, state: 'pending' }).update({ state: 'cancelled', pending_key: null, decided_by: p.userId, decided_at: now });
        }
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('This person was banned or suspended meanwhile.');
      throw err;
    }
    await s.audit.append({ tenantId: g.tenant_id, action: 'group.ban.created', kind: 'admin', actor: actorFrom(p, ctx.ip), target: { group: g.id, user: input.userId, ban: row.id }, label: g.label, detail: { kind: row.kind, expiresAt: row.expires_at, wasMember: !!m, removedMemberships: removed, withdrawn, hasReason: !!reason }, traceId: ctx.traceId ?? null });
    if (input.kind === 'ban' && m) {
      s.groups.event(g.tenant_id, 'group.member.removed', g.label, { group: g.id, workspace: g.workspace_id, actor: p.userId, user: input.userId });
      s.groups.room(g, 'group.member.removed', { userId: input.userId });
    }
    // Their sockets leave the rooms of the group and its channels at once.
    for (const gid of all) s.rooms.accessChanged({ tenantId: g.tenant_id, kind: 'group', id: gid, userIds: [input.userId] });
    // 1.7.0 (B-9709): a ban takes them out of the linked conversations; a suspension closes those to them for its time.
    for (const gid of all) {
      if (input.kind === 'ban') await s.groups.conversations.sync(gid);
      else await s.groups.conversations.standingChanged(gid, [input.userId]);
    }
    if (m && (await s.groups.eligible(g, input.userId)).ok) {
      await s.notifications.notify({ tenantId: g.tenant_id, userIds: [input.userId], kind: 'group.member', title: `You were ${row.kind === 'ban' ? 'banned from' : 'suspended from'} ${g.name} ${until(row)}`, route: 'groups', label: g.label });
    }
    return this.view(row, await this.names(g.tenant_id, [row.user_id, row.created_by]), true);
  }

  /** Lifts a standing ban or suspension: the person may come back (a suspended member is a member again at once). */
  async lift(ctx: Ctx, id: string, banId: string) {
    const s = this.s();
    const a = await s.groups.require(ctx.p, id, 'remove-members');
    const g = a.group;
    const r = await this.db('group_bans').where({ tenant_id: g.tenant_id, group_id: g.id, id: banId }).first();
    if (!r) throw notFound('Ban');
    const row = from(r);
    if (stateOf(row) !== 'active') throw conflict(`It is already ${stateOf(row)}.`);
    const m = await s.groups.member(g.id, row.user_id);
    const held = m ? await s.groups.roles.rightsOf(g.id, m) : null;
    if (held && isStaff(held) && (!can(a, 'roles') || !covers(a.rights, held))) throw forbidden('Only an owner lifts a moderator’s suspension.', { step: 'group-role' });
    const now = Date.now();
    const n = await this.db('group_bans').where({ id: row.id }).whereNotNull('active_key').update({ active_key: null, lifted_by: ctx.p.userId, lifted_at: now });
    if (!n) throw conflict('It ended meanwhile.');
    await s.audit.append({ tenantId: g.tenant_id, action: 'group.ban.lifted', kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target: { group: g.id, user: row.user_id, ban: row.id }, label: g.label, detail: { kind: row.kind, expiresAt: row.expires_at }, traceId: ctx.traceId ?? null });
    const channels = g.parent_id ? [] : ((await this.db('social_groups').where({ parent_id: g.id }).select('id')) as { id: string }[]).map((x) => x.id);
    for (const gid of [g.id, ...channels]) {
      s.rooms.accessChanged({ tenantId: g.tenant_id, kind: 'group', id: gid, userIds: [row.user_id] });
      // 1.7.0 (B-9709): a suspended member's conversations open to them again.
      await s.groups.conversations.standingChanged(gid, [row.user_id]);
    }
    if ((await s.groups.eligible(g, row.user_id)).ok) {
      await s.notifications.notify({ tenantId: g.tenant_id, userIds: [row.user_id], kind: 'group.member', title: row.kind === 'ban' ? `Your ban from ${g.name} was lifted` : `Your suspension from ${g.name} was lifted`, route: `groups?id=${g.id}`, label: g.label });
    }
    const after = from((await this.db('group_bans').where({ id: row.id }).first()) as Record<string, unknown>);
    return this.view(after, await this.names(g.tenant_id, [after.user_id, after.created_by]), true);
  }
}
