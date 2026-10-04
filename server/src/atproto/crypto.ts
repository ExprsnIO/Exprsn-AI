import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { base58Decode, base58Encode } from './encoding.js';

/*
 * AT-Protocol keys and signatures (B-1608): the two curves it allows, secp256k1 ("k256", ES256K) and NIST P-256
 * (ES256). Public keys travel compressed (33 bytes) behind a multicodec prefix in base58btc: `did:key:z…` and the
 * DID document's `publicKeyMultibase`. Signatures are ECDSA over SHA-256 of the message, in the compact 64-byte r||s
 * form, and must be "low-S" (s ≤ n/2): AT-Protocol refuses the malleable high-S twin of a valid signature, so
 * `normaliseLowS` folds every signature this server makes and `verifySignature` refuses high-S ones.
 */

export type Curve = 'secp256k1' | 'p256';
export const CURVES: readonly Curve[] = ['secp256k1', 'p256'];

interface CurveParams {
  p: bigint;
  n: bigint;
  a: bigint;
  b: bigint;
  jwk: string;
  /** The multicodec code as its varint bytes: secp256k1-pub 0xe7, p256-pub 0x1200. */
  prefix: Buffer;
  jwtAlg: 'ES256K' | 'ES256';
}

const P256_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const K256_P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;

export const CURVE: Record<Curve, CurveParams> = {
  secp256k1: { p: K256_P, n: 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n, a: 0n, b: 7n, jwk: 'secp256k1', prefix: Buffer.from([0xe7, 0x01]), jwtAlg: 'ES256K' },
  p256: { p: P256_P, n: 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n, a: P256_P - 3n, b: 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn, jwk: 'P-256', prefix: Buffer.from([0x80, 0x24]), jwtAlg: 'ES256' }
};

const big = (b: Uint8Array): bigint => BigInt('0x' + (Buffer.from(b).toString('hex') || '0'));
const bytes32 = (n: bigint): Buffer => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let r = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return r;
}

/** The compressed SEC1 form (0x02/0x03 || x) of an EC public key on either curve. */
export function compressPublicKey(key: KeyObject): { curve: Curve; compressed: Buffer } {
  const jwk = key.export({ format: 'jwk' });
  const curve = jwk.crv === 'secp256k1' ? 'secp256k1' : jwk.crv === 'P-256' ? 'p256' : null;
  if (!curve || !jwk.x || !jwk.y) throw new Error('Not a secp256k1 or P-256 public key');
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  return { curve, compressed: Buffer.concat([Buffer.from([y[y.length - 1]! & 1 ? 0x03 : 0x02]), x]) };
}

/** A KeyObject from a compressed point; refuses a point that is not on the curve. */
export function decompressPublicKey(curve: Curve, compressed: Uint8Array): KeyObject {
  if (compressed.length !== 33 || (compressed[0] !== 0x02 && compressed[0] !== 0x03)) throw new Error('A compressed public key is 33 bytes starting 02 or 03');
  const c = CURVE[curve];
  const x = big(compressed.subarray(1));
  if (x >= c.p) throw new Error('Public key x is out of range');
  const rhs = (modPow(x, 3n, c.p) + ((c.a * x) % c.p) + c.b) % c.p;
  // Both primes are 3 mod 4, so the square root is rhs^((p+1)/4).
  let y = modPow(rhs, (c.p + 1n) / 4n, c.p);
  if ((y * y) % c.p !== rhs) throw new Error('The public key is not on the curve');
  if ((y & 1n) !== BigInt(compressed[0]! & 1)) y = c.p - y;
  return createPublicKey({ key: { kty: 'EC', crv: c.jwk, x: bytes32(x).toString('base64url'), y: bytes32(y).toString('base64url') }, format: 'jwk' });
}

/** `z` + base58btc(multicodec || compressed key): the Multikey `publicKeyMultibase` value. */
export function multikey(curve: Curve, compressed: Uint8Array): string {
  return 'z' + base58Encode(Buffer.concat([CURVE[curve].prefix, Buffer.from(compressed)]));
}

export const formatDidKey = (curve: Curve, compressed: Uint8Array): string => `did:key:${multikey(curve, compressed)}`;

/** Reads a Multikey value (`z…`): its curve, compressed bytes and the KeyObject. */
export function parseMultikey(value: string): { curve: Curve; compressed: Buffer; key: KeyObject } {
  if (!value.startsWith('z') || value.length > 100) throw new Error('A multikey is base58btc (z…)');
  const raw = base58Decode(value.slice(1));
  for (const curve of CURVES) {
    const prefix = CURVE[curve].prefix;
    if (raw.subarray(0, prefix.length).equals(prefix)) {
      const compressed = raw.subarray(prefix.length);
      return { curve, compressed, key: decompressPublicKey(curve, compressed) };
    }
  }
  throw new Error('The multikey is neither a secp256k1 nor a P-256 key');
}

export function parseDidKey(did: string): { curve: Curve; compressed: Buffer; key: KeyObject } {
  if (!did.startsWith('did:key:')) throw new Error('Not a did:key');
  return parseMultikey(did.slice('did:key:'.length));
}

/** Folds a compact r||s signature to its low-S form (s → n − s when s > n/2). */
export function normaliseLowS(curve: Curve, sig: Uint8Array): Buffer {
  if (sig.length !== 64) throw new Error('A compact signature is 64 bytes');
  const n = CURVE[curve].n;
  const s = big(sig.subarray(32));
  if (s <= n / 2n) return Buffer.from(sig);
  return Buffer.concat([Buffer.from(sig.subarray(0, 32)), bytes32(n - s)]);
}

export function isLowS(curve: Curve, sig: Uint8Array): boolean {
  return sig.length === 64 && big(sig.subarray(32)) <= CURVE[curve].n / 2n;
}

/** Verifies a compact, low-S ECDSA-SHA256 signature; a high-S or DER signature is refused, as AT-Protocol requires. */
export function verifySignature(curve: Curve, key: KeyObject, data: Uint8Array, sig: Uint8Array): boolean {
  if (sig.length !== 64 || !isLowS(curve, sig)) return false;
  try {
    return cryptoVerify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
  } catch {
    return false;
  }
}
