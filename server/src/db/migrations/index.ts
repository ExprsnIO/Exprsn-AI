import type { Knex } from 'knex';
import * as m001 from './001_core.js';
import * as m002 from './002_tenancy_platform.js';
import * as m003 from './003_gateway.js';
import * as m004 from './004_chat.js';
import * as m005 from './005_guardrails.js';
import * as m007 from './007_registry.js';
import * as m008 from './008_workflows.js';

interface Migration {
  up(knex: Knex): Promise<void>;
  down(knex: Knex): Promise<void>;
}

// Migrations are imported, not discovered on disk, so the same list works from src (tsx) and dist (node).
const MIGRATIONS: Record<string, Migration> = {
  '001_core': m001,
  '002_tenancy_platform': m002,
  '003_gateway': m003,
  '004_chat': m004,
  '005_guardrails': m005,
  '007_registry': m007,
  '008_workflows': m008
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
