import type { CacheAccess, CacheProps } from '../caches.js';
import type { ProviderCredential } from '../credentials.js';
import type { CloudAccount, CloudFeature, IdentityResult, PermissionCheck, Provider } from '../types.js';

/*
 * 1.9.99-final, Sprint 56 (B-10101): the `CloudProvider` interface every adapter implements, and the resource surface
 * the planner and the apply worker (Sprint 57, B-10103, B-10104) drive. Nothing outside `cloud/providers/` calls a
 * provider; every call an adapter makes goes through `CloudTransport` (the egress guard and the rate limiter).
 *
 * The shape of a step, as the apply worker will journal it:
 *
 *   find(spec)            → adopt what a lost response already created (lookup by tag, name or client token)
 *   create(spec)          → done, or an `OperationHandle` (JSON, journalled) to poll
 *   poll(handle)          → pending (with a wait), succeeded (with the resource) or failed
 *   describe(ref)         → the observed state, or null when it is gone
 *   update(ref, spec)     → done or a handle; delete(ref) → done or a handle
 *
 * A type an adapter does not offer answers `unsupported` (the provider has no such thing) or `not_yet` (it has, but
 * this build does not drive it yet) from `supports`, and the calls throw `CloudUnsupported` with the same; the planner
 * shows both as unavailable, never as an error.
 */

// Sprint 61 (B-10905): `worker` (a Cloudflare Worker with its static assets, bindings and custom domain) and
// `hyperdrive` (a Hyperdrive configuration), Cloudflare's app tier; every other provider answers them unsupported.
export const RESOURCE_TYPES = ['network', 'subnet', 'firewall', 'kubernetes_cluster', 'node_group', 'vm', 'container_service', 'database', 'cache', 'bucket', 'dns_record', 'load_balancer', 'tunnel', 'secret', 'worker', 'hyperdrive'] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const RESOURCE_OPERATIONS = ['describe', 'list', 'create', 'update', 'delete', 'poll'] as const;
export type ResourceOperation = (typeof RESOURCE_OPERATIONS)[number];

/** `built`: driven by this build. `not_yet`: the provider has it, a later sprint drives it. `unsupported`: the provider has no such thing. */
export type Support = 'built' | 'not_yet' | 'unsupported';

/**
 * How a repeated create finds what an earlier attempt made: `client_token` (the provider deduplicates on a token we
 * send), `put_by_name` (the create is a PUT of a name we choose), `lookup_by_tag` (a tag we set at create time),
 * `lookup_by_name` (a unique name we choose), `natural` (the provider keys the resource on what we send, as a DNS
 * record set's name and type).
 */
export type Idempotency = 'client_token' | 'put_by_name' | 'lookup_by_tag' | 'lookup_by_name' | 'natural';

/** Where the `exprsn:*` tags go: `native` tags, `metadata` (Azure DNS), `description` text, `comment` (Cloudflare DNS), the `name` prefix only, or `none` (the provider keeps no labels on it; the journal holds them). */
export type Tagging = 'native' | 'metadata' | 'description' | 'comment' | 'name' | 'none';

export interface Capability {
  support: Support;
  /** The provider's own name for it (EC2 VPC, Azure virtual network, DigitalOcean VPC, R2 bucket...). */
  native: string;
  operations: readonly ResourceOperation[];
  idempotency?: Idempotency;
  tagging?: Tagging;
  /** Long-running operations: how `poll` follows them. */
  lro?: string;
  /** Why it is `not_yet` or `unsupported`, or a caveat. */
  note?: string;
}

export type CapabilityTable = Record<ResourceType, Capability>;

/** The credential an adapter is handed: what `s.cloud.credentials.for(account, purpose)` buys (B-10003 to B-10006). */
export type AdapterCredential = ProviderCredential;

/** Who a call is for. Adapters refuse to run without an account (`assertAccount`). */
export interface CallContext {
  account: CloudAccount;
  cred: AdapterCredential;
  /** The region for regional resources (default: the account's default region). */
  region?: string;
  /** Azure: the resource group the managed resources live in (default `exprsn-<account>`). */
  resourceGroup?: string;
  signal?: AbortSignal;
  /**
   * Sprint 58 (B-10204, B-10205): the deployment's secret broker, when the engine has one (`EngineHooks.secrets`).
   * Adapters ask it for a value only to hand it straight to the provider's own secret store or a single-use wrapped
   * token, never to put it in props, observed state, the journal or an error.
   */
  secrets?: SecretBrokerContext;
}

/** One secret a VM or container needs: its name (the systemd credential or file name), the variable whose `_FILE` form the app reads, and the `vault:` reference it resolves from. */
export interface SecretBinding {
  name: string;
  env: string;
  ref: string;
}

/** What an adapter may ask of the engine's secret broker for one deployment. */
export interface SecretBrokerContext {
  /** The value of a binding's reference (for the provider's own secret store: Secrets Manager, Container Apps secrets, App Platform `SECRET` values). */
  value(binding: SecretBinding): Promise<string>;
  /** A single-use, short-lived OpenBao response-wrapping token holding these bindings' values, for a VM's first boot; null when no OpenBao is configured. */
  wrap(bindings: SecretBinding[]): Promise<{ token: string; addr: string; ttlSeconds: number } | null>;
  /** Sprint 60 (B-10401): a single-use enrolment token (with the enrolment URL and the mirror host) for one GPU VM. */
  enrol?(pool: string, key: string): Promise<{ token: string; url: string; mirror: string | null; expiresAt: number } | null>;
}

/** B-10204: what the bare-metal installer reported on a VM's console (`exprsn-install:` lines). */
export interface InstallStatus {
  state: 'installed' | 'refused' | 'pending' | 'unknown';
  detail: string;
}

export interface FirewallRule {
  protocol: 'tcp' | 'udp' | 'icmp' | 'all';
  /** A port or a range `from-to`; ignored for icmp and all. */
  ports?: string;
  sources: string[];
  description?: string;
}

/** What each type's `props` hold (the planner's desired spec); fields beyond these are provider-specific. */
export interface PropsByType {
  network: { cidr: string };
  subnet: { cidr: string; zone?: string };
  firewall: { ingress: FirewallRule[]; description?: string };
  bucket: {
    /** The provider's bucket name, when it must be chosen (S3 names are global). */ bucketName?: string;
    locationHint?: string;
    /** 1.9.99-final, Sprint 61 (B-10906): an R2 bucket's jurisdiction (`cloud/r2.ts`); the region `r2-eu` or `r2-fedramp` implies it. */
    jurisdiction?: 'default' | 'eu' | 'fedramp';
  };
  dns_record: { zone: string; /** Relative to the zone (`@` for the apex). */ record: string; recordType: 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX' | 'CAA'; values: string[]; ttl?: number; proxied?: boolean; /** Azure: the resource group holding the zone (default: the context's). */ zoneGroup?: string };
  vm: {
    size: string;
    image: string;
    sshKeys?: string[];
    /** Sprint 58 (B-10204): the graph keys of its subnet and firewall (their provider ids arrive in `parent.refs`). */
    subnet?: string;
    firewall?: string;
    /** cloud-init user data (`cloud/compute.ts`), with no secret value in it; `@@EXPRSN_BOOTSTRAP@@` is replaced at create time by the wrapped token. */
    userData?: string;
    /** EC2: IMDSv2 required (`HttpTokens: required`) with this hop limit (1: nothing behind the instance reaches it). */
    imdsV2?: boolean;
    metadataHopLimit?: number;
    publicIp?: boolean;
    /** The release the installer verifies and installs (`install.sh --from-release <url> --sha256 <digest>`). */
    install?: { from: 'release'; url: string | null; sha256: string | null; bundleUrl?: string | null; identity?: string | null; version?: string | null };
    /** The systemd credentials the unit loads (`LoadCredential=`), by reference only. */
    secrets?: SecretBinding[];
    /** EC2: an instance profile for the app (cloud KMS, B-10208); Azure: none. */
    instanceProfile?: string;
  };
  container_service: ContainerServiceProps;
  tunnel: Record<string, never>;
  kubernetes_cluster: KubernetesClusterProps;
  node_group: NodeGroupProps;
  load_balancer: LoadBalancerProps;
  /** Sprint 59 (B-10305): a managed cache for `REDIS_URL` (`cloud/caches.ts`). */
  cache: CacheProps;
  database: DatabaseProps;
}

/**
 * Sprint 59 (B-10301, B-10303, B-10307): a managed PostgreSQL or MySQL database (RDS, Aurora, Azure Database Flexible
 * Server, DigitalOcean Managed Databases). `cloud/databases.ts` holds the engines, versions, sizes and the extension
 * allow-lists. Private only: `publicAccess` must be false and the database lives in the data zone's subnets behind its
 * firewall (`subnets`, `firewall`: graph keys, their provider ids in `parent.refs`). Deletion protection is on unless
 * `deletionProtection: false` was set when it was created; a protected database is deleted only by destroy, after its
 * final snapshot.
 */
export interface DatabaseProps {
  engine: 'postgres' | 'mysql';
  /** AWS: `rds` (an RDS instance, the default) or `aurora` (an Aurora cluster with its writer instance). */
  service?: 'rds' | 'aurora';
  /** The major version (`17`, `8.0`); the provider's default for the engine when absent. Changing it replaces the database. */
  version?: string;
  /** The provider's size (`db.m6g.large`, `Standard_D2ds_v5`, `db-s-2vcpu-4gb`). */
  size: string;
  /** A standby in another zone (RDS Multi-AZ, Aurora reader, Azure zone-redundant HA, a DigitalOcean standby node). */
  ha?: boolean;
  storageGb?: number;
  storageAutogrow?: boolean;
  subnets?: string[];
  firewall?: string;
  publicAccess?: boolean;
  privateEndpoint?: boolean;
  /** The provider's own automated backups: retention in days and, where the provider takes one, the daily window (`03:00-04:00` UTC). */
  backups?: { days: number; window?: string };
  /** The weekly maintenance window, UTC. */
  maintenanceWindow?: { day: 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'; hour: number };
  /** Engine parameters (an RDS parameter group, Azure server parameters, DigitalOcean config). */
  parameters?: Record<string, string>;
  /** PostgreSQL extensions to allow-list and check (`vector`, `postgis`, `pg_trgm`). */
  extensions?: string[];
  /** Default true. */
  deletionProtection?: boolean;
  /** A vault reference to the admin password; without one the provider manages it (RDS) or it is never kept (see `cloud/databases.ts`). */
  adminPasswordRef?: string;
  adminUser?: string;
  /** Restore to a new instance: the provider's snapshot id this database starts from (B-10307). */
  restoreFrom?: string;
}

/** Sprint 59 (B-10307): one snapshot or backup of a database, as the provider lists it. */
export interface DatabaseSnapshot {
  /** The provider's id (what `restoreSnapshot` takes). */
  id: string;
  name: string;
  /** `manual` (taken by Exprsn-AI or by hand), `automated` (the provider's schedule), `restore_point` (a time inside the provider's point-in-time window), `copy` (a retained copy: a final snapshot where the provider's backups die with the database). */
  kind: 'manual' | 'automated' | 'restore_point' | 'copy';
  state: 'pending' | 'available' | 'failed';
  createdAt: number | null;
  /** Billed storage, GB (the database's storage where the provider does not say). */
  sizeGb: number | null;
  /** When the provider deletes it by itself (automated backups, restore points), or null for one kept until deleted. */
  expiresAt: number | null;
  /** Taken as the final snapshot before a delete. */
  final: boolean;
  /** What it is billed as, for the price catalogue: `<sku>` per `unit` (`rds:snapshot` per gb-month, `do-db:<size>` per month for a copy). */
  billing: { sku: string; unit: 'gb-month' | 'month' | 'included' } | null;
}

/** Sprint 59 (B-10301): what an extension check found for one extension. */
export interface ExtensionStatus {
  name: string;
  /** `available`: offered for the engine version and allowed; `not_allowed`: offered but not in the allow-list yet; `not_offered`: the provider does not offer it for this engine and version. */
  state: 'available' | 'not_allowed' | 'not_offered';
  /** Where the answer came from: the provider's allow-list or supported list, or `pg_available_extensions` read on the database. */
  source: 'allow_list' | 'supported_list' | 'pg_available_extensions';
  version?: string | null;
  detail?: string;
}

/** Sprint 59 (B-10307): why a snapshot is taken (a final one must outlive the database; the others need not). */
export type SnapshotPurpose = 'final' | 'upgrade' | 'scheduled' | 'manual';

/**
 * Sprint 58 (B-10203): an EKS, AKS or DOKS control plane. `subnets` and `firewall` are graph keys (their provider ids
 * arrive in `parent.refs`); the API endpoint is public only to `apiCidrs` (default: anywhere, with private access
 * on), so the deploy worker can reach it; authentication is short-lived tokens only (EKS access entries, AKS-managed
 * Entra ID with local accounts off, DOKS credentials). AKS and DOKS need a node pool at create: `initialPool` is the
 * app node group, which its own `node_group` step then adopts.
 */
export interface KubernetesClusterProps {
  ha?: boolean;
  privateEndpoint?: boolean;
  /** The Kubernetes minor version (`1.31`); the provider's default when absent. Changing it replaces the cluster. */
  version?: string;
  subnets?: string[];
  firewall?: string;
  apiCidrs?: string[];
  initialPool?: { name: string; size: string; count: number; poolName?: string; subnet?: string };
  /** EKS: the cluster's IAM role (default `arn:aws:iam::<account>:role/exprsn-<account>-eks-cluster`). */
  clusterRoleArn?: string;
  /** The release the deploy worker installs into it (the chart and the values' origin), for the plan's view. */
  helm?: Record<string, unknown>;
}

/** Sprint 58 (B-10203, B-10401): a managed node group (EKS node group, AKS agent pool, DOKS node pool). */
export interface NodeGroupProps {
  role: 'app' | 'gpu' | string;
  size: string;
  count?: number;
  min?: number;
  max?: number;
  /** The cluster's provider name (`<deployment>-cluster`); its provider id arrives in `parent.refs.cluster`. */
  cluster?: string;
  /** AKS: the agent pool's own name (lower case letters and digits, at most 12). */
  poolName?: string;
  subnets?: string[];
  /** `key=value:Effect` (Kubernetes spelling). */
  taints?: string[];
  gpu?: string;
  gpus?: number;
  busyHours?: number;
  scaleToZero?: boolean;
  /** Sprint 60 (B-10403): spot capacity (EC2 Spot, Azure Spot; DigitalOcean is on-demand only). Unset: on demand. */
  purchase?: 'on_demand' | 'spot';
  /** Sprint 60 (B-10402): the gateway's autoscaler sets `count`, so AKS runs no cluster autoscaler of its own. */
  gatewayScaled?: boolean;
  /** EKS: the nodes' IAM role (default `arn:aws:iam::<account>:role/exprsn-<account>-eks-node`). */
  nodeRoleArn?: string;
}

/**
 * Sprint 58 (B-10203): a load balancer. `managedBy: 'cluster'` is the one in front of a Kubernetes release: the
 * cluster's own controller makes it from the release's ingress or Service (the AWS Load Balancer Controller's ALB, AKS
 * application routing's load balancer, DigitalOcean's cloud controller), so the adapter calls nothing for it and the
 * deploy worker records its address (`locator.address`) once the release is up. A standalone load balancer (VMs,
 * ECS) is another variant (B-10204, B-10205).
 */
export interface LoadBalancerProps {
  managedBy?: 'cluster';
  scheme?: 'internal' | 'internet-facing';
  listeners?: { port: number; protocol: string }[];
  subnets?: string[];
  firewall?: string;
  targets?: string[];
}

/**
 * Sprint 58 (B-10205): a container platform's app tier. ECS on Fargate (cluster, task definition, service and an
 * internal ALB that the service owns), Azure Container Apps (managed environment, app with revisions, the migration
 * job) or DigitalOcean App Platform (one app spec with a `PRE_DEPLOY` migration job). `env` holds settings only;
 * secrets are `secrets` bindings (references), delivered as files where the platform mounts them (Container Apps) or
 * through the platform's secret store with the key-encryption key in OpenBao (ECS, App Platform): never `DATA_KEY`.
 */
export interface ContainerServiceProps {
  platform: 'ecs-fargate' | 'container-apps' | 'app-platform' | 'cloudflare-containers';
  /** The image by digest (`registry/repo@sha256:<64 hex>`), or null when the spec pins none yet (the plan refuses). */
  image: string | null;
  replicas: number;
  vcpu: number;
  memoryGb: number;
  port: number;
  /** Plain settings (never a secret: `computeProblems` refuses one). */
  env: Record<string, string>;
  secrets: SecretBinding[];
  /** How secrets reach the app: `files` (mounted, `<NAME>_FILE`) or `platform` (the platform's secret store as variables, never DATA_KEY). */
  secretDelivery: 'files' | 'platform';
  /** The one-off migration before every rollout: the command, run as an ECS task, a Container Apps job or a `PRE_DEPLOY` job. */
  migrate: { command: string[] };
  /** Graph keys of the subnets and firewall (provider ids in `parent.refs`). */
  subnets: string[];
  firewall?: string;
  /** `internal` behind a tunnel, `internet-facing` for ACME or bring-your-own. */
  ingress: 'internal' | 'internet-facing';
  /** ECS: the graph keys of the edge subnets and firewall the service's own ALB lives in. */
  lbSubnets?: string[];
  lbFirewall?: string;
  /** ECS: the ALB's certificate for an internet-facing HTTPS listener (B-10206 imports it into ACM). */
  certificateArn?: string | null;
  /** ECS: the task execution role (pulls the image, reads the secrets); default `exprsn-<account>-ecs-execution`. */
  executionRoleArn?: string | null;
  /** The revision suffix (Container Apps) or deployment cause: the release version. */
  version?: string | null;
}

type PropsOf<T extends ResourceType> = T extends keyof PropsByType ? PropsByType[T] : Record<string, unknown>;

export interface ResourceSpec<T extends ResourceType = ResourceType> {
  type: T;
  /** The logical name: lower case, unique per account and type; the provider's name is derived from it. */
  name: string;
  /** Stable across retries of one journal step (B-10102); sent as a client token where the provider takes one. */
  idempotencyKey: string;
  /** The `exprsn:*` tags (`cloudTags` in `cloud/tags.ts`). */
  tags: Record<string, string>;
  region?: string;
  /** Provider ids of what this resource lives in: the network of a subnet or firewall. */
  parent?: {
    networkId?: string;
    /**
     * Sprint 58 (B-10204, B-10205): the provider ids of the resources this one depends on, by graph key (a VM's
     * subnet and firewall, a container service's subnets), so props can name other resources by key.
     */
    refs?: Record<string, string>;
  };
  props: PropsOf<T>;
}

/** Enough to find a resource again (kept in the resource graph). */
export interface ResourceRef {
  type: ResourceType;
  providerId: string;
  region?: string;
  /** Provider-specific locators (a DNS zone, a resource group, a parent network). */
  locator?: Record<string, string>;
}

export type ObservedState = 'creating' | 'ready' | 'updating' | 'deleting' | 'failed';

export interface ObservedResource extends ResourceRef {
  name: string;
  state: ObservedState;
  /** The `exprsn:*` tags as the provider reports them (decoded from descriptions or comments where that is where they live). */
  tags: Record<string, string>;
  /** Normalised fields the planner diffs (`cidr`, `ingress`, `values`...). */
  props: Record<string, unknown>;
}

/** A long-running operation, as JSON the journal keeps (B-10102), so any instance can resume polling it. */
export interface OperationHandle {
  provider: Provider;
  type: ResourceType;
  op: 'create' | 'update' | 'delete';
  /**
   * `aws-describe` (describe until the state settles), `aws-route53-change` (GetChange until INSYNC),
   * `azure-async` (`Azure-AsyncOperation`), `azure-location` (`Location`), `do-action` (`/v2/actions/<id>`),
   * `do-firewall` (the firewall's status); Sprint 58: `aws-ecs`, `azure-apps` and `do-app`, a container service's
   * phases (the one-off migration task or job, then the service or app until its deployment settles), the phase in
   * `token` as JSON.
   */
  kind: 'aws-describe' | 'aws-route53-change' | 'azure-async' | 'azure-location' | 'do-action' | 'do-firewall' | 'aws-ecs' | 'azure-apps' | 'do-app' | 'describe';
  ref: ResourceRef;
  /** The operation's URL (Azure) or id (Route 53 change, DigitalOcean action). */
  token: string;
  startedAt: number;
}

export type OperationResult =
  | { done: true; resource: ObservedResource | null; /** True when the create found what an earlier attempt made. */ adopted?: boolean; requestId?: string }
  | { done: false; operation: OperationHandle; resource?: ObservedResource; adopted?: boolean; requestId?: string };

export type PollResult =
  | { state: 'pending'; /** How long to wait before the next poll (the provider's Retry-After, or a default). */ waitMs: number; progress?: number }
  | { state: 'succeeded'; resource: ObservedResource | null }
  | { state: 'failed'; error: string; code?: string };

export interface ListFilter {
  /** Only what carries this account's `exprsn:managed` and `exprsn:account` tags (or its name prefix where there are no tags). */
  managedOnly?: boolean;
  /** The DNS zone of `dns_record`, the network of `subnet` and `firewall`. */
  zone?: string;
  networkId?: string;
}

export interface CloudProvider {
  readonly kind: Provider;
  readonly capabilities: CapabilityTable;
  supports(type: ResourceType, op?: ResourceOperation): Support;
  /** STS GetCallerIdentity, the ARM subscription, DigitalOcean `/v2/account`, Cloudflare `/user/tokens/verify`. */
  identity(cred: AdapterCredential, account: CloudAccount): Promise<IdentityResult>;
  /** IAM SimulatePrincipalPolicy, ARM permissions, DigitalOcean scope probes, Cloudflare token policies: what is missing per feature. */
  checkPermissions(cred: AdapterCredential, account: CloudAccount, features: CloudFeature[]): Promise<PermissionCheck[]>;
  /** The idempotency hook: what an earlier attempt of this spec already made, or null. */
  find(ctx: CallContext, spec: ResourceSpec): Promise<ObservedResource | null>;
  describe(ctx: CallContext, ref: ResourceRef): Promise<ObservedResource | null>;
  list(ctx: CallContext, type: ResourceType, filter?: ListFilter): Promise<ObservedResource[]>;
  /** Creates, or adopts what `find` returns (never a second copy). */
  create(ctx: CallContext, spec: ResourceSpec): Promise<OperationResult>;
  update(ctx: CallContext, ref: ResourceRef, spec: ResourceSpec): Promise<OperationResult>;
  /** Deleting something already gone is done, not an error. */
  delete(ctx: CallContext, ref: ResourceRef): Promise<OperationResult>;
  poll(ctx: CallContext, handle: OperationHandle): Promise<PollResult>;
  /**
   * B-10107 (Sprint 57): a final snapshot before a protected resource is deleted. `snapshotSupport` answers without
   * calling anything: null when the adapter takes one for the type, else why not; `snapshot` starts one and
   * `snapshotStatus` follows it. An adapter without them takes none, and destroy refuses with the reason.
   */
  snapshotSupport?(type: ResourceType): string | null;
  /**
   * Sprint 59 (B-10307): `o.purpose` says what the snapshot is for; a `final` one (the default) outlives the resource
   * (an RDS manual snapshot, an Azure or DigitalOcean retained copy, since their backups go with the server).
   */
  snapshot?(ctx: CallContext, ref: ResourceRef, name: string, o?: { purpose?: SnapshotPurpose }): Promise<SnapshotResult>;
  snapshotStatus?(ctx: CallContext, ref: ResourceRef, pending: SnapshotResult): Promise<SnapshotResult>;
  /** Sprint 59 (B-10307): a database's snapshots and backups, as the provider lists them (copies and final snapshots too). */
  listSnapshots?(ctx: CallContext, ref: ResourceRef): Promise<DatabaseSnapshot[]>;
  /** Sprint 59 (B-10307): deletes a snapshot Exprsn-AI took (scheduled snapshots past their retention); never a final one. */
  deleteSnapshot?(ctx: CallContext, ref: ResourceRef, snapshotId: string): Promise<void>;
  /** Sprint 59 (B-10301): the extensions' state on a PostgreSQL database (the provider's allow-list and supported list). */
  databaseExtensions?(ctx: CallContext, ref: ResourceRef, wanted: string[]): Promise<ExtensionStatus[]>;
  /**
   * B-10204 (Sprint 58): what the bare-metal installer reported on a VM's console (EC2 `GetConsoleOutput`, Azure boot
   * diagnostics). An adapter without a console read leaves it out, and the readiness check says so.
   */
  vmInstallStatus?(ctx: CallContext, ref: ResourceRef): Promise<InstallStatus>;
  /**
   * B-10203 (Sprint 58): short-lived access to a Kubernetes cluster's API for the deploy worker (an EKS token from a
   * presigned STS `GetCallerIdentity`, an AKS Entra token, the DOKS credentials endpoint). Never stored.
   */
  kubeAccess?(ctx: CallContext, ref: ResourceRef, o?: { seconds?: number }): Promise<ClusterAccess>;
  /**
   * B-10207 (Sprint 58): restores a snapshot `snapshot` took (a database's, before an upgrade) onto the resource. Run
   * only after a second cloud admin approved it; an adapter without it cannot restore, and the restore says so.
   * Sprint 59 (B-10307): a managed database is restored to a new instance (`o.name`, default `<name>-restored-<time>`),
   * never over the one it came from; `restoredId` names the new instance once it exists.
   */
  restoreSnapshot?(ctx: CallContext, ref: ResourceRef, snapshotId: string, o?: { name?: string; tags?: Record<string, string> }): Promise<SnapshotResult>;
  /**
   * B-10305 (Sprint 59): where a cache answers and the provider's key or password for it (Azure `listKeys`, the
   * password DigitalOcean generates; null for ElastiCache, whose AUTH token Exprsn-AI chose and keeps in the vault).
   * Only `cloud/caches.ts` calls it, to write `REDIS_URL` into the vault; never stored elsewhere.
   */
  cacheAccess?(ctx: CallContext, ref: ResourceRef): Promise<CacheAccess>;
  /** B-10302 (Sprint 59): a managed database's CA certificate (PEM) where the provider hands one out per cluster (DigitalOcean `/v2/databases/<id>/ca`). */
  databaseCa?(ctx: CallContext, ref: ResourceRef): Promise<string>;
  /**
   * B-10703 (Sprint 62): the provider's own record of who changed a resource in a window (CloudTrail `LookupEvents`,
   * the Azure Activity Log, Cloudflare's audit logs), writes only, newest first. Read only for resources with open drift
   * findings (`cloud/change-trail.ts`); an adapter without it (DigitalOcean) keeps no trail this build reads.
   */
  changeEvents?(ctx: CallContext, q: ChangeTrailQuery): Promise<ChangeEvent[]>;
}

/** B-10703: what `changeEvents` is asked: one resource, a bounded window (ms since the epoch). */
export interface ChangeTrailQuery {
  type: ResourceType;
  providerId: string;
  region?: string;
  locator?: Record<string, string> | null;
  /** Other ids the provider may name the resource by (a Cloudflare record set's record ids). */
  ids?: string[];
  /** A DNS name the resource answers for (Cloudflare audit entries name records by it). */
  name?: string;
  from: number;
  to: number;
  /** At most this many events (default 20). */
  limit?: number;
}

/** B-10703: one write to a resource, as the provider's trail records it. */
export interface ChangeEvent {
  /** When the change was made (ms since the epoch). */
  at: number;
  /** Who made it: an IAM ARN or user name, an Entra caller (UPN or object id), a Cloudflare user's e-mail or token. */
  principal: string;
  principalType: string | null;
  /** The provider's action (`AuthorizeSecurityGroupIngress`, `Microsoft.Network/networkSecurityGroups/write`, `rec_set`). */
  action: string;
  /** The service that recorded it (`ec2.amazonaws.com`, `Microsoft.Network`, `cloudflare`). */
  source: string;
  eventId: string | null;
  sourceIp: string | null;
}

/** B-10203: what a kubeconfig is built from; the token is short-lived and is never written anywhere but a private temporary kubeconfig. */
export interface ClusterAccess {
  /** The API server's URL. */
  server: string;
  /** The cluster CA (base64 PEM, as kubeconfig's `certificate-authority-data`), or null for a publicly trusted one. */
  caData: string | null;
  token: string;
  expiresAt: number;
  /** The cluster's name at the provider (the kubeconfig's context). */
  clusterName: string;
}

/** A snapshot in progress or taken (plain JSON: the destroy keeps it and any instance follows it). */
export interface SnapshotResult {
  state: 'pending' | 'done' | 'failed';
  /** The snapshot's name (`exprsn-<deployment>-<key>-final-<time>`). */
  name: string;
  /** The provider's id of the snapshot once it exists. */
  snapshotId: string | null;
  /** The provider's operation to follow while pending. */
  operation?: OperationHandle;
  waitMs?: number;
  error?: string;
  requestId?: string | null;
  /** Sprint 59 (B-10307): a restore's new instance (its provider id), once it exists. */
  restoredId?: string | null;
}

/** Thrown for a type or operation an adapter does not drive; the planner shows it as unavailable. */
export class CloudUnsupported extends Error {
  readonly code = 'unsupported';
  constructor(
    readonly provider: Provider,
    readonly type: ResourceType,
    readonly support: Exclude<Support, 'built'>,
    readonly operation?: ResourceOperation,
    reason?: string
  ) {
    super(`${provider} ${type}${operation ? ` ${operation}` : ''} is ${support === 'not_yet' ? 'not built yet' : 'not offered by the provider'}${reason ? `: ${reason}` : '.'}`);
  }
}

/** A provider's refusal or failure, with what the journal and the problem details need. Never carries a secret. */
export class CloudProviderError extends Error {
  constructor(
    message: string,
    readonly provider: Provider,
    readonly status: number,
    readonly code: string | null = null,
    readonly requestId: string | null = null,
    /** Set when the provider throttled the call and the retries ran out. */
    readonly retryAfterSeconds: number | null = null
  ) {
    super(message);
  }
  get throttled(): boolean {
    return this.status === 429 || this.retryAfterSeconds != null;
  }
}

/** Adapters run only for an account (never against a provider's default endpoints for nobody). */
export function assertAccount(provider: Provider, account: CloudAccount | null | undefined): asserts account is CloudAccount {
  if (!account || !account.id) throw new CloudProviderError('A cloud call needs an account; none was given.', provider, 400, 'no_account');
  if (account.provider !== provider) throw new CloudProviderError(`The account ${account.name} is a ${account.provider} account, not ${provider}.`, provider, 400, 'wrong_provider');
}

/** Builds a capability table: every type `unsupported` unless named. */
export function capabilityTable(entries: Partial<CapabilityTable>, fallback: (t: ResourceType) => Capability = () => ({ support: 'unsupported', native: '-', operations: [] })): CapabilityTable {
  return Object.fromEntries(RESOURCE_TYPES.map((t) => [t, entries[t] ?? fallback(t)])) as CapabilityTable;
}

export const ALL_OPS: readonly ResourceOperation[] = RESOURCE_OPERATIONS;
