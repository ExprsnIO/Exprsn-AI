import type { Knex } from 'knex';

/*
 * 1.6.0: review queues per agent.
 *
 * `moderation_queues.agents` lists the agents (names or registry entry ids) whose runs a queue takes: a flag raised
 * in an agent run (`guard_flags.source_kind = agent-run`, `source_id` the run) matches when the run's agent is
 * listed. Null is a queue that does not ask which agent, as before.
 *
 * Expand only: one nullable column.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('moderation_queues', (t) => {
    t.text('agents').nullable(); // JSON agent names or ids; null: any
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('moderation_queues', (t) => {
    t.dropColumn('agents');
  });
}
