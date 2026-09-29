import { mkdirSync } from 'node:fs';
import path from 'node:path';
import knexFactory, { type Knex } from 'knex';
import pg from 'pg';
import type { Config } from '../config/index.js';
import { migrationSource } from './migrations/index.js';

// Timestamps are stored as epoch milliseconds in BIGINT columns so the three dialects agree.
// node-postgres returns int8 as a string by default; every value we store fits in a JS number.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

export type Db = Knex;

export function createDb(config: Pick<Config, 'DB_CLIENT' | 'DATABASE_URL' | 'SQLITE_FILENAME' | 'DB_POOL_MAX'>): Db {
  switch (config.DB_CLIENT) {
    case 'pg':
      return knexFactory({ client: 'pg', connection: config.DATABASE_URL, pool: { min: 0, max: config.DB_POOL_MAX } });
    case 'mysql':
      return knexFactory({
        client: 'mysql2',
        connection: { uri: config.DATABASE_URL, charset: 'utf8mb4', timezone: 'Z', supportBigNumbers: true, bigNumberStrings: false } as unknown as Knex.MySql2ConnectionConfig,
        pool: { min: 0, max: config.DB_POOL_MAX }
      });
    case 'sqlite': {
      const filename = config.SQLITE_FILENAME;
      if (filename !== ':memory:') mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
      return knexFactory({
        client: 'better-sqlite3',
        connection: { filename },
        useNullAsDefault: true,
        // SQLite has one writer; a single connection serialises writes and keeps :memory: databases shared.
        pool: {
          min: 1,
          max: 1,
          afterCreate(conn: { pragma: (s: string) => unknown }, done: (err: Error | null, conn: unknown) => void) {
            try {
              conn.pragma('journal_mode = WAL');
              conn.pragma('foreign_keys = ON');
              conn.pragma('busy_timeout = 5000');
              done(null, conn);
            } catch (err) {
              done(err as Error, conn);
            }
          }
        }
      });
    }
  }
}

export async function migrate(db: Db): Promise<string[]> {
  const [, applied] = (await db.migrate.latest({ migrationSource })) as [number, string[]];
  return applied;
}

export async function pendingMigrations(db: Db): Promise<number> {
  const [, pending] = (await db.migrate.list({ migrationSource })) as [unknown[], unknown[]];
  return pending.length;
}

/** Parses a JSON text column; tolerates drivers that already return objects. */
export function json<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

export const now = (): number => Date.now();
