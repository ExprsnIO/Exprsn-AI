import { createHash, createPublicKey, generateKeyPairSync, randomBytes, verify as cryptoVerify, X509Certificate } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeJwt, verifyJwt, type Jwk } from '../src/federation/jose.js';
import type { KerberosVerifier } from '../src/federation/kerberos.js';
import { selfSignedCertificate } from '../src/federation/x509.js';
import { exclusiveC14n, parseXml, signEnveloped, verifyEnveloped } from '../src/federation/xml.js';
import { FakeIdp } from './fake-idp.js';
import { localUser, login, loginAdmin, type Harness } from './helpers.js';
import { harnessWith } from './retrieval-seed.js';

const REDIRECT = 'https://app.example.test/cb';
const b64u = (b: Buffer) => b.toString('base64url');
const pkce = () => {
  const verifier = b64u(randomBytes(48));
  return { verifier, challenge: b64u(createHash('sha256').update(verifier).digest()) };
};
const cookiesOf = (res: request.Response): string[] => (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];

const fakeKerberos: KerberosVerifier = {
  async status() {
    return { available: true, service: 'HTTP@localhost', detail: 'fake verifier' };
  },
  async verify(token) {
    const principal = Buffer.from(token, 'base64').toString('utf8');
    if (!principal.includes('@')) return { status: 'invalid', message: 'bad ticket' };
    return { status: 'ok', principal, responseToken: Buffer.from('mutual').toString('base64') };
  }
};

describe('Sprint 9: federation', () => {
  let h: Harness;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let member: Awaited<ReturnType<typeof login>>;
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
  const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

  /** Runs /oauth/authorize as the signed-in member and returns the code (or the redirect). */
  const authorize = async (clientId: string, extra: Record<string, string> = {}) => {
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: 'openid profile groups chat:read', state: 'st-1', nonce: 'n-1', ...extra });
    return member.agent.get(`/oauth/authorize?${q}`);
  };

  beforeAll(async () => {
    h = await harnessWith({ kerberos: fakeKerberos });
    await localUser(h, 'idadmin', ['identity-admin', 'member']);
    await localUser(h, 'mokafor', ['member']);
    admin = await loginAdmin(h, 'idadmin');
    member = await login(h, 'mokafor');
  });
  afterAll(async () => h.close());

  it('publishes discovery and an ES256 JWKS', async () => {
    const d = await request(h.app).get('/.well-known/openid-configuration');
    expect(d.status).toBe(200);
    expect(d.body.issuer).toBe('http://localhost:8080');
    expect(d.body.jwks_uri).toBe('http://localhost:8080/.well-known/jwks.json');
    expect(d.body.code_challenge_methods_supported).toEqual(['S256']);
    const keys = await jwks();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
    expect(keys[0]).not.toHaveProperty('d');
    // Other tenants live under /t/<slug>; the default tenant only at the root.
    expect((await request(h.app).get('/t/default/.well-known/openid-configuration')).status).toBe(404);
  });

  it('requires identity:manage (and a second factor) for the admin API', async () => {
    expect((await request(h.app).get('/api/admin/federation/oidc/clients')).status).toBe(401);
    const res = await member.agent.get('/api/admin/federation/oidc/clients');
    expect(res.status).toBe(403);
    expect((await as('get', '/api/admin/federation')).status).toBe(200);
  });

  it('shows a client secret once and stores only its digest', async () => {
    const { client, secret } = await createClient({ name: 'svc-close-bot', type: 'service account', scopes: ['inference:invoke:analyst', 'chat:read'], grants: ['client_credentials'] });
    expect(secret).toMatch(/^xs_live_/);
    const again = await as('get', `/api/admin/federation/oidc/clients/${client.id}`);
    expect(JSON.stringify(again.body)).not.toContain(secret!);
    const row = await h.s.db('oidc_clients').where({ id: client.id }).first();
    expect(row.secret_hash).not.toContain(secret!);
    // Client credentials work with the secret, and never with a wrong one.
    const tok = await request(h.app).post('/oauth/token').set('authorization', basic(client.clientId, secret!)).type('form').send({ grant_type: 'client_credentials' });
    expect(tok.status, JSON.stringify(tok.body)).toBe(200);
    expect(tok.body.scope.split(' ').sort()).toEqual(['chat:read', 'inference:invoke:analyst']);
    expect(tok.body.refresh_token).toBeUndefined();
    // The `inference:invoke:analyst` scope binds the token to that profile only.
    const bound = await h.s.federation.principalFromAccessToken(tok.body.access_token);
    expect(bound?.profiles).toEqual(['analyst']);
    const bad = await request(h.app).post('/oauth/token').set('authorization', basic(client.clientId, 'nope')).type('form').send({ grant_type: 'client_credentials' });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe('invalid_client');
    // Rotation shows the new secret once; the old one stops working.
    const rot = await as('post', `/api/admin/federation/oidc/clients/${client.id}/secret`);
    expect(rot.status).toBe(201);
    expect((await request(h.app).post('/oauth/token').set('authorization', basic(client.clientId, secret!)).type('form').send({ grant_type: 'client_credentials' })).status).toBe(401);
    expect((await request(h.app).post('/oauth/token').set('authorization', basic(client.clientId, rot.body.secret)).type('form').send({ grant_type: 'client_credentials' })).status).toBe(200);
  });

  describe('authorization code with PKCE', () => {
    let clientId: string;
    let secret: string;
    let clientRowId: string;

    beforeAll(async () => {
      const c = await createClient({ name: 'Exprsn-AI console', type: 'confidential, BFF', redirectUris: [REDIRECT], scopes: ['openid', 'profile', 'groups', 'chat:*'], grants: ['authorization_code', 'refresh_token'] });
      clientId = c.client.clientId;
      secret = c.secret!;
      clientRowId = c.client.id;
    });

    const exchange = async (code: string, verifier: string, extra: Record<string, string> = {}) =>
      request(h.app).post('/oauth/token').set('authorization', basic(clientId, secret)).type('form').send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, ...extra });

    it('issues a code to the signed-in user and tokens that verify against the JWKS', async () => {
      const { verifier, challenge } = pkce();
      const res = await authorize(clientId, { code_challenge: challenge, code_challenge_method: 'S256' });
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.location!);
      expect(loc.origin + loc.pathname).toBe(REDIRECT);
      expect(loc.searchParams.get('state')).toBe('st-1');
      expect(loc.searchParams.get('iss')).toBe('http://localhost:8080');
      const tok = await exchange(loc.searchParams.get('code')!, verifier);
      expect(tok.status, JSON.stringify(tok.body)).toBe(200);
      expect(tok.headers['cache-control']).toBe('no-store');
      const keys = await jwks();
      const claims = verifyJwt(tok.body.id_token, keys, { issuer: 'http://localhost:8080', audience: clientId, algs: ['ES256'] });
      expect(claims).toMatchObject({ nonce: 'n-1', preferred_username: 'mokafor', tenant: 'default', clearance: 'internal' });
      expect(claims.roles).toEqual(['member']);
      // The same check with node:crypto alone: the JWK and the raw r||s signature.
      const [hdr, payload, sig] = tok.body.id_token.split('.');
      const jwk = keys.find((k) => k.kid === JSON.parse(Buffer.from(hdr, 'base64url').toString()).kid)!;
      expect(cryptoVerify('sha256', Buffer.from(`${hdr}.${payload}`), { key: createPublicKey({ key: jwk as never, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'))).toBe(true);
      // Scopes never widen a role: chat:read is granted, nothing the member lacks.
      expect(tok.body.scope.split(' ')).toContain('chat:read');
      const info = await request(h.app).get('/oauth/userinfo').set('authorization', `Bearer ${tok.body.access_token}`);
      expect(info.status).toBe(200);
      expect(info.body.preferred_username).toBe('mokafor');
      // The API bearer hook: the token becomes a principal whose scopes narrow the user's roles.
      const principal = await h.s.federation.principalFromAccessToken(tok.body.access_token);
      expect(principal).toMatchObject({ username: 'mokafor', tenantId: h.tenantId });
      expect(principal!.scopes).toEqual(['chat:read']);
      expect(await h.s.federation.principalFromAccessToken(tok.body.id_token)).toBeNull();
      // The API accepts the access token as a bearer credential, and refuses the ID token.
      const me = await request(h.app).get('/api/me').set('authorization', `Bearer ${tok.body.access_token}`);
      expect(me.status, JSON.stringify(me.body)).toBe(200);
      expect((await request(h.app).get('/api/me').set('authorization', `Bearer ${tok.body.id_token}`)).status).toBe(401);
      // A code works once; a replay is refused and revokes what it produced.
      const replay = await exchange(loc.searchParams.get('code')!, verifier);
      expect(replay.body.error).toBe('invalid_grant');
      expect((await request(h.app).post('/oauth/token').set('authorization', basic(clientId, secret)).type('form').send({ grant_type: 'refresh_token', refresh_token: tok.body.refresh_token })).body.error).toBe('invalid_grant');
    });

    it('refuses an unregistered redirect URI without redirecting', async () => {
      const { challenge } = pkce();
      const res = await authorize(clientId, { code_challenge: challenge, code_challenge_method: 'S256', redirect_uri: 'https://evil.example.test/cb' });
      expect(res.status).toBe(400);
      expect(res.headers.location!).toBeUndefined();
      expect(res.text).toContain('not registered');
    });

    it('requires PKCE and checks the verifier', async () => {
      const res = await authorize(clientId);
      expect(res.status).toBe(302);
      expect(new URL(res.headers.location!).searchParams.get('error')).toBe('invalid_request');
      const plain = await authorize(clientId, { code_challenge: 'x'.repeat(43), code_challenge_method: 'plain' });
      expect(new URL(plain.headers.location!).searchParams.get('error')).toBe('invalid_request');
      const { challenge } = pkce();
      const ok = await authorize(clientId, { code_challenge: challenge, code_challenge_method: 'S256' });
      const code = new URL(ok.headers.location!).searchParams.get('code')!;
      const wrong = await exchange(code, pkce().verifier);
      expect(wrong.status).toBe(400);
      expect(wrong.body.error).toBe('invalid_grant');
    });

    it('sends a browser without a session to the continue page', async () => {
      const { challenge } = pkce();
      const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: 'openid', code_challenge: challenge, code_challenge_method: 'S256' });
      const res = await request(h.app).get(`/oauth/authorize?${q}`);
      expect(res.status).toBe(200);
      expect(res.text).toContain('data-mode="continue"');
      expect(res.text).toContain('/js/federation.js');
      const none = await request(h.app).get(`/oauth/authorize?${q}&prompt=none`);
      expect(new URL(none.headers.location!).searchParams.get('error')).toBe('login_required');
    });

    it('rotates refresh tokens and revokes the family when an old one is reused', async () => {
      const { verifier, challenge } = pkce();
      const res = await authorize(clientId, { code_challenge: challenge, code_challenge_method: 'S256' });
      const tok = await exchange(new URL(res.headers.location!).searchParams.get('code')!, verifier);
      const refresh = (rt: string) => request(h.app).post('/oauth/token').set('authorization', basic(clientId, secret)).type('form').send({ grant_type: 'refresh_token', refresh_token: rt });
      const r1 = await refresh(tok.body.refresh_token);
      expect(r1.status, JSON.stringify(r1.body)).toBe(200);
      expect(r1.body.refresh_token).not.toBe(tok.body.refresh_token);
      const reuse = await refresh(tok.body.refresh_token);
      expect(reuse.status).toBe(400);
      expect(reuse.body.error).toBe('invalid_grant');
      // The whole family is gone, including the token that was current, and access tokens of the grant fail.
      expect((await refresh(r1.body.refresh_token)).body.error).toBe('invalid_grant');
      expect((await request(h.app).get('/oauth/userinfo').set('authorization', `Bearer ${r1.body.access_token}`)).status).toBe(401);
      const events = await h.s.db('audit_events').where({ action: 'oidc.refresh.reused' });
      expect(events.length).toBe(1);
    });

    it('keeps the old key in the JWKS during the overlap after a rotation', async () => {
      const { verifier, challenge } = pkce();
      const res = await authorize(clientId, { code_challenge: challenge, code_challenge_method: 'S256' });
      const before = await exchange(new URL(res.headers.location!).searchParams.get('code')!, verifier);
      const oldKid = decodeJwt(before.body.id_token).header.kid!;
      // A scheduled-style rotation publishes the next key without signing with it yet.
      const planned = await as('post', '/api/admin/federation/keys/rotate', {});
      expect(planned.status).toBe(201);
      expect(planned.body.next.state).toBe('next, published');
      expect((await jwks()).map((k) => k.kid)).toEqual(expect.arrayContaining([oldKid, planned.body.next.kid]));
      // An immediate rotation signs now; the old key verifies until the overlap ends.
      const now = await as('post', '/api/admin/federation/keys/rotate', { immediate: true });
      expect(now.body.previous).toBe(oldKid);
      const kids = (await jwks()).map((k) => k.kid);
      expect(kids).toContain(oldKid);
      expect(kids).toContain(now.body.next.kid);
      expect(kids).not.toContain(planned.body.next.kid); // the replaced pending key is withdrawn
      expect(() => verifyJwt(before.body.id_token, [], { issuer: 'x', algs: ['ES256'] })).toThrow();
      expect(verifyJwt(before.body.id_token, (await jwks()) as Jwk[], { issuer: 'http://localhost:8080', audience: clientId, algs: ['ES256'] }).sub).toBeTruthy();
      const p2 = pkce();
      const res2 = await authorize(clientId, { code_challenge: p2.challenge, code_challenge_method: 'S256' });
      const after = await exchange(new URL(res2.headers.location!).searchParams.get('code')!, p2.verifier);
      expect(decodeJwt(after.body.id_token).header.kid).toBe(now.body.next.kid);
      const audit = await h.s.db('audit_events').where({ action: 'federation.key.rotated' });
      expect(audit.length).toBe(2);
    });

    it('asks third-party consent and disables a client with its tokens', async () => {
      const c = await createClient({ name: 'Ledger Notebook', type: 'third party', redirectUris: [REDIRECT], scopes: ['openid', 'chat:read', 'chat:write'], grants: ['authorization_code', 'refresh_token'] });
      const { verifier, challenge } = pkce();
      const res = await authorize(c.client.clientId, { code_challenge: challenge, code_challenge_method: 'S256', scope: 'openid chat:read' });
      expect(res.status).toBe(200);
      expect(res.text).toContain('Allow Ledger Notebook');
      expect(res.headers['content-security-policy']).toContain("form-action 'self' https://app.example.test");
      const handle = /name="handle" value="([^"]+)"/.exec(res.text)![1]!;
      const csrf = /name="csrf" value="([^"]+)"/.exec(res.text)![1]!;
      const forged = await member.agent.post('/oauth/authorize').type('form').send({ handle, csrf: 'x', decision: 'allow' });
      expect(forged.status).toBe(403);
      const allow = await member.agent.post('/oauth/authorize').type('form').send({ handle, csrf, decision: 'allow' });
      expect(allow.status).toBe(302);
      const tok = await request(h.app).post('/oauth/token').set('authorization', basic(c.client.clientId, c.secret!)).type('form').send({ grant_type: 'authorization_code', code: new URL(allow.headers.location!).searchParams.get('code')!, redirect_uri: REDIRECT, code_verifier: verifier });
      expect(tok.status).toBe(200);
      // Consent is remembered: the next authorization goes straight through.
      const p2 = pkce();
      expect((await authorize(c.client.clientId, { code_challenge: p2.challenge, code_challenge_method: 'S256', scope: 'openid chat:read' })).status).toBe(302);
      const dis = await as('post', `/api/admin/federation/oidc/clients/${c.client.id}/disable`);
      expect(dis.body.revoked).toBeGreaterThan(0);
      expect((await request(h.app).get('/oauth/userinfo').set('authorization', `Bearer ${tok.body.access_token}`)).status).toBe(401);
      expect((await request(h.app).post('/oauth/token').set('authorization', basic(c.client.clientId, c.secret!)).type('form').send({ grant_type: 'refresh_token', refresh_token: tok.body.refresh_token })).status).toBe(401);
      expect(clientRowId).toBeTruthy();
    });

    it('refuses wildcard redirect URIs', async () => {
      const res = await as('post', '/api/admin/federation/oidc/clients', { name: 'Wild', type: 'third party', redirectUris: ['https://*.example.test/cb'], scopes: ['openid'], grants: ['authorization_code'] });
      expect(res.status).toBe(400);
    });
  });

  it('runs the device flow: pending, slow down, approve, token', async () => {
    const c = await createClient({ name: 'exprsn CLI', type: 'public', scopes: ['openid', 'chat:write', 'inference:invoke'], grants: ['device_code', 'refresh_token'] });
    expect(c.secret).toBeNull();
    const auth = await request(h.app).post('/oauth/device_authorization').type('form').send({ client_id: c.client.clientId, scope: 'openid chat:write' });
    expect(auth.status, JSON.stringify(auth.body)).toBe(200);
    expect(auth.body.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    expect(auth.body.verification_uri).toBe('http://localhost:8080/device');
    const poll = () => request(h.app).post('/oauth/token').type('form').send({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: auth.body.device_code, client_id: c.client.clientId });
    expect((await poll()).body.error).toBe('authorization_pending');
    expect((await poll()).body.error).toBe('slow_down');
    const page = await request(h.app).get(`/device?user_code=${auth.body.user_code}`);
    expect(page.text).toContain('data-mode="device"');
    const look = await member.agent.get(`/api/auth/device?user_code=${auth.body.user_code}`);
    expect(look.status).toBe(200);
    expect(look.body.client.name).toBe('exprsn CLI');
    const approve = await member.agent.post('/api/auth/device').set('x-csrf-token', member.csrf).send({ userCode: auth.body.user_code.toLowerCase(), approve: true });
    expect(approve.status, JSON.stringify(approve.body)).toBe(200);
    await h.s.db('oidc_device_codes').update({ last_polled_at: null });
    const tok = await poll();
    expect(tok.status, JSON.stringify(tok.body)).toBe(200);
    expect(tok.body.id_token).toBeTruthy();
    expect(tok.body.refresh_token).toBeTruthy();
    expect(decodeJwt(tok.body.access_token).claims.sub).toBeTruthy();
    expect((await poll()).body.error).toBe('invalid_grant');
    // An unknown or already used code cannot be approved.
    expect((await member.agent.post('/api/auth/device').set('x-csrf-token', member.csrf).send({ userCode: auth.body.user_code, approve: true })).status).toBe(404);
  });

  describe('SAML IdP', () => {
    const spEntity = 'https://wiki.example.test/saml';
    const acs = 'https://wiki.example.test/saml/acs';
    let spId: string;

    beforeAll(async () => {
      const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const cert = selfSignedCertificate({ publicKey, privateKey, commonName: 'wiki.example.test', days: 365 }).toString('base64');
      const xml = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${spEntity}"><md:SPSSODescriptor AuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat><md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${acs}" index="0"/></md:SPSSODescriptor></md:EntityDescriptor>`;
      const parsed = await as('post', '/api/admin/federation/saml/parse', { xml });
      expect(parsed.status).toBe(200);
      expect(parsed.body).toMatchObject({ entityId: spEntity, nameIdFormat: 'emailAddress', signedRequests: false });
      expect(parsed.body.cert.subject).toContain('wiki.example.test');
      const created = await as('post', '/api/admin/federation/saml/sps', { name: 'Confluence', xml });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      spId = created.body.id;
    });

    it('publishes metadata and answers an AuthnRequest with a signed assertion that verifies with node:crypto', async () => {
      const meta = await request(h.app).get('/saml/metadata');
      expect(meta.status).toBe(200);
      expect(meta.text).toContain('entityID="http://localhost:8080/saml/idp"');
      const certB64 = /<ds:X509Certificate>([^<]+)</.exec(meta.text)![1]!;
      const cert = new X509Certificate(Buffer.from(certB64, 'base64'));
      expect(cert.verify(cert.publicKey)).toBe(true);

      const authn = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_req1" Version="2.0" IssueInstant="${new Date().toISOString()}" AssertionConsumerServiceURL="${acs}"><saml:Issuer>${spEntity}</saml:Issuer></samlp:AuthnRequest>`;
      const q = new URLSearchParams({ SAMLRequest: deflateRawSync(Buffer.from(authn)).toString('base64'), RelayState: 'rs-9' });
      const sso = await member.agent.get(`/saml/sso?${q}`);
      expect(sso.status).toBe(302);
      expect(sso.headers.location!).toMatch(/^\/saml\/continue\?h=/);
      const done = await member.agent.get(sso.headers.location!);
      expect(done.status).toBe(200);
      expect(done.text).toContain(`action="${acs}"`);
      expect(done.text).toContain('data-mode="autopost"');
      expect(done.headers['content-security-policy']).toContain("form-action 'self' https://wiki.example.test");
      const samlResponse = /name="SAMLResponse" value="([^"]+)"/.exec(done.text)![1]!;
      const xml = Buffer.from(samlResponse, 'base64').toString('utf8');
      expect(xml).toContain('InResponseTo="_req1"');
      expect(xml).toContain('<saml:Audience>https://wiki.example.test/saml</saml:Audience>');
      expect(xml).toContain('Name="clearance"');

      // Independent check: the SignedInfo as sent is canonical, and the assertion minus its signature is canonical too.
      const assertion = /<saml:Assertion[\s\S]*<\/saml:Assertion>/.exec(xml)![0];
      const signature = /<ds:Signature[\s\S]*<\/ds:Signature>/.exec(assertion)![0];
      const signedInfo = /<ds:SignedInfo[\s\S]*<\/ds:SignedInfo>/.exec(signature)![0];
      const digest = /<ds:DigestValue>([^<]+)</.exec(signedInfo)![1];
      expect(createHash('sha256').update(assertion.replace(signature, '')).digest('base64')).toBe(digest);
      const sigValue = Buffer.from(/<ds:SignatureValue>([^<]+)</.exec(signature)![1]!, 'base64');
      expect(cryptoVerify('sha256', Buffer.from(signedInfo), cert.publicKey, sigValue)).toBe(true);
      // And the canonicalizer agrees with the literal text.
      const root = parseXml(xml);
      expect(verifyEnveloped(root, root.children.find((c) => c.type === 'element' && c.local === 'Assertion') as never, [certB64]).ok).toBe(true);
      const tampered = parseXml(xml.replace('mokafor', 'mallory'));
      expect(verifyEnveloped(tampered, tampered.children.find((c) => c.type === 'element' && c.local === 'Assertion') as never, [certB64]).ok).toBe(false);
      const events = await h.s.db('audit_events').where({ action: 'saml.sso' });
      expect(events.length).toBe(1);
    });

    it('refuses unknown service providers and unregistered ACS URLs', async () => {
      const bad = (issuer: string, acsUrl: string) => `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r" Version="2.0" AssertionConsumerServiceURL="${acsUrl}"><saml:Issuer>${issuer}</saml:Issuer></samlp:AuthnRequest>`;
      const send = (xml: string) => member.agent.get(`/saml/sso?${new URLSearchParams({ SAMLRequest: deflateRawSync(Buffer.from(xml)).toString('base64') })}`);
      expect((await send(bad('https://other.example.test', acs))).status).toBe(400);
      expect((await send(bad(spEntity, 'https://evil.example.test/acs'))).status).toBe(400);
      expect((await send('<!DOCTYPE x [<!ENTITY a "b">]><x/>')).status).toBe(400);
      await as('patch', `/api/admin/federation/saml/sps/${spId}`, { status: 'disabled' });
      expect((await send(bad(spEntity, acs))).status).toBe(400);
      await as('patch', `/api/admin/federation/saml/sps/${spId}`, { status: 'active' });
    });
  });

  describe('upstream federation', () => {
    const idp = new FakeIdp();
    let providerId: string;

    beforeAll(async () => {
      await idp.start();
      process.env.UPSTREAM_SECRET_TEST = idp.clientSecret;
    });
    afterAll(async () => idp.stop());

    it('checks reachability and refuses public (cloud) providers', async () => {
      const ok = await as('post', '/api/admin/federation/upstream/check', { protocol: 'oidc', source: idp.url });
      expect(ok.status).toBe(200);
      expect(ok.body.ok).toBe(true);
      expect(ok.body.reach).toBe('on-prem, internal network');
      const cloud = await as('post', '/api/admin/federation/upstream/check', { protocol: 'oidc', source: 'https://8.8.8.8' });
      expect(cloud.body.ok).toBe(false);
      expect(cloud.body.steps[0].detail).toMatch(/public address/);
    });

    it('signs a user in through an upstream OIDC provider and provisions them by group mapping', async () => {
      const created = await as('post', '/api/admin/federation/upstream', { name: 'Contoso Keycloak', protocol: 'oidc', source: idp.url, clientId: idp.clientId, clientSecret: 'env:UPSTREAM_SECRET_TEST' });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      providerId = created.body.id;
      expect(created.body.status).toBe('connected');
      expect((await as('post', '/api/admin/group-mappings', { providerId, group: 'ai-users', role: 'member', clearance: 'internal' })).status).toBe(201);
      expect((await request(h.app).get('/api/auth/sign-in-options')).body.upstream.map((u: { name: string }) => u.name)).toContain('Contoso Keycloak');

      const browser = request.agent(h.app);
      const start = await browser.get(`/federation/oidc/start?provider=${providerId}`);
      expect(start.status).toBe(302);
      expect(start.headers.location!.startsWith(`${idp.url}/authorize?`)).toBe(true);
      const { code, state } = idp.authorize(start.headers.location!, { sub: 'kc-42', preferred_username: 'PNatarajan', name: 'Priya Natarajan', email: 'priya@example.test', groups: ['ai-users'] });
      // Another browser (without the binding cookie) cannot complete this sign-in.
      const stolen = await request(h.app).get(`/federation/oidc/callback?${new URLSearchParams({ code, state })}`);
      expect(stolen.status).toBe(400);
      const cb = await browser.get(`/federation/oidc/callback?${new URLSearchParams({ code, state })}`);
      expect(cb.status, cb.text).toBe(302);
      expect(cookiesOf(cb).some((c) => c.startsWith('exai_sid='))).toBe(true);
      const session = await browser.get('/api/auth/session');
      expect(session.body).toMatchObject({ authenticated: true, stage: 'active' });
      const user = await h.s.users.byUsername(h.tenantId, 'pnatarajan');
      expect(user).toMatchObject({ display_name: 'Priya Natarajan', clearance: 'internal', email: 'priya@example.test' });
      expect(await h.s.users.roleIds(user!.id)).toEqual(['member']);
      const s = (await h.s.sessions.listForUser(user!.id))[0]!;
      expect(s.method).toBe('OIDC (Contoso Keycloak)');
      // The same state cannot be replayed.
      expect((await browser.get(`/federation/oidc/callback?${new URLSearchParams({ code, state })}`)).status).toBe(400);
    });

    it('refuses an ID token with the wrong nonce', async () => {
      const browser = request.agent(h.app);
      const start = await browser.get(`/federation/oidc/start?provider=${providerId}`);
      const { code, state } = idp.authorize(start.headers.location!, { sub: 'kc-43', preferred_username: 'eve', groups: ['ai-users'] });
      idp.nonceOverride = 'replayed';
      const cb = await browser.get(`/federation/oidc/callback?${new URLSearchParams({ code, state })}`);
      idp.nonceOverride = null;
      expect(cb.status).toBe(400);
      expect(cb.text).toContain('nonce');
    });

    it('verifies signed upstream SAML responses against the registered certificate', async () => {
      const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const cert = selfSignedCertificate({ publicKey, privateKey, commonName: 'adfs.corp.example.test', days: 365 }).toString('base64');
      const entity = 'http://adfs.corp.example.test/adfs/services/trust';
      const metadata = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entity}"><md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://adfs.corp.example.test/adfs/ls/"/></md:IDPSSODescriptor></md:EntityDescriptor>`;
      const created = await as('post', '/api/admin/federation/upstream', { name: 'AD FS', protocol: 'saml', source: metadata });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const id = created.body.id;
      await as('post', '/api/admin/group-mappings', { providerId: id, group: 'field-sales', role: 'member', clearance: 'internal' });
      const spMeta = await request(h.app).get(`/federation/saml/${id}`);
      expect(spMeta.text).toContain(`entityID="http://localhost:8080/federation/saml/${id}"`);

      const response = async (opts: { inResponseTo?: string; tamper?: boolean; audience?: string } = {}) => {
        const browser = request.agent(h.app);
        const start = await browser.get(`/federation/saml/start?provider=${id}`);
        expect(start.status).toBe(302);
        const u = new URL(start.headers.location!);
        const reqXml = (await import('node:zlib')).inflateRawSync(Buffer.from(u.searchParams.get('SAMLRequest')!, 'base64')).toString();
        const requestId = /ID="([^"]+)"/.exec(reqXml)![1]!;
        const now = Date.now();
        const iso = (ms: number) => new Date(ms).toISOString();
        const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a1" IssueInstant="${iso(now)}" Version="2.0"><saml:Issuer>${entity}</saml:Issuer><saml:Subject><saml:NameID>tw@corp</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${opts.inResponseTo ?? requestId}" NotOnOrAfter="${iso(now + 300_000)}" Recipient="http://localhost:8080/federation/saml/acs"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${iso(now - 60_000)}" NotOnOrAfter="${iso(now + 300_000)}"><saml:AudienceRestriction><saml:Audience>${opts.audience ?? `http://localhost:8080/federation/saml/${id}`}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AttributeStatement><saml:Attribute Name="uid"><saml:AttributeValue>twieczorek</saml:AttributeValue></saml:Attribute><saml:Attribute Name="groups"><saml:AttributeValue>field-sales</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion>`;
        let signed = signEnveloped(assertion, privateKey, cert, { afterLocal: 'Issuer' });
        if (opts.tamper) signed = signed.replace('field-sales', 'field-sales-admins');
        const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_r1" Version="2.0"><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${signed}</samlp:Response>`;
        return browser.post('/federation/saml/acs').type('form').send({ SAMLResponse: Buffer.from(xml).toString('base64'), RelayState: u.searchParams.get('RelayState')! });
      };
      // The provider's usernames come from the uid attribute.
      await h.s.providers.update(h.tenantId, id, { config: { ...(await h.s.providers.get(h.tenantId, id))!.config, usernameAttribute: 'uid' } });
      expect((await response({ tamper: true })).status).toBe(400);
      expect((await response({ inResponseTo: '_other' })).status).toBe(400);
      expect((await response({ audience: 'https://someone-else' })).status).toBe(400);
      const ok = await response();
      expect(ok.status, ok.text).toBe(302);
      const user = await h.s.users.byUsername(h.tenantId, 'twieczorek');
      expect(user).toBeTruthy();
      expect(await h.s.users.roleIds(user!.id)).toEqual(['member']);
    });
  });

  describe('Kerberos SPNEGO', () => {
    it('challenges with Negotiate, then signs the principal in through the user stores', async () => {
      await localUser(h, 'kuser', ['member']);
      const first = await request(h.app).get('/auth/negotiate');
      expect(first.status).toBe(401);
      expect(first.headers['www-authenticate']).toBe('Negotiate');
      const browser = request.agent(h.app);
      const res = await browser.get('/auth/negotiate').set('authorization', `Negotiate ${Buffer.from('kuser@CORP.EXAMPLE').toString('base64')}`);
      expect(res.status).toBe(302);
      expect(res.headers['www-authenticate']).toBe(`Negotiate ${Buffer.from('mutual').toString('base64')}`);
      const session = await browser.get('/api/auth/session');
      expect(session.body).toMatchObject({ authenticated: true });
      const u = await h.s.users.byUsername(h.tenantId, 'kuser');
      expect((await h.s.sessions.listForUser(u!.id)).some((x) => x.method === 'Kerberos')).toBe(true);
    });

    it('still requires a second factor for admin roles and enforces the realm list', async () => {
      await localUser(h, 'kadmin', ['identity-admin']);
      const browser = request.agent(h.app);
      await browser.get('/auth/negotiate').set('authorization', `Negotiate ${Buffer.from('kadmin@CORP.EXAMPLE').toString('base64')}`);
      expect((await browser.get('/api/auth/session')).body.stage).toBe('enroll');
      expect((await as('patch', '/api/admin/federation/settings', { kerberos: { realms: ['OTHER.EXAMPLE'] } })).status).toBe(200);
      const refused = await request(h.app).get('/auth/negotiate').set('authorization', `Negotiate ${Buffer.from('kuser@CORP.EXAMPLE').toString('base64')}`);
      expect(refused.status).toBe(403);
      const bad = await request(h.app).get('/auth/negotiate').set('authorization', `Negotiate ${Buffer.from('garbage').toString('base64')}`);
      expect(bad.status).toBe(401);
      await as('patch', '/api/admin/federation/settings', { kerberos: { realms: [] } });
    });

    it('runs the test-a-login tool without creating a session', async () => {
      const before = await h.s.db('sessions').count({ n: '*' }).first();
      const res = await as('post', '/api/admin/federation/test-login', { method: 'kerberos', username: 'kuser' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.steps.map((x: { title: string }) => x.title)).toContain('Test token signed and verified against the JWKS');
      const after = await h.s.db('sessions').count({ n: '*' }).first();
      expect(after).toEqual(before);
    });
  });

  it('canonicalizes like the exclusive C14N reference', () => {
    const doc = parseXml('<r xmlns="urn:x"><p:a xmlns:p="urn:p" xmlns=""><b/><c xmlns="urn:y" xml:lang="en" p:q="1" a="2"/></p:a></r>');
    expect(exclusiveC14n(doc)).toBe('<r xmlns="urn:x"><p:a xmlns:p="urn:p"><b xmlns=""></b><c xmlns="urn:y" a="2" xml:lang="en" p:q="1"></c></p:a></r>');
    expect(exclusiveC14n(doc.children[0] as never)).toBe('<p:a xmlns:p="urn:p"><b></b><c xmlns="urn:y" a="2" xml:lang="en" p:q="1"></c></p:a>');
    expect(() => parseXml('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>')).toThrow();
    expect(textOfNameId('<a><n>admin@x.test<!-- c -->.evil.test</n></a>')).toBe('admin@x.test.evil.test');
  });
});

function textOfNameId(xml: string): string {
  const root = parseXml(xml);
  const n = root.children[0] as { children: { type: string; value: string }[] };
  return n.children.map((c) => c.value).join('');
}
