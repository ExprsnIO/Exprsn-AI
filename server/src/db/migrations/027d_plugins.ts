import type { Knex } from 'knex';

/*
 * Sprint 25 (1.4.0), plugins that run (027d): B-2003 to B-2005.
 *
 * - `plugins` gains where it came from (`source`: inline or a signed bundle, with the bundle, its digest, the path in
 *   it and the signer's key fingerprint).
 * - `plugin_invocations`: one row per event delivered to a plugin (the event sealed), run as a `plugin.invoke` job.
 *   `(plugin_id, event_id)` is unique, so an event reaches a plugin once however many instances see it. `chain` is
 *   the plugins the event was caused by (loop prevention).
 * - `plugin_tokens`: the short-lived scoped tokens a script handler's platform calls are brokered through, stored
 *   as sha256 only.
 * - `plugin_logs`: the plugin's own log (`emit:log` and a handler's output), sealed.
 * Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('plugins', (t) => {
    t.string('source', 20).notNullable().defaultTo('inline'); // inline | bundle
    t.string('bundle_id', 26).nullable();
    t.string('bundle_digest', 80).nullable();
    t.string('bundle_path', 400).nullable();
    t.string('signer_fingerprint', 64).nullable();
  });

  await knex.schema.createTable('plugin_invocations', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('plugin_id', 26).notNullable();
    t.string('event_type', 120).notNullable();
    t.string('event_id', 120).notNullable();
    t.string('label', 20).notNullable();
    t.text('event_sealed', 'mediumtext').notNullable(); // the event envelope, sealed with the tenant key
    t.string('chain', 400).notNullable().defaultTo('[]'); // JSON: ids of the plugins that caused the event
    t.string('state', 20).notNullable(); // queued | running | succeeded | failed
    t.integer('attempts').notNullable().defaultTo(0);
    t.string('job_id', 26).nullable();
    t.text('outcome').nullable(); // JSON: per action or call, its type and result (no tenant content)
    t.string('error', 1000).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('started_at').nullable();
    t.bigInteger('finished_at').nullable();
    t.unique(['plugin_id', 'event_id']);
    t.index(['tenant_id', 'plugin_id', 'created_at']);
    t.index(['plugin_id', 'state']);
  });

  await knex.schema.createTable('plugin_tokens', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('plugin_id', 26).notNullable();
    t.string('invocation_id', 26).notNullable();
    t.string('token_hash', 64).notNullable().unique();
    t.text('grants').notNullable(); // JSON: the plugin's grants when the token was made
    t.integer('calls').notNullable().defaultTo(0);
    t.bigInteger('expires_at').notNullable();
    t.bigInteger('revoked_at').nullable();
    t.bigInteger('created_at').notNullable();
    t.index(['invocation_id']);
  });

  await knex.schema.createTable('plugin_logs', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('plugin_id', 26).notNullable();
    t.string('invocation_id', 26).nullable();
    t.string('level', 10).notNullable(); // info | warn | error
    t.text('message_sealed', 'mediumtext').notNullable();
    t.bigInteger('created_at').notNullable();
    t.index(['tenant_id', 'plugin_id', 'created_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('plugin_logs');
  await knex.schema.dropTableIfExists('plugin_tokens');
  await knex.schema.dropTableIfExists('plugin_invocations');
  await knex.schema.alterTable('plugins', (t) => {
    t.dropColumn('signer_fingerprint');
    t.dropColumn('bundle_path');
    t.dropColumn('bundle_digest');
    t.dropColumn('bundle_id');
    t.dropColumn('source');
  });
}
