import { expect } from 'vitest';
import { loadPrincipal } from '../src/http/middleware.js';
import type { ServiceOverrides } from '../src/services.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * 1.6.0, Sprint 39b (B-8201 to B-8204): shared set-up for the package, pipeline and git suites: a workspace, a designer
 * (workflow-admin and member, so they may design apps and publish the workflows triggers name), an app with entities,
 * a form, a policy and a record trigger, and a published approval workflow.
 */

export interface Env {
  h: Harness;
  wsId: string;
}

export async function env(overrides: Record<string, string> = {}, services: ServiceOverrides = {}): Promise<Env> {
  const h = await harness(overrides, services);
  const wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Sales', 'confidential')).id;
  return { h, wsId };
}

export type C = Awaited<ReturnType<typeof designer>>;

async function wrap(e: Env, c: { agent: Client['agent']; csrf: string }) {
  const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
  await send('put', '/api/me/workspace', { workspaceId: e.wsId }).expect(200);
  return { ...c, post: (p: string, b?: object) => send('post', p, b), patch: (p: string, b?: object) => send('patch', p, b), put: (p: string, b?: object) => send('put', p, b), del: (p: string) => send('delete', p), get: (p: string) => c.agent.get(p) };
}

export async function designer(e: Env, name = 'dee') {
  const u = await localUser(e.h, name, ['workflow-admin', 'member'], 'confidential');
  await e.h.s.tenants.addMember(e.wsId, u.id);
  return { user: u, ...(await wrap(e, await loginAdmin(e.h, name))) };
}

export async function member(e: Env, name: string) {
  const u = await localUser(e.h, name, ['member'], 'confidential');
  await e.h.s.tenants.addMember(e.wsId, u.id);
  return { user: u, ...(await wrap(e, await login(e.h, name))) };
}

export const dealEntity = {
  name: 'deal',
  title: 'Deal',
  definition: {
    fields: [
      { name: 'title', type: 'string', required: true, indexed: true, unique: true, maxLength: 120 },
      { name: 'amount', type: 'number', indexed: true, min: 0 },
      { name: 'region', type: 'string', indexed: true, maxLength: 40 },
      { name: 'twice', type: 'formula', expression: 'amount * 2' }
    ],
    states: { initial: 'open', states: [{ name: 'open' }, { name: 'won' }], transitions: [{ from: ['open'], to: 'won' }] }
  }
};

export const taskEntity = { name: 'task', title: 'Task', definition: { fields: [{ name: 'name', type: 'string', required: true }, { name: 'deal', type: 'reference', entity: 'deal' }] } };

/** A published workflow started by record events (what an app trigger names). */
export async function publishWorkflow(e: Env, d: C, name: string, nodes: object[] = [], edges: object[] = [], triggerSource: 'record' | 'api' = 'record') {
  const p = (await loadPrincipal(e.h.s, e.h.tenantId, d.user.id, {}))!;
  p.workspaceId = e.wsId;
  const w = await e.h.s.workflows.create(p, { name, label: 'internal', graph: { nodes: [{ id: 'trigger', kind: 'trigger', title: 'Start', x: 20, y: 20, config: { source: triggerSource } }, ...nodes] as never, edges: edges as never, limits: {} } });
  const out = await e.h.s.workflows.publish(p, w.id, null);
  expect(out.version).toBe(1);
  return w.id;
}

/** The approval workflow a pipeline names: an api trigger, an approval by a workflow admin, a transform. */
export async function approvalWorkflow(e: Env, d: C, name = 'release-gate') {
  return publishWorkflow(
    e,
    d,
    name,
    [
      { id: 'ok', kind: 'approval', title: 'Release sign-off', x: 230, y: 24, config: { role: 'workflow-admin', timeoutMs: 3_600_000, show: 'Deploy {{input.app}} v{{input.package.version}} to {{input.to}}' } },
      { id: 'shape', kind: 'transform', title: 'Shape', x: 440, y: 24, config: { fields: { deployed: '{{input.deployment}}' } } }
    ],
    [
      { from: 'trigger', to: 'ok' },
      { from: 'ok', to: 'shape' }
    ],
    'api'
  );
}

/** The CRM app: deal and task entities, a form, a policy, a record trigger on a published workflow. */
export async function buildCrm(e: Env, d: C, name = 'crm', o: { trigger?: boolean; policy?: boolean } = {}) {
  await d.post('/api/apps', { name, title: 'CRM', label: 'confidential', description: 'Deals and tasks' }).expect(201);
  await ok(d.post(`/api/apps/${name}/entities`, dealEntity), 201);
  await ok(d.post(`/api/apps/${name}/entities`, taskEntity), 201);
  await d.post(`/api/apps/${name}/forms`, { name: 'new_deal', entity: 'deal', definition: { fields: [{ field: 'title' }, { field: 'amount' }] } }).expect(201);
  if (o.policy !== false) await d.post(`/api/apps/${name}/policies`, { name: 'Own region', entity: 'deal', subjects: [{ kind: 'role', value: 'member' }], rows: { field: 'region', op: 'eq', value: '$user.attributes.region' }, fields: {}, otherFields: { read: true, unmasked: true, create: true, update: true } }).expect(201);
  if (o.trigger !== false) {
    await publishWorkflow(e, d, 'on-update', [{ id: 'shape', kind: 'transform', title: 'Shape', x: 200, y: 20, config: { fields: { title: '{{input.record.values.title}}' } } }], [{ from: 'trigger', to: 'shape' }]);
    await d.post(`/api/apps/${name}/triggers`, { entity: 'deal', kind: 'record', events: ['updated'], workflow: 'on-update' }).expect(201);
  }
}

/** `.expect(status)` with the problem's detail in the failure, which supertest leaves out. */
export async function ok<T extends { status: number; body: { detail?: string; title?: string } }>(req: Promise<T> | T, status: number): Promise<T> {
  const r = await req;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${r.body?.title ?? ''} ${r.body?.detail ?? JSON.stringify(r.body).slice(0, 300)}`);
  return r;
}

export const audits = async (e: Env, action: string) => (await e.h.s.db('audit_events').where({ tenant_id: e.h.tenantId, action })) as { target: string; detail: string | null }[];

export async function drain(e: Env, times = 6): Promise<void> {
  for (let i = 0; i < times; i++) if (!(await e.h.s.jobs.runDue())) return;
}
