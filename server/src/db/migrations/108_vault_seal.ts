import type { Knex } from 'knex';

/*
 * 1.8.0, Sprint 48 (B-145): the emergency vault seal (`vault/seal.ts`).
 *
 * - `vault_seal_state`: one row (`id` = `vault`): whether the vault is sealed, since when, why, by which path
 *   (`dual-control` or `break-glass`), which proposal, and the escrow whose quorum unseals it. Every instance reads it
 *   when it starts and polls it while it runs, so a seal missed on the bus (or set by the CLI) still takes effect.
 * - `vault_seal_proposals`: "Seal the vault" under dual control: a platform admin proposes it with a reason, a second,
 *   different platform admin approves it and the seal fires. A proposal expires after an hour.
 *
 * No share is ever stored: unseal progress is held in the memory of the instance that receives the shares.
 *
 * Expand only: a build from before this migration ignores the tables.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('vault_seal_state'))) {
    await knex.schema.createTable('vault_seal_state', (t) => {
      t.string('id', 16).primary();
      t.boolean('sealed').notNullable().defaultTo(false);
      t.bigInteger('sealed_at').nullable();
      t.string('sealed_by', 200).nullable();
      t.string('mode', 16).nullable();
      t.string('reason', 1000).nullable();
      t.string('proposal_id', 26).nullable();
      t.string('escrow_id', 26).nullable();
      t.bigInteger('unsealed_at').nullable();
      t.string('unsealed_by', 200).nullable();
      t.bigInteger('updated_at').notNullable();
    });
  }
  if (!(await knex.schema.hasTable('vault_seal_proposals'))) {
    await knex.schema.createTable('vault_seal_proposals', (t) => {
      t.string('id', 26).primary();
      t.string('reason', 1000).notNullable();
      t.string('state', 12).notNullable();
      t.string('proposed_by', 26).notNullable();
      t.string('proposed_tenant', 26).notNullable();
      t.bigInteger('proposed_at').notNullable();
      t.bigInteger('expires_at').notNullable();
      t.string('decided_by', 26).nullable();
      t.bigInteger('decided_at').nullable();
      t.string('note', 500).nullable();
      t.index(['state', 'proposed_at'], 'vault_seal_prop_state');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('vault_seal_proposals');
  await knex.schema.dropTableIfExists('vault_seal_state');
}
