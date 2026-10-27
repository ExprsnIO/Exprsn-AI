import { json } from '../db/knex.js';
import type { AuditActor } from '../audit/chain.js';
import type { Services } from '../services.js';

/** Who a platform change is recorded against: a person (routes, jobs they started) or the scheduler. */
export interface OpsActor {
  tenantId: string;
  actor: AuditActor;
  userId: string | null;
  traceId?: string | null;
}

export const systemActor = (tenantId: string, userId: string | null = null): OpsActor => ({ tenantId, actor: userId ? { user: userId, service: 'platform-ops' } : { service: 'platform-ops' }, userId });

export function audit(s: Services, by: OpsActor, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>, kind: 'admin' | 'system' = 'system') {
  return s.audit.append({ tenantId: by.tenantId, action, kind, actor: by.actor, target, ...(detail ? { detail } : {}), traceId: by.traceId ?? null });
}

/** Notifies every active system admin, in whichever tenant their account lives. */
export async function notifyAdmins(s: Services, n: { kind: string; title: string; body?: string; email?: boolean }): Promise<number> {
  const rows = (await s.db('users as u').join('user_roles as r', 'r.user_id', 'u.id').where({ 'r.role': 'system-admin', 'u.state': 'active' }).distinct('u.id', 'u.tenant_id')) as { id: string; tenant_id: string }[];
  const byTenant = new Map<string, string[]>();
  for (const r of rows) byTenant.set(r.tenant_id, [...(byTenant.get(r.tenant_id) ?? []), r.id]);
  let sent = 0;
  for (const [tenantId, userIds] of byTenant) sent += (await s.notifications.notify({ tenantId, userIds, kind: n.kind, title: n.title, route: 'platform', ...(n.body ? { body: n.body } : {}), ...(n.email ? { email: true } : {}) })).length;
  return sent;
}

/** The tenant that scheduled platform work is recorded in: the default tenant. */
export async function platformTenant(s: Services): Promise<string | null> {
  return (await s.tenants.bySlug(s.cfg.DEFAULT_TENANT))?.id ?? null;
}

export async function getState<T>(s: Services, key: string, fallback: T): Promise<T> {
  const row = (await s.db('platform_state').where({ key }).first()) as { value: string } | undefined;
  return row ? json<T>(row.value, fallback) : fallback;
}

export async function setState(s: Services, key: string, value: unknown): Promise<void> {
  const row = { key, value: JSON.stringify(value), updated_at: Date.now() };
  const n = await s.db('platform_state').where({ key }).update({ value: row.value, updated_at: row.updated_at });
  if (!n) await s.db('platform_state').insert(row);
}

/** `3f:9a:c1` from a hex fingerprint. */
export const shortFingerprint = (hex: string, bytes = 3): string => (hex.match(/../g) ?? []).slice(0, bytes).join(':');

