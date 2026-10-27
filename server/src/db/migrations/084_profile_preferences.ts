import type { Knex } from 'knex';

/*
 * Default profile and visible profiles (2.0.0, 2026-10-15).
 *
 * `profile_preferences`: one row per tenant, workspace or person (`scope` + `scope_id`). `default_profile` is the
 * profile name a new conversation starts on; `enforced` (tenant and workspace rows) makes that default win over
 * people's own choice. `hidden` (person rows) is a JSON array of profile names the person keeps out of their chat and
 * compare pickers. Resolution is in `gateway/profile-preferences.ts`.
 *
 * Expand only. A build from before this migration ignores the table.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('profile_preferences')) return;
  await knex.schema.createTable('profile_preferences', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('scope', 20).notNullable();
    t.string('scope_id', 26).notNullable();
    t.string('default_profile', 63).nullable();
    t.boolean('enforced').notNullable().defaultTo(false);
    t.text('hidden').nullable();
    t.string('updated_by', 26).nullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'scope', 'scope_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('profile_preferences');
}
