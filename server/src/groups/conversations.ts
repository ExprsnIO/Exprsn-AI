import { ulid } from 'ulid';
import { actorFrom, isUniqueViolation } from '../audit/chain.js';
import { clears, labelRank, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { DmRole } from '../messaging/service.js';
import type { Services } from '../services.js';
import { can, linkRole } from './roles.js';
import type { Ctx, GroupRow } from './service.js';

/*
 * 1.7.0 (B-9709, GRP-21): a group's linked conversation.
 *
 * A group has at most one conversation linked to it, and a conversation is linked to at most one group
 * (`group_conversations`). While the link stands the conversation's members are the group's members:
 *
 * - `dm_members` is kept in step. Every change of the group's membership (a join, an accepted request or invitation, an
 *   invite link, leaving, a removal, a ban) ends in `sync`, which adds who is missing and removes who is no longer a
 *   member. It compares the two lists, so a missed call is put right by the next one.
 * - Every read asks the group as well. `standing` gives the caller's role in the conversation from their standing in
 *   the group now: nobody without a membership in effect gets in, whatever `dm_members` says. A suspension leaves the
 *   membership in place and without effect (B-9701), so a suspended member loses the conversation for that time and has
 *   it back, with their read position, when it ends. A ban removes the membership, and so the member.
 * - Roles follow too: an owner of the group is an owner of the conversation, a moderator an admin, a member a member.
 *   They are read from the group each time; `dm_members.role` is written back only when the link is removed.
 * - Nobody is added to or removed from a linked conversation directly, and nobody leaves it: they join or leave the
 *   group (the messaging service refuses, naming the group).
 *
 * History. A member reads from the time they came into the conversation: someone who joins the group later, or leaves
 * and joins again, reads from then on. What they wrote before stays in the conversation for the others.
 *
 * Label. The conversation's label is never below the group's: a link is refused when it would be, and so is raising
 * the group's label above its conversation's.
 *
 * Linking is an owner's action and is audited. A conversation that exists may be linked by someone who owns both it and
 * the group. Its members who are not members of the group stay out of the link: it is refused, naming how many there
 * are, unless the owner says to remove them (`removeOthers`), which the audit entry counts.
 */

// 1.7.0 (B-9705): a member's role in the conversation comes from their rights in the group (`linkRole` in roles.ts):
// who owns the group owns it, who moderates the group (moderators, admins, a custom role with `moderate`) administers
// it, and everyone else, guests included, is a member of it.

export interface LinkRow {
  group_id: string;
  tenant_id: string;
  conversation_id: string;
  created_by: string;
  created_at: number;
}

const from = (r: Record<string, unknown>): LinkRow => ({ ...(r as unknown as LinkRow), created_at: Number(r.created_at) });

export class GroupConversations {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  /** The link of a conversation, if it has one. */
  async ofConversation(conversationId: string): Promise<LinkRow | null> {
    const r = await this.db('group_conversations').where({ conversation_id: conversationId }).first();
    return r ? from(r) : null;
  }

  async ofGroup(groupId: string): Promise<LinkRow | null> {
    const r = await this.db('group_conversations').where({ group_id: groupId }).first();
    return r ? from(r) : null;
  }

  /**
   * The caller's role in a linked conversation, from their standing in the group now; null when their membership is
   * not in effect (not a member, suspended, banned, or the group is closed to them).
   */
  async standing(p: Principal, link: Pick<LinkRow, 'group_id'>): Promise<DmRole | null> {
    const a = await this.s().groups.accessOrNull(p, link.group_id);
    return a?.role ? linkRole(a.rights) : null;
  }

  /** Of these members of a linked conversation, the ones whose membership of the group is in effect now. */
  async inEffect(link: Pick<LinkRow, 'group_id' | 'tenant_id'>, userIds: string[]): Promise<string[]> {
    const s = this.s();
    if (!userIds.length) return [];
    const g = await s.groups.row(link.tenant_id, link.group_id);
    if (!g || g.state === 'deleted') return [];
    const barred = new Set(((await s.groups.bans.barredUsersQuery(g).whereIn('user_id', userIds)) as { user_id: string }[]).map((r) => r.user_id));
    const members = new Set(((await this.db('group_members').where({ group_id: g.id }).whereIn('user_id', userIds).select('user_id')) as { user_id: string }[]).map((r) => r.user_id));
    return userIds.filter((u) => members.has(u) && !barred.has(u));
  }

  /** Refuses a change of members made in the conversation itself. */
  async assertUnlinked(conversationId: string): Promise<void> {
    const link = await this.ofConversation(conversationId);
    if (!link) return;
    const g = await this.s().groups.row(link.tenant_id, link.group_id);
    throw new HttpProblem(409, 'Linked to a group', `This conversation’s members are the members of ${g?.name ?? 'a group'}: join or leave the group, or change roles there.`, { extensions: { step: 'group-link', group: link.group_id } });
  }

  /** Raising a group's label above its conversation's is refused (B-9709). */
  async assertLabel(g: Pick<GroupRow, 'id' | 'tenant_id'>, label: Label): Promise<void> {
    const link = await this.ofGroup(g.id);
    if (!link) return;
    const conv = await this.s().messaging.row(g.tenant_id, link.conversation_id);
    if (conv && labelRank(conv.label) < labelRank(label)) throw new HttpProblem(422, 'Label above the conversation’s', `The group’s conversation is labelled ${conv.label}. A linked conversation is never labelled below its group: remove the link first.`, { extensions: { step: 'label-floor', conversation: conv.id } });
  }

  // ---------- keeping the members in step ----------

  /**
   * Makes the conversation's members the group's members: adds who is missing (reading from now) and removes who is no
   * longer a member. Safe to call at any time and more than once.
   */
  async sync(groupId: string): Promise<{ added: string[]; removed: string[] }> {
    const s = this.s();
    const link = await this.ofGroup(groupId);
    if (!link) return { added: [], removed: [] };
    const rights = await s.groups.roles.rightsOfAll(groupId);
    const members = [...rights.keys()].map((user_id) => ({ user_id }));
    const have = new Set(((await this.db('dm_members').where({ conversation_id: link.conversation_id }).select('user_id')) as { user_id: string }[]).map((r) => r.user_id));
    const want = new Set(members.map((m) => m.user_id));
    const t = Date.now();
    const added: string[] = [];
    for (const m of members) {
      if (have.has(m.user_id)) continue;
      try {
        await this.db('dm_members').insert({ conversation_id: link.conversation_id, tenant_id: link.tenant_id, user_id: m.user_id, role: linkRole(rights.get(m.user_id)!), added_by: null, joined_at: t, visible_from: t, notify: 'all' });
        added.push(m.user_id);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    const removed = [...have].filter((u) => !want.has(u));
    if (removed.length) await this.db('dm_members').where({ conversation_id: link.conversation_id }).whereIn('user_id', removed).delete();
    if (added.length || removed.length) {
      // Their sockets are let into, or put out of, the conversation's room now.
      s.rooms.accessChanged({ tenantId: link.tenant_id, kind: 'conversation', id: link.conversation_id, userIds: [...added, ...removed] });
      for (const userId of added) s.rooms.emit({ tenantId: link.tenant_id, kind: 'conversation', id: link.conversation_id, event: 'conversation.member.added', data: { userId } });
      for (const userId of removed) s.rooms.emit({ tenantId: link.tenant_id, kind: 'conversation', id: link.conversation_id, event: 'conversation.member.removed', data: { userId } });
    }
    return { added, removed };
  }

  /** A membership changed in effect only (a suspension, or its end): the person's sockets are checked again. */
  async standingChanged(groupId: string, userIds: string[]): Promise<void> {
    const link = await this.ofGroup(groupId);
    if (link) this.s().rooms.accessChanged({ tenantId: link.tenant_id, kind: 'conversation', id: link.conversation_id, userIds });
  }

  // ---------- linking ----------

  /** What a member is shown of the group's conversation. */
  async view(p: Principal, groupId: string) {
    const s = this.s();
    const a = await s.groups.access(p, groupId);
    const link = await this.ofGroup(groupId);
    if (!link || (!a.role && !a.manager)) return { linked: false as const, canLink: can(a, 'settings') };
    const conv = await s.messaging.row(p.tenantId, link.conversation_id);
    if (!conv || conv.state !== 'active') return { linked: false as const, canLink: can(a, 'settings') };
    const cleared = clears(p.clearance, conv.label);
    return { linked: true as const, conversationId: conv.id, label: conv.label, title: cleared ? await s.messaging.openTitle(conv) : null, member: !!a.role && cleared, linkedBy: link.created_by, linkedAt: link.created_at, canLink: can(a, 'settings') };
  }

  /**
   * Links a conversation to the group: a new one with the group's name, or an existing one of the same workspace that
   * the caller owns. An owner's action (`settings`).
   */
  async link(ctx: Ctx, groupId: string, input: { conversationId?: string | undefined; label?: Label | undefined; removeOthers?: boolean | undefined }) {
    const s = this.s();
    const p = ctx.p;
    const a = await s.groups.require(p, groupId, 'settings');
    const g = a.group;
    if (await this.ofGroup(g.id)) throw conflict('This group already has a conversation; remove that link first.');
    const members = ((await this.db('group_members').where({ group_id: g.id }).select('user_id')) as { user_id: string }[]).map((r) => r.user_id);
    if (members.length > s.messaging.maxMembers) throw new HttpProblem(422, 'Too many members', `A conversation holds at most ${s.messaging.maxMembers} people; the group has ${members.length}.`, { extensions: { step: 'members' } });
    let conversationId: string;
    let label: Label;
    let created = false;
    let outside: string[] = [];
    const now = Date.now();
    if (input.conversationId) {
      // The caller owns the conversation as well as the group.
      const c = (await s.messaging.require(p, input.conversationId, 'delete')).conv;
      if (c.kind !== 'group') throw conflict('A direct conversation is between its two people only.');
      if (c.workspace_id !== g.workspace_id) throw new HttpProblem(422, 'Another workspace', 'The conversation belongs to another workspace than the group.', { extensions: { step: 'workspace' } });
      if (await this.ofConversation(c.id)) throw conflict('That conversation is linked to another group.');
      if (labelRank(c.label) < labelRank(g.label)) throw new HttpProblem(422, 'Label below the group’s', `The conversation is labelled ${c.label}, below the group’s ${g.label}. A linked conversation is never labelled below its group.`, { extensions: { step: 'label-floor' } });
      const have = ((await this.db('dm_members').where({ conversation_id: c.id }).select('user_id')) as { user_id: string }[]).map((r) => r.user_id);
      outside = have.filter((u) => !members.includes(u));
      if (outside.length && !input.removeOthers) throw new HttpProblem(409, 'Members outside the group', `${outside.length} ${outside.length === 1 ? 'person in the conversation is' : 'people in the conversation are'} not in the group. Linking would remove them; confirm it, or add them to the group first.`, { extensions: { step: 'members', outside: outside.length } });
      conversationId = c.id;
      label = c.label;
    } else {
      label = input.label ?? g.label;
      if (labelRank(label) < labelRank(g.label)) throw new HttpProblem(422, 'Label below the group’s', `A linked conversation is labelled at least ${g.label}, as its group is.`, { extensions: { step: 'label-floor' } });
      const w = await s.tenants.workspace(g.tenant_id, g.workspace_id);
      if (w && labelRank(label) > labelRank(w.label_ceiling)) throw new HttpProblem(422, 'Label above the workspace ceiling', `The workspace allows content up to ${w.label_ceiling}.`);
      if (!clears(p.clearance, label)) throw forbidden(`You are not cleared for ${label}.`, { step: 'clearance' });
      conversationId = ulid();
      created = true;
      // Sealed before the transaction: the key store reads the database too (one connection on SQLite).
      const title = await s.keys.seal(g.tenant_id, g.name, `dm-title:${conversationId}`);
      await this.db('dm_conversations').insert({ id: conversationId, tenant_id: g.tenant_id, kind: 'group', workspace_id: g.workspace_id, pair_key: null, title, label, state: 'active', created_by: p.userId, created_at: now, updated_at: now, last_message_at: null });
    }
    try {
      await this.db('group_conversations').insert({ group_id: g.id, tenant_id: g.tenant_id, conversation_id: conversationId, created_by: p.userId, created_at: now });
    } catch (err) {
      if (created) await this.db('dm_conversations').where({ id: conversationId }).delete();
      if (isUniqueViolation(err)) throw conflict('The group or the conversation was linked meanwhile.');
      throw err;
    }
    const out = await this.sync(g.id);
    await s.audit.append({ tenantId: g.tenant_id, action: 'group.conversation.linked', kind: 'admin', actor: actorFrom(p, ctx.ip), target: { group: g.id, conversation: conversationId, workspace: g.workspace_id }, label, detail: { created, label, groupLabel: g.label, membersAdded: out.added.length, membersRemoved: out.removed.length, removedOutsideGroup: outside.length }, traceId: ctx.traceId ?? null });
    return this.view(p, g.id);
  }

  /** Writes the group's roles into the conversation and takes the link away: it is an ordinary conversation again. */
  private async release(link: LinkRow): Promise<number> {
    const rights = await this.s().groups.roles.rightsOfAll(link.group_id);
    const members = [...rights.keys()].map((user_id) => ({ user_id }));
    for (const m of members) await this.db('dm_members').where({ conversation_id: link.conversation_id, user_id: m.user_id }).update({ role: linkRole(rights.get(m.user_id)!) });
    await this.db('group_conversations').where({ group_id: link.group_id }).delete();
    return members.length;
  }

  /** Removes the link. The conversation stays, with the people in it now, and is managed as any other from then on. */
  async unlink(ctx: Ctx, groupId: string) {
    const s = this.s();
    const a = await s.groups.require(ctx.p, groupId, 'settings', { reading: true });
    const link = await this.ofGroup(groupId);
    if (!link) throw notFound('Conversation');
    await this.sync(groupId);
    const members = await this.release(link);
    await s.audit.append({ tenantId: link.tenant_id, action: 'group.conversation.unlinked', kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target: { group: groupId, conversation: link.conversation_id, workspace: a.group.workspace_id }, label: a.group.label, detail: { members, reason: 'unlinked' }, traceId: ctx.traceId ?? null });
    return { linked: false as const, conversationId: link.conversation_id };
  }

  /** The group is deleted: its conversation is left to the people in it, as an ordinary one. */
  async groupDeleted(ctx: Ctx, g: Pick<GroupRow, 'id' | 'tenant_id' | 'workspace_id' | 'label'>): Promise<void> {
    const link = await this.ofGroup(g.id);
    if (!link) return;
    const members = await this.release(link);
    await this.s().audit.append({ tenantId: link.tenant_id, action: 'group.conversation.unlinked', kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target: { group: g.id, conversation: link.conversation_id, workspace: g.workspace_id }, label: g.label, detail: { members, reason: 'group-deleted' }, traceId: ctx.traceId ?? null });
  }

  /** The conversation is deleted: the link goes with it. */
  async conversationDeleted(conversationId: string): Promise<void> {
    await this.db('group_conversations').where({ conversation_id: conversationId }).delete();
  }
}
