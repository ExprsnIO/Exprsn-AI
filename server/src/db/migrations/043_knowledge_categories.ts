import type { Knex } from 'knex';
import { BUILTIN_TOOLS } from '../../registry/builtin/catalog.js';

/*
 * Knowledge categories (043_knowledge_categories). Expand only.
 *
 * - `knowledge_doc_categories`: the categories a document is filed under. One row per document and path, for the
 *   path it was given (`direct` 1) and for every category that path is under (`direct` 0), so a filter on a category
 *   also finds what is filed under its subcategories with an equality on `path`.
 * - `registry_entries`: the built-in tools `knowledge_add`, `knowledge_categorize`, `knowledge_categories` and
 *   `files.search` (added to the catalogue with this migration), and the descriptions and input schemas of `knowledge_search`,
 *   `knowledge_list` and `knowledge_save`, which take categories.
 */
const NAMES = ['knowledge_add', 'knowledge_categorize', 'knowledge_categories', 'files.search'];
const CHANGED = ['knowledge_search', 'knowledge_list', 'knowledge_save'];

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('knowledge_doc_categories', (t) => {
    t.string('document_id', 26).notNullable();
    t.string('path', 400).notNullable();
    t.string('tenant_id', 26).notNullable();
    t.string('kb_id', 26).notNullable();
    t.integer('depth').notNullable();
    t.integer('direct').notNullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.primary(['document_id', 'path']);
    t.index(['kb_id', 'path']);
    t.index(['tenant_id']);
  });
  const now = Date.now();
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
      checked_at: now,
      owner_id: null,
      owner_name: 'Platform',
      publish_scope: 'platform',
      created_at: now,
      updated_at: now
    });
  }
  for (const b of BUILTIN_TOOLS.filter((x) => CHANGED.includes(x.name))) await knex('registry_entries').where({ id: b.id }).update({ description: b.description, input_schema: JSON.stringify(b.inputSchema), output_schema: JSON.stringify(b.outputSchema), updated_at: now });
}

export async function down(knex: Knex): Promise<void> {
  await knex('registry_entries').where({ impl: 'builtin' }).whereIn('name', NAMES).delete();
  await knex.schema.dropTableIfExists('knowledge_doc_categories');
}
