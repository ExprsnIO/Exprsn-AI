import type { Knex } from 'knex';

/*
 * 1.9.0, Sprint 49 (B-152): the push delivery log.
 *
 * - `push_deliveries`: one row per attempt (or per socket delivery): the person, notification, device and provider,
 *   the channel (push or websocket), the notification's kind, the outcome (sent, failed, dropped, suppressed,
 *   retrying, waiting for a socket acknowledgement), the provider's status and short reason, the latency, the attempt
 *   and whether it was a test. Never the token, a credential or the notification's text. Kept 30 days by the
 *   `push.deliveries.sweep` job.
 *
 * Expand only. A build from before this migration ignores the table.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('push_deliveries')) return;
  await knex.schema.createTable('push_deliveries', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('notification_id', 26).nullable();
    t.string('device_id', 26).nullable();
    t.string('provider_id', 26).nullable();
    t.string('provider_kind', 20).nullable();
    t.string('provider_scope', 10).nullable();
    t.string('channel', 12).notNullable();
    t.string('kind', 100).notNullable();
    t.string('outcome', 12).notNullable();
    t.integer('status').nullable();
    t.string('reason', 200).nullable();
    t.integer('latency_ms').nullable();
    t.integer('attempt').notNullable().defaultTo(1);
    t.boolean('test').notNullable().defaultTo(false);
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'created_at'], 'push_deliveries_tenant_time');
    t.index(['provider_id', 'created_at'], 'push_deliveries_provider_time');
    t.index(['created_at'], 'push_deliveries_time');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('push_deliveries');
}
