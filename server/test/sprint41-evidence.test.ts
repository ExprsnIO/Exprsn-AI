/*
 * Sprint 41 (B-9501 to B-9504): evidence retention and legal hold.
 * - B-9501: a taken-down file is its own state: not in the members' trash, neither restored nor purged by them, the
 *   attempts audited; only the moderation decision lifts it.
 * - B-9502: what a moderation action hid is kept past its own retention until the case and any appeal close, and the
 *   purge that left it records that once.
 * - B-9503: a workspace's file retention and version cap, which leave files under a hold alone.
 * - B-9504: a legal hold on a case or one object under dual control, kept through every purge, and its export with a
 *   second approver.
 */
import type request from 'supertest';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPrincipal } from '../src/http/middleware.js';
import { ModerationService } from '../src/moderation/service.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';
import { client, drain, seedRetrieval } from './retrieval-seed.js';

const send = (c: Client, method: 'post' | 'put' | 'patch' | 'delete', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);
const DAY = 86_400_000;
type Res = request.Response;
const binary = (res: Res, cb: (err: Error | null, body: Buffer) => void) => {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('B-95: evidence retention and legal hold', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let ta: Client;
  let tb: Client;
  let taId: string;
  let tbId: string;
  let wsId: string;

  beforeEach(async () => {
    ollama = await new FakeOllama().start();
    h = await harness({ OLLAMA_POLL_MS: '600000', FILES_TRASH_DAYS: '30', MODERATION_EVIDENCE_DAYS: '30' });
    await seedRetrieval(h, ollama);
    taId = (await localUser(h, 'ta', ['tenant-admin', 'guardrail-admin'], 'confidential')).id;
    tbId = (await localUser(h, 'tb', ['tenant-admin', 'guardrail-admin'], 'confidential')).id;
    ta = await loginAdmin(h, 'ta');
    tb = await loginAdmin(h, 'tb');
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Evidence', 'confidential')).id;
    for (const id of [taId, tbId]) await h.s.tenants.addMember(wsId, id);
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  const member = async (name: string) => {
    const c = await client(h, name, ['member'], 'confidential');
    await h.s.tenants.addMember(wsId, c.user.id);
    await c.put('/api/me/workspace', { workspaceId: wsId }).expect(200);
    return {
      ...c,
      upload: async (file: string, data: string) => {
        const up = (await c.agent.put(`/api/files/uploads?${new URLSearchParams({ name: file, workspace: wsId })}`).set('x-csrf-token', c.csrf).set('content-type', 'application/octet-stream').send(Buffer.from(data)).expect(202)).body as { id: string };
        await drain(h);
        return up.id;
      },
      version: async (id: string, data: string) => {
        await c.agent.put(`/api/files/${id}/content`).set('x-csrf-token', c.csrf).set('content-type', 'application/octet-stream').send(Buffer.from(data)).expect(202);
        await drain(h);
      }
    };
  };
  const modCtx = async (userId: string) => {
    const p = await loadPrincipal(h.s, h.tenantId, userId, {});
    if (!p) throw new Error(`No principal for ${userId}`);
    return { ...ModerationService.ctxFor(p, null), principal: p };
  };
  const audits = async (action: string) => (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action })) as { target: string; detail: string | null }[];
  const skips = async (path: string) => (await h.s.db('retention_skips').where({ tenant_id: h.tenantId, path })) as { object_id: string; reason: string; ref: string }[];
  const file = async (id: string) => (await h.s.db('files').where({ id }).first()) as Record<string, unknown> | undefined;
  const hold = async (body: object) => {
    const req = (await send(ta, 'post', '/api/compliance/holds', { reason: 'Litigation 2026-21', approverId: tbId, ...body }).expect(201)).body as { id: string; subject: string; state: string };
    return (await send(tb, 'post', `/api/compliance/holds/${req.id}/decide`, { decision: 'approved' }).expect(200)).body as { id: string; subject: string; state: string; scope: string };
  };
  /** A conversation of `userId` with one sealed message, last changed `ageDays` ago. */
  const message = async (userId: string, text: string, ageDays: number) => {
    const t = Date.now() - ageDays * DAY;
    const cid = ulid();
    const mid = ulid();
    await h.s.db('conversations').insert({ id: cid, tenant_id: h.tenantId, workspace_id: wsId, user_id: userId, kind: 'chat', title: null, label: 'internal', created_at: t, updated_at: t });
    await h.s.db('messages').insert({ id: mid, conversation_id: cid, tenant_id: h.tenantId, role: 'user', content: await h.s.keys.seal(h.tenantId, text, `content:${mid}`), state: 'complete', label: 'internal', created_at: t, seq: 0 });
    await h.s.db('conversations').where({ id: cid }).update({ head_id: mid });
    return { conversationId: cid, messageId: mid };
  };

  it('B-9501: a member can neither restore nor purge a taken-down file, the attempts are audited, and the decision lifts it', async () => {
    const mo = await member('mo');
    const id = await mo.upload('notes.txt', 'Quarterly notes');
    const other = await mo.upload('other.txt', 'Other notes');
    const action = await h.s.moderation.takeDown(await modCtx(taId), 'file', id, 'Reported content');
    expect(await file(id)).toMatchObject({ taken_down_by: 'moderation' });
    expect((await file(id))!.taken_down_at).not.toBeNull();

    // Served to nobody, in no listing, and not in the trash its members see.
    await mo.agent.get(`/api/files/${id}`).expect(404);
    expect((await mo.agent.get(`/api/files/browse?workspace=${wsId}`).expect(200)).body.files.map((f: { id: string }) => f.id)).toEqual([other]);
    expect((await mo.agent.get(`/api/files/trash?workspace=${wsId}`).expect(200)).body.files).toEqual([]);

    // Restore is refused and recorded.
    const refused = await mo.post('/api/files/trash/restore', { kind: 'file', id }).expect(409);
    expect(refused.body.step).toBe('takedown');
    expect(await audits('file.restore.refused')).toHaveLength(1);

    // Emptying the trash takes the member's own file and leaves the taken-down one, recorded.
    await mo.del(`/api/files/${other}`).expect(200);
    await mo.post('/api/files/trash/empty', { workspaceId: wsId }).expect(202);
    await drain(h);
    expect(await file(other)).toBeUndefined();
    expect(await file(id)).toBeDefined();
    expect(await audits('file.purge.refused')).toHaveLength(1);

    // Past its purge date the scheduled purge still leaves it: its case is open. Recorded once, however often it runs.
    await h.s.db('files').where({ id }).update({ purge_after: Date.now() - 1000 });
    expect(await h.s.files.purge(h.tenantId)).toMatchObject({ files: 0, kept: 1 });
    expect(await h.s.files.purge(h.tenantId)).toMatchObject({ files: 0, kept: 1 });
    expect(await skips('files.purge')).toEqual([expect.objectContaining({ object_id: id, reason: 'evidence', ref: action.id })]);
    expect(await audits('retention.skipped')).toHaveLength(1);

    // A second takedown changes nothing; reversing the decision brings the file back where it was.
    await expect(h.s.moderation.takeDown(await modCtx(taId), 'file', id, 'again')).resolves.toMatchObject({ id: action.id });
    expect(await h.s.moderation.reverse(await modCtx(tbId), action.id, 'A mistake')).toMatchObject({ restored: true });
    expect(await file(id)).toMatchObject({ taken_down_at: null, trashed_at: null });
    await mo.agent.get(`/api/files/${id}`).expect(200);
  });

  it('B-9501: a file in a member’s trash that is taken down is theirs again, in the trash, once the takedown is lifted', async () => {
    const mo = await member('mo');
    const id = await mo.upload('draft.txt', 'A draft');
    await mo.del(`/api/files/${id}`).expect(200);
    const action = await h.s.moderation.takeDown(await modCtx(taId), 'file', id, 'Reported content');
    expect((await mo.agent.get(`/api/files/trash?workspace=${wsId}`).expect(200)).body.files).toEqual([]);
    await mo.post('/api/files/trash/restore', { kind: 'file', id }).expect(409);
    await h.s.moderation.reverse(await modCtx(tbId), action.id, 'Lifted');
    expect((await file(id))!.trashed_at).not.toBeNull();
    expect((await mo.agent.get(`/api/files/trash?workspace=${wsId}`).expect(200)).body.files.map((f: { id: string }) => f.id)).toEqual([id]);
    await mo.post('/api/files/trash/restore', { kind: 'file', id }).expect(200);
  });

  it('B-9502: a message taken down in a case survives its conversation’s retention purge until the appeal closes', async () => {
    const alice = await member('alice');
    const m = await message(alice.user.id, 'The disputed text', 40);
    const plain = await message(alice.user.id, 'Nothing special', 40);
    await send(ta, 'put', `/api/admin/tenants/${h.tenantId}/retention`, { conversationDays: 30 }).expect(200);
    const action = await h.s.moderation.takeDown(await modCtx(taId), 'message', m.messageId, 'Against the rules');
    // The takedown is 31 days old: without an appeal the case would be closed.
    await h.s.db('moderation_actions').where({ id: action.id }).update({ created_at: Date.now() - 31 * DAY });
    const appeal = await h.s.moderation.appeal(await modCtx(alice.user.id), { actionId: action.id, statement: 'It was a quotation.' });

    const first = await h.s.chat.purgeExpired(h.tenantId);
    expect(first.conversations).toBe(1);
    expect(await h.s.db('conversations').where({ id: plain.conversationId }).first('id')).toBeFalsy();
    expect(await h.s.db('messages').where({ id: m.messageId }).first('state')).toMatchObject({ state: 'hidden' });
    await h.s.chat.purgeExpired(h.tenantId);
    expect(await skips('chat.retention')).toEqual([expect.objectContaining({ object_id: m.messageId, reason: 'evidence', ref: action.id })]);
    expect(await audits('retention.skipped')).toHaveLength(1);

    // Its owner cannot delete the conversation meanwhile either.
    expect((await alice.del(`/api/conversations/${m.conversationId}`).expect(409)).body.step).toBe('retention');
    expect(await audits('retention.delete.refused')).toHaveLength(1);

    // The appeal is denied: the content stays for the appeal period after that decision, then follows retention.
    await h.s.moderation.decideAppeal(await modCtx(tbId), appeal.ref, 'denied', 'The decision stands.');
    expect((await h.s.chat.purgeExpired(h.tenantId)).conversations).toBe(0);
    await h.s.db('moderation_appeals').where({ id: appeal.id }).update({ decided_at: Date.now() - 31 * DAY, created_at: Date.now() - 32 * DAY });
    expect((await h.s.chat.purgeExpired(h.tenantId)).conversations).toBe(1);
    expect(await h.s.db('messages').where({ id: m.messageId }).first('id')).toBeFalsy();
  });

  it('B-9503: a workspace capped at 10 versions keeps the newest 10 of each file, except files under hold; retention trashes unchanged files', async () => {
    const mo = await member('mo');
    const capped = await mo.upload('report.txt', 'version 1');
    const held = await mo.upload('held.txt', 'version 1');
    for (let n = 2; n <= 12; n++) {
      await mo.version(capped, `version ${n}`);
      await mo.version(held, `version ${n}`);
    }
    const stale = await mo.upload('stale.txt', 'old');
    const staleHeld = await mo.upload('stale-held.txt', 'old and held');
    await h.s.db('files').whereIn('id', [stale, staleHeld]).update({ updated_at: Date.now() - 100 * DAY });
    await hold({ scope: 'object', objectType: 'file', objectId: held });
    const second = await hold({ scope: 'object', objectType: 'file', objectId: staleHeld });
    expect(second).toMatchObject({ scope: 'object', state: 'active' });

    // Set by a tenant admin, read by the workspace's members with its usage.
    await mo.put(`/api/admin/tenants/${h.tenantId}/workspaces/${wsId}/file-retention`, { retentionDays: 90, versionCap: 10 }).expect(403);
    expect((await send(ta, 'put', `/api/admin/tenants/${h.tenantId}/workspaces/${wsId}/file-retention`, { retentionDays: 90, versionCap: 10 }).expect(200)).body).toMatchObject({ retentionDays: 90, versionCap: 10 });
    expect((await mo.agent.get(`/api/files/usage?workspace=${wsId}`).expect(200)).body.retention).toMatchObject({ retentionDays: 90, versionCap: 10 });

    const out = await h.s.files.applyRetention(h.tenantId);
    expect(out).toMatchObject({ workspaces: 1, trashed: 1, versions: 2, kept: 2 });
    const numbers = async (id: string) => ((await h.s.db('file_versions').where({ file_id: id }).orderBy('number')) as { number: number }[]).map((v) => Number(v.number));
    expect(await numbers(capped)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(await numbers(held)).toHaveLength(12);
    expect((await file(stale))!.trashed_by).toBe('files.retention');
    expect((await file(staleHeld))!.trashed_at).toBeNull();
    expect((await audits('file.versions.pruned')).length).toBe(1);
    // The current version still reads, and a second run finds nothing more and records nothing twice.
    expect((await mo.agent.get(`/api/files/${capped}/content`).buffer(true).parse(binary).expect(200)).body.toString()).toBe('version 12');
    expect(await h.s.files.applyRetention(h.tenantId)).toMatchObject({ trashed: 0, versions: 0, kept: 2 });
    expect(await skips('files.version-cap')).toHaveLength(1);
    expect(await skips('files.retention')).toHaveLength(1);
  });

  it('B-9504: a held case’s objects survive every purge, and exporting them needs a second approver', async () => {
    const mo = await member('mo');
    const id = await mo.upload('contract.txt', 'The contract');
    const report = (await mo.post('/api/moderation/reports', { type: 'file', id, reason: 'Disputed', severity: 'high' }).expect(201)).body as { flag: { id: string; ref: string } };
    const m = await message(mo.user.id, 'A message in the same matter', 40);

    // Dual control, as for every hold: no self-approval, and nothing is kept until the approver agrees.
    expect((await send(ta, 'post', '/api/compliance/holds', { scope: 'case', scopeId: report.flag.ref, reason: 'Matter 21', approverId: taId }).expect(403)).body.step).toBe('dual-control');
    await send(ta, 'post', '/api/compliance/holds', { scope: 'case', scopeId: 'F-9999', reason: 'Matter 21', approverId: tbId }).expect(404);
    await send(ta, 'post', '/api/compliance/holds', { scope: 'object', objectType: 'nothing', objectId: 'x', reason: 'Matter 21', approverId: tbId }).expect(422);
    const pending = (await send(ta, 'post', '/api/compliance/holds', { scope: 'case', scopeId: report.flag.ref, reason: 'Matter 21', approverId: tbId }).expect(201)).body;
    expect(pending).toMatchObject({ state: 'pending', scope: 'case', scopeId: report.flag.id, subject: `Case ${report.flag.ref}` });
    expect((await h.s.evidence.keptOf(h.tenantId, 'file')).size).toBe(0);
    expect((await send(ta, 'post', `/api/compliance/holds/${pending.id}/decide`, { decision: 'approved' }).expect(403)).body.step).toBe('dual-control');
    await send(tb, 'post', `/api/compliance/holds/${pending.id}/decide`, { decision: 'approved' }).expect(200);
    const objectHold = await hold({ scope: 'object', objectType: 'message', objectId: m.messageId });
    expect(await h.s.evidence.kept(h.tenantId, 'file', id)).toEqual({ reason: 'legal-hold', ref: pending.id });

    // The owner trashes the file and empties the trash; the scheduled purge, retention and the version cap run;
    // conversation retention runs: everything of the case and the held message is still there.
    await mo.version(id, 'The contract, amended');
    await mo.del(`/api/files/${id}`).expect(200);
    await mo.post('/api/files/trash/empty', { workspaceId: wsId }).expect(202);
    await drain(h);
    await h.s.db('files').where({ id }).update({ purge_after: Date.now() - 1000 });
    await send(ta, 'put', `/api/admin/tenants/${h.tenantId}/workspaces/${wsId}/file-retention`, { retentionDays: null, versionCap: 1 }).expect(200);
    await h.s.files.applyRetention(h.tenantId);
    expect(await h.s.files.purge(h.tenantId)).toMatchObject({ files: 0, kept: 1 });
    expect(await h.s.db('file_versions').where({ file_id: id })).toHaveLength(2);
    await send(ta, 'put', `/api/admin/tenants/${h.tenantId}/retention`, { conversationDays: 30 }).expect(200);
    expect((await h.s.chat.purgeExpired(h.tenantId)).conversations).toBe(0);
    expect(await h.s.db('messages').where({ id: m.messageId }).first('id')).toBeTruthy();
    expect((await mo.del(`/api/conversations/${m.conversationId}`).expect(409)).body.step).toBe('retention');
    expect((await skips('files.trash-empty')).map((x) => x.reason)).toEqual(['legal-hold']);
    expect(await h.s.evidence.anyHold(h.tenantId)).toBe(2);

    // The export: asked by one compliance manager, approved by another, read by the one who asked.
    expect((await send(ta, 'post', `/api/compliance/holds/${pending.id}/exports`, { reason: 'For counsel', approverId: taId }).expect(403)).body.step).toBe('dual-control');
    const exp = (await send(ta, 'post', `/api/compliance/holds/${pending.id}/exports`, { reason: 'For counsel', approverId: tbId }).expect(201)).body;
    expect(exp).toMatchObject({ state: 'pending', holdId: pending.id });
    await ta.agent.get(`/api/compliance/evidence-exports/${exp.id}/download`).expect(409);
    expect((await send(ta, 'post', `/api/compliance/evidence-exports/${exp.id}/decide`, { decision: 'approved' }).expect(403)).body.step).toBe('dual-control');
    await send(tb, 'post', `/api/compliance/evidence-exports/${exp.id}/decide`, { decision: 'approved' }).expect(200);
    await drain(h);
    await tb.agent.get(`/api/compliance/evidence-exports/${exp.id}/download`).expect(404);
    const got = await ta.agent.get(`/api/compliance/evidence-exports/${exp.id}/download`).buffer(true).parse(binary).expect(200);
    const lines = (got.body as Buffer).toString('utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l.kind)).toEqual(['hold', 'flag', 'object']);
    expect(lines[2]).toMatchObject({ type: 'file', id, found: true, text: 'contract.txt' });
    expect((lines[2]!.versions as unknown[]).length).toBe(2);
    expect((await audits('evidence.exported')).length).toBe(1);
    const page = (await ta.agent.get('/api/compliance/holds').expect(200)).body;
    expect(page.evidenceExports).toEqual([expect.objectContaining({ id: exp.id, state: 'ready', objects: 1 })]);
    expect(page.scopes).toEqual(['user', 'workspace', 'case', 'object']);

    // Released, the next purge treats the file as any other in the trash.
    await send(tb, 'post', `/api/compliance/holds/${pending.id}/release`, { note: 'Matter closed' }).expect(200);
    expect(await h.s.files.purge(h.tenantId)).toMatchObject({ files: 1, kept: 0 });
    expect(await file(id)).toBeUndefined();
    expect(objectHold.state).toBe('active');
  });
});
