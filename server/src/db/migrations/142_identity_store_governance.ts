import type { Knex } from 'knex';

/*
 * 1.9.9-qa, Sprint QA-1 (Sprint 54 leftovers, B-181, B-185, B-186): governance of user stores
 * (`identity/store-governance.ts`).
 *
 * - `identity_store_settings`: one row per tenant. `dual_control` is `auto` (on when the tenant has two or more
 *   identity admins), `on` or `off`; `purge_after_days` how long an archived store is kept before it may be purged
 *   (default 30).
 * - `identity_store_proposals`: changes waiting for a second identity admin: a store's connection or attribute
 *   configuration (`store.config`), restoring a saved backup (`store.restore`), purging an archived store
 *   (`store.purge`) and turning dual control off (`settings`). The payload holds secret references only, never values,
 *   and a backup by its id, never its contents. `provider_id` has no foreign key: a decided proposal outlives its store.
 * - `identity_store_backup_schedules`: one per store: daily or weekly, how many and how long to keep, when it runs next
 *   and how the last run went.
 * - `identity_store_backups.origin`: `manual`, `schedule` or `upload` (null for backups saved before this migration:
 *   manual). Only scheduled backups are pruned by a schedule's retention.
 *
 * Expand only: three new tables and one nullable column. A build from before this migration ignores them; this build
 * reports the settings, proposals, purge rules, schedules and the origin as not available while they are missing, and
 * changes, restores and removal of stores work as before.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('identity_store_settings'))) {
    await knex.schema.createTable('identity_store_settings', (t) => {
      t.string('tenant_id', 26).primary();
      t.string('dual_control', 8).notNullable().defaultTo('auto'); // auto | on | off
      t.integer('purge_after_days').notNullable().defaultTo(30);
      t.string('updated_by', 26).nullable();
      t.bigInteger('updated_at').notNullable();
    });
  }
  if (!(await knex.schema.hasTable('identity_store_proposals'))) {
    await knex.schema.createTable('identity_store_proposals', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('kind', 20).notNullable(); // store.config | store.restore | store.purge | settings
      t.string('provider_id', 26).nullable();
      t.string('name', 200).notNullable();
      t.text('payload', 'mediumtext').notNullable(); // JSON; secrets are references, a backup is its id
      t.string('summary', 1000).nullable();
      t.string('state', 20).notNullable(); // pending | approved | rejected | withdrawn | superseded
      t.string('proposed_by', 26).notNullable();
      t.bigInteger('proposed_at').notNullable();
      t.string('decided_by', 26).nullable();
      t.bigInteger('decided_at').nullable();
      t.string('note', 500).nullable();
      t.index(['tenant_id', 'state']);
      t.index(['tenant_id', 'provider_id']);
    });
  }
  if (!(await knex.schema.hasTable('identity_store_backup_schedules'))) {
    await knex.schema.createTable('identity_store_backup_schedules', (t) => {
      t.string('provider_id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('frequency', 8).notNullable(); // daily | weekly
      t.integer('keep_count').nullable();
      t.integer('keep_days').nullable();
      t.boolean('enabled').notNullable().defaultTo(true);
      t.bigInteger('next_run_at').notNullable();
      t.bigInteger('last_run_at').nullable();
      t.string('last_status', 10).nullable(); // ok | failed
      t.string('last_error', 500).nullable();
      t.string('last_backup_id', 26).nullable();
      t.integer('failures').notNullable().defaultTo(0);
      t.string('updated_by', 26).nullable();
      t.bigInteger('updated_at').notNullable();
      t.index(['tenant_id']);
      t.index(['enabled', 'next_run_at']);
    });
  }
  if ((await knex.schema.hasTable('identity_store_backups')) && !(await knex.schema.hasColumn('identity_store_backups', 'origin'))) {
    await knex.schema.alterTable('identity_store_backups', (t) => t.string('origin', 10).nullable());
  }
}

export async function down(knex: Knex): Promise<void> {
  if ((await knex.schema.hasTable('identity_store_backups')) && (await knex.schema.hasColumn('identity_store_backups', 'origin'))) {
    await knex.schema.alterTable('identity_store_backups', (t) => t.dropColumn('origin'));
  }
  await knex.schema.dropTableIfExists('identity_store_backup_schedules');
  await knex.schema.dropTableIfExists('identity_store_proposals');
  await knex.schema.dropTableIfExists('identity_store_settings');
}
