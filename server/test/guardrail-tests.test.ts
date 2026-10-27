import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { casesFromCsv } from '../src/guardrails/rule-tests.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';

const rule = (id: string, pattern: string, action = 'block', extra: Record<string, unknown> = {}) => ({ id, name: id, checkpoint: 'user-input', type: 'pattern', mechanism: { kind: 'pattern', pattern }, action, stage: 'enforce', onError: 'closed', severity: 'medium', enabled: true, ...extra });

describe('B-155: rule-set tests', () => {
  let h: Harness;
  let admin: Client;
  let second: Client;
  let low: Client;
  const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);
  const put = (c: Client, url: string, body: object) => c.agent.put(url).set('x-csrf-token', c.csrf).send(body);
  const csv = (url: string, text: string) => admin.agent.post(url).set('x-csrf-token', admin.csrf).set('content-type', 'text/csv').send(text);
  const actions = async (prefix: string) => (await h.s.db('audit_events').where('action', 'like', `${prefix}%`).orderBy('seq').select('action', 'detail')) as { action: string; detail: string }[];

  beforeEach(async () => {
    h = await harness();
    await localUser(h, 'ga', ['guardrail-admin', 'member'], 'confidential');
    await localUser(h, 'gb', ['guardrail-admin', 'member'], 'confidential');
    await localUser(h, 'gc', ['guardrail-admin', 'member'], 'internal');
    admin = await loginAdmin(h, 'ga');
    second = await loginAdmin(h, 'gb');
    low = await loginAdmin(h, 'gc');
  });
  afterEach(async () => h.close());

  const newSet = async (rules: object[]) => {
    const set = (await post(admin, '/api/admin/guardrails/sets', { name: 'Tested', scope: 'tenant' }).expect(201)).body as { id: string };
    await put(admin, `/api/admin/guardrails/sets/${set.id}/draft`, { rules }).expect(200);
    return set;
  };
  const base = (id: string) => `/api/admin/guardrails/sets/${id}/tests`;

  it('runs cases on demand and refuses publishing with 409 and the failing cases until all pass', async () => {
    const set = await newSet([rule('no-casino', '(?i)casino', 'block'), rule('mild', '(?i)darn', 'warn')]);
    const added = (await post(admin, base(set.id), { cases: [
      { name: 'plain text passes', text: 'The meeting is at noon.', expect: 'pass' },
      { name: 'casino is blocked', text: 'Visit our CASINO', expect: 'block', ruleId: 'no-casino' },
      { name: 'lottery is blocked', text: 'Win the lottery', expect: 'block', ruleId: 'no-lottery' },
      { name: 'darn is annotated', text: 'darn it', expect: 'annotate', ruleId: 'mild', context: { label: 'internal', surface: 'feed' } }
    ] }).expect(201)).body.cases;
    expect(added).toHaveLength(4);
    const run = (await post(admin, `${base(set.id)}/run`).expect(200)).body;
    expect(run).toMatchObject({ total: 4, passed: 3, failed: 1, trigger: 'manual', version: 1 });
    const failing = run.results.filter((x: { ok: boolean }) => !x.ok);
    expect(failing).toEqual([expect.objectContaining({ name: 'lottery is blocked', reason: 'the rule no-lottery is not in this version' })]);
    expect(run.results.find((x: { name: string }) => x.name === 'casino is blocked')).toMatchObject({ ok: true, actual: 'block', fired: [{ ruleId: 'no-casino', action: 'block' }] });

    // publishing is refused while a case fails
    const refused = await post(admin, `/api/admin/guardrails/sets/${set.id}/draft/publish`).expect(409);
    expect(refused.body).toMatchObject({ title: 'Rule-set tests failing', failing: [{ name: 'lottery is blocked', expect: 'block', ruleId: 'no-lottery', actual: 'allow' }] });
    expect(refused.body.detail).toMatch(/1 of 4 test cases of Tested fails against v1/);
    expect((await h.s.db('guard_rule_sets').where({ id: set.id }).first()).published_version).toBeNull();
    // the rule arrives; the change queues a run, which passes, then publishing passes the gate
    await put(admin, `/api/admin/guardrails/sets/${set.id}/draft/rules/no-lottery`, { rule: rule('no-lottery', '(?i)lottery') }).expect(200);
    await h.s.jobs.runDue();
    const after = (await admin.agent.get(base(set.id)).expect(200)).body.lastRun;
    expect(after).toMatchObject({ trigger: 'change', passed: 4, failed: 0 });
    expect(after.diff).toMatchObject({ nowPassing: [failing[0].id], nowFailing: [], rules: { added: ['no-lottery'], removed: [], changed: [] } });
    await post(admin, `/api/admin/guardrails/sets/${set.id}/draft/publish`).expect(200);
    const audit = (await actions('guardrail.tests.')).map((x) => x.action);
    expect(audit).toEqual(['guardrail.tests.added', 'guardrail.tests.run', 'guardrail.tests.gate.refused', 'guardrail.tests.gate.passed']);
  });

  it('gates approval (dual control) and promotion to enforce too', async () => {
    const set = await newSet([rule('no-casino', '(?i)casino', 'block', { stage: 'shadow' })]);
    await post(admin, base(set.id), { text: 'casinos everywhere', expect: 'pass' }).expect(201);
    // the rule fires (tests judge every rule as if it enforced, as replay does): promotion and approval are refused
    const promote = await post(admin, `/api/admin/guardrails/sets/${set.id}/promote`, { ruleId: 'no-casino' }).expect(409);
    expect(promote.body.failing).toHaveLength(1);
    await post(admin, `/api/admin/guardrails/sets/${set.id}/draft/submit`).expect(200);
    const approve = await post(second, `/api/admin/guardrails/sets/${set.id}/draft/approve`).expect(409);
    expect(approve.body.failing[0]).toMatchObject({ expect: 'pass', actual: 'block' });
    const refusals = (await actions('guardrail.tests.gate.refused')).map((x) => JSON.parse(x.detail).trigger);
    expect(refusals).toEqual(['promote', 'approve']);
  });

  it('keeps texts sealed at rest and shows them only to someone cleared for the label', async () => {
    const set = await newSet([rule('no-casino', '(?i)casino')]);
    const SECRET = 'Confidential casino promotion for Lisbon';
    const [c] = (await post(admin, base(set.id), { text: SECRET, expect: 'block', ruleId: 'no-casino', context: { label: 'confidential' } }).expect(201)).body.cases;
    const raw = await h.s.db('guard_rule_tests').where({ id: c.id }).first();
    expect(raw.text).not.toContain('casino');
    expect(raw.text).not.toContain('Lisbon');
    expect(raw.label).toBe('confidential');
    expect(await h.s.keys.open(h.tenantId, raw.text, `guardtest:${c.id}`)).toBe(SECRET);
    await expect(h.s.keys.open(h.tenantId, raw.text, 'guardtest:other')).rejects.toThrow();
    // a guardrail admin cleared for internal sees that the case exists, not its text, and cannot add one above it
    const seen = (await low.agent.get(base(set.id)).expect(200)).body.cases;
    expect(seen[0]).toMatchObject({ id: c.id, text: null, hidden: true, label: 'confidential' });
    await post(low, base(set.id), { text: 'x', expect: 'pass', context: { label: 'confidential' } }).expect(400);
    expect((await admin.agent.get(base(set.id)).expect(200)).body.cases[0].text).toBe(SECRET);
    // a run keeps no text
    const run = (await post(admin, `${base(set.id)}/run`).expect(200)).body;
    const kept = await h.s.db('guard_rule_test_runs').where({ id: run.id }).first();
    expect(kept.results).not.toContain('Lisbon');
  });

  it('imports cases from shadow replay hits and from recorded decisions, within label and clearance', async () => {
    const set = await newSet([rule('no-casino', '(?i)casino', 'block', { stage: 'shadow' })]);
    await post(admin, `/api/admin/guardrails/sets/${set.id}/draft/publish`).expect(200);
    const check = (text: string, label: 'internal' | 'restricted') => h.s.guardrails.check({ tenantId: h.tenantId, workspaceId: null, checkpoint: 'user-input', text, label, meta: { via: 'feed' } });
    await check('the casino opens today', 'internal');
    await check('a restricted casino memo', 'restricted');
    await check('nothing to see', 'internal');
    // the replay keeps which decisions each rule would hit, by id only
    const job = (await post(admin, `/api/admin/guardrails/sets/${set.id}/replay`).expect(202)).body;
    await h.s.jobs.runDue();
    const result = (await h.s.jobs.get(h.tenantId, job.jobId))!.result as { rules: { id: string; wouldTrigger: number; hits: string[] }[] };
    expect(result.rules[0]).toMatchObject({ id: 'no-casino', wouldTrigger: 2 });
    expect(result.rules[0]!.hits).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('casino opens');
    const imported = (await post(admin, `${base(set.id)}/import/replay`, { jobId: job.jobId }).expect(201)).body;
    expect(imported.added).toEqual([expect.objectContaining({ expect: 'block', ruleId: 'no-casino', source: 'replay', label: 'internal', text: 'the casino opens today', context: expect.objectContaining({ checkpoint: 'user-input', surface: 'feed' }) })]);
    expect(imported.skipped).toEqual([expect.objectContaining({ reason: 'labelled restricted, above your clearance' })]);
    // importing again skips what is already a case
    const again = (await post(admin, `${base(set.id)}/import/replay`, { jobId: job.jobId }).expect(201)).body;
    expect(again.added).toEqual([]);
    expect(again.skipped.map((x: { reason: string }) => x.reason).sort()).toEqual(['already a test case of this set', 'labelled restricted, above your clearance']);

    // candidates from real outcomes: decisions where the set's rules fired, within clearance; imported as false positives
    const candidates = (await admin.agent.get(`${base(set.id)}/decisions`).expect(200)).body;
    expect(candidates).toEqual([expect.objectContaining({ excerpt: 'the casino opens today', label: 'internal', rules: [expect.objectContaining({ ruleId: 'no-casino', stage: 'shadow' })] })]);
    const fp = (await post(admin, `${base(set.id)}/import/decisions`, { decisions: [{ id: candidates[0].id, expect: 'pass' }, { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', expect: 'pass' }] }).expect(201)).body;
    expect(fp.added).toEqual([]);
    expect(fp.skipped.map((x: { reason: string }) => x.reason)).toEqual(['already a test case of this set', 'no longer recorded (decisions are kept 7 days)']);
    expect((await actions('guardrail.tests.imported')).map((x) => JSON.parse(x.detail).source)).toEqual(['replay', 'replay', 'decision']);
  });

  it('imports cases from CSV with a dry run that reports invalid rows and duplicates', async () => {
    const set = await newSet([rule('no-casino', '(?i)casino')]);
    await post(admin, base(set.id), { text: 'casino night', expect: 'block', ruleId: 'no-casino' }).expect(201);
    const body = [
      'name,text,expect,rule,checkpoint,label,surface,account_age_days,new_account',
      'one,casino night,block,no-casino,,,,,', // same as the existing case
      'two,"a quiet, plain note",pass,,,internal,feed,30,false',
      'three,a quiet, plain note,maybe,,,,,,',
      'four,"a quiet, plain note",pass,,,internal,feed,30,false', // repeats row 3
      'five,secret casino,block,no-casino,,restricted,,,', // above the importer's clearance
      'six,hello,pass,no-casino,,,,,' // a passing case names no rule
    ].join('\r\n');
    const dry = (await csv(`${base(set.id)}/import/csv?dryRun=true`, body).expect(200)).body;
    expect(dry).toMatchObject({ dryRun: true, valid: 1 });
    expect(dry.duplicates).toEqual([{ row: 2, of: 'an existing case' }, { row: 5, of: 'row 3' }]);
    expect(dry.invalid.map((x: { row: number }) => x.row)).toEqual([4, 7, 0]);
    expect(dry.invalid[2].reason).toMatch(/above your clearance/);
    expect(dry.preview[0]).toMatchObject({ name: 'two', expect: 'pass', context: { surface: 'feed', accountAgeDays: 30, newAccount: false } });
    expect(await h.s.db('guard_rule_tests').where({ set_id: set.id })).toHaveLength(1);
    const done = (await csv(`${base(set.id)}/import/csv`, body).expect(201)).body;
    expect(done.added).toHaveLength(1);
    expect(done.added[0]).toMatchObject({ source: 'csv', text: 'a quiet, plain note' });
    expect(await h.s.db('guard_rule_tests').where({ set_id: set.id })).toHaveLength(2);
    expect(casesFromCsv('text\nx', []).invalid[0]!.reason).toMatch(/must name text and expect/);
  });

  it('edits and removes cases, audited', async () => {
    const set = await newSet([rule('no-casino', '(?i)casino')]);
    const [c] = (await post(admin, base(set.id), { text: 'casino', expect: 'pass' }).expect(201)).body.cases;
    const fixed = (await admin.agent.patch(`${base(set.id)}/${c.id}`).set('x-csrf-token', admin.csrf).send({ expect: 'block', ruleId: 'no-casino' }).expect(200)).body;
    expect(fixed).toMatchObject({ expect: 'block', ruleId: 'no-casino', text: 'casino' });
    await admin.agent.patch(`${base(set.id)}/${c.id}`).set('x-csrf-token', admin.csrf).send({ expect: 'pass' }).expect(422);
    await admin.agent.delete(`${base(set.id)}/${c.id}`).set('x-csrf-token', admin.csrf).expect(204);
    expect((await actions('guardrail.tests.')).map((x) => x.action)).toEqual(['guardrail.tests.added', 'guardrail.tests.updated', 'guardrail.tests.removed']);
    // a set without cases publishes as before, without a run
    await post(admin, `/api/admin/guardrails/sets/${set.id}/draft/publish`).expect(200);
    expect(await h.s.db('guard_rule_test_runs').where({ set_id: set.id })).toHaveLength(0);
  });
});
