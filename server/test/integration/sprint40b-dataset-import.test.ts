/*
 * 1.7.0, Sprint 40b against real databases. Each block runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 042b_dataset_import; B-3804: a CKAN datastore read page by page by the
 *                                  job queue on the database into a training version whose scrub, hash and splits land
 *                                  on the row (`source_kind` import, `import_id`), and the import's `result` column.
 */
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { testConfig } from '../helpers.js';
import { startFakePortal } from '../sprint40b-fakes.js';

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`Sprint 40b on ${d.name}`, () => {
    it('migrates 042b_dataset_import; a datastore import lands as a scrubbed training version with its result on the import', async () => {
      const portal = await startFakePortal();
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url!, IMPORT_ALLOWED_HOSTS: '127.0.0.1', IMPORT_HARVEST_TICK_MINUTES: '0', IMPORT_BUNDLE_POLL_MINUTES: '0' });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        for (const c of ['result', 'rows_total', 'sample_rows', 'dataset_id', 'kb_id', 'classifier_id', 'eval_set']) expect(await db.schema.hasColumn('import_jobs', c), c).toBe(true);
        expect(await db.schema.hasColumn('training_datasets', 'import_id')).toBe(true);
        await bootstrap(s);
        s.imports.registerJobs();
        s.training.registerJobs();
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const mk = async (username: string, roles: string[]) => {
          const u = await s.users.create(tenant.id, { username, displayName: username, clearance: 'restricted' });
          await s.users.update(tenant.id, u.id, { clearance_direct: 'restricted' });
          await s.users.setRoles(u.id, 'direct', roles);
          return (await loadPrincipal(s, tenant.id, u.id, {}))!;
        };
        const a = await mk('dsa', ['model-admin', 'tenant-admin', 'ml-admin']);
        const b = await mk('dsb', ['model-admin']);
        const repo = await s.imports.repositories.propose(a, { name: 'portal (fake)', type: 'ckan', baseUrl: `${portal.url}/api/3`, region: 'US', harvestMinutes: null });
        await s.imports.repositories.confirm(b, repo.id, null);
        for (let i = 0; i < 6; i++) await s.jobs.runDue(50);

        const created = await s.imports.datasets.request(a, { repositoryId: repo.id, item: 'consumer-complaints', resources: ['ds-complaints'], target: 'training', label: 'confidential', sample: 1500, training: { name: 'complaints-it', textColumn: 'narrative', labelColumn: 'product' } });
        expect(created.state).toBe('queued');
        for (let i = 0; i < 10; i++) if (!(await s.jobs.runDue(50))) break;
        const imp = await s.imports.view(tenant.id, (await s.imports.row(tenant.id, created.id))!);
        expect(imp.state, JSON.stringify(imp.log)).toBe('complete');
        expect(imp.result).toMatchObject({ rows: 1500, sampled: true });
        expect(imp.datasetId).toBeTruthy();
        const row = (await db('training_datasets').where({ id: imp.datasetId }).first()) as Record<string, unknown>;
        expect(row).toMatchObject({ state: 'ready', source_kind: 'import', import_id: created.id, rows: 1500 });
        expect(String(row.hash)).toMatch(/^sha256:/);
        expect(JSON.parse(String(row.scrub)).byKind.email).toBe(1500);
        const stored = (await db('import_jobs').where({ id: created.id }).first()) as Record<string, unknown>;
        expect(JSON.parse(String(stored.result)).hash).toBe(imp.result!.hash);
        expect(Number(stored.rows_total)).toBe(1500);
      } finally {
        await s.close().catch(() => undefined);
        await db.destroy();
        await portal.close();
      }
    }, 180_000);
  });
}
