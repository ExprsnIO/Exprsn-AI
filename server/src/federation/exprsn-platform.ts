import { randomBytes } from 'node:crypto';
import { randomToken } from '../crypto/index.js';
import { checkServiceUrl, guardedRequest, serviceAddressProblem, servicePolicy, ServiceUrlRefused } from '../platform/egress.js';
import type { ProviderRow } from '../repos/providers.js';
import type { ExprsnPlatformConfig, ExternalUser, Step } from '../identity/providers/types.js';
import { resolveSecretRef } from '../identity/secrets.js';
import type { Services } from '../services.js';
import { pkceChallenge } from './jose.js';
import type { TenantCtx } from './oidc.js';
import { UpstreamError } from './upstream.js';

/*
 * 1.9.0, Sprint 54 (B-184): Exprsn platform accounts as a user store. The platform's OAuth 2.0 authorization server
 * (exprsn-platform `services/auth`, mounted at /api/oauth2: authorize, token, userinfo, revoke; read for its
 * endpoints and checks, not ported) signs the person in; this server is its client:
 *
 * - the authorization code grant with PKCE (S256; the platform refuses `plain` and requires it of public clients),
 *   a single-use `state` bound to the browser that started it (the `exai_fed` cookie and the upstream pending table,
 *   as for upstream OIDC and GitHub), the client secret (for a confidential client) a `vault:` reference read as
 *   the admin who saved the store;
 * - then userinfo with the access token (the platform answers `sub`, `name`, `email`, `email_verified` for the
 *   `profile` and `email` scopes), and, when the store names one, a memberships endpoint; organisations become groups
 *   `org:<slug>` and `org:<slug>/<role>`, platform roles `role:<name>`, which the tenant's group mappings turn into
 *   roles, clearance and workspaces;
 * - the link is the platform's account id (`sub`), so a changed address stays linked; an address is taken only when
 *   the platform says it is verified, and a username already linked to another store is refused by provisioning;
 * - the access token is used for these reads, revoked at the platform afterwards (best effort), never stored;
 * - every request goes through the egress guard with the operator's service policy (the platform is usually on the
 *   internal network: `PLATFORM_LOWCODE_URL`, https, or http on this host).
 */

const USERNAME = /^[a-z0-9][a-z0-9._@-]{0,189}$/;
const SUB = /^[A-Za-z0-9._:@-]{1,200}$/;
const SLUG = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const ROLE = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const MAX_GROUPS = 500;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Organisation entries as the platform may give them: a slug, or `{ slug | name | id, role | roles }`. */
function orgsOf(v: unknown): { slug: string; roles: string[] }[] {
  const list = Array.isArray(v) ? v : [];
  const out: { slug: string; roles: string[] }[] = [];
  for (const o of list.slice(0, 200)) {
    if (typeof o === 'string') {
      const slug = o.trim().toLowerCase();
      if (SLUG.test(slug)) out.push({ slug, roles: [] });
      continue;
    }
    if (!o || typeof o !== 'object') continue;
    const r = o as Record<string, unknown>;
    const slug = (str(r.slug) ?? str(r.name) ?? str(r.id))?.toLowerCase();
    if (!slug || !SLUG.test(slug)) continue;
    const roles = [...(Array.isArray(r.roles) ? r.roles : []), r.role].map((x) => (typeof x === 'string' ? x.trim().toLowerCase() : typeof x === 'object' && x ? str((x as { name?: unknown }).name)?.toLowerCase() : null)).filter((x): x is string => !!x && ROLE.test(x));
    out.push({ slug, roles: [...new Set(roles)] });
  }
  return out;
}

function rolesOf(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  return [...new Set(list.map((x) => (typeof x === 'string' ? x.trim().toLowerCase() : typeof x === 'object' && x ? str((x as { name?: unknown }).name)?.toLowerCase() : null)).filter((x): x is string => !!x && ROLE.test(x)))];
}

/** The platform's organisations and roles as group names for the mappings. */
export function platformGroups(orgs: { slug: string; roles: string[] }[], roles: string[]): string[] {
  const out: string[] = [];
  for (const o of orgs) {
    out.push(`org:${o.slug}`);
    for (const r of o.roles) out.push(`org:${o.slug}/${r}`);
  }
  for (const r of roles) out.push(`role:${r}`);
  return [...new Set(out)].slice(0, MAX_GROUPS);
}

export class PlatformStore {
  constructor(private readonly s: () => Services) {}

  private base(cfg: ExprsnPlatformConfig): string {
    return cfg.platformUrl.replace(/\/+$/, '');
  }

  /** The endpoints pass the operator's service URL checks when an admin saves the store (throws ServiceUrlRefused). */
  async checkConfig(cfg: ExprsnPlatformConfig): Promise<void> {
    await checkServiceUrl(cfg.platformUrl, servicePolicy(this.s().cfg));
  }

  private async request(url: string, init: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: unknown }> {
    const cfg = this.s().cfg;
    const policy = servicePolicy(cfg);
    const res = await guardedRequest({
      method: init.method ?? 'GET',
      url: new URL(url),
      headers: { accept: 'application/json', 'user-agent': 'Exprsn-AI', ...init.headers },
      ...(init.body != null ? { body: init.body } : {}),
      timeoutMs: cfg.FEDERATION_TIMEOUT_MS,
      maxBytes: 1_000_000,
      check: (address, host) => serviceAddressProblem(address, host, policy)
    });
    const text = res.body.toString('utf8');
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  private clientSecret(row: ProviderRow, ref: string): Promise<string> {
    return resolveSecretRef(ref, (r) => this.s().vault.resolveFor(row.tenant_id, row.vault_owner, r, { via: `identity-provider:${row.id}` }));
  }

  /** Client authentication for the token and revocation endpoints: Basic for a confidential client, else the id alone. */
  private async clientAuth(row: ProviderRow, cfg: ExprsnPlatformConfig): Promise<{ headers: Record<string, string>; form: Record<string, string> }> {
    if (!cfg.clientSecret) return { headers: {}, form: { client_id: cfg.clientId } };
    const secret = await this.clientSecret(row, cfg.clientSecret);
    return { headers: { authorization: `Basic ${Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(secret)}`).toString('base64')}` }, form: {} };
  }

  async provider(tenantId: string, id: string): Promise<ProviderRow> {
    const row = await this.s().providers.get(tenantId, id);
    if (!row || row.kind !== 'exprsn-platform' || !row.enabled || (row as { state?: string }).state === 'archived') throw new UpstreamError('That identity provider is not available.');
    return row;
  }

  redirectUri(t: TenantCtx): string {
    return `${t.issuer}/federation/exprsn-platform/callback`;
  }

  /** Starts a platform sign-in: the authorize URL with state and PKCE, and the browser binding for the cookie. */
  async start(t: TenantCtx, providerId: string, returnTo: string | null): Promise<{ url: string; browser: string }> {
    const up = this.s().federation.upstream;
    const row = await this.provider(t.id, providerId);
    const cfg = row.config as unknown as ExprsnPlatformConfig;
    const browser = randomToken(24);
    const verifier = randomBytes(48).toString('base64url');
    const state = await up.savePending(t.id, { providerId: row.id, browser: up.digest(`browser:${browser}`), returnTo, verifier });
    const url = new URL(`${this.base(cfg)}${cfg.authorizePath}`);
    url.search = new URLSearchParams({ response_type: 'code', client_id: cfg.clientId, redirect_uri: this.redirectUri(t), scope: cfg.scopes, state, code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256' }).toString();
    return { url: url.toString(), browser };
  }

  /** Completes a platform sign-in: code exchange with the verifier, userinfo, memberships, then the token revoked. */
  async finish(t: TenantCtx, query: Record<string, unknown>, browser: string | undefined): Promise<{ row: ProviderRow; user: ExternalUser; returnTo: string | null }> {
    const up = this.s().federation.upstream;
    const pending = await up.takePending(t.id, typeof query.state === 'string' ? query.state : undefined, browser);
    if (typeof query.error === 'string') throw new UpstreamError(`The Exprsn platform refused the sign-in: ${query.error.slice(0, 100)}${typeof query.error_description === 'string' ? ` (${query.error_description.slice(0, 200)})` : ''}.`);
    if (typeof query.code !== 'string' || !query.code || query.code.length > 500) throw new UpstreamError('The Exprsn platform returned no code.');
    if (!pending.verifier) throw new UpstreamError('This sign-in has no PKCE verifier. Start again.');
    const row = await this.provider(t.id, pending.providerId);
    const cfg = row.config as unknown as ExprsnPlatformConfig;
    const auth = await this.clientAuth(row, cfg);
    const form = new URLSearchParams({ grant_type: 'authorization_code', code: query.code, redirect_uri: this.redirectUri(t), code_verifier: pending.verifier, ...auth.form });
    const tok = await this.request(`${this.base(cfg)}${cfg.tokenPath}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...auth.headers }, body: form.toString() });
    const tb = (tok.body ?? {}) as { access_token?: unknown; token_type?: unknown; error?: unknown; error_description?: unknown };
    if (tok.status !== 200 || typeof tb.access_token !== 'string' || !tb.access_token) throw new UpstreamError(`The platform token exchange failed: ${typeof tb.error === 'string' ? tb.error.slice(0, 100) : `HTTP ${tok.status}`}${typeof tb.error_description === 'string' ? ` (${tb.error_description.slice(0, 200)})` : ''}.`);
    if (typeof tb.token_type === 'string' && tb.token_type.toLowerCase() !== 'bearer') throw new UpstreamError('The platform returned a token that is not a bearer token.');
    const token = tb.access_token;
    try {
      const info = await this.request(`${this.base(cfg)}${cfg.userinfoPath}`, { headers: { authorization: `Bearer ${token}` } });
      if (info.status !== 200 || !info.body || typeof info.body !== 'object') throw new UpstreamError(`The platform's userinfo answered HTTP ${info.status}.`);
      const claims = info.body as Record<string, unknown>;
      const sub = str(claims.sub);
      if (!sub || !SUB.test(sub)) throw new UpstreamError('The platform returned no usable account id.');
      const verified = claims.email_verified === true;
      const email = str(claims.email)?.toLowerCase() ?? null;
      if (cfg.usernameClaim === 'email' && cfg.requireVerifiedEmail && !verified) throw new UpstreamError('Your platform email address is not verified, so it cannot be your username here. Verify it on the platform and try again.');
      const username = str(claims[cfg.usernameClaim])?.toLowerCase() ?? null;
      if (!username || !USERNAME.test(username)) throw new UpstreamError(`The platform returned no usable ${cfg.usernameClaim} for your account.`);
      let orgs = orgsOf(claims[cfg.organizationsClaim]);
      let roles = rolesOf(claims[cfg.rolesClaim]);
      if (cfg.membershipsPath) {
        const m = await this.request(`${this.base(cfg)}${cfg.membershipsPath}`, { headers: { authorization: `Bearer ${token}` } });
        if (m.status !== 200 || !m.body || typeof m.body !== 'object') throw new UpstreamError(`The platform's memberships answered HTTP ${m.status}.`);
        const mb = m.body as Record<string, unknown>;
        orgs = [...orgs, ...orgsOf(mb.organizations)];
        roles = [...new Set([...roles, ...rolesOf(mb.roles)])];
      }
      if (cfg.allowedOrganizations.length && !orgs.some((o) => cfg.allowedOrganizations.includes(o.slug))) throw new UpstreamError('Your platform account is not a member of an organisation this sign-in allows. Ask an identity admin.');
      // With an organisation list, only those organisations reach the mappings.
      const kept = cfg.allowedOrganizations.length ? orgs.filter((o) => cfg.allowedOrganizations.includes(o.slug)) : orgs;
      const name = str(claims.name) ?? ([str(claims.given_name), str(claims.family_name)].filter(Boolean).join(' ') || null);
      return {
        row,
        returnTo: pending.returnTo,
        user: { externalId: sub, username, displayName: (name ?? username).slice(0, 200), email: verified && email ? email.slice(0, 320) : null, groups: platformGroups(kept, roles) }
      };
    } finally {
      await this.revoke(row, cfg, token);
    }
  }

  /** RFC 7009 revocation at the platform, best effort: the token was only needed for the reads above. */
  private async revoke(row: ProviderRow, cfg: ExprsnPlatformConfig, token: string): Promise<void> {
    if (!cfg.revokePath) return;
    try {
      const auth = await this.clientAuth(row, cfg);
      await this.request(`${this.base(cfg)}${cfg.revokePath}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...auth.headers }, body: new URLSearchParams({ token, token_type_hint: 'access_token', ...auth.form }).toString() });
    } catch (err) {
      this.s().log.warn({ provider: row.id, err: (err as Error).message }, 'platform token revocation failed');
    }
  }

  /** The User stores "Test connection": the address passes the checks, the platform answers, the secret resolves. */
  async test(row: ProviderRow, steps: Step[]): Promise<boolean> {
    const cfg = row.config as unknown as ExprsnPlatformConfig;
    const step = async (title: string, fn: () => Promise<string | void>) => {
      const t0 = performance.now();
      try {
        const detail = await fn();
        steps.push({ title, ok: true, ms: Math.round(performance.now() - t0), ...(detail ? { detail } : {}) });
        return true;
      } catch (err) {
        steps.push({ title, ok: false, ms: Math.round(performance.now() - t0), detail: (err as Error).message });
        return false;
      }
    };
    if (!(await step('Service address checks', async () => {
      await this.checkConfig(cfg);
      return new URL(cfg.platformUrl).host;
    }))) return false;
    const reach = await step('The platform\'s authorization server answers', async () => {
      // Without a signed-in platform session the authorize endpoint redirects to its sign-in page or refuses the
      // bare request; either way it answers. A 5xx or no answer is a failure.
      const r = await this.request(`${this.base(cfg)}${cfg.authorizePath}?client_id=${encodeURIComponent(cfg.clientId)}`, {});
      if (r.status >= 500 || r.status === 0) throw new Error(`HTTP ${r.status}`);
      return `HTTP ${r.status}`;
    });
    const secret = cfg.clientSecret ? await step('Client secret reference resolves', async () => void (await this.clientSecret(row, cfg.clientSecret!))) : true;
    return reach && secret;
  }
}

export { ServiceUrlRefused };
