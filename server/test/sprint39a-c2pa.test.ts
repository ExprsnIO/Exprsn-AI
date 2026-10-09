/*
 * 1.6.0, Sprint 39a (B-7901): C2PA content credentials on generated images. The manifest store, its CBOR and JUMBF,
 * the COSE signature and the verifier are exercised on their own with local keys, then through an image job with the
 * tenant CA's keys in the signer process: the stored PNG carries a manifest the tenant's certificate signed, the
 * verifier reads it back and binds it to the bytes, the HMAC manifest still verifies, a revoked content-credentials
 * certificate is replaced, and a tenant with no issuing CA gets an image without a manifest and a reason.
 */
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign, X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cborDecode, cborEncode, derToRaw, hashWithExclusions, locateChunk, rawToDer, readPng, signPng, verifyPng, withoutManifest, type GenerationInfo } from '../src/images/c2pa.js';
import { encodePng, readText } from '../src/images/png.js';
import { buildCertificate, distinguishedName, KU, newSerial, OIDS, spkiOf } from '../src/pki/x509.js';
import { fromPem } from '../src/pki/asn1.js';
import { startSigner } from '../src/signer/server.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';
import { FakeImageBackend, FakeSafety, harness8 } from './sprint8-fakes.js';

const binary = (t: request.Test) => t.buffer().parse((res, cb) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});

const info: GenerationInfo = {
  job: '01TESTJOB0000000000000000A',
  tenant: '01TENANT000000000000000000',
  tenantName: 'Northwind',
  workspace: null,
  user: '01USER0000000000000000000A',
  username: 'mem',
  model: 'sdxl-base',
  profile: null,
  backend: 'fake-sdxl',
  seed: 7,
  steps: 4,
  width: 4,
  height: 4,
  promptSha256: 'ab'.repeat(32),
  label: 'internal',
  createdAt: '2026-10-09T12:00:00.000Z',
  generator: 'Exprsn-AI/1.6.0'
};

/** A root and a leaf made with node keys, signed the way the signer signs (ES256). */
async function localChain() {
  const rootKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const leafKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const sig = (key: typeof rootKey.privateKey) => async (tbs: Buffer) => cryptoSign('sha256', tbs, { key, dsaEncoding: 'der' });
  const now = Date.now();
  const rootSpki = spkiOf(rootKey.publicKey);
  const rootName = distinguishedName('Test Root', 'Exprsn');
  const root = await buildCertificate({ serial: newSerial(), issuerName: rootName, subjectName: rootName, spki: rootSpki, issuerSpki: rootSpki, notBefore: now - 60_000, notAfter: now + 86_400_000, keyType: 'ecdsa-p256', ca: { pathLen: null }, keyUsage: KU.keyCertSign | KU.cRLSign }, sig(rootKey.privateKey));
  const leaf = await buildCertificate({ serial: newSerial(), issuerName: rootName, subjectName: distinguishedName('Content credentials', 'Exprsn'), spki: spkiOf(leafKey.publicKey), issuerSpki: rootSpki, notBefore: now - 60_000, notAfter: now + 86_400_000, keyType: 'ecdsa-p256', keyUsage: KU.digitalSignature, extKeyUsage: ['1.3.6.1.5.5.7.3.36', OIDS.codeSigning] }, sig(rootKey.privateKey));
  return { root, leaf, signer: { chain: [leaf, root], sign: async (data: Buffer) => derToRaw(cryptoSign('sha256', data, { key: leafKey.privateKey, dsaEncoding: 'der' })) } };
}

const samplePng = () => encodePng(4, 4, Buffer.from(Array.from({ length: 48 }, (_, i) => (i * 37) & 0xff)));

describe('B-7901: the C2PA pieces', () => {
  it('encodes and decodes CBOR deterministically (sorted map keys, negative integers, byte and text strings)', () => {
    const v = { b: 1, a: [-1, -256, 'x', Buffer.from([1, 2]), true, null], 'zz': 70000, c: { nested: 'yes' } };
    const bytes = cborEncode(v);
    expect(cborDecode(bytes)).toEqual({ a: [-1, -256, 'x', Buffer.from([1, 2]), true, null], b: 1, c: { nested: 'yes' }, zz: 70000 });
    // Shorter keys first, then bytewise: "a", "b", "c", "zz".
    expect(bytes.subarray(0, 3).toString('hex')).toBe('a46161');
    const m = new Map<number | string, number>([[33, 2], [1, -7]]);
    expect(cborEncode(m).toString('hex')).toBe('a20126182102');
    expect(cborDecode(cborEncode(m))).toEqual(new Map([[1, -7], [33, 2]]));
    expect(() => cborDecode(Buffer.from('ff', 'hex'))).toThrow();
  });

  it('converts ECDSA signatures between DER and the raw r || s form', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const der = cryptoSign('sha256', Buffer.from('hello'), { key: privateKey, dsaEncoding: 'der' });
    const raw = derToRaw(der);
    expect(raw).toHaveLength(64);
    expect(rawToDer(raw).equals(der)).toBe(true);
  });

  it('signs a PNG with a manifest the verifier reads back, binds to the bytes and chains to the anchor', async () => {
    const { root, leaf, signer } = await localChain();
    const png = samplePng();
    const out = await signPng(png, info, signer);
    expect(out.label).toMatch(/^urn:uuid:/);
    const { existing } = locateChunk(out.png);
    expect(existing).not.toBeNull();
    expect(withoutManifest(out.png).equals(png)).toBe(true);

    const read = readPng(out.png)!;
    expect(read.claim['dc:format']).toBe('image/png');
    expect(read.assertions.map((a) => a.label)).toEqual(['c2pa.actions', 'c2pa.hash.data', 'io.exprsn.generation']);
    expect(read.signature.chain).toHaveLength(2);
    expect(new X509Certificate(read.signature.chain[0]!).fingerprint256).toBe(new X509Certificate(leaf).fingerprint256);

    const v = verifyPng(out.png, { anchors: [root] });
    expect(v).toMatchObject({ present: true, verified: true, checks: { claimHashes: true, dataHash: true, signature: true, chain: true, anchor: true, certificateValid: true }, problems: [] });
    expect(v.manifest).toMatchObject({ generator: 'Exprsn-AI/1.6.0', created: info.createdAt, action: 'c2pa.created', model: 'sdxl-base', tenant: info.tenant, tenantName: 'Northwind', job: info.job });
    expect(v.signer).toMatchObject({ subject: expect.stringContaining('Content credentials') });
    // The data hash excludes exactly the manifest chunk.
    expect(hashWithExclusions(out.png, [existing!]).equals(createHash('sha256').update(png).digest())).toBe(true);
    // Without anchors the chain is still checked internally; with the wrong anchor it is not trusted.
    expect(verifyPng(out.png).checks.anchor).toBeNull();
    const { root: other } = await localChain();
    expect(verifyPng(out.png, { anchors: [other] })).toMatchObject({ verified: false, checks: { anchor: false } });
  });

  it('notices a changed pixel, a changed claim and a missing manifest', async () => {
    const { root, signer } = await localChain();
    const out = await signPng(samplePng(), info, signer);
    const pixel = Buffer.from(out.png);
    pixel[40]! ^= 0x01; // inside IDAT
    expect(verifyPng(pixel, { anchors: [root] })).toMatchObject({ verified: false, checks: { dataHash: false, signature: true } });

    const { existing } = locateChunk(out.png);
    const claimAt = out.png.indexOf(Buffer.from('dc:format'), existing!.start);
    const tampered = Buffer.from(out.png);
    tampered[claimAt + 12]! ^= 0x20; // "image/png" -> "imAge/png"
    expect(verifyPng(tampered, { anchors: [root] })).toMatchObject({ verified: false, checks: { signature: false } });

    expect(verifyPng(samplePng())).toMatchObject({ present: false, verified: false, problems: ['The image carries no C2PA manifest.'] });
    // Re-signing replaces the chunk rather than stacking a second one.
    const again = await signPng(out.png, { ...info, seed: 8 }, signer);
    expect(locateChunk(again.png).existing!.start).toBe(existing!.start);
    expect(verifyPng(again.png, { anchors: [root] }).verified).toBe(true);
  });
});

async function signerFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'exs39-'));
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
  return { ...c, post: (p: string, b: object = {}) => c.agent.post(p).set('x-csrf-token', c.csrf).send(b) };
}

describe('B-7901: generated images carry a manifest signed by the tenant CA', () => {
  let f: Awaited<ReturnType<typeof signerFixture>>;
  let h: Harness;
  let backend: FakeImageBackend;
  let member: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    f = await signerFixture();
    backend = new FakeImageBackend();
    h = await harness8({ DATA_KEY: '', SIGNER_SOCKET: f.socketPath, SIGNER_TOKEN: f.token, PKI_PUBLIC_URL: 'http://ca.example.test' }, { imageBackends: [backend], imageSafety: new FakeSafety() });
    const sys = await admin(h, 'root', ['system-admin']);
    const ta = await admin(h, 'ta', ['tenant-admin']);
    expect((await sys.post('/api/pki/issuers', { kind: 'root', commonName: 'Exprsn Test Root', organization: 'Exprsn', keyType: 'ecdsa-p256', days: 3650 })).status).toBe(201);
    expect((await ta.post('/api/pki/issuers', { kind: 'intermediate', keyType: 'ecdsa-p256', days: 1825 })).status).toBe(201);
    await localUser(h, 'mem', ['member']);
    member = await login(h, 'mem');
  }, 120_000);
  afterAll(async () => {
    await h.close();
    await f.close();
  });

  const gen = (body: object = {}) => member.agent.post('/api/images').set('x-csrf-token', member.csrf).send({ backend: 'fake-sdxl', width: 512, height: 512, prompt: 'A lighthouse at dusk', ...body });

  it('signs, stores and verifies the manifest, keeps the HMAC manifest valid, and replaces a revoked certificate', async () => {
    const out = (await gen({ seed: 5 }).expect(202)).body;
    const id = out.images[0].id as string;
    await h.s.jobs.runDue();
    const img = (await member.agent.get(`/api/images/${id}`).expect(200)).body;
    expect(img).toMatchObject({ state: 'succeeded', provenance: { signed: true }, contentCredentials: { signed: true, label: expect.stringMatching(/^urn:uuid:/) } });

    const cc = (await member.agent.get(`/api/images/${id}/content-credentials`).expect(200)).body;
    expect(cc).toMatchObject({ present: true, verified: true, checks: { claimHashes: true, dataHash: true, signature: true, chain: true, anchor: true, certificateValid: true }, problems: [] });
    expect(cc.manifest).toMatchObject({ model: 'sdxl-base', job: id, tenant: h.tenantId, generator: expect.stringMatching(/^Exprsn-AI\//) });
    expect(cc.signer.subject).toContain('Exprsn-AI content credentials');
    expect(cc.summary.certificate).toBeTruthy();

    // The downloaded bytes verify offline against the tenant's CA certificates, and the HMAC manifest still verifies.
    const file = await binary(member.agent.get(`/api/images/${id}/download`)).expect(200);
    const anchors = (await h.s.pki.contentAnchors(h.tenantId)).map((p) => fromPem(p, 'CERTIFICATE'));
    expect(verifyPng(file.body as Buffer, { anchors }).verified).toBe(true);
    expect(readText(file.body as Buffer)['exprsn-provenance']).toBeTruthy();
    expect((await member.agent.get(`/api/images/${id}/provenance`).expect(200)).body).toMatchObject({ verified: true, bytesMatch: true });

    // The certificate is on the tenant's certificate list; revoking it makes the next image sign with a new one.
    const certId = cc.summary.certificate as string;
    const cert = await h.s.db('pki_certificates').where({ id: certId }).first();
    expect(cert).toMatchObject({ common_name: 'Exprsn-AI content credentials', profile_id: null, state: 'valid' });
    await h.s.db('pki_certificates').where({ id: certId }).update({ state: 'revoked', revoked_at: Date.now(), revocation_reason: 1 });
    const second = (await gen({ seed: 6 }).expect(202)).body.images[0].id as string;
    await h.s.jobs.runDue();
    const cc2 = (await member.agent.get(`/api/images/${second}/content-credentials`).expect(200)).body;
    expect(cc2.verified).toBe(true);
    expect(cc2.summary.certificate).not.toBe(certId);
    expect(await h.s.db('pki_content_signers').where({ tenant_id: h.tenantId, state: 'active' }).count({ n: '*' }).first()).toMatchObject({ n: 1 });
    const events = await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'pki.content_signer.created' });
    expect(events).toHaveLength(2);
  });
});

describe('B-7901: without a tenant CA the image keeps the HMAC manifest only', () => {
  it('says why it is not signed', async () => {
    const backend = new FakeImageBackend();
    const h = await harness8({}, { imageBackends: [backend], imageSafety: new FakeSafety() });
    try {
      await localUser(h, 'mem', ['member']);
      const m = await login(h, 'mem');
      const out = (await m.agent.post('/api/images').set('x-csrf-token', m.csrf).send({ backend: 'fake-sdxl', width: 512, height: 512, prompt: 'A lighthouse' }).expect(202)).body;
      await h.s.jobs.runDue();
      const img = (await m.agent.get(`/api/images/${out.images[0].id}`).expect(200)).body;
      expect(img).toMatchObject({ state: 'succeeded', provenance: { signed: true }, contentCredentials: { signed: false, reason: expect.stringContaining('issuing CA') } });
      expect((await m.agent.get(`/api/images/${out.images[0].id}/content-credentials`).expect(200)).body).toMatchObject({ present: false, verified: false });
      expect((await request(h.app).get(`/api/images/${out.images[0].id}/content-credentials`)).status).toBe(401);
    } finally {
      await h.close();
    }
  });

  it('is off with IMAGE_C2PA=off', async () => {
    const h = await harness({ IMAGE_C2PA: 'off' });
    try {
      expect(h.s.contentCredentials.enabled()).toBe(false);
      expect((await h.s.contentCredentials.sign(h.tenantId, samplePng(), { ...info })).summary).toMatchObject({ signed: false, reason: expect.stringContaining('IMAGE_C2PA') });
    } finally {
      await h.close();
    }
  });
});
