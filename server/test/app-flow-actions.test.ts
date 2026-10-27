import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileFlow, flowInputSchema, flowProblems, type FlowInput } from '../src/apps/flows.js';
import type { AppRow, EntityRow } from '../src/apps/service.js';
import { entityDefinitionSchema } from '../src/apps/schema.js';
import { loadPrincipal } from '../src/http/middleware.js';
import type { HttpStepNet } from '../src/workflows/http.js';
import { FakeOllama } from './fake-ollama.js';
import { FakeRunner } from './fake-runner.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';
import { drain } from './retrieval-seed.js';
import { seedGateway } from './seed-gateway.js';

/*
 * App flows integrated with the environment (migration 082_app_flow_integration): the integration actions compile
 * onto the existing workflow steps (tool through the dispatcher, script in the sandbox, agent, model, records in
 * another entity, HTTP to allowed hosts) and each action's output feeds the later ones.
 */

const dealDefinition = {
  fields: [
    { name: 'title', type: 'string', required: true, indexed: true, maxLength: 120 },
    { name: 'amount', type: 'number', indexed: true, min: 0 },
    { name: 'notes', type: 'string', multiline: true, maxLength: 5000 }
  ]
};
const taskDefinition = {
  fields: [
    { name: 'title', type: 'string', required: true, maxLength: 200 },
    { name: 'deal', type: 'string', maxLength: 26 }
  ],
  states: { initial: 'todo', states: [{ name: 'todo' }, { name: 'done' }], transitions: [{ from: ['todo'], to: 'done' }] }
};

describe('flow integration actions: model and compiler', () => {
  const app = { id: 'A'.repeat(26), name: 'crm', title: 'CRM', label: 'internal' } as AppRow;
  const deal = { id: 'E'.repeat(26), name: 'deal', label: 'internal', definition: entityDefinitionSchema.parse(dealDefinition) } as EntityRow;
  const flow = (actions: unknown[], trigger: unknown = { kind: 'record', events: ['created'] }): FlowInput => flowInputSchema.parse({ name: 'f', entity: 'deal', trigger, actions });

  it('compiles each action onto its step kind, with outputs readable by later actions', () => {
    const g = compileFlow(
      app,
      flow([
        { type: 'tool', tool: 'calculate', args: { expression: '{{input.record.values.amount}} * 2' } },
        { type: 'script', script: 'sum.py', version: 1, args: { values: '{{input.record.values.amount}}' } },
        { type: 'agent', agent: 'Summariser', input: 'Summarise {{steps.act1.decimal}}' },
        { type: 'ai', profile: 'general', prompt: 'Say {{steps.act3.text}}', format: 'text' },
        { type: 'approval', role: 'workflow-admin' },
        { type: 'message', user: '{{input.record.values.notes}}', body: 'Done: {{steps.act4.text}}' },
        { type: 'http', method: 'POST', url: 'https://api.partner.example/hook', headers: { Authorization: 'Bearer vault:apps/partner#token' }, body: '{"t":"{{steps.act4.text}}"}' }
      ])
    );
    const kind = (id: string) => g.nodes.find((n) => n.id === id)!;
    expect(kind('act1')).toMatchObject({ kind: 'tool', config: { tool: 'calculate', args: { expression: '{{input.record.values.amount}} * 2' } } });
    expect(kind('act2')).toMatchObject({ kind: 'script', config: { script: 'sum.py', version: 1 } });
    expect(kind('act3')).toMatchObject({ kind: 'agent', config: { agent: 'Summariser', input: 'Summarise {{steps.act1.decimal}}' } });
    expect(kind('act4')).toMatchObject({ kind: 'model', config: { profile: 'general', format: 'text' } });
    expect(kind('act6')).toMatchObject({ kind: 'tool', config: { tool: 'messages.send', args: { user: '{{input.record.values.notes}}', body: 'Done: {{steps.act4.text}}' } } });
    expect(kind('act7')).toMatchObject({ kind: 'http', config: { method: 'POST', url: 'https://api.partner.example/hook' } });
    expect(compileFlow(app, flow([{ type: 'wait', minutes: 1 }], { kind: 'webhook' })).nodes[0]).toMatchObject({ kind: 'trigger', config: { source: 'api' } });
  });

  it('refuses reads of later actions, literal secrets, URLs with credentials and templated hosts, and messages without one recipient', () => {
    const p = (actions: unknown[]) => flowProblems(flow(actions), [deal]).join('\n');
    expect(p([{ type: 'ai', profile: 'general', prompt: 'x {{steps.act2.text}}' }, { type: 'wait', minutes: 1 }])).toMatch(/reads action 2, which does not run before it/);
    expect(p([{ type: 'ai', profile: 'general', prompt: 'x {{steps.other.text}}' }])).toMatch(/not an action of this flow/);
    expect(p([{ type: 'http', url: 'https://api.partner.example/x', headers: { Authorization: 'Bearer abc123' } }])).toMatch(/Authorization takes a vault reference/);
    expect(p([{ type: 'http', url: 'https://api.partner.example/x', headers: { 'X-Api-Key': 'abc123' } }])).toMatch(/X-Api-Key carries a credential/);
    expect(p([{ type: 'http', url: 'https://api.partner.example/x?api_key=abc' }])).toMatch(/query parameter api_key carries a credential/);
    expect(p([{ type: 'http', url: 'https://user:pw@api.partner.example/x' }])).toMatch(/credentials in the URL/);
    expect(p([{ type: 'http', url: 'https://{{input.record.values.notes}}/x' }])).toMatch(/host cannot come from a template/);
    expect(p([{ type: 'message', body: 'hi' }])).toMatch(/one person \(user\) or into one conversation/);
    expect(p([{ type: 'approval', role: 'workflow-admin', onError: 'continue' }])).toMatch(/approval does not go on after a failure/);
    expect(p([{ type: 'http', url: 'https://api.partner.example/x', headers: { Authorization: 'Bearer vault:apps/partner#token' } }])).toBe('');
  });
});

/** "Public" hosts of the suite, served by the local receiver. */
const PUBLIC: Record<string, string> = { 'api.partner.example': '93.184.216.34' };

describe('flow integration actions: run with fakes', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let runner: FakeRunner;
  let receiver: Server;
  let port: number;
  let seen: { method: string; url: string; body: string }[] = [];
  let wsId: string;
  let d: Awaited<ReturnType<typeof designer>>;

  type W = Awaited<ReturnType<typeof wrap>>;
  async function wrap(c: Client, ws?: string) {
    const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
    if (ws) await send('put', '/api/me/workspace', { workspaceId: ws }).expect(200);
    return { ...c, post: (p: string, b?: object) => send('post', p, b), put: (p: string, b?: object) => send('put', p, b), get: (p: string) => c.agent.get(p) };
  }
  async function designer() {
    const u = await localUser(h, 'dee', ['workflow-admin', 'member'], 'confidential');
    await h.s.tenants.addMember(wsId, u.id);
    return { user: u, ...(await wrap(await loginAdmin(h, 'dee'), wsId)) };
  }
  async function publishEntry(t: W, t2: W, body: Record<string, unknown>) {
    const e = (await t.post('/api/admin/registry', body).expect(201)).body;
    await t.post(`/api/admin/registry/${e.id}/submit`).expect(200);
    await t2.post(`/api/admin/registry/${e.id}/review`, { decision: 'approve' }).expect(200);
  }

  beforeAll(async () => {
    receiver = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ accepted: true }));
      });
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    port = (receiver.address() as AddressInfo).port;
    const net: HttpStepNet = {
      resolve: async (host) => {
        if (PUBLIC[host]) return [{ address: PUBLIC[host], family: 4 }];
        throw new Error('ENOTFOUND');
      },
      dial: (address) => (Object.values(PUBLIC).includes(address) ? { address: '127.0.0.1', family: 4 } : null)
    };
    h = await harness({ OLLAMA_POLL_MS: '600000', WORKFLOW_HTTP_ALLOW_LOOPBACK: 'true' }, { workflowHttpNet: net });
    ollama = await new FakeOllama().start();
    ollama.chatDelayMs = 0;
    await seedGateway(h, ollama);
    runner = new FakeRunner();
    h.s.scripts.runner = runner;
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Sales', 'confidential')).id;
    d = await designer();
    await d.post('/api/apps', { name: 'crm', title: 'CRM', label: 'confidential', workspaceId: wsId }).expect(201);
    await d.post('/api/apps/crm/entities', { name: 'deal', title: 'Deal', label: 'internal', definition: dealDefinition }).expect(201);
    await d.post('/api/apps/crm/entities', { name: 'task', title: 'Task', label: 'internal', definition: taskDefinition }).expect(201);
  });
  afterAll(async () => {
    await new Promise((r) => receiver.close(r));
    await h.close();
    await ollama.stop();
  });

  let n = 0;
  /** Creates a record flow with these actions, then a deal; returns the deal after the run. */
  async function runFlow(actions: unknown[], values: Record<string, unknown> = {}) {
    const name = `flow_${++n}`;
    const flow = (await d.post('/api/apps/crm/flows', { name, entity: 'deal', trigger: { kind: 'record', events: ['created'] }, actions }).expect(201)).body;
    const rec = (await d.post('/api/apps/crm/entities/deal/records', { values: { title: `Deal ${n}`, amount: 500, ...values } }).expect(201)).body as { id: string };
    await drain(h);
    // Only this flow reacts to later deals.
    await d.agent.patch(`/api/apps/crm/flows/${flow.id}`).set('x-csrf-token', d.csrf).send({ enabled: false }).expect(200);
    const read = (await d.get(`/api/apps/crm/entities/deal/records/${rec.id}`).expect(200)).body as { values: Record<string, unknown> };
    const run = (await h.s.db('workflow_runs').where({ workflow_id: flow.workflowId }).first()) as { id: string; state: string; error: string | null };
    return { flow, rec: read, run };
  }

  it('runs a tool through the dispatcher and writes its output into the record', async () => {
    const { rec, run } = await runFlow([
      { type: 'tool', tool: 'calculate', args: { expression: '{{input.record.values.amount}} * 2' } },
      { type: 'update', values: { notes: 'double {{steps.act1.decimal}}' } }
    ]);
    expect(run.state).toBe('succeeded');
    expect(rec.values.notes).toBe('double 1000');
    expect(await h.s.db('workflow_steps').where({ run_id: run.id, node_id: 'act1' }).first()).toMatchObject({ state: 'passed' });
  });

  it('refuses a write tool or a message without an approval action before it, and an unknown tool', async () => {
    const msg = { type: 'message', user: '{{input.record.created_by}}', body: 'New deal {{input.record.values.title}}' };
    const refused = await d.post('/api/apps/crm/flows', { name: 'dm_refused', entity: 'deal', trigger: { kind: 'record', events: ['created'] }, actions: [msg] }).expect(400);
    expect(refused.body.problems.join(' ')).toMatch(/messages\.send is a write tool: put an approval action/);
    const conditional = await d.post('/api/apps/crm/flows', { name: 'dm_conditional', entity: 'deal', trigger: { kind: 'record', events: ['created'] }, actions: [{ type: 'approval', role: 'workflow-admin', when: { field: 'amount', op: 'gt', value: 10 } }, msg] }).expect(400);
    expect(conditional.body.problems.join(' ')).toMatch(/approval action/);
    const ok = (await d.post('/api/apps/crm/flows', { name: 'dm_ok', entity: 'deal', trigger: { kind: 'record', events: ['created'] }, enabled: false, actions: [{ type: 'approval', role: 'workflow-admin' }, msg] }).expect(201)).body;
    expect(ok.graph.nodes.find((x: { id: string }) => x.id === 'act2')).toMatchObject({ kind: 'tool', config: { tool: 'messages.send' } });
    const unknown = await d.post('/api/apps/crm/flows', { name: 'nope', entity: 'deal', trigger: { kind: 'manual' }, actions: [{ type: 'tool', tool: 'jira.create_issue', args: {} }] }).expect(400);
    expect(unknown.body.problems[0]).toMatch(/jira\.create_issue is not a tool published to this workspace/);
    // the palette lists what the pickers offer
    const pal = (await d.get('/api/apps/crm/flows/palette?entity=deal').expect(200)).body;
    expect(pal).toMatchObject({ label: 'internal', messaging: true, canRunScripts: true });
    expect(pal.tools.map((t: { name: string }) => t.name)).toContain('calculate');
    expect(pal.profiles.map((x: { name: string }) => x.name)).toEqual(['general']);
  });

  it('runs a tested script version in the sandbox and passes its JSON on', async () => {
    const pr = { ...(await loadPrincipal(h.s, h.tenantId, d.user.id, {}))!, workspaceId: wsId };
    const s = await h.s.scripts.create(pr, { name: 'score.py', language: 'python', source: 'import json,sys\nprint(json.dumps({"score": 7}))', label: 'internal', limits: { timeoutSeconds: 30, memoryMb: 256, cpus: 1, pids: 32, outputKb: 64 } });
    runner.handler = () => ({ stdout: '{"score": 7}' });
    await h.s.scripts.run(pr, s, '{}');
    await drain(h);
    runner.requests = [];
    const { rec, run } = await runFlow([
      { type: 'script', script: 'score.py', version: 1, args: { amount: '{{input.record.values.amount}}' } },
      { type: 'update', values: { notes: 'score {{steps.act1.score}}' } }
    ]);
    expect(run.state).toBe('succeeded');
    expect(rec.values.notes).toBe('score 7');
    expect(runner.requests).toHaveLength(1);
    expect(JSON.parse(runner.requests[0]!.stdin!)).toEqual({ amount: 500 });
    const missing = await d.post('/api/apps/crm/flows', { name: 'no_script', entity: 'deal', trigger: { kind: 'manual' }, actions: [{ type: 'script', script: 'gone.py' }] }).expect(400);
    expect(missing.body.problems[0]).toMatch(/script gone\.py is not a script/);
  });

  it('asks an agent and runs an AI step through the gateway, each answer used by the next action', async () => {
    await localUser(h, 'tadmin', ['tool-admin', 'agent-admin'], 'confidential');
    await localUser(h, 'tadmin2', ['tool-admin', 'agent-admin'], 'confidential');
    const t = await wrap(await loginAdmin(h, 'tadmin'));
    const t2 = await wrap(await loginAdmin(h, 'tadmin2'));
    await publishEntry(t, t2, { kind: 'agent', name: 'Summariser', version: '1.0.0', description: 'Summariser: answers with the tools it lists and reports the result plainly.', label: 'confidential', definition: { profile: 'general', systemPrompt: 'Summarise.', tools: [], budgets: { steps: 4, tokens: 5000, wallSeconds: 60, toolCalls: 0 } } });
    ollama.reply = (messages) => ({ content: `Answer to ${String(messages[messages.length - 1]!.content).slice(0, 40)}` });
    const { rec, run } = await runFlow([
      { type: 'agent', agent: 'Summariser', input: 'about {{input.record.values.title}}' },
      { type: 'ai', profile: 'general', prompt: 'echo {{steps.act1.text}}' },
      { type: 'update', values: { notes: '{{steps.act2.text}}' } }
    ]);
    expect(run.state).toBe('succeeded');
    expect(String(rec.values.notes)).toMatch(/^Answer to echo Answer to about Deal/);
    expect(await h.s.db('agent_runs').where({ agent_name: 'Summariser' }).first()).toBeTruthy();
    const badProfile = await d.post('/api/apps/crm/flows', { name: 'no_profile', entity: 'deal', trigger: { kind: 'manual' }, actions: [{ type: 'ai', profile: 'missing', prompt: 'x' }] }).expect(400);
    expect(badProfile.body.problems[0]).toMatch(/profile missing is not published/);
    const badAgent = await d.post('/api/apps/crm/flows', { name: 'no_agent', entity: 'deal', trigger: { kind: 'manual' }, actions: [{ type: 'agent', agent: 'Nobody', input: 'x' }] }).expect(400);
    expect(badAgent.body.problems[0]).toMatch(/agent Nobody is not published/);
  });

  it('creates, moves and updates a record of another entity of the app, by the id the first action returned', async () => {
    const { rec, run } = await runFlow([
      { type: 'create', entity: 'task', values: { title: 'Follow up {{input.record.values.title}}', deal: '{{input.record.id}}' } },
      { type: 'transition', entity: 'task', record: '{{steps.act1.id}}', to: 'done' },
      { type: 'update', entity: 'task', record: '{{steps.act1.id}}', values: { title: 'Closed {{steps.act1.values.title}}' } },
      { type: 'update', values: { notes: 'task {{steps.act1.id}}' } }
    ]);
    expect(run.state).toBe('succeeded');
    const taskId = String(rec.values.notes).replace('task ', '');
    const task = (await d.get(`/api/apps/crm/entities/task/records/${taskId}`).expect(200)).body;
    expect(task).toMatchObject({ state: 'done', values: { title: expect.stringMatching(/^Closed Follow up Deal/) } });
  });

  it('sends an HTTP request only to an allowed host, and refuses literal secrets', async () => {
    const http = { type: 'http', method: 'POST', url: `http://api.partner.example:${port}/deals`, headers: { 'Content-Type': 'application/json' }, body: '{"title":"{{input.record.values.title}}"}' };
    const notListed = await d.post('/api/apps/crm/flows', { name: 'http_unlisted', entity: 'deal', trigger: { kind: 'record', events: ['created'] }, actions: [http] }).expect(400);
    expect(notListed.body.problems[0]).toMatch(/api\.partner\.example is not on this tenant's list of allowed hosts/);
    await h.s.integrations.set(h.tenantId, { allowedHosts: ['api.partner.example'] }, 'test');
    const other = await d.post('/api/apps/crm/flows', { name: 'http_other', entity: 'deal', trigger: { kind: 'manual' }, actions: [{ ...http, url: 'https://elsewhere.example/x' }] }).expect(400);
    expect(other.body.problems[0]).toMatch(/elsewhere\.example is not on this tenant's list/);
    const literal = await d.post('/api/apps/crm/flows', { name: 'http_literal', entity: 'deal', trigger: { kind: 'manual' }, actions: [{ ...http, headers: { 'X-Api-Key': 'sk-live-1234567890' } }] }).expect(400);
    expect(literal.body.problems[0]).toMatch(/X-Api-Key carries a credential and takes a vault reference/);
    const bodySecret = await d.post('/api/apps/crm/flows', { name: 'http_body', entity: 'deal', trigger: { kind: 'manual' }, actions: [{ ...http, body: '{"password":"hunter2"}' }] }).expect(400);
    expect(bodySecret.body.problems[0]).toMatch(/body field password carries a credential/);
    seen = [];
    const { rec, run } = await runFlow([http, { type: 'update', values: { notes: 'sent {{steps.act1.status}} {{steps.act1.body.accepted}}' } }]);
    expect(run.state).toBe('succeeded');
    expect(rec.values.notes).toBe('sent 200 true');
    expect(seen).toEqual([expect.objectContaining({ method: 'POST', url: '/deals', body: expect.stringMatching(/"title":"Deal \d+"/) })]);
  });
});
