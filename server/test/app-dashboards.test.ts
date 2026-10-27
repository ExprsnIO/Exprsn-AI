import { inflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppDashboards, markdownHtml } from '../src/apps/dashboards.js';
import { effectivePermissions, type Principal } from '../src/authz/policy.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { forbidden } from '../src/http/problem.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * 1.8.0, Sprint 44 (B-121): dashboards per app. Private and shared dashboards, a card the viewer cannot read ("Not
 * available to you"), the dashboard's filters applied to every card that has the field, the HTML and PDF snapshots
 * computed as the viewer (`s.apps.dashboards.render`), and the `app.dashboard.*` audits.
 */

const dealDefinition = {
  fields: [
    { name: 'title', type: 'string', required: true, indexed: true, unique: true, maxLength: 120 },
    { name: 'amount', type: 'number', indexed: true },
    { name: 'region', type: 'string', indexed: true, maxLength: 20 },
    { name: 'stage', type: 'enum', indexed: true, options: [{ value: 'Lead' }, { value: 'Won' }, { value: 'Lost' }] },
    { name: 'closed', type: 'date', indexed: true }
  ]
};
const contactDefinition = { fields: [{ name: 'name', type: 'string', indexed: true, maxLength: 100 }] };

const D = '/api/apps/crm/dashboards';
const C = '/api/apps/crm/charts';

/** The text of a PDF's content streams (they are deflated). */
function pdfText(buf: Buffer): string {
  const s = buf.toString('latin1');
  let out = '';
  const re = /\/Filter \/FlateDecode \/Length (\d+) >>\nstream\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    out += inflateSync(buf.subarray(start, start + Number(m[1]))).toString('latin1');
  }
  return out;
}

describe('dashboards per app (B-121)', () => {
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
  async function member(name: string, clearance: 'public' | 'internal' | 'confidential' = 'internal') {
    const u = await localUser(h, name, ['member'], clearance);
    await h.s.tenants.addMember(wsId, u.id);
    return { user: u, ...(await wrap(await login(h, name))) };
  }
  async function designer(name = 'dee') {
    const u = await localUser(h, name, ['workflow-admin', 'member'], 'confidential');
    await h.s.tenants.addMember(wsId, u.id);
    return { user: u, ...(await wrap(await loginAdmin(h, name))) };
  }
  type W = Awaited<ReturnType<typeof designer>>;
  async function setup(d: W) {
    await d.post('/api/apps', { name: 'crm', title: 'CRM', label: 'confidential', workspaceId: wsId }).expect(201);
    await d.post('/api/apps/crm/entities', { name: 'deal', title: 'Deal', label: 'internal', definition: dealDefinition }).expect(201);
    await d.post('/api/apps/crm/entities', { name: 'contact', title: 'Contact', label: 'internal', definition: contactDefinition }).expect(201);
    const create = [
      { values: { title: 'A', amount: 100, region: 'emea', stage: 'Won', closed: '2026-10-01' } },
      { values: { title: 'B', amount: 300, region: 'emea', stage: 'Lead', closed: '2026-10-10' } },
      { values: { title: 'C', amount: 50, region: 'apac', stage: 'Won', closed: '2026-09-15' } },
      { values: { title: 'Secret', amount: 9000, region: 'emea', stage: 'Won', closed: '2026-10-02' }, label: 'confidential' }
    ];
    await d.post('/api/apps/crm/entities/deal/records/bulk', { create }).expect(200);
    await d.post('/api/apps/crm/entities/contact/records', { values: { name: 'Ann' } }).expect(201);
    const byStage = (await d.post(C, { name: 'By stage', shared: true, definition: { type: 'bar', source: { kind: 'entity', entity: 'deal' }, dimension: { field: 'stage' }, measures: [{ op: 'sum', field: 'amount' }] } }).expect(201)).body;
    const contacts = (await d.post(C, { name: 'Contacts', shared: true, definition: { type: 'number', source: { kind: 'entity', entity: 'contact' }, measures: [{ op: 'count' }] } }).expect(201)).body;
    const privateChart = (await d.post(C, { name: 'Designer only', definition: { type: 'pie', source: { kind: 'entity', entity: 'deal' }, dimension: { field: 'region' }, measures: [{ op: 'count' }] } }).expect(201)).body;
    return { byStage, contacts, privateChart };
  }
  const audits = async (action: string) => (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action })) as { target: string; detail: string | null }[];

  it('keeps private dashboards to their owner and shares them only through designers', async () => {
    const dee = await designer();
    const { byStage } = await setup(dee);
    const mia = await member('mia');
    const noa = await member('noa');
    const mine = (await mia.post(D, { name: 'My deals', cards: [{ id: 'c1', kind: 'chart', chart: byStage.id }] }).expect(201)).body;
    expect(mine).toMatchObject({ name: 'My deals', shared: false, mine: true, canEdit: true, rev: 1, label: 'internal', cards: [{ id: 'c1', kind: 'chart', size: 'medium', title: null }] });
    expect(String((await h.s.db('app_dashboards').where({ id: mine.id }).first()).data)).not.toContain('My deals');
    expect((await noa.get(D).expect(200)).body.dashboards).toEqual([]);
    await noa.get(`${D}/${mine.id}`).expect(404);
    await noa.post(`${D}/${mine.id}/data`, {}).expect(404);
    await noa.patch(`${D}/${mine.id}`, { name: 'x' }).expect(404);
    // sharing needs the design right
    expect((await mia.post(D, { name: 'Team', shared: true }).expect(403)).body.detail).toMatch(/apps:design/);
    await mia.patch(`${D}/${mine.id}`, { shared: true }).expect(403);
    const team = (await dee.post(D, { name: 'Team', shared: true, cards: [{ id: 'c1', kind: 'chart', chart: byStage.id, size: 'wide' }] }).expect(201)).body;
    expect((await noa.get(D).expect(200)).body.dashboards.map((x: { name: string; canEdit: boolean }) => [x.name, x.canEdit])).toEqual([['Team', false]]);
    await noa.patch(`${D}/${team.id}`, { name: 'Ours' }).expect(403);
    await noa.del(`${D}/${team.id}`).expect(403);
    // moving and resizing cards is an update guarded by the revision
    const moved = (await dee.patch(`${D}/${team.id}`, { rev: 1, cards: [{ id: 't', kind: 'text', markdown: '# Notes', size: 'small' }, { id: 'c1', kind: 'chart', chart: byStage.id, size: 'full' }] }).expect(200)).body;
    expect(moved.cards.map((c: { id: string; size: string }) => `${c.id}:${c.size}`)).toEqual(['t:small', 'c1:full']);
    expect((await dee.patch(`${D}/${team.id}`, { rev: 1, name: 'Stale' }).expect(409)).body.rev).toBe(2);
    // cards are checked: a chart the author cannot see, an entity that is not there, duplicate ids
    const other = (await dee.post(C, { name: 'Dee private', definition: { type: 'bar', source: { kind: 'entity', entity: 'deal' }, dimension: { field: 'stage' }, measures: [{ op: 'count' }] } }).expect(201)).body;
    await mia.post(D, { name: 'x', cards: [{ id: 'c', kind: 'chart', chart: other.id }] }).expect(400);
    await mia.post(D, { name: 'x', cards: [{ id: 'c', kind: 'view', entity: 'ghost' }] }).expect(400);
    await mia.post(D, { name: 'x', cards: [{ id: 'c', kind: 'text', markdown: 'a' }, { id: 'c', kind: 'text', markdown: 'b' }] }).expect(400);
    await mia.post(D, { name: 'x', refresh: 7 }).expect(400);
    await dee.del(`${D}/${team.id}`).expect(204);
    await mia.del(`${D}/${mine.id}`).expect(204);
    expect((await audits('app.dashboard.created')).length).toBe(2);
    expect((await audits('app.dashboard.updated'))[0]!.detail).toContain('cards');
    expect((await audits('app.dashboard.deleted')).length).toBe(2);
    expect((await audits('app.dashboard.created'))[0]!.detail).not.toContain('My deals');
  });

  it('computes every card as the viewer: a card they cannot read says Not available to you', async () => {
    const dee = await designer();
    const { byStage, contacts, privateChart } = await setup(dee);
    const noa = await member('noa');
    vi.spyOn(h.s.savedQueries, 'get').mockResolvedValue({ id: 'Q', name: 'sales', label: 'internal' } as never);
    vi.spyOn(h.s.savedQueries, 'run').mockImplementation(async (p: Principal) => {
      if (!effectivePermissions(p).has('connections:query')) throw forbidden('needs connections:query');
      return { columns: [{ name: 'n', type: 'number' }], rows: [{ n: 4 }], truncated: false, label: 'internal', masked: [], ms: 1 } as never;
    });
    const query = (await dee.post(C, { name: 'From the warehouse', shared: true, definition: { type: 'number', source: { kind: 'query', query: 'sales' }, measures: [{ op: 'sum', field: 'n' }] } }).expect(201)).body;
    const V = '/api/apps/crm/entities/deal/views';
    const won = (await dee.post(V, { name: 'Won deals', shared: true, settings: { filters: [{ field: 'stage', op: 'eq', value: 'Won' }], columns: { fields: ['title', 'amount'], meta: [] } } }).expect(201)).body;
    const dash = (
      await dee
        .post(D, {
          name: 'Sales',
          shared: true,
          cards: [
            { id: 'stage', kind: 'chart', chart: byStage.id },
            { id: 'contacts', kind: 'chart', chart: contacts.id, size: 'small' },
            { id: 'mine', kind: 'chart', chart: privateChart.id, title: 'Regions' },
            { id: 'wh', kind: 'chart', chart: query.id },
            { id: 'won', kind: 'view', entity: 'deal', view: won.id, rows: 5 },
            { id: 'note', kind: 'text', markdown: 'Read **this** <script>alert(1)</script>\n\n- one\n- two' }
          ]
        })
        .expect(201)
    ).body;
    const forNoa = (await noa.post(`${D}/${dash.id}/data`, {}).expect(200)).body;
    const card = (id: string) => forNoa.cards.find((c: { id: string }) => c.id === id);
    // noa (internal) sums without the confidential deal
    expect(card('stage')).toMatchObject({ state: 'ok', title: 'By stage' });
    expect(Object.fromEntries(card('stage').chart.categories.map((c: { label: string }, i: number) => [c.label, card('stage').chart.series[0].values[i]]))).toEqual({ Lead: 300, Won: 150 });
    expect(card('contacts').chart.value).toBe(1);
    // the designer's private chart and the saved query (noa lacks connections:query) are not available to her
    expect(card('mine')).toMatchObject({ state: 'unavailable', title: 'Regions' });
    expect(card('mine').chart).toBeUndefined();
    expect(card('wh')).toMatchObject({ state: 'unavailable' });
    // the view's table, as noa reads it
    // The view has no sort, and records made in the same millisecond tie on their creation time: compare the rows as a set.
    expect(card('won').table).toMatchObject({ entity: 'deal', columns: [{ name: 'title' }, { name: 'amount' }], total: 2 });
    expect([...card('won').table.rows].sort()).toEqual([['A', '100'], ['C', '50']]);
    expect(card('note').html).toBe('<p>Read <strong>this</strong> &lt;script&gt;alert(1)&lt;/script&gt;</p><ul><li>one</li><li>two</li></ul>');
    // the designer sees every card, the confidential deal included
    const forDee = (await dee.post(`${D}/${dash.id}/data`, {}).expect(200)).body;
    expect(forDee.cards.every((c: { state: string }) => c.state === 'ok')).toBe(true);
    expect(forDee.cards.find((c: { id: string }) => c.id === 'won').table.total).toBe(3);
    // a hidden field under a policy: the view card leaves the column out, the sum chart is unavailable
    await dee.post('/api/apps/crm/policies', { name: 'No amounts', entity: 'deal', subjects: [{ kind: 'role', value: 'member' }], fields: { amount: { read: false } } }).expect(201);
    const later = (await noa.post(`${D}/${dash.id}/data`, { fresh: true }).expect(200)).body;
    const lc = (id: string) => later.cards.find((c: { id: string }) => c.id === id);
    expect(lc('stage').state).toBe('unavailable');
    expect(lc('won').table.columns.map((c: { name: string }) => c.name)).toEqual(['title']);
  });

  it('applies the dashboard filters to every card that has the field, with defaults', async () => {
    const dee = await designer();
    const { byStage, contacts } = await setup(dee);
    const dash = (
      await dee
        .post(D, {
          name: 'Filtered',
          shared: true,
          filters: [
            { id: 'when', kind: 'date', field: 'closed', label: 'Closed', default: { from: '2026-10-01', to: '2026-10-31' } },
            { id: 'reg', kind: 'value', field: 'region', label: 'Region' }
          ],
          cards: [
            { id: 'stage', kind: 'chart', chart: byStage.id },
            { id: 'contacts', kind: 'chart', chart: contacts.id },
            { id: 'deals', kind: 'view', entity: 'deal' }
          ]
        })
        .expect(201)
    ).body;
    const sums = (b: { cards: { id: string; chart?: { categories: { label: string }[]; series: { values: number[] }[] } }[] }) => {
      const c = b.cards.find((x) => x.id === 'stage')!.chart!;
      return Object.fromEntries(c.categories.map((k, i) => [k.label, c.series[0]!.values[i]]));
    };
    // the default range: October only (C closed in September)
    const a = (await dee.post(`${D}/${dash.id}/data`, {}).expect(200)).body;
    expect(a.applied).toEqual([{ id: 'when', kind: 'date', field: 'closed', from: '2026-10-01', to: '2026-10-31' }]);
    expect(sums(a)).toEqual({ Lead: 300, Won: 9100 });
    expect(a.cards.find((c: { id: string }) => c.id === 'stage').chart.filtersApplied).toEqual(['when']);
    // contacts have no closed or region field: unfiltered
    expect(a.cards.find((c: { id: string }) => c.id === 'contacts').chart).toMatchObject({ value: 1, filtersApplied: [] });
    expect(a.cards.find((c: { id: string }) => c.id === 'deals').table).toMatchObject({ total: 3, filtersApplied: ['when'] });
    // a region and a wider range
    const b = (await dee.post(`${D}/${dash.id}/data`, { filters: { when: { from: '2026-09-01', to: null }, reg: { value: 'apac' } } }).expect(200)).body;
    expect(sums(b)).toEqual({ Won: 50 });
    expect(b.cards.find((c: { id: string }) => c.id === 'deals').table.total).toBe(1);
    // cleared: everything
    expect(sums((await dee.post(`${D}/${dash.id}/data`, { filters: { when: {} } }).expect(200)).body)).toEqual({ Lead: 300, Won: 9150 });
    await dee.post(`${D}/${dash.id}/data`, { filters: { when: { from: '2026-10-31', to: '2026-10-01' } } }).expect(400);
    expect(AppDashboards.applied({ filters: [] }, { x: { value: 1 } })).toEqual([]);
  });

  it('renders HTML and PDF snapshots computed as the viewer, and audits them', async () => {
    const dee = await designer();
    const { byStage, contacts, privateChart } = await setup(dee);
    const noa = await member('noa');
    const dash = (
      await dee
        .post(D, {
          name: 'Board pack',
          description: 'Monthly',
          shared: true,
          filters: [{ id: 'reg', kind: 'value', field: 'region', label: 'Region' }],
          cards: [
            { id: 'stage', kind: 'chart', chart: byStage.id, size: 'large' },
            { id: 'contacts', kind: 'chart', chart: contacts.id, size: 'small' },
            { id: 'mine', kind: 'chart', chart: privateChart.id, title: 'Regions' },
            { id: 'deals', kind: 'view', entity: 'deal', rows: 3 },
            { id: 'note', kind: 'text', markdown: '## Notes\n\nFigures are **unaudited**.' }
          ]
        })
        .expect(201)
    ).body;
    const p = await loadPrincipal(h.s, h.tenantId, noa.user.id, {});
    const html = await h.s.apps.dashboards.render(p!, dash.id, { format: 'html', filters: { reg: { value: 'emea' } } });
    expect(html.contentType).toBe('text/html; charset=utf-8');
    expect(html.filename).toMatch(/^board-pack-\d{8}-\d{4}\.html$/);
    const page = html.bytes.toString('utf8');
    expect(page).toContain('<title>Board pack</title>');
    expect(page).toContain("default-src 'none'");
    expect(page).toContain('role="img"');
    expect(page).toContain('View as table');
    expect(page).toContain('Not available to you.');
    expect(page).toContain('Region: emea');
    expect(page).toContain('<strong>unaudited</strong>');
    expect(page).not.toContain('Secret');
    expect(page).not.toContain('9,000');
    expect(page).not.toContain('<script');
    const pdf = await h.s.apps.dashboards.render(p!, dash.id, { format: 'pdf' });
    expect(pdf.contentType).toBe('application/pdf');
    expect(pdf.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    const text = pdfText(pdf.bytes);
    expect(text).toMatch(/ re B/); // the bars, as vector drawing
    expect(text).toContain('(Not available to you.)');
    expect(text).not.toContain('Secret');
    // the designer's snapshot has the private chart
    const dp = await loadPrincipal(h.s, h.tenantId, dee.user.id, {});
    expect((await h.s.apps.dashboards.render(dp!, dash.id, { format: 'html' })).bytes.toString()).not.toContain('Not available to you.');
    // someone who cannot see the dashboard gets not found
    const mine = (await dee.post(D, { name: 'Private' }).expect(201)).body;
    await expect(h.s.apps.dashboards.render(p!, mine.id, { format: 'pdf' })).rejects.toMatchObject({ status: 404 });
    // the download route
    const res = await noa.get(`${D}/${dash.id}/render?format=html&filters=${encodeURIComponent(JSON.stringify({ reg: { value: 'apac' } }))}`).expect(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="board-pack-/);
    await noa.get(`${D}/${dash.id}/render?format=docx`).expect(400);
    await noa.get(`${D}/${mine.id}/render?format=pdf`).expect(404);
    const rendered = await audits('app.dashboard.rendered');
    expect(rendered.length).toBe(4);
    expect(rendered.map((r) => JSON.parse(r.detail!).format).sort()).toEqual(['html', 'html', 'html', 'pdf']);
    expect(JSON.parse(rendered[0]!.detail!)).toMatchObject({ cards: 5, unavailable: 1, filters: ['reg'] });
  });

  it('renders Markdown safely', () => {
    expect(markdownHtml('# Title\n\n`code` and *it*\n\n| a | b |\n| --- | --- |\n| <b>1</b> | 2 |')).toBe('<h4>Title</h4><p><code>code</code> and <em>it</em></p><table><thead><tr><th scope="col">a</th><th scope="col">b</th></tr></thead><tbody><tr><td>&lt;b&gt;1&lt;/b&gt;</td><td>2</td></tr></tbody></table>');
    expect(markdownHtml('[x](javascript:alert(1)) <img src=x onerror=alert(1)>')).not.toMatch(/<a|<img/);
  });
});
