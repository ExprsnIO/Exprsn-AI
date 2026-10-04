import { createHash, createPublicKey, randomBytes, verify, type KeyObject } from 'node:crypto';
import { isIP } from 'node:net';
import { Asn1Error, bits, bool, children, enumerated, expect, int, namedBits, nul, octets, oid, parse, readBits, readOid, readString, seq, set, tagged, tlv, utf8, x509Time, type Asn1 } from './asn1.js';

/*
 * X.509 certificates and CRLs (RFC 5280) built from their to-be-signed bytes, and PKCS#10 requests parsed and
 * verified (RFC 2986). The CA never holds a private key: `buildCertificate` and `buildCrl` take an async `sign`
 * that the custody layer (`keys.ts`) answers from the signer process or OpenBao transit.
 */

export const OIDS = {
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  ecPublicKey: '1.2.840.10045.2.1',
  rsaEncryption: '1.2.840.113549.1.1.1',
  ed25519: '1.3.101.112',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  ecdsaSha384: '1.2.840.10045.4.3.3',
  ecdsaSha512: '1.2.840.10045.4.3.4',
  rsaSha256: '1.2.840.113549.1.1.11',
  rsaSha384: '1.2.840.113549.1.1.12',
  rsaSha512: '1.2.840.113549.1.1.13',
  extensionRequest: '1.2.840.113549.1.9.14',
  subjectKeyIdentifier: '2.5.29.14',
  keyUsage: '2.5.29.15',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  crlNumber: '2.5.29.20',
  reasonCode: '2.5.29.21',
  invalidityDate: '2.5.29.24',
  crlDistributionPoints: '2.5.29.31',
  authorityKeyIdentifier: '2.5.29.35',
  extKeyUsage: '2.5.29.37',
  authorityInfoAccess: '1.3.6.1.5.5.7.1.1',
  ocsp: '1.3.6.1.5.5.7.48.1',
  caIssuers: '1.3.6.1.5.5.7.48.2',
  serverAuth: '1.3.6.1.5.5.7.3.1',
  clientAuth: '1.3.6.1.5.5.7.3.2',
  codeSigning: '1.3.6.1.5.5.7.3.3',
  ocspSigning: '1.3.6.1.5.5.7.3.9',
  ocspNoCheck: '1.3.6.1.5.5.7.48.1.5'
} as const;

/** KeyUsage named bits (RFC 5280 4.2.1.3). */
export const KU = { digitalSignature: 1 << 0, nonRepudiation: 1 << 1, keyEncipherment: 1 << 2, dataEncipherment: 1 << 3, keyAgreement: 1 << 4, keyCertSign: 1 << 5, cRLSign: 1 << 6 } as const;

/** RFC 5280 5.3.1 reason codes this CA accepts (certificateHold and removeFromCRL are not supported; no holds). */
export const REASONS = { unspecified: 0, keyCompromise: 1, cACompromise: 2, affiliationChanged: 3, superseded: 4, cessationOfOperation: 5, privilegeWithdrawn: 9 } as const;
export type ReasonName = keyof typeof REASONS;
export const reasonName = (code: number): ReasonName => (Object.entries(REASONS).find(([, v]) => v === code)?.[0] ?? 'unspecified') as ReasonName;

export type IssuerKeyType = 'ecdsa-p256' | 'rsa-3072';

/** The AlgorithmIdentifier an issuer key signs with. */
export const signatureAlgorithm = (type: IssuerKeyType): Buffer => (type === 'ecdsa-p256' ? seq(oid(OIDS.ecdsaSha256)) : seq(oid(OIDS.rsaSha256), nul()));

/** A raw r||s ECDSA signature (what the signer and OpenBao's JWS marshaling return) as the DER X.509 wants. */
export function ecdsaToDer(p1363: Buffer): Buffer {
  if (p1363.length % 2 || p1363.length < 2) throw new Error('Unexpected ECDSA signature length');
  const half = p1363.length / 2;
  return seq(int(p1363.subarray(0, half)), int(p1363.subarray(half)));
}

/** A Name with a common name and, optionally, an organisation (UTF8String). */
export const distinguishedName = (commonName: string, organization?: string | null): Buffer =>
  seq(...(organization ? [set(seq(oid(OIDS.organization), utf8(organization)))] : []), set(seq(oid(OIDS.commonName), utf8(commonName))));

/** The subjectPublicKey bits of an SPKI (what key identifiers and OCSP key hashes are computed over). */
export function spkiKeyBits(spki: Buffer): Buffer {
  const parts = children(parse(spki));
  return readBits(parts[1], 'subjectPublicKey');
}

/** RFC 5280 4.2.1.2 method 1: SHA-1 of the subjectPublicKey bits. */
export const keyIdentifier = (spki: Buffer): Buffer => createHash('sha1').update(spkiKeyBits(spki)).digest();

export const spkiOf = (key: KeyObject): Buffer => key.export({ type: 'spki', format: 'der' });

/** 16 random bytes, positive, never with a leading zero byte (RFC 5280 4.1.2.2: at most 20 octets). */
export function newSerial(): Buffer {
  const b = randomBytes(16);
  b[0] = (b[0]! & 0x7f) | 0x40;
  return b;
}

const extension = (id: string, critical: boolean, value: Buffer): Buffer => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

export type San = { type: 'dns' | 'ip' | 'email' | 'uri'; value: string };

function generalName(n: San): Buffer {
  switch (n.type) {
    case 'dns':
      return tlv(0x82, Buffer.from(n.value, 'ascii'));
    case 'email':
      return tlv(0x81, Buffer.from(n.value, 'ascii'));
    case 'uri':
      return tlv(0x86, Buffer.from(n.value, 'ascii'));
    case 'ip':
      return tlv(0x87, ipBytes(n.value));
  }
}

export function ipBytes(ip: string): Buffer {
  const v = isIP(ip);
  if (v === 4) return Buffer.from(ip.split('.').map(Number));
  if (v === 6) {
    const [head, tail] = ip.includes('::') ? ip.split('::') : [ip, null];
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const groups = tail === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
    const out = Buffer.alloc(16);
    groups.forEach((g, i) => out.writeUInt16BE(parseInt(g || '0', 16), i * 2));
    return out;
  }
  throw new Error(`Not an IP address: ${ip}`);
}

export interface CertificateSpec {
  serial: Buffer;
  /** The issuer's subject Name, byte for byte as in its certificate. */
  issuerName: Buffer;
  subjectName: Buffer;
  /** The subject's public key (SPKI DER). */
  spki: Buffer;
  /** The issuer's public key (SPKI DER), for the authority key identifier; the subject's own for a root. */
  issuerSpki: Buffer;
  notBefore: number;
  notAfter: number;
  keyType: IssuerKeyType;
  ca?: { pathLen: number | null };
  keyUsage: number;
  extKeyUsage?: string[];
  sans?: San[];
  crlUrl?: string | null;
  ocspUrl?: string | null;
  caIssuersUrl?: string | null;
  ocspNoCheck?: boolean;
}

/** The to-be-signed certificate. */
export function tbsCertificate(c: CertificateSpec): Buffer {
  const ext: Buffer[] = [];
  ext.push(extension(OIDS.basicConstraints, true, c.ca ? seq(bool(true), ...(c.ca.pathLen === null ? [] : [int(c.ca.pathLen)])) : seq()));
  ext.push(extension(OIDS.keyUsage, true, namedBits(c.keyUsage)));
  if (c.extKeyUsage?.length) ext.push(extension(OIDS.extKeyUsage, false, seq(...c.extKeyUsage.map((o) => oid(o)))));
  ext.push(extension(OIDS.subjectKeyIdentifier, false, octets(keyIdentifier(c.spki))));
  if (!c.issuerSpki.equals(c.spki)) ext.push(extension(OIDS.authorityKeyIdentifier, false, seq(tlv(0x80, keyIdentifier(c.issuerSpki)))));
  if (c.sans?.length) ext.push(extension(OIDS.subjectAltName, false, seq(...c.sans.map(generalName))));
  if (c.crlUrl) ext.push(extension(OIDS.crlDistributionPoints, false, seq(seq(tagged(0, true, tagged(0, true, tlv(0x86, Buffer.from(c.crlUrl, 'ascii'))))))));
  const aia = [...(c.ocspUrl ? [seq(oid(OIDS.ocsp), tlv(0x86, Buffer.from(c.ocspUrl, 'ascii')))] : []), ...(c.caIssuersUrl ? [seq(oid(OIDS.caIssuers), tlv(0x86, Buffer.from(c.caIssuersUrl, 'ascii')))] : [])];
  if (aia.length) ext.push(extension(OIDS.authorityInfoAccess, false, seq(...aia)));
  if (c.ocspNoCheck) ext.push(extension(OIDS.ocspNoCheck, false, nul()));
  return seq(tagged(0, true, int(2)), int(c.serial), signatureAlgorithm(c.keyType), c.issuerName, seq(x509Time(c.notBefore), x509Time(c.notAfter)), c.subjectName, c.spki, tagged(3, true, seq(...ext)));
}

/** Signs a TBS structure: the result is `SEQUENCE { tbs, algorithm, BIT STRING signature }`. */
export async function signed(tbs: Buffer, keyType: IssuerKeyType, sign: (tbs: Buffer) => Promise<Buffer>): Promise<Buffer> {
  return seq(tbs, signatureAlgorithm(keyType), bits(await sign(tbs)));
}

export const buildCertificate = (c: CertificateSpec, sign: (tbs: Buffer) => Promise<Buffer>): Promise<Buffer> => signed(tbsCertificate(c), c.keyType, sign);

export interface CrlEntry {
  serial: Buffer;
  revokedAt: number;
  reason: number;
  invalidityDate?: number | null;
}

/** An X.509 v2 CRL (RFC 5280 5) with cRLNumber and the authority key identifier. */
export function tbsCrl(o: { issuerName: Buffer; issuerSpki: Buffer; keyType: IssuerKeyType; thisUpdate: number; nextUpdate: number; number: number; entries: CrlEntry[] }): Buffer {
  const revoked = o.entries.map((e) => {
    const ext: Buffer[] = [];
    // 5.3.1: the reason code SHOULD be absent rather than unspecified.
    if (e.reason !== REASONS.unspecified) ext.push(extension(OIDS.reasonCode, false, enumerated(e.reason)));
    if (e.invalidityDate) ext.push(seq(oid(OIDS.invalidityDate), octets(tlv(0x18, Buffer.from(new Date(e.invalidityDate).toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z', 'ascii')))));
    return seq(int(e.serial), x509Time(e.revokedAt), ...(ext.length ? [seq(...ext)] : []));
  });
  const crlExt = seq(extension(OIDS.authorityKeyIdentifier, false, seq(tlv(0x80, keyIdentifier(o.issuerSpki)))), extension(OIDS.crlNumber, false, int(o.number)));
  return seq(int(1), signatureAlgorithm(o.keyType), o.issuerName, x509Time(o.thisUpdate), x509Time(o.nextUpdate), ...(revoked.length ? [seq(...revoked)] : []), tagged(0, true, crlExt));
}

// ---------------------------------------------------------------------------------------------------------------
// Parsing what the CA reads back: its own certificates (names, keys) and certificate signing requests.

/** The parts of a certificate the CA needs: the exact subject Name bytes, the SPKI and the serial. */
export function certificateParts(der: Buffer): { subject: Buffer; spki: Buffer; serial: Buffer; tbs: Buffer } {
  const top = children(parse(der));
  const tbs = expect(top[0], 0x30, 'tbsCertificate');
  const f = children(tbs);
  const i = f[0]?.tag === 0xa0 ? 1 : 0;
  return { serial: expect(f[i], 0x02, 'serialNumber').value, subject: expect(f[i + 4], 0x30, 'subject').raw, spki: expect(f[i + 5], 0x30, 'subjectPublicKeyInfo').raw, tbs: tbs.raw };
}

export type CsrKeyType = 'ec-p256' | 'ec-p384' | 'rsa-2048' | 'rsa-3072' | 'rsa-4096' | 'ed25519';
export const CSR_KEY_TYPES: readonly CsrKeyType[] = ['ec-p256', 'ec-p384', 'rsa-2048', 'rsa-3072', 'rsa-4096', 'ed25519'];

export interface ParsedCsr {
  commonName: string | null;
  sans: San[];
  spki: Buffer;
  publicKey: KeyObject;
  keyType: CsrKeyType;
}

export class CsrError extends Error {}

function classify(key: KeyObject): CsrKeyType {
  const d = key.asymmetricKeyDetails ?? {};
  if (key.asymmetricKeyType === 'ed25519') return 'ed25519';
  if (key.asymmetricKeyType === 'ec') {
    if (d.namedCurve === 'prime256v1') return 'ec-p256';
    if (d.namedCurve === 'secp384r1') return 'ec-p384';
    throw new CsrError(`The curve ${String(d.namedCurve)} is not accepted; use P-256 or P-384.`);
  }
  if (key.asymmetricKeyType === 'rsa') {
    const bitsLen = d.modulusLength ?? 0;
    if (bitsLen === 2048 || bitsLen === 3072 || bitsLen === 4096) return `rsa-${bitsLen}` as CsrKeyType;
    throw new CsrError(`An RSA key of ${bitsLen} bits is not accepted; use 2048, 3072 or 4096.`);
  }
  throw new CsrError(`The key type ${String(key.asymmetricKeyType)} is not accepted.`);
}

function readGeneralNames(seqNode: Asn1): San[] {
  const out: San[] = [];
  for (const g of children(seqNode)) {
    if (g.tag === 0x82) out.push({ type: 'dns', value: g.value.toString('ascii') });
    else if (g.tag === 0x81) out.push({ type: 'email', value: g.value.toString('ascii') });
    else if (g.tag === 0x86) out.push({ type: 'uri', value: g.value.toString('ascii') });
    else if (g.tag === 0x87) {
      if (g.value.length === 4) out.push({ type: 'ip', value: [...g.value].join('.') });
      else if (g.value.length === 16) out.push({ type: 'ip', value: (g.value.toString('hex').match(/..../g) ?? []).map((x) => x.replace(/^0+(?=.)/, '')).join(':') });
      else throw new CsrError('An IP address name has the wrong length.');
    } else throw new CsrError('The request names a subject alternative name type this CA does not issue.');
  }
  return out;
}

/** Parses and verifies a PKCS#10 request (its self-signature proves possession of the key). */
export function parseCsr(der: Buffer): ParsedCsr {
  try {
    const top = children(parse(der));
    const info = expect(top[0], 0x30, 'certificationRequestInfo');
    const alg = readOid(children(expect(top[1], 0x30, 'signatureAlgorithm'))[0]);
    const sig = readBits(top[2], 'signature');
    const f = children(info);
    if (expect(f[0], 0x02, 'version').value.toString('hex') !== '00') throw new CsrError('Only version 1 requests are accepted.');
    const subject = expect(f[1], 0x30, 'subject');
    const spkiNode = expect(f[2], 0x30, 'subjectPublicKeyInfo');
    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey({ key: spkiNode.raw, format: 'der', type: 'spki' });
    } catch {
      throw new CsrError('The public key in the request does not parse.');
    }
    const keyType = classify(publicKey);
    const hash = alg === OIDS.ecdsaSha256 || alg === OIDS.rsaSha256 ? 'sha256' : alg === OIDS.ecdsaSha384 || alg === OIDS.rsaSha384 ? 'sha384' : alg === OIDS.ecdsaSha512 || alg === OIDS.rsaSha512 ? 'sha512' : alg === OIDS.ed25519 ? null : undefined;
    if (hash === undefined) throw new CsrError('The request is signed with an algorithm this CA does not accept.');
    const ok = keyType === 'ed25519' ? alg === OIDS.ed25519 && verify(null, info.raw, publicKey, sig) : keyType.startsWith('ec-') ? [OIDS.ecdsaSha256, OIDS.ecdsaSha384, OIDS.ecdsaSha512].includes(alg as never) && verify(hash, info.raw, { key: publicKey, dsaEncoding: 'der' }, sig) : [OIDS.rsaSha256, OIDS.rsaSha384, OIDS.rsaSha512].includes(alg as never) && verify(hash, info.raw, publicKey, sig);
    if (!ok) throw new CsrError('The request signature does not verify.');
    let commonName: string | null = null;
    for (const rdn of children(subject)) {
      for (const atv of children(rdn)) {
        const [t, v] = children(atv);
        if (readOid(t) === OIDS.commonName && v) commonName = readString(v);
      }
    }
    const sans: San[] = [];
    if (f[3]) {
      for (const attr of children(expect(f[3], 0xa0, 'attributes'))) {
        const [t, values] = children(attr);
        if (readOid(t) !== OIDS.extensionRequest || !values) continue;
        for (const exts of children(values)) {
          for (const e of children(exts)) {
            const parts = children(e);
            if (readOid(parts[0]) !== OIDS.subjectAltName) continue;
            const value = expect(parts[parts.length - 1], 0x04, 'extnValue');
            sans.push(...readGeneralNames(parse(value.value)));
          }
        }
      }
    }
    return { commonName, sans, spki: publicKey.export({ type: 'spki', format: 'der' }), publicKey, keyType };
  } catch (err) {
    if (err instanceof CsrError) throw err;
    if (err instanceof Asn1Error) throw new CsrError(`The request is not valid DER: ${err.message}.`);
    throw new CsrError(`The request does not parse: ${(err as Error).message}`);
  }
}

