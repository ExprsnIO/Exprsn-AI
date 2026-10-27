import type { Knex } from 'knex';

/*
 * 1.9.99-final, Sprint 59 (B-10307): the snapshot schedules of managed databases (`cloud/databases.ts`).
 *
 * - `cloud_db_snapshot_schedules`: one row per database resource of a deployment (deployment id and resource key)
 *   that someone gave a schedule: every how many hours a snapshot is taken (the job `cloud.db.snapshot`, queued by the
 *   `cloud.db.schedules` tick when `next_at` passes), how many of the schedule's own snapshots are kept (older ones it
 *   took are deleted; final, manual and the provider's own snapshots never are), and the last run's outcome.
 *
 * The snapshots themselves live at the provider and are listed from it; nothing else needs a table. Expand only: one
 * new table. While it is missing the schedule route answers 503 `migration_pending` and the tick queues nothing;
 * every other database route works.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('cloud_db_snapshot_schedules'))) {
    await knex.schema.createTable('cloud_db_snapshot_schedules', (t) => {
      t.string('deployment_id', 26).notNullable();
      t.string('tenant_id', 26).notNullable();
      t.string('resource_key', 63).notNullable();
      t.integer('every_hours').notNullable();
      t.integer('keep').notNullable();
      t.boolean('enabled').notNullable().defaultTo(true);
      t.bigInteger('next_at').notNullable();
      t.bigInteger('last_at').nullable();
      t.string('last_snapshot', 500).nullable();
      t.string('last_error', 500).nullable();
      t.string('updated_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.primary(['deployment_id', 'resource_key']);
      t.index(['enabled', 'next_at']);
      t.index(['tenant_id']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('cloud_db_snapshot_schedules');
}
