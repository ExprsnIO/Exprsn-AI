/*
 * Sprint 25d (1.4.0) against real databases. Each block runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 027d_plugins; an event delivered once to a plugin however often it is
 *                                  offered; declarative actions with a refused one audited; a script handler's
 *                                  brokered calls (a granted one answered, an ungranted one 403) with its token stored
 *                                  hashed and revoked; the concurrency bound across the invocation table
 */
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { migrateCheck } from '../../src/db/schema.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { testConfig } from '../helpers.js';
import { ScriptedSession } from '../sprint25d-fakes.js';

const declarative = { key: 'flag-relay', name: 'Flag relay', version: '1.0.0', kind: 'declarative', events: ['flag.*'], capabilities: ['read:events', 'emit:log', 'emit:flag'], optionalCapabilities: ['emit:flag'], actions: [{ type: 'log', on: 'flag.created', with: { message: 'saw {{event.data.flag}}' } }, { type: 'flag', on: 'flag.created' }] };
const script = { key: 'flag-handler', name: 'Flag handler', version: '1.0.0', kind: 'script', events: ['flag.created'], capabilities: ['read:events', 'emit:log', 'call:workflow'], optionalCapabilities: ['call:workflow'], script: { entry: 'main', source: 'export async function main() { return null }' } };

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`plugins that run on ${d.name}`, () => {
    it('migrates 027d_plugins and runs actions, handlers and the bounds', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url!, PLUGINS_REQUIRE_SIGNED: 'none', PLUGIN_CONCURRENCY: '1' });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        const names = await migrationSource.getMigrations([]);
        expect(names).toContain('027d_plugins');
        expect(await migrateCheck(db)).toMatchObject({ state: 'current', pending: [], database: names.at(-1), destructive: [] });
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const op = { userId: null, clearance: 'restricted' as const, audit: { service: 'test' } };

        const p = await s.plugins.install(tenant.id, op, { manifest: declarative, maxLabel: 'internal', grants: ['read:events', 'emit:log'] });
        await s.plugins.transition(tenant.id, op, p.id, 'enable');
        const data = { flag: 'F-9', id: '01JFLAG0000000000000000000', action: 'created', severity: 'low', checkpoint: 'user-input' };
        // offered twice (two instances seeing it): delivered once
        expect(await s.pluginRuntime.offer(tenant.id, 'flag.created', 'internal', 'flag-event:x1', data)).toBe(1);
        expect(await s.pluginRuntime.offer(tenant.id, 'flag.created', 'internal', 'flag-event:x1', data)).toBe(0);
        await s.jobs.runDue();
        const inv = await db('plugin_invocations').where({ plugin_id: p.id }).first();
        expect(inv).toMatchObject({ state: 'failed' });
        expect(JSON.parse(inv.outcome).actions.map((a: { type: string; ok: boolean }) => `${a.type}:${a.ok}`)).toEqual(['log:true', 'flag:false']);
        expect(await db('audit_events').where({ action: 'plugin.action.refused' }).count({ n: '*' }).first()).toMatchObject({ n: expect.anything() });
        expect((await s.pluginRuntime.logsOf(tenant.id, p.id))[0]).toMatchObject({ message: 'saw F-9' });

        const runner = new ScriptedSession();
        s.scripts.runner = runner;
        const seen: number[] = [];
        let token = '';
        runner.play = async (hello, call) => {
          token = hello.token;
          seen.push((await call('log', { message: 'hi' })).status, (await call('workflow', { workflow: 'x' })).status);
          return null;
        };
        const sp = await s.plugins.install(tenant.id, op, { manifest: script, maxLabel: 'internal' });
        await s.plugins.transition(tenant.id, op, sp.id, 'enable');
        expect(await s.pluginRuntime.offer(tenant.id, 'flag.created', 'internal', 'flag-event:x2', data)).toBe(2);
        await s.jobs.runDue();
        expect(seen).toEqual([200, 403]);
        const tok = await db('plugin_tokens').where({ plugin_id: sp.id }).first();
        expect(tok.revoked_at).not.toBeNull();
        expect(tok.token_hash).not.toBe(token);

        // the concurrency bound reads the invocation table: with one running, the next waits as a queued job
        await s.pluginRuntime.offer(tenant.id, 'flag.created', 'internal', 'flag-event:x3', data);
        await s.pluginRuntime.offer(tenant.id, 'flag.created', 'internal', 'flag-event:x4', data);
        const [a, b] = (await db('plugin_invocations').where({ plugin_id: p.id, state: 'queued' }).orderBy('created_at')) as { id: string }[];
        await db('plugin_invocations').where({ id: a!.id }).update({ state: 'running', started_at: Date.now() });
        expect(await s.pluginRuntime.invoke(b!.id, new AbortController().signal)).toMatchObject({ deferred: expect.any(String) });
        expect(await db('plugin_invocations').where({ id: b!.id }).first()).toMatchObject({ state: 'queued' });
      } finally {
        await s.close();
        await db.destroy();
      }
    }, 120_000);
  });
}
