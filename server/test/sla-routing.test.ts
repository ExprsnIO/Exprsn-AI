import { ulid } from 'ulid';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPrincipal } from '../src/http/middleware.js';
import { addBusiness, businessHoursSchema, businessMs } from '../src/sla/hours.js';
import { evaluate, type SlaItem } from '../src/sla/service.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * Sprint 46 (B-134): SLA timers in business hours, pause and resume, warn and breach actions, assignment routing
 * (round-robin, least-loaded, skills, availability) through the domains' own paths, and the per-queue statistics.
 */

const MIN = 60_000;
const H = 60 * MIN;
const WEEKDAYS = { mon: [['09:00', '17:00']], tue: [['09:00', '17:00']], wed: [['09:00', '17:00']], thu: [['09:00', '17:00']], fri: [['09:00', '17:00']] };
// Monday 19 October 2026 is a holiday here.
const hours = businessHoursSchema.parse({ timeZone: 'America/New_York', week: WEEKDAYS, holidays: ['2026-10-19'] });

describe('B-134 business hours', () => {
  it('counts only open time, across a weekend and a holiday, in the zone (daylight saving included)', () => {
    // Friday 16 October 2026, 16:00 in New York (EDT, UTC-4).
    const fri4pm = Date.parse('2026-10-16T20:00:00Z');
    // Two hours of open time: one on Friday, nothing on the weekend or the holiday Monday, one on Tuesday.
    expect(new Date(addBusiness(fri4pm, 2 * H, hours)!).toISOString()).toBe('2026-10-20T14:00:00.000Z');
    expect(businessMs(fri4pm, Date.parse('2026-10-20T14:00:00Z'), hours)).toBe(2 * H);
    expect(businessMs(Date.parse('2026-10-17T12:00:00Z'), Date.parse('2026-10-19T20:00:00Z'), hours)).toBe(0);
    // Across the end of daylight saving (1 November): Monday 2 November opens at 09:00 EST, 14:00 UTC.
    expect(new Date(addBusiness(Date.parse('2026-10-30T20:30:00Z'), H, hours)!).toISOString()).toBe('2026-11-02T14:30:00.000Z');
    // Without a schedule every hour counts.
    expect(addBusiness(fri4pm, 2 * H, null)).toBe(fri4pm + 2 * H);
    // Bad input is refused.
    expect(businessHoursSchema.safeParse({ timeZone: 'Mars/Olympus', week: {} }).success).toBe(false);
    expect(businessHoursSchema.safeParse({ timeZone: 'UTC', week: { mon: [['17:00', '09:00']] } }).success).toBe(false);
  });

  it('pauses the resolution clock while waiting on the customer and resumes it when they write', () => {
    const t0 = Date.parse('2026-10-20T13:00:00Z'); // Tuesday 09:00 New York
    const policy = { id: 'P', name: 'Support', first_response_minutes: 30, resolution_minutes: 240, warn_percent: 75, hours, pause_on_customer: true };
    const item: SlaItem = { type: 'channel-session', id: 's', tenantId: 't', workspaceId: null, label: 'internal', scope: 'c', title: 'S', startedAt: t0, firstResponseAt: t0 + 20 * MIN, resolvedAt: null, pauses: [[t0 + 20 * MIN, null]], assignee: null, tags: [] };
    // Waiting on the customer from 09:20: the clock stands still.
    const paused = evaluate(item, policy, t0 + 3 * H);
    expect(paused.state).toBe('paused');
    expect(paused.firstResponse).toMatchObject({ met: true, breached: false });
    expect(paused.resolution).toMatchObject({ paused: true, dueAt: null, leftMs: 220 * MIN });
    // The customer wrote at 12:20: three hours paused; the due time moves by them.
    const resumed = evaluate({ ...item, pauses: [[t0 + 20 * MIN, t0 + 200 * MIN]] }, policy, t0 + 4 * H);
    expect(resumed.resolution).toMatchObject({ paused: false, dueAt: t0 + 420 * MIN, leftMs: 180 * MIN });
    expect(resumed.state).toBe('ok');
    // Without the pause option the same session would be past its target.
    expect(evaluate({ ...item, pauses: [[t0 + 20 * MIN, t0 + 200 * MIN]] }, { ...policy, pause_on_customer: false }, t0 + 5 * H).state).toBe('breached');
  });
});

describe('B-134 timers, actions, routing and statistics', () => {
  let h: Harness;
  let admin: Client;
  afterEach(async () => {
    await h?.close();
  });

  const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);
  const put = (c: Client, url: string, body: object = {}) => c.agent.put(url).set('x-csrf-token', c.csrf).send(body);

  async function setup() {
    h = await harness();
    await localUser(h, 'sadmin', ['guardrail-admin', 'tenant-admin'], 'confidential');
    const ids: Record<string, string> = {};
    for (const u of ['r1', 'r2', 'r3']) ids[u] = (await localUser(h, u, ['flag-reviewer'], 'confidential')).id;
    ids.mem = (await localUser(h, 'mem', ['member'])).id;
    // Order the reviewers by id so turns are predictable.
    const sorted = [ids.r1!, ids.r2!, ids.r3!].sort();
    admin = await loginAdmin(h, 'sadmin');
    return { ids, sorted };
  }

  let n = 0;
  const flag = (severity: 'high' | 'medium' | 'low' = 'medium', ruleName = 'Toxicity') => h.s.guard.flags.create({ tenantId: h.tenantId, workspaceId: null, kind: 'report', checkpoint: 'user-report', ruleName: `${ruleName}`, severity, label: 'internal', note: `report ${++n}` });
  const assignee = async (id: string) => ((await h.s.db('guard_flags').where({ id }).first('assignee')) as { assignee: string | null }).assignee;
  const audits = async (action: string) => (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action })).length;
  const online = (userId: string, idle = false) => h.s.presence.connected(h.tenantId, userId, `sock-${userId}`).then(() => (idle ? h.s.presence.activity(h.tenantId, userId, `sock-${userId}`, true) : undefined));

  it('fires warn and breach actions once: notify, raise priority and escalate to a person', async () => {
    const { ids } = await setup();
    const res = await post(admin, '/api/sla/policies', { name: 'Reports', queueType: 'flag', firstResponseMinutes: 60, warnPercent: 50, onWarn: [{ kind: 'notify' }], onBreach: [{ kind: 'priority', to: 'urgent' }, { kind: 'escalate', user: ids.r3 }] }).expect(201);
    expect(res.body).toMatchObject({ queueType: 'flag', scope: '*', firstResponseMinutes: 60 });
    const f = await flag();
    const t0 = f.created_at;
    expect(await h.s.sla.tick(h.tenantId, t0 + 10 * MIN)).toMatchObject({ tracked: 1, warned: 0, breached: 0 });
    expect(await h.s.sla.tick(h.tenantId, t0 + 31 * MIN)).toMatchObject({ warned: 1, breached: 0 });
    expect(await h.s.sla.tick(h.tenantId, t0 + 32 * MIN)).toMatchObject({ warned: 0 });
    const warned = (await h.s.db('notifications').where({ user_id: ids.r1, kind: 'sla' })) as { title: string }[];
    expect(warned.map((x) => x.title)).toEqual([`${`F-${f.number}`} is close to its first response target`]);

    expect(await h.s.sla.tick(h.tenantId, t0 + 61 * MIN)).toMatchObject({ breached: 1 });
    expect(await h.s.sla.tick(h.tenantId, t0 + 62 * MIN)).toMatchObject({ breached: 0 });
    // Escalated through the flag queue's own path: the event and the person's notice.
    expect(await assignee(f.id)).toBe(ids.r3);
    expect((await h.s.db('guard_flag_events').where({ flag_id: f.id, action: 'reassigned' })).length).toBe(1);
    expect((await h.s.db('notifications').where({ user_id: ids.r3, kind: 'flag' })).length).toBe(1);
    // Read now, the flag raised 61 minutes ago.
    await h.s.db('guard_flags').where({ id: f.id }).update({ created_at: Date.now() - 61 * MIN });
    const view = (await admin.agent.get('/api/sla/items?type=flag').expect(200)).body;
    expect(view.items[0]).toMatchObject({ id: f.id, priority: 'urgent', assignee: ids.r3, sla: { state: 'breached' } });
    expect(await audits('sla.item.warned')).toBe(1);
    expect(await audits('sla.item.breached')).toBe(1);
    // The breaching-soon filter.
    expect((await admin.agent.get('/api/sla/items?type=flag&filter=breaching-soon').expect(200)).body.items).toHaveLength(1);
  });

  it('routes round-robin and least-loaded through FlagService.assignTo', async () => {
    const { sorted } = await setup();
    await put(admin, '/api/sla/routing', { queueType: 'flag', mode: 'round-robin', pool: { role: 'flag-reviewer' }, skipUnavailable: false }).expect(200);
    const fs = [await flag(), await flag(), await flag(), await flag()];
    expect((await h.s.sla.tick(h.tenantId)).routed).toBe(4);
    expect(await Promise.all(fs.map((f) => assignee(f.id)))).toEqual([sorted[0], sorted[1], sorted[2], sorted[0]]);
    expect((await h.s.db('guard_flag_events').where({ action: 'reassigned', actor: 'sla-routing' })).length).toBe(4);
    expect(await audits('sla.item.routed')).toBe(4);

    // Least-loaded: the person with the fewest open items gets the next one.
    await put(admin, '/api/sla/routing', { queueType: 'flag', mode: 'least-loaded', pool: { role: 'flag-reviewer' }, skipUnavailable: false }).expect(200);
    const next = await flag();
    await h.s.sla.tick(h.tenantId);
    // sorted[0] holds two, the others one each: the first of those by id.
    expect(await assignee(next.id)).toBe(sorted[1]);
    const after = await flag();
    await h.s.sla.tick(h.tenantId);
    expect(await assignee(after.id)).toBe(sorted[2]);
  });

  it('routes by skills matched against the item, and falls back when nobody has them', async () => {
    const { ids } = await setup();
    await put(admin, `/api/sla/skills/${ids.r2}`, { skills: ['High', 'rule:hate speech'] }).expect(200);
    await put(admin, `/api/sla/skills/${ids.r3}`, { skills: ['high'] }).expect(200);
    expect((await admin.agent.get('/api/sla/skills').expect(200)).body.items).toEqual(expect.arrayContaining([expect.objectContaining({ userId: ids.r2, skills: ['high', 'rule:hate speech'] })]));
    await put(admin, '/api/sla/routing', { queueType: 'flag', mode: 'skills', pool: { role: 'flag-reviewer' }, skipUnavailable: false, fallback: { kind: 'user', userId: ids.r1 } }).expect(200);
    const both = await flag('high', 'Hate speech');
    const one = await flag('high', 'Spam');
    const none = await flag('low', 'Spam');
    await h.s.sla.tick(h.tenantId);
    // Two matching skills beat one; the skill holders share the rest by load; nobody matching goes to the fallback.
    expect(await assignee(both.id)).toBe(ids.r2);
    expect(await assignee(one.id)).toBe(ids.r3);
    expect(await assignee(none.id)).toBe(ids.r1);
    expect(await audits('sla.skills.updated')).toBe(2);
  });

  it('skips people who are away or offline, and uses the fallback when everyone is', async () => {
    const { ids, sorted } = await setup();
    await put(admin, '/api/sla/routing', { queueType: 'flag', mode: 'least-loaded', pool: { role: 'flag-reviewer' }, skipUnavailable: true, fallback: { kind: 'queue' } }).expect(200);
    // Nobody connected: everyone reads offline, and the fallback leaves the flag in the queue.
    const first = await flag();
    await h.s.sla.tick(h.tenantId);
    expect(await assignee(first.id)).toBeNull();
    // r1 is away (idle), r2 is available, r3 offline: r2 even with more open items.
    await online(ids.r1!, true);
    await online(ids.r2!);
    const busy = await flag();
    await h.s.guard.flags.assignTo(busy, ids.r2!, { id: ids.r2!, name: 'R2' });
    const second = await flag();
    await h.s.sla.tick(h.tenantId);
    expect(await assignee(second.id)).toBe(ids.r2);
    expect(await assignee(first.id)).toBe(ids.r2);
    // The audit says how many were skipped.
    const row = (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'sla.item.routed' }).orderBy('seq', 'desc').first()) as { detail: string };
    expect(JSON.parse(row.detail)).toMatchObject({ skippedUnavailable: 2 });
    expect(sorted).toHaveLength(3);
  });

  it('assigns escalated channel sessions through ChannelService.assignSession, counting pauses', async () => {
    const { ids } = await setup();
    const ws = await h.s.tenants.createWorkspace(h.tenantId, 'Support', 'confidential', { visibility: 'tenant' });
    const t = Date.now();
    const channel = ulid();
    await h.s.db('channels').insert({ id: channel, tenant_id: h.tenantId, workspace_id: ws.id, name: 'Help desk', kind: 'chat', state: 'active', label: 'internal', target_kind: 'profile', target_name: 'general', review_mode: 'escalated', allow_anonymous: true, messages_per_minute: 10, sessions_per_hour: 10, public_key: `pk-${channel}`, settings: '{}', created_at: t, updated_at: t });
    const session = ulid();
    const t0 = t - 2 * H;
    await h.s.db('channel_sessions').insert({ id: session, tenant_id: h.tenantId, channel_id: channel, workspace_id: ws.id, label: 'internal', state: 'escalated', customer_kind: 'anonymous', next_seq: 4, escalated_at: t0, escalation: 'asked for a person', last_activity_at: t, created_at: t0, updated_at: t });
    const msg = (seq: number, role: string, at: number) => h.s.db('channel_messages').insert({ id: ulid(), tenant_id: h.tenantId, session_id: session, channel_id: channel, seq, role, state: 'delivered', via: 'web', body: 'x', label: 'internal', created_at: at, delivered_at: at });
    await msg(1, 'customer', t0);
    await msg(2, 'agent', t0 + 10 * MIN);
    await msg(3, 'customer', t0 + 70 * MIN);
    await post(admin, '/api/sla/policies', { name: 'Desk', queueType: 'channel-session', scope: channel, firstResponseMinutes: 15, resolutionMinutes: 120, warnPercent: 80 }).expect(201);
    await put(admin, '/api/sla/routing', { queueType: 'channel-session', mode: 'least-loaded', pool: { role: 'flag-reviewer' }, skipUnavailable: false }).expect(200);
    await h.s.sla.tick(h.tenantId);
    const s1 = (await h.s.db('channel_sessions').where({ id: session }).first()) as { assignee_id: string | null };
    expect([ids.r1, ids.r2, ids.r3]).toContain(s1.assignee_id);
    expect(await audits('channel.session.assigned')).toBe(1);
    const item = (await admin.agent.get(`/api/sla/items/${session}?type=channel-session`).expect(200)).body;
    expect(item.pauses).toEqual([[t0 + 10 * MIN, t0 + 70 * MIN]]);
    expect(item.sla.firstResponse).toMatchObject({ met: true });
    // 120 minutes elapsed, 60 of them waiting on the customer: an hour left.
    expect(Math.round(item.sla.resolution.leftMs / MIN)).toBe(60);
    // A reviewer hands it on by hand, through the same path.
    const r = await login(h, 'r1');
    await r.agent.post(`/api/channels/${channel}/sessions/${session}/assign`).set('x-csrf-token', r.csrf).send({ userId: ids.r2 }).expect(200);
    expect(((await h.s.db('channel_sessions').where({ id: session }).first()) as { assignee_id: string }).assignee_id).toBe(ids.r2);
  });

  it('keeps per-queue statistics: met percentage and average first response', async () => {
    const { ids } = await setup();
    await post(admin, '/api/sla/policies', { name: 'Reports', queueType: 'flag', firstResponseMinutes: 60, resolutionMinutes: 120 }).expect(201);
    const reviewer = (await loadPrincipal(h.s, h.tenantId, ids.r1!, {}))!;
    const now = Date.now();
    const fast = await flag();
    const slow = await flag();
    const open = await flag();
    // Raised 30 min and 3 h ago.
    await h.s.db('guard_flags').where({ id: fast.id }).update({ created_at: now - 30 * MIN });
    await h.s.db('guard_flags').where({ id: slow.id }).update({ created_at: now - 3 * H });
    await h.s.sla.tick(h.tenantId);
    await h.s.guard.flags.decide(reviewer, `F-${fast.number}`, [], 'confirmed', null);
    await h.s.guard.flags.decide(reviewer, `F-${slow.number}`, [], 'dismissed', null);
    expect((await h.s.sla.tick(h.tenantId)).closed).toBe(2);
    const stats = (await admin.agent.get('/api/sla/stats?type=flag&days=7').expect(200)).body;
    expect(stats.total).toMatchObject({ resolved: 2, open: 1, resolutionMetPercent: 50 });
    // First responses: the decision is the first touch, 30 min and 180 min after raising.
    expect(Math.round(stats.total.averageFirstResponseMs / MIN)).toBe(105);
    expect(stats.scopes[0]).toMatchObject({ scope: '*', resolved: 2, firstResponseMetPercent: 50, open: 1 });
    expect(open.id).toBeTruthy();
  });

  it('keeps each domain\'s permissions on its policies and refuses bad ones', async () => {
    const { ids } = await setup();
    await localUser(h, 'chadmin', ['member'], 'internal');
    const m = await login(h, 'mem');
    await post(m, '/api/sla/policies', { name: 'x', queueType: 'flag', firstResponseMinutes: 5 }).expect(403);
    await m.agent.get('/api/sla/items?type=flag').expect(403);
    // A tenant admin manages channels but not, on that alone, the moderation queues' policies (guardrail-admin does).
    await post(admin, '/api/sla/policies', { name: 'none', queueType: 'appeal' }).expect(400);
    await post(admin, '/api/sla/policies', { name: 'bad', queueType: 'flag', firstResponseMinutes: 5, onBreach: [{ kind: 'escalate' }] }).expect(400);
    await post(admin, '/api/sla/policies', { name: 'bad hours', queueType: 'flag', firstResponseMinutes: 5, hours: { timeZone: 'Nowhere/Here', week: {} } }).expect(400);
    await post(admin, '/api/sla/policies', { name: 'a', queueType: 'appeal', resolutionMinutes: 60 }).expect(201);
    await post(admin, '/api/sla/policies', { name: 'b', queueType: 'appeal', resolutionMinutes: 90 }).expect(409);
    const list = (await admin.agent.get('/api/sla/policies').expect(200)).body.items;
    expect(list.map((x: { name: string }) => x.name)).toEqual(['a']);
    await admin.agent.delete(`/api/sla/policies/${list[0].id}`).set('x-csrf-token', admin.csrf).expect(204);
    expect(await audits('sla.policy.created')).toBe(1);
    expect(await audits('sla.policy.deleted')).toBe(1);
    // Problem details carry the trace id.
    const bad = await put(admin, '/api/sla/routing', { queueType: 'flag', mode: 'sometimes' }).expect(400);
    expect(bad.headers['content-type']).toMatch(/problem\+json/);
    expect(bad.body.trace_id).toBeTruthy();
    expect(ids.mem).toBeTruthy();
  });
});
