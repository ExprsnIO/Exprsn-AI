import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GuardInput } from '../src/guardrails/types.js';
import { HOOK_MAX_BYTES, signHook } from '../src/workflows/signed-hooks.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';
import { drain } from './retrieval-seed.js';

/*
 * 1.8.0, Sprint 46 (B-130): the webhook trigger of every workflow (migration 085). POST /hooks/workflows/<tenant>/<id>
 * with the app flows' signed hook (workflows/signed-hooks.ts): HMAC-SHA256 over "<timestamp>.<body>", a five-minute
 * window, replays refused across instances, 64 KB, JSON objects only, off by default, the owner checked again, the
 * content rules before a run exists, the trigger's output schema, the workflow's label, rotation without grace.
 */

const graph = (source: string) => ({
  nodes: [
    { id: 'trigger', kind: 'trigger', title: 'Trigger', x: 20, y: 20, config: { source }, output: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
    { id: 'shape', kind: 'transform', title: 'Shape', x: 220, y: 20, config: { fields: { note: 'got {{input.title}}' } } }
  ],
  edges: [{ from: 'trigger', to: 'shape' }],
  limits: {}
});

describe('workflow webhooks (B-130)', () => {
  let h: Harness;
  let wsId: string;
  let d: Client & { post: (p: string, b?: object) => request.Test; put: (p: string, b?: object) => request.Test; get: (p: string) => request.Test; userId: string };
  let slug: string;
  let checks: string[];

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Ops', 'confidential')).id;
    const u = await localUser(h, 'wanda', ['workflow-admin', 'member'], 'confidential');
    await h.s.tenants.addMember(wsId, u.id);
    const c = await loginAdmin(h, 'wanda');
    const send = (method: 'post' | 'put', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
    await send('put', '/api/me/workspace', { workspaceId: wsId }).expect(200);
    d = { ...c, userId: u.id, post: (p, b) => send('post', p, b), put: (p, b) => send('put', p, b), get: (p) => c.agent.get(p) };
    slug = (await h.s.tenants.byId(h.tenantId))!.slug;
    checks = [];
    const real = h.s.guardrails.check.bind(h.s.guardrails);
    h.s.guardrails.check = async (i: GuardInput) => {
      if (i.source?.kind === 'workflow-hook') checks.push(`${i.checkpoint}@${i.label}`);
      if (i.source?.kind === 'workflow-hook' && i.text.includes('BLOCKME')) return { action: 'block', text: i.text, findings: [], reason: 'test rule' };
      if (i.source?.kind === 'workflow-hook' && i.text.includes('SECRET')) return { action: 'redact', text: i.text.replace('SECRET', '[redacted]'), findings: [] };
      return real(i);
    };
  });
  afterEach(async () => {
    await h.close();
  });

  const audits = async (action: string) => (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action })) as { detail: string | null; target: string }[];
  const reasons = async () => (await audits('workflow.hook.refused')).map((a) => JSON.parse(a.detail!).reason as string);
  async function webhookWorkflow(name = 'inbound', label = 'confidential') {
    const w = (await d.post('/api/workflows', { name, label, graph: graph('webhook') }).expect(201)).body as { id: string };
    await d.post(`/api/workflows/${w.id}/publish`, { note: 'v1' }).expect(200);
    return { id: w.id, path: `/hooks/workflows/${slug}/${w.id}` };
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

  it('is off by default; a good signature starts the published version as the owner, at the workflow label', async () => {
    const w = await webhookWorkflow();
    const st = (await d.get(`/api/workflows/${w.id}/hook`).expect(200)).body;
    expect(st).toMatchObject({ enabled: false, secretSet: false, live: false, path: w.path, trigger: { draft: 'webhook', published: 'webhook' }, maxBytes: HOOK_MAX_BYTES });
    expect(st.example).toContain('openssl dgst -sha256 -hmac "$EXPRSN_HOOK_SECRET"');
    // off: refused like a workflow that does not exist, and audited; an unknown workflow is not audited
    await hook(w.path, '{"title":"A"}', 'x').expect(404);
    await request(h.app).post(`/hooks/workflows/${slug}/01ARZ3NDEKTSV4RRFFQ69G5FAV`).set('content-type', 'application/json').send('{}').expect(404);
    expect(await reasons()).toEqual(['disabled']);
    // no turning on before there is a secret
    await d.put(`/api/workflows/${w.id}/hook`, { enabled: true }).expect(409);
    const made = (await d.post(`/api/workflows/${w.id}/hook/secret`).expect(201)).body as { secret: string; url: string };
    expect(made.secret).toMatch(/^whsec_/);
    expect(made.url).toMatch(new RegExp(`/hooks/workflows/${slug}/${w.id}$`));
    // sealed, never shown again
    const row = await h.s.db('workflow_hooks').where({ workflow_id: w.id }).first();
    expect(String(row.secret)).not.toContain(made.secret);
    expect(JSON.stringify((await d.get(`/api/workflows/${w.id}/hook`).expect(200)).body)).not.toContain(made.secret);
    expect(JSON.stringify((await d.get(`/api/workflows/${w.id}`).expect(200)).body)).not.toContain(made.secret);
    expect((await d.put(`/api/workflows/${w.id}/hook`, { enabled: true }).expect(200)).body).toMatchObject({ enabled: true, live: true, owner: d.userId });

    const res = await hook(w.path, '{"title":"Inbound one"}', made.secret).expect(202);
    expect(res.body.run).toMatch(/^[0-9A-Z]{26}$/);
    await drain(h);
    const run = await h.s.db('workflow_runs').where({ id: res.body.run }).first();
    expect(run).toMatchObject({ state: 'succeeded', trigger: 'webhook', label: 'confidential', created_by: d.userId, workflow_id: w.id, workspace_id: wsId });
    const view = (await d.get(`/api/workflow-runs/${res.body.run}`).expect(200)).body;
    expect(JSON.stringify(view)).toContain('got Inbound one');
    expect(checks).toEqual(['untrusted-content@confidential', 'user-input@confidential']);
    expect(await audits('workflow.hook.received')).toHaveLength(1);
    expect(await audits('workflow.hook.rotated')).toHaveLength(1);
    expect(await audits('workflow.hook.updated')).toHaveLength(1);
    const after = (await d.get(`/api/workflows/${w.id}/hook`).expect(200)).body;
    // the refusal before the hook existed is in the deliveries, not on a hook row's counter
    expect(after).toMatchObject({ received: 1, refused: 0, lastRunId: res.body.run });
    expect(after.deliveries.map((x: { outcome: string; status: number }) => `${x.outcome}:${x.status}`)).toEqual(['accepted:202', 'refused:404']);
  });

  it('refuses a bad signature, stale and future timestamps, a replay, an oversize or non-object body, a schema mismatch and a payload the rules block', async () => {
    const w = await webhookWorkflow();
    const { secret } = (await d.post(`/api/workflows/${w.id}/hook/secret`).expect(201)).body as { secret: string };
    await d.put(`/api/workflows/${w.id}/hook`, { enabled: true }).expect(200);
    const body = '{"title":"Twice"}';
    const now = () => Math.floor(Date.now() / 1000);
    await hook(w.path, body, secret, { sig: signHook('whsec_wrong', now(), body) }).expect(401);
    await hook(w.path, body, secret, { sig: 'sha256=zz' }).expect(401);
    // signed over the body alone (no timestamp): refused
    await hook(w.path, body, secret, { sig: `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` }).expect(401);
    await hook(w.path, body, secret, { ts: now() - 301 }).expect(401);
    await hook(w.path, body, secret, { ts: now() + 301 }).expect(401);
    const ts = now();
    await hook(w.path, body, secret, { ts }).expect(202);
    await hook(w.path, body, secret, { ts }).expect(409);
    await hook(w.path, JSON.stringify({ title: 'x'.repeat(HOOK_MAX_BYTES) }), secret).expect(413);
    await hook(w.path, 'title=x', secret, { type: 'application/x-www-form-urlencoded' }).expect(415);
    await hook(w.path, '[1,2]', secret).expect(400);
    await hook(w.path, '"text"', secret).expect(400);
    await hook(w.path, 'not json', secret).expect(400);
    // the trigger's output schema: title is required
    expect((await hook(w.path, '{"name":"no title"}', secret).expect(400)).body.detail).toMatch(/does not match the trigger/);
    await hook(w.path, '{"title":"BLOCKME"}', secret).expect(422);
    // a redaction that keeps a JSON object goes on with the redacted payload
    const red = await hook(w.path, '{"title":"SECRET deal"}', secret).expect(202);
    await drain(h);
    expect(JSON.stringify((await d.get(`/api/workflow-runs/${red.body.run}`).expect(200)).body)).toContain('[redacted] deal');
    expect(await h.s.db('workflow_runs').where({ workflow_id: w.id })).toHaveLength(2);
    expect(await reasons()).toEqual(expect.arrayContaining(['bad signature', 'stale timestamp', 'replay', 'oversize', 'not an object', 'not json', 'schema', 'guardrail untrusted-content']));
    // the hook turned off: refused again
    await d.put(`/api/workflows/${w.id}/hook`, { enabled: false }).expect(200);
    await hook(w.path, '{"title":"Off"}', secret).expect(404);
    // the workflow no longer started by its webhook (a new version with a manual trigger): refused
    await d.put(`/api/workflows/${w.id}/hook`, { enabled: true }).expect(200);
    await hook(w.path, '{"title":"Still on"}', secret).expect(202);
    await d.put(`/api/workflows/${w.id}/draft`, { graph: graph('manual') }).expect(200);
    await d.post(`/api/workflows/${w.id}/publish`, { note: 'manual now' }).expect(200);
    await hook(w.path, '{"title":"Manual now"}', secret).expect(404);
    // an owner who lost the right to run workflows: refused, and nothing starts
    await d.put(`/api/workflows/${w.id}/draft`, { graph: graph('webhook') }).expect(200);
    await d.post(`/api/workflows/${w.id}/publish`, { note: 'webhook again' }).expect(200);
    await h.s.users.setRoles(d.userId, 'direct', ['workflow-admin']);
    expect((await hook(w.path, '{"title":"No owner"}', secret).expect(409)).body.detail).toMatch(/may no longer run workflows/);
    // a workflow that is gone: 404, and no audit for an unknown workflow
    await h.s.db('workflows').where({ id: w.id }).delete();
    const before = (await audits('workflow.hook.refused')).length;
    await hook(w.path, '{"title":"Gone"}', secret).expect(404);
    expect(await audits('workflow.hook.refused')).toHaveLength(before);
  });

  it('rotates the secret: the old one stops at once, the new one works; only webhook workflows and workflow admins', async () => {
    const w = await webhookWorkflow();
    const first = (await d.post(`/api/workflows/${w.id}/hook/secret`).expect(201)).body.secret as string;
    await d.put(`/api/workflows/${w.id}/hook`, { enabled: true }).expect(200);
    await hook(w.path, '{"title":"One"}', first).expect(202);
    const second = (await d.post(`/api/workflows/${w.id}/hook/secret`).expect(201)).body.secret as string;
    expect(second).not.toBe(first);
    await hook(w.path, '{"title":"Two"}', first).expect(401);
    await hook(w.path, '{"title":"Two"}', second).expect(202);
    expect(JSON.parse((await audits('workflow.hook.rotated'))[1]!.detail!)).toMatchObject({ first: false, enabled: true });
    // a manual workflow has no hook to make
    const manual = (await d.post('/api/workflows', { name: 'by-hand', label: 'internal', graph: graph('manual') }).expect(201)).body;
    expect((await d.post(`/api/workflows/${manual.id}/hook/secret`).expect(409)).body.title).toBe('Not a webhook workflow');
    // a member without workflows:manage
    const m = await localUser(h, 'milo', ['member'], 'confidential');
    await h.s.tenants.addMember(wsId, m.id);
    const mc = await login(h, 'milo');
    await mc.agent.put('/api/me/workspace').set('x-csrf-token', mc.csrf).send({ workspaceId: wsId }).expect(200);
    await mc.agent.post(`/api/workflows/${w.id}/hook/secret`).set('x-csrf-token', mc.csrf).send({}).expect(403);
    await mc.agent.get(`/api/workflows/${w.id}/hook`).expect(403);
    // unknown fields are refused (zod, strict)
    await d.put(`/api/workflows/${w.id}/hook`, { enabled: true, owner: m.id }).expect(400);
  });

  it('a bundle carries no hook: the imported workflow arrives switched off with no secret', async () => {
    const w = await webhookWorkflow('exported');
    await d.post(`/api/workflows/${w.id}/hook/secret`).expect(201);
    await d.put(`/api/workflows/${w.id}/hook`, { enabled: true }).expect(200);
    const bundle = (await d.get(`/api/workflows/${w.id}/bundle`).expect(200)).body;
    expect(JSON.stringify(bundle)).not.toMatch(/whsec_/);
    const out = (await d.post('/api/workflows/import', { bundle, name: 'imported' }).expect(201)).body;
    expect(out.bindings).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'trigger', from: 'webhook', status: 'on publish' })]));
    const st = (await d.get(`/api/workflows/${out.workflow.id}/hook`).expect(200)).body;
    expect(st).toMatchObject({ enabled: false, secretSet: false, live: false, trigger: { draft: 'webhook', published: null } });
  });
});
