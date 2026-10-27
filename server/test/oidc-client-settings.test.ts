import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { down as down130, up as up130 } from '../src/db/migrations/130_oidc_client_settings.js';
import { decodeJwt } from '../src/federation/jose.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';

/*
 * 1.9.0, Sprint 55 (B-191): OAuth and OIDC provider settings per tenant and per client. The migration is applied here
 * (it is registered by the owner); the last block runs without it.
 */

const REDIRECT = 'https://app.example.test/cb';
const b64u = (b: Buffer) => b.toString('base64url');
const pkce = () => {
  const verifier = b64u(randomBytes(48));
  return { verifier, challenge: b64u(createHash('sha256').update(verifier).digest()) };
};
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

describe('B-191: OAuth client settings', () => {
  let h: Harness;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let member: Awaited<ReturnType<typeof login>>;
  const as = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, body?: object) => {
    const r = admin.agent[method](path).set('x-csrf-token', admin.csrf);
    return body ? r.send(body) : r;
  };
  const createClient = async (body: object) => {
    const res = await as('post', '/api/admin/federation/oidc/clients', body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { client: { id: string; clientId: string; accessTtl: number }; secret: string | null };
  };
  const settings = async (id: string, body: object) => {
    const res = await as('put', `/api/admin/federation/oidc/clients/${id}/settings`, body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  };
  const authorize = (clientId: string, extra: Record<string, string> = {}) => {
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: 'openid chat:read', state: 's', nonce: 'n', ...extra });
    return member.agent.get(`/oauth/authorize?${q}`);
  };
  const codeFlow = async (c: { client: { clientId: string }; secret: string | null }) => {
    const { verifier, challenge } = pkce();
    const res = await authorize(c.client.clientId, { code_challenge: challenge, code_challenge_method: 'S256' });
    expect(res.status, res.text.slice(0, 300)).toBe(302);
    const code = new URL(res.headers.location!).searchParams.get('code')!;
    const tok = request(h.app).post('/oauth/token').type('form');
    if (c.secret) tok.set('authorization', basic(c.client.clientId, c.secret));
    return tok.send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, ...(c.secret ? {} : { client_id: c.client.clientId }) });
  };
  const refresh = (c: { client: { clientId: string }; secret: string | null }, token: string) => {
    const r = request(h.app).post('/oauth/token').type('form');
    if (c.secret) r.set('authorization', basic(c.client.clientId, c.secret));
    return r.send({ grant_type: 'refresh_token', refresh_token: token, ...(c.secret ? {} : { client_id: c.client.clientId }) });
  };

  beforeAll(async () => {
    h = await harness();
    await down130(h.s.db);
    await up130(h.s.db);
    await localUser(h, 'oadmin', ['identity-admin', 'member']);
    await localUser(h, 'omember', ['member']);
    admin = await loginAdmin(h, 'oadmin');
    member = await login(h, 'omember');
  });
  afterAll(async () => h.close());

  it('starts from today\'s values', async () => {
    const view = (await as('get', '/api/admin/signin-policy')).body;
    expect(view.oauth.available).toBe(true);
    expect(view.oauth.effective).toMatchObject({ codeTtl: 60, accessTtl: 600, refreshTtl: 8 * 3600, pkce: 'public', ratePerMinute: null, rotation: 'rotate' });
    const c = await createClient({ name: 'Plain app', type: 'confidential, BFF', redirectUris: [REDIRECT], scopes: ['openid', 'chat:read'], grants: ['authorization_code', 'refresh_token'] });
    expect(c.client.accessTtl).toBe(600);
    const s = (await as('get', `/api/admin/federation/oidc/clients/${c.client.id}/settings`)).body;
    expect(s.effective).toMatchObject({ codeTtl: 60, accessTtl: 600, refreshTtl: 8 * 3600, pkceRequired: true, consent: 'tenant', ratePerMinute: null, rotation: 'rotate' });
  });

  it('sets code, access and refresh lifetimes per tenant and per client', async () => {
    expect((await as('put', '/api/admin/signin-policy/oauth', { accessTtl: 4000 })).status).toBe(400);
    const d = await as('put', '/api/admin/signin-policy/oauth', { codeTtl: 30, accessTtl: 900, refreshTtl: 7200 });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const c = await createClient({ name: 'Lifetimes app', type: 'confidential, BFF', redirectUris: [REDIRECT], scopes: ['openid', 'chat:read'], grants: ['authorization_code', 'refresh_token'] });
    expect(c.client.accessTtl).toBe(900);
    let tok = await codeFlow(c);
    expect(tok.status, JSON.stringify(tok.body)).toBe(200);
    expect(tok.body.expires_in).toBe(900);
    const code = (await h.s.db('oidc_codes').where({ client_id: c.client.clientId }).orderBy('expires_at', 'desc').first()) as { expires_at: number };
    expect(Number(code.expires_at) - Date.now()).toBeLessThanOrEqual(30_000);
    expect(Number(code.expires_at) - Date.now()).toBeGreaterThan(20_000);
    // The client's own values.
    const v = await settings(c.client.id, { codeTtl: 15, accessTtl: 300, refreshTtl: 3600 });
    expect(v.effective).toMatchObject({ codeTtl: 15, accessTtl: 300, refreshTtl: 3600 });
    expect(v.effective.sources.codeTtl).toBe('client');
    tok = await codeFlow(c);
    expect(tok.body.expires_in).toBe(300);
    const claims = decodeJwt(tok.body.access_token).claims;
    expect(Number(claims.exp) - Number(claims.iat)).toBe(300);
    const fam = (await h.s.db('oidc_refresh_tokens').where({ client_id: c.client.clientId }).orderBy('created_at', 'desc').first()) as { expires_at: number; family_created_at: number };
    expect(Number(fam.expires_at) - Number(fam.family_created_at)).toBe(3600_000);
    expect((await as('put', `/api/admin/federation/oidc/clients/${c.client.id}/settings`, { codeTtl: 5 })).status).toBe(400);
    const audit = await h.s.db('audit_events').where({ tenant_id: h.tenantId }).whereIn('action', ['oidc.client.settings.updated', 'oidc.client.settings.defaults_updated']);
    expect(audit.length).toBe(2);
    await as('put', '/api/admin/signin-policy/oauth', {});
  });

  it('requires PKCE for every client, or only for public ones', async () => {
    const c = await createClient({ name: 'No PKCE app', type: 'confidential, BFF', redirectUris: [REDIRECT], scopes: ['openid', 'chat:read'], grants: ['authorization_code'], pkceRequired: false });
    const plain = await authorize(c.client.clientId);
    expect(plain.status).toBe(302);
    expect(new URL(plain.headers.location!).searchParams.get('code')).toBeTruthy();
    await as('put', '/api/admin/signin-policy/oauth', { pkce: 'all' });
    const refused = await authorize(c.client.clientId);
    expect(refused.status).toBe(302);
    expect(new URL(refused.headers.location!).searchParams.get('error')).toBe('invalid_request');
    expect((await as('get', `/api/admin/federation/oidc/clients/${c.client.id}/settings`)).body.effective.sources.pkceRequired).toBe('tenant');
    await as('put', '/api/admin/signin-policy/oauth', { pkce: 'public' });
    expect((await authorize(c.client.clientId)).headers.location).toContain('code=');
    const pub = await createClient({ name: 'Public app', type: 'public', redirectUris: [REDIRECT], scopes: ['openid', 'chat:read'], grants: ['authorization_code', 'refresh_token'] });
    expect((await as('put', `/api/admin/federation/oidc/clients/${pub.client.id}/settings`, { pkceRequired: false })).status).toBe(409);
    const pubRefused = await authorize(pub.client.clientId);
    expect(new URL(pubRefused.headers.location!).searchParams.get('error')).toBe('invalid_request');
  });

  it('shows, records and withdraws consent, with the screen on or off per client', async () => {
    const c = await createClient({ name: 'Ledger Notes', type: 'third party', redirectUris: [REDIRECT], scopes: ['openid', 'chat:read'], grants: ['authorization_code', 'refresh_token'] });
    const { challenge } = pkce();
    const page = await authorize(c.client.clientId, { code_challenge: challenge, code_challenge_method: 'S256' });
    expect(page.status).toBe(200);
    expect(page.text).toContain('Allow Ledger Notes');
    const handle = /name="handle" value="([^"]+)"/.exec(page.text)![1]!;
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.text)![1]!;
    const allow = await member.agent.post('/oauth/authorize').type('form').send({ handle, csrf, decision: 'allow' });
    expect(allow.status).toBe(302);
    expect(await h.s.db('oidc_consents').where({ client_id: c.client.clientId })).toHaveLength(1);
    // Listed in Settings, and withdrawn there.
    const grants = (await member.agent.get('/api/me/grants')).body as { clientId: string; consentedAt: number | null }[];
    expect(grants.find((g) => g.clientId === c.client.clientId)?.consentedAt).toBeTruthy();
    const out = await member.agent.delete(`/api/me/grants/${c.client.clientId}`).set('x-csrf-token', member.csrf);
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(await h.s.db('oidc_consents').where({ client_id: c.client.clientId })).toHaveLength(0);
    const actions = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).whereIn('action', ['oidc.consent.granted', 'oidc.consent.withdrawn'])).map((x: { action: string }) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['oidc.consent.granted', 'oidc.consent.withdrawn']));
    // Withdrawn: the screen is shown again.
    expect((await authorize(c.client.clientId, { code_challenge: pkce().challenge, code_challenge_method: 'S256' })).status).toBe(200);
    // Off for this client: no screen.
    await settings(c.client.id, { consent: 'off' });
    expect((await authorize(c.client.clientId, { code_challenge: pkce().challenge, code_challenge_method: 'S256' })).status).toBe(302);
    // On for a first-party client the tenant pre-consents: the screen is shown.
    const fp = await createClient({ name: 'Own portal', type: 'confidential, BFF', redirectUris: [REDIRECT], scopes: ['openid', 'chat:read'], grants: ['authorization_code'] });
    expect((await authorize(fp.client.clientId, { code_challenge: pkce().challenge, code_challenge_method: 'S256' })).status).toBe(302);
    await settings(fp.client.id, { consent: 'on' });
    expect((await authorize(fp.client.clientId, { code_challenge: pkce().challenge, code_challenge_method: 'S256' })).status).toBe(200);
  });

  it('limits each client\'s requests a minute', async () => {
    const c = await createClient({ name: 'Busy service', type: 'service account', scopes: ['chat:read'], grants: ['client_credentials'] });
    await settings(c.client.id, { ratePerMinute: 2 });
    const send = () => request(h.app).post('/oauth/token').set('authorization', basic(c.client.clientId, c.secret!)).type('form').send({ grant_type: 'client_credentials' });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    const third = await send();
    expect(third.status).toBe(429);
    expect(third.body.error).toBe('slow_down');
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    // Another client is not affected.
    const other = await createClient({ name: 'Quiet service', type: 'service account', scopes: ['chat:read'], grants: ['client_credentials'] });
    expect((await request(h.app).post('/oauth/token').set('authorization', basic(other.client.clientId, other.secret!)).type('form').send({ grant_type: 'client_credentials' })).status).toBe(200);
  });

  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const c = await createClient({ name: 'Rotating app', type: 'confidential, BFF', redirectUris: [REDIRECT], scopes: ['openid', 'chat:read', 'offline_access'], grants: ['authorization_code', 'refresh_token'] });
    const first = await codeFlow(c);
    expect(first.body.refresh_token).toBeTruthy();
    const second = await refresh(c, first.body.refresh_token);
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).toBeTruthy();
    expect(second.body.refresh_token).not.toBe(first.body.refresh_token);
    // The rotated token presented again: the whole family ends, the newest token with it.
    const reuse = await refresh(c, first.body.refresh_token);
    expect(reuse.status).toBe(400);
    expect(reuse.body.error).toBe('invalid_grant');
    expect((await refresh(c, second.body.refresh_token)).status).toBe(400);
    const view = (await as('get', `/api/admin/federation/oidc/clients/${c.client.id}/settings`)).body;
    expect(view.reusedFamilies).toHaveLength(1);
    expect(view.reusedFamilies[0]).toMatchObject({ reason: 'reuse' });
    expect(view.reusedFamilies[0].tokensRevoked).toBeGreaterThan(0);
    // A confidential client may keep its token instead (no rotation); a public client may not.
    await settings(c.client.id, { rotation: 'reuse' });
    const kept = await codeFlow(c);
    const again = await refresh(c, kept.body.refresh_token);
    expect(again.status).toBe(200);
    expect(again.body.refresh_token).toBeUndefined();
    expect((await refresh(c, kept.body.refresh_token)).status).toBe(200);
    const pub = await createClient({ name: 'Public rotating', type: 'public', redirectUris: [REDIRECT], scopes: ['openid', 'chat:read'], grants: ['authorization_code', 'refresh_token'] });
    expect((await as('put', `/api/admin/federation/oidc/clients/${pub.client.id}/settings`, { rotation: 'reuse' })).status).toBe(409);
  });

  it('needs identity:manage', async () => {
    expect((await member.agent.get('/api/admin/signin-policy')).status).toBe(403);
    const c = (await h.s.federation.oidc.listClients(h.tenantId))[0]!;
    expect((await member.agent.get(`/api/admin/federation/oidc/clients/${c.id}/settings`)).status).toBe(403);
  });
});

describe('B-191 before migration 130', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
    // without migration 130 (the harness runs it since it was registered)
    await down130(h.s.db);
    await localUser(h, 'nadmin', ['identity-admin', 'member']);
    await localUser(h, 'nmember', ['member']);
  });
  afterAll(async () => h.close());

  it('keeps today\'s lifetimes, PKCE and rotation', async () => {
    const admin = await loginAdmin(h, 'nadmin');
    const member = await login(h, 'nmember');
    const created = await admin.agent.post('/api/admin/federation/oidc/clients').set('x-csrf-token', admin.csrf).send({ name: 'Old app', type: 'confidential, BFF', redirectUris: [REDIRECT], scopes: ['openid', 'chat:read'], grants: ['authorization_code', 'refresh_token'] });
    expect(created.status).toBe(201);
    const { verifier, challenge } = pkce();
    const q = new URLSearchParams({ response_type: 'code', client_id: created.body.client.clientId, redirect_uri: REDIRECT, scope: 'openid chat:read', code_challenge: challenge, code_challenge_method: 'S256' });
    const res = await member.agent.get(`/oauth/authorize?${q}`);
    expect(res.status).toBe(302);
    const code = (await h.s.db('oidc_codes').first()) as { expires_at: number };
    expect(Number(code.expires_at) - Date.now()).toBeGreaterThan(50_000);
    const tok = await request(h.app).post('/oauth/token').set('authorization', basic(created.body.client.clientId, created.body.secret)).type('form').send({ grant_type: 'authorization_code', code: new URL(res.headers.location!).searchParams.get('code')!, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(tok.status).toBe(200);
    expect(tok.body.expires_in).toBe(600);
    const r2 = await request(h.app).post('/oauth/token').set('authorization', basic(created.body.client.clientId, created.body.secret)).type('form').send({ grant_type: 'refresh_token', refresh_token: tok.body.refresh_token });
    expect(r2.body.refresh_token).toBeTruthy();
    expect((await admin.agent.put(`/api/admin/federation/oidc/clients/${created.body.client.id}/settings`).set('x-csrf-token', admin.csrf).send({ codeTtl: 30 })).status).toBe(503);
  });
});
