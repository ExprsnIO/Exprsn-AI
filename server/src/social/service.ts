import { ulid } from 'ulid';
import { actorFrom, isUniqueViolation } from '../audit/chain.js';
import type { Principal } from '../authz/policy.js';
import { workspacesFor } from '../http/middleware.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { TOPICS } from '../platform/bus.js';
import type { RoomEvent } from '../realtime/rooms.js';
import type { Services } from '../services.js';

/*
 * Social relations (B-2606 with B-2702), shared by messaging and the workspace feed: blocks, mutes, follows, lists and
 * each user's contact rule. Everything is per tenant: a relation names two users of the same tenant, and the tenant
 * always comes from the caller's session.
 *
 * - A block works both ways. `isBlocked(tenantId, a, b)` is true whoever blocked whom, and it is the one check
 *   messaging (sending, starting conversations, listing messages, socket delivery) and the feed (posts, comments,
 *   feeds, socket delivery) both call. Blocking also ends follows in both directions. The blocked person is never told.
 * - A mute is one-way and private: the muter stops seeing the other's posts in the home feed and stops being notified
 *   of their messages. It may expire.
 * - Follows and list members must be people the caller shares a workspace with (workspace membership stays the outer
 *   boundary); blocks and mutes may name anyone active in the tenant.
 * - The contact rule says who may start a conversation with a user or add them to one: `workspace` (anyone who shares
 *   a workspace with them, the default), `following` (only people they follow) or `nobody`. A block refuses as
 *   `nobody` does, with the same words, so the refusal does not tell a blocked person they are blocked.
 *
 * Socket delivery: `emitToRoom` publishes a room event with the people in a block with the actor left out
 * (`exceptUserIds`), decided where the event is raised, so every instance relays the same filtered event (the
 * platform's BUG-080 delivered typing and presence to people who had blocked the sender).
 */

export const CONTACT_RULES = ['workspace', 'following', 'nobody'] as const;
export type ContactRule = (typeof CONTACT_RULES)[number];
export const DEFAULT_CONTACT_RULE: ContactRule = 'workspace';

/** Limits per user, so a relation set stays small enough to load whole into a filter. */
export const LIMITS = { blocks: 5000, mutes: 5000, follows: 5000, lists: 100, listMembers: 1000 } as const;

export type RelationKind = 'block' | 'mute' | 'follow';

/** Published on `TOPICS.socialRelation` (every instance) whenever a block, mute or follow is made or removed. */
export interface SocialRelationEvent {
  tenantId: string;
  kind: RelationKind;
  userId: string;
  targetId: string;
  on: boolean;
}

export interface Ctx {
  p: Principal;
  ip: string | null;
  traceId?: string | null;
}

export interface ListRow {
  id: string;
  tenant_id: string;
  owner_id: string;
  name: string;
  name_key: string;
  description: string | null;
  created_at: number;
  updated_at: number;
}

export type ContactDecision = { ok: true } | { ok: false; status: 403 | 404; why: string; step: 'contact' | 'workspace' | 'self' };

const num = (v: unknown) => Number(v);
const listFrom = (r: Record<string, unknown>): ListRow => ({ ...(r as unknown as ListRow), created_at: num(r.created_at), updated_at: num(r.updated_at) });
export const listView = (l: ListRow, members?: number) => ({ id: l.id, name: l.name, description: l.description, createdAt: l.created_at, updatedAt: l.updated_at, ...(members !== undefined ? { members } : {}) });

/** The refusal for a contact rule and for a block alike. */
const NOT_ACCEPTING = 'This person does not accept messages from you.';

export class SocialService {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  private async audit(ctx: Ctx, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>): Promise<void> {
    await this.s().audit.append({ tenantId: ctx.p.tenantId, action, kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target, ...(detail ? { detail } : {}), label: 'internal', traceId: ctx.traceId ?? null });
  }

  private changed(e: SocialRelationEvent): void {
    this.s().bus.publish(TOPICS.socialRelation, e);
  }

  // ---------- the shared checks (messaging, the feed, sockets) ----------

  /** True when either user blocked the other. */
  async isBlocked(tenantId: string, a: string, b: string): Promise<boolean> {
    if (a === b) return false;
    const r = await this.db('social_blocks')
      .where({ tenant_id: tenantId })
      .andWhere((q) => q.where({ user_id: a, target_id: b }).orWhere({ user_id: b, target_id: a }))
      .first('user_id');
    return !!r;
  }

  /** Everyone in a block with this user, in either direction. */
  async blockedWith(tenantId: string, userId: string): Promise<Set<string>> {
    const rows = (await this.db('social_blocks')
      .where({ tenant_id: tenantId })
      .andWhere((q) => q.where({ user_id: userId }).orWhere({ target_id: userId }))
      .select('user_id', 'target_id')) as { user_id: string; target_id: string }[];
    return new Set(rows.map((r) => (r.user_id === userId ? r.target_id : r.user_id)));
  }

  /** Of `userIds`, those in a block with `userId` (either direction). */
  async blockedAmong(tenantId: string, userId: string, userIds: string[]): Promise<Set<string>> {
    const ids = [...new Set(userIds)].filter((u) => u !== userId);
    if (!ids.length) return new Set();
    const out = new Set<string>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = (await this.db('social_blocks')
        .where({ tenant_id: tenantId })
        .andWhere((q) => q.where((a) => a.where({ user_id: userId }).whereIn('target_id', chunk)).orWhere((b) => b.where({ target_id: userId }).whereIn('user_id', chunk)))
        .select('user_id', 'target_id')) as { user_id: string; target_id: string }[];
      for (const r of rows) out.add(r.user_id === userId ? r.target_id : r.user_id);
    }
    return out;
  }

  /** The people this user muted, now (expired mutes left out). */
  async mutedBy(tenantId: string, userId: string): Promise<Set<string>> {
    const now = Date.now();
    const rows = (await this.db('social_mutes')
      .where({ tenant_id: tenantId, user_id: userId })
      .andWhere((q) => q.whereNull('expires_at').orWhere('expires_at', '>', now))
      .select('target_id')) as { target_id: string }[];
    return new Set(rows.map((r) => r.target_id));
  }

  /** Has `userId` muted `targetId` (now)? */
  async isMuted(tenantId: string, userId: string, targetId: string): Promise<boolean> {
    const r = (await this.db('social_mutes').where({ tenant_id: tenantId, user_id: userId, target_id: targetId }).first('expires_at')) as { expires_at: number | string | null } | undefined;
    return !!r && (r.expires_at == null || Number(r.expires_at) > Date.now());
  }

  /** The people this user follows. */
  async following(tenantId: string, userId: string): Promise<Set<string>> {
    const rows = (await this.db('social_follows').where({ tenant_id: tenantId, user_id: userId }).select('target_id')) as { target_id: string }[];
    return new Set(rows.map((r) => r.target_id));
  }

  /** The people following this user. */
  async followers(tenantId: string, userId: string): Promise<Set<string>> {
    const rows = (await this.db('social_follows').where({ tenant_id: tenantId, target_id: userId }).select('user_id')) as { user_id: string }[];
    return new Set(rows.map((r) => r.user_id));
  }

  async isFollowing(tenantId: string, userId: string, targetId: string): Promise<boolean> {
    return !!(await this.db('social_follows').where({ tenant_id: tenantId, user_id: userId, target_id: targetId }).first('user_id'));
  }

  /** Who a viewer should not see content from: everyone in a block with them, and everyone they muted. */
  async hiddenFor(tenantId: string, viewerId: string): Promise<Set<string>> {
    const [blocked, muted] = await Promise.all([this.blockedWith(tenantId, viewerId), this.mutedBy(tenantId, viewerId)]);
    for (const m of muted) blocked.add(m);
    return blocked;
  }

  /** The members of a list, for its owner only (null when the list is not theirs or does not exist). */
  async listMembers(tenantId: string, ownerId: string, listId: string): Promise<string[] | null> {
    const l = await this.db('social_lists').where({ tenant_id: tenantId, id: listId, owner_id: ownerId }).first('id');
    if (!l) return null;
    return ((await this.db('social_list_members').where({ list_id: listId }).orderBy('added_at').select('user_id')) as { user_id: string }[]).map((r) => r.user_id);
  }

  async inList(tenantId: string, listId: string, userId: string): Promise<boolean> {
    return !!(await this.db('social_list_members').where({ tenant_id: tenantId, list_id: listId, user_id: userId }).first('user_id'));
  }

  async contactRule(tenantId: string, userId: string): Promise<ContactRule> {
    const r = (await this.db('social_settings').where({ tenant_id: tenantId, user_id: userId }).first('contact_rule')) as { contact_rule: string } | undefined;
    return (CONTACT_RULES as readonly string[]).includes(r?.contact_rule ?? '') ? (r!.contact_rule as ContactRule) : DEFAULT_CONTACT_RULE;
  }

  /** The workspaces the caller may act in that the other user is a member of. */
  async sharedWorkspaces(p: Principal, otherId: string): Promise<string[]> {
    const s = this.s();
    const mine = new Set((await workspacesFor(s, p)).map((w) => w.id));
    return (await s.tenants.workspacesForUser(p.tenantId, otherId)).map((w) => w.id).filter((w) => mine.has(w));
  }

  /**
   * May the caller start a conversation with `targetId` or add them to one? The target must be active in the tenant
   * and share a workspace with the caller (else 404, as if unknown); then neither may block the other and the
   * target's contact rule must admit the caller (else 403 with the same words either way).
   */
  async mayContact(p: Principal, targetId: string): Promise<ContactDecision> {
    if (targetId === p.userId) return { ok: false, status: 403, why: 'That is you.', step: 'self' };
    if (!(await this.activeUser(p.tenantId, targetId))) return { ok: false, status: 404, why: 'User not found.', step: 'workspace' };
    if (!(await this.sharedWorkspaces(p, targetId)).length) return { ok: false, status: 404, why: 'User not found.', step: 'workspace' };
    if (await this.isBlocked(p.tenantId, p.userId, targetId)) return { ok: false, status: 403, why: NOT_ACCEPTING, step: 'contact' };
    const rule = await this.contactRule(p.tenantId, targetId);
    if (rule === 'nobody') return { ok: false, status: 403, why: NOT_ACCEPTING, step: 'contact' };
    if (rule === 'following' && !(await this.isFollowing(p.tenantId, targetId, p.userId))) return { ok: false, status: 403, why: NOT_ACCEPTING, step: 'contact' };
    return { ok: true };
  }

  /** `mayContact` as a refusal (problem+json) when it says no. */
  async requireContact(p: Principal, targetId: string): Promise<void> {
    const d = await this.mayContact(p, targetId);
    if (d.ok) return;
    if (d.status === 404) throw notFound('User');
    throw forbidden(d.why, { step: d.step });
  }

  /**
   * Publishes a room event (B-2101) from `actorId`, left out for everyone in a block with the actor (on every
   * instance: the filter travels with the event). Domains raise people's events through this, never `rooms.emit`.
   */
  async emitToRoom(e: RoomEvent, actorId: string): Promise<void> {
    const blocked = await this.blockedWith(e.tenantId, actorId);
    this.s().rooms.emit({ ...e, ...(blocked.size ? { exceptUserIds: [...new Set([...(e.exceptUserIds ?? []), ...blocked])] } : {}) });
  }

  // ---------- targets ----------

  private async activeUser(tenantId: string, id: string): Promise<{ id: string; username: string; display_name: string } | null> {
    const u = (await this.db('users').where({ tenant_id: tenantId, id, state: 'active' }).first('id', 'username', 'display_name')) as { id: string; username: string; display_name: string } | undefined;
    return u ?? null;
  }

  /** A target for a block or mute: any other active user of the tenant. */
  private async anyone(p: Principal, targetId: string): Promise<void> {
    if (targetId === p.userId) throw new HttpProblem(422, 'Not yourself', 'You cannot do this to yourself.');
    if (!(await this.activeUser(p.tenantId, targetId))) throw notFound('User');
  }

  /** A target for a follow or a list: someone the caller shares a workspace with, not in a block with them. */
  private async visible(p: Principal, targetId: string): Promise<void> {
    await this.anyone(p, targetId);
    if (!(await this.sharedWorkspaces(p, targetId)).length) throw notFound('User');
    const r = (await this.db('social_blocks').where({ tenant_id: p.tenantId, user_id: p.userId, target_id: targetId }).first('user_id')) as unknown;
    if (r) throw conflict('You blocked this person; unblock them first.');
    // Blocked by them: as if they were not there.
    if (await this.isBlocked(p.tenantId, p.userId, targetId)) throw notFound('User');
  }

  private async count(table: string, where: Record<string, unknown>): Promise<number> {
    const r = (await this.db(table).where(where).count({ n: '*' })) as { n: number | string }[];
    return Number(r[0]?.n ?? 0);
  }

  private async people(tenantId: string, ids: string[]): Promise<Map<string, { username: string; displayName: string }>> {
    const out = new Map<string, { username: string; displayName: string }>();
    for (let i = 0; i < ids.length; i += 500) {
      const rows = (await this.db('users').where({ tenant_id: tenantId }).whereIn('id', ids.slice(i, i + 500)).select('id', 'username', 'display_name')) as { id: string; username: string; display_name: string }[];
      for (const r of rows) out.set(r.id, { username: r.username, displayName: r.display_name });
    }
    return out;
  }

  // ---------- blocks ----------

  async blocks(p: Principal) {
    const rows = (await this.db('social_blocks').where({ tenant_id: p.tenantId, user_id: p.userId }).orderBy('created_at', 'desc').select('target_id', 'created_at')) as { target_id: string; created_at: number }[];
    const who = await this.people(p.tenantId, rows.map((r) => r.target_id));
    return rows.map((r) => ({ userId: r.target_id, ...(who.get(r.target_id) ?? { username: null, displayName: null }), createdAt: Number(r.created_at) }));
  }

  async block(ctx: Ctx, targetId: string): Promise<{ userId: string; blocked: true; created: boolean }> {
    const p = ctx.p;
    await this.anyone(p, targetId);
    if (await this.db('social_blocks').where({ tenant_id: p.tenantId, user_id: p.userId, target_id: targetId }).first('user_id')) return { userId: targetId, blocked: true, created: false };
    if ((await this.count('social_blocks', { tenant_id: p.tenantId, user_id: p.userId })) >= LIMITS.blocks) throw conflict(`You can block at most ${LIMITS.blocks} people.`);
    try {
      await this.db.transaction(async (trx) => {
        await trx('social_blocks').insert({ tenant_id: p.tenantId, user_id: p.userId, target_id: targetId, created_at: Date.now() });
        // A block ends follows both ways.
        await trx('social_follows').where({ tenant_id: p.tenantId }).andWhere((q) => q.where({ user_id: p.userId, target_id: targetId }).orWhere({ user_id: targetId, target_id: p.userId })).delete();
      });
    } catch (err) {
      if (isUniqueViolation(err)) return { userId: targetId, blocked: true, created: false };
      throw err;
    }
    await this.audit(ctx, 'social.block.created', { user: targetId });
    this.changed({ tenantId: p.tenantId, kind: 'block', userId: p.userId, targetId, on: true });
    return { userId: targetId, blocked: true, created: true };
  }

  async unblock(ctx: Ctx, targetId: string): Promise<{ userId: string; blocked: false }> {
    const p = ctx.p;
    const n = await this.db('social_blocks').where({ tenant_id: p.tenantId, user_id: p.userId, target_id: targetId }).delete();
    if (!n) throw notFound('Block');
    await this.audit(ctx, 'social.block.removed', { user: targetId });
    this.changed({ tenantId: p.tenantId, kind: 'block', userId: p.userId, targetId, on: false });
    return { userId: targetId, blocked: false };
  }

  // ---------- mutes ----------

  async mutes(p: Principal) {
    const now = Date.now();
    const rows = (await this.db('social_mutes').where({ tenant_id: p.tenantId, user_id: p.userId }).andWhere((q) => q.whereNull('expires_at').orWhere('expires_at', '>', now)).orderBy('created_at', 'desc').select('target_id', 'expires_at', 'created_at')) as { target_id: string; expires_at: number | null; created_at: number }[];
    const who = await this.people(p.tenantId, rows.map((r) => r.target_id));
    return rows.map((r) => ({ userId: r.target_id, ...(who.get(r.target_id) ?? { username: null, displayName: null }), expiresAt: r.expires_at == null ? null : Number(r.expires_at), createdAt: Number(r.created_at) }));
  }

  async mute(ctx: Ctx, targetId: string, expiresAt: number | null): Promise<{ userId: string; muted: true; expiresAt: number | null }> {
    const p = ctx.p;
    await this.anyone(p, targetId);
    if (expiresAt != null && expiresAt <= Date.now()) throw new HttpProblem(422, 'In the past', 'A mute must end in the future (or not at all).');
    const existing = await this.db('social_mutes').where({ tenant_id: p.tenantId, user_id: p.userId, target_id: targetId }).first('target_id');
    if (existing) await this.db('social_mutes').where({ tenant_id: p.tenantId, user_id: p.userId, target_id: targetId }).update({ expires_at: expiresAt });
    else {
      if ((await this.count('social_mutes', { tenant_id: p.tenantId, user_id: p.userId })) >= LIMITS.mutes) {
        // Expired mutes make room.
        await this.db('social_mutes').where({ tenant_id: p.tenantId, user_id: p.userId }).andWhere('expires_at', '<=', Date.now()).delete();
        if ((await this.count('social_mutes', { tenant_id: p.tenantId, user_id: p.userId })) >= LIMITS.mutes) throw conflict(`You can mute at most ${LIMITS.mutes} people.`);
      }
      try {
        await this.db('social_mutes').insert({ tenant_id: p.tenantId, user_id: p.userId, target_id: targetId, expires_at: expiresAt, created_at: Date.now() });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        await this.db('social_mutes').where({ tenant_id: p.tenantId, user_id: p.userId, target_id: targetId }).update({ expires_at: expiresAt });
      }
    }
    await this.audit(ctx, 'social.mute.created', { user: targetId }, { expiresAt });
    this.changed({ tenantId: p.tenantId, kind: 'mute', userId: p.userId, targetId, on: true });
    return { userId: targetId, muted: true, expiresAt };
  }

  async unmute(ctx: Ctx, targetId: string): Promise<{ userId: string; muted: false }> {
    const p = ctx.p;
    const n = await this.db('social_mutes').where({ tenant_id: p.tenantId, user_id: p.userId, target_id: targetId }).delete();
    if (!n) throw notFound('Mute');
    await this.audit(ctx, 'social.mute.removed', { user: targetId });
    this.changed({ tenantId: p.tenantId, kind: 'mute', userId: p.userId, targetId, on: false });
    return { userId: targetId, muted: false };
  }

  // ---------- follows ----------

  async followingList(p: Principal) {
    const rows = (await this.db('social_follows').where({ tenant_id: p.tenantId, user_id: p.userId }).orderBy('created_at', 'desc').select('target_id', 'created_at')) as { target_id: string; created_at: number }[];
    const who = await this.people(p.tenantId, rows.map((r) => r.target_id));
    return rows.map((r) => ({ userId: r.target_id, ...(who.get(r.target_id) ?? { username: null, displayName: null }), since: Number(r.created_at) }));
  }

  /** The caller's followers (people in a block with the caller are left out: a block ends follows anyway). */
  async followersList(p: Principal) {
    const rows = (await this.db('social_follows').where({ tenant_id: p.tenantId, target_id: p.userId }).orderBy('created_at', 'desc').select('user_id', 'created_at')) as { user_id: string; created_at: number }[];
    const who = await this.people(p.tenantId, rows.map((r) => r.user_id));
    return rows.map((r) => ({ userId: r.user_id, ...(who.get(r.user_id) ?? { username: null, displayName: null }), since: Number(r.created_at) }));
  }

  async follow(ctx: Ctx, targetId: string): Promise<{ userId: string; following: true; created: boolean }> {
    const p = ctx.p;
    await this.visible(p, targetId);
    if (await this.isFollowing(p.tenantId, p.userId, targetId)) return { userId: targetId, following: true, created: false };
    if ((await this.count('social_follows', { tenant_id: p.tenantId, user_id: p.userId })) >= LIMITS.follows) throw conflict(`You can follow at most ${LIMITS.follows} people.`);
    try {
      await this.db('social_follows').insert({ tenant_id: p.tenantId, user_id: p.userId, target_id: targetId, created_at: Date.now() });
    } catch (err) {
      if (isUniqueViolation(err)) return { userId: targetId, following: true, created: false };
      throw err;
    }
    await this.audit(ctx, 'social.follow.created', { user: targetId });
    this.changed({ tenantId: p.tenantId, kind: 'follow', userId: p.userId, targetId, on: true });
    return { userId: targetId, following: true, created: true };
  }

  async unfollow(ctx: Ctx, targetId: string): Promise<{ userId: string; following: false }> {
    const p = ctx.p;
    const n = await this.db('social_follows').where({ tenant_id: p.tenantId, user_id: p.userId, target_id: targetId }).delete();
    if (!n) throw notFound('Follow');
    await this.audit(ctx, 'social.follow.removed', { user: targetId });
    this.changed({ tenantId: p.tenantId, kind: 'follow', userId: p.userId, targetId, on: false });
    return { userId: targetId, following: false };
  }

  // ---------- lists ----------

  private async ownList(p: Principal, id: string): Promise<ListRow> {
    const r = await this.db('social_lists').where({ tenant_id: p.tenantId, id, owner_id: p.userId }).first();
    if (!r) throw notFound('List');
    return listFrom(r);
  }

  async lists(p: Principal) {
    const rows = ((await this.db('social_lists').where({ tenant_id: p.tenantId, owner_id: p.userId }).orderBy('name_key')) as Record<string, unknown>[]).map(listFrom);
    const counts = new Map<string, number>();
    if (rows.length) {
      const c = (await this.db('social_list_members').whereIn('list_id', rows.map((l) => l.id)).groupBy('list_id').select('list_id').count({ n: '*' })) as { list_id: string; n: number | string }[];
      for (const r of c) counts.set(r.list_id, Number(r.n));
    }
    return rows.map((l) => listView(l, counts.get(l.id) ?? 0));
  }

  async getList(p: Principal, id: string) {
    const l = await this.ownList(p, id);
    const ids = (await this.listMembers(p.tenantId, p.userId, id)) ?? [];
    const who = await this.people(p.tenantId, ids);
    return { ...listView(l, ids.length), people: ids.map((u) => ({ userId: u, ...(who.get(u) ?? { username: null, displayName: null }) })) };
  }

  async createList(ctx: Ctx, input: { name: string; description?: string | null | undefined }) {
    const p = ctx.p;
    if ((await this.count('social_lists', { tenant_id: p.tenantId, owner_id: p.userId })) >= LIMITS.lists) throw conflict(`You can keep at most ${LIMITS.lists} lists.`);
    const t = Date.now();
    const row: ListRow = { id: ulid(), tenant_id: p.tenantId, owner_id: p.userId, name: input.name, name_key: input.name.toLowerCase(), description: input.description ?? null, created_at: t, updated_at: t };
    try {
      await this.db('social_lists').insert(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('You already have a list with that name.');
      throw err;
    }
    await this.audit(ctx, 'social.list.created', { list: row.id });
    return listView(row, 0);
  }

  async updateList(ctx: Ctx, id: string, patch: { name?: string | undefined; description?: string | null | undefined }) {
    const p = ctx.p;
    const l = await this.ownList(p, id);
    const upd: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.name !== undefined) Object.assign(upd, { name: patch.name, name_key: patch.name.toLowerCase() });
    if (patch.description !== undefined) upd.description = patch.description;
    try {
      await this.db('social_lists').where({ id: l.id }).update(upd);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('You already have a list with that name.');
      throw err;
    }
    await this.audit(ctx, 'social.list.updated', { list: l.id }, { changed: Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined) });
    return this.getList(p, id);
  }

  async deleteList(ctx: Ctx, id: string) {
    const l = await this.ownList(ctx.p, id);
    await this.db.transaction(async (trx) => {
      await trx('social_list_members').where({ list_id: l.id }).delete();
      await trx('social_lists').where({ id: l.id }).delete();
    });
    await this.audit(ctx, 'social.list.deleted', { list: l.id });
    return { id: l.id, deleted: true };
  }

  async addToList(ctx: Ctx, id: string, userId: string) {
    const p = ctx.p;
    const l = await this.ownList(p, id);
    await this.visible(p, userId);
    if (await this.inList(p.tenantId, l.id, userId)) return { listId: l.id, userId, added: false };
    if ((await this.count('social_list_members', { list_id: l.id })) >= LIMITS.listMembers) throw conflict(`A list holds at most ${LIMITS.listMembers} people.`);
    try {
      await this.db('social_list_members').insert({ list_id: l.id, tenant_id: p.tenantId, user_id: userId, added_at: Date.now() });
    } catch (err) {
      if (isUniqueViolation(err)) return { listId: l.id, userId, added: false };
      throw err;
    }
    await this.db('social_lists').where({ id: l.id }).update({ updated_at: Date.now() });
    await this.audit(ctx, 'social.list.member.added', { list: l.id, user: userId });
    return { listId: l.id, userId, added: true };
  }

  async removeFromList(ctx: Ctx, id: string, userId: string) {
    const l = await this.ownList(ctx.p, id);
    const n = await this.db('social_list_members').where({ list_id: l.id, user_id: userId }).delete();
    if (!n) throw notFound('List member');
    await this.audit(ctx, 'social.list.member.removed', { list: l.id, user: userId });
    return { listId: l.id, userId, removed: true };
  }

  // ---------- settings ----------

  async settings(p: Principal) {
    return { contactRule: await this.contactRule(p.tenantId, p.userId) };
  }

  async setContactRule(ctx: Ctx, rule: ContactRule) {
    const p = ctx.p;
    const before = await this.contactRule(p.tenantId, p.userId);
    const t = Date.now();
    const n = await this.db('social_settings').where({ tenant_id: p.tenantId, user_id: p.userId }).update({ contact_rule: rule, updated_at: t });
    if (!n) {
      try {
        await this.db('social_settings').insert({ tenant_id: p.tenantId, user_id: p.userId, contact_rule: rule, updated_at: t });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        await this.db('social_settings').where({ tenant_id: p.tenantId, user_id: p.userId }).update({ contact_rule: rule, updated_at: t });
      }
    }
    if (before !== rule) await this.audit(ctx, 'social.contact-rule.updated', { user: p.userId }, { before, after: rule });
    return { contactRule: rule };
  }

  /** The caller's relation with one person (for a profile card): blocking, muting, following, followed by, can message. */
  async relation(p: Principal, targetId: string) {
    if (!(await this.activeUser(p.tenantId, targetId))) throw notFound('User');
    const blocking = !!(await this.db('social_blocks').where({ tenant_id: p.tenantId, user_id: p.userId, target_id: targetId }).first('user_id'));
    const muting = await this.isMuted(p.tenantId, p.userId, targetId);
    // Someone the caller does not share a workspace with is unknown to them, unless they blocked or muted them.
    if (!blocking && !muting && targetId !== p.userId && !(await this.sharedWorkspaces(p, targetId)).length) throw notFound('User');
    const blocked = blocking || (await this.isBlocked(p.tenantId, p.userId, targetId));
    const [following, followedBy, contact] = await Promise.all([this.isFollowing(p.tenantId, p.userId, targetId), this.isFollowing(p.tenantId, targetId, p.userId), this.mayContact(p, targetId)]);
    // Being blocked by them is never shown as such: it reads as "cannot message".
    return { userId: targetId, blocking, muting, following: blocked ? false : following, followedBy: blocked ? false : followedBy, canMessage: contact.ok };
  }

  // ---------- administration (`social:manage`) ----------

  /** A user's relations for a tenant admin (counts, and the people in each), audited as a read of private data. */
  async adminView(ctx: Ctx, userId: string) {
    const p = ctx.p;
    const u = (await this.db('users').where({ tenant_id: p.tenantId, id: userId }).first('id', 'username', 'display_name')) as { id: string; username: string; display_name: string } | undefined;
    if (!u) throw notFound('User');
    const ids = async (table: string, col: 'user_id' | 'target_id', where: Record<string, unknown>) => ((await this.db(table).where({ tenant_id: p.tenantId, ...where }).select(col)) as Record<string, string>[]).map((r) => r[col]!);
    const out = {
      userId: u.id,
      username: u.username,
      contactRule: await this.contactRule(p.tenantId, u.id),
      blocks: await ids('social_blocks', 'target_id', { user_id: u.id }),
      blockedBy: await ids('social_blocks', 'user_id', { target_id: u.id }),
      mutes: [...(await this.mutedBy(p.tenantId, u.id))],
      following: await ids('social_follows', 'target_id', { user_id: u.id }),
      followers: await ids('social_follows', 'user_id', { target_id: u.id }),
      lists: (await this.db('social_lists').where({ tenant_id: p.tenantId, owner_id: u.id }).count({ n: '*' }).then((r) => Number((r as { n: number | string }[])[0]?.n ?? 0)))
    };
    await this.s().audit.append({ tenantId: p.tenantId, action: 'social.relations.viewed', kind: 'admin', actor: actorFrom(p, ctx.ip), target: { user: u.id }, label: 'internal', traceId: ctx.traceId ?? null });
    return out;
  }
}
