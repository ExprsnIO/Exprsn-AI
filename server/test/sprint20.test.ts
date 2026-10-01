/*
 * Sprint 20: keys and supply chain. The signer process (B-1201) and the local KMS key kept only in it (B-1205),
 * webhook Ed25519 keys in OpenBao transit or the signer (B-1202), and HTTP Message Signatures (RFC 9421) on `/v1`
 * requests and webhook deliveries (B-1203). B-1204 is CI configuration and is not exercised here.
 */
import { createHash, generateKeyPairSync, randomBytes, X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { checkContentDigest, contentDigest, ed25519PublicKey, parseDictionary, signMessage, verifyMessage, type HttpMessage } from '../src/crypto/httpsig.js';
import { verifyJwt, type Jwk } from '../src/federation/jose.js';
import { SigningKeys } from '../src/federation/keys.js';
import { parseXml } from '../src/federation/xml.js';
import { decryptAssertion, encryptAssertion } from '../src/federation/xmlenc.js';
import { LocalKms } from '../src/platform/kms.js';
import { SignerClient, SignerKms } from '../src/signer/client.js';
import { startSigner, type RunningSigner } from '../src/signer/server.js';
import { FakeOpenBao } from './fake-openbao.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';
import { FakeReceiver } from './sprint13-fakes.js';

const ISSUER = 'http://localhost:8080';
const REDIRECT = 'https://app.example.test/cb';
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A signer on a fresh socket in a private temporary directory. */
async function signerFixture(key = randomBytes(32).toString('base64')) {
  const dir = mkdtempSync(path.join(tmpdir(), 'exs-'));
  const socketPath = path.join(dir, 'run', 'signer.sock');
  const token = randomBytes(24).toString('base64url') + 'x'.repeat(8);
  const signer = await startSigner({ socketPath, key, token });
  return { dir, socketPath, token, key, signer, close: async () => {
    await signer.close();
    rmSync(dir, { recursive: true, force: true });
  } };
}

async function webhookAdmin(h: Harness) {
  await localUser(h, 'ta', ['tenant-admin'], 'confidential');
  const c = await loginAdmin(h, 'ta');
  return { ...c, post: (p: string, b: object = {}) => c.agent.post(p).set('x-csrf-token', c.csrf).send(b) };
}

const drain = async (h: Harness, rounds = 8) => {
  for (let i = 0; i < rounds; i++) {
    await h.s.jobs.runDue();
    await sleep(15);
  }
};

// ---------------------------------------------------------------------------------------------------------------

describe('B-1201: the signer process', () => {
  let f: Awaited<ReturnType<typeof signerFixture>>;
  beforeAll(async () => {
    f = await signerFixture();
  });
  afterAll(async () => f.close());

  it('listens on a socket only its user can reach, and refuses a client without the token', async () => {
    if (process.platform !== 'win32') {
      expect(statSync(path.dirname(f.socketPath)).mode & 0o777).toBe(0o700);
      expect(statSync(f.socketPath).mode & 0o777).toBe(0o600);
    }
    const wrong = new SignerClient(f.socketPath, 'w'.repeat(40), 2000);
    await expect(wrong.call('health')).rejects.toThrow(/Not authorised|closed/);
    wrong.close();
    const right = new SignerClient(f.socketPath, f.token, 2000);
    expect((await right.call('health')).ok).toBe(true);
    right.close();
    // A second signer on the same socket is refused while the first one answers.
    await expect(startSigner({ socketPath: f.socketPath, key: f.key, token: f.token })).rejects.toThrow(/already answers/);
  });

  it('keeps private keys inside: a wrapped key only works under its own name and type', async () => {
    const kms = new SignerKms(new SignerClient(f.socketPath, f.token));
    const held = kms.heldKeys;
    const k = await held.create('fed:t1:k1', 'ecdsa-p256');
    expect(k.publicKey).toContain('BEGIN PUBLIC KEY');
    expect(k.wrapped).not.toContain('PRIVATE');
    const sig = await held.sign('fed:t1:k1', 'ecdsa-p256', k.wrapped, Buffer.from('payload'));
    expect(sig.length).toBe(64);
    await expect(held.sign('fed:t2:k1', 'ecdsa-p256', k.wrapped, Buffer.from('payload'))).rejects.toThrow(/does not open/);
    await expect(held.sign('fed:t1:k1', 'rsa-2048', k.wrapped, Buffer.from('payload'))).rejects.toThrow(/does not open/);
    // A decryption key does not sign, and a signing key does not decrypt.
    const enc = await held.create('fed:t1:enc', 'rsa-oaep-2048', { commonName: 'enc', organization: 'Test', days: 30 });
    expect(new X509Certificate(Buffer.from(enc.certificate!, 'base64')).verify(new X509Certificate(Buffer.from(enc.certificate!, 'base64')).publicKey)).toBe(true);
    await expect(held.sign('fed:t1:enc', 'rsa-oaep-2048' as never, enc.wrapped, Buffer.from('x'))).rejects.toThrow(/does not sign/);
    await expect(held.decrypt('fed:t1:k1', k.wrapped, Buffer.alloc(256), 'sha256')).rejects.toThrow(/does not open/);
    (kms.client as SignerClient).close();
  });

  it('wraps data keys exactly as the local KMS does, so moving DATA_KEY into the signer needs no re-wrap', async () => {
    const local = new LocalKms(f.key);
    const kms = new SignerKms(new SignerClient(f.socketPath, f.token));
    const dek = randomBytes(32);
    const wrappedLocally = await local.wrap('exprsn-tenant-x', dek, 'dek:x:1');
    expect((await kms.unwrap('exprsn-tenant-x', wrappedLocally, 'dek:x:1')).equals(dek)).toBe(true);
    expect((await local.unwrap('exprsn-tenant-x', await kms.wrap('exprsn-tenant-x', dek, 'dek:x:1'), 'dek:x:1')).equals(dek)).toBe(true);
    expect(await kms.hmac('audit', 'data')).toBe(await local.hmac('audit', 'data'));
    expect(await kms.verifyHmac('audit', 'data', await local.hmac('audit', 'data'))).toBe(true);
    expect((await kms.health()).ok).toBe(true);
    kms.client.close();
  });
});

describe('B-1201 and B-1205: the app with SIGNER_SOCKET and no DATA_KEY', () => {
  let f: Awaited<ReturnType<typeof signerFixture>>;
  let h: Harness;
  let signer: RunningSigner;
  const hook = new FakeReceiver();

  beforeAll(async () => {
    f = await signerFixture();
    signer = f.signer;
    await hook.start();
    // DATA_KEY empty counts as unset: the key-encryption key is only in the signer.
    h = await harness({ DATA_KEY: '', SIGNER_SOCKET: f.socketPath, SIGNER_TOKEN: f.token });
  });
  afterAll(async () => {
    await h.close();
    await hook.stop();
    await f.close();
  });

  it('runs without DATA_KEY: data keys are wrapped in the signer', async () => {
    expect(h.s.cfg.DATA_KEY).toBeUndefined();
    expect(h.s.kms.heldKeys).toBeTruthy();
    const sealed = await h.s.keys.seal(h.tenantId, 'tenant content', 'row-1');
    expect(await h.s.keys.open(h.tenantId, sealed, 'row-1')).toBe('tenant content');
    expect(signer.served.wrap).toBeGreaterThan(0);
  });

  it('signs ID tokens and SAML assertions and decrypts assertions with no private key in the app', async () => {
    const { client, secret } = await h.s.federation.oidc.createClient(h.tenantId, { name: 'Signed', type: 'first_party', redirectUris: [REDIRECT], grants: ['authorization_code'], scopes: ['openid', 'profile'], pkceRequired: true, accessTtl: 600, refreshTtl: 3600, models: null, serviceUserId: null }, null);
    await localUser(h, 'sgnuser', ['member']);
    const u = await login(h, 'sgnuser');
    const verifier = b64u(randomBytes(48));
    const challenge = b64u(createHash('sha256').update(verifier).digest());
    const res = await u.agent.get(`/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, scope: 'openid profile', code_challenge: challenge, code_challenge_method: 'S256' })}`);
    expect(res.status, res.text).toBe(302);
    const tok = await request(h.app).post('/oauth/token').set('authorization', basic(client.client_id, secret!)).type('form').send({ grant_type: 'authorization_code', code: new URL(res.headers.location!).searchParams.get('code')!, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(tok.status, JSON.stringify(tok.body)).toBe(200);
    const keys = (await request(h.app).get('/.well-known/jwks.json')).body.keys as Jwk[];
    expect(verifyJwt(tok.body.id_token, keys, { issuer: ISSUER, audience: client.client_id, algs: ['ES256'] }).preferred_username).toBe('sgnuser');

    // SAML IdP: the certificate was made in the signer and verifies.
    const meta = (await request(h.app).get('/saml/metadata')).text;
    const cert = new X509Certificate(Buffer.from(/<ds:X509Certificate>([^<]+)</.exec(meta)![1]!, 'base64'));
    expect(cert.verify(cert.publicKey)).toBe(true);

    // SAML SP: an assertion encrypted to our published encryption certificate is decrypted in the signer.
    const dec = await h.s.federation.keys.decrypter(h.tenantId);
    const assertion = '<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a1"><saml:Issuer>idp</saml:Issuer></saml:Assertion>';
    const encrypted = parseXml(encryptAssertion(assertion, dec.row.certificate!));
    expect(await decryptAssertion(encrypted, dec.decrypt)).toBe(assertion);
    expect(signer.served.decrypt).toBe(1);

    // No private key in the app: every federation key row is held by the signer, and none is cached in memory.
    const rows = (await h.s.db('federation_keys')) as { kid: string; use: string; private_sealed: string }[];
    expect(rows.map((r) => r.use).sort()).toEqual(['oidc', 'saml', 'saml-enc']);
    for (const r of rows) expect(SigningKeys.inSigner(r)).toBe(true);
    expect(h.s.federation.keys.cachedKids()).toEqual([]);
    expect(signer.served.sign).toBeGreaterThanOrEqual(1);
    expect(signer.served.keygen).toBe(3);
  });

  it('replaces a federation key sealed in the app when the signer takes over', async () => {
    const before = (await h.s.federation.keys.list(h.tenantId)).find((k) => k.state === 'signing')!;
    await h.s.db('federation_keys').where({ kid: before.kid }).update({ private_sealed: 'sealed-locally' });
    const s = await h.s.federation.keys.signer(h.tenantId);
    expect(s.remote).toBe(true);
    expect(s.kid).not.toBe(before.kid);
    expect((await h.s.federation.keys.jwks(h.tenantId)).keys.map((k) => k.kid)).toEqual(expect.arrayContaining([before.kid, s.kid]));
  });

  it('B-1202: holds webhook Ed25519 keys in the signer', async () => {
    const a = await webhookAdmin(h);
    await a.post('/api/admin/webhooks', { name: 'held', url: `${hook.url}/hook`, events: ['demo.*'], signing: 'ed25519' }).expect(201);
    const row = (await h.s.db('webhook_signing_keys').first()) as { id: string; private_sealed: string; public_key: string };
    expect(row.private_sealed).toMatch(/^signer:/);
    await h.s.webhooks.emit(h.tenantId, 'demo.held', 'internal', 'ev-held', { a: 1 });
    await drain(h);
    const got = hook.got.find((g) => JSON.parse(g.body).id === 'ev-held')!;
    const { verifyEd25519 } = await import('../src/webhooks/service.js');
    expect(verifyEd25519(row.public_key, String(got.headers['x-exprsn-timestamp']), String(got.headers['x-exprsn-signature-ed25519']), got.body)).toBe(true);
  });

  it('fails closed when the signer is gone', async () => {
    await signer.close();
    expect((await h.s.kms.health()).ok).toBe(false);
    await expect(h.s.federation.keys.signer(h.tenantId).then((x) => x.sign(Buffer.from('x')))).rejects.toThrow(/signer/i);
  });
});

describe('B-1205: DATA_KEY never inline in production', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'exprsn-b1205-'));
  const keyFile = path.join(dir, 'data_key');
  const tokenFile = path.join(dir, 'signer_token');
  writeFileSync(keyFile, randomBytes(32).toString('base64'), { mode: 0o600 });
  writeFileSync(tokenFile, 't'.repeat(40), { mode: 0o600 });
  const prod = { NODE_ENV: 'production', PUBLIC_URL: 'https://ai.example.internal', SESSION_SECRET: 'x'.repeat(64) };
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses DATA_KEY in the environment in production, and accepts DATA_KEY_FILE', () => {
    expect(() => loadConfig({ ...prod, DATA_KEY: randomBytes(32).toString('base64') })).toThrow(/production refuses DATA_KEY given inline/);
    expect(loadConfig({ ...prod, DATA_KEY_FILE: keyFile }).DATA_KEY).toBeTruthy();
    // Outside production it is still allowed (development and tests).
    expect(() => loadConfig({ ...prod, NODE_ENV: 'development', DATA_KEY: randomBytes(32).toString('base64') })).not.toThrow();
  });

  it('refuses DATA_KEY given inline when the signer is configured, and any DATA_KEY at all in production', () => {
    expect(() => loadConfig({ ...prod, SIGNER_SOCKET: '/run/exprsn-signer/signer.sock', SIGNER_TOKEN_FILE: tokenFile, DATA_KEY: randomBytes(32).toString('base64') })).toThrow(/production refuses DATA_KEY given inline/);
    expect(() => loadConfig({ ...prod, SIGNER_SOCKET: '/run/exprsn-signer/signer.sock', SIGNER_TOKEN_FILE: tokenFile, DATA_KEY_FILE: keyFile })).toThrow(/lives only in the signer/);
    const cfg = loadConfig({ ...prod, SIGNER_SOCKET: '/run/exprsn-signer/signer.sock', SIGNER_TOKEN_FILE: tokenFile });
    expect(cfg.DATA_KEY).toBeUndefined();
    expect(cfg.SIGNER_TOKEN).toBe('t'.repeat(40));
    // The token too comes from a file in production; the signer needs its token; OpenBao keeps transit.
    expect(() => loadConfig({ ...prod, SIGNER_SOCKET: '/run/s.sock', SIGNER_TOKEN: 't'.repeat(40) })).toThrow(/SIGNER_TOKEN given inline/);
    expect(() => loadConfig({ ...prod, SIGNER_SOCKET: '/run/s.sock' })).toThrow(/SIGNER_TOKEN/);
    expect(() => loadConfig({ ...prod, SIGNER_SOCKET: '/run/s.sock', SIGNER_TOKEN_FILE: tokenFile, KMS_PROVIDER: 'openbao', OPENBAO_ADDR: 'https://bao.internal', OPENBAO_TOKEN_FILE: tokenFile })).toThrow(/KMS_PROVIDER=local/);
    expect(() => loadConfig({ ...prod })).toThrow(/DATA_KEY is required/);
  });
});

describe('B-1202: webhook Ed25519 keys in OpenBao transit', () => {
  const bao = new FakeOpenBao();
  const hook = new FakeReceiver();
  let h: Harness;
  beforeAll(async () => {
    await bao.start();
    await hook.start();
    h = await harness({ KMS_PROVIDER: 'openbao', OPENBAO_ADDR: bao.url, OPENBAO_TOKEN: bao.token });
  });
  afterAll(async () => {
    await h.close();
    await hook.stop();
    await bao.stop();
  });

  it('makes the webhook signature in transit, with no private key in the database or the process', async () => {
    const a = await webhookAdmin(h);
    await a.post('/api/admin/webhooks', { name: 'transit', url: `${hook.url}/hook`, events: ['demo.*'], signing: 'ed25519', messageSignatures: true }).expect(201);
    const row = (await h.s.db('webhook_signing_keys').first()) as { id: string; private_sealed: string };
    expect(row.private_sealed).toBe(`kms:exprsn-webhook-${row.id.toLowerCase()}`);
    expect((await a.agent.get('/api/admin/webhooks/signing-key').expect(200)).body.active.store).toBe('kms');
    await h.s.webhooks.emit(h.tenantId, 'demo.transit', 'internal', 'ev-transit', { ok: true });
    await drain(h);
    const got = hook.got[0]!;
    expect(bao.signed.filter((n) => n.includes('webhook-'))).toHaveLength(2); // the legacy header and the RFC 9421 one
    const jwks = (await request(h.app).get('/webhooks/keys/default').expect(200)).body as { keys: { kid: string; x: string }[] };
    const jwk = jwks.keys.find((k) => k.kid === got.headers['x-exprsn-key-id'])!;
    const { verifyEd25519 } = await import('../src/webhooks/service.js');
    expect(verifyEd25519(jwk.x, String(got.headers['x-exprsn-timestamp']), String(got.headers['x-exprsn-signature-ed25519']), got.body)).toBe(true);
    // The RFC 9421 signature verifies with the same published key.
    const msg: HttpMessage = { method: 'POST', url: `${hook.url}/hook`, headers: got.headers as HttpMessage['headers'] };
    expect(checkContentDigest(String(got.headers['content-digest']), got.body)).toBe(true);
    const v = await verifyMessage(msg, { required: ['@method', '@target-uri', 'content-digest'], maxAgeSeconds: 300, keyFor: (kid) => (kid === jwk.kid ? { alg: 'ed25519', key: ed25519PublicKey(jwk.x) } : null) });
    expect(v).toMatchObject({ ok: true, label: 'exprsn', keyid: jwk.kid });
  });

  it('moves a key sealed before OpenBao into transit (the old one stays published)', async () => {
    const old = (await h.s.db('webhook_signing_keys').where({ state: 'active' }).first()) as { id: string };
    await h.s.db('webhook_signing_keys').where({ id: old.id }).update({ private_sealed: 'v2.sealed-before' });
    const out = await h.s.webhooks.edSign(h.tenantId, Buffer.from('x'));
    expect(out.kid).not.toBe(old.id);
    const all = (await h.s.db('webhook_signing_keys').select('id', 'state')) as { id: string; state: string }[];
    expect(all.find((k) => k.id === old.id)!.state).toBe('retired');
    expect((await h.s.db('audit_events').where({ action: 'webhook.signing-key.created' })).length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('B-1203: HTTP Message Signatures (RFC 9421)', () => {
  it('parses structured fields and checks Content-Digest (RFC 9530)', () => {
    const d = parseDictionary('sig1=("@method" "@target-uri");created=1618884473;keyid="test-key-ed25519", sig2=:aGVsbG8=:');
    expect([...d.keys()]).toEqual(['sig1', 'sig2']);
    expect(contentDigest('{"hello": "world"}')).toBe('sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:'); // RFC 9530 B.1
    expect(checkContentDigest('sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:', '{"hello": "world"}')).toBe(true);
    expect(checkContentDigest('sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:', '{"hello": "w0rld"}')).toBe(false);
    expect(checkContentDigest('md5=:aGVsbG8=:', 'x')).toBe(false);
    expect(() => parseDictionary('sig1=("a" "b"')).toThrow();
  });

  it('signs and verifies with Ed25519 and HMAC-SHA256, and refuses a changed component', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const msg: HttpMessage = { method: 'POST', url: 'https://api.example.test/v1/chat/completions?x=1', headers: { 'content-type': 'application/json', 'content-digest': contentDigest('{}') } };
    const comps = ['@method', '@target-uri', '@authority', '@path', '@query', 'content-type', 'content-digest'];
    const ed = await signMessage(msg, { components: comps, keyid: 'k1', alg: 'ed25519', key: privateKey });
    const signed = { ...msg, headers: { ...msg.headers, ...ed } };
    const opts = { required: ['@method', '@target-uri'], maxAgeSeconds: 300, keyFor: () => ({ alg: 'ed25519' as const, key: publicKey }) };
    expect(await verifyMessage(signed, opts)).toMatchObject({ ok: true, keyid: 'k1' });
    expect(await verifyMessage({ ...signed, method: 'PUT' }, opts)).toMatchObject({ ok: false });
    expect(await verifyMessage({ ...signed, headers: { ...signed.headers, 'content-type': 'text/plain' } }, opts)).toMatchObject({ ok: false, reason: 'The signature does not verify.' });
    expect(await verifyMessage(signed, { ...opts, required: ['authorization'] })).toMatchObject({ ok: false, reason: 'The signature must cover authorization.' });
    expect(await verifyMessage(signed, { ...opts, now: Date.now() + 3600_000 })).toMatchObject({ ok: false });

    const mac = await signMessage(msg, { components: comps, keyid: 'hook', alg: 'hmac-sha256', key: 'whsec_test' });
    const hm = { ...msg, headers: { ...msg.headers, ...mac } };
    expect(await verifyMessage(hm, { ...opts, keyFor: () => ({ alg: 'hmac-sha256', key: 'whsec_test' }) })).toMatchObject({ ok: true });
    expect(await verifyMessage(hm, { ...opts, keyFor: () => ({ alg: 'hmac-sha256', key: 'whsec_other' }) })).toMatchObject({ ok: false });
    // An alg that names a different algorithm than the key's is refused.
    expect(await verifyMessage(hm, { ...opts, keyFor: () => ({ alg: 'ed25519', key: publicKey }) })).toMatchObject({ ok: false });
  });

  describe('on /v1 and webhooks', () => {
    let h: Harness;
    const hook = new FakeReceiver();
    beforeAll(async () => {
      h = await harness();
      await hook.start();
    });
    afterAll(async () => {
      await h.close();
      await hook.stop();
    });

    it('a signed /v1 request verifies; an unsigned one and a tampered header are refused', async () => {
      await localUser(h, 'apiuser', ['member']);
      const u = await login(h, 'apiuser');
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const x = String(publicKey.export({ format: 'jwk' }).x);
      const created = await u.agent.post('/api/me/api-keys').set('x-csrf-token', u.csrf).send({ name: 'signed', scopes: ['inference:invoke'], ttlDays: 30, signatureKey: x });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.signatureKey).toBe(x);
      const auth = `Bearer ${created.body.key as string}`;

      const signedGet = async (p: string, extra: Record<string, string> = {}, components = ['@method', '@target-uri', 'authorization']) => {
        const headers: Record<string, string> = { authorization: auth, ...extra };
        const sig = await signMessage({ method: 'GET', url: `${ISSUER}${p}`, headers }, { components, keyid: created.body.id, alg: 'ed25519', key: privateKey });
        return { ...headers, ...sig };
      };
      const send = (method: 'get' | 'post', p: string, headers: Record<string, string>, body?: string) => {
        let r = request(h.app)[method](p);
        for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
        return body === undefined ? r : r.send(body);
      };

      expect((await send('get', '/v1/models', await signedGet('/v1/models'))).status).toBe(200);
      // Not accepted outside /v1, where nothing checks signatures.
      expect((await request(h.app).get('/api/me').set('authorization', auth)).status).toBe(401);
      const unsigned = await send('get', '/v1/models', { authorization: auth });
      expect(unsigned.status).toBe(401);
      expect(unsigned.body.error.code).toBe('invalid_signature');
      // A header covered by the signature is changed on the way: refused.
      const h1 = await signedGet('/v1/models', { 'x-data-label': 'internal' }, ['@method', '@target-uri', 'authorization', 'x-data-label']);
      expect((await send('get', '/v1/models', h1)).status).toBe(200);
      const tampered = await send('get', '/v1/models', { ...h1, 'x-data-label': 'public' });
      expect(tampered.status).toBe(401);
      expect(tampered.body.error.message).toContain('does not verify');
      // Signed for another path: refused.
      expect((await send('get', '/v1/models/x', await signedGet('/v1/models'))).status).toBe(401);
      // Without authorization among the components: refused.
      expect((await send('get', '/v1/models', await signedGet('/v1/models', {}, ['@method', '@target-uri']))).body.error.message).toContain('must cover authorization');

      // A body must be bound by Content-Digest; a changed body is refused before anything runs.
      const body = JSON.stringify({ model: 'no-such-model', messages: [{ role: 'user', content: 'hi' }] });
      const postHeaders = async (b: string) => {
        const headers: Record<string, string> = { authorization: auth, 'content-type': 'application/json', 'content-digest': contentDigest(b) };
        return { ...headers, ...(await signMessage({ method: 'POST', url: `${ISSUER}/v1/chat/completions`, headers }, { components: ['@method', '@target-uri', 'authorization', 'content-type', 'content-digest'], keyid: `exai_k1_${(created.body.prefix as string).slice(8)}`, alg: 'ed25519', key: privateKey })) };
      };
      const okPost = await send('post', '/v1/chat/completions', await postHeaders(body), body);
      expect(okPost.status).not.toBe(401); // past the signature check: the model does not exist
      expect(okPost.body.error.code).not.toBe('invalid_signature');
      const swapped = await send('post', '/v1/chat/completions', await postHeaders(body), body.replace('hi', 'bye'));
      expect(swapped.status).toBe(401);
      expect(swapped.body.error.message).toContain('Content-Digest');

      // Removing the key's public key turns signing off again (audited, with a security notice).
      const off = await u.agent.put(`/api/me/api-keys/${created.body.id as string}/signature-key`).set('x-csrf-token', u.csrf).send({ publicKey: null });
      expect(off.status, JSON.stringify(off.body)).toBe(200);
      expect((await send('get', '/v1/models', { authorization: auth })).status).toBe(200);
      expect((await u.agent.put(`/api/me/api-keys/${created.body.id as string}/signature-key`).set('x-csrf-token', u.csrf).send({ publicKey: 'not-a-key' })).status).toBe(400);
      expect(await h.s.db('audit_events').whereIn('action', ['apikey.signature_key.removed']).first()).toBeTruthy();
      // An API key cannot change its own signing requirement.
      expect((await request(h.app).put(`/api/me/api-keys/${created.body.id as string}/signature-key`).set('authorization', auth).send({ publicKey: x })).status).toBe(403);
    });

    it('webhooks add RFC 9421 signatures with HMAC-SHA256 next to their own headers', async () => {
      const a = await webhookAdmin(h);
      const w = (await a.post('/api/admin/webhooks', { name: 'rfc', url: `${hook.url}/rfc`, events: ['demo.*'], messageSignatures: true }).expect(201)).body;
      expect(w.messageSignatures).toBe(true);
      await h.s.webhooks.emit(h.tenantId, 'demo.rfc', 'internal', 'ev-rfc', { n: 1 });
      await drain(h);
      const got = hook.got.find((g) => g.path === '/rfc')!;
      expect(got.headers['x-exprsn-signature']).toMatch(/^sha256=/);
      expect(String(got.headers['signature-input'])).toContain('alg="hmac-sha256"');
      const msg: HttpMessage = { method: 'POST', url: `${hook.url}/rfc`, headers: got.headers as HttpMessage['headers'] };
      expect(checkContentDigest(String(got.headers['content-digest']), got.body)).toBe(true);
      const keyFor = (kid: string | null) => (kid === w.id ? { alg: 'hmac-sha256' as const, key: w.secret as string } : null);
      expect(await verifyMessage(msg, { required: ['@method', '@target-uri', 'content-digest', 'x-exprsn-delivery-id'], maxAgeSeconds: 300, keyFor })).toMatchObject({ ok: true });
      expect(await verifyMessage({ ...msg, headers: { ...msg.headers, 'x-exprsn-delivery-id': 'other' } }, { required: [], maxAgeSeconds: 300, keyFor })).toMatchObject({ ok: false });
    });
  });
});
