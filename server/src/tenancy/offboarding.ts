import type { Db } from '../db/knex.js';
import type { BlobStore } from '../platform/blob.js';
import type { DataKeys } from '../platform/datakeys.js';
import type { JobQueue } from '../platform/jobs.js';
import type { SessionService } from '../identity/sessions.js';

/** Tables holding data derived from a tenant's content, purged after its key is destroyed. Order respects FKs. */
const KNOWLEDGE_TABLES = ['knowledge_bindings', 'knowledge_terms', 'knowledge_chunks', 'knowledge_access', 'knowledge_documents', 'knowledge_sources', 'knowledge_indexes', 'knowledge_bases', 'embedding_cache', 'knowledge_keys', 'vectors', 'vectors_pg', 'memory_versions', 'memories', 'memory_rejections', 'memory_exports', 'data_connections'] as const;
// Sprint 26d: the file store (its rows go with the tenant key; versions, previews and tags cascade from files).
const FILE_TABLES = ['file_shares', 'file_tags', 'file_previews', 'file_versions', 'files', 'file_folders', 'file_quotas'] as const;
const DERIVED_TABLES = [...KNOWLEDGE_TABLES, ...FILE_TABLES, 'messages', 'attachments', 'conversations', 'exports', 'notifications'] as const;
const BLOB_PREFIXES = ['exports', 'attachments', 'quarantine', 'knowledge', 'knowledge-quarantine', 'memory-exports', 'files'] as const;

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
