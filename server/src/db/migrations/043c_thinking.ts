import type { Knex } from 'knex';

/*
 * 1.7.0, Sprint 41c (B-11701 to B-11706): thinking policy, budgets, plans and reflection.
 *
 * - `thinking_policies`: per tenant (`workspace_id` null) and per workspace: who sees thinking (`visibility`: the
 *   author, reviewers, nobody), how long it is kept apart from the answer (`retention_days`, null: as the answer),
 *   whether exports carry it, and the workspace's daily thinking-token budget.
 * - `profiles.thinking_budget`: the profile's daily thinking-token budget; `plan_first`: the model drafts a plan
 *   shown as a card before any tool runs; `reflect` and `reflect_profile`: a second pass checks the answer, by the
 *   profile itself or another.
 * - `messages.plan`: the approved plan a turn ran under (sealed JSON); `messages.checked`: the reflection's result
 *   (sealed JSON: status, findings, the revised answer); `messages.thinking_purge_at`: when the policy's retention
 *   drops the thinking (the sweep sets it null).
 * - `agent_runs.plan`, `plan_state`: a plan-first run's plan (sealed JSON) and whether it awaits, was approved, edited
 *   or declined.
 * - `chain_nodes.plan`: the approved plan on the run's node (step titles and tools, the chain view shows it);
 *   `chain_nodes.think`: the thinking level the node ran at; `chain_nodes.thinking_tokens`: what it spent thinking.
 * - `usage_records.thinking_dropped`: the thinking level was dropped by a budget (the usage summary shows the drops).
 *
 * Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('thinking_policies', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).nullable();
    t.string('visibility', 16).notNullable().defaultTo('author'); // author | reviewers | nobody
    t.integer('retention_days').nullable();
    t.boolean('exports').notNullable().defaultTo(true);
    t.bigInteger('budget_tokens_per_day').nullable();
    t.string('updated_by', 26).nullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'workspace_id']);
  });

  await knex.schema.alterTable('profiles', (t) => {
    t.bigInteger('thinking_budget').nullable();
    t.boolean('plan_first').notNullable().defaultTo(false);
    t.boolean('reflect').notNullable().defaultTo(false);
    t.string('reflect_profile', 63).nullable();
  });

  await knex.schema.alterTable('messages', (t) => {
    t.text('plan', 'mediumtext').nullable(); // sealed JSON
    t.text('checked', 'mediumtext').nullable(); // sealed JSON
    t.bigInteger('thinking_purge_at').nullable();
  });

  await knex.schema.alterTable('agent_runs', (t) => {
    t.text('plan', 'mediumtext').nullable(); // sealed JSON
    t.string('plan_state', 16).nullable(); // awaiting | approved | declined
  });

  await knex.schema.alterTable('chain_nodes', (t) => {
    t.text('plan').nullable(); // JSON {steps: [{title, tools}], approvedBy}
    t.string('think', 10).nullable();
    t.bigInteger('thinking_tokens').notNullable().defaultTo(0);
  });

  await knex.schema.alterTable('usage_records', (t) => {
    t.boolean('thinking_dropped').notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('usage_records', (t) => {
    t.dropColumn('thinking_dropped');
  });
  await knex.schema.alterTable('chain_nodes', (t) => {
    t.dropColumn('plan');
    t.dropColumn('think');
    t.dropColumn('thinking_tokens');
  });
  await knex.schema.alterTable('agent_runs', (t) => {
    t.dropColumn('plan');
    t.dropColumn('plan_state');
  });
  await knex.schema.alterTable('messages', (t) => {
    t.dropColumn('plan');
    t.dropColumn('checked');
    t.dropColumn('thinking_purge_at');
  });
  await knex.schema.alterTable('profiles', (t) => {
    t.dropColumn('thinking_budget');
    t.dropColumn('plan_first');
    t.dropColumn('reflect');
    t.dropColumn('reflect_profile');
  });
  await knex.schema.dropTableIfExists('thinking_policies');
}
