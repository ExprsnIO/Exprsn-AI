import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPrincipal } from '../src/http/middleware.js';
import { TOPICS } from '../src/platform/bus.js';
import type { RoomEvent } from '../src/realtime/rooms.js';
import type { SocialRelationEvent } from '../src/social/service.js';
import { harness, localUser, login, type Harness } from './helpers.js';

/*
 * Sprint 28b, social relations (B-2606 with B-2702): blocks, mutes, follows, lists and contact rules, shared by
 * messaging and the workspace feed. Messaging's own tests (sprint28b-messaging.test.ts) prove that it calls these
 * checks; the feed (B-2702) extends "the shared relations the feed uses" below with its own posts.
 */

type Person = Awaited<ReturnType<typeof personIn>>;

/** A member of the given workspaces, signed in, with request helpers that send the CSRF header. */
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
    principal: async () => (await loadPrincipal(h.s, h.tenantId, user.id, {}))!
  };
}

describe('social relations (Sprint 28b)', () => {
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
    alice = await personIn(h, 'alice', [ws]);
    bob = await personIn(h, 'bob', [ws]);
    carol = await personIn(h, 'carol', [ws]);
    dave = await personIn(h, 'dave', [other]);
  }, 60_000);
  afterEach(async () => {
    await h.close();
  });

  it('a block works in both directions, ends follows both ways, and is told to nobody', async () => {
    const events: SocialRelationEvent[] = [];
    h.s.bus.on<SocialRelationEvent>(TOPICS.socialRelation, (e) => void events.push(e));
    await alice.post('/api/social/following', { userId: bob.user.id }).expect(201);
    await bob.post('/api/social/following', { userId: alice.user.id }).expect(201);
    expect(await h.s.social.following(h.tenantId, alice.user.id)).toEqual(new Set([bob.user.id]));

    expect((await alice.post('/api/social/blocks', { userId: bob.user.id }).expect(201)).body).toMatchObject({ userId: bob.user.id, blocked: true, created: true });
    // again: the same block, not a second one
    expect((await alice.post('/api/social/blocks', { userId: bob.user.id }).expect(200)).body.created).toBe(false);
    expect(await h.s.social.isBlocked(h.tenantId, alice.user.id, bob.user.id)).toBe(true);
    expect(await h.s.social.isBlocked(h.tenantId, bob.user.id, alice.user.id)).toBe(true);
    expect(await h.s.social.isBlocked(h.tenantId, alice.user.id, carol.user.id)).toBe(false);
    expect(await h.s.social.blockedWith(h.tenantId, bob.user.id)).toEqual(new Set([alice.user.id]));
    expect(await h.s.social.blockedAmong(h.tenantId, alice.user.id, [bob.user.id, carol.user.id])).toEqual(new Set([bob.user.id]));
    expect(await h.s.social.following(h.tenantId, alice.user.id)).toEqual(new Set());
    expect(await h.s.social.following(h.tenantId, bob.user.id)).toEqual(new Set());

    // the blocker sees the block; the blocked person sees nothing of it
    expect((await alice.get('/api/social/blocks').expect(200)).body).toEqual([expect.objectContaining({ userId: bob.user.id, username: 'bob' })]);
    expect((await bob.get('/api/social/blocks').expect(200)).body).toEqual([]);
    const seen = (await bob.get(`/api/social/users/${alice.user.id}`).expect(200)).body;
    expect(seen).toEqual({ userId: alice.user.id, blocking: false, muting: false, following: false, followedBy: false, canMessage: false });
    // and cannot follow back (as if the blocker were not there); the blocker is told to unblock first
    await bob.post('/api/social/following', { userId: alice.user.id }).expect(404);
    await alice.post('/api/social/following', { userId: bob.user.id }).expect(409);
    // nobody blocks themselves or someone unknown
    await alice.post('/api/social/blocks', { userId: alice.user.id }).expect(422);
    await alice.post('/api/social/blocks', { userId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }).expect(404);

    await alice.del(`/api/social/blocks/${bob.user.id}`).expect(200);
    await alice.del(`/api/social/blocks/${bob.user.id}`).expect(404);
    expect(await h.s.social.isBlocked(h.tenantId, bob.user.id, alice.user.id)).toBe(false);
    expect(events.filter((e) => e.kind === 'block').map((e) => e.on)).toEqual([true, false]);

    const actions = (await h.s.db('audit_events').where('action', 'like', 'social.%').orderBy('seq').select('action')).map((r: { action: string }) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['social.follow.created', 'social.block.created', 'social.block.removed']));
  });

  it('mutes are private and may expire', async () => {
    await alice.post('/api/social/mutes', { userId: bob.user.id }).expect(201);
    await alice.post('/api/social/mutes', { userId: carol.user.id, minutes: 30 }).expect(201);
    expect(await h.s.social.mutedBy(h.tenantId, alice.user.id)).toEqual(new Set([bob.user.id, carol.user.id]));
    expect(await h.s.social.isMuted(h.tenantId, alice.user.id, bob.user.id)).toBe(true);
    expect(await h.s.social.isMuted(h.tenantId, bob.user.id, alice.user.id)).toBe(false);
    // an expired mute no longer counts
    await h.s.db('social_mutes').where({ user_id: alice.user.id, target_id: carol.user.id }).update({ expires_at: Date.now() - 1000 });
    expect(await h.s.social.mutedBy(h.tenantId, alice.user.id)).toEqual(new Set([bob.user.id]));
    expect((await alice.get('/api/social/mutes').expect(200)).body.map((m: { userId: string }) => m.userId)).toEqual([bob.user.id]);
    expect((await bob.get(`/api/social/users/${alice.user.id}`).expect(200)).body.muting).toBe(false);
    expect(await h.s.social.hiddenFor(h.tenantId, alice.user.id)).toEqual(new Set([bob.user.id]));
    await alice.del(`/api/social/mutes/${bob.user.id}`).expect(200);
    expect(await h.s.social.mutedBy(h.tenantId, alice.user.id)).toEqual(new Set());
  });

  it('follows and lists stay inside the workspaces the two share; lists are their owner’s', async () => {
    await alice.post('/api/social/following', { userId: dave.user.id }).expect(404);
    await alice.get(`/api/social/users/${dave.user.id}`).expect(404);
    await alice.post('/api/social/following', { userId: bob.user.id }).expect(201);
    expect((await bob.get('/api/social/followers').expect(200)).body).toEqual([expect.objectContaining({ userId: alice.user.id, username: 'alice' })]);
    expect((await alice.get('/api/social/following').expect(200)).body).toEqual([expect.objectContaining({ userId: bob.user.id })]);
    expect((await alice.get(`/api/social/users/${bob.user.id}`).expect(200)).body).toMatchObject({ following: true, followedBy: false, canMessage: true });

    const list = (await alice.post('/api/social/lists', { name: 'Type nerds', description: 'fonts' }).expect(201)).body;
    await alice.post('/api/social/lists', { name: 'type NERDS' }).expect(409);
    await alice.post(`/api/social/lists/${list.id}/members`, { userId: bob.user.id }).expect(201);
    await alice.post(`/api/social/lists/${list.id}/members`, { userId: bob.user.id }).expect(200);
    await alice.post(`/api/social/lists/${list.id}/members`, { userId: dave.user.id }).expect(404);
    await alice.post(`/api/social/lists/${list.id}/members`, { userId: carol.user.id }).expect(201);
    expect((await alice.get('/api/social/lists').expect(200)).body).toEqual([expect.objectContaining({ id: list.id, name: 'Type nerds', members: 2 })]);
    expect((await alice.get(`/api/social/lists/${list.id}`).expect(200)).body.people.map((x: { username: string }) => x.username)).toEqual(['bob', 'carol']);
    expect(await h.s.social.listMembers(h.tenantId, alice.user.id, list.id)).toEqual([bob.user.id, carol.user.id]);
    expect(await h.s.social.inList(h.tenantId, list.id, carol.user.id)).toBe(true);
    // someone else's list does not exist for them
    await bob.get(`/api/social/lists/${list.id}`).expect(404);
    await bob.post(`/api/social/lists/${list.id}/members`, { userId: carol.user.id }).expect(404);
    expect(await h.s.social.listMembers(h.tenantId, bob.user.id, list.id)).toBeNull();
    await alice.patch(`/api/social/lists/${list.id}`, { name: 'Typographers' }).expect(200);
    await alice.del(`/api/social/lists/${list.id}/members/${carol.user.id}`).expect(200);
    await alice.del(`/api/social/lists/${list.id}`).expect(200);
    expect((await alice.get('/api/social/lists').expect(200)).body).toEqual([]);
  });

  it('contact rules: everyone in my workspaces, people I follow, or nobody; a block refuses with the same words', async () => {
    const pa = await alice.principal();
    expect((await bob.get('/api/social/settings').expect(200)).body).toEqual({ contactRule: 'workspace' });
    expect(await h.s.social.mayContact(pa, bob.user.id)).toEqual({ ok: true });
    // outside the shared workspaces: unknown
    expect(await h.s.social.mayContact(pa, dave.user.id)).toMatchObject({ ok: false, status: 404 });
    expect(await h.s.social.mayContact(pa, alice.user.id)).toMatchObject({ ok: false, step: 'self' });

    await bob.put('/api/social/settings', { contactRule: 'following' }).expect(200);
    const refusedByRule = await h.s.social.mayContact(pa, bob.user.id);
    expect(refusedByRule).toMatchObject({ ok: false, status: 403, step: 'contact' });
    await bob.post('/api/social/following', { userId: alice.user.id }).expect(201);
    expect(await h.s.social.mayContact(pa, bob.user.id)).toEqual({ ok: true });

    await bob.put('/api/social/settings', { contactRule: 'nobody' }).expect(200);
    expect(await h.s.social.mayContact(pa, bob.user.id)).toEqual(refusedByRule);
    await bob.put('/api/social/settings', { contactRule: 'workspace' }).expect(200);
    await bob.put('/api/social/settings', { contactRule: 'everyone' }).expect(400);

    await bob.post('/api/social/blocks', { userId: alice.user.id }).expect(201);
    // the blocked person is refused exactly as by a contact rule
    expect(await h.s.social.mayContact(pa, bob.user.id)).toEqual(refusedByRule);
    await expect(h.s.social.requireContact(pa, bob.user.id)).rejects.toMatchObject({ status: 403 });
    const audited = await h.s.db('audit_events').where({ action: 'social.contact-rule.updated' }).count({ n: '*' });
    expect(Number((audited as { n: number }[])[0]!.n)).toBe(3);
  });

  it('needs its permissions; the admin view needs social:manage and is audited', async () => {
    await h.s.users.setRoles(carol.user.id, 'direct', ['flag-reviewer']);
    const c2 = await login(h, 'carol');
    await c2.agent.get('/api/social/blocks').expect(403);
    await alice.post('/api/social/blocks', { userId: bob.user.id }).expect(201);
    await alice.get(`/api/social/admin/users/${bob.user.id}`).expect(403);

    const admin = await localUser(h, 'tina', ['tenant-admin']);
    // A tenant admin's session needs a second factor; the service is what the route calls.
    const p = (await loadPrincipal(h.s, h.tenantId, admin.id, {}))!;
    const view = await h.s.social.adminView({ p, ip: null }, bob.user.id);
    expect(view).toMatchObject({ userId: bob.user.id, blockedBy: [alice.user.id], blocks: [], contactRule: 'workspace' });
    expect(await h.s.db('audit_events').where({ action: 'social.relations.viewed' }).first()).toBeTruthy();
  });
});

/*
 * The relations the workspace feed (B-2702) uses. Messaging (B-2606) calls the same `isBlocked`, `blockedWith` and
 * `emitToRoom`; the feed agent adds its own assertions here (a block hides posts, a mute leaves the home feed, list
 * feeds follow `listMembers`).
 */
describe('the shared relations the feed uses (B-2606 with B-2702)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  }, 60_000);
  afterEach(async () => {
    await h.close();
  });

  it('room events from a person leave out everyone in a block with them, on every instance', async () => {
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Design', 'internal')).id;
    const [a, b, c] = [await personIn(h, 'ann', [ws]), await personIn(h, 'ben', [ws]), await personIn(h, 'cat', [ws])];
    await b.post('/api/social/blocks', { userId: a.user.id }).expect(201);
    const relayed: RoomEvent[] = [];
    h.s.bus.on<RoomEvent>(TOPICS.roomEvent, (e) => void relayed.push(e));
    const room = { tenantId: h.tenantId, kind: 'feed' as const, id: ws, event: 'feed.post.created', data: { postId: 'x' } };
    await h.s.social.emitToRoom(room, a.user.id);
    await h.s.social.emitToRoom(room, c.user.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(relayed).toHaveLength(2);
    // ann's event skips ben (ben blocked ann); cat's event reaches everyone
    expect(relayed[0]!.exceptUserIds).toEqual([b.user.id]);
    expect(relayed[1]!.exceptUserIds).toBeUndefined();
  });
});
