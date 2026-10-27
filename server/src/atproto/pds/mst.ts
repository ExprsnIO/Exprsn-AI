import { cborDecode, cborEncode, type CborValue } from '../cbor.js';
import { Cid, CODEC_DAG_CBOR, sha256 } from '../encoding.js';
import { blockMatches } from './car.js';

/*
 * The Merkle search tree of an AT-Protocol repository (B-2902, https://atproto.com/specs/repository#mst-structure).
 *
 * Keys are `<collection>/<record key>` and values the CIDs of the records. A key's height is the number of leading
 * zero bits of SHA-256(key) divided by two (rounded down), i.e. a fanout of four. The tree's shape is fixed by its set
 * of keys alone: the root sits at the greatest height of any key and holds the keys of that height in order; the keys
 * between two of them (and before the first, and after the last) form a subtree one layer down, recursively. A layer
 * with no key of its own in a gap still gets a node, with no entries and only a left link to the layer below, so a
 * subtree is always exactly one layer below its parent. An empty repository's tree is a single empty node.
 *
 * A node is DAG-CBOR `{ l: CID | null, e: [{ p, k, v, t }] }`: `l` the subtree left of the first entry, each entry's
 * key as the length `p` of the prefix it shares with the previous key in the node and the rest `k` (bytes), its value
 * `v` and the subtree `t` to its right. `null` links are written, never left out.
 *
 * Because the shape depends only on the keys, the tree is rebuilt from the sorted key list rather than edited in
 * place: `buildMst` gives every node with its CID and bytes, and a commit's new nodes are the ones not in the previous
 * tree. `loadMst` reads a tree from blocks (a CAR file) and refuses one that is not canonical: rebuilding it from its
 * own keys must give the same root CID. The proofs follow the reference implementation's covering proofs, which a
 * commit sends on the firehose so a relay can check the operations against the previous tree (sync 1.1).
 * `mstLookup` is the other side: the relay commit check (B-3604, `../commit.ts`) walks a partial tree, only the
 * blocks a `#commit` frame carries, to prove each operation's value or absence.
 *
 * This module is the one MST implementation: the PDS (B-2902), the relay commit verification (B-3604) and the test
 * doubles of both build and read trees here. Known answers: `server/test/fixtures/atproto-interop/mst/`,
 * `firehose/commit-proof-fixtures.json` and the same vectors in `server/test/fixtures/atproto/`.
 */

export interface MstLeaf {
  key: string;
  value: Cid;
}

export interface MstNode {
  cid: Cid;
  bytes: Buffer;
  layer: number;
  left: MstNode | null;
  entries: { key: string; value: Cid; right: MstNode | null }[];
}

export interface MstTree {
  root: MstNode;
  /** Every node's block, by CID string. */
  blocks: Map<string, Buffer>;
  leaves: MstLeaf[];
}

export class MstError extends Error {}

/** MST keys: a collection NSID, a slash and a record key, in the characters both allow; at most 1024 bytes. */
export const MST_KEY_RE = /^[a-zA-Z0-9.-]{1,317}\/[A-Za-z0-9._:~-]{1,512}$/;

/** The key's layer: leading zero bits of SHA-256(key), two bits per layer. */
export function keyHeight(key: string | Uint8Array): number {
  const h = sha256(typeof key === 'string' ? Buffer.from(key, 'utf8') : key);
  let zeros = 0;
  for (const b of h) {
    if (b === 0) {
      zeros += 8;
      continue;
    }
    zeros += Math.clz32(b) - 24;
    break;
  }
  return Math.floor(zeros / 2);
}

const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

function commonPrefix(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/** The DAG-CBOR form of a node from its parts. */
export function encodeNode(left: Cid | null, entries: { key: string; value: Cid; right: Cid | null }[]): Buffer {
  let prev = Buffer.alloc(0);
  const e = entries.map((x) => {
    const k = Buffer.from(x.key, 'utf8');
    const p = commonPrefix(prev, k);
    prev = k;
    return { p, k: k.subarray(p), v: x.value, t: x.right };
  });
  return cborEncode({ l: left, e });
}

interface Item extends MstLeaf {
  height: number;
}

function buildNode(items: Item[], layer: number, blocks: Map<string, Buffer>): MstNode {
  let left: MstNode | null = null;
  const entries: MstNode['entries'] = [];
  let run: Item[] = [];
  const flush = () => {
    if (!run.length) return;
    const sub = buildNode(run, layer - 1, blocks);
    run = [];
    if (entries.length) entries[entries.length - 1]!.right = sub;
    else left = sub;
  };
  for (const it of items) {
    if (it.height === layer) {
      flush();
      entries.push({ key: it.key, value: it.value, right: null });
    } else run.push(it);
  }
  flush();
  const l = left as MstNode | null;
  const bytes = encodeNode(l?.cid ?? null, entries.map((e) => ({ key: e.key, value: e.value, right: e.right?.cid ?? null })));
  const cid = Cid.ofCbor(bytes);
  blocks.set(cid.toString(), bytes);
  return { cid, bytes, layer, left: l, entries };
}

/** Builds the tree of a set of leaves (any order; keys must be distinct and valid). */
export function buildMst(leaves: readonly MstLeaf[], o: { checkKeys?: boolean } = {}): MstTree {
  const sorted = [...leaves].sort((a, b) => byteOrder(a.key, b.key));
  for (let i = 0; i < sorted.length; i++) {
    if (o.checkKeys !== false && !MST_KEY_RE.test(sorted[i]!.key)) throw new MstError(`${sorted[i]!.key} is not a repository key`);
    if (i > 0 && sorted[i - 1]!.key === sorted[i]!.key) throw new MstError(`The key ${sorted[i]!.key} appears twice`);
  }
  const items: Item[] = sorted.map((l) => ({ ...l, height: keyHeight(l.key) }));
  const top = items.reduce((m, x) => Math.max(m, x.height), 0);
  const blocks = new Map<string, Buffer>();
  const root = buildNode(items, top, blocks);
  return { root, blocks, leaves: sorted };
}

// ---------- reading a tree from blocks ----------

const isMap = (v: unknown): v is Record<string, CborValue> => !!v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v) && !(v instanceof Cid);

interface NodeParts {
  left: Cid | null;
  /** Full keys, as bytes. */
  entries: { key: Buffer; value: Cid; right: Cid | null }[];
}

/**
 * A decoded node's left link and entries, with each key rebuilt from its prefix length. `exact` (reading a whole
 * repository) refuses any field but `l`, `e` and `p`, `k`, `v`, `t`; without it (the relay's proof walk) extra fields are
 * ignored, as the reference implementation's schema check does.
 */
function nodeParts(v: unknown, exact: boolean): NodeParts {
  if (!isMap(v) || (exact && Object.keys(v).sort().join(',') !== 'e,l')) throw new MstError('An MST node is a map of e and l');
  if (v.l !== null && !(v.l instanceof Cid)) throw new MstError('An MST node’s l is a link or null');
  if (!Array.isArray(v.e)) throw new MstError('An MST node’s e is an array');
  let prev = Buffer.alloc(0);
  const entries = v.e.map((x) => {
    if (!isMap(x) || (exact && Object.keys(x).sort().join(',') !== 'k,p,t,v')) throw new MstError('An MST entry is a map of k, p, t and v');
    if (typeof x.p !== 'number' || x.p < 0 || x.p > prev.length) throw new MstError('An MST entry’s prefix length is out of range');
    if (!Buffer.isBuffer(x.k) || !(x.v instanceof Cid) || (x.t !== null && !(x.t instanceof Cid))) throw new MstError('An MST entry’s k is bytes, v a link and t a link or null');
    const key = Buffer.concat([prev.subarray(0, x.p), x.k]);
    prev = key;
    return { key, value: x.v, right: x.t };
  });
  return { left: v.l, entries };
}

/** Decodes one node block into its left link and entries (with full keys); refuses anything not shaped like a node. */
export function decodeNode(bytes: Uint8Array): { left: Cid | null; entries: { key: string; value: Cid; right: Cid | null }[] } {
  const n = nodeParts(cborDecode(bytes), true);
  const entries = n.entries.map((e) => {
    const key = e.key.toString('utf8');
    if (!Buffer.from(key, 'utf8').equals(e.key)) throw new MstError('An MST key is not UTF-8');
    return { key, value: e.value, right: e.right };
  });
  return { left: n.left, entries };
}

/**
 * Reads the tree under `root` from `blocks` (by CID string): every leaf in key order. Refuses a missing node, a key
 * out of order or a tree whose shape is not the one its keys give (so two different trees can never carry the same
 * records), and caps the walk at `maxLeaves`.
 */
export function loadMst(blocks: ReadonlyMap<string, Uint8Array>, root: Cid, o: { maxLeaves?: number } = {}): MstTree {
  const max = o.maxLeaves ?? 1_000_000;
  const leaves: MstLeaf[] = [];
  const walk = (cid: Cid, depth: number) => {
    if (depth > 128) throw new MstError('The MST is too deep');
    const bytes = blocks.get(cid.toString());
    if (!bytes) throw new MstError(`The MST node ${cid.toString()} is missing`);
    const n = decodeNode(bytes);
    if (n.left) walk(n.left, depth + 1);
    for (const e of n.entries) {
      const last = leaves[leaves.length - 1];
      if (last && byteOrder(last.key, e.key) >= 0) throw new MstError('MST keys are out of order');
      if (leaves.length >= max) throw new MstError('The repository has too many records');
      leaves.push({ key: e.key, value: e.value });
      if (e.right) walk(e.right, depth + 1);
    }
  };
  walk(root, 0);
  const tree = buildMst(leaves, { checkKeys: false });
  if (!tree.root.cid.equals(root)) throw new MstError('The MST is not in canonical form (its keys give another tree)');
  return tree;
}

// ---------- lookups and proofs ----------

/** The value under a key, or null. */
export function mstGet(tree: MstTree, key: string): Cid | null {
  let node: MstNode | null = tree.root;
  while (node) {
    let next: MstNode | null = node.left;
    let found: Cid | null = null;
    for (const e of node.entries) {
      const c = byteOrder(key, e.key);
      if (c === 0) {
        found = e.value;
        break;
      }
      if (c < 0) break;
      next = e.right;
    }
    if (found) return found;
    node = next;
  }
  return null;
}

/** The nodes from the root down to where `key` is or would be (the inclusion or exclusion proof of a record). */
export function mstPath(tree: MstTree, key: string): MstNode[] {
  const out: MstNode[] = [];
  let node: MstNode | null = tree.root;
  while (node) {
    out.push(node);
    let next: MstNode | null = node.left;
    let stop = false;
    for (const e of node.entries) {
      const c = byteOrder(key, e.key);
      if (c === 0) {
        stop = true;
        break;
      }
      if (c < 0) break;
      next = e.right;
    }
    if (stop) break;
    node = next;
  }
  return out;
}

export type MstLookup = { found: Cid } | { absent: true } | { missing: string };

/**
 * Walks the tree from `root` towards `key` using only the given blocks (by CID string), as a relay proves a commit's
 * operation (B-3604). `found`: the key maps to that CID; `absent`: the tree has no such key; `missing`: a node on the
 * way is not among the blocks. Throws `MstError` for a node that does not hash to its CID, is not a node, or holds
 * its keys out of order.
 */
export function mstLookup(blocks: ReadonlyMap<string, Uint8Array>, root: Cid, key: string): MstLookup {
  const target = Buffer.from(key, 'utf8');
  let node: Cid | null = root;
  for (let depth = 0; node; depth++) {
    if (depth > 128) throw new MstError('The MST is too deep');
    const bytes = blocks.get(node.toString());
    if (!bytes) return { missing: node.toString() };
    if (node.codec !== CODEC_DAG_CBOR || !blockMatches(node, bytes)) throw new MstError(`The block ${node.toString().slice(0, 20)}… does not match its CID`);
    let v: unknown;
    try {
      v = cborDecode(bytes);
    } catch (err) {
      throw new MstError(`The block ${node.toString().slice(0, 20)}… is not DAG-CBOR: ${(err as Error).message}`);
    }
    const n = nodeParts(v, false);
    let next: Cid | null = n.left;
    let prev: Buffer | null = null;
    for (const e of n.entries) {
      if (prev && Buffer.compare(e.key, prev) <= 0) throw new MstError('MST entries are out of order');
      const c = Buffer.compare(target, e.key);
      if (c === 0) return { found: e.value };
      if (c < 0) break; // the key sorts before this entry: it lives in the subtree on the entry's left (`next`)
      next = e.right;
      prev = e.key;
    }
    node = next;
  }
  return { absent: true };
}

type Flat = { kind: 'tree'; node: MstNode } | { kind: 'leaf'; key: string };

/** A node as the reference implementation sees it: subtrees and leaves interleaved, in order. */
function flat(n: MstNode): Flat[] {
  const out: Flat[] = [];
  if (n.left) out.push({ kind: 'tree', node: n.left });
  for (const e of n.entries) {
    out.push({ kind: 'leaf', key: e.key });
    if (e.right) out.push({ kind: 'tree', node: e.right });
  }
  return out;
}

const gteIndex = (f: Flat[], key: string): number => {
  const i = f.findIndex((x) => x.kind === 'leaf' && byteOrder(x.key, key) >= 0);
  return i < 0 ? f.length : i;
};

function proofForKey(n: MstNode, key: string, out: Map<string, Buffer>): boolean {
  const f = flat(n);
  const i = gteIndex(f, key);
  const found = f[i];
  if (!(found && found.kind === 'leaf' && found.key === key)) {
    const prev = f[i - 1];
    if (!prev || prev.kind === 'leaf') return false;
    proofForKey(prev.node, key, out);
  }
  out.set(n.cid.toString(), n.bytes);
  return true;
}

function proofForLeftSib(n: MstNode, key: string, out: Map<string, Buffer>): void {
  const f = flat(n);
  const prev = f[gteIndex(f, key) - 1];
  if (prev && prev.kind === 'tree') proofForLeftSib(prev.node, key, out);
  out.set(n.cid.toString(), n.bytes);
}

function proofForRightSib(n: MstNode, key: string, out: Map<string, Buffer>): void {
  const f = flat(n);
  const i = gteIndex(f, key);
  const found = f[i] ?? f[i - 1];
  if (found) {
    if (found.kind === 'tree') proofForRightSib(found.node, key, out);
    else {
      const next = found.key === key ? f[i + 1] : f[i - 1];
      if (next && next.kind === 'tree') proofForRightSib(next.node, key, out);
    }
  }
  out.set(n.cid.toString(), n.bytes);
}

/**
 * The MST nodes that prove a key's value (or absence) and its neighbours on both sides: what a commit carries for
 * each operation so the operation can be checked, and inverted, against the tree (sync 1.1).
 */
export function coveringProof(tree: MstTree, key: string, into = new Map<string, Buffer>()): Map<string, Buffer> {
  proofForKey(tree.root, key, into);
  proofForLeftSib(tree.root, key, into);
  proofForRightSib(tree.root, key, into);
  return into;
}

/** Every node of a tree, root first, then depth first in key order, each followed by the records it holds. */
export function* walkNodes(n: MstNode): Generator<{ node: MstNode } | { leaf: MstLeaf }> {
  yield { node: n };
  if (n.left) yield* walkNodes(n.left);
  for (const e of n.entries) {
    yield { leaf: { key: e.key, value: e.value } };
    if (e.right) yield* walkNodes(e.right);
  }
}
