import type { Knex } from 'knex';

/*
 * 1.7.0, Sprint 43 (B-98): groups as access subjects.
 *
 * - `social_groups.ownerless_at` (B-9801): when the sweep first found the group with no owner whose account is
 *   active, and told its managers; NULL while it has one. Existing groups start NULL and are found by the first sweep.
 * - `file_group_grants` (B-9802): a social group as a reader of one file or of one folder (and what is below it).
 * - `apps.group_id`, `app_entities.group_id` (B-9805): the social group an app, or an entity's records, are scoped to.
 *
 * Vault grants (B-9803) and knowledge access (B-9804) name a social group in their existing subject columns, with the
 * new kinds `social_group`; they need no column.
 *
 * Expand only; no existing row changes. A build from before this migration ignores the columns.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('social_groups', 'ownerless_at'))) {
    await knex.schema.alterTable('social_groups', (t) => {
      t.bigInteger('ownerless_at').nullable();
    });
  }
  if (!(await knex.schema.hasTable('file_group_grants'))) {
    await knex.schema.createTable('file_group_grants', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('file_id', 26).nullable();
      t.string('folder_id', 26).nullable();
      t.string('group_id', 26).notNullable();
      t.string('created_by', 26).notNullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('revoked_at').nullable();
      t.string('revoked_by', 26).nullable();
      t.index(['tenant_id', 'group_id']);
      t.index(['tenant_id', 'file_id']);
      t.index(['tenant_id', 'folder_id']);
    });
  }
  for (const table of ['apps', 'app_entities']) {
    if (!(await knex.schema.hasColumn(table, 'group_id'))) {
      await knex.schema.alterTable(table, (t) => {
        t.string('group_id', 26).nullable();
      });
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['apps', 'app_entities']) {
    if (await knex.schema.hasColumn(table, 'group_id')) await knex.schema.alterTable(table, (t) => t.dropColumn('group_id'));
  }
  await knex.schema.dropTableIfExists('file_group_grants');
  if (await knex.schema.hasColumn('social_groups', 'ownerless_at')) {
    await knex.schema.alterTable('social_groups', (t) => {
      t.dropColumn('ownerless_at');
    });
  }
}
