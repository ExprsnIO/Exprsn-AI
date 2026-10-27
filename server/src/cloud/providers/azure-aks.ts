import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { namePrefix } from '../tags.js';
import { aksPoolName, clusterLoadBalancer, nodeLabels } from './kubernetes.js';
import type { CloudTransport } from './transport.js';
import {
  CloudProviderError,
  type CallContext,
  type ClusterAccess,
  type ListFilter,
  type ObservedResource,
  type OperationHandle,
  type OperationResult,
  type ResourceRef,
  type ResourceSpec
} from './types.js';

/*
 * 1.9.99-final, Sprint 58 (B-10203): AKS through the Azure adapter, over ARM's REST API on the adapter's transport
 * (the ARM SDK for container service is not a dependency of this build), with the adapter's ARM token.
 *
 * - Clusters: a PUT by name in the managed resource group: AKS-managed Entra ID with Azure RBAC and local accounts
 *   off (so the only way in is a short-lived Entra token), the app node pool as the system pool on the app subnet
 *   (AKS needs one at create; the graph's app `node_group` step adopts it), Azure CNI with Azure network policy,
 *   application routing (managed NGINX) for the release's ingress, the API server open only to `apiCidrs` when given.
 *   The deploying principal gets "Azure Kubernetes Service RBAC Cluster Admin" on the cluster (a role assignment by a
 *   name derived from the cluster and the principal, so a retry makes no second one).
 * - Agent pools: PUT `agentPools/<name>` (user pools; labels, taints, autoscaling).
 * - Long-running operations are ARM's own (`Azure-AsyncOperation`), followed by the adapter's poll.
 * - Access: the cluster's server and CA from `listClusterUserCredential`, and an Entra token for the AKS server
 *   application (`6dae42f8-4368-4678-94ff-3960e28e3630`), as kubelogin would get one.
 */

export const AKS_API = '2024-09-01';
/** The AKS server application every AKS-managed Entra cluster accepts tokens for. */
export const AKS_SCOPE = '6dae42f8-4368-4678-94ff-3960e28e3630/.default';
/** Built-in role "Azure Kubernetes Service RBAC Cluster Admin". */
const AKS_CLUSTER_ADMIN_ROLE = 'b1ff04bb-8a4e-4dc4-8eb5-8693973ce19b';

interface ArmCluster { id: string; name: string; location?: string; tags?: Record<string, string>; sku?: { tier?: string }; properties?: { provisioningState?: string; kubernetesVersion?: string; fqdn?: string; privateFQDN?: string; agentPoolProfiles?: { name: string }[] } }
interface ArmPool { id: string; name: string; properties?: { provisioningState?: string; vmSize?: string; count?: number; minCount?: number; maxCount?: number; enableAutoScaling?: boolean; nodeLabels?: Record<string, string>; nodeTaints?: string[]; tags?: Record<string, string> } }

export interface AksDeps {
  transport: CloudTransport;
  arm: () => string;
  /** The ARM token, and a token for another scope (the AKS server application). */
  token(ctx: CallContext, scope?: string): Promise<string>;
  /** The deploying principal's object id (from the ARM token), or null. */
  principalId(ctx: CallContext): Promise<string | null>;
  subscription(ctx: CallContext): string;
  resourceGroup(ctx: CallContext): string;
  location(ctx: CallContext, spec?: ResourceSpec): string;
  ensureGroup(ctx: CallContext, spec: ResourceSpec): Promise<string>;
}

const stateOf = (p: string | undefined): ObservedResource['state'] => {
  const s = (p ?? 'Succeeded').toLowerCase();
  return s === 'succeeded' ? 'ready' : s === 'failed' || s === 'canceled' ? 'failed' : s === 'deleting' ? 'deleting' : s === 'updating' || s === 'upgrading' || s === 'scaling' ? 'updating' : 'creating';
};
const managed = (t: Record<string, string> | undefined) => Object.fromEntries(Object.entries(t ?? {}).filter(([k]) => k.startsWith('exprsn:') && k !== 'exprsn:name'));
/** A GUID from a seed (role assignment names are GUIDs; a stable one makes the PUT idempotent). */
const guidOf = (seed: string) => {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

function clusterObserved(c: ArmCluster): ObservedResource {
  return { type: 'kubernetes_cluster', providerId: c.id, name: c.tags?.['exprsn:name'] ?? c.name, ...(c.location ? { region: c.location } : {}), state: stateOf(c.properties?.provisioningState), tags: managed(c.tags), props: { ha: c.sku?.tier === 'Standard', version: c.properties?.kubernetesVersion ?? null, endpoint: c.properties?.fqdn ?? c.properties?.privateFQDN ?? null, status: c.properties?.provisioningState ?? null } };
}

function poolObserved(p: ArmPool): ObservedResource {
  const q = p.properties ?? {};
  const labels = q.nodeLabels ?? {};
  return {
    type: 'node_group',
    providerId: p.id,
    name: labels['exprsn.ai/node-group'] ?? p.name,
    state: stateOf(q.provisioningState),
    tags: managed(q.tags),
    props: { size: q.vmSize ?? null, count: q.count ?? null, min: q.enableAutoScaling ? (q.minCount ?? null) : (q.count ?? null), max: q.enableAutoScaling ? (q.maxCount ?? null) : (q.count ?? null), role: labels['exprsn.ai/role'] ?? null, taints: q.nodeTaints ?? [] },
    locator: { clusterId: p.id.replace(/\/agentPools\/[^/]+$/i, '') }
  };
}

export class AksResources {
  constructor(private readonly d: AksDeps) {}

  /** One ARM call on the transport with the ARM token; a 404 answers null. */
  private async call<T>(ctx: CallContext, method: string, id: string, body?: unknown): Promise<{ status: number; body: T; headers: Record<string, string>; requestId: string | null } | null> {
    const url = new URL(`${this.d.arm()}${id}${id.includes('?') ? '&' : '?'}api-version=${AKS_API}`);
    try {
      return await this.d.transport.json<T>({ method, url, headers: { authorization: `Bearer ${await this.d.token(ctx)}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), accountId: ctx.account.id, ...(ctx.signal ? { signal: ctx.signal } : {}) }, (status, b) => {
        const e = ((b ?? {}) as { error?: { code?: string; message?: string } }).error ?? {};
        return { message: `Azure answered ${status}${e.code ? ` (${e.code})` : ''}: ${(e.message ?? 'no detail').slice(0, 300)}`, code: e.code ?? null };
      });
    } catch (err) {
      if (err instanceof CloudProviderError && err.status === 404) return null;
      throw err;
    }
  }

  private clusterId(ctx: CallContext, name: string): string {
    return `/subscriptions/${this.d.subscription(ctx)}/resourceGroups/${this.d.resourceGroup(ctx)}/providers/Microsoft.ContainerService/managedClusters/${namePrefix(ctx.account.name)}${name}`.slice(0, 600);
  }

  private poolId(clusterId: string, spec: ResourceSpec<'node_group'>): string {
    return `${clusterId}/agentPools/${aksPoolName(spec)}`;
  }

  private handle(op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string): OperationHandle {
    return { provider: 'azure', type: ref.type, op, kind, ref: { type: ref.type, providerId: ref.providerId }, token, startedAt: Date.now() };
  }

  /** ARM's answer to a PUT or DELETE: done, or the `Azure-AsyncOperation` (or `Location`) to follow. */
  private after(op: OperationHandle['op'], ref: ResourceRef, r: { status: number; headers: Record<string, string>; requestId: string | null }, resource: ObservedResource | null): OperationResult {
    const async = r.headers['azure-asyncoperation'];
    const location = r.headers.location;
    const requestId = r.requestId ? { requestId: r.requestId } : {};
    if (async) return { done: false, operation: this.handle(op, ref, 'azure-async', async), ...(resource ? { resource } : {}), ...requestId };
    if (location && r.status === 202) return { done: false, operation: this.handle(op, ref, 'azure-location', location), ...requestId };
    return { done: true, resource: op === 'delete' ? null : resource, ...requestId };
  }

  async find(ctx: CallContext, spec: ResourceSpec): Promise<ObservedResource | null> {
    if (spec.type === 'load_balancer') return clusterLoadBalancer.find('azure', spec);
    if (spec.type === 'kubernetes_cluster') return this.describe(ctx, { type: 'kubernetes_cluster', providerId: this.clusterId(ctx, spec.name) });
    const cluster = spec.parent?.refs?.cluster;
    return cluster ? this.describe(ctx, { type: 'node_group', providerId: this.poolId(cluster, spec as ResourceSpec<'node_group'>) }) : null;
  }

  async describe(ctx: CallContext, ref: ResourceRef): Promise<ObservedResource | null> {
    if (ref.type === 'load_balancer') return clusterLoadBalancer.describe(ref);
    if (ref.type === 'kubernetes_cluster') {
      const r = await this.call<ArmCluster>(ctx, 'GET', ref.providerId);
      return r ? clusterObserved(r.body) : null;
    }
    const r = await this.call<ArmPool>(ctx, 'GET', ref.providerId);
    return r ? poolObserved(r.body) : null;
  }

  async list(ctx: CallContext, type: 'kubernetes_cluster' | 'node_group' | 'load_balancer', filter: ListFilter = {}): Promise<ObservedResource[]> {
    if (type === 'load_balancer') return [];
    const base = `/subscriptions/${this.d.subscription(ctx)}/resourceGroups/${this.d.resourceGroup(ctx)}/providers/Microsoft.ContainerService/managedClusters`;
    const clusters = ((await this.call<{ value?: ArmCluster[] }>(ctx, 'GET', base))?.body.value ?? []).filter((c) => !filter.managedOnly || (c.tags?.['exprsn:managed'] === 'true' && c.tags?.['exprsn:account'] === ctx.account.name));
    if (type === 'kubernetes_cluster') return clusters.map(clusterObserved);
    const out: ObservedResource[] = [];
    for (const c of clusters) for (const p of (await this.call<{ value?: ArmPool[] }>(ctx, 'GET', `${c.id}/agentPools`))?.body.value ?? []) out.push(poolObserved(p));
    return out;
  }

  private ref(spec: ResourceSpec, key: string | undefined): string | undefined {
    return key ? spec.parent?.refs?.[key] : undefined;
  }

  async create(ctx: CallContext, spec: ResourceSpec): Promise<OperationResult> {
    if (spec.type === 'load_balancer') return clusterLoadBalancer.create('azure', spec);
    const before = await this.find(ctx, spec);
    const r = await this.put(ctx, spec, before ? 'update' : 'create');
    return before ? { ...r, adopted: true } : r;
  }

  async update(ctx: CallContext, ref: ResourceRef, spec: ResourceSpec): Promise<OperationResult> {
    if (ref.type === 'load_balancer') return clusterLoadBalancer.update('azure', ref, spec);
    return this.put(ctx, spec, 'update', ref);
  }

  private async put(ctx: CallContext, spec: ResourceSpec, op: 'create' | 'update', given?: ResourceRef): Promise<OperationResult> {
    await this.d.ensureGroup(ctx, spec);
    const location = this.d.location(ctx, spec);
    const tags = { ...spec.tags, 'exprsn:name': spec.name };
    if (spec.type === 'kubernetes_cluster') {
      const p = (spec as ResourceSpec<'kubernetes_cluster'>).props;
      const id = given?.providerId ?? this.clusterId(ctx, spec.name);
      const first = p.initialPool;
      const subnet = this.ref(spec, first?.subnet ?? p.subnets?.[0]);
      const pool = first ? { name: aksPoolName({ name: first.name, props: { role: 'app', size: first.size, ...(first.poolName ? { poolName: first.poolName } : {}) } }), mode: 'System', vmSize: first.size, count: first.count, osType: 'Linux', type: 'VirtualMachineScaleSets', nodeLabels: { 'exprsn.ai/role': 'app', 'exprsn.ai/node-group': first.name }, ...(subnet ? { vnetSubnetID: subnet } : {}) } : { name: 'system', mode: 'System', vmSize: 'Standard_D2s_v5', count: 1, osType: 'Linux', type: 'VirtualMachineScaleSets', ...(subnet ? { vnetSubnetID: subnet } : {}) };
      const body = {
        location,
        tags,
        sku: { name: 'Base', tier: p.ha ? 'Standard' : 'Free' },
        identity: { type: 'SystemAssigned' },
        properties: {
          dnsPrefix: `${namePrefix(ctx.account.name)}${spec.name}`.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 54),
          ...(p.version ? { kubernetesVersion: p.version } : {}),
          enableRBAC: true,
          disableLocalAccounts: true,
          aadProfile: { managed: true, enableAzureRBAC: true },
          ...(p.apiCidrs?.length ? { apiServerAccessProfile: { authorizedIPRanges: p.apiCidrs } } : {}),
          networkProfile: { networkPlugin: 'azure', networkPolicy: 'azure', loadBalancerSku: 'standard' },
          ingressProfile: { webAppRouting: { enabled: true } },
          agentPoolProfiles: [pool]
        }
      };
      const r = await this.call<ArmCluster>(ctx, 'PUT', id, body);
      if (!r) throw new CloudProviderError(`The resource group of ${spec.name} is gone.`, 'azure', 404, 'not_found');
      await this.grantAdmin(ctx, id);
      return this.after(op, { type: 'kubernetes_cluster', providerId: id }, r, clusterObserved(r.body));
    }
    const p = (spec as ResourceSpec<'node_group'>).props;
    const cluster = spec.parent?.refs?.cluster;
    if (!cluster) throw new CloudProviderError('An agent pool needs its cluster (parent.refs.cluster).', 'azure', 400, 'parent_required');
    const id = given?.providerId ?? this.poolId(cluster, spec as ResourceSpec<'node_group'>);
    const count = p.count ?? p.min ?? 1;
    const min = p.min ?? count;
    const max = p.max ?? count;
    const subnet = this.ref(spec, p.subnets?.[0]);
    const body = { properties: { vmSize: p.size, count: Math.max(count, min), mode: (p.role === 'app' ? 'System' : 'User'), osType: 'Linux', type: 'VirtualMachineScaleSets', ...(max > min && !p.gatewayScaled ? { enableAutoScaling: true, minCount: min, maxCount: max } : { enableAutoScaling: false }), ...(p.purchase === 'spot' ? { scaleSetPriority: 'Spot', scaleSetEvictionPolicy: 'Delete', spotMaxPrice: -1 } : {}), nodeLabels: nodeLabels(spec as ResourceSpec<'node_group'>), nodeTaints: p.taints ?? [], tags, ...(subnet ? { vnetSubnetID: subnet } : {}) } };
    const r = await this.call<ArmPool>(ctx, 'PUT', id, body);
    if (!r) throw new CloudProviderError(`The cluster of ${spec.name} is gone.`, 'azure', 404, 'not_found');
    return this.after(op, { type: 'node_group', providerId: id }, r, poolObserved(r.body));
  }

  /** The deploying principal as cluster admin (Azure RBAC), by a stable assignment name so a retry is a no-op. */
  private async grantAdmin(ctx: CallContext, clusterId: string): Promise<void> {
    const principal = await this.d.principalId(ctx);
    if (!principal) return;
    const sub = this.d.subscription(ctx);
    const name = guidOf(`${clusterId.toLowerCase()}|${principal}`);
    const url = new URL(`${this.d.arm()}${clusterId}/providers/Microsoft.Authorization/roleAssignments/${name}?api-version=2022-04-01`);
    await this.d.transport
      .json({ method: 'PUT', url, headers: { authorization: `Bearer ${await this.d.token(ctx)}` }, body: JSON.stringify({ properties: { roleDefinitionId: `/subscriptions/${sub}/providers/Microsoft.Authorization/roleDefinitions/${AKS_CLUSTER_ADMIN_ROLE}`, principalId: principal, principalType: 'ServicePrincipal' } }), accountId: ctx.account.id }, (status, b) => ({ message: `Azure refused the AKS admin role assignment (${status}).`, code: ((b ?? {}) as { error?: { code?: string } }).error?.code ?? null }))
      .catch((err) => {
        // Already assigned (by another attempt, or by hand) is what we want.
        if (err instanceof CloudProviderError && err.code === 'RoleAssignmentExists') return null;
        throw err;
      });
  }

  async delete(ctx: CallContext, ref: ResourceRef): Promise<OperationResult> {
    if (ref.type === 'load_balancer') return clusterLoadBalancer.delete();
    const r = await this.call(ctx, 'DELETE', ref.providerId);
    if (!r || r.status === 204 || r.status === 200) return { done: true, resource: null };
    return this.after('delete', ref, r, null);
  }

  /** The cluster's server and CA (`listClusterUserCredential`) and an Entra token for the AKS server application. */
  async access(ctx: CallContext, ref: ResourceRef): Promise<ClusterAccess> {
    const c = await this.call<ArmCluster>(ctx, 'GET', ref.providerId);
    if (!c) throw new CloudProviderError(`${ref.providerId} does not exist.`, 'azure', 404, 'not_found');
    const creds = await this.call<{ kubeconfigs?: { name: string; value: string }[] }>(ctx, 'POST', `${ref.providerId}/listClusterUserCredential`);
    let server = c.body.properties?.fqdn ? `https://${c.body.properties.fqdn}:443` : null;
    let caData: string | null = null;
    const kc = creds?.body.kubeconfigs?.[0]?.value;
    if (kc) {
      const doc = parseYaml(Buffer.from(kc, 'base64').toString('utf8'), { maxAliasCount: 10 }) as { clusters?: { cluster?: { server?: string; 'certificate-authority-data'?: string } }[] } | null;
      const cl = doc?.clusters?.[0]?.cluster;
      if (cl?.server) server = cl.server;
      caData = cl?.['certificate-authority-data'] ?? null;
    }
    if (!server) throw new CloudProviderError(`${c.body.name} has no API server address yet.`, 'azure', 409, 'cluster_not_ready');
    const t = await this.d.token(ctx, AKS_SCOPE);
    return { server, caData, token: t, expiresAt: Date.now() + 10 * 60_000, clusterName: c.body.name };
  }
}
