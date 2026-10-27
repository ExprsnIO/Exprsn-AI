import type { Db } from '../db/knex.js';

/** How long a tenant's default workspace is remembered. Short: a new or archived workspace shows within a minute. */
const TTL_MS = 60_000;

const cache = new WeakMap<object, Map<string, { id: string | null; at: number }>>();

/**
 * The tenant's default workspace: where usage that no object or caller places in a workspace is counted (embedding
 * and classifier metering, `tenancy/usage-attribution.ts`). There is no tenant setting for it yet, so it is the active
 * workspace named or slugged `general`, else the one named or slugged `platform`, else the oldest active workspace;
 * null only when the tenant has no active workspace. Cached per tenant for a minute (a null answer is not cached).
 * Exported for one-off backfills.
 */
export async function defaultWorkspace(db: Db, tenantId: string): Promise<string | null> {
  let byTenant = cache.get(db);
  if (!byTenant) cache.set(db, (byTenant = new Map()));
  const hit = byTenant.get(tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.id;
  const rows = (await db('workspaces').where({ tenant_id: tenantId }).andWhere((w) => w.where({ state: 'active' }).orWhereNull('state')).orderBy([{ column: 'created_at', order: 'asc' }, { column: 'id', order: 'asc' }]).select('id', 'name', 'slug')) as { id: string; name: string; slug: string | null }[];
  const named = (n: string) => rows.find((r) => r.name.trim().toLowerCase() === n || (r.slug ?? '').toLowerCase() === n);
  const id = (named('general') ?? named('platform') ?? rows[0])?.id ?? null;
  // A tenant without one is asked again next time, so its first workspace counts at once.
  if (id) byTenant.set(tenantId, { id, at: Date.now() });
  return id;
}

/** Forgets the cached default workspaces (tests, and after a workspace is created, renamed or archived here). */
export function forgetDefaultWorkspace(db: Db, tenantId?: string): void {
  const byTenant = cache.get(db);
  if (!byTenant) return;
  if (tenantId) byTenant.delete(tenantId);
  else byTenant.clear();
}
