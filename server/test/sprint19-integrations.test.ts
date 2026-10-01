/*
 * Sprint 19, integrations: webhooks with ordered delivery and Ed25519 signatures under a published key (B-1004), and
 * billing with per-tenant price books, currency and taxes, reconciled from signed Stripe webhooks (B-1005).
 */
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyStripeSignature } from '../src/billing/stripe.js';
import { verifyEd25519, verifySignature } from '../src/webhooks/service.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';
import { FakeReceiver, FakeStripe } from './sprint13-fakes.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('B-1004: ordered webhooks and Ed25519 signatures', () => {
  let h: Harness;
  let hook: FakeReceiver;
  beforeEach(async () => {
    h = await harness({ WEBHOOK_RETRY_BASE_MS: '10', WEBHOOK_MAX_ATTEMPTS: '3', WEBHOOK_BREAKER_THRESHOLD: '50' });
    hook = await new FakeReceiver().start();
  });
  afterEach(async () => {
    await h.close();
    await hook.stop();
  });

  async function admin() {
    await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    const c = await loginAdmin(h, 'ta');
    return { ...c, post: (p: string, b: object = {}) => c.agent.post(p).set('x-csrf-token', c.csrf).send(b), patch: (p: string, b: object) => c.agent.patch(p).set('x-csrf-token', c.csrf).send(b) };
  }
  const drain = async (rounds = 30) => {
    for (let i = 0; i < rounds; i++) {
      await h.s.jobs.runDue();
      await sleep(15);
    }
  };

  it('ordered deliveries arrive in event order, even when the first one has to be retried', async () => {
    const a = await admin();
    const w = (await a.post('/api/admin/webhooks', { name: 'ledger', url: `${hook.url}/hook`, events: ['demo.*'], ordered: true }).expect(201)).body;
    expect(w).toMatchObject({ ordered: true, signing: 'hmac' });
    // The endpoint fails the first attempt it sees.
    let calls = 0;
    const orig = hook.status;
    const statusFor = () => (calls++ === 0 ? 500 : orig);
    Object.defineProperty(hook, 'status', { get: statusFor, configurable: true });
    // Five events at once, as a burst of audit appends would give.
    await Promise.all([1, 2, 3, 4, 5].map((i) => h.s.webhooks.emit(h.tenantId, 'demo.step', 'internal', `ev-${i}`, { i })));
    const rows = (await h.s.db('webhook_deliveries').where({ webhook_id: w.id }).orderBy('seq')) as { seq: number; event_id: string; next_attempt_at: number | null }[];
    expect(rows.map((r) => [Number(r.seq), r.event_id])).toEqual([1, 2, 3, 4, 5].map((i) => [i, `ev-${i}`]));
    // Only the head is scheduled; the rest wait for their turn.
    expect(rows.filter((r) => r.next_attempt_at != null)).toHaveLength(1);
    await drain();
    const ok = hook.got.filter((_, i) => i > 0);
    expect(hook.got).toHaveLength(6);
    expect(JSON.parse(hook.got[0]!.body).id).toBe('ev-1'); // the failed first attempt
    expect(ok.map((g) => JSON.parse(g.body).id)).toEqual(['ev-1', 'ev-2', 'ev-3', 'ev-4', 'ev-5']);
    expect(ok.map((g) => g.headers['x-exprsn-sequence'])).toEqual(['1', '2', '3', '4', '5']);
    expect((await h.s.db('webhook_deliveries').where({ webhook_id: w.id, state: 'succeeded' })).length).toBe(5);

    // A delivery that gives up does not block the ones after it: the endpoint refuses ev-6 every time.
    Object.defineProperty(hook, 'status', { get: () => (JSON.parse(hook.got.at(-1)!.body).id === 'ev-6' ? 500 : 200), configurable: true });
    const before = hook.got.length;
    await h.s.webhooks.emit(h.tenantId, 'demo.step', 'internal', 'ev-6', {});
    await h.s.webhooks.emit(h.tenantId, 'demo.step', 'internal', 'ev-7', {});
    await drain();
    const states = (await h.s.db('webhook_deliveries').where({ webhook_id: w.id }).whereIn('event_id', ['ev-6', 'ev-7']).orderBy('seq')) as { event_id: string; state: string }[];
    expect(states.map((x) => `${x.event_id}:${x.state}`)).toEqual(['ev-6:failed', 'ev-7:succeeded']);
    expect(hook.got.slice(before).map((g) => JSON.parse(g.body).id)).toEqual(['ev-6', 'ev-6', 'ev-6', 'ev-7']);

    // Turning ordering off releases anything waiting.
    await a.patch(`/api/admin/webhooks/${w.id}`, { ordered: false }).expect(200);
    expect((await h.s.db('audit_events').where({ action: 'webhook.updated' }).first()).detail).toContain('"ordered":false');
  });

  it('an Ed25519 signature verifies with the published key; rotation keeps the old key published', async () => {
    const a = await admin();
    expect((await a.agent.get('/api/admin/webhooks/signing-key').expect(200)).body).toMatchObject({ active: null, jwksUrl: 'http://localhost:8080/webhooks/keys/default' });
    const w = (await a.post('/api/admin/webhooks', { name: 'signed', url: `${hook.url}/hook`, events: ['demo.*'], signing: 'ed25519' }).expect(201)).body;
    expect(w).toMatchObject({ signing: 'ed25519', ordered: false });
    expect(w.secret).toMatch(/^whsec_/); // the shared secret still exists, for switching back
    const key = (await a.agent.get('/api/admin/webhooks/signing-key').expect(200)).body;
    expect(key.active.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const sealed = (await h.s.db('webhook_signing_keys').first()) as { private_sealed: string };
    expect(sealed.private_sealed).toMatch(/^v2\./);

    await h.s.webhooks.emit(h.tenantId, 'demo.signed', 'internal', 'ev-signed', { hello: 'world' });
    await drain(5);
    const got = hook.got[0]!;
    expect(got.headers['x-exprsn-signature']).toBeUndefined();
    expect(got.headers['x-exprsn-key-id']).toBe(key.active.kid);
    // The receiver fetches the JWKS without signing in, and verifies.
    const jwks = (await request(h.app).get('/webhooks/keys/default').expect(200)).body as { keys: { kid: string; x: string; kty: string; crv: string; alg: string }[] };
    const jwk = jwks.keys.find((k) => k.kid === got.headers['x-exprsn-key-id'])!;
    expect(jwk).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA' });
    const ts = String(got.headers['x-exprsn-timestamp']);
    const sig = String(got.headers['x-exprsn-signature-ed25519']);
    expect(verifyEd25519(jwk.x, ts, sig, got.body)).toBe(true);
    expect(verifyEd25519(jwk.x, ts, sig, got.body.replace('world', 'w0rld'))).toBe(false);
    expect(verifyEd25519(jwk.x, String(Number(ts) - 3600), sig, got.body)).toBe(false);
    // Not an HMAC with the shared secret.
    expect(verifySignature(w.secret, ts, sig, got.body)).toBe(false);
    await request(h.app).get('/webhooks/keys/nope').expect(404);

    const rotated = (await a.post('/api/admin/webhooks/signing-key/rotate').expect(200)).body;
    expect(rotated.active.kid).not.toBe(key.active.kid);
    expect(rotated.retired.map((k: { kid: string }) => k.kid)).toEqual([key.active.kid]);
    const after = (await request(h.app).get('/webhooks/keys/default').expect(200)).body as { keys: { kid: string; status: string }[] };
    expect(after.keys.map((k) => `${k.kid === key.active.kid ? 'old' : 'new'}:${k.status}`).sort()).toEqual(['new:active', 'old:retired']);
    const actions = (await h.s.db('audit_events').whereIn('action', ['webhook.signing-key.created', 'webhook.signing-key.rotated']).select('action')).map((x) => x.action);
    expect(actions.sort()).toEqual(['webhook.signing-key.created', 'webhook.signing-key.rotated']);
    // Members cannot see or rotate the key.
    await localUser(h, 'mem', ['member']);
    const m = await login(h, 'mem');
    await m.agent.get('/api/admin/webhooks/signing-key').expect(403);
  });
});

describe('B-1005: billing per tenant, taxes and Stripe reconciliation', () => {
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

  const stripeEvent = (body: object, opts: { secret?: string; t?: number } = {}) => {
    const raw = JSON.stringify(body);
    const t = opts.t ?? Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', opts.secret ?? SECRET).update(`${t}.${raw}`).digest('hex');
    return request(h.app).post('/billing/stripe/webhook').set('content-type', 'application/json').set('stripe-signature', `t=${t},v1=${sig}`).send(raw);
  };

  it('prices from the tenant\'s own book in its currency, adds taxes, and a paid Stripe invoice marks the statement paid', async () => {
    await localUser(h, 'root', ['system-admin'], 'restricted');
    await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    const root = await loginAdmin(h, 'root');
    const ta = await loginAdmin(h, 'ta');
    const rpost = (p: string, b: object = {}) => root.agent.post(p).set('x-csrf-token', root.csrf).send(b);
    const rput = (p: string, b: object) => root.agent.put(p).set('x-csrf-token', root.csrf).send(b);
    const other = await h.s.tenants.create({ slug: 'other', name: 'Other' });

    const d = new Date();
    const lastMonthTs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 15);
    const last = new Date(lastMonthTs);
    const lastMonth = `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, '0')}`;
    await h.s.quotas.record({ tenantId: h.tenantId, workspaceId: null, userId: null, kind: 'chat', model: 'llama3.1:8b', promptTokens: 2_000_000, outputTokens: 0, gpuMs: 0, ts: lastMonthTs });

    const item = (price: number) => [{ match: 'any', value: null, usage: '*', meter: 'prompt_tokens', perUnits: 1_000_000, unitPriceMicros: price }];
    const platform = (await rpost('/api/admin/billing/price-books', { name: 'Platform USD', currency: 'USD', isDefault: true, items: item(1_000_000) }).expect(201)).body;
    const own = (await rpost('/api/admin/billing/price-books', { name: 'Northwind EUR', currency: 'EUR', isDefault: true, tenantId: h.tenantId, items: item(2_500_000) }).expect(201)).body;
    const theirs = (await rpost('/api/admin/billing/price-books', { name: 'Other GBP', currency: 'GBP', isDefault: true, tenantId: other.id, items: item(9_000_000) }).expect(201)).body;
    expect(own).toMatchObject({ tenantId: h.tenantId, isDefault: true });
    // Each tenant's own default does not unset the platform default.
    expect((await h.s.billing.book(platform.id)).is_default).toBe(true);
    // A tenant admin sees the platform books and its own, not another tenant's.
    const seen = (await ta.agent.get('/api/admin/billing/price-books').expect(200)).body.books.map((b: { name: string }) => b.name);
    expect(seen.sort()).toEqual(['Northwind EUR', 'Platform USD']);
    // Another tenant's book cannot be assigned; a book in another currency is refused once the tenant has one.
    await rput(`/api/admin/billing/tenants/${h.tenantId}`, { priceBookId: theirs.id }).expect(404);
    const set = (await rput(`/api/admin/billing/tenants/${h.tenantId}`, { billingCurrency: 'eur', taxRates: [{ name: 'VAT', ratePercent: 20 }, { name: 'Levy', ratePercent: 0.5 }], billingCustomer: 'cus_123' }).expect(200)).body;
    expect(set).toMatchObject({ billingCurrency: 'EUR', taxRates: [{ name: 'VAT', ratePercent: 20 }, { name: 'Levy', ratePercent: 0.5 }] });
    expect((await rput(`/api/admin/billing/tenants/${h.tenantId}`, { priceBookId: platform.id }).expect(409)).body.detail).toMatch(/is in USD; this tenant is billed in EUR/);

    const settings = (await ta.agent.get('/api/admin/billing/settings').expect(200)).body;
    expect(settings).toMatchObject({ billingCurrency: 'EUR', effectiveBook: { name: 'Northwind EUR' }, reconciliation: true });
    const st = (await ta.agent.get(`/api/admin/billing/statements/${lastMonth}`).expect(200)).body;
    // 2M prompt tokens at 2.50 per million = 5.00; VAT 20% = 1.00; levy 0.5% = 0.025.
    expect(st).toMatchObject({ currency: 'EUR', book: { name: 'Northwind EUR' }, subtotalMicros: 5_000_000, taxMicros: 1_025_000, totalMicros: 6_025_000, taxes: [{ name: 'VAT', ratePpm: 200_000, amountMicros: 1_000_000 }, { name: 'Levy', ratePpm: 5000, amountMicros: 25_000 }] });
    const csv = (await ta.agent.get(`/api/admin/billing/statements/${lastMonth}/export?format=csv`).expect(200)).text;
    expect(csv).toContain(`${lastMonth},tax,VAT,,,,,20%,1.000000,EUR,`);
    expect(csv).toContain(`${lastMonth},total,,,,,,,6.025000,EUR,`);

    const pushed = (await rpost(`/api/admin/billing/statements/${lastMonth}/push`).expect(200)).body;
    expect(pushed).toMatchObject({ state: 'pushed', providerRef: 'in_1' });
    expect(stripe.items.map((x) => [x.amount, x.currency])).toEqual([['500', 'eur'], ['100', 'eur'], ['3', 'eur']]);
    expect(stripe.items[1]!.description).toMatch(/VAT 20%$/);

    // The inbound webhook: an unsigned, badly signed or stale event is refused.
    const paid = { id: 'evt_paid_1', type: 'invoice.paid', data: { object: { id: 'in_1', object: 'invoice', amount_paid: 603, metadata: { statement: pushed.id } } } };
    await request(h.app).post('/billing/stripe/webhook').set('content-type', 'application/json').send(JSON.stringify(paid)).expect(400);
    await stripeEvent(paid, { secret: 'whsec_wrong' }).expect(400);
    await stripeEvent(paid, { t: Math.floor(Date.now() / 1000) - 3600 }).expect(400);
    expect((await ta.agent.get(`/api/admin/billing/statements/${lastMonth}`).expect(200)).body.state).toBe('pushed');

    const ok = (await stripeEvent(paid).expect(200)).body;
    expect(ok).toMatchObject({ received: true, duplicate: false });
    const after = (await ta.agent.get(`/api/admin/billing/statements/${lastMonth}`).expect(200)).body;
    expect(after).toMatchObject({ state: 'paid', providerStatus: 'invoice.paid' });
    expect(after.paidAt).toBeGreaterThan(0);
    // Stripe delivers again: applied once.
    expect((await stripeEvent(paid).expect(200)).body).toMatchObject({ duplicate: true });
    expect(await h.s.db('audit_events').where({ action: 'billing.statement.paid' })).toHaveLength(1);
    const ev = (await h.s.db('audit_events').where({ action: 'billing.statement.paid' }).first()) as { tenant_id: string; actor: string };
    expect(ev.tenant_id).toBe(h.tenantId);
    // A late failure never undoes a payment; a paid statement is final.
    expect((await stripeEvent({ id: 'evt_fail_late', type: 'invoice.payment_failed', data: { object: { id: 'in_1', object: 'invoice' } } }).expect(200)).body.result).toMatch(/already paid/);
    await rpost(`/api/admin/billing/statements/${lastMonth}/compute`).expect(409);
    await rpost(`/api/admin/billing/statements/${lastMonth}/push`).expect(409);
    // Events for unknown invoices or other types are acknowledged and logged.
    expect((await stripeEvent({ id: 'evt_x', type: 'customer.created', data: { object: { id: 'cus_1', object: 'customer' } } }).expect(200)).body.result).toMatch(/ignored/);
    expect(await h.s.db('billing_provider_events')).toHaveLength(3);
  });

  it('marks a failed payment, then a voided invoice', async () => {
    await localUser(h, 'root', ['system-admin'], 'restricted');
    const root = await loginAdmin(h, 'root');
    const d = new Date();
    const lastMonthTs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 15);
    const last = new Date(lastMonthTs);
    const lastMonth = `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, '0')}`;
    await h.s.quotas.record({ tenantId: h.tenantId, workspaceId: null, userId: null, kind: 'chat', model: 'm', promptTokens: 1_000_000, outputTokens: 0, gpuMs: 0, ts: lastMonthTs });
    await root.agent.post('/api/admin/billing/price-books').set('x-csrf-token', root.csrf).send({ name: 'P', currency: 'USD', isDefault: true, items: [{ match: 'any', value: null, usage: '*', meter: 'prompt_tokens', perUnits: 1_000_000, unitPriceMicros: 1_000_000 }] }).expect(201);
    await root.agent.put(`/api/admin/billing/tenants/${h.tenantId}`).set('x-csrf-token', root.csrf).send({ billingCustomer: 'cus_9' }).expect(200);
    await root.agent.post(`/api/admin/billing/statements/${lastMonth}/push`).set('x-csrf-token', root.csrf).expect(200);
    await stripeEvent({ id: 'evt_f', type: 'invoice.payment_failed', data: { object: { id: 'in_1', object: 'invoice' } } }).expect(200);
    expect((await h.s.billing.statement(h.tenantId, Number(lastMonth.replace('-', ''))))!.state).toBe('payment failed');
    await stripeEvent({ id: 'evt_v', type: 'invoice.voided', data: { object: { id: 'in_1', object: 'invoice' } } }).expect(200);
    expect((await h.s.billing.statement(h.tenantId, Number(lastMonth.replace('-', ''))))!.state).toBe('void');
    const actions = (await h.s.db('audit_events').whereIn('action', ['billing.statement.payment-failed', 'billing.statement.voided']).select('action')).map((x) => x.action).sort();
    expect(actions).toEqual(['billing.statement.payment-failed', 'billing.statement.voided']);
  });

  it('checks Stripe-Signature headers: several v1 values, tolerance, and nothing without a secret', async () => {
    const raw = '{"id":"evt_1"}';
    const t = 1_790_000_000;
    const good = createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex');
    expect(verifyStripeSignature(SECRET, `t=${t},v1=${'0'.repeat(64)},v1=${good},v0=abc`, raw, 300, t * 1000)).toEqual({ ok: true, timestamp: t });
    expect(verifyStripeSignature(SECRET, `t=${t},v1=${good}`, raw, 300, (t + 301) * 1000)).toMatchObject({ ok: false });
    expect(verifyStripeSignature(SECRET, `v1=${good}`, raw, 300, t * 1000)).toMatchObject({ ok: false });
    expect(verifyStripeSignature(SECRET, undefined, raw)).toMatchObject({ ok: false });
    const bare = await harness({});
    try {
      await request(bare.app).post('/billing/stripe/webhook').set('content-type', 'application/json').send(raw).expect(404);
    } finally {
      await bare.close();
    }
  });
});
