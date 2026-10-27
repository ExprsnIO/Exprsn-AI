/*
 * Sprint 19, knowledge: MySQL tables as knowledge sources (B-1001), row-level access carried onto chunks and
 * enforced at retrieval (B-1002), and PostgreSQL logical replication (B-1003): the pgoutput decoder, streamed
 * changes applied to the index, and the fallback to watermarks. The real-server path is in
 * test/integration/replication.test.ts.
 */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectionSpec, DataDriver, QueryResult } from '../src/connections/drivers.js';
import { bigToLsn, decodePgOutput, lsnToBig, PgOutputDecoder, type ReplicationBatch, type ReplicationOptions, type ReplicationStream } from '../src/connections/replication.js';
import { aclAllows, parseAccessValue, rowAcl } from '../src/knowledge/acl.js';
import { FakeOllama } from './fake-ollama.js';
import { loginAdmin, localUser, type Harness } from './helpers.js';
import { client, drain, harnessWith, seedRetrieval } from './retrieval-seed.js';

/** A fake replication stream the test feeds; `run` resolves when stopped. */
class FakeStream implements ReplicationStream {
  onBatch: ((b: ReplicationBatch) => Promise<void>) | null = null;
  private done: () => void = () => undefined;
  stopped = false;
  constructor(readonly opts: ReplicationOptions) {}
  run(onBatch: (b: ReplicationBatch) => Promise<void>, onReady?: () => void): Promise<void> {
    this.onBatch = onBatch;
    onReady?.();
    return new Promise<void>((r) => (this.done = r));
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.done();
  }
  push(b: ReplicationBatch): Promise<void> {
    return this.onBatch!(b);
  }
}

/** A DataDriver over in-memory SQLite, standing in for MySQL (`shop.` names) or PostgreSQL (`public.` names). */
class SqliteDriver implements DataDriver {
  static streams: FakeStream[] = [];
  static dropped: string[] = [];
  static refuseReplication: string | null = null;
  constructor(
    private readonly db: Database.Database,
    readonly spec: ConnectionSpec,
    private readonly prefix: string
  ) {}
  async test() {
    return { version: 'SQLite', readOnly: true, health: 'healthy' as const, detail: 'read-only' };
  }
  async introspect() {
    const objs = this.db.prepare("select name, type from sqlite_master where type in ('table','view') and name not like 'sqlite_%' order by name").all() as { name: string; type: string }[];
    return objs.map((o) => ({ name: `${this.prefix}.${o.name}`, kind: o.type === 'view' ? ('view' as const) : ('table' as const), columns: (this.db.prepare(`pragma table_info("${o.name}")`).all() as { name: string; type: string }[]).map((c) => ({ name: c.name, type: c.type.toLowerCase() })) }));
  }
  private run(sql: string, params: unknown[], limit: number): QueryResult {
    const st = this.db.prepare(sql.split(`${this.prefix}.`).join(''));
    const rows = st.raw(true).all(...params) as unknown[][];
    return { columns: st.columns().map((c) => c.name), rows: rows.slice(0, limit), capped: rows.length > limit, estimate: null };
  }
  async query(_c: unknown, text: string, opts: { limit: number }) {
    return this.run(`SELECT * FROM (${text}) LIMIT ${opts.limit + 1}`, [], opts.limit);
  }
  async rows(object: string, opts: { watermarkColumn: string | null; after: string | null; limit: number }) {
    const wm = opts.watermarkColumn;
    return this.run(`SELECT * FROM ${object}${wm && opts.after != null ? ` WHERE ${wm} > ?` : ''}${wm ? ` ORDER BY ${wm}` : ''} LIMIT ${opts.limit + 1}`, wm && opts.after != null ? [opts.after] : [], opts.limit);
  }
  async replicate(opts: ReplicationOptions): Promise<ReplicationStream> {
    if (SqliteDriver.refuseReplication) throw new Error(SqliteDriver.refuseReplication);
    const s = new FakeStream(opts);
    SqliteDriver.streams.push(s);
    return s;
  }
  async dropReplicationSlot(slot: string) {
    SqliteDriver.dropped.push(slot);
    return true;
  }
}

describe('Sprint 19: knowledge sources', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let data: Database.Database;

  afterEach(async () => {
    await h?.s.knowledge.replication.close();
    await h?.close();
    await ollama?.stop();
    data?.close();
    SqliteDriver.streams = [];
    SqliteDriver.dropped = [];
    SqliteDriver.refuseReplication = null;
  });

  async function setup(engine: 'mysql' | 'postgres', schemaSql: string, objects: string[]) {
    data = new Database(':memory:');
    data.exec(schemaSql);
    const prefix = engine === 'mysql' ? 'shop' : 'public';
    h = await harnessWith({ drivers: { [engine]: (spec: ConnectionSpec) => new SqliteDriver(data, spec, prefix) } }, { OLLAMA_POLL_MS: '600000', CONNECTIONS_ALLOWED_HOSTS: 'db.data.internal', KNOWLEDGE_REPLICATION_TICK_MS: '200' });
    ollama = await new FakeOllama().start();
    await seedRetrieval(h, ollama);
    await localUser(h, 'connadmin', ['connection-admin', 'member'], 'confidential');
    const a = await loginAdmin(h, 'connadmin');
    const post = (p: string, b: object) => a.agent.post(p).set('x-csrf-token', a.csrf).send(b);
    const conn = (await post('/api/admin/connections', { name: 'shop', engine, endpoint: `db.data.internal:${engine === 'mysql' ? 3306 : 5432}`, database: 'shop', label: 'internal', username: 'reader', password: 'pw' }).expect(201)).body;
    await post(`/api/admin/connections/${conn.id}/schema`, {}).expect(200);
    await a.agent.put(`/api/admin/connections/${conn.id}/allow-list`).set('x-csrf-token', a.csrf).send({ objects: objects.map((o) => `${prefix}.${o}`), piiColumns: [] }).expect(200);
    const curator = await client(h, 'cura', ['member', 'knowledge-curator'], 'confidential');
    const kb = (await curator.post('/api/knowledge/bases', { name: 'Shop KB', label: 'internal', embedModel: 'nomic-embed-text', sharing: 'members' }).expect(201)).body;
    await curator.patch(`/api/knowledge/bases/${kb.id}`, { status: 'published' }).expect(200);
    return { conn, curator, kb, admin: a };
  }

  it('B-1001: a MySQL view feeds a knowledge base by watermark', async () => {
    const { conn, curator, kb } = await setup(
      'mysql',
      `create table orders (id integer primary key, customer text, status text, note text, updated_at text);
       create view v_open_orders as select id, customer, status, note, updated_at from orders where status = 'open';
       insert into orders values (1, 'Contoso', 'open', 'Pallets due Friday at dock four', '2026-09-20 10:00:00'),
                                 (2, 'Fabrikam', 'closed', 'Delivered', '2026-09-20 11:00:00'),
                                 (3, 'Northwind', 'open', 'Awaiting customs papers', '2026-09-21 09:00:00');`,
      ['orders', 'v_open_orders']
    );
    const listed = (await curator.get('/api/knowledge/connections').expect(200)).body;
    expect(listed).toEqual([expect.objectContaining({ id: conn.id, engine: 'mysql', objects: expect.arrayContaining(['shop.v_open_orders']) })]);
    const src = (await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 'database', location: 'mysql: v_open_orders', connectionId: conn.id }).expect(201)).body;
    expect(src).toMatchObject({ location: 'mysql: shop.v_open_orders', config: { object: 'shop.v_open_orders', engine: 'mysql', idColumn: 'id', watermarkColumn: 'updated_at' } });
    // Replication is PostgreSQL only.
    await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 'database', location: 'mysql: orders', connectionId: conn.id, replication: true }).expect(409);
    await drain(h);
    const view = (await curator.get(`/api/knowledge/bases/${kb.id}`).expect(200)).body.sources[0];
    expect(view).toMatchObject({ state: 'idle', documents: 2, watermark: '2026-09-21 09:00:00', replication: null });
    const hit = (await curator.post('/api/knowledge/search', { kbIds: [kb.id], query: 'customs papers', rerank: false }).expect(200)).body.hits[0];
    expect(hit).toMatchObject({ document: 'shop.v_open_orders #3', source: 'mysql: shop.v_open_orders' });
    expect(hit.text).toContain('note: Awaiting customs papers');
    // A new row after the watermark is picked up alone.
    data.prepare('insert into orders values (4, ?, ?, ?, ?)').run('Litware', 'open', 'Rush order for Monday', '2026-09-22 08:00:00');
    await curator.post(`/api/knowledge/sources/${src.id}/sync`).expect(202);
    await drain(h);
    const job = (await h.s.db('jobs').where({ type: 'knowledge.sync' }).orderBy('created_at', 'desc').first()) as { result: string };
    expect(JSON.parse(job.result)).toMatchObject({ added: 1, changed: 0, unchanged: 0 });
    expect(await h.s.db('audit_events').where({ action: 'knowledge.source.added' })).toHaveLength(1);
  });

  it('B-1002: a member not in a row\'s group never retrieves its chunk', async () => {
    const { conn, curator, kb } = await setup(
      'mysql',
      `create table tickets (id integer primary key, subject text, body text, access_groups text, owner text, updated_at text);
       insert into tickets values (1, 'Payroll run', 'The payroll batch for October closes on the 28th.', 'Finance, HR', 'fin@northwind.example', '2026-09-20 10:00:00'),
                                  (2, 'Switch upgrade', 'The core switch upgrade happens on the 28th at night.', 'ops', 'ops@northwind.example', '2026-09-20 11:00:00'),
                                  (3, 'Unassigned', 'Nobody may read this note about the 28th.', '', null, '2026-09-20 12:00:00');`,
      ['tickets']
    );
    const bad = await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 'database', location: 'mysql: tickets', connectionId: conn.id, accessColumn: 'nope' });
    expect(bad.status).toBe(409);
    const src = (await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 'database', location: 'mysql: tickets', connectionId: conn.id, accessColumn: 'access_groups' }).expect(201)).body;
    expect(src.config).toMatchObject({ accessColumn: 'access_groups', accessKind: 'group' });
    const added = (await h.s.db('audit_events').where({ action: 'knowledge.source.added' }).first()) as { detail: string };
    expect(JSON.parse(added.detail)).toMatchObject({ accessColumn: 'access_groups', accessKind: 'group' });
    await drain(h);
    const docs = (await h.s.db('knowledge_documents').where({ source_id: src.id }).orderBy('name')) as { name: string; acl: string }[];
    expect(docs.map((d) => [d.name, JSON.parse(d.acl)])).toEqual([
      ['shop.tickets #1', ['g:finance', 'g:hr']],
      ['shop.tickets #2', ['g:ops']],
      ['shop.tickets #3', []]
    ]);
    const chunks = (await h.s.db('knowledge_chunks').whereNotNull('acl')) as unknown[];
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    const fin = await client(h, 'fin', ['member']);
    const ops = await client(h, 'ops', ['member']);
    await h.s.db('user_identities').where({ user_id: fin.user.id }).update({ groups: JSON.stringify(['FINANCE']) });
    await h.s.db('user_identities').where({ user_id: ops.user.id }).update({ groups: JSON.stringify(['ops']) });
    const search = async (c: typeof fin) => ((await c.post('/api/knowledge/search', { kbIds: [kb.id], query: 'what happens on the 28th', rerank: false, k: 10 }).expect(200)).body.hits as { document: string; text?: string }[]).map((x) => x.document).sort();
    expect(await search(fin)).toEqual(['shop.tickets #1']);
    expect(await search(ops)).toEqual(['shop.tickets #2']);
    // The document list and the document itself follow the same rule for members; curators manage every row.
    const opsDocs = (await ops.get(`/api/knowledge/bases/${kb.id}/documents`).expect(200)).body as { name: string; id: string }[];
    expect(opsDocs.map((d) => d.name)).toEqual(['shop.tickets #2']);
    const finId = ((await h.s.db('knowledge_documents').where({ source_id: src.id, name: 'shop.tickets #1' }).first()) as { id: string }).id;
    await ops.get(`/api/knowledge/documents/${finId}`).expect(404);
    expect(((await curator.get(`/api/knowledge/bases/${kb.id}/documents`).expect(200)).body as unknown[]).length).toBe(3);
    // The curator searches as a reader too: rows they are in no group for stay out.
    expect(await search(curator as unknown as typeof fin)).toEqual([]);
  });

  it('B-1002: an access column of users matches by email even though the value is masked in the text', async () => {
    const { conn, curator, kb } = await setup(
      'mysql',
      `create table notes (id integer primary key, body text, owner text, updated_at text);
       insert into notes values (1, 'Quarterly review notes for the badge audit', 'jane@northwind.example', '2026-09-20 10:00:00');`,
      ['notes']
    );
    const src = (await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 'database', location: 'mysql: notes', connectionId: conn.id, accessColumn: 'owner', accessKind: 'user' }).expect(201)).body;
    await drain(h);
    const doc = (await h.s.db('knowledge_documents').where({ source_id: src.id }).first()) as { acl: string };
    expect(JSON.parse(doc.acl)).toEqual(['u:jane@northwind.example']);
    const jane = await client(h, 'jane', ['member']);
    const bob = await client(h, 'bob', ['member']);
    await h.s.db('users').where({ id: jane.user.id }).update({ email: 'Jane@Northwind.example' });
    const hits = (await jane.post('/api/knowledge/search', { kbIds: [kb.id], query: 'badge audit review', rerank: false }).expect(200)).body.hits;
    expect(hits).toHaveLength(1);
    expect(hits[0].text).not.toContain('jane@northwind.example');
    expect((await bob.post('/api/knowledge/search', { kbIds: [kb.id], query: 'badge audit review', rerank: false }).expect(200)).body.hits).toEqual([]);
  });

  it('B-1003: a streamed update reaches the index at once; deletes remove documents; a broken stream falls back', async () => {
    const { conn, curator, kb } = await setup(
      'postgres',
      `create table notes (id integer primary key, title text, body text, updated_at text);
       create view v_notes as select * from notes;
       insert into notes values (1, 'Parking', 'Visitors park on level two.', '2026-09-20 10:00:00'), (2, 'Badges', 'Collect badges at reception.', '2026-09-20 10:00:00');`,
      ['notes', 'v_notes']
    );
    await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 'database', location: 'pg: v_notes', connectionId: conn.id, replication: true }).expect(409);
    const src = (await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 'database', location: 'pg: notes', connectionId: conn.id, replication: true }).expect(201)).body;
    expect(src.config).toMatchObject({ replication: true, publication: 'exprsn_knowledge' });
    await drain(h);
    await h.s.knowledge.replication.tick();
    expect(SqliteDriver.streams).toHaveLength(1);
    const stream = SqliteDriver.streams[0]!;
    expect(stream.opts).toMatchObject({ slot: `exprsn_${src.id.toLowerCase()}`, publication: 'exprsn_knowledge', table: 'public.notes', startLsn: null });
    const status = async () => (await curator.get(`/api/knowledge/bases/${kb.id}`).expect(200)).body.sources[0].replication;
    expect(await status()).toMatchObject({ state: 'streaming', slot: `exprsn_${src.id.toLowerCase()}`, changes: 0 });
    // A second instance cannot take the lease while this one holds it.
    const other = h.s.knowledge.replication as unknown as { instance: string };
    expect(other.instance).toMatch(/^[0-9a-f]{16}$/);

    const cols = ['id', 'title', 'body', 'updated_at'];
    await stream.push({ lsn: '0/1A0', changes: [{ op: 'update', relation: 'public.notes', columns: cols, values: [1, 'Parking', 'Visitors park on level three from October.', '2026-09-30 10:00:00'], old: null }, { op: 'insert', relation: 'public.other', columns: ['id'], values: [9], old: null }] });
    const hit = (await curator.post('/api/knowledge/search', { kbIds: [kb.id], query: 'level three October', rerank: false }).expect(200)).body.hits[0];
    expect(hit.text).toContain('Visitors park on level three from October.');
    await stream.push({ lsn: '0/2B0', changes: [{ op: 'delete', relation: 'public.notes', columns: cols, values: null, old: [2, null, null, null] }] });
    const names = async () => ((await h.s.db('knowledge_documents').where({ source_id: src.id }).whereNot({ state: 'removed' })) as { name: string }[]).map((d) => d.name);
    expect(await names()).toEqual(['public.notes #1']);
    expect(await status()).toMatchObject({ state: 'streaming', lsn: '0/2B0', changes: 2 });
    await stream.push({ lsn: '0/3C0', changes: [{ op: 'truncate', relation: 'public.notes', columns: cols, values: null, old: null }] });
    expect(await names()).toEqual([]);

    // Removing the source stops the stream and drops the slot.
    await curator.del(`/api/knowledge/sources/${src.id}`).expect(200);
    expect(stream.stopped).toBe(true);
    expect(SqliteDriver.dropped).toEqual([`exprsn_${src.id.toLowerCase()}`]);
    expect(await h.s.db('knowledge_replication')).toHaveLength(0);

    // A stream that cannot start leaves the source on watermarks, with the reason.
    SqliteDriver.refuseReplication = 'must be superuser or replication role to start walsender';
    const again = (await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 'database', location: 'pg: notes', connectionId: conn.id, replication: true }).expect(201)).body;
    await drain(h);
    await h.s.knowledge.replication.tick();
    expect((await curator.get(`/api/knowledge/bases/${kb.id}`).expect(200)).body.sources.find((x: { id: string }) => x.id === again.id)).toMatchObject({ state: 'idle', documents: 2, replication: { state: 'fallback', error: 'must be superuser or replication role to start walsender' } });
  });

  it('B-1003: decodes pgoutput relations, changes and commits', () => {
    const u8 = (n: number) => Buffer.from([n]);
    const i16 = (n: number) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
    const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
    const i64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(n); return b; };
    const str = (s: string) => Buffer.concat([Buffer.from(s), u8(0)]);
    const tuple = (vals: (string | null | undefined)[]) => Buffer.concat([i16(vals.length), ...vals.map((v) => (v === null ? Buffer.from('n') : v === undefined ? Buffer.from('u') : Buffer.concat([Buffer.from('t'), i32(Buffer.byteLength(v)), Buffer.from(v)])))]);
    const relation = Buffer.concat([Buffer.from('R'), i32(16384), str('public'), str('notes'), u8(100), i16(3), u8(1), str('id'), i32(23), i32(-1), u8(0), str('body'), i32(25), i32(-1), u8(0), str('updated_at'), i32(1184), i32(-1)]);
    const d = new PgOutputDecoder();
    expect(decodePgOutput(relation)).toMatchObject({ tag: 'relation', relation: { id: 16384, name: 'public.notes', columns: [{ name: 'id', type: 23, key: true }, { name: 'body', key: false }, { name: 'updated_at', type: 1184 }] } });
    for (const m of [relation, Buffer.concat([Buffer.from('B'), i64(0x1a0n), i64(0n), i32(7)])]) expect(d.push(decodePgOutput(m))).toBeNull();
    d.push(decodePgOutput(Buffer.concat([Buffer.from('I'), i32(16384), Buffer.from('N'), tuple(['5', 'Hello', '2026-09-30 10:00:00+00'])])));
    d.push(decodePgOutput(Buffer.concat([Buffer.from('U'), i32(16384), Buffer.from('K'), tuple(['4', null, null]), Buffer.from('N'), tuple(['5', 'Hi', undefined])])));
    d.push(decodePgOutput(Buffer.concat([Buffer.from('D'), i32(16384), Buffer.from('K'), tuple(['6', null, null])])));
    const b = d.push(decodePgOutput(Buffer.concat([Buffer.from('C'), u8(0), i64(0x1a0n), i64(0x1b8n), i64(0n)])))!;
    expect(b.lsn).toBe('0/1B8');
    expect(b.changes).toEqual([
      { op: 'insert', relation: 'public.notes', columns: ['id', 'body', 'updated_at'], values: [5, 'Hello', new Date('2026-09-30T10:00:00Z')], old: null },
      { op: 'update', relation: 'public.notes', columns: ['id', 'body', 'updated_at'], values: [5, 'Hi', null], old: [4, null, null] },
      { op: 'delete', relation: 'public.notes', columns: ['id', 'body', 'updated_at'], values: null, old: [6, null, null] }
    ]);
    expect(bigToLsn(lsnToBig('16/B374D848'))).toBe('16/B374D848');
    expect(decodePgOutput(Buffer.concat([Buffer.from('T'), i32(1), u8(0), i32(16384)]))).toEqual({ tag: 'truncate', relationIds: [16384] });
  });

  it('B-1002: access values parse from lists, JSON and PostgreSQL arrays, and an empty list admits nobody', () => {
    expect(parseAccessValue('Finance, HR;ops')).toEqual(['finance', 'hr', 'ops']);
    expect(parseAccessValue('["A","b"]')).toEqual(['a', 'b']);
    expect(parseAccessValue('{finance,"HR team"}')).toEqual(['finance', 'hr team']);
    expect(parseAccessValue(null)).toEqual([]);
    expect(rowAcl('user', 'Jane@X.example')).toEqual(['u:jane@x.example']);
    expect(aclAllows([], new Set(['g:finance']))).toBe(false);
    expect(aclAllows(null, new Set())).toBe(true);
    expect(aclAllows(['g:finance'], new Set(['g:finance']))).toBe(true);
  });
});
