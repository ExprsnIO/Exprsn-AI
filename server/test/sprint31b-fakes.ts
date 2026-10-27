import { cborEncode } from '../src/atproto/cbor.js';
import type { Curve } from '../src/atproto/crypto.js';
import { didDocument } from '../src/atproto/did.js';
import { Cid } from '../src/atproto/encoding.js';
import { buildMst as buildPdsMst, mstPath } from '../src/atproto/pds/mst.js';
import { commitSigningBytes } from '../src/atproto/pds/repo.js';
import { testKey, type FakePlcDirectory } from './sprint25b-fakes.js';

/*
 * Test doubles for Sprint 31b (B-3604, B-3001): the server's Merkle search tree (checked against the reference
 * implementation's vectors in `fixtures/atproto/`) in the shape these tests use, a repo that signs its commits and emits subscribeRepos `#commit`
 * frames, and a service-JWT issuer (an AppView or a user's PDS) whose DID document the fake PLC directory serves.
 */

export interface MstTree {
  root: Cid;
  /** Every node of the tree by CID string. */
  nodes: Map<string, Buffer>;
  /** The nodes on the way from the root to a key (where it is, or where it would be). */
  path(key: string): string[];
}

/** The MST for a set of keys and value CIDs: the server's own tree (`pds/mst.ts`), in the shape these tests use. */
export function buildMst(entries: Map<string, Cid> | [string, Cid][]): MstTree {
  const tree = buildPdsMst([...entries].map(([key, value]) => ({ key, value })), { checkKeys: false });
  return { root: tree.root.cid, nodes: tree.blocks, path: (key) => mstPath(tree, key).map((n) => n.cid.toString()) };
}

export interface RepoOp {
  collection: string;
  rkey: string;
  record: Record<string, unknown> | null;
  action?: 'create' | 'update' | 'delete';
}

/** A repo whose commits are signed with its `#atproto` key and served as subscribeRepos frames. */
export class FakeRepo {
  readonly key: ReturnType<typeof testKey>;
  readonly records = new Map<string, { cid: Cid; bytes: Buffer }>();
  private rev = 0;

  constructor(
    readonly did: string,
    curve: Curve = 'secp256k1'
  ) {
    this.key = testKey(curve);
  }

  document(key = this.key) {
    return didDocument(this.did, { alsoKnownAs: [`at://${this.did.slice(8, 16)}.example.org`], verificationMethods: { atproto: key.didKey }, services: { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: 'https://pds.example.org' } } });
  }

  /** Registers the DID document with the fake PLC directory. */
  publish(plc: FakePlcDirectory): this {
    plc.documents.set(this.did, this.document());
    return this;
  }

  /**
   * A `#commit` frame for these operations. `tamper` breaks it in one way: a signature by another key, a record
   * swapped after signing, a node left out of the CAR, or the commit naming another repo.
   */
  commit(seq: number, ops: RepoOp[], tamper?: 'signature' | 'record' | 'missing-node' | 'repo'): Buffer {
    const wireOps: { action: string; path: string; cid: Cid | null }[] = [];
    const recordBlocks: Buffer[] = [];
    for (const o of ops) {
      const path = `${o.collection}/${o.rkey}`;
      if (!o.record) {
        this.records.delete(path);
        wireOps.push({ action: 'delete', path, cid: null });
        continue;
      }
      const bytes = cborEncode({ $type: o.collection, ...o.record });
      const cid = Cid.ofCbor(bytes);
      const action = o.action ?? (this.records.has(path) ? 'update' : 'create');
      this.records.set(path, { cid, bytes });
      recordBlocks.push(bytes);
      wireOps.push({ action, path, cid });
    }
    const tree = buildMst([...this.records].map(([k, v]) => [k, v.cid]));
    this.rev++;
    const rev = `3l${String(this.rev).padStart(11, '0')}`;
    const unsigned = { did: tamper === 'repo' ? 'did:plc:someoneelseaaaaaaaaaaaa' : this.did, version: 3, data: tree.root, rev, prev: null };
    const signer = tamper === 'signature' ? testKey('secp256k1') : this.key;
    const commit = { ...unsigned, sig: signer.sign(commitSigningBytes(unsigned)) };
    const commitBytes = cborEncode(commit);
    // The diff: the nodes on the way to every path the commit touched.
    const needed = new Set<string>();
    for (const o of wireOps) for (const c of tree.path(o.path)) needed.add(c);
    if (tamper === 'missing-node') needed.delete([...needed].at(-1)!);
    const blocks = [commitBytes, ...[...needed].map((c) => tree.nodes.get(c)!)].map((bytes) => ({ cid: Cid.ofCbor(bytes), bytes }));
    for (const bytes of recordBlocks) {
      // 'record': the CID the tree signed, with other bytes in the CAR (the record no longer hashes to it).
      const forged = tamper === 'record' ? Buffer.concat([bytes.subarray(0, -1), Buffer.from([bytes.at(-1)! ^ 1])]) : bytes;
      blocks.push({ cid: Cid.ofCbor(bytes), bytes: forged });
    }
    return frame(seq, this.did, rev, Cid.ofCbor(commitBytes), wireOps, carWithCids(blocks));
  }
}

function frame(seq: number, did: string, rev: string, commit: Cid, ops: { action: string; path: string; cid: Cid | null }[], blocks: Buffer): Buffer {
  return Buffer.concat([cborEncode({ op: 1, t: '#commit' }), cborEncode({ seq, repo: did, rev, since: null, commit, ops, blocks, time: new Date().toISOString(), tooBig: false, rebase: false, blobs: [] })]);
}

/** A CAR file whose blocks are filed under the given CIDs (which may not match their bytes). */
export function carWithCids(blocks: { cid: Cid; bytes: Buffer }[]): Buffer {
  const header = cborEncode({ version: 1, roots: blocks.slice(0, 1).map((b) => b.cid) });
  const enc = (n: number) => {
    const out: number[] = [];
    let v = n;
    do {
      let b = v & 0x7f;
      v = Math.floor(v / 128);
      if (v > 0) b |= 0x80;
      out.push(b);
    } while (v > 0);
    return Buffer.from(out);
  };
  const parts = [enc(header.length), header];
  for (const b of blocks) parts.push(enc(b.cid.bytes.length + b.bytes.length), b.cid.bytes, b.bytes);
  return Buffer.concat(parts);
}

/** A party that signs inter-service JWTs (an AppView, or a user's PDS on their behalf). */
export class FakeServiceIssuer {
  readonly key: ReturnType<typeof testKey>;

  constructor(
    readonly did: string,
    readonly curve: Curve = 'secp256k1'
  ) {
    this.key = testKey(curve);
  }

  document() {
    return didDocument(this.did, { alsoKnownAs: [], verificationMethods: { atproto: this.key.didKey }, services: {} });
  }

  publish(plc: FakePlcDirectory): this {
    plc.documents.set(this.did, this.document());
    return this;
  }

  /** A service JWT for `aud`; `o` overrides claims or signs with another key. */
  jwt(aud: string, o: { lxm?: string | null; exp?: number; iat?: number; iss?: string; alg?: string; key?: ReturnType<typeof testKey>; highS?: boolean } = {}): string {
    const now = Math.floor(Date.now() / 1000);
    const header = { typ: 'JWT', alg: o.alg ?? (this.curve === 'secp256k1' ? 'ES256K' : 'ES256') };
    const payload: Record<string, unknown> = { iss: o.iss ?? this.did, aud, exp: o.exp ?? now + 60, iat: o.iat ?? now, jti: Math.random().toString(36).slice(2) };
    if (o.lxm !== null) payload.lxm = o.lxm ?? 'app.bsky.feed.getFeedSkeleton';
    const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    const k = o.key ?? this.key;
    let sig = k.sign(Buffer.from(input));
    if (o.highS) sig = highS(this.curve, sig);
    return `${input}.${sig.toString('base64url')}`;
  }
}

/** The malleable high-S twin of a signature (valid ECDSA, refused by AT-Protocol). */
function highS(curve: Curve, sig: Buffer): Buffer {
  const n = curve === 'secp256k1' ? 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n : 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const s = BigInt('0x' + sig.subarray(32).toString('hex'));
  return Buffer.concat([sig.subarray(0, 32), Buffer.from((n - s).toString(16).padStart(64, '0'), 'hex')]);
}

