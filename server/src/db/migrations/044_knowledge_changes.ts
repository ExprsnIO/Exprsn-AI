import type { Knex } from 'knex';
import { BUILTIN_TOOLS } from '../../registry/builtin/catalog.js';

/*
 * Differentials of crawled pages (044_knowledge_changes). Expand only.
 *
 * - `knowledge_doc_changes`: one row each time a sync of a source that records changes finds a document new,
 *   changed or gone: how many lines its text gained and lost, and the line diff, sealed with the tenant's key (the
 *   row id as associated data). `label` is the document's label at the time, so a reader sees only what they are
 *   cleared for. Rows go with their source and their knowledge base.
 * - `registry_entries`: the built-in tool `knowledge_changes` (added to the catalogue with this migration).
 */
const NAMES = ['knowledge_changes'];

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('knowledge_doc_changes', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('kb_id', 26).notNullable();
    t.string('source_id', 26).notNullable();
    t.string('document_id', 26).notNullable();
    t.string('kind', 16).notNullable();
    t.string('name', 300).notNullable();
    t.string('label', 16).notNullable();
    t.integer('label_rank').notNullable();
    t.integer('added').notNullable().defaultTo(0);
    t.integer('removed').notNullable().defaultTo(0);
    t.text('diff_sealed', 'mediumtext').nullable();
    t.integer('truncated').notNullable().defaultTo(0);
    t.bigInteger('created_at').notNullable();
    t.index(['kb_id', 'created_at']);
    t.index(['source_id', 'created_at']);
    t.index(['document_id']);
    t.index(['tenant_id']);
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
  await knex.schema.dropTableIfExists('knowledge_doc_changes');
}
