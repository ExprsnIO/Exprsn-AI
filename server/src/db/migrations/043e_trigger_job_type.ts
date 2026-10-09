import type { Knex } from 'knex';

/*
 * Live review 2026-10-09: an event trigger on a job event can be narrowed to a job type. Expand only.
 *
 * - `workflow_triggers.job_type`: the job type (`training.package`) or group (`training.*`) a trigger on
 *   `job.succeeded`, `job.failed`, `job.cancelled` or `job.*` is limited to; null for every job. Written on publish
 *   from the trigger step's `jobType`; triggers published before this migration keep receiving every job's events.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('workflow_triggers', (t) => {
    t.string('job_type', 120).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('workflow_triggers', (t) => {
    t.dropColumn('job_type');
  });
}
