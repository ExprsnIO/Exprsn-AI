import type { Knex } from 'knex';

/*
 * 1.6.0, Sprint 37c.
 *
 * B-7201, B-7202 SCIM 2.0 provisioning. A SCIM store is a user store (`identity_providers.kind = 'scim'`) in the
 * tenant's chain; an identity provider (Entra ID, Okta) pushes users and groups to it through `/scim/v2`.
 * - `scim_tokens`: bearer tokens for one SCIM store (`exai_scim1_<prefix>_<secret>`): the prefix in clear to find the
 *   row and show it, an HMAC of the whole token, an optional expiry, revocation.
 * - `scim_users`: the SCIM view of a provisioned user: the resource id is the user's id, `user_name` as the provider
 *   sent it (the user row keeps it lower case), `external_id`, `active`, the other attributes as JSON, and the
 *   version counter for `meta.version`. The user's link to the store is the usual `user_identities` row (external id =
 *   the user id), whose `groups` are the store's group names the user is a member of, so group mappings apply.
 * - `scim_groups`, `scim_group_members`: groups and their members as the provider sent them; a group's display name
 *   (normalised) is the group name the tenant's group mappings name, with the SCIM store as their provider.
 *
 * B-4801 vault sharing: a share is a vault policy grant (`vault_policies`) of `read` on one KV path to one subject.
 * - `vault_policies.share_secret_id`: the secret a grant shares (null for ordinary grants); `expires_at`: when the
 *   grant stops applying (null: never); the sweep removes expired shares.
 *
 * B-4802 MongoDB leases need no schema: `vault_db_engines.dialect` takes `mongodb`, `database` is the authentication
 * database and `vault_db_roles.schemas` the databases a role's users get `read` or `readWrite` on.
 *
 * B-4901 quote posts and per-post visibility:
 * - `feed_posts.quote_of`: the post this one quotes (with a comment of its own, in any feed the author may post in);
 *   `visibility`: `public`, `workspace` (the default, every existing post) or `unlisted` (reachable by its link, absent
 *   from every feed).
 * Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('scim_tokens', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('provider_id', 26).notNullable();
    t.string('name', 100).notNullable();
    t.string('prefix', 12).notNullable().unique();
    t.string('token_hash', 128).notNullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('expires_at').nullable();
    t.bigInteger('last_used_at').nullable();
    t.string('last_used_ip', 64).nullable();
    t.bigInteger('revoked_at').nullable();
    t.string('revoked_by', 26).nullable();
    t.index(['tenant_id', 'provider_id']);
  });

  await knex.schema.createTable('scim_users', (t) => {
    t.string('user_id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('provider_id', 26).notNullable();
    t.string('user_name', 255).notNullable();
    t.string('user_name_lc', 255).notNullable();
    t.string('external_id', 255).nullable();
    t.boolean('active').notNullable().defaultTo(true);
    t.text('attributes', 'mediumtext').notNullable(); // JSON: name, displayName, emails, title, …
    t.integer('version').notNullable().defaultTo(1);
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['provider_id', 'user_name_lc'], { indexName: 'scim_users_provider_name_uq' });
    t.index(['provider_id', 'external_id'], 'scim_users_provider_ext_idx');
    t.index(['tenant_id']);
  });

  await knex.schema.createTable('scim_groups', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('provider_id', 26).notNullable();
    t.string('display_name', 255).notNullable();
    t.string('display_name_lc', 255).notNullable();
    t.string('external_id', 255).nullable();
    t.integer('version').notNullable().defaultTo(1);
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['provider_id', 'display_name_lc'], { indexName: 'scim_groups_provider_name_uq' });
    t.index(['provider_id', 'external_id'], 'scim_groups_provider_ext_idx');
  });

  await knex.schema.createTable('scim_group_members', (t) => {
    t.string('group_id', 26).notNullable().references('id').inTable('scim_groups').onDelete('CASCADE');
    t.string('user_id', 26).notNullable();
    t.string('tenant_id', 26).notNullable();
    t.primary(['group_id', 'user_id']);
    t.index(['user_id'], 'scim_group_members_user_idx');
  });

  await knex.schema.alterTable('vault_policies', (t) => {
    t.string('share_secret_id', 26).nullable();
    t.bigInteger('expires_at').nullable();
    t.index(['tenant_id', 'share_secret_id'], 'vault_policies_share_idx');
  });

  await knex.schema.alterTable('feed_posts', (t) => {
    t.string('visibility', 12).notNullable().defaultTo('workspace');
    t.string('quote_of', 26).nullable();
    t.index(['tenant_id', 'quote_of'], 'feed_posts_quote_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('feed_posts', (t) => {
    t.dropIndex(['tenant_id', 'quote_of'], 'feed_posts_quote_idx');
    t.dropColumn('quote_of');
    t.dropColumn('visibility');
  });
  await knex.schema.alterTable('vault_policies', (t) => {
    t.dropIndex(['tenant_id', 'share_secret_id'], 'vault_policies_share_idx');
    t.dropColumn('expires_at');
    t.dropColumn('share_secret_id');
  });
  for (const table of ['scim_group_members', 'scim_groups', 'scim_users', 'scim_tokens']) await knex.schema.dropTableIfExists(table);
}
