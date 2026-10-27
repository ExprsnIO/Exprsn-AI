/*
 * 1.9.99-final, Sprint 60 (B-10509): Cloudflare Workers AI against `fake-cloudflare.ts` (with `fake-workers-ai.ts`)
 * only: the OpenAI-compatible endpoint (`/client/v4/accounts/<id>/ai/v1/...`) as a `kind: openai` instance (flavour
 * `workers-ai`) with the account's scoped token, a turn metered with its neurons and their cost on the usage record
 * (migration `160_cloud_model_servers`, applied here when missing), and the neuron price from the price sheet.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { neuronCostMicros, NEURON_PRICE_ID, workersAiNeurons } from '../src/cloud/model-backends.js';
import type { CloudAccount } from '../src/cloud/types.js';
import { seedAccount } from './cloud-credentials-helpers.js';
import { chatTurn, cloudProfile, modelsWorld, type ModelsWorld } from './cloud-models-helpers.js';
import { FakeCloudflare } from './fake-cloudflare.js';

describe('B-10509: Workers AI', () => {
  let w: ModelsWorld;
  let cf: FakeCloudflare;
  let account: CloudAccount;
  let token: string;

  beforeAll(async () => {
    cf = await new FakeCloudflare().start();
    token = cf.addToken(['Workers AI Read'], { accountOwned: true }).value;
    w = await modelsWorld();
    if (!(await w.h.s.db.schema.hasColumn('usage_records', 'neurons'))) await (await import('../src/db/migrations/160_cloud_model_servers.js')).up(w.h.s.db);
    w.h.s.quotas.resetPriceColumns();
    account = await seedAccount(w.h, { provider: 'cloudflare', mode: 'vaulted', name: 'cf-models', providerIds: { cloudflareAccountId: cf.accountId } });
    w.h.s.cloud.credentials = { for: async () => ({ kind: 'token', token, accountId: cf.accountId }) };
    w.h.s.cloud.modelCatalogue.endpoints.cloudflareApi = `${cf.url}/client/v4`;
  }, 180_000);
  afterAll(async () => {
    await w.h.close();
    await cf.stop();
  });

  it('prices neurons from the sheet', () => {
    // llama-3.1-8b: 25,608 neurons per million input tokens, 75,147 per million output; USD 0.011 per 1,000 neurons.
    expect(workersAiNeurons('@cf/meta/llama-3.1-8b-instruct', 1000, 500)).toBe(63);
    expect(neuronCostMicros(63)).toBe(693);
    expect(workersAiNeurons('@cf/unknown/model', 1000, 500)).toBeNull();
    expect(NEURON_PRICE_ID).toMatch(/^workers-ai:neurons@\d{4}-\d{2}-\d{2}$/);
  });

  it('meters a turn with its neurons and their cost on the usage record', async () => {
    const { inst } = await cloudProfile(w, { pool: 'cf-edge', instance: { name: 'workers-ai', url: `${cf.url}/client/v4/accounts/${cf.accountId}/ai`, cloud: { flavour: 'workers-ai', accountId: account.id, region: 'global' } }, serverModel: '@cf/meta/llama-3.1-8b-instruct', profile: 'cf-llama' });
    expect(inst).toMatchObject({ kind: 'openai', health: 'healthy', version: 'workers-ai' });
    // Text generation and embeddings are listed; an image model is not a chat model.
    expect(inst.available.map((x: { name: string }) => x.name).sort()).toEqual(['@cf/baai/bge-m3', '@cf/meta/llama-3.1-8b-instruct', '@cf/meta/llama-3.2-1b-instruct']);
    cf.workersAi.usage = { prompt_tokens: 1000, completion_tokens: 500 };
    w.h.s.cloud.modelBackends.resetPools();
    const r = await chatTurn(w, 'cf-llama', 'Hello edge');
    expect(r.state).toBe('complete');
    const call = cf.requests.filter((x) => x.path.endsWith('/ai/v1/chat/completions')).at(-1)!;
    expect(call.path).toBe(`/client/v4/accounts/${cf.accountId}/ai/v1/chat/completions`);
    expect(call.headers.authorization).toBe(`Bearer ${token}`);
    const [u] = await w.h.s.db('usage_records').where({ message_id: r.sent.messageId });
    expect(u).toMatchObject({ kind: 'chat', model: '@cf/meta/llama-3.1-8b-instruct', currency: 'USD', price_id: NEURON_PRICE_ID });
    expect(Number(u.prompt_tokens)).toBe(1000);
    expect(Number(u.output_tokens)).toBe(500);
    expect(Number(u.neurons)).toBe(63);
    expect(Number(u.cost_micros)).toBe(693);
  });

  it('leaves records of other models without neurons or cost', async () => {
    await w.h.s.quotas.record({ tenantId: w.h.tenantId, workspaceId: null, userId: null, kind: 'chat', model: 'llama3.1:8b', poolId: 'nope', promptTokens: 10, outputTokens: 10 });
    const u = await w.h.s.db('usage_records').where({ model: 'llama3.1:8b' }).first();
    expect(u.neurons).toBeNull();
    expect(u.cost_micros).toBeNull();
  });

  it('refuses the account token without Workers AI Read, and lists Workers AI models for the catalogue', async () => {
    const list = await w.h.s.cloud.modelCatalogue.listModels(account);
    expect(list.find((m) => m.id === '@cf/meta/llama-3.1-8b-instruct')).toMatchObject({ provider: 'cloudflare', flavour: 'workers-ai', kind: 'chat', endpoint: `${cf.url}/client/v4/accounts/${cf.accountId}/ai` });
    expect(list.find((m) => m.id === '@cf/black-forest-labs/flux-1-schnell')).toMatchObject({ kind: 'other', endpoint: null });
    const weak = cf.addToken(['DNS Read'], { accountOwned: true }).value;
    w.h.s.cloud.credentials = { for: async () => ({ kind: 'token', token: weak, accountId: cf.accountId }) };
    await expect(w.h.s.cloud.modelCatalogue.listModels(account)).rejects.toThrow(/403/);
    w.h.s.cloud.credentials = { for: async () => ({ kind: 'token', token, accountId: cf.accountId }) };
  });
});
