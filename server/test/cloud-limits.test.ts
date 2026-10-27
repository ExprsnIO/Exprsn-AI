import client from 'prom-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cloudTransportMetrics } from '../src/cloud/limits-metrics.js';
import { apiClassOf, CloudProviderError, CloudTransport, DigitalOceanProvider, type ApiClass, type BreakerState, type CallContext, type TransportMetrics } from '../src/cloud/providers/index.js';
import type { CloudAccount, Provider } from '../src/cloud/types.js';
import { servicePolicy } from '../src/platform/egress.js';
import { MemoryCounterStore } from '../src/platform/ratelimit.js';
import { FakeDigitalOcean } from './fake-do.js';

/*
 * 1.9.99-final, Sprint 57 (B-10108): rate limits, retries and the circuit breaker of `CloudTransport`, against the
 * DigitalOcean fake on 127.0.0.1 (its injections stand in for the other providers' answers: what decides is the
 * transport's provider). No network, never a real provider.
 */

const policy = servicePolicy({ SERVICE_ALLOWED_HOSTS: '127.0.0.1' });
const fake = new FakeDigitalOcean();
let token = '';
const sleeps: number[] = [];
const fastSleep = async (ms: number) => void sleeps.push(ms);

const account = (provider: Provider, name: string): CloudAccount => ({
  id: `acc-${name}`,
  name,
  provider,
  scope: 'platform',
  tenantId: null,
  providerIds: {},
  credentialMode: 'vaulted',
  defaultRegion: 'ams3',
  state: 'active',
  description: null,
  regions: [],
  validation: null,
  createdBy: null,
  createdAt: 0,
  updatedAt: 0
});

/** A metrics sink that records what the transport reports. */
function recorder() {
  const waits: { provider: Provider; apiClass: ApiClass; reason: string; ms: number }[] = [];
  const calls: { apiClass: ApiClass; outcome: string }[] = [];
  const breaker: { from: BreakerState; to: BreakerState }[] = [];
  const m: TransportMetrics = {
    waited: (provider, apiClass, reason, ms) => void waits.push({ provider, apiClass, reason, ms }),
    called: (_p, apiClass, outcome) => void calls.push({ apiClass, outcome }),
    breaker: (_p, _a, from, to) => void breaker.push({ from, to })
  };
  return { m, waits, calls, breaker };
}

const get = (t: CloudTransport, path: string, accountId = 'acc-1') => t.send({ method: 'GET', url: `${fake.url}${path}`, headers: { authorization: `Bearer ${token}` }, accountId });

beforeAll(async () => {
  await fake.start();
  token = fake.addToken();
});
afterAll(() => fake.stop());
beforeEach(() => {
  sleeps.length = 0;
  fake.reset();
});

describe('API classes', () => {
  const u = (s: string) => new URL(s);
  it('classifies AWS actions, REST reads, collections and billing per provider', () => {
    const form = (action: string) => `Action=${action}&Version=2016-11-15`;
    expect(apiClassOf('aws', 'POST', u('https://ec2.eu-central-1.amazonaws.com/'), { 'content-type': 'application/x-www-form-urlencoded' }, form('DescribeVpcs'))).toBe('list');
    expect(apiClassOf('aws', 'POST', u('https://ec2.eu-central-1.amazonaws.com/'), {}, form('CreateVpc'))).toBe('mutate');
    expect(apiClassOf('aws', 'POST', u('https://sts.amazonaws.com/'), {}, 'Action=GetCallerIdentity&Version=2011-06-15')).toBe('read');
    expect(apiClassOf('aws', 'POST', u('https://ce.us-east-1.amazonaws.com/'), { 'X-Amz-Target': 'AWSInsightsIndexService.GetCostAndUsage' }, '{}')).toBe('billing');
    expect(apiClassOf('aws', 'POST', u('https://api.pricing.us-east-1.amazonaws.com/'), { 'x-amz-target': 'AWSPriceListService.GetProducts' }, '{}')).toBe('billing');
    expect(apiClassOf('aws', 'GET', u('https://route53.amazonaws.com/2013-04-01/hostedzone/Z1/rrset'))).toBe('list');
    expect(apiClassOf('aws', 'GET', u('https://my-bucket.s3.eu-central-1.amazonaws.com/?tagging'))).toBe('read');
    expect(apiClassOf('azure', 'GET', u('https://management.azure.com/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks?api-version=2023-09-01'))).toBe('list');
    expect(apiClassOf('azure', 'GET', u('https://management.azure.com/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/exprsn-prod-core?api-version=2023-09-01'))).toBe('read');
    expect(apiClassOf('azure', 'PUT', u('https://management.azure.com/subscriptions/s1/resourceGroups/rg'))).toBe('mutate');
    expect(apiClassOf('azure', 'POST', u('https://management.azure.com/subscriptions/s1/providers/Microsoft.CostManagement/query?api-version=2023-03-01'))).toBe('billing');
    expect(apiClassOf('digitalocean', 'GET', u('https://api.digitalocean.com/v2/vpcs'))).toBe('list');
    expect(apiClassOf('digitalocean', 'GET', u('https://api.digitalocean.com/v2/vpcs/5a4c1b5e-0000-4000-8000-000000000001'))).toBe('read');
    expect(apiClassOf('digitalocean', 'GET', u('https://api.digitalocean.com/v2/account'))).toBe('read');
    expect(apiClassOf('digitalocean', 'GET', u('https://api.digitalocean.com/v2/customers/my/balance'))).toBe('billing');
    expect(apiClassOf('digitalocean', 'DELETE', u('https://api.digitalocean.com/v2/vpcs/x'))).toBe('mutate');
    expect(apiClassOf('cloudflare', 'GET', u('https://api.cloudflare.com/client/v4/zones/z1/dns_records?page=1'))).toBe('list');
    expect(apiClassOf('cloudflare', 'GET', u('https://api.cloudflare.com/client/v4/accounts/a1/billing/profile'))).toBe('billing');
  });

  it('keeps a bucket per API class: spent mutations wait or are refused while reads go on', async () => {
    const t = new CloudTransport({ provider: 'digitalocean', policy, counters: new MemoryCounterStore(), classLimits: { mutate: { points: 1, windowMs: 60_000 } }, maxQueueWaitMs: 0, sleep: fastSleep });
    const post = () => t.send({ method: 'POST', url: `${fake.url}/v2/tags`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }), accountId: 'acc-1' });
    expect((await post()).status).toBe(201);
    const seen = fake.requests.length;
    await expect(post()).rejects.toMatchObject({ status: 429, code: 'rate_limited' });
    expect(fake.requests.length).toBe(seen);
    expect((await get(t, '/v2/account')).status).toBe(200);
    expect(t.stats.byClass).toMatchObject({ mutate: 2, read: 1 });
    expect(t.stats.rateLimited).toBe(1);
    // Another account has its own buckets.
    expect((await t.send({ method: 'POST', url: `${fake.url}/v2/tags`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'y' }), accountId: 'acc-2' })).status).toBe(201);
  });

  it('a burst of 500 reads stays under the provider’s limit, and every read completes (no refusal reaches the caller)', async () => {
    // The fake allows 100 calls per half second; the transport is set to 60 per half second with refill slices, so no
    // span of the fake's window ever sees more than 80.
    fake.minuteMs = 500;
    fake.perMinute = 100;
    fake.limited = 0;
    const rec = recorder();
    const p = new DigitalOceanProvider({ policy, counters: new MemoryCounterStore(), limit: { points: 60, windowMs: 500 }, classLimits: { read: { points: 60, windowMs: 500 } }, metrics: rec.m, endpoints: { api: fake.url } });
    // A token of its own, so the fake's windows start with this test.
    const ctx: CallContext = { account: account('digitalocean', 'burst'), cred: { kind: 'token', token: fake.addToken() } };
    const vpc = await p.create(ctx, { type: 'network', name: 'burst', idempotencyKey: 'b1', tags: { 'exprsn:managed': 'true', 'exprsn:account': 'burst' }, props: { cidr: '10.70.0.0/20' } });
    const id = vpc.done ? vpc.resource!.providerId : '';
    fake.reset();
    const started = Date.now();
    const out = await Promise.all(Array.from({ length: 500 }, () => p.describe(ctx, { type: 'network', providerId: id })));
    const took = Date.now() - started;
    expect(out.every((r) => r?.providerId === id)).toBe(true);
    expect(fake.limited).toBe(0);
    expect(fake.calls('GET /vpcs/{id}')).toHaveLength(500);
    // Under the fake's 100 in any half second (one window's allowance and a slice's burst, plus arrival jitter).
    const at = fake.requests.map((r) => r.at).sort((a, b) => a - b);
    let peak = 0;
    for (let i = 0, j = 0; i < at.length; i++) {
      while (at[i]! - at[j]! >= 500) j++;
      peak = Math.max(peak, i - j + 1);
    }
    expect(peak).toBeLessThan(100);
    expect(took).toBeGreaterThan(3000);
    expect(p.transport.stats.byClass.read).toBe(500);
    expect(p.transport.stats.limiterWaits).toBeGreaterThan(0);
    expect(rec.calls.filter((c) => c.apiClass === 'read' && c.outcome === 'ok')).toHaveLength(500);
    expect(rec.waits.filter((w) => w.reason === 'limiter').length).toBeGreaterThan(0);
    fake.minuteMs = 60_000;
    fake.perMinute = 250;
  }, 60_000);
});

describe('throttling signals per provider', () => {
  const transport = (provider: Provider, extra: Partial<ConstructorParameters<typeof CloudTransport>[0]> = {}) => new CloudTransport({ provider, policy, counters: new MemoryCounterStore(), sleep: fastSleep, random: () => 0.5, ...extra });

  it('AWS: throttling error codes in the body or x-amzn-errortype, and a 5xx on a POSTed Describe is retried', async () => {
    const t = transport('aws');
    fake.fail(400, '<Response><Errors><Error><Code>RequestLimitExceeded</Code></Error></Errors></Response>', { times: 1 });
    fake.fail(429, { __type: 'com.amazon.coral#ThrottlingException', message: 'Rate exceeded' }, { times: 1, headers: { 'x-amzn-errortype': 'ThrottlingException:http://internal' } });
    fake.fail(500, '<Response><Errors><Error><Code>InternalError</Code></Error></Errors></Response>', { times: 1 });
    const res = await t.send({ method: 'POST', url: `${fake.url}/v2/account`, headers: { authorization: `Bearer ${token}` }, body: 'Action=DescribeVpcs&Version=2016-11-15', accountId: 'acc-1' });
    expect(res.status).toBe(200);
    expect(res.apiClass).toBe('list');
    expect(res.attempts).toBe(4);
    expect(t.stats.throttled).toBe(2);
    expect(sleeps).toEqual([250, 500, 1000]);
    // A mutation that failed with a 5xx is not retried: it may have happened.
    fake.fail(500, '<Response><Errors><Error><Code>InternalError</Code></Error></Errors></Response>', { times: 1 });
    const create = await t.send({ method: 'POST', url: `${fake.url}/v2/account`, body: 'Action=CreateVpc&CidrBlock=10.0.0.0/16', accountId: 'acc-1' });
    expect(create).toMatchObject({ status: 500, attempts: 1 });
  });

  it('Azure: a 429 waits x-ms-retry-after-ms, and a low x-ms-ratelimit-remaining-subscription-reads holds the next read', async () => {
    const t = transport('azure');
    fake.fail(429, { error: { code: 'TooManyRequests' } }, { times: 1, headers: { 'x-ms-retry-after-ms': '1500' } });
    expect((await get(t, '/v2/account')).status).toBe(200);
    expect(sleeps).toEqual([1500]);
    sleeps.length = 0;
    fake.fail(200, { ok: true }, { times: 1, headers: { 'x-ms-ratelimit-remaining-subscription-reads': '1' } });
    await get(t, '/v2/account');
    expect(t.stats.holds).toBe(1);
    await get(t, '/v2/account');
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(sleeps[0]).toBeLessThanOrEqual(2000);
  });

  it('DigitalOcean: a 429 waits for ratelimit-reset, and a spent allowance holds calls until it resets', async () => {
    let now = 1_000_000_000_000;
    const t = transport('digitalocean', { now: () => now, maxQueueWaitMs: 600_000 });
    const reset = Math.ceil(Date.now() / 1000) + 3;
    fake.fail(429, { id: 'too_many_requests' }, { times: 1, headers: { 'ratelimit-remaining': '0', 'ratelimit-reset': String(reset) } });
    expect((await get(t, '/v2/account')).status).toBe(200);
    expect(sleeps[0]).toBeGreaterThan(1000);
    expect(sleeps[0]).toBeLessThanOrEqual(4000);
    sleeps.length = 0;
    now = Date.now();
    fake.fail(200, { ok: true }, { times: 1, headers: { 'ratelimit-remaining': '1', 'ratelimit-reset': String(Math.ceil(now / 1000) + 30) } });
    await get(t, '/v2/account');
    await get(t, '/v2/account');
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(25_000);
    // A hold longer than the queue may wait is refused locally, with the wait to report.
    const strict = transport('digitalocean', { now: () => now, maxQueueWaitMs: 1000 });
    fake.fail(200, { ok: true }, { times: 1, headers: { 'ratelimit-remaining': '0', 'ratelimit-reset': String(Math.ceil(now / 1000) + 30) } });
    await get(strict, '/v2/account');
    await expect(get(strict, '/v2/account')).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
  });

  it('Cloudflare: a 429 with Retry-After is retried after it; one longer than allowed comes back with the wait', async () => {
    const t = transport('cloudflare', { maxRetryWaitMs: 10_000 });
    fake.fail(429, { success: false, errors: [{ code: 971 }] }, { times: 1, headers: { 'retry-after': '2' } });
    expect((await get(t, '/v2/account')).status).toBe(200);
    expect(sleeps).toEqual([2000]);
    fake.fail(429, { success: false, errors: [{ code: 971 }] }, { times: 1, headers: { 'retry-after': '60' } });
    const err = await t.json({ method: 'GET', url: `${fake.url}/v2/account`, accountId: 'acc-1' }, () => ({ message: 'throttled', code: '971' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudProviderError);
    expect(err).toMatchObject({ status: 429, retryAfterSeconds: 60, throttled: true });
  });
});

describe('circuit breaker per provider and account', () => {
  it('opens after repeated 5xx, refuses at once, lets one probe through half-open, and closes on success', async () => {
    let now = 5_000_000;
    const rec = recorder();
    const t = new CloudTransport({ provider: 'digitalocean', policy, counters: new MemoryCounterStore(), sleep: fastSleep, random: () => 0, now: () => now, breaker: { failures: 3, openMs: 30_000 }, metrics: rec.m });
    fake.fail(502, { id: 'bad_gateway' }, { times: 3 });
    // A read is retried; the third failure opens the breaker, and the fourth attempt is not made.
    await expect(get(t, '/v2/account')).rejects.toMatchObject({ status: 503, code: 'circuit_open' });
    expect(fake.requests).toHaveLength(3);
    expect(t.breakerState('acc-1')).toBe('open');
    // While open: refused at once, the provider is not called; another account is not affected.
    await expect(get(t, '/v2/account')).rejects.toMatchObject({ code: 'circuit_open', retryAfterSeconds: 30 });
    expect(fake.requests).toHaveLength(3);
    expect((await get(t, '/v2/account', 'acc-other')).status).toBe(200);
    // Half-open after the open time: one probe; it fails, so the breaker opens again.
    now += 30_000;
    expect(t.breakerState('acc-1')).toBe('half_open');
    fake.fail(503, { id: 'unavailable' }, { times: 1 });
    await expect(get(t, '/v2/account')).rejects.toMatchObject({ code: 'circuit_open' });
    expect(t.breakerState('acc-1')).toBe('open');
    // The next probe succeeds: closed, and calls flow again.
    now += 30_000;
    expect((await get(t, '/v2/account')).status).toBe(200);
    expect(t.breakerState('acc-1')).toBe('closed');
    expect((await get(t, '/v2/account')).status).toBe(200);
    expect(rec.breaker.map((b) => b.to)).toEqual(['open', 'half_open', 'open', 'half_open', 'closed']);
    expect(t.stats.breakerOpened).toBe(2);
    expect(t.stats.circuitRefused).toBe(3);
    // A 4xx answer is the caller's problem, not the provider's: it never opens the breaker.
    fake.fail(404, { id: 'not_found' }, { times: 5 });
    for (let i = 0; i < 5; i++) expect((await get(t, '/v2/vpcs/nope')).status).toBe(404);
    expect(t.breakerState('acc-1')).toBe('closed');
  });

  it('counts timeouts and unreachable endpoints, and throttling not at all', async () => {
    let now = 9_000_000;
    const t = new CloudTransport({ provider: 'digitalocean', policy, counters: new MemoryCounterStore(), sleep: fastSleep, random: () => 0, now: () => now, breaker: { failures: 2, openMs: 1000 }, maxAttempts: 1 });
    fake.throttle(4, { retryAfterS: 1 });
    for (let i = 0; i < 2; i++) expect((await get(t, '/v2/account')).status).toBe(429);
    expect(t.breakerState('acc-1')).toBe('closed');
    // A port nothing listens on.
    const dead = 'http://127.0.0.1:9';
    for (let i = 0; i < 2; i++) await expect(t.send({ method: 'GET', url: `${dead}/v2/account`, accountId: 'acc-1' })).rejects.toMatchObject({ code: 'unreachable' });
    expect(t.breakerState('acc-1')).toBe('open');
    now += 1000;
    fake.reset();
    expect((await get(t, '/v2/account')).status).toBe(200);
    expect(t.breakerState('acc-1')).toBe('closed');
  });
});

describe('metrics', () => {
  it('exports waits, outcomes and breaker changes for Prometheus, once per registry', async () => {
    const registry = new client.Registry();
    const m = cloudTransportMetrics(registry);
    expect(cloudTransportMetrics(registry)).toBe(m);
    let now = 1_000;
    const t = new CloudTransport({ provider: 'digitalocean', policy, counters: new MemoryCounterStore(), sleep: fastSleep, random: () => 0, now: () => now, breaker: { failures: 1, openMs: 10 }, metrics: m, maxAttempts: 2 });
    fake.throttle(1, { retryAfterS: 1 });
    await get(t, '/v2/account');
    fake.fail(500, { id: 'x' }, { times: 1 });
    // The 500 is retried (a read) after its backoff, and the open breaker refuses that attempt.
    await expect(get(t, '/v2/account')).rejects.toMatchObject({ code: 'circuit_open' });
    const text = await registry.metrics();
    expect(text).toMatch(/exprsn_cloud_wait_seconds_count\{provider="digitalocean",api_class="read",reason="retry"\} 2/);
    expect(text).toMatch(/exprsn_cloud_calls_total\{provider="digitalocean",api_class="read",outcome="ok"\} 1/);
    expect(text).toMatch(/exprsn_cloud_calls_total\{provider="digitalocean",api_class="read",outcome="circuit_open"\} 1/);
    expect(text).toMatch(/exprsn_cloud_breaker_transitions_total\{provider="digitalocean",to="open"\} 1/);
    expect(text).toMatch(/exprsn_cloud_breakers_open\{provider="digitalocean"\} 1/);
    now += 10;
    await get(t, '/v2/account');
    expect(await registry.metrics()).toMatch(/exprsn_cloud_breakers_open\{provider="digitalocean"\} 0/);
  });
});
