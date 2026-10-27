import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runQuery, sheetTable, sourceKey, validateDefinition, jsonTable, type QTable, type QueryDefinition } from '../src/files/documents/query.js';
import { xlsToWorkbook, isXlsWorkbook } from '../src/files/documents/xls.js';
import { harness, localUser, login, type Harness } from './helpers.js';
import { compoundFile, workbookStream, xlsFile } from './xls-writer.js';

/*
 * Files, the table builder: the query engine's steps (query.ts), the Excel 97-2003 reader (xls.ts), and the API:
 * sources, previews with step errors, saved queries, loading into a new or existing file, refresh, and labels.
 */

const F = '01J0000000000000000000FILE';
const G = '01J0000000000000000000GGGG';
const src = (fileId = F) => ({ kind: 'file' as const, fileId, header: true });
const T = (columns: string[], rows: (string | number | boolean | null)[][]): QTable => ({ columns: columns.map((name) => ({ name, type: 'any' as const })), rows });

const sales = T(['Region', 'Rep', 'Amount', 'Date'], [
  ['North', 'Ann', '1,200', '2026-01-05'],
  ['South', 'Bob', '300', '05/02/2026'],
  ['North', 'Cy', 'n/a', '2026-03-01'],
  ['North', 'Ann', '50.5', '2026-03-09'],
  [null, 'Dee', '10', '2026-04-01']
]);

function run(steps: unknown[], tables: Map<string, QTable> = new Map([[sourceKey(src()), sales]])) {
  const def = validateDefinition({ source: src(), steps });
  return runQuery(def, tables);
}

describe('query engine', () => {
  it('changes types and reports what does not convert', () => {
    const r = run([{ op: 'change-type', columns: [{ column: 'Amount', type: 'number' }, { column: 'Date', type: 'date' }], dayFirst: true }]);
    expect(r.error).toBeNull();
    expect(r.table.rows.map((x) => x[2])).toEqual([1200, 300, null, 50.5, 10]);
    expect(r.table.rows[1]![3]).toBe('2026-02-05');
    expect(r.table.columns[2]!.type).toBe('number');
    expect(r.warnings[0]!.message).toMatch(/1 value in Amount could not be read as number/);
  });

  it('filters, sorts, groups and aggregates', () => {
    const r = run([
      { op: 'change-type', columns: [{ column: 'Amount', type: 'number' }] },
      { op: 'replace-empty', columns: ['Region'], value: 'Unknown' },
      { op: 'filter', conditions: [{ column: 'Amount', op: 'gte', value: 10 }] },
      { op: 'group', by: ['Region'], aggregates: [{ as: 'Total', fn: 'sum', column: 'Amount' }, { as: 'Deals', fn: 'count-rows' }, { as: 'Reps', fn: 'count-distinct', column: 'Rep' }] },
      { op: 'sort', keys: [{ column: 'Total', desc: true }] }
    ]);
    expect(r.error).toBeNull();
    expect(r.table.columns.map((c) => c.name)).toEqual(['Region', 'Total', 'Deals', 'Reps']);
    expect(r.table.rows).toEqual([['North', 1250.5, 2, 1], ['South', 300, 1, 1], ['Unknown', 10, 1, 1]]);
  });

  it('adds custom, conditional and index columns; formulas read [Column name]', () => {
    const t = T(['Unit price', 'Qty'], [[2.5, 4], [10, null], [1, 3]]);
    const r = run([
      { op: 'custom', as: 'Line total', formula: '[Unit price] * Qty' },
      { op: 'conditional', as: 'Size', rules: [{ column: 'Line total', op: 'gte', value: 10, then: 'large' }, { column: 'Line total', op: 'empty', then: 'unknown' }], otherwise: 'small' },
      { op: 'index', as: 'No', start: 1 }
    ], new Map([[sourceKey(src()), t]]));
    expect(r.error).toBeNull();
    expect(r.table.rows).toEqual([[2.5, 4, 10, 'large', 1], [10, null, null, 'unknown', 2], [1, 3, 3, 'small', 3]]);
    const bad = run([{ op: 'custom', as: 'X', formula: '[Nope] + 1' }], new Map([[sourceKey(src()), t]]));
    expect(bad.error).toMatchObject({ step: 0 });
    expect(bad.error!.message).toMatch(/no column Nope/);
  });

  it('stops at a failing step and keeps the table before it', () => {
    const r = run([{ op: 'remove-columns', columns: ['Date'] }, { op: 'rename', columns: [{ from: 'Date', to: 'When' }] }, { op: 'index' }]);
    expect(r.applied).toBe(1);
    expect(r.error).toMatchObject({ step: 1 });
    expect(r.table.columns.map((c) => c.name)).toEqual(['Region', 'Rep', 'Amount']);
    // Up to a step: the preview of a step chosen in Applied steps.
    expect(runQuery(validateDefinition({ source: src(), steps: [{ op: 'index' }, { op: 'transpose' }] }), new Map([[sourceKey(src()), sales]]), { upto: 1 }).table.columns.at(-1)!.name).toBe('Index');
  });

  it('splits, merges, fills, replaces and removes duplicates', () => {
    const t = T(['Name', 'Group'], [['Ann Lee', 'A'], ['Bob  Ray', null], ['Ann Lee', 'A'], ['Cy', 'B']]);
    const r = run([
      { op: 'fill', columns: ['Group'] },
      { op: 'distinct' },
      { op: 'split', column: 'Name', delimiter: ' ', mode: 'first', into: ['First', 'Last'] },
      { op: 'replace', columns: ['Last'], find: ' ', replace: '', match: 'contains' },
      { op: 'merge-columns', columns: ['Last', 'First'], separator: ', ', as: 'Sort name' }
    ], new Map([[sourceKey(src()), t]]));
    expect(r.error).toBeNull();
    expect(r.table.columns.map((c) => c.name)).toEqual(['Sort name', 'Group']);
    expect(r.table.rows).toEqual([['Lee, Ann', 'A'], ['Ray, Bob', 'A'], ['Cy', 'B']]);
  });

  it('pivots and unpivots', () => {
    const t = T(['Product', 'Month', 'Sales'], [['A', 'Jan', 1], ['A', 'Feb', 2], ['B', 'Jan', 5], ['A', 'Jan', 3]]);
    const tables = new Map([[sourceKey(src()), t]]);
    const p = run([{ op: 'pivot', column: 'Month', values: 'Sales', fn: 'sum' }], tables);
    expect(p.table.columns.map((c) => c.name)).toEqual(['Product', 'Jan', 'Feb']);
    expect(p.table.rows).toEqual([['A', 4, 2], ['B', 5, null]]);
    const u = run([{ op: 'pivot', column: 'Month', values: 'Sales', fn: 'sum' }, { op: 'unpivot', columns: ['Product'], others: true, attribute: 'Month', value: 'Sales' }], tables);
    expect(u.table.rows).toEqual([['A', 'Jan', 4], ['A', 'Feb', 2], ['B', 'Jan', 5]]);
  });

  it('appends and merges other tables', () => {
    const reps = T(['Rep', 'Team'], [['Ann', 'Red'], ['Bob', 'Blue'], ['Zed', 'Green']]);
    const more = T(['Rep', 'Region', 'Extra'], [['Eve', 'East', 'x']]);
    const repRef = { kind: 'file' as const, fileId: G, header: true };
    const moreRef = { kind: 'file' as const, fileId: G, sheet: 'More', header: true };
    const tables = new Map([[sourceKey(src()), sales], [sourceKey(repRef), reps], [sourceKey(moreRef), more]]);
    const a = run([{ op: 'append', sources: [moreRef] }], tables);
    expect(a.table.columns.map((c) => c.name)).toEqual(['Region', 'Rep', 'Amount', 'Date', 'Extra']);
    expect(a.table.rows.at(-1)).toEqual(['East', 'Eve', null, null, 'x']);
    const left = run([{ op: 'merge', source: repRef, left: ['Rep'], right: ['Rep'], kind: 'left', prefix: 'Rep.' }], tables);
    expect(left.table.columns.map((c) => c.name)).toEqual(['Region', 'Rep', 'Amount', 'Date', 'Rep.Team']);
    expect(left.table.rows.map((r) => r[4])).toEqual(['Red', 'Blue', null, 'Red', null]);
    const inner = run([{ op: 'merge', source: repRef, left: ['Rep'], right: ['Rep'], kind: 'inner' }], tables);
    expect(inner.table.rows).toHaveLength(3);
    expect(inner.warnings[0]!.message).toMatch(/2 rows had no match/);
    const full = run([{ op: 'merge', source: repRef, left: ['Rep'], right: ['Rep'], kind: 'full' }], tables);
    expect(full.table.rows.at(-1)).toEqual([null, 'Zed', null, null, 'Green']);
    const anti = run([{ op: 'merge', source: repRef, left: ['Rep'], right: ['Rep'], kind: 'right-anti' }], tables);
    expect(anti.table.rows).toEqual([['Zed', 'Green']]);
    const clash = run([{ op: 'merge', source: repRef, left: ['Rep'], right: ['Rep'], columns: ['Rep'] }], tables);
    expect(clash.error!.message).toMatch(/prefix/);
  });

  it('reads headers and JSON, and holds tables to the cell limit', () => {
    const t = sheetTable({ name: 'S', header: true, columns: [], rows: [[{ v: 'a' }, { v: 'a' }, { v: null }], [{ v: 1 }, { v: 2 }, { v: 3 }]] }, true);
    expect(t.columns.map((c) => c.name)).toEqual(['a', 'a (2)', 'Column3']);
    expect(t.columns[0]!.type).toBe('integer');
    const j = jsonTable(JSON.stringify({ items: [{ id: 1, tags: ['x'] }, { id: 2, name: 'b' }] }));
    expect(j.columns.map((c) => c.name)).toEqual(['id', 'tags', 'name']);
    expect(j.rows[0]).toEqual([1, '["x"]', null]);
    const wide = T(['k', 'n'], Array.from({ length: 800 }, (_, i) => ['x', i]));
    const big = run([{ op: 'merge', source: src(), left: ['k'], right: ['k'], prefix: 'r.' }], new Map([[sourceKey(src()), wide]]));
    expect(big.error!.message).toMatch(/more than 500,000 cells/);
    expect(() => validateDefinition({ source: src(), steps: [{ op: 'sort', keys: [] }] })).toThrow(/not valid at steps.0.keys/);
    expect(() => validateDefinition({ source: src(), steps: [{ op: 'eval', code: 'x' }] })).toThrow(/not valid/);
  });
});

describe('Excel 97-2003 reader', () => {
  const sheets = [
    { name: 'Sales', rows: [['Region', 'Amount', 'When', 'Ok', 'Calc', 'Label'], ['North', 1200, { date: 46027 }, true, { formula: 42.5 }, { formula: 'done' }], ['Süd', 0.25, { date: 46028.5 }, false, { error: 0x07 }, null]] },
    { name: 'Notes', hidden: true, rows: [['x'.repeat(9000)], ['日本語のテキスト']] }
  ];

  it('reads sheets, shared strings across CONTINUE records, numbers, dates, booleans and formula results', () => {
    const buf = xlsFile(sheets);
    expect(isXlsWorkbook(buf)).toBe(true);
    const { workbook, notes } = xlsToWorkbook(buf);
    expect(workbook.sheets.map((s) => s.name)).toEqual(['Sales', 'Notes']);
    const s = workbook.sheets[0]!;
    expect(s.header).toBe(true);
    expect(s.rows[1]!.map((c) => c.v)).toEqual(['North', 1200, '2026-01-05', true, 42.5, 'done']);
    expect(s.rows[2]!.slice(0, 5).map((c) => c.v)).toEqual(['Süd', 0.25, '2026-01-06T12:00:00', false, '#DIV/0!']);
    const n = workbook.sheets[1]!;
    expect(String(n.rows[0]![0]!.v)).toHaveLength(9000);
    expect(n.rows[1]![0]!.v).toBe('日本語のテキスト');
    expect(notes.join(' ')).toMatch(/hidden/);
    expect(notes.join(' ')).toMatch(/last calculated values/);
  });

  it('reads a small workbook from the mini stream', () => {
    const buf = xlsFile([{ name: 'S', rows: [['a', 'b'], [1, 2]] }]);
    expect(buf.length).toBeLessThan(4096);
    expect(xlsToWorkbook(buf).workbook.sheets[0]!.rows[1]!.map((c) => c.v)).toEqual([1, 2]);
  });

  it('refuses passwords, other Compound Files and damage', () => {
    expect(() => xlsToWorkbook(xlsFile([{ name: 'S', rows: [['a']] }], { password: true }))).toThrow(/password/);
    const word = compoundFile(Buffer.alloc(5000), { name: 'WordDocument' });
    expect(isXlsWorkbook(word)).toBe(false);
    expect(() => xlsToWorkbook(word)).toThrow(/no Workbook stream/);
    const cut = xlsFile(sheets).subarray(0, 1600);
    expect(() => xlsToWorkbook(cut)).toThrow();
    const loop = Buffer.from(xlsFile(sheets));
    loop.writeUInt32LE(2, 512 + 2 * 4); // the FAT points sector 2 back at itself
    expect(() => xlsToWorkbook(loop)).toThrow(/chain is broken|record/);
    expect(workbookStream([{ name: 'S', rows: [] }]).readUInt16LE(0)).toBe(0x0809);
  });
});

describe('Table builder API', () => {
  let h: Harness;
  let wsId: string;

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Data', 'confidential')).id;
  });
  afterEach(async () => {
    await h.close();
  });

  async function member(name: string, clearance: 'internal' | 'confidential' = 'confidential') {
    const u = await localUser(h, name, ['member'], clearance);
    await h.s.tenants.addMember(wsId, u.id);
    const c = await login(h, name);
    const send = (method: 'post' | 'put' | 'patch' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
    return {
      post: (p: string, b?: object) => send('post', p, b),
      patch: (p: string, b?: object) => send('patch', p, b),
      del: (p: string) => send('delete', p),
      get: (p: string) => c.agent.get(p),
      putContent: (id: string, data: Buffer | string) => c.agent.put(`/api/files/${id}/content`).set('x-csrf-token', c.csrf).set('content-type', 'application/octet-stream').send(Buffer.from(data)),
      upload: (name: string, data: Buffer | string, label = 'internal') => c.agent.put(`/api/files/uploads?${new URLSearchParams({ name, workspace: wsId, label }).toString()}`).set('x-csrf-token', c.csrf).set('content-type', 'application/octet-stream').send(Buffer.from(data))
    };
  }

  /** Scans the file's newest version now (the scan job does not run in tests) and gives the file. */
  async function ready(u: Awaited<ReturnType<typeof member>>, id: string) {
    const v = (await h.s.db('file_versions').where({ file_id: id }).orderBy('number', 'desc').first('id')) as { id: string };
    await h.s.files.scanNow(v.id);
    return (await u.get(`/api/files/${id}`).expect(200)).body;
  }

  it('previews, saves, loads into new and existing files, refreshes, and opens .xls files', async () => {
    const ann = await member('ann');
    const csv = (await ann.upload('sales.csv', 'Region,Rep,Amount\nNorth,Ann,"1,200"\nSouth,Bob,300\nNorth,Cy,n/a\n').expect(202)).body;
    await ready(ann, csv.id);
    const xls = (await ann.upload('reps.xls', xlsFile([{ name: 'Reps', rows: [['Rep', 'Team'], ['Ann', 'Red'], ['Bob', 'Blue']] }])).expect(202)).body;
    const xf = await ready(ann, xls.id);
    expect(xf.type).toBe('application/vnd.ms-excel');

    // The editor opens an .xls workbook and saves it as an .xlsx copy.
    const opened = (await ann.get(`/api/files/${xls.id}/document`).expect(200)).body;
    expect(opened.kind).toBe('xls');
    expect(opened.saveKind).toBe('xlsx');
    expect(opened.workbook.sheets[0].rows[1].map((c: { v: unknown }) => c.v)).toEqual(['Ann', 'Red']);
    const tables = (await ann.get(`/api/files/${xls.id}/tables`).expect(200)).body;
    expect(tables.sheets[0]).toMatchObject({ name: 'Reps', columns: ['Rep', 'Team'] });

    const definition: QueryDefinition = validateDefinition({
      source: { kind: 'file', fileId: csv.id },
      steps: [
        { op: 'change-type', columns: [{ column: 'Amount', type: 'number' }] },
        { op: 'merge', source: { kind: 'file', fileId: xls.id, sheet: 'Reps' }, left: ['Rep'], right: ['Rep'], kind: 'left', prefix: 'Rep ' },
        { op: 'sort', keys: [{ column: 'Amount', desc: true }] }
      ]
    });
    const prev = (await ann.post('/api/files/queries/preview', { definition }).expect(200)).body;
    expect(prev.error).toBeNull();
    expect(prev.rowCount).toBe(3);
    expect(prev.columns.map((c: { name: string }) => c.name)).toEqual(['Region', 'Rep', 'Amount', 'Rep Team']);
    expect(prev.rows[0]).toEqual(['North', 'Ann', 1200, 'Red']);
    expect(prev.warnings[0].message).toMatch(/Amount/);
    expect(prev.profile[2]).toMatchObject({ column: 'Amount', empty: 1 });
    const upto = (await ann.post('/api/files/queries/preview', { definition, upto: 1 }).expect(200)).body;
    expect(upto.columns).toHaveLength(3);
    const values = (await ann.post('/api/files/queries/values', { definition, column: 'Region' }).expect(200)).body;
    expect(values.values[0]).toEqual({ value: 'North', count: 2 });
    const detect = (await ann.post('/api/files/queries/detect', { definition: { source: { kind: 'file', fileId: csv.id } } }).expect(200)).body;
    // Two of three amounts read as numbers: below the 90% a detected type needs.
    expect(detect.columns.map((c: { type: string }) => c.type)).toEqual(['text', 'text', 'text']);
    await ann.post('/api/files/queries/preview', { definition: { source: { kind: 'file', fileId: csv.id }, steps: [{ op: 'drop-table' }] } }).expect(400);
    await ann.get(`/api/files/${csv.id}/tables`).expect(200);

    // Save, load into a new workbook, then refresh after the source changes.
    const saved = (await ann.post('/api/files/queries', { name: 'Sales by rep', definition, workspaceId: wsId }).expect(201)).body;
    expect(saved.label).toBe('internal');
    expect((await ann.get(`/api/files/queries?workspace=${wsId}`).expect(200)).body.map((q: { id: string }) => q.id)).toEqual([saved.id]);
    const loaded = (await ann.post(`/api/files/queries/${saved.id}/load`, { target: { mode: 'new', name: 'Sales report', kind: 'xlsx' } }).expect(202)).body;
    expect(loaded.file.name).toBe('Sales report.xlsx');
    expect(loaded.rows).toBe(3);
    expect(loaded.query.output).toMatchObject({ fileId: loaded.file.id, sheet: 'Sales by rep', kind: 'xlsx' });
    const out = (await ann.get(`/api/files/${loaded.file.id}/document`).expect(200)).body;
    expect(out.workbook.sheets[0].rows[1].map((c: { v: unknown }) => c.v)).toEqual(['North', 'Ann', 1200, 'Red']);
    expect(out.workbook.sheets[0].columns[2].type).toBe('number');

    // Load as a second sheet of an existing workbook.
    const book = (await ann.post('/api/files/documents', { name: 'Book', kind: 'xlsx', workspaceId: wsId }).expect(202)).body;
    const into = (await ann.post(`/api/files/queries/${saved.id}/load`, { target: { mode: 'existing', fileId: book.id, sheet: 'Totals' } }).expect(202)).body;
    expect(into.sheet).toBe('Totals');
    const bookDoc = (await ann.get(`/api/files/${book.id}/document`).expect(200)).body;
    expect(bookDoc.workbook.sheets.map((s: { name: string }) => s.name)).toEqual(['Sheet1', 'Totals']);

    // A query that references the saved one.
    const ref = (await ann.post('/api/files/queries/preview', { definition: { source: { kind: 'query', queryId: saved.id }, steps: [{ op: 'group', by: [], aggregates: [{ as: 'Total', fn: 'sum', column: 'Amount' }] }] } }).expect(200)).body;
    expect(ref.rows).toEqual([[1500]]);
    await ann.patch(`/api/files/queries/${saved.id}`, { definition: { source: { kind: 'query', queryId: saved.id } } }).expect(422);

    // A new version of the source, then a refresh writes the output file again.
    await ann.putContent(csv.id, 'Region,Rep,Amount\nEast,Bob,999\n').expect(202);
    expect((await ready(ann, csv.id)).currentVersion).toBe(2);
    const refreshed = (await ann.post(`/api/files/queries/${saved.id}/refresh`).expect(202)).body;
    expect(refreshed.created).toBe(false);
    expect(refreshed.rows).toBe(1);
    // The last load was into Book's Totals sheet, so that is what a refresh writes.
    expect(refreshed.file.id).toBe(book.id);
    expect(refreshed.sheet).toBe('Totals');
    expect(refreshed.version).toBe(3);
    const again = (await ann.get(`/api/files/${book.id}/document`).expect(200)).body;
    expect(again.workbook.sheets[1].rows[1].map((c: { v: unknown }) => c.v)).toEqual(['East', 'Bob', 999, 'Blue']);

    const audits = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).where('action', 'like', 'file.query.%')) as { action: string }[];
    expect(new Set(audits.map((a) => a.action))).toEqual(new Set(['file.query.created', 'file.query.loaded', 'file.query.refreshed']));
    await ann.del(`/api/files/queries/${saved.id}`).expect(204);
    await ann.get(`/api/files/queries/${saved.id}`).expect(404);
  });

  it('keeps labels: a query reading confidential data is hidden from internal readers and never loads into a lower file', async () => {
    const ann = await member('ann');
    const bob = await member('bob', 'internal');
    const secret = (await ann.upload('pay.csv', 'Name,Pay\nAnn,10\n', 'confidential').expect(202)).body;
    await ready(ann, secret.id);
    const q = (await ann.post('/api/files/queries', { name: 'Pay', definition: { source: { kind: 'file', fileId: secret.id } }, workspaceId: wsId }).expect(201)).body;
    expect(q.label).toBe('confidential');
    await bob.get(`/api/files/queries/${q.id}`).expect(404);
    expect((await bob.get(`/api/files/queries?workspace=${wsId}`).expect(200)).body).toEqual([]);
    // The file store refuses the file itself (above Bob's clearance).
    await bob.post('/api/files/queries/preview', { definition: { source: { kind: 'file', fileId: secret.id } } }).expect(403);
    const low = (await ann.post('/api/files/documents', { name: 'Open', kind: 'xlsx', workspaceId: wsId, label: 'internal' }).expect(202)).body;
    const refused = await ann.post(`/api/files/queries/${q.id}/load`, { target: { mode: 'existing', fileId: low.id } }).expect(403);
    expect(refused.body.detail).toMatch(/confidential/);
    const made = (await ann.post(`/api/files/queries/${q.id}/load`, { target: { mode: 'new', name: 'Pay copy', kind: 'csv', label: 'internal' } }).expect(202)).body;
    expect(made.file.label).toBe('confidential');
    const pdf = (await ann.upload('x.pdf', '%PDF-1.4\n%%EOF\n').expect(202)).body;
    await ready(ann, pdf.id);
    await ann.get(`/api/files/${pdf.id}/tables`).expect(415);
  });
});
