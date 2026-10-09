import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiOf, CsvParser, inferType, parseStream } from '../src/imports/rows.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';
import { startFakePortal, type FakePortal } from './sprint40b-fakes.js';

/**
 * Sprint 40b (1.7.0), B-3804: dataset import. A CKAN datastore read page by page into a training dataset version
 * whose manifest, hash and scrub report are the same shape as an inline version's; a dataset above the quota imported
 * as a sample or refused; an unreadable format refused with nothing written; a licence outside the allow-list waiting
 * on legal review; the rows stored sealed.
 */

const send = (c: Client, method: 'post' | 'patch' | 'put' | 'delete', url: string, body: unknown = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body as object);

describe('row readers (B-3804)', () => {
  it('parses CSV with quotes, escaped quotes and newlines across chunk boundaries', () => {
    const p = new CsvParser();
    const rows = [...p.push('id,text\n1,"a ""quoted"" value"\n2,"multi\nline'), ...p.push(' value"\n3,plain\n', true)];
    expect(rows).toEqual([{ id: '1', text: 'a "quoted" value' }, { id: '2', text: 'multi\nline value' }, { id: '3', text: 'plain' }]);
  });

  it('streams CSV, JSON Lines and JSON arrays, capped at the row limit', async () => {
    const body = async function* (parts: string[]) {
      for (const x of parts) yield Buffer.from(x);
    };
    const csv: unknown[] = [];
    for await (const page of parseStream(body(['a,b\n1,2\n3,', '4\n5,6\n']), 'csv', { maxRows: 2 })) csv.push(...page);
    expect(csv).toEqual([{ a: '1', b: '2' }, { a: '3', b: '4' }]);
    const jsonl: unknown[] = [];
    for await (const page of parseStream(body(['{"x":1}\n{"x"', ':2}\n']), 'jsonl', { maxRows: 10 })) jsonl.push(...page);
    expect(jsonl).toEqual([{ x: 1 }, { x: 2 }]);
    const arr: unknown[] = [];
    for await (const page of parseStream(body(['{"results":[{"y":1},{"y":2},{"y":3}]}']), 'json', { maxRows: 2 })) arr.push(...page);
    expect(arr).toEqual([{ y: 1 }, { y: 2 }]);
    expect(inferType(['1', '2.5'])).toBe('number');
    expect(inferType(['2026-01-02', '2026-02'])).toBe('date');
    expect(inferType(['yes', 'no'])).toBe('boolean');
    expect(inferType(['a', '1'])).toBe('text');
  });

  it('tells the paged APIs from files by their URLs', () => {
    expect(apiOf({ datastore: true })).toBe('ckan-datastore');
    expect(apiOf({ url: 'https://data.cityofchicago.org/resource/ijzp-q8t2.json' })).toBe('socrata');
    expect(apiOf({ url: 'https://api.e-stat.go.jp/rest/3.0/app/json/getStatsData?statsDataId=1' })).toBe('estat');
    expect(apiOf({ url: 'https://api.data.gov.in/resource/9ef84268-d588-465a-a308-a864a43d0070' })).toBe('ogd');
    expect(apiOf({ url: 'https://x.example/files/a.csv', format: 'csv' })).toBe('file');
  });
});

describe('Sprint 40b: dataset import into Training and the store', () => {
  let h: Harness;
  let portal: FakePortal;
  let a: Client; // ML admin who imports (and tenant admin, model admin to propose)
  let b: Client; // the second model admin confirms
  let legal: Client;
  let sys: Client;
  let ckanId: string;
  const run = () => h.s.jobs.runDue(50);
  const drain = async () => {
    for (let i = 0; i < 12; i++) if (!(await run())) return;
  };
  const confirmed = async (body: object) => {
    const p = await send(a, 'post', '/api/imports/repositories', body);
    if (p.status !== 201) throw new Error(JSON.stringify(p.body));
    await send(b, 'post', `/api/imports/repositories/${p.body.id}/confirm`, {}).expect(200);
    await drain();
    return p.body.id as string;
  };

  beforeAll(async () => {
    portal = await startFakePortal();
    h = await harness({ IMPORT_ALLOWED_HOSTS: '127.0.0.1', IMPORT_HARVEST_TICK_MINUTES: '0', IMPORT_BUNDLE_POLL_MINUTES: '0', IMPORT_DATASET_MAX_ROWS: '100000' });
    await localUser(h, 'dsa', ['model-admin', 'tenant-admin', 'ml-admin'], 'restricted');
    await localUser(h, 'dsb', ['model-admin'], 'restricted');
    await localUser(h, 'dslegal', ['legal-review'], 'restricted');
    await localUser(h, 'dssys', ['system-admin'], 'restricted');
    [a, b, legal, sys] = [await loginAdmin(h, 'dsa'), await loginAdmin(h, 'dsb'), await loginAdmin(h, 'dslegal'), await loginAdmin(h, 'dssys')];
    ckanId = await confirmed({ name: 'portal (fake)', type: 'ckan', baseUrl: `${portal.url}/api/3`, region: 'US', harvestMinutes: null });
  }, 120_000);

  afterAll(async () => {
    await h.close();
    await portal.close();
  });

  it('shows a dataset\'s resources, previews its schema with PII flags, and imports the datastore page by page into a training version', async () => {
    const detail = (await a.agent.get(`/api/imports/repositories/${ckanId}/dataset?id=consumer-complaints`).expect(200)).body;
    expect(detail.resources.map((r: { id: string; api: string; format: string }) => [r.id, r.api, r.format])).toEqual([['ds-complaints', 'ckan-datastore', 'api'], ['complaints-json', 'file', 'json']]);
    expect(detail.frequency).toBe('monthly');
    expect(detail.licence).toBe('us-pd');

    const plan = (await send(a, 'post', '/api/imports/dataset-plan', { repositoryId: ckanId, item: 'consumer-complaints', resources: ['ds-complaints'], target: 'training', label: 'confidential', training: { name: 'complaints', textColumn: 'narrative', labelColumn: 'product' } }).expect(200)).body;
    expect(plan.blocked).toBe(false);
    expect(plan.schema.columns.map((c: { name: string; type: string }) => `${c.name}:${c.type}`)).toEqual(['id:number', 'product:text', 'narrative:text', 'email:text', 'region:text', 'received:date']);
    expect(plan.schema.piiColumns).toEqual(['email']);
    expect(plan.checks.find((c: { name: string }) => c.name === 'PII').result).toBe('warning');
    expect(plan.checks.find((c: { name: string }) => c.name === 'Format').detail).toContain('ckan-datastore API, paged');
    expect(plan.schedule).toBe('monthly');

    const created = (await send(a, 'post', '/api/imports/datasets', { repositoryId: ckanId, item: 'consumer-complaints', resources: ['ds-complaints'], target: 'training', label: 'confidential', training: { name: 'complaints', textColumn: 'narrative', labelColumn: 'product' } }).expect(201)).body;
    expect(created).toMatchObject({ kind: 'dataset', target: 'training', state: 'queued', licence: 'us-pd' });
    portal.calls.length = 0;
    await drain();
    const imp = (await a.agent.get(`/api/imports/${created.id}`).expect(200)).body;
    expect(imp.state, JSON.stringify(imp.log)).toBe('complete');
    expect(imp.result).toMatchObject({ rows: 2500, sampled: false, piiColumns: ['email'] });
    expect(imp.result.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(imp.datasetId).toBeTruthy();
    expect(imp.manifest).toMatchObject({ format: 'exprsn-import-manifest/1', kind: 'dataset', rows: 2500, destination: { target: 'training', dataset_id: imp.datasetId } });
    expect(typeof imp.manifest.signature.value).toBe('string');
    expect(imp.manifest.signature.value.length).toBeGreaterThan(20);
    // Paged through datastore_search with offset and limit, never the whole table at once.
    const pages = portal.calls.filter((c) => c.includes('datastore_search'));
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(pages[1]).toMatch(/offset=1000/);

    // The training version: scrubbed, sealed, hashed, with the same manifest fields as an inline version.
    const ds = (await a.agent.get(`/api/training/datasets/${imp.datasetId}`).expect(200)).body;
    expect(ds).toMatchObject({ name: 'complaints', version: 1, state: 'ready', rows: 2500, sourceKind: 'import', label: 'confidential' });
    expect(ds.hash).toMatch(/^sha256:/);
    expect(ds.splits.rows.train + ds.splits.rows.val + ds.splits.rows.test).toBe(2500);
    expect(ds.scrub.masked).toBeGreaterThanOrEqual(2500);
    expect(ds.scrub.byKind.email).toBeGreaterThanOrEqual(2500);
    const report = (await a.agent.get(`/api/training/datasets/${imp.datasetId}/report`).expect(200)).body;
    expect(JSON.stringify(report)).toContain('"dataset":"complaints"');
    expect(ds.source).toContain('portal (fake)');
    // The staging object is gone after the scrub; the sealed rows are what remains.
    expect(await h.s.blobs.get(`training/staging/${h.tenantId}/imports/${created.id}.jsonl`)).toBeNull();

    // A second import of the same name is the next version.
    const again = (await send(a, 'post', '/api/imports/datasets', { repositoryId: ckanId, item: 'consumer-complaints', resources: ['complaints-json'], target: 'training', label: 'confidential', sample: 50, training: { name: 'complaints' } }).expect(201)).body;
    await drain();
    const imp2 = (await a.agent.get(`/api/imports/${again.id}`).expect(200)).body;
    expect(imp2.state, imp2.error).toBe('complete');
    expect(imp2.result).toMatchObject({ rows: 50, sampled: true });
    expect((await a.agent.get(`/api/training/datasets/${imp2.datasetId}`).expect(200)).body.version).toBe(2);
  }, 120_000);

  it('refuses a dataset above the quota unless it is sampled, and refuses a format nobody reads with nothing written', async () => {
    await send(sys, 'put', `/api/admin/tenants/${h.tenantId}/import-quota`, { maxBytes: 300 }).expect(200);
    const plan = (await send(a, 'post', '/api/imports/dataset-plan', { repositoryId: ckanId, item: 'consumer-complaints', resources: ['ds-complaints'], target: 'store', label: 'internal' }).expect(200)).body;
    expect(plan.blocked).toBe(true);
    expect(plan.quota.overQuota).toBe(true);
    expect(plan.checks.find((c: { name: string }) => c.name === 'Quota')).toMatchObject({ result: 'refused' });
    const refused = await send(a, 'post', '/api/imports/datasets', { repositoryId: ckanId, item: 'consumer-complaints', resources: ['ds-complaints'], target: 'store', label: 'internal' }).expect(422);
    expect(refused.body.import.state).toBe('refused');
    expect(refused.body.reason).toContain('quota');
    // Sampled: the plan warns, the job keeps the sample's rows only.
    const sampled = (await send(a, 'post', '/api/imports/datasets', { repositoryId: ckanId, item: 'consumer-complaints', resources: ['ds-complaints'], target: 'store', label: 'internal', sample: 7 }).expect(201)).body;
    expect(sampled.sampleRows).toBe(7);
    await send(sys, 'put', `/api/admin/tenants/${h.tenantId}/import-quota`, { maxBytes: null }).expect(200);
    await drain();
    const imp = (await a.agent.get(`/api/imports/${sampled.id}`).expect(200)).body;
    expect(imp.state, imp.error).toBe('complete');
    expect(imp.result).toMatchObject({ rows: 7, sampled: true });
    expect(imp.result.stored.key).toBe(`imports/datasets/${h.tenantId}/${sampled.id}.jsonl`);
    const sealed = await h.s.blobs.get(imp.result.stored.key);
    expect(sealed).not.toBeNull();
    expect(sealed!.toString('utf8')).not.toContain('Complaint 1:');
    const opened = await h.s.keys.openBytes(h.tenantId, sealed!.toString(), `import-dataset:${sampled.id}`);
    expect(opened.toString('utf8').split('\n').filter(Boolean)).toHaveLength(7);

    // A spreadsheet: refused at the format check, recorded on the queue, no dataset, no staging object.
    const before = (await a.agent.get('/api/training/datasets').expect(200)).body.length;
    const xl = await send(a, 'post', '/api/imports/datasets', { repositoryId: ckanId, item: 'spreadsheet-only', target: 'training', label: 'internal', training: { name: 'spreadsheet' } }).expect(422);
    expect(xl.body.detail).toMatch(/xlsx/);
    expect(xl.body.import).toMatchObject({ state: 'refused', kind: 'dataset' });
    expect((await a.agent.get('/api/training/datasets').expect(200)).body.length).toBe(before);
    expect(await h.s.blobs.get(`training/staging/${h.tenantId}/imports/${xl.body.import.id}.jsonl`)).toBeNull();
    await send(a, 'post', `/api/imports/${xl.body.import.id}/retry`).expect(409);
  }, 120_000);

  it('waits on a legal-review exception for a licence outside the allow-list, then imports once granted', async () => {
    await send(a, 'post', '/api/imports/datasets', { repositoryId: ckanId, item: 'failed-banks', target: 'store', label: 'internal' }).expect(409);
    const waiting = (await send(a, 'post', '/api/imports/datasets', { repositoryId: ckanId, item: 'failed-banks', target: 'store', label: 'internal', exception: { reason: 'internal evaluation only' } }).expect(201)).body;
    expect(waiting).toMatchObject({ state: 'waiting on licence', licenceStatus: 'exception pending', licence: 'cc-by-nc-4.0' });
    await drain();
    expect((await a.agent.get(`/api/imports/${waiting.id}`).expect(200)).body.state).toBe('waiting on licence');
    const exc = (await legal.agent.get('/api/imports/exceptions?state=pending').expect(200)).body.find((e: { import: { ref: string } }) => e.import.ref === waiting.ref);
    expect(exc).toBeTruthy();
    await send(legal, 'post', `/api/imports/exceptions/${exc.id}/decision`, { decision: 'grant', note: 'evaluation only' }).expect(200);
    await drain();
    const imp = (await a.agent.get(`/api/imports/${waiting.id}`).expect(200)).body;
    expect(imp.state, imp.error).toBe('complete');
    expect(imp.licenceStatus).toBe('exception granted');
    expect(imp.result.rows).toBe(2);
    // The queue lists dataset imports beside model imports, with their kind and destination.
    const list = (await a.agent.get('/api/imports?kind=dataset').expect(200)).body;
    expect(list.imports.every((x: { kind: string }) => x.kind === 'dataset')).toBe(true);
    expect(list.imports.map((x: { target: string }) => x.target)).toContain('store');
  }, 60_000);

  it('cancels a queued dataset import and refuses a destination the requester may not write to', async () => {
    const q = (await send(a, 'post', '/api/imports/datasets', { repositoryId: ckanId, item: 'small-labelled', target: 'store', label: 'internal' }).expect(201)).body;
    const c = (await send(a, 'post', `/api/imports/${q.id}/cancel`).expect(200)).body;
    expect(c.state).toBe('cancelled');
    await drain();
    expect((await a.agent.get(`/api/imports/${q.id}`).expect(200)).body.state).toBe('cancelled');
    // The second model admin has imports:run but not training:submit.
    const plan = (await send(b, 'post', '/api/imports/dataset-plan', { repositoryId: ckanId, item: 'small-labelled', target: 'training', label: 'internal', training: { name: 'intents' } }).expect(200)).body;
    expect(plan.checks.find((x: { name: string }) => x.name === 'Destination')).toMatchObject({ result: 'refused' });
    expect(plan.checks.find((x: { name: string }) => x.name === 'Destination').detail).toContain('training:submit');
  }, 60_000);
});
