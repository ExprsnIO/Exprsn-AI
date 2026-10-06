import type { Knex } from 'knex';

/*
 * Sprint 32 (1.5.0), part a: the chain context (B-4101) and Workflows 2's sub-workflow, agent, map and loop steps
 * (B-3901, B-3902, B-3905).
 *
 * - `chains`: one row per root invocation: the principal the whole chain acts as, the label high-water mark (it only
 *   rises), the root's budgets (tokens, steps, wall time, GPU time as the cost meter) and what the chain has used, so
 *   every instance reads the same totals and gives the same answer.
 * - `chain_nodes`: one row per invocation (chat turn, agent run, workflow run, tool call, skill load, plugin action,
 *   app trigger): its root chain, parent, depth, the kinds above it (`path`, JSON `[[kind, callee]…]` from the root,
 *   for the per-kind caps), principal, label and its own usage. `(kind, ref)` is unique, so a job retried on another
 *   instance finds the node it began instead of starting another.
 * - `workflow_runs.chain_id`/`chain_node` and `agent_runs.chain_id`/`chain_node`: the node each run is; `caller_node`
 *   on both (and `caller_kind`/`caller_id` on agent runs) name the workflow step a sub-workflow or agent run reports to.
 * - `workflow_items`: per-item checkpoints of map and loop steps (one row per item or iteration, its output sealed),
 *   so a map resumes after a restart without running finished items again.
 *
 * Expand only: new tables and nullable columns.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('chains', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('root_node', 26).notNullable();
    t.string('root_kind', 20).notNullable();
    t.string('principal_id', 26).notNullable();
    t.string('label', 20).notNullable();
    t.string('state', 20).notNullable(); // running | done | stopped
    t.string('stop_reason', 500).nullable();
    t.bigInteger('budget_tokens').notNullable();
    t.integer('budget_steps').notNullable();
    t.bigInteger('budget_wall_ms').notNullable();
    t.bigInteger('budget_gpu_ms').notNullable();
    t.bigInteger('tokens').notNullable().defaultTo(0);
    t.integer('steps').notNullable().defaultTo(0);
    t.bigInteger('wall_ms').notNullable().defaultTo(0);
    t.bigInteger('gpu_ms').notNullable().defaultTo(0);
    t.integer('nodes').notNullable().defaultTo(1);
    t.integer('max_depth').notNullable().defaultTo(0);
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'created_at'], 'chains_tenant_idx');
  });
  await knex.schema.createTable('chain_nodes', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('chain_id', 26).notNullable().references('id').inTable('chains').onDelete('CASCADE');
    t.string('parent_id', 26).nullable();
    t.integer('depth').notNullable();
    t.string('kind', 20).notNullable();
    t.string('ref', 120).notNullable();
    t.string('callee', 200).nullable();
    t.text('path').notNullable();
    t.string('principal_id', 26).notNullable();
    t.string('label', 20).notNullable();
    t.string('state', 20).notNullable(); // running | succeeded | failed | refused | waiting | cancelled
    t.string('error', 500).nullable();
    t.bigInteger('tokens').notNullable().defaultTo(0);
    t.integer('steps').notNullable().defaultTo(0);
    t.bigInteger('wall_ms').notNullable().defaultTo(0);
    t.bigInteger('gpu_ms').notNullable().defaultTo(0);
    t.bigInteger('created_at').notNullable();
    t.bigInteger('finished_at').nullable();
    t.unique(['kind', 'ref'], { indexName: 'chain_nodes_ref_uq' });
    t.index(['chain_id', 'created_at'], 'chain_nodes_chain_idx');
  });
  await knex.schema.alterTable('workflow_runs', (t) => {
    t.string('chain_id', 26).nullable();
    t.string('chain_node', 26).nullable();
    t.string('caller_node', 63).nullable();
  });
  await knex.schema.alterTable('agent_runs', (t) => {
    t.string('chain_id', 26).nullable();
    t.string('chain_node', 26).nullable();
    t.string('caller_kind', 20).nullable();
    t.string('caller_id', 26).nullable();
    t.string('caller_node', 63).nullable();
  });
  await knex.schema.createTable('workflow_items', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('run_id', 26).notNullable().references('id').inTable('workflow_runs').onDelete('CASCADE');
    t.string('node_id', 63).notNullable();
    t.integer('idx').notNullable();
    t.string('state', 20).notNullable(); // passed | failed | waiting
    t.text('output', 'mediumtext').nullable(); // sealed
    t.string('error', 1000).nullable();
    t.string('child_run', 26).nullable();
    t.integer('tokens').notNullable().defaultTo(0);
    t.bigInteger('created_at').notNullable();
    t.bigInteger('finished_at').nullable();
    t.unique(['run_id', 'node_id', 'idx'], { indexName: 'workflow_items_uq' });
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('workflow_items');
  await knex.schema.alterTable('agent_runs', (t) => {
    t.dropColumn('caller_node');
    t.dropColumn('caller_id');
    t.dropColumn('caller_kind');
    t.dropColumn('chain_node');
    t.dropColumn('chain_id');
  });
  await knex.schema.alterTable('workflow_runs', (t) => {
    t.dropColumn('caller_node');
    t.dropColumn('chain_node');
    t.dropColumn('chain_id');
  });
  await knex.schema.dropTableIfExists('chain_nodes');
  await knex.schema.dropTableIfExists('chains');
}
