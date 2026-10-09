import type { Knex } from 'knex';

/*
 * 1.6.0, Sprint 39d.
 *
 * B-8601 entity APIs with scoped keys.
 * - `api_keys.app_scope`: JSON `{app, entity}` (ids; entity null for the whole app). A key with a scope is accepted only
 *   under `/api/apps/<that app>` and, with an entity, only on that entity's records; its scopes are at most
 *   `records:read` and `records:write`. Nullable, so nothing changes for existing keys.
 *
 * B-8602 schema versions.
 * - `app_schema_versions`: one row per change to an app's design (an entity created, replaced or deleted, a field added,
 *   changed or removed, a state machine set, a form created, replaced or deleted), whichever route made it, with the
 *   version number, what changed and a hash of the whole design after the change; the app package reads the current
 *   version and hash.
 *
 * B-8701, B-8702 app embedding.
 * - `app_embeds`: an app's embed settings: public pages on or off, the host sites allowed to frame them, signed
 *   embeds on or off with the claim that maps a token to a user, the longest session, whether embedded sessions may
 *   write and which entities they reach.
 * - `app_embed_keys`: the keys host sites sign embed tokens with: a public key (ES256, RS256, EdDSA), a shared secret
 *   (HS256, sealed with the tenant key) or the tenant CA (the token carries its certificate chain).
 * - `app_embed_pages`: a public form published as an embed page under a random id (the form's link token stays private).
 * - `app_embed_sessions`: embedded sessions, apart from console sessions: the token's hash, the key and `jti` that
 *   made it (each `jti` once per key), the host, and an expiry of its own.
 * Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('api_keys', (t) => {
    t.text('app_scope').nullable(); // JSON {app, entity}
  });

  await knex.schema.createTable('app_schema_versions', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('app_id', 26).notNullable();
    t.integer('version').notNullable();
    t.string('kind', 40).notNullable(); // entity.created | entity.updated | entity.deleted | field.added | field.updated | field.removed | states.set | form.created | form.updated | form.deleted
    t.string('target', 63).notNullable(); // the entity or form name
    t.string('summary', 300).notNullable();
    t.text('change', 'mediumtext').nullable(); // JSON: what was applied
    t.string('hash', 64).notNullable(); // sha256 of the design after the change
    t.string('created_by', 26).nullable();
    t.string('source', 20).notNullable().defaultTo('api'); // api | schema-api | package
    t.bigInteger('created_at').notNullable();
    t.unique(['app_id', 'version'], 'app_schema_versions_app_version_unique');
  });

  await knex.schema.createTable('app_embeds', (t) => {
    t.string('app_id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.boolean('public_enabled').notNullable().defaultTo(false);
    t.text('allowed_hosts').notNullable(); // JSON: ["https://example.com"]
    t.boolean('signed_enabled').notNullable().defaultTo(false);
    t.string('claim_name', 60).notNullable().defaultTo('sub');
    t.string('claim_match', 20).notNullable().defaultTo('username'); // username | email | id
    t.integer('max_ttl_seconds').notNullable().defaultTo(900);
    t.boolean('write').notNullable().defaultTo(false);
    t.text('entities').nullable(); // JSON: entity names embedded sessions reach; null: every entity
    t.string('updated_by', 26).nullable();
    t.bigInteger('updated_at').notNullable();
  });

  await knex.schema.createTable('app_embed_keys', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('app_id', 26).notNullable();
    t.string('kid', 100).notNullable();
    t.string('alg', 12).notNullable(); // ES256 | RS256 | HS256 | EdDSA | x5c
    t.text('public_key_pem').nullable();
    t.text('secret').nullable(); // HS256: sealed with the tenant key
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('revoked_at').nullable();
    t.unique(['app_id', 'kid'], 'app_embed_keys_app_kid_unique');
  });

  await knex.schema.createTable('app_embed_pages', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('app_id', 26).notNullable();
    t.string('form_id', 26).notNullable();
    t.boolean('enabled').notNullable().defaultTo(true);
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.index(['form_id'], 'app_embed_pages_form_idx');
  });

  await knex.schema.createTable('app_embed_sessions', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('app_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('key_id', 26).notNullable();
    t.string('jti', 200).notNullable();
    t.string('token_hash', 64).notNullable().unique();
    t.string('host', 300).nullable();
    t.string('ip', 64).nullable();
    t.bigInteger('expires_at').notNullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('last_seen_at').notNullable();
    t.bigInteger('revoked_at').nullable();
    t.unique(['key_id', 'jti'], 'app_embed_sessions_key_jti_unique');
    t.index(['app_id', 'user_id'], 'app_embed_sessions_app_user_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('app_embed_sessions');
  await knex.schema.dropTableIfExists('app_embed_pages');
  await knex.schema.dropTableIfExists('app_embed_keys');
  await knex.schema.dropTableIfExists('app_embeds');
  await knex.schema.dropTableIfExists('app_schema_versions');
  await knex.schema.alterTable('api_keys', (t) => {
    t.dropColumn('app_scope');
  });
}
