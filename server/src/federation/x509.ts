import { randomBytes, sign, type KeyObject } from 'node:crypto';

/*
 * A minimal DER writer, enough to build a self-signed X.509 v3 certificate for the SAML IdP signing key.
 * node:crypto can parse certificates (X509Certificate) but not create them.
 */

const len = (n: number): Buffer => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};

const tlv = (tag: number, value: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), len(value.length), value]);

export const der = {
  seq: (...items: Buffer[]) => tlv(0x30, Buffer.concat(items)),
  set: (...items: Buffer[]) => tlv(0x31, Buffer.concat(items)),
  int: (value: Buffer | number) => {
    let b = typeof value === 'number' ? Buffer.from([value]) : value;
    while (b.length > 1 && b[0] === 0 && (b[1]! & 0x80) === 0) b = b.subarray(1);
    if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    return tlv(0x02, b);
  },
  nul: () => Buffer.from([0x05, 0x00]),
  bits: (value: Buffer) => tlv(0x03, Buffer.concat([Buffer.from([0]), value])),
  utf8: (s: string) => tlv(0x0c, Buffer.from(s, 'utf8')),
  explicit: (n: number, value: Buffer) => tlv(0xa0 + n, value),
  oid: (dotted: string) => {
    const parts = dotted.split('.').map(Number);
    const out: number[] = [parts[0]! * 40 + parts[1]!];
    for (const p of parts.slice(2)) {
      const stack: number[] = [p & 0x7f];
      let v = Math.floor(p / 128);
      while (v > 0) {
        stack.unshift((v & 0x7f) | 0x80);
        v = Math.floor(v / 128);
      }
      out.push(...stack);
    }
    return tlv(0x06, Buffer.from(out));
  },
  time: (d: Date) => {
    // UTCTime through 2049, GeneralizedTime after (RFC 5280 4.1.2.5).
    const iso = d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
    return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2), 'ascii')) : tlv(0x18, Buffer.from(iso, 'ascii'));
  }
};

const OID = { sha256WithRSA: '1.2.840.113549.1.1.11', ecdsaWithSHA256: '1.2.840.10045.4.3.2', commonName: '2.5.4.3', organization: '2.5.4.10', basicConstraints: '2.5.29.19', keyUsage: '2.5.29.15' };

const name = (cn: string, org: string) => der.seq(der.set(der.seq(der.oid(OID.organization), der.utf8(org))), der.set(der.seq(der.oid(OID.commonName), der.utf8(cn))));

interface CertParams {
  publicKey: KeyObject;
  commonName: string;
  organization?: string;
  notBefore?: Date;
  days: number;
}

/** The to-be-signed part of a self-signed certificate and its signature algorithm identifier. */
function tbsCertificate(opts: CertParams, rsa: boolean): { tbs: Buffer; alg: Buffer } {
  const alg = rsa ? der.seq(der.oid(OID.sha256WithRSA), der.nul()) : der.seq(der.oid(OID.ecdsaWithSHA256));
  const from = opts.notBefore ?? new Date(Date.now() - 5 * 60_000);
  const to = new Date(from.getTime() + opts.days * 86_400_000);
  const serial = randomBytes(16);
  serial[0] = serial[0]! & 0x7f;
  const subject = name(opts.commonName, opts.organization ?? 'Exprsn-AI');
  const spki = opts.publicKey.export({ type: 'spki', format: 'der' });
  const extensions = der.explicit(
    3,
    der.seq(
      der.seq(der.oid(OID.basicConstraints), tlv(0x01, Buffer.from([0xff])), tlv(0x04, der.seq())),
      // digitalSignature and keyEncipherment (the same certificate type serves SAML signing and encryption keys).
      der.seq(der.oid(OID.keyUsage), tlv(0x01, Buffer.from([0xff])), tlv(0x04, tlv(0x03, Buffer.from([0x05, 0xa0]))))
    )
  );
  const tbs = der.seq(der.explicit(0, der.int(2)), der.int(serial), alg, subject, der.seq(der.time(from), der.time(to)), subject, spki, extensions);
  return { tbs, alg };
}

/** A self-signed certificate (DER) for `publicKey`, signed by `privateKey` (RSA → sha256WithRSAEncryption, EC → ecdsa-with-SHA256). */
export function selfSignedCertificate(opts: CertParams & { privateKey: KeyObject }): Buffer {
  const rsa = opts.privateKey.asymmetricKeyType === 'rsa';
  const { tbs, alg } = tbsCertificate(opts, rsa);
  const signature = rsa ? sign('sha256', tbs, opts.privateKey) : sign('sha256', tbs, { key: opts.privateKey, dsaEncoding: 'der' });
  return der.seq(tbs, alg, der.bits(signature));
}

/** The same for an RSA key held in a KMS: `signRsa` returns a PKCS#1 v1.5 SHA-256 signature. */
export async function selfSignedRsaCertificate(opts: CertParams & { signRsa: (tbs: Buffer) => Promise<Buffer> }): Promise<Buffer> {
  const { tbs, alg } = tbsCertificate(opts, true);
  return der.seq(tbs, alg, der.bits(await opts.signRsa(tbs)));
}

export const pemOf = (derBytes: Buffer): string => `-----BEGIN CERTIFICATE-----\n${derBytes.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END CERTIFICATE-----\n`;

/** Accepts PEM or bare base64 DER (as found in SAML metadata) and returns base64 DER without whitespace. */
export const normaliseCertificate = (text: string): string => text.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
