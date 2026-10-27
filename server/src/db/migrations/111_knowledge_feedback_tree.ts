import type { Knex } from 'knex';

/*
 * 1.8.0, Sprint 48 (B-149): knowledge feedback, and a page tree with backlinks for references.
 *
 * - `knowledge_feedback`: "was this helpful?" on a knowledge document, a reference or a chat answer's citation of a
 *   document: thumbs up or down (`helpful`), an optional comment and, for a citation when its author allows it, the
 *   question that was asked (both sealed with the row id). One row per person and target (`target_key`); answering
 *   again replaces it. `document_id` is the document the feedback is about (a reference's current document).
 * - `knowledge_references.parent_id` and `position`: a reference's parent in its base's tree and its place among its
 *   siblings. The service refuses a move that would make a cycle.
 * - `knowledge_reference_links`: the references a published reference links to, by slug (`[[slug]]` or a Markdown
 *   link to the slug), written when a revision publishes; read backwards as backlinks.
 *
 * Expand only. A build from before this migration ignores the new table and columns.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('knowledge_feedback'))) {
    await knex.schema.createTable('knowledge_feedback', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('kb_id', 26).notNullable();
      t.string('document_id', 26).nullable();
      t.string('reference_id', 26).nullable();
      t.string('origin', 20).notNullable();
      t.string('message_id', 26).nullable();
      t.string('target_key', 80).notNullable();
      t.string('user_id', 26).notNullable();
      t.string('user_name', 200).notNullable();
      t.boolean('helpful').notNullable();
      t.text('comment').nullable();
      t.text('question', 'mediumtext').nullable();
      t.string('label', 20).notNullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.unique(['tenant_id', 'user_id', 'target_key']);
      t.index(['tenant_id', 'kb_id', 'document_id']);
      t.index(['tenant_id', 'kb_id', 'reference_id']);
    });
  }
  if (!(await knex.schema.hasColumn('knowledge_references', 'parent_id'))) {
    await knex.schema.alterTable('knowledge_references', (t) => {
      t.string('parent_id', 26).nullable();
      t.integer('position').notNullable().defaultTo(0);
      t.index(['kb_id', 'parent_id']);
    });
  }
  if (!(await knex.schema.hasTable('knowledge_reference_links'))) {
    await knex.schema.createTable('knowledge_reference_links', (t) => {
      t.string('tenant_id', 26).notNullable();
      t.string('kb_id', 26).notNullable();
      t.string('from_reference_id', 26).notNullable();
      t.string('to_slug', 200).notNullable();
      t.bigInteger('created_at').notNullable();
      t.primary(['from_reference_id', 'to_slug']);
      t.index(['kb_id', 'to_slug']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('knowledge_reference_links');
  if (await knex.schema.hasColumn('knowledge_references', 'parent_id')) {
    await knex.schema.alterTable('knowledge_references', (t) => {
      t.dropIndex(['kb_id', 'parent_id']);
      t.dropColumn('parent_id');
      t.dropColumn('position');
    });
  }
  await knex.schema.dropTableIfExists('knowledge_feedback');
}
