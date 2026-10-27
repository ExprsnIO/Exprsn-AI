import type { Test } from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kindOf } from '../src/platform/notification-kinds.js';
import type { Harness } from './helpers.js';
import { albumHarness, audits, member, png } from './album-helpers.js';

/*
 * 1.9.0, Sprint 53 (B-179): an album posted to the feed (a card that opens it, within labels and the feed's own
 * visibility), the Albums tab of a group page, and one batched `album` notification to the people in an album when
 * items are added.
 */

describe('B-179: albums in the feed and groups', () => {
  let h: Harness;
  let ws: string;
  let other: string;

  beforeEach(async () => {
    h = await albumHarness();
    ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Studio', 'confidential')).id;
    other = (await h.s.tenants.createWorkspace(h.tenantId, 'Elsewhere', 'internal')).id;
  });
  afterEach(async () => {
    await h.close();
  });

  const feedIds = async (m: { get(p: string): Test }) => ((await m.get(`/api/feed/workspaces/${ws}`).expect(200)).body.items as { id: string }[]).map((x) => x.id);

  it('posts an album as a card labelled at least as high as the album; readers see the card and open it within their clearance', async () => {
    const ann = await member(h, 'ann', [ws], { clearance: 'confidential' });
    const bob = await member(h, 'bob', [ws], { clearance: 'internal' });
    const eve = await member(h, 'eve', [other]);
    const open = await ann.upload('open.png', png(1));
    const secret = await ann.upload('secret.png', png(2), { label: 'confidential' });
    const album = (await ann.post('/api/albums', { kind: 'workspace', title: 'Launch', workspaceId: ws }).expect(201)).body;
    await ann.post(`/api/albums/${album.id}/items`, { fileIds: [open.id] }).expect(201);
    const post = (await ann.post(`/api/albums/${album.id}/post`, { body: 'Pictures from the launch' }).expect(201)).body;
    expect(post).toMatchObject({ label: 'internal', source: { kind: 'album', id: album.id }, workspaceId: ws });
    expect(await feedIds(bob)).toContain(post.id);
    const card = (await bob.get(`/api/albums/${album.id}/card`).expect(200)).body;
    expect(card).toMatchObject({ title: 'Launch', itemCount: 1, label: 'internal' });
    await eve.get(`/api/albums/${album.id}/card`).expect(404);
    expect((await audits(h, 'album.posted')).length).toBe(1);

    // once a confidential item is in, a new post is confidential: bob does not see it; the old card hides the item
    await ann.post(`/api/albums/${album.id}/items`, { fileIds: [secret.id] }).expect(201);
    const high = (await ann.post(`/api/albums/${album.id}/post`, {}).expect(201)).body;
    expect(high.label).toBe('confidential');
    const seen = await feedIds(bob);
    expect(seen).toContain(post.id);
    expect(seen).not.toContain(high.id);
    expect((await bob.get(`/api/albums/${album.id}/card`).expect(200)).body.itemCount).toBe(1);
    expect((await ann.get(`/api/albums/${album.id}/card`).expect(200)).body.itemCount).toBe(2);

    // public visibility needs a public album; a personal album is not posted
    expect((await ann.post(`/api/albums/${album.id}/post`, { visibility: 'public' })).status).toBe(403);
    const mine = (await ann.post('/api/albums', { kind: 'personal', title: 'Mine', workspaceId: ws }).expect(201)).body;
    expect((await ann.post(`/api/albums/${mine.id}/post`, {})).status).toBe(409);
    // a viewer does not post the album
    expect((await bob.post(`/api/albums/${album.id}/post`, {})).status).toBe(403);
  });

  it('a group album posts to the group feed; the Albums tab lists the group\'s albums for its members', async () => {
    const ann = await member(h, 'ann', [ws]);
    const bob = await member(h, 'bob', [ws]);
    const g = (await ann.post('/api/groups', { workspaceId: ws, name: 'Runners', visibility: 'private', joinMode: 'request' }).expect(201)).body;
    const album = (await ann.post('/api/albums', { kind: 'group', title: 'Race day', groupId: g.id }).expect(201)).body;
    await ann.post('/api/albums', { kind: 'workspace', title: 'Not the group', workspaceId: ws }).expect(201);
    const tab = (await ann.get(`/api/groups/${g.id}/albums`).expect(200)).body;
    expect(tab).toMatchObject({ available: true, canCreate: true });
    expect(tab.albums.map((a: { title: string }) => a.title)).toEqual(['Race day']);
    expect([403, 404]).toContain((await bob.get(`/api/groups/${g.id}/albums`)).status);
    const pic = await ann.upload('race.png', png(3));
    await ann.post(`/api/albums/${album.id}/items`, { fileIds: [pic.id] }).expect(201);
    const post = (await ann.post(`/api/albums/${album.id}/post`, {}).expect(201)).body;
    expect(post).toMatchObject({ groupId: g.id, source: { kind: 'album', id: album.id } });
  });

  it('tells the people in an album once per window, counting only what each may see, never the adder; preferences decide', async () => {
    h.s.files.albums.notifyWindowMs = 60_000;
    expect(kindOf('album').id).toBe('album');
    const ann = await member(h, 'ann', [ws], { clearance: 'confidential' });
    const bob = await member(h, 'bob', [ws], { clearance: 'internal' });
    const cara = await member(h, 'cara', [ws], { clearance: 'confidential' });
    const dan = await member(h, 'dan', [ws], { clearance: 'confidential' });
    const album = (await ann.post('/api/albums', { kind: 'workspace', title: 'Holiday', workspaceId: ws }).expect(201)).body;
    for (const [m, role] of [[bob, 'contributor'], [cara, 'viewer'], [dan, 'viewer']] as const) await ann.put(`/api/albums/${album.id}/contributors/${m.user.id}`, { role }).expect(200);
    // dan turns album notices off in the console
    await dan.put('/api/me/notification-preferences', { kinds: { album: { in_app: { enabled: false, timing: 'instant' } } } }).expect(200);
    const a = await ann.upload('a.png', png(4));
    const b = await ann.upload('b.png', png(5));
    const c = await ann.upload('c.png', png(6), { label: 'confidential' });
    await ann.post(`/api/albums/${album.id}/items`, { fileIds: [a.id, b.id] }).expect(201);
    await ann.post(`/api/albums/${album.id}/items`, { fileIds: [c.id] }).expect(201);
    const jobs = await h.s.db('jobs').where({ type: 'album.notify' });
    expect(jobs).toHaveLength(1);
    // due at the end of the window; brought forward here
    expect(Number(jobs[0].run_at)).toBeGreaterThan(Date.now());
    await h.s.db('jobs').where({ id: jobs[0].id }).update({ run_at: Date.now() });
    expect(await h.s.jobs.runNow(jobs[0].id)).toBe(true);
    const notes = async (userId: string) => (await h.s.db('notifications').where({ user_id: userId, kind: 'album' })) as { title: string; route: string; label: string }[];
    expect(await notes(ann.user.id)).toHaveLength(0);
    const forBob = await notes(bob.user.id);
    expect(forBob.map((n) => n.title)).toEqual(['2 items added to Holiday']);
    expect(forBob[0]).toMatchObject({ route: `albums?album=${album.id}`, label: 'internal' });
    expect((await notes(cara.user.id)).map((n) => `${n.title}:${n.label}`)).toEqual(['3 items added to Holiday:confidential']);
    expect(await notes(dan.user.id)).toHaveLength(0);
    // nothing new: the next run tells nobody; a new item from bob tells ann and cara, not bob
    await h.s.files.albums.notifyBatch(h.tenantId, album.id);
    expect(await notes(cara.user.id)).toHaveLength(1);
    const d = await bob.upload('d.png', png(7));
    await bob.post(`/api/albums/${album.id}/items`, { fileIds: [d.id] }).expect(201);
    await h.s.files.albums.notifyBatch(h.tenantId, album.id);
    expect((await notes(ann.user.id)).map((n) => n.title)).toEqual(['1 item added to Holiday']);
    expect(await notes(bob.user.id)).toHaveLength(1);
    expect(await notes(cara.user.id)).toHaveLength(2);
  });
});
