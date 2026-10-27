/*
 * 1.9.0, Sprint 55 (B-192): the Bloom filter in front of a list version's shards.
 *
 * Every record is already a cryptographic digest, so the filter needs no hash functions of its own: bytes 4 to 11 of
 * the digest give two independent 32-bit values (bytes 0 to 3 are left out, since they pick the shard), and the k
 * positions are h1 + i·h2 mod m (Kirsch and Mitzenmacher). With m = -n·ln p / ln²2 bits and k = m/n·ln 2 the false
 * positive rate is p. A "maybe" goes to the shard; a "no" is final, so most checks of a password that is not listed
 * never read a shard. Stored as an 8-byte header (m, k as uint32 BE) followed by the bit array.
 */

export interface BloomSize {
  bits: number;
  hashes: number;
  /** The rate the size gives (above the asked one when the size was capped). */
  rate: number;
}

const LN2 = Math.LN2;
export const BLOOM_HEADER = 8;

/** The size of a filter for `n` entries at false-positive rate `p`, at most `maxBytes` of bits. */
export function bloomSize(n: number, p: number, maxBytes: number): BloomSize {
  const entries = Math.max(1, n);
  let bits = Math.ceil((-entries * Math.log(p)) / (LN2 * LN2));
  bits = Math.max(64, Math.min(bits, maxBytes * 8, 0xfffffff8));
  bits = Math.ceil(bits / 8) * 8;
  const hashes = Math.max(1, Math.min(30, Math.round((bits / entries) * LN2)));
  const rate = Math.pow(1 - Math.exp((-hashes * entries) / bits), hashes);
  return { bits, hashes, rate };
}

export class Bloom {
  readonly bits: number;
  readonly hashes: number;
  readonly data: Uint8Array;

  constructor(bits: number, hashes: number, data?: Uint8Array) {
    this.bits = bits;
    this.hashes = hashes;
    this.data = data ?? new Uint8Array(Math.ceil(bits / 8));
  }

  static from(buf: Buffer): Bloom {
    if (buf.length < BLOOM_HEADER) throw new Error('Bloom filter is truncated');
    const bits = buf.readUInt32BE(0);
    const hashes = buf.readUInt32BE(4);
    if (buf.length - BLOOM_HEADER < Math.ceil(bits / 8)) throw new Error('Bloom filter is truncated');
    return new Bloom(bits, hashes, new Uint8Array(buf.buffer, buf.byteOffset + BLOOM_HEADER, Math.ceil(bits / 8)));
  }

  /** The filter as stored: header then bits. */
  header(): Buffer {
    const h = Buffer.alloc(BLOOM_HEADER);
    h.writeUInt32BE(this.bits >>> 0, 0);
    h.writeUInt32BE(this.hashes >>> 0, 4);
    return h;
  }

  add(digest: Uint8Array, off = 0): void {
    const h1 = read32(digest, off + 4);
    const h2 = (read32(digest, off + 8) | 1) >>> 0;
    for (let i = 0; i < this.hashes; i++) {
      const pos = (h1 + i * h2) % this.bits;
      this.data[pos >>> 3]! |= 1 << (pos & 7);
    }
  }

  has(digest: Uint8Array, off = 0): boolean {
    const h1 = read32(digest, off + 4);
    const h2 = (read32(digest, off + 8) | 1) >>> 0;
    for (let i = 0; i < this.hashes; i++) {
      const pos = (h1 + i * h2) % this.bits;
      if (!(this.data[pos >>> 3]! & (1 << (pos & 7)))) return false;
    }
    return true;
  }
}

const read32 = (b: Uint8Array, o: number): number => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
