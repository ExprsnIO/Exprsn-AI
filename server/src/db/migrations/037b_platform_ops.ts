import type { Knex } from 'knex';

/*
 * Sprint 35b (1.6.0), the Overview and Jobs and queues screens: B-4202, B-4203.
 *
 * - `platform_instances`: one row per running server process, written by its own heartbeat. `checks` (JSON) is what
 *   its `/readyz` answered at the last beat (database, migrations, schema, kms, blobs, shutdown); `runtime` (JSON) is
 *   what the Overview inspector shows (rate-limit store, tracing counters, NTP offset, sockets, jobs claimed). `drain`
 *   is set by an administrator on any instance and honoured by the instance itself at its next beat (or at once, over
 *   the bus): it stops claiming jobs and answers `/readyz` with 503. A row whose beat is old belongs to an instance
 *   that went away; rows older than a day are removed by the next beat of any instance.
 * - `job_type_pauses`: job types no instance claims while a row exists (they keep being queued). Platform-wide.
 * - `schedule_pauses`: schedules the Scheduler skips while a row exists; the buckets missed are not caught up.
 * - `platform_alert_acks`: alerts acknowledged per tenant (B-4202, Q15: tenant-wide). An alert's key names its
 *   occurrence (the instance and migration, the time the RPO watch raised it, the drifted objects), so a new
 *   occurrence is a new key and shows again.
 *
 * Expand only: new tables.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('platform_instances', (t) => {
    t.string('id', 100).primary();
    t.string('node', 200).notNullable();
    t.integer('pid').notNullable();
    t.string('role', 40).notNullable(); // "api, jobs" | "api"
    t.string('version', 40).notNullable();
    t.string('state', 20).notNullable(); // ready | not ready | draining
    t.text('checks').notNullable(); // JSON
    t.text('runtime').notNullable(); // JSON
    t.string('schema_state', 20).nullable(); // current | ahead | behind
    t.string('schema_detail', 500).nullable();
    t.integer('jobs_claimed').notNullable().defaultTo(0);
    t.integer('sockets').notNullable().defaultTo(0);
    t.boolean('drain').notNullable().defaultTo(false);
    t.string('drained_by', 26).nullable();
    t.bigInteger('drained_at').nullable();
    t.bigInteger('started_at').notNullable();
    t.bigInteger('heartbeat_at').notNullable();
    t.index(['heartbeat_at']);
  });

  await knex.schema.createTable('job_type_pauses', (t) => {
    t.string('type', 100).primary();
    t.string('reason', 500).nullable();
    t.string('paused_by', 26).nullable();
    t.bigInteger('paused_at').notNullable();
  });

  await knex.schema.createTable('schedule_pauses', (t) => {
    t.string('name', 100).primary();
    t.string('reason', 500).nullable();
    t.string('paused_by', 26).nullable();
    t.bigInteger('paused_at').notNullable();
  });

  await knex.schema.createTable('platform_alert_acks', (t) => {
    t.string('tenant_id', 26).notNullable();
    t.string('alert_key', 200).notNullable();
    t.string('acknowledged_by', 26).nullable();
    t.bigInteger('acknowledged_at').notNullable();
    t.primary(['tenant_id', 'alert_key']);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['platform_alert_acks', 'schedule_pauses', 'job_type_pauses', 'platform_instances']) await knex.schema.dropTableIfExists(table);
}
