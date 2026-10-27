import type { Db } from '../db/knex.js';
import { defaultWorkspace } from './default-workspace.js';

/**
 * Where embedding and classifier usage is counted (owner-approved, 2026-10-19). Every such `usage_records` row gets:
 *
 * - a workspace: the object's own (knowledge base, memory, conversation…), else the caller's current workspace, else
 *   the tenant's default workspace (`defaultWorkspace`); null only for a tenant without workspaces;
 * - a profile: the classifier's profile, or for an embedding by model name the tenant's published profile for that
 *   model (a profile the caller names first, then one whose name starts with `embed`, then by name);
 * - a user when a person caused it (a search, a query, an upload, a memory's author, a message's author); background
 *   work with no person stays null and shows as "System" on Analytics.
 *
 * Profiles change without a bus topic, so the lookups here are cached per tenant for a minute.
 */

const TTL_MS = 60_000;

type Entry<T> = { v: T; at: number };
const caches = new WeakMap<object, { embed: Map<string, Entry<string | null>>; classifiers: Map<string, Entry<Set<string>>> }>();

const cachesOf = (db: Db) => {
  let c = caches.get(db);
  if (!c) caches.set(db, (c = { embed: new Map(), classifiers: new Map() }));
  return c;
};
const fresh = <T>(e: Entry<T> | undefined): e is Entry<T> => !!e && Date.now() - e.at < TTL_MS;

/** The first workspace given (the object's, then the caller's), else the tenant's default workspace. */
export async function usageWorkspace(db: Db, tenantId: string, ...candidates: (string | null | undefined)[]): Promise<string | null> {
  for (const c of candidates) if (c) return c;
  return defaultWorkspace(db, tenantId);
}

/**
 * The tenant's published profile for an embedding model, by the model's catalogue name: one of `prefer` (profile
 * names a setting gives) first, then a profile whose name starts with `embed`, then the first by name. Null when the
 * tenant has no published profile on the model.
 */
export async function embeddingProfile(db: Db, tenantId: string, model: string, prefer: (string | null | undefined)[] = []): Promise<string | null> {
  const wanted = prefer.filter((x): x is string => !!x);
  const key = `${tenantId}\u0000${model}\u0000${wanted.join(',')}`;
  const c = cachesOf(db).embed;
  const hit = c.get(key);
  if (fresh(hit)) return hit.v;
  const rows = (await db('profiles as p').join('models as m', 'm.id', 'p.model_id').where({ 'p.tenant_id': tenantId, 'p.status': 'published', 'm.name': model }).select('p.id', 'p.name')) as { id: string; name: string }[];
  const rank = (n: string) => (wanted.includes(n) ? 0 : n.toLowerCase().startsWith('embed') ? 1 : 2);
  const best = rows.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))[0];
  const v = best?.id ?? null;
  c.set(key, { v, at: Date.now() });
  return v;
}

/**
 * The ids of the tenant's profiles a model-based classifier (engines guard, llm and vision, the tenant's own or the
 * platform's) routes through, plus `llama-guard`, which the guard model and the built-in safety classifier use. Usage
 * on these profiles is classifier usage: Analytics shows it with the embeddings (`class=embedding`).
 */
export async function classifierProfiles(db: Db, tenantId: string): Promise<Set<string>> {
  const c = cachesOf(db).classifiers;
  const hit = c.get(tenantId);
  if (fresh(hit)) return hit.v;
  const names = new Set<string>(['llama-guard']);
  const rows = (await db('classifiers').where((w) => w.where({ tenant_id: tenantId }).orWhereNull('tenant_id')).whereIn('engine', ['guard', 'llm', 'vision']).select('config')) as { config: string | Record<string, unknown> }[];
  for (const r of rows) {
    try {
      const cfg = (typeof r.config === 'string' ? JSON.parse(r.config) : r.config) as { profile?: unknown };
      if (typeof cfg.profile === 'string' && cfg.profile) names.add(cfg.profile);
    } catch {
      // A config that does not parse names no profile.
    }
  }
  const ids = new Set(((await db('profiles').where({ tenant_id: tenantId }).whereIn('name', [...names]).select('id')) as { id: string }[]).map((r) => r.id));
  c.set(tenantId, { v: ids, at: Date.now() });
  return ids;
}

/** Whether usage on this profile is classifier usage (see `classifierProfiles`). */
export async function isClassifierProfile(db: Db, tenantId: string, profileId: string | null | undefined): Promise<boolean> {
  return !!profileId && (await classifierProfiles(db, tenantId)).has(profileId);
}

/**
 * The workspace for a model call made by a run (agent, workflow): the run's own; for a call on a classifier profile
 * with no workspace, the tenant's default workspace (the rule above); otherwise none, as before.
 */
export async function runUsageWorkspace(db: Db, tenantId: string, workspaceId: string | null | undefined, profileId: string | null | undefined): Promise<string | null> {
  if (workspaceId) return workspaceId;
  return (await isClassifierProfile(db, tenantId, profileId)) ? defaultWorkspace(db, tenantId) : null;
}

/** Forgets the cached lookups (tests, and after a profile or classifier change on this instance). */
export function forgetUsageAttribution(db: Db): void {
  caches.delete(db);
}
