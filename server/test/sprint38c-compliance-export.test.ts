import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';
import { client, drain, seedRetrieval } from './retrieval-seed.js';

const send = (c: Client, method: 'post' | 'put' | 'patch' | 'delete', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);

describe('B-7603: compliance exports for eDiscovery', () => {
  let h: Harness;
  let ollama: FakeOllama;

  beforeEach(async () => {
    ollama = await new FakeOllama().start();
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    await seedRetrieval(h, ollama);
    ollama.reply = () => ({ content: 'The forecast is 12% over.' });
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

  const lines = (text: string) => text.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

  it('exports a user’s conversations, files, memories, runs and account over a range, omits what is above the requester, is scoped to a token and audited', async () => {
    const mel = await client(h, 'mel', ['member'], 'confidential');
    const ws = await h.s.tenants.createWorkspace(h.tenantId, 'Finance', 'confidential');
    await h.s.tenants.addMember(ws.id, mel.user.id);
    await send(mel, 'put', '/api/me/workspace', { workspaceId: ws.id }).expect(200);
    const sent = (await mel.post('/api/chat', { content: 'How far over is the forecast?', profile: 'general', label: 'internal' }).expect(202)).body;
    await waitDone(mel, sent.conversationId, sent.messageId);
    const secret = (await mel.post('/api/chat', { content: 'Board matters', profile: 'general', label: 'confidential' }).expect(202)).body;
    await waitDone(mel, secret.conversationId, secret.messageId);
    const memory = (await mel.post('/api/memory', { text: 'Reports in EUR', label: 'internal' }).expect(201)).body;
    const up = (await mel.agent.put(`/api/files/uploads?${new URLSearchParams({ name: 'notes.txt', workspace: ws.id })}`).set('x-csrf-token', mel.csrf).set('content-type', 'application/octet-stream').send(Buffer.from('Quarterly notes')).expect(202)).body;
    await drain(h);
    const other = await client(h, 'oli', ['member'], 'confidential');
    const theirs = (await other.post('/api/chat', { content: 'Unrelated', profile: 'general', label: 'internal' }).expect(202)).body;
    await waitDone(other, theirs.conversationId, theirs.messageId);

    // Legal review holds compliance:export; a member does not.
    await localUser(h, 'lr', ['legal-review'], 'internal');
    const lr = await loginAdmin(h, 'lr');
    await mel.get('/api/compliance/exports').expect(403);
    await send(lr, 'post', '/api/compliance/exports', { from: 0, to: Date.now() + 1000 }).expect(400);
    await send(lr, 'post', '/api/compliance/exports', { userId: mel.user.id, from: Date.now(), to: 0 }).expect(400);
    const x = (await send(lr, 'post', '/api/compliance/exports', { userId: mel.user.id, from: 0, to: Date.now() + 1000 }).expect(202)).body;
    expect(x).toMatchObject({ state: 'queued', scope: expect.stringContaining('user mel'), params: { userId: mel.user.id, kinds: ['conversations', 'files', 'memories', 'runs', 'users'] } });
    await lr.agent.get(`/api/compliance/exports/${x.id}/download`).expect(409);
    await drain(h);
    const ready = (await lr.agent.get(`/api/compliance/exports/${x.id}`).expect(200)).body;
    expect(ready).toMatchObject({ state: 'ready', label: 'internal', counts: { conversations: 1, messages: 2, files: 1, memories: 1, runs: 0, users: 1 }, omitted: 1 });

    // Above the requester's clearance: the confidential conversation was left out. Raised to confidential afterwards,
    // the requester downloads with a token; an export that holds confidential rows is refused below that clearance.
    await h.s.db('compliance_exports').where({ id: x.id }).update({ max_label: 'confidential' });
    expect((await lr.agent.get(`/api/compliance/exports/${x.id}/download`).expect(403)).body.step).toBe('clearance');
    await h.s.db('compliance_exports').where({ id: x.id }).update({ max_label: 'internal' });
    await h.s.users.update(h.tenantId, (await h.s.users.byUsername(h.tenantId, 'lr'))!.id, { clearance: 'confidential', clearance_direct: 'confidential' });
    // The requester, now cleared for restricted, downloads with an API key scoped to compliance:export (the eDiscovery token).
    const key = (await h.s.apiKeys.create({ tenantId: h.tenantId, userId: (await h.s.users.byUsername(h.tenantId, 'lr'))!.id, name: 'ediscovery', scopes: ['compliance:export'] as never[], ttlDays: 7 })).key;
    const dl = await request(h.app).get(`/api/compliance/exports/${x.id}/download`).set('authorization', `Bearer ${key}`).expect(200);
    expect(dl.headers['content-type']).toMatch(/x-ndjson/);
    const rows = lines(dl.text);
    expect(rows[0]).toMatchObject({ kind: 'export', userId: mel.user.id });
    const conv = rows.find((r) => r.kind === 'conversation') as { id: string; messages: { role: string; content: string }[]; label: string };
    expect(conv.id).toBe(sent.conversationId);
    expect(conv.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'How far over is the forecast?'],
      ['assistant', 'The forecast is 12% over.']
    ]);
    expect(rows.some((r) => r.kind === 'conversation' && r.id === secret.conversationId)).toBe(false);
    expect(rows.some((r) => r.kind === 'conversation' && r.id === theirs.conversationId)).toBe(false);
    expect(rows.find((r) => r.kind === 'memory')).toMatchObject({ id: memory.id, text: 'Reports in EUR' });
    expect(rows.find((r) => r.kind === 'file')).toMatchObject({ id: up.id, name: 'notes.txt', versions: [expect.objectContaining({ number: 1 })] });
    expect(rows.find((r) => r.kind === 'user')).toMatchObject({ username: 'mel', roles: ['member'] });
    expect(rows.at(-1)).toMatchObject({ kind: 'summary', omitted: 1 });

    // The scoped token requests exports too; a key without the scope cannot.
    const byKey = await request(h.app).post('/api/compliance/exports').set('authorization', `Bearer ${key}`).send({ workspaceId: ws.id, from: 0, to: Date.now() + 1000, kinds: ['conversations', 'users'] }).expect(202);
    expect(byKey.body.apiKeyId).toBeTruthy();
    await drain(h);
    const wsExport = (await request(h.app).get(`/api/compliance/exports/${byKey.body.id}`).set('authorization', `Bearer ${key}`).expect(200)).body;
    expect(wsExport.counts).toMatchObject({ conversations: 2, users: 1 });
    const plain = (await h.s.apiKeys.create({ tenantId: h.tenantId, userId: mel.user.id, name: 'k', scopes: ['chat:read'] as never[], ttlDays: 7 })).key;
    await request(h.app).get('/api/compliance/exports').set('authorization', `Bearer ${plain}`).expect(403);

    const actions = ((await h.s.db('audit_events').where({ tenant_id: h.tenantId }).where('action', 'like', 'compliance.%').select('action')) as { action: string }[]).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['compliance.export.requested', 'compliance.exported', 'compliance.export.downloaded']));
    // The written parts are sealed: nothing readable at rest.
    const key0 = `compliance/${h.tenantId}/${x.id}/part-00000.sealed`;
    expect((await h.s.blobs.get(key0))!.toString('utf8')).not.toContain('forecast');
  });

  it('respects COMPLIANCE_EXPORT_MAX_ROWS and COMPLIANCE_EXPORT_MAX_DAYS', async () => {
    const mel = await client(h, 'mel', ['member'], 'confidential');
    await localUser(h, 'lr', ['legal-review'], 'confidential');
    const lr = await loginAdmin(h, 'lr');
    (h.s.cfg as { COMPLIANCE_EXPORT_MAX_DAYS: number }).COMPLIANCE_EXPORT_MAX_DAYS = 1;
    expect((await send(lr, 'post', '/api/compliance/exports', { userId: mel.user.id, from: 0, to: Date.now() }).expect(400)).body.title).toBe('Range too long');
    (h.s.cfg as { COMPLIANCE_EXPORT_MAX_DAYS: number }).COMPLIANCE_EXPORT_MAX_DAYS = 0;
    (h.s.cfg as { COMPLIANCE_EXPORT_MAX_ROWS: number }).COMPLIANCE_EXPORT_MAX_ROWS = 100;
    for (let i = 0; i < 3; i++) await mel.post('/api/memory', { text: `Fact ${i}`, label: 'internal' }).expect(201);
    (h.s.cfg as { COMPLIANCE_EXPORT_MAX_ROWS: number }).COMPLIANCE_EXPORT_MAX_ROWS = 100;
    const x = (await send(lr, 'post', '/api/compliance/exports', { userId: mel.user.id, from: 0, to: Date.now() + 1000, kinds: ['memories'] }).expect(202)).body;
    await drain(h);
    expect((await lr.agent.get(`/api/compliance/exports/${x.id}`).expect(200)).body.counts.memories).toBe(3);
  });
});
