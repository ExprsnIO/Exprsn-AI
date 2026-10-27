import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { LABELS, type Label } from '../authz/labels.js';
import { effectivePermissions } from '../authz/policy.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { badRequest } from '../http/problem.js';
import { USER_TYPES, WORKSPACE_TYPES } from '../memory/service.js';
import type { Services } from '../services.js';

const TABS = ['mine', 'workspace', 'agents'] as const;
const expiresAt = z.number().int().min(0).nullable();

/**
 * Memory: the caller's own memories, their current workspace's (curators change them; members propose) and agents'.
 * Everything needs `memory:write`; writes pass the memory checkpoint and are audited, and forgetting deletes the
 * memory from every backend.
 */
export function memoryRoutes(s: Services): Router {
  const r = Router();
  r.use(['/memory'], noStore, requireAuth());
  const mem = requirePermission(s, 'memory:write');
  const m = s.memory;

  const audit = (req: Request, action: string, target: Record<string, unknown>, label: Label, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, label, ...(detail ? { detail } : {}), traceId: req.traceId });
  };

  r.get('/memory', mem, async (req, res) => {
    const p = principalOf(req);
    const q = parseBody(z.object({ tab: z.enum(TABS).default('mine') }), req.query);
    const ws = p.workspaceId ? await s.tenants.workspace(p.tenantId, p.workspaceId) : undefined;
    res.json({
      tab: q.tab,
      items: await m.list(p, q.tab),
      counts: await m.counts(p),
      curator: effectivePermissions(p).has('knowledge:manage'),
      workspace: ws ? { id: ws.id, name: ws.name, labelCeiling: ws.label_ceiling } : null,
      backend: m.backend,
      policy: { restricted: false, types: { mine: USER_TYPES, workspace: WORKSPACE_TYPES } }
    });
  });

  // ---------- settings, consolidation and reindex (Sprint 30, B-3701 to B-3703; knowledge curators) ----------

  const curate = requirePermission(s, 'knowledge:manage');
  const settingsView = async (tenantId: string) => ({ ...(await m.settings(tenantId)), embeddingModels: await m.embeddingModels() });

  r.get('/memory/settings', curate, async (req, res) => {
    res.json(await settingsView(principalOf(req).tenantId));
  });

  r.put('/memory/settings', curate, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(
      z
        .object({
          profile: z.string().trim().min(1).max(200).nullable().optional(),
          embedModel: z.string().trim().min(1).max(200).nullable().optional(),
          similarity: z.number().min(0.5).max(0.99).optional(),
          staleDays: z.number().int().min(1).max(3650).nullable().optional()
        })
        .strict(),
      req.body
    );
    await m.setSettings(p, ip(req), req.traceId, body);
    res.json(await settingsView(p.tenantId));
  });

  r.post('/memory/consolidate', curate, async (req, res) => {
    res.status(202).json(await m.requestConsolidation(principalOf(req), ip(req), req.traceId));
  });

  r.post('/memory/reindex', curate, async (req, res) => {
    const p = principalOf(req);
    await m.startReindex(p, ip(req), req.traceId);
    res.status(202).json(await settingsView(p.tenantId));
  });

  r.get('/memory/:id', mem, async (req, res) => {
    const p = principalOf(req);
    res.json(await m.view(p, await m.visible(p, String(req.params.id))));
  });

  r.post('/memory', mem, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ text: z.string().trim().min(1).max(2000), scope: z.enum(['user', 'workspace']).default('user'), type: z.string().trim().min(1).max(30).optional(), label: z.enum(LABELS).default('internal'), expiresAt: expiresAt.default(null) }).strict(), req.body);
    const allowed: readonly string[] = body.scope === 'user' ? USER_TYPES : WORKSPACE_TYPES;
    const type = body.type ?? allowed[0]!;
    if (!allowed.includes(type)) throw badRequest(`A ${body.scope} memory is one of: ${allowed.join(', ')}.`);
    if (body.expiresAt != null && body.expiresAt <= Date.now()) throw badRequest('The expiry is in the past.');
    const row = await m.add(p, { ...body, type });
    await audit(req, row.state === 'proposed' ? 'memory.proposed' : 'memory.added', { memory: row.id, scope: row.scope }, row.label, { type: row.type });
    res.status(201).json(await m.view(p, row));
  });

  r.patch('/memory/:id', mem, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ text: z.string().trim().min(1).max(2000).optional(), label: z.enum(LABELS).optional(), expiresAt: expiresAt.optional() }).strict(), req.body);
    const out = await m.edit(p, String(req.params.id), body);
    if (out.changed.length) await audit(req, 'memory.edited', { memory: out.memory.id, scope: out.memory.scope }, out.memory.label, { changed: out.changed, version: out.memory.version });
    res.json(await m.view(p, out.memory));
  });

  r.post('/memory/:id/accept', mem, async (req, res) => {
    const p = principalOf(req);
    const { memory: row, replaced } = await m.accept(p, String(req.params.id));
    await audit(req, 'memory.accepted', { memory: row.id, scope: row.scope }, row.label);
    if (replaced.length) await audit(req, 'memory.merged', { memory: row.id, replaced, scope: row.scope }, row.label);
    res.json(await m.view(p, row));
  });

  r.post('/memory/:id/reject', mem, async (req, res) => {
    const row = await m.reject(principalOf(req), String(req.params.id));
    await audit(req, 'memory.rejected', { memory: row.id, scope: row.scope }, row.label);
    res.json({ id: row.id, state: 'rejected' });
  });

  for (const decision of ['accept', 'reject'] as const) {
    r.post(`/memory/:id/expiry/${decision}`, mem, async (req, res) => {
      const p = principalOf(req);
      const out = await m.decideExpiry(p, String(req.params.id), decision);
      await audit(req, decision === 'accept' ? 'memory.expiry.accepted' : 'memory.expiry.rejected', { memory: out.memory.id, scope: out.memory.scope }, out.memory.label, { reason: out.proposal.reason, by: out.proposal.by });
      res.json(await m.view(p, out.memory));
    });
  }

  r.delete('/memory/:id', mem, async (req, res) => {
    const p = principalOf(req);
    const row = await m.visible(p, String(req.params.id), 'write');
    const out = await m.forget(row);
    await m.auditForget(p, ip(req), req.traceId, row, out);
    res.json({ id: row.id, ...out });
  });

  // ---------- export ----------

  r.post('/memory/exports', mem, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ tab: z.enum(TABS).default('mine'), format: z.enum(['json', 'csv']).default('json') }).strict(), req.body);
    const out = await m.requestExport(p, body.tab, body.format);
    await audit(req, 'memory.export.requested', { export: out.id, tab: body.tab }, p.clearance, { format: body.format });
    res.status(202).json(out);
  });

  r.get('/memory/exports/:id', mem, async (req, res) => {
    const e = await m.exportRow(principalOf(req), String(req.params.id));
    res.json({ id: e.id, file: e.file, state: e.state, rows: e.rows, label: e.label, format: e.format, createdAt: Number(e.created_at) });
  });

  r.get('/memory/exports/:id/download', mem, async (req, res) => {
    const p = principalOf(req);
    const e = await m.exportRow(p, String(req.params.id));
    const data = await m.exportContent(p.tenantId, e);
    await audit(req, 'memory.export.downloaded', { export: e.id }, e.label ?? 'internal');
    res.setHeader('Content-Disposition', `attachment; filename="${e.file}"`);
    res.type(e.format === 'json' ? 'application/json' : 'text/csv').send(data);
  });

  return r;
}
