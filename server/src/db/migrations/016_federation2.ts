import type { Knex } from 'knex';

/*
 * Sprint 14: federation, second part. Logout (RP-initiated, front- and back-channel), request objects, DPoP and
 * per-token revocation on the OIDC side; single logout and encrypted assertions on the SAML side.
 *
 *   - oidc_clients: post-logout redirect URIs, front- and back-channel logout URIs, the client's public key set (for
 *     signed request objects) and two per-client requirements (pushed requests, DPoP).
 *   - oidc_refresh_tokens.dpop_jkt: a refresh token issued with a DPoP proof only refreshes with the same key.
 *   - oidc_denied: the access-token deny-list (by jti) and per-user-and-client revocations, each kept until the
 *     longest-lived token it could refuse has expired.
 *   - oidc_rp_sessions: which clients a sign-in session issued codes to, with the `sid` their ID tokens carry, so
 *     sign-out reaches them.
 *   - oauth_replay: single-use ids (DPoP proof jti, request object jti), kept until they could no longer be accepted.
 *   - saml_service_providers: single logout URL and binding, the SP's encryption certificate and whether assertions to
 *     it are encrypted.
 *   - saml_sessions: SAML sessions on both sides (this server as IdP to an SP, and as SP to an upstream IdP), by the
 *     console session they belong to, for single logout.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('oidc_clients', (t) => {
    t.text('post_logout_redirect_uris').nullable(); // JSON
    t.string('frontchannel_logout_uri', 2000).nullable();
    t.string('backchannel_logout_uri', 2000).nullable();
    t.text('jwks').nullable(); // JSON { keys: [...] }, public keys only
    t.boolean('par_required').notNullable().defaultTo(false);
    t.boolean('dpop_required').notNullable().defaultTo(false);
  });

  await knex.schema.alterTable('oidc_refresh_tokens', (t) => {
    t.string('dpop_jkt', 64).nullable();
  });

  await knex.schema.createTable('oidc_denied', (t) => {
    t.string('id', 120).primary(); // jti:<jti> | grant:<user>:<client>
    t.string('tenant_id', 26).notNullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('expires_at').notNullable();
    t.index(['expires_at']);
  });

  await knex.schema.createTable('oidc_rp_sessions', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('session_id', 64).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('client_id', 64).notNullable();
    t.string('sid', 64).notNullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('ended_at').nullable();
    t.unique(['session_id', 'client_id']);
    t.index(['tenant_id', 'user_id']);
  });

  await knex.schema.createTable('oauth_replay', (t) => {
    t.string('id', 64).primary(); // digest of kind + value
    t.bigInteger('expires_at').notNullable();
    t.index(['expires_at']);
  });

  await knex.schema.alterTable('saml_service_providers', (t) => {
    t.string('slo_url', 2000).nullable();
    t.string('slo_binding', 10).nullable(); // redirect | post
    t.text('encryption_certificate').nullable(); // base64 DER
    t.boolean('encrypt_assertions').notNullable().defaultTo(false);
  });

  await knex.schema.createTable('saml_sessions', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('session_id', 64).notNullable();
    t.string('role', 4).notNullable(); // idp (we asserted to an SP) | sp (an upstream IdP asserted to us)
    t.string('peer_id', 26).notNullable(); // saml_service_providers.id or identity_providers.id
    t.string('name_id', 500).notNullable();
    t.string('name_id_format', 200).nullable();
    t.string('session_index', 200).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('ended_at').nullable();
    t.index(['session_id']);
    t.index(['tenant_id', 'peer_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('saml_sessions');
  await knex.schema.alterTable('saml_service_providers', (t) => {
    t.dropColumn('encrypt_assertions');
    t.dropColumn('encryption_certificate');
    t.dropColumn('slo_binding');
    t.dropColumn('slo_url');
  });
  await knex.schema.dropTableIfExists('oauth_replay');
  await knex.schema.dropTableIfExists('oidc_rp_sessions');
  await knex.schema.dropTableIfExists('oidc_denied');
  await knex.schema.alterTable('oidc_refresh_tokens', (t) => {
    t.dropColumn('dpop_jkt');
  });
  await knex.schema.alterTable('oidc_clients', (t) => {
    t.dropColumn('dpop_required');
    t.dropColumn('par_required');
    t.dropColumn('jwks');
    t.dropColumn('backchannel_logout_uri');
    t.dropColumn('frontchannel_logout_uri');
    t.dropColumn('post_logout_redirect_uris');
  });
}
