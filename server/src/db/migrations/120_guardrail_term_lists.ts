import type { Knex } from 'knex';

/*
 * 1.9.0, Sprint 50 (B-156): named term lists.
 *
 * `guard_term_lists` is a tenant's list: a name unique in the tenant, a description, its kind (`deny` or `allow`,
 * fixed when it is made) and its newest version. `guard_term_list_versions` holds each version's entries as JSON
 * (`[{ value, match: word | substring | domain }]`, at most 50,000), their number, a note, who wrote it and when.
 * Versions are never changed: a rule pinned to one keeps meaning what it meant.
 *
 * Expand only: two new tables.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('guard_term_lists', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('name', 63).notNullable();
    t.string('description', 500).nullable();
    t.string('kind', 8).notNullable();
    t.integer('latest_version').notNullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'name']);
  });
  await knex.schema.createTable('guard_term_list_versions', (t) => {
    t.string('id', 26).primary();
    t.string('list_id', 26).notNullable().references('id').inTable('guard_term_lists').onDelete('CASCADE');
    t.integer('version').notNullable();
    t.text('entries', 'mediumtext').notNullable(); // JSON
    t.integer('entry_count').notNullable();
    t.string('note', 500).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.unique(['list_id', 'version']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('guard_term_list_versions');
  await knex.schema.dropTableIfExists('guard_term_lists');
}
