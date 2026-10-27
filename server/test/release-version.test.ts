import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/knex.js';
import { migrateCheck, migrateCheckExitCode, migrationsUpTo } from '../src/db/schema.js';
import type { Config } from '../src/config/index.js';

/*
 * 1.9.99-final (B-10801, B-10805): the release after 1.9.9-qa was planned as 1.0.0-GM, which semantic versioning orders
 * LOWER than 1.9.9-qa (and lower than the old 1.0.0-rc.1: "GM" < "rc.1"). Nothing may decide an upgrade, a
 * downgrade or compatibility by comparing release version strings: upgrades are decided by migration state
 * (`migrate --check`, the schema handshake) and, for cloud deployments, by image digest. This file holds that:
 *
 * - the server's own version is read only where it is shown or recorded (an allow-list of files), never compared;
 * - a 1.9.9-qa database checked by this build is "pending" (exit 2), never "newer than this build" (exit 4), whatever
 *   the version strings say.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../src');

/** Where the server's version is read, and why each is display or record only. */
const VERSION_READERS: Record<string, string> = {
  'config/settings.ts': 'Configuration screen: the build shown per instance, and the header of the settings export',
  'ops/instances.ts': 'serverVersion(): the instance heartbeat row (shown on the Overview)',
  'images/content-credentials.ts': 'the C2PA generator name (Exprsn-AI/<version>)',
  'services.ts': 'the tracer resource attribute service.version'
};
/** Files that read another package.json (an npm tarball, an app package), not the server's. */
const OTHER_PACKAGE_JSON = new Set(['ops/push.ts', 'apps/packages.ts']);

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(n) ? [p] : [];
  });

/** Semantic versioning precedence (semver.org §11), enough to state the hazard. */
function semverCompare(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = v.split('-', 2) as [string, string | undefined];
    return { core: core.split('.').map(Number), pre: pre ? pre.split('.') : [] };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!;
  if (!x.pre.length || !y.pre.length) return x.pre.length ? -1 : y.pre.length ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

describe('release version ordering (B-10805)', () => {
  it('ships as 2.0.0, which semver orders above 1.9.9-qa (the owner chose it on 2026-10-21 over 1.0.0-GM)', () => {
    expect(semverCompare('2.0.0', '1.9.9-qa')).toBeGreaterThan(0);
    expect(semverCompare('2.0.0', '1.7.0')).toBeGreaterThan(0);
  });

  it('records why 1.0.0-GM was not used: semver orders it below 1.9.9-qa, 1.7.0 and 1.0.0-rc.1', () => {
    expect(semverCompare('1.0.0-GM', '1.9.9-qa')).toBeLessThan(0);
    expect(semverCompare('1.0.0-GM', '1.7.0')).toBeLessThan(0);
    expect(semverCompare('1.0.0-GM', '1.0.0-rc.1')).toBeLessThan(0);
    expect(semverCompare('1.0.0-GM', '1.0.0')).toBeLessThan(0);
    // A semver-safe name for the same release sorts after everything before it.
    for (const before of ['1.9.9-qa', '1.7.0', '1.0.0-rc.1']) expect(semverCompare('2.0.0', before)).toBeGreaterThan(0);
  });

  it('reads the server version only to show or record it, in the listed places', () => {
    const readers: string[] = [];
    for (const f of files(SRC)) {
      const rel = path.relative(SRC, f).split(path.sep).join('/');
      const src = readFileSync(f, 'utf8');
      if (/npm_package_version|serverVersion\(|buildVersion\(|package\.json/.test(src) && !OTHER_PACKAGE_JSON.has(rel)) readers.push(rel);
      // No release-version comparison anywhere: the version is never parsed into numbers or compared as a string.
      expect(/(serverVersion|buildVersion)\(\)\s*(<|>|<=|>=|\.localeCompare|\.split)/.test(src), rel).toBe(false);
    }
    expect(readers.sort(), 'a new reader of the server version: add it with its reason, and never compare it').toEqual(Object.keys(VERSION_READERS).sort());
  });

  it('decides the upgrade from 1.9.9-qa by migration state: pending, not a downgrade', async () => {
    const db = createDb({ DB_CLIENT: 'sqlite', SQLITE_FILENAME: ':memory:', DB_POOL_MAX: 1 } as Config);
    try {
      await db.migrate.latest({ migrationSource: await migrationsUpTo('145_saved_searches') });
      const r = await migrateCheck(db);
      expect(r.state).toBe('pending');
      expect(migrateCheckExitCode(r)).toBe(2);
      expect(JSON.stringify(r)).not.toMatch(/1\.9\.9|1\.0\.0/);
    } finally {
      await db.destroy();
    }
  });
});
