/*
 * Sprint 25 (B-1608 to B-1611): AT-Protocol trust. Known-answer tests pin DAG-CBOR, CIDs, did:key, did:plc and label
 * signatures to the reference implementations' output (@ipld/dag-cbor, multiformats, @noble/curves, as used by
 * @atproto/crypto; the did:key vectors are W3C's). Then, through the API: service DIDs with keys in the signer or
 * OpenBao, key rotation changing the DID document, PLC operations accepted by a PLC directory double, the signed
 * labeler with queryLabels and subscribeLabels replayed from a cursor and verified, and inbound labels from a trusted
 * labeler, where a bad signature is dropped and audited.
 */
import { randomBytes, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { cborDecode, cborEncode } from '../src/atproto/cbor.js';
import { compressPublicKey, CURVE, formatDidKey, isLowS, normaliseLowS, parseDidKey, parseMultikey, verifySignature } from '../src/atproto/crypto.js';
import { didWebDocumentUrl, didWebFor, plcDidForGenesis, plcOperationCid, plcSigningBytes, verifyPlcOperation, type PlcOperation } from '../src/atproto/did.js';
import { base32Decode, base32Encode, base58Decode, base58Encode, Cid } from '../src/atproto/encoding.js';
import { labelSigningBytes, labelsForDecision, labelsForFlag, readLabel, verifyLabel, type Label } from '../src/atproto/labels.js';
import { attachLabelStream, readFrame } from '../src/atproto/stream.js';
import { startSigner } from '../src/signer/server.js';
import { FakeOpenBao } from './fake-openbao.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';
import { loopbackServerFor } from './loopback.js';
import { FakeLabeler, FakePlcDirectory, keyFromScalar, testKey } from './sprint25b-fakes.js';

const hex = (h: string) => Buffer.from(h, 'hex');

// Generated with @ipld/dag-cbor 9.2, multiformats 13.4 and @noble/curves (the libraries behind @atproto/crypto).
const KAT = {
  sampleCbor:
    'ab616161786162f66173781e616161616161616161616161616161616161616161616161616161616161617a01626161f5626162f46262628d012017181818ff19010019ffff1a000100001b000000010000000037381838ff39010062c3a962c3bc646c696e6bd82a582500017112209dfefe61dd76ea3dcae5023880b08379d57adf20482d6fdbe2759289f647677b65627974657343010203666e6573746564a2616b6176626b6b80',
  sampleCid: 'bafyreiahphy5ugjgktjryhal5hrft54n4ikcutdib3kat6jzt57q5s4zsa',
  kPriv: '9085d2bef69286a6cbb51623c8fa258629945cd55ca705cc4e66700396894e0c',
  pPriv58: '9p4VRzdmhsnq869vQjVCTrRry7u4TtfRxhvBFJTGU2Cp',
  kDid: 'did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme',
  pDid: 'did:key:zDnaeTiq1PdzvZXUaMdezchcMJQpBdH2VN4pgrrEhMCCbmwSb',
  plcUnsigned:
    'a66470726576f664747970656d706c635f6f7065726174696f6e687365727669636573a16f617470726f746f5f6c6162656c6572a264747970656e417470726f746f4c6162656c657268656e64706f696e74781b68747470733a2f2f6c6162656c65722e6578616d706c652e636f6d6b616c736f4b6e6f776e417381781861743a2f2f6c6162656c65722e6578616d706c652e636f6d6c726f746174696f6e4b6579738178396469643a6b65793a7a513373686f6b46545333627248634451726e383252554466435a4553574c315a6443454a77656b554450516959426d6573766572696669636174696f6e4d6574686f6473a16d617470726f746f5f6c6162656c78396469643a6b65793a7a446e61655469713150647a765a5855614d64657a6368634d4a517042644832564e347067727245684d4343626d775362',
  plcSig: 'ABFvm59KJemSByz5-nPNJEShTQpvsXgxDft0O5L-rLA7nI7mq-KBERTz_ZYI_42fOdFcx1CvByJsZf-tM-y5aA',
  plcDid: 'did:plc:hnh3tcejlpahnoxb7ieqdpmu',
  plcCid: 'bafyreib3j64yrck3yb3lvyp2bea33fczb6h2h2xy2fa45rsy3byjk6bjyi',
  labelCbor:
    'a6636374737818323032362d31302d30345430303a30303a30302e3030305a636e6567f46373726378206469643a706c633a686e68337463656a6c7061686e6f78623769657164706d7563757269782961743a2f2f6469643a706c633a6162632f6170702e62736b792e666565642e706f73742f336b6162636376616c65217761726e6376657201',
  labelSig: 'f9f050cdd9b6e517f0ef3df44553309182d2bf8a059a6aa9fe0501a2503d26a042cac63b2f0b129c88963fe9399f9db2fe7f8f961b733f4d3f3863aabfba1ce4'
};

// W3C did:key secp256k1 vectors (https://github.com/w3c-ccg/did-method-key/blob/main/test-vectors/secp256k1.json).
const W3C_K256 = [
  ['9085d2bef69286a6cbb51623c8fa258629945cd55ca705cc4e66700396894e0c', 'did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme'],
  ['f0f4df55a2b3ff13051ea814a8f24ad00f2e469af73c363ac7e9fb999a9072ed', 'did:key:zQ3shtxV1FrJfhqE1dvxYRcCknWNjHc3c5X1y3ZSoPDi2aur2'],
  ['6b0b91287ae3348f8c2f2552d766f30e3604867e34adc37ccbb74a8e6b893e02', 'did:key:zQ3shZc2QzApp2oymGvQbzP8eKheVshBHbU4ZYjeXqwSKEn6N'],
  ['c0a6a7c560d37d7ba81ecee9543721ff48fea3e0fb827d42c1868226540fac15', 'did:key:zQ3shadCps5JLAHcZiuX5YUtWHHL8ysBJqFLWvjZDKAWUBGzy'],
  ['175a232d440be1e0788f25488a73d9416c04b6f924bea6354bf05dd2f1a75133', 'did:key:zQ3shptjE6JwdkeKN4fcpnYQY3m9Cet3NiHdAfpvSUZBFoKBj']
];

const genesis = (): PlcOperation => ({
  type: 'plc_operation',
  rotationKeys: [KAT.kDid],
  verificationMethods: { atproto_label: KAT.pDid },
  alsoKnownAs: ['at://labeler.example.com'],
  services: { atproto_labeler: { type: 'AtprotoLabeler', endpoint: 'https://labeler.example.com' } },
  prev: null
});

describe('AT-Protocol encodings (known answers)', () => {
  it('encodes DAG-CBOR canonically, computes CIDs and refuses non-canonical input', () => {
    const sample = { z: 1, a: 'x', bb: [1, -1, 23, 24, 255, 256, 65535, 65536, 4294967296, -24, -25, -256, -257], aa: true, b: null, ab: false, é: 'ü', bytes: Buffer.from([1, 2, 3]), link: Cid.parse('bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm'), nested: { k: 'v', kk: [] }, s: 'a'.repeat(30), gone: undefined };
    const enc = cborEncode(sample);
    expect(enc.toString('hex')).toBe(KAT.sampleCbor);
    expect(Cid.ofCbor(enc).toString()).toBe(KAT.sampleCid);
    // Decoding and encoding again gives the same bytes; the CID link and bytes keep their types.
    const back = cborDecode(enc) as Record<string, unknown>;
    expect(back.link).toBeInstanceOf(Cid);
    expect(Buffer.isBuffer(back.bytes)).toBe(true);
    expect(cborEncode(back).toString('hex')).toBe(KAT.sampleCbor);
    expect(() => cborDecode(hex('a2616201616101'))).toThrow(/order/); // {b:1, a:1}: keys out of order
    expect(() => cborDecode(hex('9f01ff'))).toThrow(/Indefinite/);
    expect(() => cborDecode(hex('fb3ff0000000000000'))).toThrow(/Floats/);
    expect(() => cborDecode(hex('1801'))).toThrow(/shortest/);
    expect(() => cborDecode(hex('c11a00000000'))).toThrow(/tag/);
    expect(() => cborEncode({ x: 1.5 })).toThrow(/integers/);
    // base32 and base58btc round trips, with leading zeros.
    const b = Buffer.from([0, 0, 1, 2, 250, 255]);
    expect(base58Decode(base58Encode(b))).toEqual(b);
    expect(base32Decode(base32Encode(b))).toEqual(b);
  });

  it('derives did:key for secp256k1 (W3C vectors) and P-256, and parses them back to keys', () => {
    for (const [seed, did] of W3C_K256) {
      const { compressed } = keyFromScalar('secp256k1', hex(seed!));
      expect(formatDidKey('secp256k1', compressed)).toBe(did);
      const parsed = parseDidKey(did!);
      expect(parsed.curve).toBe('secp256k1');
      expect(compressPublicKey(parsed.key).compressed).toEqual(compressed);
    }
    const p = keyFromScalar('p256', base58Decode(KAT.pPriv58));
    expect(formatDidKey('p256', p.compressed)).toBe(KAT.pDid);
    expect(parseMultikey(KAT.pDid.slice(8)).curve).toBe('p256');
    expect(() => parseDidKey('did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK')).toThrow(); // Ed25519 is not allowed
  });

  it('signs, derives and verifies a did:plc genesis operation exactly as the reference does', () => {
    const op = genesis();
    expect(plcSigningBytes(op).toString('hex')).toBe(KAT.plcUnsigned);
    const signed = { ...op, sig: KAT.plcSig };
    expect(plcDidForGenesis(signed)).toBe(KAT.plcDid);
    expect(plcOperationCid(signed)).toBe(KAT.plcCid);
    expect(verifyPlcOperation(signed, [KAT.kDid])).toBe(true);
    expect(verifyPlcOperation(signed, [KAT.pDid])).toBe(false);
    expect(verifyPlcOperation({ ...signed, alsoKnownAs: ['at://evil.example.com'] }, [KAT.kDid])).toBe(false);
    // Our own signature (randomised ECDSA, then low-S) verifies too.
    const k = keyFromScalar('secp256k1', hex(KAT.kPriv));
    const ours = { ...op, sig: normaliseLowS('secp256k1', cryptoSign('sha256', plcSigningBytes(op), { key: k.privateKey, dsaEncoding: 'ieee-p1363' })).toString('base64url') };
    expect(verifyPlcOperation(ours, [KAT.kDid])).toBe(true);
  });

  it('verifies a reference label signature, and refuses its high-S twin and a changed label', () => {
    const label: Label = { ver: 1, src: KAT.plcDid, uri: 'at://did:plc:abc/app.bsky.feed.post/3kabc', val: '!warn', neg: false, cts: '2026-10-04T00:00:00.000Z' };
    expect(labelSigningBytes(label).toString('hex')).toBe(KAT.labelCbor);
    const { key } = parseDidKey(KAT.pDid);
    const sig = hex(KAT.labelSig);
    expect(isLowS('p256', sig)).toBe(true);
    expect(verifySignature('p256', key, labelSigningBytes(label), sig)).toBe(true);
    const s = BigInt('0x' + sig.subarray(32).toString('hex'));
    const high = Buffer.concat([sig.subarray(0, 32), Buffer.from((CURVE.p256.n - s).toString(16).padStart(64, '0'), 'hex')]);
    expect(verifySignature('p256', key, labelSigningBytes(label), high)).toBe(false);
    expect(normaliseLowS('p256', high)).toEqual(sig);
    expect(verifySignature('p256', key, labelSigningBytes({ ...label, val: '!hide' }), sig)).toBe(false);
    // Received in JSON form ($bytes) it reads and verifies the same way.
    const raw = { ...label, sig: { $bytes: sig.toString('base64').replace(/=+$/, '') } };
    expect(verifyLabel(raw, readLabel(raw)!, 'p256', key)).toBe(true);
  });

  it('folds every signature to low-S for both curves', () => {
    for (const curve of ['secp256k1', 'p256'] as const) {
      const k = testKey(curve);
      const { key } = parseDidKey(k.didKey);
      for (let i = 0; i < 16; i++) {
        const data = randomBytes(40);
        const sig = k.sign(data);
        expect(isLowS(curve, sig)).toBe(true);
        expect(verifySignature(curve, key, data, sig)).toBe(true);
      }
    }
  });

  it('maps guardrail and flag verdicts to labels', () => {
    expect(labelsForDecision({ action: 'block', findings: [{ ruleId: 'r', ruleName: 'Explicit sexual content', action: 'block', stage: 'enforce' }] })).toEqual(['!hide', 'porn', 'sexual']);
    expect(labelsForDecision({ action: 'warn', findings: [{ ruleId: 'r', ruleName: 'Spam links', action: 'warn', stage: 'enforce' }, { ruleId: 's', ruleName: 'Gore', action: 'block', stage: 'shadow' }] })).toEqual(['!warn', 'spam']);
    expect(labelsForDecision({ action: 'allow', findings: [] })).toEqual([]);
    expect(labelsForFlag({ state: 'open', action: 'require-approval', rule_name: 'PII detector', severity: 'medium' })).toEqual(['!hide', 'pii']);
    expect(labelsForFlag({ state: 'dismissed', action: 'block', rule_name: 'x', severity: 'high' })).toEqual([]);
  });

  it('maps did:web names to document addresses', () => {
    expect(didWebFor(new URL('https://example.com'))).toBe('did:web:example.com');
    expect(didWebFor(new URL('http://localhost:8080'), ['atproto', 'acme'])).toBe('did:web:localhost%3A8080:atproto:acme');
    expect(didWebDocumentUrl('did:web:example.com')).toBe('https://example.com/.well-known/did.json');
    expect(didWebDocumentUrl('did:web:localhost%3A8080:atproto:acme')).toBe('https://localhost:8080/atproto/acme/did.json');
    expect(() => didWebDocumentUrl('did:web:example.com:..')).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------

async function signerFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'exs-'));
  const socketPath = path.join(dir, 'run', 'signer.sock');
  const token = randomBytes(24).toString('base64url') + 'x'.repeat(8);
  const signer = await startSigner({ socketPath, key: randomBytes(32).toString('base64'), token });
  return {
    socketPath,
    token,
    signer,
    close: async () => {
      await signer.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

async function admin(h: Harness, username: string, roles: string[]) {
  await localUser(h, username, roles, 'confidential');
  const c = await loginAdmin(h, username);
  return {
    get: (p: string) => c.agent.get(p),
    post: (p: string, b: object = {}) => c.agent.post(p).set('x-csrf-token', c.csrf).send(b),
    patch: (p: string, b: object = {}) => c.agent.patch(p).set('x-csrf-token', c.csrf).send(b),
    del: (p: string) => c.agent.delete(p).set('x-csrf-token', c.csrf)
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const drain = async (h: Harness, rounds = 6) => {
  for (let i = 0; i < rounds; i++) {
    await h.s.jobs.runDue();
    await sleep(10);
  }
};

interface Frame {
  header: Record<string, unknown>;
  body: Record<string, unknown>;
}

/** Subscribes to a label stream and collects frames until `count` arrive (or the stream closes). */
function subscribe(url: string, count: number, timeoutMs = 5000): Promise<{ frames: Frame[]; ws: WebSocket }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const frames: Frame[] = [];
    const done = () => {
      clearTimeout(t);
      resolve({ frames, ws });
    };
    const t = setTimeout(() => (frames.length ? done() : reject(new Error(`no frames from ${url}`))), timeoutMs);
    ws.on('message', (data: Buffer) => {
      frames.push(readFrame(data));
      if (frames.length >= count) done();
    });
    ws.on('close', done);
    ws.on('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

/** Verifies each label in `#labels` frames against a DID document's #atproto_label key; seqs must increase. */
function verifyFrames(frames: Frame[], doc: { verificationMethod: { id: string; publicKeyMultibase: string }[] }) {
  const vm = doc.verificationMethod.find((v) => v.id.endsWith('#atproto_label'))!;
  const { curve, key } = parseMultikey(vm.publicKeyMultibase);
  let last = 0;
  const out: Label[] = [];
  for (const f of frames) {
    expect(f.header).toEqual({ op: 1, t: '#labels' });
    const seq = f.body.seq as number;
    expect(seq).toBeGreaterThan(last);
    last = seq;
    for (const raw of f.body.labels as Record<string, unknown>[]) {
      const l = readLabel(raw)!;
      expect(verifyLabel(raw, l, curve, key)).toBe(true);
      out.push(l);
    }
  }
  return out;
}

describe('Sprint 25: AT-Protocol identities, labeler and inbound labels with keys in the signer', () => {
  let f: Awaited<ReturnType<typeof signerFixture>>;
  let plc: FakePlcDirectory;
  let ext: FakeLabeler;
  let h: Harness;
  let a: Awaited<ReturnType<typeof admin>>;
  let stream: ReturnType<typeof attachLabelStream>;
  let wsBase: string;
  const HOST = 'labels.example.test';

  beforeAll(async () => {
    f = await signerFixture();
    plc = new FakePlcDirectory();
    await plc.start();
    ext = new FakeLabeler(plc);
    await ext.start();
    h = await harness({ DATA_KEY: '', SIGNER_SOCKET: f.socketPath, SIGNER_TOKEN: f.token, ATPROTO_PUBLIC_URL: `https://${HOST}`, ATPROTO_PLC_URL: plc.url });
    const server = loopbackServerFor(h.app)!;
    stream = attachLabelStream(server, h.s);
    wsBase = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    a = await admin(h, 'atadmin', ['system-admin']);
  }, 60_000);

  afterAll(async () => {
    await stream?.close();
    await h?.close();
    await ext?.stop();
    await plc?.stop();
    await f?.close();
  });

  it('refuses labels before any identity exists, and a member reaches none of it', async () => {
    const r = await a.post('/api/atproto/labels', { uri: 'at://did:plc:abc/app.bsky.feed.post/1', vals: ['!warn'] });
    expect(r.status).toBe(409);
    expect(r.body.step).toBe('identity');
    await localUser(h, 'plain', ['member']);
    const m = request.agent(h.app);
    const login = await m.post('/api/auth/login').send({ username: 'plain', password: 'correct horse battery staple' });
    expect((await m.get('/api/atproto/labels')).status).toBe(403);
    expect((await m.post('/api/atproto/identity').set('x-csrf-token', login.body.csrf).send({ method: 'web' })).status).toBe(403);
  });

  let platformDid = '';

  it('B-1608: the platform did:web has a secp256k1 label key held by the signer; rotating it updates the DID document', async () => {
    const keygens = f.signer.served.keygen ?? 0;
    const r = await a.post('/api/atproto/identity', { platform: true, method: 'web' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ platform: true, method: 'web', did: `did:web:${HOST}`, handle: HOST, endpoint: `https://${HOST}` });
    expect(f.signer.served.keygen! - keygens).toBe(1);
    platformDid = r.body.did as string;
    const key = r.body.keys[0];
    expect(key).toMatchObject({ purpose: 'label', curve: 'secp256k1', custody: 'signer', state: 'active' });
    // The app holds only the signer's opaque blob, never a private key.
    const row = (await h.s.db('atproto_keys').where({ id: key.id }).first()) as { key_wrapped: string; key_name: string };
    expect(row.key_wrapped).not.toMatch(/PRIVATE KEY|"d":/);
    expect(row.key_name).toBe(`atproto:${key.id}`);

    const doc1 = await request(h.app).get('/.well-known/did.json').set('Host', HOST);
    expect(doc1.status).toBe(200);
    expect(doc1.headers['content-type']).toMatch(/application\/did\+json/);
    const d1 = JSON.parse(doc1.text);
    expect(d1).toMatchObject({ id: platformDid, alsoKnownAs: [`at://${HOST}`], service: [{ id: '#atproto_labeler', type: 'AtprotoLabeler', serviceEndpoint: `https://${HOST}` }] });
    expect(d1.verificationMethod[0]).toMatchObject({ id: `${platformDid}#atproto_label`, type: 'Multikey', publicKeyMultibase: key.didKey.slice(8) });
    expect((await request(h.app).get('/.well-known/atproto-did').set('Host', HOST)).text).toBe(platformDid);
    expect((await request(h.app).get('/.well-known/did.json').set('Host', 'other.example.test')).status).toBe(404);

    // A label signed before the rotation is served re-signed with the new key afterwards.
    const before = await a.post('/api/atproto/labels', { uri: 'at://did:plc:rotate/app.bsky.feed.post/1', vals: ['!warn'] });
    expect(before.status).toBe(201);
    const rot = await a.post('/api/atproto/identity/rotate', { platform: true, purpose: 'label' });
    expect(rot.status).toBe(200);
    expect(rot.body.retired).toMatchObject({ id: key.id, state: 'retired' });
    expect(rot.body.key.didKey).not.toBe(key.didKey);
    const d2 = JSON.parse((await request(h.app).get('/.well-known/did.json').set('Host', HOST)).text);
    expect(d2.verificationMethod[0].publicKeyMultibase).toBe(rot.body.key.didKey.slice(8));
    const q = await request(h.app).get('/xrpc/com.atproto.label.queryLabels').set('Host', HOST).query({ uriPatterns: 'at://did:plc:rotate/*' });
    expect(q.status).toBe(200);
    const { curve, key: pub } = parseMultikey(d2.verificationMethod[0].publicKeyMultibase);
    expect(q.body.labels).toHaveLength(1);
    expect(verifyLabel(q.body.labels[0], readLabel(q.body.labels[0])!, curve, pub)).toBe(true);
    // A did:web has no rotation keys.
    expect((await a.post('/api/atproto/identity/rotate', { platform: true, purpose: 'rotation' })).status).toBe(400);
    const audit = await h.s.db('audit_events').whereIn('action', ['atproto.identity.created', 'atproto.key.rotated']).select('action');
    expect(audit.map((x) => x.action).sort()).toEqual(['atproto.identity.created', 'atproto.key.rotated']);
  });

  let tenantDid = '';

  it('B-1609: a tenant did:plc is created and rotated by operations the PLC directory double accepts', async () => {
    const r = await a.post('/api/atproto/identity', { method: 'plc', handle: 'acme.example.test', curve: 'p256', rotationCurve: 'secp256k1' });
    expect(r.status).toBe(201);
    tenantDid = r.body.did as string;
    expect(tenantDid).toMatch(/^did:plc:[a-z2-7]{24}$/);
    expect(r.body.endpoint).toBe(`https://${HOST}/atproto/default`);
    expect(plc.log.get(tenantDid)).toHaveLength(1);
    expect(plc.refused).toEqual([]);
    const genesisOp = plc.log.get(tenantDid)![0]!;
    expect(plcDidForGenesis(genesisOp)).toBe(tenantDid);
    expect(r.body.plcCid).toBe(plcOperationCid(genesisOp));
    const labelKey = r.body.keys.find((k: { purpose: string }) => k.purpose === 'label');
    const rotationKey = r.body.keys.find((k: { purpose: string }) => k.purpose === 'rotation');
    expect(labelKey.curve).toBe('p256');
    expect(genesisOp.rotationKeys).toEqual([rotationKey.didKey]);

    // The directory now resolves the DID to a document naming the label key and the labeler endpoint.
    const doc = (await (await fetch(`${plc.url}/${tenantDid}`)).json()) as { verificationMethod: { publicKeyMultibase: string }[]; alsoKnownAs: string[] };
    expect(doc.verificationMethod[0]!.publicKeyMultibase).toBe(labelKey.didKey.slice(8));
    expect(doc.alsoKnownAs).toEqual(['at://acme.example.test']);

    // Rotating the label key: a second operation chained to the first, signed by the rotation key.
    const rl = await a.post('/api/atproto/identity/rotate', { purpose: 'label' });
    expect(rl.status).toBe(200);
    expect(plc.log.get(tenantDid)).toHaveLength(2);
    const doc2 = (await (await fetch(`${plc.url}/${tenantDid}`)).json()) as { verificationMethod: { publicKeyMultibase: string }[] };
    expect(doc2.verificationMethod[0]!.publicKeyMultibase).toBe(rl.body.key.didKey.slice(8));
    // Rotating the rotation key: signed by the old one, naming the new one.
    const rr = await a.post('/api/atproto/identity/rotate', { purpose: 'rotation' });
    expect(rr.status).toBe(200);
    const ops = plc.log.get(tenantDid)!;
    expect(ops).toHaveLength(3);
    expect(ops[2]!.rotationKeys).toEqual([rr.body.key.didKey]);
    expect(verifyPlcOperation(ops[2]!, [rotationKey.didKey])).toBe(true);
    expect(plc.refused).toEqual([]);
    // An operation signed by a key that is not in force is refused by the directory.
    const forged = { ...ops[2]!, prev: plcOperationCid(ops[2]!), alsoKnownAs: ['at://evil.example.test'], sig: testKey('secp256k1').sign(plcSigningBytes({ ...ops[2]!, prev: plcOperationCid(ops[2]!) })).toString('base64url') };
    const res = await fetch(`${plc.url}/${tenantDid}`, { method: 'POST', body: JSON.stringify(forged) });
    expect(res.status).toBe(400);
    expect(plc.refused.at(-1)!.reason).toMatch(/signature/);
  });

  it('B-1609: a tenant without a host of its own gets a path-form did:web, and tenants without one fall back to the platform', async () => {
    const other = await h.s.tenants.create({ slug: 'beta', name: 'Beta' });
    const by = { tenantId: other.id, userId: null, actor: { service: 'test' } };
    const i = await h.s.atproto.createIdentity(by, other.id, { method: 'web' });
    expect(i.did).toBe(`did:web:${HOST}:atproto:beta`);
    const doc = await request(h.app).get('/atproto/beta/did.json');
    expect(doc.status).toBe(200);
    expect(JSON.parse(doc.text)).toMatchObject({ id: i.did, service: [{ serviceEndpoint: `https://${HOST}/atproto/beta` }] });
    // A third tenant has no identity: its labels are signed by the platform's.
    const third = await h.s.tenants.create({ slug: 'gamma', name: 'Gamma' });
    const rows = await h.s.atproto.emit({ tenantId: third.id, userId: null, actor: { service: 'test' } }, third.id, { uri: 'at://did:plc:gamma/app.bsky.feed.post/1', vals: ['spam'] });
    expect(rows[0]!.label.src).toBe(platformDid);
  });

  it('B-1610: guardrail and flag verdicts become signed, ordered labels; a subscriber replays them from a cursor and verifies each', async () => {
    const subject = 'at://did:plc:subject/app.bsky.feed.post/3kxyz';
    const manual = await a.post('/api/atproto/labels', { uri: subject, vals: ['!warn', 'spam'] });
    expect(manual.status).toBe(201);
    expect(manual.body.labels.map((l: { label: { val: string } }) => l.label.val)).toEqual(['!warn', 'spam']);
    // A value already in force is not repeated.
    expect((await a.post('/api/atproto/labels', { uri: subject, vals: ['spam'] })).body.labels).toEqual([]);

    const flag = await h.s.guard.flags.create({ tenantId: h.tenantId, workspaceId: null, kind: 'rule', checkpoint: 'model-output', ruleName: 'Explicit sexual content', action: 'block', severity: 'high', label: 'internal' });
    const fromFlag = await a.post('/api/atproto/labels', { uri: 'at://did:plc:subject/app.bsky.feed.post/flagged', flag: `F-${flag.number}` });
    expect(fromFlag.status).toBe(201);
    expect(fromFlag.body.labels.map((l: { label: { val: string } }) => l.label.val)).toEqual(['!hide', 'porn', 'sexual']);
    const decision = await h.s.atproto.labelDecision({ tenantId: h.tenantId, userId: null, actor: { service: 'test' } }, h.tenantId, 'at://did:plc:subject/app.bsky.feed.post/guard', { action: 'warn', findings: [{ ruleId: 'r', ruleName: 'Hate speech', action: 'warn', stage: 'enforce' }] });
    expect(decision.map((l) => l.label.val)).toEqual(['!warn', 'hate']);

    const neg = await a.post('/api/atproto/labels/negate', { uri: subject, val: 'spam', reason: 'appeal upheld' });
    expect(neg.status).toBe(201);
    expect(neg.body.label).toMatchObject({ val: 'spam', neg: true });
    expect((await a.post('/api/atproto/labels/negate', { uri: subject, val: 'spam' })).status).toBe(409);

    // Dismissing the flag withdraws the labels it produced.
    const dismissed = await a.post(`/api/flags/F-${flag.number}/decide`, { decision: 'dismissed', reason: 'not sexual' });
    expect(dismissed.status).toBe(200);
    let negated: { label: { val: string; neg: boolean } }[] = [];
    for (let i = 0; i < 50 && negated.length < 3; i++) {
      await sleep(20);
      negated = ((await a.get('/api/atproto/labels').query({ uri: 'at://did:plc:subject/app.bsky.feed.post/flagged' })).body.labels as typeof negated).filter((l) => l.label.neg);
    }
    expect(negated.map((l) => l.label.val).sort()).toEqual(['!hide', 'porn', 'sexual']);

    // The tenant's did:plc document (from the PLC directory) verifies every label in the stream, from seq 0.
    const doc = (await (await fetch(`${plc.url}/${tenantDid}`)).json()) as Parameters<typeof verifyFrames>[1];
    const total = await h.s.atproto.maxSeq((await h.s.atproto.identity(h.tenantId))!.id);
    expect(total).toBe(11);
    const all = await subscribe(`${wsBase}/atproto/default/xrpc/com.atproto.label.subscribeLabels?cursor=0`, total);
    const labels = verifyFrames(all.frames, doc);
    expect(all.frames.map((x) => x.body.seq)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    expect(labels.every((l) => l.src === tenantDid)).toBe(true);
    // Still connected: a new label arrives live.
    const live = new Promise<Frame>((resolve) => all.ws.once('message', (d: Buffer) => resolve(readFrame(d))));
    await a.post('/api/atproto/labels', { uri: 'at://did:plc:subject/app.bsky.feed.post/live', vals: ['!warn'] });
    const lf = await live;
    expect(lf.body.seq).toBe(total + 1);
    verifyFrames([lf], doc);
    all.ws.close();

    // From a cursor: only what came after it.
    const tail = await subscribe(`${wsBase}/atproto/default/xrpc/com.atproto.label.subscribeLabels?cursor=9`, 3);
    expect(tail.frames.map((x) => x.body.seq)).toEqual([10, 11, 12]);
    verifyFrames(tail.frames, doc);
    tail.ws.close();

    // A cursor past the newest label is an error frame.
    const future = await subscribe(`${wsBase}/atproto/default/xrpc/com.atproto.label.subscribeLabels?cursor=999`, 1);
    expect(future.frames[0]).toEqual({ header: { op: -1 }, body: { error: 'FutureCursor', message: expect.any(String) } });

    // queryLabels: prefix patterns, the cursor, and a sources filter.
    const q = await request(h.app).get('/atproto/default/xrpc/com.atproto.label.queryLabels').query({ uriPatterns: 'at://did:plc:subject/*', limit: 5 });
    expect(q.status).toBe(200);
    expect(q.body.labels).toHaveLength(5);
    expect(q.body.cursor).toBe('5');
    const q2 = await request(h.app).get('/atproto/default/xrpc/com.atproto.label.queryLabels').query({ uriPatterns: ['at://did:plc:subject/*'], cursor: q.body.cursor });
    expect(q2.body.labels.length).toBe(7);
    expect((await request(h.app).get('/atproto/default/xrpc/com.atproto.label.queryLabels').query({ uriPatterns: subject, sources: 'did:plc:someoneelse' })).body.labels).toEqual([]);
    expect((await request(h.app).get('/atproto/default/xrpc/com.atproto.label.queryLabels')).body).toMatchObject({ error: 'InvalidRequest' });
  });

  it('B-1611: labels from a trusted labeler are verified against its DID key; a bad signature is dropped and audited', async () => {
    const forger = testKey('secp256k1');
    ext.add([ext.label('at://did:plc:victim/app.bsky.feed.post/1', '!hide')]);
    ext.add([ext.label('at://did:plc:victim/app.bsky.feed.post/2', 'spam', { signWith: forger }), ext.label('at://did:plc:victim/app.bsky.feed.post/3', 'porn')]);
    ext.add([ext.label('at://did:plc:victim/app.bsky.feed.post/4', 'custom-thing')]);

    const workspaceId = (await h.s.tenants.workspaces(h.tenantId))[0]?.id;
    const reg = await a.post('/api/atproto/labelers', { did: ext.did, name: 'Community labeler', vals: ['!hide', 'spam', 'porn'], ...(workspaceId ? { workspaceId } : {}) });
    expect(reg.status).toBe(201);
    expect(reg.body).toMatchObject({ did: ext.did, endpoint: ext.url, didKey: ext.key.didKey, state: 'active' });

    const pull = await a.post(`/api/atproto/labelers/${reg.body.id}/pull`);
    expect(pull.status).toBe(202);
    await drain(h);
    const after = (await a.get('/api/atproto/labelers')).body.labelers[0];
    expect(after).toMatchObject({ cursor: 3, received: 3, rejected: 1, lastError: null });
    expect(ext.cursors).toEqual(['0']);
    const inbound = (await a.get(`/api/atproto/labelers/${reg.body.id}/labels`)).body.labels as { val: string; flagId: string | null; uri: string }[];
    expect(inbound.map((l) => l.val).sort()).toEqual(['!hide', 'custom-thing', 'porn']);
    expect(inbound.find((l) => l.val === 'spam')).toBeUndefined();
    expect(inbound.find((l) => l.val === 'custom-thing')!.flagId).toBeNull();
    const hide = inbound.find((l) => l.val === '!hide')!;
    const flag = await h.s.guard.flags.get(h.tenantId, hide.flagId!);
    expect(flag).toMatchObject({ kind: 'report', checkpoint: 'atproto-label', severity: 'high', state: 'open', source_kind: 'atproto-label' });
    const rejected = (await h.s.db('audit_events').where({ action: 'atproto.label.rejected' })) as { detail: string; target: string }[];
    expect(rejected).toHaveLength(1);
    expect(JSON.parse(rejected[0]!.detail)).toMatchObject({ reason: 'signature', val: 'spam' });

    // The next pull resumes from the cursor; nothing is stored twice. After the labeler rotates its key, its new
    // labels verify once its document is fetched again.
    ext.rotate();
    ext.add([ext.label('at://did:plc:victim/app.bsky.feed.post/5', '!hide')]);
    const r2 = await h.s.atproto.pull({ tenantId: h.tenantId, userId: null, actor: { service: 'test' } }, (await h.s.atproto.labeler(h.tenantId, reg.body.id))!, { idleMs: 500 });
    expect(r2).toMatchObject({ accepted: 1, rejected: 0, cursor: 4 });
    expect(ext.cursors.at(-1)).toBe('3');
    expect((await h.s.atproto.labeler(h.tenantId, reg.body.id))!.multikey).toBe(ext.key.multikey);
  });

  it('B-1611: a labeler DID that resolves to a metadata address is refused by the service URL checks', async () => {
    const r = await a.post('/api/atproto/labelers', { did: 'did:web:169.254.169.254', name: 'Bad' });
    expect(r.status).toBe(502);
    expect(r.body.detail).toMatch(/metadata/);
  });
});

describe('Sprint 25: AT-Protocol keys in OpenBao transit (P-256 only)', () => {
  let bao: FakeOpenBao;
  let h: Harness;

  beforeAll(async () => {
    bao = new FakeOpenBao();
    await bao.start();
    h = await harness({ KMS_PROVIDER: 'openbao', OPENBAO_ADDR: bao.url, OPENBAO_TOKEN: bao.token, ATPROTO_PUBLIC_URL: 'https://bao.example.test' });
  }, 60_000);

  afterAll(async () => {
    await h?.close();
    await bao?.stop();
  });

  it('refuses secp256k1 (transit has none), makes P-256 keys in transit and signs low-S labels with them', async () => {
    const by = { tenantId: h.tenantId, userId: null, actor: { service: 'test' } };
    expect(h.s.atproto.info()).toMatchObject({ custody: 'openbao', curves: ['p256'], defaultCurve: 'p256' });
    await expect(h.s.atproto.createIdentity(by, null, { method: 'web', curve: 'secp256k1' })).rejects.toThrow(/secp256k1/);
    const i = await h.s.atproto.createIdentity(by, null, { method: 'web' });
    const [key] = await h.s.atproto.keysOf(i.id);
    expect(key).toMatchObject({ custody: 'openbao', curve: 'p256', key_wrapped: null });
    expect(bao.keys.get(key!.key_name)?.type).toBe('ecdsa-p256');
    const doc = await h.s.atproto.document(i);
    for (let n = 0; n < 6; n++) await h.s.atproto.emit(by, h.tenantId, { uri: `at://did:plc:bao/app.bsky.feed.post/${n}`, vals: ['!warn'] });
    const { curve, key: pub } = parseMultikey(doc.verificationMethod[0]!.publicKeyMultibase);
    for (const l of await h.s.atproto.labelsAfter(i.id, 0, 10)) {
      expect(isLowS(curve, l.label.sig!)).toBe(true);
      expect(verifySignature(curve, pub, labelSigningBytes(l.label), l.label.sig!)).toBe(true);
    }
  });
});

describe('Sprint 25: AT-Protocol without key custody', () => {
  it('refuses to make identities when neither the signer nor OpenBao holds keys', async () => {
    const h = await harness();
    try {
      await expect(h.s.atproto.createIdentity({ tenantId: h.tenantId, userId: null, actor: { service: 'test' } }, null, { method: 'web' })).rejects.toThrow(/signer/);
      expect(h.s.atproto.info().custody).toBeNull();
    } finally {
      await h.close();
    }
  });
});
