import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../../audit/chain.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import { HttpProblem } from '../../http/problem.js';
import { codeView, ruleView, type RuleInput } from '../../billing/discounts.js';
import { METERS } from '../../billing/service.js';
import type { Services } from '../../services.js';

/*
 * 1.9.0, Sprint 51 (B-165): discount rules, promotion codes, negotiated discounts and their approvals.
 *
 * - Rules, codes, the policy (cap and approval thresholds) and approvals: `billing:manage` (platform billing admins).
 *   A rule above the threshold waits for a second holder; the proposer cannot approve it (403, step `dual-control`).
 * - Redeeming a code: `tenant:manage` (tenant admins), for the caller's own tenant.
 * - A tenant's own redemptions: `billing:read`.
 *
 * Audited: `billing.discount.*` and `billing.promo.*`. Mounted by `billingAdminRoutes`.
 */
const id26 = z.string().length(26);
const isoTime = z
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
const ppm = z.number().int().min(1).max(1_000_000);
const terms = z
  .object({
    percentPpm: ppm.optional(),
    amountMinor: z.number().int().min(1).max(1e12).optional(),
    quantity: z.number().positive().max(1e15).optional(),
    meter: z.enum(METERS).optional(),
    measure: z.enum(['quantity', 'amount']).optional(),
    tiers: z.array(z.object({ from: z.number().min(0).max(1e15), percentPpm: ppm }).strict()).min(1).max(20).optional(),
    minMonths: z.number().int().min(1).max(36).optional()
  })
  .strict();
const target = z.discriminatedUnion('kind', [z.object({ kind: z.literal('all') }).strict(), z.object({ kind: z.literal('tenants'), ids: z.array(id26).min(1).max(500) }).strict(), z.object({ kind: z.literal('plans'), ids: z.array(id26).min(1).max(100) }).strict()]);
const ruleFields = {
  name: z.string().trim().min(1).max(100),
  scope: z.enum(['plan', 'seats', 'meter', 'model', 'family', 'statement']),
  scopeValue: z.string().trim().min(1).max(200).nullable(),
  kind: z.enum(['percent', 'amount', 'allowance', 'volume', 'commitment']),
  terms,
  currency: z.string().regex(/^[A-Za-z]{3}$/).transform((c) => c.toUpperCase()).nullable(),
  validFrom: isoTime.nullable(),
  validTo: isoTime.nullable(),
  target,
  stackOrder: z.number().int().min(0).max(10_000),
  note: z.string().trim().max(300).nullable()
};
const createRule = z
  .object({ ...ruleFields, source: z.enum(['rule', 'promotion', 'negotiated']).default('rule'), scopeValue: ruleFields.scopeValue.default(null), currency: ruleFields.currency.default(null), validFrom: ruleFields.validFrom.default(null), validTo: ruleFields.validTo.default(null), target: target.default({ kind: 'all' }), stackOrder: ruleFields.stackOrder.default(100), note: ruleFields.note.default(null) })
  .strict();
const patchRule = z
  .object({ name: ruleFields.name, scope: ruleFields.scope, scopeValue: ruleFields.scopeValue, kind: ruleFields.kind, terms, currency: ruleFields.currency, validFrom: ruleFields.validFrom, validTo: ruleFields.validTo, target, stackOrder: ruleFields.stackOrder, note: ruleFields.note, state: z.literal('retired') })
  .partial()
  .strict();
const decision = z.object({ note: z.string().trim().max(300).nullable().default(null) }).strict();
const codeText = z.string().trim().regex(/^[A-Za-z0-9-]{4,40}$/, 'a code is 4 to 40 letters, digits or dashes');

export function billingDiscountRoutes(s: Services): Router {
  const r = Router();
  r.use(['/billing/discounts', '/billing/discount-approvals', '/billing/discount-policy', '/billing/promo-codes', '/billing/redemptions'], noStore, requireAuth());
  const manage = requirePermission(s, 'billing:manage');
  const read = requirePermission(s, 'billing:read');
  const redeem = requirePermission(s, 'tenant:manage');
  const d = s.billing.discounts;

  const audit = (req: Request, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>, tenantId?: string) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: tenantId ?? p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, label: 'internal', ...(detail ? { detail } : {}), traceId: req.traceId });
  };
  const summary = (x: { kind: string; scope: string; scopeValue: string | null; terms: unknown; target: unknown; source: string; stackOrder: number }) => ({ kind: x.kind, scope: x.scope, scopeValue: x.scopeValue, terms: x.terms, target: x.target, source: x.source, stackOrder: x.stackOrder });

  // ---------- rules ----------

  r.get('/billing/discounts', manage, async (req, res) => {
    const q = parseBody(z.object({ state: z.enum(['proposed', 'active', 'rejected', 'retired']).optional(), source: z.enum(['rule', 'promotion', 'negotiated']).optional(), tenant: id26.optional() }).strict(), req.query);
    res.json({ rules: (await d.rules({ state: q.state, source: q.source, tenantId: q.tenant })).map(ruleView), policy: await d.policy() });
  });

  r.get('/billing/discounts/:id', manage, async (req, res) => {
    const rule = await d.rule(parseBody(id26, req.params.id));
    res.json({ ...ruleView(rule), codes: rule.source === 'promotion' ? (await d.codes(rule.id)).map(codeView) : [], approvals: (await d.approvals()).filter((a) => a.ruleId === rule.id) });
  });

  r.post('/billing/discounts', manage, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(createRule, req.body) as RuleInput;
    if (body.source === 'negotiated' && body.target.kind === 'tenants') for (const t of body.target.ids) if (!(await s.tenants.byId(t))) throw new HttpProblem(404, 'Not found', 'Tenant not found.');
    const out = await d.create(p.userId, body);
    await audit(req, out.approval ? 'billing.discount.proposed' : 'billing.discount.created', { rule: out.rule.id, name: out.rule.name }, { ...summary(out.rule), state: out.rule.state, ...(out.reason ? { reason: out.reason, approval: out.approval!.id } : {}) });
    res.status(201).json({ rule: ruleView(out.rule), approval: out.approval, needsApproval: !!out.approval, reason: out.reason });
  });

  r.patch('/billing/discounts/:id', manage, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(patchRule, req.body) as Partial<RuleInput> & { state?: 'retired' };
    const out = await d.update(p.userId, parseBody(id26, req.params.id), body);
    const action = body.state === 'retired' ? 'billing.discount.retired' : out.approval ? 'billing.discount.change-proposed' : 'billing.discount.updated';
    await audit(req, action, { rule: out.rule.id, name: out.rule.name }, { changed: Object.keys(body), before: summary(out.before), after: summary(out.rule), ...(out.reason ? { reason: out.reason, approval: out.approval?.id ?? null } : {}) });
    res.json({ rule: ruleView(out.rule), approval: out.approval, needsApproval: !!out.approval, reason: out.reason });
  });

  // ---------- approvals (dual control) ----------

  r.get('/billing/discount-approvals', manage, async (req, res) => {
    const q = parseBody(z.object({ state: z.enum(['pending', 'approved', 'rejected']).optional() }).strict(), req.query);
    res.json({ approvals: await d.approvals(q.state) });
  });

  for (const verb of ['approve', 'reject'] as const) {
    r.post(`/billing/discount-approvals/:id/${verb}`, manage, async (req, res) => {
      const p = principalOf(req);
      const id = parseBody(id26, req.params.id);
      const { note } = parseBody(decision, req.body ?? {});
      try {
        const out = await d.decide(p.userId, id, verb, note);
        await audit(req, verb === 'approve' ? 'billing.discount.approved' : 'billing.discount.rejected', { rule: out.rule.id, name: out.rule.name, approval: id }, { change: out.approval.change, proposedBy: out.approval.proposedBy, note, state: out.rule.state });
        res.json({ approval: out.approval, rule: ruleView(out.rule) });
      } catch (err) {
        if (err instanceof HttpProblem && err.status === 403) await audit(req, 'billing.discount.approval-refused', { approval: id }, { reason: 'the proposer cannot decide' });
        throw err;
      }
    });
  }

  // ---------- policy ----------

  r.get('/billing/discount-policy', manage, async (_req, res) => {
    res.json(await d.policy());
  });

  r.put('/billing/discount-policy', manage, async (req, res) => {
    const p = principalOf(req);
    const n = (max: number) => z.number().int().min(0).max(max).nullable().optional();
    const body = parseBody(z.object({ capPercentPpm: n(1_000_000), capAmountMinor: n(1e12), approvalPercentPpm: n(1_000_000), approvalAmountMinor: n(1e12) }).strict(), req.body);
    const { before, after } = await d.setPolicy(p.userId, Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)));
    await audit(req, 'billing.discount.policy-updated', { policy: 'platform' }, { before, after });
    res.json(after);
  });

  // ---------- promotion codes ----------

  r.get('/billing/promo-codes', manage, async (req, res) => {
    const q = parseBody(z.object({ rule: id26.optional() }).strict(), req.query);
    res.json({ codes: (await d.codes(q.rule)).map(codeView) });
  });

  r.post('/billing/promo-codes', manage, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ ruleId: id26, code: codeText.nullable().default(null), expiresAt: isoTime.nullable().default(null), maxRedemptions: z.number().int().min(1).max(10_000_000).nullable().default(null) }).strict(), req.body);
    const code = await d.createCode(p.userId, body);
    await audit(req, 'billing.promo.created', { code: code.id, rule: code.ruleId }, { code: code.code, expiresAt: code.expiresAt, maxRedemptions: code.maxRedemptions });
    res.status(201).json(codeView(code));
  });

  r.patch('/billing/promo-codes/:id', manage, async (req, res) => {
    const body = parseBody(z.object({ expiresAt: isoTime.nullable().optional(), maxRedemptions: z.number().int().min(1).max(10_000_000).nullable().optional(), state: z.enum(['active', 'retired']).optional() }).strict(), req.body);
    const { before, after } = await d.updateCode(parseBody(id26, req.params.id), body);
    await audit(req, body.state === 'retired' ? 'billing.promo.retired' : 'billing.promo.updated', { code: after.id, rule: after.ruleId }, { changed: Object.keys(body), before: { expiresAt: before.expiresAt, maxRedemptions: before.maxRedemptions, state: before.state }, after: { expiresAt: after.expiresAt, maxRedemptions: after.maxRedemptions, state: after.state } });
    res.json(codeView(after));
  });

  /** A tenant admin redeems a code for the tenant of the session (never one named in the body). */
  r.post('/billing/promo-codes/redeem', redeem, async (req, res) => {
    const p = principalOf(req);
    const { code } = parseBody(z.object({ code: codeText }).strict(), req.body);
    const sub = await s.subscriptions.at(p.tenantId, Date.now()).catch(() => null);
    try {
      const out = await d.redeem(p.tenantId, p.userId, code, sub?.planId ?? null);
      await audit(req, 'billing.promo.redeemed', { code: out.code.id, rule: out.rule.id, tenant: p.tenantId }, { redemption: out.redemptionId, rule: out.rule.name, redemptions: out.code.redemptions, maxRedemptions: out.code.maxRedemptions });
      res.status(201).json({ redemptionId: out.redemptionId, rule: { id: out.rule.id, name: out.rule.name, scope: out.rule.scope, kind: out.rule.kind, terms: out.rule.terms, validTo: out.rule.validTo ? new Date(out.rule.validTo).toISOString() : null } });
    } catch (err) {
      // The caller learns only that the code did not work; the audit says why.
      const why = (err as { why?: string }).why;
      if (why) await audit(req, 'billing.promo.redeem-refused', { tenant: p.tenantId }, { reason: why, code: code.slice(0, 2) + '…' });
      throw err;
    }
  });

  r.get('/billing/redemptions', read, async (req, res) => {
    const p = principalOf(req);
    const rows = await d.redemptions({ tenantId: p.tenantId });
    res.json({ redemptions: rows });
  });

  return r;
}
