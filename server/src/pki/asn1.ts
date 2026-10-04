import { bits, bool, int, octets, oid, seq, set, tagged, tlv, utf8 } from '../ops/der.js';

/*
 * ASN.1 DER for the certificate authority (B-1601 to B-1604): the writer helpers from `ops/der.ts` plus the few the
 * CA needs on top (times, enumerations, strings), and a strict reader for what the CA parses from outside: PKCS#10
 * requests (RFC 2986) and OCSP requests (RFC 6960). The reader accepts definite lengths only, single-byte tags and
 * nothing past the end of its input; anything else is an `Asn1Error`.
 */

export { bits, bool, int, octets, oid, seq, set, tagged, tlv, utf8 };

export class Asn1Error extends Error {}

export const nul = (): Buffer => Buffer.from([0x05, 0x00]);
export const enumerated = (n: number): Buffer => tlv(0x0a, Buffer.from([n]));
export const ia5 = (s: string): Buffer => tlv(0x16, Buffer.from(s, 'ascii'));
export const printable = (s: string): Buffer => tlv(0x13, Buffer.from(s, 'ascii'));

const stamp = (ms: number): string => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
/** GeneralizedTime, whole seconds (OCSP uses it throughout). */
export const generalizedTime = (ms: number): Buffer => tlv(0x18, Buffer.from(stamp(ms), 'ascii'));
/** RFC 5280 4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050 on (certificates and CRLs). */
export const x509Time = (ms: number): Buffer => (new Date(ms).getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(stamp(ms).slice(2), 'ascii')) : generalizedTime(ms));

/** A named-bit BIT STRING (KeyUsage) with trailing zero bits trimmed, as DER requires. */
export function namedBits(value: number, width = 9): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < width; i += 8) {
    let b = 0;
    for (let j = 0; j < 8 && i + j < width; j++) if (value & (1 << (i + j))) b |= 0x80 >> j;
    bytes.push(b);
  }
  while (bytes.length && bytes[bytes.length - 1] === 0) bytes.pop();
  if (!bytes.length) return tlv(0x03, Buffer.from([0]));
  const last = bytes[bytes.length - 1]!;
  let unused = 0;
  while (((last >> unused) & 1) === 0) unused++;
  return tlv(0x03, Buffer.from([unused]), Buffer.from(bytes));
}

// ---------------------------------------------------------------------------------------------------------------
// Reader

export interface Asn1 {
  tag: number;
  /** The whole element, header included. */
  raw: Buffer;
  /** The contents. */
  value: Buffer;
}

/** Reads one element at `offset` and returns it with the offset after it. */
export function readAt(buf: Buffer, offset: number): { node: Asn1; next: number } {
  if (offset + 2 > buf.length) throw new Asn1Error('Truncated element');
  const tag = buf[offset]!;
  if ((tag & 0x1f) === 0x1f) throw new Asn1Error('Multi-byte tags are not supported');
  let len = buf[offset + 1]!;
  let head = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0) throw new Asn1Error('Indefinite lengths are not DER');
    if (n > 4) throw new Asn1Error('Length too large');
    if (offset + 2 + n > buf.length) throw new Asn1Error('Truncated length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[offset + 2 + i]!;
    if (len < 0x80 || (n > 1 && buf[offset + 2] === 0)) throw new Asn1Error('Length is not minimally encoded');
    head = 2 + n;
  }
  const end = offset + head + len;
  if (end > buf.length) throw new Asn1Error('Truncated contents');
  return { node: { tag, raw: buf.subarray(offset, end), value: buf.subarray(offset + head, end) }, next: end };
}

/** Parses a buffer that must hold exactly one element. */
export function parse(buf: Buffer): Asn1 {
  const { node, next } = readAt(buf, 0);
  if (next !== buf.length) throw new Asn1Error('Trailing data');
  return node;
}

/** The elements inside a constructed element. */
export function children(n: Asn1): Asn1[] {
  if (!(n.tag & 0x20)) throw new Asn1Error('Not a constructed element');
  const out: Asn1[] = [];
  let off = 0;
  while (off < n.value.length) {
    const r = readAt(n.value, off);
    out.push(r.node);
    off = r.next;
    if (out.length > 10_000) throw new Asn1Error('Too many elements');
  }
  return out;
}

export function expect(n: Asn1 | undefined, tag: number, what: string): Asn1 {
  if (!n || n.tag !== tag) throw new Asn1Error(`Expected ${what}`);
  return n;
}

export function readOid(n: Asn1 | undefined): string {
  const v = expect(n, 0x06, 'an object identifier').value;
  if (!v.length) throw new Asn1Error('Empty object identifier');
  const parts: number[] = [];
  let acc = 0;
  for (let i = 0; i < v.length; i++) {
    acc = acc * 128 + (v[i]! & 0x7f);
    if (acc > Number.MAX_SAFE_INTEGER / 256) throw new Asn1Error('Object identifier arc too large');
    if (!(v[i]! & 0x80)) {
      if (!parts.length) parts.push(acc < 80 ? Math.floor(acc / 40) : 2, acc < 80 ? acc % 40 : acc - 80);
      else parts.push(acc);
      acc = 0;
    } else if (i === v.length - 1) throw new Asn1Error('Truncated object identifier');
  }
  return parts.join('.');
}

/** An INTEGER's magnitude (non-negative) as bytes without leading zeros. */
export function readUnsigned(n: Asn1 | undefined, what = 'an integer'): Buffer {
  const v = expect(n, 0x02, what).value;
  if (!v.length) throw new Asn1Error('Empty integer');
  if (v[0]! & 0x80) throw new Asn1Error('Negative integer');
  let i = 0;
  while (i < v.length - 1 && v[i] === 0) i++;
  return v.subarray(i);
}

/** The string value of a directory string (UTF8, Printable, IA5, Teletex as Latin-1, BMP). */
export function readString(n: Asn1): string {
  switch (n.tag) {
    case 0x0c:
      return n.value.toString('utf8');
    case 0x13:
    case 0x16:
      return n.value.toString('ascii');
    case 0x14:
      return n.value.toString('latin1');
    case 0x1e: {
      const swapped = Buffer.from(n.value);
      if (swapped.length % 2) throw new Asn1Error('Odd BMPString');
      swapped.swap16();
      return swapped.toString('utf16le');
    }
    default:
      throw new Asn1Error('Unsupported string type');
  }
}

/** The bytes of a BIT STRING with no unused bits. */
export function readBits(n: Asn1 | undefined, what = 'a bit string'): Buffer {
  const v = expect(n, 0x03, what).value;
  if (!v.length || v[0] !== 0) throw new Asn1Error(`${what} must have no unused bits`);
  return v.subarray(1);
}

export const pem = (der: Buffer, type: string): string => `-----BEGIN ${type}-----\n${der.toString('base64').replace(/.{1,64}/g, '$&\n')}-----END ${type}-----\n`;

/** The DER inside a PEM block of `type` (or of any of `types`). */
export function fromPem(text: string, ...types: string[]): Buffer {
  for (const type of types) {
    const m = new RegExp(`-----BEGIN ${type}-----([A-Za-z0-9+/=\\s]+)-----END ${type}-----`).exec(text);
    if (m) return Buffer.from(m[1]!.replace(/\s+/g, ''), 'base64');
  }
  throw new Asn1Error(`Expected a PEM ${types[0]} block`);
}
