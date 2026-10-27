import { Router, type Request } from 'express';
import { z } from 'zod';
import { ip, noStore, parseBody, principalOf, requireAnyPermission, requireAuth } from '../../http/middleware.js';
import { prefsBody } from '../../ops/overview-cards.js';
import type { Services } from '../../services.js';

/**
 * 1.8.0, Sprint 48 (B-148): each admin's Overview cards. The same permission as the Overview itself (`tenant:manage`
 * or `platform:manage`); each card then needs its own (`audit:read` for the audit card, `platform:manage` for
 * instances and capacity, `workflows:manage` for running workflows, a queue's review permission for SLA, and
 * `knowledge:read` for revisions waiting), checked by `OverviewCards` on every read and save. A person only ever
 * reads and changes their own layout. Saves and resets are audited (`overview.cards.updated`, `overview.cards.reset`).
 */
export function overviewCardRoutes(s: Services): Router {
  const r = Router();
  r.use('/overview-cards', noStore, requireAuth(), requireAnyPermission(s, ['tenant:manage', 'platform:manage']));
  const ctx = (req: Request) => ({ ip: ip(req), traceId: req.traceId ?? null });

  r.get('/overview-cards', async (req, res) => {
    res.json(await s.overviewCards.layout(principalOf(req)));
  });

  r.put('/overview-cards', async (req, res) => {
    const b = parseBody(prefsBody, req.body);
    res.json(await s.overviewCards.save(principalOf(req), b, ctx(req)));
  });

  r.delete('/overview-cards', async (req, res) => {
    res.json(await s.overviewCards.reset(principalOf(req), ctx(req)));
  });

  // The figures of the optional cards named (and shown to the person); `cards` is a comma-separated list.
  r.get('/overview-cards/data', async (req, res) => {
    const q = parseBody(z.object({ cards: z.string().max(400).default('') }).strict(), req.query);
    res.json(await s.overviewCards.extras(principalOf(req), q.cards.split(',').map((x) => x.trim()).filter(Boolean)));
  });

  return r;
}
