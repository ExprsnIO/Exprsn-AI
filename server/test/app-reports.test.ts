import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bindReportParams, computeReport, reportDefinitionSchema, type ReportLine, type SourceColumn } from '../src/apps/report-engine.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * 1.8.0, Sprint 44 (B-122): reports. The engine (grouped tables with subtotals and a grand total, the cross-tab with
 * its column cap, parameters, computed columns, conditional formatting, masked columns) and the API: definitions
 * sealed and audited, runs as the viewer (a row policy's hidden rows never count in a total, masked values stay
 * masked), row caps, the run history with its parameters and the sealed result that expires.
 */

const def = (over: Record<string, unknown>) => reportDefinitionSchema.parse({ title: 'T', source: { kind: 'entity', entity: 'deal' }, ...over });
const cols: SourceColumn[] = [
  { key: 'title', title: 'Title', type: 'text' },
  { key: 'region', title: 'Region', type: 'text' },
  { key: 'stage', title: 'Stage', type: 'text' },
  { key: 'amount', title: 'Amount', type: 'number' }
];
const rows = [
  { title: 'A', region: 'West', stage: 'Won', amount: 100 },
  { title: 'B', region: 'East', stage: 'Lead', amount: 50 },
  { title: 'C', region: 'West', stage: 'Lead', amount: 300 },
  { title: 'D', region: 'North', stage: 'Won', amount: 25 },
  { title: 'E', region: 'East', stage: 'Won', amount: 75 }
];
const text = (l: ReportLine) => l.cells.map((c) => (c.masked ? '#' : c.v));

describe('the report engine', () => {
  it('groups with headers, subtotals and a grand total, in order', () => {
    const r = computeReport({ def: def({ layout: { kind: 'grouped', groupBy: ['region'], aggregates: [{ op: 'count' }, { op: 'sum', column: 'amount' }] }, columns: [{ key: 'title' }, { key: 'amount' }], sort: [{ column: 'amount', dir: 'desc' }] }), columns: cols, rows, truncated: false, params: {} });
    expect(r.columns.map((c) => c.key)).toEqual(['title', 'amount']);
    expect(r.lines.map((l) => [l.kind, l.label ?? null, ...text(l)])).toEqual([
      ['group', 'Region: East', ],
      ['row', null, 'E', 75],
      ['row', null, 'B', 50],
      ['subtotal', 'Subtotal East (2 rows)', null, 125],
      ['group', 'Region: North'],
      ['row', null, 'D', 25],
      ['subtotal', 'Subtotal North (1 row)', null, 25],
      ['group', 'Region: West'],
      ['row', null, 'C', 300],
      ['row', null, 'A', 100],
      ['subtotal', 'Subtotal West (2 rows)', null, 400],
      ['total', 'Grand total (5 rows)', null, 550]
    ]);
    expect(r.lines.find((l) => l.kind === 'group')!.count).toBe(2);
  });

  it('nests two group levels and rolls subtotals up', () => {
    const r = computeReport({ def: def({ layout: { kind: 'grouped', groupBy: ['region', 'stage'], aggregates: [{ op: 'sum', column: 'amount' }], grandTotal: true }, columns: [{ key: 'title' }, { key: 'amount' }] }), columns: cols, rows, truncated: false, params: {} });
    const subs = r.lines.filter((l) => l.kind === 'subtotal').map((l) => [l.level, l.label, l.cells[1]!.v]);
    expect(subs).toEqual([
      [1, 'Subtotal Lead', 50],
      [1, 'Subtotal Won', 75],
      [0, 'Subtotal East', 125],
      [1, 'Subtotal Won', 25],
      [0, 'Subtotal North', 25],
      [1, 'Subtotal Lead', 300],
      [1, 'Subtotal Won', 100],
      [0, 'Subtotal West', 400]
    ]);
    expect(r.lines.at(-1)!.cells[1]!.v).toBe(550);
  });

  it('builds a cross-tab with row and column totals, and folds columns beyond the cap into Other', () => {
    const r = computeReport({ def: def({ layout: { kind: 'crosstab', rows: ['stage'], column: 'region', values: [{ op: 'sum', column: 'amount' }], maxColumns: 2 } }), columns: cols, rows, truncated: false, params: {} });
    expect(r.columns.map((c) => c.title)).toEqual(['Stage', 'East', 'North', 'Other', 'Total']);
    expect(r.columnsFolded).toBe(1);
    expect(r.lines.map(text)).toEqual([
      ['Lead', 50, null, 300, 350],
      ['Won', 75, 25, 100, 200],
      ['Total', 125, 25, 400, 550]
    ]);
    // two values per column
    const two = computeReport({ def: def({ layout: { kind: 'crosstab', rows: ['region'], column: 'stage', values: [{ op: 'count' }, { op: 'max', column: 'amount' }], rowTotals: false } }), columns: cols, rows, truncated: false, params: {} });
    expect(two.columns.map((c) => c.title)).toEqual(['Region', 'Lead · Count', 'Lead · Max of Amount', 'Won · Count', 'Won · Max of Amount']);
    expect(two.lines.map(text)).toEqual([
      ['East', 1, 50, 1, 75],
      ['North', 0, null, 1, 25],
      ['West', 1, 300, 1, 100],
      ['Total', 2, 300, 3, 100]
    ]);
  });

  it('computes columns with the formula language, sorts by them and formats from the rule vocabulary', () => {
    const r = computeReport({
      def: def({
        computed: [{ name: 'tax', title: 'Tax', formula: 'Round(amount * 0.2, 2)' }, { name: 'band', formula: "If(tax >= 20, 'high', 'low')" }],
        columns: [{ key: 'title' }, { key: 'amount' }, { key: 'tax' }, { key: 'band' }],
        sort: [{ column: 'tax', dir: 'desc' }],
        formatting: [
          { column: 'amount', when: 'gte', value: 100, style: 'good', icon: 'up', text: 'big' },
          { column: 'band', when: 'eq', value: 'low', style: 'muted' }
        ]
      }),
      columns: cols,
      rows,
      truncated: false,
      params: {}
    });
    expect(r.lines.map(text)).toEqual([
      ['C', 300, 60, 'high'],
      ['A', 100, 20, 'high'],
      ['E', 75, 15, 'low'],
      ['B', 50, 10, 'low'],
      ['D', 25, 5, 'low']
    ]);
    expect(r.lines[0]!.cells[1]!.fmt).toBe(0);
    expect(r.lines[2]!.cells[1]!.fmt).toBeUndefined();
    expect(r.lines[2]!.cells[3]!.fmt).toBe(1);
    expect(r.formats[0]).toEqual({ style: 'good', icon: 'up', text: 'big' });
    expect(r.columns.find((c) => c.key === 'tax')).toMatchObject({ type: 'number', computed: true, title: 'Tax' });
    // a bad formula or column is a 400 that says what is wrong
    expect(() => computeReport({ def: def({ computed: [{ name: 'x', formula: 'nope + 1' }] }), columns: cols, rows, truncated: false, params: {} })).toThrow(/x: nope is not a field/);
    expect(() => computeReport({ def: def({ sort: [{ column: 'missing' }] }), columns: cols, rows, truncated: false, params: {} })).toThrow(/Sort: missing is not a column/);
  });

  it('keeps masked columns masked through totals, computed columns, grouping and formatting', () => {
    const masked: SourceColumn[] = cols.map((c) => (c.key === 'amount' ? { ...c, masked: true } : c));
    const shown = rows.map((r) => ({ ...r, amount: '***' }));
    const r = computeReport({ def: def({ computed: [{ name: 'double', formula: 'amount * 2' }], layout: { kind: 'grouped', groupBy: ['region'], aggregates: [{ op: 'sum', column: 'amount' }, { op: 'count' }] }, columns: [{ key: 'title' }, { key: 'amount' }, { key: 'double' }], formatting: [{ column: 'amount', when: 'notEmpty', style: 'bad', text: 'x' }] }), columns: masked, rows: shown, truncated: false, params: {} });
    const row = r.lines.find((l) => l.kind === 'row')!;
    expect(row.cells[1]).toEqual({ v: '***', masked: true });
    expect(row.cells[2]).toEqual({ v: null, masked: true });
    expect(r.lines.filter((l) => l.kind !== 'row' && l.kind !== 'group').every((l) => l.cells[1]!.masked && l.cells[1]!.v === null)).toBe(true);
    expect(r.lines.some((l) => l.cells.some((c) => c.fmt !== undefined))).toBe(false);
    expect(r.columns.find((c) => c.key === 'double')!.masked).toBe(true);
    // grouping by a masked column puts every row in one group
    const g = computeReport({ def: def({ layout: { kind: 'grouped', groupBy: ['amount'], aggregates: [{ op: 'count' }] } }), columns: masked, rows: shown, truncated: false, params: {} });
    expect(g.lines.filter((l) => l.kind === 'group').map((l) => l.label)).toEqual(['Amount: (masked)']);
  });

  it('binds typed parameters with defaults and refuses the rest', () => {
    const defs = reportDefinitionSchema.parse({
      title: 'T',
      source: { kind: 'entity', entity: 'deal', filters: [{ field: 'amount', op: 'gte', value: { param: 'min' } }] },
      parameters: [
        { name: 'min', type: 'number', default: 10 },
        { name: 'region', type: 'choice', options: ['West', 'East'], required: true },
        { name: 'since', type: 'date' }
      ]
    }).parameters;
    expect(bindReportParams(defs, { region: 'West' })).toEqual({ min: 10, region: 'West', since: null });
    expect(bindReportParams(defs, { region: 'East', min: '25', since: '2026-01-31' })).toEqual({ min: 25, region: 'East', since: '2026-01-31' });
    expect(() => bindReportParams(defs, {})).toThrow(/region is required/);
    expect(() => bindReportParams(defs, { region: 'South' })).toThrow(/one of West, East/);
    expect(() => bindReportParams(defs, { region: 'West', min: 'lots' })).toThrow(/min is a number/);
    expect(() => bindReportParams(defs, { region: 'West', since: 'yesterday' })).toThrow(/date/);
    expect(() => bindReportParams(defs, { region: 'West', other: 1 })).toThrow(/other is not a parameter/);
    expect(() => reportDefinitionSchema.parse({ title: 'T', source: { kind: 'entity', entity: 'deal', filters: [{ field: 'amount', op: 'gte', value: { param: 'nope' } }] } })).toThrow(/parameter nope/);
  });

  it('caps the lines it lays out and says so', () => {
    const r = computeReport({ def: def({}), columns: cols, rows, truncated: false, params: {}, lineCap: 2 });
    expect(r.lines).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });
});

const dealDefinition = {
  fields: [
    { name: 'title', type: 'string', required: true, indexed: true, unique: true, maxLength: 120 },
    { name: 'amount', type: 'number', indexed: true },
    { name: 'cost', type: 'number' },
    { name: 'region', type: 'string', indexed: true, maxLength: 20 },
    { name: 'stage', type: 'enum', indexed: true, options: [{ value: 'Lead' }, { value: 'Won' }] },
    { name: 'ssn', type: 'string', maxLength: 20 }
  ]
};

describe('reports over the API', () => {
  let h: Harness;
  let wsId: string;

  beforeEach(async () => {
    h = await harness();
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Sales', 'confidential')).id;
  });
  afterEach(async () => {
    await h.close();
  });

  async function wrap(c: { agent: Client['agent']; csrf: string }) {
    const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
    await send('put', '/api/me/workspace', { workspaceId: wsId }).expect(200);
    return { ...c, post: (p: string, b?: object) => send('post', p, b), patch: (p: string, b?: object) => send('patch', p, b), del: (p: string) => send('delete', p), get: (p: string) => c.agent.get(p) };
  }
  async function member(name: string, attributes: Record<string, string> | null = null) {
    const u = await localUser(h, name, ['member'], 'confidential');
    await h.s.tenants.addMember(wsId, u.id);
    if (attributes) await h.s.users.update(h.tenantId, u.id, { attributes: JSON.stringify(attributes) });
    return { user: u, ...(await wrap(await login(h, name))) };
  }
  async function designer(name = 'dee') {
    const u = await localUser(h, name, ['workflow-admin', 'member'], 'confidential');
    await h.s.tenants.addMember(wsId, u.id);
    return { user: u, ...(await wrap(await loginAdmin(h, name))) };
  }
  type C = Awaited<ReturnType<typeof designer>>;
  async function setup(d: C) {
    await d.post('/api/apps', { name: 'crm', title: 'CRM', label: 'confidential', workspaceId: wsId }).expect(201);
    await d.post('/api/apps/crm/entities', { name: 'deal', title: 'Deal', label: 'internal', definition: dealDefinition }).expect(201);
    const recs = [
      { title: 'Acme', amount: 100, cost: 10, region: 'West', stage: 'Won', ssn: '111-22-3333' },
      { title: 'Bolt', amount: 50, cost: 5, region: 'East', stage: 'Lead', ssn: '222-33-4444' },
      { title: 'Crux', amount: 300, cost: 30, region: 'West', stage: 'Lead', ssn: '333-44-5555' },
      { title: 'Dyne', amount: 25, cost: 2, region: 'North', stage: 'Won', ssn: '444-55-6666' },
      { title: 'Echo', amount: 75, cost: 7, region: 'East', stage: 'Won', ssn: '555-66-7777' }
    ];
    for (const values of recs) await d.post('/api/apps/crm/entities/deal/records', { values }).expect(201);
  }
  const R = '/api/apps/crm/reports';
  const audits = async (action: string) => (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action })) as { target: string; detail: string | null; label: string }[];
  const byRegion = {
    title: 'Pipeline by region',
    notes: 'Open and won deals.',
    source: { kind: 'entity', entity: 'deal', filters: [{ field: 'amount', op: 'gte', value: { param: 'min' } }] },
    parameters: [{ name: 'min', title: 'Smallest amount', type: 'number', default: 0 }],
    columns: [{ key: 'title' }, { key: 'amount' }, { key: 'ssn' }, { key: 'margin' }],
    computed: [{ name: 'margin', title: 'Margin', formula: 'amount - cost' }],
    layout: { kind: 'grouped', groupBy: ['region'], aggregates: [{ op: 'count' }, { op: 'sum', column: 'amount' }, { op: 'sum', column: 'margin' }] },
    sort: [{ column: 'amount', dir: 'desc' }],
    formatting: [{ column: 'amount', when: 'gte', value: 100, style: 'good', icon: 'up', text: 'large' }]
  };
  const total = (lines: ReportLine[]) => lines.find((l) => l.kind === 'total')!;

  it('keeps definitions sealed, audited and designer-only, and runs them as the designer with parameters', async () => {
    const dee = await designer();
    const mia = await member('mia');
    await setup(dee);
    // a reader cannot create, change or preview a report
    await mia.post(R, { name: 'pipeline', definition: byRegion }).expect(403);
    await mia.post(`${R}/preview`, { definition: byRegion }).expect(403);

    const created = (await dee.post(R, { name: 'pipeline', definition: byRegion }).expect(201)).body;
    expect(created).toMatchObject({ name: 'pipeline', title: 'Pipeline by region', label: 'internal', sourceKind: 'entity', version: 1, canEdit: true, needs: ['records:read'] });
    const row = await h.s.db('app_reports').where({ id: created.id }).first();
    expect(String(row.data)).not.toContain('Pipeline');
    expect(String(row.data)).not.toContain('margin');
    expect((await audits('app.report.created'))[0]!.detail).not.toContain('Pipeline');
    await dee.post(R, { name: 'pipeline', definition: byRegion }).expect(409);
    // problems in the definition are 400s naming them
    expect((await dee.post(R, { name: 'bad', definition: { ...byRegion, layout: { kind: 'grouped', groupBy: ['nowhere'] } } }).expect(400)).body.detail).toMatch(/Group by: nowhere is not a column/);
    expect((await dee.post(R, { name: 'bad', definition: { ...byRegion, source: { kind: 'entity', entity: 'deal', filters: [{ field: 'cost', op: 'gt', value: 1 }] } } }).expect(400)).body.detail).toMatch(/cost is not indexed/);

    // the reader lists it and runs it
    expect((await mia.get(R).expect(200)).body.reports.map((x: { name: string }) => x.name)).toEqual(['pipeline']);
    const run = (await dee.post(`${R}/pipeline/run`, {}).expect(200)).body;
    expect(run.run).toMatchObject({ state: 'succeeded', params: { min: 0 }, rows: 5, truncated: false, cached: true, label: 'internal' });
    const t = total(run.result.lines);
    expect(t.cells.map((c: { v: unknown }) => c.v)).toEqual([null, 550, null, 496]);
    expect(t.label).toBe('Grand total (5 rows)');
    expect(run.result.lines.filter((l: ReportLine) => l.kind === 'group').map((l: ReportLine) => l.label)).toEqual(['region: East', 'region: North', 'region: West']);
    expect(run.result.lines.find((l: ReportLine) => l.kind === 'row').cells[1]).toEqual({ v: 75 });
    expect(run.result.lines.find((l: ReportLine) => l.kind === 'row' && l.cells[0]!.v === 'Crux').cells[1]).toEqual({ v: 300, fmt: 0 });

    // a parameter narrows the rows through the source's filter
    const big = (await dee.post(`${R}/pipeline/run`, { params: { min: 75 } }).expect(200)).body;
    expect(big.run.rows).toBe(3);
    expect(total(big.result.lines).cells[1]!.v).toBe(475);
    await dee.post(`${R}/pipeline/run`, { params: { min: 'many' } }).expect(400);
    await dee.post(`${R}/pipeline/run`, { params: { other: 1 } }).expect(400);

    // a change bumps the version (and refuses a stale one) and is audited
    const changed = (await dee.patch(`${R}/pipeline`, { version: 1, definition: { ...byRegion, title: 'By region' } }).expect(200)).body;
    expect(changed.version).toBe(2);
    await dee.patch(`${R}/pipeline`, { version: 1, label: 'confidential' }).expect(409);
    expect(await audits('app.report.updated')).toHaveLength(1);
    expect((await audits('app.report.run')).length).toBeGreaterThanOrEqual(2);
    expect(await audits('app.report.run.failed')).toHaveLength(2);
    await mia.del(`${R}/pipeline`).expect(403);
    await dee.del(`${R}/pipeline`).expect(204);
    expect(await h.s.db('app_report_runs').where({ report_id: created.id })).toEqual([]);
    expect(await audits('app.report.deleted')).toHaveLength(1);
  });

  it('runs as the viewer: a hidden row never counts in a total and masked values stay masked', async () => {
    const dee = await designer();
    const ana = await member('ana', { region: 'West' });
    await setup(dee);
    await dee.post('/api/apps/crm/policies', { name: 'Own region', entity: 'deal', subjects: [{ kind: 'role', value: 'member' }], rows: { field: 'region', op: 'eq', value: '$user.attributes.region' }, fields: { ssn: { unmasked: false, mask: 'last4' }, cost: { read: false } } }).expect(201);
    await dee.post(R, { name: 'pipeline', definition: byRegion }).expect(201);
    await dee.post(R, { name: 'costs', definition: { title: 'Costs', source: { kind: 'entity', entity: 'deal' }, columns: [{ key: 'title' }, { key: 'cost' }], layout: { kind: 'grouped', groupBy: ['stage'], aggregates: [{ op: 'sum', column: 'cost' }] }, formatting: [{ column: 'cost', when: 'gt', value: 5, style: 'bad', text: 'high' }] } }).expect(201);

    const run = (await ana.post(`${R}/pipeline/run`, {}).expect(200)).body;
    const lines: ReportLine[] = run.result.lines;
    expect(lines.filter((l) => l.kind === 'group').map((l) => l.label)).toEqual(['region: West']);
    expect(lines.filter((l) => l.kind === 'row').map((l) => l.cells[0]!.v)).toEqual(['Crux', 'Acme']);
    // the grand total is West's alone: 400, never the 550 of every region
    expect(total(lines).cells[1]!.v).toBe(400);
    expect(total(lines).count).toBe(2);
    // the masked ssn shows its last four, and nothing reads cost (margin reads it, so it is masked too)
    const crux = lines.find((l) => l.kind === 'row' && l.cells[0]!.v === 'Crux')!;
    expect(crux.cells[2]).toEqual({ v: '***-**-5555', masked: true });
    expect(crux.cells[3]).toEqual({ v: null, masked: true });
    expect(total(lines).cells[3]).toEqual({ v: null, masked: true });
    expect(run.result.columns.find((c: { key: string }) => c.key === 'margin').masked).toBe(true);

    const costs = (await ana.post(`${R}/costs/run`, {}).expect(200)).body.result;
    expect(costs.lines.every((l: ReportLine) => l.kind === 'group' || l.cells[1]!.masked)).toBe(true);
    expect(costs.lines.some((l: ReportLine) => l.cells.some((c) => c.fmt !== undefined))).toBe(false);
    // the designer reads everything
    const all = (await dee.post(`${R}/costs/run`, {}).expect(200)).body.result;
    expect(total(all.lines).cells[1]!.v).toBe(54);
  });

  it('caps the rows it reads, previews 200 lines at most, and builds a cross-tab', async () => {
    const dee = await designer();
    await setup(dee);
    await dee.post(R, { name: 'capped', definition: { title: 'Capped', source: { kind: 'entity', entity: 'deal' }, rowCap: 2 } }).expect(201);
    const capped = (await dee.post(`${R}/capped/run`, {}).expect(200)).body;
    expect(capped.run).toMatchObject({ rows: 2, truncated: true });
    expect(capped.result).toMatchObject({ truncated: true, rowCap: 2, rowsRead: 2 });

    const cross = { title: 'Stage by region', source: { kind: 'entity', entity: 'deal' }, layout: { kind: 'crosstab', rows: ['stage'], column: 'region', values: [{ op: 'sum', column: 'amount' }], maxColumns: 2 } };
    const preview = (await dee.post(`${R}/preview`, { definition: cross }).expect(200)).body;
    expect(preview.preview).toBe(true);
    expect(preview.result.columns.map((c: { title: string }) => c.title)).toEqual(['stage', 'East', 'North', 'Other', 'Total']);
    expect(preview.result.columnsFolded).toBe(1);
    expect(preview.result.lines.at(-1).cells.map((c: { v: unknown }) => c.v)).toEqual(['Total', 125, 25, 400, 550]);
    // the preview is not recorded
    expect(await h.s.db('app_report_runs')).toHaveLength(1);

    for (let i = 0; i < 205; i++) await dee.post('/api/apps/crm/entities/deal/records', { values: { title: `Bulk ${i}`, amount: i, region: 'South', stage: 'Lead' } }).expect(201);
    const big = (await dee.post(`${R}/preview`, { definition: { title: 'All', source: { kind: 'entity', entity: 'deal' } } }).expect(200)).body;
    expect(big.result.lines).toHaveLength(200);
    expect(big.result.truncated).toBe(true);
  }, 60_000);

  it('keeps a run history with parameters and a sealed result that expires', async () => {
    const dee = await designer();
    const mia = await member('mia');
    await setup(dee);
    await dee.post(R, { name: 'pipeline', definition: { ...byRegion, cacheMinutes: 5 } }).expect(201);
    const mine = (await mia.post(`${R}/pipeline/run`, { params: { min: 60 } }).expect(200)).body.run;
    await dee.post(`${R}/pipeline/run`, {}).expect(200);
    const stored = await h.s.db('app_report_runs').where({ id: mine.id }).first();
    expect(String(stored.result)).not.toContain('Acme');
    // Sealed (v2.<key>.<iv>.<ciphertext>.<tag>, base64url): no JSON of the parameters. A check for "60" alone failed
    // whenever the random ciphertext happened to hold those two characters (QA-1).
    expect(String(stored.params)).toMatch(/^v2\.[A-Za-z0-9_.-]+$/);
    expect(String(stored.params)).not.toMatch(/[{}":]/);

    const history = (await mia.get(`${R}/pipeline/runs`).expect(200)).body;
    expect(history.runs).toHaveLength(1);
    expect(history.runs[0]).toMatchObject({ id: mine.id, params: { min: 60 }, rows: 3, cached: true, state: 'succeeded' });
    // a designer may see everyone's; a reader asking for all still sees their own
    expect((await dee.get(`${R}/pipeline/runs?all=1`).expect(200)).body.runs).toHaveLength(2);
    expect((await mia.get(`${R}/pipeline/runs?all=1`).expect(200)).body.runs).toHaveLength(1);

    const cached = (await mia.get(`${R}/pipeline/runs/${mine.id}`).expect(200)).body;
    expect(cached.result.rowsRead).toBe(3);
    // only the person who ran it reads the result
    await dee.get(`${R}/pipeline/runs/${mine.id}`).expect(404);
    // the sweep clears it once expired; the history row stays
    expect(await h.s.appReports.sweep(Date.now() + 6 * 60_000)).toBe(2);
    await mia.get(`${R}/pipeline/runs/${mine.id}`).expect(410);
    expect((await mia.get(`${R}/pipeline/runs`).expect(200)).body.runs[0]).toMatchObject({ id: mine.id, cached: false });
    // no cache at all when the report says 0 minutes
    await dee.patch(`${R}/pipeline`, { definition: { ...byRegion, cacheMinutes: 0 } }).expect(200);
    const nocache = (await mia.post(`${R}/pipeline/run`, {}).expect(200)).body.run;
    expect(nocache.cached).toBe(false);
    expect((await h.s.db('app_report_runs').where({ id: nocache.id }).first()).result).toBeNull();
  });

  it('reads saved-query sources as the viewer, who needs connections:query', async () => {
    const dee = await designer();
    const mia = await member('mia');
    await setup(dee);
    const calls: { user: string; query: string; params: unknown; ceiling: unknown }[] = [];
    const sq = h.s.savedQueries as unknown as Record<string, unknown>;
    sq.get = async (_t: string, ref: string) => ({ id: '01J00000000000000000000000', name: ref, label: 'internal' });
    sq.run = async (p: { username: string }, query: string, params: unknown, o: { ceiling?: unknown }) => {
      calls.push({ user: p.username, query, params, ceiling: o.ceiling });
      return { columns: [{ name: 'tier', type: 'string' }, { name: 'balance', type: 'number' }, { name: 'email', type: 'string' }], rows: [{ tier: 'gold', balance: 10, email: 'a***' }, { tier: 'gold', balance: 5, email: 'b***' }, { tier: 'silver', balance: 1, email: 'c***' }], truncated: false, label: 'internal', masked: ['email'], ms: 1 };
    };
    const q = { title: 'Balances', source: { kind: 'query', query: 'balances', params: { tier: { param: 'tier' } } }, parameters: [{ name: 'tier', type: 'text' }], layout: { kind: 'grouped', groupBy: ['tier'], aggregates: [{ op: 'sum', column: 'balance' }] } };
    const made = (await dee.post(R, { name: 'balances', definition: q }).expect(201)).body;
    expect(made.needs).toEqual(['records:read', 'connections:query']);
    // a reader without connections:query may see it but not run it
    expect((await mia.get(R).expect(200)).body.reports[0].canRun).toBe(false);
    expect((await mia.post(`${R}/balances/run`, {}).expect(403)).body.detail).toMatch(/connections:query/);
    const run = (await dee.post(`${R}/balances/run`, { params: { tier: 'gold' } }).expect(200)).body;
    expect(calls.at(-1)).toEqual({ user: 'dee', query: 'balances', params: { tier: 'gold' }, ceiling: 'confidential' });
    expect(total(run.result.lines).cells.find((c: { v: unknown }) => c.v === 16)).toBeTruthy();
    expect(run.result.columns.find((c: { key: string }) => c.key === 'email').masked).toBe(true);
    // an empty parameter is left out of the query's parameters
    await dee.post(`${R}/balances/run`, {}).expect(200);
    expect(calls.at(-1)!.params).toEqual({});
  });
});
