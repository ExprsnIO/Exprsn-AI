import type { Knex } from 'knex';

/*
 * Sprint 40b (1.7.0), dataset import, knowledge sets, classifier eval sets and engines: B-3804 to B-3807.
 *
 * - `import_jobs` gains what a dataset import produces: `result` (JSON: the rows fetched and kept, the staged hash,
 *   the scrub summary, the destination's ids, the minimum-sample warnings), `rows_total` and `sample_rows` (the
 *   sample a dataset above the quota is cut to), and the ids of what the import created (`dataset_id`, `kb_id`,
 *   `source_id`, `classifier_id`, `eval_set`), so the queue links to Training, Knowledge and Classifiers.
 * - `training_datasets.import_id`: a version registered by an import keeps the import's id (its `source_kind` is
 *   `import`; the manifest, hash and scrub report are the same shape as an inline version's).
 * - `knowledge_sources.kind` gains `dataset` and `schedule` gains `weekly` and `monthly` (strings; no change).
 * - `classifiers.engine` gains `imported` (a string; no change): a text-classification model served by the
 *   classifier worker, its files staged by a model import with target `classifiers`.
 *
 * Expand only: new nullable columns.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('import_jobs', (t) => {
    t.text('result', 'mediumtext').nullable();
    t.integer('rows_total').notNullable().defaultTo(0);
    t.integer('sample_rows').nullable();
    t.string('dataset_id', 26).nullable();
    t.string('kb_id', 26).nullable();
    t.string('source_id', 26).nullable();
    t.string('classifier_id', 26).nullable();
    t.string('eval_set', 120).nullable();
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
    for (const c of ['result', 'rows_total', 'sample_rows', 'dataset_id', 'kb_id', 'source_id', 'classifier_id', 'eval_set']) t.dropColumn(c);
  });
}
