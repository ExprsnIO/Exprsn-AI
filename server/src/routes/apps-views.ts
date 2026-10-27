import { Router, type Request } from 'express';
import { z } from 'zod';
import { boardColumns, boardSchema } from '../apps/board.js';
import type { Actor } from '../apps/service.js';
import { viewInputSchema, viewPatchSchema } from '../apps/views.js';
import type { Principal } from '../authz/policy.js';
import { ip, parseBody, principalOf, requirePermission } from '../http/middleware.js';
import type { Services } from '../services.js';

const ref = z.string().min(1).max(63);
const id26 = z.string().length(26);

/**
 * Saved views of the Records tab and the paged board (the exprsn-platform low-code port, follow-ups 1 and 4 of
 * `docs/decisions/lowcode-port.md`). Mounted inside `routes/apps.ts`, behind its `/apps` guards (authentication,
 * app-scoped credentials). Every route needs `records:read`; sharing a view, and changing someone else's shared view,
 * also `apps:design`, which the service checks with the app's label. A view only stores query settings: records are
 * read through the records routes and the reader's own grant.
 */
export function appViewRoutes(s: Services): Router {
  const r = Router();
  const read = requirePermission(s, 'records:read');
  const views = s.apps.views;
  const actor = (req: Request): Actor & { principal: Principal } => ({ principal: principalOf(req), source: 'api', ip: ip(req), traceId: req.traceId });
  const param = (req: Request, k: string) => parseBody(ref, req.params[k]);

  r.get('/apps/:app/entities/:entity/views', read, async (req, res) => {
    res.json(await views.list(principalOf(req), param(req, 'app'), param(req, 'entity')));
  });

  r.post('/apps/:app/entities/:entity/views', read, async (req, res) => {
    res.status(201).json(await views.create(actor(req), param(req, 'app'), param(req, 'entity'), parseBody(viewInputSchema, req.body)));
  });

  /** The caller's default view of the entity; `view: null` clears it. */
  r.put('/apps/:app/entities/:entity/views/default', read, async (req, res) => {
    const body = parseBody(z.object({ view: id26.nullable() }).strict(), req.body);
    res.json(await views.setDefault(actor(req), param(req, 'app'), param(req, 'entity'), body.view));
  });

  r.patch('/apps/:app/entities/:entity/views/:view', read, async (req, res) => {
    res.json(await views.update(actor(req), param(req, 'app'), param(req, 'entity'), parseBody(id26, req.params.view), parseBody(viewPatchSchema, req.body)));
  });

  r.delete('/apps/:app/entities/:entity/views/:view', read, async (req, res) => {
    await views.remove(actor(req), param(req, 'app'), param(req, 'entity'), parseBody(id26, req.params.view));
    res.status(204).end();
  });

  /** The board's columns, each a page of records from the server with its count; `columns` pages chosen ones. */
  r.post('/apps/:app/entities/:entity/records/board', read, async (req, res) => {
    res.json(await boardColumns(s.apps, principalOf(req), param(req, 'app'), param(req, 'entity'), parseBody(boardSchema, req.body)));
  });

  return r;
}
