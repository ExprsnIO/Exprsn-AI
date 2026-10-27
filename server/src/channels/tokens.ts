import { createHash, createHmac } from 'node:crypto';
import { hmac, safeEqual } from '../crypto/index.js';

/*
 * Customer session tokens and identity assertions for chat channels (B-2301).
 *
 * A session token is `cst_<payload>.<mac>`: the payload names the tenant, channel and session and an expiry, and the
 * MAC is HMAC-SHA256 under a key derived from SESSION_SECRET for this purpose only. It is scoped to one session: the
 * customer endpoints take the session from the token and nothing else, so a token never reaches another session or
 * channel. Closing the session (or the channel) ends it at once, whatever its expiry; rotating SESSION_SECRET ends
 * every one.
 *
 * An identity assertion is how a site vouches for a signed-in customer: `<payload>.<mac>` with the payload
 * `{"sub", "name"?, "email"?, "exp"}` (exp in seconds, at most a day ahead) and the MAC HMAC-SHA256 under the channel's
 * identity secret (shown once to the channel's admin). Both parts are base64url.
 */

const b64 = (v: Buffer | string) => Buffer.from(v).toString('base64url');
const unb64 = (v: string) => Buffer.from(v, 'base64url').toString('utf8');

export interface SessionClaims {
  tenantId: string;
  channelId: string;
  sessionId: string;
  /** Expiry, epoch milliseconds. */
  exp: number;
}

export const sessionKey = (secret: string): Buffer => createHash('sha256').update(`exprsn-ai channel session tokens\n${secret}`).digest();

export function signSession(key: Buffer, c: SessionClaims): string {
  const payload = b64(JSON.stringify({ t: c.tenantId, c: c.channelId, s: c.sessionId, e: c.exp }));
  return `cst_${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
}

export const SESSION_TOKEN = /^cst_([A-Za-z0-9_-]{20,400})\.([A-Za-z0-9_-]{43})$/;

/** The claims of a well-formed, correctly signed and unexpired token, or null. */
export function verifySession(key: Buffer, token: string, now = Date.now()): SessionClaims | null {
  const m = SESSION_TOKEN.exec(token);
  if (!m) return null;
  const mac = createHmac('sha256', key).update(m[1]!).digest('base64url');
  if (!safeEqual(mac, m[2]!)) return null;
  try {
    const p = JSON.parse(unb64(m[1]!)) as { t?: unknown; c?: unknown; s?: unknown; e?: unknown };
    if (typeof p.t !== 'string' || typeof p.c !== 'string' || typeof p.s !== 'string' || typeof p.e !== 'number') return null;
    if (p.e <= now) return null;
    return { tenantId: p.t, channelId: p.c, sessionId: p.s, exp: p.e };
  } catch {
    return null;
  }
}

export interface Identity {
  sub: string;
  name: string | null;
  email: string | null;
}

/** Signs an identity assertion (what a channel's site does; used by tests and documented for integrators). */
export function signIdentity(secret: string, claims: { sub: string; name?: string; email?: string; exp: number }): string {
  const payload = b64(JSON.stringify(claims));
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

/** Verifies an identity assertion; throws with a reason a site's developer can act on. */
export function verifyIdentity(secret: string, token: string, nowMs = Date.now()): Identity {
  const m = /^([A-Za-z0-9_-]{4,2000})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) throw new Error('The identity assertion is not <payload>.<signature> in base64url.');
  const mac = createHmac('sha256', secret).update(m[1]!).digest('base64url');
  if (!safeEqual(mac, m[2]!)) throw new Error('The identity assertion signature does not verify.');
  let p: { sub?: unknown; name?: unknown; email?: unknown; exp?: unknown };
  try {
    p = JSON.parse(unb64(m[1]!)) as typeof p;
  } catch {
    throw new Error('The identity assertion payload is not JSON.');
  }
  if (typeof p.sub !== 'string' || !p.sub || p.sub.length > 200) throw new Error('The identity assertion needs sub (1 to 200 characters).');
  if (typeof p.exp !== 'number' || !Number.isFinite(p.exp)) throw new Error('The identity assertion needs exp (seconds).');
  const now = nowMs / 1000;
  if (p.exp <= now) throw new Error('The identity assertion has expired.');
  if (p.exp > now + 86_400) throw new Error('The identity assertion may be valid for at most a day.');
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  return { sub: p.sub, name: str(p.name, 200), email: str(p.email, 320) };
}

/** A keyed digest of a customer's address or external id, so threads match senders without storing them in clear. */
export const customerKey = (secret: string, tenantId: string, kind: 'email' | 'id', value: string): string => hmac(secret, `channel-customer:${tenantId}:${kind}:${kind === 'email' ? value.trim().toLowerCase() : value}`);
