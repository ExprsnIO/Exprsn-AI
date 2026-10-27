import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPrincipal } from '../src/http/middleware.js';
import { graphSchema, validateGraph } from '../src/workflows/graph.js';
import { BUILTIN_TEMPLATES, rebindExtras, templateNeeds } from '../src/workflows/template-catalog.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';
import { seedRetrieval } from './retrieval-seed.js';

/*
 * 1.8.0, Sprint 47 (B-136): the workflow template gallery (migration 094, workflows/templates.ts). The six built-in
 * starters are real Workflows 2 graphs that publish once bound; "use template" goes through the bundle import path
 * with every reference listed as bound or missing; "save as template" keeps the workflow's label and the caller's
 * tenant and workspace; browsing is for members, using and saving for workflow admins; everything is audited.
 */

type Agent = Awaited<ReturnType<typeof loginAdmin>>;
const send = (c: { agent: Agent['agent']; csrf: string }, method: 'post' | 'put' | 'patch' | 'delete', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);

describe('workflow templates: the catalogue', () => {
  it('every starter parses, uses only existing step kinds and lists what it needs', () => {
    expect(BUILTIN_TEMPLATES.map((t) => t.name)).toEqual(['lead-follow-up', 'invoice-approval', 'weekly-report', 'new-starter-onboarding', 'webhook-to-record', 'document-intake']);
    for (const t of BUILTIN_TEMPLATES) {
      expect(() => graphSchema.parse(t.graph)).not.toThrow();
      expect(t.id).toMatch(/^[0-9A-Z]{26}$/);
      expect(t.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
    const needs = Object.fromEntries(BUILTIN_TEMPLATES.map((t) => [t.name, templateNeeds(t.graph)]));
    expect(needs['lead-follow-up']).toMatchObject({ decisions: ['lead-routing'], roles: ['member'] });
    expect(needs['invoice-approval']).toMatchObject({ roles: ['tenant-admin', 'workflow-admin'], tools: [] });
    expect(needs['weekly-report']).toMatchObject({ tools: ['connections.query'], profiles: ['report-writer'], connections: ['weekly-figures'] });
    expect(needs['new-starter-onboarding']).toMatchObject({ apps: ['onboarding'] });
    expect(needs['webhook-to-record']).toMatchObject({ apps: ['crm'] });
    expect(needs['document-intake']).toMatchObject({ tools: ['files.read', 'knowledge_add'], knowledge: ['intake'], roles: ['knowledge-curator', 'member', 'workflow-admin'] });
    // A switch with a deadline and an N-of-M quorum, a schedule, a webhook and an event trigger are all there.
    const kinds = BUILTIN_TEMPLATES.flatMap((t) => t.graph.nodes.map((n) => n.kind));
    for (const k of ['decision', 'branch', 'notify', 'wait', 'switch', 'approval', 'model', 'tool', 'record', 'transform']) expect(kinds).toContain(k);
    const invoice = BUILTIN_TEMPLATES.find((t) => t.name === 'invoice-approval')!.graph;
    expect(invoice.nodes.filter((n) => (n.config as { quorum?: { mode: string } }).quorum?.mode === 'count')).toHaveLength(2);
    // Roles, saved queries and knowledge bases re-bind inside approvals, notices and tool arguments.
    const intake = rebindExtras(BUILTIN_TEMPLATES.find((t) => t.name === 'document-intake')!.graph, { roles: { 'knowledge-curator': 'workflow-admin' }, knowledge: { intake: '01KB0000000000000000000000' } });
    expect(templateNeeds(intake)).toMatchObject({ knowledge: ['01KB0000000000000000000000'], roles: ['member', 'workflow-admin'] });
  });
});

describe('workflow templates: gallery, use and save as', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let admin: Agent;
  let adminId: string;
  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    ollama = await new FakeOllama().start();
    await seedRetrieval(h, ollama);
    const u = await localUser(h, 'wanda', ['workflow-admin', 'knowledge-curator', 'member'], 'confidential');
    adminId = u.id;
    admin = await loginAdmin(h, 'wanda');
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  const audits = async (action: string) => (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action })) as { target: string; detail: string; label: string }[];
  const byName = async (name: string) => {
    const list = (await admin.agent.get('/api/workflow-templates').expect(200)).body as { items: { id: string; name: string }[] };
    return list.items.find((t) => t.name === name)!;
  };

  it('browses the starters with search, category and tag filters, and previews a graph', async () => {
    await localUser(h, 'molly', ['member'], 'internal');
    const m = await login(h, 'molly');
    const all = (await m.agent.get('/api/workflow-templates').expect(200)).body;
    expect(all.items).toHaveLength(6);
    expect(all.items.every((t: { builtIn: boolean }) => t.builtIn)).toBe(true);
    expect(all.categories.map((c: { name: string }) => c.name)).toEqual(['Finance', 'Integration', 'Knowledge', 'People', 'Reporting', 'Sales']);
    expect(all.tags.find((t: { name: string }) => t.name === 'approvals')).toEqual({ name: 'approvals', count: 3 });
    expect((await m.agent.get('/api/workflow-templates?q=invoice').expect(200)).body.items.map((t: { name: string }) => t.name)).toEqual(['invoice-approval']);
    expect((await m.agent.get('/api/workflow-templates?category=Knowledge').expect(200)).body.items.map((t: { name: string }) => t.name)).toEqual(['document-intake']);
    expect((await m.agent.get('/api/workflow-templates?tag=schedule').expect(200)).body.items.map((t: { name: string }) => t.name)).toEqual(['weekly-report']);
    expect((await m.agent.get('/api/workflow-templates?q=nothing-like-this').expect(200)).body.items).toEqual([]);
    const preview = (await m.agent.get('/api/workflow-templates/weekly-report').expect(200)).body;
    expect(preview).toMatchObject({ name: 'weekly-report', trigger: 'schedule', steps: 4, needs: { profiles: ['report-writer'] } });
    expect(preview.graph.nodes.map((n: { kind: string }) => n.kind)).toEqual(['trigger', 'tool', 'model', 'notify']);
    // Members browse; using, checking and saving are for workflow admins.
    await send(m, 'post', `/api/workflow-templates/${preview.id}/use`, { name: 'mine' }).expect(403);
    await send(m, 'post', `/api/workflow-templates/${preview.id}/check`, {}).expect(403);
    await m.agent.get('/api/workflow-templates/options').expect(403);
    await m.agent.get('/api/workflow-templates/01ARZ3NDEKTSV4RRFFQ69G5FAV').expect(404);
    // Strict input: unknown query parameters are refused.
    await m.agent.get('/api/workflow-templates?colour=red').expect(400);
  });

  it('every built-in template validates and publishes after binding', async () => {
    const p = (await loadPrincipal(h.s, h.tenantId, adminId, {}))!;
    // What the starters need, made here under other names so every binding re-binds something.
    const table = (await send(admin, 'post', '/api/decision-tables', { name: 'my-lead-rules', label: 'internal', definition: { inputs: [{ name: 'source', type: 'string' }, { name: 'size', type: 'number' }], outputs: [{ name: 'priority', type: 'string' }], hitPolicy: 'first', rules: [{ when: { size: '>= 50' }, then: { priority: 'hot' } }, { when: {}, then: { priority: 'warm' } }] } }).expect(201)).body as { id: string };
    await send(admin, 'post', `/api/decision-tables/${table.id}/publish`, {}).expect(200);
    for (const [app, entity, fields] of [['people_ops', 'todo', ['title', 'due']], ['sales_crm', 'person', ['name', 'email', 'note']]] as const) {
      await send(admin, 'post', '/api/apps', { name: app, title: app, label: 'internal' }).expect(201);
      await send(admin, 'post', `/api/apps/${app}/entities`, { name: entity, title: entity, label: 'internal', definition: { fields: fields.map((f) => ({ name: f, type: 'string', maxLength: 200 })) } }).expect(201);
    }
    const kb = await h.s.knowledge.create(p, { name: 'Inbox', description: null, label: 'internal', embedModel: 'nomic-embed-text', reranker: null, sharing: 'members', workspaceId: null });
    const options = (await admin.agent.get('/api/workflow-templates/options').expect(200)).body;
    expect(options.profiles.map((x: { value: string }) => x.value)).toContain('general');
    expect(options.decisions.map((x: { value: string }) => x.value)).toContain('my-lead-rules');
    expect(options.apps.map((x: { value: string }) => x.value)).toEqual(expect.arrayContaining(['people_ops', 'sales_crm']));
    expect(options.knowledge.map((x: { value: string }) => x.value)).toContain(kb.id);
    expect(options.roles.map((x: { value: string }) => x.value)).toContain('workflow-admin');
    expect(options.tools.map((x: { value: string }) => x.value)).toEqual(expect.arrayContaining(['files.read', 'knowledge_add', 'connections.query']));

    const plan: Record<string, Record<string, Record<string, string>>> = {
      'lead-follow-up': { decisions: { 'lead-routing': 'my-lead-rules' } },
      'invoice-approval': { roles: { 'tenant-admin': 'system-admin' } },
      'weekly-report': { profiles: { 'report-writer': 'general' } },
      'new-starter-onboarding': { apps: { onboarding: 'people_ops' } },
      'webhook-to-record': { apps: { crm: 'sales_crm' } },
      'document-intake': { knowledge: { intake: kb.id } }
    };
    for (const [name, bindings] of Object.entries(plan)) {
      const t = await byName(name);
      const before = (await send(admin, 'post', `/api/workflow-templates/${t.id}/check`, {}).expect(200)).body as { bindings: { kind: string; status: string }[]; missing: number };
      const after = (await send(admin, 'post', `/api/workflow-templates/${t.id}/check`, { bindings }).expect(200)).body as { bindings: { kind: string; from: string; to: string; status: string; detail: string | null }[]; missing: number };
      const used = (await send(admin, 'post', `/api/workflow-templates/${t.id}/use`, { name: `my-${name}`, bindings }).expect(201)).body;
      expect(used.workflow).toMatchObject({ name: `my-${name}`, publishedVersion: null, label: 'internal' });
      expect(used.bindings).toEqual(after.bindings);
      // The only binding a test cannot satisfy is the weekly report's saved query (it needs a database connection).
      const missing = used.bindings.filter((b: { status: string }) => b.status === 'missing').map((b: { kind: string; to: string }) => `${b.kind}:${b.to}`);
      expect(missing).toEqual(name === 'weekly-report' ? ['connection:weekly-figures'] : []);
      if (name !== 'invoice-approval') expect(before.missing).toBeGreaterThan(after.missing);
      const v = (await send(admin, 'post', `/api/workflows/${used.workflow.id}/validate`, {}).expect(200)).body as { ok: boolean; errors: { message: string }[] };
      expect({ name, errors: v.errors }).toEqual({ name, errors: [] });
      const pub = await send(admin, 'post', `/api/workflows/${used.workflow.id}/publish`, { note: 'from the template' });
      expect({ name, status: pub.status, detail: pub.body.detail }).toMatchObject({ name, status: 200 });
      // Re-bound in the graph, and every starter still validates in the pure checker.
      const wf = (await admin.agent.get(`/api/workflows/${used.workflow.id}`).expect(200)).body;
      const text = JSON.stringify(wf.draft);
      for (const map of Object.values(bindings)) {
        for (const [from, to] of Object.entries(map)) {
          expect(text).toContain(to);
          expect(from === to || !text.includes(`"${from}"`)).toBe(true);
        }
      }
      expect(validateGraph(wf.draft, { label: 'internal', profile: () => ({ label: 'confidential' }) }).errors.filter((e) => e.code === 'structure' || e.code === 'cycle')).toEqual([]);
    }
    const used = await audits('workflow.template.used');
    expect(used).toHaveLength(6);
    expect(JSON.parse(used[0]!.detail)).toMatchObject({ template: expect.any(String), builtIn: true, templateVersion: '1.0.0' });
    const uses = (await admin.agent.get('/api/workflow-templates').expect(200)).body.items.map((t: { uses: number }) => t.uses);
    expect(uses).toEqual([1, 1, 1, 1, 1, 1]);
    // The webhook starter arrives switched off with no secret; the schedule and event starters start on publish.
    const hook = (await admin.agent.get(`/api/workflows/${(await h.s.db('workflows').where({ name: 'my-webhook-to-record' }).first()).id}/hook`).expect(200)).body;
    expect(hook).toMatchObject({ enabled: false, secretSet: false });
    const sched = await h.s.db('workflow_triggers').where({ workflow_id: (await h.s.db('workflows').where({ name: 'my-weekly-report' }).first()).id }).first();
    expect(sched).toMatchObject({ kind: 'schedule', cron: '0 8 * * 1', timezone: null });
  });

  it('reports what is missing, and publishing then names it', async () => {
    const t = await byName('lead-follow-up');
    const check = (await send(admin, 'post', `/api/workflow-templates/${t.id}/check`, { bindings: { roles: { member: 'no-such-role' } } }).expect(200)).body;
    expect(check.missing).toBe(2);
    expect(check.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'decision', from: 'lead-routing', to: 'lead-routing', status: 'missing', detail: expect.stringMatching(/decision table lead-routing/) }),
      expect.objectContaining({ kind: 'role', from: 'member', to: 'no-such-role', status: 'missing', detail: 'no-such-role is not a role steps can name here' })
    ]));
    const used = (await send(admin, 'post', `/api/workflow-templates/${t.id}/use`, { name: 'leads' }).expect(201)).body;
    expect(used.missing).toBe(1);
    expect(used.workflow.publishedVersion).toBeNull();
    const pub = await send(admin, 'post', `/api/workflows/${used.workflow.id}/publish`, {}).expect(422);
    expect(pub.body.errors.map((e: { message: string }) => e.message).join(' ')).toMatch(/lead-routing/);
    expect(JSON.parse((await audits('workflow.template.used'))[0]!.detail)).toMatchObject({ missing: ['decision:lead-routing'] });
    // A name that exists is a conflict; a label below the template's is refused.
    await send(admin, 'post', `/api/workflow-templates/${t.id}/use`, { name: 'leads' }).expect(409);
    await send(admin, 'post', `/api/workflow-templates/${t.id}/use`, { name: 'leads-public', label: 'public' }).expect(422);
    await send(admin, 'post', `/api/workflow-templates/${t.id}/use`, { name: 'leads-bad', bindings: { colours: {} } }).expect(400);
  });

  it('saves a workflow as a tenant template at its label, re-uses, refreshes and deletes it, all audited', async () => {
    const graph = { nodes: [{ id: 'trigger', kind: 'trigger', title: 'Trigger: manual', x: 20, y: 24, config: { source: 'manual' } }, { id: 'tell', kind: 'notify', title: 'Tell', x: 260, y: 24, config: { roles: ['workflow-admin'], users: [], title: 'Hello' } }], edges: [{ from: 'trigger', to: 'tell' }], limits: {} };
    const w = (await send(admin, 'post', '/api/workflows', { name: 'secret-flow', label: 'confidential', graph }).expect(201)).body;
    await send(admin, 'post', `/api/workflows/${w.id}/publish`, {}).expect(200);
    const saved = (await send(admin, 'post', '/api/workflow-templates', { workflow: w.id, name: 'secret-starter', title: 'Secret starter', summary: 'Tells the admins.', category: 'Operations', tags: ['notice', 'notice'], icon: 'bell' }).expect(201)).body;
    expect(saved).toMatchObject({ name: 'secret-starter', label: 'confidential', builtIn: false, version: '1.0.0', tags: ['notice'], sourceWorkflow: w.id, needs: { roles: ['workflow-admin'] } });
    expect(saved.graph.nodes).toHaveLength(2);
    await send(admin, 'post', '/api/workflow-templates', { workflow: w.id, name: 'secret-starter', title: 'Again', summary: 'x', category: 'Operations' }).expect(409);
    await send(admin, 'post', '/api/workflow-templates', { workflow: 'no-such-workflow', name: 'nope', title: 'x', summary: 'x', category: 'x' }).expect(404);
    // Clearance: someone cleared to internal neither sees nor uses it; another tenant never does.
    await localUser(h, 'ivy', ['workflow-admin', 'member'], 'internal');
    const ivy = await loginAdmin(h, 'ivy');
    expect((await ivy.agent.get('/api/workflow-templates').expect(200)).body.items.map((t: { name: string }) => t.name)).not.toContain('secret-starter');
    await ivy.agent.get(`/api/workflow-templates/${saved.id}`).expect(404);
    await send(ivy, 'post', `/api/workflow-templates/${saved.id}/use`, { name: 'stolen' }).expect(404);
    const foreign = (await h.s.db('workflow_templates').where({ id: saved.id }).first()) as Record<string, unknown>;
    await h.s.db('workflow_templates').insert({ ...foreign, id: '01OTHERTENANTTEMPLATE00000', scope: '01OTHERTENANT0000000000000', tenant_id: '01OTHERTENANT0000000000000', name: 'their-starter', label: 'internal' });
    expect((await admin.agent.get('/api/workflow-templates').expect(200)).body.items.map((t: { name: string }) => t.name)).not.toContain('their-starter');
    await admin.agent.get('/api/workflow-templates/01OTHERTENANTTEMPLATE00000').expect(404);
    await admin.agent.get('/api/workflow-templates/their-starter').expect(404);
    // Use it.
    const used = (await send(admin, 'post', `/api/workflow-templates/${saved.id}/use`, { name: 'secret-copy' }).expect(201)).body;
    expect(used.workflow).toMatchObject({ name: 'secret-copy', label: 'confidential', publishedVersion: null });
    // Change the source and refresh: the version goes up a minor step and the graph follows.
    await send(admin, 'put', `/api/workflows/${w.id}/draft`, { graph: { ...graph, nodes: [...graph.nodes, { id: 'pause', kind: 'wait', title: 'Pause', x: 500, y: 24, config: { ms: 60_000 } }], edges: [...graph.edges, { from: 'tell', to: 'pause' }] } }).expect(200);
    await send(admin, 'post', `/api/workflows/${w.id}/publish`, {}).expect(200);
    const refreshed = (await send(admin, 'patch', `/api/workflow-templates/${saved.id}`, { refresh: true, summary: 'Tells the admins, then pauses.' }).expect(200)).body;
    expect(refreshed).toMatchObject({ version: '1.1.0', summary: 'Tells the admins, then pauses.', steps: 3 });
    // Built-ins cannot be changed or deleted.
    const builtin = await byName('weekly-report');
    await send(admin, 'patch', `/api/workflow-templates/${builtin.id}`, { title: 'Mine now' }).expect(403);
    await send(admin, 'delete', `/api/workflow-templates/${builtin.id}`).expect(403);
    await send(admin, 'delete', `/api/workflow-templates/${saved.id}`).expect(204);
    await admin.agent.get(`/api/workflow-templates/${saved.id}`).expect(404);
    for (const a of ['workflow.template.saved', 'workflow.template.used', 'workflow.template.updated', 'workflow.template.deleted']) expect((await audits(a)).length).toBe(1);
    expect((await audits('workflow.template.saved'))[0]!.label).toBe('confidential');
    expect(JSON.parse((await audits('workflow.template.updated'))[0]!.detail)).toMatchObject({ refreshedFrom: w.id, workflowVersion: 2 });
  });
});
