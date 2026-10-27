import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProfileRow } from '../src/gateway/repo.js';
import { resolveDefault, type PreferenceRow } from '../src/gateway/profile-preferences.js';
import { MAX_OFFERED, rankTools, words } from '../src/registry/select.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';

const GB = 1_000_000_000;
const row = (scope: PreferenceRow['scope'], defaultProfile: string | null, enforced = false, hidden: string[] = []): PreferenceRow => ({ scope, scopeId: scope, defaultProfile, enforced, hidden, updatedAt: 1 });

describe('tool selection for a turn (registry/select.ts)', () => {
  it('splits names and drops common words', () => {
    expect(words('exprsn-images.resizeImage: the PNG')).toEqual(['exprsn', 'images', 'resize', 'image', 'png']);
  });

  it('ranks by the turn\'s words, name above description, ties in the profile\'s order', () => {
    const briefs = [
      { name: 'calculate', description: 'Exact arithmetic' },
      { name: 'weather.forecast', description: 'The forecast for a city' },
      { name: 'image_resize', description: 'Resize an image to a width' },
      { name: 'files.search', description: 'Search files, including images by name' }
    ];
    expect(rankTools(briefs, 'Please resize these images to 800 wide')[0]).toBe('image_resize');
    expect(rankTools(briefs, 'search my files')[0]).toBe('files.search');
    expect(rankTools(briefs, '')).toEqual(briefs.map((b) => b.name));
  });

  it('offers a bounded number of tools', () => {
    expect(MAX_OFFERED).toBeGreaterThan(8);
    expect(MAX_OFFERED).toBeLessThanOrEqual(32);
  });
});

describe('default profile precedence (gateway/profile-preferences.ts)', () => {
  const usable = new Set(['chat', 'cortex', 'spark', 'knowledge']);
  it('takes the person over the workspace over the tenant', () => {
    expect(resolveDefault({ tenant: row('tenant', 'chat'), workspace: row('workspace', 'cortex'), user: row('user', 'spark') }, usable)).toEqual({ profile: 'spark', source: 'user', enforced: false });
    expect(resolveDefault({ tenant: row('tenant', 'chat'), workspace: row('workspace', 'cortex'), user: row('user', null) }, usable)).toEqual({ profile: 'cortex', source: 'workspace', enforced: false });
    expect(resolveDefault({ tenant: row('tenant', 'chat'), workspace: null, user: row('user', null) }, usable)).toEqual({ profile: 'chat', source: 'tenant', enforced: false });
  });

  it('lets an enforced workspace or tenant default override the person, the tenant first', () => {
    expect(resolveDefault({ tenant: row('tenant', 'chat'), workspace: row('workspace', 'cortex', true), user: row('user', 'spark') }, usable)).toEqual({ profile: 'cortex', source: 'workspace', enforced: true });
    expect(resolveDefault({ tenant: row('tenant', 'knowledge', true), workspace: row('workspace', 'cortex', true), user: row('user', 'spark') }, usable)).toEqual({ profile: 'knowledge', source: 'tenant', enforced: true });
  });

  it('skips a default the person cannot use', () => {
    expect(resolveDefault({ tenant: row('tenant', 'chat'), workspace: row('workspace', 'secret', true), user: row('user', 'gone') }, usable)).toEqual({ profile: 'chat', source: 'tenant', enforced: false });
    expect(resolveDefault({ tenant: row('tenant', null), workspace: null, user: row('user', null) }, usable)).toEqual({ profile: null, source: null, enforced: false });
  });
});

describe('profile preferences API', () => {
  let h: Harness;
  let ollama: FakeOllama;

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    ollama = await new FakeOllama().start();
    const repo = h.s.gateway.repo;
    ollama.addAvailable({ name: 'llama3.1:8b', size: 5 * GB, capabilities: ['completion', 'tools'] });
    const pool = await repo.createPool({ name: 'gpu', accelerator: 'cuda', zone: 'inference', labelCeiling: 'confidential' });
    await repo.createInstance({ poolId: pool.id, name: 'gpu-1', url: ollama.url, deploy: 'docker', settings: { parallel: 4 } });
    const m = await repo.createModel({ name: 'llama3.1:8b', source: 'Ollama library', expectedDigest: null, license: { name: 'test' }, label: 'confidential', notes: null, requestedBy: 'x', requestedTenant: h.tenantId });
    await repo.updateModel(m.id, { state: 'approved', import_state: 'pulled', capabilities: ['completion', 'tools'], size_bytes: 5 * GB });
    await repo.place(m.id, pool.id, 'warm', 'x');
    for (const name of ['chat', 'cortex', 'spark']) {
      const t = Date.now();
      const p: ProfileRow = { id: name.toUpperCase().padEnd(26, '0').slice(0, 26), tenant_id: h.tenantId, name, display_name: name, description: null, alias_of: null, model_id: m.id, pool_id: pool.id, num_ctx: 8192, temperature: 0.2, think_default: 'off', think_ceiling: 'off', system_prompt: null, fallback: null, canary: null, tools: [], label: 'internal', status: 'published', version: 1, updated_by: null, created_at: t, updated_at: t };
      await repo.createProfile(p);
    }
    await h.s.gateway.pollAll();
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  it('applies the tenant default, the person\'s own, then an enforced tenant default, and hides profiles', async () => {
    await localUser(h, 'mem', ['member']);
    await localUser(h, 'ma', ['model-admin'], 'confidential');
    const m = await login(h, 'mem');
    const a = await loginAdmin(h, 'ma');
    const put = (c: { agent: typeof m.agent; csrf: string }, path: string, body: object) => c.agent.put(path).set('x-csrf-token', c.csrf).send(body);
    const defaultOf = async () => (await m.agent.get('/api/chat/profiles').expect(200)).body.find((x: { default: boolean }) => x.default)?.name ?? null;

    expect(await defaultOf()).toBeNull();
    await put(a, '/api/admin/profile-defaults/tenant', { defaultProfile: 'cortex' }).expect(200);
    expect(await defaultOf()).toBe('cortex');

    await put(m, '/api/me/profile-preferences', { defaultProfile: 'spark', hidden: ['chat'] }).expect(200);
    expect(await defaultOf()).toBe('spark');
    const prefs = (await m.agent.get('/api/me/profile-preferences').expect(200)).body;
    expect(prefs.applies).toEqual({ profile: 'spark', source: 'user', enforced: false });
    expect(prefs.profiles.find((x: { name: string }) => x.name === 'chat').hidden).toBe(true);

    await put(a, '/api/admin/profile-defaults/tenant', { defaultProfile: 'chat', enforced: true }).expect(200);
    const list = (await m.agent.get('/api/chat/profiles').expect(200)).body;
    // the enforced default wins and stays visible even though the person hid it
    expect(list.find((x: { name: string }) => x.name === 'chat')).toMatchObject({ default: true, hidden: false, defaultSource: 'tenant', defaultEnforced: true });

    await put(m, '/api/me/profile-preferences', { defaultProfile: 'nope' }).expect(400);
    await put(a, '/api/admin/profile-defaults/tenant', { defaultProfile: 'nope' }).expect(400);
    await put(m, '/api/admin/profile-defaults/tenant', { defaultProfile: 'chat' }).expect(403);
    const defaults = (await a.agent.get('/api/admin/profile-defaults').expect(200)).body;
    expect(defaults.tenant).toMatchObject({ defaultProfile: 'chat', enforced: true });
    expect(Array.isArray(defaults.workspaces)).toBe(true);
  });
});
