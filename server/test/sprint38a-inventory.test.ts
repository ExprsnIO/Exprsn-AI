import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';
import { seedGateway } from './seed-gateway.js';

const send = (c: Client, method: 'post' | 'put' | 'patch' | 'delete', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);

describe('B-7301, B-7302: the AI system inventory', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let modelAdmin: Client;
  let author: Client;
  let reviewer: Client;
  let authorId: string;

  beforeEach(async () => {
    ollama = await new FakeOllama().start();
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    await seedGateway(h, ollama);
    await localUser(h, 'ma', ['model-admin'], 'confidential');
    modelAdmin = await loginAdmin(h, 'ma');
    authorId = (await localUser(h, 'author', ['tool-admin'], 'confidential')).id;
    author = await loginAdmin(h, 'author');
    await localUser(h, 'reviewer', ['tool-admin'], 'confidential');
    reviewer = await loginAdmin(h, 'reviewer');
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  const draftAgent = async (name = 'Triage') =>
    (await send(author, 'post', '/api/admin/registry', { kind: 'agent', name, version: '1.0.0', description: 'Routes incoming support questions to the billing, access or outage specialist and summarises the case for them exactly.', label: 'confidential', definition: { profile: 'general', systemPrompt: 'Be brief.', tools: [], budgets: { steps: 5, tokens: 2000, wallSeconds: 30, toolCalls: 2 } } }).expect(201)).body as { id: string };

  it('lists every kind of system with its lineage and marks those without an owner incomplete', async () => {
    const agent = await draftAgent();
    const inv = (await modelAdmin.agent.get('/api/admin/inventory').expect(200)).body as { items: Record<string, unknown>[]; counts: { total: number; incomplete: number } };
    const kinds = new Set(inv.items.map((x) => x.kind));
    expect(kinds).toEqual(new Set(['model', 'profile', 'agent']));
    const model = inv.items.find((x) => x.kind === 'model')!;
    expect(model).toMatchObject({ name: 'llama3.1:8b', status: 'approved', complete: false, missing: expect.arrayContaining(['owner']) });
    const profile = inv.items.find((x) => x.kind === 'profile')!;
    // A profile's lineage runs down to the model and its base weights.
    expect((profile.lineage as { kind: string; name: string }[]).map((l) => `${l.kind}:${l.name}`)).toEqual(['profile:general', 'model:llama3.1:8b', expect.stringMatching(/^base:/)]);
    const a = inv.items.find((x) => x.kind === 'agent')!;
    expect(a).toMatchObject({ id: agent.id, name: 'Triage', status: 'draft', complete: false });
    expect((a.lineage as { kind: string }[]).map((l) => l.kind)).toEqual(['profile', 'model', 'base']);
    expect(inv.counts).toEqual({ total: 3, incomplete: 3, withIssues: 0 });

    // Members and tool admins do not read the inventory; it is the model admin's.
    await author.agent.get('/api/admin/inventory').expect(403);
  });

  it('an agent with no owner cannot be published once the tenant requires owners; naming one lets it through', async () => {
    const agent = await draftAgent();
    await send(author, 'post', `/api/admin/registry/${agent.id}/submit`).expect(200);
    // Off by default: the review goes through.
    expect((await modelAdmin.agent.get('/api/admin/inventory/settings').expect(200)).body).toMatchObject({ requireOwner: false });
    await send(modelAdmin, 'put', '/api/admin/inventory/settings', { requireOwner: true }).expect(200);
    const refused = await send(reviewer, 'post', `/api/admin/registry/${agent.id}/review`, { decision: 'approve' }).expect(409);
    expect(refused.body.detail).toMatch(/no owner in the AI inventory/);
    expect((await h.s.registry.get(h.tenantId, agent.id))?.status).toBe('in_review');

    // The owner must be a user of the tenant; a stranger's id is refused.
    await send(modelAdmin, 'patch', `/api/admin/inventory/agent/${agent.id}`, { ownerId: '01HZZZZZZZZZZZZZZZZZZZZZZZ' }).expect(409);
    const set = (await send(modelAdmin, 'patch', `/api/admin/inventory/agent/${agent.id}`, { ownerId: authorId, oversightRole: 'Support lead reviews weekly', provenance: 'Prompts written in-house; no customer data' }).expect(200)).body;
    expect(set).toMatchObject({ ownerId: authorId, ownerName: 'AUTHOR', oversightRole: 'Support lead reviews weekly', complete: true, missing: [] });
    await send(reviewer, 'post', `/api/admin/registry/${agent.id}/review`, { decision: 'approve' }).expect(200);
    expect((await h.s.registry.get(h.tenantId, agent.id))?.status).toBe('published');

    // Audited, with what changed.
    const events = await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'inventory.updated' });
    expect(events.length).toBe(1);
    expect(JSON.parse(String(events[0]!.detail))).toMatchObject({ changed: ['ownerId', 'oversightRole', 'provenance'], complete: true, wasComplete: false });
    expect((await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'inventory.settings.updated' })).length).toBe(1);
  });

  it('exports the register with every published agent, its lineage and the impact assessment (CSV and JSON)', async () => {
    const agent = await draftAgent('Billing');
    await send(author, 'post', `/api/admin/registry/${agent.id}/submit`).expect(200);
    await send(reviewer, 'post', `/api/admin/registry/${agent.id}/review`, { decision: 'approve' }).expect(200);
    await send(modelAdmin, 'patch', `/api/admin/inventory/agent/${agent.id}`, { ownerId: authorId, impactAssessment: 'Limited risk: answers billing questions; a person approves refunds.' }).expect(200);

    const json = (await modelAdmin.agent.get('/api/admin/inventory/register?format=json').expect(200)).body as { systems: Record<string, unknown>[] };
    const row = json.systems.find((x) => x.kind === 'agent')!;
    expect(row).toMatchObject({ name: 'Billing', status: 'published', owner: 'AUTHOR', lineage: expect.stringMatching(/^profile:general > model:llama3\.1:8b > base:/), impactAssessment: 'Limited risk: answers billing questions; a person approves refunds.', complete: true });

    const csv = await modelAdmin.agent.get('/api/admin/inventory/register').expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toMatch(/ai-inventory-.*\.csv/);
    const lines = csv.text.split('\r\n').filter(Boolean);
    expect(lines[0]).toBe('kind,id,name,version,status,label,owner,ownerId,oversightRole,provenance,lineage,lineageNote,openFlags,failedEvaluations,knownIssues,impactAssessment,complete,missing');
    expect(lines.find((l) => l.startsWith('agent,'))).toContain('profile:general > model:llama3.1:8b > base:');
    expect((await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'inventory.exported' })).length).toBe(2);
  });
});
