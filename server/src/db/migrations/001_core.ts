import type { Knex } from 'knex';

/*
 * Core identity, access and audit tables. Written against the Knex schema builder only, so it runs
 * unchanged on PostgreSQL, MySQL 8 and SQLite. Conventions:
 *   - ids are ULIDs (varchar 26); session and key ids are SHA-256/HMAC hex digests (varchar 64)
 *   - timestamps are epoch milliseconds (bigint)
 *   - structured values are JSON text
 *   - every tenant-owned row carries tenant_id; the repository layer scopes every query by it
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('tenants', (t) => {
    t.string('id', 26).primary();
    t.string('slug', 63).notNullable().unique();
    t.string('name', 200).notNullable();
    t.string('directory_dn', 512).nullable();
    t.string('state', 20).notNullable().defaultTo('active'); // active | offboarding | disabled
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });

  await knex.schema.createTable('workspaces', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('name', 200).notNullable();
    t.string('label_ceiling', 20).notNullable().defaultTo('internal');
    t.bigInteger('created_at').notNullable();
    t.unique(['tenant_id', 'name']);
  });

  await knex.schema.createTable('identity_providers', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('name', 100).notNullable();
    t.string('kind', 20).notNullable(); // local | ldap | sql
    t.integer('position').notNullable().defaultTo(100);
    t.boolean('enabled').notNullable().defaultTo(true);
    t.text('config').notNullable(); // JSON; secrets are references (env:/file:), never values
    t.string('managed_by', 20).notNullable().defaultTo('api'); // api | config
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'name']);
    t.index(['tenant_id', 'position']);
  });

  await knex.schema.createTable('users', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('username', 190).notNullable();
    t.string('display_name', 200).notNullable();
    t.string('email', 320).nullable();
    t.string('state', 20).notNullable().defaultTo('active'); // active | disabled
    t.string('disabled_reason', 200).nullable();
    t.string('clearance', 20).notNullable().defaultTo('internal'); // effective, recomputed at sign-in
    t.string('clearance_direct', 20).nullable(); // set by an admin; raises the mapped clearance
    t.boolean('mfa_required').notNullable().defaultTo(false);
    t.bigInteger('last_login_at').nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'username']);
  });

  await knex.schema.createTable('user_identities', (t) => {
    t.string('id', 26).primary();
    t.string('user_id', 26).notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('provider_id', 26).notNullable().references('id').inTable('identity_providers').onDelete('CASCADE');
    t.string('external_id', 512).notNullable();
    t.text('groups').notNullable(); // JSON array from the last sign-in / sync
    t.bigInteger('last_seen_at').notNullable();
    t.unique(['provider_id', 'external_id']);
    t.index(['user_id']);
  });

  await knex.schema.createTable('local_credentials', (t) => {
    t.string('user_id', 26).primary().references('id').inTable('users').onDelete('CASCADE');
    t.string('password_hash', 255).notNullable();
    t.bigInteger('updated_at').notNullable();
  });

  await knex.schema.createTable('group_mappings', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('provider_id', 26).nullable().references('id').inTable('identity_providers').onDelete('CASCADE');
    t.string('group_name', 512).notNullable(); // normalised to lower case
    t.string('role', 40).notNullable();
    t.string('clearance', 20).notNullable();
    t.bigInteger('created_at').notNullable();
    t.index(['tenant_id']);
  });

  await knex.schema.createTable('user_roles', (t) => {
    t.string('user_id', 26).notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('role', 40).notNullable();
    t.string('source', 20).notNullable(); // mapping | direct
    t.bigInteger('created_at').notNullable();
    t.primary(['user_id', 'role', 'source']);
  });

  await knex.schema.createTable('sessions', (t) => {
    t.string('id', 64).primary(); // HMAC of the cookie token; the token itself is never stored
    t.string('user_id', 26).notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('tenant_id', 26).notNullable();
    t.string('stage', 20).notNullable(); // mfa | enroll | active
    t.string('method', 100).notNullable();
    t.string('provider_id', 26).nullable();
    t.string('ip', 64).nullable();
    t.string('user_agent', 300).nullable();
    t.text('challenge').nullable(); // pending WebAuthn challenge
    t.bigInteger('challenge_expires_at').nullable();
    t.bigInteger('mfa_verified_at').nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('last_seen_at').notNullable();
    t.bigInteger('expires_at').notNullable();
    t.bigInteger('revoked_at').nullable();
    t.index(['user_id']);
    t.index(['tenant_id']);
  });

  await knex.schema.createTable('api_keys', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('name', 100).notNullable();
    t.string('prefix', 32).notNullable().unique();
    t.string('secret_hash', 64).notNullable();
    t.text('scopes').notNullable(); // JSON array
    t.bigInteger('expires_at').notNullable();
    t.bigInteger('last_used_at').nullable();
    t.bigInteger('revoked_at').nullable();
    t.bigInteger('created_at').notNullable();
    t.index(['user_id']);
  });

  await knex.schema.createTable('mfa_factors', (t) => {
    t.string('id', 26).primary();
    t.string('user_id', 26).notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('kind', 20).notNullable(); // totp | webauthn
    t.string('label', 100).notNullable();
    t.text('secret').nullable(); // TOTP seed, AES-256-GCM sealed
    t.string('credential_id', 512).nullable();
    t.text('public_key').nullable(); // base64url COSE key
    t.bigInteger('counter').nullable();
    t.text('transports').nullable(); // JSON array
    t.bigInteger('confirmed_at').nullable();
    t.bigInteger('last_used_at').nullable();
    t.bigInteger('last_step').nullable(); // last accepted TOTP time step (replay protection)
    t.bigInteger('created_at').notNullable();
    t.index(['user_id']);
  });

  await knex.schema.createTable('mfa_recovery_codes', (t) => {
    t.string('id', 26).primary();
    t.string('user_id', 26).notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('code_hash', 64).notNullable();
    t.bigInteger('used_at').nullable();
    t.bigInteger('created_at').notNullable();
    t.index(['user_id']);
  });

  await knex.schema.createTable('login_throttle', (t) => {
    t.string('key', 255).primary(); // "u:<tenant>:<username>" or "ip:<address>"
    t.integer('failures').notNullable();
    t.bigInteger('window_start').notNullable();
    t.bigInteger('locked_until').nullable();
  });

  await knex.schema.createTable('audit_events', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable(); // "platform" for events outside any tenant
    t.bigInteger('seq').notNullable();
    t.bigInteger('ts').notNullable();
    t.string('action', 100).notNullable();
    t.string('kind', 20).notNullable(); // decision | admin | correction | system | auth
    t.text('actor').notNullable();
    t.text('target').notNullable();
    t.string('label', 20).notNullable();
    t.text('decision').nullable();
    t.text('detail').nullable();
    t.string('trace_id', 32).nullable();
    t.string('corrects', 26).nullable();
    t.string('prev_hash', 64).notNullable();
    t.string('hash', 64).notNullable();
    t.unique(['tenant_id', 'seq']);
    t.index(['tenant_id', 'ts']);
    t.index(['tenant_id', 'action']);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const table of [
    'audit_events', 'login_throttle', 'mfa_recovery_codes', 'mfa_factors', 'api_keys', 'sessions',
    'user_roles', 'group_mappings', 'local_credentials', 'user_identities', 'users', 'identity_providers',
    'workspaces', 'tenants'
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
}
