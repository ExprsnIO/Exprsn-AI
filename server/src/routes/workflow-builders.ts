import { Router } from 'express';
import { z } from 'zod';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { HttpProblem } from '../http/problem.js';
import type { Services } from '../services.js';
import { rangeSchema } from '../workflows/analytics.js';
import { preview, presetView, previewSchema, SCHEDULE_PRESETS, ScheduleError } from '../workflows/schedules.js';
import { listQuerySchema, saveTemplateSchema, templateBindingsSchema, updateTemplateSchema, useTemplateSchema } from '../workflows/templates.js';

/**
 * 1.8.0, Sprint 47 (Builders' tools): the workflow template gallery (B-136), schedule presets and the next-runs
 * preview (B-138), and workflow analytics with the "running now" board (B-139). The permissions are the workflow
 * ones the designer already uses:
 *
 * - `agents:run` (every member; what reading a workflow and its run history needs): browse the gallery and preview a
 *   template, list schedule presets and preview a schedule's next runs, a workflow's analytics, the tenant summary and
 *   the running-now board. Analytics and the board count only workflows the caller may open and runs within their
 *   clearance, and only their own runs unless they also hold `workflows:manage`, exactly like the run history.
 * - `workflows:manage` (the workflow admin, who may create workflows): the binding choices and check, "use template"
 *   (it creates a workflow), "save as template", and changing or deleting a tenant template. Built-in templates cannot
 *   be changed.
 *
 * Tenant and workspace come from the session; every change is audited (`workflow.template.saved`, `.updated`,
 * `.deleted`, `.used`).
 */
export function workflowBuilderRoutes(s: Services): Router {
  const r = Router();
  r.use(['/workflow-templates', '/workflow-schedules', '/workflow-analytics', '/workflow-activity'], noStore, requireAuth());
  const run = requirePermission(s, 'agents:run');
  const manage = requirePermission(s, 'workflows:manage');
  const ctx = (req: Parameters<typeof ip>[0]) => ({ ip: ip(req), traceId: req.traceId });
  const id = (req: { params: Record<string, unknown> }) => parseBody(z.string().min(1).max(63), String(req.params.id));

  // ---------- B-136: templates ----------

  r.get('/workflow-templates', run, async (req, res) => {
    res.json(await s.workflowTemplates.list(principalOf(req), parseBody(listQuerySchema, req.query)));
  });

  /** What each kind of reference can be bound to here (the use-template dialog's choices). */
  r.get('/workflow-templates/options', manage, async (req, res) => {
    res.json(await s.workflowTemplates.options(principalOf(req)));
  });

  r.post('/workflow-templates', manage, async (req, res) => {
    res.status(201).json(await s.workflowTemplates.save(principalOf(req), parseBody(saveTemplateSchema, req.body), ctx(req)));
  });

  r.get('/workflow-templates/:id', run, async (req, res) => {
    res.json(await s.workflowTemplates.view(principalOf(req), id(req)));
  });

  r.patch('/workflow-templates/:id', manage, async (req, res) => {
    res.json(await s.workflowTemplates.update(principalOf(req), id(req), parseBody(updateTemplateSchema, req.body), ctx(req)));
  });

  r.delete('/workflow-templates/:id', manage, async (req, res) => {
    await s.workflowTemplates.remove(principalOf(req), id(req), ctx(req));
    res.status(204).end();
  });

  /** Every reference the template needs, with the given bindings: bound, missing, or started on publish. */
  r.post('/workflow-templates/:id/check', manage, async (req, res) => {
    const body = parseBody(z.object({ bindings: templateBindingsSchema.optional() }).strict(), req.body ?? {});
    res.json(await s.workflowTemplates.check(principalOf(req), id(req), body.bindings ?? {}));
  });

  /** Creates a draft workflow from the template in the current workspace (201), reporting each binding. */
  r.post('/workflow-templates/:id/use', manage, async (req, res) => {
    res.status(201).json(await s.workflowTemplates.use(principalOf(req), id(req), parseBody(useTemplateSchema, req.body), ctx(req)));
  });

  // ---------- B-138: schedules ----------

  r.get('/workflow-schedules/presets', run, async (_req, res) => {
    res.json({ presets: SCHEDULE_PRESETS.map(presetView) });
  });

  /** The next runs of a cron or preset in a time zone; a schedule that cannot run is 422 with the reason in plain words. */
  r.post('/workflow-schedules/preview', run, async (req, res) => {
    const body = parseBody(previewSchema, req.body);
    try {
      res.json(preview(body));
    } catch (err) {
      if (err instanceof ScheduleError) throw new HttpProblem(422, 'Schedule not valid', err.message);
      throw err;
    }
  });

  // ---------- B-139: analytics ----------

  r.get('/workflow-analytics', run, async (req, res) => {
    res.json(await s.workflowAnalytics.summary(principalOf(req), parseBody(rangeSchema, req.query)));
  });

  r.get('/workflow-analytics/:id', run, async (req, res) => {
    res.json(await s.workflowAnalytics.workflow(principalOf(req), id(req), parseBody(rangeSchema, req.query)));
  });

  /** The running-now board: queued, running and waiting runs with age, current step and owner. */
  r.get('/workflow-activity', run, async (req, res) => {
    const q = parseBody(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), workflow: z.string().min(1).max(63).optional() }).strict(), req.query);
    res.json(await s.workflowAnalytics.running(principalOf(req), q));
  });

  return r;
}
