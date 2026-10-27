import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fieldName, inferEntity } from '../src/apps/import-infer.js';
import { parseRange, readTable } from '../src/apps/import-read.js';
import { applyTransforms, parseDate, parseNumber, transformsSchema, type Row } from '../src/apps/import-transforms.js';
import { cellValue } from '../src/apps/sheet-import.js';
import { entityDefinitionSchema } from '../src/apps/schema.js';
import { serialDate } from '../src/imports/xlsx.js';
import { bombWorkbook, ordersWorkbook, xlsx } from './app-import-fixtures.js';
import type { Harness } from './helpers.js';
import { drain, harnessWith } from './retrieval-seed.js';
import { clients, SqliteTableDriver } from './sprint39c-helpers.js';

/*
 * Sprint 45 (B-127, B-129): spreadsheet, JSON and connection imports into an app entity: the readers (XLSX with a
 * sheet, a header row and a range; CSV, TSV, JSON with a path, JSON Lines), the transformations, inference and PII
 * flags for "new entity from file", upsert by key, the per-row report and the error CSV, policies, the limits, and
 * imports from an allow-listed table (masked, keyed, scheduled, re-checked as the owner).
 */

const limits = { maxBytes: 10_000_000, unpackedBytes: 50_000_000, maxRows: 10_000 };
const rows = (list: Record<string, unknown>[]): Row[] => list.map((values, i) => ({ n: i + 2, values }));
const T = (x: unknown) => transformsSchema.parse(x);

describe('readers (B-127)', () => {
  it('reads a multi-sheet workbook: the sheet asked for, its header on row 3, a range, dates as ISO', async () => {
    const wb = ordersWorkbook();
    const first = await readTable(wb, 'orders.xlsx', {}, limits);
    expect(first.format).toBe('xlsx');
    expect(first.sheets).toEqual([{ name: 'Cover', hidden: false }, { name: 'Orders', hidden: false }]);
    expect(first.sheet).toBe('Cover');
    const t = await readTable(wb, 'orders.xlsx', { sheet: 'Orders', headerRow: 3 }, limits);
    expect(t.headerRow).toBe(3);
    expect(t.columns).toEqual(['Order ref', 'Customer', 'Amount', 'Placed', 'Paid', 'Region']);
    expect(t.rows.map((r) => r.n)).toEqual([4, 5, 6]);
    expect(t.rows[0]!.values).toEqual({ 'Order ref': 'A-100', Customer: 'Contoso', Amount: 120.5, Placed: serialDate(46280, false), Paid: true, Region: 'EMEA' });
    // a range: columns A to C, rows 3 to 5 (the header is the range's first row with a value)
    const r = await readTable(wb, 'orders.xlsx', { sheet: 'Orders', range: 'A3:C5' }, limits);
    expect(r.columns).toEqual(['Order ref', 'Customer', 'Amount']);
    expect(r.rows.map((x) => x.values['Order ref'])).toEqual(['A-100', 'A-101']);
    await expect(readTable(wb, 'orders.xlsx', { sheet: 'Nope' }, limits)).rejects.toThrow(/no worksheet named Nope/);
    await expect(readTable(wb, 'orders.xlsx', { sheet: 'Orders', headerRow: 2 }, limits)).rejects.toThrow(/Row 2 is empty/);
    expect(parseRange('B:D')).toMatchObject({ c0: 1, c1: 3, r0: 1 });
  });

  it('reads CSV, TSV, JSON (an array, a wrapper, a path) and JSON Lines', async () => {
    const csv = await readTable(Buffer.from('\ufeffname,qty\r\n"Ada, L",3\r\nBob,4\r\n'), 'x.csv', {}, limits);
    expect(csv).toMatchObject({ format: 'csv', columns: ['name', 'qty'], headerRow: 1 });
    expect(csv.rows).toEqual([{ n: 2, values: { name: 'Ada, L', qty: '3' } }, { n: 3, values: { name: 'Bob', qty: '4' } }]);
    const titled = await readTable(Buffer.from('Report,\n,\nname,qty\nAda,3\n'), 'x.csv', { headerRow: 3 }, limits);
    expect(titled.rows).toEqual([{ n: 4, values: { name: 'Ada', qty: '3' } }]);
    const tsv = await readTable(Buffer.from('a\tb\n1\t2\n'), 'x.tsv', {}, limits);
    expect(tsv.rows[0]!.values).toEqual({ a: '1', b: '2' });
    const arr = await readTable(Buffer.from(JSON.stringify([{ a: 1, b: 'x' }, { a: 2, c: true }])), 'x.json', {}, limits);
    expect(arr.columns).toEqual(['a', 'b', 'c']);
    expect(arr.rows[1]!.values).toEqual({ a: 2, b: null, c: true });
    const wrapped = await readTable(Buffer.from(JSON.stringify({ data: [{ a: 1 }] })), 'x.json', {}, limits);
    expect(wrapped.rows).toHaveLength(1);
    const pathed = await readTable(Buffer.from(JSON.stringify({ result: { page: { items: [{ a: 1 }, { a: 2 }] } } })), 'x.json', { jsonPath: 'result.page.items' }, limits);
    expect(pathed.rows.map((r) => r.values.a)).toEqual([1, 2]);
    await expect(readTable(Buffer.from('{"a":1}'), 'x.json', { jsonPath: 'a' }, limits)).rejects.toThrow(/not an array/);
    const jl = await readTable(Buffer.from('{"a":1}\n\n{"a":2,"b":"y"}\n'), 'x.jsonl', {}, limits);
    expect(jl).toMatchObject({ format: 'jsonl', columns: ['a', 'b'] });
    // the format from the bytes when the name says nothing
    expect((await readTable(Buffer.from('[{"a":1}]'), null, {}, limits)).format).toBe('json');
    expect((await readTable(ordersWorkbook(), null, {}, limits)).format).toBe('xlsx');
  });

  it('refuses too many rows, too many bytes and a workbook that unpacks past the limit', async () => {
    const many = `n\n${Array.from({ length: 30 }, (_, i) => i).join('\n')}\n`;
    await expect(readTable(Buffer.from(many), 'x.csv', {}, { ...limits, maxRows: 20 })).rejects.toMatchObject({ status: 413, message: expect.stringMatching(/more than 20 data rows/) });
    await expect(readTable(Buffer.from(many), 'x.csv', {}, { ...limits, maxBytes: 10 })).rejects.toMatchObject({ status: 413 });
    await expect(readTable(bombWorkbook(), 'bomb.xlsx', {}, { ...limits, unpackedBytes: 100_000 })).rejects.toMatchObject({ status: 413, message: expect.stringMatching(/unpacks to more than/) });
  });
});

describe('transformations (B-127)', () => {
  const base = rows([
    { name: '  ada   lovelace ', city: 'LONDON', full: 'Ada|Lovelace|Extra', group: 'A', amount: '1.234,50', when: '15/09/2026', state: 'n/a' },
    { name: 'bob', city: 'paris', full: 'Bob|', group: '', amount: '12', when: '31/02/2026', state: 'open' },
    { name: 'ada lovelace', city: '', full: '', group: '', amount: 'x', when: '', state: 'open' }
  ]);
  const cols = ['name', 'city', 'full', 'group', 'amount', 'when', 'state'];

  it('trims, changes case, splits, merges, fills down, replaces, parses dates and numbers, defaults, drops and dedupes', () => {
    const out = applyTransforms(
      cols,
      base,
      T([
        { kind: 'trim', columns: ['name'] },
        { kind: 'case', columns: ['name'], to: 'title' },
        { kind: 'case', columns: ['city'], to: 'lower' },
        { kind: 'split', column: 'full', delimiter: '|', into: ['first', 'last'] },
        { kind: 'merge', columns: ['first', 'last'], into: 'both', separator: ' ' },
        { kind: 'fill-down', columns: ['group'] },
        { kind: 'replace', columns: ['state'], map: { 'n/a': 'unknown' } },
        { kind: 'parse-number', columns: ['amount'], decimal: ',' },
        { kind: 'parse-date', columns: ['when'], format: 'DD/MM/YYYY' },
        { kind: 'default', columns: ['city'], value: 'nowhere' }
      ])
    );
    expect(out.columns).toEqual([...cols, 'first', 'last', 'both']);
    expect(out.rows[0]!.values).toMatchObject({ name: 'Ada Lovelace', city: 'london', first: 'Ada', last: 'Lovelace|Extra', both: 'Ada Lovelace|Extra', group: 'A', amount: 1234.5, when: '2026-09-15', state: 'unknown' });
    expect(out.rows[1]!.values).toMatchObject({ first: 'Bob', last: null, both: 'Bob', group: 'A', amount: 12 });
    expect(out.rows[2]!.values).toMatchObject({ group: 'A', city: 'nowhere', name: 'Ada Lovelace' });
    // a date that does not exist and a number that is not one fail their rows, with the reason
    expect(out.failed.get(3)).toMatch(/when: 31\/02\/2026 is not a date in the format DD\/MM\/YYYY/);
    expect(out.failed.get(4)).toMatch(/amount: x is not a number with a decimal comma/);
    // the input is not changed
    expect(base[0]!.values.name).toBe('  ada   lovelace ');

    const sentence = applyTransforms(['t'], rows([{ t: 'HELLO wORLD' }]), T([{ kind: 'case', columns: ['t'], to: 'sentence' }, { kind: 'trim', columns: ['t'], collapse: false }]));
    expect(sentence.rows[0]!.values.t).toBe('Hello world');
    const upper = applyTransforms(['t'], rows([{ t: 'abc' }]), T([{ kind: 'case', columns: ['t'], to: 'upper' }]));
    expect(upper.rows[0]!.values.t).toBe('ABC');
  });

  it('drops rows where a column is empty or matches, and dedupes keeping the first or the last', () => {
    const dropped = applyTransforms(cols, base, T([{ kind: 'drop-rows', column: 'city', when: 'empty' }, { kind: 'drop-rows', column: 'state', when: 'equals', values: ['N/A'], ignoreCase: true }]));
    expect(dropped.rows.map((r) => r.n)).toEqual([3]);
    expect(dropped.skipped).toEqual([{ n: 2, reason: 'dropped: state is n/a' }, { n: 4, reason: 'dropped: city is empty' }]);
    const trimmed = T([{ kind: 'trim', columns: ['name'] }]);
    const first = applyTransforms(cols, base, [...trimmed, ...T([{ kind: 'dedupe', columns: ['name'], keep: 'first' }])]);
    expect(first.rows.map((r) => r.n)).toEqual([2, 3]);
    expect(first.skipped).toEqual([{ n: 4, reason: 'duplicate of row 2 on name' }]);
    const last = applyTransforms(cols, base, [...trimmed, ...T([{ kind: 'dedupe', columns: ['name'], keep: 'last' }])]);
    expect(last.rows.map((r) => r.n)).toEqual([3, 4]);
    expect(last.skipped[0]!.reason).toMatch(/duplicate of row 4.*last is kept/);
    expect(() => applyTransforms(cols, base, T([{ kind: 'trim', columns: ['nope'] }]))).toThrow(/no column nope/);
    // no expressions: an unknown kind or an extra option is refused by the schema
    expect(transformsSchema.safeParse([{ kind: 'eval', code: '1' }]).success).toBe(false);
    expect(transformsSchema.safeParse([{ kind: 'trim', columns: ['a'], expression: 'x' }]).success).toBe(false);
  });

  it('parses date formats and number separators', () => {
    expect(parseDate('09/15/2026', 'MM/DD/YYYY', false)).toBe('2026-09-15');
    expect(parseDate('15.09.2026 14:30', 'DD.MM.YYYY', true)).toBe('2026-09-15T14:30:00Z');
    expect(parseDate('20260915', 'YYYYMMDD', false)).toBe('2026-09-15');
    expect(parseDate('1/2/26', 'D/M/YYYY', false)).toBeNull();
    expect(parseDate('15/09/26', 'DD/MM/YY', false)).toBe('2026-09-15');
    expect(parseNumber('1,234.5', '.')).toBe(1234.5);
    expect(parseNumber("1'234,5", ',')).toBe(1234.5);
    expect(parseNumber('1,23,4', '.')).toBeNull();
    expect(parseNumber(7, ',')).toBe(7);
  });

  it('turns cells into the values their fields store', () => {
    const def = entityDefinitionSchema.parse({ fields: [{ name: 'b', type: 'boolean' }, { name: 'n', type: 'number' }, { name: 'd', type: 'date' }, { name: 'dt', type: 'date', withTime: true }, { name: 's', type: 'string' }, { name: 'j', type: 'json' }] });
    const f = (n: string) => def.fields.find((x) => x.name === n)!;
    expect(cellValue(f('b'), 'Yes')).toBe(true);
    expect(cellValue(f('b'), 0)).toBe(false);
    expect(cellValue(f('n'), ' 12 ')).toBe(12);
    expect(cellValue(f('d'), '2026-09-15T00:00:00')).toBe('2026-09-15');
    expect(cellValue(f('dt'), '2026-09-15 10:30')).toBe('2026-09-15T10:30Z');
    expect(cellValue(f('s'), 42)).toBe('42');
    expect(cellValue(f('j'), '{"a":1}')).toEqual({ a: 1 });
    expect(cellValue(f('s'), '')).toBeNull();
  });
});

describe('inference and PII flags (B-127)', () => {
  it('infers types, required, unique and enums, and flags personal data', () => {
    const data = rows(
      Array.from({ length: 8 }, (_, i) => ({
        'Customer ID': String(1000 + i),
        'E-mail': `user${i}@example.com`,
        Amount: (i * 1.5).toFixed(2),
        Active: i % 2 ? 'yes' : 'no',
        Joined: `2026-0${(i % 9) + 1}-1${i % 9}`,
        Seen: `2026-09-1${i}T10:00:00Z`,
        Tier: ['gold', 'silver'][i % 2]!,
        Website: `https://example.com/${i}`,
        Notes: i === 3 ? '' : `note ${i}`,
        Empty: '',
        id: String(i)
      }))
    );
    const p = inferEntity(Object.keys(data[0]!.values), data, { sourceLabel: 'internal', ceiling: 'confidential' });
    const by = (c: string) => p.columns.find((x) => x.column === c)!;
    expect(by('Customer ID')).toMatchObject({ name: 'customer_id', field: { type: 'number', integer: true, unique: true, required: true } });
    expect(by('E-mail')).toMatchObject({ name: 'e_mail', field: { type: 'string', pattern: expect.stringContaining('@'), unique: true }, pii: expect.stringMatching(/email/) });
    expect(by('Amount').field).toMatchObject({ type: 'number', integer: false });
    expect(by('Active').field).toMatchObject({ type: 'boolean' });
    expect(by('Joined').field).toMatchObject({ type: 'date', withTime: false });
    expect(by('Seen').field).toMatchObject({ type: 'date', withTime: true });
    expect(by('Tier').field).toMatchObject({ type: 'enum', options: [{ value: 'gold' }, { value: 'silver' }] });
    expect(by('Website').field).toMatchObject({ type: 'string', pattern: expect.stringContaining('https?') });
    expect(by('Notes').field).toMatchObject({ type: 'string', required: false });
    expect(by('Notes').pii).toMatch(/free text/);
    expect(by('Empty')).toMatchObject({ skip: true });
    expect(by('id').name).toBe('id_value');
    expect(p.label).toBe('confidential');
    expect(p.titleField).toBe('website');
    // every proposed field passes the entity schema
    expect(entityDefinitionSchema.safeParse({ fields: p.columns.map((c) => c.field) }).success).toBe(true);
    expect(fieldName('Ünïcode name', new Set())).toBe('unicode_name');
    expect(fieldName('2026 total', new Set())).toBe('f_2026_total');
  });
});

describe('spreadsheet and connection imports into an entity (API)', () => {
  let h: Harness;
  let wsId: string;
  let outside: Database.Database;

  beforeEach(async () => {
    outside = new Database(':memory:');
    outside.exec('create table customers (id integer primary key, name text not null, email text, tier text, balance real);');
    const ins = outside.prepare('insert into customers (name, email, tier, balance) values (?, ?, ?, ?)');
    ins.run('Contoso', 'ap@contoso.example', 'gold', 120.5);
    ins.run('Fabrikam', 'ops@fabrikam.example', 'silver', 0);
    ins.run('Northwind', null, 'gold', 7);
    h = await harnessWith({ drivers: { postgres: (spec) => new SqliteTableDriver(outside, spec) } }, { OLLAMA_POLL_MS: '600000', APPS_SCHEDULE_TICK_SECONDS: '0' });
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Sales', 'confidential')).id;
  });
  afterEach(async () => {
    await h.close();
    outside.close();
  });

  type C = Awaited<ReturnType<ReturnType<typeof clients>['member']>>;
  const upload = async (c: C, name: string, data: Buffer, label = 'internal') => {
    const r = await c.agent.put(`/api/files/uploads?${new URLSearchParams({ name, workspace: wsId, label }).toString()}`).set('x-csrf-token', c.csrf).set('content-type', 'application/octet-stream').send(data).expect(202);
    await drain(h);
    return (r.body as { id: string }).id;
  };
  const transfer = async (c: C, id: string) => {
    await drain(h);
    return (await c.get(`/api/apps/transfers/${id}`).expect(200)).body;
  };
  const records = async (c: C, entity = 'order') => (await c.post(`/api/apps/crm/entities/${entity}/records/query`, { sort: [{ field: 'ref', dir: 'asc' }], limit: 200 }).expect(200)).body.records as { id: string; label: string; source: string; values: Record<string, unknown> }[];
  const audits = async (prefix: string) => ((await h.s.db('audit_events').where('action', 'like', `${prefix}%`).select('action')) as { action: string }[]).map((x) => x.action);

  async function crm() {
    const c = clients(h, wsId);
    const dee = await c.designer('dee', ['workflow-admin', 'connection-admin', 'member']);
    await dee.post('/api/apps', { name: 'crm', label: 'confidential', workspaceId: wsId }).expect(201);
    await dee
      .post('/api/apps/crm/entities', {
        name: 'order',
        definition: {
          fields: [
            { name: 'ref', type: 'string', required: true, unique: true, indexed: true, maxLength: 20 },
            { name: 'customer', type: 'string', maxLength: 100 },
            { name: 'amount', type: 'number', min: 0 },
            { name: 'placed', type: 'date' },
            { name: 'paid', type: 'boolean' },
            { name: 'region', type: 'enum', options: [{ value: 'EMEA' }, { value: 'APAC' }] }
          ]
        }
      })
      .expect(201);
    const mia = await c.member('mia', 'confidential');
    return { c, dee, mia };
  }

  const orderMapping = [
    { column: 'Order ref', field: 'ref' },
    { column: 'Customer', field: 'customer' },
    { column: 'Amount', field: 'amount' },
    { column: 'Placed', field: 'placed' },
    { column: 'Paid', field: 'paid' },
    { column: 'Region', field: 'region' }
  ];

  it('previews a workbook from the file store (sheet, header row 3), dry-runs, imports, then upserts by key', async () => {
    const { mia } = await crm();
    const fileId = await upload(mia, 'orders.xlsx', ordersWorkbook());
    const source = { kind: 'file', fileId, sheet: 'Orders', headerRow: 3 };
    const pv = (await mia.post('/api/apps/crm/imports/preview', { source, transforms: [{ kind: 'case', columns: ['Customer'], to: 'upper' }], entity: 'order', mapping: orderMapping }).expect(200)).body;
    expect(pv.source).toMatchObject({ format: 'xlsx', sheet: 'Orders', headerRow: 3, rows: 3, label: 'internal', version: 1, sheets: [{ name: 'Cover' }, { name: 'Orders' }] });
    expect(pv.rows[0]).toMatchObject({ row: 4, values: { Customer: 'CONTOSO', Amount: 120.5 } });
    expect(pv.checks.map((x: { outcome: string }) => x.outcome)).toEqual(['created', 'created', 'created']);
    expect(pv.profile.find((p: { name: string }) => p.name === 'Customer').pii).toMatch(/natural persons/);

    // the dry run (the default) writes nothing and reports every row
    const dry = (await mia.post('/api/apps/crm/entities/order/imports', { source, transforms: [], mapping: orderMapping }).expect(202)).body;
    const d = await transfer(mia, dry.id);
    expect(d).toMatchObject({ state: 'succeeded', dryRun: true, summary: { rows: 3, created: 0, wouldCreate: 3, failed: 0, dryRun: true } });
    expect(await records(mia)).toHaveLength(0);
    const real = (await mia.post('/api/apps/crm/entities/order/imports', { source, transforms: [], mapping: orderMapping, dryRun: false }).expect(202)).body;
    const done = await transfer(mia, real.id);
    expect(done).toMatchObject({ state: 'succeeded', summary: { created: 3, updated: 0, failed: 0 }, errors: false });
    expect(done.report.map((x: { row: number; outcome: string }) => [x.row, x.outcome])).toEqual([[4, 'created'], [5, 'created'], [6, 'created']]);
    const recs = await records(mia);
    expect(recs.map((r) => [r.values.ref, r.values.customer, r.values.amount, r.values.paid, r.values.region, r.source])).toEqual([
      ['A-100', 'Contoso', 120.5, true, 'EMEA', 'import'],
      ['A-101', 'Fabrikam', 80, false, 'APAC', 'import'],
      ['A-102', 'Northwind', 15.25, true, 'EMEA', 'import']
    ]);
    expect(recs[0]!.values.placed).toBe(serialDate(46280, false));
    expect(await audits('app.import.')).toEqual(expect.arrayContaining(['app.import.queued', 'app.import.checked', 'app.import.completed']));
    expect(await audits('app.record.created')).toHaveLength(3);

    // upsert by the unique ref: a changed row updates, an unchanged one is skipped, a new one is created
    const csv = 'ref,amount\nA-100,99\nA-101,80\nA-200,5\n';
    const up = (await mia.post('/api/apps/crm/entities/order/imports', { source: { kind: 'text', text: csv }, transforms: [], mapping: [{ column: 'ref', field: 'ref' }, { column: 'amount', field: 'amount' }], upsert: { field: 'ref' }, dryRun: false }).expect(202)).body;
    const u = await transfer(mia, up.id);
    expect(u.summary).toMatchObject({ created: 1, updated: 1, skipped: 1, failed: 0 });
    expect(u.report.find((x: { row: number }) => x.row === 3)).toMatchObject({ outcome: 'skipped', problem: 'unchanged' });
    const after = await records(mia);
    expect(after.map((r) => [r.values.ref, r.values.amount, r.values.customer ?? null])).toEqual([['A-100', 99, 'Contoso'], ['A-101', 80, 'Fabrikam'], ['A-102', 15.25, 'Northwind'], ['A-200', 5, null]]);
    // update-only skips the rows that match no record
    const only = (await mia.post('/api/apps/crm/entities/order/imports', { source: { kind: 'text', text: 'ref,amount\nA-300,1\nA-102,16\n' }, transforms: [], mapping: [{ column: 'ref', field: 'ref' }, { column: 'amount', field: 'amount' }], upsert: { field: 'ref', mode: 'update-only' }, dryRun: false }).expect(202)).body;
    expect((await transfer(mia, only.id)).summary).toMatchObject({ created: 0, updated: 1, skipped: 1 });
    // upsert needs a unique, mapped field
    await mia.post('/api/apps/crm/entities/order/imports', { source: { kind: 'text', text: csv }, transforms: [], mapping: [{ column: 'ref', field: 'ref' }], upsert: { field: 'amount' } }).expect(400);
  });

  it('reports validation failures per row, dedupes, and offers the failed rows as CSV with their reasons', async () => {
    const { mia, c } = await crm();
    const csv = ['Order ref;Customer;Amount;Placed;Region', 'B-1;Ada;10,5;15/09/2026;EMEA', 'B-2;Bob;-3;16/09/2026;EMEA', 'B-3;Cy;4;31/02/2026;APAC', ';Dee;1;01/09/2026;EMEA', 'B-1;Ada again;11;15/09/2026;EMEA', 'B-5;Eve;2;02/09/2026;MARS'].join('\n');
    const fileId = await upload(mia, 'orders.csv', Buffer.from(csv));
    const spec = {
      source: { kind: 'file', fileId },
      transforms: [
        { kind: 'parse-number', columns: ['Amount'], decimal: ',' },
        { kind: 'parse-date', columns: ['Placed'], format: 'DD/MM/YYYY' },
        { kind: 'dedupe', columns: ['Order ref'], keep: 'first' }
      ],
      mapping: [{ column: 'Order ref', field: 'ref' }, { column: 'Customer', field: 'customer' }, { column: 'Amount', field: 'amount' }, { column: 'Placed', field: 'placed' }, { column: 'Region', field: 'region' }],
      dryRun: false
    };
    const out = (await mia.post('/api/apps/crm/entities/order/imports', spec).expect(202)).body;
    const t = await transfer(mia, out.id);
    expect(t.summary).toMatchObject({ rows: 6, created: 1, skipped: 1, failed: 4, errors: 4 });
    const by = new Map<number, { outcome: string; problem?: string }>(t.report.map((x: { row: number }) => [x.row, x]));
    expect(by.get(2)).toMatchObject({ outcome: 'created' });
    expect(by.get(3)!.problem).toMatch(/amount: is below 0/);
    expect(by.get(4)!.problem).toMatch(/Placed: 31\/02\/2026 is not a date/);
    expect(by.get(5)!.problem).toMatch(/ref: is required/);
    expect(by.get(6)).toMatchObject({ outcome: 'skipped', problem: 'duplicate of row 2 on Order ref' });
    expect(by.get(7)!.problem).toMatch(/region: should be one of EMEA, APAC/);
    expect(t.errors).toBe(true);
    const csvOut = await mia.get(`/api/apps/transfers/${out.id}/errors`).expect(200).expect('content-type', /text\/csv/);
    const lines = csvOut.text.trim().split('\r\n');
    expect(lines[0]).toBe('row,reason,Order ref,Customer,Amount,Placed,Region');
    expect(lines).toHaveLength(5);
    expect(lines[1]).toMatch(/^3,amount: is below 0,B-2,Bob,'-3,16\/09\/2026,EMEA$/);
    expect(await audits('app.import.errors.downloaded')).toHaveLength(1);
    // only the person who started it downloads it
    const other = await c.member('oli', 'confidential');
    await other.get(`/api/apps/transfers/${out.id}/errors`).expect(404);
  });

  it('applies policies to imported rows, and the label of the source', async () => {
    const { dee, mia } = await crm();
    await dee.post('/api/apps/crm/policies', { name: 'No amounts', entity: 'order', subjects: [{ kind: 'role', value: 'member' }], fields: { amount: { create: false } } }).expect(201);
    const res = (await mia.post('/api/apps/crm/entities/order/imports', { source: { kind: 'text', text: 'ref,amount\nP-1,3\nP-2,\n' }, transforms: [], mapping: [{ column: 'ref', field: 'ref' }, { column: 'amount', field: 'amount' }], dryRun: true }).expect(202)).body;
    const t = await transfer(mia, res.id);
    expect(t.summary).toMatchObject({ wouldCreate: 1, failed: 1 });
    expect(t.report.find((x: { row: number }) => x.row === 2).problem).toMatch(/amount/);
    // a confidential file makes confidential records; a member cleared for internal cannot import it
    const conf = await upload(mia, 'conf.csv', Buffer.from('ref\nL-1\n'), 'confidential');
    const r2 = (await mia.post('/api/apps/crm/entities/order/imports', { source: { kind: 'file', fileId: conf }, transforms: [], mapping: [{ column: 'ref', field: 'ref' }], dryRun: false }).expect(202)).body;
    expect((await transfer(mia, r2.id)).summary).toMatchObject({ created: 1 });
    expect((await records(mia)).find((r) => r.values.ref === 'L-1')!.label).toBe('confidential');
  });

  it('refuses a file over the limits: too many rows, too many bytes, a zip bomb', async () => {
    await h.close();
    h = await harnessWith({}, { OLLAMA_POLL_MS: '600000', APPS_IMPORT_MAX_ROWS: '20', IMPORT_ARCHIVE_MAX_BYTES: '500000', IMPORT_ARCHIVE_MAX_UNPACKED_BYTES: '100000' });
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Sales', 'confidential')).id;
    const { mia } = await crm();
    const many = await upload(mia, 'many.csv', Buffer.from(`ref\n${Array.from({ length: 30 }, (_, i) => `R-${i}`).join('\n')}\n`));
    const big = await upload(mia, 'big.csv', Buffer.from(`ref\n${'R-0\n'.repeat(150_000)}`));
    const bomb = await upload(mia, 'bomb.xlsx', bombWorkbook());
    const body = (fileId: string) => ({ source: { kind: 'file', fileId }, transforms: [], mapping: [{ column: 'ref', field: 'ref' }] });
    expect((await mia.post('/api/apps/crm/imports/preview', { source: body(many).source, transforms: [] }).expect(413)).body.detail).toMatch(/more than 20 data rows/);
    expect((await mia.post('/api/apps/crm/entities/order/imports', body(big)).expect(413)).body.detail).toMatch(/IMPORT_ARCHIVE_MAX_BYTES/);
    expect((await mia.post('/api/apps/crm/entities/order/imports', body(bomb)).expect(413)).body.detail).toMatch(/unpacks to more than/);
    // pasted text is capped by the schema
    await mia.post('/api/apps/crm/imports/preview', { source: { kind: 'text', text: 'x'.repeat(250_001) }, transforms: [] }).expect(400);
  });

  it('creates a new entity from a file (inferred, edited, through the design path) and imports into it', async () => {
    const { dee, mia } = await crm();
    const json = JSON.stringify({ data: Array.from({ length: 6 }, (_, i) => ({ code: `C-${i}`, 'Contact e-mail': `p${i}@example.com`, seats: i + 1, plan: ['basic', 'pro'][i % 2], since: `2026-0${i + 1}-01` })) });
    const fileId = await upload(dee, 'accounts.json', Buffer.from(json));
    const source = { kind: 'file', fileId };
    // inferring needs the design right
    await mia.post('/api/apps/crm/imports/infer', { source, transforms: [] }).expect(403);
    const p = (await dee.post('/api/apps/crm/imports/infer', { source, transforms: [] }).expect(200)).body;
    expect(p.columns.map((c: { name: string; field: { type: string } }) => [c.name, c.field.type])).toEqual([['code', 'string'], ['contact_e_mail', 'string'], ['seats', 'number'], ['plan', 'enum'], ['since', 'date']]);
    expect(p.columns[0].field).toMatchObject({ unique: true, required: true });
    expect(p.columns[1].pii).toMatch(/email/);
    expect(p.label).toBe('confidential');
    // the designer renames a column, makes one optional, skips the dates
    const columns = p.columns
      .filter((c: { name: string }) => c.name !== 'since')
      .map((c: { column: string; name: string; field: Record<string, unknown> }) => ({ column: c.column, field: c.name === 'contact_e_mail' ? { ...c.field, name: 'email' } : c.name === 'seats' ? { ...c.field, required: false } : c.field }));
    const made = (await dee.post('/api/apps/crm/imports/entity', { source, transforms: [], entity: { name: 'account', title: 'Accounts', label: p.label, columns, titleField: 'code' }, dryRun: false }).expect(201)).body;
    expect(made.entity).toMatchObject({ name: 'account', label: 'confidential', definition: { titleField: 'code' } });
    expect(made.entity.definition.fields.map((f: { name: string }) => f.name)).toEqual(['code', 'email', 'seats', 'plan']);
    const t = await transfer(dee, made.transfer.id);
    expect(t.summary).toMatchObject({ created: 6, failed: 0 });
    const recs = (await dee.post('/api/apps/crm/entities/account/records/query', { limit: 50 }).expect(200)).body.records;
    expect(recs).toHaveLength(6);
    expect(recs[0].label).toBe('confidential');
    // the design path: the entity's audit entry and its schema version
    expect(await audits('app.entity.created')).toHaveLength(2);
    expect(await audits('app.import.entity-created')).toHaveLength(1);
    const versions = (await h.s.db('app_schema_versions').select('kind', 'target')) as { kind: string; target: string }[];
    expect(versions).toContainEqual({ kind: 'entity.created', target: 'account' });
    // a name already taken is refused, and nothing is imported
    await dee.post('/api/apps/crm/imports/entity', { source, transforms: [], entity: { name: 'account', columns } }).expect(409);
  });

  it('imports from an allow-listed table: masked, keyed for re-imports, labelled, scheduled as its owner, cancellable', async () => {
    const { c, dee } = await crm();
    const conn = (await dee.post('/api/admin/connections', { name: 'crmdb', engine: 'postgres', endpoint: 'crm.internal:5432', database: 'crm', label: 'confidential', username: 'app', password: 'right' }).expect(201)).body;
    await dee.post(`/api/admin/connections/${conn.id}/schema`).expect(200);
    await dee.put(`/api/admin/connections/${conn.id}/allow-list`, { objects: ['public.customers'] }).expect(200);
    await dee.post('/api/apps/crm/entities', { name: 'customer', definition: { fields: [{ name: 'crm_id', type: 'number', unique: true, indexed: true }, { name: 'name', type: 'string', maxLength: 100, required: true, indexed: true }, { name: 'email', type: 'string', maxLength: 200 }, { name: 'tier', type: 'string', maxLength: 20 }] } }).expect(201);
    const source = { kind: 'connection', connectionId: conn.id, object: 'public.customers', keyColumn: 'id' };
    const pv = (await dee.post('/api/apps/crm/imports/preview', { source, transforms: [] }).expect(200)).body;
    expect(pv.source).toMatchObject({ rows: 3, label: 'confidential', format: 'json' });
    expect(pv.columns).toEqual(['id', 'name', 'email', 'tier', 'balance']);
    // e-mail addresses are masked as in every read of a connection
    expect(String(pv.rows[0].values.email)).not.toContain('ap@contoso.example');
    const spec = { source, transforms: [], mapping: [{ column: 'name', field: 'name' }, { column: 'email', field: 'email' }, { column: 'tier', field: 'tier' }], sourceKey: 'id' };
    // a member without the connection right may not read it
    const mia = await c.member('mia2', 'confidential');
    await mia.post('/api/apps/crm/imports/preview', { source, transforms: [] }).expect(403);
    const first = (await dee.post('/api/apps/crm/entities/customer/imports', { ...spec, dryRun: false }).expect(202)).body;
    expect((await transfer(dee, first.id)).summary).toMatchObject({ created: 3, source: 'connection' });
    let recs = (await dee.post('/api/apps/crm/entities/customer/records/query', { sort: [{ field: 'name', dir: 'asc' }] }).expect(200)).body.records;
    expect(recs.map((r: { values: { name: string }; label: string }) => [r.values.name, r.label])).toEqual([['Contoso', 'confidential'], ['Fabrikam', 'confidential'], ['Northwind', 'confidential']]);
    // a re-import keyed by id updates the records it made (idempotent), never duplicates them
    outside.prepare("update customers set tier = 'platinum' where id = 2").run();
    const again = (await dee.post('/api/apps/crm/entities/customer/imports', { ...spec, dryRun: false }).expect(202)).body;
    expect((await transfer(dee, again.id)).summary).toMatchObject({ created: 0, updated: 1, skipped: 2 });
    recs = (await dee.post('/api/apps/crm/entities/customer/records/query', { sort: [{ field: 'name', dir: 'asc' }] }).expect(200)).body.records;
    expect(recs).toHaveLength(3);
    expect(recs[1].values.tier).toBe('platinum');
    expect(await h.s.db('app_import_keys').count({ n: '*' }).first()).toMatchObject({ n: 3 });
    expect(await audits('app.import.source.previewed')).toHaveLength(1);

    // a schedule: refused for a file, validated cron, run by the tick as its owner, re-checked each time
    await dee.post('/api/apps/crm/entities/customer/import-schedules', { spec: { ...spec, source: { kind: 'text', text: 'a\n1\n' } }, cron: '0 * * * *' }).expect(400);
    await dee.post('/api/apps/crm/entities/customer/import-schedules', { spec, cron: 'not a cron' }).expect(400);
    const sch = (await dee.post('/api/apps/crm/entities/customer/import-schedules', { spec, cron: '0 * * * *' }).expect(201)).body;
    expect(sch).toMatchObject({ cron: '0 * * * *', enabled: true, source: { kind: 'connection' } });
    expect(sch.nextRunAt).toBeGreaterThan(Date.now());
    outside.prepare("insert into customers (name, email, tier, balance) values ('Tailspin', null, 'silver', 1)").run();
    const tick = await h.s.apps.sheetImport.tick(sch.nextRunAt + 1);
    expect(tick).toEqual({ queued: 1, skipped: 0 });
    // a second instance at the same moment finds the time claimed
    expect(await h.s.apps.sheetImport.tick(sch.nextRunAt + 1)).toEqual({ queued: 0, skipped: 0 });
    await drain(h);
    const listed = (await dee.get('/api/apps/crm/entities/customer/import-schedules').expect(200)).body;
    expect(listed[0].lastResult).toMatch(/queued 4 rows/);
    expect((await transfer(dee, listed[0].lastTransfer)).summary).toMatchObject({ created: 1, skipped: 3 });
    // the owner loses records:write: the next run is skipped and says why
    await h.s.users.setRoles(dee.user.id, 'direct', ['connection-admin']);
    const later = await h.s.apps.sheetImport.tick(Date.now() + 3 * 3600_000);
    expect(later).toEqual({ queued: 0, skipped: 1 });
    expect(await audits('app.import.schedule.skipped')).toHaveLength(1);
    await h.s.users.setRoles(dee.user.id, 'direct', ['workflow-admin', 'connection-admin', 'member']);
    await dee.patch(`/api/apps/crm/import-schedules/${sch.id}`, { enabled: false }).expect(200);
    await dee.del(`/api/apps/crm/import-schedules/${sch.id}`).expect(204);

    // a queued import is cancelled before it runs
    const q = (await dee.post('/api/apps/crm/entities/customer/imports', { ...spec, dryRun: false }).expect(202)).body;
    expect((await dee.post(`/api/apps/transfers/${q.id}/cancel`).expect(200)).body.state).toBe('cancelled');
    await drain(h);
    expect((await dee.get(`/api/apps/transfers/${q.id}`).expect(200)).body.state).toBe('cancelled');
    await dee.post(`/api/apps/transfers/${q.id}/cancel`).expect(409);
  });

  it('imports from a saved query and a REST endpoint through their read API, paging with the cursor', async () => {
    const { dee } = await crm();
    const conn = (await dee.post('/api/admin/connections', { name: 'crmdb', engine: 'postgres', endpoint: 'crm.internal:5432', database: 'crm', label: 'internal', username: 'app', password: 'right' }).expect(201)).body;
    await dee.post(`/api/admin/connections/${conn.id}/schema`).expect(200);
    await dee.put(`/api/admin/connections/${conn.id}/allow-list`, { objects: ['public.customers'] }).expect(200);
    const q = (await dee.post(`/api/admin/connections/${conn.id}/queries`, { name: 'gold_customers', label: 'confidential', definition: { text: "select id, name, tier from public.customers where tier = 'gold'" } }).expect(201)).body;
    await dee.post(`/api/admin/connection-queries/${q.id}/publish`, {}).expect(200);
    await dee.post('/api/apps/crm/entities', { name: 'gold', definition: { fields: [{ name: 'ext', type: 'number', unique: true, indexed: true }, { name: 'name', type: 'string', maxLength: 100 }] } }).expect(201);
    const spec = { source: { kind: 'saved-query', queryId: q.id, params: {} }, transforms: [], mapping: [{ column: 'id', field: 'ext' }, { column: 'name', field: 'name' }], upsert: { field: 'ext' } };
    const pv = (await dee.post('/api/apps/crm/imports/preview', { source: spec.source, transforms: [] }).expect(200)).body;
    expect(pv.source).toMatchObject({ rows: 2, label: 'confidential' });
    const run = (await dee.post('/api/apps/crm/entities/gold/imports', { ...spec, dryRun: false }).expect(202)).body;
    expect((await transfer(dee, run.id)).summary).toMatchObject({ created: 2, source: 'saved-query' });
    const golds = (await dee.post('/api/apps/crm/entities/gold/records/query', {}).expect(200)).body.records;
    expect(golds.map((r: { label: string }) => r.label)).toEqual(['confidential', 'confidential']);
    // a schedule may read a saved query as well
    expect((await dee.post('/api/apps/crm/entities/gold/import-schedules', { spec, cron: '30 6 * * 1' }).expect(201)).body.schedule).toBeTruthy();

    // a REST endpoint: pages followed through nextCursor, the endpoint's label kept
    const calls: { cursor?: string | null; via?: string }[] = [];
    const spy = vi.spyOn(h.s.restConnections, 'read').mockImplementation(async (_p, _id, _endpoint, _params, o = {}) => {
      calls.push({ cursor: o.cursor ?? null, via: o.via });
      const page = o.cursor ? [{ id: 12, name: 'Litware' }] : [{ id: 10, name: 'Adatum' }, { id: 11, name: 'Proseware' }];
      return { columns: [{ name: 'id', type: 'number' }, { name: 'name', type: 'string' }], rows: page, truncated: !o.cursor, ...(o.cursor ? {} : { nextCursor: 'p2' }), label: 'internal', masked: [], ms: 1, pages: 1 } as never;
    });
    try {
      const rest = (await dee.post('/api/apps/crm/entities/gold/imports', { ...spec, source: { kind: 'rest', connectionId: 'litware', endpoint: 'customers', params: { region: 'emea' } }, dryRun: false }).expect(202)).body;
      expect((await transfer(dee, rest.id)).summary).toMatchObject({ created: 3, source: 'rest' });
      expect(calls.filter((c) => c.cursor === 'p2').length).toBeGreaterThanOrEqual(2);
      expect(calls.every((c) => c.via === 'apps.import')).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('xlsx fixture helper', () => {
  it('builds hidden sheets the reader skips by default', async () => {
    const wb = xlsx([{ name: 'Secret', hidden: true, rows: [['a'], [1]] }, { name: 'Shown', rows: [['b'], [2]] }]);
    const t = await readTable(wb, 'x.xlsx', {}, limits);
    expect(t.sheet).toBe('Shown');
    expect(t.rows[0]!.values).toEqual({ b: 2 });
  });
});
