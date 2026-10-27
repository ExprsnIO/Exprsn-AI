import type { Knex } from 'knex';

/*
 * 1.9.99-final, Sprint 60 (B-10402, B-10403, B-10605): autoscale, spot capacity and idle GPU savings for cloud GPU
 * pools (`cloud/autoscale.ts`).
 *
 * - `cloud_scale_policies`: one row per gateway pool that runs on a cloud GPU node group: the node group's minimum,
 *   maximum and desired size as the gateway keeps them, the idle minutes after which a pool with no slot leases scales
 *   down to its minimum, the queue depth per node that adds a node, the longest a request waits for a cold start, the
 *   capacity (`on_demand` or `spot`), whether a spot pool falls back to on-demand nodes, which capacity serves now,
 *   and the last slot lease any server saw. `deployment_id` and `resource_key` name the node group when the GPU
 *   pools link (`cloud/gpu-pools.ts`) does not.
 * - `cloud_scale_events`: every scale decision (applied, refused by the budget's hard stop, failed at the provider)
 *   with its reason (`idle`, `queue`, `cold`, `manual`, `interruption`, `fallback`) and, for a scale-up, when the
 *   first instance answered healthy: the boot-to-healthy timings the cold-start estimate is made from.
 * - `cloud_interruptions`: spot interruption notices a node posted (the EC2 two-minute notice, the EC2 rebalance
 *   recommendation, Azure Scheduled Events `Preempt`), unique per instance, kind and event, with the drain's outcome.
 * - `cloud_gpu_savings`: the savings ledger: one interval per idle scale-down, the nodes it took away, from when to
 *   when (open while the pool stays down). Hours × nodes × the on-demand price is the estimated saving.
 *
 * Expand only: four new tables. While it is missing, cloud pools are served as before (no autoscale, no cold-start
 * wait, no savings) and the routes answer 503 `migration_pending`.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('cloud_scale_policies'))) {
    await knex.schema.createTable('cloud_scale_policies', (t) => {
      t.string('pool_id', 26).primary();
      t.string('deployment_id', 26).nullable();
      t.string('resource_key', 100).nullable();
      t.integer('min').notNullable().defaultTo(0);
      t.integer('max').notNullable().defaultTo(1);
      t.integer('desired').notNullable().defaultTo(0);
      t.integer('idle_minutes').notNullable().defaultTo(15);
      t.integer('queue_depth').notNullable().defaultTo(2);
      t.integer('max_cold_wait_ms').notNullable().defaultTo(600_000);
      t.string('capacity', 10).notNullable().defaultTo('on_demand'); // on_demand | spot
      t.boolean('on_demand_fallback').notNullable().defaultTo(true);
      t.string('capacity_now', 10).notNullable().defaultTo('on_demand');
      t.integer('od_nodes').notNullable().defaultTo(0); // a spot pool's nodes on its on-demand sibling
      t.bigInteger('last_lease_at').nullable();
      t.bigInteger('scaled_at').nullable();
      t.string('updated_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.index(['deployment_id']);
    });
  }
  if (!(await knex.schema.hasTable('cloud_scale_events'))) {
    await knex.schema.createTable('cloud_scale_events', (t) => {
      t.string('id', 26).primary();
      t.string('pool_id', 26).notNullable();
      t.integer('from_size').notNullable();
      t.integer('to_size').notNullable();
      t.string('reason', 16).notNullable();
      t.string('outcome', 10).notNullable(); // applied | refused | failed
      t.string('capacity', 10).nullable();
      t.string('actor', 100).notNullable();
      t.text('detail').nullable();
      t.bigInteger('requested_at').notNullable();
      t.bigInteger('healthy_at').nullable();
      t.index(['pool_id', 'requested_at']);
    });
  }
  if (!(await knex.schema.hasTable('cloud_interruptions'))) {
    await knex.schema.createTable('cloud_interruptions', (t) => {
      t.string('id', 26).primary();
      t.string('pool_id', 26).notNullable();
      t.string('instance_id', 26).notNullable();
      t.string('provider', 16).notNullable();
      t.string('kind', 20).notNullable(); // ec2_interruption | ec2_rebalance | azure_preempt
      t.string('event_key', 100).notNullable();
      t.bigInteger('notice_at').notNullable();
      t.bigInteger('reclaim_at').nullable();
      t.bigInteger('drained_at').nullable();
      t.integer('finished').notNullable().defaultTo(0);
      t.integer('moved').notNullable().defaultTo(0);
      t.string('state', 12).notNullable(); // draining | drained | reclaimed
      t.text('detail').nullable();
      t.unique(['instance_id', 'kind', 'event_key']);
      t.index(['pool_id', 'notice_at']);
    });
  }
  if (!(await knex.schema.hasTable('cloud_gpu_savings'))) {
    await knex.schema.createTable('cloud_gpu_savings', (t) => {
      t.string('id', 26).primary();
      t.string('pool_id', 26).notNullable();
      t.string('provider', 16).notNullable();
      t.string('region', 64).nullable();
      t.string('sku', 120).notNullable();
      t.integer('nodes').notNullable();
      t.bigInteger('from_at').notNullable();
      t.bigInteger('to_at').nullable();
      t.index(['pool_id', 'from_at']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('cloud_gpu_savings');
  await knex.schema.dropTableIfExists('cloud_interruptions');
  await knex.schema.dropTableIfExists('cloud_scale_events');
  await knex.schema.dropTableIfExists('cloud_scale_policies');
}
