import { createPrivateKey, sign, type KeyObject } from 'node:crypto';

/*
 * 1.9.0 (B-151): the signed tokens push providers ask for, made with node:crypto only.
 *
 * - APNs provider tokens: ES256 over `{alg, kid}.{iss: team id, iat}`, with the `.p8` key from the vault. Apple refuses
 *   a token older than an hour and throttles one renewed more often than every 20 minutes, so `ApnsTokens` keeps one
 *   per key and mints a new one once the cached one is 50 minutes old.
 * - FCM: the service account's RS256 assertion for the OAuth 2.0 JWT bearer grant (RFC 7523), traded for an access
 *   token that `OAuthTokens` caches until a minute before it expires.
 * - VAPID (RFC 8292): ES256 over `{aud: the push service's origin, exp, sub}`.
 *
 * Keys and tokens live in memory only and never reach a log, an audit entry or a response.
 */

export const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url');
export const fromB64url = (s: string): Buffer => Buffer.from(s.replace(/=+$/, ''), 'base64url');

export type Clock = () => number;

/** A compact JWS: ES256 signatures in their raw r || s form (RFC 7518 3.4), RS256 as PKCS#1 v1.5. */
export function signJwt(header: Record<string, unknown>, claims: Record<string, unknown>, key: KeyObject): string {
  const alg = header.alg;
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  let sig: Buffer;
  if (alg === 'ES256') sig = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  else if (alg === 'RS256') sig = sign('sha256', Buffer.from(input), key);
  else throw new Error(`Unsupported JWT algorithm ${String(alg)}.`);
  return `${input}.${b64url(sig)}`;
}

/** A PEM private key (PKCS#8, as Apple's .p8 and Google's service account hold it). Throws a plain message. */
export function privateKeyFrom(pem: string, want: 'ec' | 'rsa'): KeyObject {
  let k: KeyObject;
  try {
    k = createPrivateKey({ key: pem.replace(/\\n/g, '\n'), format: 'pem' });
  } catch {
    throw new Error(want === 'ec' ? 'The key is not a PEM private key (an APNs .p8 key starts with -----BEGIN PRIVATE KEY-----).' : 'The service account private_key is not a PEM private key.');
  }
  if (k.asymmetricKeyType !== want) throw new Error(want === 'ec' ? 'The APNs key must be an EC P-256 key (.p8).' : 'The service account key must be an RSA key.');
  if (want === 'ec' && k.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('The APNs key must be on the P-256 curve.');
  return k;
}

/** Renew an APNs token once the cached one is this old (Apple: valid up to 60 minutes, renew at most every 20). */
export const APNS_TOKEN_RENEW_MS = 50 * 60_000;

/** APNs provider tokens, one per team and key, renewed every 50 minutes. */
export class ApnsTokens {
  private readonly cache = new Map<string, { token: string; at: number }>();
  /** How many tokens were minted (tests check renewal). */
  minted = 0;

  constructor(private readonly clock: Clock = Date.now) {}

  token(o: { teamId: string; keyId: string; key: KeyObject }): string {
    const id = `${o.teamId}:${o.keyId}`;
    const now = this.clock();
    const hit = this.cache.get(id);
    if (hit && now - hit.at < APNS_TOKEN_RENEW_MS && now >= hit.at) return hit.token;
    const token = signJwt({ alg: 'ES256', kid: o.keyId }, { iss: o.teamId, iat: Math.floor(now / 1000) }, o.key);
    this.cache.set(id, { token, at: now });
    this.minted++;
    return token;
  }

  /** Forgets a key's token (APNs answered ExpiredProviderToken or the provider changed). */
  drop(teamId: string, keyId: string): void {
    this.cache.delete(`${teamId}:${keyId}`);
  }
}

export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** The RFC 7523 assertion a Google service account signs to ask for an access token. */
export function serviceAccountAssertion(o: { clientEmail: string; key: KeyObject; keyId?: string | null; tokenUrl: string; scope?: string; now: number }): string {
  const iat = Math.floor(o.now / 1000);
  return signJwt({ alg: 'RS256', typ: 'JWT', ...(o.keyId ? { kid: o.keyId } : {}) }, { iss: o.clientEmail, scope: o.scope ?? FCM_SCOPE, aud: o.tokenUrl, iat, exp: iat + 3600 }, o.key);
}

/** OAuth access tokens by key, kept until a minute before they expire. */
export class OAuthTokens {
  private readonly cache = new Map<string, { token: string; until: number }>();
  private readonly inflight = new Map<string, Promise<string>>();
  fetched = 0;

  constructor(private readonly clock: Clock = Date.now) {}

  async get(id: string, fetch: () => Promise<{ token: string; expiresInS: number }>): Promise<string> {
    const hit = this.cache.get(id);
    if (hit && this.clock() < hit.until) return hit.token;
    const running = this.inflight.get(id);
    if (running) return running;
    const p = (async () => {
      const r = await fetch();
      this.fetched++;
      this.cache.set(id, { token: r.token, until: this.clock() + Math.max(0, r.expiresInS - 60) * 1000 });
      return r.token;
    })().finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  drop(id: string): void {
    this.cache.delete(id);
  }
}
