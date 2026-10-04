/*
 * Sprint 24: the certificate authority (B-1601 to B-1604). The issuer hierarchy with keys in the signer process or
 * OpenBao transit, profiles and CSR issuance, revocation with numbered CRLs, and the OCSP responder. Interop is
 * checked with OpenSSL when it is on PATH (`openssl x509`, `openssl crl`, `openssl ocsp`); every check also has a
 * pure-node path over the same bytes.
 */
import { createHash, generateKeyPairSync, randomBytes, verify, X509Certificate } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request, { type Test } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCsr } from '../src/ops/der.js';
import { children, expect as asn1Expect, int, nul, octets, oid, parse, readBits, readOid, seq, tagged } from '../src/pki/asn1.js';
import { pemOf, selfSignedCertificate } from '../src/federation/x509.js';
import { OCSP_OIDS } from '../src/pki/ocsp.js';
import { certificateParts, parseCsr, spkiKeyBits } from '../src/pki/x509.js';
import { startSigner } from '../src/signer/server.js';
import { FakeOpenBao } from './fake-openbao.js';
import { harness, localUser, loginAdmin, testConfig, type Harness } from './helpers.js';
import { loopbackServerFor } from './loopback.js';

const hasOpenssl = spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0;
// OpenSSL runs with a minimal configuration of its own (a toolchain's compiled-in default path may not exist).
const sslConf = path.join(mkdtempSync(path.join(tmpdir(), 'exprsn-ssl-')), 'openssl.cnf');
writeFileSync(sslConf, '[req]\ndistinguished_name = dn\n[dn]\n');
const sslEnv = { ...process.env, OPENSSL_CONF: sslConf };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function signerFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'exs-'));
  const socketPath = path.join(dir, 'run', 'signer.sock');
  const token = randomBytes(24).toString('base64url') + 'x'.repeat(8);
  const signer = await startSigner({ socketPath, key: randomBytes(32).toString('base64'), token });
  return { dir, socketPath, token, signer, close: async () => {
    await signer.close();
    rmSync(dir, { recursive: true, force: true });
  } };
}

async function admin(h: Harness, username: string, roles: string[]) {
  await localUser(h, username, roles, 'confidential');
  const c = await loginAdmin(h, username);
  return {
    ...c,
    get: (p: string) => c.agent.get(p),
    post: (p: string, b: object = {}) => c.agent.post(p).set('x-csrf-token', c.csrf).send(b),
    patch: (p: string, b: object = {}) => c.agent.patch(p).set('x-csrf-token', c.csrf).send(b),
    del: (p: string) => c.agent.delete(p).set('x-csrf-token', c.csrf)
  };
}

const drain = async (h: Harness, rounds = 6) => {
  for (let i = 0; i < rounds; i++) {
    await h.s.jobs.runDue();
    await sleep(10);
  }
};

const csrPem = (domains: string[]) => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const der = buildCsr(domains, privateKey);
  return { privateKey, pem: `-----BEGIN CERTIFICATE REQUEST-----\n${der.toString('base64').replace(/.{1,64}/g, '$&\n')}-----END CERTIFICATE REQUEST-----\n` };
};

const derOfPem = (p: string) => Buffer.from(p.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');

/** An OCSP request for one serial under an issuer certificate (SHA-1 CertID, as OpenSSL sends by default). */
function ocspRequest(issuerPem: string, serialHex: string, o: { hash?: 'sha1' | 'sha256'; nonce?: Buffer } = {}): Buffer {
  const hash = o.hash ?? 'sha1';
  const parts = certificateParts(derOfPem(issuerPem));
  const h = (b: Buffer) => createHash(hash).update(b).digest();
  const certId = seq(seq(oid(hash === 'sha1' ? OCSP_OIDS.sha1 : OCSP_OIDS.sha256), nul()), octets(h(parts.subject)), octets(h(spkiKeyBits(parts.spki))), int(Buffer.from(serialHex, 'hex')));
  const ext = o.nonce ? [tagged(2, true, seq(seq(oid(OCSP_OIDS.nonce), octets(octets(o.nonce)))))] : [];
  return seq(seq(seq(seq(certId)), ...ext));
}

interface ParsedOcsp {
  status: number;
  certStatus?: 'good' | 'revoked' | 'unknown';
  reason?: number | null;
  nonce?: Buffer | null;
  verified?: boolean;
  responder?: X509Certificate;
}

/** Parses an OCSPResponse and verifies its signature with the responder certificate it carries (pure node). */
function parseOcsp(der: Buffer): ParsedOcsp {
  const top = children(parse(der));
  const status = top[0]!.value[0]!;
  if (status !== 0) return { status };
  const rb = children(children(top[1]!)[0]!);
  expect(readOid(rb[0])).toBe(OCSP_OIDS.basic);
  const basic = children(parse(rb[1]!.value));
  const tbs = basic[0]!;
  const sig = readBits(basic[2]);
  const certs = children(children(basic[3]!)[0]!).map((c) => new X509Certificate(c.raw));
  const responder = certs[0]!;
  const verified = verify('sha256', tbs.raw, { key: responder.publicKey, dsaEncoding: 'der' }, sig);
  const rd = children(tbs);
  const single = children(children(rd[2]!)[0]!);
  const cs = single[1]!;
  const certStatus = cs.tag === 0x80 ? 'good' : cs.tag === 0xa1 ? 'revoked' : 'unknown';
  let reason: number | null = null;
  if (cs.tag === 0xa1) {
    const inner = children(cs);
    if (inner[1]) reason = children(inner[1])[0]!.value[0]!;
  }
  let nonce: Buffer | null = null;
  if (rd[3]?.tag === 0xa1) {
    for (const e of children(children(rd[3])[0]!)) {
      const p = children(e);
      if (readOid(p[0]) === OCSP_OIDS.nonce) nonce = parse(asn1Expect(p[p.length - 1], 0x04, 'value').value).value;
    }
  }
  return { status, certStatus, reason, nonce, verified, responder };
}

/** The serials (hex) and reason codes listed in a DER CRL, its number, and whether it verifies under `issuerPem`. */
function parseCrl(der: Buffer, issuerPem: string): { number: number; entries: { serial: string; reason: number | null }[]; verified: boolean } {
  const top = children(parse(der));
  const tbs = top[0]!;
  const f = children(tbs);
  const sig = readBits(top[2]);
  const verified = verify('sha256', tbs.raw, { key: new X509Certificate(issuerPem).publicKey, dsaEncoding: 'der' }, sig);
  const revoked = f[5]?.tag === 0x30 ? children(f[5]) : [];
  const entries = revoked.map((e) => {
    const p = children(e);
    let reason: number | null = null;
    if (p[2]) for (const x of children(p[2])) if (readOid(children(x)[0]) === '2.5.29.21') reason = parse(children(x)[1]!.value).value[0]!;
    return { serial: p[0]!.value.toString('hex').replace(/^00/, ''), reason };
  });
  const exts = f.find((x) => x.tag === 0xa0)!;
  let number = -1;
  for (const x of children(children(exts)[0]!)) {
    const p = children(x);
    if (readOid(p[0]) === '2.5.29.20') number = Number('0x' + parse(p[p.length - 1]!.value).value.toString('hex'));
  }
  return { number, entries, verified };
}

/** SuperTest buffers only text and JSON by default; CRLs, certificates and OCSP answers are bytes. */
const binary = (t: Test) =>
  t.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
const getBin = (h: Harness, p: string) => binary(request(h.app).get(p));
const ocspPost = (h: Harness, body: Buffer) => binary(request(h.app).post('/pki/ocsp').set('content-type', 'application/ocsp-request')).send(body);

const openssl = (args: string[], input?: string) => execFileSync('openssl', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], env: sslEnv });

// ---------------------------------------------------------------------------------------------------------------

describe('Sprint 24: the certificate authority with keys in the signer', () => {
  let f: Awaited<ReturnType<typeof signerFixture>>;
  let h: Harness;
  let sys: Awaited<ReturnType<typeof admin>>;
  let ta: Awaited<ReturnType<typeof admin>>;
  let root: { id: string; certificatePem: string };
  let inter: { id: string; certificatePem: string };
  let profileId: string;
  let leaf: { id: string; serial: string; certificatePem: string };
  let work: string;

  beforeAll(async () => {
    f = await signerFixture();
    h = await harness({ DATA_KEY: '', SIGNER_SOCKET: f.socketPath, SIGNER_TOKEN: f.token, PKI_PUBLIC_URL: 'http://ca.example.test' });
    sys = await admin(h, 'root', ['system-admin']);
    ta = await admin(h, 'ta', ['tenant-admin']);
    work = mkdtempSync(path.join(tmpdir(), 'exprsn-pki-'));
  }, 120_000);
  afterAll(async () => {
    await h.close();
    await f.close();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('B-1601: a root and a tenant intermediate are made and signed in the signer, with no private key in the app', async () => {
    expect((await ta.post('/api/pki/issuers', { kind: 'root', commonName: 'Not allowed' })).status).toBe(403);
    expect((await ta.post('/api/pki/issuers', { kind: 'intermediate' })).status).toBe(409); // no root yet
    const signsBefore = f.signer.served.sign ?? 0;
    const r = await sys.post('/api/pki/issuers', { kind: 'root', commonName: 'Exprsn Test Root', organization: 'Exprsn', keyType: 'ecdsa-p256', days: 3650 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ kind: 'root', custody: 'signer', state: 'active', keyType: 'ecdsa-p256' });
    root = r.body;
    expect((await sys.post('/api/pki/issuers', { kind: 'root', commonName: 'Second' })).status).toBe(409);

    const i = await ta.post('/api/pki/issuers', { kind: 'intermediate', keyType: 'rsa-3072', days: 1825 });
    expect(i.status).toBe(201);
    expect(i.body).toMatchObject({ kind: 'intermediate', parentId: root.id, custody: 'signer', keyType: 'rsa-3072', pathLen: 0 });
    inter = i.body;
    expect((await ta.post('/api/pki/issuers', { kind: 'intermediate' })).status).toBe(409); // one active per tenant
    expect(f.signer.served.sign! - signsBefore).toBeGreaterThanOrEqual(2);

    const rc = new X509Certificate(root.certificatePem);
    const ic = new X509Certificate(inter.certificatePem);
    expect(rc.ca).toBe(true);
    expect(rc.verify(rc.publicKey)).toBe(true);
    expect(ic.ca).toBe(true);
    expect(ic.verify(rc.publicKey)).toBe(true);
    expect(ic.checkIssued(rc)).toBe(true);
    expect(ic.subject).toContain('Issuing CA');
    expect((ic.publicKey.asymmetricKeyDetails ?? {}).modulusLength).toBe(3072);

    // What the app stores: a public key, a certificate and the signer's wrapped blob it cannot open — no private key.
    const rows = (await h.s.db('pki_issuers')) as Record<string, string>[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toMatch(/PRIVATE KEY/);
      expect(row.custody).toBe('signer');
      expect(row.key_wrapped).toBeTruthy();
      expect(() => h.s.keys).not.toThrow();
    }
    expect(h.s.kms.heldKeys).toBeTruthy();
    expect(h.s.cfg.DATA_KEY).toBeUndefined();

    if (hasOpenssl) {
      writeFileSync(path.join(work, 'root.pem'), root.certificatePem);
      writeFileSync(path.join(work, 'int.pem'), inter.certificatePem);
      const text = openssl(['x509', '-in', path.join(work, 'int.pem'), '-noout', '-text']);
      expect(text).toMatch(/CA:TRUE, pathlen:0/);
      expect(text).toMatch(/Certificate Sign, CRL Sign/);
      expect(text).toContain(`http://ca.example.test/pki/crl/${root.id}.crl`);
      expect(openssl(['verify', '-CAfile', path.join(work, 'root.pem'), path.join(work, 'int.pem')])).toMatch(/OK/);
    }
    const events = (await h.s.db('audit_events').whereIn('action', ['pki.root.created', 'pki.intermediate.created'])) as unknown[];
    expect(events).toHaveLength(2);
  });

  it('B-1601: the issuer list and detail show the chain and URLs; another tenant cannot touch the intermediate', async () => {
    const list = await ta.get('/api/pki/issuers');
    expect(list.status).toBe(200);
    expect(list.body.issuers.map((x: { id: string }) => x.id).sort()).toEqual([root.id, inter.id].sort());
    const d = await ta.get(`/api/pki/issuers/${inter.id}`);
    expect(d.body.chain).toHaveLength(2);
    expect(d.body.urls).toEqual({ crl: `http://ca.example.test/pki/crl/${inter.id}.crl`, certificate: `http://ca.example.test/pki/ca/${inter.id}.crt`, ocsp: 'http://ca.example.test/pki/ocsp' });
    expect((await ta.post(`/api/pki/issuers/${root.id}/rotate`, {})).status).toBe(403);
    const pub = await getBin(h, `/pki/ca/${inter.id}.crt`);
    expect(pub.status).toBe(200);
    expect(pub.headers['content-type']).toMatch(/application\/pkix-cert/);
    expect(new X509Certificate(pub.body as Buffer).fingerprint256).toBe(new X509Certificate(inter.certificatePem).fingerprint256);
  });

  it('B-1602: a CSR within the profile is issued; a host outside policy, a long lifetime or a wrong key type is refused', async () => {
    expect((await ta.post('/api/pki/profiles', { name: 'too-long', kind: 'server', maxDays: 800 })).status).toBe(422);
    const p = await ta.post('/api/pki/profiles', { name: 'web', kind: 'server', maxDays: 90, defaultDays: 30, policy: { domains: ['*.example.test', 'example.test'], ipRanges: ['10.0.0.0/8'], keyTypes: ['ec-p256'] } });
    expect(p.status).toBe(201);
    profileId = p.body.id;

    const good = csrPem(['www.example.test', 'example.test']);
    const r = await ta.post(`/api/pki/issuers/${inter.id}/issue`, { csr: good.pem, profileId });
    expect(r.status).toBe(201);
    leaf = r.body;
    expect(r.body).toMatchObject({ commonName: 'www.example.test', state: 'valid', keyType: 'ec-p256', clamped: false });
    expect(r.body.chainPem).toHaveLength(2);
    const lc = new X509Certificate(r.body.certificatePem);
    expect(lc.verify(new X509Certificate(inter.certificatePem).publicKey)).toBe(true);
    expect(lc.subjectAltName).toBe('DNS:www.example.test, DNS:example.test');
    expect(lc.ca).toBe(false);
    expect(lc.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1']);
    expect(lc.serialNumber.toLowerCase()).toBe(r.body.serial);
    const days = (Date.parse(lc.validTo) - Date.parse(lc.validFrom)) / 86_400_000;
    expect(Math.round(days)).toBe(30);

    // A host outside policy is refused and audited.
    const bad = await ta.post(`/api/pki/issuers/${inter.id}/issue`, { csr: csrPem(['www.example.test', 'evil.other.test']).pem, profileId });
    expect(bad.status).toBe(422);
    expect(bad.body.detail).toMatch(/evil\.other\.test is outside/);
    expect(bad.body.name).toEqual({ type: 'dns', value: 'evil.other.test' });
    expect(await h.s.db('audit_events').where({ action: 'pki.issue.refused' }).first()).toBeTruthy();
    // So is an override naming one, an address outside the ranges, a wildcard, and too long a lifetime.
    expect((await ta.post(`/api/pki/issuers/${inter.id}/issue`, { csr: good.pem, profileId, sans: [{ type: 'dns', value: 'example.org' }] })).status).toBe(422);
    expect((await ta.post(`/api/pki/issuers/${inter.id}/issue`, { csr: good.pem, profileId, sans: [{ type: 'dns', value: 'www.example.test' }, { type: 'ip', value: '192.168.1.1' }] })).status).toBe(422);
    expect((await ta.post(`/api/pki/issuers/${inter.id}/issue`, { csr: csrPem(['*.example.test']).pem, profileId })).status).toBe(422);
    const ok = await ta.post(`/api/pki/issuers/${inter.id}/issue`, { csr: good.pem, profileId, sans: [{ type: 'dns', value: 'www.example.test' }, { type: 'ip', value: '10.1.2.3' }] });
    expect(ok.status).toBe(201);
    expect(new X509Certificate(ok.body.certificatePem).subjectAltName).toBe('DNS:www.example.test, IP Address:10.1.2.3');
    const long = await ta.post(`/api/pki/issuers/${inter.id}/issue`, { csr: good.pem, profileId, days: 91 });
    expect(long.status).toBe(422);
    expect(long.body.step).toBe('lifetime');
    // A tampered request does not verify.
    const der = derOfPem(good.pem);
    der[40] = der[40]! ^ 0xff;
    const tampered = `-----BEGIN CERTIFICATE REQUEST-----\n${der.toString('base64')}\n-----END CERTIFICATE REQUEST-----\n`;
    expect((await ta.post(`/api/pki/issuers/${inter.id}/issue`, { csr: tampered, profileId })).status).toBe(400);
    // The root does not issue end-entity certificates, and nor does another tenant's issuer.
    expect((await ta.post(`/api/pki/issuers/${root.id}/issue`, { csr: good.pem, profileId })).status).toBe(404);

    if (hasOpenssl) {
      // An RSA key from OpenSSL is not among this profile's key types; a client profile that allows it issues.
      const key = path.join(work, 'rsa.key');
      const csr = openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-subj', '/CN=svc-a', '-addext', 'subjectAltName=URI:spiffe://example.test/svc-a']);
      expect(parseCsr(derOfPem(csr)).keyType).toBe('rsa-2048');
      expect((await ta.post(`/api/pki/issuers/${inter.id}/issue`, { csr, profileId })).status).toBe(422);
      const cp = await ta.post('/api/pki/profiles', { name: 'mtls', kind: 'client', maxDays: 30, policy: { uriPrefixes: ['spiffe://example.test/'], keyTypes: ['rsa-2048'] } });
      const c = await ta.post(`/api/pki/issuers/${inter.id}/issue`, { csr, profileId: cp.body.id });
      expect(c.status).toBe(201);
      writeFileSync(path.join(work, 'client.pem'), c.body.certificatePem);
      const text = openssl(['x509', '-in', path.join(work, 'client.pem'), '-noout', '-text']);
      expect(text).toMatch(/TLS Web Client Authentication/);
      expect(text).toMatch(/Digital Signature, Key Encipherment/);
      expect(text).toContain('URI:spiffe://example.test/svc-a');
      expect(text).toContain(`OCSP - URI:http://ca.example.test/pki/ocsp`);
      writeFileSync(path.join(work, 'chain.pem'), root.certificatePem + inter.certificatePem);
      expect(openssl(['verify', '-CAfile', path.join(work, 'root.pem'), '-untrusted', path.join(work, 'int.pem'), path.join(work, 'client.pem')])).toMatch(/OK/);
    }
  });

  it('B-1603: a revoked certificate appears in the next numbered CRL, served publicly', async () => {
    const first = await getBin(h, `/pki/crl/${inter.id}.crl`);
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toMatch(/application\/pkix-crl/);
    const c1 = parseCrl(first.body as Buffer, inter.certificatePem);
    expect(c1.verified).toBe(true);
    expect(c1.entries).toEqual([]);

    expect((await ta.post(`/api/pki/certificates/${leaf.id}/revoke`, { reason: 'removeFromCRL' })).status).toBe(400);
    const rv = await ta.post(`/api/pki/certificates/${leaf.id}/revoke`, { reason: 'keyCompromise' });
    expect(rv.status).toBe(200);
    expect(rv.body).toMatchObject({ state: 'revoked', revocationReason: 'keyCompromise' });
    expect((await ta.post(`/api/pki/certificates/${leaf.id}/revoke`, {})).status).toBe(409);
    await drain(h);
    const crls = await ta.get(`/api/pki/issuers/${inter.id}/crls`);
    expect(crls.body.crls[0]).toMatchObject({ number: c1.number + 1, entries: 1 });

    const next = await getBin(h, `/pki/crl/${inter.id}.crl`);
    const c2 = parseCrl(next.body as Buffer, inter.certificatePem);
    expect(c2.verified).toBe(true);
    expect(c2.number).toBe(c1.number + 1);
    expect(c2.entries).toEqual([{ serial: leaf.serial, reason: 1 }]);
    const pemCrl = await getBin(h, `/pki/crl/${inter.id}.pem`);
    expect((pemCrl.body as Buffer).toString()).toMatch(/^-----BEGIN X509 CRL-----/);
    expect((await request(h.app).get('/pki/crl/01ARZ3NDEKTSV4RRFFQ69G5FAV.crl')).status).toBe(404);

    if (hasOpenssl) {
      writeFileSync(path.join(work, 'int.crl'), (pemCrl.body as Buffer).toString());
      const text = openssl(['crl', '-in', path.join(work, 'int.crl'), '-noout', '-text']);
      expect(text).toMatch(new RegExp(`CRL Number:\\s+${c2.number}\\b`));
      expect(text.toUpperCase()).toContain(leaf.serial.toUpperCase());
      expect(text).toMatch(/Key Compromise/);
      const v = spawnSync('openssl', ['crl', '-in', path.join(work, 'int.crl'), '-noout', '-CAfile', path.join(work, 'int.pem')], { encoding: 'utf8', env: sslEnv });
      expect(`${v.stdout}${v.stderr}`).toMatch(/verify OK/);
    }
    expect(await h.s.db('audit_events').where({ action: 'pki.certificate.revoked' }).first()).toBeTruthy();
  });

  it('B-1604: OCSP answers good, then revoked, by POST and GET, signed by a delegated responder', async () => {
    const fresh = await ta.post(`/api/pki/issuers/${inter.id}/issue`, { csr: csrPem(['api.example.test']).pem, profileId });
    expect(fresh.status).toBe(201);
    const nonce = randomBytes(16);
    const res = await ocspPost(h, ocspRequest(inter.certificatePem, fresh.body.serial, { nonce }));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/ocsp-response/);
    const good = parseOcsp(res.body as Buffer);
    expect(good).toMatchObject({ status: 0, certStatus: 'good', verified: true });
    expect(good.nonce!.equals(nonce)).toBe(true);
    // The responder is a delegated signer: issued by the intermediate for OCSP signing only.
    expect(good.responder!.verify(new X509Certificate(inter.certificatePem).publicKey)).toBe(true);
    expect(good.responder!.keyUsage).toEqual(['1.3.6.1.5.5.7.3.9']);
    expect((await h.s.db('pki_responders').where({ issuer_id: inter.id })).length).toBe(1);

    // GET without a nonce is cacheable; the revoked leaf from B-1603 answers revoked with its reason.
    const b64 = ocspRequest(inter.certificatePem, leaf.serial, { hash: 'sha256' }).toString('base64');
    const get = await getBin(h, `/pki/ocsp/${encodeURIComponent(b64)}`);
    expect(get.status).toBe(200);
    expect(get.headers['cache-control']).toMatch(/max-age=\d+/);
    expect(parseOcsp(get.body as Buffer)).toMatchObject({ status: 0, certStatus: 'revoked', reason: 1, verified: true });

    // A cached good answer turns revoked as soon as the certificate is revoked (the cache is dropped through the bus).
    const getFresh = () => getBin(h, `/pki/ocsp/${encodeURIComponent(ocspRequest(inter.certificatePem, fresh.body.serial).toString('base64'))}`);
    expect(parseOcsp((await getFresh()).body as Buffer).certStatus).toBe('good');
    expect(h.s.pki.ocspCacheSize).toBeGreaterThan(0);
    expect((await ta.post(`/api/pki/certificates/${fresh.body.id}/revoke`, { reason: 'superseded' })).status).toBe(200);
    await sleep(20);
    expect(parseOcsp((await getFresh()).body as Buffer)).toMatchObject({ certStatus: 'revoked', reason: 4 });

    // Unknown serials, unknown issuers and garbage.
    expect(parseOcsp((await ocspPost(h, ocspRequest(inter.certificatePem, '7f00112233'))).body as Buffer).certStatus).toBe('unknown');
    expect(parseOcsp((await ocspPost(h, ocspRequest(strangerPem(), 'aa'))).body as Buffer).status).toBe(6);
    expect(parseOcsp((await ocspPost(h, Buffer.from('nonsense'))).body as Buffer).status).toBe(1);
    // The root's responder answers for the intermediate.
    expect(parseOcsp((await ocspPost(h, ocspRequest(root.certificatePem, (inter as unknown as { serial: string }).serial))).body as Buffer)).toMatchObject({ certStatus: 'good', verified: true });
  });

  it.skipIf(!hasOpenssl)('B-1604: openssl ocsp reports good, then revoked', async () => {
    const key = path.join(work, 'leaf.key');
    const csr = openssl(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', key, '-subj', '/CN=ocsp.example.test']);
    const c = await ta.post(`/api/pki/issuers/${inter.id}/issue`, { csr, profileId });
    expect(c.status).toBe(201);
    writeFileSync(path.join(work, 'leaf.pem'), c.body.certificatePem);
    const port = (loopbackServerFor(h.app)!.address() as AddressInfo).port;
    // openssl runs as a child process without blocking this one, which also serves the app.
    const run = () =>
      new Promise<string>((resolve) => {
        const p = spawn('openssl', ['ocsp', '-issuer', path.join(work, 'int.pem'), '-cert', path.join(work, 'leaf.pem'), '-url', `http://127.0.0.1:${port}/pki/ocsp`, '-CAfile', path.join(work, 'root.pem'), '-timeout', '10'], { env: sslEnv });
        let out = '';
        p.stdout.on('data', (d) => (out += String(d)));
        p.stderr.on('data', (d) => (out += String(d)));
        p.on('close', () => resolve(out));
      });
    const before = await run();
    expect(before).toMatch(/Response verify OK/);
    expect(before).toMatch(/leaf\.pem: good/);
    expect((await ta.post(`/api/pki/certificates/${c.body.id}/revoke`, { reason: 'cessationOfOperation' })).status).toBe(200);
    await sleep(20);
    const after = await run();
    expect(after).toMatch(/Response verify OK/);
    expect(after).toMatch(/leaf\.pem: revoked/);
    expect(after).toMatch(/Reason: cessationOfOperation/);
  });

  it('B-1601: rotation retires the old intermediate (which still serves its CRL); re-issue keeps the key', async () => {
    const before = new X509Certificate(inter.certificatePem);
    const re = await ta.post(`/api/pki/issuers/${inter.id}/reissue`, { days: 400 });
    expect(re.status).toBe(200);
    const after = new X509Certificate(re.body.certificatePem);
    expect(after.serialNumber).not.toBe(before.serialNumber);
    expect(after.publicKey.export({ type: 'spki', format: 'der' }).equals(before.publicKey.export({ type: 'spki', format: 'der' }))).toBe(true);
    // Certificates issued before still verify under the re-issued intermediate.
    expect(new X509Certificate(leaf.certificatePem).verify(after.publicKey)).toBe(true);

    const rot = await ta.post(`/api/pki/issuers/${inter.id}/rotate`, {});
    expect(rot.status).toBe(201);
    expect(rot.body).toMatchObject({ generation: 2, state: 'active', parentId: root.id });
    const old = await ta.get(`/api/pki/issuers/${inter.id}`);
    expect(old.body).toMatchObject({ state: 'retired', replacedBy: rot.body.id });
    expect((await ta.post(`/api/pki/issuers/${inter.id}/issue`, { csr: csrPem(['www.example.test']).pem, profileId })).status).toBe(409);
    expect((await getBin(h, `/pki/crl/${inter.id}.crl`)).status).toBe(200);
    const issued = await ta.post(`/api/pki/issuers/${rot.body.id}/issue`, { csr: csrPem(['www.example.test']).pem, profileId });
    expect(issued.status).toBe(201);
    expect(new X509Certificate(issued.body.certificatePem).verify(new X509Certificate(rot.body.certificatePem).publicKey)).toBe(true);

    // Revoking an intermediate puts it on the root's CRL.
    const rv = await ta.post(`/api/pki/issuers/${inter.id}/revoke`, { reason: 'superseded' });
    expect(rv.status).toBe(200);
    await drain(h);
    const crl = parseCrl((await getBin(h, `/pki/crl/${root.id}.crl`)).body as Buffer, root.certificatePem);
    expect(crl.entries.map((e) => e.serial)).toContain(re.body.serial);
  });

  it('runs the scheduled CRL job for every live issuer', async () => {
    const count = async () => Number(((await h.s.db('pki_crls').count({ n: '*' }).first()) as { n: number | string }).n);
    const before = await count();
    const rows = (await h.s.db('pki_issuers').whereIn('state', ['active', 'retired'])) as { id: string }[];
    for (const r of rows) await h.s.jobs.enqueue({ tenantId: h.tenantId, type: 'pki.crl', payload: { issuerId: r.id } });
    await drain(h);
    expect(await count()).toBe(before + rows.length);
  });
});

/** A self-signed certificate the CA did not issue (for the unauthorized OCSP case). */
function strangerPem(): string {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return pemOf(selfSignedCertificate({ publicKey, privateKey, commonName: 'Stranger', days: 1 }));
}

describe('Sprint 24: the CA with OpenBao transit, without custody, and the public rate limit', () => {
  const bao = new FakeOpenBao();
  let h: Harness;

  beforeAll(async () => {
    await bao.start();
    h = await harness({ KMS_PROVIDER: 'openbao', OPENBAO_ADDR: bao.url, OPENBAO_TOKEN: bao.token, PKI_PUBLIC_RATE_PER_MINUTE: '5' });
  }, 60_000);
  afterAll(async () => {
    await h.close();
    await bao.stop();
  });

  it('B-1601: an RSA 3072 root and a P-256 intermediate sign in transit; issued certificates verify', async () => {
    const sys = await admin(h, 'root', ['system-admin']);
    const r = await sys.post('/api/pki/issuers', { kind: 'root', commonName: 'Bao Root', keyType: 'rsa-3072' });
    expect(r.status).toBe(201);
    expect(r.body.custody).toBe('openbao');
    const i = await sys.post('/api/pki/issuers', { kind: 'intermediate', keyType: 'ecdsa-p256' });
    expect(i.status).toBe(201);
    expect(bao.signed).toEqual(expect.arrayContaining([expect.stringMatching(/pki-/)]));
    const ic = new X509Certificate(i.body.certificatePem);
    expect(ic.verify(new X509Certificate(r.body.certificatePem).publicKey)).toBe(true);
    const row = (await h.s.db('pki_issuers').where({ id: i.body.id }).first()) as Record<string, unknown>;
    expect(row.key_wrapped).toBeNull();
    expect(String(row.key_name)).toMatch(/pki-/);
    const p = await sys.post('/api/pki/profiles', { name: 'web', kind: 'server', maxDays: 30, policy: { domains: ['*.bao.test'] } });
    const c = await sys.post(`/api/pki/issuers/${i.body.id}/issue`, { csr: csrPem(['a.bao.test']).pem, profileId: p.body.id });
    expect(c.status).toBe(201);
    expect(new X509Certificate(c.body.certificatePem).verify(ic.publicKey)).toBe(true);
    const crl = await getBin(h, `/pki/crl/${r.body.id}.crl`);
    expect(parseCrl(crl.body as Buffer, r.body.certificatePem).verified).toBe(true);
  });

  it('public routes are rate-limited per address', async () => {
    const codes: number[] = [];
    for (let n = 0; n < 7; n++) codes.push((await request(h.app).get('/pki/crl/01ARZ3NDEKTSV4RRFFQ69G5FAV.crl')).status);
    expect(codes).toContain(429);
  });

  it('without the signer or OpenBao the CA refuses to make keys', async () => {
    const plain = await harness();
    try {
      const sys = await admin(plain, 'root', ['system-admin']);
      const r = await sys.post('/api/pki/issuers', { kind: 'root', commonName: 'Nope' });
      expect(r.status).toBe(409);
      expect(r.body.detail).toMatch(/never holds a private key/);
      expect((await sys.get('/api/pki')).body.custody).toBe('unavailable');
    } finally {
      await plain.close();
    }
  });

  it('settings: CRL validity must outlast the CRL schedule', () => {
    expect(() => testConfig({ PKI_CRL_MINUTES: '120', PKI_CRL_VALIDITY_HOURS: '1' })).toThrow(/PKI_CRL_VALIDITY_HOURS/);
    expect(testConfig({ PKI_CRL_MINUTES: '30', PKI_CRL_VALIDITY_HOURS: '1' }).PKI_CRL_MINUTES).toBe(30);
  });
});

