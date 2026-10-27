import { z } from 'zod';
import { labelRank, LABELS, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { isPrivateCidr, overlaps, parseCidr, ZONE_ID } from '../zones/spec.js';
import { isSecretRef } from '../vault/policy.js';
import type { Services } from '../services.js';
import { FEATURE_NAMES, type CloudAccount, type CloudFeature, type Provider, type Region } from './types.js';
import { appTierSpecProblems } from './cloudflare-app.js';

/*
 * 1.9.99-final, Sprint 57 (B-10201): the deployment spec the wizard writes, its size presets, and its validation.
 *
 * A spec names where Exprsn-AI is deployed (a platform account of AWS, Azure or DigitalOcean and one of its regions),
 * the highest label the deployment holds, the compute shape and size, the data tier, the front door, optional GPU
 * pools, the zones each tier runs in and the network's address range. `validateSpec` checks it against the account
 * before any provider call: the account's state, scope and region allow-list, the label ceilings and residency
 * (`assertRegionAllows`'s decision), the zones' ceilings, the last validation's permission report, what the provider
 * offers per preset (GPU kinds), and the spec's own limits. Nothing here calls a provider.
 *
 * Rendering the spec into resources is `cloud/render.ts` (with the network from `cloud/network.ts`); pricing it is
 * `cloud/prices.ts`.
 */

export const DEPLOY_PROVIDERS = ['aws', 'azure', 'digitalocean'] as const;
export type DeployProvider = (typeof DEPLOY_PROVIDERS)[number];
/** Sprint 61 (B-10905): `cloudflare`, the hybrid app tier on Cloudflare (Workers, Containers, Hyperdrive, R2; `cloud/cloudflare-app.ts`). */
export const SHAPES = ['kubernetes', 'vm', 'container', 'cloudflare'] as const;
export type Shape = (typeof SHAPES)[number];
export const SIZES = ['small', 'medium', 'large'] as const;
export type Size = (typeof SIZES)[number];
export const DATA_MODES = ['provision', 'existing', 'onprem'] as const;
export const FRONT_DOORS = ['cloudflare', 'acme', 'byo'] as const;
export const GPU_KINDS = ['l4', 'a10', 'h100'] as const;
export type GpuKind = (typeof GPU_KINDS)[number];

/** Spec limits (the "quotas" a spec is checked against before any provider call). */
export const SPEC_LIMITS = { gpuPools: 4, gpuNodesPerPool: 16, gpuNodesTotal: 32, onpremCidrs: 8 } as const;

/** Cloudflare's edge sees decrypted traffic: a deployment behind its front door holds at most `confidential` (open decision 5). */
export const CLOUDFLARE_FRONT_DOOR_CAP: Label = 'confidential';

// ---------- presets ----------

export interface SizePreset {
  /** App replicas (pods, VMs or container instances), each with these vCPUs and GiB. */
  app: { replicas: number; vcpu: number; memoryGb: number };
  /** The provisioned database: one primary, plus a standby when `ha`. */
  database: { vcpu: number; memoryGb: number; storageGb: number; ha: boolean };
  cache: { memoryGb: number; ha: boolean };
  /** Availability zones the private subnets are spread over. */
  azs: 1 | 2 | 3;
  /** High availability throughout: a standby database, a replicated cache, an HA control plane, three AZs. */
  ha: boolean;
  /** The estimate's default egress per month, GB. */
  egressGb: number;
  /** Object storage per month, GB (the estimate's default). */
  bucketGb: number;
}

export const SIZE_PRESETS: Record<Size, SizePreset> = {
  small: { app: { replicas: 1, vcpu: 2, memoryGb: 4 }, database: { vcpu: 2, memoryGb: 4, storageGb: 50, ha: false }, cache: { memoryGb: 1, ha: false }, azs: 1, ha: false, egressGb: 100, bucketGb: 50 },
  medium: { app: { replicas: 2, vcpu: 4, memoryGb: 8 }, database: { vcpu: 2, memoryGb: 8, storageGb: 100, ha: false }, cache: { memoryGb: 2, ha: false }, azs: 2, ha: false, egressGb: 500, bucketGb: 200 },
  large: { app: { replicas: 3, vcpu: 8, memoryGb: 16 }, database: { vcpu: 4, memoryGb: 16, storageGb: 250, ha: true }, cache: { memoryGb: 4, ha: true }, azs: 3, ha: true, egressGb: 2000, bucketGb: 1000 }
};

/** The provider's own sizes for each preset (the SKUs the estimate prices and the adapters will build). */
export interface ProviderSkus {
  app: Record<Size, string>;
  database: Record<Size, string>;
  cache: Record<Size, string>;
  /** GPU node sizes; null where the provider offers no such GPU. */
  gpu: Record<GpuKind, { sku: string; gpus: number } | null>;
}

export const PROVIDER_SKUS: Record<DeployProvider, ProviderSkus> = {
  aws: {
    app: { small: 't3.medium', medium: 'm6i.xlarge', large: 'm6i.2xlarge' },
    database: { small: 'db.t4g.medium', medium: 'db.m6g.large', large: 'db.m6g.xlarge' },
    cache: { small: 'cache.t4g.small', medium: 'cache.m6g.large', large: 'cache.m6g.xlarge' },
    gpu: { l4: { sku: 'g6.xlarge', gpus: 1 }, a10: { sku: 'g5.xlarge', gpus: 1 }, h100: { sku: 'p5.48xlarge', gpus: 8 } }
  },
  azure: {
    app: { small: 'Standard_D2s_v5', medium: 'Standard_D4s_v5', large: 'Standard_D8s_v5' },
    database: { small: 'Standard_B2s', medium: 'Standard_D2ds_v5', large: 'Standard_D4ds_v5' },
    cache: { small: 'C1', medium: 'C2', large: 'P1' },
    gpu: { l4: null, a10: { sku: 'Standard_NV36ads_A10_v5', gpus: 1 }, h100: { sku: 'Standard_NC40ads_H100_v5', gpus: 1 } }
  },
  digitalocean: {
    app: { small: 's-2vcpu-4gb', medium: 's-4vcpu-8gb', large: 's-8vcpu-16gb' },
    database: { small: 'db-s-2vcpu-4gb', medium: 'db-s-4vcpu-8gb', large: 'db-s-6vcpu-16gb' },
    cache: { small: 'db-s-1vcpu-2gb', medium: 'db-s-2vcpu-4gb', large: 'db-s-4vcpu-8gb' },
    gpu: { l4: null, a10: null, h100: { sku: 'gpu-h100x1-80gb', gpus: 1 } }
  }
};

// ---------- the schema ----------

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'a DNS name such as ai.example.com');
const cidr = z
  .string()
  .trim()
  .max(50)
  .refine((v) => parseCidr(v)?.family === 4, 'An IPv4 CIDR such as 10.64.0.0/16');
const vaultRef = z.string().trim().max(300).refine(isSecretRef, 'a vault:<path>#<key> reference');
const zoneId = z.string().regex(ZONE_ID, 'a zone id');
const port = z.number().int().min(1).max(65535);
const httpsUrl = z.url().max(2000).refine((u) => u.startsWith('https://'), 'an https:// URL');

/** An OCI image pinned by digest (`registry/repository@sha256:<64 hex>`): a tag alone can move under a deployment. */
export const IMAGE_BY_DIGEST = /^[a-z0-9][a-z0-9.-]*(?::\d+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/;

export const gpuPoolSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/, 'lower case letters, digits and dashes'),
    gpu: z.enum(GPU_KINDS),
    /** Nodes always running (0: scale to zero). */
    min: z.number().int().min(0).max(SPEC_LIMITS.gpuNodesPerPool).default(0),
    max: z.number().int().min(1).max(SPEC_LIMITS.gpuNodesPerPool).default(1),
    /** For the estimate: hours a month one node above `min` is expected to run (scale-to-zero pools). */
    busyHours: z.number().int().min(0).max(744).default(160),
    /** Sprint 60 (B-10403): spot nodes (EC2 Spot, Azure Spot) with an on-demand sibling node group to fall back to; DigitalOcean offers on-demand only. */
    purchase: z.enum(['on_demand', 'spot']).default('on_demand'),
    /**
     * Sprint 60 (B-10405): instance types to fall back to, in order, when the preset's type has no capacity
     * (InsufficientInstanceCapacity, SkuNotAvailable, a DigitalOcean region out of GPUs); and the zones to try, in order.
     */
    fallbackTypes: z.array(z.string().trim().regex(/^[A-Za-z0-9._-]{2,64}$/, 'an instance type')).max(4).default([]),
    zones: z.array(z.string().trim().regex(/^[a-z0-9-]{1,40}$/, 'a zone name')).max(4).default([]),
    /** Sprint 60 (B-10404): where a new node's models come from: the model mirror (default) or a pre-seeded volume snapshot. */
    warmup: z
      .discriminatedUnion('source', [z.object({ source: z.literal('mirror') }).strict(), z.object({ source: z.literal('snapshot'), snapshotId: z.string().trim().regex(/^[A-Za-z0-9/._:-]{3,300}$/, 'a snapshot id') }).strict()])
      .default({ source: 'mirror' }),
    /** Sprint 60 (B-10401): the node group DaemonSet's images, pinned by digest (from the image mirror). */
    images: z.object({ ollama: z.string().max(400).regex(IMAGE_BY_DIGEST, 'an image pinned by digest'), proxy: z.string().max(400).regex(IMAGE_BY_DIGEST, 'an image pinned by digest') }).strict().optional()
  })
  .strict();

export const deploymentSpecSchema = z
  .object({
    /** The deployment's name: lower case, unique per account; the `exprsn:deployment` tag. */
    name: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/, 'lower case letters, digits and dashes, starting with a letter'),
    description: z.string().trim().max(500).optional(),
    target: z.object({ provider: z.enum(DEPLOY_PROVIDERS), accountId: id26, region: z.string().trim().min(1).max(40) }).strict(),
    /** The highest label of the data this deployment holds; checked against the region's and the zones' ceilings. */
    label: z.enum(LABELS).default('internal'),
    compute: z
      .object({
        shape: z.enum(SHAPES),
        size: z.enum(SIZES),
        /**
         * Sprint 61 (B-10905): the Cloudflare app tier's own settings (shape `cloudflare`): Redis on another provider
         * (required unless `data.redisUrlRef` names one), the R2 bucket's jurisdiction (`auto`: EU when the data region
         * is in the EU), and how Hyperdrive reaches the database (default: the tunnel, directly for an existing one).
         */
        cloudflare: z
          .object({
            redisUrlRef: vaultRef.optional(),
            r2Jurisdiction: z.enum(['auto', 'default', 'eu', 'fedramp']).default('auto'),
            databaseVia: z.enum(['tunnel', 'direct']).optional()
          })
          .strict()
          .optional()
      })
      .strict(),
    data: z
      .discriminatedUnion('mode', [
        z.object({ mode: z.literal('provision'), engine: z.literal('postgres').default('postgres'), cache: z.boolean().default(true) }).strict(),
        z.object({ mode: z.literal('existing'), databaseUrlRef: vaultRef, redisUrlRef: vaultRef.optional() }).strict(),
        z.object({ mode: z.literal('onprem'), cidrs: z.array(cidr).min(1).max(SPEC_LIMITS.onpremCidrs), ports: z.array(port).min(1).max(8).default([5432, 6379]) }).strict()
      ])
      .default({ mode: 'provision', engine: 'postgres', cache: true }),
    frontDoor: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('cloudflare'), accountId: id26, hostname, zone: hostname, plan: z.enum(['free', 'pro', 'business']).default('free') }).strict(),
      z.object({ kind: z.literal('acme'), hostname, zone: hostname }).strict(),
      z.object({ kind: z.literal('byo'), hostname }).strict()
    ]),
    gpuPools: z.array(gpuPoolSchema).max(SPEC_LIMITS.gpuPools).default([]),
    /**
     * Sprint 58 (B-10204, B-10205): the release the app tier runs. VMs install the signed release tarball (the
     * bare-metal installer verifies its sha256, and its cosign bundle when given, before running anything from it);
     * container platforms run the image by digest.
     */
    release: z
      .object({
        version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'a release version such as 1.0.0').optional(),
        tarball: z.object({ url: httpsUrl, sha256: z.string().regex(/^[a-f0-9]{64}$/, '64 lower-case hex digits'), bundleUrl: httpsUrl.optional(), identity: z.string().min(1).max(300).optional() }).strict().optional(),
        image: z.string().max(400).regex(IMAGE_BY_DIGEST, 'an image pinned by digest (registry/repository@sha256:...)').optional()
      })
      .strict()
      .optional(),
    /**
     * Sprint 58 (open decision 8): where a deployed VM or container app keeps its key-encryption key: OpenBao transit,
     * so no `DATA_KEY` ever reaches a cloud machine or a container's environment.
     */
    keys: z
      .discriminatedUnion('provider', [
        z.object({ provider: z.literal('openbao'), addr: httpsUrl, transitMount: z.string().regex(/^[a-z0-9_-]+$/).default('transit') }).strict(),
        // B-10208: the account's KMS with a vaulted key pair, the secret delivered as a file (KMS_AWS_SECRET_ACCESS_KEY_FILE).
        z.object({ provider: z.literal('aws-kms'), region: z.string().trim().min(1).max(40), accessKeyId: z.string().regex(/^[A-Z0-9]{16,128}$/), secretRef: vaultRef }).strict(),
        // B-10208: Key Vault with the install's app registration, its client secret delivered as a file (AZURE_IDENTITY_CLIENT_SECRET_FILE).
        z.object({ provider: z.literal('azure-keyvault'), vaultUrl: httpsUrl, tenantId: z.string().uuid(), clientId: z.string().uuid(), secretRef: vaultRef }).strict()
      ])
      .optional(),
    /**
     * Sprint 58 (B-10203, B-10208, open decision 8): on Kubernetes, the cloud KMS through the pods' workload identity
     * (EKS: a role assumed with the projected service-account token; AKS: an Entra workload identity), so neither
     * DATA_KEY nor a cloud secret is in the cluster at all. Without it (or `keys`) the release's Secret holds DATA_KEY
     * as a file.
     */
    clusterKeys: z
      .discriminatedUnion('provider', [
        z.object({ provider: z.literal('aws-kms'), region: z.string().trim().min(1).max(40), roleArn: z.string().regex(/^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/, 'an IAM role ARN') }).strict(),
        z.object({ provider: z.literal('azure-keyvault'), vaultUrl: httpsUrl, tenantId: z.string().uuid(), clientId: z.string().uuid() }).strict()
      ])
      .optional(),
    /** The tiers' zones (`zones/`): their rules become the firewalls (B-10202). */
    zones: z
      .object({ edge: zoneId.default('edge'), app: zoneId.default('app'), data: zoneId.default('data'), inference: zoneId.default('inference') })
      .strict()
      .default({ edge: 'edge', app: 'app', data: 'data', inference: 'inference' }),
    /** The private address range the deployment's subnets are carved from (IPv4, /16 to /22). */
    network: z.object({ cidr: cidr.default('10.64.0.0/16') }).strict().default({ cidr: '10.64.0.0/16' }),
    /** Estimate assumptions (B-10601); the preset's when not given. */
    estimate: z
      .object({ hours: z.number().int().min(1).max(744).optional(), storageGb: z.number().int().min(1).max(65_536).optional(), egressGb: z.number().int().min(0).max(1_000_000).optional() })
      .strict()
      .default({})
  })
  .strict();

export type DeploymentSpec = z.infer<typeof deploymentSpecSchema>;
export type DeploymentSpecInput = z.input<typeof deploymentSpecSchema>;
export type GpuPool = z.infer<typeof gpuPoolSchema>;

/** The month the estimate assumes when the spec does not say (730 h = 8760 / 12). */
export const HOURS_PER_MONTH = 730;

/** The estimate's assumptions for a spec: hours a month, the database's storage, egress per month. */
export function specAssumptions(spec: DeploymentSpec): { hours: number; storageGb: number; egressGb: number } {
  const p = SIZE_PRESETS[spec.compute.size];
  return { hours: spec.estimate.hours ?? HOURS_PER_MONTH, storageGb: spec.estimate.storageGb ?? p.database.storageGb, egressGb: spec.estimate.egressGb ?? p.egressGb };
}

// ---------- validation ----------

/** `region`, `ceiling`, `residency`, `state` and `use` come from `checkRegion` (B-10008); the rest are the spec's own. */
export type ProblemCheck = 'state' | 'use' | 'region' | 'ceiling' | 'residency' | 'provider' | 'scope' | 'zone' | 'permission' | 'offer' | 'limit' | 'front_door' | 'network' | 'name' | 'release' | 'app_tier';

export interface SpecProblem {
  /** The spec field the problem is about (`target.region`, `gpuPools.0.gpu`...). */
  path: string;
  check: ProblemCheck;
  message: string;
}

/** What validation resolved (for rendering and the plan): the target account and region, the front door's account. */
export interface ResolvedSpec {
  spec: DeploymentSpec;
  account: CloudAccount;
  region: Region;
  frontDoorAccount: CloudAccount | null;
  preset: SizePreset;
  skus: ProviderSkus;
}

export interface SpecValidation {
  valid: boolean;
  problems: SpecProblem[];
  /** Resource types the provider does not build yet (or at all): the plan shows them as unavailable, apply refuses them. */
  unavailable: { type: string; support: string; reason: string }[];
  resolved: ResolvedSpec | null;
}

/** The features a spec needs from the account's last validation (B-10007). */
export function featuresFor(spec: DeploymentSpec): CloudFeature[] {
  const out: CloudFeature[] = ['deploy'];
  if (spec.data.mode === 'provision') out.push('data');
  if (spec.gpuPools.length) out.push('compute');
  return out;
}

/** Steps whose refusal is a placement denial (403, step `zone`), as `assertRegionAllows` answers. */
export const PLACEMENT_CHECKS: readonly ProblemCheck[] = ['state', 'use', 'region', 'ceiling', 'residency'];

/**
 * Validates a parsed spec against its accounts, regions, ceilings, zones and limits, without calling a provider. Every
 * problem is listed (the wizard shows them all); `resolved` is set only when the account and region resolved.
 */
export async function validateSpec(s: Services, p: Principal, spec: DeploymentSpec): Promise<SpecValidation> {
  const problems: SpecProblem[] = [];
  const add = (path: string, check: ProblemCheck, message: string) => problems.push({ path, check, message });
  const acc = s.cloud.accounts;
  await acc.need();

  // The target account: visible, the named provider, platform-scoped (deploying Exprsn-AI is platform-only, open decision 6).
  const account = await acc.get(spec.target.accountId);
  if (!account || !acc.canSee(p, account)) {
    add('target.accountId', 'state', 'The cloud account does not exist.');
    return { valid: false, problems, unavailable: [], resolved: null };
  }
  if (account.provider !== spec.target.provider) add('target.provider', 'provider', `${account.name} is a ${account.provider} account, not ${spec.target.provider}.`);
  if (account.scope !== 'platform') add('target.accountId', 'scope', `${account.name} is a tenant account; deploying Exprsn-AI needs a platform account.`);

  // Region, ceiling and residency: the same decision `assertRegionAllows` makes (B-10008).
  const d = await acc.checkRegion(account, spec.target.region, spec.label, { use: 'deploy' });
  if (!d.allow) add(d.step === 'region' ? 'target.region' : d.step === 'ceiling' || d.step === 'residency' ? 'label' : 'target.accountId', (d.step ?? 'region') as ProblemCheck, d.reason);
  if (spec.gpuPools.length && d.allow) {
    const g = await acc.checkRegion(account, spec.target.region, spec.label, { use: 'pools' });
    if (!g.allow) add('gpuPools', (g.step ?? 'region') as ProblemCheck, g.reason);
  }

  // The last validation's permission report (B-10007): no provider call, only what was recorded.
  for (const f of featuresFor(spec)) {
    const v = account.validation?.features.find((x) => x.feature === f);
    if (!account.validation) {
      add('target.accountId', 'permission', `${account.name} has not been validated yet; validate it before deploying.`);
      break;
    }
    if (!v || v.status === 'unsupported') add('target.accountId', 'permission', `${account.provider} offers no ${FEATURE_NAMES[f]}.`);
    else if (v.status === 'missing') add('target.accountId', 'permission', `${account.name}'s credential lacks ${v.missing.join(', ')}, which ${FEATURE_NAMES[f]} needs.`);
    else if (v.status === 'error') add('target.accountId', 'permission', `The last permission check for ${FEATURE_NAMES[f]} failed; validate ${account.name} again.`);
  }

  // Zones: the tiers' zones must be defined, and hold the label (their ceilings cap the deployment's).
  const zones = await s.zones.current().catch(() => new Map());
  if (!zones.size) add('zones', 'zone', 'No zones are defined. Seed the default zones (Zones screen) before deploying: the firewalls are rendered from them.');
  else {
    const tiers: [keyof DeploymentSpec['zones'], boolean][] = [
      ['edge', true],
      ['app', true],
      ['data', spec.data.mode === 'provision'],
      ['inference', spec.gpuPools.length > 0]
    ];
    for (const [tier, used] of tiers) {
      if (!used) continue;
      const id = spec.zones[tier];
      const z = zones.get(id) as { spec: { maxLabel: Label; trust: string } } | undefined;
      if (!z) add(`zones.${tier}`, 'zone', `${id} is not a defined zone.`);
      else if (z.spec.trust === 'external') add(`zones.${tier}`, 'zone', `${id} is the external zone; nothing of a deployment runs in it.`);
      else if (tier !== 'edge' && labelRank(spec.label) > labelRank(z.spec.maxLabel)) add(`zones.${tier}`, 'ceiling', `${id} holds at most ${z.spec.maxLabel}; this deployment holds ${spec.label}.`);
    }
  }

  // On-prem data is reached as the app zone's egress allows: the zone spec decides, the deployment adds no rule.
  // (A Cloudflare app tier reaches on-prem data through the tunnel, not the app zone's egress: Sprint 61, B-10905.)
  if (spec.data.mode === 'onprem' && zones.size && spec.compute.shape !== 'cloudflare') {
    const app = zones.get(spec.zones.app) as { spec: { egress: { mode: string; allow: { kind: string; cidr?: string; zone?: string; ports: number[] }[] } } } | undefined;
    spec.data.cidrs.forEach((c, i) => {
      const ok = app?.spec.egress.mode === 'allow-list' && app.spec.egress.allow.some((t) => (t.kind === 'cidr' && t.cidr && within(c, t.cidr)) || (t.kind === 'zone' && t.zone && ((zones.get(t.zone) as { spec: { cidrs: string[] } } | undefined)?.spec.cidrs ?? []).some((zc) => within(c, zc))));
      if (!ok) add(`data.cidrs.${i}`, 'zone', `The ${spec.zones.app} zone's egress does not reach ${c}. Allow it in the zone spec (or a zone with that range) first: the firewalls follow the zones.`);
    });
  }

  // What the provider offers per preset.
  const provider = spec.target.provider;
  const skus = PROVIDER_SKUS[provider];
  let nodes = 0;
  spec.gpuPools.forEach((g, i) => {
    if (!skus.gpu[g.gpu]) add(`gpuPools.${i}.gpu`, 'offer', `${provider} offers no ${g.gpu.toUpperCase()} nodes in this build's presets.`);
    if (g.purchase === 'spot' && provider === 'digitalocean') add(`gpuPools.${i}.purchase`, 'offer', 'DigitalOcean offers on-demand GPU nodes only; spot is not available there.');
    if (g.min > g.max) add(`gpuPools.${i}.min`, 'limit', `The minimum (${g.min}) is above the maximum (${g.max}).`);
    nodes += g.max;
  });
  if (nodes > SPEC_LIMITS.gpuNodesTotal) add('gpuPools', 'limit', `At most ${SPEC_LIMITS.gpuNodesTotal} GPU nodes per deployment; the pools allow ${nodes}.`);
  if (new Set(spec.gpuPools.map((g) => g.name)).size !== spec.gpuPools.length) add('gpuPools', 'name', 'GPU pool names must be unique.');
  if (spec.gpuPools.length && spec.compute.shape === 'container') add('gpuPools', 'offer', 'GPU pools need the Kubernetes or VM shape; container platforms run the app tier only.');
  // Sprint 61 (B-10905): the Cloudflare app tier: Redis on another provider, the front door, the image, OpenBao keys.
  for (const p of appTierSpecProblems(spec)) add(p.path, 'app_tier', p.message);
  if (spec.compute.cloudflare && spec.compute.shape !== 'cloudflare') add('compute.cloudflare', 'app_tier', 'compute.cloudflare is for the cloudflare shape.');

  // Sprint 58 (B-10204, B-10205): what a VM or container app tier runs, and where its key-encryption key lives.
  if (spec.compute.shape === 'vm' && !spec.release?.tarball) add('release.tarball', 'release', 'A VM deployment installs a signed release tarball: give its https URL and sha256.');
  if (spec.compute.shape === 'container' && !spec.release?.image) add('release.image', 'release', 'A container deployment runs an image pinned by digest (registry/repository@sha256:...).');
  // (The cloudflare shape's image is asked for by appTierSpecProblems.)
  if (spec.compute.shape !== 'kubernetes' && !spec.keys) add('keys', 'release', 'VM and container deployments keep the key-encryption key in OpenBao transit or the cloud KMS (DATA_KEY never leaves this install): give keys.');
  if (spec.keys && spec.keys.provider !== 'openbao') {
    const want = spec.keys.provider === 'aws-kms' ? 'aws' : 'azure';
    if (provider !== want) add('keys.provider', 'release', `${spec.keys.provider} keys go with an ${want === 'aws' ? 'AWS' : 'Azure'} deployment.`);
    // ECS and App Platform hand secrets over as variables, and production takes cloud credentials only as files.
    if (spec.compute.shape === 'container' && provider === 'aws') add('keys.provider', 'release', 'ECS gives secrets to the task as variables, and production takes KMS_AWS_SECRET_ACCESS_KEY only as a file: use OpenBao for the ECS target.');
  }
  // Sprint 58 (B-10203): a Kubernetes deployment's keys: the cloud KMS by workload identity (clusterKeys) or by a vaulted secret (keys).
  if (spec.clusterKeys) {
    if (spec.compute.shape !== 'kubernetes') add('clusterKeys', 'release', 'clusterKeys (workload identity) is for Kubernetes deployments; VMs and container platforms take keys.');
    const want = spec.clusterKeys.provider === 'aws-kms' ? 'aws' : 'azure';
    if (provider !== want) add('clusterKeys.provider', 'release', `${spec.clusterKeys.provider} goes with an ${want === 'aws' ? 'AWS' : 'Azure'} deployment.`);
    if (spec.keys) add('clusterKeys', 'release', 'Give keys or clusterKeys, not both.');
  }
  if (spec.compute.shape === 'kubernetes' && spec.keys?.provider === 'openbao') add('keys.provider', 'release', 'A Kubernetes deployment uses the cloud KMS (clusterKeys or keys) or the key in its Secret; OpenBao transit for the chart needs a token this build does not hand out yet.');
  if (spec.release?.tarball?.bundleUrl && !spec.release.tarball.identity) add('release.tarball.identity', 'release', 'A cosign bundle needs the signer identity it must come from (a certificate identity regular expression).');

  // The network: private, within the provider's limits, clear of the on-prem data network.
  const net = parseCidr(spec.network.cidr)!;
  if (!isPrivateCidr(spec.network.cidr)) add('network.cidr', 'network', `${spec.network.cidr} is not a private address range.`);
  if (net.prefix < 16 || net.prefix > 22) add('network.cidr', 'network', 'The network takes a /16 to /22 range (AWS VPCs and DigitalOcean VPCs are at most /16).');
  if (spec.data.mode === 'onprem') spec.data.cidrs.forEach((c, i) => overlaps(c, spec.network.cidr) && add(`data.cidrs.${i}`, 'network', `${c} overlaps the deployment's network ${spec.network.cidr}.`));

  // The front door.
  let frontDoorAccount: CloudAccount | null = null;
  const fd = spec.frontDoor;
  if (fd.kind === 'cloudflare' || fd.kind === 'acme') {
    if (fd.hostname !== fd.zone && !fd.hostname.endsWith(`.${fd.zone}`)) add('frontDoor.hostname', 'front_door', `${fd.hostname} is not in the DNS zone ${fd.zone}.`);
  }
  if (fd.kind === 'cloudflare') {
    if (labelRank(spec.label) > labelRank(CLOUDFLARE_FRONT_DOOR_CAP)) add('frontDoor.kind', 'ceiling', `Cloudflare's edge sees decrypted traffic, so a deployment behind it holds at most ${CLOUDFLARE_FRONT_DOOR_CAP}.`);
    const cf = await acc.get(fd.accountId);
    if (!cf || !acc.canSee(p, cf)) add('frontDoor.accountId', 'state', 'The Cloudflare account does not exist.');
    else if (cf.provider !== 'cloudflare') add('frontDoor.accountId', 'provider', `${cf.name} is not a Cloudflare account.`);
    else {
      frontDoorAccount = cf;
      if (cf.scope !== 'platform') add('frontDoor.accountId', 'scope', `${cf.name} is a tenant account; the front door of a deployment needs a platform account.`);
      const e = await acc.checkRegion(cf, 'global', labelRank(spec.label) > labelRank(CLOUDFLARE_FRONT_DOOR_CAP) ? CLOUDFLARE_FRONT_DOOR_CAP : spec.label, { use: 'deploy' });
      if (!e.allow) add('frontDoor.accountId', (e.step ?? 'region') as ProblemCheck, e.reason);
      const v = cf.validation?.features.find((x) => x.feature === 'frontdoor');
      if (!cf.validation) add('frontDoor.accountId', 'permission', `${cf.name} has not been validated yet.`);
      else if (v?.status === 'missing') add('frontDoor.accountId', 'permission', `${cf.name}'s token lacks ${v.missing.join(', ')}, which the front door needs.`);
      // Sprint 61 (B-10905): the app tier on the same account needs Workers, Containers and Hyperdrive (and R2 for blobs).
      if (spec.compute.shape === 'cloudflare' && cf.validation) {
        for (const f of ['apptier', 'data'] as const) {
          const a = cf.validation.features.find((x) => x.feature === f);
          if (a?.status === 'missing') add('frontDoor.accountId', 'permission', `${cf.name}'s token lacks ${a.missing.join(', ')}, which the Cloudflare app tier needs.`);
        }
      }
    }
  }

  // The name is unique within the tenant (as `s.cloud.deployments.create` requires), when deployments are installed.
  if ((await s.cloud.deployments.installed().catch(() => false)) && (await s.db('cloud_deployments').where({ tenant_id: p.tenantId, name: spec.name }).first())) add('name', 'name', `A deployment named ${spec.name} already exists.`);

  const region = account.regions.find((r) => r.region === spec.target.region);
  const resolved: ResolvedSpec | null = region ? { spec, account, region: { ...region, ceiling: d.ceiling ?? region.ceiling }, frontDoorAccount, preset: SIZE_PRESETS[spec.compute.size], skus } : null;
  return { valid: problems.length === 0, problems, unavailable: [], resolved };
}

/** True when `inner` lies entirely inside `outer` (IPv4). */
export function within(inner: string, outer: string): boolean {
  const a = parseCidr(inner);
  const b = parseCidr(outer);
  if (!a || !b || a.family !== 4 || b.family !== 4 || a.prefix < b.prefix) return false;
  const v4 = (x: string) => x.split('.').reduce((n, o) => n * 256 + Number(o), 0);
  const size = 2 ** (32 - b.prefix);
  return Math.floor(v4(a.address) / size) === Math.floor(v4(b.address) / size);
}

/** The account's provider as a deploy target (the spec schema allows only these three). */
export const isDeployProvider = (p: Provider): p is DeployProvider => (DEPLOY_PROVIDERS as readonly string[]).includes(p);
