import { generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { isIP } from 'node:net';
import { pkceChallenge, signDpopProof, signJwtWith, type Jwk, type JwsSigner } from '../federation/jose.js';
import { ServiceUrlRefused } from '../platform/egress.js';
import type { GuardedFetch } from './did.js';
import { isResolvableDid, refusalOf } from './handles.js';

/*
 * AT-Protocol OAuth as a client (B-1808, https://atproto.com/specs/oauth). Exprsn-AI is a confidential web client:
 *
 * - its client_id is the URL of its client metadata document, served per tenant, which names one redirect URI, the
 *   `atproto` scope, DPoP-bound tokens and `private_key_jwt` client authentication with the tenant's ES256 signing key
 *   (the OIDC key set, published at the tenant's jwks_uri, signs the client assertions; the key may live in the signer
 *   or the KMS);
 * - the authorization server is found from the account's PDS: its protected-resource metadata names exactly one
 *   authorization server, whose metadata must name itself as issuer and support PAR, PKCE S256, ES256 DPoP, the `iss`
 *   authorization-response parameter and `private_key_jwt`;
 * - every request starts with a pushed authorization request (PAR); the browser only carries `client_id` and the
 *   `request_uri`;
 * - every token request carries a DPoP proof from a P-256 key made for this one sign-in. A server nonce (`DPoP-Nonce`)
 *   is remembered per origin and a request refused with `use_dpop_nonce` is sent once more with it, as the
 *   specification requires of clients;
 * - all traffic goes through the service URL checks (B-901) with redirects refused, and every URL must be https,
 *   except loopback addresses outside production (local development and the test double).
 *
 * The token response must be DPoP-bound, carry the `atproto` scope and name the account's DID in `sub`; the caller
 * then checks that this DID's PDS really uses this authorization server (the specification's defence against an
 * authorization server answering for accounts it does not hold).
 */

export class AtOAuthError extends Error {}

export interface AsMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  pushed_authorization_request_endpoint: string;
  revocation_endpoint?: string;
}

export interface ClientCredentials {
  clientId: string;
  redirectUri: string;
  /** Signs the private_key_jwt client assertions (ES256, with a kid published at the client's jwks_uri). */
  signer: JwsSigner;
}

export interface DpopKey {
  key: KeyObject;
  jwk: Jwk;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  tokenType: 'DPoP';
  scope: string[];
  sub: string;
  expiresIn: number | null;
}

/** A P-256 key for one sign-in's DPoP proofs. */
export function newDpopKey(): DpopKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const j = publicKey.export({ format: 'jwk' }) as Jwk;
  return { key: privateKey, jwk: { kty: 'EC', crv: 'P-256', x: j.x, y: j.y } };
}

export const pkcePair = (): { verifier: string; challenge: string } => {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: pkceChallenge(verifier) };
};

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export class AtOAuthClient {
  private readonly nonces = new Map<string, string>();
  private readonly asCache = new Map<string, { at: number; meta: AsMetadata }>();

  constructor(
    private readonly http: GuardedFetch,
    private readonly o: { production: boolean }
  ) {}

  /** An https URL, or plain http to a loopback address outside production. Returns its normal form. */
  secureUrl(raw: unknown, what: string): string {
    let u: URL;
    try {
      u = new URL(String(raw));
    } catch {
      throw new AtOAuthError(`The ${what} is not a URL.`);
    }
    if (u.username || u.password || u.hash) throw new AtOAuthError(`The ${what} must not carry credentials or a fragment.`);
    const loopback = LOOPBACK_NAMES.has(u.hostname) || (isIP(u.hostname) === 4 && u.hostname.startsWith('127.'));
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback && !this.o.production)) throw new AtOAuthError(`The ${what} must use https.`);
    return u.toString();
  }

  private async getJson(url: string, what: string): Promise<Record<string, unknown>> {
    let r;
    try {
      r = await this.http.request(url);
    } catch (err) {
      const refused = err instanceof ServiceUrlRefused ? err : refusalOf(err);
      if (refused) throw new AtOAuthError(`The ${what} address was refused: ${refused.message}`);
      throw new AtOAuthError(`The ${what} could not be fetched.`);
    }
    if (r.status !== 200 || !r.json || typeof r.json !== 'object' || Array.isArray(r.json)) throw new AtOAuthError(`The ${what} answered HTTP ${r.status} without a JSON object.`);
    return r.json as Record<string, unknown>;
  }

  /** The authorization server a PDS names in its protected-resource metadata (RFC 9728). */
  async authServerOf(pds: string): Promise<string> {
    const base = this.secureUrl(pds, 'PDS address').replace(/\/+$/, '');
    const meta = await this.getJson(`${new URL(base).origin}/.well-known/oauth-protected-resource`, 'PDS resource metadata');
    if (meta.resource !== undefined && (typeof meta.resource !== 'string' || !URL.canParse(meta.resource) || new URL(meta.resource).origin !== new URL(base).origin)) throw new AtOAuthError('The PDS resource metadata describes another server.');
    const servers = Array.isArray(meta.authorization_servers) ? meta.authorization_servers.filter((x): x is string => typeof x === 'string') : [];
    if (servers.length !== 1) throw new AtOAuthError('The PDS must name exactly one authorization server.');
    return new URL(this.secureUrl(servers[0], 'authorization server')).origin;
  }

  /** The authorization server's metadata (RFC 8414), checked for what AT-Protocol requires. Cached five minutes. */
  async authServer(issuer: string): Promise<AsMetadata> {
    const hit = this.asCache.get(issuer);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.meta;
    const m = await this.getJson(`${issuer}/.well-known/oauth-authorization-server`, 'authorization server metadata');
    if (m.issuer !== issuer) throw new AtOAuthError(`The authorization server metadata names issuer ${String(m.issuer).slice(0, 200)}, not ${issuer}.`);
    const list = (k: string) => (Array.isArray(m[k]) ? (m[k] as unknown[]).filter((x): x is string => typeof x === 'string') : []);
    if (!list('scopes_supported').includes('atproto')) throw new AtOAuthError('The authorization server does not support the atproto scope.');
    if (!list('code_challenge_methods_supported').includes('S256')) throw new AtOAuthError('The authorization server does not support PKCE S256.');
    if (!list('dpop_signing_alg_values_supported').includes('ES256')) throw new AtOAuthError('The authorization server does not accept ES256 DPoP proofs.');
    if (!list('token_endpoint_auth_methods_supported').includes('private_key_jwt')) throw new AtOAuthError('The authorization server does not accept private_key_jwt client authentication.');
    if (m.authorization_response_iss_parameter_supported !== true) throw new AtOAuthError('The authorization server does not send the iss parameter.');
    const meta: AsMetadata = {
      issuer,
      authorization_endpoint: this.secureUrl(m.authorization_endpoint, 'authorization endpoint'),
      token_endpoint: this.secureUrl(m.token_endpoint, 'token endpoint'),
      pushed_authorization_request_endpoint: this.secureUrl(m.pushed_authorization_request_endpoint, 'PAR endpoint'),
      ...(str(m.revocation_endpoint) ? { revocation_endpoint: this.secureUrl(m.revocation_endpoint, 'revocation endpoint') } : {})
    };
    if (this.asCache.size > 200) this.asCache.delete(this.asCache.keys().next().value!);
    this.asCache.set(issuer, { at: Date.now(), meta });
    return meta;
  }

  private async assertion(client: ClientCredentials, audience: string): Promise<Record<string, string>> {
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signJwtWith({ iss: client.clientId, sub: client.clientId, aud: audience, jti: randomBytes(16).toString('base64url'), iat: now, exp: now + 60 }, client.signer);
    return { client_id: client.clientId, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: jwt };
  }

  private remember(url: string, headers: Headers): void {
    const n = headers.get('dpop-nonce');
    if (n && n.length <= 500) {
      if (this.nonces.size > 1000) this.nonces.delete(this.nonces.keys().next().value!);
      this.nonces.set(new URL(url).origin, n);
    }
  }

  /**
   * Sends a request with a DPoP proof (and the token's hash when `accessToken` is given); a `use_dpop_nonce` refusal
   * (400 from an authorization server, 401 from a resource server) is retried once with the nonce it carried.
   */
  private async withDpop(url: string, dpop: DpopKey, init: { method: 'GET' | 'POST'; form?: Record<string, string>; accessToken?: string; formFn?: () => Promise<Record<string, string>> }) {
    for (let attempt = 0; ; attempt++) {
      const nonce = this.nonces.get(new URL(url).origin) ?? null;
      const proof = signDpopProof(dpop.key, dpop.jwk, { htm: init.method, htu: url, nonce, ...(init.accessToken !== undefined ? { accessToken: init.accessToken } : {}) });
      const headers: Record<string, string> = { DPoP: proof };
      if (init.accessToken !== undefined) headers.authorization = `DPoP ${init.accessToken}`;
      let r;
      try {
        // A fresh client assertion for each attempt: its jti is single use.
        const form = init.formFn ? { ...init.form, ...(await init.formFn()) } : init.form;
        r = await this.http.request(url, { method: init.method, headers, ...(form ? { form } : {}) });
      } catch (err) {
        const refused = err instanceof ServiceUrlRefused ? err : refusalOf(err);
        if (refused) throw new AtOAuthError(`${new URL(url).origin} was refused: ${refused.message}`);
        throw new AtOAuthError(`${new URL(url).origin} could not be reached.`);
      }
      this.remember(url, r.headers);
      const body = (r.json && typeof r.json === 'object' ? r.json : {}) as Record<string, unknown>;
      const wantsNonce = (r.status === 400 && body.error === 'use_dpop_nonce') || (r.status === 401 && /error="use_dpop_nonce"/.test(r.headers.get('www-authenticate') ?? ''));
      if (wantsNonce && attempt === 0 && r.headers.get('dpop-nonce')) continue;
      return { status: r.status, body };
    }
  }

  private static failure(what: string, status: number, body: Record<string, unknown>): AtOAuthError {
    const e = str(body.error);
    const d = str(body.error_description);
    return new AtOAuthError(`${what} failed: ${e ? e.slice(0, 100) : `HTTP ${status}`}${d ? ` (${d.slice(0, 200)})` : ''}.`);
  }

  /** The pushed authorization request; returns the `request_uri` for the browser. */
  async par(as: AsMetadata, client: ClientCredentials, dpop: DpopKey, p: { state: string; challenge: string; loginHint: string | null; scope: string }): Promise<string> {
    const form: Record<string, string> = { response_type: 'code', redirect_uri: client.redirectUri, scope: p.scope, state: p.state, code_challenge: p.challenge, code_challenge_method: 'S256', ...(p.loginHint ? { login_hint: p.loginHint } : {}) };
    const r = await this.withDpop(as.pushed_authorization_request_endpoint, dpop, { method: 'POST', form, formFn: () => this.assertion(client, as.issuer) });
    const uri = str(r.body.request_uri);
    if ((r.status !== 201 && r.status !== 200) || !uri) throw AtOAuthClient.failure('The pushed authorization request', r.status, r.body);
    return uri;
  }

  authorizeUrl(as: AsMetadata, clientId: string, requestUri: string): string {
    const u = new URL(as.authorization_endpoint);
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('request_uri', requestUri);
    return u.toString();
  }

  /** The authorization code exchange; the tokens must be DPoP-bound, scoped `atproto` and name a DID. */
  async exchange(as: AsMetadata, client: ClientCredentials, dpop: DpopKey, p: { code: string; verifier: string }): Promise<TokenSet> {
    const form = { grant_type: 'authorization_code', code: p.code, redirect_uri: client.redirectUri, code_verifier: p.verifier };
    const r = await this.withDpop(as.token_endpoint, dpop, { method: 'POST', form, formFn: () => this.assertion(client, as.issuer) });
    if (r.status !== 200) throw AtOAuthClient.failure('The token request', r.status, r.body);
    const b = r.body;
    const access = str(b.access_token);
    if (!access || access.length > 8192) throw new AtOAuthError('The token response has no access token.');
    if (b.token_type !== 'DPoP') throw new AtOAuthError('The access token is not DPoP-bound.');
    const scope = (str(b.scope) ?? '').split(' ').filter(Boolean);
    if (!scope.includes('atproto')) throw new AtOAuthError('The token response does not grant the atproto scope.');
    const sub = str(b.sub);
    if (!sub || !isResolvableDid(sub)) throw new AtOAuthError('The token response does not name a did:plc or did:web account.');
    return { accessToken: access, refreshToken: str(b.refresh_token), tokenType: 'DPoP', scope, sub, expiresIn: typeof b.expires_in === 'number' ? b.expires_in : null };
  }

  /** `com.atproto.server.getSession` at the PDS with the DPoP-bound token: the account the token really reaches. */
  async session(pds: string, dpop: DpopKey, accessToken: string): Promise<{ did: string; handle: string | null }> {
    const url = `${this.secureUrl(pds, 'PDS address').replace(/\/+$/, '')}/xrpc/com.atproto.server.getSession`;
    const r = await this.withDpop(url, dpop, { method: 'GET', accessToken });
    if (r.status !== 200) throw AtOAuthClient.failure('The PDS session check', r.status, r.body);
    const did = str(r.body.did);
    if (!did) throw new AtOAuthError('The PDS did not say which account the token belongs to.');
    return { did, handle: str(r.body.handle) };
  }

  /** Revokes a token (RFC 7009) when the server has a revocation endpoint; best effort, never throws. */
  async revoke(as: AsMetadata, client: ClientCredentials, dpop: DpopKey, token: string): Promise<boolean> {
    if (!as.revocation_endpoint) return false;
    try {
      const r = await this.withDpop(as.revocation_endpoint, dpop, { method: 'POST', form: { token }, formFn: () => this.assertion(client, as.issuer) });
      return r.status === 200;
    } catch {
      return false;
    }
  }
}
