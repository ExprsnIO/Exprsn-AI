import type { RequestHandler } from 'express';
import { JwtError, verifyJwt, type Claims, type Jwk } from '../federation/jose.js';
import { guardedRequest, serviceAddressProblem, servicePolicy } from '../platform/egress.js';
import type { Services } from '../services.js';
import { forbidden } from './problem.js';

/*
 * 1.9.99-final, Sprint 61 (B-10904): Cloudflare Access in front of the console, checked again by the server as an
 * extra condition. Exprsn-AI's identity stays authoritative (B-109): a valid Access token never signs anyone in or
 * stands for a session; it is only one more thing a protected request must carry.
 *
 * What is protected is one list, used both to render the Access applications (`cloud/edge.ts`) and here:
 *   scope `admin`  /api/admin and /admin (the console's admin API and the entry admins open first)
 *   scope `host`   every path except ACCESS_EXCLUSIONS: the machine clients and public pages that must never meet an
 *                  Access login (/v1, the OIDC and SAML endpoints, /.well-known/ and the ACME challenge, webhooks,
 *                  public share links, and the others below)
 *
 * The token (`Cf-Access-Jwt-Assertion`) is an RS256 JWT from the team's issuer `https://<team>.cloudflareaccess.com`,
 * with the application's audience tag; the team's keys come from `/cdn-cgi/access/certs` through the egress guard,
 * cached for an hour and fetched again for an unknown key id (at most once a minute).
 */

export interface AccessExclusion {
  path: string;
  why: string;
  /** Named in the backlog row (B-10904); the rest keep machine clients and public pages working. */
  required?: boolean;
}

export const ACCESS_EXCLUSIONS: readonly AccessExclusion[] = [
  { path: '/v1', why: 'the OpenAI-compatible API (bearer keys)', required: true },
  { path: '/oauth', why: "Exprsn-AI's OIDC provider", required: true },
  { path: '/t', why: "a tenant's OIDC and SAML issuer (/t/<slug>/...)", required: true },
  { path: '/saml', why: 'the SAML identity provider', required: true },
  { path: '/federation', why: 'upstream OIDC, SAML, GitHub and AT-Protocol sign-in callbacks', required: true },
  { path: '/.well-known', why: 'discovery documents, the JWKS and the ACME http-01 challenge', required: true },
  { path: '/.well-known/acme-challenge', why: 'the ACME http-01 challenge', required: true },
  { path: '/device', why: 'the OAuth device flow', required: true },
  { path: '/auth/negotiate', why: 'Kerberos sign-in' },
  { path: '/hooks', why: 'app flow and workflow webhooks (HMAC-signed)', required: true },
  { path: '/webhooks', why: 'the webhook signing keys', required: true },
  { path: '/billing/stripe/webhook', why: 'the Stripe webhook', required: true },
  { path: '/api/public', why: 'public share links, forms, channels, embeds and the unseal API', required: true },
  { path: '/shared', why: 'the public share link page', required: true },
  { path: '/css', why: 'the console stylesheet the share link page loads' },
  { path: '/js', why: 'the console scripts the share link page loads' },
  { path: '/socket.io/socket.io.min.js', why: 'the Socket.io client the console page loads' },
  { path: '/embed', why: 'embedded app pages (host tokens)' },
  { path: '/forms', why: 'public app forms' },
  { path: '/app-subscriptions', why: 'signed unsubscribe links' },
  { path: '/calendar/feeds', why: 'signed iCalendar feeds' },
  { path: '/scim', why: 'SCIM provisioning (SCIM tokens)' },
  { path: '/dav', why: 'CalDAV, CardDAV and WebDAV (app passwords)' },
  { path: '/xrpc', why: 'the PDS and labeler XRPC' },
  { path: '/atproto', why: 'AT-Protocol feeds and DID documents' },
  { path: '/mcp', why: "workspaces' MCP servers (OAuth tokens)" },
  { path: '/pki', why: 'CRLs, issuer certificates and OCSP' },
  { path: '/cloud-issuer', why: 'the cloud federation issuer (when served here)' },
  { path: '/cloud', why: 'GPU node enrolment and spot notices' },
  { path: '/trainer', why: "the training worker's callbacks" },
  { path: '/plugin-broker', why: 'plugin handler tokens' },
  { path: '/healthz', why: 'health checks' },
  { path: '/readyz', why: 'readiness checks' }
];

/** The protected prefixes of the `admin` scope. */
export const ACCESS_ADMIN_PATHS: readonly string[] = ['/api/admin', '/admin'];

/** Whether a path is a prefix's own path or below it, by segment (`/v1` covers `/v1` and `/v1/models`, not `/v10`). */
export const underPrefix = (path: string, prefix: string): boolean => path === prefix || path.startsWith(`${prefix}/`);

/** Whether Access protects a path under a scope. */
export function accessProtects(scope: 'admin' | 'host', path: string): boolean {
  // B-10803: Express routes paths case-insensitively (`/API/Admin/users` reaches the admin routes), so compare lower case.
  path = path.toLowerCase();
  if (scope === 'admin') return ACCESS_ADMIN_PATHS.some((p) => underPrefix(path, p));
  return !ACCESS_EXCLUSIONS.some((x) => underPrefix(path, x.path));
}

/** The team's issuer and certificate address. */
export const accessIssuer = (teamDomain: string): string => `https://${teamDomain}`;
export const accessCertsUrl = (teamDomain: string): string => `https://${teamDomain}/cdn-cgi/access/certs`;

export class AccessVerifier {
  /** Tests point this at the fake's certificate endpoint; otherwise the team's own. */
  certsUrl: string | null = null;
  private keys: { at: number; keys: Jwk[] } | null = null;
  private lastFetch = 0;

  constructor(private readonly s: () => Services) {}

  private async fetchKeys(): Promise<Jwk[]> {
    const cfg = this.s().cfg;
    const url = new URL(this.certsUrl ?? accessCertsUrl(cfg.CLOUDFLARE_ACCESS_TEAM_DOMAIN));
    const policy = servicePolicy(cfg);
    this.lastFetch = Date.now();
    const r = await guardedRequest({ method: 'GET', url, headers: { accept: 'application/json' }, timeoutMs: 10_000, maxBytes: 256 * 1024, check: (a, h) => serviceAddressProblem(a, h, policy) });
    if (r.status !== 200) throw new JwtError(`Cloudflare Access's keys answered ${r.status}.`);
    const body = JSON.parse(r.body.toString('utf8')) as { keys?: Jwk[] };
    const keys = (body.keys ?? []).filter((k) => k && k.kty === 'RSA');
    if (!keys.length) throw new JwtError("Cloudflare Access's key set is empty.");
    this.keys = { at: Date.now(), keys };
    return keys;
  }

  private async keySet(kid: string | undefined): Promise<Jwk[]> {
    const fresh = this.keys && Date.now() - this.keys.at < 3600_000;
    if (fresh && (!kid || this.keys!.keys.some((k) => k.kid === kid))) return this.keys!.keys;
    // An unknown key id (a rotation) is fetched again, but not more than once a minute.
    if (this.keys && fresh && Date.now() - this.lastFetch < 60_000) return this.keys.keys;
    return this.fetchKeys();
  }

  /** The token's claims when it is a valid Access token for one of the configured audiences; throws JwtError otherwise. */
  async verify(token: string): Promise<Claims> {
    const cfg = this.s().cfg;
    const auds = cfg.CLOUDFLARE_ACCESS_AUD.split(',').map((x) => x.trim()).filter(Boolean);
    if (!auds.length || !cfg.CLOUDFLARE_ACCESS_TEAM_DOMAIN) throw new JwtError('Cloudflare Access is not configured.');
    let kid: string | undefined;
    try {
      kid = (JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8')) as { kid?: string }).kid;
    } catch {
      throw new JwtError('The token is not a JWT.');
    }
    const keys = await this.keySet(kid);
    let last: unknown = null;
    for (const audience of auds) {
      try {
        return verifyJwt(token, keys, { issuer: accessIssuer(cfg.CLOUDFLARE_ACCESS_TEAM_DOMAIN), audience, algs: ['RS256'], skewS: 60 });
      } catch (err) {
        last = err;
        if (!(err instanceof JwtError) || !/audience/.test(err.message)) throw err;
      }
    }
    throw last instanceof Error ? last : new JwtError('The token audience does not match.');
  }
}

const verifiers = new WeakMap<Services, AccessVerifier>();

/** The process's verifier for these services (its key cache). */
export function accessVerifierFor(s: Services): AccessVerifier {
  let v = verifiers.get(s);
  if (!v) verifiers.set(s, (v = new AccessVerifier(() => s)));
  return v;
}

declare module 'express-serve-static-core' {
  interface Request {
    /** B-10904: the Access token's identity, when the request carried a valid one (never a sign-in). */
    access?: { email: string | null; sub: string | null };
  }
}

/**
 * The server's own Access check: off without CLOUDFLARE_ACCESS_AUD; with it, a protected path without a valid token
 * answers 403 `access_required`. Paths Access does not protect are never asked for one.
 */
export function cloudflareAccessGuard(s: Services): RequestHandler {
  return (req, _res, next) => {
    const cfg = s.cfg;
    if (!cfg.CLOUDFLARE_ACCESS_AUD) return next();
    if (!accessProtects(cfg.CLOUDFLARE_ACCESS_SCOPE, req.path)) return next();
    const raw = req.headers['cf-access-jwt-assertion'];
    const token = Array.isArray(raw) ? undefined : raw;
    if (!token) return next(forbidden('This address is behind Cloudflare Access: open it through Access.', { reason: 'access_required' }));
    accessVerifierFor(s)
      .verify(token)
      .then((claims) => {
        req.access = { email: typeof claims.email === 'string' ? claims.email : null, sub: typeof claims.sub === 'string' ? claims.sub : null };
        next();
      })
      .catch((err: unknown) => {
        if (err instanceof JwtError) return next(forbidden(`The Cloudflare Access token was refused: ${err.message}`, { reason: 'access_required' }));
        next(err);
      });
  };
}
