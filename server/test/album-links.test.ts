import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALBUM_PASSWORD_ATTEMPTS } from '../src/files/album-links.js';
import { zipEntries } from '../src/knowledge/extract.js';
import type { Harness } from './helpers.js';
import { albumHarness, allowAnonymousLinks, audits, binary, drain, member, png, type Member } from './album-helpers.js';
import { person } from './spam-helpers.js';

/*
 * 1.9.0, Sprint 53 (B-178): album share links (expiry, a password with its attempt limit, view only against download,
 * revocation) and upload links (limits, the uploader's name, the scan holding an upload until it passes, rejection,
 * the spam signals, the album's label on what comes in).
 */

describe('B-178: album share links', () => {
  let h: Harness;
  let ws: string;
  let ann: Member;
  let albumId: string;
  const anon = () => request(h.app);

  beforeEach(async () => {
    h = await albumHarness({ SHARE_ANONYMOUS_PER_MINUTE: '1000' });
    ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Family', 'confidential')).id;
    ann = await member(h, 'ann', [ws]);
    const pub = await ann.upload('beach.png', png(1), { label: 'public' });
    const inner = await ann.upload('kitchen.png', png(2), { label: 'internal' });
    albumId = (await ann.post('/api/albums', { kind: 'workspace', title: 'Summer', workspaceId: ws, label: 'public' }).expect(201)).body.id;
    await ann.post(`/api/albums/${albumId}/items`, { fileIds: [pub.id, inner.id] }).expect(201);
    await ann.put(`/api/files/${pub.id}/meta`, { altText: 'Two children building a sandcastle' }).expect(200);
  });
  afterEach(async () => {
    await h.close();
  });

  it('follows the tenant\'s anonymous-link setting and needs a public album; shows public items only, without signing in', async () => {
    expect((await ann.post(`/api/albums/${albumId}/share-links`, { mode: 'view' })).status).toBe(403);
    await allowAnonymousLinks(h, 48);
    expect((await ann.post(`/api/albums/${albumId}/share-links`, { mode: 'view', expiresInHours: 100 })).status).toBe(400);
    const internalAlbum = (await ann.post('/api/albums', { kind: 'workspace', title: 'Inside', workspaceId: ws }).expect(201)).body.id;
    expect((await ann.post(`/api/albums/${internalAlbum}/share-links`, { mode: 'view' })).body.step).toBe('label');
    const link = (await ann.post(`/api/albums/${albumId}/share-links`, { mode: 'view', expiresInHours: 24 }).expect(201)).body;
    expect(link.token).toMatch(/^exa_/);
    expect(await h.s.db('album_share_links').where({ token_hash: link.token }).first()).toBeUndefined();
    const v = (await anon().post('/api/public/album-links/open').send({ token: link.token }).expect(200)).body;
    expect(v).toMatchObject({ title: 'Summer', mode: 'view', label: 'public' });
    expect(v.items.map((i: { name: string }) => i.name)).toEqual(['beach.png']);
    expect(v.items[0].altText).toBe('Two children building a sandcastle');
    expect(v.items[0].download).toBeUndefined();
    // the media addresses work without a session, and a changed one does not
    const full = await anon().get(v.items[0].full).buffer(true).parse(binary).expect(200);
    expect((full.body as Buffer).subarray(0, 4).toString('latin1')).toBe('\x89PNG');
    expect(full.headers['set-cookie']).toBeUndefined();
    await anon().get(v.items[0].full.replace(/.$/, (c: string) => (c === 'A' ? 'B' : 'A'))).expect(404);
    await anon().get(v.items[0].full.replace('.full.', '.download.')).expect(404);
    const viewed = (await audits(h, 'album.share.viewed'))[0]!;
    expect(JSON.parse(viewed.actor)).toEqual({ ip: expect.any(String) });
  });

  it('expires, is revoked, and stops when the album is no longer public', async () => {
    await allowAnonymousLinks(h);
    const link = (await ann.post(`/api/albums/${albumId}/share-links`, { mode: 'view' }).expect(201)).body;
    await anon().post('/api/public/album-links/open').send({ token: link.token }).expect(200);
    await h.s.db('album_share_links').where({ id: link.id }).update({ expires_at: Date.now() - 1 });
    await anon().post('/api/public/album-links/open').send({ token: link.token }).expect(404);
    const second = (await ann.post(`/api/albums/${albumId}/share-links`, { mode: 'view' }).expect(201)).body;
    await anon().post('/api/public/album-links/open').send({ token: second.token }).expect(200);
    await ann.patch(`/api/albums/${albumId}`, { label: 'internal' }).expect(200);
    await anon().post('/api/public/album-links/open').send({ token: second.token }).expect(404);
    await ann.patch(`/api/albums/${albumId}`, { label: 'public' }).expect(200);
    await ann.del(`/api/albums/${albumId}/share-links/${second.id}`).expect(204);
    await anon().post('/api/public/album-links/open').send({ token: second.token }).expect(404);
    expect((await ann.get(`/api/albums/${albumId}/share-links`).expect(200)).body.map((x: { state: string }) => x.state).sort()).toEqual(['expired', 'revoked']);
    expect((await audits(h, 'album.share.revoked')).length).toBe(1);
  });

  it('a password is hashed with argon2 and its attempts are limited', async () => {
    await allowAnonymousLinks(h);
    const link = (await ann.post(`/api/albums/${albumId}/share-links`, { mode: 'view', password: 'sandcastle-2026' }).expect(201)).body;
    const row = await h.s.db('album_share_links').where({ id: link.id }).first();
    expect(row.password_hash).toMatch(/^\$argon2id\$/);
    const none = await anon().post('/api/public/album-links/open').send({ token: link.token });
    expect(none.status).toBe(401);
    expect(none.body.passwordRequired).toBe(true);
    await anon().post('/api/public/album-links/open').send({ token: link.token, password: 'sandcastle-2026' }).expect(200);
    for (let i = 1; i < ALBUM_PASSWORD_ATTEMPTS; i++) expect((await anon().post('/api/public/album-links/open').send({ token: link.token, password: `wrong-${i}` })).status).toBe(401);
    // the limit counts every attempt: the right password waits too once it is reached
    expect((await anon().post('/api/public/album-links/open').send({ token: link.token, password: 'sandcastle-2026' })).status).toBe(429);
    expect((await audits(h, 'album.share.password_failed')).length).toBe(ALBUM_PASSWORD_ATTEMPTS - 1);
  });

  it('view only against download: only a download link gives items and the zip; each download is audited', async () => {
    await allowAnonymousLinks(h);
    const view = (await ann.post(`/api/albums/${albumId}/share-links`, { mode: 'view' }).expect(201)).body;
    expect((await anon().post('/api/public/album-links/download').send({ token: view.token })).status).toBe(403);
    const dl = (await ann.post(`/api/albums/${albumId}/share-links`, { mode: 'download' }).expect(201)).body;
    const v = (await anon().post('/api/public/album-links/open').send({ token: dl.token }).expect(200)).body;
    expect(v.items[0].download).toBeTruthy();
    const one = await anon().get(v.items[0].download).buffer(true).parse(binary).expect(200);
    expect(one.headers['content-disposition']).toContain('attachment');
    const zip = await anon().post('/api/public/album-links/download').send({ token: dl.token }).buffer(true).parse(binary).expect(200);
    expect([...zipEntries(zip.body as Buffer).keys()]).toEqual(['beach.png']);
    const d = await audits(h, 'album.share.downloaded');
    expect(d.map((x) => JSON.parse(x.detail!).what).sort()).toEqual(['item', 'zip']);
    expect((await ann.get(`/api/albums/${albumId}/share-links`).expect(200)).body.find((x: { id: string }) => x.id === dl.id)).toMatchObject({ views: 1, downloads: 2 });
  });
});

describe('B-178: album upload links', () => {
  let h: Harness;
  let ws: string;
  let ann: Member;
  let albumId: string;
  const anon = () => request(h.app);
  const put = (token: string, name: string, uploader: string | null, data: Buffer) => {
    const q = new URLSearchParams({ name, ...(uploader != null ? { uploader } : {}) });
    return anon().put(`/api/public/album-uploads?${q.toString()}`).set('x-upload-token', token).set('content-type', 'application/octet-stream').send(data);
  };

  beforeEach(async () => {
    h = await albumHarness({ SHARE_ANONYMOUS_PER_MINUTE: '1000' });
    ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Family', 'confidential')).id;
    ann = await member(h, 'ann', [ws], { clearance: 'confidential' });
    albumId = (await ann.post('/api/albums', { kind: 'workspace', title: 'Wedding', workspaceId: ws, label: 'confidential' }).expect(201)).body.id;
  });
  afterEach(async () => {
    await h.close();
  });

  it('asks the uploader\'s name, holds each upload until its scan passes, then adds it with the album\'s label', async () => {
    const link = (await ann.post(`/api/albums/${albumId}/upload-links`, { maxFiles: 5, expiresInHours: 24 }).expect(201)).body;
    expect(link.token).toMatch(/^exu_/);
    expect((await anon().post('/api/public/album-uploads/open').send({ token: link.token }).expect(200)).body).toMatchObject({ albumTitle: 'Wedding', maxFiles: 5, remaining: 5 });
    expect((await put(link.token, 'one.png', null, png(1))).status).toBe(400);
    const given = 'Tante Ève <the "best" aunt>';
    const up = (await put(link.token, 'one.png', given, png(1)).expect(202)).body;
    expect(up.state).toBe('scanning');
    // held: not in the album yet, and the file is in quarantine
    expect((await ann.get(`/api/albums/${albumId}`).expect(200)).body.items).toHaveLength(0);
    let list = (await ann.get(`/api/albums/${albumId}/uploads`).expect(200)).body;
    expect(list[0]).toMatchObject({ name: 'one.png', uploaderName: given, state: 'scanning' });
    const stored = await h.s.db('album_pending_uploads').where({ id: up.id }).first();
    expect(stored.uploader_name).not.toContain('Tante');
    await drain(h);
    list = (await ann.get(`/api/albums/${albumId}/uploads`).expect(200)).body;
    expect(list[0].state).toBe('added');
    const items = (await ann.get(`/api/albums/${albumId}`).expect(200)).body.items;
    expect(items.map((i: { name: string; label: string }) => `${i.name}:${i.label}`)).toEqual(['one.png:confidential']);
    const file = await h.s.db('files').where({ id: list[0].fileId }).first();
    expect(file).toMatchObject({ owner_id: ann.user.id, workspace_id: ws, label: 'confidential', state: 'ready' });
    for (const a of ['album.upload.link_created', 'album.upload.received', 'album.upload.added']) expect((await audits(h, a)).length).toBe(1);
  });

  it('rejects what the scan rejects and shows it to the owner; the album is unchanged', async () => {
    const link = (await ann.post(`/api/albums/${albumId}/upload-links`, { maxFiles: 5 }).expect(201)).body;
    await put(link.token, 'photo.png', 'Sam', Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0xff, 0x10, 0x20, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06])).expect(202);
    await drain(h);
    const list = (await ann.get(`/api/albums/${albumId}/uploads`).expect(200)).body;
    expect(list[0].state).toBe('rejected');
    expect(list[0].reason).toMatch(/not accepted|Binary/);
    expect((await ann.get(`/api/albums/${albumId}`).expect(200)).body.items).toHaveLength(0);
    expect((await audits(h, 'album.upload.rejected')).length).toBe(1);
    // a viewer cannot see the uploads, only the owner and editors
    const bob = await member(h, 'bob', [ws], { clearance: 'confidential' });
    expect((await bob.get(`/api/albums/${albumId}/uploads`)).status).toBe(403);
  });

  it('enforces the number and size of files, expiry and revocation', async () => {
    const link = (await ann.post(`/api/albums/${albumId}/upload-links`, { maxFiles: 2, maxBytes: 200 }).expect(201)).body;
    expect((await put(link.token, 'big.png', 'Sam', Buffer.alloc(500, 1))).status).toBe(413);
    await put(link.token, 'a.png', 'Sam', png(2)).expect(202);
    await put(link.token, 'b.png', 'Sam', png(3)).expect(202);
    const full = await put(link.token, 'c.png', 'Sam', png(4));
    expect(full.status).toBe(409);
    const later = (await ann.post(`/api/albums/${albumId}/upload-links`, { maxFiles: 2 }).expect(201)).body;
    await h.s.db('album_upload_links').where({ id: later.id }).update({ expires_at: Date.now() - 1 });
    expect((await put(later.token, 'd.png', 'Sam', png(5))).status).toBe(404);
    const third = (await ann.post(`/api/albums/${albumId}/upload-links`, { maxFiles: 2 }).expect(201)).body;
    await ann.del(`/api/albums/${albumId}/upload-links/${third.id}`).expect(204);
    expect((await put(third.token, 'e.png', 'Sam', png(6))).status).toBe(404);
    expect((await ann.get(`/api/albums/${albumId}/upload-links`).expect(200)).body.map((x: { state: string }) => x.state).sort()).toEqual(['expired', 'full', 'revoked']);
  });

  it('records each upload with the spam and flood signals, per link and per address range', async () => {
    const admin = await person(h, 'boss', ['tenant-admin']);
    await h.s.spam.savePolicy(admin.p, { enabled: true, surfaces: { post: { account: 1, ip: 1, tenant: 1000, windowSeconds: 600 } } });
    const link = (await ann.post(`/api/albums/${albumId}/upload-links`, { maxFiles: 5 }).expect(201)).body;
    await put(link.token, 'a.png', 'Sam', png(7)).expect(202);
    await put(link.token, 'b.png', 'Sam', png(8)).expect(202);
    await h.s.spam.settle();
    const row = await h.s.db('spam_scores').where({ tenant_id: h.tenantId, account: `album-upload:${link.id}` }).first();
    expect(row).toBeTruthy();
    const reasons = (JSON.parse(row.reasons) as { signal: string }[]).map((r) => r.signal).sort();
    expect(reasons).toEqual(['rate.post.account', 'rate.post.ip']);
  });

  it('refuses links where uploads could not land: outside the album\'s workspace or above its ceiling', async () => {
    const bob = await member(h, 'bob', [ws], { clearance: 'confidential' });
    await ann.put(`/api/albums/${albumId}/contributors/${bob.user.id}`, { role: 'contributor' }).expect(200);
    expect((await bob.post(`/api/albums/${albumId}/upload-links`, { maxFiles: 1 })).status).toBe(403);
    const low = (await h.s.tenants.createWorkspace(h.tenantId, 'Low', 'internal')).id;
    await h.s.tenants.addMember(low, ann.user.id);
    const personal = (await ann.post('/api/albums', { kind: 'personal', title: 'Mine', workspaceId: low, label: 'confidential' })).status;
    expect(personal).toBe(201);
    const pid = (await ann.get('/api/albums?kind=personal').expect(200)).body.albums[0].id;
    const r = await ann.post(`/api/albums/${pid}/upload-links`, { maxFiles: 1 });
    expect(r.status).toBe(403);
    expect(r.body.step).toBe('zone');
  });
});
