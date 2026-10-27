import { isSecretRef } from '../vault/policy.js';
import type { DesiredResource } from './graph.js';
import { appEnv, FILE_ONLY_VARS, MIGRATE_COMMAND, SECRET_VARS } from './compute.js';
import type { SecretBinding } from './providers/types.js';
import { autoJurisdiction, regionOfJurisdiction, type R2Jurisdiction } from './r2.js';
import { SIZE_PRESETS, type DeploymentSpec, type Size } from './spec.js';

/*
 * 1.9.99-final, Sprint 61 (B-10905): the Cloudflare app tier (hybrid), `compute.shape: cloudflare`.
 *
 * Cloudflare runs the app tier only: it cannot run PostgreSQL, Redis or Ollama GPUs, so the data tier stays on the
 * target provider (AWS, Azure, DigitalOcean) or on-prem. On the Cloudflare account (the front door's), the spec renders:
 *
 *   worker        a Worker that fronts everything: the console's static files (Workers static assets, uploaded from
 *                 this build's web/ directory) for script, style, image and font paths, and every other request
 *                 (HTML pages with their CSP, /api, /v1, Socket.io) to the app's container; plain settings as
 *                 `plain_text` bindings, secrets as Worker secrets (`secret_text`, from the vault at create time),
 *                 Hyperdrive as a binding whose connection string is the container's DATABASE_URL, the R2 bucket's
 *                 S3 settings; the front door's hostname as the Worker's custom domain
 *   app           the signed image (by digest) on Cloudflare Containers, as the Worker's Durable Object class;
 *                 one instance per app replica, the instance type from the size preset; migrations as the first
 *                 instance's start (DB_MIGRATE_ON_START), since Containers have no one-off job
 *   hyperdrive    PostgreSQL through Hyperdrive: to the provisioned database through the deployment's tunnel (it has
 *                 no public address), to an existing one directly or through the tunnel, or on-prem through the tunnel
 *                 (a Cloudflare Access service token); the database password is read from the vault at create time
 *                 and handed to Cloudflare only
 *   blobs         an R2 bucket (BLOB_STORE=s3 against R2), in the EU jurisdiction when the data region is in the EU
 *                 or the spec asks, FedRAMP only when asked (B-10906)
 *
 * Redis is required from a managed cache on another provider (open decision 19: a TLS endpoint with authentication
 * and an IP allow-list of Cloudflare's egress ranges): `data.redisUrlRef` or `compute.cloudflare.redisUrlRef`. A
 * plan without it is refused with that reason (`cloudflareAppProblems`, a blocker of every plan through
 * `computeProblems`). Secrets are never plain settings: DATA_KEY and the cloud credentials would reach the container
 * as variables, so the key-encryption key stays in OpenBao transit (the app holds only its token). Pure: nothing
 * here calls anything.
 */

/** Cloudflare Containers instance types per size preset. */
export const CF_INSTANCE_TYPES: Record<Size, string> = { small: 'standard-1', medium: 'standard-2', large: 'standard-4' };
/** The Durable Object class the Worker runs the container as. */
export const CONTAINER_CLASS = 'ExprsnApp';
/** The Workers compatibility date the generated script is written for. */
export const WORKER_COMPATIBILITY_DATE = '2026-09-01';
/** Paths the Worker answers from static assets (never HTML: the console's pages come from the app, with its CSP). */
export const ASSET_PREFIXES = ['/js/', '/css/', '/img/', '/fonts/', '/icons/', '/vendor/', '/favicon.ico', '/manifest.webmanifest', '/sw.js'];
/** The app's port in the container. */
export const APP_PORT = 8080;

export const isCloudflareShape = (spec: DeploymentSpec): boolean => spec.compute.shape === 'cloudflare';

/** The Redis URL reference a Cloudflare app tier uses: the spec's cache on another provider, or null. */
export function redisRefOf(spec: DeploymentSpec): string | null {
  return spec.compute.cloudflare?.redisUrlRef ?? (spec.data.mode === 'existing' ? (spec.data.redisUrlRef ?? null) : null);
}

/** The R2 bucket's jurisdiction for the spec (`auto`: EU when the data region is in the EU). */
export function appTierJurisdiction(spec: DeploymentSpec): R2Jurisdiction {
  const want = spec.compute.cloudflare?.r2Jurisdiction ?? 'auto';
  return want === 'auto' ? autoJurisdiction(spec.target.provider, spec.target.region) : want;
}

/** How Hyperdrive reaches the database: through the tunnel (provisioned and on-prem: no public address) or directly. */
export function databaseVia(spec: DeploymentSpec): 'tunnel' | 'direct' {
  return spec.compute.cloudflare?.databaseVia ?? (spec.data.mode === 'existing' ? 'direct' : 'tunnel');
}

export const REDIS_REQUIRED = "A Cloudflare app tier needs Redis on another provider: Cloudflare has no Redis (Workers KV is no substitute), and BullMQ, the bus and Socket.io across instances need one. Give data.redisUrlRef (an existing cache) or compute.cloudflare.redisUrlRef: a managed cache on AWS, Azure or DigitalOcean with TLS and authentication that Cloudflare's egress ranges may reach (open decision 19).";
export const DATABASE_REQUIRED = 'A Cloudflare app tier reaches PostgreSQL through Hyperdrive; the plan has no Hyperdrive configuration for the Worker.';

/** The spec's problems a Cloudflare app tier has before anything is rendered (`validateSpec` adds them). */
export function appTierSpecProblems(spec: DeploymentSpec): { path: string; message: string }[] {
  if (!isCloudflareShape(spec)) return [];
  const out: { path: string; message: string }[] = [];
  if (spec.frontDoor.kind !== 'cloudflare') out.push({ path: 'frontDoor.kind', message: 'A Cloudflare app tier is reached through Cloudflare\'s edge: the front door is cloudflare, on the account the Worker and the container run in.' });
  if (!redisRefOf(spec)) out.push({ path: 'compute.cloudflare.redisUrlRef', message: REDIS_REQUIRED });
  if (spec.gpuPools.length) out.push({ path: 'gpuPools', message: 'Cloudflare runs the app tier only; pick a provider for data and GPUs (GPU pools need the Kubernetes or VM shape on AWS, Azure or DigitalOcean).' });
  if (!spec.release?.image) out.push({ path: 'release.image', message: 'A Cloudflare app tier runs the signed image pinned by digest (registry/repository@sha256:...) on Cloudflare Containers.' });
  if (spec.keys && spec.keys.provider !== 'openbao') out.push({ path: 'keys.provider', message: 'Workers hand secrets to the container as variables, and production takes cloud credentials only as files: the key-encryption key stays in OpenBao transit for a Cloudflare app tier.' });
  if (spec.clusterKeys) out.push({ path: 'clusterKeys', message: 'clusterKeys is for Kubernetes deployments; a Cloudflare app tier takes keys (OpenBao).' });
  if (spec.data.mode === 'onprem' && databaseVia(spec) === 'direct') out.push({ path: 'compute.cloudflare.databaseVia', message: 'An on-prem database is reached through the tunnel only.' });
  return out;
}

/** The Worker's secrets (references only): the container gets each as a variable from the Worker. */
export function workerSecrets(spec: DeploymentSpec): SecretBinding[] {
  const ref = (key: string) => `vault:cloud/${spec.name}#${key}`;
  const out: SecretBinding[] = [{ name: 'session_secret', env: 'SESSION_SECRET', ref: ref('session_secret') }];
  const redis = redisRefOf(spec);
  if (redis) out.push({ name: 'redis_url', env: 'REDIS_URL', ref: redis });
  out.push({ name: 'openbao_token', env: 'OPENBAO_TOKEN', ref: ref('openbao_token') });
  // The R2 API token's S3 key pair for BLOB_STORE=s3 (B-10906).
  out.push({ name: 's3_access_key_id', env: 'S3_ACCESS_KEY_ID', ref: ref('r2_access_key_id') }, { name: 's3_secret_access_key', env: 'S3_SECRET_ACCESS_KEY', ref: ref('r2_secret_access_key') });
  return out;
}

/** The Cloudflare account's resources of a `cloudflare` shape deployment (empty for any other shape). */
export function renderCloudflareAppTier(spec: DeploymentSpec): { accountId: string; resources: DesiredResource[]; notes: string[] } | null {
  if (!isCloudflareShape(spec) || spec.frontDoor.kind !== 'cloudflare') return null;
  const fd = spec.frontDoor;
  const preset = SIZE_PRESETS[spec.compute.size];
  const j = appTierJurisdiction(spec);
  const via = databaseVia(spec);
  const ref = (key: string) => `vault:cloud/${spec.name}#${key}`;
  const databaseUrlRef = spec.data.mode === 'existing' ? spec.data.databaseUrlRef : ref('database_url');
  const res = (r: Omit<DesiredResource, 'protect' | 'region'> & { protect?: boolean; region?: string | null }): DesiredResource => ({ protect: false, region: null, ...r });
  const resources: DesiredResource[] = [
    res({ key: 'blobs', type: 'bucket', spec: { publicAccess: false, jurisdiction: j, sizeGb: preset.bucketGb, store: 'r2' }, dependsOn: [], protect: true, region: j === 'default' ? null : regionOfJurisdiction(j) }),
    res({
      key: 'hyperdrive',
      type: 'hyperdrive',
      spec: {
        origin: { databaseUrlRef, via, ...(via === 'tunnel' ? { accessClientIdRef: ref('hyperdrive_access_client_id'), accessClientSecretRef: ref('hyperdrive_access_client_secret') } : {}), ...(spec.data.mode === 'provision' ? { from: { account: 'target', key: 'db' } } : {}) },
        caching: { disabled: false }
      },
      dependsOn: []
    }),
    res({
      key: 'worker',
      type: 'worker',
      spec: {
        compatibilityDate: WORKER_COMPATIBILITY_DATE,
        // Plain settings only (`cloudflareAppProblems` refuses a secret here); the R2 endpoint and bucket are added at create time.
        vars: appEnv(spec, { PORT: String(APP_PORT), BLOB_STORE: 's3', S3_REGION: 'auto', S3_FORCE_PATH_STYLE: 'true' }),
        secrets: workerSecrets(spec),
        databaseFrom: 'hyperdrive',
        hyperdrive: 'hyperdrive',
        r2: { bucket: 'blobs', jurisdiction: j },
        assets: { source: 'console', prefixes: ASSET_PREFIXES },
        container: { className: CONTAINER_CLASS, instances: preset.app.replicas, port: APP_PORT },
        customDomain: { hostname: fd.hostname, zone: fd.zone }
      },
      dependsOn: ['hyperdrive', 'blobs']
    }),
    res({
      key: 'app',
      type: 'container_service',
      spec: {
        platform: 'cloudflare-containers',
        image: spec.release?.image ?? null,
        replicas: preset.app.replicas,
        instanceType: CF_INSTANCE_TYPES[spec.compute.size],
        vcpu: preset.app.vcpu,
        memoryGb: preset.app.memoryGb,
        port: APP_PORT,
        // The container's settings and secrets come from the Worker (`worker.vars`, `worker.secrets`), never inline here.
        env: {},
        secrets: [],
        secretDelivery: 'platform',
        migrate: { command: MIGRATE_COMMAND, onStart: true },
        subnets: [],
        ingress: 'internal',
        worker: 'worker',
        className: CONTAINER_CLASS,
        version: spec.release?.version ?? null
      },
      dependsOn: ['worker']
    })
  ];
  const notes = [
    `The app tier runs on Cloudflare (account of the front door): a Worker with the console's static files, the image on Cloudflare Containers (${preset.app.replicas} × ${CF_INSTANCE_TYPES[spec.compute.size]}), Hyperdrive to PostgreSQL ${via === 'tunnel' ? 'through the tunnel' : 'directly'}, blobs on R2${j === 'default' ? '' : ` (${j} jurisdiction)`}. The data tier stays on ${spec.data.mode === 'onprem' ? 'premises' : spec.target.provider}.`,
    'Redis comes from the managed cache named by its reference (open decision 19); no cache is provisioned for a Cloudflare app tier, since Containers cannot reach a private one.',
    'Containers have no one-off job: the first instance to start runs the migrations (DB_MIGRATE_ON_START).'
  ];
  return { accountId: fd.accountId, resources, notes };
}

/** The Worker module: static assets for asset paths, everything else to the container (no value of any secret in it). */
export function renderWorkerScript(o: { className: string; instances: number; port: number; vars: string[]; secrets: string[]; prefixes: readonly string[] }): string {
  const names = JSON.stringify([...o.vars, ...o.secrets]);
  return [
    '// Exprsn-AI app tier on Cloudflare (B-10905). Generated; holds no secret value: secrets are Worker secrets.',
    "import { DurableObject } from 'cloudflare:workers';",
    `const PREFIXES = ${JSON.stringify(o.prefixes)};`,
    `const NAMES = ${names};`,
    `const INSTANCES = ${Math.max(1, Math.floor(o.instances))};`,
    'function envFor(env) {',
    '  const out = {};',
    '  for (const n of NAMES) if (typeof env[n] === "string") out[n] = env[n];',
    '  // PostgreSQL through Hyperdrive: its connection string, made by the runtime, never stored.',
    '  if (env.HYPERDRIVE) out.DATABASE_URL = env.HYPERDRIVE.connectionString;',
    '  return out;',
    '}',
    `export class ${o.className} extends DurableObject {`,
    '  async fetch(request) {',
    '    const c = this.ctx.container;',
    '    if (!c.running) c.start({ env: envFor(this.env), enableInternet: true });',
    `    return c.getTcpPort(${o.port}).fetch(request.url, request);`,
    '  }',
    '}',
    'function instanceFor(request) {',
    '  const ip = request.headers.get("cf-connecting-ip") || "";',
    '  let h = 0;',
    '  for (let i = 0; i < ip.length; i++) h = (h * 31 + ip.charCodeAt(i)) >>> 0;',
    '  return `app-${h % INSTANCES}`;',
    '}',
    'export default {',
    '  async fetch(request, env) {',
    '    const path = new URL(request.url).pathname;',
    '    if (env.ASSETS && PREFIXES.some((p) => path === p || path.startsWith(p))) {',
    '      const r = await env.ASSETS.fetch(request);',
    '      if (r.status !== 404) return r;',
    '    }',
    `    return env.APP.get(env.APP.idFromName(instanceFor(request))).fetch(request);`,
    '  }',
    '};',
    ''
  ].join('\n');
}

/**
 * Why a Cloudflare app tier's resources may not be applied (a blocker of every plan, through `computeProblems`): a
 * Worker without Redis on another provider or without Hyperdrive, a secret among its plain settings, a secret that
 * is not a vault reference or that production takes only as a file, a container without a pinned image or with
 * settings of its own.
 */
export function cloudflareAppProblems(resources: DesiredResource[]): string[] {
  const out: string[] = [];
  const workers = resources.filter((r) => r.type === 'worker');
  for (const r of workers) {
    const at = `${r.key} (worker)`;
    const p = r.spec as { vars?: Record<string, unknown>; secrets?: SecretBinding[]; hyperdrive?: string; container?: unknown };
    for (const [k, v] of Object.entries(p.vars ?? {})) {
      if (SECRET_VARS.has(k)) out.push(`${at}: ${k} is set as a plain Worker variable; secrets are Worker secrets from the vault${FILE_ONLY_VARS.has(k) ? ', and this one never leaves OpenBao or the signer' : ''}.`);
      else if (/_FILE$/.test(k)) out.push(`${at}: ${k} names a file, but Cloudflare Containers mount no secret files.`);
      else if (typeof v !== 'string') out.push(`${at}: ${k} is not a string.`);
    }
    const secrets = Array.isArray(p.secrets) ? p.secrets : [];
    for (const b of secrets) {
      if (!b || typeof b.ref !== 'string' || !isSecretRef(b.ref)) out.push(`${at}: the secret ${String(b?.name)} is not a vault: reference; secrets are never values in a graph.`);
      else if (FILE_ONLY_VARS.has(b.env)) out.push(`${at}: ${b.env} would reach the container as a variable, and production takes it only as a file; keep the key-encryption key in OpenBao transit.`);
    }
    if (p.container && !secrets.some((b) => b.env === 'REDIS_URL')) out.push(`${at}: ${REDIS_REQUIRED}`);
    if (p.container && !(p.hyperdrive && resources.some((x) => x.key === p.hyperdrive && x.type === 'hyperdrive'))) out.push(`${at}: ${DATABASE_REQUIRED}`);
  }
  for (const r of resources) {
    if (r.type === 'container_service' && (r.spec as { platform?: string }).platform === 'cloudflare-containers') {
      const p = r.spec as { worker?: string; env?: Record<string, unknown> };
      if (!p.worker || !workers.some((w) => w.key === p.worker)) out.push(`${r.key} (container_service): a Cloudflare container runs behind its Worker, which the plan does not have.`);
      if (Object.keys(p.env ?? {}).length) out.push(`${r.key} (container_service): a Cloudflare container takes its settings from its Worker, not its own env.`);
    }
    if (r.type === 'hyperdrive') {
      const o = (r.spec as { origin?: { databaseUrlRef?: unknown; accessClientSecretRef?: unknown } }).origin ?? {};
      if (typeof o.databaseUrlRef !== 'string' || !isSecretRef(o.databaseUrlRef)) out.push(`${r.key} (hyperdrive): the database URL is a vault: reference, never a value.`);
      if (o.accessClientSecretRef !== undefined && (typeof o.accessClientSecretRef !== 'string' || !isSecretRef(o.accessClientSecretRef))) out.push(`${r.key} (hyperdrive): the Access service token's secret is a vault: reference, never a value.`);
    }
  }
  return out;
}
