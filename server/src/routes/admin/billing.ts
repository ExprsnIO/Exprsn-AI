import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../../audit/chain.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import { forbidden, notFound } from '../../http/problem.js';
import { monthOf } from '../../tenancy/quotas.js';
import { bookView, METERS, monthToText, statementView } from '../../billing/service.js';
import type { Services } from '../../services.js';

const id26 = z.string().length(26);
const monthParam = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'a month is YYYY-MM').transform((m) => Number(m.replace('-', '')));
const item = z
  .object({
    match: z.enum(['model', 'profile', 'any']),
    value: z.string().trim().min(1).max(200).nullable().default(null),
    usage: z.string().regex(/^(\*|[a-z]+)$/).default('*'),
    meter: z.enum(METERS),
    perUnits: z.number().int().min(1).max(1_000_000_000),
    unitPriceMicros: z.number().int().min(0).max(1e15)
  })
  .strict()
  .refine((x) => (x.match === 'any') === (x.value == null), 'a model or profile item names it; an "any" item does not');
const currency = z.string().regex(/^[A-Za-z]{3}$/);
/** B-1505: when new prices take effect, as an ISO date or date-time (UTC unless an offset is given). */
const effectiveFrom = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/, 'an ISO date or date-time')
  .transform((v, ctx) => {
    const t = Date.parse(/T/.test(v) && !/(Z|[+-]\d{2}:\d{2})$/.test(v) ? `${v}Z` : v);
    if (Number.isNaN(t)) {
      ctx.addIssue({ code: 'custom', message: 'not a valid date' });
      return z.NEVER;
    }
    return t;
  });
const versionView = (v: { id: string; items: unknown[]; effective_from: number; created_at: number }) => ({ id: v.id, items: v.items.length, effectiveFrom: v.effective_from ? new Date(v.effective_from).toISOString() : null, createdAt: v.created_at });
const taxView = (x: { name: string; ratePpm: number }) => ({ name: x.name, ratePercent: x.ratePpm / 10_000 });

/**
 * Billing (Sprint 13, and Sprint 19: books owned by a tenant, a currency and taxes per tenant). Price books are kept by
 * holders of `billing:manage` (system admins), platform-wide or for one tenant; a
 * tenant's statements are read with `billing:read` (tenant admins, auditors). System admins may name another tenant
 * with `?tenant=`.
 */
export function billingAdminRoutes(s: Services): Router {
  const r = Router();
  r.use('/billing', noStore, requireAuth());
  const read = requirePermission(s, 'billing:read');
  const manage = requirePermission(s, 'billing:manage');
  const b = s.billing;

  const audit = (req: Request, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>, tenantId?: string) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: tenantId ?? p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, label: 'internal', ...(detail ? { detail } : {}), traceId: req.traceId });
  };

  /** The tenant a request is about: the caller's own, or another one for system admins. */
  const tenantOf = async (req: Request): Promise<string> => {
    const p = principalOf(req);
    const q = parseBody(z.object({ tenant: id26.optional() }).passthrough(), req.query);
    if (!q.tenant || q.tenant === p.tenantId) return p.tenantId;
    if (!p.roles.includes('system-admin')) throw forbidden('Statements of other tenants are for system admins.', { step: 'tenant' });
    if (!(await s.tenants.byId(q.tenant))) throw notFound('Tenant');
    return q.tenant;
  };

  // ---------- price books ----------

  r.get('/billing/price-books', read, async (req, res) => {
    const p = principalOf(req);
    // System admins see every book; others see the platform books and their tenant's own (B-1005).
    const books = p.roles.includes('system-admin') ? await b.books() : await b.books(p.tenantId);
    res.json({ books: books.map(bookView), meters: METERS, provider: b.providerName });
  });

  r.post('/billing/price-books', manage, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ name: z.string().trim().min(1).max(100), currency: currency.default('USD'), isDefault: z.boolean().default(false), items: z.array(item).max(500).default([]), tenantId: id26.nullable().optional() }).strict(), req.body);
    if (body.tenantId && !(await s.tenants.byId(body.tenantId))) throw notFound('Tenant');
    const book = await b.createBook(p.userId, body);
    await audit(req, 'billing.price-book.created', { priceBook: book.id, name: book.name, ...(book.tenant_id ? { tenant: book.tenant_id } : {}) }, { currency: book.currency, items: book.items.length, isDefault: book.is_default, tenant: book.tenant_id }, book.tenant_id ?? undefined);
    res.status(201).json(bookView(book));
  });

  r.patch('/billing/price-books/:id', manage, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ name: z.string().trim().min(1).max(100).optional(), currency: currency.optional(), isDefault: z.boolean().optional(), items: z.array(item).max(500).optional(), state: z.enum(['active', 'retired']).optional(), effectiveFrom: effectiveFrom.optional() }).strict(), req.body);
    const { before, after, effectiveFrom: from } = await b.updateBook(parseBody(id26, req.params.id), p.userId, body);
    await audit(req, 'billing.price-book.updated', { priceBook: after.id, name: after.name }, { changed: Object.keys(body), before: { items: before.items.length, state: before.state, isDefault: before.is_default }, after: { items: after.items.length, state: after.state, isDefault: after.is_default }, ...(from != null ? { effectiveFrom: new Date(from).toISOString() } : {}) });
    res.json({ ...bookView(after), versions: (await b.versions(after)).map(versionView) });
  });

  // ---------- tenant settings ----------

  r.get('/billing/settings', read, async (req, res) => {
    const tenantId = await tenantOf(req);
    const x = await s.integrations.get(tenantId);
    const book = await b.bookFor(tenantId);
    res.json({ tenantId, priceBookId: x.priceBookId, effectiveBook: book ? bookView(book) : null, billingCustomer: x.billingCustomer, billingCurrency: x.billingCurrency, taxRates: x.taxRates.map(taxView), provider: b.providerName, reconciliation: !!s.cfg.STRIPE_WEBHOOK_SECRET });
  });

  r.put('/billing/tenants/:tenantId', requirePermission(s, 'billing:manage', (req) => ({ tenantId: String(req.params.tenantId) })), async (req, res) => {
    const tenantId = parseBody(id26, req.params.tenantId);
    if (!(await s.tenants.byId(tenantId))) throw notFound('Tenant');
    const body = parseBody(
      z
        .object({
          priceBookId: id26.nullable().optional(),
          billingCustomer: z.string().trim().regex(/^[A-Za-z0-9_-]{1,100}$/).nullable().optional(),
          billingCurrency: currency.nullable().optional(),
          taxRates: z.array(z.object({ name: z.string().trim().min(1).max(40), ratePercent: z.number().min(0).max(100) }).strict()).max(5).optional()
        })
        .strict(),
      req.body
    );
    const before = await s.integrations.get(tenantId);
    const cur = body.billingCurrency !== undefined ? body.billingCurrency : before.billingCurrency;
    const bookId = body.priceBookId !== undefined ? body.priceBookId : before.priceBookId;
    if (bookId) await b.checkAssignable(tenantId, bookId, cur);
    const patch = { ...(body.priceBookId !== undefined ? { priceBookId: body.priceBookId } : {}), ...(body.billingCustomer !== undefined ? { billingCustomer: body.billingCustomer } : {}), ...(body.billingCurrency !== undefined ? { billingCurrency: body.billingCurrency } : {}), ...(body.taxRates ? { taxRates: body.taxRates.map((x) => ({ name: x.name, ratePpm: Math.round(x.ratePercent * 10_000) })) } : {}) };
    const after = await s.integrations.set(tenantId, patch, principalOf(req).userId);
    const summary = (x: typeof after) => ({ priceBookId: x.priceBookId, billingCustomer: x.billingCustomer, billingCurrency: x.billingCurrency, taxRates: x.taxRates.map(taxView) });
    await audit(req, 'billing.tenant.updated', { tenant: tenantId }, { before: summary(before), after: summary(after) }, tenantId);
    res.json({ tenantId, ...summary(after) });
  });

  // ---------- statements ----------

  r.get('/billing/statements', read, async (req, res) => {
    const tenantId = await tenantOf(req);
    const stored = await b.statements(tenantId);
    const current = monthOf(Date.now());
    const preview = stored.some((x) => x.month === current) ? null : statementView(await b.compute(tenantId, current));
    res.json({ tenantId, provider: b.providerName, current: monthToText(current), statements: [...(preview ? [preview] : []), ...stored.map(statementView)].map((x) => ({ ...x, lines: undefined, lineCount: x.lines.length })) });
  });

  r.get('/billing/statements/:month', read, async (req, res) => {
    const tenantId = await tenantOf(req);
    const month = parseBody(monthParam, req.params.month);
    const st = await b.statement(tenantId, month);
    res.json({ tenantId, ...statementView(st ?? (await b.compute(tenantId, month))) });
  });

  r.post('/billing/statements/:month/compute', manage, async (req, res) => {
    const tenantId = await tenantOf(req);
    const month = parseBody(monthParam, req.params.month);
    const st = await b.save(tenantId, month, { close: month < monthOf(Date.now()) });
    await audit(req, 'billing.statement.computed', { tenant: tenantId, month: monthToText(month), statement: st.id }, { totalMicros: st.total_micros, currency: st.currency, lines: st.lines.length, state: st.state }, tenantId);
    res.json({ tenantId, ...statementView(st) });
  });

  r.post('/billing/statements/:month/push', manage, async (req, res) => {
    const tenantId = await tenantOf(req);
    const month = parseBody(monthParam, req.params.month);
    try {
      const st = await b.push(tenantId, month);
      await audit(req, 'billing.statement.pushed', { tenant: tenantId, month: monthToText(month), statement: st.id }, { provider: b.providerName, ref: st.provider_ref, totalMicros: st.total_micros, currency: st.currency }, tenantId);
      res.json({ tenantId, ...statementView(st) });
    } catch (err) {
      await audit(req, 'billing.statement.push-failed', { tenant: tenantId, month: monthToText(month) }, { provider: b.providerName, error: String((err as Error).message).slice(0, 300) }, tenantId);
      throw err;
    }
  });

  r.get('/billing/statements/:month/export', read, async (req, res) => {
    const tenantId = await tenantOf(req);
    const month = parseBody(monthParam, req.params.month);
    const { format } = parseBody(z.object({ format: z.enum(['csv', 'json']).default('csv') }).passthrough(), req.query);
    const st = (await b.statement(tenantId, month)) ?? (await b.compute(tenantId, month));
    await audit(req, 'billing.statement.exported', { tenant: tenantId, month: monthToText(month) }, { format }, tenantId);
    const file = `statement-${tenantId.slice(-6).toLowerCase()}-${monthToText(month)}.${format}`;
    res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
    if (format === 'json') res.type('application/json').send(JSON.stringify({ tenantId, ...statementView(st) }, null, 2));
    else res.type('text/csv; charset=utf-8').send(b.toCsv(st));
  });

  return r;
}
