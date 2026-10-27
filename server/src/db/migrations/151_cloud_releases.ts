import type { Knex } from 'knex';

/*
 * 1.9.99-final, Sprint 58 (B-10203, B-10207): the Helm releases of Kubernetes deployments, their upgrades, and the
 * database snapshots taken before each upgrade (`cloud/releases.ts`, `cloud/upgrades.ts`).
 *
 * - `cloud_releases`: one row per Helm revision the deploy worker installed, upgraded to or rolled back to: the
 *   release and namespace, the chart version, the image (repository and digest), a hash of the values (the values
 *   themselves never hold a secret, only the names of the Kubernetes Secret's keys), the ingress address read after
 *   it, and its state (deployed | failed | superseded | rolled_back).
 * - `cloud_upgrades`: an upgrade of a deployment to a new image digest: the plan it was approved by (purpose
 *   `upgrade`, applied by its hash), the steps (snapshot, migrate --check, rolling update, verify, automatic rollback
 *   of the app tier) as JSON, and its state.
 * - `cloud_snapshots`: the database snapshots taken before upgrades (through the adapter's snapshot hook, or an
 *   operator's own backup acknowledged by reference), listed for restore. A restore is asked for by one cloud admin
 *   and approved by another (`restore`, JSON): the database rolls back only this way.
 *
 * Expand only: three new tables. While they are missing a Kubernetes deployment is verified without a release, and
 * the release, upgrade and snapshot routes answer 503 `migration_pending`.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('cloud_releases'))) {
    await knex.schema.createTable('cloud_releases', (t) => {
      t.string('id', 26).primary();
      t.string('deployment_id', 26).notNullable();
      t.string('tenant_id', 26).notNullable();
      t.string('release', 53).notNullable();
      t.string('namespace', 63).notNullable();
      t.integer('revision').notNullable();
      t.string('chart_version', 40).notNullable();
      t.string('repository', 300).notNullable();
      t.string('digest', 80).notNullable();
      t.string('values_hash', 64).notNullable();
      t.string('state', 12).notNullable(); // deployed | failed | superseded | rolled_back
      t.string('reason', 12).notNullable(); // install | upgrade | rollback
      t.string('upgrade_id', 26).nullable();
      t.string('address', 300).nullable();
      t.string('error', 1000).nullable();
      t.string('created_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.index(['deployment_id', 'created_at']);
    });
  }
  if (!(await knex.schema.hasTable('cloud_upgrades'))) {
    await knex.schema.createTable('cloud_upgrades', (t) => {
      t.string('id', 26).primary();
      t.string('deployment_id', 26).notNullable();
      t.string('tenant_id', 26).notNullable();
      t.string('plan_id', 26).notNullable();
      t.string('from_digest', 80).notNullable();
      t.string('to_digest', 80).notNullable();
      t.string('repository', 300).notNullable();
      t.string('state', 14).notNullable(); // planned | running | succeeded | rolled_back | blocked | failed | expired
      t.text('steps', 'mediumtext').notNullable(); // JSON
      t.string('snapshot_id', 26).nullable();
      t.text('backup').nullable(); // JSON: an operator's own backup, acknowledged by reference
      t.string('note', 1000).nullable();
      t.string('created_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.bigInteger('finished_at').nullable();
      t.index(['deployment_id', 'created_at']);
      t.index(['plan_id']);
    });
  }
  if (!(await knex.schema.hasTable('cloud_snapshots'))) {
    await knex.schema.createTable('cloud_snapshots', (t) => {
      t.string('id', 26).primary();
      t.string('deployment_id', 26).notNullable();
      t.string('tenant_id', 26).notNullable();
      t.string('upgrade_id', 26).nullable();
      t.string('kind', 10).notNullable(); // provider | external
      t.string('resource_key', 63).nullable();
      t.string('resource_type', 32).nullable();
      t.string('provider_id', 400).nullable();
      t.string('name', 200).notNullable();
      t.string('snapshot_ref', 400).nullable(); // the provider's snapshot id, or the operator's backup reference
      t.string('state', 10).notNullable(); // pending | available | failed
      t.text('pending', 'mediumtext').nullable(); // JSON: the snapshot operation being followed
      t.text('restore', 'mediumtext').nullable(); // JSON: the dual-controlled restore
      t.string('error', 1000).nullable();
      t.string('created_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.index(['deployment_id', 'created_at']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('cloud_snapshots');
  await knex.schema.dropTableIfExists('cloud_upgrades');
  await knex.schema.dropTableIfExists('cloud_releases');
}
