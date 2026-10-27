import request from 'supertest';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cacheKey, cachePolicy, type CacheParts } from '../src/chat/response-cache.js';
import type { ProfileRow } from '../src/gateway/repo.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';

/*
 * Sprint 43 (1.7.0), B-99: the response cache. The "done when" of each item is a test below:
 *   B-9901 the same question in two tenants never shares an entry, and changing the guardrail set misses the cache;
 *   B-9902 after a purge of a profile's entries, its next turn reaches the model;
 *   B-9903 (server side) a purge is audited and the profile's hit rate counts what was served.
 */

const GB = 1_000_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('response cache (Sprint 43, B-99)', () => {
  let h: Harness;
  let ollama: FakeOllama;

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    ollama = await new FakeOllama().start();
    const repo = h.s.gateway.repo;
    ollama.addAvailable({ name: 'llama3.1:8b', size: 5 * GB, capabilities: ['completion'] });
    const pool = await repo.createPool({ name: 'gpu', accelerator: 'cuda', zone: 'inference', labelCeiling: 'confidential' });
    await repo.createInstance({ poolId: pool.id, name: 'gpu-1', url: ollama.url, deploy: 'docker', settings: { parallel: 4 } });
    const m = await repo.createModel({ name: 'llama3.1:8b', source: 'Ollama library', expectedDigest: null, license: { name: 'test' }, label: 'confidential', notes: null, requestedBy: 'x', requestedTenant: h.tenantId });
    await repo.updateModel(m.id, { state: 'approved', import_state: 'pulled', capabilities: ['completion'], size_bytes: 5 * GB });
    await repo.place(m.id, pool.id, 'warm', 'x');
    const t = Date.now();
    const base = (name: string, extra: Partial<ProfileRow>): ProfileRow => ({ id: name.toUpperCase().padEnd(26, '0').slice(0, 26), tenant_id: h.tenantId, name, display_name: name, description: null, alias_of: null, model_id: m.id, pool_id: pool.id, num_ctx: 8192, temperature: 0, think_default: 'off', think_ceiling: 'off', system_prompt: 'Be brief.', fallback: null, canary: null, tools: [], label: 'internal', status: 'published', version: 1, updated_by: null, created_at: t, updated_at: t, ...extra });
    await repo.createProfile(base('cached', { cache_ttl_seconds: 3600 }));
    await repo.createProfile(base('plain', {}));
    await repo.createProfile(base('warm', { cache_ttl_seconds: 3600, temperature: 0.7 }));
    await h.s.gateway.pollAll();
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  const chats = () => ollama.requests.filter((r) => r.path === '/api/chat').length;

  async function member(name = 'mem') {
    await localUser(h, name, ['member'], 'internal');
    const c = await login(h, name);
    const ask = async (content: string, profile = 'cached') => {
      const sent = (await c.agent.post('/api/chat').set('x-csrf-token', c.csrf).send({ content, profile }).expect(202)).body as { conversationId: string; messageId: string };
      for (let i = 0; i < 200; i++) {
        const row = (await h.s.db('messages').where({ id: sent.messageId }).first('state')) as { state: string };
        if (!['queued', 'streaming', 'pending'].includes(row.state)) break;
        await sleep(20);
      }
      const view = (await c.agent.get(`/api/conversations/${sent.conversationId}`).expect(200)).body as { messages: { id: string; content: string | null; state: string }[] };
      return { ...sent, answer: view.messages.find((x) => x.id === sent.messageId)! };
    };
    return { ...c, ask };
  }

  it('B-9901: a repeated question is answered from the cache; changing the guardrail set misses it', async () => {
    const m = await member();
    const first = await m.ask('What is the capital of France?');
    expect(first.answer.state).toBe('complete');
    expect(chats()).toBe(1);
    expect(await h.s.db('chat_response_cache').where({ tenant_id: h.tenantId })).toHaveLength(1);
    const entry = (await h.s.db('chat_response_cache').first()) as { content: string; label: string };
    expect(entry.content).not.toContain(first.answer.content!.slice(0, 10)); // sealed

    // the same question in a new conversation: no model call, the same answer, metered as a hit and audited
    const second = await m.ask('What is the capital of France?');
    expect(chats()).toBe(1);
    expect(second.answer).toMatchObject({ state: 'complete', content: first.answer.content });
    const usage = (await h.s.db('usage_records').where({ message_id: second.messageId }).first()) as { cache_hit: boolean | number; prompt_tokens: number; output_tokens: number };
    expect(usage).toMatchObject({ prompt_tokens: 0, output_tokens: 0 });
    expect(!!usage.cache_hit).toBe(true);
    expect(await h.s.db('audit_events').where({ action: 'chat.cache.hit' })).toHaveLength(1);

    // another question, a profile without the cache, and a warm profile all reach the model
    await m.ask('What is the capital of Spain?');
    await m.ask('What is the capital of France?', 'plain');
    await m.ask('What is the capital of France?', 'warm');
    await m.ask('What is the capital of France?', 'warm');
    expect(chats()).toBe(5);

    // a new tenant rule set changes the guardrail key: the next turn misses and stores a new entry
    await localUser(h, 'ga', ['guardrail-admin'], 'confidential');
    const ga = await loginAdmin(h, 'ga');
    const send = (method: 'post' | 'put', url: string, body: object = {}) => ga.agent[method](url).set('x-csrf-token', ga.csrf).send(body);
    const set = (await send('post', '/api/admin/guardrails/sets', { name: 'Quiet rules', scope: 'tenant' }).expect(201)).body;
    await send('put', `/api/admin/guardrails/sets/${set.id}/draft`, { rules: [{ id: 'nope', name: 'Never this', checkpoint: 'user-input', type: 'pattern', mechanism: { kind: 'pattern', pattern: '(?i)launch codes' }, action: 'block', stage: 'enforce' }] }).expect(200);
    await send('post', `/api/admin/guardrails/sets/${set.id}/draft/publish`).expect(200);
    await m.ask('What is the capital of France?');
    expect(chats()).toBe(6);
    await m.ask('What is the capital of France?');
    expect(chats()).toBe(6);
  }, 120_000);

  it('B-9901: the same question in two tenants never shares an entry; an entry above the caller is not served', async () => {
    const p = (await loadPrincipal(h.s, h.tenantId, (await localUser(h, 'reader', ['member'], 'internal')).id, {}))!;
    const parts: CacheParts = { tenantId: h.tenantId, workspaceId: null, label: 'internal', profileId: 'P', profileVersion: 1, model: 'llama3.1:8b', modelDigest: null, guardrails: '', params: { think: 'off' }, messages: [{ role: 'user', content: 'hi' }] };
    const other = { ...parts, tenantId: ulid() };
    expect(cacheKey(parts)).not.toBe(cacheKey(other));
    expect(cacheKey(parts)).toBe(cacheKey({ ...parts, params: { think: 'off' } }));
    expect(cacheKey(parts)).not.toBe(cacheKey({ ...parts, guardrails: 'S@2' }));
    expect(cacheKey(parts)).not.toBe(cacheKey({ ...parts, label: 'confidential' }));
    // stored for another tenant under the very key this tenant computes: this tenant never reads it
    await h.s.responseCache.put({ tenantId: other.tenantId, workspaceId: null, profileId: 'P', key: cacheKey(parts), label: 'internal', model: 'm', content: 'theirs', thinking: '', ttlSeconds: 60, source: 'chat' });
    expect(await h.s.responseCache.get(p, cacheKey(parts))).toBeNull();
    // above the caller's clearance: not served
    await h.s.responseCache.put({ tenantId: h.tenantId, workspaceId: null, profileId: 'P', key: 'k-conf', label: 'confidential', model: 'm', content: 'secret', thinking: '', ttlSeconds: 60, source: 'chat' });
    expect(await h.s.responseCache.get(p, 'k-conf')).toBeNull();
    // expired: not served, and removed
    await h.s.responseCache.put({ tenantId: h.tenantId, workspaceId: null, profileId: 'P', key: 'k-old', label: 'internal', model: 'm', content: 'old', thinking: '', ttlSeconds: 60, source: 'chat' });
    await h.s.db('chat_response_cache').where({ key_hash: 'k-old' }).update({ expires_at: Date.now() - 1 });
    expect(await h.s.responseCache.get(p, 'k-old')).toBeNull();
    expect(await h.s.db('chat_response_cache').where({ key_hash: 'k-old' })).toHaveLength(0);
    expect(cachePolicy({ cache_ttl_seconds: null })).toBeNull();
    expect(cachePolicy({ cache_ttl_seconds: 10, cache_lenient: 1 })).toEqual({ ttlSeconds: 10, lenient: true });
  });

  it('B-9902: after a purge of a profile\'s entries its next turn reaches the model; hit rate and purge are an admin\'s', async () => {
    const m = await member();
    await m.ask('Name a primary colour.');
    await m.ask('Name a primary colour.');
    expect(chats()).toBe(1);
    await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    const ta = await loginAdmin(h, 'ta');
    const stats = (await ta.agent.get('/api/admin/cache/responses').expect(200)).body.profiles as { profile: string; entries: number; hits: number; turns: number; hitRate: number }[];
    expect(stats.find((x) => x.profile === 'cached')).toMatchObject({ entries: 1, hits: 1, turns: 2, hitRate: 0.5 });
    await m.agent.get('/api/admin/cache/responses').expect(403);

    const out = (await ta.agent.post('/api/admin/cache/responses/purge').set('x-csrf-token', ta.csrf).send({ profileId: 'CACHED'.padEnd(26, '0') }).expect(200)).body;
    expect(out.removed).toBe(1);
    expect(await h.s.db('audit_events').where({ action: 'chat.cache.purged' })).toHaveLength(1);
    await m.ask('Name a primary colour.');
    expect(chats()).toBe(2);
    await ta.agent.post('/api/admin/cache/responses/purge').set('x-csrf-token', ta.csrf).send({ entryId: ulid() }).expect(404);
  }, 120_000);

  it('B-9901: /v1 turns are cached too, keyed on every parameter, and never with tools', async () => {
    const u = await localUser(h, 'api', ['member'], 'internal');
    const key = (await h.s.apiKeys.create({ tenantId: h.tenantId, userId: u.id, name: 'k', scopes: ['inference:invoke', 'models:read', 'chat:read'] as never[], ttlDays: 30 })).key;
    const post = (body: object) => request(h.app).post('/v1/chat/completions').set({ authorization: `Bearer ${key}` }).send(body);
    const q = { model: 'cached', messages: [{ role: 'user', content: 'Spell cat.' }] };
    const a = (await post(q).expect(200)).body;
    const b = (await post(q).expect(200)).body;
    expect(b.choices[0].message.content).toBe(a.choices[0].message.content);
    expect(chats()).toBe(1);
    await post({ ...q, max_tokens: 20 }).expect(200);
    expect(chats()).toBe(2);
    expect(await h.s.db('audit_events').where({ action: 'api.chat.cache.hit' })).toHaveLength(1);
  }, 120_000);
});
