import type { Knex } from 'knex';

/*
 * Sprint 38b (1.6.0), red-team suites, agent identities and handoffs (040b_redteam_agents): B-7001, B-7002, B-7701,
 * B-7801. Expand only.
 *
 * - `redteam_suites` (B-7001): an adversarial suite against a target (a profile, an agent by name, or a workflow):
 *   the built-in attack categories it runs (injection from the Sprint 37a corpus, jailbreaks, data exfiltration
 *   through tools, system-prompt extraction), the tenant's own attack cases (sealed), the share of attacks that must
 *   be resisted, and whether the suite gates publishing. A decisive change starts a new revision.
 * - `redteam_runs`: one run of a suite against the target as saved (the profile's settings hash or the entry's
 *   schema hash), with the per-attack results sealed; attacks against agents and workflows run as child runs and the
 *   red-team run ends when they do. Each failed attack is a flag (`guard_flags.source_kind = redteam-run`), which a
 *   reviewer confirms into an eval case (B-7002).
 * - `agent_identities` (B-7701): an agent (by name) as a principal of its own: roles, a label ceiling and whether the
 *   identity is on. A run of the agent on behalf of a user acts within both grants.
 * - `api_keys.agent_id`: a key minted for an agent identity; requests made with it act as the agent on behalf of the
 *   key's owner, within the identity's grants and the key's scopes.
 * - `agent_runs.handed_to` (B-7801): the specialist agent (and its run) a run handed the conversation to; the
 *   handed-to run's answer is the run's answer and the reader sees who answered.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('redteam_suites', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('target_kind', 16).notNullable(); // profile | agent | workflow
    t.string('target_id', 200).notNullable(); // the profile id, the agent's name, the workflow id
    t.string('name', 120).notNullable();
    t.string('description', 500).nullable();
    t.string('label', 20).notNullable().defaultTo('internal');
    t.text('categories').notNullable(); // JSON array of built-in attack categories
    t.text('cases', 'mediumtext').notNullable(); // sealed JSON array of the tenant's own attack cases
    t.decimal('threshold', 4, 3).notNullable().defaultTo(1);
    t.boolean('gate').notNullable().defaultTo(true);
    t.integer('revision').notNullable().defaultTo(1);
    t.string('created_by', 26).nullable();
    t.string('updated_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'target_kind', 'target_id', 'name'], { indexName: 'redteam_suites_target_name_uq' });
    t.index(['tenant_id', 'target_kind', 'target_id'], 'redteam_suites_target_idx');
  });
  await knex.schema.createTable('redteam_runs', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).nullable(); // the workspace the starter acted in (agent and workflow runs start there)
    t.string('suite_id', 26).notNullable();
    t.string('target_kind', 16).notNullable();
    t.string('target_id', 200).notNullable();
    t.string('target_version', 40).nullable(); // the profile's version, the entry's version
    t.string('config_hash', 64).notNullable(); // the profile's settings hash, the entry's schema hash
    t.integer('suite_revision').notNullable();
    t.string('state', 16).notNullable(); // queued | running | passed | failed | error
    t.integer('attacks').nullable();
    t.integer('resisted').nullable();
    t.decimal('threshold', 4, 3).notNullable();
    t.text('results', 'mediumtext').nullable(); // sealed JSON array of attack results
    t.text('error').nullable();
    t.string('trigger', 16).notNullable().defaultTo('manual');
    t.string('job_id', 26).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('finished_at').nullable();
    t.index(['tenant_id', 'target_kind', 'target_id'], 'redteam_runs_target_idx');
    t.index(['suite_id', 'config_hash', 'suite_revision'], 'redteam_runs_gate_idx');
  });
  await knex.schema.createTable('agent_identities', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('agent_name', 120).notNullable();
    t.text('roles').notNullable(); // JSON array of role ids
    t.string('ceiling', 20).notNullable().defaultTo('internal');
    t.boolean('enabled').notNullable().defaultTo(true);
    t.string('created_by', 26).nullable();
    t.string('updated_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'agent_name'], { indexName: 'agent_identities_name_uq' });
  });
  await knex.schema.alterTable('api_keys', (t) => {
    t.string('agent_id', 26).nullable();
    t.index(['agent_id'], 'api_keys_agent_idx');
  });
  await knex.schema.alterTable('agent_runs', (t) => {
    t.text('handed_to').nullable(); // JSON {agent, run}
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('agent_runs', (t) => {
    t.dropColumn('handed_to');
  });
  await knex.schema.alterTable('api_keys', (t) => {
    t.dropIndex(['agent_id'], 'api_keys_agent_idx');
    t.dropColumn('agent_id');
  });
  await knex.schema.dropTableIfExists('agent_identities');
  await knex.schema.dropTableIfExists('redteam_runs');
  await knex.schema.dropTableIfExists('redteam_suites');
}
