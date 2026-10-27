import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeOllama } from './fake-ollama.js';
import { seedGateway } from './seed-gateway.js';
import { harness, localUser, login, type Harness } from './helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(10);
  }
}

describe('chat message groups', () => {
  let h: Harness;
  let ollama: FakeOllama;
  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    ollama = await new FakeOllama().start();
    await seedGateway(h, ollama, { label: 'internal' });
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  async function user(name: string, clearance: 'public' | 'internal' = 'internal') {
    const u = await localUser(h, name, ['member'], clearance);
    const c = await login(h, name);
    await h.s.db('users').where({ id: u.id }).update({ clearance });
    return {
      ...u,
      ...c,
      post: (p: string, b: object = {}) => c.agent.post(p).set('x-csrf-token', c.csrf).send(b),
      patch: (p: string, b: object = {}) => c.agent.patch(p).set('x-csrf-token', c.csrf).send(b),
      del: (p: string) => c.agent.delete(p).set('x-csrf-token', c.csrf)
    };
  }

  async function converse(o: Awaited<ReturnType<typeof user>>, text: string, conversationId?: string) {
    const sent = conversationId ? await o.post(`/api/conversations/${conversationId}/messages`, { content: text, profile: 'general' }).expect(202) : await o.post('/api/chat', { content: text, profile: 'general' }).expect(202);
    await until(async () => (await h.s.db('messages').where({ id: sent.body.messageId }).first()).completed_at != null);
    return { conversationId: (conversationId ?? sent.body.conversationId) as string, messageId: sent.body.messageId as string, userMessageId: sent.body.userMessageId as string };
  }

  const text = async (o: Awaited<ReturnType<typeof user>>, id: string) =>
    (
      await o.agent
        .get(`/api/conversation-exports/${id}/download`)
        .buffer(true)
        .parse((res, cb) => {
          let d = '';
          res.on('data', (c: Buffer) => (d += c.toString('utf8')));
          res.on('end', () => cb(null, d));
        })
        .expect(200)
    ).body as string;

  it('saves, lists, renames, changes and deletes groups; readers list them; groups export on their own', async () => {
    const owner = await user('owner');
    const reader = await user('reader');
    const low = await user('low', 'public');
    const one = await converse(owner, 'First idea');
    const two = await converse(owner, 'Second idea', one.conversationId);
    const three = await converse(owner, 'Final answer please', one.conversationId);
    const cid = one.conversationId;
    const other = await converse(owner, 'Another conversation');

    const g = (await owner.post(`/api/conversations/${cid}/groups`, { name: 'ideas', messageIds: [one.messageId, two.messageId, one.messageId] }).expect(201)).body;
    expect(g).toMatchObject({ conversationId: cid, name: 'ideas', messageIds: [one.messageId, two.messageId] });
    // Only messages of this conversation; a group keeps ids, never text, and its name is sealed.
    await owner.post(`/api/conversations/${cid}/groups`, { name: 'bad', messageIds: [other.messageId] }).expect(400);
    await owner.post(`/api/conversations/${cid}/groups`, { name: '', messageIds: [one.messageId] }).expect(400);
    await owner.post(`/api/conversations/${cid}/groups`, { name: 'none', messageIds: [] }).expect(400);
    const row = await h.s.db('chat_message_groups').where({ id: g.id }).first();
    expect(row.name).not.toContain('ideas');
    expect(row.message_ids).not.toContain('idea');

    const fin = (await owner.post(`/api/conversations/${cid}/groups`, { name: 'final answer', messageIds: [three.userMessageId, three.messageId] }).expect(201)).body;
    expect((await owner.agent.get(`/api/conversations/${cid}/groups`).expect(200)).body.map((x: { name: string }) => x.name)).toEqual(['ideas', 'final answer']);

    expect((await owner.patch(`/api/conversations/${cid}/groups/${g.id}`, { name: 'early ideas' }).expect(200)).body).toMatchObject({ name: 'early ideas', messageIds: [one.messageId, two.messageId] });
    expect((await owner.patch(`/api/conversations/${cid}/groups/${g.id}`, { messageIds: [two.messageId] }).expect(200)).body.messageIds).toEqual([two.messageId]);
    await owner.patch(`/api/conversations/${cid}/groups/${g.id}`, {}).expect(400);

    // Access follows the conversation's: nobody else until it is shared, then read-only, and only within clearance.
    await reader.agent.get(`/api/conversations/${cid}/groups`).expect(404);
    await owner.post(`/api/conversations/${cid}/shares`, { kind: 'user', userId: reader.id }).expect(201);
    expect((await reader.agent.get(`/api/conversations/${cid}/groups`).expect(200)).body).toHaveLength(2);
    await reader.post(`/api/conversations/${cid}/groups`, { name: 'mine', messageIds: [one.messageId] }).expect(404);
    await reader.patch(`/api/conversations/${cid}/groups/${g.id}`, { name: 'mine' }).expect(404);
    await reader.del(`/api/conversations/${cid}/groups/${g.id}`).expect(404);
    await low.agent.get(`/api/conversations/${cid}/groups`).expect(404);

    // A group exports on its own: only its messages, in the order they were written.
    const x = await owner.post(`/api/conversations/${cid}/exports`, { format: 'markdown', groupId: fin.id }).expect(202);
    expect(x.body).toMatchObject({ groupId: fin.id });
    expect(x.body.file).toMatch(/^conversation-\d{4}-\d{2}-\d{2}-group-[0-9a-z]{6}\.md$/);
    await h.s.jobs.runDue();
    const md = await text(owner, x.body.id);
    expect(md).toContain('- Group: final answer');
    expect(md).toContain('Final answer please');
    expect(md).toContain('You said: Final answer please');
    // The title is the first question; its messages are not in the group.
    expect(md).not.toContain('## Question\n\nFirst idea');
    expect(md).not.toContain('You said: First idea');
    expect(md).not.toContain('Second idea');

    const hx = await reader.post(`/api/conversations/${cid}/exports`, { format: 'html', groupId: g.id }).expect(202);
    await h.s.jobs.runDue();
    const html = await text(reader, hx.body.id);
    expect(html).toContain('You said: Second idea');
    expect(html).not.toContain('You said: First idea');
    expect(html).toContain('early ideas');

    const jx = await owner.post(`/api/conversations/${cid}/exports`, { format: 'json', groupId: g.id }).expect(202);
    await h.s.jobs.runDue();
    const doc = JSON.parse(await text(owner, jx.body.id));
    expect(doc.group).toEqual({ id: g.id, name: 'early ideas' });
    expect(doc.conversation.messages.map((m: { id: string }) => m.id)).toEqual([two.messageId]);

    // A group of another conversation is not found.
    await owner.post(`/api/conversations/${other.conversationId}/exports`, { format: 'pdf', groupId: g.id }).expect(404);

    await owner.del(`/api/conversations/${cid}/groups/${g.id}`).expect(204);
    await owner.del(`/api/conversations/${cid}/groups/${g.id}`).expect(404);
    expect((await owner.agent.get(`/api/conversations/${cid}/groups`).expect(200)).body.map((x2: { id: string }) => x2.id)).toEqual([fin.id]);

    // Deleting the conversation deletes its groups.
    await owner.del(`/api/conversations/${cid}`).expect(204);
    expect(await h.s.db('chat_message_groups').where({ conversation_id: cid })).toHaveLength(0);

    const actions = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).select('action')).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['conversation.group.created', 'conversation.group.updated', 'conversation.group.deleted', 'conversation.export.requested']));
  });
});
