import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compileFormula, FormulaError } from '../src/apps/formula.js';
import { csvCell } from '../src/apps/service.js';
import { pickFormValues } from '../src/apps/forms.js';
import { checkDefinition, entityDefinitionSchema } from '../src/apps/schema.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { TOPICS } from '../src/platform/bus.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';
import { drain } from './retrieval-seed.js';
import { seedGateway } from './seed-gateway.js';

describe('formulas (B-2203)', () => {
  const fields = new Set(['amount', 'qty', 'name', 'due', 'constructor']);
  const run = (src: string, values: Record<string, unknown> = {}) => compileFormula(src, fields).evaluate(new Map(Object.entries(values)));

  it('evaluates arithmetic, text, logic and dates without eval', () => {
    expect(run('amount * qty + 1', { amount: 2.5, qty: 4 })).toBe(11);
    expect(run("upper(name) & ' #' & text(qty)", { name: 'ada', qty: 3 })).toBe('ADA #3');
    expect(run('if(amount > 10 and not isblank(name), "big", "small")', { amount: 12, name: 'x' })).toBe('big');
    expect(run('round(amount / 3, 2)', { amount: 10 })).toBe(3.33);
    expect(run('amount / 0', { amount: 1 })).toBeNull();
    expect(run('amount + name', { amount: 1, name: 'a' })).toBeNull();
    expect(run("days_between('2026-01-01', due)", { due: '2026-01-31' })).toBe(30);
    expect(run("add_days(due, 2)", { due: '2026-02-27' })).toBe('2026-03-01');
    expect(run('coalesce(name, "none")', {})).toBe('none');
    expect(run('3 = "3"')).toBe(true);
    // a field named like a prototype property reads the record's own value, nothing else
    expect(run('constructor', {})).toBeNull();
    expect(run('constructor', { constructor: 'mine' })).toBe('mine');
  });

  it('cannot reach a global, a prototype or a function outside its list', () => {
    for (const src of ['process', 'globalThis', 'this', 'require', 'Function', '__proto__', 'eval', 'window', 'toString']) expect(() => compileFormula(src, fields), src).toThrow(FormulaError);
    for (const src of ['eval("1")', 'constructor("x")', 'toString()', 'Function("return process")()', 'require("fs")', 'process.exit(1)']) expect(() => compileFormula(src, fields), src).toThrow(FormulaError);
    for (const src of ['name.constructor', 'name["constructor"]', 'name[0]', '`x`', 'a => 1', 'amount; process', '{}']) expect(() => compileFormula(src, fields), src).toThrow(FormulaError);
    expect(() => compileFormula('('.repeat(60) + '1' + ')'.repeat(60), fields)).toThrow(/nested too deeply/);
    expect(() => compileFormula('upper(name, name)', fields)).toThrow(/takes 1 argument/);
  });

  it('is checked when an entity is defined: unknown names and computed fields are refused', () => {
    const def = (expression: string) => entityDefinitionSchema.parse({ fields: [{ name: 'amount', type: 'number' }, { name: 'twice', type: 'formula', expression }, { name: 'other', type: 'formula', expression: 'amount' }] });
    expect(checkDefinition(def('amount * 2'), new Set(['e']))).toEqual([]);
    expect(checkDefinition(def('process'), new Set(['e']))[0]).toMatch(/process is not a field/);
    expect(checkDefinition(def('other + 1'), new Set(['e']))[0]).toMatch(/other is not a field/);
  });
});

describe('forms and CSV helpers', () => {
  it('keeps only listed, visible fields and drops the rest', () => {
    const def = { fields: [{ field: 'kind' }, { field: 'company', visibleIf: { field: 'kind', op: 'eq' as const, value: 'business' } }, { field: 'email' }] };
    expect(pickFormValues(def, { kind: 'person', company: 'Acme', email: 'a@b.c', admin: true })).toEqual({ values: { kind: 'person', email: 'a@b.c' }, dropped: ['company', 'admin'], visible: ['kind', 'email'] });
    expect(pickFormValues(def, { kind: 'Business', company: 'Acme' }).values).toEqual({ kind: 'Business', company: 'Acme' });
  });

  it('quotes CSV cells and makes spreadsheet formulas inert', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-1+2')).toBe("'-1+2");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(3)).toBe('3');
    expect(csvCell(null)).toBe('');
  });
});

describe('low-code apps (Sprint 27b)', () => {
  let h: Harness;
  let wsId: string;
  let events: { type: string; label: string; data: Record<string, unknown> }[];

  beforeEach(async () => {
    h = await harness({ APPS_PUBLIC_FORM_PER_MINUTE: '3' });
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Sales', 'confidential')).id;
    events = [];
    h.s.bus.on<{ type: string; label: string; data: Record<string, unknown> }>(TOPICS.integrationEvent, (e) => void events.push(e));
  });
  afterEach(async () => {
    await h.close();
  });

  type C = Awaited<ReturnType<typeof member>>;
  async function wrap(c: { agent: Client['agent']; csrf: string }) {
    const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
    await send('put', '/api/me/workspace', { workspaceId: wsId }).expect(200);
    return { ...c, post: (p: string, b?: object) => send('post', p, b), patch: (p: string, b?: object) => send('patch', p, b), del: (p: string) => send('delete', p), get: (p: string) => c.agent.get(p) };
  }
  async function member(name: string, clearance: 'internal' | 'confidential' | 'public' = 'internal') {
    const u = await localUser(h, name, ['member'], clearance);
    await h.s.tenants.addMember(wsId, u.id);
    return { user: u, ...(await wrap(await login(h, name))) };
  }
  async function designer(name = 'dee') {
    const u = await localUser(h, name, ['workflow-admin', 'member'], 'confidential');
    await h.s.tenants.addMember(wsId, u.id);
    return { user: u, ...(await wrap(await loginAdmin(h, name))) };
  }

  const dealEntity = {
    name: 'deal',
    title: 'Deal',
    definition: {
      fields: [
        { name: 'title', type: 'string', required: true, indexed: true, unique: true, maxLength: 120 },
        { name: 'amount', type: 'number', indexed: true, min: 0 },
        { name: 'due', type: 'date', indexed: true },
        { name: 'stage', type: 'enum', indexed: true, options: [{ value: 'Lead' }, { value: 'Won' }, { value: 'Lost' }] },
        { name: 'owner', type: 'lookup', source: 'user' },
        { name: 'notes', type: 'string', multiline: true, maxLength: 5000 },
        { name: 'meta', type: 'json' },
        { name: 'twice', type: 'formula', expression: 'amount * 2', indexed: true }
      ],
      states: { initial: 'open', states: [{ name: 'open' }, { name: 'review' }, { name: 'closed' }], transitions: [{ from: ['open'], to: 'review' }, { from: ['review'], to: 'closed' }, { from: ['review'], to: 'open' }] }
    }
  };

  async function setup(d: C) {
    const app = (await d.post('/api/apps', { name: 'crm', title: 'CRM', label: 'confidential', workspaceId: wsId }).expect(201)).body;
    await d.post('/api/apps/crm/entities', { ...dealEntity, label: 'internal' }).expect(201);
    return app as { id: string };
  }

  const audits = async (action: string) => (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action })) as { target: string; detail: string | null }[];

  it('B-2201, B-2202: typed fields, uniqueness, sealed records, filters, sort, search, pagination and aggregation', async () => {
    const d = await designer();
    const m = await member('mia');
    await setup(d);
    // members cannot design
    await m.post('/api/apps', { name: 'mine', label: 'internal', workspaceId: wsId }).expect(403);
    await m.post('/api/apps/crm/entities', { name: 'x', definition: { fields: [{ name: 'a', type: 'string' }] } }).expect(403);
    // invalid designs
    await d.post('/api/apps/crm/entities', { name: 'bad', definition: { fields: [{ name: 'a', type: 'string', indexed: true, maxLength: 1000 }] } }).expect(400);
    await d.post('/api/apps/crm/entities', { name: 'bad', definition: { fields: [{ name: 'id', type: 'string' }] } }).expect(400);
    await d.post('/api/apps/crm/entities', { name: 'bad', definition: { fields: [{ name: 'r', type: 'reference', entity: 'nothing' }] } }).expect(400);

    const mk = (values: Record<string, unknown>) => m.post('/api/apps/crm/entities/deal/records', { values });
    const rows = [
      { title: 'Alpha', amount: 50, due: '2026-03-01', stage: 'Lead' },
      { title: 'Bravo', amount: 5, due: '2026-01-15', stage: 'won' },
      { title: 'Charlie', amount: 500, due: '2026-02-01', stage: 'Lost' },
      { title: 'delta', amount: 50, stage: 'Lead', owner: m.user.id, notes: 'secret plan', meta: { a: 1 } },
      { title: 'Echo 100%', amount: 0.5, due: '2025-12-31' }
    ];
    const ids: string[] = [];
    for (const v of rows) ids.push((await mk(v).expect(201)).body.id);
    const alpha = (await m.get(`/api/apps/crm/entities/deal/records/${ids[0]}`).expect(200)).body;
    expect(alpha).toMatchObject({ state: 'open', label: 'internal', version: 1, values: { title: 'Alpha', amount: 50, twice: 100, stage: 'Lead' } });
    expect((await m.get(`/api/apps/crm/entities/deal/records/${ids[1]}`).expect(200)).body.values.stage).toBe('Won');

    // B-2201: a duplicate unique value is refused (compared lower-cased), and so is a bad value or a computed one
    const dup = await mk({ title: 'ALPHA', amount: 1 }).expect(409);
    expect(dup.body).toMatchObject({ title: 'Duplicate value', field: 'title' });
    expect(dup.headers['content-type']).toMatch(/problem\+json/);
    const bad = await mk({ title: 'Foxtrot', amount: -1, stage: 'Maybe', twice: 3, extra: 1, owner: 'not-an-id' }).expect(400);
    expect(bad.body.problems.map((p: { field: string }) => p.field).sort()).toEqual(['amount', 'extra', 'owner', 'stage', 'twice']);
    await mk({ title: 'Golf', owner: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }).expect(400); // not a user of the tenant
    await mk({ amount: 3 }).expect(400); // title is required

    // sealed at rest: the record row holds no clear value; only indexed fields are in the index
    const raw = await h.s.db('app_records').where({ id: ids[3] }).first();
    expect(raw.data).not.toContain('secret plan');
    expect(raw.data).not.toContain('delta');
    const idx = (await h.s.db('app_record_values').where({ record_id: ids[3] })) as { field: string; v_norm: string | null; v_num: number | null }[];
    expect(idx.map((x) => x.field).sort()).toEqual(['amount', 'stage', 'title', 'twice']);
    expect(idx.find((x) => x.field === 'title')!.v_norm).toBe('delta');

    const q = async (body: object) => (await m.post('/api/apps/crm/entities/deal/records/query', body).expect(200)).body as { total: number; nextCursor: string | null; records: { id: string; values: Record<string, unknown> }[] };
    const titles = (r: { records: { values: Record<string, unknown> }[] }) => r.records.map((x) => x.values.title);
    expect(titles(await q({ filter: { field: 'amount', op: 'gte', value: 50 }, sort: [{ field: 'amount', dir: 'desc' }, { field: 'title', dir: 'asc' }] }))).toEqual(['Charlie', 'Alpha', 'delta']);
    expect(titles(await q({ filter: { and: [{ field: 'stage', op: 'in', value: ['lead', 'WON'] }, { not: { field: 'amount', op: 'eq', value: 50 } }] } }))).toEqual(['Bravo']);
    expect(titles(await q({ filter: { or: [{ field: 'due', op: 'lt', value: '2026-01-01' }, { field: 'due', op: 'exists', value: false }] }, sort: [{ field: 'title', dir: 'asc' }] }))).toEqual(['delta', 'Echo 100%']);
    expect(titles(await q({ filter: { field: 'title', op: 'startsWith', value: 'CH' } }))).toEqual(['Charlie']);
    expect(titles(await q({ filter: { field: 'stage', op: 'ne', value: 'Lead' }, sort: [{ field: 'title', dir: 'asc' }] }))).toEqual(['Bravo', 'Charlie', 'Echo 100%']);
    expect(titles(await q({ filter: { field: 'twice', op: 'gt', value: 99 }, sort: [{ field: 'twice', dir: 'asc' }, { field: 'title', dir: 'asc' }] }))).toEqual(['Alpha', 'delta', 'Charlie']);
    // empty values sort last both ways
    expect(titles(await q({ sort: [{ field: 'due', dir: 'desc' }] })).slice(-1)).toEqual(['delta']);
    expect(titles(await q({ sort: [{ field: 'due', dir: 'asc' }] }))).toEqual(['Echo 100%', 'Bravo', 'Charlie', 'Alpha', 'delta']);
    // search: lower-cased, % literal
    expect(titles(await q({ q: '100%' }))).toEqual(['Echo 100%']);
    expect(titles(await q({ q: 'a%' }))).toEqual([]);
    // pagination
    const page = await q({ sort: [{ field: 'title', dir: 'asc' }], limit: 2, offset: 2 });
    expect(page.total).toBe(5);
    expect(titles(page)).toEqual(['Charlie', 'delta']);
    // B-3601: keyset paging, the body and the GET form, to the last page
    const c1 = await q({ sort: [{ field: 'title', dir: 'asc' }], limit: 2 });
    expect([titles(c1), typeof c1.nextCursor]).toEqual([['Alpha', 'Bravo'], 'string']);
    const c2 = await q({ sort: [{ field: 'title', dir: 'asc' }], limit: 2, cursor: c1.nextCursor });
    expect(titles(c2)).toEqual(['Charlie', 'delta']);
    const c3 = (await m.get(`/api/apps/crm/entities/deal/records?sort=title:asc&limit=2&cursor=${encodeURIComponent(c2.nextCursor!)}`).expect(200)).body;
    expect([titles(c3), c3.nextCursor, c3.total]).toEqual([['Echo 100%'], null, 5]);
    await m.post('/api/apps/crm/entities/deal/records/query', { sort: [{ field: 'title', dir: 'desc' }], cursor: c1.nextCursor }).expect(400);
    await m.post('/api/apps/crm/entities/deal/records/query', { sort: [{ field: 'title', dir: 'asc' }], offset: 2, cursor: c1.nextCursor }).expect(400);
    // the GET form takes the filter as JSON and the sort as field:dir
    const got = (await m.get(`/api/apps/crm/entities/deal/records?filter=${encodeURIComponent(JSON.stringify({ field: 'amount', op: 'lt', value: 10 }))}&sort=amount:asc`).expect(200)).body;
    expect(titles(got)).toEqual(['Echo 100%', 'Bravo']);
    // a field that is not indexed cannot be filtered
    expect((await m.post('/api/apps/crm/entities/deal/records/query', { filter: { field: 'notes', op: 'eq', value: 'x' } }).expect(400)).body.detail).toMatch(/not indexed/);
    await m.post('/api/apps/crm/entities/deal/records/query', { filter: { field: 'constructor', op: 'eq', value: 'x' } }).expect(400);
    await m.post('/api/apps/crm/entities/deal/records/query', { sort: [{ field: 'toString', dir: 'asc' }] }).expect(400);
    // aggregation
    const agg = (await m.post('/api/apps/crm/entities/deal/records/aggregate', { groupBy: 'stage', metrics: [{ op: 'count' }, { op: 'sum', field: 'amount' }, { op: 'max', field: 'amount' }] }).expect(200)).body;
    expect(agg.groups).toEqual([
      { key: 'Lead', values: [2, 100, 50] },
      { key: 'Lost', values: [1, 500, 500] },
      { key: 'Won', values: [1, 5, 5] },
      { key: null, values: [1, 0.5, 0.5] }
    ]);
    const all = (await m.post('/api/apps/crm/entities/deal/records/aggregate', { filter: { field: 'amount', op: 'gt', value: 1 }, metrics: [{ op: 'avg', field: 'amount' }] }).expect(200)).body;
    expect(all.groups).toEqual([{ key: null, values: [151.25] }]);

    // optimistic updates
    const upd = (await m.patch(`/api/apps/crm/entities/deal/records/${ids[0]}`, { values: { amount: 60 }, version: 1 }).expect(200)).body;
    expect(upd).toMatchObject({ version: 2, values: { amount: 60, twice: 120, title: 'Alpha' } });
    await m.patch(`/api/apps/crm/entities/deal/records/${ids[0]}`, { values: { amount: 70 }, version: 1 }).expect(409);
    // a unique value freed by an update can be taken
    await m.patch(`/api/apps/crm/entities/deal/records/${ids[1]}`, { values: { title: 'Bravo two' } }).expect(200);
    await mk({ title: 'bravo' }).expect(201);
    await m.patch(`/api/apps/crm/entities/deal/records/${ids[2]}`, { values: { title: 'alpha' } }).expect(409);

    // audit and events (every event is checked against the catalogue by setup-events)
    expect((await audits('app.record.created')).length).toBeGreaterThanOrEqual(6);
    expect((await audits('app.record.updated')).length).toBe(2);
    expect(events.filter((e) => e.type === 'record.created')).toHaveLength(6);
    expect(events.find((e) => e.type === 'record.updated')!.data).toMatchObject({ entity: 'deal', record: ids[0], fields: ['amount'], workspace: wsId, actor: m.user.id });

    // delete
    await m.del(`/api/apps/crm/entities/deal/records/${ids[4]}`).expect(204);
    await m.get(`/api/apps/crm/entities/deal/records/${ids[4]}`).expect(404);
    expect(await h.s.db('app_record_values').where({ record_id: ids[4] })).toHaveLength(0);
  });

  it('B-2202: clearance filters records, and apps outside the caller’s workspaces are invisible', async () => {
    const d = await designer();
    const m = await member('mia');
    await setup(d);
    const conf = (await d.post('/api/apps/crm/entities/deal/records', { values: { title: 'Secret deal' }, label: 'confidential' }).expect(201)).body;
    await d.post('/api/apps/crm/entities/deal/records', { values: { title: 'Open deal' } }).expect(201);
    await m.post('/api/apps/crm/entities/deal/records', { values: { title: 'Mine' }, label: 'confidential' }).expect(403);
    const list = (await m.post('/api/apps/crm/entities/deal/records/query', {}).expect(200)).body;
    expect(list.records.map((r: { values: { title: string } }) => r.values.title)).toEqual(['Open deal']);
    await m.get(`/api/apps/crm/entities/deal/records/${conf.id}`).expect(404);
    // above the app's label
    await d.post('/api/apps/crm/entities/deal/records', { values: { title: 'Top' }, label: 'restricted' }).expect(403);
    // an outsider (not in the workspace) sees no app
    await localUser(h, 'out', ['member']);
    const o = await login(h, 'out');
    expect((await o.agent.get('/api/apps').expect(200)).body.apps).toEqual([]);
    await o.agent.get('/api/apps/crm').expect(404);
  });

  it('B-2202: bulk writes are all or nothing; CSV import and export run as jobs', async () => {
    const d = await designer();
    const m = await member('mia');
    await setup(d);
    const first = (await m.post('/api/apps/crm/entities/deal/records', { values: { title: 'One' } }).expect(201)).body;
    const refused = await m.post('/api/apps/crm/entities/deal/records/bulk', { create: [{ values: { title: 'Two' } }, { values: { title: 'one' } }] }).expect(409);
    expect(refused.body.field).toBe('title');
    expect(await h.s.db('app_records')).toHaveLength(1);
    const ok = (await m.post('/api/apps/crm/entities/deal/records/bulk', { create: [{ values: { title: 'Two', amount: 2 } }, { values: { title: 'Three' } }], update: [{ id: first.id, values: { amount: 1 }, version: 1 }] }).expect(200)).body;
    expect(ok.created).toHaveLength(2);
    expect(ok.updated).toEqual([first.id]);
    await m.post('/api/apps/crm/entities/deal/records/bulk', { update: [{ id: first.id, values: { amount: 9 }, version: 1 }] }).expect(409);
    expect((await audits('app.records.bulk')).length).toBe(1);

    const csv = 'title,amount,stage,label\r\nImported,10,Won,\r\n"=cmd|x",3,,\r\nTwo,1,,\r\nBad,-5,,\r\n';
    const job = (await m.post('/api/apps/crm/entities/deal/records/import', { csv, dryRun: true }).expect(202)).body;
    await drain(h);
    const dry = (await m.get(`/api/apps/transfers/${job.id}`).expect(200)).body;
    expect(dry).toMatchObject({ kind: 'import', state: 'succeeded', summary: { rows: 4, valid: 2, failed: 2, dryRun: true } });
    expect(await h.s.db('app_records')).toHaveLength(3);
    const real = (await m.post('/api/apps/crm/entities/deal/records/import', { csv }).expect(202)).body;
    await drain(h);
    const done = (await m.get(`/api/apps/transfers/${real.id}`).expect(200)).body;
    expect(done.summary).toMatchObject({ rows: 4, created: 2, failed: 2 });
    expect(done.report.map((r: { row: number }) => r.row)).toEqual([4, 5]);
    expect(done.report[0].problem).toMatch(/unique/);
    await m.post('/api/apps/crm/entities/deal/records/import', { csv: 'title,nope\r\nx,1\r\n' }).expect(400);
    // the CSV is not kept once imported
    expect((await h.s.db('app_transfers').where({ id: real.id }).first()).input).toBeNull();

    const exp = (await m.post('/api/apps/crm/entities/deal/records/export', { filter: { field: 'amount', op: 'gte', value: 2 }, sort: [{ field: 'amount', dir: 'asc' }] }).expect(202)).body;
    await drain(h);
    const st = (await m.get(`/api/apps/transfers/${exp.id}`).expect(200)).body;
    expect(st).toMatchObject({ state: 'succeeded', download: true, summary: { records: 3 } });
    const file = await m.get(`/api/apps/transfers/${exp.id}/download`).expect(200);
    expect(file.headers['content-type']).toMatch(/text\/csv/);
    const lines = file.text.trim().split('\r\n');
    expect(lines[0]).toBe('id,state,label,createdAt,updatedAt,title,amount,due,stage,owner,notes,meta,twice');
    expect(lines.slice(1).map((l) => l.split(',')[5])).toEqual(['Two', "'=cmd|x", 'Imported']);
    // the stored export is sealed; another person cannot fetch it
    const blob = await h.s.blobs.get((await h.s.db('app_transfers').where({ id: exp.id }).first()).blob_key);
    expect(blob!.toString()).not.toContain('Imported');
    const other = await member('oli');
    await other.get(`/api/apps/transfers/${exp.id}/download`).expect(404);
    expect((await audits('app.records.downloaded')).length).toBe(1);
  });

  it('B-2203, B-2204: lookups and an audited state machine that refuses illegal transitions', async () => {
    const d = await designer();
    const m = await member('mia');
    await setup(d);
    await d.post('/api/apps/crm/entities', {
      name: 'task',
      label: 'internal',
      definition: {
        fields: [
          { name: 'name', type: 'string', indexed: true, maxLength: 200 },
          { name: 'deal', type: 'reference', entity: 'deal' },
          { name: 'size', type: 'lookup', source: 'static', options: [{ value: 's', label: 'Small' }, { value: 'l', label: 'Large' }] },
          { name: 'space', type: 'lookup', source: 'workspace' }
        ]
      }
    }).expect(201);
    const deal = (await m.post('/api/apps/crm/entities/deal/records', { values: { title: 'Acme renewal' } }).expect(201)).body;
    const opts = (path: string) => m.get(`/api/apps/crm/entities/${path}`).expect(200).then((r) => r.body.options);
    expect(await opts('task/fields/deal/options?q=acme')).toEqual([{ value: deal.id, label: 'Acme renewal' }]);
    expect(await opts('task/fields/size/options?q=lar')).toEqual([{ value: 'l', label: 'Large' }]);
    expect(await opts('deal/fields/owner/options?q=mia')).toEqual([{ value: m.user.id, label: 'MIA' }]);
    expect((await opts('task/fields/space/options')).map((o: { value: string }) => o.value)).toContain(wsId);
    await m.post('/api/apps/crm/entities/task/records', { values: { name: 'Call', deal: deal.id, size: 'L', space: wsId } }).expect(201);
    await m.post('/api/apps/crm/entities/task/records', { values: { name: 'Call', deal: '01ARZ3NDEKTSV4RRFFQ69G5FAV' } }).expect(400);
    await m.post('/api/apps/crm/entities/task/records', { values: { name: 'Call', size: 'xl' } }).expect(400);
    // an entity something refers to cannot be removed
    await d.del('/api/apps/crm/entities/deal').expect(409);

    // B-2204
    const t = (path: string, to: string) => m.post(`/api/apps/crm/entities/deal/records/${deal.id}/transition`, { to }).then((r) => r);
    const illegal = await t('', 'closed');
    expect(illegal.status).toBe(409);
    expect(illegal.body).toMatchObject({ title: 'Illegal transition', from: 'open', to: 'closed', allowed: ['review'] });
    expect((await t('', 'review')).body).toMatchObject({ state: 'review', version: 2 });
    expect((await t('', 'closed')).body.state).toBe('closed');
    expect((await t('', 'open')).status).toBe(409);
    // the state is not a field: an update cannot set it
    await m.patch(`/api/apps/crm/entities/deal/records/${deal.id}`, { values: { state: 'open' } }).expect(400);
    const audited = await audits('app.record.transitioned');
    expect(audited.map((a) => JSON.parse(a.detail!)).map((x: { from: string; to: string }) => `${x.from}>${x.to}`)).toEqual(['open>review', 'review>closed']);
    expect(events.filter((e) => e.type === 'record.transitioned').map((e) => e.data.to)).toEqual(['review', 'closed']);
    // filter and group by state
    const byState = (await m.post('/api/apps/crm/entities/deal/records/query', { filter: { field: 'state', op: 'eq', value: 'closed' } }).expect(200)).body;
    expect(byState.total).toBe(1);
    // a state still held cannot be removed from the machine
    const e = (await d.get('/api/apps/crm/entities/deal').expect(200)).body;
    const states = { ...e.definition.states, states: [{ name: 'open' }, { name: 'review' }], transitions: [{ from: ['open'], to: 'review' }] };
    await d.patch('/api/apps/crm/entities/deal', { definition: { ...e.definition, states }, rev: e.rev }).expect(409);
  });

  it('B-2205: forms with conditional fields; a public form drops extra fields, is rate-limited and passes the user-input guardrail', async () => {
    const d = await designer();
    await setup(d);
    await d.post('/api/apps/crm/entities', {
      name: 'lead',
      label: 'internal',
      definition: {
        fields: [
          { name: 'email', type: 'string', required: true, indexed: true, maxLength: 200 },
          { name: 'kind', type: 'enum', options: [{ value: 'person' }, { value: 'business' }] },
          { name: 'company', type: 'string' },
          { name: 'score', type: 'number' },
          { name: 'owner', type: 'lookup', source: 'user' }
        ]
      }
    }).expect(201);
    const def = { fields: [{ field: 'email' }, { field: 'kind' }, { field: 'company', required: true, visibleIf: { field: 'kind', op: 'eq', value: 'business' } }] };
    await d.post('/api/apps/crm/forms', { name: 'contact', entity: 'lead', definition: { fields: [{ field: 'kind' }] } }).expect(400); // email is required by the entity
    await d.post('/api/apps/crm/forms', { name: 'contact', entity: 'lead', definition: { fields: [{ field: 'company', visibleIf: { field: 'kind', op: 'eq', value: 'x' } }, { field: 'email' }] } }).expect(400); // condition on a later field
    const form = (await d.post('/api/apps/crm/forms', { name: 'contact', title: 'Contact us', entity: 'lead', definition: def, ratePerMinute: 100 }).expect(201)).body;
    expect(form).toMatchObject({ name: 'contact', entity: 'lead', public: false });

    // signed in: hidden and unlisted fields are dropped, a visible required one is checked
    const m = await member('mia');
    const s1 = (await m.post('/api/apps/crm/forms/contact/submit', { values: { email: 'a@x.test', kind: 'person', company: 'Hidden Co', score: 99 } }).expect(201)).body;
    expect(s1.dropped.sort()).toEqual(['company', 'score']);
    expect((await m.get(`/api/apps/crm/entities/lead/records/${s1.id}`).expect(200)).body.values).toEqual({ email: 'a@x.test', kind: 'person' });
    await m.post('/api/apps/crm/forms/contact/submit', { values: { email: 'b@x.test', kind: 'business' } }).expect(400);

    // a public form cannot ask for a user lookup
    const withOwner = (await d.post('/api/apps/crm/forms', { name: 'internal_form', entity: 'lead', definition: { fields: [{ field: 'email' }, { field: 'owner' }] } }).expect(201)).body;
    expect((await d.post(`/api/apps/crm/forms/${withOwner.id}/public`, { enabled: true }).expect(400)).body.detail).toMatch(/public form cannot ask/);

    const pub = (await d.post('/api/apps/crm/forms/contact/public', { enabled: true }).expect(200)).body;
    expect(pub.token).toMatch(/^exa_/);
    const anon = request(h.app);
    const opened = (await anon.post('/api/public/forms/open').send({ token: pub.token }).expect(200)).body;
    expect(opened.fields.map((f: { name: string }) => f.name)).toEqual(['email', 'kind', 'company']);
    expect(JSON.stringify(opened)).not.toContain('score');
    await anon.post('/api/public/forms/open').send({ token: 'exa_' + 'x'.repeat(40) }).expect(404);

    // the done-when: an extra field in a public submission is dropped
    const sub = await anon.post('/api/public/forms/submit').send({ token: pub.token, values: { email: 'c@x.test', kind: 'business', company: 'Acme', score: 1000, owner: m.user.id } }).expect(201);
    expect(sub.body).toMatchObject({ submitted: true, dropped: 2 });
    const rec = (await h.s.db('app_records').where({ source: 'form' }).orderBy('created_at', 'desc').first()) as { id: string; created_by: string | null };
    expect(rec.created_by).toBeNull();
    const vals = (await d.get(`/api/apps/crm/entities/lead/records/${rec.id}`).expect(200)).body.values;
    expect(vals).toEqual({ email: 'c@x.test', kind: 'business', company: 'Acme' });
    const subAudit = (await audits('app.form.submitted')).map((a) => JSON.parse(a.detail!)).find((x: { public: boolean }) => x.public);
    expect(subAudit.dropped.sort()).toEqual(['owner', 'score']);

    // the user-input guardrail: a block refuses, a redaction is kept
    const seen: string[] = [];
    h.s.guardrails = {
      check: async (i) => {
        if (i.checkpoint !== 'user-input') return { action: 'allow', text: i.text, findings: [] };
        seen.push(i.text);
        if (i.text.includes('BLOCKME')) return { action: 'block', text: i.text, findings: [], reason: 'Not allowed here.' };
        if (i.text.includes('@redact')) return { action: 'redact', text: '[email]', findings: [] };
        return { action: 'allow', text: i.text, findings: [] };
      }
    };
    const blocked = await anon.post('/api/public/forms/submit').send({ token: pub.token, values: { email: 'BLOCKME' } }).expect(422);
    expect(blocked.body.detail).toMatch(/Not allowed here/);
    expect(seen).toContain('BLOCKME');
    const redacted = await anon.post('/api/public/forms/submit').send({ token: pub.token, values: { email: 'd@redact' } }).expect(201);
    expect(redacted.body.submitted).toBe(true);
    const last = (await h.s.db('app_records').where({ source: 'form' }).orderBy('id', 'desc').first()) as { id: string };
    expect((await d.get(`/api/apps/crm/entities/lead/records/${last.id}`).expect(200)).body.values.email).toBe('[email]');
    // the per-address limit (3 a minute in this harness) was reached by the three submissions above
    const limited = await anon.post('/api/public/forms/submit').send({ token: pub.token, values: { email: 'e@x.test' } }).expect(429);
    expect(limited.headers['retry-after']).toBeTruthy();
    // a form made private again stops answering
    await d.post('/api/apps/crm/forms/contact/public', { enabled: false }).expect(200);
    await anon.post('/api/public/forms/open').send({ token: pub.token }).expect(404);
  });

  async function publishWorkflow(d: C, name: string, nodes: object[], edges: object[]) {
    const p = (await loadPrincipal(h.s, h.tenantId, d.user.id, {}))!;
    p.workspaceId = wsId;
    const w = await h.s.workflows.create(p, { name, label: 'internal', graph: { nodes: [{ id: 'trigger', kind: 'trigger', title: 'On record', x: 20, y: 20, config: { source: 'record' } }, ...nodes] as never, edges: edges as never, limits: {} } });
    const out = await h.s.workflows.publish(p, w.id, null);
    expect(out.version).toBe(1);
    return w.id;
  }

  it('B-2206: a record update starts its workflow; workflow record steps write records; schedules fire', async () => {
    const d = await designer();
    const m = await member('mia');
    await setup(d);
    const wf = await publishWorkflow(d, 'on-update', [{ id: 'shape', kind: 'transform', title: 'Shape', x: 200, y: 20, config: { fields: { title: '{{input.record.values.title}}', event: '{{input.event}}' } } }], [{ from: 'trigger', to: 'shape' }]);
    const trig = (await d.post('/api/apps/crm/triggers', { entity: 'deal', kind: 'record', events: ['updated'], workflow: 'on-update' }).expect(201)).body;
    expect(trig).toMatchObject({ kind: 'record', events: ['updated'], workflowId: wf, workflow: 'on-update' });
    await m.post('/api/apps/crm/triggers', { entity: 'deal', kind: 'record', events: ['updated'], workflow: 'on-update' }).expect(403);

    const rec = (await m.post('/api/apps/crm/entities/deal/records', { values: { title: 'Kilo' } }).expect(201)).body;
    await drain(h);
    expect(await h.s.db('workflow_runs').where({ workflow_id: wf })).toHaveLength(0); // created is not subscribed
    await m.patch(`/api/apps/crm/entities/deal/records/${rec.id}`, { values: { amount: 7 } }).expect(200);
    await drain(h);
    const runs = (await h.s.db('workflow_runs').where({ workflow_id: wf })) as { id: string; trigger: string; state: string; created_by: string }[];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: 'record', state: 'succeeded', created_by: d.user.id });
    const step = (await h.s.workflows.runView((await loadPrincipal(h.s, h.tenantId, d.user.id, {}))!, runs[0]!.id)) as unknown as { steps: { nodeId: string; output: unknown }[] };
    expect(JSON.stringify(step)).toContain('Kilo');
    expect((await audits('app.trigger.fired')).length).toBe(1);

    // a record step: a workflow fired on create sets the record's stage and moves it to review
    await publishWorkflow(
      d,
      'triage',
      [
        { id: 'set', kind: 'record', title: 'Set stage', x: 200, y: 20, config: { action: 'update', app: 'crm', entity: 'deal', record: '{{input.record.id}}', values: { stage: 'Lead', notes: 'triaged {{input.record.values.title}}' } } },
        { id: 'move', kind: 'record', title: 'Review', x: 400, y: 20, config: { action: 'transition', app: 'crm', entity: 'deal', record: '{{input.record.id}}', to: 'review' } }
      ],
      [{ from: 'trigger', to: 'set' }, { from: 'set', to: 'move' }]
    );
    await d.post('/api/apps/crm/triggers', { entity: 'deal', kind: 'record', events: ['created', 'updated'], workflow: 'triage' }).expect(201);
    const lima = (await m.post('/api/apps/crm/entities/deal/records', { values: { title: 'Lima' } }).expect(201)).body;
    await drain(h);
    const after = (await m.get(`/api/apps/crm/entities/deal/records/${lima.id}`).expect(200)).body;
    expect(after).toMatchObject({ state: 'review', values: { stage: 'Lead', notes: 'triaged Lima' }, source: 'api' });
    // triage's own update did not start triage again; on-update ran once for it (depth 2), and stopped there
    const triage = (await h.s.db('workflows').where({ name: 'triage' }).first()).id;
    expect(await h.s.db('workflow_runs').where({ workflow_id: triage })).toHaveLength(1);
    expect((await h.s.db('workflow_runs').where({ workflow_id: wf })).length).toBe(2);

    // schedules
    await publishWorkflow(d, 'nightly', [], []);
    const sched = (await d.post('/api/apps/crm/triggers', { entity: 'deal', kind: 'schedule', cron: '0 2 * * *', workflow: 'nightly' }).expect(201)).body;
    expect(sched.nextRunAt).toBeGreaterThan(Date.now());
    await d.post('/api/apps/crm/triggers', { entity: 'deal', kind: 'schedule', cron: 'nope', workflow: 'nightly' }).expect(400);
    const fired = await h.s.apps.triggers.tick(sched.nextRunAt + 1);
    expect(fired).toEqual({ fired: 1, skipped: 0 });
    expect(await h.s.apps.triggers.tick(sched.nextRunAt + 1)).toEqual({ fired: 0, skipped: 0 });
    const nightly = (await h.s.db('workflows').where({ name: 'nightly' }).first()).id;
    expect((await h.s.db('workflow_runs').where({ workflow_id: nightly }).first()).trigger).toBe('schedule');

    // an owner who left the workflow's workspace gets a skip, audited
    await h.s.tenants.removeMember(wsId, d.user.id);
    await m.patch(`/api/apps/crm/entities/deal/records/${rec.id}`, { values: { amount: 8 } }).expect(200);
    await drain(h);
    const skipped = (await audits('app.trigger.skipped')).map((a) => JSON.parse(a.detail!).reason as string);
    expect(skipped).toContain("the owner is no longer a member of the workflow's workspace");
  });

  it('B-2207: AI fields filled by a profile prompt, failing soft; drafts of entities from a local model', async () => {
    const ollama = await new FakeOllama().start();
    try {
      await seedGateway(h, ollama);
      const d = await designer();
      const m = await member('mia');
      await d.post('/api/apps', { name: 'notes', label: 'internal', workspaceId: wsId }).expect(201);
      await d.post('/api/apps/notes/entities', { name: 'note', definition: { fields: [{ name: 'text', type: 'string', required: true }, { name: 'summary', type: 'ai', profile: 'general', prompt: 'Summarise: {{text}}', indexed: true }] } }).expect(201);
      await d.post('/api/apps/notes/entities', { name: 'bad', definition: { fields: [{ name: 'text', type: 'string' }, { name: 'summary', type: 'ai', profile: 'general', prompt: 'Summarise: {{nothing}}' }] } }).expect(400);
      ollama.reply = (msgs) => ({ content: `Short: ${msgs[msgs.length - 1]!.content.replace('Summarise: ', '')}` });
      const ok = (await m.post('/api/apps/notes/entities/note/records', { values: { text: 'the quarterly plan' } }).expect(201)).body;
      expect(ok.aiState).toBe('pending');
      await m.post('/api/apps/notes/entities/note/records', { values: { text: 'x', summary: 'mine' } }).expect(400);
      await drain(h);
      const filled = (await m.get(`/api/apps/notes/entities/note/records/${ok.id}`).expect(200)).body;
      expect(filled).toMatchObject({ aiState: 'filled', aiError: null, values: { text: 'the quarterly plan', summary: 'Short: the quarterly plan' } });
      expect((await m.post('/api/apps/notes/entities/note/records/query', { q: 'short' }).expect(200)).body.total).toBe(1);

      // the done-when: a model error leaves the field empty and the record saved
      await ollama.stop();
      const soft = (await m.post('/api/apps/notes/entities/note/records', { values: { text: 'when the model is down' } }).expect(201)).body;
      await drain(h);
      const after = (await m.get(`/api/apps/notes/entities/note/records/${soft.id}`).expect(200)).body;
      expect(after.values).toEqual({ text: 'when the model is down' });
      expect(after.aiState).toBe('failed');
      expect(after.aiError).toMatch(/^summary: /);
      expect((await audits('app.record.ai.failed')).length).toBe(1);
      // an update of the source field asks again (and the old summary is cleared until then)
      await m.patch(`/api/apps/notes/entities/note/records/${ok.id}`, { values: { text: 'new text' } }).expect(200);
      await drain(h);
      expect((await m.get(`/api/apps/notes/entities/note/records/${ok.id}`).expect(200)).body).toMatchObject({ aiState: 'failed', values: { text: 'new text' } });
    } finally {
      await ollama.stop().catch(() => undefined);
    }
  });

  it('B-2207: natural-language drafts are validated and never saved', async () => {
    const ollama = await new FakeOllama().start();
    try {
      await seedGateway(h, ollama);
      const d = await designer();
      ollama.reply = () => ({ content: JSON.stringify({ name: 'ticket', title: 'Ticket', definition: { fields: [{ name: 'subject', type: 'string', required: true }, { name: 'priority', type: 'enum', options: [{ value: 'low' }, { value: 'high' }] }], states: { initial: 'new', states: [{ name: 'new' }, { name: 'done' }], transitions: [{ from: ['new'], to: 'done' }] } } }) });
      const ok = (await d.post('/api/apps/drafts', { kind: 'entity', prompt: 'Support tickets with a subject and a priority', profile: 'general' }).expect(200)).body;
      expect(ok).toMatchObject({ kind: 'entity', valid: true, problems: [], draft: { name: 'ticket' } });
      expect(await h.s.db('app_entities')).toHaveLength(0);
      ollama.reply = () => ({ content: JSON.stringify({ name: 'flow', graph: { nodes: [{ id: 'trigger', kind: 'trigger', title: 'T', config: { source: 'record' } }, { id: 'up', kind: 'record', title: 'Update', config: { action: 'update', app: 'crm', entity: 'deal' } }], edges: [{ from: 'trigger', to: 'up' }] } }) });
      const flow = (await d.post('/api/apps/drafts', { kind: 'workflow', prompt: 'Update the deal when it changes', profile: 'general' }).expect(200)).body;
      expect(flow.valid).toBe(false);
      expect(flow.problems[0]).toMatch(/names the record/);
      ollama.reply = () => ({ content: 'I cannot help with that.' });
      await d.post('/api/apps/drafts', { kind: 'entity', prompt: 'Anything', profile: 'general' }).expect(422);
    } finally {
      await ollama.stop();
    }
  });

  it('B-2208: an app exports as a signed bundle and imports elsewhere; a tampered bundle is refused', async () => {
    const d = await designer();
    await setup(d);
    await d.post('/api/apps/crm/entities', { name: 'task', definition: { fields: [{ name: 'name', type: 'string' }, { name: 'deal', type: 'reference', entity: 'deal' }] } }).expect(201);
    await d.post('/api/apps/crm/forms', { name: 'new_deal', entity: 'deal', definition: { fields: [{ field: 'title' }, { field: 'amount' }] } }).expect(201);
    await d.post('/api/apps/crm/entities/deal/records', { values: { title: 'Not exported' } }).expect(201);
    const bundle = (await d.get('/api/apps/crm/export').expect(200)).body;
    expect(bundle).toMatchObject({ format: 'exprsn-app/1', app: { name: 'crm' }, key: expect.stringMatching(/app-bundles$/), signature: expect.any(String) });
    expect(JSON.stringify(bundle)).not.toContain('Not exported');
    expect(bundle.entities.map((e: { name: string }) => e.name)).toEqual(['deal', 'task']);

    const imported = (await d.post('/api/apps/import', { bundle, name: 'crm_copy', workspaceId: wsId }).expect(201)).body;
    expect(imported).toMatchObject({ name: 'crm_copy', label: 'confidential' });
    const copy = (await d.get('/api/apps/crm_copy').expect(200)).body;
    expect(copy.entities.map((e: { name: string }) => e.name)).toEqual(['deal', 'task']);
    expect(copy.forms.map((f: { name: string; public: boolean }) => [f.name, f.public])).toEqual([['new_deal', false]]);
    expect((await d.post('/api/apps/crm_copy/entities/deal/records/query', {}).expect(200)).body.total).toBe(0);

    // the done-when: a tampered bundle is refused (any change after signing)
    const tampered = JSON.parse(JSON.stringify(bundle));
    tampered.entities[0].definition.fields[0].unique = false;
    const refused = await d.post('/api/apps/import', { bundle: tampered, name: 'crm_bad', workspaceId: wsId }).expect(422);
    expect(refused.body).toMatchObject({ title: 'Bundle refused' });
    expect(refused.body.detail).toMatch(/signature does not verify/);
    await d.post('/api/apps/import', { bundle: { ...bundle, signature: 'local:v1:AAAA' }, name: 'crm_bad' }).expect(422);
    await d.post('/api/apps/import', { bundle: { ...bundle, key: 'someone-else' }, name: 'crm_bad' }).expect(422);
    const { signature: _s, ...unsigned } = bundle;
    void _s;
    await d.post('/api/apps/import', { bundle: unsigned, name: 'crm_bad' }).expect(422);
    await d.get('/api/apps/crm_bad').expect(404);
    expect((await audits('app.import.refused')).length).toBe(4);
    // importing under a name that exists is a conflict, and leaves nothing half made
    await d.post('/api/apps/import', { bundle, workspaceId: wsId }).expect(409);
  });

  it('records are moderation objects: a takedown hides the record, an upheld appeal shows it again', async () => {
    const d = await designer();
    const m = await member('mia');
    await setup(d);
    const rec = (await m.post('/api/apps/crm/entities/deal/records', { values: { title: 'Spam deal', notes: 'buy now' } }).expect(201)).body;
    const handler = h.s.moderation.registry.get('record')!;
    const o = (await handler.resolve(h.tenantId, rec.id))!;
    expect(o).toMatchObject({ type: 'record', workspaceId: wsId, ownerId: m.user.id, state: 'visible', label: 'internal' });
    expect(await handler.text!(o)).toBe('Spam deal\nbuy now');
    const prev = await handler.hide!(o);
    expect(prev).toBe('visible');
    await m.get(`/api/apps/crm/entities/deal/records/${rec.id}`).expect(404);
    expect((await m.post('/api/apps/crm/entities/deal/records/query', {}).expect(200)).body.total).toBe(0);
    expect(await handler.hide!((await handler.resolve(h.tenantId, rec.id))!)).toBeNull();
    expect(await handler.restore!(o, prev!)).toBe(true);
    await m.get(`/api/apps/crm/entities/deal/records/${rec.id}`).expect(200);
  });

  it('design changes: reindexing when indexed fields change, app deletion removes everything', async () => {
    const d = await designer();
    const m = await member('mia');
    await setup(d);
    await m.post('/api/apps/crm/entities/deal/records', { values: { title: 'One', notes: 'zeta' } }).expect(201);
    await m.post('/api/apps/crm/entities/deal/records', { values: { title: 'Two', notes: 'alpha' } }).expect(201);
    const e = (await d.get('/api/apps/crm/entities/deal').expect(200)).body;
    const fields = e.definition.fields.map((f: { name: string }) => (f.name === 'notes' ? { ...f, indexed: true, maxLength: 200 } : f));
    // an existing field cannot become unique once there are records; a type change is refused
    await d.patch('/api/apps/crm/entities/deal', { definition: { ...e.definition, fields: fields.map((f: { name: string }) => (f.name === 'notes' ? { ...f, unique: true } : f)) } }).expect(409);
    await d.patch('/api/apps/crm/entities/deal', { definition: { ...e.definition, fields: fields.map((f: { name: string; type: string }) => (f.name === 'amount' ? { name: 'amount', type: 'string', indexed: true, maxLength: 50 } : f)) } }).expect(409);
    const changed = (await d.patch('/api/apps/crm/entities/deal', { definition: { ...e.definition, fields }, rev: e.rev }).expect(200)).body;
    expect(changed.reindexJob).toBeTruthy();
    await drain(h);
    const sorted = (await m.post('/api/apps/crm/entities/deal/records/query', { sort: [{ field: 'notes', dir: 'asc' }] }).expect(200)).body;
    expect(sorted.records.map((r: { values: { title: string } }) => r.values.title)).toEqual(['Two', 'One']);
    await d.del('/api/apps/crm').expect(204);
    for (const t of ['apps', 'app_entities', 'app_records', 'app_record_values', 'app_unique_values']) expect(await h.s.db(t), t).toHaveLength(0);
    expect((await audits('app.deleted')).length).toBe(1);
  });
});
