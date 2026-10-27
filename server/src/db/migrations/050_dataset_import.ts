import type { Knex } from 'knex';

/*
 * 1.7.0, Sprint 40 (B-3804 to B-3806): dataset import.
 *
 * - `import_jobs.result`: what a dataset import made (the training dataset version, the knowledge base and its
 *   source, the classifier and its eval set, or the stored rows), so the queue can open it.
 * - `training_datasets.import_id`: the import a version came from (`source_kind = import`).
 *
 * `import_jobs.target` already holds any target (`models`, and now `training`, `classifiers`, `knowledge`, `store`),
 * and `knowledge_sources.kind` any kind (now also `dataset`): both are plain strings. Expand only: two nullable
 * columns.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('import_jobs', (t) => {
    t.text('result', 'mediumtext').nullable(); // JSON: the destination, by target
  });
  await knex.schema.alterTable('training_datasets', (t) => {
    t.string('import_id', 26).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('training_datasets', (t) => {
    t.dropColumn('import_id');
  });
  await knex.schema.alterTable('import_jobs', (t) => {
    t.dropColumn('result');
  });
}
