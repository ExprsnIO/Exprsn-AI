import type { Knex } from 'knex';

/*
 * Sprint 17: identity and security, third part. The devices and networks a user has signed in from (new sign-in
 * notices), per-client introspection rights for resource servers, SAML whole-response signing, fetched SAML metadata
 * with its refresh state, and the federation proposals that wait for a second identity admin (or, for a fetched
 * certificate change, for any identity admin's approval).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('signin_history', (t) => {
    t.string('id', 64).primary(); // sha256 of user, kind and value
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('kind', 10).notNullable(); // device | network
    t.bigInteger('first_seen_at').notNullable();
    t.bigInteger('last_seen_at').notNullable();
    t.index(['user_id']);
    t.index(['last_seen_at']);
  });

  await knex.schema.alterTable('oidc_clients', (t) => {
    t.string('introspect', 10).notNullable().defaultTo('own'); // own | any
  });

  await knex.schema.alterTable('saml_service_providers', (t) => {
    t.boolean('sign_response').notNullable().defaultTo(false);
  });

  await knex.schema.createTable('federation_metadata', (t) => {
    t.string('id', 26).primary(); // the SAML service provider's or upstream provider's id
    t.string('tenant_id', 26).notNullable();
    t.string('kind', 10).notNullable(); // sp | idp
    t.string('url', 2000).notNullable();
    t.string('digest', 64).nullable(); // sha256 of the security-relevant fields last applied
    t.bigInteger('fetched_at').nullable();
    t.string('error', 500).nullable();
    t.bigInteger('created_at').notNullable();
    t.index(['tenant_id']);
  });

  await knex.schema.createTable('federation_proposals', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('kind', 30).notNullable(); // client.introspect | metadata.sp | metadata.idp
    t.string('target_id', 26).notNullable();
    t.string('name', 200).notNullable();
    t.text('payload', 'mediumtext').notNullable(); // JSON: the change to apply
    t.string('summary', 1000).nullable();
    t.string('state', 20).notNullable(); // pending | approved | rejected | withdrawn | superseded
    t.string('proposed_by', 26).nullable(); // null: proposed by the metadata refresh
    t.bigInteger('proposed_at').notNullable();
    t.string('decided_by', 26).nullable();
    t.bigInteger('decided_at').nullable();
    t.string('note', 500).nullable();
    t.index(['tenant_id', 'state']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('federation_proposals');
  await knex.schema.dropTableIfExists('federation_metadata');
  await knex.schema.alterTable('saml_service_providers', (t) => t.dropColumn('sign_response'));
  await knex.schema.alterTable('oidc_clients', (t) => t.dropColumn('introspect'));
  await knex.schema.dropTableIfExists('signin_history');
}
