import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { totp } from '../src/identity/totp.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';
import { davClient } from './dav-helpers.js';

/*
 * Sprint 32 (1.5.0), B-3415: Settings lists, creates and revokes app passwords for DAV clients and shows the discovery
 * URLs. `GET /api/me/dav` tells Settings what to show; the routes under `/api/me/app-passwords` are B-3101's.
 */

type DavInfo = {
  username: string;
  usernameWithTenant: string;
  server: { url: string; caldav: string; carddav: string; webdav: string };
  scopes: { scope: string; available: boolean }[];
  stepUp: { hasFactor: boolean; windowSeconds: number; freshUntil: number | null };
};

describe('Settings: app passwords for DAV clients (B-3415)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('gives the discovery URLs, the username and whether a step-up is needed', async () => {
    await localUser(h, 'ta', ['tenant-admin']);
    const a = await loginAdmin(h, 'ta');
    const fresh = (await a.agent.get('/api/me/dav').expect(200)).body as DavInfo;
    expect(fresh.username).toBe('ta');
    expect(fresh.usernameWithTenant).toMatch(/^ta@.+/);
    expect(fresh.server.caldav).toMatch(/\/\.well-known\/caldav$/);
    expect(fresh.server.carddav).toMatch(/\/\.well-known\/carddav$/);
    expect(fresh.server.url).toMatch(/\/dav\/$/);
    expect(fresh.server.webdav).toMatch(/\/dav\/files\/$/);
    expect(fresh.scopes.map((x) => x.scope)).toEqual(['caldav', 'carddav', 'webdav']);
    expect(fresh.scopes.find((x) => x.scope === 'caldav')!.available).toBe(true);
    // Signing in with the factor just now: creating one needs no step-up for the window.
    expect(fresh.stepUp.hasFactor).toBe(true);
    expect(fresh.stepUp.freshUntil).toBeGreaterThan(Date.now());
    expect(fresh.stepUp.freshUntil! - Date.now()).toBeLessThanOrEqual(fresh.stepUp.windowSeconds * 1000);

    // An hour later the factor is stale; a password step-up does not make it fresh again, a code does.
    const user = (await h.s.users.list(h.tenantId)).find((u) => u.username === 'ta')!;
    await h.s.db('sessions').where({ user_id: user.id }).update({ mfa_verified_at: Date.now() - 3600_000, auth_at: Date.now() - 3600_000 });
    expect(((await a.agent.get('/api/me/dav').expect(200)).body as DavInfo).stepUp.freshUntil).toBeNull();
    await a.agent.post('/api/me/step-up').set('x-csrf-token', a.csrf).send({ password: 'correct horse battery staple' }).expect(200);
    expect(((await a.agent.get('/api/me/dav').expect(200)).body as DavInfo).stepUp.freshUntil).toBeNull();
    await a.agent.post('/api/me/step-up').set('x-csrf-token', a.csrf).send({ code: totp.generate(a.totpSecret, Date.now() + 30_000) }).expect(200);
    expect(((await a.agent.get('/api/me/dav').expect(200)).body as DavInfo).stepUp.freshUntil).toBeGreaterThan(Date.now());

    // An account without a second factor is told so; a member's roles allow CalDAV and CardDAV.
    await localUser(h, 'plain', ['member']);
    const m = await login(h, 'plain');
    const plain = (await m.agent.get('/api/me/dav').expect(200)).body as DavInfo;
    expect(plain.stepUp).toMatchObject({ hasFactor: false, freshUntil: null });
    expect(plain.scopes.filter((x) => x.available).map((x) => x.scope)).toEqual(expect.arrayContaining(['caldav', 'carddav']));
    // Settings is the browser's: an app password itself never reads it.
    const { password } = await h.s.dav.passwords.create({ tenantId: h.tenantId, userId: (await h.s.users.list(h.tenantId)).find((u) => u.username === 'plain')!.id, name: 'Phone', scopes: ['caldav'], ttlDays: null });
    await request(h.app).get('/api/me/dav').auth('plain', password).expect(401);
  });

  it('creates one shown once with the discovery URLs, records its use, and refuses the next DAV request once revoked', async () => {
    await localUser(h, 'ta', ['tenant-admin']);
    const a = await loginAdmin(h, 'ta');
    const created = (await a.agent.post('/api/me/app-passwords').set('x-csrf-token', a.csrf).send({ name: 'Work Mac', scopes: ['caldav'], ttlDays: 90 }).expect(201)).body;
    expect(created.server.webdav).toMatch(/\/dav\/files\/$/);
    expect(created.expiresAt - created.createdAt).toBe(90 * 86_400_000);
    // The list never carries the secret.
    const before = (await a.agent.get('/api/me/app-passwords').expect(200)).body as Record<string, unknown>[];
    expect(JSON.stringify(before)).not.toContain(created.password);

    const dav = davClient(h, 'ta', created.password);
    await dav('PROPFIND', '/dav/').set('Depth', '0').set('User-Agent', 'macOS/27.0 CalendarAgent').expect(207);
    const used = ((await a.agent.get('/api/me/app-passwords').expect(200)).body as { id: string; lastUsedAt: number | null; lastUsedAgent: string | null; state: string }[]).find((x) => x.id === created.id)!;
    expect(used.lastUsedAt).toBeGreaterThan(0);
    expect(used.lastUsedAgent).toContain('CalendarAgent');

    await a.agent.delete(`/api/me/app-passwords/${created.id}`).set('x-csrf-token', a.csrf).expect(204);
    await dav('PROPFIND', '/dav/').set('Depth', '0').expect(401);
    const after = ((await a.agent.get('/api/me/app-passwords').expect(200)).body as { id: string; state: string; revokedAt: number | null }[]).find((x) => x.id === created.id)!;
    expect(after.state).toBe('revoked');
    expect(after.revokedAt).toBeGreaterThan(0);
    // Revoking twice, or someone else's, is a 404.
    await a.agent.delete(`/api/me/app-passwords/${created.id}`).set('x-csrf-token', a.csrf).expect(404);
  });

  it('the WebDAV URL Settings shows answers: the file store, for a password with the WebDAV scope (B-32, Sprint 34)', async () => {
    await localUser(h, 'ta', ['tenant-admin']);
    const a = await loginAdmin(h, 'ta');
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Shared drive', 'internal')).id;
    const user = (await h.s.users.list(h.tenantId)).find((u) => u.username === 'ta')!;
    await h.s.tenants.addMember(ws, user.id);
    const info = (await a.agent.get('/api/me/dav').expect(200)).body as DavInfo;
    const path = new URL(info.server.webdav).pathname;
    expect(path).toBe('/dav/files/');

    const files = (await a.agent.post('/api/me/app-passwords').set('x-csrf-token', a.csrf).send({ name: 'Finder', scopes: ['webdav'], ttlDays: 30 }).expect(201)).body;
    const dav = davClient(h, 'ta', files.password);
    const listing = await dav('PROPFIND', path).set('Depth', '1').expect(207);
    expect(listing.text).toContain('<d:displayname>Shared drive</d:displayname>');
    expect((await dav('OPTIONS', path).expect(200)).headers.dav).toMatch(/\b2\b/);

    // A calendar-only password does not reach the files.
    const cal = (await a.agent.post('/api/me/app-passwords').set('x-csrf-token', a.csrf).send({ name: 'Phone', scopes: ['caldav'], ttlDays: 30 }).expect(201)).body;
    const r = await davClient(h, 'ta', cal.password)('PROPFIND', path).set('Depth', '1');
    expect(r.status).toBe(403);
  });
});
