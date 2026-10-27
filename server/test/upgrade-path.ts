/*
 * 1.9.99-final (B-10801): the upgrade path from an older release to this one and back, shared by
 * `upgrade-path.test.ts` (SQLite) and `integration/upgrade-path.test.ts` (PostgreSQL, MySQL).
 *
 * The drill, for each older release: a database migrated to that release's migrations only, seeded; `migrate --check`
 * as that release (current) and as this build (pending, expand only, exit 2); a dump; the upgrade (`migrate`) and
 * `migrate --check` (current, exit 0), with the seeded rows intact and the cost columns of `usage_records` null on
 * the old rows, and the older build refusing the newer schema (exit 4, the handshake); then the rollback: the dump
 * restored, the schema and every row back as they were, `migrate --check` as that release current again and as this
 * build pending again; and the upgrade once more.
 *
 * The dumps are the engines' own: SQLite `VACUUM INTO` and the file put back; PostgreSQL `pg_dump -Fc` and
 * `pg_restore` (a client at least as new as the server, from the PATH or PG_DUMP / PG_RESTORE); MySQL a logical dump
 * made here as mysqldump would (SHOW CREATE TABLE and every row), restored with foreign key checks off.
 */
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { deserialize, serialize } from 'node:v8';
import { expect } from 'vitest';
import type { Config } from '../src/config/index.js';
import { createDb, migrate, type Db } from '../src/db/knex.js';
import { migrateCheck, migrateCheckExitCode, migrationsUpTo, type MigrationSet } from '../src/db/schema.js';

const run = promisify(execFile);

/** The newest migration each older release shipped (Sprints.md, CHANGELOG.md). */
export const RELEASES = [
  { version: '1.6.0', last: '041d_entity_api_embeds' },
  { version: '1.7.0', last: '073_feed_crosspost' },
  { version: '1.9.9-qa', last: '145_saved_searches' }
] as const;

/** The columns 1.9.99-final added to `usage_records` (migrations 160 and 163): null for every row metered before. */
export const COST_COLUMNS = ['neurons', 'cost_micros', 'currency', 'price_id', 'cached_tokens'] as const;

export type Engine = 'sqlite' | 'pg' | 'mysql';

export interface Target {
  engine: Engine;
  /** The database URL (pg, mysql) or the SQLite file. */
  url: string;
  /** Opens a connection pool on the target. */
  open: () => Db;
}

export function target(engine: Engine, url: string): Target {
  const cfg = (pool: number) => ({ DB_CLIENT: engine, DATABASE_URL: engine === 'sqlite' ? undefined : url, SQLITE_FILENAME: engine === 'sqlite' ? url : ':memory:', DB_POOL_MAX: pool }) as unknown as Config;
  // MySQL's restore sets FOREIGN_KEY_CHECKS on its session: one connection.
  return { engine, url, open: () => createDb(cfg(engine === 'mysql' ? 1 : 2)) };
}

/** Every table, knex's own included. */
export async function tables(db: Db, engine: Engine): Promise<string[]> {
  if (engine === 'sqlite') return ((await db.raw("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) as { name: string }[]).map((r) => r.name).sort();
  if (engine === 'pg') return ((await db.raw("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'")) as { rows: { name: string }[] }).rows.map((r) => r.name).sort();
  return ((await db.raw("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = database() AND table_type = 'BASE TABLE'")) as [{ name: string }[]])[0].map((r) => r.name).sort();
}

/** Empties the database: every table dropped (the URL's database is the test's own). */
export async function wipe(db: Db, engine: Engine): Promise<void> {
  if (engine === 'pg') {
    await db.raw('DROP SCHEMA IF EXISTS public CASCADE');
    await db.raw('CREATE SCHEMA public');
    return;
  }
  if (engine === 'mysql') await db.raw('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of await tables(db, engine)) await db.raw(engine === 'mysql' ? `DROP TABLE \`${t}\`` : `DROP TABLE "${t}"`);
  if (engine === 'mysql') await db.raw('SET FOREIGN_KEY_CHECKS = 1');
}

/** The shape of the database: each table's columns and row count. */
export async function shape(db: Db, engine: Engine): Promise<Record<string, { columns: string[]; rows: number }>> {
  const out: Record<string, { columns: string[]; rows: number }> = {};
  for (const t of await tables(db, engine)) {
    const columns = Object.keys(await db(t).columnInfo()).sort();
    const [{ n }] = (await db(t).count({ n: '*' })) as [{ n: number | string }];
    out[t] = { columns, rows: Number(n) };
  }
  // The lock row's state is knex's business, not the release's.
  delete out.knex_migrations_lock;
  return out;
}

const now = 1_760_000_000_000;
const OLD = { tenant: '01JOLDTENANT0000000000000A', workspace: '01JOLDWORKSPACE00000000000', user: '01JOLDUSER0000000000000000' };
const USAGE = ['01JOLDUSAGE000000000000001', '01JOLDUSAGE000000000000002', '01JOLDUSAGE000000000000003'];

/** A value for a column the seed does not name and the schema requires (no default). */
function filler(type: string, column: string): unknown {
  const t = type.toLowerCase();
  if (/int|numeric|decimal|real|double|float/.test(t)) return 0;
  if (/bool|tinyint\(1\)/.test(t)) return false;
  if (/json/.test(t)) return '{}';
  return `seed-${column}`.slice(0, 20);
}

async function insert(db: Db, table: string, values: Record<string, unknown>): Promise<void> {
  const info = await db(table).columnInfo();
  const row: Record<string, unknown> = {};
  for (const [col, v] of Object.entries(values)) if (col in info) row[col] = v;
  for (const [col, c] of Object.entries(info)) {
    if (col in row || c.nullable || c.defaultValue != null) continue;
    row[col] = filler(String(c.type), col);
  }
  await db(table).insert(row);
}

/** Seeds what an older release's install has: a tenant, a workspace, a person and metered usage. */
export async function seed(db: Db): Promise<void> {
  await insert(db, 'tenants', { id: OLD.tenant, slug: 'old-release', name: 'Old release', state: 'active', created_at: now, updated_at: now });
  await insert(db, 'workspaces', { id: OLD.workspace, tenant_id: OLD.tenant, name: 'Old workspace', slug: 'old-workspace', label_ceiling: 'internal', created_at: now, updated_at: now });
  await insert(db, 'users', { id: OLD.user, tenant_id: OLD.tenant, username: 'old.user', display_name: 'Old user', clearance: 'internal', created_at: now, updated_at: now });
  for (const [i, id] of USAGE.entries()) {
    await insert(db, 'usage_records', { id, tenant_id: OLD.tenant, workspace_id: OLD.workspace, user_id: OLD.user, kind: 'chat', model: 'llama3.2:3b', prompt_tokens: 100 + i, output_tokens: 50 + i, day: 20251009, month: 202510, ts: now + i });
  }
}

/** The seeded rows, as an older release wrote them. */
export async function seeded(db: Db): Promise<unknown> {
  const tenant = await db('tenants').where({ id: OLD.tenant }).first('id', 'slug', 'name');
  const user = await db('users').where({ id: OLD.user }).first('id', 'tenant_id', 'username');
  const usage = await db('usage_records').whereIn('id', USAGE).orderBy('id').select('id', 'prompt_tokens', 'output_tokens', 'ts');
  return { tenant, user, usage: usage.map((u) => ({ ...u, prompt_tokens: Number(u.prompt_tokens), output_tokens: Number(u.output_tokens), ts: Number(u.ts) })) };
}

// ---------- dumps ----------

export interface Dump {
  restore: () => Promise<void>;
}

const pgUrlParts = (url: string) => {
  const u = new URL(url);
  const password = decodeURIComponent(u.password);
  u.password = '';
  return { url: u.toString(), env: { ...process.env, PGPASSWORD: password } };
};

/** The major version of a PostgreSQL client tool, or null when it is not there. */
export async function pgToolMajor(tool: string): Promise<number | null> {
  try {
    const { stdout } = await run(tool, ['--version']);
    const m = /(\d+)(?:\.\d+)?/.exec(stdout);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export const PG_DUMP = process.env.PG_DUMP || 'pg_dump';
export const PG_RESTORE = process.env.PG_RESTORE || 'pg_restore';

/** Dumps the database to `file` with the engine's own means; `restore` puts it back into an emptied database. */
export async function dump(t: Target, db: Db, file: string): Promise<Dump> {
  if (t.engine === 'sqlite') {
    await db.raw('VACUUM INTO ?', [file]);
    return {
      restore: async () => {
        for (const ext of ['', '-wal', '-shm']) rmSync(`${t.url}${ext}`, { force: true });
        copyFileSync(file, t.url);
      }
    };
  }
  if (t.engine === 'pg') {
    const { url, env } = pgUrlParts(t.url);
    await run(PG_DUMP, ['--format=custom', '--no-owner', '--no-privileges', `--file=${file}`, `--dbname=${url}`], { env });
    return {
      restore: async () => {
        const w = t.open();
        try {
          await wipe(w, 'pg');
        } finally {
          await w.destroy();
        }
        // Into the emptied database (public recreated empty), stopping at the first error.
        await run(PG_RESTORE, ['--no-owner', '--no-privileges', '--exit-on-error', `--dbname=${url}`, file], { env }).catch((err: { stderr?: string }) => {
          throw new Error(`pg_restore failed: ${String(err.stderr ?? err).slice(0, 2000)}`);
        });
      }
    };
  }
  // MySQL: what mysqldump writes, kept in memory and on disk: each table's CREATE TABLE and its rows.
  const out: { table: string; ddl: string; rows: Record<string, unknown>[] }[] = [];
  for (const table of await tables(db, 'mysql')) {
    const [[row]] = (await db.raw(`SHOW CREATE TABLE \`${table}\``)) as [[Record<string, string>]];
    out.push({ table, ddl: row!['Create Table']!, rows: (await db(table).select('*')) as Record<string, unknown>[] });
  }
  writeFileSync(file, serialize(out), { mode: 0o600 });
  return {
    restore: async () => {
      const saved = deserialize(readFileSync(file)) as typeof out;
      const w = t.open();
      try {
        await wipe(w, 'mysql');
        await w.raw('SET FOREIGN_KEY_CHECKS = 0');
        for (const { ddl } of saved) await w.raw(ddl);
        for (const { table, rows } of saved) for (let i = 0; i < rows.length; i += 200) await w(table).insert(rows.slice(i, i + 200));
        await w.raw('SET FOREIGN_KEY_CHECKS = 1');
      } finally {
        await w.destroy();
      }
    }
  };
}

// ---------- the drill ----------

export interface DrillResult {
  release: string;
  pendingAtUpgrade: number;
  exitBefore: number;
  exitAfter: number;
  exitOldAfter: number;
  exitOldRestored: number;
  exitNewRestored: number;
}

const checkAs = async (db: Db, set?: MigrationSet) => {
  const r = await migrateCheck(db, set);
  return { r, code: migrateCheckExitCode(r) };
};

/**
 * Migrates an emptied database to `release`, seeds it, upgrades it to this build and rolls it back to the dump,
 * asserting `migrate --check` at each step. Leaves the database upgraded to this build.
 */
export async function drill(t: Target, release: (typeof RELEASES)[number], dumpFile: string): Promise<DrillResult> {
  const old = await migrationsUpTo(release.last);
  let db = t.open();
  try {
    await wipe(db, t.engine);
    await db.migrate.latest({ migrationSource: old });
    await seed(db);

    // Before: current as the older release; pending as this build, expand only (a rolling upgrade is safe).
    const asOld = await checkAs(db, old);
    expect(asOld.r).toMatchObject({ state: 'current', database: release.last, pending: [], unknown: [] });
    expect(asOld.code).toBe(0);
    const before = await checkAs(db);
    expect(before.r.state).toBe('pending');
    expect(before.r.pending[0]! > release.last).toBe(true);
    expect(before.r.destructive, 'a migration since this release drops or renames without the contract marker').toEqual([]);
    expect(before.code).toBe(2);
    if (release.last === '145_saved_searches') expect(before.r.pending).toEqual(expect.arrayContaining(['146_cloud_accounts', '160_cloud_model_servers', '164_cloud_showback']));
    const oldShape = await shape(db, t.engine);
    const oldRows = await seeded(db);
    const snapshot = await dump(t, db, dumpFile);

    // Upgrade.
    const applied = await migrate(db);
    expect(applied).toEqual(before.r.pending);
    const after = await checkAs(db);
    expect(after.r).toMatchObject({ state: 'current', pending: [], unknown: [], destructive: [] });
    expect(after.code).toBe(0);
    expect(await seeded(db)).toEqual(oldRows);
    for (const col of COST_COLUMNS) expect(await db.schema.hasColumn('usage_records', col), col).toBe(true);
    const costs = (await db('usage_records').select(...COST_COLUMNS)) as Record<string, unknown>[];
    expect(costs.length).toBeGreaterThan(0);
    for (const row of costs) for (const col of COST_COLUMNS) expect(row[col], `usage_records.${col} on an old row`).toBeNull();
    // The older release, still running somewhere, sees a newer schema and stops (the handshake): exit 4.
    const oldAfter = await checkAs(db, old);
    expect(oldAfter.r.state).toBe('behind');
    expect(oldAfter.r.unknown).toEqual(applied);
    expect(oldAfter.code).toBe(4);

    // Roll back: the dump restored.
    await db.destroy();
    await snapshot.restore();
    db = t.open();
    expect(await shape(db, t.engine)).toEqual(oldShape);
    expect(await seeded(db)).toEqual(oldRows);
    for (const col of COST_COLUMNS) expect(await db.schema.hasColumn('usage_records', col), col).toBe(false);
    const oldRestored = await checkAs(db, old);
    expect(oldRestored.r).toMatchObject({ state: 'current', database: release.last, pending: [], unknown: [] });
    const newRestored = await checkAs(db);
    expect(newRestored.r.pending).toEqual(before.r.pending);

    // And forward again from the restored snapshot.
    expect(await migrate(db)).toEqual(before.r.pending);
    expect((await checkAs(db)).code).toBe(0);
    return { release: release.version, pendingAtUpgrade: applied.length, exitBefore: before.code, exitAfter: after.code, exitOldAfter: oldAfter.code, exitOldRestored: oldRestored.code, exitNewRestored: migrateCheckExitCode(newRestored.r) };
  } finally {
    await db.destroy();
    if (existsSync(dumpFile)) rmSync(dumpFile, { force: true });
  }
}

export const dumpPath = (dir: string, engine: Engine, release: string) => path.join(dir, `${engine}-${release}.dump`);
