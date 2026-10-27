import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Harness } from './helpers.js';
import { enableIndex, person, searchHarness, settle, type Person } from './search-helpers.js';

/*
 * 1.9.9-qa (B-173, the Sprint 52 leftovers): saved searches and the message locator behind "jump to the message".
 *
 * - Saved searches are sealed at rest (the name, the query and the filters; the owner and the row in the associated
 *   data), per person (another person's is not found, for reading, changing, deleting or running), listed, renamed,
 *   changed, deleted and run with their filters as the reader now; creating, changing and deleting are audited without
 *   the query; until migration 145 is applied the list says unavailable and writes answer 503.
 * - The locator says where a message is without its text, and answers the same for a message that is gone and one
 *   the reader may not see.
 */

const C = '/api/messaging/conversations';
const S = '/api/search/saved';
type Saved = { id: string; name: string; q: string; source: string; filters: Record<string, unknown>; lastRunAt: number | null };

async function applySaved(h: Harness): Promise<void> {
  if (!(await h.s.db.schema.hasTable('saved_searches'))) await (await import('../src/db/migrations/145_saved_searches.js')).up(h.s.db);
  h.s.search.saved.resetSchemaCache();
}

describe('saved searches (B-173)', () => {
  let h: Harness;
  let ws: string;
  let alice: Person;
  let bob: Person;

  beforeEach(async () => {
    h = await searchHarness();
    ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Design', 'confidential')).id;
    alice = await person(h, 'alice', [ws]);
    bob = await person(h, 'bob', [ws]);
    for (const x of [alice, bob]) await x.put('/api/me/workspace', { workspaceId: ws }).expect(200);
  }, 60_000);
  afterEach(async () => {
    await h.close();
  });

  it('reads as unavailable until migration 145 is applied, and then works', async () => {
    if (await h.s.db.schema.hasTable('saved_searches')) await h.s.db.schema.dropTable('saved_searches');
    h.s.search.saved.resetSchemaCache();
    expect((await alice.get(S).expect(200)).body).toMatchObject({ available: false, items: [] });
    const refused = await alice.post(S, { name: 'Plans', q: 'plan' }).expect(503);
    expect(refused.headers['content-type']).toMatch(/problem\+json/);
    await alice.post(`${S}/01J00000000000000000000000/run`, {}).expect(503);
    await applySaved(h);
    expect((await alice.get(S).expect(200)).body).toMatchObject({ available: true, items: [] });
    await alice.post(S, { name: 'Plans', q: 'plan' }).expect(201);
  });

  describe('with the table', () => {
    beforeEach(async () => {
      await applySaved(h);
    });

    it('seals the name, the query and the filters; the row opens only as its owner', async () => {
      const conv = (await alice.post(C, { kind: 'group', workspaceId: ws, title: 'Crit', memberIds: [bob.user.id] }).expect(201)).body as { id: string };
      const x = (await alice.post(S, { name: 'Quokka watch', q: 'quokka sightings', source: 'chats', filters: { conversation: conv.id, has: ['link'] } }).expect(201)).body as Saved;
      expect(x).toMatchObject({ name: 'Quokka watch', q: 'quokka sightings', source: 'chats', filters: { conversation: conv.id, has: ['link'] } });
      const row = (await h.s.db('saved_searches').where({ id: x.id }).first()) as Record<string, string>;
      expect(row.source).toBe('chats');
      const raw = JSON.stringify(row);
      for (const plain of ['Quokka', 'quokka', 'sightings', conv.id]) expect(raw).not.toContain(plain);
      // the associated data binds the owner: the same ciphertext does not open as bob's
      await expect(h.s.keys.open(h.tenantId, row.sealed!, `saved-search:${h.tenantId}:${bob.user.id}:${x.id}`)).rejects.toThrow();
      expect(JSON.parse(await h.s.keys.open(h.tenantId, row.sealed!, `saved-search:${h.tenantId}:${alice.user.id}:${x.id}`))).toMatchObject({ q: 'quokka sightings' });
    });

    it('is per person: another person neither lists, reads, changes, deletes nor runs it', async () => {
      const x = (await alice.post(S, { name: 'Mine', q: 'otter' }).expect(201)).body as Saved;
      await bob.post(S, { name: 'Bob’s', q: 'heron' }).expect(201);
      expect(((await alice.get(S).expect(200)).body.items as Saved[]).map((i) => i.name)).toEqual(['Mine']);
      expect(((await bob.get(S).expect(200)).body.items as Saved[]).map((i) => i.name)).toEqual(['Bob’s']);
      await bob.get(`${S}/${x.id}`).expect(404);
      await bob.patch(`${S}/${x.id}`, { name: 'Taken' }).expect(404);
      await bob.del(`${S}/${x.id}`).expect(404);
      await bob.post(`${S}/${x.id}/run`, {}).expect(404);
      expect((await alice.get(`${S}/${x.id}`).expect(200)).body).toMatchObject({ name: 'Mine', q: 'otter' });
    });

    it('creates, lists, renames, changes and deletes, audited without the query or the name', async () => {
      const a = (await alice.post(S, { name: 'Alpha', q: 'secretword alpha', source: 'posts', filters: { kind: 'post', tag: 'roadmap' } }).expect(201)).body as Saved;
      await new Promise((r) => setTimeout(r, 5));
      const b = (await alice.post(S, { name: 'Beta', q: 'beta' }).expect(201)).body as Saved;
      expect(b.source).toBe('all');
      expect(((await alice.get(S).expect(200)).body.items as Saved[]).map((i) => i.id)).toEqual([b.id, a.id]);

      const renamed = (await alice.patch(`${S}/${a.id}`, { name: 'Alpha, renamed' }).expect(200)).body as Saved;
      expect(renamed).toMatchObject({ name: 'Alpha, renamed', q: 'secretword alpha', filters: { kind: 'post', tag: 'roadmap' } });
      // a new source drops the filters only the old one takes
      const moved = (await alice.patch(`${S}/${a.id}`, { source: 'files' }).expect(200)).body as Saved;
      expect(moved).toMatchObject({ source: 'files', filters: {} });
      await alice.patch(`${S}/${a.id}`, { filters: { kind: 'post' } }).expect(400);
      expect((await alice.patch(`${S}/${a.id}`, { q: 'gamma' }).expect(200)).body.q).toBe('gamma');

      await alice.del(`${S}/${b.id}`).expect(200);
      expect(((await alice.get(S).expect(200)).body.items as Saved[]).map((i) => i.id)).toEqual([a.id]);
      await alice.del(`${S}/${b.id}`).expect(404);

      const events = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).where('action', 'like', 'search.saved.%').orderBy('seq')) as { action: string; detail: string | null; target: string | null }[];
      expect(events.map((e) => e.action)).toEqual(['search.saved.created', 'search.saved.created', 'search.saved.updated', 'search.saved.updated', 'search.saved.updated', 'search.saved.deleted']);
      const all = JSON.stringify(events);
      for (const plain of ['secretword', 'Alpha', 'Beta', 'gamma', 'roadmap']) expect(all).not.toContain(plain);
    });

    it('checks what it saves: the source permission, the filters, the limits', async () => {
      await alice.post(S, { name: 'x', q: 'y', source: 'chats', filters: { has: ['photo'] } }).expect(400);
      await alice.post(S, { name: 'x', q: 'y', source: 'posts', filters: { conversation: 'nope' } }).expect(400);
      await alice.post(S, { name: 'x', q: 'y', source: 'files', filters: { tag: 'a' } }).expect(400);
      await alice.post(S, { name: 'x', q: 'y', source: 'nowhere' }).expect(400);
      await alice.post(S, { name: '', q: 'y' }).expect(400);
      await alice.post(S, { name: 'x', q: 'y', tenantId: h.tenantId }).expect(400);
      // a curator searches knowledge, not posts
      const { localUser, login } = await import('./helpers.js');
      await localUser(h, 'kc', ['knowledge-curator'], 'internal');
      const kc = await login(h, 'kc');
      const send = (path: string, body: object) => kc.agent.post(path).set('x-csrf-token', kc.csrf).send(body);
      await send(S, { name: 'p', q: 'y', source: 'posts' }).expect(403);
      await send(S, { name: 'k', q: 'y', source: 'knowledge' }).expect(201);
    });

    it('runs with its filters, as the reader now', async () => {
      await enableIndex(h);
      const one = (await alice.post(C, { kind: 'group', workspaceId: ws, title: 'One', memberIds: [bob.user.id] }).expect(201)).body as { id: string };
      const two = (await alice.post(C, { kind: 'group', workspaceId: ws, title: 'Two', memberIds: [bob.user.id] }).expect(201)).body as { id: string };
      const m1 = (await alice.post(`${C}/${one.id}/messages`, { body: 'the pelican report' }).expect(201)).body as { id: string };
      const m2 = (await bob.post(`${C}/${two.id}/messages`, { body: 'pelican numbers are up' }).expect(201)).body as { id: string };
      const post = (await alice.post('/api/feed/posts', { workspaceId: ws, body: 'Pelican season #birds' }).expect(201)).body as { id: string };
      await settle(h);

      const inOne = (await bob.post(S, { name: 'In One', q: 'pelican', source: 'chats', filters: { conversation: one.id } }).expect(201)).body as Saved;
      const fromBob = (await bob.post(S, { name: 'Mine', q: 'pelican', source: 'chats', filters: { from: bob.user.id } }).expect(201)).body as Saved;
      const tagged = (await bob.post(S, { name: 'Birds', q: 'pelican', source: 'posts', filters: { tag: 'birds', kind: 'post' } }).expect(201)).body as Saved;
      const every = (await bob.post(S, { name: 'Everything', q: 'pelican' }).expect(201)).body as Saved;

      const r1 = (await bob.post(`${S}/${inOne.id}/run`, {}).expect(200)).body as { saved: Saved; results: { items: { id: string; route: string }[] } };
      expect(r1.results.items.map((i) => i.id)).toEqual([m1.id]);
      expect(r1.results.items[0]!.route).toBe(`messages?convo=${one.id}&message=${m1.id}`);
      expect(r1.saved.lastRunAt).toBeGreaterThan(0);
      expect(((await bob.post(`${S}/${fromBob.id}/run`, {}).expect(200)).body.results.items as { id: string }[]).map((i) => i.id)).toEqual([m2.id]);
      expect(((await bob.post(`${S}/${tagged.id}/run`, {}).expect(200)).body.results.items as { id: string }[]).map((i) => i.id)).toEqual([post.id]);
      const all = (await bob.post(`${S}/${every.id}/run`, {}).expect(200)).body.results as { groups: { source: string; items: { id: string }[] }[] };
      expect(all.groups.find((g) => g.source === 'chats')!.items.map((i) => i.id).sort()).toEqual([m1.id, m2.id].sort());

      // as the reader now: bob leaves One, and the saved search finds nothing there any more
      await alice.del(`${C}/${one.id}/members/${bob.user.id}`).expect(200);
      expect((await bob.post(`${S}/${inOne.id}/run`, {}).expect(200)).body.results.items).toEqual([]);
      // and the run reads its stored filters with the routes' schemas: a page
      expect((await bob.post(`${S}/${every.id}/run`, { limit: 1 }).expect(200)).body.results.groups.find((g: { source: string }) => g.source === 'chats').items).toHaveLength(1);
      await bob.post(`${S}/${every.id}/run`, { q: 'other' }).expect(400);
    });
  });
});

describe('the message locator (jump to the message)', () => {
  let h: Harness;
  let ws: string;
  let alice: Person;
  let bob: Person;
  let carol: Person;

  beforeEach(async () => {
    h = await searchHarness();
    ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Design', 'confidential')).id;
    alice = await person(h, 'alice', [ws]);
    bob = await person(h, 'bob', [ws]);
    carol = await person(h, 'carol', [ws]);
  }, 60_000);
  afterEach(async () => {
    await h.close();
  });

  it('says where a message is, without its text; gone and not yours answer the same', async () => {
    const conv = (await alice.post(C, { kind: 'group', workspaceId: ws, title: 'Crit', memberIds: [bob.user.id] }).expect(201)).body as { id: string };
    const m = (await alice.post(`${C}/${conv.id}/messages`, { body: 'the cormorant note' }).expect(201)).body as { id: string };
    const reply = (await bob.post(`${C}/${conv.id}/messages`, { body: 'a reply in the thread', threadId: m.id }).expect(201)).body as { id: string };
    const gone = (await alice.post(`${C}/${conv.id}/messages`, { body: 'deleted soon' }).expect(201)).body as { id: string };
    await alice.del(`/api/messaging/messages/${gone.id}`).expect(200);

    const at = (await bob.get(`/api/search/messages/${m.id}/locate`).expect(200)).body as Record<string, unknown>;
    expect(at).toMatchObject({ id: m.id, state: 'sent', conversationId: conv.id, threadId: null });
    expect(typeof at.createdAt).toBe('number');
    expect(JSON.stringify(at)).not.toContain('cormorant');
    expect((await bob.get(`/api/search/messages/${reply.id}/locate`).expect(200)).body).toMatchObject({ state: 'sent', threadId: m.id });
    expect((await bob.get(`/api/search/messages/${gone.id}/locate`).expect(200)).body).toMatchObject({ state: 'deleted', conversationId: conv.id });

    // carol is not in the conversation; an unknown id; both the same answer, with nothing about the conversation
    const none = { state: 'unavailable', conversationId: null, createdAt: null, threadId: null };
    expect((await carol.get(`/api/search/messages/${m.id}/locate`).expect(200)).body).toMatchObject(none);
    expect((await carol.get('/api/search/messages/01J00000000000000000000000/locate').expect(200)).body).toMatchObject(none);
    // a block hides the other person's messages; above the reader's clearance, nothing
    await bob.post('/api/social/blocks', { userId: alice.user.id }).expect(201);
    expect((await bob.get(`/api/search/messages/${m.id}/locate`).expect(200)).body).toMatchObject(none);
    await bob.del(`/api/social/blocks/${alice.user.id}`).expect(200);
    await h.s.db('dm_conversations').where({ id: conv.id }).update({ label: 'confidential' });
    expect((await bob.get(`/api/search/messages/${m.id}/locate`).expect(200)).body).toMatchObject(none);
    await bob.get('/api/search/messages/not-an-id/locate').expect(400);
  });
});
