/*
 * Sprint 23 (B-1504): ordered webhook deliveries across two instances on a real database, where the position
 * counter's row lock and the delivery lease have to hold under concurrent transactions (PostgreSQL and MySQL).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { testConfig } from '../helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`ordered webhooks across instances on ${d.name}`, () => {
    it('two instances raising events at once allocate gap-free positions and deliver one at a time in order', async () => {
      const got: string[] = [];
      let inFlight = 0;
      let maxInFlight = 0;
      const server: Server = createServer((req, res) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        req.resume();
        req.on('end', () =>
          setTimeout(() => {
            got.push(String(req.headers['x-exprsn-sequence']));
            inFlight--;
            res.end('ok');
          }, 20)
        );
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url!, WEBHOOK_RETRY_BASE_MS: '10' });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const one = createServices(cfg, db, createLogger('silent', false), new Metrics());
      const two = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        await bootstrap(one);
        const tenant = (await one.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const { row: w } = await one.webhooks.create(tenant.id, 'test', { name: 'ledger', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, events: ['demo.*'], maxLabel: 'internal', ordered: true });
        await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? one : two).webhooks.emit(tenant.id, 'demo.step', 'internal', `ev-${i}`, { i })));
        const seqs = ((await db('webhook_deliveries').where({ webhook_id: w.id }).orderBy('seq')) as { seq: number | string }[]).map((r) => Number(r.seq));
        expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
        for (let i = 0; i < 200 && got.length < 20; i++) {
          await Promise.all([one.jobs.runDue(), two.jobs.runDue()]);
          await sleep(10);
        }
        expect(got).toEqual(seqs.map(String));
        expect(maxInFlight).toBe(1);
      } finally {
        await one.close();
        await two.close();
        await db.destroy();
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
      }
    }, 120_000);
  });
}
