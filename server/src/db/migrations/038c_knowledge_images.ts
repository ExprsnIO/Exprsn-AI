import type { Knex } from 'knex';
import { BUILTIN_TOOLS } from '../../registry/builtin/catalog.js';

/*
 * Sprint 36c (1.6.0), B-8801 to B-8805: image classification in Knowledge. Expand only.
 *
 * - `knowledge_bases.vision_profile`: the tenant profile (a vision model) that captions an image document and reads
 *   its text; `image_classifiers` (JSON array of classifier ids): the published `vision` classifiers that label the
 *   base's images.
 * - `knowledge_documents.parent_id`: an image taken out of a PDF or Word document is a document of its own, a part of
 *   that one; `media` (`image` for image documents); `vision` (sealed JSON: the caption, the recognised text and the
 *   model that wrote them); `safety_score`: the image safety check's score when one ran.
 * - `knowledge_doc_labels`: the labels a vision classifier gave an image document: one row per document, classifier
 *   and classifier label, with the score, whether it reached the threshold (`hit`), the classifier version that
 *   scored it and the document's own label rank (labels are metadata at the image's label).
 * - `eval_cases.media_key`, `media_type`: an image case of a classifier dataset (the sealed image in the blob store),
 *   in the same eval-set format as text cases (`expected` is the label).
 * - `registry_entries`: the built-in tool `knowledge_search` (added to the catalogue by this sprint).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('knowledge_bases', (t) => {
    t.string('vision_profile', 63).nullable();
    t.text('image_classifiers').nullable();
  });
  await knex.schema.alterTable('knowledge_documents', (t) => {
    t.string('parent_id', 26).nullable();
    t.string('media', 10).nullable();
    t.text('vision', 'mediumtext').nullable();
    t.float('safety_score').nullable();
    t.index(['parent_id']);
  });
  await knex.schema.createTable('knowledge_doc_labels', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('kb_id', 26).notNullable();
    t.string('document_id', 26).notNullable();
    t.string('classifier_id', 26).notNullable();
    t.integer('classifier_version').notNullable();
    t.string('label', 100).notNullable();
    t.float('score').notNullable();
    t.boolean('hit').notNullable();
    t.integer('label_rank').notNullable();
    t.bigInteger('created_at').notNullable();
    t.index(['kb_id', 'label']);
    t.index(['document_id']);
  });
  await knex.schema.alterTable('eval_cases', (t) => {
    t.string('media_key', 200).nullable();
    t.string('media_type', 40).nullable();
  });
  const t = Date.now();
  for (const b of BUILTIN_TOOLS) {
    if (await knex('registry_entries').where({ id: b.id }).first('id')) continue;
    const hash = `builtin-${b.builtin}-1`;
    await knex('registry_entries').insert({
      id: b.id,
      tenant_id: null,
      workspace_id: null,
      kind: 'tool',
      name: b.name,
      version: '1.0.0',
      description: b.description,
      impl: 'builtin',
      side_effect: b.sideEffect,
      confirm: 'never',
      rate_per_hour: null,
      label: b.label,
      input_schema: JSON.stringify(b.inputSchema),
      output_schema: JSON.stringify(b.outputSchema),
      definition: JSON.stringify({ builtin: b.builtin }),
      status: 'published',
      schema_hash: hash,
      approved_hash: hash,
      checks: JSON.stringify([{ name: 'Built into the platform', ok: true, detail: 'Ships with the server; acts through the domain service as the caller; reviewed with each release.' }]),
      checked_at: t,
      owner_id: null,
      owner_name: 'Platform',
      publish_scope: 'platform',
      created_at: t,
      updated_at: t
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex('registry_entries').where({ name: 'knowledge_search', impl: 'builtin' }).delete();
  await knex.schema.alterTable('eval_cases', (t) => {
    t.dropColumn('media_key');
    t.dropColumn('media_type');
  });
  await knex.schema.dropTableIfExists('knowledge_doc_labels');
  await knex.schema.alterTable('knowledge_documents', (t) => {
    t.dropIndex(['parent_id']);
    t.dropColumn('parent_id');
    t.dropColumn('media');
    t.dropColumn('vision');
    t.dropColumn('safety_score');
  });
  await knex.schema.alterTable('knowledge_bases', (t) => {
    t.dropColumn('vision_profile');
    t.dropColumn('image_classifiers');
  });
}
