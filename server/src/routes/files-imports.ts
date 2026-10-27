import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { LABELS } from '../authz/labels.js';
import { FileImports, IMPORT_KINDS, type Imported } from '../files/imports.js';
import { fileView, versionView } from '../files/service.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import type { Services } from '../services.js';
import { nameSchema } from './files.js';

const id26 = z.string().length(26);
/** Run and entry ids are ULIDs in this repository; workflows and knowledge documents too. Kept loose for older ids. */
const anyId = z.string().trim().min(1).max(64);
const target = { name: nameSchema.optional(), folderId: id26.nullable().optional(), workspaceId: id26.optional(), label: z.enum(LABELS).optional() };

/**
 * 2.0.0: imports into Files from elsewhere (`files/imports.ts`). Every route needs `files:write`; each source also
 * asks its own permission inside the service (connections, knowledge, agents, workflows, registry). Each import is
 * audited `file.imported` with where it came from, beside the source's own audit (a connection's query, a bundle's
 * export). Mounted before `fileRoutes`.
 */
export function fileImportRoutes(s: Services): Router {
  const r = Router();
  r.use('/files/import', noStore, requireAuth());
  const read = requirePermission(s, 'files:read');
  const write = requirePermission(s, 'files:write');
  const imports = new FileImports(() => s);
  const ctx = (req: Request) => ({ ip: ip(req), traceId: req.traceId });

  const done = async (req: Request, res: Response, out: Imported) => {
    const p = principalOf(req);
    await s.audit.append({ tenantId: p.tenantId, action: 'file.imported', kind: 'admin', actor: actorFrom(p, ip(req)), target: { file: out.file.id, version: out.version.number, workspace: out.file.workspace_id }, label: out.version.label, detail: { name: out.file.name, size: out.version.size, sha256: out.version.sha256, ...out.detail }, traceId: req.traceId });
    res.status(202).json({ ...fileView(out.file), version: versionView(out.version) });
  };

  r.post('/files/import/url', write, async (req, res) => {
    const b = parseBody(z.object({ url: z.string().trim().min(8).max(4096), ...target }).strict(), req.body);
    await done(req, res, await imports.url(principalOf(req), b));
  });

  r.post('/files/import/database', write, async (req, res) => {
    const b = parseBody(
      z.object({ connectionId: id26.optional(), object: z.string().trim().min(1).max(200).optional(), sql: z.string().trim().min(1).max(20_000).optional(), savedQueryId: anyId.optional(), params: z.record(z.string(), z.unknown()).optional(), format: z.enum(['csv', 'xlsx', 'json']).default('csv'), ...target }).strict(),
      req.body
    );
    await done(req, res, await imports.database(principalOf(req), b, ctx(req)));
  });

  r.post('/files/import/knowledge', write, async (req, res) => {
    const b = parseBody(z.object({ documentId: anyId, as: z.enum(['original', 'text', 'markdown']).default('markdown'), ...target }).strict(), req.body);
    await done(req, res, await imports.knowledge(principalOf(req), b));
  });

  r.post('/files/import/agent-run', write, async (req, res) => {
    const b = parseBody(z.object({ runId: anyId, format: z.enum(['markdown', 'json']).default('markdown'), ...target }).strict(), req.body);
    await done(req, res, await imports.agentRun(principalOf(req), b));
  });

  r.post('/files/import/workflow-run', write, async (req, res) => {
    const b = parseBody(z.object({ runId: anyId, format: z.enum(['markdown', 'json']).default('markdown'), ...target }).strict(), req.body);
    await done(req, res, await imports.workflowRun(principalOf(req), b));
  });

  r.post('/files/import/workflow', write, async (req, res) => {
    const b = parseBody(z.object({ workflowId: anyId, ...target }).strict(), req.body);
    await done(req, res, await imports.workflow(principalOf(req), b, ctx(req)));
  });

  r.post('/files/import/skill', write, async (req, res) => {
    const b = parseBody(z.object({ skillId: anyId, ...target }).strict(), req.body);
    await done(req, res, await imports.skill(principalOf(req), b));
  });

  r.post('/files/import/tool', write, async (req, res) => {
    const b = parseBody(z.object({ toolId: anyId, ...target }).strict(), req.body);
    await done(req, res, await imports.tool(principalOf(req), b));
  });

  r.get('/files/import/sources', read, async (req, res) => {
    const q = parseBody(z.object({ kind: z.enum(IMPORT_KINDS), q: z.string().trim().max(200).optional(), connection: id26.optional() }).strict(), req.query);
    res.json(await imports.sources(principalOf(req), q.kind, { ...(q.q ? { q: q.q } : {}), ...(q.connection ? { connection: q.connection } : {}) }));
  });

  return r;
}
