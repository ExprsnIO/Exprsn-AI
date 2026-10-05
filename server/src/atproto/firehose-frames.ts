import { createHash } from 'node:crypto';
import { cborDecode, cborDecodeFirst } from './cbor.js';
import type { CommitOp, CommitProof } from './commit.js';
import { Cid, readVarint } from './encoding.js';

/*
 * The two firehose wire formats (B-1908), read into one shape: a message with a cursor and the record operations it
 * carries.
 *
 * Jetstream (https://github.com/bluesky-social/jetstream) sends one JSON object per text message:
 *
 *   { did, time_us, kind: 'commit', commit: { rev, operation: 'create' | 'update' | 'delete', collection, rkey,
 *     record?, cid? } }                      also kind 'identity' and 'account', which carry no records
 *
 * and its cursor is `time_us` (microseconds since the epoch); `?cursor=` replays from that time.
 *
 * A relay's `com.atproto.sync.subscribeRepos` sends binary frames like subscribeLabels (stream.ts), a DAG-CBOR header
 * and body. A `#commit` body is { seq, repo, rev, ops: [{ action, path: '<collection>/<rkey>', cid }], blocks, time,
 * tooBig? }, where `blocks` is a CAR v1 file holding the records the ops point at. Its cursor is `seq`. `#identity`,
 * `#account`, `#sync` and `#info` advance the cursor without records; `{ op: -1 }` is an error and the relay closes.
 */

export type FirehoseProtocol = 'jetstream' | 'subscribe-repos';

export interface RecordOp {
  did: string;
  collection: string;
  rkey: string;
  action: 'create' | 'update' | 'delete';
  cid: string | null;
  /** The record (decoded), when the message carried it. */
  record: Record<string, unknown> | null;
}

export interface FirehoseMessage {
  cursor: number;
  /** When the event happened upstream (ms), for the lag metric. */
  time: number | null;
  ops: RecordOp[];
  /** subscribeRepos `#commit` frames: what the commit verification (B-3604, `commit.ts`) needs. */
  proof?: CommitProof;
}

/** `fatal`: the stream ends (an error frame); otherwise only the one message is unusable and is skipped. */
export type Parsed = { message: FirehoseMessage } | { error: string; fatal: boolean } | { skip: string };

const NSID_RE = /^[a-zA-Z][a-zA-Z0-9-]{0,62}(\.[a-zA-Z0-9-]{1,63}){2,}$/;
const RKEY_RE = /^[A-Za-z0-9._:~-]{1,512}$/;
const DID_RE = /^did:[a-z]+:[A-Za-z0-9._:%-]{1,2000}$/;
const ACTIONS = new Set(['create', 'update', 'delete']);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v) && !(v instanceof Cid);

/** A collection allow-list entry: an NSID, or a prefix ending in `.*` (as Jetstream accepts). */
export const COLLECTION_RE = /^[a-zA-Z][a-zA-Z0-9-]{0,62}(\.[a-zA-Z0-9-]{1,63})+(\.\*)?$/;

/** Whether a collection is on an allow-list of NSIDs and `prefix.*` entries. */
export function collectionAllowed(collection: string, allow: readonly string[]): boolean {
  return allow.some((a) => (a.endsWith('.*') ? collection.startsWith(a.slice(0, -1)) : collection === a));
}

/** Deterministic sampling: the same post is in or out of the sample however often it is seen (after a restart too). */
export function sampled(uri: string, ppm: number): boolean {
  if (ppm >= 1_000_000) return true;
  if (ppm <= 0) return false;
  return createHash('sha256').update(uri).digest().readUInt32BE(0) % 1_000_000 < ppm;
}

/** Reads one Jetstream message. */
export function parseJetstream(text: string): Parsed {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { error: 'A Jetstream message is not JSON', fatal: false };
  }
  if (!isObj(v)) return { error: 'A Jetstream message is not an object', fatal: false };
  const cursor = v.time_us;
  if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor < 0) return { error: 'A Jetstream message has no time_us', fatal: false };
  const time = Math.floor(cursor / 1000);
  if (v.kind !== 'commit') return { message: { cursor, time, ops: [] } };
  const did = typeof v.did === 'string' && DID_RE.test(v.did) ? v.did : null;
  const c = v.commit;
  if (!did || !isObj(c)) return { message: { cursor, time, ops: [] } };
  const collection = typeof c.collection === 'string' && NSID_RE.test(c.collection) ? c.collection : null;
  const rkey = typeof c.rkey === 'string' && RKEY_RE.test(c.rkey) ? c.rkey : null;
  const action = typeof c.operation === 'string' && ACTIONS.has(c.operation) ? (c.operation as RecordOp['action']) : null;
  if (!collection || !rkey || !action) return { message: { cursor, time, ops: [] } };
  return { message: { cursor, time, ops: [{ did, collection, rkey, action, cid: typeof c.cid === 'string' ? c.cid.slice(0, 200) : null, record: isObj(c.record) ? c.record : null }] } };
}

/** Reads a CAR v1 file into its blocks by CID (string form). Blocks that are not DAG-CBOR are skipped. */
export function readCar(bytes: Buffer, maxBlocks = 10_000): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const h = readVarint(bytes, 0);
  const headerEnd = h.next + h.value;
  if (headerEnd > bytes.length) throw new Error('CAR header truncated');
  const header = cborDecode(bytes.subarray(h.next, headerEnd));
  if (!isObj(header) || header.version !== 1) throw new Error('Not a CAR v1 file');
  let at = headerEnd;
  while (at < bytes.length) {
    if (out.size >= maxBlocks) throw new Error('Too many blocks in the CAR file');
    const len = readVarint(bytes, at);
    const end = len.next + len.value;
    if (end > bytes.length || len.value === 0) throw new Error('CAR block truncated');
    // The CID: version, codec, then a multihash (code, length, digest).
    const ver = readVarint(bytes, len.next);
    const codec = readVarint(bytes, ver.next);
    const mh = readVarint(bytes, codec.next);
    const dl = readVarint(bytes, mh.next);
    const cidEnd = dl.next + dl.value;
    if (ver.value !== 1 || cidEnd > end) throw new Error('A CAR block has an unreadable CID');
    const cid = Cid.decode(bytes.subarray(len.next, cidEnd));
    out.set(cid.toString(), bytes.subarray(cidEnd, end));
    at = end;
  }
  return out;
}

/** Reads one subscribeRepos frame. */
export function parseRepoFrame(data: Buffer): Parsed {
  let header: unknown;
  let body: unknown;
  try {
    const h = cborDecodeFirst(data, 0);
    const b = cborDecodeFirst(data, h.next);
    if (b.next !== data.length) throw new Error('Trailing bytes after the frame body');
    header = h.value;
    body = b.value;
  } catch (err) {
    return { error: `Unreadable frame: ${(err as Error).message}`, fatal: false };
  }
  if (!isObj(header) || !isObj(body)) return { error: 'A frame is two CBOR maps', fatal: false };
  if (header.op === -1) return { error: `${String(body.error ?? 'Error')}: ${String(body.message ?? '')}`.slice(0, 300), fatal: true };
  if (header.op !== 1) return { skip: 'unknown op' };
  if (header.t === '#info') return { skip: `info: ${String(body.name ?? '')}` };
  const seq = body.seq;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return { skip: `no seq in ${String(header.t)}` };
  const time = typeof body.time === 'string' && !Number.isNaN(Date.parse(body.time)) ? Date.parse(body.time) : null;
  if (header.t !== '#commit') return { message: { cursor: seq, time, ops: [] } };
  const did = typeof body.repo === 'string' && DID_RE.test(body.repo) ? body.repo : null;
  if (!did || !Array.isArray(body.ops)) return { message: { cursor: seq, time, ops: [] } };
  let blocks = new Map<string, Buffer>();
  let unreadable = false;
  if (Buffer.isBuffer(body.blocks) && body.blocks.length) {
    try {
      blocks = readCar(body.blocks);
    } catch {
      blocks = new Map(); // records unreadable: the ops are still seen, without text (and the commit fails to verify)
      unreadable = true;
    }
  }
  const ops: RecordOp[] = [];
  const proofOps: CommitOp[] = [];
  for (const op of body.ops.slice(0, 1000)) {
    if (!isObj(op) || typeof op.path !== 'string' || typeof op.action !== 'string' || !ACTIONS.has(op.action)) continue;
    const slash = op.path.indexOf('/');
    const collection = op.path.slice(0, slash);
    const rkey = op.path.slice(slash + 1);
    if (slash < 1 || !NSID_RE.test(collection) || !RKEY_RE.test(rkey)) continue;
    const cid = op.cid instanceof Cid ? op.cid.toString() : null;
    let record: Record<string, unknown> | null = null;
    const block = cid ? blocks.get(cid) : undefined;
    if (block) {
      try {
        const v = cborDecode(block);
        record = isObj(v) ? v : null;
      } catch {
        record = null;
      }
    }
    ops.push({ did, collection, rkey, action: op.action as RecordOp['action'], cid, record });
    proofOps.push({ action: op.action as CommitOp['action'], path: op.path, cid });
  }
  const proof: CommitProof = { repo: did, rev: typeof body.rev === 'string' ? body.rev : null, commit: body.commit instanceof Cid ? body.commit : null, blocks, ops: proofOps, tooBig: body.tooBig === true, unreadable };
  return { message: { cursor: seq, time, ops, proof } };
}

const MAX_TEXT = 20_000;

/**
 * The text a check inspects for a record: a post's text and its images' alt text; for other records the usual
 * human-written fields (profile names and descriptions, list and feed names). Empty when the record has none.
 */
export function recordText(record: Record<string, unknown> | null): string {
  if (!record) return '';
  const parts: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) parts.push(v);
  };
  for (const k of ['text', 'displayName', 'name', 'title', 'description', 'summary']) push(record[k]);
  const embed = record.embed;
  const embeds = isObj(embed) ? [embed, ...(isObj(embed.media) ? [embed.media] : [])] : [];
  for (const e of embeds) {
    if (Array.isArray(e.images)) for (const img of e.images.slice(0, 10)) if (isObj(img)) push(img.alt);
    if (isObj(e.external)) {
      push(e.external.title);
      push(e.external.description);
    }
  }
  return parts.join('\n').slice(0, MAX_TEXT);
}
