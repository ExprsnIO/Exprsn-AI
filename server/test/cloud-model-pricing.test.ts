import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { costAt, DAY, NEURON_PRICE_ID, sheetModelPrices, type ModelPrice } from '../src/cloud/model-prices.js';
import type { CloudAccount } from '../src/cloud/types.js';
import { seedAccount } from './cloud-credentials-helpers.js';
import { FakeAws } from './fake-aws.js';
import { FakeAzure } from './fake-azure.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * 1.9.99-final, Sprint 61 (B-10505): per-model prices of the cloud model APIs, against the fakes only (the AWS Price
 * List `GetProducts` for AmazonBedrock in `fake-aws.ts`, the Azure Retail Prices API's Azure OpenAI meters in
 * `fake-azure.ts`), the price sheet (DigitalOcean GenAI, Workers AI neurons) and versions made by hand; never a real
 * price API (EXPRSN_TESTS_OFFLINE). Each provider's prices with their effective dates, cached input tokens,
 * embeddings, neurons, the cost on every cloud usage record (and none on an Ollama one), a price change that applies
 * from its effective date only, and the usage report's day cost equal to the sum of its records' cost_micros.
 * Migrations 146, 159, 160 and 163 are applied here when missing (none is registered yet).
 */

vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 });

const HAIKU = 'anthropic.claude-3-haiku-20240307-v1:0';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const at = (d: string) => Date.parse(`${d}T12:00:00Z`);

describe('pricing arithmetic and the sheet (B-10505)', () => {
  const base: ModelPrice = { id: null, provider: 'aws', region: '*', model: 'm', currency: 'USD', basis: 'tokens', inputPerMillion: 3, outputPerMillion: 15, cachedPerMillion: 0.3, neuronsInput: null, neuronsOutput: null, neuronPrice: null, effectiveFrom: '2026-10-01', source: 'manual', ref: null, unverified: false, priceId: 'manual:x' };

  it('prices input, cached input and output tokens per million, in micro-units', () => {
    // 1,000 prompt tokens of which 400 cached, 200 output (and 50 thinking, priced as output): 600×3 + 400×0.3 + 250×15.
    expect(costAt(base, { promptTokens: 1000, cachedTokens: 400, outputTokens: 200, thinkingTokens: 50 })).toEqual({ neurons: null, costMicros: 600 * 3 + 400 * 0.3 + 250 * 15 });
    // Without a cached rate, cached tokens cost the input rate; more cached than prompt tokens is capped.
    expect(costAt({ ...base, cachedPerMillion: null }, { promptTokens: 1000, cachedTokens: 5000, outputTokens: 0 }).costMicros).toBe(3000);
    // An embedding model: its tokens are input tokens.
    expect(costAt({ ...base, inputPerMillion: 0.02, outputPerMillion: 0, cachedPerMillion: null }, { promptTokens: 50_000 }).costMicros).toBe(1000);
  });

  it('prices Workers AI in neurons, as Sprint 60 did', () => {
    const p = sheetModelPrices().find((x) => x.provider === 'cloudflare' && x.model === '@cf/meta/llama-3.1-8b-instruct')!;
    expect(p).toMatchObject({ basis: 'neurons', neuronsInput: 25608, neuronsOutput: 75147, neuronPrice: 0.011, unverified: false, priceId: NEURON_PRICE_ID });
    expect(costAt(p, { promptTokens: 1000, outputTokens: 500 })).toEqual({ neurons: 63, costMicros: 693 });
  });

  it('dates and sources every model entry of the sheet; what is not confirmed is marked unverified', () => {
    const entries = sheetModelPrices().filter((p) => p.basis === 'tokens');
    expect(new Set(entries.map((e) => e.provider))).toEqual(new Set(['aws', 'azure', 'digitalocean']));
    for (const e of entries) {
      expect(e.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.ref).toMatch(/^https:\/\/(pricing\.us-east-1\.amazonaws\.com|prices\.azure\.com|docs\.digitalocean\.com|www\.digitalocean\.com)\//);
      expect(e.inputPerMillion).toBeGreaterThan(0);
    }
    // Checked 2026-10-21: every Bedrock and Azure entry; DigitalOcean's retired models stay unverified.
    expect(entries.filter((e) => e.unverified).map((e) => e.model).sort()).toEqual(['anthropic-claude-3.5-haiku', 'deepseek-r1-distill-llama-70b', 'llama3-8b-instruct', 'llama3.3-70b-instruct', 'mistral-nemo-instruct-2407']);
    expect(entries.find((e) => e.model === 'llama3.3-70b-instruct')).toMatchObject({ provider: 'digitalocean', inputPerMillion: 0.65, outputPerMillion: 0.65, unverified: true });
    expect(entries.find((e) => e.model === 'anthropic.claude-3-5-haiku-20241022-v1:0')).toMatchObject({ inputPerMillion: 0.8, outputPerMillion: 4, cachedPerMillion: 0.08, unverified: false, effectiveFrom: '2026-07-01' });
    expect(entries.find((e) => e.provider === 'azure' && e.model === 'gpt-4o')).toMatchObject({ inputPerMillion: 2.5, outputPerMillion: 10, cachedPerMillion: 1.25, unverified: false });
  });
});

describe('cloud model prices and metering (B-10505)', () => {
  let h: Harness;
  const aws = new FakeAws();
  const azure = new FakeAzure();
  let a: Client;
  let fin: Client;
  const acc: Record<string, CloudAccount> = {};
  const pools: Record<string, string> = {};
  const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);
  const put = (c: Client, url: string, body: object = {}) => c.agent.put(url).set('x-csrf-token', c.csrf).send(body);

  /** A catalogue model with a cloud entry, as the import makes them (inserted here: the import has its own suite). */
  const entry = async (account: CloudAccount, o: { name: string; flavour: string; region: string; offer?: string; routes?: string[]; details?: Record<string, unknown>; instanceId?: string }) => {
    const m = await h.s.gateway.repo.createModel({ name: o.name, source: `cloud:${o.flavour}/${account.name}/${o.region}/${o.name}`, expectedDigest: null, license: { name: 'Provider terms' }, label: 'internal', notes: null, requestedBy: 'test', requestedTenant: h.tenantId, ...(o.instanceId ? { server: { instanceId: o.instanceId, model: o.name, capabilities: ['completion'], contextLength: null, family: null } } : {}) });
    const now = Date.now();
    await h.s.db('cloud_model_entries').insert({ model_id: m.id, provider: account.provider, account_id: account.id, region: o.region, external_id: o.name, flavour: o.flavour, offer: o.offer ?? 'foundation', routes_to: JSON.stringify(o.routes ?? [o.region]), label_ceiling: 'internal', terms: null, access_state: 'granted', details: JSON.stringify(o.details ?? {}), imported_by: null, imported_at: now, updated_at: now });
    return m;
  };

  const record = (pool: string, model: string, o: { prompt?: number; output?: number; cached?: number; ts?: number; kind?: 'chat' | 'embed' } = {}) => h.s.quotas.record({ tenantId: h.tenantId, workspaceId: null, userId: null, kind: o.kind ?? 'chat', model, poolId: pool, promptTokens: o.prompt ?? 1000, outputTokens: o.output ?? 500, ...(o.cached ? { cachedTokens: o.cached } : {}), ts: o.ts ?? Date.now() });
  const last = async (model: string) => (await h.s.db('usage_records').where({ model }).orderBy('id', 'desc').first()) as Record<string, unknown>;

  beforeAll(async () => {
    await Promise.all([aws.start(), azure.start()]);
    h = await harness({ SERVICE_ALLOWED_HOSTS: '127.0.0.1', OLLAMA_POLL_MS: '600000' });
    if (!(await h.s.db.schema.hasTable('cloud_accounts'))) await (await import('../src/db/migrations/146_cloud_accounts.js')).up(h.s.db);
    if (!(await h.s.db.schema.hasTable('cloud_model_entries'))) await (await import('../src/db/migrations/159_cloud_models.js')).up(h.s.db);
    if (!(await h.s.db.schema.hasColumn('usage_records', 'cost_micros'))) await (await import('../src/db/migrations/160_cloud_model_servers.js')).up(h.s.db);
    if (!(await h.s.db.schema.hasTable('cloud_model_prices'))) await (await import('../src/db/migrations/163_cloud_model_prices.js')).up(h.s.db);
    h.s.cloud.accounts.resetSchemaCache();
    h.s.cloud.modelImport.resetSchemaCache();
    h.s.cloud.modelPrices.resetSchemaCache();
    h.s.quotas.resetPriceColumns();
    const key = aws.addUser({ userName: 'exprsn-billing' });
    (h.s.cloud as { credentials: unknown }).credentials = { for: async () => ({ kind: 'aws', accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey, expiresAt: null }) };
    h.s.cloud.modelPrices.setEndpoints({ awsPricing: aws.url, azureRetail: `${azure.url}/api/retail/prices` });
    h.s.cloud.modelPrices.setTransport({ sleep: async () => {}, random: () => 0.5 });
    h.s.cloud.bedrock.setEndpoints({ bedrock: aws.url, bedrockRuntime: aws.url });
    h.s.cloud.bedrock.setTransport({ sleep: async () => {}, random: () => 0.5 });
    acc.aws = await seedAccount(h, { provider: 'aws', mode: 'vaulted', name: 'aws-prices', providerIds: { awsAccountId: aws.account } });
    acc.azure = await seedAccount(h, { provider: 'azure', mode: 'vaulted', name: 'az-prices', providerIds: { azureTenantId: '11111111-2222-3333-4444-555555555555', azureSubscriptionId: '99999999-8888-7777-6666-555555555555' } });
    acc.do = await seedAccount(h, { provider: 'digitalocean', mode: 'vaulted', name: 'do-prices', providerIds: { doTeamId: 'team-1' } });
    acc.cf = await seedAccount(h, { provider: 'cloudflare', mode: 'vaulted', name: 'cf-prices', providerIds: { cloudflareAccountId: 'cf-1' } });
    // One pool per provider holding its cloud instance (the pricer reads the pool's instance; nothing is called).
    const repo = h.s.gateway.repo;
    const mk = async (k: string, settings: Record<string, unknown>, kind: 'bedrock' | 'openai') => {
      const pool = await repo.createPool({ name: `p-${k}`, accelerator: 'cpu', zone: 'inference', labelCeiling: 'internal' });
      const inst = await repo.createInstance({ poolId: pool.id, name: `i-${k}`, url: 'https://example.invalid', deploy: 'docker', kind, settings: settings as never });
      pools[k] = pool.id;
      return inst;
    };
    await mk('aws', { cloud: { provider: 'aws', accountId: acc.aws.id, region: 'eu-central-1' } }, 'bedrock');
    const az = await mk('azure', { cloud: { provider: 'azure', accountId: acc.azure.id, region: 'westeurope', flavour: 'azure' }, reported: { models: [{ id: 'mini-prod', available: true, ownedBy: 'gpt-4o-mini' }] } }, 'openai');
    await mk('do', { cloud: { provider: 'digitalocean', accountId: acc.do.id, region: 'fra1', flavour: 'digitalocean' } }, 'openai');
    await mk('cf', { cloud: { provider: 'cloudflare', accountId: acc.cf.id, region: 'global', flavour: 'workers-ai' } }, 'openai');
    const ollamaPool = await repo.createPool({ name: 'p-ollama', accelerator: 'cuda', zone: 'inference', labelCeiling: 'internal' });
    await repo.createInstance({ poolId: ollamaPool.id, name: 'i-ollama', url: 'http://127.0.0.1:9', deploy: 'docker', settings: {} });
    pools.ollama = ollamaPool.id;
    await entry(acc.aws, { name: HAIKU, flavour: 'bedrock', region: 'eu-central-1', details: { name: 'Claude 3 Haiku' } });
    await entry(acc.aws, { name: 'amazon.titan-embed-text-v2:0', flavour: 'bedrock', region: 'eu-central-1', details: { name: 'Titan Text Embeddings V2' } });
    await entry(acc.azure, { name: 'mini-prod', flavour: 'azure', region: 'westeurope', offer: 'deployment', details: { sku: 'Standard', model: { name: 'gpt-4o-mini', version: '2024-07-18' } }, instanceId: az.id });
    await localUser(h, 'pca', ['model-admin', 'tenant-admin', 'cloud-operator'], 'confidential');
    await localUser(h, 'pcf', ['cloud-admin', 'auditor', 'tenant-admin'], 'confidential');
    a = await loginAdmin(h, 'pca');
    fin = await loginAdmin(h, 'pcf');
  }, 180_000);

  afterAll(async () => {
    await h?.close();
    await Promise.all([aws.stop(), azure.stop()]);
  });

  beforeEach(() => {
    h.s.cloud.modelPrices.useSheet(null);
    h.s.cloud.modelPrices.resetPools();
  });

  it('AWS: Bedrock prices from the Price List API (AmazonBedrock, AmazonBedrockFoundationModels), per million tokens with their effective date', async () => {
    // Anthropic's models are a Marketplace seller's (AmazonBedrockFoundationModels, per 1M tokens); Titan is Amazon's.
    aws.setBedrockPrice('Claude 3 Haiku', 'eu-central-1', { input: '0.25', output: '1.25', cached: '0.025', unit: '1M tokens', effectiveDate: '2026-10-01' });
    aws.setBedrockPrice('Titan Text Embeddings V2', 'eu-central-1', { input: '0.00002', effectiveDate: '2026-09-15' });
    const r = (await post(fin, `/api/admin/cloud/accounts/${acc.aws!.id}/model-prices/refresh`).expect(200)).body;
    expect(r).toMatchObject({ account: 'aws-prices', fetched: 2, failed: [] });
    const got = await h.s.cloud.modelPrices.priceAt('aws', HAIKU, 'eu-central-1', at('2026-10-20'), { verified: true });
    expect(got).toMatchObject({ source: 'aws-price-list', inputPerMillion: 0.25, outputPerMillion: 1.25, cachedPerMillion: 0.025, effectiveFrom: '2026-10-01', region: 'eu-central-1', currency: 'USD' });
    // An inference profile is priced at its model's price in the source region.
    expect(await h.s.cloud.modelPrices.priceAt('aws', `eu.${HAIKU}`, 'eu-central-1', at('2026-10-20'), { verified: true })).toMatchObject({ inputPerMillion: 0.25 });
    // The latency-optimized, flex and priority products beside the standard ones are not read.
    expect(await h.s.cloud.modelPrices.priceAt('aws', 'amazon.titan-embed-text-v2:0', 'eu-central-1', at('2026-09-20'), { verified: true })).toMatchObject({ source: 'aws-price-list', inputPerMillion: 0.02, effectiveFrom: '2026-09-15' });
    // The calls were signed for the Price List API with the account's credential, filtered by region and the price
    // list's model name (`model`; Titan's is `titanModel`), under both service codes.
    const calls = aws.requests.filter((x) => x.headers['x-amz-target'] === 'AWSPriceListService.GetProducts');
    const haiku = calls.filter((x) => x.body.includes('Claude 3 Haiku')).map((x) => JSON.parse(x.body) as { ServiceCode: string });
    expect(haiku.map((x) => x.ServiceCode).sort()).toEqual(['AmazonBedrock', 'AmazonBedrockFoundationModels']);
    expect(haiku[0]).toMatchObject({ Filters: expect.arrayContaining([expect.objectContaining({ Field: 'regionCode', Value: 'eu-central-1' }), expect.objectContaining({ Field: 'model', Value: 'Claude 3 Haiku' })]) });
    const call = calls.find((x) => x.body.includes('TitanEmbeddingsV2-Text-input'))!;
    expect(JSON.parse(call.body)).toMatchObject({ ServiceCode: 'AmazonBedrock', Filters: expect.arrayContaining([expect.objectContaining({ Field: 'regionCode', Value: 'eu-central-1' }), expect.objectContaining({ Field: 'titanModel', Value: 'TitanEmbeddingsV2-Text-input' })]) });
    expect(call.headers.authorization).toMatch(/\/us-east-1\/pricing\/aws4_request/);
    // Refreshing again finds the same versions: nothing new is stored.
    expect((await post(fin, `/api/admin/cloud/accounts/${acc.aws!.id}/model-prices/refresh`).expect(200)).body).toMatchObject({ fetched: 0, known: 2 });
  });

  it('Azure: Azure OpenAI meters from the Retail Prices API, of the deployment type, not a longer model\'s', async () => {
    const meter = (m: string, price: number, date = '2026-08-01T00:00:00Z') => azure.addOpenAiMeter({ region: 'westeurope', meter: m, retailPrice: price, effectiveStartDate: date });
    meter('gpt-4o-mini-0718-Inp-regnl', 0.000165);
    meter('gpt-4o-mini-0718-Outp-regnl', 0.00066);
    meter('gpt-4o-mini-0718-cchd-Inp-regnl', 0.0000825, '2026-09-01T00:00:00Z');
    meter('gpt-4o-mini-0718-Inp-glbl', 0.00015);
    meter('gpt-4o-mini-0718-Outp-glbl', 0.0006);
    meter('gpt-4o-0806-Inp-regnl', 0.00275);
    meter('gpt-4o-mini-0718-Inp-regnl-Batch', 0.0000825);
    // The spaced spellings, the data zone abbreviations, per-version meters and the other Azure OpenAI products.
    meter('gpt 4o mini 0718 Inp Data Zone', 0.000165);
    meter('gpt 4o mini 0718 Outp Data Zone', 0.00066);
    meter('gpt 4o mini 0718 cached Inp DZone', 0.000083);
    meter('gpt 4o 0513 Input global', 0.005, '2024-07-01T00:00:00Z');
    meter('gpt 4o 0513 Output global', 0.015, '2024-07-01T00:00:00Z');
    meter('gpt 4o 1120 Inp glbl', 0.0025, '2024-12-01T00:00:00Z');
    meter('gpt 4o 1120 Outp glbl', 0.01, '2024-12-01T00:00:00Z');
    meter('gpt 4o 1120 cached Inp glbl', 0.00125, '2024-12-01T00:00:00Z');
    meter('gpt 4o tcrb d txt inp glbl', 0.0025);
    azure.addOpenAiMeter({ region: 'westeurope', meter: 'text embedding 3 small DZ', retailPrice: 0.000022, productName: 'Azure OpenAI Embedding', effectiveStartDate: '2026-02-01T00:00:00Z' });
    azure.addOpenAiMeter({ region: 'westeurope', meter: 'gpt4o mn trscb txt in gl 1215 1M', retailPrice: 1.25, unitOfMeasure: '1M', productName: 'Azure OpenAI Media' });
    const r = (await post(fin, `/api/admin/cloud/accounts/${acc.azure!.id}/model-prices/refresh`).expect(200)).body;
    expect(r).toMatchObject({ fetched: 1, failed: [] });
    const p = await h.s.cloud.modelPrices.priceAt('azure', 'gpt-4o-mini', 'westeurope', at('2026-10-20'), { verified: true });
    expect(p).toMatchObject({ source: 'azure-retail-prices', inputPerMillion: 0.165, outputPerMillion: 0.66, cachedPerMillion: 0.0825, effectiveFrom: '2026-09-01' });
    // A global deployment reads the global meters; a data zone one the data zone meters, however spelt.
    expect(await h.s.cloud.modelPrices.fetchAzure('westeurope', 'gpt-4o-mini', 'GlobalStandard', 'USD')).toMatchObject({ inputPerMillion: 0.15, outputPerMillion: 0.6, cachedPerMillion: null });
    expect(await h.s.cloud.modelPrices.fetchAzure('westeurope', 'gpt-4o-mini', 'DataZoneStandard', 'USD')).toMatchObject({ inputPerMillion: 0.165, outputPerMillion: 0.66, cachedPerMillion: 0.083 });
    expect(await h.s.cloud.modelPrices.fetchAzure('westeurope', 'text-embedding-3-small', 'DataZoneStandard', 'USD')).toMatchObject({ inputPerMillion: 0.022, outputPerMillion: 0, effectiveFrom: '2026-02-01' });
    // A model priced per version: the deployment's version, else the latest the meters name.
    expect(await h.s.cloud.modelPrices.fetchAzure('westeurope', 'gpt-4o', 'GlobalStandard', 'USD')).toMatchObject({ inputPerMillion: 2.5, outputPerMillion: 10, cachedPerMillion: 1.25, effectiveFrom: '2024-12-01' });
    expect(await h.s.cloud.modelPrices.fetchAzure('westeurope', 'gpt-4o', 'GlobalStandard', 'USD', '2024-05-13')).toMatchObject({ inputPerMillion: 5, outputPerMillion: 15, cachedPerMillion: null, effectiveFrom: '2024-07-01' });
    const q = azure.requests.filter((x) => x.path === '/api/retail/prices').at(-1)!;
    expect(q.query.get('$filter')).toBe("serviceName eq 'Foundry Models' and startswith(productName, 'Azure OpenAI') and armRegionName eq 'westeurope' and priceType eq 'Consumption'");
    // DigitalOcean and Cloudflare have no price API.
    expect((await post(fin, `/api/admin/cloud/accounts/${acc.do!.id}/model-prices/refresh`).expect(200)).body.skipped).toMatch(/no price API/);
  });

  it('puts the cost on every cloud usage record (tokens, cached tokens, embeddings, neurons), none on an Ollama one', async () => {
    // Bedrock: 1,000 prompt tokens of which 400 from the cache, 500 output, at 0.25 / 0.025 / 1.25 per million.
    await record(pools.aws!, HAIKU, { prompt: 1000, cached: 400, output: 500 });
    const b = await last(HAIKU);
    const pid = (await h.s.cloud.modelPrices.priceAt('aws', HAIKU, 'eu-central-1', Date.now(), { verified: true }))!.priceId;
    expect(b).toMatchObject({ currency: 'USD', price_id: pid });
    expect(Number(b.cost_micros)).toBe(Math.round(600 * 0.25 + 400 * 0.025 + 500 * 1.25));
    expect(Number(b.cached_tokens)).toBe(400);
    expect(b.neurons).toBeNull();
    // An embedding record: its tokens at the embedding price.
    await record(pools.aws!, 'amazon.titan-embed-text-v2:0', { prompt: 50_000, output: 0, kind: 'embed' });
    expect(Number((await last('amazon.titan-embed-text-v2:0')).cost_micros)).toBe(1000);
    // Azure: a deployment is priced as its model (gpt-4o-mini, regional).
    await record(pools.azure!, 'mini-prod', { prompt: 2000, output: 1000 });
    expect(Number((await last('mini-prod')).cost_micros)).toBe(Math.round(2000 * 0.165 + 1000 * 0.66));
    // Workers AI: neurons and their cost, as Sprint 60 metered them.
    await record(pools.cf!, '@cf/meta/llama-3.1-8b-instruct', { prompt: 1000, output: 500 });
    expect(await last('@cf/meta/llama-3.1-8b-instruct')).toMatchObject({ price_id: NEURON_PRICE_ID, currency: 'USD' });
    expect(Number((await last('@cf/meta/llama-3.1-8b-instruct')).neurons)).toBe(63);
    expect(Number((await last('@cf/meta/llama-3.1-8b-instruct')).cost_micros)).toBe(693);
    // DigitalOcean: the sheet's entry is unverified, so it prices nothing until confirmed or recorded by hand.
    await record(pools.do!, 'llama3.3-70b-instruct');
    expect((await last('llama3.3-70b-instruct')).cost_micros).toBeNull();
    const card = (await a.agent.get('/api/admin/cloud/model-prices?provider=digitalocean&model=llama3.3-70b-instruct').expect(200)).body.prices;
    expect(card[0]).toMatchObject({ source: 'price-sheet', unverified: true, inputPerMillion: 0.65 });
    // An Ollama record and a record with no pool are untouched.
    await record(pools.ollama!, 'llama3.1:8b');
    const o = await last('llama3.1:8b');
    expect([o.cost_micros, o.currency, o.price_id, o.neurons, o.cached_tokens]).toEqual([null, null, null, null, null]);
  });

  it('prices a DigitalOcean model by hand, from its effective date only', async () => {
    const m = 'llama3.3-70b-instruct';
    await put(a, '/api/admin/cloud/model-prices', { provider: 'digitalocean', model: m, inputPerMillion: 0.65, outputPerMillion: 0.65, effectiveFrom: '2026-10-01' }).expect(403); // FinOps only
    const v1 = (await put(fin, '/api/admin/cloud/model-prices', { provider: 'digitalocean', model: m, inputPerMillion: 0.65, outputPerMillion: 0.65, effectiveFrom: '2026-10-01', source: 'https://www.digitalocean.com/pricing/gen-ai' }).expect(200)).body;
    expect(v1).toMatchObject({ source: 'manual', effectiveFrom: '2026-10-01', priceId: `manual:${v1.id}` });
    await record(pools.do!, m, { ts: at('2026-10-20'), prompt: 1_000_000, output: 1_000_000 });
    expect(Number((await last(m)).cost_micros)).toBe(1_300_000);
    // A new price from 2026-11-01: records before it keep the old one, records on and after it get the new one.
    const v2 = (await put(fin, '/api/admin/cloud/model-prices', { provider: 'digitalocean', model: m, inputPerMillion: 0.8, outputPerMillion: 1, effectiveFrom: '2026-11-01' }).expect(200)).body;
    await record(pools.do!, m, { ts: at('2026-10-31'), prompt: 1_000_000, output: 1_000_000 });
    const before = await last(m);
    expect([Number(before.cost_micros), before.price_id]).toEqual([1_300_000, `manual:${v1.id}`]);
    await record(pools.do!, m, { ts: at('2026-11-01'), prompt: 1_000_000, output: 1_000_000 });
    const after = await last(m);
    expect([Number(after.cost_micros), after.price_id]).toEqual([1_800_000, `manual:${v2.id}`]);
    // An older version added later does not reprice anything after it took over.
    await put(fin, '/api/admin/cloud/model-prices', { provider: 'digitalocean', model: m, inputPerMillion: 5, outputPerMillion: 5, effectiveFrom: '2026-09-01' }).expect(200);
    await record(pools.do!, m, { ts: at('2026-10-15'), prompt: 1_000_000, output: 0 });
    expect(Number((await last(m)).cost_micros)).toBe(650_000);
    // The price change is audited.
    const ev = await h.s.db('audit_events').where({ action: 'cloud.model-price.set' });
    expect(ev.length).toBe(3);
    await put(fin, '/api/admin/cloud/model-prices', { provider: 'digitalocean', model: m, effectiveFrom: '2026-12-01' }).expect(400); // no input price
  });

  it('a day\'s cloud cost on the usage report equals the sum of its records\' cost_micros', async () => {
    const today = DAY(Date.now());
    const day = Number(today.replace(/-/g, ''));
    const sum = Number(((await h.s.db('usage_records').where({ tenant_id: h.tenantId, day, currency: 'USD' }).sum({ s: 'cost_micros' })) as { s: unknown }[])[0]!.s);
    expect(sum).toBeGreaterThan(0);
    const report = (await fin.agent.get(`/api/admin/usage/daily?from=${day}&to=${day}`).expect(200)).body;
    expect(report).toEqual([expect.objectContaining({ day: today, cloudCostMicros: { USD: sum } })]);
    const by = (await fin.agent.get(`/api/admin/usage/summary?by=model&from=${day}&to=${day}`).expect(200)).body.rows;
    expect(by.reduce((n: number, r: { costMicros?: Record<string, number> }) => n + (r.costMicros?.USD ?? 0), 0)).toBe(sum);
    // The analytics rows carry the same metered cost, in currency units.
    const an = (await fin.agent.get(`/api/admin/analytics/summary?by=model&from=${day}&to=${day}`).expect(200)).body.rows;
    expect(Math.round(an.reduce((n: number, r: { cloudCost?: Record<string, number> }) => n + (r.cloudCost?.USD ?? 0), 0) * 1e6)).toBe(sum);
  });

  it('meters a Bedrock turn with its cached prompt tokens through the gateway', async () => {
    const BEDROCK_MODEL = 'anthropic.claude-3-5-haiku-20241022-v1:0';
    aws.bedrock.models.push({ modelId: BEDROCK_MODEL, providerName: 'Anthropic', modelName: 'Claude 3.5 Haiku' });
    aws.setBedrockPrice('Claude 3.5 Haiku', 'eu-central-1', { input: '0.0008', output: '0.004', cached: '0.00008', effectiveDate: '2026-10-01' });
    const pool = (await post(a, '/api/admin/pools', { name: 'bedrock-priced', accelerator: 'cpu', labelCeiling: 'internal' }).expect(201)).body;
    const inst = (await post(a, `/api/admin/pools/${pool.id}/instances`, { name: 'bedrock-priced-1', kind: 'bedrock', deploy: 'docker', cloud: { accountId: acc.aws!.id, region: 'eu-central-1' } }).expect(201)).body;
    const imp = (await post(a, `/api/admin/cloud/accounts/${acc.aws!.id}/model-import`, { region: 'eu-central-1', ids: [BEDROCK_MODEL], instanceId: inst.id }).expect(201)).body;
    const modelId = imp.results[0].modelId as string;
    await h.s.gateway.repo.updateModel(modelId, { state: 'approved' });
    await post(fin, `/api/admin/cloud/accounts/${acc.aws!.id}/model-prices/refresh`).expect(200);
    const t = Date.now();
    await h.s.gateway.repo.createProfile({ id: 'PRICED0000000000000000001', tenant_id: h.tenantId, name: 'haiku-priced', display_name: 'Haiku (priced)', description: null, alias_of: null, model_id: modelId, pool_id: pool.id, num_ctx: 4096, temperature: 0.2, think_default: 'off', think_ceiling: 'off', system_prompt: null, fallback: null, canary: null, tools: [], label: 'internal', status: 'published', version: 1, updated_by: null, created_at: t, updated_at: t } as never);
    h.s.cloud.modelPrices.resetPools();
    aws.bedrock.cacheTokens = { read: 300, write: 100 };
    try {
      await localUser(h, 'pcm', ['member'], 'internal');
      const m = await login(h, 'pcm');
      const sent = (await post(m, '/api/chat', { content: 'Hello there', profile: 'haiku-priced' }).expect(202)).body;
      let msg: { state: string } | undefined;
      for (let i = 0; i < 800; i++) {
        msg = await h.s.db('messages').where({ id: sent.messageId }).first();
        if (msg && ['complete', 'failed'].includes(msg.state)) break;
        await sleep(25);
      }
      expect(msg!.state).toBe('complete');
      const [u] = await h.s.db('usage_records').where({ message_id: sent.messageId });
      const call = aws.bedrock.converseCalls.at(-1)!;
      const input = 11 + (JSON.stringify(call.body.messages).length % 50);
      // Prompt tokens are the uncached input plus the cache reads and writes; the reads are priced at the cached rate.
      expect(Number(u.prompt_tokens)).toBe(input + 300 + 100);
      expect(Number(u.cached_tokens)).toBe(300);
      expect(Number(u.cost_micros)).toBe(Math.round((input + 100) * 0.8 + 300 * 0.08 + Number(u.output_tokens) * 4));
      expect(u.currency).toBe('USD');
    } finally {
      aws.bedrock.cacheTokens = null;
    }
  });

  it('shows the current price and its history on the model card, unverified sheet entries flagged', async () => {
    const card = await h.s.cloud.modelPrices.card('aws', HAIKU, 'eu-central-1');
    expect(card.current).toMatchObject({ source: 'aws-price-list', inputPerMillion: 0.25, effectiveFrom: '2026-10-01' });
    expect(card.metered).toBe(true);
    expect(card.versions.some((v) => v.source === 'price-sheet' && !v.unverified)).toBe(true);
    // A checked sheet entry prices a model the API has not priced.
    const sheetPriced = await h.s.cloud.modelPrices.card('aws', 'amazon.nova-pro-v1:0', 'eu-central-1');
    expect(sheetPriced).toMatchObject({ metered: true, current: { source: 'price-sheet', unverified: false, inputPerMillion: 0.8 } });
    // An unverified one is shown, flagged, and prices nothing.
    const sheetOnly = await h.s.cloud.modelPrices.card('digitalocean', 'mistral-nemo-instruct-2407', null);
    expect(sheetOnly).toMatchObject({ metered: false, current: { source: 'price-sheet', unverified: true, inputPerMillion: 0.3 } });
    expect(await h.s.cloud.modelPrices.priceAt('digitalocean', 'mistral-nemo-instruct-2407', null, Date.now(), { verified: true })).toBeNull();
    // Built with another sheet (verified entries), the sheet alone prices records.
    h.s.cloud.modelPrices.useSheet([{ ...sheetOnly.current!, id: null, provider: 'digitalocean', unverified: false, neuronsInput: null, neuronsOutput: null, neuronPrice: null, source: 'price-sheet', basis: 'tokens' } as ModelPrice]);
    expect(await h.s.cloud.modelPrices.priceAt('digitalocean', 'mistral-nemo-instruct-2407', null, Date.now(), { verified: true })).toMatchObject({ source: 'price-sheet', inputPerMillion: 0.3 });
  });
});
