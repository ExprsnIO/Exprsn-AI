/*
 * 1.9.0, Sprint 54 (B-184): Exprsn platform accounts as a user store, against a local fake of the platform's OAuth
 * 2.0 authorization server (its endpoints and checks as exprsn-platform `services/auth/src/routes/oauth2.js` has
 * them: /api/oauth2/authorize, token, userinfo, revoke; PKCE S256 only). The live platform is never called.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { storeKind } from '../src/identity/providers/kinds.js';
import { platformGroups } from '../src/federation/exprsn-platform.js';
import { exprsnPlatformConfigSchema } from '../src/identity/providers/types.js';
import { singleAdminStores } from './store-governance-helpers.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';

interface PlatformUser {
  id: string;
  email: string;
  emailVerified?: boolean;
  displayName?: string;
  organizations?: unknown;
  roles?: unknown;
}

class FakePlatformAuth {
  url = '';
  readonly clientId = 'exprsn-ai-client';
  readonly clientSecret = 'platform-secret-' + randomBytes(6).toString('hex');
  readonly revoked: string[] = [];
  readonly tokenRequests: Record<string, string>[] = [];
  /** Memberships served at /api/me/memberships for the access token, when set. */
  memberships: Record<string, unknown> | null = null;
  private readonly codes = new Map<string, { user: PlatformUser; challenge: string; method: string; redirectUri: string; scope: string }>();
  private readonly tokens = new Map<string, { user: PlatformUser; scope: string }>();
  private server: Server | null = null;

  async start(): Promise<this> {
    const app = express();
    app.post('/api/oauth2/token', express.urlencoded({ extended: false }), (req, res) => {
      const b = req.body as Record<string, string>;
      this.tokenRequests.push(b);
      const [id, secret] = Buffer.from((req.header('authorization') ?? '').replace(/^Basic /, ''), 'base64').toString().split(':').map(decodeURIComponent);
      if (id !== this.clientId || secret !== this.clientSecret) return void res.status(401).json({ error: 'invalid_client', error_description: 'Client authentication failed' });
      const entry = this.codes.get(b.code ?? '');
      this.codes.delete(b.code ?? '');
      if (!entry) return void res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid grant: authorization code is invalid' });
      if (b.redirect_uri !== entry.redirectUri) return void res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      if (!b.code_verifier) return void res.status(400).json({ error: 'invalid_grant', error_description: 'code_verifier is required' });
      if (createHash('sha256').update(b.code_verifier).digest('base64url') !== entry.challenge) return void res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      const token = randomBytes(20).toString('hex');
      this.tokens.set(token, { user: entry.user, scope: entry.scope });
      res.json({ access_token: token, token_type: 'Bearer', expires_in: 3600, refresh_token: randomBytes(20).toString('hex'), scope: entry.scope });
    });
    const bearer = (req: express.Request) => this.tokens.get((req.header('authorization') ?? '').replace(/^Bearer /, ''));
    app.get('/api/oauth2/userinfo', (req, res) => {
      const t = bearer(req);
      if (!t) return void res.status(401).json({ error: 'invalid_token' });
      const scope = t.scope.split(' ');
      const u = t.user;
      res.json({ sub: u.id, ...(scope.includes('profile') ? { name: u.displayName ?? '', given_name: 'G', family_name: 'F' } : {}), ...(scope.includes('email') ? { email: u.email, email_verified: u.emailVerified !== false } : {}), ...(u.organizations ? { organizations: u.organizations } : {}), ...(u.roles ? { roles: u.roles } : {}) });
    });
    app.get('/api/me/memberships', (req, res) => (bearer(req) && this.memberships ? void res.json(this.memberships) : void res.status(401).json({})));
    app.post('/api/oauth2/revoke', express.urlencoded({ extended: false }), (req, res) => {
      this.revoked.push(String(req.body.token));
      this.tokens.delete(String(req.body.token));
      res.json({});
    });
    // Without a platform session the authorize endpoint sends the browser to the platform's sign-in.
    app.get('/api/oauth2/authorize', (req, res) => res.redirect(`/login?returnUrl=${encodeURIComponent(req.originalUrl)}`));
    await new Promise<void>((r) => (this.server = app.listen(0, '127.0.0.1', () => r())));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this;
  }

  /** The person signs in at the platform and approves: the code for the callback, with the platform's PKCE checks. */
  authorize(authorizeUrl: string, user: PlatformUser): { code: string; state: string; redirectUri: string } {
    const u = new URL(authorizeUrl);
    if (`${u.origin}${u.pathname}` !== `${this.url}/api/oauth2/authorize`) throw new Error(`wrong authorize endpoint ${u.origin}${u.pathname}`);
    if (u.searchParams.get('client_id') !== this.clientId) throw new Error('unknown client');
    if (u.searchParams.get('response_type') !== 'code') throw new Error('not the code flow');
    if (!u.searchParams.get('code_challenge')) throw new Error('PKCE is required: code_challenge is missing');
    if (u.searchParams.get('code_challenge_method') !== 'S256') throw new Error('code_challenge_method must be S256 (plain is not supported)');
    const code = randomBytes(16).toString('hex');
    this.codes.set(code, { user, challenge: u.searchParams.get('code_challenge')!, method: 'S256', redirectUri: u.searchParams.get('redirect_uri')!, scope: u.searchParams.get('scope') ?? '' });
    return { code, state: u.searchParams.get('state')!, redirectUri: u.searchParams.get('redirect_uri')! };
  }

  activeTokens(): number {
    return this.tokens.size;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}

const send = (c: Client, method: 'post' | 'put' | 'patch', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);

describe('B-184: Exprsn platform accounts as a store', () => {
  let h: Harness;
  let root: Client;
  let ida: Client;
  let platform: FakePlatformAuth;
  let storeId: string;

  beforeAll(async () => {
    platform = await new FakePlatformAuth().start();
    h = await harness({ PLATFORM_LOWCODE_URL: platform.url });
    await singleAdminStores(h); // configuration changes apply at once here (governance has its own tests)
    const rootId = (await localUser(h, 'root', ['system-admin', 'tenant-admin'], 'restricted')).id;
    await localUser(h, 'ida', ['identity-admin'], 'restricted');
    root = await loginAdmin(h, 'root');
    ida = await loginAdmin(h, 'ida');
    await send(root, 'post', '/api/vault/policies', { subjectKind: 'user', subject: rootId, path: '*', capabilities: ['*'] }).expect(201);
    await send(root, 'put', '/api/vault/kv/data/identity/exprsn-platform', { data: { clientSecret: platform.clientSecret } }).expect(201);
  });
  afterAll(async () => {
    await h.close();
    await platform.stop();
  });

  const signIn = async (user: PlatformUser, agent = request.agent(h.app)) => {
    const start = await agent.get(`/federation/exprsn-platform/start?provider=${storeId}`).expect(302);
    const { code, state, redirectUri } = platform.authorize(start.headers.location!, user);
    expect(redirectUri).toBe('http://localhost:8080/federation/exprsn-platform/callback');
    const cb = await agent.get(`/federation/exprsn-platform/callback?${new URLSearchParams({ code, state })}`);
    return { agent, cb, code, state };
  };

  it('fills its preset from PLATFORM_LOWCODE_URL, and maps organisations and roles to group names', () => {
    const def = storeKind('exprsn-platform')!;
    expect(def.platform).toBe(true);
    expect(def.signIn).toBe('redirect');
    expect(def.presets![0]!.config.platformUrl).toBe(platform.url);
    expect(exprsnPlatformConfigSchema.safeParse(def.presets![0]!.config).success).toBe(true);
    expect(exprsnPlatformConfigSchema.safeParse({ ...def.presets![0]!.config, clientSecret: 'env:UPSTREAM_SECRET_PLATFORM' }).success).toBe(false); // vault only
    expect(exprsnPlatformConfigSchema.safeParse({ ...def.presets![0]!.config, platformUrl: 'http://platform.example.com' }).success).toBe(false); // https, or http on this host
    expect(platformGroups([{ slug: 'acme', roles: ['admin', 'member'] }, { slug: 'beta', roles: [] }], ['auditor'])).toEqual(['org:acme', 'org:acme/admin', 'org:acme/member', 'org:beta', 'role:auditor']);
  });

  it('needs platform:manage to save, and checks the platform address', async () => {
    const config = { platformUrl: platform.url, clientId: platform.clientId, clientSecret: 'vault:identity/exprsn-platform#clientSecret' };
    const denied = await send(ida, 'post', '/api/admin/identity-providers', { name: 'Platform', kind: 'exprsn-platform', config });
    expect(denied.status).toBe(403);
    const meta = await send(root, 'post', '/api/admin/identity-providers', { name: 'Platform meta', kind: 'exprsn-platform', config: { ...config, platformUrl: 'https://169.254.169.254' } });
    expect(meta.status).toBe(400);
    expect(meta.body.reason).toBe('service_url');
    const created = await send(root, 'post', '/api/admin/identity-providers', { name: 'Exprsn platform', kind: 'exprsn-platform', config: { ...config, allowedOrganizations: ['acme'] } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    storeId = created.body.id;
    const tested = (await send(root, 'post', `/api/admin/identity-providers/${storeId}/test`).expect(200)).body;
    expect(tested.ok, JSON.stringify(tested.steps)).toBe(true);
    await send(root, 'post', '/api/admin/group-mappings', { providerId: storeId, group: 'org:acme', role: 'member', clearance: 'internal' }).expect(201);
    await send(root, 'post', '/api/admin/group-mappings', { providerId: storeId, group: 'org:acme/editor', role: 'knowledge-curator', clearance: 'internal' }).expect(201);
    const options = (await request(h.app).get('/api/auth/sign-in-options').expect(200)).body;
    expect(options.upstream).toEqual(expect.arrayContaining([expect.objectContaining({ id: storeId, protocol: 'exprsn-platform', start: `/federation/exprsn-platform/start?provider=${storeId}` })]));
  });

  it('signs in with the code and PKCE, maps the account, and revokes the token', async () => {
    const { agent, cb } = await signIn({ id: '8d0f8f3e-1111-4c4c-9d9d-000000000001', email: 'Pat@Acme.test', displayName: 'Pat Platform', organizations: [{ slug: 'acme', role: 'editor' }, { slug: 'other-org', role: 'owner' }], roles: ['user'] });
    expect(cb.status, cb.text).toBe(302);
    expect(cb.headers.location).toBe('/');
    const me = (await agent.get('/api/me').expect(200)).body;
    expect(me.user.username).toBe('pat@acme.test');
    expect(me.roles.map((r: { id: string }) => r.id).sort()).toEqual(['knowledge-curator', 'member']);
    const user = (await h.s.users.byUsername(h.tenantId, 'pat@acme.test'))!;
    expect(user.email).toBe('pat@acme.test');
    expect(user.display_name).toBe('Pat Platform');
    const link = (await h.s.db('user_identities').where({ user_id: user.id, provider_id: storeId }).first()) as { external_id: string; groups: string };
    expect(link.external_id).toBe('8d0f8f3e-1111-4c4c-9d9d-000000000001');
    // only the allowed organisation's groups reach the mappings
    expect((JSON.parse(link.groups) as string[]).sort()).toEqual(['org:acme', 'org:acme/editor', 'role:user']);
    // the exchange carried the verifier and the client secret from the vault; the token was revoked and never stored
    const exchange = platform.tokenRequests.at(-1)!;
    expect(exchange.grant_type).toBe('authorization_code');
    expect(exchange.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(platform.revoked.length).toBe(1);
    expect(platform.activeTokens()).toBe(0);
    expect(JSON.stringify(await h.s.db('user_identities').where({ user_id: user.id }))).not.toContain(platform.revoked[0]);
    // a changed address keeps the link (the platform id is the link)
    const again = await signIn({ id: '8d0f8f3e-1111-4c4c-9d9d-000000000001', email: 'pat@acme.test', organizations: ['acme'] });
    expect(again.cb.status).toBe(302);
    expect((await again.agent.get('/api/me').expect(200)).body.user.id).toBe(user.id);
  });

  it('reads memberships from the endpoint the store names', async () => {
    await send(root, 'patch', `/api/admin/identity-providers/${storeId}`, { config: { platformUrl: platform.url, clientId: platform.clientId, clientSecret: 'vault:identity/exprsn-platform#clientSecret', allowedOrganizations: ['acme'], membershipsPath: '/api/me/memberships' } }).expect(200);
    platform.memberships = { organizations: [{ slug: 'acme', roles: [{ name: 'editor' }] }], roles: ['auditor'] };
    const { cb } = await signIn({ id: 'p-2', email: 'quinn@acme.test' });
    expect(cb.status, cb.text).toBe(302);
    const user = (await h.s.users.byUsername(h.tenantId, 'quinn@acme.test'))!;
    const link = (await h.s.db('user_identities').where({ user_id: user.id, provider_id: storeId }).first()) as { groups: string };
    expect((JSON.parse(link.groups) as string[]).sort()).toEqual(['org:acme', 'org:acme/editor', 'role:auditor']);
  });

  it('refuses: an unverified address, an organisation outside the list, a replayed or stolen callback, a wrong verifier, an upstream error, a username of another store', async () => {
    const unverified = await signIn({ id: 'p-3', email: 'una@acme.test', emailVerified: false, organizations: ['acme'] });
    expect(unverified.cb.status).toBe(400);
    expect(unverified.cb.text).toContain('not verified');
    expect(await h.s.users.byUsername(h.tenantId, 'una@acme.test')).toBeUndefined();

    platform.memberships = { organizations: [{ slug: 'elsewhere' }] };
    const outsider = await signIn({ id: 'p-4', email: 'olly@else.test' });
    expect(outsider.cb.status).toBe(400);
    expect(outsider.cb.text).toContain('not a member of an organisation');
    platform.memberships = { organizations: ['acme'] };

    // the state is bound to the browser that started, and single use
    const agent = request.agent(h.app);
    const start = await agent.get(`/federation/exprsn-platform/start?provider=${storeId}`).expect(302);
    const { code, state } = platform.authorize(start.headers.location!, { id: 'p-5', email: 'rae@acme.test' });
    expect((await request(h.app).get(`/federation/exprsn-platform/callback?${new URLSearchParams({ code, state })}`)).status).toBe(400);
    expect((await agent.get(`/federation/exprsn-platform/callback?${new URLSearchParams({ code, state })}`)).status).toBe(302);
    expect((await agent.get(`/federation/exprsn-platform/callback?${new URLSearchParams({ code, state })}`)).status).toBe(400);

    // a code obtained for another PKCE challenge (an intercepted code) does not exchange
    const a2 = request.agent(h.app);
    const s2 = await a2.get(`/federation/exprsn-platform/start?provider=${storeId}`).expect(302);
    const forged = new URL(s2.headers.location!);
    forged.searchParams.set('code_challenge', createHash('sha256').update('attacker-verifier').digest('base64url'));
    const stolen = platform.authorize(forged.toString(), { id: 'p-6', email: 'sid@acme.test' });
    const bad = await a2.get(`/federation/exprsn-platform/callback?${new URLSearchParams({ code: stolen.code, state: stolen.state })}`);
    expect(bad.status).toBe(400);
    expect(bad.text).toContain('PKCE verification failed');

    // the platform's own refusal is shown
    const a3 = request.agent(h.app);
    const s3 = await a3.get(`/federation/exprsn-platform/start?provider=${storeId}`).expect(302);
    const st3 = new URL(s3.headers.location!).searchParams.get('state')!;
    const denied = await a3.get(`/federation/exprsn-platform/callback?${new URLSearchParams({ error: 'access_denied', error_description: 'The user denied access', state: st3 })}`);
    expect(denied.status).toBe(400);
    expect(denied.text).toContain('access_denied');

    // a username already linked to the local store is refused, not merged
    await localUser(h, 'tess@acme.test', ['member']);
    const clash = await signIn({ id: 'p-7', email: 'tess@acme.test', organizations: ['acme'] });
    expect(clash.cb.status).toBe(403);
    expect(clash.cb.text).toContain('already linked');

    // a disabled store does not start a sign-in
    await send(root, 'patch', `/api/admin/identity-providers/${storeId}`, { enabled: false }).expect(200);
    const off = await request(h.app).get(`/federation/exprsn-platform/start?provider=${storeId}`);
    expect(off.status).toBe(502);
    expect(off.text).toContain('not available');
    const failed = await h.s.audit.list(h.tenantId, { action: 'auth.login.failed' });
    expect(failed.length).toBeGreaterThan(3);
  });
});
