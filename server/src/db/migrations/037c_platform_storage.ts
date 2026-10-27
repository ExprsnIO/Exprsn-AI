import type { Knex } from 'knex';

/*
 * 1.6.0, Sprint 35c: the Storage and Configuration screens (B-4204, B-4205).
 *
 * Storage
 * - `platform_blob_runs`: runs of the integrity check `ops.blobs.verify` (objects listed, references walked, counts,
 *   whether checksums were compared).
 * - `platform_blob_findings`: what a run found: `missing` (a row names an object the store does not have), `orphan`
 *   (an object older than the grace period no row references) and `mismatch` (an object whose SHA-256 differs from the
 *   one first recorded for it), with what references it and how it was resolved.
 * - `platform_blob_checksums`: the SHA-256 and size first recorded for each object when a run compared checksums.
 * - `platform_blob_dryruns`: a dry run of orphan deletion: the exact objects that a deletion within its validity may
 *   remove, checked against a fresh walk of the references.
 * - `platform_storage_samples`: one sample a day per store and per workspace (bytes, objects), for the growth lines.
 * - `platform_blob_migrations`: blob store migrations (copy, verify, switch reads, retire the old store); the target's
 *   S3 secret is sealed with the platform key.
 *
 * Configuration
 * - `platform_setting_proposals`: an override (or its removal) proposed by one platform admin, decided by another.
 * - `platform_setting_overrides`: the overrides in force, with who proposed and who approved them.
 * - `platform_instance_settings`: what each instance reads, reported every PLATFORM_INSTANCE_REPORT_SECONDS (secrets
 *   as set or unset, length and a keyed fingerprint only, never the value).
 * Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('platform_blob_runs', (t) => {
    t.string('id', 26).primary();
    t.string('state', 20).notNullable(); // queued | running | succeeded | failed
    t.boolean('checksums').notNullable().defaultTo(false);
    t.string('store', 200).nullable(); // the store checked, in words
    t.bigInteger('objects').nullable();
    t.bigInteger('bytes').nullable();
    t.integer('missing').nullable();
    t.integer('orphans').nullable();
    t.bigInteger('orphan_bytes').nullable();
    t.integer('mismatches').nullable();
    t.bigInteger('refs').nullable(); // references walked
    t.string('error', 1000).nullable();
    t.string('job_id', 26).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('started_at').nullable();
    t.bigInteger('finished_at').nullable();
    t.index(['created_at'], 'platform_blob_runs_created_idx');
  });

  await knex.schema.createTable('platform_blob_findings', (t) => {
    t.string('id', 26).primary();
    t.string('run_id', 26).notNullable();
    t.string('kind', 20).notNullable(); // missing | orphan | mismatch
    t.string('blob_key', 512).notNullable();
    t.bigInteger('size').nullable();
    t.bigInteger('modified_at').nullable();
    t.text('referenced_by').nullable(); // JSON: [{table, column, id}] for missing; null for an orphan
    t.string('expected', 64).nullable(); // mismatch: the SHA-256 recorded first
    t.string('actual', 64).nullable(); // mismatch: the SHA-256 now
    t.string('state', 20).notNullable(); // open | deleted | accepted | gone | superseded
    t.string('resolved_by', 26).nullable();
    t.bigInteger('resolved_at').nullable();
    t.string('note', 500).nullable();
    t.bigInteger('found_at').notNullable();
    t.index(['run_id', 'kind'], 'platform_blob_findings_run_idx');
    t.index(['state', 'kind'], 'platform_blob_findings_state_idx');
  });

  await knex.schema.createTable('platform_blob_checksums', (t) => {
    t.string('blob_key', 512).primary();
    t.string('sha256', 64).notNullable();
    t.bigInteger('size').notNullable();
    t.bigInteger('first_seen').notNullable();
    t.bigInteger('verified_at').notNullable();
  });

  await knex.schema.createTable('platform_blob_dryruns', (t) => {
    t.string('id', 26).primary();
    t.string('run_id', 26).nullable();
    t.text('blob_keys', 'longtext').notNullable(); // JSON array of the objects a deletion may remove
    t.integer('total').notNullable();
    t.bigInteger('bytes').notNullable();
    t.bigInteger('oldest').nullable();
    t.integer('skipped').notNullable().defaultTo(0); // asked for but no longer orphans
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('expires_at').notNullable();
    t.bigInteger('used_at').nullable();
  });

  await knex.schema.createTable('platform_storage_samples', (t) => {
    t.string('scope', 60).notNullable(); // store:<id> | workspace:<id>
    t.string('day', 10).notNullable(); // YYYY-MM-DD (UTC)
    t.bigInteger('bytes').notNullable();
    t.bigInteger('objects').nullable();
    t.bigInteger('updated_at').notNullable();
    t.primary(['scope', 'day'], 'platform_storage_samples_pk');
  });

  await knex.schema.createTable('platform_blob_migrations', (t) => {
    t.string('id', 26).primary();
    t.string('state', 20).notNullable(); // queued | copying | switched | retired | failed | cancelled
    t.text('source').notNullable(); // JSON: the store reads came from, without secrets
    t.text('target').notNullable(); // JSON: kind, dir or endpoint, bucket, region, path style (no secret)
    t.text('target_secret').nullable(); // the S3 secret access key, sealed with the platform key
    t.string('reason', 500).notNullable();
    t.bigInteger('objects').nullable();
    t.bigInteger('copied').nullable();
    t.bigInteger('bytes').nullable();
    t.bigInteger('verified').nullable();
    t.string('error', 1000).nullable();
    t.string('job_id', 26).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('switched_at').nullable();
    t.string('retired_by', 26).nullable();
    t.bigInteger('retired_at').nullable();
  });

  await knex.schema.createTable('platform_setting_proposals', (t) => {
    t.string('id', 26).primary();
    t.string('name', 100).notNullable();
    t.string('action', 10).notNullable(); // set | clear
    t.text('value').nullable();
    t.text('previous').nullable(); // what the instances read when it was proposed (null for a secret)
    t.string('reason', 500).notNullable();
    t.string('state', 20).notNullable(); // pending | approved | rejected | withdrawn | superseded
    t.string('proposed_by', 26).notNullable();
    t.string('proposed_tenant', 26).notNullable();
    t.bigInteger('proposed_at').notNullable();
    t.string('decided_by', 26).nullable();
    t.bigInteger('decided_at').nullable();
    t.string('note', 500).nullable();
    t.index(['name', 'state'], 'platform_setting_proposals_name_idx');
  });

  await knex.schema.createTable('platform_setting_overrides', (t) => {
    t.string('name', 100).primary();
    t.text('value').notNullable();
    t.string('applies', 10).notNullable(); // hot | restart
    t.string('proposal_id', 26).notNullable();
    t.string('proposed_by', 26).notNullable();
    t.string('approved_by', 26).notNullable();
    t.string('reason', 500).notNullable();
    t.bigInteger('applied_at').notNullable();
  });

  await knex.schema.createTable('platform_instance_settings', (t) => {
    t.string('instance', 100).primary();
    t.string('host', 200).notNullable();
    t.integer('pid').notNullable();
    t.string('version', 40).notNullable();
    t.bigInteger('started_at').notNullable();
    t.bigInteger('reported_at').notNullable();
    t.string('blob_mode', 60).nullable(); // single | dual:<migration> | switched:<migration>
    t.text('settings', 'mediumtext').notNullable(); // JSON {name: {v, src, file?, chars?, fp?}}
    t.text('overrides').nullable(); // JSON {name: applied_at} of the overrides this process reads
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const t of ['platform_instance_settings', 'platform_setting_overrides', 'platform_setting_proposals', 'platform_blob_migrations', 'platform_storage_samples', 'platform_blob_dryruns', 'platform_blob_checksums', 'platform_blob_findings', 'platform_blob_runs']) await knex.schema.dropTableIfExists(t);
}
