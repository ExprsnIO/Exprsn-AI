import { createPublicKey, sign, type KeyObject } from 'node:crypto';

/*
 * A small ASN.1 DER writer: enough to build a PKCS#10 certificate signing request for ACME without a dependency.
 * (Tests use the same helpers to issue certificates from a fake CA.)
 */

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};

export const seq = (...parts: Buffer[]): Buffer => tlv(0x30, ...parts);
export const set = (...parts: Buffer[]): Buffer => tlv(0x31, ...parts);
export const octets = (b: Buffer): Buffer => tlv(0x04, b);
export const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, 'utf8'));
export const bits = (b: Buffer): Buffer => tlv(0x03, Buffer.from([0]), b);
export const bool = (v: boolean): Buffer => tlv(0x01, Buffer.from([v ? 0xff : 0]));
/** A context-specific tag: `[n]` constructed (explicit) or primitive (implicit). */
export const tagged = (n: number, constructed: boolean, ...parts: Buffer[]): Buffer => tlv((constructed ? 0xa0 : 0x80) | n, ...parts);

export function int(v: number | Buffer): Buffer {
  let b: Buffer;
  if (typeof v === 'number') {
    const bytes: number[] = [];
    let n = v;
    do {
      bytes.unshift(n & 0xff);
      n = Math.floor(n / 256);
    } while (n > 0);
    b = Buffer.from(bytes);
  } else {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    b = v.subarray(i);
  }
  if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

export function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const out: number[] = [40 * parts[0]! + parts[1]!];
  for (const p of parts.slice(2)) {
    const chunk: number[] = [p & 0x7f];
    let n = Math.floor(p / 128);
    while (n > 0) {
      chunk.unshift((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

/** GeneralizedTime (YYYYMMDDHHMMSSZ). */
export const time = (ms: number): Buffer => tlv(0x18, Buffer.from(new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z'));

export const OID = {
  commonName: '2.5.4.3',
  extensionRequest: '1.2.840.113549.1.9.14',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  ecdsaSha256: '1.2.840.10045.4.3.2'
} as const;

/** A name with a single common name. */
export const name = (cn: string): Buffer => seq(set(seq(oid(OID.commonName), utf8(cn))));

/** The subjectAltName extension value: dNSName entries. */
export const sanValue = (domains: string[]): Buffer => seq(...domains.map((d) => tlv(0x82, Buffer.from(d, 'ascii'))));

/** A PKCS#10 CSR for an ECDSA P-256 key: CN is the first domain, every domain goes into subjectAltName. */
export function buildCsr(domains: string[], privateKey: KeyObject): Buffer {
  if (!domains.length) throw new Error('A CSR needs at least one domain');
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const extensions = seq(seq(oid(OID.subjectAltName), octets(sanValue(domains))));
  const info = seq(int(0), name(domains[0]!), spki, tagged(0, true, seq(oid(OID.extensionRequest), set(extensions))));
  const signature = sign('sha256', info, privateKey);
  return seq(info, seq(oid(OID.ecdsaSha256)), bits(signature));
}

/** PEM blocks of a given type, as DER. */
export function pemBlocks(pem: string, type = 'CERTIFICATE'): Buffer[] {
  const re = new RegExp(`-----BEGIN ${type}-----([\\s\\S]*?)-----END ${type}-----`, 'g');
  return [...pem.matchAll(re)].map((m) => Buffer.from(m[1]!.replace(/\s+/g, ''), 'base64'));
}

export const toPem = (der: Buffer, type = 'CERTIFICATE'): string => `-----BEGIN ${type}-----\n${der.toString('base64').replace(/.{1,64}/g, '$&\n')}-----END ${type}-----\n`;
