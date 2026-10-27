/*
 * 1.9.99-final, Sprint 59 (B-10304): Amazon DynamoDB as a read-only data connection. The classifier (Query and
 * PartiQL SELECT only; writes, table changes and scans named and refused, a WHERE that would scan refused once the
 * keys are known), and the driver against the in-process fake (`fake-aws-data.ts`), which records every operation, so
 * the tests show that a refused request never reaches it, that requests are SigV4-signed with the connection's key
 * (and session token), that rows are capped and masked, and that the key can come from the vault. Nothing reaches AWS:
 * the offline guard refuses its real hosts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { classifyDynamo, DynamoDriver, dynamoRegion, unmarshall } from '../src/connections/dynamodb.js';
import type { ConnectionSpec } from '../src/connections/drivers.js';
import { parseAllowList } from '../src/mcp/hosts.js';
import { FakeAws } from './fake-aws.js';
import { localUser, loginAdmin, type Harness } from './helpers.js';
import { harnessWith } from './retrieval-seed.js';

const schema = [
  { name: 'orders', columns: [{ name: 'customer', type: 'string, partition key' }, { name: 'placed', type: 'string, sort key' }] },
  { name: 'orders.by-status', columns: [{ name: 'status', type: 'string, partition key' }] }
];
const ctx = { database: null, options: {}, schema };

describe('DynamoDB classification', () => {
  it('reads PartiQL SELECTs and Query requests', () => {
    expect(classifyDynamo('SELECT * FROM "orders" WHERE customer = ?', null, ctx)).toMatchObject({ kind: 'read', verb: 'SELECT', objects: ['orders'], op: { kind: 'statement' } });
    expect(classifyDynamo('select total from orders where "customer" = \'c-1\' and placed > \'2026\';', null, ctx)).toMatchObject({ kind: 'read', objects: ['orders'] });
    expect(classifyDynamo('SELECT * FROM "orders"."by-status" WHERE status IN [\'open\', \'held\']', null, ctx)).toMatchObject({ kind: 'read', objects: ['orders'] });
    expect(classifyDynamo('{"ExecuteStatement": {"Statement": "SELECT * FROM \\"orders\\" WHERE customer = ?", "Parameters": [{"S": "c-1"}]}}', null, ctx)).toMatchObject({ kind: 'read', op: { kind: 'statement', parameters: [{ S: 'c-1' }] } });
    const q = classifyDynamo('{"Query": {"TableName": "orders", "KeyConditionExpression": "#c = :c", "ExpressionAttributeNames": {"#c": "customer"}, "ExpressionAttributeValues": {":c": {"S": "c-1"}}}}', null, ctx);
    expect(q).toMatchObject({ kind: 'read', verb: 'Query', objects: ['orders'], op: { kind: 'query', input: { TableName: 'orders' } } });
    // The table picked in the schema tree fills a Query that names none.
    expect(classifyDynamo('{"KeyConditionExpression": "customer = :c", "ExpressionAttributeValues": {":c": {"S": "x"}}}', 'orders', ctx)).toMatchObject({ kind: 'read', objects: ['orders'] });
  });

  it('refuses writes, table changes, scans and every other operation, naming them', () => {
    for (const q of ['UPDATE "orders" SET total = 0 WHERE customer = ?', 'INSERT INTO "orders" VALUE {\'customer\': \'x\'}', 'DELETE FROM orders WHERE customer = ?', 'UPSERT INTO orders VALUE {}']) expect(classifyDynamo(q, null, ctx).kind, q).toBe('write');
    for (const op of ['PutItem', 'UpdateItem', 'DeleteItem', 'BatchWriteItem', 'TransactWriteItems', 'BatchExecuteStatement', 'ExecuteTransaction']) expect(classifyDynamo(JSON.stringify({ [op]: { TableName: 'orders' } }), null, ctx)).toMatchObject({ kind: 'write', verb: op });
    for (const op of ['CreateTable', 'DeleteTable', 'UpdateTable', 'UpdateTimeToLive', 'RestoreTableFromBackup']) expect(classifyDynamo(JSON.stringify({ [op]: { TableName: 'orders' } }), null, ctx).kind, op).toBe('ddl');
    expect(classifyDynamo('CREATE TABLE x', null, ctx).kind).toBe('ddl');
    expect(classifyDynamo('{"Scan": {"TableName": "orders"}}', null, ctx)).toMatchObject({ kind: 'denied', denied: 'Scan', reason: /whole table/ });
    expect(classifyDynamo('SELECT * FROM "orders"', null, ctx)).toMatchObject({ kind: 'denied', denied: 'Scan' });
    // With the keys known, a WHERE that does not name the partition key (or widens it with OR) would scan.
    expect(classifyDynamo('SELECT * FROM "orders" WHERE total > 10', null, ctx)).toMatchObject({ kind: 'denied', reason: /partition key customer/ });
    expect(classifyDynamo('SELECT * FROM "orders" WHERE customer = ? OR total > 1', null, ctx)).toMatchObject({ kind: 'denied' });
    expect(classifyDynamo('{"GetItem": {"TableName": "orders"}}', null, ctx)).toMatchObject({ kind: 'denied', verb: 'GetItem' });
    expect(classifyDynamo('{"ListGlobalTables": {}}', null, ctx)).toMatchObject({ kind: 'denied' });
    expect(classifyDynamo('SELECT * FROM "orders" WHERE customer = ?; DELETE FROM orders WHERE customer = ?', null, ctx).kind).toBe('multiple');
    expect(classifyDynamo('{"Query": {"TableName": "orders"}}', null, ctx)).toMatchObject({ kind: 'unparsed', reason: /KeyConditionExpression/ });
    expect(classifyDynamo('{"Query": {"TableName": "orders", "KeyConditionExpression": "a = :a", "Segment": 1}}', null, ctx)).toMatchObject({ kind: 'unparsed', reason: /Segment/ });
    expect(classifyDynamo('EXPLAIN', null, ctx).kind).toBe('unparsed');
    expect(classifyDynamo('SELECT * FROM "orders WHERE x', null, ctx).kind).toBe('unparsed');
  });

  it('reads values and regions', () => {
    expect(unmarshall({ M: { a: { N: '12' }, b: { L: [{ S: 'x' }, { BOOL: true }, { NULL: true }] }, c: { NS: ['1', '2.5'] }, d: { B: 'AAEC' }, e: { N: '12345678901234567890' } } })).toEqual({ a: 12, b: ['x', true, null], c: [1, 2.5], d: '[binary 3 bytes]', e: '12345678901234567890' });
    expect(dynamoRegion('https://dynamodb.eu-west-1.amazonaws.com')).toBe('eu-west-1');
    expect(dynamoRegion('https://vpce-0abc-xyz.dynamodb.ap-southeast-2.vpce.amazonaws.com')).toBe('ap-southeast-2');
    expect(dynamoRegion('http://127.0.0.1:8000', 'eu-central-1')).toBe('eu-central-1');
    expect(dynamoRegion('http://dynamodb-local:8000')).toBe('us-east-1');
  });
});

describe('DynamoDriver against the fake', () => {
  let aws: FakeAws;
  let key: { accessKeyId: string; secretAccessKey: string };
  beforeAll(async () => {
    aws = await new FakeAws().start();
    key = aws.addUser({ userName: 'reader' });
    aws.data.addTable({ name: 'orders', pk: 'customer', sk: 'placed', items: Array.from({ length: 5 }, (_, i) => ({ customer: { S: 'c-1' }, placed: { S: `2026-10-0${i + 1}` }, total: { N: String(10 * (i + 1)) }, email: { S: `buyer${i}@example.org` } })), gsi: [{ name: 'by-status', pk: 'status' }] });
  });
  afterAll(async () => aws.stop());
  beforeEach(() => {
    aws.reset();
    aws.data.ops.length = 0;
  });

  const spec = (o: Partial<ConnectionSpec> = {}): ConnectionSpec => ({ engine: 'dynamodb', endpoint: aws.url, database: null, tls: false, username: key.accessKeyId, password: key.secretAccessKey, options: { region: 'eu-central-1', maxPages: 10 }, ...o });

  it('tests, introspects keys and indexes, and signs with SigV4 for dynamodb in the region', async () => {
    const d = new DynamoDriver(spec(), parseAllowList(''));
    expect(await d.test(5000)).toMatchObject({ readOnly: true, health: 'healthy', version: expect.stringMatching(/DynamoDB-compatible/) });
    const objects = await d.introspect(5000);
    expect(objects.find((o) => o.name === 'orders')!.columns.slice(0, 2)).toEqual([{ name: 'customer', type: 'string, partition key' }, { name: 'placed', type: 'string, sort key' }]);
    expect(objects.find((o) => o.name === 'orders')!.columns.map((c) => c.name)).toContain('email');
    expect(objects.find((o) => o.name === 'orders.by-status')).toMatchObject({ kind: 'index', columns: [{ name: 'status', type: 'string, partition key' }] });
    const auth = aws.calls('dynamodb:ListTables')[0]!.headers.authorization!;
    expect(auth).toMatch(new RegExp(`^AWS4-HMAC-SHA256 Credential=${key.accessKeyId}/\\d{8}/eu-central-1/dynamodb/aws4_request`));
  });

  it('caps a Query and a SELECT at the row limit, paging as DynamoDB does', async () => {
    const d = new DynamoDriver(spec(), parseAllowList(''));
    const q = classifyDynamo('{"Query": {"TableName": "orders", "KeyConditionExpression": "customer = :c", "ExpressionAttributeValues": {":c": {"S": "c-1"}}}}', null, { database: null, options: {} });
    const r = await d.query(q, '', { limit: 3, timeoutMs: 5000 });
    expect(r).toMatchObject({ capped: true, rows: expect.any(Array) });
    expect(r.rows).toHaveLength(3);
    expect(r.columns).toEqual(['customer', 'placed', 'total', 'email']);
    expect(r.rows[0]).toEqual(['c-1', '2026-10-01', 10, 'buyer0@example.org']);
    const all = await d.query(q, '', { limit: 10, timeoutMs: 5000 });
    expect(all).toMatchObject({ capped: false });
    expect(all.rows).toHaveLength(5);
    const st = classifyDynamo('SELECT * FROM "orders" WHERE "customer" = ?', null, { database: null, options: {} });
    const withParam = { ...st, op: { ...(st.op as object), parameters: [{ S: 'c-1' }] } };
    const sr = await d.query(withParam, '', { limit: 2, timeoutMs: 5000 });
    expect(sr.rows).toHaveLength(2);
    expect(sr.capped).toBe(true);
    const counted = await d.query(classifyDynamo('{"Query": {"TableName": "orders", "Select": "COUNT", "KeyConditionExpression": "customer = :c", "ExpressionAttributeValues": {":c": {"S": "c-1"}}}}', null, { database: null, options: {} }), '', { limit: 2, timeoutMs: 5000 });
    expect(counted).toMatchObject({ columns: ['count'], rows: [[5]] });
    expect(aws.data.ops.every((o) => ['Query', 'ExecuteStatement'].includes(o.op))).toBe(true);
  });

  it('sends a temporary key\'s session token, refuses what was not classified as a read, and keeps to the address guard', async () => {
    const temp = aws.addUser({ userName: 'session' });
    aws.keys.get(temp.accessKeyId)!.sessionToken = 'session-token-1';
    const d = new DynamoDriver(spec({ username: temp.accessKeyId, password: temp.secretAccessKey, sessionToken: 'session-token-1' }), parseAllowList(''));
    await d.test(5000);
    expect(aws.calls('dynamodb:ListTables').at(-1)!.headers['x-amz-security-token']).toBe('session-token-1');
    await expect(new DynamoDriver(spec({ username: temp.accessKeyId, password: temp.secretAccessKey }), parseAllowList('')).test(5000)).rejects.toThrow(/UnrecognizedClient|InvalidClientTokenId|refused/);
    await expect(d.query({ kind: 'read', verb: 'Scan', objects: ['orders'], op: { kind: 'scan' } }, '', { limit: 5, timeoutMs: 5000 })).rejects.toThrow(/not classified/);
    await expect(d.query({ kind: 'read', verb: 'SELECT', objects: ['orders'], op: { kind: 'statement', statement: 'UPDATE "orders" SET a = 1 WHERE customer = ?' } }, '', { limit: 5, timeoutMs: 5000 })).rejects.toThrow(/Only a PartiQL SELECT/);
    await expect(new DynamoDriver(spec({ endpoint: 'http://169.254.169.254' }), parseAllowList('')).test(2000)).rejects.toThrow(/metadata|link-local/);
    await expect(new DynamoDriver(spec({ endpoint: 'https://8.8.8.8' }), parseAllowList('')).test(2000)).rejects.toThrow(/public address/);
    await expect(new DynamoDriver(spec({ username: null, password: null }), parseAllowList('')).test(2000)).rejects.toThrow(/needs an access key/);
  });

  it('never reaches the real AWS from tests', async () => {
    await expect(new DynamoDriver(spec({ endpoint: 'https://dynamodb.eu-west-1.amazonaws.com' }), parseAllowList('dynamodb.eu-west-1.amazonaws.com')).test(2000)).rejects.toThrow(/real cloud host blocked in tests/);
  });
});

describe('DynamoDB connections through the service', () => {
  let h: Harness;
  let aws: FakeAws;
  let key: { accessKeyId: string; secretAccessKey: string };
  beforeEach(async () => {
    aws = await new FakeAws().start();
    key = aws.addUser({ userName: 'reader' });
    aws.data.addTable({ name: 'orders', pk: 'customer', items: [{ customer: { S: 'c-1' }, email: { S: 'ana@example.org' }, profile: { M: { phone: { S: '+44 20 7946 0958' } } }, total: { N: '42' } }] });
    aws.data.addTable({ name: 'payroll', pk: 'id', items: [{ id: { S: 'p-1' }, salary: { N: '1' } }] });
    h = await harnessWith({}, { OLLAMA_POLL_MS: '600000' });
  });
  afterEach(async () => {
    await h.close();
    await aws.stop();
  });

  async function admin() {
    const me = await localUser(h, 'dyn', ['connection-admin', 'member'], 'confidential');
    const c = await loginAdmin(h, 'dyn');
    const send = (m: 'post' | 'patch' | 'put', p: string, b: object = {}) => c.agent[m](p).set('x-csrf-token', c.csrf).send(b);
    return { id: me.id, post: (p: string, b?: object) => send('post', p, b), put: (p: string, b?: object) => send('put', p, b), get: (p: string) => c.agent.get(p) };
  }

  it('refuses a DynamoDB UPDATE by classification before it reaches the provider; reads are allow-listed and masked', async () => {
    const a = await admin();
    const conn = (await a.post('/api/admin/connections', { name: 'shop', engine: 'dynamodb', endpoint: aws.url, zone: 'data', label: 'internal', username: key.accessKeyId, password: key.secretAccessKey, options: { region: 'eu-central-1' } }).expect(201)).body;
    expect(conn).toMatchObject({ engine: 'dynamodb', family: 'keyvalue', options: { region: 'eu-central-1', consistentRead: 'off', maxPages: 10 } });
    expect((await a.post(`/api/admin/connections/${conn.id}/test`).expect(200)).body).toMatchObject({ ok: true, readOnly: true });
    await a.post(`/api/admin/connections/${conn.id}/schema`).expect(200);
    await a.put(`/api/admin/connections/${conn.id}/allow-list`, { objects: ['orders'], piiColumns: [] }).expect(200);
    aws.reset();
    aws.data.ops.length = 0;

    const upd = await a.post(`/api/admin/connections/${conn.id}/query`, { query: 'UPDATE "orders" SET total = 0 WHERE customer = \'c-1\'' }).expect(422);
    expect(upd.body).toMatchObject({ title: 'Write refused', kind: 'write', verb: 'UPDATE' });
    for (const q of ['{"PutItem": {"TableName": "orders", "Item": {}}}', '{"DeleteTable": {"TableName": "orders"}}', '{"Scan": {"TableName": "orders"}}', 'SELECT * FROM "orders"', 'SELECT * FROM "orders" WHERE total > 1']) await a.post(`/api/admin/connections/${conn.id}/query`, { query: q }).expect(422);
    // Outside the allow-list, by PartiQL or Query.
    expect((await a.post(`/api/admin/connections/${conn.id}/query`, { query: 'SELECT * FROM "payroll" WHERE id = \'p-1\'' }).expect(422)).body.title).toBe('Object outside the allow-list');
    expect(aws.requests).toHaveLength(0);
    expect((await h.s.audit.list(h.tenantId, { action: 'connection.query.refused' })).length).toBe(7);

    const res = await a.post(`/api/admin/connections/${conn.id}/query`, { query: 'SELECT * FROM "orders" WHERE "customer" = \'c-1\'' });
    expect(res.status, res.text).toBe(200);
    const r = res.body;
    expect(r.columns, res.text).toEqual(['customer', 'email', 'profile', 'total']);
    expect(r.masked).toEqual(expect.arrayContaining(['email', 'profile']));
    expect(r.rows[0][1]).toBe('••••.org');
    expect(JSON.parse(r.rows[0][2]).phone).toMatch(/^••••/);
    expect(aws.data.ops.map((o) => o.op)).toEqual(['ExecuteStatement']);
  });

  it('takes the key from the vault at every use', async () => {
    const a = await admin();
    const rootId = (await localUser(h, 'vaultroot', ['system-admin'], 'restricted')).id;
    const root = await loginAdmin(h, 'vaultroot');
    await root.agent.post('/api/vault/policies').set('x-csrf-token', root.csrf).send({ subjectKind: 'user', subject: rootId, path: 'kv', capabilities: ['write', 'list'], effect: 'allow' }).expect(201);
    await root.agent.put('/api/vault/kv/data/aws/reader').set('x-csrf-token', root.csrf).send({ data: { secret: key.secretAccessKey } }).expect(201);
    await root.agent.post('/api/vault/policies').set('x-csrf-token', root.csrf).send({ subjectKind: 'user', subject: a.id, path: 'kv/aws', capabilities: ['read'], effect: 'allow' }).expect(201);
    const conn = (await a.post('/api/admin/connections', { name: 'vaulted', engine: 'dynamodb', endpoint: aws.url, zone: 'data', label: 'internal', username: key.accessKeyId, password: 'vault:aws/reader#secret', options: { region: 'eu-central-1' } }).expect(201)).body;
    expect(conn).toMatchObject({ passwordFromVault: true });
    expect((await a.post(`/api/admin/connections/${conn.id}/test`).expect(200)).body).toMatchObject({ ok: true });
    expect(aws.calls('dynamodb:ListTables').at(-1)!.headers.authorization).toContain(key.accessKeyId);
  });
});
