import { inflateSync } from 'node:zlib';
import type { Test } from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderReport } from '../src/apps/export-render.js';
import { computeReport, reportDefinitionSchema } from '../src/apps/report-engine.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { columnName, dateSerial, toXlsx } from '../src/imports/xlsx-writer.js';
import { xlsxRows } from '../src/imports/xlsx.js';
import { zipBytes, zipEntries } from '../src/imports/zip.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';
import { drain } from './retrieval-seed.js';

/*
 * 1.8.0, Sprint 44 (B-123): XLSX, PDF, CSV and HTML exports of records, saved views, reports and dashboards. The XLSX
 * writer's parts and typed cells (read back by imports/xlsx.ts), the PDF (structure, page setup, pages, text), the
 * CSV, masked values exported masked, a large export as a job with progress landing in a sealed file only its
 * requester downloads, and `s.appExports.render` for each kind.
 */

const binary = (t: Test) =>
  t.buffer(true).parse((res, cb) => {
    const b: Buffer[] = [];
    res.on('data', (c: Buffer) => b.push(c));
    res.on('end', () => cb(null, Buffer.concat(b)));
  });

const unpack = () => ({ used: 0, max: 50_000_000 });
async function parts(buf: Buffer): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const e of zipEntries(buf)) out.set(e.name, (await zipBytes(buf, e, unpack())).toString('utf8'));
  return out;
}
async function sheetRows(buf: Buffer, sheet?: string): Promise<unknown[][]> {
  const rows: unknown[][] = [];
  for await (const r of xlsxRows(buf, { unpack: unpack(), ...(sheet ? { sheet } : {}) })) rows.push(r.values);
  return rows;
}

/** The text drawn on a PDF's pages (its content streams inflated, the literal strings joined). */
function pdfText(pdf: Buffer): string {
  const s = pdf.toString('latin1');
  const out: string[] = [];
  const re = /\/Filter \/FlateDecode \/Length (\d+) >>\nstream\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    try {
      const txt = inflateSync(pdf.subarray(start, start + Number(m[1]))).toString('latin1');
      for (const t of txt.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)) out.push(t[1]!.replace(/\\(.)/g, '$1'));
    } catch {
      /* an image stream */
    }
  }
  return out.join(' ');
}

describe('the xlsx writer', () => {
  it('writes the parts of a workbook with typed cells, a frozen header, widths and outline levels', async () => {
    const when = new Date('2026-03-04T05:06:00Z');
    const buf = toXlsx({
      title: 'T & Co',
      sheets: [
        {
          name: 'Deals: <all>',
          columns: [{ title: 'Name' }, { title: 'Amount', width: 12 }, { title: 'Closed', type: 'date' }, { title: 'Won', type: 'boolean' }, { title: 'At', type: 'datetime' }],
          rows: [
            { cells: ['West', null, null, null, null], kind: 'group', level: 0 },
            { cells: ['=1+2', 12.5, '2026-01-31', true, when], level: 1 },
            { cells: ['A & <B>', -3, '2026-02-01', false, '2026-02-01T10:30:00Z'], level: 1 },
            { cells: ['Subtotal', 9.5, null, null, null], kind: 'subtotal', level: 0 }
          ]
        },
        { name: 'Deals: <all>', columns: [{ title: 'x' }], rows: [] }
      ]
    });
    const p = await parts(buf);
    expect([...p.keys()].sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'docProps/app.xml', 'docProps/core.xml', 'xl/_rels/workbook.xml.rels', 'xl/sharedStrings.xml', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']);
    const wb = p.get('xl/workbook.xml')!;
    // sheet names a spreadsheet accepts, unique
    expect(wb).toContain('<sheet name="Deals  &lt;all&gt;" sheetId="1" r:id="rId1"/>');
    expect(wb).toContain('<sheet name="Deals  &lt;all&gt; (2)" sheetId="2"');
    const sheet = p.get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    expect(sheet).toContain('<col min="2" max="2" width="12" customWidth="1"/>');
    expect(sheet).toContain('outlineLevelRow="1"');
    expect(sheet).toContain('<row r="3" outlineLevel="1">');
    // a number, a boolean, a date and a date-time as typed cells; text through the shared strings, never a formula
    expect(sheet).toContain('<c r="B3"><v>12.5</v></c>');
    expect(sheet).toContain('<c r="D3" t="b"><v>1</v></c>');
    expect(sheet).toContain(`<c r="C3" s="2"><v>${dateSerial(new Date('2026-01-31T00:00:00Z'))}</v></c>`);
    expect(sheet).toContain(`<c r="E3" s="3"><v>${dateSerial(when)}</v></c>`);
    expect(sheet).not.toContain('<f>');
    // group and subtotal rows are bold (style 4)
    expect(sheet).toContain('<c r="A2" s="4" t="s">');
    expect(sheet).toContain('<c r="B5" s="4"><v>9.5</v></c>');
    expect(p.get('xl/sharedStrings.xml')).toContain('<t>A &amp; &lt;B&gt;</t>');
    expect(p.get('[Content_Types].xml')).toContain('/xl/worksheets/sheet2.xml');
    // read back by the importer's reader
    const rows = await sheetRows(buf);
    expect(rows[0]).toEqual(['Name', 'Amount', 'Closed', 'Won', 'At']);
    expect(rows[2]).toEqual(['=1+2', 12.5, '2026-01-31', true, '2026-03-04T05:06:00']);
    expect(rows[3]).toEqual(['A & <B>', -3, '2026-02-01', false, '2026-02-01T10:30:00']);
    expect(columnName(0)).toBe('A');
    expect(columnName(27)).toBe('AB');
  });
});

describe('report renderings', () => {
  const def = reportDefinitionSchema.parse({ title: 'Pipeline', notes: 'Deals by region.', source: { kind: 'entity', entity: 'deal' }, layout: { kind: 'grouped', groupBy: ['region'], aggregates: [{ op: 'sum', column: 'amount' }] }, formatting: [{ column: 'amount', when: 'gt', value: 100, style: 'good', icon: 'up', text: 'large' }], page: { size: 'letter', orientation: 'landscape' } });
  const rows = Array.from({ length: 120 }, (_, i) => ({ title: `Deal <${i}>`, region: i % 2 ? 'West' : 'East', amount: i * 3 }));
  const result = computeReport({ def, columns: [{ key: 'title', title: 'Title', type: 'text' }, { key: 'region', title: 'Region', type: 'text' }, { key: 'amount', title: 'Amount', type: 'number' }], rows, truncated: false, params: { min: 3 } });
  const meta = { label: 'internal', by: 'dee', subtitle: 'Report pipeline in CRM' };

  it('writes a valid PDF with the page setup, the header on every page and the formatting in words', () => {
    const pdf = renderReport(result, 'pdf', meta);
    const s = pdf.toString('latin1');
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
    const at = Number(/startxref\n(\d+)\n/.exec(s)![1]);
    expect(s.slice(at, at + 4)).toBe('xref');
    // every object the cross-reference table points at starts there
    const count = Number(/xref\n0 (\d+)\n/.exec(s)![1]);
    const offsets = s.slice(at).split('\n').slice(3, 2 + count).map((l) => Number(l.slice(0, 10)));
    offsets.forEach((o, i) => expect(s.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    // US Letter landscape, more than one page
    expect(s).toContain('/MediaBox [0 0 792 612]');
    const pages = Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(s)![1]);
    expect(pages).toBeGreaterThan(1);
    const text = pdfText(pdf);
    expect(text).toContain('Pipeline');
    expect(text).toContain('Deal <7>');
    expect(text).toContain('Grand total');
    expect(text).toContain('[large]');
    expect(text.split('Amount').length - 1).toBeGreaterThanOrEqual(pages);
  });

  it('writes CSV with a group column and inert cells, and a self-contained HTML page', () => {
    const evil = computeReport({ def: reportDefinitionSchema.parse({ title: 'x', source: { kind: 'entity', entity: 'deal' } }), columns: [{ key: 'title', title: 'Title', type: 'text' }], rows: [{ title: '=HYPERLINK("x")' }, { title: 'a,b' }], truncated: false, params: {} });
    expect(renderReport(evil, 'csv', meta).toString('utf8')).toBe('Title\r\n"\'=HYPERLINK(""x"")"\r\n"a,b"\r\n');
    const csv = renderReport(result, 'csv', meta).toString('utf8').split('\r\n');
    expect(csv[0]).toBe('Group,Title,Amount');
    expect(csv[1]).toBe('Region: East,,');
    expect(csv.at(-2)).toBe('Grand total,,21420');
    const html = renderReport(result, 'html', meta).toString('utf8');
    expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'"`);
    expect(html).toContain('Deal &lt;7&gt;');
    expect(html).not.toContain('Deal <7>');
    expect(html).toMatch(/<span class="f f-good"><span aria-hidden="true">▲<\/span> \d+<\/span><span class="ft">large<\/span>/);
    expect(html).toContain('<th scope="rowgroup"');
    expect(html).toContain('prefers-color-scheme:dark');
  });
});

const dealDefinition = {
  fields: [
    { name: 'title', type: 'string', title: 'Title', required: true, indexed: true, unique: true, maxLength: 120 },
    { name: 'amount', type: 'number', title: 'Amount', indexed: true },
    { name: 'region', type: 'string', title: 'Region', indexed: true, maxLength: 20 },
    { name: 'closed', type: 'date', title: 'Closed' },
    { name: 'ssn', type: 'string', title: 'SSN', maxLength: 20 }
  ]
};

describe('exports over the API', () => {
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
    return { ...c, post: (p: string, b?: object) => send('post', p, b), get: (p: string) => c.agent.get(p) };
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
    const ent = (await d.post('/api/apps/crm/entities', { name: 'deal', title: 'Deal', label: 'internal', definition: dealDefinition }).expect(201)).body;
    const recs = [
      { title: 'Acme', amount: 100, region: 'West', closed: '2026-01-15', ssn: '111-22-3333' },
      { title: '=cmd|calc', amount: 50, region: 'East', closed: '2026-02-01', ssn: '222-33-4444' },
      { title: 'Crux', amount: 300, region: 'West', closed: '2026-03-10', ssn: '333-44-5555' }
    ];
    for (const values of recs) await d.post('/api/apps/crm/entities/deal/records', { values }).expect(201);
    return ent.id as string;
  }
  const X = '/api/apps/crm/exports';
  const audits = async (action: string) => (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action })) as { detail: string | null }[];

  it('downloads records as XLSX with typed cells and CSV, filtered as on screen', async () => {
    const dee = await designer();
    const entityId = await setup(dee);
    const res = await binary(dee.post(`${X}/download`, { kind: 'records', id: 'deal', format: 'xlsx', filters: { filter: { field: 'amount', op: 'gte', value: 60 }, sort: [{ field: 'amount', dir: 'desc' }] } })).expect(200);
    expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="deal-\d{4}-\d{2}-\d{2}\.xlsx"$/);
    const rows = await sheetRows(res.body as Buffer);
    expect(rows[0]).toEqual(['Id', 'Label', 'Created', 'Updated', 'Title', 'Amount', 'Region', 'Closed', 'SSN']);
    expect(rows.slice(1).map((r) => [r[4], r[5], r[7]])).toEqual([
      ['Crux', 300, '2026-03-10'],
      ['Acme', 100, '2026-01-15']
    ]);
    const sheet = (await parts(res.body as Buffer)).get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toMatch(/<c r="F2"><v>300<\/v><\/c>/);
    expect(sheet).toMatch(/<c r="H2" s="2"><v>\d+<\/v><\/c>/);
    // the About sheet says what the file is
    const about = await sheetRows(res.body as Buffer, 'About');
    expect(about.find((r) => r[0] === 'Made for')![1]).toBe('dee');
    expect((await audits('app.export.rendered'))[0]!.detail).toContain('"format":"xlsx"');

    const csv = (await binary(dee.post(`${X}/download`, { kind: 'records', id: entityId, format: 'csv' })).expect(200)).body.toString('utf8');
    expect(csv.split('\r\n')[0]).toBe('Id,Label,Created,Updated,Title,Amount,Region,Closed,SSN');
    expect(csv).toContain(",'=cmd|calc,50,");
    await dee.post(`${X}/download`, { kind: 'records', id: 'deal', format: 'docx' }).expect(400);
    await dee.post(`${X}/download`, { kind: 'records', id: 'deal', format: 'csv', filters: { filter: { field: 'ssn', op: 'eq', value: 'x' } } }).expect(400);
  });

  it('exports masked values masked and leaves out rows a policy hides', async () => {
    const dee = await designer();
    const ana = await member('ana', { region: 'West' });
    await setup(dee);
    await dee.post('/api/apps/crm/policies', { name: 'Own region', entity: 'deal', subjects: [{ kind: 'role', value: 'member' }], rows: { field: 'region', op: 'eq', value: '$user.attributes.region' }, fields: { ssn: { unmasked: false, mask: 'last4' } } }).expect(201);
    const csv = (await binary(ana.post(`${X}/download`, { kind: 'records', id: 'deal', format: 'csv' })).expect(200)).body.toString('utf8');
    expect(csv).toContain('***-**-3333');
    expect(csv).toContain('***-**-5555');
    expect(csv).not.toContain('111-22-3333');
    expect(csv).not.toContain('calc');
    const xlsx = (await binary(ana.post(`${X}/download`, { kind: 'records', id: 'deal', format: 'xlsx' })).expect(200)).body as Buffer;
    const strings = (await parts(xlsx)).get('xl/sharedStrings.xml')!;
    expect(strings).toContain('***-**-5555');
    expect(strings).not.toContain('333-44-5555');
    const pdf = (await binary(ana.post(`${X}/download`, { kind: 'records', id: 'deal', format: 'pdf' })).expect(200)).body as Buffer;
    expect(pdfText(pdf)).toContain('***-**-5555');
    expect(pdfText(pdf)).not.toContain('333-44-5555');
  });

  it('runs a large export as a job with progress into a sealed file only its requester downloads', async () => {
    const dee = await designer();
    const mia = await member('mia');
    await setup(dee);
    for (let i = 0; i < 40; i++) await dee.post('/api/apps/crm/entities/deal/records', { values: { title: `Bulk ${i}`, amount: i, region: 'South' } }).expect(201);
    const queued = (await dee.post(X, { kind: 'records', id: 'deal', format: 'pdf', filters: { q: 'bulk' } }).expect(202)).body;
    expect(queued).toMatchObject({ kind: 'records', format: 'pdf', state: 'queued' });
    expect(String((await h.s.db('app_exports').where({ id: queued.id }).first()).input)).not.toContain('bulk');
    await dee.get(`${X}/${queued.id}/download`).expect(409);
    await drain(h);
    const done = (await dee.get(`${X}/${queued.id}`).expect(200)).body;
    expect(done).toMatchObject({ state: 'ready', rows: 40, truncated: false });
    expect(done.file).toMatch(/^deal-\d{4}-\d{2}-\d{2}\.pdf$/);
    const job = await h.s.db('jobs').where({ id: queued.jobId }).first();
    expect(Number(job.progress)).toBe(100);
    // sealed at rest
    const row = await h.s.db('app_exports').where({ id: queued.id }).first();
    const blob = (await h.s.blobs.get(String(row.blob_key)))!;
    expect(blob.toString('latin1')).not.toContain('%PDF');
    const file = await binary(dee.get(`${X}/${queued.id}/download`)).expect(200);
    expect((file.body as Buffer).subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    expect(pdfText(file.body as Buffer)).toContain('Bulk 39');
    // somebody else does not see it
    await mia.get(`${X}/${queued.id}`).expect(404);
    await mia.get(`${X}/${queued.id}/download`).expect(404);
    expect((await dee.get(X).expect(200)).body.exports.map((e: { id: string }) => e.id)).toEqual([queued.id]);
    expect(await audits('app.export.queued')).toHaveLength(1);
    expect(await audits('app.export.ready')).toHaveLength(1);
    expect(await audits('app.export.downloaded')).toHaveLength(1);
    // the file expires
    expect(await h.s.appExports.sweep(Date.now() + 8 * 86_400_000)).toBe(1);
    await dee.get(`${X}/${queued.id}/download`).expect(410);
  });

  it('deletes the sealed files of an app\'s exports with the app', async () => {
    const dee = await designer();
    await setup(dee);
    const queued = (await dee.post(X, { kind: 'records', id: 'deal', format: 'csv' }).expect(202)).body;
    await drain(h);
    const row = await h.s.db('app_exports').where({ id: queued.id }).first();
    expect(row.blob_key).toBeTruthy();
    expect(await h.s.blobs.get(String(row.blob_key))).toBeTruthy();
    await dee.agent.delete('/api/apps/crm').set('x-csrf-token', dee.csrf).expect(204);
    expect(await h.s.db('app_exports').where({ id: queued.id }).first()).toBeUndefined();
    expect(await h.s.blobs.get(String(row.blob_key))).toBeFalsy();
  });

  it('renders every kind through s.appExports.render as the principal it is given', async () => {
    const dee = await designer();
    const ana = await member('ana', { region: 'West' });
    const entityId = await setup(dee);
    await dee.post('/api/apps/crm/policies', { name: 'Own region', entity: 'deal', subjects: [{ kind: 'role', value: 'member' }], rows: { field: 'region', op: 'eq', value: '$user.attributes.region' } }).expect(201);
    const view = (await dee.post('/api/apps/crm/entities/deal/views', { name: 'Big', shared: true, settings: { layout: 'table', filters: [{ field: 'amount', op: 'gte', value: 60 }], q: '', sort: [{ field: 'amount', dir: 'desc' }], columns: { fields: ['title', 'amount'], meta: [] }, pageSize: 25 } }).expect(201)).body;
    const report = (await dee.post('/api/apps/crm/reports', { name: 'by_region', definition: { title: 'By region', source: { kind: 'entity', entity: 'deal', filters: [{ field: 'amount', op: 'gte', value: { param: 'min' } }] }, parameters: [{ name: 'min', type: 'number', default: 0 }], layout: { kind: 'grouped', groupBy: ['region'], aggregates: [{ op: 'sum', column: 'amount' }] } } }).expect(201)).body;
    const pAna = (await loadPrincipal(h.s, h.tenantId, ana.user.id, {}))!;
    pAna.workspaceId = wsId;
    const pDee = (await loadPrincipal(h.s, h.tenantId, dee.user.id, {}))!;
    pDee.workspaceId = wsId;
    const x = h.s.appExports;

    const recs = await x.render(pDee, { kind: 'records', id: entityId, filters: [{ field: 'region', op: 'eq', value: 'West' }], format: 'csv' });
    expect(recs).toMatchObject({ contentType: 'text/csv; charset=utf-8', rows: 2, truncated: false, label: 'internal' });
    expect(recs.filename).toMatch(/^deal-.*\.csv$/);

    const v = await x.render(pDee, { kind: 'view', id: view.id, format: 'csv' });
    expect(v.bytes.toString('utf8').split('\r\n').slice(0, 3)).toEqual(['Title,Amount', 'Crux,300', 'Acme,100']);
    const vAna = await x.render(pAna, { kind: 'view', id: view.id, filters: [], format: 'xlsx' });
    expect(vAna.rows).toBe(2);
    expect((await sheetRows(vAna.bytes)).slice(1).map((r) => r[0])).toEqual(['Crux', 'Acme']);

    const rep = await x.render(pAna, { kind: 'report', id: report.id, params: { min: 150 }, format: 'html' });
    expect(rep.contentType).toBe('text/html; charset=utf-8');
    expect(rep.bytes.toString('utf8')).toContain('Crux');
    expect(rep.bytes.toString('utf8')).not.toContain('Acme');
    const repDee = await x.render(pDee, { kind: 'report', id: report.id, params: {}, filters: [], format: 'xlsx' });
    expect(repDee.rows).toBe(3);
    await expect(x.render(pAna, { kind: 'report', id: report.id, params: { min: 'x' }, format: 'pdf' })).rejects.toThrow(/min is a number/);

    // dashboards go to the dashboard service's own render, as the same principal (HTML or PDF)
    const dash = h.s.apps as unknown as { dashboards?: { render?: unknown } };
    const calls: unknown[] = [];
    const original = dash.dashboards?.render;
    if (dash.dashboards) {
      dash.dashboards.render = async (p: { username: string }, id: string, o: unknown) => {
        calls.push([p.username, id, o]);
        return { filename: 'd.html', contentType: 'text/html; charset=utf-8', bytes: Buffer.from('<p>dash</p>') };
      };
      const d = await x.render(pAna, { kind: 'dashboard', id: 'D1', filters: [], format: 'html' });
      expect(d).toMatchObject({ filename: 'd.html', rows: 0, truncated: false });
      expect(calls).toEqual([['ana', 'D1', { format: 'html' }]]);
      await expect(x.render(pAna, { kind: 'dashboard', id: 'D1', format: 'xlsx' })).rejects.toThrow(/HTML or PDF/);
      dash.dashboards.render = original;
    }
    // without a dashboard renderer, a clear "not available"
    const saved = dash.dashboards;
    dash.dashboards = undefined;
    await expect(x.render(pAna, { kind: 'dashboard', id: 'D1', format: 'html' })).rejects.toMatchObject({ status: 501 });
    dash.dashboards = saved;

    // a person without records:read renders nothing
    const vic = await localUser(h, 'vic', ['flag-reviewer'], 'confidential');
    const pVic = (await loadPrincipal(h.s, h.tenantId, vic.id, {}))!;
    await expect(x.render(pVic, { kind: 'records', id: entityId, format: 'csv' })).rejects.toMatchObject({ status: 403 });
  });
});
