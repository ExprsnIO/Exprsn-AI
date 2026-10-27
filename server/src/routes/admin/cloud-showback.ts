import { Router, type Request } from 'express';
import { z } from 'zod';
import type { CloudActor } from '../../cloud/accounts.js';
import { cloudAudit } from '../../cloud/audit.js';
import { BASES, monthKey, type Basis, type CostType } from '../../cloud/showback.js';
import { forbidden, notFound } from '../../http/problem.js';
import { ip, noStore, parseBody, principalOf, requireAnyPermission, requireAuth, requirePermission } from '../../http/middleware.js';
import type { Services } from '../../services.js';

/*
 * 1.9.99-final, Sprint 61 (B-10604): showback (`cloud/showback.ts`). Reads need `finops:read`; a platform admin
 * (`platform:manage`) sees every tenant and the unallocated line (and may name one with `?tenant=`), anyone else their
 * own tenant only. Rules and "compute now" are the platform's (`finops:manage` and `platform:manage`); the statement
 * setting is the tenant's own (`finops:manage` or `tenant:manage`; another tenant's needs `platform:manage`). Without
 * migration 155 every read answers 503 `migration_pending`; without 164 the rules and the setting cannot be changed
 * (503), and showback is computed with the default rules on request.
 *
 *   GET  /admin/cloud/showback?month=YYYY-MM&tenant=     the month's showback per tenant and workspace, per currency
 *   GET  /admin/cloud/showback/export?month&tenant&format=csv|json   the same as a download (audited)
 *   POST /admin/cloud/showback/:month/compute            recompute and store a month
 *   GET  /admin/cloud/showback/rules                     the rule per cost type
 *   PUT  /admin/cloud/showback/rules                     { rules: { <costType>: <basis> } }
 *   GET  /admin/cloud/showback/settings?tenant=          { statementLines }
 *   PUT  /admin/cloud/showback/settings?tenant=          { statementLines: boolean }
 */

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'a month is YYYY-MM');
const readQuery = z.object({ month: month.optional(), tenant: id26.optional(), format: z.enum(['csv', 'json']).optional() }).strict();
const basis = z.enum(BASES).optional();
const rulesBody = z.object({ rules: z.object({ gpu: basis, model: basis, compute: basis, database: basis, storage: basis, network: basis, other: basis }).strict() }).strict();
const settingsBody = z.object({ statementLines: z.boolean() }).strict();
const actorOf = (req: Request): CloudActor => ({ principal: principalOf(req), ip: ip(req), traceId: req.traceId });

export function cloudShowbackRoutes(s: Services): Router {
  const r = Router();
  const read = [noStore, requireAuth(), requirePermission(s, 'finops:read')];
  const manage = [noStore, requireAuth(), requirePermission(s, 'finops:manage')];
  const sb = () => s.cloud.showback;

  /** The tenant a settings request is about: the caller's own, or another one for platform admins. */
  const tenantOf = async (req: Request, t?: string): Promise<string> => {
    const p = principalOf(req);
    if (!t || t === p.tenantId) return p.tenantId;
    if (!s.cloud.accounts.isPlatformAdmin(p)) throw forbidden('The showback settings of another tenant are for platform admins.', { step: 'tenant' });
    if (!(await s.tenants.byId(t))) throw notFound('Tenant');
    return t;
  };

  r.get('/cloud/showback', ...read, async (req, res) => {
    const q = parseBody(readQuery, req.query);
    res.json(await sb().report(principalOf(req), q.month ?? monthKey(Date.now()), q.tenant ? { tenantId: q.tenant } : {}));
  });

  r.get('/cloud/showback/export', ...read, async (req, res) => {
    const q = parseBody(readQuery, req.query);
    const m = q.month ?? monthKey(Date.now());
    const p = principalOf(req);
    const format = q.format ?? 'csv';
    const body = format === 'csv' ? await sb().csv(p, m, q.tenant ? { tenantId: q.tenant } : {}) : JSON.stringify(await sb().report(p, m, q.tenant ? { tenantId: q.tenant } : {}), null, 2);
    await cloudAudit(s, { tenantId: p.tenantId, action: 'cloud.showback.exported', actor: actorOf(req), detail: { month: m, format, tenant: q.tenant ?? null } });
    res.setHeader('Content-Disposition', `attachment; filename="showback-${m}.${format}"`);
    res.type(format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json').send(body);
  });

  r.post('/cloud/showback/:month/compute', ...manage, async (req, res) => {
    res.json(await sb().computeNow(actorOf(req), parseBody(month, req.params.month)));
  });

  r.get('/cloud/showback/rules', ...read, async (_req, res) => {
    res.json({ installed: await sb().installed(), rules: await sb().ruleView(), bases: BASES });
  });

  r.put('/cloud/showback/rules', ...manage, async (req, res) => {
    const b = parseBody(rulesBody, req.body);
    const rules = Object.fromEntries(Object.entries(b.rules).filter(([, v]) => v)) as Partial<Record<CostType, Basis>>;
    res.json({ installed: true, rules: await sb().setRules(actorOf(req), rules), bases: BASES });
  });

  r.get('/cloud/showback/settings', ...read, async (req, res) => {
    const q = parseBody(z.object({ tenant: id26.optional() }).strict(), req.query);
    const tenantId = await tenantOf(req, q.tenant);
    res.json({ tenantId, installed: await sb().installed(), statementLines: await sb().statementLinesOn(tenantId) });
  });

  r.put('/cloud/showback/settings', noStore, requireAuth(), requireAnyPermission(s, ['finops:manage', 'tenant:manage']), async (req, res) => {
    const q = parseBody(z.object({ tenant: id26.optional() }).strict(), req.query);
    const tenantId = await tenantOf(req, q.tenant);
    const b = parseBody(settingsBody, req.body);
    res.json({ installed: true, ...(await sb().setStatementLines(actorOf(req), tenantId, b.statementLines)) });
  });

  return r;
}
