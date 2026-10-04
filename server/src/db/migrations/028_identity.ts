import type { Knex } from 'knex';

/*
 * Sprint 26a (B-1801 to B-1805): the identity gaps.
 * - `identity_policies`: one row per tenant with its signup policy (closed, open, approval; a domain allow-list;
 *   whether email must be verified) and its MFA policy (all, or for roles; a grace period; how long a device may be
 *   trusted), as JSON, and when the MFA requirement last widened (the start of the grace period).
 * - `users.email_verified_at`: when the address was proven (a verification link) or vouched for (created by an admin,
 *   or by an emailed invitation). Existing accounts with an address count as verified from their creation.
 * - `account_signups`: self-registered accounts and their approval state.
 * - `email_verifications`: single-use verification links (only the token's SHA-256 is stored), bound to the address.
 * - `invitations`: invitations by workspace admins with roles, a clearance and a workspace (token stored as SHA-256).
 * - `trusted_devices`: a device (the B-801 cookie) that skips the second factor until it expires; keyed by a digest of
 *   the user and the device id, removed whenever the user's sessions are revoked.
 * - `user_imports`: CSV imports of users, memberships and group mappings, run as jobs; the CSV is sealed with the
 *   tenant key and the report kept.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('identity_policies', (t) => {
    t.string('tenant_id', 26).primary().references('id').inTable('tenants').onDelete('CASCADE');
    t.text('signup').notNullable(); // JSON
    t.text('mfa').notNullable(); // JSON
    t.bigInteger('mfa_effective_at').nullable();
    t.string('updated_by', 26).nullable();
    t.bigInteger('updated_at').notNullable();
  });

  await knex.schema.alterTable('users', (t) => {
    t.bigInteger('email_verified_at').nullable();
  });
  // Existing accounts were created by admins or a directory: their addresses count as vouched for.
  await knex('users').whereNotNull('email').update({ email_verified_at: knex.raw('??', ['created_at']) });

  await knex.schema.createTable('account_signups', (t) => {
    t.string('user_id', 26).primary().references('id').inTable('users').onDelete('CASCADE');
    t.string('tenant_id', 26).notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('state', 20).notNullable(); // pending | approved | rejected | active
    t.string('email_domain', 255).notNullable();
    t.string('ip', 64).nullable();
    t.string('decided_by', 26).nullable();
    t.bigInteger('decided_at').nullable();
    t.string('reason', 300).nullable();
    t.bigInteger('created_at').notNullable();
    t.index(['tenant_id', 'state']);
  });

  await knex.schema.createTable('email_verifications', (t) => {
    t.string('id', 64).primary(); // sha256 of the token
    t.string('tenant_id', 26).notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('user_id', 26).notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('email', 320).notNullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('expires_at').notNullable();
    t.bigInteger('used_at').nullable();
    t.index(['user_id']);
  });

  await knex.schema.createTable('invitations', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('workspace_id', 26).nullable().references('id').inTable('workspaces').onDelete('CASCADE');
    t.string('email', 320).notNullable();
    t.text('roles').notNullable(); // JSON array
    t.string('clearance', 20).notNullable();
    t.string('token_hash', 64).notNullable().unique();
    t.string('invited_by', 26).nullable();
    t.string('state', 20).notNullable(); // pending | accepted | revoked
    t.bigInteger('created_at').notNullable();
    t.bigInteger('expires_at').notNullable();
    t.string('accepted_by', 26).nullable();
    t.bigInteger('accepted_at').nullable();
    t.bigInteger('revoked_at').nullable();
    t.index(['tenant_id', 'state']);
    t.index(['tenant_id', 'email']);
  });

  await knex.schema.createTable('trusted_devices', (t) => {
    t.string('id', 64).primary(); // sha256(user id, device id)
    t.string('tenant_id', 26).notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('user_id', 26).notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('session_id', 64).nullable();
    t.string('browser', 100).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('expires_at').notNullable();
    t.index(['user_id']);
    t.index(['session_id']);
  });

  await knex.schema.createTable('user_imports', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('created_by', 26).nullable();
    t.string('actor', 100).nullable(); // `cli` for the command line
    t.boolean('dry_run').notNullable();
    t.boolean('send_invites').notNullable().defaultTo(false);
    t.string('state', 20).notNullable(); // queued | running | done | failed
    t.text('csv_sealed', 'mediumtext').notNullable();
    t.integer('rows').notNullable().defaultTo(0);
    t.text('summary').nullable(); // JSON
    t.text('report', 'mediumtext').nullable(); // JSON
    t.string('job_id', 26).nullable();
    t.string('error', 500).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('finished_at').nullable();
    t.index(['tenant_id', 'created_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['user_imports', 'trusted_devices', 'invitations', 'email_verifications', 'account_signups', 'identity_policies']) await knex.schema.dropTableIfExists(table);
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('email_verified_at');
  });
}
