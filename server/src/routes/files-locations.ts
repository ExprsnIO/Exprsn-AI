import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { LABELS, type Label } from '../authz/labels.js';
import { LOCATION_KINDS } from '../files/locations/model.js';
import { localRootView } from '../files/locations/service.js';
import { fileView, versionView } from '../files/service.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission, requireRecentAuth } from '../http/middleware.js';
import type { Services } from '../services.js';

const id26 = z.string().length(26);
const name = z.string().trim().min(1).max(120).refine((n) => ![...n].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127), 'a name without control characters');

/**
 * 2.0.0: linked storage locations in Files (`files/locations/`). Browsing needs `files:read`, copying in and out
 * `files:write`, and adding, changing, testing or removing a location (which holds credentials) `files:link`. Local
 * stores are offered by operators (`platform:manage`) under `/api/admin/storage/local-roots`. Mounted before
 * `fileRoutes`; every change and copy is audited, and secrets never appear in an answer or the audit.
 */
export function fileLocationRoutes(s: Services): Router {
  const r = Router();
  r.use(['/files/locations', '/files/local-roots'], noStore, requireAuth());
  const read = requirePermission(s, 'files:read');
  const write = requirePermission(s, 'files:write');
  const link = requirePermission(s, 'files:link');
  const loc = () => s.files.locations;

  const audit = (req: Request, action: string, target: Record<string, unknown>, label?: Label, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, ...(label ? { label } : {}), ...(detail ? { detail } : {}), traceId: req.traceId });
  };

  r.get('/files/locations', read, async (req, res) => {
    const q = parseBody(z.object({ workspace: id26.optional() }), req.query);
    res.json(await loc().list(principalOf(req), q.workspace ?? null));
  });

  r.get('/files/local-roots', link, async (req, res) => {
    const roots = await loc().localRootsFor(principalOf(req).tenantId);
    // A tenant learns the name and whether it is read-only, never the server's path.
    res.json(roots.map((x) => ({ id: x.id, name: x.name, readOnly: x.read_only })));
  });

  r.post('/files/locations/test', link, async (req, res) => {
    const b = parseBody(z.object({ kind: z.enum(LOCATION_KINDS), config: z.unknown(), secret: z.unknown().optional() }).strict(), req.body);
    res.json(await loc().testUnsaved(principalOf(req), b));
  });

  r.post('/files/locations', link, async (req, res) => {
    const b = parseBody(z.object({ workspaceId: id26.optional(), name, kind: z.enum(LOCATION_KINDS), config: z.unknown(), secret: z.unknown().optional(), label: z.enum(LABELS).default('internal'), readOnly: z.boolean().optional() }).strict(), req.body);
    const row = await loc().create(principalOf(req), b);
    await audit(req, 'file.location.created', { location: row.id, workspace: row.workspace_id }, row.label, { name: row.name, kind: row.kind, config: row.config, readOnly: row.read_only, credentials: !!row.secret_sealed });
    res.status(201).json(await loc().view(row));
  });

  r.patch('/files/locations/:id', link, async (req, res) => {
    const b = parseBody(z.object({ name: name.optional(), config: z.unknown().optional(), secret: z.unknown().optional(), label: z.enum(LABELS).optional(), readOnly: z.boolean().optional() }).strict(), req.body);
    const { before, after } = await loc().update(principalOf(req), parseBody(id26, req.params.id), b);
    await audit(req, 'file.location.updated', { location: after.id, workspace: after.workspace_id }, after.label, { before: { name: before.name, config: before.config, label: before.label, readOnly: before.read_only }, after: { name: after.name, config: after.config, label: after.label, readOnly: after.read_only }, credentialsChanged: before.secret_sealed !== after.secret_sealed });
    res.json(await loc().view(after));
  });

  r.delete('/files/locations/:id', link, async (req, res) => {
    const l = await loc().remove(principalOf(req), parseBody(id26, req.params.id));
    await audit(req, 'file.location.removed', { location: l.id, workspace: l.workspace_id }, l.label, { name: l.name, kind: l.kind });
    res.status(204).end();
  });

  r.post('/files/locations/:id/test', link, async (req, res) => {
    const id = parseBody(id26, req.params.id);
    const out = await loc().test(principalOf(req), id);
    if ('pinned' in out && out.pinned) await audit(req, 'file.location.host-key.pinned', { location: id }, undefined, { hostKey: out.hostKey });
    res.json(out);
  });

  r.get('/files/locations/:id/browse', read, async (req, res) => {
    const q = parseBody(z.object({ path: z.string().max(1024).default(''), cursor: z.string().max(2000).optional() }), req.query);
    res.json(await loc().browse(principalOf(req), parseBody(id26, req.params.id), q.path, q.cursor ?? null));
  });

  r.post('/files/locations/:id/import', write, async (req, res) => {
    const b = parseBody(z.object({ paths: z.array(z.string().min(1).max(1024)).min(1).max(1000), folderId: id26.nullable().optional(), label: z.enum(LABELS).optional() }).strict(), req.body);
    const id = parseBody(id26, req.params.id);
    const out = await loc().importFiles(principalOf(req), id, b);
    if ('jobId' in out) {
      await audit(req, 'file.location.import.requested', { location: id, job: out.jobId }, b.label, { paths: b.paths.slice(0, 50), count: b.paths.length, folder: b.folderId ?? null });
      res.status(202).json({ jobId: out.jobId });
    } else {
      const f = out.files[0]!;
      await audit(req, 'file.location.imported', { location: id, file: f.id, workspace: f.workspace_id }, f.label, { path: b.paths[0], files: 1 });
      res.status(202).json({ files: out.files.map((x, i) => ({ ...fileView(x), version: versionView(out.versions[i]!) })) });
    }
  });

  r.post('/files/:id/send', write, async (req, res) => {
    const b = parseBody(z.object({ locationId: id26, path: z.string().min(1).max(1024).nullable().optional() }).strict(), req.body);
    const out = await loc().send(principalOf(req), parseBody(id26, req.params.id), b);
    await audit(req, 'file.location.sent', { file: out.file.id, version: out.version.number, location: out.location.id }, out.version.label, { path: out.path, size: out.size, sha256: out.version.sha256, ...(out.etag ? { etag: out.etag } : {}), ...(out.cid ? { cid: out.cid } : {}) });
    res.json({ path: out.path, size: out.size, etag: out.etag ?? null, cid: out.cid ?? null, location: { id: out.location.id, name: out.location.name } });
  });

  // ---------- local stores (operators) ----------

  const manage = [noStore, requireAuth(), requirePermission(s, 'platform:manage')];
  const session = [noStore, requireAuth({ sessionOnly: true }), requirePermission(s, 'platform:manage'), requireRecentAuth(s)];
  const rootBody = z.object({ name, path: z.string().trim().min(1).max(1024), readOnly: z.boolean().default(true), tenants: z.array(id26).max(500).nullable().default(null) }).strict();
  const opAudit = (req: Request, action: string, target: Record<string, unknown>, detail: Record<string, unknown>) => audit(req, action, target, undefined, detail);

  r.get('/admin/storage/local-roots', ...manage, async (_req, res) => {
    res.json((await loc().localRoots()).map(localRootView));
  });

  r.post('/admin/storage/local-roots', ...session, async (req, res) => {
    const b = parseBody(rootBody, req.body);
    const row = await loc().addLocalRoot(principalOf(req).userId, b);
    await opAudit(req, 'storage.local-root.created', { root: row.id }, { name: row.name, path: row.path, readOnly: row.read_only, tenants: row.tenants });
    res.status(201).json(localRootView(row));
  });

  r.patch('/admin/storage/local-roots/:id', ...session, async (req, res) => {
    const b = parseBody(rootBody.partial().strict(), req.body);
    const { before, after } = await loc().updateLocalRoot(parseBody(id26, req.params.id), b);
    await opAudit(req, 'storage.local-root.updated', { root: after.id }, { before: localRootView(before), after: localRootView(after) });
    res.json(localRootView(after));
  });

  r.delete('/admin/storage/local-roots/:id', ...session, async (req, res) => {
    const row = await loc().removeLocalRoot(parseBody(id26, req.params.id));
    await opAudit(req, 'storage.local-root.removed', { root: row.id }, { name: row.name, path: row.path });
    res.status(204).end();
  });

  return r;
}
