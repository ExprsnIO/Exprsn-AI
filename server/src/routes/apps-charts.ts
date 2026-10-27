import { Router, type Request } from 'express';
import { z } from 'zod';
import { chartDefinitionSchema, chartInputSchema, chartPatchSchema } from '../apps/charts.js';
import { dashboardInputSchema, dashboardPatchSchema, filterValuesSchema } from '../apps/dashboards.js';
import type { Actor } from '../apps/service.js';
import type { Principal } from '../authz/policy.js';
import { badRequest } from '../http/problem.js';
import { ip, parseBody, principalOf, requirePermission } from '../http/middleware.js';
import type { Services } from '../services.js';

const ref = z.string().min(1).max(63);
const id26 = z.string().length(26);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const appliedSchema = z
  .array(z.object({ id: z.string().min(1).max(31), kind: z.enum(['date', 'value']), field: z.string().min(1).max(70), from: day.nullable().optional(), to: day.nullable().optional(), value: z.union([z.string().max(200), z.number(), z.boolean(), z.null()]).optional() }).strict())
  .max(6);

/**
 * 1.8.0, Sprint 44: charts (B-120) and dashboards (B-121) of an app. Mounted inside `routes/apps.ts`, behind its
 * `/apps` guards (authentication, app-scoped credentials). Every route needs `records:read`, like saved views: anyone
 * who reads an app's records may keep private charts and dashboards. The services check the rest: sharing one with
 * the app's readers, or changing someone else's shared one, needs `apps:design` and the app's label within the
 * designer's clearance; a chart over a saved query or a REST endpoint needs `connections:query` to save, and each
 * reader needs it (and clearance for the source's label) to see it computed. Everything is computed as the caller.
 */
export function appChartRoutes(s: Services): Router {
  const r = Router();
  const read = requirePermission(s, 'records:read');
  const charts = s.apps.charts;
  const dashboards = s.apps.dashboards;
  const actor = (req: Request): Actor & { principal: Principal } => ({ principal: principalOf(req), source: 'api', ip: ip(req), traceId: req.traceId });
  const app = (req: Request) => parseBody(ref, req.params.app);

  // ---------- charts ----------

  r.get('/apps/:app/charts', read, async (req, res) => {
    res.json(await charts.list(principalOf(req), app(req)));
  });

  r.post('/apps/:app/charts', read, async (req, res) => {
    res.status(201).json(await charts.create(actor(req), app(req), parseBody(chartInputSchema, req.body)));
  });

  /** The builder's live preview: an unsaved definition computed as the caller (never cached). */
  r.post('/apps/:app/charts/preview', read, async (req, res) => {
    const body = parseBody(z.object({ name: z.string().trim().max(100).default('Preview'), definition: chartDefinitionSchema }).strict(), req.body);
    res.json({ state: 'ok', data: await charts.preview(principalOf(req), app(req), body.name || 'Preview', body.definition) });
  });

  r.get('/apps/:app/charts/:chart', read, async (req, res) => {
    res.json(await charts.get(principalOf(req), app(req), parseBody(id26, req.params.chart)));
  });

  r.patch('/apps/:app/charts/:chart', read, async (req, res) => {
    res.json(await charts.update(actor(req), app(req), parseBody(id26, req.params.chart), parseBody(chartPatchSchema, req.body)));
  });

  r.delete('/apps/:app/charts/:chart', read, async (req, res) => {
    await charts.remove(actor(req), app(req), parseBody(id26, req.params.chart));
    res.status(204).end();
  });

  r.get('/apps/:app/charts/:chart/versions', read, async (req, res) => {
    res.json(await charts.versions(principalOf(req), app(req), parseBody(id26, req.params.chart)));
  });

  /** The chart's series as the caller may see them: `{ state: ok | unavailable | error }`. */
  r.post('/apps/:app/charts/:chart/data', read, async (req, res) => {
    const body = parseBody(z.object({ filters: appliedSchema.default([]), fresh: z.boolean().default(false) }).strict(), req.body ?? {});
    res.json(await charts.data(principalOf(req), app(req), parseBody(id26, req.params.chart), body));
  });

  // ---------- dashboards ----------

  r.get('/apps/:app/dashboards', read, async (req, res) => {
    res.json(await dashboards.list(principalOf(req), app(req)));
  });

  r.post('/apps/:app/dashboards', read, async (req, res) => {
    res.status(201).json(await dashboards.create(actor(req), app(req), parseBody(dashboardInputSchema, req.body)));
  });

  r.get('/apps/:app/dashboards/:dashboard', read, async (req, res) => {
    res.json(await dashboards.get(principalOf(req), app(req), parseBody(id26, req.params.dashboard)));
  });

  r.patch('/apps/:app/dashboards/:dashboard', read, async (req, res) => {
    res.json(await dashboards.update(actor(req), app(req), parseBody(id26, req.params.dashboard), parseBody(dashboardPatchSchema, req.body)));
  });

  r.delete('/apps/:app/dashboards/:dashboard', read, async (req, res) => {
    await dashboards.remove(actor(req), app(req), parseBody(id26, req.params.dashboard));
    res.status(204).end();
  });

  /** Every card computed as the caller, with the dashboard's filters set to `filters` (else their defaults). */
  r.post('/apps/:app/dashboards/:dashboard/data', read, async (req, res) => {
    const body = parseBody(z.object({ filters: filterValuesSchema.optional(), fresh: z.boolean().default(false) }).strict(), req.body ?? {});
    res.json(await dashboards.data(principalOf(req), app(req), parseBody(id26, req.params.dashboard), body));
  });

  /** A static HTML or PDF snapshot computed as the caller (`?format=html|pdf&filters=<JSON>`), audited. */
  r.get('/apps/:app/dashboards/:dashboard/render', read, async (req, res) => {
    const format = parseBody(z.enum(['html', 'pdf']).default('pdf'), req.query.format ?? undefined);
    let filters: unknown;
    if (typeof req.query.filters === 'string' && req.query.filters) {
      try {
        filters = JSON.parse(req.query.filters);
      } catch {
        throw badRequest('filters is a JSON object.');
      }
    }
    const p = principalOf(req);
    // The app reference is checked as the caller first: a dashboard of another app is not found here.
    const a = await s.apps.app(p, app(req));
    const id = parseBody(id26, req.params.dashboard);
    await dashboards.get(p, a.id, id);
    const out = await dashboards.render(p, id, { format, ...(filters !== undefined ? { filters: parseBody(filterValuesSchema, filters) } : {}), ip: ip(req), traceId: req.traceId ?? null });
    res.setHeader('Content-Type', out.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(out.bytes);
  });

  return r;
}
