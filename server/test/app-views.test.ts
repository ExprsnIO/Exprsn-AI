import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * Saved views of the Records tab and the board paged per column (the exprsn-platform low-code port,
 * docs/decisions/lowcode-port.md, follow-ups 1 and 4).
 */

const dealDefinition = {
  fields: [
    { name: 'title', type: 'string', required: true, indexed: true, unique: true, maxLength: 120 },
    { name: 'amount', type: 'number', indexed: true, min: 0 },
    { name: 'region', type: 'string', indexed: true, maxLength: 20 },
    { name: 'stage', type: 'enum', indexed: true, options: [{ value: 'Lead' }, { value: 'Won', label: 'Closed won' }, { value: 'Lost' }] },
    { name: 'kind', type: 'enum', options: [{ value: 'new' }, { value: 'renewal' }] },
    { name: 'notes', type: 'string', multiline: true, maxLength: 5000 }
  ],
  states: { initial: 'open', states: [{ name: 'open' }, { name: 'review' }, { name: 'closed' }], transitions: [{ from: ['open'], to: 'review' }, { from: ['review'], to: 'closed' }] }
};

const settings = (over: Record<string, unknown> = {}) => ({ layout: 'table', filters: [{ field: 'amount', op: 'gte', value: 100 }], q: 'co', sort: [{ field: 'amount', dir: 'desc' }], columns: { fields: ['amount', 'title'], meta: ['state', 'updated'] }, pageSize: 25, ...over });

describe('saved views and the paged board (the low-code port)', () => {
  let h: Harness;
  let wsId: string;

  beforeEach(async () => {
    h = await harness();
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Sales', 'confidential')).id;
  });
  afterEach(async () => {
    await h.close();
  });

  type C = Awaited<ReturnType<typeof member>>;
  async function wrap(c: { agent: Client['agent']; csrf: string }) {
    const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
    await send('put', '/api/me/workspace', { workspaceId: wsId }).expect(200);
    return { ...c, post: (p: string, b?: object) => send('post', p, b), put: (p: string, b?: object) => send('put', p, b), patch: (p: string, b?: object) => send('patch', p, b), del: (p: string) => send('delete', p), get: (p: string) => c.agent.get(p) };
  }
  async function member(name: string, clearance: 'public' | 'internal' | 'confidential' = 'confidential', attributes: Record<string, string> | null = null) {
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
  async function setup(d: C) {
    await d.post('/api/apps', { name: 'crm', title: 'CRM', label: 'confidential', workspaceId: wsId }).expect(201);
    await d.post('/api/apps/crm/entities', { name: 'deal', title: 'Deal', label: 'internal', definition: dealDefinition }).expect(201);
  }
  const V = '/api/apps/crm/entities/deal/views';
  const audits = async (action: string) => (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action })) as { target: string; detail: string | null }[];
  const names = (body: { views: { name: string }[] }) => body.views.map((v) => v.name).sort();

  it('keeps private views to their owner and shares views with readers only through designers', async () => {
    const dee = await designer();
    const mia = await member('mia');
    const noa = await member('noa');
    await setup(dee);

    // a reader saves a private view; the settings come back as saved, the name and settings are sealed at rest
    const mine = (await mia.post(V, { name: 'Big deals', settings: settings() }).expect(201)).body;
    expect(mine).toMatchObject({ name: 'Big deals', shared: false, mine: true, canEdit: true, label: 'internal', settings: { layout: 'table', q: 'co', pageSize: 25, columns: { fields: ['amount', 'title'] } } });
    const row = await h.s.db('app_views').where({ id: mine.id }).first();
    expect(String(row.data)).not.toContain('Big deals');
    expect(String(row.data)).not.toContain('amount');
    expect((await audits('app.view.created'))[0]!.detail).not.toContain('Big deals');

    // nobody else sees it, changes it or deletes it
    expect((await noa.get(V).expect(200)).body.views).toEqual([]);
    await noa.patch(`${V}/${mine.id}`, { name: 'Mine now' }).expect(404);
    await noa.del(`${V}/${mine.id}`).expect(404);
    await dee.patch(`${V}/${mine.id}`, { name: 'Mine now' }).expect(404);

    // sharing needs the design right: a reader cannot share, on create or by update
    expect((await mia.post(V, { name: 'Team', shared: true, settings: settings() }).expect(403)).body.detail).toMatch(/apps:design/);
    await mia.patch(`${V}/${mine.id}`, { shared: true }).expect(403);
    expect((await mia.get(V).expect(200)).body.canShare).toBe(false);

    // a designer shares one; every reader of the app sees it, only designers and the owner change it
    expect((await dee.get(V).expect(200)).body.canShare).toBe(true);
    const team = (await dee.post(V, { name: 'Pipeline', shared: true, settings: settings({ layout: 'board', groupBy: '@state', filters: [], q: '' }) }).expect(201)).body;
    expect(names((await mia.get(V).expect(200)).body)).toEqual(['Big deals', 'Pipeline']);
    const seen = (await noa.get(V).expect(200)).body.views[0];
    expect(seen).toMatchObject({ id: team.id, shared: true, mine: false, canEdit: false, settings: { layout: 'board', groupBy: '@state' } });
    await noa.patch(`${V}/${team.id}`, { name: 'Ours' }).expect(403);
    await noa.del(`${V}/${team.id}`).expect(403);
    const dan = await designer('dan');
    expect((await dan.patch(`${V}/${team.id}`, { name: 'Pipeline by state' }).expect(200)).body).toMatchObject({ name: 'Pipeline by state', canEdit: true, mine: false });
    expect((await audits('app.view.updated'))[0]!.detail).toContain(dee.user.id);

    // names are unique per owner (private) and among shared views
    await mia.post(V, { name: 'big DEALS', settings: settings() }).expect(409);
    await dee.post(V, { name: 'Pipeline by state', shared: true, settings: settings() }).expect(409);

    // the owner deletes their private view; a designer deletes a shared one
    await mia.del(`${V}/${mine.id}`).expect(204);
    await dan.del(`${V}/${team.id}`).expect(204);
    expect((await mia.get(V).expect(200)).body.views).toEqual([]);
    expect((await audits('app.view.deleted')).length).toBe(2);
  });

  it('checks settings against the entity and refuses unknown or unindexed fields', async () => {
    const dee = await designer();
    const mia = await member('mia');
    await setup(dee);
    const bad = await mia.post(V, { name: 'x', settings: settings({ filters: [{ field: 'notes', op: 'eq', value: 'a' }], sort: [{ field: 'nope', dir: 'asc' }], columns: { fields: ['ghost'], meta: [] }, groupBy: 'kind', state: 'gone' }) }).expect(400);
    expect(bad.body.problems.join('\n')).toMatch(/notes is not indexed/);
    expect(bad.body.problems.join('\n')).toMatch(/nope is not a field/);
    expect(bad.body.problems.join('\n')).toMatch(/ghost is not a field/);
    expect(bad.body.problems.join('\n')).toMatch(/kind is not indexed/);
    expect(bad.body.problems.join('\n')).toMatch(/gone is not a state/);
    await mia.post(V, { name: 'x', settings: { ...settings(), pageSize: 33 } }).expect(400);
    await mia.post(V, { name: 'x', settings: { ...settings(), extra: 1 } }).expect(400);
    await mia.post(V, { name: 'x', ownerId: dee.user.id, settings: settings() }).expect(400);
  });

  it('lists views only at labels the reader clears, within the entity and app labels', async () => {
    const dee = await designer();
    const pat = await member('pat', 'internal');
    await setup(dee);
    // a view is labelled the entity's label at least, the app's at most, and the creator's clearance caps it
    await dee.post(V, { name: 'low', shared: true, label: 'public', settings: settings() }).expect(400);
    await dee.post(V, { name: 'high', shared: true, label: 'restricted', settings: settings() }).expect(400);
    await pat.post(V, { name: 'mine', label: 'confidential', settings: settings() }).expect(403);
    await dee.post(V, { name: 'Confidential pipeline', shared: true, label: 'confidential', settings: settings() }).expect(201);
    const open = (await dee.post(V, { name: 'Open pipeline', shared: true, settings: settings() }).expect(201)).body;
    // pat (internal) sees the internal view only, and cannot make it their default unless they see it
    expect(names((await pat.get(V).expect(200)).body)).toEqual(['Open pipeline']);
    const hidden = (await h.s.db('app_views').where({ label: 'confidential' }).first()) as { id: string };
    await pat.put(`${V}/default`, { view: hidden.id }).expect(404);
    await pat.put(`${V}/default`, { view: open.id }).expect(200);
    // raising the shared view's label above pat's clearance drops it from pat's list (and their default with it)
    await dee.patch(`${V}/${open.id}`, { label: 'confidential' }).expect(200);
    const after = (await pat.get(V).expect(200)).body;
    expect(after.views).toEqual([]);
    expect(after.defaultView).toBeNull();
  });

  it('keeps one personal default per entity, and drops it with an unshared or deleted view', async () => {
    const dee = await designer();
    const mia = await member('mia');
    await setup(dee);
    const a = (await mia.post(V, { name: 'A', settings: settings() }).expect(201)).body;
    const team = (await dee.post(V, { name: 'Team', shared: true, settings: settings({ layout: 'board' }) }).expect(201)).body;
    expect((await mia.put(`${V}/default`, { view: a.id }).expect(200)).body).toEqual({ defaultView: a.id });
    expect((await mia.put(`${V}/default`, { view: team.id }).expect(200)).body).toEqual({ defaultView: team.id });
    let list = (await mia.get(V).expect(200)).body;
    expect(list.defaultView).toBe(team.id);
    expect(list.views.filter((v: { isDefault: boolean }) => v.isDefault).map((v: { id: string }) => v.id)).toEqual([team.id]);
    // dee's own default is separate
    expect((await dee.get(V).expect(200)).body.defaultView).toBeNull();
    // unsharing drops the readers' defaults
    await dee.patch(`${V}/${team.id}`, { shared: false }).expect(200);
    list = (await mia.get(V).expect(200)).body;
    expect(list.defaultView).toBeNull();
    expect(list.views.map((v: { id: string }) => v.id)).toEqual([a.id]);
    await mia.put(`${V}/default`, { view: a.id }).expect(200);
    await mia.del(`${V}/${a.id}`).expect(204);
    expect(await h.s.db('app_view_defaults').where({ user_id: mia.user.id })).toEqual([]);
    await mia.put(`${V}/default`, { view: null }).expect(200);
    expect((await audits('app.view.default')).length).toBe(4);
  });

  it('needs records:read, and a view of an app the caller cannot see does not exist for them', async () => {
    const dee = await designer();
    await setup(dee);
    const out = await localUser(h, 'oscar', ['member'], 'confidential'); // not a member of the app's workspace
    const o = await login(h, 'oscar');
    expect(out.id).toBeTruthy();
    await o.agent.get(V).expect(404);
    const view = (await dee.post(V, { name: 'Team', shared: true, settings: settings() }).expect(201)).body;
    await o.agent.patch(`${V}/${view.id}`).set('x-csrf-token', o.csrf).send({ name: 'x' }).expect(404);
    // a role without records:read is refused at the route
    const vic = await localUser(h, 'vic', ['flag-reviewer'], 'confidential');
    await h.s.tenants.addMember(wsId, vic.id);
    const v = await wrap(await login(h, 'vic'));
    await v.get(V).expect(403);
    await v.post(V, { name: 'x', settings: settings() }).expect(403);
    await v.post('/api/apps/crm/entities/deal/records/board', { by: 'stage' }).expect(403);
  });

  it('never widens access: a shared view opens with each reader’s own policies', async () => {
    const dee = await designer();
    const ana = await member('ana', 'confidential', { region: 'emea' });
    await setup(dee);
    const rec = async (values: Record<string, unknown>) => (await dee.post('/api/apps/crm/entities/deal/records', { values }).expect(201)).body as { id: string };
    await rec({ title: 'Contoso', amount: 100, region: 'emea', stage: 'Won' });
    await rec({ title: 'Tailspin', amount: 400, region: 'apac', stage: 'Won' });
    await dee.post('/api/apps/crm/policies', { name: 'Own region', entity: 'deal', subjects: [{ kind: 'role', value: 'member' }], rows: { field: 'region', op: 'eq', value: '$user.attributes.region' }, fields: { amount: { read: false } } }).expect(201);
    // the designer shares a view filtering on every region, sorted by amount (which ana may not read)
    const view = (await dee.post(V, { name: 'All Won', shared: true, settings: settings({ filters: [{ field: 'stage', op: 'eq', value: 'Won' }], q: '', sort: [{ field: 'updatedAt', dir: 'desc' }] }) }).expect(201)).body;
    const seen = (await ana.get(V).expect(200)).body.views.find((v: { id: string }) => v.id === view.id);
    expect(seen.settings.filters).toEqual([{ field: 'stage', op: 'eq', value: 'Won' }]);
    // opening it is a records query with its settings: ana gets her region only, with the hidden field left out
    const filter = encodeURIComponent(JSON.stringify(seen.settings.filters[0]));
    const page = (await ana.get(`/api/apps/crm/entities/deal/records?filter=${filter}&sort=updatedAt:desc`).expect(200)).body;
    expect(page.records.map((r: { values: { title: string } }) => r.values.title)).toEqual(['Contoso']);
    expect(page.records[0].values.amount).toBeUndefined();
    expect(page.total).toBe(1);
    // the board with the same settings: counts and cards are hers too
    const board = (await ana.post('/api/apps/crm/entities/deal/records/board', { by: 'stage', filter: seen.settings.filters[0] }).expect(200)).body;
    expect(board.total).toBe(1);
    expect(board.columns.find((c: { value: string }) => c.value === 'Won')).toMatchObject({ total: 1, label: 'Closed won' });
    // a view naming a field ana may not read does not let her sort by it
    await ana.get('/api/apps/crm/entities/deal/records?sort=amount:desc').expect(403);
    await ana.post('/api/apps/crm/entities/deal/records/board', { by: 'stage', sort: [{ field: 'amount', dir: 'desc' }] }).expect(403);
  });

  it('removes views and defaults with their entity and with their app', async () => {
    const dee = await designer();
    const mia = await member('mia');
    await setup(dee);
    await dee.post('/api/apps/crm/entities', { name: 'contact', title: 'Contact', label: 'internal', definition: { fields: [{ name: 'name', type: 'string', indexed: true, maxLength: 100 }] } }).expect(201);
    const a = (await mia.post(V, { name: 'A', settings: settings() }).expect(201)).body;
    await mia.put(`${V}/default`, { view: a.id }).expect(200);
    const c = (await mia.post('/api/apps/crm/entities/contact/views', { name: 'C', settings: settings({ filters: [], sort: [], q: '', columns: null }) }).expect(201)).body;
    await mia.put('/api/apps/crm/entities/contact/views/default', { view: c.id }).expect(200);
    await dee.del('/api/apps/crm/entities/deal').expect(204);
    expect(await h.s.db('app_views').where({ id: a.id })).toEqual([]);
    expect((await h.s.db('app_view_defaults').where({ user_id: mia.user.id })).map((r: { view_id: string }) => r.view_id)).toEqual([c.id]);
    await dee.del('/api/apps/crm').expect(204);
    expect(await h.s.db('app_views')).toEqual([]);
    expect(await h.s.db('app_view_defaults')).toEqual([]);
  });

  it('pages the board per column on the server, with counts, a no-value column and Load more', async () => {
    const dee = await designer();
    const mia = await member('mia');
    await setup(dee);
    const rec = async (values: Record<string, unknown>) => (await mia.post('/api/apps/crm/entities/deal/records', { values }).expect(201)).body as { id: string };
    for (let i = 0; i < 7; i++) await rec({ title: `Lead ${i}`, amount: i, stage: 'Lead' });
    for (let i = 0; i < 3; i++) await rec({ title: `Won ${i}`, amount: 10 + i, stage: 'Won' });
    await rec({ title: 'Blank', amount: 1 });
    const B = '/api/apps/crm/entities/deal/records/board';

    const board = (await mia.post(B, { by: 'stage', limit: 3, sort: [{ field: 'amount', dir: 'desc' }] }).expect(200)).body;
    expect(board.total).toBe(11);
    expect(board.columns.map((c: { value: string | null; total: number }) => [c.value, c.total])).toEqual([['Lead', 7], ['Won', 3], ['Lost', 0], [null, 1]]);
    const lead = board.columns[0];
    expect(lead.records.map((r: { values: { title: string } }) => r.values.title)).toEqual(['Lead 6', 'Lead 5', 'Lead 4']);
    expect(lead.nextCursor).toBeTruthy();
    expect(board.columns[1].nextCursor).toBeNull();
    expect(board.columns[3].records.map((r: { values: { title: string } }) => r.values.title)).toEqual(['Blank']);

    // Load more: one column from its cursor
    const more = (await mia.post(B, { by: 'stage', limit: 3, sort: [{ field: 'amount', dir: 'desc' }], columns: [{ value: 'Lead', cursor: lead.nextCursor }] }).expect(200)).body;
    expect(more.columns).toHaveLength(1);
    expect(more.columns[0].records.map((r: { values: { title: string } }) => r.values.title)).toEqual(['Lead 3', 'Lead 2', 'Lead 1']);
    const last = (await mia.post(B, { by: 'stage', limit: 3, sort: [{ field: 'amount', dir: 'desc' }], columns: [{ value: 'Lead', cursor: more.columns[0].nextCursor }] }).expect(200)).body;
    expect(last.columns[0].records.map((r: { values: { title: string } }) => r.values.title)).toEqual(['Lead 0']);
    expect(last.columns[0].nextCursor).toBeNull();

    // the reader's filter and search narrow every column and its count
    const narrowed = (await mia.post(B, { by: 'stage', filter: { and: [{ field: 'amount', op: 'gte', value: 5 }] }, q: 'lead' }).expect(200)).body;
    expect(narrowed.columns.map((c: { total: number }) => c.total)).toEqual([2, 0, 0, 0]);

    // by state: every record starts open; a transition moves it between columns as before
    const byState = (await mia.post(B, { by: '@state', limit: 50 }).expect(200)).body;
    expect(byState.columns.map((c: { value: string | null; total: number }) => [c.value, c.total])).toEqual([['open', 11], ['review', 0], ['closed', 0], [null, 0]]);
    const first = byState.columns[0].records[0];
    await mia.post(`/api/apps/crm/entities/deal/records/${first.id}/transition`, { to: 'review', version: first.version }).expect(200);
    expect((await mia.post(B, { by: '@state' }).expect(200)).body.columns[1]).toMatchObject({ value: 'review', total: 1 });

    // only the state, indexed enums and static lookups group a board
    expect((await mia.post(B, { by: 'kind' }).expect(400)).body.detail).toMatch(/not indexed/);
    expect((await mia.post(B, { by: 'amount' }).expect(400)).body.detail).toMatch(/number field/);
    await mia.post(B, { by: 'nope' }).expect(400);
  });
});
