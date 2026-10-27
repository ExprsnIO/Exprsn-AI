import type { Provider } from '../types.js';
import { CloudUnsupported, type ObservedResource, type OperationResult, type ResourceRef, type ResourceSpec, type ResourceType } from './types.js';

/*
 * 1.9.99-final, Sprint 58 (B-10203): what the three Kubernetes targets share. The provider-specific parts are
 * `aws-eks.ts` (EKS over its REST API, SigV4), `azure-aks.ts` (AKS over ARM) and `do-doks.ts` (DOKS over the v2 API);
 * each adapter hands the Kubernetes types to its module, so the adapters themselves change in one place each.
 *
 * - `kubernetes_cluster` and `node_group` are real provider resources, created, polled, updated and deleted through
 *   the transport like every other type.
 * - `load_balancer` with `managedBy: 'cluster'` is the one in front of the release: the cluster's own controller
 *   makes it from the release's ingress or Service, so the adapter calls nothing for it (`clusterLoadBalancer`); the
 *   deploy worker (`cloud/releases.ts`) records its address in the graph row's locator once the release is up. A
 *   standalone load balancer (VMs, ECS) is another variant: it is refused here as not built, and B-10204/B-10205 add
 *   it beside this one.
 */

export const KUBE_TYPES: ReadonlySet<ResourceType> = new Set(['kubernetes_cluster', 'node_group', 'load_balancer']);

export const isKubeType = (t: ResourceType): boolean => KUBE_TYPES.has(t);

/** How long a kubeconfig token lives (EKS tokens are good for 15 minutes; the others are asked for this long). */
export const KUBE_TOKEN_SECONDS = 10 * 60;

/** `key=value:Effect` → its parts. */
export function parseTaint(t: string): { key: string; value: string; effect: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute' } {
  const m = /^([^=:]+)(?:=([^:]*))?:(NoSchedule|PreferNoSchedule|NoExecute)$/.exec(t);
  if (!m) return { key: t, value: '', effect: 'NoSchedule' };
  return { key: m[1]!, value: m[2] ?? '', effect: m[3] as 'NoSchedule' };
}

export const taintText = (t: { key: string; value?: string | null; effect: string }): string => `${t.key}${t.value ? `=${t.value}` : ''}:${t.effect}`;

/** The labels every node of a group carries: its role and pool, which the chart's nodeSelector and the GPU pools use. */
export function nodeLabels(spec: ResourceSpec<'node_group'>): Record<string, string> {
  const p = spec.props;
  return { 'exprsn.ai/role': String(p.role ?? 'app'), 'exprsn.ai/node-group': spec.name, ...(p.gpu ? { 'exprsn.ai/gpu': String(p.gpu) } : {}) };
}

/** An AKS agent pool name: lower case letters and digits, starting with a letter, at most 12 (Linux pools). */
export function aksPoolName(spec: Pick<ResourceSpec<'node_group'>, 'name' | 'props'>): string {
  const base = (spec.props.poolName ?? spec.name).toLowerCase().replace(/[^a-z0-9]/g, '');
  const n = /^[a-z]/.test(base) ? base : `p${base}`;
  return n.slice(0, 12) || 'app';
}

// ---------- the cluster's load balancer ----------

const lbId = (spec: Pick<ResourceSpec, 'name'>) => `k8s-lb:${spec.name}`;

function lbObserved(ref: ResourceRef & { name?: string }, props: Record<string, unknown>): ObservedResource {
  const address = ref.locator?.address ?? null;
  return { type: 'load_balancer', providerId: ref.providerId, name: ref.name ?? ref.providerId.replace(/^k8s-lb:/, ''), ...(ref.region ? { region: ref.region } : {}), state: 'ready', tags: {}, props: { managedBy: 'cluster', ...props, address }, ...(ref.locator ? { locator: ref.locator } : {}) };
}

/**
 * The load balancer a Kubernetes cluster makes for its release. Nothing is called: its provider id is derived from
 * its name, and its address is what the deploy worker read from the release's ingress (`locator.address`).
 */
export const clusterLoadBalancer = {
  assert(provider: Provider, spec: ResourceSpec): void {
    if ((spec.props as { managedBy?: string }).managedBy !== 'cluster') throw new CloudUnsupported(provider, 'load_balancer', 'not_yet', 'create', 'A standalone load balancer (VMs, ECS) is not built yet (B-10204, B-10205); the one in front of a Kubernetes release is the cluster’s (managedBy: cluster).');
  },
  find(_provider: Provider, spec: ResourceSpec): ObservedResource | null {
    return (spec.props as { managedBy?: string }).managedBy === 'cluster' ? lbObserved({ type: 'load_balancer', providerId: lbId(spec), name: spec.name, ...(spec.region ? { region: spec.region } : {}) }, { scheme: (spec.props as { scheme?: string }).scheme ?? null }) : null;
  },
  create(provider: Provider, spec: ResourceSpec): OperationResult {
    this.assert(provider, spec);
    return { done: true, resource: this.find(provider, spec) };
  },
  describe(ref: ResourceRef): ObservedResource {
    return lbObserved(ref, {});
  },
  update(provider: Provider, ref: ResourceRef, spec: ResourceSpec): OperationResult {
    this.assert(provider, spec);
    return { done: true, resource: lbObserved({ ...ref, name: spec.name }, { scheme: (spec.props as { scheme?: string }).scheme ?? null }) };
  },
  delete(): OperationResult {
    // The cluster's controller removes it with the release's ingress or Service (or with the cluster).
    return { done: true, resource: null };
  }
};
