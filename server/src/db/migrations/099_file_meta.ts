import type { Knex } from 'knex';

/*
 * 1.8.0, Sprint 47 (B-142): alt text and a description on files of the file store (shown for images).
 *
 * - `file_meta`: one row per file (not per version): what the picture shows is written once and kept when a new
 *   version replaces the picture, with `alt_version` the version it was written for, so the console can say that it
 *   may be out of date. Stored in the clear like the file's name and tags, which they sit beside and which search reads
 *   (`FileService.search` matches them); the label of the file covers them. Removed with the file by the trash purge.
 *
 * Primary key `file_id`; an index on `tenant_id` for the tenant's search. Expand only: a build from before this
 * migration ignores the table.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('file_meta')) return;
  await knex.schema.createTable('file_meta', (t) => {
    t.string('file_id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('alt_text', 1000).nullable();
    t.text('description').nullable();
    t.integer('alt_version').nullable();
    t.string('updated_by', 26).nullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id'], 'file_meta_tenant');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('file_meta');
}
