import { ulid } from 'ulid';
import { labelRank, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { conflict, forbidden, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import type { FileRow, FileShareRow, FolderRow } from './service.js';

/*
 * 1.7.0, Sprint 43 (B-9802): a social group as a reader of a file or of a folder.
 *
 * A grant names a group and either one file or one folder; a folder's grant covers every file below it, in its
 * subfolders too, as they are when the file is read. The group's members read those files as long as they count as
 * members (`GroupSubjects`: active, not banned or suspended, cleared for the group, in its workspace), within their
 * own clearance and the file's label. A grant gives read only: changing a file stays with its workspace's members.
 *
 * Granting takes the right to change the file (or, for a folder, membership of its workspace), and the group's
 * workspace ceiling must admit the file's label, as for a share with a workspace. Grants are revoked, not deleted.
 */

export interface GroupGrantRow {
  id: string;
  tenant_id: string;
  file_id: string | null;
  folder_id: string | null;
  group_id: string;
  created_by: string;
  created_at: number;
  revoked_at: number | null;
  revoked_by: string | null;
}

const rowFrom = (r: Record<string, unknown>): GroupGrantRow => ({ ...(r as unknown as GroupGrantRow), created_at: Number(r.created_at), revoked_at: r.revoked_at == null ? null : Number(r.revoked_at) });

export const groupGrantView = (g: GroupGrantRow, groupName?: string | null) => ({ id: g.id, fileId: g.file_id, folderId: g.folder_id, groupId: g.group_id, groupName: groupName ?? null, createdBy: g.created_by, createdAt: g.created_at });

/** How the read path reports a group grant: a share of kind `social_group`. */
const asShare = (g: GroupGrantRow, fileId: string): FileShareRow => ({ id: g.id, tenant_id: g.tenant_id, file_id: fileId, kind: 'social_group', user_id: null, group_name: null, workspace_id: null, token_hash: null, anonymous: false, expires_at: null, max_uses: null, uses: 0, created_by: g.created_by, created_at: g.created_at, revoked_at: null, revoked_by: null, last_used_at: null, social_group_id: g.group_id });

/** At most this many folders up from a file are looked at (the tree is a few levels deep in practice). */
const MAX_DEPTH = 64;

export class FileGroupGrants {
  constructor(
    private readonly s: () => Services,
    private readonly fs: { writable(p: Principal, id: string): Promise<FileRow>; folder(p: Principal, id: string): Promise<FolderRow> }
  ) {}

  private get db() {
    return this.s().db;
  }

  /** The folder and every folder above it. */
  async ancestors(tenantId: string, folderId: string | null): Promise<string[]> {
    const out: string[] = [];
    let at = folderId;
    while (at && out.length < MAX_DEPTH && !out.includes(at)) {
      out.push(at);
      const r = (await this.db('file_folders').where({ tenant_id: tenantId, id: at }).first('parent_id')) as { parent_id: string | null } | undefined;
      at = r?.parent_id ?? null;
    }
    return out;
  }

  /** The live grant that lets `p` read `f` through one of their groups, as a share, or null. */
  async match(p: Principal, f: FileRow): Promise<FileShareRow | null> {
    const mine = await this.s().groups.subjects.of(p);
    if (!mine.size) return null;
    const folders = await this.ancestors(p.tenantId, f.folder_id);
    const hit = (await this.db('file_group_grants').where({ tenant_id: p.tenantId }).whereNull('revoked_at').whereIn('group_id', [...mine])
      .andWhere((w) => { void w.where({ file_id: f.id }); if (folders.length) void w.orWhereIn('folder_id', folders); })
      .orderBy('created_at').first()) as Record<string, unknown> | undefined;
    return hit ? asShare(rowFrom(hit), f.id) : null;
  }

  /** Files `p` reads through a group grant (granted files and the files below granted folders), at most `limit`. */
  async files(p: Principal, limit = 500): Promise<{ grant: GroupGrantRow; fileId: string }[]> {
    const mine = await this.s().groups.subjects.of(p);
    if (!mine.size) return [];
    const grants = ((await this.db('file_group_grants').where({ tenant_id: p.tenantId }).whereNull('revoked_at').whereIn('group_id', [...mine]).orderBy('created_at', 'desc').limit(500)) as Record<string, unknown>[]).map(rowFrom);
    const out: { grant: GroupGrantRow; fileId: string }[] = [];
    for (const g of grants) {
      if (out.length >= limit) break;
      if (g.file_id) { out.push({ grant: g, fileId: g.file_id }); continue; }
      // a folder and everything below it, breadth first
      const queue = [g.folder_id!];
      const seen = new Set<string>();
      while (queue.length && out.length < limit && seen.size < 1000) {
        const folder = queue.shift()!;
        if (seen.has(folder)) continue;
        seen.add(folder);
        const ids = ((await this.db('files').where({ tenant_id: p.tenantId, folder_id: folder }).whereNull('trashed_at').select('id').limit(limit)) as { id: string }[]).map((r) => r.id);
        for (const id of ids) if (out.length < limit) out.push({ grant: g, fileId: id });
        queue.push(...((await this.db('file_folders').where({ tenant_id: p.tenantId, parent_id: folder }).whereNull('trashed_at').select('id')) as { id: string }[]).map((r) => r.id));
      }
    }
    return out;
  }

  /** Who may grant on a target, and the label and workspace the grant must fit. */
  private async target(p: Principal, t: { fileId: string } | { folderId: string }, opts: { listing?: boolean } = {}): Promise<{ fileId: string | null; folderId: string | null; workspaceId: string; label: Label | null; name: string }> {
    if ('fileId' in t) {
      const f = await this.fs.writable(p, t.fileId);
      // Granting needs a file that passed its scan; listing does not (a pending file simply has no grants yet).
      if (!opts.listing && f.state !== 'ready') throw conflict(`The file is ${f.state}; only a file that passed its scan can be granted.`);
      return { fileId: f.id, folderId: null, workspaceId: f.workspace_id, label: f.label, name: f.name };
    }
    const d = await this.fs.folder(p, t.folderId);
    return { fileId: null, folderId: d.id, workspaceId: d.workspace_id, label: null, name: d.name };
  }

  async list(p: Principal, t: { fileId: string } | { folderId: string }) {
    const at = await this.target(p, t, { listing: true });
    const rows = ((await this.db('file_group_grants').where({ tenant_id: p.tenantId, ...(at.fileId ? { file_id: at.fileId } : { folder_id: at.folderId }) }).whereNull('revoked_at').orderBy('created_at')) as Record<string, unknown>[]).map(rowFrom);
    const names = await this.s().groups.subjects.names(p.tenantId, rows.map((r) => r.group_id));
    return rows.map((r) => groupGrantView(r, names.get(r.group_id)));
  }

  async grant(p: Principal, t: { fileId: string } | { folderId: string }, groupId: string): Promise<{ grant: GroupGrantRow; groupName: string; label: string | null }> {
    const s = this.s();
    const at = await this.target(p, t);
    const g = await s.groups.subjects.subject(p.tenantId, groupId);
    if (!g) throw notFound('Group');
    const ws = await s.tenants.workspace(p.tenantId, g.workspace_id);
    if (!ws || ws.state !== 'active') throw notFound('Group');
    // A file above what the group's workspace may hold is not granted to it (as a share with a workspace).
    if (at.label && labelRank(at.label) > labelRank(ws.label_ceiling)) throw forbidden(`${g.name} is in ${ws.name}, whose ceiling is ${ws.label_ceiling}; this file is ${at.label}.`, { step: 'zone' });
    const dup = await this.db('file_group_grants').where({ tenant_id: p.tenantId, group_id: g.id, ...(at.fileId ? { file_id: at.fileId } : { folder_id: at.folderId }) }).whereNull('revoked_at').first('id');
    if (dup) throw conflict(`${at.name} is already granted to ${g.name}.`);
    const row: GroupGrantRow = { id: ulid(), tenant_id: p.tenantId, file_id: at.fileId, folder_id: at.folderId, group_id: g.id, created_by: p.userId, created_at: Date.now(), revoked_at: null, revoked_by: null };
    await this.db('file_group_grants').insert(row);
    return { grant: row, groupName: g.name, label: at.label };
  }

  async revoke(p: Principal, id: string): Promise<GroupGrantRow> {
    const r = (await this.db('file_group_grants').where({ tenant_id: p.tenantId, id }).whereNull('revoked_at').first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Grant');
    const g = rowFrom(r);
    await this.target(p, g.file_id ? { fileId: g.file_id } : { folderId: g.folder_id! });
    await this.db('file_group_grants').where({ id }).update({ revoked_at: Date.now(), revoked_by: p.userId });
    return g;
  }
}
