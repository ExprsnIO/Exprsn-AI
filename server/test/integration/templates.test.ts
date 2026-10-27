/*
 * Sprint 35d (1.6.0, B-4501), tenant provisioning templates against real databases. Each block runs when its
 * variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   a tenant provisioned from the team and enterprise templates (workspaces, custom
 *                                  roles, draft profiles pinned to a pool, the first admin in every workspace, the
 *                                  audit chain intact), and a taken slug refused with nothing written
 */
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { provisionTenant } from '../../src/tenancy/templates.js';
import { testConfig } from '../helpers.js';

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`tenant templates on ${d.name}`, () => {
    it('provisions tenants from templates with their first admin', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        await bootstrap(s);
        await s.gateway.repo.createPool({ name: 'gpu-it', description: null, accelerator: 'cuda', zone: 'inference', labelCeiling: 'confidential' });
        const by = { tenantId: null, userId: null, actor: { service: 'test' } };
        const team = await provisionTenant(s, by, { template: 'team', slug: 'it-team', name: 'IT Team', admin: { username: 'ada', displayName: 'Ada', password: 'a long integration password 1' } });
        expect(team.applied.workspaces.map((w) => w.name)).toEqual(['Team', 'Projects']);
        expect(team.applied.zone.state).toBe('pinned');
        expect(team.applied.issuer.state).toBe('skipped');
        expect((await s.customRoles.list(team.tenant.id)).map((r) => r.role.name)).toEqual(['Contributor']);
        expect((await s.gateway.repo.profiles(team.tenant.id)).map((p) => [p.name, p.status])).toEqual([['assistant', 'draft']]);
        expect((await s.tenants.workspacesForUser(team.tenant.id, team.admin.id)).length).toBe(2);
        expect((await s.users.roleIds(team.admin.id))).toContain('tenant-admin');
        expect((await s.audit.verify(team.tenant.id)).status).toBe('verified');

        const ent = await provisionTenant(s, by, { template: 'enterprise', slug: 'it-ent', name: 'IT Enterprise', admin: { username: 'gina', displayName: 'Gina', password: null } });
        expect(ent.applied.workspaces).toHaveLength(5);
        expect(ent.applied.profiles).toHaveLength(3);
        expect(ent.admin.enrolLink).toMatch(/tenant=it-ent/);

        const before = Number(((await db('tenants').count({ n: '*' })) as { n: number | string }[])[0]!.n);
        await expect(provisionTenant(s, by, { template: 'personal', slug: 'it-team', name: 'Again', admin: { username: 'x', displayName: 'X', password: null } })).rejects.toMatchObject({ status: 409 });
        expect(Number(((await db('tenants').count({ n: '*' })) as { n: number | string }[])[0]!.n)).toBe(before);
      } finally {
        await s.close();
        await db.destroy();
      }
    }, 120_000);
  });
}
