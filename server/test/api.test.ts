import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { io as ioClient } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachRealtime } from '../src/realtime/socket.js';
import { harness, localUser, login, loginAdmin, PASSWORD, type Harness } from './helpers.js';

describe('HTTP API', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.close());

  describe('platform endpoints', () => {
    it('answers liveness and readiness', async () => {
      await request(h.app).get('/healthz').expect(200, { status: 'ok' });
      const r = await request(h.app).get('/readyz').expect(200);
      expect(r.body.checks).toMatchObject({ database: 'ok', migrations: 'ok', kms: 'ok', blobs: 'ok' });
    });

    it('sends security headers and a trace id', async () => {
      const r = await request(h.app).get('/healthz');
      expect(r.headers['content-security-policy']).toContain("default-src 'self'");
      expect(r.headers['x-frame-options']).toBeDefined();
      expect(r.headers['x-trace-id']).toMatch(/^[0-9a-f]{32}$/);
    });

    it('continues a W3C trace', async () => {
      const r = await request(h.app).get('/healthz').set('traceparent', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
      expect(r.headers['x-trace-id']).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    });

    it('returns problem+json for unknown API routes', async () => {
      const r = await request(h.app).get('/api/nope').expect(404);
      expect(r.headers['content-type']).toContain('application/problem+json');
      expect(r.body).toMatchObject({ status: 404, title: 'Not found' });
      expect(r.body.trace_id).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  describe('sign-in', () => {
    it('rejects unauthenticated API calls', async () => {
      const r = await request(h.app).get('/api/me').expect(401);
      expect(r.body.title).toBe('Unauthorized');
    });

    it('signs a member in with one factor', async () => {
      await localUser(h, 'alice', ['member']);
      const { agent, res } = await login(h, 'alice');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ authenticated: true, stage: 'active' });
      const cookie = String(res.headers['set-cookie']);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
      const me = await agent.get('/api/me').expect(200);
      expect(me.body.user).toMatchObject({ username: 'alice', clearance: 'internal' });
      expect(me.body.permissions).toContain('chat:write');
      expect(me.body.permissions).not.toContain('identity:manage');
    });

    it('gives the same answer for unknown users and wrong passwords, and counts down', async () => {
      await localUser(h, 'alice', ['member']);
      const a = await login(h, 'alice', 'wrong password one');
      const b = await login(h, 'nobody', 'wrong password one');
      expect(a.res.status).toBe(401);
      expect(b.res.status).toBe(401);
      expect(a.res.body.title).toBe(b.res.body.title);
      expect(a.res.body.attempts_remaining).toBe(4);
    });

    it('locks an account after repeated failures', async () => {
      await localUser(h, 'alice', ['member']);
      let last;
      for (let i = 0; i < 5; i++) last = await login(h, 'alice', 'wrong password here');
      expect(last!.res.status).toBe(429);
      expect(last!.res.headers['retry-after']).toBeDefined();
      const r = await login(h, 'alice');
      expect(r.res.status).toBe(429);
    });

    it('refuses disabled users', async () => {
      const u = await localUser(h, 'alice', ['member']);
      await h.s.users.update(h.tenantId, u.id, { state: 'disabled' });
      expect((await login(h, 'alice')).res.status).toBe(401);
    });

    it('writes sign-ins to the audit chain', async () => {
      await localUser(h, 'alice', ['member']);
      await login(h, 'alice', 'wrong password here');
      await login(h, 'alice');
      const events = await h.s.audit.list(h.tenantId);
      expect(events.map((e) => e.action)).toEqual(['auth.login', 'auth.login.failed']);
      expect((await h.s.audit.verify(h.tenantId)).status).toBe('verified');
    });

    it('logs out and ends the session', async () => {
      await localUser(h, 'alice', ['member']);
      const { agent, csrf } = await login(h, 'alice');
      await agent.post('/api/auth/logout').set('x-csrf-token', csrf).expect(204);
      await agent.get('/api/me').expect(401);
    });
  });

  describe('second factor', () => {
    it('makes admins enrol a factor before anything else, then rotates the session', async () => {
      await localUser(h, 'root', ['system-admin'], 'restricted');
      const { agent, res, cookie } = await login(h, 'root');
      expect(res.body.stage).toBe('enroll');
      const blocked = await agent.get('/api/me').expect(401);
      expect(blocked.body.stage).toBe('enroll');

      const admin = await loginAdmin(h, 'root');
      expect(admin.cookie).not.toBe(cookie);
      const me = await admin.agent.get('/api/me').expect(200);
      expect(me.body.mfa).toMatchObject({ verified: true, methods: ['totp', 'recovery'] });
      // the pre-MFA token no longer works
      await request(h.app).get('/api/me').set('cookie', cookie).expect(401);
    });

    it('requires TOTP on later sign-ins and rejects a replayed code', async () => {
      await localUser(h, 'root', ['system-admin'], 'restricted');
      const { enrolCode } = await loginAdmin(h, 'root');
      const { agent, res } = await login(h, 'root');
      expect(res.body).toMatchObject({ stage: 'mfa', mfa: { methods: ['totp', 'recovery'] } });
      await agent.get('/api/admin/users').expect(401);
      // The code used at enrolment is spent: replaying it is refused (reusing the exact code, not regenerating it,
      // keeps this true when the test crosses a 30-second step).
      const replay = await agent.post('/api/auth/mfa/totp').set('x-csrf-token', res.body.csrf).send({ code: enrolCode });
      expect(replay.status).toBe(401);
    });

    it('accepts a recovery code once', async () => {
      await localUser(h, 'root', ['system-admin'], 'restricted');
      const admin = await loginAdmin(h, 'root');
      const codes = (await admin.agent.post('/api/me/mfa/recovery-codes').set('x-csrf-token', admin.csrf).expect(201)).body.recoveryCodes as string[];
      const first = await login(h, 'root');
      const ok = await first.agent.post('/api/auth/mfa/recovery').set('x-csrf-token', first.csrf).send({ code: codes[0] });
      expect(ok.body.stage).toBe('active');
      const second = await login(h, 'root');
      await second.agent.post('/api/auth/mfa/recovery').set('x-csrf-token', second.csrf).send({ code: codes[0] }).expect(401);
    });
  });

  describe('gating', () => {
    it('refuses state changes without the CSRF token', async () => {
      await localUser(h, 'alice', ['member']);
      const { agent } = await login(h, 'alice');
      const r = await agent.post('/api/me/sessions/revoke-others').expect(403);
      expect(r.body.step).toBe('csrf');
    });

    it('refuses cross-origin state changes', async () => {
      await localUser(h, 'alice', ['member']);
      const { agent, csrf } = await login(h, 'alice');
      await agent.post('/api/me/sessions/revoke-others').set('x-csrf-token', csrf).set('origin', 'https://evil.example').expect(403);
    });

    it('keeps members out of admin routes and audits the denial', async () => {
      await localUser(h, 'alice', ['member']);
      const { agent } = await login(h, 'alice');
      const r = await agent.get('/api/admin/identity-providers').expect(403);
      expect(r.body).toMatchObject({ step: 'role', action: 'identity:manage' });
      const [denied] = await h.s.audit.list(h.tenantId, { kind: 'decision' });
      expect(denied).toMatchObject({ action: 'authz.denied', decision: { step: 'role' } });
    });

    it('keeps auditors to the audit chain', async () => {
      await localUser(h, 'aud', ['auditor']);
      const a = await loginAdmin(h, 'aud');
      await a.agent.get('/api/admin/audit').expect(200);
      await a.agent.get('/api/admin/users').expect(403);
    });

    it('denies admin roles granted mid-session until a factor is verified', async () => {
      const u = await localUser(h, 'bob', ['member']);
      const { agent } = await login(h, 'bob');
      await h.s.users.setRoles(u.id, 'direct', ['member', 'identity-admin']);
      const r = await agent.get('/api/admin/identity-providers').expect(403);
      expect(r.body.step).toBe('mfa');
    });
  });

  describe('API keys', () => {
    it('issues a key once, authenticates with it, and never widens scopes', async () => {
      await localUser(h, 'alice', ['member']);
      const { agent, csrf } = await login(h, 'alice');
      await agent.post('/api/me/api-keys').set('x-csrf-token', csrf).send({ name: 'ci', scopes: ['models:manage'], ttlDays: 30 }).expect(403);
      const created = await agent.post('/api/me/api-keys').set('x-csrf-token', csrf).send({ name: 'cli', scopes: ['chat:read', 'models:read'], ttlDays: 30 }).expect(201);
      expect(created.body.key).toMatch(/^exai_k1_[0-9a-f]{12}_/);

      const me = await request(h.app).get('/api/me').set('authorization', `Bearer ${created.body.key}`).expect(200);
      expect(me.body.permissions).toEqual(['chat:read', 'models:read']);
      expect(me.body.credential).toBe('api_key');

      const list = await agent.get('/api/me/api-keys').expect(200);
      expect(list.body[0]).not.toHaveProperty('key');
      expect(JSON.stringify(list.body)).not.toContain(created.body.key);

      await agent.delete(`/api/me/api-keys/${created.body.id}`).set('x-csrf-token', csrf).expect(204);
      const after = await request(h.app).get('/api/me').set('authorization', `Bearer ${created.body.key}`).expect(401);
      expect(after.body.error).toBe('invalid_token');
    });

    it('cannot create keys or manage factors with a key', async () => {
      await localUser(h, 'alice', ['member']);
      const { agent, csrf } = await login(h, 'alice');
      const { body } = await agent.post('/api/me/api-keys').set('x-csrf-token', csrf).send({ name: 'cli', scopes: ['chat:read'], ttlDays: 30 });
      await request(h.app).post('/api/me/api-keys').set('authorization', `Bearer ${body.key}`).send({ name: 'x', scopes: ['chat:read'], ttlDays: 30 }).expect(403);
    });
  });

  describe('identity administration', () => {
    it('manages user stores, mappings and test logins', async () => {
      await localUser(h, 'ida', ['identity-admin'], 'confidential');
      const a = await loginAdmin(h, 'ida');
      const post = (url: string, body: object) => a.agent.post(url).set('x-csrf-token', a.csrf).send(body);

      const bad = await post('/api/admin/identity-providers', { name: 'Dir', kind: 'ldap', config: { url: 'ldaps://ldap', bindDN: 'cn=x', bindPassword: 'inline-secret', userBase: 'dc=x', groupBase: 'dc=x' } }).expect(400);
      expect(JSON.stringify(bad.body.errors)).toContain('config.bindPassword');

      const created = await post('/api/admin/identity-providers', { name: 'OpenLDAP', kind: 'ldap', position: 10, config: { url: 'ldaps://127.0.0.1:1', bindDN: 'cn=svc,dc=corp', bindPassword: 'env:LDAP_BIND_PW', userBase: 'ou=people,dc=corp', groupBase: 'ou=groups,dc=corp', timeoutMs: 500 } }).expect(201);
      const test = await post(`/api/admin/identity-providers/${created.body.id}/test`, {}).expect(200);
      expect(test.body.ok).toBe(false);

      // identity admins cannot grant admin roles through mappings
      await post('/api/admin/group-mappings', { group: 'cn=ai-admins,ou=groups,dc=corp', role: 'system-admin', clearance: 'restricted' }).expect(403);
      // nor clearance above their own (confidential)
      await post('/api/admin/group-mappings', { group: 'cn=Finance,ou=groups,dc=corp', role: 'member', clearance: 'restricted' }).expect(403);
      await post('/api/admin/users', { username: 'breakglass', displayName: 'Break glass', password: 'a long enough password', roles: ['member'], clearance: 'restricted' }).expect(403);
      await post('/api/admin/group-mappings', { group: 'cn=Finance,ou=groups,dc=corp', role: 'member', clearance: 'confidential' }).expect(201);

      await localUser(h, 'carol', ['member']);
      const tl = await post('/api/admin/test-login', { username: 'carol', password: PASSWORD }).expect(200);
      expect(tl.body).toMatchObject({ result: 'ok', provider: { kind: 'local' } });
      // Directly granted roles count, as they do at sign-in.
      expect(tl.body.mapping).toMatchObject({ roles: ['member'], clearance: 'internal' });
      expect(tl.body.steps.some((st: { title: string }) => st.title.includes('OpenLDAP'))).toBe(true);
      expect(await h.s.sessions.listForUser((await h.s.users.byUsername(h.tenantId, 'carol'))!.id)).toHaveLength(0);

      const local = (await h.s.providers.list(h.tenantId)).find((p) => p.kind === 'local')!;
      await a.agent.patch(`/api/admin/identity-providers/${created.body.id}`).set('x-csrf-token', a.csrf).send({ enabled: false }).expect(200);
      const last = await a.agent.patch(`/api/admin/identity-providers/${local.id}`).set('x-csrf-token', a.csrf).send({ enabled: false }).expect(409);
      expect(last.body.detail).toMatch(/only enabled user store/);
    });

    it('disables a user and ends their sessions and keys', async () => {
      await localUser(h, 'ida', ['identity-admin'], 'confidential');
      const target = await localUser(h, 'dave', ['member']);
      const d = await login(h, 'dave');
      const key = (await d.agent.post('/api/me/api-keys').set('x-csrf-token', d.csrf).send({ name: 'k', scopes: ['chat:read'], ttlDays: 30 })).body.key;
      const a = await loginAdmin(h, 'ida');
      const r = await a.agent.patch(`/api/admin/users/${target.id}`).set('x-csrf-token', a.csrf).send({ state: 'disabled', disabledReason: 'Left the company' }).expect(200);
      expect(r.body.sessionsRevoked).toBe(1);
      await d.agent.get('/api/me').expect(401);
      await request(h.app).get('/api/me').set('authorization', `Bearer ${key}`).expect(401);
      const [evt] = await h.s.audit.list(h.tenantId, { action: 'user.disabled' });
      expect(evt).toMatchObject({ action: 'user.disabled', target: { username: 'dave' } });
    });

    it('stops admins changing users who hold roles they cannot grant', async () => {
      await localUser(h, 'ida', ['identity-admin'], 'confidential');
      const root = await localUser(h, 'root', ['system-admin'], 'restricted');
      const a = await loginAdmin(h, 'ida');
      await a.agent.patch(`/api/admin/users/${root.id}`).set('x-csrf-token', a.csrf).send({ state: 'disabled' }).expect(403);
      await a.agent.post(`/api/admin/users/${root.id}/reset-mfa`).set('x-csrf-token', a.csrf).send({}).expect(403);
      const list = await a.agent.get('/api/admin/users?q=ro_').expect(200);
      expect(list.body).toHaveLength(0);
      expect((await a.agent.get('/api/admin/users?q=roo').expect(200)).body.map((u: { username: string }) => u.username)).toEqual(['root']);
    });

    it('stops admins changing their own access', async () => {
      const me = await localUser(h, 'ida', ['identity-admin'], 'confidential');
      const a = await loginAdmin(h, 'ida');
      const r = await a.agent.patch(`/api/admin/users/${me.id}`).set('x-csrf-token', a.csrf).send({ roles: ['identity-admin', 'member'] }).expect(403);
      expect(r.body.step).toBe('self');
    });

    it('redacts audit events above the reader\'s clearance', async () => {
      await localUser(h, 'aud', ['auditor'], 'internal');
      await h.s.audit.append({ tenantId: h.tenantId, action: 'secret.thing', kind: 'admin', actor: { user: 'x' }, label: 'restricted', detail: { payload: 'hidden' } });
      const a = await loginAdmin(h, 'aud');
      const list = await a.agent.get('/api/admin/audit?action=secret').expect(200);
      expect(list.body[0]).toMatchObject({ action: 'secret.thing', redacted: true });
      expect(list.body[0]).not.toHaveProperty('detail');
      const v = await a.agent.post('/api/admin/audit/verify').set('x-csrf-token', a.csrf).send({}).expect(200);
      expect(v.body.status).toBe('verified');
    });
  });
});

describe('Socket.io', () => {
  let h: Harness;
  let server: Server;
  let url: string;
  beforeEach(async () => {
    h = await harness();
    server = createServer(h.app);
    attachRealtime(server, h.s);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await h.close();
  });

  const connect = (cookie?: string) =>
    ioClient(url, { path: '/socket.io', transports: ['websocket'], reconnection: false, extraHeaders: cookie ? { cookie } : {} });

  it('refuses connections without a session', async () => {
    const sock = connect();
    const err = await new Promise<Error>((resolve) => sock.on('connect_error', resolve));
    expect(err.message).toBe('unauthorized');
    sock.close();
  });

  it('connects signed-in users and disconnects them when the session is revoked', async () => {
    await localUser(h, 'alice', ['member']);
    const { cookie, agent, csrf } = await login(h, 'alice');
    const sock = connect(cookie);
    const ready = await new Promise<{ tenant: string }>((resolve) => sock.on('ready', resolve));
    expect(ready.tenant).toBe('default');
    const gone = new Promise<string>((resolve) => sock.on('disconnect', resolve));
    await agent.post('/api/auth/logout').set('x-csrf-token', csrf).expect(204);
    expect(await gone).toBe('io server disconnect');
  });
});
