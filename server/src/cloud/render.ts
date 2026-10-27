import type { ZoneSpec } from '../zones/spec.js';
import type { DesiredResource } from './graph.js';
import { dataPlacement, publicDataProblems, renderNetwork, type NetworkRender } from './network.js';
import type { ResourceType, Support } from './providers/types.js';
import { PROVIDER_SKUS, SIZE_PRESETS, specAssumptions, type DeploymentSpec } from './spec.js';
import { containerProps, vmAppProps } from './compute.js';
import { DEFAULT_EXTENSIONS } from './databases.js';
import { DEFAULT_CACHE_SERVICE } from './caches.js';
import { renderGpuNodeInit } from './gpu-node.js';
import { renderCloudflareAppTier } from './cloudflare-app.js';

/*
 * 1.9.99-final, Sprint 57 (B-10201, B-10202): a deployment spec rendered into its desired graph, the resources the
 * planner (`cloud/planner.ts`) compares with what the provider reports.
 *
 *   network foundation   network, subnets and one firewall per zone (`cloud/network.ts`, from the zone specs)
 *   compute              kubernetes: cluster, app node group, a node group per GPU pool, the load balancer
 *                        vm:         one VM per app replica, GPU VMs per pool, the load balancer (Sprint 58,
 *                                    B-10204: cloud-init runs the installer from the signed release, `cloud/compute.ts`)
 *                        container:  the container service (Sprint 58, B-10205: ECS on Fargate with the ALB the
 *                                    service owns, Container Apps or App Platform, each with its own ingress)
 *   data tier            provision: PostgreSQL and Redis on private endpoints in the data zone, and the blob
 *                        bucket, all without public access; existing: references only; on-prem: nothing (the zones
 *                        reach it)
 *   front door           acme: a DNS record in the provider's DNS (dns-01 for the certificate); byo: nothing;
 *                        cloudflare: a tunnel and a proxied record on the Cloudflare account, rendered apart
 *                        (`frontDoor`), since a deployment's graph lives on one account (B-10901 plans them)
 *
 * Types the provider's adapter does not build yet are rendered anyway; `unavailableIn` names them, and the plan
 * shows them as unavailable (apply refuses the plan). Pure: no provider, no database.
 */

export interface RenderEnv {
  /** The current zone set and the corporate network (`s.zones.current()`, ZONES_CORPORATE_CIDRS). */
  zones: Map<string, { version: number; spec: ZoneSpec }>;
  corporateCidrs: string[];
}

export interface GraphRender {
  resources: DesiredResource[];
  network: NetworkRender;
  /** The Cloudflare front door's resources (on the front door's account), or none. */
  frontDoor: { accountId: string; resources: DesiredResource[]; planned: false; note: string } | null;
  /**
   * Sprint 61 (B-10905): a `cloudflare` shape's app tier on the Cloudflare account (Worker with static assets,
   * Containers, Hyperdrive, the R2 bucket; `cloud/cloudflare-app.ts`), planned on a deployment of that account.
   */
  appTier?: { accountId: string; resources: DesiredResource[]; notes: string[] } | null;
  notes: string[];
}

const k = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);

/** The record name relative to its zone (`@` for the apex). */
export const relativeName = (hostname: string, zone: string): string => (hostname === zone ? '@' : hostname.slice(0, -(zone.length + 1)));

/**
 * Sprint 60 (B-10401, B-10404, B-10405): what a GPU node group or VM carries beside its size: the allowed sizes and
 * zones in order (the capacity fallback; a size in `capacity.sizes` satisfies the plan, so a fallback is not drift),
 * the warm-up source, and the node's pool and DaemonSet images.
 */
function gpuExtras(g: DeploymentSpec['gpuPools'][number], sku: string): Record<string, unknown> {
  return { capacity: { sizes: [...new Set([sku, ...g.fallbackTypes])], zones: g.zones }, warmup: g.warmup, gpuNode: { pool: g.name, ...(g.images ? { images: g.images } : {}) } };
}

export function renderGraph(spec: DeploymentSpec, env: RenderEnv): GraphRender {
  const provider = spec.target.provider;
  const preset = SIZE_PRESETS[spec.compute.size];
  const skus = PROVIDER_SKUS[provider];
  const size = spec.compute.size;
  const assumptions = specAssumptions(spec);
  const network = renderNetwork({ spec, provider, region: spec.target.region, zones: env.zones, corporateCidrs: env.corporateCidrs });
  const out: DesiredResource[] = [...network.resources];
  const notes: string[] = [];
  const pl = network.placement;
  const app = pl.app!;
  const edge = pl.edge!;
  const inference = pl.inference;
  const add = (r: Omit<DesiredResource, 'region' | 'protect'> & { protect?: boolean }) => out.push({ region: null, protect: false, ...r });
  const appSubnets = app.subnets;
  const appDeps = [...appSubnets, app.firewall];
  // Sprint 59 (B-10302, B-10305): app VMs and container services read the provisioned database's and cache's URLs at
  // create time, so they wait for them (the Kubernetes release runs after the whole apply).
  const dataDeps = spec.data.mode === 'provision' ? ['db', ...(spec.data.cache ? ['cache'] : [])] : [];
  const internal = spec.frontDoor.kind === 'cloudflare';

  // The app's data settings: references only, never a value.
  const data: Record<string, unknown> =
    spec.data.mode === 'existing' ? { mode: 'existing', databaseUrlRef: spec.data.databaseUrlRef, ...(spec.data.redisUrlRef ? { redisUrlRef: spec.data.redisUrlRef } : {}) } : spec.data.mode === 'onprem' ? { mode: 'onprem', cidrs: spec.data.cidrs, ports: spec.data.ports } : { mode: 'provision', database: 'db', cache: spec.data.cache ? 'cache' : null, blobs: 'blobs' };

  // ---------- compute ----------
  let lbTarget: string[] = [];
  if (spec.compute.shape === 'kubernetes') {
    // Sprint 58 (B-10203): AKS and DOKS need a node pool at create, so the cluster is made with the app pool, which
    // the `nodes-app` step then adopts by name; the release (the Helm chart, `cloud/releases.ts`) is installed after.
    const appPool = { name: `${spec.name}-nodes-app`, size: skus.app[size], count: preset.app.replicas, poolName: 'app', ...(appSubnets[0] ? { subnet: appSubnets[0] } : {}) };
    add({ key: 'cluster', type: 'kubernetes_cluster', spec: { ha: preset.ha, privateEndpoint: true, subnets: appSubnets, firewall: app.firewall, initialPool: appPool, helm: { chart: 'exprsn-ai', image: spec.release?.image ?? null, values: { replicas: preset.app.replicas, data } } }, dependsOn: appDeps, network: app.network });
    add({ key: 'nodes-app', type: 'node_group', spec: { role: 'app', size: skus.app[size], count: preset.app.replicas, min: preset.app.replicas, max: preset.app.replicas * 2, subnets: appSubnets, cluster: `${spec.name}-cluster`, poolName: 'app' }, dependsOn: ['cluster', ...appSubnets] });
    for (const g of spec.gpuPools) {
      const sku = skus.gpu[g.gpu]!;
      const subnets = inference?.subnets ?? appSubnets;
      add({ key: k(`gpu-${g.name}`), type: 'node_group', spec: { role: 'gpu', gpu: g.gpu, gpus: sku.gpus, size: sku.sku, min: g.min, max: g.max, busyHours: g.busyHours, scaleToZero: g.min === 0, subnets, cluster: `${spec.name}-cluster`, poolName: `g${g.name.replace(/[^a-z0-9]/g, '')}`.slice(0, 12), taints: ['exprsn.ai/gpu=true:NoSchedule'], ...gpuExtras(g, sku.sku), ...(g.purchase === 'spot' ? { purchase: 'spot' } : {}) }, dependsOn: ['cluster', ...subnets], tags: { pool: g.name } });
      // Sprint 60 (B-10403): a spot pool's on-demand sibling (min 0), which the autoscaler grows when spot capacity runs out.
      if (g.purchase === 'spot') add({ key: k(`gpu-${g.name}-od`), type: 'node_group', spec: { role: 'gpu', gpu: g.gpu, gpus: sku.gpus, size: sku.sku, min: 0, max: g.max, busyHours: 0, scaleToZero: true, purchase: 'on_demand', fallbackFor: k(`gpu-${g.name}`), subnets, cluster: `${spec.name}-cluster`, poolName: `o${g.name.replace(/[^a-z0-9]/g, '')}`.slice(0, 12), taints: ['exprsn.ai/gpu=true:NoSchedule'], ...gpuExtras(g, sku.sku) }, dependsOn: ['cluster', ...subnets], tags: { pool: g.name } });
    }
    lbTarget = ['cluster'];
  } else if (spec.compute.shape === 'vm') {
    for (let i = 1; i <= preset.app.replicas; i++) {
      const sub = appSubnets.length ? appSubnets[(i - 1) % appSubnets.length]! : null;
      add({ key: `app-${i}`, type: 'vm', spec: { ...vmAppProps(spec, { size: skus.app[size], ...(sub ? { subnet: sub } : {}), firewall: app.firewall }), data }, dependsOn: [...appDeps, ...dataDeps], network: app.network });
      lbTarget.push(`app-${i}`);
    }
    for (const g of spec.gpuPools) {
      const sku = skus.gpu[g.gpu]!;
      const n = Math.max(g.min, 1);
      for (let i = 1; i <= n; i++) {
        const key = k(`gpu-${g.name}-${i}`);
        // Sprint 60 (B-10401, B-10404): the node bootstrap (enrolment with a single-use token, the mTLS proxy, warm-up from the mirror).
        const sub = inference?.subnets.length ? inference.subnets[(i - 1) % inference.subnets.length]! : null;
        add({ key, type: 'vm', spec: { role: 'gpu', gpu: g.gpu, gpus: sku.gpus, size: sku.sku, image: 'ubuntu-24.04-gpu', imdsV2: true, metadataHopLimit: 1, publicIp: false, scaleToZero: g.min === 0, busyHours: g.busyHours, ...(sub ? { subnet: sub } : {}), firewall: inference?.firewall ?? app.firewall, ...gpuExtras(g, sku.sku), userData: renderGpuNodeInit({ deployment: spec.name, pool: g.name, key, warmup: g.warmup }), ...(g.warmup.source === 'snapshot' ? { modelVolume: { snapshotId: g.warmup.snapshotId, label: 'exprsn-models' } } : {}) }, dependsOn: inference ? [...inference.subnets, inference.firewall] : appDeps, network: inference?.network ?? app.network, tags: { pool: g.name } });
      }
    }
    if (spec.gpuPools.some((g) => g.min === 0)) notes.push('GPU VM pools with a minimum of 0 are rendered with one VM that is stopped while idle; scale-to-zero arrives with the GPU pools (B-104).');
  } else if (spec.compute.shape === 'cloudflare') {
    // Sprint 61 (B-10905): the app tier is on the Cloudflare account (`appTier` below); nothing of it on this one.
  } else {
    // Sprint 58 (B-10205): the ECS service owns its ALB (target group and listener), so no separate load balancer.
    const c = containerProps(spec, { replicas: preset.app.replicas, vcpu: preset.app.vcpu, memoryGb: preset.app.memoryGb, subnets: appSubnets, firewall: app.firewall, ingress: internal ? 'internal' : 'internet-facing' });
    add({ key: 'app', type: 'container_service', spec: { ...c, ...(provider === 'aws' ? { lbSubnets: edge.subnets, lbFirewall: edge.firewall } : {}), data }, dependsOn: provider === 'aws' ? [...appDeps, ...edge.subnets, edge.firewall, ...dataDeps] : [...appDeps, ...dataDeps], network: app.network });
    notes.push(`${c.platform === 'ecs-fargate' ? 'The ECS service owns its application load balancer' : c.platform === 'container-apps' ? 'Azure Container Apps brings its own ingress' : 'App Platform brings its own ingress'}; no separate load balancer is rendered. Migrations run as a one-off ${c.platform === 'ecs-fargate' ? 'task' : 'job'} before every rollout.`);
  }
  if (lbTarget.length) {
    // Sprint 58 (B-10203): on Kubernetes the cluster's controller makes it from the release (managedBy: cluster).
    add({ key: 'lb', type: 'load_balancer', spec: { ...(spec.compute.shape === 'kubernetes' ? { managedBy: 'cluster' } : {}), scheme: internal ? 'internal' : 'internet-facing', listeners: [{ port: 443, protocol: 'tls' }], subnets: edge.subnets, firewall: edge.firewall, targets: lbTarget }, dependsOn: [...edge.subnets, edge.firewall, ...lbTarget], network: edge.network });
  }

  // ---------- data tier ----------
  if (spec.data.mode === 'provision') {
    const place = dataPlacement(network)!;
    const deps = [...place.subnets, place.firewall];
    add({ key: 'db', type: 'database', spec: { engine: 'postgres', version: '17', size: skus.database[size], ha: preset.database.ha, storageGb: assumptions.storageGb, subnets: place.subnets, firewall: place.firewall, publicAccess: false, privateEndpoint: true, backups: { days: 7, ...(provider === 'digitalocean' ? {} : { window: '02:00-03:00' }) }, maintenanceWindow: { day: 'sun', hour: 3 }, storageAutogrow: true, extensions: [...DEFAULT_EXTENSIONS], deletionProtection: true, adminUser: 'exprsn', adminPasswordRef: `vault:cloud/${spec.name}#db_admin_password` }, dependsOn: deps, network: place.network, protect: true });
    // Sprint 59 (B-10305): the cache BullMQ and the bus can use as REDIS_URL: cluster mode off, noeviction, TLS.
    // Sprint 61 (B-10905): not for a Cloudflare app tier, which cannot reach a private cache (open decision 19).
    if (spec.data.cache && spec.compute.shape !== 'cloudflare') add({ key: 'cache', type: 'cache', spec: { engine: provider === 'digitalocean' ? 'valkey' : 'redis', service: DEFAULT_CACHE_SERVICE[provider as 'aws' | 'azure' | 'digitalocean'], size: skus.cache[size], ha: preset.cache.ha, clusterMode: false, evictionPolicy: 'noeviction', subnets: place.subnets, firewall: place.firewall, publicAccess: false, privateEndpoint: true, tls: true }, dependsOn: deps, network: place.network });
    // A Cloudflare app tier keeps its blobs on R2 (its `appTier`), not in this provider's object store.
    if (spec.compute.shape !== 'cloudflare') add({ key: 'blobs', type: 'bucket', spec: { publicAccess: false, versioning: true, sizeGb: preset.bucketGb }, dependsOn: [], protect: true });
  } else if (spec.data.mode === 'existing') notes.push('The data tier exists already: the app gets its references; nothing is provisioned.');
  else notes.push('The data tier is on-prem: the app reaches it as its zone allows; nothing is provisioned.');

  // ---------- front door ----------
  let frontDoor: GraphRender['frontDoor'] = null;
  const fd = spec.frontDoor;
  if (fd.kind === 'acme') {
    add({
      key: 'dns-app',
      type: 'dns_record',
      spec: { zone: fd.zone, record: relativeName(fd.hostname, fd.zone), recordType: 'CNAME', values: [], valueFrom: { key: lbTarget.length ? 'lb' : 'app', field: 'address' }, ttl: 300, acme: { challenge: 'dns-01', dnsProvider: provider === 'aws' ? 'route53' : provider === 'azure' ? 'azure-dns' : 'digitalocean' } },
      dependsOn: lbTarget.length ? ['lb'] : ['app']
    });
  } else if (fd.kind === 'byo') {
    notes.push(`Bring your own front door: point ${fd.hostname} at the ${lbTarget.length ? 'load balancer' : 'service'}'s address once it is applied.`);
  } else if (spec.compute.shape === 'cloudflare') {
    // Sprint 61 (B-10905): the Worker answers on the hostname (its custom domain, in `appTier`); the tunnel carries
    // Hyperdrive to a database without a public address (the provisioned or on-prem one).
    frontDoor = {
      accountId: fd.accountId,
      planned: false,
      note: 'The Cloudflare app tier answers on the hostname through its Worker; the tunnel connects Hyperdrive to the data tier.',
      resources: spec.data.mode === 'existing' && spec.compute.cloudflare?.databaseVia !== 'tunnel' ? [] : [{ key: 'tunnel', type: 'tunnel', spec: { origin: spec.data.mode === 'provision' ? 'db' : 'onprem', purpose: 'hyperdrive' }, dependsOn: [], protect: false, region: null }]
    };
  } else {
    frontDoor = {
      accountId: fd.accountId,
      planned: false,
      note: 'The Cloudflare front door lives on the Cloudflare account; it is rendered here and planned with the edge work (B-10901), since a deployment graph lives on one account.',
      resources: [
        { key: 'tunnel', type: 'tunnel', spec: { origin: lbTarget.length ? 'lb' : 'app' }, dependsOn: [], protect: false, region: null },
        { key: 'dns-app', type: 'dns_record', spec: { zone: fd.zone, record: relativeName(fd.hostname, fd.zone), recordType: 'CNAME', values: [], valueFrom: { key: 'tunnel', field: 'cname' }, proxied: true, plan: fd.plan }, dependsOn: ['tunnel'], protect: false, region: null }
      ]
    };
  }
  const appTier = renderCloudflareAppTier(spec);
  if (appTier) notes.push(...appTier.notes);
  return { resources: out, network, frontDoor, notes, appTier };
}

/** The resource types of a graph an adapter does not build (`supports(type, 'create')`), with why. */
export function unavailableIn(resources: DesiredResource[], supports: (type: ResourceType) => Support, note?: (type: ResourceType) => string | undefined): { key: string; type: ResourceType; support: Exclude<Support, 'built'>; reason: string }[] {
  const out: { key: string; type: ResourceType; support: Exclude<Support, 'built'>; reason: string }[] = [];
  for (const r of resources) {
    const s = supports(r.type);
    if (s !== 'built') out.push({ key: r.key, type: r.type, support: s, reason: note?.(r.type) ?? (s === 'not_yet' ? `${r.type} is not built yet for this provider.` : `The provider offers no ${r.type}.`) });
  }
  return out;
}

/** The graph's refusals: a data resource with a public address (B-10202). */
export function graphProblems(resources: DesiredResource[]): string[] {
  return publicDataProblems(resources);
}
