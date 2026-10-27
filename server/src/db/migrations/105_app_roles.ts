import type { Knex } from 'knex';

/*
 * 1.8.0, Sprint 48 (B-143): app-local roles (`apps/roles.ts`).
 *
 * - `app_roles`: an app's own role catalogue (Clerk, Approver, Viewer...): a name unique per app (compared without
 *   case: `name_key` is the lower-cased name, unique with the app) and an optional description. Row and field
 *   policies name a role with the subject `{ kind: 'app_role', value: <name> }`. Packages carry the catalogue.
 * - `app_role_members`: who holds a role in this environment: a person (`user`), a social group (`group`, whose
 *   members count through `s.groups.subjects`) or a workspace's members (`workspace`, the default role of everyone in
 *   it). One row per role and subject. Packages never carry these: each environment assigns its own people.
 *
 * Expand only: a build from before this migration ignores the tables (and refuses the subject kind it does not know).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('app_roles'))) {
    await knex.schema.createTable('app_roles', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('app_id', 26).notNullable();
      t.string('name', 63).notNullable();
      t.string('name_key', 63).notNullable();
      t.string('description', 500).nullable();
      t.string('created_by', 26).nullable();
      t.string('updated_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.unique(['app_id', 'name_key'], { indexName: 'app_roles_name_uq' });
      t.index(['tenant_id', 'app_id'], 'app_roles_app');
    });
  }
  if (!(await knex.schema.hasTable('app_role_members'))) {
    await knex.schema.createTable('app_role_members', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('app_id', 26).notNullable();
      t.string('role_id', 26).notNullable();
      t.string('subject_kind', 16).notNullable();
      t.string('subject_id', 26).notNullable();
      t.string('created_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.unique(['role_id', 'subject_kind', 'subject_id'], { indexName: 'app_role_members_uq' });
      t.index(['app_id'], 'app_role_members_app');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('app_role_members');
  await knex.schema.dropTableIfExists('app_roles');
}
