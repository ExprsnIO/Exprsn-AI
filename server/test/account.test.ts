import { mkdtempSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';
import request from 'supertest';
import { authenticator } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app.js';
import { sha256 } from '../src/crypto/index.js';
import { searchSorted, sha1Hex } from '../src/identity/breached.js';
import { renderEmail } from '../src/platform/email-templates.js';
import { FakeMail, fakeHibp, tokenFrom } from './fake-account.js';
import { harness, localUser, login, loginAdmin, PASSWORD, type Harness } from './helpers.js';

const NEW_PASSWORD = 'a quiet meadow of seventeen owls';

/** Makes a session look as if its owner last proved who they are ten minutes ago. */
const age = (h: Harness, userId: string) => h.s.db('sessions').where({ user_id: userId }).update({ auth_at: Date.now() - 10 * 60_000, created_at: Date.now() - 10 * 60_000 });

async function withEmail(h: Harness, username: string, roles: string[] = ['member']) {
  const u = await localUser(h, username, roles);
  const email = `${username}@example.test`;
  await h.s.users.update(h.tenantId, u.id, { email });
  return { ...u, email };
}

function adminCreate(h: Harness, admin: { agent: ReturnType<typeof request.agent>; csrf: string }, body: Record<string, unknown>) {
  return admin.agent.post('/api/admin/users').set('x-csrf-token', admin.csrf).send({ displayName: 'New Person', roles: ['member'], ...body });
}

/** Sprint 11: account self-service, security notices, and email templates. */
describe('Sprint 11: account self-service', () => {
  describe('B-101 password change', () => {
    let h: Harness;
    const mail = new FakeMail();
    beforeAll(async () => {
      h = await harness({}, { mail });
    });
    afterAll(async () => h.close());

    it('changes the password, ends every other session and OAuth grant, and keeps this one', async () => {
      const u = await withEmail(h, 'changer');
      const a = await login(h, 'changer');
      const b = await login(h, 'changer');
      await h.s.db('oidc_refresh_tokens').insert({ id: 'x'.repeat(64), family_id: '01J00000000000000000000000', tenant_id: h.tenantId, client_id: 'app', user_id: u.id, session_id: null, scopes: 'openid', amr: 'pwd', method: 'Local password', auth_time: Date.now(), created_at: Date.now(), family_created_at: Date.now(), expires_at: Date.now() + 3600_000 });

      const res = await a.agent.post('/api/me/password').set('x-csrf-token', a.csrf).send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(200);
      expect(res.body).toMatchObject({ changed: true, sessionsRevoked: 1, grantsRevoked: 1 });
      await a.agent.get('/api/me').expect(200);
      await b.agent.get('/api/me').expect(401);
      expect((await h.s.db('oidc_refresh_tokens').where({ user_id: u.id }).first()).revoked_at).not.toBeNull();
      expect((await login(h, 'changer')).res.status).toBe(401);
      expect((await login(h, 'changer', NEW_PASSWORD)).res.status).toBe(200);
      const audit = await h.s.db('audit_events').where({ action: 'password.changed' });
      expect(audit.length).toBe(1);
      // B-109: the owner is told, in the console and by email, without any secret.
      const notes = (await a.agent.get('/api/me/notifications')).body.items as { title: string }[];
      expect(notes.some((n) => n.title === 'Your password was changed')).toBe(true);
      const sent = await mail.next(u.email);
      expect(sent.subject).toContain('Your password was changed');
      expect(sent.text).not.toContain(NEW_PASSWORD);
      expect(sent.html).not.toContain(NEW_PASSWORD);
    });

    it('refuses the current password again and a password that fails the policy', async () => {
      await localUser(h, 'reuser', ['member']);
      const a = await login(h, 'reuser');
      const same = await a.agent.post('/api/me/password').set('x-csrf-token', a.csrf).send({ currentPassword: PASSWORD, newPassword: PASSWORD }).expect(400);
      expect(same.body.reason).toBe('reuse');
      const weak = await a.agent.post('/api/me/password').set('x-csrf-token', a.csrf).send({ currentPassword: PASSWORD, newPassword: 'short' }).expect(400);
      expect(weak.body.reason).toBe('policy');
    });

    it('counts a wrong current password toward the sign-in lockout', async () => {
      await localUser(h, 'guesser', ['member']);
      const a = await login(h, 'guesser');
      const first = await a.agent.post('/api/me/password').set('x-csrf-token', a.csrf).send({ currentPassword: 'wrong wrong wrong', newPassword: NEW_PASSWORD }).expect(400);
      expect(first.body.attempts_remaining).toBe(4);
      for (let i = 0; i < 3; i++) await a.agent.post('/api/me/password').set('x-csrf-token', a.csrf).send({ currentPassword: 'wrong wrong wrong', newPassword: NEW_PASSWORD });
      await a.agent.post('/api/me/password').set('x-csrf-token', a.csrf).send({ currentPassword: 'wrong wrong wrong', newPassword: NEW_PASSWORD }).expect(429);
      // The account is now locked for sign-in too, even with the right password.
      expect((await login(h, 'guesser')).res.status).toBe(429);
      expect((await h.s.db('audit_events').where({ action: 'password.change.failed' })).length).toBeGreaterThanOrEqual(4);
    });

    it('says a directory account changes its password in the directory', async () => {
      const u = await h.s.users.create(h.tenantId, { username: 'ldapperson', displayName: 'LDAP Person' });
      await h.s.users.setRoles(u.id, 'direct', ['member']);
      const { token, session } = await h.s.sessions.create({ userId: u.id, tenantId: h.tenantId, stage: 'active', method: 'LDAP password', providerId: null, ip: null, userAgent: null });
      const res = await request(h.app).post('/api/me/password').set('cookie', `exai_sid=${token}`).set('x-csrf-token', h.s.sessions.csrfFor(session.id)).send({ currentPassword: 'x', newPassword: NEW_PASSWORD }).expect(409);
      expect(res.body.title).toBe('Managed by the directory');
      const me = await request(h.app).get('/api/me').set('cookie', `exai_sid=${token}`).expect(200);
      expect(me.body.password.managedHere).toBe(false);
    });
  });

  describe('B-102 admin reset and B-103 forced change', () => {
    let h: Harness;
    const mail = new FakeMail();
    let admin: Awaited<ReturnType<typeof loginAdmin>>;
    beforeAll(async () => {
      h = await harness({}, { mail });
      await localUser(h, 'idadmin', ['identity-admin']);
      admin = await loginAdmin(h, 'idadmin');
    });
    afterAll(async () => h.close());

    it('sets a temporary password: audited, the old one stops working, the next sign-in must change it', async () => {
      const u = await withEmail(h, 'forgetful');
      const old = await login(h, 'forgetful');
      const temp = 'temporary lantern 4815';
      const res = await admin.agent.post(`/api/admin/users/${u.id}/password`).set('x-csrf-token', admin.csrf).send({ mode: 'temporary', password: temp }).expect(200);
      expect(res.body).toMatchObject({ mode: 'temporary', mustChange: true, sessionsRevoked: 1 });
      await old.agent.get('/api/me').expect(401);
      expect(JSON.stringify((await h.s.db('audit_events').where({ action: 'user.password_reset' }).first()).actor)).toContain('idadmin');
      expect((await login(h, 'forgetful')).res.status).toBe(401);

      // B-103: a session in the password stage reaches nothing but the change route.
      const t = await login(h, 'forgetful', temp);
      expect(t.res.body.stage).toBe('password');
      for (const p of ['/api/me', '/api/me/sessions', '/api/conversations', '/api/admin/users']) await t.agent.get(p).expect(401);
      await t.agent.post('/api/me/api-keys').set('x-csrf-token', t.csrf).send({ name: 'x', scopes: ['chat:read'], ttlDays: 30 }).expect(401);
      const changed = await t.agent.post('/api/me/password').set('x-csrf-token', t.csrf).send({ currentPassword: temp, newPassword: NEW_PASSWORD }).expect(200);
      expect(changed.body.stage).toBe('active');
      await t.agent.get('/api/me').expect(200);
      expect((await h.s.account.localCredential(u.id))!.must_change).toBe(false);
      // The owner was told an admin reset it.
      expect(mail.to(u.email).some((m) => m.subject.includes('An administrator reset your password'))).toBe(true);
    });

    it('sends a single-use link: the old password stops working and the link sets a new one', async () => {
      const u = await withEmail(h, 'linkuser');
      const before = mail.to(u.email).length;
      const res = await admin.agent.post(`/api/admin/users/${u.id}/password`).set('x-csrf-token', admin.csrf).send({ mode: 'link' }).expect(200);
      expect(res.body.linkSent).toBe(true);
      expect(JSON.stringify(res.body)).not.toMatch(/reset=/);
      expect((await login(h, 'linkuser')).res.status).toBe(401);
      const msg = mail.to(u.email).slice(before).find((m) => m.subject.startsWith('Set a new password'))!;
      const token = tokenFrom(msg);
      await request(h.app).post('/api/auth/password/reset').send({ token, password: NEW_PASSWORD }).expect(200);
      expect((await login(h, 'linkuser', NEW_PASSWORD)).res.body.stage).toBe('active');
    });

    it('creates accounts whose initial password must change, and admins do their factor first', async () => {
      await adminCreate(h, admin, { username: 'newhire', password: 'initial harbour 2027' }).expect(201);
      expect((await login(h, 'newhire', 'initial harbour 2027')).res.body.stage).toBe('password');
      await adminCreate(h, admin, { username: 'newadmin', password: 'initial harbour 2028', roles: ['member'] }).expect(201);
      await h.s.users.update(h.tenantId, (await h.s.users.byUsername(h.tenantId, 'newadmin'))!.id, { mfa_required: true });
      const a = await login(h, 'newadmin', 'initial harbour 2028');
      expect(a.res.body.stage).toBe('enroll');
      const begin = await a.agent.post('/api/me/mfa/totp').set('x-csrf-token', a.csrf).send({});
      const confirm = await a.agent.post(`/api/me/mfa/totp/${begin.body.id}/confirm`).set('x-csrf-token', a.csrf).send({ code: authenticator.generate(begin.body.secret) }).expect(201);
      expect(confirm.body.stage).toBe('password');
      await a.agent.get('/api/me').expect(401);
      await a.agent.post('/api/me/password').set('x-csrf-token', confirm.body.csrf).send({ currentPassword: 'initial harbour 2028', newPassword: NEW_PASSWORD }).expect(200);
      await a.agent.get('/api/me').expect(200);
    });

    it('invites by email instead of a password', async () => {
      const res = await adminCreate(h, admin, { username: 'invitee', email: 'invitee@example.test', invite: true }).expect(201);
      expect(res.body.invited).toBe(true);
      const msg = await mail.next('invitee@example.test');
      expect(msg.subject).toContain('You have an account');
      await request(h.app).post('/api/auth/password/reset').send({ token: tokenFrom(msg), password: NEW_PASSWORD }).expect(200);
      expect((await login(h, 'invitee', NEW_PASSWORD)).res.body.stage).toBe('active');
    });

    it('answers clearly for a directory account and refuses resetting yourself', async () => {
      const u = await h.s.users.create(h.tenantId, { username: 'dirperson', displayName: 'Dir Person' });
      await admin.agent.post(`/api/admin/users/${u.id}/password`).set('x-csrf-token', admin.csrf).send({ mode: 'temporary', password: 'temporary lantern 4815' }).expect(409);
      const me = (await admin.agent.get('/api/me')).body.user.id as string;
      await admin.agent.post(`/api/admin/users/${me}/password`).set('x-csrf-token', admin.csrf).send({ mode: 'temporary', password: 'temporary lantern 4815' }).expect(403);
    });
  });

  describe('B-104 reset by email', () => {
    let h: Harness;
    const mail = new FakeMail();
    const lines: string[] = [];
    beforeAll(async () => {
      h = await harness({}, { mail });
      // Capture every log line the HTTP layer writes, to prove the token never reaches the logs.
      h.s.log = pino({ level: 'trace' }, new Writable({ write: (chunk, _enc, cb) => (lines.push(String(chunk)), cb()) }));
      h.app = createApp(h.s);
    });
    afterAll(async () => h.close());

    it('answers the same whether or not the account exists', async () => {
      const u = await withEmail(h, 'resetme');
      const known = await request(h.app).post('/api/auth/password/forgot').send({ identifier: 'resetme' }).expect(202);
      const unknown = await request(h.app).post('/api/auth/password/forgot').send({ identifier: 'nobody-here' }).expect(202);
      const byEmail = await request(h.app).post('/api/auth/password/forgot').send({ identifier: u.email }).expect(202);
      expect(unknown.body).toEqual(known.body);
      expect(byEmail.body).toEqual(known.body);
      await mail.next(u.email, 1);
      expect(mail.sent.every((m) => m.to === u.email)).toBe(true);
    });

    it('stores only the hash, works once, expires, revokes sessions, and never shows the token', async () => {
      const u = await withEmail(h, 'onceonly');
      const s1 = await login(h, 'onceonly');
      const before = mail.to(u.email).length;
      const forgot = await request(h.app).post('/api/auth/password/forgot').send({ identifier: 'onceonly' }).expect(202);
      const msg = await mail.next(u.email, before);
      const token = tokenFrom(msg);
      expect(msg.text).toContain('/#/signin?reset=');
      expect(JSON.stringify(forgot.body)).not.toContain(token);
      const rows = await h.s.db('password_tokens').where({ user_id: u.id });
      expect(rows.map((r: { id: string }) => r.id)).toContain(sha256(token));
      expect(JSON.stringify(rows)).not.toContain(token);

      const res = await request(h.app).post('/api/auth/password/reset').send({ token, password: NEW_PASSWORD }).expect(200);
      expect(JSON.stringify(res.body)).not.toContain(token);
      await s1.agent.get('/api/me').expect(401);
      const again = await request(h.app).post('/api/auth/password/reset').send({ token, password: 'another fine password 99' }).expect(400);
      expect(JSON.stringify(again.body)).not.toContain(token);
      expect((await login(h, 'onceonly', NEW_PASSWORD)).res.status).toBe(200);

      // Expired links do not work.
      const n = mail.to(u.email).length;
      await request(h.app).post('/api/auth/password/forgot').send({ identifier: 'onceonly' }).expect(202);
      const token2 = tokenFrom(await mail.next(u.email, n));
      await h.s.db('password_tokens').where({ id: sha256(token2) }).update({ expires_at: Date.now() - 1000 });
      await request(h.app).post('/api/auth/password/reset').send({ token: token2, password: 'another fine password 99' }).expect(400);

      expect(lines.length).toBeGreaterThan(0);
      for (const t of [token, token2]) expect(lines.some((l) => l.includes(t))).toBe(false);
    });

    it('throttles requests per identifier and per address', async () => {
      const u = await withEmail(h, 'throttled');
      const before = mail.to(u.email).length;
      for (let i = 0; i < 5; i++) await request(h.app).post('/api/auth/password/forgot').send({ identifier: 'throttled' }).expect(202);
      await request(h.app).post('/api/auth/password/forgot').send({ identifier: 'throttled' }).expect(429);
      await new Promise((r) => setTimeout(r, 50));
      // The account throttle (five an hour) held the mail back to five at most, counting the earlier tests' requests.
      expect(mail.to(u.email).length - before).toBeLessThanOrEqual(5);
      // Per address: four times the per-identifier limit across identifiers.
      let limited = false;
      for (let i = 0; i < 25 && !limited; i++) limited = (await request(h.app).post('/api/auth/password/forgot').send({ identifier: `someone${i}` })).status === 429;
      expect(limited).toBe(true);
    });
  });

  describe('B-105 breached passwords', () => {
    it('refuses a known-breached password through the range API, sending only the prefix', async () => {
      const breached = 'a perfectly breached passphrase';
      const hibp = await fakeHibp([breached]);
      const h = await harness({ BREACHED_PASSWORDS: 'hibp', BREACHED_HIBP_URL: hibp.url });
      try {
        await localUser(h, 'hibpuser', ['member']);
        const a = await login(h, 'hibpuser');
        const res = await a.agent.post('/api/me/password').set('x-csrf-token', a.csrf).send({ currentPassword: PASSWORD, newPassword: breached }).expect(400);
        expect(res.body.reason).toBe('breached');
        const full = sha1Hex(breached);
        expect(hibp.paths).toEqual([`/range/${full.slice(0, 5)}`]);
        expect(hibp.paths.join()).not.toContain(full.slice(5));
        expect(hibp.headers[0]!['add-padding']).toBe('true');
        await a.agent.post('/api/me/password').set('x-csrf-token', a.csrf).send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(200);
      } finally {
        await h.close();
        await hibp.close();
      }
    });

    it('fails open with an audit event when the range API cannot be reached', async () => {
      const hibp = await fakeHibp([]);
      await hibp.close();
      const h = await harness({ BREACHED_PASSWORDS: 'hibp', BREACHED_HIBP_URL: hibp.url, BREACHED_TIMEOUT_MS: '500' });
      try {
        await localUser(h, 'offline', ['member']);
        const a = await login(h, 'offline');
        await a.agent.post('/api/me/password').set('x-csrf-token', a.csrf).send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(200);
        const ev = await h.s.db('audit_events').where({ action: 'password.breach_check.unavailable' }).first();
        expect(ev).toBeTruthy();
      } finally {
        await h.close();
      }
    });

    it('searches a sorted hash file without loading it', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'exprsn-breach-'));
      const file = path.join(dir, 'hashes.txt');
      const words = Array.from({ length: 3000 }, (_, i) => `corpus password number ${i}`);
      const listed = words.map((w) => `${sha1Hex(w)}:${(w.length % 7) + 1}`).sort();
      writeFileSync(file, listed.join('\r\n') + '\r\n');
      const fh = await open(file, 'r');
      try {
        const size = (await fh.stat()).size;
        for (const w of [words[0]!, words[1234]!, words[2999]!]) expect(await searchSorted(fh, size, sha1Hex(w))).toBe(true);
        for (const w of ['not in the corpus at all', '', 'corpus password number 3000']) expect(await searchSorted(fh, size, sha1Hex(w))).toBe(false);
        expect(await searchSorted(fh, size, listed[0]!.slice(0, 40))).toBe(true);
        expect(await searchSorted(fh, size, listed[listed.length - 1]!.slice(0, 40))).toBe(true);
      } finally {
        await fh.close();
      }
      const h = await harness({ BREACHED_PASSWORDS: 'file', BREACHED_FILE: file });
      try {
        await localUser(h, 'fileuser', ['member']);
        const a = await login(h, 'fileuser');
        const res = await a.agent.post('/api/me/password').set('x-csrf-token', a.csrf).send({ currentPassword: PASSWORD, newPassword: words[42] }).expect(400);
        expect(res.body.reason).toBe('breached');
      } finally {
        await h.close();
      }
    });
  });

  describe('B-106 step-up re-authentication', () => {
    let h: Harness;
    const mail = new FakeMail();
    beforeAll(async () => {
      h = await harness({}, { mail });
    });
    afterAll(async () => h.close());

    it('lets a fresh sign-in through, asks again outside the window, and accepts the password', async () => {
      const u = await withEmail(h, 'stepper');
      const a = await login(h, 'stepper');
      const key = await a.agent.post('/api/me/api-keys').set('x-csrf-token', a.csrf).send({ name: 'fresh', scopes: ['chat:read'], ttlDays: 30 }).expect(201);
      await age(h, u.id);
      const refused = await a.agent.post('/api/me/api-keys').set('x-csrf-token', a.csrf).send({ name: 'stale', scopes: ['chat:read'], ttlDays: 30 }).expect(401);
      expect(refused.body.title).toBe('Step-up required');
      expect(refused.body.step_up).toBe(true);
      // Not a sign-out: the session still works for everything else.
      await a.agent.get('/api/me').expect(200);
      await a.agent.post('/api/me/step-up').set('x-csrf-token', a.csrf).send({ password: 'not my password' }).expect(400);
      await a.agent.post('/api/me/step-up').set('x-csrf-token', a.csrf).send({ password: PASSWORD }).expect(200);
      await a.agent.post('/api/me/api-keys').set('x-csrf-token', a.csrf).send({ name: 'after', scopes: ['chat:read'], ttlDays: 30 }).expect(201);
      expect((await h.s.db('audit_events').where({ action: 'auth.step_up' })).length).toBe(1);

      // B-109: the key-created notice names the key but never carries it.
      const sent = await mail.next(u.email);
      expect(sent.subject).toContain('An API key was created');
      expect(sent.text).toContain('fresh');
      expect(sent.text).not.toContain(key.body.key);
      expect(sent.html).not.toContain(key.body.key);
    });

    it('guards factor removal and recovery codes, and accepts a TOTP code', async () => {
      await localUser(h, 'stepadmin', ['identity-admin']);
      const a = await loginAdmin(h, 'stepadmin');
      const factors = (await a.agent.get('/api/me/mfa')).body.factors as { id: string }[];
      await age(h, (await h.s.users.byUsername(h.tenantId, 'stepadmin'))!.id);
      await a.agent.post('/api/me/mfa/recovery-codes').set('x-csrf-token', a.csrf).expect(401);
      await a.agent.delete(`/api/me/mfa/${factors[0]!.id}`).set('x-csrf-token', a.csrf).expect(401);
      const next = authenticator.clone({ epoch: Date.now() + 30_000 }).generate(a.totpSecret);
      const ok = await a.agent.post('/api/me/step-up').set('x-csrf-token', a.csrf).send({ code: next }).expect(200);
      expect(ok.body.method).toBe('TOTP');
      await a.agent.post('/api/me/mfa/recovery-codes').set('x-csrf-token', a.csrf).expect(201);
    });

    it('reports the window and the methods on /api/me', async () => {
      await localUser(h, 'lookup', ['member']);
      const a = await login(h, 'lookup');
      const me = (await a.agent.get('/api/me')).body;
      expect(me.stepUp.windowSeconds).toBe(300);
      expect(me.stepUp.methods).toEqual(['password']);
      expect(Date.now() - me.stepUp.authAt).toBeLessThan(60_000);
    });
  });

  describe('B-109 security notifications', () => {
    let h: Harness;
    const mail = new FakeMail();
    beforeAll(async () => {
      h = await harness({}, { mail });
    });
    afterAll(async () => h.close());

    it('notifies on factor, recovery code, key and session changes, and on admin actions', async () => {
      const u = await localUser(h, 'watched', ['identity-admin']);
      await h.s.users.update(h.tenantId, u.id, { email: 'watched@example.test' });
      const a = await loginAdmin(h, 'watched');
      await a.agent.post('/api/me/mfa/recovery-codes').set('x-csrf-token', a.csrf).expect(201);
      const key = await a.agent.post('/api/me/api-keys').set('x-csrf-token', a.csrf).send({ name: 'nb', scopes: ['users:manage'], ttlDays: 30 }).expect(201);
      await a.agent.delete(`/api/me/api-keys/${key.body.id}`).set('x-csrf-token', a.csrf).expect(204);
      const other = await login(h, 'watched');
      expect(other.res.body.stage).toBe('mfa');
      await a.agent.post('/api/me/sessions/revoke-others').set('x-csrf-token', a.csrf).expect(200);

      await localUser(h, 'boss', ['tenant-admin']);
      const boss = await loginAdmin(h, 'boss');
      await boss.agent.post(`/api/admin/users/${u.id}/reset-mfa`).set('x-csrf-token', boss.csrf).expect(200);

      const titles = (await h.s.notifications.list(u.id)).map((n) => n.title);
      for (const t of ['A second factor was added', 'New recovery codes were generated', 'An API key was created', 'An API key was revoked', 'Your other sessions were signed out', 'An administrator removed your second factors']) expect(titles).toContain(t);
      await new Promise((r) => setTimeout(r, 100));
      const mails = mail.to('watched@example.test');
      expect(mails.length).toBeGreaterThanOrEqual(6);
      for (const m of mails) {
        expect(m.text).not.toContain(key.body.key);
        expect(m.text).not.toContain(a.totpSecret);
      }
    });
  });

  describe('B-110 email templates', () => {
    it('escapes every value in the HTML and keeps the subject on one line', () => {
      const m = renderEmail('security-alert', { product: 'Exprsn-AI', name: '<script>alert(1)</script>', username: 'a"b\'c', event: 'Evil\r\nBcc: x@example.test', time: 'now', link: 'https://console.example.test/#/settings', detail: '<img src=x onerror=alert(1)>' });
      expect(m.html).not.toContain('<script>');
      expect(m.html).not.toContain('<img');
      expect(m.html).toContain('&lt;script&gt;');
      expect(m.html).toContain('a&quot;b&#39;c');
      expect(m.subject).not.toMatch(/[\r\n]/);
      expect(m.text).toContain('https://console.example.test/#/settings');
    });

    it('drops a link that is not http(s) and refuses a missing value', () => {
      const m = renderEmail('notification', { title: 'Hello', link: 'javascript:alert(1)' });
      expect(m.html).not.toContain('javascript:');
      expect(m.text).not.toContain('javascript:');
      expect(() => renderEmail('password-reset', { product: 'Exprsn-AI', name: 'x', username: 'x', minutes: 60 })).toThrow(/link/);
    });
  });

  describe('B-501 appearance preferences', () => {
    it('stores the accessibility mode per user, so it follows them to another browser', async () => {
      const h = await harness();
      try {
        await localUser(h, 'prefs', ['member']);
        const a = await login(h, 'prefs');
        expect((await a.agent.get('/api/me')).body.preferences.a11y).toBe('system');
        await a.agent.patch('/api/me/preferences').set('x-csrf-token', a.csrf).send({ a11y: 'aaa' }).expect(200);
        await a.agent.patch('/api/me/preferences').set('x-csrf-token', a.csrf).send({ a11y: 'loud' }).expect(400);
        const b = await login(h, 'prefs');
        expect((await b.agent.get('/api/me')).body.preferences.a11y).toBe('aaa');
        expect(await h.s.db('audit_events').where({ action: 'user.preferences.updated' }).first()).toBeTruthy();
      } finally {
        await h.close();
      }
    });
  });
});
