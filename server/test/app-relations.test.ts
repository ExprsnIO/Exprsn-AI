import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppPackages } from '../src/apps/packages.js';
import request from 'supertest';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * 1.8.0, Sprint 45 (B-128): many-to-many relationships and back-references ("related records") in Apps.
 */

const companyDef = { fields: [{ name: 'name', type: 'string', required: true, indexed: true, maxLength: 120 }, { name: 'region', type: 'string', indexed: true, maxLength: 20 }] };
const tagDef = { fields: [{ name: 'name', type: 'string', indexed: true, maxLength: 60 }] };
const ticketDef = {
  fields: [
    { name: 'title', type: 'string', required: true, indexed: true, maxLength: 120 },
    { name: 'priority', type: 'number', indexed: true },
    { name: 'companies', type: 'relation', entity: 'company', inverse: 'tickets', inverseTitle: 'Tickets', twoWay: true, max: 3 },
    { name: 'related', type: 'relation', entity: 'ticket', symmetric: true, title: 'Related tickets' },
    { name: 'tags', type: 'relation', entity: 'tag', onDelete: 'block' },
    { name: 'owner', type: 'reference', entity: 'company', indexed: true, inverse: 'owned', inverseTitle: 'Owned tickets' }
  ]
};
const taskDef = { fields: [{ name: 'name', type: 'string', indexed: true, maxLength: 60 }, { name: 'parent', type: 'relation', entity: 'ticket', required: true, max: 1, inverse: 'tasks' }] };

describe('relations and back-references (B-128)', () => {
  let h: Harness;
  let wsId: string;

  beforeEach(async () => {
    h = await harness();
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Support', 'confidential')).id;
  });
  afterEach(async () => {
    await h.close();
  });

  async function wrap(c: Client) {
    const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
    await send('put', '/api/me/workspace', { workspaceId: wsId }).expect(200);
    return { ...c, post: (p: string, b?: object) => send('post', p, b), put: (p: string, b?: object) => send('put', p, b), patch: (p: string, b?: object) => send('patch', p, b), del: (p: string) => send('delete', p), get: (p: string) => c.agent.get(p) };
  }
  type C = Awaited<ReturnType<typeof wrap>> & { user: { id: string } };
  async function member(name: string, clearance: 'public' | 'internal' | 'confidential' = 'confidential'): Promise<C> {
    const u = await localUser(h, name, ['member'], clearance);
    await h.s.tenants.addMember(wsId, u.id);
    return { user: u, ...(await wrap(await login(h, name))) };
  }
  async function designer(name = 'dee'): Promise<C> {
    const u = await localUser(h, name, ['workflow-admin', 'member'], 'confidential');
    await h.s.tenants.addMember(wsId, u.id);
    return { user: u, ...(await wrap(await loginAdmin(h, name))) };
  }
  const R = (entity: string) => `/api/apps/desk/entities/${entity}/records`;
  const L = (entity: string, id: string, rel: string) => `${R(entity)}/${id}/links/${rel}`;
  const audits = async (action: string) => (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action })) as { target: string; detail: string | null; label: string }[];
  const ids = (body: { records: { id: string }[] }) => body.records.map((r) => r.id);

  async function setup(d: C) {
    await d.post('/api/apps', { name: 'desk', title: 'Desk', label: 'confidential', workspaceId: wsId }).expect(201);
    await d.post('/api/apps/desk/entities', { name: 'company', label: 'internal', definition: companyDef }).expect(201);
    await d.post('/api/apps/desk/entities', { name: 'tag', label: 'internal', definition: tagDef }).expect(201);
    await d.post('/api/apps/desk/entities', { name: 'ticket', label: 'internal', definition: ticketDef }).expect(201);
    const co = async (name: string, region: string, label?: string) => (await d.post(R('company'), { values: { name, region }, ...(label ? { label } : {}) }).expect(201)).body.id as string;
    const acme = await co('Acme', 'emea');
    const bolt = await co('Bolt', 'amer');
    const crux = await co('Crux', 'emea', 'confidential');
    return { acme, bolt, crux };
  }

  it('links many to many and to the same entity, from both sides, in order, with paging', async () => {
    const dee = await designer();
    const { acme, bolt } = await setup(dee);

    // a relation is not a value: it is written as ids on create and read back as links
    const t1 = (await dee.post(R('ticket'), { values: { title: 'Printer', priority: 2, companies: [acme, bolt] } }).expect(201)).body;
    expect(t1.values.companies).toBeUndefined();
    const row = await h.s.db('app_records').where({ id: t1.id }).first();
    expect(String(row.data)).not.toContain(acme);
    const page = (await dee.get(L('ticket', t1.id, 'companies')).expect(200)).body;
    expect(page).toMatchObject({ name: 'companies', kind: 'relation', side: 'forward', total: 2, editable: true, cardinality: 'many-to-many' });
    expect(page.records.map((r: { title: string }) => r.title)).toEqual(['Acme', 'Bolt']);
    expect((await dee.get(`${L('ticket', t1.id, 'companies')}?limit=1&offset=1`).expect(200)).body).toMatchObject({ total: 2, records: [{ id: bolt }] });

    // reorder: the visible links in the order given
    expect(ids((await dee.put(`${L('ticket', t1.id, 'companies')}/order`, { order: [bolt, acme] }).expect(200)).body)).toEqual([bolt, acme]);
    await dee.put(`${L('ticket', t1.id, 'companies')}/order`, { order: [bolt] }).expect(409);

    // the back-reference on the company lists the ticket, and is editable there (two-way)
    expect(ids((await dee.get(L('company', acme, 'tickets')).expect(200)).body)).toEqual([t1.id]);
    const t2 = (await dee.post(R('ticket'), { values: { title: 'Laptop' } }).expect(201)).body;
    expect((await dee.post(L('company', acme, 'tickets'), { id: t2.id }).expect(201)).body.created).toBe(true);
    expect((await dee.post(L('company', acme, 'tickets'), { id: t2.id }).expect(200)).body.created).toBe(false);
    expect(ids((await dee.get(L('ticket', t2.id, 'companies')).expect(200)).body)).toEqual([acme]);
    await dee.put(`${L('company', acme, 'tickets')}/order`, { order: [t2.id, t1.id] }).expect(409);

    // a symmetric self-relation reads the same from both tickets; a ticket is not related to itself
    await dee.post(L('ticket', t1.id, 'related'), { id: t2.id }).expect(201);
    expect(ids((await dee.get(L('ticket', t2.id, 'related')).expect(200)).body)).toEqual([t1.id]);
    await dee.post(L('ticket', t1.id, 'related'), { id: t1.id }).expect(400);
    await dee.del(`${L('ticket', t2.id, 'related')}/${t1.id}`).expect(204);
    expect((await dee.get(L('ticket', t1.id, 'related')).expect(200)).body.total).toBe(0);

    // one-to-many: a reference's back-reference is read-only
    await dee.patch(`${R('ticket')}/${t2.id}`, { values: { owner: bolt } }).expect(200);
    expect((await dee.get(L('company', bolt, 'owned')).expect(200)).body).toMatchObject({ kind: 'reference', cardinality: 'one-to-many', editable: false, total: 1, records: [{ id: t2.id }] });
    await dee.post(L('company', bolt, 'owned'), { id: t1.id }).expect(409);

    // the entity's relation ends, for the console
    const ends = (await dee.get('/api/apps/desk/entities/company/relations').expect(200)).body.relations as { name: string; side: string; editable: boolean }[];
    expect(ends.map((e) => [e.name, e.side, e.editable])).toEqual([['tickets', 'inverse', true], ['owned', 'inverse', false]]);

    // every change is audited
    expect((await audits('app.record.linked')).length).toBeGreaterThanOrEqual(3);
    expect(await audits('app.record.unlinked')).toHaveLength(1);
    expect(await audits('app.record.links.reordered')).toHaveLength(1);
    const linked = (await audits('app.record.linked')).find((a) => JSON.parse(a.detail!).via === 'record write')!;
    expect(JSON.parse(linked.detail!)).toMatchObject({ field: 'companies', others: [acme, bolt] });

    // the design refuses an inverse name the target already has, and a symmetric relation to another entity
    const bad = { fields: [{ name: 'x', type: 'string' }, { name: 'co', type: 'relation', entity: 'company', inverse: 'name' }] };
    expect((await dee.post('/api/apps/desk/entities', { name: 'bad', definition: bad }).expect(400)).body.detail).toMatch(/already has the field name/);
    await dee.post('/api/apps/desk/entities', { name: 'bad', definition: { fields: [{ name: 'co', type: 'relation', entity: 'company', symmetric: true }] } }).expect(400);
    await dee.post('/api/apps/desk/entities', { name: 'bad', definition: { fields: [{ name: 'co', type: 'relation', entity: 'company', twoWay: true }] } }).expect(400);
    await dee.post('/api/apps/desk/entities', { name: 'bad', definition: { fields: [{ name: 'co', type: 'relation', entity: 'company', indexed: true }] } }).expect(400);
  });

  it('keeps max and required, and versioned updates still detect conflicts', async () => {
    const dee = await designer();
    const { acme, bolt, crux } = await setup(dee);
    const extra = (await dee.post(R('company'), { values: { name: 'Delta', region: 'apac' } }).expect(201)).body.id as string;
    const t = (await dee.post(R('ticket'), { values: { title: 'Router', companies: [acme, bolt, crux] } }).expect(201)).body;
    expect((await dee.post(L('ticket', t.id, 'companies'), { id: extra }).expect(409)).body.detail).toMatch(/most links/);
    expect((await dee.post(R('ticket'), { values: { title: 'Too many', companies: [acme, bolt, crux, extra] } }).expect(400)).body.problems[0]).toMatchObject({ field: 'companies' });

    // required: at least one link, on create and when removing
    await dee.post('/api/apps/desk/entities', { name: 'task', label: 'internal', definition: taskDef }).expect(201);
    expect((await dee.post(R('task'), { values: { name: 'orphan' } }).expect(400)).body.problems).toEqual([{ field: 'parent', message: 'needs at least one link' }]);
    const task = (await dee.post(R('task'), { values: { name: 'call back', parent: [t.id] } }).expect(201)).body;
    expect((await dee.del(`${L('task', task.id, 'parent')}/${t.id}`).expect(409)).body.detail).toMatch(/at least one link/);
    expect(ids((await dee.get(L('ticket', t.id, 'tasks')).expect(200)).body)).toEqual([task.id]);
    // a form cannot take records for an entity that requires links
    await dee.post('/api/apps/desk/forms', { name: 'taskform', entity: 'task', definition: { fields: [{ field: 'name' }] } }).expect(400);

    // a record write replaces the links the writer sees, with the version check of every update
    await dee.patch(`${R('ticket')}/${t.id}`, { values: { companies: [acme] }, version: t.version + 5 }).expect(409);
    expect((await dee.get(L('ticket', t.id, 'companies')).expect(200)).body.total).toBe(3);
    const upd = (await dee.patch(`${R('ticket')}/${t.id}`, { values: { companies: [acme], priority: 1 }, version: t.version }).expect(200)).body;
    expect(upd.version).toBe(t.version + 1);
    expect(ids((await dee.get(L('ticket', t.id, 'companies')).expect(200)).body)).toEqual([acme]);
    // adding a link is not a value change: the record's version stays
    await dee.post(L('ticket', t.id, 'companies'), { id: bolt }).expect(201);
    expect((await dee.get(`${R('ticket')}/${t.id}`).expect(200)).body.version).toBe(upd.version);
    await dee.patch(`${R('ticket')}/${t.id}`, { values: { priority: 3 }, version: upd.version }).expect(200);
    // a lower max is refused while a record holds more links
    const def = (await dee.get('/api/apps/desk/entities/ticket').expect(200)).body;
    const lowered = { ...def.definition, fields: def.definition.fields.map((f: { name: string }) => (f.name === 'companies' ? { ...f, max: 1 } : f)) };
    await dee.patch('/api/apps/desk/entities/ticket', { definition: lowered, rev: def.rev }).expect(409);
  });

  it('never shows or links a record the reader may not read (labels, row policies, group scope)', async () => {
    const dee = await designer();
    const { acme, bolt, crux } = await setup(dee);
    const t = (await dee.post(R('ticket'), { values: { title: 'Desk', companies: [acme, bolt, crux] } }).expect(201)).body;
    const pat = await member('pat', 'internal');
    const mia = await member('mia');

    // a label above the reader's clearance: the link is neither listed, counted, expanded nor matched
    expect((await dee.get(L('ticket', t.id, 'companies')).expect(200)).body.total).toBe(3);
    const seen = (await pat.get(L('ticket', t.id, 'companies')).expect(200)).body;
    expect(seen.total).toBe(2);
    expect(ids(seen)).not.toContain(crux);
    const exp = (await pat.get(`${R('ticket')}?expand=companies`).expect(200)).body.records[0];
    expect(exp.links.companies.total).toBe(2);
    expect(exp.links.companies.records.map((r: { id: string }) => r.id)).not.toContain(crux);
    expect((await pat.get(`${R('ticket')}?filter=${encodeURIComponent(JSON.stringify({ field: 'companies', op: 'eq', value: crux }))}`).expect(200)).body.total).toBe(0);
    expect((await pat.get(`${R('ticket')}?filter=${encodeURIComponent(JSON.stringify({ field: 'companies.count', op: 'eq', value: 2 }))}`).expect(200)).body.total).toBe(1);
    expect((await pat.get(L('company', crux, 'tickets'))).status).toBe(404);
    // and linking it is refused as if it did not exist
    const t2 = (await pat.post(R('ticket'), { values: { title: 'Mine' } }).expect(201)).body;
    await pat.post(L('ticket', t2.id, 'companies'), { id: crux }).expect(404);
    await pat.post(L('ticket', t2.id, 'companies'), { id: '01HZZZZZZZZZZZZZZZZZZZZZZZ' }).expect(404);
    expect((await pat.post(R('ticket'), { values: { title: 'Sneaky', companies: [crux] } }).expect(400)).body.problems[0].field).toBe('companies');
    // a link the reader cannot see is not theirs to remove
    await pat.del(`${L('ticket', t.id, 'companies')}/${crux}`).expect(404);
    // a record write keeps the links the writer cannot see
    await pat.patch(`${R('ticket')}/${t.id}`, { values: { companies: [acme] } }).expect(200);
    expect(ids((await dee.get(L('ticket', t.id, 'companies')).expect(200)).body).sort()).toEqual([acme, crux].sort());

    // a row policy on the companies: members reach the EMEA ones only
    await dee.post('/api/apps/desk/policies', { name: 'EMEA', entity: 'company', subjects: [{ kind: 'role', value: 'member' }], rows: { field: 'region', op: 'eq', value: 'emea' } }).expect(201);
    await dee.post(L('ticket', t.id, 'companies'), { id: bolt }).expect(201);
    expect(ids((await mia.get(L('ticket', t.id, 'companies')).expect(200)).body).sort()).toEqual([acme, crux].sort());
    await mia.post(L('ticket', t2.id, 'companies'), { id: bolt }).expect(404);
    const cand = (await mia.get(`${L('ticket', t2.id, 'companies')}/candidates?q=c`).expect(200)).body.candidates as { id: string; title: string }[];
    expect(cand.map((c) => c.id)).not.toContain(bolt);
    expect(cand.map((c) => c.title)).toContain('Acme');
    // a matches filter reads the other entity through its own grant
    const matches = (f: object) => `${R('ticket')}?filter=${encodeURIComponent(JSON.stringify(f))}`;
    expect((await mia.get(matches({ field: 'companies', op: 'matches', where: { field: 'region', op: 'eq', value: 'amer' } })).expect(200)).body.total).toBe(0);
    expect((await dee.get(matches({ field: 'companies', op: 'matches', where: { field: 'region', op: 'eq', value: 'amer' } })).expect(200)).body.total).toBe(1);
    // a field policy hides the relation itself
    await dee.post('/api/apps/desk/policies', { name: 'No companies', entity: 'ticket', subjects: [{ kind: 'role', value: 'member' }], fields: { companies: { read: false, unmasked: false, create: false, update: false, mask: 'hidden' } } }).expect(201);
    await mia.get(L('ticket', t.id, 'companies')).expect(403);
    await mia.get(matches({ field: 'companies.count', op: 'gte', value: 1 })).expect(403);
    expect((await mia.get(`${R('ticket')}/${t.id}?expand=companies`).expect(200)).body.links).toEqual({});
    await mia.post(L('ticket', t2.id, 'companies'), { id: acme }).expect(403);

    // group scope: an entity scoped to a group links only for its members
    const g = (await dee.post('/api/groups', { workspaceId: wsId, name: 'Vendors team', joinMode: 'open', visibility: 'public' }).expect(201)).body;
    await dee.post('/api/apps/desk/entities', { name: 'vendor', label: 'internal', definition: { fields: [{ name: 'name', type: 'string', indexed: true, maxLength: 60 }] } }).expect(201);
    const v = (await dee.post(R('vendor'), { values: { name: 'Vee' } }).expect(201)).body.id as string;
    await dee.put('/api/apps/desk/entities/vendor/group', { groupId: g.id }).expect(200);
    const def = (await dee.get('/api/apps/desk/entities/ticket').expect(200)).body;
    await dee.patch('/api/apps/desk/entities/ticket', { definition: { ...def.definition, fields: [...def.definition.fields, { name: 'vendors', type: 'relation', entity: 'vendor', inverse: 'tickets' }] }, rev: def.rev }).expect(200);
    await dee.post(L('ticket', t2.id, 'vendors'), { id: v }).expect(201);
    expect((await pat.get(L('ticket', t2.id, 'vendors')).expect(200)).body.total).toBe(0);
    await pat.post(`/api/groups/${g.id}/join`).expect(200);
    expect((await pat.get(L('ticket', t2.id, 'vendors')).expect(200)).body.total).toBe(1);
  });

  it('unlinks or blocks on delete, and clears links when a relation field or its entity goes', async () => {
    const dee = await designer();
    const { acme, bolt } = await setup(dee);
    const tag = (await dee.post(R('tag'), { values: { name: 'urgent' } }).expect(201)).body.id as string;
    const t = (await dee.post(R('ticket'), { values: { title: 'Fax', companies: [acme, bolt], tags: [tag] } }).expect(201)).body;
    const t2 = (await dee.post(R('ticket'), { values: { title: 'Scanner', related: [t.id] } }).expect(201)).body;

    // unlink (the default): the company goes, its links with it, audited
    await dee.del(`${R('company')}/${acme}`).expect(204);
    expect(ids((await dee.get(L('ticket', t.id, 'companies')).expect(200)).body)).toEqual([bolt]);
    const gone = (await audits('app.record.unlinked')).map((a) => JSON.parse(a.detail!)).find((d) => d.reason === 'deleted')!;
    expect(gone).toMatchObject({ records: [acme], relations: [{ relation: 'ticket.companies', links: 1 }] });

    // block: a tag in use cannot be deleted, nor a ticket holding one; unlinked, it can
    expect((await dee.del(`${R('tag')}/${tag}`).expect(409)).body.detail).toMatch(/blocks deletes/);
    await dee.post(`${R('ticket')}/bulk`, { delete: [t.id] }).expect(409);
    await dee.del(`${L('ticket', t.id, 'tags')}/${tag}`).expect(204);
    await dee.del(`${R('tag')}/${tag}`).expect(204);

    // a symmetric link goes from both sides when either record does
    await dee.post(`${R('ticket')}/bulk`, { delete: [t2.id] }).expect(200);
    expect((await dee.get(L('ticket', t.id, 'related')).expect(200)).body.total).toBe(0);

    // an entity a relation targets cannot go while it does; removing the field clears its links with a schema version
    await dee.del('/api/apps/desk/entities/tag').expect(409);
    expect(Number(((await h.s.db('app_record_links').count({ n: '*' })) as { n: number }[])[0]!.n)).toBe(1);
    await dee.del('/api/apps/desk/schema/entities/ticket/fields/companies').expect(200);
    expect(await h.s.db('app_record_links')).toEqual([]);
    const cleared = (await audits('app.relation.cleared')).map((a) => JSON.parse(a.detail!));
    expect(cleared).toEqual([{ field: 'companies', links: 1, why: 'field removed' }]);
    const versions = (await dee.get('/api/apps/desk/schema/versions').expect(200)).body.versions as { kind: string; summary: string }[];
    expect(versions[0]).toMatchObject({ kind: 'field.removed', summary: 'Field companies removed from ticket' });

    // an entity's own relations' links go with it
    await dee.post('/api/apps/desk/entities', { name: 'note', label: 'internal', definition: { fields: [{ name: 'text', type: 'string' }, { name: 'about', type: 'relation', entity: 'ticket' }] } }).expect(201);
    await dee.post(R('note'), { values: { text: 'hello', about: [t.id] } }).expect(201);
    await dee.del('/api/apps/desk/entities/note').expect(204);
    expect(await h.s.db('app_record_links')).toEqual([]);
    expect((await audits('app.relation.cleared')).map((a) => JSON.parse(a.detail!).why)).toContain('entity deleted');
  });

  it('filters, sorts and aggregates by links, in saved views too', async () => {
    const dee = await designer();
    const { acme, bolt, crux } = await setup(dee);
    const a = (await dee.post(R('ticket'), { values: { title: 'A', companies: [acme] } }).expect(201)).body.id as string;
    const b = (await dee.post(R('ticket'), { values: { title: 'B', companies: [acme, bolt, crux] } }).expect(201)).body.id as string;
    const c = (await dee.post(R('ticket'), { values: { title: 'C', companies: [bolt, crux] } }).expect(201)).body.id as string;
    const d = (await dee.post(R('ticket'), { values: { title: 'D' } }).expect(201)).body.id as string;
    const q = async (body: object) => ids((await dee.post(`${R('ticket')}/query`, body).expect(200)).body);

    expect(await q({ filter: { field: 'companies', op: 'eq', value: acme }, sort: [{ field: 'title' }] })).toEqual([a, b]);
    expect(await q({ filter: { field: 'companies', op: 'in', value: [crux] }, sort: [{ field: 'title' }] })).toEqual([b, c]);
    expect(await q({ filter: { field: 'companies', op: 'ne', value: acme }, sort: [{ field: 'title' }] })).toEqual([c, d]);
    expect(await q({ filter: { field: 'companies', op: 'exists', value: false } })).toEqual([d]);
    expect(await q({ filter: { field: 'companies', op: 'matches', where: { field: 'region', op: 'eq', value: 'amer' } }, sort: [{ field: 'title' }] })).toEqual([b, c]);
    expect(await q({ filter: { field: 'companies.count', op: 'gte', value: 2 }, sort: [{ field: 'title' }] })).toEqual([b, c]);
    // from the other side: companies by their tickets
    expect(ids((await dee.post(`${R('company')}/query`, { filter: { field: 'tickets.count', op: 'eq', value: 3 } }).expect(200)).body)).toEqual([]);
    expect(ids((await dee.post(`${R('company')}/query`, { filter: { and: [{ field: 'tickets', op: 'eq', value: b }, { field: 'tickets.count', op: 'eq', value: 2 }] }, sort: [{ field: 'tickets.count', dir: 'desc' }, { field: 'name', dir: 'desc' }] }).expect(200)).body)).toEqual([crux, bolt, acme]);
    expect(ids((await dee.post(`${R('company')}/query`, { filter: { field: 'tickets', op: 'eq', value: a } }).expect(200)).body)).toEqual([acme]);

    // sort by the number of links, paged with a cursor
    const first = (await dee.post(`${R('ticket')}/query`, { sort: [{ field: 'companies.count', dir: 'desc' }], limit: 2 }).expect(200)).body;
    expect(ids(first)).toEqual([b, c]);
    const next = (await dee.post(`${R('ticket')}/query`, { sort: [{ field: 'companies.count', dir: 'desc' }], limit: 2, cursor: first.nextCursor }).expect(200)).body;
    expect(ids(next)).toEqual([a, d]);
    expect((await dee.get(`${R('ticket')}?sort=companies.count:asc&limit=1`).expect(200)).body.records[0].id).toBe(d);
    await dee.post(`${R('ticket')}/query`, { sort: [{ field: 'companies' }] }).expect(400);
    // one level: no relation inside a where; and the size limits count the where too
    await dee.post(`${R('ticket')}/query`, { filter: { field: 'companies', op: 'matches', where: { field: 'tickets', op: 'exists' } } }).expect(400);
    await dee.post(`${R('ticket')}/query`, { filter: { field: 'title', op: 'matches', where: { field: 'name', op: 'exists' } } }).expect(400);
    // a reference's back-reference is not filtered through links
    await dee.post(`${R('company')}/query`, { filter: { field: 'owned', op: 'exists' } }).expect(400);

    // aggregates: count with a link filter, and metrics over the number of links
    const agg = (await dee.post(`${R('ticket')}/aggregate`, { filter: { field: 'companies', op: 'exists' }, metrics: [{ op: 'count' }, { op: 'sum', field: 'companies.count' }, { op: 'max', field: 'companies.count' }] }).expect(200)).body;
    expect(agg.groups[0].values).toEqual([3, 6, 3]);

    // saved views keep these filters and sorts
    const view = (await dee.post('/api/apps/desk/entities/ticket/views', { name: 'Busy', settings: { filters: [{ field: 'companies', op: 'matches', where: { field: 'region', op: 'eq', value: 'emea' } }, { field: 'companies.count', op: 'gte', value: 2 }], sort: [{ field: 'companies.count', dir: 'desc' }] } }).expect(201)).body;
    expect(view.settings.filters[0].where).toEqual({ field: 'region', op: 'eq', value: 'emea' });
    expect((await dee.post('/api/apps/desk/entities/ticket/views', { name: 'Bad', settings: { sort: [{ field: 'companies' }] } }).expect(400)).body.detail).toMatch(/companies.count/);
  });

  it('expands relations on the entity API, and documents them in OpenAPI and the client', async () => {
    const dee = await designer();
    const { acme, bolt } = await setup(dee);
    const t = (await dee.post('/api/apps/desk/ticket', { values: { title: 'API', companies: [acme, bolt] } }).expect(201)).body;
    const list = (await dee.get('/api/apps/desk/ticket?expand=companies,related&expandLimit=1').expect(200)).body.records[0];
    expect(list.links.companies.total).toBe(2);
    expect(list.links.companies.records).toHaveLength(1);
    expect(list.links.companies.records[0]).toMatchObject({ id: acme, title: 'Acme', entity: 'company' });
    expect(list.links.related).toEqual({ total: 0, records: [] });
    await dee.get('/api/apps/desk/ticket?expand=nope').expect(400);
    expect((await dee.get(`/api/apps/desk/ticket/${t.id}?expand=companies`).expect(200)).body.links.companies.total).toBe(2);
    expect((await dee.get('/api/apps/desk/ticket?where=companies.count:gte:2').expect(200)).body.total).toBe(1);
    // the links paths of the entity API
    expect((await dee.get(`/api/apps/desk/ticket/${t.id}/links/companies`).expect(200)).body.total).toBe(2);
    const t2 = (await dee.post('/api/apps/desk/ticket', { values: { title: 'Two' } }).expect(201)).body;
    await dee.post(`/api/apps/desk/ticket/${t2.id}/links/related`, { id: t.id }).expect(201);
    await dee.put(`/api/apps/desk/ticket/${t.id}/links/companies/order`, { order: [bolt, acme] }).expect(200);
    await dee.del(`/api/apps/desk/ticket/${t2.id}/links/related/${t.id}`).expect(204);

    // a credential limited to one entity reaches no other entity through a relation
    const key = (await dee.post('/api/me/api-keys', { name: 'tickets only', scopes: ['records:read'], ttlDays: 30, app: { app: 'desk', entity: 'ticket' } }).expect(201)).body.key as string;
    const asKey = (p: string) => request(h.app).get(p).set('authorization', `Bearer ${key}`);
    await asKey('/api/apps/desk/ticket').expect(200);
    await asKey(`/api/apps/desk/ticket/${t.id}/links/companies`).expect(403);
    await asKey('/api/apps/desk/ticket?expand=companies').expect(403);
    await asKey('/api/apps/desk/ticket?where=companies.count:gte:1').expect(403);
    await asKey(`/api/apps/desk/ticket/${t2.id}/links/related`).expect(200);

    const doc = (await dee.get('/api/apps/desk/openapi.json').expect(200)).body;
    expect(doc.paths['/api/apps/desk/ticket/{id}/links/{relation}'].get.operationId).toBe('links_ticket');
    expect(doc.paths['/api/apps/desk/ticket/{id}/links/{relation}/{target}'].delete).toBeTruthy();
    expect(doc.paths['/api/apps/desk/company/{id}/links/{relation}'].parameters[1].schema.enum).toEqual(['tickets', 'owned']);
    expect(doc.components.schemas.TicketInput.properties.companies).toMatchObject({ type: 'array', maxItems: 3 });
    expect(doc.components.schemas.TicketValues.properties.companies).toBeUndefined();
    expect(doc.components.schemas.CompanyInput.properties.tickets).toMatchObject({ type: 'array' });
    expect(doc.paths['/api/apps/desk/ticket'].get.parameters.map((p: { name: string }) => p.name)).toContain('expand');
    const client = (await dee.get('/api/apps/desk/client.ts').expect(200)).text;
    expect(client).toContain('companies?: string[];');
    expect(client).toContain("'/links/' + encodeURIComponent(relation)");
    expect(client).toContain('expandLimit');
  });

  it('carries relation fields and links in packages and their git layout', async () => {
    const dee = await designer();
    const { acme, bolt } = await setup(dee);
    const t1 = (await dee.post(R('ticket'), { values: { title: 'One', companies: [bolt, acme] } }).expect(201)).body.id as string;
    await dee.post(R('ticket'), { values: { title: 'Two', related: [t1], companies: [acme] } }).expect(201);
    const made = (await dee.post('/api/apps/desk/packages', { withData: true }).expect(201)).body;
    const pkg = made.package;
    expect(pkg.entities.find((e: { name: string }) => e.name === 'ticket').definition.fields.find((f: { name: string }) => f.name === 'companies')).toMatchObject({ type: 'relation', inverse: 'tickets', twoWay: true });
    expect(pkg.links.filter((l: { relation: string }) => l.relation === 'ticket.companies')).toHaveLength(3);
    expect(pkg.links.filter((l: { relation: string }) => l.relation === 'ticket.related')).toHaveLength(2);
    // the files for git read back into the same signed package
    const files = AppPackages.files(pkg);
    expect([...files.keys()]).toEqual(expect.arrayContaining(['links/ticket.companies.json', 'links/ticket.related.json']));
    const back = AppPackages.fromFiles(files);
    expect(AppPackages.hashOf(back as never)).toBe(AppPackages.hashOf(pkg));

    const imported = (await dee.post('/api/apps/packages/import', { package: back, name: 'desk2', workspaceId: wsId }).expect(201)).body;
    expect(imported.report.links).toEqual({ created: 5, skipped: 0 });
    const tickets = (await dee.post('/api/apps/desk2/entities/ticket/records/query', { sort: [{ field: 'title' }], expand: 'companies,related' }).expect(200)).body.records;
    expect(tickets[0].links.companies.records.map((r: { title: string }) => r.title)).toEqual(['Bolt', 'Acme']);
    expect(tickets[1].links.related.records[0].id).toBe(tickets[0].id);
    expect(tickets[0].id).not.toBe(t1);
  });
});
