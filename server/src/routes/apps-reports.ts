import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { exportInputSchema, exportView } from '../apps/exports.js';
import { reportDefinitionSchema } from '../apps/report-engine.js';
import { reportInputSchema, reportPatchSchema, runInputSchema } from '../apps/reports.js';
import type { Actor } from '../apps/service.js';
import type { Principal } from '../authz/policy.js';
import { ip, parseBody, principalOf, requirePermission } from '../http/middleware.js';
import type { Services } from '../services.js';

const ref = z.string().min(1).max(63);
const id26 = z.string().length(26);

/**
 * 1.8.0, Sprint 44: reports (B-122) and exports (B-123) of an app. Mounted inside `routes/apps.ts`, behind its `/apps`
 * guards (authentication, app-scoped credentials).
 *
 * - Listing, reading and running reports, their run history and cached results, and every export need
 *   `records:read`: a run and an export read as the caller, with their row policies, masks and clearance. A report
 *   over a saved query or a REST endpoint also needs `connections:query`, which the service checks (403), because the
 *   rows come from that read API as the caller.
 * - Creating, changing, deleting and previewing a report need `apps:design` (and the app's label within the
 *   designer's clearance, which the service checks).
 */
export function appReportRoutes(s: Services): Router {
  const r = Router();
  const read = requirePermission(s, 'records:read');
  const design = requirePermission(s, 'apps:design');
  const reports = s.appReports;
  const exportsSvc = s.appExports;
  const actor = (req: Request): Actor & { principal: Principal } => ({ principal: principalOf(req), source: 'api', ip: ip(req), traceId: req.traceId });
  const param = (req: Request, k: string) => parseBody(ref, req.params[k]);
  const send = (res: Response, f: { filename: string; contentType: string; bytes: Buffer }) => {
    res.setHeader('Content-Type', f.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${f.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.send(f.bytes);
  };

  // ---------- reports (B-122) ----------

  r.get('/apps/:app/reports', read, async (req, res) => {
    res.json(await reports.list(principalOf(req), param(req, 'app')));
  });

  r.post('/apps/:app/reports', design, async (req, res) => {
    res.status(201).json(await reports.create(actor(req), param(req, 'app'), parseBody(reportInputSchema, req.body)));
  });

  /** The designer's live preview of a draft definition: the first 200 rows, as the designer, not recorded. */
  r.post('/apps/:app/reports/preview', design, async (req, res) => {
    const body = parseBody(z.object({ definition: reportDefinitionSchema, params: runInputSchema.shape.params }).strict(), req.body);
    res.json(await reports.preview(actor(req), param(req, 'app'), body.definition, body.params));
  });

  r.get('/apps/:app/reports/:report', read, async (req, res) => {
    res.json(await reports.get(principalOf(req), param(req, 'app'), param(req, 'report')));
  });

  r.patch('/apps/:app/reports/:report', design, async (req, res) => {
    res.json(await reports.update(actor(req), param(req, 'app'), param(req, 'report'), parseBody(reportPatchSchema, req.body)));
  });

  r.delete('/apps/:app/reports/:report', design, async (req, res) => {
    await reports.remove(actor(req), param(req, 'app'), param(req, 'report'));
    res.status(204).end();
  });

  r.post('/apps/:app/reports/:report/run', read, async (req, res) => {
    res.json(await reports.run(actor(req), param(req, 'app'), param(req, 'report'), parseBody(runInputSchema, req.body ?? {})));
  });

  /** The caller's runs (`all=1`: a designer sees everyone's). */
  r.get('/apps/:app/reports/:report/runs', read, async (req, res) => {
    const q = parseBody(z.object({ all: z.enum(['0', '1']).optional() }).strict(), req.query);
    res.json(await reports.runs(principalOf(req), param(req, 'app'), param(req, 'report'), q.all === '1'));
  });

  r.get('/apps/:app/reports/:report/runs/:run', read, async (req, res) => {
    res.json(await reports.runResult(principalOf(req), param(req, 'app'), param(req, 'report'), parseBody(id26, req.params.run)));
  });

  // ---------- exports (B-123) ----------

  /** A direct download of a small export (at most 5000 rows; more is a 409 asking for the job). */
  r.post('/apps/:app/exports/download', read, async (req, res) => {
    const body = parseBody(exportInputSchema, req.body);
    const app = await s.apps.app(principalOf(req), param(req, 'app'));
    send(res, await exportsSvc.download(actor(req), app, body));
  });

  /** Queues an export as the job apps.export-file; poll it, then download the file. */
  r.post('/apps/:app/exports', read, async (req, res) => {
    const body = parseBody(exportInputSchema, req.body);
    const app = await s.apps.app(principalOf(req), param(req, 'app'));
    res.status(202).json(await exportsSvc.request(actor(req), app, body));
  });

  r.get('/apps/:app/exports', read, async (req, res) => {
    const p = principalOf(req);
    res.json(await exportsSvc.list(p, await s.apps.app(p, param(req, 'app'))));
  });

  r.get('/apps/:app/exports/:id', read, async (req, res) => {
    const p = principalOf(req);
    res.json(exportView(await exportsSvc.get(p, await s.apps.app(p, param(req, 'app')), parseBody(id26, req.params.id))));
  });

  r.get('/apps/:app/exports/:id/download', read, async (req, res) => {
    const p = principalOf(req);
    send(res, await exportsSvc.file(actor(req), await s.apps.app(p, param(req, 'app')), parseBody(id26, req.params.id)));
  });

  return r;
}
