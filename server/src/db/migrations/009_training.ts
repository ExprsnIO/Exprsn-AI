import type { Knex } from 'knex';

/*
 * Sprint 9: training.
 *
 * Dataset versions keep a manifest (rows, hash, label, source, splits, PII-scrub summary, opt-in); the rows and the
 * scrub report are sealed in the blob store with the tenant key. Training jobs keep the pipeline's state (approval,
 * run on the worker, checkpoint, loss series, evals, model card); the GPU work happens on the worker. Windows lend
 * gateway pools to training on a schedule; recurring schedules submit jobs from a template.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('training_datasets', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('name', 63).notNullable();
    t.integer('version').notNullable();
    t.string('label', 20).notNullable();
    t.string('source', 500).notNullable(); // what the rows are, in words
    t.string('source_kind', 20).notNullable(); // inline | staging
    t.string('staging_key', 512).nullable();
    t.boolean('conversation_data').notNullable().defaultTo(false);
    t.text('opt_in').nullable(); // JSON: who recorded the tenant opt-in, when, for what
    t.string('state', 20).notNullable(); // scrubbing | ready | failed | withdrawn
    t.integer('rows').notNullable().defaultTo(0);
    t.string('hash', 80).nullable(); // sha256 of the scrubbed rows
    t.text('splits').notNullable(); // JSON: percentages and row counts
    t.text('scrub').nullable(); // JSON: masked counts by kind, rows affected
    t.string('blob_key', 512).nullable();
    t.string('report_key', 512).nullable();
    t.string('error', 1000).nullable();
    t.string('withdrawn_reason', 500).nullable();
    t.string('withdrawn_by', 26).nullable();
    t.bigInteger('withdrawn_at').nullable();
    t.string('created_by', 26).notNullable();
    t.bigInteger('created_at').notNullable();
    t.unique(['tenant_id', 'name', 'version']);
  });

  await knex.schema.createTable('training_jobs', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('name', 63).notNullable();
    t.string('base_model', 200).notNullable();
    t.string('base_model_id', 26).nullable();
    t.string('base_digest', 100).nullable();
    t.string('dataset_id', 26).notNullable();
    t.text('method').notNullable(); // JSON
    t.string('trainer', 20).notNullable();
    t.text('hardware').notNullable(); // JSON: accelerator, gpus, memoryGb
    t.float('max_hours').notNullable();
    t.string('priority', 10).notNullable(); // low | normal | high
    t.boolean('preemptible').notNullable().defaultTo(true);
    t.bigInteger('deadline').nullable();
    t.string('packaging', 40).notNullable();
    t.integer('canary').notNullable().defaultTo(0); // percent after model approval, 0 for none
    t.integer('checkpoint_every').notNullable().defaultTo(250);
    t.string('label', 20).notNullable();
    t.string('state', 20).notNullable(); // queued | running | succeeded | failed | cancelled | preempted
    t.integer('stage').notNullable().defaultTo(0);
    t.string('stage_tone', 10).nullable();
    t.string('approval', 10).nullable(); // pending | approved
    t.string('approved_by', 26).nullable();
    t.bigInteger('approved_at').nullable();
    t.boolean('hold').notNullable().defaultTo(false); // paused: not dispatched until run again
    t.boolean('run_now').notNullable().defaultTo(false); // may start outside a window
    t.string('wait_reason', 500).nullable();
    t.string('window_id', 26).nullable();
    t.string('run_id', 200).nullable();
    t.integer('step').notNullable().defaultTo(0);
    t.integer('steps').notNullable();
    t.float('epoch').notNullable().defaultTo(0);
    t.integer('epochs').notNullable();
    t.float('loss').nullable();
    t.text('series', 'mediumtext').nullable(); // JSON [[step, loss]]
    t.bigInteger('gpu_ms').notNullable().defaultTo(0); // metered so far, every run
    t.bigInteger('run_gpu_ms').notNullable().defaultTo(0); // what the current run has reported
    t.text('checkpoint').nullable(); // JSON: step, ref, at, reason
    t.string('container', 300).nullable();
    t.string('note', 1000).nullable();
    t.string('error', 2000).nullable();
    t.text('card', 'mediumtext').nullable(); // JSON: the model card
    t.string('model_id', 26).nullable();
    t.string('schedule_id', 26).nullable();
    t.string('created_by', 26).notNullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('started_at').nullable();
    t.bigInteger('finished_at').nullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'name']);
    t.index(['state']);
  });

  await knex.schema.createTable('training_windows', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('name', 63).notNullable();
    t.string('pool_id', 26).nullable(); // a gateway pool lent to training; null for the worker's own GPUs
    t.string('kind', 10).notNullable(); // always | daily | weekly
    t.integer('start_day').nullable(); // weekly: 0 Sunday … 6 Saturday
    t.string('start_time', 5).nullable(); // HH:MM, UTC
    t.integer('end_day').nullable();
    t.string('end_time', 5).nullable();
    t.integer('reload_minutes').notNullable().defaultTo(20);
    t.string('state', 10).notNullable().defaultTo('idle'); // idle | open
    t.text('drained').nullable(); // JSON: instance ids drained when the window opened
    t.bigInteger('opened_at').nullable();
    t.string('created_by', 26).notNullable();
    t.bigInteger('created_at').notNullable();
    t.unique(['tenant_id', 'name']);
  });

  await knex.schema.createTable('training_schedules', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('name', 100).notNullable();
    t.string('template_job_id', 26).notNullable();
    t.string('cron', 100).notNullable();
    t.string('condition', 20).notNullable(); // dataset-changed | always
    t.string('window_id', 26).nullable();
    t.string('priority', 10).notNullable();
    t.boolean('enabled').notNullable().defaultTo(true);
    t.string('last_dataset_id', 26).nullable();
    t.string('last_job_id', 26).nullable();
    t.string('last_result', 300).nullable();
    t.bigInteger('last_run_at').nullable();
    t.bigInteger('next_run_at').nullable();
    t.string('created_by', 26).notNullable();
    t.bigInteger('created_at').notNullable();
    t.unique(['tenant_id', 'name']);
  });

  await knex.schema.createTable('training_evals', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('job_id', 26).nullable();
    t.string('model', 200).notNullable();
    t.string('hardware', 20).notNullable();
    t.string('suite', 40).notNullable();
    t.float('score').notNullable();
    t.float('base_score').nullable();
    t.float('threshold').notNullable();
    t.integer('passed').nullable();
    t.integer('total').nullable();
    t.string('result', 10).notNullable(); // pass | fail
    t.string('label', 20).notNullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.index(['tenant_id', 'created_at']);
  });

  await knex.schema.createTable('training_settings', (t) => {
    t.string('tenant_id', 26).primary();
    t.text('thresholds').nullable(); // JSON: suite → pass threshold
    t.boolean('conversation_opt_in').notNullable().defaultTo(false);
    t.string('opt_in_scope', 200).nullable();
    t.string('opt_in_by', 26).nullable();
    t.bigInteger('opt_in_at').nullable();
    t.string('updated_by', 26).nullable();
    t.bigInteger('updated_at').notNullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const t of ['training_settings', 'training_evals', 'training_schedules', 'training_windows', 'training_jobs', 'training_datasets']) await knex.schema.dropTableIfExists(t);
}
