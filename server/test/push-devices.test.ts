import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '../src/authz/policy.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';

/*
 * 1.9.0, Sprint 49 (B-150): push devices. Register, re-register, rename and revoke; the token sealed at rest and never
 * answered; markGone for delivery; the idle prune; revoked with the person's sessions and at offboarding; nobody else
 * sees or ends a person's devices except an admin with users:manage; every change audited.
 */

const APNS = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const p256dh = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');
const auth = Buffer.alloc(16, 9).toString('base64url');
const WEBPUSH = { endpoint: 'https://push.example.test/send/abcdef123456', keys: { p256dh, auth } };

type Agent = Awaited<ReturnType<typeof login>>;
const send = (c: Agent, m: 'post' | 'patch' | 'delete', path: string, body: object = {}) => c.agent[m](path).set('x-csrf-token', c.csrf).send(body);

describe('push devices (Sprint 49, B-150)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.close();
  });

  const actions = async (prefix = 'push.device.') => ((await h.s.audit.list(h.tenantId, { limit: 200 })) as { action: string; detail: Record<string, unknown> | null; target: Record<string, unknown> }[]).filter((e) => e.action.startsWith(prefix));

  it('registers, re-registers the same token without a duplicate, renames and revokes; the token is sealed and never answered', async () => {
    const u = await localUser(h, 'ana', ['member']);
    const c = await login(h, 'ana');
    const first = await send(c, 'post', '/api/me/devices', { platform: 'ios', provider: 'apns', appId: 'net.exprsn.app', name: 'Ana phone', token: APNS }).expect(201);
    expect(first.body).toMatchObject({ platform: 'ios', provider: 'apns', appId: 'net.exprsn.app', name: 'Ana phone', state: 'active', current: true });
    expect(first.body.fingerprint).toMatch(/^[0-9a-f]{4}:[0-9a-f]{4}:[0-9a-f]{4}$/);
    expect(JSON.stringify(first.body)).not.toContain(APNS);

    // Same token again: the same row, updated, not audited again when nothing changed.
    const again = await send(c, 'post', '/api/me/devices', { platform: 'ios', provider: 'apns', appId: 'net.exprsn.app', token: APNS }).expect(200);
    expect(again.body.id).toBe(first.body.id);
    expect(again.body.name).toBe('Ana phone');
    expect(await h.s.db('push_devices').count({ n: '*' }).first()).toMatchObject({ n: 1 });

    // A Web Push subscription is a second device.
    const web = await send(c, 'post', '/api/me/devices', { platform: 'web', provider: 'webpush', subscription: WEBPUSH }).expect(201);
    expect(web.body.name).toBe('Web browser');
    expect(JSON.stringify(web.body)).not.toContain(p256dh);

    // At rest: sealed, neither token nor key material in the clear.
    const rows = (await h.s.db('push_devices').select('*')) as Record<string, string>[];
    for (const r of rows) {
      expect(String(r.token_sealed).startsWith('v2.')).toBe(true);
      expect(JSON.stringify(r)).not.toContain(APNS);
      expect(JSON.stringify(r)).not.toContain(p256dh);
      expect(JSON.stringify(r)).not.toContain(WEBPUSH.endpoint);
    }
    // For delivery only: opened.
    const forDelivery = await h.s.pushDevices.forDelivery(h.tenantId, u.id);
    expect(forDelivery.find((d) => d.provider === 'apns')!.token).toBe(APNS);
    expect(forDelivery.find((d) => d.provider === 'webpush')!.subscription).toEqual(WEBPUSH);

    const list = (await c.agent.get('/api/me/devices').expect(200)).body.devices as { id: string }[];
    expect(list).toHaveLength(2);
    expect(JSON.stringify(list)).not.toContain(APNS);

    await send(c, 'patch', `/api/me/devices/${first.body.id}`, { name: 'Work phone' }).expect(200);
    const revoked = await send(c, 'delete', `/api/me/devices/${first.body.id}`).expect(200);
    expect(revoked.body).toMatchObject({ state: 'revoked', reason: 'by you' });
    // An ended device keeps no token and is not delivered to.
    expect((await h.s.db('push_devices').where({ id: first.body.id }).first()).token_sealed).toBeNull();
    expect((await h.s.pushDevices.forDelivery(h.tenantId, u.id)).map((d) => d.provider)).toEqual(['webpush']);
    // Registering it again brings it back (one row still).
    const back = await send(c, 'post', '/api/me/devices', { platform: 'ios', provider: 'apns', appId: 'net.exprsn.app', token: APNS }).expect(200);
    expect(back.body).toMatchObject({ id: first.body.id, state: 'active' });

    const a = await actions();
    expect(a.map((e) => e.action)).toEqual(expect.arrayContaining(['push.device.registered', 'push.device.renamed', 'push.device.revoked']));
    expect(a.filter((e) => e.action === 'push.device.registered')).toHaveLength(3); // new, web, reactivated
    expect(JSON.stringify(a)).not.toContain(APNS);
  });

  it('validates the platform, provider and token', async () => {
    await localUser(h, 'ana', ['member']);
    const c = await login(h, 'ana');
    await send(c, 'post', '/api/me/devices', { platform: 'android', provider: 'apns', token: APNS }).expect(400);
    await send(c, 'post', '/api/me/devices', { platform: 'web', provider: 'webpush', token: APNS }).expect(400);
    await send(c, 'post', '/api/me/devices', { platform: 'web', provider: 'webpush', subscription: { ...WEBPUSH, endpoint: 'http://push.example.test/x' } }).expect(400);
    await send(c, 'post', '/api/me/devices', { platform: 'web', provider: 'webpush', subscription: { ...WEBPUSH, keys: { p256dh: 'short', auth } } }).expect(400);
    await send(c, 'post', '/api/me/devices', { platform: 'ios', provider: 'carrier-pigeon', token: APNS }).expect(400);
    await send(c, 'post', '/api/me/devices', { platform: 'ios', provider: 'apns', token: APNS, tenantId: 'other' }).expect(400);
  });

  it('keeps people apart; an admin with users:manage lists and revokes, others may not', async () => {
    const ana = await localUser(h, 'ana', ['member']);
    await localUser(h, 'ben', ['member']);
    await localUser(h, 'ida', ['identity-admin'], 'confidential');
    const a = await login(h, 'ana');
    const b = await login(h, 'ben');
    const dev = (await send(a, 'post', '/api/me/devices', { platform: 'android', provider: 'fcm', token: 'fcm-token-of-ana-0001' }).expect(201)).body;
    expect((await b.agent.get('/api/me/devices').expect(200)).body.devices).toEqual([]);
    await send(b, 'patch', `/api/me/devices/${dev.id}`, { name: 'mine now' }).expect(404);
    await send(b, 'delete', `/api/me/devices/${dev.id}`).expect(404);
    await b.agent.get(`/api/admin/users/${ana.id}/devices`).expect(403);

    const admin = await loginAdmin(h, 'ida');
    const seen = (await admin.agent.get(`/api/admin/users/${ana.id}/devices`).expect(200)).body.devices;
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen)).not.toContain('fcm-token-of-ana-0001');
    const r = await admin.agent.delete(`/api/admin/users/${ana.id}/devices/${dev.id}`).set('x-csrf-token', admin.csrf).expect(200);
    expect(r.body.state).toBe('revoked');
    await admin.agent.get('/api/admin/users/01NOSUCHUSER0000000000000/devices').expect(404);

    // The same token registered by someone else moves the device to them.
    await send(a, 'post', '/api/me/devices', { platform: 'android', provider: 'fcm', token: 'fcm-shared-tablet-0002' }).expect(201);
    const moved = await send(b, 'post', '/api/me/devices', { platform: 'android', provider: 'fcm', token: 'fcm-shared-tablet-0002' }).expect(200);
    expect(moved.body.name).toBe('Android device');
    expect((await a.agent.get('/api/me/devices').expect(200)).body.devices.map((d: { id: string }) => d.id)).not.toContain(moved.body.id);
    expect((await actions()).some((e) => e.action === 'push.device.registered' && e.detail?.movedFrom === ana.id)).toBe(true);
  });

  it('marks a device gone when the provider says so, and prunes idle ones', async () => {
    const u = await localUser(h, 'ana', ['member']);
    const c = await login(h, 'ana');
    const d1 = (await send(c, 'post', '/api/me/devices', { platform: 'android', provider: 'fcm', token: 'fcm-token-gone-0001' }).expect(201)).body;
    const d2 = (await send(c, 'post', '/api/me/devices', { platform: 'android', provider: 'fcm', token: 'fcm-token-idle-0002' }).expect(201)).body;
    const d3 = (await send(c, 'post', '/api/me/devices', { platform: 'ios', provider: 'apns', token: APNS }).expect(201)).body;

    expect(await h.s.pushDevices.markGone(d1.id, 'FCM UNREGISTERED')).toBe(true);
    expect(await h.s.pushDevices.markGone(d1.id, 'again')).toBe(false);
    expect(await h.s.pushDevices.markGone('01NOSUCHDEVICE00000000000', 'x')).toBe(false);
    expect((await c.agent.get('/api/me/devices').expect(200)).body.devices.find((d: { id: string }) => d.id === d1.id)).toMatchObject({ state: 'gone', reason: 'FCM UNREGISTERED' });
    expect((await h.s.pushDevices.forDelivery(h.tenantId, u.id)).map((d) => d.id).sort()).toEqual([d2.id, d3.id].sort());

    const now = Date.now();
    await h.s.db('push_devices').where({ id: d2.id }).update({ last_seen_at: now - 91 * 86_400_000 });
    await h.s.db('push_devices').where({ id: d3.id }).update({ last_seen_at: now - 89 * 86_400_000 });
    await h.s.db('push_devices').where({ id: d1.id }).update({ ended_at: now - 31 * 86_400_000 });
    expect(await h.s.pushDevices.prune(h.tenantId, now)).toEqual({ pruned: 1, endedRemoved: 1 });
    expect((await h.s.db('push_devices').select('id')).map((r: { id: string }) => r.id)).toEqual([d3.id]);

    const a = await actions();
    expect(a.find((e) => e.action === 'push.device.gone')).toMatchObject({ target: { user: u.id, device: d1.id }, detail: { reason: 'FCM UNREGISTERED' } });
    expect(a.find((e) => e.action === 'push.device.pruned')).toMatchObject({ detail: { idleDays: 90, count: 1, devices: [d2.id] } });
  });

  it('honours PUSH_DEVICE_IDLE_DAYS', async () => {
    await h.close();
    h = await harness({ PUSH_DEVICE_IDLE_DAYS: '10' });
    await localUser(h, 'ana', ['member']);
    const c = await login(h, 'ana');
    const d = (await send(c, 'post', '/api/me/devices', { platform: 'android', provider: 'fcm', token: 'fcm-token-ten-days-01' }).expect(201)).body;
    await h.s.db('push_devices').where({ id: d.id }).update({ last_seen_at: Date.now() - 11 * 86_400_000 });
    expect((await h.s.pushDevices.prune(h.tenantId)).pruned).toBe(1);
  });

  it('revokes devices with the sessions: sign out everywhere else keeps this session\'s device; one session\'s sign-out ends its own', async () => {
    const u = await localUser(h, 'ana', ['member']);
    const here = await login(h, 'ana');
    const there = await login(h, 'ana');
    const mine = (await send(here, 'post', '/api/me/devices', { platform: 'web', provider: 'webpush', subscription: WEBPUSH }).expect(201)).body;
    const other = (await send(there, 'post', '/api/me/devices', { platform: 'android', provider: 'fcm', token: 'fcm-token-other-0001' }).expect(201)).body;
    expect((await here.agent.get('/api/me/devices').expect(200)).body.devices.find((d: { id: string }) => d.id === mine.id).current).toBe(true);

    await send(here, 'post', '/api/me/sessions/revoke-others').expect(200);
    const after = (await here.agent.get('/api/me/devices').expect(200)).body.devices as { id: string; state: string; reason: string }[];
    expect(after.find((d) => d.id === mine.id)!.state).toBe('active');
    expect(after.find((d) => d.id === other.id)).toMatchObject({ state: 'revoked', reason: 'with your other sessions' });

    // Signing out of this browser ends the device registered from it.
    await send(here, 'post', '/api/auth/logout').expect((r) => expect([200, 204]).toContain(r.status));
    expect((await h.s.db('push_devices').where({ id: mine.id }).first()).state).toBe('revoked');
    expect((await h.s.pushDevices.forDelivery(h.tenantId, u.id))).toEqual([]);
    expect((await actions()).filter((e) => e.action === 'push.device.revoked').map((e) => e.detail?.reason)).toEqual(expect.arrayContaining(['with your other sessions', 'with the session it was registered from']));
  });

  it('revokes every device of a tenant at offboarding, and the purge deletes them', async () => {
    await localUser(h, 'root', ['system-admin'], 'restricted');
    const admin = await loginAdmin(h, 'root');
    const tid = (await admin.agent.post('/api/admin/tenants').set('x-csrf-token', admin.csrf).send({ slug: 'contoso', name: 'Contoso Freight' }).expect(201)).body.id as string;
    const p = { kind: 'user', userId: '01CONTOSOUSER000000000000', tenantId: tid, tenantSlug: 'contoso', username: 'c', displayName: 'C', roles: ['member'], clearance: 'internal', scopes: null, sessionId: null, apiKeyId: null, mfa: false } as Principal;
    await h.s.pushDevices.register(p, { platform: 'android', provider: 'fcm', token: 'fcm-contoso-device-001' });
    await admin.agent.post(`/api/admin/tenants/${tid}/offboard`).set('x-csrf-token', admin.csrf).send({ confirm: 'Contoso Freight' }).expect(202);
    const row = await h.s.db('push_devices').where({ tenant_id: tid }).first();
    expect(row).toMatchObject({ state: 'revoked', token_sealed: null });
    await h.s.jobs.runDue();
    expect(await h.s.db('push_devices').where({ tenant_id: tid })).toEqual([]);
  });
});
