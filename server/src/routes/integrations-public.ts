import express, { Router } from 'express';
import { z } from 'zod';
import { HttpProblem, notFound } from '../http/problem.js';
import { verifyStripeSignature } from '../billing/stripe.js';
import { monthToText } from '../billing/service.js';
import type { Services } from '../services.js';

/*
 * Sprint 19 public endpoints, mounted at the root outside /api (no session, no CSRF):
 *   GET  /webhooks/keys/:tenant    the tenant's Ed25519 webhook signing keys as a JWKS (B-1004)
 *   POST /billing/stripe/webhook   Stripe events, authenticated by the Stripe-Signature header (B-1005)
 */
export function integrationPublicRoutes(s: Services): Router {
  const r = Router();

  r.get('/webhooks/keys/:tenant', async (req, res) => {
    const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).safeParse(req.params.tenant);
    if (!slug.success) throw notFound('Tenant');
    const t = await s.tenants.bySlug(slug.data);
    if (!t) throw notFound('Tenant');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(await s.webhooks.jwks(t.id));
  });

  // The raw body is what Stripe signed: it is read as bytes here, never through the JSON parser.
  r.post('/billing/stripe/webhook', express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
    const secret = s.cfg.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw notFound('Endpoint');
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const check = verifyStripeSignature(secret, req.get('stripe-signature'), raw, s.cfg.STRIPE_WEBHOOK_TOLERANCE_SECONDS);
    if (!check.ok) {
      s.log.warn({ reason: check.reason, ip: req.ip }, 'Stripe webhook refused');
      throw new HttpProblem(400, 'Invalid signature', 'The Stripe-Signature header does not verify.');
    }
    let event: { id?: unknown; type?: unknown; data?: { object?: Record<string, unknown> } };
    try {
      event = JSON.parse(raw.toString('utf8')) as typeof event;
    } catch {
      throw new HttpProblem(400, 'Invalid request', 'The body is not JSON.');
    }
    const parsed = z.object({ id: z.string().min(1).max(100), type: z.string().min(1).max(100) }).safeParse(event);
    if (!parsed.success) throw new HttpProblem(400, 'Invalid request', 'An event needs an id and a type.');
    const obj = event.data?.object ?? {};
    const isInvoice = obj.object === 'invoice' || parsed.data.type.startsWith('invoice.');
    const metadata = (obj.metadata ?? {}) as Record<string, unknown>;
    const out = await s.billing.reconcile('stripe', {
      id: parsed.data.id,
      type: parsed.data.type,
      invoiceId: isInvoice && typeof obj.id === 'string' ? obj.id : null,
      statementId: typeof metadata.statement === 'string' ? metadata.statement : null,
      amountPaidMinor: typeof obj.amount_paid === 'number' ? obj.amount_paid : null
    });
    if (out.transition && out.statement) {
      const st = out.statement;
      const action = out.transition === 'paid' ? 'billing.statement.paid' : out.transition === 'void' ? 'billing.statement.voided' : 'billing.statement.payment-failed';
      await s.audit.append({ tenantId: st.tenant_id, action, kind: 'system', actor: { service: 'stripe' }, target: { tenant: st.tenant_id, month: monthToText(st.month), statement: st.id }, label: 'internal', detail: { event: parsed.data.id, type: parsed.data.type, invoice: st.provider_ref, amountPaidMinor: typeof obj.amount_paid === 'number' ? obj.amount_paid : null, currency: st.currency }, traceId: req.traceId });
    }
    // Stripe retries anything but a 2xx: every verified event is acknowledged, applied or not.
    res.json({ received: true, duplicate: out.duplicate, result: out.result });
  });

  return r;
}
