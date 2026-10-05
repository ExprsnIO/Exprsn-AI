import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { parseMultikey, verifySignature, type Curve } from '../crypto.js';

/*
 * PDS credentials (B-2901). An XRPC session is a pair of JWTs, as `com.atproto.server.createSession` returns them:
 * an access token (`typ: at+jwt`, short-lived) and a refresh token (`typ: refresh+jwt`, carrying a `jti` the
 * database tracks, spent once by `refreshSession` and revoked by `deleteSession`, deactivation and takedowns). Both
 * are HS256 under a key derived from SESSION_SECRET, so every instance accepts them; the account's state is read on
 * every request, so a takedown applies at once to tokens already issued.
 *
 * Inter-service tokens (`getServiceAuth`, and the migration's `createAccount` with an existing DID) are ES256K or
 * ES256 JWTs signed with the account's repo signing key (in the signer or OpenBao) and checked against the issuer
 * DID's `#atproto` key: https://atproto.com/specs/xrpc#inter-service-authentication-jwt.
 */

export type AccessScope = 'com.atproto.access' | 'com.atproto.appPass' | 'com.atproto.appPassPrivileged';
export const REFRESH_SCOPE = 'com.atproto.refresh';

export class TokenError extends Error {
  constructor(
    readonly code: 'InvalidToken' | 'ExpiredToken',
    message: string
  ) {
    super(message);
  }
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export interface SessionClaims {
  scope: AccessScope | typeof REFRESH_SCOPE;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  jti?: string;
}

export class PdsTokens {
  private readonly key: Buffer;

  constructor(sessionSecret: string) {
    this.key = createHmac('sha256', sessionSecret).update('exprsn-ai pds session tokens v1').digest();
  }

  private sign(typ: string, claims: SessionClaims): string {
    const input = `${b64u(JSON.stringify({ typ, alg: 'HS256' }))}.${b64u(JSON.stringify(claims))}`;
    return `${input}.${b64u(createHmac('sha256', this.key).update(input).digest())}`;
  }

  /** `jti` names the session (the refresh token's), so revoking the session stops its access tokens at once. */
  access(o: { did: string; aud: string; scope: AccessScope; ttlS: number; jti: string; now?: number }): string {
    const iat = Math.floor((o.now ?? Date.now()) / 1000);
    return this.sign('at+jwt', { scope: o.scope, sub: o.did, aud: o.aud, iat, exp: iat + o.ttlS, jti: o.jti });
  }

  refresh(o: { did: string; aud: string; jti: string; ttlS: number; now?: number }): string {
    const iat = Math.floor((o.now ?? Date.now()) / 1000);
    return this.sign('refresh+jwt', { scope: REFRESH_SCOPE, sub: o.did, aud: o.aud, iat, exp: iat + o.ttlS, jti: o.jti });
  }

  /** Checks a token's signature, type, audience and expiry; returns its claims. */
  verify(token: string, o: { typ: 'at+jwt' | 'refresh+jwt'; aud: string; now?: number }): SessionClaims {
    const parts = token.split('.');
    if (parts.length !== 3 || token.length > 4096) throw new TokenError('InvalidToken', 'Malformed token.');
    const [h, c, s] = parts as [string, string, string];
    const expected = createHmac('sha256', this.key).update(`${h}.${c}`).digest();
    const got = Buffer.from(s, 'base64url');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new TokenError('InvalidToken', 'Token could not be verified.');
    let header: { typ?: unknown; alg?: unknown };
    let claims: SessionClaims;
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { typ?: unknown; alg?: unknown };
      claims = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as SessionClaims;
    } catch {
      throw new TokenError('InvalidToken', 'Malformed token.');
    }
    if (header.alg !== 'HS256' || header.typ !== o.typ) throw new TokenError('InvalidToken', 'Wrong token type.');
    if (claims.aud !== o.aud || typeof claims.sub !== 'string') throw new TokenError('InvalidToken', 'Token is not for this server.');
    if (o.typ === 'refresh+jwt' ? claims.scope !== REFRESH_SCOPE || typeof claims.jti !== 'string' : claims.scope === REFRESH_SCOPE) throw new TokenError('InvalidToken', 'Wrong token scope.');
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= (o.now ?? Date.now())) throw new TokenError('ExpiredToken', 'Token has expired.');
    return claims;
  }
}

export const newJti = (): string => randomBytes(24).toString('base64url');

// ---------- inter-service JWTs ----------

export interface ServiceClaims {
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  lxm?: string;
  jti: string;
}

/** An inter-service JWT, signed with `sign` (the account's key: compact r||s, low-S). */
export async function signServiceJwt(curve: Curve, claims: ServiceClaims, sign: (bytes: Buffer) => Promise<Buffer>): Promise<string> {
  const input = `${b64u(JSON.stringify({ typ: 'JWT', alg: curve === 'secp256k1' ? 'ES256K' : 'ES256' }))}.${b64u(JSON.stringify(claims))}`;
  const sig = await sign(Buffer.from(input, 'ascii'));
  return `${input}.${b64u(sig)}`;
}

/** Reads an inter-service JWT without trusting it (to learn which DID to resolve). */
export function peekServiceJwt(token: string): { header: { alg?: unknown }; claims: Partial<ServiceClaims>; input: string; sig: Buffer } {
  const parts = token.split('.');
  if (parts.length !== 3 || token.length > 8192) throw new TokenError('InvalidToken', 'Malformed service token.');
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as { alg?: unknown },
      claims: JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Partial<ServiceClaims>,
      input: `${parts[0]}.${parts[1]}`,
      sig: Buffer.from(parts[2]!, 'base64url')
    };
  } catch {
    throw new TokenError('InvalidToken', 'Malformed service token.');
  }
}

/** Verifies an inter-service JWT against the issuer's `#atproto` multikey, the audience and, when given, the method. */
export function verifyServiceJwt(token: string, o: { multikey: string; aud: string; lxm?: string; now?: number }): ServiceClaims {
  const t = peekServiceJwt(token);
  const { curve, key } = parseMultikey(o.multikey);
  const alg = curve === 'secp256k1' ? 'ES256K' : 'ES256';
  if (t.header.alg !== alg) throw new TokenError('InvalidToken', `The service token is not ${alg}.`);
  if (!verifySignature(curve, key, Buffer.from(t.input, 'ascii'), t.sig)) throw new TokenError('InvalidToken', 'The service token’s signature does not verify.');
  const c = t.claims;
  if (typeof c.iss !== 'string' || c.aud !== o.aud) throw new TokenError('InvalidToken', 'The service token is not for this server.');
  if (o.lxm !== undefined && c.lxm !== o.lxm) throw new TokenError('InvalidToken', `The service token is for ${String(c.lxm ?? 'any method')}, not ${o.lxm}.`);
  const now = Math.floor((o.now ?? Date.now()) / 1000);
  if (typeof c.exp !== 'number' || c.exp <= now) throw new TokenError('ExpiredToken', 'The service token has expired.');
  if (typeof c.iat === 'number' && c.iat > now + 300) throw new TokenError('InvalidToken', 'The service token was issued in the future.');
  return c as ServiceClaims;
}
