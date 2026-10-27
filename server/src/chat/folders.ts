import { ulid } from 'ulid';
import type { Principal } from '../authz/policy.js';
import { badRequest, conflict, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import type { ConversationRow } from './service.js';

/*
 * Chat folders (2026-10-15, migration 076): a person's own folders for their conversations in one workspace, nested at
 * most `MAX_DEPTH` deep and ordered by `position` among siblings. Only the owner sees or changes them; a folder holds
 * no conversation text, only `conversations.folder_id` points at it. The name is tenant content and sealed
 * (`chat-folder:<id>`). Deleting a folder deletes the folders below it and files their conversations under no folder.
 */

export const MAX_DEPTH = 3;
export const MAX_FOLDERS = 500;

export interface FolderRow {
  id: string;
  tenant_id: string;
  user_id: string;
  workspace_id: string | null;
  parent_id: string | null;
  name: string;
  position: number;
  created_at: number;
  updated_at: number;
}

export interface FolderView {
  id: string;
  name: string;
  parentId: string | null;
  position: number;
  depth: number;
  conversations: number;
  createdAt: number;
  updatedAt: number;
}

const fromRow = (r: Record<string, unknown>): FolderRow => ({ ...(r as unknown as FolderRow), position: Number(r.position), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });

export class ChatFolders {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  private scoped(p: Principal) {
    const q = this.db('chat_folders').where({ tenant_id: p.tenantId, user_id: p.userId });
    if (p.workspaceId) q.andWhere({ workspace_id: p.workspaceId });
    else q.whereNull('workspace_id');
    return q;
  }

  private async rows(p: Principal): Promise<FolderRow[]> {
    return ((await this.scoped(p).orderBy([{ column: 'position' }, { column: 'created_at' }])) as Record<string, unknown>[]).map(fromRow);
  }

  async get(p: Principal, id: string): Promise<FolderRow> {
    const r = (await this.scoped(p).andWhere({ id }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Folder');
    return fromRow(r);
  }

  private depthOf(byId: Map<string, FolderRow>, id: string | null): number {
    let d = 0;
    for (let cur = id ? byId.get(id) : undefined; cur && d <= MAX_DEPTH + 1; cur = cur.parent_id ? byId.get(cur.parent_id) : undefined) d++;
    return d;
  }

  /** The folder and every folder below it. */
  private subtree(all: FolderRow[], id: string): string[] {
    const out = [id];
    for (let i = 0; i < out.length; i++) for (const f of all) if (f.parent_id === out[i] && !out.includes(f.id)) out.push(f.id);
    return out;
  }

  /** Levels below a folder, the folder itself counting one. */
  private height(all: FolderRow[], id: string): number {
    const kids = all.filter((f) => f.parent_id === id);
    return 1 + (kids.length ? Math.max(...kids.map((k) => this.height(all, k.id))) : 0);
  }

  async list(p: Principal): Promise<FolderView[]> {
    const all = await this.rows(p);
    const byId = new Map(all.map((f) => [f.id, f]));
    const counts = new Map<string, number>();
    if (all.length) {
      const rows = (await this.db('conversations').where({ tenant_id: p.tenantId, user_id: p.userId }).whereIn('folder_id', all.map((f) => f.id)).whereNull('archived_at').groupBy('folder_id').select('folder_id').count({ n: '*' })) as { folder_id: string; n: number | string }[];
      for (const r of rows) counts.set(r.folder_id, Number(r.n));
    }
    const keys = this.s().keys;
    return Promise.all(all.map(async (f) => ({ id: f.id, name: await keys.open(f.tenant_id, f.name, `chat-folder:${f.id}`), parentId: f.parent_id, position: f.position, depth: this.depthOf(byId, f.id), conversations: counts.get(f.id) ?? 0, createdAt: f.created_at, updatedAt: f.updated_at })));
  }

  async view(p: Principal, id: string): Promise<FolderView> {
    const v = (await this.list(p)).find((f) => f.id === id);
    if (!v) throw notFound('Folder');
    return v;
  }

  /** Puts `id` at `position` among the children of `parentId` (null: the top level) and numbers them 0, 1, 2… */
  private async place(p: Principal, id: string, parentId: string | null, position: number | undefined): Promise<void> {
    const siblings = (await this.rows(p)).filter((f) => f.parent_id === parentId && f.id !== id);
    const at = Math.max(0, Math.min(position ?? siblings.length, siblings.length));
    const order = [...siblings.slice(0, at).map((f) => f.id), id, ...siblings.slice(at).map((f) => f.id)];
    const t = Date.now();
    for (let i = 0; i < order.length; i++) {
      const f = order[i]!;
      const cur = siblings.find((x) => x.id === f);
      if (f === id) await this.scoped(p).andWhere({ id }).update({ parent_id: parentId, position: i, updated_at: t });
      else if (cur && cur.position !== i) await this.scoped(p).andWhere({ id: f }).update({ position: i });
    }
  }

  /** Numbers the children of `parentId` 0, 1, 2… in their order (closes the gap a move or a delete leaves). */
  private async renumber(p: Principal, parentId: string | null): Promise<void> {
    const siblings = (await this.rows(p)).filter((x) => x.parent_id === parentId);
    for (let i = 0; i < siblings.length; i++) if (siblings[i]!.position !== i) await this.scoped(p).andWhere({ id: siblings[i]!.id }).update({ position: i });
  }

  async create(p: Principal, input: { name: string; parentId?: string | null }): Promise<FolderView> {
    const all = await this.rows(p);
    if (all.length >= MAX_FOLDERS) throw conflict(`You have ${MAX_FOLDERS} folders here, the most there can be.`);
    const parentId = input.parentId ?? null;
    if (parentId) {
      const byId = new Map(all.map((f) => [f.id, f]));
      if (!byId.has(parentId)) throw notFound('Parent folder');
      if (this.depthOf(byId, parentId) >= MAX_DEPTH) throw badRequest(`Folders nest at most ${MAX_DEPTH} deep.`);
    }
    const id = ulid();
    const t = Date.now();
    const row: FolderRow = { id, tenant_id: p.tenantId, user_id: p.userId, workspace_id: p.workspaceId ?? null, parent_id: parentId, name: await this.s().keys.seal(p.tenantId, input.name, `chat-folder:${id}`), position: all.filter((f) => f.parent_id === parentId).length, created_at: t, updated_at: t };
    await this.db('chat_folders').insert(row);
    return this.view(p, id);
  }

  async rename(p: Principal, id: string, name: string): Promise<FolderView> {
    const f = await this.get(p, id);
    await this.scoped(p).andWhere({ id: f.id }).update({ name: await this.s().keys.seal(p.tenantId, name, `chat-folder:${f.id}`), updated_at: Date.now() });
    return this.view(p, id);
  }

  /** Moves a folder under another (or to the top level) and/or to a place among its siblings. */
  async move(p: Principal, id: string, input: { parentId?: string | null; position?: number }): Promise<{ folder: FolderView; from: string | null }> {
    const all = await this.rows(p);
    const f = all.find((x) => x.id === id);
    if (!f) throw notFound('Folder');
    const parentId = input.parentId === undefined ? f.parent_id : input.parentId;
    if (parentId) {
      const byId = new Map(all.map((x) => [x.id, x]));
      if (!byId.has(parentId)) throw notFound('Parent folder');
      if (this.subtree(all, id).includes(parentId)) throw badRequest('A folder cannot go inside itself or a folder within it.');
      if (this.depthOf(byId, parentId) + this.height(all, id) > MAX_DEPTH) throw badRequest(`Folders nest at most ${MAX_DEPTH} deep; this one has folders inside it.`);
    }
    await this.place(p, id, parentId, input.position);
    if (parentId !== f.parent_id) await this.renumber(p, f.parent_id);
    return { folder: await this.view(p, id), from: f.parent_id };
  }

  /** Deletes the folder and those below it; their conversations go back to no folder. */
  async remove(p: Principal, id: string): Promise<{ folders: number; conversations: number }> {
    const all = await this.rows(p);
    const f = all.find((x) => x.id === id);
    if (!f) throw notFound('Folder');
    const ids = this.subtree(all, id);
    const conversations = await this.db('conversations').where({ tenant_id: p.tenantId, user_id: p.userId }).whereIn('folder_id', ids).update({ folder_id: null });
    await this.scoped(p).whereIn('id', ids).delete();
    await this.renumber(p, f.parent_id);
    return { folders: ids.length, conversations: Number(conversations) || 0 };
  }

  /** Files one of the caller's conversations in a folder of the same workspace, or under no folder. */
  async file(p: Principal, conversationId: string, folderId: string | null): Promise<{ c: ConversationRow; from: string | null }> {
    const c = await this.s().chat.conversation(p, conversationId);
    const from = ((await this.db('conversations').where({ id: c.id }).first('folder_id')) as { folder_id: string | null } | undefined)?.folder_id ?? null;
    if (folderId) {
      const f = await this.get(p, folderId);
      if ((f.workspace_id ?? null) !== (c.workspace_id ?? null)) throw conflict('That conversation belongs to another workspace than the folder.');
    }
    await this.db('conversations').where({ tenant_id: p.tenantId, id: c.id }).update({ folder_id: folderId });
    return { c, from };
  }
}
