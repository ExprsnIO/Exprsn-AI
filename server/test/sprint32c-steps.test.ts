import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPrincipal } from '../src/http/middleware.js';
import { BUILTIN_TOOLS } from '../src/registry/builtin/index.js';
import { verifyEd25519 } from '../src/webhooks/service.js';
import { validateGraph, type WfGraph } from '../src/workflows/graph.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';
import { FakeReceiver } from './sprint13-fakes.js';
import { ScriptedSession } from './sprint25d-fakes.js';

/*
 * Sprint 32c, Workflows 2 steps (B-3904, B-3907, B-3908). The "done when" of each item is a test below:
 *   B-3904 a workflow posts to a workspace feed under its label and the post carries the run as its source;
 *   B-3907 an approver's answers reach the next step and are audited with the decision;
 *   B-3908 a webhook step is refused at save for a host outside the tenant's list.
 */

const send = (c: Client, method: 'post' | 'put' | 'patch' | 'delete', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);
const TEXT = { type: 'object' as const, properties: { text: { type: 'string' as const } }, required: ['text'] };
const audits = async (h: Harness, action: string) => (await h.s.db('audit_events').where({ action }).orderBy('seq')) as { target: string; detail: string | null; label: string; actor: string }[];

async function drain(h: Harness, rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 5));
    if (!(await h.s.jobs.runDue())) return;
  }
}

function graph(nodes: WfGraph['nodes'], edges: [string, string][]): WfGraph {
  return { nodes: [{ id: 'trigger', kind: 'trigger', title: 'Trigger: manual', x: 20, y: 24, config: { source: 'manual' }, output: TEXT }, ...nodes], edges: edges.map(([from, to]) => ({ from, to })), limits: {} };
}

describe('Sprint 32c graph validation', () => {
  const env = { label: 'internal' as const, profile: () => undefined };

  it('knows the notify and webhook kinds, their ports, and an approval form on the output', () => {
    const g = graph(
      [
        { id: 'ask', kind: 'approval', title: 'Ask', x: 0, y: 0, config: { role: 'workflow-admin', form: { app: 'crm', form: 'review' } } },
        { id: 'tell', kind: 'notify', title: 'Tell', x: 0, y: 0, config: { users: ['{{input.text}}'], roles: ['workflow-admin'], title: 'Reviewed: {{steps.ask.answers.verdict}}' } },
        { id: 'hook', kind: 'webhook', title: 'Hook', x: 0, y: 0, config: { url: 'https://hooks.example.org/in', event: 'workflow.reviewed', body: { verdict: '{{steps.ask.answers.verdict}}' } }, input: { type: 'object', properties: { notified: { type: 'integer' } }, required: ['notified'] } }
      ],
      [['trigger', 'ask'], ['ask', 'tell'], ['tell', 'hook']]
    );
    const v = validateGraph(g, env);
    expect(v.errors).toEqual([]);
    expect(v.warnings.map((w) => w.nodeId)).toContain('hook');

    const bad = graph(
      [
        { id: 'tell', kind: 'notify', title: 'Tell', x: 0, y: 0, config: { title: 'x' } },
        { id: 'tell2', kind: 'notify', title: 'Tell 2', x: 0, y: 0, config: { roles: ['nobody'], title: 'x' } },
        { id: 'hook', kind: 'webhook', title: 'Hook', x: 0, y: 0, config: { url: 'https://hooks.example.org/{{input.text}}' } },
        { id: 'hook2', kind: 'webhook', title: 'Hook 2', x: 0, y: 0, config: { url: 'ftp://hooks.example.org/x' } },
        { id: 'hook3', kind: 'webhook', title: 'Hook 3', x: 0, y: 0, config: { url: 'https://hooks.example.org/x', event: 'flag.created' } }
      ],
      [['trigger', 'tell'], ['trigger', 'tell2'], ['trigger', 'hook'], ['trigger', 'hook2'], ['trigger', 'hook3']]
    );
    const msgs = validateGraph(bad, env).errors.map((e) => `${e.code}:${e.nodeId}:${e.message}`);
    expect(msgs).toEqual(
      expect.arrayContaining([
        'config:tell:Tell: Name at least one recipient: users or roles',
        'config:tell2:Tell 2: there is no role nobody.',
        'config:hook:Hook: the URL is fixed (the endpoint is registered once); put run data in the body.',
        'config:hook2:Hook 2: the URL must be http:// or https://.',
        expect.stringMatching(/^config:hook3:Hook 3: event: An event type under workflow\./)
      ])
    );
  });
});

describe('Sprint 32c steps', () => {
  let h: Harness;
  let ws: string;
  let admin: Client;
  let approver: Client;
  let rx: FakeReceiver;

  beforeEach(async () => {
    h = await harness({ WEBHOOK_RETRY_BASE_MS: '10', PLUGINS_REQUIRE_SIGNED: 'none' });
    ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Finance Ops', 'confidential')).id;
    const a = await localUser(h, 'wadmin', ['workflow-admin', 'member'], 'confidential');
    const b = await localUser(h, 'wadmin2', ['workflow-admin', 'member'], 'confidential');
    for (const u of [a, b]) await h.s.tenants.addMember(ws, u.id);
    admin = await loginAdmin(h, 'wadmin');
    approver = await loginAdmin(h, 'wadmin2');
    for (const c of [admin, approver]) await send(c, 'put', '/api/me/workspace', { workspaceId: ws }).expect(200);
    rx = await new FakeReceiver().start();
  });
  afterEach(async () => {
    await h.close();
    await rx.stop();
  });

  async function publish(name: string, g: WfGraph, label = 'internal') {
    const w = (await send(admin, 'post', '/api/workflows', { name, label }).expect(201)).body;
    await send(admin, 'put', `/api/workflows/${w.id}/draft`, { graph: g }).expect(200);
    await send(admin, 'post', `/api/workflows/${w.id}/publish`).expect(200);
    return w.id as string;
  }
  const runView = async (id: string) => (await admin.agent.get(`/api/workflow-runs/${id}`).expect(200)).body;
  const stepOf = (run: { steps: { nodeId: string }[] }, id: string) => run.steps.find((s) => s.nodeId === id) as unknown as Record<string, unknown> & { output: Record<string, unknown> };

  it('B-3904: a workflow posts to a workspace feed under its label and the post carries the run as its source', async () => {
    const g = graph(
      [
        { id: 'ok', kind: 'approval', title: 'Approve the post', x: 0, y: 0, config: { role: 'workflow-admin' } },
        { id: 'post', kind: 'tool', title: 'Post to the feed', x: 0, y: 0, config: { tool: 'feed.post', args: { body: 'Close is done: {{input.text}}' } } }
      ],
      [['trigger', 'ok'], ['ok', 'post']]
    );
    const id = await publish('close-notice', g, 'confidential');
    const run = (await send(admin, 'post', `/api/workflows/${id}/runs`, { input: { text: 'September #close' } }).expect(202)).body;
    await drain(h);
    const [a] = (await approver.agent.get('/api/workflow-approvals').expect(200)).body;
    await send(approver, 'post', `/api/workflow-approvals/${a.id}`, { decision: 'approve' }).expect(200);
    await drain(h);
    const v = await runView(run.id);
    expect(v.state).toBe('succeeded');
    const out = stepOf(v, 'post').output;
    expect(out).toMatchObject({ state: 'published', label: 'confidential', workspace: ws });

    const post = (await admin.agent.get(`/api/feed/posts/${String(out.post)}`).expect(200)).body;
    expect(post).toMatchObject({ body: 'Close is done: September #close', label: 'confidential', workspaceId: ws, source: { kind: 'workflow-run', id: run.id }, tags: ['close'] });
    const [created] = await audits(h, 'feed.post.created');
    expect(JSON.parse(created!.detail!)).toMatchObject({ source: { kind: 'workflow-run', id: run.id } });
    expect(created!.label).toBe('confidential');
    expect(await audits(h, 'workflow.tool.called')).toHaveLength(1);
  });

  it('B-3904: the built-ins act as the caller through the domain rules, and refuse data above where it would go', async () => {
    const bob = await localUser(h, 'bob', ['member'], 'internal');
    await h.s.tenants.addMember(ws, bob.id);
    const alice = (await h.s.users.byUsername(h.tenantId, 'wadmin'))!;
    const p = (await loadPrincipal(h.s, h.tenantId, alice.id, {}))!;
    p.workspaceId = ws;
    const call = async (name: string, args: Record<string, unknown>, label: 'internal' | 'confidential' = 'internal') => {
      const { tools } = await h.s.tools.resolve(p, [name], label);
      return h.s.tools.call({ principal: p, label, approved: true, source: { kind: 'agent-run', id: 'R1' } }, tools[0]!, args);
    };

    const m = await call('messages.send', { user: bob.id, body: 'The ledger is closed.' });
    expect(m).toMatchObject({ ok: true, result: { conversation: expect.any(String), message: expect.any(String) } });
    expect(await h.s.db('dm_messages').where({ id: (m.result as { message: string }).message }).first('author_id')).toEqual({ author_id: alice.id });
    // the direct conversation is internal: confidential data does not go into it
    const high = await call('messages.send', { conversation: (m.result as { conversation: string }).conversation, body: 'secret' }, 'confidential');
    expect(high).toMatchObject({ ok: false, error: expect.stringMatching(/^Blocked by label ceiling: the conversation is internal/) });
    expect(await call('messages.send', { body: 'nobody' })).toMatchObject({ ok: false, error: 'Name either a conversation or a person (user), not both.' });

    const group = await h.s.groups.create({ p, ip: null }, { workspaceId: ws, name: 'Close team', visibility: 'public', joinMode: 'open', label: 'internal' });
    const e = await call('groups.create_event', { group: group.id, title: 'Close review', start: '2026-11-03T10:00', timeZone: 'Europe/Berlin', durationMinutes: 30 });
    expect(e).toMatchObject({ ok: true, result: { group: group.id, startsAt: '2026-11-03T09:00:00.000Z', label: 'internal' } });
    expect(await audits(h, 'group.event.created')).toHaveLength(1);

    const up = (await admin.agent.put(`/api/files/uploads?${new URLSearchParams({ name: 'close.md', workspace: ws }).toString()}`).set('x-csrf-token', admin.csrf).set('content-type', 'application/octet-stream').send(Buffer.from('# v1')).expect(202)).body;
    const fileId = String(up.file?.id ?? up.id);
    const f = await call('files.write_version', { file: fileId, content: '# v2', type: 'text/markdown' });
    expect(f).toMatchObject({ ok: true, result: { file: fileId, version: 2 } });

    // channels.answer needs channels:review, which a workflow admin does not hold
    expect(await call('channels.answer', { channel: '01ARZ3NDEKTSV4RRFFQ69G5FAV', session: '01ARZ3NDEKTSV4RRFFQ69G5FAV', text: 'Hello' })).toMatchObject({ ok: false, error: expect.stringMatching(/may not do this: No role held grants channels:review/) });
    // arguments are checked against the input schema before anything runs
    expect(await call('feed.post', { body: 'x', extra: true })).toMatchObject({ ok: false, error: expect.stringMatching(/input schema/) });
  });

  it('B-3904: the registry harness holds a writing built-in instead of acting on live data', async () => {
    await localUser(h, 'tadmin', ['tool-admin'], 'confidential');
    const t = await loginAdmin(h, 'tadmin');
    const entry = BUILTIN_TOOLS.find((b) => b.name === 'feed.post')!;
    const r = (await send(t, 'post', `/api/admin/registry/${entry.id}/test`, { arguments: { body: 'from the harness' } }).expect(200)).body;
    expect(r).toMatchObject({ ok: false, needsApproval: true, sandboxed: false });
    expect(await h.s.db('feed_posts').count({ n: '*' }).first()).toMatchObject({ n: 0 });
  });

  it("B-3904: the broker's records, files, groups and posts calls are live and act as the installer", async () => {
    const ta = await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    await h.s.tenants.addMember(ws, ta.id);
    const tac = await loginAdmin(h, 'ta');
    await send(tac, 'put', '/api/me/workspace', { workspaceId: ws }).expect(200);
    await send(tac, 'post', '/api/apps', { name: 'crm', label: 'internal', workspaceId: ws }).expect(201);
    await send(tac, 'post', '/api/apps/crm/entities', { name: 'lead', definition: { fields: [{ name: 'email', type: 'string', required: true, maxLength: 200 }] } }).expect(201);
    const up = (await tac.agent.put(`/api/files/uploads?${new URLSearchParams({ name: 'notes.txt', workspace: ws }).toString()}`).set('x-csrf-token', tac.csrf).set('content-type', 'application/octet-stream').send(Buffer.from('plain notes')).expect(202)).body;
    const fileId = String(up.file?.id ?? up.id);
    await drain(h); // the scan releases the file from quarantine
    const p = (await loadPrincipal(h.s, h.tenantId, ta.id, {}))!;
    const group = await h.s.groups.create({ p, ip: null }, { workspaceId: ws, name: 'Leads', visibility: 'public', joinMode: 'open' });

    const runner = new ScriptedSession();
    h.s.scripts.runner = runner;
    const got: Record<string, { status: number; body?: unknown; detail?: string }> = {};
    runner.play = async (_hello, call) => {
      got.write = await call('records.write', { app: 'crm', entity: 'lead', values: { email: 'a@x.test' } });
      got.read = await call('records.read', { app: 'crm', entity: 'lead', id: (got.write.body as { id: string }).id });
      got.file = await call('files.read', { file: fileId });
      got.group = await call('groups.read', { group: group.id, events: true });
      got.post = await call('posts.write', { workspace: ws, body: 'From the plugin' });
      got.bad = await call('records.write', { app: 'crm' });
      return null;
    };
    const manifest = { key: 'lead-bot', name: 'Lead bot', version: '1.0.0', kind: 'script', events: ['flag.created'], capabilities: ['read:events', 'read:records', 'write:records', 'read:files', 'read:groups', 'write:posts'], script: { entry: 'main', source: 'export function main() {}' } };
    const pl = (await send(tac, 'post', '/api/admin/plugins', { manifest, grants: manifest.capabilities }).expect(201)).body;
    await send(tac, 'post', `/api/admin/plugins/${pl.id}/enable`).expect(200);
    await h.s.guard.flags.create({ tenantId: h.tenantId, workspaceId: null, kind: 'report', checkpoint: 'user-input', ruleName: 'Test rule', severity: 'low', label: 'internal', note: 'x' });
    await drain(h);

    expect(got.write).toMatchObject({ status: 200, body: { id: expect.any(String), label: 'internal' } });
    expect(got.read).toMatchObject({ status: 200, body: { record: { values: { email: 'a@x.test' } } } });
    expect(got.file).toMatchObject({ status: 200, body: { name: 'notes.txt', text: 'plain notes', truncated: false } });
    expect(got.group).toMatchObject({ status: 200, body: { group: { id: group.id }, events: expect.anything() } });
    expect(got.post).toMatchObject({ status: 200, body: { state: 'published', workspace: ws } });
    expect(got.bad?.status).toBe(400);
    const rec = await h.s.db('app_records').first('source', 'created_by');
    expect(rec).toEqual({ source: 'plugin', created_by: ta.id });
    const post = await h.s.db('feed_posts').first('author_id', 'source_kind', 'source_id');
    expect(post).toEqual({ author_id: ta.id, source_kind: 'plugin', source_id: pl.id });

    // the calls act as the installer: once that user is gone, the plugin's grant is not enough
    await h.s.db('users').where({ id: ta.id }).update({ state: 'disabled' });
    got.write = { status: 0 };
    runner.play = async (_hello, call) => {
      got.write = await call('posts.write', { workspace: ws, body: 'again' });
      return null;
    };
    await h.s.guard.flags.create({ tenantId: h.tenantId, workspaceId: null, kind: 'report', checkpoint: 'user-input', ruleName: 'Test rule', severity: 'low', label: 'internal', note: 'y' });
    await drain(h);
    expect(got.write).toMatchObject({ status: 403, detail: expect.stringMatching(/no longer active/) });
  });

  it('B-3907: an approver answers a form, the answers reach the next step and are audited with the decision', async () => {
    const d = admin;
    await send(d, 'post', '/api/apps', { name: 'vendors', label: 'confidential', workspaceId: ws }).expect(201);
    await send(d, 'post', '/api/apps/vendors/entities', { name: 'review', definition: { fields: [{ name: 'verdict', type: 'enum', required: true, options: [{ value: 'accept' }, { value: 'decline' }] }, { name: 'note', type: 'string', maxLength: 500 }, { name: 'reason', type: 'string', maxLength: 500 }] } }).expect(201);
    await send(d, 'post', '/api/apps/vendors/forms', { name: 'decision', entity: 'review', definition: { fields: [{ field: 'verdict' }, { field: 'note' }, { field: 'reason', required: true, visibleIf: { field: 'verdict', op: 'eq', value: 'decline' } }] } }).expect(201);

    // a form that does not exist is refused at save
    const w0 = (await send(admin, 'post', '/api/workflows', { name: 'no-form', label: 'internal' }).expect(201)).body;
    const missing = graph([{ id: 'ask', kind: 'approval', title: 'Ask', x: 0, y: 0, config: { role: 'workflow-admin', form: { app: 'vendors', form: 'nothing' } } }], [['trigger', 'ask']]);
    const refused = await send(admin, 'put', `/api/workflows/${w0.id}/draft`, { graph: missing }).expect(422);
    expect(refused.body.errors).toEqual([expect.objectContaining({ code: 'reference', nodeId: 'ask' })]);

    const g = graph(
      [
        { id: 'ask', kind: 'approval', title: 'Vendor decision', x: 0, y: 0, config: { role: 'workflow-admin', show: '{{input.text}}', form: { app: 'vendors', form: 'decision' } } },
        { id: 'shape', kind: 'transform', title: 'Shape', x: 0, y: 0, config: { fields: { verdict: '{{steps.ask.answers.verdict}}', why: '{{steps.ask.answers.reason}}', by: '{{steps.ask.by}}' } } }
      ],
      [['trigger', 'ask'], ['ask', 'shape']]
    );
    const id = await publish('vendor-decision', g);
    const run = (await send(admin, 'post', `/api/workflows/${id}/runs`, { input: { text: 'Northwind Ltd' } }).expect(202)).body;
    await drain(h);
    const [a] = (await approver.agent.get('/api/workflow-approvals').expect(200)).body;
    expect(a.form).toMatchObject({ app: 'vendors', form: 'decision', fields: [expect.objectContaining({ name: 'verdict', type: 'enum', required: true }), expect.objectContaining({ name: 'note' }), expect.objectContaining({ name: 'reason', visibleIf: { field: 'verdict', op: 'eq', value: 'decline' } })] });

    // validated like a submission: a required field shown by a condition, an option not on the list
    await send(approver, 'post', `/api/workflow-approvals/${a.id}`, { decision: 'approve', answers: { verdict: 'decline' } }).expect(400);
    await send(approver, 'post', `/api/workflow-approvals/${a.id}`, { decision: 'approve', answers: { verdict: 'maybe' } }).expect(400);
    await send(approver, 'post', `/api/workflow-approvals/${a.id}`, { decision: 'approve' }).expect(400);
    const ok = (await send(approver, 'post', `/api/workflow-approvals/${a.id}`, { decision: 'approve', answers: { verdict: 'decline', reason: 'No audit report', extra: 'dropped' } }).expect(200)).body;
    expect(ok).toMatchObject({ state: 'approved', answers: { verdict: 'decline', reason: 'No audit report' } });
    expect(ok.answers.extra).toBeUndefined();
    await drain(h);

    const v = await runView(run.id);
    expect(v.state).toBe('succeeded');
    expect(stepOf(v, 'ask').output).toMatchObject({ approved: true, by: 'WADMIN2', answers: { verdict: 'decline', reason: 'No audit report' } });
    expect(stepOf(v, 'shape').output).toEqual({ verdict: 'decline', why: 'No audit report', by: 'WADMIN2' });
    expect(v.approvals[0]).toMatchObject({ state: 'approved', answers: { verdict: 'decline', reason: 'No audit report' } });
    const [audit] = await audits(h, 'workflow.approval.approved');
    expect(JSON.parse(audit!.detail!)).toMatchObject({ answers: { verdict: 'decline', reason: 'No audit report' } });
    // nothing was written to the app: an approval form records no submission
    expect(await h.s.db('app_records').count({ n: '*' }).first()).toMatchObject({ n: 0 });

    // answers on an approval without a form are refused
    const plain = await publish('plain', graph([{ id: 'ask', kind: 'approval', title: 'Ask', x: 0, y: 0, config: { role: 'workflow-admin' } }], [['trigger', 'ask']]));
    await send(admin, 'post', `/api/workflows/${plain}/runs`, { input: { text: 'x' } }).expect(202);
    await drain(h);
    const [b] = (await approver.agent.get('/api/workflow-approvals').expect(200)).body;
    await send(approver, 'post', `/api/workflow-approvals/${b.id}`, { decision: 'approve', answers: { verdict: 'accept' } }).expect(400);
  });

  it("B-3908: a webhook step is refused at save for a host outside the tenant's list", async () => {
    await h.s.integrations.set(h.tenantId, { allowedHosts: ['hooks.example.org'] }, 'test');
    const w = (await send(admin, 'post', '/api/workflows', { name: 'hooked', label: 'internal' }).expect(201)).body;
    const g = graph([{ id: 'hook', kind: 'webhook', title: 'Tell the ERP', x: 0, y: 0, config: { url: `${rx.url}/in` } }], [['trigger', 'hook']]);
    const r = await send(admin, 'put', `/api/workflows/${w.id}/draft`, { graph: g }).expect(422);
    expect(r.body.errors).toEqual([expect.objectContaining({ code: 'config', nodeId: 'hook', message: expect.stringMatching(/^Tell the ERP: the endpoint is refused by the outbound host rules: 127\.0\.0\.1 is not on this tenant's list of allowed hosts\./) })]);
    expect((await admin.agent.get(`/api/workflows/${w.id}`).expect(200)).body.draftRev).toBe(1); // nothing saved
    // creating with it is refused too
    await send(admin, 'post', '/api/workflows', { name: 'hooked-2', label: 'internal', graph: g }).expect(422);
  });

  it('B-3908: a webhook step delivers one signed delivery through the webhook path; a dry run sends nothing', async () => {
    const g = graph([{ id: 'hook', kind: 'webhook', title: 'Tell the ERP', x: 0, y: 0, config: { url: `${rx.url}/in`, event: 'workflow.close.done', body: { period: '{{input.text}}' } } }], [['trigger', 'hook']]);
    const id = await publish('hooked', g);
    const dry = (await send(admin, 'post', `/api/workflows/${id}/dry-run`, { input: { text: 'x' } }).expect(202)).body;
    await drain(h);
    expect(stepOf(await runView(dry.id), 'hook')).toMatchObject({ state: 'passed', detail: { mocked: true } });
    expect(rx.got).toHaveLength(0);

    const run = (await send(admin, 'post', `/api/workflows/${id}/runs`, { input: { text: '2026-09' } }).expect(202)).body;
    await drain(h);
    const v = await runView(run.id);
    expect(v.state).toBe('succeeded');
    expect(stepOf(v, 'hook').output).toMatchObject({ webhook: expect.any(String), delivery: expect.any(String), event: 'workflow.close.done' });
    expect(rx.got).toHaveLength(1);
    const body = JSON.parse(rx.got[0]!.body);
    expect(body).toMatchObject({ type: 'workflow.close.done', tenant: h.tenantId, label: 'internal', data: { workflow: id, run: run.id, step: 'hook', data: { period: '2026-09' } } });
    const slug = (await h.s.tenants.byId(h.tenantId))!.slug;
    const jwks = (await request(h.app).get(`/webhooks/keys/${slug}`).expect(200)).body;
    const key = jwks.keys.find((k: { kid: string }) => k.kid === rx.got[0]!.headers['x-exprsn-key-id']);
    expect(verifyEd25519(key.x, String(rx.got[0]!.headers['x-exprsn-timestamp']), String(rx.got[0]!.headers['x-exprsn-signature-ed25519']), rx.got[0]!.body)).toBe(true);
    const [a] = await audits(h, 'workflow.step.webhook');
    expect(JSON.parse(a!.detail!)).toMatchObject({ event: 'workflow.close.done', host: new URL(rx.url).host });

    // the hook is the workflow's; deleting the workflow removes it
    const hooks = (await h.s.db('webhooks').where({ tenant_id: h.tenantId }).select('name')) as { name: string }[];
    expect(hooks.map((x) => x.name)).toEqual([expect.stringMatching(new RegExp(`^workflow:${id}:[0-9a-f]{8}$`))]);
    await send(admin, 'delete', `/api/workflows/${id}`).expect(204);
    expect(await h.s.db('webhooks').where({ tenant_id: h.tenantId }).count({ n: '*' }).first()).toMatchObject({ n: 0 });
  });

  it('B-3908: a notify step tells the cleared recipients and skips the rest', async () => {
    const low = await localUser(h, 'low', ['member'], 'internal');
    const outside = await localUser(h, 'outside', ['member'], 'confidential');
    const reader = await localUser(h, 'reader', ['member'], 'confidential');
    await h.s.tenants.addMember(ws, low.id);
    await h.s.tenants.addMember(ws, reader.id);
    void outside; // not in the workspace
    const g = graph([{ id: 'tell', kind: 'notify', title: 'Tell', x: 0, y: 0, config: { users: ['reader', 'low', 'outside', 'ghost'], roles: ['workflow-admin'], title: 'Closed: {{input.text}}', body: 'Run done.' } }], [['trigger', 'tell']]);
    const id = await publish('tell', g, 'confidential');
    const run = (await send(admin, 'post', `/api/workflows/${id}/runs`, { input: { text: 'September' } }).expect(202)).body;
    await drain(h);
    const v = await runView(run.id);
    expect(v.state).toBe('succeeded');
    // reader, wadmin and wadmin2 are told; low (clearance), outside (not a member) and ghost (unknown) are skipped
    expect(stepOf(v, 'tell').output).toEqual({ notified: 3, skipped: 3 });
    const rows = (await h.s.db('notifications').where({ kind: 'workflow' }).select('user_id', 'title', 'label')) as { user_id: string; title: string; label: string }[];
    const ids = new Set(rows.filter((r) => r.title === 'Closed: September').map((r) => r.user_id));
    expect(ids.has(reader.id)).toBe(true);
    expect(ids.has(low.id)).toBe(false);
    expect(ids.has(outside.id)).toBe(false);
    expect(rows.every((r) => r.label === 'confidential')).toBe(true);
    expect(await audits(h, 'workflow.step.notified')).toHaveLength(1);
  });

  it('marks notify and webhook steps as writes when a workflow is offered as a tool', async () => {
    const g: WfGraph = graph([{ id: 'tell', kind: 'notify', title: 'Tell', x: 0, y: 0, config: { roles: ['workflow-admin'], title: 'x' } }], [['trigger', 'tell']]);
    const id = await publish('tell-tool', g);
    const r = await send(admin, 'post', `/api/workflows/${id}/tool`, { name: 'workflow.tell', version: '1.0.0', sideEffect: 'read' });
    expect(r.status).toBe(409);
    expect(r.body.detail).toMatch(/Tell makes tell-tool write/);
  });
});

void login;
