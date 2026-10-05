/*
 * MongoDB connections on a real server (TEST_MONGODB_URL, an account that may create users and databases, such as
 * mongodb://root:root@127.0.0.1:27017/?authSource=admin): Test connection telling a read-only account from one with
 * write privileges and from a wrong password, introspection by sampling, find and aggregate through the query API
 * with caps and masking, the read role refusing a write stage sent past the parser, and a collection as a knowledge
 * source synced by watermark.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { openMongo } from '../../src/connections/mongo.js';
import { FakeOllama } from '../fake-ollama.js';
import { loginAdmin, localUser, type Harness } from '../helpers.js';
import { client, drain, harnessWith, seedRetrieval } from '../retrieval-seed.js';

const URL_ = process.env.TEST_MONGODB_URL;
const DB = 'exprsn_it';

describe.skipIf(!URL_)('MongoDB connections on a real server', () => {
  let admin: MongoClient;
  let h: Harness;
  let ollama: FakeOllama;
  const u = new URL(URL_ ?? 'mongodb://127.0.0.1:27017');
  const endpoint = `${u.hostname}:${u.port || 27017}`;

  beforeAll(async () => {
    admin = new MongoClient(URL_!);
    await admin.connect();
    await admin.db(DB).dropDatabase();
    const t0 = Date.UTC(2026, 8, 20);
    await admin.db(DB).collection('tickets').insertMany(Array.from({ length: 12 }, (_, i) => ({ _id: `t${i + 1}` as never, subject: `Ticket ${i + 1}`, body: i === 0 ? 'The payroll batch for October closes on the 28th.' : `Routine note ${i + 1}.`, email: `user${i}@northwind.example`, team: i % 2 ? 'ops' : 'finance', updatedAt: new Date(t0 + i * 60_000) })));
    await admin.db(DB).collection('salaries').insertOne({ who: 'x', amount: 1 });
    for (const name of ['exprsn_reader', 'exprsn_writer']) await admin.db('admin').command({ dropUser: name }).catch(() => undefined);
    await admin.db('admin').command({ createUser: 'exprsn_reader', pwd: 'reader-pw', roles: [{ role: 'read', db: DB }] });
    await admin.db('admin').command({ createUser: 'exprsn_writer', pwd: 'writer-pw', roles: [{ role: 'readWrite', db: DB }] });
    h = await harnessWith({}, { OLLAMA_POLL_MS: '600000' });
    ollama = await new FakeOllama().start();
    await seedRetrieval(h, ollama);
  });

  afterAll(async () => {
    await h?.close();
    await ollama?.stop();
    if (admin) {
      for (const name of ['exprsn_reader', 'exprsn_writer']) await admin.db('admin').command({ dropUser: name }).catch(() => undefined);
      await admin.db(DB).dropDatabase().catch(() => undefined);
      await admin.close();
    }
  });

  it('tests accounts, introspects, queries read-only with caps and masking, and syncs a knowledge source', async () => {
    await localUser(h, 'mongoadmin', ['connection-admin', 'member'], 'confidential');
    const a = await loginAdmin(h, 'mongoadmin');
    const post = (p: string, b: object) => a.agent.post(p).set('x-csrf-token', a.csrf).send(b);
    const reg = (name: string, username: string, password: string) => post('/api/admin/connections', { name, engine: 'mongodb', endpoint, database: DB, label: 'internal', rowLimit: 5, timeoutS: 10, username, password }).expect(201);

    const writer = (await reg('mongo-writer', 'exprsn_writer', 'writer-pw')).body;
    expect((await post(`/api/admin/connections/${writer.id}/test`, {}).expect(200)).body).toMatchObject({ ok: true, readOnly: false, health: 'degraded' });
    const wrong = (await reg('mongo-wrong', 'exprsn_reader', 'not-the-password')).body;
    const bad = (await post(`/api/admin/connections/${wrong.id}/test`, {}).expect(200)).body;
    expect(bad).toMatchObject({ ok: false, health: 'unreachable' });
    expect(bad.detail).not.toContain('not-the-password');

    const conn = (await reg('mongo-reader', 'exprsn_reader', 'reader-pw')).body;
    const t = (await post(`/api/admin/connections/${conn.id}/test`, {}).expect(200)).body;
    expect(t).toMatchObject({ ok: true, readOnly: true, health: 'healthy' });
    expect(t.version).toMatch(/^MongoDB \d/);
    const sch = (await post(`/api/admin/connections/${conn.id}/schema`, {}).expect(200)).body;
    expect(sch.objects).toBe(2);
    const tickets = sch.connection.schema.find((o: { name: string }) => o.name === 'tickets');
    expect(tickets.columns.map((c: { name: string }) => c.name)).toEqual(expect.arrayContaining(['_id', 'subject', 'body', 'email', 'team', 'updatedAt']));
    await a.agent.put(`/api/admin/connections/${conn.id}/allow-list`).set('x-csrf-token', a.csrf).send({ objects: ['tickets'], piiColumns: [] }).expect(200);

    const q = (query: string) => post(`/api/admin/connections/${conn.id}/query`, { query });
    const found = (await q('{"find": "tickets", "filter": {"updatedAt": {"$gte": {"$date": "2026-09-20T00:03:00Z"}}}, "sort": {"updatedAt": 1}}').expect(200)).body;
    expect(found).toMatchObject({ capped: true, label: 'internal' });
    expect(found.rows).toHaveLength(5);
    expect(found.rows[0][0]).toBe('t4');
    expect(found.rows[0][found.columns.indexOf('email')]).toMatch(/^••••/);
    const agg = (await q('{"aggregate": "tickets", "pipeline": [{"$group": {"_id": "$team", "n": {"$sum": 1}}}, {"$sort": {"_id": 1}}]}').expect(200)).body;
    expect(agg.rows).toEqual([['finance', 6], ['ops', 6]]);
    await q('{"find": "salaries"}').expect(422);
    await q('{"aggregate": "tickets", "pipeline": [{"$out": "copy"}]}').expect(422);

    // Past the parser, the read role still refuses a write stage.
    const raw = await openMongo({ host: u.hostname, address: u.hostname, port: Number(u.port || 27017), tls: false, database: DB, username: 'exprsn_reader', password: 'reader-pw', timeoutMs: 5000 });
    try {
      await expect(raw.aggregate('tickets', [{ $out: 'copy' }], { maxTimeMS: 5000 })).rejects.toThrow(/not authorized|Unauthorized/i);
    } finally {
      await raw.close();
    }
    expect(await admin.db(DB).listCollections({ name: 'copy' }).toArray()).toHaveLength(0);

    // A knowledge source over the collection, by watermark.
    const curator = await client(h, 'mcura', ['member', 'knowledge-curator'], 'confidential');
    const kb = (await curator.post('/api/knowledge/bases', { name: 'Tickets', label: 'internal', embedModel: 'nomic-embed-text', sharing: 'members' }).expect(201)).body;
    await curator.patch(`/api/knowledge/bases/${kb.id}`, { status: 'published' }).expect(200);
    const src = (await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 'database', connectionId: conn.id, location: 'mongo: tickets', fields: ['subject', 'body'] }).expect(201)).body;
    expect(src.config).toMatchObject({ watermarkColumn: 'updatedAt', idColumn: '_id' });
    await drain(h);
    expect(await h.s.db('knowledge_documents').where({ source_id: src.id })).toHaveLength(12);
    const hit = (await curator.post('/api/knowledge/search', { kbIds: [kb.id], query: 'payroll batch October', rerank: false }).expect(200)).body.hits[0];
    expect(hit).toMatchObject({ document: 'tickets #t1', source: 'mongo: tickets' });
    expect(hit.text).toContain('body: The payroll batch');
    expect(hit.text).not.toContain('email');
    await admin.db(DB).collection('tickets').insertOne({ _id: 't13' as never, subject: 'Ticket 13', body: 'Badges are printed on Tuesdays.', email: 'x@northwind.example', team: 'ops', updatedAt: new Date(Date.UTC(2026, 8, 21)) });
    await curator.post(`/api/knowledge/sources/${src.id}/sync`).expect(202);
    await drain(h);
    const job = (await h.s.db('jobs').where({ type: 'knowledge.sync' }).orderBy('created_at', 'desc').first()) as { result: string };
    expect(JSON.parse(job.result)).toMatchObject({ added: 1, changed: 0 });
  });
});
