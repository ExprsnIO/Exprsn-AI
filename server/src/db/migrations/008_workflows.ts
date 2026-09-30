import type { Knex } from 'knex';

/*
 * Sprint 8: workflows, media and images.
 *
 * Workflows are graphs with a draft and published versions; runs pin the graph they started on and persist every
 * step's output (sealed), so a run resumes from its last checkpoint on any instance. Media assets and outputs, and
 * generated images, are sealed in the blob store; rows keep only what the screens and the caps need.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('workflows', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).nullable();
    t.string('name', 63).notNullable(); // slug, unique per tenant
    t.string('description', 500).nullable();
    t.string('label', 20).notNullable(); // the label of the data a run starts with
    t.text('draft', 'mediumtext').notNullable(); // JSON graph being edited
    t.integer('draft_rev').notNullable().defaultTo(1);
    t.integer('published_version').nullable();
    t.string('created_by', 26).nullable();
    t.string('updated_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'name']);
  });

  await knex.schema.createTable('workflow_versions', (t) => {
    t.string('id', 26).primary();
    t.string('workflow_id', 26).notNullable().references('id').inTable('workflows').onDelete('CASCADE');
    t.string('tenant_id', 26).notNullable();
    t.integer('version').notNullable();
    t.text('graph', 'mediumtext').notNullable(); // JSON, immutable once published
    t.string('state', 20).notNullable(); // published | deprecated
    t.string('note', 500).nullable();
    t.string('published_by', 26).nullable();
    t.bigInteger('published_at').notNullable();
    t.unique(['workflow_id', 'version']);
  });

  await knex.schema.createTable('workflow_runs', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).nullable();
    t.string('workflow_id', 26).notNullable().references('id').inTable('workflows').onDelete('CASCADE');
    t.integer('version').nullable(); // null for a dry run of the draft
    t.integer('draft_rev').nullable();
    t.text('graph', 'mediumtext').notNullable(); // the graph this run executes, pinned at start
    t.string('mode', 10).notNullable(); // run | dry
    t.string('trigger', 100).notNullable(); // manual | api | replay
    t.string('state', 20).notNullable(); // queued | running | waiting | succeeded | failed | rejected | cancelled
    t.text('input', 'mediumtext').nullable(); // sealed JSON
    t.string('label', 20).notNullable(); // high-water mark of the data the run has handled
    t.string('created_by', 26).notNullable();
    t.string('job_id', 26).nullable();
    t.string('replay_of', 26).nullable();
    t.string('replay_from', 63).nullable();
    t.string('error', 1000).nullable();
    t.bigInteger('tokens').notNullable().defaultTo(0);
    t.bigInteger('locked_until').nullable(); // held by the instance executing it
    t.bigInteger('created_at').notNullable();
    t.bigInteger('started_at').nullable();
    t.bigInteger('finished_at').nullable();
    t.index(['tenant_id', 'workflow_id', 'created_at']);
  });

  await knex.schema.createTable('workflow_steps', (t) => {
    t.string('id', 26).primary();
    t.string('run_id', 26).notNullable().references('id').inTable('workflow_runs').onDelete('CASCADE');
    t.string('tenant_id', 26).notNullable();
    t.string('node_id', 63).notNullable();
    t.string('state', 20).notNullable(); // running | passed | failed | skipped | waiting | blocked
    t.text('output', 'mediumtext').nullable(); // sealed JSON: the checkpoint
    t.string('label', 20).notNullable();
    t.integer('attempts').notNullable().defaultTo(0);
    t.text('detail').nullable(); // JSON: tokens, model, duration, mocked, reused
    t.string('error', 1000).nullable();
    t.bigInteger('resume_at').nullable(); // wait steps
    t.bigInteger('started_at').nullable();
    t.bigInteger('finished_at').nullable();
    t.unique(['run_id', 'node_id']);
  });

  await knex.schema.createTable('workflow_approvals', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('run_id', 26).notNullable().references('id').inTable('workflow_runs').onDelete('CASCADE');
    t.string('node_id', 63).notNullable();
    t.string('role', 63).notNullable();
    t.string('state', 20).notNullable(); // pending | approved | rejected | expired
    t.text('shown', 'mediumtext').nullable(); // sealed: the data the approver sees
    t.string('decided_by', 26).nullable();
    t.text('reason').nullable(); // sealed
    t.bigInteger('due_at').notNullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('decided_at').nullable();
    t.index(['tenant_id', 'state']);
  });

  await knex.schema.createTable('media_assets', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).nullable();
    t.string('user_id', 26).notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('name', 255).notNullable();
    t.string('kind', 10).nullable(); // video | audio | image, once probed
    t.string('format', 60).nullable(); // container format from the probe
    t.bigInteger('size').notNullable();
    t.string('sha256', 64).notNullable();
    t.bigInteger('duration_ms').nullable();
    t.integer('width').nullable();
    t.integer('height').nullable();
    t.text('streams').nullable(); // JSON [{type, codec}]
    t.integer('previews').notNullable().defaultTo(0); // thumbnails (video) or one waveform/preview picture
    t.string('state', 20).notNullable(); // quarantined | probing | ready | refused
    t.string('label', 20).notNullable();
    t.string('reason', 500).nullable();
    t.string('blob_key', 300).nullable();
    t.bigInteger('created_at').notNullable();
    t.index(['tenant_id', 'workspace_id', 'created_at']);
  });

  await knex.schema.createTable('media_jobs', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).nullable();
    t.string('user_id', 26).notNullable();
    t.string('asset_id', 26).notNullable().references('id').inTable('media_assets').onDelete('CASCADE');
    t.string('preset', 40).notNullable();
    t.text('params').notNullable(); // JSON, validated against the preset
    t.string('encoder', 20).nullable(); // nvenc | cpu | none
    t.string('state', 20).notNullable(); // queued | running | succeeded | failed | cancelled
    t.string('stage', 200).nullable();
    t.integer('progress').notNullable().defaultTo(0);
    t.string('job_id', 26).nullable();
    t.string('node', 100).nullable();
    t.text('outputs').nullable(); // JSON [{key, name, type, size}]
    t.text('result').nullable(); // JSON: words, frames, withheld, masked
    t.string('label', 20).notNullable();
    t.string('error', 1000).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('finished_at').nullable();
    t.index(['tenant_id', 'asset_id']);
  });

  await knex.schema.createTable('image_jobs', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).nullable();
    t.string('user_id', 26).notNullable();
    t.string('batch_id', 26).notNullable();
    t.text('prompt').notNullable(); // sealed
    t.string('prompt_hash', 64).notNullable();
    t.string('backend', 63).notNullable();
    t.string('model', 200).nullable();
    t.integer('width').notNullable();
    t.integer('height').notNullable();
    t.bigInteger('seed').notNullable();
    t.integer('steps').notNullable();
    t.string('state', 20).notNullable(); // queued | running | succeeded | withheld | failed | cancelled
    t.string('stage', 100).nullable();
    t.integer('step').notNullable().defaultTo(0);
    t.bigInteger('gpu_ms').notNullable().defaultTo(0);
    t.float('safety_score').nullable();
    t.string('label', 20).notNullable();
    t.string('blob_key', 300).nullable();
    t.text('provenance').nullable(); // JSON sidecar with its HMAC signature
    t.string('job_id', 26).nullable();
    t.string('node', 100).nullable();
    t.string('error', 1000).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('started_at').nullable();
    t.bigInteger('finished_at').nullable();
    t.index(['tenant_id', 'user_id', 'created_at']);
    t.index(['backend', 'state']);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['image_jobs', 'media_jobs', 'media_assets', 'workflow_approvals', 'workflow_steps', 'workflow_runs', 'workflow_versions', 'workflows']) {
    await knex.schema.dropTableIfExists(table);
  }
}
