import { randomBytes } from 'node:crypto';

/*
 * B-1404: Shamir secret sharing over GF(2^8).
 *
 * The field is GF(2^8) with the AES reduction polynomial x^8 + x^4 + x^3 + x + 1 (0x11b); multiplication uses log and
 * exponent tables over the generator 3. Each byte of the secret is the constant term of its own random polynomial of
 * degree k - 1; share i holds the polynomials evaluated at x = i (1 to 255). Any k shares rebuild every byte by
 * Lagrange interpolation at x = 0; fewer reveal nothing about it (each byte is uniformly distributed given k - 1
 * shares). Coefficients come from the system CSPRNG.
 */

const EXP = new Uint8Array(510);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    // x * 3 = x * 2 xor x, with the reduction when x * 2 overflows a byte.
    x ^= (x << 1) ^ (x & 0x80 ? 0x11b : 0);
    x &= 0xff;
  }
  for (let i = 255; i < 510; i++) EXP[i] = EXP[i - 255]!;
}

export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

export function gfDiv(a: number, b: number): number {
  if (b === 0) throw new RangeError('division by zero in GF(256)');
  if (a === 0) return 0;
  return EXP[LOG[a]! + 255 - LOG[b]!]!;
}

export interface Share {
  /** The x coordinate, 1 to 255. */
  x: number;
  /** One y value per secret byte. */
  y: Buffer;
}

/**
 * Splits `secret` into `n` shares of which any `k` rebuild it. `random(len)` supplies the coefficients (tests pass a
 * fixed source for known-answer vectors).
 */
export function split(secret: Buffer, n: number, k: number, random: (len: number) => Buffer = randomBytes): Share[] {
  if (!Number.isInteger(n) || !Number.isInteger(k) || k < 2 || n < k || n > 255) throw new RangeError('Shamir needs 2 <= k <= n <= 255');
  if (!secret.length) throw new RangeError('Nothing to split');
  const shares: Share[] = Array.from({ length: n }, (_, i) => ({ x: i + 1, y: Buffer.alloc(secret.length) }));
  for (let b = 0; b < secret.length; b++) {
    // coefficients[0] is the secret byte; the others are random.
    const coeff = [secret[b]!, ...random(k - 1)];
    for (const sh of shares) {
      // Horner's rule from the highest coefficient down.
      let y = 0;
      for (let c = k - 1; c >= 0; c--) y = gfMul(y, sh.x) ^ coeff[c]!;
      sh.y[b] = y;
    }
  }
  return shares;
}

/**
 * Rebuilds the secret from shares by interpolating at x = 0. With fewer shares than the threshold the result is a
 * different, unrelated value: the caller checks it against a key check value.
 */
export function combine(shares: Share[]): Buffer {
  if (shares.length < 2) throw new RangeError('At least two shares are needed');
  const len = shares[0]!.y.length;
  const xs = new Set<number>();
  for (const s of shares) {
    if (s.y.length !== len) throw new RangeError('The shares are of different lengths');
    if (s.x < 1 || s.x > 255 || xs.has(s.x)) throw new RangeError('Share numbers must be distinct, from 1 to 255');
    xs.add(s.x);
  }
  const out = Buffer.alloc(len);
  for (let b = 0; b < len; b++) {
    let acc = 0;
    for (let i = 0; i < shares.length; i++) {
      // Lagrange basis at 0: prod_{j != i} x_j / (x_j - x_i); subtraction is xor in GF(2^8).
      let num = 1;
      let den = 1;
      for (let j = 0; j < shares.length; j++) {
        if (i === j) continue;
        num = gfMul(num, shares[j]!.x);
        den = gfMul(den, shares[j]!.x ^ shares[i]!.x);
      }
      acc ^= gfMul(shares[i]!.y[b]!, gfDiv(num, den));
    }
    out[b] = acc;
  }
  return out;
}
