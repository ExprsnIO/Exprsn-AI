import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crc32 } from 'node:zlib';
import { zipEntries as centralDirectory } from '../src/imports/zip.js';
import { zipEntries } from '../src/knowledge/extract.js';
import type { Harness } from './helpers.js';
import { albumHarness, audits, binary, member, png } from './album-helpers.js';

/*
 * 1.9.0, Sprint 53 (B-177): albums on Files: create, order and cover; the three kinds; contributor roles; labels and
 * clearance hiding items; the access rule never widening who reads a file; the streamed zip; the audit entries.
 */

describe('B-177: albums on Files', () => {
  let h: Harness;
  let ws: string;
  let other: string;

  beforeEach(async () => {
    h = await albumHarness();
    ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Design', 'confidential')).id;
    other = (await h.s.tenants.createWorkspace(h.tenantId, 'Elsewhere', 'confidential')).id;
  });
  afterEach(async () => {
    await h.close();
  });

  it('creates an album, adds files in order, reorders them and sets a cover; audits each change', async () => {
    const ann = await member(h, 'ann', [ws]);
    const a = await ann.upload('a.png', png(1));
    const b = await ann.upload('b.png', png(2));
    const c = await ann.upload('c.png', png(3));
    expect(a.state).toBe('ready');
    const album = (await ann.post('/api/albums', { kind: 'workspace', title: 'Offsite 2026', description: 'Pictures from the day', workspaceId: ws }).expect(201)).body;
    expect(album).toMatchObject({ kind: 'workspace', title: 'Offsite 2026', role: 'owner', label: 'internal', itemCount: 0 });
    const added = (await ann.post(`/api/albums/${album.id}/items`, { fileIds: [a.id, b.id, c.id] }).expect(201)).body;
    expect(added.added).toBe(3);
    expect(added.album.items.map((i: { name: string }) => i.name)).toEqual(['a.png', 'b.png', 'c.png']);
    // adding the same file again is not a second item
    expect((await ann.post(`/api/albums/${album.id}/items`, { fileIds: [a.id] }).expect(201)).body).toMatchObject({ added: 0, alreadyIn: 1 });
    const ids = added.album.items.map((i: { id: string }) => i.id);
    const re = (await ann.put(`/api/albums/${album.id}/order`, { itemIds: [ids[2], ids[0], ids[1]] }).expect(200)).body;
    expect(re.items.map((i: { name: string }) => i.name)).toEqual(['c.png', 'a.png', 'b.png']);
    // the cover is the first item until one is chosen
    expect(re.cover).toMatchObject({ itemId: ids[2], chosen: false });
    const covered = (await ann.patch(`/api/albums/${album.id}`, { coverItemId: ids[1], title: 'Offsite' }).expect(200)).body;
    expect(covered).toMatchObject({ title: 'Offsite', cover: { itemId: ids[1], fileId: b.id, chosen: true } });
    // a non-image cannot be added
    const txt = await ann.upload('notes.txt', Buffer.from('hello'));
    expect((await ann.post(`/api/albums/${album.id}/items`, { fileIds: [txt.id] })).status).toBe(415);
    for (const action of ['album.created', 'album.item.added', 'album.reordered', 'album.updated']) expect((await audits(h, action)).length).toBeGreaterThan(0);
    // removing an item keeps the file
    await ann.del(`/api/albums/${album.id}/items/${ids[0]}`).expect(200);
    expect(await h.s.db('files').where({ id: a.id }).first('id')).toBeTruthy();
    expect((await audits(h, 'album.item.removed')).length).toBe(1);
    // deleting the album keeps its files; it is gone for everyone
    await ann.del(`/api/albums/${album.id}`).expect(204);
    await ann.get(`/api/albums/${album.id}`).expect(404);
    expect(await h.s.db('files').where({ id: b.id }).first('id')).toBeTruthy();
    expect((await audits(h, 'album.deleted')).length).toBe(1);
  });

  it('kinds: a workspace album is seen by the workspace, a personal one by the people it names, a group one by the group', async () => {
    const ann = await member(h, 'ann', [ws]);
    const bob = await member(h, 'bob', [ws]);
    const eve = await member(h, 'eve', [other]);
    const pic = await ann.upload('team.png', png(4));
    const wsAlbum = (await ann.post('/api/albums', { kind: 'workspace', title: 'Team', workspaceId: ws }).expect(201)).body;
    await ann.post(`/api/albums/${wsAlbum.id}/items`, { fileIds: [pic.id] }).expect(201);
    expect((await bob.get(`/api/albums/${wsAlbum.id}`).expect(200)).body).toMatchObject({ role: 'viewer', itemCount: 1 });
    await eve.get(`/api/albums/${wsAlbum.id}`).expect(404);
    expect((await eve.get('/api/albums').expect(200)).body.albums.map((x: { id: string }) => x.id)).not.toContain(wsAlbum.id);

    const personal = (await ann.post('/api/albums', { kind: 'personal', title: 'Mine', workspaceId: ws }).expect(201)).body;
    await bob.get(`/api/albums/${personal.id}`).expect(404);
    await ann.put(`/api/albums/${personal.id}/contributors/${eve.user.id}`, { role: 'viewer' }).expect(200);
    expect((await eve.get(`/api/albums/${personal.id}`).expect(200)).body.role).toBe('viewer');

    // a group album: the group's members (and its moderators as editors)
    const g = (await ann.post('/api/groups', { workspaceId: ws, name: 'Photographers', visibility: 'public', joinMode: 'open' }).expect(201)).body;
    const cara = await member(h, 'cara', [ws]);
    const gAlbum = (await ann.post('/api/albums', { kind: 'group', title: 'Walks', groupId: g.id }).expect(201)).body;
    expect(gAlbum).toMatchObject({ kind: 'group', groupId: g.id, workspaceId: ws });
    await cara.get(`/api/albums/${gAlbum.id}`).expect(404);
    await cara.post(`/api/groups/${g.id}/join`, {}).expect((r) => expect([200, 201]).toContain(r.status));
    expect((await cara.get(`/api/albums/${gAlbum.id}`).expect(200)).body.role).toBe('viewer');
    // a group album needs its group; a role in it is held by members only
    expect((await ann.post('/api/albums', { kind: 'group', title: 'x' })).status).toBe(400);
    expect((await ann.put(`/api/albums/${gAlbum.id}/contributors/${eve.user.id}`, { role: 'contributor' })).status).toBe(422);
  });

  it('contributor roles: viewers view, contributors add and remove their own, editors order and remove any; owners and editors manage', async () => {
    const ann = await member(h, 'ann', [ws]);
    const bob = await member(h, 'bob', [ws]);
    const cara = await member(h, 'cara', [ws]);
    const dan = await member(h, 'dan', [ws]);
    const zoe = await member(h, 'zoe', [other]);
    const album = (await ann.post('/api/albums', { kind: 'workspace', title: 'Roles', workspaceId: ws }).expect(201)).body;
    const annPic = await ann.upload('ann.png', png(5));
    const bobPic = await bob.upload('bob.png', png(6));
    await ann.post(`/api/albums/${album.id}/items`, { fileIds: [annPic.id] }).expect(201);
    // a workspace member without a role views only
    expect((await bob.post(`/api/albums/${album.id}/items`, { fileIds: [bobPic.id] })).status).toBe(403);
    await ann.put(`/api/albums/${album.id}/contributors/${bob.user.id}`, { role: 'contributor' }).expect(200);
    const after = (await bob.post(`/api/albums/${album.id}/items`, { fileIds: [bobPic.id] }).expect(201)).body.album;
    const annItem = after.items.find((i: { name: string }) => i.name === 'ann.png');
    const bobItem = after.items.find((i: { name: string }) => i.name === 'bob.png');
    expect(bobItem.mine).toBe(true);
    // a contributor cannot remove another's item, order, or edit details
    expect((await bob.del(`/api/albums/${album.id}/items/${annItem.id}`)).status).toBe(403);
    expect((await bob.put(`/api/albums/${album.id}/order`, { itemIds: [bobItem.id, annItem.id] })).status).toBe(403);
    expect((await bob.patch(`/api/albums/${album.id}`, { title: 'Mine now' })).status).toBe(403);
    // a contributor cannot add a file they could not share (outside their workspaces: 404, as the file store says)
    const zoePic = await zoe.upload('zoe.png', png(7));
    expect((await bob.post(`/api/albums/${album.id}/items`, { fileIds: [zoePic.id] })).status).toBe(404);
    await bob.del(`/api/albums/${album.id}/items/${bobItem.id}`).expect(200);
    // an editor orders, removes any, edits; manages viewers and contributors but not editors
    await ann.put(`/api/albums/${album.id}/contributors/${cara.user.id}`, { role: 'editor' }).expect(200);
    await cara.patch(`/api/albums/${album.id}`, { description: 'Edited by Cara' }).expect(200);
    await cara.put(`/api/albums/${album.id}/contributors/${dan.user.id}`, { role: 'contributor' }).expect(200);
    expect((await cara.put(`/api/albums/${album.id}/contributors/${dan.user.id}`, { role: 'editor' })).status).toBe(403);
    expect((await bob.put(`/api/albums/${album.id}/contributors/${dan.user.id}`, { role: 'viewer' })).status).toBe(403);
    await cara.del(`/api/albums/${album.id}/items/${annItem.id}`).expect(200);
    // only the owner deletes
    expect((await cara.del(`/api/albums/${album.id}`)).status).toBe(403);
    const list = (await ann.get(`/api/albums/${album.id}`).expect(200)).body.contributors;
    expect(list.map((c: { name: string; role: string }) => `${c.name}:${c.role}`).sort()).toEqual(['BOB:contributor', 'CARA:editor', 'DAN:contributor']);
    expect((await audits(h, 'album.contributor.set')).length).toBe(3);
  });

  it('labels: the album is at least its highest item; an item above a viewer\'s clearance is never shown or counted', async () => {
    const ann = await member(h, 'ann', [ws], { clearance: 'confidential' });
    const bob = await member(h, 'bob', [ws], { clearance: 'internal' });
    const open = await ann.upload('open.png', png(8), { label: 'internal' });
    const secret = await ann.upload('secret.png', png(9), { label: 'confidential' });
    const album = (await ann.post('/api/albums', { kind: 'workspace', title: 'Mixed', workspaceId: ws, label: 'internal' }).expect(201)).body;
    await ann.post(`/api/albums/${album.id}/items`, { fileIds: [open.id, secret.id] }).expect(201);
    const mine = (await ann.get(`/api/albums/${album.id}`).expect(200)).body;
    expect(mine).toMatchObject({ label: 'confidential', floorLabel: 'internal', itemCount: 2 });
    expect((await h.s.db('albums').where({ id: album.id }).first()).effective_label).toBe('confidential');
    const theirs = (await bob.get(`/api/albums/${album.id}`).expect(200)).body;
    expect(theirs.itemCount).toBe(1);
    expect(theirs.label).toBe('internal');
    expect(JSON.stringify(theirs)).not.toContain('secret.png');
    const hidden = mine.items.find((i: { name: string }) => i.name === 'secret.png');
    await bob.get(`/api/albums/${album.id}/items/${hidden.id}/content`).expect(404);
    expect(((await bob.get('/api/albums').expect(200)).body.albums.find((x: { id: string }) => x.id === album.id)).itemCount).toBe(1);
    // the floor is the gate for the album itself
    const conf = (await ann.post('/api/albums', { kind: 'workspace', title: 'Board', workspaceId: ws, label: 'confidential' }).expect(201)).body;
    expect((await bob.get(`/api/albums/${conf.id}`)).status).toBe(403);
    // a floor above the caller's clearance or the ceiling is refused
    expect((await bob.post('/api/albums', { kind: 'workspace', title: 'Up', workspaceId: ws, label: 'confidential' })).status).toBe(403);
    // removing the confidential item lowers the album's label
    await ann.del(`/api/albums/${album.id}/items/${hidden.id}`).expect(200);
    expect((await h.s.db('albums').where({ id: album.id }).first()).effective_label).toBe('internal');
  });

  it('access never widens: an item goes only to people the adder could share it with, and stops when the adder loses the file', async () => {
    const ann = await member(h, 'ann', [ws, other], { clearance: 'confidential' });
    const bob = await member(h, 'bob', [ws]);
    const eve = await member(h, 'eve', [other]);
    // ann's picture in Design, added to a personal album naming eve (outside Design): like a share with eve
    const pic = await ann.upload('design.png', png(10));
    const album = (await ann.post('/api/albums', { kind: 'personal', title: 'For Eve', workspaceId: other }).expect(201)).body;
    await ann.post(`/api/albums/${album.id}/items`, { fileIds: [pic.id] }).expect(201);
    await ann.put(`/api/albums/${album.id}/contributors/${eve.user.id}`, { role: 'viewer' }).expect(200);
    const seen = (await eve.get(`/api/albums/${album.id}`).expect(200)).body;
    expect(seen.items).toHaveLength(1);
    // eve reads it through the album, not the file store
    await eve.get(`/api/files/${pic.id}`).expect(404);
    const bytes = await eve.get(`/api/albums/${album.id}/items/${seen.items[0].id}/content`).buffer(true).parse(binary).expect(200);
    expect(bytes.body.subarray(0, 4).toString('latin1')).toBe('\x89PNG');
    // bob is not in the album's audience at all
    await bob.get(`/api/albums/${album.id}`).expect(404);
    // the grant ends when the adder loses the file (leaves its workspace)
    await h.s.db('workspace_members').where({ workspace_id: ws, user_id: ann.user.id }).delete();
    expect((await eve.get(`/api/albums/${album.id}`).expect(200)).body.items).toHaveLength(0);
    // a file in the trash is never shown
    await h.s.tenants.addMember(ws, ann.user.id);
    expect((await eve.get(`/api/albums/${album.id}`).expect(200)).body.items).toHaveLength(1);
    await ann.del(`/api/files/${pic.id}`).expect(200);
    expect((await eve.get(`/api/albums/${album.id}`).expect(200)).body.items).toHaveLength(0);
    // a label above the audience's ceiling is refused when added
    const low = (await h.s.tenants.createWorkspace(h.tenantId, 'Low', 'internal')).id;
    await h.s.tenants.addMember(low, ann.user.id);
    const conf = await ann.upload('conf.png', png(11), { label: 'confidential' });
    const lowAlbum = (await ann.post('/api/albums', { kind: 'workspace', title: 'Low', workspaceId: low }).expect(201)).body;
    const r = await ann.post(`/api/albums/${lowAlbum.id}/items`, { fileIds: [conf.id] });
    expect(r.status).toBe(403);
    expect(r.body.step).toBe('zone');
  });

  it('downloads what the reader sees as a zip, streamed, with the images cleaned; audited', async () => {
    const ann = await member(h, 'ann', [ws], { clearance: 'confidential' });
    const bob = await member(h, 'bob', [ws]);
    const a = await ann.upload('same.png', png(12));
    const b = await ann.upload('same (2).png', png(13));
    const secret = await ann.upload('secret.png', png(14), { label: 'confidential' });
    const album = (await ann.post('/api/albums', { kind: 'workspace', title: 'Zip me', workspaceId: ws }).expect(201)).body;
    await ann.post(`/api/albums/${album.id}/items`, { fileIds: [a.id, b.id, secret.id] }).expect(201);
    const res = await bob.get(`/api/albums/${album.id}/download`).buffer(true).parse(binary).expect(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-length']).toBeUndefined();
    expect(res.headers['content-disposition']).toContain('attachment');
    const entries = zipEntries(res.body as Buffer);
    expect([...entries.keys()].sort()).toEqual(['same (2).png', 'same.png']);
    expect(entries.get('same.png')!().subarray(0, 4).toString('latin1')).toBe('\x89PNG');
    // the central directory (written after the streamed members) carries each member's CRC and size
    for (const e of centralDirectory(res.body as Buffer)) {
      const data = entries.get(e.name)!();
      expect(e).toMatchObject({ method: 0, size: data.length });
      expect(e.crc >>> 0).toBe(crc32(data) >>> 0);
    }
    const audit = (await audits(h, 'album.downloaded'))[0]!;
    expect(JSON.parse(audit.detail!)).toMatchObject({ count: 2 });
  });

  it('reports albums as unavailable while the migrations are missing, and changes nothing', async () => {
    const ann = await member(h, 'ann', [ws]);
    await h.s.db.schema.dropTable('album_contributors');
    h.s.files.albums.resetSchemaCache();
    expect((await ann.get('/api/albums').expect(200)).body).toEqual({ available: false, albums: [] });
    const r = await ann.post('/api/albums', { kind: 'workspace', title: 'x', workspaceId: ws });
    expect(r.status).toBe(503);
    expect(r.body.migration).toBe('135_albums');
  });
});
