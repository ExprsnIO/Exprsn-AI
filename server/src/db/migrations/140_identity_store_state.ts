import type { Knex } from 'knex';

/*
 * 1.9.0, Sprint 54 (B-181, B-185): user-store state and configuration versions (`identity/store-admin.ts`).
 *
 * - `identity_providers.state`: null (active) or `archived`. An archived store is also `enabled = false`, so every
 *   reader that filters on `enabled` (the sign-in chain, directory sync, the redirect sign-in options, SCIM) leaves it
 *   out even in a build that does not know the column. `state_before` is `enabled` or `disabled`, what restore goes
 *   back to; `archived_at` and `archived_by` say when and who.
 * - `identity_provider_versions`: every saved change of a store (name, order, enabled, configuration) as a numbered
 *   version with the reason given, who and when. Configurations hold secret references only, never values, so a
 *   version is safe to show and to diff. Kept after the store is removed (no foreign key), for the audit trail and for
 *   store backups.
 *
 * Expand only: four nullable columns and one new table. A build from before this migration ignores them; this build
 * reports archiving and versions as not available while they are missing, and the wizard still creates stores.
 */
export async function up(knex: Knex): Promise<void> {
  const add: [string, (t: Knex.AlterTableBuilder) => void][] = [
    ['state', (t) => t.string('state', 16).nullable()],
    ['state_before', (t) => t.string('state_before', 16).nullable()],
    ['archived_at', (t) => t.bigInteger('archived_at').nullable()],
    ['archived_by', (t) => t.string('archived_by', 26).nullable()]
  ];
  for (const [column, define] of add) {
    if (!(await knex.schema.hasColumn('identity_providers', column))) await knex.schema.alterTable('identity_providers', define);
  }
  if (!(await knex.schema.hasTable('identity_provider_versions'))) {
    await knex.schema.createTable('identity_provider_versions', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('provider_id', 26).notNullable();
      t.integer('version').notNullable();
      t.string('name', 100).notNullable();
      t.string('kind', 20).notNullable();
      t.integer('position').notNullable();
      t.boolean('enabled').notNullable();
      t.text('config', 'mediumtext').notNullable(); // JSON; secrets are references
      t.string('reason', 500).nullable();
      t.string('created_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.unique(['provider_id', 'version']);
      t.index(['tenant_id', 'provider_id']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('identity_provider_versions');
  for (const column of ['archived_by', 'archived_at', 'state_before', 'state']) {
    if (await knex.schema.hasColumn('identity_providers', column)) await knex.schema.alterTable('identity_providers', (t) => t.dropColumn(column));
  }
}
