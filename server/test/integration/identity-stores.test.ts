/*
 * 1.9.0, Sprint 54 (B-181, B-185, B-186): user-store versions, archive and backups against real databases. Each block
 * runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migrations 140_identity_store_state and 141_identity_store_backups (applied here
 *                                  until they are registered); versions numbered per store with a diff; archive
 *                                  leaving the chain and restore returning the previous state; a local store's
 *                                  backup (password hashes and a TOTP factor) sealed, signed, refused when changed,
 *                                  dry-run and restored into another tenant inside one transaction
 */
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { hashPassword } from '../../src/identity/passwords.js';
import { storeAdminFor } from '../../src/identity/store-admin.js';
import { storeBackupsFor } from '../../src/identity/store-backups.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { PASSWORD, testConfig } from '../helpers.js';

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`user stores on ${d.name}`, () => {
    it('keeps versions, archives and restores, and backs up and restores a local store into another tenant', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      const m140 = await import('../../src/db/migrations/140_identity_store_state.js');
      const m141 = await import('../../src/db/migrations/141_identity_store_backups.js');
      if (await db.schema.hasTable('identity_providers')) {
        await m141.down(db);
        await m140.down(db);
      }
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      await m140.up(db);
      await m141.up(db);
      await m140.up(db); // idempotent
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const admin = storeAdminFor(s);
        const backups = storeBackupsFor(s, admin);
        expect(await admin.installed()).toBe(true);
        expect(await backups.installed()).toBe(true);
        const local = (await s.providers.list(tenant.id)).find((p) => p.kind === 'local')!;

        // Versions.
        const scim = await s.providers.create(tenant.id, { name: 'Pushed', kind: 'scim', position: 10, enabled: true, config: {} });
        expect(await admin.recordVersion(scim, 'created', null)).toBe(1);
        const changed = (await s.providers.update(tenant.id, scim.id, { config: { defaultRoles: ['member'] } }))!;
        expect(await admin.recordVersion(changed, 'everyone a member', null)).toBe(2);
        const history = await admin.history(tenant.id, scim.id);
        expect(history.map((v) => v.version)).toEqual([2, 1]);
        expect(history[0]!.changes).toContainEqual({ path: 'config.defaultRoles', before: [], after: ['member'] });

        // Archive and restore.
        const out = await admin.archive(changed, 'admin');
        expect(out.row).toMatchObject({ state: 'archived', enabled: false, state_before: 'enabled' });
        const restored = await admin.restore(out.row);
        expect(restored).toMatchObject({ state: 'active', enabled: true, state_before: null });

        // A local account with a password and a TOTP factor, then its store's backup.
        const ida = await s.users.create(tenant.id, { username: 'ida', displayName: 'Ida', clearance: 'confidential' });
        await s.users.update(tenant.id, ida.id, { clearance_direct: 'confidential' });
        await db('local_credentials').insert({ user_id: ida.id, password_hash: await hashPassword(PASSWORD), updated_at: Date.now() });
        await s.users.upsertIdentity(ida.id, local.id, ida.id, []);
        await s.users.setRoles(ida.id, 'direct', ['identity-admin']);
        const factor = await s.mfa.beginTotp(ida.id, 'ida', 'phone');
        await db('mfa_factors').where({ id: factor.id }).update({ confirmed_at: Date.now() });
        const archive = await backups.build(local);
        expect(archive.counts).toMatchObject({ passwords: 1, factors: 1, links: 1 });
        await expect(backups.open({ ...archive, counts: { ...archive.counts, links: 2 } })).rejects.toMatchObject({ status: 422 });

        // Into another tenant: a dry run first, then the restore.
        const other = await s.tenants.create({ slug: 'other-' + d.client, name: 'Other' });
        await s.providers.create(other.id, { name: 'Local accounts', kind: 'local', position: 1000, enabled: true, config: {} });
        const boss = await s.users.create(other.id, { username: 'boss', displayName: 'Boss', clearance: 'confidential' });
        await s.users.update(other.id, boss.id, { clearance_direct: 'confidential' });
        await s.users.setRoles(boss.id, 'direct', ['identity-admin']);
        const p = (await loadPrincipal(s, other.id, boss.id, {}))!;
        const dry = await backups.restore(p, archive, { mode: 'same', dryRun: true });
        expect(dry.changes).toContainEqual({ what: 'user', action: 'create', detail: 'ida (active)' });
        expect(await s.users.byUsername(other.id, 'ida')).toBeUndefined();
        await backups.restore(p, archive, { mode: 'same', dryRun: false });
        const copy = (await s.users.byUsername(other.id, 'ida'))!;
        expect((await s.chain.authenticate(other.id, 'ida', PASSWORD)).status).toBe('ok');
        expect(await s.mfa.methods(copy.id)).toContain('totp');

        // Saved to the blob store and read back.
        const saved = await backups.save(local, null);
        expect((await backups.list(tenant.id)).map((b) => b.id)).toContain(saved.id);
        expect((await backups.read(tenant.id, saved.id)).id).toBe(saved.id);
      } finally {
        await s.close();
        await m141.down(db).catch(() => undefined);
        await m140.down(db).catch(() => undefined);
        await db.destroy();
      }
    }, 120_000);
  });
}
