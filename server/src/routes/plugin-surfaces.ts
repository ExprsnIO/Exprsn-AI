import { Router } from 'express';
import { z } from 'zod';
import { ip, noStore, parseBody, principalOf, requireAuth } from '../http/middleware.js';
import { SURFACE_SLOTS } from '../plugins/surfaces.js';
import type { Services } from '../services.js';

/*
 * 1.7.0, Sprint 43 (B-11202, B-11203): the console's side of plugin UI surfaces. Any signed-in user lists the
 * surfaces approved for a slot (their declarative blocks, no data) and asks the bridge to run one of a surface's
 * declared calls, which runs as them (plugins/surfaces.ts): the permission each call needs is checked there.
 */
const sid = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const ctxSchema = z.record(z.string().regex(/^[a-z]{1,20}$/), z.string().max(200)).default({});

export function pluginSurfaceRoutes(s: Services): Router {
  const r = Router();
  r.use('/plugin-surfaces', noStore, requireAuth());

  r.get('/plugin-surfaces', async (req, res) => {
    const q = parseBody(z.object({ slot: z.enum(SURFACE_SLOTS), app: z.string().max(100).optional(), entity: z.string().max(100).optional() }).strict(), req.query);
    res.json(await s.pluginSurfaces.forSlot(principalOf(req), q.slot, { ...(q.app ? { app: q.app } : {}), ...(q.entity ? { entity: q.entity } : {}) }));
  });

  for (const kind of ['data', 'action'] as const) {
    r.post(`/plugin-surfaces/:plugin/:surface/${kind === 'data' ? 'data' : 'actions'}/:call`, async (req, res) => {
      const b = parseBody(z.object({ context: ctxSchema }).strict(), req.body ?? {});
      res.json(await s.pluginSurfaces.call(principalOf(req), parseBody(id26, req.params.plugin), parseBody(sid, req.params.surface), kind, parseBody(sid, req.params.call), b.context, { ip: ip(req), traceId: req.traceId }));
    });
  }
  return r;
}
