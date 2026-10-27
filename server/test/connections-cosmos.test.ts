/*
 * 1.9.99-final, Sprint 59 (B-10304): Azure Cosmos DB for NoSQL as a read-only data connection. The classifier (one
 * SELECT, no user-defined functions, the container from the schema tree, FROM or JSON), and the driver against the
 * fake data plane (`fake-azure-cosmos.ts`): master-key signatures and Entra tokens checked, capped pages, masking, the
 * key from the vault. Every request is recorded, so a refused query is shown never to reach it; real Azure hosts are
 * refused by the offline guard.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { classifyCosmos, CosmosDriver, masterKeyAuth } from '../src/connections/cosmos.js';
import type { ConnectionSpec } from '../src/connections/drivers.js';
import { parseAllowList } from '../src/mcp/hosts.js';
import { FakeAzure } from './fake-azure.js';
import { localUser, loginAdmin, type Harness } from './helpers.js';
import { harnessWith } from './retrieval-seed.js';

describe('Cosmos DB classification', () => {
  it('reads one SELECT on a container', () => {
    expect(classifyCosmos('SELECT TOP 10 * FROM c WHERE c.status = "open"', 'orders')).toMatchObject({ kind: 'read', verb: 'SELECT', objects: ['orders'], op: { container: 'orders' } });
    expect(classifyCosmos('SELECT * FROM orders o', null)).toMatchObject({ kind: 'read', objects: ['orders'] });
    expect(classifyCosmos('{"container": "orders", "query": "SELECT * FROM c WHERE c.id = @id", "parameters": [{"name": "@id", "value": "o-1"}]}', null)).toMatchObject({ kind: 'read', objects: ['orders'], op: { parameters: [{ name: '@id', value: 'o-1' }] } });
    expect(classifyCosmos("SELECT VALUE COUNT(1) FROM c WHERE c.note = 'DELETE me; please'", 'orders')).toMatchObject({ kind: 'read' });
  });

  it('refuses anything else', () => {
    expect(classifyCosmos('DELETE FROM c', 'orders').kind).toBe('write');
    expect(classifyCosmos('UPSERT c', 'orders').kind).toBe('write');
    expect(classifyCosmos('DROP CONTAINER orders', 'orders').kind).toBe('ddl');
    expect(classifyCosmos('SELECT udf.tax(c.total) FROM c', 'orders')).toMatchObject({ kind: 'denied', denied: 'udf' });
    expect(classifyCosmos('SELECT * FROM c; SELECT * FROM c', 'orders').kind).toBe('multiple');
    expect(classifyCosmos('EXEC sp', 'orders').kind).toBe('unparsed');
    expect(classifyCosmos('{"container": "orders", "query": "SELECT * FROM c", "partitionKey": "x"}', null)).toMatchObject({ kind: 'unparsed', reason: /partitionKey/ });
    expect(classifyCosmos('{"query": "SELECT 1", "parameters": [{"name": "id"}]}', 'c')).toMatchObject({ kind: 'unparsed' });
  });

  it('signs with the master key as Cosmos DB does', () => {
    const key = Buffer.from('k'.repeat(32)).toString('base64');
    const a = decodeURIComponent(masterKeyAuth({ verb: 'GET', resourceType: 'dbs', resourceLink: 'dbs/shop', date: 'Tue, 20 Oct 2026 10:00:00 GMT', key }));
    expect(a).toMatch(/^type=master&ver=1\.0&sig=[A-Za-z0-9+/]+=*$/);
  });
});

describe('CosmosDriver against the fake', () => {
  let az: FakeAzure;
  const tenant = '11111111-2222-3333-4444-555555555555';
  let app: { clientId: string; secret?: string };
  beforeAll(async () => {
    az = await new FakeAzure().start();
    app = az.addApp({ tenantId: tenant, secret: true });
    az.cosmos.addContainer('shop', 'orders', { partitionKey: 'customer', docs: Array.from({ length: 5 }, (_, i) => ({ id: `o-${i}`, customer: 'c-1', status: i % 2 ? 'open' : 'closed', email: `b${i}@example.org` })) });
  });
  afterAll(async () => az.stop());

  const spec = (o: Partial<ConnectionSpec> = {}): ConnectionSpec => ({ engine: 'cosmos-nosql', endpoint: az.url, database: 'shop', tls: true, username: null, password: az.cosmos.readKey, options: { auth: 'key' }, ...o });

  it('tests, introspects the containers and their sampled fields, and caps queries', async () => {
    const d = new CosmosDriver(spec(), parseAllowList(''));
    expect(await d.test(5000)).toMatchObject({ version: 'Azure Cosmos DB for NoSQL', readOnly: true });
    const objects = await d.introspect(5000);
    expect(objects).toEqual([{ name: 'orders', kind: 'collection', columns: [{ name: 'customer', type: 'partition key' }, { name: 'id', type: 'string' }, { name: 'status', type: 'string' }, { name: 'email', type: 'string' }, { name: '_ts', type: 'number' }] }]);
    const r = await d.query(classifyCosmos('SELECT * FROM c', 'orders'), '', { limit: 3, timeoutMs: 5000 });
    expect(r.columns).toEqual(['id', 'customer', 'status', 'email', '_ts']);
    expect(r.rows).toHaveLength(3);
    expect(r.capped).toBe(true);
    const p = await d.query(classifyCosmos('{"container": "orders", "query": "SELECT * FROM c WHERE c.status = @s", "parameters": [{"name": "@s", "value": "open"}]}', null), '', { limit: 10, timeoutMs: 5000 });
    expect(p.rows.map((x) => x[0])).toEqual(['o-1', 'o-3']);
    expect(p.capped).toBe(false);
    const n = await d.query(classifyCosmos('SELECT VALUE COUNT(1) FROM c', 'orders'), '', { limit: 10, timeoutMs: 5000 });
    expect(n).toMatchObject({ columns: ['value'], rows: [[5]] });
    expect(az.cosmos.auths.every((x) => x === 'master-read')).toBe(true);
    expect(az.cosmos.writes).toEqual([]);
  });

  it('signs in as a service principal through Entra, or with a bearer from a cloud account', async () => {
    const d = new CosmosDriver(spec({ username: app.clientId, password: app.secret!, options: { auth: 'entra-service-principal', entraTenantId: tenant } }), parseAllowList(''), { authority: az.url });
    await d.test(5000);
    expect(az.cosmos.auths.at(-1)).toBe('aad');
    expect(az.calls('entra:token').at(-1)!.body).toContain(encodeURIComponent('https://cosmos.azure.com/.default'));
    await expect(new CosmosDriver(spec({ password: 'bm90IHRoZSBrZXk=' }), parseAllowList('')).test(5000)).rejects.toThrow(/401/);
    await expect(new CosmosDriver(spec({ bearer: 'not-a-token' }), parseAllowList('')).test(5000)).rejects.toThrow(/401/);
  });

  it('refuses what was not classified, and keeps to the guard', async () => {
    const d = new CosmosDriver(spec(), parseAllowList(''));
    await expect(d.query({ kind: 'read', verb: 'DELETE', objects: ['orders'], op: { container: 'orders', query: 'DELETE FROM c' } }, '', { limit: 5, timeoutMs: 5000 })).rejects.toThrow(/not classified/);
    await expect(new CosmosDriver(spec({ endpoint: 'https://shop.documents.azure.com' }), parseAllowList('shop.documents.azure.com')).test(2000)).rejects.toThrow(/real cloud host blocked in tests/);
    await expect(new CosmosDriver(spec({ endpoint: 'https://8.8.4.4' }), parseAllowList('')).test(2000)).rejects.toThrow(/public address/);
  });
});

describe('Cosmos DB connections through the service', () => {
  let h: Harness;
  let az: FakeAzure;
  beforeEach(async () => {
    az = await new FakeAzure().start();
    az.cosmos.addContainer('shop', 'orders', { partitionKey: 'customer', docs: [{ id: 'o-1', customer: 'c-1', email: 'ana@example.org', billing: { iban: 'GB33BUKB20201555555555' } }] });
    az.cosmos.addContainer('shop', 'payroll', { partitionKey: 'id', docs: [{ id: 'p-1' }] });
    h = await harnessWith({}, { OLLAMA_POLL_MS: '600000' });
  });
  afterEach(async () => {
    await h.close();
    await az.stop();
  });

  it('runs allow-listed SELECTs, masks them, and sends nothing for a refused query', async () => {
    const me = await localUser(h, 'cos', ['connection-admin', 'member'], 'confidential');
    const c = await loginAdmin(h, 'cos');
    const post = (p: string, b: object = {}) => c.agent.post(p).set('x-csrf-token', c.csrf).send(b);
    const conn = (await post('/api/admin/connections', { name: 'shop', engine: 'cosmos-nosql', endpoint: az.url, database: 'shop', zone: 'data', label: 'internal', username: null, password: az.cosmos.readKey, tls: false }).expect(201)).body;
    expect(conn).toMatchObject({ engine: 'cosmos-nosql', tls: true, options: { auth: 'key' } });
    await post(`/api/admin/connections/${conn.id}/schema`).expect(200);
    await c.agent.put(`/api/admin/connections/${conn.id}/allow-list`).set('x-csrf-token', c.csrf).send({ objects: ['orders'], piiColumns: [] }).expect(200);
    az.reset();
    expect((await post(`/api/admin/connections/${conn.id}/query`, { query: 'DELETE FROM c', object: 'orders' }).expect(422)).body.title).toBe('Write refused');
    expect((await post(`/api/admin/connections/${conn.id}/query`, { query: 'SELECT * FROM c', object: 'payroll' }).expect(422)).body.title).toBe('Object outside the allow-list');
    expect((await post(`/api/admin/connections/${conn.id}/query`, { query: 'SELECT udf.x(c) FROM c', object: 'orders' }).expect(422)).body.title).toBe('Object outside the allow-list');
    expect(az.requests).toHaveLength(0);
    const r = (await post(`/api/admin/connections/${conn.id}/query`, { query: 'SELECT * FROM c', object: 'orders' }).expect(200)).body;
    expect(r.masked).toEqual(expect.arrayContaining(['email', 'billing']));
    expect(r.rows[0][r.columns.indexOf('email')]).toBe('••••.org');
    expect(JSON.parse(r.rows[0][r.columns.indexOf('billing')]).iban).toMatch(/^••••/);
    expect(me.id).toBeTruthy();
  });
});
