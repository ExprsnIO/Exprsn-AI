import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPrincipal } from '../src/http/middleware.js';
import { TOPICS, type IntegrationEvent } from '../src/platform/bus.js';
import { harness, localUser, login, type Harness } from './helpers.js';
import { drain } from './retrieval-seed.js';

/*
 * 1.6.0, Sprint 37c (B-4901): quote posts and per-post visibility. Done when an unlisted post is reachable by link and
 * absent from every feed.
 */

type Person = Awaited<ReturnType<typeof personIn>>;

async function personIn(h: Harness, name: string, workspaces: string[], clearance: 'internal' | 'confidential' = 'confidential') {
  const user = await localUser(h, name, ['member'], clearance);
  for (const w of workspaces) await h.s.tenants.addMember(w, user.id);
  const c = await login(h, name);
  const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
  return { user, post: (p: string, b?: object) => send('post', p, b), patch: (p: string, b?: object) => send('patch', p, b), put: (p: string, b?: object) => send('put', p, b), get: (p: string) => c.agent.get(p) };
}

const ids = (page: { items: { id: string }[] }) => page.items.map((x) => x.id);

describe('B-4901: quote posts and per-post visibility', () => {
  let h: Harness;
  let ws: string;
  let legal: string;
  let alice: Person;
  let bob: Person;
  let carol: Person;
  let dave: Person;

  beforeEach(async () => {
    h = await harness();
    ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Design', 'confidential')).id;
    legal = (await h.s.tenants.createWorkspace(h.tenantId, 'Legal', 'internal')).id;
    alice = await personIn(h, 'alice', [ws, legal]);
    bob = await personIn(h, 'bob', [ws]);
    carol = await personIn(h, 'carol', [ws]);
    dave = await personIn(h, 'dave', [legal], 'internal');
  }, 60_000);
  afterEach(async () => {
    await h.close();
  });

  it('an unlisted post is reachable by its link and absent from every feed', async () => {
    const events: IntegrationEvent[] = [];
    h.s.bus.on<IntegrationEvent>(TOPICS.integrationEvent, (e) => void events.push(e));
    const roomEvents: string[] = [];
    const emit = h.s.rooms.emit.bind(h.s.rooms);
    h.s.rooms.emit = ((e: { event: string; data?: { postId?: string } }) => {
      roomEvents.push(`${e.event}:${e.data?.postId ?? ''}`);
      return emit(e as never);
    }) as typeof h.s.rooms.emit;
    await carol.post('/api/social/following', { userId: alice.user.id }).expect(201);
    const list = (await carol.post('/api/social/lists', { name: 'Leads' }).expect(201)).body;
    await carol.post(`/api/social/lists/${list.id}/members`, { userId: alice.user.id }).expect(201);
    const group = (await alice.post('/api/groups', { workspaceId: ws, name: 'Crit', visibility: 'public', joinMode: 'open' }).expect(201)).body;

    const listed = (await alice.post('/api/feed/posts', { workspaceId: ws, body: 'Kickoff #launch' }).expect(201)).body;
    expect(listed.visibility).toBe('workspace');
    const hidden = (await alice.post('/api/feed/posts', { workspaceId: ws, body: 'Draft plan, by link only #launch', visibility: 'unlisted' }).expect(201)).body;
    expect(hidden).toMatchObject({ visibility: 'unlisted', state: 'published', tags: [] });
    const inGroup = (await alice.post('/api/feed/posts', { groupId: group.id, body: 'Group notes by link', visibility: 'unlisted' }).expect(201)).body;
    const pub = (await alice.post('/api/feed/posts', { workspaceId: ws, body: 'Public note', visibility: 'public' }).expect(201)).body;
    expect(pub.visibility).toBe('public');

    // Reachable by link, to anyone who could read it there; not to someone outside the workspace.
    expect((await bob.get(`/api/feed/posts/${hidden.id}`).expect(200)).body).toMatchObject({ id: hidden.id, body: 'Draft plan, by link only #launch', visibility: 'unlisted' });
    await bob.get(`/api/feed/posts/${inGroup.id}`).expect(200);
    await dave.get(`/api/feed/posts/${hidden.id}`).expect(404);
    // It takes comments and reactions like any post.
    await bob.post(`/api/feed/posts/${hidden.id}/comments`, { body: 'Looks right' }).expect(201);
    await bob.put(`/api/feed/posts/${hidden.id}/reactions/like`).expect(201);

    // Absent from every feed: home, workspace, group, person, list, tag, trending.
    const feeds = [`/api/feed/home`, `/api/feed/workspaces/${ws}`, `/api/feed/groups/${group.id}`, `/api/feed/users/${alice.user.id}`, `/api/feed/users/${alice.user.id}?unlisted=true`, `/api/feed/lists/${list.id}`, `/api/feed/tags/launch`];
    for (const url of feeds) {
      const got = ids((await carol.get(url).expect(200)).body);
      expect(got, url).not.toContain(hidden.id);
      expect(got, url).not.toContain(inGroup.id);
    }
    expect(ids((await carol.get(`/api/feed/workspaces/${ws}`).expect(200)).body)).toEqual([pub.id, listed.id]);
    expect(ids((await alice.get('/api/feed/home').expect(200)).body)).not.toContain(hidden.id);
    // The author finds their own links on their own page with unlisted=true.
    expect(ids((await alice.get(`/api/feed/users/${alice.user.id}?unlisted=true`).expect(200)).body)).toEqual(expect.arrayContaining([hidden.id, inGroup.id]));
    expect(ids((await alice.get(`/api/feed/users/${alice.user.id}`).expect(200)).body)).not.toContain(hidden.id);
    await h.s.jobs.enqueue({ tenantId: h.tenantId, type: 'feed.trending', payload: { tenantId: h.tenantId } });
    await drain(h);
    expect((await carol.get(`/api/feed/trending?workspace=${ws}`).expect(200)).body.tags).toEqual([{ tag: 'launch', posts: 1, people: 1 }]);
    // Digests read through visibleViews, which leaves it out.
    const p = (await loadPrincipal(h.s, h.tenantId, carol.user.id, {}))!;
    expect([...(await h.s.feed.visibleViews(p, [hidden.id, listed.id])).keys()]).toEqual([listed.id]);
    // No live feed event about it; the catalogue event names its visibility.
    expect(roomEvents.filter((e) => e.endsWith(hidden.id))).toEqual([]);
    expect(roomEvents).toContain(`feed.post.created:${listed.id}`);
    expect(events.find((e) => e.type === 'post.created' && (e.data as { post: string }).post === hidden.id)?.data).toMatchObject({ visibility: 'unlisted' });

    // A repost would put it in a feed: refused. A quote of it is unlisted too.
    await bob.post(`/api/feed/posts/${hidden.id}/repost`).expect(409);
    await bob.post(`/api/feed/posts/${hidden.id}/repost`, { body: 'with text' }).expect(409);
    const q = (await bob.post(`/api/feed/posts/${hidden.id}/quote`, { body: 'Agreed', visibility: 'workspace' }).expect(201)).body;
    expect(q).toMatchObject({ visibility: 'unlisted', quoteOf: hidden.id });
    expect(ids((await carol.get(`/api/feed/workspaces/${ws}`).expect(200)).body)).not.toContain(q.id);
    await bob.patch(`/api/feed/posts/${q.id}`, { visibility: 'workspace' }).expect(409);

    // The author moves it into the feeds and out again; tags follow; only the author may.
    await bob.patch(`/api/feed/posts/${hidden.id}`, { visibility: 'workspace' }).expect(403);
    expect((await alice.patch(`/api/feed/posts/${hidden.id}`, { visibility: 'workspace' }).expect(200)).body).toMatchObject({ visibility: 'workspace', tags: ['launch'] });
    expect(ids((await carol.get(`/api/feed/workspaces/${ws}`).expect(200)).body)).toContain(hidden.id);
    expect(ids((await carol.get('/api/feed/tags/launch').expect(200)).body)).toContain(hidden.id);
    expect(roomEvents).toContain(`feed.post.created:${hidden.id}`);
    await alice.patch(`/api/feed/posts/${hidden.id}`, { visibility: 'unlisted' }).expect(200);
    expect(ids((await carol.get(`/api/feed/workspaces/${ws}`).expect(200)).body)).not.toContain(hidden.id);
    expect(ids((await carol.get('/api/feed/tags/launch').expect(200)).body)).not.toContain(hidden.id);
    const audit = (await h.s.db('audit_events').where({ action: 'feed.post.visibility' }).select('detail')) as { detail: string }[];
    expect(audit.map((a) => JSON.parse(a.detail))).toEqual([{ from: 'unlisted', to: 'workspace' }, { from: 'workspace', to: 'unlisted' }]);
  });

  it('quotes a post with a comment, in the same or another workspace, never below the quoted label', async () => {
    const orig = (await alice.post('/api/feed/posts', { workspaceId: ws, body: 'New type scale shipped' }).expect(201)).body;
    const secret = (await alice.post('/api/feed/posts', { workspaceId: ws, body: 'Budget numbers', label: 'confidential' }).expect(201)).body;

    // In the quoted post's own workspace by default.
    const q1 = (await bob.post(`/api/feed/posts/${orig.id}/quote`, { body: 'This is the one to read' }).expect(201)).body;
    expect(q1).toMatchObject({ workspaceId: ws, quoteOf: orig.id, body: 'This is the one to read', label: 'internal', visibility: 'workspace', repostOf: null, quoted: expect.objectContaining({ id: orig.id, body: 'New type scale shipped' }) });
    expect(ids((await carol.get(`/api/feed/workspaces/${ws}`).expect(200)).body)).toContain(q1.id);
    await bob.post(`/api/feed/posts/${orig.id}/quote`, { body: '   ' }).expect(422);

    // Into another workspace: its readers who cannot read the original see the quote without the embed.
    const q2 = (await alice.post(`/api/feed/posts/${orig.id}/quote`, { body: 'Sharing with legal', workspaceId: legal }).expect(201)).body;
    expect(q2).toMatchObject({ workspaceId: legal, label: 'internal', quoteOf: orig.id });
    const seenByDave = (await dave.get(`/api/feed/workspaces/${legal}`).expect(200)).body.items.find((x: { id: string }) => x.id === q2.id);
    expect(seenByDave).toMatchObject({ body: 'Sharing with legal', quoteOf: orig.id, quoted: null });
    await dave.get(`/api/feed/posts/${orig.id}`).expect(404);

    // A quote is labelled at least as high as what it quotes, and must fit the target's ceiling.
    const q3 = (await bob.post(`/api/feed/posts/${secret.id}/quote`, { body: 'Noted', label: 'internal' }).expect(201)).body;
    expect(q3.label).toBe('confidential');
    const refused = await alice.post(`/api/feed/posts/${secret.id}/quote`, { body: 'For legal', workspaceId: legal }).expect(422);
    expect(refused.body).toMatchObject({ step: 'label', quoted: 'confidential', ceiling: 'internal' });
    await dave.post(`/api/feed/posts/${orig.id}/quote`, { body: 'x' }).expect(404);

    // Counted on the original (listed quotes only); audited with the quoted post.
    expect((await carol.get(`/api/feed/posts/${orig.id}`).expect(200)).body.counts).toMatchObject({ quotes: 2, reposts: 0 });
    const created = (await h.s.db('audit_events').where({ action: 'feed.post.created' }).select('target')) as { target: string }[];
    expect(created.map((c) => JSON.parse(c.target)).filter((t) => t.quoteOf === orig.id)).toHaveLength(2);
    // Deleting the original leaves the quote with an empty embed.
    await alice.post(`/api/feed/posts/${orig.id}/quote`, { body: 'one more' }).expect(201);
    await h.s.db('feed_posts').where({ id: orig.id }).update({ state: 'deleted' });
    expect((await carol.get(`/api/feed/posts/${q1.id}`).expect(200)).body.quoted).toBeNull();
  });
});
