import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { ulid } from 'ulid';
import { z } from 'zod';
import { clears, highest, labelRank, type Label } from '../../authz/labels.js';
import type { Principal } from '../../authz/policy.js';
import { json } from '../../db/knex.js';
import { loadPrincipal } from '../../http/middleware.js';
import { conflict, forbidden, HttpProblem, notFound } from '../../http/problem.js';
import type { JobContext } from '../../platform/jobs.js';
import type { Services } from '../../services.js';
import { collect } from '../crypt.js';
import type { FileRow, FolderRow, VersionRow } from '../service.js';
import { openConnector } from './connectors/index.js';
import { addressCheck } from './net.js';
import { cleanPath, LOCATION_LIMITS, RemoteError, type Connector, type LocationKind } from './model.js';

/*
 * Linked storage locations (2.0.0, `model.ts`): the rows, their sealed credentials, browsing, and copying files in
 * (an ordinary upload, quarantined and scanned) and out. A location belongs to one workspace; its members browse it
 * when cleared for its label; `files:link` (checked by the routes) adds, changes and removes locations.
 */

export interface LocationRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  name: string;
  kind: LocationKind;
  config: Record<string, unknown>;
  secret_sealed: string | null;
  label: Label;
  read_only: boolean;
  state: 'unchecked' | 'ok' | 'failing';
  last_checked_at: number | null;
  last_error: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface LocalRootRow {
  id: string;
  name: string;
  path: string;
  read_only: boolean;
  tenants: string[] | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const rowFrom = (r: Record<string, unknown>): LocationRow => ({ ...(r as unknown as LocationRow), config: json<Record<string, unknown>>(r.config, {}), read_only: !!r.read_only, last_checked_at: num(r.last_checked_at), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
const rootFrom = (r: Record<string, unknown>): LocalRootRow => ({ ...(r as unknown as LocalRootRow), read_only: !!r.read_only, tenants: json<string[] | null>(r.tenants, null), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
const aad = (id: string) => `file-location:${id}`;

// ---------- per-kind validation ----------

const host = z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.-]+$|^\[[0-9A-Fa-f:.]+\]$/, 'a host name or address');
const httpUrl = z.string().trim().url().max(500).refine((u) => /^https?:\/\//i.test(u), 'an http:// or https:// URL').transform((u) => u.replace(/\/+$/, ''));
const rel = z.string().trim().max(1024).default('').transform((p, ctx) => {
  try {
    return cleanPath(p);
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: (err as Error).message });
    return z.NEVER;
  }
});
const prefix = rel.transform((p) => (p ? `${p}/` : ''));

export const CONFIG_SCHEMAS = {
  s3: z.object({ endpoint: httpUrl, region: z.string().trim().min(1).max(40).default('us-east-1'), bucket: z.string().trim().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'an S3 bucket name'), prefix, pathStyle: z.boolean().default(false), flavour: z.enum(['aws', 'minio', 'self-hosted']).default('self-hosted') }).strict(),
  azure: z.object({ endpoint: httpUrl.optional(), account: z.string().trim().regex(/^[a-z0-9]{3,24}$/, 'a storage account name'), container: z.string().trim().regex(/^[a-z0-9](?!.*--)[a-z0-9-]{1,61}[a-z0-9]$/, 'a container name'), prefix }).strict(),
  local: z.object({ rootId: z.string().length(26), path: rel }).strict(),
  sftp: z.object({ host, port: z.number().int().min(1).max(65535).default(22), username: z.string().trim().min(1).max(100), root: z.string().trim().max(1024).default(''), hostKey: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/).nullable().default(null) }).strict(),
  ftp: z.object({ host, port: z.number().int().min(1).max(65535).default(21), username: z.string().trim().min(1).max(100), root: z.string().trim().max(1024).default(''), tls: z.enum(['explicit', 'implicit', 'none']).default('explicit') }).strict(),
  ipfs: z.object({ mode: z.enum(['rpc', 'gateway']), endpoint: httpUrl, root: z.string().trim().max(300).default(''), pin: z.boolean().default(true) }).strict()
} as const;

export const SECRET_SCHEMAS = {
  s3: z.object({ accessKeyId: z.string().trim().min(3).max(200), secretAccessKey: z.string().min(8).max(500), sessionToken: z.string().max(4000).optional() }).strict(),
  azure: z.union([z.object({ accountKey: z.string().trim().regex(/^[A-Za-z0-9+/=]{20,200}$/, 'a base64 account key') }).strict(), z.object({ sas: z.string().trim().min(10).max(2000).transform((x) => x.replace(/^\?/, '')) }).strict()]),
  local: z.null().optional(),
  sftp: z.union([z.object({ password: z.string().min(1).max(500) }).strict(), z.object({ privateKey: z.string().min(40).max(20_000), passphrase: z.string().max(500).optional() }).strict()]),
  ftp: z.object({ password: z.string().min(1).max(500) }).strict(),
  ipfs: z.object({ authorization: z.string().max(2000).optional() }).strict().nullable().optional()
} as const;

function parseKind<K extends LocationKind>(kind: K, config: unknown, secret: unknown, requireSecret: boolean) {
  const c = CONFIG_SCHEMAS[kind].safeParse(config);
  if (!c.success) throw new HttpProblem(400, 'Invalid request', `The ${kind} settings: ${c.error.issues.map((i) => `${i.path.join('.') || 'value'} ${i.message}`).join('; ')}`);
  let sec: unknown = undefined;
  if (secret !== undefined) {
    const r = SECRET_SCHEMAS[kind].safeParse(secret);
    if (!r.success) throw new HttpProblem(400, 'Invalid request', `The ${kind} credentials: ${r.error.issues.map((i) => `${i.path.join('.') || 'value'} ${i.message}`).join('; ')}`);
    sec = r.data;
  } else if (requireSecret && kind !== 'local' && kind !== 'ipfs') throw new HttpProblem(400, 'Invalid request', `A ${kind} location needs credentials.`);
  const cfg = c.data as Record<string, unknown>;
  if (kind === 'azure' && !cfg.endpoint) cfg.endpoint = `https://${String(cfg.account)}.blob.core.windows.net`;
  return { config: cfg, secret: sec };
}

export const locationView = (l: LocationRow, writable: boolean) => ({
  id: l.id,
  workspaceId: l.workspace_id,
  name: l.name,
  kind: l.kind,
  config: l.config,
  hasSecret: !!l.secret_sealed,
  label: l.label,
  readOnly: l.read_only,
  writable,
  state: l.state,
  lastCheckedAt: l.last_checked_at,
  lastError: l.last_error,
  createdBy: l.created_by,
  createdAt: l.created_at,
  updatedAt: l.updated_at
});

export const localRootView = (r: LocalRootRow) => ({ id: r.id, name: r.name, path: r.path, readOnly: r.read_only, tenants: r.tenants, createdAt: r.created_at, updatedAt: r.updated_at });

const remote = (err: unknown): never => {
  if (err instanceof RemoteError) throw new HttpProblem(err.status, err.status === 403 ? 'Refused' : err.status === 404 ? 'Not found' : err.status === 501 ? 'Not supported' : 'Remote storage error', err.message, { extensions: { step: 'remote' } });
  throw err;
};

/** Whether a connector of this kind and config can write at all (before opening it). */
const kindWritable = (l: Pick<LocationRow, 'kind' | 'config' | 'read_only'>, root?: LocalRootRow | null) => !l.read_only && !(l.kind === 'ipfs' && l.config.mode === 'gateway') && !(l.kind === 'local' && (!root || root.read_only));

export class FileLocations {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  registerJobs(): void {
    this.s().jobs.register('files.location.import', (p, ctx) => this.runImport(p, ctx), { timeoutMs: 6 * 60 * 60_000 });
  }

  // ---------- local roots (operators) ----------

  async localRoots(): Promise<LocalRootRow[]> {
    return ((await this.db('file_local_roots').orderBy('name')) as Record<string, unknown>[]).map(rootFrom);
  }

  async localRootsFor(tenantId: string): Promise<LocalRootRow[]> {
    return (await this.localRoots()).filter((r) => !r.tenants || r.tenants.includes(tenantId));
  }

  /** An operator's directory: absolute, existing, a directory, and never the blob store's own directory or above it. */
  private async checkRootPath(raw: string): Promise<string> {
    if (!path.isAbsolute(raw)) throw new HttpProblem(400, 'Invalid request', 'Give an absolute path on the server.');
    let real: string;
    try {
      real = await realpath(raw);
      if (!(await stat(real)).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new HttpProblem(400, 'Invalid request', `${raw} is not a directory the server can read.`);
    }
    const s = this.s();
    const guarded = [s.cfg.BLOB_DIR, s.cfg.MEDIA_WORK_DIR].filter((x): x is string => !!x).map((x) => path.resolve(x));
    for (const g of guarded) {
      const gr = await realpath(g).catch(() => g);
      if (real === gr || gr.startsWith(`${real}${path.sep}`) || real.startsWith(`${gr}${path.sep}`)) throw new HttpProblem(400, 'Invalid request', 'A local store may not hold, or be inside, the server\'s own storage directories.');
    }
    if (real === path.parse(real).root) throw new HttpProblem(400, 'Invalid request', 'A local store may not be the file system root.');
    return real;
  }

  async addLocalRoot(by: string, input: { name: string; path: string; readOnly: boolean; tenants: string[] | null }): Promise<LocalRootRow> {
    const t = Date.now();
    const row: LocalRootRow = { id: ulid(), name: input.name, path: await this.checkRootPath(input.path), read_only: input.readOnly, tenants: input.tenants, created_by: by, created_at: t, updated_at: t };
    await this.db('file_local_roots').insert({ ...row, tenants: row.tenants ? JSON.stringify(row.tenants) : null });
    return row;
  }

  async updateLocalRoot(id: string, patch: { name?: string; path?: string; readOnly?: boolean; tenants?: string[] | null }): Promise<{ before: LocalRootRow; after: LocalRootRow }> {
    const before = (await this.localRoots()).find((r) => r.id === id);
    if (!before) throw notFound('Local store');
    const after: LocalRootRow = { ...before, name: patch.name ?? before.name, path: patch.path !== undefined ? await this.checkRootPath(patch.path) : before.path, read_only: patch.readOnly ?? before.read_only, tenants: patch.tenants !== undefined ? patch.tenants : before.tenants, updated_at: Date.now() };
    await this.db('file_local_roots').where({ id }).update({ name: after.name, path: after.path, read_only: after.read_only, tenants: after.tenants ? JSON.stringify(after.tenants) : null, updated_at: after.updated_at });
    return { before, after };
  }

  async removeLocalRoot(id: string): Promise<LocalRootRow> {
    const before = (await this.localRoots()).find((r) => r.id === id);
    if (!before) throw notFound('Local store');
    const used = (await this.db('file_locations').where({ kind: 'local' }).select('id', 'config')) as { id: string; config: unknown }[];
    if (used.some((u) => json<{ rootId?: string }>(u.config, {}).rootId === id)) throw conflict(`${before.name} is linked by Files locations; remove those first.`);
    await this.db('file_local_roots').where({ id }).delete();
    return before;
  }

  // ---------- rows ----------

  private async rowOf(tenantId: string, id: string): Promise<LocationRow | undefined> {
    const r = await this.db('file_locations').where({ tenant_id: tenantId, id }).first();
    return r ? rowFrom(r) : undefined;
  }

  private async rootOf(l: Pick<LocationRow, 'kind' | 'config' | 'tenant_id'>): Promise<LocalRootRow | null> {
    if (l.kind !== 'local') return null;
    return (await this.localRootsFor(l.tenant_id)).find((r) => r.id === l.config.rootId) ?? null;
  }

  /** A location the caller may see: a member of its workspace, cleared for its label. */
  async get(p: Principal, id: string): Promise<LocationRow> {
    const l = await this.rowOf(p.tenantId, id);
    if (!l) throw notFound('Location');
    await this.s().files.workspaceFor(p, l.workspace_id).catch(() => {
      throw notFound('Location');
    });
    if (!clears(p.clearance, l.label)) throw notFound('Location');
    return l;
  }

  async list(p: Principal, workspaceId?: string | null) {
    const w = await this.s().files.workspaceFor(p, workspaceId ?? null);
    const rows = ((await this.db('file_locations').where({ tenant_id: p.tenantId, workspace_id: w.id }).orderBy('name')) as Record<string, unknown>[]).map(rowFrom).filter((l) => clears(p.clearance, l.label));
    const roots = await this.localRootsFor(p.tenantId);
    return rows.map((l) => locationView(l, kindWritable(l, l.kind === 'local' ? roots.find((r) => r.id === l.config.rootId) : null)));
  }

  async view(l: LocationRow) {
    return locationView(l, kindWritable(l, await this.rootOf(l)));
  }

  private checkLabel(p: Principal, ceiling: Label, label: Label): void {
    if (!clears(p.clearance, label)) throw forbidden(`Your clearance is ${p.clearance}; the location would be ${label}.`, { step: 'clearance' });
    if (labelRank(label) > labelRank(ceiling)) throw forbidden(`The workspace's ceiling is ${ceiling}; the location would be ${label}.`, { step: 'zone' });
  }

  async create(p: Principal, input: { workspaceId?: string | null; name: string; kind: LocationKind; config: unknown; secret?: unknown; label: Label; readOnly?: boolean }): Promise<LocationRow> {
    const w = await this.s().files.workspaceFor(p, input.workspaceId ?? null);
    this.checkLabel(p, w.label_ceiling, input.label);
    const { config, secret } = parseKind(input.kind, input.config, input.secret, true);
    if (input.kind === 'local' && !(await this.localRootsFor(p.tenantId)).some((r) => r.id === config.rootId)) throw notFound('Local store');
    if (await this.db('file_locations').where({ tenant_id: p.tenantId, workspace_id: w.id }).whereRaw('lower(name) = ?', [input.name.toLowerCase()]).first('id')) throw conflict(`A location named ${input.name} is already linked here.`);
    const t = Date.now();
    const id = ulid();
    const row: LocationRow = { id, tenant_id: p.tenantId, workspace_id: w.id, name: input.name, kind: input.kind, config, secret_sealed: secret ? await this.s().keys.seal(p.tenantId, JSON.stringify(secret), aad(id)) : null, label: input.label, read_only: !!input.readOnly, state: 'unchecked', last_checked_at: null, last_error: null, created_by: p.userId, created_at: t, updated_at: t };
    await this.db('file_locations').insert({ ...row, config: JSON.stringify(config) });
    return row;
  }

  async update(p: Principal, id: string, patch: { name?: string; config?: unknown; secret?: unknown; label?: Label; readOnly?: boolean }): Promise<{ before: LocationRow; after: LocationRow }> {
    const before = await this.get(p, id);
    const w = await this.s().files.workspaceFor(p, before.workspace_id);
    if (patch.label) this.checkLabel(p, w.label_ceiling, patch.label);
    const merged = patch.config !== undefined ? parseKind(before.kind, patch.config, patch.secret, false) : patch.secret !== undefined ? parseKind(before.kind, before.config, patch.secret, false) : null;
    if (merged && before.kind === 'local' && !(await this.localRootsFor(p.tenantId)).some((r) => r.id === merged.config.rootId)) throw notFound('Local store');
    const after: LocationRow = {
      ...before,
      name: patch.name ?? before.name,
      config: merged ? merged.config : before.config,
      secret_sealed: merged?.secret ? await this.s().keys.seal(p.tenantId, JSON.stringify(merged.secret), aad(id)) : before.secret_sealed,
      label: patch.label ?? before.label,
      read_only: patch.readOnly ?? before.read_only,
      state: merged ? 'unchecked' : before.state,
      updated_at: Date.now()
    };
    await this.db('file_locations').where({ id }).update({ name: after.name, config: JSON.stringify(after.config), secret_sealed: after.secret_sealed, label: after.label, read_only: after.read_only, state: after.state, updated_at: after.updated_at });
    return { before, after };
  }

  async remove(p: Principal, id: string): Promise<LocationRow> {
    const l = await this.get(p, id);
    await this.db('file_locations').where({ id: l.id }).delete();
    return l;
  }

  // ---------- connections ----------

  private async open(l: LocationRow, signal?: AbortSignal): Promise<Connector> {
    const s = this.s();
    const secret = l.secret_sealed ? json<unknown>(await s.keys.open(l.tenant_id, l.secret_sealed, aad(l.id)), null) : null;
    const root = await this.rootOf(l);
    if (l.kind === 'local' && !root) throw conflict('The local store this location reads is no longer offered to this tenant. An operator manages local stores under Storage.');
    return openConnector(l.kind, l.config, secret, { check: await addressCheck(s, l.tenant_id), timeoutMs: LOCATION_LIMITS.timeoutMs, ...(signal ? { signal } : {}), ...(root ? { localRoot: { path: root.path, readOnly: root.read_only } } : {}) }, { readOnly: l.read_only });
  }

  private async using<T>(l: LocationRow, f: (c: Connector) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const c = await this.open(l, signal);
    try {
      return await f(c);
    } catch (err) {
      return remote(err);
    } finally {
      await c.close().catch(() => undefined);
    }
  }

  /** Tries settings before they are saved (`files:link`); the SFTP host key comes back to be pinned. */
  async testUnsaved(p: Principal, input: { kind: LocationKind; config: unknown; secret?: unknown }) {
    const { config, secret } = parseKind(input.kind, input.config, input.secret, false);
    const root = input.kind === 'local' ? ((await this.localRootsFor(p.tenantId)).find((r) => r.id === config.rootId) ?? null) : null;
    if (input.kind === 'local' && !root) throw notFound('Local store');
    const c = await openConnector(input.kind, config, secret ?? null, { check: await addressCheck(this.s(), p.tenantId), timeoutMs: 20_000, ...(root ? { localRoot: { path: root.path, readOnly: root.read_only } } : {}) }, {});
    try {
      const out = await c.test();
      return { ok: true, detail: out.detail, ...('hostKey' in c && c.hostKey ? { hostKey: String(c.hostKey) } : {}) };
    } catch (err) {
      return remote(err);
    } finally {
      await c.close().catch(() => undefined);
    }
  }

  /** Tests a saved location and records the outcome; an SFTP host key seen for the first time is pinned. */
  async test(p: Principal, id: string) {
    const l = await this.get(p, id);
    const c = await this.open(l);
    const t = Date.now();
    try {
      const out = await c.test();
      const hostKey = 'hostKey' in c && c.hostKey ? String(c.hostKey) : null;
      const config = l.kind === 'sftp' && hostKey && !l.config.hostKey ? { ...l.config, hostKey } : l.config;
      await this.db('file_locations').where({ id: l.id }).update({ state: 'ok', last_checked_at: t, last_error: null, config: JSON.stringify(config) });
      return { ok: true, detail: out.detail, ...(hostKey ? { hostKey, pinned: config !== l.config } : {}) };
    } catch (err) {
      await this.db('file_locations').where({ id: l.id }).update({ state: 'failing', last_checked_at: t, last_error: (err as Error).message.slice(0, 500) });
      return remote(err);
    } finally {
      await c.close().catch(() => undefined);
    }
  }

  async browse(p: Principal, id: string, dir: string, cursor: string | null) {
    const l = await this.get(p, id);
    let clean: string;
    try {
      clean = cleanPath(dir);
    } catch (err) {
      throw new HttpProblem(400, 'Invalid request', (err as Error).message);
    }
    const out = await this.using(l, (c) => c.list(clean, cursor));
    return { location: await this.view(l), path: clean, entries: out.entries.slice(0, LOCATION_LIMITS.pageSize), next: out.next };
  }

  // ---------- copying in ----------

  /** The files under the paths asked for: files as they are, directories walked (subfolders kept), at most maxBatch. */
  private async expand(c: Connector, paths: string[]): Promise<{ path: string; rel: string; size: number | null }[]> {
    const out: { path: string; rel: string; size: number | null }[] = [];
    const walk = async (dir: string, base: string) => {
      let cursor: string | null = null;
      do {
        const page = await c.list(dir, cursor);
        for (const e of page.entries) {
          if (out.length >= LOCATION_LIMITS.maxBatch) throw new HttpProblem(413, 'Too many files', `One import copies up to ${LOCATION_LIMITS.maxBatch} files; choose fewer.`);
          const rel = base ? `${base}/${e.name}` : e.name;
          if (e.dir) await walk(e.path, rel);
          else out.push({ path: e.path, rel, size: e.size });
        }
        cursor = page.next;
      } while (cursor);
    };
    for (const raw of paths) {
      const p = cleanPath(raw);
      const st = await c.stat(p);
      if (!st) throw new HttpProblem(404, 'Not found', `${p || 'The root'} is not in this location.`);
      if (st.dir) await walk(p, st.name || p.split('/').pop() || 'import');
      else out.push({ path: p, rel: st.name || p.split('/').pop() || 'file', size: st.size });
    }
    return out;
  }

  /** The folder (made when missing) below `base` for a relative directory path. */
  private async folderFor(p: Principal, workspaceId: string, base: string | null, relDir: string, cache: Map<string, string | null>): Promise<string | null> {
    if (!relDir) return base;
    const hit = cache.get(relDir);
    if (hit !== undefined) return hit;
    const parts = relDir.split('/');
    const parent = await this.folderFor(p, workspaceId, base, parts.slice(0, -1).join('/'), cache);
    const name = parts[parts.length - 1]!;
    const existing = (await this.db('file_folders').where({ tenant_id: p.tenantId, workspace_id: workspaceId, parent_id: parent }).whereNull('trashed_at').select('id', 'name')) as { id: string; name: string }[];
    const found = existing.find((x) => x.name.toLowerCase() === name.toLowerCase());
    const id = found ? found.id : (await this.s().files.createFolder(p, { workspaceId, parentId: parent, name })).id;
    cache.set(relDir, id);
    return id;
  }

  private async importOne(p: Principal, c: Connector, l: LocationRow, item: { path: string; rel: string }, target: { workspaceId: string; folderId: string | null; label: Label }, cache: Map<string, string | null>): Promise<{ file: FileRow; version: VersionRow }> {
    const s = this.s();
    const dir = item.rel.includes('/') ? item.rel.slice(0, item.rel.lastIndexOf('/')) : '';
    const folderId = await this.folderFor(p, target.workspaceId, target.folderId, dir, cache);
    // eslint-disable-next-line no-control-regex
    const base = item.rel.split('/').pop()!.replace(/[\\/\u0000-\u001f\u007f]/g, '_').slice(0, 255) || 'file';
    const name = await s.files.freeName(p.tenantId, target.workspaceId, folderId, base);
    const got = await c.read(item.path);
    return s.files.upload(p, { workspaceId: target.workspaceId, folderId, name, label: target.label, declaredType: got.type, declaredBytes: got.size }, got.stream);
  }

  /**
   * Copies files in: one small file at once (answered with the file), anything else as the `files.location.import` job.
   * The new files get at least the location's label.
   */
  async importFiles(p: Principal, id: string, input: { paths: string[]; folderId?: string | null; label?: Label }): Promise<{ jobId: string } | { files: FileRow[]; versions: VersionRow[]; location: LocationRow }> {
    const s = this.s();
    const l = await this.get(p, id);
    let folder: FolderRow | null = null;
    if (input.folderId) folder = await s.files.folder(p, input.folderId);
    const w = await s.files.workspaceFor(p, folder?.workspace_id ?? l.workspace_id);
    const label = highest(l.label, input.label ?? l.label);
    this.checkLabel(p, w.label_ceiling, label);
    let paths: string[];
    try {
      paths = input.paths.map(cleanPath);
    } catch (err) {
      throw new HttpProblem(400, 'Invalid request', (err as Error).message);
    }
    if (paths.length === 1) {
      const quick = await this.using(l, async (c) => {
        const st = await c.stat(paths[0]!);
        if (!st) throw new HttpProblem(404, 'Not found', `${paths[0]} is not in this location.`);
        if (st.dir || st.size == null || st.size > 16 * 1024 * 1024) return null;
        return this.importOne(p, c, l, { path: paths[0]!, rel: st.name || paths[0]!.split('/').pop()! }, { workspaceId: w.id, folderId: folder?.id ?? null, label }, new Map());
      });
      if (quick) {
        const v = (await s.files.scanNow(quick.version.id, 15_000)) ?? quick.version;
        return { files: [await s.files.writable(p, quick.file.id)], versions: [v], location: l };
      }
    }
    const job = await s.jobs.enqueue({ tenantId: p.tenantId, type: 'files.location.import', payload: { locationId: l.id, userId: p.userId, paths, workspaceId: w.id, folderId: folder?.id ?? null, label }, createdBy: p.userId, maxAttempts: 1 });
    return { jobId: job.id };
  }

  private async runImport(payload: Record<string, unknown>, ctx: JobContext): Promise<unknown> {
    const s = this.s();
    const tenantId = ctx.job.tenant_id ?? '';
    const p = await loadPrincipal(s, tenantId, String(payload.userId), {});
    if (!p) return { skipped: 'the person who asked is no longer active' };
    const l = await this.get(p, String(payload.locationId));
    const target = { workspaceId: String(payload.workspaceId), folderId: (payload.folderId as string | null) ?? null, label: payload.label as Label };
    const c = await this.open(l, ctx.signal);
    const done: string[] = [];
    const failed: { path: string; error: string }[] = [];
    try {
      const items = await this.expand(c, (payload.paths as string[]) ?? []);
      const cache = new Map<string, string | null>();
      for (const [i, item] of items.entries()) {
        if (ctx.signal?.aborted) break;
        try {
          const { file } = await this.importOne(p, c, l, item, target, cache);
          done.push(file.id);
        } catch (err) {
          failed.push({ path: item.path, error: (err as Error).message.slice(0, 300) });
        }
        await ctx.progress?.(Math.round(((i + 1) / items.length) * 100), `${i + 1} of ${items.length}`);
      }
    } finally {
      await c.close().catch(() => undefined);
    }
    await s.audit.append({ tenantId, action: 'file.location.imported', kind: 'admin', actor: { user: p.userId, username: p.username }, target: { location: l.id, workspace: target.workspaceId }, label: target.label, detail: { files: done.length, failed: failed.length, folder: target.folderId, ...(failed.length ? { failures: failed.slice(0, 20) } : {}) } });
    return { files: done.length, failed };
  }

  // ---------- copying out ----------

  /** Sends a file's current version to a writable location (images without their metadata, as every reader gets them). */
  async send(p: Principal, fileId: string, input: { locationId: string; path?: string | null }) {
    const s = this.s();
    const l = await this.get(p, input.locationId);
    const { file, version, stream } = await s.files.content(p, fileId);
    if (labelRank(version.label) > labelRank(l.label)) {
      await (stream as AsyncGenerator<Buffer>).return?.(undefined);
      throw forbidden(`${file.name} is ${version.label}; ${l.name} takes files up to ${l.label}.`, { step: 'label' });
    }
    let target: string;
    try {
      target = cleanPath(input.path || file.name);
    } catch (err) {
      throw new HttpProblem(400, 'Invalid request', (err as Error).message);
    }
    const served = await s.files.served(p, file, version, stream);
    const body = served.size == null ? await collect(served.stream, s.files.options.maxBytes) : null;
    const size = body ? body.length : served.size!;
    const out = await this.using(l, async (c) => {
      if (!c.writable) throw new HttpProblem(409, 'Conflict', `${l.name} is read-only.`);
      return c.write(target, body ? (async function* () { yield body; })() : served.stream, size, version.type);
    });
    return { location: l, file, version, path: target, size, ...out };
  }
}

