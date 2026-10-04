/*
 * Sprint 26d (1.4.0), the file store, against real databases. Each block runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 028d_files; an upload through quarantine; a version restored and scanned
 *                                  again; use-limited links taken concurrently (only the limit passes); storage sums
 *                                  and the quota; LIKE search with escaped wildcards and tags; the trash purge
 */
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { collect } from '../../src/files/crypt.js';
import { testConfig } from '../helpers.js';
import { FakePreviewRenderer } from '../sprint26d-fakes.js';

async function* bytes(s: string) {
  yield Buffer.from(s);
}

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`file store on ${d.name}`, () => {
    it('migrates 028d_files and runs uploads, restores, links, quotas, search and purge', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics(), { previewRenderer: new FakePreviewRenderer() });
      const drain = async () => {
        for (let i = 0; i < 20; i++) if (!(await s.jobs.runDue())) return;
      };
      try {
        expect(await db.schema.hasTable('file_versions')).toBe(true);
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const ws = await s.tenants.createWorkspace(tenant.id, 'Files', 'confidential');
        const u = await s.users.create(tenant.id, { username: 'fia', displayName: 'Fia', clearance: 'internal' });
        await s.users.update(tenant.id, u.id, { clearance_direct: 'internal' });
        await s.users.setRoles(u.id, 'direct', ['member']);
        await s.tenants.addMember(ws.id, u.id);
        const p = (await loadPrincipal(s, tenant.id, u.id, {}))!;
        p.workspaceId = ws.id;

        const { file } = await s.files.upload(p, { name: 'Plan_100%.txt', label: 'internal', declaredType: null, declaredBytes: null }, bytes('first'));
        await drain();
        await s.files.uploadVersion(p, file.id, { declaredType: null, declaredBytes: null }, bytes('second!'));
        await drain();
        const { version } = await s.files.restoreVersion(p, file.id, 1);
        expect(version).toMatchObject({ number: 3, state: 'quarantined', restored_from: 1 });
        await drain();
        const got = await s.files.content(p, file.id);
        expect(got.version.number).toBe(3);
        expect((await collect(got.stream)).toString()).toBe('first');
        expect((await s.files.storage(tenant.id, ws.id)).usedBytes).toBe(5 + 7 + 5);

        // links: four concurrent uses of a two-use link, two pass
        const { token } = await s.files.createShare(p, file.id, { kind: 'link', expiresInHours: 1, maxUses: 2 });
        const r = await Promise.allSettled([1, 2, 3, 4].map(() => s.files.useLink(token!, { principal: p }, null)));
        expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(2);
        for (const x of r) if (x.status === 'fulfilled') await collect(x.value.stream);

        // quota
        await s.files.setLimit(tenant.id, ws.id, 20, u.id);
        await expect(s.files.upload(p, { name: 'big.txt', label: 'internal', declaredType: null, declaredBytes: null }, bytes('xxxxxxxx'))).rejects.toMatchObject({ status: 413 });

        // search: % and _ are literal
        await s.files.setTags(p, file.id, ['Plans']);
        expect((await s.files.search(p, { q: '100%' })).map((f) => f.name)).toEqual(['Plan_100%.txt']);
        expect(await s.files.search(p, { q: 'n%1' })).toEqual([]);
        expect((await s.files.search(p, { tags: ['plans'] })).map((f) => f.id)).toEqual([file.id]);

        // trash and purge
        await s.files.trashFile(p, file.id);
        expect(await s.files.purge(tenant.id, { workspaceId: ws.id, all: true })).toMatchObject({ files: 1 });
        expect(await db('file_versions').where({ file_id: file.id })).toHaveLength(0);
      } finally {
        await s.close();
        await db.destroy();
      }
    }, 120_000);
  });
}
