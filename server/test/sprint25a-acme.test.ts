/*
 * Sprint 25a: the ACME server (B-1605), export, renewal and expiry notices (B-1606), and `exprsn-ai pki` (B-1607).
 *
 * The CA keys live in a real signer process. Exprsn-AI's own ACME client (`ops/acme.ts`, the platform certificate
 * flow) orders from the tenant's directory over HTTP on loopback: http-01 is fetched from the app's own
 * `/.well-known/acme-challenge/` route (host names under `.acme.test` resolve to 127.0.0.1 through the validator's
 * lookup, still checked by the service address policy), and dns-01 asks a fake DNS server over UDP through
 * `node:dns` (PKI_ACME_DNS_SERVERS). A hand-written client checks the protocol edges: nonces, URLs, RS256 and EdDSA
 * keys, key change, revocation by certificate key, external account binding and tenant isolation.
 */
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign as cryptoSign, X509Certificate, type KeyObject } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSecureContext } from 'node:tls';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pkiCommand } from '../src/cli/pki.js';
import { HttpAcmeClient } from '../src/ops/acme.js';
import { selfSignedCertificate } from '../src/federation/x509.js';
import { buildCsr, toPem } from '../src/ops/der.js';
import { buildPkcs12, pkcs12Kdf } from '../src/pki/pkcs12.js';
import type { PkiActor } from '../src/pki/service.js';
import { startSigner } from '../src/signer/server.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';
import { loopbackServerFor } from './loopback.js';
import { startFakeDns, type FakeDns } from './sprint25a-fakes.js';

const hasOpenssl = spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0;
const sslConf = path.join(mkdtempSync(path.join(tmpdir(), 'exprsn-ssl-')), 'openssl.cnf');
writeFileSync(sslConf, '[req]\ndistinguished_name = dn\n[dn]\n');
const openssl = (args: string[]) => execFileSync('openssl', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, OPENSSL_CONF: sslConf } });
/** stdout and stderr together (`pkcs12 -info` reports on stderr). */
const opensslAll = (args: string[]) => {
  const r = spawnSync('openssl', args, { encoding: 'utf8', env: { ...process.env, OPENSSL_CONF: sslConf } });
  if (r.status !== 0) throw new Error(r.stderr);
  return `${r.stdout}${r.stderr}`;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;

async function signerFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'exs-'));
  const socketPath = path.join(dir, 'run', 'signer.sock');
  const token = randomBytes(24).toString('base64url') + 'x'.repeat(8);
  const signer = await startSigner({ socketPath, key: randomBytes(32).toString('base64'), token });
  return { socketPath, token, close: async () => {
    await signer.close();
    rmSync(dir, { recursive: true, force: true });
  } };
}

async function admin(h: Harness, username: string, roles: string[]) {
  const user = await localUser(h, username, roles, 'confidential');
  const c = await loginAdmin(h, username);
  return {
    ...c,
    user,
    get: (p: string) => c.agent.get(p),
    post: (p: string, b: object = {}) => c.agent.post(p).set('x-csrf-token', c.csrf).send(b),
    put: (p: string, b: object = {}) => c.agent.put(p).set('x-csrf-token', c.csrf).send(b)
  };
}

const csrPem = (domains: string[], key = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey) => ({ key, pem: toPem(buildCsr(domains, key), 'CERTIFICATE REQUEST') });

// ---------------------------------------------------------------------------------------------------------------
// A hand-written ACME client for the protocol edges (Exprsn-AI's own client covers the happy paths).

type Alg = 'ES256' | 'RS256' | 'EdDSA';
const publicJwk = (key: KeyObject): Record<string, string> => {
  const j = key.export({ format: 'jwk' }) as Record<string, string>;
  return j.kty === 'EC' ? { crv: j.crv!, kty: 'EC', x: j.x!, y: j.y! } : j.kty === 'RSA' ? { e: j.e!, kty: 'RSA', n: j.n! } : { crv: j.crv!, kty: 'OKP', x: j.x! };
};
const thumb = (key: KeyObject) => createHash('sha256').update(JSON.stringify(publicJwk(key))).digest('base64url');
const b64u = (x: string | Buffer) => Buffer.from(x).toString('base64url');
function jwsSign(alg: Alg, key: KeyObject, input: string): string {
  if (alg === 'ES256') return b64u(cryptoSign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }));
  if (alg === 'RS256') return b64u(cryptoSign('sha256', Buffer.from(input), key));
  return b64u(cryptoSign(null, Buffer.from(input), key));
}

interface Reply {
  status: number;
  headers: Headers;
  body: Record<string, unknown> & { type?: string; detail?: string; status?: string };
  text: string;
}

class RawAcme {
  kid: string | null = null;
  constructor(
    readonly dir: Record<string, string>,
    public priv: KeyObject,
    public alg: Alg = 'ES256'
  ) {}

  static async open(url: string, priv?: KeyObject, alg: Alg = 'ES256'): Promise<RawAcme> {
    const r = await fetch(url);
    return new RawAcme((await r.json()) as Record<string, string>, priv ?? generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey, alg);
  }

  async nonce(): Promise<string> {
    return (await fetch(this.dir.newNonce!, { method: 'HEAD' })).headers.get('replay-nonce')!;
  }

  body(url: string, payload: unknown, o: { nonce: string; jwk?: boolean; key?: KeyObject; alg?: Alg; headerUrl?: string }): string {
    const key = o.key ?? this.priv;
    const alg = o.alg ?? this.alg;
    const header = { alg, nonce: o.nonce, url: o.headerUrl ?? url, ...(o.jwk || !this.kid ? { jwk: publicJwk(key) } : { kid: this.kid }) };
    const p = b64u(JSON.stringify(header));
    const pl = payload === null ? '' : b64u(JSON.stringify(payload));
    return JSON.stringify({ protected: p, payload: pl, signature: jwsSign(alg, key, `${p}.${pl}`) });
  }

  async send(url: string, body: string, contentType = 'application/jose+json'): Promise<Reply> {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': contentType }, body });
    const text = await r.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // PEM or empty
    }
    return { status: r.status, headers: r.headers, body: parsed as Reply['body'], text };
  }

  async post(url: string, payload: unknown, o: { jwk?: boolean; key?: KeyObject; alg?: Alg; headerUrl?: string } = {}): Promise<Reply> {
    return this.send(url, this.body(url, payload, { ...o, nonce: await this.nonce() }));
  }

  async register(extra: Record<string, unknown> = {}): Promise<Reply> {
    const r = await this.post(this.dir.newAccount!, { termsOfServiceAgreed: true, ...extra }, { jwk: true });
    if (r.status === 201 || r.status === 200) this.kid = r.headers.get('location');
    return r;
  }

  keyAuthorization(token: string): string {
    return `${token}.${thumb(this.priv)}`;
  }
}

// ---------------------------------------------------------------------------------------------------------------

describe('Sprint 25a: the ACME server, certificate lifecycle and the pki CLI', () => {
  let f: Awaited<ReturnType<typeof signerFixture>>;
  let dns: FakeDns;
  let h: Harness;
  let base: string;
  let port: number;
  let slug: string;
  let directory: string;
  let sys: Awaited<ReturnType<typeof admin>>;
  let ta: Awaited<ReturnType<typeof admin>>;
  let by: PkiActor;
  let profileId: string;
  let interPem: string;
  let rootPem: string;
  let work: string;
  /** http-01 answers the hand-written client serves (the app's route serves the platform client's). */
  const served = new Map<string, string>();

  /** Two job loops, so the platform's issuing job can wait while another loop runs the validation jobs. */
  const runJobs = () => {
    let on = true;
    const loop = async () => {
      while (on) {
        await h.s.jobs.runDue(5).catch(() => undefined);
        await sleep(15);
      }
    };
    const loops = [loop(), loop()];
    return async () => {
      on = false;
      await Promise.all(loops);
    };
  };

  const waitFor = async <T>(fn: () => Promise<T | undefined | null | false>, ms = 30_000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error('timed out');
      await sleep(25);
    }
  };

  beforeAll(async () => {
    f = await signerFixture();
    dns = await startFakeDns();
    h = await harness({ DATA_KEY: '', SIGNER_SOCKET: f.socketPath, SIGNER_TOKEN: f.token, PKI_ACME_DNS_SERVERS: dns.address, ACME_POLL_MS: '20', ACME_DNS_WAIT_SECONDS: '0', PKI_EXPIRY_SWEEP_MINUTES: '0' });
    port = (loopbackServerFor(h.app)!.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    h.s.cfg.PKI_PUBLIC_URL = base;
    // The hand-written client's tokens are answered here; everything else falls through to the app's own route.
    h.s.pki.acme.validation = { httpPort: port, resolveHost: async (host) => (host.endsWith('.acme.test') ? ['127.0.0.1'] : host === 'meta.acme.example' ? ['169.254.169.254'] : []) };
    const origin = h.s.ops.certs.challengeResponse.bind(h.s.ops.certs);
    h.s.ops.certs.challengeResponse = async (token: string) => served.get(token) ?? origin(token);
    slug = (await h.s.tenants.byId(h.tenantId))!.slug;
    directory = `${base}/pki/acme/${slug}/directory`;
    sys = await admin(h, 'root', ['system-admin']);
    ta = await admin(h, 'ta', ['tenant-admin']);
    by = { tenantId: h.tenantId, userId: null, actor: { service: 'test' } };
    rootPem = (await h.s.pki.createRoot(by, { commonName: 'ACME Test Root', keyType: 'ecdsa-p256', days: 3650 })).certificate_pem;
    interPem = (await h.s.pki.createIntermediate(by, h.tenantId, { keyType: 'ecdsa-p256', days: 1825 })).certificate_pem;
    const p = await ta.post('/api/pki/profiles', { name: 'acme', kind: 'server', maxDays: 90, defaultDays: 30, policy: { domains: ['*.acme.test'], allowWildcard: true } });
    expect(p.status).toBe(201);
    profileId = p.body.id;
    work = mkdtempSync(path.join(tmpdir(), 'exprsn-acme-'));
  }, 120_000);

  afterAll(async () => {
    await h.close();
    await dns.close();
    await f.close();
    rmSync(work, { recursive: true, force: true });
  });

  it('B-1605: the directory stays closed until a pki:manage holder opens it with a server profile', async () => {
    const closed = await fetch(directory);
    expect(closed.status).toBe(404);
    expect(closed.headers.get('content-type')).toMatch(/application\/problem\+json/);
    expect(((await closed.json()) as { type: string }).type).toBe('urn:ietf:params:acme:error:malformed');
    expect((await ta.put('/api/pki/acme', { enabled: true })).status).toBe(422); // no profile yet
    const r = await ta.put('/api/pki/acme', { enabled: true, profileId });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, profileId, eabRequired: false, challenges: ['http-01', 'dns-01'], directoryUrl: directory });
    const d = (await (await fetch(directory)).json()) as Record<string, unknown>;
    expect(d).toMatchObject({ newNonce: `${base}/pki/acme/${slug}/new-nonce`, newAccount: `${base}/pki/acme/${slug}/new-account`, newOrder: `${base}/pki/acme/${slug}/new-order`, revokeCert: `${base}/pki/acme/${slug}/revoke-cert`, keyChange: `${base}/pki/acme/${slug}/key-change`, meta: { externalAccountRequired: false } });
    const n = await fetch(`${base}/pki/acme/${slug}/new-nonce`, { method: 'HEAD' });
    expect(n.status).toBe(200);
    expect(n.headers.get('replay-nonce')).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(n.headers.get('cache-control')).toBe('no-store');
    expect(n.headers.get('link')).toBe(`<${directory}>;rel="index"`);
    expect((await h.s.db('audit_events').where({ action: 'pki.acme.settings.updated' })).length).toBe(1);
  });

  it('B-1605: Exprsn-AI\'s own ACME client gets a certificate end to end over http-01, then revokes it', async () => {
    (h.s as { acme: unknown }).acme = new HttpAcmeClient(directory, { pollMs: 20 });
    const req = await sys.post('/api/admin/platform/certificates', { domains: ['www.acme.test', 'api.acme.test'], issuedTo: 'web', use: 'TLS' });
    expect(req.status).toBe(202);
    const stop = runJobs();
    let row: Record<string, unknown>;
    try {
      row = await waitFor(async () => {
        const r = (await h.s.db('platform_certificates').where({ id: req.body.id }).first()) as Record<string, unknown>;
        if (r.state === 'failed') throw new Error(`issue failed: ${String(r.error)}`);
        return r.state === 'valid' ? r : null;
      });
    } finally {
      await stop();
    }
    const chain = String(row.chain_pem);
    const blocks = chain.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)!;
    expect(blocks).toHaveLength(2); // the leaf and the intermediate; the root comes from the trust store
    const leaf = new X509Certificate(blocks[0]!);
    const inter = new X509Certificate(interPem);
    expect(leaf.verify(inter.publicKey)).toBe(true);
    expect(new X509Certificate(blocks[1]!).fingerprint256).toBe(inter.fingerprint256);
    expect(leaf.subjectAltName).toBe('DNS:www.acme.test, DNS:api.acme.test');
    expect(leaf.subject).toBe('CN=www.acme.test');
    expect(Math.round((Date.parse(leaf.validTo) - Date.now()) / DAY)).toBe(30); // the profile's default lifetime
    if (hasOpenssl) {
      writeFileSync(path.join(work, 'root.pem'), rootPem);
      writeFileSync(path.join(work, 'int.pem'), interPem);
      writeFileSync(path.join(work, 'leaf.pem'), blocks[0]! + '\n');
      expect(openssl(['verify', '-CAfile', path.join(work, 'root.pem'), '-untrusted', path.join(work, 'int.pem'), path.join(work, 'leaf.pem')])).toMatch(/OK/);
    }

    // The CA's record: issued under the ACME profile, for the account the platform registered.
    const issued = (await h.s.db('pki_certificates').where({ fingerprint: createHash('sha256').update(leaf.raw).digest('hex') }).first()) as Record<string, unknown>;
    expect(issued).toMatchObject({ tenant_id: h.tenantId, profile_id: profileId, state: 'valid', requested_by: null });
    const account = (await h.s.db('pki_acme_accounts').first()) as Record<string, unknown>;
    expect(issued.acme_account_id).toBe(account.id);
    expect(JSON.parse(String(account.contact))).toEqual([]);
    const order = (await h.s.db('pki_acme_orders').where({ certificate_id: issued.id }).first()) as Record<string, unknown>;
    expect(order.status).toBe('valid');
    const challenges = (await h.s.db('pki_acme_challenges').where({ status: 'valid' })) as Record<string, unknown>[];
    expect(challenges.map((c) => c.type)).toEqual(['http-01', 'http-01']);
    const actions = ((await h.s.db('audit_events').where('action', 'like', 'pki.acme.%').orderBy('seq')) as { action: string }[]).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['pki.acme.account.created', 'pki.acme.order.created', 'pki.acme.challenge.valid', 'pki.acme.order.finalized']));
    // The challenge answers were removed once the order was done; nonces are single use and stored.
    expect(await h.s.db('platform_acme_challenges').count({ n: '*' })).toEqual([{ n: 0 }]);

    const rev = await sys.post(`/api/admin/platform/certificates/${req.body.id}/revoke`, { reason: 'superseded' });
    expect(rev.status).toBe(200);
    const after = (await h.s.db('pki_certificates').where({ id: issued.id }).first()) as Record<string, unknown>;
    expect(after).toMatchObject({ state: 'revoked', revocation_reason: 4 });
  }, 60_000);

  it('B-1605: dns-01 proves a wildcard through a real DNS lookup', async () => {
    h.s.ops.certs.dns = dns.provider;
    try {
      const req = await sys.post('/api/admin/platform/certificates', { domains: ['*.acme.test', 'dns.acme.test'], use: 'TLS' });
      expect(req.status).toBe(202);
      const stop = runJobs();
      let row: Record<string, unknown>;
      try {
        row = await waitFor(async () => {
          const r = (await h.s.db('platform_certificates').where({ id: req.body.id }).first()) as Record<string, unknown>;
          if (r.state === 'failed') throw new Error(`issue failed: ${String(r.error)}`);
          return r.state === 'valid' ? r : null;
        });
      } finally {
        await stop();
      }
      const leaf = new X509Certificate(String(row.chain_pem).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)![0]);
      expect(leaf.subjectAltName).toBe('DNS:*.acme.test, DNS:dns.acme.test');
      expect(dns.queries).toEqual(expect.arrayContaining(['_acme-challenge.acme.test/16', '_acme-challenge.dns.acme.test/16']));
      const wild = (await h.s.db('pki_acme_authorizations').where({ identifier: 'acme.test', wildcard: true }).first()) as Record<string, unknown>;
      expect(wild.status).toBe('valid');
      // A wildcard is offered dns-01 only.
      expect(((await h.s.db('pki_acme_challenges').where({ authz_id: wild.id })) as { type: string }[]).map((c) => c.type)).toEqual(['dns-01']);
      expect(dns.txt.size).toBe(0); // the client cleaned up
    } finally {
      h.s.ops.certs.dns = null;
    }
  }, 60_000);

  it('B-1605: nonces, URLs, media types and signatures are checked; problems are RFC 8555 documents', async () => {
    const c = await RawAcme.open(directory);
    // A reused nonce is badNonce, with a fresh nonce to retry with.
    const nonce = await c.nonce();
    const first = await c.send(c.dir.newAccount!, c.body(c.dir.newAccount!, { termsOfServiceAgreed: true }, { nonce, jwk: true }));
    expect(first.status).toBe(201);
    c.kid = first.headers.get('location');
    expect(c.kid).toMatch(new RegExp(`^${base}/pki/acme/${slug}/acct/[0-9A-Z]{26}$`));
    const again = await c.send(c.dir.newAccount!, c.body(c.dir.newAccount!, { termsOfServiceAgreed: true }, { nonce, jwk: true }));
    expect(again.status).toBe(400);
    expect(again.headers.get('content-type')).toMatch(/application\/problem\+json/);
    expect(again.body.type).toBe('urn:ietf:params:acme:error:badNonce');
    expect(again.headers.get('replay-nonce')).toBeTruthy();
    // The same key finds its account (200); onlyReturnExisting with a new key does not create one.
    expect((await c.post(c.dir.newAccount!, { onlyReturnExisting: true }, { jwk: true })).status).toBe(200);
    const stranger = await RawAcme.open(directory);
    expect((await stranger.post(stranger.dir.newAccount!, { onlyReturnExisting: true }, { jwk: true })).body.type).toBe('urn:ietf:params:acme:error:accountDoesNotExist');
    // The JWS url must be the URL it was sent to; the body must be application/jose+json; the signature must verify.
    expect((await c.post(c.dir.newOrder!, { identifiers: [{ type: 'dns', value: 'x.acme.test' }] }, { headerUrl: c.dir.newAccount! })).body.type).toBe('urn:ietf:params:acme:error:unauthorized');
    expect((await c.send(c.dir.newOrder!, c.body(c.dir.newOrder!, {}, { nonce: await c.nonce() }), 'application/json')).status).toBe(415);
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    const forged = await c.send(c.dir.newOrder!, c.body(c.dir.newOrder!, { identifiers: [{ type: 'dns', value: 'x.acme.test' }] }, { nonce: await c.nonce(), key: other }));
    expect(forged.body.type).toBe('urn:ietf:params:acme:error:malformed');
    expect(forged.body.detail).toMatch(/signature/);
    // HS256 and none are not signature algorithms here.
    const hs = JSON.stringify({ protected: b64u(JSON.stringify({ alg: 'HS256', nonce: await c.nonce(), url: c.dir.newOrder, kid: c.kid })), payload: b64u('{}'), signature: b64u('x') });
    expect((await c.send(c.dir.newOrder!, hs)).body.type).toBe('urn:ietf:params:acme:error:badSignatureAlgorithm');
    // Names outside the profile are rejected identifiers, with a subproblem each; IP identifiers are unsupported.
    const out = await c.post(c.dir.newOrder!, { identifiers: [{ type: 'dns', value: 'ok.acme.test' }, { type: 'dns', value: 'www.example.org' }] });
    expect(out.status).toBe(400);
    expect(out.body.type).toBe('urn:ietf:params:acme:error:rejectedIdentifier');
    expect(out.body.subproblems).toEqual([expect.objectContaining({ type: 'urn:ietf:params:acme:error:rejectedIdentifier', identifier: { type: 'dns', value: 'www.example.org' } })]);
    expect((await c.post(c.dir.newOrder!, { identifiers: [{ type: 'ip', value: '10.0.0.1' }] })).body.type).toBe('urn:ietf:params:acme:error:unsupportedIdentifier');
    expect((await h.s.db('audit_events').where({ action: 'pki.acme.order.refused' })).length).toBe(2);
  });

  /** Places an order, answers http-01 for every authorization with the given content, and returns the order. */
  async function order(c: RawAcme, names: string[], answer?: (token: string) => string): Promise<{ url: string; body: Record<string, unknown> }> {
    const o = await c.post(c.dir.newOrder!, { identifiers: names.map((value) => ({ type: 'dns', value })) });
    expect(o.status).toBe(201);
    const url = o.headers.get('location')!;
    const stop = runJobs();
    try {
      for (const authzUrl of o.body.authorizations as string[]) {
        const a = await c.post(authzUrl, null);
        const ch = (a.body.challenges as { type: string; url: string; token: string }[]).find((x) => x.type === 'http-01')!;
        served.set(ch.token, answer ? answer(ch.token) : c.keyAuthorization(ch.token));
        const started = await c.post(ch.url, {});
        expect(started.body.status).toBe('processing');
        expect(started.headers.get('link')).toContain(`<${authzUrl}>;rel="up"`);
        await waitFor(async () => ((await c.post(authzUrl, null)).body.status !== 'pending' ? true : null));
      }
    } finally {
      await stop();
    }
    return { url, body: (await c.post(url, null)).body };
  }

  it('B-1605: RS256 and EdDSA accounts, a wrong http-01 answer, badCSR, finalize, download and key change', async () => {
    const rsa = await RawAcme.open(directory, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey, 'RS256');
    expect((await rsa.register({ contact: ['mailto:ops@acme.test'] })).status).toBe(201);
    const acct = await rsa.post(rsa.kid!, null);
    expect(acct.body).toMatchObject({ status: 'valid', contact: ['mailto:ops@acme.test'], orders: `${rsa.kid}/orders` });
    expect((await rsa.post(rsa.kid!, { contact: ['tel:+15550100'] })).body.type).toBe('urn:ietf:params:acme:error:unsupportedContact');

    // A wrong answer fails the challenge, the authorization and the order.
    const bad = await order(rsa, ['bad.acme.test'], () => 'not the key authorization');
    expect(bad.body.status).toBe('invalid');
    expect((bad.body.error as { type: string }).type).toBe('urn:ietf:params:acme:error:incorrectResponse');
    // A name that resolves to a cloud metadata address is never fetched.
    expect((await h.s.pki.acme['checkHttp01']('meta.acme.example', 'x', 'y'))?.detail).toMatch(/metadata/);

    const good = await order(rsa, ['rsa.acme.test']);
    expect(good.body.status).toBe('ready');
    const finalize = good.body.finalize as string;
    // The CSR must name exactly the order's identifiers, and not use the account key.
    const wrong = csrPem(['other.acme.test']);
    const badCsr = await rsa.post(finalize, { csr: b64u(Buffer.from(wrong.pem.replace(/-----[^-]+-----|\s/g, ''), 'base64')) });
    expect(badCsr.body.type).toBe('urn:ietf:params:acme:error:badCSR');
    const notReady = await rsa.post((bad.body.finalize as string), { csr: b64u(buildCsr(['bad.acme.test'], wrong.key)) });
    expect(notReady.body.type).toBe('urn:ietf:params:acme:error:orderNotReady');
    const certKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    const fin = await rsa.post(finalize, { csr: b64u(buildCsr(['rsa.acme.test'], certKey)) });
    expect(fin.status).toBe(200);
    expect(fin.body.status).toBe('valid');
    const pemChain = await rsa.post(fin.body.certificate as string, null);
    expect(pemChain.headers.get('content-type')).toMatch(/application\/pem-certificate-chain/);
    const leaf = new X509Certificate(pemChain.text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)![0]);
    expect(leaf.subjectAltName).toBe('DNS:rsa.acme.test');
    expect((await rsa.post(`${rsa.kid}/orders`, null)).body.orders).toEqual([good.url]);

    // Key change (RFC 8555 7.3.5): the inner JWS is signed by the new key and names the old one.
    const ed = generateKeyPairSync('ed25519').privateKey;
    const innerHeader = b64u(JSON.stringify({ alg: 'EdDSA', jwk: publicJwk(ed), url: rsa.dir.keyChange }));
    const innerPayload = b64u(JSON.stringify({ account: rsa.kid, oldKey: publicJwk(rsa.priv) }));
    const inner = { protected: innerHeader, payload: innerPayload, signature: jwsSign('EdDSA', ed, `${innerHeader}.${innerPayload}`) };
    const kc = await rsa.post(rsa.dir.keyChange!, inner);
    expect(kc.status).toBe(200);
    const oldKey = rsa.priv;
    rsa.priv = ed;
    rsa.alg = 'EdDSA';
    expect((await rsa.post(rsa.kid!, null)).status).toBe(200);
    const stale = await rsa.post(rsa.kid!, null, { key: oldKey, alg: 'RS256' });
    expect(stale.body.type).toBe('urn:ietf:params:acme:error:badSignatureAlgorithm');
    expect((await h.s.db('audit_events').where({ action: 'pki.acme.account.key-changed' })).length).toBe(1);

    // Revocation signed by the certificate's own key (jwk), then again: alreadyRevoked.
    const holder = new RawAcme(rsa.dir, certKey, 'ES256');
    const rev = await holder.post(rsa.dir.revokeCert!, { certificate: b64u(leaf.raw), reason: 1 }, { jwk: true });
    expect(rev.status).toBe(200);
    expect((await holder.post(rsa.dir.revokeCert!, { certificate: b64u(leaf.raw) }, { jwk: true })).body.type).toBe('urn:ietf:params:acme:error:alreadyRevoked');
    const stored = (await h.s.db('pki_certificates').where({ fingerprint: createHash('sha256').update(leaf.raw).digest('hex') }).first()) as Record<string, unknown>;
    expect(stored).toMatchObject({ state: 'revoked', revocation_reason: 1 });
    // Deactivating the account ends it.
    expect((await rsa.post(rsa.kid!, { status: 'deactivated' })).body.status).toBe('deactivated');
    expect((await rsa.post(rsa.kid!, null)).body.type).toBe('urn:ietf:params:acme:error:unauthorized');
  }, 60_000);

  it('B-1605: one tenant\'s account never reaches another tenant\'s directory, nor another account\'s orders', async () => {
    const other = await h.s.tenants.create({ slug: 'other', name: 'Other' });
    const oby: PkiActor = { tenantId: other.id, userId: null, actor: { service: 'test' } };
    await h.s.pki.createIntermediate(oby, other.id, { keyType: 'ecdsa-p256', days: 365 });
    const op = await h.s.pki.createProfile(oby, { name: 'acme', kind: 'server', maxDays: 30, defaultDays: 30, policy: { domains: ['*.acme.test'], allowWildcard: false, ipRanges: [], emailDomains: [], uriPrefixes: [], keyTypes: ['ec-p256'] } });
    await h.s.pki.acme.updateSettings(oby, { enabled: true, profileId: op.id });
    const otherDir = `${base}/pki/acme/other/directory`;

    const a = await RawAcme.open(directory);
    await a.register();
    const b = await RawAcme.open(otherDir);
    await b.register();
    const mine = await a.post(a.dir.newOrder!, { identifiers: [{ type: 'dns', value: 'iso.acme.test' }] });
    const orderUrl = mine.headers.get('location')!;
    const authzUrl = (mine.body.authorizations as string[])[0]!;

    // b's kid is an account of the other directory: refused at this one, whatever the URL.
    const viaA = new RawAcme(a.dir, b.priv);
    viaA.kid = b.kid;
    expect((await viaA.post(orderUrl, null)).body.type).toBe('urn:ietf:params:acme:error:accountDoesNotExist');
    expect((await viaA.post(a.dir.newOrder!, { identifiers: [{ type: 'dns', value: 'x.acme.test' }] })).body.type).toBe('urn:ietf:params:acme:error:accountDoesNotExist');
    // a's order under the other tenant's path: not found there.
    const crossUrl = orderUrl.replace(`/pki/acme/${slug}/`, '/pki/acme/other/');
    expect((await b.post(crossUrl, null)).status).toBe(404);
    // A second account of the same tenant cannot read or answer the first's order, authorization or challenge.
    const a2 = await RawAcme.open(directory);
    await a2.register();
    expect((await a2.post(orderUrl, null)).status).toBe(404);
    expect((await a2.post(authzUrl, null)).status).toBe(404);
    const ch = ((await a.post(authzUrl, null)).body.challenges as { url: string }[])[0]!;
    expect((await a2.post(ch.url, {})).status).toBe(404);
    expect((await a2.post(`${a.kid}/orders`, null)).body.type).toBe('urn:ietf:params:acme:error:unauthorized');
    // Nor revoke a certificate it neither ordered nor holds authorizations for.
    const issued = await h.s.db('pki_certificates').where({ tenant_id: h.tenantId, state: 'valid' }).whereNotNull('acme_account_id').first();
    const der = new X509Certificate(String(issued.certificate_pem)).raw;
    expect((await a2.post(a2.dir.revokeCert!, { certificate: b64u(der) })).body.type).toBe('urn:ietf:params:acme:error:unauthorized');
    expect((await b.post(b.dir.revokeCert!, { certificate: b64u(der) })).status).toBe(404);
    // The admin API is tenant-scoped too.
    const accounts = (await ta.get('/api/pki/acme/accounts')).body.accounts as { id: string }[];
    expect(accounts.some((x) => b.kid!.endsWith(x.id))).toBe(false);
    expect((await ta.get('/api/pki/acme/orders')).body.orders.length).toBeGreaterThan(0);
  });

  it('B-1605: external account binding when the tenant requires it; a key binds one account', async () => {
    const k = await ta.post('/api/pki/acme/eab-keys', { name: 'build server' });
    expect(k.status).toBe(201);
    expect(k.body.hmacKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(await h.s.db('pki_acme_eab_keys').where({ id: k.body.id }).first())).not.toContain(k.body.hmacKey);
    expect((await ta.get('/api/pki/acme/eab-keys')).body.keys[0]).not.toHaveProperty('hmacKey');
    await ta.put('/api/pki/acme', { eabRequired: true });
    expect(((await (await fetch(directory)).json()) as { meta: { externalAccountRequired: boolean } }).meta.externalAccountRequired).toBe(true);

    const plain = await RawAcme.open(directory);
    expect((await plain.register()).body.type).toBe('urn:ietf:params:acme:error:externalAccountRequired');
    // A wrong MAC is refused and audited.
    const forged = await RawAcme.open(directory);
    const bindingFor = (c: RawAcme, mac: Buffer) => {
      const p = b64u(JSON.stringify({ alg: 'HS256', kid: k.body.kid, url: c.dir.newAccount }));
      const pl = b64u(JSON.stringify(publicJwk(c.priv)));
      return { protected: p, payload: pl, signature: b64u(createHmac('sha256', mac).update(`${p}.${pl}`).digest()) };
    };
    expect((await forged.register({ externalAccountBinding: bindingFor(forged, randomBytes(32)) })).body.type).toBe('urn:ietf:params:acme:error:unauthorized');
    expect((await h.s.db('audit_events').where({ action: 'pki.acme.eab.refused' })).length).toBe(1);

    // Exprsn-AI's own client binds with the key (its B-904 support).
    const client = new HttpAcmeClient(directory, { pollMs: 20, eab: { kid: k.body.kid, hmacKey: k.body.hmacKey } });
    const kid = await client.register(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey, 'eab@acme.test');
    const bound = (await ta.get('/api/pki/acme/eab-keys')).body.keys.find((x: { id: string }) => x.id === k.body.id);
    expect(bound).toMatchObject({ state: 'bound' });
    expect(kid.endsWith(bound.accountId)).toBe(true);
    // The same key cannot bind a second account.
    const second = await RawAcme.open(directory);
    expect((await second.register({ externalAccountBinding: bindingFor(second, Buffer.from(k.body.hmacKey, 'base64url')) })).body.detail).toMatch(/already used or revoked/);
    await ta.put('/api/pki/acme', { eabRequired: false });
  });

  it('B-1605: an administrator revokes an account; its open orders end', async () => {
    const c = await RawAcme.open(directory);
    await c.register();
    const o = await c.post(c.dir.newOrder!, { identifiers: [{ type: 'dns', value: 'gone.acme.test' }] });
    const id = c.kid!.split('/').pop()!;
    expect((await ta.post(`/api/pki/acme/accounts/${id}/revoke`)).body.status).toBe('revoked');
    expect((await c.post(o.headers.get('location')!, null)).body.type).toBe('urn:ietf:params:acme:error:unauthorized');
    expect(((await h.s.db('pki_acme_orders').where({ account_id: id }).first()) as { status: string }).status).toBe('invalid');
  });

  // -------------------------------------------------------------------------------------------------------------

  it('B-1606: exports PEM, DER, chain and PKCS#12 (OpenSSL and node both open it)', async () => {
    const issue = await ta.post(`/api/pki/issuers/${(await h.s.pki.activeIntermediate(h.tenantId))!.id}/issue`, { csr: csrPem(['export.acme.test']).pem, profileId });
    expect(issue.status).toBe(201);
    const id = issue.body.id as string;
    const p = await ta.get(`/api/pki/certificates/${id}/export?format=pem`);
    expect(p.text).toBe(issue.body.certificatePem);
    const d = await ta.get(`/api/pki/certificates/${id}/export?format=der`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(d.headers['content-type']).toMatch(/application\/pkix-cert/);
    expect(new X509Certificate(d.body as Buffer).fingerprint256).toBe(new X509Certificate(issue.body.certificatePem).fingerprint256);
    const chain = await ta.get(`/api/pki/certificates/${id}/export?format=chain`);
    expect(chain.text.match(/BEGIN CERTIFICATE/g)).toHaveLength(3);
    expect((await ta.post(`/api/pki/certificates/${id}/pkcs12`, { password: 'short' })).status).toBe(400);
    const p12res = await ta.post(`/api/pki/certificates/${id}/pkcs12`, { password: 'correct horse' }).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(p12res.status).toBe(200);
    expect(p12res.headers['content-type']).toMatch(/application\/x-pkcs12/);
    const p12 = p12res.body as Buffer;
    if (hasOpenssl) {
      writeFileSync(path.join(work, 'cert.p12'), p12);
      const outText = opensslAll(['pkcs12', '-in', path.join(work, 'cert.p12'), '-passin', 'pass:correct horse', '-nokeys', '-info']);
      expect(outText).toMatch(/MAC: sha256/);
      expect(outText).toMatch(/PBES2, PBKDF2, AES-256-CBC/);
      expect(outText.match(/BEGIN CERTIFICATE/g)).toHaveLength(3);
      expect(() => openssl(['pkcs12', '-in', path.join(work, 'cert.p12'), '-passin', 'pass:wrong password', '-nokeys'])).toThrow();
    }

    // With a key made here: the PKCS#12 carries it, node's TLS stack loads it, and the key is never stored.
    const gen = await ta.post(`/api/pki/issuers/${(await h.s.pki.activeIntermediate(h.tenantId))!.id}/issue`, { profileId, sans: [{ type: 'dns', value: 'gen.acme.test' }], generateKey: { keyType: 'ec-p256', password: 'pkcs12 password' } });
    expect(gen.status).toBe(201);
    const bundle = Buffer.from(gen.body.pkcs12, 'base64');
    expect(() => createSecureContext({ pfx: bundle, passphrase: 'pkcs12 password' })).not.toThrow();
    expect(() => createSecureContext({ pfx: bundle, passphrase: 'not it' })).toThrow();
    if (hasOpenssl) {
      writeFileSync(path.join(work, 'gen.p12'), bundle);
      const outText = openssl(['pkcs12', '-in', path.join(work, 'gen.p12'), '-passin', 'pass:pkcs12 password', '-nodes']);
      expect(outText).toMatch(/BEGIN PRIVATE KEY/);
      expect(outText).toMatch(/friendlyName: gen\.acme\.test/);
    }
    const row = await h.s.db('pki_certificates').where({ id: gen.body.id }).first();
    expect(JSON.stringify(row)).not.toMatch(/PRIVATE KEY/);
    const ev = (await h.s.db('audit_events').where({ action: 'pki.certificate.issued' }).orderBy('seq', 'desc').first()) as { detail: string };
    expect(JSON.parse(ev.detail)).toMatchObject({ keyGenerated: true });
    expect((await ta.post(`/api/pki/issuers/${(await h.s.pki.activeIntermediate(h.tenantId))!.id}/issue`, { profileId, csr: csrPem(['x.acme.test']).pem, generateKey: { password: 'pkcs12 password' } })).status).toBe(400);
  }, 60_000);

  it('B-1606: the PKCS#12 MAC key derivation (RFC 7292 B.2) is what OpenSSL checks, for any password', () => {
    // Node's TLS stack (OpenSSL) verifies the MAC before it opens anything, so a wrong derivation fails to load.
    const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const der = selfSignedCertificate({ publicKey: kp.publicKey, privateKey: kp.privateKey, commonName: 'pkcs12 test', days: 1 });
    for (const [password, macIterations] of [['smeg', 1], ['pässwörd with spaces', 3], ['x'.repeat(100), 2048]] as const) {
      const p12 = buildPkcs12({ certificates: [der], privateKey: kp.privateKey, password, macIterations, iterations: 1000 });
      expect(() => createSecureContext({ pfx: p12, passphrase: password })).not.toThrow();
      expect(() => createSecureContext({ pfx: p12, passphrase: `${password}!` })).toThrow(/mac verify failure/);
    }
    expect(pkcs12Kdf('smeg', Buffer.from('0a58cf64530d823f', 'hex'), 3, 1, 40)).toHaveLength(40);
    expect(() => buildPkcs12({ certificates: [], password: 'x' })).toThrow();
  });

  it('B-1606: renewal keeps the names and key (or takes a new CSR) and can revoke the old certificate', async () => {
    const r = await ta.post(`/api/pki/issuers/${(await h.s.pki.activeIntermediate(h.tenantId))!.id}/issue`, { csr: csrPem(['renew.acme.test']).pem, profileId, days: 10 });
    const same = await ta.post(`/api/pki/certificates/${r.body.id}/renew`, {});
    expect(same.status).toBe(201);
    expect(same.body).toMatchObject({ renewedFrom: r.body.id, sans: [{ type: 'dns', value: 'renew.acme.test' }], revokedOld: false });
    expect(new X509Certificate(same.body.certificatePem).publicKey.export({ format: 'der', type: 'spki' })).toEqual(new X509Certificate(r.body.certificatePem).publicKey.export({ format: 'der', type: 'spki' }));
    expect(same.body.notAfter - Date.now()).toBeGreaterThan(29 * DAY); // the profile default, not the old 10 days
    const fresh = csrPem(['ignored.acme.test']);
    const rekey = await ta.post(`/api/pki/certificates/${same.body.id}/renew`, { csr: fresh.pem, revokeOld: true });
    expect(rekey.status).toBe(201);
    expect(rekey.body.sans).toEqual([{ type: 'dns', value: 'renew.acme.test' }]);
    expect(rekey.body.revokedOld).toBe(true);
    expect((await ta.get(`/api/pki/certificates/${same.body.id}`)).body).toMatchObject({ state: 'revoked', revocationReason: 'superseded' });
    expect((await ta.post(`/api/pki/certificates/${same.body.id}/renew`, {})).status).toBe(409);
    expect((await h.s.db('audit_events').where({ action: 'pki.certificate.renewed' })).length).toBe(2);
  });

  it('B-1606: a certificate 7 days from expiry notifies its owner, once; 30 days notifies too', async () => {
    const inter = (await h.s.pki.activeIntermediate(h.tenantId))!;
    const week = await ta.post(`/api/pki/issuers/${inter.id}/issue`, { csr: csrPem(['week.acme.test']).pem, profileId, days: 7 });
    const month = await ta.post(`/api/pki/issuers/${inter.id}/issue`, { csr: csrPem(['month.acme.test']).pem, profileId, days: 20 });
    const later = await ta.post(`/api/pki/issuers/${inter.id}/issue`, { csr: csrPem(['later.acme.test']).pem, profileId, days: 60 });
    // A renewed certificate is not nagged about.
    const renewed = await ta.post(`/api/pki/issuers/${inter.id}/issue`, { csr: csrPem(['renewed.acme.test']).pem, profileId, days: 5 });
    await ta.post(`/api/pki/certificates/${renewed.body.id}/renew`, {});
    await h.s.db('notifications').delete();

    const job = await h.s.jobs.enqueue({ tenantId: h.tenantId, type: 'pki.expiry', payload: {} });
    await h.s.jobs.runDue();
    expect((await h.s.jobs.get(h.tenantId, job.id))!.state).toBe('succeeded');
    const mine = async () => ((await h.s.db('notifications').where({ kind: 'pki.certificate.expiring' })) as { user_id: string; title: string }[]).filter((n) => /(week|month|later)\.acme\.test/.test(n.title));
    const notes = await mine();
    expect(notes.every((n) => n.user_id === ta.user.id)).toBe(true); // the owner: whoever requested it
    expect(notes.map((n) => n.title).sort()).toEqual(['Certificate month.acme.test expires in 20 days', 'Certificate week.acme.test expires in 7 days']);
    const notices = (await h.s.db('pki_expiry_notices')) as { certificate_id: string; threshold: number }[];
    expect(notices.find((x) => x.certificate_id === week.body.id)!.threshold).toBe(7);
    expect(notices.find((x) => x.certificate_id === month.body.id)!.threshold).toBe(30);
    expect(notices.some((x) => x.certificate_id === later.body.id || x.certificate_id === renewed.body.id)).toBe(false);
    // Certificates ordered over ACME (no requester) notify the tenant's certificate administrators.
    const acmeCert = (await h.s.db('pki_certificates').whereNotNull('acme_account_id').where({ state: 'valid' }).first()) as { id: string };
    expect(notices.some((x) => x.certificate_id === acmeCert.id)).toBe(true);

    // Again: nothing new. Two weeks on, the 20-day certificate crosses 7 days and notifies once more.
    expect((await h.s.pki.expirySweep()).notified).toBe(0);
    await h.s.pki.expirySweep(Date.now() + 14 * DAY);
    expect((await mine()).map((n) => n.title).sort()).toEqual(['Certificate month.acme.test expires in 20 days', 'Certificate month.acme.test expires in 6 days', 'Certificate week.acme.test expires in 7 days']);
    expect((await h.s.db('audit_events').where({ action: 'pki.certificate.expiry.notified' })).length).toBe((await h.s.db('pki_expiry_notices')).length);
  });

  // -------------------------------------------------------------------------------------------------------------

  it('B-1607: the CLI lists, issues, revokes and signs a CRL against the test database', async () => {
    let out = '';
    const write = (t: string) => void (out += t);
    const csrFile = path.join(work, 'cli.csr');
    writeFileSync(csrFile, csrPem(['cli.acme.test']).pem);
    const certFile = path.join(work, 'cli.pem');
    expect(await pkiCommand(h.s, ['issue', '--csr', csrFile, '--profile', 'acme', '--days', '5', '--out', certFile], write)).toBe(0);
    expect(out).toMatch(/^Issued [0-9A-Z]{26} \(serial [0-9a-f]+\)/);
    const leaf = new X509Certificate(readFileSync(certFile, 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)![0]);
    expect(leaf.subjectAltName).toBe('DNS:cli.acme.test');
    const serial = leaf.serialNumber.toLowerCase();

    out = '';
    expect(await pkiCommand(h.s, ['list', '--json', '--limit', '500'], write)).toBe(0);
    const listed = (JSON.parse(out) as { serial: string; state: string }[]).find((c) => c.serial === serial);
    expect(listed).toMatchObject({ state: 'valid' });
    out = '';
    expect(await pkiCommand(h.s, ['revoke', serial, '--reason', 'keyCompromise'], write)).toBe(0);
    expect(out).toMatch(/Revoked .* keyCompromise/);
    expect(await pkiCommand(h.s, ['revoke', serial], write)).toBe(3); // already revoked: a conflict
    out = '';
    const crlFile = path.join(work, 'cli.crl');
    expect(await pkiCommand(h.s, ['crl', '--out', crlFile, '--der'], write)).toBe(0);
    expect(out).toMatch(/^CRL \d+ for .*: \d+ revoked/);
    if (hasOpenssl) {
      writeFileSync(path.join(work, 'int.pem'), interPem);
      const text = openssl(['crl', '-inform', 'DER', '-in', crlFile, '-noout', '-text', '-CAfile', path.join(work, 'int.pem')]);
      expect(text.toUpperCase()).toContain(serial.toUpperCase());
    }
    out = '';
    expect(await pkiCommand(h.s, ['issue', '--csr', csrFile, '--profile', 'nope'], write)).toBe(1);
    expect(out).toMatch(/Unknown profile/);
    const outside = path.join(work, 'outside.csr');
    writeFileSync(outside, csrPem(['www.example.org']).pem);
    expect(await pkiCommand(h.s, ['issue', '--csr', outside, '--profile', 'acme'], write)).toBe(1);
    expect(await pkiCommand(h.s, ['frobnicate'], write)).toBe(64);
    const actors = ((await h.s.db('audit_events').whereIn('action', ['pki.certificate.issued', 'pki.certificate.revoked', 'pki.crl.requested']).orderBy('seq', 'desc').limit(3)) as { actor: string }[]).map((e) => JSON.parse(e.actor) as { service?: string });
    expect(actors.every((a) => a.service === 'cli')).toBe(true);
  });

  it('serves ACME problems for unknown directories and resources, and keeps unknown routes out', async () => {
    expect((await request(h.app).get('/pki/acme/nowhere/directory')).status).toBe(404);
    const c = await RawAcme.open(directory);
    await c.register();
    const r = await c.post(`${base}/pki/acme/${slug}/nothing-here`, null);
    expect(r.status).toBe(404);
    expect(r.body.type).toBe('urn:ietf:params:acme:error:malformed');
  });
});

describe('Sprint 25a: the ACME endpoints are rate-limited per address', () => {
  it('answers rateLimited (429, Retry-After) past PKI_ACME_RATE_PER_MINUTE writes', async () => {
    const h = await harness({ PKI_ACME_RATE_PER_MINUTE: '2' });
    try {
      const port = (loopbackServerFor(h.app)!.address() as AddressInfo).port;
      h.s.cfg.PKI_PUBLIC_URL = `http://127.0.0.1:${port}`;
      const by: PkiActor = { tenantId: h.tenantId, userId: null, actor: { service: 'test' } };
      const p = await h.s.pki.createProfile(by, { name: 'acme', kind: 'server', maxDays: 30, defaultDays: 30, policy: { domains: ['*.acme.test'], allowWildcard: false, ipRanges: [], emailDomains: [], uriPrefixes: [], keyTypes: ['ec-p256'] } });
      await h.s.pki.acme.updateSettings(by, { enabled: true, profileId: p.id });
      const slug = (await h.s.tenants.byId(h.tenantId))!.slug;
      const statuses: number[] = [];
      let last: Reply | undefined;
      for (let i = 0; i < 3; i++) {
        const c = await RawAcme.open(`http://127.0.0.1:${port}/pki/acme/${slug}/directory`);
        last = await c.register();
        statuses.push(last.status);
      }
      expect(statuses).toEqual([201, 201, 429]);
      expect(last!.body.type).toBe('urn:ietf:params:acme:error:rateLimited');
      expect(last!.headers.get('retry-after')).toBe('60');
      // Reading (nonces, the directory) is not a write.
      expect((await fetch(`http://127.0.0.1:${port}/pki/acme/${slug}/new-nonce`, { method: 'HEAD' })).status).toBe(200);
    } finally {
      await h.close();
    }
  });
});
