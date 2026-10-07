import { verifySignature, type Curve } from './crypto.js';
import { repoKeyFromDocument } from './commit.js';
import type { DidResolver } from './did.js';

/*
 * Inter-service JWTs (B-3001; https://atproto.com/specs/xrpc#inter-service-authentication-jwt). An AppView asking a
 * feed generator for a skeleton on a user's behalf sends `Authorization: Bearer <jwt>`, signed by the user's (or the
 * calling service's) `#atproto` key:
 *
 *   header  { typ: 'JWT', alg: 'ES256K' | 'ES256' }
 *   payload { iss: <DID>[#<service>], aud: <this service's DID>[#bsky_fg], exp, iat?, lxm?: <NSID>, jti? }
 *
 * Verification here: the algorithm is one of the two AT-Protocol curves and matches the key's curve (no `none`, no
 * HMAC); `aud` is one of ours; `exp` is in the future and at most an hour away; `iat`, when given, is not in the future;
 * `lxm`, when given, is the method called; and the compact low-S signature over `<header>.<payload>` verifies against
 * the issuer's `#atproto` key, resolved through the DID resolver (service URL checks, caching). When the signature
 * fails the document is fetched once more, at most once a minute per DID, in case the key rotated.
 */

export type ServiceJwtError = 'BadJwt' | 'BadJwtSignature' | 'JwtExpired' | 'BadJwtAudience' | 'BadJwtLexiconMethod';

export class ServiceJwtRefused extends Error {
  constructor(
    readonly error: ServiceJwtError,
    message: string
  ) {
    super(message);
  }
}

const ALGS: Record<string, Curve> = { ES256K: 'secp256k1', ES256: 'p256' };
const MAX_LIFETIME_S = 3600;
const SKEW_S = 30;
const DID_RE = /^did:(plc:[a-z2-7]{24}|web:[A-Za-z0-9.%:-]{3,250})$/;

function part(s: string, what: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new ServiceJwtRefused('BadJwt', `The token's ${what} is not base64url.`);
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  } catch {
    throw new ServiceJwtRefused('BadJwt', `The token's ${what} is not JSON.`);
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ServiceJwtRefused('BadJwt', `The token's ${what} is not an object.`);
  return v as Record<string, unknown>;
}

export class ServiceJwtVerifier {
  private readonly refreshed = new Map<string, number>();

  constructor(private readonly resolver: Pick<DidResolver, 'resolve'>) {}

  /** Verifies a token for `lxm` addressed to one of `audiences`; returns the issuer's DID (without a fragment). */
  async verify(token: string, o: { audiences: readonly string[]; lxm: string; now?: number }): Promise<{ iss: string }> {
    if (token.length > 8192) throw new ServiceJwtRefused('BadJwt', 'The token is too long.');
    const parts = token.split('.');
    if (parts.length !== 3) throw new ServiceJwtRefused('BadJwt', 'The token is not a JWT.');
    const header = part(parts[0]!, 'header');
    const payload = part(parts[1]!, 'payload');
    const curve = typeof header.alg === 'string' ? ALGS[header.alg] : undefined;
    if (!curve) throw new ServiceJwtRefused('BadJwt', 'The token is signed with an algorithm AT-Protocol does not use (ES256K or ES256).');
    if (header.typ !== undefined && header.typ !== 'JWT' && header.typ !== 'at+jwt') throw new ServiceJwtRefused('BadJwt', 'The token is not a JWT.');
    const now = Math.floor((o.now ?? Date.now()) / 1000);
    const { iss, aud, exp, iat, lxm } = payload;
    if (typeof iss !== 'string' || !DID_RE.test(iss.split('#')[0]!)) throw new ServiceJwtRefused('BadJwt', 'The token has no issuer DID.');
    if (typeof aud !== 'string' || !o.audiences.includes(aud)) throw new ServiceJwtRefused('BadJwtAudience', 'The token is meant for another service.');
    if (typeof exp !== 'number' || !Number.isFinite(exp)) throw new ServiceJwtRefused('BadJwt', 'The token has no expiry.');
    if (exp <= now) throw new ServiceJwtRefused('JwtExpired', 'The token has expired.');
    if (exp > now + MAX_LIFETIME_S + SKEW_S) throw new ServiceJwtRefused('BadJwt', 'The token lives longer than an hour.');
    if (iat !== undefined && (typeof iat !== 'number' || iat > now + SKEW_S)) throw new ServiceJwtRefused('BadJwt', 'The token was issued in the future.');
    if (lxm !== undefined && lxm !== o.lxm) throw new ServiceJwtRefused('BadJwtLexiconMethod', `The token is for ${String(lxm).slice(0, 100)}, not ${o.lxm}.`);
    const sig = Buffer.from(parts[2]!, 'base64url');
    if (!/^[A-Za-z0-9_-]+$/.test(parts[2]!) || sig.length !== 64) throw new ServiceJwtRefused('BadJwtSignature', 'The signature is not a compact 64-byte ECDSA signature.');
    const did = iss.split('#')[0]!;
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii');
    const check = async (fresh: boolean): Promise<boolean> => {
      let doc: unknown;
      try {
        doc = await this.resolver.resolve(did, fresh);
      } catch (err) {
        throw new ServiceJwtRefused('BadJwtSignature', `The issuer ${did} could not be resolved: ${(err as Error).message}`.slice(0, 300));
      }
      let k: ReturnType<typeof repoKeyFromDocument>;
      try {
        k = repoKeyFromDocument(doc, did);
      } catch (err) {
        throw new ServiceJwtRefused('BadJwtSignature', `${did}: ${(err as Error).message}`.slice(0, 300));
      }
      return k.curve === curve && verifySignature(k.curve, k.key, signed, sig);
    };
    if (await check(false)) return { iss: did };
    if (Date.now() - (this.refreshed.get(did) ?? 0) > 60_000) {
      this.refreshed.set(did, Date.now());
      if (this.refreshed.size > 10_000) this.refreshed.delete(this.refreshed.keys().next().value!);
      if (await check(true)) return { iss: did };
    }
    throw new ServiceJwtRefused('BadJwtSignature', "The token's signature does not verify against the issuer's key.");
  }
}
