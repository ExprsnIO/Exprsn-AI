/*
 * 1.9.9-qa (QA-1): directory sync state and directory imports against real databases. Each block runs when its
 * variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 143_directory_sync_state (applied here until it is registered), twice;
 *                                  delta links saved, replaced and cleared per store; an import row with its boolean
 *                                  and a report beyond 64 KB (mediumtext on MySQL); the migration rolled back
 */
import { describe, expect, it } from 'vitest';
import { createDb, json, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { DirectoryState } from '../../src/identity/directory-state.js';
import { testConfig } from '../helpers.js';

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`directory sync state on ${d.name}`, () => {
    it('keeps delta links per store and imports with large reports', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      const m143 = await import('../../src/db/migrations/143_directory_sync_state.js');
      try {
        await m143.down(db);
        await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
        await migrate(db);
        const state = new DirectoryState(db);
        expect(await state.available()).toBe(false);
        expect(await state.links('01J0000000000000000000000A')).toBeNull();
        await state.save('01J0000000000000000000000T', '01J0000000000000000000000A', { users: 'x', groups: 'y' }, 'full'); // no table: nothing
        await m143.up(db);
        await m143.up(db); // idempotent
        expect(await state.available()).toBe(true);

        const long = 'https://graph.microsoft.com/v1.0/users/delta?$deltatoken=' + 'a'.repeat(3000);
        await state.save('01J0000000000000000000000T', '01J0000000000000000000000A', { users: long, groups: long.replace('users', 'groups') }, 'full');
        expect(await state.links('01J0000000000000000000000A')).toEqual({ users: long, groups: long.replace('users', 'groups') });
        await state.save('01J0000000000000000000000T', '01J0000000000000000000000A', { users: 'u2', groups: 'g2' }, 'delta');
        const row = await state.get('01J0000000000000000000000A');
        expect(row).toMatchObject({ users_delta_link: 'u2', groups_delta_link: 'g2', mode: 'delta' });
        expect(Number(row!.synced_at)).toBeGreaterThan(0);
        await state.save('01J0000000000000000000000T', '01J0000000000000000000000A', null, 'full');
        expect(await state.links('01J0000000000000000000000A')).toBeNull();
        expect(Number((await db('directory_sync_state').count({ n: '*' }).first() as { n: number | string }).n)).toBe(1);

        const report = Array.from({ length: 1000 }, (_, i) => ({ username: `user${i}@contoso.test`, externalId: `id-${i}`, action: 'create', roles: ['member'], detail: 'x'.repeat(60) }));
        await db('directory_imports').insert({ id: '01J0000000000000000000000I', tenant_id: '01J0000000000000000000000T', provider_id: '01J0000000000000000000000A', created_by: null, actor: JSON.stringify({ roles: ['tenant-admin'], clearance: 'internal' }), dry_run: true, from_dry_run: null, state: 'succeeded', job_id: null, summary: JSON.stringify({ users: 1000 }), report: JSON.stringify(report), error: null, created_at: Date.now(), finished_at: Date.now() });
        const back = (await db('directory_imports').where({ id: '01J0000000000000000000000I' }).first()) as { dry_run: unknown; report: string };
        expect(!!back.dry_run).toBe(true);
        expect(JSON.stringify(report).length).toBeGreaterThan(65_535);
        expect(json<unknown[]>(back.report, []).length).toBe(1000);

        await m143.down(db);
        expect(await db.schema.hasTable('directory_imports')).toBe(false);
        expect(await db.schema.hasTable('directory_sync_state')).toBe(false);
      } finally {
        await db.destroy();
      }
    }, 120_000);
  });
}
