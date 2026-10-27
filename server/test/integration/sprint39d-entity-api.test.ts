/*
 * 1.6.0, Sprint 39d against real databases. Each block runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 041d_entity_api_embeds; B-8602: a schema version per design change with
 *                                  the hash of the design; B-8601: an app-scoped key stored and read back; B-8702: an
 *                                  embed key, a host token exchanged for a session (the jti unique per key on the
 *                                  database), the session resolved and ended with its key.
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { entityDefinitionSchema } from '../../src/apps/schema.js';
import { AppEmbeds } from '../../src/apps/embeds.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { testConfig } from '../helpers.js';
import { claimsFor, es256, jwt, pem } from '../sprint39d-helpers.js';

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`Sprint 39d on ${d.name}`, () => {
    it('migrates 041d_entity_api_embeds; schema versions, app-scoped keys and embedded sessions work on the database', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        for (const t of ['app_schema_versions', 'app_embeds', 'app_embed_keys', 'app_embed_pages', 'app_embed_sessions']) expect(await db.schema.hasTable(t), t).toBe(true);
        expect(await db.schema.hasColumn('api_keys', 'app_scope')).toBe(true);
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const ws = await s.tenants.createWorkspace(tenant.id, 'Sales', 'confidential');
        const person = async (username: string, roles: string[]) => {
          const u = await s.users.create(tenant.id, { username, displayName: username.toUpperCase(), clearance: 'confidential' });
          await s.users.update(tenant.id, u.id, { clearance_direct: 'confidential' });
          await s.users.setRoles(u.id, 'direct', roles);
          await s.tenants.addMember(ws.id, u.id);
          const p = (await loadPrincipal(s, tenant.id, u.id, {}))!;
          p.workspaceId = ws.id;
          return { u, p };
        };
        const dee = await person('dee', ['workflow-admin', 'member']);
        const ana = await person('ana', ['member']);
        const actor = { principal: dee.p, source: 'api' as const };

        // B-8602: versions and the hash.
        const app = await s.apps.create(actor, { name: 'crm', title: 'CRM', label: 'confidential', workspaceId: ws.id });
        const { entity } = await s.apps.createEntity(actor, app.name, { name: 'deal', title: 'Deal', label: 'internal', definition: entityDefinitionSchema.parse({ fields: [{ name: 'title', type: 'string', required: true, indexed: true, unique: true, maxLength: 120 }, { name: 'region', type: 'string', indexed: true, maxLength: 20 }] }) });
        const v1 = await s.apps.schema.current(app);
        expect(v1.version).toBe(1);
        const withAmount = await s.apps.schema.addField(actor, app, entity.name, { name: 'amount', type: 'number', required: false, indexed: true, unique: false, integer: false });
        const v2 = await s.apps.schema.current(app);
        expect(v2.version).toBe(2);
        expect(v2.hash).not.toBe(v1.hash);
        const versions = await s.apps.schema.versions(app);
        expect(versions.map((v) => [v.version, v.kind, v.source])).toEqual([[2, 'field.added', 'schema-api'], [1, 'entity.created', 'api']]);
        expect(versions[0]!.hash).toBe(v2.hash);
        // The OpenAPI document reads the design back from the database.
        const doc = s.apps.schema.openapi(app, await s.apps.entities(app), v2, 'http://x');
        expect(Object.keys(doc.paths as object)).toContain('/api/apps/crm/deal');

        // B-8601: an app-scoped key round-trips.
        const { row } = await s.apiKeys.create({ tenantId: tenant.id, userId: dee.u.id, name: 'k', scopes: ['records:read'], ttlDays: 1, appScope: { app: app.id, entity: entity.id } });
        expect((await s.apiKeys.listForUser(dee.u.id)).find((k) => k.id === row.id)?.app_scope).toEqual({ app: app.id, entity: entity.id });
        await s.apps.createRecord(actor, app, withAmount, { values: { title: 'Contoso', region: 'emea', amount: 10 } });

        // B-8702: a key, a token, a session; the jti is unique per key; revoking the key ends the session.
        await s.apps.embeds.update(actor, app, { signedEnabled: true, allowedHosts: ['https://portal.example.com'], write: false });
        const host = generateKeyPairSync('ec', { namedCurve: 'P-256' });
        const key = await s.apps.embeds.addKey(actor, app, { kid: 'portal', alg: 'ES256', publicKey: pem(host.publicKey) });
        const token = jwt({ alg: 'ES256', kid: 'portal' }, claimsFor(AppEmbeds.audience(app), 'ana'), es256(host.privateKey));
        const opened = await s.apps.embeds.exchange(tenant.id, app.name, token, { ip: '127.0.0.1' });
        expect(opened.user.username).toBe('ana');
        const session = await s.apps.embeds.resolveSession(opened.token);
        expect(session?.user_id).toBe(ana.u.id);
        expect(session?.scope.app).toBe(app.id);
        await expect(s.apps.embeds.exchange(tenant.id, app.name, token, { ip: '127.0.0.1' })).rejects.toMatchObject({ status: 401 });
        const reader = (await loadPrincipal(s, tenant.id, ana.u.id, {}))!;
        reader.workspaceId = ws.id;
        reader.scopes = AppEmbeds.scopesFor(session!);
        expect((await s.apps.query(reader, app.id, entity.id, {})).records.map((r) => r.values.title)).toEqual(['Contoso']);
        await s.apps.embeds.revokeKey(actor, app, key.key.id);
        expect(await s.apps.embeds.resolveSession(opened.token)).toBeNull();
        expect((await s.apps.embeds.sessions(app)).map((x) => x.revoked_at != null)).toEqual([true]);
      } finally {
        await s.close();
        await db.destroy();
      }
    });
  });
}
