import { Cid } from './encoding.js';

/*
 * DAG-CBOR (B-1609, B-1610): the deterministic CBOR subset AT-Protocol signs and hashes. Encoding is canonical:
 * shortest-form integers and lengths, definite lengths only, map keys are strings sorted by encoded length and then
 * bytewise, no floats (the AT-Protocol data model has none), no undefined (an undefined map value is left out), and
 * the only tag is 42 (a CID link, with its 0x00 multibase prefix). Decoding is strict in the same ways, so a value
 * read from the network re-encodes to the same bytes or is refused.
 */

export type CborValue = null | boolean | number | string | Buffer | Cid | CborValue[] | { [key: string]: CborValue | undefined };

const MAX_DEPTH = 64;

function head(major: number, n: number): Buffer {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('CBOR length or integer out of range');
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  if (n < 0x100000000) {
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = (major << 5) | 27;
  b.writeBigUInt64BE(BigInt(n), 1);
  return b;
}

/** Map key order: shorter encoded keys first, then bytewise (RFC 7049 canonical, as DAG-CBOR requires). */
const keyOrder = (a: Buffer, b: Buffer): number => a.length - b.length || Buffer.compare(a, b);

function enc(v: unknown, out: Buffer[], depth: number): void {
  if (depth > MAX_DEPTH) throw new Error('CBOR value nested too deeply');
  if (v === null) return void out.push(Buffer.from([0xf6]));
  if (v === true) return void out.push(Buffer.from([0xf5]));
  if (v === false) return void out.push(Buffer.from([0xf4]));
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error('DAG-CBOR here carries integers only');
    return void out.push(v >= 0 ? head(0, v) : head(1, -1 - v));
  }
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    out.push(head(3, b.length), b);
    return;
  }
  if (v instanceof Cid) {
    const b = Buffer.concat([Buffer.from([0x00]), v.bytes]);
    out.push(Buffer.from([0xd8, 42]), head(2, b.length), b);
    return;
  }
  if (v instanceof Uint8Array) {
    out.push(head(2, v.length), Buffer.from(v));
    return;
  }
  if (Array.isArray(v)) {
    out.push(head(4, v.length));
    for (const x of v) enc(x, out, depth + 1);
    return;
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => [Buffer.from(k, 'utf8'), x] as const)
      .sort((a, b) => keyOrder(a[0], b[0]));
    out.push(head(5, entries.length));
    for (const [k, x] of entries) {
      out.push(head(3, k.length), k);
      enc(x, out, depth + 1);
    }
    return;
  }
  throw new Error(`DAG-CBOR cannot encode a ${typeof v}`);
}

export function cborEncode(value: unknown): Buffer {
  const out: Buffer[] = [];
  enc(value, out, 0);
  return Buffer.concat(out);
}

class Reader {
  constructor(
    readonly b: Buffer,
    public at = 0
  ) {}

  byte(): number {
    if (this.at >= this.b.length) throw new Error('CBOR truncated');
    return this.b[this.at++]!;
  }

  take(n: number): Buffer {
    if (n > this.b.length - this.at) throw new Error('CBOR truncated');
    const s = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return s;
  }

  /** The argument of a head, refusing indefinite lengths and non-shortest forms. */
  arg(info: number): number {
    if (info < 24) return info;
    let n: number;
    if (info === 24) {
      n = this.byte();
      if (n < 24) throw new Error('CBOR integer not in shortest form');
    } else if (info === 25) {
      n = this.take(2).readUInt16BE(0);
      if (n < 0x100) throw new Error('CBOR integer not in shortest form');
    } else if (info === 26) {
      n = this.take(4).readUInt32BE(0);
      if (n < 0x10000) throw new Error('CBOR integer not in shortest form');
    } else if (info === 27) {
      const big = this.take(8).readBigUInt64BE(0);
      if (big < 0x100000000n) throw new Error('CBOR integer not in shortest form');
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CBOR integer too large');
      n = Number(big);
    } else throw new Error('Indefinite lengths are not DAG-CBOR');
    return n;
  }

  value(depth: number): CborValue {
    if (depth > MAX_DEPTH) throw new Error('CBOR value nested too deeply');
    const ib = this.byte();
    const major = ib >> 5;
    const info = ib & 31;
    switch (major) {
      case 0:
        return this.arg(info);
      case 1:
        return -1 - this.arg(info);
      case 2:
        return Buffer.from(this.take(this.arg(info)));
      case 3: {
        const s = this.take(this.arg(info));
        const text = s.toString('utf8');
        if (!Buffer.from(text, 'utf8').equals(s)) throw new Error('CBOR text is not valid UTF-8');
        return text;
      }
      case 4: {
        const n = this.arg(info);
        if (n > this.b.length - this.at) throw new Error('CBOR truncated');
        const arr: CborValue[] = [];
        for (let i = 0; i < n; i++) arr.push(this.value(depth + 1));
        return arr;
      }
      case 5: {
        const n = this.arg(info);
        if (n > this.b.length - this.at) throw new Error('CBOR truncated');
        const obj: Record<string, CborValue> = Object.create(null) as Record<string, CborValue>;
        let prev: Buffer | null = null;
        for (let i = 0; i < n; i++) {
          const kh = this.byte();
          if (kh >> 5 !== 3) throw new Error('DAG-CBOR map keys are strings');
          const kb = Buffer.from(this.take(this.arg(kh & 31)));
          if (prev && keyOrder(prev, kb) >= 0) throw new Error('DAG-CBOR map keys out of order or repeated');
          prev = kb;
          obj[kb.toString('utf8')] = this.value(depth + 1);
        }
        return { ...obj };
      }
      case 6: {
        const tag = this.arg(info);
        if (tag !== 42) throw new Error(`CBOR tag ${tag} is not DAG-CBOR`);
        const inner = this.value(depth + 1);
        if (!Buffer.isBuffer(inner) || inner[0] !== 0x00) throw new Error('A CID link is bytes with a 0x00 prefix');
        return Cid.decode(inner.subarray(1));
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new Error('Floats and undefined are not used in AT-Protocol data');
      default:
        throw new Error('Bad CBOR');
    }
  }
}

/** Decodes one value and says where it ended (event-stream frames carry two values back to back). */
export function cborDecodeFirst(bytes: Uint8Array, at = 0): { value: CborValue; next: number } {
  const r = new Reader(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), at);
  const value = r.value(0);
  return { value, next: r.at };
}

/** Decodes exactly one value; trailing bytes are refused. */
export function cborDecode(bytes: Uint8Array): CborValue {
  const { value, next } = cborDecodeFirst(bytes);
  if (next !== bytes.length) throw new Error('Trailing bytes after the CBOR value');
  return value;
}
