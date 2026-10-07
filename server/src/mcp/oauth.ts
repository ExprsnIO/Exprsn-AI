import { fetch, type Dispatcher } from 'undici';
import type { Logger } from 'pino';
import { hmac, randomToken, safeEqual } from '../crypto/index.js';
import { json, type Db } from '../db/knex.js';
import { pkceChallenge } from '../federation/jose.js';
import { conflict, HttpProblem } from '../http/problem.js';
import type { DataKeys } from '../platform/datakeys.js';
import { canonicalResource } from './server/resource.js';
import { PROTOCOL_VERSION } from './client.js';
import { checkUrl, HostRefused, type AllowList } from './hosts.js';

/*
 * B-7103: OAuth for the MCP client, per user. An MCP server that answers 401 with RFC 9728 protected resource metadata
 * names its authorization server; this module finds that server's metadata (RFC 8414, or OpenID discovery), registers
 * a public client there (RFC 7591) when nobody gave it one, and runs the authorization code grant with PKCE (S256) for
 * each user who connects, naming the MCP server as the resource (RFC 8707). Tokens are sealed with the tenant key;
 * an expired access token is refreshed before a call (and once more when the server answers 401), and disconnecting
 * revokes the refresh and access tokens at the authorization server (RFC 7009) before forgetting them. When discovery
 * fails, a tool admin enters the endpoints and client by hand.
 *
 * The server's own fetches (metadata, registration, token, revocation) go through the same internal-hosts dispatcher
 * as MCP calls; only the user's browser visits the authorization endpoint.
 */

const MAX_BODY = 256 * 1024;
/** An authorization request in flight lives this long (the user signs in and consents at the other end). */
export const STATE_MS = 10 * 60_000;
export const OAUTH_COOKIE = 'exai_mcpoauth';

export interface OAuthRow {
  server_id: string;
  tenant_id: string;
  mode: 'discovered' | 'manual';
  resource: string | null;
  issuer: string | null;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string | null;
  revocation_endpoint: string | null;
  client_id: string;
  client_secret: string | null;
  registered: boolean;
  scopes: string | null;
  metadata: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

export const oauthView = (r: OAuthRow | null) =>
  r
    ? { mode: r.mode, resource: r.resource, issuer: r.issuer, authorizationEndpoint: r.authorization_endpoint, tokenEndpoint: r.token_endpoint, registrationEndpoint: r.registration_endpoint, revocationEndpoint: r.revocation_endpoint, clientId: r.client_id, hasSecret: !!r.client_secret, registered: !!r.registered, scopes: r.scopes, updatedAt: Number(r.updated_at) }
    : null;

export interface TokenSet {
  access: string;
  refresh: string | null;
  expiresAt: number | null;
  scopes: string | null;
}

export class OAuthFailure extends Error {
  constructor(
    message: string,
    readonly code: string = 'oauth_failed'
  ) {
    super(message);
  }
}

/** The quoted or bare parameters of a WWW-Authenticate challenge, by name (lower case). */
export function challengeParams(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const m of header.matchAll(/([a-zA-Z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) out[m[1]!.toLowerCase()] = (m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1');
  return out;
}

const httpUrl = (v: unknown): string | null => {
  if (typeof v !== 'string' || v.length > 500) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
};

export class McpOAuth {
  constructor(
    private readonly db: Db,
    private readonly keys: DataKeys,
    private readonly dispatcher: Dispatcher,
    private readonly allow: AllowList,
    private readonly log: Logger,
    private readonly o: { timeoutMs: number; secret: string; callbackUrl: string }
  ) {}

  get callbackUrl(): string {
    return this.o.callbackUrl;
  }

  async config(serverId: string): Promise<OAuthRow | null> {
    const r = (await this.db('mcp_oauth').where({ server_id: serverId }).first()) as OAuthRow | undefined;
    return r ? { ...r, registered: !!r.registered } : null;
  }

  async remove(serverId: string): Promise<void> {
    await this.db('mcp_oauth').where({ server_id: serverId }).delete();
    await this.db('mcp_oauth_states').where({ server_id: serverId }).delete();
  }

  // ---------- HTTP ----------

  private async http(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: Headers; body: unknown }> {
    try {
      await checkUrl(url, this.allow);
    } catch (err) {
      if (err instanceof HostRefused) throw new OAuthFailure(`${new URL(url).host}: ${err.message}`, 'refused');
      throw err;
    }
    let res;
    try {
      res = await fetch(url, { method: init.method ?? 'GET', headers: { accept: 'application/json', ...init.headers }, ...(init.body !== undefined ? { body: init.body } : {}), dispatcher: this.dispatcher, redirect: 'error', signal: AbortSignal.timeout(this.o.timeoutMs) });
    } catch (err) {
      const cause = (err as { cause?: unknown }).cause;
      if (cause instanceof HostRefused) throw new OAuthFailure(cause.message, 'refused');
      throw new OAuthFailure(`${new URL(url).host} did not answer: ${(cause as Error | undefined)?.message ?? (err as Error).message}`, 'unreachable');
    }
    const text = await res.text();
    if (text.length > MAX_BODY) throw new OAuthFailure(`${new URL(url).host} answered with more than ${MAX_BODY} bytes.`);
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = null;
      }
    }
    return { status: res.status, headers: res.headers as unknown as Headers, body };
  }

  private async getJson(url: string): Promise<Record<string, unknown> | null> {
    try {
      const r = await this.http(url);
      return r.status === 200 && r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? (r.body as Record<string, unknown>) : null;
    } catch (err) {
      if (err instanceof OAuthFailure && err.code === 'refused') throw err;
      return null;
    }
  }

  // ---------- discovery ----------

  /**
   * MCP authorization discovery for a server: its 401 challenge and protected resource metadata (RFC 9728), then its
   * authorization server's metadata (RFC 8414 at the path-inserted well-known address, then OpenID discovery), then a
   * client registration (RFC 7591) unless one exists for this server already. Each step is reported.
   */
  async discover(server: { id: string; tenant_id: string; url: string; name: string }, by: string | null, tenantName: string): Promise<{ row: OAuthRow; steps: { check: string; result: 'passed' | 'failed' | 'skipped'; detail: string }[] }> {
    const steps: { check: string; result: 'passed' | 'failed' | 'skipped'; detail: string }[] = [];
    const fail = (check: string, detail: string): never => {
      steps.push({ check, result: 'failed', detail });
      throw Object.assign(new OAuthFailure(detail, 'discovery'), { steps });
    };
    const target = new URL(server.url);
    // 1. The challenge: an unauthenticated initialize.
    let prmUrl: string | null = null;
    let scopeHint: string | null = null;
    const r = await this.http(server.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL_VERSION }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'exprsn-ai', version: '1.0' } } }) });
    if (r.status === 401) {
      const c = challengeParams(r.headers.get('www-authenticate'));
      prmUrl = httpUrl(c.resource_metadata);
      scopeHint = c.scope ?? null;
      steps.push({ check: 'Challenge', result: 'passed', detail: prmUrl ? `401 with resource_metadata ${prmUrl}.` : '401 without resource_metadata; trying the well-known addresses.' });
    } else steps.push({ check: 'Challenge', result: 'skipped', detail: `The server answered ${r.status} without credentials; looking for its metadata anyway.` });
    // 2. Protected resource metadata.
    const path = target.pathname.replace(/\/+$/, '');
    const prmCandidates = [...(prmUrl ? [prmUrl] : []), `${target.origin}/.well-known/oauth-protected-resource${path}`, `${target.origin}/.well-known/oauth-protected-resource`];
    let prm: Record<string, unknown> | null = null;
    for (const u of [...new Set(prmCandidates)]) {
      prm = await this.getJson(u);
      if (prm) break;
    }
    let issuer: string;
    let resource = canonicalResource(server.url) ?? server.url;
    if (prm) {
      const named = typeof prm.resource === 'string' ? canonicalResource(prm.resource) : null;
      if (named && named !== resource) fail('Protected resource metadata', `The metadata is for ${named}, not ${resource}.`);
      const list = Array.isArray(prm.authorization_servers) ? prm.authorization_servers.map(httpUrl).filter((x): x is string => !!x) : [];
      if (!list.length) fail('Protected resource metadata', 'The metadata names no authorization server.');
      issuer = list[0]!.replace(/\/+$/, '');
      resource = named ?? resource;
      if (!scopeHint && Array.isArray(prm.scopes_supported)) scopeHint = prm.scopes_supported.filter((x) => typeof x === 'string').join(' ') || null;
      steps.push({ check: 'Protected resource metadata', result: 'passed', detail: `Authorization server ${issuer}.` });
    } else {
      issuer = target.origin;
      steps.push({ check: 'Protected resource metadata', result: 'skipped', detail: `None published; assuming the server's origin ${issuer} is its authorization server.` });
    }
    // 3. Authorization server metadata.
    const iss = new URL(issuer);
    const ipath = iss.pathname.replace(/\/+$/, '');
    const asCandidates = [`${iss.origin}/.well-known/oauth-authorization-server${ipath}`, `${iss.origin}/.well-known/openid-configuration${ipath}`, `${issuer}/.well-known/openid-configuration`];
    let meta: Record<string, unknown> | null = null;
    for (const u of [...new Set(asCandidates)]) {
      const m = await this.getJson(u);
      if (m && (typeof m.issuer !== 'string' || m.issuer.replace(/\/+$/, '') === issuer) && httpUrl(m.authorization_endpoint) && httpUrl(m.token_endpoint)) {
        meta = m;
        break;
      }
    }
    if (!meta) fail('Authorization server metadata', `${issuer} publishes no usable metadata. Enter its endpoints by hand.`);
    const methods = Array.isArray(meta!.code_challenge_methods_supported) ? meta!.code_challenge_methods_supported : null;
    if (methods && !methods.includes('S256')) fail('Authorization server metadata', `${issuer} does not offer PKCE with S256.`);
    steps.push({ check: 'Authorization server metadata', result: 'passed', detail: `Authorize at ${String(meta!.authorization_endpoint)}, tokens at ${String(meta!.token_endpoint)}.` });
    // 4. A client: the one registered before for this server, else dynamic registration.
    const cur = await this.config(server.id);
    let clientId = cur && cur.issuer === issuer ? cur.client_id : null;
    let secret = cur && cur.issuer === issuer ? cur.client_secret : null;
    let registered = !!(cur && cur.issuer === issuer && cur.registered);
    const registration = httpUrl(meta!.registration_endpoint);
    if (clientId) steps.push({ check: 'Client registration', result: 'skipped', detail: `Using client ${clientId} from before.` });
    else if (registration) {
      const reg = await this.http(registration, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: `Exprsn-AI (${tenantName})`.slice(0, 100), redirect_uris: [this.o.callbackUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...(scopeHint ? { scope: scopeHint } : {}) }) });
      const b = (reg.body ?? {}) as Record<string, unknown>;
      if ((reg.status !== 201 && reg.status !== 200) || typeof b.client_id !== 'string') fail('Client registration', `Registration at ${registration} failed (${reg.status}${typeof b.error === 'string' ? ` ${b.error}` : ''}${typeof b.error_description === 'string' ? `: ${b.error_description.slice(0, 200)}` : ''}).`);
      clientId = String(b.client_id).slice(0, 300);
      secret = typeof b.client_secret === 'string' ? await this.keys.seal(server.tenant_id, b.client_secret, `mcp-oauth-client:${server.id}`) : null;
      registered = true;
      steps.push({ check: 'Client registration', result: 'passed', detail: `Registered as ${clientId} with redirect ${this.o.callbackUrl}.` });
    } else fail('Client registration', `${issuer} does not register clients dynamically. Enter a client id by hand.`);
    const t = Date.now();
    const row: OAuthRow = { server_id: server.id, tenant_id: server.tenant_id, mode: 'discovered', resource, issuer, authorization_endpoint: httpUrl(meta!.authorization_endpoint)!, token_endpoint: httpUrl(meta!.token_endpoint)!, registration_endpoint: registration, revocation_endpoint: httpUrl(meta!.revocation_endpoint), client_id: clientId!, client_secret: secret, registered, scopes: scopeHint?.slice(0, 500) ?? null, metadata: JSON.stringify({ prm: prm ?? null, issuer: meta!.issuer ?? null }).slice(0, 20_000), updated_by: by, created_at: cur?.created_at ?? t, updated_at: t };
    await this.save(row);
    return { row, steps };
  }

  /** Endpoints and a client entered by hand, when the server or its authorization server publishes no metadata. */
  async setManual(server: { id: string; tenant_id: string; url: string }, input: { authorizationEndpoint: string; tokenEndpoint: string; revocationEndpoint?: string | null; clientId: string; clientSecret?: string | null; scopes?: string | null; resource?: string | null }, by: string): Promise<OAuthRow> {
    const cur = await this.config(server.id);
    const t = Date.now();
    const row: OAuthRow = {
      server_id: server.id,
      tenant_id: server.tenant_id,
      mode: 'manual',
      resource: input.resource ? canonicalResource(input.resource) : (canonicalResource(server.url) ?? server.url),
      issuer: null,
      authorization_endpoint: input.authorizationEndpoint,
      token_endpoint: input.tokenEndpoint,
      registration_endpoint: null,
      revocation_endpoint: input.revocationEndpoint ?? null,
      client_id: input.clientId,
      client_secret: input.clientSecret === undefined ? (cur?.client_secret ?? null) : input.clientSecret ? await this.keys.seal(server.tenant_id, input.clientSecret, `mcp-oauth-client:${server.id}`) : null,
      registered: false,
      scopes: input.scopes ?? null,
      metadata: null,
      updated_by: by,
      created_at: cur?.created_at ?? t,
      updated_at: t
    };
    await this.save(row);
    return row;
  }

  private async save(row: OAuthRow): Promise<void> {
    const n = await this.db('mcp_oauth').where({ server_id: row.server_id }).update(row);
    if (!n) await this.db('mcp_oauth').insert(row);
  }

  // ---------- the authorization code grant ----------

  /** Starts a user's authorization: the URL their browser goes to, and the value of the cookie that binds it to them. */
  async start(server: { id: string; tenant_id: string; name: string }, userId: string, returnTo: string | null): Promise<{ authorizeUrl: string; binding: string }> {
    const cfg = await this.config(server.id);
    if (!cfg) throw conflict(`${server.name} has no OAuth configuration yet; a tool admin discovers it or enters it on the MCP servers screen.`);
    const state = randomToken(24);
    const verifier = randomToken(48);
    const binding = randomToken(24);
    const t = Date.now();
    await this.db('mcp_oauth_states').where('expires_at', '<', t).delete();
    await this.db('mcp_oauth_states').insert({ id: hmac(this.o.secret, `mcp-oauth-state:${state}`), tenant_id: server.tenant_id, server_id: server.id, user_id: userId, verifier: await this.keys.seal(server.tenant_id, verifier, `mcp-oauth-verifier:${server.id}:${userId}`), binding: hmac(this.o.secret, `mcp-oauth-binding:${binding}`), return_to: returnTo, created_at: t, expires_at: t + STATE_MS });
    const u = new URL(cfg.authorization_endpoint);
    const params: Record<string, string> = { response_type: 'code', client_id: cfg.client_id, redirect_uri: this.o.callbackUrl, state, code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256', ...(cfg.scopes ? { scope: cfg.scopes } : {}), ...(cfg.resource ? { resource: cfg.resource } : {}) };
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return { authorizeUrl: u.toString(), binding };
  }

  /**
   * The redirect back: the state names the request (once), the cookie proves it is the browser that started it, and
   * the code is exchanged for tokens with the PKCE verifier. Returns whose tokens these are.
   */
  async finish(q: { state?: string; code?: string; error?: string; error_description?: string; iss?: string }, cookie: string | undefined): Promise<{ tenantId: string; serverId: string; userId: string; returnTo: string | null; tokens: TokenSet }> {
    if (!q.state) throw new OAuthFailure('The answer carries no state.', 'invalid_request');
    const id = hmac(this.o.secret, `mcp-oauth-state:${q.state}`);
    const row = (await this.db('mcp_oauth_states').where({ id }).first()) as { tenant_id: string; server_id: string; user_id: string; verifier: string; binding: string; return_to: string | null; expires_at: number } | undefined;
    if (!row) throw new OAuthFailure('This authorization is unknown or was already used. Start again.', 'invalid_state');
    await this.db('mcp_oauth_states').where({ id }).delete();
    if (Number(row.expires_at) < Date.now()) throw new OAuthFailure('This authorization expired. Start again.', 'expired');
    if (!cookie || !safeEqual(hmac(this.o.secret, `mcp-oauth-binding:${cookie}`), row.binding)) throw new OAuthFailure('This authorization was started in another browser. Start again from the same one.', 'binding');
    const cfg = await this.config(row.server_id);
    if (!cfg) throw new OAuthFailure('The server lost its OAuth configuration meanwhile.', 'config');
    // RFC 9207: when the authorization server names itself, it must be the one asked.
    if (q.iss && cfg.issuer && q.iss.replace(/\/+$/, '') !== cfg.issuer) throw new OAuthFailure('The answer came from another authorization server.', 'mix-up');
    if (q.error) throw new OAuthFailure(`The authorization server refused: ${q.error}${q.error_description ? ` (${q.error_description.slice(0, 200)})` : ''}.`, q.error.slice(0, 50));
    if (!q.code) throw new OAuthFailure('The answer carries no code.', 'invalid_request');
    const verifier = await this.keys.open(row.tenant_id, row.verifier, `mcp-oauth-verifier:${row.server_id}:${row.user_id}`);
    const tokens = await this.tokenRequest(cfg, { grant_type: 'authorization_code', code: q.code, redirect_uri: this.o.callbackUrl, code_verifier: verifier });
    return { tenantId: row.tenant_id, serverId: row.server_id, userId: row.user_id, returnTo: row.return_to, tokens };
  }

  /** A refresh: new tokens, or an OAuthFailure (`invalid_grant` when the grant is gone and the user must reconnect). */
  async refresh(serverId: string, refreshToken: string): Promise<TokenSet> {
    const cfg = await this.config(serverId);
    if (!cfg) throw new OAuthFailure('The server has no OAuth configuration.', 'config');
    const t = await this.tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: refreshToken });
    return { ...t, refresh: t.refresh ?? refreshToken };
  }

  private async clientAuth(cfg: OAuthRow, form: Record<string, string>): Promise<Record<string, string>> {
    if (!cfg.client_secret) {
      form.client_id = cfg.client_id;
      return {};
    }
    const secret = await this.keys.open(cfg.tenant_id, cfg.client_secret, `mcp-oauth-client:${cfg.server_id}`);
    return { authorization: `Basic ${Buffer.from(`${encodeURIComponent(cfg.client_id)}:${encodeURIComponent(secret)}`).toString('base64')}` };
  }

  private async tokenRequest(cfg: OAuthRow, form: Record<string, string>): Promise<TokenSet> {
    if (cfg.resource) form.resource = cfg.resource;
    const headers = { 'content-type': 'application/x-www-form-urlencoded', ...(await this.clientAuth(cfg, form)) };
    const r = await this.http(cfg.token_endpoint, { method: 'POST', headers, body: new URLSearchParams(form).toString() });
    const b = (r.body ?? {}) as Record<string, unknown>;
    if (r.status !== 200 || typeof b.access_token !== 'string') throw new OAuthFailure(`The token endpoint refused (${r.status}${typeof b.error === 'string' ? ` ${b.error}` : ''}${typeof b.error_description === 'string' ? `: ${b.error_description.slice(0, 200)}` : ''}).`, typeof b.error === 'string' ? b.error.slice(0, 50) : 'token');
    if (typeof b.token_type === 'string' && b.token_type.toLowerCase() !== 'bearer') throw new OAuthFailure(`The token endpoint issued a ${b.token_type} token; only bearer tokens are used here.`, 'token_type');
    const expiresIn = typeof b.expires_in === 'number' && b.expires_in > 0 ? b.expires_in : null;
    return { access: b.access_token.slice(0, 8000), refresh: typeof b.refresh_token === 'string' ? b.refresh_token.slice(0, 8000) : null, expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null, scopes: typeof b.scope === 'string' ? b.scope.slice(0, 300) : (cfg.scopes?.slice(0, 300) ?? null) };
  }

  /** RFC 7009: revokes what a user stored (refresh token first). Returns whether the server confirmed. */
  async revoke(serverId: string, tokens: { access: string | null; refresh: string | null }): Promise<boolean> {
    const cfg = await this.config(serverId);
    if (!cfg?.revocation_endpoint) return false;
    let ok = true;
    for (const [token, hint] of [
      [tokens.refresh, 'refresh_token'],
      [tokens.access, 'access_token']
    ] as const) {
      if (!token) continue;
      const form: Record<string, string> = { token, token_type_hint: hint };
      try {
        const headers = { 'content-type': 'application/x-www-form-urlencoded', ...(await this.clientAuth(cfg, form)) };
        const r = await this.http(cfg.revocation_endpoint, { method: 'POST', headers, body: new URLSearchParams(form).toString() });
        if (r.status !== 200) ok = false;
      } catch (err) {
        ok = false;
        this.log.warn({ err: (err as Error).message, server: serverId }, 'mcp oauth revocation failed');
      }
    }
    return ok;
  }
}

/** Turns an OAuthFailure into a problem for the admin routes. */
export const oauthProblem = (err: unknown): unknown =>
  err instanceof OAuthFailure ? new HttpProblem(422, 'OAuth', err.message, { extensions: { reason: err.code, ...((err as { steps?: unknown }).steps ? { steps: (err as { steps?: unknown }).steps } : {}) } }) : err;

export const metadataOf = (r: OAuthRow | null) => json<Record<string, unknown>>(r?.metadata, {});
