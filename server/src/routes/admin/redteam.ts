import { Router, type Request } from 'express';
import { z } from 'zod';
import { authorize } from '../../authz/policy.js';
import { forbidden } from '../../http/problem.js';
import { noStore, parseBody, principalOf, requireAnyPermission, requireAuth } from '../../http/middleware.js';
import { permissionForTarget, suiteBody, targetKind, type TargetKind } from '../../redteam/service.js';
import type { Services } from '../../services.js';

/**
 * Red-team suites (1.6.0, Sprint 38b, B-7001, B-7002). A suite belongs to a target: a profile (`profiles:manage`),
 * an agent by name (`agents:manage`) or a workflow (`workflows:manage`); the route needs any of the three and the
 * handler checks the one the target kind takes, through the policy pipeline. Suites above the caller's clearance
 * are left out.
 */
export function redTeamRoutes(s: Services): Router {
  const r = Router();
  const any = requireAnyPermission(s, ['profiles:manage', 'agents:manage', 'workflows:manage']);
  const target = z.object({ targetKind, targetId: z.string().trim().min(1).max(200) });

  /** The permission of the target kind, decided by the pipeline (role, scopes, tenant). */
  const forTarget = (req: Request, kind: TargetKind) => {
    const p = principalOf(req);
    const action = permissionForTarget(kind);
    const d = authorize(p, action, { tenantId: p.tenantId });
    if (!d.allow) throw forbidden(d.reason, { step: d.step, action, policy: d.policy });
    return p;
  };

  r.get('/red-team/attacks', noStore, requireAuth(), any, (_req, res) => {
    res.json(s.redteam.catalogue());
  });

  r.get('/red-team', noStore, requireAuth(), any, async (req, res) => {
    const q = parseBody(target, { targetKind: req.query.targetKind, targetId: req.query.targetId });
    const p = forTarget(req, q.targetKind);
    res.json(await s.redteam.overview(p, q.targetKind, q.targetId));
  });

  r.post('/red-team/suites', noStore, requireAuth(), any, async (req, res) => {
    const body = parseBody(target.extend(suiteBody.shape).strict(), req.body);
    const p = forTarget(req, body.targetKind);
    const { targetKind: kind, targetId, ...input } = body;
    res.status(201).json(await s.redteam.createSet(p, kind, targetId, input));
  });

  r.patch('/red-team/suites/:id', noStore, requireAuth(), any, async (req, res) => {
    const body = parseBody(suiteBody.partial().strict(), req.body);
    const p = principalOf(req);
    const before = await s.redteam.suiteOf(p, String(req.params.id));
    forTarget(req, before.targetKind);
    res.json(await s.redteam.updateSet(p, String(req.params.id), body));
  });

  r.delete('/red-team/suites/:id', noStore, requireAuth(), any, async (req, res) => {
    const p = principalOf(req);
    const before = await s.redteam.suiteOf(p, String(req.params.id));
    forTarget(req, before.targetKind);
    await s.redteam.removeSet(p, String(req.params.id));
    res.status(204).end();
  });

  r.post('/red-team/run', noStore, requireAuth(), any, async (req, res) => {
    const body = parseBody(target.extend({ suiteId: z.string().length(26).optional() }).strict(), req.body);
    const p = forTarget(req, body.targetKind);
    res.status(202).json(await s.redteam.start(p, body.targetKind, body.targetId, { ...(body.suiteId ? { suiteId: body.suiteId } : {}), trigger: 'manual' }));
  });

  r.get('/red-team/runs/:id', noStore, requireAuth(), any, async (req, res) => {
    const p = principalOf(req);
    const run = await s.redteam.run(p, String(req.params.id));
    forTarget(req, run.targetKind);
    res.json(run);
  });

  return r;
}
