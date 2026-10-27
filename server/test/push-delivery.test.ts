/*
 * 1.9.0, Sprint 49 (B-152): push delivery against a local fake APNs over HTTP/2 (node:http2 createSecureServer with a
 * test certificate the client trusts through the `push.ca` override; no real Apple endpoint).
 *
 *   - one HTTP/2 session reused across sends
 *   - 429 with Retry-After: the retry waits as long as the provider asked
 *   - 410: the device is marked gone (B-150's markGone)
 *   - collapse id and time to live as apns-collapse-id and apns-expiration
 *   - the console's socket first; push only when no client acknowledges in time
 *   - suppressed by preferences, and logged
 *   - the 30-day sweep of the delivery log
 *   - metrics per provider
 */
import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { createSecureServer, type Http2SecureServer, type IncomingHttpHeaders, type ServerHttp2Stream } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { selfSignedCertificate } from '../src/federation/x509.js';
import { pushTestCommand } from '../src/cli/push.js';
import { ACK_TOPIC, SOCKET_TOPIC, type SocketPush } from '../src/push/service.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';

const send = (c: Client, method: 'post' | 'patch' | 'put', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);

function localhostCert() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const der = selfSignedCertificate({ publicKey: pair.publicKey, privateKey: pair.privateKey, commonName: 'localhost', days: 2 });
  const cert = '-----BEGIN CERTIFICATE-----\n' + der.toString('base64').match(/.{1,64}/g)!.join('\n') + '\n-----END CERTIFICATE-----\n';
  return { key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), cert };
}

/** APNs as far as delivery needs: checks the provider token, answers by the device token's first characters. */
class FakeApns {
  server: Http2SecureServer;
  origin = '';
  sessions = 0;
  seen: { path: string; headers: IncomingHttpHeaders; body: string }[] = [];
  throttled = new Set<string>();
  constructor(
    pem: { key: string; cert: string },
    private readonly apnsKey: KeyObject
  ) {
    this.server = createSecureServer({ key: pem.key, cert: pem.cert, allowHTTP1: false });
    this.server.on('session', () => this.sessions++);
    this.server.on('stream', (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
      let body = '';
      stream.on('data', (c: Buffer) => (body += c.toString('utf8')));
      stream.on('end', () => {
        const path = String(headers[':path']);
        this.seen.push({ path, headers, body });
        const auth = String(headers.authorization ?? '');
        const [h, p, s] = auth.replace(/^bearer /, '').split('.');
        if (!h || !p || !s || !verify('sha256', Buffer.from(`${h}.${p}`), { key: this.apnsKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))) {
          stream.respond({ ':status': 403, 'content-type': 'application/json' });
          return stream.end('{"reason":"InvalidProviderToken"}');
        }
        const token = path.split('/').pop()!;
        if (token.startsWith('410')) {
          stream.respond({ ':status': 410, 'content-type': 'application/json' });
          return stream.end('{"reason":"Unregistered","timestamp":1}');
        }
        if (token.startsWith('429') && !this.throttled.has(token)) {
          this.throttled.add(token);
          stream.respond({ ':status': 429, 'retry-after': '7', 'content-type': 'application/json' });
          return stream.end('{"reason":"TooManyRequests"}');
        }
        stream.respond({ ':status': 200, 'apns-id': 'x' });
        stream.end();
      });
    });
  }
  async start() {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.origin = `https://localhost:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }
}

const hex = (prefix: string) => (prefix + '0123456789abcdef'.repeat(4)).slice(0, 64);

describe('B-152 push delivery', () => {
  const pem = localhostCert();
  const apnsPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  let apns: FakeApns;
  let h: Harness;
  let admin: Client;
  let userId: string;
  let providerId: string;

  beforeAll(async () => {
    apns = await new FakeApns(pem, apnsPair.publicKey).start();
  });
  afterAll(async () => {
    await apns.stop();
  });

  beforeEach(async () => {
    apns.seen.length = 0;
    apns.sessions = 0;
    h = await harness({ SERVICE_ALLOWED_HOSTS: '127.0.0.1,::1,localhost' }, { push: { endpoints: { apns: apns.origin }, ca: pem.cert, backoffMs: 1000 } });
    userId = (await localUser(h, 'tadmin', ['tenant-admin'], 'confidential')).id;
    admin = await loginAdmin(h, 'tadmin');
    await send(admin, 'post', '/api/vault/policies', { subjectKind: 'user', subject: userId, path: '*', capabilities: ['*'] }).expect(201);
    const st = await send(admin, 'put', '/api/admin/push/secrets', { path: 'push/apns', data: { p8: apnsPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() } }).expect(201);
    const p = await send(admin, 'post', '/api/admin/push/providers', { kind: 'apns', name: 'iOS', config: { keyRef: st.body.refs.p8, keyId: 'KEY1234567', teamId: 'TEAM123456', topic: 'org.exprsn.app' } }).expect(201);
    providerId = p.body.id;
  });
  afterEach(async () => {
    await h.close();
  });

  const device = async (token: string, name = 'iPhone') => {
    const r = await send(admin, 'post', '/api/me/devices', { platform: 'ios', provider: 'apns', appId: 'org.exprsn.app', token, name });
    expect(r.status).toBeLessThan(300);
    return ((r.body.device ?? r.body) as { id: string }).id;
  };
  const notify = (over: Record<string, unknown> = {}) => h.s.notifications.notify({ tenantId: h.tenantId, userIds: [userId], kind: 'chat.reply', title: 'A reply', body: 'Your answer is ready.', route: 'chat', label: 'public', ...over });
  const log = async () => (await h.s.db('push_deliveries').where({ tenant_id: h.tenantId }).orderBy('created_at').orderBy('id')) as { channel: string; outcome: string; status: number | null; reason: string | null; device_id: string | null; attempt: number }[];

  it('reuses one HTTP/2 session for several sends and sends collapse id and time to live', async () => {
    await device(hex('aa'));
    const t0 = Math.floor(Date.now() / 1000);
    await notify({ push: { collapseId: 'thread-1', ttlSeconds: 600 } });
    await notify();
    await notify();
    await h.s.jobs.runDue();
    const sent = apns.seen.filter((x) => x.path.startsWith('/3/device/'));
    expect(sent).toHaveLength(3);
    expect(apns.sessions).toBe(1);
    expect(h.s.push.pool.opened).toBe(1);
    const first = sent.find((x) => x.headers['apns-collapse-id'] === 'thread-1')!;
    expect(first.headers['apns-topic']).toBe('org.exprsn.app');
    expect(Number(first.headers['apns-expiration'])).toBeGreaterThanOrEqual(t0 + 598);
    expect(Number(first.headers['apns-expiration'])).toBeLessThanOrEqual(t0 + 602);
    expect(JSON.parse(first.body).aps.alert).toEqual({ title: 'A reply', body: 'Your answer is ready.' });
    expect((await log()).map((r) => r.outcome)).toEqual(['sent', 'sent', 'sent']);
  });

  it('sends no content above the provider content label', async () => {
    await device(hex('ab'));
    await notify({ label: 'confidential' });
    await h.s.jobs.runDue();
    const alert = JSON.parse(apns.seen[0]!.body).aps.alert as { title: string; body?: string };
    expect(alert.title).not.toContain('A reply');
    expect(JSON.stringify(alert)).not.toContain('Your answer');
  });

  it('honours Retry-After on 429', async () => {
    await device(hex('429'));
    await notify();
    const before = Date.now();
    await h.s.jobs.runDue();
    expect((await log()).map((r) => [r.outcome, r.status])).toEqual([['retrying', 429]]);
    const retry = (await h.s.db('jobs').where({ type: 'push.send', state: 'queued' }).first()) as { run_at: number; payload: string };
    expect(Number(retry.run_at) - before).toBeGreaterThanOrEqual(6900);
    expect(Number(retry.run_at) - before).toBeLessThan(9000);
    await h.s.db('jobs').where({ type: 'push.send', state: 'queued' }).update({ run_at: Date.now() });
    await h.s.jobs.runDue();
    expect((await log()).map((r) => [r.outcome, r.attempt])).toEqual([['retrying', 1], ['sent', 2]]);
  });

  it('marks the device gone on 410', async () => {
    const id = await device(hex('410'));
    await notify();
    await h.s.jobs.runDue();
    expect((await log()).map((r) => [r.outcome, r.status, r.reason])).toEqual([['dropped', 410, 'Unregistered']]);
    const row = (await h.s.db('push_devices').where({ id }).first()) as { state: string; state_reason: string };
    expect(row.state).toBe('gone');
    expect(row.state_reason).toMatch(/apns: Unregistered/);
    // The next notification has no device to go to.
    apns.seen.length = 0;
    await notify();
    await h.s.jobs.runDue();
    expect(apns.seen).toHaveLength(0);
  });

  it('tries the console socket first and pushes only without an acknowledgement', async () => {
    await device(hex('ac'));
    await send(admin, 'post', '/api/admin/push/providers', { kind: 'websocket', name: 'Console', config: { mode: 'socketio', ackTimeoutMs: 500 } }).expect(201);
    await h.s.presence.connected(h.tenantId, userId, 'socket-1');
    const emitted: SocketPush[] = [];
    const off = h.s.bus.on<SocketPush>(SOCKET_TOPIC, (e) => void emitted.push(e));
    try {
      // No acknowledgement: after the wait, push.
      await notify();
      await h.s.jobs.runDue();
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.notification.title).toBe('A reply');
      expect(apns.seen).toHaveLength(0);
      expect((await log()).map((r) => [r.channel, r.outcome])).toEqual([['websocket', 'waiting']]);
      await h.s.db('jobs').where({ type: 'push.fallback', state: 'queued' }).update({ run_at: Date.now() });
      await h.s.jobs.runDue();
      expect(apns.seen).toHaveLength(1);
      expect((await log()).map((r) => [r.channel, r.outcome])).toEqual([['websocket', 'failed'], ['push', 'sent']]);
      // Acknowledged: nothing pushed.
      await notify();
      await h.s.jobs.runDue();
      h.s.bus.publish(ACK_TOPIC, { deliveryId: emitted[1]!.deliveryId, userId });
      await new Promise((r) => setTimeout(r, 50));
      await h.s.db('jobs').where({ type: 'push.fallback', state: 'queued' }).update({ run_at: Date.now() });
      await h.s.jobs.runDue();
      expect(apns.seen).toHaveLength(1);
      const rows = await log();
      expect(rows.slice(2).map((r) => [r.channel, r.outcome, r.reason])).toEqual([['websocket', 'sent', 'acknowledged']]);
      // Someone else cannot acknowledge it.
      await notify();
      await h.s.jobs.runDue();
      h.s.bus.publish(ACK_TOPIC, { deliveryId: emitted[2]!.deliveryId, userId: '01J00000000000000000000000' });
      await new Promise((r) => setTimeout(r, 50));
      expect((await h.s.db('push_deliveries').where({ id: emitted[2]!.deliveryId }).first()).outcome).toBe('waiting');
    } finally {
      off();
    }
  });

  it('logs a delivery the preferences suppress, and sends nothing', async () => {
    await device(hex('ad'));
    const prefs = h.s.notificationPrefs as unknown as { decide: (...a: unknown[]) => Promise<unknown> };
    const original = prefs.decide;
    prefs.decide = async (_t: unknown, _u: unknown, _k: unknown, channel: unknown) => (channel === 'push' ? { deliver: 'suppressed', reason: 'quiet hours', kind: 'chat.reply' } : original.call(h.s.notificationPrefs, _t, _u, _k, channel));
    try {
      await notify();
      await h.s.jobs.runDue();
    } finally {
      prefs.decide = original;
    }
    expect(apns.seen).toHaveLength(0);
    expect((await log()).map((r) => [r.channel, r.outcome, r.reason])).toEqual([['push', 'suppressed', 'suppressed: quiet hours']]);
  });

  it('changes nothing without an enabled provider', async () => {
    await device(hex('ae'));
    await send(admin, 'patch', `/api/admin/push/providers/${providerId}`, { enabled: false }).expect(200);
    await notify();
    expect(await h.s.db('jobs').where({ type: 'push.deliver' })).toHaveLength(0);
  });

  it('push:test sends to a person\'s devices through their providers and audits it', async () => {
    await device(hex('b0'), 'Work phone');
    const lines: string[] = [];
    expect(await pushTestCommand(h.s, ['--user', 'tadmin', '--kind', 'apns'], (t) => void lines.push(t))).toBe(0);
    expect(lines.join('')).toMatch(/^Work phone: sent 200 via iOS, \d+ ms/);
    expect(await pushTestCommand(h.s, ['--user', 'tadmin', '--kind', 'fcm'], (t) => void lines.push(t))).toBe(2);
    const audit = (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'push.test.sent' })) as unknown[];
    expect(audit).toHaveLength(2);
    expect((await log()).map((r) => r.outcome)).toEqual(['sent']);
  });

  it('sweeps the log after 30 days and counts sends per provider', async () => {
    await device(hex('af'));
    await notify();
    await h.s.jobs.runDue();
    const old = Date.now() - 31 * 86_400_000;
    await h.s.db('push_deliveries').insert({ id: '01J00000000000000000000001', tenant_id: h.tenantId, user_id: userId, notification_id: null, device_id: null, provider_id: providerId, provider_kind: 'apns', provider_scope: 'tenant', channel: 'push', kind: 'x', outcome: 'sent', status: 200, reason: null, latency_ms: 1, attempt: 1, test: false, created_at: old, updated_at: old });
    expect(await h.s.push.sweep()).toEqual({ removed: 1 });
    expect(await h.s.db('push_deliveries')).toHaveLength(1);
    const text = await h.s.metrics.registry.metrics();
    expect(text).toMatch(new RegExp(`exprsn_push_deliveries_total\\{kind="apns",provider="${providerId}",outcome="sent"\\} 1`));
    expect(text).toMatch(new RegExp(`exprsn_push_send_seconds_count\\{kind="apns",provider="${providerId}"\\} 1`));
  });
});
