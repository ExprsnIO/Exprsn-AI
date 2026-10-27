import type { Knex } from 'knex';

/*
 * Sprint 32 (1.5.0), Workflows 2 part b: triggers on the workflow itself, failure handling (B-3903, B-3906).
 *
 * - `workflow_triggers`: the trigger of a workflow's published version when it starts runs by itself: an `event`
 *   trigger (a catalogue event type or group) or a `schedule` trigger (a five-field UTC cron). One row per workflow,
 *   rewritten on every publish; the person who published it is its owner, as whom runs start. `next_run_at` is
 *   claimed with one conditional update per due time, so a cron fires once across instances.
 * - `workflow_trigger_firings`: each event delivered to (or due time of) a trigger, with the event sealed, the chain of
 *   workflows that caused it (the loop rule) and the run it started or why it was skipped. Unique per trigger and
 *   event id: an event (or due time) seen by two instances starts one run.
 * - `workflow_dead_letters`: runs that failed for good, for the dead-letter view; a redrive replays the run from its
 *   failed step and records the new run.
 *
 * Expand only: new tables.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('workflow_triggers', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workflow_id', 26).notNullable().references('id').inTable('workflows').onDelete('CASCADE');
    t.string('workspace_id', 26).nullable();
    t.integer('version').notNullable(); // the published version the trigger came from
    t.string('kind', 10).notNullable(); // event | schedule
    t.string('event', 120).nullable(); // a catalogue type or group pattern (event triggers)
    t.string('cron', 120).nullable(); // five-field UTC cron (schedule triggers)
    t.string('owner_id', 26).notNullable(); // who published the version: runs start as them
    t.boolean('enabled').notNullable().defaultTo(true);
    t.bigInteger('next_run_at').nullable();
    t.bigInteger('last_fired_at').nullable();
    t.string('last_run_id', 26).nullable();
    t.string('last_result', 300).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['workflow_id']);
    t.index(['tenant_id', 'kind', 'enabled']);
    t.index(['kind', 'enabled', 'next_run_at']);
  });

  await knex.schema.createTable('workflow_trigger_firings', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('trigger_id', 26).notNullable().references('id').inTable('workflow_triggers').onDelete('CASCADE');
    t.string('workflow_id', 26).notNullable();
    t.string('event_type', 120).notNullable();
    t.string('event_id', 120).notNullable();
    t.string('label', 20).notNullable();
    t.text('event_sealed', 'mediumtext').nullable(); // sealed JSON envelope (event triggers)
    t.text('chain').notNullable(); // JSON array: the workflow ids that caused the event, oldest first
    t.string('state', 20).notNullable(); // queued | started | skipped | failed
    t.string('run_id', 26).nullable();
    t.string('reason', 300).nullable();
    t.string('job_id', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('finished_at').nullable();
    t.unique(['trigger_id', 'event_id']);
    t.index(['tenant_id', 'workflow_id', 'created_at']);
    t.index(['run_id']);
  });

  await knex.schema.createTable('workflow_dead_letters', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workflow_id', 26).notNullable().references('id').inTable('workflows').onDelete('CASCADE');
    t.string('run_id', 26).notNullable();
    t.string('node_id', 63).nullable(); // the step that failed (null when the run failed as a whole)
    t.string('label', 20).notNullable();
    t.string('error', 1000).nullable();
    t.string('state', 20).notNullable(); // open | redriven
    t.bigInteger('failed_at').notNullable();
    t.string('redriven_by', 26).nullable();
    t.bigInteger('redriven_at').nullable();
    t.string('redrive_run_id', 26).nullable();
    t.unique(['run_id']);
    t.index(['tenant_id', 'state', 'failed_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['workflow_dead_letters', 'workflow_trigger_firings', 'workflow_triggers']) await knex.schema.dropTableIfExists(table);
}
