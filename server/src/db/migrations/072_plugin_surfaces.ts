import type { Knex } from 'knex';

/*
 * 1.7.0, Sprint 43 (B-112): plugin UI surfaces.
 *
 * - `plugin_surfaces`: per installed plugin and surface (an id from its manifest's `ui`), who approved it and when,
 *   and whether it is enabled. No row: not approved, not shown. The surfaces themselves are in the manifest.
 *
 * Expand only. A build from before this migration ignores the table (and refuses a manifest with `ui`).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('plugin_surfaces'))) {
    await knex.schema.createTable('plugin_surfaces', (t) => {
      t.string('tenant_id', 26).notNullable();
      t.string('plugin_id', 26).notNullable();
      t.string('surface_id', 40).notNullable();
      t.string('approved_by', 26).nullable();
      t.bigInteger('approved_at').nullable();
      t.boolean('enabled').notNullable().defaultTo(false);
      t.bigInteger('updated_at').notNullable();
      t.primary(['plugin_id', 'surface_id']);
      t.index(['tenant_id']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('plugin_surfaces');
}
