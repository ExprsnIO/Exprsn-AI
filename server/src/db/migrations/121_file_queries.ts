import type { Knex } from 'knex';

/*
 * Files: the table builder (Power Query style queries over spreadsheet, CSV and JSON files).
 *
 * - `file_queries`: a saved query of a workspace: its source and applied steps as JSON (`definition`), where it was
 *   last loaded (`output`: the file and sheet it writes, JSON), and how the last refresh went. `label` is the highest
 *   label of the files it read when it was last saved or run; a reader below it does not see the query. Deleting a
 *   source or output file leaves the query; its next run says which file is gone.
 *
 * Expand only: a build from before this migration ignores the table.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('file_queries'))) {
    await knex.schema.createTable('file_queries', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('workspace_id', 26).notNullable();
      t.string('name', 200).notNullable();
      t.string('description', 2000).nullable();
      t.text('definition', 'mediumtext').notNullable();
      t.text('output').nullable();
      t.string('label', 20).notNullable();
      t.string('created_by', 26).nullable();
      t.string('updated_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.bigInteger('refreshed_at').nullable();
      t.integer('refreshed_rows').nullable();
      t.string('refresh_error', 2000).nullable();
      t.index(['tenant_id', 'workspace_id'], 'file_queries_workspace');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('file_queries');
}
