import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContainerRunner, DEFAULT_LIMITS } from '../src/scripts/runner.js';
import { blockedModules } from '../src/scripts/service.js';
import { FakeRunner } from './fake-runner.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';

const CLEAN = 'import sys, json\nargs = json.load(sys.stdin)\nprint(json.dumps({"total": sum(args["values"])}))';

describe('script sandbox', () => {
  it('runs containers with no network, a read-only root, a non-root user and the limits', () => {
    const r = new ContainerRunner('podman', { python: 'python:3.13-slim', javascript: 'node:22-slim' });
    const args = r.args({ id: '01ABC', language: 'python', source: 'print(1)', limits: { ...DEFAULT_LIMITS, memoryMb: 256, cpus: 0.5, pids: 32 } });
    const joined = args.join(' ');
    for (const flag of ['--network none', '--read-only', '--user 65534:65534', '--cap-drop ALL', '--security-opt no-new-privileges', '--memory 256m', '--memory-swap 256m', '--cpus 0.5', '--pids-limit 32', '--rm']) expect(joined).toContain(flag);
    expect(joined).toMatch(/--tmpfs \/tmp:rw,noexec,nosuid,nodev/);
    expect(args.slice(-4)).toEqual(['python3', '-I', '-c', 'print(1)']);
    expect(args).not.toContain('-v');
    const js = r.args({ id: '01ABC', language: 'javascript', source: 'console.log(1)', limits: DEFAULT_LIMITS });
    expect(js.slice(-4)).toEqual(['node', '--input-type=module', '-e', 'console.log(1)']);
  });

  it('finds network and process modules', () => {
    expect(blockedModules('python', 'import csv\nimport requests  # no\nfrom subprocess import run')).toEqual([{ module: 'requests', line: 2 }, { module: 'subprocess', line: 3 }]);
    expect(blockedModules('javascript', "import { readFileSync } from 'node:fs';\nconst r = await fetch('http://x');")).toEqual([{ module: 'fetch', line: 2 }]);
    expect(blockedModules('javascript', "const cp = require('child_process');")).toEqual([{ module: 'child_process', line: 1 }]);
    expect(blockedModules('javascript', 'const x = obj.fetch(1);')).toEqual([]);
  });
});

describe('scripts', () => {
  let h: Harness;
  let runner: FakeRunner;
  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    runner = new FakeRunner();
    h.s.scripts.runner = runner;
  });
  afterEach(async () => {
    await h.close();
  });

  async function user(name: string, roles: string[]) {
    await localUser(h, name, roles, 'confidential');
    const c = await loginAdmin(h, name);
    return { ...c, post: (path: string, body: object = {}) => c.agent.post(path).set('x-csrf-token', c.csrf).send(body), patch: (path: string, body: object) => c.agent.patch(path).set('x-csrf-token', c.csrf).send(body) };
  }

  it('checks every version, refuses blocked scripts before start, runs clean ones as jobs and seals the output', async () => {
    const w = await user('wf', ['workflow-admin']);
    const created = (await w.post('/api/scripts', { name: 'clean_feed.py', language: 'python', source: 'import csv\nimport requests\nprint(1)', label: 'confidential' }).expect(201)).body;
    expect(created).toMatchObject({ status: 'draft', version: 1, blocked: true });
    expect(created.checks.find((c: { name: string }) => c.name === 'Blocked modules')).toMatchObject({ tone: 'danger', line: 2 });
    const refused = await w.post(`/api/scripts/${created.id}/run`, {}).expect(409);
    expect(refused.body).toMatchObject({ title: 'Refused before start' });
    expect(refused.body.detail).toMatch(/Line 2 uses requests/);
    expect(runner.requests).toHaveLength(0);

    const v2 = (await w.patch(`/api/scripts/${created.id}`, { source: CLEAN, note: 'Drop requests' }).expect(200)).body;
    expect(v2).toMatchObject({ version: 2, blocked: false, status: 'draft' });
    expect((await w.agent.get(`/api/scripts/${created.id}/versions`).expect(200)).body.map((v: { version: number; blocked: boolean }) => [v.version, v.blocked])).toEqual([[2, false], [1, true]]);
    const raw = await h.s.db('script_versions').where({ script_id: created.id, version: 2 }).first();
    expect(raw.source).toMatch(/^v2\./);
    expect(raw.source).not.toContain('json.load');

    runner.handler = (req) => ({ stdout: `{"total": ${(JSON.parse(req.stdin!) as { values: number[] }).values.reduce((a, b) => a + b, 0)}}`, stderr: 'warning: none' });
    const started = (await w.post(`/api/scripts/${created.id}/run`, { stdin: '{"values":[1,2,3]}' }).expect(202)).body;
    await h.s.jobs.runDue();
    const run = (await w.agent.get(`/api/script-runs/${started.runId}`).expect(200)).body;
    expect(run).toMatchObject({ state: 'succeeded', exitCode: 0, stdout: '{"total": 6}', stderr: 'warning: none', runner: 'fake', version: 2 });
    expect(runner.requests[0]).toMatchObject({ language: 'python', source: CLEAN, limits: DEFAULT_LIMITS });
    const rawRun = await h.s.db('script_runs').where({ id: started.runId }).first();
    expect(rawRun.stdout).toMatch(/^v2\./);
    expect((await w.agent.get(`/api/scripts/${created.id}`).expect(200)).body.status).toBe('tested');

    runner.handler = () => ({ exitCode: null, timedOut: true, stdout: 'partial' });
    const t = (await w.post(`/api/scripts/${created.id}/run`, {}).expect(202)).body;
    await h.s.jobs.runDue();
    expect((await w.agent.get(`/api/script-runs/${t.runId}`).expect(200)).body).toMatchObject({ state: 'timeout', stdout: 'partial' });
    expect((await w.agent.get(`/api/scripts/${created.id}/runs`).expect(200)).body.map((r: { state: string }) => r.state)).toEqual(['timeout', 'succeeded']);

    // Restoring v1 makes v3 (versions are never overwritten), with v1's checks.
    const v3 = (await w.post(`/api/scripts/${created.id}/restore`, { version: 1 }).expect(200)).body;
    expect(v3).toMatchObject({ version: 3, blocked: true });
    expect((await h.s.audit.list(h.tenantId, { action: 'script.' })).map((e) => e.action)).toEqual(expect.arrayContaining(['script.created', 'script.updated', 'script.run.started', 'script.restored']));
  });

  it('applies the script guardrail checkpoint and the secrets scan', async () => {
    const w = await user('wf', ['workflow-admin']);
    const seen: string[] = [];
    h.s.guardrails = { check: async (i) => (seen.push(i.checkpoint), i.checkpoint === 'script' && i.text.includes('eval(') ? { action: 'block', text: i.text, findings: [{ ruleId: 'r1', ruleName: 'No eval', action: 'block', stage: 'enforce' }], reason: 'Dynamic evaluation is not allowed.' } : { action: 'allow', text: i.text, findings: [] }) };
    const s1 = (await w.post('/api/scripts', { name: 'ev.py', language: 'python', source: 'eval("1+1")' }).expect(201)).body;
    expect(s1.checks.find((c: { name: string }) => c.name === 'Script guardrail')).toMatchObject({ result: 'blocked', tone: 'danger', detail: 'Dynamic evaluation is not allowed.' });
    expect(seen).toContain('script');
    const s2 = (await w.post('/api/scripts', { name: 'key.mjs', language: 'javascript', source: 'const password = "correct-horse-battery";\nconsole.log(1);' }).expect(201)).body;
    expect(s2.checks.find((c: { name: string }) => c.name === 'Secrets scan')).toMatchObject({ tone: 'danger', line: 1 });
    await w.post(`/api/scripts/${s2.id}/run`, {}).expect(409);
  });

  it('promotes a tested script to a registry tool that a tool admin publishes, then runs it as a tool', async () => {
    const w = await user('wf', ['workflow-admin']);
    const ta = await user('ta', ['tool-admin']);
    const sc = (await w.post('/api/scripts', { name: 'sum.py', language: 'python', source: CLEAN, label: 'internal' }).expect(201)).body;
    const promo = { toolName: 'numbers.sum', description: 'Adds a list of numbers exactly and returns the total as a number.', sideEffect: 'read', inputSchema: { type: 'object', properties: { values: { type: 'array', items: { type: 'number' } } }, required: ['values'] }, outputSchema: { type: 'object', properties: { total: { type: 'number' } }, required: ['total'] } };
    const early = await w.post(`/api/scripts/${sc.id}/promote`, promo).expect(409);
    expect(early.body.detail).toMatch(/Run the current version once/);
    runner.handler = (req) => ({ stdout: JSON.stringify({ total: ((JSON.parse(req.stdin || '{"values":[]}') as { values: number[] }).values).reduce((a, b) => a + b, 0) }) });
    await w.post(`/api/scripts/${sc.id}/run`, { stdin: '{"values":[1]}' }).expect(202);
    await h.s.jobs.runDue();
    const entry = (await w.post(`/api/scripts/${sc.id}/promote`, promo).expect(201)).body;
    expect(entry).toMatchObject({ name: 'numbers.sum', impl: 'script', status: 'in_review', checksPassed: true, definition: { scriptId: sc.id, version: 1 } });
    expect((await w.agent.get(`/api/scripts/${sc.id}`).expect(200)).body).toMatchObject({ status: 'in_review', registry: { name: 'numbers.sum', status: 'in_review' } });

    // A tool admin (not the author) publishes it; the script is then promoted.
    await ta.post(`/api/admin/registry/${entry.id}/review`, { decision: 'approve' }).expect(200);
    expect((await w.agent.get(`/api/scripts/${sc.id}`).expect(200)).body.status).toBe('promoted');
    const test = (await ta.post(`/api/admin/registry/${entry.id}/test`, { arguments: { values: [2, 3.5] } }).expect(200)).body;
    expect(test).toMatchObject({ ok: true, valid: true, result: { total: 5.5 }, sandboxed: true });
    expect(runner.requests.at(-1)!.stdin).toBe('{"values":[2,3.5]}');
    // A new version of the script does not change the published tool, which pins version 1.
    await w.patch(`/api/scripts/${sc.id}`, { source: CLEAN + '\n# v2' }).expect(200);
    await ta.post(`/api/admin/registry/${entry.id}/test`, { arguments: { values: [1] } }).expect(200);
    expect(runner.requests.at(-1)!.source).toBe(CLEAN);
    // A failing script is a failed call, not a crash.
    runner.handler = () => ({ exitCode: 1, stderr: 'Traceback\nValueError: bad' });
    const failed = (await ta.post(`/api/admin/registry/${entry.id}/test`, { arguments: { values: [1] } }).expect(200)).body;
    expect(failed).toMatchObject({ ok: false });
    expect(failed.error).toMatch(/exited with 1: Traceback ValueError: bad/);
  });
});
