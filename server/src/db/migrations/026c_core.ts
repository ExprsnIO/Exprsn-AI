import type { Knex } from 'knex';

/*
 * Sprint 24 (1.4.0), platform core (026c): plugins as data (B-2002). One row per plugin per tenant (its manifest,
 * the capabilities asked for and granted, the lifecycle state and sealed configuration), and the history of its
 * lifecycle transitions (also in the audit chain). The event catalogue (B-2001), realtime rooms (B-2101) and the cache
 * (B-2102) need no tables. Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('plugins', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('plugin_key', 63).notNullable();
    t.string('name', 100).notNullable();
    t.string('version', 100).notNullable();
    t.string('kind', 20).notNullable(); // declarative | webhook | script
    t.text('manifest', 'mediumtext').notNullable(); // JSON, as validated
    t.string('manifest_hash', 64).notNullable(); // sha256 of the canonical manifest
    t.text('granted').notNullable(); // JSON: capabilities granted (a subset of the manifest's)
    t.string('max_label', 20).notNullable().defaultTo('internal');
    t.text('config_sealed', 'mediumtext').nullable(); // JSON, sealed with the tenant key
    t.string('state', 20).notNullable(); // installed | enabled | disabled | removed
    t.string('installed_by', 26).nullable();
    t.string('updated_by', 26).nullable();
    t.bigInteger('state_changed_at').notNullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'plugin_key']);
    t.index(['tenant_id', 'state']);
  });

  await knex.schema.createTable('plugin_transitions', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('plugin_id', 26).notNullable();
    t.string('event', 20).notNullable(); // install | enable | disable | remove | grants
    t.string('from_state', 20).nullable();
    t.string('to_state', 20).notNullable();
    t.string('version', 100).notNullable();
    t.string('actor', 200).nullable(); // user id, or `service:<name>` for the CLI
    t.string('reason', 500).nullable();
    t.bigInteger('created_at').notNullable();
    t.index(['plugin_id', 'created_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('plugin_transitions');
  await knex.schema.dropTableIfExists('plugins');
}
