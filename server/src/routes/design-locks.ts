import { Router, type Request } from 'express';
import { z } from 'zod';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { HttpProblem } from '../http/problem.js';
import { BREAK_PERMISSION, DESIGN_KINDS, type DesignKind } from '../realtime/design-locks.js';
import type { Services } from '../services.js';

const kind = z.enum(DESIGN_KINDS);
const ref = z.string().min(1).max(63);
const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

/**
 * 1.8.0, Sprint 47 (B-140): presence and the edit lock of a design object over REST, beside the console's socket
 * (`realtime/design-locks.ts`). The kind decides the right: seeing the state needs the kind's read right, taking or
 * releasing the lock its manage right (both checked in the handler, since they differ per kind, so these routes are
 * declared `authenticated`); breaking someone's lock and the list of live locks are for tenant admins
 * (`tenant:manage`). An object outside the caller's workspaces or above their clearance is 404, whether it exists or
 * not. `app` names the app of a flow, form or entity.
 */
export function designLockRoutes(s: Services): Router {
  const r = Router();
  r.use(['/design-locks', '/admin/design-locks'], noStore, requireAuth());
  const admin = requirePermission(s, BREAK_PERMISSION);
  const locks = s.designLocks;
  const ctx = (req: Request) => ({ ip: ip(req), traceId: req.traceId });

  const target = (req: Request, appFrom: unknown) => {
    const k = parseBody(kind, req.params.kind) as DesignKind;
    const app = parseBody(ref.optional(), typeof appFrom === 'string' && appFrom ? appFrom : undefined);
    return { kind: k, id: parseBody(ref, req.params.id), ...(app ? { app } : {}) };
  };

  /** Who has it open and who holds the lock. */
  r.get('/design-locks/:kind/:id', async (req, res) => {
    const p = principalOf(req);
    const obj = await locks.resolve(p, target(req, req.query.app));
    const st = await locks.state(obj.tenantId, obj.kind, obj.id);
    res.json({ kind: obj.kind, id: obj.id, title: obj.title, label: obj.label, canManage: locks.canManage(p, obj.kind), viewers: st.viewers.map((v) => ({ ...v, you: v.userId === p.userId })), lock: st.lock ? { userId: st.lock.userId, name: st.lock.name, since: st.lock.since, expiresAt: st.lock.expiresAt, via: st.lock.via, you: st.lock.userId === p.userId } : null });
  });

  /** Takes (or renews) the edit lock; `takeover` takes it from someone else. 409 names the holder. */
  r.post('/design-locks/:kind/:id', async (req, res) => {
    const body = parseBody(z.object({ app: ref.optional(), takeover: z.boolean().default(false) }).strict(), req.body ?? {});
    const p = principalOf(req);
    const obj = await locks.resolve(p, target(req, body.app));
    const out = await locks.acquire(p, obj, { ...ctx(req), takeover: body.takeover });
    if (!out.ok) throw new HttpProblem(409, 'Being edited', `${out.lock?.name ?? 'Someone'} is editing this. Take it over to edit it yourself.`, { extensions: { lock: out.lock } });
    res.json({ lock: out.lock, tookOver: !!out.tookOver });
  });

  /** Releases the caller's own lock. */
  r.delete('/design-locks/:kind/:id', async (req, res) => {
    const p = principalOf(req);
    const obj = await locks.resolve(p, target(req, req.query.app));
    if (!locks.canManage(p, obj.kind)) throw new HttpProblem(403, 'Forbidden', `Editing this needs ${locks.managePermissions(obj.kind).join(' and ')}.`, { extensions: { step: 'role' } });
    await locks.release(p, obj, 'release', ctx(req));
    res.status(204).end();
  });

  /** Live edit locks in the tenant, within the admin's clearance. */
  r.get('/admin/design-locks', admin, async (req, res) => {
    res.json({ locks: await locks.list(principalOf(req)) });
  });

  /** Breaks a lock without taking it; the holder is told and keeps their unsaved state on their device. */
  r.post('/admin/design-locks/:kind/:id/break', admin, async (req, res) => {
    parseBody(z.object({}).strict(), req.body ?? {});
    const k = parseBody(kind, req.params.kind) as DesignKind;
    const broken = await locks.breakLock(principalOf(req), k, parseBody(id26, req.params.id), ctx(req));
    res.json({ broken });
  });

  return r;
}
