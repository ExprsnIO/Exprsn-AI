import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADAPTERS, type AdapterContext } from '../src/imports/adapters/index.js';
import { ImportFetcher, retryAfterMs } from '../src/imports/fetcher.js';
import { contentProblem, formatOf, normaliseLicence, parameterBucket, quantizationOf, sniff } from '../src/imports/formats.js';
import { NeedsCredential, type CatalogItem } from '../src/imports/types.js';
import { harness, localUser, loginAdmin, login, type Client, type Harness } from './helpers.js';
import { FakeConverter, gguf, pickle, safetensors, startFakeCkan, startFakeHub, startFakeRegistry, startFakeSource, type FakeCkan, type FakeHub, type FakeRegistry, type FakeSource } from './sprint30-imports-fakes.js';

/**
 * Sprint 30 (1.5.0), B-3801 to B-3803: the repository registry with dual control, credentials in the vault and the
 * staging-proxy allow-list; catalogue browse with facets, live search and the snapshot fallback; model import from a
 * Hugging Face compatible hub, an Ollama compatible registry and the signed bundle share. All sources are local fakes.
 */

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const send = (c: Client, method: 'post' | 'patch' | 'put' | 'delete', url: string, body: unknown = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body as object);

describe('formats, licences and the fetcher (B-3803)', () => {
  it('tells weights, metadata and pickle apart by name and by content', () => {
    expect(formatOf('model-00001-of-00004.safetensors')).toBe('safetensors');
    expect(formatOf('pytorch_model.bin')).toBe('pickle');
    expect(formatOf('x.ckpt')).toBe('pickle');
    expect(formatOf('tiny-Q4_K_M.gguf')).toBe('gguf');
    expect(formatOf('tokenizer.json')).toBe('metadata');
    expect(formatOf('', 'application/vnd.ollama.image.model')).toBe('gguf');
    expect(sniff(gguf('a'))).toBe('gguf');
    expect(sniff(safetensors('a'))).toBe('safetensors');
    expect(sniff(pickle())).toBe('pickle');
    expect(sniff(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2]))).toBe('zip');
    expect(contentProblem('model.safetensors', 'safetensors', pickle())).toMatch(/pickle/);
    expect(contentProblem('model.safetensors', 'safetensors', safetensors('a').subarray(0, 64))).toBeNull();
    expect(contentProblem('x.gguf', 'gguf', Buffer.from('not gguf at all'))).toMatch(/GGUF/);
    expect(quantizationOf('qwen2.5-7b-instruct-Q4_K_M.gguf')).toBe('Q4_K_M');
    expect(quantizationOf('model-f16.gguf')).toBe('f16');
    expect(parameterBucket('7.6B')).toBe('1 to 10B');
    expect(parameterBucket(137_000_000)).toBe('under 1B');
  });

  it('normalises licences from ids, URLs and licence texts', () => {
    expect(normaliseLicence('Apache-2.0')).toBe('apache-2.0');
    expect(normaliseLicence('https://creativecommons.org/licenses/by/4.0/')).toBe('cc-by-4.0');
    expect(normaliseLicence('http://www.opendefinition.org/licenses/odc-odbl')).toBe('odbl-1.0');
    expect(normaliseLicence('cc-by')).toBe('cc-by-4.0');
    expect(normaliseLicence('MIT License\n\nPermission is hereby granted, free of charge, to any person')).toBe('mit');
    expect(normaliseLicence('LLAMA 3.1 COMMUNITY LICENSE AGREEMENT\nLlama 3.1 Version Release Date: July 23, 2024')).toBe('llama3.1');
    expect(normaliseLicence(null)).toBe('unknown');
    expect(normaliseLicence('notspecified')).toBe('unknown');
  });

  it('keeps every request on the allow-list and plain http to operator hosts', async () => {
    const f = new ImportFetcher({ allowedHosts: '127.0.0.1', timeoutMs: 5000 });
    expect(f.baseUrlProblem('http://example.org')).toMatch(/https/);
    expect(f.baseUrlProblem('https://user:pw@example.org')).toMatch(/Credentials/);
    expect(f.baseUrlProblem('https://169.254.169.254/latest')).toMatch(/metadata/);
    expect(f.baseUrlProblem('http://127.0.0.1:9')).toBeNull();
    const access = { host: 'hub.example', hosts: ['hub.example'], auth: async () => ({}) };
    await expect(f.request('https://other.example/x', access)).rejects.toThrow(/not on the staging-proxy allow-list/);
    await expect(f.request('http://hub.example/x', access)).rejects.toThrow(/plain http/);
    expect(retryAfterMs('30')).toBe(30_000);
    expect(retryAfterMs(null)).toBeNull();
  });
});

describe('dataset repository types harvest their own taxonomy (B-3801, B-3802)', () => {
  let src: FakeSource;
  const fetcher = new ImportFetcher({ allowedHosts: '127.0.0.1', timeoutMs: 5000 });
  const ctx = (type: AdapterContext['repo']['type'], baseUrl: string, options: Record<string, unknown> = {}, credential: string | null = null): AdapterContext => ({
    repo: { id: 'r', tenantId: 't', type, baseUrl, kinds: type === 'invenio' ? ['dataset', 'model'] : ['dataset'], options, hasCredential: !!credential },
    fetcher,
    access: { host: '127.0.0.1', hosts: ['127.0.0.1'], auth: async (): Promise<Record<string, string>> => (credential ? { authorization: `Basic ${Buffer.from(credential).toString('base64')}` } : {}) },
    maxItems: 100,
    s: null as never
  });
  const all = async (it: AsyncIterable<CatalogItem>) => {
    const out: CatalogItem[] = [];
    for await (const x of it) out.push(x);
    return out;
  };

  beforeAll(async () => {
    src = await startFakeSource();
  });
  afterAll(async () => {
    await src.close();
  });

  it('DCAT-AP: themes, licences and file types from JSON-LD, following hydra:next', async () => {
    src.routes.set('/catalog.jsonld', {
      body: {
        '@graph': [
          { '@id': 'https://data.example/ds/1', '@type': 'dcat:Dataset', 'dct:title': [{ '@value': 'Inflation', '@language': 'en' }], 'dct:publisher': { '@id': 'https://data.example/org/ecb' }, 'dcat:theme': { '@id': 'http://publications.europa.eu/resource/authority/data-theme/ECON' }, 'dct:license': { '@id': 'https://creativecommons.org/licenses/by/4.0/' }, 'dct:accrualPeriodicity': { '@id': 'http://publications.europa.eu/resource/authority/frequency/MONTHLY' }, 'dcat:distribution': [{ '@id': '_:d1' }] },
          { '@id': '_:d1', 'dct:format': { '@id': 'http://publications.europa.eu/resource/authority/file-type/CSV' } },
          { '@id': 'https://data.example/org/ecb', 'foaf:name': 'European Central Bank' },
          { '@id': 'https://data.example/catalog?page=1', '@type': 'hydra:PagedCollection', 'hydra:next': '/catalog2.jsonld' }
        ]
      }
    });
    src.routes.set('/catalog2.jsonld', { body: { '@graph': [{ '@id': 'https://data.example/ds/2', '@type': 'http://www.w3.org/ns/dcat#Dataset', 'http://purl.org/dc/terms/title': 'Trade', 'dcat:theme': 'http://publications.europa.eu/resource/authority/data-theme/ECON' }] } });
    const items = await all(ADAPTERS.dcat.harvest(ctx('dcat', `${src.url}/catalog.jsonld`)));
    expect(items.map((i) => i.name)).toEqual(['Inflation', 'Trade']);
    expect(items[0]).toMatchObject({ publisher: 'European Central Bank', licence: 'cc-by-4.0', classification: 'ECON', formats: ['csv'] });
    expect(items[0]!.facets.updates).toEqual(['monthly']);
  });

  it('SDMX: dataflows and their categorisations from structure XML', async () => {
    src.routes.set('/sdmx/dataflow/all/all/latest', { type: 'application/xml', body: '<m:Structure><m:Structures><s:Dataflows><s:Dataflow id="PRC_HICP_MIDX" agencyID="ESTAT" version="1.0"><c:Name xml:lang="de">HVPI</c:Name><c:Name xml:lang="en">HICP monthly index</c:Name></s:Dataflow></s:Dataflows></m:Structures></m:Structure>' });
    src.routes.set('/sdmx/categorisation/all/all/latest', { type: 'application/xml', body: '<s:Categorisation id="C1"><s:Source><Ref id="PRC_HICP_MIDX" class="Dataflow"/></s:Source><s:Target><Ref id="economy.prices" class="Category"/></s:Target></s:Categorisation>' });
    const items = await all(ADAPTERS.sdmx.harvest(ctx('sdmx', `${src.url}/sdmx`, { licence: 'cc-by-4.0' })));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ itemId: 'ESTAT,PRC_HICP_MIDX,1.0', name: 'HICP monthly index', classification: 'prices', licence: 'cc-by-4.0', formats: ['sdmx'] });
  });

  it('OpenML: task types and row buckets, licences from the descriptions', async () => {
    src.routes.set('/api/v1/json/data/list/limit/100/offset/0/status/active', { body: { data: { dataset: [{ did: 31, name: 'credit-g', version: 1, format: 'ARFF', quality: [{ name: 'NumberOfClasses', value: '2.0' }, { name: 'NumberOfInstances', value: '1000.0' }] }] } } });
    src.routes.set('/api/v1/json/data/list/limit/99/offset/1/status/active', { status: 412, body: { error: { code: '372', message: 'No results' } } });
    src.routes.set('/api/v1/json/data/31', { body: { data_set_description: { licence: 'Public', tag: ['credit'] } } });
    const items = await all(ADAPTERS.openml.harvest(ctx('openml', src.url)));
    expect(items).toHaveLength(1);
    expect(items[0]!.facets).toMatchObject({ classification: ['Supervised Classification'], rows: ['under 10k rows'] });
  });

  it('InvenioRDM: resource types, rights and subjects; live search', async () => {
    const hit = { id: 'abc12', metadata: { title: 'EDGAR corpus', description: '<p>10-K filings</p>', creators: [{ person_or_org: { name: 'Loukas' } }], rights: [{ id: 'cc-by-4.0' }], resource_type: { id: 'dataset' }, subjects: [{ subject: 'finance' }] }, files: { entries: { 'a.jsonl': { key: 'a.jsonl', size: 10 } } } };
    src.routes.set('/api/records?size=10&page=1&q=(edgar)', { body: { hits: { total: 1, hits: [hit] } } });
    const items = await ADAPTERS.invenio.search!(ctx('invenio', src.url), 'edgar', 'dataset', 10);
    expect(items[0]).toMatchObject({ name: 'EDGAR corpus', description: '10-K filings', licence: 'cc-by-4.0', classification: 'dataset', formats: ['jsonl'] });
  });

  it('Kaggle: needs a recorded token, then lists with its tags as the classification', async () => {
    await expect(ADAPTERS.kaggle.probe(ctx('kaggle', src.url))).rejects.toBeInstanceOf(NeedsCredential);
    src.routes.set('/api/v1/datasets/list?page=1&sortBy=hottest&search=fraud', { body: [{ ref: 'mlg-ulb/creditcardfraud', title: 'Credit Card Fraud Detection', licenseName: 'Database: Open Database, Contents: Database Contents', totalBytes: 150_000_000, tags: [{ name: 'finance' }, { name: 'crime' }] }] });
    const items = await ADAPTERS.kaggle.search!(ctx('kaggle', src.url, {}, 'user:key'), 'fraud', 'dataset', 10);
    expect(items[0]).toMatchObject({ itemId: 'mlg-ulb/creditcardfraud', licence: 'odbl-1.0', classification: 'finance' });
    expect(src.seen.at(-1)!.auth).toBe(`Basic ${Buffer.from('user:key').toString('base64')}`);
  });
});

describe('Sprint 30: import repositories, catalogue browse and model import', () => {
  let h: Harness;
  let hub: FakeHub;
  let ckan: FakeCkan;
  let registry: FakeRegistry;
  const conv = new FakeConverter();
  let a: Client; // model admin who proposes (with vault access for the credential)
  let b: Client; // the second model admin
  let legal: Client;
  let ta: Client;
  let selfLegal: Client;
  let sys: Client;
  let aId: string;
  let hubId: string;
  let regId: string;

  const run = () => h.s.jobs.runDue(50);
  const confirmed = async (body: object) => {
    const p = await send(a, 'post', '/api/imports/repositories', body);
    if (p.status !== 201) throw new Error(JSON.stringify(p.body));
    expect(p.body.state).toBe('pending');
    const c = await send(b, 'post', `/api/imports/repositories/${p.body.id}/confirm`, {}).expect(200);
    await run();
    return c.body.id as string;
  };
  const blobKeys = async (prefix: string) => {
    const out: string[] = [];
    for await (const o of h.s.blobs.list(prefix)) out.push(o.key);
    return out;
  };

  beforeAll(async () => {
    [hub, ckan, registry] = await Promise.all([startFakeHub(), startFakeCkan(), startFakeRegistry()]);
    h = await harness({ IMPORT_ALLOWED_HOSTS: '127.0.0.1', IMPORT_PART_BYTES: '1024', IMPORT_HARVEST_TICK_MINUTES: '0', IMPORT_BUNDLE_POLL_MINUTES: '0' }, { trainer: conv });
    conv.useApp(h.app);
    aId = (await localUser(h, 'ima', ['model-admin', 'tenant-admin'], 'restricted')).id;
    await localUser(h, 'imb', ['model-admin'], 'restricted');
    await localUser(h, 'legal1', ['legal-review'], 'restricted');
    await localUser(h, 'ta1', ['tenant-admin'], 'restricted');
    await localUser(h, 'selflegal', ['model-admin', 'legal-review'], 'restricted');
    await localUser(h, 'imsys', ['system-admin'], 'restricted');
    await localUser(h, 'member1', ['member']);
    [a, b, legal, ta, selfLegal, sys] = [await loginAdmin(h, 'ima'), await loginAdmin(h, 'imb'), await loginAdmin(h, 'legal1'), await loginAdmin(h, 'ta1'), await loginAdmin(h, 'selflegal'), await loginAdmin(h, 'imsys')];
    // The proposer may write the repository credential into the vault.
    await send(a, 'post', '/api/vault/policies', { subjectKind: 'user', subject: aId, path: '*', capabilities: ['*'] }).expect(201);
  }, 120_000);

  afterAll(async () => {
    await h.close();
    await Promise.all([hub.close(), ckan.close(), registry.close()]);
  });

  it('has the legal-review role and the import permissions, and refuses members', async () => {
    const m = await login(h, 'member1');
    await m.agent.get('/api/imports/repositories').expect(403);
    const types = (await a.agent.get('/api/imports/types').expect(200)).body as { type: string; modelImport: boolean }[];
    expect(types.map((t) => t.type)).toEqual(['hf', 'ollama', 'ckan', 'dcat', 'sdmx', 'openml', 'invenio', 'kaggle', 'bundle']);
    expect(types.filter((t) => t.modelImport).map((t) => t.type)).toEqual(['hf', 'ollama', 'bundle']);
  });

  it('B-3801: a CKAN portal added from the screen is harvested and browsable after confirmation', async () => {
    const p = await send(a, 'post', '/api/imports/repositories', { name: 'data.gov (fake)', type: 'ckan', baseUrl: `${ckan.url}/api/3`, region: 'US', harvestMinutes: 1440, options: { region: 'US' } }).expect(201);
    expect(p.body).toMatchObject({ state: 'pending', status: 'unknown', host: '127.0.0.1', kinds: ['dataset'], snapshotItems: 0 });
    // Not browsable, not on the allow-list, not harvested before the second admin confirms.
    await a.agent.get(`/api/imports/repositories/${p.body.id}/catalog`).expect(409);
    expect((await sys.agent.get('/api/imports/proxy-allowlist').expect(200)).body.hosts.find((x: { repositories: string[] }) => x.repositories.includes('data.gov (fake)'))).toBeUndefined();
    expect(ckan.calls).toHaveLength(0);
    const self = await send(a, 'post', `/api/imports/repositories/${p.body.id}/confirm`, {}).expect(403);
    expect(self.body.step).toBe('dual-control');
    const c = await send(b, 'post', `/api/imports/repositories/${p.body.id}/confirm`, { note: 'checked the portal' }).expect(200);
    expect(c.body).toMatchObject({ state: 'active' });
    expect(c.body.harvestJobId).toHaveLength(26);
    await run();
    const r = (await a.agent.get(`/api/imports/repositories/${p.body.id}`).expect(200)).body;
    expect(r).toMatchObject({ status: 'reachable', snapshotItems: 5 });
    expect(r.nextHarvestAt).toBeGreaterThan(Date.now());
    const cat = (await a.agent.get(`/api/imports/repositories/${p.body.id}/catalog`).expect(200)).body;
    expect(cat).toMatchObject({ source: 'snapshot', total: 5, kind: 'dataset' });
    expect(cat.items[0]).toMatchObject({ itemId: 'consumer-complaints', publisher: 'CFPB', classification: 'Finance', licence: 'us-pd', licenceAllowed: true, formats: ['csv', 'json'] });
    expect(cat.items[0].description).toBe('Consumer Complaint Database from CFPB');
    const squid = (await sys.agent.get('/api/imports/proxy-allowlist?format=squid').expect(200)).text;
    expect(squid).toContain('127.0.0.1');
    const actions = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).where('action', 'like', 'import.repository.%').select('action')).map((x: { action: string }) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['import.repository.proposed', 'import.repository.confirmed', 'import.repository.harvested']));
  });

  it('B-3802: a facet count equals the rows the filter returns', async () => {
    const repo = (await a.agent.get('/api/imports/repositories').expect(200)).body.find((x: { type: string }) => x.type === 'ckan');
    const base = `/api/imports/repositories/${repo.id}/catalog?live=off`;
    const first = (await a.agent.get(base).expect(200)).body as { facets: { key: string; values: { value: string; count: number }[] }[] };
    expect(first.facets.map((f) => f.key)).toEqual(expect.arrayContaining(['classification', 'licence', 'format', 'publisher', 'updates', 'region']));
    let checked = 0;
    for (const f of first.facets) {
      for (const v of f.values) {
        const got = (await a.agent.get(`${base}&facet.${f.key}=${encodeURIComponent(v.value)}`).expect(200)).body;
        expect(got.total, `${f.key}=${v.value}`).toBe(v.count);
        expect(got.items).toHaveLength(v.count);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
    // With one facet selected, the other facets count within it (and still equal what their filter returns).
    const finance = (await a.agent.get(`${base}&facet.classification=Finance`).expect(200)).body;
    const csv = finance.facets.find((f: { key: string }) => f.key === 'format').values.find((v: { value: string }) => v.value === 'json');
    const both = (await a.agent.get(`${base}&facet.classification=Finance&facet.format=json`).expect(200)).body;
    expect(both.total).toBe(csv.count);
    expect(both.items.map((i: { itemId: string }) => i.itemId)).toEqual(['consumer-complaints']);
    // Search within the snapshot.
    expect((await a.agent.get(`${base}&q=bank`).expect(200)).body.items.map((i: { itemId: string }) => i.itemId)).toEqual(['failed-banks']);
  });

  it('B-3802: live search through the proxy, and the snapshot with backoff when rate limited', async () => {
    const repo = (await a.agent.get('/api/imports/repositories').expect(200)).body.find((x: { type: string }) => x.type === 'ckan');
    const live = (await a.agent.get(`/api/imports/repositories/${repo.id}/catalog?q=college`).expect(200)).body;
    expect(live).toMatchObject({ source: 'live', liveReason: null, total: 1 });
    ckan.rateLimit = 1;
    const limited = (await a.agent.get(`/api/imports/repositories/${repo.id}/catalog?q=college`).expect(200)).body;
    expect(limited.source).toBe('snapshot');
    expect(limited.liveReason).toMatch(/rate limiting/);
    expect(limited.items.map((i: { itemId: string }) => i.itemId)).toEqual(['college-scorecard']);
    expect(limited.repository.status).toBe('rate limited');
    expect(limited.repository.backoffUntil).toBeGreaterThan(Date.now() + 100_000); // the source's Retry-After (120 s)
    const calls = ckan.calls.length;
    const again = (await a.agent.get(`/api/imports/repositories/${repo.id}/catalog?q=college`).expect(200)).body;
    expect(again.source).toBe('snapshot');
    expect(ckan.calls).toHaveLength(calls); // backing off: the source is not called
    // A harvest that comes due while backing off waits for the backoff.
    await h.s.db('import_repositories').where({ id: repo.id }).update({ next_harvest_at: Date.now() - 1 });
    expect(await h.s.imports.repositories.harvestDue(h.tenantId)).toEqual({ queued: 0 });
    await h.s.db('import_repositories').where({ id: repo.id }).update({ backoff_until: null, backoff_count: 0, status: 'reachable', next_harvest_at: Date.now() - 1 });
    expect(await h.s.imports.repositories.harvestDue(h.tenantId)).toEqual({ queued: 1 });
    await run();
  });

  it('records the credential in the vault, never shows it, and sends it only to the hub', async () => {
    hubId = await confirmed({ name: 'Hugging Face (fake)', type: 'hf', baseUrl: hub.url, region: 'Global', kinds: ['model', 'dataset'], extraHosts: [], credential: hub.token });
    const r = (await a.agent.get(`/api/imports/repositories/${hubId}`).expect(200)).body;
    expect(r.credential).toMatchObject({ recorded: true, ref: `vault:imports/repositories/${hubId.toLowerCase()}#credential` });
    expect(JSON.stringify(r)).not.toContain(hub.token);
    expect(r).toMatchObject({ status: 'reachable', snapshotItems: 9 });
    const check = (await send(b, 'post', `/api/imports/repositories/${hubId}/check`).expect(200)).body;
    expect(check.statusDetail).toContain('northwind-ml');
    const models = (await a.agent.get(`/api/imports/repositories/${hubId}/catalog?kind=model&live=off`).expect(200)).body;
    expect(models.total).toBe(7);
    const fmt = models.facets.find((f: { key: string }) => f.key === 'format').values;
    expect(fmt).toEqual(expect.arrayContaining([{ value: 'pickle', count: 1, selected: false }, { value: 'gguf', count: 1, selected: false }]));
    expect(models.facets.find((f: { key: string }) => f.key === 'access').values).toEqual(expect.arrayContaining([{ value: 'gated', count: 1, selected: false }]));
    const ds = (await a.agent.get(`/api/imports/repositories/${hubId}/catalog?kind=dataset&live=off`).expect(200)).body;
    expect(ds.items.map((i: { itemId: string }) => i.itemId)).toEqual(['acme/phrasebank', 'acme/dolly']);
    expect(ds.facets.find((f: { key: string }) => f.key === 'rows').values.map((v: { value: string }) => v.value).sort()).toEqual(['10k to 1M rows', 'under 10k rows']);
  });

  it('B-3803: a pickle-only repository is refused with nothing written', async () => {
    const models = (await h.s.db('models').count({ n: '*' }))[0]!.n;
    const plan = (await send(a, 'post', '/api/imports/plan', { repositoryId: hubId, item: 'acme/pickle-only' }).expect(200)).body;
    expect(plan.blocked).toBe(true);
    expect(plan.checks.find((c: { name: string }) => c.name === 'Format')).toMatchObject({ result: 'refused' });
    const res = await send(a, 'post', '/api/imports', { repositoryId: hubId, item: 'acme/pickle-only' }).expect(422);
    expect(res.body.title).toBe('Import refused');
    expect(res.body.detail).toMatch(/pickle/);
    expect(res.body.import).toMatchObject({ state: 'refused', files: [] });
    expect((await h.s.db('models').count({ n: '*' }))[0]!.n).toBe(models);
    expect(hub.downloads).toHaveLength(0);
    expect(await blobKeys('imports/')).toEqual([]);
    expect(await h.s.db('jobs').where({ type: 'imports.model' }).first()).toBeUndefined();
    expect(await h.s.db('audit_events').where({ action: 'import.refused' }).first()).toBeDefined();
  });

  it('B-3803: a safetensors import registers a draft whose digest matches, resuming an interrupted download', async () => {
    const plan = (await send(a, 'post', '/api/imports/plan', { repositoryId: hubId, item: 'acme/tiny-safetensors', label: 'internal' }).expect(200)).body;
    expect(plan).toMatchObject({ blocked: false, waiting: false, tag: 'tiny-safetensors:q4_k_m', conversion: { needed: true, quantization: 'Q4_K_M' } });
    expect(plan.licence).toMatchObject({ id: 'apache-2.0', allowed: true });
    expect(plan.selected).toEqual(['model.safetensors', 'config.json', 'tokenizer.json']);
    const files = hub.repos.get('acme/tiny-safetensors')!.files;
    const weights = files.find((f) => f.name === 'model.safetensors')!.bytes;
    expect(plan.files.find((f: { name: string }) => f.name === 'model.safetensors').pin).toBe(`sha256:${sha256(weights)}`);
    // The import needs models:manage too: a tenant admin holds imports:run but not that.
    await send(ta, 'post', '/api/imports', { repositoryId: hubId, item: 'acme/tiny-safetensors' }).expect(403);
    const created = (await send(a, 'post', '/api/imports', { repositoryId: hubId, item: 'acme/tiny-safetensors', label: 'internal', attribution: 'Acme, Hugging Face' }).expect(201)).body;
    expect(created).toMatchObject({ state: 'queued', licenceStatus: 'allowed', mode: 'direct' });
    expect(created.ref).toMatch(/^IMP-\d{4}-\d+$/);
    hub.cut.after = 1500; // the first download stops after 1 500 bytes (stored as a part)
    await run();
    let imp = (await a.agent.get(`/api/imports/${created.id}`).expect(200)).body;
    expect(imp.state).toBe('failed');
    expect(imp.files.find((f: { name: string }) => f.name === 'model.safetensors').done).toBe(1500);
    await send(a, 'post', `/api/imports/${created.id}/retry`).expect(200);
    await run();
    imp = (await a.agent.get(`/api/imports/${created.id}`).expect(200)).body;
    expect(imp.state, JSON.stringify(imp.log)).toBe('complete');
    expect(hub.downloads.filter((d) => d.file === 'model.safetensors').map((d) => d.range)).toEqual([null, 'bytes=1500-']);
    // The draft's digest is the one the worker pinned for the converted model; the staged bytes matched their pins.
    expect(conv.digests).toHaveLength(1);
    expect(imp.model).toMatchObject({ name: 'tiny-safetensors:q4_k_m', state: 'draft', expectedDigest: conv.digests[0] });
    const model = await h.s.gateway.repo.model(imp.model.id);
    expect(model).toMatchObject({ expected_digest: conv.digests[0], state: 'draft', format: 'gguf', label: 'internal', requested_by: aId });
    expect(model!.license).toMatchObject({ name: 'apache-2.0' });
    expect(model!.source).toContain(created.ref);
    expect(conv.read.find((x) => x.name === 'model.safetensors')!.sha256).toBe(sha256(weights));
    expect(imp.manifest).toMatchObject({ format: 'exprsn-import-manifest/1', licence: { id: 'apache-2.0' }, label: 'internal', attribution: 'Acme, Hugging Face', model: { expectedDigest: conv.digests[0] }, source: { item: 'acme/tiny-safetensors', revision: hub.repos.get('acme/tiny-safetensors')!.sha } });
    expect(imp.manifest.files.find((f: { name: string }) => f.name === 'model.safetensors')).toMatchObject({ pin: `sha256:${sha256(weights)}`, sha256: sha256(weights) });
    expect(imp.manifest.files.find((f: { name: string }) => f.name === 'config.json').pin).toMatch(/^gitsha1:/);
    expect(imp.manifest.signature.value).toMatch(/^local:v1:/);
    expect(imp.storedBytes).toBeGreaterThan(weights.length);
    expect(await blobKeys(`imports/parts/`)).toEqual([]);
    expect((await h.s.blobs.get(`imports/blobs/sha256/${sha256(weights)}`))?.equals(weights)).toBe(true);
    // The credential never reached the CDN (the fake answers 400 if it does), and a quota view meters it.
    const quota = (await a.agent.get('/api/imports/quota').expect(200)).body;
    expect(quota).toMatchObject({ maxBytes: 500_000_000_000, appliesTo: 'datasets' });
    expect(quota.usedBytes.models).toBe(imp.storedBytes);
  });

  it('B-3803: a published GGUF changed under the same revision is refused', async () => {
    const created = (await send(a, 'post', '/api/imports', { repositoryId: hubId, item: 'acme/tiny-gguf', variants: ['tiny-Q8_0.gguf'] }).expect(201)).body;
    expect(created.options).toMatchObject({ tag: 'tiny-gguf:q8_0', quantization: 'as-is' });
    hub.tamper('acme/tiny-gguf', 'tiny-Q8_0.gguf', gguf('other'));
    await run();
    const imp = (await a.agent.get(`/api/imports/${created.id}`).expect(200)).body;
    expect(imp.state).toBe('refused');
    expect(imp.error).toMatch(/changed under the same revision/);
    expect(await h.s.gateway.repo.modelByName('tiny-gguf:q8_0')).toBeUndefined();
  });

  it('B-3803: pickle bytes behind a safetensors name are refused at staging', async () => {
    const created = (await send(a, 'post', '/api/imports', { repositoryId: hubId, item: 'acme/sneaky' }).expect(201)).body;
    await run();
    const imp = (await a.agent.get(`/api/imports/${created.id}`).expect(200)).body;
    expect(imp.state).toBe('refused');
    expect(imp.error).toMatch(/pickle/);
    expect(await blobKeys(`imports/parts/`)).toEqual([]);
    expect(await h.s.gateway.repo.modelByName('sneaky:q4_k_m')).toBeUndefined();
  });

  it('B-3803: models the gateway does not serve are refused (classifier engines come with B-3806)', async () => {
    const res = await send(a, 'post', '/api/imports', { repositoryId: hubId, item: 'acme/sentiment' }).expect(422);
    expect(res.body.reason).toContain('serving path');
  });

  it('B-3803: a gated repository waits until the gate is accepted with the recorded token', async () => {
    const plan = (await send(a, 'post', '/api/imports/plan', { repositoryId: hubId, item: 'acme/gated-llama' }).expect(200)).body;
    expect(plan).toMatchObject({ gated: true, access: 'gated', waiting: true });
    expect((await send(a, 'post', '/api/imports', { repositoryId: hubId, item: 'acme/gated-llama' }).expect(409)).body.reason).toBe('gate');
    const g = (await send(b, 'post', `/api/imports/repositories/${hubId}/gate`, { item: 'acme/gated-llama' }).expect(200)).body;
    expect(g).toMatchObject({ access: 'granted', account: 'northwind-ml' });
    const after = (await a.agent.get(`/api/imports/repositories/${hubId}/item?id=acme/gated-llama`).expect(200)).body;
    expect(after).toMatchObject({ access: 'granted', gate: { account: 'northwind-ml' } });
    const created = (await send(a, 'post', '/api/imports', { repositoryId: hubId, item: 'acme/gated-llama', tag: 'gated-llama:q4' }).expect(201)).body;
    await run();
    const imp = (await a.agent.get(`/api/imports/${created.id}`).expect(200)).body;
    expect(imp.state, imp.error).toBe('complete');
    expect(imp.manifest.gate).toMatchObject({ account: 'northwind-ml' });
  });

  it('B-3803: a licence outside policy waits for the legal-review role, who cannot be the requester', async () => {
    const no = await send(selfLegal, 'post', '/api/imports', { repositoryId: hubId, item: 'acme/nc-model' }).expect(409);
    expect(no.body).toMatchObject({ reason: 'licence-exception-required', licence: 'cc-by-nc-4.0' });
    const created = (await send(selfLegal, 'post', '/api/imports', { repositoryId: hubId, item: 'acme/nc-model', exception: { reason: 'Internal research only' } }).expect(201)).body;
    expect(created).toMatchObject({ state: 'waiting on licence', licenceStatus: 'exception pending', exception: { state: 'pending' } });
    expect(created.exception.ref).toMatch(/^EXC-\d+$/);
    const downloads = hub.downloads.length;
    await run();
    expect(hub.downloads).toHaveLength(downloads); // nothing is fetched while the import waits
    const list = (await legal.agent.get('/api/imports/exceptions?state=pending').expect(200)).body;
    expect(list).toHaveLength(1);
    // Tenant admins request, they cannot decide; and nobody decides their own request.
    await send(ta, 'post', `/api/imports/exceptions/${list[0].id}/decision`, { decision: 'grant' }).expect(403);
    expect((await send(selfLegal, 'post', `/api/imports/exceptions/${list[0].id}/decision`, { decision: 'grant' }).expect(403)).body.step).toBe('dual-control');
    // A tenant admin cannot hand themselves the role either.
    expect((await h.s.db('user_roles').where({ role: 'legal-review' }).count({ n: '*' }))[0]!.n).toBe(2);
    const d = (await send(legal, 'post', `/api/imports/exceptions/${list[0].id}/decision`, { decision: 'grant', note: 'Internal research is fine' }).expect(200)).body;
    expect(d).toMatchObject({ state: 'granted', decisionNote: 'Internal research is fine' });
    await send(legal, 'post', `/api/imports/exceptions/${list[0].id}/decision`, { decision: 'refuse' }).expect(409);
    await run();
    const imp = (await a.agent.get(`/api/imports/${created.id}`).expect(200)).body;
    expect(imp).toMatchObject({ state: 'complete', licenceStatus: 'exception granted' });
    expect(imp.manifest.licence).toMatchObject({ id: 'cc-by-nc-4.0', status: 'exception granted' });
  });

  it('keeps the licence allow-list with the legal-review role', async () => {
    await send(a, 'put', '/api/imports/settings/licences', { allowedLicences: ['mit'] }).expect(403);
    const s = (await send(legal, 'put', '/api/imports/settings/licences', { allowedLicences: ['apache-2.0', 'mit', 'cc-by-nc-4.0', 'llama3.1', 'Unknown'] }).expect(200)).body;
    expect(s.allowedLicences).toEqual(['apache-2.0', 'cc-by-nc-4.0', 'llama3.1', 'mit']);
    expect(s.connectivity).toBe('direct');
  });

  it('B-3803: an Ollama registry import pins the manifest digest (token flow, licence layer)', async () => {
    regId = await confirmed({ name: 'Registry (fake)', type: 'ollama', baseUrl: registry.url, region: 'Global' });
    const r = (await a.agent.get(`/api/imports/repositories/${regId}`).expect(200)).body;
    expect(r).toMatchObject({ status: 'reachable', snapshotItems: 1 });
    expect(registry.tokenRequests).toBeGreaterThan(0);
    const cat = (await a.agent.get(`/api/imports/repositories/${regId}/catalog`).expect(200)).body;
    expect(cat.items[0]).toMatchObject({ itemId: 'tinyllama', licence: 'mit', formats: ['gguf'] });
    expect(cat.facets.find((f: { key: string }) => f.key === 'quantization').values.map((v: { value: string }) => v.value).sort()).toEqual(['Q4_K_M', 'Q8_0']);
    const host = new URL(registry.url).host;
    const created = (await send(a, 'post', '/api/imports', { repositoryId: regId, item: 'tinyllama', revision: '1b-q4_K_M' }).expect(201)).body;
    expect(created.revision).toBe(registry.manifestDigest('1b-q4_K_M'));
    expect(created.options.tag).toBe(`${host}/library/tinyllama:1b-q4_K_M`);
    await run();
    const imp = (await a.agent.get(`/api/imports/${created.id}`).expect(200)).body;
    expect(imp.state, imp.error).toBe('complete');
    expect(imp.model).toMatchObject({ name: `${host}/library/tinyllama:1b-q4_K_M`, expectedDigest: registry.manifestDigest('1b-q4_K_M') });
    const model = await h.s.gateway.repo.model(imp.model.id);
    expect(model).toMatchObject({ quantization: 'Q4_K_M', family: 'llama', format: 'gguf' });
    expect(conv.converts).toHaveLength(3); // the registry path needs no conversion
  });

  it('B-3803: bundle mode queues the request; a promoted bundle carrying it completes the import', async () => {
    const cfg = h.s.cfg as { IMPORT_CONNECTIVITY: 'direct' | 'bundle' };
    cfg.IMPORT_CONNECTIVITY = 'bundle';
    try {
      const created = (await send(a, 'post', '/api/imports', { repositoryId: regId, item: 'tinyllama', revision: '1b-q8_0' }).expect(201)).body;
      expect(created).toMatchObject({ state: 'queued for bundle', mode: 'bundle' });
      expect(created.options.manifestDigest).toBe(registry.manifestDigest('1b-q8_0'));
      const req = (await sys.agent.get('/api/imports/bundle-requests').expect(200)).body;
      expect(req.format).toBe('exprsn-import-requests/1');
      expect(req.requests).toEqual([expect.objectContaining({ id: created.id, item: 'tinyllama', revision: '1b-q8_0', path: `imports/${created.id}/` })]);
      expect(await h.s.imports.bundleMatch(h.tenantId)).toEqual({ matched: 0 });
      // Staging fetched, scanned and signed; the bundle was verified and promoted into the models mirror store.
      const manifest = registry.manifests.get('library/tinyllama:1b-q8_0')!;
      const m = JSON.parse(manifest.toString('utf8')) as { config: { digest: string; mediaType: string }; layers: { digest: string; mediaType: string }[] };
      const entries: { path: string; bytes: Buffer }[] = [{ path: 'manifest.json', bytes: manifest }];
      for (const l of [m.config, ...m.layers]) entries.push({ path: `${l.mediaType === m.config.mediaType ? 'config' : l.mediaType.replace('application/vnd.ollama.image.', '')}-${l.digest.slice(7, 19)}`, bytes: registry.blobs.get(l.digest)! });
      const files = [];
      for (const e of entries) {
        const hex = sha256(e.bytes);
        await h.s.blobs.put(`mirrors/models/sha256/${hex}`, e.bytes);
        files.push({ path: `imports/${created.id}/${e.path}`, sha256: hex, size: e.bytes.length });
      }
      await h.s.blobs.put('mirrors/models/index/bundle-2026-41.json', Buffer.from(JSON.stringify({ bundle: 'bundle-2026-41', files })));
      await h.s.db('platform_bundles').insert({ id: '01JBUNDLE0000000000000000A', name: 'bundle-2026-41', state: 'in production', expedited: false, transfer: 'share', steps: '[]', report: JSON.stringify({ byMirror: { models: files.length } }), created_at: Date.now(), updated_at: Date.now(), promoted_at: Date.now() });
      expect(await h.s.imports.bundleMatch(h.tenantId)).toEqual({ matched: 1 });
      await run();
      const imp = (await a.agent.get(`/api/imports/${created.id}`).expect(200)).body;
      expect(imp.state, imp.error).toBe('complete');
      expect(imp.model.expectedDigest).toBe(registry.manifestDigest('1b-q8_0'));
      expect(imp.manifest.source.bundle).toBe(`imports/${created.id}`);
    } finally {
      cfg.IMPORT_CONNECTIVITY = 'direct';
    }
  });

  it('cancels a queued import, and keeps the dataset quota with the system admin', async () => {
    const created = (await send(b, 'post', '/api/imports', { repositoryId: regId, item: 'tinyllama', revision: '1b-q8_0', tag: 'tiny-copy:q8' }).expect(201)).body;
    const c = (await send(b, 'post', `/api/imports/${created.id}/cancel`).expect(200)).body;
    expect(c.state).toBe('cancelled');
    await run();
    expect((await a.agent.get(`/api/imports/${created.id}`).expect(200)).body.state).toBe('cancelled');
    const q = (await a.agent.get('/api/imports?state=cancelled').expect(200)).body;
    expect(q.imports.map((x: { id: string }) => x.id)).toContain(created.id);
    await send(ta, 'put', `/api/admin/tenants/${h.tenantId}/import-quota`, { maxBytes: 1000 }).expect(403);
    const set = (await send(sys, 'put', `/api/admin/tenants/${h.tenantId}/import-quota`, { maxBytes: 1000 }).expect(200)).body;
    expect(set).toMatchObject({ maxBytes: 1000, custom: true });
    await expect(h.s.imports.admitDataset(h.tenantId, 1001)).rejects.toMatchObject({ status: 413 });
    await expect(h.s.imports.admitDataset(h.tenantId, 999)).resolves.toBeUndefined();
  });

  it('rejects, disables and deletes repositories under dual control', async () => {
    const p = (await send(b, 'post', '/api/imports/repositories', { name: 'Zenodo (fake)', type: 'invenio', baseUrl: hub.url, region: 'EU' }).expect(201)).body;
    const rej = (await send(a, 'post', `/api/imports/repositories/${p.id}/reject`, { note: 'not needed' }).expect(200)).body;
    expect(rej.state).toBe('rejected');
    await send(a, 'post', `/api/imports/repositories/${p.id}/confirm`).expect(409);
    await send(a, 'post', `/api/imports/repositories/${regId}/disable`).expect(200);
    await a.agent.get(`/api/imports/repositories/${regId}/catalog`).expect(409);
    await send(a, 'post', `/api/imports/repositories/${regId}/enable`).expect(200);
    await send(a, 'delete', `/api/imports/repositories/${p.id}`).expect(204);
    await send(a, 'post', '/api/imports/repositories', { name: 'bad', type: 'ckan', baseUrl: 'http://example.org', region: 'US' }).expect(400);
  });
});
