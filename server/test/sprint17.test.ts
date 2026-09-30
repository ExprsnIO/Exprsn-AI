import type * as dnsModule from 'node:dns';
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { createServer, type AddressInfo, type Server as NetServer, type Socket } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import request from 'supertest';
import { authenticator } from 'otplib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Jwk } from '../src/federation/jose.js';
import { selfSignedCertificate } from '../src/federation/x509.js';
import { child, NS, parseXml, verifyEnveloped } from '../src/federation/xml.js';
import { createAdmin } from '../src/identity/admin-create.js';
import { estimateStrength } from '../src/identity/passwords.js';
import { SqlProvider } from '../src/identity/providers/sql.js';
import { sqlConfigSchema, type Step } from '../src/identity/providers/types.js';
import { networkOf } from '../src/identity/signin-notices.js';
import { parseAllowList } from '../src/mcp/hosts.js';
import { fakeHibp } from './fake-account.js';
import { FakeIdp } from './fake-idp.js';
import { harness, localUser, login, loginAdmin, PASSWORD, type Harness } from './helpers.js';

// B-809: names under .sprint17.test resolve by plan (the first answers, then the last one repeats); others resolve normally.
const dnsPlan = vi.hoisted(() => new Map<string, string[]>());
vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof dnsModule>();
  type Cb = (err: NodeJS.ErrnoException | null, address: unknown, family?: number) => void;
  const lookup = (host: string, opts: unknown, cb?: Cb) => {
    const callback = (typeof opts === 'function' ? opts : cb) as Cb;
    const plan = dnsPlan.get(host);
    if (!plan) return (actual.lookup as unknown as (h: string, o: unknown, c: Cb) => void)(host, typeof opts === 'function' ? {} : opts, callback);
    const address = plan.length > 1 ? plan.shift()! : plan[0]!;
    const family = address.includes(':') ? 6 : 4;
    const all = typeof opts === 'object' && opts !== null && (opts as { all?: boolean }).all;
    queueMicrotask(() => callback(null, all ? [{ address, family }] : address, family));
  };
  return { ...actual, lookup, default: { ...actual, lookup } };
});

const ISSUER = 'http://localhost:8080';
const REDIRECT = 'https://app.example.test/cb';
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
const unesc = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const pkce = () => {
  const verifier = b64u(randomBytes(48));
  return { verifier, challenge: b64u(createHash('sha256').update(verifier).digest()) };
};
const ecKey = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as Jwk;
  return { privateKey, jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } as Jwk };
};
/** A DPoP proof with an optional server nonce (RFC 9449 section 8). */
function dpopProof(key: KeyObject, jwk: Jwk, htm: string, htu: string, opts: { token?: string; nonce?: string } = {}): string {
  const header = b64u(JSON.stringify({ typ: 'dpop+jwt', alg: 'ES256', jwk }));
  const claims = b64u(JSON.stringify({ jti: randomBytes(12).toString('hex'), htm, htu, iat: Math.floor(Date.now() / 1000), ...(opts.token ? { ath: b64u(createHash('sha256').update(opts.token).digest()) } : {}), ...(opts.nonce ? { nonce: opts.nonce } : {}) }));
  return `${header}.${claims}.${b64u(cryptoSign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }))}`;
}
const spMetadata = (entity: string, acs: string, cert: string) =>
  `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entity}"><md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${acs}" index="0"/></md:SPSSODescriptor></md:EntityDescriptor>`;
const newCert = (cn: string) => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return selfSignedCertificate({ publicKey, privateKey, commonName: cn, days: 365 }).toString('base64');
};

/** Sprint 17: identity and security. */
describe('Sprint 17: identity and security', () => {
  let h: Harness;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let admin2: Awaited<ReturnType<typeof loginAdmin>>;
  const as = (who: { agent: ReturnType<typeof request.agent>; csrf: string }, method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string, body?: object) => {
    const r = who.agent[method](path).set('x-csrf-token', who.csrf);
    return body ? r.send(body) : r;
  };
  const createClient = async (body: object) => {
    const res = await as(admin, 'post', '/api/admin/federation/oidc/clients', body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { client: { id: string; clientId: string }; secret: string | null };
  };
  const codeFor = async (agent: ReturnType<typeof request.agent>, clientId: string) => {
    const { verifier, challenge } = pkce();
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: 'openid profile chat:read', state: 'st', nonce: 'n', code_challenge: challenge, code_challenge_method: 'S256' });
    const res = await agent.get(`/oauth/authorize?${q}`);
    expect(res.status, res.text).toBe(302);
    return { code: new URL(res.headers.location!).searchParams.get('code')!, verifier };
  };
  const exchange = (clientId: string, secret: string, code: string, verifier: string) =>
    request(h.app).post('/oauth/token').set('authorization', basic(clientId, secret)).type('form').send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier });

  beforeAll(async () => {
    h = await harness();
    await localUser(h, 'idadmin', ['identity-admin', 'member']);
    await localUser(h, 'idadmin2', ['identity-admin', 'member']);
    admin = await loginAdmin(h, 'idadmin');
    admin2 = await loginAdmin(h, 'idadmin2');
  });
  afterAll(async () => h.close());

  describe('B-801: new sign-in notices', () => {
    const notices = async (agent: ReturnType<typeof request.agent>) => ((await agent.get('/api/me/notifications')).body.items as { title: string; body: string }[]).filter((n) => n.title === 'New sign-in to your account');

    it('notifies the first sign-in from a new browser, and not the second', async () => {
      await localUser(h, 'traveller', ['member']);
      // The account's first sign-in has nothing to compare with.
      const first = await login(h, 'traveller');
      expect((first.res.headers['set-cookie'] as unknown as string[]).some((c) => c.startsWith('exai_device='))).toBe(true);
      expect(await notices(first.agent)).toHaveLength(0);
      // The same browser again: known device, known network.
      await first.agent.post('/api/auth/login').send({ username: 'traveller', password: PASSWORD });
      expect(await notices(first.agent)).toHaveLength(0);
      // A new browser (no device cookie) notifies once.
      const other = await login(h, 'traveller');
      const list = await notices(other.agent);
      expect(list).toHaveLength(1);
      expect(list[0]!.body).toMatch(/new browser/);
      // The second sign-in from that browser does not.
      await other.agent.post('/api/auth/login').send({ username: 'traveller', password: PASSWORD });
      expect(await notices(other.agent)).toHaveLength(1);
      // A forged device cookie counts as a new browser.
      const forged = request.agent(h.app);
      await forged.post('/api/auth/login').set('cookie', `exai_device=${'a'.repeat(32)}.${'0'.repeat(32)}`).send({ username: 'traveller', password: PASSWORD });
      expect(await notices(forged)).toHaveLength(2);
      const events = await h.s.db('audit_events').where({ action: 'auth.login.new_context' });
      expect(events.length).toBe(2);
    });

    it('groups addresses into /24 and /48 networks', () => {
      expect(networkOf('10.1.2.3')).toBe('10.1.2.0/24');
      expect(networkOf('::ffff:192.168.7.9')).toBe('192.168.7.0/24');
      expect(networkOf('2001:db8:1:2::5')).toBe('2001:db8:1::/48');
      expect(networkOf('2001:0db8::1')).toBe('2001:db8:0::/48');
      expect(networkOf(null)).toBeNull();
    });
  });

  describe('B-802: password strength', () => {
    it('rates passwords and lists the policy rules for a signed-in user', async () => {
      await localUser(h, 'meter', ['member']);
      const u = await login(h, 'meter');
      const weak = await u.agent.post('/api/auth/password/check').set('x-csrf-token', u.csrf).send({ password: 'meter12345678' });
      expect(weak.status).toBe(200);
      expect(weak.body.rules.find((r: { id: string }) => r.id === 'username').ok).toBe(false);
      expect(weak.body.acceptable).toBe(false);
      expect(weak.body.breached).toMatchObject({ mode: 'off', checked: false });
      const strong = await u.agent.post('/api/auth/password/check').set('x-csrf-token', u.csrf).send({ password: 'violet harbour lanterns drift 42' });
      expect(strong.body.acceptable).toBe(true);
      expect(strong.body.score).toBeGreaterThanOrEqual(3);
      expect(estimateStrength('aaaaaaaaaaaaaaaa', 'x').score).toBe(0);
      expect(estimateStrength('abcdefghijklmnop', 'x').bits).toBeLessThan(estimateStrength('qZ7!mW2#pL9$vR4k', 'x').bits);
      // Signed out and without a password link it is refused.
      expect((await request(h.app).post('/api/auth/password/check').send({ password: 'anything at all' })).status).toBe(401);
    });

    it('reports a breached password when the check is on, and checks with a reset link', async () => {
      const breached = 'hunter2 but much longer';
      const hibp = await fakeHibp([breached]);
      const h2 = await harness({ BREACHED_PASSWORDS: 'hibp', BREACHED_HIBP_URL: hibp.url });
      try {
        const u = await localUser(h2, 'meter2', ['member']);
        const { token } = await h2.s.account.issueToken({ tenantId: h2.tenantId, userId: u.id, kind: 'reset', ttlMs: 60_000 });
        const r = await request(h2.app).post('/api/auth/password/check').send({ password: breached, token });
        expect(r.status).toBe(200);
        expect(r.body.breached).toMatchObject({ mode: 'hibp', checked: true, found: true });
        expect(r.body.acceptable).toBe(false);
        // Only the five-character prefix left.
        expect(hibp.paths.every((p) => /^\/range\/[0-9A-F]{5}$/.test(p))).toBe(true);
      } finally {
        await h2.close();
        await hibp.close();
      }
    });

    it('tells Platform when the breached-password check is off', async () => {
      await localUser(h, 'plat', ['system-admin']);
      const p = await loginAdmin(h, 'plat');
      const sum = await p.agent.get('/api/admin/platform/summary');
      expect(sum.status).toBe(200);
      expect(sum.body.passwords).toEqual({ breachedCheck: 'off' });
    });
  });

  describe('B-803: step-up at the upstream identity provider', () => {
    const idp = new FakeIdp();
    let providerId: string;
    beforeAll(async () => {
      await idp.start();
      process.env.UPSTREAM_SECRET_S17 = idp.clientSecret;
      const created = await as(admin, 'post', '/api/admin/federation/upstream', { name: 'Corp Keycloak', protocol: 'oidc', source: idp.url, clientId: idp.clientId, clientSecret: 'env:UPSTREAM_SECRET_S17' });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      providerId = created.body.id;
      expect((await as(admin, 'post', '/api/admin/group-mappings', { providerId, group: 'staff', role: 'member', clearance: 'internal' })).status).toBe(201);
    });
    afterAll(async () => idp.stop());

    const signInUpstream = async (sub: string, username: string) => {
      const browser = request.agent(h.app);
      const start = await browser.get(`/federation/oidc/start?provider=${providerId}`);
      const { code, state } = idp.authorize(start.headers.location!, { sub, preferred_username: username, groups: ['staff'] });
      expect((await browser.get(`/federation/oidc/callback?${new URLSearchParams({ code, state })}`)).status).toBe(302);
      const session = await browser.get('/api/auth/session');
      expect(session.body.stage).toBe('active');
      return { agent: browser, csrf: session.body.csrf as string };
    };
    const staleSessions = (userId: string) => h.s.db('sessions').where({ user_id: userId }).update({ auth_at: Date.now() - 10 * 60_000, created_at: Date.now() - 10 * 60_000 });

    it('lets an upstream OIDC user with no local factor create an API key after re-authenticating upstream', async () => {
      const u = await signInUpstream('kc-s17', 'upstream.user');
      const user = (await h.s.users.byUsername(h.tenantId, 'upstream.user'))!;
      await staleSessions(user.id);
      const me = await u.agent.get('/api/me');
      expect(me.body.stepUp.methods).toEqual(['upstream']);
      expect(me.body.stepUp.upstream).toEqual({ name: 'Corp Keycloak', protocol: 'oidc' });
      const key = { name: 'ci', scopes: ['chat:read'], ttlDays: 30 };
      const refused = await as(u, 'post', '/api/me/api-keys', key);
      expect(refused.status).toBe(401);

      const start = await as(u, 'post', '/api/me/step-up/upstream', {});
      expect(start.status, JSON.stringify(start.body)).toBe(200);
      const { code, state } = idp.authorize(start.body.url, { sub: 'kc-s17', preferred_username: 'upstream.user', groups: ['staff'] });
      expect(idp.lastPrompt).toBe('login');
      expect(idp.lastMaxAge).toBe('0');
      const cb = await u.agent.get(`/federation/oidc/callback?${new URLSearchParams({ code, state })}`);
      expect(cb.status, cb.text).toBe(302);
      const handle = /#\/settings\?stepup=([A-Za-z0-9_-]+)$/.exec(cb.headers.location!)![1]!;
      // The callback alone does not step up; the handle is redeemed by this session only.
      expect((await as(u, 'post', '/api/me/api-keys', key)).status).toBe(401);
      const other = await signInUpstream('kc-s17', 'upstream.user');
      expect((await as(other, 'post', '/api/me/step-up/upstream/complete', { handle })).status).toBe(400);
      const done = await as(u, 'post', '/api/me/step-up/upstream/complete', { handle });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect(done.body.method).toBe('OIDC (Corp Keycloak)');
      // Single use.
      expect((await as(u, 'post', '/api/me/step-up/upstream/complete', { handle })).status).toBe(400);
      expect((await as(u, 'post', '/api/me/api-keys', key)).status).toBe(201);
      expect(await h.s.db('audit_events').where({ action: 'auth.step_up' }).first()).toBeTruthy();
    });

    it('does not count an upstream session the IdP merely reused, or another upstream account', async () => {
      const u = await signInUpstream('kc-s17b', 'upstream.two');
      await signInUpstream('kc-s17c', 'upstream.three');
      // The IdP reports an old authentication (it ignored max_age=0).
      const start = await as(u, 'post', '/api/me/step-up/upstream', {});
      const a = idp.authorize(start.body.url, { sub: 'kc-s17b', preferred_username: 'upstream.two', groups: ['staff'] });
      idp.authTimeOverride = Math.floor(Date.now() / 1000) - 3600;
      const stale = await u.agent.get(`/federation/oidc/callback?${new URLSearchParams(a)}`);
      idp.authTimeOverride = null;
      expect(stale.status).toBe(400);
      expect(stale.text).toContain('did not sign you in again');
      // Someone else signs in at the IdP.
      const again = await as(u, 'post', '/api/me/step-up/upstream', {});
      const b = idp.authorize(again.body.url, { sub: 'kc-s17c', preferred_username: 'upstream.three', groups: ['staff'] });
      const wrong = await u.agent.get(`/federation/oidc/callback?${new URLSearchParams(b)}`);
      expect(wrong.status).toBe(403);
      // A password session has no upstream step-up.
      await localUser(h, 'pwonly', ['member']);
      const pw = await login(h, 'pwonly');
      expect((await pw.agent.post('/api/me/step-up/upstream').set('x-csrf-token', pw.csrf).send({})).status).toBe(409);
    });
  });

  describe('B-804: admin password reset ends API keys', () => {
    it('revokes the user\'s keys by default and keeps them when unticked', async () => {
      const target = await localUser(h, 'keyholder', ['member']);
      const u = await login(h, 'keyholder');
      const mk = async () => (await u.agent.post('/api/me/api-keys').set('x-csrf-token', u.csrf).send({ name: `k${randomBytes(2).toString('hex')}`, scopes: ['chat:read'], ttlDays: 30 })).body.key as string;
      const key1 = await mk();
      expect((await request(h.app).get('/api/me').set('authorization', `Bearer ${key1}`)).status).toBe(200);
      const kept = await as(admin, 'post', `/api/admin/users/${target.id}/password`, { mode: 'temporary', password: 'a brand new temporary phrase', revokeApiKeys: false });
      expect(kept.status, JSON.stringify(kept.body)).toBe(200);
      expect(kept.body.apiKeysRevoked).toBe(0);
      expect((await request(h.app).get('/api/me').set('authorization', `Bearer ${key1}`)).status).toBe(200);
      const reset = await as(admin, 'post', `/api/admin/users/${target.id}/password`, { mode: 'temporary', password: 'another temporary phrase here' });
      expect(reset.body.apiKeysRevoked).toBe(1);
      expect((await request(h.app).get('/api/me').set('authorization', `Bearer ${key1}`)).status).toBe(401);
    });
  });

  describe('B-806: introspection for registered resource servers', () => {
    it('lets an approved resource server introspect another client\'s token; an ordinary client still cannot', async () => {
      const app = await createClient({ name: 'Ledger app', type: 'confidential, BFF', redirectUris: [REDIRECT], scopes: ['openid', 'profile', 'chat:read'], grants: ['authorization_code'] });
      const rs = await createClient({ name: 'Ledger API', type: 'confidential, BFF', redirectUris: [REDIRECT], scopes: ['openid'], grants: ['authorization_code'] });
      const plain = await createClient({ name: 'Other app', type: 'confidential, BFF', redirectUris: [REDIRECT], scopes: ['openid'], grants: ['authorization_code'] });
      await localUser(h, 'ledgeruser', ['member']);
      const u = await login(h, 'ledgeruser');
      const c = await codeFor(u.agent, app.client.clientId);
      const at = (await exchange(app.client.clientId, app.secret!, c.code, c.verifier)).body.access_token as string;
      const introspect = (id: string, secret: string) => request(h.app).post('/oauth/introspect').set('authorization', basic(id, secret)).type('form').send({ token: at });
      expect((await introspect(rs.client.clientId, rs.secret!)).body).toEqual({ active: false });

      const proposed = await as(admin, 'post', `/api/admin/federation/oidc/clients/${rs.client.id}/introspect`, { mode: 'any', reason: 'The ledger API validates app tokens.' });
      expect(proposed.status, JSON.stringify(proposed.body)).toBe(202);
      expect(proposed.body.client.introspect).toBe('own');
      expect(proposed.body.client.introspectPending).toBe(true);
      // Still own-only while pending, and the proposer cannot approve.
      expect((await introspect(rs.client.clientId, rs.secret!)).body).toEqual({ active: false });
      expect((await as(admin, 'post', `/api/admin/federation/proposals/${proposed.body.proposal.id}/approve`, {})).status).toBe(403);
      const approved = await as(admin2, 'post', `/api/admin/federation/proposals/${proposed.body.proposal.id}/approve`, { note: 'checked' });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(approved.body.state).toBe('approved');
      const ok = await introspect(rs.client.clientId, rs.secret!);
      expect(ok.body).toMatchObject({ active: true, client_id: app.client.clientId, username: 'ledgeruser' });
      expect((await introspect(plain.client.clientId, plain.secret!)).body).toEqual({ active: false });
      // Narrowing applies at once without a second admin.
      expect((await as(admin, 'post', `/api/admin/federation/oidc/clients/${rs.client.id}/introspect`, { mode: 'own' })).body.client.introspect).toBe('own');
      expect((await introspect(rs.client.clientId, rs.secret!)).body).toEqual({ active: false });
      expect(await h.s.db('audit_events').where({ action: 'federation.proposal.approved' }).first()).toBeTruthy();
    });
  });

  describe('B-807: SAML response signing and fetched metadata', () => {
    let meta: Server;
    let metaUrl = '';
    const served: Record<string, string> = {};
    beforeAll(async () => {
      const app = express();
      app.get('/:name', (req, res) => (served[String(req.params.name)] ? res.type('application/samlmetadata+xml').send(served[String(req.params.name)]) : res.status(404).end()));
      await new Promise<void>((resolve) => (meta = app.listen(0, '127.0.0.1', () => resolve())));
      metaUrl = `http://127.0.0.1:${(meta.address() as AddressInfo).port}`;
    });
    afterAll(async () => new Promise<void>((resolve) => meta.close(() => resolve())));

    it('signs the whole response when the service provider asks for it', async () => {
      const t = (await h.s.federation.tenantById(h.tenantId))!;
      const sp = await h.s.federation.saml.create(h.tenantId, { name: 'Whole-response SP', entityId: 'https://whole.example.test', acsUrls: [{ url: 'https://whole.example.test/acs', index: 0, binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST' }], nameIdFormat: 'unspecified', certificate: null, signedRequests: false, attributeMap: {}, signResponse: true });
      const b64 = await h.s.federation.saml.response(t, sp, sp.acs_urls[0]!, null, { id: 'u1', username: 'jdoe', displayName: 'J Doe', email: null, groups: [], roles: ['member'], clearance: 'internal', authTime: Date.now(), method: 'Local password' });
      const root = parseXml(Buffer.from(b64, 'base64').toString('utf8'));
      const cert = (await h.s.federation.saml.certificate(t)).certificate;
      expect(verifyEnveloped(root, root, [cert]).ok).toBe(true);
      expect(child(root, NS.ds, 'Signature')).toBeTruthy();
      expect(verifyEnveloped(root, child(root, NS.saml, 'Assertion')!, [cert]).ok).toBe(true);
      const off = await h.s.federation.saml.update(h.tenantId, sp.id, { signResponse: false });
      const plain = parseXml(Buffer.from(await h.s.federation.saml.response(t, off!, sp.acs_urls[0]!, null, { id: 'u1', username: 'jdoe', displayName: 'J Doe', email: null, groups: [], roles: [], clearance: 'internal', authTime: Date.now(), method: 'Local password' }), 'base64').toString('utf8'));
      expect(child(plain, NS.ds, 'Signature')).toBeUndefined();
    });

    it('fetches SP metadata from a URL and holds a changed certificate for approval', async () => {
      const entity = 'https://fetched.example.test/sp';
      const certA = newCert('fetched-a.example.test');
      const certB = newCert('fetched-b.example.test');
      served['sp.xml'] = spMetadata(entity, 'https://fetched.example.test/acs', certA);
      const created = await as(admin, 'post', '/api/admin/federation/saml/sps', { name: 'Fetched SP', metadataUrl: `${metaUrl}/sp.xml`, signResponse: true });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.signResponse).toBe(true);
      const id = created.body.id as string;
      const sources = (await as(admin, 'get', '/api/admin/federation/metadata')).body as { id: string; url: string }[];
      expect(sources.find((x) => x.id === id)?.url).toBe(`${metaUrl}/sp.xml`);

      // Unchanged metadata only records the fetch.
      expect((await as(admin, 'post', `/api/admin/federation/metadata/${id}/refresh`, {})).body.state).toBe('unchanged');
      // A new certificate is proposed, not applied.
      served['sp.xml'] = spMetadata(entity, 'https://fetched.example.test/acs', certB);
      const out = await h.s.federation.metadata.refreshTenant(h.tenantId);
      expect(out.proposed).toBe(1);
      expect((await h.s.federation.saml.get(h.tenantId, id))!.certificate).toBe(certA);
      const pending = (await as(admin, 'get', '/api/admin/federation/proposals?state=pending')).body as { id: string; kind: string; targetId: string; summary: string }[];
      const p = pending.find((x) => x.targetId === id)!;
      expect(p.kind).toBe('metadata.sp');
      expect(p.summary).toMatch(/signing certificate/);
      // Fetching the same change again does not pile up proposals.
      expect((await h.s.federation.metadata.refresh(h.tenantId, id)).state).toBe('pending');
      // The refresh job proposed it, so any identity admin approves.
      const ok = await as(admin, 'post', `/api/admin/federation/proposals/${p.id}/approve`, {});
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect((await h.s.federation.saml.get(h.tenantId, id))!.certificate).toBe(certB);
      // Metadata for another entity is refused outright.
      served['sp.xml'] = spMetadata('https://someone-else.example.test', 'https://evil.example.test/acs', certB);
      const other = await h.s.federation.metadata.refresh(h.tenantId, id);
      expect(other.state).toBe('error');
      expect((await h.s.federation.saml.get(h.tenantId, id))!.acs_urls[0]!.url).toBe('https://fetched.example.test/acs');
    });

    it('fetches upstream IdP metadata through the outbound checks', async () => {
      const cert = newCert('idp-a.example.test');
      const entity = 'https://idp.fetched.example.test';
      served['idp.xml'] = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entity}"><md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.fetched.example.test/sso"/></md:IDPSSODescriptor></md:EntityDescriptor>`;
      const created = await as(admin, 'post', '/api/admin/federation/upstream', { name: 'Fetched IdP', protocol: 'saml', source: `${metaUrl}/idp.xml` });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const next = newCert('idp-b.example.test');
      served['idp.xml'] = served['idp.xml'].replace(cert, next);
      const r = await as(admin, 'post', `/api/admin/federation/metadata/${created.body.id}/refresh`, {});
      expect(r.body.state).toBe('proposed');
      expect(((await h.s.providers.get(h.tenantId, created.body.id))!.config as { certificates: string[] }).certificates).toEqual([cert]);
      expect((await as(admin2, 'post', `/api/admin/federation/proposals/${r.body.proposal.id}/approve`, {})).status).toBe(200);
      expect(((await h.s.providers.get(h.tenantId, created.body.id))!.config as { certificates: string[] }).certificates).toEqual([next]);
      // A metadata URL on a public address is refused (SSRF).
      expect((await as(admin, 'post', '/api/admin/federation/saml/sps', { name: 'Public', metadataUrl: 'http://8.8.8.8/metadata' })).status).toBe(400);
    });
  });

  describe('B-808: console sign-out runs front-channel logout', () => {
    it('loads each front-channel URI on the signed-out page', async () => {
      const a = await createClient({ name: 'Frontchannel RP', type: 'confidential, BFF', redirectUris: [REDIRECT], scopes: ['openid', 'profile', 'chat:read'], grants: ['authorization_code'], frontchannelLogoutUri: 'https://rp-front.example.test/logout' });
      await localUser(h, 'frontuser', ['member']);
      const u = await login(h, 'frontuser');
      const c = await codeFor(u.agent, a.client.clientId);
      const tok = await exchange(a.client.clientId, a.secret!, c.code, c.verifier);
      expect(tok.status).toBe(200);
      const out = await u.agent.post('/api/auth/logout').set('x-csrf-token', u.csrf);
      expect(out.status).toBe(200);
      expect(out.body.next).toMatch(/^\/oauth\/logged-out\?handle=[A-Za-z0-9_-]{32}$/);
      expect((await u.agent.get('/api/auth/session')).body.authenticated).toBe(false);
      const page = await u.agent.get(out.body.next);
      expect(page.status).toBe(200);
      expect(page.text).toContain('data-mode="logout"');
      const frame = unesc(/<iframe src="([^"]+)"/.exec(page.text)![1]!);
      expect(frame.startsWith(`https://rp-front.example.test/logout?iss=${encodeURIComponent(ISSUER)}&sid=`)).toBe(true);
      expect(page.headers['content-security-policy']).toContain('frame-src https://rp-front.example.test');
      // The handle works once.
      expect((await u.agent.get(out.body.next)).text).not.toContain('<iframe');
      // A session with no front-channel applications signs out as before.
      await localUser(h, 'plainuser', ['member']);
      const p = await login(h, 'plainuser');
      expect((await p.agent.post('/api/auth/logout').set('x-csrf-token', p.csrf)).status).toBe(204);
    });
  });

  describe('B-810: first admin enrolment link', () => {
    it('creates an admin who must use the link, and whose session can only enrol a factor', async () => {
      const out = await createAdmin(h.s, { username: 'firstroot', displayName: 'First Root', password: null });
      expect(out.enrol).toBeTruthy();
      const token = /#\/signin\?reset=([A-Za-z0-9_-]{43})/.exec(out.enrol!.link)![1]!;
      // No password works before the link is used.
      expect((await request(h.app).post('/api/auth/login').send({ username: 'firstroot', password: PASSWORD })).status).toBe(401);
      const browser = request.agent(h.app);
      const set = await browser.post('/api/auth/password/reset').send({ token, password: 'the first root chooses this' });
      expect(set.status, JSON.stringify(set.body)).toBe(200);
      expect(set.body.session).toMatchObject({ stage: 'enroll', authenticated: false });
      const csrf = set.body.session.csrf as string;
      // Before a factor exists no admin route answers.
      const blocked = await browser.get('/api/admin/users');
      expect(blocked.status).toBe(401);
      expect(blocked.body.stage).toBe('enroll');
      // The link works once.
      expect((await request(h.app).post('/api/auth/password/reset').send({ token, password: 'the first root chooses this' })).status).toBe(400);
      const begin = await browser.post('/api/me/mfa/totp').set('x-csrf-token', csrf).send({});
      const confirm = await browser.post(`/api/me/mfa/totp/${begin.body.id}/confirm`).set('x-csrf-token', csrf).send({ code: authenticator.generate(begin.body.secret) });
      expect(confirm.status).toBe(201);
      expect(confirm.body.stage).toBe('active');
      expect((await browser.get('/api/admin/users')).status).toBe(200);
      // A password sign-in now asks for the factor.
      expect((await request(h.app).post('/api/auth/login').send({ username: 'firstroot', password: 'the first root chooses this' })).body.stage).toBe('mfa');
    });
  });
});

describe('B-805: DPoP nonces and a proxied API base', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness({ DPOP_NONCES: 'true', API_PUBLIC_URL: 'https://gw.example.test/ai' });
  });
  afterAll(async () => h.close());

  it('asks for a nonce, then accepts proofs carrying it against the proxied htu', async () => {
    await localUser(h, 'idadmin', ['identity-admin', 'member']);
    const admin = await loginAdmin(h, 'idadmin');
    const created = await admin.agent.post('/api/admin/federation/oidc/clients').set('x-csrf-token', admin.csrf).send({ name: 'Proxied', type: 'confidential, BFF', redirectUris: [REDIRECT], scopes: ['openid', 'chat:read'], grants: ['authorization_code'], dpopRequired: true });
    const client = created.body as { client: { clientId: string }; secret: string };
    await localUser(h, 'proxyuser', ['member']);
    const u = await login(h, 'proxyuser');
    const { verifier, challenge } = pkce();
    const q = new URLSearchParams({ response_type: 'code', client_id: client.client.clientId, redirect_uri: REDIRECT, scope: 'openid chat:read', state: 's', nonce: 'n', code_challenge: challenge, code_challenge_method: 'S256' });
    const code = new URL((await u.agent.get(`/oauth/authorize?${q}`)).headers.location!).searchParams.get('code')!;
    const key = ecKey();
    const tokenUrl = `${ISSUER}/oauth/token`;
    const send = (proof: string) => request(h.app).post('/oauth/token').set('authorization', basic(client.client.clientId, client.secret)).set('dpop', proof).type('form').send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier });
    const first = await send(dpopProof(key.privateKey, key.jwk, 'POST', tokenUrl));
    expect(first.status).toBe(400);
    expect(first.body.error).toBe('use_dpop_nonce');
    const nonce = first.headers['dpop-nonce'] as string;
    expect(nonce).toMatch(/^[0-9a-f]{43}$/);
    const tok = await send(dpopProof(key.privateKey, key.jwk, 'POST', tokenUrl, { nonce }));
    expect(tok.status, JSON.stringify(tok.body)).toBe(200);
    const at = tok.body.access_token as string;

    const proxied = 'https://gw.example.test/ai/api/me';
    const noNonce = await request(h.app).get('/api/me').set('authorization', `DPoP ${at}`).set('dpop', dpopProof(key.privateKey, key.jwk, 'GET', proxied, { token: at }));
    expect(noNonce.status).toBe(401);
    expect(noNonce.body.error).toBe('use_dpop_nonce');
    expect(noNonce.headers['www-authenticate']).toContain('use_dpop_nonce');
    const fresh = noNonce.headers['dpop-nonce'] as string;
    const ok = await request(h.app).get('/api/me').set('authorization', `DPoP ${at}`).set('dpop', dpopProof(key.privateKey, key.jwk, 'GET', proxied, { token: at, nonce: fresh }));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // The unproxied address is not where this API is served.
    const direct = await request(h.app).get('/api/me').set('authorization', `DPoP ${at}`).set('dpop', dpopProof(key.privateKey, key.jwk, 'GET', `${ISSUER}/api/me`, { token: at, nonce: fresh }));
    expect(direct.status).toBe(401);
    // A made-up nonce is refused like a missing one.
    const bogus = await request(h.app).get('/api/me').set('authorization', `DPoP ${at}`).set('dpop', dpopProof(key.privateKey, key.jwk, 'GET', proxied, { token: at, nonce: 'f'.repeat(43) }));
    expect(bogus.body.error).toBe('use_dpop_nonce');
  });
});

describe('B-809: SQL user stores dial the checked address', () => {
  let server: NetServer;
  let port = 0;
  const seen: string[] = [];
  beforeAll(async () => {
    server = createServer((sock: Socket) => {
      seen.push(sock.localAddress ?? '');
      sock.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => new Promise<void>((resolve) => server.close(() => resolve())));

  it('dials the address it checked, and refuses a name that re-resolves to a link-local address', async () => {
    // Checked twice (before the pool, and for the connection): 127.0.0.1; any later lookup gives the metadata address.
    dnsPlan.set('hr-db.sprint17.test', ['127.0.0.1', '127.0.0.1', '169.254.169.254']);
    process.env.HR_PINNED = `postgres://reader:pw@hr-db.sprint17.test:${port}/hr`;
    const p = new SqlProvider('p', 'HR', sqlConfigSchema.parse({ dialect: 'pg', connection: 'env:HR_PINNED', table: 'staff', columns: { username: 'login', passwordHash: 'pw' }, timeoutMs: 2000 }), { allow: parseAllowList(''), refusedSqliteFiles: [] });
    const steps: Step[] = [];
    expect(await p.test(steps)).toBe(false);
    expect(steps[0]).toMatchObject({ title: 'Check the database host', ok: true });
    // The driver reached the checked address although the name itself does not resolve for it.
    expect(seen).toEqual(['127.0.0.1']);
    // The next connection re-checks the name, which now points at the metadata service: refused, never dialled.
    const r = await p.authenticate('jdoe', PASSWORD);
    expect(r.status).toBe('error');
    expect((r as { message: string }).message).toMatch(/link-local/);
    expect(seen).toEqual(['127.0.0.1']);
    await p.close();
  });
});
