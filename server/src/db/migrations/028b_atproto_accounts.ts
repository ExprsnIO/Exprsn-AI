import type { Knex } from 'knex';

/*
 * Sprint 26 (1.4.0), AT-Protocol accounts (028b): a user's own DID, bound by a proof-of-control challenge or by
 * signing in at the DID's PDS, and the handle resolved for it (B-1807). One DID per user per tenant; a DID is bound
 * to at most one user of a tenant once verified (`verified_did` is null until then, so unfinished claims never
 * collide). The challenge is stored as a SHA-256 only. AT-Protocol sign-in (B-1808) keeps its short-lived state in
 * `federation_pending` and needs no table of its own. Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('atproto_user_dids', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('did', 300).notNullable(); // the DID claimed
    t.string('verified_did', 300).nullable(); // = did once control is proven
    t.string('proof', 20).nullable(); // well-known | profile | oauth
    t.string('challenge_hash', 64).nullable();
    t.bigInteger('challenge_expires_at').nullable();
    t.string('pds', 500).nullable(); // the #atproto_pds endpoint from the DID document
    t.string('handle', 253).nullable(); // a handle that resolved to this DID both ways
    t.bigInteger('handle_checked_at').nullable();
    t.bigInteger('verified_at').nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'user_id']);
    t.unique(['tenant_id', 'verified_did']);
    t.index(['tenant_id', 'did']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('atproto_user_dids');
}
