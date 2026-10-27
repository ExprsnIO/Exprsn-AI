import type { Knex } from 'knex';

/*
 * Sprint 15: operations. Dual control for import signer keys (a proposal to add or revoke one waits for a second
 * platform admin), and OpenBao dynamic credentials for data connections (the credential source and the role).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('platform_signer_proposals', (t) => {
    t.string('id', 26).primary();
    t.string('action', 10).notNullable(); // add | revoke
    t.string('key_id', 26).nullable(); // the key to revoke, or the key created on approval
    t.string('name', 100).notNullable();
    t.string('algorithm', 30).nullable();
    t.string('fingerprint', 64).nullable();
    t.text('public_key_pem').nullable();
    t.string('reason', 500).nullable();
    t.string('state', 20).notNullable(); // pending | approved | rejected | withdrawn
    t.string('proposed_by', 26).nullable();
    t.string('proposed_tenant', 26).notNullable();
    t.bigInteger('proposed_at').notNullable();
    t.string('decided_by', 26).nullable();
    t.bigInteger('decided_at').nullable();
    t.string('note', 500).nullable();
    t.index(['state']);
  });

  await knex.schema.alterTable('data_connections', (t) => {
    t.string('credential_source', 20).notNullable().defaultTo('static'); // static | openbao
    t.string('bao_role', 200).nullable(); // the OpenBao database role: GET <mount>/creds/<role>
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('data_connections', (t) => {
    t.dropColumn('bao_role');
    t.dropColumn('credential_source');
  });
  await knex.schema.dropTableIfExists('platform_signer_proposals');
}
