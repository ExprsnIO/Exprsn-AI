import type { Knex } from 'knex';

/*
 * Sprint 29 (1.5.0), access (031): B-3302 custom roles and B-3305 access reviews. The role × permission matrix
 * (B-3301), the effective-access matrix (B-3303) and the route permission registry (B-3304) are computed from the
 * catalogue and `policy.ts` and store nothing.
 *
 * - `custom_roles`: a tenant's role. `id` is `custom-` and a lower-case ULID (it fits `user_roles.role`, 40 characters).
 *   `state` is pending (its first version waits for a second admin), active or retired; `current_version` is the
 *   version in force (null while the first is pending). Name, description and the definition are the current version's.
 * - `custom_role_versions`: every version of a role, kept for the diff and the audit trail. `state` is pending (dual
 *   control: the role holds an admin permission), applied, rejected, withdrawn or superseded; `permissions` and
 *   `grantable_by` are JSON arrays.
 * - `access_reviews`: certification campaigns. `scope` is JSON ({ kinds, roles, workspaceId }), `reviewers` a JSON array
 *   of user ids; `state` scheduled, open, closed or cancelled. `every_days` repeats the campaign: closing it schedules
 *   the next one (`next_id`).
 * - `access_review_items`: one direct grant (a role or a workspace membership) of one user, snapshotted when the
 *   campaign opens; `decision` pending, confirmed, revoked or expired (the campaign closed first).
 * Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('custom_roles', (t) => {
    t.string('id', 40).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('name', 120).notNullable();
    t.string('description', 500).notNullable().defaultTo('');
    t.text('permissions').notNullable();
    t.boolean('requires_mfa').notNullable().defaultTo(true);
    t.text('grantable_by').notNullable();
    t.string('state', 20).notNullable(); // pending | active | retired
    t.integer('current_version').nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'state']);
  });

  await knex.schema.createTable('custom_role_versions', (t) => {
    t.string('role_id', 40).notNullable().references('id').inTable('custom_roles').onDelete('CASCADE');
    t.integer('version').notNullable();
    t.string('tenant_id', 26).notNullable();
    t.string('name', 120).notNullable();
    t.string('description', 500).notNullable().defaultTo('');
    t.text('permissions').notNullable();
    t.boolean('requires_mfa').notNullable();
    t.text('grantable_by').notNullable();
    t.boolean('dual_control').notNullable().defaultTo(false);
    t.string('state', 20).notNullable(); // pending | applied | rejected | withdrawn | superseded
    t.string('proposed_by', 26).nullable();
    t.bigInteger('proposed_at').notNullable();
    t.string('decided_by', 26).nullable();
    t.bigInteger('decided_at').nullable();
    t.string('note', 500).nullable();
    t.primary(['role_id', 'version']);
    t.index(['tenant_id', 'state']);
  });

  await knex.schema.createTable('access_reviews', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('name', 200).notNullable();
    t.string('state', 20).notNullable(); // scheduled | open | closed | cancelled
    t.text('scope').notNullable();
    t.text('reviewers').notNullable();
    t.bigInteger('opens_at').notNullable();
    t.integer('due_days').notNullable();
    t.bigInteger('due_at').nullable();
    t.integer('every_days').nullable();
    t.bigInteger('escalated_at').nullable();
    t.integer('items_total').notNullable().defaultTo(0);
    t.integer('items_decided').notNullable().defaultTo(0);
    t.string('next_id', 26).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('opened_at').nullable();
    t.bigInteger('closed_at').nullable();
    t.index(['tenant_id', 'state', 'opens_at']);
  });

  await knex.schema.createTable('access_review_items', (t) => {
    t.string('id', 26).primary();
    t.string('review_id', 26).notNullable().references('id').inTable('access_reviews').onDelete('CASCADE');
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('kind', 20).notNullable(); // role | workspace
    t.string('grant_ref', 40).notNullable(); // a role id or a workspace id
    t.string('decision', 20).notNullable(); // pending | confirmed | revoked | expired
    t.string('decided_by', 26).nullable();
    t.bigInteger('decided_at').nullable();
    t.string('note', 500).nullable();
    t.boolean('removed').notNullable().defaultTo(false);
    t.index(['review_id', 'decision']);
    t.index(['tenant_id', 'user_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['access_review_items', 'access_reviews', 'custom_role_versions', 'custom_roles']) await knex.schema.dropTableIfExists(table);
}
