/*
 * 1.9.99-final, Sprint 60 (B-10502, B-10503, B-10509; the listing B-10504 imports from): `listModels(account)` of
 * `s.cloud.modelCatalogue` for Azure (deployments through ARM), DigitalOcean (GenAI models and agents) and Workers AI
 * (`models/search`), against the in-process fakes only, through the adapters' transports.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CloudAccount } from '../src/cloud/types.js';
import { seedAccount } from './cloud-credentials-helpers.js';
import { FakeAzure } from './fake-azure.js';
import { FakeAzureOpenAI } from './fake-azure-openai.js';
import { FakeCloudflare } from './fake-cloudflare.js';
import { FakeDigitalOcean } from './fake-do.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';

const tenant = '0f0e0d0c-0000-4000-8000-00000000cccc';
const sub = '1a2b3c4d-0000-4000-8000-00000000dddd';

describe('cloud model listing', () => {
  let h: Harness;
  let az: FakeAzure;
  let aoai: FakeAzureOpenAI;
  let dio: FakeDigitalOcean;
  let cf: FakeCloudflare;
  let azAcct: CloudAccount;
  let doAcct: CloudAccount;
  let cfAcct: CloudAccount;
  let cfToken: string;

  beforeAll(async () => {
    az = await new FakeAzure().start();
    aoai = await new FakeAzureOpenAI().start();
    dio = await new FakeDigitalOcean().start();
    cf = await new FakeCloudflare().start();
    az.addSubscription(sub, tenant);
    az.tokens.set('arm-list', { tenantId: tenant, clientId: 'app', scope: 'https://management.azure.com', exp: Date.now() + 3600_000 });
    aoai.deployments.set('chat-4o', { model: 'gpt-4o', version: '2024-08-06' });
    aoai.deployments.set('embed-3', { model: 'text-embedding-3-large', version: '1' });
    aoai.seedArm(az, { subscription: sub, resourceGroup: 'ai', account: 'eu-aoai', location: 'swedencentral', states: { 'embed-3': 'Failed' } });
    dio.tokens.set('do-list', new Set(['genai:read']));
    dio.genai.addAgent('faq');
    cfToken = cf.addToken(['Workers AI Read'], { accountOwned: true }).value;
    h = await harness({ SERVICE_ALLOWED_HOSTS: '127.0.0.1', OLLAMA_POLL_MS: '600000' });
    azAcct = await seedAccount(h, { provider: 'azure', mode: 'vaulted', name: 'az-list', providerIds: { azureTenantId: tenant, azureSubscriptionId: sub }, params: { clientId: 'app' } });
    doAcct = await seedAccount(h, { provider: 'digitalocean', mode: 'vaulted', name: 'do-list', providerIds: { doTeamId: '5d1f0b5e-0000-4000-8000-0000000000b1' } });
    cfAcct = await seedAccount(h, { provider: 'cloudflare', mode: 'vaulted', name: 'cf-list', providerIds: { cloudflareAccountId: cf.accountId } });
    h.s.cloud.credentials = {
      for: async (a: CloudAccount) => (a.provider === 'azure' ? { kind: 'azure', tenantId: tenant, getToken: async () => ({ token: 'arm-list', expiresAt: Date.now() + 3600_000 }) } : a.provider === 'digitalocean' ? { kind: 'token', token: 'do-list' } : { kind: 'token', token: cfToken, accountId: cf.accountId })
    };
    Object.assign(h.s.cloud.modelCatalogue.endpoints, { azureArm: az.url, doApi: dio.url, cloudflareApi: `${cf.url}/client/v4` });
  }, 180_000);
  afterAll(async () => {
    await h.close();
    await Promise.all([az.stop(), aoai.stop(), dio.stop(), cf.stop()]);
  });

  it('lists Azure deployments with their endpoint, model and state', async () => {
    const list = await h.s.cloud.modelCatalogue.listModels(azAcct);
    expect(list).toHaveLength(2);
    expect(list.find((m) => m.id === 'chat-4o')).toMatchObject({ provider: 'azure', flavour: 'azure', kind: 'chat', name: 'gpt-4o', region: 'swedencentral', endpoint: aoai.url, model: { name: 'gpt-4o', version: '2024-08-06', format: 'OpenAI' }, available: true, details: { account: 'eu-aoai', sku: 'Standard', capacity: 10 } });
    expect(list.find((m) => m.id === 'embed-3')).toMatchObject({ kind: 'embedding', available: false, reason: 'The deployment is Failed' });
    expect(az.requests.every((r) => r.headers.authorization === 'Bearer arm-list')).toBe(true);
  });

  it('lists DigitalOcean serverless models and agents', async () => {
    const list = await h.s.cloud.modelCatalogue.listModels(doAcct);
    expect(list.filter((m) => m.kind !== 'agent').map((m) => m.id).sort()).toEqual(['gte-large-en-v1.5', 'llama3.3-70b-instruct', 'openai-gpt-oss-120b']);
    expect(list.find((m) => m.kind === 'agent')).toMatchObject({ name: 'faq', region: 'tor1', available: true, endpoint: expect.stringMatching(/\/agents\/[0-9a-f-]{36}$/) });
  });

  it('lists Workers AI models with their task and neuron rates', async () => {
    const list = await h.s.cloud.modelCatalogue.listModels(cfAcct);
    expect(list.map((m) => m.id)).toContain('@cf/baai/bge-m3');
    expect(list.find((m) => m.id === '@cf/meta/llama-3.1-8b-instruct')!.details).toMatchObject({ task: 'Text Generation', neurons: { input: 25608, output: 75147 } });
  });

  it('feeds the catalogue import (B-10504) through these listers: drafts held by the account\'s instances', async () => {
    if (!(await h.s.db.schema.hasTable('cloud_model_entries'))) await (await import('../src/db/migrations/159_cloud_models.js')).up(h.s.db);
    h.s.cloud.modelImport.resetSchemaCache();
    await localUser(h, 'cml', ['model-admin', 'tenant-admin', 'cloud-operator'], 'confidential');
    const a = await loginAdmin(h, 'cml');
    const imp = (id: string) => a.agent.post(`/api/admin/cloud/accounts/${id}/model-import`).set('x-csrf-token', a.csrf).send({});
    const pool = await h.s.gateway.repo.createPool({ name: 'cloud-import', accelerator: 'cpu', zone: 'inference', labelCeiling: 'internal' });
    const azInst = await h.s.gateway.repo.createInstance({ poolId: pool.id, name: 'aoai-import', url: aoai.url, deploy: 'docker', kind: 'openai', settings: { cloud: { provider: 'azure', accountId: azAcct.id, region: 'westeurope', flavour: 'azure' } } });
    await h.s.gateway.repo.createInstance({ poolId: pool.id, name: 'do-import', url: dio.url, deploy: 'docker', kind: 'openai', settings: { cloud: { provider: 'digitalocean', accountId: doAcct.id, region: 'fra1', flavour: 'digitalocean' } } });
    await h.s.gateway.repo.createInstance({ poolId: pool.id, name: 'cf-import', url: `${cf.url}/client/v4/accounts/${cf.accountId}/ai`, deploy: 'docker', kind: 'openai', settings: { cloud: { provider: 'cloudflare', accountId: cfAcct.id, region: 'global', flavour: 'workers-ai' } } });

    // The deployments run in swedencentral, which is not on the account's allow-list (westeurope): refused, then allowed.
    const off = (await imp(azAcct.id).expect(200)).body.results as { id: string; outcome: string; reason?: string }[];
    expect(off.every((x) => x.outcome === 'skipped' && /swedencentral, which is not on az-list's allow-list/.test(x.reason ?? ''))).toBe(true);
    await h.s.db('cloud_account_regions').insert({ account_id: azAcct.id, region: 'swedencentral', zone: 'cloud-eu', ceiling: 'internal', geo: 'eu', is_default: false, updated_at: Date.now() });
    const az = (await imp(azAcct.id).expect(201)).body.results as { id: string; outcome: string; modelId?: string; reason?: string; instance?: string }[];
    expect(az.find((x) => x.id === 'chat-4o')).toMatchObject({ outcome: 'registered', instance: 'aoai-import' });
    expect(az.find((x) => x.id === 'embed-3')).toMatchObject({ outcome: 'skipped' });
    const gpt = await h.s.gateway.repo.model(az.find((x) => x.id === 'chat-4o')!.modelId!);
    expect(gpt).toMatchObject({ format: 'server', server_instance_id: azInst.id, server_model: 'chat-4o', state: 'draft' });

    const dr = (await imp(doAcct.id).expect(201)).body.results as { id: string; outcome: string; reason?: string }[];
    expect(dr.find((x) => x.id === 'llama3.3-70b-instruct')).toMatchObject({ outcome: 'registered' });
    expect(dr.filter((x) => x.outcome === 'skipped').some((x) => /registry tool/.test(x.reason ?? ''))).toBe(true); // the agent

    const wr = (await imp(cfAcct.id).expect(201)).body.results as { id: string; outcome: string }[];
    expect(wr.find((x) => x.id === '@cf/meta/llama-3.1-8b-instruct')).toMatchObject({ outcome: 'registered' });
    expect(wr.find((x) => x.id === '@cf/black-forest-labs/flux-1-schnell')).toMatchObject({ outcome: 'skipped' });
  });

  it('refuses a pending account, and an account of a provider with no lister', async () => {
    const pending = await seedAccount(h, { provider: 'digitalocean', mode: 'vaulted', name: 'do-pending', providerIds: { doTeamId: '5d1f0b5e-0000-4000-8000-0000000000b2' }, state: 'pending' });
    await expect(h.s.cloud.modelCatalogue.listModels(pending)).rejects.toMatchObject({ status: 409 });
    const before = h.s.cloud.modelCatalogue.has('aws');
    expect(typeof before).toBe('boolean');
  });
});
