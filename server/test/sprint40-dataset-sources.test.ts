import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anyRecords, xmlRows, zipRecords, type PartRecord } from '../src/imports/containers.js';
import { parquetRecords } from '../src/imports/parquet.js';
import { fileKind } from '../src/imports/tabular.js';
import { serialDate, xlsxRecords } from '../src/imports/xlsx.js';
import { MAX_ENTRIES, zipBytes, zipEntries } from '../src/imports/zip.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';
import { drain } from './retrieval-seed.js';
import { startFakeCkan, startFakeHub, xlsxOf, zipOf, type FakeCkan, type FakeHub } from './sprint30-imports-fakes.js';
import { startFakeEstat, startFakeKaggle, startFakeOgd, type FakeEstat, type FakeKaggle, type FakeOgd } from './sprint40-sources-fakes.js';

/**
 * Sprint 40 (1.7.0), B-3804, the sources and formats added after the first fetch steps: zip archives with their
 * limits, xlsx workbooks, Parquet and XML; a gated dataset read from the hub with the token; Kaggle, e-Stat and the
 * OGD platform. Every source is a local fake; the Parquet files are fixtures written with pyarrow.
 */

const fixture = (name: string) => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/imports', name));
const send = (c: Client, method: 'post' | 'patch' | 'put' | 'delete', url: string, body: unknown = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body as object);
const all = async <T>(it: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};
const bytes = async function* (...parts: Buffer[]) {
  for (const p of parts) yield p;
};
const room = () => ({ used: 0, max: 64 * 1024 * 1024 });
const LIMITS = { archiveBytes: 8 * 1024 * 1024, unpackedBytes: 16 * 1024 * 1024 };
/** The offset of the nth member's entry in an archive's central directory. */
const centralAt = (zip: Buffer, n: number): number => {
  let p = zip.readUInt32LE(zip.length - 22 + 16);
  for (let i = 0; i < n; i++) p += 46 + zip.readUInt16LE(p + 28) + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  return p;
};
const patched = (zip: Buffer, fn: (b: Buffer) => void): Buffer => {
  const b = Buffer.from(zip);
  fn(b);
  return b;
};

describe('archives, workbooks, Parquet and XML as rows (B-3804)', () => {
  const csv = 'bank,city\nFirst,Austin\nSecond,Tulsa\n';

  it('names the new kinds, and reads the members of an archive in its order', async () => {
    expect(fileKind('ZIP', 'https://x.example/data.zip')).toEqual({ kind: 'zip', gzip: false });
    expect(fileKind(null, 'table.XML.gz')).toEqual({ kind: 'xml', gzip: true });
    expect(fileKind('CSV', 'packed.zip')).toEqual({ kind: 'zip', gzip: false });
    const zip = zipOf([{ name: 'README.txt', data: 'not a table' }, { name: 'data/banks.csv', data: csv }, { name: 'data/more.jsonl', data: '{"bank":"Third","city":"Reno"}\n', store: true }, { name: '__MACOSX/._banks.csv', data: 'x' }, { name: 'data/', data: '' }]);
    expect(zipEntries(zip).map((e) => e.name)).toEqual(['README.txt', 'data/banks.csv', 'data/more.jsonl', '__MACOSX/._banks.csv', 'data/']);
    const rows = await all(zipRecords(zip, { unpack: room() }));
    // The note beside the data and the Finder's shadow file are not tables.
    expect(rows).toEqual([
      { values: { bank: 'First', city: 'Austin' }, part: 'data/banks.csv' },
      { values: { bank: 'Second', city: 'Tulsa' }, part: 'data/banks.csv' },
      { values: { bank: 'Third', city: 'Reno' }, part: 'data/more.jsonl' }
    ]);
    // Through the one entry: a zip resource, and a CSV resource that turns out to be served packed.
    expect(await all(anyRecords(bytes(zip.subarray(0, 50), zip.subarray(50)), 'zip', { maxBytes: 1e9, limits: LIMITS }))).toHaveLength(3);
    const sniffed = await all(anyRecords(bytes(zip.subarray(0, 2), zip.subarray(2)), 'csv', { maxBytes: 1e9, limits: LIMITS }));
    expect(sniffed.map((r: PartRecord) => r.part)).toEqual(['data/banks.csv', 'data/banks.csv']);
    expect(await all(anyRecords(bytes(Buffer.from(csv)), 'csv', { maxBytes: 1e9, limits: LIMITS }))).toEqual([{ values: { bank: 'First', city: 'Austin' }, part: null }, { values: { bank: 'Second', city: 'Tulsa' }, part: null }]);
  });

  it('bounds what an archive may do: size, count, overlap, lies about size, and what it will not open', async () => {
    const zeros = zipOf([{ name: 'zeros.csv', data: Buffer.alloc(5 * 1024 * 1024, 0x30) }]);
    expect(zeros.length).toBeLessThan(20_000);
    // Five megabytes from a few kilobytes: refused before a byte is unpacked when the allowance is smaller.
    await expect(all(zipRecords(zeros, { unpack: { used: 0, max: 1024 * 1024 } }))).rejects.toThrow(/unpacks to more than the 1,048,576 bytes/);
    await expect(all(anyRecords(bytes(zeros), 'zip', { maxBytes: 1e9, limits: { archiveBytes: 1e9, unpackedBytes: 1024 * 1024 } }))).rejects.toThrow(/IMPORT_ARCHIVE_MAX_UNPACKED_BYTES/);
    // The archive itself is held in memory, so it has a cap of its own, and the import's budget still applies.
    await expect(all(anyRecords(bytes(zeros), 'zip', { maxBytes: 1e9, limits: { archiveBytes: 1000, unpackedBytes: 1e9 } }))).rejects.toThrow(/read whole, and this one is larger than 1,000 bytes \(IMPORT_ARCHIVE_MAX_BYTES\)/);
    await expect(all(anyRecords(bytes(zeros), 'zip', { maxBytes: 500, limits: LIMITS }))).rejects.toThrow(/larger than the 500 bytes this import may fetch/);
    // A header that states a smaller size than the member unpacks to.
    const liar = patched(zeros, (b) => b.writeUInt32LE(100, centralAt(b, 0) + 24));
    await expect(all(zipRecords(liar, { unpack: room() }))).rejects.toThrow(/unpacks to more than the 100 bytes its header states/);
    const two = zipOf([{ name: 'a.csv', data: csv }, { name: 'b.csv', data: csv }]);
    // Two members that share one block of data (the trick behind an archive that unpacks to many times its size).
    expect(() => zipEntries(patched(two, (b) => b.writeUInt32LE(0, centralAt(b, 1) + 42)))).toThrow(/overlap/);
    expect((await zipBytes(two, zipEntries(two)[1]!, room())).toString()).toBe(csv);
    const badCrc = patched(two, (b) => b.writeUInt32LE(7, centralAt(b, 0) + 16));
    await expect(all(zipRecords(badCrc, { unpack: room() }))).rejects.toThrow(/does not match its checksum/);
    const locked = patched(two, (b) => b.writeUInt16LE(b.readUInt16LE(centralAt(b, 0) + 8) | 1, centralAt(b, 0) + 8));
    await expect(all(zipRecords(locked, { unpack: room() }))).rejects.toThrow(/encrypted/);
    const lzma = patched(two, (b) => b.writeUInt16LE(14, centralAt(b, 0) + 10));
    await expect(all(zipRecords(lzma, { unpack: room() }))).rejects.toThrow(/method this import does not read \(14\)/);
    expect(() => zipEntries(patched(two, (b) => (b.writeUInt16LE(0xffff, b.length - 22 + 8), b.writeUInt16LE(0xffff, b.length - 22 + 10))))).toThrow(/Zip64/);
    expect(() => zipEntries(zipOf(Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => ({ name: `f${i}.csv`, data: '', store: true }))))).toThrow(/at most 2,000 are read/);
    expect(() => zipEntries(Buffer.from('PK\u0003\u0004 not an archive at all'))).toThrow(/not a zip archive/);
    // Names that are not plain relative names are not members at all; an archive in the archive is not opened.
    const tricky = zipOf([{ name: '../../etc/cron.d/x.csv', data: csv }, { name: '/abs.csv', data: csv }, { name: 'C:\\x.csv', data: csv }, { name: 'inner.zip', data: two }, { name: 'packed.csv.gz', data: gzipSync(csv) }]);
    expect(zipEntries(tricky).map((e) => e.name)).toEqual(['inner.zip', 'packed.csv.gz']);
    await expect(all(zipRecords(tricky, { unpack: room() }))).rejects.toThrow(/holds no file this import reads \(it holds inner\.zip, packed\.csv\.gz\).*an archive inside an archive is not/);
  });

  it('reads a workbook: the first visible sheet, shared strings, numbers, booleans and dates', async () => {
    const book = xlsxOf({ Notes: [['About this file']], Vehicles: [['Make', 'Count', 'Registered', 'Plug-in', 'Make'], ['NISSAN', 101, new Date(Date.UTC(2026, 0, 5)), true, 'x'], ['TESLA & Co <1>', 7.5, new Date(Date.UTC(2026, 1, 28, 6, 30)), false, null], [null, null, null, null, null], ['RIVIAN', null, null, null, 'z']] }, { hidden: ['Notes'] });
    const rows = await all(xlsxRecords(book, { unpack: room() }));
    expect(rows).toEqual([
      { Make: 'NISSAN', Count: 101, Registered: '2026-01-05', 'Plug-in': true, Make_2: 'x' },
      { Make: 'TESLA & Co <1>', Count: 7.5, Registered: '2026-02-28T06:30:00', 'Plug-in': false, Make_2: null },
      { Make: 'RIVIAN', Count: null, Registered: null, 'Plug-in': null, Make_2: 'z' }
    ]);
    expect(await all(xlsxRecords(book, { unpack: room(), sheet: 'Notes' }))).toEqual([]);
    await expect(all(xlsxRecords(book, { unpack: room(), sheet: 'Nope' }))).rejects.toThrow(/no worksheet named Nope\. It has Notes, Vehicles/);
    await expect(all(xlsxRecords(zipOf([{ name: 'a.csv', data: csv }]), { unpack: room() }))).rejects.toThrow(/not an xlsx workbook/);
    expect(serialDate(1, false)).toBe('1899-12-31');
    expect(serialDate(0, true)).toBe('1904-01-01');
    // Inline strings and cells without a reference, as some writers produce them.
    const inline = zipOf([
      { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>' },
      { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData><row><c t="inlineStr"><is><t>a</t></is></c><c t="inlineStr"><is><r><t>b</t></r><r><t>c</t></r></is></c></row><row><c><v>1</v></c><c t="str"><v>x &amp; y</v></c></row><row/></sheetData></worksheet>' }
    ]);
    expect(await all(xlsxRecords(inline, { unpack: room() }))).toEqual([{ a: 1, bc: 'x & y' }]);
    // A workbook announced as an archive, and a workbook inside one.
    expect(await all(zipRecords(book, { unpack: room() }))).toHaveLength(3);
    expect((await all(zipRecords(zipOf([{ name: 'ev.xlsx', data: book, store: true }]), { unpack: room() }))).map((r) => r.part)).toEqual(['ev.xlsx', 'ev.xlsx', 'ev.xlsx']);
  });

  it('reads Parquet: row groups, Snappy, Zstandard and gzip pages, values as JSON can hold them', async () => {
    const rows = await all(parquetRecords(fixture('readings.snappy.parquet'), { unpack: room() }));
    expect(rows).toHaveLength(250);
    expect(rows[0]).toEqual({ id: 1, station: 'Oslo', reading: 10, valid: true, taken: '2026-09-01T00:00:00.000Z', big: '9007199254740993', tags: [], note: 'note 0' });
    expect(rows[4]).toMatchObject({ id: 5, reading: null, big: 4 });
    expect(rows[249]).toMatchObject({ id: 250, station: 'Oslo', tags: ['a', 'b'] });
    for (const name of ['readings.zstd.parquet', 'readings.gzip.parquet']) {
      const some = await all(parquetRecords(fixture(name), { unpack: room() }));
      expect(some).toHaveLength(20);
      expect(some[7]).toMatchObject({ id: 8, station: 'Bergen', note: 'write to kari@example.org' });
    }
    // The footer says what a row group unpacks to: past the allowance, nothing of it is read.
    await expect(all(parquetRecords(fixture('readings.snappy.parquet'), { unpack: { used: 0, max: 2000 } }))).rejects.toThrow(/unpacks to more than the 2,000 bytes/);
    await expect(all(parquetRecords(Buffer.from('PAR1 nothing more'), { unpack: room() }))).rejects.toThrow(/not a readable Parquet file/);
    // A reader that stops early (a sample) reads only the first row group.
    const first: unknown[] = [];
    const used = room();
    for await (const r of parquetRecords(fixture('readings.snappy.parquet'), { unpack: used })) {
      first.push(r);
      if (first.length === 10) break;
    }
    const whole = room();
    await all(parquetRecords(fixture('readings.snappy.parquet'), { unpack: whole }));
    expect(used.used).toBeLessThan(whole.used);
    expect(await all(anyRecords(bytes(fixture('readings.zstd.parquet')), 'parquet', { maxBytes: 1e9, limits: LIMITS }))).toHaveLength(20);
  });

  it('reads XML where an element repeats, and refuses a document type', async () => {
    const socrata = '<?xml version="1.0"?><response><row><row _id="row-1" _uuid="u1"><make>NISSAN</make><model>LEAF</model><range unit="mi">150</range></row><row _id="row-2"><make>TESLA</make><model>MODEL 3</model><owner><name>A</name><name>B</name></owner></row></row></response>';
    expect(xmlRows(socrata)).toEqual([
      { '@_id': 'row-1', '@_uuid': 'u1', make: 'NISSAN', model: 'LEAF', range: { '@unit': 'mi', value: '150' } },
      { '@_id': 'row-2', make: 'TESLA', model: 'MODEL 3', owner: { name: ['A', 'B'] } }
    ]);
    expect(xmlRows('<data><info><source>x</source></info><record><a>1</a></record><record><a>2</a></record></data>')).toEqual([{ a: '1' }, { a: '2' }]);
    expect(() => xmlRows('<catalog><title>One thing</title></catalog>')).toThrow(/no repeated element/);
    // No document type, so no entities to expand and nothing to fetch.
    expect(() => xmlRows('<!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><d><r>&x;</r><r>2</r></d>')).toThrow(/not XML this import reads/);
    expect(await all(anyRecords(bytes(gzipSync('<d><r><a>1</a></r><r><a>2</a></r></d>')), 'xml', { maxBytes: 1e9, gzip: true, limits: LIMITS }))).toEqual([{ values: { a: '1' }, part: null }, { values: { a: '2' }, part: null }]);
  });
});

describe('Sprint 40: datasets from archives, a gated hub dataset, Kaggle, e-Stat and the OGD platform', () => {
  let h: Harness;
  let hub: FakeHub;
  let ckan: FakeCkan;
  let kaggle: FakeKaggle;
  let estat: FakeEstat;
  let ogd: FakeOgd;
  let a: Client;
  let b: Client;
  let hubId: string;
  let ckanId: string;
  let kaggleId: string;
  let estatId: string;
  let ogdId: string;

  const confirmed = async (body: object) => {
    const p = await send(a, 'post', '/api/imports/repositories', body);
    if (p.status !== 201) throw new Error(JSON.stringify(p.body));
    await send(b, 'post', `/api/imports/repositories/${p.body.id}/confirm`, {}).expect(200);
    await drain(h);
    return p.body.id as string;
  };
  const imported = async (body: object) => {
    const res = await send(a, 'post', '/api/imports/datasets', body);
    if (res.status !== 201) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
    await drain(h);
    return (await a.agent.get(`/api/imports/${res.body.id}`).expect(200)).body;
  };
  const stored = async (id: string) => (await a.agent.get(`/api/imports/${id}/rows`).expect(200)).text.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

  beforeAll(async () => {
    [hub, ckan, kaggle, estat, ogd] = await Promise.all([startFakeHub(), startFakeCkan(), startFakeKaggle(), startFakeEstat(), startFakeOgd()]);
    h = await harness({ IMPORT_ALLOWED_HOSTS: '127.0.0.1', IMPORT_HARVEST_TICK_MINUTES: '0', IMPORT_BUNDLE_POLL_MINUTES: '0', IMPORT_REFRESH_TICK_MINUTES: '0', IMPORT_DATASET_MAX_ROWS: '30000', IMPORT_PREVIEW_ROWS: '300' });
    const aId = (await localUser(h, 'srca', ['model-admin', 'ml-admin', 'tenant-admin'], 'restricted')).id;
    await localUser(h, 'srcb', ['model-admin'], 'restricted');
    [a, b] = [await loginAdmin(h, 'srca'), await loginAdmin(h, 'srcb')];
    await send(a, 'post', '/api/vault/policies', { subjectKind: 'user', subject: aId, path: '*', capabilities: ['*'] }).expect(201);

    hub.viewer.set('acme/gated-readings', { licence: 'mit', gated: true, configs: {} });
    hub.parquet.set('acme/gated-readings', { default: { train: [fixture('readings.zstd.parquet'), fixture('readings.gzip.parquet')], test: [fixture('readings.snappy.parquet')] } });
    kaggle.datasets.set('northwind/branches', { title: 'Branch ledger', licenceName: 'CC0: Public Domain', version: 3, files: new Map<string, string | Buffer>([['branches.csv', 'branch,city,deposits\n' + Array.from({ length: 40 }, (_, i) => `B${i + 1},${['Oslo', 'Bergen'][i % 2]},${1000 + i}`).join('\n') + '\n'], ['notes/readme.txt', 'Branches of Northwind.'], ['staff.json', JSON.stringify(Array.from({ length: 5 }, (_, i) => ({ branch: `B${i + 1}`, staff: 3 + i })))]]) });
    kaggle.packed.add('branches.csv');
    const areas: [string, string][] = [['13000', 'Tokyo'], ['27000', 'Osaka']];
    const months: [string, string][] = Array.from({ length: 30 }, (_, i) => [`2024${String((i % 12) + 1).padStart(2, '0')}${String(Math.floor(i / 12)).padStart(2, '0')}`, `month ${i + 1}`]);
    estat.tables.set('0003143513', { title: 'Consumer price index by area', survey: 'Consumer Price Index', org: 'Ministry of Internal Affairs and Communications', cycle: 'Monthly', updated: '2026-09-19', category: 'Prices', classes: [{ id: 'tab', name: 'Tabulated variable', items: [['1', 'Index']] }, { id: 'area', name: 'Area', items: areas }, { id: 'time', name: 'Time', items: months }], values: areas.flatMap(([area], g) => months.map(([time], i) => ({ '@tab': '1', '@area': area, '@time': time, '@unit': 'index', $: i === 3 && g === 0 ? '-' : (100 + g + i * 0.1).toFixed(1) }))) });
    estat.tables.set('0003999999', { title: 'Labour force by age', survey: 'Labour Force Survey', org: 'Statistics Bureau', cycle: '年次', updated: '2026-02-01', category: 'Labour', classes: [], values: [] });
    ogd.resources.set('9ef84268-d588-465a-a308-a864a43d0070', { title: 'Daily mandi prices of commodities', desc: 'Current daily prices from markets', org: ['Ministry of Agriculture and Farmers Welfare'], sector: ['Agriculture'], updated: 1_757_000_000, records: Array.from({ length: 2300 }, (_, i) => ({ state: ['Kerala', 'Punjab'][i % 2], market: `Market ${i % 40}`, commodity: ['Rice', 'Wheat', 'Onion'][i % 3], modal_price: String(1800 + (i % 500)) })) });

    hubId = await confirmed({ name: 'Hub (fake)', type: 'hf', baseUrl: hub.url, region: 'Global', kinds: ['model', 'dataset'], extraHosts: [], credential: hub.token });
    ckanId = await confirmed({ name: 'data.gov (fake)', type: 'ckan', baseUrl: `${ckan.url}/api/3`, region: 'US' });
    kaggleId = await confirmed({ name: 'Kaggle (fake)', type: 'kaggle', baseUrl: kaggle.url, region: 'Global', extraHosts: [], credential: kaggle.credential });
    estatId = await confirmed({ name: 'e-Stat (fake)', type: 'estat', baseUrl: `${estat.url}/rest/3.0/app`, region: 'JP', credential: estat.appId, options: { licence: 'cc-by-4.0' } });
    ogdId = await confirmed({ name: 'data.gov.in (fake)', type: 'ogd', baseUrl: ogd.url, region: 'IN', credential: ogd.key, options: { licence: 'cc-by-4.0', updates: 'daily' } });
  }, 180_000);

  afterAll(async () => {
    await h.close();
    await Promise.all([hub.close(), ckan.close(), kaggle.close(), estat.close(), ogd.close()]);
  });

  it('says what the new types are, and that Kaggle, e-Stat and the OGD platform need a credential', async () => {
    const types = (await a.agent.get('/api/imports/types').expect(200)).body as { type: string; datasetImport: boolean; credentialRequired: boolean; defaultHosts: string[] }[];
    const by = Object.fromEntries(types.map((t) => [t.type, t]));
    expect(by.kaggle).toMatchObject({ datasetImport: true, credentialRequired: true, defaultHosts: ['storage.googleapis.com'] });
    expect(by.estat).toMatchObject({ datasetImport: true, credentialRequired: true, kinds: ['dataset'] });
    expect(by.ogd).toMatchObject({ datasetImport: true, credentialRequired: true });
    const repos = (await a.agent.get('/api/imports/repositories').expect(200)).body as { id: string; credential: { recorded: boolean; ref: string } }[];
    // Recorded in the vault; the list shows the reference, never the value.
    expect(JSON.stringify(repos)).not.toContain(estat.appId);
    expect(JSON.stringify(repos)).not.toContain(ogd.key);
    expect(repos.find((r) => r.id === estatId)!.credential).toMatchObject({ recorded: true });
  });

  it('CKAN: a workbook and a zip archive are resources that can be read; an unknown format still is not', async () => {
    const ev = (await a.agent.get(`/api/imports/repositories/${ckanId}/dataset?id=ev-population`).expect(200)).body;
    expect(ev.resources.map((r: { id: string; access: string; format: string }) => [r.id, r.access, r.format])).toEqual([['ev-xlsx', 'file', 'xlsx'], ['ev-api', 'socrata', 'api'], ['ev-shp', 'unsupported', 'shp']]);
    const pv = (await send(a, 'post', '/api/imports/datasets/preview', { repositoryId: ckanId, item: 'ev-population', resources: ['ev-xlsx'] }).expect(200)).body;
    expect(pv.rows).toBe(60);
    expect(Object.fromEntries(pv.columns.map((c: { name: string; type: string }) => [c.name, c.type]))).toMatchObject({ Make: 'class (NISSAN, TESLA)', Registered: 'date', Count: 'int', 'Plug-in': 'bool' });
    const book = await imported({ repositoryId: ckanId, item: 'ev-population', resources: ['ev-xlsx'], target: 'store', label: 'internal', store: { name: 'ev-workbook' } });
    expect(book).toMatchObject({ state: 'complete', result: { store: { rows: 60 } } });
    expect((await stored(book.id))[1]).toEqual({ Make: 'TESLA', Model: 'MODEL 3', County: 'Pierce', Registered: '2026-01-02', Count: 101, 'Plug-in': false });
    // The packed list: the CSV in it is read, the note beside it is not; each row says which member it came from.
    const banks = await imported({ repositoryId: ckanId, item: 'failed-banks', resources: ['banks-zip'], target: 'store', label: 'internal', store: { name: 'banks-zip' } });
    expect(banks).toMatchObject({ state: 'complete', result: { store: { rows: 12 } } });
    expect((await stored(banks.id))[0]).toMatchObject({ 'Bank Name': 'Bank 1, N.A.', City: 'Chicago' });
    // Without a choice the plain CSV comes before the archive.
    const plan = (await send(a, 'post', '/api/imports/datasets/plan', { repositoryId: ckanId, item: 'failed-banks', target: 'store', label: 'internal', store: { name: 'banks' } }).expect(200)).body;
    expect(plan.selection.resources.map((r: { id: string }) => r.id)).toEqual(['banks-csv']);
    // An archive on a host the repository was not confirmed for is refused by the fetcher, as any file is.
    const away = await send(a, 'post', '/api/imports/datasets/preview', { repositoryId: ckanId, item: 'consumer-complaints', resources: ['cc-json'] });
    expect(away.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(away.body)).toMatch(/files\.example is not on the staging-proxy allow-list/);
  });

  it('an archive past IMPORT_ARCHIVE_MAX_UNPACKED_BYTES fails the import and keeps nothing', async () => {
    ckan.files.set('banklist.zip', zipOf([{ name: 'big.csv', data: Buffer.concat([Buffer.from('a\n'), Buffer.alloc(3 * 1024 * 1024, 0x31)]) }]));
    const cfg = h.s.cfg as { IMPORT_ARCHIVE_MAX_UNPACKED_BYTES: number };
    const before = cfg.IMPORT_ARCHIVE_MAX_UNPACKED_BYTES;
    cfg.IMPORT_ARCHIVE_MAX_UNPACKED_BYTES = 1024 * 1024;
    try {
      const res = await send(a, 'post', '/api/imports/datasets', { repositoryId: ckanId, item: 'failed-banks', resources: ['banks-zip'], target: 'store', label: 'internal', store: { name: 'banks-bomb' } });
      // The plan reads a preview first, so the request itself is refused; nothing is queued or stored.
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(res.body)).toMatch(/unpacks to more than the 1,048,576 bytes/);
    } finally {
      cfg.IMPORT_ARCHIVE_MAX_UNPACKED_BYTES = before;
    }
  });

  it('a gated hub dataset is read from the hub with the token once its terms are accepted, never from the viewer', async () => {
    const closed = (await a.agent.get(`/api/imports/repositories/${hubId}/dataset?id=acme/gated-readings`).expect(200)).body;
    expect(closed).toMatchObject({ gated: true, access: 'gated', splits: [] });
    const body = { repositoryId: hubId, item: 'acme/gated-readings', target: 'store', label: 'internal', store: { name: 'gated-readings' } };
    const plan = (await send(a, 'post', '/api/imports/datasets/plan', body).expect(200)).body;
    expect(plan.checks.find((c: { name: string }) => c.name === 'Access')).toMatchObject({ result: 'refused' });
    expect((await send(a, 'post', '/api/imports/datasets', body).expect(422)).body.reason).toContain('access');

    hub.accepted.add('acme/gated-readings');
    const open = (await a.agent.get(`/api/imports/repositories/${hubId}/dataset?id=acme/gated-readings`).expect(200)).body;
    expect(open).toMatchObject({ gated: true, access: 'granted', configurations: [{ id: 'default' }], splits: [{ config: 'default', id: 'train', rows: null }, { config: 'default', id: 'test', rows: null }] });
    const ok = (await send(a, 'post', '/api/imports/datasets/plan', { ...body, splits: ['train'] }).expect(200)).body;
    expect(ok.checks.find((c: { name: string }) => c.name === 'Access')).toMatchObject({ result: 'passed' });
    expect(ok.blocked).toBe(false);
    const imp = await imported({ ...body, splits: ['train'] });
    expect(imp).toMatchObject({ state: 'complete', result: { store: { rows: 40 } } });
    const rows = await stored(imp.id);
    expect(rows[7]).toMatchObject({ id: 8, station: 'Bergen', taken: '2026-09-01T07:00:00.000Z' });
    // Both files of the split, from the CDN, which the fake refuses when it is sent the credential.
    expect(hub.parquetDownloads.filter((d) => d.startsWith('acme/gated-readings/default/train/'))).toEqual(expect.arrayContaining(['acme/gated-readings/default/train/0', 'acme/gated-readings/default/train/1']));
    expect(hub.rowCalls.some((c) => c.dataset === 'acme/gated-readings')).toBe(false);
    // A sample stops within the first file.
    const sample = await imported({ ...body, splits: ['test'], sample: { rows: 15 }, store: { name: 'gated-sample' } });
    expect(sample).toMatchObject({ state: 'complete', result: { store: { rows: 15 } } });
  });

  it('Kaggle: files and the whole archive, downloaded through a redirect the credential does not follow', async () => {
    const d = (await a.agent.get(`/api/imports/repositories/${kaggleId}/dataset?id=northwind/branches`).expect(200)).body;
    expect(d).toMatchObject({ name: 'Branch ledger', licence: 'cc0-1.0', revision: 'version 3', publisher: 'northwind', gated: false });
    expect(d.resources.map((r: { id: string; access: string; format: string }) => [r.id, r.access, r.format])).toEqual([['branches.csv', 'file', 'csv'], ['notes/readme.txt', 'file', 'csv'], ['staff.json', 'file', 'json'], ['archive', 'file', 'zip']]);
    // The file is listed as CSV and served packed: read as the CSV it holds.
    const one = await imported({ repositoryId: kaggleId, item: 'northwind/branches', resources: ['branches.csv'], target: 'store', label: 'internal', store: { name: 'branches' } });
    expect(one).toMatchObject({ state: 'complete', result: { store: { rows: 40 } } });
    expect((await stored(one.id))[1]).toEqual({ branch: 'B2', city: 'Bergen', deposits: '1001' });
    // The whole dataset: every table in the archive, in its order (the note is left out).
    const whole = await imported({ repositoryId: kaggleId, item: 'northwind/branches', resources: ['archive'], target: 'store', label: 'internal', store: { name: 'branches-all' } });
    expect(whole).toMatchObject({ state: 'complete', result: { store: { rows: 45 } } });
    expect(kaggle.seen.filter((x) => x.path.startsWith('/storage/')).length).toBeGreaterThan(0);
    expect(kaggle.seen.every((x) => (x.path.startsWith('/storage/') ? !x.auth : x.auth))).toBe(true);
    await a.agent.get(`/api/imports/repositories/${kaggleId}/dataset?id=northwind/nope`).expect(404);
    await a.agent.get(`/api/imports/repositories/${kaggleId}/dataset?id=not-a-ref`).expect((r) => expect(r.status).toBeGreaterThanOrEqual(400));
  });

  it('e-Stat: harvested and searched, a table read page by page with its classes as columns, the id only in the query', async () => {
    await send(a, 'post', `/api/imports/repositories/${estatId}/harvest`, {}).expect((r) => expect(r.status).toBeLessThan(300));
    await drain(h);
    const list = (await a.agent.get(`/api/imports/repositories/${estatId}/catalog?kind=dataset`).expect(200)).body;
    expect(list.items.map((i: { itemId: string }) => i.itemId).sort()).toEqual(['0003143513', '0003999999']);
    const cpi = list.items.find((i: { itemId: string }) => i.itemId === '0003143513');
    expect(cpi).toMatchObject({ name: 'Consumer Price Index: Consumer price index by area', publisher: 'Ministry of Internal Affairs and Communications', classification: 'Prices', licence: 'cc-by-4.0' });
    const d = (await a.agent.get(`/api/imports/repositories/${estatId}/dataset?id=0003143513`).expect(200)).body;
    expect(d).toMatchObject({ rows: 60, updates: 'monthly', revision: '2026-09-19', resources: [{ id: 'data', access: 'estat', format: 'api' }] });
    // The address kept with the import has no key in it.
    expect(JSON.stringify(d)).not.toContain(estat.appId);
    expect((await a.agent.get(`/api/imports/repositories/${estatId}/dataset?id=0003999999`).expect(200)).body.updates).toBe('yearly');
    const imp = await imported({ repositoryId: estatId, item: '0003143513', target: 'store', label: 'internal', store: { name: 'cpi' } });
    expect(imp).toMatchObject({ state: 'complete', result: { store: { rows: 60 } } });
    const rows = await stored(imp.id);
    expect(rows[0]).toEqual({ tab_code: '1', 'Tabulated variable': 'Index', area_code: '13000', Area: 'Tokyo', time_code: '20240100', Time: 'month 1', unit: 'index', value: 100 });
    // A cell without a figure keeps what the table shows.
    expect(rows[3]!.value).toBe('-');
    expect(rows[59]).toMatchObject({ Area: 'Osaka', Time: 'month 30', value: 103.9 });
    expect(JSON.stringify(imp)).not.toContain(estat.appId);
    expect(estat.seen.every((x) => !x.header && x.query.includes(`appId=${estat.appId}`))).toBe(true);
    // A sample asks for no more than it needs.
    estat.seen.length = 0;
    const sample = await imported({ repositoryId: estatId, item: '0003143513', target: 'store', label: 'internal', sample: { rows: 7 }, store: { name: 'cpi-sample' } });
    expect(sample.result.store.rows).toBe(7);
    expect(estat.seen.filter((x) => x.path.endsWith('getStatsData')).at(-1)!.query).toContain('limit=7');
  });

  it('e-Stat pages by NEXT_KEY, and a refused application id is a credential problem that does not quote the id', async () => {
    const { estatRows } = await import('../src/imports/adapters/dataset-sources.js');
    const repo = await h.s.imports.repositories.get(h.tenantId, estatId);
    const ctx = h.s.imports.repositories.context(repo);
    const big = { title: 'Wide', survey: 'S', org: 'O', cycle: 'Monthly', updated: '2026-01-01', category: 'C', classes: [{ id: 'cat01', name: 'Item', items: [['a', 'A']] as [string, string][] }], values: Array.from({ length: 23_500 }, (_, i) => ({ '@cat01': 'a', '@time': String(i), $: String(i) })) };
    estat.tables.set('0001', big);
    estat.seen.length = 0;
    let n = 0;
    let spent = 0;
    for await (const r of estatRows(ctx, { id: 'data', name: 't', format: 'api', size: null, access: 'estat', url: `${estat.url}/rest/3.0/app/json/getStatsData?statsDataId=0001`, note: null }, { n: null }, (b) => (spent += b))) {
      if (n === 23_499) expect(r).toMatchObject({ id: 'a', values: { Item: 'A', time: '23499', value: 23_499 } });
      n++;
    }
    expect(n).toBe(23_500);
    expect(spent).toBeGreaterThan(500_000);
    expect(estat.seen.map((x) => [/startPosition=(\d+)/.exec(x.query)![1], /metaGetFlg=(\w)/.exec(x.query)![1]])).toEqual([['1', 'Y'], ['10001', 'N'], ['20001', 'N']]);
    const wrong = estat.appId;
    estat.appId = 'rotated';
    try {
      const res = await a.agent.get(`/api/imports/repositories/${estatId}/dataset?id=0003143513`);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(res.body)).toMatch(/refused the application id/);
      expect(JSON.stringify(res.body)).not.toContain(wrong);
    } finally {
      estat.appId = wrong;
    }
  });

  it('the OGD platform: harvested, a resource read page by page even when the platform caps the page, the key only in the query', async () => {
    await send(a, 'post', `/api/imports/repositories/${ogdId}/harvest`, {}).expect((r) => expect(r.status).toBeLessThan(300));
    await drain(h);
    const list = (await a.agent.get(`/api/imports/repositories/${ogdId}/catalog?kind=dataset`).expect(200)).body;
    expect(list.items[0]).toMatchObject({ itemId: '9ef84268-d588-465a-a308-a864a43d0070', name: 'Daily mandi prices of commodities', publisher: 'Ministry of Agriculture and Farmers Welfare', classification: 'Agriculture' });
    const d = (await a.agent.get(`/api/imports/repositories/${ogdId}/dataset?id=9ef84268-d588-465a-a308-a864a43d0070`).expect(200)).body;
    expect(d).toMatchObject({ rows: 2300, updates: 'daily', licence: 'cc-by-4.0', resources: [{ id: 'data', access: 'ogd', format: 'api' }] });
    expect(JSON.stringify(d)).not.toContain(ogd.key);
    ogd.seen.length = 0;
    // The key's own page limit is lower than what is asked for: the rows still all arrive.
    ogd.pageCap = 600;
    const imp = await imported({ repositoryId: ogdId, item: '9ef84268-d588-465a-a308-a864a43d0070', target: 'training', label: 'internal', training: { name: 'mandi-prices', promptColumn: 'commodity', completionColumn: 'modal_price' } });
    ogd.pageCap = 1000;
    expect(imp).toMatchObject({ state: 'complete', manifest: { rows: { fetched: 2300 } } });
    expect(imp.result.training.rows).toBeGreaterThan(0);
    const offsets = ogd.seen.filter((x) => x.path.startsWith('/resource/') && /limit=1000/.test(x.query)).map((x) => /offset=(\d+)/.exec(x.query)![1]);
    expect(offsets).toEqual(['0', '600', '1200', '1800']);
    expect(ogd.seen.every((x) => !x.header && x.query.includes(`api-key=${ogd.key}`))).toBe(true);
    expect(JSON.stringify(imp)).not.toContain(ogd.key);
    const key = ogd.key;
    ogd.key = 'rotated';
    try {
      const res = await a.agent.get(`/api/imports/repositories/${ogdId}/dataset?id=9ef84268-d588-465a-a308-a864a43d0070`);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(res.body)).not.toContain(key);
    } finally {
      ogd.key = key;
    }
  });
});
