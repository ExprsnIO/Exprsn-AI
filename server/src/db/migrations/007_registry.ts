import type { Knex } from 'knex';

/*
 * Sprint 7: the registry (tools, skills and agents with a review lifecycle), MCP servers with hashed tools and
 * per-user vault tokens, agent runs with steps and checkpoints, and sandboxed scripts with versions and runs.
 * Tenant content (agent inputs and outputs, step details, checkpoints, script sources and output, vault tokens) is
 * sealed with the tenant's data key.
 */

/** The built-in calculate tool, published to every tenant. Its row has no tenant. */
export const CALCULATE_ENTRY_ID = 'BUILTIN0CALCULATE000000000';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('registry_entries', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).nullable(); // null: a platform entry, visible to every tenant
    t.string('workspace_id', 26).nullable(); // the author's workspace
    t.string('kind', 10).notNullable(); // tool | skill | agent
    t.string('name', 120).notNullable();
    t.string('version', 40).notNullable(); // semver
    t.string('description', 2000).nullable();
    t.string('impl', 20).notNullable(); // builtin | mcp | script | archive | agent
    t.string('side_effect', 20).nullable(); // read | write | destructive (tools)
    t.string('confirm', 10).notNullable().defaultTo('never'); // always | never
    t.integer('rate_per_hour').nullable();
    t.string('label', 20).notNullable().defaultTo('internal'); // ceiling: highest data label it may handle
    t.text('input_schema', 'mediumtext').nullable(); // JSON Schema
    t.text('output_schema', 'mediumtext').nullable();
    t.text('definition', 'mediumtext').nullable(); // JSON, per impl: {serverId, tool} | {scriptId, version} | agent or skill body
    t.string('status', 20).notNullable(); // draft | in_review | published | deprecated | retired
    t.string('schema_hash', 64).notNullable();
    t.string('approved_hash', 64).nullable();
    t.text('checks').nullable(); // JSON [{name, ok, detail}]
    t.bigInteger('checked_at').nullable();
    t.string('owner_id', 26).nullable();
    t.string('owner_name', 200).nullable();
    t.bigInteger('submitted_at').nullable();
    t.string('reviewed_by', 26).nullable();
    t.bigInteger('reviewed_at').nullable();
    t.string('review_note', 1000).nullable();
    t.string('publish_scope', 20).nullable(); // tenant | workspace | platform
    t.text('publish_workspaces').nullable(); // JSON array of workspace ids (scope workspace)
    t.string('replacement', 200).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'kind', 'name']);
  });

  await knex.schema.createTable('mcp_servers', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('name', 63).notNullable();
    t.string('description', 500).nullable();
    t.string('url', 500).notNullable();
    t.string('zone', 63).notNullable().defaultTo('app-internal');
    t.string('auth', 20).notNullable().defaultTo('none'); // none | service | user
    t.text('credential').nullable(); // sealed service bearer token (auth service)
    t.bigInteger('credential_rotated_at').nullable();
    t.string('state', 20).notNullable().defaultTo('active'); // active | deregistered
    t.string('health', 20).notNullable().defaultTo('registering'); // registering | healthy | changed | unreachable | incompatible
    t.string('health_detail', 500).nullable();
    t.string('protocol_version', 20).nullable();
    t.text('server_info').nullable(); // JSON {name, version}
    t.integer('latency_ms').nullable();
    t.integer('failures').notNullable().defaultTo(0); // consecutive failed checks
    t.bigInteger('last_checked_at').nullable();
    t.bigInteger('last_ok_at').nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'name']);
  });

  await knex.schema.createTable('mcp_tools', (t) => {
    t.string('id', 26).primary();
    t.string('server_id', 26).notNullable().references('id').inTable('mcp_servers').onDelete('CASCADE');
    t.string('tenant_id', 26).notNullable();
    t.string('name', 120).notNullable();
    t.string('description', 2000).nullable();
    t.text('input_schema', 'mediumtext').nullable(); // as announced now
    t.text('annotations').nullable(); // JSON, untrusted hints
    t.string('hash', 64).notNullable(); // of what the server announces now
    t.string('approved_hash', 64).nullable();
    t.text('approved_schema', 'mediumtext').nullable(); // the announcement that was approved, for the diff
    t.string('state', 20).notNullable(); // pending | approved | changed | rejected | removed
    t.string('side_effect', 20).nullable(); // set at review
    t.string('confirm', 10).nullable();
    t.string('label', 20).nullable();
    t.string('approved_by', 26).nullable();
    t.bigInteger('approved_at').nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['server_id', 'name']);
  });

  await knex.schema.createTable('mcp_events', (t) => {
    t.string('id', 26).primary();
    t.string('server_id', 26).notNullable().references('id').inTable('mcp_servers').onDelete('CASCADE');
    t.string('title', 300).notNullable();
    t.string('text', 1000).nullable();
    t.string('tone', 10).nullable(); // ok | warn | danger | ''
    t.bigInteger('ts').notNullable();
    t.index(['server_id', 'ts']);
  });

  await knex.schema.createTable('mcp_tokens', (t) => {
    t.string('id', 26).primary();
    t.string('server_id', 26).notNullable().references('id').inTable('mcp_servers').onDelete('CASCADE');
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.text('token').notNullable(); // sealed; never returned
    t.string('scopes', 300).nullable();
    t.bigInteger('expires_at').nullable();
    t.bigInteger('created_at').notNullable();
    t.unique(['server_id', 'user_id']);
  });

  await knex.schema.createTable('agent_runs', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).nullable();
    t.string('user_id', 26).notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('agent_id', 26).notNullable();
    t.string('agent_name', 120).notNullable();
    t.string('agent_version', 40).notNullable();
    t.string('profile', 63).nullable();
    t.string('state', 20).notNullable(); // queued | running | waiting | succeeded | failed | cancelled | budget
    t.string('label', 20).notNullable();
    t.text('input', 'mediumtext').nullable(); // sealed
    t.text('output', 'mediumtext').nullable(); // sealed
    t.string('error', 1000).nullable();
    t.text('budgets').notNullable(); // JSON {steps, tokens, wallSeconds, toolCalls}
    t.text('usage').notNullable(); // JSON {steps, tokens, toolCalls, wallMs, calcCalls}
    t.string('job_id', 26).nullable();
    t.string('replay_of', 26).nullable();
    t.integer('replay_from').nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('started_at').nullable();
    t.bigInteger('finished_at').nullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'user_id', 'created_at']);
  });

  await knex.schema.createTable('agent_steps', (t) => {
    t.string('id', 26).primary();
    t.string('run_id', 26).notNullable().references('id').inTable('agent_runs').onDelete('CASCADE');
    t.integer('n').notNullable();
    t.string('lane', 10).notNullable(); // think | do | calc
    t.string('title', 200).notNullable();
    t.string('state', 20).notNullable(); // ok | failed | waiting | denied | rejected
    t.text('meta').notNullable(); // JSON, not sensitive: tool, side effect, tokens, durations, decision
    t.text('detail', 'mediumtext').nullable(); // sealed JSON: text, thinking, arguments, result
    t.bigInteger('created_at').notNullable();
    t.bigInteger('finished_at').nullable();
    t.unique(['run_id', 'n']);
  });

  await knex.schema.createTable('agent_checkpoints', (t) => {
    t.string('id', 26).primary();
    t.string('run_id', 26).notNullable().references('id').inTable('agent_runs').onDelete('CASCADE');
    t.integer('n').notNullable(); // the state after step n (0: before the first step)
    t.text('state', 'mediumtext').notNullable(); // sealed JSON {messages, pending}
    t.text('usage').notNullable();
    t.bigInteger('created_at').notNullable();
    t.unique(['run_id', 'n']);
  });

  await knex.schema.createTable('scripts', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).nullable();
    t.string('name', 120).notNullable();
    t.string('language', 20).notNullable(); // python | javascript
    t.string('label', 20).notNullable().defaultTo('internal');
    t.string('status', 20).notNullable(); // draft | tested | in_review | promoted
    t.integer('version').notNullable();
    t.string('registry_id', 26).nullable(); // the draft tool created by promotion
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'workspace_id', 'name']);
  });

  await knex.schema.createTable('script_versions', (t) => {
    t.string('id', 26).primary();
    t.string('script_id', 26).notNullable().references('id').inTable('scripts').onDelete('CASCADE');
    t.integer('version').notNullable();
    t.text('source', 'mediumtext').notNullable(); // sealed
    t.text('limits').notNullable(); // JSON {timeoutSeconds, memoryMb, cpus, pids, outputKb}
    t.text('checks').notNullable(); // JSON [{name, result, tone, detail}]
    t.string('note', 300).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.unique(['script_id', 'version']);
  });

  await knex.schema.createTable('script_runs', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('script_id', 26).notNullable().references('id').inTable('scripts').onDelete('CASCADE');
    t.integer('version').notNullable();
    t.string('job_id', 26).nullable();
    t.string('state', 20).notNullable(); // queued | running | succeeded | failed | timeout | cancelled
    t.text('input', 'mediumtext').nullable(); // sealed stdin
    t.text('stdout', 'mediumtext').nullable(); // sealed
    t.text('stderr', 'mediumtext').nullable(); // sealed
    t.integer('exit_code').nullable();
    t.integer('duration_ms').nullable();
    t.boolean('truncated').notNullable().defaultTo(false);
    t.string('runner', 40).nullable();
    t.string('error', 1000).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('finished_at').nullable();
    t.index(['script_id', 'created_at']);
  });

  const t = Date.now();
  const inputSchema = { type: 'object', properties: { expression: { type: 'string', description: 'For example (1250 * 1.07) / 12' } }, required: ['expression'], additionalProperties: false };
  const outputSchema = { type: 'object', properties: { fraction: { type: 'string' }, decimal: { type: 'string' }, exact: { type: 'boolean' } }, required: ['fraction', 'decimal', 'exact'] };
  await knex('registry_entries').insert({
    id: CALCULATE_ENTRY_ID,
    tenant_id: null,
    workspace_id: null,
    kind: 'tool',
    name: 'calculate',
    version: '1.0.0',
    description: 'Evaluates an arithmetic expression exactly (+ - * / ^, parentheses, percentages) in a sandboxed worker with memory and time limits.',
    impl: 'builtin',
    side_effect: 'read',
    confirm: 'never',
    rate_per_hour: null,
    label: 'restricted',
    input_schema: JSON.stringify(inputSchema),
    output_schema: JSON.stringify(outputSchema),
    definition: JSON.stringify({ builtin: 'calculate' }),
    status: 'published',
    schema_hash: 'builtin-calculate-1',
    approved_hash: 'builtin-calculate-1',
    checks: JSON.stringify([{ name: 'Built into the platform', ok: true, detail: 'Ships with the server; reviewed with each release.' }]),
    checked_at: t,
    owner_id: null,
    owner_name: 'Platform',
    publish_scope: 'platform',
    created_at: t,
    updated_at: t
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['script_runs', 'script_versions', 'scripts', 'agent_checkpoints', 'agent_steps', 'agent_runs', 'mcp_tokens', 'mcp_events', 'mcp_tools', 'mcp_servers', 'registry_entries']) {
    await knex.schema.dropTableIfExists(table);
  }
}
