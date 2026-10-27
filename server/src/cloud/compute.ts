import { ENROL_PLACEHOLDER_RE, type EnrolPayload } from './gpu-node.js';
import { CLOUD_CREDENTIAL_VARS, FILE_VARS } from '../config/index.js';
import { guardedRequest, serviceAddressProblem, servicePolicy } from '../platform/egress.js';
import type { Services } from '../services.js';
import { isSecretRef } from '../vault/policy.js';
import type { Deployment, DesiredResource, GraphResource, ReadinessResult } from './graph.js';
import type { ContainerServiceProps, InstallStatus, PropsByType, SecretBinding, SecretBrokerContext } from './providers/types.js';
import type { DeploymentSpec } from './spec.js';
import type { ReadinessCheck } from './verify.js';
import { cloudflareAppProblems } from './cloudflare-app.js';

/*
 * 1.9.99-final, Sprint 58 (B-10204, B-10205): the app tier on VMs and container platforms, rendered from the spec.
 *
 *   VMs          cloud-init user data that runs the bare-metal installer from the signed release tarball
 *                (`install.sh --from-release <url> --sha256 <digest>`): the bootstrap downloads it, checks the digest
 *                before anything from it runs, and the installer checks it again (and the cosign bundle when given).
 *                IMDSv2 required with hop limit 1 on EC2. Secrets are systemd credentials (`LoadCredential=`, or
 *                `LoadCredentialEncrypted=` where `systemd-creds` works), delivered once through a single-use OpenBao
 *                response-wrapping token the adapter writes into the user data at create time; the rendered user
 *                data holds no secret value, only the placeholder.
 *   containers   ECS on Fargate, Azure Container Apps or DigitalOcean App Platform with a one-off migration task or
 *                job before every rollout; secrets as files where the platform mounts them (Container Apps), else
 *                the platform's secret store; the key-encryption key always in OpenBao transit (open decision 8).
 *
 * `computeProblems` is the render check the planner refuses on: no `DATA_KEY` (or any other secret the config reads)
 * as a plain variable, no unpinned release, no VM without IMDSv2 and hop limit 1. Pure apart from the secret broker
 * and the readiness check at the end.
 */

/** The installer's console lines (`exprsn-install: <state> <detail>`), which the readiness check reads back. */
export const INSTALL_MARK = 'exprsn-install:';
/** Where the adapter writes the wrapped token (JSON `{addr, token}`) into the user data at create time. */
export const BOOTSTRAP_PLACEHOLDER = '@@EXPRSN_BOOTSTRAP@@';
/** The migration every rollout runs first, as a one-off task or job. */
export const MIGRATE_COMMAND = ['node', 'server/dist/cli.js', 'migrate'];
/** Where Container Apps mounts the secrets volume. */
export const SECRET_MOUNT = '/run/secrets/exprsn';

/** Variables that may never be given inline to a deployed app: every secret the config reads (and `_FILE` reads). */
export const SECRET_VARS: ReadonlySet<string> = new Set<string>([...FILE_VARS]);
/** Secrets production takes only as files: never handed over as a platform's secret variables either. */
export const FILE_ONLY_VARS: ReadonlySet<string> = new Set<string>(['DATA_KEY', 'DATA_KEY_PREVIOUS', 'SIGNER_TOKEN', ...CLOUD_CREDENTIAL_VARS]);

const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/** The secrets a deployed app needs, by reference only (never a value). */
export function secretBindings(spec: DeploymentSpec): SecretBinding[] {
  const ref = (key: string) => `vault:cloud/${spec.name}#${key}`;
  const out: SecretBinding[] = [{ name: 'session_secret', env: 'SESSION_SECRET', ref: ref('session_secret') }];
  if (spec.data.mode === 'existing') {
    out.push({ name: 'database_url', env: 'DATABASE_URL', ref: spec.data.databaseUrlRef });
    if (spec.data.redisUrlRef) out.push({ name: 'redis_url', env: 'REDIS_URL', ref: spec.data.redisUrlRef });
  } else {
    // provision (B-103 fills them once the managed database and cache exist) or on-prem (the operator writes them).
    out.push({ name: 'database_url', env: 'DATABASE_URL', ref: ref('database_url') });
    if (spec.data.mode === 'provision' ? spec.data.cache : false) out.push({ name: 'redis_url', env: 'REDIS_URL', ref: ref('redis_url') });
    // Sprint 59 (B-10302): the managed database's CA bundle, as a file the URL's sslrootcert names (`cloud/data-tier.ts`).
    if (spec.data.mode === 'provision') out.push({ name: 'database_ca', env: 'DATABASE_CA', ref: ref('database_ca') });
  }
  // The key-encryption key stays in OpenBao transit or the cloud KMS (B-10208): the app holds only a credential for
  // it, as a file (open decision 8). With no keys given, OpenBao is assumed (validation asks for keys).
  const keys = spec.keys;
  if (keys?.provider === 'aws-kms') out.push({ name: 'kms_aws_secret', env: 'KMS_AWS_SECRET_ACCESS_KEY', ref: keys.secretRef });
  else if (keys?.provider === 'azure-keyvault') out.push({ name: 'azure_identity_secret', env: 'AZURE_IDENTITY_CLIENT_SECRET', ref: keys.secretRef });
  else out.push({ name: 'openbao_token', env: 'OPENBAO_TOKEN', ref: ref('openbao_token') });
  return out;
}

/** The app's plain settings (no secret: `computeProblems` checks). */
export function appEnv(spec: DeploymentSpec, extra: Record<string, string> = {}): Record<string, string> {
  const host = 'hostname' in spec.frontDoor ? spec.frontDoor.hostname : null;
  return {
    NODE_ENV: 'production',
    ...(host ? { PUBLIC_URL: `https://${host}` } : {}),
    ...keyEnv(spec),
    ...extra
  };
}

/** The key provider's plain settings (B-10208 for the cloud KMS: credentials read explicitly, never from metadata). */
function keyEnv(spec: DeploymentSpec): Record<string, string> {
  const k = spec.keys;
  if (k?.provider === 'aws-kms') return { KMS_PROVIDER: 'aws-kms', KMS_AWS_REGION: k.region, KMS_AWS_ACCESS_KEY_ID: k.accessKeyId };
  if (k?.provider === 'azure-keyvault') return { KMS_PROVIDER: 'azure-keyvault', KMS_AZURE_VAULT_URL: k.vaultUrl, AZURE_IDENTITY_TENANT_ID: k.tenantId, AZURE_IDENTITY_CLIENT_ID: k.clientId };
  return { KMS_PROVIDER: 'openbao', ...(k ? { OPENBAO_ADDR: k.addr, OPENBAO_TRANSIT_MOUNT: k.transitMount } : {}) };
}

// ---------- VMs (B-10204) ----------

export interface VmBootInput {
  deployment: string;
  install: NonNullable<PropsByType['vm']['install']>;
  kms: string;
  env: Record<string, string>;
  secrets: SecretBinding[];
}

/**
 * The cloud-init user data of an app VM. The bootstrap script is in the user data itself (the provider keeps it
 * intact), so the first thing that runs from the network is the archive whose digest was checked: it downloads the
 * tarball, compares its sha256 with the pinned digest and refuses on a mismatch (nothing is extracted), takes the
 * installer out of the verified archive and runs `install.sh --from-release <url> --sha256 <digest>` on that copy,
 * which verifies again, checks the cosign bundle when one is pinned, installs, and loads the credentials from the
 * single-use wrapped token as systemd credentials. Every outcome is an `exprsn-install:` line on the console.
 */
export function renderCloudInit(o: VmBootInput): string {
  const url = o.install.url ?? '';
  const sha = o.install.sha256 ?? '';
  const envLines = Object.entries(o.env).map(([k, v]) => `      ${k}=${v}`);
  const credLines = o.secrets.map((b) => `      ${b.name} ${b.env}`);
  const flags = [`--from-release ${shq(url)}`, `--sha256 ${sha}`, '--archive "$d/release.tar.gz"', `--kms ${o.kms}`, '--credentials-list /etc/exprsn-ai/credentials.list', '--credentials-wrapped /run/exprsn-bootstrap/token'];
  if (o.install.bundleUrl) flags.push(`--bundle ${shq(o.install.bundleUrl)}`, `--cert-identity-regexp ${shq(o.install.identity ?? '')}`);
  flags.push('--start');
  const bootstrap = [
    '#!/bin/sh',
    '# Exprsn-AI first boot (B-10204): verify the release tarball before anything from it runs.',
    'set -eu',
    `URL=${shq(url)}`,
    `SHA=${shq(sha)}`,
    `say() { echo "${INSTALL_MARK} $*"; echo "${INSTALL_MARK} $*" > /dev/console 2>/dev/null || true; }`,
    'd=$(mktemp -d)',
    "trap 'rm -rf \"$d\"' EXIT",
    'case "$URL" in https://*) ;; *) say "refused the release URL is not https"; exit 1 ;; esac',
    'curl -fsSL --proto =https --tlsv1.2 --retry 5 -o "$d/release.tar.gz" "$URL" || { say "refused the release tarball could not be downloaded"; exit 1; }',
    'got=$(sha256sum "$d/release.tar.gz" | cut -d" " -f1)',
    '[ "$got" = "$SHA" ] || { say "refused sha256 mismatch: expected $SHA, got $got"; exit 1; }',
    'tar -xzf "$d/release.tar.gz" -C "$d" --no-same-owner --no-same-permissions exprsn-ai/deploy/baremetal/install.sh || { say "refused the archive has no installer"; exit 1; }',
    `sh "$d/exprsn-ai/deploy/baremetal/install.sh" ${flags.join(' ')}`
  ];
  return [
    '#cloud-config',
    `# Exprsn-AI ${o.deployment}: app VM (B-10204). No secret value is in this file; the wrapped token below is single use.`,
    'package_update: false',
    'write_files:',
    '  - path: /etc/exprsn-ai/exprsn-ai.env',
    "    permissions: '0640'",
    '    content: |',
    ...envLines,
    '  - path: /etc/exprsn-ai/credentials.list',
    "    permissions: '0600'",
    '    content: |',
    ...credLines,
    '  - path: /run/exprsn-bootstrap/token',
    "    permissions: '0600'",
    `    content: '${BOOTSTRAP_PLACEHOLDER}'`,
    '  - path: /usr/local/sbin/exprsn-bootstrap',
    "    permissions: '0700'",
    '    content: |',
    ...bootstrap.map((l) => `      ${l}`),
    'runcmd:',
    '  - [ /usr/local/sbin/exprsn-bootstrap ]',
    ''
  ].join('\n');
}

/** The props of one app VM. */
export function vmAppProps(spec: DeploymentSpec, base: { size: string; subnet?: string; firewall: string }): PropsByType['vm'] & Record<string, unknown> {
  const t = spec.release?.tarball;
  const install = { from: 'release' as const, url: t?.url ?? null, sha256: t?.sha256 ?? null, bundleUrl: t?.bundleUrl ?? null, identity: t?.identity ?? null, version: spec.release?.version ?? null };
  const secrets = secretBindings(spec);
  const env = appEnv(spec);
  return {
    role: 'app',
    size: base.size,
    image: 'ubuntu-24.04',
    ...(base.subnet ? { subnet: base.subnet } : {}),
    firewall: base.firewall,
    imdsV2: true,
    metadataHopLimit: 1,
    publicIp: false,
    install,
    secrets,
    userData: renderCloudInit({ deployment: spec.name, install, env, secrets, kms: spec.keys?.provider ?? 'openbao' })
  };
}

/** The bootstrap JSON the adapter puts in place of the placeholder (or an empty object without a broker). */
export async function bootstrapUserData(userData: string | undefined, secrets: SecretBinding[] | undefined, broker: SecretBrokerContext | undefined): Promise<string | undefined> {
  // Sprint 60 (B-10401): a GPU node's single-use enrolment token, minted for this VM at create time (never in the graph).
  if (userData && ENROL_PLACEHOLDER_RE.test(userData)) {
    ENROL_PLACEHOLDER_RE.lastIndex = 0;
    const found = [...userData.matchAll(ENROL_PLACEHOLDER_RE)];
    for (const m of found) {
      const payload = broker?.enrol ? await broker.enrol(m[1]!, m[2]!) : null;
      userData = userData.replace(m[0], JSON.stringify(payload ?? {}).replace(/'/g, "''"));
    }
  }
  if (!userData || !userData.includes(BOOTSTRAP_PLACEHOLDER)) return userData;
  const wrapped = broker && secrets?.length ? await broker.wrap(secrets) : null;
  // JSON inside a single-quoted YAML scalar: single quotes doubled.
  const payload = JSON.stringify(wrapped ? { addr: wrapped.addr, token: wrapped.token, ttl: wrapped.ttlSeconds } : {}).replace(/'/g, "''");
  return userData.replace(BOOTSTRAP_PLACEHOLDER, payload);
}

// ---------- containers (B-10205) ----------

export const CONTAINER_PLATFORM = { aws: 'ecs-fargate', azure: 'container-apps', digitalocean: 'app-platform' } as const;

/** The props of the container service: Container Apps mounts secrets as files; ECS and App Platform use their secret stores. */
export function containerProps(spec: DeploymentSpec, base: { replicas: number; vcpu: number; memoryGb: number; subnets: string[]; firewall: string; ingress: 'internal' | 'internet-facing' }): ContainerServiceProps & Record<string, unknown> {
  const platform = CONTAINER_PLATFORM[spec.target.provider];
  const secretDelivery = platform === 'container-apps' ? 'files' : 'platform';
  const secrets = secretBindings(spec);
  const files = secretDelivery === 'files' ? Object.fromEntries(secrets.map((b) => [`${b.env}_FILE`, `${SECRET_MOUNT}/${fileName(b)}`])) : {};
  return {
    platform,
    image: spec.release?.image ?? null,
    replicas: base.replicas,
    vcpu: base.vcpu,
    memoryGb: base.memoryGb,
    port: 8080,
    env: appEnv(spec, { PORT: '8080', ...files }),
    secrets,
    secretDelivery,
    migrate: { command: MIGRATE_COMMAND },
    subnets: base.subnets,
    firewall: base.firewall,
    ingress: base.ingress,
    version: spec.release?.version ?? null
  };
}

/** A binding's file or platform secret name (Container Apps secret names: lower case letters, digits and dashes). */
export const fileName = (b: SecretBinding): string => b.name.replace(/_/g, '-');

// ---------- the render check the planner refuses on ----------

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/gm;

/** Inline assignments of secret variables in a text (an env file in user data): `DATA_KEY=...` and friends. */
function inlineSecrets(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(ASSIGNMENT)) if (SECRET_VARS.has(m[1]!) && m[2]!.trim() !== '') out.push(m[1]!);
  return [...new Set(out)];
}

/**
 * Why a VM or container resource of a graph may not be applied: a secret given inline (DATA_KEY above all), a
 * secret binding that is not a `vault:` reference, an unpinned release, a VM without IMDSv2 and hop limit 1 or with a
 * public address. The planner adds these to a plan's blockers, so the plan is not applicable.
 */
export function computeProblems(resources: DesiredResource[]): string[] {
  const out: string[] = [];
  for (const r of resources) {
    const at = `${r.key} (${r.type})`;
    const p = r.spec as Record<string, unknown>;
    const bindings = Array.isArray(p.secrets) ? (p.secrets as SecretBinding[]) : [];
    for (const b of bindings) if (!b || typeof b.ref !== 'string' || !isSecretRef(b.ref)) out.push(`${at}: the secret ${String(b?.name)} is not a vault: reference; secrets are never values in a graph.`);
    if (r.type === 'container_service') {
      const env = (p.env ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(env)) {
        if (SECRET_VARS.has(k)) out.push(`${at}: ${k} is set as a plain environment variable; ${k === 'DATA_KEY' || k === 'DATA_KEY_PREVIOUS' ? 'the key-encryption key stays in OpenBao transit or the signer' : 'it must come from the platform\'s secret store or a mounted file'}.`);
        else if (/_FILE$/.test(k) && SECRET_VARS.has(k.slice(0, -5)) && p.secretDelivery !== 'files') out.push(`${at}: ${k} names a file, but ${String(p.platform)} mounts no secret files.`);
        else if (typeof v !== 'string') out.push(`${at}: ${k} is not a string.`);
      }
      for (const b of bindings) if (FILE_ONLY_VARS.has(b.env) && p.secretDelivery !== 'files') out.push(`${at}: ${b.env} would reach the app as a variable from ${String(p.platform)}'s secret store, and production takes it only as a file; ${b.env.startsWith('DATA_KEY') ? 'keep the key-encryption key in OpenBao transit or the signer' : 'use OpenBao for this target'}.`);
      if (typeof p.image !== 'string' || !/@sha256:[a-f0-9]{64}$/.test(p.image)) out.push(`${at}: no image pinned by digest (release.image).`);
      const migrate = p.migrate as { command?: unknown } | undefined;
      if (!migrate || !Array.isArray(migrate.command) || !migrate.command.length) out.push(`${at}: no one-off migration before the rollout.`);
    }
    if (r.type === 'vm' && (p.role === 'app' || p.install)) {
      const install = p.install as PropsByType['vm']['install'] | undefined;
      if (!install || install.from !== 'release' || !install.url?.startsWith('https://') || !/^[a-f0-9]{64}$/.test(install.sha256 ?? '')) out.push(`${at}: no signed release pinned (release.tarball: an https URL and its sha256).`);
      const ud = typeof p.userData === 'string' ? p.userData : '';
      if (install?.sha256 && (!ud.includes('--from-release') || !ud.includes(`--sha256 ${install.sha256}`))) out.push(`${at}: the user data does not run the installer with --from-release and the pinned sha256.`);
      for (const k of inlineSecrets(ud)) out.push(`${at}: the user data sets ${k} inline; secrets are systemd credentials.`);
      if (p.imdsV2 !== true || p.metadataHopLimit !== 1) out.push(`${at}: the instance metadata service must require IMDSv2 tokens with a hop limit of 1.`);
      if (p.publicIp !== false) out.push(`${at}: an app VM has no public address; the load balancer or the tunnel reaches it.`);
    }
    // B-10705 (Sprint 59): every other VM (GPU pools) too: never IMDSv1, never a hop limit above 1.
    else if (r.type === 'vm' && (p.imdsV2 === false || (p.metadataHopLimit !== undefined && p.metadataHopLimit !== 1))) out.push(`${at}: the instance metadata service must require IMDSv2 tokens with a hop limit of 1.`);
  }
  // Sprint 61 (B-10905): a Cloudflare app tier: Redis on another provider, Hyperdrive, no secret among the Worker's settings.
  out.push(...cloudflareAppProblems(resources));
  return out;
}

// ---------- the secret broker ----------

/** The engine's secret broker (`EngineHooks.secrets`): values for one deployment, wrapped tokens for its VMs. */
export interface SecretBroker {
  value(d: Deployment, b: SecretBinding): Promise<string>;
  wrap(d: Deployment, bindings: SecretBinding[]): Promise<{ token: string; addr: string; ttlSeconds: number } | null>;
  /** Sprint 60 (B-10401): a single-use enrolment token for one GPU VM of a pool (null: no link, no migration). */
  enrol?(d: Deployment, pool: string, key: string): Promise<EnrolPayload | null>;
}

/** Binds a broker to a deployment for an adapter's call context. */
export const brokerFor = (broker: SecretBroker | undefined, d: Deployment): SecretBrokerContext | undefined =>
  broker ? { value: (b) => broker.value(d, b), wrap: (list) => broker.wrap(d, list), ...(broker.enrol ? { enrol: (pool: string, key: string) => broker.enrol!(d, pool, key) } : {}) } : undefined;

/**
 * The default broker: values through the vault as the deployment's creator (`resolveFor`, audited as reads), and
 * wrapped tokens through OpenBao's `sys/wrapping/wrap` (15 minutes, single use) when OPENBAO_ADDR and OPENBAO_TOKEN
 * are set; otherwise `wrap` answers null and the VM installs without credentials (its readiness says so).
 */
export function defaultSecretBroker(s: () => Services, ttlSeconds = 900, intercept?: (d: Deployment, b: SecretBinding) => Promise<string | null>): SecretBroker {
  // Sprint 59 (B-10302, B-10305): `intercept` answers what Exprsn-AI generates or wires itself (a provisioned data
  // tier's URLs and CA, a database's admin password, a cache's AUTH token: `cloud/data-tier.ts`); the rest resolves
  // through the vault as the deployment's creator, as before.
  const value: SecretBroker['value'] = async (d, b) => (intercept ? await intercept(d, b) : null) ?? s().vault.resolveFor(d.tenantId, d.createdBy, b.ref, { via: `cloud.deploy:${d.name}` });
  return {
    value,
    async wrap(d, bindings) {
      const cfg = s().cfg;
      if (!cfg.OPENBAO_ADDR || !cfg.OPENBAO_TOKEN) return null;
      const data: Record<string, string> = {};
      for (const b of bindings) data[b.name] = await value(d, b);
      const policy = servicePolicy(cfg);
      const res = await guardedRequest({ method: 'POST', url: new URL('/v1/sys/wrapping/wrap', cfg.OPENBAO_ADDR), headers: { 'x-vault-token': cfg.OPENBAO_TOKEN, 'x-vault-wrap-ttl': String(ttlSeconds), 'content-type': 'application/json' }, body: JSON.stringify(data), timeoutMs: 10_000, maxBytes: 64 * 1024, check: (a, h) => serviceAddressProblem(a, h, policy) });
      if (res.status !== 200) throw new Error(`OpenBao refused to wrap the credentials (HTTP ${res.status}).`);
      const token = (JSON.parse(res.body.toString('utf8')) as { wrap_info?: { token?: string } }).wrap_info?.token;
      if (!token) throw new Error('OpenBao answered without a wrapping token.');
      return { token, addr: cfg.OPENBAO_ADDR, ttlSeconds };
    }
  };
}

// ---------- the install readiness check (B-10204) ----------

/** The last `exprsn-install:` line of a console log, as an install status. */
export function installStatusFrom(consoleText: string | null | undefined): InstallStatus {
  if (consoleText == null) return { state: 'unknown', detail: 'The console output is not available yet.' };
  const lines = consoleText.split(/\r?\n/).filter((l) => l.includes(INSTALL_MARK)).map((l) => l.slice(l.indexOf(INSTALL_MARK) + INSTALL_MARK.length).trim());
  const refused = lines.find((l) => l.startsWith('refused'));
  if (refused) return { state: 'refused', detail: `The installer refused: ${refused.slice('refused'.length).trim().slice(0, 300)}` };
  const done = lines.reverse().find((l) => l.startsWith('installed'));
  if (done) return { state: 'installed', detail: `The installer finished: ${done.slice('installed'.length).trim().slice(0, 300)}` };
  return { state: 'pending', detail: lines.length ? `The installer is running (${lines[0]!.slice(0, 200)}).` : 'The installer has not reported yet.' };
}

/** Readiness of every app VM's install, as its adapter reads the console: a refused release fails verify. */
export const vmInstallCheck: ReadinessCheck = {
  id: 'vm.install',
  applies: (_d, resources: GraphResource[]) => resources.some((r) => r.type === 'vm' && !!(r.desired.spec as { install?: unknown }).install && !!r.providerId),
  async run(c) {
    const d = c.deployment;
    const ctxs = await c.s.cloud.deployments.context(d, 'read');
    const out: ReadinessResult[] = [];
    for (const r of c.resources) {
      if (r.type !== 'vm' || !(r.desired.spec as { install?: unknown }).install || !r.providerId) continue;
      const at = (status: ReadinessResult['status'], detail: string): ReadinessResult => ({ id: 'vm.install', key: r.key, status, detail });
      const read = ctxs.provider.vmInstallStatus?.bind(ctxs.provider);
      if (!read) {
        out.push(at('unknown', `${d.provider} offers no console read, so the installer's result is not known; the app's /readyz decides.`));
        continue;
      }
      const st = await read(ctxs.ctx(r.region ?? d.region, c.signal), { type: 'vm', providerId: r.providerId, region: r.region ?? d.region, ...(r.locator ? { locator: r.locator } : {}) });
      out.push(at(st.state === 'installed' ? 'pass' : st.state === 'refused' ? 'fail' : 'unknown', st.detail));
    }
    return out;
  }
};
