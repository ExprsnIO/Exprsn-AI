/*
 * 1.9.0, Sprint 50 (B-161): graduated responses. A tenant starts in shadow (scores, no action); under enforce a
 * score reaches slow mode, a hold for review (through moderation/held.ts and the post's review flag), a temporary
 * posting limit and a case in the moderation queue; never a ban. The person is told and appeals through the existing
 * appeals, and an upheld appeal lifts the response; admins and the allow-list are exempt; every step is audited.
 */
import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { policyInput, RESPONSE_KINDS } from '../src/spam/policy.js';
import { withSpamHold } from '../src/spam/service.js';
import { localUser, login, loginAdmin, type Harness } from './helpers.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { spamHarness } from './spam-helpers.js';

type Agent = Awaited<ReturnType<typeof agentFor>>;

async function agentFor(c: { agent: ReturnType<typeof request.agent>; csrf: string }) {
  const send = (method: 'post' | 'put' | 'patch' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
  return { get: (p: string) => c.agent.get(p), post: (p: string, b?: object) => send('post', p, b), put: (p: string, b?: object) => send('put', p, b) };
}

describe('graduated spam responses', () => {
  let h: Harness;
  let ws: string;
  let admin: Agent;
  let reviewer: Agent;
  let adminId: string;
  const users: Record<string, { id: string; c: Agent }> = {};

  const audits = async (action: string) => (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action }).orderBy('seq')).map((r) => ({ ...r, detail: typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail, target: typeof r.target === 'string' ? JSON.parse(r.target) : r.target }));
  const member = async (name: string, roles = ['member']) => {
    const u = await localUser(h, name, roles);
    await h.s.tenants.addMember(ws, u.id);
    users[name] = { id: u.id, c: await agentFor(await login(h, name)) };
    return users[name]!;
  };
  const post = (who: string, body: string) => users[who]!.c.post('/api/feed/posts', { workspaceId: ws, body });

  beforeAll(async () => {
    h = await spamHarness();
    ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Town', 'internal')).id;
    const a = await localUser(h, 'spam-admin', ['tenant-admin']);
    adminId = a.id;
    await h.s.tenants.addMember(ws, a.id);
    admin = await agentFor(await loginAdmin(h, 'spam-admin'));
    await localUser(h, 'spam-reviewer', ['flag-reviewer']);
    reviewer = await agentFor(await login(h, 'spam-reviewer'));
    // Low steps, so a few posts reach each one: the second post in ten minutes is past an account threshold of 1.
    const saved = await admin.put('/api/moderation/spam/policy', { enabled: true, surfaces: { post: { account: 1, windowSeconds: 600 }, follow: { account: 1 }, message: { account: 1 } }, responses: { slowAt: 20, holdAt: 40, limitAt: 60, caseAt: 80, slowSeconds: 30, limitPerHour: 0, durationMinutes: 60 } }).expect(200);
    expect(saved.body.enabled).toBe(true);
    expect(saved.body.surfaces.post.mode).toBe('shadow');
  });
  afterAll(async () => h.close());

  it('starts in shadow: scores and audits, no action', async () => {
    await member('shadow-sam');
    for (let i = 0; i < 4; i++) await post('shadow-sam', `Shadow post number ${i} about the bake sale on Saturday`).expect(201);
    await h.s.spam.settle();
    const score = await h.s.spam.scoreOf(h.tenantId, users['shadow-sam']!.id);
    expect(score!.score).toBeGreaterThanOrEqual(40);
    expect(await h.s.db('spam_responses').where({ user_id: users['shadow-sam']!.id })).toHaveLength(0);
    expect(await h.s.db('moderation_sanctions').where({ user_id: users['shadow-sam']!.id })).toHaveLength(0);
    const scored = (await audits('spam.scored')).filter((a) => a.target.account === users['shadow-sam']!.id);
    expect(scored.length).toBeGreaterThan(0);
    expect(scored[scored.length - 1]!.detail).toMatchObject({ mode: 'shadow', applied: null });
    expect(scored.some((a) => a.detail.wouldApply === 'hold')).toBe(true);
    // The flagged list shows it with its reasons.
    const list = (await reviewer.get('/api/moderation/spam/accounts').expect(200)).body.items;
    const row = list.find((x: { userId: string }) => x.userId === users['shadow-sam']!.id);
    expect(row.reasons[0]).toMatchObject({ signal: 'rate.post.account', threshold: 1 });
    expect(row.responses).toEqual([]);
  });

  it('switches a surface to enforce (audited), then slows and holds', async () => {
    await member('enforce-eve');
    const r = await admin.put('/api/moderation/spam/policy', { surfaces: { post: { mode: 'enforce' }, follow: { mode: 'enforce' }, message: { mode: 'enforce' } } }).expect(200);
    expect(r.body.surfaces.post).toMatchObject({ mode: 'enforce', account: 1 });
    const upd = (await audits('spam.policy.updated')).pop()!;
    expect(upd.detail.modes.post).toBe('enforce');
    expect(upd.detail.beforeModes.post).toBe('shadow');
    // A member cannot change the policy.
    await users['enforce-eve']!.c.put('/api/moderation/spam/policy', { enabled: false }).expect(403);

    await post('enforce-eve', 'First post of the day about the library opening hours').expect(201);
    await post('enforce-eve', 'Second post of the day about the library opening hours').expect(201);
    await h.s.spam.settle();
    const [resp] = await h.s.db('spam_responses').where({ user_id: users['enforce-eve']!.id, state: 'active' });
    expect(resp).toMatchObject({ surface: 'post', kind: 'hold' });
    const applied = (await audits('spam.response.applied')).find((a) => a.target.user === users['enforce-eve']!.id)!;
    expect(applied.detail).toMatchObject({ surface: 'post', kind: 'hold', from: null });

    // Held for review: the post waits (202) behind its review flag, seen by its author only.
    const held = await post('enforce-eve', 'Third post, held for a moderator to read first');
    expect(held.status).toBe(202);
    expect(held.body.state).toBe('held');
    const flag = await h.s.db('guard_flags').where({ tenant_id: h.tenantId, source_id: held.body.id }).first();
    expect(flag).toMatchObject({ rule_name: 'Spam and flood', kind: 'hold' });
    // Slow mode: the next one within 30 seconds is refused with Retry-After.
    const slow = await post('enforce-eve', 'Fourth post too soon after the third one');
    expect(slow.status).toBe(429);
    expect(slow.body.step).toBe('spam-slow');
    expect(Number(slow.headers['retry-after'])).toBeGreaterThan(0);
    expect(slow.body.appeal).toBe(resp.sanction_id);
  });

  it('limits posting for a while, and opens a case with the evidence', async () => {
    const f = await member('limit-lou');
    const target = await member('target-tia');
    const policy = await h.s.spam.policy(h.tenantId);
    expect(await h.s.spam.apply(h.tenantId, f.id, 'follow', 'limit', 65, [{ signal: 'rate.follow.account', value: 9, threshold: 1, points: 40 }], policy)).toBe('limit');
    const limited = await f.c.post('/api/social/following', { userId: target.id });
    expect(limited.status).toBe(429);
    expect(limited.body.step).toBe('spam-limit');

    const reasons = [{ signal: 'near_duplicate', value: 7, threshold: 5, points: 42 }, { signal: 'rate.message.account', value: 12, threshold: 1, points: 40 }];
    expect(await h.s.spam.apply(h.tenantId, f.id, 'message', 'case', 90, reasons, policy)).toBe('case');
    const caseRow = await h.s.db('spam_responses').where({ user_id: f.id, surface: 'message', state: 'active' }).first();
    expect(caseRow.kind).toBe('case');
    const flag = await h.s.db('guard_flags').where({ id: caseRow.flag_id }).first();
    expect(flag).toMatchObject({ checkpoint: 'spam', rule_name: 'Spam and flood', kind: 'reviewer', source_kind: 'spam-account', source_id: f.id, state: 'open', excerpt: null });
    expect(flag.note).toContain('near_duplicate = 7, threshold 5');
    // Raising the same surface again updates the one response, it does not stack.
    expect(await h.s.spam.apply(h.tenantId, f.id, 'message', 'slow', 30, reasons, policy)).toBeNull();
    expect(await h.s.db('spam_responses').where({ user_id: f.id, surface: 'message' })).toHaveLength(1);
  });

  it('never bans or suspends', async () => {
    const kinds = (await h.s.db('moderation_sanctions').where({ tenant_id: h.tenantId }).distinct('kind')).map((r) => r.kind);
    expect(kinds).toEqual(['warn']);
    for (const u of Object.values(users)) expect(await h.s.moderation.blocking(h.tenantId, u.id)).toBeNull();
    // The most limited person still signs in and reads.
    await users['limit-lou']!.c.get('/api/me').expect(200);
    expect(RESPONSE_KINDS).not.toContain('ban' as never);
    expect(policyInput.safeParse({ responses: { banAt: 99 } }).success).toBe(false);
  });

  it('tells the person, and an upheld appeal lifts the response', async () => {
    const eve = users['enforce-eve']!;
    const notes = await h.s.db('notifications').where({ tenant_id: h.tenantId, user_id: eve.id, kind: 'spam.response' });
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toContain('held for review');
    const resp = await h.s.db('spam_responses').where({ user_id: eve.id, state: 'active' }).first();
    expect(notes[0].body).toContain(resp.sanction_id);
    const mine = (await eve.c.get('/api/moderation/spam/mine').expect(200)).body.items;
    expect(mine[0]).toMatchObject({ id: resp.id, kind: 'hold', sanctionId: resp.sanction_id });

    const appeal = (await eve.c.post('/api/moderation/appeals', { sanctionId: resp.sanction_id, statement: 'I was posting the library schedule for my neighbours.' }).expect(201)).body;
    await reviewer.post(`/api/moderation/appeals/${appeal.ref}/decide`, { decision: 'upheld', note: 'Ordinary posts.' }).expect(200);
    const after = await h.s.db('spam_responses').where({ id: resp.id }).first();
    expect(after).toMatchObject({ state: 'lifted', lift_reason: 'Appeal upheld' });
    const lifted = (await audits('spam.response.lifted')).find((a) => a.target.response === resp.id)!;
    expect(lifted.detail).toMatchObject({ state: 'lifted', reason: 'Appeal upheld' });
    // Writing is back to normal: no slow mode, no hold.
    expect(await h.s.spam.gate((await loadPrincipal(h.s, h.tenantId, eve.id, {}))!, 'post')).toEqual({ hold: null });
    const free = await post('enforce-eve', 'Back to normal after the appeal');
    expect(free.status).not.toBe(429);
  });

  it('lets a moderator lift a response (and its warning)', async () => {
    const lou = users['limit-lou']!;
    const resp = await h.s.db('spam_responses').where({ user_id: lou.id, surface: 'follow', state: 'active' }).first();
    await users['target-tia']!.c.post(`/api/moderation/spam/responses/${resp.id}/lift`, { reason: 'x' }).expect(403);
    const out = (await admin.post(`/api/moderation/spam/responses/${resp.id}/lift`, { reason: 'Known organiser' }).expect(200)).body;
    expect(out).toMatchObject({ state: 'lifted', liftReason: 'Known organiser', liftedBy: adminId });
    expect((await h.s.db('moderation_sanctions').where({ id: resp.sanction_id }).first()).state).toBe('lifted');
    await admin.post(`/api/moderation/spam/responses/${resp.id}/lift`, {}).expect(409);
    const target = users['target-tia']!;
    await lou.c.post('/api/social/following', { userId: target.id }).expect((r) => expect(r.status).toBeLessThan(400));
  });

  it('exempts admins and the allow-list', async () => {
    for (let i = 0; i < 4; i++) await admin.post('/api/feed/posts', { workspaceId: ws, body: `Admin notice ${i}: the hall is closed for cleaning on Sunday morning` }).expect(201);
    await h.s.spam.settle();
    expect(await h.s.db('spam_responses').where({ user_id: adminId })).toHaveLength(0);
    const scored = (await audits('spam.scored')).filter((a) => a.target.account === adminId);
    expect(scored.some((a) => a.detail.exempt === true)).toBe(true);

    const ally = await member('allowed-ali');
    await admin.put('/api/moderation/spam/policy', { allowList: [ally.id] }).expect(200);
    for (let i = 0; i < 4; i++) await post('allowed-ali', `Neighbourhood watch update ${i} for the north side streets`).expect(201);
    await h.s.spam.settle();
    expect(await h.s.db('spam_responses').where({ user_id: ally.id })).toHaveLength(0);
    // The allow-list names accounts of this tenant only.
    await admin.put('/api/moderation/spam/policy', { allowList: ['01ARZ3NDEKTSV4RRFFQ69G5FAV'] }).expect(422);
    // Steps that do not rise are refused.
    await admin.put('/api/moderation/spam/policy', { responses: { slowAt: 90 } }).expect(400);
  });

  it('adds a hold to a decision without weakening a block', () => {
    const hold = { ruleId: 'spam', ruleName: 'Spam and flood', action: 'require-approval' as const, stage: 'enforce' as const };
    expect(withSpamHold({ action: 'allow', text: 't', findings: [] }, hold)).toMatchObject({ action: 'require-approval', findings: [hold] });
    expect(withSpamHold({ action: 'block', text: 't', findings: [] }, hold).action).toBe('block');
    expect(withSpamHold({ action: 'redact', text: 't', findings: [] }, null).action).toBe('redact');
  });

  it('audits every step', async () => {
    for (const a of ['spam.scored', 'spam.response.applied', 'spam.response.lifted', 'spam.policy.updated']) expect((await audits(a)).length, a).toBeGreaterThan(0);
  });
});
