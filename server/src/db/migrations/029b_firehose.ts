import type { Knex } from 'knex';

/*
 * Sprint 27 (1.4.0), AT-Protocol firehose ingest (029b, B-1908): per-tenant subscriptions to a Jetstream or a relay's
 * com.atproto.sync.subscribeRepos, with their filters (collections, authors, sampling), the desired state an admin
 * sets (running or stopped), the lease that keeps each consumer on one instance, the persisted cursor and the running
 * counts. Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('firehose_subscriptions', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('name', 100).notNullable();
    t.string('protocol', 20).notNullable(); // jetstream | subscribe-repos
    t.string('endpoint', 500).notNullable(); // ws:// or wss:// base (or full URL) of the service
    t.text('collections').notNullable(); // JSON: NSIDs (or `prefix.*`) to take; others are skipped
    t.text('dids', 'mediumtext').nullable(); // JSON: author DIDs to take, null for everyone
    t.integer('sample_ppm').notNullable().defaultTo(1_000_000); // parts per million of matching posts checked
    t.string('workspace_id', 26).nullable(); // where flags go; null for the tenant queue
    t.string('label', 20).notNullable().defaultTo('public');
    t.string('state', 20).notNullable(); // running | stopped (what an admin asked for)
    t.integer('rev').notNullable().defaultTo(1); // moves on every configuration change; a running consumer restarts
    t.string('status', 20).notNullable().defaultTo('idle'); // idle | connecting | streaming | backoff | error
    t.string('holder', 40).nullable(); // the instance running the consumer
    t.bigInteger('lease_until').nullable();
    t.bigInteger('cursor').nullable(); // Jetstream time_us or the relay's seq of the last event handled
    t.bigInteger('cursor_at').nullable(); // when the cursor was last stored
    t.bigInteger('last_event_at').nullable();
    t.string('last_error', 500).nullable();
    t.bigInteger('received').notNullable().defaultTo(0);
    t.bigInteger('checked').notNullable().defaultTo(0);
    t.bigInteger('flagged').notNullable().defaultTo(0);
    t.bigInteger('labelled').notNullable().defaultTo(0);
    t.bigInteger('failed').notNullable().defaultTo(0);
    t.integer('reconnects').notNullable().defaultTo(0);
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'name']);
    t.index(['state']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('firehose_subscriptions');
}
