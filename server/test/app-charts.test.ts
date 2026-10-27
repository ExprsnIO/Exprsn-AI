import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bucketKey, bucketLabel, chartDefinitionSchema, groupRows, periodStarts } from '../src/apps/charts.js';
import { chartSvg, scene, toPdfDrawing } from '../src/apps/chart-render.js';
import { effectivePermissions, type Principal } from '../src/authz/policy.js';
import { forbidden } from '../src/http/problem.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * 1.8.0, Sprint 44 (B-120): charts over app records (through `records/aggregate`, so the reader's grant applies),
 * saved queries and REST endpoints (read as the reader), every aggregate and date bucket, policies and clearance (a
 * row the reader may not read is never counted), the caps, and the short cache keyed by the reader.
 *
 * The saved query and REST reads are stand-ins that keep the one rule the chart depends on (the reader needs
 * `connections:query`); their own governance is covered by saved-queries.test.ts and rest-connections.test.ts.
 */

const dealDefinition = {
  fields: [
    { name: 'title', type: 'string', required: true, indexed: true, unique: true, maxLength: 120 },
    { name: 'amount', type: 'number', indexed: true },
    { name: 'region', type: 'string', indexed: true, maxLength: 20 },
    { name: 'stage', type: 'enum', indexed: true, options: [{ value: 'Lead' }, { value: 'Won', label: 'Closed won' }, { value: 'Lost' }] },
    { name: 'closed', type: 'date', indexed: true },
    { name: 'notes', type: 'string', maxLength: 500 }
  ],
  states: { initial: 'open', states: [{ name: 'open' }, { name: 'closed' }], transitions: [{ from: ['open'], to: 'closed' }] }
};

const C = '/api/apps/crm/charts';

describe('chart helpers', () => {
  it('buckets dates in UTC the way the SQL does, and labels them', () => {
    const t = Date.parse('2026-10-14T15:00:00Z'); // a Wednesday
    expect(bucketKey(t, 'day')).toBe('2026-10-14');
    expect(bucketKey(t, 'week')).toBe('2026-10-12');
    expect(bucketKey(Date.parse('2026-10-18T23:00:00Z'), 'week')).toBe('2026-10-12');
    expect(bucketKey(Date.parse('2026-10-19T00:00:00Z'), 'week')).toBe('2026-10-19');
    expect(bucketKey(t, 'month')).toBe('2026-10');
    expect(bucketKey(t, 'quarter')).toBe('2026-Q4');
    expect(bucketKey(t, 'year')).toBe('2026');
    expect(bucketLabel('2026-10-12', 'week')).toBe('Week of 12 Oct 2026');
    expect(bucketLabel('2026-10', 'month')).toBe('Oct 2026');
    expect(bucketLabel('2026-Q4', 'quarter')).toBe('Q4 2026');
    expect(periodStarts(t, 'month')).toEqual({ current: Date.parse('2026-10-01T00:00:00Z'), previous: Date.parse('2026-09-01T00:00:00Z') });
    expect(periodStarts(t, 'quarter')).toEqual({ current: Date.parse('2026-10-01T00:00:00Z'), previous: Date.parse('2026-07-01T00:00:00Z') });
  });

  it('groups rows in memory with every aggregate', () => {
    const rows = [
      { r: 'a', v: 1, d: '2026-01-05' },
      { r: 'a', v: 3, d: '2026-02-05' },
      { r: 'b', v: '5', d: '2026-02-06T10:00:00Z' },
      { r: null, v: null, d: null }
    ];
    const g = groupRows(rows, { dimension: { field: 'r' }, measures: [{ op: 'count', label: null }, { op: 'sum', field: 'v', label: null }, { op: 'avg', field: 'v', label: null }, { op: 'min', field: 'v', label: null }, { op: 'max', field: 'v', label: null }] });
    expect(g).toEqual([
      { key: 'a', values: [2, 4, 2, 1, 3] },
      { key: 'b', values: [1, 5, 5, 5, 5] },
      { key: null, values: [1, null, null, null, null] }
    ]);
    expect(groupRows(rows, { dimension: { field: 'd', bucket: 'month' }, measures: [{ op: 'count', label: null }] })).toEqual([
      { key: '2026-01', values: [1] },
      { key: '2026-02', values: [2] },
      { key: null, values: [1] }
    ]);
  });

  it('checks a definition: tiles have no dimension, pies one measure, splits one measure', () => {
    const src = { kind: 'entity', entity: 'deal' };
    expect(chartDefinitionSchema.safeParse({ type: 'number', source: src, dimension: { field: 'stage' }, measures: [{ op: 'count' }] }).success).toBe(false);
    expect(chartDefinitionSchema.safeParse({ type: 'pie', source: src, dimension: { field: 'stage' }, measures: [{ op: 'count' }, { op: 'sum', field: 'amount' }] }).success).toBe(false);
    expect(chartDefinitionSchema.safeParse({ type: 'bar', source: src, dimension: { field: 'stage' }, split: { field: 'region' }, measures: [{ op: 'count' }, { op: 'sum', field: 'amount' }] }).success).toBe(false);
    expect(chartDefinitionSchema.safeParse({ type: 'bar', source: src, measures: [{ op: 'count' }] }).success).toBe(false);
    expect(chartDefinitionSchema.safeParse({ type: 'bar', source: src, dimension: { field: 'stage' }, measures: [{ op: 'count' }], colors: ['#ff0000'] }).success).toBe(false);
    expect(chartDefinitionSchema.safeParse({ type: 'bar', source: src, dimension: { field: 'stage' }, measures: [{ op: 'count' }], colors: ['accent', 'ok'] }).success).toBe(true);
  });
});

describe('charts over app records, queries and REST endpoints (B-120)', () => {
  let h: Harness;
  let wsId: string;

  beforeEach(async () => {
    h = await harness();
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Sales', 'confidential')).id;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.close();
  });

  async function wrap(c: { agent: Client['agent']; csrf: string }) {
    const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
    await send('put', '/api/me/workspace', { workspaceId: wsId }).expect(200);
    return { ...c, post: (p: string, b?: object) => send('post', p, b), patch: (p: string, b?: object) => send('patch', p, b), del: (p: string) => send('delete', p), get: (p: string) => c.agent.get(p) };
  }
  async function member(name: string, clearance: 'public' | 'internal' | 'confidential' = 'internal', attributes: Record<string, string> | null = null) {
    const u = await localUser(h, name, ['member'], clearance);
    await h.s.tenants.addMember(wsId, u.id);
    if (attributes) await h.s.users.update(h.tenantId, u.id, { attributes: JSON.stringify(attributes) });
    return { user: u, ...(await wrap(await login(h, name))) };
  }
  async function designer(name = 'dee') {
    const u = await localUser(h, name, ['workflow-admin', 'member'], 'confidential');
    await h.s.tenants.addMember(wsId, u.id);
    return { user: u, ...(await wrap(await loginAdmin(h, name))) };
  }
  type D = Awaited<ReturnType<typeof designer>>;
  async function setup(d: D) {
    await d.post('/api/apps', { name: 'crm', title: 'CRM', label: 'confidential', workspaceId: wsId }).expect(201);
    await d.post('/api/apps/crm/entities', { name: 'deal', title: 'Deal', label: 'internal', definition: dealDefinition }).expect(201);
    const create = [
      { values: { title: 'A', amount: 100, region: 'emea', stage: 'Won', closed: '2026-10-14' } },
      { values: { title: 'B', amount: 300, region: 'emea', stage: 'Lead', closed: '2026-10-18' } },
      { values: { title: 'C', amount: 50, region: 'apac', stage: 'Won', closed: '2026-10-19' } },
      { values: { title: 'D', amount: 1000, region: 'apac', stage: 'Lost', closed: '2025-12-31' } },
      { values: { title: 'E', region: 'amer', stage: 'Lead' } },
      // confidential: above an internal reader's clearance
      { values: { title: 'Secret', amount: 5000, region: 'emea', stage: 'Won', closed: '2026-10-14' }, label: 'confidential' }
    ];
    const out = (await d.post('/api/apps/crm/entities/deal/records/bulk', { create }).expect(200)).body;
    return out;
  }
  const def = (over: Record<string, unknown> = {}) => ({ type: 'bar', source: { kind: 'entity', entity: 'deal' }, dimension: { field: 'stage' }, measures: [{ op: 'count' }], ...over });
  const audits = async (action: string) => (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action })) as { target: string; detail: string | null }[];
  const data = async (c: { post: (p: string, b?: object) => ReturnType<D['post']> }, id: string, body: object = {}) => (await c.post(`${C}/${id}/data`, body).expect(200)).body;
  const series = (d: { data: { categories: { label: string }[]; series: { values: (number | null)[] }[] } }) => Object.fromEntries(d.data.categories.map((c, i) => [c.label, d.data.series.map((s) => s.values[i])]));

  it('computes every aggregate and date bucket over records through aggregate, with labels and a summary', async () => {
    const dee = await designer();
    await setup(dee);
    const chart = (await dee.post(C, { name: 'By stage', shared: true, definition: def({ measures: [{ op: 'count' }, { op: 'sum', field: 'amount' }, { op: 'avg', field: 'amount' }, { op: 'min', field: 'amount' }, { op: 'max', field: 'amount' }] }) }).expect(201)).body;
    expect(chart).toMatchObject({ name: 'By stage', shared: true, label: 'internal', rev: 1, sourceKind: 'entity', canEdit: true });
    // sealed at rest
    expect(String((await h.s.db('app_charts').where({ id: chart.id }).first()).data)).not.toContain('By stage');
    const d = await data(dee, chart.id);
    expect(d.state).toBe('ok');
    expect(series(d)).toEqual({ Lead: [2, 300, 300, 300, 300], Lost: [1, 1000, 1000, 1000, 1000], 'Closed won': [3, 5150, 5150 / 3, 50, 5000] });
    expect(d.data.series.map((s: { name: string }) => s.name)).toEqual(['Count', 'Sum of amount', 'Average of amount', 'Minimum of amount', 'Maximum of amount']);
    expect(d.data.summary).toMatch(/^Bar chart: By stage\. 3 categories of stage/);

    // date buckets over a date field (the record without one is "No value", last)
    const by = async (bucket: string) => {
      const c = (await dee.post(C, { name: `By ${bucket}`, definition: def({ dimension: { field: 'closed', bucket } }) }).expect(201)).body;
      return series(await data(dee, c.id));
    };
    expect(await by('day')).toEqual({ '31 Dec 2025': [1], '14 Oct 2026': [2], '18 Oct 2026': [1], '19 Oct 2026': [1], 'No value': [1] });
    expect(await by('week')).toEqual({ 'Week of 29 Dec 2025': [1], 'Week of 12 Oct 2026': [3], 'Week of 19 Oct 2026': [1], 'No value': [1] });
    expect(await by('month')).toEqual({ 'Dec 2025': [1], 'Oct 2026': [4], 'No value': [1] });
    expect(await by('quarter')).toEqual({ 'Q4 2025': [1], 'Q4 2026': [4], 'No value': [1] });
    expect(await by('year')).toEqual({ '2025': [1], '2026': [4], 'No value': [1] });
    // createdAt by month: every record was made this month
    const created = (await dee.post(C, { name: 'Created', definition: def({ type: 'line', dimension: { field: 'createdAt', bucket: 'month' } }) }).expect(201)).body;
    expect(Object.values(series(await data(dee, created.id)))).toEqual([[6]]);
    // a number tile against a target
    const tile = (await dee.post(C, { name: 'Won amount', definition: { type: 'number', source: { kind: 'entity', entity: 'deal', filter: { field: 'stage', op: 'eq', value: 'Won' } }, measures: [{ op: 'sum', field: 'amount' }], compare: { kind: 'target', value: 5000 } } }).expect(201)).body;
    const t = (await data(dee, tile.id)).data;
    expect(t).toMatchObject({ type: 'number', value: 5150, compare: { kind: 'target', value: 5000, delta: 150, pct: 3 } });
    expect(t.summary).toBe('Number: Won amount. 5,150; target 5,000, up 150 (3 %).');
    // a scatter of the amount by itself, a pie, a horizontal stacked bar split by region
    const split = (await dee.post(C, { name: 'Split', definition: def({ split: { field: 'region' }, orientation: 'horizontal', stacking: 'stacked' }) }).expect(201)).body;
    const s = (await data(dee, split.id)).data;
    expect(s.series.map((x: { name: string }) => x.name).sort()).toEqual(['amer', 'apac', 'emea']);
    const emea = s.series.find((x: { name: string }) => x.name === 'emea');
    expect(s.categories.map((c: { label: string }, i: number) => [c.label, emea.values[i]])).toEqual([['Lead', 1], ['Lost', null], ['Closed won', 2]]);

    // refused definitions: unknown and unindexed fields, a bucket on text, a sum of text
    expect((await dee.post(C, { name: 'x', definition: def({ dimension: { field: 'notes' } }) }).expect(400)).body.detail).toMatch(/notes is not indexed/);
    expect((await dee.post(C, { name: 'x', definition: def({ dimension: { field: 'region', bucket: 'month' } }) }).expect(400)).body.detail).toMatch(/only a date groups by a bucket/);
    expect((await dee.post(C, { name: 'x', definition: def({ dimension: { field: 'createdAt' } }) }).expect(400)).body.detail).toMatch(/date bucket/);
    expect((await dee.post(C, { name: 'x', definition: def({ measures: [{ op: 'sum', field: 'region' }] }) }).expect(400)).body.detail).toMatch(/number, date and boolean/);
    expect((await dee.post(C, { name: 'x', definition: def({ dimension: { field: 'ghost' } }) }).expect(400)).body.detail).toMatch(/ghost is not a field/);

    // the server-side drawing (snapshots): SVG with patterns and a role="img" summary, PDF operators
    const svg = chartSvg(d.data, 'x1');
    expect(svg).toContain('role="img"');
    expect(svg).toContain('<pattern id="x1-p1"');
    expect(svg).toContain('var(--accent)');
    expect(svg).not.toMatch(/#[0-9a-f]{6}/i);
    expect(scene(t)!.shapes.some((x) => x.t === 'text' && x.text === '5,150')).toBe(true);
    expect(toPdfDrawing(s, 400)!.ops).toMatch(/ re B/);
  });

  it('applies the reader’s policies and clearance: a hidden row is never counted, a hidden field makes the chart unavailable', async () => {
    const dee = await designer();
    const created = await setup(dee);
    const ana = await member('ana', 'internal', { region: 'emea' });
    const count = (await dee.post(C, { name: 'Count by region', shared: true, definition: def({ dimension: { field: 'region' } }) }).expect(201)).body;
    const sum = (await dee.post(C, { name: 'Sum by region', shared: true, definition: def({ dimension: { field: 'region' }, measures: [{ op: 'sum', field: 'amount' }] }) }).expect(201)).body;
    // clearance: ana (internal) does not count the confidential deal
    expect(series(await data(ana, count.id))).toEqual({ amer: [1], apac: [2], emea: [2] });
    expect(series(await data(dee, count.id))).toEqual({ amer: [1], apac: [2], emea: [3] });
    // a moderated (hidden) record is not counted by anyone
    await h.s.apps.setHidden(h.tenantId, created.created[1], true);
    expect(series(await data(dee, count.id, { fresh: true }))).toEqual({ amer: [1], apac: [2], emea: [2] });
    // a row policy: ana reaches her region only; amount is hidden from her
    const own = (await dee.post('/api/apps/crm/policies', { name: 'Own region', entity: 'deal', subjects: [{ kind: 'role', value: 'member' }], rows: { field: 'region', op: 'eq', value: '$user.attributes.region' }, fields: { amount: { read: false } } }).expect(201)).body;
    expect(series(await data(ana, count.id))).toEqual({ emea: [1] });
    expect(await data(ana, sum.id)).toEqual({ state: 'unavailable', reason: 'A policy hides amount from you.' });
    // a masked field is not summed either; a reader no policy names reaches nothing
    await dee.del(`/api/apps/crm/policies/${own.id}`).expect(204);
    await dee.post('/api/apps/crm/policies', { name: 'Masked', entity: 'deal', subjects: [{ kind: 'user', value: ana.user.id }], fields: { amount: { read: true, unmasked: false, mask: 'last4' } } }).expect(201);
    expect(await data(ana, sum.id)).toEqual({ state: 'unavailable', reason: 'A policy masks amount from you.' });
    expect(series(await data(ana, count.id))).toEqual({ amer: [1], apac: [2], emea: [1] });
    const noa = await member('noa', 'internal');
    expect(await data(noa, count.id)).toEqual({ state: 'unavailable', reason: 'No policy of this app lets you read these records.' });
    // a private chart of someone else does not exist for a reader
    const mine = (await dee.post(C, { name: 'Private', definition: def() }).expect(201)).body;
    await ana.get(`${C}/${mine.id}`).expect(404);
    expect((await ana.get(C).expect(200)).body.charts.map((c: { name: string }) => c.name).sort()).toEqual(['Count by region', 'Sum by region']);
    expect(await data(ana, mine.id)).toEqual({ state: 'unavailable', reason: 'The chart is not shared with you.' });
  });

  it('shares only through designers, versions every save and audits app.chart.*', async () => {
    const dee = await designer();
    await setup(dee);
    const mia = await member('mia');
    expect((await mia.post(C, { name: 'Team', shared: true, definition: def() }).expect(403)).body.detail).toMatch(/apps:design/);
    const own = (await mia.post(C, { name: 'Mine', definition: def() }).expect(201)).body;
    await mia.patch(`${C}/${own.id}`, { shared: true }).expect(403);
    const team = (await dee.post(C, { name: 'Team', shared: true, definition: def() }).expect(201)).body;
    await mia.patch(`${C}/${team.id}`, { name: 'Ours' }).expect(403);
    await mia.del(`${C}/${team.id}`).expect(403);
    const v2 = (await dee.patch(`${C}/${team.id}`, { rev: 1, definition: def({ type: 'pie' }) }).expect(200)).body;
    expect(v2).toMatchObject({ rev: 2, definition: { type: 'pie' } });
    expect((await dee.patch(`${C}/${team.id}`, { rev: 1, name: 'Stale' }).expect(409)).body.rev).toBe(2);
    expect((await dee.get(`${C}/${team.id}/versions`).expect(200)).body.versions.map((v: { rev: number; definition: { type: string } }) => [v.rev, v.definition.type])).toEqual([[2, 'pie'], [1, 'bar']]);
    // a label below the source's or above the app's is refused
    await dee.post(C, { name: 'Low', label: 'public', definition: def() }).expect(400);
    await dee.post(C, { name: 'High', label: 'restricted', definition: def() }).expect(400);
    await dee.del(`${C}/${team.id}`).expect(204);
    expect(await h.s.db('app_chart_versions').where({ chart_id: team.id })).toEqual([]);
    expect((await audits('app.chart.created')).length).toBe(2);
    expect((await audits('app.chart.updated'))[0]!.detail).toContain('definition');
    expect((await audits('app.chart.deleted')).length).toBe(1);
    expect((await audits('app.chart.created'))[0]!.detail).not.toContain('Team');
    // charts go with their app
    await dee.del('/api/apps/crm').expect(204);
    expect(await h.s.db('app_charts')).toEqual([]);
  });

  it('reads through a saved view only when the reader sees it', async () => {
    const dee = await designer();
    await setup(dee);
    const mia = await member('mia');
    const V = '/api/apps/crm/entities/deal/views';
    const shared = (await dee.post(V, { name: 'Won', shared: true, settings: { filters: [{ field: 'stage', op: 'eq', value: 'Won' }] } }).expect(201)).body;
    const priv = (await dee.post(V, { name: 'Mine', settings: { filters: [{ field: 'region', op: 'eq', value: 'apac' }] } }).expect(201)).body;
    const viaShared = (await dee.post(C, { name: 'Won by region', shared: true, definition: def({ source: { kind: 'entity', entity: 'deal', view: shared.id }, dimension: { field: 'region' } }) }).expect(201)).body;
    const viaPrivate = (await dee.post(C, { name: 'Apac by stage', shared: true, definition: def({ source: { kind: 'entity', entity: 'deal', view: priv.id } }) }).expect(201)).body;
    expect(series(await data(mia, viaShared.id))).toEqual({ apac: [1], emea: [1] });
    expect(series(await data(dee, viaPrivate.id))).toEqual({ Lost: [1], 'Closed won': [1] });
    expect(await data(mia, viaPrivate.id)).toEqual({ state: 'unavailable', reason: 'The saved view it reads is not shared with you.' });
    // a view the author cannot see is refused when saving
    await mia.post(C, { name: 'x', definition: def({ source: { kind: 'entity', entity: 'deal', view: priv.id } }) }).expect(400);
  });

  it('caps categories and series, and says so', async () => {
    const dee = await designer();
    await dee.post('/api/apps', { name: 'crm', title: 'CRM', label: 'confidential', workspaceId: wsId }).expect(201);
    await dee.post('/api/apps/crm/entities', { name: 'deal', title: 'Deal', label: 'internal', definition: dealDefinition }).expect(201);
    const create = Array.from({ length: 12 }, (_, i) => ({ values: { title: `T${i}`, amount: i, region: `r${String(i).padStart(2, '0')}`, stage: i % 2 ? 'Won' : 'Lead' } }));
    await dee.post('/api/apps/crm/entities/deal/records/bulk', { create }).expect(200);
    const top = (await dee.post(C, { name: 'Top', definition: def({ dimension: { field: 'region' }, measures: [{ op: 'sum', field: 'amount' }], sort: { by: 'value', dir: 'desc' }, limit: 3 }) }).expect(201)).body;
    const d = (await data(dee, top.id)).data;
    expect(d.categories.map((c: { label: string }) => c.label)).toEqual(['r11', 'r10', 'r09']);
    expect(d).toMatchObject({ truncated: true, groups: 12 });
    expect(d.summary).toMatch(/Showing the first 3 of 12\./);
    const split = (await dee.post(C, { name: 'Split', definition: def({ split: { field: 'region' } }) }).expect(201)).body;
    const s = (await data(dee, split.id)).data;
    expect(s.series.length).toBe(8);
    expect(s.truncated).toBe(true);
    await dee.post(C, { name: 'x', definition: def({ limit: 500 }) }).expect(400);
  });

  it('keeps results briefly per reader: the cache is keyed by viewer, grant and version', async () => {
    const dee = await designer();
    await setup(dee);
    const mia = await member('mia');
    const chart = (await dee.post(C, { name: 'By stage', shared: true, definition: def() }).expect(201)).body;
    const first = await data(mia, chart.id);
    expect(first.data.cached).toBe(false);
    expect((await data(mia, chart.id)).data.cached).toBe(true);
    // another reader is computed for themselves
    expect((await data(dee, chart.id)).data.cached).toBe(false);
    // a new record: mia's cached answer stays until it expires or she asks fresh
    await dee.post('/api/apps/crm/entities/deal/records', { values: { title: 'F', stage: 'Lead' } }).expect(201);
    expect(series(await data(mia, chart.id)).Lead).toEqual([2]);
    expect(series(await data(mia, chart.id, { fresh: true })).Lead).toEqual([3]);
    // a policy that names mia changes her grant, and so her key
    await dee.post('/api/apps/crm/policies', { name: 'Leads', entity: 'deal', subjects: [{ kind: 'role', value: 'member' }], rows: { field: 'stage', op: 'eq', value: 'Lead' } }).expect(201);
    const after = await data(mia, chart.id);
    expect(after.data.cached).toBe(false);
    expect(series(after)).toEqual({ Lead: [3] });
    // a new version of the chart is not served from the old one's entry
    await dee.patch(`${C}/${chart.id}`, { definition: def({ type: 'line' }) }).expect(200);
    expect((await data(mia, chart.id)).data).toMatchObject({ cached: false, type: 'line' });
  });

  it('charts a saved query and a REST endpoint as the reader, who needs connections:query', async () => {
    const dee = await designer();
    await setup(dee);
    const mia = await member('mia');
    const rows = [
      { region: 'emea', total: 10, day: '2026-10-14' },
      { region: 'emea', total: 5, day: '2026-10-20' },
      { region: 'apac', total: 7, day: '2026-09-01T08:00:00Z' }
    ];
    const result = { columns: [{ name: 'region', type: 'text' }, { name: 'total', type: 'number' }, { name: 'day', type: 'text' }], rows, truncated: false, label: 'internal' as const, masked: [], ms: 1 };
    const needs = (p: Principal) => {
      if (!effectivePermissions(p).has('connections:query')) throw forbidden(`${p.displayName} may not run saved queries.`);
    };
    vi.spyOn(h.s.savedQueries, 'get').mockResolvedValue({ id: 'Q', name: 'sales', label: 'internal' } as never);
    const run = vi.spyOn(h.s.savedQueries, 'run').mockImplementation(async (p) => {
      needs(p);
      return result as never;
    });
    vi.spyOn(h.s.restConnections, 'get').mockResolvedValue({ id: 'R', name: 'shop', label: 'internal' } as never);
    vi.spyOn(h.s.restConnections, 'endpoint').mockResolvedValue({ id: 'E', name: 'orders' } as never);
    const read = vi.spyOn(h.s.restConnections, 'read').mockImplementation(async (p) => {
      needs(p);
      return { ...result, pages: 1 } as never;
    });

    // a reader without connections:query cannot save one
    expect((await mia.post(C, { name: 'q', definition: def({ source: { kind: 'query', query: 'sales' }, dimension: { field: 'region' } }) }).expect(403)).body.detail).toMatch(/connections:query/);
    const q = (await dee.post(C, { name: 'Sales', shared: true, definition: def({ source: { kind: 'query', query: 'sales', params: { tier: 'gold' } }, dimension: { field: 'region' }, measures: [{ op: 'sum', field: 'total' }, { op: 'count' }] }) }).expect(201)).body;
    expect(q).toMatchObject({ sourceKind: 'query', label: 'internal' });
    expect(series(await data(dee, q.id))).toEqual({ apac: [7, 1], emea: [15, 2] });
    // run as the reader, at most ROW_CAP rows, held to the app's label
    expect(run.mock.calls[0]![0].userId).toBe(dee.user.id);
    expect(run.mock.calls[0]!.slice(1)).toEqual(['sales', { tier: 'gold' }, { limit: 5000, ceiling: 'confidential', via: 'app-chart' }]);
    // the reader without the right sees it as not available
    expect((await data(mia, q.id)).state).toBe('unavailable');

    const r = (await dee.post(C, { name: 'Orders by month', shared: true, definition: def({ type: 'area', source: { kind: 'rest', connection: 'shop', endpoint: 'orders' }, dimension: { field: 'day', bucket: 'month' }, measures: [{ op: 'max', field: 'total' }] }) }).expect(201)).body;
    expect(series(await data(dee, r.id))).toEqual({ 'Sep 2026': [7], 'Oct 2026': [10] });
    expect(read.mock.calls[0]!.slice(1, 4)).toEqual(['shop', 'orders', {}]);
    expect((await data(mia, r.id)).state).toBe('unavailable');
    // a dashboard filter on a column applies to the rows; one on a column it lacks does not
    const f = await data(dee, q.id, { filters: [{ id: 'reg', kind: 'value', field: 'region', value: 'emea' }, { id: 'stage', kind: 'value', field: 'stage', value: 'Won' }] });
    expect(series(f)).toEqual({ emea: [15, 2] });
    expect(f.data.filtersApplied).toEqual(['reg']);
    // a column the result lacks is an error, not a crash
    const bad = (await dee.post(C, { name: 'Bad', definition: def({ source: { kind: 'query', query: 'sales' }, dimension: { field: 'nope' } }) }).expect(201)).body;
    expect(await data(dee, bad.id)).toMatchObject({ state: 'error', detail: expect.stringMatching(/nope is not a column/) });
  });

  it('previews an unsaved definition and filters by a date range', async () => {
    const dee = await designer();
    await setup(dee);
    const p = (await dee.post(`${C}/preview`, { name: 'Try', definition: def({ dimension: { field: 'region' } }) }).expect(200)).body;
    expect(p.data.summary).toMatch(/^Bar chart: Try\./);
    await dee.post(`${C}/preview`, { definition: def({ dimension: { field: 'notes' } }) }).expect(400);
    const chart = (await dee.post(C, { name: 'By stage', definition: def() }).expect(201)).body;
    const d = await data(dee, chart.id, { filters: [{ id: 'when', kind: 'date', field: 'closed', from: '2026-10-14', to: '2026-10-18' }] });
    expect(series(d)).toEqual({ Lead: [1], 'Closed won': [2] });
    expect(d.data.filtersApplied).toEqual(['when']);
  });
});
