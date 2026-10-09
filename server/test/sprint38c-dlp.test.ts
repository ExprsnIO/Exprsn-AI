import request from 'supertest';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { redactSpans } from '../src/compliance/dlp.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';
import { client, drain, seedRetrieval } from './retrieval-seed.js';

const send = (c: Client, method: 'post' | 'put' | 'patch' | 'delete', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);
const CARD = '4111 1111 1111 1111';

describe('B-7601: DLP', () => {
  it('redacts merged spans with the kind', () => {
    expect(redactSpans('card 4111 1111 1111 1111 and key', [{ span: [5, 24], kind: 'payment_card' }])).toBe('card [redacted payment card] and key');
    expect(redactSpans('abcdef', [{ span: [1, 4], kind: 'x' }, { span: [2, 5], kind: 'y' }])).toBe('a[redacted x]f');
  });

  describe('on answers, outputs and uploads', () => {
    let h: Harness;
    let ollama: FakeOllama;
    let ta: Client;

    beforeEach(async () => {
      ollama = await new FakeOllama().start();
      h = await harness({ OLLAMA_POLL_MS: '600000' });
      await seedRetrieval(h, ollama);
      await localUser(h, 'ta', ['tenant-admin'], 'confidential');
      ta = await loginAdmin(h, 'ta');
      ollama.reply = (messages) => {
        const q = messages[messages.length - 1]!.content;
        return { content: q.includes('card') ? `The card on file is ${CARD}, expiring soon.` : q.includes('project') ? 'The code name is PROJ-4471.' : 'Nothing sensitive here.' };
      };
    });
    afterEach(async () => {
      await h.close();
      await ollama.stop();
    });

    async function waitDone(c: Awaited<ReturnType<typeof client>>, conversationId: string, messageId: string) {
      for (let i = 0; i < 300; i++) {
        const m = (await c.get(`/api/conversations/${conversationId}`)).body.messages.find((x: { id: string }) => x.id === messageId);
        if (m && m.state !== 'queued' && m.state !== 'streaming') return m;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('answer did not finish');
    }
    const ask = async (c: Awaited<ReturnType<typeof client>>, content: string, label = 'internal') => {
      const sent = (await c.post('/api/chat', { content, profile: 'general', label }).expect(202)).body;
      const m = await waitDone(c, sent.conversationId, sent.messageId);
      const conv = (await c.get(`/api/conversations/${sent.conversationId}`).expect(200)).body;
      return { m, conv, row: await h.s.db('messages').where({ id: sent.messageId }).first() };
    };
    const rule = (body: object) => send(ta, 'post', '/api/compliance/dlp/rules', body);

    it('rules and patterns are kept by compliance:manage and tried on a text', async () => {
      const mel = await client(h, 'mel', ['member'], 'confidential');
      await mel.get('/api/compliance/dlp').expect(403);
      await rule({ name: 'x', detectors: ['nope'], raiseTo: 'confidential', action: 'label', scopes: ['answer'] }).expect(400);
      await rule({ name: 'x', detectors: [`pattern:${ulid()}`], raiseTo: 'confidential', action: 'label', scopes: ['answer'] }).expect(422);
      expect((await send(ta, 'post', '/api/compliance/dlp/patterns', { name: 'bad', pattern: '(a+)+\\1', label: 'internal' }).expect(422)).body.title).toBe('Invalid pattern');
      const pat = (await send(ta, 'post', '/api/compliance/dlp/patterns', { name: 'Project codes', pattern: 'PROJ-\\d{4}', label: 'restricted' }).expect(201)).body;
      const r = (await rule({ name: 'Cards and codes', detectors: ['payment_card', `pattern:${pat.id}`], raiseTo: 'confidential', action: 'redact', scopes: ['answer', 'upload'] }).expect(201)).body;
      expect(r).toMatchObject({ name: 'Cards and codes', enabled: true, raiseTo: 'confidential', action: 'redact', scopes: ['answer', 'upload'] });
      const listed = (await ta.agent.get('/api/compliance/dlp').expect(200)).body;
      expect(listed.rules).toHaveLength(1);
      expect(listed.patterns[0]).toMatchObject({ id: pat.id, name: 'Project codes' });
      expect(listed.detectors).toContain('private_key');
      const test = (await send(ta, 'post', '/api/compliance/dlp/test', { text: `Pay ${CARD} for PROJ-1234`, scope: 'answer', label: 'internal' }).expect(200)).body;
      expect(test).toMatchObject({ label: 'restricted', raised: true, action: 'redact', text: 'Pay [redacted payment card] for [redacted pattern:Project codes]' });
      expect(test.detections.map((d: { kind: string }) => d.kind).sort()).toEqual(['pattern:Project codes', 'payment_card']);
      expect((await send(ta, 'post', '/api/compliance/dlp/test', { text: 'Nothing here', scope: 'answer' }).expect(200)).body).toMatchObject({ raised: false, action: null, rules: [] });
      // A pattern in use cannot go; a rule can.
      await send(ta, 'delete', `/api/compliance/dlp/patterns/${pat.id}`).expect(409);
      await send(ta, 'delete', `/api/compliance/dlp/rules/${r.id}`).expect(204);
      await send(ta, 'delete', `/api/compliance/dlp/patterns/${pat.id}`).expect(204);
      const actions = ((await h.s.db('audit_events').where({ tenant_id: h.tenantId }).where('action', 'like', 'dlp.%').select('action')) as { action: string }[]).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(['dlp.pattern.created', 'dlp.rule.created', 'dlp.rule.deleted', 'dlp.pattern.deleted']));
    });

    it('an answer with a card number is labelled and redacted; a hold rule files it for review; a label above the owner holds it', async () => {
      const mel = await client(h, 'mel', ['member'], 'confidential');
      const plain = await ask(mel, 'Tell me about the card');
      expect(plain.m.content).toContain(CARD);

      const r = (await rule({ name: 'Payment cards', detectors: ['payment_card'], raiseTo: 'confidential', action: 'redact', scopes: ['answer'] }).expect(201)).body;
      const red = await ask(mel, 'Tell me about the card');
      expect(red.m.content).toBe('The card on file is [redacted payment card], expiring soon.');
      expect(red.m.label).toBe('confidential');
      expect(red.conv.label).toBe('confidential');
      expect(JSON.parse(String(red.row.guard))).toMatchObject({ action: 'redact', dlp: { label: 'confidential', action: 'redact', rules: ['Payment cards'] }, rules: ['DLP: Payment cards'] });
      // Nothing happens to an answer the rule does not match.
      const clean = await ask(mel, 'Tell me about the weather');
      expect(clean.m).toMatchObject({ content: 'Nothing sensitive here.', label: 'internal' });

      await send(ta, 'put', `/api/compliance/dlp/rules/${r.id}`, { name: 'Payment cards', enabled: true, detectors: ['payment_card'], raiseTo: 'confidential', action: 'hold', scopes: ['answer'] }).expect(200);
      const held = await ask(mel, 'Tell me about the card');
      expect(held.m.state).toBe('held');
      expect(held.m.content).toBe('');
      const flag = await h.s.db('guard_flags').where({ tenant_id: h.tenantId, kind: 'hold' }).orderBy('created_at', 'desc').first();
      expect(flag).toMatchObject({ rule_name: 'DLP: Payment cards', checkpoint: 'model-output' });

      // A rule that only raises the label, to restricted: Mel (confidential) may not read it, so it is held; a reader
      // cleared for restricted gets the answer with its label raised.
      await send(ta, 'put', `/api/compliance/dlp/rules/${r.id}`, { name: 'Payment cards', enabled: true, detectors: ['payment_card'], raiseTo: 'restricted', action: 'label', scopes: ['answer'] }).expect(200);
      const above = await ask(mel, 'Tell me about the card');
      expect(above.m.state).toBe('held');
      expect(JSON.parse(String(above.row.guard)).reason).toMatch(/above your clearance/);
      const rex = await client(h, 'rex', ['member'], 'restricted');
      const labelled = await ask(rex, 'Tell me about the card');
      expect(labelled.m).toMatchObject({ state: 'complete', label: 'restricted' });
      expect(labelled.m.content).toContain(CARD);
      expect(labelled.conv.label).toBe('restricted');
    });

    it('the OpenAI-compatible API applies the same rules', async () => {
      const mel = await client(h, 'mel', ['member'], 'confidential');
      const key = (await h.s.apiKeys.create({ tenantId: h.tenantId, userId: mel.user.id, name: 'k', scopes: ['inference:invoke', 'models:read'] as never[], ttlDays: 30 })).key;
      await rule({ name: 'Payment cards', detectors: ['payment_card'], raiseTo: 'confidential', action: 'redact', scopes: ['answer'] }).expect(201);
      const res = await request(h.app).post('/v1/chat/completions').set('authorization', `Bearer ${key}`).send({ model: 'general', messages: [{ role: 'user', content: 'Tell me about the card' }] }).expect(200);
      expect(res.body.choices[0].message.content).toBe('The card on file is [redacted payment card], expiring soon.');
      expect(res.body.choices[0].finish_reason).toBe('content_filter');
      expect(await h.s.db('audit_events').where({ action: 'api.chat.dlp' }).first()).toBeTruthy();
    });

    it('uploads: an attachment and a file version are labelled, and a hold rule refuses them', async () => {
      const mel = await client(h, 'mel', ['member'], 'confidential');
      const ws = await h.s.tenants.createWorkspace(h.tenantId, 'Finance', 'confidential');
      await h.s.tenants.addMember(ws.id, mel.user.id);
      await send(mel, 'put', '/api/me/workspace', { workspaceId: ws.id }).expect(200);
      const pat = (await send(ta, 'post', '/api/compliance/dlp/patterns', { name: 'Project codes', pattern: 'PROJ-\\d{4}', label: 'confidential' }).expect(201)).body;
      const r = (await rule({ name: 'Project codes', detectors: [`pattern:${pat.id}`], raiseTo: 'confidential', action: 'label', scopes: ['upload'] }).expect(201)).body;
      const attach = (name: string, data: string) => mel.agent.put(`/api/attachments?name=${encodeURIComponent(name)}`).set('x-csrf-token', mel.csrf).set('content-type', 'text/plain').send(Buffer.from(data));
      const a1 = (await attach('plan.txt', 'Budget for PROJ-2026 is set.').expect(202)).body;
      const f1 = (await mel.agent.put(`/api/files/uploads?${new URLSearchParams({ name: 'plan.txt', workspace: ws.id })}`).set('x-csrf-token', mel.csrf).set('content-type', 'application/octet-stream').send(Buffer.from('Budget for PROJ-2026 is set.')).expect(202)).body;
      await drain(h);
      expect((await mel.get(`/api/attachments/${a1.id}`).expect(200)).body).toMatchObject({ state: 'ready', label: 'confidential', findings: { dlp: { label: 'confidential', action: 'label', rules: ['Project codes'] } } });
      const file = (await mel.get(`/api/files/${f1.id}`).expect(200)).body;
      expect(file.label).toBe('confidential');
      expect(await h.s.db('file_versions').where({ file_id: f1.id }).first()).toMatchObject({ state: 'ready', label: 'confidential' });
      await send(ta, 'put', `/api/compliance/dlp/rules/${r.id}`, { name: 'Project codes', enabled: true, detectors: [`pattern:${pat.id}`], raiseTo: 'confidential', action: 'hold', scopes: ['upload'] }).expect(200);
      const a2 = (await attach('plan2.txt', 'PROJ-9999 again').expect(202)).body;
      const f2 = (await mel.agent.put(`/api/files/uploads?${new URLSearchParams({ name: 'plan2.txt', workspace: ws.id })}`).set('x-csrf-token', mel.csrf).set('content-type', 'application/octet-stream').send(Buffer.from('PROJ-9999 again')).expect(202)).body;
      await drain(h);
      expect((await mel.get(`/api/attachments/${a2.id}`).expect(200)).body).toMatchObject({ state: 'rejected', reason: 'Held by the DLP rule Project codes.' });
      const v2 = await h.s.db('file_versions').where({ file_id: f2.id }).first();
      expect(v2).toMatchObject({ state: 'rejected', reason: 'Held by the DLP rule Project codes.' });
    });

    it('an agent run’s output is classified: the run’s label rises, a redaction is stored, a hold ends the run', async () => {
      const a = await localUser(h, 'author', ['tool-admin'], 'confidential');
      const b = await localUser(h, 'reviewer', ['tool-admin'], 'confidential');
      void a;
      void b;
      const ca = await loginAdmin(h, 'author');
      const cb = await loginAdmin(h, 'reviewer');
      const e = (await send(ca, 'post', '/api/admin/registry', { kind: 'agent', name: 'Card bot', version: '1.0.0', description: 'Answers questions about the payment cards on file and explains their status exactly.', label: 'confidential', definition: { profile: 'general', systemPrompt: 'Be exact.', tools: [], budgets: { steps: 5, tokens: 10000, wallSeconds: 60, toolCalls: 2 } } }).expect(201)).body;
      await send(ca, 'post', `/api/admin/registry/${e.id}/submit`).expect(200);
      await send(cb, 'post', `/api/admin/registry/${e.id}/review`, { decision: 'approve' }).expect(200);
      const mel = await client(h, 'mel', ['member'], 'confidential');
      const run = async () => {
        const r = (await mel.post('/api/runs', { agent: 'Card bot', input: 'Tell me about the card', label: 'internal' }).expect(202)).body;
        await drain(h);
        return (await mel.get(`/api/runs/${r.id}`).expect(200)).body as { state: string; output: string | null; label: string; error: string | null };
      };
      const r = (await rule({ name: 'Payment cards', detectors: ['payment_card'], raiseTo: 'confidential', action: 'redact', scopes: ['agent'] }).expect(201)).body;
      const red = await run();
      expect(red).toMatchObject({ state: 'succeeded', label: 'confidential', output: 'The card on file is [redacted payment card], expiring soon.' });
      await send(ta, 'put', `/api/compliance/dlp/rules/${r.id}`, { name: 'Payment cards', enabled: true, detectors: ['payment_card'], raiseTo: 'confidential', action: 'hold', scopes: ['agent'] }).expect(200);
      const held = await run();
      expect(held.state).toBe('failed');
      expect(held.error).toMatch(/Held by the DLP rule Payment cards/);
      expect(await h.s.db('audit_events').where({ action: 'agent.run.dlp' }).first()).toBeTruthy();
    });
  });
});
