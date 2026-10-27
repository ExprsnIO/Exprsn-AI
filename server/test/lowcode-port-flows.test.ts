import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compileFlow, flowInputSchema, flowProblems, type FlowInput } from '../src/apps/flows.js';
import type { AppRow, EntityRow } from '../src/apps/service.js';
import { entityDefinitionSchema } from '../src/apps/schema.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';
import { drain } from './retrieval-seed.js';
import { seedGateway } from './seed-gateway.js';

/*
 * The exprsn-platform low-code port (docs/decisions/lowcode-port.md): app flows compiled into Workflows graphs and
 * started by the app's own triggers.
 */

const dealDefinition = {
  fields: [
    { name: 'title', type: 'string', required: true, indexed: true, unique: true, maxLength: 120 },
    { name: 'amount', type: 'number', indexed: true, min: 0 },
    { name: 'stage', type: 'enum', indexed: true, options: [{ value: 'Lead' }, { value: 'Won' }, { value: 'Lost' }] },
    { name: 'notes', type: 'string', multiline: true, maxLength: 5000 },
    { name: 'twice', type: 'formula', expression: 'amount * 2' }
  ],
  states: { initial: 'open', states: [{ name: 'open' }, { name: 'review' }, { name: 'closed' }], transitions: [{ from: ['open'], to: 'review' }, { from: ['review'], to: 'closed' }] }
};

describe('flow model and compiler', () => {
  const app = { id: 'A'.repeat(26), name: 'crm', title: 'CRM', label: 'internal' } as AppRow;
  const deal = { id: 'E'.repeat(26), name: 'deal', definition: entityDefinitionSchema.parse(dealDefinition) } as EntityRow;
  const base = (over: Partial<FlowInput> = {}): FlowInput => flowInputSchema.parse({ name: 'f', entity: 'deal', trigger: { kind: 'record', events: ['created'] }, actions: [{ type: 'update', values: { notes: 'x' } }], ...over });

  it('compiles a condition tree into branch steps with one live path each way', () => {
    const g = compileFlow(app, base({ match: { all: [{ field: 'amount', op: 'gt', value: 10 }, { any: [{ field: 'stage', op: 'in', value: ['Won', 'Lead'] }, { field: 'notes', op: 'not_exists' }] }] } }));
    const branches = g.nodes.filter((n) => n.kind === 'branch');
    // amount > 10, stage = Won, stage = Lead, notes exists (negated)
    expect(branches).toHaveLength(4);
    const trig = g.edges.find((e) => e.from === 'trigger')!;
    const first = g.nodes.find((n) => n.id === trig.to)!;
    expect(first.config).toMatchObject({ left: '{{input.record.values.amount}}', op: 'gt', right: 10 });
    // not_exists swaps the edges of an exists step: true leads nowhere (the run ends), false to the action
    const notes = branches.find((n) => n.config.op === 'exists')!;
    expect(g.edges.filter((e) => e.from === notes.id)).toEqual([{ from: notes.id, to: 'act1', branch: 'false' }]);
    // every node is laid out to the right of the trigger and no edge is doubled
    expect(new Set(g.edges.map((e) => `${e.from}>${e.to}`)).size).toBe(g.edges.length);
    expect(g.nodes.every((n) => n.id === 'trigger' || n.x > 20)).toBe(true);
  });

  it('compiles per-action conditions, retries and continue-on-error', () => {
    const g = compileFlow(app, base({ actions: [{ type: 'transition', to: 'closed', onError: 'continue', retries: 2 }, { type: 'update', values: { notes: 'y' }, when: { field: 'state', op: 'eq', value: 'open' } }] as never }));
    const act1 = g.nodes.find((n) => n.id === 'act1')!;
    expect(act1).toMatchObject({ kind: 'record', retry: { max: 2 }, config: { action: 'transition', app: app.id, entity: 'deal', record: '{{input.record.id}}', to: 'closed' } });
    expect(g.edges).toContainEqual({ from: 'act1', to: 'act1-failed', branch: 'failure' });
    const when = g.nodes.find((n) => n.kind === 'branch')!;
    expect(g.edges).toContainEqual({ from: 'act1', to: when.id });
    expect(g.edges).toContainEqual({ from: 'act1-failed', to: when.id });
    expect(g.edges).toContainEqual({ from: when.id, to: 'act2', branch: 'true' });
  });

  it('names every problem: unknown fields, values, states, roles and record-less flows', () => {
    const p = flowProblems(base({ match: { field: 'nope', op: 'eq', value: 1 }, actions: [{ type: 'update', values: { twice: '1' } }, { type: 'transition', to: 'gone' }, { type: 'notify', users: [], roles: ['nobody'], title: 'x' }, { type: 'wait', minutes: 1, retries: 1 }] as never }), [deal]);
    expect(p.join('\n')).toMatch(/nope is not a field/);
    expect(p.join('\n')).toMatch(/twice is not a field of deal that can be written/);
    expect(p.join('\n')).toMatch(/gone is not a state/);
    expect(p.join('\n')).toMatch(/no role nobody/);
    expect(p.join('\n')).toMatch(/wait step is not retried/);
    expect(flowProblems(base({ trigger: { kind: 'schedule', cron: '0 9 * * 1' }, match: { field: 'amount', op: 'gt', value: 1 } }), [deal]).join('\n')).toMatch(/needs a record/);
    expect(flowProblems(base({ match: { field: 'stage', op: 'in', value: 'Won' } }), [deal]).join('\n')).toMatch(/takes a list/);
    expect(flowProblems(base(), [deal])).toEqual([]);
  });
});

describe('app flows (the low-code port)', () => {
  let h: Harness;
  let wsId: string;

  beforeEach(async () => {
    h = await harness();
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Sales', 'confidential')).id;
  });
  afterEach(async () => {
    await h.close();
  });

  type C = Awaited<ReturnType<typeof member>>;
  async function wrap(c: { agent: Client['agent']; csrf: string }) {
    const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
    await send('put', '/api/me/workspace', { workspaceId: wsId }).expect(200);
    return { ...c, post: (p: string, b?: object) => send('post', p, b), put: (p: string, b?: object) => send('put', p, b), patch: (p: string, b?: object) => send('patch', p, b), del: (p: string) => send('delete', p), get: (p: string) => c.agent.get(p) };
  }
  async function member(name: string) {
    const u = await localUser(h, name, ['member'], 'internal');
    await h.s.tenants.addMember(wsId, u.id);
    return { user: u, ...(await wrap(await login(h, name))) };
  }
  async function designer(name = 'dee') {
    const u = await localUser(h, name, ['workflow-admin', 'member'], 'confidential');
    await h.s.tenants.addMember(wsId, u.id);
    return { user: u, ...(await wrap(await loginAdmin(h, name))) };
  }
  async function setup(d: C) {
    await d.post('/api/apps', { name: 'crm', title: 'CRM', label: 'confidential', workspaceId: wsId }).expect(201);
    await d.post('/api/apps/crm/entities', { name: 'deal', title: 'Deal', label: 'internal', definition: dealDefinition }).expect(201);
  }
  const audits = async (action: string) => (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action })) as { target: string; detail: string | null }[];
  const record = async (c: C, values: Record<string, unknown>) => (await c.post('/api/apps/crm/entities/deal/records', { values }).expect(201)).body as { id: string };
  const read = async (c: C, id: string) => (await c.get(`/api/apps/crm/entities/deal/records/${id}`).expect(200)).body as { state: string; values: Record<string, unknown> };

  const bigDeals = {
    name: 'big_deals',
    title: 'Big deals',
    entity: 'deal',
    trigger: { kind: 'record', events: ['created'] },
    match: { all: [{ field: 'amount', op: 'gt', value: 100 }, { any: [{ field: 'stage', op: 'in', value: ['Won', 'Lead'] }, { field: 'notes', op: 'exists' }] }] },
    actions: [
      { type: 'update', values: { notes: 'big: {{input.record.values.title}}' } },
      { type: 'transition', to: 'closed', onError: 'continue' },
      { type: 'transition', to: 'review', when: { field: 'stage', op: 'eq', value: 'Won' } }
    ]
  };

  it('creates a flow as a published workflow with a record trigger, and runs it on matching records only', async () => {
    const d = await designer();
    const m = await member('mia');
    await setup(d);
    // members neither see nor change flows
    await m.get('/api/apps/crm/flows').expect(403);
    await m.post('/api/apps/crm/flows', bigDeals).expect(403);
    // an invalid flow is refused with every problem
    const bad = await d.post('/api/apps/crm/flows', { ...bigDeals, actions: [{ type: 'transition', to: 'nowhere' }] }).expect(400);
    expect(bad.body.problems[0]).toMatch(/nowhere is not a state/);

    const flow = (await d.post('/api/apps/crm/flows', bigDeals).expect(201)).body;
    expect(flow).toMatchObject({ name: 'big_deals', entity: 'deal', enabled: true, editedElsewhere: false, workflow: { name: 'app-crm-big-deals', publishedVersion: 1 } });
    expect(flow.graph.nodes.filter((n: { kind: string }) => n.kind === 'branch').length).toBe(5);
    const trig = await h.s.db('app_triggers').where({ id: flow.triggerId }).first();
    expect(trig).toMatchObject({ kind: 'record', events: 'created', workflow_id: flow.workflowId, owner_id: d.user.id });
    await d.post('/api/apps/crm/flows', bigDeals).expect(409);

    const won = await record(m, { title: 'Kilo', amount: 500, stage: 'Won' });
    const small = await record(m, { title: 'Lima', amount: 5, stage: 'Won' });
    const lost = await record(m, { title: 'Mike', amount: 500, stage: 'Lost' });
    const noted = await record(m, { title: 'Nova', amount: 500, stage: 'Lost', notes: 'call back' });
    await drain(h);
    // all of: amount > 100, and stage Won or Lead or notes set. The illegal move to closed fails and the flow goes on.
    expect(await read(m, won.id)).toMatchObject({ state: 'review', values: { notes: 'big: Kilo' } });
    expect(await read(m, small.id)).toMatchObject({ state: 'open', values: {} });
    expect((await read(m, small.id)).values.notes).toBeUndefined();
    expect((await read(m, lost.id)).values.notes).toBeUndefined();
    expect(await read(m, noted.id)).toMatchObject({ state: 'open', values: { notes: 'big: Nova' } });
    const runs = (await h.s.db('workflow_runs').where({ workflow_id: flow.workflowId })) as { state: string }[];
    expect(runs).toHaveLength(4);
    expect(runs.every((r) => r.state === 'succeeded')).toBe(true);

    const listed = (await d.get('/api/apps/crm/flows').expect(200)).body.flows;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: 'big_deals', lastResult: 'started', steps: 3 });
    expect((await d.get(`/api/apps/crm/flows/${flow.id}/runs`).expect(200)).body.runs).toHaveLength(4);
    expect((await audits('app.flow.created')).length).toBe(1);
    expect((await audits('workflow.published')).length).toBe(1);
  });

  it('notices an edit on Workflows, overwrites it on request, changes the trigger, tests, toggles and deletes', async () => {
    const d = await designer();
    const m = await member('mia');
    await setup(d);
    const flow = (await d.post('/api/apps/crm/flows', { ...bigDeals, match: null }).expect(201)).body;
    // someone saves the workflow on the Workflows screen
    const wf = (await d.get(`/api/workflows/${flow.workflowId}`).expect(200)).body;
    await d.put(`/api/workflows/${flow.workflowId}/draft`, { graph: wf.draft, rev: wf.draftRev }).expect(200);
    expect((await d.get(`/api/apps/crm/flows/${flow.id}`).expect(200)).body.editedElsewhere).toBe(true);
    const { name: _n, ...change } = { ...bigDeals, match: null, trigger: { kind: 'schedule', cron: '0 6 * * 1' }, actions: [{ type: 'notify', roles: ['workflow-admin'], title: 'Weekly deals' }] };
    const refused = await d.put(`/api/apps/crm/flows/${flow.id}`, change).expect(409);
    expect(refused.body.editedElsewhere).toBe(true);
    const saved = (await d.put(`/api/apps/crm/flows/${flow.id}`, { ...change, force: true }).expect(200)).body;
    expect(saved).toMatchObject({ editedElsewhere: false, trigger: { kind: 'schedule' }, workflow: { publishedVersion: 2 } });
    // the record trigger was replaced by a schedule trigger
    expect(saved.triggerId).not.toBe(flow.triggerId);
    expect(await h.s.db('app_triggers').where({ id: flow.triggerId }).first()).toBeUndefined();
    expect(await h.s.db('app_triggers').where({ id: saved.triggerId }).first()).toMatchObject({ kind: 'schedule', cron: '0 6 * * 1' });
    expect((await audits('app.flow.updated'))[0]!.detail).toContain('"overwrote":true');

    // back to a record flow, then a dry run on a record changes nothing
    await d.put(`/api/apps/crm/flows/${flow.id}`, { ...bigDeals, match: null }).expect(400); // the name is fixed
    const { name: _x, ...again } = { ...bigDeals, match: null };
    await d.put(`/api/apps/crm/flows/${flow.id}`, again).expect(200);
    const rec = await record(m, { title: 'Oscar', amount: 1 });
    await drain(h);
    await d.patch(`/api/apps/crm/flows/${flow.id}`, { enabled: false }).expect(200);
    const rec2 = await record(m, { title: 'Papa', amount: 1 });
    await drain(h);
    expect((await read(m, rec2.id)).values.notes).toBeUndefined();
    expect((await read(m, rec.id)).values.notes).toBe('big: Oscar');
    await d.post(`/api/apps/crm/flows/${flow.id}/test`, {}).expect(400);
    const test = (await d.post(`/api/apps/crm/flows/${flow.id}/test`, { record: rec2.id }).expect(202)).body;
    expect(test.mode).toBe('dry');
    await drain(h);
    expect((await read(m, rec2.id)).values.notes).toBeUndefined();
    expect((await h.s.db('workflow_runs').where({ id: test.run }).first()).state).toBe('succeeded');
    expect((await audits('app.flow.tested')).length).toBe(1);

    await d.del(`/api/apps/crm/flows/${flow.id}`).expect(204);
    expect(await h.s.db('workflows').where({ id: flow.workflowId }).first()).toBeUndefined();
    expect(await h.s.db('app_triggers').where({ workflow_id: flow.workflowId })).toHaveLength(0);
    expect(await h.s.db('app_flows')).toHaveLength(0);
    expect((await audits('app.flow.deleted')).length).toBe(1);
    await d.get(`/api/apps/crm/flows/${flow.id}`).expect(404);
  });

  it('a manual flow has no trigger; deleting the app deletes its flows', async () => {
    const d = await designer();
    await setup(d);
    const flow = (await d.post('/api/apps/crm/flows', { name: 'by_hand', entity: 'deal', trigger: { kind: 'manual' }, actions: [{ type: 'wait', minutes: 5 }] }).expect(201)).body;
    expect(flow.triggerId).toBeNull();
    expect(flow.graph.nodes[0]).toMatchObject({ kind: 'trigger', config: { source: 'manual' } });
    await d.del('/api/apps/crm').expect(204);
    expect(await h.s.db('app_flows')).toHaveLength(0);
  });

  it('drafts a flow from a description, validated and never saved', async () => {
    const ollama = await new FakeOllama().start();
    try {
      await seedGateway(h, ollama);
      const d = await designer();
      await setup(d);
      ollama.reply = () => ({ content: JSON.stringify({ name: 'won_deals', entity: 'deal', trigger: { kind: 'record', events: ['updated'] }, match: { field: 'stage', op: 'eq', value: 'Won' }, actions: [{ type: 'transition', to: 'review' }] }) });
      const ok = (await d.post('/api/apps/crm/flows/draft', { prompt: 'Move won deals to review', profile: 'general' }).expect(200)).body;
      expect(ok).toMatchObject({ valid: true, problems: [], draft: { name: 'won_deals', actions: [{ type: 'transition', to: 'review' }] } });
      ollama.reply = () => ({ content: JSON.stringify({ name: 'x', entity: 'deal', trigger: { kind: 'manual' }, actions: [{ type: 'transition', to: 'gone' }] }) });
      const bad = (await d.post('/api/apps/crm/flows/draft', { prompt: 'Something odd', profile: 'general' }).expect(200)).body;
      expect(bad.valid).toBe(false);
      expect(bad.problems.join(' ')).toMatch(/gone is not a state/);
      expect(await h.s.db('app_flows')).toHaveLength(0);
      expect((await audits('app.flow.drafted')).length).toBe(2);
    } finally {
      await ollama.stop();
    }
  });
});
