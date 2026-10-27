import type { Knex } from 'knex';

/*
 * 1.7.0, Sprint 42 (B-9209, B-9701, B-9702): owners of vault references, group bans, invite links and messages.
 *
 * - `vault_reference_owners` (B-9209): a `vault:` reference saved by a person may be handed to a workspace or to a
 *   named service, so that it resolves under that owner's vault policy and no longer depends on the person staying
 *   active. One row per person and reference (`ref_key` is the SHA-256 of the reference). Nothing is converted here:
 *   every reference saved before this migration keeps resolving as the person who saved it until a holder of
 *   `secrets:admin` hands it over, one reference at a time.
 * - `group_bans` (B-9701): a ban (the member is removed and may not come back) or a suspension (the membership stays
 *   and is without effect) of one person in one group. `active_key` is `<group>:<user>` while it stands, so one stands
 *   at a time; `expires_at` null means until it is lifted.
 * - `group_invite_links`, `group_invite_uses` (B-9702): a link's code is shown once and kept as a keyed digest;
 *   `uses` counts the people it admitted against `max_uses`.
 * - `group_requests.message` (B-9702): what the requester or the inviter wrote, sealed as `group-request:<id>`.
 *
 * Expand only: three new tables, one more, and one nullable column. No existing row changes.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('vault_reference_owners'))) {
    await knex.schema.createTable('vault_reference_owners', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('saved_by', 26).notNullable(); // the person the integration's owner column names
      t.string('ref', 600).notNullable();
      t.string('ref_key', 64).notNullable();
      t.string('owner_kind', 12).notNullable(); // workspace | service
      t.string('owner', 100).notNullable(); // the workspace id, or the service's name
      t.string('clearance', 20).notNullable(); // the highest label the reference reads at
      t.string('created_by', 26).notNullable();
      t.bigInteger('created_at').notNullable();
      t.unique(['tenant_id', 'saved_by', 'ref_key']);
    });
  }

  if (!(await knex.schema.hasTable('group_bans'))) {
    await knex.schema.createTable('group_bans', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('group_id', 26).notNullable();
      t.string('user_id', 26).notNullable();
      t.string('kind', 10).notNullable(); // ban | suspend
      t.text('reason').nullable(); // sealed as group-ban:<id>
      t.string('active_key', 60).nullable().unique();
      t.string('created_by', 26).notNullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('expires_at').nullable();
      t.string('lifted_by', 26).nullable();
      t.bigInteger('lifted_at').nullable();
      t.index(['group_id', 'created_at']);
      t.index(['tenant_id', 'user_id']);
    });
  }

  if (!(await knex.schema.hasTable('group_invite_links'))) {
    await knex.schema.createTable('group_invite_links', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('group_id', 26).notNullable();
      t.string('code_hash', 64).notNullable().unique();
      t.string('code_hint', 8).notNullable(); // the code's last four characters, to tell links apart
      t.integer('max_uses').nullable(); // null: no limit
      t.integer('uses').notNullable().defaultTo(0);
      t.bigInteger('expires_at').notNullable();
      t.string('state', 10).notNullable().defaultTo('active'); // active | revoked
      t.string('created_by', 26).notNullable();
      t.bigInteger('created_at').notNullable();
      t.string('revoked_by', 26).nullable();
      t.bigInteger('revoked_at').nullable();
      t.index(['group_id', 'created_at']);
    });
    await knex.schema.createTable('group_invite_uses', (t) => {
      t.string('link_id', 26).notNullable();
      t.string('user_id', 26).notNullable();
      t.bigInteger('used_at').notNullable();
      t.primary(['link_id', 'user_id']);
    });
  }

  if (!(await knex.schema.hasColumn('group_requests', 'message'))) {
    await knex.schema.alterTable('group_requests', (t) => {
      t.text('message').nullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('group_requests', (t) => {
    t.dropColumn('message');
  });
  await knex.schema.dropTableIfExists('group_invite_uses');
  await knex.schema.dropTableIfExists('group_invite_links');
  await knex.schema.dropTableIfExists('group_bans');
  // The references handed over resolve as the person who saved them again, as before this migration.
  await knex.schema.dropTableIfExists('vault_reference_owners');
}
