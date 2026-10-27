import type { Knex } from 'knex';

/*
 * Categories filed by a vision classifier (046_classifier_categories). Expand only.
 *
 * - `knowledge_doc_categories.origin`: `manual` (a person, a tool or a script filed the document there) or
 *   `classifier` (the labels a vision classifier gave an image put it there, under `images/<classifier>/<label>`).
 *   `classifier_id` names the classifier of a category it filed. Rows written before this migration are `manual`.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('knowledge_doc_categories', (t) => {
    t.string('origin', 20).notNullable().defaultTo('manual');
    t.string('classifier_id', 26).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('knowledge_doc_categories', (t) => {
    t.dropColumn('origin');
    t.dropColumn('classifier_id');
  });
}
