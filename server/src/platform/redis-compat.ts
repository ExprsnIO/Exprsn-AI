/*
 * 1.9.99-final, Sprint 59 (B-10305): what BullMQ and the bus need of a Redis (or Valkey), shared by the cloud cache
 * work (`cloud/caches.ts`: the planner's refusal and the wiring of a managed cache as `REDIS_URL`) and the readiness
 * check (`Bus.compatibility`, `/readyz`): one keyspace (no cluster mode: BullMQ's Lua scripts touch several keys at
 * once, which a cluster refuses with CROSSSLOT unless every key shares a hash tag, and this build does not tag them),
 * nothing evicted under memory pressure (`noeviction`: an evicting policy silently drops queued jobs, their locks and
 * the shared counters), and TLS (`rediss://`). Pure.
 */

/** The only eviction policy BullMQ and the bus can live with. */
export const REQUIRED_EVICTION_POLICY = 'noeviction';

export interface CacheProblem {
  code: 'cluster_mode' | 'eviction_policy' | 'tls_off' | 'public_access';
  reason: string;
}

/** What BullMQ and the bus need of a cache, checked on desired props or on what a provider (or `INFO`) reports. */
export function cacheCompatibility(p: { clusterMode?: boolean | null; evictionPolicy?: string | null; tls?: boolean | null; publicAccess?: boolean | null; service?: string | null }): CacheProblem[] {
  const out: CacheProblem[] = [];
  if (p.service === 'memorydb') out.push({ code: 'cluster_mode', reason: 'MemoryDB always runs in cluster mode, and BullMQ and the bus need one keyspace on one primary (multi-key scripts fail with CROSSSLOT); use ElastiCache with cluster mode off.' });
  else if (p.clusterMode) out.push({ code: 'cluster_mode', reason: 'Cluster mode is on: BullMQ and the bus need one keyspace on one primary (their multi-key scripts fail with CROSSSLOT across shards); turn cluster mode off.' });
  const policy = p.evictionPolicy == null ? null : normalisePolicy(p.evictionPolicy);
  if (policy != null && policy !== REQUIRED_EVICTION_POLICY) out.push({ code: 'eviction_policy', reason: `maxmemory-policy is ${policy}: under memory pressure Redis would evict queued jobs, their locks and the shared counters without an error; set it to noeviction.` });
  if (p.tls === false) out.push({ code: 'tls_off', reason: 'In-transit encryption is off: the install connects with rediss:// only.' });
  if (p.publicAccess === true) out.push({ code: 'public_access', reason: 'Public network access is on: the cache must sit behind the deployment’s private endpoint.' });
  return out;
}

/** `allkeys-lru`, `ALLKEYS_LRU`, `AllKeysLRU` and `NoEviction` to Redis's own spelling. */
export function normalisePolicy(v: string): string {
  const s = v.trim();
  if (/^noeviction$/i.test(s)) return 'noeviction';
  const m = /^(allkeys|volatile)[-_]?(lru|lfu|random|ttl)$/i.exec(s);
  if (m) return `${m[1]!.toLowerCase()}-${m[2]!.toLowerCase()}`;
  return s.toLowerCase().replace(/_/g, '-');
}

/** The fields of a Redis `INFO` answer. */
export function parseInfo(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return out;
}

export interface RedisCompatibility {
  clusterMode: boolean | null;
  evictionPolicy: string | null;
  problems: CacheProblem[];
}

/**
 * A running Redis checked over `INFO cluster` and `INFO memory` (managed services that refuse `CONFIG GET` still
 * answer `INFO`). A field Redis does not report is unknown and not a problem.
 */
export async function redisCompatibility(client: { info(section: string): Promise<string> }): Promise<RedisCompatibility> {
  const cluster = parseInfo(await client.info('cluster').catch(() => ''));
  const memory = parseInfo(await client.info('memory').catch(() => ''));
  const clusterMode = cluster.cluster_enabled == null ? null : cluster.cluster_enabled === '1';
  const evictionPolicy = memory.maxmemory_policy ?? null;
  return { clusterMode, evictionPolicy, problems: cacheCompatibility({ clusterMode, evictionPolicy }) };
}

/** The readiness check's word for a Redis that answers: `ok`, or `incompatible: <codes>` (reported, not failed). */
export function readinessWord(c: RedisCompatibility | null): string {
  if (!c || !c.problems.length) return 'ok';
  return `incompatible: ${c.problems.map((p) => (p.code === 'eviction_policy' ? `maxmemory-policy ${c.evictionPolicy}` : p.code.replace(/_/g, ' '))).join(', ')}`;
}
