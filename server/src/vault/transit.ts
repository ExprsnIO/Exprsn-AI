import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';

/*
 * Transit key material and the versioned wire format (B-1702). Ciphertexts and signatures look like
 * `exai:v<version>:<base64>`, naming the key version that made them, so a rotated key still opens old ciphertext
 * until its minimum decryption version passes it, and `rewrap` moves ciphertext to the latest version without the
 * plaintext ever leaving the server.
 *
 *   aes256-gcm96  encrypt, decrypt, rewrap: AES-256-GCM, 96-bit nonce, payload nonce || ciphertext || tag; the
 *                 associated data binds the tenant, the key's id, the version and the caller's optional context
 *   ed25519       sign, verify: Ed25519 over the input
 *   ecdsa-p256    sign, verify: ECDSA P-256 over SHA-256 of the input, DER-encoded signature
 *
 * Material is generated here, sealed with the tenant data key by the service, and never exported.
 */

export const TRANSIT_KEY_TYPES = ['aes256-gcm96', 'ed25519', 'ecdsa-p256'] as const;
export type TransitKeyType = (typeof TRANSIT_KEY_TYPES)[number];

export const isSigningType = (t: TransitKeyType): boolean => t === 'ed25519' || t === 'ecdsa-p256';

export const CIPHERTEXT_PREFIX = 'exai';

/** New key material: a raw AES key, or a PKCS#8 DER private key with its SPKI PEM public key. */
export function generateMaterial(type: TransitKeyType): { material: Buffer; publicKey: string | null } {
  if (type === 'aes256-gcm96') return { material: randomBytes(32), publicKey: null };
  const pair = type === 'ed25519' ? generateKeyPairSync('ed25519') : generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { material: pair.privateKey.export({ type: 'pkcs8', format: 'der' }), publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

export const formatVersioned = (version: number, payload: Buffer): string => `${CIPHERTEXT_PREFIX}:v${version}:${payload.toString('base64')}`;

/** Parses `exai:v<n>:<base64>`; null when the text is not in that form. */
export function parseVersioned(text: string): { version: number; payload: Buffer } | null {
  const m = /^exai:v([1-9][0-9]{0,8}):([A-Za-z0-9+/]+={0,2})$/.exec(text);
  if (!m) return null;
  return { version: Number(m[1]), payload: Buffer.from(m[2]!, 'base64') };
}

export function transitAad(tenantId: string, keyId: string, version: number, context: Buffer | null): Buffer {
  return Buffer.concat([Buffer.from(`exai-transit|${tenantId}|${keyId}|${version}|`), context ?? Buffer.alloc(0)]);
}

export function encryptWith(key: Buffer, aad: Buffer, plaintext: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]);
}

/** Throws when the payload was not made with this key, version and context (or was altered). */
export function decryptWith(key: Buffer, aad: Buffer, payload: Buffer): Buffer {
  if (payload.length < 12 + 16) throw new Error('Ciphertext is too short');
  const d = createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12));
  d.setAAD(aad);
  d.setAuthTag(payload.subarray(payload.length - 16));
  return Buffer.concat([d.update(payload.subarray(12, payload.length - 16)), d.final()]);
}

export function signWith(type: TransitKeyType, pkcs8: Buffer, data: Buffer): Buffer {
  const key = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  return type === 'ed25519' ? sign(null, data, key) : sign('sha256', data, key);
}

export function verifyWith(type: TransitKeyType, publicKeyPem: string, data: Buffer, signature: Buffer): boolean {
  const key = createPublicKey(publicKeyPem);
  try {
    return type === 'ed25519' ? verify(null, data, key, signature) : verify('sha256', data, key, signature);
  } catch {
    return false;
  }
}
