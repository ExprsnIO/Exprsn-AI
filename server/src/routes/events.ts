import { Router } from 'express';
import { requireAnyPermission, requireAuth } from '../http/middleware.js';
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
  const either = requireAnyPermission(s, ['webhooks:manage', 'plugins:manage']);
  r.get('/events/catalogue', requireAuth(), either, (req, res) => {
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) return void res.status(304).end();
    res.json(body);
  });
  return r;
}
