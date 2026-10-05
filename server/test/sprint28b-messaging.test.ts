import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPrincipal } from '../src/http/middleware.js';
import { citeOnly } from '../src/messaging/insights.js';
import { attachRealtime } from '../src/realtime/socket.js';
import type { ProfileRow } from '../src/gateway/repo.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, login, type Harness } from './helpers.js';
import { drain } from './retrieval-seed.js';

/*
 * Sprint 28b, messaging (B-2601 to B-2606). The "done when" of each item is a test below:
 *   B-2601 a second direct conversation for a pair returns the first (also when both start it at once);
 *   B-2602 a deleted message leaves an audit entry, not its text;
 *   B-2603 a blocked user receives no typing or presence event;
 *   B-2604 a muted conversation sends no notification;
 *   B-2605 a summary cites only messages the reader can see;
 *   B-2606 a block in messaging is the shared `isBlocked` the feed uses (sprint28b-social.test.ts has the feed's part).
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
    principal: async () => (await loadPrincipal(h.s, h.tenantId, user.id, {}))!
  };
}

const C = '/api/messaging/conversations';
const M = '/api/messaging/messages';

describe('messaging (Sprint 28b)', () => {
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

  const group = async (who: Person, members: Person[], extra: Record<string, unknown> = {}) => (await who.post(C, { kind: 'group', workspaceId: ws, title: 'Type crit', memberIds: members.map((m) => m.user.id), ...extra }).expect(201)).body as { id: string; label: string };
  const say = async (who: Person, conv: string, body: string, extra: Record<string, unknown> = {}) => (await who.post(`${C}/${conv}/messages`, { body, ...extra }).expect(201)).body as { id: string; body: string; threadId: string | null };

  it('B-2601: one direct conversation per pair, also when both start it at once; roles in group conversations', async () => {
    const first = await alice.post(C, { kind: 'direct', userId: bob.user.id }).expect(201);
    expect(first.body).toMatchObject({ kind: 'direct', workspaceId: null, role: 'member', members: 2, with: { userId: bob.user.id, username: 'bob' } });
    // a second one for the pair, from either side, is the first
    expect((await alice.post(C, { kind: 'direct', userId: bob.user.id }).expect(200)).body.id).toBe(first.body.id);
    expect((await bob.post(C, { kind: 'direct', userId: alice.user.id }).expect(200)).body.id).toBe(first.body.id);
    // racing: both start a conversation with carol's pair at the same moment
    const raced = await Promise.all([alice.post(C, { kind: 'direct', userId: carol.user.id }), carol.post(C, { kind: 'direct', userId: alice.user.id }), alice.post(C, { kind: 'direct', userId: carol.user.id })]);
    expect(new Set(raced.map((r) => r.body.id)).size).toBe(1);
    expect(raced.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await h.s.db('dm_conversations').where({ kind: 'direct' }).count({ n: '*' }).then((r) => Number((r as { n: number }[])[0]!.n))).toBe(2);

    // outside the shared workspaces: unknown; with oneself: refused
    await alice.post(C, { kind: 'direct', userId: dave.user.id }).expect(404);
    await alice.post(C, { kind: 'direct', userId: alice.user.id }).expect(403);
    // the contact rule applies when starting one
    await carol.put('/api/social/settings', { contactRule: 'nobody' }).expect(200);
    await bob.post(C, { kind: 'direct', userId: carol.user.id }).expect(403);

    const g = await group(alice, [bob]);
    await alice.post(C, { kind: 'group', workspaceId: ws, memberIds: [dave.user.id] }).expect(422);
    expect((await bob.get(`${C}/${g.id}`).expect(200)).body).toMatchObject({ kind: 'group', title: 'Type crit', role: 'member', members: 2 });
    await dave.get(`${C}/${g.id}`).expect(404);
    // members do not add people; owners and admins do (within the contact rules)
    await bob.post(`${C}/${g.id}/members`, { userId: carol.user.id }).expect(403);
    await alice.post(`${C}/${g.id}/members`, { userId: carol.user.id }).expect(403); // carol accepts nobody
    await carol.put('/api/social/settings', { contactRule: 'workspace' }).expect(200);
    await alice.patch(`${C}/${g.id}/members/${bob.user.id}`, { role: 'admin' }).expect(200);
    await bob.post(`${C}/${g.id}/members`, { userId: carol.user.id }).expect(201);
    await bob.patch(`${C}/${g.id}/members/${carol.user.id}`, { role: 'owner' }).expect(403);
    await alice.del(`${C}/${g.id}/members/${alice.user.id}`).expect(409); // the last owner
    await bob.del(`${C}/${g.id}/members/${carol.user.id}`).expect(200);
    // direct conversations have no member management
    await alice.post(`${C}/${first.body.id}/members`, { userId: carol.user.id }).expect(409);

    // workspace membership is the outer boundary
    await h.s.tenants.removeMember(ws, bob.user.id);
    await bob.get(`${C}/${g.id}`).expect(404);
    await bob.get(`${C}/${first.body.id}`).expect(404);
    expect((await bob.get(C).expect(200)).body).toEqual([]);
    const listed = (await alice.get(C).expect(200)).body as { id: string }[];
    expect(listed.map((x) => x.id)).toEqual(expect.arrayContaining([g.id]));
  });

  it('B-2602: send, reply, thread, react, pin, forward, edit and delete; a deleted message leaves an audit entry, not its text', async () => {
    const events: { type: string; data: Record<string, unknown> }[] = [];
    h.s.bus.on<{ type: string; data: Record<string, unknown> }>('integration.event', (e) => void events.push(e));
    const g = await group(alice, [bob, carol]);
    const one = await say(alice, g.id, 'Kerning review on Thursday at ten');
    const raw = await h.s.db('dm_messages').where({ id: one.id }).first();
    expect(raw.body).not.toContain('Kerning'); // sealed at rest
    const reply = await say(bob, g.id, 'Works for me', { replyTo: one.id });
    expect(reply).toMatchObject({ body: 'Works for me' });
    const t1 = await say(carol, g.id, 'Which typeface?', { threadId: one.id });
    const t2 = await say(alice, g.id, 'Inter and Söhne', { threadId: t1.id });
    expect(t2.threadId).toBe(one.id); // threads are one level deep

    const main = (await bob.get(`${C}/${g.id}/messages`).expect(200)).body as { id: string; replyCount: number }[];
    expect(main.map((x) => x.id)).toEqual([reply.id, one.id]);
    expect(main.find((x) => x.id === one.id)!.replyCount).toBe(2);
    expect(((await bob.get(`${C}/${g.id}/messages?thread=${one.id}`).expect(200)).body as { id: string }[]).map((x) => x.id)).toEqual([t2.id, t1.id, one.id]);

    await bob.post(`${M}/${one.id}/reactions`, { emoji: '👍' }).expect(201);
    await carol.post(`${M}/${one.id}/reactions`, { emoji: '👍' }).expect(201);
    await carol.post(`${M}/${one.id}/reactions`, { emoji: 'has space' }).expect(400);
    await carol.del(`${M}/${one.id}/reactions/${encodeURIComponent('👍')}`).expect(200);
    await bob.post(`${M}/${one.id}/pin`).expect(403); // members of a group do not pin
    await alice.post(`${M}/${one.id}/pin`).expect(200);
    const pins = (await bob.get(`${C}/${g.id}/pins`).expect(200)).body;
    expect(pins).toEqual([expect.objectContaining({ id: one.id, pinned: true, reactions: [{ emoji: '👍', count: 1, mine: true }] })]);

    const dm = (await alice.post(C, { kind: 'direct', userId: bob.user.id }).expect(201)).body;
    const fwd = (await alice.post(`${M}/${one.id}/forward`, { conversationId: dm.id }).expect(201)).body;
    expect(fwd).toMatchObject({ conversationId: dm.id, body: 'Kerning review on Thursday at ten', forwardedFrom: one.id });

    await bob.patch(`${M}/${one.id}`, { body: 'changed' }).expect(403);
    const edited = (await alice.patch(`${M}/${one.id}`, { body: 'Kerning review moved to Friday' }).expect(200)).body;
    expect(edited).toMatchObject({ edited: true, body: 'Kerning review moved to Friday' });
    // members delete only their own; admins and owners anyone's
    await carol.del(`${M}/${reply.id}`).expect(403);
    await alice.del(`${M}/${reply.id}`).expect(200);
    await alice.del(`${M}/${one.id}`).expect(200);
    await alice.del(`${M}/${one.id}`).expect(404);

    const gone = await h.s.db('dm_messages').where({ id: one.id }).first();
    expect(gone).toMatchObject({ state: 'deleted', body: null, attachments: null });
    expect(await h.s.db('dm_terms').where({ message_id: one.id }).first()).toBeUndefined();
    expect(await h.s.db('dm_reactions').where({ message_id: one.id }).first()).toBeUndefined();
    const tomb = ((await bob.get(`${C}/${g.id}/messages`).expect(200)).body as { id: string; state: string; body: string | null }[]).find((x) => x.id === one.id);
    expect(tomb).toMatchObject({ state: 'deleted', body: null });

    const audit = (await h.s.db('audit_events').where('action', 'like', 'messaging.%').orderBy('seq')) as { action: string; target: string; detail: string | null }[];
    const del = audit.find((x) => x.action === 'messaging.message.deleted' && x.target.includes(one.id));
    expect(del).toBeTruthy();
    expect(audit.map((x) => x.action)).toEqual(expect.arrayContaining(['messaging.conversation.created', 'messaging.message.sent', 'messaging.message.edited', 'messaging.message.deleted', 'messaging.message.forwarded', 'messaging.message.pinned', 'messaging.reaction.added', 'messaging.reaction.removed']));
    // no audit entry carries a message's text
    const all = JSON.stringify(audit);
    for (const text of ['Kerning', 'Works for me', 'Söhne', 'Friday']) expect(all).not.toContain(text);
    expect(events.filter((e) => e.type.startsWith('message.')).map((e) => e.type)).toEqual(expect.arrayContaining(['message.sent', 'message.edited', 'message.deleted']));
    expect(events.find((e) => e.type === 'message.deleted')!.data).toEqual({ conversation: g.id, message: reply.id, actor: alice.user.id });
  });

  it('B-2604: attachments only after the file-store quarantine; a muted conversation sends no notification', async () => {
    const upload = (who: Person, name: string, data: string) => who.agent.put(`/api/files/uploads?${new URLSearchParams({ name, workspace: ws }).toString()}`).set('x-csrf-token', who.csrf).set('content-type', 'application/octet-stream').send(Buffer.from(data));
    const g = await group(alice, [bob]);
    const f = (await upload(alice, 'brief.txt', 'The brief.').expect(202)).body;
    // still in quarantine: refused
    await alice.post(`${C}/${g.id}/messages`, { body: 'See the brief', attachments: [f.id] }).expect(409);
    await drain(h);
    const sent = await say(alice, g.id, 'See the brief', { attachments: [f.id] });
    expect((sent as unknown as { attachments: unknown[] }).attachments).toEqual([expect.objectContaining({ fileId: f.id, name: 'brief.txt', state: 'ready' })]);
    // a file outside the conversation's workspace, or someone else's unreadable file, is refused
    const legal = await personIn(h, 'lena', [other]);
    const theirs = (await legal.agent.put(`/api/files/uploads?${new URLSearchParams({ name: 'x.txt', workspace: other }).toString()}`).set('x-csrf-token', legal.csrf).set('content-type', 'application/octet-stream').send(Buffer.from('x')).expect(202)).body;
    await drain(h);
    await alice.post(`${C}/${g.id}/messages`, { body: 'x', attachments: [theirs.id] }).expect(404);

    const notes = async (who: Person) => Number(((await h.s.db('notifications').where({ user_id: who.user.id, kind: 'message' }).count({ n: '*' })) as { n: number }[])[0]!.n);
    expect(await notes(bob)).toBe(1);
    expect(await notes(alice)).toBe(0);
    await bob.put(`${C}/${g.id}/settings`, { muted: true }).expect(200);
    await say(alice, g.id, 'Anyone?');
    expect(await notes(bob)).toBe(1);
    // muted for a while: still nothing; unmuted with mentions only: only when named
    await bob.put(`${C}/${g.id}/settings`, { mutedMinutes: 30 }).expect(200);
    await say(alice, g.id, 'Still nobody?');
    expect(await notes(bob)).toBe(1);
    await bob.put(`${C}/${g.id}/settings`, { muted: false, notify: 'mentions' }).expect(200);
    await say(alice, g.id, 'Hello all');
    expect(await notes(bob)).toBe(1);
    await say(alice, g.id, 'Hello @bob');
    expect(await notes(bob)).toBe(2);
    const n = await h.s.db('notifications').where({ user_id: bob.user.id, kind: 'message' }).orderBy('created_at', 'desc').first();
    expect(n.title).toBe('ALICE wrote in a group conversation');
    expect(JSON.stringify(n)).not.toContain('Hello');
    // a person bob muted (social mute) notifies him of nothing
    await bob.put(`${C}/${g.id}/settings`, { notify: 'all' }).expect(200);
    await bob.post('/api/social/mutes', { userId: alice.user.id }).expect(201);
    await say(alice, g.id, 'Ping @bob');
    expect(await notes(bob)).toBe(2);
  });

  it('B-2606: a block in messaging is the shared isBlocked; it stops direct messages and hides each other’s messages', async () => {
    const dm = (await alice.post(C, { kind: 'direct', userId: bob.user.id }).expect(201)).body;
    const g = await group(alice, [bob, carol]);
    await say(bob, g.id, 'from bob before');
    await bob.post('/api/social/blocks', { userId: alice.user.id }).expect(201);
    // the one check both messaging and the feed call
    expect(await h.s.social.isBlocked(h.tenantId, alice.user.id, bob.user.id)).toBe(true);
    const refused = (await alice.post(`${C}/${dm.id}/messages`, { body: 'hello?' }).expect(403)).body;
    expect(refused).toMatchObject({ step: 'contact', detail: 'This person does not accept messages from you.' });
    await bob.post(`${C}/${dm.id}/messages`, { body: 'hello?' }).expect(403);
    // in a group both stay, but neither sees the other's messages, reactions or receipts
    const fromAlice = await say(alice, g.id, 'from alice after');
    await say(carol, g.id, 'from carol');
    const forBob = ((await bob.get(`${C}/${g.id}/messages`).expect(200)).body as { body: string }[]).map((x) => x.body);
    expect(forBob).toEqual(['from carol', 'from bob before']);
    const forAlice = ((await alice.get(`${C}/${g.id}/messages`).expect(200)).body as { body: string }[]).map((x) => x.body);
    expect(forAlice).toEqual(['from carol', 'from alice after']);
    expect(((await carol.get(`${C}/${g.id}/messages`).expect(200)).body as unknown[]).length).toBe(3);
    await bob.post(`${M}/${fromAlice.id}/reactions`, { emoji: '👍' }).expect(404);
    expect(((await bob.get(`${C}/${g.id}/receipts`).expect(200)).body as { userId: string }[]).map((r) => r.userId).sort()).toEqual([bob.user.id, carol.user.id].sort());
    // bob is not notified of alice's messages
    const told = (await h.s.db('notifications').where({ user_id: bob.user.id, kind: 'message' }).select('title')) as { title: string }[];
    expect(told.map((n) => n.title)).toEqual(['CAROL wrote in a group conversation']);
  });

  it('messages are a moderation object type: a report by someone who can see it makes a flag', async () => {
    const g = await group(alice, [bob]);
    const m = await say(alice, g.id, 'Something to report');
    await carol.post('/api/moderation/reports', { type: 'dm-message', id: m.id, reason: 'Spam' }).expect(404);
    const rep = await bob.post('/api/moderation/reports', { type: 'dm-message', id: m.id, reason: 'Rude' }).expect(201);
    const flag = await h.s.db('guard_flags').where({ id: rep.body.flag.id }).first();
    expect(flag).toMatchObject({ source_kind: 'dm-message', source_id: m.id, workspace_id: ws });
    expect(h.s.moderation.registry.get('dm-message')).toBeTruthy();
  });

  it('needs messages:read and messages:write', async () => {
    await h.s.users.setRoles(carol.user.id, 'direct', ['flag-reviewer']);
    const c = await login(h, 'carol');
    await c.agent.get(C).expect(403);
    await c.agent.post(C).set('x-csrf-token', c.csrf).send({ kind: 'direct', userId: alice.user.id }).expect(403);
  });
});

describe('search, summaries and digests (B-2605)', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let ws: string;

  beforeEach(async () => {
    ollama = await new FakeOllama().start();
    h = await harness({ MESSAGING_EMBED_MODEL: 'nomic-embed-text' });
    ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Design', 'confidential')).id;
    const repo = h.s.gateway.repo;
    const pool = await repo.createPool({ name: 'gpu', accelerator: 'cuda', zone: 'inference', labelCeiling: 'confidential' });
    await repo.createInstance({ poolId: pool.id, name: 'gpu-1', url: ollama.url, deploy: 'docker', settings: { parallel: 8 } });
    const ids: Record<string, string> = {};
    for (const [name, caps] of [
      ['nomic-embed-text', ['embedding']],
      ['llama3.1:8b', ['completion']]
    ] as const) {
      ollama.addAvailable({ name, size: 1e9, capabilities: [...caps] });
      const m = await repo.createModel({ name, source: 'Ollama library', expectedDigest: null, license: { name: 'test' }, label: 'confidential', notes: null, requestedBy: 'x', requestedTenant: h.tenantId });
      await repo.updateModel(m.id, { state: 'approved', import_state: 'pulled', capabilities: [...caps], size_bytes: 1e9 });
      await repo.place(m.id, pool.id, 'warm', 'x');
      ids[name] = m.id;
    }
    const t = Date.now();
    const general: ProfileRow = { id: 'GENERAL'.padEnd(26, '0'), tenant_id: h.tenantId, name: 'general', display_name: 'General', description: null, alias_of: null, model_id: ids['llama3.1:8b']!, pool_id: pool.id, num_ctx: 8192, temperature: 0.2, think_default: 'off', think_ceiling: 'off', system_prompt: null, fallback: null, canary: null, tools: [], label: 'confidential', status: 'published', version: 1, updated_by: null, created_at: t, updated_at: t };
    await repo.createProfile(general);
    await h.s.gateway.pollAll();
  }, 60_000);
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  it('keyword and semantic search over what the reader can see; summaries cite only messages the reader can see', async () => {
    const alice = await personIn(h, 'alice', [ws]);
    const bob = await personIn(h, 'bob', [ws]);
    const carol = await personIn(h, 'carol', [ws]);
    const g = (await alice.post(C, { kind: 'group', workspaceId: ws, memberIds: [bob.user.id] }).expect(201)).body;
    const say = async (who: Person, body: string, extra: Record<string, unknown> = {}) => (await who.post(`${C}/${g.id}/messages`, { body, ...extra }).expect(201)).body as { id: string };
    const early = await say(alice, 'The secret launch date is the ninth of March');
    await new Promise((r) => setTimeout(r, 5));
    // carol joins later: she reads from then on
    await alice.post(`${C}/${g.id}/members`, { userId: carol.user.id }).expect(201);
    await new Promise((r) => setTimeout(r, 5));
    const budget = await say(alice, 'Budget review for the printing costs');
    const fromBob = await say(bob, 'Printing budget needs another quote', { threadId: budget.id });
    const later = await say(alice, 'Lunch at noon tomorrow');
    await carol.post('/api/social/blocks', { userId: bob.user.id }).expect(201);
    await drain(h);
    expect(await h.s.db('vectors').where({ collection: 'dm-messages' }).count({ n: '*' }).then((r) => Number((r as { n: number }[])[0]!.n))).toBe(4);

    const kw = (await carol.get(`${C}/${g.id}/search?q=budget printing&mode=keyword`).expect(200)).body as { id: string; score: { keyword: number } }[];
    expect(kw.map((x) => x.id)).toEqual([budget.id]); // bob's is left out (blocked), not just ranked lower
    const kwAlice = (await alice.get(`${C}/${g.id}/search?q=budget printing&mode=keyword`).expect(200)).body as { id: string }[];
    expect(kwAlice.map((x) => x.id).sort()).toEqual([budget.id, fromBob.id].sort());
    expect(((await carol.get(`${C}/${g.id}/search?q=launch secret&mode=keyword`).expect(200)).body as unknown[]).length).toBe(0);
    const sem = (await carol.get(`${C}/${g.id}/search?q=printing costs budget&mode=semantic`).expect(200)).body as { id: string; score: { semantic: number } }[];
    expect(sem[0]!.id).toBe(budget.id);
    expect(sem.map((x) => x.id)).not.toContain(early.id);
    expect(sem.map((x) => x.id)).not.toContain(fromBob.id);
    const hybrid = (await alice.get(`${C}/${g.id}/search?q=lunch`).expect(200)).body as { id: string }[];
    expect(hybrid[0]!.id).toBe(later.id);

    // The model cites [1] to [3] and some numbers that do not exist.
    let prompt = '';
    ollama.reply = (messages) => {
      prompt = messages.map((m) => m.content).join('\n');
      return { content: 'Printing needs a budget review [1][2]. Lunch is at noon [2]. Also see [5] and [0].' };
    };
    const sum = (await carol.post(`${C}/${g.id}/summary`, {}).expect(200)).body as { summary: string; citations: { n: number; messageId: string }[]; messages: number };
    expect(sum.messages).toBe(2);
    expect(prompt).toContain('Budget review for the printing costs');
    expect(prompt).toContain('Lunch at noon');
    for (const hidden of ['secret launch', 'another quote']) expect(prompt).not.toContain(hidden);
    expect(sum.citations).toEqual([
      { n: 1, messageId: budget.id },
      { n: 2, messageId: later.id }
    ]);
    expect(sum.summary).not.toContain('[5]');
    expect(sum.summary).not.toContain('[0]');
    const visible = new Set(((await carol.get(`${C}/${g.id}/messages`).expect(200)).body as { id: string }[]).map((x) => x.id));
    for (const c of sum.citations) expect(visible.has(c.messageId)).toBe(true);

    // A thread summary for alice includes bob's reply; the digest is what she has not read.
    const thread = (await alice.post(`${C}/${g.id}/summary`, { threadId: budget.id }).expect(200)).body;
    expect(thread).toMatchObject({ kind: 'thread', messages: 2 });
    await bob.post(`${C}/${g.id}/read`, { messageId: budget.id }).expect(200);
    const digest = (await bob.post(`${C}/${g.id}/digest`, {}).expect(200)).body;
    expect(digest).toMatchObject({ kind: 'digest', messages: 1 }); // "Lunch" (his own reply is not news to him)
    await bob.post(`${C}/${g.id}/read`, { messageId: later.id }).expect(200);
    expect((await bob.post(`${C}/${g.id}/digest`, {}).expect(200)).body).toMatchObject({ messages: 0, summary: null });
    expect(await h.s.db('audit_events').where({ action: 'messaging.summary.created' }).first()).toBeTruthy();
  });

  it('keeps only citations of the given messages', () => {
    expect(citeOnly('A [1] B [3] C [2][9] .', ['x', 'y'])).toEqual({ text: 'A [1] B  C [2].', citations: [{ n: 1, messageId: 'x' }, { n: 2, messageId: 'y' }] });
  });
});

describe('the conversation room (B-2603)', () => {
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
    const join = (id: string) => new Promise<{ ok: boolean }>((r) => sock.emit('room.join', { kind: 'conversation', id }, r));
    const signal = (id: string, s: string, data: Record<string, unknown> = {}) => new Promise<{ ok: boolean; error?: string }>((r) => sock.emit('room.signal', { kind: 'conversation', id, signal: s, data }, r));
    return { sock, got, join, signal };
  }

  it('delivery, receipts, typing and presence; a blocked user receives no typing or presence event', async () => {
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Design', 'internal')).id;
    const alice = await personIn(h, 'alice', [ws]);
    const bob = await personIn(h, 'bob', [ws]);
    const carol = await personIn(h, 'carol', [ws]);
    const eve = await personIn(h, 'eve', [ws]);
    const g = (await alice.post(C, { kind: 'group', workspaceId: ws, memberIds: [bob.user.id, carol.user.id] }).expect(201)).body;
    // bob blocks alice
    await bob.post('/api/social/blocks', { userId: alice.user.id }).expect(201);
    const [b, c, e] = [await connect(bob), await connect(carol), await connect(eve)];
    expect(await b.join(g.id)).toMatchObject({ ok: true });
    expect(await c.join(g.id)).toMatchObject({ ok: true });
    expect(await e.join(g.id)).toMatchObject({ ok: false }); // not a member
    expect(await e.signal(g.id, 'typing')).toMatchObject({ ok: false });

    // alice comes online and types: carol hears both, bob neither
    const a = await connect(alice);
    expect(await a.join(g.id)).toMatchObject({ ok: true });
    await until(() => c.got.some((x) => x.event === 'conversation.presence' && x.data.userId === alice.user.id));
    expect(await a.signal(g.id, 'typing', { typing: true })).toMatchObject({ ok: true });
    await until(() => c.got.some((x) => x.event === 'conversation.typing' && x.data.userId === alice.user.id));
    // a message from alice: carol is told, bob is not
    const msg = (await alice.post(`${C}/${g.id}/messages`, { body: 'hi all' }).expect(201)).body;
    await until(() => c.got.some((x) => x.event === 'conversation.message.created'));
    expect(c.got.find((x) => x.event === 'conversation.message.created')!.data).toMatchObject({ kind: 'conversation', id: g.id, messageId: msg.id, authorId: alice.user.id });
    expect(JSON.stringify(c.got)).not.toContain('hi all');
    // carol's receipts over the socket reach alice; bob's typing reaches carol but not alice
    expect(await c.signal(g.id, 'delivered', { messageId: msg.id })).toMatchObject({ ok: true });
    expect(await c.signal(g.id, 'read', { messageId: msg.id })).toMatchObject({ ok: true });
    await until(() => a.got.some((x) => x.event === 'conversation.read' && x.data.userId === carol.user.id));
    expect(a.got.some((x) => x.event === 'conversation.delivered' && x.data.userId === carol.user.id)).toBe(true);
    expect(await b.signal(g.id, 'typing', { typing: true })).toMatchObject({ ok: true });
    await until(() => c.got.some((x) => x.event === 'conversation.typing' && x.data.userId === bob.user.id));
    // alice leaves: carol sees her offline
    a.sock.close();
    await until(() => c.got.some((x) => x.event === 'conversation.presence' && x.data.userId === alice.user.id && x.data.state === 'offline'));
    await new Promise((r) => setTimeout(r, 50));

    const fromAlice = b.got.filter((x) => x.data?.userId === alice.user.id || x.data?.authorId === alice.user.id);
    expect(fromAlice).toEqual([]);
    expect(b.got.some((x) => x.event === 'conversation.typing')).toBe(false);
    expect(a.got.some((x) => x.event === 'conversation.typing' && x.data.userId === bob.user.id)).toBe(false);
    expect(e.got.some((x) => x.event.startsWith('conversation.'))).toBe(false);
    const receipts = (await alice.get(`${C}/${g.id}/receipts`).expect(200)).body as { userId: string; lastReadId: string | null; deliveredId: string | null }[];
    expect(receipts.find((r) => r.userId === carol.user.id)).toMatchObject({ lastReadId: msg.id, deliveredId: msg.id });
    expect(receipts.map((r) => r.userId)).not.toContain(bob.user.id);
  });

  it('a removed member’s room closes at once', async () => {
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Design', 'internal')).id;
    const alice = await personIn(h, 'alice', [ws]);
    const bob = await personIn(h, 'bob', [ws]);
    const g = (await alice.post(C, { kind: 'group', workspaceId: ws, memberIds: [bob.user.id] }).expect(201)).body;
    const b = await connect(bob);
    expect(await b.join(g.id)).toMatchObject({ ok: true });
    await alice.del(`${C}/${g.id}/members/${bob.user.id}`).expect(200);
    await until(() => b.got.some((x) => x.event === 'room.closed'));
    await alice.post(`${C}/${g.id}/messages`, { body: 'after' }).expect(201);
    await new Promise((r) => setTimeout(r, 50));
    expect(b.got.some((x) => x.event === 'conversation.message.created')).toBe(false);
  });
});
