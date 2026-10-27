import { createCipheriv, createDecipheriv, createECDH, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { b64url, fromB64url, signJwt } from './jwt.js';

/*
 * 1.9.0 (B-151): Web Push with node:crypto only (no new dependency).
 *
 * - RFC 8291 message encryption with the RFC 8188 `aes128gcm` content coding: an ephemeral P-256 key pair per
 *   message, ECDH with the browser's `p256dh` key, HKDF-SHA-256 keyed by the browser's `auth` secret, one AES-128-GCM
 *   record (the payload, the 0x02 delimiter, no padding), and the header salt || rs || idlen || keyid (our ephemeral
 *   public key). `encryptPayload` takes the ephemeral key and salt as options only so the RFC 8291 Appendix A vector
 *   can be checked; production calls leave them out.
 * - RFC 8292 VAPID: the application server's P-256 key signs `{aud, exp, sub}`; the request carries
 *   `Authorization: vapid t=<jwt>, k=<public key>`.
 *
 * HKDF is written out with HMAC (RFC 5869) because each step's output is fixed at one block, which keeps the code
 * next to the RFC's own description of it.
 */

const hmac = (key: Buffer, data: Buffer): Buffer => createHmac('sha256', key).update(data).digest();

/** One HKDF-Expand step of at most 32 bytes (info || 0x01). */
const expand1 = (prk: Buffer, info: Buffer, len: number): Buffer => hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, len);

export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Parses a browser's `PushSubscription.toJSON()` (what a web device's token holds). Throws a plain message. */
export function parseSubscription(token: string): WebPushSubscription {
  let v: unknown;
  try {
    v = JSON.parse(token);
  } catch {
    throw new Error('The Web Push subscription is not JSON.');
  }
  const o = v as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof o?.endpoint !== 'string' || !/^https:\/\//.test(o.endpoint)) throw new Error('The Web Push subscription has no https endpoint.');
  const p256dh = typeof o.keys?.p256dh === 'string' ? o.keys.p256dh : '';
  const auth = typeof o.keys?.auth === 'string' ? o.keys.auth : '';
  if (fromB64url(p256dh).length !== 65 || fromB64url(auth).length !== 16) throw new Error('The Web Push subscription keys are not a P-256 public key and a 16-byte secret.');
  return { endpoint: o.endpoint, keys: { p256dh, auth } };
}

export interface EncryptOptions {
  /** RFC 8291 test vector only: the application server's ephemeral private key (32 bytes) and the salt. */
  asPrivate?: Buffer;
  salt?: Buffer;
  /** The record size written into the header (4096 by default). */
  rs?: number;
}

function keysFor(uaPublic: Buffer, authSecret: Buffer, asPublic: Buffer, ecdhSecret: Buffer, salt: Buffer): { cek: Buffer; nonce: Buffer } {
  // PRK_key = HMAC(auth_secret, ecdh_secret); IKM = HKDF-Expand(PRK_key, "WebPush: info" 0x00 ua_public as_public, 32)
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = expand1(prkKey, keyInfo, 32);
  // PRK = HKDF-Extract(salt, IKM); CEK and NONCE as RFC 8188 derives them.
  const prk = hmac(salt, ikm);
  return { cek: expand1(prk, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16), nonce: expand1(prk, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12) };
}

/** RFC 8291: the encrypted body for one push message (header and one aes128gcm record). */
export function encryptPayload(sub: Pick<WebPushSubscription, 'keys'>, plaintext: Buffer, o: EncryptOptions = {}): Buffer {
  const uaPublic = fromB64url(sub.keys.p256dh);
  const authSecret = fromB64url(sub.keys.auth);
  const ecdh = createECDH('prime256v1');
  if (o.asPrivate) ecdh.setPrivateKey(o.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const salt = o.salt ?? randomBytes(16);
  const rs = o.rs ?? 4096;
  if (plaintext.length + 1 + 16 > rs) throw new Error(`The push payload is larger than one ${rs}-byte record.`);
  const { cek, nonce } = keysFor(uaPublic, authSecret, asPublic, ecdhSecret, salt);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(rs, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/** RFC 8291 decryption as the user agent does it (tests, and the check that a key pair works). */
export function decryptPayload(uaPrivate: Buffer, authSecret: Buffer, message: Buffer): Buffer {
  const salt = message.subarray(0, 16);
  const idlen = message.readUInt8(20);
  const asPublic = message.subarray(21, 21 + idlen);
  const record = message.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const uaPublic = ecdh.getPublicKey();
  const { cek, nonce } = keysFor(uaPublic, authSecret, asPublic, ecdh.computeSecret(asPublic), salt);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  // Strip the padding back to the delimiter: 0x02 marks the last record.
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (end < 0 || padded[end] !== 2) throw new Error('No last-record delimiter.');
  return padded.subarray(0, end);
}

// ---------- VAPID (RFC 8292) ----------

export interface VapidKeys {
  /** The uncompressed P-256 public key, base64url (the browser's `applicationServerKey`). */
  publicKey: string;
  /** The private key as PKCS#8 PEM (stored in the vault, never shown). */
  privatePem: string;
}

/** A fresh VAPID key pair. */
export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const raw = Buffer.concat([Buffer.from([4]), fromB64url(jwk.x), fromB64url(jwk.y)]);
  return { publicKey: b64url(raw), privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

/** The VAPID private key from the vault (PKCS#8 PEM, or the raw 32-byte d as base64url as web-push tools print it). */
export function vapidPrivateKey(value: string, publicKey: string): KeyObject {
  const v = value.trim();
  const pub = fromB64url(publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('The VAPID public key is not an uncompressed P-256 point (65 bytes, base64url).');
  let key: KeyObject;
  try {
    if (v.includes('BEGIN')) key = createPrivateKey({ key: v.replace(/\\n/g, '\n'), format: 'pem' });
    else {
      const d = fromB64url(v);
      if (d.length !== 32) throw new Error('length');
      key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: b64url(d), x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33)) }, format: 'jwk' });
    }
  } catch {
    throw new Error('The VAPID private key is neither a PEM key nor a 32-byte base64url value.');
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('The VAPID key must be a P-256 key.');
  // The pair must match: the public half of the private key is the one browsers subscribed with.
  const jwk = key.export({ format: 'jwk' }) as { x: string; y: string };
  if (!Buffer.concat([Buffer.from([4]), fromB64url(jwk.x), fromB64url(jwk.y)]).equals(pub)) throw new Error('The VAPID private key does not belong to the public key.');
  return key;
}

/** `Authorization: vapid t=…, k=…` for one push service origin, valid for 12 hours. */
export function vapidAuthorization(o: { endpoint: string; subject: string; publicKey: string; key: KeyObject; now: number }): string {
  const aud = new URL(o.endpoint).origin;
  const jwt = signJwt({ typ: 'JWT', alg: 'ES256' }, { aud, exp: Math.floor(o.now / 1000) + 12 * 3600, sub: o.subject }, o.key);
  return `vapid t=${jwt}, k=${o.publicKey}`;
}
