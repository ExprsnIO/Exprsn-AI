/*
 * 1.9.0: the engine catalogue (engines.ts), the SQL dialects (dialects.ts) and what the service and routes do with
 * them, engine by engine: settings checked and kept, TLS forced where it is required, the database field asked for
 * where it is needed, names resolved against the allow-list in each engine's naming, saved-query placeholders bound
 * in each dialect, and a knowledge-source read of a new engine's table. The drivers themselves have their own suites.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConnectionSpec, DataDriver, QueryResult } from '../src/connections/drivers.js';
import { allowedQualified, canonical, findObject, type NameContext } from '../src/connections/dialects.js';
import { engineCatalogue, ENGINES, parseOptions } from '../src/connections/engines.js';
import type { ParamDef } from '../src/connections/params.js';
import { renderSql, sqlPieces } from '../src/connections/saved-queries.js';
import { loginAdmin, localUser, type Harness } from './helpers.js';
import { harnessWith } from './retrieval-seed.js';

const ctx = (engine: NameContext['engine'], database: string | null, options: Record<string, unknown> = {}, account: string | null = null): NameContext => ({ engine, database, account, options });

describe('engine catalogue and settings', () => {
  it('lists every engine with what Register asks for', () => {
    const all = engineCatalogue(ENGINES);
    expect(all.map((e) => e.id)).toEqual(['postgres', 'opensearch', 'mysql', 'mongodb', 'mssql', 'azure-sql', 'oracle', 'snowflake', 'bigquery', 'redis', 'rabbitmq', 'prometheus', 'influxdb', 'documentdb', 'cosmos-mongodb', 'do-mongodb', 'dynamodb', 'cosmos-nosql', 'cloudflare-d1']);
    const byId = Object.fromEntries(all.map((e) => [e.id, e]));
    expect(byId['azure-sql']!.tlsRequired).toBe(true);
    expect(byId.snowflake!.transport).toBe('https');
    expect(byId.bigquery!.credential.multiline).toBe(true);
    expect(byId.oracle!.database).toMatchObject({ label: 'Service name', required: true });
    expect(engineCatalogue(['postgres', 'mssql']).map((e) => e.id)).toEqual(['postgres', 'mssql']);
    // 1.9.99-final (B-10304): the cloud document and key-value stores.
    expect(byId.dynamodb).toMatchObject({ family: 'keyvalue', transport: 'https', database: null, knowledgeSource: false, objectNoun: 'table' });
    expect(byId['cosmos-nosql']).toMatchObject({ family: 'document', transport: 'https', tlsRequired: true, knowledgeSource: false, objectNoun: 'container' });
    expect(byId['cosmos-mongodb']!.tlsRequired).toBe(true);
    expect(byId['do-mongodb']!.tlsRequired).toBe(true);
    expect(byId.documentdb).toMatchObject({ family: 'document', transport: 'tcp', knowledgeSource: true, defaultPort: 27017 });
    // 1.9.99-final, Sprint 61 (B-10907): Cloudflare D1, SQLite through the query API.
    expect(byId['cloudflare-d1']).toMatchObject({ family: 'sql', dialect: 'sqlite', transport: 'https', tlsRequired: true, objectNoun: 'table' });
    // Every engine's name fits data_connections.engine (string 20).
    for (const e of all) expect(e.id.length).toBeLessThanOrEqual(20);
  });

  it('checks settings and fills defaults', () => {
    expect(parseOptions('mssql', {})).toEqual({ options: { schema: 'dbo', applicationIntent: 'ReadOnly' }, problems: [] });
    expect(parseOptions('snowflake', { warehouse: 'WH', role: 'READER' }).options).toEqual({ auth: 'key-pair', warehouse: 'WH', role: 'READER', schema: 'PUBLIC' });
    expect(parseOptions('azure-sql', { auth: 'entra-service-principal' }).problems).toEqual(['A service principal needs the Entra tenant id.']);
    expect(parseOptions('postgres', { schema: 'x' }).problems[0]).toMatch(/Unrecognized key/);
    expect(parseOptions('snowflake', { role: 'bad role; drop' }).problems[0]).toMatch(/role: a plain name/);
    expect(parseOptions('bigquery', { maximumBytesBilled: 5 }).problems[0]).toMatch(/maximumBytesBilled/);
    expect(parseOptions('dynamodb', {}).options).toEqual({ consistentRead: 'off', maxPages: 10 });
    expect(parseOptions('dynamodb', { region: 'not a region' }).problems[0]).toMatch(/region/);
    expect(parseOptions('documentdb', { tlsCaFile: '/etc/exprsn/ca/rds-global-bundle.pem' }).options).toEqual({ tlsCaFile: '/etc/exprsn/ca/rds-global-bundle.pem', readPreference: 'secondaryPreferred' });
    expect(parseOptions('documentdb', { tlsCaFile: '../../etc/passwd' }).problems[0]).toMatch(/tlsCaFile/);
    expect(parseOptions('documentdb', { tlsCaFile: '/etc/../etc/passwd.pem' }).problems[0]).toMatch(/tlsCaFile/);
    expect(parseOptions('cosmos-nosql', { auth: 'entra-service-principal' }).problems).toEqual(['A service principal needs the Entra tenant id.']);
    expect(parseOptions('cosmos-nosql', {}).options).toEqual({ auth: 'key' });
  });
});

describe('names in each engine', () => {
  it('resolves SQL Server and Azure SQL names to schema.table', () => {
    const c = ctx('mssql', 'Sales', { schema: 'dbo' });
    expect(canonical('Orders', c)).toBe('dbo.orders');
    expect(canonical('Sales.dbo.Orders', c)).toBe('dbo.orders');
    expect(canonical('Sales..Orders', c)).toBe('dbo.orders');
    expect(canonical('Other.dbo.Orders', c)).toBe('other.dbo.orders');
    expect(allowedQualified('orders', ['dbo.Orders'], c)).toBe(true);
    expect(allowedQualified('Other.dbo.Orders', ['dbo.Orders'], c)).toBe(false);
    expect(allowedQualified('hr.salaries', ['dbo.Orders'], c)).toBe(false);
  });

  it('resolves Oracle names to the schema option or the account', () => {
    expect(canonical('EMPLOYEES', ctx('oracle', 'FREEPDB1', {}, 'HR'))).toBe('hr.employees');
    expect(canonical('EMPLOYEES', ctx('oracle', 'FREEPDB1', { schema: 'APP' }, 'HR'))).toBe('app.employees');
    expect(allowedQualified('hr.employees', ['HR.EMPLOYEES'], ctx('oracle', 'FREEPDB1', {}, 'HR'))).toBe(true);
  });

  it('resolves Snowflake and BigQuery names, dropping only the connection\'s own database or project', () => {
    const sf = ctx('snowflake', 'ANALYTICS', { schema: 'PUBLIC' });
    expect(canonical('analytics.public.orders', sf)).toBe('public.orders');
    expect(canonical('ORDERS', sf)).toBe('public.orders');
    expect(allowedQualified('OTHERDB.PUBLIC.ORDERS', ['PUBLIC.ORDERS'], sf)).toBe(false);
    const bq = ctx('bigquery', 'my-project');
    expect(canonical('my-project.sales.orders', bq)).toBe('sales.orders');
    expect(canonical('orders', bq)).toBe('orders');
    expect(allowedQualified('orders', ['orders'], bq)).toBe(true);
    expect(allowedQualified('other-project.sales.orders', ['sales.orders'], bq)).toBe(false);
    expect(findObject([{ name: 'sales.orders' }], 'my-project.sales.orders', bq)?.name).toBe('sales.orders');
  });
});

describe('saved-query placeholders in each dialect', () => {
  const defs = [
    { name: 'tier', type: 'string' as const, required: true },
    { name: 'ids', type: 'list' as const, required: true }
  ] as unknown as ParamDef[];
  const names = new Set(['tier', 'ids']);
  const values = { tier: 'gold', ids: [1, 2] };
  const sql = 'SELECT * FROM t WHERE tier = :tier AND id IN (:ids) AND alt = :tier';

  it('writes each dialect\'s placeholders', () => {
    expect(renderSql(sqlPieces(sql, 'tsql', names).pieces, 'tsql', defs, values)).toEqual({ text: 'SELECT * FROM t WHERE tier = @p1 AND id IN (@p2, @p3) AND alt = @p1', params: ['gold', 1, 2] });
    expect(renderSql(sqlPieces(sql, 'oracle', names).pieces, 'oracle', defs, values)).toEqual({ text: 'SELECT * FROM t WHERE tier = :1 AND id IN (:2, :3) AND alt = :4', params: ['gold', 1, 2, 'gold'] });
    expect(renderSql(sqlPieces(sql, 'snowflake', names).pieces, 'snowflake', defs, values).text).toBe('SELECT * FROM t WHERE tier = ? AND id IN (?, ?) AND alt = ?');
    expect(renderSql(sqlPieces(sql, 'bigquery', names).pieces, 'bigquery', defs, values).params).toEqual(['gold', 1, 2, 'gold']);
  });

  it('does not read placeholders inside each dialect\'s strings, identifiers and comments', () => {
    const none = new Set<string>();
    expect(() => sqlPieces("SELECT [a:b], N':x' FROM t /* :y /* :z */ */ -- :w", 'tsql', none)).not.toThrow();
    expect(() => sqlPieces("SELECT q'[it's :x]', \"A:B\" FROM t", 'oracle', none)).not.toThrow();
    expect(() => sqlPieces("SELECT $$ :x $$, v:field FROM t // :y", 'snowflake', none)).not.toThrow();
    expect(() => sqlPieces("SELECT '''a :x''', `p.d:t` FROM t # :y", 'bigquery', none)).not.toThrow();
    expect(() => sqlPieces('SELECT 1 FROM t WHERE a = :typo', 'tsql', none)).toThrow(/:typo/);
  });
});

/** A stand-in driver: answers from fixed rows, records what it was asked. */
class FakeDriver implements DataDriver {
  static seen: { spec: ConnectionSpec; text?: string; params?: unknown[]; object?: string }[] = [];
  constructor(readonly spec: ConnectionSpec) {}
  async test() {
    return { version: `${this.spec.engine} 1`, readOnly: true, health: 'healthy' as const, detail: 'read-only' };
  }
  async introspect() {
    return [{ name: 'dbo.Orders', kind: 'table' as const, columns: [{ name: 'id', type: 'int' }, { name: 'customer_email', type: 'nvarchar' }, { name: 'updated_at', type: 'datetime2' }] }];
  }
  async query(_c: unknown, text: string, opts: { params?: unknown[] }): Promise<QueryResult> {
    FakeDriver.seen.push({ spec: this.spec, text, ...(opts.params ? { params: opts.params } : {}) });
    return { columns: ['id', 'customer_email'], rows: [[1, 'ana@example.org']], capped: false, estimate: null };
  }
  async rows(object: string): Promise<QueryResult> {
    FakeDriver.seen.push({ spec: this.spec, object });
    return { columns: ['id', 'customer_email', 'updated_at'], rows: [[1, 'ana@example.org', '2026-10-01T00:00:00Z']], capped: false, estimate: null };
  }
}

describe('registering the new engines', () => {
  let h: Harness;
  beforeEach(async () => {
    FakeDriver.seen = [];
    const fake = (spec: ConnectionSpec) => new FakeDriver(spec);
    h = await harnessWith({ drivers: { mssql: fake, 'azure-sql': fake, oracle: fake, snowflake: fake, bigquery: fake } }, { OLLAMA_POLL_MS: '600000' });
  });
  afterEach(async () => h.close());

  async function admin() {
    await localUser(h, 'connadmin', ['connection-admin', 'member'], 'confidential');
    const c = await loginAdmin(h, 'connadmin');
    const send = (m: 'post' | 'patch' | 'put', p: string, b: object = {}) => c.agent[m](p).set('x-csrf-token', c.csrf).send(b);
    return { post: (p: string, b?: object) => send('post', p, b), patch: (p: string, b?: object) => send('patch', p, b), put: (p: string, b?: object) => send('put', p, b), get: (p: string) => c.agent.get(p) };
  }

  it('offers the catalogue and checks each engine\'s fields', async () => {
    const a = await admin();
    const cat = (await a.get('/api/admin/connections/engines').expect(200)).body as { id: string; options: { name: string }[] }[];
    expect(cat.map((e) => e.id)).toContain('snowflake');
    expect(cat.find((e) => e.id === 'azure-sql')!.options.map((o) => o.name)).toContain('entraTenantId');
    const base = { endpoint: 'sql.internal:1433', zone: 'data', label: 'internal', username: 'reader', password: 'pw' };
    expect((await a.post('/api/admin/connections', { ...base, name: 'sales', engine: 'mssql' }).expect(409)).body.detail).toMatch(/names the database it reads/);
    expect((await a.post('/api/admin/connections', { ...base, name: 'az', engine: 'azure-sql', database: 'sales', options: { auth: 'entra-service-principal' } }).expect(422)).body.detail).toMatch(/Entra tenant id/);
    expect((await a.post('/api/admin/connections', { ...base, name: 'cobol', engine: 'db2', database: 'x' }).expect(409)).body.detail).toMatch(/Register offers .*SQL Server.*BigQuery/);
    expect((await a.post('/api/admin/connections', { ...base, name: 'pg', engine: 'postgres', options: { schema: 'x' } }).expect(422)).body.title).toBe('Invalid settings');

    const az = (await a.post('/api/admin/connections', { ...base, name: 'az', engine: 'azure-sql', endpoint: 'contoso.database.windows.net', database: 'sales', tls: false, options: { auth: 'entra-service-principal', entraTenantId: 'contoso.onmicrosoft.com' } }).expect(201)).body;
    expect(az).toMatchObject({ engine: 'azure-sql', engineTitle: 'Azure SQL', family: 'sql', tls: true, options: { auth: 'entra-service-principal', entraTenantId: 'contoso.onmicrosoft.com', schema: 'dbo', applicationIntent: 'ReadOnly' } });
    expect((await a.patch(`/api/admin/connections/${az.id}`, { tls: false }).expect(409)).body.detail).toMatch(/always use TLS/);
    expect((await a.patch(`/api/admin/connections/${az.id}`, { options: { auth: 'sql', schema: 'sales' } }).expect(200)).body.options).toEqual({ auth: 'sql', schema: 'sales', applicationIntent: 'ReadOnly' });

    // BigQuery: the account is optional (the key names its service account); a JSON key longer than a password fits.
    const key = JSON.stringify({ type: 'service_account', client_email: 'reader@p.iam.gserviceaccount.com', private_key: `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(1600)}\n-----END PRIVATE KEY-----\n` });
    const bq = (await a.post('/api/admin/connections', { name: 'bq', engine: 'bigquery', endpoint: 'bigquery.googleapis.com', database: 'my-project', zone: 'data', label: 'internal', username: null, password: key, options: { location: 'EU' } }).expect(201)).body;
    expect(bq).toMatchObject({ hasCredential: true, account: null, tls: true });
    await a.post(`/api/admin/connections/${bq.id}/test`).expect(200);
    expect(FakeDriver.seen.length).toBe(0); // test() is not recorded; the spec reached the driver through the factory
    await a.put(`/api/admin/connections/${bq.id}/credential`, { username: null, password: key }).expect(200);
    expect((await a.put(`/api/admin/connections/${az.id}/credential`, { username: null, password: 'x' }).expect(409)).body.detail).toMatch(/names its account or client id/);
  });

  it('runs allow-listed reads and binds saved-query parameters in the engine\'s dialect', async () => {
    const a = await admin();
    const conn = (await a.post('/api/admin/connections', { name: 'sales', engine: 'mssql', endpoint: 'sql.internal:1433', database: 'Sales', zone: 'data', label: 'internal', username: 'reader', password: 'pw' }).expect(201)).body;
    await a.post(`/api/admin/connections/${conn.id}/schema`).expect(200);
    await a.put(`/api/admin/connections/${conn.id}/allow-list`, { objects: ['dbo.Orders'] }).expect(200);
    const r = (await a.post(`/api/admin/connections/${conn.id}/query`, { query: 'SELECT TOP 10 id, customer_email FROM [Sales].[dbo].[Orders]' }).expect(200)).body;
    expect(r).toMatchObject({ columns: ['id', 'customer_email'], masked: ['customer_email'] });
    expect(r.rows[0][1]).toBe('••••.org');
    expect((await a.post(`/api/admin/connections/${conn.id}/query`, { query: 'SELECT * FROM hr.Salaries' }).expect(422)).body.title).toBe('Object outside the allow-list');
    expect((await a.post(`/api/admin/connections/${conn.id}/query`, { query: 'DELETE FROM dbo.Orders' }).expect(422)).body.title).toBe('Write refused');
  });
});
