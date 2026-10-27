import { Router, type Request } from 'express';
import { z } from 'zod';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission, requireRecentAuth } from '../http/middleware.js';
import { notFound } from '../http/problem.js';
import { PUSH_KINDS, type PushScope } from '../push/model.js';
import type { Services } from '../services.js';

/*
 * 1.9.0, Sprint 49 (B-151, B-152, B-154): push providers, test sends and the delivery log.
 *
 * Platform defaults (platform:manage)              Tenant overrides (tenant:manage)
 *   GET    /admin/platform/push/providers            GET    /admin/push/providers
 *   POST   /admin/platform/push/providers            POST   /admin/push/providers
 *   GET    /admin/platform/push/providers/:id        GET    /admin/push/providers/:id
 *   PATCH  /admin/platform/push/providers/:id        PATCH  /admin/push/providers/:id
 *   DELETE /admin/platform/push/providers/:id        DELETE /admin/push/providers/:id
 *   POST   /admin/platform/push/providers/:id/check  POST   /admin/push/providers/:id/check
 *   POST   /admin/platform/push/providers/:id/test   POST   /admin/push/providers/:id/test
 *   POST   /admin/platform/push/vapid-keys           POST   /admin/push/vapid-keys
 *   PUT    /admin/platform/push/secrets              PUT    /admin/push/secrets   (store a credential; refs back)
 *   GET    /admin/platform/push/deliveries           GET    /admin/push/deliveries
 *
 *   GET    /push/web-config    (any signed-in member) the VAPID public key the browser subscribes with
 *
 * Creating, changing and deleting a provider and generating keys need a recent sign-in (they move credentials).
 * A test goes only to the caller's own devices. The log never holds a token, a credential or a notification's text.
 */

const id = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const name = z.string().trim().min(1).max(100);
const createBody = z.object({ kind: z.enum(PUSH_KINDS), name, enabled: z.boolean().optional(), config: z.record(z.string(), z.unknown()) }).strict();
const patchBody = z.object({ name: name.optional(), enabled: z.boolean().optional(), config: z.record(z.string(), z.unknown()).optional() }).strict();
const testBody = z.object({ deviceId: id.optional() }).strict();
const vapidBody = z.object({ path: z.string().trim().min(1).max(300).regex(/^(vault:)?[a-z0-9._/-]+$/, 'A vault path of lower-case letters, digits, dot, dash, underscore and /.') }).strict();
const secretBody = z.object({ path: vapidBody.shape.path, data: z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/), z.string().min(1).max(32_000)).refine((d) => Object.keys(d).length >= 1 && Object.keys(d).length <= 10, 'One to ten keys.') }).strict();
const logQuery = z
  .object({
    provider: id.optional(),
    outcome: z.enum(['sent', 'failed', 'dropped', 'suppressed', 'retrying', 'waiting']).optional(),
    channel: z.enum(['push', 'websocket']).optional(),
    user: id.optional(),
    since: z.coerce.number().int().min(0).optional(),
    before: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional()
  })
  .strict();

export function pushRoutes(s: Services): Router {
  const r = Router();
  const ctx = (req: Request) => ({ ip: ip(req), traceId: req.traceId });
  r.use(['/admin/platform/push', '/admin/push', '/push'], noStore, requireAuth());

  const scoped = (base: string, scope: PushScope, perm: 'platform:manage' | 'tenant:manage') => {
    const gate = requirePermission(s, perm);
    const tenantOf = (req: Request) => (scope === 'tenant' ? principalOf(req).tenantId : null);

    r.get(`${base}/providers`, gate, async (req, res) => {
      res.json({ scope, providers: await s.push.list(scope, tenantOf(req)) });
    });
    r.post(`${base}/providers`, gate, requireRecentAuth(s), async (req, res) => {
      const b = parseBody(createBody, req.body);
      res.status(201).json(await s.push.create(principalOf(req), scope, { kind: b.kind, name: b.name, config: b.config, ...(b.enabled !== undefined ? { enabled: b.enabled } : {}) }, ctx(req)));
    });
    r.get(`${base}/providers/:id`, gate, async (req, res) => {
      res.json(await s.push.get(scope, tenantOf(req), id.parse(String(req.params.id))));
    });
    r.patch(`${base}/providers/:id`, gate, requireRecentAuth(s), async (req, res) => {
      const b = parseBody(patchBody, req.body);
      res.json(await s.push.update(principalOf(req), scope, id.parse(String(req.params.id)), { ...(b.name !== undefined ? { name: b.name } : {}), ...(b.enabled !== undefined ? { enabled: b.enabled } : {}), ...(b.config !== undefined ? { config: b.config } : {}) }, ctx(req)));
    });
    r.delete(`${base}/providers/:id`, gate, requireRecentAuth(s), async (req, res) => {
      await s.push.remove(principalOf(req), scope, id.parse(String(req.params.id)), ctx(req));
      res.status(204).end();
    });
    r.post(`${base}/providers/:id/check`, gate, async (req, res) => {
      parseBody(z.object({}).strict(), req.body ?? {});
      res.json(await s.push.check(principalOf(req), scope, id.parse(String(req.params.id)), ctx(req)));
    });
    r.post(`${base}/providers/:id/test`, gate, async (req, res) => {
      const b = parseBody(testBody, req.body ?? {});
      res.json(await s.push.testProvider(principalOf(req), scope, id.parse(String(req.params.id)), b.deviceId ? { deviceId: b.deviceId } : {}, ctx(req)));
    });
    r.post(`${base}/vapid-keys`, gate, requireRecentAuth(s), async (req, res) => {
      const b = parseBody(vapidBody, req.body);
      res.status(201).json(await s.push.generateVapid(principalOf(req), scope, b.path, ctx(req)));
    });
    r.put(`${base}/secrets`, gate, requireRecentAuth(s), async (req, res) => {
      const b = parseBody(secretBody, req.body);
      res.status(201).json(await s.push.storeSecret(principalOf(req), scope, b.path, b.data, ctx(req)));
    });
    r.get(`${base}/deliveries`, gate, async (req, res) => {
      const q = parseBody(logQuery, req.query);
      res.json(await s.push.deliveries(scope, tenantOf(req), { ...(q.provider ? { providerId: q.provider } : {}), ...(q.outcome ? { outcome: q.outcome } : {}), ...(q.channel ? { channel: q.channel } : {}), ...(q.user ? { userId: q.user } : {}), ...(q.since !== undefined ? { since: q.since } : {}), ...(q.before !== undefined ? { before: q.before } : {}), ...(q.limit ? { limit: q.limit } : {}) }));
    });
  };
  scoped('/admin/platform/push', 'platform', 'platform:manage');
  scoped('/admin/push', 'tenant', 'tenant:manage');

  // Any signed-in member: the public key their browser subscribes with (no credential; 404 without a provider).
  r.get('/push/web-config', async (req, res) => {
    const c = await s.push.webConfig(principalOf(req).tenantId);
    if (!c) throw notFound('Web Push provider');
    res.json(c);
  });

  return r;
}
