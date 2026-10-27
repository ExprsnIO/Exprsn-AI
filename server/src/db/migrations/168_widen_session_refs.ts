import type { Knex } from 'knex';

/*
 * 2.0.x fix (database review 2026-10-21): two columns that hold a sign-in session id were 26 characters wide, but
 * `sessions.id` is the 64-character hex HMAC of the cookie token (001_core). PostgreSQL and MySQL rejected the insert
 * ("value too long"), which broke email-code MFA sign-in (`mfa_email_codes`, 030_channels) and design locks
 * (`design_locks`, 098_design_locks). SQLite ignores varchar lengths, so the tests never saw it.
 *
 * Widens both to varchar(64), still nullable. On PostgreSQL widening a varchar is a catalog-only change (no table
 * rewrite) and both tables are small. SQLite needs nothing. Expand only: a build from before this migration still works.
 */
const COLUMNS: Array<[table: string, column: string]> = [
  ['mfa_email_codes', 'session_id'],
  ['design_locks', 'session_id']
];

async function setWidth(knex: Knex, width: number): Promise<void> {
  const client = String(knex.client.config.client);
  const pg = client === 'pg' || client === 'postgres' || client === 'postgresql';
  const mysql = /mysql/.test(client);
  if (!pg && !mysql) return; // SQLite: lengths are not enforced
  for (const [table, column] of COLUMNS) {
    if (!(await knex.schema.hasTable(table)) || !(await knex.schema.hasColumn(table, column))) continue;
    if (pg) await knex.raw('ALTER TABLE ?? ALTER COLUMN ?? TYPE varchar(' + width + ')', [table, column]);
    else await knex.raw('ALTER TABLE ?? MODIFY ?? varchar(' + width + ') NULL', [table, column]);
  }
}

export async function up(knex: Knex): Promise<void> {
  await setWidth(knex, 64);
}

export async function down(knex: Knex): Promise<void> {
  // Narrowing fails if a row already holds a 64-character id; clear those first (they are short-lived codes and locks).
  for (const [table, column] of COLUMNS) {
    if (await knex.schema.hasTable(table)) await knex(table).whereRaw('length(??) > 26', [column]).update({ [column]: null });
  }
  await setWidth(knex, 26);
}
