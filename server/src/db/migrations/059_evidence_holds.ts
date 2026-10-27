import type { Knex } from 'knex';

/*
 * 1.7.0, Sprint 41 (B-9501 to B-9504): evidence retention and legal hold on cases and single objects.
 *
 * - `files.taken_down_at` and `taken_down_by` (B-9501): a takedown is its own state. A taken-down file stays out of
 *   the folder tree through the trash mark as before, but it is not in the members' trash, cannot be restored or
 *   purged by them, and leaves only when the moderation decision is reversed. Files that the moderation service put in
 *   the trash before this migration (`trashed_by = moderation`) get the state: only `takeDown` ever wrote that value,
 *   and an upheld appeal cleared it, so such a row is a takedown that still stands. Re-running changes nothing.
 * - `legal_holds.object_type`, `object_id` and `object_hash` (B-9504): a hold of scope `case` (`scope_id` the flag) or
 *   `object` (the moderated object, by its registry type and id).
 * - `retention_skips` (B-9502): one row the first time a purge path leaves an object alone for a reason (the case or
 *   the hold in `ref`), so a sweep that runs every hour records it once.
 * - `file_retention` (B-9503): per workspace, the days after which an unchanged file goes to the trash and the number
 *   of versions kept of each file.
 * - `evidence_exports` (B-9504): the dual-controlled export of a held case's or object's content, sealed.
 *
 * Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('files', 'taken_down_at'))) {
    await knex.schema.alterTable('files', (t) => {
      t.bigInteger('taken_down_at').nullable();
      t.string('taken_down_by', 40).nullable();
    });
  }
  await knex('files').where({ trashed_by: 'moderation' }).whereNotNull('trashed_at').whereNull('taken_down_at').update({ taken_down_at: knex.ref('trashed_at'), taken_down_by: 'moderation' });

  if (!(await knex.schema.hasColumn('legal_holds', 'object_hash'))) {
    await knex.schema.alterTable('legal_holds', (t) => {
      t.string('object_type', 30).nullable();
      t.text('object_id').nullable();
      t.string('object_hash', 64).nullable();
    });
  }

  if (!(await knex.schema.hasTable('retention_skips'))) {
    await knex.schema.createTable('retention_skips', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('object_hash', 64).notNullable();
      t.string('object_type', 30).notNullable();
      t.text('object_id').notNullable();
      t.string('path', 40).notNullable(); // the purge path: files.purge, chat.retention, …
      t.string('reason', 20).notNullable(); // evidence | legal-hold
      t.string('ref', 64).notNullable(); // the moderation action, or the legal hold
      t.bigInteger('created_at').notNullable();
      t.unique(['tenant_id', 'object_hash', 'path', 'ref']);
    });
  }

  if (!(await knex.schema.hasTable('file_retention'))) {
    await knex.schema.createTable('file_retention', (t) => {
      t.string('tenant_id', 26).notNullable();
      t.string('workspace_id', 26).notNullable();
      t.integer('retention_days').nullable(); // null: files are kept
      t.integer('version_cap').nullable(); // null: every version is kept
      t.string('updated_by', 26).nullable();
      t.bigInteger('updated_at').notNullable();
      t.bigInteger('last_run_at').nullable();
      t.primary(['tenant_id', 'workspace_id']);
    });
  }

  if (!(await knex.schema.hasTable('evidence_exports'))) {
    await knex.schema.createTable('evidence_exports', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('hold_id', 26).notNullable();
      t.string('label', 20).notNullable();
      t.text('reason').notNullable(); // sealed
      t.string('requested_by', 26).notNullable();
      t.string('approver_id', 26).notNullable();
      t.string('state', 10).notNullable(); // pending | approved | rejected | withdrawn | ready | failed
      t.string('decided_by', 26).nullable();
      t.bigInteger('decided_at').nullable();
      t.string('note', 500).nullable();
      t.string('job_id', 26).nullable();
      t.string('file', 200).nullable();
      t.string('blob_key', 300).nullable();
      t.integer('objects').nullable();
      t.string('error', 500).nullable();
      t.bigInteger('downloaded_at').nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.index(['tenant_id', 'hold_id']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('evidence_exports');
  await knex.schema.dropTableIfExists('file_retention');
  await knex.schema.dropTableIfExists('retention_skips');
  await knex.schema.alterTable('legal_holds', (t) => {
    t.dropColumn('object_type');
    t.dropColumn('object_id');
    t.dropColumn('object_hash');
  });
  // A taken-down file is again an ordinary trash entry of the moderation service, as before this migration.
  await knex.schema.alterTable('files', (t) => {
    t.dropColumn('taken_down_at');
    t.dropColumn('taken_down_by');
  });
}
