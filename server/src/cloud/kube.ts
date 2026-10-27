import type { CloudTransport } from './providers/transport.js';
import { CloudProviderError, type ClusterAccess } from './providers/types.js';
import type { Provider } from './types.js';

/*
 * 1.9.99-final, Sprint 58 (B-10203, B-10207): the few Kubernetes API calls the deploy worker makes itself, beside
 * `helm`: the namespace and the release's Secret (server-side apply), the migrate check Job and its pod's exit code,
 * the ingress or Service address. Every call goes through the provider adapter's transport (the egress guard, which
 * admits the providers' cluster API hosts, and the rate limiter) with the cluster's short-lived token and its CA.
 * Request bodies (the Secret's data among them) are never logged.
 */

export type KubeObject = { apiVersion: string; kind: string; metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string>; [k: string]: unknown }; [k: string]: unknown };

const FIELD_MANAGER = 'exprsn-ai-deploy';

const PLURAL: Record<string, string> = { Namespace: 'namespaces', Secret: 'secrets', Job: 'jobs', ConfigMap: 'configmaps' };

/** The API path of an object (core and named groups). */
export function objectPath(o: Pick<KubeObject, 'apiVersion' | 'kind' | 'metadata'>): string {
  const plural = PLURAL[o.kind] ?? `${o.kind.toLowerCase()}s`;
  const base = o.apiVersion.includes('/') ? `/apis/${o.apiVersion}` : `/api/${o.apiVersion}`;
  const ns = o.kind === 'Namespace' ? '' : `/namespaces/${encodeURIComponent(o.metadata.namespace ?? 'default')}`;
  return `${base}${ns}/${plural}/${encodeURIComponent(o.metadata.name)}`;
}

export class KubeApi {
  constructor(
    private readonly transport: CloudTransport,
    private readonly access: ClusterAccess,
    private readonly accountId: string,
    private readonly provider: Provider
  ) {}

  private async send<T>(method: string, path: string, body?: unknown, contentType = 'application/json'): Promise<T | null> {
    if (this.access.expiresAt <= Date.now()) throw new CloudProviderError('The cluster token expired during the operation.', this.provider, 401, 'kube_token_expired');
    const url = new URL(path, this.access.server.replace(/\/?$/, '/'));
    const res = await this.transport.send({
      method,
      url,
      headers: { authorization: `Bearer ${this.access.token}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': contentType } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      accountId: this.accountId,
      apiClass: method === 'GET' ? 'read' : 'mutate',
      ...(this.access.caData ? { ca: Buffer.from(this.access.caData, 'base64') } : {})
    });
    if (res.status === 404 && method !== 'PATCH' && method !== 'POST') return null;
    const text = res.body.toString('utf8');
    if (res.status >= 300) {
      let reason = '';
      try {
        reason = String((JSON.parse(text) as { message?: string }).message ?? '');
      } catch {
        /* not JSON */
      }
      throw new CloudProviderError(`The cluster's API answered ${res.status} for ${method} ${url.pathname}${reason ? `: ${reason.slice(0, 300)}` : ''}.`, this.provider, res.status, res.status === 401 ? 'kube_unauthorized' : 'kube_error');
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** `GET /version`: also proves the token works. */
  version(): Promise<{ gitVersion?: string } | null> {
    return this.send('GET', '/version');
  }

  get<T = KubeObject>(path: string): Promise<T | null> {
    return this.send<T>('GET', path);
  }

  /** Server-side apply (create or replace the fields this manager owns). */
  async apply(o: KubeObject): Promise<KubeObject> {
    return (await this.send<KubeObject>('PATCH', `${objectPath(o)}?fieldManager=${FIELD_MANAGER}&force=true`, o, 'application/apply-patch+yaml'))!;
  }

  async remove(path: string): Promise<void> {
    await this.send('DELETE', `${path}?propagationPolicy=Background`);
  }

  /** The pods of a Job (its exit code is the migrate check's answer). */
  async jobPods(namespace: string, job: string): Promise<{ metadata: { name: string }; status?: { phase?: string; containerStatuses?: { state?: { terminated?: { exitCode?: number } } }[] } }[]> {
    const r = await this.send<{ items?: never[] }>('GET', `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?labelSelector=${encodeURIComponent(`job-name=${job}`)}`);
    return r?.items ?? [];
  }

  /** The address the cluster's load balancer answers on, from an Ingress or a Service of type LoadBalancer. */
  async address(namespace: string, name: string, kind: 'ingress' | 'service'): Promise<string | null> {
    const path = kind === 'ingress' ? `/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(namespace)}/ingresses/${encodeURIComponent(name)}` : `/api/v1/namespaces/${encodeURIComponent(namespace)}/services/${encodeURIComponent(name)}`;
    const o = await this.get<{ status?: { loadBalancer?: { ingress?: { hostname?: string; ip?: string }[] } } }>(path);
    const i = o?.status?.loadBalancer?.ingress?.[0];
    return i?.hostname ?? i?.ip ?? null;
  }
}
