import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startKind } from '../src/workflows/callers.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';
import { drain } from './retrieval-seed.js';

/*
 * Sprint 32e (B-3910): the routes the live Workflows screen needs beyond Sprint 32a to 32c. `GET
 * /api/workflows/:id/callers` lists what else starts a workflow (app triggers, other workflows' sub, map and loop
 * steps, registry tools, plugins granted call:workflow, and the last run of each kind of start); the event catalogue
 * is readable by workflow admins, who pick a trigger's event from it.
 */

describe('startKind', () => {
  it('reads the kind of start from a run trigger', () => {
    expect(['manual', 'api', 'record', 'schedule', 'tool', 'replay'].map(startKind)).toEqual(['manual', 'api', 'record', 'schedule', 'tool', 'replay']);
    expect(startKind('event:01J8')).toBe('event');
    expect(startKind('schedule:01J8')).toBe('schedule');
    expect(startKind('plugin:a,b')).toBe('plugin');
    expect(startKind('workflow:01J8')).toBe('workflow');
    expect(startKind('something-else')).toBe('manual');
  });
});

describe('workflow callers (Sprint 32e)', () => {
  let h: Harness;
  let wsId: string;

  beforeEach(async () => {
    h = await harness();
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Finance', 'confidential')).id;
  });
  afterEach(async () => {
    await h.close();
  });

  async function wrap(c: { agent: Client['agent']; csrf: string }) {
    const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
    await send('put', '/api/me/workspace', { workspaceId: wsId }).expect(200);
    return { post: (p: string, b?: object) => send('post', p, b), get: (p: string) => c.agent.get(p) };
  }

  const trigger = { id: 'trigger', kind: 'trigger', title: 'Trigger', x: 20, y: 20, config: { source: 'record' } };
  const shape = { id: 'shape', kind: 'transform', title: 'Shape', x: 200, y: 20, config: { fields: { text: 'hello' } } };

  it('lists app triggers, calling workflows and the last run of each kind of start, within what the caller may see', async () => {
    const u = await localUser(h, 'dee', ['workflow-admin', 'member'], 'confidential');
    await h.s.tenants.addMember(wsId, u.id);
    const d = await wrap(await loginAdmin(h, 'dee'));
    const m = await localUser(h, 'mia', ['member']);
    await h.s.tenants.addMember(wsId, m.id);
    const mia = await wrap(await login(h, 'mia'));

    // the callee, published, and an app trigger that starts it
    const callee = (await d.post('/api/workflows', { name: 'callee', label: 'internal', graph: { nodes: [trigger, shape], edges: [{ from: 'trigger', to: 'shape' }], limits: {} } }).expect(201)).body as { id: string };
    await d.post(`/api/workflows/${callee.id}/publish`, { note: null }).expect(200);
    await d.post('/api/apps', { name: 'crm', title: 'CRM', label: 'internal', workspaceId: wsId }).expect(201);
    await d.post('/api/apps/crm/entities', { name: 'deal', title: 'Deal', label: 'internal', definition: { fields: [{ name: 'title', type: 'string', required: true, maxLength: 120 }] } }).expect(201);
    await d.post('/api/apps/crm/triggers', { entity: 'deal', kind: 'record', events: ['created', 'transitioned'], workflow: 'callee' }).expect(201);

    // a draft that runs it as a sub-workflow
    const sub = { id: 'child', kind: 'sub', title: 'Run the callee', x: 200, y: 20, config: { workflow: 'callee' } };
    await d.post('/api/workflows', { name: 'parent', label: 'internal', graph: { nodes: [{ ...trigger, config: { source: 'manual' } }, sub], edges: [{ from: 'trigger', to: 'child' }], limits: {} } }).expect(201);

    // a manual run by the admin
    await d.post(`/api/workflows/${callee.id}/runs`, { input: {} }).expect(202);
    await drain(h);

    const out = (await d.get(`/api/workflows/callee/callers`).expect(200)).body;
    expect(out.workflowId).toBe(callee.id);
    expect(out.appTriggers).toHaveLength(1);
    expect(out.appTriggers[0]).toMatchObject({ kind: 'record', appName: 'crm', appTitle: 'CRM', entity: 'deal', events: ['created', 'transitioned'], ownerName: 'DEE', enabled: true });
    expect(out.workflows).toEqual([expect.objectContaining({ workflow: 'parent', step: 'child', stepTitle: 'Run the callee', kind: 'sub', in: 'draft', version: null })]);
    expect(out.tools).toEqual([]);
    expect(out.plugins).toEqual([]);
    expect(out.lastRuns.manual).toMatchObject({ count: 1, state: 'succeeded', trigger: 'manual' });

    // a member sees the callers, and only their own runs in the last-run summary
    const seen = (await mia.get(`/api/workflows/${callee.id}/callers`).expect(200)).body;
    expect(seen.appTriggers).toHaveLength(1);
    expect(seen.lastRuns).toEqual({});
    await mia.get('/api/workflows/nothing-here/callers').expect(404);
  });

  it('lets workflow admins read the event catalogue for event triggers; members are refused', async () => {
    const u = await localUser(h, 'dee', ['workflow-admin', 'member'], 'confidential');
    await h.s.tenants.addMember(wsId, u.id);
    const d = await wrap(await loginAdmin(h, 'dee'));
    await localUser(h, 'mia', ['member']);
    const mia = await login(h, 'mia');
    const cat = (await d.get('/api/events/catalogue').expect(200)).body as { types: { type: string }[] };
    expect(cat.types.map((e) => e.type)).toContain('file.uploaded');
    await mia.agent.get('/api/events/catalogue').expect(403);
  });
});
