import type { Harness } from './helpers.js';

/**
 * Tests that are not about store governance (migration 142) but change or remove stores: the tenant runs single-admin,
 * so a configuration change applies at once instead of becoming a proposal for a second identity admin.
 */
export async function singleAdminStores(h: Harness, tenantId: string = h.tenantId): Promise<void> {
  if (!(await h.s.db.schema.hasTable('identity_store_settings'))) return;
  const row = { dual_control: 'off', purge_after_days: 1, updated_by: null, updated_at: Date.now() };
  if (await h.s.db('identity_store_settings').where({ tenant_id: tenantId }).first()) await h.s.db('identity_store_settings').where({ tenant_id: tenantId }).update(row);
  else await h.s.db('identity_store_settings').insert({ tenant_id: tenantId, ...row });
}

/** Archives a store and backdates the archive past its retention, so a following DELETE (a purge) is allowed. */
export async function readyToPurge(h: Harness, providerId: string): Promise<void> {
  if (!(await h.s.db.schema.hasColumn('identity_providers', 'archived_at'))) return;
  const old = Date.now() - 400 * 86_400_000;
  await h.s.db('identity_providers').where({ id: providerId }).update({ state: 'archived', state_before: 'active', enabled: false, archived_at: old });
}
