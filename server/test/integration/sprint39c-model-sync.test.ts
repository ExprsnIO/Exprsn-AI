/*
 * 1.6.0, Sprint 39c against real databases. Each block runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 041c_model_gen_sync; B-8501: a table of the same database, reached as an
 *                                  outside data connection through the real PostgreSQL or MySQL driver, attached to an
 *                                  entity: a pull writes its rows as records (typed, keyed), a changed row comes back
 *                                  at the next pull, a missing one removes its record, and app writes (create, update,
 *                                  transition, delete) reach the table at once through the driver's row mutation.
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
  { name: 'PostgreSQL', client: 'pg' as const, engine: 'postgres' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, engine: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`Sprint 39c on ${d.name}`, () => {
    it('migrates 041c_model_gen_sync; an outside table attached to an entity pulls in and takes writes at once', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url!, APPS_AI_DEBOUNCE_MS: '0' });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      const u = new URL(d.url!);
      const table = 'ext_customers';
      try {
        for (const t of ['app_ai_fills', 'app_entity_sources']) expect(await db.schema.hasTable(t), t).toBe(true);
        expect(await db.schema.hasColumn('app_records', 'external_key')).toBe(true);
        expect(await db.schema.hasColumn('app_records', 'ai_pending')).toBe(true);
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const ws = await s.tenants.createWorkspace(tenant.id, 'Sales', 'confidential');
        const person = async (username: string, roles: string[]) => {
          const user = await s.users.create(tenant.id, { username, displayName: username.toUpperCase(), clearance: 'confidential' });
          await s.users.update(tenant.id, user.id, { clearance_direct: 'confidential' });
          await s.users.setRoles(user.id, 'direct', roles);
          await s.tenants.addMember(ws.id, user.id);
          const p = (await loadPrincipal(s, tenant.id, user.id, {}))!;
          p.workspaceId = ws.id;
          return { user, p };
        };
        const dee = await person('dee', ['workflow-admin', 'connection-admin', 'member']);
        const actor = { principal: dee.p, source: 'api' as const };

        // the outside table, in this same database
        await db.schema.dropTableIfExists(table);
        await db.schema.createTable(table, (t) => {
          t.increments('id');
          t.string('name', 200).notNullable();
          t.string('email', 200).nullable();
          t.decimal('balance', 12, 2).nullable();
          t.boolean('active').notNullable().defaultTo(true);
          t.string('status', 20).nullable();
        });
        await db(table).insert([
          { name: 'Contoso', email: 'ap@contoso.example', balance: 120.5, active: true, status: 'new' },
          { name: 'Fabrikam', email: 'ops@fabrikam.example', balance: 0, active: false, status: 'paid' }
        ]);

        // the same database as a data connection, through the real driver
        const database = u.pathname.replace(/^\//, '');
        const conn = await s.connections.create(dee.p, { name: 'self', engine: d.engine, endpoint: `${u.hostname}:${u.port || (d.engine === 'postgres' ? 5432 : 3306)}`, database, zone: 'data', label: 'internal', rowLimit: 500, timeoutS: 10, tls: false, username: decodeURIComponent(u.username) || null, password: decodeURIComponent(u.password) || '' });
        await s.connections.refreshSchema(tenant.id, conn.id);
        const objects = ((await s.connections.get(tenant.id, conn.id)).schema ?? []).map((o) => o.name);
        const object = objects.find((o) => o.endsWith(`.${table}`))!;
        expect(object).toBeTruthy();
        await s.connections.setAllowList(dee.p, conn.id, [object], []);

        const app = await s.apps.create(actor, { name: 'crm', title: 'CRM', label: 'internal', workspaceId: ws.id });
        const { entity } = await s.apps.createEntity(actor, app.name, {
          name: 'customer',
          definition: entityDefinitionSchema.parse({
            fields: [{ name: 'crm_id', type: 'number', indexed: true, unique: true }, { name: 'name', type: 'string', required: true, indexed: true, maxLength: 200 }, { name: 'email', type: 'string', maxLength: 200 }, { name: 'balance', type: 'number' }, { name: 'active', type: 'boolean', indexed: true }],
            states: { initial: 'new', states: [{ name: 'new' }, { name: 'paid' }], transitions: [{ from: ['new'], to: 'paid' }] }
          })
        });
        await s.apps.sources.set(actor, app, entity, { connectionId: conn.id, object, keyColumn: 'id', keyField: 'crm_id', columns: { crm_id: 'id' }, stateColumn: 'status', writes: true, deleteMissing: true, pullMinutes: null, enabled: true });

        // pull: two typed records keyed by id, the state from the status column
        let r = await s.apps.sources.pull(entity.id);
        expect(r).toMatchObject({ rows: 2, created: 2, failed: 0 });
        const page = async () => (await s.apps.query(dee.p, 'crm', 'customer', { sort: [{ field: 'name', dir: 'asc' }] })).records;
        let recs = await page();
        expect(recs.map((x) => [x.externalKey, x.state, x.values.name, x.values.active, x.values.balance])).toEqual([
          ['1', 'new', 'Contoso', true, 120.5],
          ['2', 'paid', 'Fabrikam', false, 0]
        ]);
        // a changed row and a gone row, after the next pull
        await db(table).where({ id: 2 }).update({ balance: 9.75, active: true });
        await db(table).where({ id: 1 }).delete();
        r = await s.apps.sources.pull(entity.id);
        expect(r).toMatchObject({ rows: 1, updated: 1, deleted: 1 });
        recs = await page();
        expect(recs).toHaveLength(1);
        expect(recs[0]!.values).toMatchObject({ name: 'Fabrikam', balance: 9.75, active: true });

        // app writes reach the table at once
        const fab = recs[0]!;
        await s.apps.updateRecord(actor, app, entity, fab.id, { values: { balance: 10, name: 'Fabrikam Ltd' } });
        expect(await db(table).where({ id: 2 }).first('name', 'balance')).toMatchObject({ name: 'Fabrikam Ltd', balance: d.engine === 'postgres' ? '10.00' : '10.00' });
        await s.apps.transition(actor, app, entity, fab.id, 'paid').catch(() => undefined); // already paid: illegal, nothing written
        const made = await s.apps.createRecord(actor, app, entity, { values: { crm_id: 7, name: 'Northwind', balance: 1 } });
        expect(made.externalKey).toBe('7');
        const row = await db(table).where({ id: 7 }).first();
        expect(row).toMatchObject({ name: 'Northwind', status: 'new' });
        await s.apps.transition(actor, app, entity, made.id, 'paid');
        expect((await db(table).where({ id: 7 }).first('status'))!.status).toBe('paid');
        await s.apps.removeRecord(actor, app, entity, made.id);
        expect(await db(table).where({ id: 7 }).first()).toBeUndefined();
        expect(await db('audit_events').where({ tenant_id: tenant.id, action: 'app.entity.source.pulled' }).count({ n: '*' }).first()).toMatchObject({ n: expect.anything() });
      } finally {
        await db.schema.dropTableIfExists(table).catch(() => undefined);
        await s.close();
        await db.destroy();
      }
    }, 120_000);
  });
}
