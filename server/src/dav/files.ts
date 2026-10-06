import type { Request, Response } from 'express';
import { labelRank } from '../authz/labels.js';
import type { FileRow } from '../files/service.js';
import { HttpProblem } from '../http/problem.js';
import { sandboxHeaders } from '../media/origin.js';
import { contentDisposition, nameSchema } from '../routes/files.js';
import { audit, children, defaultFileLabel, fileByName, need, pathOf, resolve, type DavCtx, type Node } from './tree.js';
import { DavError } from './xml.js';

/*
 * The file store over WebDAV (B-3201 to B-3203): workspaces, folders and files as collections and resources. Every
 * operation is the file service's own, so membership, clearance, workspace ceilings, quotas and audit apply as on the
 * API:
 *
 * - PUT goes through quarantine, the type check and ClamAV like any upload (B-2401); the scan job is run before the
 *   answer when it can be (so a client can read back what it wrote), and until a version has passed it the file is not
 *   readable (GET answers 409). A rejected upload answers 415 (type) or 403 (malware, label). Each PUT on an existing
 *   file is a new version; old versions are kept.
 * - DELETE puts a file or folder in the trash (restorable from the console until it is purged).
 * - MOVE renames or moves within a workspace, keeping the file's or folder's id, so versions and shares stay; across
 *   workspaces it is refused (share the file instead). COPY makes new files whose content is scanned again.
 * - Files shared with the caller are under ~shared, read-only.
 * - Finder's AppleDouble files (`._*`), `.DS_Store`, `Thumbs.db` and `desktop.ini` are accepted and dropped: they are
 *   not content and would fail the type check.
 */

const JUNK = /^(\._.*|\.DS_Store|Thumbs\.db|desktop\.ini)$/i;
export const isJunk = (name: string): boolean => JUNK.test(name);

const write = (ctx: DavCtx, label?: Node['label']) => need(ctx, 'files:write', label);

/** File-store problems in DAV terms: a quota is 507 (RFC 4331 quota-not-exceeded). */
export function davProblem(err: unknown): never {
  if (err instanceof HttpProblem && err.extensions.limit === 'storage_bytes') throw new DavError(507, err.detail ?? 'Storage quota exceeded.', '{DAV:}quota-not-exceeded');
  throw err;
}

function checkName(name: string): string {
  const r = nameSchema.safeParse(name);
  if (!r.success) throw new DavError(400, 'The name is not allowed (no slashes, backslashes or control characters).');
  return r.data;
}

/** The workspace and folder a new member would go in, or a 409 when the parent is not a folder of the file store. */
export function folderParent(parent: Node | null): { ws: NonNullable<Node['ws']>; folderId: string | null } {
  if (!parent || (parent.kind !== 'workspace' && parent.kind !== 'folder')) throw new DavError(409, 'The parent is not a folder of the file store.');
  return { ws: parent.ws!, folderId: parent.folder?.id ?? null };
}

/** Streams a file's current version (shared files included), audited as a download. */
export async function readFile(ctx: DavCtx, req: Request, res: Response, n: Node): Promise<void> {
  const f = n.file!;
  if (f.current_version == null) throw new DavError(409, 'The file is still being scanned; it can be read once it has passed.');
  if (req.method === 'HEAD') {
    sandboxHeaders(res);
    res.status(200).setHeader('Content-Type', f.type ?? 'application/octet-stream');
    res.setHeader('Content-Length', String(f.size));
    res.setHeader('ETag', `"${n.etag}"`);
    res.setHeader('Last-Modified', new Date(f.updated_at).toUTCString());
    res.end();
    return;
  }
  const { file, version, stream, via } = await ctx.s.files.content(ctx.p, f.id).catch(davProblem);
  await audit(ctx, 'file.downloaded', { file: file.id, version: version.number }, { via: via === 'workspace' ? 'workspace' : `share:${via.kind}`, ...(via !== 'workspace' ? { share: via.id } : {}), size: version.size, dav: true }, version.label);
  sandboxHeaders(res);
  res.status(200).setHeader('Content-Type', version.type ?? 'application/octet-stream');
  res.setHeader('Content-Length', String(version.size));
  res.setHeader('Content-Disposition', contentDisposition('attachment', file.name));
  res.setHeader('ETag', `"${n.etag}"`);
  res.setHeader('Last-Modified', new Date(file.updated_at).toUTCString());
  for await (const c of stream) if (!res.write(c)) await new Promise((r) => res.once('drain', r));
  res.end();
}

async function drain(req: Request): Promise<void> {
  for await (const _ of req as AsyncIterable<Buffer>) void _;
}

/**
 * PUT of a file: a new file or a new version, through quarantine and the scan. Returns 201 or 204 and the new ETag
 * once the version is ready; the scan's refusal is the answer when it rejects the upload.
 */
export async function putFile(ctx: DavCtx, req: Request, parent: Node | null, name: string, existing: Node | null): Promise<{ status: number; etag: string | null }> {
  if (existing?.collection) throw new DavError(405, 'PUT does not replace a folder.');
  if (existing && existing.kind !== 'file') throw new DavError(405, 'Nothing can be stored here.');
  const { ws, folderId } = folderParent(parent);
  checkName(name);
  if (isJunk(name)) {
    await drain(req);
    return { status: 201, etag: null };
  }
  await write(ctx, existing?.label);
  const declaredType = req.header('content-type') ?? null;
  const len = Number(req.header('content-length') ?? NaN);
  const declaredBytes = Number.isFinite(len) && len >= 0 ? len : null;
  const s = ctx.s;
  const { file, version } = existing
    ? await s.files.uploadVersion(ctx.p, existing.file!.id, { declaredType, declaredBytes }, req).catch(davProblem)
    : await s.files.upload(ctx.p, { workspaceId: ws.id, folderId, name, label: defaultFileLabel(ctx.p, ws), declaredType, declaredBytes }, req).catch(davProblem);
  await audit(ctx, 'file.upload.received', { file: file.id, version: version.number, workspace: file.workspace_id }, { name: file.name, size: version.size, sha256: version.sha256, folder: file.folder_id, dav: true }, version.label);
  const v = await s.files.scanNow(version.id);
  if (v?.state === 'rejected') {
    const reason = v.reason ?? 'The upload was rejected.';
    throw new DavError(/malware|clearance|ceiling/i.test(reason) ? 403 : 415, reason);
  }
  const after = await fileByName(ctx, ws, folderId, name);
  return { status: existing ? 204 : 201, etag: v?.state === 'ready' && after ? (await resolve(ctx, [...parent!.segs, after.name]))?.etag ?? null : null };
}

export async function mkcolFile(ctx: DavCtx, parent: Node | null, name: string): Promise<void> {
  const { ws, folderId } = folderParent(parent);
  checkName(name);
  await write(ctx);
  const folder = await ctx.s.files.createFolder(ctx.p, { workspaceId: ws.id, parentId: folderId, name }).catch(davProblem);
  await audit(ctx, 'file.folder.created', { folder: folder.id, workspace: folder.workspace_id }, { name: folder.name, parent: folder.parent_id, dav: true });
}

/** DELETE: to the trash. Locks on the path go (locks stay with paths); dead properties stay for a restore. */
export async function deleteFileNode(ctx: DavCtx, n: Node): Promise<void> {
  if (n.kind === 'file') {
    await write(ctx, n.label);
    const f = await ctx.s.files.trashFile(ctx.p, n.file!.id);
    await audit(ctx, 'file.trashed', { file: f.id, workspace: f.workspace_id }, { name: f.name, purgeAfter: f.purge_after, dav: true }, f.label);
  } else if (n.kind === 'folder') {
    await write(ctx);
    const out = await ctx.s.files.trashFolder(ctx.p, n.folder!.id);
    await audit(ctx, 'file.folder.trashed', { folder: out.folder.id, workspace: out.folder.workspace_id }, { files: out.files, folders: out.folders, purgeAfter: out.folder.purge_after, dav: true });
  } else throw new DavError(403, 'Workspaces and the shared folder cannot be deleted over WebDAV.', '{DAV:}need-privileges');
  await ctx.s.dav.locks.dropAt(ctx.p.tenantId, pathOf(n.segs));
}

/** MOVE within a workspace: the same file or folder under a new name or parent (its id, versions and shares stay). */
export async function moveFileNode(ctx: DavCtx, src: Node, parent: Node | null, name: string): Promise<void> {
  const { ws, folderId } = folderParent(parent);
  checkName(name);
  if (src.kind !== 'file' && src.kind !== 'folder') throw new DavError(403, 'Only files and folders move.');
  if (src.ws?.id !== ws.id && src.file?.workspace_id !== ws.id) throw new DavError(403, 'Files and folders move within their workspace; share a file with another workspace instead.');
  await write(ctx, src.label);
  if (src.kind === 'file') {
    const { before, after } = await ctx.s.files.updateFile(ctx.p, src.file!.id, { name, folderId }).catch(davProblem);
    await audit(ctx, 'file.changed', { file: after.id, workspace: after.workspace_id }, { before: { name: before.name, folder: before.folder_id }, after: { name: after.name, folder: after.folder_id }, dav: true }, after.label);
  } else {
    const { before, after } = await ctx.s.files.updateFolder(ctx.p, src.folder!.id, { name, parentId: folderId }).catch(davProblem);
    await audit(ctx, 'file.folder.updated', { folder: after.id, workspace: after.workspace_id }, { before: { name: before.name, parent: before.parent_id }, after: { name: after.name, parent: after.parent_id }, dav: true });
  }
  await ctx.s.dav.locks.dropAt(ctx.p.tenantId, pathOf(src.segs));
}

async function copyFile(ctx: DavCtx, f: FileRow, ws: NonNullable<Node['ws']>, folderId: string | null, name: string, deadFrom: string | null): Promise<void> {
  if (f.current_version == null) throw new DavError(409, `${f.name} is still being scanned and cannot be copied yet.`);
  const { version, stream } = await ctx.s.files.content(ctx.p, f.id).catch(davProblem);
  // The copy keeps the label unless the destination workspace's ceiling is lower (then it is refused, as on upload).
  if (labelRank(version.label) > labelRank(ws.label_ceiling)) throw new DavError(403, `${ws.name}'s ceiling is ${ws.label_ceiling}; ${f.name} is ${version.label}.`);
  const { file, version: v } = await ctx.s.files.upload(ctx.p, { workspaceId: ws.id, folderId, name, label: version.label, declaredType: version.type, declaredBytes: version.size }, stream).catch(davProblem);
  await audit(ctx, 'file.upload.received', { file: file.id, version: v.number, workspace: file.workspace_id }, { name: file.name, size: v.size, sha256: v.sha256, folder: file.folder_id, copiedFrom: f.id, dav: true }, v.label);
  const done = await ctx.s.files.scanNow(v.id);
  if (done?.state === 'rejected') throw new DavError(415, done.reason ?? 'The copy was rejected by the scan.');
  if (deadFrom) await ctx.s.dav.store.copyProperties(ctx.p.tenantId, deadFrom, `file:${file.id}`);
}

/** COPY: files are uploaded again (and scanned); folders are copied with what is in them for Depth infinity. */
export async function copyFileNode(ctx: DavCtx, src: Node, parent: Node | null, name: string, depth: '0' | 'infinity'): Promise<void> {
  const { ws, folderId } = folderParent(parent);
  checkName(name);
  await write(ctx);
  if (src.kind === 'file') return copyFile(ctx, src.file!, ws, folderId, name, src.deadKey);
  if (src.kind !== 'folder' && src.kind !== 'workspace') throw new DavError(403, 'Only files and folders are copied.');
  const created = await ctx.s.files.createFolder(ctx.p, { workspaceId: ws.id, parentId: folderId, name }).catch(davProblem);
  await audit(ctx, 'file.folder.created', { folder: created.id, workspace: created.workspace_id }, { name: created.name, parent: created.parent_id, copiedFrom: src.folder?.id ?? null, dav: true });
  if (src.deadKey) await ctx.s.dav.store.copyProperties(ctx.p.tenantId, src.deadKey, `folder:${created.id}`);
  if (depth === '0') return;
  const target: Node = { ...src, kind: 'folder', ws, folder: created, segs: [...parent!.segs, name] };
  for (const k of await children(ctx, src)) await copyFileNode(ctx, k, target, k.segs[k.segs.length - 1]!, 'infinity');
}

/** Storage used and left for a workspace or folder: the workspace's and the tenant's limits, whichever is tighter. */
export async function quotaOf(ctx: DavCtx, n: Node): Promise<{ used: number; available: number | null } | null> {
  if (!n.ws) return null;
  const [w, t] = await Promise.all([ctx.s.files.storage(ctx.p.tenantId, n.ws.id), ctx.s.files.storage(ctx.p.tenantId, null)]);
  const left = [w, t].filter((x) => x.maxBytes != null).map((x) => x.maxBytes! - x.usedBytes);
  return { used: w.usedBytes, available: left.length ? Math.min(...left) : null };
}

