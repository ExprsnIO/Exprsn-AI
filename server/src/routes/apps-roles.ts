import { Router, type Request } from 'express';
import { z } from 'zod';
import { memberInputSchema, roleInputSchema, rolePatchSchema } from '../apps/roles.js';
import type { Actor } from '../apps/service.js';
import type { Principal } from '../authz/policy.js';
import { ip, parseBody, principalOf, requirePermission } from '../http/middleware.js';
import type { Services } from '../services.js';

const ref = z.string().min(1).max(63);
const id26 = z.string().length(26);

/**
 * App-local roles (1.8.0, B-143): an app's own role catalogue and who holds each role in this environment. Mounted
 * inside `routes/apps.ts`, behind its `/apps` guards (authentication, app-scoped credentials).
 *
 * Every route needs `apps:design` and the app's label within the caller's clearance (`AppService.designable`), the
 * same right that writes the row and field policies a role feeds: a role grants only what those policies say, so its
 * catalogue and assignments are the app's designers' and need no tenant administration permission. Changes are
 * audited `app.role.created`, `app.role.updated`, `app.role.deleted`, `app.role.assigned`, `app.role.unassigned`.
 */
export function appRoleRoutes(s: Services): Router {
  const r = Router();
  const design = requirePermission(s, 'apps:design');
  const a = s.apps;
  const actor = (req: Request): Actor & { principal: Principal } => ({ principal: principalOf(req), source: 'api', ip: ip(req), traceId: req.traceId });
  const app = (req: Request) => a.designable(principalOf(req), parseBody(ref, req.params.app));
  const roleView = (x: Awaited<ReturnType<typeof a.roles.get>>) => ({ id: x.id, name: x.name, description: x.description, createdBy: x.created_by, updatedBy: x.updated_by, createdAt: x.created_at, updatedAt: x.updated_at });

  /** The catalogue: each role with its assignments and the policies that name it ("what can this role do"). */
  r.get('/apps/:app/roles', design, async (req, res) => {
    res.json({ roles: await a.roles.view(await app(req)) });
  });

  /** People the designer may assign (the app's workspace members; the tenant's users for a tenant-wide app). */
  r.get('/apps/:app/roles/candidates', design, async (req, res) => {
    const q = parseBody(z.object({ q: z.string().trim().max(100).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }).strict(), req.query);
    res.json({ people: await a.roles.candidates(await app(req), q.q || null, q.limit) });
  });

  r.post('/apps/:app/roles', design, async (req, res) => {
    const body = parseBody(roleInputSchema, req.body);
    res.status(201).json(roleView(await a.roles.create(actor(req), await app(req), body)));
  });

  r.patch('/apps/:app/roles/:id', design, async (req, res) => {
    const body = parseBody(rolePatchSchema, req.body);
    res.json(roleView(await a.roles.update(actor(req), await app(req), parseBody(id26, req.params.id), body)));
  });

  r.delete('/apps/:app/roles/:id', design, async (req, res) => {
    await a.roles.remove(actor(req), await app(req), parseBody(id26, req.params.id));
    res.status(204).end();
  });

  r.post('/apps/:app/roles/:id/members', design, async (req, res) => {
    const body = parseBody(memberInputSchema, req.body);
    const m = await a.roles.assign(actor(req), await app(req), parseBody(id26, req.params.id), body);
    res.status(201).json({ id: m.id, roleId: m.role_id, kind: m.subject_kind, subjectId: m.subject_id, createdAt: m.created_at });
  });

  r.delete('/apps/:app/roles/:id/members/:member', design, async (req, res) => {
    await a.roles.unassign(actor(req), await app(req), parseBody(id26, req.params.id), parseBody(id26, req.params.member));
    res.status(204).end();
  });

  return r;
}
