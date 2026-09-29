/*
 * Sprint 6 paths on a real PostgreSQL (TEST_PG_URL): the migration, knowledge indexing and hybrid search with the
 * vector store the database offers (pgvector when the extension is installed, the table scan otherwise), and the
 * PostgreSQL connection driver: a read-only account, introspection, row caps with the planner's estimate, the
 * read-only transaction refusing a write the parser could not see, the statement timeout, and a view as a
 * knowledge source synced by watermark.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices, type Services } from '../../src/services.js';
import { bootstrap } from '../../src/bootstrap.js';
import { createApp } from '../../src/http/app.js';
import { LazyVectorStore } from '../../src/platform/vectors.js';
import { FakeOllama } from '../fake-ollama.js';
import { loginAdmin, localUser, testConfig, type Harness } from '../helpers.js';
import { client, drain, seedRetrieval } from '../retrieval-seed.js';

const PG = process.env.TEST_PG_URL;

describe.skipIf(!PG)('knowledge and connections on PostgreSQL', () => {
  let s: Services;
  let h: Harness;
  let ollama: FakeOllama;
  let admin: pg.Client;
  const url = new URL(PG ?? 'postgres://x@localhost/x');

  beforeAll(async () => {
    const cfg = testConfig({ DB_CLIENT: 'pg', DATABASE_URL: PG!, OLLAMA_POLL_MS: '600000' });
    const db = createDb(cfg);
    await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
    await migrate(db);
    s = createServices(cfg, db, createLogger('silent', false), new Metrics());
    await bootstrap(s);
    h = { s, app: createApp(s), tenantId: (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!.id, close: async () => undefined };
    ollama = await new FakeOllama().start();
    admin = new pg.Client({ connectionString: PG });
    await admin.connect();
    await admin.query(`
      DROP SCHEMA IF EXISTS exprsn_it CASCADE;
      CREATE SCHEMA exprsn_it;
      CREATE TABLE exprsn_it.cost_centres (id serial PRIMARY KEY, cost_centre text, q3_actual numeric, q3_budget numeric, owner_email text, updated_at timestamptz);
      INSERT INTO exprsn_it.cost_centres (cost_centre, q3_actual, q3_budget, owner_email, updated_at)
        SELECT 'CC-' || lpad(g::text, 4, '0'), 1000 + g, 1000, 'owner' || g || '@northwind.example', timestamptz '2026-09-10 12:00:00+00' + (g || ' minutes')::interval FROM generate_series(1, 700) g;
      ANALYZE exprsn_it.cost_centres;
      CREATE VIEW exprsn_it.v_cost_centres AS SELECT id, cost_centre, q3_actual, q3_budget, owner_email, updated_at FROM exprsn_it.cost_centres;
      CREATE TABLE exprsn_it.audit_touch (n int);
      CREATE FUNCTION exprsn_it.touch() RETURNS int LANGUAGE sql AS 'INSERT INTO exprsn_it.audit_touch VALUES (1) RETURNING n';
      DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'exprsn_it_ro') THEN REVOKE ALL ON ALL TABLES IN SCHEMA exprsn_it FROM exprsn_it_ro; DROP OWNED BY exprsn_it_ro; DROP ROLE exprsn_it_ro; END IF; END $$;
      CREATE ROLE exprsn_it_ro LOGIN PASSWORD 'ro-secret';
      GRANT USAGE ON SCHEMA exprsn_it TO exprsn_it_ro;
      GRANT SELECT ON ALL TABLES IN SCHEMA exprsn_it TO exprsn_it_ro;
      GRANT EXECUTE ON FUNCTION exprsn_it.touch() TO exprsn_it_ro;
    `);
  });
  afterAll(async () => {
    await admin?.query('DROP SCHEMA IF EXISTS exprsn_it CASCADE').catch(() => undefined);
    await admin?.end();
    await s?.close();
    await s?.db.destroy();
    await ollama?.stop();
  });

  it('indexes and searches with the database vector store, filtering by label in the query', async () => {
    await seedRetrieval(h, ollama);
    const curator = await client(h, 'cura', ['member', 'knowledge-curator'], 'confidential');
    const kb = (await curator.post('/api/knowledge/bases', { name: 'Finance KB', label: 'internal', embedModel: 'nomic-embed-text' }).expect(201)).body;
    for (const [name, text] of [
      ['policy.md', '# Travel\n\nTaxis after 22:00 need no pre-approval.'],
      ['bank.txt', 'Contoso IBAN GB82 WEST 1234 5698 7654 32 for Lisbon.']
    ]) {
      await curator.agent.put(`/api/knowledge/bases/${kb.id}/uploads?name=${name}`).set('x-csrf-token', curator.csrf).set('content-type', 'application/octet-stream').send(Buffer.from(text!)).expect(202);
    }
    await drain(h);
    const kind = (await (s.vectors as LazyVectorStore).resolve()).kind;
    expect(['db', 'pgvector']).toContain(kind);
    const hit = (await curator.post('/api/knowledge/search', { kbIds: [kb.id], query: 'Contoso IBAN Lisbon', rerank: false }).expect(200)).body;
    expect(hit).toMatchObject({ vectorStore: kind });
    expect(hit.hits[0]).toMatchObject({ document: 'bank.txt', label: 'confidential' });
    const member = await client(h, 'mem', ['member'], 'internal');
    const miss = (await member.post('/api/knowledge/search', { kbIds: [kb.id], query: 'Contoso IBAN Lisbon', rerank: false }).expect(200)).body;
    expect(miss.hits.map((x: { document: string }) => x.document)).toEqual(['policy.md']);
    // blue/green on PostgreSQL
    await curator.post(`/api/knowledge/bases/${kb.id}/reindex`, { embedModel: 'bge-m3' }).expect(202);
    await drain(h);
    expect((await curator.get(`/api/knowledge/bases/${kb.id}`)).body).toMatchObject({ serving: { version: 2, dims: 48, chunks: 2 } });
  });

  it('reads through a read-only account with caps, the read-only transaction and the statement timeout', async () => {
    await localUser(h, 'connadmin', ['connection-admin', 'member'], 'confidential');
    const c = await loginAdmin(h, 'connadmin');
    const post = (p: string, b: object = {}) => c.agent.post(p).set('x-csrf-token', c.csrf).send(b);
    const endpoint = `${url.hostname}:${url.port || 5432}`;
    const database = url.pathname.slice(1);
    const conn = (await post('/api/admin/connections', { name: 'ledger-ro', engine: 'postgres', endpoint, database, label: 'confidential', rowLimit: 500, timeoutS: 2, username: 'exprsn_it_ro', password: 'ro-secret' }).expect(201)).body;
    expect((await post(`/api/admin/connections/${conn.id}/test`).expect(200)).body).toMatchObject({ ok: true, readOnly: true, health: 'healthy' });
    const schema = (await post(`/api/admin/connections/${conn.id}/schema`).expect(200)).body;
    expect(schema.connection.schema.map((o: { name: string }) => o.name)).toEqual(expect.arrayContaining(['exprsn_it.cost_centres', 'exprsn_it.v_cost_centres']));
    await c.agent.put(`/api/admin/connections/${conn.id}/allow-list`).set('x-csrf-token', c.csrf).send({ objects: ['exprsn_it.v_cost_centres'] }).expect(200);

    const ok = (await post(`/api/admin/connections/${conn.id}/query`, { query: 'SELECT cost_centre, q3_actual - q3_budget AS overrun, owner_email FROM exprsn_it.v_cost_centres ORDER BY overrun DESC LIMIT 3;' }).expect(200)).body;
    expect(ok.rows[0][0]).toBe('CC-0700');
    expect(ok.rows[0][2]).toMatch(/^••••/);
    const capped = (await post(`/api/admin/connections/${conn.id}/query`, { query: 'SELECT * FROM exprsn_it.v_cost_centres' }).expect(200)).body;
    expect(capped).toMatchObject({ capped: true });
    expect(capped.rows).toHaveLength(500);
    expect(capped.estimate).toBeGreaterThan(500);
    await post(`/api/admin/connections/${conn.id}/query`, { query: 'SELECT * FROM exprsn_it.cost_centres' }).expect(422);
    await post(`/api/admin/connections/${conn.id}/query`, { query: "UPDATE exprsn_it.cost_centres SET q3_budget = 0" }).expect(422);

    // a write hidden in a function: the parser cannot see it, the read-only transaction refuses it
    await post(`/api/admin/connections/${conn.id}/query`, { query: 'SELECT exprsn_it.touch()' }).expect(409);
    const hidden = (await post(`/api/admin/connections/${conn.id}/query`, { query: 'SELECT exprsn_it.touch()', confirmUnparsed: true }).expect(502)).body;
    expect(hidden.detail).toMatch(/read-only transaction/);
    expect((await admin.query('SELECT count(*)::int AS n FROM exprsn_it.audit_touch')).rows[0].n).toBe(0);
    const slow = (await post(`/api/admin/connections/${conn.id}/query`, { query: 'SELECT count(*) FROM generate_series(1, 2000000000) g', confirmUnparsed: true }).expect(502)).body;
    expect(slow.detail).toMatch(/statement timeout/);

    // a view as a knowledge source, by watermark on a timestamptz column
    const curator = await client(h, 'cura2', ['member', 'knowledge-curator'], 'confidential');
    const kb = (await curator.post('/api/knowledge/bases', { name: 'Ledger KB', label: 'internal', embedModel: 'nomic-embed-text' }).expect(201)).body;
    await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 'database', location: 'pg: exprsn_it.v_cost_centres', connectionId: conn.id }).expect(201);
    await drain(h);
    const src = (await curator.get(`/api/knowledge/bases/${kb.id}`)).body.sources[0];
    expect(src).toMatchObject({ state: 'idle', documents: 700, watermark: '2026-09-10T23:40:00.000Z' });
    await admin.query("INSERT INTO exprsn_it.cost_centres (cost_centre, q3_actual, q3_budget, updated_at) VALUES ('CC-NEW', 1, 1, timestamptz '2026-09-19 12:02:00+00')");
    await post(`/api/admin/connections/${conn.id}/sync`).expect(202);
    await drain(h);
    const job = (await s.db('jobs').where({ type: 'knowledge.sync' }).orderBy('created_at', 'desc').first()) as { result: unknown };
    expect(typeof job.result === 'string' ? JSON.parse(job.result) : job.result).toMatchObject({ added: 1, changed: 0 });

    // a superuser account is reported as able to write
    await c.agent.put(`/api/admin/connections/${conn.id}/credential`).set('x-csrf-token', c.csrf).send({ username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) }).expect(200);
    expect((await post(`/api/admin/connections/${conn.id}/test`).expect(200)).body).toMatchObject({ ok: true, readOnly: false, health: 'degraded' });
  });
});
