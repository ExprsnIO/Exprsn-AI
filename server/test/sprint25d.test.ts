import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPrincipal } from '../src/http/middleware.js';
import { keyFingerprint } from '../src/ops/bundles.js';
import { writeTar } from '../src/ops/tar.js';
import { render } from '../src/plugins/runtime.js';
import { UnavailableRunner } from '../src/scripts/runner.js';
import { verifyEd25519 } from '../src/webhooks/service.js';
import type { WfGraph } from '../src/workflows/graph.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';
import { FakeReceiver } from './sprint13-fakes.js';
import { ProcessRunner, ScriptedSession } from './sprint25d-fakes.js';

const send = (c: Client, method: 'post' | 'put' | 'patch' | 'delete', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Raises a flag as a guardrail would (outside any plugin), which emits `flag.created`. */
const raiseFlag = (h: Harness, note = 'original') => h.s.guard.flags.create({ tenantId: h.tenantId, workspaceId: null, kind: 'report', checkpoint: 'user-input', ruleName: 'Test rule', severity: 'low', label: 'internal', note });

/** Runs due jobs until none are left (invocations queue deliveries, which queue nothing more). */
async function drain(h: Harness, rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 5));
    if (!(await h.s.jobs.runDue())) {
      const due = await h.s.db('jobs').where({ state: 'queued' }).andWhere('run_at', '<=', Date.now() + 2000).count({ n: '*' }).first();
      if (!Number((due as { n: number }).n)) return;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

const invocations = (h: Harness, pluginId?: string) => h.s.db('plugin_invocations').modify((q) => void (pluginId ? q.where({ plugin_id: pluginId }) : q)).orderBy('created_at');
const auditActions = async (h: Harness, like: string) => ((await h.s.db('audit_events').where('action', 'like', like).orderBy('seq')) as { action: string; detail: string; actor: string }[]);

const declarative = (over: Record<string, unknown> = {}) => ({
  key: 'flag-relay',
  name: 'Flag relay',
  version: '1.0.0',
  kind: 'declarative',
  events: ['flag.*'],
  capabilities: ['read:events', 'emit:log', 'emit:audit', 'emit:notification', 'emit:flag', 'call:webhook'],
  optionalCapabilities: ['emit:flag'],
  actions: [
    { type: 'log', on: 'flag.created', with: { message: 'Flag {{event.data.flag}} at {{event.data.checkpoint}}' } },
    { type: 'audit', on: 'flag.created', with: { message: 'relayed {{event.data.flag}}' } },
    { type: 'notify', on: 'flag.created', with: { title: 'New flag {{event.data.flag}}', roles: ['tenant-admin'] } },
    { type: 'flag', on: 'flag.created', with: { reason: 'second look' } }
  ],
  ...over
});

// ---------- B-2003 ----------

describe('declarative plugin actions (B-2003)', () => {
  let h: Harness;
  let admin: Client;
  let rx: FakeReceiver;
  beforeEach(async () => {
    h = await harness({ WEBHOOK_RETRY_BASE_MS: '10' });
    await localUser(h, 'ta', ['tenant-admin', 'workflow-admin', 'member'], 'confidential');
    admin = await loginAdmin(h, 'ta');
    rx = await new FakeReceiver().start();
  });
  afterEach(async () => {
    await rx.stop();
    await h.close();
  });

  it('runs each action through its service, refuses and audits an action whose capability is not granted, and delivers webhooks signed', async () => {
    const m = declarative({ actions: [...declarative().actions, { type: 'webhook', on: 'flag.created', with: { url: `${rx.url}/plugin` } }] });
    const p = (await send(admin, 'post', '/api/admin/plugins', { manifest: m, grants: ['read:events', 'emit:log', 'emit:audit', 'emit:notification', 'call:webhook'] }).expect(201)).body;
    expect(p.missing).toEqual([]); // emit:flag is optional and not granted
    await send(admin, 'post', `/api/admin/plugins/${p.id}/enable`).expect(200);

    const f = await raiseFlag(h);
    await drain(h);

    const [inv] = (await admin.agent.get(`/api/admin/plugins/${p.id}/invocations`).expect(200)).body.invocations;
    expect(inv).toMatchObject({ event: 'flag.created', state: 'failed', chain: [], error: '1 of 5 actions failed or were refused' });
    expect(inv.outcome.actions.map((a: { type: string; ok: boolean }) => `${a.type}:${a.ok}`)).toEqual(['log:true', 'audit:true', 'notify:true', 'flag:false', 'webhook:true']);
    expect(inv.outcome.actions[3]).toMatchObject({ status: 403, error: expect.stringMatching(/not granted emit:flag/) });

    // the refusal is audited, attributed to the plugin
    const refused = await auditActions(h, 'plugin.action.refused');
    expect(refused).toHaveLength(1);
    expect(JSON.parse(refused[0]!.detail)).toMatchObject({ action: 'flag', capability: 'emit:flag', event: 'flag.created' });
    expect(JSON.parse(refused[0]!.actor)).toEqual({ service: 'plugin:flag-relay' });
    // no second flag was raised
    expect(await h.s.db('guard_flags').count({ n: '*' }).first()).toMatchObject({ n: 1 });

    // log (sealed at rest), audit, notification
    const logs = (await admin.agent.get(`/api/admin/plugins/${p.id}/logs`).expect(200)).body.logs;
    expect(logs[0]).toMatchObject({ level: 'info', message: `Flag F-${f.number} at user-input`, invocationId: inv.id });
    expect((await h.s.db('plugin_logs').first()).message_sealed).not.toContain('user-input');
    const audited = await auditActions(h, 'plugin.audited');
    expect(JSON.parse(audited[0]!.detail)).toMatchObject({ message: `relayed F-${f.number}`, event: 'flag.created' });
    const ta = await h.s.users.byUsername(h.tenantId, 'ta');
    expect(await h.s.db('notifications').where({ user_id: ta!.id, kind: 'plugin' }).first()).toMatchObject({ title: `New flag F-${f.number}` });

    // the webhook went through the webhook path: a plugin-managed endpoint, Ed25519-signed, the catalogue event as body
    expect(rx.got).toHaveLength(1);
    const body = JSON.parse(rx.got[0]!.body);
    expect(body).toMatchObject({ type: 'flag.created', tenant: h.tenantId, data: { flag: `F-${f.number}`, action: 'created' } });
    const slug = (await h.s.tenants.byId(h.tenantId))!.slug;
    const jwks = (await request(h.app).get(`/webhooks/keys/${slug}`).expect(200)).body;
    const key = jwks.keys.find((k: { kid: string }) => k.kid === rx.got[0]!.headers['x-exprsn-key-id']);
    expect(verifyEd25519(key.x, String(rx.got[0]!.headers['x-exprsn-timestamp']), String(rx.got[0]!.headers['x-exprsn-signature-ed25519']), rx.got[0]!.body)).toBe(true);
    const hooks = (await admin.agent.get('/api/admin/webhooks').expect(200)).body.webhooks as { name: string; events: string[] }[];
    expect(hooks).toEqual([expect.objectContaining({ name: expect.stringMatching(/^plugin:flag-relay:[0-9a-f]{8}$/), events: [] })]);

    // granting the capability lets the action run on the next event; removing the plugin removes its webhook
    await send(admin, 'put', `/api/admin/plugins/${p.id}/grants`, { grants: ['read:events', 'emit:log', 'emit:audit', 'emit:notification', 'call:webhook', 'emit:flag'] }).expect(200);
    await raiseFlag(h, 'again');
    await drain(h);
    const latest = (await admin.agent.get(`/api/admin/plugins/${p.id}/invocations?limit=1`).expect(200)).body.invocations[0];
    expect(latest).toMatchObject({ state: 'succeeded' });
    expect(await h.s.db('guard_flags').where({ source_kind: 'plugin' }).count({ n: '*' }).first()).toMatchObject({ n: 1 });
    await send(admin, 'delete', `/api/admin/plugins/${p.id}`).expect(204);
    expect((await admin.agent.get('/api/admin/webhooks').expect(200)).body.webhooks).toEqual([]);
  });

  it('checks every webhook endpoint a plugin names against the outbound host rules (the Sprint 24 gap)', async () => {
    const hook = (url: string, kind = 'webhook') => ({ key: 'hooked', name: 'Hooked', version: '1.0.0', kind, events: ['flag.*'], capabilities: ['read:events', 'call:webhook'], ...(kind === 'webhook' ? { webhook: { url } } : { actions: [{ type: 'webhook', with: { url } }] }) });
    for (const url of ['http://169.254.169.254/latest/meta-data', 'http://8.8.8.8/hook']) {
      const r = await send(admin, 'post', '/api/admin/plugins', { manifest: hook(url), grants: ['read:events', 'call:webhook'] }).expect(422);
      expect(r.body.title).toBe('Endpoint refused');
    }
    await send(admin, 'post', '/api/admin/plugins', { manifest: hook('http://8.8.4.4/x', 'declarative'), grants: ['read:events', 'call:webhook'] }).expect(422);
    const cfg = { ...hook(`${rx.url}/ok`, 'declarative'), actions: [{ type: 'webhook' }], config: { schema: { type: 'object', properties: { webhookUrl: { type: 'string' } } } } };
    await send(admin, 'post', '/api/admin/plugins', { manifest: cfg, config: { webhookUrl: 'http://1.1.1.1/' }, grants: ['read:events', 'call:webhook'] }).expect(422);
    expect(await h.s.db('plugins').count({ n: '*' }).first()).toMatchObject({ n: 0 });

    // an internal endpoint installs; if the tenant's allow-list later refuses it, enabling is refused too
    const ok = (await send(admin, 'post', '/api/admin/plugins', { manifest: hook(`${rx.url}/ok`), grants: ['read:events', 'call:webhook'] }).expect(201)).body;
    const ta = (await h.s.users.byUsername(h.tenantId, 'ta'))!;
    await h.s.integrations.set(h.tenantId, { allowedHosts: ['hooks.example.org'] }, ta.id);
    expect((await send(admin, 'post', `/api/admin/plugins/${ok.id}/enable`).expect(422)).body.detail).toMatch(/allowed hosts/);
    await h.s.integrations.set(h.tenantId, { allowedHosts: [] }, ta.id);
    await send(admin, 'post', `/api/admin/plugins/${ok.id}/enable`).expect(200);
  });

  it('keeps a plugin from triggering itself, stops chains through other plugins, and caps the depth', async () => {
    const flagger = (key: string, events = ['flag.*']) => ({ key, name: key, version: '1.0.0', kind: 'declarative', events, capabilities: ['read:events', 'emit:flag'], actions: [{ type: 'flag', on: 'flag.created', with: { reason: `${key} saw {{event.data.flag}}` } }] });
    const a = (await send(admin, 'post', '/api/admin/plugins', { manifest: flagger('loop-a') }).expect(201)).body;
    await send(admin, 'post', `/api/admin/plugins/${a.id}/enable`).expect(200);

    // A raises a flag on every flag.created, including (were it not for the rule) its own
    await raiseFlag(h);
    await drain(h);
    expect(await h.s.db('guard_flags').count({ n: '*' }).first()).toMatchObject({ n: 2 });
    expect(await invocations(h, a.id)).toHaveLength(1);
    expect(await h.s.pluginRuntime.dropped.get().then((m) => m.values.find((v) => v.labels.reason === 'loop')?.value)).toBeGreaterThanOrEqual(1);

    // A and B: each one's flag reaches the other once, and the chain stops there
    const b = (await send(admin, 'post', '/api/admin/plugins', { manifest: flagger('loop-b') }).expect(201)).body;
    await send(admin, 'post', `/api/admin/plugins/${b.id}/enable`).expect(200);
    await h.s.db('guard_flags').delete();
    await h.s.db('plugin_invocations').delete();
    await raiseFlag(h, 'second round');
    await drain(h);
    // original, A's and B's on it, B's on A's flag, A's on B's flag
    expect(await h.s.db('guard_flags').count({ n: '*' }).first()).toMatchObject({ n: 5 });
    const chains = ((await invocations(h)) as { chain: string }[]).map((r) => JSON.parse(r.chain) as string[]);
    expect(chains.map((c) => c.length).sort()).toEqual([0, 0, 1, 1]);
  });

  it('caps a chain at PLUGIN_MAX_DEPTH', async () => {
    await h.close();
    h = await harness({ PLUGIN_MAX_DEPTH: '1' });
    await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    admin = await loginAdmin(h, 'ta');
    for (const key of ['depth-a', 'depth-b']) {
      const p = (await send(admin, 'post', '/api/admin/plugins', { manifest: { key, name: key, version: '1.0.0', kind: 'declarative', events: ['flag.*'], capabilities: ['read:events', 'emit:flag'], actions: [{ type: 'flag', on: 'flag.created' }] } }).expect(201)).body;
      await send(admin, 'post', `/api/admin/plugins/${p.id}/enable`).expect(200);
    }
    await raiseFlag(h);
    await drain(h);
    expect(await h.s.db('guard_flags').count({ n: '*' }).first()).toMatchObject({ n: 3 }); // the original and one from each
    expect(await invocations(h)).toHaveLength(2);
  });

  it('starts a published workflow as the installer, and the run it starts does not trigger the plugin again', async () => {
    const ta = (await h.s.users.byUsername(h.tenantId, 'ta'))!;
    const who = (await loadPrincipal(h.s, h.tenantId, ta.id, {}))!;
    who.workspaceId = null;
    const graph: WfGraph = { nodes: [{ id: 'trigger', kind: 'trigger', title: 'Trigger', x: 20, y: 24, config: { source: 'manual' } }, { id: 'shape', kind: 'transform', title: 'Shape', x: 230, y: 24, config: { fields: { note: 'from a plugin' } } }], edges: [{ from: 'trigger', to: 'shape' }], limits: {} };
    const w = await h.s.workflows.create(who, { name: 'triage', label: 'internal', graph });
    await h.s.workflows.publish(who, w.id, null);
    const m = { key: 'wf-starter', name: 'Workflow starter', version: '1.0.0', kind: 'declarative', events: ['flag.*', 'workflow.*', 'job.*'], capabilities: ['read:events', 'call:workflow'], actions: [{ type: 'workflow', with: { workflow: 'triage', includeEvent: true } }] };
    const p = (await send(admin, 'post', '/api/admin/plugins', { manifest: m, grants: ['read:events', 'call:workflow'] }).expect(201)).body;
    await send(admin, 'post', `/api/admin/plugins/${p.id}/enable`).expect(200);

    await raiseFlag(h);
    await drain(h, 20);
    const runs = (await h.s.db('workflow_runs').select('trigger', 'state', 'created_by')) as { trigger: string; state: string; created_by: string }[];
    expect(runs).toEqual([{ trigger: `plugin:${p.id}`, state: 'succeeded', created_by: ta.id }]);
    // the run's own events (workflow.run.started, the workflow job's job.succeeded) carry the chain: no second run
    const invs = (await invocations(h, p.id)) as { event_type: string }[];
    expect(invs.map((i) => i.event_type)).toEqual(['flag.created']);
    expect((await auditActions(h, 'workflow.run.started')).map((r) => JSON.parse(r.actor))).toEqual([{ service: 'plugin:wf-starter', user: ta.id }]);
  });

  it('bounds fan-out: a rate per plugin (audited once a window) and a number running at once', async () => {
    await h.close();
    h = await harness({ PLUGIN_RATE_PER_MINUTE: '2', PLUGIN_CONCURRENCY: '1' });
    await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    admin = await loginAdmin(h, 'ta');
    const p = (await send(admin, 'post', '/api/admin/plugins', { manifest: { key: 'busy', name: 'Busy', version: '1.0.0', kind: 'declarative', events: ['flag.*'], capabilities: ['read:events', 'emit:log'], actions: [{ type: 'log', on: 'flag.created' }] } }).expect(201)).body;
    await send(admin, 'post', `/api/admin/plugins/${p.id}/enable`).expect(200);
    for (let i = 0; i < 4; i++) await raiseFlag(h, `n${i}`);
    await new Promise((r) => setTimeout(r, 50));
    const rows = (await invocations(h, p.id)) as { id: string; state: string }[];
    expect(rows).toHaveLength(2);
    expect(await auditActions(h, 'plugin.throttled')).toHaveLength(1);

    // with one slot, an invocation finding another running gives its slot back and waits as a queued job
    await h.s.db('plugin_invocations').where({ id: rows[0]!.id }).update({ state: 'running', started_at: Date.now() });
    const out = await h.s.pluginRuntime.invoke(rows[1]!.id, new AbortController().signal);
    expect(out).toMatchObject({ deferred: expect.stringMatching(/1 invocations of busy running/) });
    expect(await h.s.db('plugin_invocations').where({ id: rows[1]!.id }).first()).toMatchObject({ state: 'queued' });
    await h.s.db('plugin_invocations').where({ id: rows[0]!.id }).update({ state: 'succeeded' });
    await new Promise((r) => setTimeout(r, 1100));
    await drain(h);
    expect(await h.s.db('plugin_invocations').where({ id: rows[1]!.id }).first()).toMatchObject({ state: 'succeeded' });
  });

  it('validates each action\'s arguments in the manifest and renders templates', async () => {
    const r = await send(admin, 'post', '/api/admin/plugins/validate', { manifest: declarative({ actions: [{ type: 'notify', with: { colour: 'red' } }, { type: 'workflow', with: {} }] }) }).expect(422);
    expect((r.body.errors as string[]).join('\n')).toMatch(/actions.0.with: Unrecognized key/);
    expect((r.body.errors as string[]).join('\n')).toMatch(/actions.1.with.workflow/);
    expect(render('{{event.type}} {{event.data.flag}} {{config.x}} {{missing.y}}', { event: { type: 'flag.created', data: { flag: 'F-1' } }, config: { x: 1 } })).toBe('flag.created F-1 1 ');
  });
});

// ---------- B-2004 ----------

const handlerSource = `
export async function main(event, platform) {
  await platform.log('handling ' + event.type + ' for ' + platform.config.team);
  const n = await platform.call('notify', { title: 'Handler saw ' + event.data.flag, roles: ['tenant-admin'] });
  let refused = null;
  try {
    await platform.call('workflow', { workflow: 'anything' });
  } catch (e) {
    refused = e.status;
  }
  console.log('workflow call answered ' + refused);
  return { notified: n.notified, refused };
}
`;

const scriptManifest = (over: Record<string, unknown> = {}) => ({
  key: 'flag-handler',
  name: 'Flag handler',
  version: '1.0.0',
  kind: 'script',
  events: ['flag.created'],
  capabilities: ['read:events', 'emit:log', 'emit:notification', 'call:workflow'],
  optionalCapabilities: ['call:workflow'],
  config: { schema: { type: 'object', properties: { team: { type: 'string' } } } },
  script: { entry: 'main', source: handlerSource },
  ...over
});

describe('script plugins (B-2004)', () => {
  let h: Harness;
  let admin: Client;
  beforeEach(async () => {
    h = await harness({ PLUGINS_REQUIRE_SIGNED: 'none' });
    await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    admin = await loginAdmin(h, 'ta');
  });
  afterEach(async () => {
    await h.close();
  });

  it('runs the handler in the sandbox, brokers its calls through a scoped token, and answers an ungranted call with 403', async () => {
    const runner = new ProcessRunner();
    h.s.scripts.runner = runner;
    const p = (await send(admin, 'post', '/api/admin/plugins', { manifest: scriptManifest(), config: { team: 'ops' } }).expect(201)).body;
    expect(p.granted).toEqual(['read:events', 'emit:log', 'emit:notification']); // call:workflow is high risk: not granted
    await send(admin, 'post', `/api/admin/plugins/${p.id}/enable`).expect(200);

    const f = await raiseFlag(h);
    await drain(h);
    const [inv] = (await admin.agent.get(`/api/admin/plugins/${p.id}/invocations`).expect(200)).body.invocations;
    expect(inv).toMatchObject({ state: 'succeeded', outcome: { calls: [{ api: 'log', status: 200 }, { api: 'notify', status: 200 }, { api: 'workflow', status: 403 }], exitCode: 0, returned: true } });
    const logs = ((await admin.agent.get(`/api/admin/plugins/${p.id}/logs`).expect(200)).body.logs as { message: string }[]).map((l) => l.message);
    expect(logs).toEqual(expect.arrayContaining(['handling flag.created for ops', expect.stringMatching(/workflow call answered 403/), expect.stringMatching(/returned \{"notified":1,"refused":403\}/)]));
    const refused = await auditActions(h, 'plugin.call.refused');
    expect(JSON.parse(refused[0]!.detail)).toMatchObject({ call: 'workflow', capability: 'call:workflow' });
    expect(await h.s.db('notifications').where({ kind: 'plugin' }).first()).toMatchObject({ title: `Handler saw F-${f.number}` });

    // the sandbox got the program and the limits; the token is stored hashed and revoked after the run
    expect(runner.requests[0]).toMatchObject({ language: 'javascript', limits: { timeoutSeconds: 30, memoryMb: 256 } });
    const hello = JSON.parse(runner.requests[0]!.stdin!);
    expect(hello.token).toMatch(/^xpt_/);
    const tok = await h.s.db('plugin_tokens').first();
    expect(tok.token_hash).toBe(sha(Buffer.from(hello.token)));
    expect(tok.revoked_at).not.toBeNull();
    expect(JSON.stringify(tok)).not.toContain(hello.token);
    await request(h.app).post('/plugin-broker/v1/calls/log').set('authorization', `Bearer ${hello.token}`).send({ message: 'late' }).expect(401);
  });

  it('serves the broker over HTTP to a live token: granted calls succeed, ungranted ones are 403', async () => {
    const runner = new ScriptedSession();
    h.s.scripts.runner = runner;
    const statuses: Record<string, number> = {};
    runner.play = async (hello) => {
      const call = (api: string, body: object) => request(h.app).post(`/plugin-broker/v1/calls/${api}`).set('authorization', `Bearer ${hello.token}`).send(body);
      statuses.log = (await call('log', { message: 'over http' })).status;
      const wf = await call('workflow', { workflow: 'x' });
      statuses.workflow = wf.status;
      statuses.records = (await call('records.write', {})).status;
      statuses.unknown = (await call('shell.exec', {})).status;
      statuses.badToken = (await request(h.app).post('/plugin-broker/v1/calls/log').set('authorization', 'Bearer xpt_notarealtokennotarealtoken').send({})).status;
      statuses.noToken = (await request(h.app).post('/plugin-broker/v1/calls/log').send({})).status;
      expect(wf.body).toMatchObject({ status: 403, detail: expect.stringMatching(/call:workflow/) });
      expect(wf.headers['content-type']).toMatch(/problem\+json/);
      return null;
    };
    const p = (await send(admin, 'post', '/api/admin/plugins', { manifest: scriptManifest({ capabilities: ['read:events', 'emit:log', 'emit:notification', 'call:workflow', 'write:records'], optionalCapabilities: ['call:workflow', 'write:records'] }) }).expect(201)).body;
    await send(admin, 'put', `/api/admin/plugins/${p.id}/grants`, { grants: ['read:events', 'emit:log', 'emit:notification', 'write:records'] }).expect(200);
    await send(admin, 'post', `/api/admin/plugins/${p.id}/enable`).expect(200);
    await raiseFlag(h);
    await drain(h);
    expect(statuses).toEqual({ log: 200, workflow: 403, records: 501, unknown: 404, badToken: 401, noToken: 401 });
    expect((await auditActions(h, 'plugin.call.refused')).length).toBe(1);
  });

  it('withdrawing a grant takes effect within a running handler, and calls per run are capped', async () => {
    await h.close();
    h = await harness({ PLUGINS_REQUIRE_SIGNED: 'none', PLUGIN_MAX_CALLS: '3' });
    await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    admin = await loginAdmin(h, 'ta');
    const runner = new ScriptedSession();
    h.s.scripts.runner = runner;
    const seen: number[] = [];
    let pluginId = '';
    runner.play = async (_hello, call) => {
      seen.push((await call('notify', { title: 'one' })).status);
      // a tenant admin withdraws emit:notification (not required) while the handler runs
      await h.s.db('plugins').where({ id: pluginId }).update({ granted: JSON.stringify(['read:events', 'emit:log']) });
      seen.push((await call('notify', { title: 'two' })).status);
      seen.push((await call('log', { message: 'three' })).status);
      seen.push((await call('log', { message: 'four' })).status);
      return null;
    };
    const p = (await send(admin, 'post', '/api/admin/plugins', { manifest: scriptManifest({ optionalCapabilities: ['call:workflow', 'emit:notification'] }) }).expect(201)).body;
    pluginId = p.id;
    await send(admin, 'post', `/api/admin/plugins/${p.id}/enable`).expect(200);
    await raiseFlag(h);
    await drain(h);
    expect(seen).toEqual([200, 403, 200, 429]);
  });

  it('runs a Python handler too', async () => {
    let python = true;
    try {
      execFileSync('python3', ['-c', 'pass']);
    } catch {
      python = false;
    }
    if (!python) return;
    h.s.scripts.runner = new ProcessRunner();
    const src = 'def handle(event, platform):\n    platform.log("py saw " + event["data"]["flag"])\n    try:\n        platform.call("workflow", {"workflow": "x"})\n    except PlatformError as e:\n        return {"refused": e.status}\n';
    const p = (await send(admin, 'post', '/api/admin/plugins', { manifest: scriptManifest({ key: 'py-handler', script: { entry: 'handle', language: 'python', source: src } }) }).expect(201)).body;
    await send(admin, 'post', `/api/admin/plugins/${p.id}/enable`).expect(200);
    const f = await raiseFlag(h);
    await drain(h);
    const [inv] = (await admin.agent.get(`/api/admin/plugins/${p.id}/invocations`).expect(200)).body.invocations;
    expect(inv).toMatchObject({ state: 'succeeded', outcome: { calls: [{ api: 'log', status: 200 }, { api: 'workflow', status: 403 }] } });
    const logs = ((await admin.agent.get(`/api/admin/plugins/${p.id}/logs`).expect(200)).body.logs as { message: string }[]).map((l) => l.message);
    expect(logs).toEqual(expect.arrayContaining([`py saw F-${f.number}`, 'returned {"refused":403}']));
  });

  it('refuses a handler that reaches for the network, and enabling without a sandbox', async () => {
    const bad = await send(admin, 'post', '/api/admin/plugins/validate', { manifest: scriptManifest({ script: { entry: 'main', source: "export async function main() { return fetch('http://x') }" } }) }).expect(422);
    expect((bad.body.errors as string[]).join('\n')).toMatch(/uses fetch/);
    await send(admin, 'post', '/api/admin/plugins/validate', { manifest: scriptManifest({ script: { entry: 'not-a-name', source: 'x' } }) }).expect(422);
    h.s.scripts.runner = new UnavailableRunner();
    const p = (await send(admin, 'post', '/api/admin/plugins', { manifest: scriptManifest() }).expect(201)).body;
    expect((await send(admin, 'post', `/api/admin/plugins/${p.id}/enable`).expect(409)).body.detail).toMatch(/sandbox/);
  });
});

// ---------- B-2005 ----------

function pluginBundle(o: { id: string; plugins: { path: string; manifest: object }[]; key: KeyObject | null; components?: object[] }): Buffer {
  const files = o.plugins.map((p) => ({ path: p.path, data: Buffer.from(JSON.stringify(p.manifest)) }));
  const manifest = {
    format: 'exprsn-bundle/1',
    id: o.id,
    files: files.map((f) => ({ path: f.path, sha256: sha(f.data), size: f.data.length, mirror: 'plugins' })),
    sbom: { bomFormat: 'CycloneDX', specVersion: '1.5', components: o.components ?? [{ name: 'flag-handler', version: '1.0.0', licenses: [{ license: { id: 'MIT' } }] }] }
  };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2));
  const sig = o.key ? Buffer.from(JSON.stringify({ algorithm: 'ed25519', key: keyFingerprint(o.key), signature: sign(null, bytes, o.key).toString('base64') })) : Buffer.from('unsigned');
  return writeTar([{ path: 'manifest.json', data: bytes }, { path: 'manifest.sig', data: sig }, ...files.map((f) => ({ path: `files/${f.path}`, data: f.data }))]);
}

describe('plugins from signed import bundles (B-2005)', () => {
  let h: Harness;
  let root: Client;
  let admin: Client;
  let signer: { privateKey: KeyObject; publicKey: KeyObject };

  async function importBundle(name: string, data: Buffer, promote = true) {
    const b = await send(root, 'post', '/api/admin/platform/bundles', { name, transfer: 'diode' }).expect(201);
    await root.agent.put(`/api/admin/platform/bundles/${b.body.id}/transfer`).set('x-csrf-token', root.csrf).set('content-type', 'application/octet-stream').send(data).expect(202);
    await h.s.jobs.runDue();
    let got = (await root.agent.get(`/api/admin/platform/bundles/${b.body.id}`).expect(200)).body;
    if (promote && got.state === 'ready to promote') {
      await send(root, 'post', `/api/admin/platform/bundles/${b.body.id}/promote`).expect(202);
      await h.s.jobs.runDue();
      got = (await root.agent.get(`/api/admin/platform/bundles/${b.body.id}`).expect(200)).body;
    }
    return got;
  }

  beforeEach(async () => {
    h = await harness();
    await localUser(h, 'root', ['system-admin'], 'restricted');
    root = await loginAdmin(h, 'root');
    await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    admin = await loginAdmin(h, 'ta');
    signer = generateKeyPairSync('ed25519');
    await send(root, 'post', '/api/admin/platform/signers', { name: 'plugin-signer', publicKeyPem: signer.publicKey.export({ type: 'spki', format: 'pem' }).toString() }).expect(201);
    h.s.scripts.runner = new ProcessRunner();
  });
  afterEach(async () => {
    await h.close();
  });

  it('installs a script plugin only from a promoted, signed bundle, and records where it came from', async () => {
    // inline, a script plugin is refused under the default policy
    expect((await send(admin, 'post', '/api/admin/plugins', { manifest: scriptManifest() }).expect(409)).body.detail).toMatch(/signed import bundle/);

    const b = await importBundle('plugins-2026-40', pluginBundle({ id: 'plugins-2026-40', plugins: [{ path: 'plugins/flag-handler.json', manifest: scriptManifest() }], key: signer.privateKey }));
    expect(b).toMatchObject({ state: 'in production', contents: '1 plugin' });
    expect(b.report.promotedTo).toEqual(['plugin catalogue']);

    const avail = (await admin.agent.get('/api/admin/plugins/available').expect(200)).body.plugins;
    expect(avail).toEqual([expect.objectContaining({ bundle: expect.objectContaining({ id: b.id, name: 'plugins-2026-40' }), path: 'plugins/flag-handler.json', manifest: expect.objectContaining({ key: 'flag-handler', kind: 'script' }), problem: null })]);

    const p = (await send(admin, 'post', '/api/admin/plugins/import', { bundle: 'plugins-2026-40', path: 'plugins/flag-handler.json', config: { team: 'ops' } }).expect(201)).body;
    expect(p).toMatchObject({ key: 'flag-handler', source: 'bundle', bundle: { id: b.id, digest: b.digest, path: 'plugins/flag-handler.json', signer: keyFingerprint(signer.publicKey) } });
    const installed = await auditActions(h, 'plugin.installed');
    expect(JSON.parse(installed[0]!.detail)).toMatchObject({ source: 'bundle', bundle: b.id, signer: keyFingerprint(signer.publicKey) });
    await send(admin, 'post', `/api/admin/plugins/${p.id}/enable`).expect(200);
    await raiseFlag(h);
    await drain(h);
    expect((await admin.agent.get(`/api/admin/plugins/${p.id}/invocations`).expect(200)).body.invocations[0]).toMatchObject({ state: 'succeeded' });
  });

  it('an unsigned plugin bundle cannot be installed, nor one whose signer was revoked or whose transfer changed', async () => {
    const files = [{ path: 'plugins/flag-handler.json', manifest: scriptManifest() }];
    const unsigned = await importBundle('unsigned', pluginBundle({ id: 'unsigned', plugins: files, key: null }));
    expect(unsigned.state).toBe('rejected');
    expect((await send(admin, 'post', '/api/admin/plugins/import', { bundle: 'unsigned', path: files[0]!.path }).expect(409)).body.detail).toMatch(/rejected/);
    // even marked promoted by hand, the signature is checked again on install
    await h.s.db('platform_bundles').where({ id: unsigned.id }).update({ state: 'in production' });
    expect((await send(admin, 'post', '/api/admin/plugins/import', { bundle: unsigned.id, path: files[0]!.path }).expect(409)).body.title).toBe('Bundle refused');

    const stranger = generateKeyPairSync('ed25519');
    const foreign = await importBundle('foreign', pluginBundle({ id: 'foreign', plugins: files, key: stranger.privateKey }));
    expect(foreign.state).toBe('rejected');
    await send(admin, 'post', '/api/admin/plugins/import', { bundle: 'foreign', path: files[0]!.path }).expect(409);

    // a licence outside the allow-list stops the bundle at verification
    const gpl = await importBundle('gpl', pluginBundle({ id: 'gpl', plugins: files, key: signer.privateKey, components: [{ name: 'x', licenses: [{ license: { id: 'AGPL-3.0-only' } }] }] }));
    expect(gpl.state).toBe('rejected');

    const good = await importBundle('good', pluginBundle({ id: 'good', plugins: files, key: signer.privateKey }));
    expect(good.state).toBe('in production');
    // the stored transfer altered after promotion
    const blob = (await h.s.db('platform_bundles').where({ id: good.id }).first()).blob_key as string;
    const original = (await h.s.blobs.get(blob))!;
    const at = original.lastIndexOf('Flag handler');
    const altered = Buffer.from(original);
    altered.write('Flag hacker!', at);
    await h.s.blobs.put(blob, altered);
    expect((await send(admin, 'post', '/api/admin/plugins/import', { bundle: 'good', path: files[0]!.path }).expect(409)).body.detail).toMatch(/changed/);
    await h.s.blobs.put(blob, original);
    // the signer revoked since promotion
    const keyRow = await h.s.db('platform_signer_keys').first();
    await h.s.ops.bundles.revokeKey({ tenantId: h.tenantId, userId: null, actor: { service: 'test' } }, keyRow.id, 'compromised');
    expect((await send(admin, 'post', '/api/admin/plugins/import', { bundle: 'good', path: files[0]!.path }).expect(409)).body.detail).toMatch(/revoked/);
    expect(await h.s.db('plugins').count({ n: '*' }).first()).toMatchObject({ n: 0 });
  });

  it('PLUGINS_REQUIRE_SIGNED=all refuses every inline install', async () => {
    await h.close();
    h = await harness({ PLUGINS_REQUIRE_SIGNED: 'all' });
    await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    admin = await loginAdmin(h, 'ta');
    expect((await send(admin, 'post', '/api/admin/plugins', { manifest: declarative() }).expect(409)).body.detail).toMatch(/PLUGINS_REQUIRE_SIGNED=all/);
  });
});
