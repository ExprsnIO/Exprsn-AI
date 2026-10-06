import type { KeyObject } from 'node:crypto';
import { cborDecode, cborEncode, type CborValue } from '../cbor.js';
import { verifySignature, type Curve } from '../crypto.js';
import { Cid } from '../encoding.js';
import { readCarVerified, writeCar, type CarFile } from './car.js';
import { buildMst, coveringProof, loadMst, mstPath, walkNodes, type MstLeaf, type MstTree } from './mst.js';
import { TID_RE } from './tid.js';

/*
 * Signed commits (B-2902, https://atproto.com/specs/repository#commit-objects). A repository's head is a commit, the
 * DAG-CBOR map `{ did, version: 3, data, rev, prev: null, sig }`: `data` the MST root, `rev` a TID that grows with
 * every commit, `prev` kept (and null) for version 2 readers, and `sig` the account's signing key's ECDSA-SHA256
 * signature (compact, low-S) over the DAG-CBOR of the same map without `sig`. The signature is made in the signer or
 * OpenBao transit (`keys.ts`); nothing here holds a private key.
 *
 * `verifyRepoCar` is what a relay or a migrating PDS does with an exported repository: read the CAR file, check every
 * block's hash, the commit's signature against the DID's `#atproto` key, and the MST's canonical shape, and return the
 * records. It is how the tests prove that "a repo exported as CAR verifies against its signed commit".
 */

export interface UnsignedCommit {
  did: string;
  version: 3;
  data: Cid;
  rev: string;
  prev: Cid | null;
}

export interface SignedCommit extends UnsignedCommit {
  sig: Buffer;
}

export class RepoError extends Error {}

/**
 * The bytes a commit's signature covers: the commit object without `sig`, as DAG-CBOR. Every other field is signed as
 * it is, so the relay check (B-3604, `../commit.ts`) verifies a foreign commit (version 2, or with fields this server
 * does not write) exactly as it was made; this server's commits pass the five fields of `UnsignedCommit`.
 */
export const commitSigningBytes = (c: UnsignedCommit | Record<string, unknown>): Buffer => cborEncode({ ...(c as Record<string, CborValue>), sig: undefined });

const unsigned = (c: UnsignedCommit): UnsignedCommit => ({ did: c.did, version: c.version, data: c.data, rev: c.rev, prev: c.prev });

export async function signCommit(c: UnsignedCommit, sign: (bytes: Buffer) => Promise<Buffer>): Promise<{ commit: SignedCommit; bytes: Buffer; cid: Cid }> {
  const sig = await sign(commitSigningBytes(unsigned(c)));
  const commit: SignedCommit = { ...c, sig };
  const bytes = cborEncode({ did: c.did, version: c.version, data: c.data, rev: c.rev, prev: c.prev, sig });
  return { commit, bytes, cid: Cid.ofCbor(bytes) };
}

/** Reads a commit block; refuses anything but a version 3 commit with the fields it must have. */
export function decodeCommit(bytes: Uint8Array): SignedCommit {
  const v = cborDecode(bytes) as Record<string, CborValue> | null;
  if (!v || typeof v !== 'object' || Array.isArray(v) || Buffer.isBuffer(v) || v instanceof Cid) throw new RepoError('A commit is a map');
  if (v.version !== 3) throw new RepoError('Only version 3 commits are read');
  if (typeof v.did !== 'string' || !v.did.startsWith('did:')) throw new RepoError('A commit names its DID');
  if (!(v.data instanceof Cid)) throw new RepoError('A commit links its MST root');
  if (typeof v.rev !== 'string' || !TID_RE.test(v.rev)) throw new RepoError('A commit’s rev is a TID');
  if (v.prev !== null && v.prev !== undefined && !(v.prev instanceof Cid)) throw new RepoError('A commit’s prev is a link or null');
  if (!Buffer.isBuffer(v.sig) || v.sig.length !== 64) throw new RepoError('A commit carries a 64-byte signature');
  return { did: v.did, version: 3, data: v.data, rev: v.rev, prev: (v.prev as Cid | null | undefined) ?? null, sig: v.sig };
}

export const verifyCommit = (c: SignedCommit, curve: Curve, key: KeyObject): boolean => verifySignature(curve, key, commitSigningBytes(unsigned(c)), c.sig);

export interface VerifiedRepo {
  did: string;
  commit: SignedCommit;
  commitCid: Cid;
  tree: MstTree;
  /** Each record's key, CID and DAG-CBOR bytes, in key order. */
  records: (MstLeaf & { bytes: Buffer })[];
  car: CarFile;
}

/**
 * Checks an exported repository: hashes, the signature (when a key is given; a migration checks it against the DID
 * document), the canonical MST, and that every record the tree names is present and is DAG-CBOR.
 */
export function verifyRepoCar(bytes: Buffer, o: { did?: string; key?: { curve: Curve; key: KeyObject } | null; maxBytes?: number; maxRecords?: number } = {}): VerifiedRepo {
  const car = readCarVerified(bytes, { ...(o.maxBytes !== undefined ? { maxBytes: o.maxBytes } : {}) });
  if (car.roots.length !== 1) throw new RepoError('A repository CAR file has exactly one root, its commit');
  const commitCid = car.roots[0]!;
  const cb = car.blocks.get(commitCid.toString());
  if (!cb) throw new RepoError('The commit block is missing');
  const commit = decodeCommit(cb);
  if (o.did && commit.did !== o.did) throw new RepoError(`The repository belongs to ${commit.did}, not ${o.did}`);
  if (o.key && !verifyCommit(commit, o.key.curve, o.key.key)) throw new RepoError('The commit’s signature does not verify against the account’s signing key');
  let tree: MstTree;
  try {
    tree = loadMst(car.blocks, commit.data, { ...(o.maxRecords !== undefined ? { maxLeaves: o.maxRecords } : {}) });
  } catch (err) {
    throw new RepoError((err as Error).message);
  }
  const records = tree.leaves.map((l) => {
    const b = car.blocks.get(l.value.toString());
    if (!b) throw new RepoError(`The record ${l.key} (${l.value.toString()}) is missing`);
    try {
      cborDecode(b);
    } catch (err) {
      throw new RepoError(`The record ${l.key} is not DAG-CBOR: ${(err as Error).message}`);
    }
    return { ...l, bytes: b };
  });
  return { did: commit.did, commit, commitCid, tree, records, car };
}

/** The whole repository as a CAR file: the commit, then the tree depth first with each record after its entry. */
export function repoCar(commitCid: Cid, commitBytes: Buffer, tree: MstTree, record: (cid: Cid) => Buffer | undefined): Buffer {
  const blocks: [Cid, Buffer][] = [[commitCid, commitBytes]];
  for (const x of walkNodes(tree.root)) {
    if ('node' in x) blocks.push([x.node.cid, x.node.bytes]);
    else {
      const b = record(x.leaf.value);
      if (!b) throw new RepoError(`The record ${x.leaf.key} is missing from the store`);
      blocks.push([x.leaf.value, b]);
    }
  }
  return writeCar(commitCid, blocks);
}

/** A record with its proof (`com.atproto.sync.getRecord`): the commit, the MST path to the key and the record. */
export function recordProofCar(commitCid: Cid, commitBytes: Buffer, tree: MstTree, key: string, record: Buffer | null): Buffer {
  const blocks: [Cid, Buffer][] = [[commitCid, commitBytes]];
  for (const n of mstPath(tree, key)) blocks.push([n.cid, n.bytes]);
  const value = tree.leaves.find((l) => l.key === key)?.value;
  if (value && record) blocks.push([value, record]);
  return writeCar(commitCid, blocks);
}

export { buildMst, coveringProof };
