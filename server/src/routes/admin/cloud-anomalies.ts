import { Router, type Request } from 'express';
import { z } from 'zod';
import type { CloudActor } from '../../cloud/accounts.js';
import { spendOverview } from '../../cloud/spend-overview.js';
import { ip, noStore, parseBody, principalOf, requireAnyPermission, requireAuth, requirePermission } from '../../http/middleware.js';
import type { Services } from '../../services.js';

/*
 * 1.9.99-final, Sprint 62 (B-10606, B-10607): spend anomalies (`cloud/anomalies.ts`) and the Cloud spend screen's
 * overview (`cloud/spend-overview.ts`). Reads need `finops:read` or `cloud:read` and see only the accounts the caller
 * may see; acknowledging needs `finops:manage` (a platform account also `platform:manage`, checked in the service).
 * Without migration 155 every route answers 503 `migration_pending`; without 166 the anomaly routes do.
 *
 *   GET  /admin/cloud/spend?month=YYYY-MM                  daily spend per provider, totals, model calls priced at metering, GPU savings
 *   GET  /admin/cloud/anomalies?state&account&from&to&limit the anomalies on the accounts one may see, newest day first
 *   GET  /admin/cloud/anomalies/:id                        one anomaly with its top contributors
 *   POST /admin/cloud/anomalies/:id/acknowledge            { note? } stops repeat notices for its account and service
 */

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a day (YYYY-MM-DD)');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'a month is YYYY-MM');
const listQuery = z.object({ state: z.enum(['open', 'acknowledged']).optional(), account: id26.optional(), from: day.optional(), to: day.optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).strict();
const spendQuery = z.object({ month: month.optional() }).strict();
const ackBody = z.object({ note: z.string().trim().max(500).optional() }).strict();
const actorOf = (req: Request): CloudActor => ({ principal: principalOf(req), ip: ip(req), traceId: req.traceId });

export function cloudAnomalyRoutes(s: Services): Router {
  const r = Router();
  const read = [noStore, requireAuth(), requireAnyPermission(s, ['finops:read', 'cloud:read'])];
  const manage = [noStore, requireAuth(), requirePermission(s, 'finops:manage')];
  const an = () => s.cloud.anomalies;

  r.get('/cloud/spend', ...read, async (req, res) => {
    const q = parseBody(spendQuery, req.query);
    res.json(await spendOverview(s, principalOf(req), q.month ?? new Date().toISOString().slice(0, 7)));
  });

  r.get('/cloud/anomalies', ...read, async (req, res) => {
    const q = parseBody(listQuery, req.query);
    res.json({ anomalies: await an().list(principalOf(req), { state: q.state, accountId: q.account, from: q.from, to: q.to, limit: q.limit }) });
  });

  r.get('/cloud/anomalies/:id', ...read, async (req, res) => {
    res.json(await an().get(principalOf(req), parseBody(id26, req.params.id)));
  });

  r.post('/cloud/anomalies/:id/acknowledge', ...manage, async (req, res) => {
    const b = parseBody(ackBody, req.body ?? {});
    res.json(await an().acknowledge(actorOf(req), parseBody(id26, req.params.id), b.note || null));
  });

  return r;
}
