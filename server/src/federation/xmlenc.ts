import { constants, createCipheriv, createDecipheriv, privateDecrypt, publicEncrypt, randomBytes, X509Certificate, type KeyObject } from 'node:crypto';
import { attr, child, descendants, elements, NS, textOf, XmlError, type XmlElement } from './xml.js';

/*
 * XML Encryption for SAML assertions, only the modern algorithms:
 *   - content: AES-GCM (xmlenc 1.1 aes256-gcm; aes128-gcm is also accepted when decrypting). CBC modes are refused,
 *     because CBC in XML Encryption is open to padding-oracle attacks.
 *   - key transport: RSA-OAEP (xmlenc 1.1 rsa-oaep, or rsa-oaep-mgf1p), with SHA-1 or SHA-256 used for both the
 *     digest and MGF1. RSA PKCS#1 v1.5 key transport is refused (Bleichenbacher).
 * Encryption (this server as IdP) always uses AES-256-GCM with RSA-OAEP, SHA-256 digest and MGF1-SHA-256.
 */

export const ENC = {
  aes256gcm: 'http://www.w3.org/2009/xmlenc11#aes256-gcm',
  aes128gcm: 'http://www.w3.org/2009/xmlenc11#aes128-gcm',
  rsaOaep: 'http://www.w3.org/2009/xmlenc11#rsa-oaep',
  rsaOaepMgf1p: 'http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p',
  mgf1sha1: 'http://www.w3.org/2009/xmlenc11#mgf1sha1',
  mgf1sha256: 'http://www.w3.org/2009/xmlenc11#mgf1sha256',
  sha1: 'http://www.w3.org/2000/09/xmldsig#sha1',
  sha256: 'http://www.w3.org/2001/04/xmlenc#sha256',
  element: 'http://www.w3.org/2001/04/xmlenc#Element'
};

export class XmlEncError extends Error {}

/**
 * Encrypts a (signed) `<saml:Assertion>` for the holder of `certificateB64` (base64 DER): returns the
 * `<saml:EncryptedAssertion>` element that replaces it in the response.
 */
export function encryptAssertion(assertionXml: string, certificateB64: string): string {
  const publicKey = new X509Certificate(Buffer.from(certificateB64, 'base64')).publicKey;
  if (publicKey.asymmetricKeyType !== 'rsa') throw new XmlEncError('The encryption certificate must hold an RSA key.');
  const cek = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cek, iv);
  const ct = Buffer.concat([cipher.update(assertionXml, 'utf8'), cipher.final()]);
  const content = Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64');
  const wrapped = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, cek).toString('base64');
  return (
    `<saml:EncryptedAssertion xmlns:saml="${NS.saml}">` +
    `<xenc:EncryptedData xmlns:xenc="${NS.xenc}" Type="${ENC.element}">` +
    `<xenc:EncryptionMethod Algorithm="${ENC.aes256gcm}"></xenc:EncryptionMethod>` +
    `<ds:KeyInfo xmlns:ds="${NS.ds}"><xenc:EncryptedKey>` +
    `<xenc:EncryptionMethod Algorithm="${ENC.rsaOaep}"><ds:DigestMethod Algorithm="${ENC.sha256}"></ds:DigestMethod><xenc11:MGF xmlns:xenc11="${NS.xenc11}" Algorithm="${ENC.mgf1sha256}"></xenc11:MGF></xenc:EncryptionMethod>` +
    `<xenc:CipherData><xenc:CipherValue>${wrapped}</xenc:CipherValue></xenc:CipherData>` +
    `</xenc:EncryptedKey></ds:KeyInfo>` +
    `<xenc:CipherData><xenc:CipherValue>${content}</xenc:CipherValue></xenc:CipherData>` +
    `</xenc:EncryptedData></saml:EncryptedAssertion>`
  );
}

const cipherValue = (el: XmlElement | undefined): Buffer => {
  const v = textOf(child(child(el, NS.xenc, 'CipherData'), NS.xenc, 'CipherValue')).replace(/\s+/g, '');
  if (!v) throw new XmlEncError('The encrypted element has no CipherValue (CipherReference is not supported).');
  return Buffer.from(v, 'base64');
};

/** The OAEP hash for an EncryptedKey's method: SHA-1 or SHA-256, the same for the digest and MGF1. */
function oaepHash(method: XmlElement | undefined): 'sha1' | 'sha256' {
  const alg = attr(method, 'Algorithm');
  if (alg !== ENC.rsaOaep && alg !== ENC.rsaOaepMgf1p) throw new XmlEncError(`Key transport ${alg ?? '(none)'} is refused; only RSA-OAEP is accepted.`);
  if (method && elements(method, NS.xenc, 'OAEPparams').length) throw new XmlEncError('OAEP parameters (a label) are not supported.');
  const digestUri = attr(child(method, NS.ds, 'DigestMethod'), 'Algorithm') ?? ENC.sha1;
  const digest = digestUri === ENC.sha256 ? 'sha256' : digestUri === ENC.sha1 ? 'sha1' : null;
  if (!digest) throw new XmlEncError('Only SHA-1 and SHA-256 OAEP digests are accepted.');
  // rsa-oaep-mgf1p fixes MGF1 with SHA-1; xmlenc 1.1 rsa-oaep names it (default SHA-1).
  const mgfUri = alg === ENC.rsaOaepMgf1p ? ENC.mgf1sha1 : (attr(child(method, NS.xenc11, 'MGF'), 'Algorithm') ?? ENC.mgf1sha1);
  const mgf = mgfUri === ENC.mgf1sha256 ? 'sha256' : mgfUri === ENC.mgf1sha1 ? 'sha1' : null;
  if (!mgf || mgf !== digest) throw new XmlEncError('The OAEP digest and MGF1 hash must be the same (SHA-1 or SHA-256).');
  return digest;
}

/** Unwraps a content key with RSA-OAEP: a local key, or (B-1201) a call to the signer that holds it. */
export type OaepDecrypt = (ciphertext: Buffer, oaepHash: 'sha1' | 'sha256') => Promise<Buffer>;

/** An `OaepDecrypt` over a private key in this process. */
export const localOaep = (key: KeyObject): OaepDecrypt => async (ct, hash) => privateDecrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: hash }, ct);

/**
 * Decrypts a `<saml:EncryptedAssertion>` with our RSA private key and returns the plaintext XML of the assertion.
 * The EncryptedKey may sit in the EncryptedData's KeyInfo or next to the EncryptedData.
 */
export async function decryptAssertion(encrypted: XmlElement, decryptKey: OaepDecrypt): Promise<string> {
  const data = child(encrypted, NS.xenc, 'EncryptedData');
  if (!data) throw new XmlEncError('The EncryptedAssertion has no EncryptedData.');
  const dataAlg = attr(child(data, NS.xenc, 'EncryptionMethod'), 'Algorithm');
  const keyLen = dataAlg === ENC.aes256gcm ? 32 : dataAlg === ENC.aes128gcm ? 16 : 0;
  if (!keyLen) throw new XmlEncError(`Content encryption ${dataAlg ?? '(none)'} is refused; only AES-GCM is accepted.`);
  const encKeys = [...descendants(data, NS.xenc, 'EncryptedKey'), ...elements(encrypted, NS.xenc, 'EncryptedKey')];
  if (!encKeys.length) throw new XmlEncError('No EncryptedKey was found for the assertion.');
  let cek: Buffer | null = null;
  let lastError = 'The content key could not be decrypted with our key.';
  for (const ek of encKeys) {
    try {
      const hash = oaepHash(child(ek, NS.xenc, 'EncryptionMethod'));
      cek = await decryptKey(cipherValue(ek), hash);
      break;
    } catch (err) {
      if (err instanceof XmlEncError) lastError = err.message;
    }
  }
  if (!cek || cek.length !== keyLen) throw new XmlEncError(lastError);
  const raw = cipherValue(data);
  if (raw.length < 12 + 16 + 1) throw new XmlEncError('The encrypted assertion is too short.');
  const decipher = createDecipheriv(keyLen === 32 ? 'aes-256-gcm' : 'aes-128-gcm', cek, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  try {
    return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8');
  } catch {
    throw new XmlEncError('The encrypted assertion failed its integrity check.');
  }
}

export { XmlError };
