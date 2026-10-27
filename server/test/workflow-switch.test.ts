/*
 * Sprint 46 (B-132): the multi-way switch step. A value compared with ordered cases (equals, in a list, a number
 * range) and a default; exactly one edge is taken, the steps behind the others are skipped. Publishing needs unique
 * case labels, an edge for every case and a default edge; bundles carry the case edges.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '../src/authz/policy.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { HttpProblem } from '../src/http/problem.js';
import { validateGraph, type WfEdge, type WfGraph, type WfNode } from '../src/workflows/graph.js';
import { switchCaseOf, type SwitchCase } from '../src/workflows/steps/kinds.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';

const CASES: SwitchCase[] = [
  { label: 'small', match: 'range', max: 1000 },
  { label: 'medium', match: 'range', min: 1000, max: 10000 },
  { label: 'vip', match: 'in', values: ['acme', 'globex'] },
  { label: 'exact', match: 'equals', value: 'yes' }
];

const trigger: WfNode = { id: 'trigger', kind: 'trigger', title: 'Trigger', x: 20, y: 20, config: { source: 'api' } };
const sw = (cases: SwitchCase[] = CASES, value = '{{input.amount}}'): WfNode => ({ id: 'route', kind: 'switch', title: 'Route', x: 200, y: 20, config: { value, cases } });
const leaf = (id: string): WfNode => ({ id, kind: 'transform', title: id, x: 400, y: 20, config: { fields: { went: id } } });

/** trigger → switch → one transform per case and the default. */
function graph(cases: SwitchCase[] = CASES, value?: string, edges?: WfEdge[]): WfGraph {
  const labels = [...cases.map((c) => c.label), 'default'];
  const ids = labels.map((l) => `to-${l.replace(/[^a-z0-9]/gi, '')}`);
  return {
    nodes: [trigger, sw(cases, value), ...ids.map(leaf)],
    edges: edges ?? [{ from: 'trigger', to: 'route' }, ...labels.map((l, i) => ({ from: 'route', to: ids[i]!, case: l }))],
    limits: {}
  };
}

const env = { label: 'internal' as const, profile: () => undefined };

describe('switch: matching', () => {
  it('takes the first case that matches, else the default', () => {
    expect(switchCaseOf(CASES, 5)).toBe('small');
    expect(switchCaseOf(CASES, '999.5')).toBe('small');
    expect(switchCaseOf(CASES, 1000)).toBe('medium'); // min is included, max is not
    expect(switchCaseOf(CASES, 10000)).toBe('default');
    expect(switchCaseOf(CASES, 'acme')).toBe('vip');
    expect(switchCaseOf(CASES, 'yes')).toBe('exact');
    expect(switchCaseOf(CASES, 'no')).toBe('default');
    expect(switchCaseOf(CASES, undefined)).toBe('default');
    expect(switchCaseOf([{ label: 'none', match: 'equals', value: null }], undefined)).toBe('none');
    expect(switchCaseOf([{ label: 'five', match: 'equals', value: 5 }], '5')).toBe('five');
    // Order decides: the first matching case wins.
    expect(switchCaseOf([{ label: 'a', match: 'range', min: 0 }, { label: 'b', match: 'range', min: 10 }], 50)).toBe('a');
  });
});

describe('switch: publish validation', () => {
  const errors = (g: WfGraph) => validateGraph(g, env).errors.map((e) => e.message);

  it('a complete switch is valid', () => {
    expect(validateGraph(graph(), env)).toMatchObject({ ok: true, errors: [] });
  });

  it('needs unique case labels, not "default", and sound ranges', () => {
    expect(errors(graph([{ label: 'a', match: 'equals', value: 1 }, { label: 'A', match: 'equals', value: 2 }]))).toEqual(expect.arrayContaining([expect.stringMatching(/two cases are labelled A; case labels are unique/)]));
    expect(errors(graph([{ label: 'Default', match: 'equals', value: 1 }]))).toEqual(expect.arrayContaining([expect.stringMatching(/"default" is the label of the default edge/)]));
    expect(errors(graph([{ label: 'r', match: 'range' }]))).toEqual(expect.arrayContaining([expect.stringMatching(/case r is a range without a minimum or a maximum/)]));
    expect(errors(graph([{ label: 'r', match: 'range', min: 5, max: 5 }]))).toEqual(expect.arrayContaining([expect.stringMatching(/runs from 5 up to 5, which holds no number/)]));
    expect(errors(graph([]))).toEqual(expect.arrayContaining([expect.stringMatching(/Add at least one case/)]));
  });

  it('needs a default edge, an edge for every case, and one edge per case', () => {
    const base = graph();
    const without = (label: string) => ({ ...base, edges: base.edges.filter((e) => e.case !== label) });
    expect(errors(without('default'))).toEqual(expect.arrayContaining([expect.stringMatching(/Route needs a default edge/)]));
    expect(errors(without('vip'))).toEqual(expect.arrayContaining([expect.stringMatching(/case vip is not connected/)]));
    // Two edges taking one case would take two steps.
    const twice = { ...base, edges: base.edges.map((e) => (e.case === 'exact' ? { ...e, case: 'vip' } : e)) };
    expect(errors(twice)).toEqual(expect.arrayContaining([expect.stringMatching(/2 edges take the case vip/), expect.stringMatching(/case exact is not connected/)]));
    // An edge without a case, or naming one the step does not have; a case on another step's edge.
    const noCase = { ...base, edges: base.edges.map((e) => (e.case === 'small' ? { from: e.from, to: e.to } : e)) };
    expect(errors(noCase)).toEqual(expect.arrayContaining([expect.stringMatching(/needs a case: one of the switch's cases, or default/)]));
    const unknown = { ...base, edges: base.edges.map((e) => (e.case === 'small' ? { ...e, case: 'tiny' } : e)) };
    expect(errors(unknown)).toEqual(expect.arrayContaining([expect.stringMatching(/names the case tiny, which the step does not have/)]));
    const stray = { ...base, edges: base.edges.map((e) => (e.from === 'trigger' ? { ...e, case: 'small' } : e)) };
    expect(errors(stray)).toEqual(expect.arrayContaining([expect.stringMatching(/Only a switch step's edges take a case/)]));
    const branchy = { ...base, edges: base.edges.map((e) => (e.case === 'small' ? { ...e, branch: 'true' as const } : e)) };
    expect(errors(branchy)).toEqual(expect.arrayContaining([expect.stringMatching(/Only a branch step's edges take true or false/)]));
    // A switch cannot have a retry policy (it decides the same every time), and reads only earlier steps.
    expect(errors({ ...base, nodes: base.nodes.map((n) => (n.id === 'route' ? { ...n, retry: { max: 1, delayMs: 1000, backoff: 'fixed' as const } } : n)) })).toEqual(expect.arrayContaining([expect.stringMatching(/a switch step cannot have a retry policy/)]));
    expect(errors(graph(CASES, '{{steps.to-small.went}}'))).toEqual(expect.arrayContaining([expect.stringMatching(/reads to-small, which does not run before it/)]));
  });
});

describe('switch: runs and bundles', () => {
  let h: Harness;
  let p: Principal;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    const u = await localUser(h, 'designer', ['workflow-admin', 'member'], 'internal');
    p = (await loadPrincipal(h.s, h.tenantId, u.id, {}))!;
    admin = await loginAdmin(h, 'designer');
  });
  afterEach(async () => {
    await h.close();
  });

  async function drain(): Promise<void> {
    for (let i = 0; i < 20; i++) if (!(await h.s.jobs.runDue())) break;
  }
  const states = async (runId: string) => Object.fromEntries(((await h.s.db('workflow_steps').where({ run_id: runId })) as { node_id: string; state: string }[]).map((s) => [s.node_id, s.state]));

  it('takes exactly one edge in a run; the other branches are skipped, and a join after them still runs', async () => {
    const g = graph();
    // A join after every branch runs once, whichever branch was taken.
    g.nodes.push({ id: 'join', kind: 'transform', title: 'Join', x: 600, y: 20, config: { fields: { took: '{{steps.route.case}}' } } });
    for (const n of g.nodes.filter((x) => x.id.startsWith('to-'))) g.edges.push({ from: n.id, to: 'join' });
    const w = await h.s.workflows.create(p, { name: 'router', label: 'internal', graph: g });
    expect((await h.s.workflows.publish(p, w.id, null)).version).toBe(1);
    const cases: [unknown, string][] = [[50, 'to-small'], [5000, 'to-medium'], ['globex', 'to-vip'], ['yes', 'to-exact'], [10 ** 6, 'to-default']];
    for (const [amount, expected] of cases) {
      const run = await h.s.workflows.start(p, w.id, { input: { amount }, dry: false });
      await drain();
      const st = await states(run.id);
      expect((await h.s.db('workflow_runs').where({ id: run.id }).first()).state).toBe('succeeded');
      const taken = Object.keys(st).filter((k) => k.startsWith('to-') && st[k] === 'passed');
      expect(taken, String(amount)).toEqual([expected]);
      expect(Object.keys(st).filter((k) => k.startsWith('to-') && st[k] === 'skipped')).toHaveLength(4);
      expect(st.join).toBe('passed');
      const view = (await h.s.workflows.runView(p, run.id)) as unknown as { steps: { nodeId: string; output: Record<string, unknown>; detail: Record<string, unknown> }[] };
      const route = view.steps.find((s) => s.nodeId === 'route')!;
      expect(route.output).toMatchObject({ amount, case: expected.slice(3) });
      expect(route.detail).toMatchObject({ case: expected.slice(3) });
      expect(view.steps.find((s) => s.nodeId === 'join')!.output).toEqual({ took: expected.slice(3) });
    }
    // A dry run decides the same way.
    const dry = await h.s.workflows.start(p, w.id, { input: { amount: 1500 }, dry: true });
    await drain();
    expect((await states(dry.id))['to-medium']).toBe('passed');
  });

  it('publishing refuses an incomplete switch with every problem', async () => {
    const base = graph();
    const w = await h.s.workflows.create(p, { name: 'broken', label: 'internal', graph: { ...base, edges: base.edges.filter((e) => e.case !== 'default' && e.case !== 'vip') } });
    const err = await h.s.workflows.publish(p, w.id, null).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(HttpProblem);
    expect((err as HttpProblem).status).toBe(422);
    const msgs = ((err as HttpProblem).extensions.errors as { message: string; nodeId?: string }[]).map((e) => e.message);
    expect(msgs).toEqual(expect.arrayContaining([expect.stringMatching(/case vip is not connected/), expect.stringMatching(/Route needs a default edge/)]));
  });

  it('bundles carry the switch and its case edges', async () => {
    const w = await h.s.workflows.create(p, { name: 'router', label: 'internal', graph: graph() });
    await h.s.workflows.publish(p, w.id, null);
    const bundle = (await admin.agent.get(`/api/workflows/${w.id}/bundle`).expect(200)).body as { graph: WfGraph };
    expect(bundle.graph.edges.filter((e) => e.from === 'route').map((e) => e.case).sort()).toEqual(['default', 'exact', 'medium', 'small', 'vip']);
    const imp = await admin.agent.post('/api/workflows/import').set('x-csrf-token', admin.csrf).send({ bundle, name: 'router-copy' }).expect(201);
    expect(imp.body.workflow.validation.ok).toBe(true);
    expect(imp.body.workflow.draft.nodes.find((n: WfNode) => n.id === 'route').config.cases).toHaveLength(4);
    // A case edge changed after signing is refused like any other change.
    const tampered = JSON.parse(JSON.stringify(bundle)) as { graph: WfGraph };
    tampered.graph.edges.find((e) => e.case === 'vip')!.case = 'small';
    await admin.agent.post('/api/workflows/import').set('x-csrf-token', admin.csrf).send({ bundle: tampered, name: 'router-bad' }).expect(422);
  });
});
