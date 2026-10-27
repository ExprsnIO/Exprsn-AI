import { ulid } from 'ulid';
import type { Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { badRequest, conflict, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import type { ConversationRow } from './service.js';

/*
 * Message groups (2026-10-15, migration 076): named selections of messages in one conversation ("final answer",
 * "ideas"). A group stores message ids and a sealed name (`chat-group:<id>`), never a copy of the messages, so what it
 * shows is what the conversation holds and who may read it is who may read the conversation: the owner, and a reader
 * with a live share who is cleared for its label (`ConversationSharing.readable`). Only the owner creates, changes or
 * deletes groups. A group can be exported on its own in any export format (`ConversationSharing.requestExport`).
 */

export const MAX_GROUPS = 100;
export const MAX_GROUP_MESSAGES = 500;

interface GroupRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  created_by: string;
  name: string;
  message_ids: string;
  created_at: number;
  updated_at: number;
}

export interface GroupView {
  id: string;
  conversationId: string;
  name: string;
  messageIds: string[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export class MessageGroups {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  private async view(r: GroupRow): Promise<GroupView> {
    return { id: r.id, conversationId: r.conversation_id, name: await this.s().keys.open(r.tenant_id, r.name, `chat-group:${r.id}`), messageIds: json<string[]>(r.message_ids, []), createdBy: r.created_by, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) };
  }

  private async row(c: ConversationRow, id: string): Promise<GroupRow> {
    const r = (await this.db('chat_message_groups').where({ tenant_id: c.tenant_id, conversation_id: c.id, id }).first()) as GroupRow | undefined;
    if (!r) throw notFound('Message group');
    return r;
  }

  /** The ids, once each, in the order given, after checking every one is a message of this conversation. */
  private async checkIds(c: ConversationRow, ids: string[]): Promise<string[]> {
    const unique = [...new Set(ids)];
    if (!unique.length) throw badRequest('Pick at least one message.');
    if (unique.length > MAX_GROUP_MESSAGES) throw badRequest(`A group holds at most ${MAX_GROUP_MESSAGES} messages.`);
    const found = new Set(((await this.db('messages').where({ conversation_id: c.id }).whereIn('id', unique).select('id')) as { id: string }[]).map((m) => m.id));
    const missing = unique.filter((id) => !found.has(id));
    if (missing.length) throw badRequest(`${missing.length === 1 ? 'A message' : `${missing.length} messages`} picked ${missing.length === 1 ? 'is' : 'are'} not in this conversation.`);
    return unique;
  }

  /** The groups of a conversation the caller may read (owner or share reader). */
  async list(p: Principal, conversationId: string): Promise<{ c: ConversationRow; groups: GroupView[] }> {
    const { c } = await this.s().sharing.readable(p, conversationId);
    const rows = (await this.db('chat_message_groups').where({ tenant_id: p.tenantId, conversation_id: c.id }).orderBy('created_at')) as GroupRow[];
    return { c, groups: await Promise.all(rows.map((r) => this.view(r))) };
  }

  async create(p: Principal, conversationId: string, input: { name: string; messageIds: string[] }): Promise<{ c: ConversationRow; group: GroupView }> {
    const c = await this.s().chat.conversation(p, conversationId);
    const n = Number(((await this.db('chat_message_groups').where({ tenant_id: p.tenantId, conversation_id: c.id }).count({ n: '*' }).first()) as { n: number | string } | undefined)?.n ?? 0);
    if (n >= MAX_GROUPS) throw conflict(`This conversation has ${MAX_GROUPS} groups, the most it can have.`);
    const ids = await this.checkIds(c, input.messageIds);
    const id = ulid();
    const t = Date.now();
    const row: GroupRow = { id, tenant_id: p.tenantId, conversation_id: c.id, created_by: p.userId, name: await this.s().keys.seal(p.tenantId, input.name, `chat-group:${id}`), message_ids: JSON.stringify(ids), created_at: t, updated_at: t };
    await this.db('chat_message_groups').insert(row);
    return { c, group: await this.view(row) };
  }

  async update(p: Principal, conversationId: string, id: string, patch: { name?: string; messageIds?: string[] }): Promise<{ c: ConversationRow; group: GroupView }> {
    const c = await this.s().chat.conversation(p, conversationId);
    const r = await this.row(c, id);
    const upd: Partial<GroupRow> = { updated_at: Date.now() };
    if (patch.name !== undefined) upd.name = await this.s().keys.seal(p.tenantId, patch.name, `chat-group:${r.id}`);
    if (patch.messageIds !== undefined) upd.message_ids = JSON.stringify(await this.checkIds(c, patch.messageIds));
    await this.db('chat_message_groups').where({ id: r.id }).update(upd);
    return { c, group: await this.view({ ...r, ...upd }) };
  }

  async remove(p: Principal, conversationId: string, id: string): Promise<ConversationRow> {
    const c = await this.s().chat.conversation(p, conversationId);
    const r = await this.row(c, id);
    await this.db('chat_message_groups').where({ id: r.id }).delete();
    return c;
  }
}
