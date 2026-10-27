import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppPackages, type AppPackage } from '../src/apps/packages.js';
import type { Principal } from '../src/authz/policy.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';
import { drain } from './retrieval-seed.js';

/*
 * Flows in app packages (docs/decisions/lowcode-port.md, follow-up 3): an `exprsn-app/2` package carries each flow's
 * model, not its compiled workflow and trigger; the git layout has one file per flow; import re-creates and compiles
 * the flows in the new app with references re-bound by name, and a deployment reconciles them by name.
 */

const deal = { fields: [{ name: 'title', type: 'string', required: true, maxLength: 120 }, { name: 'amount', type: 'number' }, { name: 'notes', type: 'string', maxLength: 2000 }] };
const task = { fields: [{ name: 'title', type: 'string', required: true, maxLength: 200 }] };

describe('flows in app packages', () => {
  let h: Harness;
  let wsId: string;
  let d: Client & { post: (p: string, b?: object) => ReturnType<Client['agent']['post']>; get: (p: string) => ReturnType<Client['agent']['get']>; put: (p: string, b?: object) => ReturnType<Client['agent']['put']> };
  let p: Principal;

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Sales', 'confidential')).id;
    const u = await localUser(h, 'dee', ['workflow-admin', 'member'], 'confidential');
    await h.s.tenants.addMember(wsId, u.id);
    const c = await loginAdmin(h, 'dee');
    const send = (method: 'post' | 'put', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
    await send('put', '/api/me/workspace', { workspaceId: wsId }).expect(200);
    d = { ...c, post: (x, b) => send('post', x, b), put: (x, b) => send('put', x, b), get: (x) => c.agent.get(x) };
    p = { ...(await loadPrincipal(h.s, h.tenantId, u.id, {}))!, workspaceId: wsId };
    await d.post('/api/apps', { name: 'crm', title: 'CRM', label: 'confidential', workspaceId: wsId }).expect(201);
    await d.post('/api/apps/crm/entities', { name: 'deal', title: 'Deal', label: 'internal', definition: deal }).expect(201);
    await d.post('/api/apps/crm/entities', { name: 'task', title: 'Task', label: 'internal', definition: task }).expect(201);
    await d.post('/api/apps/crm/flows', {
      name: 'follow_up',
      title: 'Follow up',
      entity: 'deal',
      trigger: { kind: 'record', events: ['created'] },
      actions: [
        { type: 'tool', tool: 'calculate', args: { expression: '{{input.record.values.amount}} + 1' } },
        { type: 'create', entity: 'task', values: { title: 'Call about {{input.record.values.title}} ({{steps.act1.decimal}})' } }
      ]
    }).expect(201);
    const hooked = (await d.post('/api/apps/crm/flows', { name: 'inbound', entity: 'deal', trigger: { kind: 'webhook' }, actions: [{ type: 'create', entity: 'deal', values: { title: '{{input.payload.title}}' } }] }).expect(201)).body;
    await d.post(`/api/apps/crm/flows/${hooked.id}/hook/secret`).expect(201);
    await d.put(`/api/apps/crm/flows/${hooked.id}/hook`, { enabled: true }).expect(200);
  });
  afterEach(async () => {
    await h.close();
  });

  const actor = () => ({ principal: p, source: 'api' as const, ip: null });

  it('carries flow models (not their workflows and triggers), survives the git layout, and imports them compiled again', async () => {
    const made = (await d.post('/api/apps/crm/packages', {}).expect(201)).body as { package: AppPackage };
    const pkg = made.package;
    expect(pkg.flows?.map((f) => f.name)).toEqual(['follow_up', 'inbound']);
    expect(pkg.flows?.[0]).toMatchObject({ title: 'Follow up', entity: 'deal', trigger: { kind: 'record', events: ['created'] }, actions: [{ type: 'tool', tool: 'calculate' }, { type: 'create', entity: 'task' }] });
    expect(JSON.stringify(pkg)).not.toMatch(/whsec_|hook_secret/);
    expect(pkg.triggers).toEqual([]);
    expect(pkg.workflows).toEqual([]);

    // one file per flow; reassembled, the signature still verifies
    const files = AppPackages.files(pkg);
    expect([...files.keys()]).toEqual(expect.arrayContaining(['flows/follow_up.json', 'flows/inbound.json']));
    const back = await h.s.apps.packages.verify(actor(), AppPackages.fromFiles(files));
    expect(AppPackages.hashOf(back)).toBe(AppPackages.hashOf(pkg));
    // a changed flow file breaks the signature
    const tampered = new Map(files);
    tampered.set('flows/follow_up.json', files.get('flows/follow_up.json')!.replace('calculate', 'messages.send'));
    await expect(h.s.apps.packages.verify(actor(), AppPackages.fromFiles(tampered))).rejects.toMatchObject({ status: 422 });

    const imported = (await d.post('/api/apps/packages/import', { package: pkg, name: 'crm2' }).expect(201)).body;
    expect(imported.report.flows).toEqual({ created: ['follow_up', 'inbound'], updated: [], removed: [], failed: [] });
    const flows = (await d.get('/api/apps/crm2/flows').expect(200)).body.flows as { name: string; workflow: { name: string; publishedVersion: number }; hook: { enabled: boolean } | null; triggerId: string | null }[];
    expect(flows.map((f) => [f.name, f.workflow.name, f.workflow.publishedVersion])).toEqual([['follow_up', 'app-crm2-follow-up', 1], ['inbound', 'app-crm2-inbound', 1]]);
    expect(flows[1]!.hook).toMatchObject({ enabled: false, secretSet: false });
    expect(flows[0]!.triggerId).toBeTruthy();
    // the imported flow runs in the new app
    await d.post('/api/apps/crm2/entities/deal/records', { values: { title: 'Zulu', amount: 41 } }).expect(201);
    await drain(h);
    const tasks = (await d.get('/api/apps/crm2/entities/task/records').expect(200)).body.records as { values: { title: string } }[];
    expect(tasks.map((t) => t.values.title)).toEqual(['Call about Zulu (42)']);
    // the source app's flows did not run for it
    expect((await d.get('/api/apps/crm/entities/task/records').expect(200)).body.records).toHaveLength(0);
  });

  it('a deployment reconciles flows by name: changed in place, removed when the package no longer has them, failures reported', async () => {
    const v1 = (await d.post('/api/apps/crm/packages', {}).expect(201)).body.package as AppPackage;
    const target = (await d.post('/api/apps/packages/import', { package: v1, name: 'crm_prod' }).expect(201)).body as { id: string };
    // the source drops the webhook flow and changes the other
    await d.agent.delete('/api/apps/crm/flows/inbound').set('x-csrf-token', d.csrf).expect(204);
    await d.put('/api/apps/crm/flows/follow_up', { entity: 'deal', trigger: { kind: 'record', events: ['created', 'updated'] }, actions: [{ type: 'create', entity: 'task', values: { title: 'Again {{input.record.values.title}}' } }] }).expect(200);
    const v2 = (await d.post('/api/apps/crm/packages', {}).expect(201)).body.package as AppPackage;
    const app = await h.s.apps.app(p, target.id);
    const report = await h.s.apps.packages.apply(actor(), v2, app, { mode: 'deploy' });
    expect(report.flows).toMatchObject({ created: [], updated: ['follow_up'], removed: ['inbound'], failed: [] });
    const flow = (await d.get('/api/apps/crm_prod/flows/follow_up').expect(200)).body;
    expect(flow).toMatchObject({ trigger: { events: ['created', 'updated'] }, workflow: { publishedVersion: 2 } });
    expect(await h.s.db('app_triggers').where({ app_id: target.id })).toHaveLength(1);

    // a flow whose tool is not callable in the target is reported, the rest still applies
    const broken = { ...v2, flows: [{ ...v2.flows![0]!, actions: [{ type: 'tool', tool: 'no.such_tool', args: {}, onError: 'stop', retries: 0 }] }] } as AppPackage;
    const r2 = await h.s.apps.packages.apply(actor(), broken, app, { mode: 'deploy' });
    expect(r2.flows.failed).toEqual([{ name: 'follow_up', reason: expect.stringMatching(/no\.such_tool is not a tool published/) }]);
  });
});
