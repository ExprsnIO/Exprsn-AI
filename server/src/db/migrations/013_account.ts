import type { Knex } from 'knex';

/*
 * Sprint 11: account self-service. Local passwords can be marked for a forced change, sessions record when their
 * owner last proved who they are (password or second factor, for step-up), users keep their appearance preferences,
 * and password reset and invite links are stored as SHA-256 digests (the token itself is never stored). A small
 * counter table throttles reset requests per client address, per identifier and per account.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('local_credentials', (t) => {
    t.boolean('must_change').notNullable().defaultTo(false);
  });

  await knex.schema.alterTable('sessions', (t) => {
    t.bigInteger('auth_at').nullable(); // last password or factor check; null means created_at
  });

  await knex.schema.alterTable('users', (t) => {
    t.text('preferences').nullable(); // JSON: { a11y }
  });

  await knex.schema.createTable('password_tokens', (t) => {
    t.string('id', 64).primary(); // sha256(token), hex
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('kind', 20).notNullable(); // reset | admin | invite
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('expires_at').notNullable();
    t.bigInteger('used_at').nullable();
    t.index(['user_id']);
  });

  await knex.schema.createTable('account_throttle', (t) => {
    t.string('key', 255).primary();
    t.integer('count').notNullable();
    t.bigInteger('window_start').notNullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('account_throttle');
  await knex.schema.dropTableIfExists('password_tokens');
  await knex.schema.alterTable('users', (t) => t.dropColumn('preferences'));
  await knex.schema.alterTable('sessions', (t) => t.dropColumn('auth_at'));
  await knex.schema.alterTable('local_credentials', (t) => t.dropColumn('must_change'));
}
