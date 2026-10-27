import type { Knex } from 'knex';

/*
 * 1.9.9 (QA-1): who added a knowledge document.
 *
 * - `knowledge_documents.created_by`: the person who uploaded or added the document (null for documents a source sync
 *   or a backfill wrote, and for rows from before this migration). Indexing a document again later (a reindex, a
 *   refresh, a model change) is metered for this person (`tenancy/usage-attribution.ts`); before, background work
 *   credited whoever added the document's source.
 *
 * Expand only: one nullable column, no backfill (an older row keeps falling back to its source's creator). The build
 * writes and reads it only while it exists (`KnowledgeService.hasDocumentCreator`).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('knowledge_documents', 'created_by'))) {
    await knex.schema.alterTable('knowledge_documents', (t) => {
      t.string('created_by', 26).nullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('knowledge_documents', 'created_by')) {
    await knex.schema.alterTable('knowledge_documents', (t) => {
      t.dropColumn('created_by');
    });
  }
}
