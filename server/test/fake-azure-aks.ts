/*
 * 1.9.99-final, Sprint 58 (B-10203): AKS for `fake-azure.ts`. Managed clusters and agent pools are ordinary ARM
 * resources there (PUT by name, asynchronous through `Azure-AsyncOperation`); this adds what is particular to AKS:
 * a PUT of a cluster makes its agent pools from `agentPoolProfiles` and gives it an FQDN; `listClusterUserCredential`
 * answers a kubeconfig whose server is the fake Kubernetes API; role assignments at a cluster's scope are kept.
 * `acceptsToken` is what a cluster's API asks: an Entra token the fake issued for the AKS server application.
 * It is never the real AKS.
 */
import { randomUUID } from 'node:crypto';
import { stringify } from 'yaml';
import type { RecordedRequest, Reply } from './fake-cloud-base.js';

export const AKS_SERVER_APP = '6dae42f8-4368-4678-94ff-3960e28e3630';

interface ArmLike {
  id: string;
  name: string;
  type: string;
  location?: string;
  tags?: Record<string, string>;
  etag: string;
  body: Record<string, unknown>;
}

export class FakeAks {
  /** The clusters' API endpoint (the fake Kubernetes API). */
  kubeServer = 'https://aks.example.test:443';
  readonly roleAssignments = new Map<string, { principalId: string; roleDefinitionId: string; scope: string }>();
  readonly credentialReads: string[] = [];

  constructor(private readonly tokens: () => Map<string, { scope: string; exp: number }>) {}

  /** The calls only AKS has; null for everything else (the generic ARM handling). */
  handle(r: RecordedRequest, resource: (key: string) => ArmLike | undefined): Reply | null {
    const ra = /^(.*)\/providers\/Microsoft\.Authorization\/roleAssignments\/([^/]+)$/i.exec(r.path);
    if (ra && /\/managedclusters\//i.test(ra[1]!)) {
      if (r.method !== 'PUT') return { status: 405, body: { error: { code: 'MethodNotAllowed', message: 'Not allowed' } } };
      if (!resource(ra[1]!.toLowerCase())) return { status: 404, body: { error: { code: 'ResourceNotFound', message: `The Resource '${ra[1]}' was not found.` } } };
      const b = JSON.parse(r.body || '{}') as { properties?: { principalId?: string; roleDefinitionId?: string } };
      const name = ra[2]!.toLowerCase();
      const existed = this.roleAssignments.has(name);
      this.roleAssignments.set(name, { principalId: b.properties?.principalId ?? '', roleDefinitionId: b.properties?.roleDefinitionId ?? '', scope: ra[1]! });
      return { status: existed ? 200 : 201, body: { id: r.path, name: ra[2], type: 'Microsoft.Authorization/roleAssignments', properties: { ...b.properties, scope: ra[1] } } };
    }
    const cred = /^(.*\/managedClusters\/[^/]+)\/listClusterUserCredential$/i.exec(r.path);
    if (cred && r.method === 'POST') {
      const c = resource(cred[1]!.toLowerCase());
      if (!c) return { status: 404, body: { error: { code: 'ResourceNotFound', message: `The Resource '${cred[1]}' was not found.` } } };
      this.credentialReads.push(cred[1]!);
      const kubeconfig = stringify({ apiVersion: 'v1', kind: 'Config', clusters: [{ name: c.name, cluster: { server: this.kubeServer, 'certificate-authority-data': Buffer.from('-----BEGIN CERTIFICATE-----\nfake-aks\n-----END CERTIFICATE-----\n').toString('base64') } }], users: [{ name: `clusterUser_${c.name}`, user: { exec: { apiVersion: 'client.authentication.k8s.io/v1beta1', command: 'kubelogin', args: ['get-token', '--server-id', AKS_SERVER_APP] } } }], contexts: [{ name: c.name, context: { cluster: c.name, user: `clusterUser_${c.name}` } }], 'current-context': c.name });
      return { status: 200, body: { kubeconfigs: [{ name: 'clusterUser', value: Buffer.from(kubeconfig).toString('base64') }] } };
    }
    return null;
  }

  /** After a PUT: a cluster gets its FQDN and its agent pools from `agentPoolProfiles`. */
  afterPut(key: string, res: ArmLike, set: (key: string, v: ArmLike) => void, get: (key: string) => ArmLike | undefined): void {
    if (res.type.toLowerCase() !== 'microsoft.containerservice/managedclusters') return;
    const props = res.body.properties as Record<string, unknown>;
    props.fqdn = `${res.name}-dns.hcp.${res.location ?? 'westeurope'}.azmk8s.io`;
    props.kubernetesVersion ??= '1.31.0';
    for (const p of (props.agentPoolProfiles as { name: string }[] | undefined) ?? []) {
      const id = `${res.id}/agentPools/${p.name}`;
      if (get(id.toLowerCase())) continue;
      const { name: _n, ...rest } = p;
      set(id.toLowerCase(), { id, name: p.name, type: 'Microsoft.ContainerService/managedClusters/agentPools', etag: `W/"${randomUUID()}"`, body: { properties: { ...rest, provisioningState: 'Succeeded' } } });
    }
    void key;
  }

  /** A token for the AKS server application that the fake issued and has not expired. */
  acceptsToken(token: string): boolean {
    const t = this.tokens().get(token);
    return !!t && t.exp > Date.now() && t.scope.startsWith(AKS_SERVER_APP);
  }
}
