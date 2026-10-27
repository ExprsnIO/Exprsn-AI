import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { CloudActor } from '../../cloud/accounts.js';
import { approvalSchema, destroySchema } from '../../cloud/destroy.js';
import { decideSchema, DRIFT_STATES } from '../../cloud/drift.js';
import { ORPHAN_STATES } from '../../cloud/orphans.js';
import { RESOURCE_KEY } from '../../cloud/graph.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission, requireRecentAuth } from '../../http/middleware.js';
import type { Services } from '../../services.js';

/*
 * 1.9.99-final, Sprint 57 (B-10106, B-10107): drift findings and their decisions, destroy with the second admin's
 * approval of protected resources, rollback, and the orphans of a deployment's account (`cloud/drift.ts`,
 * `cloud/destroy.ts`, `cloud/orphans.ts`). Reads need `cloud:read`; drift decisions, sweeps and adoptions
 * `cloud:deploy`; destroy and rollback `cloud:deploy` with a recent sign-in; approving or refusing the deletion of a
 * protected resource and deleting an orphan `cloud:admin` with a recent sign-in. A platform deployment also needs
 * `platform:manage` (checked in the services). A revert applied at once needs a recent sign-in too. Without migration
 * 149 every route answers 503 `migration_pending` (without 148, the deployments' own 503).
 *
 *   GET  /admin/cloud/deployments/:id/drift                                  ?state=  the findings
 *   POST /admin/cloud/deployments/:id/drift/check                            reads the provider now
 *   POST /admin/cloud/deployments/:id/drift/:findingId/decide                { decision: revert|adopt|ignore, note?, apply? }
 *   GET  /admin/cloud/deployments/:id/destroy                                the deployment's destroys
 *   POST /admin/cloud/deployments/:id/destroy                                { reason? } → 202 { destroy, job }
 *   POST /admin/cloud/deployments/:id/destroy/:destroyId/protected/:key/approve   { note? } (a second cloud admin)
 *   POST /admin/cloud/deployments/:id/destroy/:destroyId/protected/:key/reject    { note? }
 *   POST /admin/cloud/deployments/:id/destroy/:destroyId/cancel
 *   POST /admin/cloud/deployments/:id/rollback                               → 202 { plan, job }
 *   GET  /admin/cloud/deployments/:id/orphans                                ?state=
 *   POST /admin/cloud/deployments/:id/orphans/sweep
 *   POST /admin/cloud/deployments/:id/orphans/:orphanId/adopt
 *   POST /admin/cloud/deployments/:id/orphans/:orphanId/ignore
 *   POST /admin/cloud/deployments/:id/orphans/:orphanId/delete
 */

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
const key = z.string().regex(RESOURCE_KEY, 'a resource key');
const actorOf = (req: Request): CloudActor => ({ principal: principalOf(req), ip: ip(req), traceId: req.traceId });

export function cloudLifecycleRoutes(s: Services): Router {
  const r = Router();
  const read = [noStore, requireAuth(), requirePermission(s, 'cloud:read')];
  const deploy = [noStore, requireAuth(), requirePermission(s, 'cloud:deploy')];
  const freshDeploy = [noStore, requireAuth({ sessionOnly: true }), requirePermission(s, 'cloud:deploy'), requireRecentAuth(s)];
  const freshAdmin = [noStore, requireAuth({ sessionOnly: true }), requirePermission(s, 'cloud:admin'), requireRecentAuth(s)];
  const admin = [noStore, requireAuth(), requirePermission(s, 'cloud:admin')];
  const life = () => s.cloud.lifecycle;
  const recent = async (req: Request, res: Response) => {
    await requireAuth({ sessionOnly: true })(req, res, () => undefined);
    await requireRecentAuth(s)(req, res, () => undefined);
  };

  // ---------- drift (B-10106) ----------

  r.get('/cloud/deployments/:id/drift', ...read, async (req, res) => {
    const q = parseBody(z.object({ state: z.enum(DRIFT_STATES).optional() }).strict(), req.query);
    res.json({ findings: await life().drift.findings(principalOf(req), parseBody(id26, req.params.id), q) });
  });

  r.post('/cloud/deployments/:id/drift/check', ...deploy, async (req, res) => {
    const p = principalOf(req);
    await life().schema.need();
    const d = await s.cloud.deployments.getFor(p, parseBody(id26, req.params.id));
    s.cloud.deployments.assertCanDeploy(p, d);
    const out = await life().drift.detect(d);
    res.json({ checked: out.checked, findings: out.open, fresh: out.fresh.map((f) => f.id), resolved: out.resolved });
  });

  r.post('/cloud/deployments/:id/drift/:findingId/decide', ...deploy, async (req, res) => {
    const body = parseBody(decideSchema, req.body);
    if (body.decision === 'revert' && body.apply) await recent(req, res);
    const out = await life().drift.decide(actorOf(req), parseBody(id26, req.params.id), parseBody(id26, req.params.findingId), body);
    res.json({ finding: out.finding, plan: out.plan, job: out.jobId ? { id: out.jobId, type: 'cloud.apply' } : null });
  });

  // ---------- destroy and rollback (B-10107) ----------

  r.get('/cloud/deployments/:id/destroy', ...read, async (req, res) => {
    res.json({ destroys: await life().destroys.list(principalOf(req), parseBody(id26, req.params.id)) });
  });

  r.post('/cloud/deployments/:id/destroy', ...freshDeploy, async (req, res) => {
    const body = parseBody(destroySchema, req.body ?? {});
    const out = await life().destroys.request(actorOf(req), parseBody(id26, req.params.id), body);
    res.status(202).json({ destroy: out.destroy, job: { id: out.jobId, type: 'cloud.destroy' } });
  });

  r.post('/cloud/deployments/:id/destroy/:destroyId/protected/:key/approve', ...freshAdmin, async (req, res) => {
    const body = parseBody(approvalSchema, req.body ?? {});
    const out = await life().destroys.approve(actorOf(req), parseBody(id26, req.params.id), parseBody(id26, req.params.destroyId), parseBody(key, req.params.key), body.note ?? null);
    res.json({ destroy: out.destroy, job: out.jobId ? { id: out.jobId, type: 'cloud.destroy' } : null });
  });

  r.post('/cloud/deployments/:id/destroy/:destroyId/protected/:key/reject', ...admin, async (req, res) => {
    const body = parseBody(approvalSchema, req.body ?? {});
    res.json({ destroy: await life().destroys.reject(actorOf(req), parseBody(id26, req.params.id), parseBody(id26, req.params.destroyId), parseBody(key, req.params.key), body.note ?? null) });
  });

  r.post('/cloud/deployments/:id/destroy/:destroyId/cancel', ...deploy, async (req, res) => {
    res.json({ destroy: await life().destroys.cancel(actorOf(req), parseBody(id26, req.params.id), parseBody(id26, req.params.destroyId)) });
  });

  r.post('/cloud/deployments/:id/rollback', ...freshDeploy, async (req, res) => {
    await life().schema.need();
    const out = await life().destroys.rollback(actorOf(req), parseBody(id26, req.params.id));
    res.status(202).json({ plan: out.plan, job: out.jobId ? { id: out.jobId, type: 'cloud.apply' } : null });
  });

  // ---------- orphans (B-10107) ----------

  r.get('/cloud/deployments/:id/orphans', ...read, async (req, res) => {
    const q = parseBody(z.object({ state: z.enum(ORPHAN_STATES).optional() }).strict(), req.query);
    res.json({ orphans: await life().orphans.forDeployment(principalOf(req), parseBody(id26, req.params.id), q) });
  });

  r.post('/cloud/deployments/:id/orphans/sweep', ...deploy, async (req, res) => {
    const p = principalOf(req);
    await life().schema.need();
    const d = await s.cloud.deployments.getFor(p, parseBody(id26, req.params.id));
    s.cloud.deployments.assertCanDeploy(p, d);
    const account = await s.cloud.accounts.getFor(p, d.accountId);
    const out = await life().orphans.sweep(account, actorOf(req));
    res.json({ fresh: out.fresh, gone: out.gone, orphans: await life().orphans.forDeployment(p, d.id) });
  });

  r.post('/cloud/deployments/:id/orphans/:orphanId/adopt', ...deploy, async (req, res) => {
    res.json(await life().orphans.adopt(actorOf(req), parseBody(id26, req.params.id), parseBody(id26, req.params.orphanId)));
  });

  r.post('/cloud/deployments/:id/orphans/:orphanId/ignore', ...deploy, async (req, res) => {
    res.json({ orphan: await life().orphans.ignore(actorOf(req), parseBody(id26, req.params.id), parseBody(id26, req.params.orphanId)) });
  });

  r.post('/cloud/deployments/:id/orphans/:orphanId/delete', ...freshAdmin, async (req, res) => {
    res.json(await life().orphans.delete(actorOf(req), parseBody(id26, req.params.id), parseBody(id26, req.params.orphanId)));
  });

  return r;
}
