import type { Knex } from 'knex';

/*
 * 1.9.99-final, Sprint 62 (B-10703): the out-of-band change trail on drift findings (`cloud/change-trail.ts`).
 *
 * `cloud_change_trail`: per drift finding, what the provider's own trail (CloudTrail `LookupEvents`, the Azure
 * Activity Log, Cloudflare's audit logs) says about the change that caused it: the lookup's state (`pending`, `found`,
 * `not_found`, `unsupported`, `error`), how many lookups were made, the window asked about, the change chosen
 * ("changed by" principal, its type, the action, the service, the event id, the source address, when) and up to five
 * events as found (JSON). A cache: a finding's row is written by the drift run that looked it up and never changes the
 * finding itself.
 *
 * Expand only: one new table. While it is missing, drift runs as before, no trail is looked up, and each finding
 * answers `changedBy: null` with the trail `unavailable`.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('cloud_change_trail')) return;
  await knex.schema.createTable('cloud_change_trail', (t) => {
    t.string('finding_id', 26).primary();
    t.string('deployment_id', 26).notNullable();
    t.string('provider', 20).notNullable();
    t.string('state', 16).notNullable();
    t.integer('attempts').notNullable().defaultTo(0);
    t.bigInteger('window_from').nullable();
    t.bigInteger('window_to').nullable();
    t.string('principal', 500).nullable();
    t.string('principal_type', 60).nullable();
    t.string('action', 200).nullable();
    t.string('source', 200).nullable();
    t.string('event_id', 200).nullable();
    t.string('source_ip', 100).nullable();
    t.bigInteger('changed_at').nullable();
    t.boolean('by_exprsn').notNullable().defaultTo(false);
    t.text('events').nullable();
    t.string('error', 500).nullable();
    t.bigInteger('checked_at').notNullable();
    t.index(['deployment_id'], 'cloud_change_trail_deployment_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('cloud_change_trail');
}
