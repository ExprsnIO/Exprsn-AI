import type { Knex } from 'knex';

/*
 * 1.9.99-final, Sprint 60 (B-10401, B-10404): cloud GPU node groups and GPU VMs as gateway pools.
 *
 * - `cloud_gpu_pool_links`: one row per GPU pool of a deployment spec, linking the graph resource (an EKS managed node
 *   group, an AKS or DOKS GPU node pool, or the pool's GPU VMs) to the gateway pool its nodes join: the provider's id,
 *   the instance type it runs (after any capacity fallback), size limits (min, max, desired), the price per node hour,
 *   the PKI profiles the node and gateway certificates are issued under, the gateway's client identity for the pool
 *   (its certificate id; the private key sealed with the tenant key, never returned), the warm-up source (the model
 *   mirror or a pre-seeded volume snapshot) and its state.
 * - `cloud_gpu_enrolments`: single-use enrolment tokens (only their SHA-256 is kept), each bound to a link and, for a
 *   node group, to the node's name and private address; used once, by the node's bootstrap, to exchange a CSR for its
 *   server certificate. A used, expired or unknown token is refused.
 * - `cloud_gpu_boot_timings`: per node, the time from boot to healthy: booted (the provider's creation time or the
 *   token's), enrolled, healthy (the gateway saw the instance healthy with every approved placement listed), and where
 *   the models came from (mirror, snapshot).
 *
 * Expand only: three new tables. While it is missing nothing changes: deployments with GPU pools apply as before and
 * the GPU pool routes answer 503 `migration_pending`.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('cloud_gpu_pool_links'))) {
    await knex.schema.createTable('cloud_gpu_pool_links', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('deployment_id', 26).notNullable();
      t.string('provider', 20).notNullable();
      t.string('pool_name', 40).notNullable(); // the spec's GPU pool name
      t.string('resource_key', 100).notNullable(); // the graph key (node group) or key prefix (VMs)
      t.string('kind', 12).notNullable(); // node_group | vm
      t.string('provider_id', 500).nullable();
      t.string('gateway_pool_id', 26).nullable();
      t.string('gpu', 10).notNullable();
      t.string('instance_type', 100).notNullable();
      t.text('instance_types').notNullable(); // JSON: the allowed types in order (capacity fallback)
      t.text('zones').notNullable(); // JSON: the allowed zones in order
      t.integer('min_nodes').notNullable();
      t.integer('max_nodes').notNullable();
      t.integer('desired_nodes').nullable();
      t.double('price_hourly').nullable();
      t.string('currency', 3).nullable();
      t.string('server_profile_id', 26).nullable();
      t.string('client_profile_id', 26).nullable();
      t.string('client_cert_id', 26).nullable();
      t.text('client_key_sealed').nullable();
      t.text('warmup').notNullable(); // JSON: { source: mirror | snapshot, snapshotId?, mirror? }
      t.string('state', 20).notNullable(); // pending | active | pki_missing | removed
      t.string('state_detail', 500).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.unique(['deployment_id', 'pool_name']);
      t.index(['gateway_pool_id']);
    });
  }
  if (!(await knex.schema.hasTable('cloud_gpu_enrolments'))) {
    await knex.schema.createTable('cloud_gpu_enrolments', (t) => {
      t.string('id', 26).primary();
      t.string('link_id', 26).notNullable();
      t.string('token_hash', 64).notNullable().unique();
      t.string('node', 253).nullable(); // a node group's node name (bound), or the VM's graph key
      t.string('address', 45).nullable(); // the private address the node must present (bound when known)
      t.bigInteger('expires_at').notNullable();
      t.bigInteger('used_at').nullable();
      t.string('instance_id', 26).nullable();
      t.string('certificate_id', 26).nullable();
      t.string('created_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.index(['link_id']);
    });
  }
  if (!(await knex.schema.hasTable('cloud_gpu_boot_timings'))) {
    await knex.schema.createTable('cloud_gpu_boot_timings', (t) => {
      t.string('id', 26).primary();
      t.string('link_id', 26).notNullable();
      t.string('instance_id', 26).notNullable().unique();
      t.string('node', 253).nullable();
      t.string('source', 10).notNullable(); // mirror | snapshot
      t.bigInteger('booted_at').notNullable();
      t.bigInteger('enrolled_at').notNullable();
      t.bigInteger('healthy_at').nullable();
      t.integer('seconds').nullable(); // healthy − booted
      t.index(['link_id']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('cloud_gpu_boot_timings');
  await knex.schema.dropTableIfExists('cloud_gpu_enrolments');
  await knex.schema.dropTableIfExists('cloud_gpu_pool_links');
}
