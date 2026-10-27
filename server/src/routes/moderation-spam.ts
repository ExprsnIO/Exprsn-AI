import { Router } from 'express';
import { z } from 'zod';
import type { Permission } from '../authz/permissions.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { policyInput } from '../spam/policy.js';
import type { Services } from '../services.js';

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const days = z.coerce.number().int().min(1).max(366).default(30);

/**
 * 1.9.0, Sprint 50 (B-158 to B-161): spam and flood, and the moderation metrics, under `/api/moderation`.
 * Reading the policy, the flagged accounts, responses, signals and metrics needs `moderation:review`; changing the
 * policy `moderation:manage`; lifting a response `moderation:sanction`. A person's own responses are in
 * `GET /api/moderation/spam/mine` (`moderation:appeal`, which every member holds).
 */
export function moderationSpamRoutes(s: Services): Router {
  const r = Router();
  r.use(['/moderation/spam', '/moderation/metrics'], noStore, requireAuth());
  const perm = (x: Permission) => requirePermission(s, x);
  const review = perm('moderation:review');
  const ctx = (req: Parameters<typeof ip>[0]) => ({ ip: ip(req), traceId: req.traceId ?? null });

  r.get('/moderation/spam/policy', review, async (req, res) => {
    res.json(await s.spam.policyView(principalOf(req).tenantId));
  });

  r.put('/moderation/spam/policy', perm('moderation:manage'), async (req, res) => {
    const body = parseBody(policyInput, req.body);
    res.json(await s.spam.savePolicy(principalOf(req), body, ctx(req)));
  });

  r.get('/moderation/spam/accounts', review, async (req, res) => {
    const q = parseBody(z.object({ min: z.coerce.number().int().min(0).max(100).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).strict(), req.query);
    res.json({ items: await s.spam.accounts(principalOf(req), q) });
  });

  r.get('/moderation/spam/responses', review, async (req, res) => {
    const q = parseBody(z.object({ state: z.enum(['active', 'lifted', 'expired']).optional(), userId: id26.optional() }).strict(), req.query);
    res.json({ items: await s.spam.responses(principalOf(req), q) });
  });

  r.post('/moderation/spam/responses/:id/lift', perm('moderation:sanction'), async (req, res) => {
    const id = parseBody(id26, req.params.id);
    const body = parseBody(z.object({ reason: z.string().trim().min(1).max(500).optional() }).strict(), req.body ?? {});
    res.json(await s.spam.lift(principalOf(req), id, body.reason ?? null, ctx(req)));
  });

  r.get('/moderation/spam/signals', review, async (req, res) => {
    res.json(await s.spam.signals(principalOf(req)));
  });

  r.get('/moderation/spam/mine', perm('moderation:appeal'), async (req, res) => {
    res.json({ items: await s.spam.mine(principalOf(req)) });
  });

  r.get('/moderation/metrics', review, async (req, res) => {
    const q = parseBody(z.object({ days }).strict(), req.query);
    res.json(await s.moderationMetrics.trend(principalOf(req), q.days));
  });

  r.get('/moderation/metrics/export', review, async (req, res) => {
    const q = parseBody(z.object({ days }).strict(), req.query);
    const csv = await s.moderationMetrics.csv(principalOf(req), q.days, ctx(req));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="moderation-metrics-${q.days}d.csv"`);
    res.send(csv);
  });

  return r;
}
