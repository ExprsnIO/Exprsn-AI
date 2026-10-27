import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeOllama } from './fake-ollama.js';
import type { Harness } from './helpers.js';
import { count, drain, enableIndex, person, searchHarness, seedEmbeddings, settle, type Person } from './search-helpers.js';

/*
 * 1.9.0, Sprint 52 (B-171, B-172): search across chats and posts. Access is checked again for every result (a
 * conversation the reader left, a message hidden or raised above them since it was indexed, is not found); the chat
 * filters (who, conversation, group, dates, has a file or a link, label); keyword plus meaning; and for posts,
 * visibility, blocks, mutes and labels applied before counting, with the post filters (author, tag, group, list,
 * kind, dates).
 */

const C = '/api/messaging/conversations';
type Found = { items: { id: string; kind?: string; conversationId?: string; score?: { keyword: number | null; semantic: number | null } }[]; total: number; engine: string };
const ids = (r: Found) => r.items.map((x) => x.id);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('search across chats (B-171)', () => {
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
    await enableIndex(h);
  }, 60_000);
  afterEach(async () => {
    await h.close();
  });

  const say = async (who: Person, conv: string, body: string, extra: Record<string, unknown> = {}) => (await who.post(`${C}/${conv}/messages`, { body, ...extra }).expect(201)).body as { id: string };
  const find = async (who: Person, query: string) => (await who.get(`/api/search/messages?${query.includes('=') ? query : `q=${encodeURIComponent(query)}`}`).expect(200)).body as Found;

  it('checks access for every result: a conversation left, a message hidden, a label raised, a block, the join time', async () => {
    const early = (await alice.post(C, { kind: 'group', workspaceId: ws, title: 'Crit', memberIds: [bob.user.id] }).expect(201)).body as { id: string };
    const before = await say(alice, early.id, 'the walnut plan, before carol joined');
    await sleep(5);
    await alice.post(`${C}/${early.id}/members`, { userId: carol.user.id }).expect(201);
    await sleep(5);
    const m1 = await say(alice, early.id, 'walnut budget from alice');
    const m2 = await say(bob, early.id, 'walnut budget from bob');
    const direct = (await alice.post(C, { kind: 'direct', userId: carol.user.id }).expect(201)).body as { id: string };
    const d1 = await say(alice, direct.id, 'walnut in private');
    await settle(h);

    expect(ids(await find(carol, 'walnut')).sort()).toEqual([m1.id, m2.id, d1.id].sort());
    // bob is not in the direct conversation; carol joined after the first message
    expect(ids(await find(bob, 'walnut')).sort()).toEqual([before.id, m1.id, m2.id].sort());
    // a block takes the other person's messages out
    await carol.post('/api/social/blocks', { userId: bob.user.id }).expect(201);
    expect(ids(await find(carol, 'walnut')).sort()).toEqual([m1.id, d1.id].sort());
    await carol.del(`/api/social/blocks/${bob.user.id}`).expect(200);

    // hidden since it was indexed (nothing told the index): still left out, by the check on each result
    await h.s.db('dm_messages').where({ id: m2.id }).update({ state: 'hidden' });
    expect(ids(await find(carol, 'walnut')).sort()).toEqual([m1.id, d1.id].sort());
    // the conversation raised above carol's clearance: none of it
    await h.s.db('dm_conversations').where({ id: early.id }).update({ label: 'confidential' });
    expect(ids(await find(carol, 'walnut'))).toEqual([d1.id]);
    await h.s.db('dm_conversations').where({ id: early.id }).update({ label: 'internal' });
    // a conversation carol was removed from is not found, for her; the others still find it
    await alice.del(`${C}/${early.id}/members/${carol.user.id}`).expect(200);
    expect(ids(await find(carol, 'walnut'))).toEqual([d1.id]);
    expect(ids(await find(alice, 'walnut')).sort()).toEqual([before.id, m1.id, d1.id].sort());
    // nor through the one search box
    const box = (await carol.get('/api/search?q=walnut').expect(200)).body as { groups: { source: string; items: { id: string }[] }[] };
    expect(box.groups.find((g) => g.source === 'chats')!.items.map((x) => x.id)).toEqual([d1.id]);
    // and a message in someone else's conversation never answers, even by id in the query
    await bob.get(`/api/search/messages?q=walnut&conversation=${direct.id}`).expect(200).then((r) => expect((r.body as Found).items).toEqual([]));
  });

  it('filters by who, conversation, group, dates, file, link and label', async () => {
    const g1 = (await alice.post(C, { kind: 'group', workspaceId: ws, title: 'One', memberIds: [bob.user.id, carol.user.id] }).expect(201)).body as { id: string };
    const conf = await person(h, 'dora', [ws], { clearance: 'confidential' });
    const g2 = (await alice.post(C, { kind: 'group', workspaceId: ws, title: 'Two', memberIds: [bob.user.id, conf.user.id] }).expect(201)).body as { id: string };
    const a1 = await say(alice, g1.id, 'pumpkin soup recipe');
    await sleep(15);
    const cut = Date.now();
    await sleep(15);
    const b1 = await say(bob, g1.id, 'pumpkin pie, see https://example.com/pie');
    const b2 = await say(bob, g2.id, 'pumpkin carving');
    // a file in the message
    const up = await bob.agent.put(`/api/files/uploads?${new URLSearchParams({ name: 'pumpkin.txt', workspace: ws }).toString()}`).set('x-csrf-token', bob.csrf).set('content-type', 'application/octet-stream').send(Buffer.from('a pumpkin file'));
    expect(up.status).toBe(202);
    await drain(h);
    const withFile = await say(bob, g1.id, 'pumpkin sheet attached', { attachments: [up.body.id] });
    // a confidential conversation
    const conf2 = await person(h, 'ezra', [ws], { clearance: 'confidential' });
    const club = (await conf.post(C, { kind: 'group', workspaceId: ws, title: 'Secret', memberIds: [conf2.user.id], label: 'confidential' }).expect(201)).body as { id: string; label: string };
    expect(club.label).toBe('confidential');
    const c1 = await say(conf, club.id, 'pumpkin numbers');
    // a group's linked conversation
    const grp = (await alice.post('/api/groups', { workspaceId: ws, name: 'Gardeners', joinMode: 'open', visibility: 'public' }).expect(201)).body as { id: string };
    await bob.post(`/api/groups/${grp.id}/join`).expect(200);
    const linked = (await alice.put(`/api/groups/${grp.id}/conversation`, {}).expect(201)).body as { conversationId: string };
    const l1 = await say(alice, linked.conversationId, 'pumpkin patch rota');
    await settle(h);

    const all = await find(bob, 'pumpkin');
    expect(all.engine).toBe('index');
    // bob's clearance is internal: the confidential conversation is not his to search
    expect(ids(all).sort()).toEqual([a1.id, b1.id, b2.id, withFile.id, l1.id].sort());
    expect(all.total).toBe(5);
    expect(ids(await find(bob, `q=pumpkin&from=${alice.user.id}`)).sort()).toEqual([a1.id, l1.id].sort());
    expect(ids(await find(bob, `q=pumpkin&conversation=${g2.id}`))).toEqual([b2.id]);
    expect(ids(await find(bob, `q=pumpkin&group=${grp.id}`))).toEqual([l1.id]);
    expect(ids(await find(bob, `q=pumpkin&before=${cut}&conversation=${g1.id}`))).toEqual([a1.id]);
    expect(ids(await find(bob, `q=pumpkin&after=${cut}&conversation=${g1.id}`)).sort()).toEqual([b1.id, withFile.id].sort());
    expect(ids(await find(bob, 'q=pumpkin&has=file'))).toEqual([withFile.id]);
    expect(ids(await find(bob, 'q=pumpkin&has=link'))).toEqual([b1.id]);
    expect(ids(await find(conf, 'q=pumpkin&label=confidential'))).toEqual([c1.id]);
    expect(ids(await find(conf, 'q=pumpkin&label=internal'))).toEqual([b2.id]);
    // dates as ISO days: today's messages are before the end of today
    const today = new Date().toISOString().slice(0, 10);
    expect((await find(bob, `q=pumpkin&before=${today}`)).total).toBe(5);
    await bob.get('/api/search/messages?q=pumpkin&after=tomorrowish').expect(400);
    await bob.get('/api/search/messages?q=pumpkin&has=photo').expect(400);
    // snippets come with the conversation's title as the reader sees it
    const one = (await bob.get(`/api/search/messages?q=carving`).expect(200)).body as { items: { id: string; conversation: { title: string }; snippet: string; route: string }[] };
    // the route opens the conversation at the message itself
    expect(one.items[0]).toMatchObject({ conversation: { title: 'Two' }, snippet: 'pumpkin carving', route: `messages?convo=${g2.id}&message=${one.items[0]!.id}` });
  });

  it('a member of nothing finds nothing, and the route needs messages:read', async () => {
    const loner = await person(h, 'loner', [ws]);
    expect((await find(loner, 'anything')).items).toEqual([]);
    // a curator reads knowledge only: no chats, no posts, and the box asks knowledge alone
    const curator = await person(h, 'kc', [ws], { roles: ['knowledge-curator'] });
    await curator.get('/api/search/messages?q=x').expect(403);
    await curator.get('/api/search/posts?q=x').expect(403);
    expect(((await curator.get('/api/search?q=x').expect(200)).body as { groups: { source: string }[] }).groups.map((g) => g.source)).toEqual(['knowledge']);
    // someone who may search no source at all is refused
    const reviewer = await person(h, 'fr', [ws], { roles: ['flag-reviewer'] });
    await reviewer.get('/api/search?q=x').expect(403);
    await reviewer.get('/api/search/suggest?q=x').expect(403);
  });
});

describe('keyword plus meaning (B-171)', () => {
  let h: Harness;
  let ollama: FakeOllama;

  beforeEach(async () => {
    ollama = await new FakeOllama().start();
    h = await searchHarness({ MESSAGING_EMBED_MODEL: 'nomic-embed-text' });
    await seedEmbeddings(h, ollama);
  }, 60_000);
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  it('fuses the blind index with the message vectors, within the reader’s conversations only', async () => {
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Design', 'confidential')).id;
    const alice = await person(h, 'alice', [ws]);
    const bob = await person(h, 'bob', [ws]);
    const carol = await person(h, 'carol', [ws]);
    await enableIndex(h);
    const g = (await alice.post(C, { kind: 'group', workspaceId: ws, memberIds: [bob.user.id] }).expect(201)).body as { id: string };
    const other = (await alice.post(C, { kind: 'group', workspaceId: ws, memberIds: [carol.user.id] }).expect(201)).body as { id: string };
    const budget = (await alice.post(`${C}/${g.id}/messages`, { body: 'Budget review for the printing costs' }).expect(201)).body as { id: string };
    const lunch = (await alice.post(`${C}/${g.id}/messages`, { body: 'Lunch at noon tomorrow' }).expect(201)).body as { id: string };
    const elsewhere = (await alice.post(`${C}/${other.id}/messages`, { body: 'Printing costs budget, for carol only' }).expect(201)).body as { id: string };
    await settle(h);
    expect(await count(h, 'vectors', { collection: 'dm-messages' })).toBe(3);

    const kw = (await bob.get('/api/search/messages?q=printing&mode=keyword').expect(200)).body as Found;
    expect(ids(kw)).toEqual([budget.id]);
    expect(kw.items[0]!.score).toMatchObject({ semantic: null });
    const sem = (await bob.get('/api/search/messages?q=printing costs budget&mode=semantic').expect(200)).body as Found;
    expect(sem.items[0]!.id).toBe(budget.id);
    expect(ids(sem)).not.toContain(elsewhere.id);
    const hybrid = (await bob.get('/api/search/messages?q=printing').expect(200)).body as Found & { mode: string };
    expect(hybrid.mode).toBe('hybrid');
    expect(hybrid.items[0]!.id).toBe(budget.id);
    expect(hybrid.items[0]!.score!.keyword).not.toBeNull();
    expect(hybrid.items[0]!.score!.semantic).not.toBeNull();
    // meaning can find what no word matched (in the reader's conversations), never in another's
    expect(ids(hybrid)).toContain(lunch.id);
    expect(ids(hybrid)).not.toContain(elsewhere.id);
  });
});

describe('full-text post search (B-172)', () => {
  let h: Harness;
  let ws: string;
  let alice: Person;
  let bob: Person;
  let carol: Person;
  let dave: Person;
  let erin: Person;

  beforeEach(async () => {
    h = await searchHarness();
    ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Farm', 'confidential')).id;
    alice = await person(h, 'alice', [ws]);
    bob = await person(h, 'bob', [ws]);
    carol = await person(h, 'carol', [ws]);
    dave = await person(h, 'dave', [ws]);
    erin = await person(h, 'erin', [ws], { clearance: 'confidential' });
    await enableIndex(h);
  }, 60_000);
  afterEach(async () => {
    await h.close();
  });

  const post = async (who: Person, body: string, extra: Record<string, unknown> = {}) => (await who.post('/api/feed/posts', { workspaceId: ws, body, ...extra }).expect(201)).body as { id: string; label: string };
  const find = async (who: Person, q: string) => (await who.get(`/api/search/posts?${q.includes('=') ? q : `q=${encodeURIComponent(q)}`}`).expect(200)).body as Found;

  it('applies visibility, blocks, mutes and labels before counting', async () => {
    const pa = await post(alice, 'orchard harvest #apples');
    const pb = await post(bob, 'orchard pruning');
    const pd = await post(dave, 'orchard irrigation');
    const pe = await post(erin, 'orchard secrets', { label: 'confidential' });
    expect(pe.label).toBe('confidential');
    const pu = await post(alice, 'orchard unlisted notes', { visibility: 'unlisted' });
    const cb = (await bob.post(`/api/feed/posts/${pa.id}/comments`, { body: 'orchard comment from bob' }).expect(201)).body as { id: string };
    await settle(h);

    const everything = await find(carol, 'orchard');
    expect(everything.engine).toBe('index');
    expect(ids(everything).sort()).toEqual([pa.id, pb.id, pd.id, cb.id].sort());
    expect(everything.total).toBe(4);
    // the unlisted post is its author's alone; the confidential one is above carol
    expect(ids(await find(alice, 'unlisted'))).toEqual([pu.id]);
    expect(ids(await find(carol, 'unlisted'))).toEqual([]);
    expect(ids(await find(erin, 'secrets'))).toEqual([pe.id]);
    expect(ids(await find(carol, 'secrets'))).toEqual([]);
    // a block (either way) removes bob's post and comment; a mute removes dave's
    await bob.post('/api/social/blocks', { userId: carol.user.id }).expect(201);
    await carol.post('/api/social/mutes', { userId: dave.user.id }).expect(201);
    const after = await find(carol, 'orchard');
    expect(ids(after)).toEqual([pa.id]);
    expect(after.total).toBe(1);
    // the one search box agrees
    const box = (await carol.get('/api/search?q=orchard&sources=posts').expect(200)).body as { groups: { source: string; items: { id: string }[]; total: number }[] };
    expect(box.groups).toHaveLength(1);
    expect(box.groups[0]).toMatchObject({ source: 'posts', total: 1 });
    // hidden by moderation since it was indexed: checked again, not found
    await h.s.db('feed_posts').where({ id: pa.id }).update({ state: 'hidden' });
    expect(ids(await find(carol, 'orchard'))).toEqual([]);
  });

  it('searches groups, phrases, authors, tags, lists, kinds and dates', async () => {
    const club = (await alice.post('/api/groups', { workspaceId: ws, name: 'Beekeepers', joinMode: 'open', visibility: 'private' }).expect(201)).body as { id: string };
    await bob.post(`/api/groups/${club.id}/join`).expect(200);
    const gp = await post(alice, 'honey harvest in the club', { groupId: club.id });
    await sleep(15);
    const cut = Date.now();
    await sleep(15);
    const p1 = await post(bob, 'the honey harvest begins #honey');
    const p2 = await post(dave, 'harvest the honey later');
    const c1 = (await carol.post(`/api/feed/posts/${p1.id}/comments`, { body: 'honey for everyone' }).expect(201)).body as { id: string };
    await settle(h);

    // the group's post is for its readers
    expect((await carol.get(`/api/search/posts?q=honey&group=${club.id}`)).status).not.toBe(200);
    expect(ids(await find(carol, 'honey'))).not.toContain(gp.id);
    expect(ids(await find(alice, `q=honey&group=${club.id}`))).toEqual([gp.id]);
    expect(ids(await find(bob, 'honey'))).toContain(gp.id);
    // a phrase by position
    expect(ids(await find(carol, '"honey harvest"'))).toEqual([p1.id]);
    expect(ids(await find(carol, 'harvest honey')).sort()).toEqual([p1.id, p2.id].sort());
    // author, tag, kind, dates
    expect(ids(await find(carol, `q=honey&author=${dave.user.id}`))).toEqual([p2.id]);
    expect(ids(await find(carol, 'q=honey&tag=%23Honey')).sort()).toEqual([p1.id, c1.id].sort());
    expect(ids(await find(carol, 'q=honey&kind=comment'))).toEqual([c1.id]);
    expect(ids(await find(alice, `q=honey&before=${cut}`))).toEqual([gp.id]);
    expect(ids(await find(alice, `q=harvest&after=${cut}&kind=post`)).sort()).toEqual([p1.id, p2.id].sort());
    // a list: the people on it
    const list = (await carol.post('/api/social/lists', { name: 'Keepers' }).expect(201)).body as { id: string };
    await carol.post(`/api/social/lists/${list.id}/members`, { userId: dave.user.id }).expect(201);
    expect(ids(await find(carol, `q=honey&list=${list.id}`))).toEqual([p2.id]);
    await bob.get(`/api/search/posts?q=honey&list=${list.id}`).expect(404);
    // results carry the post's tags and a link to it
    const one = (await carol.get('/api/search/posts?q=begins').expect(200)).body as { items: { tags: string[]; route: string; snippet: string }[] };
    expect(one.items[0]).toMatchObject({ tags: ['honey'], route: `messages?post=${p1.id}`, snippet: 'the honey harvest begins #honey' });
  });

  it('before the index is built, the newest posts in scope are matched the old way', async () => {
    await h.s.search.index.purgeTenant(h.tenantId);
    const p = await post(alice, 'meadow flowers in bloom');
    await bob.post('/api/social/blocks', { userId: alice.user.id }).expect(201);
    await settle(h);
    const r = (await carol.get('/api/search/posts?q=meadow').expect(200)).body as Found & { partial: boolean };
    expect(r).toMatchObject({ engine: 'fallback', partial: false });
    expect(ids(r)).toEqual([p.id]);
    expect(ids(await find(bob, 'meadow'))).toEqual([]);
    expect(await count(h, 'search_postings')).toBe(0);
  });
});
