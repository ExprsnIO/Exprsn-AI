import { cborDecode, cborEncode } from '../cbor.js';
import { Cid, CODEC_DAG_CBOR, CODEC_RAW, readVarint, sha256, varint } from '../encoding.js';

/*
 * CAR v1 files (B-2902, https://ipld.io/specs/transport/car/carv1/), the repository export format of
 * `com.atproto.sync.getRepo`, `getRecord` and `getBlocks` and the `blocks` of a firehose commit: a varint-prefixed
 * DAG-CBOR header `{ roots: [CID], version: 1 }`, then each block as a varint length, the binary CID and the bytes.
 *
 * Writing is streaming-friendly (a header, then blocks as they come). Reading for import is strict, unlike the
 * firehose reader (`readCarBlocks`, which only looks for records and leaves hashing to the commit check): every
 * block's CID must be a CIDv1 over SHA-256 that matches its bytes, with the DAG-CBOR or raw codec, and the file must
 * end exactly after its last block. Both are the same reader (`readCarFile`), in two modes.
 */

export function carHeader(roots: Cid[]): Buffer {
  const h = cborEncode({ version: 1, roots });
  return Buffer.concat([varint(h.length), h]);
}

export function carBlock(cid: Cid, bytes: Uint8Array): Buffer {
  return Buffer.concat([varint(cid.bytes.length + bytes.length), cid.bytes, Buffer.from(bytes)]);
}

/** A whole CAR file: the root and the blocks, in the order given (duplicates written once). */
export function writeCar(root: Cid | null, blocks: Iterable<[Cid | string, Uint8Array]>): Buffer {
  const parts: Buffer[] = [carHeader(root ? [root] : [])];
  const seen = new Set<string>();
  for (const [c, bytes] of blocks) {
    const cid = typeof c === 'string' ? Cid.parse(c) : c;
    const key = cid.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(carBlock(cid, bytes));
  }
  return Buffer.concat(parts);
}

export class CarError extends Error {}

export interface CarFile {
  roots: Cid[];
  /** Blocks by CID string, in file order. */
  blocks: Map<string, Buffer>;
  bytes: number;
}

/** Whether bytes hash to a CID (SHA2-256; DAG-CBOR or raw): a CAR file only claims its CIDs. */
export function blockMatches(cid: Cid | string, bytes: Uint8Array): boolean {
  try {
    const c = typeof cid === 'string' ? Cid.parse(cid) : cid;
    return Cid.create(c.codec, sha256(bytes)).equals(c);
  } catch {
    return false;
  }
}

/**
 * The one CAR v1 reader. `verify` (import, migration, a relay double) checks the header's roots, that every CID is a
 * CIDv1 over SHA-256 with the DAG-CBOR or raw codec and that every block hashes to it. Without it (the firehose,
 * `readCarBlocks`) any CIDv1 is filed as claimed and the relay commit check (`../commit.ts`) hashes each block it uses.
 */
function readCarFile(bytes: Buffer, o: { verify: boolean; maxBlocks: number; maxBytes?: number }): CarFile {
  const fail = (strict: string, lenient: string): never => {
    throw o.verify ? new CarError(strict) : new Error(lenient);
  };
  if (o.maxBytes !== undefined && bytes.length > o.maxBytes) throw new CarError('The CAR file is too large');
  let h: { value: number; next: number };
  try {
    h = readVarint(bytes, 0);
  } catch (err) {
    return fail('The CAR header is unreadable', (err as Error).message);
  }
  const headerEnd = h.next + h.value;
  if (headerEnd > bytes.length || (o.verify && h.value === 0)) fail('The CAR header is truncated', 'CAR header truncated');
  let header: unknown;
  try {
    header = cborDecode(bytes.subarray(h.next, headerEnd));
  } catch (err) {
    return fail(`The CAR header is not DAG-CBOR: ${(err as Error).message}`, (err as Error).message);
  }
  const hv = header as { version?: unknown; roots?: unknown } | null;
  if (!hv || typeof hv !== 'object' || Array.isArray(hv) || Buffer.isBuffer(hv) || hv instanceof Cid || hv.version !== 1) fail('Not a CAR v1 file with CID roots', 'Not a CAR v1 file');
  if (o.verify && (!Array.isArray(hv!.roots) || hv!.roots.some((r) => !(r instanceof Cid)))) fail('Not a CAR v1 file with CID roots', '');
  const roots = Array.isArray(hv!.roots) ? (hv!.roots.filter((r) => r instanceof Cid) as Cid[]) : [];
  const blocks = new Map<string, Buffer>();
  let at = headerEnd;
  while (at < bytes.length) {
    if (blocks.size >= o.maxBlocks) fail('Too many blocks in the CAR file', 'Too many blocks in the CAR file');
    let len: { value: number; next: number };
    try {
      len = readVarint(bytes, at);
    } catch (err) {
      return fail('A CAR block length is unreadable', (err as Error).message);
    }
    const end = len.next + len.value;
    if (len.value === 0 || end > bytes.length) fail('A CAR block is truncated', 'CAR block truncated');
    // CIDv1: version, codec, multihash code, digest length, digest.
    let cid: Cid;
    let cidEnd: number;
    try {
      const ver = readVarint(bytes, len.next);
      const codec = readVarint(bytes, ver.next);
      const code = readVarint(bytes, codec.next);
      const dl = readVarint(bytes, code.next);
      cidEnd = dl.next + dl.value;
      if (ver.value !== 1 || cidEnd > end) throw new Error('A CAR block has an unreadable CID');
      if (o.verify && (code.value !== 0x12 || dl.value !== 32 || (codec.value !== CODEC_DAG_CBOR && codec.value !== CODEC_RAW))) throw new Error('bad');
      cid = Cid.decode(bytes.subarray(len.next, cidEnd));
    } catch (err) {
      return fail('A CAR block’s CID is not a CIDv1 over SHA-256 with the DAG-CBOR or raw codec', (err as Error).message);
    }
    const data = bytes.subarray(cidEnd, end);
    if (o.verify && !sha256(data).equals(cid.bytes.subarray(cid.bytes.length - 32))) throw new CarError(`The block ${cid.toString()} does not hash to its CID`);
    blocks.set(cid.toString(), o.verify ? Buffer.from(data) : data);
    at = end;
  }
  return { roots, blocks, bytes: bytes.length };
}

/** Reads and checks a CAR v1 file: every block hashes to its CID. Caps the block count and the total size. */
export function readCarVerified(bytes: Buffer, o: { maxBlocks?: number; maxBytes?: number } = {}): CarFile {
  return readCarFile(bytes, { verify: true, maxBlocks: o.maxBlocks ?? 2_000_000, ...(o.maxBytes !== undefined ? { maxBytes: o.maxBytes } : {}) });
}

/**
 * Reads a firehose `#commit`'s CAR into its blocks by CID string, unchecked (B-1908): the commit check hashes the
 * blocks it uses, and a record block that is not used is only read for its text.
 */
export function readCarBlocks(bytes: Buffer, maxBlocks = 10_000): Map<string, Buffer> {
  return readCarFile(bytes, { verify: false, maxBlocks }).blocks;
}
