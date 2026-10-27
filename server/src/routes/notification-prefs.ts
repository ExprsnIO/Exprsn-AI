import { Router, type Request } from 'express';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { defaultsBody, prefsBody } from '../platform/notification-prefs.js';
import { templateApplyBody, templateCreateBody, templateUpdateBody } from '../platform/notification-templates.js';
import type { Services } from '../services.js';

/**
 * 1.9.0, Sprint 49 (B-153): notification preferences.
 *
 * - `/api/me/notification-preferences`: a person's own choices per kind and channel, quiet hours, time zone and digest
 *   times (any signed-in principal, their own only). A mandatory kind cannot be turned off or delayed (409 naming it).
 *   `DELETE` goes back to the tenant defaults. Audited `notification.prefs.updated` and `.reset`.
 * - `/api/admin/notification-defaults`: the tenant's defaults and mandatory kinds, with `tenant:manage` (tenant admins).
 *   Security alerts are mandatory in every tenant and cannot be made optional (409). Audited
 *   `notification.defaults.updated`.
 * - `/api/admin/notification-templates`: named, versioned preference sets of the tenant, applied to one person, a
 *   list, a role, a group or everyone (`replace` or `fill`), and the default for new members; the same permission as
 *   the defaults, `tenant:manage`. A template that would turn a mandatory kind off or delay it is refused (409 naming
 *   the kinds). Without migration 132 the list says `available: false` and the rest answer 503. Audited
 *   `notification.template.created`, `.updated`, `.deleted` and `.applied`.
 */
export function notificationPrefRoutes(s: Services): Router {
  const r = Router();
  const ctx = (req: Request) => ({ ip: ip(req), traceId: req.traceId ?? null });

  r.use('/me/notification-preferences', noStore, requireAuth());

  r.get('/me/notification-preferences', async (req, res) => {
    res.json(await s.notificationPrefs.view(principalOf(req)));
  });

  r.put('/me/notification-preferences', async (req, res) => {
    const b = parseBody(prefsBody, req.body);
    res.json(await s.notificationPrefs.update(principalOf(req), b, ctx(req)));
  });

  r.delete('/me/notification-preferences', async (req, res) => {
    res.json(await s.notificationPrefs.reset(principalOf(req), ctx(req)));
  });

  const admin = [noStore, requireAuth(), requirePermission(s, 'tenant:manage')];

  r.get('/admin/notification-defaults', ...admin, async (req, res) => {
    res.json(await s.notificationPrefs.tenantView(principalOf(req).tenantId));
  });

  r.put('/admin/notification-defaults', ...admin, async (req, res) => {
    const b = parseBody(defaultsBody, req.body);
    res.json(await s.notificationPrefs.updateTenant(principalOf(req), b, ctx(req)));
  });

  const id = (req: Request) => String(req.params.id);

  r.get('/admin/notification-templates', ...admin, async (req, res) => {
    res.json(await s.notificationPrefs.templates.list(principalOf(req).tenantId));
  });

  r.post('/admin/notification-templates', ...admin, async (req, res) => {
    const b = parseBody(templateCreateBody, req.body);
    res.status(201).json(await s.notificationPrefs.templates.create(principalOf(req), b, ctx(req)));
  });

  r.get('/admin/notification-templates/:id', ...admin, async (req, res) => {
    res.json(await s.notificationPrefs.templates.get(principalOf(req).tenantId, id(req)));
  });

  r.patch('/admin/notification-templates/:id', ...admin, async (req, res) => {
    const b = parseBody(templateUpdateBody, req.body);
    res.json(await s.notificationPrefs.templates.update(principalOf(req), id(req), b, ctx(req)));
  });

  r.delete('/admin/notification-templates/:id', ...admin, async (req, res) => {
    res.json(await s.notificationPrefs.templates.remove(principalOf(req), id(req), ctx(req)));
  });

  r.post('/admin/notification-templates/:id/apply', ...admin, async (req, res) => {
    const b = parseBody(templateApplyBody, req.body);
    res.json(await s.notificationPrefs.templates.apply(principalOf(req), id(req), b, ctx(req)));
  });

  return r;
}
