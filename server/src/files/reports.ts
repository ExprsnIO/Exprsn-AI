import { clears, highest, LABELS, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { Cid, CODEC_RAW } from '../atproto/encoding.js';
import { badRequest } from '../http/problem.js';
import { toXlsx, type XlsxValue } from '../imports/xlsx-writer.js';
import type { Workspace } from '../repos/tenants.js';
import type { Services } from '../services.js';
import type { FolderRow } from './service.js';

/*
 * 2.0.0 (file management): reports and a dashboard over a workspace's files, or over a folder and everything below
 * it. Read as a member of the workspace, within clearance: files above the caller's clearance, in the trash or taken
 * down are left out (the trash is counted apart). Files shared with the caller from elsewhere are not in reports.
 *
 * Everything is read in a few batched queries per scope (the files with their current version in one join; versions,
 * tags, shares, grants and owners in chunks of 500), never one query per file. A tabular report is capped at
 * REPORT_MAX_ROWS rows and says when it was cut. Rendered as CSV, a report neutralises cells that a spreadsheet would
 * read as a formula (a leading = + - @ tab or carriage return gets a quote): the report is generated content, and its
 * file names and tags are other people's text.
 */

export const REPORT_KINDS = ['inventory', 'largest', 'stale', 'duplicates', 'shared', 'activity', 'by-owner', 'by-type'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export type ReportFormat = 'csv' | 'xlsx' | 'json';
export type ColumnKind = 'text' | 'number' | 'bytes' | 'date' | 'datetime';

export interface ReportScope {
  workspaceId?: string | null;
  folderId?: string | null;
}

export interface ReportColumn {
  key: string;
  title: string;
  type: ColumnKind;
}

export interface Report {
  kind: ReportKind;
  title: string;
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  /** The highest label among the files in the scope: what a saved copy of the report is labelled at least. */
  label: Label;
  scope: ScopeView;
  generatedAt: number;
}

export interface ScopeView {
  workspaceId: string;
  workspaceName: string;
  folderId: string | null;
  folderName: string | null;
  /** The folders from the workspace root down to the scope's folder. */
  path: { id: string; name: string }[];
}

export const REPORT_MAX_ROWS = 10_000;
export const STALE_DAYS = 180;

const DAY = 86_400_000;
const CHUNK = 500;

const TYPE_NAMES: Record<string, string> = {
  'text/plain': 'Text',
  'text/markdown': 'Markdown',
  'text/csv': 'CSV',
  'text/html': 'HTML',
  'application/json': 'JSON',
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint',
  'application/vnd.oasis.opendocument.text': 'OpenDocument text',
  'application/vnd.oasis.opendocument.spreadsheet': 'OpenDocument spreadsheet',
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/webp': 'WebP',
  'image/gif': 'GIF'
};

export const typeName = (t: string | null): string => (t ? (TYPE_NAMES[t] ?? t) : 'Not scanned yet');

/** The CIDv1 (raw codec, SHA2-256, base32) of content with this SHA-256: what an AT-Protocol PDS calls the same bytes. */
export function cidOfSha256(hex: string | null | undefined): string | null {
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) return null;
  return Cid.create(CODEC_RAW, Buffer.from(hex, 'hex')).toString();
}

const REPORT_META: Record<ReportKind, { title: string; columns: ReportColumn[] }> = {
  inventory: {
    title: 'File inventory',
    columns: [
      { key: 'path', title: 'Path', type: 'text' },
      { key: 'name', title: 'Name', type: 'text' },
      { key: 'type', title: 'Type', type: 'text' },
      { key: 'size', title: 'Size', type: 'bytes' },
      { key: 'label', title: 'Label', type: 'text' },
      { key: 'state', title: 'State', type: 'text' },
      { key: 'version', title: 'Version', type: 'number' },
      { key: 'versions', title: 'Versions', type: 'number' },
      { key: 'owner', title: 'Owner', type: 'text' },
      { key: 'tags', title: 'Tags', type: 'text' },
      { key: 'created', title: 'Created', type: 'datetime' },
      { key: 'updated', title: 'Updated', type: 'datetime' },
      { key: 'sha256', title: 'SHA-256', type: 'text' },
      { key: 'cid', title: 'CID', type: 'text' }
    ]
  },
  largest: {
    title: 'Largest files',
    columns: [
      { key: 'path', title: 'Path', type: 'text' },
      { key: 'size', title: 'Size', type: 'bytes' },
      { key: 'versionBytes', title: 'All versions', type: 'bytes' },
      { key: 'versions', title: 'Versions', type: 'number' },
      { key: 'type', title: 'Type', type: 'text' },
      { key: 'owner', title: 'Owner', type: 'text' },
      { key: 'updated', title: 'Updated', type: 'datetime' }
    ]
  },
  stale: {
    title: `Files unchanged for ${STALE_DAYS} days`,
    columns: [
      { key: 'path', title: 'Path', type: 'text' },
      { key: 'size', title: 'Size', type: 'bytes' },
      { key: 'type', title: 'Type', type: 'text' },
      { key: 'owner', title: 'Owner', type: 'text' },
      { key: 'updated', title: 'Updated', type: 'datetime' },
      { key: 'days', title: 'Days unchanged', type: 'number' }
    ]
  },
  duplicates: {
    title: 'Duplicate files',
    columns: [
      { key: 'group', title: 'Group', type: 'number' },
      { key: 'path', title: 'Path', type: 'text' },
      { key: 'size', title: 'Size', type: 'bytes' },
      { key: 'owner', title: 'Owner', type: 'text' },
      { key: 'updated', title: 'Updated', type: 'datetime' },
      { key: 'sha256', title: 'SHA-256', type: 'text' },
      { key: 'cid', title: 'CID', type: 'text' }
    ]
  },
  shared: {
    title: 'Shared files',
    columns: [
      { key: 'path', title: 'Path', type: 'text' },
      { key: 'kind', title: 'Shared as', type: 'text' },
      { key: 'with', title: 'With', type: 'text' },
      { key: 'created', title: 'Shared', type: 'datetime' },
      { key: 'expires', title: 'Expires', type: 'datetime' },
      { key: 'uses', title: 'Uses', type: 'number' },
      { key: 'maxUses', title: 'Max uses', type: 'number' },
      { key: 'label', title: 'Label', type: 'text' }
    ]
  },
  activity: {
    title: 'Activity by person and month',
    columns: [
      { key: 'month', title: 'Month', type: 'text' },
      { key: 'person', title: 'Person', type: 'text' },
      { key: 'versions', title: 'Versions added', type: 'number' },
      { key: 'files', title: 'Files changed', type: 'number' },
      { key: 'bytes', title: 'Bytes added', type: 'bytes' }
    ]
  },
  'by-owner': {
    title: 'Storage by owner',
    columns: [
      { key: 'owner', title: 'Owner', type: 'text' },
      { key: 'files', title: 'Files', type: 'number' },
      { key: 'bytes', title: 'Size', type: 'bytes' },
      { key: 'versionBytes', title: 'All versions', type: 'bytes' },
      { key: 'share', title: 'Share of size (%)', type: 'number' }
    ]
  },
  'by-type': {
    title: 'Storage by type',
    columns: [
      { key: 'type', title: 'Type', type: 'text' },
      { key: 'mime', title: 'Media type', type: 'text' },
      { key: 'files', title: 'Files', type: 'number' },
      { key: 'bytes', title: 'Size', type: 'bytes' },
      { key: 'share', title: 'Share of size (%)', type: 'number' }
    ]
  }
};

export const reportTitle = (kind: ReportKind): string => REPORT_META[kind].title;

interface ScopedFile {
  id: string;
  name: string;
  folder_id: string | null;
  owner_id: string;
  label: Label;
  state: string;
  current_version: number | null;
  size: number;
  type: string | null;
  created_at: number;
  updated_at: number;
  sha256: string | null;
}

interface VersionLite {
  file_id: string;
  number: number;
  size: number;
  state: string;
  created_by: string | null;
  created_at: number;
}

interface ShareLite {
  id: string;
  file_id: string;
  kind: string;
  user_id: string | null;
  group_name: string | null;
  workspace_id: string | null;
  anonymous: boolean;
  expires_at: number | null;
  max_uses: number | null;
  uses: number;
  created_at: number;
}

interface GrantLite {
  id: string;
  file_id: string | null;
  folder_id: string | null;
  group_id: string;
  created_at: number;
}

/** Everything a report is computed from, read once per request. */
interface Loaded {
  w: Workspace;
  view: ScopeView;
  files: ScopedFile[];
  /** Non-trashed folder ids in the scope (the root folder included when the scope is a folder). */
  folderIds: Set<string>;
  folders: Map<string, FolderRow>;
  /** A file's folder path below the scope's root, ending in `/` (empty for a file directly in the root). */
  pathOf: (folderId: string | null) => string;
  versions: Map<string, VersionLite[]>;
  tags: Map<string, string[]>;
  shares: ShareLite[];
  /** Live group grants that cover files in the scope: on a file, on a folder in it, or on a folder above it. */
  grants: GrantLite[];
  /** Files covered by a live share or grant. */
  sharedFiles: Set<string>;
  users: Map<string, string>;
  trash: { files: number; bytes: number };
  label: Label;
  now: number;
}

const n = (v: unknown): number => Number(v ?? 0) || 0;
const nn = (v: unknown): number | null => (v == null ? null : Number(v));

export function monthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The last `count` months, oldest first, ending with the month of `now`. */
export function lastMonths(now: number, count = 12): string[] {
  const d = new Date(now);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(monthKey(m.getTime()));
  }
  return out;
}

const chunks = <T>(list: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
};

/** A CSV cell (RFC 4180): quoted when it must be; text that a spreadsheet would read as a formula gets a leading quote. */
export function csvCell(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export class FileReports {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  // ---------- loading ----------

  private async load(p: Principal, scope: ReportScope, o: { versions?: boolean; shares?: boolean } = {}): Promise<Loaded> {
    const s = this.s();
    const now = Date.now();
    let root: FolderRow | null = null;
    let w: Workspace;
    if (scope.folderId) {
      root = await s.files.folder(p, scope.folderId);
      w = await s.files.workspaceFor(p, root.workspace_id);
    } else w = await s.files.workspaceFor(p, scope.workspaceId ?? null);

    // Every folder of the workspace, trashed ones too (the trash is counted by where it was).
    const all = ((await this.db('file_folders').where({ tenant_id: p.tenantId, workspace_id: w.id }).select('id', 'parent_id', 'name', 'trashed_at')) as Record<string, unknown>[]).map(
      (r) => ({ id: String(r.id), parent_id: (r.parent_id as string | null) ?? null, name: String(r.name), trashed_at: nn(r.trashed_at) }) as unknown as FolderRow
    );
    const folders = new Map(all.map((f) => [f.id, f]));
    const kids = new Map<string | null, FolderRow[]>();
    for (const f of all) kids.set(f.parent_id, [...(kids.get(f.parent_id) ?? []), f]);
    const subtree = (rootId: string | null, withTrashed: boolean): Set<string> => {
      const out = new Set<string>();
      const stack = [...(kids.get(rootId) ?? [])];
      if (rootId) out.add(rootId);
      while (stack.length) {
        const f = stack.pop()!;
        if (out.has(f.id) || (!withTrashed && f.trashed_at != null)) continue;
        out.add(f.id);
        stack.push(...(kids.get(f.id) ?? []));
      }
      return out;
    };
    const folderIds = subtree(root?.id ?? null, false);
    const everyFolder = subtree(root?.id ?? null, true);
    const inScope = (folderId: string | null, set: Set<string>) => (folderId == null ? !root : set.has(folderId));

    const pathOf = (folderId: string | null): string => {
      const parts: string[] = [];
      for (let at = folderId, i = 0; at && at !== root?.id && i < 256; i++) {
        const f = folders.get(at);
        if (!f) break;
        parts.unshift(f.name);
        at = f.parent_id;
      }
      return parts.length ? `${parts.join('/')}/` : '';
    };
    const trail: { id: string; name: string }[] = [];
    for (let at = root?.id ?? null, i = 0; at && i < 256; i++) {
      const f = folders.get(at);
      if (!f) break;
      trail.unshift({ id: f.id, name: f.name });
      at = f.parent_id;
    }

    const cleared = LABELS.filter((l) => clears(p.clearance, l));
    const rows = (await this.db('files as f')
      .leftJoin('file_versions as v', (j) => void j.on('v.file_id', '=', 'f.id').andOn('v.number', '=', 'f.current_version'))
      .where({ 'f.tenant_id': p.tenantId, 'f.workspace_id': w.id })
      .whereNull('f.taken_down_at')
      .whereIn('f.label', cleared)
      .select('f.id', 'f.name', 'f.folder_id', 'f.owner_id', 'f.label', 'f.state', 'f.current_version', 'f.size', 'f.type', 'f.created_at', 'f.updated_at', 'f.trashed_at', 'v.sha256 as cur_sha256')) as Record<string, unknown>[];
    const files: ScopedFile[] = [];
    const trash = { files: 0, bytes: 0 };
    for (const r of rows) {
      const folderId = (r.folder_id as string | null) ?? null;
      if (r.trashed_at != null) {
        if (inScope(folderId, everyFolder)) {
          trash.files++;
          trash.bytes += n(r.size);
        }
        continue;
      }
      if (!inScope(folderId, folderIds)) continue;
      files.push({ id: String(r.id), name: String(r.name), folder_id: folderId, owner_id: String(r.owner_id), label: r.label as Label, state: String(r.state), current_version: nn(r.current_version), size: n(r.size), type: (r.type as string | null) ?? null, created_at: n(r.created_at), updated_at: n(r.updated_at), sha256: (r.cur_sha256 as string | null) ?? null });
    }
    const ids = files.map((f) => f.id);

    const versions = new Map<string, VersionLite[]>();
    if (o.versions !== false) {
      for (const part of chunks(ids)) {
        for (const r of (await this.db('file_versions').whereIn('file_id', part).select('file_id', 'number', 'size', 'state', 'created_by', 'created_at')) as Record<string, unknown>[]) {
          const v: VersionLite = { file_id: String(r.file_id), number: n(r.number), size: n(r.size), state: String(r.state), created_by: (r.created_by as string | null) ?? null, created_at: n(r.created_at) };
          versions.set(v.file_id, [...(versions.get(v.file_id) ?? []), v]);
        }
      }
    }
    const tags = new Map<string, string[]>();
    for (const part of chunks(ids)) for (const r of (await this.db('file_tags').whereIn('file_id', part).orderBy('tag').select('file_id', 'tag')) as { file_id: string; tag: string }[]) tags.set(r.file_id, [...(tags.get(r.file_id) ?? []), r.tag]);

    const shares: ShareLite[] = [];
    const grants: GrantLite[] = [];
    const sharedFiles = new Set<string>();
    if (o.shares !== false) {
      for (const part of chunks(ids)) {
        for (const r of (await this.db('file_shares').where({ tenant_id: p.tenantId }).whereIn('file_id', part).whereNull('revoked_at')) as Record<string, unknown>[]) {
          const x: ShareLite = { id: String(r.id), file_id: String(r.file_id), kind: String(r.kind), user_id: (r.user_id as string | null) ?? null, group_name: (r.group_name as string | null) ?? null, workspace_id: (r.workspace_id as string | null) ?? null, anonymous: !!r.anonymous, expires_at: nn(r.expires_at), max_uses: nn(r.max_uses), uses: n(r.uses), created_at: n(r.created_at) };
          if ((x.expires_at != null && x.expires_at <= now) || (x.max_uses != null && x.uses >= x.max_uses)) continue;
          shares.push(x);
          sharedFiles.add(x.file_id);
        }
      }
      // Grants on files in the scope, on folders in it, and on the folders above the scope's root (they cover it all).
      const above: string[] = [];
      for (let at = root?.parent_id ?? null, i = 0; at && i < 256; i++) {
        above.push(at);
        at = folders.get(at)?.parent_id ?? null;
      }
      const grantRow = (r: Record<string, unknown>): GrantLite => ({ id: String(r.id), file_id: (r.file_id as string | null) ?? null, folder_id: (r.folder_id as string | null) ?? null, group_id: String(r.group_id), created_at: n(r.created_at) });
      const seen = new Set<string>();
      const add = (g: GrantLite) => {
        if (!seen.has(g.id)) {
          seen.add(g.id);
          grants.push(g);
        }
      };
      for (const part of chunks(ids)) for (const r of (await this.db('file_group_grants').where({ tenant_id: p.tenantId }).whereIn('file_id', part).whereNull('revoked_at')) as Record<string, unknown>[]) add(grantRow(r));
      for (const part of chunks([...folderIds, ...above])) for (const r of (await this.db('file_group_grants').where({ tenant_id: p.tenantId }).whereIn('folder_id', part).whereNull('revoked_at')) as Record<string, unknown>[]) add(grantRow(r));
      const grantedFolders = new Set(grants.filter((g) => g.folder_id).map((g) => g.folder_id!));
      const coveredByFolder = (folderId: string | null): boolean => {
        for (let at = folderId, i = 0; at && i < 256; i++) {
          if (grantedFolders.has(at)) return true;
          at = folders.get(at)?.parent_id ?? null;
        }
        return false;
      };
      for (const g of grants) if (g.file_id) sharedFiles.add(g.file_id);
      if (grantedFolders.size) for (const f of files) if (coveredByFolder(f.folder_id)) sharedFiles.add(f.id);
    }

    const users = new Map<string, string>();
    const people = [...new Set([...files.map((f) => f.owner_id), ...[...versions.values()].flat().map((v) => v.created_by).filter((x): x is string => !!x), ...shares.map((x) => x.user_id).filter((x): x is string => !!x)])];
    for (const part of chunks(people)) for (const r of (await this.db('users').where({ tenant_id: p.tenantId }).whereIn('id', part).select('id', 'display_name', 'username')) as Record<string, unknown>[]) users.set(String(r.id), String(r.display_name ?? r.username ?? r.id));

    const label = files.length ? highest(...files.map((f) => f.label)) : 'public';
    const view: ScopeView = { workspaceId: w.id, workspaceName: w.name, folderId: root?.id ?? null, folderName: root?.name ?? null, path: trail };
    return { w, view, files, folderIds, folders, pathOf, versions, tags, shares, grants, sharedFiles, users, trash, label, now };
  }

  // ---------- the dashboard ----------

  async summary(p: Principal, scope: ReportScope) {
    const L = await this.load(p, scope);
    const { files, versions, now } = L;
    const allVersions = [...versions.values()].flat();
    const live = allVersions.filter((v) => v.state !== 'rejected');
    const bytes = files.reduce((a, f) => a + f.size, 0);

    const group = <K>(key: (f: ScopedFile) => K) => {
      const m = new Map<K, { files: number; bytes: number }>();
      for (const f of files) {
        const k = key(f);
        const cur = m.get(k) ?? { files: 0, bytes: 0 };
        cur.files++;
        cur.bytes += f.size;
        m.set(k, cur);
      }
      return m;
    };
    const byType = [...group((f) => f.type)].map(([type, x]) => ({ type, name: typeName(type), ...x })).sort((a, b) => b.bytes - a.bytes || b.files - a.files);
    const labels = group((f) => f.label);
    const byLabel = LABELS.filter((l) => labels.has(l)).map((label) => ({ label, ...labels.get(label)! }));
    const byOwner = [...group((f) => f.owner_id)].map(([ownerId, x]) => ({ ownerId, ownerName: L.users.get(ownerId) ?? null, ...x })).sort((a, b) => b.bytes - a.bytes || b.files - a.files).slice(0, 20);
    const tagCounts = new Map<string, number>();
    for (const f of files) for (const t of L.tags.get(f.id) ?? []) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    const byTag = [...tagCounts].map(([tag, c]) => ({ tag, files: c })).sort((a, b) => b.files - a.files || a.tag.localeCompare(b.tag)).slice(0, 30);

    // Each immediate child folder of the scope with the totals of everything below it, and the files directly in it.
    const rootId = L.view.folderId;
    const top = new Map<string, string>(); // folder id → the immediate child of the root it sits under
    const topOf = (folderId: string | null): string | null => {
      if (folderId == null || folderId === rootId) return null;
      const hit = top.get(folderId);
      if (hit !== undefined) return hit;
      let at: string | null = folderId;
      for (let i = 0; at && i < 256; i++) {
        const parent: string | null = L.folders.get(at)?.parent_id ?? null;
        if (parent === rootId) break;
        at = parent;
      }
      top.set(folderId, at ?? folderId);
      return at;
    };
    const folderTotals = new Map<string | null, { files: number; bytes: number }>();
    for (const f of files) {
      const k = topOf(f.folder_id);
      const cur = folderTotals.get(k) ?? { files: 0, bytes: 0 };
      cur.files++;
      cur.bytes += f.size;
      folderTotals.set(k, cur);
    }
    const children = [...L.folders.values()].filter((f) => f.parent_id === rootId && f.trashed_at == null).sort((a, b) => a.name.localeCompare(b.name));
    const byFolder = [
      { folderId: rootId, name: L.view.folderName ?? L.view.workspaceName, direct: true, files: folderTotals.get(null)?.files ?? 0, bytes: folderTotals.get(null)?.bytes ?? 0 },
      ...children.map((c) => ({ folderId: c.id, name: c.name, direct: false, files: folderTotals.get(c.id)?.files ?? 0, bytes: folderTotals.get(c.id)?.bytes ?? 0 }))
    ];

    const months = lastMonths(now);
    const tl = new Map(months.map((m) => [m, { month: m, created: 0, updated: 0, versions: 0, bytesAdded: 0 }]));
    for (const f of files) {
      const c = tl.get(monthKey(f.created_at));
      if (c) c.created++;
      const u = tl.get(monthKey(f.updated_at));
      if (u) u.updated++;
    }
    for (const v of live) {
      const t = tl.get(monthKey(v.created_at));
      if (t) {
        t.versions++;
        t.bytesAdded += v.size;
      }
    }

    const brief = (f: ScopedFile) => ({ id: f.id, name: f.name, size: f.size, type: f.type, typeName: typeName(f.type), folderId: f.folder_id, path: L.pathOf(f.folder_id) + f.name, updatedAt: f.updated_at, label: f.label });
    const staleCut = now - STALE_DAYS * DAY;
    const stale = files.filter((f) => f.updated_at < staleCut);
    const dup = this.duplicateGroups(files);

    return {
      scope: L.view,
      generatedAt: now,
      label: L.label,
      totals: {
        files: files.length,
        folders: rootId ? L.folderIds.size - 1 : L.folderIds.size,
        bytes,
        versions: allVersions.length,
        versionBytes: live.reduce((a, v) => a + v.size, 0),
        ready: files.filter((f) => f.state === 'ready').length,
        pending: files.filter((f) => f.state === 'pending').length,
        rejected: files.filter((f) => f.state === 'rejected').length,
        tagged: files.filter((f) => (L.tags.get(f.id) ?? []).length).length,
        shared: files.filter((f) => L.sharedFiles.has(f.id)).length,
        trashFiles: L.trash.files,
        trashBytes: L.trash.bytes
      },
      byType,
      byLabel,
      byOwner,
      byTag,
      byFolder,
      timeline: [...tl.values()],
      largest: files.slice().sort((a, b) => b.size - a.size).slice(0, 10).map(brief),
      recent: files.slice().sort((a, b) => b.updated_at - a.updated_at).slice(0, 10).map(brief),
      stale: { days: STALE_DAYS, files: stale.length, bytes: stale.reduce((a, f) => a + f.size, 0) },
      duplicates: { groups: dup.length, files: dup.reduce((a, g) => a + g.length, 0), wastedBytes: dup.reduce((a, g) => a + g[0]!.size * (g.length - 1), 0) },
      shares: {
        links: L.shares.filter((x) => x.kind === 'link').length,
        activeLinks: L.shares.filter((x) => x.kind === 'link').length,
        anonymousLinks: L.shares.filter((x) => x.kind === 'link' && x.anonymous).length,
        users: L.shares.filter((x) => x.kind === 'user').length,
        workspaces: L.shares.filter((x) => x.kind === 'workspace').length,
        groups: L.shares.filter((x) => x.kind === 'group').length,
        groupGrants: L.grants.length
      }
    };
  }

  /** Files whose current version has the same content, two or more to a group, largest groups first. */
  private duplicateGroups(files: ScopedFile[]): ScopedFile[][] {
    const by = new Map<string, ScopedFile[]>();
    for (const f of files) if (f.sha256 && f.state === 'ready') by.set(f.sha256, [...(by.get(f.sha256) ?? []), f]);
    return [...by.values()].filter((g) => g.length > 1).sort((a, b) => b[0]!.size * (b.length - 1) - a[0]!.size * (a.length - 1));
  }

  // ---------- tabular reports ----------

  async report(p: Principal, scope: ReportScope, kind: ReportKind): Promise<Report> {
    if (!REPORT_KINDS.includes(kind)) throw badRequest(`Unknown report ${String(kind)}.`);
    const L = await this.load(p, scope, { shares: kind === 'shared' });
    const meta = REPORT_META[kind];
    const owner = (id: string | null) => (id ? (L.users.get(id) ?? id) : '');
    const pathOf = (f: ScopedFile) => L.pathOf(f.folder_id) + f.name;
    const vs = (f: ScopedFile) => L.versions.get(f.id) ?? [];
    const vBytes = (f: ScopedFile) => vs(f).filter((v) => v.state !== 'rejected').reduce((a, v) => a + v.size, 0);
    let rows: Record<string, unknown>[] = [];
    const byPath = (a: ScopedFile, b: ScopedFile) => pathOf(a).localeCompare(pathOf(b));
    switch (kind) {
      case 'inventory':
        rows = L.files.sort(byPath).map((f) => ({ id: f.id, path: pathOf(f), name: f.name, type: typeName(f.type), size: f.size, label: f.label, state: f.state, version: f.current_version, versions: vs(f).length, owner: owner(f.owner_id), tags: (L.tags.get(f.id) ?? []).join(', '), created: f.created_at, updated: f.updated_at, sha256: f.sha256, cid: cidOfSha256(f.sha256) }));
        break;
      case 'largest':
        rows = L.files
          .sort((a, b) => b.size - a.size)
          .slice(0, 100)
          .map((f) => ({ id: f.id, path: pathOf(f), size: f.size, versionBytes: vBytes(f), versions: vs(f).length, type: typeName(f.type), owner: owner(f.owner_id), updated: f.updated_at }));
        break;
      case 'stale': {
        const cut = L.now - STALE_DAYS * DAY;
        rows = L.files
          .filter((f) => f.updated_at < cut)
          .sort((a, b) => a.updated_at - b.updated_at)
          .map((f) => ({ id: f.id, path: pathOf(f), size: f.size, type: typeName(f.type), owner: owner(f.owner_id), updated: f.updated_at, days: Math.floor((L.now - f.updated_at) / DAY) }));
        break;
      }
      case 'duplicates':
        this.duplicateGroups(L.files).forEach((g, i) => {
          for (const f of g.sort(byPath)) rows.push({ id: f.id, group: i + 1, path: pathOf(f), size: f.size, owner: owner(f.owner_id), updated: f.updated_at, sha256: f.sha256, cid: cidOfSha256(f.sha256) });
        });
        break;
      case 'shared': {
        const byId = new Map(L.files.map((f) => [f.id, f]));
        const wsNames = new Map((await this.s().tenants.workspaces(p.tenantId, { includeArchived: true })).map((w) => [w.id, w.name]));
        const groupIds = [...new Set(L.grants.map((g) => g.group_id))];
        const groupNames = new Map<string, string>();
        for (const part of chunks(groupIds)) for (const r of (await this.db('social_groups').where({ tenant_id: p.tenantId }).whereIn('id', part).select('id', 'name')) as { id: string; name: string }[]) groupNames.set(r.id, r.name);
        for (const x of L.shares) {
          const f = byId.get(x.file_id);
          if (!f) continue;
          const kindName = x.kind === 'link' ? (x.anonymous ? 'anonymous link' : 'link') : x.kind === 'group' ? 'directory group' : x.kind;
          const who = x.kind === 'user' ? owner(x.user_id) : x.kind === 'group' ? (x.group_name ?? '') : x.kind === 'workspace' ? (wsNames.get(x.workspace_id ?? '') ?? x.workspace_id ?? '') : 'whoever holds the link';
          rows.push({ id: f.id, path: pathOf(f), kind: kindName, with: who, created: x.created_at, expires: x.expires_at, uses: x.uses, maxUses: x.max_uses, label: f.label });
        }
        for (const g of L.grants) {
          const who = `group ${groupNames.get(g.group_id) ?? g.group_id}`;
          if (g.file_id) {
            const f = byId.get(g.file_id);
            if (f) rows.push({ id: f.id, path: pathOf(f), kind: 'group (social)', with: who, created: g.created_at, expires: null, uses: null, maxUses: null, label: f.label });
          } else if (g.folder_id) {
            const fo = L.folders.get(g.folder_id);
            const inside = L.folderIds.has(g.folder_id);
            rows.push({ id: null, folderId: g.folder_id, path: inside ? `${L.pathOf(g.folder_id)}` || `${fo?.name ?? ''}/` : `(above this folder) ${fo?.name ?? ''}/`, kind: 'folder to group (social)', with: who, created: g.created_at, expires: null, uses: null, maxUses: null, label: null });
          }
        }
        rows.sort((a, b) => String(a.path).localeCompare(String(b.path)));
        break;
      }
      case 'activity': {
        const m = new Map<string, { month: string; person: string; versions: number; files: Set<string>; bytes: number }>();
        for (const v of [...L.versions.values()].flat()) {
          if (v.state === 'rejected') continue;
          const month = monthKey(v.created_at);
          const k = `${month}\u0000${v.created_by ?? ''}`;
          const cur = m.get(k) ?? { month, person: owner(v.created_by) || 'a service', versions: 0, files: new Set<string>(), bytes: 0 };
          cur.versions++;
          cur.files.add(v.file_id);
          cur.bytes += v.size;
          m.set(k, cur);
        }
        rows = [...m.values()].sort((a, b) => b.month.localeCompare(a.month) || b.versions - a.versions).map((x) => ({ month: x.month, person: x.person, versions: x.versions, files: x.files.size, bytes: x.bytes }));
        break;
      }
      case 'by-owner':
      case 'by-type': {
        const total = L.files.reduce((a, f) => a + f.size, 0) || 1;
        const m = new Map<string, { files: number; bytes: number; versionBytes: number }>();
        for (const f of L.files) {
          const k = kind === 'by-owner' ? f.owner_id : (f.type ?? '');
          const cur = m.get(k) ?? { files: 0, bytes: 0, versionBytes: 0 };
          cur.files++;
          cur.bytes += f.size;
          cur.versionBytes += vBytes(f);
          m.set(k, cur);
        }
        rows = [...m]
          .sort((a, b) => b[1].bytes - a[1].bytes)
          .map(([k, x]) => (kind === 'by-owner' ? { ownerId: k, owner: owner(k), files: x.files, bytes: x.bytes, versionBytes: x.versionBytes, share: Math.round((x.bytes / total) * 1000) / 10 } : { type: typeName(k || null), mime: k, files: x.files, bytes: x.bytes, share: Math.round((x.bytes / total) * 1000) / 10 }));
        break;
      }
    }
    const truncated = rows.length > REPORT_MAX_ROWS;
    return { kind, title: meta.title, columns: meta.columns, rows: truncated ? rows.slice(0, REPORT_MAX_ROWS) : rows, truncated, label: L.label, scope: L.view, generatedAt: L.now };
  }

  // ---------- rendering ----------

  /** The report as a file: CSV (RFC 4180, CRLF, formula-safe), Excel, or JSON. */
  async render(p: Principal, scope: ReportScope, kind: ReportKind, format: ReportFormat): Promise<{ name: string; type: string; data: Buffer; report: Report }> {
    const report = await this.report(p, scope, kind);
    return { ...renderReport(report, format), report };
  }
}

/** The file name a report is offered under: its title, the folder or workspace, and the date. */
export function reportFileName(report: Report, format: ReportFormat): string {
  const where = report.scope.folderName ?? report.scope.workspaceName;
  const date = new Date(report.generatedAt).toISOString().slice(0, 10);
  // eslint-disable-next-line no-control-regex
  const base = `${report.title} - ${where} ${date}`.replace(/[/\\\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  return `${base}.${format}`;
}

const iso = (v: unknown): string => (v == null ? '' : new Date(Number(v)).toISOString());

export function renderReport(report: Report, format: ReportFormat): { name: string; type: string; data: Buffer } {
  const name = reportFileName(report, format);
  if (format === 'json') return { name, type: 'application/json', data: Buffer.from(JSON.stringify(report, null, 2), 'utf8') };
  if (format === 'csv') {
    const lines = [report.columns.map((c) => csvCell(c.title)).join(',')];
    for (const r of report.rows) lines.push(report.columns.map((c) => csvCell(c.type === 'datetime' || c.type === 'date' ? (r[c.key] == null ? '' : c.type === 'date' ? iso(r[c.key]).slice(0, 10) : iso(r[c.key])) : r[c.key])).join(','));
    return { name, type: 'text/csv', data: Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8') };
  }
  const cell = (c: ReportColumn, v: unknown): XlsxValue => {
    if (v == null || v === '') return null;
    if (c.type === 'date' || c.type === 'datetime') return new Date(Number(v));
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
    return String(v);
  };
  const data = toXlsx({
    title: report.title,
    author: 'Exprsn-AI',
    created: new Date(report.generatedAt),
    sheets: [
      {
        name: report.title.slice(0, 31),
        columns: report.columns.map((c) => ({ title: c.type === 'bytes' ? `${c.title} (bytes)` : c.title, type: c.type === 'date' ? 'date' : c.type === 'datetime' ? 'datetime' : c.type === 'text' ? 'text' : 'number' })),
        rows: report.rows.map((r) => ({ cells: report.columns.map((c) => cell(c, r[c.key])) }))
      }
    ]
  });
  return { name, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data };
}
