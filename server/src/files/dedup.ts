import type { Knex } from 'knex';
import { isUniqueViolation } from '../audit/chain.js';
import type { Db } from '../db/knex.js';

/*
 * 1.6.0 (B-4601): reference-counted blobs for the file store, within one tenant only.
 *
 * Every version is uploaded into quarantine sealed under a content key of its own (files/crypt.ts), so an upload always
 * stores and scans its full bytes, whatever the tenant already holds. When the scan releases it, the SHA-256 of its
 * plaintext is looked up among the tenant's blobs:
 *
 * - found: the version reads that blob (its key and associated data name the version that first stored it), `refs`
 *   goes up by one, and the quarantined copy is deleted;
 * - not found: the version's object moves into the store as before and becomes a blob (refs 1) under its own id.
 *
 * Deleting (the trash purge) takes `refs` down inside the transaction that deletes the version rows; the object goes
 * only when the count reaches zero, after the commit. Taking a reference is a conditional increment (`refs > 0`), so a
 * blob whose last reference is being released is never adopted: the new version stores its own copy instead.
 *
 * Tenants never share: the lookup is keyed by tenant, and each tenant's content is sealed with its own key, so one
 * tenant's upload can neither read nor reveal another's. The quota counts every version's own size, as before.
 */

export interface BlobRow {
  id: string;
  tenant_id: string;
  sha256: string;
  size: number;
  blob_key: string;
  sealed_key: string;
  refs: number;
  created_at: number;
  updated_at: number;
}

const blobFrom = (r: Record<string, unknown>): BlobRow => ({ ...(r as unknown as BlobRow), size: Number(r.size), refs: Number(r.refs), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });

export class FileBlobs {
  constructor(private readonly db: () => Db) {}

  /** Takes a reference to the tenant's blob of the same content, or null when there is none to share. */
  async adopt(v: { id: string; tenant_id: string; sha256: string; size: number }): Promise<BlobRow | null> {
    const db = this.db();
    const r = await db('file_blobs').where({ tenant_id: v.tenant_id, sha256: v.sha256, size: v.size }).first();
    if (!r || r.id === v.id) return null;
    const n = await db('file_blobs').where({ id: r.id }).andWhere('refs', '>', 0).update({ refs: db.raw('refs + 1'), updated_at: Date.now() });
    return n ? blobFrom(r) : null;
  }

  /**
   * Registers a version's own object as a blob. False when the tenant registered the same content meanwhile (two
   * identical uploads released together): this version then keeps its object unshared.
   */
  async register(v: { id: string; tenant_id: string; sha256: string; size: number; blob_key: string | null; sealed_key: string | null }): Promise<boolean> {
    if (!v.blob_key || !v.sealed_key) return false;
    const t = Date.now();
    try {
      await this.db()('file_blobs').insert({ id: v.id, tenant_id: v.tenant_id, sha256: v.sha256, size: v.size, blob_key: v.blob_key, sealed_key: v.sealed_key, refs: 1, created_at: t, updated_at: t });
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }

  /** Drops one reference inside `trx`; returns the object keys to delete once it commits (the last reference went). */
  async release(trx: Knex | Knex.Transaction, blobId: string): Promise<string[]> {
    const r = (await trx('file_blobs').where({ id: blobId }).first('blob_key')) as { blob_key: string } | undefined;
    if (!r) return [];
    await trx('file_blobs').where({ id: blobId }).update({ refs: trx.raw('refs - 1'), updated_at: Date.now() });
    const gone = await trx('file_blobs').where({ id: blobId }).andWhere('refs', '<=', 0).delete();
    return gone ? [r.blob_key] : [];
  }

  /** What sharing saves, per tenant: objects, references, the bytes the versions hold and the bytes stored. */
  async savings(): Promise<{ tenantId: string; blobs: number; shared: number; references: number; logicalBytes: number; storedBytes: number; savedBytes: number }[]> {
    const rows = (await this.db()('file_blobs').select('tenant_id').count({ blobs: '*' }).sum({ refs: 'refs', stored: 'size' }).groupBy('tenant_id')) as { tenant_id: string; blobs: number | string; refs: number | string | null; stored: number | string | null }[];
    const shared = new Map(((await this.db()('file_blobs').where('refs', '>', 1).select('tenant_id', this.db().raw('count(*) as n'), this.db().raw('sum((refs - 1) * size) as extra')).groupBy('tenant_id')) as { tenant_id: string; n: number | string; extra: number | string | null }[]).map((r) => [r.tenant_id, { n: Number(r.n), saved: Number(r.extra ?? 0) }]));
    return rows.map((r) => {
      const sh = shared.get(r.tenant_id) ?? { n: 0, saved: 0 };
      const stored = Number(r.stored ?? 0);
      return { tenantId: r.tenant_id, blobs: Number(r.blobs), shared: sh.n, references: Number(r.refs ?? 0), logicalBytes: stored + sh.saved, storedBytes: stored, savedBytes: sh.saved };
    });
  }
}
