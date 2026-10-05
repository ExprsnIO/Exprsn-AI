/*
 * 1.5.0, Sprint 31 (B-2902): the repository format byte for byte. The Merkle search tree against the AT-Protocol
 * interop fixtures (key heights, the sync 1.1 commit proofs with their roots before and after, and their covering
 * proofs) and against root CIDs computed with the reference implementation (@atproto/repo 0.11.0, the scripts in
 * fixtures/atproto-ref); a reference repository exported as CAR, read, verified against its signed commit and written
 * again; TIDs; and the strict CAR reader refusing what it must.
 */
import { createHash, createPublicKey, sign as cryptoSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cborEncode } from '../src/atproto/cbor.js';
import { compressPublicKey, normaliseLowS, parseDidKey } from '../src/atproto/crypto.js';
import { Cid, CODEC_RAW, sha256 } from '../src/atproto/encoding.js';
import { carBlock, carHeader, readCarVerified, writeCar } from '../src/atproto/pds/car.js';
import { buildMst, coveringProof, decodeNode, keyHeight, loadMst, mstGet, mstPath } from '../src/atproto/pds/mst.js';
import { commitSigningBytes, decodeCommit, recordProofCar, repoCar, signCommit, verifyCommit, verifyRepoCar } from '../src/atproto/pds/repo.js';
import { nextTid, TID_RE, tidFrom, tidMicros } from '../src/atproto/pds/tid.js';
import { keyFromScalar } from './sprint25b-fakes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (p: string) => readFileSync(path.join(here, 'fixtures', p), 'utf8');
const LEAF = Cid.parse('bafyreie5cvv4h45feadgeuwhbcutmh6t2ceseocckahdoe6uat64zmz454');
const leaves = (keys: string[]) => keys.map((key) => ({ key, value: LEAF }));

describe('Merkle search tree (B-2902)', () => {
  it('gives each key the height of the interop fixtures', () => {
    for (const k of JSON.parse(fixture('atproto-interop/mst/key_heights.json')) as { key: string; height: number }[]) expect(keyHeight(k.key), k.key).toBe(k.height);
  });

  it('has the reference CIDs for the empty and the one-key tree', () => {
    expect(buildMst([]).root.cid.toString()).toBe('bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm');
    expect(buildMst(leaves(['com.example.record/3jqfcqzm3fo2j'])).root.cid.toString()).toBe('bafyreibj4lsc3aqnrvphp5xmrnfoorvru4wynt6lwidqbm2623a6tatzdu');
  });

  it('matches every sync 1.1 commit-proof fixture: roots before and after, and the blocks of the proof', () => {
    const fx = JSON.parse(fixture('atproto-interop/firehose/commit-proof-fixtures.json')) as { comment: string; leafValue: string; keys: string[]; adds: string[]; dels: string[]; rootBeforeCommit: string; rootAfterCommit: string; blocksInProof: string[] }[];
    expect(fx.length).toBeGreaterThanOrEqual(6);
    for (const f of fx) {
      const v = Cid.parse(f.leafValue);
      const before = buildMst(f.keys.map((key) => ({ key, value: v })));
      expect(before.root.cid.toString(), f.comment).toBe(f.rootBeforeCommit);
      const keys = new Set(f.keys);
      for (const d of f.dels) keys.delete(d);
      for (const a of f.adds) keys.add(a);
      const after = buildMst([...keys].map((key) => ({ key, value: v })));
      expect(after.root.cid.toString(), f.comment).toBe(f.rootAfterCommit);
      const proof = new Map<string, Buffer>();
      for (const k of [...f.adds, ...f.dels]) coveringProof(after, k, proof);
      expect([...proof.keys()].sort(), f.comment).toEqual([...f.blocksInProof].sort());
      // Reading the tree back from its blocks gives the same keys and refuses nothing.
      expect(loadMst(after.blocks, after.root.cid).leaves.map((l) => l.key)).toEqual([...keys].sort());
    }
  });

  it('matches the reference root CIDs for the example keys and a 600-key repo, before and after deletes', () => {
    const example = fixture('atproto-interop/mst/example_keys.txt').split('\n').map((s) => s.trim()).filter(Boolean);
    const cols = ['app.bsky.feed.post', 'app.bsky.feed.like', 'app.bsky.graph.follow'];
    const big = Array.from({ length: 600 }, (_, i) => `${cols[i % 3]}/${createHash('sha256').update(String(i)).digest('hex').slice(0, 13)}`);
    // Generated with @atproto/repo 0.11.0 (fixtures/atproto-ref/gen-mst.mjs.txt): adds in order, then every third key deleted.
    const cases: [string[], string, string][] = [
      [example, 'bafyreicp3ghg3qdepi7bx3letryyerzfoky5htzymzljibxhd3m3z3xfb4', 'bafyreibe4beesz6ucdwmv52sn6fozxypd3f2fufybcwq7prkltjc4urzia'],
      [big, 'bafyreicllx6k7weeaerra3aszvrixsbtt7mx6z7jhutow7xrasqgioa4ru', 'bafyreif53dbi5a72cuufz46gjjopthzauwsgerumec6jrxzh5niyk6rnwm']
    ];
    for (const [keys, full, thinned] of cases) {
      expect(buildMst(leaves(keys)).root.cid.toString()).toBe(full);
      expect(buildMst(leaves(keys.filter((_, i) => i % 3 !== 0))).root.cid.toString()).toBe(thinned);
      // Any insertion order gives the same tree.
      expect(buildMst(leaves([...keys].reverse())).root.cid.toString()).toBe(full);
    }
  });

  it('finds values and paths, and refuses a tree that is not canonical or not a tree', () => {
    const keys = ['app.bsky.feed.post/3jzfcijpj2z2a', 'app.bsky.feed.post/3jzfcijpj2z2b', 'app.bsky.actor.profile/self'];
    const t = buildMst(leaves(keys));
    expect(mstGet(t, keys[0]!)?.equals(LEAF)).toBe(true);
    expect(mstGet(t, 'app.bsky.feed.post/nope')).toBeNull();
    expect(mstPath(t, keys[1]!)[0]!.cid.equals(t.root.cid)).toBe(true);
    // Two keys in the wrong order inside one node.
    const bad = cborEncode({ l: null, e: [{ p: 0, k: Buffer.from('b/1'), v: LEAF, t: null }, { p: 0, k: Buffer.from('a/1'), v: LEAF, t: null }] });
    expect(() => loadMst(new Map([[Cid.ofCbor(bad).toString(), bad]]), Cid.ofCbor(bad))).toThrow(/order/);
    // A key at the wrong layer: a valid node shape but not the tree its keys make.
    const low = keys.find((k) => keyHeight(k) === 0)!;
    const wrong = cborEncode({ l: null, e: [{ p: 0, k: Buffer.from(low), v: LEAF, t: null }] });
    const lifted = cborEncode({ l: Cid.ofCbor(wrong), e: [] });
    const blocks = new Map([[Cid.ofCbor(wrong).toString(), wrong], [Cid.ofCbor(lifted).toString(), lifted]]);
    expect(() => loadMst(blocks, Cid.ofCbor(lifted))).toThrow(/canonical/);
    expect(() => decodeNode(cborEncode({ l: null, e: [], x: 1 }))).toThrow(/map of e and l/);
    expect(() => buildMst(leaves(['no-slash']))).toThrow(/repository key/);
    expect(() => buildMst(leaves(['a.b.c/x', 'a.b.c/x']))).toThrow(/twice/);
  });
});

describe('commits and CAR files (B-2902)', () => {
  const ref = JSON.parse(fixture('atproto-ref/repo.json')) as { did: string; commit: string; data: string; rev: string; sig: string; car: string; pub: string };
  const pub = parseDidKey(ref.pub);

  it('reads a reference repository, verifies it against its signed commit, and writes the same blocks back', () => {
    const car = Buffer.from(ref.car, 'base64');
    const v = verifyRepoCar(car, { did: ref.did, key: { curve: pub.curve, key: pub.key } });
    expect(v.commitCid.toString()).toBe(ref.commit);
    expect(v.commit).toMatchObject({ did: ref.did, version: 3, rev: ref.rev, prev: null });
    expect(v.commit.data.toString()).toBe(ref.data);
    expect(v.commit.sig.toString('hex')).toBe(ref.sig);
    expect(v.records.map((r) => r.key)).toEqual(['app.bsky.actor.profile/self', 'app.bsky.feed.post/3jzfcijpj2z2a', 'app.bsky.feed.post/3jzfcijpj2z2b']);
    // The commit's bytes and CID are what this code would sign and hash.
    const unsigned = { did: v.commit.did, version: 3 as const, data: v.commit.data, rev: v.commit.rev, prev: null };
    expect(verifyCommit(v.commit, pub.curve, pub.key)).toBe(true);
    expect(Cid.ofCbor(cborEncode({ ...unsigned, sig: v.commit.sig })).toString()).toBe(ref.commit);
    // Our export of the same repository has the same blocks (the order differs: a CAR file's order is free).
    const ours = repoCar(v.commitCid, v.car.blocks.get(ref.commit)!, v.tree, (c) => v.car.blocks.get(c.toString()));
    const back = readCarVerified(ours);
    expect([...back.blocks.keys()].sort()).toEqual([...v.car.blocks.keys()].sort());
    expect(back.roots.map(String)).toEqual([ref.commit]);
    // A record proof is the commit, the path and the record, and verifies on its own.
    const proof = readCarVerified(recordProofCar(v.commitCid, v.car.blocks.get(ref.commit)!, v.tree, 'app.bsky.feed.post/3jzfcijpj2z2b', v.records[2]!.bytes));
    expect(proof.blocks.has(v.records[2]!.value.toString())).toBe(true);
    expect(proof.blocks.has(v.tree.root.cid.toString())).toBe(true);
  });

  it('refuses a changed signature, another DID, a missing record and a block that does not hash to its CID', () => {
    const car = Buffer.from(ref.car, 'base64');
    expect(() => verifyRepoCar(car, { did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa' })).toThrow(/belongs to/);
    const wrongKey = keyFromScalar('secp256k1', Buffer.alloc(32, 9));
    expect(() => verifyRepoCar(car, { key: { curve: 'secp256k1', key: createPublicKey(wrongKey.privateKey) } })).toThrow(/signature/);
    // Drop one record.
    const v = readCarVerified(car);
    const recCid = verifyRepoCar(car).records[0]!.value.toString();
    const missing = writeCar(Cid.parse(ref.commit), [...v.blocks].filter(([cid]) => cid !== recCid));
    expect(() => verifyRepoCar(missing)).toThrow(/missing/);
    // Flip a byte inside a block.
    const tampered = Buffer.from(car);
    tampered[tampered.length - 3] ^= 0xff;
    expect(() => readCarVerified(tampered)).toThrow(/hash/);
    // A truncated file, an empty header, a CIDv0-shaped block.
    expect(() => readCarVerified(car.subarray(0, car.length - 5))).toThrow(/truncated/);
    expect(() => readCarVerified(Buffer.from([0]))).toThrow();
    expect(() => readCarVerified(Buffer.concat([carHeader([]), Buffer.from([4, 0x12, 0x20, 0, 0])]))).toThrow(/CID/);
  });

  it('signs a commit through a signing function and verifies it; the signed bytes leave out sig', async () => {
    const k = keyFromScalar('secp256k1', Buffer.from('9085d2bef69286a6cbb51623c8fa258629945cd55ca705cc4e66700396894e0c', 'hex'));
    const data = buildMst([]).root.cid;
    const signed = await signCommit({ did: 'did:plc:hnh3tcejlpahnoxb7ieqdpmu', version: 3, data, rev: nextTid(), prev: null }, async (bytes) => normaliseLowS('secp256k1', cryptoSign('sha256', bytes, { key: k.privateKey, dsaEncoding: 'ieee-p1363' })));
    expect(verifyCommit(decodeCommit(signed.bytes), 'secp256k1', createPublicKey(k.privateKey))).toBe(true);
    expect(commitSigningBytes(signed.commit).includes(signed.commit.sig)).toBe(false);
    expect(compressPublicKey(createPublicKey(k.privateKey)).curve).toBe('secp256k1');
    expect(() => decodeCommit(cborEncode({ did: 'did:x', version: 2 }))).toThrow(/version 3/);
  });

  it('writes CAR headers and blocks as the format says', () => {
    const raw = Buffer.from('blob bytes');
    const cid = Cid.create(CODEC_RAW, sha256(raw));
    const car = writeCar(cid, [[cid, raw], [cid, raw]]);
    // {roots:[cid], version:1}: the header, then one block (duplicates written once).
    expect(car.subarray(0, carHeader([cid]).length).equals(carHeader([cid]))).toBe(true);
    expect(car.length).toBe(carHeader([cid]).length + carBlock(cid, raw).length);
    expect(readCarVerified(car).blocks.get(cid.toString())).toEqual(raw);
  });
});

describe('TIDs (B-2902)', () => {
  it('are 13 sortable characters that only grow, even after the given rev', () => {
    const a = nextTid();
    const b = nextTid();
    expect(TID_RE.test(a) && TID_RE.test(b)).toBe(true);
    expect(b > a).toBe(true);
    const future = tidFrom(BigInt(Date.now() + 3600_000) * 1000n, 5n);
    const c = nextTid(future);
    expect(c > future).toBe(true);
    expect(tidMicros(c)).toBe(tidMicros(future) + 1n);
    // The reference's timestamp layout: 3jzfcijpj2z2a decodes to a time in 2023.
    expect(new Date(Number(tidMicros('3jzfcijpj2z2a') / 1000n)).getUTCFullYear()).toBe(2023);
    for (const line of fixture('atproto-interop/syntax/tid_syntax_valid.txt').split('\n').filter((l) => l && !l.startsWith('#'))) expect(TID_RE.test(line.trim()), line).toBe(true);
  });
});
