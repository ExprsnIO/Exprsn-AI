import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';
import { FakeOllama } from './fake-ollama.js';
import { drain, seedRetrieval } from './retrieval-seed.js';
import { FakeClamd } from './sprint26d-fakes.js';

/*
 * Sprint 43 (1.7.0), B-98: groups as access subjects. The "done when" of each item is a test below:
 *   B-9801 a group whose only owner is disabled can be administered again, and the departed owner receives no notices;
 *   B-9802 a folder granted to a group is readable by its members and by no one who leaves it;
 *   B-9803 explain shows the group grant that lets a member read a secret;
 *   B-9804 a group member searches the knowledge base; a former member's search no longer returns it;
 *   B-9805 a record in a group-scoped app is listed only to that group's members.
 */

type Person = Awaited<ReturnType<typeof personIn>>;

async function personIn(h: Harness, name: string, workspaces: string[], roles: string[] = ['member'], admin = false) {
  const user = await localUser(h, name, roles, 'confidential');
  for (const w of workspaces) await h.s.tenants.addMember(w, user.id);
  const c: Client = admin ? await loginAdmin(h, name) : await login(h, name);
  const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
  return {
    user,
    ...c,
    post: (p: string, b?: object) => send('post', p, b),
    patch: (p: string, b?: object) => send('patch', p, b),
    put: (p: string, b?: object) => send('put', p, b),
    del: (p: string) => send('delete', p),
    get: (p: string) => c.agent.get(p),
    upload: (ws: string, name: string, data: string, q: Record<string, string> = {}) =>
      c.agent.put(`/api/files/uploads?${new URLSearchParams({ name, workspace: ws, ...q }).toString()}`).set('x-csrf-token', c.csrf).set('content-type', 'application/octet-stream').send(Buffer.from(data))
  };
}

const notes = (h: Harness, userId: string) => h.s.db('notifications').where({ tenant_id: h.tenantId, user_id: userId }) as Promise<{ title: string }[]>;

describe('groups as access subjects (Sprint 43, B-98)', () => {
  let h: Harness;
  let clamd: FakeClamd;
  let design: string;
  let finance: string;
  let alice: Person;
  let bob: Person;
  let carol: Person;

  beforeEach(async () => {
    clamd = await new FakeClamd().start();
    h = await harness({ CLAMD_HOST: '127.0.0.1', CLAMD_PORT: String(clamd.port) });
    design = (await h.s.tenants.createWorkspace(h.tenantId, 'Design', 'confidential')).id;
    finance = (await h.s.tenants.createWorkspace(h.tenantId, 'Finance', 'confidential')).id;
    alice = await personIn(h, 'alice', [design]);
    bob = await personIn(h, 'bob', [design]);
    carol = await personIn(h, 'carol', [design]);
  }, 120_000);
  afterEach(async () => {
    await h.close();
    await clamd.stop();
  });

  it('B-9801: a group whose only owner is disabled can be administered again, and the departed owner receives no notices', async () => {
    const mgr = await personIn(h, 'mgr', [design], ['tenant-admin'], true);
    const g = (await alice.post('/api/groups', { workspaceId: design, name: 'Type club', joinMode: 'open', visibility: 'public' }).expect(201)).body;
    await bob.post(`/api/groups/${g.id}/join`).expect(200);
    // while alice is active, the last owner cannot leave and nobody claims the group
    await alice.del(`/api/groups/${g.id}/members/${alice.user.id}`).expect(409);
    await mgr.post(`/api/groups/${g.id}/claim-ownership`).expect(409);
    expect((await h.s.groups.ownership.sweep(h.tenantId)).notified).toEqual([]);

    // alice's account is disabled: the group has no active owner
    await h.s.db('users').where({ id: alice.user.id }).update({ state: 'disabled' });
    expect(await h.s.groups.ownership.activeOwners(g.id)).toBe(0);
    const before = (await notes(h, alice.user.id)).length;
    const swept = await h.s.groups.ownership.sweep(h.tenantId);
    expect(swept.notified).toEqual([g.id]);
    expect((await notes(h, mgr.user.id)).map((n) => n.title)).toContain('Type club has no active owner');
    expect((await h.s.groups.ownership.sweep(h.tenantId)).notified).toEqual([]); // told once
    expect(await h.s.db('audit_events').where({ action: 'group.ownerless' })).toHaveLength(1);

    // departed members are left out of member lists, unless a manager asks for them
    expect(((await bob.get(`/api/groups/${g.id}/members`).expect(200)).body as { userId: string }[]).map((m) => m.userId)).toEqual([bob.user.id]);
    expect(((await bob.get(`/api/groups/${g.id}/members?departed=1`).expect(200)).body as { userId: string }[]).map((m) => m.userId)).toEqual([bob.user.id]);
    expect((await mgr.get(`/api/groups/${g.id}/members?departed=1`).expect(200)).body).toEqual(expect.arrayContaining([expect.objectContaining({ userId: alice.user.id, role: 'owner', departed: true })]));

    // a member cannot claim it; a manager can, and administers it as its owner
    expect((await bob.post(`/api/groups/${g.id}/claim-ownership`).expect(403)).body.step).toBe('permission');
    expect((await mgr.post(`/api/groups/${g.id}/claim-ownership`).expect(200)).body).toMatchObject({ owner: mgr.user.id, joined: true });
    expect(await h.s.groups.ownership.activeOwners(g.id)).toBe(1);
    await mgr.patch(`/api/groups/${g.id}/members/${bob.user.id}`, { role: 'moderator' }).expect(200);
    await mgr.post(`/api/groups/${g.id}/claim-ownership`).expect(409);
    expect((await h.s.db('social_groups').where({ id: g.id }).first()).ownerless_at).toBeNull();
    expect(await h.s.db('audit_events').where({ action: 'group.ownership.claimed' })).toHaveLength(1);

    // the departed owner receives no notices about the group from here on
    await carol.post(`/api/groups/${g.id}/join`).expect(200);
    await mgr.patch(`/api/groups/${g.id}/members/${carol.user.id}`, { role: 'moderator' }).expect(200);
    expect((await notes(h, alice.user.id)).length).toBe(before);
  }, 120_000);

  it('B-9802: a folder granted to a group is readable by its members and by no one who leaves it', async () => {
    const fran = await personIn(h, 'fran', [finance]);
    const g = (await alice.post('/api/groups', { workspaceId: design, name: 'Budget readers', joinMode: 'open', visibility: 'public' }).expect(201)).body;
    await bob.post(`/api/groups/${g.id}/join`).expect(200);

    // a folder in Finance, a file in a subfolder of it, and a file outside it
    const folder = (await fran.post('/api/files/folders', { name: 'Budgets', workspaceId: finance }).expect(201)).body;
    const sub = (await fran.post('/api/files/folders', { name: '2027', parentId: folder.id }).expect(201)).body;
    const inside = (await fran.upload(finance, 'plan.txt', 'The 2027 plan.', { folder: sub.id }).expect(202)).body;
    const outside = (await fran.upload(finance, 'payroll.txt', 'Payroll.').expect(202)).body;
    // A file still being scanned lists no grants (200, not 409) but cannot be granted yet.
    const pending = (await fran.upload(finance, 'pending.txt', 'Not scanned yet.').expect(202)).body;
    expect((await fran.get(`/api/files/${pending.id}/group-grants`).expect(200)).body).toEqual([]);
    await fran.post(`/api/files/${pending.id}/group-grants`, { groupId: g.id }).expect(409);
    await drain(h);

    // before the grant nobody in Design reads either
    await bob.get(`/api/files/${inside.id}`).expect(404);
    // granting takes the right to the folder (a Finance member), and names a live group once
    await bob.post(`/api/files/folders/${folder.id}/group-grants`, { groupId: g.id }).expect(404);
    const grant = (await fran.post(`/api/files/folders/${folder.id}/group-grants`, { groupId: g.id }).expect(201)).body;
    expect(grant).toMatchObject({ folderId: folder.id, groupId: g.id, groupName: 'Budget readers' });
    await fran.post(`/api/files/folders/${folder.id}/group-grants`, { groupId: g.id }).expect(409);
    expect((await fran.get(`/api/files/folders/${folder.id}/group-grants`).expect(200)).body).toHaveLength(1);

    // its members read what is below the folder, not what is beside it, and the list says how
    expect((await bob.get(`/api/files/${inside.id}`).expect(200)).body).toMatchObject({ id: inside.id, name: 'plan.txt' });
    expect((await alice.get(`/api/files/${inside.id}/content`).expect(200)).text).toBe('The 2027 plan.');
    await bob.get(`/api/files/${outside.id}`).expect(404);
    const shared = (await bob.get('/api/files/shared').expect(200)).body as { id: string; sharedVia: string; groupId?: string; viaFolder?: string }[];
    expect(shared).toEqual([expect.objectContaining({ id: inside.id, sharedVia: 'social_group', groupId: g.id, viaFolder: folder.id })]);
    // a grant reads, never writes
    await bob.patch(`/api/files/${inside.id}`, { name: 'mine.txt' }).expect(404);
    // carol is in Design but not in the group
    await carol.get(`/api/files/${inside.id}`).expect(404);

    // leaving the group ends it at once; so do a ban and a suspension
    await bob.del(`/api/groups/${g.id}/members/${bob.user.id}`).expect(200);
    await bob.get(`/api/files/${inside.id}`).expect(404);
    expect((await bob.get('/api/files/shared').expect(200)).body).toEqual([]);
    await carol.post(`/api/groups/${g.id}/join`).expect(200);
    await carol.get(`/api/files/${inside.id}`).expect(200);
    await alice.post(`/api/groups/${g.id}/bans`, { userId: carol.user.id, kind: 'suspend', days: 1 }).expect(201);
    await carol.get(`/api/files/${inside.id}`).expect(404);

    // revoking the grant ends it for everyone
    await fran.del(`/api/files/group-grants/${grant.id}`).expect(204);
    await alice.get(`/api/files/${inside.id}`).expect(404);
    expect((await h.s.db('audit_events').whereIn('action', ['file.group-grant.created', 'file.group-grant.revoked'])).length).toBe(2);
  }, 120_000);
  it('B-9803: explain shows the group grant that lets a member read a secret; a deny to the group wins', async () => {
    const admin = await personIn(h, 'vadmin', [design], ['tenant-admin'], true);
    const g = (await alice.post('/api/groups', { workspaceId: design, name: 'On call', joinMode: 'open', visibility: 'public' }).expect(201)).body;
    await bob.post(`/api/groups/${g.id}/join`).expect(200);
    await admin.post('/api/vault/policies', { subjectKind: 'user', subject: admin.user.id, path: 'kv/teams', capabilities: ['read', 'write', 'list'], effect: 'allow' }).expect(201);
    await admin.agent.put('/api/vault/kv/data/teams/oncall/pager').set('x-csrf-token', admin.csrf).send({ data: { token: 'pager-T0ken' } }).expect((r) => expect(r.status).toBeLessThan(300));
    // a social group that does not exist is refused as a subject
    await admin.post('/api/vault/policies', { subjectKind: 'social_group', subject: '01ARZ3NDEKTSV4RRFFQ69G5FAV', path: 'kv/teams/oncall', capabilities: ['read'], effect: 'allow' }).expect(400);
    const grant = (await admin.post('/api/vault/policies', { subjectKind: 'social_group', subject: g.id, path: 'kv/teams/oncall', capabilities: ['read'], effect: 'allow', description: 'On call reads the pager token' }).expect(201)).body;

    // bob reads it through the group, and explain names the group's grant
    expect((await bob.get('/api/vault/kv/data/teams/oncall/pager').expect(200)).body.data).toEqual({ token: 'pager-T0ken' });
    const ex = (await admin.post('/api/vault/policies/explain', { path: 'kv/teams/oncall/pager', capability: 'read', userId: bob.user.id }).expect(200)).body;
    expect(ex.decision).toMatchObject({ allow: true, grant: { id: grant.id, subjectKind: 'social_group', subject: g.id } });
    expect(ex.subjects.socialGroups).toEqual([g.id]);
    expect(ex.socialGroupNames).toEqual({ [g.id]: 'On call' });
    // carol, in the workspace but not the group, is refused
    await carol.get('/api/vault/kv/data/teams/oncall/pager').expect(403);

    // a deny to the group wins over a user's allow
    await admin.post('/api/vault/policies', { subjectKind: 'user', subject: bob.user.id, path: 'kv/teams/oncall/pager', capabilities: ['read'], effect: 'allow' }).expect(201);
    const deny = (await admin.post('/api/vault/policies', { subjectKind: 'social_group', subject: g.id, path: 'kv/teams/oncall', capabilities: ['read'], effect: 'deny' }).expect(201)).body;
    expect((await bob.get('/api/vault/kv/data/teams/oncall/pager').expect(403)).body).toMatchObject({ step: 'vault-policy' });
    await admin.del(`/api/vault/policies/${deny.id}`).expect(204);
    // leaving the group ends the group's grant (the user grant still reads)
    await admin.del(`/api/vault/policies/${(await h.s.db('vault_policies').where({ subject_kind: 'user', subject: bob.user.id }).first()).id}`).expect(204);
    await bob.del(`/api/groups/${g.id}/members/${bob.user.id}`).expect(200);
    await bob.get('/api/vault/kv/data/teams/oncall/pager').expect(403);
  }, 120_000);

  it('B-9804: a group member searches the knowledge base; a former member\'s search no longer returns it', async () => {
    const ollama = await new FakeOllama().start();
    try {
      await seedRetrieval(h, ollama);
      const curator = await personIn(h, 'cura', [finance], ['member', 'knowledge-curator']);
      const kb = (await curator.post('/api/knowledge/bases', { name: 'Runbooks', label: 'internal', embedModel: 'nomic-embed-text', workspaceId: finance, sharing: 'curators' }).expect((r) => expect(r.status).toBe(201))).body as { id: string };
      await curator.patch(`/api/knowledge/bases/${kb.id}`, { status: 'published' }).expect(200);
      await curator.agent.put(`/api/knowledge/bases/${kb.id}/uploads?${new URLSearchParams({ name: 'failover.md', label: 'internal' })}`).set('x-csrf-token', curator.csrf).set('content-type', 'application/octet-stream').send(Buffer.from('# Failover\nTo fail over the database, promote the replica and repoint the pool.')).expect(202);
      await drain(h);
      const search = (c: Person) => c.post('/api/knowledge/search', { kbIds: [kb.id], query: 'fail over the database', rerank: false });

      const g = (await alice.post('/api/groups', { workspaceId: design, name: 'SRE', joinMode: 'open', visibility: 'public' }).expect(201)).body;
      await bob.post(`/api/groups/${g.id}/join`).expect(200);
      await search(bob).expect(404);
      await curator.post(`/api/knowledge/bases/${kb.id}/access`, { kind: 'social_group', id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', access: 'read' }).expect(404);
      const list = (await curator.post(`/api/knowledge/bases/${kb.id}/access`, { kind: 'social_group', id: g.id, access: 'read' }).expect(201)).body as { kind: string; name: string }[];
      expect(list).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'social_group', name: 'SRE' })]));

      const hits = (await search(bob).expect(200)).body.hits as { document: string }[];
      expect(hits.length).toBeGreaterThan(0);
      expect(((await bob.get('/api/knowledge/bases').expect(200)).body as { id: string }[]).map((b) => b.id)).toContain(kb.id);
      await search(carol).expect(404);
      // a read grant does not manage
      await bob.patch(`/api/knowledge/bases/${kb.id}`, { description: 'mine' }).expect((r) => expect([403, 404]).toContain(r.status));

      await bob.del(`/api/groups/${g.id}/members/${bob.user.id}`).expect(200);
      await search(bob).expect(404);
      expect(((await bob.get('/api/knowledge/bases').expect(200)).body as { id: string }[]).map((b) => b.id)).not.toContain(kb.id);
    } finally {
      await ollama.stop();
    }
  }, 120_000);

  it('B-9805: a record in a group-scoped app is listed only to that group\'s members; app roles follow group roles', async () => {
    const dana = await personIn(h, 'dana', [design], ['member', 'workflow-admin'], true);
    const g = (await dana.post('/api/groups', { workspaceId: design, name: 'Field team', joinMode: 'open', visibility: 'public' }).expect(201)).body;
    const other = (await alice.post('/api/groups', { workspaceId: design, name: 'Not dana\'s', joinMode: 'open', visibility: 'public' }).expect(201)).body;
    await bob.post(`/api/groups/${g.id}/join`).expect(200);
    await carol.post(`/api/groups/${other.id}/join`).expect(200);

    // only an owner of the group scopes an app to it
    await dana.post('/api/apps', { name: 'stolen', label: 'internal', workspaceId: design, groupId: other.id }).expect(403);
    const app = (await dana.post('/api/apps', { name: 'visits', label: 'internal', workspaceId: design, groupId: g.id }).expect(201)).body;
    expect(app.groupId).toBe(g.id);
    await dana.post('/api/apps/visits/entities', { name: 'visit', definition: { fields: [{ name: 'site', type: 'string', indexed: true, maxLength: 120 }] } }).expect(201);
    const rec = (await dana.post('/api/apps/visits/entities/visit/records', { values: { site: 'North depot' } }).expect(201)).body;

    // members list the record; carol (in the workspace, not the group) does not even see the app
    const listed = async (c: Person) => ((await c.get('/api/apps/visits/entities/visit/records').expect(200)).body.records as { id: string }[]).map((r) => r.id);
    expect(await listed(bob)).toEqual([rec.id]);
    await carol.get('/api/apps/visits/entities/visit/records').expect(404);
    expect(((await carol.get('/api/apps').expect(200)).body.apps as { name: string }[]).map((a) => a.name)).not.toContain('visits');

    // app roles follow group roles: a policy for the group's moderators
    await dana.post('/api/apps/visits/policies', { name: 'Moderators only', entity: 'visit', subjects: [{ kind: 'group_role', value: 'moderator' }] }).expect(201);
    expect(await listed(bob)).toEqual([]);
    await dana.patch(`/api/groups/${g.id}/members/${bob.user.id}`, { role: 'moderator' }).expect(200);
    expect(await listed(bob)).toEqual([rec.id]);

    // leaving the group: the app is gone for them
    await bob.del(`/api/groups/${g.id}/members/${bob.user.id}`).expect(200);
    await bob.get('/api/apps/visits/entities/visit/records').expect(404);

    // an entity can be scoped on its own: an unscoped app, one entity for the group
    const open = (await dana.post('/api/apps', { name: 'depots', label: 'internal', workspaceId: design }).expect(201)).body;
    expect(open.groupId).toBeNull();
    await dana.post('/api/apps/depots/entities', { name: 'depot', definition: { fields: [{ name: 'name', type: 'string' }] } }).expect(201);
    await dana.post('/api/apps/depots/entities/depot/records', { values: { name: 'East' } }).expect(201);
    expect((await carol.get('/api/apps/depots/entities/depot/records').expect(200)).body.records).toHaveLength(1);
    expect((await dana.put('/api/apps/depots/entities/depot/group', { groupId: g.id }).expect(200)).body.groupId).toBe(g.id);
    expect((await carol.get('/api/apps/depots/entities/depot/records').expect(200)).body.records).toHaveLength(0);
    expect(await h.s.db('audit_events').where({ action: 'app.entity.scoped' })).toHaveLength(1);
  }, 120_000);
});
