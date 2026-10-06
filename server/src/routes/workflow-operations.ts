import { Router } from 'express';
import { z } from 'zod';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import type { Services } from '../services.js';
import { bindingsSchema } from '../workflows/bundles.js';

const name = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Lower-case letters, digits and hyphens');
const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'An id');

/**
 * Sprint 32b (1.5.0): workflow triggers, dead letters and bundles.
 *
 * - B-3903: the trigger a workflow's published version starts runs with (event or schedule) and its recent firings
 *   (`agents:run`, as reading a workflow); turning it off and on again (`workflows:manage`).
 * - B-3906: the dead-letter view of failed runs and their redrive (`workflows:manage`).
 * - B-3909: signed export and import of a workflow (`exprsn-workflow/1`, `workflows:manage`); a bundle changed after
 *   signing is refused with `422 Bundle refused`.
 */
export function workflowOperationRoutes(s: Services): Router {
  const r = Router();
  r.use(['/workflows', '/workflow-dead-letters'], noStore, requireAuth());
  const run = requirePermission(s, 'agents:run');
  const manage = requirePermission(s, 'workflows:manage');
  const ctx = (req: Parameters<typeof ip>[0]) => ({ ip: ip(req), traceId: req.traceId });

  // ---------- B-3909: bundles ----------

  r.post('/workflows/import', manage, async (req, res) => {
    const body = parseBody(z.object({ bundle: z.unknown(), name: name.optional(), bindings: bindingsSchema.optional() }).strict(), req.body);
    res.status(201).json(await s.workflowBundles.import(principalOf(req), body.bundle, { ...(body.name ? { name: body.name } : {}), ...(body.bindings ? { bindings: body.bindings } : {}) }, ctx(req)));
  });

  r.get('/workflows/:id/bundle', manage, async (req, res) => {
    const bundle = await s.workflowBundles.export(principalOf(req), String(req.params.id), ctx(req));
    res.setHeader('Content-Disposition', `attachment; filename="${bundle.workflow.name}.workflow.json"`);
    res.json(bundle);
  });

  // ---------- B-3903: triggers ----------

  r.get('/workflows/:id/triggers', run, async (req, res) => {
    const q = parseBody(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    res.json(await s.workflowTriggers.view(principalOf(req), String(req.params.id), q.limit));
  });

  r.patch('/workflows/:id/triggers', manage, async (req, res) => {
    const body = parseBody(z.object({ enabled: z.boolean() }).strict(), req.body);
    res.json(await s.workflowTriggers.setEnabled(principalOf(req), String(req.params.id), body.enabled, ctx(req)));
  });

  // ---------- B-3906: dead letters ----------

  r.get('/workflow-dead-letters', manage, async (req, res) => {
    const q = parseBody(z.object({ state: z.enum(['open', 'redriven']).optional(), workflow: z.string().min(1).max(63).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }).strict(), req.query);
    res.json({ items: await s.workflowDeadLetters.list(principalOf(req), q) });
  });

  r.post('/workflow-dead-letters/:id/redrive', manage, async (req, res) => {
    res.status(201).json(await s.workflowDeadLetters.redrive(principalOf(req), parseBody(id26, req.params.id), ctx(req)));
  });

  return r;
}
