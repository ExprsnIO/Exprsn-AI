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
