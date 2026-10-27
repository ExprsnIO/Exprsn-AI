import type { Knex } from 'knex';

/*
 * 1.6.0, Sprint 38c.
 *
 * B-8101 to B-8103 row and field policies for low-code apps.
 * - `app_policies`: a reusable rule set of one app, for one entity or every entity of the app. `subjects` names who it
 *   applies to (everyone, a role, a directory or tenant group, a workspace's members, one user); `rows` is a record
 *   filter in the query grammar whose values may name the user's facts (`$user.id`, `$user.username`,
 *   `$user.clearance`, `$user.roles`, `$user.groups`, `$user.workspaces`, `$user.attributes.<name>`), or null for
 *   every row; `fields` carries per-field grants (read, read unmasked, create, update) with a masking format, and
 *   `other_fields` the grant for fields it does not name. Enforced by the app service in queries, reads, writes,
 *   exports, forms, `/v1` tools and workflow steps; explained on the Apps screen.
 * - `users.attributes`: a tenant admin's attributes of a user (JSON: `{region: "emea", department: "sales"}`),
 *   compared by policies. Nullable, so nothing changes for existing rows.
 *
 * B-7601 DLP.
 * - `dlp_rules`: what a rule detects (built-in PII and secret detectors, and the tenant's own patterns), the label the
 *   content rises to, the action by that label (`label`: raise only; `redact`: replace the spans; `hold`: keep the
 *   content for review) and the scopes it applies to (`answer`, `agent`, `upload`).
 * - `dlp_patterns`: a tenant's own RE2 patterns, each with the label it implies.
 *
 * B-7602 legal holds.
 * - `legal_holds`: a hold on a user or a workspace, requested by one holder of `compliance:manage` and approved by
 *   another (dual control), that suspends every retention purge of their conversations, files, memories and agent
 *   runs until it is released. The reason is sealed with the tenant key.
 *
 * B-7603 compliance exports.
 * - `compliance_exports`: an export of conversations, files, memories, agent runs and users by user, workspace and
 *   date range, written by a job as JSON Lines sealed in parts in the blob store, for eDiscovery tools.
 * Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('app_policies', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('app_id', 26).notNullable();
    t.string('entity_id', 26).nullable();
    t.string('name', 100).notNullable();
    t.string('description', 500).nullable();
    t.boolean('enabled').notNullable().defaultTo(true);
    t.text('subjects').notNullable(); // JSON: [{kind, value?}]
    t.text('rows').nullable(); // JSON: a record filter with $user placeholders; null: every row
    t.text('fields').notNullable(); // JSON: {field: {read, unmasked, create, update, mask}}
    t.text('other_fields').notNullable(); // JSON: {read, unmasked, create, update}
    t.string('created_by', 26).nullable();
    t.string('updated_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'app_id'], 'app_policies_app_idx');
  });

  await knex.schema.alterTable('users', (t) => {
    t.text('attributes').nullable(); // JSON object of attribute name to string
  });

  await knex.schema.createTable('dlp_rules', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('name', 100).notNullable();
    t.boolean('enabled').notNullable().defaultTo(true);
    t.text('detectors').notNullable(); // JSON: ["payment_card", "private_key", "pattern:<id>", ...]
    t.string('raise_to', 20).notNullable();
    t.string('action', 10).notNullable(); // label | redact | hold
    t.text('scopes').notNullable(); // JSON: ["answer", "agent", "upload"]
    t.string('created_by', 26).nullable();
    t.string('updated_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id'], 'dlp_rules_tenant_idx');
  });

  await knex.schema.createTable('dlp_patterns', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('name', 100).notNullable();
    t.string('pattern', 2000).notNullable();
    t.string('label', 20).notNullable();
    t.boolean('enabled').notNullable().defaultTo(true);
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id'], 'dlp_patterns_tenant_idx');
  });

  await knex.schema.createTable('legal_holds', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('scope', 10).notNullable(); // user | workspace
    t.string('scope_id', 26).notNullable();
    t.text('reason').notNullable(); // sealed
    t.string('state', 10).notNullable(); // pending | active | rejected | withdrawn | released
    t.string('requested_by', 26).notNullable();
    t.string('approver_id', 26).notNullable();
    t.string('decided_by', 26).nullable();
    t.bigInteger('decided_at').nullable();
    t.string('released_by', 26).nullable();
    t.bigInteger('released_at').nullable();
    t.string('note', 500).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'state'], 'legal_holds_state_idx');
    t.index(['tenant_id', 'scope', 'scope_id'], 'legal_holds_scope_idx');
  });

  await knex.schema.createTable('compliance_exports', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.text('params').notNullable(); // JSON: {userId?, workspaceId?, from, to, kinds}
    t.string('scope', 300).notNullable();
    t.string('state', 10).notNullable(); // queued | running | ready | failed
    t.string('max_label', 20).notNullable();
    t.text('counts').nullable(); // JSON: {conversations, messages, files, memories, runs, users}
    t.integer('omitted').nullable();
    t.string('blob_key', 300).nullable();
    t.string('job_id', 26).nullable();
    t.string('created_by', 26).notNullable();
    t.string('api_key_id', 26).nullable();
    t.string('error', 500).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('finished_at').nullable();
    t.index(['tenant_id', 'created_at'], 'compliance_exports_tenant_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('compliance_exports');
  await knex.schema.dropTableIfExists('legal_holds');
  await knex.schema.dropTableIfExists('dlp_patterns');
  await knex.schema.dropTableIfExists('dlp_rules');
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('attributes');
  });
  await knex.schema.dropTableIfExists('app_policies');
}
