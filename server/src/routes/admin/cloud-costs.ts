import { Router, type Request } from 'express';
import { z } from 'zod';
import type { CloudActor } from '../../cloud/accounts.js';
import { dayOf } from '../../cloud/costs.js';
import { monthOf } from '../../cloud/spend.js';
import { badRequest } from '../../http/problem.js';
import { ip, noStore, parseBody, principalOf, requireAnyPermission, requireAuth, requirePermission } from '../../http/middleware.js';
import type { Services } from '../../services.js';

/*
 * 1.9.99-final, Sprint 59 (B-10603): the ingested cloud costs (`cloud/costs.ts`). Reads need `finops:read` or
 * `cloud:read` and see only the accounts (and their deployments) the caller may see; "fetch now" needs
 * `finops:manage` (a platform account also `platform:manage`, checked in the service) and is refused when the account
 * was already fetched by hand this hour (each fetch is a paid provider request). Without migration 155 every route
 * answers 503 `migration_pending`. Periods are UTC days, `from` inclusive and `to` exclusive, at most 400 days;
 * the default is this month.
 *
 *   GET  /admin/cloud/costs                                     per account: this month's billed total, the budget's spend source, the last fetch
 *   GET  /admin/cloud/accounts/:id/costs?from&to&by&deployment  daily rows, or sums by day, deployment or service (by=day|deployment|service)
 *   GET  /admin/cloud/accounts/:id/costs/estimate-vs-actual     per deployment: the applied plans' estimate against the ingested rows
 *   GET  /admin/cloud/accounts/:id/costs/fetches                the last fetches (window, requests, rows, totals, error)
 *   POST /admin/cloud/accounts/:id/costs/fetch                  → 202 { jobId }: fetch now (one per account and hour)
 *   GET  /admin/cloud/deployments/:id/costs?from&to             one deployment: estimate against actual, with its daily rows
 *   GET  /admin/cloud/accounts/:id/costs/neurons?from&to        Sprint 61 (B-10608), Cloudflare: Workers AI neurons per day, analytics against metered
 */

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a day (YYYY-MM-DD)');
const periodQuery = z.object({ from: day.optional(), to: day.optional(), by: z.enum(['row', 'day', 'deployment', 'service']).optional(), deployment: id26.optional() }).strict();
const actorOf = (req: Request): CloudActor => ({ principal: principalOf(req), ip: ip(req), traceId: req.traceId });

function period(q: { from?: string; to?: string }): { from: string; to: string } {
  const m = monthOf(Date.now());
  const from = q.from ?? dayOf(m.start);
  const to = q.to ?? dayOf(m.end);
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (!Number.isFinite(span) || span <= 0) throw badRequest('`to` must be after `from`.');
  if (span > 400) throw badRequest('A period is at most 400 days.');
  return { from, to };
}

export function cloudCostRoutes(s: Services): Router {
  const r = Router();
  const read = [noStore, requireAuth(), requireAnyPermission(s, ['finops:read', 'cloud:read'])];
  const manage = [noStore, requireAuth(), requirePermission(s, 'finops:manage')];
  const c = () => s.cloud.costs;

  r.get('/cloud/costs', ...read, async (req, res) => {
    res.json({ installed: true, accounts: await c().summary(principalOf(req)) });
  });

  r.get('/cloud/accounts/:id/costs', ...read, async (req, res) => {
    await c().need();
    const q = parseBody(periodQuery, req.query);
    const a = await s.cloud.accounts.getFor(principalOf(req), parseBody(id26, req.params.id));
    const p = period(q);
    const by = q.by ?? 'row';
    const opts = { ...p, ...(q.deployment ? { deploymentId: q.deployment } : {}) };
    if (by === 'row') res.json({ account: { id: a.id, name: a.name, provider: a.provider }, ...p, rows: await c().rows(a.id, opts) });
    else res.json({ account: { id: a.id, name: a.name, provider: a.provider }, ...p, by, groups: await c().grouped(a.id, { ...opts, by }) });
  });

  r.get('/cloud/accounts/:id/costs/estimate-vs-actual', ...read, async (req, res) => {
    await c().need();
    const q = parseBody(periodQuery, req.query);
    const a = await s.cloud.accounts.getFor(principalOf(req), parseBody(id26, req.params.id));
    res.json(await c().estimateVsActual(a, period(q)));
  });

  r.get('/cloud/accounts/:id/costs/fetches', ...read, async (req, res) => {
    await c().need();
    const a = await s.cloud.accounts.getFor(principalOf(req), parseBody(id26, req.params.id));
    res.json({ eligible: c().eligibility(a), billing: await c().billingState(a.id), fetches: await c().fetches(a.id) });
  });

  r.get('/cloud/accounts/:id/costs/neurons', ...read, async (req, res) => {
    await c().need();
    const q = parseBody(periodQuery, req.query);
    const a = await s.cloud.accounts.getFor(principalOf(req), parseBody(id26, req.params.id));
    if (a.provider !== 'cloudflare') throw badRequest('The neuron check is for Cloudflare accounts (Workers AI).');
    res.json({ account: { id: a.id, name: a.name, provider: a.provider }, tolerance: 0.01, ...(await c().neuronCheck(a.id, period(q))) });
  });

  r.post('/cloud/accounts/:id/costs/fetch', ...manage, async (req, res) => {
    res.status(202).json(await c().requestFetch(actorOf(req), parseBody(id26, req.params.id)));
  });

  r.get('/cloud/deployments/:id/costs', ...read, async (req, res) => {
    await c().need();
    const q = parseBody(periodQuery, req.query);
    const d = await s.cloud.deployments.getFor(principalOf(req), parseBody(id26, req.params.id));
    const a = await s.cloud.accounts.getFor(principalOf(req), d.accountId);
    const p = period(q);
    const eva = await c().estimateVsActual(a, { ...p, deploymentId: d.id });
    res.json({ deployment: { id: d.id, name: d.name, state: d.state }, ...eva, rows: await c().rows(a.id, { ...p, deploymentId: d.id }) });
  });

  return r;
}
