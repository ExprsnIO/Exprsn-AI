import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../../audit/chain.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import { forbidden, notFound } from '../../http/problem.js';
import { ANALYTICS_DIMENSIONS, priceView } from '../../tenancy/analytics.js';
import { dayOf, dayToDate, monthOf } from '../../tenancy/quotas.js';
import type { Services } from '../../services.js';

const dayParam = z.coerce.number().int().min(20000101).max(29991231);

/** 1.6.0, Sprint 38a (B-7401, B-7402): the Analytics screen (usage:read) and the tenant's prices (tenant:manage, who also set quotas). */
export function analyticsAdminRoutes(s: Services): Router {
  const r = Router();
  r.use('/analytics', noStore, requireAuth(), requirePermission(s, 'usage:read'));
  const manage = requirePermission(s, 'tenant:manage');

  const range = (req: Request) => {
    const q = parseBody(z.object({ from: dayParam.optional(), to: dayParam.optional(), days: z.coerce.number().int().min(1).max(366).default(14), workspace: z.string().length(26).optional(), group: z.string().length(26).optional() }).passthrough(), req.query);
    const to = q.to ?? dayOf(Date.now());
    const from = q.from ?? dayOf(Date.now() - (q.days - 1) * 86_400_000);
    return { from, to, workspaceId: q.workspace ?? null, groupId: q.group ?? null };
  };

  const names = async (by: string, ids: string[]): Promise<Map<string, string>> => {
    const out = new Map<string, string>();
    if (!ids.length) return out;
    const table = { user: ['users', 'display_name'], workspace: ['workspaces', 'name'], tenant: ['tenants', 'name'], profile: ['profiles', 'display_name'], group: ['social_groups', 'name'], model: null }[by];
    if (table) for (const x of await s.db(table[0]!).whereIn('id', ids).select('id', `${table[1]} as name`)) out.set(String(x.id), String(x.name));
    return out;
  };

  r.get('/analytics/summary', async (req, res) => {
    const p = principalOf(req);
    const { by } = parseBody(z.object({ by: z.enum(ANALYTICS_DIMENSIONS).default('workspace') }).passthrough(), req.query);
    const { from, to, workspaceId, groupId } = range(req);
    if (by === 'tenant' && !p.roles.includes('system-admin')) throw forbidden('Analytics across tenants is for system admins.', { step: 'tenant' });
    const { rows, currency } = await s.analytics.summary(by === 'tenant' ? null : p.tenantId, by, from, to, { workspaceId, groupId });
    const n = await names(by, rows.map((x) => x.key).filter((k): k is string => !!k));
    const total = rows.reduce((a, x) => ({ requests: a.requests + x.requests, messages: a.messages + x.messages, runs: a.runs + x.runs, tokens: a.tokens + x.tokens, prompt: a.prompt + x.prompt, output: a.output + x.output, gpuMs: a.gpuMs + x.gpuMs, cost: a.cost == null || x.cost == null ? null : Math.round((a.cost + x.cost) * 1e6) / 1e6 }), { requests: 0, messages: 0, runs: 0, tokens: 0, prompt: 0, output: 0, gpuMs: 0, cost: rows.length ? 0 : null } as { requests: number; messages: number; runs: number; tokens: number; prompt: number; output: number; gpuMs: number; cost: number | null });
    res.json({ by, from: dayToDate(from), to: dayToDate(to), currency, rows: rows.map((x) => ({ ...x, name: x.key ? (n.get(x.key) ?? x.key) : by === 'workspace' ? 'No workspace' : by === 'group' ? 'No group' : 'Unknown' })), total });
  });

  r.get('/analytics/daily', async (req, res) => {
    const p = principalOf(req);
    const { from, to, workspaceId } = range(req);
    const rows = await s.analytics.daily(p.tenantId, from, to, workspaceId);
    const byDay = new Map(rows.map((x) => [x.day, x]));
    const out: { day: string; messages: number; runs: number; tokens: number; gpuSeconds: number }[] = [];
    for (let t = Date.UTC(+String(from).slice(0, 4), +String(from).slice(4, 6) - 1, +String(from).slice(6, 8)); dayOf(t) <= to; t += 86_400_000) {
      const d = byDay.get(dayOf(t));
      out.push({ day: dayToDate(dayOf(t)), messages: d?.messages ?? 0, runs: d?.runs ?? 0, tokens: d?.tokens ?? 0, gpuSeconds: Math.round((d?.gpuMs ?? 0) / 1000) });
    }
    res.json(out);
  });

  r.get('/analytics/prices', async (req, res) => {
    const p = principalOf(req);
    res.json({ prices: (await s.analytics.prices(p.tenantId)).map(priceView) });
  });

  r.put('/analytics/prices', manage, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ scope: z.enum(['model', 'pool']), ref: z.string().trim().min(1).max(200), currency: z.string().trim().regex(/^[A-Za-z]{3}$/), inputPerMillion: z.coerce.number().min(0).max(1e9).default(0), outputPerMillion: z.coerce.number().min(0).max(1e9).default(0), gpuHour: z.coerce.number().min(0).max(1e9).default(0), note: z.string().trim().max(300).nullable().optional() }).strict(), req.body);
    const existing = await s.analytics.prices(p.tenantId);
    if (existing.length && existing[0]!.currency !== body.currency.toUpperCase()) throw forbidden(`This tenant's prices are in ${existing[0]!.currency}; one currency per tenant.`, { step: 'currency' });
    const price = await s.analytics.setPrice(p.tenantId, body, p.userId);
    await s.audit.append({ tenantId: p.tenantId, action: 'analytics.price.set', kind: 'admin', actor: actorFrom(p, ip(req)), target: { scope: price.scope, ref: price.ref }, detail: { currency: price.currency, inputPerMillion: price.input_per_million, outputPerMillion: price.output_per_million, gpuHour: price.gpu_hour }, traceId: req.traceId });
    res.json(priceView(price));
  });

  r.delete('/analytics/prices/:id', manage, async (req, res) => {
    const p = principalOf(req);
    const price = await s.analytics.deletePrice(p.tenantId, String(req.params.id));
    if (!price) throw notFound('Price');
    await s.audit.append({ tenantId: p.tenantId, action: 'analytics.price.removed', kind: 'admin', actor: actorFrom(p, ip(req)), target: { scope: price.scope, ref: price.ref }, traceId: req.traceId });
    res.status(204).end();
  });

  /** B-7402: the chargeback for a month per workspace, as JSON or CSV. Audited. */
  r.get('/analytics/chargeback', async (req, res) => {
    const p = principalOf(req);
    const q = parseBody(z.object({ month: z.coerce.number().int().min(200001).max(299912).optional(), workspace: z.string().length(26).optional(), format: z.enum(['json', 'csv']).default('json') }).passthrough(), req.query);
    const month = q.month ?? monthOf(Date.now());
    const ws = q.workspace ? await s.tenants.workspace(p.tenantId, q.workspace) : null;
    if (q.workspace && !ws) throw notFound('Workspace');
    const c = await s.analytics.chargeback(p.tenantId, month, ws?.id ?? null);
    await s.audit.append({ tenantId: p.tenantId, action: 'analytics.chargeback.exported', kind: 'admin', actor: actorFrom(p, ip(req)), target: { month, workspace: ws?.id ?? null }, detail: { rows: c.rows.length, format: q.format, total: c.total }, traceId: req.traceId });
    if (q.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="chargeback-${p.tenantSlug}-${ws ? ws.name.replace(/[^A-Za-z0-9-]+/g, '-').toLowerCase() + '-' : ''}${String(month).slice(0, 4)}-${String(month).slice(4, 6)}.csv"`);
      res.send(s.analytics.chargebackCsv(c));
      return;
    }
    res.json({ ...c, workspace: ws ? { id: ws.id, name: ws.name } : null });
  });

  return r;
}
