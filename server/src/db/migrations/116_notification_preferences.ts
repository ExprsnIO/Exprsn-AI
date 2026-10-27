import type { Knex } from 'knex';

/*
 * 1.9.0, Sprint 49 (B-153): notification preferences, tenant defaults and digests.
 *
 * - `notification_prefs`: one row per person: their time zone (IANA, null: UTC), quiet hours per weekday (`quiet`,
 *   JSON `{ mon: { start: 'HH:MM', end: 'HH:MM' } | null, … }`, a window whose end is before its start runs past
 *   midnight), whether urgent notifications pass through quiet hours, and the hour and weekday digests are sent at.
 * - `notification_pref_rules`: per person and notification kind (an id of the catalogue in
 *   `platform/notification-kinds.ts`), the choice per channel (`channels`, JSON `{ in_app: { enabled, timing }, … }`;
 *   timing `instant`, `hourly`, `daily` or `weekly`). A channel left out follows the tenant default.
 * - `notification_tenant_defaults`: per tenant and kind, the defaults per channel and whether the kind is mandatory
 *   (a person cannot turn it off or delay it).
 * - `notification_digest_items`: notifications held for a digest (timing, or quiet hours), with the title sealed with
 *   the tenant key (associated data `notification-digest:<id>`), due at `due_at`, sent once (`sent_at`).
 *
 * No row anywhere: today's behaviour (in-app now, email when the sender asks for it). Expand only. A build from before
 * this migration ignores the tables.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('notification_prefs'))) {
    await knex.schema.createTable('notification_prefs', (t) => {
      t.string('tenant_id', 26).notNullable();
      t.string('user_id', 26).notNullable();
      t.string('time_zone', 64).nullable();
      t.text('quiet').nullable();
      t.boolean('quiet_urgent').notNullable().defaultTo(true);
      t.integer('digest_hour').notNullable().defaultTo(8);
      t.integer('digest_weekday').notNullable().defaultTo(0);
      t.bigInteger('updated_at').notNullable();
      t.primary(['tenant_id', 'user_id']);
    });
  }
  if (!(await knex.schema.hasTable('notification_pref_rules'))) {
    await knex.schema.createTable('notification_pref_rules', (t) => {
      t.string('tenant_id', 26).notNullable();
      t.string('user_id', 26).notNullable();
      t.string('kind', 64).notNullable();
      t.text('channels').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.primary(['tenant_id', 'user_id', 'kind']);
    });
  }
  if (!(await knex.schema.hasTable('notification_tenant_defaults'))) {
    await knex.schema.createTable('notification_tenant_defaults', (t) => {
      t.string('tenant_id', 26).notNullable();
      t.string('kind', 64).notNullable();
      t.boolean('mandatory').notNullable().defaultTo(false);
      t.text('channels').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.string('updated_by', 26).nullable();
      t.primary(['tenant_id', 'kind']);
    });
  }
  if (!(await knex.schema.hasTable('notification_digest_items'))) {
    await knex.schema.createTable('notification_digest_items', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('user_id', 26).notNullable();
      t.string('kind', 120).notNullable();
      t.string('channel', 16).notNullable();
      t.string('period', 16).notNullable();
      t.string('label', 16).notNullable();
      t.text('title_sealed').notNullable();
      t.string('route', 300).nullable();
      t.bigInteger('due_at').notNullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('sent_at').nullable();
      t.index(['tenant_id', 'sent_at', 'due_at']);
      t.index(['tenant_id', 'user_id']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('notification_digest_items');
  await knex.schema.dropTableIfExists('notification_tenant_defaults');
  await knex.schema.dropTableIfExists('notification_pref_rules');
  await knex.schema.dropTableIfExists('notification_prefs');
}
