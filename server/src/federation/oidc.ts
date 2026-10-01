import { randomBytes, randomInt } from 'node:crypto';
import { ulid } from 'ulid';
import { json } from '../db/knex.js';
import { hmac, randomToken, safeEqual } from '../crypto/index.js';
import { isUniqueViolation } from '../audit/chain.js';
import { permissionsFor } from '../authz/permissions.js';
import type { Services } from '../services.js';
import type { SigningKeys } from './keys.js';
import { halfHash, JwtError, pkceChallenge, publicJwk, signJwtWith, verifyDpopProof, verifyJwt, type Claims, type Jwk } from './jose.js';
import { expandAllowed, grantScopes, isKnownScope, parseScope } from './scopes.js';

export const CLIENT_TYPES = ['first_party', 'public', 'service', 'third_party'] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];
export const GRANTS = ['authorization_code', 'refresh_token', 'client_credentials', 'urn:ietf:params:oauth:grant-type:device_code', 'urn:ietf:params:oauth:grant-type:token-exchange'] as const;
export type Grant = (typeof GRANTS)[number];
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
export const EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';

/** An OAuth error for the token, device and revocation endpoints (RFC 6749 5.2): JSON `{error, error_description}`. */
/** A DPoP proof without the current server nonce (RFC 9449 8): the client retries with the DPoP-Nonce header's value. */
export class DpopNonceError extends JwtError {}

export class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    description: string,
    readonly headers: Record<string, string> = {}
  ) {
    super(description);
  }
}

/** A tenant as the protocol endpoints see it: its issuer and endpoint base. */
export interface TenantCtx {
  id: string;
  slug: string;
  name: string;
  issuer: string;
}

export interface ClientRow {
  id: string;
  tenant_id: string;
  client_id: string;
  name: string;
  type: ClientType;
  redirect_uris: string[];
  grants: Grant[];
  scopes: string[];
  pkce_required: boolean;
  secret_hash: string | null;
  secret_created_at: number | null;
  access_ttl: number;
  refresh_ttl: number;
  models: string | null;
  service_user_id: string | null;
  status: 'active' | 'disabled';
  /** Sprint 14: logout URIs, the client's public keys for signed request objects, and per-client requirements. */
  post_logout_redirect_uris: string[];
  frontchannel_logout_uri: string | null;
  backchannel_logout_uri: string | null;
  jwks: Jwk[];
  par_required: boolean;
  dpop_required: boolean;
  /** Sprint 17 (B-806): `any` lets a resource server introspect every client's access tokens (set under dual control). */
  introspect: 'own' | 'any';
  created_by: string | null;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
}

const clientFromRow = (r: Record<string, unknown>): ClientRow => ({
  ...(r as unknown as ClientRow),
  redirect_uris: json<string[]>(r.redirect_uris, []),
  grants: json<Grant[]>(r.grants, []),
  scopes: json<string[]>(r.scopes, []),
  pkce_required: !!r.pkce_required,
  post_logout_redirect_uris: json<string[]>(r.post_logout_redirect_uris, []),
  frontchannel_logout_uri: (r.frontchannel_logout_uri as string | null) ?? null,
  backchannel_logout_uri: (r.backchannel_logout_uri as string | null) ?? null,
  jwks: json<{ keys?: Jwk[] }>(r.jwks, {}).keys ?? [],
  par_required: !!r.par_required,
  dpop_required: !!r.dpop_required,
  introspect: r.introspect === 'any' ? 'any' : 'own',
  secret_created_at: r.secret_created_at == null ? null : Number(r.secret_created_at),
  access_ttl: Number(r.access_ttl),
  refresh_ttl: Number(r.refresh_ttl),
  last_used_at: r.last_used_at == null ? null : Number(r.last_used_at),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

export const isConfidential = (c: Pick<ClientRow, 'type'>): boolean => c.type !== 'public';
/** First-party and service clients are pre-consented (when the tenant allows it); public and third-party clients ask. */
export const isFirstParty = (c: Pick<ClientRow, 'type'>): boolean => c.type === 'first_party' || c.type === 'service';

export interface AuthzRequest {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string | null;
  nonce: string | null;
  codeChallenge: string | null;
  prompt: string | null;
  audience: string | null;
  /** OIDC max_age in seconds: a sign-in older than this must be repeated. */
  maxAge: number | null;
}

/** The request_uri prefix of pushed authorization requests (RFC 9126). */
export const PAR_URN = 'urn:ietf:params:oauth:request_uri:';
/** Pushed requests live this long before the browser presents them (RFC 9126 recommends a short lifetime). */
export const PAR_SECONDS = 60;
/** Once presented, a pushed request stays usable (once) while the user signs in and consents. */
const PAR_FLOW_MS = 10 * 60_000;
/** The longest access-token lifetime a client can have (30 minutes), plus clock skew: how long a revocation must be kept. */
const MAX_ACCESS_MS = 1800_000 + 60_000;
export const BACKCHANNEL_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
/** Bus topic: an access token (or a user's grant to a client) was denied; instances drop their cached checks. */
export const DENIED_TOPIC = 'oauth.denied';

/** The client parameters an admin sets for logout, request objects, PAR and DPoP. */
export interface ClientExtras {
  postLogoutRedirectUris?: string[];
  frontchannelLogoutUri?: string | null;
  backchannelLogoutUri?: string | null;
  jwks?: Jwk[] | null;
  parRequired?: boolean;
  dpopRequired?: boolean;
}

/** A DPoP proof presented at the token endpoint or with a resource request. */
export interface DpopInput {
  proof: string | undefined;
  method: string;
  url: string;
}

/** Validates a client's public key set for request objects: EC P-256 or RSA (2048+) public keys only, at most 5. */
export function clientJwks(input: unknown): Jwk[] {
  const list = Array.isArray(input) ? input : input && typeof input === 'object' && Array.isArray((input as { keys?: unknown }).keys) ? (input as { keys: unknown[] }).keys : null;
  if (!list || list.length > 5) throw new Error('Give a JWKS with one to five public keys.');
  return list.map((k) => {
    const pub = publicJwk(k);
    if (!pub) throw new Error('Each key must be a public EC P-256 or RSA (2048 bits or more) key, without private members.');
    const kid = (k as { kid?: unknown }).kid;
    return typeof kid === 'string' && kid.length <= 100 ? { ...pub, kid } : pub;
  });
}

/** An /oauth/authorize failure. `redirect` false means the client or redirect URI is untrusted: show a page, never redirect. */
export class AuthorizeError extends Error {
  constructor(
    readonly error: string,
    description: string,
    readonly redirect: boolean
  ) {
    super(description);
  }
}

export interface SignedInUser {
  tenantId: string;
  userId: string;
  sessionId: string | null;
  method: string;
  authTime: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer' | 'DPoP';
  expires_in: number;
  scope: string;
  id_token?: string;
  refresh_token?: string;
  issued_token_type?: string;
}

interface RefreshRow {
  id: string;
  family_id: string;
  tenant_id: string;
  client_id: string;
  user_id: string;
  session_id: string | null;
  scopes: string;
  amr: string;
  method: string;
  auth_time: number;
  created_at: number;
  family_created_at: number;
  expires_at: number;
  used_at: number | null;
  revoked_at: number | null;
  dpop_jkt: string | null;
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));

/** RFC 8176 method references from the session's sign-in method ("LDAP password, TOTP"). */
export function amrFor(method: string): string[] {
  const m = method.toLowerCase();
  const out: string[] = [];
  if (m.includes('password')) out.push('pwd');
  if (m.includes('totp') || m.includes('recovery')) out.push('otp');
  if (m.includes('passkey')) out.push('hwk');
  if (m.includes('kerberos')) out.push('kerberos');
  if (m.includes('oidc') || m.includes('saml')) out.push('fed');
  if (out.length > 1) out.push('mfa');
  return out.length ? out : ['pwd'];
}

const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
export const normaliseUserCode = (c: string): string => c.toUpperCase().replace(/[^A-Z]/g, '');
const formatUserCode = (c: string): string => `${c.slice(0, 4)}-${c.slice(4)}`;

/**
 * The OpenID Connect provider: clients, authorization codes with PKCE, ID and access tokens (JWT, ES256),
 * refresh-token families rotated on every use (a reused token revokes its family), client credentials, device
 * authorization (RFC 8628) and token exchange (RFC 8693). Codes, refresh tokens, device codes and client secrets
 * are stored as HMAC digests only.
 */
export class OidcProvider {
  constructor(
    private readonly s: () => Services,
    private readonly keys: SigningKeys
  ) {}

  private get db() {
    return this.s().db;
  }

  digest(kind: string, value: string): string {
    return hmac(this.s().cfg.SESSION_SECRET, `oidc-${kind}:${value}`);
  }

  // ---------- discovery ----------

  discovery(t: TenantCtx): Record<string, unknown> {
    const b = t.issuer;
    return {
      issuer: b,
      authorization_endpoint: `${b}/oauth/authorize`,
      token_endpoint: `${b}/oauth/token`,
      userinfo_endpoint: `${b}/oauth/userinfo`,
      jwks_uri: `${b}/.well-known/jwks.json`,
      revocation_endpoint: `${b}/oauth/revoke`,
      introspection_endpoint: `${b}/oauth/introspect`,
      end_session_endpoint: `${b}/oauth/logout`,
      pushed_authorization_request_endpoint: `${b}/oauth/par`,
      device_authorization_endpoint: `${b}/oauth/device_authorization`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: [...GRANTS],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['ES256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      introspection_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['openid', 'profile', 'email', 'groups', 'offline_access'],
      claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'auth_time', 'nonce', 'amr', 'azp', 'at_hash', 'sid', 'name', 'preferred_username', 'email', 'groups', 'roles', 'clearance', 'tenant'],
      prompt_values_supported: ['none', 'login', 'consent'],
      claims_parameter_supported: false,
      // RFC 9101 request objects (signed with a key the client registered) and RFC 9126 pushed requests.
      request_parameter_supported: true,
      request_uri_parameter_supported: true,
      require_request_uri_registration: true,
      request_object_signing_alg_values_supported: ['ES256', 'RS256'],
      require_pushed_authorization_requests: false,
      // RFC 9449 sender-constrained tokens.
      dpop_signing_alg_values_supported: ['ES256', 'RS256'],
      // OpenID Connect RP-initiated, front-channel and back-channel logout.
      frontchannel_logout_supported: true,
      frontchannel_logout_session_supported: true,
      backchannel_logout_supported: true,
      backchannel_logout_session_supported: true
    };
  }

  // ---------- clients ----------

  async listClients(tenantId: string): Promise<ClientRow[]> {
    return (await this.db('oidc_clients').where({ tenant_id: tenantId }).orderBy('created_at')).map(clientFromRow);
  }

  async getClient(tenantId: string, id: string): Promise<ClientRow | undefined> {
    const r = await this.db('oidc_clients').where({ tenant_id: tenantId, id }).first();
    return r ? clientFromRow(r) : undefined;
  }

  async byClientId(tenantId: string, clientId: string): Promise<ClientRow | undefined> {
    const r = await this.db('oidc_clients').where({ tenant_id: tenantId, client_id: clientId }).first();
    return r ? clientFromRow(r) : undefined;
  }

  private newSecret(): string {
    return `xs_live_${randomToken(32)}`;
  }

  async createClient(
    tenantId: string,
    input: { name: string; type: ClientType; redirectUris: string[]; grants: Grant[]; scopes: string[]; pkceRequired: boolean; accessTtl: number; refreshTtl: number; models: string | null; serviceUserId: string | null } & ClientExtras,
    createdBy: string | null
  ): Promise<{ client: ClientRow; secret: string | null }> {
    const t = Date.now();
    const secret = isConfidential(input) ? this.newSecret() : null;
    const row = {
      id: ulid(),
      tenant_id: tenantId,
      client_id: `c_${randomBytes(4).toString('hex')}`,
      name: input.name,
      type: input.type,
      redirect_uris: JSON.stringify(input.redirectUris),
      grants: JSON.stringify(input.grants),
      scopes: JSON.stringify(input.scopes),
      pkce_required: input.type === 'public' ? true : input.pkceRequired,
      secret_hash: secret ? this.digest('secret', secret) : null,
      secret_created_at: secret ? t : null,
      access_ttl: input.accessTtl,
      refresh_ttl: input.refreshTtl,
      models: input.models,
      service_user_id: input.serviceUserId,
      post_logout_redirect_uris: JSON.stringify(input.postLogoutRedirectUris ?? []),
      frontchannel_logout_uri: input.frontchannelLogoutUri ?? null,
      backchannel_logout_uri: input.backchannelLogoutUri ?? null,
      jwks: input.jwks?.length ? JSON.stringify({ keys: input.jwks }) : null,
      par_required: input.parRequired ?? false,
      dpop_required: input.dpopRequired ?? false,
      status: 'active',
      created_by: createdBy,
      last_used_at: null,
      created_at: t,
      updated_at: t
    };
    await this.db('oidc_clients').insert(row);
    return { client: clientFromRow(row), secret };
  }

  async updateClient(tenantId: string, id: string, patch: { name?: string; redirectUris?: string[]; scopes?: string[]; pkceRequired?: boolean; accessTtl?: number; models?: string | null; grants?: Grant[] } & ClientExtras): Promise<ClientRow | undefined> {
    const current = await this.getClient(tenantId, id);
    if (!current) return undefined;
    const upd: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.name !== undefined) upd.name = patch.name;
    if (patch.redirectUris !== undefined) upd.redirect_uris = JSON.stringify(patch.redirectUris);
    if (patch.scopes !== undefined) upd.scopes = JSON.stringify(patch.scopes);
    if (patch.grants !== undefined) upd.grants = JSON.stringify(patch.grants);
    if (patch.pkceRequired !== undefined) upd.pkce_required = current.type === 'public' ? true : patch.pkceRequired;
    if (patch.accessTtl !== undefined) upd.access_ttl = patch.accessTtl;
    if (patch.models !== undefined) upd.models = patch.models;
    if (patch.postLogoutRedirectUris !== undefined) upd.post_logout_redirect_uris = JSON.stringify(patch.postLogoutRedirectUris);
    if (patch.frontchannelLogoutUri !== undefined) upd.frontchannel_logout_uri = patch.frontchannelLogoutUri;
    if (patch.backchannelLogoutUri !== undefined) upd.backchannel_logout_uri = patch.backchannelLogoutUri;
    if (patch.jwks !== undefined) upd.jwks = patch.jwks?.length ? JSON.stringify({ keys: patch.jwks }) : null;
    if (patch.parRequired !== undefined) upd.par_required = patch.parRequired;
    if (patch.dpopRequired !== undefined) upd.dpop_required = patch.dpopRequired;
    await this.db('oidc_clients').where({ tenant_id: tenantId, id }).update(upd);
    return this.getClient(tenantId, id);
  }

  /** Issues a new secret; the old one stops working immediately. Returns the new secret (shown once). */
  async rotateSecret(tenantId: string, id: string): Promise<string> {
    const secret = this.newSecret();
    const t = Date.now();
    await this.db('oidc_clients').where({ tenant_id: tenantId, id }).update({ secret_hash: this.digest('secret', secret), secret_created_at: t, updated_at: t });
    return secret;
  }

  /** Disabling revokes every refresh token of the client; its access tokens fail at userinfo and the API at once. */
  async setStatus(tenantId: string, id: string, status: 'active' | 'disabled'): Promise<{ revoked: number }> {
    const client = await this.getClient(tenantId, id);
    if (!client) return { revoked: 0 };
    await this.db('oidc_clients').where({ tenant_id: tenantId, id }).update({ status, updated_at: Date.now() });
    if (status === 'active') return { revoked: 0 };
    const revoked = await this.db('oidc_refresh_tokens').where({ tenant_id: tenantId, client_id: client.client_id, revoked_at: null }).update({ revoked_at: Date.now() });
    await this.db('oidc_device_codes').where({ tenant_id: tenantId, client_id: client.client_id, status: 'pending' }).update({ status: 'denied' });
    return { revoked };
  }

  /**
   * Authenticates a client at the token, device and revocation endpoints: HTTP Basic or form credentials for
   * confidential clients; public clients present only their id.
   */
  async authenticateClient(t: TenantCtx, form: Record<string, string>, authorization: string | undefined): Promise<ClientRow> {
    let clientId = form.client_id;
    let secret = form.client_secret;
    if (authorization?.startsWith('Basic ')) {
      const raw = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
      const i = raw.indexOf(':');
      if (i < 0) throw new OAuthError(401, 'invalid_client', 'Malformed client credentials.', { 'WWW-Authenticate': 'Basic realm="token"' });
      clientId = decodeURIComponent(raw.slice(0, i));
      secret = decodeURIComponent(raw.slice(i + 1));
    }
    if (!clientId) throw new OAuthError(401, 'invalid_client', 'Client authentication is required.');
    const client = await this.byClientId(t.id, clientId);
    if (!client || client.status !== 'active') throw new OAuthError(401, 'invalid_client', 'Unknown or disabled client.');
    if (isConfidential(client)) {
      if (!secret || !client.secret_hash || !safeEqual(this.digest('secret', secret), client.secret_hash)) throw new OAuthError(401, 'invalid_client', 'Client authentication failed.');
    } else if (secret) throw new OAuthError(401, 'invalid_client', 'Public clients have no secret.');
    return client;
  }

  private async touchClient(client: ClientRow): Promise<void> {
    await this.db('oidc_clients').where({ id: client.id }).update({ last_used_at: Date.now() });
  }

  // ---------- authorization endpoint ----------

  /**
   * Validates an authorization request. Errors about the client or redirect URI must not redirect. A `request_uri`
   * names a pushed request (RFC 9126), used instead of the query; a `request` object (RFC 9101) is verified with the
   * client's registered keys and its parameters alone are used. `par` is the pushed request's id, to be claimed
   * (once) when the request is answered.
   */
  async validateAuthorize(t: TenantCtx, q: Record<string, unknown>): Promise<{ client: ClientRow; req: AuthzRequest; par: string | null }> {
    const str = (k: string): string | null => (typeof q[k] === 'string' && (q[k] as string).length <= 2000 ? (q[k] as string) : null);
    const clientId = str('client_id');
    const client = clientId ? await this.byClientId(t.id, clientId) : undefined;
    if (!client) throw new AuthorizeError('invalid_client', 'Unknown client.', false);
    if (client.status !== 'active') throw new AuthorizeError('invalid_client', 'This client is disabled.', false);
    if (q.request_uri !== undefined) {
      const pushed = await this.pushedRequest(t, client, q.request_uri);
      return { client, req: await this.checkParams(t, client, pushed.params), par: pushed.id };
    }
    if (client.par_required) throw new AuthorizeError('invalid_request', 'This client must push its authorization requests (PAR) first.', false);
    const params = q.request !== undefined ? await this.requestObject(t, client, q.request, q) : q;
    return { client, req: await this.checkParams(t, client, params), par: null };
  }

  /** The parameter checks shared by the authorization endpoint and the PAR endpoint. */
  private async checkParams(t: TenantCtx, client: ClientRow, q: Record<string, unknown>): Promise<AuthzRequest> {
    const str = (k: string): string | null => (typeof q[k] === 'string' && (q[k] as string).length <= 2000 ? (q[k] as string) : null);
    if (q.client_id !== undefined && q.client_id !== client.client_id) throw new AuthorizeError('invalid_request', 'client_id does not match.', false);
    const redirectUri = str('redirect_uri');
    // Exact string match: no wildcards, no prefix or path matching.
    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) throw new AuthorizeError('invalid_request', 'The redirect URI is not registered for this client.', false);
    if (!client.grants.includes('authorization_code')) throw new AuthorizeError('unauthorized_client', 'This client may not use the authorization code grant.', true);
    if (str('response_type') !== 'code') throw new AuthorizeError('unsupported_response_type', 'Only response_type=code is supported.', true);
    if (q.request !== undefined || q.request_uri !== undefined) throw new AuthorizeError('invalid_request', 'A request object cannot carry another request.', true);
    const challenge = str('code_challenge');
    const method = str('code_challenge_method');
    if (challenge && method !== 'S256') throw new AuthorizeError('invalid_request', 'Only the S256 code challenge method is accepted.', true);
    if (challenge && !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new AuthorizeError('invalid_request', 'Malformed code challenge.', true);
    if (!challenge && (client.type === 'public' || client.pkce_required)) throw new AuthorizeError('invalid_request', 'PKCE (code_challenge with S256) is required for this client.', true);
    const scopes = parseScope(str('scope'));
    if (!scopes.length) throw new AuthorizeError('invalid_scope', 'Request at least one scope.', true);
    const unknown = scopes.filter((x) => !isKnownScope(x) || x.endsWith(':*'));
    if (unknown.length) throw new AuthorizeError('invalid_scope', `Unknown scope ${unknown[0]}.`, true);
    const prompt = str('prompt');
    const prompts = (prompt ?? '').split(' ').filter(Boolean);
    if (prompts.some((x) => !['none', 'login', 'consent'].includes(x))) throw new AuthorizeError('invalid_request', 'prompt must be none, login or consent.', true);
    if (prompts.includes('none') && prompts.length > 1) throw new AuthorizeError('invalid_request', 'prompt=none cannot be combined with other values.', true);
    const maxAgeRaw = q.max_age;
    let maxAge: number | null = null;
    if (maxAgeRaw !== undefined) {
      maxAge = typeof maxAgeRaw === 'number' ? maxAgeRaw : typeof maxAgeRaw === 'string' && /^\d{1,9}$/.test(maxAgeRaw) ? Number(maxAgeRaw) : NaN;
      if (!Number.isInteger(maxAge) || maxAge < 0) throw new AuthorizeError('invalid_request', 'max_age must be a whole number of seconds.', true);
    }
    return { clientId: client.client_id, redirectUri, scopes, state: str('state'), nonce: str('nonce'), codeChallenge: challenge, prompt: prompts.join(' ') || null, audience: str('audience') ?? str('resource'), maxAge };
  }

  /**
   * RFC 9101: verifies a signed request object with the client's registered keys (ES256 or RS256; `none` never) and
   * returns its parameters. It must name the client as issuer and this server as audience, and not be replayed.
   */
  private async requestObject(t: TenantCtx, client: ClientRow, jwt: unknown, outer: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (typeof jwt !== 'string' || jwt.length > 16_000) throw new AuthorizeError('invalid_request_object', 'Malformed request object.', false);
    if (!client.jwks.length) throw new AuthorizeError('invalid_request_object', 'This client has no registered keys for request objects.', false);
    let claims: Claims;
    try {
      claims = verifyJwt(jwt, client.jwks, { issuer: client.client_id, audience: t.issuer, algs: ['ES256', 'RS256'] });
    } catch (err) {
      throw new AuthorizeError('invalid_request_object', `The request object was refused: ${(err as Error).message}`, false);
    }
    if (claims.client_id !== client.client_id || (outer.client_id !== undefined && outer.client_id !== client.client_id)) throw new AuthorizeError('invalid_request_object', 'The request object is for another client.', false);
    if (typeof claims.exp !== 'number' || claims.exp * 1000 - Date.now() > 3600_000) throw new AuthorizeError('invalid_request_object', 'The request object must expire within an hour.', false);
    if (typeof claims.jti === 'string' && !(await this.once('jar', `${client.client_id}:${claims.jti}`, claims.exp * 1000 + 60_000))) throw new AuthorizeError('invalid_request_object', 'The request object was already used.', false);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(claims)) {
      if (['iss', 'aud', 'exp', 'iat', 'nbf', 'jti'].includes(k)) continue;
      out[k] = typeof v === 'number' ? String(v) : v;
    }
    return out;
  }

  /** RFC 9126: stores a pushed request for 60 seconds and returns its request_uri. */
  async pushRequest(t: TenantCtx, form: Record<string, string>, authorization: string | undefined): Promise<{ client: ClientRow; response: { request_uri: string; expires_in: number } }> {
    const client = await this.authenticateClient(t, form, authorization);
    if (form.request_uri !== undefined) throw new OAuthError(400, 'invalid_request', 'request_uri cannot be pushed.');
    const q: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(form)) if (!['client_secret', 'client_assertion', 'client_assertion_type'].includes(k)) q[k] = v;
    let params: Record<string, unknown>;
    try {
      params = q.request !== undefined ? await this.requestObject(t, client, q.request, q) : q;
      await this.checkParams(t, client, params);
    } catch (err) {
      if (err instanceof AuthorizeError) throw new OAuthError(400, err.error, err.message);
      throw err;
    }
    const handle = randomToken(32);
    await this.db('federation_pending').insert({ id: this.digest('par', handle), tenant_id: t.id, kind: 'par', data: JSON.stringify({ clientId: client.client_id, params, presented: false }), expires_at: Date.now() + PAR_SECONDS * 1000 });
    return { client, response: { request_uri: `${PAR_URN}${handle}`, expires_in: PAR_SECONDS } };
  }

  /** Finds a pushed request by its request_uri (without using it up); the first presentation extends it for the sign-in. */
  private async pushedRequest(t: TenantCtx, client: ClientRow, uri: unknown): Promise<{ id: string; params: Record<string, unknown> }> {
    if (typeof uri !== 'string' || !uri.startsWith(PAR_URN) || uri.length > 200) throw new AuthorizeError('invalid_request_uri', 'Only request URIs from the pushed authorization endpoint are accepted.', false);
    const id = this.digest('par', uri.slice(PAR_URN.length));
    const row = (await this.db('federation_pending').where({ id, tenant_id: t.id, kind: 'par' }).first()) as { data: string; expires_at: number } | undefined;
    if (!row || Number(row.expires_at) < Date.now()) throw new AuthorizeError('invalid_request_uri', 'The pushed request is unknown, expired or already used.', false);
    const data = json<{ clientId: string; params: Record<string, unknown>; presented: boolean }>(row.data, { clientId: '', params: {}, presented: true });
    if (data.clientId !== client.client_id) throw new AuthorizeError('invalid_request_uri', 'The pushed request belongs to another client.', false);
    if (!data.presented) await this.db('federation_pending').where({ id }).update({ data: JSON.stringify({ ...data, presented: true }), expires_at: Date.now() + PAR_FLOW_MS });
    return { id, params: data.params };
  }

  /** Uses up a pushed request when it is answered (a code, a consent page or an error): a request_uri works once. */
  async claimPushed(id: string | null): Promise<boolean> {
    if (!id) return true;
    return (await this.db('federation_pending').where({ id, kind: 'par' }).delete()) > 0;
  }

  /** Records a single-use value (a DPoP or request object jti) until `expiresAt`; false when it was seen before. */
  async once(kind: string, value: string, expiresAt: number): Promise<boolean> {
    try {
      await this.db('oauth_replay').insert({ id: this.digest(`replay-${kind}`, value), expires_at: expiresAt });
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }

  /** The scopes this user would be granted, which the consent page lists. */
  async grantableScopes(tenantId: string, userId: string, client: ClientRow, requested: string[]): Promise<string[]> {
    return grantScopes(requested, client.scopes, permissionsFor(await this.s().users.roleIds(userId)));
  }

  /** Does this grant need the user's consent, given the tenant's consent policy and remembered consents? */
  async needsConsent(tenantId: string, client: ClientRow, userId: string, scopes: string[], policy: { firstPartyPreconsented: boolean; thirdPartyAsk: boolean }): Promise<boolean> {
    if (isFirstParty(client)) {
      if (policy.firstPartyPreconsented) return false;
    } else if (!policy.thirdPartyAsk) return false;
    const row = (await this.db('oidc_consents').where({ user_id: userId, client_id: client.client_id, tenant_id: tenantId }).first()) as { scopes: string; expires_at: number | null } | undefined;
    if (!row || (row.expires_at != null && Number(row.expires_at) < Date.now())) return true;
    const granted = row.scopes.split(' ');
    return !scopes.every((x) => granted.includes(x));
  }

  async recordConsent(tenantId: string, client: ClientRow, userId: string, scopes: string[], rememberDays: number): Promise<void> {
    if (rememberDays <= 0) return;
    const t = Date.now();
    await this.db('oidc_consents').where({ user_id: userId, client_id: client.client_id }).delete();
    await this.db('oidc_consents').insert({ tenant_id: tenantId, user_id: userId, client_id: client.client_id, scopes: scopes.join(' '), granted_at: t, expires_at: t + rememberDays * 86_400_000 });
  }

  async consentCount(tenantId: string, clientId: string): Promise<number> {
    const r = (await this.db('oidc_consents').where({ tenant_id: tenantId, client_id: clientId }).count({ n: '*' }).first()) as { n: number | string } | undefined;
    return Number(r?.n ?? 0);
  }

  async issueCode(t: TenantCtx, client: ClientRow, req: AuthzRequest, user: SignedInUser, scopes: string[]): Promise<string> {
    const code = randomToken(32);
    await this.db('oidc_codes').insert({
      id: this.digest('code', code),
      tenant_id: t.id,
      client_id: client.client_id,
      user_id: user.userId,
      session_id: user.sessionId,
      redirect_uri: req.redirectUri,
      scopes: scopes.join(' '),
      nonce: req.nonce,
      code_challenge: req.codeChallenge,
      amr: amrFor(user.method).join(' ') + '|' + user.method.slice(0, 100),
      auth_time: user.authTime,
      expires_at: Date.now() + 60_000,
      used_at: null,
      family_id: null
    });
    if (user.sessionId) await this.recordRpSession(t.id, user.sessionId, user.userId, client.client_id);
    return code;
  }

  /** The `sid` this issuer puts in ID and logout tokens for a sign-in session: stable per session, not the session id. */
  sidFor(sessionId: string): string {
    return this.digest('sid', sessionId).slice(0, 32);
  }

  /** Remembers that a session issued a code to a client, so signing out reaches that client. */
  async recordRpSession(tenantId: string, sessionId: string, userId: string, clientId: string): Promise<void> {
    try {
      await this.db('oidc_rp_sessions').insert({ id: ulid(), tenant_id: tenantId, session_id: sessionId, user_id: userId, client_id: clientId, sid: this.sidFor(sessionId), created_at: Date.now(), ended_at: null });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }

  // ---------- tokens ----------

  /** Identity claims for the granted scopes: profile, email, and groups (with roles and clearance). */
  private async identityClaims(tenantId: string, userId: string, scopes: string[]): Promise<Claims> {
    const user = await this.s().users.get(tenantId, userId);
    if (!user) return {};
    const out: Claims = {};
    if (scopes.includes('profile')) Object.assign(out, { name: user.display_name, preferred_username: user.username });
    if (scopes.includes('email') && user.email) Object.assign(out, { email: user.email });
    if (scopes.includes('groups')) {
      const links = (await this.db('user_identities').where({ user_id: userId }).orderBy('last_seen_at', 'desc').select('groups')) as { groups: string }[];
      out.groups = json<string[]>(links[0]?.groups, []);
      out.roles = await this.s().users.roleIds(userId);
      out.clearance = user.clearance;
    }
    return out;
  }

  private async mint(
    t: TenantCtx,
    client: ClientRow,
    grant: { userId: string; scopes: string[]; nonce?: string | null; authTime: number | null; amr: string[]; method: string; sessionId: string | null; audience?: string | null; act?: Claims; familyId?: string | null; familyCreatedAt?: number; refresh: boolean; dpopJkt?: string | null }
  ): Promise<TokenResponse> {
    const signer = await this.keys.signer(t.id);
    const now = Math.floor(Date.now() / 1000);
    const tenant = { tenant: t.slug, tid: t.id };
    let refresh: string | undefined;
    let familyId = grant.familyId ?? null;
    if (grant.refresh && client.grants.includes('refresh_token')) {
      refresh = randomToken(32);
      familyId = familyId ?? ulid();
      const created = Date.now();
      await this.db('oidc_refresh_tokens').insert({
        id: this.digest('refresh', refresh),
        family_id: familyId,
        tenant_id: t.id,
        client_id: client.client_id,
        user_id: grant.userId,
        session_id: grant.sessionId,
        scopes: grant.scopes.join(' '),
        amr: grant.amr.join(' '),
        method: grant.method.slice(0, 100),
        auth_time: grant.authTime ?? created,
        created_at: created,
        family_created_at: grant.familyCreatedAt ?? created,
        expires_at: (grant.familyCreatedAt ?? created) + client.refresh_ttl * 1000,
        used_at: null,
        revoked_at: null,
        dpop_jkt: grant.dpopJkt ?? null
      });
    }
    const access = await signJwtWith(
      {
        iss: t.issuer,
        sub: grant.userId,
        aud: grant.audience || `${t.issuer}/api`,
        client_id: client.client_id,
        scope: grant.scopes.join(' '),
        iat: now,
        exp: now + client.access_ttl,
        jti: ulid(),
        ...(grant.authTime ? { auth_time: Math.floor(grant.authTime / 1000) } : {}),
        ...(grant.amr.length ? { amr: grant.amr } : {}),
        ...(familyId ? { sid: familyId } : {}),
        ...(client.models ? { models: client.models } : {}),
        ...(grant.act ? { act: grant.act } : {}),
        // RFC 9449: a DPoP-bound token names the thumbprint of the key whose proofs must accompany it.
        ...(grant.dpopJkt ? { cnf: { jkt: grant.dpopJkt } } : {}),
        ...tenant
      },
      signer,
      'at+jwt'
    );
    const out: TokenResponse = { access_token: access, token_type: grant.dpopJkt ? 'DPoP' : 'Bearer', expires_in: client.access_ttl, scope: grant.scopes.join(' ') };
    if (grant.scopes.includes('openid')) {
      out.id_token = await signJwtWith(
        {
          iss: t.issuer,
          sub: grant.userId,
          aud: client.client_id,
          azp: client.client_id,
          iat: now,
          exp: now + client.access_ttl,
          ...(grant.authTime ? { auth_time: Math.floor(grant.authTime / 1000) } : {}),
          ...(grant.nonce ? { nonce: grant.nonce } : {}),
          amr: grant.amr,
          at_hash: halfHash(access),
          ...(grant.sessionId ? { sid: this.sidFor(grant.sessionId) } : {}),
          ...tenant,
          ...(await this.identityClaims(t.id, grant.userId, grant.scopes))
        },
        signer
      );
    }
    if (refresh) out.refresh_token = refresh;
    await this.touchClient(client);
    return out;
  }

  private async userActive(tenantId: string, userId: string): Promise<boolean> {
    const [user, tenant] = await Promise.all([this.s().users.get(tenantId, userId), this.s().tenants.byId(tenantId)]);
    return !!user && user.state === 'active' && tenant?.state === 'active';
  }

  /**
   * The current DPoP nonce (RFC 9449 8, B-805): an HMAC of the time window, so every instance issues and accepts the
   * same values without shared state. The previous window's nonce stays valid, so a nonce lives one to two periods.
   */
  dpopNonce(at = Date.now()): string {
    const period = this.s().cfg.DPOP_NONCE_SECONDS * 1000;
    return hmac(this.s().cfg.SESSION_SECRET, `dpop-nonce:${Math.floor(at / period)}`).slice(0, 43);
  }

  private dpopNonceValid(nonce: string | null): boolean {
    if (!nonce) return false;
    const now = Date.now();
    return safeEqual(nonce, this.dpopNonce(now)) || safeEqual(nonce, this.dpopNonce(now - this.s().cfg.DPOP_NONCE_SECONDS * 1000));
  }

  /**
   * Verifies a DPoP proof and records its jti (shared by every instance) so it cannot be replayed. Returns the key
   * thumbprint. With DPOP_NONCES the proof must carry a current server nonce, or `DpopNonceError` asks for one.
   */
  async checkDpop(dpop: DpopInput, accessToken?: string): Promise<string> {
    if (!dpop.proof || dpop.proof.length > 8000) throw new JwtError('A DPoP proof is required.');
    const maxAge = this.s().cfg.DPOP_PROOF_MAX_AGE_SECONDS;
    const proof = verifyDpopProof(dpop.proof, { method: dpop.method, url: dpop.url, accessToken, maxAgeS: maxAge });
    if (this.s().cfg.DPOP_NONCES && !this.dpopNonceValid(proof.nonce)) throw new DpopNonceError(proof.nonce ? 'The DPoP nonce has expired; use the one in the DPoP-Nonce header.' : 'Send the DPoP proof with the nonce from the DPoP-Nonce header.');
    if (!(await this.once('dpop', `${proof.jkt}:${proof.jti}`, (proof.iat + maxAge + 60) * 1000))) throw new JwtError('The DPoP proof was already used.');
    return proof.jkt;
  }

  /** The token endpoint. `dpop` carries the request's DPoP header, when there is one. */
  async token(t: TenantCtx, form: Record<string, string>, authorization: string | undefined, dpop?: DpopInput): Promise<{ response: TokenResponse; client: ClientRow; userId: string; grant: string }> {
    const grantType = form.grant_type;
    if (!grantType) throw new OAuthError(400, 'invalid_request', 'grant_type is required.');
    const client = await this.authenticateClient(t, form, authorization);
    if (!(GRANTS as readonly string[]).includes(grantType)) throw new OAuthError(400, 'unsupported_grant_type', `Unsupported grant type ${grantType}.`);
    if (!client.grants.includes(grantType as Grant)) throw new OAuthError(400, 'unauthorized_client', 'This client may not use that grant type.');
    let jkt: string | null = null;
    if (dpop?.proof !== undefined) {
      try {
        jkt = await this.checkDpop(dpop);
      } catch (err) {
        if (err instanceof DpopNonceError) throw new OAuthError(400, 'use_dpop_nonce', err.message, { 'DPoP-Nonce': this.dpopNonce() });
        throw new OAuthError(400, 'invalid_dpop_proof', (err as Error).message);
      }
    } else if (client.dpop_required) throw new OAuthError(400, 'invalid_dpop_proof', 'This client must send a DPoP proof.');
    switch (grantType) {
      case 'authorization_code':
        return this.codeGrant(t, client, form, jkt);
      case 'refresh_token':
        return this.refreshGrant(t, client, form, jkt);
      case 'client_credentials':
        return this.clientCredentials(t, client, form, jkt);
      case DEVICE_GRANT:
        return this.deviceGrant(t, client, form, jkt);
      default:
        return this.exchangeGrant(t, client, form, jkt);
    }
  }

  private async codeGrant(t: TenantCtx, client: ClientRow, form: Record<string, string>, jkt: string | null) {
    const code = form.code;
    if (!code) throw new OAuthError(400, 'invalid_request', 'code is required.');
    const id = this.digest('code', code);
    const row = (await this.db('oidc_codes').where({ id, tenant_id: t.id }).first()) as Record<string, unknown> | undefined;
    if (!row) throw new OAuthError(400, 'invalid_grant', 'Unknown authorization code.');
    if (row.used_at != null) {
      // A replayed code: revoke whatever it produced (RFC 6749 4.1.2).
      if (row.family_id) await this.revokeFamily(t.id, String(row.family_id));
      throw new OAuthError(400, 'invalid_grant', 'The authorization code was already used.');
    }
    if (Number(row.expires_at) < Date.now()) throw new OAuthError(400, 'invalid_grant', 'The authorization code has expired.');
    if (row.client_id !== client.client_id) throw new OAuthError(400, 'invalid_grant', 'The code was issued to another client.');
    if (form.redirect_uri !== row.redirect_uri) throw new OAuthError(400, 'invalid_grant', 'redirect_uri does not match the authorization request.');
    if (row.code_challenge) {
      const verifier = form.code_verifier;
      if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !safeEqual(pkceChallenge(verifier), String(row.code_challenge))) throw new OAuthError(400, 'invalid_grant', 'The PKCE code verifier does not match.');
    } else if (form.code_verifier) throw new OAuthError(400, 'invalid_grant', 'No code challenge was sent with the authorization request.');
    const claimed = await this.db('oidc_codes').where({ id, used_at: null }).update({ used_at: Date.now() });
    if (!claimed) throw new OAuthError(400, 'invalid_grant', 'The authorization code was already used.');
    const userId = String(row.user_id);
    if (!(await this.userActive(t.id, userId))) throw new OAuthError(400, 'invalid_grant', 'The user is disabled.');
    const [amr, method] = String(row.amr).split('|');
    const familyId = ulid();
    await this.db('oidc_codes').where({ id }).update({ family_id: familyId });
    const response = await this.mint(t, client, { userId, scopes: String(row.scopes).split(' ').filter(Boolean), nonce: row.nonce as string | null, authTime: Number(row.auth_time), amr: (amr ?? 'pwd').split(' '), method: method ?? '', sessionId: (row.session_id as string | null) ?? null, familyId, refresh: true, dpopJkt: jkt });
    return { response, client, userId, grant: 'authorization_code' };
  }

  private async sessionRevoked(sessionId: string | null): Promise<boolean> {
    if (!sessionId) return false;
    const r = (await this.db('sessions').where({ id: sessionId }).first('revoked_at')) as { revoked_at: number | null } | undefined;
    return !r || r.revoked_at != null;
  }

  private async refreshGrant(t: TenantCtx, client: ClientRow, form: Record<string, string>, jkt: string | null) {
    const token = form.refresh_token;
    if (!token) throw new OAuthError(400, 'invalid_request', 'refresh_token is required.');
    const id = this.digest('refresh', token);
    const raw = (await this.db('oidc_refresh_tokens').where({ id, tenant_id: t.id }).first()) as Record<string, unknown> | undefined;
    if (!raw) throw new OAuthError(400, 'invalid_grant', 'Unknown refresh token.');
    const row = { ...(raw as unknown as RefreshRow), used_at: num(raw.used_at), revoked_at: num(raw.revoked_at), expires_at: Number(raw.expires_at), family_created_at: Number(raw.family_created_at), auth_time: Number(raw.auth_time), dpop_jkt: (raw.dpop_jkt as string | null) ?? null };
    if (row.client_id !== client.client_id) throw new OAuthError(400, 'invalid_grant', 'The token was issued to another client.');
    // A refresh token issued with a DPoP proof only refreshes with a proof from the same key (RFC 9449 5).
    if (row.dpop_jkt && row.dpop_jkt !== jkt) throw new OAuthError(400, 'invalid_dpop_proof', 'This refresh token is bound to a DPoP key; send a proof made with that key.');
    if (row.revoked_at != null) throw new OAuthError(400, 'invalid_grant', 'The grant was revoked.');
    if (row.used_at != null) {
      // Reuse of a rotated token means it was copied: end the whole family (RFC 9700 4.14.2).
      await this.revokeFamily(t.id, row.family_id);
      await this.s().audit.append({ tenantId: t.id, action: 'oidc.refresh.reused', kind: 'auth', actor: { user: row.user_id, service: client.client_id }, target: { client: client.client_id, family: row.family_id }, detail: { note: 'A rotated refresh token was presented again; the grant was revoked.' } });
      throw new OAuthError(400, 'invalid_grant', 'The refresh token was already used; the grant has been revoked.');
    }
    if (row.expires_at < Date.now()) throw new OAuthError(400, 'invalid_grant', 'The refresh token has expired.');
    if (!(await this.userActive(t.id, row.user_id))) throw new OAuthError(400, 'invalid_grant', 'The user is disabled.');
    if (await this.sessionRevoked(row.session_id)) {
      await this.revokeFamily(t.id, row.family_id);
      throw new OAuthError(400, 'invalid_grant', 'The sign-in session behind this grant was revoked.');
    }
    const claimed = await this.db('oidc_refresh_tokens').where({ id, used_at: null, revoked_at: null }).update({ used_at: Date.now() });
    if (!claimed) {
      await this.revokeFamily(t.id, row.family_id);
      throw new OAuthError(400, 'invalid_grant', 'The refresh token was already used; the grant has been revoked.');
    }
    let scopes = row.scopes.split(' ').filter(Boolean);
    const narrowed = parseScope(form.scope);
    if (narrowed.length) {
      if (narrowed.some((x) => !scopes.includes(x))) throw new OAuthError(400, 'invalid_scope', 'A refresh cannot add scopes.');
      scopes = narrowed;
    }
    // Scopes are re-intersected with the user's current roles, so a removed role takes effect at the next refresh.
    scopes = grantScopes(scopes, client.scopes, permissionsFor(await this.s().users.roleIds(row.user_id)));
    const response = await this.mint(t, client, { userId: row.user_id, scopes, authTime: row.auth_time, amr: row.amr.split(' '), method: row.method, sessionId: row.session_id, familyId: row.family_id, familyCreatedAt: row.family_created_at, refresh: true, dpopJkt: row.dpop_jkt ?? jkt });
    return { response, client, userId: row.user_id, grant: 'refresh_token' };
  }

  private async clientCredentials(t: TenantCtx, client: ClientRow, form: Record<string, string>, jkt: string | null) {
    if (!isConfidential(client)) throw new OAuthError(400, 'unauthorized_client', 'Public clients cannot use client credentials.');
    if (!client.service_user_id) throw new OAuthError(400, 'unauthorized_client', 'This client has no service account.');
    if (!(await this.userActive(t.id, client.service_user_id))) throw new OAuthError(400, 'invalid_grant', 'The service account is disabled.');
    const requested = parseScope(form.scope);
    const perms = permissionsFor(await this.s().users.roleIds(client.service_user_id));
    const scopes = grantScopes(requested.length ? requested : expandAllowed(client.scopes), client.scopes, perms).filter((x) => x !== 'openid' && x !== 'offline_access');
    if (requested.length && !scopes.length) throw new OAuthError(400, 'invalid_scope', 'None of the requested scopes is allowed.');
    const response = await this.mint(t, client, { userId: client.service_user_id, scopes, authTime: null, amr: [], method: 'client credentials', sessionId: null, audience: form.audience ?? form.resource ?? null, refresh: false, dpopJkt: jkt });
    return { response, client, userId: client.service_user_id, grant: 'client_credentials' };
  }

  /** RFC 8693: exchanges an access token from this issuer for a narrower one naming this client as the actor. */
  private async exchangeGrant(t: TenantCtx, client: ClientRow, form: Record<string, string>, jkt: string | null) {
    if (!isConfidential(client)) throw new OAuthError(400, 'unauthorized_client', 'Token exchange needs a confidential client.');
    if (form.subject_token_type !== 'urn:ietf:params:oauth:token-type:access_token' || !form.subject_token) throw new OAuthError(400, 'invalid_request', 'subject_token must be an access token from this issuer.');
    let subject: Claims;
    try {
      subject = await this.verifyAccessToken(t, form.subject_token);
    } catch (err) {
      throw new OAuthError(400, 'invalid_grant', (err as Error).message);
    }
    const had = String(subject.scope ?? '').split(' ').filter(Boolean);
    const requested = parseScope(form.scope);
    const perms = permissionsFor(await this.s().users.roleIds(String(subject.sub)));
    const scopes = grantScopes(requested.length ? requested : had, client.scopes, perms).filter((x) => had.includes(x) && x !== 'openid' && x !== 'offline_access');
    if (!scopes.length) throw new OAuthError(400, 'invalid_scope', 'The exchanged token would carry no scope.');
    const act: Claims = { sub: client.client_id, ...(subject.act ? { act: subject.act } : {}) };
    const response = await this.mint(t, client, { userId: String(subject.sub), scopes, authTime: typeof subject.auth_time === 'number' ? subject.auth_time * 1000 : null, amr: [], method: 'token exchange', sessionId: null, audience: form.audience ?? form.resource ?? null, act, refresh: false, dpopJkt: jkt });
    response.issued_token_type = 'urn:ietf:params:oauth:token-type:access_token';
    return { response, client, userId: String(subject.sub), grant: 'token_exchange' };
  }

  // ---------- device authorization (RFC 8628) ----------

  async deviceAuthorization(t: TenantCtx, form: Record<string, string>, authorization: string | undefined): Promise<Record<string, unknown>> {
    const client = await this.authenticateClient(t, form, authorization);
    if (!client.grants.includes(DEVICE_GRANT)) throw new OAuthError(400, 'unauthorized_client', 'This client may not use the device authorization grant.');
    return this.issueDeviceCode(t, client, parseScope(form.scope));
  }

  async issueDeviceCode(t: TenantCtx, client: ClientRow, requested: string[]): Promise<Record<string, unknown>> {
    const scopes = requested.filter((x) => isKnownScope(x) && !x.endsWith(':*'));
    if (!scopes.length) throw new OAuthError(400, 'invalid_scope', 'Request at least one scope.');
    const cfg = this.s().cfg;
    const deviceCode = randomToken(32);
    let userCode = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      userCode = Array.from({ length: 8 }, () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]).join('');
      if (!(await this.db('oidc_device_codes').where({ user_code: userCode }).first())) break;
    }
    const t0 = Date.now();
    await this.db('oidc_device_codes').insert({ id: this.digest('device', deviceCode), user_code: userCode, tenant_id: t.id, client_id: client.client_id, scopes: scopes.join(' '), status: 'pending', user_id: null, session_id: null, amr: null, interval: cfg.DEVICE_POLL_SECONDS, last_polled_at: null, expires_at: t0 + cfg.DEVICE_CODE_MINUTES * 60_000, created_at: t0 });
    return {
      device_code: deviceCode,
      user_code: formatUserCode(userCode),
      verification_uri: `${t.issuer}/device`,
      verification_uri_complete: `${t.issuer}/device?user_code=${formatUserCode(userCode)}`,
      expires_in: cfg.DEVICE_CODE_MINUTES * 60,
      interval: cfg.DEVICE_POLL_SECONDS
    };
  }

  /** The pending device request behind a user code, for the approval page. */
  async deviceLookup(tenantId: string, userCode: string): Promise<{ id: string; client: ClientRow; scopes: string[]; expiresAt: number } | null> {
    const code = normaliseUserCode(userCode);
    if (code.length !== 8) return null;
    const row = (await this.db('oidc_device_codes').where({ user_code: code, tenant_id: tenantId }).first()) as Record<string, unknown> | undefined;
    if (!row || row.status !== 'pending' || Number(row.expires_at) < Date.now()) return null;
    const client = await this.byClientId(tenantId, String(row.client_id));
    if (!client || client.status !== 'active') return null;
    return { id: String(row.id), client, scopes: String(row.scopes).split(' '), expiresAt: Number(row.expires_at) };
  }

  async deviceDecide(tenantId: string, userCode: string, user: SignedInUser, approve: boolean): Promise<{ client: ClientRow; scopes: string[] } | null> {
    const found = await this.deviceLookup(tenantId, userCode);
    if (!found) return null;
    const scopes = approve ? await this.grantableScopes(tenantId, user.userId, found.client, found.scopes) : found.scopes;
    const n = await this.db('oidc_device_codes')
      .where({ id: found.id, status: 'pending' })
      .update(approve ? { status: 'approved', user_id: user.userId, session_id: user.sessionId, amr: amrFor(user.method).join(' ') + '|' + user.method.slice(0, 100), scopes: scopes.join(' ') } : { status: 'denied' });
    return n ? { client: found.client, scopes } : null;
  }

  private async deviceGrant(t: TenantCtx, client: ClientRow, form: Record<string, string>, jkt: string | null) {
    if (!form.device_code) throw new OAuthError(400, 'invalid_request', 'device_code is required.');
    const id = this.digest('device', form.device_code);
    const row = (await this.db('oidc_device_codes').where({ id, tenant_id: t.id }).first()) as Record<string, unknown> | undefined;
    if (!row || row.client_id !== client.client_id) throw new OAuthError(400, 'invalid_grant', 'Unknown device code.');
    const now = Date.now();
    if (Number(row.expires_at) < now) throw new OAuthError(400, 'expired_token', 'The device code has expired. Start again.');
    const interval = Number(row.interval);
    const last = num(row.last_polled_at);
    await this.db('oidc_device_codes').where({ id }).update({ last_polled_at: now });
    if (row.status === 'pending' && last != null && now - last < interval * 1000) {
      await this.db('oidc_device_codes').where({ id }).update({ interval: interval + 5 });
      throw new OAuthError(400, 'slow_down', `Poll at most every ${interval + 5} seconds.`);
    }
    if (row.status === 'pending') throw new OAuthError(400, 'authorization_pending', 'The user has not approved the request yet.');
    if (row.status === 'denied') throw new OAuthError(400, 'access_denied', 'The user denied the request.');
    if (row.status !== 'approved') throw new OAuthError(400, 'invalid_grant', 'The device code was already used.');
    const claimed = await this.db('oidc_device_codes').where({ id, status: 'approved' }).update({ status: 'used' });
    if (!claimed) throw new OAuthError(400, 'invalid_grant', 'The device code was already used.');
    const userId = String(row.user_id);
    if (!(await this.userActive(t.id, userId))) throw new OAuthError(400, 'invalid_grant', 'The user is disabled.');
    const [amr, method] = String(row.amr ?? 'pwd|').split('|');
    const response = await this.mint(t, client, { userId, scopes: String(row.scopes).split(' ').filter(Boolean), authTime: now, amr: (amr ?? 'pwd').split(' '), method: `device code, ${method ?? ''}`, sessionId: (row.session_id as string | null) ?? null, refresh: true, dpopJkt: jkt });
    return { response, client, userId, grant: 'device_code' };
  }

  // ---------- verification, userinfo, revocation, introspection ----------

  /** Access-token checks that passed recently, per jti; cleared on every denial (DENIED_TOPIC, from any instance). */
  private readonly checked = new Map<string, number>();

  /** Drops the cached checks: a token or grant was just denied somewhere. */
  forgetChecks(): void {
    this.checked.clear();
  }

  /**
   * Is this access token on the deny-list (RFC 7009 revocation of this token) or older than a revocation of the
   * user's grant to its client? The deny-list is in the database, shared by every instance; a short per-instance cache
   * of passed checks is cleared through the bus when anything is denied.
   */
  private async denied(tenantId: string, claims: Claims): Promise<boolean> {
    const jti = String(claims.jti ?? '');
    const hit = this.checked.get(jti);
    if (jti && hit && hit > Date.now()) return false;
    const ids = [`jti:${jti}`, `grant:${String(claims.sub)}:${String(claims.client_id)}`];
    const rows = (await this.db('oidc_denied').where({ tenant_id: tenantId }).whereIn('id', ids).select('id', 'created_at')) as { id: string; created_at: number }[];
    const iatMs = typeof claims.iat === 'number' ? claims.iat * 1000 : 0;
    const out = rows.some((r) => r.id.startsWith('jti:') || iatMs <= Number(r.created_at));
    if (!out && jti) {
      if (this.checked.size > 10_000) this.checked.clear();
      this.checked.set(jti, Date.now() + 15_000);
    }
    return out;
  }

  /** Adds a deny-list entry, kept until every token it could refuse has expired, and tells every instance. */
  private async deny(tenantId: string, id: string, expiresAt: number): Promise<void> {
    const t = Date.now();
    const n = await this.db('oidc_denied').where({ id }).update({ created_at: t, expires_at: expiresAt });
    if (!n) {
      try {
        await this.db('oidc_denied').insert({ id, tenant_id: tenantId, created_at: t, expires_at: expiresAt });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    this.forgetChecks();
    this.s().bus.publish(DENIED_TOPIC, { tenantId });
  }

  /** Verifies an access token from this issuer and that its client, user and grant are still live and it is not revoked. */
  async verifyAccessToken(t: TenantCtx, token: string): Promise<Claims> {
    const claims = verifyJwt(token, (await this.keys.jwks(t.id)).keys, { issuer: t.issuer, algs: ['ES256'], typ: 'at+jwt' });
    if (claims.tid !== t.id) throw new JwtError('The token belongs to another tenant.');
    const client = await this.byClientId(t.id, String(claims.client_id));
    if (!client || client.status !== 'active') throw new JwtError('The client is disabled.');
    if (!(await this.userActive(t.id, String(claims.sub)))) throw new JwtError('The user is disabled.');
    if (claims.sid) {
      const live = await this.db('oidc_refresh_tokens').where({ family_id: String(claims.sid) }).whereNotNull('revoked_at').first();
      if (live) throw new JwtError('The grant was revoked.');
    }
    if (await this.denied(t.id, claims)) throw new JwtError('The token was revoked.');
    return claims;
  }

  /**
   * The sender constraint for a resource request (RFC 9449 7): a DPoP-bound token needs the DPoP scheme and a proof
   * from its key for this request; an unbound token is a bearer token and must not be sent as DPoP.
   */
  async checkBinding(claims: Claims, token: string, scheme: 'bearer' | 'dpop', dpop: DpopInput): Promise<void> {
    const jkt = (claims.cnf as { jkt?: unknown } | undefined)?.jkt;
    if (typeof jkt !== 'string') {
      if (scheme === 'dpop') throw new JwtError('This token is not DPoP-bound; send it as a Bearer token.');
      return;
    }
    if (scheme !== 'dpop') throw new JwtError('This token is DPoP-bound; send it with the DPoP scheme and a proof.');
    if ((await this.checkDpop(dpop, token)) !== jkt) throw new JwtError('The DPoP proof was made with another key.');
  }

  async userinfo(t: TenantCtx, token: string, binding?: { scheme: 'bearer' | 'dpop'; dpop: DpopInput }): Promise<Claims> {
    const claims = await this.verifyAccessToken(t, token);
    if (binding) await this.checkBinding(claims, token, binding.scheme, binding.dpop);
    const scopes = String(claims.scope ?? '').split(' ');
    if (!scopes.includes('openid')) throw new JwtError('The token was not issued with the openid scope.');
    return { sub: claims.sub, tenant: t.slug, ...(await this.identityClaims(t.id, String(claims.sub), scopes)) };
  }

  /** A refresh token row by its value, when it belongs to this tenant. */
  private async refreshRow(tenantId: string, token: string): Promise<RefreshRow | undefined> {
    if (!token || token.length > 200) return undefined;
    const r = (await this.db('oidc_refresh_tokens').where({ id: this.digest('refresh', token), tenant_id: tenantId }).first()) as Record<string, unknown> | undefined;
    return r ? ({ ...(r as unknown as RefreshRow), used_at: num(r.used_at), revoked_at: num(r.revoked_at), expires_at: Number(r.expires_at), created_at: Number(r.created_at) } as RefreshRow) : undefined;
  }

  /**
   * RFC 7009: revokes a refresh token (and its family), or puts an access token on the deny-list so it is refused at
   * once everywhere, before it expires. Only the client the token was issued to may revoke it; anything else
   * (unknown, expired, another client's) answers 200 without effect (2.2).
   */
  async revoke(t: TenantCtx, form: Record<string, string>, authorization: string | undefined): Promise<{ client: ClientRow; revoked: 'refresh_token' | 'access_token' | null }> {
    const client = await this.authenticateClient(t, form, authorization);
    const token = form.token ?? '';
    const tryRefresh = async () => {
      const row = await this.refreshRow(t.id, token);
      if (row && row.client_id === client.client_id) {
        await this.revokeFamily(t.id, row.family_id);
        return true;
      }
      return false;
    };
    const tryAccess = async () => {
      let claims: Claims;
      try {
        claims = verifyJwt(token, (await this.keys.jwks(t.id)).keys, { issuer: t.issuer, algs: ['ES256'], typ: 'at+jwt', allowExpired: true });
      } catch {
        return false;
      }
      if (claims.client_id !== client.client_id || claims.tid !== t.id || typeof claims.jti !== 'string' || typeof claims.exp !== 'number') return false;
      if (claims.exp * 1000 + 60_000 > Date.now()) await this.deny(t.id, `jti:${claims.jti}`, claims.exp * 1000 + 60_000);
      return true;
    };
    // token_type_hint only orders the lookups (2.1).
    if (form.token_type_hint === 'access_token') {
      if (await tryAccess()) return { client, revoked: 'access_token' };
      if (await tryRefresh()) return { client, revoked: 'refresh_token' };
    } else {
      if (await tryRefresh()) return { client, revoked: 'refresh_token' };
      if (await tryAccess()) return { client, revoked: 'access_token' };
    }
    return { client, revoked: null };
  }

  /** Sets who a client may introspect for (B-806); widening to `any` is applied only by an approved proposal. */
  async setIntrospect(tenantId: string, id: string, mode: 'own' | 'any'): Promise<void> {
    await this.db('oidc_clients').where({ tenant_id: tenantId, id }).update({ introspect: mode, updated_at: Date.now() });
  }

  /**
   * RFC 7662: token introspection for confidential clients. A token is active only for the client it was issued to;
   * another client's tokens, and anything revoked, expired or unknown, introspect as `{active: false}`. A registered
   * resource server (`introspect: any`, B-806) may introspect every client's access tokens in its tenant; refresh
   * tokens stay visible to their own client only.
   */
  async introspect(t: TenantCtx, form: Record<string, string>, authorization: string | undefined): Promise<{ client: ClientRow; response: Record<string, unknown> }> {
    const client = await this.authenticateClient(t, form, authorization);
    if (!isConfidential(client)) throw new OAuthError(401, 'invalid_client', 'Only confidential clients may introspect tokens.');
    const token = form.token ?? '';
    const inactive = { client, response: { active: false } };
    const refresh = async () => {
      const row = await this.refreshRow(t.id, token);
      if (!row || row.client_id !== client.client_id || row.revoked_at != null || row.used_at != null || row.expires_at < Date.now()) return null;
      if (!(await this.userActive(t.id, row.user_id)) || (await this.sessionRevoked(row.session_id))) return null;
      const user = await this.s().users.get(t.id, row.user_id);
      return { active: true, token_type: 'refresh_token', scope: row.scopes, client_id: row.client_id, sub: row.user_id, username: user?.username, iss: t.issuer, iat: Math.floor(row.created_at / 1000), exp: Math.floor(row.expires_at / 1000), tenant: t.slug };
    };
    const access = async () => {
      let claims: Claims;
      try {
        claims = await this.verifyAccessToken(t, token);
      } catch {
        return null;
      }
      if (claims.client_id !== client.client_id && client.introspect !== 'any') return null;
      const user = await this.s().users.get(t.id, String(claims.sub));
      const cnf = claims.cnf as { jkt?: string } | undefined;
      return { active: true, token_type: cnf?.jkt ? 'DPoP' : 'Bearer', scope: claims.scope, client_id: claims.client_id, sub: claims.sub, username: user?.username, iss: claims.iss, aud: claims.aud, iat: claims.iat, exp: claims.exp, jti: claims.jti, ...(cnf?.jkt ? { cnf: { jkt: cnf.jkt } } : {}), ...(claims.auth_time ? { auth_time: claims.auth_time } : {}), ...(claims.act ? { act: claims.act } : {}), tenant: t.slug };
    };
    const order = form.token_type_hint === 'refresh_token' ? [refresh, access] : [access, refresh];
    for (const f of order) {
      const r = await f();
      if (r) return { client, response: r };
    }
    return inactive;
  }

  // ---------- the user's own grants (Settings, B-107) ----------

  /** The clients a user has consented to or holds live tokens for, with what they may do. */
  async userGrants(tenantId: string, userId: string): Promise<{ clientId: string; name: string; type: ClientType; scopes: string[]; consentedAt: number | null; consentExpiresAt: number | null; activeGrants: number; lastUsedAt: number | null; createdAt: number | null }[]> {
    const now = Date.now();
    const consents = (await this.db('oidc_consents').where({ tenant_id: tenantId, user_id: userId })) as { client_id: string; scopes: string; granted_at: number; expires_at: number | null }[];
    const refresh = (await this.db('oidc_refresh_tokens').where({ tenant_id: tenantId, user_id: userId, revoked_at: null, used_at: null }).andWhere('expires_at', '>', now)) as { client_id: string; family_id: string; scopes: string; family_created_at: number; created_at: number }[];
    const ids = [...new Set([...consents.filter((c) => c.expires_at == null || Number(c.expires_at) > now).map((c) => c.client_id), ...refresh.map((r) => r.client_id)])];
    const out = [];
    for (const id of ids) {
      const client = await this.byClientId(tenantId, id);
      if (!client) continue;
      const consent = consents.find((c) => c.client_id === id);
      const mine = refresh.filter((r) => r.client_id === id);
      const scopes = new Set([...(consent ? consent.scopes.split(' ') : []), ...mine.flatMap((r) => r.scopes.split(' '))].filter(Boolean));
      out.push({
        clientId: id,
        name: client.name,
        type: client.type,
        scopes: [...scopes].sort(),
        consentedAt: consent ? Number(consent.granted_at) : null,
        consentExpiresAt: consent?.expires_at != null ? Number(consent.expires_at) : null,
        activeGrants: new Set(mine.map((r) => r.family_id)).size,
        lastUsedAt: mine.length ? Math.max(...mine.map((r) => Number(r.created_at))) : null,
        createdAt: mine.length ? Math.min(...mine.map((r) => Number(r.family_created_at))) : consent ? Number(consent.granted_at) : null
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Revokes everything a user granted a client: the remembered consent, every refresh-token family, and (through
   * the deny-list) every access token issued before now, so all of them stop working at once (ASVS 3.5.1).
   */
  async revokeUserGrant(tenantId: string, userId: string, clientId: string): Promise<{ consents: number; refreshTokens: number }> {
    const consents = await this.db('oidc_consents').where({ tenant_id: tenantId, user_id: userId, client_id: clientId }).delete();
    const refreshTokens = await this.db('oidc_refresh_tokens').where({ tenant_id: tenantId, user_id: userId, client_id: clientId, revoked_at: null }).update({ revoked_at: Date.now() });
    await this.deny(tenantId, `grant:${userId}:${clientId}`, Date.now() + MAX_ACCESS_MS);
    await this.db('oidc_rp_sessions').where({ tenant_id: tenantId, user_id: userId, client_id: clientId, ended_at: null }).update({ ended_at: Date.now() });
    return { consents, refreshTokens };
  }

  // ---------- logout (OpenID Connect RP-initiated, front-channel, back-channel) ----------

  /**
   * Checks an end-session request: `id_token_hint` (an ID token from this issuer, possibly expired) names the
   * client and user; `post_logout_redirect_uri` must be registered exactly for that client.
   */
  async checkLogout(t: TenantCtx, q: Record<string, unknown>): Promise<{ client: ClientRow | null; userId: string | null; sid: string | null; redirect: string | null; state: string | null }> {
    const str = (k: string): string | null => (typeof q[k] === 'string' && (q[k] as string).length <= 8000 ? (q[k] as string) : null);
    let claims: Claims | null = null;
    const hint = str('id_token_hint');
    if (hint) {
      try {
        claims = verifyJwt(hint, (await this.keys.jwks(t.id)).keys, { issuer: t.issuer, algs: ['ES256'], allowExpired: true });
      } catch (err) {
        throw new AuthorizeError('invalid_request', `The id_token_hint was refused: ${(err as Error).message}`, false);
      }
      if (claims.tid !== t.id || typeof claims.aud !== 'string') throw new AuthorizeError('invalid_request', 'The id_token_hint is not an ID token from this tenant.', false);
    }
    const clientId = str('client_id') ?? (claims ? String(claims.aud) : null);
    if (claims && clientId !== claims.aud) throw new AuthorizeError('invalid_request', 'client_id does not match the id_token_hint.', false);
    const client = clientId ? ((await this.byClientId(t.id, clientId)) ?? null) : null;
    if (clientId && !client) throw new AuthorizeError('invalid_request', 'Unknown client.', false);
    const redirect = str('post_logout_redirect_uri');
    if (redirect && (!client || !client.post_logout_redirect_uris.includes(redirect))) throw new AuthorizeError('invalid_request', 'The post-logout redirect URI is not registered for this client.', false);
    return { client, userId: claims ? String(claims.sub) : null, sid: claims && typeof claims.sid === 'string' ? claims.sid : null, redirect, state: str('state') };
  }

  /** Front-channel logout URLs (with iss and sid) of the clients a session signed in to. */
  async frontChannelUrls(t: TenantCtx, sessionId: string): Promise<string[]> {
    const rows = (await this.db('oidc_rp_sessions').where({ tenant_id: t.id, session_id: sessionId })) as { client_id: string; sid: string }[];
    const out: string[] = [];
    for (const r of rows) {
      const client = await this.byClientId(t.id, r.client_id);
      if (!client || client.status !== 'active' || !client.frontchannel_logout_uri) continue;
      const u = new URL(client.frontchannel_logout_uri);
      u.searchParams.set('iss', t.issuer);
      u.searchParams.set('sid', r.sid);
      out.push(u.toString());
    }
    return out;
  }

  /**
   * A sign-in session ended (sign-out, revocation, disabled user, offboarding): its refresh tokens end, and each
   * client it signed in to with a back-channel logout URI gets a logout token, delivered by a job with retries. Every
   * instance hears the revocation; the update below lets exactly one of them enqueue each delivery.
   */
  async sessionsEnded(sessionIds: string[]): Promise<number> {
    if (!sessionIds.length) return 0;
    let queued = 0;
    const rows = (await this.db('oidc_rp_sessions').whereIn('session_id', sessionIds).whereNull('ended_at')) as { id: string; tenant_id: string; session_id: string; user_id: string; client_id: string; sid: string }[];
    for (const r of rows) {
      if (!(await this.db('oidc_rp_sessions').where({ id: r.id, ended_at: null }).update({ ended_at: Date.now() }))) continue;
      await this.revokeForSession(r.tenant_id, r.session_id);
      const client = await this.byClientId(r.tenant_id, r.client_id);
      if (!client?.backchannel_logout_uri || client.status !== 'active') continue;
      await this.s().jobs.enqueue({ tenantId: r.tenant_id, type: 'federation.backchannel', payload: { clientId: r.client_id, userId: r.user_id, sid: r.sid }, dedupeKey: `bcl:${r.sid}:${r.client_id}`, maxAttempts: 4 });
      queued++;
    }
    return queued;
  }

  /** A signed logout token (OIDC Back-Channel Logout 2.4): events claim, sid and sub, no nonce, two minutes. */
  async logoutToken(t: TenantCtx, clientId: string, userId: string, sid: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return signJwtWith({ iss: t.issuer, aud: clientId, iat: now, exp: now + 120, jti: ulid(), sub: userId, sid, events: { [BACKCHANNEL_EVENT]: {} }, tenant: t.slug, tid: t.id }, await this.keys.signer(t.id), 'logout+jwt');
  }

  async revokeFamily(tenantId: string, familyId: string): Promise<number> {
    return this.db('oidc_refresh_tokens').where({ tenant_id: tenantId, family_id: familyId, revoked_at: null }).update({ revoked_at: Date.now() });
  }

  async revokeForSession(tenantId: string, sessionId: string): Promise<number> {
    return this.db('oidc_refresh_tokens').where({ tenant_id: tenantId, session_id: sessionId, revoked_at: null }).update({ revoked_at: Date.now() });
  }

  /** Live OAuth grants (refresh families) in a tenant, newest first, for the Sessions tab. */
  async grants(tenantId: string): Promise<{ familyId: string; userId: string; clientId: string; method: string; createdAt: number; lastUsedAt: number; expiresAt: number }[]> {
    const rows = (await this.db('oidc_refresh_tokens').where({ tenant_id: tenantId, revoked_at: null, used_at: null }).andWhere('expires_at', '>', Date.now()).orderBy('created_at', 'desc').limit(500)) as Record<string, unknown>[];
    return rows.map((r) => ({ familyId: String(r.family_id), userId: String(r.user_id), clientId: String(r.client_id), method: String(r.method), createdAt: Number(r.family_created_at), lastUsedAt: Number(r.created_at), expiresAt: Number(r.expires_at) }));
  }

  /** Deletes expired codes, device codes and refresh tokens. */
  async purge(): Promise<number> {
    const cutoff = Date.now() - 86_400_000;
    let n = await this.db('oidc_codes').where('expires_at', '<', cutoff).delete();
    n += await this.db('oidc_device_codes').where('expires_at', '<', cutoff).delete();
    n += await this.db('oidc_refresh_tokens').where('expires_at', '<', cutoff).delete();
    n += await this.db('federation_pending').where('expires_at', '<', Date.now()).delete();
    n += await this.db('oidc_denied').where('expires_at', '<', Date.now()).delete();
    n += await this.db('oauth_replay').where('expires_at', '<', Date.now()).delete();
    n += await this.db('oidc_rp_sessions').where('ended_at', '<', cutoff).delete();
    n += await this.db('saml_sessions').where('ended_at', '<', cutoff).delete();
    return n;
  }
}
