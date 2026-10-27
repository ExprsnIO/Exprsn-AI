import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { down as down129, up as up129 } from '../src/db/migrations/129_signin_policy.js';
import { totp } from '../src/identity/totp.js';
import { checkPasswordPolicy, hashPassword, passwordRules, tooSimilar, type LeakedPasswordResult } from '../src/identity/passwords.js';
import { resolvePolicy, signinPolicySchema } from '../src/identity/signin-policy.js';
import { harness, type Harness } from './helpers.js';

/*
 * 1.9.0, Sprint 55 (B-190): the tenant sign-in policy, enforced. The migration is applied here (it is registered by
 * the owner); the last block runs without it, as a deployed build before the migration would.
 */

const GOOD = 'violet tram under the pier';
const cookieOf = (res: request.Response): string => ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? []).map((c) => c.split(';')[0]).join('; ');

async function user(h: Harness, username: string, roles: string[], password = GOOD) {
  const local = (await h.s.providers.list(h.tenantId)).find((p) => p.kind === 'local')!;
  const u = await h.s.users.create(h.tenantId, { username, displayName: username.toUpperCase(), clearance: 'internal' });
  await h.s.users.update(h.tenantId, u.id, { clearance_direct: 'internal' });
  await h.s.db('local_credentials').insert({ user_id: u.id, password_hash: await hashPassword(password), updated_at: Date.now() });
  await h.s.users.upsertIdentity(u.id, local.id, u.id, []);
  await h.s.users.setRoles(u.id, 'direct', roles);
  return u;
}

async function signIn(h: Harness, username: string, password = GOOD) {
  const agent = request.agent(h.app);
  const res = await agent.post('/api/auth/login').send({ username, password });
  return { agent, res, csrf: res.body.csrf as string };
}

async function admin(h: Harness, username: string) {
  const { agent, res } = await signIn(h, username);
  expect(res.body.stage, JSON.stringify(res.body)).toBe('enroll');
  const begin = await agent.post('/api/me/mfa/totp').set('x-csrf-token', res.body.csrf).send({});
  const confirm = await agent.post(`/api/me/mfa/totp/${begin.body.id}/confirm`).set('x-csrf-token', res.body.csrf).send({ code: totp.generate(begin.body.secret) });
  expect(confirm.status, JSON.stringify(confirm.body)).toBe(201);
  return { agent, csrf: confirm.body.csrf as string, secret: begin.body.secret as string, cookie: cookieOf(confirm) };
}

describe('B-190: the tenant sign-in policy', () => {
  let h: Harness;
  let a: Awaited<ReturnType<typeof admin>>;
  const as = (method: 'get' | 'put' | 'post' | 'delete' | 'patch', path: string, body?: object) => {
    const r = a.agent[method](path).set('x-csrf-token', a.csrf);
    return body ? r.send(body) : r;
  };
  const setPolicy = async (policy: object) => {
    const res = await as('put', '/api/admin/signin-policy', policy);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  };

  beforeAll(async () => {
    h = await harness();
    await down129(h.s.db);
    await up129(h.s.db);
    await user(h, 'poladmin', ['identity-admin', 'member']);
    a = await admin(h, 'poladmin');
  });
  afterAll(async () => h.close());

  it('without a policy, behaves as today', async () => {
    const view = (await as('get', '/api/admin/signin-policy')).body;
    expect(view.available).toBe(true);
    expect(view.policy).toBeNull();
    expect(view.effective.configured).toBe(false);
    expect(view.effective.lockout).toEqual({ maxAttempts: h.s.cfg.LOCKOUT_MAX_ATTEMPTS, windowMinutes: h.s.cfg.LOCKOUT_WINDOW_MINUTES, durationMinutes: h.s.cfg.LOCKOUT_DURATION_MINUTES });
    expect(view.effective.sessions).toEqual({ idleMinutes: h.s.cfg.SESSION_IDLE_MINUTES, absoluteHours: h.s.cfg.SESSION_ABSOLUTE_HOURS, stepUpSeconds: h.s.cfg.STEPUP_WINDOW_SECONDS });
    expect(await h.s.account.policy.sessionLifetimes(h.tenantId)).toBeNull();
    // A password the platform's rules now refuse (a common one) still signs in to an active session, as before.
    await user(h, 'legacy', ['member'], 'correct horse battery staple');
    const r = await signIn(h, 'legacy', 'correct horse battery staple');
    expect(r.res.status).toBe(200);
    expect(r.res.body.stage).toBe('active');
    expect(r.res.body.passwordChange).toBeUndefined();
    // The rules with the defaults are exactly the platform's.
    expect(passwordRules(GOOD, 'x').map((x) => x.id)).toEqual(['length', 'max', 'username', 'repeated', 'common', 'service']);
  });

  it('never lowers the floor of 12', async () => {
    expect(signinPolicySchema.safeParse({ password: { minLength: 8 } }).success).toBe(false);
    const res = await as('put', '/api/admin/signin-policy', { password: { minLength: 11 } });
    expect(res.status).toBe(400);
    expect(resolvePolicy(null, h.s.cfg).password.minLength).toBe(12);
    expect(resolvePolicy(null, h.s.cfg).sources['password.minLength']).toBe('platform floor');
    expect(checkPasswordPolicy('elevenchars', 'x', { ...resolvePolicy(null, h.s.cfg).password, minLength: 3 }).ok).toBe(false);
    const view = await setPolicy({ password: { minLength: 16, maxLength: 64 } });
    expect(view.effective.password.minLength).toBe(16);
    await user(h, 'shorty', ['member']);
    const r = await signIn(h, 'shorty');
    // GOOD has 26 characters: fine at 16.
    expect(r.res.body.stage).toBe('active');
    const tooShort = await r.agent.post('/api/me/password').set('x-csrf-token', r.csrf).send({ currentPassword: GOOD, newPassword: 'amber kite sky' });
    expect(tooShort.status).toBe(400);
    expect(tooShort.body.rule).toBe('length');
    expect(tooShort.body.detail).toMatch(/at least 16/);
    expect((await as('put', '/api/admin/signin-policy', { password: { minLength: 20, maxLength: 16 } })).status).toBe(400);
  });

  it('keeps character rules off by default, and applies them when turned on', async () => {
    expect(checkPasswordPolicy(GOOD, 'x').ok).toBe(true);
    const view = await setPolicy({ password: { requireUpper: true, requireDigit: true, requireSymbol: true } });
    expect(view.warnings.join(' ')).toMatch(/Character-class rules/);
    const rules = view.effective.password;
    expect(checkPasswordPolicy(GOOD, 'x', rules)).toEqual({ ok: false, reason: 'Include an upper-case letter.' });
    expect(checkPasswordPolicy('Violet tram under the pier', 'x', rules).reason).toBe('Include a digit.');
    expect(checkPasswordPolicy('Violet tram under pier 9', 'x', rules).reason).toMatch(/symbol/);
    expect(checkPasswordPolicy('Violet tram, under pier 9', 'x', rules).ok).toBe(true);
    // The strength meter shows the same rules.
    await user(h, 'meter', ['member']);
    const r = await signIn(h, 'meter');
    const m = await r.agent.post('/api/auth/password/check').set('x-csrf-token', r.csrf).send({ password: 'violet tram under the pier', breach: false });
    expect(m.body.rules.filter((x: { ok: boolean }) => !x.ok).map((x: { id: string }) => x.id)).toEqual(['upper', 'digit', 'symbol']);
    expect(m.body.acceptable).toBe(false);
  });

  it('refuses a new password too close to the old one', async () => {
    expect(tooSimilar('Summer-2025!long', 'Summer-2026!long')).toBe(true);
    expect(tooSimilar('violet tram under the pier', 'Violet Tram Under The Pier 2')).toBe(true);
    expect(tooSimilar('violet tram under the pier', 'quartz lamp over a meadow')).toBe(false);
    await setPolicy({ password: { notSimilarToPrevious: true } });
    await user(h, 'closeone', ['member']);
    const r = await signIn(h, 'closeone');
    const close = await r.agent.post('/api/me/password').set('x-csrf-token', r.csrf).send({ currentPassword: GOOD, newPassword: 'violet tram under the pier!!' });
    expect(close.status).toBe(400);
    expect(close.body.rule).toBe('similar');
    const far = await r.agent.post('/api/me/password').set('x-csrf-token', r.csrf).send({ currentPassword: GOOD, newPassword: 'quartz lamp over a meadow' });
    expect(far.status, JSON.stringify(far.body)).toBe(200);
  });

  it('keeps a history of argon2 hashes and refuses reuse', async () => {
    await setPolicy({ password: { history: 2 } });
    const u = await user(h, 'historian', ['member']);
    let current = GOOD;
    const change = async (next: string) => {
      const r = await signIn(h, 'historian', current);
      expect(r.res.status, JSON.stringify(r.res.body)).toBe(200);
      const res = await r.agent.post('/api/me/password').set('x-csrf-token', r.csrf).send({ currentPassword: current, newPassword: next });
      if (res.status === 200) current = next;
      return res;
    };
    expect((await change('quartz lamp over a meadow')).status).toBe(200);
    expect((await change('copper bell in the fog')).status).toBe(200);
    const back = await change(GOOD);
    expect(back.status).toBe(400);
    expect(back.body.reason).toBe('history');
    const rows = await h.s.db('password_history').where({ user_id: u.id });
    expect(rows.length).toBe(2);
    expect(rows.every((x: { password_hash: string }) => x.password_hash.startsWith('$argon2id$'))).toBe(true);
    // An admin set is checked against the history too.
    const adminSet = await as('post', `/api/admin/users/${u.id}/password`, { mode: 'temporary', password: 'quartz lamp over a meadow' });
    expect(adminSet.status).toBe(400);
    expect(adminSet.body.reason).toBe('history');
    // Turning the history off forgets it.
    await setPolicy({});
    expect(await h.s.db('password_history').where({ user_id: u.id })).toHaveLength(0);
  });

  it('warns about forced expiry and asks for a change once a password has expired', async () => {
    const view = await setPolicy({ password: { expiryDays: 90 } });
    expect(view.warnings.join(' ')).toMatch(/NIST SP 800-63B advises against forced expiry/);
    const u = await user(h, 'expired', ['member']);
    await h.s.db('local_credentials').where({ user_id: u.id }).update({ updated_at: Date.now() - 91 * 86_400_000 });
    const r = await signIn(h, 'expired');
    expect(r.res.status).toBe(200);
    expect(r.res.body.stage).toBe('password');
    expect(r.res.body.passwordChange).toEqual({ reason: 'expired' });
    const done = await r.agent.post('/api/me/password').set('x-csrf-token', r.csrf).send({ currentPassword: GOOD, newPassword: 'quartz lamp over a meadow' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.stage).toBe('active');
    const audit = await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'identity.policy.change_required' });
    expect(audit.length).toBeGreaterThan(0);
  });

  it('applies the tenant lockout', async () => {
    expect((await as('put', '/api/admin/signin-policy', { lockout: { maxAttempts: h.s.cfg.LOCKOUT_MAX_ATTEMPTS + 1 } })).status).toBe(400);
    await setPolicy({ lockout: { maxAttempts: 3, windowMinutes: 30, durationMinutes: 45 } });
    await user(h, 'locky', ['member']);
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await request(h.app).post('/api/auth/login').send({ username: 'locky', password: 'not the password at all' })).status);
    expect(codes).toEqual([401, 401, 429]);
    const locked = await request(h.app).post('/api/auth/login').send({ username: 'locky', password: GOOD });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(30 * 60);
    await setPolicy({});
  });

  it('keeps session lifetimes and the step-up window within the platform bounds', async () => {
    for (const bad of [{ idleMinutes: h.s.cfg.SESSION_IDLE_MINUTES + 1 }, { absoluteHours: h.s.cfg.SESSION_ABSOLUTE_HOURS + 1 }, { stepUpSeconds: h.s.cfg.STEPUP_WINDOW_SECONDS + 1 }, { idleMinutes: 4 }]) {
      expect((await as('put', '/api/admin/signin-policy', { sessions: bad })).status, JSON.stringify(bad)).toBe(400);
    }
    await setPolicy({ sessions: { idleMinutes: 5, absoluteHours: 2, stepUpSeconds: 30 } });
    await user(h, 'sessy', ['member']);
    // Idle: past the tenant's 5 minutes (the platform's are 30).
    const idle = await signIn(h, 'sessy');
    expect((await idle.agent.get('/api/auth/session')).body.authenticated).toBe(true);
    await h.s.db('sessions').where({ user_id: (await h.s.users.byUsername(h.tenantId, 'sessy'))!.id }).update({ last_seen_at: Date.now() - 6 * 60_000 });
    expect((await idle.agent.get('/api/auth/session')).body.authenticated).toBe(false);
    // Absolute: a session started more than the tenant's 2 hours ago ends.
    const abs = await signIn(h, 'sessy');
    const row = (await h.s.db('sessions').where({ user_id: (await h.s.users.byUsername(h.tenantId, 'sessy'))!.id, revoked_at: null }).orderBy('created_at', 'desc').first()) as { id: string; expires_at: number };
    const active = await abs.agent.get('/api/auth/session');
    expect(active.body.authenticated).toBe(true);
    expect(active.body.expiresAt).toBeLessThanOrEqual(Date.now() + 2 * 3600_000 + 5000);
    await h.s.db('sessions').where({ id: row.id }).update({ expires_at: Date.now() + (h.s.cfg.SESSION_ABSOLUTE_HOURS - 2) * 3600_000 - 60_000 });
    expect((await abs.agent.get('/api/auth/session')).body.authenticated).toBe(false);
    // Step-up: a check older than the tenant's 30 seconds must be repeated.
    const st = await signIn(h, 'sessy');
    await h.s.db('sessions').where({ user_id: (await h.s.users.byUsername(h.tenantId, 'sessy'))!.id, revoked_at: null }).update({ auth_at: Date.now() - 60_000, last_seen_at: Date.now() });
    const up = await st.agent.post('/api/me/mfa/recovery-codes').set('x-csrf-token', st.csrf).send({});
    expect(up.status).toBe(401);
    expect(up.body.step_up).toBe(true);
    expect(up.body.window_seconds).toBe(30);
    await setPolicy({});
  });

  it('restricts the MFA methods without locking anyone out', async () => {
    expect((await as('put', '/api/admin/signin-policy', { mfaMethods: [] })).status).toBe(400);
    await setPolicy({ mfaMethods: ['passkey'] });
    await user(h, 'factorless', ['member']);
    const r = await signIn(h, 'factorless');
    const refused = await r.agent.post('/api/me/mfa/totp').set('x-csrf-token', r.csrf).send({});
    expect(refused.status).toBe(403);
    expect(refused.body.reason).toBe('mfa_method_not_allowed');
    expect((await r.agent.get('/api/me/mfa')).body.allowedMethods).toEqual(['passkey']);
    // Offered at sign-in: the allowed kinds the account has; an account with none of them keeps its own.
    expect(await h.s.account.policy.offered(h.tenantId, ['webauthn', 'totp', 'recovery'])).toEqual(['webauthn', 'recovery']);
    expect(await h.s.account.policy.offered(h.tenantId, ['totp', 'recovery'])).toEqual(['totp', 'recovery']);
    // The admin, who has only TOTP, still signs in with it.
    const s2 = await signIn(h, 'poladmin');
    expect(s2.res.body.stage).toBe('mfa');
    expect(s2.res.body.mfa.methods).toContain('totp');
    const ok = await s2.agent.post('/api/auth/mfa/totp').set('x-csrf-token', s2.csrf).send({ code: totp.generate(a.secret) });
    expect([200, 401]).toContain(ok.status); // the code may be the one used a moment ago
    await setPolicy({});
  });

  it('applies the policy at change, reset, import and admin set', async () => {
    await setPolicy({ password: { requireDigit: true } });
    const u = await user(h, 'everywhere', ['member']);
    // Change.
    const r = await signIn(h, 'everywhere');
    expect(r.res.body.stage).toBe('password'); // GOOD has no digit: accepted, and a change is asked for
    expect(r.res.body.passwordChange).toEqual({ reason: 'policy' });
    const change = await r.agent.post('/api/me/password').set('x-csrf-token', r.csrf).send({ currentPassword: GOOD, newPassword: 'quartz lamp over a meadow' });
    expect(change.status).toBe(400);
    expect(change.body.rule).toBe('digit');
    // Reset by link.
    const { token } = await h.s.account.issueToken({ tenantId: h.tenantId, userId: u.id, kind: 'reset', ttlMs: 600_000 });
    const reset = await request(h.app).post('/api/auth/password/reset').send({ token, password: 'quartz lamp over a meadow' });
    expect(reset.status).toBe(400);
    expect(reset.body.rule).toBe('digit');
    expect((await request(h.app).post('/api/auth/password/reset').send({ token, password: 'quartz lamp over 7 meadows' })).status).toBe(200);
    // Admin set, and admin create with a password.
    const set = await as('post', `/api/admin/users/${u.id}/password`, { mode: 'temporary', password: 'copper bell in the fog' });
    expect(set.status).toBe(400);
    expect(set.body.rule).toBe('digit');
    const create = await as('post', '/api/admin/users', { username: 'madeby', displayName: 'Made By', roles: ['member'], password: 'copper bell in the fog' });
    expect(create.status).toBe(400);
    // Import: the password column, for new accounts.
    const csv = 'kind,username,display_name,roles,password\nuser,imp1,Imp One,member,copper bell in the fog\nuser,imp2,Imp Two,member,copper bell 4 the fog\n';
    const out = await h.s.userImports.run({ kind: 'cli', tenantId: h.tenantId }, csv, { dryRun: false, sendInvites: false });
    const byKey = Object.fromEntries(out.report.map((x) => [x.key, x]));
    expect(byKey.imp1!.action).toBe('error');
    expect(byKey.imp1!.detail).toMatch(/refused: Include a digit/);
    expect(JSON.stringify(out.report)).not.toContain('copper bell');
    expect(byKey.imp2!.action).toBe('create');
    const imp2 = await h.s.users.byUsername(h.tenantId, 'imp2');
    expect(await h.s.account.mustChange(imp2!.id)).toBe(true);
    expect((await signIn(h, 'imp2', 'copper bell 4 the fog')).res.body.stage).toBe('password');
    await setPolicy({});
  });

  it('shows what applies to a person, with the sources', async () => {
    const u = await user(h, 'applies', ['member']);
    let v = (await as('get', `/api/admin/users/${u.id}/signin-policy`)).body;
    expect(v.configured).toBe(false);
    expect(v.sources['password.minLength']).toBe('platform floor');
    expect(v.sources['lockout.maxAttempts']).toBe('platform');
    expect(v.sources['mfaMethods']).toBe('default');
    expect(v.password.managedHere).toBe(true);
    expect(v.mfa.required).toBe(false);
    await setPolicy({ password: { minLength: 14, expiryDays: 30 }, sessions: { idleMinutes: 10 } });
    v = (await as('get', `/api/admin/users/${u.id}/signin-policy`)).body;
    expect(v.configured).toBe(true);
    expect(v.sources['password.minLength']).toBe('tenant');
    expect(v.sources['sessions.idleMinutes']).toBe('tenant');
    expect(v.sources['sessions.absoluteHours']).toBe('platform');
    expect(v.password.rules.minLength).toBe(14);
    expect(v.password.expiresAt).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    const adminRow = (await h.s.users.byUsername(h.tenantId, 'poladmin'))!;
    const av = (await as('get', `/api/admin/users/${adminRow.id}/signin-policy`)).body;
    expect(av.mfa).toMatchObject({ required: true, why: 'role', enrolled: ['totp'] });
    // A member without users:manage cannot read it.
    const m = await signIn(h, 'applies');
    expect((await m.agent.get(`/api/admin/users/${u.id}/signin-policy`)).status).toBe(403);
    await as('delete', '/api/admin/signin-policy');
    const audit = await h.s.db('audit_events').where({ tenant_id: h.tenantId }).whereIn('action', ['identity.policy.updated', 'identity.policy.reset']);
    expect(audit.length).toBeGreaterThan(3);
  });

  it('checks in order: policy, deny words, leaked lists (stubbed)', async () => {
    const calls: string[] = [];
    let deny: { found: boolean; term?: string } = { found: false };
    let leaked: LeakedPasswordResult = { found: false };
    const hosts = h.s as unknown as Record<string, unknown>;
    const real = { passwordDenyWords: hosts.passwordDenyWords, leakedPasswords: hosts.leakedPasswords };
    hosts.passwordDenyWords = { check: async (tenantId: string) => (calls.push(`deny:${tenantId === h.tenantId}`), deny) };
    hosts.leakedPasswords = { check: async (tenantId: string) => (calls.push(`leaked:${tenantId === h.tenantId}`), leaked) };
    try {
      const check = (password: string) => h.s.account.checkNewPassword({ tenantId: h.tenantId, username: 'pipe', password });
      // The policy refuses first: neither check runs.
      await expect(check('short')).rejects.toMatchObject({ status: 400, extensions: { reason: 'policy' } });
      expect(calls).toEqual([]);
      // A deny word stops before the leaked lists.
      deny = { found: true, term: 'acme' };
      await expect(check('acme rocket launch day')).rejects.toMatchObject({ status: 400, extensions: { reason: 'deny_word' } });
      expect(calls).toEqual(['deny:true']);
      // Both run, in order; the leaked check decides what a hit means.
      deny = { found: false };
      calls.length = 0;
      leaked = { found: true };
      await expect(check(GOOD)).rejects.toMatchObject({ status: 400, extensions: { reason: 'leaked' } });
      expect(calls).toEqual(['deny:true', 'leaked:true']);
      leaked = { found: true, action: 'warn' };
      expect((await check(GOOD)).warnings[0]).toMatch(/leaked/);
      leaked = { unavailable: true, action: 'block' };
      await expect(check(GOOD)).rejects.toMatchObject({ status: 503 });
      leaked = { unavailable: true };
      expect((await check(GOOD)).warnings).toEqual([]);
      const miss = await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'password.breach_check.unavailable' });
      expect(miss.length).toBe(2);
      leaked = { found: false };
      expect(await check(GOOD)).toEqual({ warnings: [] });
    } finally {
      hosts.passwordDenyWords = real.passwordDenyWords;
      hosts.leakedPasswords = real.leakedPasswords;
    }
  });
});

describe('B-190 before migration 129', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
    // without migration 129 (the harness runs it since it was registered)
    await down129(h.s.db);
  });
  afterAll(async () => h.close());

  it('signs in, sets passwords and answers as today', async () => {
    await user(h, 'nomig', ['member']);
    const r = await signIn(h, 'nomig');
    expect(r.res.body.stage).toBe('active');
    expect(await h.s.account.policy.available()).toBe(false);
    const change = await r.agent.post('/api/me/password').set('x-csrf-token', r.csrf).send({ currentPassword: GOOD, newPassword: 'quartz lamp over a meadow' });
    expect(change.status, JSON.stringify(change.body)).toBe(200);
    expect((await h.s.account.policy.effective(h.tenantId)).configured).toBe(false);
    await user(h, 'nomigadmin', ['identity-admin', 'member']);
    const a = await admin(h, 'nomigadmin');
    const view = await a.agent.get('/api/admin/signin-policy');
    expect(view.status).toBe(200);
    expect(view.body.available).toBe(false);
    expect((await a.agent.put('/api/admin/signin-policy').set('x-csrf-token', a.csrf).send({ password: { minLength: 14 } })).status).toBe(503);
  });
});
