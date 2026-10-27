import type { Knex } from 'knex';
import { BUILTIN_TOOLS } from '../../registry/builtin/catalog.js';

/*
 * Sprint 46 (B-131): decision tables. Expand only.
 *
 * - `decision_tables`: a tenant's named table with its label and the draft definition (JSON: input and output
 *   columns, rules, hit policy; `decisions/table.ts`), the draft revision the editor saves against, and the version in
 *   force.
 * - `decision_table_versions`: each published definition, `published` or `deprecated`, kept for pinned workflow steps.
 * - The built-in tool `decision.evaluate` (read-only, platform entry, published to every tenant), seeded from the
 *   catalogue as 049 seeds its tools.
 *
 * A build from before this migration ignores both tables; the tool entry answers "unknown built-in" there.
 */
const NAMES = ['decision.evaluate'];

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('decision_tables'))) {
    await knex.schema.createTable('decision_tables', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('name', 63).notNullable();
      t.string('title', 200).nullable();
      t.string('description', 500).nullable();
      t.string('label', 20).notNullable();
      t.text('draft', 'mediumtext').notNullable();
      t.integer('draft_rev').notNullable().defaultTo(1);
      t.integer('published_version').nullable();
      t.string('created_by', 26).nullable();
      t.string('updated_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.unique(['tenant_id', 'name']);
    });
  }
  if (!(await knex.schema.hasTable('decision_table_versions'))) {
    await knex.schema.createTable('decision_table_versions', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('table_id', 26).notNullable();
      t.integer('version').notNullable();
      t.text('definition', 'mediumtext').notNullable();
      t.string('state', 20).notNullable();
      t.string('note', 500).nullable();
      t.string('published_by', 26).nullable();
      t.bigInteger('published_at').notNullable();
      t.unique(['table_id', 'version']);
      t.index(['tenant_id']);
    });
  }
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
  await knex.schema.dropTableIfExists('decision_table_versions');
  await knex.schema.dropTableIfExists('decision_tables');
}
