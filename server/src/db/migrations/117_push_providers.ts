import type { Knex } from 'knex';

/*
 * 1.9.0, Sprint 49 (B-151): push providers.
 *
 * - `push_providers`: one row per provider: a platform default (`scope` platform, no tenant) or a tenant's override
 *   (`scope` tenant). `kind` is apns, fcm, webpush, http or websocket; `config` is the kind's settings as JSON, whose
 *   credentials are only `vault:` references (never a secret); `app_id` the bundle id or project it serves; `owner_id`
 *   the admin whose vault policy a tenant provider's references resolve under; the last credential check.
 *
 * Expand only. A build from before this migration ignores the table (nothing is pushed).
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('push_providers')) return;
  await knex.schema.createTable('push_providers', (t) => {
    t.string('id', 26).primary();
    t.string('scope', 10).notNullable();
    t.string('tenant_id', 26).nullable();
    t.string('kind', 20).notNullable();
    t.string('name', 100).notNullable();
    t.string('app_id', 200).nullable();
    t.boolean('enabled').notNullable().defaultTo(true);
    t.text('config').notNullable();
    t.string('owner_id', 26).nullable();
    t.bigInteger('last_check_at').nullable();
    t.boolean('last_check_ok').nullable();
    t.string('last_check_detail', 500).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['scope', 'tenant_id', 'kind'], 'push_providers_scope_kind');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('push_providers');
}
