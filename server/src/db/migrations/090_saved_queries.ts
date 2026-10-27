import type { Knex } from 'knex';
import { BUILTIN_TOOLS } from '../../registry/builtin/catalog.js';

/*
 * Sprint 45 (B-125): saved, named, parameterised connection queries. Expand only.
 *
 * - `connection_queries`: a tenant's named query on one data connection: its label, description, whether it is a
 *   write query (saved by a connections manager, never run where writes are not allowed), whether app lookups may use
 *   it, the draft (query text, typed parameters, row and time limits) with the classification it got when it was
 *   saved, the draft revision the editor saves against, and the version in force.
 * - `connection_query_versions`: each published definition with its classification, `published` or `retired`.
 * - The built-in tool `connections.query` (read-only, platform entry, published to every tenant), seeded from the
 *   catalogue as 049 seeds its tools.
 *
 * A build from before this migration ignores both tables; the tool entry answers "unknown built-in" there.
 */
const NAMES = ['connections.query'];

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('connection_queries'))) {
    await knex.schema.createTable('connection_queries', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('connection_id', 26).notNullable();
      t.string('name', 63).notNullable();
      t.string('title', 200).nullable();
      t.string('description', 1000).nullable();
      t.string('label', 20).notNullable();
      t.boolean('write').notNullable().defaultTo(false);
      t.boolean('lookups').notNullable().defaultTo(false);
      t.text('draft', 'mediumtext').notNullable();
      t.text('draft_classification', 'mediumtext').nullable();
      t.integer('draft_rev').notNullable().defaultTo(1);
      t.integer('published_version').nullable();
      t.string('created_by', 26).nullable();
      t.string('updated_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.unique(['tenant_id', 'name']);
      t.index(['tenant_id', 'connection_id']);
    });
  }
  if (!(await knex.schema.hasTable('connection_query_versions'))) {
    await knex.schema.createTable('connection_query_versions', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('query_id', 26).notNullable();
      t.integer('version').notNullable();
      t.text('definition', 'mediumtext').notNullable();
      t.text('classification', 'mediumtext').notNullable();
      t.string('state', 20).notNullable();
      t.string('note', 500).nullable();
      t.string('published_by', 26).nullable();
      t.bigInteger('published_at').notNullable();
      t.unique(['query_id', 'version']);
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
  await knex.schema.dropTableIfExists('connection_query_versions');
  await knex.schema.dropTableIfExists('connection_queries');
}
