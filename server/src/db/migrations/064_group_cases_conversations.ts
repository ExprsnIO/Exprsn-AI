import type { Knex } from 'knex';

/*
 * 1.7.0, Sprint 42 (B-9706, B-9709): what a group's moderators did with a case, and a group's linked conversation.
 *
 * - `group_case_actions` (B-9706): one row for each thing a group's moderator did with a flag on the group's content
 *   (confirm, dismiss, hide, warn, suspend, ban, assign), with the person it concerned, the moderation action or the
 *   ban it made, and the moderator's note sealed as `group-case:<id>`. The flag, the moderation action and the ban
 *   stay where they are (`guard_flags`, `moderation_actions`, `group_bans`); this is the case's history in the group.
 * - `group_conversations` (B-9709): a group's one linked conversation. While the row stands the conversation's members
 *   are the group's members: `dm_members` is kept in step, and every read asks the group who is a member now.
 *
 * Expand only: two new tables. No existing row changes, and no conversation is linked here: linking is an owner's
 * action, audited.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('group_case_actions'))) {
    await knex.schema.createTable('group_case_actions', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('group_id', 26).notNullable();
      t.string('flag_id', 26).notNullable();
      t.string('action', 20).notNullable(); // confirm | dismiss | hide | warn | suspend | ban | assign
      t.string('target_user', 26).nullable(); // whose content it was, or who the case was assigned to
      t.string('moderation_action_id', 26).nullable();
      t.string('ban_id', 26).nullable();
      t.text('note').nullable(); // sealed as group-case:<id>
      t.string('created_by', 26).notNullable();
      t.bigInteger('created_at').notNullable();
      t.index(['tenant_id', 'group_id', 'flag_id']);
    });
  }

  if (!(await knex.schema.hasTable('group_conversations'))) {
    await knex.schema.createTable('group_conversations', (t) => {
      t.string('group_id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('conversation_id', 26).notNullable().unique();
      t.string('created_by', 26).notNullable();
      t.bigInteger('created_at').notNullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('group_conversations');
  await knex.schema.dropTableIfExists('group_case_actions');
}
