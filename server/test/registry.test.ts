import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runChecks, scanSecrets, suggestedSideEffect } from '../src/registry/checks.js';
import { schemaHash, schemaProblems, validateAgainst } from '../src/registry/schema.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';

const agentBody = (over: Record<string, unknown> = {}) => ({
  kind: 'agent',
  name: 'Data analyst',
  version: '1.0.0',
  description: 'Answers finance questions from the ledger and computes variances exactly with the calculator.',
  label: 'confidential',
  definition: { profile: 'general', systemPrompt: 'Be exact.', tools: ['calculate'], budgets: { steps: 20, tokens: 10000, wallSeconds: 120, toolCalls: 8 } },
  ...over
});

const skillBody = (over: Record<string, unknown> = {}) => ({
  kind: 'skill',
  name: 'variance-analysis',
  version: '1.0.0',
  description: 'Instructions for explaining budget variances by cost centre, with the arithmetic done by the calculator.',
  definition: { instructions: 'Group by cost centre, compute actual minus budget, report the two largest.', tools: ['calculate'] },
  ...over
});

describe('registry checks', () => {
  it('validates schemas, descriptions, side effects and scans for secrets', () => {
    expect(schemaProblems({ type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, 'input')).toEqual([]);
    expect(schemaProblems({ type: 'string' }, 'input')[0]).toMatch(/must describe an object/);
    expect(schemaProblems({ type: 'object', properties: {}, required: ['missing'] }, 'input')[0]).toMatch(/"missing" is required/);
    expect(schemaProblems({ type: 'object', properties: { a: { type: 'nonsense' } } }, 'input').length).toBeGreaterThan(0);
    expect(validateAgainst({ type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] }, { n: 'x' })[0]).toMatch(/integer/);
    expect(suggestedSideEffect('kb.delete_documents')).toBe('destructive');
    expect(suggestedSideEffect('jira.create_issue')).toBe('write');
    expect(suggestedSideEffect('ledger.query')).toBeNull();
    expect(scanSecrets('const key = "AKIAIOSFODNN7EXAMPLE";\nok').map((x) => x.line)).toEqual([1]);
    expect(scanSecrets('password = "hunter2hunter2"')[0]!.what).toMatch(/password/);
    expect(scanSecrets('-----BEGIN PRIVATE KEY-----')).toHaveLength(1);
    expect(schemaHash({ name: 'a', inputSchema: { b: 1, a: 2 } })).toBe(schemaHash({ name: 'a', inputSchema: { a: 2, b: 1 } }));

    const checks = runChecks({ kind: 'tool', name: 'files.remove', version: '1.0', description: 'TODO', sideEffect: 'read', inputSchema: { type: 'object' }, outputSchema: null, definition: { token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB' } });
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName['Required fields']!.ok).toBe(false); // not semver
    expect(byName['Description quality']!.ok).toBe(false);
    expect(byName['Side effect declared']!.detail).toMatch(/suggests destructive/);
    expect(byName['Secrets scan']!.ok).toBe(false);
    expect(byName['Schema valid']!.ok).toBe(true);
  });
});

describe('registry', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
  });
  afterEach(async () => {
    await h.close();
  });

  async function admins() {
    await localUser(h, 'author', ['tool-admin'], 'confidential');
    await localUser(h, 'reviewer', ['tool-admin'], 'confidential');
    const a = await loginAdmin(h, 'author');
    const b = await loginAdmin(h, 'reviewer');
    const post = (c: typeof a) => (path: string, body: object = {}) => c.agent.post(path).set('x-csrf-token', c.csrf).send(body);
    return { a, b, pa: post(a), pb: post(b) };
  }

  it('lists the built-in calculate tool as a published platform entry, and its harness runs', async () => {
    const { a, pa } = await admins();
    const list = (await a.agent.get('/api/admin/registry?kind=tool').expect(200)).body;
    const calc = list.find((e: { name: string }) => e.name === 'calculate');
    expect(calc).toMatchObject({ status: 'published', impl: 'builtin', sideEffect: 'read', platform: true, publishScope: 'platform' });
    const t = (await pa(`/api/admin/registry/${calc.id}/test`, { arguments: { expression: '(1250 * 1.07) / 12' } }).expect(200)).body;
    expect(t).toMatchObject({ ok: true, valid: true, result: { fraction: '2675/24', exact: false } });
    await a.agent.patch(`/api/admin/registry/${calc.id}`).set('x-csrf-token', a.csrf).send({ description: 'x' }).expect(403);
    const bad = await pa(`/api/admin/registry/${calc.id}/test`, { arguments: { expr: 1 } }).expect(200);
    expect(bad.body.error).toMatch(/input schema/);
  });

  it('walks an entry through checks, review by someone else, publish scope, deprecation and retirement', async () => {
    const { a, b, pa, pb } = await admins();
    // A draft with a secret and a weak description fails its checks.
    const bad = (await pa('/api/admin/registry', skillBody({ name: 'leaky', description: 'short', definition: { instructions: 'Use api_key = "sk-live-abcdefghijklmnopqrstu".', tools: [] } })).expect(201)).body;
    expect(bad.status).toBe('draft');
    expect(bad.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { name: string }) => c.name).sort()).toEqual(['Description quality', 'Secrets scan']);
    await pa(`/api/admin/registry/${bad.id}/submit`).expect(200);
    const refused = await pb(`/api/admin/registry/${bad.id}/review`, { decision: 'approve' }).expect(409);
    expect(refused.body.detail).toMatch(/Approve stays disabled until the checks pass: Description quality, Secrets scan/);
    const rejected = (await pb(`/api/admin/registry/${bad.id}/review`, { decision: 'reject', note: 'Remove the key.' }).expect(200)).body;
    expect(rejected).toMatchObject({ status: 'draft', reviewNote: 'Remove the key.' });
    const fixed = (await a.agent.patch(`/api/admin/registry/${bad.id}`).set('x-csrf-token', a.csrf).send({ description: 'Instructions for a leak-free walkthrough of the monthly close checklist.', definition: { instructions: 'Use the secret reference ledger-ro.', tools: [] } }).expect(200)).body;
    expect(fixed.checksPassed).toBe(true);

    const skill = (await pa('/api/admin/registry', skillBody()).expect(201)).body;
    expect(skill.checksPassed).toBe(true);
    await pa(`/api/admin/registry/${skill.id}/submit`).expect(200);
    // The author cannot review their own entry.
    const own = await pa(`/api/admin/registry/${skill.id}/review`, { decision: 'approve' }).expect(403);
    expect(own.body.step).toBe('dual-control');

    // Workspace scope: a workspace below the entry's label cannot receive it.
    const low = await h.s.tenants.createWorkspace(h.tenantId, 'Public desk', 'public');
    const fin = await h.s.tenants.createWorkspace(h.tenantId, 'Finance Ops', 'confidential');
    await pb(`/api/admin/registry/${skill.id}/review`, { decision: 'approve', scope: 'workspace', workspaces: [low.id] }).expect(409);
    const pub = (await pb(`/api/admin/registry/${skill.id}/review`, { decision: 'approve', scope: 'workspace', workspaces: [fin.id] }).expect(200)).body;
    expect(pub).toMatchObject({ status: 'published', publishScope: 'workspace', publishWorkspaces: [fin.id], reviewedBy: 'REVIEWER' });
    expect(pub.approvedHash).toBe(pub.schemaHash);
    const detail = (await b.agent.get(`/api/admin/registry/${skill.id}`).expect(200)).body;
    expect(detail.workspaces).toEqual([{ id: fin.id, name: 'Finance Ops' }]);
    // The author was told.
    expect((await h.s.notifications.list((await h.s.users.byUsername(h.tenantId, 'author'))!.id)).map((n) => n.title)).toContain('variance-analysis 1.0.0 published');

    await pb(`/api/admin/registry/${skill.id}/publish`, { scope: 'tenant' }).expect(200);
    await pb(`/api/admin/registry/${skill.id}/lifecycle`, { to: 'retired' }).expect(409);
    const dep = (await pb(`/api/admin/registry/${skill.id}/lifecycle`, { to: 'deprecated', replacement: 'variance-analysis 2.0.0' }).expect(200)).body;
    expect(dep).toMatchObject({ status: 'deprecated', replacement: 'variance-analysis 2.0.0' });
    await pb(`/api/admin/registry/${skill.id}/lifecycle`, { to: 'published' }).expect(200);
    await pb(`/api/admin/registry/${skill.id}/lifecycle`, { to: 'deprecated' }).expect(200);
    const ret = (await pb(`/api/admin/registry/${skill.id}/lifecycle`, { to: 'retired' }).expect(200)).body;
    expect(ret.status).toBe('retired');

    const v2 = (await pa(`/api/admin/registry/${skill.id}/versions`, { version: '2.0.0' }).expect(201)).body;
    expect(v2).toMatchObject({ status: 'draft', version: '2.0.0', name: 'variance-analysis' });
    await pa(`/api/admin/registry/${skill.id}/versions`, { version: '2.0.0' }).expect(409);
    const versions = (await a.agent.get(`/api/admin/registry/${v2.id}`).expect(200)).body.versions;
    expect(versions.map((v: { version: string }) => v.version)).toEqual(['2.0.0', '1.0.0']);

    const actions = (await h.s.audit.list(h.tenantId, { action: 'registry.' })).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['registry.created', 'registry.submitted', 'registry.rejected', 'registry.published', 'registry.deprecated', 'registry.retired', 'registry.restored', 'registry.version.created', 'registry.scope.changed']));
  });

  it('checks agents: profile, referenced tools published, and limits', async () => {
    const { pa } = await admins();
    await pa('/api/admin/registry', agentBody()).expect(404); // no such profile
    const t = Date.now();
    await h.s.gateway.repo.createProfile({ id: 'GENERAL0000000000000000000', tenant_id: h.tenantId, name: 'general', display_name: 'general', description: null, alias_of: null, model_id: null, pool_id: null, num_ctx: null, temperature: null, think_default: 'off', think_ceiling: 'off', system_prompt: null, fallback: null, canary: null, tools: [], label: 'internal', status: 'draft', version: 1, updated_by: null, created_at: t, updated_at: t });
    const ok = (await pa('/api/admin/registry', agentBody()).expect(201)).body;
    expect(ok.checksPassed).toBe(true);
    const missing = (await pa('/api/admin/registry', agentBody({ name: 'Needs tools', definition: { ...agentBody().definition, tools: ['ledger.query', 'calculate'] } })).expect(201)).body;
    const refs = missing.checks.find((c: { name: string }) => c.name === 'Referenced tools published');
    expect(refs).toMatchObject({ ok: false });
    expect(refs.detail).toMatch(/ledger.query is not in the registry/);
    await pa('/api/admin/registry', agentBody({ name: 'Greedy', definition: { ...agentBody().definition, budgets: { steps: 1000, tokens: 10, wallSeconds: 1, toolCalls: 1 } } })).expect(400);
  });

  it('keeps members out of the admin registry and requires agents:manage for agent entries', async () => {
    await localUser(h, 'mem', ['member']);
    const m = await login(h, 'mem');
    await m.agent.get('/api/admin/registry').expect(403);
    await localUser(h, 'wf', ['workflow-admin']);
    const w = await loginAdmin(h, 'wf');
    const r = await w.agent.post('/api/admin/registry').set('x-csrf-token', w.csrf).send(agentBody()).expect(403);
    expect(r.body.action).toBe('agents:manage');
  });
});
