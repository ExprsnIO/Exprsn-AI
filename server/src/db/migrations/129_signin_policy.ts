import type { Knex } from 'knex';

/*
 * 1.9.0, Sprint 55 (B-190): the tenant sign-in policy, and password history.
 *
 * - `signin_policies`: one row per tenant: `policy` (JSON, `signinPolicySchema` in `identity/signin-policy.ts`), only
 *   the values the tenant set (anything left out is the platform's: its floor of 12, the SESSION_*, STEPUP_* and
 *   LOCKOUT_* settings, or the defaults); who changed it and when. No row: today's behaviour.
 * - `password_history`: argon2id hashes of a local account's earlier passwords (never anything else), kept only while
 *   the tenant's policy keeps a history, newest first and at most the policy's count; compared by verifying.
 *
 * Expand only. A build from before this migration ignores both tables.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('signin_policies'))) {
    await knex.schema.createTable('signin_policies', (t) => {
      t.string('tenant_id', 26).primary();
      t.text('policy').notNullable();
      t.string('updated_by', 26).nullable();
      t.bigInteger('updated_at').notNullable();
    });
  }
  if (!(await knex.schema.hasTable('password_history'))) {
    await knex.schema.createTable('password_history', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('user_id', 26).notNullable();
      t.string('password_hash', 255).notNullable();
      t.bigInteger('created_at').notNullable();
      t.index(['user_id', 'created_at'], 'password_history_user');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const t of ['password_history', 'signin_policies']) await knex.schema.dropTableIfExists(t);
}
