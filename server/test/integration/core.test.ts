/*
 * Sprint 24c (1.4.0) against real servers. Each block runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 026c_core and `migrate --check`; plugin installs and their lifecycle,
 *                                  with two transitions racing from one state (only one applies)
 *   TEST_REDIS_URL                 the read-through cache: shared entries in Redis, and bus invalidation across
 *                                  instances for the memory store
 */
import { describe, expect, it } from 'vitest';
import { Registry } from 'prom-client';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { migrateCheck } from '../../src/db/schema.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { Bus } from '../../src/platform/bus.js';
import { MemoryCacheStore, RedisCacheStore, TenantCache } from '../../src/platform/cache.js';
import { createServices } from '../../src/services.js';
import { testConfig } from '../helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const manifest = { key: 'flag-notifier', name: 'Flag notifier', version: '1.0.0', kind: 'declarative', events: ['flag.*'], capabilities: ['read:events', 'emit:notification'], actions: [{ type: 'notify', on: 'flag.created' }] };

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`platform core on ${d.name}`, () => {
    it('migrates 026c_core, reports up to date, and runs the plugin lifecycle with racing transitions refused', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        const names = await migrationSource.getMigrations([]);
        expect(await migrateCheck(db)).toMatchObject({ state: 'current', pending: [], database: names.at(-1), destructive: [] });
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const op = { userId: null, clearance: 'restricted' as const, audit: { service: 'test' } };
        const p = await s.plugins.install(tenant.id, op, { manifest, maxLabel: 'internal', config: {} });
        expect(p.state).toBe('installed');
        await expect(s.plugins.install(tenant.id, op, { manifest, maxLabel: 'internal' })).rejects.toThrow(/already installed/);
        // two enables at once from `installed`: one applies, the other is refused
        const r = await Promise.allSettled([s.plugins.transition(tenant.id, op, p.id, 'enable'), s.plugins.transition(tenant.id, op, p.id, 'enable')]);
        expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
        expect(await s.plugins.enabled(tenant.id)).toEqual([expect.objectContaining({ key: 'flag-notifier' })]);
        await s.plugins.transition(tenant.id, op, p.id, 'remove');
        const again = await s.plugins.install(tenant.id, op, { manifest: { ...manifest, version: '1.0.1' }, maxLabel: 'internal' });
        expect(again).toMatchObject({ id: p.id, version: '1.0.1', state: 'installed' });
        expect((await s.plugins.transitions(tenant.id, p.id)).map((t) => t.event)).toEqual(['install', 'enable', 'remove', 'install']);
      } finally {
        await s.close();
        await db.destroy();
      }
    }, 120_000);
  });
}

const REDIS = process.env.TEST_REDIS_URL;

describe.skipIf(!REDIS)('read-through cache on Redis', () => {
  const log = createLogger('silent', false);
  const ttl = { short: 5, medium: 60, long: 600 };

  it('shares entries in Redis and clears them for every instance', async () => {
    const bus = new Bus(log, REDIS);
    const prefix = `exprsn:test:${Date.now()}`;
    const a = new TenantCache(new RedisCacheStore(REDIS!), bus, new Registry(), { ttlSeconds: ttl, prefix });
    const b = new TenantCache(new RedisCacheStore(REDIS!), bus, new Registry(), { ttlSeconds: ttl, prefix });
    try {
      let n = 0;
      const load = async () => ({ n: ++n });
      expect(await a.get('T1', 'webhooks', 'active', 'medium', load)).toEqual({ n: 1 });
      expect(await b.get('T1', 'webhooks', 'active', 'medium', load)).toEqual({ n: 1 });
      await b.invalidate({ tenantId: 'T1', ns: 'webhooks', key: 'active' });
      expect(await a.get('T1', 'webhooks', 'active', 'medium', load)).toEqual({ n: 2 });
      await a.invalidate({ tenantId: 'T1', ns: 'webhooks' });
      expect(await b.get('T1', 'webhooks', 'active', 'medium', load)).toEqual({ n: 3 });
    } finally {
      await a.close();
      await b.close();
      await bus.close();
    }
  });

  it('a bus invalidation on one instance clears a memory entry on another', async () => {
    const busA = new Bus(log, REDIS);
    const busB = new Bus(log, REDIS);
    const a = new TenantCache(new MemoryCacheStore(), busA, new Registry(), { ttlSeconds: ttl });
    const b = new TenantCache(new MemoryCacheStore(), busB, new Registry(), { ttlSeconds: ttl });
    try {
      await sleep(200);
      let v = 1;
      const read = (c: TenantCache) => c.get('T1', 'profiles', 'general', 'long', async () => v);
      expect(await read(b)).toBe(1);
      v = 2;
      await a.invalidate({ tenantId: 'T1', ns: 'profiles', key: 'general' });
      for (let i = 0; i < 50 && (await read(b)) !== 2; i++) await sleep(20);
      expect(await read(b)).toBe(2);
    } finally {
      await a.close();
      await b.close();
      await busA.close();
      await busB.close();
    }
  });
});
