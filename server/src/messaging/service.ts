import { ulid } from 'ulid';
import { actorFrom, isUniqueViolation } from '../audit/chain.js';
import { clears, isLabel, labelRank, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { loadPrincipal, workspacesFor } from '../http/middleware.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { termCounts } from '../knowledge/terms.js';
import type { ModeratedObject } from '../moderation/registry.js';
import { TOPICS, type IntegrationEvent } from '../platform/bus.js';
import type { Services } from '../services.js';

/*
 * Messaging (B-2601 to B-2604, B-2606): person-to-person conversations inside a tenant, sealed at rest with the tenant
 * key (no end-to-end encryption, so search and summaries work; see insights.ts for B-2605).
 *
 * - Direct conversations are between two people and unique per pair (`pair_key`, so two people starting one at once
 *   get the same conversation). They have no workspace: the two must share a workspace now, which is the outer
 *   boundary as for groups. Group conversations live in one workspace; every member must be in it now.
 * - Roles: owner (title, roles, delete), admin (add and remove members, pin, remove others' messages), member (send,
 *   react, receipts; in a direct conversation also pin). Holders of nothing more than `messages:*` act only through
 *   their role: there is no administrator who reads other people's conversations (moderation reads reported messages).
 * - Blocks (social/service.ts) apply everywhere: a direct conversation with someone in a block with the caller takes no
 *   messages, the messages, reactions and receipts of people in a block with the reader are left out of everything they
 *   read, and room events (new messages, typing, presence, receipts) are raised through `social.emitToRoom`, which
 *   leaves them out on the socket as well (the platform's BUG-080). Contact rules apply when a conversation is started
 *   or someone is added.
 * - Edits and deletes are audited without the text; a deleted message keeps its row (a tombstone) with the body
 *   removed, and its keyword terms, vector and reactions are deleted.
 */

export const DM_ROLES = ['owner', 'admin', 'member'] as const;
export type DmRole = (typeof DM_ROLES)[number];
export const NOTIFY_RULES = ['all', 'mentions', 'none'] as const;
export type NotifyRule = (typeof NOTIFY_RULES)[number];

export const MESSAGE_OBJECT = 'dm-message';
export const EMBED_JOB = 'messaging.embed';
export const VECTOR_COLLECTION = 'dm-messages';
/** A mute "until unmuted" (31 December 9999). */
export const FOREVER = 253_402_300_799_000;
export const MAX_ATTACHMENTS = 10;
export const MAX_BODY = 10_000;

type Right = 'read' | 'send' | 'pin' | 'add' | 'remove' | 'moderate' | 'rename' | 'roles' | 'delete';
const RIGHTS: Record<DmRole, readonly Right[]> = {
  member: ['read', 'send'],
  admin: ['read', 'send', 'pin', 'add', 'remove', 'moderate', 'rename'],
  owner: ['read', 'send', 'pin', 'add', 'remove', 'moderate', 'rename', 'roles', 'delete']
};
/** What only makes sense with more than two people. */
const GROUP_ONLY: readonly Right[] = ['add', 'remove', 'rename', 'roles', 'delete'];

export interface ConversationRow {
  id: string;
  tenant_id: string;
  kind: 'direct' | 'group';
  workspace_id: string | null;
  pair_key: string | null;
  title: string | null;
  label: Label;
  state: 'active' | 'deleted';
  created_by: string;
  created_at: number;
  updated_at: number;
  last_message_at: number | null;
}

export interface MemberRow {
  conversation_id: string;
  tenant_id: string;
  user_id: string;
  role: DmRole;
  added_by: string | null;
  joined_at: number;
  visible_from: number;
  last_read_id: string | null;
  last_read_at: number | null;
  delivered_id: string | null;
  delivered_at: number | null;
  muted_until: number | null;
  notify: NotifyRule;
  last_seen_at: number | null;
}

export interface MessageRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  author_id: string;
  body: string | null;
  reply_to_id: string | null;
  thread_id: string | null;
  reply_count: number;
  forwarded_from: string | null;
  attachments: string[];
  label: Label;
  state: 'sent' | 'hidden' | 'deleted';
  edits: number;
  edited_at: number | null;
  pinned_at: number | null;
  pinned_by: string | null;
  created_at: number;
  updated_at: number;
}

/** Who is acting: the principal, the address and the request's trace id (for the audit chain). */
export interface Ctx {
  p: Principal;
  ip: string | null;
  traceId?: string | null;
}

/** The caller's standing in a conversation, decided now. */
export interface Access {
  conv: ConversationRow;
  me: MemberRow;
  /** The workspaces that let the caller in (the group's, or those the two people of a direct conversation share). */
  workspaces: string[];
  /** Everyone in a block with the caller (their messages, reactions and receipts are left out). */
  blocked: Set<string>;
}

const num = (v: unknown) => Number(v);
const numOrNull = (v: unknown) => (v == null ? null : Number(v));
const convFrom = (r: Record<string, unknown>): ConversationRow => ({ ...(r as unknown as ConversationRow), label: isLabel(r.label) ? r.label : 'internal', created_at: num(r.created_at), updated_at: num(r.updated_at), last_message_at: numOrNull(r.last_message_at) });
const memberFrom = (r: Record<string, unknown>): MemberRow => ({ ...(r as unknown as MemberRow), joined_at: num(r.joined_at), visible_from: num(r.visible_from), last_read_at: numOrNull(r.last_read_at), delivered_at: numOrNull(r.delivered_at), muted_until: numOrNull(r.muted_until), last_seen_at: numOrNull(r.last_seen_at) });
const parseIds = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== 'string' || !v) return [];
  try {
    const x = JSON.parse(v) as unknown;
    return Array.isArray(x) ? x.map(String) : [];
  } catch {
    return [];
  }
};
export const messageFrom = (r: Record<string, unknown>): MessageRow => ({
  ...(r as unknown as MessageRow),
  attachments: parseIds(r.attachments),
  label: isLabel(r.label) ? r.label : 'internal',
  reply_count: num(r.reply_count ?? 0),
  edits: num(r.edits ?? 0),
  edited_at: numOrNull(r.edited_at),
  pinned_at: numOrNull(r.pinned_at),
  created_at: num(r.created_at),
  updated_at: num(r.updated_at)
});

export const pairKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);
const roleHas = (conv: ConversationRow, role: DmRole, right: Right): boolean => (conv.kind === 'direct' ? right === 'pin' || RIGHTS.member.includes(right) : RIGHTS[role].includes(right));
const mentionsIn = (text: string): Set<string> => new Set([...text.matchAll(/(?:^|[^\w@])@([A-Za-z0-9._-]{1,64})/g)].map((m) => m[1]!.toLowerCase()));

export class MessagingService {
  private started = false;

  constructor(
    private readonly s: () => Services,
    private readonly o: { maxMembers: number; embedModel: string | null }
  ) {}

  private get db() {
    return this.s().db;
  }

  get embedModel(): string | null {
    return this.o.embedModel;
  }

  // ---------- wiring ----------

  /** Registers the conversation room (authoriser, signals, presence), the embedding job and the moderated type. */
  init(): void {
    if (this.started) return;
    this.started = true;
    const s = this.s();
    s.rooms.register('conversation', async (p, id) => {
      const a = await this.accessOrNull(p, id);
      return a && clears(p.clearance, a.conv.label) ? { label: a.conv.label, workspaceId: a.workspaces[0] ?? null } : null;
    });
    s.rooms.onSignal('conversation', (p, id, signal, data) => this.signal(p, id, signal, data));
    s.rooms.onPresence('conversation', { joined: (p, id) => this.presence(p, id, 'online'), left: (p, id) => this.presence(p, id, 'offline') });
    s.jobs.register(EMBED_JOB, async (payload) => this.embedMessage(String(payload.messageId ?? '')));
    this.registerModeration();
  }

  private async audit(ctx: Ctx, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>, label?: Label): Promise<void> {
    await this.s().audit.append({ tenantId: ctx.p.tenantId, action, kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target, ...(detail ? { detail } : {}), ...(label ? { label } : {}), traceId: ctx.traceId ?? null });
  }

  /** A named catalogue event (`message.*`, B-2001) for webhooks and plugins on this instance: ids only. */
  private event(tenantId: string, type: 'message.sent' | 'message.edited' | 'message.deleted', label: Label, data: Record<string, unknown>): void {
    this.s().bus.emitLocal(TOPICS.integrationEvent, { tenantId, type, label, id: `${type}:${ulid()}`, data } satisfies IntegrationEvent);
  }

  /** A room event from a person, left out for everyone in a block with them (on every instance). */
  private async room(c: Pick<ConversationRow, 'tenant_id' | 'id'>, event: string, data: Record<string, unknown>, actorId: string, exceptActor = true): Promise<void> {
    await this.s().social.emitToRoom({ tenantId: c.tenant_id, kind: 'conversation', id: c.id, event, data, ...(exceptActor ? { exceptUserId: actorId } : {}) }, actorId);
  }

  async openTitle(c: ConversationRow): Promise<string | null> {
    return c.title ? ((await this.s().keys.open(c.tenant_id, c.title, `dm-title:${c.id}`)) ?? null) : null;
  }

  async openBody(m: MessageRow): Promise<string | null> {
    return m.body ? ((await this.s().keys.open(m.tenant_id, m.body, `dm-message:${m.id}`)) ?? '') : null;
  }

  // ---------- access ----------

  async row(tenantId: string, id: string): Promise<ConversationRow | null> {
    const r = await this.db('dm_conversations').where({ tenant_id: tenantId, id }).first();
    return r ? convFrom(r) : null;
  }

  async memberRow(conversationId: string, userId: string): Promise<MemberRow | null> {
    const r = await this.db('dm_members').where({ conversation_id: conversationId, user_id: userId }).first();
    return r ? memberFrom(r) : null;
  }

  private async memberIds(conversationId: string): Promise<string[]> {
    return ((await this.db('dm_members').where({ conversation_id: conversationId }).select('user_id')) as { user_id: string }[]).map((r) => r.user_id);
  }

  /** The caller's standing, or null when they may not know the conversation (not a member, outside the boundary). */
  async accessOrNull(p: Principal, id: string): Promise<Access | null> {
    const conv = await this.row(p.tenantId, id);
    if (!conv || conv.state !== 'active') return null;
    const me = await this.memberRow(conv.id, p.userId);
    if (!me) return null;
    let workspaces: string[];
    if (conv.kind === 'group') {
      if (!conv.workspace_id || !(await workspacesFor(this.s(), p)).some((w) => w.id === conv.workspace_id)) return null;
      workspaces = [conv.workspace_id];
    } else {
      const other = (await this.memberIds(conv.id)).find((u) => u !== p.userId);
      workspaces = other ? await this.s().social.sharedWorkspaces(p, other) : [];
      if (!workspaces.length) return null;
    }
    return { conv, me, workspaces, blocked: await this.s().social.blockedWith(p.tenantId, p.userId) };
  }

  /** Access with a right; outside it is 404, below the label or without the role 403. */
  async require(p: Principal, id: string, right: Right): Promise<Access> {
    const a = await this.accessOrNull(p, id);
    if (!a) throw notFound('Conversation');
    if (!clears(p.clearance, a.conv.label)) throw forbidden(`The conversation is labelled ${a.conv.label}, above your clearance of ${p.clearance}.`, { step: 'clearance' });
    if (!roleHas(a.conv, a.me.role, right)) {
      if (a.conv.kind === 'direct' && GROUP_ONLY.includes(right)) throw conflict('A direct conversation is between its two people only.');
      throw forbidden(`Your role in this conversation (${a.me.role}) does not allow this.`, { step: 'conversation-role', right });
    }
    return a;
  }

  /** Can this member see this message (their join time, blocks)? Deleted and hidden ones show as tombstones. */
  sees(a: Access, m: MessageRow): boolean {
    return m.conversation_id === a.conv.id && m.created_at >= a.me.visible_from && !a.blocked.has(m.author_id);
  }

  async messageRow(tenantId: string, id: string): Promise<MessageRow | null> {
    const r = await this.db('dm_messages').where({ tenant_id: tenantId, id }).first();
    return r ? messageFrom(r) : null;
  }

  /** A message the caller can see, with their access to its conversation. */
  async message(p: Principal, id: string, right: Right = 'read'): Promise<{ a: Access; m: MessageRow }> {
    const m = await this.messageRow(p.tenantId, id);
    if (!m) throw notFound('Message');
    const a = await this.accessOrNull(p, m.conversation_id);
    if (!a || !this.sees(a, m)) throw notFound('Message');
    return { a: await this.require(p, m.conversation_id, right), m };
  }

  // ---------- views ----------

  private async people(tenantId: string, ids: string[]): Promise<Map<string, { username: string; displayName: string }>> {
    const out = new Map<string, { username: string; displayName: string }>();
    const uniq = [...new Set(ids)];
    for (let i = 0; i < uniq.length; i += 500) {
      const rows = (await this.db('users').where({ tenant_id: tenantId }).whereIn('id', uniq.slice(i, i + 500)).select('id', 'username', 'display_name')) as { id: string; username: string; display_name: string }[];
      for (const r of rows) out.set(r.id, { username: r.username, displayName: r.display_name });
    }
    return out;
  }

  /** Messages as their reader sees them: bodies opened, attachments described, reactions without blocked people. */
  async views(a: Access, rows: MessageRow[]) {
    if (!rows.length) return [];
    const ids = rows.map((m) => m.id);
    const reactions = (await this.db('dm_reactions').whereIn('message_id', ids).select('message_id', 'user_id', 'emoji')) as { message_id: string; user_id: string; emoji: string }[];
    const fileIds = [...new Set(rows.flatMap((m) => (m.state === 'sent' ? m.attachments : [])))];
    const files = new Map<string, { name: string; type: string | null; size: number; state: string; label: string }>();
    if (fileIds.length) {
      const fr = (await this.db('files').where({ tenant_id: a.conv.tenant_id }).whereIn('id', fileIds).select('id', 'name', 'type', 'size', 'state', 'label', 'trashed_at')) as { id: string; name: string; type: string | null; size: number; state: string; label: string; trashed_at: unknown }[];
      for (const f of fr) files.set(f.id, { name: f.name, type: f.type, size: Number(f.size), state: f.trashed_at != null ? 'trashed' : f.state, label: f.label });
    }
    const who = await this.people(a.conv.tenant_id, rows.map((m) => m.author_id));
    const out = [];
    for (const m of rows) {
      const counts = new Map<string, { count: number; mine: boolean }>();
      for (const r of reactions) {
        if (r.message_id !== m.id || a.blocked.has(r.user_id)) continue;
        const c = counts.get(r.emoji) ?? { count: 0, mine: false };
        c.count++;
        if (r.user_id === a.me.user_id) c.mine = true;
        counts.set(r.emoji, c);
      }
      const live = m.state === 'sent';
      out.push({
        id: m.id,
        conversationId: m.conversation_id,
        authorId: m.author_id,
        authorName: who.get(m.author_id)?.displayName ?? null,
        body: live ? await this.openBody(m) : null,
        state: m.state,
        label: m.label,
        replyTo: m.reply_to_id,
        threadId: m.thread_id,
        replyCount: m.reply_count,
        forwardedFrom: live ? m.forwarded_from : null,
        attachments: live ? m.attachments.map((id) => ({ fileId: id, ...(files.get(id) ?? { name: null, type: null, size: null, state: 'gone', label: null }) })) : [],
        reactions: live ? [...counts].map(([emoji, c]) => ({ emoji, count: c.count, mine: c.mine })) : [],
        pinned: live && m.pinned_at != null,
        pinnedAt: live ? m.pinned_at : null,
        pinnedBy: live ? m.pinned_by : null,
        edited: m.edits > 0,
        editedAt: m.edited_at,
        createdAt: m.created_at
      });
    }
    return out;
  }

  private async conversationView(p: Principal, a: Access, withMembers = false) {
    const c = a.conv;
    const memberRows = ((await this.db('dm_members').where({ conversation_id: c.id })) as Record<string, unknown>[]).map(memberFrom);
    const visible = memberRows.filter((m) => !a.blocked.has(m.user_id));
    const who = await this.people(c.tenant_id, visible.map((m) => m.user_id));
    const others = visible.filter((m) => m.user_id !== p.userId);
    const muted = a.me.muted_until != null && a.me.muted_until > Date.now();
    return {
      id: c.id,
      kind: c.kind,
      workspaceId: c.workspace_id,
      title: await this.openTitle(c),
      label: c.label,
      state: c.state,
      createdBy: c.created_by,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      lastMessageAt: c.last_message_at,
      role: a.me.role,
      members: memberRows.length,
      unread: await this.unread(a),
      muted,
      mutedUntil: muted ? a.me.muted_until : null,
      notify: a.me.notify,
      lastReadId: a.me.last_read_id,
      ...(c.kind === 'direct' ? { with: others[0] ? { userId: others[0].user_id, ...(who.get(others[0].user_id) ?? {}) } : null } : {}),
      ...(withMembers ? { people: visible.map((m) => ({ userId: m.user_id, ...(who.get(m.user_id) ?? { username: null, displayName: null }), role: m.role, joinedAt: m.joined_at, lastSeenAt: m.last_seen_at })) } : {})
    };
  }

  /** Messages after the caller's last read one that they can see and did not write. */
  private async unread(a: Access): Promise<number> {
    let after = a.me.visible_from;
    if (a.me.last_read_id) {
      const r = (await this.db('dm_messages').where({ id: a.me.last_read_id }).first('created_at')) as { created_at: number } | undefined;
      if (r) after = Math.max(after, Number(r.created_at) + 1);
    }
    const q = this.db('dm_messages').where({ conversation_id: a.conv.id, state: 'sent' }).andWhere('created_at', '>=', after).whereNot({ author_id: a.me.user_id });
    if (a.blocked.size) q.whereNotIn('author_id', [...a.blocked]);
    const r = (await q.count({ n: '*' })) as { n: number | string }[];
    return Number(r[0]?.n ?? 0);
  }

  // ---------- conversations (B-2601) ----------

  async list(p: Principal, q: { workspaceId?: string | null | undefined }) {
    const rows = ((await this.db('dm_members as m')
      .join('dm_conversations as c', 'c.id', 'm.conversation_id')
      .where({ 'm.tenant_id': p.tenantId, 'm.user_id': p.userId, 'c.state': 'active' })
      .modify((qb) => (q.workspaceId ? qb.andWhere('c.workspace_id', q.workspaceId) : qb))
      .orderByRaw('coalesce(c.last_message_at, c.created_at) desc')
      .limit(500)
      .select('c.id')) as { id: string }[]);
    const out = [];
    for (const r of rows) {
      const a = await this.accessOrNull(p, r.id);
      if (!a || !clears(p.clearance, a.conv.label)) continue;
      out.push(await this.conversationView(p, a));
    }
    return out;
  }

  async view(p: Principal, id: string) {
    const a = await this.require(p, id, 'read');
    return this.conversationView(p, a, true);
  }

  private async defaultLabel(p: Principal, ceiling: Label, wanted: Label | undefined, people: Principal[]): Promise<Label> {
    const label = wanted ?? (labelRank(ceiling) < labelRank('internal') ? ceiling : 'internal');
    if (labelRank(label) > labelRank(ceiling)) throw new HttpProblem(422, 'Label above the workspace ceiling', `The workspace allows content up to ${ceiling}.`);
    if (!clears(p.clearance, label)) throw forbidden(`You are not cleared for ${label}.`, { step: 'clearance' });
    for (const x of people) if (!clears(x.clearance, label)) throw new HttpProblem(422, 'Not cleared', `${x.displayName} is not cleared for ${label}.`, { extensions: { step: 'clearance' } });
    return label;
  }

  /** The user as they would be on their next request (active, not sanctioned, their clearance now). */
  private async principalOf(tenantId: string, userId: string): Promise<Principal | null> {
    return loadPrincipal(this.s(), tenantId, userId, {});
  }

  /**
   * The direct conversation with `userId`: the existing one when there is one (200), else a new one (201). Two
   * requests racing for the same pair both get the one that won the unique `pair_key`.
   */
  async direct(ctx: Ctx, userId: string, label?: Label): Promise<{ created: boolean; conversation: Awaited<ReturnType<MessagingService['view']>> }> {
    const p = ctx.p;
    const key = pairKey(p.userId, userId);
    const existing = (await this.db('dm_conversations').where({ tenant_id: p.tenantId, pair_key: key }).first('id')) as { id: string } | undefined;
    if (existing && (await this.accessOrNull(p, existing.id))) return { created: false, conversation: await this.view(p, existing.id) };
    if (existing) throw notFound('User');
    await this.s().social.requireContact(p, userId);
    const other = await this.principalOf(p.tenantId, userId);
    if (!other) throw notFound('User');
    const shared = await this.s().social.sharedWorkspaces(p, userId);
    const ceilings = await Promise.all(shared.map((w) => this.s().tenants.workspace(p.tenantId, w)));
    const ceiling = ceilings.reduce<Label>((hi, w) => (w && labelRank(w.label_ceiling) > labelRank(hi) ? w.label_ceiling : hi), 'public');
    const lbl = await this.defaultLabel(p, ceiling, label, [other]);
    const id = ulid();
    const t = Date.now();
    try {
      await this.db.transaction(async (trx) => {
        await trx('dm_conversations').insert({ id, tenant_id: p.tenantId, kind: 'direct', workspace_id: null, pair_key: key, title: null, label: lbl, state: 'active', created_by: p.userId, created_at: t, updated_at: t, last_message_at: null });
        for (const u of [p.userId, userId]) await trx('dm_members').insert({ conversation_id: id, tenant_id: p.tenantId, user_id: u, role: 'member', added_by: p.userId, joined_at: t, visible_from: 0, notify: 'all' });
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // The other request won the pair: answer with its conversation.
      const won = (await this.db('dm_conversations').where({ tenant_id: p.tenantId, pair_key: key }).first('id')) as { id: string } | undefined;
      if (!won) throw err;
      return { created: false, conversation: await this.view(p, won.id) };
    }
    await this.audit(ctx, 'messaging.conversation.created', { conversation: id }, { kind: 'direct', with: userId }, lbl);
    return { created: true, conversation: await this.view(p, id) };
  }

  async createGroup(ctx: Ctx, input: { workspaceId?: string | null | undefined; title?: string | null | undefined; memberIds: string[]; label?: Label | undefined }) {
    const s = this.s();
    const p = ctx.p;
    const wsId = input.workspaceId ?? p.workspaceId ?? null;
    if (!wsId) throw new HttpProblem(422, 'No workspace', 'Name the workspace the conversation belongs to.');
    const w = (await workspacesFor(s, p)).find((x) => x.id === wsId);
    if (!w) throw notFound('Workspace');
    const ids = [...new Set(input.memberIds)].filter((u) => u !== p.userId);
    if (ids.length + 1 > this.o.maxMembers) throw new HttpProblem(422, 'Too many members', `A conversation holds at most ${this.o.maxMembers} people.`);
    const people: Principal[] = [];
    for (const u of ids) {
      await this.addable(p, w.id, u);
      const x = await this.principalOf(p.tenantId, u);
      if (!x) throw notFound('User');
      people.push(x);
    }
    const label = await this.defaultLabel(p, w.label_ceiling, input.label, people);
    const id = ulid();
    const t = Date.now();
    // Sealed before the transaction: the key store reads the database too (one connection on SQLite).
    const title = input.title ? await s.keys.seal(p.tenantId, input.title, `dm-title:${id}`) : null;
    await s.db.transaction(async (trx) => {
      await trx('dm_conversations').insert({ id, tenant_id: p.tenantId, kind: 'group', workspace_id: w.id, pair_key: null, title, label, state: 'active', created_by: p.userId, created_at: t, updated_at: t, last_message_at: null });
      await trx('dm_members').insert({ conversation_id: id, tenant_id: p.tenantId, user_id: p.userId, role: 'owner', added_by: p.userId, joined_at: t, visible_from: 0, notify: 'all' });
      for (const u of ids) await trx('dm_members').insert({ conversation_id: id, tenant_id: p.tenantId, user_id: u, role: 'member', added_by: p.userId, joined_at: t, visible_from: 0, notify: 'all' });
    });
    await this.audit(ctx, 'messaging.conversation.created', { conversation: id, workspace: w.id }, { kind: 'group', members: ids.length + 1 }, label);
    return this.view(p, id);
  }

  /** Can `userId` be put in a group conversation of this workspace by the caller? Workspace, contact rule, block. */
  private async addable(p: Principal, workspaceId: string, userId: string): Promise<void> {
    const s = this.s();
    if (!(await s.tenants.workspacesForUser(p.tenantId, userId)).some((w) => w.id === workspaceId)) throw new HttpProblem(422, 'Not in the workspace', 'Everyone in the conversation must be a member of its workspace.', { extensions: { step: 'workspace' } });
    await s.social.requireContact(p, userId);
  }

  async update(ctx: Ctx, id: string, patch: { title?: string | null | undefined }) {
    const s = this.s();
    const a = await this.require(ctx.p, id, 'rename');
    if (patch.title !== undefined) await s.db('dm_conversations').where({ id }).update({ title: patch.title ? await s.keys.seal(a.conv.tenant_id, patch.title, `dm-title:${id}`) : null, updated_at: Date.now() });
    await this.audit(ctx, 'messaging.conversation.updated', { conversation: id }, { changed: Object.keys(patch) }, a.conv.label);
    await this.room(a.conv, 'conversation.updated', { by: ctx.p.userId }, ctx.p.userId);
    return this.view(ctx.p, id);
  }

  async remove(ctx: Ctx, id: string) {
    const s = this.s();
    const a = await this.require(ctx.p, id, 'delete');
    await s.db('dm_conversations').where({ id }).update({ state: 'deleted', updated_at: Date.now() });
    // Message bodies go with the conversation; the rows stay as tombstones until the tenant is offboarded.
    const ids = ((await s.db('dm_messages').where({ conversation_id: id }).select('id')) as { id: string }[]).map((r) => r.id);
    await s.db('dm_messages').where({ conversation_id: id }).update({ body: null, attachments: null, state: 'deleted', updated_at: Date.now() });
    await s.db('dm_terms').where({ conversation_id: id }).delete();
    for (let i = 0; i < ids.length; i += 500) await s.vectors.delete(VECTOR_COLLECTION, ids.slice(i, i + 500));
    await this.audit(ctx, 'messaging.conversation.deleted', { conversation: id }, { messages: ids.length }, a.conv.label);
    s.rooms.accessChanged({ tenantId: a.conv.tenant_id, kind: 'conversation', id });
    return { id, state: 'deleted' as const };
  }

  // ---------- members ----------

  async members(p: Principal, id: string) {
    return (await this.view(p, id)).people ?? [];
  }

  async addMember(ctx: Ctx, id: string, userId: string, role: DmRole) {
    const a = await this.require(ctx.p, id, 'add');
    if (role !== 'member' && !roleHas(a.conv, a.me.role, 'roles')) throw forbidden('Only an owner adds owners and admins.', { step: 'conversation-role' });
    if (await this.memberRow(id, userId)) throw conflict('Already a member.');
    if ((await this.memberIds(id)).length >= this.o.maxMembers) throw new HttpProblem(422, 'Too many members', `A conversation holds at most ${this.o.maxMembers} people.`);
    await this.addable(ctx.p, a.conv.workspace_id!, userId);
    const x = await this.principalOf(ctx.p.tenantId, userId);
    if (!x) throw notFound('User');
    if (!clears(x.clearance, a.conv.label)) throw new HttpProblem(422, 'Not cleared', `${x.displayName} is not cleared for ${a.conv.label}.`, { extensions: { step: 'clearance' } });
    const t = Date.now();
    try {
      // A member added later reads from now on.
      await this.db('dm_members').insert({ conversation_id: id, tenant_id: ctx.p.tenantId, user_id: userId, role, added_by: ctx.p.userId, joined_at: t, visible_from: t, notify: 'all' });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('Already a member.');
      throw err;
    }
    await this.audit(ctx, 'messaging.member.added', { conversation: id, user: userId }, { role }, a.conv.label);
    await this.room(a.conv, 'conversation.member.added', { userId, role }, ctx.p.userId, false);
    return { userId, role };
  }

  private async owners(id: string): Promise<number> {
    const r = (await this.db('dm_members').where({ conversation_id: id, role: 'owner' }).count({ n: '*' })) as { n: number | string }[];
    return Number(r[0]?.n ?? 0);
  }

  async setRole(ctx: Ctx, id: string, userId: string, role: DmRole) {
    const a = await this.require(ctx.p, id, 'roles');
    const m = await this.memberRow(id, userId);
    if (!m) throw notFound('Member');
    if (m.role === role) return { userId, role };
    if (m.role === 'owner' && (await this.owners(id)) <= 1) throw conflict('A conversation needs at least one owner; make someone else owner first.');
    await this.db('dm_members').where({ conversation_id: id, user_id: userId }).update({ role });
    await this.audit(ctx, 'messaging.member.role', { conversation: id, user: userId }, { before: m.role, after: role }, a.conv.label);
    await this.room(a.conv, 'conversation.member.role', { userId, role }, ctx.p.userId, false);
    return { userId, role };
  }

  /** Leaves (one's own id) or removes someone (admins remove members; owners anyone). */
  async removeMember(ctx: Ctx, id: string, userId: string) {
    const s = this.s();
    const self = userId === ctx.p.userId;
    const a = await this.require(ctx.p, id, self ? 'read' : 'remove');
    if (a.conv.kind === 'direct') throw conflict('A direct conversation is between its two people only.');
    const m = await this.memberRow(id, userId);
    if (!m) throw notFound('Member');
    if (!self && m.role !== 'member' && !roleHas(a.conv, a.me.role, 'roles')) throw forbidden('Only an owner removes owners and admins.', { step: 'conversation-role' });
    if (m.role === 'owner' && (await this.owners(id)) <= 1) throw conflict('The last owner cannot leave; make someone else owner or delete the conversation.');
    await s.db('dm_members').where({ conversation_id: id, user_id: userId }).delete();
    await this.audit(ctx, self ? 'messaging.member.left' : 'messaging.member.removed', { conversation: id, user: userId }, { role: m.role }, a.conv.label);
    s.rooms.accessChanged({ tenantId: a.conv.tenant_id, kind: 'conversation', id, userIds: [userId] });
    await this.room(a.conv, 'conversation.member.removed', { userId }, ctx.p.userId, false);
    return { userId, removed: true };
  }

  /** The caller's own mute and notification rule for this conversation (B-2604). */
  async settings(ctx: Ctx, id: string, input: { muted?: boolean | undefined; mutedMinutes?: number | undefined; notify?: NotifyRule | undefined }) {
    const a = await this.require(ctx.p, id, 'read');
    const upd: Record<string, unknown> = {};
    if (input.mutedMinutes !== undefined) upd.muted_until = Date.now() + input.mutedMinutes * 60_000;
    else if (input.muted !== undefined) upd.muted_until = input.muted ? FOREVER : null;
    if (input.notify !== undefined) upd.notify = input.notify;
    if (Object.keys(upd).length) await this.db('dm_members').where({ conversation_id: id, user_id: ctx.p.userId }).update(upd);
    await this.audit(ctx, 'messaging.member.settings', { conversation: id, user: ctx.p.userId }, { mutedUntil: (upd.muted_until as number | null | undefined) ?? a.me.muted_until, notify: input.notify ?? a.me.notify }, a.conv.label);
    const me = (await this.memberRow(id, ctx.p.userId))!;
    const muted = me.muted_until != null && me.muted_until > Date.now();
    return { conversationId: id, muted, mutedUntil: muted ? me.muted_until : null, notify: me.notify };
  }

  // ---------- messages (B-2602) ----------

  async messages(p: Principal, id: string, q: { before?: number | undefined; thread?: string | undefined; limit?: number | undefined }) {
    const a = await this.require(p, id, 'read');
    const rows = ((await this.db('dm_messages')
      .where({ conversation_id: id })
      .andWhere('created_at', '>=', a.me.visible_from)
      .modify((qb) => {
        if (q.before) qb.andWhere('created_at', '<', q.before);
        // A thread is its first message and the replies; the main timeline leaves the replies out.
        if (q.thread) qb.andWhere((x) => x.where({ id: q.thread }).orWhere({ thread_id: q.thread }));
        else qb.whereNull('thread_id');
        if (a.blocked.size) qb.whereNotIn('author_id', [...a.blocked]);
      })
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(Math.min(q.limit ?? 50, 200))) as Record<string, unknown>[]).map(messageFrom);
    return this.views(a, rows);
  }

  async pins(p: Principal, id: string) {
    const a = await this.require(p, id, 'read');
    const rows = ((await this.db('dm_messages').where({ conversation_id: id, state: 'sent' }).whereNotNull('pinned_at').andWhere('created_at', '>=', a.me.visible_from).orderBy('pinned_at', 'desc').limit(200)) as Record<string, unknown>[]).map(messageFrom).filter((m) => !a.blocked.has(m.author_id));
    return this.views(a, rows);
  }

  /** File ids the sender can read, past quarantine, within the label and the conversation's workspaces. */
  private async attachable(p: Principal, a: Access, ids: string[]): Promise<string[]> {
    const out = [...new Set(ids)];
    if (out.length > MAX_ATTACHMENTS) throw new HttpProblem(422, 'Too many attachments', `At most ${MAX_ATTACHMENTS} files a message.`);
    for (const fid of out) {
      const { file } = await this.s().files.readable(p, fid);
      // Only a file whose current version passed its scan; one still in quarantine or rejected waits or is refused.
      if (file.state !== 'ready' || file.current_version == null) throw conflict(`The file ${file.name} has not passed its scan yet.`);
      if (labelRank(file.label) > labelRank(a.conv.label)) throw new HttpProblem(422, 'File above the conversation label', `The file is ${file.label}; the conversation is ${a.conv.label}.`, { extensions: { step: 'clearance' } });
      // Everyone in the conversation reads it through the workspace: it must be in one that lets them all in.
      if (!a.workspaces.includes(file.workspace_id)) throw new HttpProblem(422, 'File outside the conversation', 'Attach files from the conversation’s workspace (or, in a direct conversation, a workspace you both belong to).', { extensions: { step: 'workspace' } });
    }
    return out;
  }

  private async indexTerms(m: Pick<MessageRow, 'id' | 'tenant_id' | 'conversation_id'>, text: string): Promise<void> {
    const s = this.s();
    await s.db('dm_terms').where({ message_id: m.id }).delete();
    const { counts } = termCounts(text);
    if (!counts.size) return;
    const hashed = await s.knowledge.terms.terms(m.tenant_id, [...counts.keys()]);
    const rows = [...counts].map(([w, tf]) => ({ message_id: m.id, tenant_id: m.tenant_id, conversation_id: m.conversation_id, term: hashed.get(w)!, tf }));
    for (let i = 0; i < rows.length; i += 200) await s.db('dm_terms').insert(rows.slice(i, i + 200));
  }

  private async queueEmbedding(m: MessageRow): Promise<void> {
    if (!this.o.embedModel) return;
    await this.s().jobs.enqueue({ tenantId: m.tenant_id, type: EMBED_JOB, payload: { messageId: m.id }, createdBy: m.author_id, maxAttempts: 3, dedupeKey: `${EMBED_JOB}:${m.id}:${m.edits}` });
  }

  /** Screens the text at the `user-input` checkpoint (as for a chat prompt or a group post). */
  private async screen(p: Principal, a: Access, id: string, text: string): Promise<{ text: string; action: string }> {
    const d = await this.s().guardrails.check({ tenantId: a.conv.tenant_id, workspaceId: a.conv.workspace_id, checkpoint: 'user-input', text, label: a.conv.label, principal: p, source: { kind: MESSAGE_OBJECT, id }, meta: { objectType: MESSAGE_OBJECT, conversation: a.conv.id } });
    if (d.action === 'block' || d.action === 'require-approval') throw new HttpProblem(422, 'Blocked by guardrails', d.reason ?? 'The message was blocked by a guardrail rule.', { extensions: { step: 'guardrails', action: d.action } });
    return { text: d.action === 'redact' ? d.text : text, action: d.action };
  }

  /** A direct conversation takes no messages while either person blocks the other (the same words as a contact rule). */
  private async directOpen(a: Access): Promise<void> {
    if (a.conv.kind !== 'direct') return;
    const other = (await this.memberIds(a.conv.id)).find((u) => u !== a.me.user_id);
    if (other && a.blocked.has(other)) throw forbidden('This person does not accept messages from you.', { step: 'contact' });
  }

  async send(ctx: Ctx, id: string, input: { body: string; replyTo?: string | undefined; threadId?: string | undefined; attachments?: string[] | undefined }, forwardedFrom?: string) {
    const s = this.s();
    const p = ctx.p;
    const a = await this.require(p, id, 'send');
    await this.directOpen(a);
    const messageId = ulid();
    let threadId: string | null = null;
    if (input.threadId) {
      const root = await this.messageRow(p.tenantId, input.threadId);
      if (!root || !this.sees(a, root) || root.state !== 'sent') throw notFound('Thread');
      // Threads are one level deep: a reply in a thread belongs to the thread's first message.
      threadId = root.thread_id ?? root.id;
    }
    if (input.replyTo) {
      const quoted = await this.messageRow(p.tenantId, input.replyTo);
      if (!quoted || !this.sees(a, quoted)) throw notFound('Message');
    }
    const attachments = input.attachments?.length ? await this.attachable(p, a, input.attachments) : [];
    const screened = await this.screen(p, a, messageId, input.body);
    const t = Date.now();
    const row: MessageRow = { id: messageId, tenant_id: p.tenantId, conversation_id: id, author_id: p.userId, body: await s.keys.seal(p.tenantId, screened.text, `dm-message:${messageId}`), reply_to_id: input.replyTo ?? null, thread_id: threadId, reply_count: 0, forwarded_from: forwardedFrom ?? null, attachments, label: a.conv.label, state: 'sent', edits: 0, edited_at: null, pinned_at: null, pinned_by: null, created_at: t, updated_at: t };
    await s.db.transaction(async (trx) => {
      await trx('dm_messages').insert({ ...row, attachments: attachments.length ? JSON.stringify(attachments) : null });
      if (threadId) await trx('dm_messages').where({ id: threadId }).increment('reply_count', 1);
      await trx('dm_conversations').where({ id }).update({ last_message_at: t });
      // The sender has read their own message.
      await trx('dm_members').where({ conversation_id: id, user_id: p.userId }).update({ last_read_id: messageId, last_read_at: t });
    });
    await this.indexTerms(row, screened.text);
    await this.queueEmbedding(row);
    await this.audit(ctx, forwardedFrom ? 'messaging.message.forwarded' : 'messaging.message.sent', { conversation: id, message: messageId }, { length: screened.text.length, attachments: attachments.length, guardrails: screened.action, ...(threadId ? { thread: threadId } : {}), ...(forwardedFrom ? { from: forwardedFrom } : {}) }, a.conv.label);
    this.event(p.tenantId, 'message.sent', a.conv.label, { conversation: id, message: messageId, actor: p.userId, thread: threadId });
    await this.room(a.conv, 'conversation.message.created', { messageId, authorId: p.userId, threadId }, p.userId);
    await this.notifyMembers(a, row, screened.text);
    return (await this.views(a, [row]))[0]!;
  }

  /**
   * Tells the other members (B-2604): not those in a block with the author, not those who muted the conversation (for
   * now or for good) or the author, not those whose rule is `none`, and with `mentions` only when named (`@username`).
   * The notice names the sender, never the text or the conversation's title.
   */
  private async notifyMembers(a: Access, m: MessageRow, text: string): Promise<void> {
    const s = this.s();
    const now = Date.now();
    const rows = ((await s.db('dm_members').where({ conversation_id: a.conv.id }).whereNot({ user_id: m.author_id })) as Record<string, unknown>[]).map(memberFrom);
    if (!rows.length) return;
    const blocked = await s.social.blockedAmong(m.tenant_id, m.author_id, rows.map((r) => r.user_id));
    const mutedAuthor = new Set(((await s.db('social_mutes').where({ tenant_id: m.tenant_id, target_id: m.author_id }).whereIn('user_id', rows.map((r) => r.user_id)).andWhere((q) => q.whereNull('expires_at').orWhere('expires_at', '>', now)).select('user_id')) as { user_id: string }[]).map((r) => r.user_id));
    const named = mentionsIn(text);
    const who = await this.people(m.tenant_id, [m.author_id, ...rows.map((r) => r.user_id)]);
    const to: string[] = [];
    for (const r of rows) {
      if (blocked.has(r.user_id) || mutedAuthor.has(r.user_id)) continue;
      if (r.muted_until != null && r.muted_until > now) continue;
      if (r.notify === 'none') continue;
      if (r.notify === 'mentions' && !named.has((who.get(r.user_id)?.username ?? '').toLowerCase())) continue;
      to.push(r.user_id);
    }
    if (!to.length) return;
    const author = who.get(m.author_id)?.displayName ?? 'Someone';
    await s.notifications.notify({ tenantId: m.tenant_id, userIds: to, kind: 'message', title: a.conv.kind === 'direct' ? `${author} sent you a message` : `${author} wrote in a group conversation`, route: `messages?c=${a.conv.id}&m=${m.id}`, label: a.conv.label });
  }

  async edit(ctx: Ctx, messageId: string, body: string) {
    const s = this.s();
    const p = ctx.p;
    const { a, m } = await this.message(p, messageId, 'send');
    if (m.author_id !== p.userId) throw forbidden('Only its author edits a message.', { step: 'author' });
    if (m.state !== 'sent') throw conflict(`The message is ${m.state}.`);
    await this.directOpen(a);
    const screened = await this.screen(p, a, m.id, body);
    const t = Date.now();
    const n = await s.db('dm_messages').where({ id: m.id, state: 'sent', edits: m.edits }).update({ body: await s.keys.seal(p.tenantId, screened.text, `dm-message:${m.id}`), edits: m.edits + 1, edited_at: t, updated_at: t });
    if (!n) throw conflict('The message changed meanwhile.');
    const after = (await this.messageRow(p.tenantId, m.id))!;
    await this.indexTerms(after, screened.text);
    await this.queueEmbedding(after);
    // Audited without the text: the length and the number of the edit.
    await this.audit(ctx, 'messaging.message.edited', { conversation: m.conversation_id, message: m.id }, { edit: after.edits, length: screened.text.length, guardrails: screened.action }, m.label);
    this.event(p.tenantId, 'message.edited', m.label, { conversation: m.conversation_id, message: m.id, actor: p.userId });
    await this.room(a.conv, 'conversation.message.edited', { messageId: m.id }, p.userId);
    return (await this.views(a, [after]))[0]!;
  }

  /** Deletes (its author, or an admin): the body, terms, vector and reactions go; the audit entry stays, without text. */
  async delete(ctx: Ctx, messageId: string) {
    const s = this.s();
    const p = ctx.p;
    const { a, m } = await this.message(p, messageId);
    const own = m.author_id === p.userId;
    if (!own && !roleHas(a.conv, a.me.role, 'moderate')) throw forbidden('Only its author or a conversation admin deletes a message.', { step: 'conversation-role' });
    if (m.state === 'deleted') throw notFound('Message');
    const n = await s.db('dm_messages').where({ id: m.id, state: m.state }).update({ body: null, attachments: null, state: 'deleted', pinned_at: null, pinned_by: null, updated_at: Date.now() });
    if (!n) throw conflict('The message changed meanwhile.');
    await s.db('dm_terms').where({ message_id: m.id }).delete();
    await s.db('dm_reactions').where({ message_id: m.id }).delete();
    await s.vectors.delete(VECTOR_COLLECTION, [m.id]);
    await this.audit(ctx, 'messaging.message.deleted', { conversation: m.conversation_id, message: m.id }, { by: own ? 'author' : 'admin', author: m.author_id, edits: m.edits }, m.label);
    this.event(p.tenantId, 'message.deleted', m.label, { conversation: m.conversation_id, message: m.id, actor: p.userId });
    await this.room(a.conv, 'conversation.message.deleted', { messageId: m.id }, p.userId);
    return { id: m.id, state: 'deleted' as const };
  }

  async react(ctx: Ctx, messageId: string, emoji: string, on: boolean) {
    const p = ctx.p;
    const { a, m } = await this.message(p, messageId, 'send');
    if (m.state !== 'sent') throw conflict(`The message is ${m.state}.`);
    if (on) {
      await this.directOpen(a);
      try {
        await this.db('dm_reactions').insert({ message_id: m.id, tenant_id: p.tenantId, user_id: p.userId, emoji, created_at: Date.now() });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        return { messageId: m.id, emoji, reacted: true };
      }
    } else if (!(await this.db('dm_reactions').where({ message_id: m.id, user_id: p.userId, emoji }).delete())) throw notFound('Reaction');
    await this.audit(ctx, on ? 'messaging.reaction.added' : 'messaging.reaction.removed', { conversation: m.conversation_id, message: m.id }, { emoji }, m.label);
    await this.room(a.conv, 'conversation.reaction', { messageId: m.id, userId: p.userId, emoji, on }, p.userId);
    return { messageId: m.id, emoji, reacted: on };
  }

  async pin(ctx: Ctx, messageId: string, on: boolean) {
    const p = ctx.p;
    const { a, m } = await this.message(p, messageId, 'pin');
    if (m.state !== 'sent') throw conflict(`The message is ${m.state}.`);
    if ((m.pinned_at != null) === on) return { messageId: m.id, pinned: on };
    await this.db('dm_messages').where({ id: m.id }).update(on ? { pinned_at: Date.now(), pinned_by: p.userId } : { pinned_at: null, pinned_by: null });
    await this.audit(ctx, on ? 'messaging.message.pinned' : 'messaging.message.unpinned', { conversation: m.conversation_id, message: m.id }, undefined, m.label);
    await this.room(a.conv, 'conversation.pin', { messageId: m.id, pinned: on, by: p.userId }, p.userId);
    return { messageId: m.id, pinned: on };
  }

  /** Copies a message the caller can read into another conversation they can write in (never to a lower label). */
  async forward(ctx: Ctx, messageId: string, conversationId: string) {
    const { m } = await this.message(ctx.p, messageId);
    if (m.state !== 'sent') throw conflict(`The message is ${m.state}.`);
    const target = await this.require(ctx.p, conversationId, 'send');
    if (labelRank(m.label) > labelRank(target.conv.label)) throw new HttpProblem(422, 'Label above the conversation', `The message is ${m.label}; that conversation is ${target.conv.label}.`, { extensions: { step: 'clearance' } });
    const text = (await this.openBody(m)) ?? '';
    return this.send(ctx, conversationId, { body: text, attachments: m.attachments }, m.id);
  }

  // ---------- receipts, typing and presence (B-2603) ----------

  /** Moves the caller's read or delivered mark forward to a message they can see. */
  async mark(ctx: Ctx, id: string, kind: 'read' | 'delivered', messageId: string) {
    const p = ctx.p;
    const a = await this.require(p, id, 'read');
    const m = await this.messageRow(p.tenantId, messageId);
    if (!m || !this.sees(a, m)) throw notFound('Message');
    const col = kind === 'read' ? 'last_read_id' : 'delivered_id';
    const at = kind === 'read' ? 'last_read_at' : 'delivered_at';
    const t = Date.now();
    // Only forwards: a mark never moves back to an older message.
    const n = await this.db('dm_members')
      .where({ conversation_id: id, user_id: p.userId })
      .andWhere((q) => q.whereNull(col).orWhere(col, '<', m.id))
      .update({ [col]: m.id, [at]: t, ...(kind === 'read' ? { delivered_id: this.db.raw('case when delivered_id is null or delivered_id < ? then ? else delivered_id end', [m.id, m.id]) } : {}) });
    if (n) await this.room(a.conv, kind === 'read' ? 'conversation.read' : 'conversation.delivered', { userId: p.userId, messageId: m.id }, p.userId);
    return { conversationId: id, [kind === 'read' ? 'lastReadId' : 'deliveredId']: n ? m.id : (await this.memberRow(id, p.userId))![col] };
  }

  /** Who has read and received how far (people in a block with the caller left out). */
  async receipts(p: Principal, id: string) {
    const a = await this.require(p, id, 'read');
    const rows = ((await this.db('dm_members').where({ conversation_id: id })) as Record<string, unknown>[]).map(memberFrom).filter((m) => !a.blocked.has(m.user_id));
    return rows.map((m) => ({ userId: m.user_id, lastReadId: m.last_read_id, lastReadAt: m.last_read_at, deliveredId: m.delivered_id, deliveredAt: m.delivered_at, lastSeenAt: m.last_seen_at }));
  }

  /** Signals from a socket in the conversation's room: `typing {typing}`, `read {messageId}`, `delivered {messageId}`. */
  private async signal(p: Principal, id: string, signal: string, data: Record<string, unknown>): Promise<void> {
    const a = await this.accessOrNull(p, id);
    if (!a || !clears(p.clearance, a.conv.label)) return;
    if (signal === 'typing') {
      await this.room(a.conv, 'conversation.typing', { userId: p.userId, typing: data.typing !== false }, p.userId);
      return;
    }
    if ((signal === 'read' || signal === 'delivered') && typeof data.messageId === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(data.messageId)) {
      await this.mark({ p, ip: null }, id, signal, data.messageId).catch(() => undefined);
    }
  }

  /** A socket joined or left the room: tell the others (not people in a block with this user) and note the time. */
  private async presence(p: Principal, id: string, state: 'online' | 'offline'): Promise<void> {
    const a = await this.accessOrNull(p, id);
    if (!a) return;
    const t = Date.now();
    await this.db('dm_members').where({ conversation_id: id, user_id: p.userId }).update({ last_seen_at: t });
    await this.room(a.conv, 'conversation.presence', { userId: p.userId, state, at: t }, p.userId);
  }

  // ---------- embeddings (B-2605) ----------

  /** The `messaging.embed` job: embeds a message for semantic search, or drops its vector when it is gone. */
  private async embedMessage(messageId: string): Promise<unknown> {
    const s = this.s();
    const model = this.o.embedModel;
    if (!model) return { skipped: 'no model' };
    const r = await s.db('dm_messages').where({ id: messageId }).first();
    if (!r) return { skipped: 'gone' };
    const m = messageFrom(r);
    if (m.state !== 'sent' || !m.body) {
      await s.vectors.delete(VECTOR_COLLECTION, [m.id]);
      return { skipped: m.state };
    }
    const row = await s.gateway.repo.modelByName(model);
    if (!row || !row.capabilities.includes('embedding') || (row.state !== 'approved' && row.state !== 'deprecated')) return { skipped: `${model} is not an approved embedding model` };
    if (labelRank(row.label) < labelRank(m.label)) return { skipped: `${model} is approved up to ${row.label}` };
    const text = (await this.openBody(m)) ?? '';
    if (!text.trim()) return { skipped: 'empty' };
    const [vector] = await s.knowledge.embed(m.tenant_id, model, [text], m.label, m.author_id);
    await s.vectors.upsert(VECTOR_COLLECTION, [{ id: m.id, tenantId: m.tenant_id, partition: m.conversation_id, labelRank: labelRank(m.label), vector: vector! }]);
    return { embedded: m.id };
  }

  // ---------- moderation (messages are a moderated object type) ----------

  private registerModeration(): void {
    const reg = this.s().moderation.registry;
    if (reg.get(MESSAGE_OBJECT)) return;
    const db = () => this.s().db;
    reg.register({
      type: MESSAGE_OBJECT,
      description: 'A person-to-person message (a hidden message shows to its conversation as hidden, without the text)',
      resolve: async (tenantId, id) => {
        const r = (await db()('dm_messages as m').join('dm_conversations as c', 'c.id', 'm.conversation_id').where({ 'm.tenant_id': tenantId, 'm.id': id }).first('m.id', 'm.state', 'm.label', 'm.author_id', 'c.workspace_id')) as { id: string; state: string; label: string; author_id: string; workspace_id: string | null } | undefined;
        return r ? { type: MESSAGE_OBJECT, id: r.id, tenantId, workspaceId: r.workspace_id, label: isLabel(r.label) ? r.label : 'internal', ownerId: r.author_id, state: r.state } : null;
      },
      // Whoever can see it in their conversation may report it.
      canRead: async (p, o) => {
        if (!clears(p.clearance, o.label) || o.state === 'deleted') return false;
        const m = await this.messageRow(o.tenantId, o.id);
        if (!m) return false;
        const a = await this.accessOrNull(p, m.conversation_id);
        return !!a && this.sees(a, m);
      },
      text: async (o) => {
        const m = await this.messageRow(o.tenantId, o.id);
        return m ? ((await this.openBody(m)) ?? '') : '';
      },
      hide: async (o: ModeratedObject) => {
        if (o.state !== 'sent') return null;
        const n = await db()('dm_messages').where({ id: o.id, tenant_id: o.tenantId, state: 'sent' }).update({ state: 'hidden', updated_at: Date.now() });
        if (!n) return null;
        await this.s().vectors.delete(VECTOR_COLLECTION, [o.id]);
        return 'sent';
      },
      restore: async (o, prev) => {
        const n = await db()('dm_messages').where({ id: o.id, tenant_id: o.tenantId, state: 'hidden' }).update({ state: prev, updated_at: Date.now() });
        if (n && prev === 'sent') {
          const m = await this.messageRow(o.tenantId, o.id);
          if (m) await this.queueEmbedding(m);
        }
        return n > 0;
      }
    });
  }
}
