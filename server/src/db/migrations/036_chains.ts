import type { Knex } from 'knex';

/*
 * Sprint 34 (1.5.0), part a: chaining agents, skills, tools and workflows (B-4102 to B-4107).
 *
 * - `chain_nodes.decision`: the `tool-call` guardrail checkpoint's action on a tool-call node (the chain view shows it).
 * - `chain_nodes.error_type`: how a node ended when it did not succeed, as the typed error its caller received
 *   (`failed`, `budget`, `cancelled`, `rejected`, `chain_limit`, `output`, `label`, `timeout`), B-4106.
 * - `agent_runs (caller_kind, caller_id)`: an agent run's delegated children (B-4102) and its workflow step's agent
 *   runs are looked up by their caller.
 * - `guard_decisions (source_kind, source_id)`: the chain view lists each run's guardrail decisions (B-4107).
 *
 * Expand only: new nullable columns and indexes.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('chain_nodes', (t) => {
    t.string('decision', 20).nullable();
    t.string('error_type', 20).nullable();
  });
  await knex.schema.alterTable('agent_runs', (t) => {
    t.index(['caller_kind', 'caller_id'], 'agent_runs_caller_idx');
  });
  await knex.schema.alterTable('guard_decisions', (t) => {
    t.index(['source_kind', 'source_id'], 'guard_decisions_source_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('guard_decisions', (t) => {
    t.dropIndex(['source_kind', 'source_id'], 'guard_decisions_source_idx');
  });
  await knex.schema.alterTable('agent_runs', (t) => {
    t.dropIndex(['caller_kind', 'caller_id'], 'agent_runs_caller_idx');
  });
  await knex.schema.alterTable('chain_nodes', (t) => {
    t.dropColumn('error_type');
    t.dropColumn('decision');
  });
}
