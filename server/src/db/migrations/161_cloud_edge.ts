import type { Knex } from 'knex';

/*
 * 1.9.99-final, Sprint 61 (B-10901 to B-10904): Cloudflare front doors (`cloud/edge.ts`).
 *
 * `cloud_edge` is one front door: a hostname in a Cloudflare zone on a platform Cloudflare account, in front of a
 * cloud deployment (`deployment_id`) or of an install without one (this install, or an on-prem one: `deployment_id`
 * null). It keeps what the front door is (the origin: a named tunnel to a local service, or a public origin address;
 * the WAF options; the Access settings) and what the last apply did: the tunnel's id and the vault reference of its
 * token (`token_ref`, `vault:cloud/edge/<id>#tunnel_token`, never the token), the Access applications and their
 * audience tag, each step's result, and the mode it moved from (`acme` when a name answered DNS-only before).
 * Expand only; a build without this migration answers the front door routes 503 `migration_pending` and changes
 * nothing else.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('cloud_edge')) return;
  await knex.schema.createTable('cloud_edge', (t) => {
    t.string('id', 26).primary();
    t.string('name', 64).notNullable().unique();
    t.string('account_id', 26).notNullable();
    t.string('deployment_id', 26).nullable();
    t.string('hostname', 253).notNullable().unique();
    t.string('zone', 253).notNullable();
    t.string('plan', 16).notNullable().defaultTo('free');
    t.text('origin').notNullable();
    t.text('waf').notNullable();
    t.text('access').nullable();
    t.string('state', 16).notNullable().defaultTo('draft');
    t.string('switched_from', 16).nullable();
    t.string('tunnel_id', 64).nullable();
    t.string('token_ref', 200).nullable();
    t.string('access_aud', 64).nullable();
    t.text('steps').nullable();
    t.text('last_error').nullable();
    t.string('created_by', 26).nullable();
    t.string('created_tenant', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.bigInteger('applied_at').nullable();
    t.index(['account_id']);
    t.index(['deployment_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('cloud_edge');
}
