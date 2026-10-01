/*
 * Sprint 23, integrations: ordered webhooks across instances through one delivery lease per endpoint in the
 * database (B-1504), and billing with prorated mid-month price changes and Stripe refunds, credit notes and disputes
 * (B-1505).
 */
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { segmentsFor } from '../src/billing/service.js';
import { createServices, type Services } from '../src/services.js';
import { createLogger, Metrics } from '../src/observability/index.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';
import { FakeStripe } from './sprint13-fakes.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A receiver that answers slowly and records how many deliveries were in flight at once. */
class SlowReceiver {
  got: { id: string; seq: string | undefined }[] = [];
  inFlight = 0;
  maxInFlight = 0;
  delayMs = 40;
  url = '';
  private readonly server: Server = createServer((req, res) => {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      setTimeout(() => {
        this.got.push({ id: (JSON.parse(body) as { id: string }).id, seq: req.headers['x-exprsn-sequence'] as string | undefined });
        this.inFlight--;
        res.writeHead(200);
        res.end('ok');
      }, this.delayMs);
    });
  });
  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }
}

describe('B-1504: ordered webhooks across instances', () => {
  let h: Harness;
  let other: Services;
  let hook: SlowReceiver;
  beforeEach(async () => {
    h = await harness({ WEBHOOK_RETRY_BASE_MS: '10', WEBHOOK_MAX_ATTEMPTS: '3', WEBHOOK_BREAKER_THRESHOLD: '50' });
    // A second instance on the same database, with the same keys (as a second replica would have).
    other = createServices(h.s.cfg, h.s.db, createLogger('silent', false), new Metrics(), {});
    hook = await new SlowReceiver().start();
  });
  afterEach(async () => {
    await other.close();
    await h.close();
    await hook.stop();
  });

  it('ordered events raised on two instances arrive in order, one delivery in flight at a time', async () => {
    await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    const a = await loginAdmin(h, 'ta');
    const w = (await a.agent.post('/api/admin/webhooks').set('x-csrf-token', a.csrf).send({ name: 'ledger', url: `${hook.url}/hook`, events: ['demo.*'], ordered: true }).expect(201)).body;
    expect(h.s.webhooks.instance).not.toBe(other.webhooks.instance);

    // Events alternate between the instances; each instance queues in the order its events happen.
    const order: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const s = i % 2 ? h.s : other;
      await s.webhooks.emit(h.tenantId, 'demo.step', 'internal', `ev-${i}`, { i });
      order.push(`ev-${i}`);
    }
    // And a burst raised on both at once: positions are still unique and gap-free.
    await Promise.all([7, 8, 9, 10].map((i) => (i % 2 ? h.s : other).webhooks.emit(h.tenantId, 'demo.step', 'internal', `ev-${i}`, { i })));
    const rows = (await h.s.db('webhook_deliveries').where({ webhook_id: w.id }).orderBy('seq')) as { seq: number; event_id: string }[];
    expect(rows.map((r) => Number(r.seq))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(rows.slice(0, 6).map((r) => r.event_id)).toEqual(order);
    expect((await h.s.db('webhook_order').where({ webhook_id: w.id }).first()).next_seq).toBe(11);

    // Both instances work the job queue at once.
    for (let i = 0; i < 80 && hook.got.length < 10; i++) {
      await Promise.all([h.s.jobs.runDue(), other.jobs.runDue()]);
      await sleep(10);
    }
    expect(hook.got.map((g) => g.seq)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    expect(hook.got.map((g) => g.id)).toEqual(rows.map((r) => r.event_id));
    expect(hook.maxInFlight).toBe(1);
    expect((await h.s.db('webhook_order').where({ webhook_id: w.id }).first()).holder).toBeNull();
  });

  it('the delivery lease keeps a second instance from sending while the first holds it', async () => {
    await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    const a = await loginAdmin(h, 'ta');
    const w = (await a.agent.post('/api/admin/webhooks').set('x-csrf-token', a.csrf).send({ name: 'ledger', url: `${hook.url}/hook`, events: ['demo.*'], ordered: true }).expect(201)).body;
    hook.delayMs = 150;
    await h.s.webhooks.emit(h.tenantId, 'demo.step', 'internal', 'ev-1', {});
    const head = (await h.s.db('webhook_deliveries').where({ webhook_id: w.id }).first()) as { id: string };
    // The same head is picked up on both instances at once (a duplicated job, a slow instance): one sends.
    const first = h.s.webhooks.deliver(head.id);
    await sleep(30);
    const lease = (await h.s.db('webhook_order').where({ webhook_id: w.id }).first()) as { holder: string; delivery_id: string; lease_until: number };
    expect(lease).toMatchObject({ holder: h.s.webhooks.instance, delivery_id: head.id });
    expect(Number(lease.lease_until)).toBeGreaterThan(Date.now());
    expect(await other.webhooks.deliver(head.id)).toEqual({ deferred: 'lease held by another instance' });
    expect(await first).toMatchObject({ delivered: 200 });
    // When the lease has gone, the other instance finds the delivery already handled.
    expect(await other.webhooks.deliver(head.id)).toEqual({ skipped: 'delivery is succeeded' });
    expect(hook.got).toHaveLength(1);

    // A holder that died: its lease runs out and another instance takes over.
    await h.s.webhooks.emit(h.tenantId, 'demo.step', 'internal', 'ev-2', {});
    const next = (await h.s.db('webhook_deliveries').where({ webhook_id: w.id, event_id: 'ev-2' }).first()) as { id: string };
    await h.s.db('webhook_order').where({ webhook_id: w.id }).update({ holder: 'dead-instance', delivery_id: next.id, lease_until: Date.now() + 60_000 });
    expect(await other.webhooks.deliver(next.id)).toEqual({ deferred: 'lease held by another instance' });
    await h.s.db('webhook_order').where({ webhook_id: w.id }).update({ lease_until: Date.now() - 1 });
    expect(await other.webhooks.deliver(next.id)).toMatchObject({ delivered: 200 });
    expect(hook.got.map((g) => g.id)).toEqual(['ev-1', 'ev-2']);
  });
});

describe('B-1505: proration, refunds, credit notes and disputes', () => {
  let h: Harness;
  let stripe: FakeStripe;
  const SECRET = 'whsec_test_reconcile';
  beforeEach(async () => {
    stripe = await new FakeStripe().start();
    h = await harness({ BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: stripe.key, STRIPE_API_URL: stripe.url, STRIPE_WEBHOOK_SECRET: SECRET });
  });
  afterEach(async () => {
    await h.close();
    await stripe.stop();
  });

  const stripeEvent = (body: object) => {
    const raw = JSON.stringify(body);
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex');
    return request(h.app).post('/billing/stripe/webhook').set('content-type', 'application/json').set('stripe-signature', `t=${t},v1=${sig}`).send(raw);
  };
  const item = (price: number) => [{ match: 'any', value: null, usage: '*', meter: 'prompt_tokens', perUnits: 1_000_000, unitPriceMicros: price }];

  it('splits a month at the moments its prices changed', () => {
    const m = 202609;
    const sep = Date.UTC(2026, 8, 1);
    const mid = Date.UTC(2026, 8, 16);
    const parts = segmentsFor([{ items: [], effective_from: 0 }, { items: item(2) as never, effective_from: mid }], m);
    expect(parts.map((p) => [p.from, p.to])).toEqual([[sep, mid], [mid, Date.UTC(2026, 9, 1)]]);
    expect(segmentsFor([{ items: [], effective_from: Date.UTC(2026, 7, 3) }], m)).toHaveLength(1);
    // A book created mid-month prices the whole month from its first version.
    expect(segmentsFor([{ items: [], effective_from: mid }], m).map((p) => p.from)).toEqual([sep]);
  });

  it('prorates a mid-month price change in this month\'s statement', async () => {
    await localUser(h, 'root', ['system-admin'], 'restricted');
    const root = await loginAdmin(h, 'root');
    const send = (m: 'post' | 'patch', p: string, b: object = {}) => root.agent[m](p).set('x-csrf-token', root.csrf).send(b);
    const now = new Date();
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const book = (await send('post', '/api/admin/billing/price-books', { name: 'P', currency: 'USD', isDefault: true, items: item(1_000_000) }).expect(201)).body;
    // One million tokens before the change and two million after it.
    const change = start + Math.floor((Date.now() - start) / 2);
    await h.s.quotas.record({ tenantId: h.tenantId, workspaceId: null, userId: null, kind: 'chat', model: 'm', promptTokens: 1_000_000, outputTokens: 0, gpuMs: 0, ts: start + 1000 });
    await h.s.quotas.record({ tenantId: h.tenantId, workspaceId: null, userId: null, kind: 'chat', model: 'm', promptTokens: 2_000_000, outputTokens: 0, gpuMs: 0, ts: Date.now() - 500 });
    // Not before this month, not in the future, and only with new items.
    await send('patch', `/api/admin/billing/price-books/${book.id}`, { items: item(3_000_000), effectiveFrom: new Date(start - 86_400_000).toISOString() }).expect(409);
    await send('patch', `/api/admin/billing/price-books/${book.id}`, { items: item(3_000_000), effectiveFrom: new Date(Date.now() + 86_400_000).toISOString() }).expect(409);
    await send('patch', `/api/admin/billing/price-books/${book.id}`, { name: 'Q', effectiveFrom: new Date(change).toISOString() }).expect(400);
    const changed = (await send('patch', `/api/admin/billing/price-books/${book.id}`, { items: item(3_000_000), effectiveFrom: new Date(change).toISOString() }).expect(200)).body;
    expect(changed.versions.map((v: { effectiveFrom: string | null }) => v.effectiveFrom)).toEqual([null, new Date(change).toISOString()]);
    const audit = (await h.s.db('audit_events').where({ action: 'billing.price-book.updated' }).first()) as { detail: string };
    expect(JSON.parse(audit.detail)).toMatchObject({ effectiveFrom: new Date(change).toISOString() });

    const st = (await root.agent.get(`/api/admin/billing/statements/${month}`).expect(200)).body;
    // 1M at 1.00 plus 2M at 3.00 = 7.00, not 9.00 (all at the new price) or 3.00 (all at the old).
    expect(st).toMatchObject({ prorated: true, subtotalMicros: 7_000_000, totalMicros: 7_000_000 });
    expect(st.lines.filter((l: { meter: string }) => l.meter === 'prompt_tokens').map((l: { quantity: number; amountMicros: number; from: number; to: number }) => [l.quantity, l.amountMicros, l.from, l.to])).toEqual([
      [1_000_000, 1_000_000, start, change],
      [2_000_000, 6_000_000, change, expect.any(Number)]
    ]);
    // The usage totals still match the meter.
    expect(st.totals.promptTokens).toBe(3_000_000);
  });

  it('a refunded invoice marks the statement refunded with the amount; credit notes and disputes are reconciled', async () => {
    await localUser(h, 'root', ['system-admin'], 'restricted');
    const root = await loginAdmin(h, 'root');
    const d = new Date();
    const lastMonthTs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 15);
    const last = new Date(lastMonthTs);
    const lastMonth = `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, '0')}`;
    const month = Number(lastMonth.replace('-', ''));
    await h.s.quotas.record({ tenantId: h.tenantId, workspaceId: null, userId: null, kind: 'chat', model: 'm', promptTokens: 10_000_000, outputTokens: 0, gpuMs: 0, ts: lastMonthTs });
    await root.agent.post('/api/admin/billing/price-books').set('x-csrf-token', root.csrf).send({ name: 'P', currency: 'USD', isDefault: true, items: item(1_000_000) }).expect(201);
    await root.agent.put(`/api/admin/billing/tenants/${h.tenantId}`).set('x-csrf-token', root.csrf).send({ billingCustomer: 'cus_9' }).expect(200);
    const pushed = (await root.agent.post(`/api/admin/billing/statements/${lastMonth}/push`).set('x-csrf-token', root.csrf).expect(200)).body;
    expect(pushed).toMatchObject({ state: 'pushed', totalMicros: 10_000_000 });

    await stripeEvent({ id: 'evt_paid', type: 'invoice.paid', data: { object: { id: 'in_1', object: 'invoice', amount_paid: 1000, charge: 'ch_1', payment_intent: 'pi_1' } } }).expect(200);
    const st = () => h.s.billing.statement(h.tenantId, month);
    expect(await st()).toMatchObject({ state: 'paid', provider_charge: 'ch_1', provider_payment: 'pi_1' });

    // A partial refund, then the rest (Stripe reports the running total on the charge).
    expect((await stripeEvent({ id: 'evt_r1', type: 'charge.refunded', data: { object: { id: 'ch_1', object: 'charge', amount: 1000, amount_refunded: 250, payment_intent: 'pi_1', invoice: null } } }).expect(200)).body.result).toMatch(/partly refunded/);
    expect(await st()).toMatchObject({ state: 'partly refunded', refunded_micros: 2_500_000 });
    await stripeEvent({ id: 'evt_r2', type: 'charge.refunded', data: { object: { id: 'ch_1', object: 'charge', amount: 1000, amount_refunded: 1000, invoice: 'in_1' } } }).expect(200);
    expect(await st()).toMatchObject({ state: 'refunded', refunded_micros: 10_000_000 });
    // An older event arriving late never lowers the amount.
    expect((await stripeEvent({ id: 'evt_r0', type: 'charge.refunded', data: { object: { id: 'ch_1', object: 'charge', amount: 1000, amount_refunded: 100 } } }).expect(200)).body.result).toMatch(/already recorded/);
    expect((await st())!.refunded_micros).toBe(10_000_000);
    const view = (await root.agent.get(`/api/admin/billing/statements/${lastMonth}`).expect(200)).body;
    expect(view).toMatchObject({ state: 'refunded', refundedMicros: 10_000_000 });
    const refundAudit = (await h.s.db('audit_events').where({ action: 'billing.statement.refunded' }).orderBy('seq')) as { detail: string; actor: string }[];
    expect(refundAudit).toHaveLength(2);
    expect(JSON.parse(refundAudit[1]!.detail)).toMatchObject({ refundedMicros: 10_000_000, full: true, state: 'refunded' });

    // Credit notes by id: issued, then one voided.
    await stripeEvent({ id: 'evt_c1', type: 'credit_note.created', data: { object: { id: 'cn_1', object: 'credit_note', invoice: 'in_1', total: 300, status: 'issued' } } }).expect(200);
    await stripeEvent({ id: 'evt_c2', type: 'credit_note.created', data: { object: { id: 'cn_2', object: 'credit_note', invoice: 'in_1', total: 200, status: 'issued' } } }).expect(200);
    expect(await st()).toMatchObject({ credited_micros: 5_000_000, credits: [{ id: 'cn_1', amountMicros: 3_000_000, state: 'issued' }, { id: 'cn_2', amountMicros: 2_000_000, state: 'issued' }] });
    await stripeEvent({ id: 'evt_c3', type: 'credit_note.voided', data: { object: { id: 'cn_2', object: 'credit_note', invoice: 'in_1', total: 200, status: 'void' } } }).expect(200);
    expect(await st()).toMatchObject({ credited_micros: 3_000_000 });
    expect(await h.s.db('audit_events').whereIn('action', ['billing.statement.credited', 'billing.statement.credit-voided'])).toHaveLength(3);

    // A dispute names the charge; losing it is recorded, winning it returns the statement to where it was.
    await stripeEvent({ id: 'evt_d1', type: 'charge.dispute.created', data: { object: { id: 'dp_1', object: 'dispute', charge: 'ch_1', amount: 1000, status: 'needs_response' } } }).expect(200);
    expect(await st()).toMatchObject({ state: 'disputed', disputed_micros: 10_000_000, dispute_status: 'needs_response' });
    await stripeEvent({ id: 'evt_d2', type: 'charge.dispute.closed', data: { object: { id: 'dp_1', object: 'dispute', charge: 'ch_1', amount: 1000, status: 'won' } } }).expect(200);
    expect(await st()).toMatchObject({ state: 'refunded', dispute_status: 'won' });
    await stripeEvent({ id: 'evt_d3', type: 'charge.dispute.created', data: { object: { id: 'dp_2', object: 'dispute', payment_intent: 'pi_1', amount: 500, status: 'warning_needs_response' } } }).expect(200);
    await stripeEvent({ id: 'evt_d4', type: 'charge.dispute.closed', data: { object: { id: 'dp_2', object: 'dispute', payment_intent: 'pi_1', amount: 500, status: 'lost' } } }).expect(200);
    expect(await st()).toMatchObject({ state: 'dispute lost', disputed_micros: 5_000_000, dispute_status: 'lost' });
    expect((await h.s.db('audit_events').whereIn('action', ['billing.statement.disputed', 'billing.statement.dispute-closed']).select('action')).map((x) => x.action)).toHaveLength(4);
    // Each event is applied once.
    expect((await stripeEvent({ id: 'evt_d4', type: 'charge.dispute.closed', data: { object: { id: 'dp_2', object: 'dispute', payment_intent: 'pi_1', amount: 500, status: 'lost' } } }).expect(200)).body).toMatchObject({ duplicate: true });
    // A refund for an unknown charge is acknowledged and ignored.
    expect((await stripeEvent({ id: 'evt_x', type: 'charge.refunded', data: { object: { id: 'ch_unknown', object: 'charge', amount: 5, amount_refunded: 5 } } }).expect(200)).body.result).toMatch(/ignored/);
    // A statement past its invoice is still final.
    await root.agent.post(`/api/admin/billing/statements/${lastMonth}/compute`).set('x-csrf-token', root.csrf).expect(409);
  });
});
