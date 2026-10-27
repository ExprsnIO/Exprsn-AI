import { mac, macs } from '../vault/keyring.js';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ulid } from 'ulid';
import { FileGroupGrants } from './group-grants.js';
import { clears, highest, LABELS, labelRank, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { randomToken } from '../crypto/index.js';
import { json } from '../db/knex.js';
import { workspacesFor } from '../http/middleware.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { readerEntries } from '../knowledge/acl.js';
import { ACCEPTED as KNOWLEDGE_TYPES } from '../knowledge/extract.js';
import type { SourceItem } from '../knowledge/sources.js';
import { TOPICS, type IntegrationEvent } from '../platform/bus.js';
import type { JobContext } from '../platform/jobs.js';
import type { Workspace } from '../repos/tenants.js';
import type { Services } from '../services.js';
import { FileBlobs } from './dedup.js';
import { collect, decryptStream, encryptStream, newFileKey, packKey, unpackKey, type FileKey } from './crypt.js';
import { PreviewUnavailable, type PreviewRenderer } from './preview.js';
import { STRIP_BUFFER_MAX, StripError, stripBuffer, strippable, stripStream } from './exif.js';
import { textDiff } from '../knowledge/diff.js';
import { generate, ModelUnavailable, parseJsonObject } from '../apps/ai.js';
import { DOCX as DOCX_TYPE, ExtractionError, extractText, TEXT_TYPES } from '../knowledge/extract.js';
import { clamStream, IMAGE_TYPES, inspect } from './scan.js';
import { cidOf, sha256OfCid } from './cid.js';
import { FileLocations } from './locations/service.js';
import { Albums } from './albums.js';

/*
 * The file store (B-2401 to B-2405), on the existing blob store.
 *
 * Files live in a workspace's folder tree; members of the workspace read and write them within their clearance.
 * Every upload, new version and restored version is a version that goes through quarantine: the bytes stream into
 * the blob store sealed (files/crypt.ts), a job detects the type from the bytes, classifies text, scans with ClamAV
 * when configured (files/scan.ts) and checks the label against the uploader's clearance and the workspace ceiling;
 * only then is the version ready, and only a ready version is ever served. Restoring an old version writes its content
 * again as a new version, which is scanned again (ClamAV's signatures may have changed since).
 *
 * 1.7.0 (B-9501): a takedown is its own state (`taken_down_at`). A taken-down file is served to nobody and is out of
 * the folder tree like a trashed one, but it is not in the trash members see, they can neither restore nor purge it,
 * and only the moderation decision lifts it. B-9502, B-9504: the purge leaves what `s.evidence` says is kept (an open
 * moderation case, a legal hold on the case or the object). B-9503: a workspace may set a retention period (an
 * unchanged file goes to the trash) and a version cap (the newest versions of each file stay); both leave files under
 * a hold alone.
 *
 * Trash is a mark: a folder or file put in the trash takes what is inside with it, can be restored until its purge
 * date (FILES_TRASH_DAYS), and the `files.purge` job deletes it and its blobs after that.
 *
 * Shares are read-only: with a user, a directory group, or a workspace of the tenant, or a link (a token shown once,
 * stored as an HMAC) that may expire and may be used a limited number of times. A link's use is consumed atomically
 * in the database, so a link past its limit is refused even under concurrent requests. Anonymous links follow the
 * conversation rules (B-706): the tenant's anonymous-link setting, public files only, the tenant's maximum lifetime.
 * Every download is audited. Storage quotas per tenant and per workspace are enforced while the bytes arrive.
 */

export type FileState = 'pending' | 'ready' | 'rejected';
export type VersionState = 'quarantined' | 'scanning' | 'ready' | 'rejected';
/** `social_group` (1.7.0, B-9802) is a group grant (`files/group-grants.ts`) as the read path reports it; never a row of file_shares. */
export type ShareKind = 'user' | 'group' | 'workspace' | 'link' | 'social_group';

export interface FolderRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  parent_id: string | null;
  name: string;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  trashed_at: number | null;
  trashed_by: string | null;
  trashed_with: string | null;
  purge_after: number | null;
}

export interface FileRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  folder_id: string | null;
  owner_id: string;
  name: string;
  name_lower: string;
  label: Label;
  state: FileState;
  current_version: number | null;
  size: number;
  type: string | null;
  created_at: number;
  updated_at: number;
  trashed_at: number | null;
  trashed_by: string | null;
  trashed_with: string | null;
  purge_after: number | null;
  /** 1.7.0 (B-9501): set while a moderation decision keeps the file down. */
  taken_down_at?: number | null;
  taken_down_by?: string | null;
}

export interface VersionRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  file_id: string;
  number: number;
  state: VersionState;
  size: number;
  sha256: string;
  type: string | null;
  declared_type: string | null;
  label: Label;
  reason: string | null;
  findings: { scanner?: string; detections?: Record<string, number>; dlp?: { label: Label; action: string | null; rules: string[] }; shared?: boolean } | null;
  blob_key: string | null;
  sealed_key: string | null;
  /** 1.6.0 (B-4601): the shared object this version reads (`file_blobs`); null for an object of its own. */
  blob_id?: string | null;
  restored_from: number | null;
  created_by: string | null;
  created_at: number;
  scanned_at: number | null;
}

export interface PreviewRow {
  version_id: string;
  tenant_id: string;
  file_id: string;
  state: 'queued' | 'ready' | 'failed' | 'unavailable';
  type: string | null;
  size: number | null;
  blob_key: string | null;
  sealed_key: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

/** 1.8.0 (B-142, migration 099): alt text and a description of an image, per file. */
export interface FileMetaRow {
  file_id: string;
  tenant_id: string;
  alt_text: string | null;
  description: string | null;
  alt_version: number | null;
  updated_by: string | null;
  updated_at: number;
}

export interface FileMeta {
  altText: string | null;
  description: string | null;
  /** The version the text was written for (the picture may have changed since). */
  altVersion: number | null;
  altUpdatedAt: number | null;
}

/** Limits of a version compare (B-142): the bytes read of each version and the characters of text compared. */
export const COMPARE_LIMITS = { maxBytes: 4 * 1024 * 1024, maxChars: 1_000_000, maxLines: 20_000, maxDiffChars: 400_000 };
export const META_LIMITS = { altText: 1000, description: 4000 };

export const metaView = (m: FileMetaRow | undefined): FileMeta => ({ altText: m?.alt_text ?? null, description: m?.description ?? null, altVersion: m?.alt_version == null ? null : Number(m.alt_version), altUpdatedAt: m ? Number(m.updated_at) : null });

/** One hunk of a version compare: the line numbers on each side and its lines (` ` both, `-` before only, `+` after only). */
export interface DiffHunk {
  fromStart: number;
  fromCount: number;
  toStart: number;
  toCount: number;
  lines: { op: ' ' | '-' | '+'; text: string }[];
}

/** textDiff's unified text as hunks the console draws unified or side by side. */
export function diffHunks(unified: string): DiffHunk[] {
  const out: DiffHunk[] = [];
  for (const line of unified ? unified.split('\n') : []) {
    const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(line);
    if (m) out.push({ fromStart: Number(m[1]), fromCount: Number(m[2]), toStart: Number(m[3]), toCount: Number(m[4]), lines: [] });
    else if (out.length) out[out.length - 1]!.lines.push({ op: (line[0] === '-' || line[0] === '+' ? line[0] : ' ') as ' ' | '-' | '+', text: line.slice(1) });
  }
  return out;
}

export interface FileShareRow {
  id: string;
  tenant_id: string;
  file_id: string;
  kind: ShareKind;
  user_id: string | null;
  group_name: string | null;
  workspace_id: string | null;
  token_hash: string | null;
  anonymous: boolean;
  expires_at: number | null;
  max_uses: number | null;
  uses: number;
  created_by: string;
  created_at: number;
  revoked_at: number | null;
  revoked_by: string | null;
  last_used_at: number | null;
  /** 1.7.0 (B-9802): the social group of a group grant. */
  social_group_id?: string | null;
}

export interface FilesOptions {
  maxBytes: number;
  trashDays: number;
  previewMaxBytes: number;
  previewPx: number;
  clamd?: { host: string; port: number };
  workDir?: string;
  renderer: PreviewRenderer;
}

export interface StorageScope {
  scope: 'tenant' | 'workspace';
  workspaceId: string | null;
  usedBytes: number;
  maxBytes: number | null;
  files: number;
}

/** What the knowledge service needs to use a folder as a source (B-2405). */
export interface FolderSourceProvider {
  check(p: Principal, folderId: string): Promise<{ id: string; name: string; workspaceId: string }>;
  items(tenantId: string, folderId: string, maxLabel: Label, maxBytes: number): Promise<SourceItem[]>;
}

/** The object type this store registers with the moderation object registry (B-1901). */
export const FILE_OBJECT_TYPE = 'file';

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const folderFrom = (r: Record<string, unknown>): FolderRow => ({ ...(r as unknown as FolderRow), created_at: Number(r.created_at), updated_at: Number(r.updated_at), trashed_at: num(r.trashed_at), purge_after: num(r.purge_after) });
const fileFrom = (r: Record<string, unknown>): FileRow => ({ ...(r as unknown as FileRow), current_version: num(r.current_version), size: Number(r.size), created_at: Number(r.created_at), updated_at: Number(r.updated_at), trashed_at: num(r.trashed_at), purge_after: num(r.purge_after), taken_down_at: num(r.taken_down_at), taken_down_by: (r.taken_down_by as string | null | undefined) ?? null });
const versionFrom = (r: Record<string, unknown>): VersionRow => ({ ...(r as unknown as VersionRow), number: Number(r.number), size: Number(r.size), findings: json(r.findings, null), restored_from: num(r.restored_from), created_at: Number(r.created_at), scanned_at: num(r.scanned_at) });
const previewFrom = (r: Record<string, unknown>): PreviewRow => ({ ...(r as unknown as PreviewRow), size: num(r.size), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
const shareFrom = (r: Record<string, unknown>): FileShareRow => ({ ...(r as unknown as FileShareRow), anonymous: !!r.anonymous, expires_at: num(r.expires_at), max_uses: num(r.max_uses), uses: Number(r.uses ?? 0), created_at: Number(r.created_at), revoked_at: num(r.revoked_at), last_used_at: num(r.last_used_at) });

const live = (x: FileShareRow, now = Date.now()) => x.revoked_at == null && (x.expires_at == null || x.expires_at > now) && (x.max_uses == null || x.uses < x.max_uses);
const versionAad = (id: string) => `file-version:${id}`;
const previewAad = (id: string) => `file-preview:${id}`;
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ACTIVE_VERSION_STATES: VersionState[] = ['quarantined', 'scanning', 'ready'];
/** 1.8.0 (B-142): what the vision profile is asked for a suggested alt text. */
const ALT_PROMPT = 'You write alt text for images, for people who use screen readers. Describe what the image shows that matters to a reader, in one or two plain sentences of at most 150 characters. Do not start with "Image of" or "Picture of", and do not guess at names, places or other facts the image does not show. Answer with a JSON object {"alt": "..."}.';

export const fileView = (f: FileRow, extra: { tags?: string[]; ownerName?: string | null } = {}) => ({
  id: f.id,
  name: f.name,
  workspaceId: f.workspace_id,
  folderId: f.folder_id,
  ownerId: f.owner_id,
  ...(extra.ownerName !== undefined ? { ownerName: extra.ownerName } : {}),
  label: f.label,
  state: f.state,
  size: f.size,
  type: f.type,
  currentVersion: f.current_version,
  ...(extra.tags ? { tags: extra.tags } : {}),
  createdAt: f.created_at,
  updatedAt: f.updated_at,
  trashedAt: f.trashed_at,
  purgeAfter: f.purge_after
});

export const folderView = (f: FolderRow) => ({ id: f.id, name: f.name, workspaceId: f.workspace_id, parentId: f.parent_id, createdAt: f.created_at, updatedAt: f.updated_at, trashedAt: f.trashed_at, purgeAfter: f.purge_after });

export const versionView = (v: VersionRow) => ({ number: v.number, state: v.state, size: v.size, sha256: v.sha256, cid: v.state === 'rejected' ? null : cidOf(v.sha256), type: v.type, label: v.label, reason: v.reason, findings: v.findings, restoredFrom: v.restored_from, createdBy: v.created_by, createdAt: v.created_at, scannedAt: v.scanned_at });

export const fileShareView = (x: FileShareRow, extra: { userName?: string | null; workspaceName?: string | null } = {}) => ({
  id: x.id,
  fileId: x.file_id,
  kind: x.kind,
  userId: x.user_id,
  userName: extra.userName ?? null,
  group: x.group_name,
  workspaceId: x.workspace_id,
  workspaceName: extra.workspaceName ?? null,
  anonymous: x.anonymous,
  expiresAt: x.expires_at,
  maxUses: x.max_uses,
  uses: x.uses,
  createdAt: x.created_at,
  revokedAt: x.revoked_at,
  lastUsedAt: x.last_used_at,
  state: x.revoked_at != null ? 'revoked' : x.expires_at != null && x.expires_at <= Date.now() ? 'expired' : x.max_uses != null && x.uses >= x.max_uses ? 'used up' : 'active'
});

const quotaExceeded = (scope: 'tenant' | 'workspace', used: number, max: number, incoming: number) =>
  new HttpProblem(413, 'Storage quota exceeded', `${scope === 'tenant' ? 'This tenant' : 'This workspace'} has ${Math.max(0, max - used).toLocaleString('en-US')} of ${max.toLocaleString('en-US')} bytes of file storage left; the upload needs ${incoming.toLocaleString('en-US')}. Empty the trash or ask ${scope === 'tenant' ? 'a system admin' : 'a tenant admin'} to raise the limit.`, {
    extensions: { limit: 'storage_bytes', scope, used, max, incoming }
  });

export class FileService {
  /** 1.7.0 (B-9802): files and folders granted to social groups. */
  readonly groupGrants: FileGroupGrants;
  /** 1.6.0 (B-4601): the tenant's shared, reference-counted objects. */
  readonly dedup: FileBlobs;
  /** 2.0.0: linked storage locations (S3, Azure, local stores, SFTP, FTP, IPFS). */
  readonly locations: FileLocations;
  /** 1.9.0 (B-177 to B-179): albums of files, their share and upload links. */
  readonly albums: Albums;
  /** 1.9.0 (B-178): told when a version's scan finished (ready or rejected); a listener's failure is logged only. */
  readonly settledListeners: ((e: { tenantId: string; fileId: string; version: number; state: 'ready' | 'rejected'; reason?: string }) => Promise<void>)[] = [];

  constructor(
    private readonly s: () => Services,
    private readonly o: FilesOptions
  ) {
    this.dedup = new FileBlobs(() => this.s().db);
    this.groupGrants = new FileGroupGrants(s, this);
    this.locations = new FileLocations(s);
    this.albums = new Albums(s, this);
    this.settledListeners.push((e) => this.albums.links.onSettled(e));
  }

  private get db() {
    return this.s().db;
  }

  get options(): Readonly<FilesOptions> {
    return this.o;
  }

  registerJobs(): void {
    const jobs = this.s().jobs;
    jobs.register('file.scan', (p) => this.scan(String(p.versionId)), { timeoutMs: 30 * 60_000 });
    jobs.register('file.preview', (p, ctx) => this.renderPreview(String(p.versionId), ctx), { timeoutMs: 5 * 60_000 });
    this.locations.registerJobs();
    this.albums.registerJobs();
    // The scheduled run (no `all`) first applies the workspaces' retention and version caps (B-9503), then purges.
    jobs.register('files.purge', async (p, ctx) => {
      const tenantId = String(p.tenantId ?? ctx.job.tenant_id);
      const retention = p.all ? null : await this.applyRetention(tenantId);
      return { ...(await this.purge(tenantId, { workspaceId: (p.workspaceId as string | undefined) ?? null, all: !!p.all, by: (p.by as string | undefined) ?? null })), ...(retention ? { retention } : {}) };
    });
  }

  schedule(minutes: number, targets: () => Promise<{ tenantId: string; payload?: Record<string, unknown> }[]>): void {
    if (minutes > 0) this.s().scheduler.every('files.purge', minutes * 60_000, targets);
  }

  // ---------- access ----------

  private async memberWorkspaces(p: Principal): Promise<Map<string, Workspace>> {
    return new Map((await workspacesFor(this.s(), p)).map((w) => [w.id, w]));
  }

  /** The workspace a request acts in: the one named, else the current one; the caller must be a member. */
  async workspaceFor(p: Principal, requested?: string | null): Promise<Workspace> {
    const id = requested ?? p.workspaceId ?? null;
    const w = id ? (await this.memberWorkspaces(p)).get(id) : undefined;
    if (!w) throw id ? notFound('Workspace') : conflict('Choose a workspace first: files live in a workspace.');
    return w;
  }

  private async fileRow(tenantId: string, id: string): Promise<FileRow | undefined> {
    const r = await this.db('files').where({ tenant_id: tenantId, id }).first();
    return r ? fileFrom(r) : undefined;
  }

  private async folderRow(tenantId: string, id: string): Promise<FolderRow | undefined> {
    const r = await this.db('file_folders').where({ tenant_id: tenantId, id }).first();
    return r ? folderFrom(r) : undefined;
  }

  /** A folder in one of the caller's workspaces (not in the trash unless asked). */
  async folder(p: Principal, id: string, o: { trashed?: boolean } = {}): Promise<FolderRow> {
    const f = await this.folderRow(p.tenantId, id);
    if (!f || (f.trashed_at != null && !o.trashed)) throw notFound('Folder');
    if (!(await this.memberWorkspaces(p)).has(f.workspace_id)) throw notFound('Folder');
    return f;
  }

  /** A file the caller may change: a member of its workspace, cleared for its label. */
  async writable(p: Principal, id: string, o: { trashed?: boolean } = {}): Promise<FileRow> {
    const f = await this.fileRow(p.tenantId, id);
    if (!f || (f.trashed_at != null && !o.trashed)) throw notFound('File');
    if (!(await this.memberWorkspaces(p)).has(f.workspace_id)) throw notFound('File');
    if (!clears(p.clearance, f.label)) throw forbidden(`This file is ${f.label}; your clearance is ${p.clearance}.`, { step: 'clearance' });
    return f;
  }

  /** The live user, group or workspace share that lets `p` read a file, or null. */
  private async grantFor(p: Principal, f: FileRow): Promise<FileShareRow | null> {
    const rows = ((await this.db('file_shares').where({ tenant_id: p.tenantId, file_id: f.id }).whereIn('kind', ['user', 'group', 'workspace']).whereNull('revoked_at')) as Record<string, unknown>[]).map(shareFrom).filter((x) => live(x));
    const direct = rows.find((x) => x.kind === 'user' && x.user_id === p.userId);
    if (direct) return direct;
    const ws = rows.filter((x) => x.kind === 'workspace');
    if (ws.length) {
      const mine = await this.memberWorkspaces(p);
      const hit = ws.find((x) => x.workspace_id && mine.has(x.workspace_id));
      if (hit) return hit;
    }
    const groups = rows.filter((x) => x.kind === 'group');
    if (groups.length) {
      const entries = await readerEntries(this.db, p);
      const hit = groups.find((x) => x.group_name && entries.has(`g:${x.group_name}`));
      if (hit) return hit;
    }
    // 1.7.0 (B-9802): a grant of the file, or of a folder above it, to a social group the caller counts as a member of.
    return this.groupGrants.match(p, f);
  }

  /** A file the caller may read: through its workspace or a share, cleared for its current label. */
  async readable(p: Principal, id: string): Promise<{ file: FileRow; via: 'workspace' | FileShareRow }> {
    const f = await this.fileRow(p.tenantId, id);
    if (!f || f.trashed_at != null) throw notFound('File');
    let via: 'workspace' | FileShareRow;
    if ((await this.memberWorkspaces(p)).has(f.workspace_id)) via = 'workspace';
    else {
      const g = await this.grantFor(p, f);
      if (!g) throw notFound('File');
      via = g;
    }
    if (!clears(p.clearance, f.label)) throw forbidden(`This file is ${f.label}; your clearance is ${p.clearance}.`, { step: 'clearance' });
    return { file: f, via };
  }

  // ---------- names and folders ----------

  private async nameTaken(tenantId: string, workspaceId: string, folderId: string | null, name: string, except?: string): Promise<boolean> {
    const lower = name.toLowerCase();
    const fq = this.db('files').where({ tenant_id: tenantId, workspace_id: workspaceId, folder_id: folderId, name_lower: lower }).whereNull('trashed_at');
    if (except) fq.andWhereNot({ id: except });
    if (await fq.first('id')) return true;
    const folders = (await this.db('file_folders').where({ tenant_id: tenantId, workspace_id: workspaceId, parent_id: folderId }).whereNull('trashed_at').select('id', 'name')) as { id: string; name: string }[];
    return folders.some((x) => x.id !== except && x.name.toLowerCase() === lower);
  }

  async createFolder(p: Principal, input: { workspaceId?: string | null; parentId?: string | null; name: string }): Promise<FolderRow> {
    let w: Workspace;
    let parent: FolderRow | null = null;
    if (input.parentId) {
      parent = await this.folder(p, input.parentId);
      w = await this.workspaceFor(p, parent.workspace_id);
      if (input.workspaceId && input.workspaceId !== parent.workspace_id) throw conflict('The parent folder is in another workspace.');
    } else w = await this.workspaceFor(p, input.workspaceId);
    if (await this.nameTaken(p.tenantId, w.id, parent?.id ?? null, input.name)) throw conflict(`Something named ${input.name} is already in this folder.`);
    const t = Date.now();
    const row: FolderRow = { id: ulid(), tenant_id: p.tenantId, workspace_id: w.id, parent_id: parent?.id ?? null, name: input.name, created_by: p.userId, created_at: t, updated_at: t, trashed_at: null, trashed_by: null, trashed_with: null, purge_after: null };
    await this.db('file_folders').insert(row);
    return row;
  }

  /** Folder ids under `rootId`, the root included (only those not in the trash, unless `trashed`). */
  private async descendants(tenantId: string, rootId: string, o: { trashed?: boolean } = {}): Promise<string[]> {
    const out = [rootId];
    let frontier = [rootId];
    while (frontier.length) {
      const q = this.db('file_folders').where({ tenant_id: tenantId }).whereIn('parent_id', frontier);
      if (!o.trashed) q.whereNull('trashed_at');
      const kids = ((await q.select('id')) as { id: string }[]).map((r) => r.id).filter((id) => !out.includes(id));
      out.push(...kids);
      frontier = kids;
      if (out.length > 100_000) throw conflict('The folder tree is too deep to walk.');
    }
    return out;
  }

  async updateFolder(p: Principal, id: string, patch: { name?: string; parentId?: string | null }): Promise<{ before: FolderRow; after: FolderRow }> {
    const f = await this.folder(p, id);
    let parentId = f.parent_id;
    if (patch.parentId !== undefined && patch.parentId !== f.parent_id) {
      if (patch.parentId) {
        const target = await this.folder(p, patch.parentId);
        if (target.workspace_id !== f.workspace_id) throw conflict('Folders move within their workspace.');
        if ((await this.descendants(p.tenantId, f.id)).includes(target.id)) throw conflict('A folder cannot move into itself or a folder inside it.');
      }
      parentId = patch.parentId;
    }
    const name = patch.name ?? f.name;
    if ((name !== f.name || parentId !== f.parent_id) && (await this.nameTaken(p.tenantId, f.workspace_id, parentId, name, f.id))) throw conflict(`Something named ${name} is already there.`);
    const t = Date.now();
    await this.db('file_folders').where({ id: f.id }).update({ name, parent_id: parentId, updated_at: t });
    return { before: f, after: { ...f, name, parent_id: parentId, updated_at: t } };
  }

  /** The folder's contents (the workspace root when no folder): folders, and files the caller is cleared for. */
  async browse(p: Principal, input: { workspaceId?: string | null; folderId?: string | null }) {
    let folder: FolderRow | null = null;
    let w: Workspace;
    if (input.folderId) {
      folder = await this.folder(p, input.folderId);
      w = await this.workspaceFor(p, folder.workspace_id);
    } else w = await this.workspaceFor(p, input.workspaceId);
    const folders = ((await this.db('file_folders').where({ tenant_id: p.tenantId, workspace_id: w.id, parent_id: folder?.id ?? null }).whereNull('trashed_at').orderBy('name')) as Record<string, unknown>[]).map(folderFrom);
    const files = ((await this.db('files').where({ tenant_id: p.tenantId, workspace_id: w.id, folder_id: folder?.id ?? null }).whereNull('trashed_at').whereIn('label', LABELS.filter((l) => clears(p.clearance, l))).orderBy('name_lower')) as Record<string, unknown>[]).map(fileFrom);
    const tags = await this.tagsFor(files.map((f) => f.id));
    const trail: { id: string; name: string }[] = [];
    for (let cur = folder; cur; cur = cur.parent_id ? ((await this.folderRow(p.tenantId, cur.parent_id)) ?? null) : null) trail.unshift({ id: cur.id, name: cur.name });
    return { workspace: { id: w.id, name: w.name, labelCeiling: w.label_ceiling }, folder: folder ? folderView(folder) : null, path: trail, folders: folders.map(folderView), files: files.map((f) => fileView(f, { tags: tags.get(f.id) ?? [] })) };
  }

  // ---------- quotas and usage (B-2403) ----------

  async limit(tenantId: string, workspaceId: string | null): Promise<{ maxBytes: number | null; updatedBy: string | null; updatedAt: number | null }> {
    const r = (await this.db('file_quotas').where({ tenant_id: tenantId, workspace_id: workspaceId }).first()) as { max_bytes: unknown; updated_by: string | null; updated_at: unknown } | undefined;
    return { maxBytes: num(r?.max_bytes), updatedBy: r?.updated_by ?? null, updatedAt: num(r?.updated_at) };
  }

  async setLimit(tenantId: string, workspaceId: string | null, maxBytes: number | null, by: string): Promise<void> {
    const row = { max_bytes: maxBytes, updated_by: by, updated_at: Date.now() };
    const n = await this.db('file_quotas').where({ tenant_id: tenantId, workspace_id: workspaceId }).update(row);
    if (!n) await this.db('file_quotas').insert({ id: ulid(), tenant_id: tenantId, workspace_id: workspaceId, ...row });
  }

  /** Bytes held: every version that is stored or waiting for its scan, in the trash too, until purged. */
  async used(tenantId: string, workspaceId: string | null): Promise<{ bytes: number; files: number }> {
    const q = this.db('file_versions').where({ tenant_id: tenantId }).whereIn('state', ACTIVE_VERSION_STATES);
    if (workspaceId) q.andWhere({ workspace_id: workspaceId });
    const r = ((await q.sum({ b: 'size' })) as Record<string, unknown>[])[0];
    const fq = this.db('files').where({ tenant_id: tenantId }).whereNot({ state: 'rejected' });
    if (workspaceId) fq.andWhere({ workspace_id: workspaceId });
    const c = ((await fq.count({ n: '*' })) as Record<string, unknown>[])[0];
    return { bytes: Number(r?.b ?? 0), files: Number(c?.n ?? 0) };
  }

  async storage(tenantId: string, workspaceId: string | null): Promise<StorageScope> {
    const [l, u] = await Promise.all([this.limit(tenantId, workspaceId), this.used(tenantId, workspaceId)]);
    return { scope: workspaceId ? 'workspace' : 'tenant', workspaceId, usedBytes: u.bytes, maxBytes: l.maxBytes, files: u.files };
  }

  /** Throws 413 when `incoming` more bytes would pass the workspace's or the tenant's limit. */
  private async assertRoom(tenantId: string, workspaceId: string, incoming: number): Promise<void> {
    for (const sc of [await this.storage(tenantId, workspaceId), await this.storage(tenantId, null)]) {
      if (sc.maxBytes != null && sc.usedBytes + incoming > sc.maxBytes) throw quotaExceeded(sc.scope, sc.usedBytes, sc.maxBytes, incoming);
    }
  }

  /** The smallest room left under any limit, or null when there is none. */
  private async room(tenantId: string, workspaceId: string): Promise<{ scope: 'tenant' | 'workspace'; used: number; max: number } | null> {
    let best: { scope: 'tenant' | 'workspace'; used: number; max: number } | null = null;
    for (const sc of [await this.storage(tenantId, workspaceId), await this.storage(tenantId, null)]) {
      if (sc.maxBytes == null) continue;
      if (!best || sc.maxBytes - sc.usedBytes < best.max - best.used) best = { scope: sc.scope, used: sc.usedBytes, max: sc.maxBytes };
    }
    return best;
  }

  // ---------- uploads and versions (B-2401) ----------

  private tooLarge(): HttpProblem {
    return new HttpProblem(413, 'Payload too large', `The file is above the upload cap of ${this.o.maxBytes.toLocaleString('en-US')} bytes (FILES_MAX_BYTES).`, { extensions: { cap: 'size', max: this.o.maxBytes } });
  }

  /** A new file from an upload stream: quarantined until its scan finishes. */
  async upload(p: Principal, input: { workspaceId?: string | null; folderId?: string | null; name: string; label: Label; declaredType: string | null; declaredBytes: number | null }, body: AsyncIterable<Buffer | Uint8Array>): Promise<{ file: FileRow; version: VersionRow }> {
    let w: Workspace;
    let folder: FolderRow | null = null;
    if (input.folderId) {
      folder = await this.folder(p, input.folderId);
      w = await this.workspaceFor(p, folder.workspace_id);
    } else w = await this.workspaceFor(p, input.workspaceId);
    this.checkLabel(p, w, input.label);
    if (await this.nameTaken(p.tenantId, w.id, folder?.id ?? null, input.name)) throw conflict(`Something named ${input.name} is already in this folder; upload a new version of the file instead.`);
    const t = Date.now();
    const file: FileRow = { id: ulid(), tenant_id: p.tenantId, workspace_id: w.id, folder_id: folder?.id ?? null, owner_id: p.userId, name: input.name, name_lower: input.name.toLowerCase(), label: input.label, state: 'pending', current_version: null, size: 0, type: null, created_at: t, updated_at: t, trashed_at: null, trashed_by: null, trashed_with: null, purge_after: null };
    await this.db('files').insert(file);
    try {
      const version = await this.ingest(p.userId, file, { label: input.label, declaredType: input.declaredType, declaredBytes: input.declaredBytes, restoredFrom: null }, body);
      return { file, version };
    } catch (err) {
      await this.db('files').where({ id: file.id }).delete();
      throw err;
    }
  }

  /** A new version of an existing file from an upload stream. */
  async uploadVersion(p: Principal, id: string, input: { label?: Label; declaredType: string | null; declaredBytes: number | null }, body: AsyncIterable<Buffer | Uint8Array>): Promise<{ file: FileRow; version: VersionRow }> {
    const file = await this.writable(p, id);
    const w = await this.workspaceFor(p, file.workspace_id);
    const label = input.label ?? file.label;
    this.checkLabel(p, w, label);
    const version = await this.ingest(p.userId, file, { label, declaredType: input.declaredType, declaredBytes: input.declaredBytes, restoredFrom: null }, body);
    return { file, version };
  }

  /** Writes an old version's content again as a new version, which goes through quarantine and is scanned again. */
  async restoreVersion(p: Principal, id: string, number: number): Promise<{ file: FileRow; version: VersionRow; from: VersionRow }> {
    const file = await this.writable(p, id);
    const from = await this.versionByNumber(file, number);
    if (from.state !== 'ready' || !from.blob_key) throw conflict(`Version ${number} is ${from.state}; only a version that passed its scan can be restored.`);
    if (!clears(p.clearance, from.label)) throw forbidden(`Version ${number} is ${from.label}; your clearance is ${p.clearance}.`, { step: 'clearance' });
    const version = await this.ingest(p.userId, file, { label: from.label, declaredType: from.type, declaredBytes: from.size, restoredFrom: from.number }, await this.plain(from));
    return { file, version, from };
  }

  private checkLabel(p: Principal, w: Workspace, label: Label): void {
    if (!clears(p.clearance, label)) throw forbidden(`Your clearance is ${p.clearance}; the file would be ${label}.`, { step: 'clearance' });
    if (labelRank(label) > labelRank(w.label_ceiling)) throw forbidden(`${w.name}'s ceiling is ${w.label_ceiling}; the file would be ${label}.`, { step: 'zone' });
  }

  /**
   * Streams content into sealed quarantine and records the version. The size cap and the storage quota are checked
   * while the bytes arrive (an upload is cut off as soon as it passes either), and the quota once more after the
   * version is recorded, so two uploads finishing together cannot both pass a limit only one fits under.
   */
  private async ingest(userId: string, file: FileRow, o: { label: Label; declaredType: string | null; declaredBytes: number | null; restoredFrom: number | null }, body: AsyncIterable<Buffer | Uint8Array>): Promise<VersionRow> {
    const s = this.s();
    const max = this.o.maxBytes;
    if (o.declaredBytes != null && o.declaredBytes > max) throw this.tooLarge();
    if (o.declaredBytes != null) await this.assertRoom(file.tenant_id, file.workspace_id, o.declaredBytes);
    const room = await this.room(file.tenant_id, file.workspace_id);
    const id = ulid();
    const key = newFileKey();
    const blobKey = `files/${file.tenant_id}/quarantine/${id}`;
    const hash = createHash('sha256');
    let bytes = 0;
    const tooLarge = () => this.tooLarge();
    const counted = async function* (): AsyncGenerator<Buffer> {
      for await (const c of body) {
        const b = Buffer.isBuffer(c) ? c : Buffer.from(c.buffer, c.byteOffset, c.byteLength);
        bytes += b.length;
        if (bytes > max) throw tooLarge();
        if (room && room.used + bytes > room.max) throw quotaExceeded(room.scope, room.used, room.max, bytes);
        hash.update(b);
        yield b;
      }
    };
    try {
      await s.blobs.putStream(blobKey, encryptStream(counted(), key, versionAad(id)), 'application/octet-stream');
    } catch (err) {
      await s.blobs.delete(blobKey).catch(() => undefined);
      throw err;
    }
    const sealedKey = await s.keys.sealBytes(file.tenant_id, packKey(key), `file-key:${id}`);
    const sha256 = hash.digest('hex');
    let row: VersionRow | null = null;
    for (let attempt = 0; attempt < 5 && !row; attempt++) {
      const last = ((await this.db('file_versions').where({ file_id: file.id }).max({ n: 'number' })) as Record<string, unknown>[])[0];
      const candidate: VersionRow = { id, tenant_id: file.tenant_id, workspace_id: file.workspace_id, file_id: file.id, number: Number(last?.n ?? 0) + 1, state: 'quarantined', size: bytes, sha256, type: null, declared_type: o.declaredType?.slice(0, 120) ?? null, label: o.label, reason: null, findings: null, blob_key: blobKey, sealed_key: sealedKey, restored_from: o.restoredFrom, blob_id: null, created_by: userId, created_at: Date.now(), scanned_at: null };
      try {
        await this.db('file_versions').insert({ ...candidate, findings: null });
        row = candidate;
      } catch (err) {
        // Another version of the same file took the number: take the next one.
        if (attempt === 4) {
          await s.blobs.delete(blobKey).catch(() => undefined);
          throw err;
        }
      }
    }
    const v = row!;
    const after = await this.room(file.tenant_id, file.workspace_id);
    if (after && after.used > after.max) {
      await this.db('file_versions').where({ id: v.id }).delete();
      await s.blobs.delete(blobKey).catch(() => undefined);
      throw quotaExceeded(after.scope, after.used - bytes, after.max, bytes);
    }
    await s.jobs.enqueue({ tenantId: file.tenant_id, type: 'file.scan', payload: { versionId: v.id }, createdBy: userId, maxAttempts: 3, dedupeKey: `file.scan:${v.id}` });
    return v;
  }

  /**
   * 1.5.0 (B-3201): finishes a version's quarantine scan before answering (a WebDAV PUT, whose client reads the file
   * back at once). The scan is still the `file.scan` job: it is claimed and run here when this instance can (database
   * queue), otherwise the worker's result is awaited. Returns the version as it then is; still quarantined or scanning
   * when the scan did not finish within `waitMs` (it carries on as a job, and the file stays unreadable until then).
   */
  async scanNow(versionId: string, waitMs = 30_000): Promise<VersionRow | null> {
    const job = (await this.db('jobs').where({ dedupe_key: `file.scan:${versionId}` }).first('id', 'state')) as { id: string; state: string } | undefined;
    if (job?.state === 'queued') await this.s().jobs.runNow(job.id);
    const until = Date.now() + waitMs;
    for (;;) {
      const r = await this.db('file_versions').where({ id: versionId }).first();
      if (!r) return null;
      const v = versionFrom(r);
      if (v.state === 'ready' || v.state === 'rejected' || Date.now() >= until) return v;
      // Only a running scan is worth waiting for: one that failed waits for its retry, in the background.
      const now = job ? ((await this.db('jobs').where({ id: job.id }).first('state')) as { state: string } | undefined) : undefined;
      if (now && now.state !== 'running' && now.state !== 'queued') return v;
      if (now?.state === 'queued' && job?.state === 'queued' && !(await this.db('jobs').where({ id: job.id }).andWhere('run_at', '<=', Date.now()).first('id'))) return v;
      await new Promise((res) => setTimeout(res, 100));
    }
  }

  private async versionByNumber(file: FileRow, number: number): Promise<VersionRow> {
    const r = await this.db('file_versions').where({ file_id: file.id, number }).first();
    if (!r) throw notFound('Version');
    return versionFrom(r);
  }

  async versions(p: Principal, id: string): Promise<VersionRow[]> {
    const file = await this.writable(p, id);
    return ((await this.db('file_versions').where({ file_id: file.id }).orderBy('number', 'desc')) as Record<string, unknown>[]).map(versionFrom);
  }

  private async keyOf(tenantId: string, sealed: string, aad: string): Promise<FileKey> {
    return unpackKey(await this.s().keys.openBytes(tenantId, sealed, aad));
  }

  /** The plaintext of a stored version, decrypted segment by segment as it is read. */
  private async plain(v: VersionRow): Promise<AsyncIterable<Buffer>> {
    if (!v.blob_key || !v.sealed_key) throw notFound('File content');
    // A shared object (B-4601) was sealed for the version that first stored it: its key and stream name that version.
    const owner = v.blob_id ?? v.id;
    const key = await this.keyOf(v.tenant_id, v.sealed_key, `file-key:${owner}`);
    const got = await this.s().blobs.getStream(v.blob_key);
    if (!got) throw notFound('File content');
    return decryptStream(got.stream as AsyncIterable<Buffer>, key, versionAad(owner));
  }

  /** The current version's content (or version `number`'s, for members of the file's workspace). */
  async content(p: Principal, id: string, number?: number): Promise<{ file: FileRow; version: VersionRow; stream: AsyncIterable<Buffer>; via: 'workspace' | FileShareRow }> {
    const { file, version, via } = await this.readyVersion(p, id, number);
    return { file, version, stream: await this.plain(version), via };
  }

  /** The checks of `content` without opening the bytes: for a caller that may already hold the version decoded. */
  async readyVersion(p: Principal, id: string, number?: number): Promise<{ file: FileRow; version: VersionRow; via: 'workspace' | FileShareRow }> {
    const { file, via } = number == null ? await this.readable(p, id) : { file: await this.writable(p, id), via: 'workspace' as const };
    const n = number ?? file.current_version;
    if (n == null) throw conflict(`The file is ${file.state}: no version has passed its scan yet.`);
    const version = await this.versionByNumber(file, n);
    if (version.state !== 'ready') throw conflict(`Version ${n} is ${version.state}.`);
    if (!clears(p.clearance, version.label)) throw forbidden(`Version ${n} is ${version.label}; your clearance is ${p.clearance}.`, { step: 'clearance' });
    return { file, version, via };
  }

  /**
   * 1.5.0 (B-5801): the state of one version of a file, for a caller that pins a version (a profile's avatar) and
   * decides who may see it itself. `gone` when the file or version no longer exists or the file is in the trash
   * (deleted by its owner or taken down by moderation).
   */
  async pinnedVersion(tenantId: string, fileId: string, number: number): Promise<{ state: VersionState | 'gone'; type: string | null; label: Label | null; size: number }> {
    const file = await this.fileRow(tenantId, fileId);
    if (!file || file.trashed_at != null) return { state: 'gone', type: null, label: null, size: 0 };
    const r = await this.db('file_versions').where({ file_id: file.id, number }).first();
    if (!r) return { state: 'gone', type: null, label: null, size: 0 };
    const v = versionFrom(r);
    return { state: v.state, type: v.type, label: v.label, size: v.size };
  }

  /** The content of a pinned version that passed its scan (B-5801), or null for anything else. */
  async pinnedContent(tenantId: string, fileId: string, number: number): Promise<{ type: string | null; label: Label; size: number; stream: AsyncIterable<Buffer> } | null> {
    const file = await this.fileRow(tenantId, fileId);
    if (!file || file.trashed_at != null) return null;
    const r = await this.db('file_versions').where({ file_id: file.id, number }).first();
    if (!r) return null;
    const v = versionFrom(r);
    if (v.state !== 'ready') return null;
    if (!strippable(v.type)) return { type: v.type, label: v.label, size: v.size, stream: await this.plain(v) };
    // 1.8.0 (B-142): avatars and group pictures are served without their metadata (read whole: they are small).
    if (v.size > STRIP_BUFFER_MAX) return null;
    try {
      const data = await stripBuffer(v.type, await collect(await this.plain(v)));
      return { type: v.type, label: v.label, size: data.length, stream: (async function* () { yield data; })() };
    } catch (err) {
      if (err instanceof StripError) return null;
      throw err;
    }
  }

  // ---------- the quarantine scan ----------

  private async scan(versionId: string): Promise<unknown> {
    const s = this.s();
    const r = await this.db('file_versions').where({ id: versionId }).first();
    if (!r) return { skipped: 'gone' };
    const v = versionFrom(r);
    if (v.state !== 'quarantined' && v.state !== 'scanning') return { skipped: v.state };
    const file = await this.fileRow(v.tenant_id, v.file_id);
    if (!file) return { skipped: 'gone' };
    await this.db('file_versions').where({ id: v.id }).update({ state: 'scanning' });
    const reject = async (reason: string, findings: VersionRow['findings'] = null) => {
      if (v.blob_key) await s.blobs.delete(v.blob_key).catch(() => undefined);
      await this.db('file_versions').where({ id: v.id }).update({ state: 'rejected', reason: reason.slice(0, 500), findings: findings ? JSON.stringify(findings) : null, blob_key: null, sealed_key: null, scanned_at: Date.now() });
      if (file.current_version == null) await this.db('files').where({ id: file.id }).whereNull('current_version').update({ state: 'rejected', updated_at: Date.now() });
      await s.audit.append({ tenantId: v.tenant_id, action: 'file.version.rejected', kind: 'system', actor: { service: 'files', user: v.created_by ?? undefined }, target: { file: file.id, version: v.number }, label: v.label, detail: { reason, ...(v.restored_from != null ? { restoredFrom: v.restored_from } : {}), ...(findings ? { findings } : {}) } });
      this.notifyOwner(file, v, 'rejected', reason);
      await this.settled({ tenantId: v.tenant_id, fileId: file.id, version: v.number, state: 'rejected', reason });
      return { state: 'rejected', reason };
    };
    try {
      const result = await inspect(await this.plain(v), file.name, v.label);
      if ('rejected' in result) return await reject(result.rejected);
      let scanner = 'type check only (no ClamAV configured)';
      if (this.o.clamd) {
        const found = await clamStream(this.o.clamd.host, this.o.clamd.port, await this.plain(v));
        if (found) return await reject(`Malware detected: ${found}`, { scanner: 'clamav' });
        scanner = 'clamav: clean';
      }
      let label = highest(v.label, result.label);
      // 1.6.0 (B-7601): the tenant's DLP rules on text uploads: the label rises; a hold rejects the version.
      let dlpFinding: { label: Label; action: string | null; rules: string[] } | undefined;
      if (/^text\//.test(result.type) || result.type === 'application/json') {
        const max = s.cfg.DLP_MAX_TEXT_BYTES;
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of await this.plain(v)) {
          chunks.push(chunk);
          size += chunk.length;
          if (size >= max) break;
        }
        const dlp = await s.dlp.inspect({ tenantId: v.tenant_id, text: Buffer.concat(chunks).subarray(0, max).toString('utf8'), scope: 'upload', label });
        if (dlp.rules.length) {
          label = highest(label, dlp.label);
          dlpFinding = { label: dlp.label, action: dlp.action, rules: dlp.rules.map((x) => x.name) };
          if (dlp.action === 'hold') return await reject(`Held by the DLP rule ${dlpFinding.rules.join(', ')}.`, { scanner, detections: result.detections, dlp: dlpFinding });
        }
      }
      const findings = { scanner, detections: result.detections, ...(dlpFinding ? { dlp: dlpFinding } : {}) };
      const user = (await this.db('users').where({ id: v.created_by ?? '' }).first('clearance')) as { clearance: Label } | undefined;
      const ws = await s.tenants.workspace(v.tenant_id, v.workspace_id);
      if (user && labelRank(label) > labelRank(user.clearance)) return await reject(`Classified ${label}, above the uploader's clearance.`, findings);
      if (ws && labelRank(label) > labelRank(ws.label_ceiling)) return await reject(`Classified ${label}, above this workspace's ceiling of ${ws.label_ceiling}.`, findings);
      // Out of quarantine. 1.6.0 (B-4601): content the tenant already stores is shared (the quarantined copy goes);
      // anything else moves as it is (no re-encryption) and becomes a blob later uploads of the same content share.
      const t = Date.now();
      const shared = await this.dedup.adopt(v);
      if (shared) {
        await s.blobs.delete(v.blob_key!);
        await this.db('file_versions').where({ id: v.id }).update({ state: 'ready', type: result.type, label, findings: JSON.stringify({ ...findings, shared: true }), blob_key: shared.blob_key, sealed_key: shared.sealed_key, blob_id: shared.id, scanned_at: t });
      } else {
        const storeKey = `files/${v.tenant_id}/store/${v.id}`;
        const got = await s.blobs.getStream(v.blob_key!);
        if (!got) throw new Error('The quarantined content is missing.');
        await s.blobs.putStream(storeKey, got.stream as AsyncIterable<Buffer>, 'application/octet-stream');
        await s.blobs.delete(v.blob_key!);
        const own = await this.dedup.register({ ...v, blob_key: storeKey });
        await this.db('file_versions').where({ id: v.id }).update({ state: 'ready', type: result.type, label, findings: JSON.stringify(findings), blob_key: storeKey, blob_id: own ? v.id : null, scanned_at: t });
      }
      // The newest ready version is current; an older one finishing later does not take its place.
      const moved = await this.db('files')
        .where({ id: file.id })
        .andWhere((q) => q.whereNull('current_version').orWhere('current_version', '<', v.number))
        .update({ current_version: v.number, state: 'ready', size: v.size, type: result.type, label, updated_at: t });
      const after = (await this.fileRow(v.tenant_id, file.id))!;
      await s.audit.append({ tenantId: v.tenant_id, action: 'file.version.ready', kind: 'system', actor: { service: 'files', user: v.created_by ?? undefined }, target: { file: file.id, version: v.number }, label, detail: { type: result.type, size: v.size, sha256: v.sha256, scanner, ...(shared ? { sharedWith: shared.id } : {}), ...(v.restored_from != null ? { restoredFrom: v.restored_from } : {}), current: !!moved } });
      if (moved) {
        const type = v.restored_from != null ? 'file.restored' : v.number === 1 ? 'file.uploaded' : 'file.updated';
        this.event(type, after, v.number, v.created_by, v.restored_from != null ? { from: v.restored_from } : {});
      }
      this.notifyOwner(after, v, 'ready');
      if (moved) await this.settled({ tenantId: v.tenant_id, fileId: file.id, version: v.number, state: 'ready' });
      if ((IMAGE_TYPES.includes(result.type) || result.type === 'application/pdf') && v.size <= this.o.previewMaxBytes) {
        await this.db('file_previews').insert({ version_id: v.id, tenant_id: v.tenant_id, file_id: file.id, state: 'queued', type: null, size: null, blob_key: null, sealed_key: null, error: null, created_at: t, updated_at: t });
        await s.jobs.enqueue({ tenantId: v.tenant_id, type: 'file.preview', payload: { versionId: v.id }, createdBy: v.created_by, maxAttempts: 2 });
      }
      return { state: 'ready', type: result.type, label, detections: result.detections };
    } catch (err) {
      // A scan that could not finish (clamd down) leaves the version in quarantine for the retry.
      await this.db('file_versions').where({ id: v.id, state: 'scanning' }).update({ state: 'quarantined' });
      throw err;
    }
  }

  private async settled(e: { tenantId: string; fileId: string; version: number; state: 'ready' | 'rejected'; reason?: string }): Promise<void> {
    for (const l of this.settledListeners) await l(e).catch((err: unknown) => this.s().log.warn({ err: (err as Error).message, file: e.fileId }, 'a scan listener failed'));
  }

  private notifyOwner(f: FileRow, v: VersionRow, state: string, reason?: string): void {
    if (!v.created_by) return;
    this.s().bus.publish(TOPICS.chatEvent, { userId: v.created_by, tenantId: f.tenant_id, event: 'file.state', data: { id: f.id, version: v.number, state, ...(reason ? { reason } : {}) } });
  }

  private event(type: string, f: FileRow, version: number, actor: string | null, extra: Record<string, unknown> = {}): void {
    this.s().bus.emitLocal(TOPICS.integrationEvent, { tenantId: f.tenant_id, type, label: f.label, id: `${type}:${ulid()}`, data: { file: f.id, folder: f.folder_id, workspace: f.workspace_id, version: Math.max(1, version), actor, ...extra } } satisfies IntegrationEvent);
  }

  private async lastNumber(fileId: string): Promise<number> {
    const r = ((await this.db('file_versions').where({ file_id: fileId }).max({ n: 'number' })) as Record<string, unknown>[])[0];
    return Number(r?.n ?? 1) || 1;
  }

  // ---------- previews (B-2404) ----------

  private async renderPreview(versionId: string, ctx: JobContext): Promise<unknown> {
    const s = this.s();
    const r = await this.db('file_versions').where({ id: versionId }).first();
    if (!r) return { skipped: 'gone' };
    const v = versionFrom(r);
    if (v.state !== 'ready' || !v.type) return { skipped: v.state };
    const kind = IMAGE_TYPES.includes(v.type) ? ('image' as const) : v.type === 'application/pdf' ? ('pdf' as const) : null;
    if (!kind) return { skipped: 'no preview for this type' };
    const set = (row: Partial<PreviewRow>) => this.db('file_previews').where({ version_id: v.id }).update({ ...row, updated_at: Date.now() });
    if (v.size > this.o.previewMaxBytes) {
      await set({ state: 'unavailable', error: 'The file is larger than FILES_PREVIEW_MAX_BYTES.' });
      return { state: 'unavailable' };
    }
    const dir = await mkdtemp(path.join(this.o.workDir ?? tmpdir(), 'exprsn-preview-'));
    try {
      const input = path.join(dir, 'input');
      const output = path.join(dir, 'preview.png');
      await pipeline(Readable.from(await this.plain(v)), createWriteStream(input, { mode: 0o600 }));
      try {
        await this.o.renderer.render(kind, v.type, input, output, this.o.previewPx, ctx.signal);
      } catch (err) {
        if (err instanceof PreviewUnavailable) {
          await set({ state: 'unavailable', error: err.message.slice(0, 500) });
          return { state: 'unavailable', reason: err.message };
        }
        await set({ state: 'failed', error: (err as Error).message.slice(0, 500) });
        throw err;
      }
      let data: Buffer = await readFile(output);
      if (!data.subarray(0, 8).equals(PNG) || data.length > 10 * 1024 * 1024) {
        await set({ state: 'failed', error: 'The renderer did not produce a PNG.' });
        return { state: 'failed' };
      }
      // 1.8.0 (B-142): a renderer may copy the original's metadata into the preview (eXIf, text chunks): it is
      // taken out before the preview is stored.
      try {
        data = await stripBuffer('image/png', data);
      } catch {
        await set({ state: 'failed', error: 'The renderer wrote a PNG that could not be read.' });
        return { state: 'failed' };
      }
      // Sealed like the original: a key of its own, sealed with the tenant key.
      const key = newFileKey();
      const blobKey = `files/${v.tenant_id}/previews/${v.id}`;
      await s.blobs.putStream(blobKey, encryptStream([data], key, previewAad(v.id)), 'application/octet-stream');
      await set({ state: 'ready', type: 'image/png', size: data.length, blob_key: blobKey, sealed_key: await s.keys.sealBytes(v.tenant_id, packKey(key), `file-preview-key:${v.id}`), error: null });
      return { state: 'ready', bytes: data.length };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * The current version's preview for a reader of the file, or version `number`'s for members of its workspace (as
   * for the version's content). 1.8.0 (B-142): served without metadata, also for previews stored before that.
   */
  async preview(p: Principal, id: string, number?: number): Promise<{ file: FileRow; data: Buffer; type: string; version: number }> {
    const file = number == null ? (await this.readable(p, id)).file : await this.writable(p, id);
    const n = number ?? file.current_version;
    if (n == null) throw notFound('Preview');
    const v = await this.versionByNumber(file, n);
    if (number != null && !clears(p.clearance, v.label)) throw forbidden(`Version ${n} is ${v.label}; your clearance is ${p.clearance}.`, { step: 'clearance' });
    const r = await this.db('file_previews').where({ version_id: v.id }).first();
    if (!r) throw notFound('Preview');
    const pv = previewFrom(r);
    if (pv.state !== 'ready' || !pv.blob_key || !pv.sealed_key) throw new HttpProblem(pv.state === 'queued' ? 409 : 404, pv.state === 'queued' ? 'Conflict' : 'Not found', pv.state === 'queued' ? 'The preview is still being drawn.' : `No preview: ${pv.error ?? pv.state}.`);
    const key = await this.keyOf(pv.tenant_id, pv.sealed_key, `file-preview-key:${v.id}`);
    const got = await this.s().blobs.getStream(pv.blob_key);
    if (!got) throw notFound('Preview');
    const type = pv.type ?? 'image/png';
    const data = await collect(decryptStream(got.stream as AsyncIterable<Buffer>, key, previewAad(v.id)));
    let clean: Buffer;
    try {
      clean = await stripBuffer(type, data);
    } catch {
      throw notFound('Preview');
    }
    return { file, data: clean, type, version: v.number };
  }

  /**
   * 1.9.0 (B-177): the current version's preview, cleaned, for a caller that decided who may see the file itself (an
   * album, through its access rule). Null when there is none ready or the file is in the trash or taken down.
   */
  async previewCurrent(tenantId: string, fileId: string): Promise<{ data: Buffer; type: string; version: number } | null> {
    const file = await this.fileRow(tenantId, fileId);
    if (!file || file.trashed_at != null || file.taken_down_at != null || file.current_version == null) return null;
    const r = (await this.db('file_previews as p').join('file_versions as v', 'v.id', 'p.version_id').where({ 'v.file_id': file.id, 'v.number': file.current_version, 'v.state': 'ready' }).first('p.*')) as Record<string, unknown> | undefined;
    if (!r) return null;
    const pv = previewFrom(r);
    if (pv.state !== 'ready' || !pv.blob_key || !pv.sealed_key) return null;
    const key = await this.keyOf(pv.tenant_id, pv.sealed_key, `file-preview-key:${pv.version_id}`);
    const got = await this.s().blobs.getStream(pv.blob_key);
    if (!got) return null;
    const type = pv.type ?? 'image/png';
    try {
      return { data: await stripBuffer(type, await collect(decryptStream(got.stream as AsyncIterable<Buffer>, key, previewAad(pv.version_id)))), type, version: file.current_version };
    } catch {
      return null;
    }
  }

  /**
   * 1.9.0 (B-177): the current version as a reader is served it (through `served`: an image without its metadata), for
   * a caller that decided who may read the file itself (an album's grid, slideshow, zip and share links). Null when the
   * file has no ready current version, or is in the trash or taken down.
   */
  async servedCurrent(tenantId: string, fileId: string): Promise<{ file: FileRow; version: VersionRow; stream: AsyncIterable<Buffer>; size: number | null; stripped: boolean } | null> {
    const file = await this.fileRow(tenantId, fileId);
    if (!file || file.trashed_at != null || file.taken_down_at != null || file.current_version == null) return null;
    const r = await this.db('file_versions').where({ file_id: file.id, number: file.current_version }).first();
    if (!r) return null;
    const version = versionFrom(r);
    if (version.state !== 'ready') return null;
    return { file, version, ...(await this.served(null, file, version, await this.plain(version))) };
  }

  async previewState(fileId: string, versionNumber: number | null): Promise<PreviewRow['state'] | null> {
    if (versionNumber == null) return null;
    const r = (await this.db('file_previews as p').join('file_versions as v', 'v.id', 'p.version_id').where({ 'v.file_id': fileId, 'v.number': versionNumber }).first('p.state')) as { state: PreviewRow['state'] } | undefined;
    return r?.state ?? null;
  }

  // ---------- served copies, alt text, version compare (1.8.0, B-142) ----------

  /**
   * What a reader is served of a version: an image without its EXIF, GPS, XMP and other metadata (files/exif.ts),
   * unless the owner of the file asked for the original. `size` is null when the copy streams as it is cleaned (JPEG,
   * PNG): its length is known only at the end. The stored original is never changed.
   */
  async served(p: Principal | null, file: FileRow, version: VersionRow, stream: AsyncIterable<Buffer>, o: { original?: boolean } = {}): Promise<{ stream: AsyncIterable<Buffer>; size: number | null; stripped: boolean }> {
    if (!strippable(version.type)) return { stream, size: version.size, stripped: false };
    if (o.original) {
      if (!p || p.userId !== file.owner_id) throw forbidden('Only the owner of the file can download the original, with its metadata.', { step: 'owner' });
      return { stream, size: version.size, stripped: false };
    }
    if (version.type === 'image/jpeg' || version.type === 'image/png') return { stream: stripStream(version.type, stream), size: null, stripped: true };
    if (version.size > STRIP_BUFFER_MAX) throw new HttpProblem(413, 'Too large to clean', `Images of this type are served without their metadata, which is done in memory up to ${STRIP_BUFFER_MAX} bytes; this one is larger. Its owner can download the original.`);
    try {
      const data = await stripBuffer(version.type, await collect(stream));
      return { stream: (async function* () { yield data; })(), size: data.length, stripped: true };
    } catch (err) {
      if (err instanceof StripError) throw new HttpProblem(422, 'Image not readable', `The image could not be served without its metadata: ${err.message}`);
      throw err;
    }
  }

  /** Refuses a request for the original unless the caller owns the file (checked before any content is read). */
  async assertOriginal(p: Principal, id: string): Promise<void> {
    const f = await this.fileRow(p.tenantId, id);
    if (f && f.owner_id !== p.userId) throw forbidden('Only the owner of the file can download the original, with its metadata.', { step: 'owner' });
  }

  async metaFor(ids: string[]): Promise<Map<string, FileMetaRow>> {
    const out = new Map<string, FileMetaRow>();
    for (let i = 0; i < ids.length; i += 500) for (const r of (await this.db('file_meta').whereIn('file_id', ids.slice(i, i + 500))) as FileMetaRow[]) out.set(r.file_id, r);
    return out;
  }

  /** A text a person wrote about an image, screened at `user-input` like a profile's bio; returns what to store. */
  private async screenMeta(p: Principal, file: FileRow, field: 'altText' | 'description', text: string): Promise<string> {
    const d = await this.s().guardrails.check({ tenantId: p.tenantId, workspaceId: file.workspace_id, checkpoint: 'user-input', text, label: file.label, principal: p, source: { kind: 'file-meta', id: file.id }, meta: { objectType: FILE_OBJECT_TYPE, field } });
    if (d.action === 'block' || d.action === 'require-approval') throw new HttpProblem(422, 'Blocked by guardrails', d.reason ?? `The ${field === 'altText' ? 'alt text' : 'description'} was blocked by a guardrail rule.`, { extensions: { step: 'guardrails', action: d.action, field } });
    return d.action === 'redact' ? d.text : text;
  }

  /**
   * Sets an image's alt text and description (either may be null to clear it), for people who may change the file.
   * Per file, not per version: `alt_version` keeps the version they were written for.
   */
  async setMeta(p: Principal, id: string, patch: { altText?: string | null; description?: string | null }): Promise<{ file: FileRow; before: FileMeta; after: FileMeta }> {
    const file = await this.writable(p, id);
    if (!file.type || !IMAGE_TYPES.includes(file.type)) throw conflict(`Alt text and a description are for images; ${file.name} is ${file.type ?? 'not scanned yet'}.`);
    const row = (await this.metaFor([file.id])).get(file.id);
    const before = metaView(row);
    const clean = async (field: 'altText' | 'description', v: string | null | undefined, cur: string | null): Promise<string | null> => (v === undefined ? cur : v === null || !v.trim() ? null : this.screenMeta(p, file, field, v.trim()));
    const alt = await clean('altText', patch.altText, row?.alt_text ?? null);
    const description = await clean('description', patch.description, row?.description ?? null);
    const t = Date.now();
    const values = { alt_text: alt, description, alt_version: file.current_version, updated_by: p.userId, updated_at: t };
    if (row) await this.db('file_meta').where({ file_id: file.id }).update(values);
    else await this.db('file_meta').insert({ file_id: file.id, tenant_id: file.tenant_id, ...values });
    return { file, before, after: metaView({ file_id: file.id, tenant_id: file.tenant_id, ...values }) };
  }

  /**
   * A suggested alt text for an image, from a vision model through the gateway (`apps/ai.ts` `generate`: the profile
   * resolved and its model approved, the caller's `inference:invoke` within the profile's ceiling, the image's label
   * under the profile's, the quota admitted and the use metered, the answer through `model-output`). For people who may
   * change the file; nothing is saved: the person accepts or edits it and saves it like any alt text. The model sees
   * the picture without its metadata.
   */
  async suggestAlt(p: Principal, id: string, profile: string): Promise<{ file: FileRow; suggestion: string; profile: string; model: string | null; version: number }> {
    const file = await this.writable(p, id);
    if (!file.type || !IMAGE_TYPES.includes(file.type) || file.current_version == null) throw conflict('Alt text can be suggested for an image that passed its scan.');
    const v = await this.versionByNumber(file, file.current_version);
    if (!clears(p.clearance, v.label)) throw forbidden(`Version ${v.number} is ${v.label}; your clearance is ${p.clearance}.`, { step: 'clearance' });
    const max = 10 * 1024 * 1024;
    const data = await this.bytesOf(v, max);
    if (!data) throw new HttpProblem(413, 'Too large', `Alt text is suggested for images up to ${max.toLocaleString('en-US')} bytes.`);
    const usage = { prompt: 0, output: 0, gpuMs: 0, model: null as string | null };
    let text: string;
    try {
      text = await generate(this.s(), { tenantId: p.tenantId, workspaceId: file.workspace_id, profile, system: ALT_PROMPT, prompt: 'Write the alt text for this image.', images: [(await stripBuffer(v.type, data)).toString('base64')], label: v.label, principal: p, userId: p.userId, json: true, source: { kind: 'file-alt', id: file.id }, usage });
    } catch (err) {
      if (err instanceof ModelUnavailable) throw conflict(err.message);
      throw err;
    }
    let suggestion: string;
    try {
      const o = parseJsonObject(text);
      suggestion = String(o.alt ?? o.caption ?? '');
    } catch {
      suggestion = text;
    }
    suggestion = suggestion.replace(/\s+/g, ' ').trim().slice(0, META_LIMITS.altText);
    if (!suggestion) throw new HttpProblem(422, 'No suggestion', 'The model gave no alt text for this image.');
    return { file, suggestion, profile, model: usage.model, version: v.number };
  }

  /** A version's bytes up to `max` (null past it). */
  private async bytesOf(v: VersionRow, max: number): Promise<Buffer | null> {
    const parts: Buffer[] = [];
    let n = 0;
    for await (const c of await this.plain(v)) {
      n += c.length;
      if (n > max) return null;
      parts.push(c);
    }
    return Buffer.concat(parts, n);
  }

  /** The text a version is compared by: text files as they are (JSON on one line spread out), PDF and Word extracted. */
  private compareText(data: Buffer, type: string): string {
    if (type === 'application/pdf' || type === DOCX_TYPE) return extractText(data, type);
    const t = data.toString('utf8').replace(/^\uFEFF/, '');
    if (type === 'application/json' && !t.trim().includes('\n')) {
      try {
        return JSON.stringify(JSON.parse(t), null, 2);
      } catch {
        return t;
      }
    }
    return t;
  }

  /**
   * Compares two versions of a file for a member of its workspace cleared for both (as for downloading a version).
   * Text-like files and PDF and Word documents (extracted as `files.read` does) give a line diff through `textDiff`;
   * images give both versions' previews to show side by side. Past COMPARE_LIMITS the answer is 413, "too large to
   * compare"; other types are 415.
   */
  async compare(p: Principal, id: string, from: number, to: number) {
    const file = await this.writable(p, id);
    const [a, b] = [await this.versionByNumber(file, from), await this.versionByNumber(file, to)];
    for (const v of [a, b]) {
      if (v.state !== 'ready') throw conflict(`Version ${v.number} is ${v.state}; only versions that passed their scan can be compared.`);
      if (!clears(p.clearance, v.label)) throw forbidden(`Version ${v.number} is ${v.label}; your clearance is ${p.clearance}.`, { step: 'clearance' });
    }
    const side = async (v: VersionRow) => ({ ...versionView(v), preview: await this.previewState(file.id, v.number) });
    const head = { file: { id: file.id, name: file.name }, from: await side(a), to: await side(b) };
    const image = (t: string | null) => !!t && IMAGE_TYPES.includes(t);
    if (image(a.type) && image(b.type)) return { kind: 'image' as const, ...head, same: a.sha256 === b.sha256 };
    const textual = (t: string | null) => !!t && (TEXT_TYPES.includes(t) || t === 'application/pdf' || t === DOCX_TYPE);
    if (!textual(a.type) || !textual(b.type)) throw new HttpProblem(415, 'Cannot compare', image(a.type) !== image(b.type) ? 'One version is an image and the other is not; download both to compare them.' : `Versions of ${a.type === b.type ? a.type : `${a.type} and ${b.type}`} cannot be compared as text here. Text, Markdown, CSV, JSON, HTML, PDF and Word files can, and images side by side.`);
    const L = COMPARE_LIMITS;
    const tooLarge = (why: string) => new HttpProblem(413, 'Too large to compare', `${why} Download both versions to compare them.`, { extensions: { limits: L } });
    if (a.size > L.maxBytes || b.size > L.maxBytes) throw tooLarge(`Versions up to ${L.maxBytes.toLocaleString('en-US')} bytes are compared here; version ${(a.size > L.maxBytes ? a : b).number} has ${(a.size > L.maxBytes ? a : b).size.toLocaleString('en-US')}.`);
    const texts: string[] = [];
    for (const v of [a, b]) {
      const data = await this.bytesOf(v, L.maxBytes);
      if (!data) throw tooLarge(`Version ${v.number} is larger than ${L.maxBytes.toLocaleString('en-US')} bytes.`);
      let t: string;
      try {
        t = this.compareText(data, v.type!);
      } catch (err) {
        if (err instanceof ExtractionError) throw new HttpProblem(422, 'Cannot compare', `The text of version ${v.number} could not be read: ${err.message}`);
        throw err;
      }
      if (t.length > L.maxChars) throw tooLarge(`Version ${v.number} has ${t.length.toLocaleString('en-US')} characters of text; up to ${L.maxChars.toLocaleString('en-US')} are compared.`);
      if (t.split('\n').length > L.maxLines) throw tooLarge(`Version ${v.number} has more than ${L.maxLines.toLocaleString('en-US')} lines.`);
      texts.push(t);
    }
    const d = textDiff(texts[0]!, texts[1]!, { context: 3, maxChars: L.maxDiffChars });
    return { kind: 'text' as const, ...head, extracted: a.type === 'application/pdf' || a.type === DOCX_TYPE || b.type === 'application/pdf' || b.type === DOCX_TYPE, added: d.added, removed: d.removed, truncated: d.truncated, same: !d.added && !d.removed, hunks: diffHunks(d.text) };
  }

  // ---------- details, tags, rename and move ----------

  private async tagsFor(ids: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (!ids.length) return out;
    for (let i = 0; i < ids.length; i += 500) {
      for (const r of (await this.db('file_tags').whereIn('file_id', ids.slice(i, i + 500)).orderBy('tag')) as { file_id: string; tag: string }[]) out.set(r.file_id, [...(out.get(r.file_id) ?? []), r.tag]);
    }
    return out;
  }

  async details(p: Principal, id: string) {
    const { file, via } = await this.readable(p, id);
    const owner = await this.s().users.get(p.tenantId, file.owner_id);
    const cur = file.current_version == null ? undefined : ((await this.db('file_versions').where({ file_id: file.id, number: file.current_version }).first('sha256')) as { sha256: string } | undefined);
    return { ...fileView(file, { tags: (await this.tagsFor([file.id])).get(file.id) ?? [], ownerName: owner?.display_name ?? null }), sha256: cur?.sha256 ?? null, cid: cidOf(cur?.sha256), access: via === 'workspace' ? 'workspace' : 'shared', preview: await this.previewState(file.id, file.current_version), ...metaView((await this.metaFor([file.id])).get(file.id)), owner: file.owner_id === p.userId };
  }

  async setTags(p: Principal, id: string, tags: string[]): Promise<{ file: FileRow; before: string[]; after: string[] }> {
    const file = await this.writable(p, id);
    const before = (await this.tagsFor([file.id])).get(file.id) ?? [];
    const after = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].sort();
    await this.db.transaction(async (trx) => {
      await trx('file_tags').where({ file_id: file.id }).delete();
      if (after.length) await trx('file_tags').insert(after.map((tag) => ({ file_id: file.id, tenant_id: file.tenant_id, tag })));
    });
    return { file, before, after };
  }

  async updateFile(p: Principal, id: string, patch: { name?: string; folderId?: string | null }): Promise<{ before: FileRow; after: FileRow }> {
    const f = await this.writable(p, id);
    let folderId = f.folder_id;
    if (patch.folderId !== undefined && patch.folderId !== f.folder_id) {
      if (patch.folderId) {
        const target = await this.folder(p, patch.folderId);
        if (target.workspace_id !== f.workspace_id) throw conflict('Files move within their workspace; share the file with another workspace instead.');
      }
      folderId = patch.folderId;
    }
    const name = patch.name ?? f.name;
    if ((name !== f.name || folderId !== f.folder_id) && (await this.nameTaken(p.tenantId, f.workspace_id, folderId, name, f.id))) throw conflict(`Something named ${name} is already there.`);
    const t = Date.now();
    await this.db('files').where({ id: f.id }).update({ name, name_lower: name.toLowerCase(), folder_id: folderId, updated_at: t });
    return { before: f, after: { ...f, name, name_lower: name.toLowerCase(), folder_id: folderId, updated_at: t } };
  }

  // ---------- duplicate and content identifiers (2.0.0) ----------

  /** The highest version number a file has, ready or not (an editor's save is refused when it is past its base). */
  async lastVersionNumber(fileId: string): Promise<number> {
    const r = ((await this.db('file_versions').where({ file_id: fileId }).max({ n: 'number' })) as Record<string, unknown>[])[0];
    return Number(r?.n ?? 0) || 0;
  }

  /** A free name in a folder: `name`, else `name (2)`, `name (3)`… before the extension. */
  async freeName(tenantId: string, workspaceId: string, folderId: string | null, name: string): Promise<string> {
    if (!(await this.nameTaken(tenantId, workspaceId, folderId, name))) return name;
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let i = 2; i < 10_000; i++) {
      const candidate = `${stem} (${i})${ext}`.slice(0, 255);
      if (!(await this.nameTaken(tenantId, workspaceId, folderId, candidate))) return candidate;
    }
    throw conflict(`Too many files named like ${name} here.`);
  }

  /**
   * A copy of a file: its current version written again as version 1 of a new file the caller owns, in the same or
   * another folder of the same workspace. The copy goes through quarantine and the scan like any upload (and shares
   * the stored object through B-4601). Tags, alt text and column definitions come along; shares, versions and
   * knowledge links do not.
   */
  async duplicate(p: Principal, id: string, input: { name?: string; folderId?: string | null } = {}): Promise<{ file: FileRow; version: VersionRow; from: FileRow }> {
    const src = await this.writable(p, id);
    if (src.current_version == null) throw conflict(`The file is ${src.state}: only a file with a version that passed its scan can be copied.`);
    const v = await this.versionByNumber(src, src.current_version);
    if (v.state !== 'ready' || !v.blob_key) throw conflict(`Version ${v.number} is ${v.state}.`);
    if (!clears(p.clearance, v.label)) throw forbidden(`Version ${v.number} is ${v.label}; your clearance is ${p.clearance}.`, { step: 'clearance' });
    let folderId = src.folder_id;
    if (input.folderId !== undefined) {
      if (input.folderId) {
        const target = await this.folder(p, input.folderId);
        if (target.workspace_id !== src.workspace_id) throw conflict('Copies stay in the workspace of the file; share it with another workspace instead.');
      }
      folderId = input.folderId;
    }
    const w = await this.workspaceFor(p, src.workspace_id);
    this.checkLabel(p, w, v.label);
    const wanted = input.name ?? (() => {
      const dot = src.name.lastIndexOf('.');
      return dot > 0 ? `${src.name.slice(0, dot)} copy${src.name.slice(dot)}` : `${src.name} copy`;
    })();
    const name = input.name ? wanted : await this.freeName(p.tenantId, w.id, folderId, wanted);
    const { file, version } = await this.upload(p, { workspaceId: w.id, folderId, name, label: v.label, declaredType: v.type, declaredBytes: v.size }, await this.plain(v));
    const tags = (await this.tagsFor([src.id])).get(src.id) ?? [];
    if (tags.length) await this.db('file_tags').insert(tags.map((tag) => ({ file_id: file.id, tenant_id: file.tenant_id, tag })));
    const meta = (await this.metaFor([src.id])).get(src.id);
    if (meta) await this.db('file_meta').insert({ ...meta, file_id: file.id, alt_version: meta.alt_version == null ? null : 1, updated_by: p.userId, updated_at: Date.now() });
    const cols = (await this.db('file_doc_columns').where({ file_id: src.id }).first()) as Record<string, unknown> | undefined;
    if (cols) await this.db('file_doc_columns').insert({ ...cols, file_id: file.id, updated_by: p.userId, updated_at: Date.now() });
    return { file, version, from: src };
  }

  /**
   * A copy of a folder with its subfolders and the ready files in them the caller is cleared for (at most
   * `maxFiles`), into `parentId` (default: beside the original) under a free name. Files that are not ready, or above
   * the caller's clearance, are left out and counted.
   */
  async duplicateFolder(p: Principal, id: string, input: { name?: string; parentId?: string | null; maxFiles?: number } = {}): Promise<{ folder: FolderRow; files: number; folders: number; skipped: number }> {
    const src = await this.folder(p, id);
    const parentId = input.parentId === undefined ? src.parent_id : input.parentId;
    if (parentId) {
      const target = await this.folder(p, parentId);
      if (target.workspace_id !== src.workspace_id) throw conflict('Copies stay in the workspace of the folder.');
      if ((await this.descendants(p.tenantId, src.id)).includes(target.id)) throw conflict('A folder cannot be copied into itself or a folder inside it.');
    }
    const ids = await this.descendants(p.tenantId, src.id);
    const max = input.maxFiles ?? 500;
    const count = ((await this.db('files').where({ tenant_id: p.tenantId }).whereIn('folder_id', ids.slice(0, 1000)).whereNull('trashed_at').count({ n: '*' })) as Record<string, unknown>[])[0];
    if (ids.length > 1000 || Number(count?.n ?? 0) > max) throw new HttpProblem(413, 'Too large to copy', `A folder copy takes up to ${max} files and 1000 folders; this one has more. Copy its subfolders one by one.`);
    const name = input.name ?? (await this.freeName(p.tenantId, src.workspace_id, parentId, `${src.name} copy`));
    const root = await this.createFolder(p, { workspaceId: src.workspace_id, parentId, name });
    const map = new Map<string, string>([[src.id, root.id]]);
    let folders = 1;
    let files = 0;
    let skipped = 0;
    // Breadth first, so every folder's parent copy exists before it.
    for (let frontier = [src.id]; frontier.length; ) {
      const next: string[] = [];
      for (const fid of frontier) {
        const kids = ((await this.db('file_folders').where({ tenant_id: p.tenantId, parent_id: fid }).whereNull('trashed_at').orderBy('name')) as Record<string, unknown>[]).map(folderFrom);
        for (const k of kids) {
          const made = await this.createFolder(p, { workspaceId: src.workspace_id, parentId: map.get(fid)!, name: k.name });
          map.set(k.id, made.id);
          folders++;
          next.push(k.id);
        }
        const list = ((await this.db('files').where({ tenant_id: p.tenantId, folder_id: fid }).whereNull('trashed_at').orderBy('name_lower')) as Record<string, unknown>[]).map(fileFrom);
        for (const f of list) {
          if (f.state !== 'ready' || f.current_version == null || !clears(p.clearance, f.label)) {
            skipped++;
            continue;
          }
          await this.duplicate(p, f.id, { name: f.name, folderId: map.get(fid)! });
          files++;
        }
      }
      frontier = next;
    }
    return { folder: root, files, folders, skipped };
  }

  /** Files in the caller's workspaces whose current version has this content identifier (or sha256), within clearance. */
  async byCid(p: Principal, cidOrSha: string) {
    const sha = /^[0-9a-f]{64}$/i.test(cidOrSha) ? cidOrSha.toLowerCase() : sha256OfCid(cidOrSha);
    if (!sha) throw new HttpProblem(400, 'Invalid request', 'Give a CIDv1 of raw content (bafkrei…) or a sha256 in hex.');
    const ws = await this.memberWorkspaces(p);
    if (!ws.size) return { cid: cidOf(sha), sha256: sha, files: [] };
    const rows = (await this.db('files as f')
      .join('file_versions as v', (j) => j.on('v.file_id', '=', 'f.id').andOn('v.number', '=', 'f.current_version'))
      .where({ 'f.tenant_id': p.tenantId, 'v.sha256': sha, 'v.state': 'ready' })
      .whereIn('f.workspace_id', [...ws.keys()])
      .whereNull('f.trashed_at')
      .whereIn('f.label', LABELS.filter((l) => clears(p.clearance, l)))
      .limit(100)
      .select('f.*')) as Record<string, unknown>[];
    return { cid: cidOf(sha), sha256: sha, files: rows.map(fileFrom).map((f) => ({ ...fileView(f), workspaceName: ws.get(f.workspace_id)?.name ?? null })) };
  }

  // ---------- trash ----------

  async trashFile(p: Principal, id: string): Promise<FileRow> {
    const f = await this.writable(p, id);
    const t = Date.now();
    const purge = t + this.o.trashDays * 86_400_000;
    await this.db('files').where({ id: f.id }).update({ trashed_at: t, trashed_by: p.userId, trashed_with: f.id, purge_after: purge });
    const after = { ...f, trashed_at: t, trashed_by: p.userId, trashed_with: f.id, purge_after: purge };
    this.event('file.deleted', after, f.current_version ?? (await this.lastNumber(f.id)), p.userId);
    return after;
  }

  /** Puts a folder in the trash with everything in it that is not there already. */
  async trashFolder(p: Principal, id: string): Promise<{ folder: FolderRow; files: number; folders: number }> {
    const f = await this.folder(p, id);
    const ids = await this.descendants(p.tenantId, f.id);
    const t = Date.now();
    const mark = { trashed_at: t, trashed_by: p.userId, trashed_with: f.id, purge_after: t + this.o.trashDays * 86_400_000 };
    const files = ((await this.db('files').where({ tenant_id: p.tenantId }).whereIn('folder_id', ids).whereNull('trashed_at')) as Record<string, unknown>[]).map(fileFrom);
    await this.db.transaction(async (trx) => {
      for (let i = 0; i < ids.length; i += 500) {
        await trx('file_folders').where({ tenant_id: p.tenantId }).whereIn('id', ids.slice(i, i + 500)).whereNull('trashed_at').update(mark);
        await trx('files').where({ tenant_id: p.tenantId }).whereIn('folder_id', ids.slice(i, i + 500)).whereNull('trashed_at').update(mark);
      }
    });
    for (const x of files) this.event('file.deleted', { ...x, ...mark }, x.current_version ?? (await this.lastNumber(x.id)), p.userId);
    return { folder: { ...f, ...mark }, files: files.length, folders: ids.length };
  }

  /** What the caller put in the trash in a workspace: the folders and files trashed on their own (not their contents). */
  async trash(p: Principal, workspaceId?: string | null) {
    const w = await this.workspaceFor(p, workspaceId);
    const folders = ((await this.db('file_folders').where({ tenant_id: p.tenantId, workspace_id: w.id }).whereNotNull('trashed_at').whereRaw('trashed_with = id').orderBy('trashed_at', 'desc')) as Record<string, unknown>[]).map(folderFrom);
    const files = ((await this.db('files').where({ tenant_id: p.tenantId, workspace_id: w.id }).whereNotNull('trashed_at').whereNull('taken_down_at').whereRaw('trashed_with = id').whereIn('label', LABELS.filter((l) => clears(p.clearance, l))).orderBy('trashed_at', 'desc')) as Record<string, unknown>[]).map(fileFrom);
    return { workspace: { id: w.id, name: w.name }, folders: folders.map(folderView), files: files.map((f) => fileView(f)) };
  }

  /** Restores a folder or file from the trash, with what went in with it; to the root if its folder is gone. */
  async restoreFromTrash(p: Principal, kind: 'file' | 'folder', id: string): Promise<{ kind: 'file' | 'folder'; id: string; name: string; files: number; label: Label | undefined }> {
    const row = kind === 'file' ? await this.writable(p, id, { trashed: true }) : await this.folder(p, id, { trashed: true });
    if (kind === 'file' && (row as FileRow).taken_down_at != null) {
      // B-9501: only the moderation decision lifts a takedown. The attempt is recorded.
      await this.s().audit.append({ tenantId: p.tenantId, action: 'file.restore.refused', kind: 'admin', actor: { user: p.userId, username: p.username }, target: { file: row.id, workspace: row.workspace_id }, label: (row as FileRow).label, detail: { reason: 'taken down by a moderation decision' } });
      throw new HttpProblem(409, 'Conflict', 'This file was taken down by a moderation decision. Only that decision, or an appeal of it, brings it back.', { extensions: { step: 'takedown' } });
    }
    if (row.trashed_at == null) throw conflict('It is not in the trash.');
    if (row.trashed_with !== row.id) throw conflict('It went to the trash with a folder; restore that folder.');
    const parentId = kind === 'file' ? (row as FileRow).folder_id : (row as FolderRow).parent_id;
    const parent = parentId ? await this.folderRow(p.tenantId, parentId) : null;
    const target = parent && parent.trashed_at == null ? parent.id : null;
    let name = row.name;
    for (let i = 2; await this.nameTaken(p.tenantId, row.workspace_id, target, name, row.id); i++) name = `${row.name} (${i})`;
    const clear = { trashed_at: null, trashed_by: null, trashed_with: null, purge_after: null };
    const restored = ((await this.db('files').where({ tenant_id: p.tenantId, trashed_with: row.id }).whereNull('taken_down_at')) as Record<string, unknown>[]).length;
    await this.db.transaction(async (trx) => {
      await trx('file_folders').where({ tenant_id: p.tenantId, trashed_with: row.id }).update(clear);
      await trx('files').where({ tenant_id: p.tenantId, trashed_with: row.id }).whereNull('taken_down_at').update(clear);
      if (kind === 'file') await trx('files').where({ id: row.id }).update({ folder_id: target, name, name_lower: name.toLowerCase() });
      else await trx('file_folders').where({ id: row.id }).update({ parent_id: target, name });
    });
    return { kind, id: row.id, name, files: restored, label: kind === 'file' ? (row as FileRow).label : undefined };
  }

  /**
   * The purge job: deletes trashed files whose purge date has passed (or, with `all`, everything in a workspace's
   * trash), their versions, previews, tags, shares and blobs, then the trashed folders left empty.
   */
  async purge(tenantId: string, o: { workspaceId?: string | null; all?: boolean; by?: string | null } = {}): Promise<{ files: number; folders: number; bytes: number; kept: number }> {
    const s = this.s();
    const now = Date.now();
    const fq = this.db('files').where({ tenant_id: tenantId }).whereNotNull('trashed_at');
    if (o.workspaceId) fq.andWhere({ workspace_id: o.workspaceId });
    // 1.6.0 (B-7602): a legal hold on the owner or the workspace keeps their trashed files.
    const held = await s.legalHolds.held(tenantId);
    if (held.users.length) fq.andWhere((w) => w.whereNull('owner_id').orWhereNotIn('owner_id', held.users));
    if (held.workspaces.length) fq.whereNotIn('workspace_id', held.workspaces);
    if (!o.all) fq.andWhere('purge_after', '<=', now);
    const candidates = ((await fq.limit(5000)) as Record<string, unknown>[]).map(fileFrom);
    // 1.7.0 (B-9501, B-9502, B-9504): a taken-down file is never emptied from the trash by a member, and the
    // scheduled purge takes it, like any file, only when no open case and no legal hold keeps it.
    const kept = await s.evidence.keptOf(tenantId, FILE_OBJECT_TYPE);
    const files: FileRow[] = [];
    for (const f of candidates) {
      const k = kept.get(f.id);
      if (o.all && f.taken_down_at != null) {
        await s.audit.append({ tenantId, action: 'file.purge.refused', kind: o.by ? 'admin' : 'system', actor: { service: 'files', ...(o.by ? { user: o.by } : {}) }, target: { file: f.id, workspace: f.workspace_id }, label: f.label, detail: { reason: 'taken down by a moderation decision', emptied: true } });
        continue;
      }
      if (k) {
        await s.evidence.recordSkip(tenantId, FILE_OBJECT_TYPE, f.id, o.all ? 'files.trash-empty' : 'files.purge', k);
        continue;
      }
      files.push(f);
    }
    let bytes = 0;
    for (const f of files) {
      const versions = ((await this.db('file_versions').where({ file_id: f.id })) as Record<string, unknown>[]).map(versionFrom);
      const previews = ((await this.db('file_previews').where({ file_id: f.id })) as Record<string, unknown>[]).map(previewFrom);
      for (const v of versions) {
        // 1.6.0 (B-4601): a shared object goes only with the last version that reads it (below).
        if (v.blob_key && !v.blob_id) await s.blobs.delete(v.blob_key);
        if (v.state !== 'rejected') bytes += v.size;
      }
      for (const pv of previews) if (pv.blob_key) await s.blobs.delete(pv.blob_key);
      const freed: string[] = [];
      await this.db.transaction(async (trx) => {
        await trx('file_previews').where({ file_id: f.id }).delete();
        await trx('file_versions').where({ file_id: f.id }).delete();
        await trx('file_tags').where({ file_id: f.id }).delete();
        await trx('file_meta').where({ file_id: f.id }).delete();
        await trx('file_doc_columns').where({ file_id: f.id }).delete();
        await trx('file_knowledge_links').where({ file_id: f.id }).delete();
        await trx('file_shares').where({ file_id: f.id }).delete();
        await trx('files').where({ id: f.id }).delete();
        for (const v of versions) if (v.blob_id) freed.push(...(await this.dedup.release(trx, v.blob_id)));
      });
      for (const k of freed) await s.blobs.delete(k);
      await s.audit.append({ tenantId, action: 'file.purged', kind: 'system', actor: { service: 'files', ...(o.by ? { user: o.by } : {}) }, target: { file: f.id, workspace: f.workspace_id }, label: f.label, detail: { versions: versions.length, trashedAt: f.trashed_at, ...(o.all ? { emptied: true } : {}) } });
    }
    // Trashed folders go once nothing is left in them.
    const dq = this.db('file_folders').where({ tenant_id: tenantId }).whereNotNull('trashed_at');
    if (o.workspaceId) dq.andWhere({ workspace_id: o.workspaceId });
    if (!o.all) dq.andWhere('purge_after', '<=', now);
    const folders = ((await dq) as Record<string, unknown>[]).map(folderFrom);
    let removed = 0;
    for (let again = true; again; ) {
      again = false;
      for (const d of folders) {
        if (!d.id) continue;
        const busy = (await this.db('files').where({ folder_id: d.id }).first('id')) || (await this.db('file_folders').where({ parent_id: d.id }).first('id'));
        if (busy) continue;
        if (await this.db('file_folders').where({ id: d.id }).delete()) {
          removed++;
          again = true;
        }
        d.id = '';
      }
    }
    return { files: files.length, folders: removed, bytes, kept: candidates.length - files.length };
  }

  // ---------- retention and the version cap (B-9503) ----------

  async retention(tenantId: string, workspaceId: string): Promise<{ retentionDays: number | null; versionCap: number | null; updatedBy: string | null; updatedAt: number | null; lastRunAt: number | null }> {
    const r = (await this.db('file_retention').where({ tenant_id: tenantId, workspace_id: workspaceId }).first()) as Record<string, unknown> | undefined;
    return { retentionDays: num(r?.retention_days), versionCap: num(r?.version_cap), updatedBy: (r?.updated_by as string | null | undefined) ?? null, updatedAt: num(r?.updated_at), lastRunAt: num(r?.last_run_at) };
  }

  async setRetention(tenantId: string, workspaceId: string, input: { retentionDays: number | null; versionCap: number | null }, by: string): Promise<void> {
    const row = { retention_days: input.retentionDays, version_cap: input.versionCap, updated_by: by, updated_at: Date.now() };
    const n = await this.db('file_retention').where({ tenant_id: tenantId, workspace_id: workspaceId }).update(row);
    if (!n) await this.db('file_retention').insert({ tenant_id: tenantId, workspace_id: workspaceId, ...row, last_run_at: null });
  }

  /**
   * Applies every workspace's retention period and version cap. A file unchanged for longer than the period goes to
   * the trash (so it can be restored until the trash purge takes it); of each file the newest `versionCap` versions
   * stay, and always the current one and any still in quarantine. Files under a hold are left alone and recorded
   * once: a legal hold on the owner or the workspace (B-7602), on the file or its case (B-9504), or an open
   * moderation case (B-9502).
   */
  async applyRetention(tenantId: string): Promise<{ workspaces: number; trashed: number; versions: number; bytes: number; kept: number }> {
    const s = this.s();
    const rules = (await this.db('file_retention').where({ tenant_id: tenantId })) as Record<string, unknown>[];
    const out = { workspaces: 0, trashed: 0, versions: 0, bytes: 0, kept: 0 };
    if (!rules.length) return out;
    const held = await s.legalHolds.held(tenantId);
    const kept = await s.evidence.keptOf(tenantId, FILE_OBJECT_TYPE);
    const now = Date.now();
    for (const rule of rules) {
      const workspaceId = String(rule.workspace_id);
      const days = num(rule.retention_days);
      const cap = num(rule.version_cap);
      if (days == null && cap == null) continue;
      out.workspaces++;
      const wsHeld = held.workspaces.includes(workspaceId);
      const holdOf = (f: FileRow) => kept.get(f.id) ?? (wsHeld ? { reason: 'legal-hold' as const, ref: `workspace:${workspaceId}` } : held.users.includes(f.owner_id) ? { reason: 'legal-hold' as const, ref: `user:${f.owner_id}` } : null);
      if (days != null) {
        const stale = ((await this.db('files').where({ tenant_id: tenantId, workspace_id: workspaceId }).whereNull('trashed_at').andWhere('updated_at', '<', now - days * 86_400_000).limit(5000)) as Record<string, unknown>[]).map(fileFrom);
        for (const f of stale) {
          const k = holdOf(f);
          if (k) {
            out.kept++;
            await s.evidence.recordSkip(tenantId, FILE_OBJECT_TYPE, f.id, 'files.retention', k);
            continue;
          }
          const mark = { trashed_at: now, trashed_by: 'files.retention', trashed_with: f.id, purge_after: now + this.o.trashDays * 86_400_000 };
          if (!(await this.db('files').where({ id: f.id }).whereNull('trashed_at').update(mark))) continue;
          out.trashed++;
          await s.audit.append({ tenantId, action: 'file.retention.trashed', kind: 'system', actor: { service: 'files.retention' }, target: { file: f.id, workspace: workspaceId }, label: f.label, detail: { retentionDays: days, unchangedSince: f.updated_at, purgeAfter: mark.purge_after } });
          this.event('file.deleted', { ...f, ...mark }, f.current_version ?? (await this.lastNumber(f.id)), null);
        }
      }
      if (cap != null && cap >= 1) {
        const over = (await this.db('file_versions').where({ tenant_id: tenantId, workspace_id: workspaceId }).groupBy('file_id').havingRaw('count(*) > ?', [cap]).select('file_id').limit(5000)) as { file_id: string }[];
        for (const { file_id } of over) {
          const f = await this.fileRow(tenantId, file_id);
          if (!f) continue;
          const k = holdOf(f);
          if (k) {
            out.kept++;
            await s.evidence.recordSkip(tenantId, FILE_OBJECT_TYPE, f.id, 'files.version-cap', k);
            continue;
          }
          const versions = ((await this.db('file_versions').where({ file_id: f.id }).orderBy('number', 'desc')) as Record<string, unknown>[]).map(versionFrom);
          const drop = versions.slice(cap).filter((v) => v.number !== f.current_version && v.state !== 'quarantined' && v.state !== 'scanning');
          if (!drop.length) continue;
          let bytes = 0;
          for (const v of drop) {
            const pv = (await this.db('file_previews').where({ version_id: v.id }).first('blob_key')) as { blob_key: string | null } | undefined;
            if (pv?.blob_key) await s.blobs.delete(pv.blob_key).catch(() => undefined);
            if (v.blob_key && !v.blob_id) await s.blobs.delete(v.blob_key).catch(() => undefined);
            const freed: string[] = [];
            await this.db.transaction(async (trx) => {
              await trx('file_previews').where({ version_id: v.id }).delete();
              await trx('file_versions').where({ id: v.id }).delete();
              if (v.blob_id) freed.push(...(await this.dedup.release(trx, v.blob_id)));
            });
            for (const key of freed) await s.blobs.delete(key).catch(() => undefined);
            if (v.state !== 'rejected') bytes += v.size;
          }
          out.versions += drop.length;
          out.bytes += bytes;
          await s.audit.append({ tenantId, action: 'file.versions.pruned', kind: 'system', actor: { service: 'files.retention' }, target: { file: f.id, workspace: workspaceId }, label: f.label, detail: { versionCap: cap, removed: drop.map((v) => v.number), bytes } });
        }
      }
      await this.db('file_retention').where({ tenant_id: tenantId, workspace_id: workspaceId }).update({ last_run_at: now });
    }
    return out;
  }

  // ---------- sharing (B-2402) ----------

  private tokenHash(token: string): string {
    return mac(this.s().sysKeys.key('link'), `file-link:${token}`);
  }

  async createShare(p: Principal, id: string, input: { kind: 'user'; userId: string } | { kind: 'group'; group: string } | { kind: 'workspace'; workspaceId: string } | { kind: 'link'; expiresInHours: number; maxUses?: number | null; anonymous?: boolean }): Promise<{ share: FileShareRow; token?: string; file: FileRow }> {
    const s = this.s();
    const file = await this.writable(p, id);
    if (file.state !== 'ready') throw conflict(`The file is ${file.state}; only a file that passed its scan can be shared.`);
    const t = Date.now();
    const base: FileShareRow = { id: ulid(), tenant_id: p.tenantId, file_id: file.id, kind: input.kind, user_id: null, group_name: null, workspace_id: null, token_hash: null, anonymous: false, expires_at: null, max_uses: null, uses: 0, created_by: p.userId, created_at: t, revoked_at: null, revoked_by: null, last_used_at: null };
    const dup = (q: Record<string, unknown>) => this.db('file_shares').where({ tenant_id: p.tenantId, file_id: file.id, ...q }).whereNull('revoked_at').first('id');
    let token: string | undefined;
    if (input.kind === 'user') {
      const u = await s.users.get(p.tenantId, input.userId);
      if (!u || u.state !== 'active') throw notFound('User');
      if (!clears(u.clearance as Label, file.label)) throw forbidden(`${u.display_name}'s clearance is ${u.clearance}; this file is ${file.label}.`, { step: 'clearance' });
      if (await dup({ kind: 'user', user_id: u.id })) throw conflict(`The file is already shared with ${u.display_name}.`);
      base.user_id = u.id;
    } else if (input.kind === 'group') {
      const g = input.group.trim().toLowerCase();
      if (await dup({ kind: 'group', group_name: g })) throw conflict(`The file is already shared with the group ${g}.`);
      base.group_name = g;
    } else if (input.kind === 'workspace') {
      const ws = await s.tenants.workspace(p.tenantId, input.workspaceId);
      if (!ws || ws.state !== 'active') throw notFound('Workspace');
      if (ws.id === file.workspace_id) throw conflict('The file is already in that workspace.');
      if (labelRank(file.label) > labelRank(ws.label_ceiling)) throw forbidden(`${ws.name}'s ceiling is ${ws.label_ceiling}; this file is ${file.label}.`, { step: 'zone' });
      if (await dup({ kind: 'workspace', workspace_id: ws.id })) throw conflict(`The file is already shared with ${ws.name}.`);
      base.workspace_id = ws.id;
    } else {
      if (input.anonymous) {
        // B-706's rules: the tenant's opt-in, public files only, and never longer than the tenant allows.
        const set = await s.sharing.settings(p.tenantId);
        if (!set.anonymousLinks) throw forbidden('Anonymous links are turned off for this tenant. A tenant admin can turn them on.', { step: 'policy' });
        if (file.label !== 'public') throw forbidden(`Only public files can have an anonymous link; this one is ${file.label}.`, { step: 'label' });
        if (input.expiresInHours > set.anonymousMaxHours) throw new HttpProblem(400, 'Invalid request', `Anonymous links expire within ${set.anonymousMaxHours} hours in this tenant.`);
        base.anonymous = true;
      }
      token = `exf_${randomToken(32)}`;
      base.token_hash = this.tokenHash(token);
      base.expires_at = t + input.expiresInHours * 3_600_000;
      base.max_uses = input.maxUses ?? null;
    }
    await this.db('file_shares').insert(base);
    this.event('file.shared', file, file.current_version ?? 1, p.userId, { with: input.kind });
    return { share: base, file, ...(token ? { token } : {}) };
  }

  async shares(p: Principal, id: string): Promise<FileShareRow[]> {
    const file = await this.writable(p, id);
    return ((await this.db('file_shares').where({ tenant_id: p.tenantId, file_id: file.id }).orderBy('created_at', 'desc')) as Record<string, unknown>[]).map(shareFrom);
  }

  async revokeShare(p: Principal, id: string, shareId: string): Promise<{ share: FileShareRow; file: FileRow }> {
    const file = await this.writable(p, id);
    const r = await this.db('file_shares').where({ tenant_id: p.tenantId, file_id: file.id, id: shareId }).first();
    if (!r) throw notFound('Share');
    const x = shareFrom(r);
    if (x.revoked_at != null) return { share: x, file };
    const t = Date.now();
    await this.db('file_shares').where({ id: x.id }).update({ revoked_at: t, revoked_by: p.userId });
    return { share: { ...x, revoked_at: t, revoked_by: p.userId }, file };
  }

  /** Files shared with the caller (directly, through a workspace or a group), live shares only, within clearance. */
  async sharedWithMe(p: Principal) {
    const mine = [...(await this.memberWorkspaces(p)).keys()];
    const groups = [...(await readerEntries(this.db, p))].filter((e) => e.startsWith('g:')).map((e) => e.slice(2));
    const rows = (await this.db('file_shares as s')
      .join('files as f', 'f.id', 's.file_id')
      .where('s.tenant_id', p.tenantId)
      .whereNull('s.revoked_at')
      .whereNull('f.trashed_at')
      .andWhere((b) => {
        b.where({ 's.kind': 'user', 's.user_id': p.userId });
        if (mine.length) b.orWhere((x) => x.where('s.kind', 'workspace').whereIn('s.workspace_id', mine));
        if (groups.length) b.orWhere((x) => x.where('s.kind', 'group').whereIn('s.group_name', groups));
      })
      .orderBy('s.created_at', 'desc')
      .limit(500)
      .select('s.*', 'f.id as f_id')) as Record<string, unknown>[];
    const seen = new Set<string>();
    const out = [];
    for (const r of rows) {
      const x = shareFrom(r);
      if (!live(x) || seen.has(x.file_id)) continue;
      const f = await this.fileRow(p.tenantId, x.file_id);
      // A file in one of the caller's own workspaces is not "shared with" them.
      if (!f || !clears(p.clearance, f.label) || mine.includes(f.workspace_id)) continue;
      seen.add(x.file_id);
      out.push({ ...fileView(f), shareId: x.id, sharedVia: x.kind, sharedAt: x.created_at });
    }
    // 1.7.0 (B-9802): files granted, directly or by their folder, to one of the caller's groups.
    for (const { grant, fileId } of await this.groupGrants.files(p)) {
      if (seen.has(fileId)) continue;
      const f = await this.fileRow(p.tenantId, fileId);
      if (!f || f.trashed_at != null || !clears(p.clearance, f.label) || mine.includes(f.workspace_id)) continue;
      seen.add(fileId);
      out.push({ ...fileView(f), shareId: grant.id, sharedVia: 'social_group' as const, sharedAt: grant.created_at, groupId: grant.group_id, ...(grant.folder_id ? { viaFolder: grant.folder_id } : {}) });
    }
    return out;
  }

  private async linkRow(token: string): Promise<FileShareRow | null> {
    const r = await this.db('file_shares').where({ kind: 'link' }).whereIn('token_hash', macs(this.s().sysKeys.key('link'), `file-link:${token}`)).first();
    return r ? shareFrom(r) : null;
  }

  /**
   * What a signed-in reader learns about a link before using it: the file's name, size, type and label, and the
   * link's expiry and uses left. Nothing about the owner or where the file lives, and only for a live link of the
   * reader's tenant they are cleared for; every other case is the same 404 (the platform's BUG-020 told them apart).
   */
  async openLink(p: Principal, token: string) {
    const gone = () => notFound('Shared file');
    const x = await this.linkRow(token);
    if (!x || x.tenant_id !== p.tenantId || !live(x)) throw gone();
    const f = await this.fileRow(x.tenant_id, x.file_id);
    if (!f || f.trashed_at != null || f.state !== 'ready' || !clears(p.clearance, f.label)) throw gone();
    return { name: f.name, size: f.size, type: f.type, label: f.label, expiresAt: x.expires_at, usesLeft: x.max_uses == null ? null : x.max_uses - x.uses };
  }

  /**
   * Uses a link: one use is taken atomically (a conditional update that only succeeds while the link is live and has
   * uses left), then the current version is streamed. Signed in: the reader's tenant and clearance. Anonymous: the
   * link must be anonymous, the tenant must still allow anonymous links, and the file must be public now. Refusals
   * look the same. Every use is audited with the address.
   */
  async useLink(token: string, who: { principal: Principal } | { anonymous: true }, ip: string | null, traceId?: string): Promise<{ file: FileRow; version: VersionRow; stream: AsyncIterable<Buffer>; share: FileShareRow }> {
    const s = this.s();
    const gone = () => notFound('Shared file');
    const x = await this.linkRow(token);
    if (!x || !live(x)) throw gone();
    const f = await this.fileRow(x.tenant_id, x.file_id);
    if (!f || f.trashed_at != null || f.state !== 'ready' || f.current_version == null) throw gone();
    if ('principal' in who) {
      if (x.tenant_id !== who.principal.tenantId || !clears(who.principal.clearance, f.label)) throw gone();
    } else {
      if (!x.anonymous || f.label !== 'public') throw gone();
      if (!(await s.sharing.settings(x.tenant_id)).anonymousLinks) throw gone();
      const tenant = await s.tenants.byId(x.tenant_id);
      if (!tenant || tenant.state !== 'active') throw gone();
    }
    const version = await this.versionByNumber(f, f.current_version);
    if (version.state !== 'ready' || !clears('principal' in who ? who.principal.clearance : 'public', version.label)) throw gone();
    const now = Date.now();
    const taken = await this.db('file_shares')
      .where({ id: x.id })
      .whereNull('revoked_at')
      .andWhere((q) => q.whereNull('expires_at').orWhere('expires_at', '>', now))
      .andWhere((q) => q.whereNull('max_uses').orWhere('uses', '<', this.db.ref('max_uses')))
      .update({ uses: this.db.raw('?? + 1', ['uses']), last_used_at: now });
    if (!taken) throw gone();
    const actor = 'principal' in who ? { user: who.principal.userId, username: who.principal.username, ip } : { ip };
    await s.audit.append({ tenantId: x.tenant_id, action: 'file.downloaded', kind: 'principal' in who ? 'admin' : 'system', actor, target: { file: f.id, version: version.number, share: x.id }, label: f.label, detail: { via: 'link', anonymous: !('principal' in who), use: x.uses + 1, ...(x.max_uses != null ? { maxUses: x.max_uses } : {}) }, traceId: traceId ?? null });
    return { file: f, version, stream: await this.plain(version), share: { ...x, uses: x.uses + 1, last_used_at: now } };
  }

  // ---------- search (B-2405) ----------

  /** Files in the caller's workspaces whose name contains `q` and that carry every tag asked for, within clearance. */
  async search(p: Principal, input: { q?: string; tags?: string[]; workspaceId?: string | null; limit?: number }) {
    const ws = await this.memberWorkspaces(p);
    const ids = input.workspaceId ? (ws.has(input.workspaceId) ? [input.workspaceId] : []) : [...ws.keys()];
    if (!ids.length) return [];
    const q = this.db('files').where({ tenant_id: p.tenantId, state: 'ready' }).whereIn('workspace_id', ids).whereNull('trashed_at').whereIn('label', LABELS.filter((l) => clears(p.clearance, l)));
    if (input.q) {
      // 1.8.0 (B-142): the name, or an image's alt text or description.
      const like = `%${likeEscape(input.q.toLowerCase())}%`;
      q.where((w) =>
        w.whereRaw('name_lower like ? escape ?', [like, '\\']).orWhereExists((sub) =>
          void sub
            .select(this.db.raw('1'))
            .from('file_meta')
            .whereRaw('file_meta.file_id = files.id')
            .andWhere((m) => m.whereRaw('lower(file_meta.alt_text) like ? escape ?', [like, '\\']).orWhereRaw('lower(file_meta.description) like ? escape ?', [like, '\\']))
        )
      );
    }
    for (const tag of input.tags ?? []) q.whereExists((sub) => void sub.select(this.db.raw('1')).from('file_tags').whereRaw('file_tags.file_id = files.id').andWhere('file_tags.tag', tag.toLowerCase()));
    const rows = ((await q.orderBy('updated_at', 'desc').limit(input.limit ?? 100)) as Record<string, unknown>[]).map(fileFrom);
    const tags = await this.tagsFor(rows.map((f) => f.id));
    const meta = await this.metaFor(rows.map((f) => f.id));
    return rows.map((f) => ({ ...fileView(f, { tags: tags.get(f.id) ?? [] }), workspaceName: ws.get(f.workspace_id)?.name ?? null, altText: meta.get(f.id)?.alt_text ?? null }));
  }

  // ---------- a folder as a knowledge source (B-2405) ----------

  folderSource(): FolderSourceProvider {
    return {
      check: async (p, folderId) => {
        const f = await this.folder(p, folderId);
        return { id: f.id, name: f.name, workspaceId: f.workspace_id };
      },
      items: (tenantId, folderId, maxLabel, maxBytes) => this.folderItems(tenantId, folderId, maxLabel, maxBytes)
    };
  }

  /**
   * The files under a folder (subfolders included) a knowledge source may index: ready, not in the trash, a type
   * the knowledge pipeline reads, at most `maxBytes`, and labelled at or below `maxLabel` (the base's label), so a
   * document never sits in a base below its own label. Names are paths below the folder.
   */
  private async folderItems(tenantId: string, folderId: string, maxLabel: Label, maxBytes: number): Promise<SourceItem[]> {
    const root = await this.folderRow(tenantId, folderId);
    if (!root || root.trashed_at != null) throw new Error('The folder is in the trash or was deleted.');
    const ids = await this.descendants(tenantId, root.id);
    const folders = new Map(((await this.db('file_folders').whereIn('id', ids)) as Record<string, unknown>[]).map(folderFrom).map((f) => [f.id, f]));
    const pathOf = (id: string | null): string => {
      const parts: string[] = [];
      for (let cur = id ? folders.get(id) : undefined; cur && cur.id !== root.id; cur = cur.parent_id ? folders.get(cur.parent_id) : undefined) parts.unshift(cur.name);
      return parts.length ? `${parts.join('/')}/` : '';
    };
    const files = ((await this.db('files').where({ tenant_id: tenantId, state: 'ready' }).whereIn('folder_id', ids).whereNull('trashed_at').whereIn('label', LABELS.filter((l) => labelRank(l) <= labelRank(maxLabel))).where('size', '<=', maxBytes)) as Record<string, unknown>[]).map(fileFrom);
    const out: SourceItem[] = [];
    for (const f of files) {
      if (!f.type || !KNOWLEDGE_TYPES.includes(f.type) || f.current_version == null) continue;
      const v = await this.versionByNumber(f, f.current_version);
      if (v.state !== 'ready') continue;
      out.push({ key: `file:${f.id}`, name: `${pathOf(f.folder_id)}${f.name}`, version: v.id, size: v.size, type: v.type ?? undefined, read: async () => collect(await this.plain(v), maxBytes) });
    }
    return out;
  }

  // ---------- moderation (B-1901 hook) ----------

  /**
   * The file as a moderation object: what the moderation object registry (Sprint 26c) needs to show and act on a
   * report about a file. `takeDown` marks it taken down (B-9501: out of the tree and of the members' trash, kept
   * until its case closes) and revokes every share.
   */
  async moderationTarget(tenantId: string, id: string): Promise<{ type: typeof FILE_OBJECT_TYPE; id: string; tenantId: string; workspaceId: string; ownerId: string; label: Label; name: string; state: FileState; trashed: boolean; takenDown: boolean } | null> {
    const f = await this.fileRow(tenantId, id);
    return f ? { type: FILE_OBJECT_TYPE, id: f.id, tenantId, workspaceId: f.workspace_id, ownerId: f.owner_id, label: f.label, name: f.name, state: f.state, trashed: f.trashed_at != null, takenDown: f.taken_down_at != null } : null;
  }

  async takeDown(tenantId: string, id: string, by: string): Promise<boolean> {
    const f = await this.fileRow(tenantId, id);
    if (!f) return false;
    const t = Date.now();
    await this.db('file_shares').where({ tenant_id: tenantId, file_id: f.id }).whereNull('revoked_at').update({ revoked_at: t, revoked_by: by });
    if (f.taken_down_at != null) return false;
    // A file already in a member's trash stays theirs underneath (the takedown lifted, it is in their trash again),
    // on its own, so restoring the folder it went with does not bring it back meanwhile.
    const mark = f.trashed_at == null ? { trashed_at: t, trashed_by: by, purge_after: t + this.o.trashDays * 86_400_000 } : {};
    await this.db('files').where({ id: f.id }).update({ ...mark, trashed_with: f.id, taken_down_at: t, taken_down_by: by });
    return true;
  }

  /**
   * Undoes `takeDown` for an upheld appeal or a reversed action: the takedown is lifted if it still stands (`by`
   * matches and the file was not purged). A file a member had trashed before is in their trash again. Shares
   * revoked by the takedown stay revoked; the owner shares again.
   */
  async undoTakeDown(tenantId: string, id: string, by: string): Promise<boolean> {
    const f = await this.fileRow(tenantId, id);
    if (!f || f.taken_down_at == null || f.taken_down_by !== by) return false;
    const lifted = { taken_down_at: null, taken_down_by: null };
    const n = await this.db('files').where({ tenant_id: tenantId, id }).whereNotNull('taken_down_at').update(f.trashed_by === by ? { ...lifted, trashed_at: null, trashed_by: null, trashed_with: null, purge_after: null } : lifted);
    return n > 0;
  }
}
