import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowedIndex, allowedSql, classifyOpenSearch, classifySql } from '../src/connections/classify.js';
import type { ConnectionSpec, DataDriver, QueryResult } from '../src/connections/drivers.js';
import { FakeOllama } from './fake-ollama.js';
import { loginAdmin, type Harness } from './helpers.js';
import { localUser } from './helpers.js';
import { client, drain, harnessWith, seedRetrieval } from './retrieval-seed.js';

describe('query classification', () => {
  it('reads SQL: verbs, objects, CTEs and joins', () => {
    expect(classifySql('SELECT cost_centre, q3_actual FROM ledger.v_cost_centres WHERE q3_actual > q3_budget ORDER BY 2 DESC LIMIT 500;')).toMatchObject({ kind: 'read', verb: 'SELECT', objects: ['ledger.v_cost_centres'] });
    expect(classifySql('WITH o AS (SELECT * FROM ledger.a) SELECT * FROM o JOIN "Ledger"."B" b ON b.id = o.id, ledger.c AS c').objects).toEqual(['ledger.a', 'Ledger.B', 'ledger.c']);
    expect(classifySql('select 1 from t -- DELETE in a comment\n where x = \'DROP TABLE y\'')).toMatchObject({ kind: 'read', objects: ['t'] });
    expect(classifySql('SELECT * FROM (SELECT * FROM inner_t) s, outer_t o WHERE s.a IN (SELECT a FROM sub_t)').objects).toEqual(['inner_t', 'outer_t', 'sub_t']);
    expect(classifySql('TABLE ledger.x')).toMatchObject({ kind: 'read', objects: ['ledger.x'] });
    expect(classifySql('SELECT copy, lock FROM t')).toMatchObject({ kind: 'read', objects: ['t'] });
  });

  it('refuses writes, DDL, several statements, locking and dangerous functions; flags what it cannot read', () => {
    expect(classifySql("UPDATE ledger.v_cost_centres SET q3_budget = q3_actual WHERE cost_centre = 'LIS-ONBOARD';")).toMatchObject({ kind: 'write', verb: 'UPDATE' });
    expect(classifySql('DROP TABLE ledger.card_feed;')).toMatchObject({ kind: 'ddl', verb: 'DROP' });
    expect(classifySql('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d')).toMatchObject({ kind: 'write', verb: 'DELETE' });
    expect(classifySql('SELECT * INTO copy FROM t')).toMatchObject({ kind: 'write', verb: 'SELECT INTO' });
    expect(classifySql('SELECT * FROM t FOR UPDATE')).toMatchObject({ kind: 'write' });
    expect(classifySql('SELECT 1 FROM t; DELETE FROM t')).toMatchObject({ kind: 'multiple' });
    expect(classifySql('SET search_path = x')).toMatchObject({ kind: 'ddl', verb: 'SET' });
    expect(classifySql("SELECT pg_read_file('/etc/passwd') FROM t")).toMatchObject({ kind: 'denied', denied: 'pg_read_file()' });
    expect(classifySql('SELECT * FROM dblink(\'x\', \'y\') AS t(a int)')).toMatchObject({ kind: 'denied' });
    expect(classifySql('SELECT cost_centre, q3_actual::vendor_money AS actual FROM ledger.v_cost_centres')).toMatchObject({ kind: 'unparsed' });
    expect(classifySql('SELECT 1 FROM t WHERE x = $$ hint $$')).toMatchObject({ kind: 'unparsed' });
    expect(classifySql('SELECT q3_actual::numeric FROM t')).toMatchObject({ kind: 'read' });
    expect(classifySql('EXPLAIN ANALYZE DELETE FROM t')).toMatchObject({ kind: 'write' });
  });

  it('checks objects against the allow-list', () => {
    expect(allowedSql('ledger.v_cost_centres', ['ledger.v_cost_centres'])).toBe(true);
    expect(allowedSql('v_x', ['public.v_x'])).toBe(true);
    expect(allowedSql('ledger.payroll_lines', ['ledger.v_cost_centres'])).toBe(false);
    expect(allowedIndex('gateway-logs-2026.09.19', ['gateway-logs-*'])).toBe(true);
    expect(allowedIndex('gateway-logs-*', ['gateway-logs-*'])).toBe(true);
    expect(allowedIndex('*', ['gateway-logs-*'])).toBe(false);
    expect(allowedIndex('security-1', ['gateway-logs-*'])).toBe(false);
  });

  it('reads OpenSearch requests', () => {
    expect(classifyOpenSearch('{ "size": 500, "query": { "match_all": {} } }', 'gateway-logs-*')).toMatchObject({ kind: 'read', request: { path: '/gateway-logs-*/_search', endpoint: '_search' } });
    expect(classifyOpenSearch('POST /gateway-logs-*/_delete_by_query\n{ "query": { "term": { "level": "error" } } }', null)).toMatchObject({ kind: 'write', verb: '_delete_by_query' });
    expect(classifyOpenSearch('DELETE /gateway-logs-2026.09.19', null)).toMatchObject({ kind: 'ddl' });
    expect(classifyOpenSearch('GET /_cat/indices', null)).toMatchObject({ kind: 'denied' });
    expect(classifyOpenSearch('{ not json', 'x')).toMatchObject({ kind: 'unparsed' });
    expect(classifyOpenSearch('GET /audit-*/_count', null)).toMatchObject({ kind: 'read', objects: ['audit-*'] });
  });
});

/** A DataDriver over an in-memory SQLite database, standing in for PostgreSQL. */
class SqliteDriver implements DataDriver {
  constructor(
    private readonly db: Database.Database,
    readonly spec: ConnectionSpec
  ) {}

  async test() {
    if (this.spec.password !== 'right') throw new Error('password authentication failed');
    return { version: 'SQLite ' + (this.db.prepare('select sqlite_version() v').get() as { v: string }).v, readOnly: true, health: 'healthy' as const, detail: `Account ${this.spec.username} is read-only; no write grants.` };
  }

  async introspect() {
    const objs = this.db.prepare("select name, type from sqlite_master where type in ('table','view') and name not like 'sqlite_%' order by name").all() as { name: string; type: string }[];
    return objs.map((o) => ({ name: `ledger.${o.name}`, kind: o.type === 'view' ? ('view' as const) : ('table' as const), columns: (this.db.prepare(`pragma table_info("${o.name}")`).all() as { name: string; type: string }[]).map((c) => ({ name: c.name, type: c.type.toLowerCase() })) }));
  }

  private run(sql: string, params: unknown[], limit: number): QueryResult {
    const st = this.db.prepare(sql.replace(/ledger\./g, ''));
    const rows = st.raw(true).all(...params) as unknown[][];
    return { columns: st.columns().map((c) => c.name), rows: rows.slice(0, limit), capped: rows.length > limit, estimate: rows.length > limit ? 12_000 : null };
  }

  async query(_c: unknown, text: string, opts: { limit: number }) {
    return this.run(`SELECT * FROM (${text.trim().replace(/;\s*$/, '')}) LIMIT ${opts.limit + 1}`, [], opts.limit);
  }

  async rows(object: string, opts: { watermarkColumn: string | null; after: string | null; limit: number }) {
    const wm = opts.watermarkColumn;
    return this.run(`SELECT * FROM ${object}${wm && opts.after != null ? ` WHERE ${wm} > ?` : ''}${wm ? ` ORDER BY ${wm}` : ''} LIMIT ${opts.limit + 1}`, wm && opts.after != null ? [opts.after] : [], opts.limit);
  }
}

describe('data connections', () => {
  let h: Harness;
  let ledger: Database.Database;
  let specs: ConnectionSpec[];
  let os: Server;
  let osUrl: string;
  let osRequests: { method: string; path: string; body: unknown; auth: string | undefined }[];

  beforeEach(async () => {
    ledger = new Database(':memory:');
    ledger.exec(`
      create table cost_centres (id integer primary key, cost_centre text, q3_actual numeric, q3_budget numeric, owner_email text, updated_at text);
      create table payroll_lines (id integer, amount numeric);
      create view v_cost_centres as select cost_centre, q3_actual, q3_budget from cost_centres;
      create view v_suppliers as select 'Contoso' as name, 'GB82 WEST 1234 5698 7654 32' as iban, 'ap@contoso.example' as contact_email, 'Paid 3 invoices' as note;
    `);
    const ins = ledger.prepare('insert into cost_centres (cost_centre, q3_actual, q3_budget, owner_email, updated_at) values (?, ?, ?, ?, ?)');
    for (let i = 0; i < 700; i++) ins.run(`CC-${String(i).padStart(4, '0')}`, 1000 + i, 1000, `owner${i}@northwind.example`, `2026-09-${String(10 + (i % 9)).padStart(2, '0')}T12:00:00Z`);
    specs = [];
    osRequests = [];
    os = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        osRequests.push({ method: req.method ?? '', path: req.url ?? '', body: raw ? JSON.parse(raw) : null, auth: req.headers.authorization });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/') return res.end(JSON.stringify({ version: { number: '2.17.0' } }));
        if (req.url === '/_cluster/health') return res.end(JSON.stringify({ status: 'yellow', unassigned_shards: 1 }));
        if (req.url === '/_mapping') return res.end(JSON.stringify({ 'gateway-logs-2026.09.19': { mappings: { properties: { '@timestamp': { type: 'date' }, level: { type: 'keyword' }, message: { type: 'text' }, actor: { type: 'keyword' } } } }, '.kibana': { mappings: {} } }));
        if (req.url === '/gateway-logs-*/_search') return res.end(JSON.stringify({ hits: { total: { value: 2 }, hits: [{ _id: '1', _source: { level: 'error', message: 'connection refused', actor: 'mokafor' } }, { _id: '2', _source: { level: 'error', message: 'route refused for jane@northwind.example' } }] } }));
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { reason: 'no such index' } }));
      });
    });
    await new Promise<void>((r) => os.listen(0, '127.0.0.1', r));
    osUrl = `http://127.0.0.1:${(os.address() as AddressInfo).port}`;
    h = await harnessWith({ drivers: { postgres: (spec) => (specs.push(spec), new SqliteDriver(ledger, spec)) } }, { OLLAMA_POLL_MS: '600000' });
  });
  afterEach(async () => {
    await h.close();
    ledger.close();
    os.closeAllConnections();
    await new Promise((r) => os.close(r));
  });

  async function admin(clearance: 'internal' | 'confidential' = 'confidential') {
    await localUser(h, 'connadmin', ['connection-admin', 'member'], clearance);
    const c = await loginAdmin(h, 'connadmin');
    const send = (m: 'post' | 'patch' | 'put' | 'delete', p: string, b: object = {}) => c.agent[m](p).set('x-csrf-token', c.csrf).send(b);
    return { ...c, post: (p: string, b?: object) => send('post', p, b), patch: (p: string, b?: object) => send('patch', p, b), put: (p: string, b?: object) => send('put', p, b), del: (p: string) => send('delete', p), get: (p: string) => c.agent.get(p) };
  }

  async function registerLedger(a: Awaited<ReturnType<typeof admin>>) {
    const conn = (await a.post('/api/admin/connections', { name: 'ledger-ro', engine: 'postgres', endpoint: 'pg-ledger.northwind.internal:5432', database: 'ledger', label: 'confidential', rowLimit: 500, username: 'ledger_ro', password: 'right' }).expect(201)).body;
    await a.post(`/api/admin/connections/${conn.id}/schema`).expect(200);
    await a.put(`/api/admin/connections/${conn.id}/allow-list`, { objects: ['ledger.v_cost_centres', 'ledger.v_suppliers', 'ledger.cost_centres'], piiColumns: [] }).expect(200);
    return conn;
  }

  it('registers with a sealed credential, tests, introspects and keeps an allow-list', async () => {
    const a = await admin();
    const conn = (await a.post('/api/admin/connections', { name: 'ledger-ro', engine: 'postgres', endpoint: 'pg-ledger.northwind.internal:5432', database: 'ledger', label: 'confidential', username: 'ledger_ro', password: 'wrong' }).expect(201)).body;
    expect(conn).toMatchObject({ name: 'ledger-ro', engine: 'postgres', account: 'ledger_ro', hasCredential: true, ops: 'read', rowLimit: 500, timeoutS: 10, health: 'unknown' });
    expect(JSON.stringify(conn)).not.toContain('wrong');
    const raw = await h.s.db('data_connections').where({ id: conn.id }).first();
    expect(raw.credential).toMatch(/^v2\./);
    expect(raw.credential).not.toContain('wrong');
    expect((await a.post(`/api/admin/connections/${conn.id}/test`).expect(200)).body).toMatchObject({ ok: false, health: 'unreachable' });
    await a.put(`/api/admin/connections/${conn.id}/credential`, { username: 'ledger_ro', password: 'right' }).expect(200);
    expect((await a.post(`/api/admin/connections/${conn.id}/test`).expect(200)).body).toMatchObject({ ok: true, health: 'healthy', readOnly: true });
    expect(specs.pop()).toMatchObject({ endpoint: 'pg-ledger.northwind.internal:5432', username: 'ledger_ro', password: 'right' });
    const schema = (await a.post(`/api/admin/connections/${conn.id}/schema`).expect(200)).body;
    expect(schema).toMatchObject({ objects: 4, allowed: 0, outside: 4 });
    await a.put(`/api/admin/connections/${conn.id}/allow-list`, { objects: ['ledger.nope'] }).expect(409);
    const saved = (await a.put(`/api/admin/connections/${conn.id}/allow-list`, { objects: ['ledger.v_cost_centres', 'ledger.v_suppliers'], piiColumns: ['ledger.v_suppliers.note'] }).expect(200)).body;
    const suppliers = saved.schema.find((o: { name: string }) => o.name === 'ledger.v_suppliers');
    expect(suppliers).toMatchObject({ allowed: true });
    expect(suppliers.columns.filter((c: { pii: boolean }) => c.pii).map((c: { name: string }) => c.name)).toEqual(['iban', 'contact_email', 'note']);
    await a.patch(`/api/admin/connections/${conn.id}`, { ops: 'write' }).expect(409);
    expect((await a.patch(`/api/admin/connections/${conn.id}`, { rowLimit: 200, timeoutS: 5 }).expect(200)).body).toMatchObject({ rowLimit: 200, timeoutS: 5, version: 4 });
    await a.post('/api/admin/connections', { name: 'm', engine: 'mysql', endpoint: 'x:3306' }).expect(409);
  });

  it('runs reads masked and capped, refuses writes, DDL and objects outside the allow-list, and audits all of it', async () => {
    const a = await admin();
    const conn = await registerLedger(a);
    const ok = (await a.post(`/api/admin/connections/${conn.id}/query`, { query: 'SELECT cost_centre, q3_actual, q3_budget FROM ledger.v_cost_centres WHERE q3_actual > q3_budget ORDER BY q3_actual DESC LIMIT 3;' }).expect(200)).body;
    expect(ok).toMatchObject({ columns: ['cost_centre', 'q3_actual', 'q3_budget'], capped: false, label: 'confidential', unparsed: false });
    expect(ok.rows[0]).toEqual(['CC-0699', 1699, 1000]);
    const masked = (await a.post(`/api/admin/connections/${conn.id}/query`, { query: 'SELECT name, iban, contact_email, note FROM ledger.v_suppliers' }).expect(200)).body;
    expect(masked.rows[0]).toEqual(['Contoso', '••••4 32', '••••mple', 'Paid 3 invoices']);
    expect(masked.masked.sort()).toEqual(['contact_email', 'iban']);
    const capped = (await a.post(`/api/admin/connections/${conn.id}/query`, { query: 'SELECT * FROM ledger.cost_centres ORDER BY cost_centre' }).expect(200)).body;
    expect(capped).toMatchObject({ capped: true, estimate: 12000 });
    expect(capped.rows).toHaveLength(500);
    expect(capped.masked).toContain('owner_email');

    const write = (await a.post(`/api/admin/connections/${conn.id}/query`, { query: "UPDATE ledger.v_cost_centres SET q3_budget = q3_actual WHERE cost_centre = 'LIS-ONBOARD';" }).expect(422)).body;
    expect(write).toMatchObject({ title: 'Write refused', kind: 'write', verb: 'UPDATE' });
    expect(write.detail).toMatch(/^An UPDATE was proposed on a read-only connection/);
    expect(write.trace_id).toBeTruthy();
    expect((await a.post(`/api/admin/connections/${conn.id}/query`, { query: 'DROP TABLE ledger.card_feed;' }).expect(422)).body).toMatchObject({ title: 'DDL refused', verb: 'DROP' });
    expect((await a.post(`/api/admin/connections/${conn.id}/query`, { query: 'SELECT * FROM ledger.payroll_lines LIMIT 10;' }).expect(422)).body).toMatchObject({ title: 'Object outside the allow-list', object: 'ledger.payroll_lines' });
    const unparsed = (await a.post(`/api/admin/connections/${conn.id}/query`, { query: 'SELECT cost_centre, q3_actual::vendor_money AS actual FROM ledger.v_cost_centres' }).expect(409)).body;
    expect(unparsed).toMatchObject({ title: 'Parser could not read it', kind: 'unparsed' });
    // SQLite ignores the cast; the point is that it runs only after confirmation
    const confirmed = (await a.post(`/api/admin/connections/${conn.id}/query`, { query: 'SELECT cost_centre FROM ledger.v_cost_centres WHERE $$x$$ IS NULL', confirmUnparsed: true })).body;
    expect(confirmed.title ?? 'ran').toMatch(/ran|Query failed/);
    expect(ledger.prepare('select count(*) n from cost_centres where q3_budget = q3_actual').get()).toEqual({ n: 1 }); // only CC-0000, as seeded

    const actions = (await h.s.db('audit_events').whereLike('action', 'connection.query%').orderBy('seq').select('action', 'detail')).map((x: { action: string; detail: string }) => ({ action: x.action, detail: JSON.parse(x.detail) }));
    expect(actions.map((x) => x.action)).toEqual(['connection.query', 'connection.query', 'connection.query', 'connection.query.refused', 'connection.query.refused', 'connection.query.refused', 'connection.query.refused', expect.stringMatching(/connection.query/)]);
    expect(actions[3]!.detail).toMatchObject({ kind: 'write', verb: 'UPDATE', query: expect.stringContaining('UPDATE ledger.v_cost_centres') });

    // export: CSV with the label and the masking
    const csv = await a.post(`/api/admin/connections/${conn.id}/export`, { query: 'SELECT name, iban FROM ledger.v_suppliers' }).expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['x-label']).toBe('confidential');
    expect(csv.text).toContain('# label: confidential');
    expect(csv.text).toContain('Contoso,••••4 32');
  });

  it('withholds queries on a connection above the caller\'s clearance', async () => {
    const a = await admin('internal');
    const conn = (await a.post('/api/admin/connections', { name: 'hr', engine: 'postgres', endpoint: 'pg-hr:5432', label: 'internal', username: 'u', password: 'right' }).expect(201)).body;
    await h.s.db('data_connections').where({ id: conn.id }).update({ label: 'restricted', allow_list: JSON.stringify(['ledger.v_cost_centres']) });
    const r = (await a.post(`/api/admin/connections/${conn.id}/query`, { query: 'SELECT * FROM ledger.v_cost_centres' }).expect(403)).body;
    expect(r.detail).toMatch(/queries and results are withheld/);
    await a.post('/api/admin/connections', { name: 'r', engine: 'postgres', endpoint: 'x:1', label: 'restricted' }).expect(403);
    const member = await client(h, 'plain', ['member']);
    await member.get('/api/admin/connections').expect(403);
  });

  it('queries OpenSearch with basic auth, refuses by-query writes, and masks personal data', async () => {
    const a = await admin();
    const conn = (await a.post('/api/admin/connections', { name: 'app-logs', engine: 'opensearch', endpoint: osUrl, label: 'internal', username: 'logs-reader', password: 'pw' }).expect(201)).body;
    expect((await a.post(`/api/admin/connections/${conn.id}/test`).expect(200)).body).toMatchObject({ ok: true, health: 'degraded', version: 'OpenSearch 2.17.0' });
    const schema = (await a.post(`/api/admin/connections/${conn.id}/schema`).expect(200)).body;
    expect(schema.connection.schema.map((o: { name: string }) => o.name)).toEqual(['gateway-logs-2026.09.19']);
    await a.put(`/api/admin/connections/${conn.id}/allow-list`, { objects: ['gateway-logs-*'] }).expect(200);
    const r = (await a.post(`/api/admin/connections/${conn.id}/query`, { query: '{ "size": 5000, "query": { "term": { "level": "error" } } }', object: 'gateway-logs-*' }).expect(200)).body;
    expect(r.columns).toEqual(['_id', 'level', 'message', 'actor']);
    expect(r.rows[0]).toEqual(['1', 'error', 'connection refused', '••••afor']);
    expect(r.rows[1][2]).toMatch(/^••••/);
    const sent = osRequests.find((x) => x.path === '/gateway-logs-*/_search')!;
    expect(sent.auth).toBe('Basic ' + Buffer.from('logs-reader:pw').toString('base64'));
    expect(sent.body).toMatchObject({ size: 500, track_total_hits: true });
    await a.post(`/api/admin/connections/${conn.id}/query`, { query: 'POST /gateway-logs-*/_delete_by_query\n{ "query": { "match_all": {} } }' }).expect(422);
    await a.post(`/api/admin/connections/${conn.id}/query`, { query: 'DELETE /gateway-logs-2026.09.19' }).expect(422);
    await a.post(`/api/admin/connections/${conn.id}/query`, { query: '{}', object: 'security-1' }).expect(422);
    expect(osRequests.some((x) => x.method === 'DELETE' || x.path.includes('_delete_by_query'))).toBe(false);
  });

  it('feeds a knowledge source from a view by watermark and refuses removal while it is used', async () => {
    const ollama = await new FakeOllama().start();
    try {
      await seedRetrieval(h, ollama);
      const a = await admin();
      const conn = await registerLedger(a);
      const curator = await client(h, 'cura', ['member', 'knowledge-curator'], 'confidential');
      const kb = (await curator.post('/api/knowledge/bases', { name: 'Finance KB', label: 'internal', embedModel: 'nomic-embed-text' }).expect(201)).body;
      // the source form lists the connection and its allow-listed objects, never the credential
      const listed = (await curator.get('/api/knowledge/connections').expect(200)).body;
      expect(listed).toEqual([{ id: conn.id, name: conn.name, label: conn.label, objects: expect.arrayContaining(['ledger.cost_centres']), columns: expect.objectContaining({ 'ledger.cost_centres': expect.arrayContaining(['updated_at']) }) }]);
      expect(JSON.stringify(listed)).not.toMatch(/password|credential/i);
      await (await client(h, 'plain', ['member'])).get('/api/knowledge/connections').expect(403);
      await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 'database', location: 'pg: ledger.payroll_lines', connectionId: conn.id }).expect(409);
      const src = (await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 'database', location: 'pg: ledger.cost_centres', connectionId: conn.id }).expect(201)).body;
      expect(src).toMatchObject({ location: 'pg: ledger.cost_centres', labelFloor: 'confidential', config: { object: 'ledger.cost_centres', idColumn: 'id', watermarkColumn: 'updated_at' } });
      await drain(h);
      const after = (await curator.get(`/api/knowledge/bases/${kb.id}`)).body.sources[0];
      expect(after).toMatchObject({ state: 'idle', documents: 700, watermark: '2026-09-18T12:00:00Z' });
      const hit = (await curator.post('/api/knowledge/search', { kbIds: [kb.id], query: 'CC-0042', rerank: false })).body.hits[0];
      expect(hit.text).toContain('cost_centre: CC-0042');
      expect(hit.text).toMatch(/owner_email: ••••/);
      expect(hit.label).toBe('confidential');
      // a new row after the watermark is picked up; nothing else is re-read
      ledger.prepare('insert into cost_centres (cost_centre, q3_actual, q3_budget, owner_email, updated_at) values (?, ?, ?, ?, ?)').run('CC-NEW', 5, 5, 'x@y.example', '2026-09-19T12:02:00Z');
      await a.post(`/api/admin/connections/${conn.id}/sync`).expect(202);
      await drain(h);
      const job = (await h.s.db('jobs').where({ type: 'knowledge.sync' }).orderBy('created_at', 'desc').first()) as { result: string };
      expect(JSON.parse(job.result)).toMatchObject({ added: 1, changed: 0, unchanged: 0 });
      const view = (await a.get(`/api/admin/connections/${conn.id}`).expect(200)).body;
      expect(view.syncs).toEqual([expect.objectContaining({ kb: 'Finance KB', object: 'ledger.cost_centres', docs: 701 })]);
      const refused = (await a.del(`/api/admin/connections/${conn.id}`).expect(409)).body;
      expect(refused.detail).toMatch(/Finance KB still syncs from ledger-ro/);
      await curator.del(`/api/knowledge/sources/${src.id}`).expect(200);
      await a.del(`/api/admin/connections/${conn.id}`).expect(204);
    } finally {
      await ollama.stop();
    }
  });
});
