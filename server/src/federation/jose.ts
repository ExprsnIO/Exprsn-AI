import { createHash, createPublicKey, sign as cryptoSign, verify as cryptoVerify, type JsonWebKey, type KeyObject } from 'node:crypto';

/** Compact JWS (RFC 7515) for ES256 signing and ES256 / RS256 verification, with node:crypto only. */

export const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');
export const fromB64u = (s: string): Buffer => Buffer.from(s, 'base64url');

export type JwtAlg = 'ES256' | 'RS256';

export interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

export type Claims = Record<string, unknown>;

/** Signs claims as a JWT with an EC P-256 private key (ES256, raw r||s signature). */
export function signJwt(claims: Claims, key: KeyObject, kid: string, typ = 'JWT'): string {
  const header = b64u(JSON.stringify({ alg: 'ES256', kid, typ }));
  const payload = b64u(JSON.stringify(claims));
  const sig = cryptoSign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${b64u(sig)}`;
}

export function decodeJwt(token: string): { header: JwtHeader; claims: Claims; signingInput: string; signature: Buffer } {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) throw new Error('Malformed JWT');
  const header = JSON.parse(fromB64u(parts[0]!).toString('utf8')) as JwtHeader;
  const claims = JSON.parse(fromB64u(parts[1]!).toString('utf8')) as Claims;
  if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object') throw new Error('Malformed JWT');
  return { header, claims, signingInput: `${parts[0]}.${parts[1]}`, signature: fromB64u(parts[2]!) };
}

/** Verifies a JWS signature with the given key. Only ES256 and RS256 are accepted; `none` and HMAC never are. */
export function verifySignature(alg: string, signingInput: string, signature: Buffer, key: KeyObject): boolean {
  if (alg === 'ES256') {
    if (key.asymmetricKeyType !== 'ec') return false;
    return cryptoVerify('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' }, signature);
  }
  if (alg === 'RS256') {
    if (key.asymmetricKeyType !== 'rsa') return false;
    return cryptoVerify('sha256', Buffer.from(signingInput), key, signature);
  }
  return false;
}

export interface Jwk extends JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
}

export const keyFromJwk = (jwk: Jwk): KeyObject => {
  // Only the public members are passed on, so a JWKS that leaks a private member cannot be used to sign.
  const pub: JsonWebKey = jwk.kty === 'EC' ? { kty: 'EC', crv: jwk.crv, x: jwk.x, y: jwk.y } : { kty: 'RSA', n: jwk.n, e: jwk.e };
  return createPublicKey({ key: pub, format: 'jwk' });
};

export class JwtError extends Error {}

/**
 * Verifies a JWT against a key set: signature (alg from an allow-list, key picked by kid), then issuer, audience,
 * expiry and not-before with a small clock skew. Returns the claims.
 */
export function verifyJwt(token: string, keys: Jwk[], opts: { issuer: string; audience?: string; algs: JwtAlg[]; skewS?: number; now?: number; typ?: string }): Claims {
  let decoded;
  try {
    decoded = decodeJwt(token);
  } catch {
    throw new JwtError('The token is not a JWT.');
  }
  const { header, claims } = decoded;
  if (!opts.algs.includes(header.alg as JwtAlg)) throw new JwtError(`Algorithm ${String(header.alg)} is not accepted.`);
  if (opts.typ && header.typ !== opts.typ) throw new JwtError('Unexpected token type.');
  const candidates = keys.filter((k) => (header.kid ? k.kid === header.kid : true) && (header.alg === 'ES256' ? k.kty === 'EC' : k.kty === 'RSA') && (!k.use || k.use === 'sig'));
  if (!candidates.length) throw new JwtError('No key in the key set matches the token.');
  if (!candidates.some((k) => verifySignature(header.alg, decoded.signingInput, decoded.signature, keyFromJwk(k)))) throw new JwtError('The token signature does not verify.');
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const skew = opts.skewS ?? 60;
  if (claims.iss !== opts.issuer) throw new JwtError('The token issuer does not match.');
  if (opts.audience !== undefined) {
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(opts.audience)) throw new JwtError('The token audience does not match.');
    if (aud.length > 1 && claims.azp !== undefined && claims.azp !== opts.audience) throw new JwtError('The token azp does not match.');
  }
  if (typeof claims.exp !== 'number' || claims.exp + skew < now) throw new JwtError('The token has expired.');
  if (typeof claims.nbf === 'number' && claims.nbf - skew > now) throw new JwtError('The token is not valid yet.');
  if (typeof claims.iat === 'number' && claims.iat - skew > now) throw new JwtError('The token was issued in the future.');
  return claims;
}

/** RFC 7636 S256: BASE64URL(SHA256(verifier)). */
export const pkceChallenge = (verifier: string): string => b64u(createHash('sha256').update(verifier, 'ascii').digest());

/** OIDC at_hash / c_hash: left half of SHA-256 of the ASCII value. */
export const halfHash = (value: string): string => b64u(createHash('sha256').update(value, 'ascii').digest().subarray(0, 16));

/** RFC 7638 thumbprint of an EC or RSA public JWK, used as the key id. */
export function thumbprint(jwk: Jwk): string {
  const members = jwk.kty === 'EC' ? { crv: jwk.crv, kty: 'EC', x: jwk.x, y: jwk.y } : { e: jwk.e, kty: 'RSA', n: jwk.n };
  return b64u(createHash('sha256').update(JSON.stringify(members)).digest());
}
