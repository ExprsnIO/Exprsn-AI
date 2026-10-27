import { Router, type Request } from 'express';
import { z } from 'zod';
import { deliveryScheduleSchema, subscriptionInputSchema, subscriptionPatchSchema } from '../apps/subscriptions.js';
import type { Actor } from '../apps/service.js';
import type { Principal } from '../authz/policy.js';
import { ip, parseBody, principalOf, requirePermission } from '../http/middleware.js';
import type { Services } from '../services.js';

const id26 = z.string().length(26);

/**
 * 1.8.0, Sprint 44 (B-124): subscriptions to app views, reports, dashboards and records, delivered on a schedule by
 * email, to the file store or to a signed webhook (`apps/subscriptions.ts`). Mounted inside `routes/apps.ts`, behind
 * its `/apps` guards (an app-scoped credential is refused here), before `/apps/:app`.
 *
 * Permissions: every route needs `records:read` (subscribing is reading the object on a schedule; the service checks
 * the object itself as the subscriber, and every run re-checks it as each recipient). On top, checked by the service
 * where the body asks for it: other recipients need `apps:design` on the app (and its label within clearance); a
 * folder destination `files:write` and membership of its workspace; a webhook destination `webhooks:manage` (the
 * integrations right) and a host on the tenant's list. The tenant's list of every subscription needs `tenant:manage`;
 * an admin may pause or delete any subscription within clearance, only the owner changes, resumes or runs one.
 */
export function appSubscriptionRoutes(s: Services): Router {
  const r = Router();
  const read = requirePermission(s, 'records:read');
  const admin = requirePermission(s, 'tenant:manage');
  const subs = s.apps.subscriptions;
  const actor = (req: Request): Actor & { principal: Principal } => ({ principal: principalOf(req), source: 'api', ip: ip(req), traceId: req.traceId });
  const id = (req: Request) => parseBody(id26, req.params.id);

  r.get('/apps/subscriptions', read, async (req, res) => {
    res.json(await subs.mine(principalOf(req)));
  });

  r.get('/apps/subscriptions/options', read, async (_req, res) => {
    res.json(subs.options());
  });

  /** The next runs of a schedule (a cron or a preset in a zone), checked as a subscription's would be; 422 when it cannot run. */
  r.post('/apps/subscriptions/preview', read, async (req, res) => {
    const body = parseBody(z.object({ schedule: deliveryScheduleSchema, count: z.number().int().min(1).max(20).default(5) }).strict(), req.body);
    res.json(subs.preview(body.schedule, body.count));
  });

  r.get('/apps/subscriptions/all', admin, async (req, res) => {
    const q = parseBody(z.object({ state: z.enum(['active', 'paused']).optional(), app: id26.optional() }).strict(), req.query);
    res.json(await subs.all(principalOf(req), q));
  });

  r.post('/apps/subscriptions', read, async (req, res) => {
    res.status(201).json(await subs.create(actor(req), parseBody(subscriptionInputSchema, req.body)));
  });

  r.get('/apps/subscriptions/:id', read, async (req, res) => {
    res.json(await subs.get(principalOf(req), id(req)));
  });

  r.patch('/apps/subscriptions/:id', read, async (req, res) => {
    res.json(await subs.update(actor(req), id(req), parseBody(subscriptionPatchSchema, req.body)));
  });

  r.delete('/apps/subscriptions/:id', read, async (req, res) => {
    await subs.remove(actor(req), id(req));
    res.status(204).end();
  });

  r.get('/apps/subscriptions/:id/deliveries', read, async (req, res) => {
    const q = parseBody(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).strict(), req.query);
    res.json(await subs.deliveries(principalOf(req), id(req), q.limit));
  });

  r.post('/apps/subscriptions/:id/run', read, async (req, res) => {
    res.status(202).json(await subs.runNow(actor(req), id(req)));
  });

  /** The signed-in recipient stops their own email copies (the email's link does the same without a sign-in). */
  r.post('/apps/subscriptions/:id/unsubscribe', read, async (req, res) => {
    res.json(await subs.unsubscribeSelf(actor(req), id(req)));
  });

  return r;
}
