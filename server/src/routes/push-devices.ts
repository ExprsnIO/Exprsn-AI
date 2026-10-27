import { Router, type Request } from 'express';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { registerBody, renameBody } from '../platform/push-devices.js';
import type { Services } from '../services.js';

/**
 * 1.9.0, Sprint 49 (B-150): push devices.
 *
 * - `/api/me/devices`: a person's own devices: list, register (the same token again updates its row, `200`; a new
 *   one is `201`), rename and revoke. Any signed-in principal, for their own account only (like `/api/me/sessions`).
 * - `/api/admin/users/:id/devices`: an administrator lists and revokes a person's devices with `users:manage`, the
 *   permission that already ends a person's sessions, disables the account and resets its factors
 *   (`routes/admin/users.ts`); tenant admins and identity admins hold it. The person must be in the admin's tenant.
 *
 * No answer ever carries a token or subscription: only the fingerprint.
 */
export function pushDeviceRoutes(s: Services): Router {
  const r = Router();
  const ctx = (req: Request) => ({ ip: ip(req), traceId: req.traceId ?? null });
  const id = (req: Request, name = 'id') => String(req.params[name]).slice(0, 26);

  r.use('/me/devices', noStore, requireAuth());

  r.get('/me/devices', async (req, res) => {
    const p = principalOf(req);
    res.json({ devices: await s.pushDevices.list(p.tenantId, p.userId, p.sessionId) });
  });

  r.post('/me/devices', async (req, res) => {
    const b = parseBody(registerBody, req.body);
    const out = await s.pushDevices.register(principalOf(req), b, ctx(req));
    res.status(out.created ? 201 : 200).json(out.device);
  });

  r.patch('/me/devices/:id', async (req, res) => {
    const b = parseBody(renameBody, req.body);
    res.json(await s.pushDevices.rename(principalOf(req), id(req), b.name, ctx(req)));
  });

  r.delete('/me/devices/:id', async (req, res) => {
    res.json(await s.pushDevices.revokeOwn(principalOf(req), id(req), ctx(req)));
  });

  const admin = [noStore, requireAuth(), requirePermission(s, 'users:manage')];

  r.get('/admin/users/:id/devices', ...admin, async (req, res) => {
    res.json({ devices: await s.pushDevices.listFor(principalOf(req), id(req)) });
  });

  r.delete('/admin/users/:id/devices/:deviceId', ...admin, async (req, res) => {
    res.json(await s.pushDevices.revokeFor(principalOf(req), id(req), id(req, 'deviceId'), ctx(req)));
  });

  return r;
}
