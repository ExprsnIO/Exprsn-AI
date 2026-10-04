import { Router } from 'express';
import type { RequestHandler } from 'express';
import { authorize } from '../authz/policy.js';
import { principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { catalogue } from '../events/catalogue.js';
import type { Services } from '../services.js';

/**
 * The event catalogue (B-2001): every event type with its data schema, the delivery envelope and the subscription
 * groups. For whoever subscribes to events: webhook managers and plugin managers.
 */
export function eventRoutes(s: Services): Router {
  const r = Router();
  const body = catalogue();
  const etag = `"catalogue-${body.version}"`;
  // Plugin managers may read it too; anyone else is refused (and audited) as for webhooks:manage.
  const webhooks = requirePermission(s, 'webhooks:manage');
  const plugins = requirePermission(s, 'plugins:manage');
  const either: RequestHandler = (req, res, next) => (authorize(principalOf(req), 'plugins:manage', {}).allow ? plugins(req, res, next) : webhooks(req, res, next));
  r.get('/events/catalogue', requireAuth(), either, (req, res) => {
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) return void res.status(304).end();
    res.json(body);
  });
  return r;
}
