/*
 * 1.9.99-final, Sprint 58 (B-10208): ECDSA P-256 over a precomputed digest, for the KMS fakes. AWS KMS `Sign` with
 * `MessageType: DIGEST` and Key Vault `sign` take the digest itself, which node:crypto cannot sign without hashing it
 * again; this does the textbook arithmetic with BigInt (slow, test-only, never for real keys). The code under test
 * verifies the result with node:crypto, so the two are checked against each other.
 */
import { randomBytes, type KeyObject } from 'node:crypto';

const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const A = P - 3n;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const G: [bigint, bigint] = [0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n, 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n];

const mod = (a: bigint, m: bigint) => ((a % m) + m) % m;
function pow(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n;
  b = mod(b, m);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}
const inv = (a: bigint, m: bigint) => pow(a, m - 2n, m);

type Pt = [bigint, bigint] | null;
function add(p: Pt, q: Pt): Pt {
  if (!p) return q;
  if (!q) return p;
  if (p[0] === q[0] && mod(p[1] + q[1], P) === 0n) return null;
  const l = p[0] === q[0] && p[1] === q[1] ? mod((3n * p[0] * p[0] + A) * inv(2n * p[1], P), P) : mod((q[1] - p[1]) * inv(q[0] - p[0], P), P);
  const x = mod(l * l - p[0] - q[0], P);
  return [x, mod(l * (p[0] - x) - p[1], P)];
}
function mul(k: bigint, p: Pt): Pt {
  let r: Pt = null;
  let q = p;
  while (k > 0n) {
    if (k & 1n) r = add(r, q);
    q = add(q, q);
    k >>= 1n;
  }
  return r;
}

const big = (b: Buffer) => BigInt(`0x${b.toString('hex') || '0'}`);
const bytes32 = (n: bigint) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');

/** r||s of an ECDSA P-256 signature over `digest` (32 bytes) with the private key. */
export function signDigestP256(privateKey: KeyObject, digest: Buffer): Buffer {
  const d = big(Buffer.from(privateKey.export({ format: 'jwk' }).d as string, 'base64url'));
  const z = big(digest.subarray(0, 32));
  for (;;) {
    const k = mod(big(randomBytes(32)), N);
    if (k === 0n) continue;
    const pt = mul(k, G);
    const r = mod(pt![0], N);
    if (r === 0n) continue;
    const s = mod(inv(k, N) * (z + r * d), N);
    if (s === 0n) continue;
    return Buffer.concat([bytes32(r), bytes32(s)]);
  }
}

/** A raw r||s signature as ASN.1 DER (what AWS KMS returns). */
export function rawToDer(raw: Buffer): Buffer {
  const int = (b: Buffer) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.subarray(i);
    if (v[0]! & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
    return Buffer.concat([Buffer.from([0x02, v.length]), v]);
  };
  const body = Buffer.concat([int(raw.subarray(0, 32)), int(raw.subarray(32))]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}
