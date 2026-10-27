import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../../audit/chain.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission, requireRecentAuth } from '../../http/middleware.js';
import type { Services } from '../../services.js';
import type { SealActor } from '../../vault/seal.js';

/*
 * 1.8.0, Sprint 48 (B-145): "Seal the vault", under dual control, for holders of `platform:manage`.
 *
 *   GET  /admin/platform/vault/seal                          whether a seal is possible (an escrow of the running
 *                                                            key), the last seal and unseal, the proposals
 *   POST /admin/platform/vault/seal/proposals                propose the seal, with a reason (recent sign-in)
 *   POST /admin/platform/vault/seal/proposals/:id/approve    a second, different platform admin: the seal fires on
 *                                                            every instance (recent sign-in)
 *   POST /admin/platform/vault/seal/proposals/:id/reject
 *   POST /admin/platform/vault/seal/proposals/:id/withdraw   the proposer
 *
 * While sealed none of these answer (the seal gate refuses every authenticated route); the unseal page and its API
 * are public: `routes/vault-seal-public.ts`.
 */

const id26 = z.string().regex(/^[0-9A-Za-z]{26}$/);
const note = z.string().trim().max(500).nullable().optional();

export function vaultSealAdminRoutes(s: Services): Router {
  const r = Router();
  const platform = requirePermission(s, 'platform:manage');
  r.use('/platform/vault/seal', noStore, requireAuth());
  const actor = (req: Request): SealActor => {
    const p = principalOf(req);
    return { tenantId: p.tenantId, userId: p.userId, audit: actorFrom(p, ip(req)), traceId: req.traceId ?? null };
  };

  r.get('/platform/vault/seal', platform, async (req, res) => {
    res.json(await s.vaultSeal.status(principalOf(req).userId));
  });

  r.post('/platform/vault/seal/proposals', platform, requireRecentAuth(s), async (req, res) => {
    const b = parseBody(z.object({ reason: z.string().trim().min(10).max(1000) }).strict(), req.body);
    res.status(201).json(await s.vaultSeal.propose(actor(req), b.reason));
  });

  r.post('/platform/vault/seal/proposals/:id/approve', platform, requireRecentAuth(s), async (req, res) => {
    const b = parseBody(z.object({ note }).strict(), req.body ?? {});
    res.json(await s.vaultSeal.approve(actor(req), parseBody(id26, req.params.id), b.note ?? null));
  });

  r.post('/platform/vault/seal/proposals/:id/reject', platform, async (req, res) => {
    const b = parseBody(z.object({ note }).strict(), req.body ?? {});
    res.json(await s.vaultSeal.reject(actor(req), parseBody(id26, req.params.id), b.note ?? null));
  });

  r.post('/platform/vault/seal/proposals/:id/withdraw', platform, async (req, res) => {
    parseBody(z.object({}).strict(), req.body ?? {});
    res.json(await s.vaultSeal.withdraw(actor(req), parseBody(id26, req.params.id)));
  });

  return r;
}
