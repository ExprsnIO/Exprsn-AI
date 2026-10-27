import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProfileRow } from '../src/gateway/repo.js';
import { defaultWorkspace, forgetDefaultWorkspace } from '../src/tenancy/default-workspace.js';
import { classifierProfiles, embeddingProfile, forgetUsageAttribution, runUsageWorkspace } from '../src/tenancy/usage-attribution.js';
import { FakeOllama, markedPng } from './fake-ollama.js';
import { localUser, loginAdmin, type Harness } from './helpers.js';
import { client, drain, harnessWith, seedRetrieval } from './retrieval-seed.js';

/*
 * 2026-10-19: embedding and classifier usage is counted in the object's workspace, else the caller's, else the
 * tenant's default workspace; on the profile (the classifier's, or the tenant's published profile for the embedding
 * model); for the person who caused it, or nobody ("System") for background work. Analytics narrows to it with
 * `class=embedding`, per profile and per user.
 */

const GB = 1_000_000_000;

interface UsageRow {
  kind: string;
  workspace_id: string | null;
  user_id: string | null;
  api_key_id: string | null;
  profile_id: string | null;
  model: string | null;
}

describe('embedding and classifier usage attribution', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let seed: Awaited<ReturnType<typeof seedRetrieval>>;
  const EMBED_NOMIC = 'EMBEDNOMIC'.padEnd(26, '0');
  const ZZ_NOMIC = 'ZZNOMIC'.padEnd(26, '0');
  const EMBED_BGE = 'EMBEDBGE'.padEnd(26, '0');
  const SEE = 'SEE'.padEnd(26, '0');

  const profile = (id: string, name: string, modelId: string, status: ProfileRow['status'] = 'published'): ProfileRow => {
    const t = Date.now();
    return { id, tenant_id: h.tenantId, name, display_name: name, description: null, alias_of: null, model_id: modelId, pool_id: seed.pool.id, num_ctx: 8192, temperature: 0, think_default: 'off', think_ceiling: 'off', system_prompt: null, fallback: null, canary: null, tools: [], label: 'confidential', status, version: 1, updated_by: null, created_at: t, updated_at: t };
  };
  const usage = async (kind = 'embed'): Promise<UsageRow[]> => (await h.s.db('usage_records').where({ tenant_id: h.tenantId, kind }).orderBy('ts').orderBy('id')) as UsageRow[];
  const fresh = async () => {
    await h.s.db('usage_records').delete();
    await h.s.db('embedding_cache').delete();
  };
  const upload = (c: Awaited<ReturnType<typeof client>>, kbId: string, name: string, data: Buffer, label = 'public') =>
    c.agent.put(`/api/knowledge/bases/${kbId}/uploads?name=${encodeURIComponent(name)}&label=${label}`).set('x-csrf-token', c.csrf).set('content-type', 'application/octet-stream').send(data);

  beforeEach(async () => {
    ollama = await new FakeOllama().start();
    ollama.chatDelayMs = 0;
    h = await harnessWith({}, { OLLAMA_POLL_MS: '600000', MESSAGING_EMBED_MODEL: 'nomic-embed-text' });
    seed = await seedRetrieval(h, ollama);
    const repo = h.s.gateway.repo;
    // Two published profiles on nomic: the `embed` one is preferred. bge has a published one too.
    await repo.createProfile(profile(ZZ_NOMIC, 'aa-nomic', seed.models['nomic-embed-text']!));
    await repo.createProfile(profile(EMBED_NOMIC, 'embed-nomic', seed.models['nomic-embed-text']!));
    await repo.createProfile(profile(EMBED_BGE, 'embed-bge', seed.models['bge-m3']!));
    // A vision model behind the profile `see`, which a vision classifier routes through.
    ollama.addAvailable({ name: 'gemma3:12b', size: 8 * GB, capabilities: ['completion', 'vision'] });
    const m = await repo.createModel({ name: 'gemma3:12b', source: 'Ollama library', expectedDigest: null, license: { name: 'test' }, label: 'confidential', notes: null, requestedBy: 'x', requestedTenant: h.tenantId });
    await repo.updateModel(m.id, { state: 'approved', import_state: 'pulled', capabilities: ['completion', 'vision'], size_bytes: 8 * GB });
    await repo.place(m.id, seed.pool.id, 'warm', 'x');
    await repo.createProfile(profile(SEE, 'see', m.id));
    await h.s.gateway.pollAll();
    forgetUsageAttribution(h.s.db);
    forgetDefaultWorkspace(h.s.db);
  }, 60_000);
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  it('a tenant with no workspaces records no workspace without failing; the default workspace is General, else Platform, else the oldest', async () => {
    expect(await defaultWorkspace(h.s.db, h.tenantId)).toBeNull();
    await h.s.knowledge.embed(h.tenantId, 'nomic-embed-text', ['no workspace yet'], 'internal', null);
    expect(await usage()).toEqual([expect.objectContaining({ workspace_id: null, user_id: null, profile_id: EMBED_NOMIC, model: 'nomic-embed-text' })]);

    const zeta = await h.s.tenants.createWorkspace(h.tenantId, 'Zeta', 'confidential');
    expect(await defaultWorkspace(h.s.db, h.tenantId)).toBe(zeta.id);
    const platform = await h.s.tenants.createWorkspace(h.tenantId, 'Platform', 'confidential');
    forgetDefaultWorkspace(h.s.db, h.tenantId);
    expect(await defaultWorkspace(h.s.db, h.tenantId)).toBe(platform.id);
    const general = await h.s.tenants.createWorkspace(h.tenantId, 'General', 'confidential');
    forgetDefaultWorkspace(h.s.db, h.tenantId);
    expect(await defaultWorkspace(h.s.db, h.tenantId)).toBe(general.id);
    // Cached for a minute: a new workspace named general elsewhere does not move it until then.
    expect(await defaultWorkspace(h.s.db, h.tenantId)).toBe(general.id);
  });

  it('resolves the published profile for an embedding model, preferring a setting, then an embed name', async () => {
    expect(await embeddingProfile(h.s.db, h.tenantId, 'nomic-embed-text')).toBe(EMBED_NOMIC);
    expect(await embeddingProfile(h.s.db, h.tenantId, 'nomic-embed-text', ['aa-nomic'])).toBe(ZZ_NOMIC);
    expect(await embeddingProfile(h.s.db, h.tenantId, 'bge-m3')).toBe(EMBED_BGE);
    expect(await embeddingProfile(h.s.db, h.tenantId, 'no-such-model')).toBeNull();
    // A draft profile does not count.
    await h.s.db('profiles').where({ id: EMBED_BGE }).update({ status: 'draft' });
    forgetUsageAttribution(h.s.db);
    expect(await embeddingProfile(h.s.db, h.tenantId, 'bge-m3')).toBeNull();
  });

  it('knowledge: indexing counts in the base\'s workspace, else the default, for the uploader; a search for the searcher in their workspace', async () => {
    const ws = await h.s.tenants.createWorkspace(h.tenantId, 'Finance', 'confidential');
    const general = await h.s.tenants.createWorkspace(h.tenantId, 'General', 'confidential');
    const curator = await client(h, 'cura', ['member', 'knowledge-curator'], 'confidential');
    await h.s.tenants.addMember(ws.id, curator.user.id);
    const inWs = (await curator.post('/api/knowledge/bases', { name: 'Finance KB', label: 'internal', embedModel: 'nomic-embed-text', workspaceId: ws.id }).expect(201)).body;
    const wide = (await curator.post('/api/knowledge/bases', { name: 'Tenant KB', label: 'internal', embedModel: 'nomic-embed-text', workspaceId: null }).expect(201)).body;
    expect(wide.workspaceId ?? null).toBeNull();
    await fresh();

    await upload(curator, inWs.id, 'policy.md', Buffer.from('# Policy\n\nTaxis after 22:00 need no approval.')).expect(202);
    await drain(h);
    const a = await usage();
    expect(a.length).toBeGreaterThan(0);
    for (const r of a) expect(r).toMatchObject({ workspace_id: ws.id, user_id: curator.user.id, profile_id: EMBED_NOMIC, model: 'nomic-embed-text' });

    await fresh();
    await upload(curator, wide.id, 'meals.md', Buffer.from('# Meals\n\nMeals are covered up to 40 EUR a day.')).expect(202);
    await drain(h);
    const b = await usage();
    expect(b.length).toBeGreaterThan(0);
    for (const r of b) expect(r).toMatchObject({ workspace_id: general.id, user_id: curator.user.id, profile_id: EMBED_NOMIC });

    // A person searching the tenant-wide base from their workspace: counted there, for them.
    const sales = await h.s.tenants.createWorkspace(h.tenantId, 'Sales', 'confidential');
    const searcher = await client(h, 'sid', ['member'], 'internal');
    await h.s.tenants.addMember(sales.id, searcher.user.id);
    await fresh();
    await searcher.post('/api/knowledge/search', { kbIds: [wide.id], query: 'how much for meals a day', rerank: false }).expect(200);
    expect(await usage()).toEqual([expect.objectContaining({ workspace_id: sales.id, user_id: searcher.user.id, profile_id: EMBED_NOMIC })]);
    // Searching the base with a workspace of its own counts in that workspace.
    await fresh();
    await curator.post('/api/knowledge/search', { kbIds: [inWs.id], query: 'taxi approval at night', rerank: false }).expect(200);
    expect(await usage()).toEqual([expect.objectContaining({ workspace_id: ws.id, user_id: curator.user.id })]);
  });

  it('memory: a person\'s memory for its author in their workspace, else the default; a workspace memory in its workspace', async () => {
    const general = await h.s.tenants.createWorkspace(h.tenantId, 'General', 'confidential');
    const me = await client(h, 'mia', ['member'], 'internal');
    await fresh();
    // mia is in no workspace: her memory counts in the default workspace.
    await me.post('/api/memory', { text: 'Current project: Q3 close for Finance Ops', label: 'internal' }).expect(201);
    // The first approved embedding model by name is the memory model here: bge-m3, on embed-bge.
    expect(await usage()).toEqual([expect.objectContaining({ workspace_id: general.id, user_id: me.user.id, profile_id: EMBED_BGE, model: 'bge-m3' })]);

    const ws = await h.s.tenants.createWorkspace(h.tenantId, 'Finance Ops', 'confidential', { visibility: 'tenant' });
    const curator = await client(h, 'cura', ['member', 'knowledge-curator'], 'confidential');
    await fresh();
    // Now her current workspace is Finance Ops (visible to the tenant): her own memory counts there.
    await me.post('/api/memory', { text: 'Prefers summaries in bullet points', label: 'internal' }).expect(201);
    expect(await usage()).toEqual([expect.objectContaining({ workspace_id: ws.id, user_id: me.user.id })]);

    await fresh();
    await curator.post('/api/memory', { scope: 'workspace', type: 'convention', text: 'Variance is actual minus budget', label: 'internal' }).expect(201);
    expect(await usage()).toEqual([expect.objectContaining({ workspace_id: ws.id, user_id: curator.user.id, profile_id: EMBED_BGE })]);
  });

  it('messaging: a message is embedded in its conversation\'s workspace for its author', async () => {
    const ws = await h.s.tenants.createWorkspace(h.tenantId, 'Design', 'confidential');
    const alice = await client(h, 'alice', ['member'], 'internal');
    const bob = await client(h, 'bob', ['member'], 'internal');
    await h.s.tenants.addMember(ws.id, alice.user.id);
    await h.s.tenants.addMember(ws.id, bob.user.id);
    const g = (await alice.post('/api/messaging/conversations', { kind: 'group', workspaceId: ws.id, memberIds: [bob.user.id] }).expect(201)).body as { id: string };
    await fresh();
    await bob.post(`/api/messaging/conversations/${g.id}/messages`, { body: 'Printing budget needs another quote' }).expect(201);
    await drain(h);
    expect(await usage()).toEqual([expect.objectContaining({ workspace_id: ws.id, user_id: bob.user.id, profile_id: EMBED_NOMIC, model: 'nomic-embed-text' })]);
  });

  it('/v1/embeddings: the caller\'s workspace, the key\'s person and the model\'s profile', async () => {
    const ws = await h.s.tenants.createWorkspace(h.tenantId, 'Platform', 'confidential');
    const u = await localUser(h, 'dev', ['member'], 'internal');
    await h.s.tenants.addMember(ws.id, u.id);
    const key = (await h.s.apiKeys.create({ tenantId: h.tenantId, userId: u.id, name: 'k', scopes: ['inference:invoke', 'models:read'] as never[], ttlDays: 1 })).key;
    await fresh();
    const r = await request(h.app).post('/v1/embeddings').set('authorization', `Bearer ${key}`).send({ model: 'nomic-embed-text', input: ['one', 'two'] }).expect(200);
    expect(r.body.data).toHaveLength(2);
    const rows = await usage();
    expect(rows).toEqual([expect.objectContaining({ workspace_id: ws.id, user_id: u.id, profile_id: EMBED_NOMIC, model: 'nomic-embed-text' })]);
    expect(rows[0]!.api_key_id).toBeTruthy();
  });

  it('classifiers: image descriptions and classification get the classifier\'s profile, the default workspace and the uploader; runs on a classifier profile get the default workspace', async () => {
    const general = await h.s.tenants.createWorkspace(h.tenantId, 'General', 'confidential');
    const curator = await client(h, 'cura', ['member', 'knowledge-curator'], 'confidential');
    const kb = (await curator.post('/api/knowledge/bases', { name: 'Screens', label: 'internal', embedModel: 'nomic-embed-text', workspaceId: null }).expect(201)).body;
    await curator.patch(`/api/knowledge/bases/${kb.id}`, { visionProfile: 'see' }).expect(200);
    await localUser(h, 'ga', ['guardrail-admin'], 'confidential');
    const admin = await loginAdmin(h, 'ga');
    const kind = (await admin.agent.post('/api/admin/classifiers').set('x-csrf-token', admin.csrf).send({ name: 'Image kind', slug: 'image-kind', engine: 'vision', labels: ['receipt', 'diagram'], profile: 'see' }).expect(201)).body as { id: string };
    await curator.patch(`/api/knowledge/bases/${kb.id}`, { imageClassifiers: [kind.id] }).expect(200);
    expect([...(await classifierProfiles(h.s.db, h.tenantId))]).toContain(SEE);
    await fresh();
    await upload(curator, kb.id, 'taxi.png', markedPng({ caption: 'A taxi receipt', ocr: 'Fare 42.00 EUR', scores: { receipt: 0.88, diagram: 0.02 } }, 24, 3)).expect(202);
    await drain(h);
    const rows = await usage();
    const onSee = rows.filter((r) => r.profile_id === SEE);
    // One description and one classification, both on the vision profile.
    expect(onSee.length).toBe(2);
    for (const r of onSee) expect(r).toMatchObject({ workspace_id: general.id, user_id: curator.user.id, model: 'gemma3:12b' });
    for (const r of rows.filter((x) => x.profile_id !== SEE)) expect(r).toMatchObject({ workspace_id: general.id, user_id: curator.user.id, profile_id: EMBED_NOMIC });

    // A workflow or agent call with no workspace: on a classifier profile, the default workspace; otherwise none.
    expect(await runUsageWorkspace(h.s.db, h.tenantId, null, SEE)).toBe(general.id);
    expect(await runUsageWorkspace(h.s.db, h.tenantId, null, seed.general.id)).toBeNull();
    const other = await h.s.tenants.createWorkspace(h.tenantId, 'Other', 'confidential');
    expect(await runUsageWorkspace(h.s.db, h.tenantId, other.id, SEE)).toBe(other.id);
  });

  it('analytics: class=embedding narrows to embeddings and classifiers, per profile (no profile: the model) and per user (no user: System)', async () => {
    const ws = await h.s.tenants.createWorkspace(h.tenantId, 'General', 'confidential');
    await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    const admin = await loginAdmin(h, 'ta');
    const alice = await localUser(h, 'alice', ['member'], 'internal');
    await h.s.db('classifiers').insert({ id: 'CLSSEE'.padEnd(26, '0'), tenant_id: h.tenantId, slug: 'kinds', name: 'Kinds', engine: 'vision', description: null, status: 'draft', version: 1, owner: 'x', dataset: null, config: JSON.stringify({ labels: [{ label: 'a', threshold: 0.5 }], profile: 'see' }), created_by: null, created_at: Date.now(), updated_at: Date.now() });
    forgetUsageAttribution(h.s.db);
    await fresh();
    const rec = (p: { kind: 'chat' | 'embed' | 'workflow'; userId: string | null; profileId: string | null; model: string; prompt: number; gpuMs?: number }) =>
      h.s.quotas.record({ tenantId: h.tenantId, workspaceId: ws.id, userId: p.userId, kind: p.kind, profileId: p.profileId, model: p.model, poolId: seed.pool.id, promptTokens: p.prompt, outputTokens: 0, gpuMs: p.gpuMs ?? 1000 });
    await rec({ kind: 'chat', userId: alice.id, profileId: seed.general.id, model: 'llama3.1:8b', prompt: 5000 });
    await rec({ kind: 'embed', userId: alice.id, profileId: EMBED_NOMIC, model: 'nomic-embed-text', prompt: 100 });
    await rec({ kind: 'embed', userId: null, profileId: EMBED_NOMIC, model: 'nomic-embed-text', prompt: 300 });
    await rec({ kind: 'embed', userId: null, profileId: null, model: 'legacy-embed', prompt: 40 });
    await rec({ kind: 'workflow', userId: alice.id, profileId: SEE, model: 'gemma3:12b', prompt: 20, gpuMs: 2000 });

    const byProfile = (await admin.agent.get('/api/admin/analytics/summary?by=profile&days=1&class=embedding').expect(200)).body as { class: string; rows: { key: string; name: string; requests: number; tokens: number; users: number; gpuMs: number }[]; total: { requests: number; tokens: number } };
    expect(byProfile.class).toBe('embedding');
    const names = Object.fromEntries(byProfile.rows.map((r) => [r.name, r]));
    expect(Object.keys(names).sort()).toEqual(['embed-nomic', 'legacy-embed', 'see']);
    expect(names['embed-nomic']).toMatchObject({ key: EMBED_NOMIC, requests: 2, tokens: 400, users: 1 });
    expect(names['legacy-embed']).toMatchObject({ key: 'model:legacy-embed', requests: 1, tokens: 40 });
    expect(names.see).toMatchObject({ key: SEE, requests: 1, tokens: 20, gpuMs: 2000 });
    expect(byProfile.total).toMatchObject({ requests: 4, tokens: 460 });

    const byUser = (await admin.agent.get('/api/admin/analytics/summary?by=user&days=1&class=embedding').expect(200)).body as { rows: { key: string | null; name: string; requests: number; tokens: number }[] };
    expect(byUser.rows.find((r) => r.key === alice.id)).toMatchObject({ name: 'ALICE', requests: 2, tokens: 120 });
    expect(byUser.rows.find((r) => r.key === null)).toMatchObject({ name: 'System', requests: 2, tokens: 340 });

    // Without the class every record counts; the daily view narrows the same way.
    const all = (await admin.agent.get('/api/admin/analytics/summary?by=profile&days=1').expect(200)).body as { total: { requests: number } };
    expect(all.total.requests).toBe(5);
    const daily = (await admin.agent.get('/api/admin/analytics/daily?days=1&class=embedding').expect(200)).body as { tokens: number }[];
    expect(daily[0]!.tokens).toBe(460);
    await admin.agent.get('/api/admin/analytics/summary?class=chat').expect(400);
  });
});
