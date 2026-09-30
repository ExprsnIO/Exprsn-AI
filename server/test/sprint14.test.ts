import { constants, createCipheriv, createDecipheriv, createHash, generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes, sign as cryptoSign, X509Certificate, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeJwt, signJwt, verifyJwt, type Jwk } from '../src/federation/jose.js';
import { SigningKeys } from '../src/federation/keys.js';
import { selfSignedCertificate } from '../src/federation/x509.js';
import { parseXml, signEnveloped, verifyEnveloped, verifyRedirectSignature, type XmlElement } from '../src/federation/xml.js';
import { FakeOpenBao } from './fake-openbao.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';

const ISSUER = 'http://localhost:8080';
const REDIRECT = 'https://app.example.test/cb';
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const pkce = () => {
  const verifier = b64u(randomBytes(48));
  return { verifier, challenge: b64u(createHash('sha256').update(verifier).digest()) };
};
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
const unesc = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const until = async (fn: () => Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out');
};

/** A DPoP proof (RFC 9449) signed by `key`, for `htm` and `htu`, optionally bound to an access token. */
function dpopProof(key: KeyObject, jwk: Jwk, htm: string, htu: string, token?: string, iat = Math.floor(Date.now() / 1000)): string {
  const header = b64u(JSON.stringify({ typ: 'dpop+jwt', alg: 'ES256', jwk }));
  const claims = b64u(JSON.stringify({ jti: randomBytes(12).toString('hex'), htm, htu, iat, ...(token ? { ath: b64u(createHash('sha256').update(token).digest()) } : {}) }));
  return `${header}.${claims}.${b64u(cryptoSign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }))}`;
}

const ecKey = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as Jwk;
  return { privateKey, jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } as Jwk };
};

/** A relying party's back-channel logout endpoints: records each logout token posted to it. */
class FakeRp {
  url = '';
  readonly received: { path: string; token: string }[] = [];
  private server: Server | null = null;
  async start() {
    const app = express();
    app.post('/:rp/backchannel', express.urlencoded({ extended: false }), (req, res) => {
      this.received.push({ path: String(req.params.rp), token: String(req.body.logout_token) });
      res.status(200).end();
    });
    await new Promise<void>((resolve) => (this.server = app.listen(0, '127.0.0.1', () => resolve())));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }
  async stop() {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

describe('Sprint 14: federation', () => {
  let h: Harness;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  const rp = new FakeRp();
  const as = (method: 'get' | 'post' | 'patch' | 'delete', path: string, body?: object) => {
    const r = admin.agent[method](path).set('x-csrf-token', admin.csrf);
    return body ? r.send(body) : r;
  };
  const jwks = async (): Promise<Jwk[]> => (await request(h.app).get('/.well-known/jwks.json')).body.keys;
  const createClient = async (body: object) => {
    const res = await as('post', '/api/admin/federation/oidc/clients', body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { client: { id: string; clientId: string }; secret: string | null };
  };
  /** Authorizes as `agent` and returns the code (the client must not ask for consent). */
  const codeFor = async (agent: ReturnType<typeof request.agent>, clientId: string, extra: Record<string, string> = {}) => {
    const { verifier, challenge } = pkce();
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: 'openid profile chat:read', state: 'st', nonce: 'n', code_challenge: challenge, code_challenge_method: 'S256', ...extra });
    const res = await agent.get(`/oauth/authorize?${q}`);
    expect(res.status, res.text).toBe(302);
    return { code: new URL(res.headers.location!).searchParams.get('code')!, verifier };
  };
  const exchange = (clientId: string, secret: string, code: string, verifier: string, headers: Record<string, string> = {}) => {
    let r = request(h.app).post('/oauth/token').set('authorization', basic(clientId, secret));
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r.type('form').send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier });
  };

  beforeAll(async () => {
    h = await harness();
    await rp.start();
    await localUser(h, 'idadmin', ['identity-admin', 'member']);
    admin = await loginAdmin(h, 'idadmin');
  });
  afterAll(async () => {
    await rp.stop();
    await h.close();
  });

  it('advertises the new endpoints and capabilities in discovery', async () => {
    const d = (await request(h.app).get('/.well-known/openid-configuration')).body;
    expect(d).toMatchObject({
      introspection_endpoint: `${ISSUER}/oauth/introspect`,
      revocation_endpoint: `${ISSUER}/oauth/revoke`,
      end_session_endpoint: `${ISSUER}/oauth/logout`,
      pushed_authorization_request_endpoint: `${ISSUER}/oauth/par`,
      request_parameter_supported: true,
      backchannel_logout_supported: true,
      backchannel_logout_session_supported: true,
      frontchannel_logout_supported: true
    });
    expect(d.dpop_signing_alg_values_supported).toEqual(['ES256', 'RS256']);
    expect(d.request_object_signing_alg_values_supported).toEqual(['ES256', 'RS256']);
  });

  describe('B-108: revocation and introspection', () => {
    let c1: { client: { clientId: string }; secret: string | null };
    let c2: { client: { clientId: string }; secret: string | null };
    let user: Awaited<ReturnType<typeof login>>;

    beforeAll(async () => {
      c1 = await createClient({ name: 'Ledger', type: 'confidential, BFF', redirectUris: [REDIRECT], scopes: ['openid', 'profile', 'chat:read'], grants: ['authorization_code', 'refresh_token'] });
      c2 = await createClient({ name: 'Other resource server', type: 'confidential, BFF', redirectUris: [REDIRECT], scopes: ['openid'], grants: ['authorization_code'] });
      await localUser(h, 'rvuser', ['member']);
      user = await login(h, 'rvuser');
    });

    it('refuses a revoked access token before it expires, and keeps other tokens working', async () => {
      const { code, verifier } = await codeFor(user.agent, c1.client.clientId);
      const tok = await exchange(c1.client.clientId, c1.secret!, code, verifier);
      expect(tok.status, JSON.stringify(tok.body)).toBe(200);
      const at = tok.body.access_token as string;
      // A successful call first, so this instance has the token's check cached.
      expect((await request(h.app).get('/api/me').set('authorization', `Bearer ${at}`)).status).toBe(200);
      const rev = await request(h.app).post('/oauth/revoke').set('authorization', basic(c1.client.clientId, c1.secret!)).type('form').send({ token: at, token_type_hint: 'access_token' });
      expect(rev.status).toBe(200);
      const me = await request(h.app).get('/api/me').set('authorization', `Bearer ${at}`);
      expect(me.status).toBe(401);
      expect((await request(h.app).get('/oauth/userinfo').set('authorization', `Bearer ${at}`)).status).toBe(401);
      // On the shared deny-list until the token would have expired.
      const row = await h.s.db('oidc_denied').where({ id: `jti:${decodeJwt(at).claims.jti}` }).first();
      expect(Number(row.expires_at)).toBeGreaterThanOrEqual(Number(decodeJwt(at).claims.exp) * 1000);
      expect((await h.s.db('audit_events').where({ action: 'oidc.token.revoked' })).length).toBe(1);
      // The grant itself lives on: the refresh token still works and its new access token is accepted.
      const r = await request(h.app).post('/oauth/token').set('authorization', basic(c1.client.clientId, c1.secret!)).type('form').send({ grant_type: 'refresh_token', refresh_token: tok.body.refresh_token });
      expect(r.status).toBe(200);
      expect((await request(h.app).get('/api/me').set('authorization', `Bearer ${r.body.access_token}`)).status).toBe(200);
      // Another client cannot revoke it (and learns nothing).
      const other = await request(h.app).post('/oauth/revoke').set('authorization', basic(c2.client.clientId, c2.secret!)).type('form').send({ token: r.body.access_token });
      expect(other.status).toBe(200);
      expect((await request(h.app).get('/api/me').set('authorization', `Bearer ${r.body.access_token}`)).status).toBe(200);
    });

    it('introspects tokens for the client they were issued to, and other clients\' tokens as inactive', async () => {
      const { code, verifier } = await codeFor(user.agent, c1.client.clientId);
      const tok = await exchange(c1.client.clientId, c1.secret!, code, verifier);
      const introspect = (id: string, secret: string, token: string, hint?: string) => request(h.app).post('/oauth/introspect').set('authorization', basic(id, secret)).type('form').send({ token, ...(hint ? { token_type_hint: hint } : {}) });
      const mine = await introspect(c1.client.clientId, c1.secret!, tok.body.access_token);
      expect(mine.status).toBe(200);
      expect(mine.headers['cache-control']).toBe('no-store');
      expect(mine.body).toMatchObject({ active: true, client_id: c1.client.clientId, token_type: 'Bearer', username: 'rvuser', iss: ISSUER });
      expect(mine.body.scope).toContain('chat:read');
      expect((await introspect(c1.client.clientId, c1.secret!, tok.body.refresh_token)).body).toMatchObject({ active: true, token_type: 'refresh_token', client_id: c1.client.clientId });
      expect((await introspect(c2.client.clientId, c2.secret!, tok.body.access_token)).body).toEqual({ active: false });
      expect((await introspect(c2.client.clientId, c2.secret!, tok.body.refresh_token)).body).toEqual({ active: false });
      expect((await introspect(c1.client.clientId, c1.secret!, 'garbage')).body).toEqual({ active: false });
      await request(h.app).post('/oauth/revoke').set('authorization', basic(c1.client.clientId, c1.secret!)).type('form').send({ token: tok.body.access_token });
      expect((await introspect(c1.client.clientId, c1.secret!, tok.body.access_token)).body).toEqual({ active: false });
      // Public clients cannot introspect; bad credentials are refused.
      const pub = await createClient({ name: 'Public CLI', type: 'public', scopes: ['openid'], grants: ['device_code'] });
      expect((await request(h.app).post('/oauth/introspect').type('form').send({ client_id: pub.client.clientId, token: tok.body.access_token })).status).toBe(401);
      expect((await introspect(c1.client.clientId, 'wrong', tok.body.access_token)).status).toBe(401);
    });
  });

  describe('B-107: a user lists and revokes their own grants', () => {
    it('ends the grant\'s tokens at once and notifies the user', async () => {
      const tp = await createClient({ name: 'Notebook', type: 'third party', redirectUris: [REDIRECT], scopes: ['openid', 'chat:read'], grants: ['authorization_code', 'refresh_token'] });
      await localUser(h, 'grantuser', ['member']);
      const u = await login(h, 'grantuser');
      const { verifier, challenge } = pkce();
      const q = new URLSearchParams({ response_type: 'code', client_id: tp.client.clientId, redirect_uri: REDIRECT, scope: 'openid chat:read', code_challenge: challenge, code_challenge_method: 'S256' });
      const consent = await u.agent.get(`/oauth/authorize?${q}`);
      expect(consent.text).toContain('Allow Notebook');
      const handle = /name="handle" value="([^"]+)"/.exec(consent.text)![1]!;
      const csrf = /name="csrf" value="([^"]+)"/.exec(consent.text)![1]!;
      const allow = await u.agent.post('/oauth/authorize').type('form').send({ handle, csrf, decision: 'allow' });
      const tok = await exchange(tp.client.clientId, tp.secret!, new URL(allow.headers.location!).searchParams.get('code')!, verifier);
      expect(tok.status).toBe(200);
      const list = await u.agent.get('/api/me/grants');
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).toMatchObject({ clientId: tp.client.clientId, name: 'Notebook', activeGrants: 1 });
      expect(list.body[0].scopes).toEqual(['chat:read', 'openid']);
      expect((await request(h.app).get('/api/me').set('authorization', `Bearer ${tok.body.access_token}`)).status).toBe(200);

      // Only the owner, with a CSRF token; an unknown client is not found.
      expect((await u.agent.delete(`/api/me/grants/${tp.client.clientId}`)).status).toBe(403);
      expect((await u.agent.delete('/api/me/grants/c_nothere').set('x-csrf-token', u.csrf)).status).toBe(404);
      const del = await u.agent.delete(`/api/me/grants/${tp.client.clientId}`).set('x-csrf-token', u.csrf);
      expect(del.status, JSON.stringify(del.body)).toBe(200);
      expect(del.body).toMatchObject({ revoked: true, consents: 1 });
      // Every token of the grant stops working now (ASVS 3.5.1).
      expect((await request(h.app).get('/api/me').set('authorization', `Bearer ${tok.body.access_token}`)).status).toBe(401);
      expect((await request(h.app).get('/oauth/userinfo').set('authorization', `Bearer ${tok.body.access_token}`)).status).toBe(401);
      expect((await request(h.app).post('/oauth/token').set('authorization', basic(tp.client.clientId, tp.secret!)).type('form').send({ grant_type: 'refresh_token', refresh_token: tok.body.refresh_token })).body.error).toBe('invalid_grant');
      expect((await u.agent.get('/api/me/grants')).body).toEqual([]);
      // The consent is forgotten: the next authorization asks again.
      expect((await u.agent.get(`/oauth/authorize?${q}`)).text).toContain('Allow Notebook');
      const user = await h.s.users.byUsername(h.tenantId, 'grantuser');
      const notes = await h.s.db('notifications').where({ user_id: user!.id, kind: 'security' }).orderBy('created_at');
      expect(notes.map((n: { title: string }) => n.title)).toEqual(['Notebook can now act as you', 'Access removed for Notebook']);
      expect((await h.s.db('audit_events').where({ action: 'oidc.grant.revoked_by_user' })).length).toBe(1);
    });
  });

  describe('B-401: RP-initiated, front-channel and back-channel logout', () => {
    it('signs out, loads front-channel frames and delivers logout tokens to every back-channel client', async () => {
      const a = await createClient({ name: 'RP A', type: 'confidential, BFF', redirectUris: [REDIRECT], scopes: ['openid', 'profile', 'chat:read'], grants: ['authorization_code', 'refresh_token'], postLogoutRedirectUris: ['https://rp-a.example.test/bye'], frontchannelLogoutUri: 'https://rp-a.example.test/frontchannel', backchannelLogoutUri: `${rp.url}/a/backchannel` });
      const b = await createClient({ name: 'RP B', type: 'confidential, BFF', redirectUris: [REDIRECT], scopes: ['openid', 'chat:read'], grants: ['authorization_code'], backchannelLogoutUri: `${rp.url}/b/backchannel` });
      await localUser(h, 'loguser', ['member']);
      const u = await login(h, 'loguser');
      const ca = await codeFor(u.agent, a.client.clientId);
      const ta = await exchange(a.client.clientId, a.secret!, ca.code, ca.verifier);
      const cb = await codeFor(u.agent, b.client.clientId);
      expect((await exchange(b.client.clientId, b.secret!, cb.code, cb.verifier)).status).toBe(200);
      const idToken = ta.body.id_token as string;
      const sid = decodeJwt(idToken).claims.sid as string;
      expect(sid).toMatch(/^[0-9a-f]{32}$/);

      // The post-logout redirect must be registered for the client named by the hint.
      const bad = await request(h.app).get(`/oauth/logout?${new URLSearchParams({ id_token_hint: idToken, post_logout_redirect_uri: 'https://evil.example.test/' })}`);
      expect(bad.status).toBe(400);
      const ask = await request(h.app).get(`/oauth/logout?${new URLSearchParams({ id_token_hint: idToken, post_logout_redirect_uri: 'https://rp-a.example.test/bye', state: 'xyz' })}`);
      expect(ask.status).toBe(200);
      expect(ask.text).toContain('RP A</b> asks to sign you out');
      const handle = /name="handle" value="([^"]+)"/.exec(ask.text)![1]!;
      // A cross-site confirmation is refused.
      expect((await u.agent.post('/oauth/logout').set('origin', 'https://evil.example.test').type('form').send({ handle, decision: 'logout' })).status).toBe(403);
      const out = await u.agent.post('/oauth/logout').type('form').send({ handle, decision: 'logout' });
      expect(out.status).toBe(200);
      expect(out.text).toContain('data-mode="logout"');
      const frame = unesc(/<iframe src="([^"]+)"/.exec(out.text)![1]!);
      expect(frame).toBe(`https://rp-a.example.test/frontchannel?iss=${encodeURIComponent(ISSUER)}&sid=${sid}`);
      // Only the logout page may frame, and only the registered front-channel origin.
      expect(out.headers['content-security-policy']).toContain('frame-src https://rp-a.example.test');
      expect(unesc(/data-continue="([^"]+)"/.exec(out.text)![1]!)).toBe('https://rp-a.example.test/bye?state=xyz');
      expect((await u.agent.get('/api/auth/session')).body.authenticated).toBe(false);
      // The handle works once.
      expect((await u.agent.post('/oauth/logout').type('form').send({ handle, decision: 'logout' })).status).toBe(400);
      // The session's refresh tokens ended with it.
      expect((await request(h.app).post('/oauth/token').set('authorization', basic(a.client.clientId, a.secret!)).type('form').send({ grant_type: 'refresh_token', refresh_token: ta.body.refresh_token })).body.error).toBe('invalid_grant');

      // Back-channel: one job per client, each posting a signed logout token.
      await until(async () => (await h.s.db('jobs').where({ type: 'federation.backchannel' })).length === 2);
      await h.s.jobs.runDue();
      expect(rp.received.map((x) => x.path).sort()).toEqual(['a', 'b']);
      const keys = await jwks();
      for (const { path, token } of rp.received) {
        const aud = path === 'a' ? a.client.clientId : b.client.clientId;
        const claims = verifyJwt(token, keys, { issuer: ISSUER, audience: aud, algs: ['ES256'], typ: 'logout+jwt' });
        expect(claims.sid).toBe(sid);
        expect(claims.events).toEqual({ 'http://schemas.openid.net/event/backchannel-logout': {} });
        expect(claims.nonce).toBeUndefined();
        expect(claims.sub).toBe((await h.s.users.byUsername(h.tenantId, 'loguser'))!.id);
      }
      expect((await h.s.db('audit_events').where({ action: 'oidc.logout.backchannel' })).length).toBe(2);
    });

    it('also reaches back-channel clients when the session ends in the console', async () => {
      const c = await createClient({ name: 'RP C', type: 'confidential, BFF', redirectUris: [REDIRECT], scopes: ['openid'], grants: ['authorization_code'], backchannelLogoutUri: `${rp.url}/c/backchannel` });
      await localUser(h, 'logcon', ['member']);
      const u = await login(h, 'logcon');
      const cc = await codeFor(u.agent, c.client.clientId, { scope: 'openid' });
      expect((await exchange(c.client.clientId, c.secret!, cc.code, cc.verifier)).status).toBe(200);
      expect((await u.agent.post('/api/auth/logout').set('x-csrf-token', u.csrf)).status).toBe(204);
      await until(async () => (await h.s.db('jobs').where({ type: 'federation.backchannel' })).length === 3);
      await h.s.jobs.runDue();
      expect(rp.received.filter((x) => x.path === 'c')).toHaveLength(1);
    });

    it('refuses back-channel URIs that are not https or loopback', async () => {
      const res = await as('post', '/api/admin/federation/oidc/clients', { name: 'Bad logout', type: 'third party', redirectUris: [REDIRECT], scopes: ['openid'], grants: ['authorization_code'], backchannelLogoutUri: 'http://rp.example.test/logout' });
      expect(res.status).toBe(400);
    });
  });

  describe('B-402: prompt=login and max_age', () => {
    let c: { client: { clientId: string }; secret: string | null };
    beforeAll(async () => {
      c = await createClient({ name: 'Treasury', type: 'confidential, BFF', redirectUris: [REDIRECT], scopes: ['openid', 'chat:read'], grants: ['authorization_code'] });
      await localUser(h, 'reauth', ['member']);
    });
    const url = (extra: Record<string, string>) => `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: c.client.clientId, redirect_uri: REDIRECT, scope: 'openid', state: 's', code_challenge: pkce().challenge, code_challenge_method: 'S256', ...extra })}`;

    it('asks an old session to sign in again (max_age)', async () => {
      const u = await login(h, 'reauth');
      const user = await h.s.users.byUsername(h.tenantId, 'reauth');
      await h.s.db('sessions').where({ user_id: user!.id, revoked_at: null }).update({ created_at: Date.now() - 2 * 3600_000 });
      const res = await u.agent.get(url({ max_age: '3600' }));
      expect(res.status).toBe(200);
      expect(res.text).toContain('data-mode="reauth"');
      const none = await u.agent.get(url({ max_age: '3600', prompt: 'none' }));
      expect(new URL(none.headers.location!).searchParams.get('error')).toBe('login_required');
      // A recent enough session goes straight through.
      expect((await u.agent.get(url({ max_age: '99999' }))).status).toBe(302);
      // After a new sign-in the resumed request issues a code whose auth_time is fresh.
      const resume = unesc(/data-continue="([^"]+)"/.exec(res.text)![1]!);
      const again = await login(h, 'reauth');
      const done = await again.agent.get(resume);
      expect(done.status).toBe(302);
      expect(new URL(done.headers.location!).searchParams.get('code')).toBeTruthy();
      expect((await h.s.db('audit_events').where({ action: 'oidc.reauth.required' })).length).toBeGreaterThanOrEqual(1);
    });

    it('asks again with prompt=login until there is a sign-in after the request', async () => {
      const u = await login(h, 'reauth');
      const first = await u.agent.get(url({ prompt: 'login' }));
      expect(first.text).toContain('data-mode="reauth"');
      const resume = unesc(/data-continue="([^"]+)"/.exec(first.text)![1]!);
      expect(resume).toContain('reauth=');
      // The same session presenting the resume address is still asked: it signed in before the request.
      expect((await u.agent.get(resume)).text).toContain('data-mode="reauth"');
      // A forged marker does not help.
      expect((await u.agent.get(resume.replace(/reauth=\d+/, `reauth=${Date.now() - 3600_000}`))).text).toContain('data-mode="reauth"');
      const fresh = await login(h, 'reauth');
      const ok = await fresh.agent.get(resume);
      expect(ok.status).toBe(302);
      expect(new URL(ok.headers.location!).searchParams.get('code')).toBeTruthy();
    });
  });

  describe('B-403: pushed authorization requests and request objects', () => {
    let c: { client: { id: string; clientId: string }; secret: string | null };
    let u: Awaited<ReturnType<typeof login>>;
    const jar = ecKey();
    beforeAll(async () => {
      c = await createClient({ name: 'Payments', type: 'confidential, BFF', redirectUris: [REDIRECT], scopes: ['openid', 'chat:read'], grants: ['authorization_code'], jwks: { keys: [{ ...jar.jwk, kid: 'rp-1' }] } });
      await localUser(h, 'paruser', ['member']);
      u = await login(h, 'paruser');
    });
    const push = (form: Record<string, string>) => request(h.app).post('/oauth/par').set('authorization', basic(c.client.clientId, c.secret!)).type('form').send(form);

    it('a pushed request_uri works once, within 60 seconds', async () => {
      const { verifier, challenge } = pkce();
      const pushed = await push({ response_type: 'code', redirect_uri: REDIRECT, scope: 'openid chat:read', state: 'par-1', code_challenge: challenge, code_challenge_method: 'S256' });
      expect(pushed.status, JSON.stringify(pushed.body)).toBe(201);
      expect(pushed.body.expires_in).toBe(60);
      expect(pushed.body.request_uri).toMatch(/^urn:ietf:params:oauth:request_uri:/);
      const go = () => u.agent.get(`/oauth/authorize?${new URLSearchParams({ client_id: c.client.clientId, request_uri: pushed.body.request_uri })}`);
      const first = await go();
      expect(first.status, first.text).toBe(302);
      const loc = new URL(first.headers.location!);
      expect(loc.searchParams.get('state')).toBe('par-1');
      expect((await exchange(c.client.clientId, c.secret!, loc.searchParams.get('code')!, verifier)).status).toBe(200);
      const second = await go();
      expect(second.status).toBe(400);
      expect(second.headers.location).toBeUndefined();
      // Invalid requests are refused at the push; an expired request_uri is refused at the authorization endpoint.
      expect((await push({ response_type: 'code', redirect_uri: 'https://evil.example.test/cb', scope: 'openid', code_challenge: challenge, code_challenge_method: 'S256' })).status).toBe(400);
      const late = await push({ response_type: 'code', redirect_uri: REDIRECT, scope: 'openid', code_challenge: challenge, code_challenge_method: 'S256' });
      await h.s.db('federation_pending').where({ kind: 'par' }).update({ expires_at: Date.now() - 1 });
      expect((await u.agent.get(`/oauth/authorize?${new URLSearchParams({ client_id: c.client.clientId, request_uri: late.body.request_uri })}`)).status).toBe(400);
      // Another client cannot use it; a URL request_uri is never fetched.
      expect((await u.agent.get(`/oauth/authorize?${new URLSearchParams({ client_id: c.client.clientId, request_uri: 'https://evil.example.test/req.jwt' })}`)).status).toBe(400);
    });

    it('accepts request objects signed with the client\'s registered key only', async () => {
      const { verifier, challenge } = pkce();
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: c.client.clientId, aud: ISSUER, iat: now, exp: now + 300, jti: randomBytes(8).toString('hex'), client_id: c.client.clientId, response_type: 'code', redirect_uri: REDIRECT, scope: 'openid chat:read', state: 'jar-1', code_challenge: challenge, code_challenge_method: 'S256' };
      const signed = signJwt(claims, jar.privateKey, 'rp-1', 'oauth-authz-req+jwt');
      // The outer query's scope and state are ignored: only the signed parameters count.
      const res = await u.agent.get(`/oauth/authorize?${new URLSearchParams({ client_id: c.client.clientId, request: signed, state: 'outer', scope: 'openid profile' })}`);
      expect(res.status, res.text).toBe(302);
      const loc = new URL(res.headers.location!);
      expect(loc.searchParams.get('state')).toBe('jar-1');
      const tok = await exchange(c.client.clientId, c.secret!, loc.searchParams.get('code')!, verifier);
      expect(tok.body.scope.split(' ').sort()).toEqual(['chat:read', 'openid']);
      // Replayed, signed by another key, unsigned, or for another audience: refused without redirecting.
      expect((await u.agent.get(`/oauth/authorize?${new URLSearchParams({ client_id: c.client.clientId, request: signed })}`)).status).toBe(400);
      const other = signJwt({ ...claims, jti: 'x2' }, ecKey().privateKey, 'rp-1');
      expect((await u.agent.get(`/oauth/authorize?${new URLSearchParams({ client_id: c.client.clientId, request: other })}`)).status).toBe(400);
      const none = `${b64u(JSON.stringify({ alg: 'none' }))}.${b64u(JSON.stringify({ ...claims, jti: 'x3' }))}.`;
      expect((await u.agent.get(`/oauth/authorize?${new URLSearchParams({ client_id: c.client.clientId, request: none })}`)).status).toBe(400);
      const wrongAud = signJwt({ ...claims, jti: 'x4', aud: 'https://other.example.test' }, jar.privateKey, 'rp-1');
      expect((await u.agent.get(`/oauth/authorize?${new URLSearchParams({ client_id: c.client.clientId, request: wrongAud })}`)).status).toBe(400);
      // A request object can also be pushed.
      const pushed = await push({ request: signJwt({ ...claims, jti: 'x5', state: 'jar-par' }, jar.privateKey, 'rp-1') });
      expect(pushed.status, JSON.stringify(pushed.body)).toBe(201);
      const viaPar = await u.agent.get(`/oauth/authorize?${new URLSearchParams({ client_id: c.client.clientId, request_uri: pushed.body.request_uri })}`);
      expect(new URL(viaPar.headers.location!).searchParams.get('state')).toBe('jar-par');
    });

    it('makes a client that requires PAR push its requests', async () => {
      await as('patch', `/api/admin/federation/oidc/clients/${c.client.id}`, { parRequired: true });
      const res = await u.agent.get(`/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: c.client.clientId, redirect_uri: REDIRECT, scope: 'openid', code_challenge: pkce().challenge, code_challenge_method: 'S256' })}`);
      expect(res.status).toBe(400);
      expect(res.text).toContain('push');
      await as('patch', `/api/admin/federation/oidc/clients/${c.client.id}`, { parRequired: false });
    });
  });

  describe('B-404: DPoP', () => {
    it('binds tokens to the proof key and refuses them without a valid proof', async () => {
      const c = await createClient({ name: 'Mobile', type: 'confidential, BFF', redirectUris: [REDIRECT], scopes: ['openid', 'chat:read'], grants: ['authorization_code', 'refresh_token'], dpopRequired: true });
      await localUser(h, 'dpopuser', ['member']);
      const u = await login(h, 'dpopuser');
      const key = ecKey();
      const tokenUrl = `${ISSUER}/oauth/token`;
      const c1 = await codeFor(u.agent, c.client.clientId);
      const without = await exchange(c.client.clientId, c.secret!, c1.code, c1.verifier);
      expect(without.status).toBe(400);
      expect(without.body.error).toBe('invalid_dpop_proof');
      const c2 = await codeFor(u.agent, c.client.clientId);
      const tok = await exchange(c.client.clientId, c.secret!, c2.code, c2.verifier, { dpop: dpopProof(key.privateKey, key.jwk, 'POST', tokenUrl) });
      expect(tok.status, JSON.stringify(tok.body)).toBe(200);
      expect(tok.body.token_type).toBe('DPoP');
      const at = tok.body.access_token as string;
      const jkt = (decodeJwt(at).claims.cnf as { jkt: string }).jkt;
      expect(jkt).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const meUrl = `${ISSUER}/api/me`;
      // As a bearer token, without a proof, with a proof for another URL or key, or a replayed proof: refused.
      expect((await request(h.app).get('/api/me').set('authorization', `Bearer ${at}`)).status).toBe(401);
      expect((await request(h.app).get('/api/me').set('authorization', `DPoP ${at}`)).status).toBe(401);
      expect((await request(h.app).get('/api/me').set('authorization', `DPoP ${at}`).set('dpop', dpopProof(key.privateKey, key.jwk, 'GET', `${ISSUER}/api/other`, at))).status).toBe(401);
      const stranger = ecKey();
      expect((await request(h.app).get('/api/me').set('authorization', `DPoP ${at}`).set('dpop', dpopProof(stranger.privateKey, stranger.jwk, 'GET', meUrl, at))).status).toBe(401);
      expect((await request(h.app).get('/api/me').set('authorization', `DPoP ${at}`).set('dpop', dpopProof(key.privateKey, key.jwk, 'GET', meUrl))).status).toBe(401);
      expect((await request(h.app).get('/api/me').set('authorization', `DPoP ${at}`).set('dpop', dpopProof(key.privateKey, key.jwk, 'GET', meUrl, at, Math.floor(Date.now() / 1000) - 600))).status).toBe(401);
      const proof = dpopProof(key.privateKey, key.jwk, 'GET', meUrl, at);
      const ok = await request(h.app).get('/api/me').set('authorization', `DPoP ${at}`).set('dpop', proof);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.user.username).toBe('dpopuser');
      expect((await request(h.app).get('/api/me').set('authorization', `DPoP ${at}`).set('dpop', proof)).status).toBe(401);
      // userinfo applies the same rule.
      expect((await request(h.app).get('/oauth/userinfo').set('authorization', `DPoP ${at}`).set('dpop', dpopProof(key.privateKey, key.jwk, 'GET', `${ISSUER}/oauth/userinfo`, at))).status).toBe(200);
      // The refresh token only refreshes with a proof from the same key.
      const refresh = (proofKey: typeof key) => request(h.app).post('/oauth/token').set('authorization', basic(c.client.clientId, c.secret!)).set('dpop', dpopProof(proofKey.privateKey, proofKey.jwk, 'POST', tokenUrl)).type('form').send({ grant_type: 'refresh_token', refresh_token: tok.body.refresh_token });
      expect((await refresh(stranger)).body.error).toBe('invalid_dpop_proof');
      const again = await refresh(key);
      expect(again.status, JSON.stringify(again.body)).toBe(200);
      expect((decodeJwt(again.body.access_token).claims.cnf as { jkt: string }).jkt).toBe(jkt);
      // Introspection reports the binding.
      const intro = await request(h.app).post('/oauth/introspect').set('authorization', basic(c.client.clientId, c.secret!)).type('form').send({ token: again.body.access_token });
      expect(intro.body).toMatchObject({ active: true, token_type: 'DPoP', cnf: { jkt } });
    });
  });

  describe('B-405: SAML single logout and encrypted assertions', () => {
    const spEntity = 'https://crm.example.test/saml';
    const acs = 'https://crm.example.test/saml/acs';
    const spSlo = 'https://crm.example.test/saml/slo';
    const spSign = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const spEnc = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const signCert = selfSignedCertificate({ ...spSign, commonName: 'crm signing', days: 365 }).toString('base64');
    const encCert = selfSignedCertificate({ ...spEnc, commonName: 'crm encryption', days: 365 }).toString('base64');
    const kd = (use: string, cert: string) => `<md:KeyDescriptor use="${use}"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`;
    const metadata = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${spEntity}"><md:SPSSODescriptor AuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">${kd('signing', signCert)}${kd('encryption', encCert)}<md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</md:NameIDFormat><md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${spSlo}"/><md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${acs}" index="0"/></md:SPSSODescriptor></md:EntityDescriptor>`;
    /** Signs an HTTP-Redirect query the way SAML bindings 3.4.4.1 says. */
    const redirectQuery = (param: string, xml: string, key: KeyObject, relay?: string) => {
      const parts = [`${param}=${encodeURIComponent(deflateRawSync(Buffer.from(xml)).toString('base64'))}`];
      if (relay) parts.push(`RelayState=${encodeURIComponent(relay)}`);
      parts.push(`SigAlg=${encodeURIComponent('http://www.w3.org/2001/04/xmldsig-more#rsa-sha256')}`);
      const signed = parts.join('&');
      return `${signed}&Signature=${encodeURIComponent(cryptoSign('sha256', Buffer.from(signed), key).toString('base64'))}`;
    };

    it('encrypts assertions for an SP with an encryption certificate, and its LogoutRequest ends the session', async () => {
      const parsed = await as('post', '/api/admin/federation/saml/parse', { xml: metadata });
      expect(parsed.body).toMatchObject({ sloUrl: spSlo, sloBinding: 'redirect' });
      expect(parsed.body.encryptionCert.subject).toContain('crm encryption');
      const created = await as('post', '/api/admin/federation/saml/sps', { name: 'CRM', xml: metadata });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body).toMatchObject({ encryptAssertions: true, sloUrl: spSlo });
      const idpMeta = (await request(h.app).get('/saml/metadata')).text;
      expect(idpMeta).toContain(`SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${ISSUER}/saml/slo"`);
      const idpCert = /<ds:X509Certificate>([^<]+)</.exec(idpMeta)![1]!;

      await localUser(h, 'samlslo', ['member']);
      const u = await login(h, 'samlslo');
      const authn = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_crm1" Version="2.0" IssueInstant="${new Date().toISOString()}" AssertionConsumerServiceURL="${acs}"><saml:Issuer>${spEntity}</saml:Issuer></samlp:AuthnRequest>`;
      const sso = await u.agent.get(`/saml/sso?${new URLSearchParams({ SAMLRequest: deflateRawSync(Buffer.from(authn)).toString('base64') })}`);
      const done = await u.agent.get(sso.headers.location!);
      const xml = Buffer.from(/name="SAMLResponse" value="([^"]+)"/.exec(done.text)![1]!, 'base64').toString('utf8');
      expect(xml).toContain('<saml:EncryptedAssertion');
      expect(xml).not.toContain('<saml:Assertion');
      expect(xml).not.toContain('samlslo');
      // Decrypted independently with node:crypto: RSA-OAEP (SHA-256) unwraps the key, AES-256-GCM the assertion.
      expect(xml).toContain('http://www.w3.org/2009/xmlenc11#aes256-gcm');
      const [wrapped, content] = [...xml.matchAll(/<xenc:CipherValue>([^<]+)</g)].map((m) => Buffer.from(m[1]!, 'base64'));
      const cek = privateDecrypt({ key: spEnc.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, wrapped!);
      const d = createDecipheriv('aes-256-gcm', cek, content!.subarray(0, 12));
      d.setAuthTag(content!.subarray(content!.length - 16));
      const assertionXml = Buffer.concat([d.update(content!.subarray(12, content!.length - 16)), d.final()]).toString('utf8');
      const assertion = parseXml(assertionXml);
      // Signed, then encrypted: the signature verifies on the decrypted assertion.
      expect(verifyEnveloped(assertion, assertion, [idpCert]).ok).toBe(true);
      const nameId = /<saml:NameID[^>]*>([^<]+)</.exec(assertionXml)![1]!;
      const sessionIndex = /SessionIndex="([^"]+)"/.exec(assertionXml)![1]!;

      const logoutRequest = (id: string) => `<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${new Date().toISOString()}" Destination="${ISSUER}/saml/slo"><saml:Issuer>${spEntity}</saml:Issuer><saml:NameID>${nameId}</saml:NameID><samlp:SessionIndex>${sessionIndex}</samlp:SessionIndex></samlp:LogoutRequest>`;
      // Unsigned, or signed with another key: refused, and the session lives on.
      expect((await request(h.app).get(`/saml/slo?${new URLSearchParams({ SAMLRequest: deflateRawSync(Buffer.from(logoutRequest('_lr0'))).toString('base64') })}`)).status).toBe(400);
      expect((await request(h.app).get(`/saml/slo?${redirectQuery('SAMLRequest', logoutRequest('_lr0'), spEnc.privateKey)}`)).status).toBe(400);
      expect((await u.agent.get('/api/auth/session')).body.authenticated).toBe(true);
      // The SP's browser has no cookie of ours: the session is found by NameID and SessionIndex.
      const slo = await request(h.app).get(`/saml/slo?${redirectQuery('SAMLRequest', logoutRequest('_lr1'), spSign.privateKey, 'rs-7')}`);
      expect(slo.status, slo.text).toBe(302);
      const back = new URL(slo.headers.location!);
      expect(back.origin + back.pathname).toBe(spSlo);
      expect(back.searchParams.get('RelayState')).toBe('rs-7');
      expect(verifyRedirectSignature(slo.headers.location!.split('?')[1]!, [idpCert]).ok).toBe(true);
      const response = inflateRawSync(Buffer.from(back.searchParams.get('SAMLResponse')!, 'base64')).toString();
      expect(response).toContain('InResponseTo="_lr1"');
      expect(response).toContain('status:Success');
      expect((await u.agent.get('/api/auth/session')).body.authenticated).toBe(false);
      expect((await h.s.db('audit_events').where({ action: 'saml.slo' })).length).toBe(1);
    });

    it('as SP, accepts an encrypted upstream assertion and ends the session on the IdP\'s LogoutRequest', async () => {
      const idp = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const cert = selfSignedCertificate({ ...idp, commonName: 'sts.corp.example.test', days: 365 }).toString('base64');
      const entity = 'http://sts.corp.example.test/idp';
      const idpSlo = 'https://sts.corp.example.test/slo';
      const meta = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entity}"><md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${idpSlo}"/><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://sts.corp.example.test/sso"/></md:IDPSSODescriptor></md:EntityDescriptor>`;
      const created = await as('post', '/api/admin/federation/upstream', { name: 'Corp STS', protocol: 'saml', source: meta });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const id = created.body.id as string;
      await as('post', '/api/admin/group-mappings', { providerId: id, group: 'crm-users', role: 'member', clearance: 'internal' });
      await h.s.providers.update(h.tenantId, id, { config: { ...(await h.s.providers.get(h.tenantId, id))!.config, usernameAttribute: 'uid' } });
      // Our SP metadata publishes the encryption certificate and the SLO endpoint.
      const spMeta = (await request(h.app).get(`/federation/saml/${id}`)).text;
      expect(spMeta).toContain(`SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${ISSUER}/federation/saml/slo"`);
      const ourEnc = /<md:KeyDescriptor use="encryption">[\s\S]*?<ds:X509Certificate>([^<]+)</.exec(spMeta)![1]!;
      const encKey = new X509Certificate(Buffer.from(ourEnc, 'base64')).publicKey;

      /** The IdP's answer: a signed assertion encrypted for us (rsa-oaep-mgf1p, SHA-1) with AES-GCM, or CBC. */
      const signIn = async (cipher: 'gcm' | 'cbc') => {
        const browser = request.agent(h.app);
        const start = await browser.get(`/federation/saml/start?provider=${id}`);
        const u = new URL(start.headers.location!);
        const reqId = /ID="([^"]+)"/.exec(inflateRawSync(Buffer.from(u.searchParams.get('SAMLRequest')!, 'base64')).toString())![1]!;
        const now = Date.now();
        const iso = (ms: number) => new Date(ms).toISOString();
        const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_e1" IssueInstant="${iso(now)}" Version="2.0"><saml:Issuer>${entity}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">p-991</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${reqId}" NotOnOrAfter="${iso(now + 300_000)}" Recipient="${ISSUER}/federation/saml/acs"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${iso(now - 60_000)}" NotOnOrAfter="${iso(now + 300_000)}"><saml:AudienceRestriction><saml:Audience>${ISSUER}/federation/saml/${id}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="_idx-42"/><saml:AttributeStatement><saml:Attribute Name="uid"><saml:AttributeValue>cmoreau</saml:AttributeValue></saml:Attribute><saml:Attribute Name="groups"><saml:AttributeValue>crm-users</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion>`;
        const signed = signEnveloped(assertion, idp.privateKey, cert, { afterLocal: 'Issuer' });
        const cek = randomBytes(32);
        let content: Buffer;
        if (cipher === 'gcm') {
          const iv = randomBytes(12);
          const c = createCipheriv('aes-256-gcm', cek, iv);
          content = Buffer.concat([iv, c.update(signed), c.final(), c.getAuthTag()]);
        } else {
          const iv = randomBytes(16);
          const c = createCipheriv('aes-256-cbc', cek, iv);
          content = Buffer.concat([iv, c.update(signed), c.final()]);
        }
        const wrapped = publicEncrypt({ key: encKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, cek);
        const alg = cipher === 'gcm' ? 'http://www.w3.org/2009/xmlenc11#aes256-gcm' : 'http://www.w3.org/2001/04/xmlenc#aes256-cbc';
        const enc = `<saml:EncryptedAssertion><xenc:EncryptedData xmlns:xenc="http://www.w3.org/2001/04/xmlenc#" Type="http://www.w3.org/2001/04/xmlenc#Element"><xenc:EncryptionMethod Algorithm="${alg}"/><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><xenc:EncryptedKey><xenc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p"><ds:DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/></xenc:EncryptionMethod><xenc:CipherData><xenc:CipherValue>${wrapped.toString('base64')}</xenc:CipherValue></xenc:CipherData></xenc:EncryptedKey></ds:KeyInfo><xenc:CipherData><xenc:CipherValue>${content.toString('base64')}</xenc:CipherValue></xenc:CipherData></xenc:EncryptedData></saml:EncryptedAssertion>`;
        // The response declares the saml prefix the encrypted assertion's container uses.
        const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r1" Version="2.0"><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${enc}</samlp:Response>`;
        const res = await browser.post('/federation/saml/acs').type('form').send({ SAMLResponse: Buffer.from(xml).toString('base64'), RelayState: u.searchParams.get('RelayState')! });
        return { res, browser };
      };
      const cbc = await signIn('cbc');
      expect(cbc.res.status).toBe(400);
      expect(cbc.res.text).toContain('only AES-GCM is accepted');
      const ok = await signIn('gcm');
      expect(ok.res.status, ok.res.text).toBe(302);
      expect((await ok.browser.get('/api/auth/session')).body.authenticated).toBe(true);
      const user = await h.s.users.byUsername(h.tenantId, 'cmoreau');
      expect(user).toBeTruthy();
      expect(await h.s.db('saml_sessions').where({ role: 'sp', peer_id: id, name_id: 'p-991', session_index: '_idx-42' }).first()).toBeTruthy();

      // The IdP's signed LogoutRequest ends the session and gets a LogoutResponse signed with our key.
      const lr = `<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_up-lr" Version="2.0" IssueInstant="${new Date().toISOString()}"><saml:Issuer>${entity}</saml:Issuer><saml:NameID>p-991</saml:NameID><samlp:SessionIndex>_idx-42</samlp:SessionIndex></samlp:LogoutRequest>`;
      expect((await request(h.app).get(`/federation/saml/slo?${redirectQuery('SAMLRequest', lr, spSign.privateKey)}`)).status).toBe(400);
      const out = await request(h.app).get(`/federation/saml/slo?${redirectQuery('SAMLRequest', lr, idp.privateKey, 'up-rs')}`);
      expect(out.status, out.text).toBe(302);
      const loc = new URL(out.headers.location!);
      expect(loc.origin + loc.pathname).toBe(idpSlo);
      const ours = /<md:KeyDescriptor use="signing">[\s\S]*?<ds:X509Certificate>([^<]+)</.exec(spMeta)![1]!;
      expect(verifyRedirectSignature(out.headers.location!.split('?')[1]!, [ours]).ok).toBe(true);
      expect(inflateRawSync(Buffer.from(loc.searchParams.get('SAMLResponse')!, 'base64')).toString()).toContain('InResponseTo="_up-lr"');
      expect((await ok.browser.get('/api/auth/session')).body.authenticated).toBe(false);
    });
  });
});

describe('Sprint 14, B-408: signing in OpenBao transit', () => {
  const bao = new FakeOpenBao();
  let h: Harness;

  beforeAll(async () => {
    await bao.start();
    h = await harness({ KMS_PROVIDER: 'openbao', OPENBAO_ADDR: bao.url, OPENBAO_TOKEN: bao.token });
  });
  afterAll(async () => {
    await h.close();
    await bao.stop();
  });

  it('signs ID tokens and SAML assertions in the KMS, with no private signing key in the process', async () => {
    const { client, secret } = await h.s.federation.oidc.createClient(h.tenantId, { name: 'Vaulted', type: 'first_party', redirectUris: [REDIRECT], grants: ['authorization_code'], scopes: ['openid', 'profile'], pkceRequired: true, accessTtl: 600, refreshTtl: 3600, models: null, serviceUserId: null }, null);
    await localUser(h, 'baouser', ['member']);
    const u = await login(h, 'baouser');
    const { verifier, challenge } = pkce();
    const res = await u.agent.get(`/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, scope: 'openid profile', code_challenge: challenge, code_challenge_method: 'S256' })}`);
    expect(res.status, res.text).toBe(302);
    const tok = await request(h.app).post('/oauth/token').set('authorization', basic(client.client_id, secret!)).type('form').send({ grant_type: 'authorization_code', code: new URL(res.headers.location!).searchParams.get('code')!, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(tok.status, JSON.stringify(tok.body)).toBe(200);
    const keys = (await request(h.app).get('/.well-known/jwks.json')).body.keys as Jwk[];
    expect(verifyJwt(tok.body.id_token, keys, { issuer: ISSUER, audience: client.client_id, algs: ['ES256'] }).preferred_username).toBe('baouser');
    expect((await request(h.app).get('/api/me').set('authorization', `Bearer ${tok.body.access_token}`)).status).toBe(200);

    // SAML: the IdP certificate was self-signed through transit, and assertions are signed there too.
    const meta = (await request(h.app).get('/saml/metadata')).text;
    const certB64 = /<ds:X509Certificate>([^<]+)</.exec(meta)![1]!;
    const cert = new X509Certificate(Buffer.from(certB64, 'base64'));
    expect(cert.verify(cert.publicKey)).toBe(true);
    const sp = await h.s.federation.saml.create(h.tenantId, { name: 'Wiki', entityId: 'https://wiki.example.test/saml', acsUrls: [{ url: 'https://wiki.example.test/acs', index: 0, binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST' }], nameIdFormat: 'unspecified', certificate: null, signedRequests: false, attributeMap: {} });
    const t = (await h.s.federation.tenantById(h.tenantId))!;
    const xml = Buffer.from(await h.s.federation.saml.response(t, sp, sp.acs_urls[0]!, null, { id: 'u1', username: 'baouser', displayName: 'Bao', email: null, groups: [], roles: [], clearance: 'internal', authTime: Date.now(), method: 'password' }), 'base64').toString();
    const root = parseXml(xml);
    const assertion = root.children.find((c) => c.type === 'element' && c.local === 'Assertion') as XmlElement;
    expect(verifyEnveloped(root, assertion, [certB64]).ok).toBe(true);

    // No private key material: every signing key row names a transit key, and none is cached in memory.
    const rows = (await h.s.db('federation_keys').whereIn('use', ['oidc', 'saml'])) as { kid: string; private_sealed: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) expect(SigningKeys.inKms(r)).toBe(true);
    const cached = h.s.federation.keys.cachedKids();
    expect(rows.filter((r) => cached.includes(r.kid))).toEqual([]);
    expect(new Set(bao.signed).size).toBe(2);
    expect([...bao.keys.keys()].filter((k) => k.includes('fed-'))).toHaveLength(2);
  });

  it('replaces a key sealed in the process when KMS signing is turned on', async () => {
    // A key from before the switch (sealed locally) stops signing; one in the KMS takes over and the old one stays published.
    const t = (await h.s.federation.tenantById(h.tenantId))!;
    const before = (await h.s.federation.keys.list(t.id)).find((k) => k.state === 'signing')!;
    await h.s.db('federation_keys').where({ kid: before.kid }).update({ private_sealed: 'sealed-locally' });
    const signer = await h.s.federation.keys.signer(t.id);
    expect(signer.remote).toBe(true);
    expect(signer.kid).not.toBe(before.kid);
    expect((await h.s.federation.keys.jwks(t.id)).keys.map((k) => k.kid)).toEqual(expect.arrayContaining([before.kid, signer.kid]));
  });
});
