import type { Knex } from 'knex';

/*
 * 1.9.99-final, Sprint 56 (B-10002, B-10007 to B-10009): cloud accounts (`cloud/accounts.ts`).
 *
 * - `cloud_accounts`: one row per AWS, Azure, DigitalOcean or Cloudflare account. `scope` is `platform` (tenant_id
 *   null) or `tenant`; `scope_key` is the tenant id or `platform`, so a name is unique within its scope on every
 *   dialect. `provider_ids` is JSON (the provider's own account, tenant, subscription, team, account and zone ids);
 *   `validation` is the last validation's report (JSON, no secret). `state`: pending | active | attention | disabled.
 * - `cloud_account_regions`: the allow-list of regions per account, each with its zone, label ceiling and residency
 *   geography; `is_default` marks the default region.
 * - `cloud_credentials`: one per account, references only (B-10006): `params` (JSON: role ARN, client id) and `refs`
 *   (JSON: field to `vault:<path>#<key>`). Never a key, a secret or a token value.
 * - `cloud_account_proposals`: changes waiting for a second cloud admin (add, remove, credential mode, raising a
 *   region's ceiling, a tenant's residency). The payload holds references and settings, never a value. `account_id`
 *   has no foreign key: a decided proposal outlives its account.
 * - `cloud_residency`: per tenant, the residency geographies its `confidential` data may be placed in (B-10008,
 *   open decision 4).
 *
 * Expand only: five new tables. A build from before this migration ignores them; this build reports cloud accounts
 * as not installed while they are missing.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('cloud_accounts'))) {
    await knex.schema.createTable('cloud_accounts', (t) => {
      t.string('id', 26).primary();
      t.string('name', 63).notNullable();
      t.string('provider', 20).notNullable(); // aws | azure | digitalocean | cloudflare
      t.string('scope', 10).notNullable(); // platform | tenant
      t.string('tenant_id', 26).nullable();
      t.string('scope_key', 26).notNullable(); // tenant id, or 'platform'
      t.text('provider_ids').notNullable(); // JSON
      t.string('credential_mode', 10).notNullable(); // federated | vaulted
      t.string('default_region', 40).nullable();
      t.string('state', 12).notNullable(); // pending | active | attention | disabled
      t.string('description', 500).nullable();
      t.text('validation', 'mediumtext').nullable(); // JSON report, no secret
      t.bigInteger('validated_at').nullable();
      t.string('created_by', 26).nullable();
      t.string('created_tenant', 26).nullable(); // the tenant of the admin who added it (its audit chain)
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.unique(['scope_key', 'name']);
      t.index(['tenant_id']);
      t.index(['scope', 'state']);
    });
  }
  if (!(await knex.schema.hasTable('cloud_account_regions'))) {
    await knex.schema.createTable('cloud_account_regions', (t) => {
      t.string('account_id', 26).notNullable();
      t.string('region', 40).notNullable();
      t.string('zone', 63).notNullable();
      t.string('ceiling', 16).notNullable(); // public | internal | confidential | restricted
      t.string('geo', 10).notNullable(); // eu | us | ca | global
      t.boolean('is_default').notNullable().defaultTo(false);
      t.bigInteger('updated_at').notNullable();
      t.primary(['account_id', 'region']);
    });
  }
  if (!(await knex.schema.hasTable('cloud_credentials'))) {
    await knex.schema.createTable('cloud_credentials', (t) => {
      t.string('account_id', 26).primary();
      t.string('mode', 10).notNullable(); // federated | vaulted
      t.text('params').notNullable(); // JSON, not secret
      t.text('refs').notNullable(); // JSON: field -> vault: reference
      t.string('updated_by', 26).nullable();
      t.bigInteger('updated_at').notNullable();
    });
  }
  if (!(await knex.schema.hasTable('cloud_account_proposals'))) {
    await knex.schema.createTable('cloud_account_proposals', (t) => {
      t.string('id', 26).primary();
      t.string('kind', 24).notNullable(); // account.add | account.remove | account.credential | region.ceiling | residency
      t.string('account_id', 26).nullable();
      t.string('scope', 10).notNullable();
      t.string('tenant_id', 26).nullable();
      t.string('scope_key', 26).notNullable();
      t.string('summary', 1000).notNullable();
      t.text('payload', 'mediumtext').notNullable(); // JSON; references and settings only
      t.boolean('needs_platform').notNullable().defaultTo(false);
      t.string('state', 12).notNullable(); // pending | approved | rejected | withdrawn | superseded
      t.string('proposed_by', 26).notNullable();
      t.string('proposed_tenant', 26).notNullable();
      t.bigInteger('proposed_at').notNullable();
      t.string('decided_by', 26).nullable();
      t.bigInteger('decided_at').nullable();
      t.string('note', 500).nullable();
      t.index(['scope_key', 'state']);
      t.index(['account_id', 'state']);
    });
  }
  if (!(await knex.schema.hasTable('cloud_residency'))) {
    await knex.schema.createTable('cloud_residency', (t) => {
      t.string('tenant_id', 26).primary();
      t.string('geos', 200).notNullable(); // JSON array: eu | us | ca
      t.string('updated_by', 26).nullable();
      t.bigInteger('updated_at').notNullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('cloud_residency');
  await knex.schema.dropTableIfExists('cloud_account_proposals');
  await knex.schema.dropTableIfExists('cloud_credentials');
  await knex.schema.dropTableIfExists('cloud_account_regions');
  await knex.schema.dropTableIfExists('cloud_accounts');
}
