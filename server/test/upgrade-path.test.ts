import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { migrateCheck, migrateCheckExitCode, migrationsUpTo } from '../src/db/schema.js';
import { drill, dumpPath, RELEASES, target } from './upgrade-path.js';

/*
 * 1.9.99-final (B-10801): an older release's database upgrades to this one and back to its snapshot, with
 * `migrate --check` clean at each step, on SQLite (a file, dumped with VACUUM INTO). PostgreSQL and MySQL run the same
 * drill in `integration/upgrade-path.test.ts`. The drill is in `upgrade-path.ts`.
 */
describe('upgrade path from older releases on SQLite (B-10801)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'exprsn-upgrade-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  for (const release of RELEASES) {
    it(`${release.version} (${release.last}) upgrades to this release and rolls back to its snapshot`, async () => {
      const t = target('sqlite', path.join(dir, `app-${release.version}.sqlite`));
      const r = await drill(t, release, dumpPath(dir, 'sqlite', release.version));
      expect(r).toMatchObject({ exitBefore: 2, exitAfter: 0, exitOldAfter: 4, exitOldRestored: 0, exitNewRestored: 2 });
      expect(r.pendingAtUpgrade).toBeGreaterThan(0);
    }, 300_000);
  }

  it('knows each release boundary, and refuses one it does not know', async () => {
    const qa = await (await migrationsUpTo('145_saved_searches')).getMigrations([]);
    expect(qa.at(-1)).toBe('145_saved_searches');
    expect(qa).not.toContain('146_cloud_accounts');
    expect(qa[0]).toBe('001_core');
    await expect(migrationsUpTo('999_nope')).rejects.toThrow(/Unknown migration/);
  });

  it('maps migrate --check results to the CLI exit codes', async () => {
    const t = target('sqlite', ':memory:');
    const db = t.open();
    try {
      const fresh = await migrateCheck(db);
      expect(migrateCheckExitCode(fresh)).toBe(2);
      expect(migrateCheckExitCode({ ...fresh, destructive: [{ migration: 'x', steps: [] }] })).toBe(3);
      expect(migrateCheckExitCode({ ...fresh, state: 'behind' })).toBe(4);
      expect(migrateCheckExitCode({ ...fresh, state: 'current', pending: [] })).toBe(0);
    } finally {
      await db.destroy();
    }
  });
});
