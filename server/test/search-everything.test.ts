import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeOllama } from './fake-ollama.js';
import { loginAdmin, localUser, type Harness } from './helpers.js';
import { adminPrincipal, drain, enableIndex, person, searchHarness, seedEmbeddings, settle, type Person } from './search-helpers.js';

/*
 * 1.9.0, Sprint 52 (B-173): one search box. One query answers from chats, posts, files, knowledge, groups, people, app
 * records and the reader's assistant chats, grouped by source in a fixed order; type-ahead reads the last word as a
 * prefix and offers completions from the reader's own results; a source the reader may not use is not asked, a source
 * that fails does not take the others down, and no source answers with anything its own search would not.
 */

type Box = { q: string; engine: string; groups: { source: string; title: string; items: { id: string; title: string; route: string }[]; error: string | null }[]; completions?: string[] };
const C = '/api/messaging/conversations';

describe('one search box (B-173)', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let ws: string;
  let other: string;
  let alice: Person;
  let bob: Person;

  beforeEach(async () => {
    ollama = await new FakeOllama().start();
    h = await searchHarness();
    await seedEmbeddings(h, ollama);
    ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Studio', 'confidential')).id;
    other = (await h.s.tenants.createWorkspace(h.tenantId, 'Elsewhere', 'confidential')).id;
    alice = await person(h, 'alice', [ws]);
    bob = await person(h, 'bob', [ws]);
    for (const x of [alice, bob]) await x.put('/api/me/workspace', { workspaceId: ws }).expect(200);
    await enableIndex(h);
  }, 60_000);
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  /** One thing called "zephyr" in every source, all of it in the Studio workspace. */
  async function seed() {
    const g = (await alice.post(C, { kind: 'group', workspaceId: ws, title: 'Crew', memberIds: [bob.user.id] }).expect(201)).body as { id: string };
    const msg = (await alice.post(`${C}/${g.id}/messages`, { body: 'The zephyr launch is on Friday' }).expect(201)).body as { id: string };
    const post = (await alice.post('/api/feed/posts', { workspaceId: ws, body: 'Zephyr roadmap, first draft' }).expect(201)).body as { id: string };
    const up = await alice.agent.put(`/api/files/uploads?${new URLSearchParams({ name: 'zephyr-plan.txt', workspace: ws }).toString()}`).set('x-csrf-token', alice.csrf).set('content-type', 'application/octet-stream').send(Buffer.from('the plan'));
    expect(up.status).toBe(202);
    const curator = await localUser(h, 'kc', ['knowledge-curator', 'member'], 'confidential');
    await h.s.tenants.addMember(ws, curator.id);
    const cp = (await (await import('../src/http/middleware.js')).loadPrincipal(h.s, h.tenantId, curator.id, {}))!;
    const kb = await h.s.knowledge.create(cp, { name: 'Handbook', description: null, label: 'internal', embedModel: 'nomic-embed-text', reranker: null, sharing: 'members', workspaceId: ws });
    const doc = await h.s.knowledge.upload(cp, kb.id, { name: 'zephyr-handbook.txt', label: 'internal', data: Buffer.from('How the zephyr project works.') });
    const grp = (await alice.post('/api/groups', { workspaceId: ws, name: 'Zephyr club', joinMode: 'open', visibility: 'public' }).expect(201)).body as { id: string };
    const zed = await person(h, 'zephyrine', [ws]);
    // an app with a record called Zephyr deal
    const designer = await localUser(h, 'dee', ['workflow-admin', 'member'], 'confidential');
    await h.s.tenants.addMember(ws, designer.id);
    const d = await loginAdmin(h, 'dee');
    const send = (method: 'post' | 'put', path: string, body: object) => d.agent[method](path).set('x-csrf-token', d.csrf).send(body);
    await send('put', '/api/me/workspace', { workspaceId: ws }).expect(200);
    await send('post', '/api/apps', { name: 'crm', title: 'CRM', label: 'internal', workspaceId: ws }).expect(201);
    await send('post', '/api/apps/crm/entities', { name: 'deal', title: 'Deal', label: 'internal', definition: { fields: [{ name: 'title', type: 'string', required: true, indexed: true, maxLength: 120 }] } }).expect(201);
    const rec = (await alice.post('/api/apps/crm/entities/deal/records', { values: { title: 'Zephyr deal' } }).expect(201)).body as { id: string };
    const chat = (await alice.post('/api/conversations', { title: 'Zephyr notes' }).expect(201)).body as { id: string };
    await drain(h);
    await settle(h);
    return { msg, post, file: up.body.id as string, doc, grp, zed, rec, chat };
  }

  it('answers from every source, grouped in a fixed order, each through its own search', async () => {
    const x = await seed();
    const box = (await alice.get('/api/search?q=zephyr').expect(200)).body as Box;
    expect(box.engine).toBe('index');
    expect(box.groups.map((g) => g.source)).toEqual(['chats', 'posts', 'files', 'knowledge', 'groups', 'people', 'apps', 'assistant']);
    const by = Object.fromEntries(box.groups.map((g) => [g.source, g]));
    expect(by.chats!.items.map((i) => i.id)).toEqual([x.msg.id]);
    expect(by.posts!.items.map((i) => i.id)).toEqual([x.post.id]);
    expect(by.files!.items.map((i) => i.id)).toEqual([x.file]);
    expect(by.knowledge!.items.map((i) => i.id)).toEqual([x.doc.id]);
    expect(by.groups!.items.map((i) => i.id)).toEqual([x.grp.id]);
    expect(by.people!.items.map((i) => i.id)).toEqual([x.zed.user.id]);
    expect(by.apps!.items.map((i) => i.title)).toEqual(['Zephyr deal']);
    expect(by.assistant!.items.map((i) => i.id)).toEqual([x.chat.id]);
    for (const g of box.groups) expect(g.error).toBeNull();
    expect(by.people!.items[0]!.route).toBe(`person?user=${x.zed.user.id}`);
    expect(by.chats!.items[0]!.route).toMatch(/^messages\?convo=/);
    // one source only
    const only = (await alice.get('/api/search?q=zephyr&sources=files,people').expect(200)).body as Box;
    expect(only.groups.map((g) => g.source)).toEqual(['files', 'people']);
    await alice.get('/api/search?q=zephyr&sources=everything').expect(400);
    await alice.get('/api/search').expect(400);
  });

  it('type-ahead reads the last word as a prefix and completes it from the reader’s results', async () => {
    const x = await seed();
    const sug = (await alice.get('/api/search/suggest?q=zeph').expect(200)).body as Box;
    const by = Object.fromEntries(sug.groups.map((g) => [g.source, g]));
    expect(by.chats!.items.map((i) => i.id)).toEqual([x.msg.id]);
    expect(by.posts!.items.map((i) => i.id)).toEqual([x.post.id]);
    expect(by.groups!.items.map((i) => i.id)).toEqual([x.grp.id]);
    expect(sug.completions).toContain('zephyr');
    for (const g of sug.groups) expect(g.items.length).toBeLessThanOrEqual(3);
    expect(((await alice.get('/api/search/suggest?q=').expect(200)).body as Box).groups).toEqual([]);
  });

  it('never widens access: other workspaces, missing permissions, and a failing source', async () => {
    await seed();
    // someone outside the workspace finds none of it, in any source
    const out = await person(h, 'olaf', [other]);
    await out.put('/api/me/workspace', { workspaceId: other }).expect(200);
    const theirs = (await out.get('/api/search?q=zephyr').expect(200)).body as Box;
    for (const g of theirs.groups) expect([g.source, g.items]).toEqual([g.source, []]);
    // a curator searches knowledge alone (the only source permission they hold)
    const kc = await localUser(h, 'kc2', ['knowledge-curator'], 'internal');
    await h.s.tenants.addMember(ws, kc.id);
    const p = (await (await import('../src/http/middleware.js')).loadPrincipal(h.s, h.tenantId, kc.id, {}))!;
    expect(h.s.search.everything.sourcesFor(p)).toEqual(['knowledge']);
    // asking for a source one may not search leaves it out rather than answering it
    const r = await h.s.search.everything.search(p, { q: 'zephyr', sources: ['chats', 'files', 'knowledge'] });
    expect(r.groups.map((g) => g.source)).toEqual(['knowledge']);
    // a source that fails says so; the others still answer
    const files = h.s.files.search.bind(h.s.files);
    h.s.files.search = async () => {
      throw new Error('disk on fire');
    };
    try {
      const box = (await alice.get('/api/search?q=zephyr').expect(200)).body as Box;
      const f = box.groups.find((g) => g.source === 'files')!;
      expect(f).toMatchObject({ items: [], error: 'This source could not be searched just now.' });
      expect(box.groups.find((g) => g.source === 'chats')!.items).toHaveLength(1);
      expect(JSON.stringify(box)).not.toContain('disk on fire');
    } finally {
      h.s.files.search = files;
    }
    // bob, who is in the conversation and the workspace, finds the chat; the assistant chat is alice's alone
    const b = (await bob.get('/api/search?q=zephyr').expect(200)).body as Box;
    expect(b.groups.find((g) => g.source === 'chats')!.items).toHaveLength(1);
    expect(b.groups.find((g) => g.source === 'assistant')!.items).toEqual([]);
  });

  it('works the same before the index is built', async () => {
    const admin = await adminPrincipal(h, 'boss');
    await h.s.search.index.disable({ p: admin, ip: null });
    const x = await seed();
    const box = (await alice.get('/api/search?q=zephyr').expect(200)).body as Box;
    expect(box.engine).toBe('fallback');
    const by = Object.fromEntries(box.groups.map((g) => [g.source, g]));
    expect(by.chats!.items.map((i) => i.id)).toEqual([x.msg.id]);
    expect(by.posts!.items.map((i) => i.id)).toEqual([x.post.id]);
  });
});
