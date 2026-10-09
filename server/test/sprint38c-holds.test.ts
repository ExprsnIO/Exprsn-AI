import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';
import { client, drain, seedRetrieval } from './retrieval-seed.js';

const send = (c: Client, method: 'post' | 'put' | 'patch' | 'delete', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);
const DAY = 86_400_000;

describe('B-7602: legal holds under dual control suspend retention', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let ta: Client;
  let tb: Client;
  let taId: string;
  let tbId: string;

  beforeEach(async () => {
    ollama = await new FakeOllama().start();
    h = await harness({ OLLAMA_POLL_MS: '600000', FILES_TRASH_DAYS: '30' });
    await seedRetrieval(h, ollama);
    taId = (await localUser(h, 'ta', ['tenant-admin'], 'confidential')).id;
    tbId = (await localUser(h, 'tb', ['tenant-admin'], 'confidential')).id;
    ta = await loginAdmin(h, 'ta');
    tb = await loginAdmin(h, 'tb');
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  it('a hold is requested, approved by another compliance manager, keeps conversations, memories and files past retention, and is released', async () => {
    const mel = await client(h, 'mel', ['member'], 'confidential');
    const ws = await h.s.tenants.createWorkspace(h.tenantId, 'Legal', 'confidential');
    await h.s.tenants.addMember(ws.id, mel.user.id);
    const other = await client(h, 'oli', ['member'], 'confidential');
    const old = async (c: typeof mel, title: string) => {
      const conv = (await c.post('/api/conversations', { title }).expect(201)).body;
      await h.s.db('conversations').where({ id: conv.id }).update({ updated_at: Date.now() - 40 * DAY });
      return conv.id as string;
    };
    const melConv = await old(mel, 'held conversation');
    const oliConv = await old(other, 'ordinary conversation');
    await send(ta, 'put', `/api/admin/tenants/${h.tenantId}/retention`, { conversationDays: 30 }).expect(200);
    const memory = (await mel.post('/api/memory', { text: 'Kept for the case', label: 'internal', expiresAt: Date.now() + 60_000 }).expect(201)).body;
    await h.s.db('memories').where({ id: memory.id }).update({ expires_at: Date.now() - 1000 });
    const oliMemory = (await other.post('/api/memory', { text: 'Not kept', label: 'internal', expiresAt: Date.now() + 60_000 }).expect(201)).body;
    await h.s.db('memories').where({ id: oliMemory.id }).update({ expires_at: Date.now() - 1000 });
    await send(mel, 'put', '/api/me/workspace', { workspaceId: ws.id }).expect(200);
    const up = (await mel.agent.put(`/api/files/uploads?${new URLSearchParams({ name: 'evidence.txt', workspace: ws.id })}`).set('x-csrf-token', mel.csrf).set('content-type', 'application/octet-stream').send(Buffer.from('Keep me')).expect(202)).body;
    await drain(h);
    await mel.del(`/api/files/${up.id}`).expect(200);
    await h.s.db('files').where({ id: up.id }).update({ purge_after: Date.now() - 1000 });

    // Dual control: no self-approval, and the approver must be another compliance manager.
    const page = (await ta.agent.get('/api/compliance/holds').expect(200)).body;
    expect(page.approvers).toEqual([expect.objectContaining({ userId: tbId, username: 'tb' })]);
    expect((await send(ta, 'post', '/api/compliance/holds', { scope: 'user', scopeId: mel.user.id, reason: 'Litigation 2026-17', approverId: taId }).expect(403)).body.step).toBe('dual-control');
    await send(ta, 'post', '/api/compliance/holds', { scope: 'user', scopeId: mel.user.id, reason: 'Litigation 2026-17', approverId: mel.user.id }).expect(422);
    const hold = (await send(ta, 'post', '/api/compliance/holds', { scope: 'user', scopeId: mel.user.id, reason: 'Litigation 2026-17', approverId: tbId }).expect(201)).body;
    expect(hold).toMatchObject({ state: 'pending', scope: 'user', scopeId: mel.user.id, subject: 'MEL', reason: 'Litigation 2026-17', requestedBy: { username: 'ta' }, approver: { username: 'tb' } });
    await send(ta, 'post', '/api/compliance/holds', { scope: 'user', scopeId: mel.user.id, reason: 'again', approverId: tbId }).expect(409);
    expect((await send(ta, 'post', `/api/compliance/holds/${hold.id}/decide`, { decision: 'approved' }).expect(403)).body.step).toBe('dual-control');

    // Pending suspends nothing: a purge now would take the conversation. Approve first.
    expect(await h.s.legalHolds.held(h.tenantId)).toEqual({ users: [], workspaces: [] });
    const active = (await send(tb, 'post', `/api/compliance/holds/${hold.id}/decide`, { decision: 'approved', note: 'Approved per counsel' }).expect(200)).body;
    expect(active).toMatchObject({ state: 'active', decidedBy: { username: 'tb' }, note: 'Approved per counsel' });
    expect(await h.s.legalHolds.held(h.tenantId)).toEqual({ users: [mel.user.id], workspaces: [] });

    // Retention leaves the held user's content alone and purges the rest.
    const purged = await h.s.chat.purgeExpired(h.tenantId);
    expect(purged.conversations).toBe(1);
    expect(await h.s.db('conversations').where({ id: melConv }).first('id')).toBeTruthy();
    expect(await h.s.db('conversations').where({ id: oliConv }).first('id')).toBeFalsy();
    expect(await h.s.memory.purgeExpired(h.tenantId)).toEqual({ purged: 1 });
    expect(await h.s.db('memories').where({ id: memory.id }).first('id')).toBeTruthy();
    expect(await h.s.db('memories').where({ id: oliMemory.id }).first('id')).toBeFalsy();
    expect((await h.s.files.purge(h.tenantId)).files).toBe(0);
    expect(await h.s.db('files').where({ id: up.id }).first('id')).toBeTruthy();

    // A workspace hold works the same way (another request, approved by the other admin).
    const wsHold = (await send(tb, 'post', '/api/compliance/holds', { scope: 'workspace', scopeId: ws.id, reason: 'Audit', approverId: taId }).expect(201)).body;
    expect(wsHold.subject).toBe('Legal');
    await send(ta, 'post', `/api/compliance/holds/${wsHold.id}/decide`, { decision: 'approved' }).expect(200);
    expect((await h.s.legalHolds.held(h.tenantId)).workspaces).toEqual([ws.id]);

    // Released: the next purge takes the content as before. Withdraw only works on a pending request by its requester.
    const released = (await send(tb, 'post', `/api/compliance/holds/${hold.id}/release`, { note: 'Case closed' }).expect(200)).body;
    expect(released).toMatchObject({ state: 'released', releasedBy: { username: 'tb' }, note: 'Case closed' });
    await send(ta, 'post', `/api/compliance/holds/${hold.id}/release`).expect(409);
    await send(ta, 'post', `/api/compliance/holds/${wsHold.id}/release`).expect(200);
    expect((await h.s.chat.purgeExpired(h.tenantId)).conversations).toBe(1);
    expect(await h.s.db('conversations').where({ id: melConv }).first('id')).toBeFalsy();
    expect(await h.s.memory.purgeExpired(h.tenantId)).toEqual({ purged: 1 });
    expect((await h.s.files.purge(h.tenantId)).files).toBe(1);

    const pending = (await send(ta, 'post', '/api/compliance/holds', { scope: 'user', scopeId: other.user.id, reason: 'Maybe', approverId: tbId }).expect(201)).body;
    await send(tb, 'post', `/api/compliance/holds/${pending.id}/withdraw`).expect(403);
    expect((await send(ta, 'post', `/api/compliance/holds/${pending.id}/withdraw`).expect(200)).body.state).toBe('withdrawn');
    const rejected = (await send(ta, 'post', '/api/compliance/holds', { scope: 'user', scopeId: other.user.id, reason: 'Not this one', approverId: tbId }).expect(201)).body;
    expect((await send(tb, 'post', `/api/compliance/holds/${rejected.id}/decide`, { decision: 'rejected', note: 'Not needed' }).expect(200)).body.state).toBe('rejected');

    // Members see nothing of it; the chain records every step and never the reason in clear beyond its excerpt.
    await mel.agent.get('/api/compliance/holds').expect(403);
    const actions = ((await h.s.db('audit_events').where({ tenant_id: h.tenantId }).where('action', 'like', 'legal_hold.%').select('action')) as { action: string }[]).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['legal_hold.requested', 'legal_hold.approved', 'legal_hold.released', 'legal_hold.withdrawn', 'legal_hold.rejected']));
    const notes = (await h.s.db('notifications').where({ user_id: tbId, kind: 'compliance' }).select('title')) as { title: string }[];
    expect(notes.map((n) => n.title)).toContain('TA asks you to approve a legal hold');
    const stored = (await h.s.db('legal_holds').where({ id: hold.id }).first('reason')) as { reason: string };
    expect(stored.reason).not.toContain('Litigation');
  });
});
