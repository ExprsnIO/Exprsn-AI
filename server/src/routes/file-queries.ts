import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { LABELS, type Label } from '../authz/labels.js';
import { FileQueries, queryView } from '../files/documents/queries-service.js';
import { MAX_STEPS } from '../files/documents/query.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import type { Services } from '../services.js';
import { nameSchema } from './files.js';

const id26 = z.string().length(26);
const upto = z.number().int().min(0).max(MAX_STEPS).optional();

/**
 * Files: the table builder (Power Query style). Previews run a query definition as the caller over the files it
 * names; saved queries live in a workspace and load their result into a spreadsheet file, a new one or a sheet of an
 * existing one, and refresh it later. Reading needs `files:read`, saving, loading and refreshing `files:write`; every
 * read of a file goes through the file store as the caller, and every change is audited.
 *
 *   GET    /api/files/:id/tables                  the sheets of a file and their column names
 *   POST   /api/files/queries/preview             { definition, upto?, offset?, limit?, queryId? } → a page of the result
 *   POST   /api/files/queries/values              { definition, upto?, column } → the column's distinct values
 *   POST   /api/files/queries/detect              { definition, upto? } → each column's detected type
 *   GET    /api/files/queries?workspace=          saved queries of a workspace
 *   POST   /api/files/queries                     { name, description?, definition, workspaceId? }
 *   GET    /api/files/queries/:qid
 *   PATCH  /api/files/queries/:qid                { name?, description?, definition? }
 *   DELETE /api/files/queries/:qid
 *   POST   /api/files/queries/:qid/load           { target } → writes the result, keeps the place
 *   POST   /api/files/queries/:qid/refresh        writes the result again where it was last loaded
 */
export function fileQueryRoutes(s: Services): Router {
  const r = Router();
  r.use('/files', noStore, requireAuth());
  const read = requirePermission(s, 'files:read');
  const write = requirePermission(s, 'files:write');
  const q = new FileQueries(() => s);

  const audit = (req: Request, action: string, target: Record<string, unknown>, label?: Label, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, ...(label ? { label } : {}), ...(detail ? { detail } : {}), traceId: req.traceId });
  };

  const runBody = { definition: z.unknown(), upto, queryId: id26.optional() };

  r.get('/files/:id/tables', read, async (req, res) => {
    res.json(await q.tables(principalOf(req), parseBody(id26, req.params.id)));
  });

  r.post('/files/queries/preview', read, async (req, res) => {
    const b = parseBody(z.object({ ...runBody, offset: z.number().int().min(0).max(10_000_000).optional(), limit: z.number().int().min(1).max(1000).optional() }).strict(), req.body);
    res.json(await q.preview(principalOf(req), { ...b, self: b.queryId }));
  });

  r.post('/files/queries/values', read, async (req, res) => {
    const b = parseBody(z.object({ ...runBody, column: z.string().min(1).max(200) }).strict(), req.body);
    res.json(await q.values(principalOf(req), { ...b, self: b.queryId }));
  });

  r.post('/files/queries/detect', read, async (req, res) => {
    const b = parseBody(z.object(runBody).strict(), req.body);
    res.json(await q.detect(principalOf(req), { ...b, self: b.queryId }));
  });

  r.get('/files/queries', read, async (req, res) => {
    const ws = parseBody(id26.optional(), typeof req.query.workspace === 'string' && req.query.workspace ? req.query.workspace : undefined);
    res.json(await q.list(principalOf(req), ws ?? null));
  });

  const meta = { name: z.string().trim().min(1).max(200), description: z.string().max(2000).nullable().optional() };

  r.post('/files/queries', write, async (req, res) => {
    const b = parseBody(z.object({ ...meta, definition: z.unknown(), workspaceId: id26.optional() }).strict(), req.body);
    const row = await q.create(principalOf(req), b);
    await audit(req, 'file.query.created', { query: row.id, workspace: row.workspace_id }, row.label, { name: row.name });
    res.status(201).json(queryView(row));
  });

  r.get('/files/queries/:qid', read, async (req, res) => {
    res.json(queryView(await q.row(principalOf(req), parseBody(id26, req.params.qid))));
  });

  r.patch('/files/queries/:qid', write, async (req, res) => {
    const b = parseBody(z.object({ name: meta.name.optional(), description: meta.description, definition: z.unknown().optional() }).strict(), req.body);
    const { before, after } = await q.update(principalOf(req), parseBody(id26, req.params.qid), b);
    await audit(req, 'file.query.updated', { query: after.id, workspace: after.workspace_id }, after.label, { name: after.name, ...(before.name !== after.name ? { renamedFrom: before.name } : {}), definition: b.definition !== undefined });
    res.json(queryView(after));
  });

  r.delete('/files/queries/:qid', write, async (req, res) => {
    const row = await q.remove(principalOf(req), parseBody(id26, req.params.qid));
    await audit(req, 'file.query.deleted', { query: row.id, workspace: row.workspace_id }, row.label, { name: row.name });
    res.status(204).end();
  });

  const target = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('new'), name: nameSchema, kind: z.enum(['xlsx', 'csv', 'ods']).default('xlsx'), folderId: id26.nullable().optional(), sheet: z.string().trim().min(1).max(31).optional(), label: z.enum(LABELS).optional() }).strict(),
    z.object({ mode: z.literal('existing'), fileId: id26, sheet: z.string().trim().min(1).max(31).optional() }).strict()
  ]);

  const loaded = async (req: Request, action: string, out: Awaited<ReturnType<FileQueries['loadTo']>>) => {
    await audit(req, action, { query: out.query.id, file: out.file.id, workspace: out.query.workspace_id }, out.label, { name: out.query.name, sheet: out.sheet, kind: out.kind, rows: out.rows, version: out.version, created: out.created });
    return { query: queryView(out.query), file: out.file, version: out.version, versionState: out.versionState, sheet: out.sheet, kind: out.kind, rows: out.rows, warnings: out.warnings, created: out.created };
  };

  r.post('/files/queries/:qid/load', write, async (req, res) => {
    const b = parseBody(z.object({ target }).strict(), req.body);
    const out = await q.loadTo(principalOf(req), parseBody(id26, req.params.qid), b.target);
    res.status(202).json(await loaded(req, 'file.query.loaded', out));
  });

  r.post('/files/queries/:qid/refresh', write, async (req, res) => {
    const out = await q.refresh(principalOf(req), parseBody(id26, req.params.qid));
    res.status(202).json(await loaded(req, 'file.query.refreshed', out));
  });

  return r;
}
