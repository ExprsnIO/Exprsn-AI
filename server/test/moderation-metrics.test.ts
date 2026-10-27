/*
 * 1.9.0, Sprint 50 (B-158): guardrail and moderation metrics. Daily aggregates from the recorded decisions, appeals,
 * flags, held writes and spam responses (no content), the false-positive rate from upheld appeals, time to decision,
 * the trend with today computed afresh, the Overview card behind its permission, and the CSV export behind
 * `moderation:review`, audited.
 */
import request from 'supertest';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dayOf, ModerationMetrics } from '../src/spam/metrics.js';
import { localUser, login, loginAdmin, type Harness } from './helpers.js';
import { clock, person, spamHarness } from './spam-helpers.js';

const DAY = 86_400_000;

describe('moderation metrics', () => {
  let h: Harness;
  const c = clock(Date.UTC(2026, 9, 18, 15, 0, 0));
  let m: ModerationMetrics;
  let userId: string;

  const decision = (at: number, action: string, findings: { ruleId: string; ruleName: string; setId: string; stage: string; action: string }[]) =>
    h.s.db('guard_decisions').insert({ id: ulid(at), tenant_id: h.tenantId, workspace_id: null, user_id: null, checkpoint: 'user-input', label: 'internal', action, text: null, meta: null, findings: JSON.stringify(findings), timings: '{}', source_kind: null, source_id: null, latency_ms: 1, created_at: at });
  const appeal = (n: number, state: 'upheld' | 'denied', created: number, decided: number) =>
    h.s.db('moderation_appeals').insert({ id: ulid(), tenant_id: h.tenantId, number: n, workspace_id: null, kind: 'action', action_id: ulid(), sanction_id: null, flag_id: null, label: 'internal', user_id: userId, filed_by: userId, statement: 'sealed', state, reviewer_id: null, decision_note: null, created_at: created, reviewed_at: decided, decided_at: decided });

  beforeAll(async () => {
    h = await spamHarness();
    m = new ModerationMetrics(() => h.s, c.now);
    userId = (await person(h, 'met-user')).id;
    const today = c.now() - 3_600_000;
    const yesterday = c.now() - DAY;
    const pii = { ruleId: 'R-PII', ruleName: 'No card numbers', setId: 'S-BASE', stage: 'enforce', action: 'block' };
    const tone = { ruleId: 'R-TONE', ruleName: 'Tone', setId: 'S-BASE', stage: 'shadow', action: 'flag' };
    const mask = { ruleId: 'R-MASK', ruleName: 'Mask emails', setId: 'S-WS', stage: 'enforce', action: 'redact' };
    await decision(yesterday, 'block', [pii, pii, tone]);
    await decision(yesterday, 'redact', [mask]);
    await decision(yesterday, 'allow', []);
    await decision(yesterday, 'flag', [tone]);
    await decision(today, 'block', [pii]);
    await decision(today, 'warn', [tone]);
    await appeal(1, 'upheld', yesterday - 7_200_000, yesterday);
    await appeal(2, 'denied', yesterday - 3_600_000, yesterday);
    await appeal(3, 'denied', yesterday - 3_600_000, yesterday);
    await appeal(4, 'upheld', today - 600_000, today);
    const f = await h.s.guard.flags.create({ tenantId: h.tenantId, workspaceId: null, kind: 'rule', checkpoint: 'user-input', ruleName: 'Tone', severity: 'low', label: 'internal', note: 'n' });
    await h.s.db('guard_flags').where({ id: f.id }).update({ state: 'dismissed', created_at: yesterday - 1_800_000, decided_at: yesterday });
    await h.s.db('held_writes').insert({ id: ulid(), tenant_id: h.tenantId, workspace_id: null, kind: 'dm-message', object_id: ulid(), scope_id: ulid(), author_id: userId, label: 'internal', body: null, reason: 'review', state: 'delivered', rule_name: 'Hold', flag_id: null, attempts: 0, screened_at: null, decided_by: null, decided_at: yesterday, note: null, created_at: yesterday - 240_000 });
    for (const kind of ['slow', 'hold', 'hold', 'case']) await h.s.db('spam_responses').insert({ id: ulid(), tenant_id: h.tenantId, user_id: userId, surface: 'post', kind, state: 'active', score: 50, reasons: '[]', sanction_id: null, flag_id: null, starts_at: yesterday, ends_at: yesterday + 3_600_000, created_at: yesterday });
  });
  afterAll(async () => h.close());

  it('rolls a day up into aggregates per rule, set, action, queue and kind', async () => {
    const day = dayOf(c.now() - DAY);
    expect(await m.rollup(h.tenantId, day)).toBeGreaterThan(0);
    const rows = await h.s.db('moderation_metrics_daily').where({ tenant_id: h.tenantId, day });
    const get = (metric: string, dim: string) => rows.find((r) => r.metric === metric && r.dim === dim);
    expect(Number(get('rule.hit', 'R-PII|No card numbers')!.n)).toBe(1); // once per decision, not per finding
    expect(Number(get('rule.hit', 'R-TONE|Tone')!.n)).toBe(2);
    expect(Number(get('set.hit', 'S-BASE')!.n)).toBe(2);
    expect(Number(get('set.hit', 'S-WS')!.n)).toBe(1);
    expect(Number(get('action', 'block')!.n)).toBe(1);
    expect(Number(get('action', 'redact')!.n)).toBe(1);
    expect(Number(get('action', 'annotate')!.n)).toBe(1);
    expect(Number(get('decision', 'allow')!.n)).toBe(1);
    expect(Number(get('appeal.decided', 'action')!.n)).toBe(3);
    expect(Number(get('appeal.upheld', 'action')!.n)).toBe(1);
    expect(get('ttd', 'appeals')).toMatchObject({ n: 3 });
    expect(Number(get('ttd', 'appeals')!.total)).toBe(7_200_000 + 3_600_000 + 3_600_000);
    expect(Number(get('ttd', 'flags')!.total)).toBe(1_800_000);
    expect(Number(get('ttd', 'held')!.total)).toBe(240_000);
    expect(Number(get('spam.response', 'hold')!.n)).toBe(2);
    // Rolling up again rewrites the day, it does not add to it.
    await m.rollup(h.tenantId, day);
    expect(await h.s.db('moderation_metrics_daily').where({ tenant_id: h.tenantId, day })).toHaveLength(rows.length);
    // No content: nothing but ids, names of rules and counts.
    expect(JSON.stringify(rows)).not.toContain('sealed');
  });

  it('gives trends with rates, the false-positive rate and time to decision, today computed afresh', async () => {
    const t = await m.trend({ tenantId: h.tenantId } as never, 7);
    expect(t.series).toHaveLength(7);
    expect(t.series[6]!.day).toBe(dayOf(c.now()));
    expect(t.series[6]!.block).toBe(1);
    expect(t.series[6]!.annotate).toBe(1);
    expect(t.totals.decisions).toBe(6);
    expect(t.totals.rates.block).toBeCloseTo(2 / 6);
    expect(t.totals.appealsDecided).toBe(4);
    expect(t.totals.falsePositiveRate).toBeCloseTo(2 / 4);
    expect(t.totals.timeToDecision.appeals).toEqual({ n: 4, meanMs: Math.round((7_200_000 + 3_600_000 + 3_600_000 + 600_000) / 4) });
    expect(t.totals.timeToDecision.flags).toEqual({ n: 1, meanMs: 1_800_000 });
    expect(t.totals.spamResponses).toEqual({ slow: 1, hold: 2, case: 1 });
    expect(t.topRules[0]).toMatchObject({ ruleId: 'R-TONE', name: 'Tone', hits: 3 });
    expect(t.topSets[0]).toMatchObject({ setId: 'S-BASE', hits: 4 });
  });

  it('exports CSV for moderation:review only, audited, and shows the Overview card only with the permission', async () => {
    const day = dayOf(Date.now());
    await h.s.db('guard_decisions').insert({ id: ulid(), tenant_id: h.tenantId, workspace_id: null, user_id: null, checkpoint: 'user-input', label: 'internal', action: 'block', text: null, meta: null, findings: JSON.stringify([{ ruleId: '=HYPERLINK("x")', ruleName: 'formula', setId: 'S', stage: 'enforce', action: 'block' }]), timings: '{}', source_kind: null, source_id: null, latency_ms: 1, created_at: Date.now() });
    await localUser(h, 'met-member', ['member']);
    const member = await login(h, 'met-member');
    await member.agent.get('/api/moderation/metrics/export').expect(403);
    await member.agent.get('/api/moderation/metrics').expect(403);
    await localUser(h, 'met-reviewer', ['flag-reviewer']);
    const reviewer = await login(h, 'met-reviewer');
    const res = await reviewer.agent.get('/api/moderation/metrics/export?days=3').expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('moderation-metrics-3d.csv');
    const lines = res.text.trim().split(/\r\n/);
    expect(lines[0]).toBe('day,metric,dim,n,total');
    expect(lines.some((l) => l.startsWith(`${day},action,block,`))).toBe(true);
    // A dimension that looks like a formula is quoted as text.
    expect(res.text).toContain(`"'=HYPERLINK(""x"")|formula"`);
    const audit = await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'moderation.metrics.exported' });
    expect(audit).toHaveLength(1);
    await reviewer.agent.get('/api/moderation/metrics?days=3').expect(200);
    await reviewer.agent.get('/api/moderation/metrics?days=0').expect(400);

    // The Overview card: listed and computed for an admin who reviews, not for an admin without moderation:review.
    await localUser(h, 'met-mod-admin', ['tenant-admin', 'flag-reviewer']);
    const modAdmin = await loginAdmin(h, 'met-mod-admin');
    const ask = (cookie: string, path: string) => request(h.app).get(path).set('cookie', cookie).expect(200);
    expect((await ask(modAdmin.cookie, '/api/admin/overview-cards')).body.cards.map((x: { id: string }) => x.id)).toContain('moderation-trends');
    const card = (await ask(modAdmin.cookie, '/api/admin/overview-cards/data?cards=moderation-trends')).body;
    expect(card['moderation-trends'].totals).toHaveProperty('falsePositiveRate');
    await localUser(h, 'met-admin', ['tenant-admin']);
    const admin = await loginAdmin(h, 'met-admin');
    expect((await ask(admin.cookie, '/api/admin/overview-cards')).body.cards.map((x: { id: string }) => x.id)).not.toContain('moderation-trends');
    expect((await ask(admin.cookie, '/api/admin/overview-cards/data?cards=moderation-trends')).body).not.toHaveProperty('moderation-trends');
  });
});
