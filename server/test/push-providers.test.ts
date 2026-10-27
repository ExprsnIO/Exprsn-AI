/*
 * 1.9.0, Sprint 49 (B-151, B-154): push providers.
 *
 *   - the APNs provider token: ES256 that verifies, renewed after 50 minutes (fixed clock)
 *   - the FCM OAuth assertion against a local fake token server
 *   - Web Push: RFC 8291 encryption against the RFC's Appendix A vector, and decryptable
 *   - the HTTP vendor's body template and response mapping
 *   - hosts through the egress guard (refused ones refused)
 *   - credentials only as vault references; literals refused
 *   - the audit entries push.provider.created, .updated, .checked, .deleted and push.test.sent
 */
import { createPublicKey, generateKeyPairSync, randomBytes, createECDH, verify } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { servicePolicy } from '../src/platform/egress.js';
import { parseAllowList } from '../src/mcp/hosts.js';
import { ApnsTokens, APNS_TOKEN_RENEW_MS, fromB64url } from '../src/push/jwt.js';
import { configProblems, parseConfig, pushAddressProblem, retryAfterMs } from '../src/push/model.js';
import { classify, renderTemplate, renderUrl } from '../src/push/senders.js';
import { decryptPayload, encryptPayload, generateVapidKeys, vapidPrivateKey } from '../src/push/webpush.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';

const send = (c: Client, method: 'post' | 'patch' | 'put' | 'delete', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);
const b = (s: string) => Buffer.from(s, 'base64url');
const jwtParts = (t: string) => t.split('.').map((x, i) => (i < 2 ? JSON.parse(b(x).toString('utf8')) : x)) as [Record<string, unknown>, Record<string, unknown>, string];

describe('B-151 crypto: APNs tokens, Web Push encryption', () => {
  it('mints an ES256 provider token that verifies, and renews it once it is 50 minutes old', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    let now = Date.UTC(2026, 9, 16, 12, 0, 0);
    const tokens = new ApnsTokens(() => now);
    const t1 = tokens.token({ teamId: 'TEAM123456', keyId: 'KEY1234567', key: privateKey });
    const [h, c, sig] = jwtParts(t1);
    expect(h).toEqual({ alg: 'ES256', kid: 'KEY1234567' });
    expect(c).toEqual({ iss: 'TEAM123456', iat: Math.floor(now / 1000) });
    const [hp, cp] = t1.split('.');
    expect(verify('sha256', Buffer.from(`${hp}.${cp}`), { key: createPublicKey(privateKey), dsaEncoding: 'ieee-p1363' }, b(sig))).toBe(true);
    now += APNS_TOKEN_RENEW_MS - 60_000; // 49 minutes: the same token
    expect(tokens.token({ teamId: 'TEAM123456', keyId: 'KEY1234567', key: privateKey })).toBe(t1);
    expect(tokens.minted).toBe(1);
    now += 60_000; // 50 minutes: a new one
    const t2 = tokens.token({ teamId: 'TEAM123456', keyId: 'KEY1234567', key: privateKey });
    expect(t2).not.toBe(t1);
    expect(jwtParts(t2)[1].iat).toBe(Math.floor(now / 1000));
    expect(tokens.minted).toBe(2);
  });

  it('encrypts as RFC 8291 Appendix A says', () => {
    const out = encryptPayload(
      { keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } },
      b('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'),
      { asPrivate: b('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'), salt: b('DGv6ra1nlYgDCS1FRnbzlw') }
    );
    expect(out.toString('base64url')).toBe('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
    expect(decryptPayload(b('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'), b('BTBZMqHH6r4Tts7J_aSIgg'), out).toString('utf8')).toBe('When I grow up, I want to be a watermelon');
  });

  it('round-trips a fresh message, and refuses a VAPID key that is not the pair of its public key', () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const auth = randomBytes(16);
    const msg = Buffer.from(JSON.stringify({ title: 'Hello', body: 'World' }));
    const enc = encryptPayload({ keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } }, msg);
    expect(enc.readUInt32BE(16)).toBe(4096);
    expect(decryptPayload(ua.getPrivateKey(), auth, enc).equals(msg)).toBe(true);
    const a = generateVapidKeys();
    const other = generateVapidKeys();
    expect(() => vapidPrivateKey(a.privatePem, a.publicKey)).not.toThrow();
    expect(() => vapidPrivateKey(other.privatePem, a.publicKey)).toThrow(/does not belong/);
  });
});

describe('B-151 configuration: templates, mappings, hosts, literals', () => {
  it('renders a body template as JSON values and maps answers', () => {
    const vars = { title: 'He said "hi"', body: null, data: { a: '1' }, token: 'ExponentPushToken[x]', collapseId: null, ttl: 60, priority: 'high', route: 'chat', kind: 'chat.reply', link: 'https://x/#/chat' };
    const out = JSON.parse(renderTemplate('{"to":{token},"title":{title},"body":{body},"data":{data},"ttl":{ttl}}', vars)) as Record<string, unknown>;
    expect(out).toEqual({ to: 'ExponentPushToken[x]', title: 'He said "hi"', body: null, data: { a: '1' }, ttl: 60 });
    expect(renderUrl('https://api.vendor.test/v1/{kind}/send?to={token}', vars)).toBe('https://api.vendor.test/v1/chat.reply/send?to=ExponentPushToken%5Bx%5D');
    const map = parseConfig('http', { url: 'https://api.vendor.test/send', body: '{"to":{token}}', response: { gone: { status: [], pointer: '/data/status', equals: ['DeviceNotRegistered'] } } }) as { response: Parameters<typeof classify>[0] };
    expect(classify(map.response, 200, { data: { status: 'ok' } }).outcome).toBe('sent');
    expect(classify(map.response, 200, { data: { status: 'DeviceNotRegistered' } }).outcome).toBe('gone');
    expect(classify(map.response, 429, null).outcome).toBe('retry');
    expect(classify(map.response, 503, null).outcome).toBe('retry');
    expect(classify(map.response, 400, null).outcome).toBe('failed');
    expect(retryAfterMs('7')).toBe(7000);
  });

  it('refuses literals and unknown placeholders, and keeps platform references under push/', () => {
    const c = parseConfig('http', { url: 'https://api.vendor.test/send', headers: { 'X-Api-Key': 'abc123', 'X-Tenant': 'acme' }, body: '{"to":{token},"x":{secret}}' });
    const p = configProblems('http', c, 'tenant');
    expect(p.join(' ')).toMatch(/X-Api-Key carries a credential/);
    expect(p.join(' ')).toMatch(/\{secret\}/);
    expect(() => parseConfig('fcm', { serviceAccountRef: '{"type":"service_account"}' })).toThrow(/vault reference/);
    const w = parseConfig('webpush', { publicKey: generateVapidKeys().publicKey, privateKeyRef: 'vault:apps/push#key', subject: 'mailto:ops@example.org' });
    expect(configProblems('webpush', w, 'platform').join(' ')).toMatch(/under vault:push\//);
    expect(configProblems('webpush', w, 'tenant')).toEqual([]);
  });

  it('lets each kind reach its own hosts and refuses metadata and unlisted hosts', () => {
    const policy = servicePolicy({});
    expect(pushAddressProblem('169.254.169.254', 'metadata', 'http', policy, null)).toMatch(/metadata/);
    expect(pushAddressProblem('17.188.1.1', 'api.push.apple.com', 'apns', policy, null)).toBeNull();
    expect(pushAddressProblem('17.188.1.1', 'api.push.apple.com', 'http', policy, null)).toMatch(/not on this tenant's list/);
    expect(pushAddressProblem('203.0.113.9', 'api.vendor.test', 'http', policy, parseAllowList('api.vendor.test'))).toBeNull();
    expect(pushAddressProblem('127.0.0.1', 'localhost', 'http', policy, null)).toMatch(/internal address/);
  });
});

/** A Google token endpoint and a vendor that records what it got. */
class Fakes {
  server: Server;
  url = '';
  tokenRequests: URLSearchParams[] = [];
  vendor: { auth: string | undefined; body: string }[] = [];
  constructor() {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url === '/token') {
          this.tokenRequests.push(new URLSearchParams(body));
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ access_token: 'ya29.fake', expires_in: 3600, token_type: 'Bearer' }));
        }
        if (req.url === '/send') {
          this.vendor.push({ auth: req.headers.authorization, body });
          const to = (JSON.parse(body) as { to?: string }).to;
          res.writeHead(to === 'gone-device-1' ? 410 : 200, { 'content-type': 'application/json' });
          return res.end('{"ok":true}');
        }
        res.writeHead(404).end();
      });
    });
  }
  async start() {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }
}

describe('B-151 providers through the API', () => {
  let h: Harness;
  let fakes: Fakes;
  let admin: Client;
  let root: Client;
  let adminId: string;
  const sa = (() => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    return { publicKey, json: JSON.stringify({ type: 'service_account', project_id: 'exprsn-test', private_key_id: 'kid1', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), client_email: 'push@exprsn-test.iam.gserviceaccount.com' }) };
  })();

  beforeAll(async () => {
    fakes = await new Fakes().start();
  });
  afterAll(async () => {
    await fakes.stop();
  });
  beforeEach(async () => {
    h = await harness({ SERVICE_ALLOWED_HOSTS: '127.0.0.1' }, { push: { endpoints: { googleToken: `${fakes.url}/token` } } });
    adminId = (await localUser(h, 'tadmin', ['tenant-admin'], 'confidential')).id;
    await localUser(h, 'root', ['system-admin'], 'restricted');
    await localUser(h, 'member', ['member'], 'internal');
    admin = await loginAdmin(h, 'tadmin');
    root = await loginAdmin(h, 'root');
    await send(admin, 'post', '/api/vault/policies', { subjectKind: 'user', subject: adminId, path: '*', capabilities: ['*'] }).expect(201);
    fakes.tokenRequests.length = 0;
    fakes.vendor.length = 0;
  });
  afterEach(async () => {
    await h.close();
  });

  it('fetches an FCM OAuth token with a signed assertion, without sending', async () => {
    const st = await send(admin, 'put', '/api/admin/push/secrets', { path: 'push/fcm', data: { service_account: sa.json } }).expect(201);
    expect(JSON.stringify(st.body)).not.toContain('PRIVATE KEY');
    const created = await send(admin, 'post', '/api/admin/push/providers', { kind: 'fcm', name: 'Android', config: { serviceAccountRef: st.body.refs.service_account } }).expect(201);
    expect(created.body.appId).toBeNull();
    const chk = await send(admin, 'post', `/api/admin/push/providers/${created.body.id}/check`).expect(200);
    expect(chk.body).toMatchObject({ ok: true });
    expect(chk.body.detail).toMatch(/OAuth token fetched for push@exprsn-test/);
    expect(fakes.tokenRequests).toHaveLength(1);
    const form = fakes.tokenRequests[0]!;
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const assertion = form.get('assertion')!;
    const [hdr, claims, sig] = jwtParts(assertion);
    expect(hdr).toMatchObject({ alg: 'RS256', kid: 'kid1' });
    expect(claims).toMatchObject({ iss: 'push@exprsn-test.iam.gserviceaccount.com', aud: `${fakes.url}/token`, scope: 'https://www.googleapis.com/auth/firebase.messaging' });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(3600);
    const [ah, ac] = assertion.split('.');
    expect(verify('sha256', Buffer.from(`${ah}.${ac}`), sa.publicKey, fromB64url(sig))).toBe(true);
    const list = await admin.agent.get('/api/admin/push/providers').expect(200);
    expect(list.body.providers[0].lastCheck).toMatchObject({ ok: true });
  });

  it('refuses literal credentials and references the admin cannot read', async () => {
    const lit = await send(admin, 'post', '/api/admin/push/providers', { kind: 'http', name: 'Vendor', config: { url: `${fakes.url}/send`, headers: { Authorization: 'Bearer sk_live_123' }, body: '{"to":{token}}' } });
    expect(lit.status).toBe(400);
    const lit2 = await send(admin, 'post', '/api/admin/push/providers', { kind: 'fcm', name: 'Android', config: { serviceAccountRef: sa.json } });
    expect(lit2.status).toBe(400);
    expect(JSON.stringify(lit2.body)).not.toContain('PRIVATE KEY');
    // A platform provider's references sit under push/ in the platform scope.
    const plat = await send(root, 'post', '/api/admin/platform/push/providers', { kind: 'fcm', name: 'Android', config: { serviceAccountRef: 'vault:apps/fcm#sa' } });
    expect(plat.status).toBe(400);
    expect(plat.body.detail).toMatch(/under vault:push\//);
  });

  it('keeps platform defaults to platform:manage and tenant overrides to tenant:manage', async () => {
    await admin.agent.get('/api/admin/platform/push/providers').expect(403);
    const member = await (await import('./helpers.js')).login(h, 'member');
    await member.agent.get('/api/admin/push/providers').expect(403);
    await root.agent.get('/api/admin/platform/push/providers').expect(200);
    await root.agent.get('/api/admin/push/providers').expect(200);
  });

  it('sends an HTTP vendor test through its template, drops a gone token, and audits every step', async () => {
    await send(admin, 'put', '/api/vault/kv/data/push/vendor', { data: { token: 'vendor-secret-1' } }).expect(201);
    const p = await send(admin, 'post', '/api/admin/push/providers', { kind: 'http', name: 'Vendor', config: { url: `${fakes.url}/send`, auth: { type: 'bearer', tokenRef: 'vault:push/vendor#token' }, body: '{"to":{token},"title":{title},"ttl":{ttl}}' } }).expect(201);
    const ok = await send(admin, 'post', '/api/me/devices', { platform: 'android', provider: 'http', token: 'subscriber-1', name: 'Phone' });
    expect(ok.status).toBeLessThan(300);
    const gone = await send(admin, 'post', '/api/me/devices', { platform: 'web', provider: 'http', token: 'gone-device-1', name: 'Old tablet' });
    expect(gone.status).toBeLessThan(300);
    const t = await send(admin, 'post', `/api/admin/push/providers/${p.body.id}/test`).expect(200);
    const outcomes = Object.fromEntries((t.body.results as { name: string; outcome: string }[]).map((r) => [r.name, r.outcome]));
    expect(outcomes).toEqual({ Phone: 'sent', 'Old tablet': 'gone' });
    const seen = fakes.vendor.find((v) => v.body.includes('subscriber-1'))!;
    expect(seen.auth).toBe('Bearer vendor-secret-1');
    expect(JSON.parse(seen.body)).toEqual({ to: 'subscriber-1', title: 'Test notification', ttl: 300 });
    const devices = (await admin.agent.get('/api/me/devices').expect(200)).body as { devices?: { name: string; state: string }[] } | { name: string; state: string }[];
    const list = Array.isArray(devices) ? devices : devices.devices ?? [];
    expect(list.find((d) => d.name === 'Old tablet')?.state ?? 'gone').toBe('gone');
    // The log has the attempts, never the token or the text.
    const log = await admin.agent.get(`/api/admin/push/deliveries?provider=${p.body.id}`).expect(200);
    expect(log.body.deliveries.map((d: { outcome: string }) => d.outcome).sort()).toEqual(['dropped', 'sent']);
    expect(JSON.stringify(log.body)).not.toMatch(/subscriber-1|gone-device-1|Test notification|vendor-secret/);
    await send(admin, 'patch', `/api/admin/push/providers/${p.body.id}`, { enabled: false }).expect(200);
    await send(admin, 'delete', `/api/admin/push/providers/${p.body.id}`).expect(204);
    const events = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).whereIn('action', ['push.provider.created', 'push.provider.updated', 'push.provider.checked', 'push.provider.deleted', 'push.test.sent']).select('action', 'detail')) as { action: string; detail: string }[];
    expect(new Set(events.map((e) => e.action))).toEqual(new Set(['push.provider.created', 'push.provider.updated', 'push.provider.deleted', 'push.test.sent']));
    expect(JSON.stringify(events)).not.toMatch(/vendor-secret|subscriber-1/);
  });

  it('refuses a host the egress guard refuses, when checking and when sending', async () => {
    const p = await send(admin, 'post', '/api/admin/push/providers', { kind: 'http', name: 'Metadata', config: { url: 'http://169.254.169.254/latest', body: '{"to":{token}}' } }).expect(201);
    const chk = await send(admin, 'post', `/api/admin/push/providers/${p.body.id}/check`).expect(200);
    expect(chk.body.ok).toBe(false);
    expect(chk.body.detail).toMatch(/metadata/);
    await send(admin, 'post', '/api/me/devices', { platform: 'android', provider: 'http', token: 'subscriber-2', name: 'Phone' });
    const t = await send(admin, 'post', `/api/admin/push/providers/${p.body.id}/test`).expect(200);
    expect(t.body.results[0]).toMatchObject({ outcome: 'failed', reason: 'egress refused' });
    const audits = await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'push.provider.checked' });
    expect(audits).toHaveLength(1);
  });

  it('generates VAPID keys into the vault, checks them, and hands browsers the public key', async () => {
    await admin.agent.get('/api/push/web-config').expect(404);
    const k = await send(admin, 'post', '/api/admin/push/vapid-keys', { path: 'push/vapid' }).expect(201);
    expect(k.body.privateKeyRef).toBe('vault:push/vapid#private_key');
    expect(JSON.stringify(k.body)).not.toContain('PRIVATE KEY');
    const p = await send(admin, 'post', '/api/admin/push/providers', { kind: 'webpush', name: 'Browsers', config: { publicKey: k.body.publicKey, privateKeyRef: k.body.privateKeyRef, subject: 'mailto:ops@example.org' } }).expect(201);
    const chk = await send(admin, 'post', `/api/admin/push/providers/${p.body.id}/check`).expect(200);
    expect(chk.body).toMatchObject({ ok: true });
    const cfg = await admin.agent.get('/api/push/web-config').expect(200);
    expect(cfg.body).toEqual({ publicKey: k.body.publicKey, providerId: p.body.id });
    // A platform key goes into the platform scope, which the push service is granted to read.
    const pk = await send(root, 'post', '/api/admin/platform/push/vapid-keys', { path: 'push/vapid' }).expect(201);
    const pp = await send(root, 'post', '/api/admin/platform/push/providers', { kind: 'webpush', name: 'Browsers', config: { publicKey: pk.body.publicKey, privateKeyRef: pk.body.privateKeyRef, subject: 'mailto:ops@example.org' } }).expect(201);
    const pchk = await send(root, 'post', `/api/admin/platform/push/providers/${pp.body.id}/check`).expect(200);
    expect(pchk.body).toMatchObject({ ok: true });
  });
});
