import type { Knex } from 'knex';

/*
 * 1.7.0, Sprint 40: agents, tools and skills in chat (B-40).
 *
 * B-4002 to B-4004, B-4009: `chat_invocations` is one `/tool`, `@agent` or `/workflow` call a person made from a
 * conversation: what was called (the registry entry and its approved hash, so a card decided later runs what it
 * showed), the exact arguments sealed with the tenant key, the approval card's state (the caller's own decision, the
 * reviewer's through the flag queue, when it expires), the run it started and the two messages it added to the
 * conversation tree. `messages.kind` and `messages.invocation_id` mark those messages.
 *
 * B-4005: `chat_conversation_skills` holds the skills added to a conversation (`sticky` until removed, or `once`).
 *
 * B-4001: `profiles.chat_capabilities` is the profile's allow-list for what a person may call from a conversation
 * that uses it (JSON: `tools`, `agents`, `skills`, `workflows`, each a list of names; an absent kind is not
 * restricted). `agent_runs.conversation_id` and `workflow_runs.conversation_id` link a run started from chat back to
 * its conversation and meter it there.
 *
 * Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('messages', (t) => {
    t.string('kind', 16).nullable(); // tool | agent | workflow
    t.string('invocation_id', 26).nullable();
  });

  await knex.schema.alterTable('profiles', (t) => {
    t.text('chat_capabilities').nullable();
  });

  await knex.schema.alterTable('agent_runs', (t) => {
    t.string('conversation_id', 26).nullable();
  });

  await knex.schema.alterTable('workflow_runs', (t) => {
    t.string('conversation_id', 26).nullable();
  });

  await knex.schema.createTable('chat_invocations', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).nullable();
    t.string('conversation_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('kind', 16).notNullable(); // tool | agent | workflow
    t.string('entry_id', 26).notNullable();
    t.string('entry_name', 200).notNullable();
    t.string('entry_version', 40).notNullable();
    t.string('entry_hash', 200).nullable();
    t.string('side_effect', 16).nullable();
    t.string('profile', 63).nullable();
    // pending | held | running | waiting | succeeded | failed | denied | rejected | expired | cancelled | budget | blocked
    t.string('state', 16).notNullable();
    t.string('label', 16).notNullable();
    t.text('args', 'mediumtext').nullable(); // sealed JSON: the arguments, or an agent's task
    t.text('result', 'mediumtext').nullable(); // sealed JSON
    t.string('error', 1000).nullable();
    t.boolean('from_text').notNullable().defaultTo(false);
    t.string('needs', 40).nullable(); // caller | reviewer | caller,reviewer
    t.string('caller_decision', 16).nullable();
    t.bigInteger('caller_decided_at').nullable();
    t.string('reviewer_decision', 16).nullable();
    t.string('reviewer_id', 26).nullable();
    t.bigInteger('reviewer_decided_at').nullable();
    t.string('flag_id', 26).nullable();
    t.string('hold_reason', 500).nullable();
    t.bigInteger('expires_at').nullable();
    t.string('run_kind', 16).nullable(); // agent-run | workflow-run
    t.string('run_id', 26).nullable();
    t.string('job_id', 26).nullable();
    t.string('user_message_id', 26).notNullable();
    t.string('message_id', 26).notNullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'conversation_id', 'created_at']);
    t.index(['state', 'expires_at']);
    t.index(['run_kind', 'run_id']);
  });

  await knex.schema.createTable('chat_conversation_skills', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('conversation_id', 26).notNullable();
    t.string('skill', 200).notNullable();
    t.string('mode', 8).notNullable(); // sticky | once
    t.string('added_by', 26).notNullable();
    t.bigInteger('added_at').notNullable();
    t.unique(['conversation_id', 'skill']);
    t.index(['tenant_id', 'conversation_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('chat_conversation_skills');
  await knex.schema.dropTableIfExists('chat_invocations');
  await knex.schema.alterTable('workflow_runs', (t) => t.dropColumn('conversation_id'));
  await knex.schema.alterTable('agent_runs', (t) => t.dropColumn('conversation_id'));
  await knex.schema.alterTable('profiles', (t) => t.dropColumn('chat_capabilities'));
  await knex.schema.alterTable('messages', (t) => {
    t.dropColumn('kind');
    t.dropColumn('invocation_id');
  });
}
