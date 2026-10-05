/*
 * Sprint 26 (B-1901 to B-1907): moderation actions and appeals on top of the guardrails and the flag queue. Checks of
 * any object type deduplicated per object; reports into the object's own workspace queue through the registry;
 * actions, appeals that restore the hidden object, reopen the flag and negate the AT-Protocol labels made from it;
 * sanctions enforced at sign-in and on every request and ended by the sweep; routed queues that escalate past their
 * SLA; the dead-letter queue with redrive; external providers in shadow and enforce mode (a fake on 127.0.0.1), only
 * in zones with egress; and the notices by email.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Label } from '../src/authz/labels.js';
import { startSigner } from '../src/signer/server.js';
import { parseVerdict } from '../src/moderation/providers.js';
import { FakeMail } from './fake-account.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';
import { FakeModerationProvider } from './sprint26c-fakes.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Agent = { get: (p: string) => request.Test; post: (p: string, b?: object) => request.Test; patch: (p: string, b?: object) => request.Test; del: (p: string) => request.Test; csrf: string; agent: ReturnType<typeof request.agent> };

const wrap = (c: { agent: ReturnType<typeof request.agent>; csrf: string }): Agent => ({
  agent: c.agent,
  csrf: c.csrf,
  get: (p) => c.agent.get(p),
  post: (p, b = {}) => c.agent.post(p).set('x-csrf-token', c.csrf).send(b),
  patch: (p, b = {}) => c.agent.patch(p).set('x-csrf-token', c.csrf).send(b),
  del: (p) => c.agent.delete(p).set('x-csrf-token', c.csrf)
});

async function signerFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'exm-'));
  const socketPath = path.join(dir, 'run', 'signer.sock');
  const token = randomBytes(24).toString('base64url') + 'x'.repeat(8);
  const signer = await startSigner({ socketPath, key: randomBytes(32).toString('base64'), token });
  return {
    socketPath,
    token,
    close: async () => {
      await signer.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe('Sprint 26: moderation actions and appeals', () => {
  let f: Awaited<ReturnType<typeof signerFixture>>;
  let h: Harness;
  let mail: FakeMail;
  let provider: FakeModerationProvider;
  let admin: Agent;
  let reviewer2: Agent;
  let flagReviewer: Agent;
  let alice: Agent;
  let bob: Agent;
  let ids: { alice: string; bob: string; reviewer: string };
  let ws: string;
  let other: string;

  const drain = async (rounds = 8) => {
    for (let i = 0; i < rounds; i++) {
      // Retries back off for seconds; bring them forward so the test does not wait.
      await h.s.db('jobs').where({ state: 'queued' }).update({ run_at: 0 });
      await h.s.jobs.runDue();
      await sleep(10);
    }
  };

  /** A conversation of `userId` in workspace `workspaceId` with one sealed user message. */
  async function message(userId: string, text: string, workspaceId: string | null = ws, label: Label = 'internal') {
    const t = Date.now();
    const cid = ulid();
    const mid = ulid();
    await h.s.db('conversations').insert({ id: cid, tenant_id: h.tenantId, workspace_id: workspaceId, user_id: userId, kind: 'chat', title: null, label, created_at: t, updated_at: t });
    await h.s.db('messages').insert({ id: mid, conversation_id: cid, tenant_id: h.tenantId, role: 'user', content: await h.s.keys.seal(h.tenantId, text, `content:${mid}`), state: 'complete', label, created_at: t, seq: 0 });
    await h.s.db('conversations').where({ id: cid }).update({ head_id: mid });
    return { conversationId: cid, messageId: mid };
  }

  async function mediaAsset(userId: string, name: string, workspaceId: string) {
    const id = ulid();
    await h.s.db('media_assets').insert({ id, tenant_id: h.tenantId, workspace_id: workspaceId, user_id: userId, name, kind: 'image', size: 10, sha256: 'a'.repeat(64), state: 'ready', label: 'internal', previews: 0, created_at: Date.now() });
    return id;
  }

  beforeAll(async () => {
    f = await signerFixture();
    mail = new FakeMail();
    provider = new FakeModerationProvider();
    await provider.start();
    h = await harness({ DATA_KEY: '', SIGNER_SOCKET: f.socketPath, SIGNER_TOKEN: f.token, ATPROTO_PUBLIC_URL: 'https://mod.example.test', MODERATION_EXTERNAL_PROVIDERS: 'true', ZONES_AIR_GAPPED: 'false', MODERATION_SWEEP_SECONDS: '0' }, { mail });
    ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Community', 'confidential', { visibility: 'members' })).id;
    other = (await h.s.tenants.createWorkspace(h.tenantId, 'Elsewhere', 'confidential', { visibility: 'members' })).id;
    const adminUser = await localUser(h, 'modadmin', ['tenant-admin', 'guardrail-admin'], 'confidential');
    const r2 = await localUser(h, 'modreview', ['guardrail-admin'], 'confidential');
    const fr = await localUser(h, 'flagger', ['flag-reviewer'], 'internal');
    const a = await localUser(h, 'alice', ['member'], 'internal');
    const b = await localUser(h, 'bob', ['member'], 'internal');
    for (const u of [adminUser, r2, fr, a, b]) {
      await h.s.users.update(h.tenantId, u.id, { email: `${u.username}@example.test` });
      await h.s.tenants.addMember(ws, u.id);
    }
    ids = { alice: a.id, bob: b.id, reviewer: r2.id };
    admin = wrap(await loginAdmin(h, 'modadmin'));
    reviewer2 = wrap(await loginAdmin(h, 'modreview'));
    flagReviewer = wrap(await login(h, 'flagger'));
    alice = wrap(await login(h, 'alice'));
    bob = wrap(await login(h, 'bob'));
    // One tenant rule set: a blocked word and a flagged link, both at user-input.
    const set = (await admin.post('/api/admin/guardrails/sets', { name: 'Community rules', scope: 'tenant' }).expect(201)).body as { id: string };
    await admin.agent
      .put(`/api/admin/guardrails/sets/${set.id}/draft`)
      .set('x-csrf-token', admin.csrf)
      .send({
        rules: [
          { id: 'forbidden', name: 'Forbidden word', checkpoint: 'user-input', type: 'pattern', mechanism: { kind: 'pattern', pattern: 'FORBIDDENWORD' }, action: 'block', stage: 'enforce', severity: 'high' },
          { id: 'spam-link', name: 'Spam links', checkpoint: 'user-input', type: 'pattern', mechanism: { kind: 'pattern', pattern: 'SPAMLINK' }, action: 'flag', stage: 'enforce', severity: 'medium' }
        ]
      })
      .expect(200);
    await admin.post(`/api/admin/guardrails/sets/${set.id}/draft/publish`).expect(200);
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    await provider?.stop();
    await f?.close();
  });

  it('B-1901: the same object checked twice makes one flag, in a batch too, for registered and unregistered types', async () => {
    const m = await message(ids.alice, 'Buy now at SPAMLINK dot example');
    const first = await admin.post('/api/moderation/check', { type: 'message', id: m.messageId }).expect(200);
    expect(first.body.verdict.action).toBe('flag');
    expect(first.body.flag).toMatchObject({ created: true, state: 'open' });
    expect(first.body.object).toMatchObject({ type: 'message', workspaceId: ws, registered: true });
    const second = await admin.post('/api/moderation/check', { type: 'message', id: m.messageId }).expect(200);
    expect(second.body.flag).toMatchObject({ id: first.body.flag.id, created: false });
    expect(await h.s.db('guard_flags').where({ tenant_id: h.tenantId, source_kind: 'message', source_id: m.messageId }).count({ n: '*' }).first()).toMatchObject({ n: 1 });

    // Concurrent checks of one object still make one flag between them.
    const m2 = await message(ids.alice, 'SPAMLINK twice at once');
    const both = await Promise.all([admin.post('/api/moderation/check', { type: 'message', id: m2.messageId }), admin.post('/api/moderation/check', { type: 'message', id: m2.messageId })]);
    expect(both[0]!.body.flag.id).toBe(both[1]!.body.flag.id);

    // A batch: an unregistered type with its text, and a clean object.
    const post = 'at://did:plc:someone/app.bsky.feed.post/3kabc';
    const batch = await admin.post('/api/moderation/batch', { items: [{ type: 'atproto-post', id: post, text: 'see SPAMLINK', workspaceId: ws }, { type: 'message', id: m.messageId }, { type: 'atproto-post', id: 'at://x/y/clean', text: 'hello' }, { type: 'mystery', id: 'x' }] }).expect(200);
    expect(batch.body.items.map((x: { ok: boolean }) => x.ok)).toEqual([true, true, true, false]);
    expect(batch.body.items[0].object.registered).toBe(false);
    expect(batch.body.items[1].flag.id).toBe(first.body.flag.id);
    expect(batch.body.items[2].flag).toBeNull();
    expect(batch.body.items[3].status).toBe(422);
    const again = await admin.post('/api/moderation/batch', { items: [{ type: 'atproto-post', id: post, text: 'see SPAMLINK', workspaceId: ws }] }).expect(200);
    expect(again.body.items[0].flag.id).toBe(batch.body.items[0].flag.id);

    // A dismissed flag is not raised again for the same text.
    await admin.post(`/api/flags/${first.body.flag.ref}/decide`, { decision: 'dismissed', reason: 'fine' }).expect(200);
    const third = await admin.post('/api/moderation/check', { type: 'message', id: m.messageId }).expect(200);
    expect(third.body.flag).toMatchObject({ id: first.body.flag.id, state: 'dismissed', created: false });

    // Members cannot run checks; objects outside the caller's workspaces are not found.
    await alice.post('/api/moderation/check', { type: 'message', id: m.messageId }).expect(403);
    const hidden = await message(ids.bob, 'SPAMLINK', other);
    await flagReviewer.agent.get('/api/moderation/types').expect(403);
    expect((await alice.get('/api/moderation/types').expect(200)).body.items.map((x: { type: string }) => x.type)).toEqual(['conversation', 'file', 'group', 'group-event', 'group-post', 'image', 'knowledge-document', 'media-asset', 'message', 'record']); // records since Sprint 27 (B-22)
    const r2 = await localUser(h, 'checker', ['guardrail-admin'], 'internal');
    void r2;
    const checker = wrap(await loginAdmin(h, 'checker'));
    await checker.post('/api/moderation/check', { type: 'message', id: hidden.messageId }).expect(404);
  });

  it('B-1903: a block hides the object; upholding the appeal restores it, reopens the flag and negates its labels', async () => {
    // The tenant's labeler, so the verdict becomes signed labels on the post's subject.
    await admin.post('/api/atproto/identity', { method: 'web' }).expect(201);
    const m = await message(ids.alice, 'This has the FORBIDDENWORD in it');
    const subject = `at://did:plc:alice/app.bsky.feed.post/${m.messageId.toLowerCase()}`;
    const r = await admin.post('/api/moderation/check', { type: 'message', id: m.messageId, subject }).expect(200);
    expect(r.body.verdict.action).toBe('block');
    expect(r.body.action).toMatchObject({ action: 'hide', state: 'applied', source: 'guardrail', ownerId: ids.alice });
    expect(r.body.labels).toContain('!hide');
    expect((await h.s.db('messages').where({ id: m.messageId }).first()).state).toBe('hidden');
    const view = await alice.get(`/api/conversations/${m.conversationId}`).expect(200);
    expect(view.body.messages[0]).toMatchObject({ state: 'hidden', content: '' });

    // The owner is told (B-1907) and sees the action; a reviewer confirms the flag.
    const told = await mail.next('alice@example.test');
    expect(told.subject).toMatch(/moderation notice: Something of yours was hidden/);
    expect(told.text).not.toContain('FORBIDDENWORD');
    const mine = await alice.get('/api/moderation/mine').expect(200);
    const action = mine.body.actions.find((a: { objectId: string }) => a.objectId === m.messageId);
    expect(action).toBeTruthy();
    await admin.post(`/api/flags/${r.body.flag.ref}/decide`, { decision: 'confirmed', reason: 'it is forbidden' }).expect(200);

    // Someone else cannot appeal it; the owner can, once.
    await bob.post('/api/moderation/appeals', { actionId: action.id, statement: 'not mine' }).expect(404);
    const appeal = await alice.post('/api/moderation/appeals', { actionId: action.id, statement: 'It was a quotation, not a use.' }).expect(201);
    expect(appeal.body).toMatchObject({ ref: expect.stringMatching(/^A-\d+$/), state: 'pending', statement: 'It was a quotation, not a use.' });
    await alice.post('/api/moderation/appeals', { actionId: action.id, statement: 'again' }).expect(409);
    await alice.post(`/api/moderation/appeals/${appeal.body.ref}/decide`, { decision: 'upheld' }).expect(403);
    expect((await admin.get('/api/moderation/appeals?state=pending').expect(200)).body.items.map((x: { id: string }) => x.id)).toContain(appeal.body.id);

    await reviewer2.post(`/api/moderation/appeals/${appeal.body.ref}/review`).expect(200);
    // The admin ran the check that hid it, so may not decide; another reviewer may not while it is being reviewed.
    expect((await admin.post(`/api/moderation/appeals/${appeal.body.ref}/decide`, { decision: 'upheld' }).expect(403)).body.step).toBe('independence');
    await flagReviewer.post(`/api/moderation/appeals/${appeal.body.ref}/decide`, { decision: 'upheld' }).expect(409);
    const decided = await reviewer2.post(`/api/moderation/appeals/${appeal.body.ref}/decide`, { decision: 'upheld', note: 'A quotation in context.' }).expect(200);
    expect(decided.body.effects).toMatchObject({ restored: true, flagReopened: r.body.flag.ref });
    expect(decided.body.effects.labelsNegated).toContain('!hide');
    expect((await h.s.db('messages').where({ id: m.messageId }).first()).state).toBe('complete');
    expect((await alice.get(`/api/conversations/${m.conversationId}`).expect(200)).body.messages[0].content).toContain('FORBIDDENWORD');
    const flag = await h.s.guard.flags.get(h.tenantId, r.body.flag.ref);
    expect(flag.state).toBe('open');
    const events = (await h.s.db('guard_flag_events').where({ flag_id: flag.id }).orderBy('created_at')).map((e: { action: string }) => e.action);
    expect(events).toEqual(['created', 'confirmed', 'reopened']);
    const negs = await h.s.db('atproto_labels').where({ flag_id: flag.id, neg: true });
    expect(negs.length).toBeGreaterThan(0);
    // All of it in the audit chain.
    const audit = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).whereIn('action', ['moderation.action.applied', 'moderation.appeal.submitted', 'moderation.appeal.reviewing', 'moderation.appeal.upheld', 'moderation.action.reversed', 'atproto.label.negated']).select('action')).map((x: { action: string }) => x.action);
    for (const a of ['moderation.action.applied', 'moderation.appeal.submitted', 'moderation.appeal.reviewing', 'moderation.appeal.upheld', 'moderation.action.reversed', 'atproto.label.negated']) expect(audit).toContain(a);
    expect((await h.s.audit.verify(h.tenantId)).status).toBe('verified');
    const upheld = await mail.next('alice@example.test', 2);
    expect(upheld.subject).toMatch(/appeal A-\d+ was upheld/);
  });

  it('B-1903: a reviewer hides an object from its flag and cannot decide the appeal of their own action', async () => {
    const m = await message(ids.bob, 'More SPAMLINK here');
    const r = await admin.post('/api/moderation/check', { type: 'message', id: m.messageId }).expect(200);
    expect(r.body.action).toBeNull();
    const acted = await admin.post(`/api/moderation/flags/${r.body.flag.ref}/action`, { action: 'hide', reason: 'Spam' }).expect(201);
    expect(acted.body.flag.state).toBe('confirmed');
    expect(acted.body.action).toMatchObject({ source: 'reviewer', ownerId: ids.bob });
    const appeal = await bob.post('/api/moderation/appeals', { actionId: acted.body.action.id, statement: 'Not spam' }).expect(201);
    const own = await admin.post(`/api/moderation/appeals/${appeal.body.ref}/decide`, { decision: 'denied' }).expect(403);
    expect(own.body.step).toBe('independence');
    const denied = await reviewer2.post(`/api/moderation/appeals/${appeal.body.ref}/decide`, { decision: 'denied', note: 'It is spam.' }).expect(200);
    expect(denied.body.appeal.state).toBe('denied');
    expect((await h.s.db('messages').where({ id: m.messageId }).first()).state).toBe('hidden');
    await reviewer2.post(`/api/moderation/appeals/${appeal.body.ref}/decide`, { decision: 'upheld' }).expect(409);
  });

  it('B-1902: a report on a file appears in its workspace queue, once per reporter, and only for what the reporter can see', async () => {
    const file = await mediaAsset(ids.bob, 'holiday.png', ws);
    const rep = await alice.post('/api/moderation/reports', { type: 'media-asset', id: file, reason: 'Offensive image', severity: 'high' }).expect(201);
    expect(rep.body.flag.workspaceId).toBe(ws);
    const queue = await flagReviewer.get('/api/flags').expect(200);
    expect(queue.body.items.map((x: { ref: string }) => x.ref)).toContain(rep.body.flag.ref);
    const detail = await flagReviewer.get(`/api/flags/${rep.body.flag.ref}`).expect(200);
    expect(detail.body).toMatchObject({ kind: 'report', checkpoint: 'user-report', workspaceId: ws });
    expect((await alice.post('/api/moderation/reports', { type: 'media-asset', id: file, reason: 'Again' }).expect(200)).body).toMatchObject({ duplicate: true, flag: { ref: rep.body.flag.ref } });
    // A file in a workspace the reporter is not in, an unknown type, and an object that does not exist.
    const elsewhere = await mediaAsset(ids.bob, 'other.png', other);
    await alice.post('/api/moderation/reports', { type: 'media-asset', id: elsewhere, reason: 'x' }).expect(404);
    await alice.post('/api/moderation/reports', { type: 'nothing', id: 'x', reason: 'x' }).expect(422);
    await alice.post('/api/moderation/reports', { type: 'message', id: ulid(), reason: 'x' }).expect(404);
    // Someone else's private conversation cannot be reported by a member.
    const priv = await message(ids.bob, 'private words');
    await alice.post('/api/moderation/reports', { type: 'message', id: priv.messageId, reason: 'x' }).expect(404);
    // Hiding the file makes it unavailable; restoring it from an upheld appeal makes it available again.
    const acted = await admin.post(`/api/moderation/flags/${rep.body.flag.ref}/action`, { action: 'hide', reason: 'Offensive' }).expect(201);
    expect((await h.s.db('media_assets').where({ id: file }).first()).state).toBe('hidden');
    const ap = await bob.post('/api/moderation/appeals', { actionId: acted.body.action.id, statement: 'It is a landscape.' }).expect(201);
    await reviewer2.post(`/api/moderation/appeals/${ap.body.ref}/decide`, { decision: 'upheld' }).expect(200);
    expect((await h.s.db('media_assets').where({ id: file }).first()).state).toBe('ready');
  });

  it('B-1904, B-1907: a suspended user is refused on the next request and at sign-in, is told by email, and the sweep lifts it', async () => {
    const key = (await bob.post('/api/me/api-keys', { name: 'cli', scopes: ['chat:read'], ttlDays: 30 }).expect(201)).body.key as string;
    await request(h.app).get('/api/me').set('authorization', `Bearer ${key}`).expect(200);
    await bob.get('/api/me').expect(200);

    // Members cannot sanction; a sanction needs a recent sign-in.
    await alice.post('/api/moderation/sanctions', { userId: ids.bob, kind: 'warn', reason: 'x' }).expect(403);
    await h.s.db('sessions').where({ user_id: ids.reviewer }).update({ auth_at: Date.now() - 24 * 3_600_000 });
    const stepUp = await reviewer2.post('/api/moderation/sanctions', { userId: ids.bob, kind: 'warn', reason: 'x' }).expect(401);
    expect(stepUp.body.step_up).toBe(true);
    await admin.post('/api/moderation/sanctions', { userId: ids.bob, kind: 'suspend', reason: 'x' }).expect(400); // no duration
    await admin.post('/api/moderation/sanctions', { userId: (await h.s.db('users').where({ username: 'modadmin' }).first()).id, kind: 'warn', reason: 'x' }).expect(403);

    const before = mail.to('bob@example.test').length;
    const s = await admin.post('/api/moderation/sanctions', { userId: ids.bob, kind: 'suspend', durationMinutes: 60, reason: 'Repeated spam' }).expect(201);
    expect(s.body).toMatchObject({ kind: 'suspend', state: 'active', sessionsRevoked: 1 });

    // The open session is refused on its next request; so are the API key and a new sign-in.
    const next = await bob.get('/api/me');
    expect(next.status === 401 || next.status === 403).toBe(true);
    const viaKey = await request(h.app).get('/api/me').set('authorization', `Bearer ${key}`).expect(403);
    expect(viaKey.body).toMatchObject({ title: 'Account suspended', sanction: 'suspend' });
    const signIn = await request(h.app).post('/api/auth/login').send({ username: 'bob', password: 'correct horse battery staple' }).expect(403);
    expect(signIn.body.step).toBe('sanction');

    // The notice reached him by email (B-1907).
    const notice = await mail.next('bob@example.test', before);
    expect(notice.subject).toMatch(/moderation notice: Your account is suspended until/);
    expect(notice.text).toContain('Repeated spam');

    // The sweep ends it once its time is up; he can sign in again and is told.
    await h.s.db('moderation_sanctions').where({ id: s.body.id }).update({ ends_at: Date.now() - 1000 });
    const swept = await h.s.moderation.sweep(h.tenantId);
    expect(swept.expired).toBe(1);
    expect((await h.s.db('moderation_sanctions').where({ id: s.body.id }).first()).state).toBe('expired');
    await request(h.app).get('/api/me').set('authorization', `Bearer ${key}`).expect(200);
    bob = wrap(await login(h, 'bob'));
    await bob.get('/api/me').expect(200);
    expect((await mail.next('bob@example.test', before + 1)).subject).toMatch(/has ended/);

    // A ban without a duration lasts until lifted; a warning keeps the user in.
    const w = await admin.post('/api/moderation/sanctions', { userId: ids.bob, kind: 'warn', reason: 'Mind the tone' }).expect(201);
    await bob.get('/api/me').expect(200);
    const ban = await admin.post('/api/moderation/sanctions', { userId: ids.bob, kind: 'ban', reason: 'Enough' }).expect(201);
    expect(ban.body.endsAt).toBeNull();
    expect((await request(h.app).post('/api/auth/login').send({ username: 'bob', password: 'correct horse battery staple' }).expect(403)).body.title).toBe('Account banned');
    // A reviewer records his appeal of the ban for him (he cannot sign in); the admin who banned him cannot decide
    // it, another reviewer can, and upholding it lets him back in.
    const ap = await reviewer2.post('/api/moderation/appeals', { sanctionId: ban.body.id, statement: 'Replied by email: please reconsider.', forUserId: ids.bob }).expect(201);
    expect(ap.body).toMatchObject({ filedBy: ids.reviewer, userId: ids.bob, kind: 'sanction' });
    expect((await admin.post(`/api/moderation/appeals/${ap.body.ref}/decide`, { decision: 'upheld' }).expect(403)).body.step).toBe('independence');
    const up = await reviewer2.post(`/api/moderation/appeals/${ap.body.ref}/decide`, { decision: 'upheld' }).expect(200);
    expect(up.body.effects).toMatchObject({ sanctionEnded: true });
    bob = wrap(await login(h, 'bob'));
    await bob.get('/api/me').expect(200);
    expect((await admin.get(`/api/moderation/sanctions?userId=${ids.bob}`).expect(200)).body.items.map((x: { kind: string; state: string }) => `${x.kind}:${x.state}`)).toEqual(['ban:reversed', 'warn:active', 'suspend:expired']);
    await admin.post(`/api/moderation/sanctions/${w.body.id}/lift`, { reason: 'Talked it through' }).expect(200);
    const audit = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).where('action', 'like', 'moderation.%').select('action')).map((x: { action: string }) => x.action);
    for (const a of ['moderation.sanction.created', 'moderation.sanction.expired', 'moderation.sanction.reversed', 'moderation.sanction.lifted', 'moderation.signin.refused']) expect(audit).toContain(a);
  });

  it('B-1905: a routed flag past its SLA escalates; a failed moderation job is dead-lettered and redriven', async () => {
    await alice.post('/api/moderation/queues', { name: 'x', slaMinutes: 5, escalateTo: 'tenant' }).expect(403);
    const q = await admin.post('/api/moderation/queues', { name: 'Spam', rules: ['spam-link'], labels: ['internal'], workspaceId: ws, slaMinutes: 5, escalateTo: 'tenant', escalationSlaMinutes: 30 }).expect(201);
    await admin.post('/api/moderation/queues', { name: 'Spam', slaMinutes: 5, escalateTo: 'tenant' }).expect(409);
    const m = await message(ids.alice, 'SPAMLINK in the queue');
    const r = await admin.post('/api/moderation/check', { type: 'message', id: m.messageId }).expect(200);
    expect(r.body.flag.queueId).toBe(q.body.id);
    let flag = await h.s.guard.flags.get(h.tenantId, r.body.flag.ref);
    expect(flag.sla_minutes).toBe(5);
    expect(flag.due_at).toBe(flag.created_at + 5 * 60_000);
    // A flag from another rule is not routed there.
    const other2 = await admin.post('/api/moderation/check', { type: 'message', id: (await message(ids.alice, 'FORBIDDENWORD again')).messageId }).expect(200);
    expect(other2.body.flag.queueId).toBeNull();

    expect((await h.s.moderation.sweep(h.tenantId)).escalated).toBe(0);
    await h.s.db('guard_flags').where({ id: flag.id }).update({ due_at: Date.now() - 60_000 });
    const swept = await h.s.moderation.sweep(h.tenantId);
    expect(swept.escalated).toBe(1);
    flag = await h.s.guard.flags.get(h.tenantId, flag.id);
    expect(flag).toMatchObject({ escalated_to: 'tenant', sla_minutes: 30 });
    expect(flag.escalated_at).toBeTruthy();
    expect((await h.s.moderation.sweep(h.tenantId)).escalated).toBe(0);
    const qf = await admin.get(`/api/moderation/queues/${q.body.id}/flags`).expect(200);
    expect(qf.body).toMatchObject({ open: 1, escalated: 1 });
    expect((await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'moderation.queue.escalated' })).length).toBe(1);

    // A provider that is down: the job retries, then lands in the dead-letter queue; redriving it succeeds.
    h.s.zones.current = async () => new Map([['edge', { version: 1, spec: egressZone() }]]) as never;
    const pr = await admin.post('/api/moderation/providers', { name: 'Down', url: provider.url, zone: 'edge', mode: 'shadow', enabled: true }).expect(201);
    provider.failing = true;
    await admin.post('/api/moderation/check', { type: 'message', id: m.messageId }).expect(200);
    await drain();
    const dl = await admin.get('/api/moderation/dead-letters?state=open').expect(200);
    expect(dl.body.items).toHaveLength(1);
    expect(dl.body.items[0]).toMatchObject({ type: 'moderation.provider', attempts: 3 });
    provider.failing = false;
    const red = await admin.post(`/api/moderation/dead-letters/${dl.body.items[0].id}/redrive`).expect(201);
    await admin.post(`/api/moderation/dead-letters/${dl.body.items[0].id}/redrive`).expect(409);
    await drain();
    expect((await h.s.db('jobs').where({ id: red.body.jobId }).first()).state).toBe('succeeded');
    expect((await admin.get(`/api/moderation/providers/${pr.body.id}/verdicts`).expect(200)).body.items).toHaveLength(1);
    await admin.del(`/api/moderation/providers/${pr.body.id}`).expect(204);
  });

  it('B-1906: providers are off unless turned on and only in zones with egress; shadow records without acting, enforce acts', async () => {
    h.s.zones.current = async () => new Map([['edge', { version: 1, spec: egressZone() }], ['data', { version: 1, spec: { ...egressZone(), egress: { mode: 'deny', allow: [], note: null } } }], ['inside', { version: 1, spec: { ...egressZone(), egress: { mode: 'allow-list', allow: [{ kind: 'cidr', cidr: '10.0.0.0/8', ports: [] }], note: null } } }]]) as never;
    const cfg = h.s.cfg as { MODERATION_EXTERNAL_PROVIDERS: boolean };
    cfg.MODERATION_EXTERNAL_PROVIDERS = false;
    expect((await admin.post('/api/moderation/providers', { name: 'Off', url: provider.url, zone: 'edge' }).expect(403)).body.step).toBe('disabled');
    cfg.MODERATION_EXTERNAL_PROVIDERS = true;
    expect((await admin.post('/api/moderation/providers', { name: 'Data', url: provider.url, zone: 'data' }).expect(403)).body.step).toBe('zone');
    await admin.post('/api/moderation/providers', { name: 'Inside', url: provider.url, zone: 'inside' }).expect(403);
    await admin.post('/api/moderation/providers', { name: 'Nowhere', url: provider.url, zone: 'missing' }).expect(403);
    await admin.post('/api/moderation/providers', { name: 'Metadata', url: 'http://169.254.169.254/latest', zone: 'edge' }).expect(422);

    const pr = await admin.post('/api/moderation/providers', { name: 'Acme moderation', url: provider.url, zone: 'edge', secret: 'prov-secret-1' }).expect(201);
    expect(pr.body).toMatchObject({ enabled: false, mode: 'shadow', hasSecret: true });
    expect(JSON.stringify(pr.body)).not.toContain('prov-secret-1');
    // Off by default: a check queues nothing.
    const m1 = await message(ids.alice, 'quiet EXTERNALBAD words');
    expect((await admin.post('/api/moderation/check', { type: 'message', id: m1.messageId }).expect(200)).body.providers).toEqual([]);

    // Shadow: the verdict is recorded, nothing else happens.
    await admin.patch(`/api/moderation/providers/${pr.body.id}`, { enabled: true }).expect(200);
    const calls = provider.calls.length;
    const shadow = await admin.post('/api/moderation/check', { type: 'message', id: m1.messageId }).expect(200);
    expect(shadow.body.verdict.action).toBe('allow');
    expect(shadow.body.providers).toEqual([{ id: pr.body.id, mode: 'shadow', jobId: expect.any(String) }]);
    await drain();
    expect(provider.calls.length).toBe(calls + 1);
    expect(provider.calls.at(-1)).toMatchObject({ input: 'quiet EXTERNALBAD words', type: 'message', auth: 'Bearer prov-secret-1' });
    let verdicts = (await admin.get(`/api/moderation/providers/${pr.body.id}/verdicts`).expect(200)).body.items;
    expect(verdicts[0]).toMatchObject({ objectId: m1.messageId, mode: 'shadow', flagged: true, acted: false, flagId: null, categories: ['harassment'] });
    expect((await h.s.db('messages').where({ id: m1.messageId }).first()).state).toBe('complete');
    expect(await h.s.db('guard_flags').where({ source_kind: 'message', source_id: m1.messageId }).first()).toBeUndefined();
    // The job payload carries the text sealed, never in the clear.
    expect(JSON.stringify(await h.s.db('jobs').where({ type: 'moderation.provider' }).select('payload'))).not.toContain('EXTERNALBAD');

    // Enforce: a flagged verdict files the object's flag and hides it.
    await admin.patch(`/api/moderation/providers/${pr.body.id}`, { mode: 'enforce' }).expect(200);
    const m2 = await message(ids.alice, 'loud EXTERNALBAD words');
    await admin.post('/api/moderation/check', { type: 'message', id: m2.messageId }).expect(200);
    await drain();
    verdicts = (await admin.get(`/api/moderation/providers/${pr.body.id}/verdicts`).expect(200)).body.items;
    expect(verdicts[0]).toMatchObject({ objectId: m2.messageId, mode: 'enforce', flagged: true, acted: true, flagId: expect.any(String) });
    expect((await h.s.db('messages').where({ id: m2.messageId }).first()).state).toBe('hidden');
    const audit = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).where('action', 'like', 'moderation.provider.%').select('action')).map((x: { action: string }) => x.action);
    expect(audit).toEqual(expect.arrayContaining(['moderation.provider.created', 'moderation.provider.updated', 'moderation.provider.enforced']));
  });
});

function egressZone() {
  return { contents: 'egress proxy', trust: 'private', cidrs: ['10.70.0.0/24'], maxLabel: 'internal', accepts: [], acceptsNote: null, egress: { mode: 'allow-list', allow: [{ kind: 'cidr', cidr: '0.0.0.0/0', ports: [443] }], note: null }, peers: [], services: [] };
}

describe('moderation provider verdicts', () => {
  it('reads the json and OpenAI answer shapes, with the threshold', () => {
    expect(parseVerdict('json', { flagged: false, score: 0.8, categories: ['Hate Speech'] }, 0.5)).toEqual({ flagged: true, score: 0.8, categories: ['hate-speech'] });
    expect(parseVerdict('openai', { results: [{ flagged: false, categories: { harassment: true, violence: false }, category_scores: { harassment: 0.3, violence: 0.1 } }] }, 0.5)).toEqual({ flagged: false, score: 0.3, categories: ['harassment'] });
    expect(() => parseVerdict('openai', { nope: 1 }, 0.5)).toThrow();
  });
});
