import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/crypto/index.js';
import { cadenceOf, datasetItems, nextRefresh } from '../src/imports/datasets.js';
import { delimitedRows, fileKind, fileRecords, profile } from '../src/imports/tabular.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';
import { drain, seedRetrieval } from './retrieval-seed.js';
import { startFakeCkan, startFakeHub, startFakeSource, type FakeCkan, type FakeHub, type FakeSource } from './sprint30-imports-fakes.js';

/**
 * Sprint 40 (1.7.0), B-3804 to B-3806: dataset import. Rows from a hub's dataset viewer, a CKAN datastore, a Socrata
 * resource, a CSV download and SDMX-CSV become a training dataset version, a knowledge set that refreshes on a
 * schedule, a classifier eval set or a stored dataset. All sources are the local fakes of the first half.
 */

const send = (c: Client, method: 'post' | 'patch' | 'put' | 'delete', url: string, body: unknown = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body as object);
const bytes = async function* (...parts: (string | Buffer)[]) {
  for (const p of parts) yield Buffer.from(p);
};
const all = async <T>(it: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

describe('rows out of published files, and the schema preview (B-3804)', () => {
  it('reads CSV with quoted delimiters, line breaks and doubled quotes, across chunk boundaries', async () => {
    const csv = 'name;note;n\r\n"Smith; J.";"said ""hi""\nand left";3\r\nplain;;4\n';
    // One character a chunk: every state of the reader crosses a boundary.
    const chunks = (async function* () {
      for (const c of csv) yield c;
    })();
    expect(await all(delimitedRows(chunks))).toEqual([['name', 'note', 'n'], ['Smith; J.', 'said "hi"\nand left', '3'], ['plain', '', '4']]);
    expect(await all(fileRecords(bytes('a,b\n1,"x,y"\n'), 'csv', { maxBytes: 1000 }))).toEqual([{ a: '1', b: 'x,y' }]);
    expect(await all(fileRecords(bytes('a\tb\n1\t2\n'), 'tsv', { maxBytes: 1000 }))).toEqual([{ a: '1', b: '2' }]);
    // Two columns with one name keep both values.
    expect(await all(fileRecords(bytes('v,v\n1,2\n'), 'csv', { maxBytes: 1000 }))).toEqual([{ v: '1', v_2: '2' }]);
  });

  it('reads JSON Lines, JSON documents, ARFF and gzip, and stops past its byte budget', async () => {
    expect(await all(fileRecords(bytes('{"a":1}\n\n{"a":', '2}\n'), 'jsonl', { maxBytes: 1000 }))).toEqual([{ a: 1 }, { a: 2 }]);
    expect(await all(fileRecords(bytes('{"records":[{"a":1},{"a":2}]}'), 'json', { maxBytes: 1000 }))).toEqual([{ a: 1 }, { a: 2 }]);
    const arff = "% credit\n@relation credit\n@attribute 'checking status' {a,b}\n@attribute duration numeric\n@attribute class {good,bad}\n@data\n'<0',6,good\n?,12,bad\n";
    expect(await all(fileRecords(bytes(arff), 'arff', { maxBytes: 1000 }))).toEqual([{ 'checking status': '<0', duration: '6', class: 'good' }, { 'checking status': null, duration: '12', class: 'bad' }]);
    expect(await all(fileRecords(bytes(gzipSync('a,b\n1,2\n')), 'csv', { maxBytes: 1000, gzip: true }))).toEqual([{ a: '1', b: '2' }]);
    await expect(all(fileRecords(bytes('a,b\n', '1,2\n'.repeat(100)), 'csv', { maxBytes: 50 }))).rejects.toThrow(/larger than the 50 bytes/);
    expect(fileKind('CSV', 'https://x.example/data')).toEqual({ kind: 'csv', gzip: false });
    expect(fileKind(null, 'https://x.example/prc_hicp.tsv.gz?download=1')).toEqual({ kind: 'tsv', gzip: true });
    expect(fileKind('XLSX', 'report.xlsx')).toEqual({ kind: 'xlsx', gzip: false });
    expect(fileKind('parquet', 'x.parquet')).toEqual({ kind: 'parquet', gzip: false });
    expect(fileKind('PDF', 'report.pdf')).toBeNull();
  });

  it('profiles columns: types, classes, and PII by detector and by name', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: String(i + 1), amount: `${i}.50`, month: '2026-08', product: ['Card', 'Loan'][i % 2], narrative: i === 4 ? 'write to jo@example.org' : `charged twice ${i}`, zip_code: `750${i % 10}0`, value: i }));
    const cols = Object.fromEntries(profile(rows).map((c) => [c.name, c]));
    expect(cols.id).toMatchObject({ type: 'int', pii: null });
    expect(cols.amount!.type).toBe('decimal');
    expect(cols.month!.type).toBe('month');
    expect(cols.product!.type).toBe('class (Card, Loan)');
    expect(cols.value!.type).toBe('int');
    expect(cols.narrative).toMatchObject({ type: 'string', pii: 'email in 1 row', detected: { email: 1 } });
    expect(cols.zip_code!.pii).toMatch(/quasi-identifier/);
  });

  it('schedules refreshes by calendar month and follows the publisher only when it states a frequency', () => {
    const jan31 = Date.UTC(2026, 0, 31, 7, 0);
    expect(new Date(nextRefresh('monthly', jan31)!).toISOString()).toBe('2026-02-28T07:00:00.000Z');
    expect(new Date(nextRefresh('quarterly', Date.UTC(2026, 10, 15, 7, 0))!).toISOString()).toBe('2027-02-15T07:00:00.000Z');
    expect(nextRefresh('daily', jan31)! - jan31).toBe(86_400_000);
    expect(nextRefresh(null, jan31)).toBeNull();
    expect(cadenceOf('publisher', 'monthly')).toBe('monthly');
    expect(cadenceOf('publisher', 'irregular')).toBeNull();
    expect(cadenceOf('publisher', null)).toBeNull();
    expect(cadenceOf('weekly', 'monthly')).toBe('weekly');
    expect(cadenceOf('manual', 'daily')).toBeNull();
  });

  it('makes one document per row or per group, each row with its id', async () => {
    const cfg = { name: 'Banks', titleColumn: 'Bank', textColumns: ['Bank', 'City'], metadataColumns: ['Cert'], idColumn: 'Cert', groupBy: null };
    const recs = [{ id: null, part: 'banks.csv', values: { Bank: 'First', City: 'Austin', Cert: '10' } }, { id: null, part: 'banks.csv', values: { Bank: 'Second', City: 'Tulsa', Cert: '11' } }];
    const perRow = datasetItems(cfg, recs, 'data.gov');
    expect(perRow.map((x) => [x.key, x.name])).toEqual([['row:10', 'First (row 10)'], ['row:11', 'Second (row 11)']]);
    expect((await perRow[0]!.read()).toString()).toBe('# First\n\nBank: First\nCity: Austin\n\nRow 10 of Banks (data.gov), banks.csv\nCert: 10\n');
    const grouped = datasetItems({ ...cfg, groupBy: 'City', textColumns: ['Bank'] }, [...recs, { id: null, part: null, values: { Bank: 'Third', City: 'Austin', Cert: '12' } }], 'data.gov');
    expect(grouped.map((x) => x.name)).toEqual(['Banks: Austin', 'Banks: Tulsa']);
    expect((await grouped[0]!.read()).toString()).toContain('## First, row 10\n\nFirst\n\nRow 10 of Banks (data.gov), banks.csv\nCert: 10\n\n## Third, row 12');
    // Without an id column, the source's own row id, then the position.
    expect(datasetItems({ ...cfg, idColumn: null }, [{ id: 'r-7', part: null, values: { Bank: 'A' } }, { id: null, part: null, values: { Bank: 'B' } }], 'x').map((x) => x.key)).toEqual(['row:r-7', 'row:2']);
  });
});

describe('Sprint 40: dataset import into Training, Knowledge, Classifiers and the store', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let hub: FakeHub;
  let ckan: FakeCkan;
  let src: FakeSource;
  let a: Client; // imports for every destination
  let b: Client; // the second model admin
  let legal: Client;
  let sys: Client;
  let curator: Client; // imports:run and knowledge:manage only
  let hubId: string;
  let ckanId: string;
  let sdmxId: string;

  const confirmed = async (body: object) => {
    const p = await send(a, 'post', '/api/imports/repositories', body);
    if (p.status !== 201) throw new Error(JSON.stringify(p.body));
    await send(b, 'post', `/api/imports/repositories/${p.body.id}/confirm`, {}).expect(200);
    await drain(h);
    return p.body.id as string;
  };
  const imported = async (c: Client, body: object) => {
    const res = await send(c, 'post', '/api/imports/datasets', body);
    if (res.status !== 201) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
    await drain(h);
    return (await c.agent.get(`/api/imports/${res.body.id}`).expect(200)).body;
  };
  const SDMX_HEAD = 'DATAFLOW,FREQ,UNIT,COICOP,GEO,TIME_PERIOD,OBS_VALUE';
  const sdmxCsv = (months: string[]) => `${SDMX_HEAD}\n${['EA20', 'DE'].flatMap((geo, g) => months.map((m, i) => `ESTAT:PRC_HICP_MIDX(1.0),M,I15,CP00,${geo},${m},${(126 + g + i * 0.4).toFixed(1)}`)).join('\n')}\n`;

  beforeAll(async () => {
    [ollama, hub, ckan, src] = await Promise.all([new FakeOllama().start(), startFakeHub(), startFakeCkan(), startFakeSource()]);
    h = await harness({ IMPORT_ALLOWED_HOSTS: '127.0.0.1', IMPORT_HARVEST_TICK_MINUTES: '0', IMPORT_BUNDLE_POLL_MINUTES: '0', IMPORT_REFRESH_TICK_MINUTES: '0', IMPORT_DATASET_MAX_ROWS: '3000', IMPORT_PREVIEW_ROWS: '300', OLLAMA_POLL_MS: '600000' });
    await seedRetrieval(h, ollama);
    await localUser(h, 'dsa', ['model-admin', 'ml-admin', 'knowledge-curator', 'guardrail-admin'], 'restricted');
    await localUser(h, 'dsb', ['model-admin'], 'restricted');
    await localUser(h, 'dslegal', ['legal-review'], 'restricted');
    await localUser(h, 'dssys', ['system-admin'], 'restricted');
    await localUser(h, 'dscur', ['knowledge-curator'], 'restricted');
    await localUser(h, 'dsmember', ['member']);
    [a, b, legal, sys] = [await loginAdmin(h, 'dsa'), await loginAdmin(h, 'dsb'), await loginAdmin(h, 'dslegal'), await loginAdmin(h, 'dssys')];
    curator = await login(h, 'dscur');
    src.routes.set('/sdmx/dataflow/all/all/latest', { type: 'application/xml', body: '<s:Dataflows><s:Dataflow id="PRC_HICP_MIDX" agencyID="ESTAT" version="1.0"><c:Name xml:lang="en">HICP monthly index</c:Name></s:Dataflow></s:Dataflows>' });
    src.routes.set('/sdmx/dataflow/ESTAT/PRC_HICP_MIDX/1.0', { type: 'application/xml', body: '<s:Dataflows><s:Dataflow id="PRC_HICP_MIDX" agencyID="ESTAT" version="1.0"><c:Name xml:lang="en">HICP monthly index</c:Name></s:Dataflow></s:Dataflows>' });
    src.routes.set('/sdmx/data/ESTAT,PRC_HICP_MIDX,1.0', { type: 'application/vnd.sdmx.data+csv', body: sdmxCsv(['2026-06', '2026-07', '2026-08']) });
    hubId = await confirmed({ name: 'Hub (fake)', type: 'hf', baseUrl: hub.url, region: 'Global', kinds: ['model', 'dataset'] });
    ckanId = await confirmed({ name: 'data.gov (fake)', type: 'ckan', baseUrl: `${ckan.url}/api/3`, region: 'US' });
    sdmxId = await confirmed({ name: 'Eurostat (fake)', type: 'sdmx', baseUrl: `${src.url}/sdmx`, region: 'EU', options: { licence: 'cc-by-4.0' } });
  }, 180_000);

  afterAll(async () => {
    await h.close();
    await Promise.all([hub.close(), ckan.close(), src.close(), ollama.stop()]);
  });

  it('says which repository types fetch datasets, and describes configurations, splits and resources', async () => {
    const types = (await a.agent.get('/api/imports/types').expect(200)).body as { type: string; datasetImport: boolean }[];
    expect(types.filter((t) => t.datasetImport).map((t) => t.type)).toEqual(['hf', 'ckan', 'dcat', 'sdmx', 'openml', 'invenio', 'kaggle', 'estat', 'ogd']);
    const dolly = (await a.agent.get(`/api/imports/repositories/${hubId}/dataset?id=acme/dolly`).expect(200)).body;
    expect(dolly).toMatchObject({ itemId: 'acme/dolly', licence: 'cc-by-sa-3.0', licenceAllowed: true, rows: 250, source: 'live', configurations: [{ id: 'default' }], splits: [{ config: 'default', id: 'train', rows: 250 }] });
    expect(dolly.revision).toHaveLength(40);
    const cc = (await a.agent.get(`/api/imports/repositories/${ckanId}/dataset?id=consumer-complaints`).expect(200)).body;
    expect(cc).toMatchObject({ name: 'Consumer Complaint Database', licence: 'us-pd', updates: 'monthly', publisher: 'CFPB' });
    expect(cc.resources).toMatchObject([{ id: 'cc-datastore', access: 'ckan-datastore', format: 'api' }, { id: 'cc-json', access: 'file', format: 'zip' }]);
    const ev = (await a.agent.get(`/api/imports/repositories/${ckanId}/dataset?id=ev-population`).expect(200)).body;
    expect(ev.resources.map((r: { access: string }) => r.access)).toEqual(['file', 'socrata', 'unsupported']);
    expect(ev.resources[2].note).toMatch(/shp files are not read/);
    const hicp = (await a.agent.get(`/api/imports/repositories/${sdmxId}/dataset?id=ESTAT,PRC_HICP_MIDX,1.0`).expect(200)).body;
    expect(hicp).toMatchObject({ name: 'HICP monthly index', licence: 'cc-by-4.0', resources: [{ access: 'sdmx', format: 'sdmx' }] });
    await a.agent.get(`/api/imports/repositories/${ckanId}/dataset?id=nope`).expect(404);
    const m = await login(h, 'dsmember');
    await m.agent.get(`/api/imports/repositories/${ckanId}/dataset?id=consumer-complaints`).expect(403);
  });

  it('B-3804: previews the schema with PII flags, a class label by its names', async () => {
    const pv = (await send(a, 'post', '/api/imports/datasets/preview', { repositoryId: ckanId, item: 'consumer-complaints' }).expect(200)).body;
    expect(pv).toMatchObject({ rows: 300, limit: 300, flagged: 1, sourceIds: true, selection: { resources: ['cc-datastore'] } });
    const col = (n: string) => pv.columns.find((c: { name: string }) => c.name === n);
    expect(col('Product').type).toBe('class (Credit card, Mortgage, Student loan)');
    expect(col('Date received').type).toBe('date');
    expect(col('Consumer complaint narrative')).toMatchObject({ type: 'string', pii: 'email in 6 rows' });
    expect(pv.suggested).toMatchObject({ label: 'Product' });
    const intents = (await send(a, 'post', '/api/imports/datasets/preview', { repositoryId: hubId, item: 'acme/intents', splits: ['test'], rows: 30 }).expect(200)).body;
    expect(intents.rows).toBe(30);
    expect(intents.columns.find((c: { name: string }) => c.name === 'label').type).toBe('class (card_arrival, refund, top_up)');
    // The viewer never saw a credential (the fake answers 400 if it does).
    expect(hub.rowCalls.at(-1)).toMatchObject({ dataset: 'acme/intents', split: 'test', offset: 0, length: 30 });
  });

  it('B-3804: an imported version has a manifest, hash and scrub report identical in shape to an inline one', async () => {
    ckan.calls.length = 0;
    const body = { repositoryId: ckanId, item: 'consumer-complaints', target: 'training', label: 'internal', attribution: 'CFPB, data.gov', training: { name: 'complaints', promptColumn: 'Consumer complaint narrative', completionColumn: 'Product' } };
    const plan = (await send(a, 'post', '/api/imports/datasets/plan', body).expect(200)).body;
    expect(plan).toMatchObject({ blocked: false, waiting: false, creates: 'Training dataset complaints v1', licence: { id: 'us-pd', allowed: true } });
    expect(plan.checks.map((c: { name: string; result: string }) => `${c.name}: ${c.result}`)).toEqual(['Selection: passed', 'Size and quota: info', 'Licence: passed', 'PII preview: warning', 'Refresh: info', 'Destination: passed', 'Connectivity: passed']);
    const imp = await imported(a, body);
    expect(imp).toMatchObject({ kind: 'dataset', target: 'training', state: 'complete', progress: 100, licenceStatus: 'allowed' });
    expect(imp.ref).toMatch(/^IMP-\d{4}-\d+$/);
    // The datastore was read page by page.
    expect(ckan.calls.filter((c) => c.includes('datastore_search') && c.includes('limit=1000')).map((c) => /offset=(\d+)/.exec(c)![1])).toEqual(['0', '1000', '2000']);
    expect(imp.result.training).toMatchObject({ name: 'complaints', version: 1, rows: 2300 });
    expect(imp.storedBytes).toBeGreaterThan(100_000);
    // An inline version of the same shape, registered the old way.
    await send(a, 'post', '/api/training/datasets', { name: 'inline-set', label: 'internal', source: 'by hand', rows: [{ prompt: 'mail jo@example.org', completion: 'Credit card' }, { prompt: 'no pii', completion: 'Mortgage' }] }).expect(202);
    await drain(h);
    const list = (await a.agent.get('/api/training/datasets').expect(200)).body as Record<string, unknown>[];
    const inline = list.find((d) => d.name === 'inline-set')!;
    const mine = list.find((d) => d.name === 'complaints')!;
    expect(mine).toMatchObject({ state: 'ready', sourceKind: 'import', importId: imp.id, rows: 2300, hash: imp.result.training.hash, splits: { pct: { train: 80, val: 10, test: 10 }, rows: { train: 1840, val: 230, test: 230 } } });
    expect(mine.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.keys(mine).sort()).toEqual(Object.keys(inline).sort());
    expect(Object.keys(mine.scrub as object).sort()).toEqual(Object.keys(inline.scrub as object).sort());
    expect(mine.scrub).toMatchObject({ masked: 46, rowsAffected: 46, byKind: { email: 46 } });
    const [rep, repInline] = [(await a.agent.get(`/api/training/datasets/${String(mine.id)}/report`).expect(200)).body, (await a.agent.get(`/api/training/datasets/${String(inline.id)}/report`).expect(200)).body];
    expect(Object.keys(rep).sort()).toEqual(Object.keys(repInline).sort());
    expect(rep.findings[0]).toEqual({ row: 1, field: 'prompt', kind: 'email' });
    // The import's own manifest: source, revision, hash, scrub, licence, label, attribution, requester, signed.
    expect(imp.manifest).toMatchObject({ format: 'exprsn-import-manifest/1', kind: 'dataset', import: imp.ref, hash: mine.hash, source: { type: 'ckan', item: 'consumer-complaints', revision: '2026-10-01T05:00:00', resources: [{ id: 'cc-datastore', access: 'ckan-datastore' }] }, rows: { fetched: 2300, kept: 2300, sampled: false }, scrub: { masked: 46 }, licence: { id: 'us-pd', status: 'allowed' }, label: 'internal', attribution: 'CFPB, data.gov', requester: { username: 'dsa' } });
    const { signature, ...signed } = imp.manifest;
    expect(await h.s.kms.verifyHmac(signature.key, canonicalJson(signed), signature.value)).toBe(true);
    expect(await h.s.kms.verifyHmac(signature.key, canonicalJson({ ...signed, label: 'public' }), signature.value)).toBe(false);
    expect(imp.log.map((l: { title: string }) => l.title)).toEqual(['Request accepted', 'Fetched', 'PII scrub', 'Ready']);
    // A second import of the same name is the next version.
    const again = await imported(a, { ...body, sample: { rows: 10 } });
    expect(again.result.training).toMatchObject({ version: 2, rows: 10 });
    const actions = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).whereIn('action', ['import.requested', 'import.completed', 'training.dataset.scrubbed']).select('action')).map((x: { action: string }) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['import.requested', 'import.completed', 'training.dataset.scrubbed']));
  });

  it('B-3804: above the quota only a sample is imported, in publication order', async () => {
    const used = (await a.agent.get('/api/imports/quota').expect(200)).body.usedBytes.datasets as number;
    const tenant = h.tenantId;
    await send(sys, 'put', `/api/admin/tenants/${tenant}/import-quota`, { maxBytes: used + 10_000 }).expect(200);
    const body = { repositoryId: hubId, item: 'acme/dolly', target: 'training', label: 'internal', training: { name: 'dolly', promptColumn: 'instruction', completionColumn: 'response' } };
    const over = await send(a, 'post', '/api/imports/datasets', body).expect(422);
    expect(over.body.reason).toEqual(['size and quota']);
    expect(over.body.detail).toMatch(/Import a sample \(a row limit\)/);
    // The refusal is on the queue, and nothing was fetched or registered.
    expect(over.body.import).toMatchObject({ state: 'refused', kind: 'dataset', storedBytes: 0 });
    hub.rowCalls.length = 0;
    const plan = (await send(a, 'post', '/api/imports/datasets/plan', { ...body, sample: { rows: 20 } }).expect(200)).body;
    expect(plan.checks.find((c: { name: string }) => c.name === 'Size and quota')).toMatchObject({ result: 'warning', detail: expect.stringMatching(/the first 20 rows in publication order, of 250/) });
    const imp = await imported(a, { ...body, sample: { rows: 20 } });
    expect(imp.state).toBe('complete');
    // Twenty rows fetched in one page; the row with an empty response is left out.
    expect(hub.rowCalls.at(-1)).toMatchObject({ offset: 0, length: 20 });
    expect(imp.manifest.rows).toMatchObject({ fetched: 20, kept: 19, left: 1, sampled: true, limit: 20 });
    expect(imp.result.training.rows).toBe(19);
    await send(sys, 'put', `/api/admin/tenants/${tenant}/import-quota`, { maxBytes: null }).expect(200);
    // Above the row cap (3,000 here) with a known row count is refused the same way; a larger sample than the cap too.
    const big = (await send(a, 'post', '/api/imports/datasets/plan', { ...body, sample: { rows: 5000 } }).expect(200)).body;
    expect(big.checks.find((c: { name: string }) => c.name === 'Size and quota')).toMatchObject({ result: 'refused' });
  });

  it('B-3804: a licence outside policy waits for legal review; a gated dataset and a missing permission are refused', async () => {
    const body = { repositoryId: hubId, item: 'acme/phrasebank', target: 'training', label: 'internal', training: { name: 'phrasebank', promptColumn: 'sentence', completionColumn: 'label' } };
    const need = await send(a, 'post', '/api/imports/datasets', body).expect(409);
    expect(need.body.reason).toBe('licence-exception-required');
    const res = await send(a, 'post', '/api/imports/datasets', { ...body, exception: { reason: 'internal evaluation only' } }).expect(201);
    expect(res.body).toMatchObject({ state: 'waiting on licence', licenceStatus: 'exception pending', exception: { state: 'pending' } });
    await drain(h);
    expect((await a.agent.get(`/api/imports/${res.body.id}`).expect(200)).body.storedBytes).toBe(0);
    await send(legal, 'post', `/api/imports/exceptions/${res.body.exception.id}/decision`, { decision: 'grant', note: 'evaluation only' }).expect(200);
    await drain(h);
    const done = (await a.agent.get(`/api/imports/${res.body.id}`).expect(200)).body;
    expect(done).toMatchObject({ state: 'complete', licenceStatus: 'exception granted', manifest: { licence: { id: 'cc-by-nc-sa-4.0', status: 'exception granted' } } });
    expect(done.result.training.rows).toBe(40);
    const gated = await send(a, 'post', '/api/imports/datasets', { ...body, item: 'acme/gated-data', training: { name: 'gated', promptColumn: 'text' } }).expect(422);
    expect(gated.body.reason).toContain('access');
    // A knowledge curator runs imports but may not make a training dataset.
    const noTrain = await send(curator, 'post', '/api/imports/datasets', { ...body, item: 'acme/dolly', training: { name: 'x', promptColumn: 'instruction' } }).expect(403);
    expect(noTrain.body.action).toBe('training:manage');
    // A column that is not in the selection is a refused destination.
    const bad = (await send(a, 'post', '/api/imports/datasets/plan', { ...body, item: 'acme/dolly', training: { name: 'x', promptColumn: 'nope' } }).expect(200)).body;
    expect(bad.checks.find((c: { name: string }) => c.name === 'Destination')).toMatchObject({ result: 'refused', detail: expect.stringMatching(/nope: not a column/) });
    await send(a, 'post', '/api/imports/datasets', { repositoryId: hubId, item: 'acme/dolly', target: 'training', label: 'internal', bogus: 1 }).expect(400);
  });

  it('B-3805: a monthly SDMX table becomes a knowledge set, refreshes on schedule and keeps answering', async () => {
    const body = { repositoryId: sdmxId, item: 'ESTAT,PRC_HICP_MIDX,1.0', target: 'knowledge', label: 'internal', knowledge: { name: 'Euro area inflation', embedModel: 'nomic-embed-text', titleColumn: 'TIME_PERIOD', textColumns: ['GEO', 'COICOP', 'TIME_PERIOD', 'OBS_VALUE'], metadataColumns: ['UNIT'], groupBy: 'GEO', refresh: 'publisher' } };
    const imp = await imported(a, body);
    expect(imp).toMatchObject({ state: 'complete', target: 'knowledge' });
    // "Follow the publisher": the table's FREQ dimension says monthly.
    expect(imp.result.knowledge).toMatchObject({ name: 'Euro area inflation', createdBase: true, documents: 2, added: 2, refresh: 'publisher', cadence: 'monthly' });
    const kbId = imp.result.knowledge.kbId as string;
    const sourceId = imp.result.knowledge.sourceId as string;
    const next = imp.result.knowledge.nextRefreshAt as number;
    expect(next - Date.now()).toBeGreaterThan(27 * 86_400_000);
    const kb = (await a.agent.get(`/api/knowledge/bases/${kbId}`).expect(200)).body;
    const source = kb.sources.find((s: { id: string }) => s.id === sourceId);
    expect(source).toMatchObject({ kind: 'dataset', location: 'Eurostat (fake): HICP monthly index', schedule: 'manual', state: 'idle', documents: 2, config: { dataset: { groupBy: 'GEO', licenceStatus: 'allowed', lastImport: imp.ref, lastRows: 6 } } });
    const search = async (query: string) => (await send(a, 'post', '/api/knowledge/search', { kbIds: [kbId], query, rerank: false }).expect(200)).body.hits as { document: string; source: string; heading: string | null; text: string }[];
    // A citation names the document, the source and the row: the series key and period of the observation.
    const hit = (await search('EA20 2026-08')).find((x) => x.text.includes('2026-08'))!;
    expect(hit).toMatchObject({ document: 'HICP monthly index: EA20', source: 'Eurostat (fake): HICP monthly index' });
    expect(hit.text).toContain('Row M.I15.CP00.EA20.2026-08 of HICP monthly index (Eurostat (fake))');
    const serving = (await h.s.db('knowledge_bases').where({ id: kbId }).first('serving_index_id')).serving_index_id as string;

    // The publisher adds a month. Nothing is due yet; then the schedule falls due.
    src.routes.set('/sdmx/data/ESTAT,PRC_HICP_MIDX,1.0', { type: 'application/vnd.sdmx.data+csv', body: sdmxCsv(['2026-06', '2026-07', '2026-08', '2026-09']) });
    expect(await h.s.imports.datasets.refreshDue(h.tenantId)).toMatchObject({ queued: 0 });
    const due = async () => {
      const row = await h.s.db('knowledge_sources').where({ id: sourceId }).first('config');
      const cfg = JSON.parse(String(row.config));
      cfg.dataset.nextRefreshAt = Date.now() - 1000;
      await h.s.db('knowledge_sources').where({ id: sourceId }).update({ config: JSON.stringify(cfg) });
    };
    await due();
    expect(await h.s.imports.datasets.refreshDue(h.tenantId)).toMatchObject({ queued: 1 });
    // Queued twice in a row, it is still one refresh; and the old rows answer while it waits.
    expect(await h.s.imports.datasets.refreshDue(h.tenantId)).toMatchObject({ queued: 0 });
    expect((await search('EA20 2026-08')).length).toBeGreaterThan(0);
    await drain(h);
    const queue = (await a.agent.get('/api/imports?kind=dataset').expect(200)).body.imports as { ref: string; state: string; note: string; result: { knowledge?: Record<string, unknown> }; log: { title: string }[]; requestedBy: string }[];
    const refresh = queue[0]!;
    expect(refresh).toMatchObject({ state: 'complete', result: { knowledge: { refreshOf: sourceId, documents: 2, added: 0, changed: 2, removed: 0, cadence: 'monthly' } } });
    expect(refresh.log[0]!.title).toBe('Refresh due');
    expect((await search('DE 2026-09')).some((x) => x.text.includes('2026-09'))).toBe(true);
    // The refresh built index v2 beside the serving one and swapped it in; v1 is retired and empty
    // (sprint40-knowledge-refresh.test.ts holds a refresh half-way and searches the old rows).
    expect(refresh.result.knowledge).toMatchObject({ indexVersion: 2, retiredVersion: 1 });
    expect(refresh.log.map((l) => l.title)).toContain('Index swapped');
    const swapped = (await h.s.db('knowledge_bases').where({ id: kbId }).first('serving_index_id')).serving_index_id as string;
    expect(swapped).not.toBe(serving);
    expect((await h.s.db('knowledge_indexes').where({ kb_id: kbId }).orderBy('version').select('version', 'state')) as { version: number; state: string }[]).toMatchObject([{ version: 1, state: 'retired' }, { version: 2, state: 'serving' }]);
    expect(await h.s.db('knowledge_chunks').where({ index_id: serving })).toHaveLength(0);
    // Only the newest refresh counts against the quota.
    const stored = (await h.s.db('import_jobs').where({ tenant_id: h.tenantId, target: 'knowledge' }).andWhere('options', 'like', `%${sourceId}%`).select('ref', 'stored_bytes')) as { ref: string; stored_bytes: number }[];
    expect(stored.filter((x) => Number(x.stored_bytes) > 0).map((x) => x.ref)).toEqual([refresh.ref]);

    // A refresh that fails keeps the last good rows, says so, and is tried again the next day.
    src.routes.set('/sdmx/data/ESTAT,PRC_HICP_MIDX,1.0', { status: 500, body: { error: 'maintenance' } });
    await due();
    await h.s.imports.datasets.refreshDue(h.tenantId);
    await drain(h);
    const failed = ((await a.agent.get('/api/imports?kind=dataset').expect(200)).body.imports as { state: string; error: string }[])[0]!;
    expect(failed).toMatchObject({ state: 'failed', error: expect.stringMatching(/answered 500/) });
    const after = (await a.agent.get(`/api/knowledge/bases/${kbId}`).expect(200)).body.sources.find((s: { id: string }) => s.id === sourceId);
    expect(after).toMatchObject({ state: 'failed', documents: 2 });
    expect(after.config.dataset.nextRefreshAt - Date.now()).toBeLessThan(25 * 3_600_000);
    expect((await search('DE 2026-09')).some((x) => x.text.includes('2026-09'))).toBe(true);
    // "Sync now" on the Knowledge screen is the same refresh, as an import of its own.
    src.routes.set('/sdmx/data/ESTAT,PRC_HICP_MIDX,1.0', { type: 'application/vnd.sdmx.data+csv', body: sdmxCsv(['2026-06', '2026-07', '2026-08', '2026-09']) });
    await send(a, 'post', `/api/knowledge/sources/${sourceId}/sync`).expect(202);
    await drain(h);
    const manual = ((await a.agent.get('/api/imports?kind=dataset').expect(200)).body.imports as { state: string; note: string; result: { knowledge: Record<string, unknown> } }[])[0]!;
    expect(manual).toMatchObject({ state: 'complete', result: { knowledge: { unchanged: 2, changed: 0 } } });
    // A dataset source is not added through the Knowledge API, where its licence would go unrecorded.
    await send(a, 'post', `/api/knowledge/bases/${kbId}/sources`, { kind: 'dataset', location: 'x' }).expect(409);
  });

  it('B-3805: one document per row from a CSV download, cited by the mapped id column, on an existing base', async () => {
    const kb = (await send(a, 'post', '/api/knowledge/bases', { name: 'Banks', label: 'internal', embedModel: 'nomic-embed-text' }).expect(201)).body;
    const body = { repositoryId: ckanId, item: 'failed-banks', target: 'knowledge', label: 'internal', knowledge: { knowledgeBaseId: kb.id, titleColumn: 'Bank Name', textColumns: ['Bank Name', 'City', 'Acquiring Institution'], metadataColumns: ['Cert', 'Closing Date'], idColumn: 'Cert', refresh: 'publisher' } };
    const imp = await imported(a, body);
    // The portal states the frequency (R/P1M), so there is a schedule to follow.
    expect(imp.result.knowledge).toMatchObject({ createdBase: false, documents: 12, added: 12, cadence: 'monthly' });
    const hits = (await send(a, 'post', '/api/knowledge/search', { kbIds: [kb.id], query: 'Bank 3 Tulsa Acquirer', rerank: false }).expect(200)).body.hits as { document: string; text: string }[];
    const hit = hits.find((x) => x.document === 'Bank 3, N.A. (row 28002)')!;
    expect(hit.text).toContain('Acquiring Institution: Acquirer "3"');
    expect(hit.text).toContain('Row 28002 of Failed Bank List (data.gov (fake)), banklist.csv');
    // A knowledge curator does the same on a base of their own; cancelling a queued import removes its empty source.
    const own = (await send(curator, 'post', '/api/knowledge/bases', { name: 'Curator banks', label: 'internal', embedModel: 'nomic-embed-text' }).expect(201)).body;
    const queued = await send(curator, 'post', '/api/imports/datasets', { ...body, knowledge: { ...body.knowledge, knowledgeBaseId: own.id } }).expect(201);
    expect((await curator.agent.get(`/api/knowledge/bases/${own.id}`).expect(200)).body.sources).toHaveLength(1);
    await send(curator, 'post', `/api/imports/${queued.body.id}/cancel`).expect(200);
    expect((await curator.agent.get(`/api/knowledge/bases/${own.id}`).expect(200)).body.sources).toHaveLength(0);
    await drain(h);
  });

  it('B-3806: an imported eval set shows precision and recall per label, with minimum-sample warnings', async () => {
    const body = { repositoryId: hubId, item: 'acme/intents', target: 'classifiers', label: 'internal', classifier: { name: 'Banking intent', textColumn: 'text', labelColumn: 'label' } };
    const imp = await imported(a, body);
    expect(imp).toMatchObject({ state: 'complete', target: 'classifiers' });
    const c = imp.result.classifier;
    // Both published splits, 170 samples a label: below the 200 a classifier publishes with.
    expect(c).toMatchObject({ name: 'Banking intent', slug: 'banking-intent', engine: 'linear', created: true, evalSet: 'banking-intent-eval', cases: 510, skipped: 0, minimum: 200, counts: { card_arrival: 170, refund: 170, top_up: 170 } });
    expect(c.short).toEqual([{ label: 'card_arrival', samples: 170 }, { label: 'refund', samples: 170 }, { label: 'top_up', samples: 170 }]);
    expect(imp.log.map((l: { title: string }) => l.title)).toContain('Labels below the minimum');
    expect(imp.manifest.scrub).toMatchObject({ masked: 1, byKind: { email: 1 } });
    // The head was trained and measured by the job the import queued: the Classifiers screen has its numbers.
    const cls = (await a.agent.get(`/api/admin/classifiers/${c.id}`).expect(200)).body;
    expect(cls).toMatchObject({ status: 'draft', dataset: 'banking-intent-eval', samples: { card_arrival: 170, refund: 170, top_up: 170 } });
    expect(cls.metrics.heldOut).toBe(true);
    for (const l of ['card_arrival', 'refund', 'top_up']) {
      expect(cls.metrics.perLabel[l].n).toBeGreaterThan(0);
      expect(cls.metrics.perLabel[l].precision).toBeGreaterThanOrEqual(0);
      expect(cls.metrics.perLabel[l].recall).toBeGreaterThanOrEqual(0);
    }
    // The stored case is the scrubbed text.
    const stored = (await h.s.db('eval_cases').where({ tenant_id: h.tenantId, eval_set: 'banking-intent-eval', expected: 'card_arrival' })) as { id: string; text: string }[];
    const texts = await Promise.all(stored.map((x) => h.s.keys.open(h.tenantId, x.text, `eval:${x.id}`)));
    expect(texts).toContain('My card has not arrived, mail me at [EMAIL]');
    expect(texts.join(' ')).not.toContain('sam@example.com');
    // Adding to the existing classifier with a lower minimum raises no warning; replacing starts the set again.
    const more = await imported(a, { ...body, splits: ['test'], classifier: { classifierId: c.id, textColumn: 'text', labelColumn: 'label', minPerLabel: 50, evaluate: false } });
    expect(more.result.classifier).toMatchObject({ created: false, cases: 60, short: [], counts: { refund: 190 }, jobId: null });
    const replaced = await imported(a, { ...body, splits: ['test'], classifier: { classifierId: c.id, textColumn: 'text', labelColumn: 'label', mode: 'replace', evaluate: false } });
    expect(replaced.result.classifier).toMatchObject({ replaced: 570, cases: 60, counts: { refund: 20 } });
    // A label column with too many values cannot define a classifier; a taken name is refused at the plan.
    const many = await send(a, 'post', '/api/imports/datasets', { ...body, classifier: { name: 'Texts', textColumn: 'label', labelColumn: 'text' } }).expect(201);
    await drain(h);
    expect((await a.agent.get(`/api/imports/${many.body.id}`).expect(200)).body).toMatchObject({ state: 'refused', error: expect.stringMatching(/at most 20 labels/) });
    const taken = await send(a, 'post', '/api/imports/datasets', body).expect(422);
    expect(taken.body.detail).toMatch(/A classifier named banking-intent exists/);
    await send(curator, 'post', '/api/imports/datasets', body).expect(403);
  });

  it('stores a dataset sealed with its hash, reads a Socrata resource page by page, and ends its retention', async () => {
    ckan.calls.length = 0;
    const imp = await imported(a, { repositoryId: ckanId, item: 'ev-population', target: 'store', label: 'internal', dropColumns: ['county'], store: { name: 'ev-raw', retentionDays: 30 } });
    expect(imp).toMatchObject({ state: 'complete', target: 'store', result: { store: { name: 'ev-raw', rows: 1200 } }, manifest: { scrub: null, rows: { fetched: 1200, droppedColumns: ['county'] } } });
    expect(ckan.calls.filter((c) => c.startsWith('/resource/f6w7-q2d2.json') && c.includes('limit=1000')).map((c) => /offset=(\d+)/.exec(c)![1])).toEqual(['0', '1000']);
    const rows = (await a.agent.get(`/api/imports/${imp.id}/rows`).expect(200)).text.trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1200);
    expect(rows[0]).toEqual({ make: 'NISSAN', model: 'LEAF', electric_range: '150' });
    // The blob is sealed, not the rows as they came.
    expect((await h.s.blobs.get(imp.result.store.key))!.toString()).not.toContain('NISSAN');
    expect(await h.s.imports.datasets.refreshDue(h.tenantId)).toMatchObject({ purged: 0 });
    const r = JSON.parse(String((await h.s.db('import_jobs').where({ id: imp.id }).first('result')).result));
    r.store.retainUntil = Date.now() - 1000;
    await h.s.db('import_jobs').where({ id: imp.id }).update({ result: JSON.stringify(r) });
    expect(await h.s.imports.datasets.refreshDue(h.tenantId)).toMatchObject({ purged: 1 });
    await a.agent.get(`/api/imports/${imp.id}/rows`).expect(410);
    expect((await a.agent.get(`/api/imports/${imp.id}`).expect(200)).body).toMatchObject({ storedBytes: 0, manifest: { hash: imp.manifest.hash } });
    // A resource that cannot be read is refused by name; a retry of a refused import changes nothing.
    const shp = await send(a, 'post', '/api/imports/datasets', { repositoryId: ckanId, item: 'ev-population', resources: ['ev-shp'], target: 'store', label: 'internal', store: { name: 'ev-shp' } }).expect(422);
    expect(shp.body.detail).toMatch(/shp files are not read/);
    await send(a, 'post', `/api/imports/${shp.body.import.id}/retry`).expect(409);
  });
});
