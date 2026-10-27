/*
 * Sprint 24 (B-1701 to B-1703): the secrets vault on a real database. The schema (unique paths and versions, the
 * optimistic version counter, booleans and mediumtext) and the policy query have to behave the same on PostgreSQL
 * and MySQL as on SQLite.
 */
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import type { VaultCaller } from '../../src/vault/service.js';
import { testConfig } from '../helpers.js';

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`secrets vault on ${d.name}`, () => {
    it('versions, policies and transit keys', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const user = await s.users.create(tenant.id, { username: 'vaulter', displayName: 'Vaulter', clearance: 'internal' });
        const local = (await s.providers.list(tenant.id)).find((p) => p.kind === 'local')!;
        await s.users.upsertIdentity(user.id, local.id, user.id, ['Platform Team']);
        const ws = await s.tenants.createWorkspace(tenant.id, 'Vault WS', 'internal');
        await s.users.setWorkspaceMemberships(user.id, 'direct', [ws.id]);
        const c: VaultCaller = { tenantId: tenant.id, clearance: 'internal', subjects: await s.vault.subjectsFor(tenant.id, user.id, null), actor: { user: user.id }, denialKey: `${tenant.id}:${user.id}` };
        expect(c.subjects.groups).toEqual(['platform team']);

        await s.vault.createGrant(c, { subjectKind: 'group', subject: 'Platform Team', path: '*', capabilities: ['*'], effect: 'allow' });
        await s.vault.createGrant(c, { subjectKind: 'workspace', subject: ws.id, path: 'kv/apps/prod', capabilities: ['read'], effect: 'deny' });

        for (const v of ['one', 'two', 'three']) await s.vault.write(c, 'apps/db', { password: v });
        expect((await s.vault.read(c, 'apps/db', 2)).data).toEqual({ password: 'two' });
        expect((await s.vault.read(c, 'apps/db')).version).toBe(3);
        await expect(s.vault.write(c, 'apps/db', { password: 'x' }, { cas: 1 })).rejects.toMatchObject({ status: 409 });
        // Concurrent writers: each version number is taken once.
        const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => s.vault.write(c, 'apps/db', { password: `c${i}` })));
        const versions = results.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<{ version: number }>).value.version);
        expect(new Set(versions).size).toBe(versions.length);
        await s.vault.softDelete(c, 'apps/db', [2]);
        await expect(s.vault.read(c, 'apps/db', 2)).rejects.toMatchObject({ status: 410 });
        await s.vault.destroyVersions(c, 'apps/db', [1]);
        expect((await s.vault.metadata(c, 'apps/db')).versions[0]).toMatchObject({ version: 1, state: 'destroyed' });

        await s.vault.write(c, 'apps/prod/api', { token: 't' });
        await expect(s.vault.read(c, 'apps/prod/api')).rejects.toMatchObject({ status: 403 });
        const ex = await s.vault.explain(tenant.id, c.subjects, 'kv/apps/prod/api', 'read');
        expect(ex.decision.grant?.effect).toBe('deny');
        expect((await s.vault.list(c, 'apps')).map((x) => x.path)).toEqual(['apps/db', 'apps/prod/api']);

        await s.vault.createKey(c, { name: 'orders', type: 'aes256-gcm96' });
        const [c1] = await s.vault.encrypt(c, 'orders', [{ plaintext: Buffer.from('hello'), context: null }]);
        await s.vault.rotateKey(c, 'orders');
        await s.vault.configureKey(c, 'orders', { minDecryptVersion: 2 });
        const [dec] = await s.vault.decrypt(c, 'orders', [{ ciphertext: c1!, context: null }]);
        expect(dec).toMatchObject({ status: 400 });
        await s.vault.configureKey(c, 'orders', { minDecryptVersion: 1 });
        const [re] = await s.vault.rewrap(c, 'orders', [{ ciphertext: c1!, context: null }]);
        expect((re as { ciphertext: string }).ciphertext).toMatch(/^exai:v2:/);
      } finally {
        await s.close();
        await db.destroy();
      }
    });
  });
}
