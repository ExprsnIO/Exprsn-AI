import type { Knex } from 'knex';

/*
 * Sprint 22: operations, second part. Expand only (new tables and a nullable column), so an instance one release
 * older keeps working against it until the schema handshake (db/schema.ts) asks it to stop taking jobs.
 * - Tracing (B-1401): the W3C traceparent of the request that queued a job, so the job's spans join its trace.
 * - Key escrow (B-1404): one row per `kms:escrow` run with the key check value that `kms:recover` verifies against.
 *   The shares themselves are printed once and never stored.
 * - Zones applied in-cluster (B-1405): each object the server applied through the Kubernetes API, the hash of what
 *   was applied, and the last drift check.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('jobs', (t) => {
    t.string('trace_parent', 55).nullable();
  });

  await knex.schema.createTable('kms_escrows', (t) => {
    t.string('id', 26).primary();
    t.string('kms', 20).notNullable(); // local
    t.integer('threshold').notNullable();
    t.integer('shares').notNullable();
    t.string('key_check', 32).notNullable(); // hex, HMAC-SHA256(key, label) truncated: identifies the key, reveals nothing
    t.string('created_by', 100).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('verified_at').nullable(); // the last kms:recover that matched this key check value
  });

  await knex.schema.createTable('zone_cluster_objects', (t) => {
    t.string('namespace', 63).notNullable();
    t.string('kind', 40).notNullable();
    t.string('name', 253).notNullable();
    t.string('zone_id', 31).notNullable();
    t.integer('zone_version').notNullable();
    t.string('desired_hash', 64).notNullable();
    t.string('state', 20).notNullable(); // pending | applied | drift | missing | error
    t.string('detail', 1000).nullable();
    t.bigInteger('applied_at').nullable();
    t.bigInteger('checked_at').nullable();
    t.bigInteger('updated_at').notNullable();
    t.primary(['namespace', 'kind', 'name']);
    t.index(['zone_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('zone_cluster_objects');
  await knex.schema.dropTableIfExists('kms_escrows');
  await knex.schema.alterTable('jobs', (t) => {
    t.dropColumn('trace_parent');
  });
}
