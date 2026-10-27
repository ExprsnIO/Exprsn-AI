/*
 * Sprint 46 (B-131): decision tables. The pure core (`decisions/table.ts`: hit policies, every test, text cells,
 * types, the publish check with overlaps and unreachable rules), the routes (versions, publish, test, export and
 * import, permissions, clearance, audit), the `decision` workflow step in a run, the app-flow `decision` action, the
 * built-in tool `decision.evaluate`, and workflow bundles that carry decision steps.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compileFlow, flowInputSchema, flowProblems } from '../src/apps/flows.js';
import type { AppRow, EntityRow } from '../src/apps/service.js';
import { entityDefinitionSchema } from '../src/apps/schema.js';
import type { Label } from '../src/authz/labels.js';
import type { Principal } from '../src/authz/policy.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { HttpProblem } from '../src/http/problem.js';
import { cellText, checkDefinition, DecisionError, definitionInputSchema, evaluate, normalize, parseCell, type Definition } from '../src/decisions/table.js';
import type { WfGraph, WfNode } from '../src/workflows/graph.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';

const def = (raw: unknown): Definition => normalize(definitionInputSchema.parse(raw));

/** Discount by tier and amount: the running example. */
const DISCOUNT = {
  inputs: [
    { name: 'tier', type: 'string' },
    { name: 'amount', type: 'number' }
  ],
  outputs: [{ name: 'discount', type: 'number' }],
  hitPolicy: 'first',
  rules: [
    { id: 'gold-big', when: { tier: '"gold"', amount: '>= 1000' }, then: { discount: 15 } },
    { id: 'gold', when: { tier: 'gold' }, then: { discount: 10 } },
    { id: 'silver', when: { tier: 'in ("silver", "bronze")', amount: '[100..999]' }, then: { discount: 5 } },
    { id: 'none', when: {}, then: { discount: 0 } }
  ]
};

describe('decision tables: the evaluator', () => {
  it('first: the first rule that matches, with the explanation of why', () => {
    const d = def(DISCOUNT);
    const r = evaluate(d, { tier: 'gold', amount: 1500 });
    expect(r.matched).toEqual([{ rule: 'gold-big', index: 0 }]);
    expect(r.outputs).toEqual({ discount: 15 });
    expect(r.summary).toMatch(/Rule 1 \(gold-big\) is the first that matches: tier "gold" = "gold"; amount 1500 ≥ 1000\. Outputs: discount = 15\./);
    expect(evaluate(d, { tier: 'gold', amount: 50 }).outputs).toEqual({ discount: 10 });
    expect(evaluate(d, { tier: 'bronze', amount: '250' }).outputs).toEqual({ discount: 5 });
    const none = evaluate(d, { tier: 'bronze', amount: 5000 });
    expect(none.matched).toEqual([{ rule: 'none', index: 3 }]);
    // The explanation names the test each rule failed at.
    expect(none.explanation[2]).toMatchObject({ rule: 'silver', matched: false, tests: [{ column: 'tier', passed: true }, { column: 'amount', test: '[100..999]', value: 5000, passed: false }] });
    // An input of the wrong type is refused, not guessed.
    expect(() => evaluate(d, { tier: 'gold', amount: 'lots' })).toThrow(DecisionError);
    expect(() => evaluate(d, { tier: 'gold', amount: 'lots' })).toThrow(/Input amount should be a number/);
  });

  it('unique: one match, and two matches are an error naming both rules', () => {
    const d = def({ ...DISCOUNT, hitPolicy: 'unique', rules: [{ id: 'a', when: { amount: '< 100' }, then: { discount: 0 } }, { id: 'b', when: { amount: '>= 50' }, then: { discount: 5 } }] });
    expect(evaluate(d, { amount: 10 }).outputs).toEqual({ discount: 0 });
    expect(evaluate(d, { amount: 500 }).matched).toEqual([{ rule: 'b', index: 1 }]);
    let err: unknown;
    try {
      evaluate(d, { amount: 75 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DecisionError);
    expect(err).toMatchObject({ code: 'unique', rules: ['a', 'b'], message: expect.stringMatching(/allows one matching rule, and 2 match: a, b/) });
    // The publish check finds the overlap first.
    expect(checkDefinition(d).errors).toEqual([expect.objectContaining({ code: 'overlap', rule: 'b', other: 'a' })]);
  });

  it('priority: of the matching rules, the one whose output comes first in the value order', () => {
    const d = def({
      inputs: [{ name: 'risk', type: 'number' }, { name: 'vip', type: 'boolean' }],
      outputs: [{ name: 'route', type: 'string', values: ['reject', 'review', 'approve'] }],
      hitPolicy: 'priority',
      rules: [
        { id: 'ok', when: {}, then: { route: 'approve' } },
        { id: 'vip', when: { vip: 'true' }, then: { route: 'review' } },
        { id: 'risky', when: { risk: '> 80' }, then: { route: 'reject' } }
      ]
    });
    expect(checkDefinition(d).ok).toBe(true);
    expect(evaluate(d, { risk: 10, vip: false }).outputs).toEqual({ route: 'approve' });
    expect(evaluate(d, { risk: 10, vip: true }).outputs).toEqual({ route: 'review' });
    const r = evaluate(d, { risk: 95, vip: true });
    expect(r.outputs).toEqual({ route: 'reject' });
    expect(r.matched).toEqual([{ rule: 'risky', index: 2 }]);
    expect(r.summary).toMatch(/3 rules matched; rule 3 \(risky\) has the highest-priority outputs/);
    // Without a value order there is nothing to rank by.
    expect(checkDefinition({ ...d, outputs: [{ name: 'route', type: 'string' }] }).errors.map((e) => e.message).join('\n')).toMatch(/priority hit policy ranks by the order/);
  });

  it('any: matching rules must agree; disagreement is an error at publish and at evaluation', () => {
    const agree = def({ ...DISCOUNT, hitPolicy: 'any', rules: [{ id: 'a', when: { tier: 'gold' }, then: { discount: 10 } }, { id: 'b', when: { amount: '>= 1000' }, then: { discount: 10 } }] });
    expect(checkDefinition(agree).ok).toBe(true);
    const r = evaluate(agree, { tier: 'gold', amount: 2000 });
    expect(r.outputs).toEqual({ discount: 10 });
    expect(r.matched.map((m) => m.rule)).toEqual(['a', 'b']);
    const clash = { ...agree, rules: [agree.rules[0]!, { ...agree.rules[1]!, then: { discount: 20 } }] };
    expect(checkDefinition(clash).errors).toEqual([expect.objectContaining({ code: 'overlap', message: expect.stringMatching(/give different values of discount \(10 and 20\); the any hit policy/) })]);
    expect(() => evaluate(clash, { tier: 'gold', amount: 2000 })).toThrow(/any hit policy needs every matching rule to give the same outputs/);
    expect(evaluate(clash, { tier: 'gold', amount: 1 }).outputs).toEqual({ discount: 10 });
  });

  it('collect: every match in order, or aggregated with sum, min, max and count', () => {
    const base = { inputs: [{ name: 'items', type: 'number' }], outputs: [{ name: 'fee', type: 'number' }], hitPolicy: 'collect', rules: [{ id: 'base', when: {}, then: { fee: 2 } }, { id: 'bulk', when: { items: '> 10' }, then: { fee: 5 } }, { id: 'huge', when: { items: '> 100' }, then: { fee: 20 } }] };
    const all = evaluate(def(base), { items: 500 });
    expect(all.outputs).toEqual({ fee: [2, 5, 20] });
    expect(all.rows).toEqual([{ fee: 2 }, { fee: 5 }, { fee: 20 }]);
    expect(evaluate(def({ ...base, aggregation: 'sum' }), { items: 500 }).outputs).toEqual({ fee: 27 });
    expect(evaluate(def({ ...base, aggregation: 'min' }), { items: 500 }).outputs).toEqual({ fee: 2 });
    expect(evaluate(def({ ...base, aggregation: 'max' }), { items: 50 }).outputs).toEqual({ fee: 5 });
    expect(evaluate(def({ ...base, aggregation: 'count' }), { items: 50 }).outputs).toEqual({ fee: 2 });
    // Nothing matched: an empty list, sum 0, count 0, min null.
    const none = { ...base, rules: base.rules.slice(1) };
    expect(evaluate(def(none), { items: 1 }).outputs).toEqual({ fee: [] });
    expect(evaluate(def({ ...none, aggregation: 'sum' }), { items: 1 }).outputs).toEqual({ fee: 0 });
    expect(evaluate(def({ ...none, aggregation: 'count' }), { items: 1 }).outputs).toEqual({ fee: 0 });
    expect(evaluate(def({ ...none, aggregation: 'min' }), { items: 1 }).outputs).toEqual({ fee: null });
    // Aggregation rules: collect only, one output column, numbers for sum.
    const msgs = (raw: unknown) => checkDefinition(def(raw)).errors.map((e) => e.message).join('\n');
    expect(msgs({ ...base, hitPolicy: 'first', aggregation: 'sum' })).toMatch(/Only the collect hit policy aggregates/);
    expect(msgs({ ...base, aggregation: 'sum', outputs: [{ name: 'fee', type: 'string' }], rules: [{ id: 'x', then: { fee: 'a' } }] })).toMatch(/sum adds numbers; fee is string/);
    expect(msgs({ ...base, aggregation: 'max', outputs: [{ name: 'fee', type: 'number' }, { name: 'why', type: 'string' }], rules: [{ id: 'x', then: { fee: 1, why: 'a' } }] })).toMatch(/works on one output column; this table has 2/);
  });

  it('every test, by type, including empty inputs and dates', () => {
    const one = (type: string, cell: string, value: unknown) => evaluate(def({ inputs: [{ name: 'x', type }], outputs: [{ name: 'hit', type: 'boolean' }], rules: [{ id: 'r', when: { x: cell }, then: { hit: true } }] }), { x: value }).matched.length === 1;
    // number
    expect([one('number', '= 5', 5), one('number', '= 5', 6)]).toEqual([true, false]);
    expect([one('number', '!= 5', 6), one('number', '≠ 5', 5)]).toEqual([true, false]);
    expect([one('number', '< 5', 4), one('number', '< 5', 5), one('number', '<= 5', 5), one('number', '≤ 5', 6)]).toEqual([true, false, true, false]);
    expect([one('number', '> 5', 6), one('number', '> 5', 5), one('number', '>= 5', 5), one('number', '≥ 5', 4)]).toEqual([true, false, true, false]);
    expect([one('number', '[1..5]', 1), one('number', '[1..5]', 5), one('number', 'between 1 and 5', 6)]).toEqual([true, true, false]);
    expect([one('number', 'in (1, 2, 3)', 2), one('number', '1, 2, 3', 4), one('number', 'not in (1, 2)', 3), one('number', 'not in (1, 2)', 2)]).toEqual([true, false, true, false]);
    // string
    expect([one('string', 'gold', 'gold'), one('string', '"gold"', 'Gold')]).toEqual([true, false]);
    expect([one('string', 'contains "ac"', 'black'), one('string', 'contains ac', 'blue')]).toEqual([true, false]);
    expect([one('string', 'starts with "bl"', 'blue'), one('string', 'starts with bl', 'ablue')]).toEqual([true, false]);
    expect([one('string', 'in ("a, b", c)', 'a, b'), one('string', 'not in (a)', 'b')]).toEqual([true, true]);
    // boolean
    expect([one('boolean', 'true', true), one('boolean', '= false', 'false'), one('boolean', '!= true', true)]).toEqual([true, true, false]);
    // date
    expect([one('date', '>= 2026-01-01', '2026-03-04'), one('date', '< 2026-01-01', '2026-03-04T10:00:00Z'), one('date', '[2026-01-01..2026-12-31]', '2026-06-30')]).toEqual([true, false, true]);
    expect(one('date', '= 2026-01-01', '2026-01-01T00:00:00Z')).toBe(true);
    // empty: only "-" and "is empty" match a missing, null or empty input.
    expect([one('string', 'is empty', ''), one('string', 'is empty', null), one('string', 'is empty', 'x'), one('number', '-', undefined), one('string', '!= a', undefined)]).toEqual([true, true, false, true, false]);
    // Text cells and their text again.
    expect(parseCell('>= 1000', 'number')).toEqual({ op: 'gte', value: 1000 });
    expect(parseCell('in ("EU", UK)', 'string')).toEqual({ op: 'in', values: ['EU', 'UK'] });
    expect(parseCell('-', 'string')).toEqual({ op: 'any' });
    expect(cellText({ op: 'between', min: 1, max: 5 })).toBe('[1..5]');
    expect(cellText({ op: 'not_in', values: ['a', 2] })).toBe('not in ("a", 2)');
    expect(() => parseCell('>=', 'number')).toThrow(/needs a value/);
  });

  it('the publish check: types, columns, values, and rules never reached under first', () => {
    const errs = (raw: unknown) => checkDefinition(def(raw)).errors.map((e) => e.message);
    expect(errs({ ...DISCOUNT, rules: [{ id: 'x', when: { amount: '>= lots' }, then: { discount: 1 } }] })).toEqual([expect.stringMatching(/Rule 1 \(x\), amount: "lots" is not a number/)]);
    expect(errs({ ...DISCOUNT, rules: [{ id: 'x', when: { tier: '> 5' }, then: { discount: 1 } }] })).toEqual([expect.stringMatching(/a string column cannot be tested with gt/)]);
    expect(errs({ ...DISCOUNT, rules: [{ id: 'x', when: { amount: '[9..1]' }, then: { discount: 1 } }] })).toEqual([expect.stringMatching(/the range starts after it ends/)]);
    expect(errs({ ...DISCOUNT, rules: [{ id: 'x', when: { colour: 'red' }, then: { discount: 1 } }] })).toEqual([expect.stringMatching(/tests colour, which is not an input column/)]);
    expect(errs({ ...DISCOUNT, rules: [{ id: 'x', then: { discount: 'ten' } }] })).toEqual([expect.stringMatching(/discount: "ten" is not a number/)]);
    expect(errs({ ...DISCOUNT, rules: [{ id: 'x', then: {} }] })).toEqual([expect.stringMatching(/gives no value for discount/)]);
    expect(errs({ ...DISCOUNT, rules: [] })).toEqual([expect.stringMatching(/Add a rule/)]);
    expect(errs({ ...DISCOUNT, outputs: [{ name: 'discount', type: 'number', values: [0, 5] }], rules: [{ id: 'x', then: { discount: 7 } }] })).toEqual([expect.stringMatching(/7 is not one of its listed values/)]);
    expect(errs({ ...DISCOUNT, inputs: [{ name: 'tier', type: 'string' }, { name: 'Tier', type: 'number' }] }).join('\n')).toMatch(/Two columns are named Tier/);
    // Under first, a catch-all before other rules hides them (a warning, not an error); a narrower rule after a wider one too.
    const hidden = checkDefinition(def({ ...DISCOUNT, rules: [{ id: 'all', then: { discount: 0 } }, { id: 'gold', when: { tier: 'gold' }, then: { discount: 10 } }] }));
    expect(hidden.ok).toBe(true);
    expect(hidden.warnings).toEqual([expect.objectContaining({ code: 'unreachable', rule: 'gold', other: 'all', message: expect.stringMatching(/Rule 2 \(gold\) can never match: rule 1 \(all\) comes first/) })]);
    const narrower = checkDefinition(def({ ...DISCOUNT, rules: [{ id: 'big', when: { amount: '>= 100' }, then: { discount: 1 } }, { id: 'bigger', when: { amount: '[500..900]', tier: 'gold' }, then: { discount: 2 } }, { id: 'small', when: { amount: '< 100' }, then: { discount: 0 } }] }));
    expect(narrower.warnings.map((w) => w.rule)).toEqual(['bigger']);
    // The running example has nothing hidden; under unique its overlapping rules are errors.
    expect(checkDefinition(def(DISCOUNT))).toMatchObject({ ok: true, warnings: [] });
    expect(checkDefinition(def({ ...DISCOUNT, hitPolicy: 'unique' })).errors.map((e) => `${e.other}>${e.rule}`)).toEqual(['gold-big>gold', 'gold-big>none', 'gold>none', 'silver>none']);
    // Disjoint ranges, open and closed ends, and patterns that cannot meet are not overlaps.
    const disjoint = def({ inputs: [{ name: 'n', type: 'number' }, { name: 's', type: 'string' }], outputs: [{ name: 'o', type: 'number' }], hitPolicy: 'unique', rules: [{ id: 'a', when: { n: '< 10' }, then: { o: 1 } }, { id: 'b', when: { n: '>= 10', s: 'starts with ab' }, then: { o: 2 } }, { id: 'c', when: { n: '>= 10', s: 'starts with ba' }, then: { o: 3 } }, { id: 'd', when: { n: 'is empty' }, then: { o: 4 } }] });
    expect(checkDefinition(disjoint)).toMatchObject({ ok: true });
  });
});

// ---------- the server ----------

const trigger = (output?: WfNode['output']): WfNode => ({ id: 'trigger', kind: 'trigger', title: 'Trigger', x: 20, y: 20, config: { source: 'api' }, ...(output ? { output } : {}) });
const node = (id: string, kind: string, config: Record<string, unknown>): WfNode => ({ id, kind: kind as WfNode['kind'], title: id, x: 200, y: 20, config });
const chain = (nodes: WfNode[]): WfGraph => ({ nodes, edges: nodes.slice(1).map((n, i) => ({ from: nodes[i]!.id, to: n.id })), limits: {} });

describe('decision tables: routes, steps, flows, the tool and bundles', () => {
  let h: Harness;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let p: Principal;

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    const u = await localUser(h, 'designer', ['workflow-admin', 'member'], 'confidential');
    admin = await loginAdmin(h, 'designer');
    p = (await loadPrincipal(h.s, h.tenantId, u.id, {}))!;
  });
  afterEach(async () => {
    await h.close();
  });

  const send = (c: { agent: Awaited<ReturnType<typeof loginAdmin>>['agent']; csrf: string }, method: 'post' | 'put' | 'delete', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);
  const audits = async (action: string) => (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action })) as { target: string; detail: string; label: string }[];
  async function drain(): Promise<void> {
    for (let i = 0; i < 20; i++) if (!(await h.s.jobs.runDue())) break;
  }
  /** A published table through the routes. */
  async function published(name: string, raw: unknown = DISCOUNT, label: Label = 'internal') {
    const t = (await send(admin, 'post', '/api/decision-tables', { name, label, definition: raw }).expect(201)).body as { id: string };
    await send(admin, 'post', `/api/decision-tables/${t.id}/publish`, {}).expect(200);
    return t;
  }
  const runOf = async (workflowId: string) => (await h.s.db('workflow_runs').where({ workflow_id: workflowId }).orderBy('created_at', 'desc').first()) as { id: string; state: string; error: string | null };
  const stepOf = async (runId: string, nodeId: string) => ((await h.s.workflows.runView(p, runId)) as unknown as { steps: { nodeId: string; state: string; error: string | null; output: Record<string, unknown>; detail: Record<string, unknown>; label: string }[] }).steps.find((s) => s.nodeId === nodeId);

  it('drafts with text cells, checks, publishes versions, tests, exports and imports, all audited', async () => {
    const created = await send(admin, 'post', '/api/decision-tables', { name: 'discounts', title: 'Order discounts', label: 'internal', definition: { ...DISCOUNT, rules: DISCOUNT.rules.map(({ id: _id, ...r }) => r) } }).expect(201);
    const id = created.body.id as string;
    expect(created.body).toMatchObject({ name: 'discounts', title: 'Order discounts', draftRev: 1, publishedVersion: null, dirty: true, check: { ok: true } });
    // Text cells are stored as structured tests; rules without ids get r1, r2, …
    expect(created.body.draft.rules.map((r: { id: string }) => r.id)).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(created.body.draft.rules[0].when).toEqual({ tier: { op: 'eq', value: 'gold' }, amount: { op: 'gte', value: 1000 } });
    // A cell that does not parse is a 400 naming it.
    const bad = await send(admin, 'put', `/api/decision-tables/${id}/draft`, { definition: { ...DISCOUNT, rules: [{ when: { amount: '>=' }, then: { discount: 1 } }] } }).expect(400);
    expect(bad.headers['content-type']).toMatch(/problem\+json/);
    expect(bad.body.detail).toMatch(/Rule 1, amount: >= needs a value/);
    // The check endpoint says what publishing would, without saving.
    const check = await send(admin, 'post', `/api/decision-tables/${id}/check`, { definition: { ...DISCOUNT, hitPolicy: 'unique' } }).expect(200);
    expect(check.body.ok).toBe(false);
    expect(check.body.errors[0].code).toBe('overlap');

    // Publish v1; a draft with a problem is refused with every problem, and audited.
    const v1 = await send(admin, 'post', `/api/decision-tables/${id}/publish`, { note: 'first' }).expect(200);
    expect(v1.body).toMatchObject({ version: 1, warnings: [], table: { publishedVersion: 1, dirty: false } });
    const draft = await send(admin, 'put', `/api/decision-tables/${id}/draft`, { rev: 1, definition: { ...DISCOUNT, hitPolicy: 'unique' } }).expect(200);
    const refused = await send(admin, 'post', `/api/decision-tables/${id}/publish`, {}).expect(422);
    expect(refused.body.title).toBe('Decision table invalid');
    expect(refused.body.errors.length).toBe(4);
    expect((await audits('decision.publish.refused')).length).toBe(1);
    // A stale revision is a 409.
    await send(admin, 'put', `/api/decision-tables/${id}/draft`, { rev: 1, title: 'x' }).expect(409);
    await send(admin, 'put', `/api/decision-tables/${id}/draft`, { rev: draft.body.draftRev, definition: { ...DISCOUNT, rules: [{ id: 'flat', then: { discount: 3 } }] } }).expect(200);
    const v2 = await send(admin, 'post', `/api/decision-tables/${id}/publish`, {}).expect(200);
    expect(v2.body.version).toBe(2);
    expect(v2.body.table.versions.map((v: { version: number; state: string }) => [v.version, v.state])).toEqual([[2, 'published'], [1, 'deprecated']]);
    expect((await admin.agent.get(`/api/decision-tables/${id}/versions/1`).expect(200)).body.definition.rules).toHaveLength(4);

    // The test panel: the draft, a version, the latest published.
    const t1 = await send(admin, 'post', `/api/decision-tables/${id}/test`, { version: 1, inputs: { tier: 'gold', amount: 2000 } }).expect(200);
    expect(t1.body).toMatchObject({ version: 1, outputs: { discount: 15 }, matched: [{ rule: 'r1' }] });
    expect((await send(admin, 'post', `/api/decision-tables/${id}/test`, { version: 'published', inputs: { tier: 'gold', amount: 2000 } }).expect(200)).body.outputs).toEqual({ discount: 3 });
    const wrong = await send(admin, 'post', `/api/decision-tables/${id}/test`, { version: 1, inputs: { amount: 'lots' } }).expect(422);
    expect(wrong.body).toMatchObject({ title: 'Input refused', code: 'input' });

    // Export and import as a new draft table, never published.
    const exp = await admin.agent.get(`/api/decision-tables/${id}/export?version=1`).expect(200);
    expect(exp.headers['content-disposition']).toMatch(/discounts\.decision\.json/);
    expect(exp.body).toMatchObject({ format: 'exprsn-decision/1', table: { name: 'discounts', label: 'internal' }, version: 1 });
    await send(admin, 'post', '/api/decision-tables/import', { export: exp.body }).expect(409);
    const imp = await send(admin, 'post', '/api/decision-tables/import', { export: exp.body, name: 'discounts-copy' }).expect(201);
    expect(imp.body).toMatchObject({ name: 'discounts-copy', publishedVersion: null, check: { ok: true } });
    expect(imp.body.draft.rules).toHaveLength(4);
    await send(admin, 'post', '/api/decision-tables/import', { export: { format: 'something/1' } }).expect(400);

    expect((await admin.agent.get('/api/decision-tables').expect(200)).body.map((t: { name: string; publishedVersion: number | null }) => [t.name, t.publishedVersion])).toEqual([['discounts', 2], ['discounts-copy', null]]);
    for (const action of ['decision.created', 'decision.draft.saved', 'decision.published', 'decision.tested', 'decision.exported', 'decision.imported']) expect((await audits(action)).length, action).toBeGreaterThan(0);
    await send(admin, 'delete', `/api/decision-tables/${imp.body.id}`).expect(204);
    expect((await audits('decision.deleted')).length).toBe(1);
  });

  it('permissions and clearance: members read and test, only workflow admins design; tables above clearance do not exist for you', async () => {
    const t = await published('discounts');
    const secret = await published('secret-rates', DISCOUNT, 'confidential');
    await localUser(h, 'mem', ['member'], 'internal');
    const m = await login(h, 'mem');
    const mem = { agent: m.agent, csrf: m.csrf };
    expect((await mem.agent.get('/api/decision-tables').expect(200)).body.map((x: { name: string }) => x.name)).toEqual(['discounts']);
    await mem.agent.get(`/api/decision-tables/${t.id}`).expect(200);
    await mem.agent.get(`/api/decision-tables/${secret.id}`).expect(404);
    await send(mem, 'post', `/api/decision-tables/${secret.id}/test`, { inputs: {} }).expect(404);
    expect((await send(mem, 'post', `/api/decision-tables/${t.id}/test`, { version: 'published', inputs: { tier: 'gold', amount: 1 } }).expect(200)).body.outputs).toEqual({ discount: 10 });
    await send(mem, 'post', '/api/decision-tables', { name: 'mine' }).expect(403);
    await send(mem, 'put', `/api/decision-tables/${t.id}/draft`, { title: 'x' }).expect(403);
    await send(mem, 'post', `/api/decision-tables/${t.id}/publish`, {}).expect(403);
    await mem.agent.get(`/api/decision-tables/${t.id}/export`).expect(403);
    await send(mem, 'delete', `/api/decision-tables/${t.id}`).expect(403);
    // A designer cannot create a table above their own clearance.
    await send(admin, 'post', '/api/decision-tables', { name: 'top', label: 'restricted' }).expect(403);
  });

  it('a decision step in a run: inputs mapped from context, outputs into context, versions pinned or latest', async () => {
    await published('discounts');
    const input = { type: 'object' as const, properties: { tier: { type: 'string' as const }, total: { type: 'number' as const } }, required: ['tier', 'total'] };
    const g = chain([
      trigger(input),
      node('decide', 'decision', { table: 'discounts', inputs: { tier: '{{input.tier}}', amount: '{{input.total}}' }, outputs: { pct: 'discount' } }),
      node('price', 'transform', { fields: { pct: '{{steps.decide.pct}}', rules: '{{steps.decide.matched}}' } })
    ]);
    const w = await h.s.workflows.create(p, { name: 'pricing', label: 'internal', graph: g });
    expect((await h.s.workflows.publish(p, w.id, null)).version).toBe(1);
    const run = await h.s.workflows.start(p, w.id, { input: { tier: 'gold', total: 1200 }, dry: false });
    await drain();
    expect(await runOf(w.id)).toMatchObject({ state: 'succeeded' });
    const step = await stepOf(run.id, 'decide');
    expect(step!.output).toEqual({ pct: 15, matched: ['gold-big'] });
    expect(step!.detail).toMatchObject({ table: 'discounts', version: 1, hitPolicy: 'first', matched: ['gold-big'] });
    expect((await stepOf(run.id, 'price'))!.output).toEqual({ pct: 15, rules: ['gold-big'] });

    // Without a mapping the columns read the step's input fields of the same names; the latest version is used.
    const t = (await h.s.db('decision_tables').where({ name: 'discounts' }).first()) as { id: string; draft_rev: number };
    await send(admin, 'put', `/api/decision-tables/${t.id}/draft`, { definition: { ...DISCOUNT, rules: [{ id: 'flat', then: { discount: 7 } }] } }).expect(200);
    await send(admin, 'post', `/api/decision-tables/${t.id}/publish`, {}).expect(200);
    const g2 = chain([trigger({ type: 'object', properties: { tier: { type: 'string' }, amount: { type: 'number' } }, required: ['tier', 'amount'] }), node('latest', 'decision', { table: 'discounts' }), node('pinned', 'decision', { table: 'discounts', version: 1, source: '{{input}}' })]);
    const w2 = await h.s.workflows.create(p, { name: 'pricing-2', label: 'internal', graph: g2 });
    await h.s.workflows.publish(p, w2.id, null);
    const run2 = await h.s.workflows.start(p, w2.id, { input: { tier: 'gold', amount: 50 }, dry: false });
    await drain();
    expect((await stepOf(run2.id, 'latest'))!.output).toEqual({ discount: 7, matched: ['flat'] });
    expect((await stepOf(run2.id, 'pinned'))!.output).toEqual({ discount: 10, matched: ['gold'] });

    // A dry run evaluates too (nothing is written).
    const dry = await h.s.workflows.start(p, w2.id, { input: { tier: 'silver', amount: 500 }, dry: true });
    await drain();
    expect((await stepOf(dry.id, 'pinned'))!.output).toEqual({ discount: 5, matched: ['silver'] });
  });

  it('decision steps at publish and at run time: missing tables, labels, columns, no match, the owner\'s clearance, a broken policy', async () => {
    const publishError = async (name: string, g: WfGraph, label: Label = 'internal') => {
      const w = await h.s.workflows.create(p, { name, label, graph: g });
      const err = await h.s.workflows.publish(p, w.id, null).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(HttpProblem);
      return ((err as HttpProblem).extensions as { errors: { code: string; message: string }[] }).errors;
    };
    expect(await publishError('missing', chain([trigger(), node('d', 'decision', { table: 'nope' })]))).toEqual([expect.objectContaining({ code: 'unavailable', message: 'd: decision table nope is not a decision table here.' })]);
    const draftOnly = (await send(admin, 'post', '/api/decision-tables', { name: 'unpublished', definition: DISCOUNT }).expect(201)).body as { id: string };
    expect(draftOnly.id).toBeTruthy();
    expect((await publishError('draft-only', chain([trigger(), node('d', 'decision', { table: 'unpublished' })])))[0]!.message).toMatch(/has no published version/);
    await published('discounts');
    expect((await publishError('no-v9', chain([trigger(), node('d', 'decision', { table: 'discounts', version: 9 })])))[0]!.message).toMatch(/has no published version 9/);
    expect((await publishError('columns', chain([trigger(), node('d', 'decision', { table: 'discounts', inputs: { colour: '{{input.c}}' }, outputs: { x: 'nothing' } })]))).map((e) => e.message)).toEqual([expect.stringMatching(/has no input column colour/), expect.stringMatching(/x reads nothing, which is not an output column/)]);
    await published('secret-rates', DISCOUNT, 'confidential');
    expect(await publishError('above', chain([trigger(), node('d', 'decision', { table: 'secret-rates' })]))).toEqual([expect.objectContaining({ code: 'label', message: "d: decision table secret-rates is confidential, above this workflow's internal label." })]);

    // noMatch: fail stops the run with the reason; continue gives null outputs.
    const strict = def({ ...DISCOUNT, rules: [{ id: 'gold', when: { tier: 'gold' }, then: { discount: 10 } }] });
    await published('gold-only', strict);
    const g = chain([trigger(), node('d', 'decision', { table: 'gold-only', source: '{{input}}', noMatch: 'fail' })]);
    const w = await h.s.workflows.create(p, { name: 'strict', label: 'internal', graph: g });
    await h.s.workflows.publish(p, w.id, null);
    await h.s.workflows.start(p, w.id, { input: { tier: 'tin', amount: 1 }, dry: false });
    await drain();
    expect(await runOf(w.id)).toMatchObject({ state: 'failed', error: expect.stringMatching(/gold-only v1: no rule matched/) });
    const lax = await h.s.workflows.create(p, { name: 'lax', label: 'internal', graph: chain([trigger(), node('d', 'decision', { table: 'gold-only', source: '{{input}}' })]) });
    await h.s.workflows.publish(p, lax.id, null);
    const laxRun = await h.s.workflows.start(p, lax.id, { input: { tier: 'tin' }, dry: false });
    await drain();
    expect((await stepOf(laxRun.id, 'd'))!.output).toEqual({ discount: null, matched: [] });

    // A unique table whose rules overlap fails the step with both rules named. Publishing refuses such a table, so the
    // version row is written directly here, as an unchecked version would be.
    const t = (await h.s.db('decision_tables').where({ name: 'gold-only' }).first()) as { id: string };
    const clash = def({ ...DISCOUNT, hitPolicy: 'unique', rules: [{ id: 'a', when: { tier: 'gold' }, then: { discount: 1 } }, { id: 'b', when: { amount: '> 0' }, then: { discount: 2 } }] });
    await h.s.db('decision_table_versions').where({ table_id: t.id, version: 1 }).update({ definition: JSON.stringify(clash) });
    const laxRun2 = await h.s.workflows.start(p, lax.id, { input: { tier: 'gold', amount: 5 }, dry: false });
    await drain();
    expect(await h.s.db('workflow_runs').where({ id: laxRun2.id }).first()).toMatchObject({ state: 'failed', error: expect.stringMatching(/unique hit policy allows one matching rule, and 2 match: a, b/) });

    // The run's owner must clear the table: a confidential table in a confidential workflow, run by someone who no
    // longer clears it, blocks the step.
    const conf = await h.s.workflows.create(p, { name: 'conf', label: 'confidential', graph: chain([trigger(), node('d', 'decision', { table: 'secret-rates', source: '{{input}}' })]) });
    await h.s.workflows.publish(p, conf.id, null);
    const runC = await h.s.workflows.start(p, conf.id, { input: { tier: 'gold', amount: 5000 }, dry: false });
    await drain();
    const okStep = await stepOf(runC.id, 'd');
    expect(okStep).toMatchObject({ state: 'passed', label: 'confidential', output: { discount: 15 } });
    const lowered = { ...p, clearance: 'internal' as Label };
    expect(await h.s.decisions.forStep(lowered, 'secret-rates')).toMatchObject({ blocked: true, missing: expect.stringMatching(/above the clearance of the run's owner/) });

    // Deleting a table that a published workflow uses is refused.
    const used = await send(admin, 'delete', `/api/decision-tables/${t.id}`).expect(409);
    expect(used.body).toMatchObject({ title: 'Still in use', usedBy: expect.arrayContaining([expect.objectContaining({ workflow: 'lax', steps: ['d'] })]) });
    expect((await admin.agent.get(`/api/decision-tables/${t.id}/used-by`).expect(200)).body.deleteBlocked).toBe(true);
  });

  it('the app-flow decision action compiles onto a decision step that reads the record and feeds later actions', async () => {
    await published('discounts');
    const app = { id: 'A'.repeat(26), name: 'crm', title: 'CRM', label: 'internal' } as AppRow;
    const deal = { id: 'E'.repeat(26), name: 'deal', label: 'internal', definition: entityDefinitionSchema.parse({ fields: [{ name: 'tier', type: 'string', maxLength: 20 }, { name: 'amount', type: 'number' }, { name: 'discount', type: 'number' }] }) } as EntityRow;
    const flow = flowInputSchema.parse({
      name: 'price_deal',
      entity: 'deal',
      trigger: { kind: 'record', events: ['created'] },
      actions: [
        { type: 'decision', table: 'discounts' },
        { type: 'decision', table: 'discounts', version: 1, inputs: { tier: '{{input.record.values.tier}}', amount: '{{input.record.values.amount}}' }, noMatch: 'fail' },
        { type: 'update', values: { discount: '{{steps.act1.discount}}' } }
      ]
    });
    expect(flowProblems(flow, [deal])).toEqual([]);
    const g = compileFlow(app, flow);
    expect(g.nodes.find((n) => n.id === 'act1')).toMatchObject({ kind: 'decision', title: 'Decide with discounts', config: { table: 'discounts', source: '{{input.record.values}}', noMatch: 'continue' } });
    expect(g.nodes.find((n) => n.id === 'act2')).toMatchObject({ kind: 'decision', config: { table: 'discounts', version: 1, inputs: { tier: '{{input.record.values.tier}}' }, noMatch: 'fail' } });
    // The compiled decision steps run as a workflow would (the record step is left out: no app here).
    const runnable = { ...g, nodes: g.nodes.filter((n) => n.id !== 'act3'), edges: g.edges.filter((e) => e.to !== 'act3' && e.from !== 'act3') };
    const w = await h.s.workflows.create(p, { name: 'flow-like', label: 'internal', graph: runnable });
    await h.s.workflows.publish(p, w.id, null);
    const run = await h.s.workflows.start(p, w.id, { input: { event: 'created', record: { id: 'R1', values: { tier: 'gold', amount: 3000 } } }, dry: false });
    await drain();
    expect((await stepOf(run.id, 'act1'))!.output).toEqual({ discount: 15, matched: ['gold-big'] });
    expect((await stepOf(run.id, 'act2'))!.output).toEqual({ discount: 15, matched: ['gold-big'] });
    // An action reading a later one is refused like any other.
    expect(flowProblems(flowInputSchema.parse({ ...flow, actions: [{ type: 'decision', table: 'discounts', inputs: { tier: '{{steps.act2.x}}' } }, { type: 'wait', minutes: 1 }] }), [deal]).join('\n')).toMatch(/reads action 2, which does not run before it/);
  });

  it('decision.evaluate: a read-only built-in, as the caller, never above the label of the call', async () => {
    await published('discounts');
    await published('secret-rates', DISCOUNT, 'confidential');
    const entry = (await h.s.db('registry_entries').where({ name: 'decision.evaluate' }).first()) as { side_effect: string; status: string; tenant_id: string | null; impl: string };
    expect(entry).toMatchObject({ side_effect: 'read', status: 'published', tenant_id: null, impl: 'builtin' });
    const call = async (as: Principal, args: Record<string, unknown>, label: Label = 'internal') => {
      const { tools } = await h.s.tools.resolve(as, ['decision.evaluate'], label);
      return h.s.tools.call({ principal: as, label, approved: false, source: { kind: 'agent-run', id: 'R1' } }, tools[0]!, args);
    };
    const ok = await call(p, { table: 'discounts', inputs: { tier: 'silver', amount: 120 } });
    expect(ok.ok).toBe(true);
    expect(ok.result).toMatchObject({ table: 'discounts', version: 1, hitPolicy: 'first', outputs: { discount: 5 }, matched: [{ rule: 'silver' }], summary: expect.stringMatching(/Rule 3 \(silver\)/) });
    // A confidential table from an internal conversation is refused, even for someone cleared for it.
    const low = await call(p, { table: 'secret-rates', inputs: {} }, 'internal');
    expect(low.ok).toBe(false);
    expect(String(low.error)).toMatch(/no decision table secret-rates that this call may read/);
    expect((await call(p, { table: 'secret-rates', inputs: { tier: 'gold', amount: 2000 } }, 'confidential')).result).toMatchObject({ outputs: { discount: 15 } });
    // Wrong input types come back as data the model can correct.
    const wrong = await call(p, { table: 'discounts', inputs: { amount: 'many' } });
    expect(wrong.ok).toBe(false);
    expect(String(wrong.error)).toMatch(/Input amount should be a number/);
    // Someone without agents:run cannot read tables through it either.
    const u = await localUser(h, 'reader', ['auditor'], 'internal');
    const auditor = (await loadPrincipal(h.s, h.tenantId, u.id, {}))!;
    const r = await h.s.tools.resolve(auditor, ['decision.evaluate'], 'internal');
    if (r.tools[0]) {
      const denied = await h.s.tools.call({ principal: auditor, label: 'internal', approved: false, source: { kind: 'agent-run', id: 'R1' } }, r.tools[0], { table: 'discounts', inputs: {} });
      expect(denied.ok).toBe(false);
    } else expect(r.tools).toEqual([]);
  });

  it('workflow bundles carry decision steps by table name and re-bind them on import, or report them missing', async () => {
    const t = await published('discounts');
    // A step naming the table by id is exported by name.
    const g = chain([trigger(), node('decide', 'decision', { table: t.id, source: '{{input}}' }), node('done', 'transform', { fields: { d: '{{steps.decide.discount}}' } })]);
    const w = await h.s.workflows.create(p, { name: 'priced', label: 'internal', graph: g });
    await h.s.workflows.publish(p, w.id, null);
    const bundle = (await admin.agent.get(`/api/workflows/${w.id}/bundle`).expect(200)).body as { graph: WfGraph; references: { decisions?: { name: string; version: number | null }[] } };
    expect(bundle.graph.nodes.find((n) => n.id === 'decide')!.config.table).toBe('discounts');
    expect(bundle.references.decisions).toEqual([{ name: 'discounts', version: null }]);
    // Same name here: bound.
    const same = await send(admin, 'post', '/api/workflows/import', { bundle, name: 'priced-copy' }).expect(201);
    expect(same.body.bindings).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'decision', from: 'discounts', to: 'discounts', status: 'bound', detail: 'version 1, internal' })]));
    // Bound to another table by name.
    await published('discounts-eu');
    const other = await send(admin, 'post', '/api/workflows/import', { bundle, name: 'priced-eu', bindings: { decisions: { discounts: 'discounts-eu' } } }).expect(201);
    expect(other.body.bindings).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'decision', from: 'discounts', to: 'discounts-eu', status: 'bound' })]));
    expect(other.body.workflow.draft.nodes.find((n: WfNode) => n.id === 'decide').config.table).toBe('discounts-eu');
    // A table that is not here: reported missing, and publishing the import refuses it.
    const gone = await send(admin, 'post', '/api/workflows/import', { bundle, name: 'priced-gone', bindings: { decisions: { discounts: 'nowhere' } } }).expect(201);
    expect(gone.body.bindings).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'decision', to: 'nowhere', status: 'missing', detail: 'decision table nowhere is not a decision table here' })]));
    await send(admin, 'post', `/api/workflows/${gone.body.workflow.id}/publish`, {}).expect(422);
    // A bundle from before decision tables (no decisions reference) still imports.
    const plain = await h.s.workflows.create(p, { name: 'plain', label: 'internal', graph: chain([trigger(), node('t', 'transform', { fields: { a: '1' } })]) });
    const pb = (await admin.agent.get(`/api/workflows/${plain.id}/bundle`).expect(200)).body as Record<string, unknown> & { references: Record<string, unknown> };
    expect(pb.references.decisions).toBeUndefined();
    await send(admin, 'post', '/api/workflows/import', { bundle: pb, name: 'plain-copy' }).expect(201);
  });
});
