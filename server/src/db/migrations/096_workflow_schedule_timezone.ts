import type { Knex } from 'knex';

/*
 * 1.8.0, Sprint 47 (B-138): a schedule trigger's time zone (`workflows/schedules.ts`).
 *
 * `workflow_triggers.timezone`: the IANA zone the cron of a schedule trigger reads its wall-clock times in. Null is
 * UTC, so every schedule from before this migration fires exactly as it did. `next_run_at` stays the UTC instant the
 * tick claims with one conditional update. Expand only: a nullable column.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('workflow_triggers', 'timezone'))) {
    await knex.schema.alterTable('workflow_triggers', (t) => {
      t.string('timezone', 64).nullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('workflow_triggers', 'timezone')) {
    await knex.schema.alterTable('workflow_triggers', (t) => {
      t.dropColumn('timezone');
    });
  }
}
