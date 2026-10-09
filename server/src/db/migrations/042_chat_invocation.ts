import type { Knex } from 'knex';

/*
 * 1.7.0, Sprint 40a (B-4001 to B-4009): agents, tools, skills and workflows called from a conversation.
 *
 * `chat_invocations` is one row per call a person or the model makes from a conversation: a tool call (`/tool`, or a
 * write tool the model proposed), an agent run (`@agent`, or an agent the model handed a turn to) or a workflow run
 * (`/workflow`). It carries the card's state (awaiting the owner's approval, held for a reviewer, running, done,
 * failed, denied, expired, cancelled), who decided and when, the run it started and the message that shows it; the
 * arguments and the result are sealed with the tenant key.
 *
 * `messages.turn` marks the turns these make: `tool` (the call and its result, which the model sees next), `agent`
 * (an answer attributed to an agent) and `workflow` (a workflow run's outcome); `messages.invocation_id` links the
 * turn to its card. `conversations.skills` holds the skills added with `+skill` (sticky or for one turn).
 * `profiles.agents` lists the agents a profile offers the model as `agent:<name>` tools; `profiles.skills`, when
 * set, restricts which published skills a conversation on the profile may add.
 *
 * Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('chat_invocations', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('conversation_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('kind', 16).notNullable(); // tool | agent | workflow
    t.string('name', 200).notNullable();
    t.string('entry_id', 26).nullable();
    t.string('version', 40).nullable();
    t.string('side_effect', 16).nullable(); // read | write | destructive
    t.string('proposed_by', 16).notNullable(); // user | model
    t.text('arguments', 'mediumtext').nullable(); // sealed JSON
    t.string('state', 24).notNullable(); // awaiting | held | running | done | failed | denied | expired | cancelled
    t.string('approval', 24).nullable(); // owner | reviewer | owner+reviewer
    t.string('decided_by', 26).nullable();
    t.bigInteger('decided_at').nullable();
    t.bigInteger('expires_at').nullable();
    t.string('run_kind', 16).nullable(); // agent-run | workflow-run
    t.string('run_id', 26).nullable();
    t.string('chain_id', 26).nullable();
    t.string('message_id', 26).nullable(); // the turn that shows the outcome
    t.string('answer_id', 26).nullable(); // the answer a model-proposed call belongs to
    t.string('flag_id', 26).nullable();
    t.text('result', 'mediumtext').nullable(); // sealed JSON
    t.text('error').nullable();
    t.string('label', 16).notNullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'conversation_id']);
    t.index(['run_kind', 'run_id']);
    t.index(['tenant_id', 'state', 'expires_at']);
  });

  await knex.schema.alterTable('messages', (t) => {
    t.string('turn', 16).nullable();
    t.string('invocation_id', 26).nullable();
  });

  await knex.schema.alterTable('conversations', (t) => {
    t.text('skills').nullable(); // JSON [{name, mode}]
  });

  await knex.schema.alterTable('profiles', (t) => {
    t.text('agents').nullable(); // JSON string[]
    t.text('skills').nullable(); // JSON string[] | null (null: any published skill)
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('profiles', (t) => {
    t.dropColumn('agents');
    t.dropColumn('skills');
  });
  await knex.schema.alterTable('conversations', (t) => {
    t.dropColumn('skills');
  });
  await knex.schema.alterTable('messages', (t) => {
    t.dropColumn('turn');
    t.dropColumn('invocation_id');
  });
  await knex.schema.dropTableIfExists('chat_invocations');
}
