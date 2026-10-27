import { createSign } from 'node:crypto';
import { z } from 'zod';
import { badRequest, HttpProblem } from '../http/problem.js';

/*
 * 1.7.0 (B-9302): outside providers of leased API keys.
 *
 * A provider makes a key at an outside service and revokes it there when the lease ends. It never opens a connection
 * itself: `ProviderTarget.request` is the service's call through the outbound address guard (`guardedRequest`), and
 * `credential` reads the provider's admin credential from the vault as the person who registered it. A provider
 * returns the key once; what it needs to revoke the key later (`secret`) is kept sealed with the lease.
 *
 * The reference provider is `github`: installation access tokens of a GitHub App. The App's id and installation id
 * are the provider's configuration, its private key the admin credential. Nothing here is configured by the server:
 * a tenant without a registered provider has none, and no call leaves it.
 */

export interface ProviderResponse {
  status: number;
  /** The parsed JSON body, or null when there is none or it is not JSON. */
  body: unknown;
}

export interface ProviderTarget {
  tenantId: string;
  name: string;
  /** The provider's base URL, without a trailing slash. */
  endpoint: string;
  config: Record<string, unknown>;
  /** The admin credential behind the provider's vault reference. */
  credential(): Promise<string>;
  /** One request to `endpoint` + `path` through the egress guard. Redirects are not followed. */
  request(r: { method: 'GET' | 'POST' | 'DELETE'; path: string; headers: Record<string, string>; body?: unknown }): Promise<ProviderResponse>;
}

export interface IssuedKey {
  /** The key, returned to the reader once and never stored in the clear. */
  key: string;
  /** When the provider ends the key by itself, if it says. The lease never outlives it. */
  expiresAt?: number | null;
  /** What `revoke` needs later (for GitHub, the token itself); sealed with the lease. */
  secret?: string | null;
  /** Shown with the lease; nothing secret. */
  detail?: Record<string, unknown>;
}

export interface ApiKeyProvider {
  kind: string;
  title: string;
  defaultEndpoint: string;
  /** What an admin supplies to register it, in words. */
  needs: string;
  /** Validates a provider's configuration (400 on a bad one). */
  providerConfig(input: unknown): Record<string, unknown>;
  /** Validates a role's scope set and its own configuration. */
  role(input: { scopes: string[]; config: unknown }): { scopes: string[]; config: Record<string, unknown> };
  create(t: ProviderTarget, role: { name: string; scopes: string[]; config: Record<string, unknown> }): Promise<IssuedKey>;
  /** Ends the key at the provider. A key that is already gone there is a success. */
  revoke(t: ProviderTarget, issued: { secret: string | null }): Promise<void>;
}

const upstream = (what: string, r: ProviderResponse): HttpProblem => {
  const said = r.body && typeof r.body === 'object' && typeof (r.body as { message?: unknown }).message === 'string' ? `: ${(r.body as { message: string }).message.slice(0, 200)}` : '';
  return new HttpProblem(502, 'Provider refused', `${what} answered ${r.status}${said}.`, { extensions: { step: 'apikey-provider', status: r.status } });
};

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

/** The App's JWT (RS256, nine minutes), which GitHub exchanges for an installation token. */
export function githubAppJwt(appId: string, privateKeyPem: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60; // GitHub allows for clock drift this way
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat, exp: iat + 600, iss: appId }));
  let signature: Buffer;
  try {
    signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKeyPem.includes('\\n') ? privateKeyPem.replace(/\\n/g, '\n') : privateKeyPem);
  } catch {
    throw new HttpProblem(409, 'Conflict', 'The credential of this provider is not an RSA private key in PEM form (the GitHub App private key).', { extensions: { step: 'apikey-provider-credential' } });
  }
  return `${head}.${body}.${b64url(signature)}`;
}

const GH_HEADERS = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'exprsn-ai' };
const ghScope = z.string().regex(/^[a-z_]{1,60}:(read|write|admin)$/, 'A GitHub permission and its level, such as contents:read or issues:write');
const ghRepo = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, 'A repository name without its owner');

export const githubProvider: ApiKeyProvider = {
  kind: 'github',
  title: 'GitHub App installation tokens',
  defaultEndpoint: 'https://api.github.com',
  needs: 'A GitHub App installed on the account or organisation: its App id (or client id), the installation id, and the App private key (PEM) stored in the vault and given as a vault:path#key reference. api.github.com must be on the tenant\'s list of allowed hosts.',
  providerConfig(input) {
    const p = z.object({ appId: z.string().trim().regex(/^[A-Za-z0-9.]{1,40}$/, 'The App id or client id'), installationId: z.string().trim().regex(/^\d{1,20}$/, 'The installation id, digits') }).strict().safeParse(input);
    if (!p.success) throw badRequest(`A GitHub provider needs config {appId, installationId}: ${p.error.issues[0]?.message ?? 'invalid'}.`);
    return p.data;
  },
  role(input) {
    const scopes = z.array(ghScope).min(1).max(40).safeParse(input.scopes);
    if (!scopes.success) throw badRequest(`A GitHub role needs at least one scope such as contents:read: ${scopes.error.issues[0]?.message ?? 'invalid'}.`);
    const names = scopes.data.map((x) => x.split(':')[0]);
    if (new Set(names).size !== names.length) throw badRequest('A GitHub role names each permission once.');
    const config = z.object({ repositories: z.array(ghRepo).min(1).max(100).optional() }).strict().safeParse(input.config ?? {});
    if (!config.success) throw badRequest(`A GitHub role's config is {repositories?: [names]}: ${config.error.issues[0]?.message ?? 'invalid'}.`);
    return { scopes: [...scopes.data].sort(), config: config.data };
  },
  async create(t, role) {
    const jwt = githubAppJwt(String(t.config.appId), await t.credential());
    const permissions = Object.fromEntries(role.scopes.map((x) => x.split(':') as [string, string]));
    const repositories = role.config.repositories as string[] | undefined;
    const r = await t.request({ method: 'POST', path: `/app/installations/${encodeURIComponent(String(t.config.installationId))}/access_tokens`, headers: { ...GH_HEADERS, authorization: `Bearer ${jwt}` }, body: { permissions, ...(repositories ? { repositories } : {}) } });
    const b = r.body as { token?: unknown; expires_at?: unknown; permissions?: unknown; repository_selection?: unknown } | null;
    if (r.status !== 201 || !b || typeof b.token !== 'string' || !b.token) throw upstream('GitHub, asked for an installation token,', r);
    // The role is the ceiling: a token that came back with more than was asked for is ended and refused.
    const got = b.permissions && typeof b.permissions === 'object' ? (b.permissions as Record<string, string>) : permissions;
    const rank = { read: 1, write: 2, admin: 3 } as Record<string, number>;
    const over = Object.entries(got).filter(([name, level]) => (rank[level] ?? 9) > (rank[permissions[name] ?? ''] ?? 0)).map(([name, level]) => `${name}:${level}`);
    if (over.length) {
      await githubProvider.revoke(t, { secret: b.token }).catch(() => undefined);
      throw new HttpProblem(502, 'Provider refused', `GitHub issued a token with more than the role allows (${over.join(', ').slice(0, 200)}); it was revoked.`, { extensions: { step: 'apikey-provider-scope' } });
    }
    const expiresAt = typeof b.expires_at === 'string' && Number.isFinite(Date.parse(b.expires_at)) ? Date.parse(b.expires_at) : null;
    return { key: b.token, expiresAt, secret: b.token, detail: { permissions: got, repositorySelection: typeof b.repository_selection === 'string' ? b.repository_selection : null } };
  },
  async revoke(t, issued) {
    if (!issued.secret) return; // nothing to present: the token ends by itself within the hour
    const r = await t.request({ method: 'DELETE', path: '/installation/token', headers: { ...GH_HEADERS, authorization: `Bearer ${issued.secret}` } });
    // 401: the token is already expired or revoked there.
    if (r.status !== 204 && r.status !== 401 && r.status !== 404) throw upstream('GitHub, asked to revoke the token,', r);
  }
};

export type ApiKeyProviders = Record<string, ApiKeyProvider>;
export const builtinApiKeyProviders = (): ApiKeyProviders => ({ [githubProvider.kind]: githubProvider });
