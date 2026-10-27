import { Router, type Request } from 'express';
import { z } from 'zod';
import type { CloudActor } from '../../cloud/accounts.js';
import { moveDecisionSchema, moveInputSchema, moveRollbackSchema } from '../../cloud/db-move.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission, requireRecentAuth } from '../../http/middleware.js';
import type { Services } from '../../services.js';

/*
 * 1.9.99-final, Sprint 59 (B-10302): moving this install's own database onto a managed PostgreSQL
 * (`cloud/db-move.ts`), under dual control. Every route needs `cloud:admin` and `platform:manage` (it is the
 * platform's database); asking, approving and rolling back need a recent sign-in, and the approval is never by the
 * person who asked. Asking runs the dry run first and refuses with its failed checks; the approved move runs as the
 * job `cloud.db.move`. The target's URL comes from a `vault:` reference the asker can read, or from a deployment's
 * wired database; no URL, password or CA appears in any answer. These routes answer during the read-only window.
 *
 *   GET  /admin/cloud/db-moves                          the moves, newest first
 *   GET  /admin/cloud/db-moves/:id
 *   POST /admin/cloud/db-moves/dry-run                  { target, caRef?, instances?, windowMinutes? } → 201 { move } (changes nothing)
 *   POST /admin/cloud/db-moves                          { target, caRef?, instances?, windowMinutes?, keepOldDays?, note? } → 201 { move } (ask)
 *   POST /admin/cloud/db-moves/:id/approve              { note? } (a second admin) → 202 { move, job }
 *   POST /admin/cloud/db-moves/:id/reject               { note? }
 *   POST /admin/cloud/db-moves/:id/rollback             { discardNewWrites?, note? }
 *   POST /admin/cloud/db-moves/:id/finish               ends the keep window of the old database
 */

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
const actorOf = (req: Request): CloudActor => ({ principal: principalOf(req), ip: ip(req), traceId: req.traceId });

export function cloudDbMoveRoutes(s: Services): Router {
  const r = Router();
  const base = [requirePermission(s, 'cloud:admin'), requirePermission(s, 'platform:manage')];
  const read = [noStore, requireAuth(), ...base];
  const fresh = [noStore, requireAuth({ sessionOnly: true }), ...base, requireRecentAuth(s)];
  const moves = () => s.cloud.dbMoves;

  r.get('/cloud/db-moves', ...read, async (_req, res) => {
    res.json({ moves: (await moves().list()).map((m) => moves().view(m)), window: await moves().window.current(0) });
  });

  r.get('/cloud/db-moves/:id', ...read, async (req, res) => {
    res.json({ move: moves().view(await moves().get(parseBody(id26, req.params.id))) });
  });

  r.post('/cloud/db-moves/dry-run', ...fresh, async (req, res) => {
    const body = parseBody(moveInputSchema, req.body ?? {});
    const a = actorOf(req);
    const target = body.target.kind === 'vault' ? { kind: 'vault' as const, ref: body.target.ref, tenantId: a.principal.tenantId, ownerId: a.principal.userId! } : { kind: 'deployment' as const, deploymentId: body.target.deploymentId, ...(body.target.key ? { key: body.target.key } : {}) };
    const m = await moves().plan({ target, dryRun: true, ...(body.instances ? { instances: body.instances } : {}), ...(body.windowMinutes ? { windowMinutes: body.windowMinutes } : {}) }, a);
    res.status(201).json({ move: moves().view(m) });
  });

  r.post('/cloud/db-moves', ...fresh, async (req, res) => {
    const body = parseBody(moveInputSchema, req.body ?? {});
    res.status(201).json({ move: moves().view(await moves().request(actorOf(req), body)) });
  });

  r.post('/cloud/db-moves/:id/approve', ...fresh, async (req, res) => {
    const body = parseBody(moveDecisionSchema, req.body ?? {});
    const out = await moves().approve(actorOf(req), parseBody(id26, req.params.id), body.note ?? null);
    res.status(202).json({ move: moves().view(out.move), job: { id: out.jobId, type: 'cloud.db.move' } });
  });

  r.post('/cloud/db-moves/:id/reject', ...read, async (req, res) => {
    const body = parseBody(moveDecisionSchema, req.body ?? {});
    res.json({ move: moves().view(await moves().reject(actorOf(req), parseBody(id26, req.params.id), body.note ?? null)) });
  });

  r.post('/cloud/db-moves/:id/rollback', ...fresh, async (req, res) => {
    const body = parseBody(moveRollbackSchema, req.body ?? {});
    res.json({ move: moves().view(await moves().rollback(parseBody(id26, req.params.id), actorOf(req), { discardNewWrites: body.discardNewWrites })) });
  });

  r.post('/cloud/db-moves/:id/finish', ...fresh, async (req, res) => {
    res.json({ move: moves().view(await moves().finish(parseBody(id26, req.params.id), actorOf(req))) });
  });

  return r;
}
