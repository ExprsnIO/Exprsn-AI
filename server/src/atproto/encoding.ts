import { createHash } from 'node:crypto';

/*
 * The small encodings AT-Protocol needs (B-1608 to B-1611), written here rather than taken from the multiformats
 * packages: RFC 4648 base32 (lower case, no padding, as multibase `b`), base58btc (multibase `z`), unsigned varints
 * (multicodec prefixes) and CIDv1. Known-answer tests in `test/sprint25b-atproto.test.ts` pin them to the reference
 * implementations' output.
 */

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of text.toLowerCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Not base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = new Map([...B58].map((c, i) => [c, BigInt(i)]));

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return '1'.repeat(zeros) + out;
}

export function base58Decode(text: string): Buffer {
  if (text.length > 256) throw new Error('base58 value too long');
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;
  let n = 0n;
  for (const ch of text) {
    const v = B58_MAP.get(ch);
    if (v === undefined) throw new Error('Not base58btc');
    n = n * 58n + v;
  }
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return Buffer.from([...new Array<number>(zeros).fill(0), ...body]);
}

export function varint(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return Buffer.from(out);
}

export function readVarint(b: Uint8Array, at = 0): { value: number; next: number } {
  let value = 0;
  let shift = 1;
  for (let i = at; i < b.length && i < at + 8; i++) {
    const byte = b[i]!;
    value += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) return { value, next: i + 1 };
    shift *= 128;
  }
  throw new Error('Bad varint');
}

export const sha256 = (data: Uint8Array): Buffer => createHash('sha256').update(data).digest();

export const CODEC_DAG_CBOR = 0x71;
export const CODEC_RAW = 0x55;
const SHA2_256 = 0x12;

/** A CIDv1 with a SHA2-256 multihash (the only kind AT-Protocol uses). */
export class Cid {
  private constructor(
    /** The binary CID: version, codec, multihash. */
    readonly bytes: Buffer
  ) {}

  static create(codec: number, digest: Uint8Array): Cid {
    if (digest.length !== 32) throw new Error('A SHA2-256 digest is 32 bytes');
    return new Cid(Buffer.concat([varint(1), varint(codec), varint(SHA2_256), varint(32), Buffer.from(digest)]));
  }

  /** The CID of DAG-CBOR bytes. */
  static ofCbor(bytes: Uint8Array): Cid {
    return Cid.create(CODEC_DAG_CBOR, sha256(bytes));
  }

  /** Reads a binary CIDv1 (CIDv0 is not used by AT-Protocol and is refused). */
  static decode(bytes: Uint8Array): Cid {
    const v = readVarint(bytes, 0);
    if (v.value !== 1) throw new Error('Only CIDv1 is supported');
    const codec = readVarint(bytes, v.next);
    const hash = readVarint(bytes, codec.next);
    const len = readVarint(bytes, hash.next);
    if (len.next + len.value !== bytes.length) throw new Error('Bad CID length');
    if (len.value > 64) throw new Error('Bad CID digest length');
    return new Cid(Buffer.from(bytes));
  }

  /** Parses the base32 (`b…`) string form. */
  static parse(text: string): Cid {
    if (!/^b[a-z2-7]{8,200}$/.test(text)) throw new Error('Not a base32 CIDv1');
    return Cid.decode(base32Decode(text.slice(1)));
  }

  get codec(): number {
    return readVarint(this.bytes, readVarint(this.bytes, 0).next).value;
  }

  toString(): string {
    return 'b' + base32Encode(this.bytes);
  }

  equals(other: Cid): boolean {
    return this.bytes.equals(other.bytes);
  }

  toJSON(): { $link: string } {
    return { $link: this.toString() };
  }
}
