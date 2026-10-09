/*
 * 1.7.0, Sprint 41d (B-12301 to B-12304): finding what you can use.
 *
 *   B-12301 the catalogue: the workflows, agents, tools and skills a person may use in a workspace, grouped by
 *           category, with the call and an example prompt; what the profile's allow-list hides is "not on this
 *           profile" with the profiles that offer it; never an entry above the person's clearance.
 *   B-12302 publish notices: once per person and entry, only to members whose clearance reaches its label, as each
 *           one happens, in a weekly digest, or not at all; a notice links to the catalogue entry.
 *   B-12303 composer suggestions: up to three entries ranked by the embedding profile's similarity to the draft; a
 *           dismissed one stays away for the conversation; off per profile; vectors cached per entry version.
 *   B-12304 the registry's submit asks for a purpose, an example prompt and a category for entries offered in chat,
 *           naming what is missing; the reviewer sees the catalogue card; older entries keep working without them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProfileRow } from '../src/gateway/repo.js';
import type { WfGraph } from '../src/workflows/graph.js';
import { FakeMcp } from './fake-mcp.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';
import { seedGateway } from './seed-gateway.js';

type Client = { agent: Awaited<ReturnType<typeof login>>['agent']; csrf: string; cookie: string };
const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);
const put = (c: Client, url: string, body: object = {}) => c.agent.put(url).set('x-csrf-token', c.csrf).send(body);
const patch = (c: Client, url: string, body: object = {}) => c.agent.patch(url).set('x-csrf-token', c.csrf).send(body);
const GB = 1_000_000_000;
const DAY = 24 * 60 * 60_000;

interface Entry {
  key: string;
  kind: string;
  name: string;
  category: string;
  call: string;
  compose: string;
  example: string | null;
  available: boolean;
  reason: string | null;
  profiles: string[];
  missing: string[];
}

const graph: WfGraph = {
  nodes: [
    { id: 'trigger', kind: 'trigger', title: 'Trigger', x: 20, y: 24, config: { source: 'api' }, output: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    { id: 'shape', kind: 'transform', title: 'Shape', x: 230, y: 24, config: { fields: { summary: 'Summary of {{input.text}}' } } }
  ],
  edges: [{ from: 'trigger', to: 'shape' }],
  limits: {}
};

describe('Sprint 41d: finding what you can use (B-12301 to B-12304)', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let mcp: FakeMcp;

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000', REGISTRY_DISCOVERY_REQUIRED: 'true' });
    ollama = await new FakeOllama().start();
    ollama.chatDelayMs = 0;
    mcp = await new FakeMcp().start();
    mcp.tools = [{ name: 'lookup_invoice', description: 'Looks up an invoice by number.', inputSchema: { type: 'object', properties: { number: { type: 'string' } }, required: ['number'] }, annotations: { readOnlyHint: true }, run: (a) => ({ invoice: a.number }) }];
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
    await mcp.stop();
  });

  async function setup() {
    // general: calculate, and only the skill "concise"; analyst: the invoice tool and every skill; embed: the embedding profile.
    const g = await seedGateway(h, ollama, { tools: ['calculate'], skills: ['concise'], label: 'internal' });
    const repo = h.s.gateway.repo;
    ollama.addAvailable({ name: 'nomic-embed-text', size: GB, capabilities: ['embedding'] });
    const em = await repo.createModel({ name: 'nomic-embed-text', source: 'Ollama library', expectedDigest: null, license: { name: 'test' }, label: 'confidential', notes: null, requestedBy: 'x', requestedTenant: h.tenantId });
    await repo.updateModel(em.id, { state: 'approved', import_state: 'pulled', capabilities: ['embedding'], size_bytes: GB });
    await repo.place(em.id, g.pool.id, 'warm', 'x');
    const t = Date.now();
    const base: ProfileRow = { ...g.profile, created_at: t, updated_at: t };
    await repo.createProfile({ ...base, id: 'ANALYST'.padEnd(26, '0'), name: 'analyst', display_name: 'Analyst', tools: ['calculate', 'jira.lookup_invoice'], skills: null });
    await repo.createProfile({ ...base, id: 'EMBED'.padEnd(26, '0'), name: 'embed', display_name: 'Embed', model_id: em.id, tools: [], skills: null });
    await h.s.gateway.pollAll();

    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Legal', 'confidential')).id;
    const people = {
      tadmin: await localUser(h, 'tadmin', ['tool-admin', 'member'], 'confidential'),
      tadmin2: await localUser(h, 'tadmin2', ['tool-admin', 'member'], 'confidential'),
      wadmin: await localUser(h, 'wadmin', ['workflow-admin', 'member'], 'confidential'),
      mia: await localUser(h, 'mia', ['member'], 'internal'),
      noah: await localUser(h, 'noah', ['member'], 'confidential'),
      olga: await localUser(h, 'olga', ['member'], 'confidential'),
      pat: await localUser(h, 'pat', ['member'], 'confidential')
    };
    for (const u of Object.values(people)) await h.s.tenants.addMember(ws, u.id);
    const c = { t: await loginAdmin(h, 'tadmin'), t2: await loginAdmin(h, 'tadmin2'), w: await loginAdmin(h, 'wadmin'), mia: await login(h, 'mia'), noah: await login(h, 'noah'), olga: await login(h, 'olga'), pat: await login(h, 'pat') };
    for (const x of Object.values(c)) await put(x, '/api/me/workspace', { workspaceId: ws }).expect(200);
    const reg = (await post(c.t, '/api/admin/mcp-servers', { name: 'jira', url: mcp.url }).expect(201)).body;
    await post(c.t, `/api/admin/mcp-servers/${reg.id}/tools/lookup_invoice/approve`, { sideEffect: 'read', confirm: 'never', label: 'confidential' }).expect(200);
    return { ...c, ws, people };
  }
  type Ctx = Awaited<ReturnType<typeof setup>>;

  const catalogue = async (c: Client, profile = 'general') => (await c.agent.get(`/api/catalog?profile=${profile}`).expect(200)).body as { profile: string; entries: Entry[]; categories: { name: string; count: number }[]; counts: { available: number; notOnProfile: number } };
  const notices = async (userId: string) => (await h.s.db('notifications').where({ user_id: userId, kind: 'catalog' }).orderBy('created_at')) as { title: string; route: string; label: string; body: string | null }[];

  async function publishWorkflow(c: Ctx) {
    const w = (await post(c.w, '/api/workflows', { name: 'summarise-contract', description: 'Summarises a contract: the parties, the term, the obligations and the risks.', label: 'internal' }).expect(201)).body;
    await put(c.w, `/api/workflows/${w.id}/draft`, { graph }).expect(200);
    await put(c.w, `/api/workflows/${w.id}/discovery`, { purpose: 'Read a contract and get its summary in one page.', examples: ['Summarise this contract for me'], category: 'Documents' }).expect(200);
    await post(c.w, `/api/workflows/${w.id}/publish`).expect(200);
    return w as { id: string };
  }
  const agent = (name: string, label: string, card: Record<string, unknown>) => ({ kind: 'agent', name, version: '1.0.0', description: `${name}: reviews the documents it is given and reports what needs attention.`, label, definition: { profile: 'general', systemPrompt: 'Be exact.', tools: [], budgets: { steps: 6, tokens: 4000, wallSeconds: 60, toolCalls: 2 } }, ...card });
  const card = { purpose: 'Check a contract before it is signed.', examples: ['Review this NDA for unusual terms'], category: 'Documents' };
  async function publishEntry(c: Ctx, body: Record<string, unknown>) {
    const e = (await post(c.t, '/api/admin/registry', body).expect(201)).body;
    await post(c.t, `/api/admin/registry/${e.id}/submit`).expect(200);
    await post(c.t2, `/api/admin/registry/${e.id}/review`, { decision: 'approve' }).expect(200);
    return e as { id: string };
  }

  it('B-12301: a member sees a newly published workflow with its call; an entry above their clearance is not listed; the allow-list hides are "not on this profile"', async () => {
    const c = await setup();
    await publishWorkflow(c);
    await publishEntry(c, agent('Contract reviewer', 'internal', card));
    await publishEntry(c, agent('Deal desk', 'confidential', { ...card, category: 'Finance', examples: ['Price this deal'] }));
    await publishEntry(c, { kind: 'skill', name: 'concise', version: '1.0.0', description: 'Answers in one sentence with the figure first.', label: 'internal', definition: { instructions: 'One sentence.', tools: [] }, purpose: 'Short answers.', examples: ['What is the refund window?'], category: 'Writing' });
    await publishEntry(c, { kind: 'skill', name: 'cite-sources', version: '1.0.0', description: 'Cites the source of every figure it states.', label: 'internal', definition: { instructions: 'Cite.', tools: [] }, purpose: 'Answers with their sources.', examples: ['Where does this figure come from?'], category: 'Writing' });

    // Mia (internal): the workflow with its call and example, filled into the composer; the confidential agent and the
    // confidential invoice tool are never listed, not even as "not on this profile".
    const mia = await catalogue(c.mia);
    const wf = mia.entries.find((e) => e.key === 'workflow:summarise-contract')!;
    expect(wf).toMatchObject({ kind: 'workflow', category: 'Documents', call: '/summarise-contract', example: 'Summarise this contract for me', compose: '/summarise-contract Summarise this contract for me', available: true, missing: [] });
    expect(mia.entries.find((e) => e.key === 'agent:Contract reviewer')).toMatchObject({ call: '@Contract reviewer', compose: '@Contract reviewer: Review this NDA for unusual terms', available: true });
    expect(mia.entries.map((e) => e.key)).not.toContain('agent:Deal desk');
    expect(mia.entries.map((e) => e.key)).not.toContain('tool:jira.lookup_invoice');
    // Grouped by category, "Other" last.
    expect(mia.categories.map((x) => x.name)).toEqual(['Built in', 'Documents', 'Writing']);
    // The skill outside general's allow-list: not on this profile, offered by analyst.
    expect(mia.entries.find((e) => e.key === 'skill:cite-sources')).toMatchObject({ available: false, reason: 'not on this profile', profiles: ['analyst'], call: '+cite-sources' });
    expect(mia.entries.find((e) => e.key === 'skill:concise')).toMatchObject({ available: true });

    // Noah (confidential): the confidential agent, and the invoice tool as not on this profile, offered by analyst.
    const noah = await catalogue(c.noah);
    expect(noah.entries.find((e) => e.key === 'agent:Deal desk')).toMatchObject({ category: 'Finance', available: true });
    expect(noah.entries.find((e) => e.key === 'tool:jira.lookup_invoice')).toMatchObject({ available: false, reason: 'not on this profile', profiles: ['analyst'], call: '/jira.lookup_invoice' });
    // Through analyst the tool is callable and the skill is on the profile.
    const viaAnalyst = await catalogue(c.noah, 'analyst');
    expect(viaAnalyst.entries.find((e) => e.key === 'tool:jira.lookup_invoice')).toMatchObject({ available: true });
    expect(viaAnalyst.entries.find((e) => e.key === 'skill:cite-sources')).toMatchObject({ available: true });
    // The catalogue is the workspace form of a conversation's capabilities: the same lists.
    const caps = await h.s.chatInvocations.workspaceCapabilities((await h.s.chat.principalForOwner(h.tenantId, c.people.noah.id, c.ws))!, 'general');
    expect(caps.workflows.map((x) => x.name)).toEqual(['summarise-contract']);
    // A profile the person may not pick is refused.
    await c.mia.agent.get('/api/catalog?profile=nobody').expect(404);
  });

  it('B-12302: publishing gives each member one notice linking to the entry, none below its label; digest and off are honoured', async () => {
    const c = await setup();
    await put(c.olga, '/api/me/catalog-notices', { notices: 'digest' }).expect(200);
    await put(c.pat, '/api/me/catalog-notices', { notices: 'off' }).expect(200);
    await publishWorkflow(c);
    const forNoah = await notices(c.people.noah.id);
    expect(forNoah).toHaveLength(1);
    expect(forNoah[0]).toMatchObject({ title: 'Workflow summarise-contract is now available to you', route: 'catalog?entry=workflow%3Asummarise-contract', label: 'internal' });
    expect(await notices(c.people.mia.id)).toHaveLength(1);
    // The publisher, the digest reader and the person with notices off get nothing now.
    expect(await notices(c.people.wadmin.id)).toHaveLength(0);
    expect(await notices(c.people.olga.id)).toHaveLength(0);
    expect(await notices(c.people.pat.id)).toHaveLength(0);
    expect((await c.olga.agent.get('/api/me/catalog-notices').expect(200)).body).toMatchObject({ notices: 'digest', pending: 1 });

    // Publishing a new version notifies nobody again (once per person and entry).
    const w = (await c.w.agent.get('/api/workflows').expect(200)).body[0] as { id: string };
    await post(c.w, `/api/workflows/${w.id}/publish`).expect(200);
    expect(await notices(c.people.noah.id)).toHaveLength(1);

    // A confidential agent: Noah gets one, Mia (internal) none.
    await publishEntry(c, agent('Deal desk', 'confidential', card));
    expect((await notices(c.people.noah.id)).map((n) => n.title)).toEqual(['Workflow summarise-contract is now available to you', 'Agent Deal desk is now available to you']);
    expect((await notices(c.people.noah.id))[1]!.label).toBe('confidential');
    expect(await notices(c.people.mia.id)).toHaveLength(1);

    // The weekly digest: nothing before a week, then one notification for both entries; nothing for Pat.
    expect(await h.s.discovery.sendDigests(h.tenantId)).toEqual({ digests: 0, entries: 0 });
    expect(await h.s.discovery.sendDigests(h.tenantId, Date.now() + 8 * DAY)).toEqual({ digests: 1, entries: 2 });
    const digest = await notices(c.people.olga.id);
    expect(digest).toHaveLength(1);
    expect(digest[0]).toMatchObject({ title: 'This week: 2 new things you can use', route: 'catalog', label: 'confidential' });
    expect(digest[0]!.body).toContain('workflow summarise-contract');
    expect(await notices(c.people.pat.id)).toHaveLength(0);
    expect(await h.s.db('audit_events').where({ action: 'catalog.notices.sent' }).first()).toBeTruthy();
    // Newly offered: an agent published to another workspace reaches its members; offered to Legal as well, it
    // reaches Legal's members who have not had it, and nobody twice.
    const ops = (await h.s.tenants.createWorkspace(h.tenantId, 'Ops', 'confidential')).id;
    await h.s.tenants.addMember(ops, c.people.noah.id);
    const helper = (await post(c.t, '/api/admin/registry', agent('Ops helper', 'internal', card)).expect(201)).body as { id: string };
    await post(c.t, `/api/admin/registry/${helper.id}/submit`).expect(200);
    await post(c.t2, `/api/admin/registry/${helper.id}/review`, { decision: 'approve', scope: 'workspace', workspaces: [ops] }).expect(200);
    expect((await notices(c.people.noah.id)).map((n) => n.title)).toContain('Agent Ops helper is now available to you');
    expect((await notices(c.people.mia.id)).map((n) => n.title)).not.toContain('Agent Ops helper is now available to you');
    await post(c.t2, `/api/admin/registry/${helper.id}/publish`, { scope: 'workspace', workspaces: [ops, c.ws] }).expect(200);
    expect((await notices(c.people.mia.id)).map((n) => n.title)).toContain('Agent Ops helper is now available to you');
    expect((await notices(c.people.noah.id)).filter((n) => n.title === 'Agent Ops helper is now available to you')).toHaveLength(1);
    // Leaving the digest for notices as they happen delivers what it held at once.
    await publishEntry(c, agent('Clause finder', 'internal', card));
    expect((await c.olga.agent.get('/api/me/catalog-notices').expect(200)).body.pending).toBe(2);
    await put(c.olga, '/api/me/catalog-notices', { notices: 'each' }).expect(200);
    expect((await notices(c.people.olga.id)).map((n) => n.title)).toEqual(['This week: 2 new things you can use', '2 new things you can use']);
    expect((await c.olga.agent.get('/api/me/catalog-notices').expect(200)).body).toMatchObject({ notices: 'each', pending: 0 });
  });

  it('B-12303: "summarise this contract" suggests the summarise workflow; a dismissed one stays away; off per profile; vectors cached per version', async () => {
    const c = await setup();
    await publishWorkflow(c);
    await publishEntry(c, agent('Contract reviewer', 'internal', card));
    const r = (await post(c.mia, '/api/chat', { content: 'Hello', profile: 'general' }).expect(202)).body as { conversationId: string };
    // Embedding requests that carried an entry's text, and the ones that carried a draft.
    const embedInputs = () => ollama.requests.filter((x) => x.path === '/api/embed').map((x) => (Array.isArray(x.body.input) ? x.body.input : [x.body.input]) as string[]);
    const entryEmbeds = () => embedInputs().filter((i) => i.some((t) => t.includes('Summarises a contract'))).length;
    const draftEmbeds = (d: string) => embedInputs().filter((i) => i.length === 1 && i[0] === d).length;
    const s1 = (await post(c.mia, '/api/catalog/suggestions', { draft: 'summarise this contract', conversationId: r.conversationId }).expect(200)).body;
    expect(s1.off).toBeNull();
    expect(s1.suggestions.length).toBeGreaterThanOrEqual(1);
    expect(s1.suggestions.length).toBeLessThanOrEqual(3);
    expect(s1.suggestions[0]).toMatchObject({ key: 'workflow:summarise-contract', call: '/summarise-contract' });
    expect(entryEmbeds()).toBe(1);
    expect(draftEmbeds('summarise this contract')).toBe(1);
    // The entries' vectors are cached per version: a second draft embeds only the draft.
    expect(await h.s.db('catalog_vectors').where({ tenant_id: h.tenantId, entry_key: 'workflow:summarise-contract', version: 'v1' }).first()).toBeTruthy();
    await post(c.mia, '/api/catalog/suggestions', { draft: 'please summarise the contract', conversationId: r.conversationId }).expect(200);
    expect(entryEmbeds()).toBe(1);
    expect(draftEmbeds('please summarise the contract')).toBe(1);
    // No chat model was called for the suggestions.
    expect(ollama.requests.filter((x) => x.path === '/api/embed').every((x) => x.body.model === 'nomic-embed-text')).toBe(true);

    // Dismissed: away for the rest of this conversation, back in another.
    await post(c.mia, `/api/conversations/${r.conversationId}/suggestions/dismiss`, { key: 'workflow:summarise-contract' }).expect(200);
    const s2 = (await post(c.mia, '/api/catalog/suggestions', { draft: 'summarise this contract', conversationId: r.conversationId }).expect(200)).body;
    expect(s2.suggestions.map((x: { key: string }) => x.key)).not.toContain('workflow:summarise-contract');
    expect(s2.dismissed).toEqual(['workflow:summarise-contract']);
    const fresh = (await post(c.mia, '/api/catalog/suggestions', { draft: 'summarise this contract', profile: 'general' }).expect(200)).body;
    expect(fresh.suggestions[0].key).toBe('workflow:summarise-contract');
    // Someone else cannot dismiss in Mia's conversation.
    await post(c.noah, `/api/conversations/${r.conversationId}/suggestions/dismiss`, { key: 'agent:Contract reviewer' }).expect(404);

    // A new version of the workflow is embedded again (cached per version).
    const w = (await c.w.agent.get('/api/workflows').expect(200)).body[0] as { id: string };
    await post(c.w, `/api/workflows/${w.id}/publish`).expect(200);
    await post(c.mia, '/api/catalog/suggestions', { draft: 'summarise this contract', profile: 'general' }).expect(200);
    expect(await h.s.db('catalog_vectors').where({ tenant_id: h.tenantId, entry_key: 'workflow:summarise-contract', version: 'v2' }).first()).toBeTruthy();

    // Off per profile.
    await h.s.gateway.repo.updateProfile(h.tenantId, 'GENERAL0000000000000000000', { suggestions: false });
    const off = (await post(c.mia, '/api/catalog/suggestions', { draft: 'summarise this contract', profile: 'general' }).expect(200)).body;
    expect(off).toMatchObject({ off: 'profile', suggestions: [] });
    // No embedding profile: nothing, with the reason.
    h.s.cfg.DISCOVERY_EMBED_PROFILE = 'missing';
    const none = (await post(c.mia, '/api/catalog/suggestions', { draft: 'summarise this contract', profile: 'analyst' }).expect(200)).body;
    expect(none).toMatchObject({ off: 'embedding', suggestions: [] });
    expect(none.detail).toMatch(/No embedding profile missing/);
  });

  it('B-12304: an agent submitted without an example prompt is returned with the missing field named; the reviewer sees the card; older entries keep working', async () => {
    const c = await setup();
    const e = (await post(c.t, '/api/admin/registry', agent('Contract reviewer', 'internal', { purpose: card.purpose, category: card.category })).expect(201)).body;
    const refused = (await post(c.t, `/api/admin/registry/${e.id}/submit`).expect(422)).body;
    expect(refused.detail).toMatch(/Missing: example prompt\./);
    expect(refused.missing).toEqual(['examples']);
    expect(refused.errors).toEqual([{ path: 'examples', message: 'Add at least one example prompt.' }]);
    expect(await h.s.db('audit_events').where({ action: 'registry.submit.refused' }).first()).toBeTruthy();
    await patch(c.t, `/api/admin/registry/${e.id}`, { examples: ['Review this NDA for unusual terms'] }).expect(200);
    await post(c.t, `/api/admin/registry/${e.id}/submit`).expect(200);
    // The reviewer's preview of the catalogue card.
    const detail = (await c.t2.agent.get(`/api/admin/registry/${e.id}`).expect(200)).body;
    expect(detail).toMatchObject({ purpose: card.purpose, examples: ['Review this NDA for unusual terms'], category: 'Documents', offeredInChat: true, discoveryRequired: true });
    expect(detail.catalogCard).toMatchObject({ key: 'agent:Contract reviewer', call: '@Contract reviewer', compose: '@Contract reviewer: Review this NDA for unusual terms', category: 'Documents', missing: [] });
    await post(c.t2, `/api/admin/registry/${e.id}/review`, { decision: 'approve' }).expect(200);

    // A tool no published profile lists is not offered in chat: its submit does not ask for the fields.
    // An entry published before the fields existed keeps working and is listed with what it has.
    h.s.cfg.REGISTRY_DISCOVERY_REQUIRED = false;
    const old = (await post(c.t, '/api/admin/registry', agent('Legacy helper', 'internal', {})).expect(201)).body;
    await post(c.t, `/api/admin/registry/${old.id}/submit`).expect(200);
    await post(c.t2, `/api/admin/registry/${old.id}/review`, { decision: 'approve' }).expect(200);
    h.s.cfg.REGISTRY_DISCOVERY_REQUIRED = true;
    const list = await catalogue(c.mia);
    expect(list.entries.find((x) => x.key === 'agent:Legacy helper')).toMatchObject({ category: 'Other', example: null, compose: '@Legacy helper: ', available: true, missing: ['purpose', 'examples', 'category'] });
    expect(list.categories.at(-1)!.name).toBe('Other');
    // Its owner fills the fields later without a new version, and the approval still holds.
    await put(c.t, `/api/admin/registry/${old.id}/discovery`, { purpose: 'Answers the old questions.', examples: ['What did we decide in 2024?'], category: 'Archive' }).expect(200);
    const after = (await c.t.agent.get(`/api/admin/registry/${old.id}`).expect(200)).body;
    expect(after).toMatchObject({ status: 'published', category: 'Archive' });
    expect(after.approvedHash).toBe(after.schemaHash);
    const run = (await post(c.mia, '/api/chat', { content: 'Hello', profile: 'general' }).expect(202)).body as { conversationId: string };
    const caps = (await c.mia.agent.get(`/api/conversations/${run.conversationId}/capabilities`).expect(200)).body;
    expect(caps.agents.map((a: { name: string }) => a.name)).toEqual(expect.arrayContaining(['Contract reviewer', 'Legacy helper']));
  });
});
