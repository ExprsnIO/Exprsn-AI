import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPrincipal } from '../src/http/middleware.js';
import { DEFAULT_LIMITS } from '../src/scripts/runner.js';
import { FakeRunner } from './fake-runner.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';

describe('Tenant-wide scripts are seen from every workspace', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    h.s.scripts.runner = new FakeRunner();
  });
  afterEach(async () => {
    await h.close();
  });

  it('lists and opens a script without a workspace from inside a workspace, and keeps workspaces apart', async () => {
    const u = await localUser(h, 'wf', ['workflow-admin'], 'confidential');
    const a = (await h.s.tenants.createWorkspace(h.tenantId, 'Alpha', 'confidential')).id;
    const b = (await h.s.tenants.createWorkspace(h.tenantId, 'Beta', 'confidential')).id;
    await h.s.tenants.addMember(a, u.id);
    await h.s.tenants.addMember(b, u.id);
    const c = await loginAdmin(h, 'wf');
    const post = (path: string, body: object = {}) => c.agent.post(path).set('x-csrf-token', c.csrf).send(body);
    const put = (path: string, body: object = {}) => c.agent.put(path).set('x-csrf-token', c.csrf).send(body);
    const names = async () => ((await c.agent.get('/api/scripts').expect(200)).body as { name: string; workspaceId: string | null }[]).map((x) => `${x.name}:${x.workspaceId ?? 'tenant'}`);

    // Outside any workspace, as a setup script creates it: a tenant-wide script.
    const p = (await loadPrincipal(h.s, h.tenantId, u.id, {}))!;
    const wide = await h.s.scripts.create({ ...p, workspaceId: null }, { name: 'wide.py', language: 'python', source: 'print(1)', label: 'internal', limits: DEFAULT_LIMITS });
    expect(wide.workspace_id).toBeNull();

    await put('/api/me/workspace', { workspaceId: a }).expect(200);
    const inA = (await post('/api/scripts', { name: 'alpha.py', language: 'python', source: 'print(2)', label: 'internal' }).expect(201)).body as { id: string };
    expect(await names()).toEqual([`alpha.py:${a}`, 'wide.py:tenant']);
    expect((await c.agent.get(`/api/scripts/${wide.id}`).expect(200)).body).toMatchObject({ name: 'wide.py', workspaceId: null });
    await post(`/api/scripts/${wide.id}/run`, { stdin: '{}' }).expect(202);

    await put('/api/me/workspace', { workspaceId: b }).expect(200);
    expect(await names()).toEqual(['wide.py:tenant']);
    await c.agent.get(`/api/scripts/${inA.id}`).expect(404);
    await c.agent.get(`/api/scripts/${wide.id}`).expect(200);
  });
});
