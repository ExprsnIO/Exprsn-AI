import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness, localUser, login, type Harness } from './helpers.js';

describe('chat conversation folders', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
  });
  afterEach(async () => {
    await h.close();
  });

  async function user(name: string) {
    const u = await localUser(h, name, ['member'], 'internal');
    const c = await login(h, name);
    const csrf = (r: ReturnType<typeof c.agent.post>) => r.set('x-csrf-token', c.csrf);
    return {
      ...u,
      ...c,
      post: (p: string, b: object = {}) => csrf(c.agent.post(p)).send(b),
      patch: (p: string, b: object = {}) => c.agent.patch(p).set('x-csrf-token', c.csrf).send(b),
      put: (p: string, b: object = {}) => c.agent.put(p).set('x-csrf-token', c.csrf).send(b),
      del: (p: string) => c.agent.delete(p).set('x-csrf-token', c.csrf)
    };
  }

  it('creates, nests (at most three deep), renames, moves, files into and deletes folders, audited', async () => {
    const me = await user('me');
    const other = await user('other');
    const a = (await me.post('/api/chat/folders', { name: 'Work' }).expect(201)).body;
    expect(a).toMatchObject({ name: 'Work', parentId: null, position: 0, depth: 1, conversations: 0 });
    const b = (await me.post('/api/chat/folders', { name: 'Home' }).expect(201)).body;
    expect(b.position).toBe(1);
    const a1 = (await me.post('/api/chat/folders', { name: 'Clients', parentId: a.id }).expect(201)).body;
    const a2 = (await me.post('/api/chat/folders', { name: 'Acme', parentId: a1.id }).expect(201)).body;
    expect(a2.depth).toBe(3);
    await me.post('/api/chat/folders', { name: 'Too deep', parentId: a2.id }).expect(400);
    await me.post('/api/chat/folders', { name: '' }).expect(400);
    await me.post('/api/chat/folders', { name: 'x', parentId: 'nope' }).expect(400);

    // The name is sealed at rest.
    const stored = await h.s.db('chat_folders').where({ id: a.id }).first();
    expect(stored.name).not.toContain('Work');

    // Others see none of it and cannot touch it.
    expect((await other.agent.get('/api/chat/folders').expect(200)).body).toEqual([]);
    await other.patch(`/api/chat/folders/${a.id}`, { name: 'Mine' }).expect(404);
    await other.del(`/api/chat/folders/${a.id}`).expect(404);

    expect((await me.patch(`/api/chat/folders/${b.id}`, { name: 'Personal' }).expect(200)).body).toMatchObject({ name: 'Personal' });

    // Moving: not into itself or below itself, and not past the depth limit with what is inside.
    await me.post(`/api/chat/folders/${a.id}/move`, { parentId: a2.id }).expect(400);
    await me.post(`/api/chat/folders/${a1.id}/move`, { parentId: b.id }).expect(200);
    const b1 = (await me.post('/api/chat/folders', { name: 'Holidays', parentId: b.id }).expect(201)).body;
    await me.post(`/api/chat/folders/${a1.id}/move`, { parentId: b1.id }).expect(400); // a1 has a2 inside: 2 + 2 > 3
    // Reorder at the top level: Personal first.
    await me.post(`/api/chat/folders/${b.id}/move`, { position: 0 }).expect(200);
    let list = (await me.agent.get('/api/chat/folders').expect(200)).body as { id: string; name: string; parentId: string | null; position: number; depth: number }[];
    const top = list.filter((f) => !f.parentId).sort((x, y) => x.position - y.position).map((f) => f.name);
    expect(top).toEqual(['Personal', 'Work']);
    expect(list.find((f) => f.id === a2.id)).toMatchObject({ depth: 3 });

    // Filing a conversation, listing by folder, and others' conversations or folders refused.
    const c1 = (await me.post('/api/conversations', { title: 'Q3 review' }).expect(201)).body;
    const c2 = (await me.post('/api/conversations', { title: 'Loose' }).expect(201)).body;
    const theirs = (await other.post('/api/conversations', { title: 'Theirs' }).expect(201)).body;
    await me.put(`/api/conversations/${c1.id}/folder`, { folderId: a2.id }).expect(200);
    await me.put(`/api/conversations/${theirs.id}/folder`, { folderId: a2.id }).expect(404);
    await other.put(`/api/conversations/${theirs.id}/folder`, { folderId: a2.id }).expect(404);
    const inA2 = (await me.agent.get(`/api/conversations?folder=${a2.id}`).expect(200)).body;
    expect(inA2.map((c: { id: string; folderId: string }) => [c.id, c.folderId])).toEqual([[c1.id, a2.id]]);
    expect((await me.agent.get('/api/conversations?folder=none').expect(200)).body.map((c: { id: string }) => c.id)).toEqual([c2.id]);
    expect((await me.agent.get('/api/conversations').expect(200)).body).toHaveLength(2);
    list = (await me.agent.get('/api/chat/folders').expect(200)).body;
    expect(list.find((f) => f.id === a2.id)).toMatchObject({ conversations: 1 });

    // Folders belong to a workspace: one from elsewhere is not found.
    const ws = await h.s.tenants.createWorkspace(h.tenantId, 'Elsewhere', 'internal');
    await h.s.db('chat_folders').where({ id: b1.id }).update({ workspace_id: ws.id });
    await me.put(`/api/conversations/${c2.id}/folder`, { folderId: b1.id }).expect(404);

    // Deleting a folder deletes those inside it and moves their conversations back to no folder.
    const gone = (await me.del(`/api/chat/folders/${b.id}`).expect(200)).body;
    expect(gone).toEqual({ folders: 3, conversations: 1 });
    expect((await h.s.db('conversations').where({ id: c1.id }).first()).folder_id).toBeNull();
    list = (await me.agent.get('/api/chat/folders').expect(200)).body;
    expect(list.map((f) => f.name)).toEqual(['Work']);
    expect(list[0]!.position).toBe(0);

    // Taking a conversation out of its folder.
    await me.put(`/api/conversations/${c2.id}/folder`, { folderId: a.id }).expect(200);
    await me.put(`/api/conversations/${c2.id}/folder`, { folderId: null }).expect(200);
    expect((await h.s.db('conversations').where({ id: c2.id }).first()).folder_id).toBeNull();

    const actions = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).select('action')).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['chat.folder.created', 'chat.folder.renamed', 'chat.folder.moved', 'chat.folder.deleted', 'conversation.filed']));
  });

  it('needs chat permissions', async () => {
    const u = await localUser(h, 'keyed', ['member'], 'internal');
    const key = (await h.s.apiKeys.create({ tenantId: h.tenantId, userId: u.id, name: 'k', scopes: ['models:read'] as never[], ttlDays: 1 })).key;
    await request(h.app).get('/api/chat/folders').set('authorization', `Bearer ${key}`).expect(403);
    await request(h.app).post('/api/chat/folders').set('authorization', `Bearer ${key}`).send({ name: 'x' }).expect(403);
  });
});
