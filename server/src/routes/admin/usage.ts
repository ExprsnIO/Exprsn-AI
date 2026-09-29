import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../../audit/chain.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import { forbidden } from '../../http/problem.js';
import { dayOf, dayToDate } from '../../tenancy/quotas.js';
import type { Services } from '../../services.js';
import { exportView } from './audit.js';

const dayParam = z.coerce.number().int().min(20000101).max(29991231);

/** Metering and quotas, read by auditors and tenant admins (usage:read). */
export function usageAdminRoutes(s: Services): Router {
  const r = Router();
  r.use(['/usage', '/quotas'], noStore, requireAuth(), requirePermission(s, 'usage:read'));

  const range = (req: Request) => {
    const q = parseBody(z.object({ from: dayParam.optional(), to: dayParam.optional(), days: z.coerce.number().int().min(1).max(366).default(14), workspace: z.string().length(26).optional() }), req.query);
    const to = q.to ?? dayOf(Date.now());
    const from = q.from ?? dayOf(Date.now() - (q.days - 1) * 86_400_000);
    return { from, to, workspace: q.workspace };
  };

  r.get('/usage/summary', async (req, res) => {
    const p = principalOf(req);
    const { by } = parseBody(z.object({ by: z.enum(['user', 'model', 'workspace', 'tenant', 'profile']).default('user') }).passthrough(), req.query);
    const { from, to, workspace } = range(req);
    if (by === 'tenant' && !p.roles.includes('system-admin')) throw forbidden('Usage across tenants is for system admins.', { step: 'tenant' });
    const rows = await s.quotas.summary(by === 'tenant' ? null : p.tenantId, by, from, to, workspace);
    const ids = rows.map((x) => x.key).filter((k): k is string => !!k);
    const names = new Map<string, string>();
    if (ids.length) {
      const table = { user: ['users', 'display_name'], workspace: ['workspaces', 'name'], tenant: ['tenants', 'name'], profile: ['profiles', 'display_name'], model: null }[by];
      if (table && (await s.db.schema.hasTable(table[0]!))) {
        for (const x of await s.db(table[0]!).whereIn('id', ids).select('id', `${table[1]} as name`)) names.set(String(x.id), String(x.name));
      }
    }
    res.json({ by, from: dayToDate(from), to: dayToDate(to), rows: rows.map((x) => ({ ...x, name: x.key ? (names.get(x.key) ?? x.key) : by === 'workspace' ? 'No workspace' : 'Unknown' })) });
  });

  r.get('/usage/daily', async (req, res) => {
    const p = principalOf(req);
    const { from, to, workspace } = range(req);
    const rows = await s.quotas.daily(p.tenantId, from, to, workspace);
    // Every day in the range, zero-filled, so the chart and its table have one entry per day.
    const out: { day: string; tokens: number; gpuSeconds: number }[] = [];
    const byDay = new Map(rows.map((x) => [x.day, x]));
    for (let t = Date.UTC(+String(from).slice(0, 4), +String(from).slice(4, 6) - 1, +String(from).slice(6, 8)); dayOf(t) <= to; t += 86_400_000) {
      const d = byDay.get(dayOf(t));
      out.push({ day: dayToDate(dayOf(t)), tokens: d?.tokens ?? 0, gpuSeconds: Math.round((d?.gpuMs ?? 0) / 1000) });
    }
    res.json(out);
  });

  /** Quotas and current use for the tenant and each of its workspaces. */
  r.get('/quotas', async (req, res) => {
    const p = principalOf(req);
    const workspaces = await s.tenants.workspaces(p.tenantId);
    const [tenant, ...ws] = await Promise.all([s.quotas.view(p.tenantId, null), ...workspaces.map((w) => s.quotas.view(p.tenantId, w.id))]);
    res.json({ tenant, workspaces: workspaces.map((w, i) => ({ id: w.id, name: w.name, label: w.label_ceiling, ...ws[i] })) });
  });

  r.post('/usage/exports', async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ from: dayParam.optional(), to: dayParam.optional(), workspaceId: z.string().length(26).optional() }), req.body);
    const ws = body.workspaceId ? await s.tenants.workspace(p.tenantId, body.workspaceId) : null;
    const from = body.from ?? dayOf(Date.now() - 29 * 86_400_000);
    const to = body.to ?? dayOf(Date.now());
    const x = await s.exports.request({ tenantId: p.tenantId, tenantSlug: p.tenantSlug, kind: 'usage', params: { from, to, ...(ws ? { workspaceId: ws.id } : {}) }, scope: `Usage, ${ws ? ws.name : 'all workspaces'}, ${dayToDate(from)} to ${dayToDate(to)}, per day, user and model`, maxLabel: 'internal', userId: p.userId });
    await s.audit.append({ tenantId: p.tenantId, action: 'usage.export.requested', kind: 'admin', actor: actorFrom(p, ip(req)), target: { export: x.id }, detail: { from, to, workspace: ws?.id ?? null }, traceId: req.traceId });
    res.status(202).json(exportView(x));
  });

  return r;
}
