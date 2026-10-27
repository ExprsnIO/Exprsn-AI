import { Router, type Request } from 'express';
import { z } from 'zod';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import type { Services } from '../services.js';
import { tagsSchema } from '../workflows/tags.js';

/**
 * 1.8.0, Sprint 47 (B-137): workflow tags and favourites. Reading the tag vocabulary and starring a workflow need
 * `agents:run`, as reading workflows does; changing a workflow's tags needs `workflows:manage`. The list itself
 * (`GET /api/workflows`, with `?tag=` and `?favourites=true`) carries each workflow's tags and the caller's star.
 */
export function workflowTagRoutes(s: Services): Router {
  const r = Router();
  r.use(['/workflow-tags', '/workflows/:id/tags', '/workflows/:id/favourite'], noStore, requireAuth());
  const run = requirePermission(s, 'agents:run');
  const manage = requirePermission(s, 'workflows:manage');
  const t = s.workflowTags;
  const ctx = (req: Request) => ({ p: principalOf(req), ip: ip(req), traceId: req.traceId });
  const id = (req: Request) => parseBody(z.string().min(1).max(63), req.params.id);

  r.get('/workflow-tags', run, async (req, res) => {
    res.json({ tags: await t.vocabulary(principalOf(req)) });
  });

  r.put('/workflows/:id/tags', manage, async (req, res) => {
    const body = parseBody(z.object({ tags: tagsSchema }).strict(), req.body);
    res.json({ tags: await t.setTags(ctx(req), id(req), body.tags) });
  });

  r.put('/workflows/:id/favourite', run, async (req, res) => {
    parseBody(z.object({}).strict(), req.body ?? {});
    res.json({ favourite: await t.setFavourite(ctx(req), id(req), true) });
  });

  r.delete('/workflows/:id/favourite', run, async (req, res) => {
    await t.setFavourite(ctx(req), id(req), false);
    res.status(204).end();
  });

  return r;
}
