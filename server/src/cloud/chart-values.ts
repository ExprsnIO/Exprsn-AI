import { namePrefix } from './tags.js';
import type { NetworkRender } from './network.js';
import { SIZE_PRESETS, type DeployProvider, type DeploymentSpec } from './spec.js';

/*
 * 1.9.99-final, Sprint 58 (B-10203): the Helm values of a Kubernetes deployment, derived from its spec (the chart in
 * `deploy/helm/exprsn-ai` is the single source of the manifests). What comes from where:
 *
 *   image                  the spec's release image, by digest (an upgrade changes only this, B-10207)
 *   replicas, resources    the size preset (pods on the app node group's `exprsn.ai/role: app` nodes, spread over
 *                          the preset's availability zones, a PodDisruptionBudget above one replica)
 *   config.publicUrl       https://<front door hostname>
 *   secrets                the keys of the one Kubernetes Secret the deploy worker writes (`cloud/releases.ts`):
 *                          SESSION_SECRET, DATA_KEY, DATABASE_URL and REDIS_URL as files, never values here
 *   migrations             `job`: the chart's pre-install/pre-upgrade migrate Job
 *   blob store             a shared volume (ReadWriteMany) on the provider's file storage class until the data tier
 *                          provisions the bucket (B-103)
 *   ingress / service      AWS: an ALB from the AWS Load Balancer Controller (target type ip, certificate found by
 *                          host in ACM); Azure: AKS application routing (managed NGINX); DigitalOcean: the release's
 *                          Service of type LoadBalancer, which DigitalOcean's cloud controller turns into a load
 *                          balancer (TLS on it when a certificate id is given, B-10206)
 *   networkPolicy          the chart's policies, with the edge's and the data tier's ranges from the network render
 */

export const RELEASE_NAME = 'exprsn-ai';
export const RELEASE_NAMESPACE = 'exprsn-ai';
/** The Kubernetes Secret the release's pods mount (written by the deploy worker, named by the values). */
export const RELEASE_SECRET = 'exprsn-ai-secrets';
/** What `kubeVersion` the chart is rendered for when the cluster's is not known yet. */
export const DEFAULT_KUBE_VERSION = '1.31.0';

/** The provider's shared-volume storage class (ReadWriteMany): EFS CSI, Azure Files; DOKS has none built in. */
const RWX_CLASS: Record<DeployProvider, string> = { aws: 'efs-sc', azure: 'azurefile-csi', digitalocean: '' };

export interface ChartValuesInput {
  spec: DeploymentSpec;
  provider: DeployProvider;
  /** The account's name (resource name prefixes). */
  accountName: string;
  image: { repository: string; digest: string };
  placement: NetworkRender['placement'];
  /** Whether a Redis URL is in the Secret (more than one replica needs it). */
  redis: boolean;
  /** Provider ids of the edge subnets (the ALB's), when known. */
  edgeSubnetIds?: string[];
  /** DigitalOcean: the load balancer's certificate (B-10206). */
  tlsCertificateId?: string | null;
}

/** `registry/repo@sha256:...` → its repository and digest. */
export function splitImage(ref: string): { repository: string; digest: string } {
  const i = ref.lastIndexOf('@');
  if (i < 0 || !/^sha256:[a-f0-9]{64}$/.test(ref.slice(i + 1))) throw new Error('The image must be pinned by digest (registry/repository@sha256:<64 hex>).');
  return { repository: ref.slice(0, i), digest: ref.slice(i + 1) };
}

const ipBlocks = (cidrs: string[]) => cidrs.map((cidr) => ({ ipBlock: { cidr } }));
const secretRef = (key: string) => ({ name: RELEASE_SECRET, key });
const unset = (key: string) => ({ name: '', key });

export function chartValues(i: ChartValuesInput): Record<string, unknown> {
  const { spec, provider } = i;
  const preset = SIZE_PRESETS[spec.compute.size];
  const replicas = preset.app.replicas;
  const hostname = spec.frontDoor.hostname;
  const internal = spec.frontDoor.kind === 'cloudflare';
  const edge = i.placement.edge?.cidrs ?? [];
  const app = i.placement.app?.cidrs ?? [spec.network.cidr];
  const data = spec.data.mode === 'onprem' ? spec.data.cidrs : (i.placement.data?.cidrs ?? [spec.network.cidr]);
  const inference = i.placement.inference?.cidrs ?? [];
  const selector = { 'app.kubernetes.io/name': 'exprsn-ai', 'app.kubernetes.io/component': 'server' };

  let ingress: Record<string, unknown> = { enabled: false };
  let service: Record<string, unknown> = { type: 'ClusterIP', port: 80, annotations: {} };
  let controller: Record<string, unknown>;
  let fromEdge: { from: unknown[]; ports: unknown[] }[] = [];
  if (provider === 'aws') {
    ingress = {
      enabled: true,
      className: 'alb',
      annotations: {
        'alb.ingress.kubernetes.io/scheme': internal ? 'internal' : 'internet-facing',
        'alb.ingress.kubernetes.io/target-type': 'ip',
        'alb.ingress.kubernetes.io/listen-ports': '[{"HTTPS":443}]',
        'alb.ingress.kubernetes.io/healthcheck-path': '/readyz',
        'alb.ingress.kubernetes.io/load-balancer-attributes': 'idle_timeout.timeout_seconds=3600',
        'alb.ingress.kubernetes.io/target-group-attributes': 'stickiness.enabled=true,stickiness.type=lb_cookie,stickiness.lb_cookie.duration_seconds=86400',
        'alb.ingress.kubernetes.io/tags': `exprsn:managed=true,exprsn:account=${i.accountName},exprsn:deployment=${spec.name}`,
        ...(i.edgeSubnetIds?.length ? { 'alb.ingress.kubernetes.io/subnets': i.edgeSubnetIds.join(',') } : {})
      },
      hosts: [{ host: hostname, paths: [{ path: '/', pathType: 'Prefix' }] }],
      tls: []
    };
    controller = { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } }, podSelector: { matchLabels: { 'app.kubernetes.io/name': 'aws-load-balancer-controller' } } };
    // Target type ip: the ALB in the edge subnets reaches the pods directly.
    if (edge.length) fromEdge = [{ from: ipBlocks(edge), ports: [{ port: 'http', protocol: 'TCP' }] }];
  } else if (provider === 'azure') {
    ingress = {
      enabled: true,
      className: 'webapprouting.kubernetes.azure.com',
      annotations: {
        'nginx.ingress.kubernetes.io/proxy-read-timeout': '3600',
        'nginx.ingress.kubernetes.io/proxy-send-timeout': '3600',
        'nginx.ingress.kubernetes.io/proxy-body-size': '16m',
        'nginx.ingress.kubernetes.io/affinity': 'cookie',
        'nginx.ingress.kubernetes.io/session-cookie-name': 'exprsn-route',
        'nginx.ingress.kubernetes.io/session-cookie-secure': 'true'
      },
      hosts: [{ host: hostname, paths: [{ path: '/', pathType: 'Prefix' }] }],
      tls: [{ secretName: 'exprsn-ai-tls', hosts: [hostname] }]
    };
    controller = { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'app-routing-system' } }, podSelector: { matchLabels: { app: 'nginx' } } };
  } else {
    const tls = !!i.tlsCertificateId;
    service = {
      type: 'LoadBalancer',
      port: tls ? 443 : 80,
      annotations: {
        'service.beta.kubernetes.io/do-loadbalancer-name': `${namePrefix(i.accountName)}${spec.name}-lb`.slice(0, 255),
        'service.beta.kubernetes.io/do-loadbalancer-protocol': 'http',
        'service.beta.kubernetes.io/do-loadbalancer-healthcheck-path': '/readyz',
        'service.beta.kubernetes.io/do-loadbalancer-healthcheck-protocol': 'http',
        'service.beta.kubernetes.io/do-loadbalancer-sticky-sessions-type': 'cookies',
        'service.beta.kubernetes.io/do-loadbalancer-sticky-sessions-cookie-name': 'exprsn-route',
        'service.beta.kubernetes.io/do-loadbalancer-sticky-sessions-cookie-ttl': '86400',
        'service.beta.kubernetes.io/do-loadbalancer-http-idle-timeout-seconds': '3600',
        ...(tls ? { 'service.beta.kubernetes.io/do-loadbalancer-tls-ports': '443', 'service.beta.kubernetes.io/do-loadbalancer-certificate-id': i.tlsCertificateId!, 'service.beta.kubernetes.io/do-loadbalancer-redirect-http-to-https': 'true' } : {}),
        ...(internal ? { 'service.beta.kubernetes.io/do-loadbalancer-network': 'INTERNAL' } : {})
      }
    };
    controller = { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } }, podSelector: { matchLabels: { 'k8s-app': 'kube-proxy' } } };
    // The load balancer reaches the pods through the nodes (in the app VPC).
    fromEdge = [{ from: ipBlocks(app), ports: [{ port: 'http', protocol: 'TCP' }] }];
  }

  const rwx = RWX_CLASS[provider];
  const k = keyValues(spec);
  return {
    fullnameOverride: RELEASE_NAME,
    image: { repository: i.image.repository, digest: i.image.digest, tag: '', pullPolicy: 'IfNotPresent' },
    replicaCount: replicas,
    config: {
      publicUrl: `https://${hostname}`,
      nodeEnv: 'production',
      trustProxy: 'uniquelocal',
      database: { client: 'pg', poolMax: 10 },
      kms: { provider: k.provider },
      blobStore: { type: 'pvc', pvc: { existingClaim: '', storageClassName: rwx, accessModes: ['ReadWriteMany'], size: `${preset.bucketGb}Gi` } },
      workersEnabled: true,
      jobConcurrency: 4,
      extra: k.extra
    },
    serviceAccount: { create: true, name: '', annotations: k.annotations, automountServiceAccountToken: false },
    // Sprint 59 (B-10302): a provisioned database's CA bundle, at /run/secrets/database_ca.pem (the URL's sslrootcert).
    extraSecretFiles: spec.data.mode === 'provision' ? [...k.secretFiles, { name: RELEASE_SECRET, key: 'database_ca', path: 'database_ca.pem' }] : k.secretFiles,
    extraVolumes: k.volumes,
    extraVolumeMounts: k.mounts,
    secrets: {
      SESSION_SECRET: secretRef('session_secret'),
      DATA_KEY: k.provider === 'local' ? secretRef('data_key') : unset('data_key'),
      DATABASE_URL: secretRef('database_url'),
      REDIS_URL: i.redis ? secretRef('redis_url') : unset('redis_url'),
      METRICS_TOKEN: unset('metrics_token'),
      OPENBAO_TOKEN: unset('openbao_token'),
      S3_SECRET_ACCESS_KEY: unset('s3_secret_access_key'),
      SMTP_URL: unset('smtp_url'),
      SIEM_TOKEN: unset('siem_token')
    },
    migrations: { mode: 'job' },
    nodeSelector: { 'exprsn.ai/role': 'app' },
    resources: { requests: { cpu: String(Math.max(0.25, preset.app.vcpu / 4)), memory: `${Math.max(1, Math.floor(preset.app.memoryGb / 4))}Gi` }, limits: { memory: `${Math.max(1, Math.floor((preset.app.memoryGb * 3) / 4))}Gi` } },
    topologySpreadConstraints: preset.azs > 1 ? [{ maxSkew: 1, topologyKey: 'topology.kubernetes.io/zone', whenUnsatisfiable: 'ScheduleAnyway', labelSelector: { matchLabels: selector } }] : [],
    podDisruptionBudget: { enabled: replicas > 1, minAvailable: 1 },
    service,
    ingress,
    networkPolicy: {
      enabled: true,
      zoneLabel: spec.zones.app,
      ingress: { controller, extra: fromEdge },
      egress: {
        database: { to: ipBlocks(data), ports: [{ port: 5432, protocol: 'TCP' }] },
        redis: { to: i.redis ? ipBlocks(data) : [], ports: [{ port: 6379, protocol: 'TCP' }] },
        inference: { to: ipBlocks(inference), ports: [{ port: 11434, protocol: 'TCP' }, { port: 8188, protocol: 'TCP' }] }
      }
    }
  };
}

/** Where the key-encryption key lives (open decision 8, B-10208): the keys of the Secret beside the four always there. */
export function secretKeysFor(spec: DeploymentSpec): string[] {
  if (spec.clusterKeys) return [];
  if (spec.keys?.provider === 'aws-kms') return ['kms_aws_secret_access_key'];
  if (spec.keys?.provider === 'azure-keyvault') return ['azure_identity_client_secret'];
  return ['data_key'];
}

const TOKEN_DIR = '/var/run/secrets/exprsn';

/**
 * The KMS settings of the release. `clusterKeys`: the cloud KMS through the pods' workload identity, with the
 * projected service-account token mounted by the chart itself (audience `sts.amazonaws.com` or
 * `api://AzureADTokenExchange`), so no admission webhook is relied on and no DATA_KEY or cloud secret is in the
 * cluster. `keys` (a vaulted key pair or client secret): the secret as a file from the release's Secret. Neither: the
 * local KMS with DATA_KEY as a file.
 */
function keyValues(spec: DeploymentSpec): { provider: string; extra: Record<string, string>; annotations: Record<string, string>; secretFiles: unknown[]; volumes: unknown[]; mounts: unknown[] } {
  const token = (name: string, audience: string) => ({ volumes: [{ name, projected: { defaultMode: 0o440, sources: [{ serviceAccountToken: { audience, expirationSeconds: 3600, path: 'token' } }] } }], mounts: [{ name, mountPath: `${TOKEN_DIR}/${name.replace(/-token$/, '')}`, readOnly: true }] });
  const file = (key: string) => ({ name: RELEASE_SECRET, key, path: key });
  const ck = spec.clusterKeys;
  if (ck?.provider === 'aws-kms') {
    const t = token('aws-token', 'sts.amazonaws.com');
    return { provider: 'aws-kms', extra: { KMS_AWS_REGION: ck.region, KMS_AWS_ROLE_ARN: ck.roleArn, KMS_AWS_WEB_IDENTITY_TOKEN_FILE: `${TOKEN_DIR}/aws/token`, KMS_AWS_STS_URL: `https://sts.${ck.region}.amazonaws.com` }, annotations: {}, secretFiles: [], ...t };
  }
  if (ck?.provider === 'azure-keyvault') {
    const t = token('azure-token', 'api://AzureADTokenExchange');
    return { provider: 'azure-keyvault', extra: { KMS_AZURE_VAULT_URL: ck.vaultUrl, AZURE_IDENTITY_TENANT_ID: ck.tenantId, AZURE_IDENTITY_CLIENT_ID: ck.clientId, AZURE_IDENTITY_FEDERATED_TOKEN_FILE: `${TOKEN_DIR}/azure/token` }, annotations: { 'azure.workload.identity/client-id': ck.clientId }, secretFiles: [], ...t };
  }
  const kk = spec.keys;
  if (kk?.provider === 'aws-kms') return { provider: 'aws-kms', extra: { KMS_AWS_REGION: kk.region, KMS_AWS_ACCESS_KEY_ID: kk.accessKeyId, KMS_AWS_SECRET_ACCESS_KEY_FILE: '/run/secrets/kms_aws_secret_access_key' }, annotations: {}, secretFiles: [file('kms_aws_secret_access_key')], volumes: [], mounts: [] };
  if (kk?.provider === 'azure-keyvault') return { provider: 'azure-keyvault', extra: { KMS_AZURE_VAULT_URL: kk.vaultUrl, AZURE_IDENTITY_TENANT_ID: kk.tenantId, AZURE_IDENTITY_CLIENT_ID: kk.clientId, AZURE_IDENTITY_CLIENT_SECRET_FILE: '/run/secrets/azure_identity_client_secret' }, annotations: {}, secretFiles: [file('azure_identity_client_secret')], volumes: [], mounts: [] };
  return { provider: 'local', extra: {}, annotations: {}, secretFiles: [], volumes: [], mounts: [] };
}
