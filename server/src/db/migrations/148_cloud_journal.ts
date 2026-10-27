import type { Knex } from 'knex';

/*
 * 1.9.99-final, Sprint 57 (B-10102 to B-10105, B-10701): the resource graph, plans and the operation journal
 * (`cloud/graph.ts`, `cloud/deployments.ts`, `cloud/planner.ts`, `cloud/journal.ts`, `cloud/apply.ts`).
 *
 * - `cloud_deployments`: one per deployment, on one cloud account. `scope` is the account's (a platform deployment
 *   also needs `platform:manage`); `label` is the highest label of what it holds; `spec` the deployment spec it was
 *   rendered from (JSON, no secret); `endpoints` where its app answers (JSON); `observed_version` is bumped whenever
 *   the observed state of one of its resources changes (a plan made at another version is stale); `lease_holder` and
 *   `lease_until` are the one apply that may run (B-10104); `verify` the last verify report (JSON).
 * - `cloud_resources`: the graph, one row per resource key: the desired resource (JSON), the observed state (JSON) and
 *   its hash, the provider id and locator, dependencies, the protection flag, tags, state, the journal step and audit
 *   entry that created it (B-10701), and the desired and observed state at the last passing verify (`last_verified`).
 * - `cloud_plans`: plans with their hash, the desired graph and the steps (JSON, mediumtext), the estimate, the
 *   observed version and digest they were made at, state and expiry.
 * - `cloud_operations`: the append-only operation journal. Every state of every step is a new row (step, idempotency
 *   key, client token, provider request id, attempt, state, error, the long-running operation's handle); rows are
 *   never updated or deleted by the application.
 *
 * Expand only: four new tables. A build from before this migration ignores them; this build answers 503
 * `migration_pending` for deployments while they are missing.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('cloud_deployments'))) {
    await knex.schema.createTable('cloud_deployments', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('scope', 10).notNullable(); // platform | tenant (the account's)
      t.string('account_id', 26).notNullable();
      t.string('provider', 20).notNullable();
      t.string('name', 63).notNullable();
      t.string('region', 40).notNullable();
      t.string('label', 16).notNullable();
      t.string('description', 500).nullable();
      t.string('state', 16).notNullable(); // draft | planned | applying | applied | ready | degraded | failed | destroying | destroyed
      t.string('health', 12).notNullable(); // unknown | healthy | degraded
      t.text('spec', 'mediumtext').nullable(); // JSON
      t.text('endpoints').nullable(); // JSON
      t.integer('observed_version').notNullable().defaultTo(0);
      t.string('current_plan_id', 26).nullable();
      t.string('lease_holder', 64).nullable();
      t.bigInteger('lease_until').nullable();
      t.text('verify', 'mediumtext').nullable(); // JSON
      t.bigInteger('verified_at').nullable();
      t.string('created_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.unique(['tenant_id', 'name']);
      t.index(['account_id']);
      t.index(['scope', 'state']);
    });
  }
  if (!(await knex.schema.hasTable('cloud_resources'))) {
    await knex.schema.createTable('cloud_resources', (t) => {
      t.string('id', 26).primary();
      t.string('deployment_id', 26).notNullable();
      t.string('key', 63).notNullable();
      t.string('type', 32).notNullable();
      t.string('region', 40).notNullable();
      t.string('provider_id', 400).nullable();
      t.text('locator').nullable(); // JSON
      t.text('desired', 'mediumtext').notNullable(); // JSON DesiredResource
      t.text('observed', 'mediumtext').nullable(); // JSON ObservedResource
      t.string('observed_hash', 64).nullable(); // sha256, or 'missing'
      t.bigInteger('observed_at').nullable();
      t.text('depends_on').notNullable(); // JSON array of keys
      t.boolean('protect').notNullable().defaultTo(false);
      t.text('tags').notNullable(); // JSON
      t.string('state', 12).notNullable(); // planned | creating | ready | updating | deleting | deleted | failed | missing
      t.string('created_op', 26).nullable(); // cloud_operations.id
      t.string('created_audit', 26).nullable(); // audit_events.id
      t.text('last_verified', 'mediumtext').nullable(); // JSON { desired, observed, at }
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.unique(['deployment_id', 'key']);
      t.index(['provider_id']);
    });
  }
  if (!(await knex.schema.hasTable('cloud_plans'))) {
    await knex.schema.createTable('cloud_plans', (t) => {
      t.string('id', 26).primary();
      t.string('deployment_id', 26).notNullable();
      t.string('tenant_id', 26).notNullable();
      t.string('hash', 64).notNullable();
      t.string('purpose', 10).notNullable(); // apply | revert | destroy | rollback
      t.text('desired', 'mediumtext').notNullable(); // JSON
      t.text('steps', 'mediumtext').notNullable(); // JSON
      t.text('summary').notNullable(); // JSON
      t.text('estimate', 'mediumtext').nullable(); // JSON
      t.integer('observed_version').notNullable();
      t.string('observed_digest', 64).notNullable();
      t.string('state', 10).notNullable(); // open | applying | applied | failed | stale | expired | cancelled
      t.boolean('applicable').notNullable().defaultTo(true);
      t.text('blockers').nullable(); // JSON
      t.string('note', 500).nullable();
      t.string('created_by', 26).nullable();
      t.string('applied_by', 26).nullable();
      t.string('apply_job_id', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('expires_at').notNullable();
      t.bigInteger('applied_at').nullable();
      t.unique(['hash']);
      t.index(['deployment_id', 'created_at']);
    });
  }
  if (!(await knex.schema.hasTable('cloud_operations'))) {
    await knex.schema.createTable('cloud_operations', (t) => {
      t.string('id', 26).primary(); // ULID: the journal's order
      t.string('deployment_id', 26).notNullable();
      t.string('plan_id', 26).nullable();
      t.string('resource_key', 63).notNullable();
      t.string('step', 20).notNullable(); // create | update | delete | replace.delete | replace.create | poll | refresh | verify
      t.string('idempotency_key', 64).notNullable();
      t.string('client_token', 64).nullable();
      t.string('provider_request_id', 200).nullable();
      t.integer('attempt').notNullable();
      t.string('state', 10).notNullable(); // started | pending | succeeded | adopted | failed | cancelled
      t.text('error').nullable();
      t.text('handle').nullable(); // JSON OperationHandle
      t.string('provider_id', 400).nullable();
      t.string('audit_id', 26).nullable();
      t.string('job_id', 26).nullable();
      t.string('worker', 120).nullable();
      t.bigInteger('at').notNullable();
      t.index(['deployment_id', 'id']);
      t.index(['plan_id', 'resource_key']);
      t.index(['idempotency_key']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('cloud_operations');
  await knex.schema.dropTableIfExists('cloud_plans');
  await knex.schema.dropTableIfExists('cloud_resources');
  await knex.schema.dropTableIfExists('cloud_deployments');
}
