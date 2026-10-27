import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { LABELS } from '../authz/labels.js';
import { ALBUM_KINDS, ALBUM_LIMITS, ALBUM_ROLES, type AuditCtx } from '../files/albums.js';
import { UPLOAD_LIMITS } from '../files/album-links.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { notFound } from '../http/problem.js';
import { sandboxHeaders } from '../media/origin.js';
import type { Services } from '../services.js';
import { contentDisposition, sendFile } from './files.js';
import { sendBytes } from './media.js';

const id26 = z.string().length(26);
const text = (max: number) => z.string().max(max).refine((t) => ![...t].some((c) => (c.charCodeAt(0) < 32 && c !== '\n') || c.charCodeAt(0) === 127), 'text without control characters');
const title = z.string().trim().min(1).max(ALBUM_LIMITS.title).refine((t) => ![...t].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127), 'a title without control characters');

/** Streams a zip to the client: an attachment, never cached, under the media sandbox. */
export async function sendZip(res: Response, name: string, stream: AsyncIterable<Buffer>): Promise<void> {
  sandboxHeaders(res);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', contentDisposition('attachment', name));
  res.setHeader('Cache-Control', 'private, no-store');
  await pipeline(Readable.from(stream), res);
}

/**
 * 1.9.0, Sprint 53 (B-177 to B-179): albums on Files. Reading needs `files:read`, changing `files:write`; what a person
 * may do in an album is their standing in it (`files/albums.ts`), and what they see of its items is the album's access
 * rule. Posting to the feed also needs `feed:write`; a group's albums also `groups:read`.
 */
export function albumRoutes(s: Services): Router {
  const r = Router();
  r.use(['/albums', '/groups/:gid/albums'], noStore, requireAuth());
  const read = requirePermission(s, 'files:read');
  const write = requirePermission(s, 'files:write');
  const al = () => s.files.albums;
  const ctx = (req: Request): AuditCtx => ({ ip: ip(req), traceId: req.traceId });

  r.get('/albums', read, async (req, res) => {
    const q = parseBody(z.object({ kind: z.enum(ALBUM_KINDS).optional(), workspace: id26.optional(), group: id26.optional() }), req.query);
    res.json(await al().list(principalOf(req), { ...(q.kind ? { kind: q.kind } : {}), ...(q.workspace ? { workspaceId: q.workspace } : {}), ...(q.group ? { groupId: q.group } : {}) }));
  });

  r.post('/albums', write, async (req, res) => {
    const body = parseBody(
      z.object({ kind: z.enum(ALBUM_KINDS), title, description: text(ALBUM_LIMITS.description).nullable().optional(), label: z.enum(LABELS).optional(), workspaceId: id26.optional(), groupId: id26.optional() }).strict().refine((b) => b.kind !== 'group' || !!b.groupId, 'groupId for a group album'),
      req.body
    );
    res.status(201).json(await al().create(principalOf(req), ctx(req), body));
  });

  r.get('/albums/:id', read, async (req, res) => {
    res.json(await al().detail(principalOf(req), parseBody(id26, req.params.id)));
  });

  r.patch('/albums/:id', write, async (req, res) => {
    const body = parseBody(z.object({ title: title.optional(), description: text(ALBUM_LIMITS.description).nullable().optional(), label: z.enum(LABELS).optional(), coverItemId: id26.nullable().optional() }).strict(), req.body);
    res.json(await al().update(principalOf(req), ctx(req), parseBody(id26, req.params.id), body));
  });

  r.delete('/albums/:id', write, async (req, res) => {
    await al().remove(principalOf(req), ctx(req), parseBody(id26, req.params.id));
    res.status(204).end();
  });

  r.get('/albums/:id/card', read, async (req, res) => {
    res.json(await al().card(principalOf(req), parseBody(id26, req.params.id)));
  });

  // ---------- items ----------

  r.post('/albums/:id/items', write, async (req, res) => {
    const { fileIds } = parseBody(z.object({ fileIds: z.array(id26).min(1).max(ALBUM_LIMITS.addPerCall) }).strict(), req.body);
    res.status(201).json(await al().addItems(principalOf(req), ctx(req), parseBody(id26, req.params.id), fileIds));
  });

  r.delete('/albums/:id/items/:itemId', write, async (req, res) => {
    res.json(await al().removeItem(principalOf(req), ctx(req), parseBody(id26, req.params.id), parseBody(id26, req.params.itemId)));
  });

  r.put('/albums/:id/order', write, async (req, res) => {
    const { itemIds } = parseBody(z.object({ itemIds: z.array(id26).min(1).max(ALBUM_LIMITS.items) }).strict(), req.body);
    res.json(await al().reorder(principalOf(req), ctx(req), parseBody(id26, req.params.id), itemIds));
  });

  /**
   * An item's preview (the grid), through the album's access rule. Where no preview was drawn (no renderer, a video),
   * the cleaned image itself is served instead, and audited as a download is.
   */
  r.get('/albums/:id/items/:itemId/preview', read, async (req, res) => {
    const p = principalOf(req);
    const acc = await al().require(p, parseBody(id26, req.params.id));
    const v = await al().visibleItem({ p }, acc, parseBody(id26, req.params.itemId));
    const pv = await s.files.previewCurrent(p.tenantId, v.file.id);
    if (pv) {
      sendBytes(req, res, pv.data, pv.type, 'inline');
      return;
    }
    const got = await s.files.servedCurrent(p.tenantId, v.file.id);
    if (!got) throw notFound('Preview');
    await al().audit(p, ctx(req), p.tenantId, 'file.downloaded', { file: v.file.id, version: got.version.number }, v.file.label, { via: `album:${acc.album.id}`, item: v.item.id, size: got.version.size, preview: 'none, served the file', ...(got.stripped ? { metadata: 'stripped' } : {}) });
    await sendFile(res, { name: v.file.name, type: got.version.type, size: got.size, stream: got.stream });
  });

  /** An item as served to readers (images without their metadata), through the album's access rule. Audited. */
  r.get('/albums/:id/items/:itemId/content', read, async (req, res) => {
    const p = principalOf(req);
    const acc = await al().require(p, parseBody(id26, req.params.id));
    const v = await al().visibleItem({ p }, acc, parseBody(id26, req.params.itemId));
    const got = await s.files.servedCurrent(p.tenantId, v.file.id);
    if (!got) throw notFound('File content');
    await al().audit(p, ctx(req), p.tenantId, 'file.downloaded', { file: v.file.id, version: got.version.number }, v.file.label, { via: `album:${acc.album.id}`, item: v.item.id, size: got.version.size, ...(got.stripped ? { metadata: 'stripped' } : {}) });
    await sendFile(res, { name: v.file.name, type: got.version.type, size: got.size, stream: got.stream });
  });

  /** The whole album (what the caller sees of it) as a zip, streamed. Audited. */
  r.get('/albums/:id/download', read, async (req, res) => {
    const out = await al().download(principalOf(req), ctx(req), parseBody(id26, req.params.id));
    await sendZip(res, out.name, out.stream);
  });

  // ---------- contributors ----------

  r.put('/albums/:id/contributors/:userId', write, async (req, res) => {
    const { role } = parseBody(z.object({ role: z.enum(ALBUM_ROLES) }).strict(), req.body);
    res.json(await al().setContributor(principalOf(req), ctx(req), parseBody(id26, req.params.id), parseBody(id26, req.params.userId), role));
  });

  r.delete('/albums/:id/contributors/:userId', write, async (req, res) => {
    res.json(await al().removeContributor(principalOf(req), ctx(req), parseBody(id26, req.params.id), parseBody(id26, req.params.userId)));
  });

  // ---------- B-179: the feed and groups ----------

  r.post('/albums/:id/post', write, requirePermission(s, 'feed:write'), async (req, res) => {
    const body = parseBody(z.object({ body: z.string().max(5000).optional(), visibility: z.enum(['workspace', 'unlisted', 'public']).optional() }).strict(), req.body ?? {});
    const view = (await al().post(principalOf(req), ctx(req), parseBody(id26, req.params.id), body)) as { state?: string };
    res.status(view.state === 'held' ? 202 : 201).json(view);
  });

  r.get('/groups/:gid/albums', read, requirePermission(s, 'groups:read'), async (req, res) => {
    res.json(await al().ofGroup(principalOf(req), parseBody(id26, req.params.gid)));
  });

  // ---------- B-178: share links ----------

  r.get('/albums/:id/share-links', read, async (req, res) => {
    res.json(await al().links.shares(principalOf(req), parseBody(id26, req.params.id)));
  });

  r.post('/albums/:id/share-links', write, async (req, res) => {
    const body = parseBody(z.object({ mode: z.enum(['view', 'download']).default('view'), expiresInHours: z.number().int().min(1).max(30 * 24).default(72), password: z.string().min(8).max(200).nullable().optional() }).strict(), req.body);
    res.status(201).json(await al().links.createShare(principalOf(req), ctx(req), parseBody(id26, req.params.id), body));
  });

  r.delete('/albums/:id/share-links/:linkId', write, async (req, res) => {
    await al().links.revokeShare(principalOf(req), ctx(req), parseBody(id26, req.params.id), parseBody(id26, req.params.linkId));
    res.status(204).end();
  });

  // ---------- B-178: upload links ----------

  r.get('/albums/:id/upload-links', read, async (req, res) => {
    res.json(await al().links.uploadLinks(principalOf(req), parseBody(id26, req.params.id)));
  });

  r.post('/albums/:id/upload-links', write, async (req, res) => {
    const body = parseBody(z.object({ expiresInHours: z.number().int().min(1).max(UPLOAD_LIMITS.maxHours).default(7 * 24), maxFiles: z.number().int().min(1).max(UPLOAD_LIMITS.maxFiles).default(50), maxBytes: z.number().int().min(1).max(1e12).nullable().optional(), folderId: id26.nullable().optional() }).strict(), req.body);
    res.status(201).json(await al().links.createUpload(principalOf(req), ctx(req), parseBody(id26, req.params.id), body));
  });

  r.delete('/albums/:id/upload-links/:linkId', write, async (req, res) => {
    await al().links.revokeUpload(principalOf(req), ctx(req), parseBody(id26, req.params.id), parseBody(id26, req.params.linkId));
    res.status(204).end();
  });

  r.get('/albums/:id/uploads', read, async (req, res) => {
    res.json(await al().links.uploads(principalOf(req), parseBody(id26, req.params.id)));
  });

  return r;
}
