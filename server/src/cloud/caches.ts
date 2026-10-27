import { randomBytes } from 'node:crypto';
import type { Services } from '../services.js';
import { HttpProblem } from '../http/problem.js';
import { cloudAudit, type CloudAuditActor } from './audit.js';
import { CloudVault, refOf } from './cloud-vault.js';
import type { Deployment, DesiredResource, GraphResource } from './graph.js';
import type { CloudProvider, ObservedResource } from './providers/types.js';
import { cacheCompatibility, REQUIRED_EVICTION_POLICY, type CacheProblem } from '../platform/redis-compat.js';

export { cacheCompatibility, normalisePolicy, parseInfo, readinessWord, redisCompatibility, REQUIRED_EVICTION_POLICY, type CacheProblem, type RedisCompatibility } from '../platform/redis-compat.js';

/*
 * 1.9.99-final, Sprint 59 (B-10305): managed caches as the install's `REDIS_URL`.
 *
 *   AWS           ElastiCache for Valkey or Redis OSS, a replication group with cluster mode off (one primary and,
 *                 with HA, one replica), in-transit encryption and an AUTH token we choose (kept in the vault), the
 *                 deployment's own parameter group with `maxmemory-policy noeviction`. MemoryDB is listed and
 *                 described, never accepted as `REDIS_URL`: a MemoryDB cluster is always in cluster mode.
 *   Azure         Azure Cache for Redis (Basic, Standard, Premium without shards) on port 6380 with the non-TLS port
 *                 off, public network access off and a private endpoint in the data subnet, `maxmemory-policy
 *                 noeviction` in its Redis configuration, the access key read back with `listKeys`; or Azure
 *                 Managed Redis (Redis Enterprise) with the `NoCluster` clustering policy and `NoEviction`.
 *   DigitalOcean  Managed Valkey in the deployment's VPC, its eviction policy set to `noeviction`, the password the
 *                 provider generates read back from the cluster's connection.
 *
 * The compatibility rules (`cacheCompatibility`) are what BullMQ and the bus need: one keyspace (no cluster mode:
 * BullMQ's Lua scripts touch several keys at once, which a cluster refuses with CROSSSLOT unless every key shares a
 * hash tag, and this build does not tag them), nothing evicted under memory pressure (`noeviction`: an evicting
 * policy silently drops queued jobs, locks and the rate-limit counters), and TLS (`rediss://`). The planner refuses
 * a desired cache that breaks one (`cacheProblems`), wiring a cache as a deployment's `REDIS_URL` refuses an observed
 * one that does, and `/readyz` reports a running Redis that does (`redisCompatibility` over `INFO`).
 *
 * The URL is `rediss://[user]:<token>@<host>:<port>`; the token and the URL live only in the vault (the platform
 * scope, `cloud/deployments/<id>/data`), never in props, the observed state, the journal, an audit entry or an error.
 */

export const CACHE_SERVICES = ['elasticache', 'memorydb', 'azure-cache', 'azure-managed-redis', 'do-valkey'] as const;
export type CacheService = (typeof CACHE_SERVICES)[number];

export const DEFAULT_CACHE_SERVICE: Record<'aws' | 'azure' | 'digitalocean', CacheService> = { aws: 'elasticache', azure: 'azure-cache', digitalocean: 'do-valkey' };

/** A managed cache's desired props (the `cache` type of `PropsByType`). */
export interface CacheProps {
  engine: 'redis' | 'valkey';
  /** Which managed offer (default: the provider's, `DEFAULT_CACHE_SERVICE`). */
  service?: CacheService;
  /** The provider's node type or SKU (`cache.t4g.small`, `C1`, `Balanced_B1`, `db-s-1vcpu-2gb`). */
  size: string;
  /** A replica with automatic failover (ElastiCache, DigitalOcean), Standard or Premium (Azure). */
  ha?: boolean;
  version?: string;
  /** Cluster mode (sharding). Always false for `REDIS_URL`; the planner refuses true. */
  clusterMode?: boolean;
  /** `maxmemory-policy`; default and only accepted value `noeviction`. */
  evictionPolicy?: string;
  /** In-transit encryption; default and only accepted value true. */
  tls?: boolean;
  /** Graph keys of the data subnets and firewall (provider ids arrive in `parent.refs`). */
  subnets?: string[];
  firewall?: string;
  publicAccess?: boolean;
  privateEndpoint?: boolean;
  /** DigitalOcean: the trusted sources (CIDRs) of the cluster's firewall. */
  allowCidrs?: string[];
}

/** The planner's blockers: every desired cache that breaks a rule, with the reason (`cache: ...`). */
export function cacheProblems(resources: DesiredResource[]): string[] {
  const out: string[] = [];
  for (const r of resources) {
    if (r.type !== 'cache') continue;
    const s = r.spec as Partial<CacheProps>;
    const problems = cacheCompatibility({ clusterMode: s.clusterMode ?? false, evictionPolicy: s.evictionPolicy ?? REQUIRED_EVICTION_POLICY, tls: s.tls ?? true, service: s.service ?? null });
    for (const p of problems) out.push(`${r.key}: refused as REDIS_URL (${p.code}): ${p.reason}`);
  }
  return out;
}

/** What an observed cache reports, as the compatibility check reads it. */
export function observedCompatibility(o: ObservedResource): CacheProblem[] {
  const p = o.props as { clusterMode?: boolean; evictionPolicy?: string | null; tls?: boolean; publicAccess?: boolean; service?: string };
  return cacheCompatibility({ clusterMode: p.clusterMode ?? null, evictionPolicy: p.evictionPolicy ?? null, tls: p.tls ?? null, publicAccess: p.publicAccess ?? null, service: p.service ?? null });
}

/** `rediss://[user]:<token>@<host>:<port>` (the token percent-encoded); plain `redis://` is never made. */
export function redisUrl(o: { host: string; port: number; token: string; username?: string | null }): string {
  const user = o.username ? encodeURIComponent(o.username) : '';
  return `rediss://${user}:${encodeURIComponent(o.token)}@${o.host.includes(':') ? `[${o.host}]` : o.host}:${o.port}`;
}

// ---------- the deployment's cache as REDIS_URL ----------

/** Where a deployment's wired data tier lives in the vault (platform scope). */
export const dataTierPath = (deploymentId: string): string => `cloud/deployments/${deploymentId.toLowerCase()}/data`;

/** What the adapter hands back for a cache it holds the password of (Azure keys, DigitalOcean's generated password). */
export interface CacheAccess {
  host: string;
  port: number;
  username: string | null;
  /** The provider's key or password; null when Exprsn-AI chose it (ElastiCache's AUTH token, in the vault). */
  token: string | null;
}

export const cacheIncompatible = (problems: CacheProblem[]) =>
  new HttpProblem(409, 'Conflict', `The cache cannot be the install's REDIS_URL: ${problems.map((p) => p.reason).join(' ')}`, { extensions: { reason: 'cache_incompatible', problems } });

export class CloudCaches {
  constructor(private readonly s: () => Services) {}

  private vault(): CloudVault {
    return new CloudVault(this.s);
  }

  /** The AUTH token Exprsn-AI chooses for an ElastiCache replication group: made once, kept in the vault. */
  async authToken(d: Pick<Deployment, 'id'>): Promise<string> {
    const path = dataTierPath(d.id);
    const v = this.vault();
    let have: Record<string, string> = {};
    try {
      have = await v.readAll(path);
    } catch {
      /* not made yet */
    }
    if (have.cache_auth_token) return have.cache_auth_token;
    // ElastiCache: 16 to 128 printable characters, no @, " or /; hex is all of that.
    const token = randomBytes(32).toString('hex');
    await v.write(path, { ...have, cache_auth_token: token });
    return token;
  }

  /**
   * Wires the deployment's managed cache as its `REDIS_URL`: the observed cache must pass the compatibility check
   * (else 409 `cache_incompatible` with the reasons, and the refusal is audited); the URL goes to the vault only.
   * Answers the reference the app's binding resolves.
   */
  async wire(d: Deployment, resource: GraphResource, actor: CloudAuditActor): Promise<{ ref: string; host: string; port: number }> {
    const s = this.s();
    if (resource.type !== 'cache' || !resource.observed || !resource.providerId) throw new HttpProblem(409, 'Conflict', `${resource.key} is not a cache that exists yet.`, { extensions: { reason: 'cache_not_ready' } });
    const problems = observedCompatibility(resource.observed);
    if (problems.length) {
      await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.cache.refused', actor, deploymentId: d.id, deploymentName: d.name, resource: { key: resource.key, type: 'cache', providerId: resource.providerId }, detail: { problems } });
      throw cacheIncompatible(problems);
    }
    const ctxs = await s.cloud.deployments.context(d, 'read');
    const provider = ctxs.provider as unknown as CloudProvider;
    if (!provider.cacheAccess) throw new HttpProblem(409, 'Conflict', `The ${d.provider} adapter cannot hand out a cache's address.`, { extensions: { reason: 'cache_access_unsupported' } });
    const access = await provider.cacheAccess(ctxs.ctx(resource.region), { type: 'cache', providerId: resource.providerId, ...(resource.region ? { region: resource.region } : {}), ...(resource.locator ? { locator: resource.locator } : {}) });
    const token = access.token ?? (await this.authToken(d));
    const path = dataTierPath(d.id);
    const v = this.vault();
    let have: Record<string, string> = {};
    try {
      have = await v.readAll(path);
    } catch {
      /* first value */
    }
    await v.write(path, { ...have, redis_url: redisUrl({ host: access.host, port: access.port, token, username: access.username }) });
    await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.cache.wired', actor, deploymentId: d.id, deploymentName: d.name, resource: { key: resource.key, type: 'cache', providerId: resource.providerId }, detail: { host: access.host, port: access.port, service: (resource.observed.props as { service?: string }).service ?? null } });
    return { ref: refOf(path, 'redis_url'), host: access.host, port: access.port };
  }
}
