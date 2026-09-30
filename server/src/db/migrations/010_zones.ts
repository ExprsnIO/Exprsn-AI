import type { Knex } from 'knex';

/*
 * Sprint 9: network zones. A zone is platform-wide and versioned: a change is proposed as a draft version, reviewed
 * with its rendered NetworkPolicy, Compose and nftables diff, and becomes current when a second system admin
 * approves it. Pools, connections and MCP servers keep naming their zone by id (the existing `zone` columns).
 * Static endpoints are zone members the platform health-checks itself (pool instances come from the gateway poller).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('zones', (t) => {
    t.string('id', 63).primary(); // the zone name: edge, app, data, inference, ...
    t.integer('position').notNullable().defaultTo(0); // order in the table and on the map
    t.integer('current_version').nullable(); // null until the first version is approved
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });

  await knex.schema.createTable('zone_versions', (t) => {
    t.string('id', 26).primary();
    t.string('zone_id', 63).notNullable().references('id').inTable('zones').onDelete('CASCADE');
    t.integer('version').notNullable();
    t.string('status', 20).notNullable(); // draft | current | superseded | withdrawn | rejected
    t.text('spec', 'mediumtext').notNullable(); // JSON zone specification at this version
    t.text('move_pools').notNullable(); // JSON array of pool names moved into the zone when approved
    t.string('reason', 500).nullable();
    t.string('proposed_by', 26).nullable();
    t.bigInteger('proposed_at').nullable();
    t.string('decided_by', 26).nullable();
    t.bigInteger('decided_at').nullable();
    t.string('decision_note', 500).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['zone_id', 'version']);
    t.index(['zone_id', 'status']);
  });

  await knex.schema.createTable('zone_endpoints', (t) => {
    t.string('id', 26).primary();
    t.string('zone_id', 63).notNullable().references('id').inTable('zones').onDelete('CASCADE');
    t.string('name', 100).notNullable();
    t.string('address', 300).notNullable(); // http(s):// URL, or host:port for a TCP check
    t.string('kind', 40).notNullable().defaultTo('service');
    t.string('state', 20).notNullable().defaultTo('active'); // active | drained
    t.string('health', 20).notNullable().defaultTo('unknown'); // unknown | healthy | degraded | unhealthy
    t.string('health_detail', 300).nullable();
    t.integer('failures').notNullable().defaultTo(0); // consecutive failed checks
    t.integer('checks').notNullable().defaultTo(0); // checks since the last success or registration
    t.bigInteger('failing_since').nullable();
    t.bigInteger('last_checked_at').nullable();
    t.bigInteger('last_ok_at').nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['zone_id', 'name']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('zone_endpoints');
  await knex.schema.dropTableIfExists('zone_versions');
  await knex.schema.dropTableIfExists('zones');
}
