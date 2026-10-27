import type { Knex } from 'knex';

/*
 * Sprint 46 (B-134): SLA timers and assignment routing (`sla/service.ts`).
 *
 * - `sla_policies`: one per tenant, queue type (`channel-session`, `flag`, `held-write`, `appeal`) and scope
 *   (`scope_key`: a channel id, a moderation queue id, a held-write kind, or `*` for the whole queue type). Targets
 *   in minutes of open time, the warn threshold as a percentage of each target, business hours (JSON, null for 24/7),
 *   whether waiting on the customer pauses the clock, and the actions on warn and breach (JSON).
 * - `sla_timers`: one per item a policy covered, keyed by queue type and item id: the timer's start, its due times
 *   when last seen, the first response and resolution once they happened (kept for the statistics), the moments the
 *   warn and breach actions were claimed (once each, across instances), the raised priority and the routing marks.
 * - `routing_rules`: one per tenant, queue type and scope: `manual`, `round-robin` (with its cursor), `least-loaded`
 *   or `skills`; the pool (a role, or named people), the fallback, and whether away or offline people are skipped.
 * - `user_skills`: skill tags on people, matched against an item's tags.
 * - `channel_sessions.assignee_id` and `assigned_at`, and `moderation_appeals.assignee_id`: who works the item, set
 *   only through `ChannelService.assignSession` and `ModerationService.assignAppeal`.
 *
 * Expand only; a build from before this migration ignores the new tables and columns.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('sla_policies'))) {
    await knex.schema.createTable('sla_policies', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable().references('id').inTable('tenants').onDelete('CASCADE');
      t.string('name', 120).notNullable();
      t.string('queue_type', 20).notNullable();
      t.string('scope_key', 63).notNullable().defaultTo('*');
      t.integer('first_response_minutes').nullable();
      t.integer('resolution_minutes').nullable();
      t.integer('warn_percent').notNullable().defaultTo(80);
      t.text('hours').nullable();
      t.boolean('pause_on_customer').notNullable().defaultTo(true);
      t.text('on_warn').nullable();
      t.text('on_breach').nullable();
      t.boolean('enabled').notNullable().defaultTo(true);
      t.string('created_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.unique(['tenant_id', 'queue_type', 'scope_key']);
    });
  }
  if (!(await knex.schema.hasTable('sla_timers'))) {
    await knex.schema.createTable('sla_timers', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('queue_type', 20).notNullable();
      t.string('item_id', 64).notNullable();
      t.string('scope_key', 63).notNullable().defaultTo('*');
      t.string('policy_id', 26).nullable();
      t.bigInteger('started_at').notNullable();
      t.bigInteger('first_response_due').nullable();
      t.bigInteger('first_response_at').nullable();
      t.bigInteger('resolution_due').nullable();
      t.bigInteger('resolved_at').nullable();
      t.boolean('first_response_met').nullable();
      t.boolean('resolution_met').nullable();
      t.bigInteger('fr_warned_at').nullable();
      t.bigInteger('fr_breached_at').nullable();
      t.bigInteger('res_warned_at').nullable();
      t.bigInteger('res_breached_at').nullable();
      t.string('priority', 10).notNullable().defaultTo('normal');
      t.bigInteger('escalated_at').nullable();
      t.string('assignee', 26).nullable();
      t.bigInteger('routed_at').nullable();
      t.bigInteger('updated_at').notNullable();
      t.unique(['queue_type', 'item_id']);
      t.index(['tenant_id', 'queue_type', 'resolved_at']);
    });
  }
  if (!(await knex.schema.hasTable('routing_rules'))) {
    await knex.schema.createTable('routing_rules', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable().references('id').inTable('tenants').onDelete('CASCADE');
      t.string('queue_type', 20).notNullable();
      t.string('scope_key', 63).notNullable().defaultTo('*');
      t.string('mode', 20).notNullable(); // manual | round-robin | least-loaded | skills
      t.text('pool').nullable();
      t.text('fallback').nullable();
      t.boolean('skip_unavailable').notNullable().defaultTo(true);
      t.string('cursor', 26).nullable();
      t.boolean('enabled').notNullable().defaultTo(true);
      t.string('created_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.unique(['tenant_id', 'queue_type', 'scope_key']);
    });
  }
  if (!(await knex.schema.hasTable('user_skills'))) {
    await knex.schema.createTable('user_skills', (t) => {
      t.string('tenant_id', 26).notNullable().references('id').inTable('tenants').onDelete('CASCADE');
      t.string('user_id', 26).notNullable().references('id').inTable('users').onDelete('CASCADE');
      t.string('skill', 63).notNullable();
      t.string('created_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.primary(['tenant_id', 'user_id', 'skill']);
      t.index(['tenant_id', 'skill']);
    });
  }
  if (!(await knex.schema.hasColumn('channel_sessions', 'assignee_id'))) {
    await knex.schema.alterTable('channel_sessions', (t) => {
      t.string('assignee_id', 26).nullable();
      t.bigInteger('assigned_at').nullable();
    });
  }
  if (!(await knex.schema.hasColumn('moderation_appeals', 'assignee_id'))) {
    await knex.schema.alterTable('moderation_appeals', (t) => {
      t.string('assignee_id', 26).nullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('moderation_appeals', 'assignee_id')) await knex.schema.alterTable('moderation_appeals', (t) => t.dropColumn('assignee_id'));
  if (await knex.schema.hasColumn('channel_sessions', 'assignee_id')) {
    await knex.schema.alterTable('channel_sessions', (t) => {
      t.dropColumn('assignee_id');
      t.dropColumn('assigned_at');
    });
  }
  for (const table of ['user_skills', 'routing_rules', 'sla_timers', 'sla_policies']) await knex.schema.dropTableIfExists(table);
}
