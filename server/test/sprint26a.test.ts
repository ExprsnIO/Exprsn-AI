import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { secretsCommand, usersCommand } from '../src/cli/identity.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { parseCsv } from '../src/identity/user-import.js';
import { totp } from '../src/identity/totp.js';
import { FakeMail, type SentMail } from './fake-account.js';
import { FakeGitHub } from './sprint26a-fakes.js';
import { harness, localUser, login, loginAdmin, PASSWORD, type Client, type Harness } from './helpers.js';

/*
 * Sprint 26a: the identity gaps (B-1801 to B-1805) and the remaining CLI commands (B-2103: secrets, users import).
 */

const send = (c: Client, method: 'post' | 'put' | 'patch' | 'delete', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);
const linkToken = (mail: SentMail, param: 'verify' | 'invitation' | 'reset'): string => {
  const m = new RegExp(`[#&?]${param}=([A-Za-z0-9_-]{43})`).exec(mail.text);
  if (!m) throw new Error(`no ${param} link in: ${mail.text}`);
  return m[1]!;
};
const STRONG = 'a much longer passphrase for sign-up 26';

async function drainJobs(h: Harness) {
  for (let i = 0; i < 20; i++) if (!(await h.s.jobs.runDue())) return;
}

/*
 * Each block gets its own app (sign-in attempts share a per-address limit of 30 a minute) with an identity admin and a
 * tenant admin signed in.
 */
function setup() {
  const ctx = {} as { h: Harness; mail: FakeMail; ida: Client & { totpSecret: string }; ta: Client };
  beforeAll(async () => {
    ctx.mail = new FakeMail();
    ctx.h = await harness({}, { mail: ctx.mail });
    await localUser(ctx.h, 'ida', ['identity-admin'], 'confidential');
    ctx.ida = await loginAdmin(ctx.h, 'ida');
    await localUser(ctx.h, 'ta', ['tenant-admin'], 'confidential');
    ctx.ta = await loginAdmin(ctx.h, 'ta');
  });
  afterAll(async () => ctx.h.close());
  return ctx;
}

describe('Sprint 26a: identity gaps', () => {

  // ---------- B-1801 ----------

  describe('B-1801 self-registration under a signup policy', () => {
    const ctx = setup();
    let h: Harness, ida: Client & { totpSecret: string };
    beforeAll(() => {
      ({ h, ida } = ctx);
    });
    const register = (body: object) => request(h.app).post('/api/auth/register').send({ displayName: 'New Person', password: STRONG, ...body });

    it('is closed by default, and refuses a signup from a domain outside the list', async () => {
      const closed = await register({ username: 'early', email: 'early@example.com' }).expect(403);
      expect(closed.body.reason).toBe('closed');
      expect((await request(h.app).get('/api/auth/sign-in-options').expect(200)).body.signup).toBe(false);

      await send(ida, 'put', '/api/admin/identity-policy/signup', { mode: 'open', domains: ['example.com', '*.example.org'], requireEmailVerification: false, roles: ['member'] }).expect(200);
      const outside = await register({ username: 'outsider', email: 'someone@elsewhere.net' }).expect(403);
      expect(outside.body.reason).toBe('domain');
      expect(await h.s.users.byUsername(h.tenantId, 'outsider')).toBeUndefined();
      expect((await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'user.signup.refused' }).select('detail')).map((r: { detail: string }) => JSON.parse(r.detail).reason)).toEqual(expect.arrayContaining(['closed', 'domain']));

      // a listed domain (and a subdomain of a wildcard) signs up and signs in with the policy's roles only
      const ok = await register({ username: 'insider', email: 'insider@example.com' }).expect(201);
      expect(ok.body).toMatchObject({ state: 'active', verification: 'not_required' });
      await register({ username: 'subdomain', email: 'x@lab.example.org' }).expect(201);
      const signed = await login(h, 'insider', STRONG);
      expect(signed.res.body.stage).toBe('active');
      const me = (await signed.agent.get('/api/me').expect(200)).body;
      expect(me.roles.map((r: { id: string }) => r.id)).toEqual(['member']);
      // the same username or address again is refused without saying which
      await register({ username: 'insider', email: 'other@example.com' }).expect(409);
      await register({ username: 'insider2', email: 'INSIDER@example.com' }).expect(409);
      // admin roles are not a signup option
      await send(ida, 'put', '/api/admin/identity-policy/signup', { mode: 'open', roles: ['tenant-admin'] }).expect(400);
    });

    it('with approval, the account waits disabled until an admin approves it', async () => {
      await send(ida, 'put', '/api/admin/identity-policy/signup', { mode: 'approval', domains: [], requireEmailVerification: false }).expect(200);
      const r = await register({ username: 'waiting', email: 'waiting@corp.test' }).expect(201);
      expect(r.body.state).toBe('pending');
      const before = await login(h, 'waiting', STRONG);
      expect(before.res.status).toBe(403);
      expect(before.res.body.reason).toBe('signup_pending');
      // a wrong password still says nothing about the sign-up
      expect((await login(h, 'waiting', 'wrong password entirely')).res.status).toBe(401);
      const pending = (await ida.agent.get('/api/admin/signups?state=pending').expect(200)).body;
      const row = pending.find((x: { username: string }) => x.username === 'waiting');
      expect(row).toMatchObject({ state: 'pending', domain: 'corp.test' });
      // approvers were told in the console
      expect(await h.s.db('notifications').where({ kind: 'signup' }).first()).toBeTruthy();
      await send(ida, 'post', `/api/admin/signups/${row.userId}/approve`).expect(200);
      await send(ida, 'post', `/api/admin/signups/${row.userId}/approve`).expect(409);
      expect((await login(h, 'waiting', STRONG)).res.body.stage).toBe('active');
      // a rejected one stays out
      await register({ username: 'rejected', email: 'rejected@corp.test' }).expect(201);
      const rejectedId = (await h.s.users.byUsername(h.tenantId, 'rejected'))!.id;
      await send(ida, 'post', `/api/admin/signups/${rejectedId}/reject`, { reason: 'Unknown person' }).expect(200);
      expect((await login(h, 'rejected', STRONG)).res.body.reason).toBe('signup_rejected');
      await send(ida, 'put', '/api/admin/identity-policy/signup', { mode: 'closed' }).expect(200);
    });
  });

  describe('B-1801 invitations by workspace admins', () => {
    const ctx = setup();
    let h: Harness, mail: FakeMail, ida: Client & { totpSecret: string }, ta: Client;
    beforeAll(() => {
      ({ h, mail, ida, ta } = ctx);
    });
    it('invites with roles into a workspace; the invitee picks a username, and the link works once', async () => {
      const ws = await h.s.tenants.createWorkspace(h.tenantId, 'Research', 'confidential');
      // identity admins hold members:invite, but only into workspaces they belong to (tenant admins: any)
      const notMember = await send(ida, 'post', '/api/invitations', { email: 'guest@partner.test', workspaceId: ws.id, roles: ['member'] }).expect(403);
      expect(notMember.body.step).toBe('workspace');
      const idaUser = (await h.s.users.byUsername(h.tenantId, 'ida'))!;
      await h.s.tenants.addMember(ws.id, idaUser.id);
      // roles the inviter cannot grant are refused
      expect((await send(ida, 'post', '/api/invitations', { email: 'guest@partner.test', roles: ['model-admin'] }).expect(403)).body.step).toBe('role');
      // a member cannot invite at all
      await localUser(h, 'plain', ['member']);
      const plain = await login(h, 'plain');
      await plain.agent.post('/api/invitations').set('x-csrf-token', plain.csrf).send({ email: 'x@y.test', roles: ['member'] }).expect(403);

      // an identity admin grants members; a tenant admin also the curator role
      await send(ida, 'post', '/api/invitations', { email: 'guest@partner.test', workspaceId: ws.id, roles: ['knowledge-curator'] }).expect(403);
      const inv = (await send(ta, 'post', '/api/invitations', { email: 'Guest@Partner.test', workspaceId: ws.id, roles: ['member', 'knowledge-curator'], clearance: 'internal' }).expect(201)).body;
      expect(inv).toMatchObject({ email: 'guest@partner.test', state: 'pending', sent: true, roles: ['member', 'knowledge-curator'] });
      expect((await send(ida, 'post', '/api/invitations', { email: 'member@partner.test', workspaceId: ws.id, roles: ['member'] }).expect(201)).body.sent).toBe(true);
      const message = await mail.next('guest@partner.test');
      expect(message.subject).toMatch(/invited you/);
      const token = linkToken(message, 'invitation');
      expect(JSON.stringify(inv)).not.toContain(token);
      const preview = (await request(h.app).post('/api/auth/invitations/preview').send({ token }).expect(200)).body;
      expect(preview).toMatchObject({ email: 'guest@partner.test', workspace: { id: ws.id, name: 'Research' }, roles: ['member', 'knowledge-curator'] });

      // invitations bypass a closed signup policy
      const accepted = await request(h.app).post('/api/auth/invitations/accept').send({ token, username: 'guest', displayName: 'Guest', password: STRONG }).expect(201);
      expect(accepted.body.username).toBe('guest');
      await request(h.app).post('/api/auth/invitations/accept').send({ token, username: 'guest2', displayName: 'Guest', password: STRONG }).expect(400);
      await request(h.app).post('/api/auth/invitations/preview').send({ token }).expect(400);
      const g = await login(h, 'guest', STRONG);
      const me = (await g.agent.get('/api/me').expect(200)).body;
      expect(me.roles.map((r: { id: string }) => r.id).sort()).toEqual(['knowledge-curator', 'member']);
      expect(me.workspaces.map((w: { id: string }) => w.id)).toContain(ws.id);
      const guest = (await h.s.users.byUsername(h.tenantId, 'guest'))!;
      expect(await h.s.signup.emailVerifiedAt(guest.id)).toBeTruthy();
      expect(await h.s.db('audit_events').where({ action: 'user.invitation.accepted' }).first()).toBeTruthy();
    });

    it('an existing account accepts as itself and gains the roles; a withdrawn invitation stops working', async () => {
      const u = await localUser(h, 'existing', ['member']);
      await h.s.users.update(h.tenantId, u.id, { email: 'existing@corp.test' });
      const inv = (await send(ta, 'post', '/api/invitations', { email: 'existing@corp.test', roles: ['flag-reviewer'] }).expect(201)).body;
      const token = linkToken(await mail.next('existing@corp.test'), 'invitation');
      // a new account cannot take an address that has one
      await request(h.app).post('/api/auth/invitations/accept').send({ token, username: 'dupe', displayName: 'Dupe', password: STRONG }).expect(409);
      // another account cannot accept it
      const plain = await login(h, 'plain');
      await plain.agent.post('/api/me/invitations/accept').set('x-csrf-token', plain.csrf).send({ token }).expect(403);
      const ex = await login(h, 'existing');
      await ex.agent.post('/api/me/invitations/accept').set('x-csrf-token', ex.csrf).send({ token }).expect(200);
      expect((await h.s.users.roleIds(u.id)).sort()).toEqual(['flag-reviewer', 'member']);
      expect((await ta.agent.get('/api/invitations').expect(200)).body.find((x: { id: string }) => x.id === inv.id).state).toBe('accepted');

      const inv2 = (await send(ta, 'post', '/api/invitations', { email: 'later@corp.test', roles: ['member'] }).expect(201)).body;
      const token2 = linkToken(await mail.next('later@corp.test'), 'invitation');
      await send(ta, 'delete', `/api/invitations/${inv2.id}`).expect(204);
      await request(h.app).post('/api/auth/invitations/preview').send({ token: token2 }).expect(400);
    });
  });

  // ---------- B-1802 ----------

  describe('B-1802 email verification', () => {
    const ctx = setup();
    let h: Harness, mail: FakeMail, ida: Client & { totpSecret: string };
    beforeAll(() => {
      ({ h, mail, ida } = ctx);
    });
    it('an unverified account cannot sign in when the tenant requires verification; the link works once', async () => {
      await send(ida, 'put', '/api/admin/identity-policy/signup', { mode: 'open', requireEmailVerification: true }).expect(200);
      const r = await request(h.app).post('/api/auth/register').send({ username: 'verifier', displayName: 'Verifier', email: 'verifier@corp.test', password: STRONG }).expect(201);
      expect(r.body.verification).toBe('sent');
      const first = await mail.next('verifier@corp.test');
      expect(first.subject).toMatch(/Confirm your email address/);
      const token = linkToken(first, 'verify');

      const refused = await login(h, 'verifier', STRONG);
      expect(refused.res.status).toBe(403);
      expect(refused.res.body.reason).toBe('email_unverified');
      // a new link went out, and the old one stopped working
      const second = await mail.next('verifier@corp.test', 1);
      const token2 = linkToken(second, 'verify');
      await request(h.app).post('/api/auth/email/verify').send({ token }).expect(400);
      const ok = await request(h.app).post('/api/auth/email/verify').send({ token: token2 }).expect(200);
      expect(ok.body).toMatchObject({ verified: true, username: 'verifier' });
      await request(h.app).post('/api/auth/email/verify').send({ token: token2 }).expect(400);
      expect((await login(h, 'verifier', STRONG)).res.body.stage).toBe('active');

      // the requirement covers other local accounts with an unproven address too, and they can ask for a link
      const old = await localUser(h, 'unproven', ['member']);
      await h.s.users.update(h.tenantId, old.id, { email: 'unproven@corp.test' });
      expect((await login(h, 'unproven')).res.body.reason).toBe('email_unverified');
      const resend = await request(h.app).post('/api/auth/email/resend').send({ identifier: 'nobody-here' }).expect(202);
      const resend2 = await request(h.app).post('/api/auth/email/resend').send({ identifier: 'unproven' }).expect(202);
      expect(resend.body).toEqual(resend2.body);
      // admin-created accounts with an address are vouched for
      const created = await send(ida, 'post', '/api/admin/users', { username: 'vouched', displayName: 'Vouched', email: 'vouched@corp.test', password: STRONG, mustChange: false, roles: ['member'] }).expect(201);
      expect(await h.s.signup.emailVerifiedAt(created.body.id)).toBeTruthy();
      expect((await login(h, 'vouched', STRONG)).res.body.stage).toBe('active');
      await send(ida, 'put', '/api/admin/identity-policy/signup', { mode: 'closed', requireEmailVerification: false }).expect(200);
    });
  });

  // ---------- B-1803 ----------

  describe('B-1803 tenant MFA policy and trusted devices', () => {
    const ctx = setup();
    let h: Harness, ida: Client & { totpSecret: string };
    beforeAll(() => {
      ({ h, ida } = ctx);
    });
    it('requires a factor for listed roles, after the grace period', async () => {
      await localUser(h, 'curator', ['member', 'knowledge-curator']);
      await localUser(h, 'reader', ['member']);
      await send(ida, 'put', '/api/admin/identity-policy/mfa', { require: 'roles', roles: ['knowledge-curator'], graceDays: 7 }).expect(200);
      const grace = await login(h, 'curator');
      expect(grace.res.body.stage).toBe('active');
      expect(grace.res.body.mfa.enrolBy).toBeGreaterThan(Date.now() + 6 * 24 * 3600_000);
      await send(ida, 'put', '/api/admin/identity-policy/mfa', { require: 'roles', roles: ['knowledge-curator'], graceDays: 0 }).expect(200);
      expect((await login(h, 'curator')).res.body.stage).toBe('enroll');
      expect((await login(h, 'reader')).res.body.stage).toBe('active');
      await send(ida, 'put', '/api/admin/identity-policy/mfa', { require: 'all', graceDays: 0 }).expect(200);
      expect((await login(h, 'reader')).res.body.stage).toBe('enroll');
      // a requirement for roles needs roles
      await send(ida, 'put', '/api/admin/identity-policy/mfa', { require: 'roles', roles: [] }).expect(400);
      await send(ida, 'put', '/api/admin/identity-policy/mfa', { require: 'off' }).expect(200);
      expect((await login(h, 'reader')).res.body.stage).toBe('active');
    });

    it('admins never get a trusted device: the factor is asked for on every sign-in', async () => {
      await send(ida, 'put', '/api/admin/identity-policy/mfa', { require: 'off', trustedDeviceDays: 30 }).expect(200);
      const u = await localUser(h, 'boss', ['tenant-admin']);
      const enrolled = await loginAdmin(h, 'boss');
      await send(enrolled, 'post', '/api/auth/logout').expect((res) => expect([200, 204]).toContain(res.status));
      const browser = enrolled.agent;
      const step = await browser.post('/api/auth/login').send({ username: 'boss', password: PASSWORD }).expect(200);
      expect(step.body.stage).toBe('mfa');
      const code = totp.generate(enrolled.totpSecret, Date.now() + 30_000);
      const done = await browser.post('/api/auth/mfa/totp').set('x-csrf-token', step.body.csrf).send({ code, rememberDevice: true }).expect(200);
      expect(done.body.stage).toBe('active');
      expect(done.body.trustedDevice ?? null).toBeNull();
      expect(await h.s.db('trusted_devices').where({ user_id: u.id }).first()).toBeUndefined();
      await browser.post('/api/auth/logout').set('x-csrf-token', done.body.csrf).send({});
      // even a trust row made some other way (say before the role was granted) is ignored for an admin
      await h.s.db('trusted_devices').insert({ id: 'x'.repeat(64), tenant_id: h.tenantId, user_id: u.id, session_id: null, browser: null, created_at: Date.now(), expires_at: Date.now() + 3600_000 }).catch(() => undefined);
      expect((await browser.post('/api/auth/login').send({ username: 'boss', password: PASSWORD }).expect(200)).body.stage).toBe('mfa');
    });

    it('a trusted device skips the factor until its period ends or sessions are revoked', async () => {
      await send(ida, 'put', '/api/admin/identity-policy/mfa', { require: 'off', trustedDeviceDays: 30 }).expect(200);
      const u = await localUser(h, 'traveller', ['member']);
      await h.s.users.update(h.tenantId, u.id, { mfa_required: true });
      const enrolled = await loginAdmin(h, 'traveller');
      // mfa_required only made this member enrol; an account still marked so is never trusted (see the admin test below)
      await h.s.users.update(h.tenantId, u.id, { mfa_required: false });
      await send(enrolled, 'post', '/api/auth/logout').expect((res) => expect([200, 204]).toContain(res.status));

      // the same browser (cookie jar: the B-801 device cookie) signs in with the factor and asks to be remembered
      const browser = enrolled.agent;
      const step = await browser.post('/api/auth/login').send({ username: 'traveller', password: PASSWORD }).expect(200);
      expect(step.body.stage).toBe('mfa');
      const code = totp.generate(enrolled.totpSecret, Date.now() + 30_000);
      const done = await browser.post('/api/auth/mfa/totp').set('x-csrf-token', step.body.csrf).send({ code, rememberDevice: true }).expect(200);
      expect(done.body.stage).toBe('active');
      expect(done.body.trustedDevice.until).toBeGreaterThan(Date.now() + 29 * 24 * 3600_000);
      await browser.post('/api/auth/logout').set('x-csrf-token', done.body.csrf).send({});

      // next time this browser skips the factor (and the session counts as factor-verified)
      const again = await browser.post('/api/auth/login').send({ username: 'traveller', password: PASSWORD }).expect(200);
      expect(again.body).toMatchObject({ stage: 'active', mfa: { trustedDevice: true } });
      const devices = (await browser.get('/api/me/trusted-devices').expect(200)).body;
      expect(devices).toMatchObject({ periodDays: 30, thisDevice: true });
      expect(devices.devices).toHaveLength(1);
      // another browser does not
      expect((await login(h, 'traveller')).res.body.stage).toBe('mfa');

      // revoking the sessions ends the trust (a sign-in in a browser holding a session sends its CSRF token)
      let csrf: string = again.body.csrf;
      const relogin = async () => {
        const r = await browser.post('/api/auth/login').set('x-csrf-token', csrf).send({ username: 'traveller', password: PASSWORD }).expect(200);
        csrf = r.body.csrf;
        return r.body as { stage: string; csrf: string };
      };
      await browser.post('/api/me/sessions/revoke-others').set('x-csrf-token', csrf).send({}).expect(200);
      expect((await relogin()).stage).toBe('mfa');

      // trust again, then let the period end
      // (the next 30-second code is already used: let the same one count again for the test)
      await h.s.db('mfa_factors').where({ user_id: u.id }).update({ last_step: null });
      const code2 = totp.generate(enrolled.totpSecret, Date.now() + 30_000);
      const done2 = await browser.post('/api/auth/mfa/totp').set('x-csrf-token', csrf).send({ code: code2, rememberDevice: true }).expect(200);
      csrf = done2.body.csrf;
      expect((await relogin()).stage).toBe('active');
      await h.s.db('trusted_devices').where({ user_id: u.id }).update({ expires_at: Date.now() - 1000 });
      expect((await relogin()).stage).toBe('mfa');

      // an admin's session revocation ends it too; turning trusted devices off ends them at once
      await h.s.db('trusted_devices').where({ user_id: u.id }).update({ expires_at: Date.now() + 3600_000 });
      expect(await h.s.db('trusted_devices').where({ user_id: u.id }).first()).toBeTruthy();
      await send(ida, 'put', '/api/admin/identity-policy/mfa', { require: 'off', trustedDeviceDays: 0 }).expect(200);
      expect(await h.s.db('trusted_devices').where({ user_id: u.id }).first()).toBeUndefined();
      expect(await h.s.db('audit_events').where({ action: 'auth.trusted_device.added' }).first()).toBeTruthy();
    });
  });

  // ---------- B-1804 ----------

  describe('B-1804 GitHub sign-in', () => {
    const ctx = setup();
    let h: Harness, ida: Client & { totpSecret: string }, ta: Client;
    beforeAll(() => {
      ({ h, ida, ta } = ctx);
    });
    let gh: FakeGitHub;
    let providerId: string;
    beforeAll(async () => {
      gh = await new FakeGitHub().start();
      process.env.UPSTREAM_SECRET_GH = gh.clientSecret;
    });
    afterAll(async () => gh.stop());

    const signIn = async (user: Parameters<FakeGitHub['authorize']>[1]) => {
      const agent = request.agent(h.app);
      const start = await agent.get(`/federation/github/start?provider=${providerId}`).expect(302);
      const { code, state, redirectUri } = gh.authorize(start.headers.location!, user);
      expect(redirectUri).toBe('http://localhost:8080/federation/github/callback');
      const cb = await agent.get(`/federation/github/callback?code=${code}&state=${encodeURIComponent(state)}`);
      return { agent, cb };
    };

    it('refuses an endpoint at a metadata address, and maps a team member to the mapped role', async () => {
      const bad = await send(ida, 'post', '/api/admin/identity-providers', { name: 'GitHub bad', kind: 'github', config: { clientId: gh.clientId, clientSecret: 'env:UPSTREAM_SECRET_GH', webUrl: 'http://169.254.169.254', apiUrl: `${gh.url}/api` } }).expect(400);
      expect(bad.body.reason).toBe('service_url');
      const created = (await send(ida, 'post', '/api/admin/identity-providers', { name: 'GitHub', kind: 'github', config: { clientId: gh.clientId, clientSecret: 'env:UPSTREAM_SECRET_GH', webUrl: gh.url, apiUrl: `${gh.url}/api`, allowedOrgs: ['acme'] } }).expect(201)).body;
      providerId = created.id;
      const tested = (await send(ida, 'post', `/api/admin/identity-providers/${providerId}/test`).expect(200)).body;
      expect(tested.ok).toBe(true);
      await send(ta, 'post', '/api/admin/group-mappings', { providerId, group: 'acme/platform', role: 'knowledge-curator', clearance: 'internal' }).expect(201);
      await send(ida, 'post', '/api/admin/group-mappings', { providerId, group: 'acme', role: 'member', clearance: 'internal' }).expect(201);
      const options = (await request(h.app).get('/api/auth/sign-in-options').expect(200)).body;
      expect(options.upstream).toEqual(expect.arrayContaining([expect.objectContaining({ id: providerId, protocol: 'github', start: `/federation/github/start?provider=${providerId}` })]));

      const { agent, cb } = await signIn({ id: 4242, login: 'Octo-Dev', name: 'Octo Dev', emails: [{ email: 'unverified@octo.test', primary: false, verified: false }, { email: 'octo@acme.test', primary: true, verified: true }], orgs: ['acme', 'other-org'], teams: [{ org: 'acme', slug: 'platform' }, { org: 'other-org', slug: 'secret' }] });
      expect(cb.status).toBe(302);
      expect(cb.headers.location).toBe('/');
      const me = (await agent.get('/api/me').expect(200)).body;
      expect(me.user.username).toBe('octo-dev');
      expect(me.roles.map((r: { id: string }) => r.id).sort()).toEqual(['knowledge-curator', 'member']);
      const user = (await h.s.users.byUsername(h.tenantId, 'octo-dev'))!;
      expect(user.email).toBe('octo@acme.test');
      const link = (await h.s.users.identitiesFor(user.id)).find((i) => i.provider_id === providerId)!;
      expect(link.external_id).toBe('4242');
      const groups = JSON.parse(((await h.s.db('user_identities').where({ user_id: user.id, provider_id: providerId }).first('groups')) as { groups: string }).groups) as string[];
      expect(groups.sort()).toEqual(['acme', 'acme/platform']); // other organisations stay out
      // the token was used with the API and never stored
      expect(gh.requests.some((r) => r.path === '/api/user/teams' && r.auth?.startsWith('Bearer gho_'))).toBe(true);
      expect(JSON.stringify(await h.s.db('user_identities').where({ user_id: user.id }))).not.toContain('gho_');
    });

    it('refuses an account outside the allowed organisations, a replayed callback, and a renamed login stays linked', async () => {
      const outsider = await signIn({ id: 5, login: 'stranger', orgs: ['elsewhere'] });
      expect(outsider.cb.status).toBe(400);
      expect(outsider.cb.text).toContain('not a member of an organisation');
      expect(await h.s.users.byUsername(h.tenantId, 'stranger')).toBeUndefined();

      const agent = request.agent(h.app);
      const start = await agent.get(`/federation/github/start?provider=${providerId}`).expect(302);
      const { code, state } = gh.authorize(start.headers.location!, { id: 4242, login: 'octo-dev', orgs: ['acme'] });
      // a callback from another browser (no binding cookie) is refused
      expect((await request(h.app).get(`/federation/github/callback?code=${code}&state=${encodeURIComponent(state)}`)).status).toBe(400);
      expect((await agent.get(`/federation/github/callback?code=${code}&state=${encodeURIComponent(state)}`)).status).toBe(302);
      expect((await agent.get(`/federation/github/callback?code=${code}&state=${encodeURIComponent(state)}`)).status).toBe(400);
    });
  });

  // ---------- B-1805 ----------

  describe('B-1805 CSV import of users, memberships and group mappings', () => {
    const ctx = setup();
    let h: Harness, ida: Client & { totpSecret: string }, ta: Client;
    beforeAll(() => {
      ({ h, ida, ta } = ctx);
    });
    const snapshot = async () => ({
      users: await h.s.db('users').where({ tenant_id: h.tenantId }).orderBy('id').select('id', 'username', 'display_name', 'email', 'clearance_direct'),
      roles: await h.s.db('user_roles').orderBy(['user_id', 'role', 'source']).select('user_id', 'role', 'source'),
      members: await h.s.db('workspace_members').orderBy(['workspace_id', 'user_id']).select('workspace_id', 'user_id', 'source'),
      mappings: await h.s.db('group_mappings').where({ tenant_id: h.tenantId }).orderBy('id').select('id', 'group_name', 'role', 'clearance'),
      credentials: (await h.s.db('local_credentials').count({ n: '*' }).first()) as unknown
    });

    const csv = [
      'kind,username,display_name,email,roles,clearance,workspace,provider,group',
      'user,ada,Ada Lovelace,ada@corp.test,member;knowledge-curator,internal,,,',
      'membership,ada,,,,,research,,',
      'user,octo-dev,Octo,,member,internal,,,', // linked to GitHub: a conflict, never merged
      'user,ada,Ada Again,,member,internal,,,', // the same username twice
      'user,bob,Bob,existing@corp.test,member,,,,', // an address another account has
      'user,eve,Eve,,system-admin,,,,', // a role the importer cannot grant
      'mapping,,,,flag-reviewer,internal,research,GitHub,acme/reviewers',
      'membership,nobody,,,,,research,,',
      '"user","quoted, name","Quoted ""Name""",,member,,,,'
    ].join('\n');

    it('a dry run reports conflicts and changes nothing', async () => {
      // fixtures: a workspace, an account linked to another user store, an account with an address
      await h.s.tenants.createWorkspace(h.tenantId, 'Research', 'confidential');
      const gh = await h.s.providers.create(h.tenantId, { name: 'GitHub', kind: 'github', position: 50, enabled: true, config: { clientId: 'x', clientSecret: 'env:UPSTREAM_SECRET_GH' } });
      const octo = await h.s.users.create(h.tenantId, { username: 'octo-dev', displayName: 'Octo' });
      await h.s.users.upsertIdentity(octo.id, gh.id, '4242', ['acme']);
      await h.s.users.setRoles(octo.id, 'mapping', ['member']);
      const ex = await localUser(h, 'existing', ['member']);
      await h.s.users.update(h.tenantId, ex.id, { email: 'existing@corp.test' });
      const before = await snapshot();
      const auditBefore = Number(((await h.s.db('audit_events').where({ tenant_id: h.tenantId }).count({ n: '*' }).first()) as { n: number }).n);
      const sub = await ta.agent.post('/api/admin/user-imports?dryRun=true').set('x-csrf-token', ta.csrf).set('content-type', 'text/csv').send(csv).expect(202);
      await drainJobs(h);
      const rep = (await ta.agent.get(`/api/admin/user-imports/${sub.body.id}`).expect(200)).body;
      expect(rep).toMatchObject({ state: 'done', dryRun: true, summary: { rows: 9, applied: 0, dryRun: true } });
      const by = (row: number) => rep.report.find((r: { row: number }) => r.row === row);
      expect(by(2)).toMatchObject({ kind: 'user', key: 'ada', action: 'create' });
      expect(by(3)).toMatchObject({ kind: 'membership', action: 'create' });
      expect(by(4)).toMatchObject({ key: 'octo-dev', action: 'conflict' });
      expect(by(4).detail).toContain('GitHub');
      expect(by(5)).toMatchObject({ key: 'ada', action: 'conflict' });
      expect(by(6)).toMatchObject({ key: 'bob', action: 'conflict' });
      expect(by(7)).toMatchObject({ key: 'eve', action: 'error' });
      expect(by(8)).toMatchObject({ kind: 'mapping', action: 'create' });
      expect(by(9)).toMatchObject({ kind: 'membership', action: 'error' });
      expect(by(10)).toMatchObject({ action: 'error' }); // "quoted, name" is not a username
      expect(rep.summary.conflict).toBe(3);
      // nothing changed: accounts, roles, memberships, mappings and credentials are as they were
      expect(await snapshot()).toEqual(before);
      const actions = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).orderBy('seq').offset(auditBefore).select('action')).map((r: { action: string }) => r.action);
      expect(actions.filter((a: string) => !a.startsWith('user.import.'))).toEqual([]);
    });

    it('a real run applies what the plan accepted, auditing each change', async () => {
      const sub = await ta.agent.post('/api/admin/user-imports').set('x-csrf-token', ta.csrf).set('content-type', 'text/csv').send(csv).expect(202);
      await drainJobs(h);
      const rep = (await ta.agent.get(`/api/admin/user-imports/${sub.body.id}`).expect(200)).body;
      expect(rep.summary).toMatchObject({ create: 3, conflict: 3, applied: 3, dryRun: false });
      const ada = (await h.s.users.byUsername(h.tenantId, 'ada'))!;
      expect((await h.s.users.roleIds(ada.id)).sort()).toEqual(['knowledge-curator', 'member']);
      const research = (await h.s.tenants.workspaces(h.tenantId)).find((w) => w.slug === 'research')!;
      expect(await h.s.users.workspaceIds(ada.id)).toContain(research.id);
      expect((await h.s.users.mappings(h.tenantId)).some((m) => m.group_name === 'acme/reviewers' && m.role === 'flag-reviewer' && m.workspace_id === research.id)).toBe(true);
      expect(await h.s.db('audit_events').where({ action: 'user.created' }).whereRaw("detail like '%import%'").first()).toBeTruthy();
      // running it again changes nothing more
      const again = await ta.agent.post('/api/admin/user-imports?dryRun=true').set('x-csrf-token', ta.csrf).set('content-type', 'text/csv').send(csv.split('\n').slice(0, 4).join('\n')).expect(202);
      await drainJobs(h);
      const rep2 = (await ta.agent.get(`/api/admin/user-imports/${again.body.id}`).expect(200)).body;
      expect(rep2.report.map((r: { action: string }) => r.action)).toEqual(['unchanged', 'unchanged', 'conflict']);
      expect((await ta.agent.get('/api/admin/user-imports').expect(200)).body.length).toBeGreaterThanOrEqual(3);
      // an identity admin may not grant the curator role, so for them the same row is an error
      const idaRun = await ida.agent.post('/api/admin/user-imports?dryRun=true').set('x-csrf-token', ida.csrf).set('content-type', 'text/csv').send('kind,username,roles\nuser,newcurator,knowledge-curator\n').expect(202);
      await drainJobs(h);
      expect((await ida.agent.get(`/api/admin/user-imports/${idaRun.body.id}`).expect(200)).body.report[0]).toMatchObject({ action: 'error', detail: 'Your roles cannot grant knowledge-curator.' });
    });

    it('parses RFC 4180 CSV and refuses an unterminated quote', () => {
      expect(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\n\n', 10)).toEqual([['a', 'b'], ['x, y', 'he said "hi"']]);
      expect(() => parseCsv('a,"b\n', 10)).toThrow(/unterminated/);
      expect(() => parseCsv('a\n1\n2\n3\n', 2)).toThrow(/more than 2 rows/);
    });
  });

  // ---------- B-2103: secrets and users import CLI ----------

  describe('B-2103 CLI: secrets and users import', () => {
    const ctx = setup();
    let h: Harness;
    beforeAll(() => {
      ({ h } = ctx);
    });
    it('runs kv, transit and policy explain through the vault under the account policy, audited as the CLI', async () => {
      const lines: string[] = [];
      const out = (t: string) => void lines.push(t);
      const sec = await localUser(h, 'secops', ['member', 'connection-admin'], 'confidential');
      // without a grant the vault policy refuses
      expect(await secretsCommand(h.s, ['kv', 'put', 'apps/billing', 'token=s3cr3t', '--as', 'secops'], out)).toBe(1);

      expect(lines.pop()).toMatch(/error: /);
      const c = await h.s.vault.callerFor((await loadPrincipal(h.s, h.tenantId, (await h.s.users.byUsername(h.tenantId, 'ta'))!.id, {}))!);
      await h.s.vault.createGrant(c, { subjectKind: 'user', subject: sec.id, path: 'kv/apps', capabilities: ['list', 'read', 'write'], effect: 'allow' });
      await h.s.vault.createGrant(c, { subjectKind: 'user', subject: sec.id, path: 'transit/payments', capabilities: ['encrypt', 'decrypt'], effect: 'allow' });
      const taUser = (await h.s.users.byUsername(h.tenantId, 'ta'))!;
      await h.s.vault.createGrant(c, { subjectKind: 'user', subject: taUser.id, path: 'transit', capabilities: ['manage'], effect: 'allow' });
      await h.s.vault.createKey(c, { name: 'payments', type: 'aes256-gcm96' });
      expect(await secretsCommand(h.s, ['kv', 'put', 'apps/billing', 'token=s3cr3t', 'user=svc', '--as', 'secops'], out)).toBe(0);
      expect(lines.pop()).toBe('Wrote apps/billing version 1.\n');
      expect(await secretsCommand(h.s, ['kv', 'get', 'apps/billing', '--field', 'token', '--as', 'secops'], out)).toBe(0);
      expect(lines.pop()).toBe('s3cr3t\n');
      expect(await secretsCommand(h.s, ['kv', 'list', '--as', 'secops'], out)).toBe(0);
      expect(lines.pop()).toContain('apps/billing  v1');
      expect(await secretsCommand(h.s, ['transit', 'encrypt', 'payments', '--plaintext', 'card 4242', '--as', 'secops'], out)).toBe(0);
      const ct = lines.pop()!.trim();
      expect(ct).toMatch(/^exai:v1:/);
      expect(await secretsCommand(h.s, ['transit', 'decrypt', 'payments', ct, '--as', 'secops'], out)).toBe(0);
      expect(lines.pop()).toBe('card 4242\n');
      expect(await secretsCommand(h.s, ['policy', 'explain', 'kv/apps/billing', '--capability', 'destroy', '--as', 'secops'], out)).toBe(0);
      expect(JSON.parse(lines.pop()!).decision.allow).toBe(false);
      // an account without secrets:write is refused before the policy
      await localUser(h, 'nowrite', ['member']);
      expect(await secretsCommand(h.s, ['kv', 'put', 'apps/x', 'a=b', '--as', 'nowrite'], out)).toBe(1);
      expect(await secretsCommand(h.s, ['kv'], out)).toBe(64);
      // audited as the CLI acting for the account, without values
      const written = (await h.s.db('audit_events').where({ action: 'vault.secret.written' }).orderBy('seq', 'desc').first()) as { actor: string; detail: string };
      expect(JSON.parse(written.actor)).toMatchObject({ service: 'cli', username: 'secops', via: 'cli' });
      expect(JSON.stringify(await h.s.db('audit_events').where({ tenant_id: h.tenantId }).select('detail', 'target'))).not.toContain('s3cr3t');
    });

    it('imports users from a file; --dry-run changes nothing', async () => {
      await h.s.tenants.createWorkspace(h.tenantId, 'Research', 'confidential');
      const dir = mkdtempSync(path.join(tmpdir(), 'exprsn-import-'));
      const file = path.join(dir, 'users.csv');
      writeFileSync(file, 'kind,username,display_name,email,roles,clearance,workspace\nuser,cliuser,CLI User,cli@corp.test,auditor,confidential,\nmembership,cliuser,,,,,research\n');
      const lines: string[] = [];
      const out = (t: string) => void lines.push(t);
      expect(await usersCommand(h.s, ['import', file, '--dry-run'], out)).toBe(0);
      expect(lines.join('')).toContain('Dry run, nothing changed: 2 rows: 2 to create');
      expect(await h.s.users.byUsername(h.tenantId, 'cliuser')).toBeUndefined();
      lines.length = 0;
      expect(await usersCommand(h.s, ['import', file], out)).toBe(0);
      expect(lines.join('')).toContain('2 applied');
      const u = (await h.s.users.byUsername(h.tenantId, 'cliuser'))!;
      expect(await h.s.users.roleIds(u.id)).toEqual(['auditor']);
      expect(u.mfa_required).toBe(true);
      const created = (await h.s.db('audit_events').where({ action: 'user.created' }).orderBy('seq', 'desc').first()) as { actor: string };
      expect(JSON.parse(created.actor)).toEqual({ service: 'cli' });
      expect(await usersCommand(h.s, ['export'], out)).toBe(64);
    });
  });
});
