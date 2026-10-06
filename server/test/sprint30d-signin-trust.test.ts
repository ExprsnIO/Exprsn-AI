import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harness, localUser, loginAdmin, PASSWORD, type Client, type Harness } from './helpers.js';

/*
 * Sprint 30d (B-3413): the pending second-factor session tells the sign-in page how long "trust this browser" lasts
 * for this account, so the console offers it only when the tenant allows trusted devices and the account may have one.
 */

describe('Sprint 30d: trusted-device period on the second-factor step', () => {
  let h: Harness;
  let ida: Client;
  const put = (url: string, body: object) => ida.agent.put(url).set('x-csrf-token', ida.csrf).send(body);
  const pending = async (username: string) => {
    const agent = request.agent(h.app);
    const res = await agent.post('/api/auth/login').send({ username, password: PASSWORD }).expect(200);
    const session = await agent.get('/api/auth/session').expect(200);
    return { login: res.body, session: session.body };
  };

  beforeAll(async () => {
    h = await harness();
    await localUser(h, 'ida', ['identity-admin'], 'confidential');
    ida = await loginAdmin(h, 'ida');
    // A member with a confirmed factor: may get a trusted device.
    const u = await localUser(h, 'walker', ['member']);
    await h.s.users.update(h.tenantId, u.id, { mfa_required: true });
    await loginAdmin(h, 'walker');
    await h.s.users.update(h.tenantId, u.id, { mfa_required: false });
  });
  afterAll(async () => h.close());

  it('is the tenant period for a member, and 0 for an admin or while trusted devices are off', async () => {
    await put('/api/admin/identity-policy/mfa', { require: 'off', trustedDeviceDays: 0 }).expect(200);
    let m = await pending('walker');
    expect(m.login.stage).toBe('mfa');
    expect(m.login.mfa.trustedDeviceDays).toBe(0);

    await put('/api/admin/identity-policy/mfa', { require: 'off', trustedDeviceDays: 21 }).expect(200);
    m = await pending('walker');
    expect(m.login.mfa).toMatchObject({ trustedDeviceDays: 21 });
    expect(m.session.mfa).toMatchObject({ trustedDeviceDays: 21 });

    // Admins are asked for the factor on every sign-in: no trusted device to offer.
    const admin = await pending('ida');
    expect(admin.login.stage).toBe('mfa');
    expect(admin.login.mfa.trustedDeviceDays).toBe(0);

    // An active session's body does not carry it.
    const me = await ida.agent.get('/api/auth/session').expect(200);
    expect(me.body.mfa.trustedDeviceDays).toBeUndefined();
  });
});

describe('Sprint 30d: the account address in GET /api/me', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(async () => h.close());

  it('carries the address and whether it is proven', async () => {
    const u = await localUser(h, 'addressed', ['member']);
    await h.s.users.update(h.tenantId, u.id, { email: 'addressed@example.com' });
    const agent = request.agent(h.app);
    await agent.post('/api/auth/login').send({ username: 'addressed', password: PASSWORD }).expect(200);
    let me = (await agent.get('/api/me').expect(200)).body;
    expect(me.user).toMatchObject({ username: 'addressed', email: 'addressed@example.com', emailVerified: false });
    await h.s.db('users').where({ id: u.id }).update({ email_verified_at: Date.now() });
    me = (await agent.get('/api/me').expect(200)).body;
    expect(me.user.emailVerified).toBe(true);
  });
});
