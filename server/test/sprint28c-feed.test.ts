import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../src/feed/service.js';
import { extractTags, normaliseTag } from '../src/feed/tags.js';
import { weekStartOf } from '../src/feed/digest.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { TOPICS, type IntegrationEvent } from '../src/platform/bus.js';
import { attachRealtime } from '../src/realtime/socket.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';
import { drain } from './retrieval-seed.js';
import { seedGateway } from './seed-gateway.js';

/*
 * Sprint 28c, the workspace feed (B-2701 to B-2705), on the shared social relations (B-2606, B-2702). The "done when"
 * of each item is a test below:
 *   B-2701 a comment on a deleted post is refused;         B-2702 a muted author's posts leave the home feed;
 *   B-2703 a new post reaches open feeds without a reload; B-2704 a held post is invisible until approved;
 *   B-2705 the digest lists the week's top posts;          B-2606 a block in messaging also hides posts.
 */

type Person = Awaited<ReturnType<typeof personIn>>;

async function personIn(h: Harness, name: string, workspaces: string[], roles: string[] = ['member'], clearance: 'public' | 'internal' | 'confidential' = 'internal') {
  const user = await localUser(h, name, roles, clearance);
  for (const w of workspaces) await h.s.tenants.addMember(w, user.id);
  const c = await login(h, name);
  const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
  return {
    user,
    ...c,
    post: (p: string, b?: object) => send('post', p, b),
    put: (p: string, b?: object) => send('put', p, b),
    patch: (p: string, b?: object) => send('patch', p, b),
    del: (p: string) => send('delete', p),
    get: (p: string) => c.agent.get(p),
    upload: (ws: string, name: string, data: string) =>
      c.agent
        .put(`/api/files/uploads?${new URLSearchParams({ name, workspace: ws }).toString()}`)
        .set('x-csrf-token', c.csrf)
        .set('content-type', 'application/octet-stream')
        .send(Buffer.from(data)),
    principal: async () => (await loadPrincipal(h.s, h.tenantId, user.id, {}))!
  };
}

const ids = (page: { items: { id: string }[] }) => page.items.map((x) => x.id);
const send = (c: Client, method: 'post' | 'put', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);

describe('hashtags and cursors', () => {
  it('extracts tags in any script, once each, and not from words or numbers', () => {
    expect(extractTags('Ship it #Launch #launch #Q3 and #café, not a#b, &#38; or #2026; #日本語 #under_score.')).toEqual(['launch', 'q3', 'café', '日本語', 'under_score']);
    expect(extractTags('#a '.repeat(30) + Array.from({ length: 30 }, (_, i) => `#t${i}`).join(' '))).toHaveLength(20);
    expect(normaliseTag('#CAFÉ')).toBe('café');
    expect(normaliseTag('#12')).toBeNull();
    expect(normaliseTag('x'.repeat(65))).toBeNull();
  });

  it('round-trips cursors and refuses forged ones', () => {
    const c = encodeCursor(1_700_000_000_000, '01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(decodeCursor(c)).toEqual({ t: 1_700_000_000_000, id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' });
    expect(() => decodeCursor(Buffer.from("1' OR 1=1").toString('base64url'))).toThrow(/cursor/);
    expect(weekStartOf(Date.parse('2026-10-08T15:00:00Z'))).toBe(Date.parse('2026-10-05T00:00:00Z'));
    expect(weekStartOf(Date.parse('2026-10-05T00:00:00Z'))).toBe(Date.parse('2026-10-05T00:00:00Z'));
  });
});

describe('the workspace feed (Sprint 28c)', () => {
  let h: Harness;
  let ws: string;
  let other: string;
  let alice: Person;
  let bob: Person;
  let carol: Person;
  let dave: Person;

  beforeEach(async () => {
    h = await harness();
    ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Design', 'confidential')).id;
    other = (await h.s.tenants.createWorkspace(h.tenantId, 'Legal', 'confidential')).id;
    alice = await personIn(h, 'alice', [ws, other]);
    bob = await personIn(h, 'bob', [ws]);
    carol = await personIn(h, 'carol', [ws]);
    dave = await personIn(h, 'dave', [other]);
  }, 60_000);
  afterEach(async () => {
    await h.close();
  });

  it('B-2701: posts with media, threaded comments, reactions, reposts and bookmarks, sealed; a comment on a deleted post is refused', async () => {
    const events: IntegrationEvent[] = [];
    h.s.bus.on<IntegrationEvent>(TOPICS.integrationEvent, (e) => void events.push(e));
    const file = (await alice.upload(ws, 'brief.txt', 'The launch brief').expect(202)).body;
    const elsewhere = (await alice.upload(other, 'contract.txt', 'Terms').expect(202)).body;
    // still in quarantine
    await alice.post('/api/feed/posts', { workspaceId: ws, body: 'Too early', media: [file.id] }).expect(409);
    await drain(h);
    const post = (await alice.post('/api/feed/posts', { workspaceId: ws, body: 'Launch notes are up #Launch #q3', media: [file.id] }).expect(201)).body;
    expect(post).toMatchObject({ state: 'published', label: 'internal', body: 'Launch notes are up #Launch #q3', tags: ['launch', 'q3'], author: { id: alice.user.id, username: 'alice' } });
    expect(post.media).toEqual([expect.objectContaining({ fileId: file.id, name: 'brief.txt', available: true })]);
    await alice.post('/api/feed/posts', { workspaceId: ws, body: 'x', media: [elsewhere.id] }).expect(422);
    await alice.post('/api/feed/posts', { workspaceId: ws }).expect(422);
    await alice.post('/api/feed/posts', { workspaceId: ws, body: 'too high', label: 'restricted' }).expect(422);
    await dave.post('/api/feed/posts', { workspaceId: ws, body: 'not my workspace' }).expect(404);
    // sealed at rest
    const raw = await h.s.db('feed_posts').where({ id: post.id }).first();
    expect(raw.body).not.toContain('Launch notes');

    const c1 = (await bob.post(`/api/feed/posts/${post.id}/comments`, { body: 'Great, reading now' }).expect(201)).body;
    const c2 = (await alice.post(`/api/feed/posts/${post.id}/comments`, { body: 'Thanks', parentId: c1.id }).expect(201)).body;
    await carol.post(`/api/feed/posts/${post.id}/comments`, { body: 'x', parentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }).expect(404);
    const thread = (await carol.get(`/api/feed/posts/${post.id}/comments`).expect(200)).body;
    expect(thread.items.map((c: { id: string; parentId: string | null; body: string }) => [c.id, c.parentId, c.body])).toEqual([
      [c1.id, null, 'Great, reading now'],
      [c2.id, c1.id, 'Thanks']
    ]);
    expect((await h.s.db('feed_comments').where({ id: c1.id }).first()).body).not.toContain('reading');

    expect((await bob.put(`/api/feed/posts/${post.id}/reactions/like`).expect(201)).body.added).toBe(true);
    expect((await bob.put(`/api/feed/posts/${post.id}/reactions/like`).expect(200)).body.added).toBe(false);
    await carol.put(`/api/feed/posts/${post.id}/reactions/celebrate`).expect(201);
    await carol.put(`/api/feed/posts/${post.id}/reactions/angry`).expect(400);
    const plain = (await bob.post(`/api/feed/posts/${post.id}/repost`).expect(201)).body;
    expect(plain).toMatchObject({ repostOf: post.id, body: null, label: 'internal', original: expect.objectContaining({ id: post.id }) });
    expect((await bob.post(`/api/feed/posts/${post.id}/repost`).expect(200)).body.id).toBe(plain.id);
    // a plain repost of a plain repost reposts the original
    expect((await carol.post(`/api/feed/posts/${plain.id}/repost`).expect(201)).body.repostOf).toBe(post.id);
    await bob.post(`/api/feed/posts/${post.id}/repost`, { body: 'Worth reading' }).expect(201);
    await bob.put(`/api/feed/posts/${post.id}/bookmark`).expect(201);
    expect(ids((await bob.get('/api/feed/bookmarks').expect(200)).body)).toEqual([post.id]);

    const seen = (await bob.get(`/api/feed/posts/${post.id}`).expect(200)).body;
    expect(seen.counts).toEqual({ comments: 2, reposts: 3, quotes: 0, reactions: { like: 1, celebrate: 1 } });
    expect(seen.mine).toEqual({ reactions: ['like'], bookmarked: true, reposted: true });
    await bob.del(`/api/feed/posts/${post.id}/reactions/like`).expect(200);
    await bob.del(`/api/feed/posts/${post.id}/repost`).expect(200);
    await bob.del(`/api/feed/posts/${post.id}/repost`).expect(404);

    // edits are the author's, checked again, and re-tag the post
    await bob.patch(`/api/feed/posts/${post.id}`, { body: 'mine now' }).expect(403);
    const edited = (await alice.patch(`/api/feed/posts/${post.id}`, { body: 'Launch notes, final #launch' }).expect(200)).body;
    expect(edited).toMatchObject({ tags: ['launch'], editedAt: expect.any(Number) });
    // comments can be removed by the post's author
    await carol.del(`/api/feed/comments/${c1.id}`).expect(403);
    await alice.del(`/api/feed/comments/${c1.id}`).expect(200);

    await bob.del(`/api/feed/posts/${post.id}`).expect(403);
    await alice.del(`/api/feed/posts/${post.id}`).expect(200);
    // the done-when: a comment on a deleted post is refused (and so are reactions and reposts)
    const refused = await bob.post(`/api/feed/posts/${post.id}/comments`, { body: 'Still here?' }).expect(409);
    expect(refused.headers['content-type']).toMatch(/problem\+json/);
    expect(refused.body.detail).toMatch(/deleted/);
    await bob.put(`/api/feed/posts/${post.id}/reactions/like`).expect(409);
    await bob.post(`/api/feed/posts/${post.id}/repost`).expect(409);
    await bob.get(`/api/feed/posts/${post.id}`).expect(404);
    expect(ids((await bob.get('/api/feed/bookmarks').expect(200)).body)).toEqual([]);
    expect(await h.s.db('feed_comments').where({ post_id: post.id }).count({ n: '*' }).then((r) => Number((r as { n: number }[])[0]!.n))).toBe(2);

    const actions = (await h.s.db('audit_events').where('action', 'like', 'feed.%').select('action')).map((r: { action: string }) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['feed.post.created', 'feed.comment.created', 'feed.reaction.added', 'feed.reaction.removed', 'feed.bookmark.added', 'feed.post.updated', 'feed.comment.deleted', 'feed.post.deleted']));
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['post.created', 'post.updated', 'post.deleted']));
    expect(JSON.stringify(events.filter((e) => e.type.startsWith('post.')))).not.toContain('Launch notes');
  });

  it('B-2702 and B-2606: a muted author leaves the home feed; a block in messaging also hides posts, both ways', async () => {
    await carol.post('/api/social/following', { userId: alice.user.id }).expect(201);
    await carol.post('/api/social/following', { userId: bob.user.id }).expect(201);
    const a = (await alice.post('/api/feed/posts', { workspaceId: ws, body: 'From alice' }).expect(201)).body;
    const b = (await bob.post('/api/feed/posts', { workspaceId: ws, body: 'From bob' }).expect(201)).body;
    const d = (await dave.post('/api/feed/posts', { workspaceId: other, body: 'From dave' }).expect(201)).body;
    const c = (await carol.post('/api/feed/posts', { workspaceId: ws, body: 'From carol' }).expect(201)).body;
    expect(ids((await carol.get('/api/feed/home').expect(200)).body)).toEqual([c.id, b.id, a.id]);
    // alice is in both workspaces; carol only sees Design
    expect(ids((await alice.get('/api/feed/home').expect(200)).body)).toEqual([a.id]);
    expect(ids((await carol.get(`/api/feed/workspaces/${ws}`).expect(200)).body)).toEqual([c.id, b.id, a.id]);
    await carol.get(`/api/feed/workspaces/${other}`).expect(404);
    await carol.get(`/api/feed/posts/${d.id}`).expect(404);

    // the done-when: a mute takes bob out of carol's home feed only
    await carol.post('/api/social/mutes', { userId: bob.user.id }).expect(201);
    expect(ids((await carol.get('/api/feed/home').expect(200)).body)).toEqual([c.id, a.id]);
    expect(ids((await carol.get(`/api/feed/workspaces/${ws}`).expect(200)).body)).toEqual([c.id, b.id, a.id]);
    // lists: carol's list of bob still shows bob (a list is asked for by name)
    const list = (await carol.post('/api/social/lists', { name: 'Studio' }).expect(201)).body;
    await carol.post(`/api/social/lists/${list.id}/members`, { userId: bob.user.id }).expect(201);
    expect(ids((await carol.get(`/api/feed/lists/${list.id}`).expect(200)).body)).toEqual([b.id]);
    await bob.get(`/api/feed/lists/${list.id}`).expect(404);

    // B-2606: alice blocks carol through the shared relations messaging uses; the feed hides posts both ways
    await alice.post('/api/social/blocks', { userId: carol.user.id }).expect(201);
    expect(await h.s.social.isBlocked(h.tenantId, carol.user.id, alice.user.id)).toBe(true);
    expect(ids((await carol.get(`/api/feed/workspaces/${ws}`).expect(200)).body)).toEqual([c.id, b.id]);
    expect(ids((await alice.get(`/api/feed/workspaces/${ws}`).expect(200)).body)).toEqual([b.id, a.id]);
    expect(ids((await carol.get('/api/feed/home').expect(200)).body)).toEqual([c.id]);
    await carol.get(`/api/feed/posts/${a.id}`).expect(404);
    await alice.get(`/api/feed/posts/${c.id}`).expect(404);
    await carol.get(`/api/feed/users/${alice.user.id}`).expect(404);
    await carol.post(`/api/feed/posts/${a.id}/comments`, { body: 'hi' }).expect(404);
    await carol.put(`/api/feed/posts/${a.id}/reactions/like`).expect(404);
    await carol.post(`/api/feed/posts/${a.id}/repost`).expect(404);
    // bob's repost of alice's post shows carol the repost without the original
    const rp = (await bob.post(`/api/feed/posts/${a.id}/repost`, { body: 'Look' }).expect(201)).body;
    expect((await carol.get(`/api/feed/posts/${rp.id}`).expect(200)).body.original).toBeNull();
    // and alice's comments vanish from what carol reads
    await bob.post(`/api/feed/posts/${b.id}/comments`, { body: 'bob here' }).expect(201);
    await alice.post(`/api/feed/posts/${b.id}/comments`, { body: 'alice here' }).expect(201);
    expect((await carol.get(`/api/feed/posts/${b.id}/comments`).expect(200)).body.items.map((x: { body: string }) => x.body)).toEqual(['bob here']);
    // unblocked: back
    await alice.del(`/api/social/blocks/${carol.user.id}`).expect(200);
    expect(ids((await carol.get(`/api/feed/workspaces/${ws}`).expect(200)).body)).toContain(a.id);
    // user feeds: only people sharing a workspace
    expect(ids((await alice.get(`/api/feed/users/${dave.user.id}`).expect(200)).body)).toEqual([d.id]);
    await carol.get(`/api/feed/users/${dave.user.id}`).expect(404);
  });

  it('B-2703: cursor pagination, group feeds, and permissions', async () => {
    const made: string[] = [];
    for (let i = 0; i < 5; i++) made.push((await alice.post('/api/feed/posts', { workspaceId: ws, body: `Post ${i}` }).expect(201)).body.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = (await bob.get(`/api/feed/workspaces/${ws}?limit=2${cursor ? `&cursor=${cursor}` : ''}`).expect(200)).body as { items: { id: string }[]; nextCursor: string | null };
      seen.push(...ids(res));
      cursor = res.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual([...made].reverse());
    await bob.get(`/api/feed/workspaces/${ws}?cursor=bogus`).expect(400);

    // group feeds: feed posts targeted at a group, with the group's rights
    const g = (await alice.post('/api/groups', { workspaceId: ws, name: 'Crit', visibility: 'private', joinMode: 'open' }).expect(201)).body;
    await bob.post('/api/feed/posts', { groupId: g.id, body: 'not a member' }).expect(403);
    await bob.post(`/api/groups/${g.id}/join`).expect(200);
    const gp = (await bob.post('/api/feed/posts', { groupId: g.id, body: 'In the group #crit' }).expect(201)).body;
    expect(gp).toMatchObject({ groupId: g.id, workspaceId: ws });
    expect(ids((await alice.get(`/api/feed/groups/${g.id}`).expect(200)).body)).toEqual([gp.id]);
    // a private group's posts stay out of the workspace feed and away from non-members
    expect(ids((await carol.get(`/api/feed/workspaces/${ws}`).expect(200)).body)).not.toContain(gp.id);
    await carol.get(`/api/feed/groups/${g.id}`).expect(403);
    await carol.get(`/api/feed/posts/${gp.id}`).expect(404);
    // group notices (Sprint 27) stay where they are
    await alice.post(`/api/groups/${g.id}/posts`, { body: 'Notice' }).expect(201);
    expect(ids((await alice.get(`/api/feed/groups/${g.id}`).expect(200)).body)).toEqual([gp.id]);
    // a moderator of the group removes posts in it
    await alice.del(`/api/feed/posts/${gp.id}`).expect(200);

    // permissions
    await h.s.users.setRoles(carol.user.id, 'direct', ['flag-reviewer']);
    const c2 = await login(h, 'carol');
    await c2.agent.get('/api/feed/home').expect(403);
    await bob.get(`/api/feed/workspaces/${ws}/settings`).expect(403);
    await bob.post(`/api/feed/workspaces/${ws}/digest`, {}).expect(403);
  });

  it('posts are moderation objects: a report makes a flag; a hidden post leaves the feeds', async () => {
    const a = (await alice.post('/api/feed/posts', { workspaceId: ws, body: 'Questionable' }).expect(201)).body;
    const c = (await alice.post(`/api/feed/posts/${a.id}/comments`, { body: 'Also questionable' }).expect(201)).body;
    const rep = (await bob.post('/api/moderation/reports', { type: 'feed-post', id: a.id, reason: 'spam' }).expect(201)).body;
    expect(rep.flag.ref).toMatch(/^F-\d+$/);
    await bob.post('/api/moderation/reports', { type: 'feed-comment', id: c.id, reason: 'spam' }).expect(201);
    await dave.post('/api/moderation/reports', { type: 'feed-post', id: a.id, reason: 'spam' }).expect(404);
    const handler = h.s.moderation.registry.get('feed-post')!;
    const o = (await handler.resolve(h.tenantId, a.id))!;
    expect(await handler.hide!(o)).toBe('published');
    expect(ids((await bob.get(`/api/feed/workspaces/${ws}`).expect(200)).body)).toEqual([]);
    await bob.get(`/api/feed/posts/${a.id}`).expect(404);
    expect(await handler.restore!({ ...o, state: 'hidden' }, 'published')).toBe(true);
    expect(ids((await bob.get(`/api/feed/workspaces/${ws}`).expect(200)).body)).toEqual([a.id]);
  });
});

describe('held posts (B-2704)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  }, 60_000);
  afterEach(async () => {
    await h.close();
  });

  it('a held post is invisible until approved; a rejected one stays invisible', async () => {
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Finance', 'confidential')).id;
    const alice = await personIn(h, 'alice', [ws]);
    const bob = await personIn(h, 'bob', [ws]);
    await bob.post('/api/social/following', { userId: alice.user.id }).expect(201);
    const gaUser = await localUser(h, 'ga', ['guardrail-admin'], 'confidential');
    await h.s.tenants.addMember(ws, gaUser.id);
    const ga = await loginAdmin(h, 'ga');
    const set = (await send(ga, 'post', '/api/admin/guardrails/sets', { name: 'Feed rules', scope: 'tenant' }).expect(201)).body;
    await send(ga, 'put', `/api/admin/guardrails/sets/${set.id}/draft`, { rules: [{ id: 'wire', name: 'Wire transfers', checkpoint: 'user-input', type: 'pattern', mechanism: { kind: 'pattern', pattern: '(?i)wire transfer' }, action: 'require-approval', stage: 'enforce' }] }).expect(200);
    await send(ga, 'post', `/api/admin/guardrails/sets/${set.id}/draft/publish`).expect(200);
    const events: IntegrationEvent[] = [];
    h.s.bus.on<IntegrationEvent>(TOPICS.integrationEvent, (e) => void events.push(e));

    const held = await alice.post('/api/feed/posts', { workspaceId: ws, body: 'Please approve the wire transfer #ops' }).expect(202);
    expect(held.body).toMatchObject({ state: 'held', body: 'Please approve the wire transfer #ops', tags: [] });
    const id = held.body.id as string;
    // invisible to everyone but its author, in every feed
    await bob.get(`/api/feed/posts/${id}`).expect(404);
    expect(ids((await bob.get(`/api/feed/workspaces/${ws}`).expect(200)).body)).toEqual([]);
    expect(ids((await bob.get('/api/feed/home').expect(200)).body)).toEqual([]);
    expect(ids((await alice.get('/api/feed/home').expect(200)).body)).toEqual([]);
    expect((await alice.get(`/api/feed/posts/${id}`).expect(200)).body.state).toBe('held');
    await bob.post(`/api/feed/posts/${id}/comments`, { body: 'x' }).expect(404);
    await alice.post(`/api/feed/posts/${id}/comments`, { body: 'x' }).expect(409);
    expect(events.find((e) => e.type === 'post.held')?.data).toMatchObject({ post: id, flag: expect.stringMatching(/^F-\d+$/) });

    const item = (await ga.agent.get('/api/flags').expect(200)).body.items.find((f: { kind: string; checkpoint: string }) => f.kind === 'hold' && f.checkpoint === 'user-input');
    expect(item).toMatchObject({ action: 'require-approval', rule: 'Wire transfers' });
    await send(ga, 'post', `/api/flags/${item.ref}/decide`, { decision: 'approved' }).expect(200);
    const seen = (await bob.get(`/api/feed/posts/${id}`).expect(200)).body;
    expect(seen).toMatchObject({ state: 'published', body: 'Please approve the wire transfer #ops', tags: ['ops'] });
    expect(ids((await bob.get('/api/feed/home').expect(200)).body)).toEqual([id]);
    expect(events.filter((e) => e.type === 'post.created').map((e) => e.data.post)).toEqual([id]);
    expect(await h.s.db('audit_events').where({ action: 'feed.post.approved' }).first()).toBeTruthy();
    expect(JSON.stringify((await alice.get('/api/me/notifications').expect(200)).body)).toMatch(/approved and published/);

    const second = (await alice.post('/api/feed/posts', { workspaceId: ws, body: 'Another wire transfer' }).expect(202)).body;
    const item2 = (await ga.agent.get('/api/flags').expect(200)).body.items.find((f: { kind: string; state: string }) => f.kind === 'hold' && f.state === 'open');
    await send(ga, 'post', `/api/flags/${item2.ref}/decide`, { decision: 'rejected', reason: 'Not here' }).expect(200);
    await bob.get(`/api/feed/posts/${second.id}`).expect(404);
    expect((await alice.get(`/api/feed/posts/${second.id}`).expect(200)).body.state).toBe('rejected');
    // edits and comments do not wait for review: refused
    await alice.patch(`/api/feed/posts/${id}`, { body: 'A wire transfer again' }).expect(422);
    await bob.post(`/api/feed/posts/${id}/comments`, { body: 'wire transfer?' }).expect(422);
  });
});

describe('live feeds (B-2703 with B-2101)', () => {
  let h: Harness;
  let server: Server;
  let url: string;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    h = await harness();
    server = createServer(h.app);
    attachRealtime(server, h.s);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    for (const x of sockets.splice(0)) x.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await h.close();
  });

  const until = async (fn: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!fn()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  async function connect(m: Person) {
    const sock = ioClient(url, { path: '/socket.io', transports: ['websocket'], reconnection: false, extraHeaders: { cookie: m.cookie } });
    sockets.push(sock);
    await new Promise((r) => sock.on('ready', r));
    const got: { event: string; data: Record<string, unknown> }[] = [];
    sock.onAny((event: string, data: Record<string, unknown>) => void got.push({ event, data }));
    const join = (id: string) => new Promise<{ ok: boolean }>((r) => sock.emit('room.join', { kind: 'feed', id }, r));
    return { sock, got, join };
  }

  it('a new post reaches open workspace and home feeds without a reload, never people in a block or outside', async () => {
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Design', 'confidential')).id;
    const other = (await h.s.tenants.createWorkspace(h.tenantId, 'Legal', 'internal')).id;
    const alice = await personIn(h, 'alice', [ws]);
    const bob = await personIn(h, 'bob', [ws]);
    const carol = await personIn(h, 'carol', [ws]);
    const eve = await personIn(h, 'eve', [other]);
    const pat = await personIn(h, 'pat', [ws]);
    // a sign-in takes the clearance from the store's mappings (internal here); pat is cleared for public only
    await h.s.db('users').where({ id: pat.user.id }).update({ clearance: 'public' });
    await bob.post('/api/social/following', { userId: alice.user.id }).expect(201);
    await carol.post('/api/social/blocks', { userId: alice.user.id }).expect(201);
    const [b, c, e, p] = [await connect(bob), await connect(carol), await connect(eve), await connect(pat)];
    expect(await b.join(ws)).toMatchObject({ ok: true });
    expect(await b.join(bob.user.id)).toMatchObject({ ok: true });
    expect(await c.join(ws)).toMatchObject({ ok: true });
    expect(await p.join(ws)).toMatchObject({ ok: true });
    expect(await e.join(ws)).toMatchObject({ ok: false });
    // someone else's home room is nobody else's
    expect(await e.join(bob.user.id)).toMatchObject({ ok: false });

    const post = (await alice.post('/api/feed/posts', { workspaceId: ws, body: 'Fresh' }).expect(201)).body;
    await until(() => b.got.filter((x) => x.event === 'feed.post.created').length === 2);
    const got = b.got.filter((x) => x.event === 'feed.post.created').map((x) => x.data);
    expect(got).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'feed', id: ws, postId: post.id, authorId: alice.user.id }), expect.objectContaining({ kind: 'feed', id: bob.user.id, postId: post.id, feed: 'home' })]));
    // ids only, never the text; the reader fetches the post through the API
    expect(JSON.stringify(b.got)).not.toContain('Fresh');
    expect((await bob.get(`/api/feed/posts/${post.id}`).expect(200)).body.body).toBe('Fresh');
    await pat.get(`/api/feed/posts/${post.id}`).expect(404);
    // a comment reaches the room too
    await bob.post(`/api/feed/posts/${post.id}/comments`, { body: 'Nice' }).expect(201);
    await new Promise((r) => setTimeout(r, 100));
    // carol blocked alice; pat is below the post's label (internal); eve is outside the workspace
    expect(c.got.some((x) => x.event.startsWith('feed.post'))).toBe(false);
    expect(p.got.some((x) => x.event.startsWith('feed.'))).toBe(false);
    expect(e.got.some((x) => x.event.startsWith('feed.'))).toBe(false);
    expect(c.got.some((x) => x.event === 'feed.comment.created')).toBe(true);
    // a public post reaches pat
    await alice.post('/api/feed/posts', { workspaceId: ws, body: 'For everyone', label: 'public' }).expect(201);
    await until(() => p.got.some((x) => x.event === 'feed.post.created'));
  });
});

describe('trending tags and the weekly digest (B-2705)', () => {
  let h: Harness;
  let ollama: FakeOllama;
  beforeEach(async () => {
    ollama = await new FakeOllama().start();
    h = await harness({ FEED_DIGEST_PROFILE: 'general', FEED_DIGEST_TOP: '2' });
  }, 60_000);
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  it('counts tags by job within each reader’s clearance; the digest lists the week’s top posts, written by a profile', async () => {
    await seedGateway(h, ollama);
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Studio', 'confidential')).id;
    const alice = await personIn(h, 'alice', [ws]);
    const bob = await personIn(h, 'bob', [ws]);
    const cleo = await personIn(h, 'cleo', [ws], ['member'], 'confidential');
    const quiet = (await alice.post('/api/feed/posts', { workspaceId: ws, body: 'A quiet note #design' }).expect(201)).body;
    const top = (await bob.post('/api/feed/posts', { workspaceId: ws, body: 'New type scale shipped #design #Type' }).expect(201)).body;
    const second = (await alice.post('/api/feed/posts', { workspaceId: ws, body: 'Office move on Friday #ops' }).expect(201)).body;
    await cleo.post('/api/feed/posts', { workspaceId: ws, body: 'Budget numbers #secret', label: 'confidential' }).expect(201);
    for (const who of [alice, cleo]) await who.put(`/api/feed/posts/${top.id}/reactions/like`).expect(201);
    await cleo.post(`/api/feed/posts/${top.id}/comments`, { body: 'Love it' }).expect(201);
    await bob.put(`/api/feed/posts/${second.id}/reactions/like`).expect(201);

    // trending, by job
    await h.s.jobs.enqueue({ tenantId: h.tenantId, type: 'feed.trending', payload: { tenantId: h.tenantId } });
    await drain(h);
    const trending = (await bob.get(`/api/feed/trending?workspace=${ws}`).expect(200)).body;
    expect(trending.tags).toEqual([
      { tag: 'design', posts: 2, people: 2 },
      { tag: 'ops', posts: 1, people: 1 },
      { tag: 'type', posts: 1, people: 1 }
    ]);
    expect((await cleo.get('/api/feed/trending').expect(200)).body.tags.map((t: { tag: string }) => t.tag)).toContain('secret');
    expect(ids((await bob.get('/api/feed/tags/DESIGN').expect(200)).body)).toEqual([top.id, quiet.id]);

    // the digest: the week's top posts within FEED_DIGEST_MAX_LABEL, ranked, summarised through the gateway
    ollama.reply = (messages) => ({ content: `Digest. ${messages[messages.length - 1]?.content ?? ''}` });
    await h.s.jobs.enqueue({ tenantId: h.tenantId, type: 'feed.digest', payload: { tenantId: h.tenantId, workspaceId: ws, weekEnd: Date.now() + 1000 } });
    await drain(h);
    const list = (await bob.get(`/api/feed/workspaces/${ws}/digests`).expect(200)).body;
    expect(list).toEqual([expect.objectContaining({ state: 'ready', posts: 2, label: 'internal' })]);
    const digest = (await bob.get(`/api/feed/digests/${list[0].id}`).expect(200)).body;
    expect(digest.posts.map((x: { id: string }) => x.id)).toEqual([top.id, second.id]);
    expect(digest.posts[0]).toMatchObject({ reactions: 2, comments: 1, reposts: 0, score: 4, post: expect.objectContaining({ id: top.id }) });
    expect(digest.summary).toMatch(/^Digest\./);
    expect(digest.summary).toContain('New type scale shipped');
    expect(digest.summary).toContain('Office move on Friday');
    expect(digest.summary).not.toContain('Budget numbers');
    const sent = ollama.requests.filter((x) => x.path === '/api/chat').pop()!.body.messages as { role: string; content: string }[];
    expect(sent[0]!.content).toMatch(/weekly digest/);
    // sealed at rest; written once per workspace and week
    expect((await h.s.db('feed_digests').where({ id: digest.id }).first()).summary).not.toContain('type scale');
    expect(JSON.stringify((await bob.get('/api/me/notifications').expect(200)).body)).toMatch(/This week in Studio/);
    const again = await h.s.feed.digests.digestJob(h.tenantId, { workspaceId: ws, weekEnd: digest.weekEnd, by: null });
    expect(again.digests).toBe(0);
    expect(await h.s.db('audit_events').where({ action: 'feed.digest.created' }).first()).toBeTruthy();
  });
});
