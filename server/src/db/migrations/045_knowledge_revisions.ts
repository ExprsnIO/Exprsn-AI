import type { Knex } from 'knex';
import { BUILTIN_TOOLS } from '../../registry/builtin/catalog.js';

/*
 * Knowledge references, revisions and review (045_knowledge_revisions). Expand only.
 *
 * - `knowledge_references`: a document of a base that is kept under version control: a stable `slug`, the title, the
 *   version that is published now, the revision that made it and the knowledge document that serves it.
 * - `knowledge_revisions`: every proposed change to a reference, kept for good: its number and version, what changed
 *   (`summary`) and for which feature, the sealed Markdown, who wrote it, who decided it and why, the workflow run
 *   that reviewed it, and the knowledge document it was published as.
 * - `knowledge_reviewers`: the editors (who may propose) and approvers (who may decide) of a base, as users or roles.
 * - `knowledge_bases`: `review` (`required` refuses uploads that go around review), `review_workflow_id` (the
 *   published workflow whose run decides a submitted revision) and `review_four_eyes` (an author may not approve
 *   their own revision).
 * - `registry_entries`: the built-in tools `knowledge_propose`, `knowledge_revisions` and `knowledge_publish`.
 */
const NAMES = ['knowledge_propose', 'knowledge_revisions', 'knowledge_publish'];

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('knowledge_references', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('kb_id', 26).notNullable();
    t.string('slug', 200).notNullable();
    t.string('title', 300).notNullable();
    t.string('label', 20).notNullable();
    t.text('categories').nullable();
    t.string('state', 20).notNullable();
    t.string('version', 40).nullable();
    t.string('revision_id', 26).nullable();
    t.string('document_id', 26).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['kb_id', 'slug']);
    t.index(['tenant_id']);
  });
  await knex.schema.createTable('knowledge_revisions', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('kb_id', 26).notNullable();
    t.string('reference_id', 26).notNullable();
    t.integer('number').notNullable();
    t.string('version', 40).notNullable();
    t.string('bump', 10).notNullable();
    t.string('state', 20).notNullable();
    t.string('title', 300).notNullable();
    t.text('summary').notNullable();
    t.string('feature', 300).nullable();
    t.text('content', 'mediumtext').notNullable();
    t.string('sha256', 64).notNullable();
    t.integer('size').notNullable();
    t.string('base_revision_id', 26).nullable();
    t.string('author_id', 26).nullable();
    t.string('author_name', 200).notNullable();
    t.string('approval_run_id', 26).nullable();
    t.string('decided_by', 26).nullable();
    t.string('decided_by_name', 200).nullable();
    t.text('decision_reason').nullable();
    t.string('document_id', 26).nullable();
    t.string('error', 500).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.bigInteger('submitted_at').nullable();
    t.bigInteger('decided_at').nullable();
    t.bigInteger('published_at').nullable();
    t.unique(['reference_id', 'number']);
    t.index(['kb_id', 'state']);
    t.index(['tenant_id', 'state']);
    t.index(['approval_run_id']);
    t.index(['document_id']);
  });
  await knex.schema.createTable('knowledge_reviewers', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('kb_id', 26).notNullable();
    t.string('duty', 10).notNullable();
    t.string('principal_kind', 10).notNullable();
    t.string('principal_id', 63).notNullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.unique(['kb_id', 'duty', 'principal_kind', 'principal_id'], { indexName: 'knowledge_reviewers_principal_unique' });
    t.index(['tenant_id']);
  });
  await knex.schema.alterTable('knowledge_bases', (t) => {
    t.string('review', 10).notNullable().defaultTo('off');
    t.string('review_workflow_id', 26).nullable();
    t.integer('review_four_eyes').notNullable().defaultTo(1);
  });
  const now = Date.now();
  for (const b of BUILTIN_TOOLS.filter((x) => NAMES.includes(x.name))) {
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
      checked_at: now,
      owner_id: null,
      owner_name: 'Platform',
      publish_scope: 'platform',
      created_at: now,
      updated_at: now
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex('registry_entries').where({ impl: 'builtin' }).whereIn('name', NAMES).delete();
  await knex.schema.alterTable('knowledge_bases', (t) => {
    t.dropColumn('review');
    t.dropColumn('review_workflow_id');
    t.dropColumn('review_four_eyes');
  });
  await knex.schema.dropTableIfExists('knowledge_reviewers');
  await knex.schema.dropTableIfExists('knowledge_revisions');
  await knex.schema.dropTableIfExists('knowledge_references');
}
