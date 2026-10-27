import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPrincipal } from '../src/http/middleware.js';
import { createLogger, Metrics } from '../src/observability/index.js';
import { createServices } from '../src/services.js';
import { nextCron } from '../src/training/calendar.js';
import { validateGraph, type WfGraph } from '../src/workflows/graph.js';
import { buildPreset, describeSchedule, nextRun, nextRuns, parseSchedule, preview, presetView, SCHEDULE_PRESETS, scheduleProblem } from '../src/workflows/schedules.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';
import { drain } from './retrieval-seed.js';

/*
 * 1.8.0, Sprint 47 (B-138): schedule triggers with a time zone (migration 096, workflows/schedules.ts), presets, the
 * next-runs preview, plain-word validation, daylight-saving changes both ways, UTC schedules exactly as before, and
 * the cron tick still claimed once across instances.
 */

const iso = (xs: (number | null)[]) => xs.map((x) => (x == null ? null : new Date(x).toISOString()));
const env = { label: 'internal' as const, profile: () => undefined };
const trigger = (config: Record<string, unknown>) => ({ id: 'trigger', kind: 'trigger' as const, title: 'Trigger', x: 20, y: 20, config });
const shape = { id: 'shape', kind: 'transform' as const, title: 'Shape', x: 200, y: 20, config: { fields: { due: '{{input.dueAt}}' } } };
const g = (cfg: Record<string, unknown>): WfGraph => ({ nodes: [trigger(cfg), shape], edges: [{ from: 'trigger', to: 'shape' }], limits: {} });

describe('schedules in a time zone', () => {
  it('reads wall-clock times in the zone, with names, L, W and #', () => {
    // 09:00 on weekdays in New York: 14:00Z in winter, 13:00Z once daylight saving starts (8 March 2026).
    expect(iso(nextRuns('0 9 * * 1-5', 'America/New_York', 3, Date.UTC(2026, 2, 5, 12)))).toEqual(['2026-03-05T14:00:00.000Z', '2026-03-06T14:00:00.000Z', '2026-03-09T13:00:00.000Z']);
    // Half-hour zones.
    expect(iso(nextRuns('0 9 * * *', 'Asia/Kolkata', 1, Date.UTC(2026, 0, 1)))).toEqual(['2026-01-01T03:30:00.000Z']);
    expect(iso(nextRuns('0 9 * * *', 'Australia/Adelaide', 1, Date.UTC(2026, 0, 1)))).toEqual(['2026-01-01T22:30:00.000Z']);
    // Names, and the same schedule written in numbers.
    expect(nextRuns('0 9 * JAN,JUL MON-FRI', 'UTC', 5, Date.UTC(2026, 0, 1))).toEqual(nextRuns('0 9 * 1,7 1-5', 'UTC', 5, Date.UTC(2026, 0, 1)));
    // 1W: the first business day (1 Feb 2026 is a Sunday, 1 Mar a Sunday, 1 Aug a Saturday).
    expect(iso(nextRuns('0 9 1W * *', 'UTC', 3, Date.UTC(2026, 0, 15)))).toEqual(['2026-02-02T09:00:00.000Z', '2026-03-02T09:00:00.000Z', '2026-04-01T09:00:00.000Z']);
    expect(iso(nextRuns('0 9 1W 8 *', 'UTC', 1, Date.UTC(2026, 0, 1)))).toEqual(['2026-08-03T09:00:00.000Z']);
    // L and LW: the last day and the last business day (31 Jan 2026 is a Saturday).
    expect(iso(nextRuns('0 17 L * *', 'UTC', 2, Date.UTC(2026, 0, 1)))).toEqual(['2026-01-31T17:00:00.000Z', '2026-02-28T17:00:00.000Z']);
    expect(iso(nextRuns('0 17 LW * *', 'UTC', 2, Date.UTC(2026, 0, 1)))).toEqual(['2026-01-30T17:00:00.000Z', '2026-02-27T17:00:00.000Z']);
    // 1#1: the first Monday; 5#3: the third Friday.
    expect(iso(nextRuns('0 9 * * 1#1', 'UTC', 2, Date.UTC(2026, 0, 1)))).toEqual(['2026-01-05T09:00:00.000Z', '2026-02-02T09:00:00.000Z']);
    expect(iso(nextRuns('0 9 * * FRI#3', 'UTC', 1, Date.UTC(2026, 0, 1)))).toEqual(['2026-01-16T09:00:00.000Z']);
  });

  it('clocks going forward: a named hour runs once at the jump, an interval just skips the missing times', () => {
    // Europe/Berlin, 29 March 2026: 02:00 CET becomes 03:00 CEST (01:00Z).
    expect(iso(nextRuns('30 2 * * *', 'Europe/Berlin', 3, Date.UTC(2026, 2, 27, 12)))).toEqual(['2026-03-28T01:30:00.000Z', '2026-03-29T01:00:00.000Z', '2026-03-30T00:30:00.000Z']);
    expect(iso(nextRuns('*/30 * * * *', 'Europe/Berlin', 4, Date.UTC(2026, 2, 29, 0, 10)))).toEqual(['2026-03-29T00:30:00.000Z', '2026-03-29T01:00:00.000Z', '2026-03-29T01:30:00.000Z', '2026-03-29T02:00:00.000Z']);
    // Every 15 minutes within the missing hour: one run at the jump, not four.
    expect(iso(nextRuns('*/15 2 * * *', 'Europe/Berlin', 2, Date.UTC(2026, 2, 28, 12)))).toEqual(['2026-03-29T01:00:00.000Z', '2026-03-30T00:00:00.000Z']);
    // America/New_York, 8 March 2026: 02:00 EST becomes 03:00 EDT (07:00Z).
    expect(iso(nextRuns('30 2 * * *', 'America/New_York', 2, Date.UTC(2026, 2, 7, 12)))).toEqual(['2026-03-08T07:00:00.000Z', '2026-03-09T06:30:00.000Z']);
  });

  it('clocks going back: a named hour runs once, at the first 02:30; an interval keeps its pace', () => {
    // Europe/Berlin, 25 October 2026: 03:00 CEST becomes 02:00 CET (01:00Z), so 02:30 happens twice.
    expect(iso(nextRuns('30 2 * * *', 'Europe/Berlin', 3, Date.UTC(2026, 9, 23, 12)))).toEqual(['2026-10-24T00:30:00.000Z', '2026-10-25T00:30:00.000Z', '2026-10-26T01:30:00.000Z']);
    expect(iso(nextRuns('*/30 * * * *', 'Europe/Berlin', 6, Date.UTC(2026, 9, 24, 23, 10)))).toEqual(['2026-10-24T23:30:00.000Z', '2026-10-25T00:00:00.000Z', '2026-10-25T00:30:00.000Z', '2026-10-25T01:00:00.000Z', '2026-10-25T01:30:00.000Z', '2026-10-25T02:00:00.000Z']);
    // America/New_York, 1 November 2026: 01:30 happens at 05:30Z (EDT) and 06:30Z (EST); the schedule runs once.
    expect(iso(nextRuns('30 1 * * *', 'America/New_York', 2, Date.UTC(2026, 9, 31, 12)))).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z']);
    // Daily at 09:00 keeps 09:00 local across the change (07:00Z, then 08:00Z).
    expect(iso(nextRuns('0 9 * * *', 'Europe/Berlin', 2, Date.UTC(2026, 9, 24, 12)))).toEqual(['2026-10-25T08:00:00.000Z', '2026-10-26T08:00:00.000Z']);
  });

  it('UTC schedules are exactly what the training calendar computes, as before', () => {
    const corpus = ['0 3 * * *', '*/5 * * * *', '15 14 1 * *', '0 22 * * 1-5', '0 0 1 1 *', '30 6 * * 0', '0 */6 * * *', '5,35 8-17 * * 1-5', '0 12 13 * 5', '0 9 29 2 *'];
    for (const expr of corpus) {
      for (let i = 0; i < 25; i++) {
        const from = Date.UTC(2026, 0, 1) + i * 7_919_323_457;
        expect(nextRun(expr, from)).toBe(nextCron(expr, from));
        expect(nextRun(expr, from, 'UTC')).toBe(nextCron(expr, from));
        expect(nextRun(parseSchedule(expr), from, 'UTC')).toBe(nextCron(expr, from));
      }
    }
  });

  it('about twenty presets, each a valid cron with runs and a reading in plain words', () => {
    expect(SCHEDULE_PRESETS.length).toBeGreaterThanOrEqual(20);
    for (const p of SCHEDULE_PRESETS) {
      const v = presetView(p);
      expect(scheduleProblem(v.example, 'Europe/Berlin')).toBeNull();
      expect(nextRuns(v.example, 'Europe/Berlin', 3, Date.UTC(2026, 0, 1))).toHaveLength(3);
      expect(describeSchedule(v.example, 'Europe/Berlin')).toMatch(/\(Europe\/Berlin\)$/);
    }
    expect(buildPreset('every-n-minutes', { n: 10 })).toBe('*/10 * * * *');
    expect(buildPreset('hourly', { minute: 5 })).toBe('5 * * * *');
    expect(buildPreset('weekdays', { hour: 9, minute: 0 })).toBe('0 9 * * 1-5');
    expect(buildPreset('first-business-day')).toBe('0 9 1W * *');
    expect(buildPreset('quarterly', { hour: 7 })).toBe('0 7 1 1,4,7,10 *');
    expect(() => buildPreset('every-n-minutes', { n: 90 })).toThrow('Every (minutes) must be a whole number from 1 to 30; 90 is not.');
    expect(() => buildPreset('no-such')).toThrow('There is no schedule preset no-such.');
    expect(describeSchedule('0 9 * * 1-5', 'Europe/Berlin')).toBe('On weekdays, at 09:00 (Europe/Berlin)');
    expect(describeSchedule('0 9 1W * *')).toBe('On the first business day of the month, at 09:00 (UTC)');
    expect(describeSchedule('*/15 * * * *', 'Asia/Tokyo')).toBe('Every 15 minutes (Asia/Tokyo)');
    expect(describeSchedule('0 9 1 1,4,7,10 *')).toBe('On the 1st of each quarter, at 09:00 (UTC)');
  });

  it('says what is wrong in plain words', () => {
    expect(scheduleProblem('every day')).toMatch(/^A schedule has five parts, minute, hour, day of the month, month and day of the week/);
    expect(scheduleProblem('0 25 * * *')).toBe('The hour part "25" is out of range: hours run from 0 to 23.');
    expect(scheduleProblem('61 * * * *')).toBe('The minute part "61" is out of range: minutes run from 0 to 59.');
    expect(scheduleProblem('0 9 * * 5-1')).toMatch(/runs backwards \(5 to 1\); write the smaller number first/);
    expect(scheduleProblem('0 9 30 2 *')).toMatch(/never runs within a year/);
    expect(scheduleProblem('0 9 * * 1#6')).toMatch(/there are at most 5/);
    expect(scheduleProblem('0 9 * FOO *')).toMatch(/"FOO" is not a name this schedule knows/);
    expect(scheduleProblem('0 9 * * *', 'Mars/Olympus')).toBe('"Mars/Olympus" is not a time zone this server knows. Use an IANA name such as Europe/Berlin or America/New_York, or UTC.');
    expect(scheduleProblem('0 9 * * *', '+02:00')).toMatch(/not a time zone/);
    // At publish, through the trigger's checks.
    const msgs = (cfg: Record<string, unknown>) => validateGraph(g(cfg), env).errors.map((e) => e.message);
    expect(msgs({ source: 'schedule', cron: '0 9 * * 1-5', timezone: 'Europe/Berlin' })).toEqual([]);
    expect(msgs({ source: 'schedule', cron: '0 9 * * *', timezone: 'Mars/Olympus' })).toEqual(['Trigger: "Mars/Olympus" is not a time zone this server knows. Use an IANA name such as Europe/Berlin or America/New_York, or UTC.']);
    expect(msgs({ source: 'manual', timezone: 'Europe/Berlin' })).toEqual(['Trigger: only a schedule trigger has a time zone.']);
    expect(msgs({ source: 'schedule', cron: '0 25 * * *' })[0]).toMatch(/not a valid cron expression: The hour part "25" is out of range/);
  });

  it('previews the next runs with local times and daylight-saving notes', () => {
    const out = preview({ cron: '30 2 * * *', timezone: 'Europe/Berlin', count: 3, from: Date.UTC(2026, 2, 27, 12) });
    expect(out).toMatchObject({ cron: '30 2 * * *', timezone: 'Europe/Berlin', description: 'At 02:30, every day (Europe/Berlin)' });
    expect(out.runs.map((r) => r.local)).toEqual(['Sat, 28 Mar 2026, 02:30 CET', 'Sun, 29 Mar 2026, 03:00 CEST', 'Mon, 30 Mar 2026, 02:30 CEST']);
    expect(out.runs.map((r) => r.offsetMinutes)).toEqual([60, 120, 120]);
    expect(out.notes.join(' ')).toMatch(/at the moment the clocks go forward/);
    expect(preview({ preset: 'weekly', values: { dow: 3, hour: 10 }, timezone: 'UTC', count: 2, from: Date.UTC(2026, 0, 1) }).runs.map((r) => r.iso)).toEqual(['2026-01-07T10:00:00.000Z', '2026-01-14T10:00:00.000Z']);
  });
});

describe('schedule triggers with a time zone, end to end', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness({ WORKFLOW_SCHEDULE_TICK_SECONDS: '0', OLLAMA_POLL_MS: '600000' });
  });
  afterEach(async () => {
    await h.close();
  });

  async function admin() {
    const u = await localUser(h, 'wadmin', ['workflow-admin', 'member'], 'confidential');
    const c = await loginAdmin(h, 'wadmin');
    const p = (await loadPrincipal(h.s, h.tenantId, u.id, {}))!;
    return { p, c, post: (x: string, b: object = {}) => c.agent.post(x).set('x-csrf-token', c.csrf).send(b), get: (x: string) => c.agent.get(x) };
  }

  it('the preview and presets endpoints, with problems in plain words', async () => {
    const a = await admin();
    const presets = (await a.get('/api/workflow-schedules/presets').expect(200)).body.presets;
    expect(presets.length).toBeGreaterThanOrEqual(20);
    expect(presets.find((p: { id: string }) => p.id === 'first-business-day')).toMatchObject({ title: 'First business day of the month', example: '0 9 1W * *', params: [{ name: 'hour' }, { name: 'minute' }] });
    const ok = (await a.post('/api/workflow-schedules/preview', { cron: '0 9 * * 1-5', timezone: 'Europe/Berlin', count: 5 }).expect(200)).body;
    expect(ok.runs).toHaveLength(5);
    expect(ok.description).toBe('On weekdays, at 09:00 (Europe/Berlin)');
    for (const r of ok.runs) expect(r.local).toMatch(/09:00 CES?T$/);
    const viaPreset = (await a.post('/api/workflow-schedules/preview', { preset: 'every-n-minutes', values: { n: 20 }, timezone: 'UTC', count: 3 }).expect(200)).body;
    expect(viaPreset.cron).toBe('*/20 * * * *');
    const bad = (await a.post('/api/workflow-schedules/preview', { cron: '0 9 * * *', timezone: 'Mars/Olympus' }).expect(422)).body;
    expect(bad).toMatchObject({ title: 'Schedule not valid', detail: expect.stringMatching(/is not a time zone this server knows/) });
    expect((await a.post('/api/workflow-schedules/preview', { cron: '0 9 31 2 *' }).expect(422)).body.detail).toMatch(/never runs within a year/);
    await a.post('/api/workflow-schedules/preview', { cron: '0 9 * * *', preset: 'daily' }).expect(400);
    await a.post('/api/workflow-schedules/preview', { cron: '0 9 * * *', count: 500 }).expect(400);
  });

  it('a zoned schedule fires at its local time, is claimed once across instances, and UTC triggers keep a null zone', async () => {
    const a = await admin();
    const w = await h.s.workflows.create(a.p, { name: 'berlin-morning', label: 'internal', graph: g({ source: 'schedule', cron: '0 9 * * *', timezone: 'Europe/Berlin' }) });
    await h.s.workflows.publish(a.p, w.id, null);
    const t = await h.s.db('workflow_triggers').where({ workflow_id: w.id }).first();
    expect(t).toMatchObject({ kind: 'schedule', cron: '0 9 * * *', timezone: 'Europe/Berlin' });
    const due = Number(t.next_run_at);
    expect(due).toBe(nextRun('0 9 * * *', Number(t.updated_at), 'Europe/Berlin'));
    expect(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(due))).toBe('09:00');
    const view = (await a.get(`/api/workflows/${w.id}/triggers`).expect(200)).body.trigger;
    expect(view).toMatchObject({ timezone: 'Europe/Berlin', schedule: 'At 09:00, every day (Europe/Berlin)' });
    // Two instances tick at the due time: one run.
    const second = createServices(h.s.cfg, h.s.db, createLogger('silent', false), new Metrics());
    try {
      const [x, y] = await Promise.all([h.s.workflowTriggers.tick(due + 1), second.workflowTriggers.tick(due + 1)]);
      expect(x.fired + y.fired).toBe(1);
      expect(await h.s.workflowTriggers.tick(due + 1)).toEqual({ fired: 0, skipped: 0 });
    } finally {
      second.workflowTriggers.close();
      second.pluginRuntime.close();
    }
    await drain(h);
    expect(await h.s.db('workflow_runs').where({ workflow_id: w.id })).toHaveLength(1);
    const after = await h.s.db('workflow_triggers').where({ workflow_id: w.id }).first();
    expect(Number(after.next_run_at)).toBe(nextRun('0 9 * * *', due + 1, 'Europe/Berlin'));
    // A UTC schedule (no zone) is stored and computed exactly as before.
    const u = await h.s.workflows.create(a.p, { name: 'utc-nightly', label: 'internal', graph: g({ source: 'schedule', cron: '0 3 * * *' }) });
    await h.s.workflows.publish(a.p, u.id, null);
    const ut = await h.s.db('workflow_triggers').where({ workflow_id: u.id }).first();
    expect(ut.timezone).toBeNull();
    expect(Number(ut.next_run_at)).toBe(nextCron('0 3 * * *', Number(ut.updated_at)));
    expect(JSON.parse((await h.s.db('audit_events').where({ action: 'workflow.trigger.set' }).orderBy('seq', 'asc').first()).detail)).toMatchObject({ cron: '0 9 * * *', timezone: 'Europe/Berlin' });
    // Publishing an unknown zone is refused with the reason.
    const bad = await h.s.workflows.create(a.p, { name: 'nowhere', label: 'internal', graph: g({ source: 'schedule', cron: '0 9 * * *', timezone: 'Mars/Olympus' }) });
    await expect(h.s.workflows.publish(a.p, bad.id, null)).rejects.toMatchObject({ status: 422, detail: expect.stringMatching(/Mars\/Olympus" is not a time zone/) });
  });
});
