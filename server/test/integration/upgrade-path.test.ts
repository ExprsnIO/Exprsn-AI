/*
 * 1.9.99-final (B-10801): an older release's database upgrades to this release and back to its snapshot, with
 * `migrate --check` clean at each step, on real servers. Each block runs when its variable is set:
 *
 *   TEST_PG_URL      PostgreSQL: dumped with pg_dump -Fc and restored with pg_restore (a client at least as new as
 *                    the server, on the PATH or as PG_DUMP and PG_RESTORE; the block is skipped, saying so, without)
 *   TEST_MYSQL_URL   MySQL: a logical dump of every table's CREATE TABLE and rows, restored with foreign key checks off
 *
 * The database at each URL is emptied first and left migrated to this build. The drill is in `../upgrade-path.ts`;
 * SQLite runs it in `../upgrade-path.test.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drill, dumpPath, PG_DUMP, PG_RESTORE, pgToolMajor, RELEASES, target, type Engine } from '../upgrade-path.js';

const dir = mkdtempSync(path.join(tmpdir(), 'exprsn-upgrade-int-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

for (const d of [
  { name: 'PostgreSQL', engine: 'pg' as Engine, url: process.env.TEST_PG_URL },
  { name: 'MySQL', engine: 'mysql' as Engine, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`upgrade path from older releases on ${d.name} (B-10801)`, () => {
    let skip: string | null = null;
    beforeAll(async () => {
      if (d.engine !== 'pg') return;
      const t = target('pg', d.url!);
      const db = t.open();
      try {
        const server = Math.floor(Number(((await db.raw('SHOW server_version_num')) as { rows: { server_version_num: string }[] }).rows[0]!.server_version_num) / 10000);
        const [dumpMajor, restoreMajor] = [await pgToolMajor(PG_DUMP), await pgToolMajor(PG_RESTORE)];
        if (dumpMajor == null || restoreMajor == null || dumpMajor < server || restoreMajor < server) skip = `pg_dump/pg_restore ${dumpMajor ?? 'missing'}/${restoreMajor ?? 'missing'} cannot dump PostgreSQL ${server}: set PG_DUMP and PG_RESTORE`;
      } finally {
        await db.destroy();
      }
      if (skip) process.stderr.write(`upgrade-path: ${skip}\n`);
    });

    for (const release of RELEASES) {
      it(`${release.version} (${release.last}) upgrades to this release and rolls back to its snapshot`, async (ctx) => {
        if (skip) ctx.skip();
        const r = await drill(target(d.engine, d.url!), release, dumpPath(dir, d.engine, release.version));
        expect(r).toMatchObject({ exitBefore: 2, exitAfter: 0, exitOldAfter: 4, exitOldRestored: 0, exitNewRestored: 2 });
      }, 900_000);
    }
  });
}
