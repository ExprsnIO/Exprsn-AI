/*
 * Sprint 23 (B-1503): a PostgreSQL knowledge source read as mapped database roles, so the table's own row security
 * policies decide which group retrieves which row. Against a real server (TEST_PG_URL, whose account may create
 * databases and roles). A scratch database and scratch roles are created and dropped.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { FakeOllama } from '../fake-ollama.js';
import { loginAdmin, localUser, type Harness } from '../helpers.js';
import { client, drain, harnessWith, seedRetrieval } from '../retrieval-seed.js';

const PG = process.env.TEST_PG_URL;

describe.skipIf(!PG)('knowledge row security through PostgreSQL roles', () => {
  const tag = randomBytes(4).toString('hex');
  const dbName = `exprsn_rls_${tag}`;
  const reader = `kb_reader_${tag}`;
  const fin = `kb_fin_${tag}`;
  const ops = `kb_ops_${tag}`;
  const outsider = `kb_out_${tag}`;
  const password = randomBytes(12).toString('hex');
  const base = new URL(PG ?? 'postgres://x@localhost/x');
  const scratch = new URL(base.toString());
  scratch.pathname = `/${dbName}`;
  let admin: pg.Client;
  let src: pg.Client;
  let h: Harness;
  let ollama: FakeOllama;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: PG });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.query(`CREATE ROLE ${reader} LOGIN PASSWORD '${password}'`);
    await admin.query(`CREATE ROLE ${fin} NOLOGIN`);
    await admin.query(`CREATE ROLE ${ops} NOLOGIN`);
    await admin.query(`CREATE ROLE ${outsider} NOLOGIN`);
    // Membership without inheritance (PostgreSQL 16+): the account can only read through SET ROLE.
    await admin.query(`GRANT ${fin}, ${ops} TO ${reader} WITH INHERIT FALSE`);
    src = new pg.Client({ connectionString: scratch.toString() });
    await src.connect();
    await src.query(`
      CREATE TABLE notices (id int PRIMARY KEY, title text, body text, region text NOT NULL);
      INSERT INTO notices VALUES
        (1, 'Finance close', 'The quarterly close for the ledger is on the 28th.', 'finance'),
        (2, 'Network change', 'The firewall change window is on the 28th.', 'ops'),
        (3, 'Town hall', 'Everyone joins the town hall on the 28th.', 'all'),
        (4, 'Restructure', 'The HR restructure plan lands on the 28th.', 'hr');
      ALTER TABLE notices ENABLE ROW LEVEL SECURITY;
      CREATE POLICY finance_rows ON notices FOR SELECT TO ${fin} USING (region IN ('finance', 'all'));
      CREATE POLICY ops_rows ON notices FOR SELECT TO ${ops} USING (region IN ('ops', 'all'));
      GRANT SELECT ON notices TO ${fin}, ${ops};
      -- The account itself may see the table (for schema introspection) but no policy names it: it reads no rows.
      GRANT SELECT ON notices TO ${reader};
      CREATE TABLE open_notes (id int PRIMARY KEY, body text);
      GRANT SELECT ON open_notes TO ${fin}, ${ops}, ${reader};
    `);
    ollama = await new FakeOllama().start();
    h = await harnessWith({}, { OLLAMA_POLL_MS: '600000' });
    await seedRetrieval(h, ollama);
  }, 60_000);

  afterAll(async () => {
    await h?.close();
    await ollama?.stop();
    await src?.end().catch(() => undefined);
    if (admin) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [dbName]).catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => undefined);
      for (const r of [reader, fin, ops, outsider]) await admin.query(`DROP ROLE IF EXISTS ${r}`).catch(() => undefined);
      await admin.end();
    }
  }, 60_000);

  it('reads as each mapped role, so a row a policy hides from a group never reaches its chunks', async () => {
    await localUser(h, 'connadmin', ['connection-admin', 'member'], 'confidential');
    const a = await loginAdmin(h, 'connadmin');
    const post = (p: string, b: object) => a.agent.post(p).set('x-csrf-token', a.csrf).send(b);
    const conn = (await post('/api/admin/connections', { name: 'intranet', engine: 'postgres', endpoint: `${scratch.hostname}:${scratch.port || 5432}`, database: dbName, label: 'internal', username: reader, password }).expect(201)).body;
    await post(`/api/admin/connections/${conn.id}/schema`, {}).expect(200);
    await a.agent.put(`/api/admin/connections/${conn.id}/allow-list`).set('x-csrf-token', a.csrf).send({ objects: ['public.notices', 'public.open_notes'], piiColumns: [] }).expect(200);

    const curator = await client(h, 'cura', ['member', 'knowledge-curator'], 'confidential');
    const kb = (await curator.post('/api/knowledge/bases', { name: 'Notices', label: 'internal', embedModel: 'nomic-embed-text' }).expect(201)).body;
    await curator.patch(`/api/knowledge/bases/${kb.id}`, { status: 'published' }).expect(200);
    const add = (location: string, roleMappings: object[]) => curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 'database', location, connectionId: conn.id, roleMappings });

    // The server checks the setup: membership, row security, a role that exists.
    expect((await add('pg: notices', [{ group: 'finance', role: outsider }]).expect(409)).body.detail).toContain(`GRANT ${outsider} TO ${reader}`);
    expect((await add('pg: open_notes', [{ group: 'finance', role: fin }]).expect(409)).body.detail).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect((await add('pg: notices', [{ group: 'finance', role: `no_such_${tag}` }]).expect(409)).body.detail).toMatch(/There is no role/);

    const source = (await add('pg: notices', [{ group: 'finance', role: fin }, { group: 'ops', role: ops }]).expect(201)).body;
    await drain(h);
    const docs = (await h.s.db('knowledge_documents').where({ source_id: source.id }).orderBy('name')) as { name: string; acl: string; state: string }[];
    expect(docs.map((d) => [d.name, JSON.parse(d.acl)])).toEqual([
      ['public.notices #1', ['g:finance']],
      ['public.notices #2', ['g:ops']],
      ['public.notices #3', ['g:finance', 'g:ops']]
    ]);

    const f = await client(h, 'fin', ['member']);
    const o = await client(h, 'ops', ['member']);
    await h.s.db('user_identities').where({ user_id: f.user.id }).update({ groups: JSON.stringify(['finance']) });
    await h.s.db('user_identities').where({ user_id: o.user.id }).update({ groups: JSON.stringify(['ops']) });
    const search = async (c: typeof f) => ((await c.post('/api/knowledge/search', { kbIds: [kb.id], query: 'what happens on the 28th', rerank: false, k: 10 }).expect(200)).body.hits as { document: string }[]).map((x) => x.document).sort();
    expect(await search(f)).toEqual(['public.notices #1', 'public.notices #3']);
    expect(await search(o)).toEqual(['public.notices #2', 'public.notices #3']);

    // The database changes its policy; the next sync follows it.
    await src.query(`DROP POLICY ops_rows ON notices; CREATE POLICY ops_rows ON notices FOR SELECT TO ${ops} USING (region IN ('ops', 'hr'))`);
    await curator.post(`/api/knowledge/sources/${source.id}/sync`).expect(202);
    await drain(h);
    expect(await search(o)).toEqual(['public.notices #2', 'public.notices #4']);
    expect(await search(f)).toEqual(['public.notices #1', 'public.notices #3']);
    // Without a role the account itself reads no rows: no policy names it, and it does not inherit the roles'.
    const plain = new pg.Client({ host: scratch.hostname, port: Number(scratch.port || 5432), database: dbName, user: reader, password });
    await plain.connect();
    try {
      expect(Number((await plain.query<{ n: string }>('SELECT count(*) AS n FROM notices')).rows[0]!.n)).toBe(0);
    } finally {
      await plain.end();
    }
  }, 60_000);
});
