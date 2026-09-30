import type { Knex } from 'knex';

/*
 * Sprint 9: federation. The OIDC provider (signing keys, clients, codes, refresh-token families, consents, device
 * codes), the SAML IdP (service providers), short-lived pending protocol state, and per-tenant settings.
 * Upstream OIDC and SAML providers are rows in identity_providers (kinds `oidc` and `saml`).
 * Codes, tokens and device codes are stored as HMAC digests; private keys are sealed with the platform data key.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('federation_keys', (t) => {
    t.string('kid', 40).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('use', 10).notNullable(); // oidc (ES256) | saml (RS256 with a self-signed certificate)
    t.string('alg', 10).notNullable();
    t.string('state', 20).notNullable(); // next | signing | retired
    t.text('public_jwk').notNullable();
    t.text('private_sealed').notNullable();
    t.text('certificate').nullable(); // base64 DER, SAML keys only
    t.bigInteger('created_at').notNullable();
    t.bigInteger('activates_at').notNullable(); // starts signing
    t.bigInteger('retires_at').nullable(); // stops signing
    t.bigInteger('removes_at').nullable(); // leaves the JWKS
    t.index(['tenant_id', 'use']);
  });

  await knex.schema.createTable('oidc_clients', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('client_id', 64).notNullable().unique();
    t.string('name', 100).notNullable();
    t.string('type', 20).notNullable(); // first_party | public | service | third_party
    t.text('redirect_uris').notNullable(); // JSON
    t.text('grants').notNullable(); // JSON
    t.text('scopes').notNullable(); // JSON, allowed scopes
    t.boolean('pkce_required').notNullable().defaultTo(true);
    t.string('secret_hash', 64).nullable();
    t.bigInteger('secret_created_at').nullable();
    t.integer('access_ttl').notNullable().defaultTo(600);
    t.integer('refresh_ttl').notNullable().defaultTo(8 * 3600);
    t.string('models', 500).nullable();
    t.string('service_user_id', 26).nullable();
    t.string('status', 20).notNullable().defaultTo('active'); // active | disabled
    t.string('created_by', 26).nullable();
    t.bigInteger('last_used_at').nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'name']);
  });

  await knex.schema.createTable('oidc_codes', (t) => {
    t.string('id', 64).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('client_id', 64).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('session_id', 64).nullable();
    t.string('redirect_uri', 2000).notNullable();
    t.string('scopes', 2000).notNullable();
    t.string('nonce', 500).nullable();
    t.string('code_challenge', 128).nullable();
    t.string('amr', 200).notNullable();
    t.bigInteger('auth_time').notNullable();
    t.bigInteger('expires_at').notNullable();
    t.bigInteger('used_at').nullable();
    t.string('family_id', 26).nullable(); // refresh family minted from this code (revoked on code replay)
  });

  await knex.schema.createTable('oidc_refresh_tokens', (t) => {
    t.string('id', 64).primary();
    t.string('family_id', 26).notNullable();
    t.string('tenant_id', 26).notNullable();
    t.string('client_id', 64).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('session_id', 64).nullable();
    t.string('scopes', 2000).notNullable();
    t.string('amr', 200).notNullable();
    t.string('method', 100).notNullable();
    t.bigInteger('auth_time').notNullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('family_created_at').notNullable();
    t.bigInteger('expires_at').notNullable();
    t.bigInteger('used_at').nullable();
    t.bigInteger('revoked_at').nullable();
    t.index(['family_id']);
    t.index(['tenant_id', 'client_id']);
  });

  await knex.schema.createTable('oidc_consents', (t) => {
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('client_id', 64).notNullable();
    t.string('scopes', 2000).notNullable();
    t.bigInteger('granted_at').notNullable();
    t.bigInteger('expires_at').nullable();
    t.primary(['user_id', 'client_id']);
    t.index(['tenant_id', 'client_id']);
  });

  await knex.schema.createTable('oidc_device_codes', (t) => {
    t.string('id', 64).primary(); // digest of the device code
    t.string('user_code', 16).notNullable().unique();
    t.string('tenant_id', 26).notNullable();
    t.string('client_id', 64).notNullable();
    t.string('scopes', 2000).notNullable();
    t.string('status', 20).notNullable(); // pending | approved | denied | used
    t.string('user_id', 26).nullable();
    t.string('session_id', 64).nullable();
    t.string('amr', 200).nullable();
    t.integer('interval').notNullable();
    t.bigInteger('last_polled_at').nullable();
    t.bigInteger('expires_at').notNullable();
    t.bigInteger('created_at').notNullable();
  });

  await knex.schema.createTable('saml_service_providers', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('name', 100).notNullable();
    t.string('entity_id', 1000).notNullable();
    t.text('acs_urls').notNullable(); // JSON [{ url, index, binding }]
    t.string('nameid_format', 40).notNullable(); // emailAddress | persistent | unspecified | transient
    t.text('certificate').nullable(); // base64 DER of the SP signing certificate
    t.boolean('signed_requests').notNullable().defaultTo(false);
    t.text('attribute_map').notNullable(); // JSON { claim: attribute name }
    t.string('status', 20).notNullable().defaultTo('active');
    t.bigInteger('last_used_at').nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'name']);
    t.index(['tenant_id']);
  });

  await knex.schema.createTable('federation_pending', (t) => {
    t.string('id', 64).primary(); // digest of the handle given to the browser
    t.string('tenant_id', 26).notNullable();
    t.string('kind', 20).notNullable(); // saml_authn | upstream
    t.text('data').notNullable(); // JSON
    t.bigInteger('expires_at').notNullable();
    t.index(['expires_at']);
  });

  await knex.schema.createTable('federation_settings', (t) => {
    t.string('tenant_id', 26).primary();
    t.text('settings').notNullable(); // JSON
    t.bigInteger('updated_at').notNullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const t of ['federation_settings', 'federation_pending', 'saml_service_providers', 'oidc_device_codes', 'oidc_consents', 'oidc_refresh_tokens', 'oidc_codes', 'oidc_clients', 'federation_keys']) {
    await knex.schema.dropTableIfExists(t);
  }
}
