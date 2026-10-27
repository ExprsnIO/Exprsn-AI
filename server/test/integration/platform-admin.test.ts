/*
 * Sprint 35b (1.6.0), the Overview and Jobs and queues screens, against real databases. Each block runs when its
 * variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 037b_platform_ops; two instances (each its own pool) beat into
 *                                  platform_instances and see each other; one drains the other, which stops claiming
 *                                  at its next beat while the first runs the job; a type paused on one instance stops
 *                                  the other claiming at its next poll; alerts acknowledged once although asked twice;
 *                                  the queue statistics, the job search, the schedules' last runs and the database size
 */
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { testConfig } from '../helpers.js';

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`Overview and Jobs and queues on ${d.name}`, () => {
    it('migrates 037b_platform_ops, drains one of two instances, pauses a type across them and reads the screens', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const a = createServices(cfg, db, createLogger('silent', false), new Metrics(), { instanceId: 'node-a:1001' });
      const db2 = createDb(cfg);
      const b = createServices(cfg, db2, createLogger('silent', false), new Metrics(), { instanceId: 'node-b:2002' });
      try {
        for (const t of ['platform_instances', 'job_type_pauses', 'schedule_pauses', 'platform_alert_acks']) expect(await db.schema.hasTable(t)).toBe(true);
        await bootstrap(a);
        const tenant = (await a.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const u = await a.users.create(tenant.id, { username: 'root', displayName: 'Root', clearance: 'internal' });
        await a.users.setRoles(u.id, 'direct', ['system-admin']);
        const p = (await loadPrincipal(a, tenant.id, u.id, {}))!;
        const by = { tenantId: tenant.id, actor: { user: u.id }, userId: u.id };

        const ran: string[] = [];
        a.jobs.register('test.echo', async (payload) => void ran.push(`a:${String(payload.n)}`));
        b.jobs.register('test.echo', async (payload) => void ran.push(`b:${String(payload.n)}`));

        // Both instances beat and each lists both.
        await a.instances.beat();
        await b.instances.beat();
        const seen = await a.instances.list();
        expect(seen.map((i) => i.id)).toEqual(['node-a:1001', 'node-b:2002']);
        expect(seen[0]).toMatchObject({ self: true, state: 'ready', checks: { database: 'ok', schema: 'ok' } });
        expect((await b.instances.list())[0]!.id).toBe('node-b:2002');

        // a drains b; b takes it from its row at its next beat (no shared bus here) and stops claiming.
        await a.instances.drain(by, 'node-b:2002');
        await expect(a.instances.drain(by, 'node-b:2002')).rejects.toThrow(/already draining/);
        expect(b.instances.draining).toBe(false);
        await b.instances.beat();
        expect(b.instances.draining).toBe(true);
        await a.jobs.enqueue({ tenantId: tenant.id, type: 'test.echo', payload: { n: 1 } });
        expect(await b.jobs.runDue()).toBe(0);
        expect(await a.jobs.runDue()).toBe(1);
        expect(ran).toEqual(['a:1']);
        expect((await a.instances.get('node-b:2002'))!.state).toBe('draining');

        // A type paused on a stops b claiming at b's next poll (b is drained, so use a second job on a fresh pair).
        b.instances.draining = false;
        await a.jobsAdmin.pauseType(p, 'test.echo', 'maintenance', null);
        await a.jobs.enqueue({ tenantId: tenant.id, type: 'test.echo', payload: { n: 2 } });
        expect(await b.jobs.runDue()).toBe(0);
        expect(b.jobs.isPaused('test.echo')).toBe(true);
        await a.jobsAdmin.resumeType(p, 'test.echo', null);
        expect(await b.jobs.runDue()).toBe(1);
        expect(ran).toEqual(['a:1', 'b:2']);

        // Queue statistics, the job list with a trace search and the counters.
        const q = await a.jobsAdmin.queues({ all: true, tenantId: null });
        const echo = q.items.find((t) => t.type === 'test.echo')!;
        expect(echo).toMatchObject({ queued: 0, running: 0, succeeded24h: 2, paused: false });
        expect(echo.p50Ms).not.toBeNull();
        const list = await a.jobsAdmin.list({ all: true, tenantId: null }, { type: 'test.echo', windowMs: 3600_000, q: '0123456789abcdef0123456789abcdef' });
        expect(list.items).toEqual([]);
        const all = await a.jobsAdmin.list({ all: true, tenantId: null }, { type: 'test.echo', state: 'succeeded' });
        expect(all.items).toHaveLength(2);
        const counters = await a.overview.counters(p, 3600_000);
        expect(counters).toMatchObject({ jobsScope: 'all tenants', queued: 0, running: 0, failed: 0 });

        // Schedules: the last runs by dedupe-key range, and a run now.
        a.scheduler.every('test.tick', 3600_000, async () => [{ tenantId: tenant.id, key: 'platform' }], 'test.echo');
        await new Promise((r) => setTimeout(r, 100));
        await a.scheduler.runNow('test.tick', u.id);
        const sched = (await a.jobsAdmin.schedules()).items.find((x) => x.name === 'test.tick')!;
        expect(sched.runs).toHaveLength(2);
        expect(sched.targets).toBe('platform');

        // An alert acknowledged twice at once is stored once.
        await a.ops.backups.watch(by);
        const alerts = await a.overview.alerts(p);
        const rpo = alerts.find((x) => x.kind === 'rpo')!;
        await Promise.all([a.overview.acknowledge(p, [rpo.key], null), a.overview.acknowledge(p, [rpo.key], null).catch(() => null)]);
        expect(await db('platform_alert_acks').where({ alert_key: rpo.key }).count({ n: '*' }).first()).toMatchObject({ n: expect.anything() });
        expect(Number(((await db('platform_alert_acks').where({ alert_key: rpo.key }).count({ n: '*' }).first()) as { n: number | string }).n)).toBe(1);
        expect((await a.overview.alerts(p)).some((x) => x.key === rpo.key)).toBe(false);

        // Capacity: the database's size from its own catalogue.
        const cap = await a.overview.capacity();
        expect(cap.database.client).toBe(d.client);
        expect(cap.database.bytes).toBeGreaterThan(0);

        // A clean stop removes the instance's row.
        await b.instances.stop();
        expect((await a.instances.list()).map((i) => i.id)).toEqual(['node-a:1001']);
      } finally {
        a.scheduler.stop();
        await b.close().catch(() => undefined);
        await a.close().catch(() => undefined);
        await db2.destroy();
        await db.destroy();
      }
    }, 120_000);
  });
}
