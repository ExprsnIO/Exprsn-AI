/*
 * Sprint 2–4 paths against real servers. Each block runs when its variable is set (CI sets them):
 *
 *   TEST_REDIS_URL   redis://localhost:6379        BullMQ job queue, the cross-instance bus, the Socket.io adapter
 *   TEST_PG_URL      postgres://…/exprsn_test      quotas, audit exports and chat on PostgreSQL
 *   TEST_MYSQL_URL   mysql://…/exprsn_test         the same on MySQL
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as ioClient } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices, type Services } from '../../src/services.js';
import { bootstrap } from '../../src/bootstrap.js';
import { createApp } from '../../src/http/app.js';
import { attachRealtime } from '../../src/realtime/socket.js';
import { Bus } from '../../src/platform/bus.js';
import { FakeOllama } from '../fake-ollama.js';
import { testConfig, localUser, login, type Harness } from '../helpers.js';

const REDIS = process.env.TEST_REDIS_URL;

describe.skipIf(!REDIS)('Redis', () => {
  it('fans bus messages out to other instances, not back to the sender', async () => {
    const log = createLogger('silent', false);
    const a = new Bus(log, REDIS);
    const b = new Bus(log, REDIS);
    const gotA: unknown[] = [];
    const gotB: unknown[] = [];
    a.on('t', (x) => gotA.push(x));
    b.on('t', (x) => gotB.push(x));
    await new Promise((r) => setTimeout(r, 200));
    a.publish('t', { n: 1 });
    await new Promise((r) => setTimeout(r, 300));
    expect(gotA).toEqual([{ n: 1 }]);
    expect(gotB).toEqual([{ n: 1 }]);
    await a.close();
    await b.close();
  });

  it('runs jobs through BullMQ and delivers notifications to a socket held by another instance', async () => {
    const mk = async () => {
      const cfg = testConfig({ REDIS_URL: REDIS!, JOB_QUEUE: 'bullmq', SQLITE_FILENAME: ':memory:' });
      const db = createDb(cfg);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      await bootstrap(s);
      return { s, db, cfg };
    };
    // Two instances; for the socket test they share one database file so sessions resolve on both.
    const file = `/tmp/exprsn-int-${Date.now()}.sqlite`;
    const A = await (async () => {
      const cfg = testConfig({ REDIS_URL: REDIS!, JOB_QUEUE: 'bullmq', SQLITE_FILENAME: file });
      const db = createDb(cfg);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      await bootstrap(s);
      return { s, db, cfg };
    })();
    const B = await (async () => {
      const cfg = testConfig({ REDIS_URL: REDIS!, JOB_QUEUE: 'bullmq', SQLITE_FILENAME: file, SESSION_SECRET: A.cfg.SESSION_SECRET, DATA_KEY: A.cfg.DATA_KEY! });
      const db = createDb(cfg);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      return { s, db, cfg };
    })();
    const solo = await mk();
    try {
      // BullMQ dispatch
      solo.s.jobs.register('it.echo', async (p) => ({ echo: p.v }));
      solo.s.jobs.start();
      const tenant = (await solo.s.tenants.list())[0]!;
      const job = await solo.s.jobs.enqueue({ tenantId: tenant.id, type: 'it.echo', payload: { v: 42 } });
      let row = await solo.s.jobs.get(tenant.id, job.id);
      for (let i = 0; i < 50 && row?.state !== 'succeeded'; i++) {
        await new Promise((r) => setTimeout(r, 100));
        row = await solo.s.jobs.get(tenant.id, job.id);
      }
      expect(row).toMatchObject({ state: 'succeeded', result: { echo: 42 } });

      // Socket held by instance A, notification raised on instance B
      const tenantId = (await A.s.tenants.list())[0]!.id;
      const h: Harness = { s: A.s, app: createApp(A.s), tenantId, close: async () => undefined };
      const user = await localUser(h, 'alice', ['member']);
      const { cookie } = await login(h, 'alice');
      const serverA: Server = createServer(h.app);
      const rt = attachRealtime(serverA, A.s);
      await new Promise<void>((r) => serverA.listen(0, '127.0.0.1', r));
      const sock = ioClient(`http://127.0.0.1:${(serverA.address() as AddressInfo).port}`, { path: '/socket.io', transports: ['websocket'], reconnection: false, extraHeaders: { cookie } });
      await new Promise((r) => sock.on('ready', r));
      const got = new Promise<{ title: string }>((r) => sock.on('notification', r));
      await new Promise((r) => setTimeout(r, 200));
      await B.s.notifications.notify({ tenantId, userIds: [user.id], kind: 'test', title: 'From the other instance' });
      expect((await got).title).toBe('From the other instance');
      sock.close();
      await rt.close();
      serverA.closeAllConnections();
      await new Promise((r) => serverA.close(r));
    } finally {
      for (const x of [solo, A, B]) {
        await x.s.close();
        await x.db.destroy();
      }
    }
  });
});

const dialects = [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
];

for (const d of dialects) {
  describe.skipIf(!d.url)(`chat, quotas and exports on ${d.name}`, () => {
    let s: Services;
    let ollama: FakeOllama;
    let h: Harness;

    beforeAll(async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url!, OLLAMA_POLL_MS: '600000' });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      await bootstrap(s);
      h = { s, app: createApp(s), tenantId: (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!.id, close: async () => undefined };
      ollama = await new FakeOllama().start();
    });
    afterAll(async () => {
      await s?.close();
      await s?.db.destroy();
      await ollama?.stop();
    });

    it('streams, meters, enforces the quota and exports usage', async () => {
      const repo = s.gateway.repo;
      ollama.addAvailable({ name: 'llama3.1:8b', size: 5e9, capabilities: ['completion'] });
      const pool = await repo.createPool({ name: `gpu-${Date.now()}`, accelerator: 'cuda', zone: 'inference', labelCeiling: 'confidential' });
      await repo.createInstance({ poolId: pool.id, name: 'gpu-1', url: ollama.url, deploy: 'docker', settings: {} });
      const m = await repo.createModel({ name: 'llama3.1:8b', source: 'test', expectedDigest: null, license: { name: 't' }, label: 'internal', notes: null, requestedBy: 'x', requestedTenant: h.tenantId });
      await repo.updateModel(m.id, { state: 'approved', import_state: 'pulled', capabilities: ['completion'] });
      await repo.place(m.id, pool.id, 'warm', 'x');
      const t = Date.now();
      await repo.createProfile({ id: '01PROFILEGENERAL0000000000', tenant_id: h.tenantId, name: 'general', display_name: 'General', description: null, alias_of: null, model_id: m.id, pool_id: pool.id, num_ctx: 4096, temperature: 0.5, think_default: 'off', think_ceiling: 'off', system_prompt: null, fallback: null, canary: null, tools: [], label: 'internal', status: 'published', version: 1, updated_by: null, created_at: t, updated_at: t });
      await s.gateway.pollAll();

      await localUser(h, 'bob', ['member']);
      const b = await login(h, 'bob');
      const sent = await b.agent.post('/api/chat').set('x-csrf-token', b.csrf).send({ content: 'Hello', profile: 'general' }).expect(202);
      let view;
      for (let i = 0; i < 50; i++) {
        view = (await b.agent.get(`/api/conversations/${sent.body.conversationId}`).expect(200)).body;
        if (view.messages[1].state === 'complete') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(view.messages[1]).toMatchObject({ content: 'You said: Hello', state: 'complete' });
      const used = await s.quotas.used(h.tenantId, null);
      expect(used.tokensToday).toBeGreaterThan(0);
      await s.quotas.set(h.tenantId, null, { tokensPerDay: 1 }, 'x');
      await b.agent.post('/api/chat').set('x-csrf-token', b.csrf).send({ content: 'Again', profile: 'general' }).expect(429);
      const sum = await s.quotas.summary(h.tenantId, 'model', 20000101, 29991231);
      expect(sum[0]).toMatchObject({ key: 'llama3.1:8b', requests: 1 });
      const daily = await s.quotas.daily(h.tenantId, 20000101, 29991231);
      expect(daily[0]!.tokens).toBe(used.tokensToday);
      const x = await s.exports.request({ tenantId: h.tenantId, tenantSlug: 'default', kind: 'usage', params: {}, scope: 'test', maxLabel: 'internal', userId: 'x' });
      await s.jobs.runDue();
      expect((await s.exports.get(h.tenantId, x.id))?.state).toBe('ready');
      const a = await s.exports.request({ tenantId: h.tenantId, tenantSlug: 'default', kind: 'audit', params: { actor: 'bob' }, scope: 'test', maxLabel: 'internal', userId: 'x' });
      await s.jobs.runDue();
      const csv = (await s.exports.content((await s.exports.get(h.tenantId, a.id))!))!.toString();
      expect(csv).toContain('auth.login');
      expect((await s.checkpoints.verify(h.tenantId)).status).toBe('verified');
    });
  });
}
