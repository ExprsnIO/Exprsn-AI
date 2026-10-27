import type { Knex } from 'knex';

/*
 * 1.9.9-qa (B-173, the Sprint 52 leftovers): saved searches (`search/saved.ts`).
 *
 * - `saved_searches`: one row per search a person saved, theirs alone. `source` is where it searches (`all` or one of
 *   the search box's sources); `sealed` is the name, the query text and the filters as JSON, sealed with the tenant key
 *   under the associated data `saved-search:<tenant>:<user>:<id>`, so a row moved to another person or tenant does not
 *   open. Nothing of the query is kept in plain text. `last_run_at` is when it was last run.
 *
 * Expand only: one new table. While it is missing, saved searches read as unavailable and the console hides them.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('saved_searches')) return;
  await knex.schema.createTable('saved_searches', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('source', 16).notNullable();
    t.text('sealed').notNullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.bigInteger('last_run_at').nullable();
    t.index(['tenant_id', 'user_id'], 'saved_searches_owner');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('saved_searches');
}
