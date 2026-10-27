import { Router, type Request } from 'express';
import { z } from 'zod';
import type { CloudActor } from '../../cloud/accounts.js';
import { overrideSchema, setBudgetSchema } from '../../cloud/budgets.js';
import { ip, noStore, parseBody, principalOf, requireAnyPermission, requireAuth, requirePermission, requireRecentAuth } from '../../http/middleware.js';
import type { Services } from '../../services.js';

/*
 * 1.9.99-final, Sprint 58 (B-10602): budgets per cloud account (`cloud/budgets.ts`). Reads need `finops:read` or
 * `cloud:read`; setting and removing a budget `finops:manage`; proposing, rejecting and revoking an override
 * `finops:manage` or `cloud:admin`; approving one the same, from a second admin with a recent sign-in. A platform
 * account also needs `platform:manage` for changes (checked in the service). Without migration 152 every route
 * answers 503 `migration_pending` (without 146, the accounts' own 503).
 *
 *   GET    /admin/cloud/budgets                                         every budget on the accounts one may see, with its status
 *   GET    /admin/cloud/accounts/:id/budget                             the budget, this month's actual and forecast spend, alerts, overrides
 *   PUT    /admin/cloud/accounts/:id/budget                             { amount, currency?, hardStop? }
 *   DELETE /admin/cloud/accounts/:id/budget
 *   GET    /admin/cloud/accounts/:id/budget/overrides
 *   POST   /admin/cloud/accounts/:id/budget/overrides                   { reason, hours? (at most 168) } → 202, a proposal
 *   POST   /admin/cloud/accounts/:id/budget/overrides/:oid/approve      { note? } (a second admin, recent sign-in)
 *   POST   /admin/cloud/accounts/:id/budget/overrides/:oid/reject       { note? }
 *   POST   /admin/cloud/accounts/:id/budget/overrides/:oid/withdraw     (the proposer)
 *   POST   /admin/cloud/accounts/:id/budget/overrides/:oid/revoke       { note? } (ends an active override at once)
 */

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
const noteBody = z.object({ note: z.string().trim().max(500).optional() }).strict();
const actorOf = (req: Request): CloudActor => ({ principal: principalOf(req), ip: ip(req), traceId: req.traceId });

export function cloudBudgetRoutes(s: Services): Router {
  const r = Router();
  const read = [noStore, requireAuth(), requireAnyPermission(s, ['finops:read', 'cloud:read'])];
  const manage = [noStore, requireAuth(), requirePermission(s, 'finops:manage')];
  const decide = [noStore, requireAuth(), requireAnyPermission(s, ['finops:manage', 'cloud:admin'])];
  const freshDecide = [noStore, requireAuth({ sessionOnly: true }), requireAnyPermission(s, ['finops:manage', 'cloud:admin']), requireRecentAuth(s)];
  const b = () => s.cloud.budgets;

  r.get('/cloud/budgets', ...read, async (req, res) => {
    res.json({ budgets: await b().list(principalOf(req)) });
  });

  r.get('/cloud/accounts/:id/budget', ...read, async (req, res) => {
    res.json(await b().view(principalOf(req), parseBody(id26, req.params.id)));
  });

  r.put('/cloud/accounts/:id/budget', ...manage, async (req, res) => {
    const body = parseBody(setBudgetSchema, req.body);
    res.json(await b().set(actorOf(req), parseBody(id26, req.params.id), body));
  });

  r.delete('/cloud/accounts/:id/budget', ...manage, async (req, res) => {
    await b().remove(actorOf(req), parseBody(id26, req.params.id));
    res.status(204).end();
  });

  r.get('/cloud/accounts/:id/budget/overrides', ...read, async (req, res) => {
    const id = parseBody(id26, req.params.id);
    await b().need();
    const a = await s.cloud.accounts.getFor(principalOf(req), id);
    const me = principalOf(req).userId;
    res.json({ overrides: (await b().overrides(a.id)).map((o) => ({ ...o, mine: o.proposedBy === me })) });
  });

  r.post('/cloud/accounts/:id/budget/overrides', ...decide, async (req, res) => {
    const body = parseBody(overrideSchema, req.body);
    res.status(202).json(await b().propose(actorOf(req), parseBody(id26, req.params.id), body));
  });

  r.post('/cloud/accounts/:id/budget/overrides/:oid/approve', ...freshDecide, async (req, res) => {
    const body = parseBody(noteBody, req.body ?? {});
    res.json(await b().approve(actorOf(req), parseBody(id26, req.params.id), parseBody(id26, req.params.oid), body.note ?? null));
  });

  r.post('/cloud/accounts/:id/budget/overrides/:oid/reject', ...decide, async (req, res) => {
    const body = parseBody(noteBody, req.body ?? {});
    res.json(await b().reject(actorOf(req), parseBody(id26, req.params.id), parseBody(id26, req.params.oid), body.note ?? null));
  });

  r.post('/cloud/accounts/:id/budget/overrides/:oid/withdraw', ...decide, async (req, res) => {
    res.json(await b().withdraw(actorOf(req), parseBody(id26, req.params.id), parseBody(id26, req.params.oid)));
  });

  r.post('/cloud/accounts/:id/budget/overrides/:oid/revoke', ...decide, async (req, res) => {
    const body = parseBody(noteBody, req.body ?? {});
    res.json(await b().revoke(actorOf(req), parseBody(id26, req.params.id), parseBody(id26, req.params.oid), body.note ?? null));
  });

  return r;
}
