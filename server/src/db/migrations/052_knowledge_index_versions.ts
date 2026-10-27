import type { Knex } from 'knex';

/*
 * 1.7.0, Sprint 40 (B-3805): a refresh of a dataset source builds a new index version beside the serving one and
 * swaps it in (052_knowledge_index_versions). Expand only: three nullable columns.
 *
 * - `knowledge_indexes.source_id`: the dataset source whose refresh builds this version (null for a version built
 *   by "Rebuild index"), so a build a stopped job left behind is found and discarded by the next refresh.
 * - `knowledge_documents.staged_index_id`: the one index version a document belongs to while a refresh is under way:
 *   the version being built for a new or changed row (out of search and of the documents list until the swap), and
 *   afterwards the retired version for the rows it replaced or dropped, until they are deleted. Null otherwise.
 * - `knowledge_documents.staged_key`: the `external_key` a staged document takes at the swap. Until then the row it
 *   replaces holds that key (`source_id` and `external_key` are unique together).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('knowledge_indexes', (t) => {
    t.string('source_id', 26).nullable();
  });
  await knex.schema.alterTable('knowledge_documents', (t) => {
    t.string('staged_index_id', 26).nullable();
    t.string('staged_key', 64).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('knowledge_documents', (t) => {
    t.dropColumn('staged_key');
    t.dropColumn('staged_index_id');
  });
  await knex.schema.alterTable('knowledge_indexes', (t) => {
    t.dropColumn('source_id');
  });
}
