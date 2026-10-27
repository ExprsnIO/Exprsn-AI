import type { Knex } from 'knex';

/*
 * Sprint 46 (B-133): approval deadlines, reminders, escalation and quorum (`workflows/approval-deadlines.ts`).
 *
 * `workflow_approvals` gains the soft due time (`breach_at`), its reminder times (JSON epoch milliseconds) and how
 * many were sent, the breach action (JSON), when the due time passed (`breached_at`), whom it escalated to, the
 * deadline's `outcome` (`overdue`, `escalated`, `auto-approved`, `auto-rejected`, `timed-out`), the quorum (`any`,
 * `all`, `count`; the number required; how rejects count; the eligible approvers counted when the step paused) and
 * `next_check_at`, the earliest moment the scheduled tick has work for the row. `due_at` stays the hard expiry.
 *
 * `workflow_approval_votes`: one row per approval and person (unique), so one person counts once.
 *
 * Pending approvals from before this migration get `next_check_at = due_at`: the tick expires them as the old
 * per-approval job did. Expand only; a build from before this migration ignores the new columns and table.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('workflow_approvals', 'next_check_at'))) {
    await knex.schema.alterTable('workflow_approvals', (t) => {
      t.bigInteger('breach_at').nullable();
      t.text('reminder_times').nullable();
      t.integer('reminders_sent').notNullable().defaultTo(0);
      t.text('on_breach').nullable();
      t.bigInteger('breached_at').nullable();
      t.string('escalated_role', 63).nullable();
      t.string('escalated_user', 26).nullable();
      t.bigInteger('escalated_at').nullable();
      t.string('outcome', 20).nullable();
      t.string('quorum', 10).nullable();
      t.integer('quorum_required').nullable();
      t.string('reject_mode', 10).nullable();
      t.text('eligible').nullable();
      t.bigInteger('next_check_at').nullable();
      t.index(['state', 'next_check_at']);
    });
    await knex('workflow_approvals').where({ state: 'pending' }).update({ next_check_at: knex.ref('due_at') });
  }
  if (!(await knex.schema.hasTable('workflow_approval_votes'))) {
    await knex.schema.createTable('workflow_approval_votes', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('approval_id', 26).notNullable().references('id').inTable('workflow_approvals').onDelete('CASCADE');
      t.string('user_id', 26).notNullable();
      t.string('decision', 10).notNullable(); // approve | reject
      t.text('reason').nullable(); // sealed
      t.bigInteger('created_at').notNullable();
      t.unique(['approval_id', 'user_id']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('workflow_approval_votes');
  if (await knex.schema.hasColumn('workflow_approvals', 'next_check_at')) {
    await knex.schema.alterTable('workflow_approvals', (t) => {
      t.dropIndex(['state', 'next_check_at']);
      for (const c of ['breach_at', 'reminder_times', 'reminders_sent', 'on_breach', 'breached_at', 'escalated_role', 'escalated_user', 'escalated_at', 'outcome', 'quorum', 'quorum_required', 'reject_mode', 'eligible', 'next_check_at']) t.dropColumn(c);
    });
  }
}
