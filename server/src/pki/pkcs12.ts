import { createCipheriv, createHash, createHmac, pbkdf2Sync, randomBytes, type KeyObject } from 'node:crypto';
import { int, nul, octets, oid, seq, set, tagged, tlv } from './asn1.js';

/*
 * PKCS#12 (RFC 7292) writer for certificate export (B-1606), built on node:crypto with the modern parameters
 * OpenSSL 3 uses by default:
 *
 *   - the certificates in an encryptedData content, and the private key (when there is one) as a
 *     pkcs8ShroudedKeyBag, both encrypted with PBES2 (RFC 8018): PBKDF2 with HMAC-SHA256 and AES-256-CBC;
 *   - the integrity MAC as HMAC-SHA256 with its key from the PKCS#12 key derivation (RFC 7292 appendix B.2, ID 3).
 *
 * The key and its certificate share a localKeyId attribute (the SHA-1 of the certificate), so readers pair them.
 * Nothing older (RC2, 3DES, SHA-1 MACs) is written.
 */

const OID = {
  data: '1.2.840.113549.1.7.1',
  encryptedData: '1.2.840.113549.1.7.6',
  shroudedKeyBag: '1.2.840.113549.1.12.10.1.2',
  certBag: '1.2.840.113549.1.12.10.1.3',
  x509Certificate: '1.2.840.113549.1.9.22.1',
  friendlyName: '1.2.840.113549.1.9.20',
  localKeyId: '1.2.840.113549.1.9.21',
  pbes2: '1.2.840.113549.1.5.13',
  pbkdf2: '1.2.840.113549.1.5.12',
  hmacWithSha256: '1.2.840.113549.2.9',
  aes256Cbc: '2.16.840.1.101.3.4.1.42',
  sha256: '2.16.840.1.101.3.4.2.1'
} as const;

export const PKCS12_ITERATIONS = 100_000;
/** The MAC key derivation is a plain hash loop; OpenSSL's default count. */
export const PKCS12_MAC_ITERATIONS = 2048;

/** DER SET OF: the elements sorted by their encodings (X.690 11.6). */
const setOf = (...items: Buffer[]): Buffer => set(...[...items].sort(Buffer.compare));

const bmp = (s: string): Buffer => {
  const b = Buffer.from(s, 'utf16le');
  b.swap16();
  return b;
};

/** PBES2 with PBKDF2-HMAC-SHA256 and AES-256-CBC: the AlgorithmIdentifier and the ciphertext. */
function pbes2Encrypt(plain: Buffer, password: string, iterations: number): { alg: Buffer; data: Buffer } {
  const salt = randomBytes(16);
  const iv = randomBytes(16);
  const key = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
  const c = createCipheriv('aes-256-cbc', key, iv);
  const data = Buffer.concat([c.update(plain), c.final()]);
  const kdf = seq(oid(OID.pbkdf2), seq(octets(salt), int(iterations), seq(oid(OID.hmacWithSha256), nul())));
  const enc = seq(oid(OID.aes256Cbc), octets(iv));
  return { alg: seq(oid(OID.pbes2), seq(kdf, enc)), data };
}

/** RFC 7292 appendix B.2 key derivation with SHA-256 (u = 32, v = 64). `id` 3 makes a MAC key. */
export function pkcs12Kdf(password: string, salt: Buffer, id: number, iterations: number, length: number): Buffer {
  const u = 32;
  const v = 64;
  const pw = Buffer.concat([bmp(password), Buffer.from([0, 0])]);
  const fill = (b: Buffer) => {
    if (!b.length) return Buffer.alloc(0);
    const n = v * Math.ceil(b.length / v);
    const out = Buffer.alloc(n);
    for (let i = 0; i < n; i++) out[i] = b[i % b.length]!;
    return out;
  };
  const D = Buffer.alloc(v, id);
  const I = Buffer.concat([fill(salt), fill(pw)]);
  const out: Buffer[] = [];
  for (let i = 0; i < Math.ceil(length / u); i++) {
    let A = createHash('sha256').update(D).update(I).digest();
    for (let r = 1; r < iterations; r++) A = createHash('sha256').update(A).digest();
    out.push(A);
    const B = fill(A);
    for (let j = 0; j < I.length; j += v) {
      // I_j = (I_j + B + 1) mod 2^(8v)
      let carry = 1;
      for (let k = v - 1; k >= 0; k--) {
        const sum = I[j + k]! + B[k]! + carry;
        I[j + k] = sum & 0xff;
        carry = sum >> 8;
      }
    }
  }
  return Buffer.concat(out).subarray(0, length);
}

const attribute = (id: string, value: Buffer): Buffer => seq(oid(id), setOf(value));
const contentInfoData = (content: Buffer): Buffer => seq(oid(OID.data), tagged(0, true, octets(content)));

export interface Pkcs12Input {
  /** The end-entity certificate first, then its chain (DER). */
  certificates: Buffer[];
  /** The private key of the first certificate, when the bundle carries one. */
  privateKey?: KeyObject | null;
  password: string;
  friendlyName?: string;
  iterations?: number;
  macIterations?: number;
}

/** Builds a PKCS#12 (PFX) file. */
export function buildPkcs12(o: Pkcs12Input): Buffer {
  if (!o.certificates.length) throw new Error('A PKCS#12 file needs at least one certificate.');
  if (!o.password) throw new Error('A PKCS#12 file needs a password.');
  const iterations = o.iterations ?? PKCS12_ITERATIONS;
  const localKeyId = createHash('sha1').update(o.certificates[0]!).digest();
  const leafAttrs = [attribute(OID.localKeyId, octets(localKeyId)), ...(o.friendlyName ? [attribute(OID.friendlyName, tlv(0x1e, bmp(o.friendlyName)))] : [])];

  const certBags = o.certificates.map((der, i) => seq(oid(OID.certBag), tagged(0, true, seq(oid(OID.x509Certificate), tagged(0, true, octets(der)))), ...(i === 0 && o.privateKey ? [setOf(...leafAttrs)] : [])));
  const certContents = seq(...certBags);
  const encCerts = pbes2Encrypt(certContents, o.password, iterations);
  // EncryptedData { version 0, EncryptedContentInfo { data, algorithm, [0] IMPLICIT encryptedContent } }
  const encryptedData = seq(oid(OID.encryptedData), tagged(0, true, seq(int(0), seq(oid(OID.data), encCerts.alg, tlv(0x80, encCerts.data)))));

  const safes: Buffer[] = [encryptedData];
  if (o.privateKey) {
    const pkcs8 = o.privateKey.export({ type: 'pkcs8', format: 'der' });
    const encKey = pbes2Encrypt(pkcs8, o.password, iterations);
    const keyBag = seq(oid(OID.shroudedKeyBag), tagged(0, true, seq(encKey.alg, octets(encKey.data))), setOf(...leafAttrs));
    safes.push(contentInfoData(seq(keyBag)));
  }
  const authSafe = seq(...safes);

  const macSalt = randomBytes(16);
  const macIterations = o.macIterations ?? PKCS12_MAC_ITERATIONS;
  const macKey = pkcs12Kdf(o.password, macSalt, 3, macIterations, 32);
  const mac = createHmac('sha256', macKey).update(authSafe).digest();
  const macData = seq(seq(seq(oid(OID.sha256), nul()), octets(mac)), octets(macSalt), int(macIterations));
  return seq(int(3), contentInfoData(authSafe), macData);
}
