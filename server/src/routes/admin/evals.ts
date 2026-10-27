import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../../audit/chain.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import { evalSetBody } from '../../evals/service.js';
import type { Services } from '../../services.js';

/**
 * Evaluations of a profile (B-1303), mounted with the profile routes: eval sets, runs on demand, the score history
 * and dual-control overrides of the publish gate. Everything needs `profiles:manage`; sets above the caller's
 * clearance are left out.
 */
export function evalRoutes(s: Services): Router {
  const r = Router();
  const manage = requirePermission(s, 'profiles:manage');
  const audit = (req: Request, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, ...(detail ? { detail } : {}), traceId: req.traceId });
  };
  const pid = (req: Request) => String(req.params.id);

  r.get('/profiles/:id/evaluations', noStore, requireAuth(), manage, async (req, res) => {
    res.json(await s.evals.overview(principalOf(req), pid(req)));
  });

  r.post('/profiles/:id/eval-sets', noStore, requireAuth(), manage, async (req, res) => {
    const body = parseBody(evalSetBody, req.body);
    const out = await s.evals.createSet(principalOf(req), pid(req), body);
    await audit(req, 'profile.eval.set.created', { profile: pid(req), set: out.id, name: out.name }, { cases: out.cases.length, threshold: out.threshold, gate: out.gate, judge: out.judgeProfile });
    res.status(201).json(out);
  });

  r.patch('/profiles/:id/eval-sets/:sid', noStore, requireAuth(), manage, async (req, res) => {
    const body = parseBody(evalSetBody.partial().strict(), req.body);
    const out = await s.evals.updateSet(principalOf(req), pid(req), String(req.params.sid), body);
    await audit(req, 'profile.eval.set.updated', { profile: pid(req), set: out.id, name: out.name }, { changed: Object.keys(body), revision: out.revision });
    res.json(out);
  });

  r.delete('/profiles/:id/eval-sets/:sid', noStore, requireAuth(), manage, async (req, res) => {
    const x = await s.evals.removeSet(principalOf(req), pid(req), String(req.params.sid));
    await audit(req, 'profile.eval.set.deleted', { profile: pid(req), set: x.id, name: x.name });
    res.status(204).end();
  });

  r.post('/profiles/:id/evaluations/run', noStore, requireAuth(), manage, async (req, res) => {
    const body = parseBody(z.object({ setId: z.string().length(26).optional(), trigger: z.enum(['manual', 'publish']).default('manual') }), req.body ?? {});
    const runs = await s.evals.start(principalOf(req), pid(req), { ...(body.setId ? { setId: body.setId } : {}), trigger: body.trigger });
    await audit(req, 'profile.eval.started', { profile: pid(req) }, { runs: runs.map((x) => x.id), version: runs[0]?.profileVersion ?? null, trigger: body.trigger });
    res.status(202).json(runs);
  });

  r.get('/profiles/:id/evaluations/runs/:rid', noStore, requireAuth(), manage, async (req, res) => {
    res.json(await s.evals.run(principalOf(req), pid(req), String(req.params.rid)));
  });

  r.post('/profiles/:id/evaluations/overrides', noStore, requireAuth(), manage, async (req, res) => {
    const body = parseBody(z.object({ reason: z.string().trim().min(10).max(500) }), req.body);
    res.status(201).json(await s.evals.requestOverride(principalOf(req), pid(req), body.reason));
  });

  r.post('/profiles/:id/evaluations/overrides/:oid/decide', noStore, requireAuth(), manage, async (req, res) => {
    const body = parseBody(z.object({ decision: z.enum(['approve', 'reject']) }), req.body);
    res.json(await s.evals.decideOverride(principalOf(req), pid(req), String(req.params.oid), body.decision));
  });

  return r;
}
