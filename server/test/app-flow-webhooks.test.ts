import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOOK_MAX_BYTES, signHook } from '../src/apps/flow-hooks.js';
import type { GuardInput } from '../src/guardrails/types.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';
import { drain } from './retrieval-seed.js';

/*
 * The incoming webhook trigger of app flows (migration 082_app_flow_integration): POST /hooks/apps/<tenant>/<flow>,
 * HMAC-SHA256 over "<timestamp>.<body>" with the flow's secret, a five-minute window, replays refused, a body cap,
 * the content rules before any step, off by default, audited.
 */

const dealDefinition = { fields: [{ name: 'title', type: 'string', required: true, indexed: true, maxLength: 120 }, { name: 'notes', type: 'string', maxLength: 5000 }] };

describe('app flow webhooks', () => {
  let h: Harness;
  let wsId: string;
  let d: Client & { post: (p: string, b?: object) => request.Test; put: (p: string, b?: object) => request.Test; get: (p: string) => request.Test; userId: string };
  let slug: string;
  let checks: string[];

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Sales', 'confidential')).id;
    const u = await localUser(h, 'dee', ['workflow-admin', 'member'], 'confidential');
    await h.s.tenants.addMember(wsId, u.id);
    const c = await loginAdmin(h, 'dee');
    const send = (method: 'post' | 'put' | 'patch', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
    await send('put', '/api/me/workspace', { workspaceId: wsId }).expect(200);
    d = { ...c, userId: u.id, post: (p, b) => send('post', p, b), put: (p, b) => send('put', p, b), get: (p) => c.agent.get(p) };
    slug = (await h.s.tenants.byId(h.tenantId))!.slug;
    await d.post('/api/apps', { name: 'crm', title: 'CRM', label: 'confidential', workspaceId: wsId }).expect(201);
    await d.post('/api/apps/crm/entities', { name: 'deal', title: 'Deal', label: 'internal', definition: dealDefinition }).expect(201);
    // The content rules see every payload; a payload saying BLOCKME is refused, one saying SECRET is redacted.
    checks = [];
    const real = h.s.guardrails.check.bind(h.s.guardrails);
    h.s.guardrails.check = async (i: GuardInput) => {
      if (i.source?.kind === 'app-flow-hook') checks.push(i.checkpoint);
      if (i.source?.kind === 'app-flow-hook' && i.text.includes('BLOCKME')) return { action: 'block', text: i.text, findings: [], reason: 'test rule' };
      if (i.source?.kind === 'app-flow-hook' && i.text.includes('SECRET')) return { action: 'redact', text: i.text.replace('SECRET', '[redacted]'), findings: [] };
      return real(i);
    };
  });
  afterEach(async () => {
    await h.close();
  });

  const audits = async (action: string) => (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action })) as { detail: string | null; target: string }[];
  async function webhookFlow() {
    return (await d.post('/api/apps/crm/flows', { name: 'inbound', entity: 'deal', trigger: { kind: 'webhook' }, actions: [{ type: 'create', entity: 'deal', values: { title: '{{input.payload.title}}', notes: 'from {{input.event}}' } }] }).expect(201)).body as { id: string; workflowId: string; hook: { enabled: boolean; path: string; secretSet: boolean } };
  }
  const hook = (path: string, body: string, secret: string, o: { ts?: number; sig?: string; type?: string } = {}) => {
    const ts = o.ts ?? Math.floor(Date.now() / 1000);
    return request(h.app)
      .post(path)
      .set('content-type', o.type ?? 'application/json')
      .set('x-exprsn-timestamp', String(ts))
      .set('x-exprsn-signature', o.sig ?? signHook(secret, ts, body))
      .send(body);
  };
  const deals = async () => ((await h.s.db('app_records').count({ n: '*' })) as { n: number }[])[0]!.n;

  it('is off by default; a good signature starts the flow as its owner at the flow label', async () => {
    const f = await webhookFlow();
    expect(f.hook).toMatchObject({ enabled: false, secretSet: false, path: `/hooks/apps/${slug}/${f.id}` });
    // off: refused like a flow that does not exist, and audited
    await hook(f.hook.path, '{"title":"A"}', 'x').expect(404);
    await request(h.app).post(`/hooks/apps/${slug}/01ARZ3NDEKTSV4RRFFQ69G5FAV`).set('content-type', 'application/json').send('{}').expect(404);
    expect((await audits('app.flow.hook.refused')).map((a) => JSON.parse(a.detail!).reason)).toEqual(['disabled']);
    // no turning on before there is a secret
    await d.put(`/api/apps/crm/flows/${f.id}/hook`, { enabled: true }).expect(409);
    const made = (await d.post(`/api/apps/crm/flows/${f.id}/hook/secret`).expect(201)).body as { secret: string; url: string };
    expect(made.secret).toMatch(/^whsec_/);
    expect(made.url).toMatch(new RegExp(`/hooks/apps/${slug}/${f.id}$`));
    // the secret is sealed, never shown again
    const row = await h.s.db('app_flows').where({ id: f.id }).first();
    expect(String(row.hook_secret)).not.toContain(made.secret);
    expect(JSON.stringify((await d.get(`/api/apps/crm/flows/${f.id}`).expect(200)).body)).not.toContain(made.secret);
    await d.put(`/api/apps/crm/flows/${f.id}/hook`, { enabled: true }).expect(200);

    const before = await deals();
    const res = await hook(f.hook.path, '{"title":"Inbound one"}', made.secret).expect(202);
    expect(res.body.run).toMatch(/^[0-9A-Z]{26}$/);
    await drain(h);
    const run = await h.s.db('workflow_runs').where({ id: res.body.run }).first();
    expect(run).toMatchObject({ state: 'succeeded', trigger: 'webhook', label: 'internal', created_by: d.userId });
    expect(await deals()).toBe(before + 1);
    const rec = (await d.get('/api/apps/crm/entities/deal/records?limit=5').expect(200)).body.records[0];
    expect(rec.values).toMatchObject({ title: 'Inbound one', notes: 'from webhook' });
    expect(checks).toEqual(['untrusted-content', 'user-input']);
    expect(await audits('app.flow.hook.received')).toHaveLength(1);
    expect((await audits('app.flow.hook.rotated')).length).toBe(1);
    expect((await audits('app.flow.hook.updated')).length).toBe(1);
  });

  it('refuses a bad signature, a stale timestamp, a replay, an oversize body, a non-JSON body and a payload the rules block', async () => {
    const f = await webhookFlow();
    const { secret } = (await d.post(`/api/apps/crm/flows/${f.id}/hook/secret`).expect(201)).body as { secret: string };
    await d.put(`/api/apps/crm/flows/${f.id}/hook`, { enabled: true }).expect(200);
    const body = '{"title":"Twice"}';
    await hook(f.hook.path, body, secret, { sig: signHook('whsec_wrong', Math.floor(Date.now() / 1000), body) }).expect(401);
    await hook(f.hook.path, body, secret, { sig: 'sha256=zz' }).expect(401);
    // signed with the body only (no timestamp): refused
    await hook(f.hook.path, body, secret, { sig: `sha256=${(await import('node:crypto')).createHmac('sha256', secret).update(body).digest('hex')}` }).expect(401);
    await hook(f.hook.path, body, secret, { ts: Math.floor(Date.now() / 1000) - 301 }).expect(401);
    await hook(f.hook.path, body, secret, { ts: Math.floor(Date.now() / 1000) + 301 }).expect(401);
    const ts = Math.floor(Date.now() / 1000);
    await hook(f.hook.path, body, secret, { ts }).expect(202);
    await hook(f.hook.path, body, secret, { ts }).expect(409);
    const big = JSON.stringify({ title: 'x'.repeat(HOOK_MAX_BYTES) });
    await hook(f.hook.path, big, secret).expect(413);
    await hook(f.hook.path, 'title=x', secret, { type: 'application/x-www-form-urlencoded' }).expect(415);
    await hook(f.hook.path, '[1,2]', secret).expect(400);
    await hook(f.hook.path, '{"title":"BLOCKME"}', secret).expect(422);
    // a redaction that keeps a JSON object goes on with the redacted payload
    const red = await hook(f.hook.path, '{"title":"SECRET deal"}', secret).expect(202);
    await drain(h);
    const runs = (await h.s.db('workflow_runs').where({ workflow_id: f.workflowId })) as { id: string }[];
    expect(runs).toHaveLength(2);
    const view = (await d.get(`/api/workflow-runs/${red.body.run}`).expect(200)).body;
    expect(JSON.stringify(view.input ?? view.steps)).toContain('[redacted] deal');
    const reasons = (await audits('app.flow.hook.refused')).map((a) => JSON.parse(a.detail!).reason);
    expect(reasons).toEqual(expect.arrayContaining(['bad signature', 'stale timestamp', 'replay', 'oversize', 'not an object', 'guardrail untrusted-content']));
    // turned off, or the flow disabled: refused again
    await d.put(`/api/apps/crm/flows/${f.id}/hook`, { enabled: false }).expect(200);
    await hook(f.hook.path, '{"title":"Off"}', secret).expect(404);
    await d.put(`/api/apps/crm/flows/${f.id}/hook`, { enabled: true }).expect(200);
    await d.agent.patch(`/api/apps/crm/flows/${f.id}`).set('x-csrf-token', d.csrf).send({ enabled: false }).expect(200);
    await hook(f.hook.path, '{"title":"Flow off"}', secret).expect(404);
  });

  it('rotates the secret: the old one stops at once, the new one works', async () => {
    const f = await webhookFlow();
    const first = (await d.post(`/api/apps/crm/flows/${f.id}/hook/secret`).expect(201)).body.secret as string;
    await d.put(`/api/apps/crm/flows/${f.id}/hook`, { enabled: true }).expect(200);
    await hook(f.hook.path, '{"title":"One"}', first).expect(202);
    const second = (await d.post(`/api/apps/crm/flows/${f.id}/hook/secret`).expect(201)).body.secret as string;
    expect(second).not.toBe(first);
    await hook(f.hook.path, '{"title":"Two"}', first).expect(401);
    await hook(f.hook.path, '{"title":"Two"}', second).expect(202);
    expect(JSON.parse((await audits('app.flow.hook.rotated'))[1]!.detail!)).toMatchObject({ first: false, enabled: true });
    // hook routes are for webhook flows only, and need workflows:manage
    const manual = (await d.post('/api/apps/crm/flows', { name: 'by_hand', entity: 'deal', trigger: { kind: 'manual' }, actions: [{ type: 'wait', minutes: 1 }] }).expect(201)).body;
    await d.post(`/api/apps/crm/flows/${manual.id}/hook/secret`).expect(409);
    const m = await localUser(h, 'mia', ['member'], 'internal');
    await h.s.tenants.addMember(wsId, m.id);
    const mc = await login(h, 'mia');
    await mc.agent.post(`/api/apps/crm/flows/${f.id}/hook/secret`).set('x-csrf-token', mc.csrf).send({}).expect(403);
    // a webhook flow that becomes a manual flow stops taking webhooks
    await d.put(`/api/apps/crm/flows/${f.id}`, { entity: 'deal', trigger: { kind: 'manual' }, actions: [{ type: 'wait', minutes: 1 }] }).expect(200);
    await hook(f.hook.path, '{"title":"Three"}', second).expect(404);
  });
});
