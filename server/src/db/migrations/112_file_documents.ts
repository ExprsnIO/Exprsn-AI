import type { Knex } from 'knex';

/*
 * 2.0.0, file management: editable documents in the file store.
 *
 * - `file_doc_columns`: the column definitions of a table or spreadsheet file (name, type, required, width per sheet),
 *   which a CSV file cannot carry itself. One row per file, JSON in `sheets` ({ "<sheet name>": Column[] }), read when
 *   the document is opened and written when it is saved. Removed with the file by the trash purge.
 * - `file_knowledge_links`: a file added to a knowledge base: which version became which knowledge document, so the
 *   file shows where it is and can send a newer version. Removed with the file by the trash purge; the knowledge
 *   document itself stays (the base's curators decide about it).
 *
 * Expand only: a build from before this migration ignores both tables.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('file_doc_columns'))) {
    await knex.schema.createTable('file_doc_columns', (t) => {
      t.string('file_id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.text('sheets', 'mediumtext').notNullable();
      t.string('updated_by', 26).nullable();
      t.bigInteger('updated_at').notNullable();
      t.index(['tenant_id'], 'file_doc_columns_tenant');
    });
  }
  if (!(await knex.schema.hasTable('file_knowledge_links'))) {
    await knex.schema.createTable('file_knowledge_links', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('file_id', 26).notNullable();
      t.integer('version').notNullable();
      t.string('kb_id', 26).notNullable();
      t.string('document_id', 26).notNullable();
      t.string('converted_to', 60).nullable();
      t.string('created_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.index(['tenant_id', 'file_id'], 'file_knowledge_links_file');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('file_knowledge_links');
  await knex.schema.dropTableIfExists('file_doc_columns');
}
