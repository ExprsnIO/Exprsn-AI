import { randomBytes } from 'node:crypto';
import { fetch, type Agent } from 'undici';
import { randomToken } from '../crypto/index.js';
import { checkServiceUrl, literalProblem, serviceAgent, servicePolicy, ServiceUrlRefused, type ServicePolicy } from '../platform/egress.js';
import type { ProviderRow } from '../repos/providers.js';
import type { ExternalUser, GitHubConfig, Step } from '../identity/providers/types.js';
import { resolveSecretRef } from '../identity/secrets.js';
import type { Services } from '../services.js';
import { pkceChallenge } from './jose.js';
import type { TenantCtx } from './oidc.js';
import { UpstreamError } from './upstream.js';

/*
 * Sprint 26a (B-1804): GitHub sign-in as an OAuth 2.0 user store (ported in design from exprsn-platform's passport
 * GitHub strategy, without its email-based account linking). The browser round trip is the upstream OIDC store's:
 * a single-use `state` bound to the browser that started it (the `exai_fed` cookie), PKCE (S256), and the same
 * pending table. After the code exchange the store reads the user, their verified primary address, their
 * organisations and their teams; organisations become groups `org` and teams `org/team-slug`, which the tenant's
 * group mappings turn into roles, clearance and workspaces like any directory group. The link to a local user is the
 * GitHub numeric id (logins can be renamed), and a login already linked to another store is refused by provisioning.
 * Every request goes through the service URL checks (B-901): the address is checked before the request and again at
 * connect time, so GitHub Enterprise Server on an internal network works and a metadata address never does. The
 * access token is used for these reads only and never stored.
 */

const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const PAGES = 5;

interface GitHubUser {
  id?: unknown;
  login?: unknown;
  name?: unknown;
  email?: unknown;
}

export class GitHubStore {
  private agentCache: { key: string; agent: Agent } | null = null;

  constructor(private readonly s: () => Services) {}

  private policy(): ServicePolicy {
    return servicePolicy(this.s().cfg);
  }

  private agent(): Agent {
    const cfg = this.s().cfg;
    const key = `${cfg.SERVICE_INTERNAL_ONLY ? 1 : 0}|${cfg.SERVICE_ALLOWED_HOSTS}|${cfg.FEDERATION_TIMEOUT_MS}`;
    if (!this.agentCache || this.agentCache.key !== key) this.agentCache = { key, agent: serviceAgent(this.policy(), {}, { headersTimeout: cfg.FEDERATION_TIMEOUT_MS, bodyTimeout: cfg.FEDERATION_TIMEOUT_MS }) };
    return this.agentCache.agent;
  }

  /** Checks the store's endpoints when an admin saves it (throws ServiceUrlRefused). */
  async checkConfig(cfg: GitHubConfig): Promise<void> {
    for (const u of [cfg.webUrl, cfg.apiUrl]) await checkServiceUrl(u, this.policy());
  }

  private async request(url: string, init: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: unknown }> {
    const literal = literalProblem(url, this.policy());
    if (literal) throw new ServiceUrlRefused(literal);
    const res = await fetch(url, { method: init.method ?? 'GET', headers: { 'user-agent': 'Exprsn-AI', ...init.headers }, ...(init.body ? { body: init.body } : {}), dispatcher: this.agent(), redirect: 'error', signal: AbortSignal.timeout(this.s().cfg.FEDERATION_TIMEOUT_MS) });
    const text = await res.text();
    if (text.length > 1_000_000) throw new UpstreamError('GitHub returned too much data.');
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  private async api<T>(cfg: GitHubConfig, token: string, path: string): Promise<T> {
    const r = await this.request(`${cfg.apiUrl.replace(/\/$/, '')}${path}`, { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' } });
    if (r.status !== 200) throw new UpstreamError(`GitHub answered HTTP ${r.status} for ${path.split('?')[0]}.`);
    return r.body as T;
  }

  /** Up to PAGES pages of 100. */
  private async list<T>(cfg: GitHubConfig, token: string, path: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= PAGES; page++) {
      const items = await this.api<T[]>(cfg, token, `${path}?per_page=100&page=${page}`);
      if (!Array.isArray(items)) throw new UpstreamError(`GitHub returned no list for ${path}.`);
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }

  private clientSecret(row: ProviderRow, ref: string): Promise<string> {
    return resolveSecretRef(ref, (r) => this.s().vault.resolveFor(row.tenant_id, row.vault_owner, r, { via: `identity-provider:${row.id}` }));
  }

  redirectUri(t: TenantCtx): string {
    return `${t.issuer}/federation/github/callback`;
  }

  /** Starts a GitHub sign-in: the authorize URL with state and PKCE, and the browser binding for the cookie. */
  async start(t: TenantCtx, providerId: string, returnTo: string | null): Promise<{ url: string; browser: string }> {
    const up = this.s().federation.upstream;
    const row = await up.provider(t.id, providerId, 'github');
    const cfg = row.config as unknown as GitHubConfig;
    const browser = randomToken(24);
    const verifier = randomBytes(48).toString('base64url');
    const state = await up.savePending(t.id, { providerId: row.id, browser: up.digest(`browser:${browser}`), returnTo, verifier });
    const url = new URL(`${cfg.webUrl.replace(/\/$/, '')}/login/oauth/authorize`);
    url.search = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: this.redirectUri(t), scope: cfg.scopes, state, code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256', allow_signup: 'false' }).toString();
    return { url: url.toString(), browser };
  }

  /** Completes a GitHub sign-in: code exchange, then the user, address, organisations and teams. */
  async finish(t: TenantCtx, query: Record<string, unknown>, browser: string | undefined): Promise<{ row: ProviderRow; user: ExternalUser; returnTo: string | null }> {
    const up = this.s().federation.upstream;
    const pending = await up.takePending(t.id, typeof query.state === 'string' ? query.state : undefined, browser);
    if (typeof query.error === 'string') throw new UpstreamError(`GitHub refused the sign-in: ${query.error.slice(0, 100)}${typeof query.error_description === 'string' ? ` (${query.error_description.slice(0, 200)})` : ''}.`);
    if (typeof query.code !== 'string' || !query.code || query.code.length > 200) throw new UpstreamError('GitHub returned no code.');
    const row = await up.provider(t.id, pending.providerId, 'github');
    const cfg = row.config as unknown as GitHubConfig;
    const form = new URLSearchParams({ client_id: cfg.clientId, client_secret: await this.clientSecret(row, cfg.clientSecret), code: query.code, redirect_uri: this.redirectUri(t), code_verifier: pending.verifier! });
    const tok = await this.request(`${cfg.webUrl.replace(/\/$/, '')}/login/oauth/access_token`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    const tb = (tok.body ?? {}) as { access_token?: unknown; token_type?: unknown; error?: unknown; error_description?: unknown };
    if (tok.status !== 200 || typeof tb.access_token !== 'string' || !tb.access_token) throw new UpstreamError(`The GitHub token exchange failed: ${typeof tb.error === 'string' ? tb.error.slice(0, 100) : `HTTP ${tok.status}`}${typeof tb.error_description === 'string' ? ` (${tb.error_description.slice(0, 200)})` : ''}.`);
    if (typeof tb.token_type === 'string' && tb.token_type.toLowerCase() !== 'bearer') throw new UpstreamError('GitHub returned a token that is not a bearer token.');
    const token = tb.access_token;
    const me = await this.api<GitHubUser>(cfg, token, '/user');
    const id = typeof me.id === 'number' || (typeof me.id === 'string' && /^\d{1,20}$/.test(me.id)) ? String(me.id) : null;
    const login = typeof me.login === 'string' ? me.login.toLowerCase() : '';
    if (!id || !LOGIN.test(login)) throw new UpstreamError('GitHub returned no usable account id or login.');
    const emails = await this.api<{ email?: unknown; primary?: unknown; verified?: unknown }[]>(cfg, token, '/user/emails').catch(() => []);
    // Only an address GitHub has verified is taken (never one it has not, which anyone could add to their account).
    const primary = Array.isArray(emails) ? emails.find((e) => e.primary === true && e.verified === true && typeof e.email === 'string') : undefined;
    const orgs = (await this.list<{ login?: unknown }>(cfg, token, '/user/orgs')).map((o) => (typeof o.login === 'string' ? o.login.toLowerCase() : '')).filter((o) => LOGIN.test(o));
    const teams = (await this.list<{ slug?: unknown; organization?: { login?: unknown } }>(cfg, token, '/user/teams'))
      .map((x) => (typeof x.slug === 'string' && typeof x.organization?.login === 'string' ? `${x.organization.login.toLowerCase()}/${x.slug.toLowerCase()}` : ''))
      .filter((x) => /^[a-z0-9-]{1,39}\/[a-z0-9._-]{1,100}$/.test(x));
    const allOrgs = [...new Set([...orgs, ...teams.map((x) => x.split('/')[0]!)])];
    if (cfg.allowedOrgs.length && !allOrgs.some((o) => cfg.allowedOrgs.includes(o))) throw new UpstreamError('Your GitHub account is not a member of an organisation this sign-in allows. Ask an identity admin.');
    // With an organisation list, only those organisations' groups reach the mappings.
    const keep = (g: string) => !cfg.allowedOrgs.length || cfg.allowedOrgs.includes(g.split('/')[0]!);
    const groups = [...new Set([...allOrgs, ...teams])].filter(keep).slice(0, 500);
    return {
      row,
      returnTo: pending.returnTo,
      user: { externalId: id, username: login, displayName: typeof me.name === 'string' && me.name.trim() ? me.name.trim().slice(0, 200) : login, email: primary ? String(primary.email).slice(0, 320) : null, groups }
    };
  }

  /** The User stores "Test connection": the endpoints pass the service checks, the API answers, the secret resolves. */
  async test(row: ProviderRow, steps: Step[]): Promise<boolean> {
    const cfg = row.config as unknown as GitHubConfig;
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
    const urls = await step('Service address checks', async () => {
      await this.checkConfig(cfg);
      return `${new URL(cfg.webUrl).host}, ${new URL(cfg.apiUrl).host}`;
    });
    if (!urls) return false;
    const api = await step('GitHub API answers', async () => {
      const r = await this.request(`${cfg.apiUrl.replace(/\/$/, '')}/`, { headers: { accept: 'application/vnd.github+json' } });
      if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
      return `HTTP ${r.status}`;
    });
    const secret = await step('Client secret reference resolves', async () => {
      await this.clientSecret(row, cfg.clientSecret);
    });
    return api && secret;
  }
}
