import { createHmac, timingSafeEqual } from 'node:crypto';

/*
 * The billing provider seam. `StripeProvider` creates an invoice through Stripe's REST API with plain `fetch`
 * (form-encoded, idempotency keys per statement and line), so a retried push never bills twice. No Stripe SDK.
 */

export interface InvoiceInput {
  customer: string;
  statementId: string;
  tenantId: string;
  month: string;
  currency: string;
  lines: { description: string; amountMinor: number }[];
}

export interface BillingProvider {
  readonly name: string;
  /** Creates the invoice and returns the provider's reference for it. */
  invoice(input: InvoiceInput): Promise<string>;
}

const form = (o: Record<string, string | number | boolean>): string =>
  Object.entries(o)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');

export class StripeProvider implements BillingProvider {
  readonly name = 'Stripe';

  constructor(private readonly o: { secretKey: string; apiUrl: string; timeoutMs: number; daysUntilDue: number }) {}

  private async post(path: string, body: Record<string, string | number | boolean>, idempotencyKey: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.o.apiUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.o.secretKey}`, 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': idempotencyKey },
      body: form(body),
      redirect: 'error',
      signal: AbortSignal.timeout(this.o.timeoutMs)
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = data.error as { message?: string } | undefined;
      throw new Error(`Stripe answered ${res.status}${err?.message ? `: ${err.message}` : ''}`);
    }
    return data;
  }

  async invoice(input: InvoiceInput): Promise<string> {
    const currency = input.currency.toLowerCase();
    // Pending invoice items first, then the invoice that collects them.
    for (const [i, l] of input.lines.entries()) {
      await this.post('/v1/invoiceitems', { customer: input.customer, currency, amount: l.amountMinor, description: l.description.slice(0, 500), 'metadata[statement]': input.statementId, 'metadata[tenant]': input.tenantId }, `exprsn-${input.statementId}-item-${i}`);
    }
    const inv = await this.post(
      '/v1/invoices',
      { customer: input.customer, currency, collection_method: 'send_invoice', days_until_due: this.o.daysUntilDue, auto_advance: false, pending_invoice_items_behavior: 'include', description: `Exprsn-AI usage, ${input.month}`, 'metadata[statement]': input.statementId, 'metadata[tenant]': input.tenantId, 'metadata[month]': input.month },
      `exprsn-${input.statementId}-invoice`
    );
    if (typeof inv.id !== 'string') throw new Error('Stripe returned no invoice id');
    return inv.id;
  }
}

/**
 * Checks a `Stripe-Signature` header (B-1005): `t=<unix seconds>` and one or more `v1=<hex>` signatures, each an
 * HMAC-SHA256 of `<t>.<raw body>` keyed with the endpoint's signing secret. The timestamp must be within
 * `toleranceSeconds` of now, which bounds replays; `v0` (test-mode legacy) signatures are ignored.
 */
export function verifyStripeSignature(secret: string, header: string | undefined, rawBody: Buffer | string, toleranceSeconds = 300, now = Date.now()): { ok: true; timestamp: number } | { ok: false; reason: string } {
  if (!header) return { ok: false, reason: 'no Stripe-Signature header' };
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't' && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === 'v1' && /^[0-9a-f]{64}$/i.test(v)) v1.push(v.toLowerCase());
  }
  if (t == null || !v1.length) return { ok: false, reason: 'the header has no timestamp or v1 signature' };
  if (Math.abs(now / 1000 - t) > toleranceSeconds) return { ok: false, reason: 'the timestamp is outside the tolerance' };
  const expected = createHmac('sha256', secret).update(`${t}.`).update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody).digest();
  const match = v1.some((sig) => {
    const b = Buffer.from(sig, 'hex');
    return b.length === expected.length && timingSafeEqual(b, expected);
  });
  return match ? { ok: true, timestamp: t } : { ok: false, reason: 'no signature matches' };
}
