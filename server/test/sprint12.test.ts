import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app.js';
import { createLogger, Metrics } from '../src/observability/index.js';
import { createServices, type Services } from '../src/services.js';
import { TOPICS } from '../src/platform/bus.js';
import { lastBoundaryEnd, MAX_HOLD_CHARS, StreamGuard } from '../src/guardrails/stream.js';
import type { GuardAction, GuardDecision } from '../src/guardrails/types.js';
import { passageSpan } from '../src/chat/context.js';
import { FakeOllama } from './fake-ollama.js';
import { seedGateway } from './seed-gateway.js';
import { harness, localUser, login, loginAdmin, PASSWORD, type Client, type Harness } from './helpers.js';
import { client, drain, seedRetrieval } from './retrieval-seed.js';

/** A screen that fires `action` when `trigger` appears anywhere in the text, recording what it saw. */
function screen(trigger: string | null, action: GuardAction = 'block') {
  const seen: string[] = [];
  const fn = async (text: string): Promise<GuardDecision> => {
    seen.push(text);
    const at = trigger ? text.indexOf(trigger) : -1;
    if (at < 0) return { action: 'allow', text, findings: [] };
    return { action, text, findings: [{ ruleId: 'r', ruleName: 'Test rule', action, stage: 'enforce', span: [at, at + trigger!.length] }], reason: `${action} by test` };
  };
  return Object.assign(fn, { seen });
}

describe('streaming guard (B-201)', () => {
  it('finds sentence and line boundaries, and releases a long run without one', () => {
    expect(lastBoundaryEnd('One. Two. Thr', 0)).toBe(10);
    expect(lastBoundaryEnd('a line\nmore', 0)).toBe(7);
    expect(lastBoundaryEnd('pi is 3.14', 0)).toBe(-1);
    const long = 'x'.repeat(MAX_HOLD_CHARS + 5);
    expect(lastBoundaryEnd(long, 0)).toBe(long.length);
  });

  it('releases only screened prefixes, never twice, and screens the whole buffer', async () => {
    const s = screen('for bidden');
    const g = new StreamGuard(s);
    expect((await g.push('Hello ')).text).toBe('');
    expect((await g.push('there. Next')).text).toBe('Hello there. ');
    expect((await g.finish()).text).toBe('Next');
    expect(g.released).toBe('Hello there. Next');
    const g2 = new StreamGuard(s);
    await g2.push('this is for ');
    const r = await g2.push('bidden. ');
    expect(r).toMatchObject({ halted: true, text: '' });
    expect(s.seen.every((t) => g2.buffered.startsWith(t) || g.buffered.startsWith(t))).toBe(true);
    expect((await g2.push('More. ')).text).toBe('');
    expect((await g2.finish()).text).toBe('');
    expect(g2.released).toBe('');
  });

  it('holds on require-approval, redacts spans, and streams through a warning', async () => {
    const held = new StreamGuard(screen('review me', 'require-approval'));
    expect((await held.push('Fine. ')).text).toBe('Fine. ');
    expect(await held.push('Please review me. ')).toMatchObject({ held: true, text: '' });
    expect((await held.push('After. ')).text).toBe('');
    const red = new StreamGuard(screen('4111', 'redact'));
    expect((await red.push('Card 4111 is on file. ')).text).toBe('Card [redacted] is on file. ');
    const warn = new StreamGuard(screen('meh', 'warn'));
    expect((await warn.push('meh but fine. ')).text).toBe('meh but fine. ');
  });

  it('continues after preloaded text without releasing it again', async () => {
    const g = new StreamGuard(screen(null));
    g.preload('Already shown. ');
    expect((await g.push('And more. ')).text).toBe('And more. ');
    expect(g.released).toBe('Already shown. And more. ');
  });

  it('picks the passage of a chunk that an answer draws on', () => {
    const chunk = 'Intro line about nothing. Q3 travel: budget 361,500, actual 412,880. The Lisbon onboarding overran.';
    const [s, e] = passageSpan(chunk, 'Travel came in at 412,880 against a budget of 361,500 [1].');
    expect(chunk.slice(s, e)).toContain('412,880');
    expect(chunk.slice(s, e)).not.toContain('Intro line');
    expect(passageSpan('No overlap here at all.', 'zzz')).toEqual([0, 'No overlap here at all.'.length]);
  });
});

describe('chat, sprint 12', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let admin: Client;
  const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);
  const put = (c: Client, url: string, body: object) => c.agent.put(url).set('x-csrf-token', c.csrf).send(body);

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    ollama = await new FakeOllama().start();
    ollama.chatDelayMs = 2;
    await localUser(h, 'ga', ['guardrail-admin'], 'confidential');
    admin = await loginAdmin(h, 'ga');
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  async function member(name = 'mem', clearance: 'internal' | 'confidential' = 'confidential') {
    await localUser(h, name, ['member'], clearance);
    const c = await login(h, name);
    return { ...c, post: (url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body) };
  }

  async function finished(messageId: string, s: Services = h.s) {
    for (let i = 0; i < 400; i++) {
      const m = await s.db('messages').where({ id: messageId }).first();
      if (m?.completed_at || m?.state === 'interrupted') return m;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('answer did not finish');
  }

  async function tenantSet(rules: object[], name = 'Chat rules') {
    const set = (await post(admin, '/api/admin/guardrails/sets', { name, scope: 'tenant' }).expect(201)).body;
    await put(admin, `/api/admin/guardrails/sets/${set.id}/draft`, { rules }).expect(200);
    await post(admin, `/api/admin/guardrails/sets/${set.id}/draft/publish`).expect(200);
    return set as { id: string };
  }

  /** Every chat event published for delivery to sockets (the socket layer relays exactly these). */
  function tap(s: Services = h.s) {
    const events: { userId: string; event: string; data: Record<string, unknown> }[] = [];
    s.bus.on<{ userId: string; event: string; data: Record<string, unknown> }>(TOPICS.chatEvent, (e) => void events.push(e));
    return events;
  }

  it('never sends a blocked phrase to the socket, stops the model, and still runs the full check (B-201)', async () => {
    await seedGateway(h, ollama);
    await tenantSet([{ id: 'no-codename', name: 'No codename', checkpoint: 'model-output', type: 'pattern', mechanism: { kind: 'pattern', pattern: '(?i)project bluebird' }, action: 'block', stage: 'enforce' }]);
    const m = await member();
    const events = tap();
    ollama.chatDelayMs = 10;
    ollama.reply = () => ({ content: 'The plan is ready. It is called Project Blue' + 'bird internally. ' + 'Filler sentence. '.repeat(40) });
    const sent = await m.post('/api/chat', { content: 'What is the plan?', profile: 'general' }).expect(202);
    const stored = await finished(sent.body.messageId);
    const chunks = events.filter((e) => e.event === 'chat.chunk' && e.data.messageId === sent.body.messageId).map((e) => String(e.data.delta ?? ''));
    expect(chunks.join('')).toBe('The plan is ready. ');
    expect(JSON.stringify(events)).not.toMatch(/bluebird/i);
    const done = events.find((e) => e.event === 'chat.done' && e.data.messageId === sent.body.messageId)!;
    expect(done.data).toMatchObject({ state: 'complete', guard: { action: 'block', rules: ['No codename'] } });
    const view = (await m.agent.get(`/api/conversations/${sent.body.conversationId}`).expect(200)).body;
    expect(view.messages[1].content).toMatch(/^This answer was withheld\. Blocked by the guardrail "No codename"/);
    expect(Number(stored.seq)).toBeGreaterThan(chunks.length);
    // the generation stopped early: far fewer tokens than the 80-odd words of the reply
    expect(Number(stored.output_tokens)).toBeLessThan(40);
    // the finished answer went through the recorded checkpoint as well
    const decision = await h.s.db('guard_decisions').where({ checkpoint: 'model-output', source_id: sent.body.messageId }).first();
    expect(decision).toMatchObject({ action: 'block' });
  });

  it('streams a clean answer sentence by sentence and screens thinking too', async () => {
    await seedGateway(h, ollama);
    await tenantSet([{ id: 'no-codename', name: 'No codename', checkpoint: 'model-output', type: 'pattern', mechanism: { kind: 'pattern', pattern: '(?i)bluebird' }, action: 'block', stage: 'enforce' }]);
    const m = await member();
    const events = tap();
    ollama.reply = () => ({ content: 'One. Two. Three.' });
    const sent = await m.post('/api/chat', { content: 'Count', profile: 'general' }).expect(202);
    await finished(sent.body.messageId);
    const chunks = events.filter((e) => e.event === 'chat.chunk' && e.data.messageId === sent.body.messageId).map((e) => e.data);
    expect(chunks.map((c) => c.delta)).toEqual(['One. ', 'Two. ', 'Three.']);
    expect(chunks.map((c) => c.seq)).toEqual([1, 2, 3]);
  });

  it('holds an answer for review: invisible until approved, withdrawn when rejected (B-202)', async () => {
    await seedGateway(h, ollama);
    await tenantSet([{ id: 'legal-review', name: 'Legal review', checkpoint: 'model-output', type: 'pattern', mechanism: { kind: 'pattern', pattern: '(?i)settlement offer' }, action: 'require-approval', stage: 'enforce', severity: 'high' }]);
    const m = await member();
    const events = tap();
    ollama.reply = () => ({ content: 'Some context first. The settlement offer is 40,000. Then more detail follows.' });
    const sent = await m.post('/api/chat', { content: 'What do we offer?', profile: 'general' }).expect(202);
    const stored = await finished(sent.body.messageId);
    expect(stored.state).toBe('held');
    expect(JSON.stringify(events.filter((e) => e.event === 'chat.chunk'))).not.toMatch(/settlement/);
    expect(events.find((e) => e.event === 'chat.done' && e.data.messageId === sent.body.messageId)!.data).toMatchObject({ state: 'held' });
    // the owner sees only the state, from the view and from catch-up
    const view = (await m.agent.get(`/api/conversations/${sent.body.conversationId}`).expect(200)).body;
    expect(view.messages[1]).toMatchObject({ state: 'held', content: '' });
    const resume = (await m.agent.get(`/api/conversations/${sent.body.conversationId}/messages/${sent.body.messageId}/stream?after=0`).expect(200)).body;
    expect(resume).toMatchObject({ state: 'held', content: '' });
    // it is stored whole and sealed
    expect(stored.content).toMatch(/^v2\./);
    // the reviewer sees the full answer in the flag queue
    const queue = (await admin.agent.get('/api/flags').expect(200)).body;
    const item = queue.items.find((f: { kind: string }) => f.kind === 'hold');
    expect(item).toMatchObject({ action: 'require-approval', rule: 'Legal review', conversationId: sent.body.conversationId });
    const detail = (await admin.agent.get(`/api/flags/${item.ref}`).expect(200)).body;
    expect(detail.held).toMatchObject({ messageId: sent.body.messageId, state: 'held', content: 'Some context first. The settlement offer is 40,000. Then more detail follows.' });
    await post(admin, `/api/flags/${item.ref}/decide`, { decision: 'confirmed' }).expect(409);
    // a member cannot decide; the reviewer approves
    await m.post(`/api/flags/${item.ref}/decide`, { decision: 'approved' }).expect(403);
    const approved = (await post(admin, `/api/flags/${item.ref}/decide`, { decision: 'approved', reason: 'Cleared by legal' }).expect(200)).body;
    expect(approved.state).toBe('approved');
    expect(events.find((e) => e.event === 'chat.released')!.data).toMatchObject({ messageId: sent.body.messageId, state: 'complete' });
    const after = (await m.agent.get(`/api/conversations/${sent.body.conversationId}`).expect(200)).body;
    expect(after.messages[1]).toMatchObject({ state: 'complete', content: 'Some context first. The settlement offer is 40,000. Then more detail follows.', guard: { action: 'require-approval', review: { decision: 'approved' } } });
    const notes = (await m.agent.get('/api/me/notifications').expect(200)).body;
    expect(JSON.stringify(notes)).toMatch(/held for review is now available/);
    const audit = await h.s.db('audit_events').whereIn('action', ['chat.held', 'chat.hold.approved']).select('action');
    expect(audit.map((a: { action: string }) => a.action).sort()).toEqual(['chat.held', 'chat.hold.approved']);

    // a second held answer, rejected: withdrawn, and its text is gone
    const again = await m.post(`/api/conversations/${sent.body.conversationId}/messages`, { content: 'And again?', profile: 'general' }).expect(202);
    await finished(again.body.messageId);
    const ref = (await admin.agent.get('/api/flags').expect(200)).body.items.find((f: { kind: string; state: string }) => f.kind === 'hold').ref;
    await post(admin, `/api/flags/${ref}/decide`, { decision: 'rejected' }).expect(200);
    await post(admin, `/api/flags/${ref}/decide`, { decision: 'approved' }).expect(409);
    const final = (await m.agent.get(`/api/conversations/${sent.body.conversationId}`).expect(200)).body;
    const rejected = final.messages.find((x: { id: string }) => x.id === again.body.messageId);
    expect(rejected).toMatchObject({ state: 'withdrawn', content: 'This answer was withdrawn after review.' });
    // withdrawn and held answers never go back to the model
    const third = await m.post(`/api/conversations/${sent.body.conversationId}/messages`, { content: 'Summarise.', profile: 'general' }).expect(202);
    await finished(third.body.messageId);
    const last = ollama.requests.filter((r) => r.path === '/api/chat').pop()!.body.messages as { role: string; content: string }[];
    expect(JSON.stringify(last)).not.toContain('withdrawn after review');
  });

  it('catches up from a second instance, and continues an interrupted answer there (B-203)', async () => {
    await seedGateway(h, ollama);
    const m = await member();
    // A second app instance on the same database: its own chat service, bus and stream map.
    const s2 = createServices(h.s.cfg, h.s.db, createLogger('silent', false), new Metrics());
    const app2 = createApp(s2);
    try {
      const other = request.agent(app2);
      const login2 = await other.post('/api/auth/login').send({ username: 'mem', password: PASSWORD }).expect(200);
      const csrf2 = login2.body.csrf as string;
      ollama.chatDelayMs = 15;
      const sentences = Array.from({ length: 60 }, (_, i) => `Sentence ${i + 1}.`);
      ollama.reply = () => ({ content: sentences.join(' ') });
      const sent = await m.post('/api/chat', { content: 'Talk', profile: 'general' }).expect(202);
      const url = `/api/conversations/${sent.body.conversationId}/messages/${sent.body.messageId}/stream`;
      // Wait until some of the answer has been produced on instance one.
      for (let i = 0; i < 200; i++) {
        const row = await h.s.db('messages').where({ id: sent.body.messageId }).first();
        if (row.state === 'streaming' && (await h.s.db('chat_stream_chunks').where({ message_id: sent.body.messageId }).first())) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const first = (await other.get(`${url}?after=0`).expect(200)).body;
      expect(first.state).toBe('streaming');
      let text = first.content ?? first.chunks.map((c: { delta?: string }) => c.delta ?? '').join('');
      let seq = first.seq as number;
      expect(seq).toBeGreaterThan(0);
      expect(sentences.join(' ').startsWith(text)).toBe(true);
      // later reads continue exactly where the last one stopped
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 350));
        const next = (await other.get(`${url}?after=${seq}`).expect(200)).body;
        if (next.chunks) {
          if (next.chunks.length) expect(next.chunks[0].seq).toBe(seq + 1);
          text += next.chunks.map((c: { delta?: string }) => c.delta ?? '').join('');
        } else text = next.content;
        seq = next.seq;
        expect(sentences.join(' ').startsWith(text)).toBe(true);
      }
      expect(text.length).toBeGreaterThan(0);
      const done = await finished(sent.body.messageId);
      expect(done.state).toBe('complete');
      const end = (await other.get(`${url}?after=${seq}`).expect(200)).body;
      expect(end.state).toBe('complete');
      expect(await h.s.db('chat_stream_chunks').where({ message_id: sent.body.messageId })).toHaveLength(0);

      // An answer whose instance died: streaming, with a stale heartbeat, generated by nobody alive.
      const conv = sent.body.conversationId;
      const mid = '01J0DEADDEADDEADDEADDEAD00';
      const user = await h.s.db('messages').where({ conversation_id: conv, role: 'user' }).first();
      const tid = user.tenant_id;
      await h.s.db('messages').insert({ id: mid, conversation_id: conv, tenant_id: tid, parent_id: sent.body.messageId, role: 'assistant', content: await h.s.keys.seal(tid, 'The first half of the answer.', `content:${mid}`), state: 'streaming', profile_id: 'GENERAL0000000000000000000', profile_name: 'general', model: 'llama3.1:8b', label: 'internal', seq: 7, canary: false, created_at: Date.now() - 120_000, generator: 'gone', heartbeat_at: Date.now() - 120_000 });
      const userQ = '01J0USERUSERUSERUSERUSER00';
      await h.s.db('messages').where({ id: mid }).update({ parent_id: userQ });
      await h.s.db('messages').insert({ id: userQ, conversation_id: conv, tenant_id: tid, parent_id: sent.body.messageId, role: 'user', content: await h.s.keys.seal(tid, 'Tell me more.', `content:${userQ}`), state: 'complete', label: 'internal', seq: 0, canary: false, created_at: Date.now() - 121_000, completed_at: Date.now() - 121_000 });
      const events2 = tap(s2);
      const caught = (await other.get(`/api/conversations/${conv}/messages/${mid}/stream?after=3`).expect(200)).body;
      expect(caught).toMatchObject({ state: 'interrupted', content: 'The first half of the answer.', seq: 7 });
      expect(events2.find((e) => e.event === 'chat.done' && e.data.messageId === mid)!.data).toMatchObject({ state: 'interrupted' });
      expect(await h.s.db('audit_events').where({ action: 'chat.interrupted' }).first()).toBeTruthy();
      // continue it from instance two
      ollama.chatDelayMs = 1;
      ollama.reply = (messages) => ({ content: messages[messages.length - 1]!.role === 'assistant' ? ' And the second half.' : 'unexpected' });
      await other.post(`/api/conversations/${conv}/messages/${mid}/continue`).set('x-csrf-token', csrf2).send({}).expect(202);
      const cont = await finished(mid, s2);
      expect(cont.state).toBe('complete');
      const req = ollama.requests.filter((r) => r.path === '/api/chat').pop()!.body.messages as { role: string; content: string }[];
      expect(req[req.length - 1]).toEqual({ role: 'assistant', content: 'The first half of the answer.' });
      const v = (await other.get(`/api/conversations/${conv}`).expect(200)).body.messages.find((x: { id: string }) => x.id === mid);
      expect(v).toMatchObject({ state: 'complete', content: 'The first half of the answer. And the second half.' });
      expect(v.seq).toBeGreaterThan(7);
      const contChunks = events2.filter((e) => e.event === 'chat.chunk' && e.data.messageId === mid);
      expect(contChunks[0]!.data.seq).toBe(8);
      // a complete answer cannot be continued
      await other.post(`/api/conversations/${conv}/messages/${mid}/continue`).set('x-csrf-token', csrf2).send({}).expect(409);
    } finally {
      await s2.close();
    }
  });

  it('marks an answer interrupted when its instance shuts down, and the sweep finds silent ones', async () => {
    await seedGateway(h, ollama);
    const m = await member();
    let release!: () => void;
    ollama.hold = new Promise<void>((r) => (release = r));
    const sent = await m.post('/api/chat', { content: 'Wait', profile: 'general' }).expect(202);
    for (let i = 0; i < 100 && (await h.s.db('messages').where({ id: sent.body.messageId }).first()).state !== 'streaming'; i++) await new Promise((r) => setTimeout(r, 20));
    h.s.chat.close();
    const row = await finished(sent.body.messageId);
    expect(row.state).toBe('interrupted');
    release();
    // a silent answer found by the sweep job
    await h.s.db('messages').where({ id: sent.body.messageId }).update({ state: 'streaming', heartbeat_at: Date.now() - 3_600_000 });
    await h.s.jobs.enqueue({ tenantId: row.tenant_id, type: 'chat.sweep', payload: { tenantId: row.tenant_id }, maxAttempts: 1 });
    await h.s.jobs.runDue();
    expect((await h.s.db('messages').where({ id: sent.body.messageId }).first()).state).toBe('interrupted');
  });

  it('purges conversations past the tenant retention period, and audits it (B-206)', async () => {
    await seedGateway(h, ollama);
    const m = await member();
    await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    const ta = await loginAdmin(h, 'ta');
    const old = await m.post('/api/chat', { content: 'Old one', profile: 'general' }).expect(202);
    await finished(old.body.messageId);
    const fresh = await m.post('/api/chat', { content: 'New one', profile: 'general' }).expect(202);
    await finished(fresh.body.messageId);
    await h.s.db('conversations').where({ id: old.body.conversationId }).update({ updated_at: Date.now() - 40 * 86_400_000 });
    const tid = h.tenantId;
    expect((await ta.agent.get(`/api/admin/tenants/${tid}/retention`).expect(200)).body).toMatchObject({ conversationDays: null });
    await post(ta, `/api/admin/tenants/${tid}/retention/run`).expect(409);
    await put(ta, `/api/admin/tenants/${tid}/retention`, { conversationDays: 0 }).expect(400);
    await m.agent.put(`/api/admin/tenants/${tid}/retention`).set('x-csrf-token', m.csrf).send({ conversationDays: 30 }).expect(403);
    expect((await put(ta, `/api/admin/tenants/${tid}/retention`, { conversationDays: 30 }).expect(200)).body).toMatchObject({ conversationDays: 30 });
    await post(ta, `/api/admin/tenants/${tid}/retention/run`).expect(202);
    await h.s.jobs.runDue();
    expect(await h.s.db('conversations').where({ id: old.body.conversationId }).first()).toBeUndefined();
    expect(await h.s.db('messages').where({ conversation_id: old.body.conversationId })).toHaveLength(0);
    expect(await h.s.db('conversations').where({ id: fresh.body.conversationId }).first()).toBeTruthy();
    const ev = await h.s.db('audit_events').where({ action: 'chat.retention.purged' }).first();
    expect(ev).toBeTruthy();
    expect(JSON.parse(ev.detail)).toMatchObject({ days: 30, conversations: 1, messages: 2 });
    expect(await h.s.db('audit_events').where({ action: 'tenant.retention.updated' }).first()).toBeTruthy();
    expect((await ta.agent.get(`/api/admin/tenants/${tid}/retention`).expect(200)).body).toMatchObject({ conversationDays: 30, lastPurged: 1 });
  });
});

describe('agent memory write-back (B-204)', () => {
  let h: Harness;
  let ollama: FakeOllama;

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    ollama = await new FakeOllama().start();
    ollama.chatDelayMs = 0;
    await seedGateway(h, ollama);
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  async function admin(name: string, roles = ['tool-admin']) {
    await localUser(h, name, roles, 'confidential');
    const c = await loginAdmin(h, name);
    return { ...c, post: (path: string, body: object = {}) => c.agent.post(path).set('x-csrf-token', c.csrf).send(body) };
  }

  async function publishAgent(name: string, memory?: object) {
    const a = await admin(`author${Math.random().toString(36).slice(2, 7)}`);
    const b = await admin(`reviewer${Math.random().toString(36).slice(2, 7)}`);
    const e = (await a.post('/api/admin/registry', { kind: 'agent', name, version: '1.0.0', description: 'Reconciles supplier statements against the ledger each month.', label: 'confidential', definition: { profile: 'general', systemPrompt: 'Be exact.', tools: [], budgets: { steps: 10, tokens: 10000, wallSeconds: 60, toolCalls: 4 }, ...(memory ? { memory } : {}) } }).expect(201)).body;
    await a.post(`/api/admin/registry/${e.id}/submit`).expect(200);
    await b.post(`/api/admin/registry/${e.id}/review`, { decision: 'approve' }).expect(200);
    return e;
  }

  const remembering = (text: string, type = 'quirk') => (messages: { role: string; content: string }[]) => {
    const last = messages[messages.length - 1]!;
    if (last.role === 'tool') return { content: `Noted: ${last.content}` };
    return { content: '', toolCall: { name: 'remember', arguments: { text, type } } };
  };

  it('proposes a memory under the agent policy, through the memory checkpoint, for a curator to accept', async () => {
    await publishAgent('Reconciler', { write: 'propose', types: ['quirk'], maxPerRun: 1 });
    const mem = await client(h, 'mem', ['member'], 'confidential');
    ollama.reply = remembering('The supplier API returns at most 100 rows per page.');
    const run = (await mem.post('/api/runs', { agent: 'Reconciler', input: 'Reconcile March.', label: 'internal' }).expect(202)).body;
    await drain(h);
    const v = (await mem.get(`/api/runs/${run.id}`).expect(200)).body;
    expect(v.state).toBe('succeeded');
    const step = v.steps.find((s: { title: string }) => s.title === 'remember');
    expect(step).toMatchObject({ lane: 'do', state: 'ok' });
    const tools = ollama.requests.filter((r) => r.path === '/api/chat')[0]!.body.tools as { function: { name: string } }[];
    expect(tools.map((t) => t.function.name)).toContain('remember');
    const row = await h.s.db('memories').where({ scope: 'agent', owner_id: 'Reconciler' }).first();
    expect(row).toMatchObject({ state: 'proposed', origin: 'agent', type: 'quirk', label: 'internal' });
    expect(row.content).toMatch(/^v2\./);
    expect(JSON.parse(row.source)).toEqual({ runId: run.id });
    // the memory checkpoint saw it
    expect(await h.s.db('guard_decisions').where({ checkpoint: 'memory' }).first()).toBeTruthy();
    expect(await h.s.db('audit_events').where({ action: 'memory.proposed' }).first()).toBeTruthy();
    // a curator accepts it; the next run reads it
    const curator = await client(h, 'cur', ['member', 'knowledge-curator'], 'confidential');
    const list = (await curator.get('/api/memory?tab=agents').expect(200)).body;
    const item = (list.items ?? list).find((x: { id: string }) => x.id === row.id);
    expect(item).toMatchObject({ state: 'proposed', run: run.id });
    await curator.post(`/api/memory/${row.id}/accept`).expect(200);
    expect((await h.s.db('memories').where({ id: row.id }).first()).state).toBe('active');
    // the policy caps proposals per run and refuses other types
    ollama.reply = remembering('Progress: March is half done.', 'progress');
    const run2 = (await mem.post('/api/runs', { agent: 'Reconciler', input: 'Continue.', label: 'internal' }).expect(202)).body;
    await drain(h);
    const v2 = (await mem.get(`/api/runs/${run2.id}`).expect(200)).body;
    expect(v2.steps.find((s: { title: string }) => s.title === 'remember')).toMatchObject({ state: 'denied', detail: { error: expect.stringMatching(/does not allow progress/) } });
    const system = ollama.requests.filter((r) => r.path === '/api/chat').pop()!.body.messages as { role: string; content: string }[];
    expect(system[0]!.content).toContain('The supplier API returns at most 100 rows per page.');
  });

  it('offers no memory tool when the policy is off, and refuses credentials at the checkpoint', async () => {
    await publishAgent('Quiet');
    await publishAgent('Leaky', { write: 'propose' });
    const mem = await client(h, 'mem', ['member'], 'confidential');
    ollama.reply = remembering('Nothing to see.');
    const quiet = (await mem.post('/api/runs', { agent: 'Quiet', input: 'Go.', label: 'internal' }).expect(202)).body;
    await drain(h);
    expect(ollama.requests.filter((r) => r.path === '/api/chat')[0]!.body.tools).toBeUndefined();
    expect((await mem.get(`/api/runs/${quiet.id}`).expect(200)).body.state).toBe('succeeded');
    ollama.reply = remembering('The API password is hunter22 for staging.', 'quirk');
    const leaky = (await mem.post('/api/runs', { agent: 'Leaky', input: 'Go.', label: 'internal' }).expect(202)).body;
    await drain(h);
    const step = (await mem.get(`/api/runs/${leaky.id}`).expect(200)).body.steps.find((s: { title: string }) => s.title === 'remember');
    expect(step).toMatchObject({ state: 'denied', detail: { error: expect.stringMatching(/credential/) } });
    expect(await h.s.db('memories').where({ scope: 'agent' })).toHaveLength(0);
  });
});

describe('citation passages (B-205)', () => {
  let h: Harness;
  let ollama: FakeOllama;

  beforeEach(async () => {
    ollama = await new FakeOllama().start();
    h = await harness({ OLLAMA_POLL_MS: '600000' });
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  it('stores the chunk id, span and passage with the answer, and shows the passage only within clearance', async () => {
    await seedRetrieval(h, ollama);
    const curator = await client(h, 'cura', ['member', 'knowledge-curator'], 'confidential');
    const kb = (await curator.post('/api/knowledge/bases', { name: 'Finance KB', label: 'internal', embedModel: 'nomic-embed-text', reranker: 'llama3.1:8b' }).expect(201)).body;
    const doc = 'Intro to the travel file.\n\nQ3 travel: budget 361,500, actual 412,880. The Lisbon onboarding overran.';
    await curator.agent.put(`/api/knowledge/bases/${kb.id}/uploads?name=Travel.md&label=confidential`).set('x-csrf-token', curator.csrf).set('content-type', 'application/octet-stream').send(Buffer.from(doc)).expect(202);
    await drain(h);
    await curator.patch(`/api/knowledge/bases/${kb.id}`, { status: 'published' }).expect(200);
    const conv = (await curator.post('/api/conversations', { title: 'Q3', label: 'internal' }).expect(201)).body;
    await curator.put(`/api/conversations/${conv.id}/knowledge`, { kbIds: [kb.id] }).expect(200);
    ollama.reply = () => ({ content: 'Travel came in at 412,880 against 361,500 [1].' });
    const sent = (await curator.post(`/api/conversations/${conv.id}/messages`, { content: 'How much did the Lisbon travel overrun?', profile: 'general' }).expect(202)).body;
    for (let i = 0; i < 200; i++) {
      const row = await h.s.db('messages').where({ id: sent.messageId }).first();
      if (row.completed_at) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const answer = (await curator.get(`/api/conversations/${conv.id}`)).body.messages.find((x: { id: string }) => x.id === sent.messageId);
    const cite = answer.citations[0];
    expect(cite).toMatchObject({ n: 1, kind: 'knowledge', kbId: kb.id, label: 'confidential' });
    expect(cite.chunkId).toBeTruthy();
    expect(cite.passage).toContain('412,880');
    expect(cite.span).toHaveLength(2);
    expect((await h.s.db('messages').where({ id: sent.messageId }).first()).citations).toMatch(/^v2\./);
    // the reader's clearance drops below the chunk's label: the passage is withheld
    await h.s.db('users').where({ id: curator.user.id }).update({ clearance: 'internal', clearance_direct: 'internal' });
    const later = (await curator.agent.get(`/api/conversations/${conv.id}`).expect(200)).body.messages.find((x: { id: string }) => x.id === sent.messageId);
    expect(later.citations[0]).toMatchObject({ passage: null, span: null, restricted: true, chunkId: cite.chunkId });
  });
});
