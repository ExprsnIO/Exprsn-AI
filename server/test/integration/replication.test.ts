/*
 * Sprint 19 (B-1003): logical replication of a PostgreSQL table into a knowledge base, against a real server
 * (TEST_PG_URL, whose account may create databases and replication slots, with wal_level=logical; CI turns it on).
 * A scratch database is created and dropped. An update in the source reaches the index within seconds, a delete
 * removes its document, and removing the source drops its slot.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { FakeOllama } from '../fake-ollama.js';
import { loginAdmin, localUser, type Harness } from '../helpers.js';
import { client, drain, harnessWith, seedRetrieval } from '../retrieval-seed.js';

const PG = process.env.TEST_PG_URL;

async function walLevel(url: string): Promise<string> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return String((await c.query<{ w: string }>("SELECT current_setting('wal_level') AS w")).rows[0]!.w);
  } finally {
    await c.end();
  }
}

const logical = PG ? await walLevel(PG).catch(() => 'unreachable') : 'unset';

describe.skipIf(logical !== 'logical')('knowledge replication on PostgreSQL', () => {
  const dbName = `exprsn_repl_${randomBytes(4).toString('hex')}`;
  const base = new URL(PG ?? 'postgres://x@localhost/x');
  const scratch = new URL(base.toString());
  scratch.pathname = `/${dbName}`;
  let admin: pg.Client;
  let src: pg.Client;
  let h: Harness;
  let ollama: FakeOllama;
  let a: Awaited<ReturnType<typeof loginAdmin>>;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: PG });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    src = new pg.Client({ connectionString: scratch.toString() });
    await src.connect();
    await src.query(`
      CREATE TABLE notes (id int PRIMARY KEY, title text, body text, updated_at timestamptz NOT NULL DEFAULT now());
      INSERT INTO notes (id, title, body) VALUES (1, 'Parking', 'Visitors park on level two.'), (2, 'Badges', 'Badges are collected at reception.');
      CREATE PUBLICATION exprsn_knowledge FOR TABLE notes;
    `);
    ollama = await new FakeOllama().start();
    h = await harnessWith({}, { OLLAMA_POLL_MS: '600000', KNOWLEDGE_REPLICATION_TICK_MS: '300' });
    await seedRetrieval(h, ollama);
  }, 60_000);

  afterAll(async () => {
    await h?.s.knowledge.replication.close().catch(() => undefined);
    await h?.close();
    await ollama?.stop();
    await src?.end().catch(() => undefined);
    if (admin) {
      await admin.query('SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE database = $1 AND NOT active', [dbName]).catch(() => undefined);
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [dbName]).catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => undefined);
      await admin.end();
    }
  }, 60_000);

  const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  it('streams an update into the index within seconds, removes deleted rows and drops the slot with the source', async () => {
    await localUser(h, 'connadmin', ['connection-admin', 'member'], 'confidential');
    a = await loginAdmin(h, 'connadmin');
    const post = (p: string, b: object) => a.agent.post(p).set('x-csrf-token', a.csrf).send(b);
    const conn = (await post('/api/admin/connections', { name: 'notes', engine: 'postgres', endpoint: `${scratch.hostname}:${scratch.port || 5432}`, database: dbName, label: 'internal', username: decodeURIComponent(scratch.username), password: decodeURIComponent(scratch.password) || 'unused' }).expect(201)).body;
    await post(`/api/admin/connections/${conn.id}/schema`, {}).expect(200);
    await a.agent.put(`/api/admin/connections/${conn.id}/allow-list`).set('x-csrf-token', a.csrf).send({ objects: ['public.notes'], piiColumns: [] }).expect(200);

    const curator = await client(h, 'cura', ['member', 'knowledge-curator'], 'confidential');
    const kb = (await curator.post('/api/knowledge/bases', { name: 'Notes', label: 'internal', embedModel: 'nomic-embed-text' }).expect(201)).body;
    const source = (await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 'database', location: 'pg: notes', connectionId: conn.id, replication: true }).expect(201)).body;
    expect(source.config).toMatchObject({ replication: true, publication: 'exprsn_knowledge', engine: 'postgres' });
    await drain(h);
    const docs = async () => (await h.s.db('knowledge_documents').where({ source_id: source.id }).whereNot({ state: 'removed' })) as { name: string; sha256: string; state: string }[];
    expect((await docs()).map((d) => d.name).sort()).toEqual(['public.notes #1', 'public.notes #2']);

    await h.s.knowledge.replication.tick();
    await until(async () => (await h.s.knowledge.replication.row(source.id))?.state === 'streaming');
    const slot = (await admin.query('SELECT slot_name, plugin FROM pg_replication_slots WHERE database = $1', [dbName])).rows;
    expect(slot).toEqual([{ slot_name: `exprsn_${source.id.toLowerCase()}`, plugin: 'pgoutput' }]);

    const before = (await docs()).find((d) => d.name === 'public.notes #1')!.sha256;
    const t0 = Date.now();
    await src.query("UPDATE notes SET body = 'Visitors park on level three from October.', updated_at = now() WHERE id = 1");
    await until(async () => (await docs()).find((d) => d.name === 'public.notes #1' && d.sha256 !== before && d.state === 'indexed'));
    expect(Date.now() - t0).toBeLessThan(5000);
    const hit = (await curator.post('/api/knowledge/search', { kbIds: [kb.id], query: 'level three October', rerank: false }).expect(200)).body.hits[0];
    expect(hit.text).toContain('level three from October');

    await src.query('DELETE FROM notes WHERE id = 2');
    await until(async () => !(await docs()).some((d) => d.name === 'public.notes #2'));
    await src.query("INSERT INTO notes (id, title, body) VALUES (3, 'Lockers', 'Lockers close at eight.')");
    await until(async () => (await docs()).some((d) => d.name === 'public.notes #3' && d.state === 'indexed'));
    const row = (await h.s.knowledge.replication.row(source.id))!;
    expect(row).toMatchObject({ state: 'streaming', error: null });
    expect(Number(row.changes)).toBeGreaterThanOrEqual(3);
    expect(row.lsn).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/);

    await curator.del(`/api/knowledge/sources/${source.id}`).expect(200);
    await until(async () => (await admin.query('SELECT 1 FROM pg_replication_slots WHERE database = $1', [dbName])).rows.length === 0);
  }, 60_000);

  it('falls back to watermarks when the table is not in the publication', async () => {
    await src.query('CREATE TABLE other (id int PRIMARY KEY, body text, updated_at timestamptz DEFAULT now()); INSERT INTO other VALUES (1, $$hello$$)');
    const conn = (await a.agent.get('/api/admin/connections').expect(200)).body.find((c: { name: string }) => c.name === 'notes');
    await a.agent.post(`/api/admin/connections/${conn.id}/schema`).set('x-csrf-token', a.csrf).expect(200);
    await a.agent.put(`/api/admin/connections/${conn.id}/allow-list`).set('x-csrf-token', a.csrf).send({ objects: ['public.notes', 'public.other'], piiColumns: [] }).expect(200);
    const curator = await client(h, 'cura2', ['member', 'knowledge-curator'], 'confidential');
    const kb = (await curator.post('/api/knowledge/bases', { name: 'Other', label: 'internal', embedModel: 'nomic-embed-text' }).expect(201)).body;
    const source = (await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 'database', location: 'pg: other', connectionId: conn.id, replication: true }).expect(201)).body;
    await drain(h);
    await h.s.knowledge.replication.tick();
    const row = await until(async () => {
      const r = await h.s.knowledge.replication.row(source.id);
      return r?.state === 'fallback' ? r : null;
    });
    expect(row.error).toMatch(/does not include public\.other/);
    // The watermark sync still fed it.
    expect(await h.s.db('knowledge_documents').where({ source_id: source.id, state: 'indexed' })).toHaveLength(1);
  }, 60_000);
});
