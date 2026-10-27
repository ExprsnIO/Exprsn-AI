import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../../audit/chain.js';
import { clears } from '../../authz/labels.js';
import { effectivePermissions } from '../../authz/policy.js';
import { ip, noStore, parseBody, principalOf, requireAnyPermission, requireAuth, requirePermission, requireRecentAuth } from '../../http/middleware.js';
import { forbidden, notFound } from '../../http/problem.js';
import { planVersionView, planView, versionInputSchema, type PlanActor, type PlanRow } from '../../billing/plans.js';
import { eventView, subscriptionView, type SubscriptionActor } from '../../billing/subscriptions.js';
import { statementPdf } from '../../billing/pdf.js';
import type { Services } from '../../services.js';

const id26 = z.string().length(26);
const note = z.object({ note: z.string().trim().max(500).nullable().optional() }).strict();
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
const planKey = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, 'a key is lower case letters, digits and dashes');
const cycleInput = z
  .object({ kind: z.enum(['monthly', 'quarterly', 'annual', 'custom']), months: z.number().int().min(1).max(36).optional(), anchorDay: z.number().int().min(1).max(28).optional() })
  .strict()
  .refine((c) => c.kind === 'custom' || c.months === undefined, 'only a custom cycle names its months')
  .refine((c) => c.kind !== 'custom' || c.months !== undefined, 'a custom cycle names its months');
const changeInput = z
  .object({ planId: id26.optional(), seats: z.number().int().min(1).max(1_000_000).optional(), when: z.enum(['now', 'renewal']).default('now') })
  .strict()
  .refine((x) => x.planId !== undefined || x.seats !== undefined, 'name a plan or a number of seats');

/**
 * 1.9.0, Sprint 51 (B-162, B-166): the plan catalogue, a tenant's subscription and the statement PDF.
 *
 * - Plans are platform-wide. Reading them takes `billing:read` (tenant admins see the visible, active plans; holders of
 *   `platform:manage` see every plan with its versions). Changing them takes `platform:manage` in a browser session
 *   signed in recently; a version (prices, allowances, entitlements) is in force only once a second platform admin
 *   approves it.
 * - A tenant's subscription is its own (the tenant comes from the session; system admins may name another with
 *   `?tenant=`). Reading it takes `billing:read`; changing it takes `billing:manage` or `tenant:manage` (its billing or
 *   tenant admin). Only platform admins use private plans or set the trial.
 * - `GET /billing/statements/{id}.pdf` (`billing:read`): a stored statement of the caller's tenant as PDF.
 */
export function billingPlanRoutes(s: Services): Router {
  const r = Router();
  const read = requirePermission(s, 'billing:read');
  const platform = [requireAuth({ sessionOnly: true }), requirePermission(s, 'platform:manage'), requireRecentAuth(s)];
  const change = requireAnyPermission(s, ['billing:manage', 'tenant:manage']);
  r.use(['/billing/plans', '/billing/subscription', '/billing/statements'], noStore, requireAuth());

  const isPlatform = (req: Request) => effectivePermissions(principalOf(req)).has('platform:manage');
  const planActor = (req: Request): PlanActor => {
    const p = principalOf(req);
    return { tenantId: p.tenantId, userId: p.userId, actor: actorFrom(p, ip(req)), traceId: req.traceId };
  };
  const subActor = (req: Request): SubscriptionActor => ({ ...planActor(req), platform: isPlatform(req) });
  /** Billing is labelled internal: a reader needs that clearance. */
  const cleared = (req: Request) => {
    if (!clears(principalOf(req).clearance, 'internal')) throw forbidden('Billing is internal; your clearance does not reach it.', { step: 'clearance' });
  };
  /** The tenant a request is about: the caller's own, or another one for system admins. */
  const tenantOf = async (req: Request): Promise<string> => {
    cleared(req);
    const p = principalOf(req);
    const q = parseBody(z.object({ tenant: id26.optional() }).passthrough(), req.query);
    if (!q.tenant || q.tenant === p.tenantId) return p.tenantId;
    if (!p.roles.includes('system-admin')) throw forbidden('Subscriptions of other tenants are for system admins.', { step: 'tenant' });
    if (!(await s.tenants.byId(q.tenant))) throw notFound('Tenant');
    return q.tenant;
  };

  const fullView = async (plan: PlanRow, withVersions: boolean) => {
    const versions = await s.plans.versions(plan.id);
    const current = versions.find((v) => v.version === plan.current_version) ?? null;
    const pending = versions.find((v) => v.state === 'pending') ?? null;
    return { ...planView(plan, current, withVersions ? pending : undefined), ...(withVersions ? { versions: versions.map(planVersionView) } : {}) };
  };

  // ---------- the plan catalogue ----------

  r.get('/billing/plans', read, async (req, res) => {
    cleared(req);
    const all = isPlatform(req);
    const q = parseBody(z.object({ retired: z.enum(['true', 'false']).optional() }).passthrough(), req.query);
    const plans = await s.plans.list({ includePrivate: all, includeRetired: all && q.retired === 'true' });
    const views = await Promise.all(plans.map((p) => fullView(p, all)));
    res.json({ plans: all ? views : views.filter((v) => v.subscribable), canManage: all });
  });

  r.get('/billing/plans/:id', read, async (req, res) => {
    cleared(req);
    const plan = await s.plans.get(parseBody(id26, req.params.id));
    const all = isPlatform(req);
    if (!all) {
      const mine = await s.subscriptions.current(principalOf(req).tenantId);
      if (plan.visibility === 'private' && mine?.planId !== plan.id) throw notFound('Plan');
    }
    res.json(await fullView(plan, all));
  });

  r.post('/billing/plans', ...platform, async (req, res) => {
    const body = parseBody(
      z
        .object({ key: planKey, name: z.string().trim().min(1).max(100), description: z.string().trim().max(1000).nullable().optional(), visibility: z.enum(['visible', 'private']).default('visible'), trialDays: z.number().int().min(0).max(365).default(0) })
        .extend(versionInputSchema.shape)
        .strict(),
      req.body
    );
    const { plan } = await s.plans.create(planActor(req), body);
    res.status(201).json(await fullView(plan, true));
  });

  r.patch('/billing/plans/:id', ...platform, async (req, res) => {
    const body = parseBody(z.object({ name: z.string().trim().min(1).max(100).optional(), description: z.string().trim().max(1000).nullable().optional(), visibility: z.enum(['visible', 'private']).optional(), state: z.enum(['active', 'retired']).optional(), trialDays: z.number().int().min(0).max(365).optional() }).strict(), req.body);
    const { after } = await s.plans.update(planActor(req), parseBody(id26, req.params.id), body);
    res.json(await fullView(after, true));
  });

  r.post('/billing/plans/:id/versions', ...platform, async (req, res) => {
    const id = parseBody(id26, req.params.id);
    const v = await s.plans.propose(planActor(req), id, parseBody(versionInputSchema, req.body));
    res.status(201).json(planVersionView(v));
  });

  r.post('/billing/plans/:id/versions/:version/approve', ...platform, async (req, res) => {
    const { note: n } = parseBody(note, req.body ?? {});
    const { plan } = await s.plans.approve(planActor(req), parseBody(id26, req.params.id), parseBody(z.coerce.number().int().min(1), req.params.version), n ?? null);
    res.json(await fullView(plan, true));
  });

  r.post('/billing/plans/:id/versions/:version/reject', ...platform, async (req, res) => {
    const { note: n } = parseBody(note, req.body ?? {});
    const v = await s.plans.reject(planActor(req), parseBody(id26, req.params.id), parseBody(z.coerce.number().int().min(1), req.params.version), n ?? null);
    res.json(planVersionView(v));
  });

  // ---------- a tenant's subscription ----------

  const subscriptionBody = async (tenantId: string) => {
    let sub = await s.subscriptions.current(tenantId);
    if (sub) sub = await s.subscriptions.advance(sub);
    const live = sub && !['cancelled', 'ended'].includes(sub.state) ? sub : null;
    const book = live ? await s.subscriptions.book([live]) : null;
    const history = await s.subscriptions.history(tenantId, { limit: 100 });
    return { tenantId, subscription: live && book ? subscriptionView(live, book) : null, history: history.map(eventView) };
  };

  r.get('/billing/subscription', read, async (req, res) => {
    res.json(await subscriptionBody(await tenantOf(req)));
  });

  r.get('/billing/subscription/periods', read, async (req, res) => {
    const tenantId = await tenantOf(req);
    const q = parseBody(z.object({ from: isoTime, to: isoTime }).passthrough(), req.query);
    if (q.to - q.from > 5 * 366 * 86_400_000) throw forbidden('Ask for at most five years at a time.', { step: 'range' });
    res.json({ tenantId, periods: await s.subscriptions.cycleDetail(tenantId, q.from, q.to), stretches: await s.subscriptions.periods(tenantId, q.from, q.to) });
  });

  r.post('/billing/subscription', change, async (req, res) => {
    const tenantId = await tenantOf(req);
    const body = parseBody(z.object({ planId: id26, seats: z.number().int().min(1).max(1_000_000).default(1), currency: z.string().regex(/^[A-Za-z]{3}$/), cycle: cycleInput, trialDays: z.number().int().min(0).max(365).optional(), endsAt: isoTime.nullable().optional() }).strict(), req.body);
    await s.subscriptions.subscribe(subActor(req), tenantId, body);
    res.status(201).json(await subscriptionBody(tenantId));
  });

  r.post('/billing/subscription/preview', change, async (req, res) => {
    const tenantId = await tenantOf(req);
    res.json(await s.subscriptions.preview(subActor(req), tenantId, parseBody(changeInput, req.body)));
  });

  r.patch('/billing/subscription', change, async (req, res) => {
    const tenantId = await tenantOf(req);
    const out = await s.subscriptions.change(subActor(req), tenantId, parseBody(changeInput, req.body));
    res.json({ ...(await subscriptionBody(tenantId)), proration: out.proration });
  });

  r.delete('/billing/subscription/scheduled-change', change, async (req, res) => {
    const tenantId = await tenantOf(req);
    await s.subscriptions.unschedule(subActor(req), tenantId);
    res.json(await subscriptionBody(tenantId));
  });

  r.post('/billing/subscription/cancel', change, async (req, res) => {
    const tenantId = await tenantOf(req);
    const { when } = parseBody(z.object({ when: z.enum(['period-end', 'now']).default('period-end') }).strict(), req.body ?? {});
    const out = await s.subscriptions.cancel(subActor(req), tenantId, when);
    res.json({ ...(await subscriptionBody(tenantId)), proration: out.proration });
  });

  r.post('/billing/subscription/keep', change, async (req, res) => {
    const tenantId = await tenantOf(req);
    await s.subscriptions.keep(subActor(req), tenantId);
    res.json(await subscriptionBody(tenantId));
  });

  r.post('/billing/subscription/pause', change, async (req, res) => {
    const tenantId = await tenantOf(req);
    const out = await s.subscriptions.pause(subActor(req), tenantId);
    res.json({ ...(await subscriptionBody(tenantId)), proration: out.proration });
  });

  r.post('/billing/subscription/resume', change, async (req, res) => {
    const tenantId = await tenantOf(req);
    const out = await s.subscriptions.resume(subActor(req), tenantId);
    res.json({ ...(await subscriptionBody(tenantId)), proration: out.proration });
  });

  // ---------- the statement PDF (B-166) ----------

  r.get('/billing/statements/:id.pdf', read, async (req, res) => {
    const tenantId = await tenantOf(req);
    const p = principalOf(req);
    const { pdf, doc, filename } = await statementPdf(s, tenantId, parseBody(id26, req.params.id), p.displayName || p.username);
    await s.audit.append({ tenantId, action: 'billing.statement.exported', kind: 'admin', actor: actorFrom(p, ip(req)), target: { tenant: tenantId, statement: doc.id, period: doc.periodText }, label: 'internal', detail: { format: 'pdf', lines: doc.lines.length }, traceId: req.traceId });
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.type('application/pdf').send(pdf);
  });

  return r;
}
