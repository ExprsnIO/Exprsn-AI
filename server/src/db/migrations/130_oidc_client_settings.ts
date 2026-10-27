import type { Knex } from 'knex';

/*
 * 1.9.0, Sprint 55 (B-191): OAuth and OIDC provider settings per tenant and per client, and refresh-token families.
 *
 * - `oidc_client_settings`: `settings` (JSON, `clientSettingsSchema` and `tenantOauthSchema` in
 *   `federation/client-settings.ts`) for one client (`client_id`, the public client id) or, with `client_id` empty, the
 *   tenant's defaults: authorization code lifetime, PKCE for every client or only public ones, the consent screen,
 *   a rate limit, refresh-token rotation; and the access and refresh lifetimes new clients get. No row: today's values.
 * - `oidc_refresh_families`: one row per refresh-token family that ended for a reason worth keeping (a rotated token
 *   presented again, B-191 reuse detection): the family, client, user, when and why. The tokens themselves stay in
 *   `oidc_refresh_tokens`; consents stay in `oidc_consents`.
 *
 * Expand only. A build from before this migration ignores both tables.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('oidc_client_settings'))) {
    await knex.schema.createTable('oidc_client_settings', (t) => {
      t.string('tenant_id', 26).notNullable();
      t.string('client_id', 64).notNullable();
      t.text('settings').notNullable();
      t.string('updated_by', 26).nullable();
      t.bigInteger('updated_at').notNullable();
      t.primary(['tenant_id', 'client_id']);
    });
  }
  if (!(await knex.schema.hasTable('oidc_refresh_families'))) {
    await knex.schema.createTable('oidc_refresh_families', (t) => {
      t.string('family_id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('client_id', 64).notNullable();
      t.string('user_id', 26).notNullable();
      t.string('reason', 40).notNullable();
      t.integer('tokens_revoked').notNullable().defaultTo(0);
      t.bigInteger('revoked_at').notNullable();
      t.index(['tenant_id', 'revoked_at'], 'oidc_refresh_families_tenant');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const t of ['oidc_refresh_families', 'oidc_client_settings']) await knex.schema.dropTableIfExists(t);
}
