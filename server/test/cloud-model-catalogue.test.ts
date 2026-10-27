import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CloudModelListing } from '../src/cloud/model-catalogue.js';
import type { CloudAccount, Provider } from '../src/cloud/types.js';
import { seedAccount } from './cloud-credentials-helpers.js';
import { FakeAws } from './fake-aws.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * 1.9.99-final, Sprint 60 (B-10504): the cloud catalogue import, against the fakes only. Bedrock is listed through its
 * real lister against the Bedrock fake (foundation models with model access, inference profiles); Azure deployments,
 * DigitalOcean models and Workers AI models through listers registered on `s.cloud.modelCatalogue` that answer as
 * the providers' listings do (their own listing calls are B-10502, B-10503 and B-10509's, tested there). Each listing
 * becomes a draft with `format: server`, provider, account, region, terms and a label ceiling capped at the region's
 * (open decision 5: `internal` unless the data terms are attested); access state is recorded; a re-import is
 * idempotent; nothing is approved or published. Migrations 146 and 159 are applied here when missing.
 */

vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 });

const HAIKU = 'anthropic.claude-3-haiku-20240307-v1:0';

describe('cloud catalogue import (B-10504)', () => {
  let h: Harness;
  const aws = new FakeAws();
  let a: Client;
  const acc: Record<string, CloudAccount> = {};
  const listings: Record<string, CloudModelListing[]> = {};
  const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);
  const imp = (id: string, body: object = {}) => post(a, `/api/admin/cloud/accounts/${id}/model-import`, body);

  const listing = (account: CloudAccount, o: Partial<CloudModelListing> & Pick<CloudModelListing, 'id' | 'flavour' | 'kind'>): CloudModelListing => ({ provider: account.provider, accountId: account.id, name: o.id, region: account.defaultRegion, endpoint: 'https://example.invalid', available: true, ...o });

  beforeAll(async () => {
    await aws.start();
    h = await harness({ SERVICE_ALLOWED_HOSTS: '127.0.0.1', OLLAMA_POLL_MS: '600000' });
    if (!(await h.s.db.schema.hasTable('cloud_accounts'))) await (await import('../src/db/migrations/146_cloud_accounts.js')).up(h.s.db);
    if (!(await h.s.db.schema.hasTable('cloud_model_entries'))) await (await import('../src/db/migrations/159_cloud_models.js')).up(h.s.db);
    h.s.cloud.accounts.resetSchemaCache();
    h.s.cloud.modelImport.resetSchemaCache();
    const key = aws.addUser({ userName: 'exprsn-read' });
    (h.s.cloud as { credentials: unknown }).credentials = { for: async () => ({ kind: 'aws', accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey, expiresAt: null }) };
    h.s.cloud.bedrock.setEndpoints({ bedrock: aws.url, bedrockRuntime: aws.url });
    h.s.cloud.bedrock.setTransport({ sleep: async () => {}, random: () => 0.5 });
    const seed = async (provider: Provider, name: string, providerIds: Record<string, string>) => (await seedAccount(h, { provider, mode: 'vaulted', name, providerIds }))!;
    acc.aws = await seed('aws', 'aws-cat', { awsAccountId: aws.account });
    acc.azure = await seed('azure', 'az-cat', { azureTenantId: '11111111-2222-3333-4444-555555555555', azureSubscriptionId: '99999999-8888-7777-6666-555555555555' });
    acc.do = await seed('digitalocean', 'do-cat', { doTeamId: 'team-1' });
    acc.cf = await seed('cloudflare', 'cf-cat', { cfAccountId: 'cf-1' });
    // The region allow-lists: AWS eu-central-1 raised to confidential (the import still caps at internal), Azure's at public.
    await h.s.db('cloud_account_regions').where({ account_id: acc.aws.id }).update({ ceiling: 'confidential' });
    await h.s.db('cloud_account_regions').where({ account_id: acc.azure.id }).update({ ceiling: 'public' });
    for (const k of Object.keys(acc)) acc[k] = (await h.s.cloud.accounts.get(acc[k]!.id))!;
    listings.azure = [
      listing(acc.azure, { id: 'gpt-4o-prod', name: 'gpt-4o', flavour: 'azure', kind: 'chat', model: { name: 'gpt-4o', version: '2024-08-06' }, details: { sku: 'Standard' } }),
      listing(acc.azure, { id: 'embed-small', flavour: 'azure', kind: 'embedding', model: { name: 'text-embedding-3-small' } }),
      listing(acc.azure, { id: 'gpt-4o-mini-new', flavour: 'azure', kind: 'chat', available: false, reason: 'The deployment is Creating' })
    ];
    listings.digitalocean = [listing(acc.do, { id: 'llama3.3-70b-instruct', flavour: 'digitalocean', kind: 'chat', region: null }), listing(acc.do, { id: 'support-agent', flavour: 'digitalocean', kind: 'agent', region: null })];
    listings.cloudflare = [listing(acc.cf, { id: '@cf/meta/llama-3.1-8b-instruct', flavour: 'workers-ai', kind: 'chat', region: 'global', details: { dataTermsAttested: true } }), listing(acc.cf, { id: '@cf/baai/bge-base-en-v1.5', flavour: 'workers-ai', kind: 'embedding', region: 'global' })];
    for (const p of ['azure', 'digitalocean', 'cloudflare'] as const) h.s.cloud.modelCatalogue.register(p, { listModels: async () => listings[p]! });
    await localUser(h, 'cma', ['model-admin', 'tenant-admin', 'cloud-operator'], 'confidential');
    a = await loginAdmin(h, 'cma');
  }, 180_000);

  afterAll(async () => {
    await h?.close();
    await aws.stop();
  });

  it('previews Bedrock\'s offer with model access, routing regions and the capped ceiling, writing nothing', async () => {
    const before = (await h.s.db('models').count({ n: '*' }))[0]!.n;
    const p = (await a.agent.get(`/api/admin/cloud/accounts/${acc.aws!.id}/model-import`).expect(200)).body;
    expect(p.account).toMatchObject({ name: 'aws-cat', provider: 'aws' });
    const by = Object.fromEntries(p.models.map((m: { id: string }) => [m.id, m]));
    expect(by[HAIKU]).toMatchObject({ kind: 'chat', flavour: 'bedrock', region: 'eu-central-1', routesTo: ['eu-central-1'], available: true, accessState: 'granted', ceiling: 'internal', catalogued: null });
    expect(by['meta.llama3-8b-instruct-v1:0']).toMatchObject({ available: false, accessState: 'not_granted' });
    expect(by['mistral.mistral-large-2402-v1:0']).toMatchObject({ available: false, accessState: 'pending' });
    expect(by['amazon.titan-embed-text-v2:0']).toMatchObject({ kind: 'embedding', accessState: 'granted' });
    expect(by['eu.anthropic.claude-3-haiku-20240307-v1:0']).toMatchObject({ routesTo: ['eu-central-1', 'eu-west-1'], ceiling: null, reason: expect.stringMatching(/eu-west-1, which is not on/) });
    expect(by['global.anthropic.claude-3-haiku-20240307-v1:0']).toMatchObject({ routesTo: ['*'], ceiling: null });
    expect((await h.s.db('models').count({ n: '*' }))[0]!.n).toBe(before);
    expect(aws.calls(/foundation-model-availability/).length).toBeGreaterThan(0);
    expect(aws.bedrock.signatures.bad).toBe(0);
  });

  it('registers Bedrock drafts with format server, provider, account, region, terms and an internal ceiling; never approved', async () => {
    const r = (await imp(acc.aws!.id, { region: 'eu-central-1' }).expect(201)).body;
    const by = Object.fromEntries(r.results.map((x: { id: string }) => [x.id, x]));
    expect(by[HAIKU]).toMatchObject({ outcome: 'registered', ceiling: 'internal', label: 'internal', accessState: 'granted', instance: null });
    expect(by['amazon.titan-embed-text-v2:0']).toMatchObject({ outcome: 'registered', kind: 'embedding' });
    expect(by['meta.llama3-8b-instruct-v1:0']).toMatchObject({ outcome: 'skipped', accessState: 'not_granted', reason: expect.stringMatching(/Model access is not granted/) });
    expect(by['mistral.mistral-large-2402-v1:0']).toMatchObject({ outcome: 'skipped', accessState: 'pending' });
    expect(by['amazon.titan-image-generator-v2:0']).toMatchObject({ outcome: 'skipped', reason: expect.stringMatching(/Neither a chat nor an embedding/) });
    expect(by['global.anthropic.claude-3-haiku-20240307-v1:0']).toMatchObject({ outcome: 'skipped', reason: expect.stringMatching(/global profile/) });
    const m = await h.s.gateway.repo.model(by[HAIKU].modelId);
    expect(m).toMatchObject({ name: HAIKU, format: 'server', state: 'draft', approved_by: null, approved_at: null, label: 'internal', import_state: 'pulled', capabilities: ['completion'], family: 'Anthropic', source: `cloud:bedrock/aws-cat/eu-central-1/${HAIKU}` });
    expect(m!.license).toMatchObject({ name: expect.stringMatching(/Anthropic model on Amazon Bedrock/), url: 'https://aws.amazon.com/service-terms/', recordedBy: 'cma' });
    const e = await h.s.cloud.modelImport.entry(m!.id);
    expect(e).toMatchObject({ provider: 'aws', accountId: acc.aws!.id, region: 'eu-central-1', externalId: HAIKU, flavour: 'bedrock', offer: 'foundation', routesTo: ['eu-central-1'], ceiling: 'internal', accessState: 'granted', terms: expect.objectContaining({ url: 'https://aws.amazon.com/service-terms/' }) });
    // Nothing is published or routed: no profile uses it, and it cannot be approved without evaluation.
    expect(await h.s.db('profiles').where({ model_id: m!.id })).toHaveLength(0);
    await post(a, `/api/admin/models/${m!.id}/lifecycle`, { to: 'approved' }).expect(409);
    // A label above the ceiling is refused, though the region's own ceiling is confidential (open decision 5).
    expect((await a.agent.patch(`/api/admin/models/${m!.id}`).set('x-csrf-token', a.csrf).send({ label: 'confidential' }).expect(403)).body).toMatchObject({ step: 'zone', ceiling: 'internal' });
    const audit = await h.s.db('audit_events').whereIn('action', ['model.import.requested', 'cloud.models.imported']);
    expect(audit.some((x: { action: string; detail: string }) => x.action === 'model.import.requested' && JSON.parse(x.detail).cloud.account === 'aws-cat')).toBe(true);
    expect(audit.some((x: { action: string }) => x.action === 'cloud.models.imported')).toBe(true);
  });

  it('is idempotent: a re-import updates the entries in place and registers nothing twice', async () => {
    const count = async () => Number((await h.s.db('models').count({ n: '*' }))[0]!.n);
    const n = await count();
    const entries = (await h.s.db('cloud_model_entries').count({ n: '*' }))[0]!.n;
    const r = (await imp(acc.aws!.id, { region: 'eu-central-1' }).expect(200)).body;
    expect(r.results.filter((x: { outcome: string }) => x.outcome === 'registered')).toEqual([]);
    expect(r.results.find((x: { id: string }) => x.id === HAIKU)).toMatchObject({ outcome: 'unchanged' });
    expect(await count()).toBe(n);
    expect((await h.s.db('cloud_model_entries').count({ n: '*' }))[0]!.n).toBe(entries);
    // The region's ceiling lowered to public: the entry and the draft's label follow it.
    await h.s.db('cloud_account_regions').where({ account_id: acc.aws!.id }).update({ ceiling: 'public' });
    const again = (await imp(acc.aws!.id, { ids: [HAIKU] }).expect(200)).body;
    expect(again.results[0]).toMatchObject({ outcome: 'updated', ceiling: 'public', label: 'public' });
    const m = await h.s.gateway.repo.modelByName(HAIKU);
    expect(m!.label).toBe('public');
    expect((await h.s.cloud.modelImport.entry(m!.id))!.ceiling).toBe('public');
    await h.s.db('cloud_account_regions').where({ account_id: acc.aws!.id }).update({ ceiling: 'confidential' });
  });

  it('registers Azure deployments, DigitalOcean models and Workers AI models with their terms, ceilings and instances', async () => {
    // An Azure instance for the account: the deployments are held by it and placed on its pool.
    const pool = await h.s.gateway.repo.createPool({ name: 'azure-pool', accelerator: 'cpu', zone: 'inference', labelCeiling: 'internal' });
    const inst = await h.s.gateway.repo.createInstance({ poolId: pool.id, name: 'azure-openai', url: 'http://127.0.0.1:9', deploy: 'docker', kind: 'openai', settings: { cloud: { provider: 'azure', accountId: acc.azure!.id, region: 'westeurope', flavour: 'azure' } } });
    const az = (await imp(acc.azure!.id).expect(201)).body.results;
    const azBy = Object.fromEntries(az.map((x: { id: string }) => [x.id, x]));
    expect(azBy['gpt-4o-prod']).toMatchObject({ outcome: 'registered', region: 'westeurope', ceiling: 'public', label: 'public', instance: 'azure-openai' });
    expect(azBy['embed-small']).toMatchObject({ outcome: 'registered', kind: 'embedding' });
    expect(azBy['gpt-4o-mini-new']).toMatchObject({ outcome: 'skipped', reason: 'The deployment is Creating' });
    const gpt = await h.s.gateway.repo.model(azBy['gpt-4o-prod'].modelId);
    expect(gpt).toMatchObject({ format: 'server', server_instance_id: inst.id, server_model: 'gpt-4o-prod', state: 'draft', license: expect.objectContaining({ url: 'https://www.microsoft.com/licensing/terms' }) });
    expect((await h.s.gateway.repo.placements()).some((p) => p.model_id === gpt!.id && p.pool_id === pool.id && p.residency === 'warm')).toBe(true);
    expect(await h.s.cloud.modelImport.entry(gpt!.id)).toMatchObject({ provider: 'azure', flavour: 'azure', offer: 'deployment', region: 'westeurope', details: expect.objectContaining({ model: { name: 'gpt-4o', version: '2024-08-06' } }) });

    const dr = (await imp(acc.do!.id).expect(201)).body.results;
    expect(dr.find((x: { id: string }) => x.id === 'llama3.3-70b-instruct')).toMatchObject({ outcome: 'registered', region: 'fra1', ceiling: 'internal' });
    expect(dr.find((x: { id: string }) => x.id === 'support-agent')).toMatchObject({ outcome: 'skipped', reason: expect.stringMatching(/registry tool/) });

    // Workers AI on the global edge. Since Sprint 61 (B-10507) a listing's own claim of attested terms raises nothing:
    // attestation is a dual-controlled record per entry, and a global model stays at internal whatever the terms.
    const cf = (await imp(acc.cf!.id, { label: 'internal' }).expect(201)).body.results;
    expect(cf.find((x: { id: string }) => x.id === '@cf/meta/llama-3.1-8b-instruct')).toMatchObject({ outcome: 'registered', region: 'global', ceiling: 'internal' });
    await h.s.db('cloud_account_regions').where({ account_id: acc.cf!.id }).update({ ceiling: 'confidential' });
    const raised = (await imp(acc.cf!.id).expect(200)).body.results;
    expect(raised.find((x: { id: string }) => x.id === '@cf/meta/llama-3.1-8b-instruct')).toMatchObject({ outcome: 'unchanged', ceiling: 'internal' });
    expect(raised.find((x: { id: string }) => x.id === '@cf/baai/bge-base-en-v1.5')).toMatchObject({ outcome: 'unchanged', ceiling: 'internal' }); // not attested
    const entries = (await a.agent.get('/api/admin/cloud/model-entries').expect(200)).body.entries;
    expect(new Set(entries.map((e: { provider: string }) => e.provider))).toEqual(new Set(['aws', 'azure', 'digitalocean', 'cloudflare']));
    // Never published: every imported model is a draft.
    const states = await h.s.db('models').whereIn('id', entries.map((e: { modelId: string }) => e.modelId)).select('state');
    expect(new Set(states.map((s: { state: string }) => s.state))).toEqual(new Set(['draft']));
  });

  it('refuses an unknown model id, a region off the allow-list and an account the caller may not read', async () => {
    expect((await imp(acc.aws!.id, { ids: ['nope.model-v1'] }).expect(409)).body.detail).toMatch(/does not offer nope\.model-v1/);
    await imp(acc.aws!.id, { region: 'us-east-1' }).expect(400);
    await localUser(h, 'cmx', ['model-admin'], 'internal');
    const x = await loginAdmin(h, 'cmx');
    await x.agent.post(`/api/admin/cloud/accounts/${acc.aws!.id}/model-import`).set('x-csrf-token', x.csrf).send({}).expect(403); // no cloud:read
  });
});
