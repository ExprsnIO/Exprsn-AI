import type { Knex } from 'knex';

/*
 * 1.9.99-final, Sprint 57 (B-10106, B-10107): drift findings, destroys with their protected resources, and orphans
 * (`cloud/drift.ts`, `cloud/destroy.ts`, `cloud/orphans.ts`). The rate limits and the circuit breaker (B-10108) keep
 * no table: the buckets are on the shared counter store, the breaker in each process.
 *
 * - `cloud_drift_findings`: what the scheduled `cloud.drift` found per deployment: `kind` field (a field of a managed
 *   resource differs from its desired spec), missing (the provider no longer reports it) or unmanaged (a resource
 *   inside a managed network or tagged for the deployment that the graph does not hold). One open row per
 *   fingerprint (kind, resource or provider id, field); `state` open | reverted | adopted | ignored | resolved. An
 *   ignored field finding is also the rule that keeps that field out of later runs. `desired` and `observed` are JSON
 *   (provider props, never a secret).
 * - `cloud_destroys`: one per destroy of a deployment: `protected` (JSON) lists each protected resource with its final
 *   snapshot and its second admin's approval; `rounds` (JSON) the destroy plans applied; `acting_user` whose name the
 *   next round runs under (the requester, then each approver).
 * - `cloud_orphans`: resources an account's sweep found tagged for Exprsn-AI that no graph and no journal knows, until
 *   they are adopted into a deployment, deleted or ignored.
 *
 * Expand only: three new tables. While they are missing the lifecycle routes answer 503 `migration_pending` and the
 * drift and orphan schedules queue nothing.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('cloud_drift_findings'))) {
    await knex.schema.createTable('cloud_drift_findings', (t) => {
      t.string('id', 26).primary();
      t.string('deployment_id', 26).notNullable();
      t.string('tenant_id', 26).notNullable();
      t.string('kind', 12).notNullable(); // field | missing | unmanaged
      t.string('resource_key', 63).nullable();
      t.string('resource_type', 32).notNullable();
      t.string('provider_id', 400).nullable();
      t.string('path', 120).notNullable().defaultTo(''); // the field, '' for missing and unmanaged
      t.string('fingerprint', 64).notNullable();
      t.text('desired', 'mediumtext').nullable(); // JSON
      t.text('observed', 'mediumtext').nullable(); // JSON
      t.string('detail', 500).nullable();
      t.string('state', 10).notNullable(); // open | reverted | adopted | ignored | resolved
      t.string('decided_by', 26).nullable();
      t.bigInteger('decided_at').nullable();
      t.string('decision_note', 500).nullable();
      t.string('plan_id', 26).nullable();
      t.bigInteger('first_seen').notNullable();
      t.bigInteger('last_seen').notNullable();
      t.index(['deployment_id', 'state']);
      t.index(['fingerprint']);
    });
  }
  if (!(await knex.schema.hasTable('cloud_destroys'))) {
    await knex.schema.createTable('cloud_destroys', (t) => {
      t.string('id', 26).primary();
      t.string('deployment_id', 26).notNullable();
      t.string('tenant_id', 26).notNullable();
      t.string('state', 12).notNullable(); // running | waiting | finished | failed | cancelled
      t.string('reason', 500).nullable();
      t.string('requested_by', 26).notNullable();
      t.string('acting_user', 26).notNullable();
      t.text('protected', 'mediumtext').notNullable(); // JSON
      t.text('rounds').notNullable(); // JSON array of plan ids
      t.string('job_id', 26).nullable();
      t.string('note', 1000).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.bigInteger('finished_at').nullable();
      t.index(['deployment_id', 'state']);
    });
  }
  if (!(await knex.schema.hasTable('cloud_orphans'))) {
    await knex.schema.createTable('cloud_orphans', (t) => {
      t.string('id', 26).primary();
      t.string('account_id', 26).notNullable();
      t.string('tenant_id', 26).notNullable();
      t.string('provider', 20).notNullable();
      t.string('resource_type', 32).notNullable();
      t.string('provider_id', 400).notNullable();
      t.string('name', 200).notNullable();
      t.string('region', 40).nullable();
      t.string('deployment_name', 63).nullable(); // its exprsn:deployment tag
      t.text('tags').notNullable(); // JSON
      t.text('observed', 'mediumtext').notNullable(); // JSON
      t.string('state', 10).notNullable(); // open | adopted | deleted | ignored | gone
      t.string('deployment_id', 26).nullable(); // adopted into, or deleted through
      t.string('decided_by', 26).nullable();
      t.bigInteger('decided_at').nullable();
      t.bigInteger('first_seen').notNullable();
      t.bigInteger('last_seen').notNullable();
      t.unique(['account_id', 'resource_type', 'provider_id']);
      t.index(['account_id', 'state']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('cloud_orphans');
  await knex.schema.dropTableIfExists('cloud_destroys');
  await knex.schema.dropTableIfExists('cloud_drift_findings');
}
