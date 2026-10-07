import type { Db } from '../db/knex.js';
import type { BlobStore } from '../platform/blob.js';
import type { DataKeys } from '../platform/datakeys.js';
import type { JobQueue } from '../platform/jobs.js';
import type { SessionService } from '../identity/sessions.js';

/** Tables holding data derived from a tenant's content, purged after its key is destroyed. Order respects FKs. */
const KNOWLEDGE_TABLES = ['knowledge_bindings', 'knowledge_doc_labels', 'knowledge_terms', 'knowledge_chunks', 'knowledge_access', 'knowledge_documents', 'knowledge_sources', 'knowledge_indexes', 'knowledge_bases', 'embedding_cache', 'knowledge_keys', 'vectors', 'vectors_pg', 'memory_versions', 'memories', 'memory_rejections', 'memory_exports', 'memory_settings', 'data_connections'] as const;
// Sprint 26d: the file store (its rows go with the tenant key; versions, previews and tags cascade from files).
const FILE_TABLES = ['file_shares', 'file_tags', 'file_previews', 'file_versions', 'files', 'file_folders', 'file_quotas'] as const;
// Sprint 27c: groups and events (posts, titles and descriptions are sealed with the tenant key).
const GROUP_TABLES = ['calendar_feeds', 'group_event_reminders', 'group_event_rsvps', 'group_events', 'group_posts', 'group_requests', 'group_members', 'social_groups'] as const;
// Sprint 28a (B-23): customer-service channels and their sealed transcripts.
const CHANNEL_TABLES = ['channel_bounces', 'channel_outbox', 'channel_threads', 'channel_imap_cursors', 'channel_messages', 'channel_sessions', 'channels'] as const;
// Sprint 28b: messaging (bodies and titles sealed) and social relations (blocks, mutes, follows, lists, contact rules).
const SOCIAL_TABLES = ['dm_terms', 'dm_reactions', 'dm_messages', 'dm_members', 'dm_conversations', 'social_list_members', 'social_lists', 'social_settings', 'social_follows', 'social_mutes', 'social_blocks'] as const;
// Sprint 28c: the workspace feed (posts, comments and digest summaries are sealed with the tenant key).
const FEED_TABLES = ['feed_settings', 'feed_digests', 'feed_trending', 'feed_hashtags', 'feed_bookmarks', 'feed_reactions', 'feed_comments', 'feed_post_media', 'feed_posts'] as const;
// 1.5.0, Sprint 30 (B-31, B-32): DAV app passwords, personal calendars and address books (sealed), properties and (B-32) locks.
const DAV_TABLES = ['dav_locks', 'dav_properties', 'dav_tombstones', 'dav_objects', 'dav_collections', 'dav_app_passwords'] as const;
// 1.5.0, Sprint 34c (B-5801, B-5802): profiles, chosen presence statuses and live connection rows.
const PROFILE_TABLES = ['presence_connections', 'user_presence', 'user_profiles'] as const;
const DERIVED_TABLES = [...KNOWLEDGE_TABLES, ...FILE_TABLES, ...GROUP_TABLES, ...CHANNEL_TABLES, ...SOCIAL_TABLES, ...FEED_TABLES, ...DAV_TABLES, ...PROFILE_TABLES, 'messages', 'attachments', 'conversations', 'exports', 'notifications'] as const;
const BLOB_PREFIXES = ['exports', 'attachments', 'quarantine', 'knowledge', 'knowledge-quarantine', 'memory-exports', 'files', 'eval-images'] as const;

/**
 * Offboarding, in the three steps the Tenants board shows:
 *   1. export on request (a normal audit/usage export, taken before this runs);
 *   2. destroy the tenant key: every value sealed with it (conversations, attachments, exports) becomes unreadable;
 *   3. a job deletes the derived data and blobs, reporting progress; the audit chain and usage records are kept.
 * Sign-in is refused from step 2 on, and every session and API key in the tenant is revoked.
 */
export class Offboarding {
  constructor(
    private readonly db: Db,
    private readonly keys: DataKeys,
    private readonly blobs: BlobStore,
    private readonly jobs: JobQueue,
    private readonly sessions: Pick<SessionService, 'revokeAllForTenant'>
  ) {
    jobs.register('tenant.purge', (p, ctx) => this.purge(String(p.tenantId), ctx.progress), { timeoutMs: 60 * 60_000 });
  }

  async start(tenantId: string, by: string): Promise<{ keyVersionsDestroyed: number; sessionsRevoked: number; apiKeysRevoked: number; jobId: string }> {
    await this.db('tenants').where({ id: tenantId }).update({ state: 'offboarding', updated_at: Date.now() });
    const t = Date.now();
    const sessionsRevoked = await this.sessions.revokeAllForTenant(tenantId);
    const apiKeysRevoked = await this.db('api_keys').where({ tenant_id: tenantId, revoked_at: null }).update({ revoked_at: t });
    const { versions } = await this.keys.destroy(tenantId);
    const job = await this.jobs.enqueue({ tenantId, type: 'tenant.purge', payload: { tenantId }, createdBy: by, dedupeKey: `tenant.purge:${tenantId}`, maxAttempts: 5 });
    return { keyVersionsDestroyed: versions, sessionsRevoked, apiKeysRevoked: Number(apiKeysRevoked), jobId: job.id };
  }

  private async purge(tenantId: string, progress: (pct: number, m?: string) => Promise<void>): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    const steps = DERIVED_TABLES.length + BLOB_PREFIXES.length;
    let i = 0;
    for (const table of DERIVED_TABLES) {
      if (await this.db.schema.hasTable(table)) out[table] = await this.db(table).where({ tenant_id: tenantId }).delete();
      await progress((++i / steps) * 100, `Deleted ${table}`);
    }
    for (const prefix of BLOB_PREFIXES) {
      out[`blobs:${prefix}`] = await this.blobs.deletePrefix(`${prefix}/${tenantId}`);
      await progress((++i / steps) * 100, `Deleted ${prefix} objects`);
    }
    await this.db('tenants').where({ id: tenantId }).update({ state: 'offboarded', updated_at: Date.now() });
    return out;
  }
}
