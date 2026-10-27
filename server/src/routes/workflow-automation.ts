import { Router } from 'express';
import { z } from 'zod';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import type { Services } from '../services.js';

/**
 * 1.8.0, Sprint 46 (Automation): the webhook trigger of every workflow (B-130) and run retention (B-135). Every route
 * needs `workflows:manage` (the workflow admin's permission; a webhook's owner must also hold `agents:run`), acts in
 * the caller's tenant and workspace, and on workflows within the caller's clearance.
 *
 * - `GET /api/workflows/:id/hook`: on or off, the secret's age, the owner, counts, the URL, how to sign (with a curl
 *   example) and the last 20 deliveries. `PUT …/hook {enabled}`: on (the caller becomes the owner) or off.
 *   `POST …/hook/secret`: makes or rotates the secret, shown in this answer only (201).
 * - `GET/PUT /api/workflow-retention`: the tenant's policy (null falls back to the default).
 *   `GET/PUT /api/workflows/:id/retention`: a workflow's override (null falls back to the tenant's; all null removes
 *   it). `POST /api/workflow-retention/prune {dryRun, workflow?}`: prune now, or count what a prune would remove.
 */
const days = z.number().int().min(1).max(3650).nullable();
const policy = z.object({ runDays: days, failedDays: days, maxRuns: z.number().int().min(1).max(100_000).nullable() }).strict();

export function workflowAutomationRoutes(s: Services): Router {
  const r = Router();
  r.use(['/workflows', '/workflow-retention'], noStore, requireAuth());
  const manage = requirePermission(s, 'workflows:manage');
  const ctx = (req: Parameters<typeof ip>[0]) => ({ ip: ip(req), traceId: req.traceId });
  const id = (req: { params: Record<string, unknown> }) => parseBody(z.string().min(1).max(63), String(req.params.id));

  // ---------- B-130: the webhook trigger ----------

  r.get('/workflows/:id/hook', manage, async (req, res) => {
    res.json(await s.workflowHooks.status(principalOf(req), id(req)));
  });

  r.put('/workflows/:id/hook', manage, async (req, res) => {
    const body = parseBody(z.object({ enabled: z.boolean() }).strict(), req.body);
    res.json(await s.workflowHooks.setEnabled(principalOf(req), id(req), body.enabled, ctx(req)));
  });

  r.post('/workflows/:id/hook/secret', manage, async (req, res) => {
    parseBody(z.object({}).strict(), req.body ?? {});
    res.status(201).json(await s.workflowHooks.rotate(principalOf(req), id(req), ctx(req)));
  });

  // ---------- B-135: run retention ----------

  r.get('/workflow-retention', manage, async (req, res) => {
    res.json(await s.workflowRetention.tenantView(principalOf(req)));
  });

  r.put('/workflow-retention', manage, async (req, res) => {
    const body = parseBody(policy, req.body);
    res.json(await s.workflowRetention.setTenant(principalOf(req), body, ctx(req)));
  });

  r.post('/workflow-retention/prune', manage, async (req, res) => {
    const body = parseBody(z.object({ dryRun: z.boolean().default(true), workflow: z.string().min(1).max(63).optional() }).strict(), req.body ?? {});
    res.json(await s.workflowRetention.pruneNow(principalOf(req), { dryRun: body.dryRun, ...(body.workflow ? { workflow: body.workflow } : {}) }, ctx(req)));
  });

  r.get('/workflows/:id/retention', manage, async (req, res) => {
    res.json(await s.workflowRetention.workflowView(principalOf(req), id(req)));
  });

  r.put('/workflows/:id/retention', manage, async (req, res) => {
    const body = parseBody(policy, req.body);
    res.json(await s.workflowRetention.setWorkflow(principalOf(req), id(req), body, ctx(req)));
  });

  return r;
}
