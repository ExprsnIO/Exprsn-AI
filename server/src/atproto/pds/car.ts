import { cborDecode, cborEncode } from '../cbor.js';
import { Cid, CODEC_DAG_CBOR, CODEC_RAW, readVarint, sha256, varint } from '../encoding.js';

/*
 * CAR v1 files (B-2902, https://ipld.io/specs/transport/car/carv1/), the repository export format of
 * `com.atproto.sync.getRepo`, `getRecord` and `getBlocks` and the `blocks` of a firehose commit: a varint-prefixed
 * DAG-CBOR header `{ roots: [CID], version: 1 }`, then each block as a varint length, the binary CID and the bytes.
 *
 * Writing is streaming-friendly (a header, then blocks as they come). Reading for import is strict, unlike the
 * firehose reader in `firehose-frames.ts` (which only looks for records): every block's CID must be a CIDv1 over
 * SHA-256 that matches its bytes, with the DAG-CBOR or raw codec, and the file must end exactly after its last block.
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

/** Reads and checks a CAR v1 file: every block hashes to its CID. Caps the block count and the total size. */
export function readCarVerified(bytes: Buffer, o: { maxBlocks?: number; maxBytes?: number } = {}): CarFile {
  const maxBlocks = o.maxBlocks ?? 2_000_000;
  if (o.maxBytes !== undefined && bytes.length > o.maxBytes) throw new CarError('The CAR file is too large');
  let h: { value: number; next: number };
  try {
    h = readVarint(bytes, 0);
  } catch {
    throw new CarError('The CAR header is unreadable');
  }
  const headerEnd = h.next + h.value;
  if (h.value === 0 || headerEnd > bytes.length) throw new CarError('The CAR header is truncated');
  let header: unknown;
  try {
    header = cborDecode(bytes.subarray(h.next, headerEnd));
  } catch (err) {
    throw new CarError(`The CAR header is not DAG-CBOR: ${(err as Error).message}`);
  }
  const hv = header as { version?: unknown; roots?: unknown } | null;
  if (!hv || typeof hv !== 'object' || hv.version !== 1 || !Array.isArray(hv.roots) || hv.roots.some((r) => !(r instanceof Cid))) throw new CarError('Not a CAR v1 file with CID roots');
  const roots = hv.roots as Cid[];
  const blocks = new Map<string, Buffer>();
  let at = headerEnd;
  while (at < bytes.length) {
    if (blocks.size >= maxBlocks) throw new CarError('Too many blocks in the CAR file');
    let len: { value: number; next: number };
    try {
      len = readVarint(bytes, at);
    } catch {
      throw new CarError('A CAR block length is unreadable');
    }
    const end = len.next + len.value;
    if (len.value === 0 || end > bytes.length) throw new CarError('A CAR block is truncated');
    // CIDv1: version, codec, multihash code, digest length, digest.
    let cid: Cid;
    let cidEnd: number;
    try {
      const ver = readVarint(bytes, len.next);
      const codec = readVarint(bytes, ver.next);
      const code = readVarint(bytes, codec.next);
      const dl = readVarint(bytes, code.next);
      cidEnd = dl.next + dl.value;
      if (ver.value !== 1 || code.value !== 0x12 || dl.value !== 32 || cidEnd > end) throw new Error('bad');
      if (codec.value !== CODEC_DAG_CBOR && codec.value !== CODEC_RAW) throw new Error('bad');
      cid = Cid.decode(bytes.subarray(len.next, cidEnd));
    } catch {
      throw new CarError('A CAR block’s CID is not a CIDv1 over SHA-256 with the DAG-CBOR or raw codec');
    }
    const data = bytes.subarray(cidEnd, end);
    if (!sha256(data).equals(cid.bytes.subarray(cid.bytes.length - 32))) throw new CarError(`The block ${cid.toString()} does not hash to its CID`);
    blocks.set(cid.toString(), Buffer.from(data));
    at = end;
  }
  return { roots, blocks, bytes: bytes.length };
}
