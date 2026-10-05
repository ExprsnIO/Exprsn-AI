import type { Knex } from 'knex';

/*
 * Sprint 28a (1.4.0), customer-service channels (030): B-2301 to B-2304, and the email one-time-code factor (B-1806).
 *
 * - `channels`: a chat or email channel in one workspace, bound to a published profile or agent (`target_kind`,
 *   `target_name`), with its own label, review mode, rate limits and retention. `public_key` names the channel in the
 *   public customer endpoints (it is not a secret: a session token is). `settings` is JSON without secrets; the
 *   channel's own secrets (the identity key, the generic webhook key) are sealed; IMAP, SMTP and Mailgun credentials
 *   are `vault:` references that resolve as `vault_owner`.
 * - `channel_sessions`: one customer conversation (anonymous, identified, or by email), at the channel's label.
 *   `customer` and `subject` are sealed; `customer_key` is an HMAC of the customer's email address or external id, so
 *   a thread can be matched to its sender without storing the address in clear.
 * - `channel_messages`: the transcript, sealed per row. `state` delivered | held | rejected | hidden; `original` keeps
 *   a held reply as the model wrote it when a reviewer edits it; `flag_id` links a held reply to its flag.
 * - `channel_threads`: every email Message-ID seen or sent in a session, by SHA-256 (Message-IDs can be long), so a
 *   reply's In-Reply-To or References finds its session; unique per channel, which also deduplicates inbound mail.
 *   The Message-ID itself is kept sealed, for the In-Reply-To and References of replies.
 * - `channel_outbox`: outbound email, sent by a queue job; recipient and subject sealed; bounces mark the row.
 * - `channel_bounces`: bounces and complaints from IMAP delivery reports or provider webhooks.
 * - `channel_imap_cursors`: the last UID seen per channel and mailbox UIDVALIDITY.
 * - `mfa_email_codes`: one-time codes sent by email (B-1806), stored as an HMAC, for enrolment or a pending sign-in.
 * Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('channels', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).notNullable();
    t.string('name', 200).notNullable();
    t.string('kind', 20).notNullable(); // chat | email
    t.string('state', 20).notNullable(); // active | paused | deleted
    t.string('label', 20).notNullable();
    t.string('target_kind', 20).notNullable(); // profile | agent
    t.string('target_name', 200).notNullable();
    t.text('instructions').nullable(); // sealed: extra system prompt for this channel
    t.string('review_mode', 20).notNullable(); // never | escalated | always
    t.boolean('allow_anonymous').notNullable().defaultTo(true);
    t.integer('messages_per_minute').notNullable();
    t.integer('sessions_per_hour').notNullable();
    t.integer('retention_days').nullable();
    t.string('public_key', 64).notNullable().unique();
    t.text('settings').notNullable(); // JSON, no secrets
    t.text('identity_secret').nullable(); // sealed
    t.text('webhook_secret').nullable(); // sealed
    t.string('vault_owner', 26).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'workspace_id', 'state']);
  });

  await knex.schema.createTable('channel_sessions', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('channel_id', 26).notNullable().references('id').inTable('channels').onDelete('CASCADE');
    t.string('workspace_id', 26).notNullable();
    t.string('label', 20).notNullable();
    t.string('state', 20).notNullable(); // open | escalated | closed | hidden
    t.string('customer_kind', 20).notNullable(); // anonymous | identified | email
    t.string('customer_key', 64).nullable();
    t.text('customer').nullable(); // sealed JSON
    t.text('subject').nullable(); // sealed
    t.integer('next_seq').notNullable().defaultTo(1);
    t.bigInteger('escalated_at').nullable();
    t.string('escalation', 500).nullable();
    t.bigInteger('last_activity_at').notNullable();
    t.bigInteger('closed_at').nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'channel_id', 'last_activity_at']);
    t.index(['channel_id', 'customer_key']);
  });

  await knex.schema.createTable('channel_messages', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('session_id', 26).notNullable().references('id').inTable('channel_sessions').onDelete('CASCADE');
    t.string('channel_id', 26).notNullable();
    t.integer('seq').notNullable();
    t.string('role', 20).notNullable(); // customer | assistant | agent | notice
    t.string('state', 20).notNullable(); // delivered | held | rejected | hidden
    t.string('via', 20).notNullable(); // web | email | reviewer
    t.text('body', 'mediumtext').notNullable(); // sealed
    t.text('original', 'mediumtext').nullable(); // sealed: a held reply before a reviewer's edit
    t.string('label', 20).notNullable();
    t.string('flag_id', 26).nullable();
    t.string('author_id', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('delivered_at').nullable();
    t.unique(['session_id', 'seq']);
    t.index(['tenant_id', 'channel_id', 'created_at']);
  });

  await knex.schema.createTable('channel_threads', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('channel_id', 26).notNullable().references('id').inTable('channels').onDelete('CASCADE');
    t.string('session_id', 26).notNullable().references('id').inTable('channel_sessions').onDelete('CASCADE');
    t.string('mid_hash', 64).notNullable();
    t.text('mid').notNullable(); // sealed: the Message-ID itself, for In-Reply-To and References
    t.string('direction', 10).notNullable(); // in | out
    t.bigInteger('created_at').notNullable();
    t.unique(['channel_id', 'mid_hash']);
    t.index(['session_id']);
  });

  await knex.schema.createTable('channel_outbox', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('channel_id', 26).notNullable().references('id').inTable('channels').onDelete('CASCADE');
    t.string('session_id', 26).notNullable().references('id').inTable('channel_sessions').onDelete('CASCADE');
    t.string('message_id', 26).notNullable();
    t.text('recipient').notNullable(); // sealed
    t.string('recipient_key', 64).notNullable();
    t.text('subject').notNullable(); // sealed
    t.string('header_id', 255).notNullable(); // our Message-ID
    t.text('in_reply_to').nullable();
    t.text('refs').nullable(); // References, space-separated
    t.string('state', 20).notNullable(); // queued | sent | failed | bounced
    t.boolean('automatic').notNullable().defaultTo(false); // written by the model: sent with Auto-Submitted
    t.integer('attempts').notNullable().defaultTo(0);
    t.string('last_error', 500).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('sent_at').nullable();
    t.bigInteger('bounced_at').nullable();
    t.index(['tenant_id', 'channel_id', 'state']);
  });

  await knex.schema.createTable('channel_bounces', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('channel_id', 26).notNullable().references('id').inTable('channels').onDelete('CASCADE');
    t.string('outbox_id', 26).nullable();
    t.string('recipient_key', 64).nullable();
    t.string('kind', 20).notNullable(); // hard | soft | complaint
    t.string('status', 20).nullable(); // the enhanced status code (5.1.1)
    t.string('reason', 500).nullable();
    t.string('source', 20).notNullable(); // imap | generic | mailgun
    t.string('report_hash', 64).nullable(); // the report's own id, so a report read twice is recorded once
    t.bigInteger('created_at').notNullable();
    t.index(['tenant_id', 'channel_id', 'created_at']);
    t.unique(['channel_id', 'report_hash']);
  });

  await knex.schema.createTable('channel_imap_cursors', (t) => {
    t.string('channel_id', 26).primary().references('id').inTable('channels').onDelete('CASCADE');
    t.string('tenant_id', 26).notNullable();
    t.bigInteger('uid_validity').nullable();
    t.bigInteger('last_uid').notNullable().defaultTo(0);
    t.bigInteger('polled_at').nullable();
    t.string('last_error', 500).nullable();
  });

  await knex.schema.createTable('mfa_email_codes', (t) => {
    t.string('id', 26).primary();
    t.string('user_id', 26).notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('factor_id', 26).notNullable();
    t.string('purpose', 20).notNullable(); // enrol | signin
    t.string('session_id', 26).nullable();
    t.string('code_hash', 64).notNullable();
    t.bigInteger('expires_at').notNullable();
    t.bigInteger('used_at').nullable();
    t.bigInteger('created_at').notNullable();
    t.index(['user_id', 'purpose']);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['mfa_email_codes', 'channel_imap_cursors', 'channel_bounces', 'channel_outbox', 'channel_threads', 'channel_messages', 'channel_sessions', 'channels']) await knex.schema.dropTableIfExists(table);
}
