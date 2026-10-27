/*
 * 1.8.0, Sprint 45 (B-125): saved, named, parameterised connection queries. Parameter binding (an injection attempt
 * stays data), classification refusing a write, masking, the db-query guardrail, clearance, versions, the read API,
 * the built-in tool `connections.query`, a workflow tool step, the knowledge source of kind `saved-query`, and an app
 * lookup over a query column. The outside databases are SQLite stand-ins that bind parameters as the real drivers do.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Label } from '../src/authz/labels.js';
import type { Principal } from '../src/authz/policy.js';
import type { Classification } from '../src/connections/classify.js';
import type { ConnectionSpec, DataDriver, QueryResult } from '../src/connections/drivers.js';
import { bindParams, paramProblems } from '../src/connections/params.js';
import { renderJson, renderSql, sqlPieces } from '../src/connections/saved-queries.js';
import { loadPrincipal } from '../src/http/middleware.js';
import type { WfGraph, WfNode } from '../src/workflows/graph.js';
import { FakeOllama } from './fake-ollama.js';
import { type Harness, localUser, loginAdmin } from './helpers.js';
import { client, drain, harnessWith, seedRetrieval } from './retrieval-seed.js';

/** PostgreSQL (`$n`) or MySQL (`?`) placeholders bound by SQLite, the way the drivers send them: apart from the text. */
class BindingDriver implements DataDriver {
  readonly sent: { text: string; params: unknown[] }[] = [];
  constructor(
    private readonly db: Database.Database,
    readonly spec: ConnectionSpec
  ) {}
  private prefix() {
    return this.spec.engine === 'mysql' ? `${this.spec.database}.` : 'public.';
  }
  async test() {
    return { version: 'SQLite', readOnly: true, health: 'healthy' as const, detail: 'read-only' };
  }
  async introspect() {
    const objs = this.db.prepare("select name, type from sqlite_master where type in ('table','view') and name not like 'sqlite_%' order by name").all() as { name: string; type: string }[];
    return objs.map((o) => ({ name: `${this.prefix()}${o.name}`, kind: o.type === 'view' ? ('view' as const) : ('table' as const), columns: (this.db.prepare(`pragma table_info("${o.name}")`).all() as { name: string; type: string }[]).map((c) => ({ name: c.name, type: c.type.toLowerCase() })) }));
  }
  async query(_c: Classification, text: string, opts: { limit: number; params?: unknown[]; offset?: number }): Promise<QueryResult> {
    this.sent.push({ text, params: opts.params ?? [] });
    let sql = text.trim().replace(/;\s*$/, '').split(this.prefix()).join('');
    let values = opts.params ?? [];
    if (this.spec.engine === 'postgres') {
      const order: unknown[] = [];
      sql = sql.replace(/\$(\d+)/g, (_m, n: string) => {
        order.push(values[Number(n) - 1]);
        return '?';
      });
      values = order;
    }
    const st = this.db.prepare(`SELECT * FROM (${sql}) LIMIT ${opts.limit + 1}${opts.offset ? ` OFFSET ${opts.offset}` : ''}`);
    const rows = st.raw(true).all(...values.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v))) as unknown[][];
    return { columns: st.columns().map((c) => c.name), rows: rows.slice(0, opts.limit), capped: rows.length > opts.limit, estimate: null };
  }
  async rows(): Promise<QueryResult> {
    throw new Error('not used');
  }
}

const trigger = (output?: WfNode['output']): WfNode => ({ id: 'trigger', kind: 'trigger', title: 'Trigger', x: 20, y: 20, config: { source: 'api' }, ...(output ? { output } : {}) });
const node = (id: string, kind: string, config: Record<string, unknown>): WfNode => ({ id, kind: kind as WfNode['kind'], title: id, x: 200, y: 20, config });
const chain = (nodes: WfNode[]): WfGraph => ({ nodes, edges: nodes.slice(1).map((n, i) => ({ from: nodes[i]!.id, to: n.id })), limits: {} });

describe('parameters and placeholders', () => {
  it('types, checks and binds parameters; placeholders become driver placeholders, never text', () => {
    const defs = [
      { name: 'tier', type: 'string' as const, required: true, allowed: ['gold', 'silver'] },
      { name: 'min', type: 'number' as const, required: false, default: 0, min: 0, max: 1000 },
      { name: 'ids', type: 'list' as const, required: false, itemType: 'number' as const },
      { name: 'sort', type: 'identifier' as const, required: false, default: 'name', allowed: ['name', 'balance'] }
    ];
    expect(paramProblems(defs)).toEqual([]);
    expect(paramProblems([{ name: 'x', type: 'identifier', required: false }])).toEqual([expect.stringMatching(/lists the names/)]);
    expect(bindParams(defs, { tier: 'gold', ids: '1, 2' })).toEqual({ tier: 'gold', min: 0, ids: [1, 2], sort: 'name' });
    expect(() => bindParams(defs, {})).toThrow(/tier is required/);
    expect(() => bindParams(defs, { tier: 'bronze' })).toThrow(/tier should be one of gold, silver/);
    expect(() => bindParams(defs, { tier: 'gold', min: 5000 })).toThrow(/min is above 1000/);
    expect(() => bindParams(defs, { tier: 'gold', sort: 'name; drop table x' })).toThrow(/sort should be one of name, balance/);
    expect(() => bindParams(defs, { tier: 'gold', nope: 1 })).toThrow(/nope is not a parameter/);

    const names = new Set(['tier', 'ids', 'sort']);
    const sql = "SELECT id, name FROM customers WHERE tier = :tier AND note <> ':tier' AND id IN (:ids) AND x::text = 'a' -- :nothing\nORDER BY :sort";
    const pg = sqlPieces(sql, 'postgres', names);
    expect([...pg.used].sort()).toEqual(['ids', 'sort', 'tier']);
    const values = { tier: "gold' OR '1'='1", ids: [1, 2], sort: 'name' };
    expect(renderSql(pg.pieces, 'postgres', defs, values)).toEqual({ text: `SELECT id, name FROM customers WHERE tier = $1 AND note <> ':tier' AND id IN ($2) AND x::text = 'a' -- :nothing\nORDER BY "name"`, params: ["gold' OR '1'='1", [1, 2]] });
    const my = renderSql(sqlPieces(sql, 'mysql', names).pieces, 'mysql', defs, values);
    expect(my.text).toContain('tier = ? AND');
    expect(my.text).toContain('id IN (?, ?)');
    expect(my.text).toContain('ORDER BY `name`');
    expect(my.params).toEqual(["gold' OR '1'='1", 1, 2]);
    expect(() => sqlPieces('SELECT 1 FROM t WHERE a = :typo', 'postgres', names)).toThrow(/:typo, which is not one of its parameters/);
    // JSON queries take a value where {"$param"} stands; a value never becomes structure.
    expect(renderJson('POST /logs-*/_search\n{"query":{"term":{"level":{"$param":"tier"}}}}', { tier: '{"$where":"x"}' })).toBe('POST /logs-*/_search\n{"query":{"term":{"level":"{\\"$where\\":\\"x\\"}"}}}');
  });
});

describe('saved connection queries (B-125)', () => {
  let h: Harness;
  let crm: Database.Database;
  let drivers: BindingDriver[];

  beforeEach(async () => {
    crm = new Database(':memory:');
    crm.exec(`
      create table customers (id integer primary key, name text, email text, tier text, balance real);
      create table secrets (id integer primary key, token text);
    `);
    const ins = crm.prepare('insert into customers (name, email, tier, balance) values (?, ?, ?, ?)');
    ins.run('Contoso', 'ap@contoso.example', 'gold', 120.5);
    ins.run('Fabrikam', 'ops@fabrikam.example', 'silver', 10);
    ins.run('Northwind', 'buy@northwind.example', 'gold', 75);
    for (let i = 0; i < 30; i++) ins.run(`Bulk ${i}`, null, 'bronze', i);
    drivers = [];
    const make = (spec: ConnectionSpec) => {
      const d = new BindingDriver(crm, spec);
      drivers.push(d);
      return d;
    };
    h = await harnessWith({ drivers: { postgres: make, mysql: make } }, { OLLAMA_POLL_MS: '600000' });
  });
  afterEach(async () => {
    await h.close();
    crm.close();
  });

  async function admin(name = 'connadmin', clearance: Label = 'confidential', roles = ['connection-admin', 'member']) {
    await localUser(h, name, roles, clearance);
    const c = await loginAdmin(h, name);
    const send = (m: 'post' | 'patch' | 'put' | 'delete', p: string, b: object = {}) => c.agent[m](p).set('x-csrf-token', c.csrf).send(b);
    return { ...c, post: (p: string, b?: object) => send('post', p, b), patch: (p: string, b?: object) => send('patch', p, b), put: (p: string, b?: object) => send('put', p, b), del: (p: string) => send('delete', p), get: (p: string) => c.agent.get(p) };
  }
  type Admin = Awaited<ReturnType<typeof admin>>;

  async function connection(a: Admin, engine: 'postgres' | 'mysql' = 'postgres', label: Label = 'internal') {
    const conn = (await a.post('/api/admin/connections', { name: `crm-${engine}`, engine, endpoint: 'crm.internal:5432', database: 'crm', label, username: 'reader', password: 'right' }).expect(201)).body as { id: string };
    await a.post(`/api/admin/connections/${conn.id}/schema`).expect(200);
    const prefix = engine === 'mysql' ? 'crm.' : 'public.';
    await a.put(`/api/admin/connections/${conn.id}/allow-list`, { objects: [`${prefix}customers`] }).expect(200);
    return conn;
  }

  const BY_TIER = {
    name: 'by-tier',
    title: 'Customers by tier',
    label: 'internal',
    definition: {
      text: 'SELECT id, name, email, tier, balance FROM customers WHERE tier = :tier ORDER BY :sort',
      params: [
        { name: 'tier', type: 'string', required: true },
        { name: 'sort', type: 'identifier', default: 'id', allowed: ['id', 'name', 'balance'] }
      ],
      rowLimit: 10
    }
  };

  async function published(a: Admin, connId: string, body: object = BY_TIER) {
    const q = (await a.post(`/api/admin/connections/${connId}/queries`, body).expect(201)).body as { id: string; name: string };
    await a.post(`/api/admin/connection-queries/${q.id}/publish`, { note: 'first' }).expect(200);
    return q;
  }

  const principal = async (name: string) => (await loadPrincipal(h.s, h.tenantId, (await h.s.db('users').where({ tenant_id: h.tenantId, username: name }).first('id')).id, {}))!;

  it('binds parameters (an injection attempt stays data), masks, pages, and audits every run', async () => {
    const a = await admin();
    const conn = await connection(a);
    const q = await published(a, conn.id);
    const run = (body: object) => a.post(`/api/connection-queries/${q.id}/run`, body);
    const gold = (await run({ params: { tier: 'gold', sort: 'name' } }).expect(200)).body;
    expect(gold.columns).toEqual([{ name: 'id', type: 'number' }, { name: 'name', type: 'string' }, { name: 'email', type: 'string' }, { name: 'tier', type: 'string' }, { name: 'balance', type: 'number' }]);
    expect(gold.rows.map((r: { name: string }) => r.name)).toEqual(['Contoso', 'Northwind']);
    expect(gold).toMatchObject({ truncated: false, label: 'internal', masked: ['email'] });
    expect(gold.rows[0].email).toMatch(/^••••/);
    // The value travelled apart from the text; the text holds only the placeholder and the quoted identifier.
    const last = drivers.at(-1)!.sent.at(-1)!;
    expect(last.text).toBe('SELECT id, name, email, tier, balance FROM customers WHERE tier = $1 ORDER BY "name"');
    expect(last.params).toEqual(['gold']);
    // Injection attempts are data: no rows, and the table is untouched.
    for (const evil of ["gold' OR '1'='1", "x'; DROP TABLE customers; --", '1 OR 1=1']) {
      expect((await run({ params: { tier: evil } }).expect(200)).body.rows).toEqual([]);
    }
    expect((crm.prepare('select count(*) n from customers').get() as { n: number }).n).toBe(33);
    // An identifier outside its list, an unknown or missing parameter: 400 naming it.
    expect((await run({ params: { tier: 'gold', sort: 'name; DROP TABLE customers' } }).expect(400)).body.detail).toMatch(/sort should be one of id, name, balance/);
    expect((await run({ params: {} }).expect(400)).body.detail).toMatch(/tier is required/);
    // Paging: the query's row limit is the page; a cursor goes on.
    const p1 = (await run({ params: { tier: 'bronze' } }).expect(200)).body;
    expect(p1.rows).toHaveLength(10);
    expect(p1.truncated).toBe(true);
    const p2 = (await run({ params: { tier: 'bronze' }, cursor: p1.nextCursor }).expect(200)).body;
    expect(p2.rows[0].name).toBe('Bulk 10');
    const small = (await run({ params: { tier: 'bronze' }, limit: 3 }).expect(200)).body;
    expect(small.rows).toHaveLength(3);
    const audits = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).whereLike('action', 'connection.query.%').select('action')) as { action: string }[];
    expect(audits.map((x) => x.action)).toEqual(expect.arrayContaining(['connection.query.created', 'connection.query.published', 'connection.query.run']));
    expect(audits.filter((x) => x.action === 'connection.query.run').length).toBeGreaterThanOrEqual(7);
  });

  it('classifies once when saved: refuses writes, DDL, objects outside the allow-list and unused parameters; a write query is saved but never runs', async () => {
    const a = await admin();
    const conn = await connection(a);
    const save = (name: string, text: string, extra: object = {}, params: object[] = []) => a.post(`/api/admin/connections/${conn.id}/queries`, { name, label: 'internal', definition: { text, params }, ...extra });
    const w = (await save('wipe', 'DELETE FROM customers WHERE id = :id', {}, [{ name: 'id', type: 'number', required: true }]).expect(422)).body;
    expect(w).toMatchObject({ title: 'Write refused', kind: 'write', verb: 'DELETE' });
    expect((await save('drop', 'DROP TABLE customers').expect(422)).body.title).toBe('DDL refused');
    expect((await save('two', 'SELECT 1 FROM customers; SELECT 2 FROM customers').expect(422)).body.title).toBe('Several statements refused');
    expect((await save('peek', 'SELECT * FROM secrets').expect(422)).body.title).toBe('Object outside the allow-list');
    expect((await save('unused', 'SELECT * FROM customers', {}, [{ name: 'tier', type: 'string' }]).expect(400)).body.detail).toMatch(/tier is not used/);
    // An identifier is classified with every name it may stand for.
    expect((await save('sneaky', 'SELECT * FROM :t', {}, [{ name: 't', type: 'identifier', allowed: ['customers', 'secrets'] }]).expect(422)).body.title).toBe('Object outside the allow-list');
    // A write query, explicitly marked by a connections manager: saved, published, never run.
    const wq = (await save('fix-tier', 'UPDATE customers SET tier = :tier WHERE id = :id', { write: true }, [{ name: 'tier', type: 'string', required: true }, { name: 'id', type: 'number', required: true }]).expect(201)).body;
    expect(wq).toMatchObject({ write: true, lookups: false, draftClassification: { kind: 'write', verb: 'UPDATE' } });
    await a.post(`/api/admin/connection-queries/${wq.id}/publish`, {}).expect(200);
    expect((await a.post(`/api/connection-queries/${wq.id}/run`, { params: { tier: 'gold', id: 2 } }).expect(409)).body.detail).toMatch(/write query/);
    expect((crm.prepare('select tier from customers where id = 2').get() as { tier: string }).tier).toBe('silver');
    expect(drivers.flatMap((d) => d.sent).some((s) => /UPDATE/.test(s.text))).toBe(false);
    // Marking a read as a write is refused too.
    expect((await save('readw', 'SELECT * FROM customers', { write: true }).expect(422)).body.title).toBe('Not a write query');
    // The allow-list is checked again at each run: narrowed after publishing, the run is refused.
    const q = await published(a, conn.id);
    await a.put(`/api/admin/connections/${conn.id}/allow-list`, { objects: [] }).expect(200);
    expect((await a.post(`/api/connection-queries/${q.id}/run`, { params: { tier: 'gold' } }).expect(422)).body.title).toBe('Object outside the allow-list');
    expect(await h.s.db('audit_events').where({ action: 'connection.query.run.refused' }).first()).toBeTruthy();
  });

  it('versions: draft and published, the test panel runs the draft, a run uses the published version', async () => {
    const a = await admin();
    const conn = await connection(a);
    const q = (await a.post(`/api/admin/connections/${conn.id}/queries`, BY_TIER).expect(201)).body;
    expect(q).toMatchObject({ draftRev: 1, publishedVersion: null, versions: [] });
    await a.post(`/api/connection-queries/${q.id}/run`, { params: { tier: 'gold' } }).expect(409); // nothing published yet
    const test = (await a.post(`/api/admin/connection-queries/${q.id}/test`, { params: { tier: 'silver' } }).expect(200)).body;
    expect(test).toMatchObject({ version: 'draft', classification: { kind: 'read', objects: ['customers'] } });
    expect(test.rows.map((r: { name: string }) => r.name)).toEqual(['Fabrikam']);
    const v1 = (await a.post(`/api/admin/connection-queries/${q.id}/publish`, {}).expect(200)).body;
    expect(v1).toMatchObject({ version: 1, query: { publishedVersion: 1, dirty: false } });
    await a.post(`/api/admin/connection-queries/${q.id}/publish`, {}).expect(409); // nothing changed
    // A stale revision is refused; a new draft is not what runs until it is published.
    await a.put(`/api/admin/connection-queries/${q.id}`, { rev: 7, title: 'x' }).expect(409);
    const d2 = (await a.put(`/api/admin/connection-queries/${q.id}`, { rev: 1, definition: { ...BY_TIER.definition, text: 'SELECT id, name, tier FROM customers WHERE tier = :tier ORDER BY :sort' } }).expect(200)).body;
    expect(d2).toMatchObject({ draftRev: 2, dirty: true });
    expect(Object.keys((await a.post(`/api/connection-queries/${q.id}/run`, { params: { tier: 'gold' } }).expect(200)).body.rows[0])).toContain('email');
    const v2 = (await a.post(`/api/admin/connection-queries/${q.id}/publish`, { note: 'no email' }).expect(200)).body;
    expect(v2.query.versions.map((v: { version: number; state: string }) => [v.version, v.state])).toEqual([[2, 'published'], [1, 'retired']]);
    expect(Object.keys((await a.post(`/api/connection-queries/${q.id}/run`, { params: { tier: 'gold' } }).expect(200)).body.rows[0])).not.toContain('email');
    // The test panel can still run version 1.
    expect(Object.keys((await a.post(`/api/admin/connection-queries/${q.id}/test`, { version: 1, params: { tier: 'gold' } }).expect(200)).body.rows[0])).toContain('email');
    // A cursor from another version is refused.
    const page = (await a.post(`/api/admin/connection-queries/${q.id}/test`, { version: 'published', params: { tier: 'gold' }, limit: 1 }).expect(200)).body;
    expect(page.truncated).toBe(true);
    await a.del(`/api/admin/connection-queries/${q.id}`).expect(204);
    expect(await h.s.db('connection_query_versions').where({ query_id: q.id }).first()).toBeUndefined();
    expect(await h.s.db('audit_events').where({ action: 'connection.query.removed' }).first()).toBeTruthy();
  });

  it('the db-query guardrail sees the query and its parameter values on every run', async () => {
    const a = await admin();
    const conn = await connection(a);
    const q = await published(a, conn.id);
    await localUser(h, 'ga', ['guardrail-admin'], 'confidential');
    const ga = await loginAdmin(h, 'ga');
    const set = (await ga.agent.post('/api/admin/guardrails/sets').set('x-csrf-token', ga.csrf).send({ name: 'Queries', scope: 'tenant' }).expect(201)).body;
    await ga.agent.put(`/api/admin/guardrails/sets/${set.id}/draft`).set('x-csrf-token', ga.csrf).send({ rules: [{ id: 'no-northwind', name: 'Not about Northwind', checkpoint: 'db-query', type: 'pattern', mechanism: { kind: 'pattern', pattern: '(?i)northwind' }, action: 'block', stage: 'enforce' }] }).expect(200);
    await ga.agent.post(`/api/admin/guardrails/sets/${set.id}/draft/publish`).set('x-csrf-token', ga.csrf).expect(200);
    await a.post(`/api/connection-queries/${q.id}/run`, { params: { tier: 'gold' } }).expect(200);
    const blocked = (await a.post(`/api/connection-queries/${q.id}/run`, { params: { tier: 'Northwind' } }).expect(403)).body;
    expect(blocked).toMatchObject({ title: 'Blocked by a guardrail', checkpoint: 'db-query' });
    expect(await h.s.db('audit_events').where({ action: 'connection.query.run.refused' }).first()).toBeTruthy();
  });

  it('clearance and permissions: the read right runs, design is connections:manage, a query above clearance does not exist', async () => {
    const a = await admin();
    const conn = await connection(a);
    const q = await published(a, conn.id);
    const secret = await published(a, conn.id, { ...BY_TIER, name: 'by-tier-conf', label: 'confidential' });
    // A query is labelled at least its connection's label.
    const conf = await connection(a, 'mysql', 'confidential');
    expect((await a.post(`/api/admin/connections/${conf.id}/queries`, { ...BY_TIER, name: 'low', label: 'internal' }).expect(409)).body.detail).toMatch(/labelled at least/);
    const runner = await client(h, 'runner', ['member', 'knowledge-curator'], 'internal');
    expect((await runner.get('/api/connection-queries').expect(200)).body.map((x: { name: string }) => x.name)).toEqual(['by-tier']);
    await runner.post(`/api/connection-queries/${q.id}/run`, { params: { tier: 'gold' } }).expect(200);
    await runner.post(`/api/connection-queries/${secret.id}/run`, { params: { tier: 'gold' } }).expect(404);
    await runner.post(`/api/admin/connections/${conn.id}/queries`, { ...BY_TIER, name: 'mine' }).expect(403);
    await runner.post(`/api/admin/connection-queries/${q.id}/publish`, {}).expect(403);
    const plain = await client(h, 'plain', ['member'], 'confidential');
    await plain.post(`/api/connection-queries/${q.id}/run`, { params: { tier: 'gold' } }).expect(403);
    // The service function Agent 2's import calls enforces the same rights.
    await expect(h.s.savedQueries.run(await principal('plain'), q.id, { tier: 'gold' })).rejects.toMatchObject({ status: 403 });
    await expect(h.s.savedQueries.run(await principal('runner'), secret.id, { tier: 'gold' })).rejects.toMatchObject({ status: 404 });
    const out = await h.s.savedQueries.run(await principal('runner'), 'by-tier', { tier: 'gold' }, { limit: 1 });
    expect(out).toMatchObject({ truncated: true, nextCursor: expect.any(String), columns: expect.arrayContaining([{ name: 'name', type: 'string' }]) });
    // A designer above clearance cannot create one.
    expect((await a.post(`/api/admin/connections/${conn.id}/queries`, { ...BY_TIER, name: 'top', label: 'restricted' }).expect(403)).body.step).toBe('clearance');
  });

  it('lists over MySQL bind one placeholder per item', async () => {
    const a = await admin();
    const conn = await connection(a, 'mysql');
    const q = await published(a, conn.id, { name: 'some', label: 'internal', definition: { text: 'SELECT name FROM customers WHERE id IN (:ids) ORDER BY id', params: [{ name: 'ids', type: 'list', itemType: 'number', required: true, maxItems: 5 }] } });
    expect((await a.post(`/api/connection-queries/${q.id}/run`, { params: { ids: [1, 3] } }).expect(200)).body.rows).toEqual([{ name: 'Contoso' }, { name: 'Northwind' }]);
    expect(drivers.at(-1)!.sent.at(-1)).toEqual({ text: 'SELECT name FROM customers WHERE id IN (?, ?) ORDER BY id', params: [1, 3] });
    await a.post(`/api/connection-queries/${q.id}/run`, { params: { ids: [1, 2, 3, 4, 5, 6] } }).expect(400);
    await a.post(`/api/connection-queries/${q.id}/run`, { params: { ids: ['1) OR (1=1'] } }).expect(400);
  });

  it('the tool connections.query: read-only, as the caller, never above the label of the call; and as a workflow tool step', async () => {
    const a = await admin('designer', 'confidential', ['connection-admin', 'workflow-admin', 'member']);
    const conn = await connection(a);
    await published(a, conn.id);
    await published(a, conn.id, { ...BY_TIER, name: 'by-tier-conf', label: 'confidential' });
    const entry = (await h.s.db('registry_entries').where({ name: 'connections.query' }).first()) as { side_effect: string; status: string; tenant_id: string | null; impl: string };
    expect(entry).toMatchObject({ side_effect: 'read', status: 'published', tenant_id: null, impl: 'builtin' });
    const p = await principal('designer');
    const call = async (as: Principal, args: Record<string, unknown>, label: Label = 'internal') => {
      const { tools } = await h.s.tools.resolve(as, ['connections.query'], label);
      return h.s.tools.call({ principal: as, label, approved: false, source: { kind: 'agent-run', id: 'R1' } }, tools[0]!, args);
    };
    const ok = await call(p, { query: 'by-tier', params: { tier: 'silver' } });
    expect(ok.ok).toBe(true);
    expect(ok.result).toMatchObject({ rows: [{ name: 'Fabrikam', tier: 'silver' }], truncated: false, label: 'internal' });
    // A confidential query from an internal conversation is refused, even for someone cleared for it.
    const low = await call(p, { query: 'by-tier-conf', params: { tier: 'gold' } });
    expect(low.ok).toBe(false);
    expect(String(low.error)).toMatch(/label ceiling|may read/);
    expect((await call(p, { query: 'by-tier-conf', params: { tier: 'gold' } }, 'confidential')).ok).toBe(true);
    const wrong = await call(p, { query: 'by-tier', params: { tier: 'gold', sort: 'nope' } });
    expect(wrong.ok).toBe(false);
    expect(String(wrong.error)).toMatch(/sort should be one of/);
    // Without connections:query the call is refused.
    await localUser(h, 'aud', ['auditor'], 'internal');
    const auditor = await principal('aud');
    const r = await h.s.tools.resolve(auditor, ['connections.query'], 'internal');
    if (r.tools[0]) expect((await h.s.tools.call({ principal: auditor, label: 'internal', approved: false, source: { kind: 'agent-run', id: 'R1' } }, r.tools[0], { query: 'by-tier', params: { tier: 'gold' } })).ok).toBe(false);
    else expect(r.tools).toEqual([]);

    // A workflow tool step through the same tool.
    const input = { type: 'object' as const, properties: { tier: { type: 'string' as const } }, required: ['tier'] };
    const g = chain([trigger(input), node('q', 'tool', { tool: 'connections.query', args: { query: 'by-tier', params: '{{input}}' } }), node('out', 'transform', { fields: { first: '{{steps.q.rows.0.name}}', count: '{{steps.q.truncated}}' } })]);
    const w = await h.s.workflows.create(p, { name: 'gold-customers', label: 'internal', graph: g });
    await h.s.workflows.publish(p, w.id, null);
    const run = await h.s.workflows.start(p, w.id, { input: { tier: 'gold' }, dry: false });
    await drain(h);
    expect(await h.s.db('workflow_runs').where({ id: run.id }).first('state', 'error')).toMatchObject({ state: 'succeeded' });
    const steps = ((await h.s.workflows.runView(p, run.id)) as unknown as { steps: { nodeId: string; output: Record<string, unknown> }[] }).steps;
    expect(steps.find((s) => s.nodeId === 'out')!.output).toMatchObject({ first: 'Contoso' });
    const ran = (await h.s.db('audit_events').where({ action: 'connection.query.run' }).select('detail')) as { detail: string }[];
    expect(ran.some((x) => /workflow-step/.test(x.detail))).toBe(true);
  });

  it('a knowledge source of kind saved-query: rows become documents on sync; changed rows re-index', async () => {
    const ollama = await new FakeOllama().start();
    try {
      await seedRetrieval(h, ollama);
      const a = await admin();
      const conn = await connection(a);
      const q = await published(a, conn.id);
      const curator = await client(h, 'cura', ['member', 'knowledge-curator'], 'confidential');
      const kb = (await curator.post('/api/knowledge/bases', { name: 'Accounts', label: 'internal', embedModel: 'nomic-embed-text' }).expect(201)).body;
      await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 'saved-query', queryId: q.id, params: { tier: 'nope', extra: 1 } }).expect(400);
      const src = (await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 'saved-query', queryId: q.id, params: { tier: 'gold' }, idField: 'id', titleField: 'name' }).expect(201)).body;
      expect(src).toMatchObject({ kind: 'saved-query', location: 'query: by-tier', labelFloor: 'internal' });
      await drain(h);
      const after = (await curator.get(`/api/knowledge/bases/${kb.id}`)).body.sources[0];
      expect(after).toMatchObject({ state: 'idle', documents: 2 });
      const hit = (await curator.post('/api/knowledge/search', { kbIds: [kb.id], query: 'Northwind', rerank: false })).body.hits[0];
      expect(hit.text).toContain('name: Northwind');
      expect(hit.text).toMatch(/email: ••••/);
      crm.prepare("update customers set balance = 999 where name = 'Contoso'").run();
      await curator.post(`/api/knowledge/sources/${src.id}/sync`).expect(202);
      await drain(h);
      const job = (await h.s.db('jobs').where({ type: 'knowledge.sync' }).orderBy('created_at', 'desc').first()) as { result: string };
      expect(JSON.parse(job.result)).toMatchObject({ added: 0, changed: 1, unchanged: 1 });
      // The query cannot be removed while the source reads it, nor its connection while the query exists.
      expect((await a.del(`/api/admin/connection-queries/${q.id}`).expect(409)).body.usedBy).toEqual([expect.objectContaining({ kind: 'knowledge-source' })]);
      expect((await a.del(`/api/admin/connections/${conn.id}`).expect(409)).body.detail).toMatch(/saved queries/);
    } finally {
      await ollama.stop();
    }
  });

  it('an app lookup takes its options from a query column, within the entity label, and refuses other values', async () => {
    const a = await admin('designer', 'confidential', ['connection-admin', 'workflow-admin', 'member']);
    const conn = await connection(a);
    const lookupQ = { name: 'tiers', label: 'internal', lookups: true, definition: { text: 'SELECT name, tier FROM customers WHERE balance >= :min ORDER BY name', params: [{ name: 'min', type: 'number', default: 50 }] } };
    await published(a, conn.id, lookupQ);
    await published(a, conn.id, { ...lookupQ, name: 'not-offered', lookups: false });
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Sales', 'confidential')).id;
    await h.s.tenants.addMember(ws, (await h.s.db('users').where({ username: 'designer' }).first('id')).id);
    await a.put('/api/me/workspace', { workspaceId: ws }).expect(200);
    await a.post('/api/apps', { name: 'crm', label: 'internal', workspaceId: ws }).expect(201);
    await a.post('/api/apps/crm/entities', { name: 'deal', definition: { fields: [{ name: 'title', type: 'string', required: true }, { name: 'customer', type: 'lookup', source: 'query', query: 'tiers', valueField: 'name', labelField: 'name', params: { min: 50 } }, { name: 'other', type: 'lookup', source: 'query', query: 'not-offered', valueField: 'name' }] } }).expect(201);
    const opts = (await a.get('/api/apps/crm/entities/deal/fields/customer/options').expect(200)).body;
    expect((opts.options ?? opts).map((o: { value: string }) => o.value)).toEqual(['Contoso', 'Northwind']);
    const filtered = (await a.get('/api/apps/crm/entities/deal/fields/customer/options?q=north').expect(200)).body;
    expect((filtered.options ?? filtered).map((o: { value: string }) => o.value)).toEqual(['Northwind']);
    await a.post('/api/apps/crm/entities/deal/records', { values: { title: 'Renewal', customer: 'Northwind' } }).expect(201);
    const refused = (await a.post('/api/apps/crm/entities/deal/records', { values: { title: 'Bad', customer: 'Fabrikam' } }).expect(400)).body;
    expect(JSON.stringify(refused)).toMatch(/customer/);
    const notOffered = (await a.post('/api/apps/crm/entities/deal/records', { values: { title: 'X', other: 'Contoso' } }).expect(400)).body;
    expect(JSON.stringify(notOffered)).toMatch(/not offered to app lookups/);
    expect(await h.s.db('audit_events').where({ action: 'connection.query.run' }).whereLike('detail', '%lookup%').first()).toBeTruthy();
  });
});
