import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { LABELS, type Label } from '../authz/labels.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { badRequest, forbidden, notFound, tooManyRequests } from '../http/problem.js';
import { fileShareView, fileView, folderView, versionView, type FileShareRow } from '../files/service.js';
import { redirectToMedia, sandboxHeaders } from '../media/origin.js';
import { Limiter } from '../platform/ratelimit.js';
import type { Services } from '../services.js';
import { sendBytes } from './media.js';

const id26 = z.string().length(26);
const TOKEN = /^exf_[A-Za-z0-9_-]{20,100}$/;

/** A file or folder name: no path separators or control characters, not `.` or `..`. */
export const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((n) => n !== '.' && n !== '..' && !/[/\\]/.test(n) && ![...n].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127), 'a name without / or \\ or control characters');

const tagSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9 _.-]{0,39}$/, 'a tag of letters, digits, spaces, dots, dashes and underscores, at most 40 characters');

/**
 * Content-Disposition with the name escaped (RFC 6266 and RFC 8187): an ASCII fallback with anything outside a safe
 * set replaced, and the exact name percent-encoded in `filename*`. The platform's filevault put the raw name inside
 * quotes, so a name with a quote or a line break could change the header.
 */
export function contentDisposition(kind: 'attachment' | 'inline', name: string): string {
  const ascii = name.replace(/[^A-Za-z0-9 ._()-]/g, '_').slice(0, 150) || 'file';
  const star = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${star}`;
}

const textual = (type: string) => type.startsWith('text/') || type === 'application/json';

/**
 * Streams decrypted content to the client under the media sandbox (B-413): `Content-Security-Policy: sandbox`,
 * `nosniff`, and always as an attachment, so a stored HTML or SVG file can never run with the console's origin.
 */
export async function sendFile(res: Response, o: { name: string; type: string | null; size: number; stream: AsyncIterable<Buffer> }): Promise<void> {
  sandboxHeaders(res);
  const type = o.type ?? 'application/octet-stream';
  res.setHeader('Content-Type', textual(type) ? `${type}; charset=utf-8` : type);
  res.setHeader('Content-Length', String(o.size));
  res.setHeader('Content-Disposition', contentDisposition('attachment', o.name));
  res.setHeader('Cache-Control', 'private, no-store');
  await pipeline(Readable.from(o.stream), res);
}

/**
 * The file store (Sprint 26d, B-2401 to B-2405). Reading needs `files:read`, changing `files:write`; both act inside
 * the caller's workspaces and clearance (shared files are read-only). Uploads are the raw body, streamed.
 */
export function fileRoutes(s: Services): Router {
  const r = Router();
  r.use(['/files', '/file-links'], noStore, requireAuth());
  const read = requirePermission(s, 'files:read');
  const write = requirePermission(s, 'files:write');
  const f = s.files;

  const audit = (req: Request, action: string, target: Record<string, unknown>, label?: Label, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, ...(label ? { label } : {}), ...(detail ? { detail } : {}), traceId: req.traceId });
  };

  const declared = (req: Request): number | null => {
    const n = Number(req.header('content-length') ?? NaN);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  const describeShare = async (tenantId: string, x: FileShareRow) =>
    fileShareView(x, {
      userName: x.user_id ? ((await s.users.get(tenantId, x.user_id))?.display_name ?? null) : null,
      workspaceName: x.workspace_id ? ((await s.tenants.workspace(tenantId, x.workspace_id))?.name ?? null) : null
    });

  // ---------- browsing, folders ----------

  r.get('/files/browse', read, async (req, res) => {
    const q = parseBody(z.object({ workspace: id26.optional(), folder: id26.optional() }), req.query);
    res.json(await f.browse(principalOf(req), { workspaceId: q.workspace ?? null, folderId: q.folder ?? null }));
  });

  r.post('/files/folders', write, async (req, res) => {
    const body = parseBody(z.object({ name: nameSchema, parentId: id26.nullable().optional(), workspaceId: id26.optional() }).strict(), req.body);
    const folder = await f.createFolder(principalOf(req), body);
    await audit(req, 'file.folder.created', { folder: folder.id, workspace: folder.workspace_id }, undefined, { name: folder.name, parent: folder.parent_id });
    res.status(201).json(folderView(folder));
  });

  r.patch('/files/folders/:id', write, async (req, res) => {
    const body = parseBody(z.object({ name: nameSchema.optional(), parentId: id26.nullable().optional() }).strict(), req.body);
    const { before, after } = await f.updateFolder(principalOf(req), parseBody(id26, req.params.id), body);
    await audit(req, 'file.folder.updated', { folder: after.id, workspace: after.workspace_id }, undefined, { before: { name: before.name, parent: before.parent_id }, after: { name: after.name, parent: after.parent_id } });
    res.json(folderView(after));
  });

  r.delete('/files/folders/:id', write, async (req, res) => {
    const out = await f.trashFolder(principalOf(req), parseBody(id26, req.params.id));
    await audit(req, 'file.folder.trashed', { folder: out.folder.id, workspace: out.folder.workspace_id }, undefined, { files: out.files, folders: out.folders, purgeAfter: out.folder.purge_after });
    res.json({ ...folderView(out.folder), files: out.files, folders: out.folders });
  });

  // ---------- trash ----------

  r.get('/files/trash', read, async (req, res) => {
    const q = parseBody(z.object({ workspace: id26.optional() }), req.query);
    res.json(await f.trash(principalOf(req), q.workspace ?? null));
  });

  r.post('/files/trash/restore', write, async (req, res) => {
    const body = parseBody(z.object({ kind: z.enum(['file', 'folder']), id: id26 }).strict(), req.body);
    const out = await f.restoreFromTrash(principalOf(req), body.kind, body.id);
    await audit(req, body.kind === 'file' ? 'file.untrashed' : 'file.folder.untrashed', { [body.kind]: out.id }, out.label, { name: out.name, files: out.files });
    res.json(out);
  });

  /** Empties the workspace's trash now, as a job (the scheduled purge only takes what passed its purge date). */
  r.post('/files/trash/empty', write, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ workspaceId: id26.optional() }).strict(), req.body ?? {});
    const w = await f.workspaceFor(p, body.workspaceId ?? null);
    const job = await s.jobs.enqueue({ tenantId: p.tenantId, type: 'files.purge', payload: { tenantId: p.tenantId, workspaceId: w.id, all: true, by: p.userId }, createdBy: p.userId, maxAttempts: 2 });
    await audit(req, 'file.trash.emptied', { workspace: w.id }, undefined, { job: job.id });
    res.status(202).json({ jobId: job.id });
  });

  // ---------- search, shared with me, usage ----------

  r.get('/files/search', read, async (req, res) => {
    const q = parseBody(z.object({ q: z.string().trim().max(200).optional(), tag: z.union([tagSchema, z.array(tagSchema).max(10)]).optional(), workspace: id26.optional() }), req.query);
    const tags = q.tag == null ? [] : Array.isArray(q.tag) ? q.tag : [q.tag];
    if (!q.q && !tags.length) throw badRequest('Give a name to search for (q) or at least one tag.');
    res.json(await f.search(principalOf(req), { q: q.q ?? '', tags, workspaceId: q.workspace ?? null }));
  });

  r.get('/files/shared', read, async (req, res) => {
    res.json(await f.sharedWithMe(principalOf(req)));
  });

  /** Storage used and the limits that apply, for the current (or named) workspace and the tenant. */
  r.get('/files/usage', read, async (req, res) => {
    const p = principalOf(req);
    const q = parseBody(z.object({ workspace: id26.optional() }), req.query);
    const w = await f.workspaceFor(p, q.workspace ?? null);
    res.json({ workspace: { id: w.id, name: w.name, ...(await f.storage(p.tenantId, w.id)) }, tenant: await f.storage(p.tenantId, null), maxUploadBytes: f.options.maxBytes, trashDays: f.options.trashDays });
  });

  // ---------- uploads ----------

  r.put('/files/uploads', write, async (req, res) => {
    const p = principalOf(req);
    const q = parseBody(z.object({ name: nameSchema, label: z.enum(LABELS).default('internal'), folder: id26.optional(), workspace: id26.optional() }), req.query);
    const { file, version } = await f.upload(p, { workspaceId: q.workspace ?? null, folderId: q.folder ?? null, name: q.name, label: q.label, declaredType: req.header('content-type') ?? null, declaredBytes: declared(req) }, req);
    await audit(req, 'file.upload.received', { file: file.id, version: version.number, workspace: file.workspace_id }, version.label, { name: file.name, size: version.size, sha256: version.sha256, folder: file.folder_id });
    res.status(202).json({ ...fileView(file), version: versionView(version) });
  });

  // ---------- one file ----------

  r.get('/files/:id', read, async (req, res) => {
    res.json(await f.details(principalOf(req), parseBody(id26, req.params.id)));
  });

  r.patch('/files/:id', write, async (req, res) => {
    const body = parseBody(z.object({ name: nameSchema.optional(), folderId: id26.nullable().optional() }).strict(), req.body);
    const { before, after } = await f.updateFile(principalOf(req), parseBody(id26, req.params.id), body);
    await audit(req, 'file.changed', { file: after.id, workspace: after.workspace_id }, after.label, { before: { name: before.name, folder: before.folder_id }, after: { name: after.name, folder: after.folder_id } });
    res.json(fileView(after));
  });

  r.put('/files/:id/tags', write, async (req, res) => {
    const body = parseBody(z.object({ tags: z.array(tagSchema).max(20) }).strict(), req.body);
    const out = await f.setTags(principalOf(req), parseBody(id26, req.params.id), body.tags);
    await audit(req, 'file.tags.updated', { file: out.file.id }, out.file.label, { before: out.before, after: out.after });
    res.json({ ...fileView(out.file), tags: out.after });
  });

  r.delete('/files/:id', write, async (req, res) => {
    const file = await f.trashFile(principalOf(req), parseBody(id26, req.params.id));
    await audit(req, 'file.trashed', { file: file.id, workspace: file.workspace_id }, file.label, { name: file.name, purgeAfter: file.purge_after });
    res.json(fileView(file));
  });

  const download = async (req: Request, res: Response, number?: number) => {
    const p = principalOf(req);
    const { file, version, stream, via } = await f.content(p, parseBody(id26, req.params.id), number);
    await audit(req, 'file.downloaded', { file: file.id, version: version.number }, version.label, { via: via === 'workspace' ? 'workspace' : `share:${via.kind}`, ...(via !== 'workspace' ? { share: via.id } : {}), size: version.size });
    await sendFile(res, { name: file.name, type: version.type, size: version.size, stream });
  };

  r.get('/files/:id/content', read, async (req, res) => download(req, res));

  r.put('/files/:id/content', write, async (req, res) => {
    const p = principalOf(req);
    const q = parseBody(z.object({ label: z.enum(LABELS).optional() }), req.query);
    const { file, version } = await f.uploadVersion(p, parseBody(id26, req.params.id), { ...(q.label ? { label: q.label } : {}), declaredType: req.header('content-type') ?? null, declaredBytes: declared(req) }, req);
    await audit(req, 'file.upload.received', { file: file.id, version: version.number, workspace: file.workspace_id }, version.label, { name: file.name, size: version.size, sha256: version.sha256 });
    res.status(202).json({ ...fileView(file), version: versionView(version) });
  });

  r.get('/files/:id/versions', read, async (req, res) => {
    res.json((await f.versions(principalOf(req), parseBody(id26, req.params.id))).map(versionView));
  });

  r.get('/files/:id/versions/:n/content', read, async (req, res) => download(req, res, parseBody(z.coerce.number().int().min(1), req.params.n)));

  r.post('/files/:id/versions/:n/restore', write, async (req, res) => {
    const { file, version, from } = await f.restoreVersion(principalOf(req), parseBody(id26, req.params.id), parseBody(z.coerce.number().int().min(1), req.params.n));
    await audit(req, 'file.version.restore.requested', { file: file.id, version: version.number }, version.label, { from: from.number, size: version.size });
    res.status(202).json({ ...fileView(file), version: versionView(version) });
  });

  r.get('/files/:id/preview', read, async (req, res) => {
    const p = principalOf(req);
    const id = parseBody(id26, req.params.id);
    // Authorise before any redirect: the signed URL is only handed to a reader.
    const pv = await f.preview(p, id);
    if (redirectToMedia(s, req, res, { kind: 'file-preview', id })) return;
    sendBytes(req, res, pv.data, pv.type, 'inline');
  });

  // ---------- shares (B-2402) ----------

  r.get('/files/:id/shares', read, async (req, res) => {
    const p = principalOf(req);
    const list = await f.shares(p, parseBody(id26, req.params.id));
    res.json(await Promise.all(list.map((x) => describeShare(p.tenantId, x))));
  });

  r.post('/files/:id/shares', write, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('user'), userId: id26 }).strict(),
        z.object({ kind: z.literal('group'), group: z.string().trim().min(1).max(200) }).strict(),
        z.object({ kind: z.literal('workspace'), workspaceId: id26 }).strict(),
        z.object({ kind: z.literal('link'), expiresInHours: z.number().int().min(1).max(30 * 24).default(7 * 24), maxUses: z.number().int().min(1).max(100_000).nullable().optional(), anonymous: z.boolean().default(false) }).strict()
      ]),
      req.body
    );
    const { share, token, file } = await f.createShare(p, parseBody(id26, req.params.id), body);
    await audit(req, 'file.share.created', { file: file.id, share: share.id }, file.label, { kind: share.kind, user: share.user_id, group: share.group_name, workspace: share.workspace_id, expiresAt: share.expires_at, maxUses: share.max_uses, ...(share.anonymous ? { anonymous: true } : {}) });
    res.status(201).json({ ...(await describeShare(p.tenantId, share)), ...(token ? { token } : {}) });
  });

  r.delete('/files/:id/shares/:shareId', write, async (req, res) => {
    const { share, file } = await f.revokeShare(principalOf(req), parseBody(id26, req.params.id), parseBody(id26, req.params.shareId));
    await audit(req, 'file.share.revoked', { file: file.id, share: share.id }, file.label, { kind: share.kind });
    res.status(204).end();
  });

  // Link tokens travel in the body, never in a URL that proxies or logs could keep.
  r.post('/file-links/open', read, async (req, res) => {
    const { token } = parseBody(z.object({ token: z.string().regex(TOKEN) }).strict(), req.body);
    res.json(await f.openLink(principalOf(req), token));
  });

  r.post('/file-links/download', read, async (req, res) => {
    const { token } = parseBody(z.object({ token: z.string().regex(TOKEN) }).strict(), req.body);
    const { file, version, stream } = await f.useLink(token, { principal: principalOf(req) }, ip(req), req.traceId);
    await sendFile(res, { name: file.name, type: version.type, size: version.size, stream });
  });

  // ---------- storage quotas and usage (B-2403) ----------

  const quotaBody = z.object({ maxBytes: z.number().int().min(0).max(1e15).nullable() }).strict();

  r.get('/admin/usage/storage', noStore, requireAuth(), requirePermission(s, 'usage:read'), async (req, res) => {
    const p = principalOf(req);
    const workspaces = await s.tenants.workspaces(p.tenantId);
    res.json({ tenant: await f.storage(p.tenantId, null), workspaces: await Promise.all(workspaces.map(async (w) => ({ name: w.name, ...(await f.storage(p.tenantId, w.id)) }))) });
  });

  const manage = requirePermission(s, 'tenant:manage', (req) => ({ tenantId: String(req.params.tid) }));

  r.put('/admin/tenants/:tid/file-quota', noStore, requireAuth(), manage, async (req, res) => {
    const p = principalOf(req);
    if (!p.roles.includes('system-admin')) throw forbidden('Only a system admin can set the tenant total.', { step: 'role' });
    const t = await s.tenants.byId(parseBody(id26, req.params.tid));
    if (!t) throw notFound('Tenant');
    const { maxBytes } = parseBody(quotaBody, req.body);
    const before = await f.limit(t.id, null);
    await f.setLimit(t.id, null, maxBytes, p.userId);
    const e = { action: 'file.quota.updated', kind: 'admin' as const, actor: actorFrom(p, ip(req)), target: { tenant: t.id, scope: 'tenant' }, detail: { before: before.maxBytes, after: maxBytes }, traceId: req.traceId };
    await Promise.all([s.audit.append({ tenantId: t.id, ...e }), ...(t.id !== p.tenantId ? [s.audit.append({ tenantId: p.tenantId, ...e })] : [])]);
    res.json(await f.storage(t.id, null));
  });

  r.put('/admin/tenants/:tid/workspaces/:wid/file-quota', noStore, requireAuth(), manage, async (req, res) => {
    const p = principalOf(req);
    const w = await s.tenants.workspace(parseBody(id26, req.params.tid), parseBody(id26, req.params.wid));
    if (!w) throw notFound('Workspace');
    const { maxBytes } = parseBody(quotaBody, req.body);
    const tenant = await f.limit(w.tenant_id, null);
    if (maxBytes != null && tenant.maxBytes != null && maxBytes > tenant.maxBytes) throw badRequest(`The workspace limit cannot exceed the tenant limit of ${tenant.maxBytes} bytes.`);
    const before = await f.limit(w.tenant_id, w.id);
    await f.setLimit(w.tenant_id, w.id, maxBytes, p.userId);
    const e = { action: 'file.quota.updated', kind: 'admin' as const, actor: actorFrom(p, ip(req)), target: { tenant: w.tenant_id, scope: 'workspace', workspace: w.id }, detail: { before: before.maxBytes, after: maxBytes }, traceId: req.traceId };
    await Promise.all([s.audit.append({ tenantId: w.tenant_id, ...e }), ...(w.tenant_id !== p.tenantId ? [s.audit.append({ tenantId: p.tenantId, ...e })] : [])]);
    res.json(await f.storage(w.tenant_id, w.id));
  });

  return r;
}

/**
 * Anonymous file links (Sprint 26d, B-2402 on B-706's rules), at `/api/public`: no session, no cookie, rate-limited
 * per address in the shared counters (SHARE_ANONYMOUS_PER_MINUTE). There is no metadata route: the only thing an
 * anonymous holder can do is use the link, and every refusal is the same 404.
 */
export function publicFileRoutes(s: Services): Router {
  const r = Router();
  const limiter = new Limiter(s.counters, 'file-link-anon', s.cfg.SHARE_ANONYMOUS_PER_MINUTE, 60_000);
  r.post('/file-links/download', noStore, express.json({ limit: '4kb', strict: true }), async (req, res) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    const l = await limiter.consume(ip(req) ?? 'unknown');
    if (!l.allowed) throw tooManyRequests('Too many shared links opened from this address; try again in a minute.', l.resetMs / 1000);
    const { token } = parseBody(z.object({ token: z.string().regex(TOKEN) }).strict(), req.body);
    const { file, version, stream } = await s.files.useLink(token, { anonymous: true }, ip(req), req.traceId);
    await sendFile(res, { name: file.name, type: version.type, size: version.size, stream });
  });
  return r;
}

