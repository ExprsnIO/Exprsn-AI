import { createHash } from 'node:crypto';
import { AuthorizationManagementClient } from '@azure/arm-authorization';
import { DnsManagementClient, type RecordSet } from '@azure/arm-dns';
import { NetworkManagementClient, type NetworkSecurityGroup, type SecurityRule, type Subnet, type VirtualNetwork } from '@azure/arm-network';
import { ResourceManagementClient } from '@azure/arm-resources';
import { StorageManagementClient, type StorageAccount } from '@azure/arm-storage';
import type { AccessToken, TokenCredential } from '@azure/core-auth';
import { createPipelineRequest, type Pipeline } from '@azure/core-rest-pipeline';
import { FEATURES_BY_PROVIDER, type CloudAccount, type CloudFeature, type IdentityResult, type PermissionCheck } from '../types.js';
import { namePrefix } from '../tags.js';
import { azureHttpClient } from './sdk-bridges.js';
import { AZURE_CAPABILITIES, AZURE_FEATURE_ACTIONS, snapshotReason } from './capabilities.js';
import { AksResources } from './azure-aks.js';
import { isKubeType } from './kubernetes.js';
import { CloudTransport, type TransportOptions } from './transport.js';
import { AzureCompute } from './azure-compute.js';
import { AzureCaches } from './azure-cache.js';
import { AzureDatabases } from './azure-databases.js';
import type { CacheAccess } from '../caches.js';
import {
  assertAccount,
  CloudProviderError,
  CloudUnsupported,
  type AdapterCredential,
  type CallContext,
  type ChangeEvent,
  type ChangeTrailQuery,
  type ClusterAccess,
  type CloudProvider,
  type FirewallRule,
  type InstallStatus,
  type ListFilter,
  type ObservedResource,
  type OperationHandle,
  type OperationResult,
  type PollResult,
  type ResourceOperation,
  type ResourceRef,
  type ResourceSpec,
  type ResourceType,
  type Support,
  type DatabaseSnapshot,
  type ExtensionStatus,
  type SnapshotPurpose,
  type SnapshotResult
} from './types.js';

/*
 * 1.9.99-final, Sprint 56 (B-10101): the Azure adapter, on the `@azure/arm-*` clients (resources, network, storage,
 * DNS, authorization) with a `TokenCredential` over the account's credential (`cloud/credentials.ts` buys the Entra
 * tokens) and `azureHttpClient` as every client's `httpClient`, so every request, the pipeline's own polls and
 * redirects included, goes through `CloudTransport`. The pipeline's retries are off (`maxRetries: 0`); the transport
 * retries throttled calls. The ARM token scope is always `https://management.azure.com/.default`, whatever endpoint the
 * client is pointed at.
 *
 * Idempotency is Azure's own: every create is a PUT by a name we choose, in the account's managed resource group
 * (`exprsn-<account>`, created on first use and tagged). Long-running operations: the initial PUT or DELETE is sent
 * (`submitted()`), the `Azure-AsyncOperation` or `Location` URL it answered with becomes the journalled handle, and
 * `poll` reads it (only on the ARM endpoint's own origin) until Succeeded, Failed or Canceled.
 */

export interface AzureEndpoints {
  /** Azure Resource Manager (default `https://management.azure.com`). */
  arm?: string;
}

export const ARM_SCOPE = 'https://management.azure.com/.default';


const API = { subscription: '2022-12-01', permissions: '2022-04-01', activityLog: '2015-04-01' };
/** Sprint 62 (B-10703): at most this many pages of the Activity Log per lookup. */
const ACTIVITY_PAGES = 3;

export interface AzureProviderOptions extends Omit<TransportOptions, 'provider'> {
  endpoints?: AzureEndpoints;
}

type ClientOpts = Record<string, unknown>;

const tokens = new WeakMap<object, Map<string, { token: string; expiresAt: number }>>();

/**
 * A `TokenCredential` over the account's credential. Tokens are reused per credential object and scope until two
 * minutes before they expire (the clients are built per call, so their own policy caches would not last).
 */
export function tokenCredential(cred: AdapterCredential): TokenCredential {
  if (cred.kind !== 'azure') throw new CloudProviderError('An Azure account needs an Azure credential.', 'azure', 400, 'wrong_credential');
  return {
    async getToken(scopes): Promise<AccessToken> {
      const scope = (Array.isArray(scopes) ? scopes[0] : scopes) ?? ARM_SCOPE;
      let cache = tokens.get(cred);
      if (!cache) tokens.set(cred, (cache = new Map()));
      let t = cache.get(scope);
      if (!t || t.expiresAt - 120_000 < Date.now()) {
        t = await cred.getToken(scope);
        cache.set(scope, t);
      }
      return { token: t.token, expiresOnTimestamp: t.expiresAt, tokenType: 'Bearer' };
    }
  };
}

/** Sprint 62 (B-10703): one page of the Activity Log (`eventtypes/management/values`). */
interface ActivityPage {
  value?: { caller?: string; eventTimestamp?: string; operationName?: { value?: string }; status?: { value?: string }; eventDataId?: string; correlationId?: string; resourceProviderName?: { value?: string }; httpRequest?: { clientIpAddress?: string }; claims?: Record<string, string> }[];
  nextLink?: string;
  error?: { code?: string; message?: string };
}

interface Captured {
  status?: number;
  headers: Record<string, string>;
}

export class AzureProvider implements CloudProvider {
  readonly kind = 'azure' as const;
  readonly capabilities = AZURE_CAPABILITIES;
  readonly transport: CloudTransport;
  private endpoints: AzureEndpoints;

  /** Sprint 58 (B-10204, B-10205): virtual machines and Container Apps (`azure-compute.ts`). */
  private readonly compute: AzureCompute;
  /** Sprint 59 (B-10305): Azure Cache for Redis and Azure Managed Redis (`azure-cache.ts`). */
  private readonly caches: AzureCaches;
  /** Sprint 59 (B-10301, B-10303, B-10307): PostgreSQL and MySQL Flexible Servers (`azure-databases.ts`). */
  private readonly databases: AzureDatabases;

  constructor(o: AzureProviderOptions) {
    const { endpoints, ...t } = o;
    this.transport = new CloudTransport({ ...t, provider: 'azure' });
    this.endpoints = endpoints ?? {};
    this.compute = new AzureCompute({
      transport: this.transport,
      arm: () => this.arm,
      pipeline: (ctx) => this.resources(ctx).pipeline,
      subscription: (ctx) => this.subscription(ctx.account),
      rg: (ctx) => this.rg(ctx),
      location: (ctx, spec) => this.location(ctx, spec),
      ensureGroup: (ctx, spec) => this.ensureGroup(ctx, spec)
    });
    this.caches = new AzureCaches({
      transport: this.transport,
      arm: () => this.arm,
      pipeline: (ctx) => this.resources(ctx).pipeline,
      subscription: (ctx) => this.subscription(ctx.account),
      rg: (ctx) => this.rg(ctx),
      location: (ctx, spec) => this.location(ctx, spec),
      ensureGroup: (ctx, spec) => this.ensureGroup(ctx, spec)
    });
    this.databases = new AzureDatabases({
      transport: this.transport,
      arm: () => this.arm,
      pipeline: (ctx) => this.resources(ctx).pipeline,
      subscription: (ctx) => this.subscription(ctx.account),
      rg: (ctx) => this.rg(ctx),
      location: (ctx, spec) => this.location(ctx, spec),
      ensureGroup: (ctx, spec) => this.ensureGroup(ctx, spec)
    });
  }

  /** B-10307: database snapshots (on-demand backups, or a retained copy as the final one); nothing else here takes one. */
  snapshotSupport(type: ResourceType): string | null {
    return snapshotReason('azure', type);
  }

  async snapshot(ctx: CallContext, ref: ResourceRef, name: string, o?: { purpose?: SnapshotPurpose }): Promise<SnapshotResult> {
    const why = snapshotReason('azure', ref.type);
    if (why) throw new CloudUnsupported('azure', ref.type, 'not_yet', undefined, why);
    return this.databases.snapshot(ctx, ref, name, o?.purpose ?? 'final');
  }

  async snapshotStatus(ctx: CallContext, ref: ResourceRef, pending: SnapshotResult): Promise<SnapshotResult> {
    return this.databases.snapshotStatus(ctx, ref, pending);
  }

  async listSnapshots(ctx: CallContext, ref: ResourceRef): Promise<DatabaseSnapshot[]> {
    this.assertBuilt('database', 'describe');
    return this.databases.listSnapshots(ctx, ref);
  }

  async deleteSnapshot(ctx: CallContext, ref: ResourceRef, snapshotId: string): Promise<void> {
    this.assertBuilt('database', 'delete');
    return this.databases.deleteSnapshot(ctx, ref, snapshotId);
  }

  /** B-10307: a database snapshot restored to a new server. */
  async restoreSnapshot(ctx: CallContext, ref: ResourceRef, snapshotId: string, o?: { name?: string; tags?: Record<string, string> }): Promise<SnapshotResult> {
    this.assertBuilt('database', 'create');
    return this.databases.restore(ctx, ref, snapshotId, o);
  }

  /** B-10301: the extension check (`azure.extensions`, the allow-list). */
  async databaseExtensions(ctx: CallContext, ref: ResourceRef, wanted: string[]): Promise<ExtensionStatus[]> {
    this.assertBuilt('database', 'describe');
    return this.databases.extensions(ctx, ref, wanted);
  }

  /** B-10305: a cache's host, TLS port and primary access key (`listKeys`), for `cloud/caches.ts` only. */
  async cacheAccess(ctx: CallContext, ref: ResourceRef): Promise<CacheAccess> {
    this.assertBuilt('cache', 'describe');
    return this.caches.access(ctx, ref);
  }

  setEndpoints(e: AzureEndpoints): void {
    this.endpoints = { ...e };
  }

  get arm(): string {
    return (this.endpoints.arm ?? 'https://management.azure.com').replace(/\/$/, '');
  }

  supports(type: ResourceType, op?: ResourceOperation): Support {
    const c = this.capabilities[type];
    if (c.support !== 'built') return c.support;
    return !op || c.operations.includes(op) ? 'built' : 'not_yet';
  }

  /**
   * B-10703 (Sprint 62): the Activity Log's administrative events for one resource in a window
   * (`Microsoft.Insights/eventtypes/management/values`, filtered by `resourceUri`), writes and deletes only, newest
   * first. Needs `Microsoft.Insights/eventtypes/values/read` (Reader on the subscription holds it).
   */
  async changeEvents(ctx: CallContext, q: ChangeTrailQuery): Promise<ChangeEvent[]> {
    const sub = this.subscription(ctx.account);
    const iso = (t: number) => new Date(t).toISOString();
    const filter = `eventTimestamp ge '${iso(q.from)}' and eventTimestamp le '${iso(q.to)}' and resourceUri eq '${q.providerId.replace(/'/g, "''")}'`;
    let url: string | null = `${this.arm}/subscriptions/${encodeURIComponent(sub)}/providers/Microsoft.Insights/eventtypes/management/values?api-version=${API.activityLog}&$filter=${encodeURIComponent(filter)}`;
    const pipeline = this.resources(ctx).pipeline;
    const limit = q.limit ?? 20;
    const out: ChangeEvent[] = [];
    for (let page = 0; url && page < ACTIVITY_PAGES && out.length < limit; page++) {
      const r: { status: number; body: ActivityPage; headers: Record<string, string> } = await this.armGet<ActivityPage>(pipeline, ctx.account, url);
      if (r.status >= 300) throw new CloudProviderError(`Azure answered ${r.status} for the Activity Log${r.body?.error?.code ? ` (${r.body.error.code})` : ''}: ${String(r.body?.error?.message ?? 'no detail').slice(0, 300)}`, 'azure', r.status, r.body?.error?.code ?? null, r.headers['x-ms-request-id'] ?? null);
      for (const e of r.body.value ?? []) {
        const action = e.operationName?.value ?? '';
        const status = e.status?.value ?? '';
        if (!action || /\/read$/i.test(action) || (status && !/^(Succeeded|Accepted|Started)$/i.test(status))) continue;
        const at = Date.parse(e.eventTimestamp ?? '');
        if (!Number.isFinite(at) || !e.caller) continue;
        out.push({ at, principal: e.caller, principalType: e.claims?.idtyp ?? (/@/.test(e.caller) ? 'user' : 'servicePrincipal'), action, source: e.resourceProviderName?.value ?? action.split('/')[0] ?? 'Microsoft.Resources', eventId: e.eventDataId ?? e.correlationId ?? null, sourceIp: e.httpRequest?.clientIpAddress ?? null });
      }
      url = r.body.nextLink ?? null;
    }
    // A long-running write logs Started, then Succeeded: one change, kept once (its latest record).
    const seen = new Set<string>();
    return out
      .sort((a, b) => b.at - a.at)
      .filter((e) => {
        const k = `${e.principal}|${e.action}|${Math.floor(e.at / 60_000)}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, limit);
  }

  // ---------- clients ----------

  private subscription(account: CloudAccount): string {
    assertAccount('azure', account);
    const sub = account.providerIds.azureSubscriptionId;
    if (!sub) throw new CloudProviderError(`The account ${account.name} has no Azure subscription id.`, 'azure', 400, 'no_subscription');
    return sub;
  }

  private opts(account: CloudAccount): ClientOpts {
    const insecure = this.arm.startsWith('http:');
    return {
      endpoint: this.arm,
      $host: this.arm,
      httpClient: azureHttpClient(this.transport, account.id),
      retryOptions: { maxRetries: 0 },
      credentials: { scopes: [ARM_SCOPE] },
      credentialScopes: [ARM_SCOPE],
      ...(insecure ? { allowInsecureConnection: true } : {})
    };
  }

  private resources(ctx: { cred: AdapterCredential; account: CloudAccount }) {
    return new ResourceManagementClient(tokenCredential(ctx.cred), this.subscription(ctx.account), this.opts(ctx.account));
  }
  private network(ctx: CallContext) {
    return new NetworkManagementClient(tokenCredential(ctx.cred), this.subscription(ctx.account), this.opts(ctx.account));
  }
  private storage(ctx: CallContext) {
    return new StorageManagementClient(tokenCredential(ctx.cred), this.subscription(ctx.account), this.opts(ctx.account));
  }
  private dns(ctx: CallContext) {
    return new DnsManagementClient(tokenCredential(ctx.cred), this.subscription(ctx.account), this.opts(ctx.account));
  }
  private authorization(cred: AdapterCredential, account: CloudAccount) {
    return new AuthorizationManagementClient(tokenCredential(cred), this.subscription(account), this.opts(account));
  }

  /** A raw ARM GET through a client's pipeline (token policy and all), for what no typed client covers. */
  private async armGet<T>(pipeline: Pipeline, account: CloudAccount, url: string): Promise<{ status: number; body: T; headers: Record<string, string> }> {
    const target = new URL(url, `${this.arm}/`);
    if (target.origin !== new URL(this.arm).origin) throw new CloudProviderError(`Refusing to follow an operation URL off the ARM endpoint (${target.host}).`, 'azure', 502, 'foreign_operation_url');
    const req = createPipelineRequest({ url: target.toString(), method: 'GET', ...(target.protocol === 'http:' ? { allowInsecureConnection: true } : {}) });
    const res = await pipeline.sendRequest(azureHttpClient(this.transport, account.id), req);
    const headers = res.headers.toJSON();
    let body: unknown = null;
    if (res.bodyAsText) {
      try {
        body = JSON.parse(res.bodyAsText);
      } catch {
        body = res.bodyAsText;
      }
    }
    return { status: res.status, body: body as T, headers };
  }

  /** Sprint 58 (B-10203): AKS clusters, agent pools and the cluster's load balancer (`azure-aks.ts`), on this adapter's transport. */
  private get kube(): AksResources {
    return (this.aks ??= new AksResources({
      transport: this.transport,
      arm: () => this.arm,
      token: async (ctx, scope) => (await tokenCredential(ctx.cred).getToken(scope ?? ARM_SCOPE))!.token,
      principalId: (ctx) => this.principal(ctx.cred),
      subscription: (ctx) => this.subscription(ctx.account),
      resourceGroup: (ctx) => this.rg(ctx),
      location: (ctx, spec) => this.location(ctx, spec),
      ensureGroup: (ctx, spec) => this.ensureGroup(ctx, spec)
    }));
  }
  private aks: AksResources | null = null;

  /** B-10203: an AKS cluster's server, CA and a short-lived Entra token for its API. */
  async kubeAccess(ctx: CallContext, ref: ResourceRef): Promise<ClusterAccess> {
    this.assertBuilt('kubernetes_cluster', 'describe');
    return this.kube.access(ctx, ref);
  }

  private rg(ctx: CallContext): string {
    return ctx.resourceGroup ?? `exprsn-${ctx.account.name}`;
  }

  private location(ctx: CallContext, spec?: ResourceSpec): string {
    return spec?.region ?? ctx.region ?? ctx.account.defaultRegion ?? 'westeurope';
  }

  private async ensureGroup(ctx: CallContext, spec: ResourceSpec): Promise<string> {
    const name = this.rg(ctx);
    await this.resources(ctx)
      .resourceGroups.createOrUpdate(name, { location: this.location(ctx, spec), tags: { ...spec.tags } })
      .catch((err) => {
        throw azureError(err);
      });
    return name;
  }

  // ---------- identity and permissions ----------

  async identity(cred: AdapterCredential, account: CloudAccount): Promise<IdentityResult> {
    const sub = this.subscription(account);
    try {
      const r = await this.armGet<{ subscriptionId?: string; tenantId?: string; state?: string; displayName?: string; error?: { code?: string; message?: string } }>(this.resources({ cred, account }).pipeline, account, `${this.arm}/subscriptions/${encodeURIComponent(sub)}?api-version=${API.subscription}`);
      const requestId = r.headers['x-ms-request-id'];
      if (r.status === 429 || r.status >= 500) throw new CloudProviderError(`Azure answered ${r.status} for the subscription.`, 'azure', r.status, r.body?.error?.code ?? null, requestId ?? null, r.status === 429 ? Math.ceil((this.transport.retryAfterMs({ headers: r.headers }) ?? 1000) / 1000) : null);
      if (r.status !== 200) return { ok: false, error: `Azure refused the subscription read (${r.body?.error?.code ?? r.status}): ${r.body?.error?.message ?? 'no detail'}`, ...(requestId ? { requestId } : {}) };
      if (r.body.state && r.body.state !== 'Enabled') return { ok: false, providerAccount: r.body.subscriptionId, error: `The subscription is ${r.body.state}.`, ...(requestId ? { requestId } : {}) };
      const principal = await this.principal(cred);
      return { ok: true, principal: principal ?? `tenant ${r.body.tenantId ?? (cred as { tenantId: string }).tenantId}`, providerAccount: r.body.subscriptionId, ...(requestId ? { requestId } : {}) };
    } catch (err) {
      const e = azureError(err);
      if (e.status === 401 || e.status === 403) return { ok: false, error: `Azure refused the credential: ${e.message}` };
      throw e;
    }
  }

  /** The service principal's object id from the ARM token's claims, when the token is a readable JWT. */
  private async principal(cred: AdapterCredential): Promise<string | null> {
    try {
      const t = await tokenCredential(cred).getToken(ARM_SCOPE);
      const part = t?.token.split('.')[1];
      if (!part) return null;
      const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { oid?: string; appid?: string; azp?: string };
      return claims.oid ?? claims.appid ?? claims.azp ?? null;
    } catch {
      return null;
    }
  }

  async checkPermissions(cred: AdapterCredential, account: CloudAccount, features: CloudFeature[]): Promise<PermissionCheck[]> {
    const offered = FEATURES_BY_PROVIDER.azure;
    const sub = this.subscription(account);
    const wanted = features.filter((f) => offered.includes(f) && AZURE_FEATURE_ACTIONS[f]);
    let grants: { actions: string[]; notActions: string[] }[] = [];
    if (wanted.length) {
      const r = await this.armGet<{ value?: { actions?: string[]; notActions?: string[] }[]; error?: { code?: string; message?: string } }>(this.resources({ cred, account }).pipeline, account, `${this.arm}/subscriptions/${encodeURIComponent(sub)}/providers/Microsoft.Authorization/permissions?api-version=${API.permissions}`);
      if (r.status === 429 || r.status >= 500) throw new CloudProviderError(`Azure answered ${r.status} for the permissions list.`, 'azure', r.status, r.body?.error?.code ?? null, r.headers['x-ms-request-id'] ?? null);
      if (r.status !== 200) return features.map((f) => (wanted.includes(f) ? { feature: f, required: AZURE_FEATURE_ACTIONS[f]!, missing: [], error: `The permissions list was refused (${r.body?.error?.code ?? r.status}).` } : { feature: f, required: [], missing: [], unsupported: true }));
      grants = (r.body.value ?? []).map((p) => ({ actions: p.actions ?? [], notActions: p.notActions ?? [] }));
      // Contributor on the managed resource group (B-10004) shows only at that scope.
      const missingAnywhere = wanted.some((f) => AZURE_FEATURE_ACTIONS[f]!.some((a) => !allowedBy(grants, a)));
      if (missingAnywhere) {
        try {
          for await (const p of this.authorization(cred, account).permissions.listForResourceGroup(`exprsn-${account.name}`)) grants.push({ actions: p.actions ?? [], notActions: p.notActions ?? [] });
        } catch {
          /* the managed group may not exist yet */
        }
      }
    }
    return features.map((f) => {
      if (!wanted.includes(f)) return { feature: f, required: [], missing: [], unsupported: true };
      const required = AZURE_FEATURE_ACTIONS[f]!;
      return { feature: f, required, missing: required.filter((a) => !allowedBy(grants, a)) };
    });
  }

  // ---------- resources ----------

  private assertBuilt(type: ResourceType, op: ResourceOperation): void {
    const s = this.supports(type, op);
    if (s !== 'built') throw new CloudUnsupported('azure', type, s, op, this.capabilities[type].note);
  }

  private idFor(ctx: CallContext, spec: ResourceSpec): string {
    const sub = this.subscription(ctx.account);
    const rg = this.rg(ctx);
    const base = `/subscriptions/${sub}/resourceGroups/${rg}/providers`;
    switch (spec.type) {
      case 'network':
        return `${base}/Microsoft.Network/virtualNetworks/${this.armName(ctx, spec)}`;
      case 'subnet':
        if (!spec.parent?.networkId) throw new CloudProviderError('A subnet needs its network (parent.networkId).', 'azure', 400, 'parent_required');
        return `${spec.parent.networkId}/subnets/${this.armName(ctx, spec)}`;
      case 'firewall':
        return `${base}/Microsoft.Network/networkSecurityGroups/${this.armName(ctx, spec)}`;
      case 'bucket':
        return `${base}/Microsoft.Storage/storageAccounts/${storageName(ctx.account, spec as ResourceSpec<'bucket'>)}`;
      case 'dns_record': {
        const p = (spec as ResourceSpec<'dns_record'>).props;
        return `/subscriptions/${sub}/resourceGroups/${p.zoneGroup ?? rg}/providers/Microsoft.Network/dnsZones/${p.zone}/${p.recordType}/${p.record || '@'}`;
      }
    }
    throw new CloudUnsupported('azure', spec.type, 'not_yet');
  }

  private armName(ctx: CallContext, spec: ResourceSpec): string {
    return `${namePrefix(ctx.account.name)}${spec.name}`;
  }

  async find(ctx: CallContext, spec: ResourceSpec): Promise<ObservedResource | null> {
    this.assertBuilt(spec.type, 'describe');
    if (isKubeType(spec.type)) return this.kube.find(ctx, spec);
    if (spec.type === 'cache') return this.caches.find(ctx, spec);
    if (spec.type === 'database') return this.databases.find(ctx, spec);
    if (spec.type === 'vm') return this.compute.describeVm(ctx, { type: 'vm', providerId: this.compute.vmId(ctx, spec) });
    if (spec.type === 'container_service') return this.compute.findApp(ctx, spec);
    // A subnet whose network does not exist yet cannot exist either (refresh before the first apply).
    if (spec.type === 'subnet' && !spec.parent?.networkId) return null;
    return this.describe(ctx, { type: spec.type, providerId: this.idFor(ctx, spec) });
  }

  async describe(ctx: CallContext, ref: ResourceRef): Promise<ObservedResource | null> {
    this.assertBuilt(ref.type, 'describe');
    if (isKubeType(ref.type)) return this.kube.describe(ctx, ref);
    if (ref.type === 'cache') return this.caches.describe(ctx, ref);
    if (ref.type === 'database') return this.databases.describe(ctx, ref);
    if (ref.type === 'vm') return this.compute.describeVm(ctx, ref);
    if (ref.type === 'container_service') return this.compute.describeApp(ctx, ref);
    const id = parseId(ref.providerId);
    try {
      switch (ref.type) {
        case 'network':
          return vnetObserved(await this.network(ctx).virtualNetworks.get(id.rg, id.names[0]!));
        case 'subnet':
          return subnetObserved(await this.network(ctx).subnets.get(id.rg, id.names[0]!, id.names[1]!), ref.providerId);
        case 'firewall':
          return nsgObserved(await this.network(ctx).networkSecurityGroups.get(id.rg, id.names[0]!));
        case 'bucket':
          return storageObserved(await this.storage(ctx).storageAccounts.getProperties(id.rg, id.names[0]!));
        case 'dns_record': {
          const r = await this.dns(ctx).recordSets.get(id.rg, id.names[0]!, id.names[2]!, id.names[1]! as never);
          return recordObserved(r, ref.providerId, id.names[0]!);
        }
      }
    } catch (err) {
      const e = azureError(err);
      if (e.status === 404) return null;
      throw e;
    }
    return null;
  }

  async list(ctx: CallContext, type: ResourceType, filter: ListFilter = {}): Promise<ObservedResource[]> {
    this.assertBuilt(type, 'list');
    if (type === 'kubernetes_cluster' || type === 'node_group' || type === 'load_balancer') return this.kube.list(ctx, type, filter);
    if (type === 'cache') return this.caches.list(ctx, filter);
    if (type === 'database') return this.databases.list(ctx, filter);
    if (type === 'vm') return this.compute.listVms(ctx, !!filter.managedOnly);
    if (type === 'container_service') return this.compute.listApps(ctx, !!filter.managedOnly);
    const rg = this.rg(ctx);
    const out: ObservedResource[] = [];
    const keep = (o: ObservedResource) => !filter.managedOnly || (o.tags['exprsn:managed'] === 'true' && o.tags['exprsn:account'] === ctx.account.name);
    try {
      switch (type) {
        case 'network':
          for await (const v of this.network(ctx).virtualNetworks.list(rg)) out.push(vnetObserved(v));
          break;
        case 'subnet': {
          if (!filter.networkId) throw new CloudProviderError('Listing subnets needs the network.', 'azure', 400, 'network_required');
          const id = parseId(filter.networkId);
          for await (const s of this.network(ctx).subnets.list(id.rg, id.names[0]!)) out.push(subnetObserved(s, s.id!));
          return out;
        }
        case 'firewall':
          for await (const g of this.network(ctx).networkSecurityGroups.list(rg)) out.push(nsgObserved(g));
          break;
        case 'bucket':
          for await (const a of this.storage(ctx).storageAccounts.listByResourceGroup(rg)) out.push(storageObserved(a));
          break;
        case 'dns_record': {
          if (!filter.zone) throw new CloudProviderError('Listing DNS records needs the zone.', 'azure', 400, 'zone_required');
          for await (const r of this.dns(ctx).recordSets.listByDnsZone(rg, filter.zone)) if (!/\/(NS|SOA)$/i.test(r.type ?? '')) out.push(recordObserved(r, r.id!, filter.zone));
          break;
        }
      }
    } catch (err) {
      const e = azureError(err);
      if (e.status === 404 && /ResourceGroupNotFound|NotFound/.test(e.code ?? '')) return [];
      throw e;
    }
    return out.filter(keep);
  }

  async create(ctx: CallContext, spec: ResourceSpec): Promise<OperationResult> {
    this.assertBuilt(spec.type, 'create');
    if (isKubeType(spec.type)) return this.kube.create(ctx, spec);
    if (spec.type === 'database') return this.databases.create(ctx, spec as ResourceSpec<'database'>, azureHandle);
    if (spec.type === 'cache') {
      const found = await this.caches.find(ctx, spec);
      if (found?.state === 'ready') return { done: true, resource: found, adopted: true };
      const r = await this.caches.put(ctx, spec, 'create', azureHandle);
      return found ? { ...r, adopted: true } : r;
    }
    if (spec.type === 'vm' || spec.type === 'container_service') return this.createCompute(ctx, spec);
    const before = await this.find(ctx, spec);
    const r = await this.put(ctx, spec, before ? 'update' : 'create');
    return before ? { ...r, adopted: true } : r;
  }

  async update(ctx: CallContext, ref: ResourceRef, spec: ResourceSpec): Promise<OperationResult> {
    this.assertBuilt(ref.type, 'update');
    if (isKubeType(ref.type)) return this.kube.update(ctx, ref, spec);
    if (ref.type === 'cache') return this.caches.put(ctx, spec, 'update', azureHandle);
    if (ref.type === 'database') return this.databases.update(ctx, ref, spec as ResourceSpec<'database'>, azureHandle);
    if (ref.type === 'vm') return this.compute.putVm(ctx, spec as ResourceSpec<'vm'>, true, azureHandle);
    if (ref.type === 'container_service') return this.compute.rolloutApp(ctx, spec as ResourceSpec<'container_service'>, 'update', azureHandle);
    if (this.idFor(ctx, spec).toLowerCase() !== ref.providerId.toLowerCase()) throw new CloudProviderError('An Azure resource is updated in place by its own name; renaming is a replace.', 'azure', 400, 'replace_required');
    return this.put(ctx, spec, 'update');
  }

  /** The PUT by name every create and update is. */
  private async put(ctx: CallContext, spec: ResourceSpec, op: 'create' | 'update'): Promise<OperationResult> {
    const id = this.idFor(ctx, spec);
    const ref: ResourceRef = { type: spec.type, providerId: id };
    const loc = this.location(ctx, spec);
    const captured: Captured = { headers: {} };
    const onResponse = (raw: { status: number; headers: { toJSON(): Record<string, string> } }) => {
      if (captured.status === undefined) {
        captured.status = raw.status;
        captured.headers = raw.headers.toJSON();
      }
    };
    const parts = parseId(id);
    try {
      switch (spec.type) {
        case 'network': {
          await this.ensureGroup(ctx, spec);
          const p = (spec as ResourceSpec<'network'>).props;
          const poller = this.network(ctx).virtualNetworks.createOrUpdate(parts.rg, parts.names[0]!, { location: loc, tags: { ...spec.tags, 'exprsn:name': spec.name }, addressSpace: { addressPrefixes: [p.cidr] } }, { onResponse } as never);
          await poller.submitted();
          break;
        }
        case 'subnet': {
          const p = (spec as ResourceSpec<'subnet'>).props;
          const poller = this.network(ctx).subnets.createOrUpdate(parts.rg, parts.names[0]!, parts.names[1]!, { addressPrefix: p.cidr }, { onResponse } as never);
          await poller.submitted();
          break;
        }
        case 'firewall': {
          await this.ensureGroup(ctx, spec);
          const p = (spec as ResourceSpec<'firewall'>).props;
          const poller = this.network(ctx).networkSecurityGroups.createOrUpdate(parts.rg, parts.names[0]!, { location: loc, tags: { ...spec.tags, 'exprsn:name': spec.name }, securityRules: toSecurityRules(p.ingress) }, { onResponse } as never);
          await poller.submitted();
          break;
        }
        case 'bucket': {
          await this.ensureGroup(ctx, spec);
          const poller = this.storage(ctx).storageAccounts.create(parts.rg, parts.names[0]!, { location: loc, sku: { name: 'Standard_LRS' }, kind: 'StorageV2', tags: { ...spec.tags, 'exprsn:name': spec.name }, allowBlobPublicAccess: false, minimumTlsVersion: 'TLS1_2', enableHttpsTrafficOnly: true } as never, { onResponse } as never);
          await poller.submitted();
          break;
        }
        case 'dns_record': {
          const p = (spec as ResourceSpec<'dns_record'>).props;
          const r = await this.dns(ctx).recordSets.createOrUpdate(parts.rg, parts.names[0]!, parts.names[2]!, p.recordType as never, { ttl: p.ttl ?? 300, metadata: { ...spec.tags, 'exprsn:name': spec.name }, ...recordValues(p.recordType, p.values) });
          return { done: true, resource: recordObserved(r, id, p.zone) };
        }
        default:
          throw new CloudUnsupported('azure', spec.type, 'not_yet', 'create');
      }
    } catch (err) {
      throw azureError(err);
    }
    return this.afterSubmit(ctx, op, ref, captured);
  }

  private async afterSubmit(ctx: CallContext, op: OperationHandle['op'], ref: ResourceRef, c: Captured): Promise<OperationResult> {
    const requestId = c.headers['x-ms-request-id'];
    const async = c.headers['azure-asyncoperation'];
    const location = c.headers.location;
    const handle = (kind: OperationHandle['kind'], token: string): OperationHandle => ({ provider: 'azure', type: ref.type, op, kind, ref, token, startedAt: Date.now() });
    if (async) return { done: false, operation: handle('azure-async', async), ...(requestId ? { requestId } : {}) };
    if (location && c.status === 202) return { done: false, operation: handle('azure-location', location), ...(requestId ? { requestId } : {}) };
    const resource = op === 'delete' ? null : await this.describe(ctx, ref);
    return { done: true, resource, ...(requestId ? { requestId } : {}) };
  }

  async delete(ctx: CallContext, ref: ResourceRef): Promise<OperationResult> {
    this.assertBuilt(ref.type, 'delete');
    if (isKubeType(ref.type)) return this.kube.delete(ctx, ref);
    if (ref.type === 'cache') return this.caches.delete(ctx, ref, azureHandle);
    if (ref.type === 'database') return this.databases.delete(ctx, ref, azureHandle);
    if (ref.type === 'vm') return this.compute.deleteVm(ctx, ref, azureHandle);
    if (ref.type === 'container_service') return this.compute.deleteApp(ctx, ref, azureHandle);
    const parts = parseId(ref.providerId);
    const captured: Captured = { headers: {} };
    const onResponse = (raw: { status: number; headers: { toJSON(): Record<string, string> } }) => {
      if (captured.status === undefined) {
        captured.status = raw.status;
        captured.headers = raw.headers.toJSON();
      }
    };
    try {
      switch (ref.type) {
        case 'network':
          await this.network(ctx).virtualNetworks.delete(parts.rg, parts.names[0]!, { onResponse } as never).submitted();
          break;
        case 'subnet':
          await this.network(ctx).subnets.delete(parts.rg, parts.names[0]!, parts.names[1]!, { onResponse } as never).submitted();
          break;
        case 'firewall':
          await this.network(ctx).networkSecurityGroups.delete(parts.rg, parts.names[0]!, { onResponse } as never).submitted();
          break;
        case 'bucket':
          await this.storage(ctx).storageAccounts.delete(parts.rg, parts.names[0]!);
          return { done: true, resource: null };
        case 'dns_record':
          await this.dns(ctx).recordSets.delete(parts.rg, parts.names[0]!, parts.names[2]!, parts.names[1]! as never);
          return { done: true, resource: null };
      }
    } catch (err) {
      const e = azureError(err);
      if (e.status === 404) return { done: true, resource: null };
      throw e;
    }
    if (captured.status === 204 || captured.status === 200) return { done: true, resource: null };
    return this.afterSubmit(ctx, 'delete', ref, captured);
  }

  async poll(ctx: CallContext, h: OperationHandle): Promise<PollResult> {
    if (h.provider !== 'azure') throw new CloudProviderError('That operation is not an Azure one.', 'azure', 400, 'wrong_provider');
    if (h.kind === 'azure-apps') return this.compute.pollApps(ctx, h);
    if (h.type === 'cache') return this.caches.poll(ctx, h);
    if (h.type === 'database') return this.databases.poll(ctx, h);
    const pipeline = this.resources(ctx).pipeline;
    const r = await this.armGet<{ status?: string; error?: { code?: string; message?: string } }>(pipeline, ctx.account, h.token);
    const wait = this.transport.retryAfterMs({ headers: r.headers }) ?? 2000;
    if (h.kind === 'azure-location') {
      if (r.status === 202) return { state: 'pending', waitMs: wait };
      if (r.status >= 400) return { state: 'failed', error: r.body?.error?.message ?? `Azure answered ${r.status}.`, ...(r.body?.error?.code ? { code: r.body.error.code } : {}) };
      return { state: 'succeeded', resource: h.op === 'delete' ? null : await this.describe(ctx, h.ref) };
    }
    if (r.status >= 400) return { state: 'failed', error: r.body?.error?.message ?? `Azure answered ${r.status}.`, ...(r.body?.error?.code ? { code: r.body.error.code } : {}) };
    const status = (r.body?.status ?? '').toLowerCase();
    if (status === 'succeeded') return { state: 'succeeded', resource: h.op === 'delete' ? null : await this.describe(ctx, h.ref) };
    if (status === 'failed' || status === 'canceled') return { state: 'failed', error: r.body?.error?.message ?? `The operation ${status}.`, ...(r.body?.error?.code ? { code: r.body.error.code } : {}) };
    return { state: 'pending', waitMs: wait };
  }

  // ---------- Sprint 58: VMs and Container Apps (B-10204, B-10205) ----------

  /** A create adopts what a lost attempt made (PUT by name), or rolls out. */
  private async createCompute(ctx: CallContext, spec: ResourceSpec): Promise<OperationResult> {
    const found = await this.find(ctx, spec);
    if (spec.type === 'vm') {
      if (found) return found.state === 'ready' ? { done: true, resource: found, adopted: true } : { done: false, operation: azureHandle('create', found, 'azure-location', `${found.providerId}?api-version=2024-07-01`), resource: found, adopted: true };
      return this.compute.putVm(ctx, spec as ResourceSpec<'vm'>, false, azureHandle);
    }
    if (found?.state === 'ready' && found.props.image === (spec as ResourceSpec<'container_service'>).props.image) return { done: true, resource: found, adopted: true };
    const r = await this.compute.rolloutApp(ctx, spec as ResourceSpec<'container_service'>, found ? 'update' : 'create', azureHandle);
    return found ? { ...r, adopted: true } : r;
  }

  /** B-10204: the installer's lines in the VM's serial console log (boot diagnostics). */
  async vmInstallStatus(ctx: CallContext, ref: ResourceRef): Promise<InstallStatus> {
    return this.compute.installStatus(ctx, ref);
  }
}

const azureHandle = (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string): OperationHandle => ({ provider: 'azure', type: ref.type, op, kind, ref, token, startedAt: Date.now() });

// ---------- mapping ----------

/** An Azure SDK error as a `CloudProviderError`. */
export function azureError(err: unknown): CloudProviderError {
  if (err instanceof CloudProviderError) return err;
  const e = (err ?? {}) as { statusCode?: number; code?: string; message?: string; details?: { error?: { code?: string; message?: string } }; response?: { headers?: { get?(n: string): string | undefined } } };
  const status = e.statusCode ?? 502;
  const code = e.details?.error?.code ?? e.code ?? null;
  const requestId = e.response?.headers?.get?.('x-ms-request-id') ?? null;
  const retry = status === 429 ? Number(e.response?.headers?.get?.('retry-after')) || 1 : null;
  return new CloudProviderError(`Azure answered ${status}${code ? ` (${code})` : ''}: ${(e.details?.error?.message ?? e.message ?? 'no detail').slice(0, 300)}`, 'azure', status, code, requestId, retry);
}

/** Whether ARM's permission entries grant an action (wildcards, case-insensitive, minus notActions). */
export function allowedBy(grants: { actions: string[]; notActions: string[] }[], action: string): boolean {
  const re = (p: string) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
  return grants.some((g) => g.actions.some((a) => re(a).test(action)) && !g.notActions.some((n) => re(n).test(action)));
}

/** The resource group and the names of an ARM id (`.../providers/<ns>/<type>/<name>/<type>/<name>`). */
export function parseId(id: string): { sub: string; rg: string; names: string[] } {
  const m = /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/[^/]+\/(.+)$/i.exec(id);
  if (!m) throw new CloudProviderError(`${id} is not an ARM resource id.`, 'azure', 400, 'bad_id');
  const segs = m[3]!.split('/');
  const names = segs.filter((_, i) => i % 2 === 1);
  // A DNS record set's id is .../dnsZones/<zone>/<TYPE>/<name>: names are [zone, name], with the type kept between.
  if (/^dnszones$/i.test(segs[0] ?? '') && segs.length === 4) return { sub: m[1]!, rg: m[2]!, names: [segs[1]!, segs[2]!, segs[3]!] };
  return { sub: m[1]!, rg: m[2]!, names };
}

/** A storage account name (3 to 24 lower-case letters and digits), stable for an account and logical name. */
export function storageName(account: CloudAccount, spec: ResourceSpec<'bucket'>): string {
  if (spec.props.bucketName) return spec.props.bucketName;
  const base = `ex${account.name}${spec.name}`.toLowerCase().replace(/[^a-z0-9]/g, '');
  return base.length <= 24 ? base : `${base.slice(0, 16)}${createHash('sha256').update(base).digest('hex').slice(0, 8)}`;
}

const stateOf = (p: string | undefined): ObservedResource['state'] => {
  const s = (p ?? 'Succeeded').toLowerCase();
  return s === 'succeeded' ? 'ready' : s === 'failed' || s === 'canceled' ? 'failed' : s === 'deleting' ? 'deleting' : s === 'updating' ? 'updating' : 'creating';
};

const managed = (t: Record<string, string> | undefined) => Object.fromEntries(Object.entries(t ?? {}).filter(([k]) => k.startsWith('exprsn:')));

function vnetObserved(v: VirtualNetwork): ObservedResource {
  return { type: 'network', providerId: v.id!, name: v.tags?.['exprsn:name'] ?? v.name!, ...(v.location ? { region: v.location } : {}), state: stateOf(v.provisioningState), tags: managed(v.tags), props: { cidr: v.addressSpace?.addressPrefixes?.[0] } };
}

function subnetObserved(s: Subnet, id: string): ObservedResource {
  return { type: 'subnet', providerId: s.id ?? id, name: s.name!, state: stateOf(s.provisioningState), tags: {}, props: { cidr: s.addressPrefix ?? s.addressPrefixes?.[0] }, locator: { networkId: (s.id ?? id).replace(/\/subnets\/[^/]+$/i, '') } };
}

function nsgObserved(g: NetworkSecurityGroup): ObservedResource {
  return { type: 'firewall', providerId: g.id!, name: g.tags?.['exprsn:name'] ?? g.name!, ...(g.location ? { region: g.location } : {}), state: stateOf(g.provisioningState), tags: managed(g.tags), props: { ingress: fromSecurityRules(g.securityRules ?? []) } };
}

function storageObserved(a: StorageAccount): ObservedResource {
  return { type: 'bucket', providerId: a.id!, name: a.tags?.['exprsn:name'] ?? a.name!, ...(a.location ? { region: a.location } : {}), state: stateOf(a.provisioningState), tags: managed(a.tags), props: { bucketName: a.name, endpoint: a.primaryEndpoints?.blob } };
}

function recordObserved(r: RecordSet, id: string, zone: string): ObservedResource {
  const type = (r.type ?? id.split('/').slice(-2)[0] ?? '').split('/').pop()!.toUpperCase();
  const values = r.aRecords?.map((x) => x.ipv4Address!) ?? r.aaaaRecords?.map((x) => x.ipv6Address!) ?? (r.cnameRecord?.cname ? [r.cnameRecord.cname] : undefined) ?? r.txtRecords?.map((x) => (x.value ?? []).join('')) ?? r.mxRecords?.map((x) => `${x.preference} ${x.exchange}`) ?? r.caaRecords?.map((x) => `${x.flags} ${x.tag} ${x.value}`) ?? [];
  return { type: 'dns_record', providerId: r.id ?? id, name: r.metadata?.['exprsn:name'] ?? r.name!, state: stateOf(r.provisioningState), tags: managed(r.metadata), props: { zone, record: r.name, recordType: type, values, ttl: r.ttl } };
}

function recordValues(type: string, values: string[]): Partial<RecordSet> {
  switch (type) {
    case 'A':
      return { aRecords: values.map((ipv4Address) => ({ ipv4Address })) };
    case 'AAAA':
      return { aaaaRecords: values.map((ipv6Address) => ({ ipv6Address })) };
    case 'CNAME':
      return { cnameRecord: { cname: values[0]! } };
    case 'TXT':
      return { txtRecords: values.map((v) => ({ value: [v] })) };
    case 'MX':
      return { mxRecords: values.map((v) => ({ preference: Number(v.split(/\s+/)[0]), exchange: v.split(/\s+/)[1] })) };
    case 'CAA':
      return { caaRecords: values.map((v) => ({ flags: Number(v.split(/\s+/)[0]), tag: v.split(/\s+/)[1], value: v.split(/\s+/).slice(2).join(' ').replace(/^"|"$/g, '') })) };
  }
  throw new CloudProviderError(`Record type ${type} is not driven yet.`, 'azure', 400, 'record_type');
}

function toSecurityRules(rules: FirewallRule[]): SecurityRule[] {
  return rules.map((r, i) => ({
    name: `exprsn-in-${i + 1}`,
    protocol: (r.protocol === 'all' ? '*' : r.protocol === 'icmp' ? 'Icmp' : r.protocol === 'udp' ? 'Udp' : 'Tcp') as SecurityRule['protocol'],
    sourcePortRange: '*',
    destinationPortRange: r.protocol === 'tcp' || r.protocol === 'udp' ? (r.ports ?? '*') : '*',
    sourceAddressPrefixes: r.sources,
    destinationAddressPrefix: '*',
    access: 'Allow',
    priority: 100 + i * 10,
    direction: 'Inbound',
    ...(r.description ? { description: r.description } : {})
  }));
}

function fromSecurityRules(rules: SecurityRule[]): FirewallRule[] {
  return rules
    .filter((r) => r.direction === 'Inbound' && r.access === 'Allow')
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    .map((r) => {
      const protocol = (r.protocol === '*' ? 'all' : String(r.protocol).toLowerCase()) as FirewallRule['protocol'];
      const ports = r.destinationPortRange && r.destinationPortRange !== '*' ? r.destinationPortRange : undefined;
      return { protocol, ...(ports && (protocol === 'tcp' || protocol === 'udp') ? { ports } : {}), sources: r.sourceAddressPrefixes?.length ? r.sourceAddressPrefixes : r.sourceAddressPrefix ? [r.sourceAddressPrefix] : [] };
    });
}
