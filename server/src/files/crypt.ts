import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/*
 * File content at rest (B-2401). A file version can be gigabytes, so it is never sealed as one value: it is cut into
 * 64 KiB segments, each sealed with AES-256-GCM under a random key of its own (the version key), so content streams in
 * and out with flat memory and every segment is authenticated before a byte of it is released. The version key and
 * its nonce prefix are sealed with the tenant key (`DataKeys.sealBytes`), so destroying the tenant key crypto-shreds
 * every file, as for the rest of the tenant's content.
 *
 * Segment i is sealed with IV = nonce prefix (8 bytes) || i (32-bit big-endian) and associated data
 * `<aad>|<i>|<final>`, where `aad` names the version: segments cannot be reordered, moved to another version, or cut
 * off at the end (the last segment is the only one sealed as final, and an empty file is one empty final segment).
 */

export const SEGMENT_BYTES = 64 * 1024;
const TAG_BYTES = 16;
const MAX_SEGMENTS = 0xffffffff;

export interface FileKey {
  dek: Buffer;
  nonce: Buffer;
}

export const newFileKey = (): FileKey => ({ dek: randomBytes(32), nonce: randomBytes(8) });

/** The key and nonce as one buffer, for sealing with the tenant key. */
export const packKey = (k: FileKey): Buffer => Buffer.concat([k.dek, k.nonce]);

export function unpackKey(b: Buffer): FileKey {
  if (b.length !== 40) throw new Error('Unrecognised file key');
  return { dek: Buffer.from(b.subarray(0, 32)), nonce: Buffer.from(b.subarray(32)) };
}

const ivFor = (nonce: Buffer, i: number): Buffer => {
  const iv = Buffer.alloc(12);
  nonce.copy(iv, 0);
  iv.writeUInt32BE(i, 8);
  return iv;
};
const aadFor = (aad: string, i: number, last: boolean) => Buffer.from(`${aad}|${i}|${last ? 1 : 0}`);

export class FileIntegrityError extends Error {
  constructor() {
    super('The stored file does not authenticate: it was changed, cut short, or the key is wrong.');
  }
}

const asBuffer = (c: Buffer | Uint8Array | string): Buffer => (Buffer.isBuffer(c) ? c : typeof c === 'string' ? Buffer.from(c) : Buffer.from(c.buffer, c.byteOffset, c.byteLength));

/** Encrypts a stream of plaintext into sealed segments. */
export async function* encryptStream(source: AsyncIterable<Buffer | Uint8Array | string> | Iterable<Buffer>, key: FileKey, aad: string): AsyncGenerator<Buffer> {
  let i = 0;
  const seal = (plain: Buffer, last: boolean): Buffer => {
    if (i >= MAX_SEGMENTS) throw new Error('The file is too large to seal.');
    const c = createCipheriv('aes-256-gcm', key.dek, ivFor(key.nonce, i));
    c.setAAD(aadFor(aad, i, last));
    const out = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    i++;
    return out;
  };
  let pending: Buffer[] = [];
  let len = 0;
  for await (const chunk of source) {
    const b = asBuffer(chunk);
    if (!b.length) continue;
    pending.push(b);
    len += b.length;
    // Strictly more than a segment: the last segment is only sealed once the source has ended.
    while (len > SEGMENT_BYTES) {
      const all = pending.length === 1 ? pending[0]! : Buffer.concat(pending, len);
      yield seal(all.subarray(0, SEGMENT_BYTES), false);
      const rest = all.subarray(SEGMENT_BYTES);
      pending = [rest];
      len = rest.length;
    }
  }
  yield seal(pending.length === 1 ? pending[0]! : Buffer.concat(pending, len), true);
}

/** Decrypts sealed segments back into plaintext, authenticating each segment before yielding it. */
export async function* decryptStream(source: AsyncIterable<Buffer | Uint8Array | string>, key: FileKey, aad: string): AsyncGenerator<Buffer> {
  const seg = SEGMENT_BYTES + TAG_BYTES;
  let i = 0;
  const open = (sealed: Buffer, last: boolean): Buffer => {
    if (sealed.length < TAG_BYTES) throw new FileIntegrityError();
    const d = createDecipheriv('aes-256-gcm', key.dek, ivFor(key.nonce, i));
    d.setAAD(aadFor(aad, i, last));
    d.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    try {
      const out = Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG_BYTES)), d.final()]);
      i++;
      return out;
    } catch {
      throw new FileIntegrityError();
    }
  };
  let buf: Buffer = Buffer.alloc(0);
  for await (const chunk of source) {
    const b = asBuffer(chunk);
    buf = buf.length ? Buffer.concat([buf, b]) : b;
    // Hold back at least one byte past a full segment: only then is the segment known not to be the last.
    while (buf.length > seg) {
      yield open(buf.subarray(0, seg), false);
      buf = buf.subarray(seg);
    }
  }
  yield open(buf, true);
}

/** The stored size of a plaintext of `bytes` bytes. */
export const sealedSize = (bytes: number): number => {
  const segments = Math.max(1, Math.ceil(bytes / SEGMENT_BYTES));
  return bytes + segments * TAG_BYTES;
};

/** Collects a stream into one buffer (for small files: previews, knowledge indexing). */
export async function collect(source: AsyncIterable<Buffer>, max = Number.POSITIVE_INFINITY): Promise<Buffer> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of source) {
    n += c.length;
    if (n > max) throw new Error(`The content is larger than ${max} bytes.`);
    parts.push(c);
  }
  return Buffer.concat(parts, n);
}
