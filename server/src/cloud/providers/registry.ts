import type { Config } from '../../config/index.js';
import { servicePolicy, type ServicePolicy } from '../../platform/egress.js';
import type { CounterStore } from '../../platform/ratelimit.js';
import type { Provider } from '../types.js';
import type { AwsEndpoints, AwsProvider } from './aws.js';
import type { AzureEndpoints, AzureProvider } from './azure.js';
import { AWS_CAPABILITIES, AZURE_CAPABILITIES, CF_CAPABILITIES, DO_CAPABILITIES, snapshotReason } from './capabilities.js';
import type { CloudflareEndpoints, CloudflareProvider } from './cloudflare.js';
import type { DigitalOceanEndpoints, DigitalOceanProvider } from './digitalocean.js';
import type { TransportMetrics, TransportOptions } from './transport.js';
import { RESOURCE_TYPES, type CapabilityTable, type CloudProvider, type ResourceOperation, type ResourceType, type Support } from './types.js';

/*
 * 1.9.99-final, Sprint 56 (B-10101): the provider adapters, one per provider, shared by the process (they hold no
 * account state: every call names its account and credential). `s.cloud.providers` is this registry and
 * `s.cloud.providerFor(kind)` its lookup. Building it calls nothing and loads no SDK: each adapter module (the AWS
 * SDK and the Azure clients are large) is imported on its first call, so nothing changes until a cloud account is
 * added and used. Capabilities answer at once from `capabilities.ts`.
 */

export interface ProviderEndpoints {
  aws?: AwsEndpoints;
  azure?: AzureEndpoints;
  digitalocean?: DigitalOceanEndpoints;
  cloudflare?: CloudflareEndpoints;
}

export interface ProviderRegistryOptions {
  policy: ServicePolicy;
  counters?: CounterStore;
  timeoutMs?: number;
  endpoints?: ProviderEndpoints;
  /** Transport settings for every adapter (tests: a fast `sleep`, `testOrigins`). */
  transport?: Omit<TransportOptions, 'provider' | 'policy' | 'counters'>;
}

interface Adapters {
  aws: AwsProvider;
  azure: AzureProvider;
  digitalocean: DigitalOceanProvider;
  cloudflare: CloudflareProvider;
}

const TABLES: Record<Provider, CapabilityTable> = { aws: AWS_CAPABILITIES, azure: AZURE_CAPABILITIES, digitalocean: DO_CAPABILITIES, cloudflare: CF_CAPABILITIES };

/** `supports` from a capability table alone. */
export function supportOf(table: CapabilityTable, type: ResourceType, op?: ResourceOperation): Support {
  const c = table[type];
  if (c.support !== 'built') return c.support;
  return !op || c.operations.includes(op) ? 'built' : 'not_yet';
}

/** An adapter that loads its module on first use; every method is the loaded adapter's. */
class LazyProvider<K extends Provider> implements CloudProvider {
  readonly capabilities: CapabilityTable;
  constructor(
    readonly kind: K,
    private readonly load: () => Promise<Adapters[K]>
  ) {
    this.capabilities = TABLES[kind];
  }
  supports(type: ResourceType, op?: ResourceOperation): Support {
    return supportOf(this.capabilities, type, op);
  }
  identity: CloudProvider['identity'] = async (...a) => (await this.load()).identity(...a);
  checkPermissions: CloudProvider['checkPermissions'] = async (...a) => (await this.load()).checkPermissions(...a);
  find: CloudProvider['find'] = async (...a) => (await this.load()).find(...a);
  describe: CloudProvider['describe'] = async (...a) => (await this.load()).describe(...a);
  list: CloudProvider['list'] = async (...a) => (await this.load()).list(...a);
  create: CloudProvider['create'] = async (...a) => (await this.load()).create(...a);
  update: CloudProvider['update'] = async (...a) => (await this.load()).update(...a);
  delete: CloudProvider['delete'] = async (...a) => (await this.load()).delete(...a);
  poll: CloudProvider['poll'] = async (...a) => (await this.load()).poll(...a);
  /** B-10107: from the table, without loading the adapter. */
  snapshotSupport(type: ResourceType): string | null {
    return snapshotReason(this.kind, type);
  }
  snapshot: NonNullable<CloudProvider['snapshot']> = async (...a) => {
    const p = (await this.load()) as CloudProvider;
    if (!p.snapshot) throw new Error(snapshotReason(this.kind, a[1].type) ?? 'no snapshot');
    return p.snapshot(...a);
  };
  snapshotStatus: NonNullable<CloudProvider['snapshotStatus']> = async (...a) => {
    const p = (await this.load()) as CloudProvider;
    if (!p.snapshotStatus) throw new Error(snapshotReason(this.kind, a[1].type) ?? 'no snapshot');
    return p.snapshotStatus(...a);
  };
  /** B-10207: a snapshot restored onto its resource (after a second admin's approval); the adapter's, when it has one. */
  restoreSnapshot: NonNullable<CloudProvider['restoreSnapshot']> = async (...a) => {
    const p = (await this.load()) as CloudProvider;
    if (!p.restoreSnapshot) throw new Error(`This build cannot restore a ${a[1].type.replace(/_/g, ' ')} snapshot on ${this.kind}.`);
    return p.restoreSnapshot(...a);
  };
  /** Sprint 59 (B-10307): a database's snapshots and backups; deleting one Exprsn-AI took (past a schedule's retention). */
  listSnapshots: NonNullable<CloudProvider['listSnapshots']> = async (...a) => {
    const p = (await this.load()) as CloudProvider;
    if (!p.listSnapshots) throw new Error(`This build lists no ${a[1].type.replace(/_/g, ' ')} snapshots on ${this.kind}.`);
    return p.listSnapshots(...a);
  };
  deleteSnapshot: NonNullable<CloudProvider['deleteSnapshot']> = async (...a) => {
    const p = (await this.load()) as CloudProvider;
    if (!p.deleteSnapshot) throw new Error(`This build deletes no ${a[1].type.replace(/_/g, ' ')} snapshots on ${this.kind}.`);
    return p.deleteSnapshot(...a);
  };
  /** Sprint 59 (B-10301): the extension check of a PostgreSQL database. */
  databaseExtensions: NonNullable<CloudProvider['databaseExtensions']> = async (...a) => {
    const p = (await this.load()) as CloudProvider;
    if (!p.databaseExtensions) throw new Error(`This build checks no database extensions on ${this.kind}.`);
    return p.databaseExtensions(...a);
  };
  /** B-10204: what the installer reported on a VM's console; unknown where the adapter has no console read. */
  vmInstallStatus: NonNullable<CloudProvider['vmInstallStatus']> = async (...a) => {
    const p = (await this.load()) as CloudProvider;
    if (!p.vmInstallStatus) return { state: 'unknown', detail: `${this.kind} offers no console read, so the installer's result is not known; the app's /readyz decides.` };
    return p.vmInstallStatus(...a);
  };
  /** B-10305 (Sprint 59): a cache's address and the provider's key for it, for `cloud/caches.ts` only. */
  cacheAccess: NonNullable<CloudProvider['cacheAccess']> = async (...a) => {
    const p = (await this.load()) as CloudProvider;
    if (!p.cacheAccess) throw new Error(`This build hands out no cache address on ${this.kind}.`);
    return p.cacheAccess(...a);
  };
  /** B-10302 (Sprint 59): a managed database's CA bundle where the provider publishes one per cluster (DigitalOcean). */
  databaseCa: NonNullable<CloudProvider['databaseCa']> = async (...a) => {
    const p = (await this.load()) as CloudProvider;
    if (!p.databaseCa) throw new Error(`${this.kind} publishes no per-database CA through its API; the CA bundle comes from the provider's published bundle.`);
    return p.databaseCa(...a);
  };
  /** B-10203: short-lived access to a Kubernetes cluster's API. */
  kubeAccess: NonNullable<CloudProvider['kubeAccess']> = async (...a) => {
    const p = (await this.load()) as CloudProvider;
    if (!p.kubeAccess) throw new Error(`${this.kind} has no Kubernetes clusters.`);
    return p.kubeAccess(...a);
  };
}

export class ProviderRegistry {
  private readonly loaded: Partial<Adapters> = {};
  private readonly loading: Partial<Record<Provider, Promise<unknown>>> = {};
  private readonly facades: { [K in Provider]: LazyProvider<K> };
  private endpoints: ProviderEndpoints;

  constructor(private readonly o: ProviderRegistryOptions) {
    this.endpoints = { ...(o.endpoints ?? {}) };
    this.facades = {
      aws: new LazyProvider('aws', () => this.adapter('aws')),
      azure: new LazyProvider('azure', () => this.adapter('azure')),
      digitalocean: new LazyProvider('digitalocean', () => this.adapter('digitalocean')),
      cloudflare: new LazyProvider('cloudflare', () => this.adapter('cloudflare'))
    };
  }

  private base() {
    return { policy: this.o.policy, ...(this.o.counters ? { counters: this.o.counters } : {}), ...(this.o.timeoutMs ? { timeoutMs: this.o.timeoutMs } : {}), ...(this.o.transport ?? {}) };
  }

  /** The loaded adapter itself (its transport's statistics, `setEndpoints`). */
  async adapter<K extends Provider>(kind: K): Promise<Adapters[K]> {
    const have = this.loaded[kind];
    if (have) return have;
    this.loading[kind] ??= (async () => {
      const base = this.base();
      let a: Adapters[Provider];
      if (kind === 'aws') a = new (await import('./aws.js')).AwsProvider({ ...base, ...(this.endpoints.aws ? { endpoints: this.endpoints.aws } : {}) });
      else if (kind === 'azure') a = new (await import('./azure.js')).AzureProvider({ ...base, ...(this.endpoints.azure ? { endpoints: this.endpoints.azure } : {}) });
      else if (kind === 'digitalocean') a = new (await import('./digitalocean.js')).DigitalOceanProvider({ ...base, ...(this.endpoints.digitalocean ? { endpoints: this.endpoints.digitalocean } : {}) });
      else a = new (await import('./cloudflare.js')).CloudflareProvider({ ...base, ...(this.endpoints.cloudflare ? { endpoints: this.endpoints.cloudflare } : {}) });
      (this.loaded as Record<Provider, unknown>)[kind] = a;
      return a;
    })();
    return (await this.loading[kind]) as Adapters[K];
  }

  providerFor(kind: Provider): CloudProvider {
    return this.facades[kind];
  }

  /** Every provider's capability table (for the planner, the console and `docs/cloud.md`). */
  capabilities(): Record<Provider, CapabilityTable> {
    return { ...TABLES };
  }

  /** Points the adapters at other endpoints (tests: the fakes), now or when they load. */
  setEndpoints(e: ProviderEndpoints): void {
    this.endpoints = { ...this.endpoints, ...e };
    if (e.aws) this.loaded.aws?.setEndpoints(e.aws);
    if (e.azure) this.loaded.azure?.setEndpoints(e.azure);
    if (e.digitalocean) this.loaded.digitalocean?.setEndpoints(e.digitalocean);
    if (e.cloudflare) this.loaded.cloudflare?.setEndpoints(e.cloudflare);
  }
}

/** The registry `s.cloud` holds, under the operator's service policy and the shared counters. */
export function createProviderRegistry(cfg: Pick<Config, 'SERVICE_ALLOWED_HOSTS' | 'SERVICE_INTERNAL_ONLY'> & { CLOUD_HTTP_TIMEOUT_MS?: number }, counters?: CounterStore, endpoints?: ProviderEndpoints, metrics?: TransportMetrics): ProviderRegistry {
  return new ProviderRegistry({ policy: servicePolicy(cfg), ...(counters ? { counters } : {}), ...(cfg.CLOUD_HTTP_TIMEOUT_MS ? { timeoutMs: cfg.CLOUD_HTTP_TIMEOUT_MS } : {}), ...(endpoints ? { endpoints } : {}), ...(metrics ? { transport: { metrics } } : {}) });
}

let registry: ProviderRegistry | null = null;

/** An adapter from a process-wide registry under the default policy (no shared counters); `s.cloud.providerFor` is the configured one. */
export function providerFor(kind: Provider): CloudProvider {
  registry ??= new ProviderRegistry({ policy: servicePolicy({}) });
  return registry.providerFor(kind);
}

/** The capability tables as rows (provider, type, support, native, operations), for documentation and the console. */
export function capabilityRows(tables: Record<Provider, CapabilityTable> = TABLES): { provider: Provider; type: string; support: string; native: string; operations: string; note: string }[] {
  return (Object.keys(tables) as Provider[]).flatMap((p) => RESOURCE_TYPES.map((t) => ({ provider: p, type: t, support: tables[p][t].support, native: tables[p][t].native, operations: tables[p][t].operations.join(', '), note: tables[p][t].note ?? '' })));
}
