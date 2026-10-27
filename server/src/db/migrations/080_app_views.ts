import type { Knex } from 'knex';

/*
 * 1.7.0, the exprsn-platform low-code port (docs/decisions/lowcode-port.md, follow-up 1): saved views of the Apps
 * Records tab.
 *
 * - `app_views`: a named configuration of one entity's records (layout, board grouping, filters, search, sort, columns,
 *   rows per page), private to `owner_id` or `shared` with the app's readers. `data` is the name and the settings
 *   sealed with the tenant key (associated data `app-view:<id>`); `label` decides who it is listed to.
 * - `app_view_defaults`: one person's default view of one entity.
 *
 * Expand only. Both tables are emptied with their entity or app; a build from before this migration ignores them.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('app_views'))) {
    await knex.schema.createTable('app_views', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('app_id', 26).notNullable();
      t.string('entity_id', 26).notNullable();
      t.string('owner_id', 26).notNullable();
      t.boolean('shared').notNullable().defaultTo(false);
      t.string('label', 20).notNullable();
      t.text('data', 'mediumtext').notNullable();
      t.string('updated_by', 26).notNullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.index(['tenant_id', 'entity_id']);
      t.index(['app_id']);
      t.index(['owner_id']);
    });
  }
  if (!(await knex.schema.hasTable('app_view_defaults'))) {
    await knex.schema.createTable('app_view_defaults', (t) => {
      t.string('tenant_id', 26).notNullable();
      t.string('user_id', 26).notNullable();
      t.string('app_id', 26).notNullable();
      t.string('entity_id', 26).notNullable();
      t.string('view_id', 26).notNullable();
      t.bigInteger('updated_at').notNullable();
      t.primary(['user_id', 'entity_id']);
      t.index(['view_id']);
      t.index(['app_id']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('app_view_defaults');
  await knex.schema.dropTableIfExists('app_views');
}
