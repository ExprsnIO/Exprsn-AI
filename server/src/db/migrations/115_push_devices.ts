import type { Knex } from 'knex';

/*
 * 1.9.0, Sprint 49 (B-150): each person's push devices.
 *
 * - `push_devices`: one row per registered endpoint: the platform (`ios`, `android`, `web`, `desktop`), the provider
 *   kind (`apns`, `fcm`, `webpush`, `http`, `websocket`), the app or bundle id, a name the person chose, and the token
 *   or Web Push subscription sealed with the tenant key (`token_sealed`, associated data `push-device:<id>`). The
 *   token itself is never stored in the clear: `token_digest` (SHA-256 over tenant, provider, app id and the token, or
 *   the subscription's endpoint) finds a re-registration, so the same token updates its row instead of adding one
 *   (unique per tenant), and `fingerprint` is the short value the console shows. `session_id` is the session the
 *   device was registered from (null for an API key or OAuth token), so "sign out everywhere else" keeps the device of
 *   the session that asked. `state` is `active`, `revoked` (by the person, an admin, or with the person's sessions) or
 *   `gone` (the provider said the token no longer exists); an ended device keeps no token (`token_sealed` is cleared).
 *
 * Expand only. A build from before this migration ignores the table.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('push_devices')) return;
  await knex.schema.createTable('push_devices', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('session_id', 128).nullable();
    t.string('platform', 16).notNullable();
    t.string('provider', 16).notNullable();
    t.string('app_id', 255).nullable();
    t.string('name', 100).notNullable();
    t.string('token_digest', 64).notNullable();
    t.text('token_sealed').nullable();
    t.string('fingerprint', 32).notNullable();
    t.string('state', 16).notNullable().defaultTo('active');
    t.string('state_reason', 200).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('last_seen_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.bigInteger('ended_at').nullable();
    t.unique(['tenant_id', 'token_digest']);
    t.index(['tenant_id', 'user_id', 'state']);
    t.index(['state', 'last_seen_at']);
    t.index(['session_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('push_devices');
}
