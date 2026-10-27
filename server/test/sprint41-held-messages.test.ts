import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProfileRow } from '../src/gateway/repo.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { attachRealtime } from '../src/realtime/socket.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * Sprint 41, held messages (B-9401 to B-9403). The "done when" of each item is a test below:
 *   B-9401 a held message is invisible to the other members until a reviewer accepts it, then arrives once;
 *   B-9402 a held group post appears in the moderation queue and, once accepted, in the group;
 *   B-9403 with the guard model stopped, messages queue as held, and when it returns the clean ones are delivered
 *          without a reviewer.
 * B-9404, the console, is e2e/tests/held-messages.spec.ts.
 */

const C = '/api/messaging/conversations';
const GB = 1_000_000_000;

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
    patch: (p: string, b?: object) => send('patch', p, b),
    del: (p: string) => send('delete', p),
    get: (p: string) => c.agent.get(p),
    principal: async () => (await loadPrincipal(h.s, h.tenantId, user.id, {}))!
  };
}

const send = (c: Client, method: 'post' | 'put', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);
const bodies = (list: { body: string | null }[]) => list.map((m) => m.body);

/** A reviewer (guardrail admin, in the workspace) and a tenant rule set with these rules, published. */
async function reviewerWith(h: Harness, ws: string, rules: object[]) {
  const user = await localUser(h, 'ga', ['guardrail-admin'], 'confidential');
  await h.s.tenants.addMember(ws, user.id);
  const ga = await loginAdmin(h, 'ga');
  const set = (await send(ga, 'post', '/api/admin/guardrails/sets', { name: 'Message rules', scope: 'tenant' }).expect(201)).body;
  await send(ga, 'put', `/api/admin/guardrails/sets/${set.id}/draft`, { rules }).expect(200);
  await send(ga, 'post', `/api/admin/guardrails/sets/${set.id}/draft/publish`).expect(200);
  return { ga, user };
}

const WIRE = { id: 'wire', name: 'Wire transfers', checkpoint: 'user-input', type: 'pattern', mechanism: { kind: 'pattern', pattern: '(?i)wire transfer' }, action: 'require-approval', stage: 'enforce' };
const NUKE = { id: 'nuke', name: 'Never this', checkpoint: 'user-input', type: 'pattern', mechanism: { kind: 'pattern', pattern: '(?i)launch codes' }, action: 'block', stage: 'enforce' };

describe('held messages and edits (B-9401)', () => {
  let h: Harness;
  let ws: string;
  let alice: Person;
  let bob: Person;
  let ga: Client;

  beforeEach(async () => {
    h = await harness();
    ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Finance', 'confidential')).id;
    alice = await personIn(h, 'alice', [ws]);
    bob = await personIn(h, 'bob', [ws]);
    ({ ga } = await reviewerWith(h, ws, [WIRE, NUKE]));
  }, 60_000);
  afterEach(async () => {
    await h.close();
  });

  const heldItems = async () => (await ga.agent.get('/api/moderation/held').expect(200)).body.items as { id: string; kind: string; objectId: string; flag: { ref: string; state: string } | null; reason: string; own: boolean }[];

  it('a held message is invisible to the other member until a reviewer accepts it, then arrives once, with its original time', async () => {
    const id = (await alice.post(C, { kind: 'direct', userId: bob.user.id }).expect(201)).body.id as string;
    const hello = (await alice.post(`${C}/${id}/messages`, { body: 'hello bob' }).expect(201)).body;
    await bob.post(`${C}/${id}/read`, { messageId: hello.id }).expect(200);
    const before = JSON.stringify((await bob.get('/api/me/notifications').expect(200)).body);

    const held = (await alice.post(`${C}/${id}/messages`, { body: 'Please send the wire transfer today' }).expect(202)).body;
    expect(held).toMatchObject({ state: 'held', body: 'Please send the wire transfer today', held: { state: 'held', reason: 'review', kind: 'dm-message' } });
    // a block still refuses
    expect((await alice.post(`${C}/${id}/messages`, { body: 'the launch codes are 1234' }).expect(422)).body).toMatchObject({ action: 'block' });

    // the other member: not in the timeline, not readable by id, not counted, not searchable, not notified
    expect(bodies((await bob.get(`${C}/${id}/messages`).expect(200)).body)).toEqual(['hello bob']);
    await bob.post(`${C}/${id}/read`, { messageId: held.id }).expect(404);
    await bob.post(`/api/messaging/messages/${held.id}/reactions`, { emoji: '👍' }).expect(404);
    await bob.post(`${C}/${id}/messages`, { body: 're', replyTo: held.id }).expect(404);
    expect((await bob.get(`${C}/${id}`).expect(200)).body.unread).toBe(0);
    expect(JSON.stringify((await bob.get('/api/me/notifications').expect(200)).body)).toBe(before);
    expect(await h.s.db('dm_terms').where({ message_id: held.id }).first()).toBeUndefined();
    expect(await h.s.messaging.sees((await h.s.messaging.accessOrNull(await bob.principal(), id))!, (await h.s.messaging.messageRow(h.tenantId, held.id))!)).toBe(false);
    // the conversation did not move for him
    expect((await h.s.db('dm_conversations').where({ id }).first()).last_message_at).toBe(hello.createdAt);
    // its sender sees it, as held, and may not reply to or react on it
    expect(bodies((await alice.get(`${C}/${id}/messages`).expect(200)).body)).toEqual(['Please send the wire transfer today', 'hello bob']);
    await alice.post(`/api/messaging/messages/${held.id}/reactions`, { emoji: '👍' }).expect(409);
    expect((await alice.get('/api/me/held').expect(200)).body.items).toMatchObject([{ state: 'held', what: 'message', objectId: held.id }]);

    // the review queue: a hold flag, and the item with the conversation's context
    const [item] = await heldItems();
    expect(item).toMatchObject({ kind: 'dm-message', objectId: held.id, reason: 'review', own: false, flag: { state: 'open' } });
    const flag = (await ga.agent.get(`/api/flags/${item!.flag!.ref}`).expect(200)).body;
    expect(flag).toMatchObject({ kind: 'hold', held: { state: 'held', content: 'Please send the wire transfer today' } });
    const detail = (await ga.agent.get(`/api/moderation/held/${item!.id}`).expect(200)).body;
    expect(detail.text).toBe('Please send the wire transfer today');
    expect(detail.context.place).toMatch(/^A direct conversation between /);
    expect(detail.context.items.map((i: { text: string }) => i.text)).toEqual(['hello bob']);
    expect((await ga.agent.get('/api/moderation/held/summary').expect(200)).body).toMatchObject({ review: 1, unavailable: 0 });
    // a member is not a reviewer; the sender never decides on their own
    await bob.get('/api/moderation/held').expect(403);
    await expect(h.s.held.resolve(await alice.principal(), item!.id, 'approved', null)).rejects.toMatchObject({ status: 403 });

    // two reviewers' accepts at once: one lands, the message is delivered once
    const gaP = (await loadPrincipal(h.s, h.tenantId, (await h.s.db('users').where({ username: 'ga' }).first()).id, {}))!;
    const both = await Promise.allSettled([h.s.held.resolve(gaP, item!.id, 'approved', null), h.s.held.resolve(gaP, item!.id, 'approved', null)]);
    expect(both.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected']);
    await send(ga, 'post', `/api/moderation/held/${item!.id}/decide`, { decision: 'accept' }).expect(409);

    const seen = (await bob.get(`${C}/${id}/messages`).expect(200)).body as { id: string; body: string; createdAt: number; state: string }[];
    expect(seen.filter((m) => m.id === held.id)).toHaveLength(1);
    expect(seen.find((m) => m.id === held.id)).toMatchObject({ state: 'sent', body: 'Please send the wire transfer today', createdAt: held.createdAt });
    // unread although its time is before what he last read; reading again clears it
    expect((await bob.get(`${C}/${id}`).expect(200)).body.unread).toBe(1);
    expect(JSON.stringify((await bob.get('/api/me/notifications').expect(200)).body)).toMatch(/sent you a message/);
    await bob.post(`${C}/${id}/read`, { messageId: held.id }).expect(200);
    expect((await bob.get(`${C}/${id}`).expect(200)).body.unread).toBe(0);
    expect(await h.s.db('dm_terms').where({ message_id: held.id }).first()).toBeTruthy();
    expect((await alice.get(`${C}/${id}/messages`).expect(200)).body[0]).toMatchObject({ id: held.id, state: 'sent', held: null });
    expect((await h.s.db('audit_events').where({ action: 'moderation.held.delivered' })).length).toBe(1);
  });

  it('a rejected message tells its sender and never reaches the conversation; a withdrawn one is removed and its flag closed', async () => {
    const id = (await alice.post(C, { kind: 'direct', userId: bob.user.id }).expect(201)).body.id as string;
    const one = (await alice.post(`${C}/${id}/messages`, { body: 'wire transfer one' }).expect(202)).body;
    const [item] = await heldItems();
    const out = (await send(ga, 'post', `/api/moderation/held/${item!.id}/decide`, { decision: 'reject', reason: 'Not in chat' }).expect(200)).body;
    expect(out).toMatchObject({ state: 'rejected', flag: { state: 'rejected' } });
    expect(bodies((await bob.get(`${C}/${id}/messages`).expect(200)).body)).toEqual([]);
    expect((await alice.get(`${C}/${id}/messages`).expect(200)).body[0]).toMatchObject({ id: one.id, state: 'rejected', held: { state: 'rejected', note: 'Not in chat' } });
    expect(JSON.stringify((await alice.get('/api/me/notifications').expect(200)).body)).toMatch(/was not delivered/);
    // the sender clears it
    await alice.del(`/api/messaging/messages/${one.id}`).expect(200);
    expect(await h.s.db('dm_messages').where({ id: one.id }).first()).toBeUndefined();

    const two = (await alice.post(`${C}/${id}/messages`, { body: 'wire transfer two' }).expect(202)).body;
    const [waiting] = await heldItems();
    await bob.del(`/api/messaging/messages/${two.id}`).expect(404);
    await alice.del(`/api/messaging/messages/${two.id}`).expect(200);
    expect(await h.s.db('dm_messages').where({ id: two.id }).first()).toBeUndefined();
    expect(await heldItems()).toEqual([]);
    const flag = (await ga.agent.get(`/api/flags/${waiting!.flag!.ref}`).expect(200)).body;
    expect(flag).toMatchObject({ state: 'rejected' });
    expect(flag.history.map((e: { action: string }) => e.action)).toContain('withdrawn');
    await send(ga, 'post', `/api/moderation/held/${waiting!.id}/decide`, { decision: 'accept' }).expect(409);
    expect((await h.s.db('held_writes').where({ id: waiting!.id }).first()).state).toBe('withdrawn');
  });

  it('a held edit leaves the message as everyone reads it until it is accepted', async () => {
    const id = (await alice.post(C, { kind: 'direct', userId: bob.user.id }).expect(201)).body.id as string;
    const m = (await alice.post(`${C}/${id}/messages`, { body: 'see you at noon' }).expect(201)).body;
    const edited = (await alice.patch(`/api/messaging/messages/${m.id}`, { body: 'see you at noon, bring the wire transfer form' }).expect(202)).body;
    expect(edited).toMatchObject({ body: 'see you at noon', state: 'sent', pendingEdit: { state: 'held', body: 'see you at noon, bring the wire transfer form' } });
    expect((await bob.get(`${C}/${id}/messages`).expect(200)).body[0]).toMatchObject({ body: 'see you at noon', edited: false, pendingEdit: null });
    // one edit at a time
    await alice.patch(`/api/messaging/messages/${m.id}`, { body: 'other' }).expect(409);
    // withdrawn by its sender: the flag is closed and the message can be edited again
    await bob.post(`/api/me/held/${edited.pendingEdit.id}/withdraw`).expect(404);
    await alice.post(`/api/me/held/${edited.pendingEdit.id}/withdraw`).expect(200);
    expect(await heldItems()).toEqual([]);
    const again = (await alice.patch(`/api/messaging/messages/${m.id}`, { body: 'noon, with the wire transfer form' }).expect(202)).body;
    const [item] = await heldItems();
    expect(item).toMatchObject({ kind: 'dm-edit', objectId: m.id });
    await send(ga, 'post', `/api/flags/${item!.flag!.ref}/decide`, { decision: 'approved' }).expect(200);
    expect((await bob.get(`${C}/${id}/messages`).expect(200)).body[0]).toMatchObject({ body: 'noon, with the wire transfer form', edited: true });
    expect((await alice.get(`${C}/${id}/messages`).expect(200)).body[0]).toMatchObject({ pendingEdit: null, edited: true });
    expect(again.pendingEdit.id).toBe(item!.id);
    // the held text is dropped once decided
    expect((await h.s.db('held_writes').where({ id: item!.id }).first()).body).toBeNull();
  });

  it('holds per author are capped, and a deleted conversation withdraws what waited in it', async () => {
    await h.close();
    h = await harness({ HELD_MAX_PER_AUTHOR: '2' });
    ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Finance', 'confidential')).id;
    alice = await personIn(h, 'alice', [ws]);
    bob = await personIn(h, 'bob', [ws]);
    ({ ga } = await reviewerWith(h, ws, [WIRE]));
    const g = (await alice.post(C, { kind: 'group', workspaceId: ws, memberIds: [bob.user.id], title: 'Ops' }).expect(201)).body;
    await alice.post(`${C}/${g.id}/messages`, { body: 'wire transfer 1' }).expect(202);
    await alice.post(`${C}/${g.id}/messages`, { body: 'wire transfer 2' }).expect(202);
    const refused = (await alice.post(`${C}/${g.id}/messages`, { body: 'wire transfer 3' }).expect(422)).body;
    expect(refused).toMatchObject({ step: 'held-queue-full' });
    // nothing of the refused one is left behind
    expect((await h.s.db('dm_messages').where({ conversation_id: g.id })).length).toBe(2);
    // the legal-hold export of a conversation never carries what only its sender could see
    expect((await h.s.db('dm_messages').where({ conversation_id: g.id }).whereNotIn('state', ['held', 'rejected'])).length).toBe(0);
    await alice.del(`${C}/${g.id}`).expect(200);
    expect(await heldItems()).toEqual([]);
    expect((await h.s.db('held_writes').where({ scope_id: g.id })).map((r: { state: string }) => r.state)).toEqual(['withdrawn', 'withdrawn']);
    expect((await h.s.db('guard_flags').where({ kind: 'hold' })).map((f: { state: string }) => f.state)).toEqual(['rejected', 'rejected']);
  });
});

describe('held group posts, comments and post edits (B-9402)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  }, 60_000);
  afterEach(async () => {
    await h.close();
  });

  it('a held group post is in the moderation queue and, once accepted, in the group; comments and post edits wait the same way', async () => {
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Finance', 'confidential')).id;
    const alice = await personIn(h, 'alice', [ws]);
    const bob = await personIn(h, 'bob', [ws]);
    const { ga } = await reviewerWith(h, ws, [WIRE]);
    const g = (await alice.post('/api/groups', { workspaceId: ws, name: 'Treasury', visibility: 'public', joinMode: 'open' }).expect(201)).body;
    await bob.post(`/api/groups/${g.id}/join`).expect((r) => expect([200, 201]).toContain(r.status));
    const notice = (await alice.post(`/api/groups/${g.id}/posts`, { body: 'Welcome' }).expect(201)).body;

    const held = (await bob.post(`/api/groups/${g.id}/posts`, { body: 'Who signs the wire transfer?' }).expect(202)).body;
    expect(held).toMatchObject({ state: 'held', body: 'Who signs the wire transfer?', held: { state: 'held', kind: 'group-post' } });
    const ids = async (who: Person) => ((await who.get(`/api/groups/${g.id}/posts`).expect(200)).body as { id: string }[]).map((x) => x.id);
    // the group's owner, who moderates it, does not see it; its author does
    expect(await ids(alice)).toEqual([notice.id]);
    expect(await ids(bob)).toEqual([held.id, notice.id]);
    await alice.del(`/api/group-posts/${held.id}`).expect(404);

    const items = (await ga.agent.get('/api/moderation/held').expect(200)).body.items;
    expect(items).toMatchObject([{ kind: 'group-post', objectId: held.id, flag: { state: 'open' } }]);
    // the hold flag is in the review queue like any other
    const queued = (await ga.agent.get('/api/flags').expect(200)).body.items.find((f: { ref: string }) => f.ref === items[0].flag.ref);
    expect(queued).toMatchObject({ kind: 'hold', rule: 'Wire transfers' });
    const detail = (await ga.agent.get(`/api/moderation/held/${items[0].id}`).expect(200)).body;
    expect(detail).toMatchObject({ text: 'Who signs the wire transfer?', context: { place: 'The group Treasury' } });
    expect(detail.context.items.map((i: { text: string }) => i.text)).toEqual(['Welcome']);
    await send(ga, 'post', `/api/moderation/held/${items[0].id}/decide`, { decision: 'accept' }).expect(200);
    expect(await ids(alice)).toEqual([held.id, notice.id]);
    expect(((await alice.get(`/api/groups/${g.id}/posts`).expect(200)).body as { id: string; body: string; state: string }[])[0]).toMatchObject({ state: 'published', body: 'Who signs the wire transfer?' });

    // a comment on a feed post
    const post = (await alice.post('/api/feed/posts', { workspaceId: ws, body: 'Quarter close' }).expect(201)).body;
    const comment = (await bob.post(`/api/feed/posts/${post.id}/comments`, { body: 'after the wire transfer?' }).expect(202)).body;
    expect(comment).toMatchObject({ state: 'held', body: 'after the wire transfer?' });
    const comments = async (who: Person) => ((await who.get(`/api/feed/posts/${post.id}/comments`).expect(200)).body.items as { id: string; state: string }[]).map((c) => `${c.id}:${c.state}`);
    expect(await comments(alice)).toEqual([]);
    expect(await comments(bob)).toEqual([`${comment.id}:held`]);
    expect((await alice.get(`/api/feed/posts/${post.id}`).expect(200)).body.counts.comments).toBe(0);
    await alice.del(`/api/feed/comments/${comment.id}`).expect(404);
    const c1 = (await ga.agent.get('/api/moderation/held').expect(200)).body.items[0];
    expect(c1).toMatchObject({ kind: 'feed-comment', objectId: comment.id });
    await send(ga, 'post', `/api/flags/${c1.flag.ref}/decide`, { decision: 'approved' }).expect(200);
    expect(await comments(alice)).toEqual([`${comment.id}:published`]);
    expect((await alice.get(`/api/feed/posts/${post.id}`).expect(200)).body.counts.comments).toBe(1);

    // a rejected comment stays its author's; withdrawing a waiting one removes it
    const c2 = (await bob.post(`/api/feed/posts/${post.id}/comments`, { body: 'wire transfer again' }).expect(202)).body;
    const i2 = (await ga.agent.get('/api/moderation/held').expect(200)).body.items[0];
    await send(ga, 'post', `/api/moderation/held/${i2.id}/decide`, { decision: 'reject' }).expect(200);
    expect(await comments(alice)).toEqual([`${comment.id}:published`]);
    expect(await comments(bob)).toEqual([`${comment.id}:published`, `${c2.id}:rejected`]);
    const c3 = (await bob.post(`/api/feed/posts/${post.id}/comments`, { body: 'a third wire transfer' }).expect(202)).body;
    await bob.del(`/api/feed/comments/${c3.id}`).expect(200);
    expect((await ga.agent.get('/api/moderation/held').expect(200)).body.items).toEqual([]);
    expect(await h.s.db('feed_comments').where({ id: c3.id }).first()).toBeUndefined();

    // an edit of a published post waits while the post keeps its text
    const edit = (await alice.patch(`/api/feed/posts/${post.id}`, { body: 'Quarter close and the wire transfer' }).expect(202)).body;
    expect(edit).toMatchObject({ body: 'Quarter close', held: { kind: 'feed-post-edit', state: 'held', body: 'Quarter close and the wire transfer' } });
    expect((await bob.get(`/api/feed/posts/${post.id}`).expect(200)).body).toMatchObject({ body: 'Quarter close', held: null });
    const e1 = (await ga.agent.get('/api/moderation/held').expect(200)).body.items[0];
    await send(ga, 'post', `/api/moderation/held/${e1.id}/decide`, { decision: 'accept' }).expect(200);
    expect((await bob.get(`/api/feed/posts/${post.id}`).expect(200)).body).toMatchObject({ body: 'Quarter close and the wire transfer' });
  });
});

describe('a guard-model outage holds instead of refusing (B-9403)', () => {
  let h: Harness;
  let ollama: FakeOllama;
  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000', HELD_OUTAGE_MAX_PER_TENANT: '4' });
    ollama = await new FakeOllama().start();
  }, 60_000);
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  /** A pool on the fake Ollama with a guard model and its published profile. */
  async function seedGuard() {
    const repo = h.s.gateway.repo;
    ollama.addAvailable({ name: 'llama-guard3:8b', size: 5 * GB, capabilities: ['completion'] });
    const pool = await repo.createPool({ name: 'gpu', accelerator: 'cuda', zone: 'inference', labelCeiling: 'confidential' });
    await repo.createInstance({ poolId: pool.id, name: 'gpu-1', url: ollama.url, deploy: 'docker', settings: { parallel: 8 } });
    const m = await repo.createModel({ name: 'llama-guard3:8b', source: 'Ollama library', expectedDigest: null, license: { name: 'test' }, label: 'confidential', notes: null, requestedBy: 'x', requestedTenant: h.tenantId });
    await repo.updateModel(m.id, { state: 'approved', import_state: 'pulled', capabilities: ['completion'], size_bytes: 5 * GB });
    await repo.place(m.id, pool.id, 'warm', 'x');
    const t = Date.now();
    const row: ProfileRow = { id: 'LLAMAGUARD0000000000000000', tenant_id: h.tenantId, name: 'llama-guard', display_name: 'Guard', description: null, alias_of: null, model_id: m.id, pool_id: pool.id, num_ctx: 8192, temperature: 0.2, think_default: 'off', think_ceiling: 'off', system_prompt: null, fallback: null, canary: null, tools: [], label: 'confidential', status: 'published', version: 1, updated_by: null, created_at: t, updated_at: t };
    await repo.createProfile(row);
    await h.s.gateway.pollAll();
  }

  it('with the guard model stopped messages queue as held; when it returns the clean ones are delivered without a reviewer', async () => {
    await seedGuard();
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Support', 'internal')).id;
    const alice = await personIn(h, 'alice', [ws]);
    const bob = await personIn(h, 'bob', [ws]);
    const { ga } = await reviewerWith(h, ws, [
      { id: 'safety', name: 'Prompt safety', checkpoint: 'user-input', type: 'guard model', mechanism: { kind: 'guard-model', profile: 'llama-guard' }, action: 'block', stage: 'enforce' },
      WIRE
    ]);
    const id = (await alice.post(C, { kind: 'direct', userId: bob.user.id }).expect(201)).body.id as string;
    // the guard answers: a clean message goes straight through
    await alice.post(`${C}/${id}/messages`, { body: 'before the outage' }).expect(201);

    ollama.down = true;
    const clean = (await alice.post(`${C}/${id}/messages`, { body: 'during the outage, all fine' }).expect(202)).body;
    const unsafe = (await alice.post(`${C}/${id}/messages`, { body: 'this is UNSAFE-TEST material' }).expect(202)).body;
    const review = (await alice.post(`${C}/${id}/messages`, { body: 'and a wire transfer' }).expect(202)).body;
    expect(clean).toMatchObject({ state: 'held', held: { reason: 'unavailable' } });
    // a rule that did run and asked for a reviewer makes it a reviewer's, even while the guard is down
    expect(review.held).toMatchObject({ reason: 'review' });
    const post = (await alice.post('/api/feed/posts', { workspaceId: ws, body: 'Posted during the outage' }).expect(202)).body;
    expect(post).toMatchObject({ state: 'held', held: { kind: 'feed-post', reason: 'unavailable' } });
    expect(bodies((await bob.get(`${C}/${id}/messages`).expect(200)).body)).toEqual(['before the outage']);
    await bob.get(`/api/feed/posts/${post.id}`).expect(404);
    // no flag for what only waits on the check; the count is on the Moderation screen and reviewers are told once
    expect((await h.s.db('guard_flags').where({ kind: 'hold' })).length).toBe(1);
    expect((await ga.agent.get('/api/moderation/held/summary').expect(200)).body).toMatchObject({ review: 1, unavailable: 3 });
    const told = ((await ga.agent.get('/api/me/notifications').expect(200)).body.items ?? (await ga.agent.get('/api/me/notifications')).body) as { title: string }[];
    expect(told.filter((n) => /waiting on a guardrail check/.test(n.title))).toHaveLength(1);
    // a reviewer cannot release what has no verdict
    const waiting = (await ga.agent.get('/api/moderation/held?reason=unavailable').expect(200)).body.items;
    await send(ga, 'post', `/api/moderation/held/${waiting[0].id}/decide`, { decision: 'accept' }).expect(409);
    // the pile is bounded: the tenant's fourth outage hold is the last
    await bob.post(`${C}/${id}/messages`, { body: 'bob during the outage' }).expect(202);
    expect((await bob.post(`${C}/${id}/messages`, { body: 'one too many' }).expect(422)).body).toMatchObject({ step: 'held-queue-full' });

    // still down: the re-screen releases nothing
    expect(await h.s.held.rescreen(h.tenantId)).toMatchObject({ delivered: 0, rejected: 0 });
    expect(bodies((await bob.get(`${C}/${id}/messages`).expect(200)).body)).toEqual(['bob during the outage', 'before the outage']);

    ollama.down = false;
    const [a, b] = await Promise.all([h.s.held.rescreen(h.tenantId), h.s.held.rescreen(h.tenantId)]);
    expect(a.delivered + b.delivered).toBe(3);
    expect(a.rejected + b.rejected).toBe(1);
    const seen = (await bob.get(`${C}/${id}/messages`).expect(200)).body as { id: string; body: string }[];
    expect(seen.filter((m) => m.id === clean.id)).toHaveLength(1);
    expect(seen.map((m) => m.body)).toEqual(['bob during the outage', 'during the outage, all fine', 'before the outage']);
    expect((await bob.get(`/api/feed/posts/${post.id}`).expect(200)).body).toMatchObject({ state: 'published', body: 'Posted during the outage' });
    // the unsafe one got a fresh verdict and was refused; its sender is told and keeps it as rejected
    expect((await alice.get(`${C}/${id}/messages`).expect(200)).body.find((m: { id: string }) => m.id === unsafe.id)).toMatchObject({ state: 'rejected' });
    expect(JSON.stringify((await alice.get('/api/me/notifications').expect(200)).body)).toMatch(/was not delivered/);
    // the one for a reviewer still waits
    expect((await ga.agent.get('/api/moderation/held/summary').expect(200)).body).toMatchObject({ review: 1, unavailable: 0 });
    expect((await h.s.db('audit_events').where({ action: 'moderation.held.delivered' })).length).toBe(3);
  });

  it('what waits on a check past its time is refused, never released', async () => {
    await seedGuard();
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Support', 'internal')).id;
    const alice = await personIn(h, 'alice', [ws]);
    const bob = await personIn(h, 'bob', [ws]);
    await reviewerWith(h, ws, [{ id: 'safety', name: 'Prompt safety', checkpoint: 'user-input', type: 'guard model', mechanism: { kind: 'guard-model', profile: 'llama-guard' }, action: 'block', stage: 'enforce' }]);
    const id = (await alice.post(C, { kind: 'direct', userId: bob.user.id }).expect(201)).body.id as string;
    ollama.down = true;
    const m = (await alice.post(`${C}/${id}/messages`, { body: 'never checked' }).expect(202)).body;
    await h.s.db('held_writes').where({ object_id: m.id }).update({ created_at: Date.now() - 73 * 3_600_000 });
    expect(await h.s.held.rescreen(h.tenantId)).toMatchObject({ expired: 1, delivered: 0 });
    expect(bodies((await bob.get(`${C}/${id}/messages`).expect(200)).body)).toEqual([]);
    expect((await alice.get(`${C}/${id}/messages`).expect(200)).body[0]).toMatchObject({ state: 'rejected' });
  });
});

describe('held messages over the socket (B-9404, the server side)', () => {
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
  }, 60_000);
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

  async function connect(m: Person, id: string) {
    const sock = ioClient(url, { path: '/socket.io', transports: ['websocket'], reconnection: false, extraHeaders: { cookie: m.cookie } });
    sockets.push(sock);
    await new Promise((r) => sock.on('ready', r));
    const got: { event: string; data: Record<string, unknown> }[] = [];
    sock.onAny((event: string, data: Record<string, unknown>) => void got.push({ event, data }));
    expect(await new Promise<{ ok: boolean }>((r) => sock.emit('room.join', { kind: 'conversation', id }, r))).toMatchObject({ ok: true });
    return got;
  }

  it('nothing reaches the other member while it is held; an accept reaches both, a rejection only the sender', async () => {
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Finance', 'confidential')).id;
    const alice = await personIn(h, 'alice', [ws]);
    const bob = await personIn(h, 'bob', [ws]);
    const { ga } = await reviewerWith(h, ws, [WIRE]);
    const id = (await alice.post(C, { kind: 'direct', userId: bob.user.id }).expect(201)).body.id as string;
    const [a, b] = [await connect(alice, id), await connect(bob, id)];

    const held = (await alice.post(`${C}/${id}/messages`, { body: 'a wire transfer' }).expect(202)).body;
    const item = (await ga.agent.get('/api/moderation/held').expect(200)).body.items[0];
    // until the accept, bob hears nothing about it
    await new Promise((r) => setTimeout(r, 100));
    expect(b.filter((x) => JSON.stringify(x.data).includes(held.id))).toEqual([]);
    await send(ga, 'post', `/api/moderation/held/${item.id}/decide`, { decision: 'accept' }).expect(200);
    await until(() => a.some((x) => x.event === 'conversation.message.created') && b.some((x) => x.event === 'conversation.message.created'));
    expect(b.filter((x) => x.event === 'conversation.message.created' && x.data.messageId === held.id)).toHaveLength(1);
    expect(a.find((x) => x.event === 'conversation.message.created')!.data).toMatchObject({ messageId: held.id, released: true });

    const second = (await alice.post(`${C}/${id}/messages`, { body: 'another wire transfer' }).expect(202)).body;
    const item2 = (await ga.agent.get('/api/moderation/held').expect(200)).body.items[0];
    await send(ga, 'post', `/api/moderation/held/${item2.id}/decide`, { decision: 'reject' }).expect(200);
    await until(() => a.some((x) => x.event === 'conversation.message.held'));
    expect(a.find((x) => x.event === 'conversation.message.held')!.data).toMatchObject({ messageId: second.id, state: 'rejected' });
    await new Promise((r) => setTimeout(r, 100));
    expect(b.some((x) => JSON.stringify(x.data).includes(second.id))).toBe(false);
  });
});
