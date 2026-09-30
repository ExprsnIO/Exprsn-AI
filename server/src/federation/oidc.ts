import { randomBytes, randomInt } from 'node:crypto';
import { ulid } from 'ulid';
import { json } from '../db/knex.js';
import { hmac, randomToken, safeEqual } from '../crypto/index.js';
import { permissionsFor } from '../authz/permissions.js';
import type { Services } from '../services.js';
import type { SigningKeys } from './keys.js';
import { decodeJwt, halfHash, JwtError, pkceChallenge, signJwt, verifyJwt, type Claims } from './jose.js';
import { expandAllowed, grantScopes, isKnownScope, parseScope } from './scopes.js';

export const CLIENT_TYPES = ['first_party', 'public', 'service', 'third_party'] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];
export const GRANTS = ['authorization_code', 'refresh_token', 'client_credentials', 'urn:ietf:params:oauth:grant-type:device_code', 'urn:ietf:params:oauth:grant-type:token-exchange'] as const;
export type Grant = (typeof GRANTS)[number];
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
export const EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';

/** An OAuth error for the token, device and revocation endpoints (RFC 6749 5.2): JSON `{error, error_description}`. */
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
  token_type: 'Bearer';
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
      device_authorization_endpoint: `${b}/oauth/device_authorization`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: [...GRANTS],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['ES256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['openid', 'profile', 'email', 'groups', 'offline_access'],
      claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'auth_time', 'nonce', 'amr', 'azp', 'at_hash', 'name', 'preferred_username', 'email', 'groups', 'roles', 'clearance', 'tenant'],
      prompt_values_supported: ['none', 'login', 'consent'],
      request_parameter_supported: false,
      claims_parameter_supported: false
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
    input: { name: string; type: ClientType; redirectUris: string[]; grants: Grant[]; scopes: string[]; pkceRequired: boolean; accessTtl: number; refreshTtl: number; models: string | null; serviceUserId: string | null },
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
      status: 'active',
      created_by: createdBy,
      last_used_at: null,
      created_at: t,
      updated_at: t
    };
    await this.db('oidc_clients').insert(row);
    return { client: clientFromRow(row), secret };
  }

  async updateClient(tenantId: string, id: string, patch: { name?: string; redirectUris?: string[]; scopes?: string[]; pkceRequired?: boolean; accessTtl?: number; models?: string | null; grants?: Grant[] }): Promise<ClientRow | undefined> {
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

  /** Validates an authorization request. Errors about the client or redirect URI must not redirect. */
  async validateAuthorize(t: TenantCtx, q: Record<string, unknown>): Promise<{ client: ClientRow; req: AuthzRequest }> {
    const str = (k: string): string | null => (typeof q[k] === 'string' && (q[k] as string).length <= 2000 ? (q[k] as string) : null);
    const clientId = str('client_id');
    const client = clientId ? await this.byClientId(t.id, clientId) : undefined;
    if (!client) throw new AuthorizeError('invalid_client', 'Unknown client.', false);
    if (client.status !== 'active') throw new AuthorizeError('invalid_client', 'This client is disabled.', false);
    const redirectUri = str('redirect_uri');
    // Exact string match: no wildcards, no prefix or path matching.
    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) throw new AuthorizeError('invalid_request', 'The redirect URI is not registered for this client.', false);
    if (!client.grants.includes('authorization_code')) throw new AuthorizeError('unauthorized_client', 'This client may not use the authorization code grant.', true);
    if (str('response_type') !== 'code') throw new AuthorizeError('unsupported_response_type', 'Only response_type=code is supported.', true);
    if (q.request !== undefined || q.request_uri !== undefined) throw new AuthorizeError('request_not_supported', 'Request objects are not supported.', true);
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
    return {
      client,
      req: { clientId: client.client_id, redirectUri, scopes, state: str('state'), nonce: str('nonce'), codeChallenge: challenge, prompt, audience: str('audience') ?? str('resource') }
    };
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
    return code;
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
    grant: { userId: string; scopes: string[]; nonce?: string | null; authTime: number | null; amr: string[]; method: string; sessionId: string | null; audience?: string | null; act?: Claims; familyId?: string | null; familyCreatedAt?: number; refresh: boolean }
  ): Promise<TokenResponse> {
    const { row, key } = await this.keys.signer(t.id);
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
        revoked_at: null
      });
    }
    const access = signJwt(
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
        ...tenant
      },
      key,
      row.kid,
      'at+jwt'
    );
    const out: TokenResponse = { access_token: access, token_type: 'Bearer', expires_in: client.access_ttl, scope: grant.scopes.join(' ') };
    if (grant.scopes.includes('openid')) {
      out.id_token = signJwt(
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
          ...tenant,
          ...(await this.identityClaims(t.id, grant.userId, grant.scopes))
        },
        key,
        row.kid
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

  /** The token endpoint. */
  async token(t: TenantCtx, form: Record<string, string>, authorization: string | undefined): Promise<{ response: TokenResponse; client: ClientRow; userId: string; grant: string }> {
    const grantType = form.grant_type;
    if (!grantType) throw new OAuthError(400, 'invalid_request', 'grant_type is required.');
    const client = await this.authenticateClient(t, form, authorization);
    if (!(GRANTS as readonly string[]).includes(grantType)) throw new OAuthError(400, 'unsupported_grant_type', `Unsupported grant type ${grantType}.`);
    if (!client.grants.includes(grantType as Grant)) throw new OAuthError(400, 'unauthorized_client', 'This client may not use that grant type.');
    switch (grantType) {
      case 'authorization_code':
        return this.codeGrant(t, client, form);
      case 'refresh_token':
        return this.refreshGrant(t, client, form);
      case 'client_credentials':
        return this.clientCredentials(t, client, form);
      case DEVICE_GRANT:
        return this.deviceGrant(t, client, form);
      default:
        return this.exchangeGrant(t, client, form);
    }
  }

  private async codeGrant(t: TenantCtx, client: ClientRow, form: Record<string, string>) {
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
    const response = await this.mint(t, client, { userId, scopes: String(row.scopes).split(' ').filter(Boolean), nonce: row.nonce as string | null, authTime: Number(row.auth_time), amr: (amr ?? 'pwd').split(' '), method: method ?? '', sessionId: (row.session_id as string | null) ?? null, familyId, refresh: true });
    return { response, client, userId, grant: 'authorization_code' };
  }

  private async sessionRevoked(sessionId: string | null): Promise<boolean> {
    if (!sessionId) return false;
    const r = (await this.db('sessions').where({ id: sessionId }).first('revoked_at')) as { revoked_at: number | null } | undefined;
    return !r || r.revoked_at != null;
  }

  private async refreshGrant(t: TenantCtx, client: ClientRow, form: Record<string, string>) {
    const token = form.refresh_token;
    if (!token) throw new OAuthError(400, 'invalid_request', 'refresh_token is required.');
    const id = this.digest('refresh', token);
    const raw = (await this.db('oidc_refresh_tokens').where({ id, tenant_id: t.id }).first()) as Record<string, unknown> | undefined;
    if (!raw) throw new OAuthError(400, 'invalid_grant', 'Unknown refresh token.');
    const row = { ...(raw as unknown as RefreshRow), used_at: num(raw.used_at), revoked_at: num(raw.revoked_at), expires_at: Number(raw.expires_at), family_created_at: Number(raw.family_created_at), auth_time: Number(raw.auth_time) };
    if (row.client_id !== client.client_id) throw new OAuthError(400, 'invalid_grant', 'The token was issued to another client.');
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
    const response = await this.mint(t, client, { userId: row.user_id, scopes, authTime: row.auth_time, amr: row.amr.split(' '), method: row.method, sessionId: row.session_id, familyId: row.family_id, familyCreatedAt: row.family_created_at, refresh: true });
    return { response, client, userId: row.user_id, grant: 'refresh_token' };
  }

  private async clientCredentials(t: TenantCtx, client: ClientRow, form: Record<string, string>) {
    if (!isConfidential(client)) throw new OAuthError(400, 'unauthorized_client', 'Public clients cannot use client credentials.');
    if (!client.service_user_id) throw new OAuthError(400, 'unauthorized_client', 'This client has no service account.');
    if (!(await this.userActive(t.id, client.service_user_id))) throw new OAuthError(400, 'invalid_grant', 'The service account is disabled.');
    const requested = parseScope(form.scope);
    const perms = permissionsFor(await this.s().users.roleIds(client.service_user_id));
    const scopes = grantScopes(requested.length ? requested : expandAllowed(client.scopes), client.scopes, perms).filter((x) => x !== 'openid' && x !== 'offline_access');
    if (requested.length && !scopes.length) throw new OAuthError(400, 'invalid_scope', 'None of the requested scopes is allowed.');
    const response = await this.mint(t, client, { userId: client.service_user_id, scopes, authTime: null, amr: [], method: 'client credentials', sessionId: null, audience: form.audience ?? form.resource ?? null, refresh: false });
    return { response, client, userId: client.service_user_id, grant: 'client_credentials' };
  }

  /** RFC 8693: exchanges an access token from this issuer for a narrower one naming this client as the actor. */
  private async exchangeGrant(t: TenantCtx, client: ClientRow, form: Record<string, string>) {
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
    const response = await this.mint(t, client, { userId: String(subject.sub), scopes, authTime: typeof subject.auth_time === 'number' ? subject.auth_time * 1000 : null, amr: [], method: 'token exchange', sessionId: null, audience: form.audience ?? form.resource ?? null, act, refresh: false });
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

  private async deviceGrant(t: TenantCtx, client: ClientRow, form: Record<string, string>) {
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
    const response = await this.mint(t, client, { userId, scopes: String(row.scopes).split(' ').filter(Boolean), authTime: now, amr: (amr ?? 'pwd').split(' '), method: `device code, ${method ?? ''}`, sessionId: (row.session_id as string | null) ?? null, refresh: true });
    return { response, client, userId, grant: 'device_code' };
  }

  // ---------- verification, userinfo, revocation ----------

  /** Verifies an access token from this issuer and that its client, user and grant are still live. */
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
    return claims;
  }

  async userinfo(t: TenantCtx, token: string): Promise<Claims> {
    const claims = await this.verifyAccessToken(t, token);
    const scopes = String(claims.scope ?? '').split(' ');
    if (!scopes.includes('openid')) throw new JwtError('The token was not issued with the openid scope.');
    return { sub: claims.sub, tenant: t.slug, ...(await this.identityClaims(t.id, String(claims.sub), scopes)) };
  }

  /** RFC 7009: revokes a refresh token (and its family); access tokens are short-lived and end with their grant. */
  async revoke(t: TenantCtx, form: Record<string, string>, authorization: string | undefined): Promise<{ client: ClientRow; revoked: boolean }> {
    const client = await this.authenticateClient(t, form, authorization);
    const token = form.token ?? '';
    const row = (await this.db('oidc_refresh_tokens').where({ id: this.digest('refresh', token), tenant_id: t.id }).first()) as RefreshRow | undefined;
    if (row && row.client_id === client.client_id) {
      await this.revokeFamily(t.id, row.family_id);
      return { client, revoked: true };
    }
    // An access token: revoke the family it carries, when it verifies and belongs to this client.
    try {
      const { claims } = decodeJwt(token);
      if (claims.client_id === client.client_id && claims.sid) {
        await this.verifyAccessToken(t, token);
        await this.revokeFamily(t.id, String(claims.sid));
        return { client, revoked: true };
      }
    } catch {
      /* unknown tokens are not an error (RFC 7009 2.2) */
    }
    return { client, revoked: false };
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
    return n;
  }
}
