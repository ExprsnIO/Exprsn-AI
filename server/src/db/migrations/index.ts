import type { Knex } from 'knex';
import * as m001 from './001_core.js';

interface Migration {
  up(knex: Knex): Promise<void>;
  down(knex: Knex): Promise<void>;
}

// Migrations are imported, not discovered on disk, so the same list works from src (tsx) and dist (node).
const MIGRATIONS: Record<string, Migration> = {
  '001_core': m001
};

export const migrationSource: Knex.MigrationSource<string> = {
  getMigrations: async () => Object.keys(MIGRATIONS).sort(),
  getMigrationName: (name) => name,
  getMigration: async (name) => {
    const m = MIGRATIONS[name];
    if (!m) throw new Error(`Unknown migration ${name}`);
    return m;
  }
};
