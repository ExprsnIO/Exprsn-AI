import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness, localUser, login, type Harness } from './helpers.js';

/*
 * Messaging folders: each person files the conversations they are in into their own Inbox, Archive and custom
 * folders. Filing is per person, Archive is left when someone else writes, deleting a folder returns its conversations
 * to the Inbox, and nobody files a conversation they are not in.
 */

type Person = Awaited<ReturnType<typeof personIn>>;

async function personIn(h: Harness, name: string, workspaces: string[]) {
  const user = await localUser(h, name, ['member'], 'internal');
  for (const w of workspaces) await h.s.tenants.addMember(w, user.id);
  const c = await login(h, name);
  const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
  return {
    user,
    post: (p: string, b?: object) => send('post', p, b),
    put: (p: string, b?: object) => send('put', p, b),
    patch: (p: string, b?: object) => send('patch', p, b),
    del: (p: string) => send('delete', p),
    get: (p: string) => c.agent.get(p)
  };
}

const C = '/api/messaging/conversations';
const F = '/api/messaging/folders';

interface Folder {
  id: string;
  kind: string;
  name: string;
  parentId: string | null;
  depth: number;
  conversations: number;
  unread: number;
}

describe('messaging folders', () => {
  let h: Harness;
  let ws: string;
  let alice: Person;
  let bob: Person;
  let carol: Person;

  beforeEach(async () => {
    h = await harness();
    ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Design', 'confidential')).id;
    alice = await personIn(h, 'alice', [ws]);
    bob = await personIn(h, 'bob', [ws]);
    carol = await personIn(h, 'carol', [ws]);
  }, 60_000);
  afterEach(async () => {
    await h.close();
  });

  const direct = async (who: Person, other: Person) => (await who.post(C, { kind: 'direct', userId: other.user.id })).body as { id: string };
  const say = async (who: Person, conv: string, body: string) => (await who.post(`${C}/${conv}/messages`, { body }).expect(201)).body as { id: string };
  const folderOf = async (who: Person, conv: string) => ((await who.get(C).expect(200)).body as { id: string; folder: string }[]).find((c) => c.id === conv)?.folder;
  const foldersOf = async (who: Person) => (await who.get(F).expect(200)).body as Folder[];
  const audits = async (action: string) => (await h.s.db('audit_events').where({ action })) as { target: string; detail: string }[];

  it('filing is per person: Alice archiving or filing a conversation does not move it for Bob', async () => {
    const conv = await direct(alice, bob);
    await say(bob, conv.id, 'first');
    expect(await folderOf(alice, conv.id)).toBe('inbox');

    const work = (await alice.post(F, { name: 'Work' }).expect(201)).body as Folder;
    expect(work).toMatchObject({ kind: 'custom', name: 'Work', parentId: null, depth: 1 });
    await alice.put(`${C}/${conv.id}/folder`, { folder: work.id }).expect(200);
    expect(await folderOf(alice, conv.id)).toBe(work.id);
    expect(await folderOf(bob, conv.id)).toBe('inbox');
    // only Alice's filtered list has it
    expect(((await alice.get(`${C}?folder=${work.id}`).expect(200)).body as unknown[]).length).toBe(1);
    expect(((await bob.get(`${C}?folder=inbox`).expect(200)).body as { id: string }[]).map((c) => c.id)).toEqual([conv.id]);

    // counts: Alice's unread message sits in Work, Bob's Inbox has nothing unread from himself
    const af = await foldersOf(alice);
    expect(af.find((f) => f.id === work.id)).toMatchObject({ conversations: 1, unread: 1 });
    expect(af.find((f) => f.id === 'inbox')).toMatchObject({ conversations: 0, unread: 0 });
    const bf = await foldersOf(bob);
    expect(bf.map((f) => f.id)).toEqual(['inbox', 'archive']);
    expect(bf[0]).toMatchObject({ conversations: 1 });

    // Bob cannot see, rename, delete or file into Alice's folder
    await bob.patch(`${F}/${work.id}`, { name: 'Mine' }).expect(404);
    await bob.del(`${F}/${work.id}`).expect(404);
    await bob.put(`${C}/${conv.id}/folder`, { folder: work.id }).expect(404);

    // filing changes no membership and no conversation row
    expect(await h.s.db('dm_members').where({ conversation_id: conv.id }).count({ n: '*' }).then((r) => Number((r as { n: number }[])[0]!.n))).toBe(2);
    const filed = await audits('messaging.conversation.filed');
    expect(filed).toHaveLength(1);
    expect(JSON.parse(filed[0]!.detail)).toEqual({ folder: 'custom', folderId: work.id });
  });

  it('archive hides a conversation from the Inbox, and a message from someone else brings it back', async () => {
    const conv = await direct(alice, bob);
    await say(bob, conv.id, 'hello');
    await alice.put(`${C}/${conv.id}/folder`, { folder: 'archive' }).expect(200);
    expect(await folderOf(alice, conv.id)).toBe('archive');
    expect(((await alice.get(`${C}?folder=inbox`).expect(200)).body as unknown[]).length).toBe(0);
    expect((await foldersOf(alice)).find((f) => f.id === 'archive')).toMatchObject({ conversations: 1, unread: 1 });

    // Alice's own message keeps it archived
    await new Promise((r) => setTimeout(r, 5));
    await say(alice, conv.id, 'noted');
    expect(await folderOf(alice, conv.id)).toBe('archive');

    // Bob writes: back in Alice's Inbox
    await new Promise((r) => setTimeout(r, 5));
    await say(bob, conv.id, 'one more thing');
    expect(await folderOf(alice, conv.id)).toBe('inbox');
    // archiving again holds until the next message from someone else
    await new Promise((r) => setTimeout(r, 5));
    await alice.put(`${C}/${conv.id}/folder`, { folder: 'archive' }).expect(200);
    expect(await folderOf(alice, conv.id)).toBe('archive');
    // and back to the Inbox by hand
    await alice.put(`${C}/${conv.id}/folder`, { folder: 'inbox' }).expect(200);
    expect(await folderOf(alice, conv.id)).toBe('inbox');
    expect(await h.s.db('dm_filings').where({ conversation_id: conv.id }).count({ n: '*' }).then((r) => Number((r as { n: number }[])[0]!.n))).toBe(0);
  });

  it('deleting a folder deletes its subfolders and returns their conversations to the Inbox', async () => {
    const one = await direct(alice, bob);
    const two = (await alice.post(C, { kind: 'group', workspaceId: ws, title: 'Crit', memberIds: [bob.user.id, carol.user.id] }).expect(201)).body as { id: string };
    const top = (await alice.post(F, { name: 'Projects' }).expect(201)).body as Folder;
    const sub = (await alice.post(F, { name: 'Crit', parentId: top.id }).expect(201)).body as Folder;
    expect(sub.depth).toBe(2);
    // two levels at most, unique names per level, the built-in names are taken
    await alice.post(F, { name: 'Deeper', parentId: sub.id }).expect(422);
    await alice.post(F, { name: 'projects' }).expect(409);
    await alice.post(F, { name: 'Archive' }).expect(409);
    await alice.post(F, { name: 'Crit' }).expect(201);

    await alice.put(`${C}/${one.id}/folder`, { folder: top.id }).expect(200);
    await alice.put(`${C}/${two.id}/folder`, { folder: sub.id }).expect(200);
    // rename and reorder
    expect((await alice.patch(`${F}/${top.id}`, { name: 'Clients' }).expect(200)).body).toMatchObject({ name: 'Clients' });
    const tops = (await foldersOf(alice)).filter((f) => f.kind === 'custom' && !f.parentId);
    const order = tops.map((f) => f.id).reverse();
    const after = (await alice.put(`${F}/order`, { parentId: null, ids: order }).expect(200)).body as Folder[];
    expect(after.filter((f) => f.kind === 'custom' && !f.parentId).map((f) => f.id)).toEqual(order);
    await alice.put(`${F}/order`, { parentId: null, ids: [order[0]] }).expect(422);

    const out = (await alice.del(`${F}/${top.id}`).expect(200)).body;
    expect(out).toMatchObject({ deleted: true, folders: 2, returned: 2 });
    expect(await folderOf(alice, one.id)).toBe('inbox');
    expect(await folderOf(alice, two.id)).toBe('inbox');
    expect((await foldersOf(alice)).some((f) => f.id === sub.id)).toBe(false);
    expect(await audits('messaging.folder.deleted')).toHaveLength(1);
    expect(await audits('messaging.folder.created')).toHaveLength(3);
    expect(await audits('messaging.folder.updated')).toHaveLength(1);
    expect(await audits('messaging.folder.reordered')).toHaveLength(1);
    // the stored name is sealed
    expect(JSON.stringify(await h.s.db('dm_folders').select('name'))).not.toContain('Crit');
  });

  it('a person who is not a member cannot file the conversation', async () => {
    const conv = await direct(alice, bob);
    await carol.put(`${C}/${conv.id}/folder`, { folder: 'archive' }).expect(404);
    const mine = (await carol.post(F, { name: 'Snoop' }).expect(201)).body as Folder;
    await carol.put(`${C}/${conv.id}/folder`, { folder: mine.id }).expect(404);
    expect(await h.s.db('dm_filings').count({ n: '*' }).then((r) => Number((r as { n: number }[])[0]!.n))).toBe(0);
    // an unknown folder and a malformed one are refused for a member too
    await alice.put(`${C}/${conv.id}/folder`, { folder: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }).expect(404);
    await alice.put(`${C}/${conv.id}/folder`, { folder: 'spam' }).expect(400);
  });
});

describe('messaging folders: permissions (2026-10-15)', () => {
  let h: Harness;
  beforeEach(async () => { h = await harness(); });
  afterEach(async () => { await h.close(); });

  it('lists with messages:read, but changes need messages:write: a read-only key cannot rearrange the inbox', async () => {
    const user = await localUser(h, 'reader', ['member'], 'internal');
    const ro = (await h.s.apiKeys.create({ tenantId: h.tenantId, userId: user.id, name: 'read only', scopes: ['messages:read'], ttlDays: 30 })).key;
    const rw = (await h.s.apiKeys.create({ tenantId: h.tenantId, userId: user.id, name: 'read write', scopes: ['messages:read', 'messages:write'], ttlDays: 30 })).key;
    const as = (k: string) => (t: request.Test) => t.set('authorization', `Bearer ${k}`);
    await as(ro)(request(h.app).get(F)).expect(200);
    await as(ro)(request(h.app).post(F).send({ name: 'Projects' })).expect(403);
    await as(ro)(request(h.app).put(`${F}/order`).send({ parentId: null, ids: [] })).expect(403);
    const made = (await as(rw)(request(h.app).post(F).send({ name: 'Projects' })).expect(201)).body as { id: string };
    await as(ro)(request(h.app).patch(`${F}/${made.id}`).send({ name: 'Renamed' })).expect(403);
    await as(ro)(request(h.app).delete(`${F}/${made.id}`)).expect(403);
    await as(ro)(request(h.app).put(`${C}/01ARZ3NDEKTSV4RRFFQ69G5FAV/folder`).send({ folder: 'archive' })).expect(403);
    await as(rw)(request(h.app).delete(`${F}/${made.id}`)).expect(200);
  });
});
