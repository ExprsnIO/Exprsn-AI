import { Router, type Request } from 'express';
import { z } from 'zod';
import type { CloudActor } from '../../cloud/accounts.js';
import { DEPLOYMENT_STATES } from '../../cloud/graph.js';
import { applyPlanSchema, createPlanSchema } from '../../cloud/planner.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission, requireRecentAuth } from '../../http/middleware.js';
import type { Services } from '../../services.js';

/*
 * 1.9.99-final, Sprint 57 (B-10102 to B-10105): deployments, their graphs, plans, the operation journal and verify
 * (`cloud/deployments.ts`, `cloud/planner.ts`, `cloud/journal.ts`, `cloud/apply.ts`, `cloud/verify.ts`). Reads need
 * `cloud:read`; plans, applies and verifies `cloud:deploy`, and a platform deployment also `platform:manage` (checked
 * in the service). Applying needs a recent sign-in. Without migration 148 every route answers 503 `migration_pending`.
 * Creating a deployment from a spec is the deployment spec work's route (B-10201), over `s.cloud.deployments.create`.
 *
 *   GET  /admin/cloud/deployments                               ?accountId=&state=&kind=cloud|onprem
 *   GET  /admin/cloud/deployments/:id
 *   GET  /admin/cloud/deployments/:id/graph                     resources and dependency edges
 *   GET  /admin/cloud/deployments/:id/plans
 *   POST /admin/cloud/deployments/:id/plans                     { desired: DesiredResource[] } → 201 the plan
 *   GET  /admin/cloud/deployments/:id/plans/:planId
 *   POST /admin/cloud/deployments/:id/plans/:planId/apply       { hash } → 202 { plan, job }; 409 plan_stale with a fresh plan
 *   GET  /admin/cloud/deployments/:id/operations                ?planId=&key=&after=&limit=  the journal
 *   POST /admin/cloud/deployments/:id/verify                    202 { job }
 */

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
const actorOf = (req: Request): CloudActor => ({ principal: principalOf(req), ip: ip(req), traceId: req.traceId });

export function cloudDeploymentRoutes(s: Services): Router {
  const r = Router();
  const read = [noStore, requireAuth(), requirePermission(s, 'cloud:read')];
  const deploy = [noStore, requireAuth(), requirePermission(s, 'cloud:deploy')];
  const fresh = [noStore, requireAuth({ sessionOnly: true }), requirePermission(s, 'cloud:deploy'), requireRecentAuth(s)];
  const dep = () => s.cloud.deployments;
  const plans = () => s.cloud.plans;

  r.get('/cloud/deployments', ...read, async (req, res) => {
    // Sprint 62 (B-10209): `kind=onprem` lists the on-prem installs registered for their front door.
    const q = parseBody(z.object({ accountId: id26.optional(), state: z.enum(DEPLOYMENT_STATES).optional(), kind: z.enum(['cloud', 'onprem']).optional() }).strict(), req.query);
    const list = await dep().list(principalOf(req), q);
    res.json({ deployments: list, installed: true });
  });

  r.get('/cloud/deployments/:id', ...read, async (req, res) => {
    const p = principalOf(req);
    const d = await dep().getFor(p, parseBody(id26, req.params.id));
    const current = d.currentPlanId ? await plans().get(d.currentPlanId) : null;
    res.json({ ...d, currentPlan: current ? { id: current.id, hash: current.hash, state: current.state, summary: current.summary, expiresAt: current.expiresAt } : null });
  });

  r.get('/cloud/deployments/:id/graph', ...read, async (req, res) => {
    res.json(await dep().graph(principalOf(req), parseBody(id26, req.params.id)));
  });

  r.get('/cloud/deployments/:id/plans', ...read, async (req, res) => {
    const q = parseBody(z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }).strict(), req.query);
    res.json({ plans: await plans().list(principalOf(req), parseBody(id26, req.params.id), q.limit ?? 50) });
  });

  r.post('/cloud/deployments/:id/plans', ...deploy, async (req, res) => {
    const body = parseBody(createPlanSchema, req.body);
    res.status(201).json(await plans().create(actorOf(req), parseBody(id26, req.params.id), body.desired));
  });

  r.get('/cloud/deployments/:id/plans/:planId', ...read, async (req, res) => {
    res.json(await plans().getFor(principalOf(req), parseBody(id26, req.params.id), parseBody(id26, req.params.planId)));
  });

  r.post('/cloud/deployments/:id/plans/:planId/apply', ...fresh, async (req, res) => {
    const body = parseBody(applyPlanSchema, req.body);
    const deploymentId = parseBody(id26, req.params.id);
    const planId = parseBody(id26, req.params.planId);
    await plans().getFor(principalOf(req), deploymentId, planId);
    const out = await plans().apply(actorOf(req), planId, body.hash);
    res.status(202).json({ plan: out.plan, job: { id: out.jobId, type: 'cloud.apply' } });
  });

  r.get('/cloud/deployments/:id/operations', ...read, async (req, res) => {
    const q = parseBody(z.object({ planId: id26.optional(), key: z.string().max(63).optional(), after: id26.optional(), limit: z.coerce.number().int().min(1).max(2000).optional() }).strict(), req.query);
    const d = await dep().getFor(principalOf(req), parseBody(id26, req.params.id));
    const ops = await s.cloud.journal.list(d.id, { ...(q.planId ? { planId: q.planId } : {}), ...(q.key ? { key: q.key } : {}), ...(q.after ? { after: q.after } : {}), limit: q.limit ?? 500 });
    res.json({ operations: ops });
  });

  r.post('/cloud/deployments/:id/verify', ...deploy, async (req, res) => {
    const p = principalOf(req);
    const d = await dep().getFor(p, parseBody(id26, req.params.id));
    dep().assertCanDeploy(p, d);
    const job = await s.jobs.enqueue({ tenantId: d.tenantId, type: 'cloud.verify', payload: { deploymentId: d.id }, createdBy: p.userId, dedupeKey: `cloud.verify:${d.id}:${Math.floor(Date.now() / 10_000)}`, maxAttempts: 2 });
    res.status(202).json({ job: { id: job.id, type: 'cloud.verify', state: job.state } });
  });

  return r;
}
