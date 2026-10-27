import type { Knex } from 'knex';

/*
 * 1.9.0, Sprint 52 (B-170): the search index's keys and state per tenant (`search/`).
 *
 * - `search_keys`: a tenant's search keys by version: 32 random bytes sealed with the tenant key (associated data
 *   `search-key:<tenant>:<version>`), so destroying the tenant key makes every posting meaningless. `state` is
 *   `building` (a backfill is writing it), `active` (queries use it) or `retiring` (its postings are being removed
 *   after a rotation; the row goes when they are gone).
 * - `search_state`: one row per tenant that turned the index on: `state` `building` or `ready`; the version queries
 *   use (`active_version`, null until the first backfill finishes) and the one a backfill or rotation is writing
 *   (`building_version`); the backfill's resumable `cursor` (JSON: the kind and the last id done), what it has done
 *   and expects (`processed`, `total`), its job, and the last error. No row: the index is off and nothing is written.
 *
 * Expand only: two new tables. While they are missing the index reads as not installed.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('search_keys'))) {
    await knex.schema.createTable('search_keys', (t) => {
      t.string('tenant_id', 26).notNullable();
      t.integer('version').notNullable();
      t.text('sealed').notNullable();
      t.string('state', 16).notNullable();
      t.bigInteger('created_at').notNullable();
      t.primary(['tenant_id', 'version']);
    });
  }
  if (!(await knex.schema.hasTable('search_state'))) {
    await knex.schema.createTable('search_state', (t) => {
      t.string('tenant_id', 26).primary();
      t.string('state', 16).notNullable();
      t.integer('active_version').nullable();
      t.integer('building_version').nullable();
      t.text('cursor').nullable();
      t.integer('processed').notNullable().defaultTo(0);
      t.integer('total').notNullable().defaultTo(0);
      t.string('job_id', 26).nullable();
      t.bigInteger('started_at').nullable();
      t.bigInteger('finished_at').nullable();
      t.string('updated_by', 26).nullable();
      t.bigInteger('updated_at').notNullable();
      t.text('error').nullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['search_state', 'search_keys']) await knex.schema.dropTableIfExists(table);
}
