import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fromColumn, toColumn } from '../src/apps/sources.js';
import { entityDefinitionSchema } from '../src/apps/schema.js';
import type { Harness } from './helpers.js';
import { drain, harnessWith } from './retrieval-seed.js';
import { clients, SqliteTableDriver } from './sprint39c-helpers.js';

/*
 * 1.6.0, Sprint 39c, B-8501: a table in an outside database attached as an app entity: a scheduled pull brings its
 * rows in (and a changed row appears after the next pull), and with writes on an app edit reaches the table at once.
 * The outside PostgreSQL is a SQLite stand-in (the real drivers run in the integration test).
 */

describe('value mapping', () => {
  it('turns columns into field values and back', () => {
    const def = entityDefinitionSchema.parse({ fields: [{ name: 'n', type: 'number' }, { name: 'b', type: 'boolean' }, { name: 'd', type: 'date' }, { name: 'dt', type: 'date', withTime: true }, { name: 'j', type: 'json' }, { name: 's', type: 'string' }] });
    const f = (name: string) => def.fields.find((x) => x.name === name)!;
    expect(fromColumn(f('n'), '12.5')).toBe(12.5);
    expect(fromColumn(f('n'), 'x')).toBeNull();
    expect(fromColumn(f('b'), 1)).toBe(true);
    expect(fromColumn(f('b'), 'f')).toBe(false);
    expect(fromColumn(f('d'), new Date('2026-03-04T10:00:00Z'))).toBe('2026-03-04');
    expect(fromColumn(f('dt'), '2026-03-04T10:00:00Z')).toBe('2026-03-04T10:00:00.000Z');
    expect(fromColumn(f('j'), '{"a":1}')).toEqual({ a: 1 });
    expect(fromColumn(f('s'), 42)).toBe('42');
    expect(toColumn(f('j'), { a: 1 })).toBe('{"a":1}');
    expect(toColumn(f('d'), '2026-03-04T10:00:00.000Z')).toBe('2026-03-04');
    expect(toColumn(f('s'), null)).toBeNull();
  });
});

describe('outside tables as entities (B-8501)', () => {
  let h: Harness;
  let wsId: string;
  let outside: Database.Database;
  let drivers: SqliteTableDriver[];

  beforeEach(async () => {
    outside = new Database(':memory:');
    outside.exec(`
      create table customers (id integer primary key, name text not null, email text, tier text, active integer default 1, balance real, updated_at text);
      create table orders (ref text primary key, total real, status text);
    `);
    const ins = outside.prepare('insert into customers (name, email, tier, active, balance, updated_at) values (?, ?, ?, ?, ?, ?)');
    ins.run('Contoso', 'ap@contoso.example', 'gold', 1, 120.5, '2026-09-01T00:00:00Z');
    ins.run('Fabrikam', 'ops@fabrikam.example', 'silver', 0, 0, '2026-09-02T00:00:00Z');
    drivers = [];
    h = await harnessWith({ drivers: { postgres: (spec) => { const d = new SqliteTableDriver(outside, spec); drivers.push(d); return d; } } }, { OLLAMA_POLL_MS: '600000' });
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Sales', 'confidential')).id;
  });
  afterEach(async () => {
    await h.close();
    outside.close();
  });

  async function connection(c: { post: (p: string, b?: object) => ReturnType<ReturnType<typeof clients>['designer']> extends Promise<infer T> ? T extends { post: infer P } ? P extends (...a: never[]) => infer R ? R : never : never : never; put: (p: string, b?: object) => unknown }) {
    const conn = (await (c.post('/api/admin/connections', { name: 'crm', engine: 'postgres', endpoint: 'crm.internal:5432', database: 'crm', label: 'internal', username: 'app', password: 'right' }) as unknown as Promise<{ body: { id: string } }>)).body;
    await (c.post(`/api/admin/connections/${conn.id}/schema`) as unknown as Promise<unknown>);
    await (c.put(`/api/admin/connections/${conn.id}/allow-list`, { objects: ['public.customers', 'public.orders'] }) as unknown as Promise<unknown>);
    return conn;
  }

  const customerEntity = {
    name: 'customer',
    definition: {
      fields: [
        { name: 'crm_id', type: 'number', indexed: true, unique: true },
        { name: 'name', type: 'string', required: true, indexed: true, maxLength: 200 },
        { name: 'email', type: 'string', indexed: true, maxLength: 200 },
        { name: 'tier', type: 'enum', options: [{ value: 'gold' }, { value: 'silver' }], indexed: true },
        { name: 'active', type: 'boolean', indexed: true },
        { name: 'balance', type: 'number' },
        { name: 'balance_x2', type: 'formula', expression: 'balance * 2' }
      ]
    }
  };

  it('pulls rows as records, shows a changed row after the next pull, removes gone rows, and writes through at once', async () => {
    const c = clients(h, wsId);
    const d = await c.designer('dee', ['workflow-admin', 'connection-admin', 'member']);
    const conn = await connection(d as never);
    await d.post('/api/apps', { name: 'crm', label: 'internal', workspaceId: wsId }).expect(201);
    await d.post('/api/apps/crm/entities', customerEntity).expect(201);
    const src = (await d.put('/api/apps/crm/entities/customer/source', { connectionId: conn.id, object: 'public.customers', keyColumn: 'id', keyField: 'crm_id', columns: { crm_id: 'id' }, writes: true, pullMinutes: 5 }).expect(200)).body;
    expect(src).toMatchObject({ entity: 'customer', connection: 'crm', engine: 'postgres', object: 'public.customers', keyColumn: 'id', keyField: 'crm_id', writes: true, pullMinutes: 5, lastPull: null });
    expect(src.nextPullAt).toBeGreaterThan(Date.now());
    expect((await d.get('/api/apps/crm').expect(200)).body.sources).toHaveLength(1);

    // the first pull: two records, typed values, the formula computed, the key kept
    await d.post('/api/apps/crm/entities/customer/source/pull').expect(202);
    await drain(h);
    const pulled = (await d.get('/api/apps/crm/entities/customer/source').expect(200)).body;
    expect(pulled.lastPull).toMatchObject({ rows: 2, created: 2, updated: 0, deleted: 0, unchanged: 0, failed: 0 });
    const q = async () => (await d.post('/api/apps/crm/entities/customer/records/query', { sort: [{ field: 'name', dir: 'asc' }] }).expect(200)).body.records as { id: string; externalKey: string; source: string; values: Record<string, unknown> }[];
    let recs = await q();
    expect(recs.map((r) => [r.externalKey, r.source, r.values.name, r.values.tier, r.values.active, r.values.balance_x2])).toEqual([
      ['1', 'import', 'Contoso', 'gold', true, 241],
      ['2', 'import', 'Fabrikam', 'silver', false, 0]
    ]);
    expect(recs[0]!.values.crm_id).toBe(1);

    // a second pull with nothing changed writes nothing; a changed outside row appears after the next pull
    await d.post('/api/apps/crm/entities/customer/source/pull').expect(202);
    await drain(h);
    expect((await d.get('/api/apps/crm/entities/customer/source').expect(200)).body.lastPull).toMatchObject({ rows: 2, created: 0, updated: 0, unchanged: 2 });
    outside.prepare("update customers set tier = 'gold', balance = 9 where id = 2").run();
    outside.prepare('delete from customers where id = 1').run();
    await d.post('/api/apps/crm/entities/customer/source/pull').expect(202);
    await drain(h);
    expect((await d.get('/api/apps/crm/entities/customer/source').expect(200)).body.lastPull).toMatchObject({ rows: 1, updated: 1, deleted: 1, unchanged: 0 });
    recs = await q();
    expect(recs).toHaveLength(1);
    expect(recs[0]!.values).toMatchObject({ name: 'Fabrikam', tier: 'gold', balance: 9, balance_x2: 18 });
    const fabrikam = recs[0]!;

    // an app edit reaches the table at once; so do a new record and a delete
    const m = await c.member('mia');
    await m.patch(`/api/apps/crm/entities/customer/records/${fabrikam.id}`, { values: { balance: 10, active: true } }).expect(200);
    expect(outside.prepare('select balance, active from customers where id = 2').get()).toEqual({ balance: 10, active: 1 });
    await m.patch(`/api/apps/crm/entities/customer/records/${fabrikam.id}`, { values: { crm_id: 7 } }).expect(409); // the key cannot change
    const created = (await m.post('/api/apps/crm/entities/customer/records', { values: { crm_id: 3, name: 'Northwind', tier: 'silver', balance: 1 } }).expect(201)).body;
    expect(created.externalKey).toBe('3');
    expect(outside.prepare('select name, tier, balance from customers where id = 3').get()).toEqual({ name: 'Northwind', tier: 'silver', balance: 1 });
    // a pull now keeps the record it wrote (same key); the table's default for `active` comes back as an update
    await d.post('/api/apps/crm/entities/customer/source/pull').expect(202);
    await drain(h);
    expect((await d.get('/api/apps/crm/entities/customer/source').expect(200)).body.lastPull).toMatchObject({ rows: 2, created: 0, deleted: 0, updated: 1, unchanged: 1 });
    expect((await m.get(`/api/apps/crm/entities/customer/records/${created.id}`).expect(200)).body.values.active).toBe(true);
    await m.del(`/api/apps/crm/entities/customer/records/${created.id}`).expect(204);
    expect(outside.prepare('select count(*) n from customers').get()).toEqual({ n: 1 });
    const kinds = drivers.flatMap((x) => x.mutations.map((o) => o.kind));
    expect(kinds).toEqual(['update', 'insert', 'delete']);
    // a bulk write goes through too, outside rows first
    const bulk = (await m.post('/api/apps/crm/entities/customer/records/bulk', { create: [{ values: { crm_id: 4, name: 'Adatum' } }], update: [{ id: fabrikam.id, values: { balance: 11 } }] }).expect(200)).body;
    expect(bulk.created).toHaveLength(1);
    expect(outside.prepare('select count(*) n from customers').get()).toEqual({ n: 2 });
    expect(outside.prepare('select balance from customers where id = 2').get()).toEqual({ balance: 11 });

    const audits = await h.s.db('audit_events').where({ tenant_id: h.tenantId }).whereIn('action', ['app.entity.source.set', 'app.entity.source.pulled']).select('action');
    expect(audits.filter((a: { action: string }) => a.action === 'app.entity.source.set')).toHaveLength(1);
    expect(audits.filter((a: { action: string }) => a.action === 'app.entity.source.pulled')).toHaveLength(4);
  });

  it('refuses writes when they are off, needs connections:manage to attach, and the schedule tick queues due pulls', async () => {
    const c = clients(h, wsId);
    const d = await c.designer('dee', ['workflow-admin', 'connection-admin', 'member']);
    const plain = await c.designer('dan');
    const conn = await connection(d as never);
    await d.post('/api/apps', { name: 'crm', label: 'internal', workspaceId: wsId }).expect(201);
    await d.post('/api/apps/crm/entities', { name: 'order', definition: { fields: [{ name: 'ref', type: 'string', required: true, unique: true, indexed: true, maxLength: 60 }, { name: 'total', type: 'number' }], states: { initial: 'new', states: [{ name: 'new' }, { name: 'paid' }], transitions: [{ from: ['new'], to: 'paid' }] } } }).expect(201);
    await plain.put('/api/apps/crm/entities/order/source', { connectionId: conn.id, object: 'public.orders', keyColumn: 'ref', keyField: 'ref' }).expect(403);
    await d.put('/api/apps/crm/entities/order/source', { connectionId: conn.id, object: 'public.nope', keyColumn: 'ref' }).expect(409);
    await d.put('/api/apps/crm/entities/order/source', { connectionId: conn.id, object: 'public.orders', keyColumn: 'ref', keyField: 'total' }).expect(200); // a number key field is fine
    await d.put('/api/apps/crm/entities/order/source', { connectionId: conn.id, object: 'public.orders', keyColumn: 'ref', keyField: 'ref', stateColumn: 'status', writes: false, pullMinutes: 1 }).expect(200);
    outside.prepare("insert into orders (ref, total, status) values ('A-1', 10, 'new'), ('A-2', 20, 'paid')").run();
    // due at once when next_pull_at is in the past
    await h.s.db('app_entity_sources').update({ next_pull_at: Date.now() - 1 });
    expect(await h.s.apps.sources.tick()).toEqual({ queued: 1 });
    await drain(h);
    const recs = (await d.post('/api/apps/crm/entities/order/records/query', { sort: [{ field: 'ref', dir: 'asc' }] }).expect(200)).body.records;
    expect(recs.map((r: { state: string; values: { ref: string } }) => [r.values.ref, r.state])).toEqual([
      ['A-1', 'new'],
      ['A-2', 'paid']
    ]);
    expect(await h.s.apps.sources.tick()).toEqual({ queued: 0 }); // not due again yet
    const m = await c.member('mia');
    const refused = (await m.post('/api/apps/crm/entities/order/records', { values: { ref: 'A-3' } }).expect(409)).body;
    expect(refused.detail).toMatch(/writes through to it are off/);
    await m.patch(`/api/apps/crm/entities/order/records/${recs[0].id}`, { values: { total: 1 } }).expect(409);
    await m.del(`/api/apps/crm/entities/order/records/${recs[0].id}`).expect(409);
    // writes on: a transition reaches the state column; a key not given is the record id
    await d.put('/api/apps/crm/entities/order/source', { connectionId: conn.id, object: 'public.orders', keyColumn: 'ref', stateColumn: 'status', writes: true }).expect(200);
    await m.post(`/api/apps/crm/entities/order/records/${recs[0].id}/transition`, { to: 'paid' }).expect(200);
    expect(outside.prepare("select status from orders where ref = 'A-1'").get()).toEqual({ status: 'paid' });
    const byId = (await m.post('/api/apps/crm/entities/order/records', { values: { ref: 'B-9', total: 5 } }).expect(201)).body;
    expect(outside.prepare(`select total, status from orders where ref = ?`).get(byId.id)).toEqual({ total: 5, status: 'new' });
    await d.del('/api/apps/crm/entities/order/source').expect(204);
    await d.get('/api/apps/crm/entities/order/source').expect(404);
    await m.post('/api/apps/crm/entities/order/records', { values: { ref: 'C-1' } }).expect(201); // a plain entity again
  });
});
