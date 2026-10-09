/*
 * 1.6.0, Sprint 39b against real databases. Each block runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 041b_app_packages; B-8201: a package built, stored sealed (mediumtext on
 *                                  MySQL) and opened again with its hash intact, and imported as a new app; B-8202,
 *                                  B-8203: a pipeline's promotion to test run by the job queue on the database, with
 *                                  the backup taken first and the history row's report.
 */
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { entityDefinitionSchema } from '../../src/apps/schema.js';
import { AppPackages } from '../../src/apps/packages.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { testConfig } from '../helpers.js';

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`Sprint 39b on ${d.name}`, () => {
    it('migrates 041b_app_packages; packages store sealed and open again; a promotion to test runs on the database', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        for (const t of ['app_packages', 'app_pipelines', 'app_deployments']) expect(await db.schema.hasTable(t), t).toBe(true);
        await bootstrap(s);
        s.apps.registerJobs();
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const ws = await s.tenants.createWorkspace(tenant.id, 'Sales', 'confidential');
        const u = await s.users.create(tenant.id, { username: 'dee', displayName: 'Dee', clearance: 'confidential' });
        await s.users.update(tenant.id, u.id, { clearance_direct: 'confidential' });
        await s.users.setRoles(u.id, 'direct', ['workflow-admin', 'member']);
        await s.tenants.addMember(ws.id, u.id);
        const p = (await loadPrincipal(s, tenant.id, u.id, {}))!;
        p.workspaceId = ws.id;
        const actor = { principal: p, source: 'api' as const };

        // ---- B-8201: a package with records, stored sealed and opened, imported as a new app ----
        const dev = await s.apps.create(actor, { name: 'crm', title: 'CRM', label: 'confidential', workspaceId: ws.id });
        const { entity } = await s.apps.createEntity(actor, dev.name, { name: 'deal', title: 'Deal', label: 'internal', definition: entityDefinitionSchema.parse({ fields: [{ name: 'title', type: 'string', required: true, indexed: true, unique: true, maxLength: 120 }, { name: 'amount', type: 'number', indexed: true }] }) });
        await s.apps.forms.create(actor, dev.name, { name: 'new_deal', entity: 'deal', definition: { fields: [{ field: 'title' }] } as never });
        await s.apps.policies.create(actor, dev, { name: 'Everyone', description: null, enabled: true, entity: null, subjects: [{ kind: 'everyone' }], rows: null, fields: {}, otherFields: { read: true, unmasked: true, create: true, update: true } });
        for (let i = 0; i < 3; i++) await s.apps.createRecord(actor, dev, entity, { values: { title: `Deal ${i}`, amount: i * 10 } });
        const { row, pkg } = await s.apps.packages.create(actor, dev, { withData: true, note: 'with data' });
        expect(row).toMatchObject({ version: 1, with_data: true, source: 'export', hash: AppPackages.hashOf(pkg) });
        expect(pkg.records).toHaveLength(3);
        const opened = await s.apps.packages.open(tenant.id, row.id);
        expect(opened.pkg).toEqual(pkg);
        expect((await db('app_packages').where({ id: row.id }).first('body'))!.body).not.toContain('Deal 0'); // sealed
        const imported = await s.apps.packages.importNew(actor, await s.apps.packages.verify(actor, pkg), { name: 'crm_copy', workspaceId: ws.id });
        expect(imported.report).toMatchObject({ entities: { created: ['deal'] }, forms: { created: ['new_deal'] }, policies: { created: 1 }, records: { created: 3, skipped: [] } });
        const copy = await s.apps.resolve(p, 'crm_copy', 'deal');
        expect((await s.apps.query(p, copy.app.name, 'deal', {})).total).toBe(3);

        // ---- B-8202, B-8203: a pipeline and a promotion to test, by the job queue ----
        const test = await s.apps.create(actor, { name: 'crm_test', title: 'CRM test', label: 'confidential', workspaceId: ws.id });
        const prod = await s.apps.create(actor, { name: 'crm_prod', title: 'CRM prod', label: 'confidential', workspaceId: ws.id });
        const pipeline = await s.apps.pipelines.create(actor, { name: 'CRM', development: dev.name, test: test.name, production: prod.name, approvalWorkflow: null });
        const dep = await s.apps.pipelines.promote(actor, pipeline.id, { to: 'test', note: 'first' });
        expect(dep).toMatchObject({ state: 'queued', version: 2, from: 'development', to: 'test' });
        for (let i = 0; i < 5 && (await s.jobs.runDue()); i++);
        const done = await s.apps.pipelines.deploymentFor(p, dep.id);
        expect(done).toMatchObject({ state: 'succeeded', backupPackageId: expect.any(String), report: { entities: { created: ['deal'] }, forms: { created: ['new_deal'] }, policies: { created: 1 } } });
        expect((await s.apps.entities((await s.apps.appById(tenant.id, test.id))!)).map((e) => e.name)).toEqual(['deal']);
        const history = await s.apps.pipelines.history(p, pipeline.id);
        expect(history.map((h) => [h.kind, h.to, h.state])).toEqual([['promotion', 'test', 'succeeded']]);
        expect((await s.apps.packages.list(test)).map((x) => x.source)).toEqual(['backup']);
        await expect(s.apps.pipelines.promote(actor, pipeline.id, { to: 'production' })).rejects.toMatchObject({ status: 409 }); // no approval workflow
        const audit = await db('audit_events').where({ tenant_id: tenant.id, action: 'app.package.promoted' });
        expect(audit).toHaveLength(1);
      } finally {
        await s.close();
        await db.destroy();
      }
    }, 120_000);
  });
}
