/*
 * B-43 (model servers beyond Ollama) against real databases. Each block runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 037_model_servers; a kind openai instance on a fake Chat Completions
 *                                  server, polled healthy with what it reported kept in its settings; a server-held
 *                                  catalogue entry (format server, no digest) placed warm and evaluated on it; load
 *                                  and unload recorded as unsupported; the token columns written and cleared.
 */
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { FakeOpenAIServer } from '../fake-openai-server.js';
import { testConfig } from '../helpers.js';

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`model servers on ${d.name}`, () => {
    it('migrates 037_model_servers and serves a server-held model through a Chat Completions instance', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url!, OLLAMA_POLL_MS: '600000' });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      const fm = new FakeOpenAIServer();
      fm.add({ id: 'system', ownedBy: 'Apple' }).add({ id: 'pcc', available: false, reason: 'PCC inference is not available in this context.' });
      await fm.start();
      try {
        for (const col of ['kind', 'socket_path', 'token_ref', 'token_tenant', 'token_owner']) expect(await db.schema.hasColumn('instances', col)).toBe(true);
        for (const col of ['server_instance_id', 'server_model']) expect(await db.schema.hasColumn('models', col)).toBe(true);
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const repo = s.gateway.repo;
        const pool = await repo.createPool({ name: 'apple', accelerator: 'metal', zone: 'inference', labelCeiling: 'confidential' });
        // An instance from before the migration reads as Ollama.
        const old = await repo.createInstance({ poolId: pool.id, name: 'legacy', url: 'http://127.0.0.1:1', deploy: 'docker', settings: {} });
        expect((await repo.instance(old.id))!.kind).toBe('ollama');
        await repo.deleteInstance(old.id);
        const inst = await repo.createInstance({ poolId: pool.id, name: 'mac-1-fm', url: fm.url, deploy: 'baremetal', settings: { hardware: 'M2 Max' }, kind: 'openai', token: { ref: 'vault:model-servers/x#token', tenantId: tenant.id, ownerId: 'U'.repeat(26) } });
        await repo.updateInstance(inst.id, { token_ref: null, token_tenant: null, token_owner: null });
        await s.gateway.pollAll();
        const row = (await repo.instance(inst.id))!;
        expect(row).toMatchObject({ kind: 'openai', health: 'healthy', version: 'fm serve', token_ref: null, socket_path: null });
        expect(row.settings.hardware).toBe('M2 Max');
        expect(row.settings.reported?.models?.map((m) => [m.id, m.available])).toEqual([
          ['system', true],
          ['pcc', false]
        ]);

        const m = await repo.createModel({ name: 'system', source: 'server:mac-1-fm/system', expectedDigest: null, license: { name: 'Apple terms' }, label: 'internal', notes: null, requestedBy: 'R'.repeat(26), requestedTenant: tenant.id, server: { instanceId: inst.id, model: 'system', capabilities: ['completion'], contextLength: null, family: 'Apple' } });
        expect((await repo.model(m.id))!).toMatchObject({ format: 'server', import_state: 'pulled', expected_digest: null, digest: null, server_instance_id: inst.id, server_model: 'system', family: 'Apple' });
        await repo.place(m.id, pool.id, 'warm', 'x');
        const job = await s.jobs.enqueue({ tenantId: tenant.id, type: 'model.evaluate', payload: { modelId: m.id }, createdBy: null, maxAttempts: 1 });
        await s.jobs.runDue();
        expect((await db('jobs').where({ id: job.id }).first()).state).toBe('succeeded');
        const evaluated = (await repo.model(m.id))!;
        expect(evaluated.state).toBe('evaluated');
        expect(evaluated.capabilities).toEqual(['completion', 'tools']);
        expect(await s.gateway.load(inst.id, 'system', { actor: 'it' })).toEqual({ evicted: [], unsupported: true });
        expect(await s.gateway.unload(inst.id, 'system', 'it')).toEqual({ unsupported: true });
        expect((await repo.events(inst.id)).filter((e) => e.event === 'unsupported')).toHaveLength(2);
        expect((await repo.events(inst.id)).some((e) => e.event === 'dropped')).toBe(true); // think, from the evaluation
      } finally {
        await fm.stop();
        await s.gateway.stop();
        await s.close();
        await db.destroy();
      }
    }, 60_000);
  });
}
