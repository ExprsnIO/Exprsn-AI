import { ulid } from 'ulid';
import { actorFrom } from '../audit/chain.js';
import type { Principal } from '../authz/policy.js';
import { conflict, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import type { Ctx, MessagingService } from './service.js';

/*
 * Messaging folders: each person files the conversations they are in into folders of their own. A conversation is
 * shared by its members, so a filing is per person (`dm_filings`, keyed by conversation and user): it never changes the
 * conversation, its membership or what anyone else sees.
 *
 * - Built in: `inbox` (no filing row: everything not filed elsewhere) and `archive`. Custom folders (`dm_folders`) have
 *   a sealed name, nest at most two deep and are ordered among their siblings.
 * - Archive is left on new activity: a conversation archived at `filed_at` is in the Inbox again once a message from
 *   someone else that the person can see (not before they joined, not from someone in a block with them) arrives
 *   after that time. It is decided on read, so no send path changes; archiving again moves the time forward.
 * - Deleting a folder deletes its subfolders too, and their conversations go back to the Inbox.
 * - Filing needs the caller's standing in the conversation now (`MessagingService.require` with `read`: 404 outside
 *   it, 403 above the caller's clearance), so nobody files a conversation they are not in.
 */

export const BUILTIN_FOLDERS = ['inbox', 'archive'] as const;
export type BuiltinFolder = (typeof BUILTIN_FOLDERS)[number];
/** The most custom folders one person keeps. */
export const MAX_FOLDERS = 200;
export const MAX_FOLDER_NAME = 80;
/** Two levels: a top-level folder and its subfolders. */
export const MAX_DEPTH = 2;

interface FolderRow {
  id: string;
  tenant_id: string;
  user_id: string;
  parent_id: string | null;
  name: string;
  position: number;
  created_at: number;
  updated_at: number;
}

interface FilingRow {
  conversation_id: string;
  user_id: string;
  tenant_id: string;
  folder: string;
  filed_at: number;
}

type ConversationView = Awaited<ReturnType<MessagingService['list']>>[number];

export interface FolderView {
  id: string;
  kind: 'inbox' | 'archive' | 'custom';
  name: string;
  parentId: string | null;
  position: number;
  depth: number;
  conversations: number;
  unread: number;
}

const folderFrom = (r: Record<string, unknown>): FolderRow => ({ ...(r as unknown as FolderRow), position: Number(r.position ?? 0), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
const filingFrom = (r: Record<string, unknown>): FilingRow => ({ ...(r as unknown as FilingRow), filed_at: Number(r.filed_at) });
const sameName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;

export class MessagingFolders {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  private async audit(ctx: Ctx, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>): Promise<void> {
    await this.s().audit.append({ tenantId: ctx.p.tenantId, action, kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target, ...(detail ? { detail } : {}), traceId: ctx.traceId ?? null });
  }

  private async rows(p: Principal): Promise<FolderRow[]> {
    return ((await this.db('dm_folders').where({ tenant_id: p.tenantId, user_id: p.userId }).orderBy([{ column: 'position' }, { column: 'created_at' }])) as Record<string, unknown>[]).map(folderFrom);
  }

  private async nameOf(f: FolderRow): Promise<string> {
    return (await this.s().keys.open(f.tenant_id, f.name, `dm-folder:${f.id}`)) ?? '';
  }

  /** One of the caller's own custom folders, or 404 (another person's folder is not found either). */
  private async own(p: Principal, id: string): Promise<FolderRow> {
    const r = await this.db('dm_folders').where({ tenant_id: p.tenantId, user_id: p.userId, id }).first();
    if (!r) throw notFound('Folder');
    return folderFrom(r);
  }

  /** The folder each conversation is in for this person now, after archived ones with new activity went back. */
  async placement(p: Principal, convos: Pick<ConversationView, 'id'>[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!convos.length) return out;
    const ids = convos.map((c) => c.id);
    const filings: FilingRow[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      filings.push(...((await this.db('dm_filings').where({ tenant_id: p.tenantId, user_id: p.userId }).whereIn('conversation_id', ids.slice(i, i + 500))) as Record<string, unknown>[]).map(filingFrom));
    }
    const folders = new Set((await this.db('dm_folders').where({ tenant_id: p.tenantId, user_id: p.userId }).select('id')).map((r: { id: string }) => r.id));
    const archived = filings.filter((f) => f.folder === 'archive');
    const back = await this.returned(p, archived);
    for (const c of ids) out.set(c, 'inbox');
    for (const f of filings) {
      if (f.folder === 'archive') out.set(f.conversation_id, back.has(f.conversation_id) ? 'inbox' : 'archive');
      else if (folders.has(f.folder)) out.set(f.conversation_id, f.folder);
    }
    return out;
  }

  /** The archived conversations that have a message from someone else, which the person can see, since archiving. */
  private async returned(p: Principal, archived: FilingRow[]): Promise<Set<string>> {
    const out = new Set<string>();
    if (!archived.length) return out;
    const blocked = await this.s().social.blockedWith(p.tenantId, p.userId);
    const members = new Map(((await this.db('dm_members').where({ user_id: p.userId }).whereIn('conversation_id', archived.map((f) => f.conversation_id)).select('conversation_id', 'visible_from')) as { conversation_id: string; visible_from: number | string }[]).map((m) => [m.conversation_id, Number(m.visible_from)]));
    for (const f of archived) {
      const q = this.db('dm_messages')
        .where({ conversation_id: f.conversation_id, state: 'sent' })
        .whereNot({ author_id: p.userId })
        .andWhere('created_at', '>=', members.get(f.conversation_id) ?? 0)
        .andWhere((w) => w.where('created_at', '>', f.filed_at).orWhere('released_at', '>', f.filed_at));
      if (blocked.size) q.whereNotIn('author_id', [...blocked]);
      if (await q.first('id')) out.add(f.conversation_id);
    }
    return out;
  }

  /** The caller's conversations with the folder each is in, optionally only those of one folder. */
  async decorate(p: Principal, convos: ConversationView[], folder?: string): Promise<(ConversationView & { folder: string })[]> {
    const where = await this.placement(p, convos);
    const out = convos.map((c) => ({ ...c, folder: where.get(c.id) ?? 'inbox' }));
    return folder ? out.filter((c) => c.folder === folder) : out;
  }

  /** Inbox, Archive and the custom folders (parents before their children), with conversation and unread counts. */
  async list(p: Principal): Promise<FolderView[]> {
    const convos = await this.s().messaging.list(p, {});
    const where = await this.placement(p, convos);
    const counts = new Map<string, { conversations: number; unread: number }>();
    for (const c of convos) {
      const f = where.get(c.id) ?? 'inbox';
      const n = counts.get(f) ?? { conversations: 0, unread: 0 };
      n.conversations++;
      n.unread += Number(c.unread ?? 0);
      counts.set(f, n);
    }
    const of = (id: string) => counts.get(id) ?? { conversations: 0, unread: 0 };
    const out: FolderView[] = [
      { id: 'inbox', kind: 'inbox', name: 'Inbox', parentId: null, position: 0, depth: 1, ...of('inbox') },
      { id: 'archive', kind: 'archive', name: 'Archive', parentId: null, position: 1, depth: 1, ...of('archive') }
    ];
    const rows = await this.rows(p);
    const view = async (f: FolderRow, depth: number): Promise<FolderView> => ({ id: f.id, kind: 'custom', name: await this.nameOf(f), parentId: f.parent_id, position: f.position, depth, ...of(f.id) });
    const ids = new Set(rows.map((f) => f.id));
    for (const top of rows.filter((f) => !f.parent_id || !ids.has(f.parent_id))) {
      out.push(await view(top, 1));
      for (const child of rows.filter((f) => f.parent_id === top.id)) out.push(await view(child, 2));
    }
    return out;
  }

  private async assertName(p: Principal, name: string, parentId: string | null, except?: string): Promise<void> {
    if (!parentId && BUILTIN_FOLDERS.some((b) => sameName(b, name))) throw conflict(`"${name}" is a built-in folder.`);
    for (const f of await this.rows(p)) {
      if (f.id === except || (f.parent_id ?? null) !== parentId) continue;
      if (sameName(await this.nameOf(f), name)) throw conflict(`There is already a folder named "${name}" there.`);
    }
  }

  /** A top-level folder of the caller's that may hold subfolders. */
  private async parent(p: Principal, parentId: string): Promise<FolderRow> {
    const parent = await this.own(p, parentId);
    if (parent.parent_id) throw new HttpProblem(422, 'Too deep', `Folders nest at most ${MAX_DEPTH} levels.`, { extensions: { field: 'parentId' } });
    return parent;
  }

  async create(ctx: Ctx, input: { name: string; parentId?: string | null | undefined }): Promise<FolderView> {
    const p = ctx.p;
    const parentId = input.parentId ?? null;
    if (parentId) await this.parent(p, parentId);
    const n = (await this.db('dm_folders').where({ tenant_id: p.tenantId, user_id: p.userId }).count({ n: '*' })) as { n: number | string }[];
    if (Number(n[0]?.n ?? 0) >= MAX_FOLDERS) throw new HttpProblem(422, 'Too many folders', `You can keep at most ${MAX_FOLDERS} folders.`);
    await this.assertName(p, input.name, parentId);
    const siblings = (await this.rows(p)).filter((f) => (f.parent_id ?? null) === parentId);
    const position = siblings.reduce((hi, f) => Math.max(hi, f.position + 1), 0);
    const id = ulid();
    const t = Date.now();
    const name = await this.s().keys.seal(p.tenantId, input.name, `dm-folder:${id}`);
    await this.db('dm_folders').insert({ id, tenant_id: p.tenantId, user_id: p.userId, parent_id: parentId, name, position, created_at: t, updated_at: t });
    await this.audit(ctx, 'messaging.folder.created', { folder: id }, { parent: parentId });
    return { id, kind: 'custom', name: input.name, parentId, position, depth: parentId ? 2 : 1, conversations: 0, unread: 0 };
  }

  /** Rename, or move under another top-level folder (`parentId`, null for the top). */
  async update(ctx: Ctx, id: string, input: { name?: string | undefined; parentId?: string | null | undefined }): Promise<FolderView> {
    const p = ctx.p;
    const f = await this.own(p, id);
    const parentId = input.parentId === undefined ? (f.parent_id ?? null) : input.parentId;
    const moved = parentId !== (f.parent_id ?? null);
    if (moved && parentId) {
      if (parentId === f.id) throw new HttpProblem(422, 'Not a parent', 'A folder cannot be inside itself.', { extensions: { field: 'parentId' } });
      await this.parent(p, parentId);
      if (await this.db('dm_folders').where({ tenant_id: p.tenantId, user_id: p.userId, parent_id: f.id }).first('id')) throw new HttpProblem(422, 'Too deep', `A folder with subfolders stays at the top: folders nest at most ${MAX_DEPTH} levels.`, { extensions: { field: 'parentId' } });
    }
    const name = input.name ?? (await this.nameOf(f));
    if (input.name !== undefined || moved) await this.assertName(p, name, parentId, f.id);
    const patch: Record<string, unknown> = { updated_at: Date.now() };
    if (input.name !== undefined) patch.name = await this.s().keys.seal(p.tenantId, input.name, `dm-folder:${f.id}`);
    if (moved) {
      patch.parent_id = parentId;
      patch.position = (await this.rows(p)).filter((x) => (x.parent_id ?? null) === parentId).reduce((hi, x) => Math.max(hi, x.position + 1), 0);
    }
    await this.db('dm_folders').where({ id: f.id }).update(patch);
    await this.audit(ctx, 'messaging.folder.updated', { folder: f.id }, { renamed: input.name !== undefined, ...(moved ? { parent: parentId } : {}) });
    return (await this.list(p)).find((x) => x.id === f.id)!;
  }

  /** Sets the order of one level: `ids` must be every custom folder under `parentId` (null for the top) once. */
  async reorder(ctx: Ctx, input: { parentId: string | null; ids: string[] }): Promise<FolderView[]> {
    const p = ctx.p;
    if (input.parentId) await this.own(p, input.parentId);
    const siblings = (await this.rows(p)).filter((f) => (f.parent_id ?? null) === input.parentId);
    const want = new Set(input.ids);
    if (want.size !== input.ids.length || want.size !== siblings.length || siblings.some((f) => !want.has(f.id))) {
      throw new HttpProblem(422, 'Not the folders of that level', 'Name every folder at that level once, in the new order.', { extensions: { field: 'ids' } });
    }
    const t = Date.now();
    await this.db.transaction(async (trx) => {
      for (const [i, id] of input.ids.entries()) await trx('dm_folders').where({ tenant_id: p.tenantId, user_id: p.userId, id }).update({ position: i, updated_at: t });
    });
    await this.audit(ctx, 'messaging.folder.reordered', { parent: input.parentId ?? 'top' }, { folders: input.ids.length });
    return this.list(p);
  }

  /** Deletes a folder and its subfolders; their conversations go back to the Inbox. */
  async remove(ctx: Ctx, id: string): Promise<{ id: string; deleted: true; folders: number; returned: number }> {
    const p = ctx.p;
    const f = await this.own(p, id);
    const ids = [f.id, ...((await this.db('dm_folders').where({ tenant_id: p.tenantId, user_id: p.userId, parent_id: f.id }).select('id')) as { id: string }[]).map((r) => r.id)];
    let returned = 0;
    await this.db.transaction(async (trx) => {
      returned = Number(await trx('dm_filings').where({ tenant_id: p.tenantId, user_id: p.userId }).whereIn('folder', ids).delete());
      await trx('dm_folders').where({ tenant_id: p.tenantId, user_id: p.userId }).whereIn('id', ids).delete();
    });
    await this.audit(ctx, 'messaging.folder.deleted', { folder: f.id }, { folders: ids.length, returned });
    return { id: f.id, deleted: true, folders: ids.length, returned };
  }

  /** Files one conversation the caller is in: `inbox`, `archive` or one of their folders. Only their own view changes. */
  async file(ctx: Ctx, conversationId: string, folder: string): Promise<{ conversationId: string; folder: string }> {
    const p = ctx.p;
    const a = await this.s().messaging.require(p, conversationId, 'read');
    if (!(BUILTIN_FOLDERS as readonly string[]).includes(folder)) await this.own(p, folder);
    const key = { conversation_id: a.conv.id, user_id: p.userId };
    await this.db.transaction(async (trx) => {
      await trx('dm_filings').where(key).delete();
      if (folder !== 'inbox') await trx('dm_filings').insert({ ...key, tenant_id: p.tenantId, folder, filed_at: Date.now() });
    });
    await this.s().audit.append({
      tenantId: p.tenantId,
      action: 'messaging.conversation.filed',
      kind: 'admin',
      actor: actorFrom(p, ctx.ip),
      target: { conversation: a.conv.id },
      detail: { folder: (BUILTIN_FOLDERS as readonly string[]).includes(folder) ? folder : 'custom', ...((BUILTIN_FOLDERS as readonly string[]).includes(folder) ? {} : { folderId: folder }) },
      label: a.conv.label,
      traceId: ctx.traceId ?? null
    });
    return { conversationId: a.conv.id, folder };
  }
}
