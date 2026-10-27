/*
 * 1.6.0, Sprint 38c against real databases. Each block runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 040c_policies_dlp; B-8101/B-8102: a policy's row condition and field
 *                                  masks applied to record queries, counts and reads (the policy filter joins the
 *                                  value index like any filter; PostgreSQL's COLLATE "C" path included); B-7601: DLP
 *                                  rules and patterns stored and tried; B-7602: an active hold read by retention;
 *                                  B-7603: an export written as sealed parts and read back.
 */
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { entityDefinitionSchema } from '../../src/apps/schema.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { testConfig } from '../helpers.js';

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`Sprint 38c on ${d.name}`, () => {
    it('migrates 040c_policies_dlp; policies narrow queries and mask fields; DLP, holds and exports work on the database', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        for (const t of ['app_policies', 'dlp_rules', 'dlp_patterns', 'legal_holds', 'compliance_exports']) expect(await db.schema.hasTable(t), t).toBe(true);
        expect(await db.schema.hasColumn('users', 'attributes')).toBe(true);
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const ws = await s.tenants.createWorkspace(tenant.id, 'Sales', 'confidential');
        const person = async (username: string, roles: string[], attributes: Record<string, string> | null = null) => {
          const u = await s.users.create(tenant.id, { username, displayName: username.toUpperCase(), clearance: 'confidential' });
          await s.users.update(tenant.id, u.id, { clearance_direct: 'confidential', ...(attributes ? { attributes: JSON.stringify(attributes) } : {}) });
          await s.users.setRoles(u.id, 'direct', roles);
          await s.tenants.addMember(ws.id, u.id);
          const p = (await loadPrincipal(s, tenant.id, u.id, {}))!;
          p.workspaceId = ws.id;
          return { u, p };
        };
        const dee = await person('dee', ['workflow-admin', 'member']);
        const ana = await person('ana', ['member'], { region: 'emea' });
        const cat = await person('cat', ['member']);
        const actor = (p: typeof dee.p) => ({ principal: p, source: 'api' as const });

        // ---- B-8101, B-8102 ----
        const app = await s.apps.create(actor(dee.p), { name: 'crm', title: 'CRM', label: 'confidential', workspaceId: ws.id });
        const { entity } = await s.apps.createEntity(actor(dee.p), app.name, {
          name: 'deal',
          title: 'Deal',
          label: 'internal',
          definition: entityDefinitionSchema.parse({ fields: [{ name: 'title', type: 'string', required: true, indexed: true, unique: true, maxLength: 120 }, { name: 'region', type: 'string', indexed: true, maxLength: 20 }, { name: 'ssn', type: 'string', maxLength: 20 }] })
        });
        for (const [title, region, ssn] of [['Contoso', 'emea', '123-45-6789'], ['Fabrikam', 'EMEA', '987-65-4321'], ['Tailspin', 'apac', '555-66-7777']] as const) await s.apps.createRecord(actor(dee.p), app, entity, { values: { title, region, ssn } });
        await s.apps.policies.create(actor(dee.p), app, { name: 'Own region', description: null, enabled: true, entity: 'deal', subjects: [{ kind: 'role', value: 'member' }], rows: { field: 'region', op: 'eq', value: '$user.attributes.region' }, fields: { ssn: { read: true, unmasked: false, create: true, update: true, mask: 'last4' } }, otherFields: { read: true, unmasked: true, create: true, update: true } });
        const page = await s.apps.query(ana.p, 'crm', 'deal', { sort: [{ field: 'title', dir: 'asc' }] });
        // Text compares on lower-cased NFC, so EMEA matches emea on every dialect.
        expect(page.records.map((r) => r.values.title)).toEqual(['Contoso', 'Fabrikam']);
        expect(page.total).toBe(2);
        expect(page.records[0]!.values.ssn).toBe('***-**-6789');
        expect(page.records[0]!.masked).toEqual({ ssn: 'last4' });
        const tailspin = (await s.apps.query(dee.p, 'crm', 'deal', { filter: { field: 'title', op: 'eq', value: 'Tailspin' } })).records[0]!;
        await expect(s.apps.get(ana.p, 'crm', 'deal', tailspin.id)).rejects.toMatchObject({ status: 404 });
        expect((await s.apps.query(cat.p, 'crm', 'deal', {})).total).toBe(0);
        expect((await s.apps.aggregate(ana.p, 'crm', 'deal', { metrics: [{ op: 'count' }] })).groups[0]!.values).toEqual([2]);
        const explain = await s.apps.policies.explain(app, entity, { userId: ana.u.id, recordId: tailspin.id, field: 'ssn' });
        expect(explain).toMatchObject({ policed: true, record: { reachable: false }, field: { read: true, unmasked: false, mask: 'last4' } });

        // ---- B-7601 ----
        const pat = await s.dlp.createPattern(dee.p, null, { name: 'Project codes', pattern: 'PROJ-\\d{4}', label: 'confidential', enabled: true });
        await s.dlp.createRule(dee.p, null, { name: 'Cards and codes', enabled: true, detectors: ['payment_card', `pattern:${pat.id}`], raiseTo: 'confidential', action: 'redact', scopes: ['answer', 'agent', 'upload'] });
        const out = await s.dlp.inspect({ tenantId: tenant.id, text: 'Pay 4111 1111 1111 1111 for PROJ-1234', scope: 'answer', label: 'internal' });
        expect(out).toMatchObject({ label: 'confidential', raised: true, action: 'redact', text: 'Pay [redacted payment card] for [redacted pattern:Project codes]' });

        // ---- B-7602 ----
        const root = await person('root', ['tenant-admin']);
        const two = await person('two', ['tenant-admin']);
        const hold = await s.legalHolds.request({ p: root.p, ip: null }, { scope: 'user', scopeId: ana.u.id, reason: 'Case 1', approverId: two.u.id });
        expect(await s.legalHolds.held(tenant.id)).toEqual({ users: [], workspaces: [] });
        await s.legalHolds.decide({ p: two.p, ip: null }, hold.id, 'approved', null);
        expect(await s.legalHolds.held(tenant.id)).toEqual({ users: [ana.u.id], workspaces: [] });
        expect((await s.legalHolds.get(root.p, hold.id)).reason).toBe('Case 1');

        // ---- B-7603 ----
        const lr = await person('lr', ['legal-review']);
        const x = await s.complianceExports.request(lr.p, null, { userId: ana.u.id, from: 0, to: Date.now() + 1000, kinds: ['users', 'conversations', 'files', 'memories', 'runs'] });
        for (let i = 0; i < 20; i++) if (!(await s.jobs.runDue())) break;
        const ready = await s.complianceExports.get(tenant.id, x.id);
        expect(ready).toMatchObject({ state: 'ready', counts: { users: 1, conversations: 0 } });
        const text = (await s.complianceExports.content(ready))!.toString('utf8');
        expect(text.split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { kind: string }).kind)).toEqual(['export', 'user', 'summary']);
      } finally {
        await s.close();
        await db.destroy();
      }
    }, 120_000);
  });
}
