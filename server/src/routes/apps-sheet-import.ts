import { Router, type Request } from 'express';
import { z } from 'zod';
import { importSourceSchema, importSpecSchema, newEntitySchema, previewSchema, scheduleInputSchema } from '../apps/sheet-import.js';
import { transformsSchema } from '../apps/import-transforms.js';
import { entityView, type Actor } from '../apps/service.js';
import type { Principal } from '../authz/policy.js';
import { ip, parseBody, principalOf, requirePermission } from '../http/middleware.js';
import type { Services } from '../services.js';

const ref = z.string().min(1).max(63);
const id26 = z.string().length(26);

/**
 * Sprint 45 (B-127, B-129): imports into an app entity from a spreadsheet, JSON, pasted text or a connection, with
 * transformations, upsert by key, a downloadable error report, cancellation and scheduled re-imports
 * (`apps/sheet-import.ts`). Mounted inside `routes/apps.ts`, behind its `/apps` guards, before `/apps/:app`.
 *
 * Previewing and importing need `records:write`; "new entity from file" (inferring and creating) `apps:design`, and
 * the import that follows also `records:write` (the service checks it). A connection source needs
 * `connections:manage`, a saved query or REST endpoint whatever its own service asks; the file store and attachments
 * apply their own read checks.
 */
export function appSheetImportRoutes(s: Services): Router {
  const r = Router();
  const read = requirePermission(s, 'records:read');
  const write = requirePermission(s, 'records:write');
  const design = requirePermission(s, 'apps:design');
  const im = s.apps.sheetImport;
  const a = s.apps;
  const actor = (req: Request): Actor & { principal: Principal } => ({ principal: principalOf(req), source: 'api', ip: ip(req), traceId: req.traceId });
  const param = (req: Request, k: string) => parseBody(ref, req.params[k]);

  r.get('/apps/transfers/:id/errors', read, async (req, res) => {
    const out = await im.errorReport(actor(req), parseBody(id26, req.params.id));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${out.name.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(out.body);
  });

  r.post('/apps/transfers/:id/cancel', write, async (req, res) => {
    res.json(await im.cancel(actor(req), parseBody(id26, req.params.id)));
  });

  r.post('/apps/:app/imports/preview', write, async (req, res) => {
    res.json(await im.preview(actor(req), param(req, 'app'), parseBody(previewSchema, req.body)));
  });

  r.post('/apps/:app/imports/infer', design, async (req, res) => {
    const body = parseBody(z.object({ source: importSourceSchema, transforms: transformsSchema }).strict(), req.body);
    res.json(await im.infer(actor(req), param(req, 'app'), body));
  });

  r.post('/apps/:app/imports/entity', design, async (req, res) => {
    const out = await im.createWithImport(actor(req), param(req, 'app'), parseBody(newEntitySchema, req.body));
    res.status(201).json({ entity: entityView(out.entity), transfer: out.transfer });
  });

  r.post('/apps/:app/entities/:entity/imports', write, async (req, res) => {
    const body = parseBody(importSpecSchema.extend({ dryRun: z.boolean().default(true) }).strict(), req.body);
    const { app, entity } = await a.resolve(principalOf(req), param(req, 'app'), param(req, 'entity'));
    const { dryRun, ...spec } = body;
    res.status(202).json(await im.submit(actor(req), app, entity, spec, { dryRun }));
  });

  // ---------- scheduled re-imports from connections (B-129) ----------

  r.get('/apps/:app/entities/:entity/import-schedules', read, async (req, res) => {
    const { app, entity } = await a.resolve(principalOf(req), param(req, 'app'), param(req, 'entity'));
    res.json(await im.schedules(principalOf(req), app, entity));
  });

  r.post('/apps/:app/entities/:entity/import-schedules', write, async (req, res) => {
    const { app, entity } = await a.resolve(principalOf(req), param(req, 'app'), param(req, 'entity'));
    res.status(201).json(await im.createSchedule(actor(req), app, entity, parseBody(scheduleInputSchema, req.body)));
  });

  r.patch('/apps/:app/import-schedules/:id', write, async (req, res) => {
    const body = parseBody(z.object({ cron: z.string().trim().min(9).max(100).optional(), enabled: z.boolean().optional() }).strict(), req.body);
    const app = await a.app(principalOf(req), param(req, 'app'));
    res.json(await im.updateSchedule(actor(req), app, parseBody(id26, req.params.id), body));
  });

  r.delete('/apps/:app/import-schedules/:id', write, async (req, res) => {
    const app = await a.app(principalOf(req), param(req, 'app'));
    await im.removeSchedule(actor(req), app, parseBody(id26, req.params.id));
    res.status(204).end();
  });

  r.post('/apps/:app/import-schedules/:id/run', write, async (req, res) => {
    const app = await a.app(principalOf(req), param(req, 'app'));
    res.status(202).json(await im.runSchedule(actor(req), app, parseBody(id26, req.params.id)));
  });

  return r;
}
