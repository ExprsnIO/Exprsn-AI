import { createHash } from 'node:crypto';

/*
 * 1.9.0, Sprint 55 (B-192): the hashes leaked-password lists hold, and the line formats they are imported from.
 *
 * A list is either SHA-1 (20 bytes, what HIBP's Pwned Passwords publishes and what `breached.ts` checks) or NTLM
 * (16 bytes: MD4 over the UTF-16LE password, HIBP's NTLM download). Every record is the raw digest; nothing else of a
 * line is kept. Counts in the HIBP format are read only to drop padding (count 0) and are never stored: a check says
 * "found", never how often.
 *
 * Plain-text lines are hashed as they are read and the line is dropped at once; it is never logged, stored or put in
 * an error message (invalid lines are counted by number only).
 */

export const HASH_KINDS = ['sha1', 'ntlm'] as const;
export type HashKind = (typeof HASH_KINDS)[number];
export const WIDTH: Record<HashKind, number> = { sha1: 20, ntlm: 16 };

/** `hibp`: HEX:COUNT lines (HIBP's "ordered by hash" files); `hashes`: one hex digest per line; `plain`: passwords. */
export const IMPORT_FORMATS = ['hibp', 'hashes', 'plain'] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

/** A line longer than this is not a password or a hash; it is counted invalid and skipped. */
export const MAX_LINE_BYTES = 1024;

export const sha1 = (password: string | Buffer): Buffer => createHash('sha1').update(password).digest();

// ---------- MD4 (RFC 1320), for NTLM: Node's OpenSSL 3 build refuses md4 without the legacy provider ----------

const rotl = (x: number, n: number): number => (x << n) | (x >>> (32 - n));

export function md4(input: Buffer): Buffer {
  const bitLen = input.length * 8;
  const padLen = ((input.length + 8) >> 6) * 64 + 64;
  const msg = Buffer.alloc(padLen);
  input.copy(msg);
  msg[input.length] = 0x80;
  msg.writeUInt32LE(bitLen >>> 0, padLen - 8);
  msg.writeUInt32LE(Math.floor(bitLen / 0x100000000) >>> 0, padLen - 4);
  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;
  const x = new Array<number>(16);
  const F = (p: number, q: number, r: number) => (p & q) | (~p & r);
  const G = (p: number, q: number, r: number) => (p & q) | (p & r) | (q & r);
  const H = (p: number, q: number, r: number) => p ^ q ^ r;
  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) x[i] = msg.readUInt32LE(off + i * 4);
    const [aa, bb, cc, dd] = [a, b, c, d];
    for (const i of [0, 4, 8, 12]) {
      a = rotl((a + F(b, c, d) + x[i]!) | 0, 3);
      d = rotl((d + F(a, b, c) + x[i + 1]!) | 0, 7);
      c = rotl((c + F(d, a, b) + x[i + 2]!) | 0, 11);
      b = rotl((b + F(c, d, a) + x[i + 3]!) | 0, 19);
    }
    for (const i of [0, 1, 2, 3]) {
      a = rotl((a + G(b, c, d) + x[i]! + 0x5a827999) | 0, 3);
      d = rotl((d + G(a, b, c) + x[i + 4]! + 0x5a827999) | 0, 5);
      c = rotl((c + G(d, a, b) + x[i + 8]! + 0x5a827999) | 0, 9);
      b = rotl((b + G(c, d, a) + x[i + 12]! + 0x5a827999) | 0, 13);
    }
    for (const i of [0, 2, 1, 3]) {
      a = rotl((a + H(b, c, d) + x[i]! + 0x6ed9eba1) | 0, 3);
      d = rotl((d + H(a, b, c) + x[i + 8]! + 0x6ed9eba1) | 0, 9);
      c = rotl((c + H(d, a, b) + x[i + 4]! + 0x6ed9eba1) | 0, 11);
      b = rotl((b + H(c, d, a) + x[i + 12]! + 0x6ed9eba1) | 0, 15);
    }
    a = (a + aa) | 0;
    b = (b + bb) | 0;
    c = (c + cc) | 0;
    d = (d + dd) | 0;
  }
  const out = Buffer.alloc(16);
  out.writeInt32LE(a, 0);
  out.writeInt32LE(b, 4);
  out.writeInt32LE(c, 8);
  out.writeInt32LE(d, 12);
  return out;
}

export const ntlm = (password: string): Buffer => md4(Buffer.from(password, 'utf16le'));

/** The digest a list of `kind` holds for a password. */
export const digestOf = (kind: HashKind, password: string): Buffer => (kind === 'sha1' ? sha1(Buffer.from(password, 'utf8')) : ntlm(password));

const HEX = /^[0-9A-Fa-f]+$/;

/** Parses `width` bytes of hex; null when the text is not exactly that. */
export function hexDigest(text: string, width: number): Buffer | null {
  if (text.length !== width * 2 || !HEX.test(text)) return null;
  return Buffer.from(text, 'hex');
}

/** One line of an import, already split; returns the digest, `null` for an invalid line, `'skip'` for padding. */
export function parseLine(format: ImportFormat, kind: HashKind, line: Buffer): Buffer | null | 'skip' {
  if (format === 'plain') return kind === 'sha1' ? sha1(line) : ntlm(line.toString('utf8'));
  const text = line.toString('latin1').trim();
  if (!text) return 'skip';
  if (format === 'hashes') return hexDigest(text, WIDTH[kind]);
  const colon = text.indexOf(':');
  const hex = colon < 0 ? text : text.slice(0, colon);
  if (colon >= 0) {
    const count = text.slice(colon + 1).trim();
    if (!/^\d{1,12}$/.test(count)) return null;
    if (Number(count) === 0) return 'skip'; // padding in HIBP range answers
  }
  return hexDigest(hex, WIDTH[kind]);
}

/**
 * Splits a byte stream into lines (`\n` or `\r\n`) without decoding it, never holding more than one line plus one
 * chunk. Lines longer than MAX_LINE_BYTES are reported as `null` (their content is dropped).
 */
export async function* lines(source: AsyncIterable<Buffer | Uint8Array | string>): AsyncGenerator<Buffer | null> {
  let carry: Buffer[] = [];
  let carryLen = 0;
  let overlong = false;
  for await (const raw of source) {
    const chunk = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start);
      if (nl < 0) {
        const rest = chunk.length - start;
        if (rest > 0) {
          if (carryLen + rest > MAX_LINE_BYTES) {
            overlong = true;
            carry = [];
            carryLen = 0;
          } else if (!overlong) {
            carry.push(Buffer.from(chunk.subarray(start)));
            carryLen += rest;
          }
        }
        break;
      }
      const piece = chunk.subarray(start, nl);
      start = nl + 1;
      if (overlong || carryLen + piece.length > MAX_LINE_BYTES + 1) {
        overlong = false;
        carry = [];
        carryLen = 0;
        yield null;
        continue;
      }
      let line = carryLen ? Buffer.concat([...carry, piece]) : piece;
      carry = [];
      carryLen = 0;
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      if (line.length > MAX_LINE_BYTES) {
        yield null;
        continue;
      }
      yield line;
    }
  }
  if (overlong) yield null;
  else if (carryLen) {
    let line = Buffer.concat(carry);
    if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
    yield line;
  }
}
