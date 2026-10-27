import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ulid } from 'ulid';
import type { Principal } from '../authz/policy.js';
import { HttpProblem } from '../http/problem.js';
import { loadPrincipal } from '../http/middleware.js';
import { CLOUD_PROVIDER_HOSTS, cloudAddressProblem, servicePolicy } from '../platform/egress.js';
import type { Services } from '../services.js';
import { cloudAudit, type CloudAuditActor } from './audit.js';
import { chartValues, RELEASE_NAME, RELEASE_NAMESPACE, RELEASE_SECRET, secretKeysFor, splitImage } from './chart-values.js';
import { CloudVault } from './cloud-vault.js';
import type { DeploymentContext } from './deployments.js';
import type { Deployment, GraphResource } from './graph.js';
import { chartDir, Helm, HELM_PINNED, helmBin, type HelmExec } from './helm.js';
import { KubeApi } from './kube.js';
import { withKubeconfig } from './kubeconfig.js';
import { KUBE_TOKEN_SECONDS } from './providers/kubernetes.js';
import type { CloudTransport } from './providers/transport.js';
import { CloudProviderError, type CloudProvider, type ClusterAccess, type ResourceRef } from './providers/types.js';
import { renderGraph } from './render.js';
import { deploymentSpecSchema, isDeployProvider, type DeploymentSpec } from './spec.js';
import { CloudUpgrades } from './upgrades.js';

/*
 * 1.9.99-final, Sprint 58 (B-10203): the release of a Kubernetes deployment. `s.cloud.releases`.
 *
 * After an apply of a Kubernetes deployment succeeds (an engine follow-up), `cloud.release` installs the chart into
 * the cluster instead of verifying at once:
 *
 *   1. a short-lived kubeconfig for the cluster (the adapter's `kubeAccess`: an EKS token from a presigned STS
 *      GetCallerIdentity, an AKS Entra token, the DOKS credentials endpoint), in a private file deleted afterwards;
 *      the API server's address is checked as every cloud address is before `helm` (which dials it itself) runs;
 *   2. the namespace and the release's one Kubernetes Secret (server-side apply through the egress guard): the
 *      session secret and the key-encryption key (made once per deployment and kept sealed in the vault at
 *      `cloud/deployments/<id>`), the database and Redis URLs behind the spec's `vault:` references; never in the
 *      values, the journal, an audit entry or a log;
 *   3. `helm upgrade --install --wait --wait-for-jobs` with the pinned binary and the values derived from the spec
 *      (`chart-values.ts`); the chart's migrate Job runs as its pre-install/pre-upgrade hook;
 *   4. the load balancer's address from the ingress (or the Service on DigitalOcean), recorded on the graph's `lb`
 *      and the release; the deployment's public URL; then `cloud.verify` (the app's `/readyz` there).
 *
 * Every revision is a row of `cloud_releases` (migration 151); upgrades and their snapshots are `upgrades.ts`.
 * Without the migration a Kubernetes deployment is verified as before, without a release.
 */

const TABLES = ['cloud_releases', 'cloud_upgrades', 'cloud_snapshots'] as const;
const RECHECK_MS = 30_000;

export const releasesMissing = () => new HttpProblem(503, 'Not installed', 'Releases, upgrades and snapshots need the database migration 151_cloud_releases, which has not been applied.', { extensions: { reason: 'migration_pending' } });

export type ReleaseState = 'deployed' | 'failed' | 'superseded' | 'rolled_back';
export type ReleaseReason = 'install' | 'upgrade' | 'rollback';

export interface ReleaseRecord {
  id: string;
  deploymentId: string;
  release: string;
  namespace: string;
  revision: number;
  chartVersion: string;
  repository: string;
  digest: string;
  valuesHash: string;
  state: ReleaseState;
  reason: ReleaseReason;
  upgradeId: string | null;
  address: string | null;
  error: string | null;
  createdBy: string | null;
  createdAt: number;
}

function releaseFrom(r: Record<string, unknown>): ReleaseRecord {
  return {
    id: String(r.id),
    deploymentId: String(r.deployment_id),
    release: String(r.release),
    namespace: String(r.namespace),
    revision: Number(r.revision),
    chartVersion: String(r.chart_version),
    repository: String(r.repository),
    digest: String(r.digest),
    valuesHash: String(r.values_hash),
    state: r.state as ReleaseState,
    reason: r.reason as ReleaseReason,
    upgradeId: (r.upgrade_id as string | null) ?? null,
    address: (r.address as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: Number(r.created_at)
  };
}

export interface ReleaseOptions {
  /** `helm --timeout` for an install, upgrade or rollback. */
  timeoutSeconds: number;
  /** How long a kubeconfig token is asked for. */
  tokenSeconds: number;
  /** Reads of the ingress status while the cluster's controller makes the load balancer. */
  addressPolls: number;
  addressWaitMs: number;
  sleep: (ms: number) => Promise<void>;
  /** The deployment's public URL (default `https://<front door hostname>`); tests point it at their fake app. */
  publicUrlFor?: (d: Deployment, address: string | null) => string;
  /** Called with each kubeconfig's path while it exists (tests check it is private and gone after). */
  onKubeconfig?: (path: string) => void;
  /** DigitalOcean: the load balancer's certificate (the DNS and TLS work fills it, B-10206). */
  tlsCertificateId?: (d: Deployment) => string | null;
}

/** The release's cluster session: the deployment's context, the cluster row, its access and a Kubernetes client. */
export interface ClusterSession {
  c: DeploymentContext;
  cluster: GraphResource;
  access: ClusterAccess;
  kube: KubeApi;
}

const valuesHash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

export class CloudReleases {
  options: ReleaseOptions = { timeoutSeconds: 900, tokenSeconds: KUBE_TOKEN_SECONDS, addressPolls: 30, addressWaitMs: 10_000, sleep: (ms) => new Promise((r) => setTimeout(r, ms).unref?.()) };
  /** How `helm` is run (tests: a stand-in for the commands that need a cluster). */
  helmExec: HelmExec | undefined;
  readonly upgrades: CloudUpgrades;
  private helmRunner: Helm | null = null;
  private schemaState: { ok: boolean; at: number } | null = null;
  private registered = false;

  constructor(private readonly s: () => Services) {
    this.upgrades = new CloudUpgrades(s, this);
  }

  /** The pinned Helm (HELM_BIN); built on first use. */
  get helm(): Helm {
    return (this.helmRunner ??= new Helm({ bin: helmBin(this.s().cfg.HELM_BIN), pinned: HELM_PINNED, ...(this.helmExec ? { exec: this.helmExec } : {}) }));
  }

  set helm(h: Helm) {
    this.helmRunner = h;
  }

  // ---------- schema ----------

  async installed(): Promise<boolean> {
    const t = Date.now();
    if (this.schemaState && (this.schemaState.ok || t - this.schemaState.at < RECHECK_MS)) return this.schemaState.ok;
    let ok = true;
    try {
      for (const name of TABLES) if (!(await this.s().db.schema.hasTable(name))) ok = false;
    } catch {
      ok = false;
    }
    this.schemaState = { ok, at: t };
    return ok;
  }

  reset(): void {
    this.schemaState = null;
  }

  async need(): Promise<void> {
    if (!(await this.installed())) throw releasesMissing();
  }

  // ---------- jobs and the follow-up of applies ----------

  registerJobs(): void {
    const s = this.s();
    s.jobs.register('cloud.release', async (p, ctx) => this.install(String(p.deploymentId), { jobId: ctx.job.id, onBehalfOf: ctx.job.created_by, reapplyPlan: p.reapply && p.planId ? String(p.planId) : null }), { timeoutMs: 60 * 60_000 });
    this.upgrades.registerJobs();
    if (this.registered) return;
    this.registered = true;
    s.cloud.engine.followUps.push(async ({ deployment, plan, state, run }) => {
      if (!(await this.installed())) return false;
      if (plan.purpose === 'upgrade') return this.upgrades.afterApply(deployment, plan, state, run.onBehalfOf ?? null);
      if (plan.purpose === 'destroy' || !isKubernetes(deployment)) return false;
      const d = await s.cloud.deployments.get(deployment.id);
      if (!d) return false;
      const release = (reapply: boolean) => s.jobs.enqueue({ tenantId: d.tenantId, type: 'cloud.release', payload: { deploymentId: d.id, planId: plan.id, ...(reapply ? { reapply: true } : {}) }, createdBy: run.onBehalfOf ?? null, dedupeKey: `cloud.release:${plan.id}`, maxAttempts: 2 });
      if (state === 'failed') {
        // A front door record whose value is the cluster's load balancer fails while the release (which makes that
        // load balancer) is not up: the release goes first, then the plan is applied again (B-10206 with B-10203).
        if (!(await this.onlyWaitsForAddress(plan.id))) return false;
        await release(true);
        return false;
      }
      if (state !== 'applied') return false;
      // A plan that changed nothing of the cluster, with the release up, needs no new release: verify as usual.
      const clusterSide = plan.steps.some((x) => x.action !== 'noop' && ['kubernetes_cluster', 'node_group', 'load_balancer'].includes(x.type));
      if (!clusterSide && (await this.current(d.id))) return false;
      await release(false);
      return true;
    });
  }

  /** Whether every step of a failed plan that failed is a DNS record waiting for its source's address. */
  private async onlyWaitsForAddress(planId: string): Promise<boolean> {
    const failed = [...(await this.s().cloud.journal.latest(planId)).values()].filter((e) => e.state === 'failed');
    return failed.length > 0 && failed.every((e) => /takes its value from .* reports no address yet/.test(e.error ?? ''));
  }

  // ---------- reads ----------

  async list(p: Principal, deploymentId: string): Promise<ReleaseRecord[]> {
    await this.need();
    await this.s().cloud.deployments.getFor(p, deploymentId);
    return ((await this.s().db('cloud_releases').where({ deployment_id: deploymentId }).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(100)) as Record<string, unknown>[]).map(releaseFrom);
  }

  /** The revision running now (the last one deployed), or null. */
  async current(deploymentId: string): Promise<ReleaseRecord | null> {
    const r = await this.s().db('cloud_releases').where({ deployment_id: deploymentId, state: 'deployed' }).orderBy('created_at', 'desc').orderBy('id', 'desc').first();
    return r ? releaseFrom(r as Record<string, unknown>) : null;
  }

  // ---------- the cluster session ----------

  /** The deployment's spec, parsed (a Kubernetes deployment made from a spec). */
  specOf(d: Deployment): DeploymentSpec {
    const parsed = deploymentSpecSchema.safeParse(d.spec ?? {});
    if (!parsed.success || parsed.data.compute.shape !== 'kubernetes') throw new HttpProblem(409, 'Conflict', `${d.name} is not a Kubernetes deployment made from a deployment spec.`, { extensions: { reason: 'not_kubernetes' } });
    return parsed.data;
  }

  /** Opens a short-lived session on the deployment's cluster (the token is never stored). */
  async session(d: Deployment): Promise<ClusterSession> {
    const s = this.s();
    const c = await s.cloud.deployments.context(d, 'deploy');
    const cluster = (await s.cloud.deployments.resources(d.id)).find((r) => r.type === 'kubernetes_cluster' && r.providerId);
    if (!cluster) throw new HttpProblem(409, 'Conflict', `${d.name} has no cluster yet; apply its plan first.`, { extensions: { reason: 'no_cluster' } });
    const adapter = (await s.cloud.providers.adapter(c.account.provider)) as unknown as CloudProvider & { transport: CloudTransport };
    if (!adapter.kubeAccess) throw new HttpProblem(409, 'Conflict', `${c.account.provider} has no Kubernetes clusters.`, { extensions: { reason: 'not_kubernetes' } });
    const ref: ResourceRef = { type: 'kubernetes_cluster', providerId: cluster.providerId!, region: cluster.region, ...(cluster.locator ? { locator: cluster.locator } : {}) };
    const access = await adapter.kubeAccess(c.ctx(cluster.region), ref, { seconds: this.options.tokenSeconds });
    await this.checkServer(c, access.server);
    return { c, cluster, access, kube: new KubeApi(adapter.transport, access, c.account.id, c.account.provider) };
  }

  /** The API server must be an address a cloud call may reach (`helm` dials it itself, outside the transport). */
  private async checkServer(c: DeploymentContext, server: string): Promise<void> {
    const u = new URL(server);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new CloudProviderError(`The cluster's API server ${u.host} is not an http(s) address.`, c.account.provider, 502, 'egress_refused');
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
    const policy = servicePolicy(this.s().cfg);
    for (const a of addresses) {
      const why = cloudAddressProblem(a, host, policy, CLOUD_PROVIDER_HOSTS[c.account.provider]);
      if (why) throw new CloudProviderError(`The cluster's API server was refused: ${why}`, c.account.provider, 502, 'egress_refused');
    }
    if (u.protocol === 'http:' && !policy.allow.hosts.includes(host) && !policy.allow.networks.check(host, host.includes(':') ? 'ipv6' : 'ipv4')) throw new CloudProviderError(`The cluster's API server ${u.host} is plain http and not named in SERVICE_ALLOWED_HOSTS.`, c.account.provider, 502, 'egress_refused');
  }

  /** Runs `fn` with a private kubeconfig for the session, deleted afterwards. */
  kubeconfig<T>(session: ClusterSession, fn: (path: string) => Promise<T>): Promise<T> {
    return withKubeconfig(session.access, fn, { ...(this.options.onKubeconfig ? { onWrite: this.options.onKubeconfig } : {}) });
  }

  // ---------- secrets ----------

  private vault(): CloudVault {
    return new CloudVault(this.s);
  }

  /** The deployment's own session secret and key-encryption key: made once, kept sealed in the vault. */
  private async ownKeys(d: Deployment): Promise<{ session_secret: string; data_key: string }> {
    const path = `cloud/deployments/${d.id.toLowerCase()}`;
    const v = this.vault();
    try {
      const have = await v.readAll(path);
      if (typeof have.session_secret === 'string' && typeof have.data_key === 'string') return { session_secret: have.session_secret, data_key: have.data_key };
    } catch {
      /* not made yet */
    }
    const keys = { session_secret: randomBytes(32).toString('hex'), data_key: randomBytes(32).toString('base64') };
    await v.write(path, keys);
    return keys;
  }

  /** The Secret's data (values from the vault; nothing here is ever logged or returned). */
  private async secretData(d: Deployment, spec: DeploymentSpec): Promise<{ data: Record<string, string>; redis: boolean }> {
    const s = this.s();
    if (spec.data.mode === 'onprem') throw new HttpProblem(409, 'Conflict', 'An on-prem data tier names its networks but not the database URL; give the deployment an existing data tier (vault: references to the URLs).', { extensions: { reason: 'no_database_ref' } });
    const resolve = (ref: string) => s.vault.resolveFor(d.tenantId, d.createdBy, ref, { via: 'cloud.releases' });
    const keys = await this.ownKeys(d);
    // DATA_KEY only with the local KMS; with the cloud KMS the key never leaves the provider (open decision 8).
    const kek = secretKeysFor(spec);
    const data: Record<string, string> = { session_secret: keys.session_secret, ...(kek.includes('data_key') ? { data_key: keys.data_key } : {}) };
    if (spec.keys && spec.keys.provider !== 'openbao') data[kek[0]!] = await resolve(spec.keys.secretRef);
    if (spec.data.mode === 'provision') {
      // Sprint 59 (B-10302, B-10305): the managed database's URL and CA bundle and the cache's URL, wired once they exist.
      const tier = await s.cloud.dataTier.values(d, { service: 'cloud.releases', onBehalfOf: d.createdBy });
      if (!tier.database_url || !tier.database_ca) throw new HttpProblem(409, 'Conflict', 'The provisioned database is not wired yet.', { extensions: { reason: 'data_tier_not_wired' } });
      data.database_url = tier.database_url;
      data.database_ca = tier.database_ca;
      if (spec.data.cache) {
        if (!tier.redis_url) throw new HttpProblem(409, 'Conflict', 'The provisioned cache is not wired yet.', { extensions: { reason: 'data_tier_not_wired' } });
        data.redis_url = tier.redis_url;
      }
      return { data, redis: !!spec.data.cache };
    }
    data.database_url = await resolve(spec.data.databaseUrlRef);
    if (spec.data.redisUrlRef) data.redis_url = await resolve(spec.data.redisUrlRef);
    return { data, redis: !!spec.data.redisUrlRef };
  }

  // ---------- values ----------

  /** The chart's values for this deployment and image (no secret in them). */
  async valuesFor(d: Deployment, spec: DeploymentSpec, image: { repository: string; digest: string }, redis: boolean): Promise<Record<string, unknown>> {
    const s = this.s();
    if (!isDeployProvider(d.provider)) throw new HttpProblem(409, 'Conflict', `${d.provider} hosts no Kubernetes deployment.`, { extensions: { reason: 'not_kubernetes' } });
    const zones = await s.zones.current().catch(() => new Map());
    const g = renderGraph(spec, { zones, corporateCidrs: s.cfg.ZONES_CORPORATE_CIDRS.split(',').map((x) => x.trim()).filter(Boolean) });
    const account = await s.cloud.accounts.get(d.accountId);
    const rows = await s.cloud.deployments.resources(d.id);
    const edgeSubnetIds = (g.network.placement.edge?.subnets ?? []).map((k) => rows.find((r) => r.key === k)?.providerId).filter((x): x is string => !!x);
    return chartValues({ spec, provider: d.provider, accountName: account?.name ?? 'account', image, placement: g.network.placement, redis, edgeSubnetIds, tlsCertificateId: this.options.tlsCertificateId?.(d) ?? null });
  }

  // ---------- install and upgrade ----------

  /**
   * Installs (or upgrades) the release to an image and records the revision. Used by `cloud.release` after an apply
   * and by an upgrade's rolling update. Throws on failure, after recording a failed revision.
   */
  async deploy(d: Deployment, spec: DeploymentSpec, image: { repository: string; digest: string }, o: { reason: ReleaseReason; upgradeId?: string | null; by: string | null; actor: CloudAuditActor }): Promise<ReleaseRecord> {
    const s = this.s();
    const { data, redis } = await this.secretData(d, spec);
    const values = await this.valuesFor(d, spec, image, redis);
    await this.helm.assertPinned();
    const session = await this.session(d);
    const chart = chartDir();
    let revision = 0;
    let chartVersion = '';
    let error: string | null = null;
    try {
      // The namespace and the Secret first (through the egress guard), then the chart.
      await session.kube.apply({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: RELEASE_NAMESPACE, labels: { 'exprsn.ai/zone': spec.zones.app, 'app.kubernetes.io/managed-by': 'exprsn-ai' } } });
      await session.kube.apply({ apiVersion: 'v1', kind: 'Secret', metadata: { name: RELEASE_SECRET, namespace: RELEASE_NAMESPACE, labels: { 'app.kubernetes.io/managed-by': 'exprsn-ai' } }, type: 'Opaque', data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Buffer.from(v).toString('base64')])) });
      const info = await this.kubeconfig(session, (kubeconfig) => this.helm.upgradeInstall({ chart, release: RELEASE_NAME, namespace: RELEASE_NAMESPACE, values, kubeconfig, timeoutSeconds: this.options.timeoutSeconds }));
      revision = info.revision;
      chartVersion = info.chart ?? '';
    } catch (err) {
      error = String((err as Error).message ?? err).slice(0, 1000);
    }
    const address = error ? null : await this.address(session, d);
    const row: ReleaseRecord = { id: ulid(), deploymentId: d.id, release: RELEASE_NAME, namespace: RELEASE_NAMESPACE, revision, chartVersion: chartVersion || 'unknown', repository: image.repository, digest: image.digest, valuesHash: valuesHash(values), state: error ? 'failed' : 'deployed', reason: o.reason, upgradeId: o.upgradeId ?? null, address, error, createdBy: o.by, createdAt: Date.now() };
    if (!error) await s.db('cloud_releases').where({ deployment_id: d.id, state: 'deployed' }).update({ state: 'superseded' });
    await s.db('cloud_releases').insert({ id: row.id, deployment_id: d.id, tenant_id: d.tenantId, release: row.release, namespace: row.namespace, revision: row.revision, chart_version: row.chartVersion, repository: row.repository, digest: row.digest, values_hash: row.valuesHash, state: row.state, reason: row.reason, upgrade_id: row.upgradeId, address: row.address, error: row.error, created_by: row.createdBy, created_at: row.createdAt });
    await cloudAudit(s, { tenantId: d.tenantId, action: error ? 'cloud.release.failed' : 'cloud.release.deployed', actor: o.actor, deploymentId: d.id, deploymentName: d.name, label: d.label, detail: { release: row.release, revision, reason: o.reason, image: `${image.repository}@${image.digest}`, chart: row.chartVersion, address, ...(o.upgradeId ? { upgrade: o.upgradeId } : {}), ...(error ? { error } : {}) } });
    if (error) throw new HttpProblem(502, 'Bad gateway', `The release of ${d.name} failed: ${error}`, { extensions: { reason: 'release_failed', release: row.id } });
    await this.recordAddress(d, spec, address);
    return row;
  }

  /** The load balancer's address, read from the ingress (or the Service) while the cluster's controller makes it. */
  private async address(session: ClusterSession, d: Deployment): Promise<string | null> {
    const kind = d.provider === 'digitalocean' ? 'service' : 'ingress';
    for (let i = 0; i < this.options.addressPolls; i++) {
      const a = await session.kube.address(RELEASE_NAMESPACE, RELEASE_NAME, kind).catch(() => null);
      if (a) return a;
      await this.options.sleep(this.options.addressWaitMs);
    }
    return null;
  }

  /** The address on the graph's load balancer (its locator) and the deployment's public URL for verify. */
  private async recordAddress(d: Deployment, spec: DeploymentSpec, address: string | null): Promise<void> {
    const s = this.s();
    const lb = await s.cloud.deployments.resource(d.id, 'lb');
    if (lb && address) await s.db('cloud_resources').where({ id: lb.id }).update({ locator: JSON.stringify({ ...(lb.locator ?? {}), address }), updated_at: Date.now() });
    const publicUrl = this.options.publicUrlFor?.(d, address) ?? `https://${spec.frontDoor.hostname}`;
    const endpoints = { ...d.endpoints, publicUrl, tlsName: spec.frontDoor.hostname, app: true, redis: spec.data.mode === 'provision' ? !!spec.data.cache : !!(spec.data.mode === 'existing' && spec.data.redisUrlRef) };
    await s.db('cloud_deployments').where({ id: d.id }).update({ endpoints: JSON.stringify(endpoints), updated_at: Date.now() });
  }

  /** `cloud.release`: the release after an apply, then verify. */
  async install(deploymentId: string, run: { jobId: string; onBehalfOf?: string | null; reapplyPlan?: string | null }): Promise<Record<string, unknown>> {
    const s = this.s();
    const d = await s.cloud.deployments.get(deploymentId);
    if (!d) return { skipped: 'no such deployment' };
    const actor: CloudAuditActor = { service: 'cloud.release', onBehalfOf: run.onBehalfOf ?? null, jobId: run.jobId };
    const verify = () => s.jobs.enqueue({ tenantId: d.tenantId, type: 'cloud.verify', payload: { deploymentId: d.id }, createdBy: run.onBehalfOf ?? null, dedupeKey: `cloud.verify:release:${run.jobId}`, maxAttempts: 2 });
    let spec: DeploymentSpec;
    try {
      spec = this.specOf(d);
    } catch (err) {
      await verify();
      return { skipped: (err as Error).message };
    }
    const current = await this.current(d.id);
    const imageRef = current ? `${current.repository}@${current.digest}` : spec.release?.image;
    if (!imageRef) {
      await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.release.failed', actor, deploymentId: d.id, deploymentName: d.name, label: d.label, detail: { error: 'The spec names no image (release.image, by digest).' } });
      await s.cloud.deployments.setState(d.id, 'failed');
      return { state: 'failed', error: 'no image' };
    }
    try {
      const row = await this.deploy(d, spec, splitImage(imageRef), { reason: current ? 'upgrade' : 'install', by: run.onBehalfOf ?? null, actor });
      if (run.reapplyPlan && (await this.reapply(d, run.reapplyPlan, run.onBehalfOf ?? null))) return { state: 'deployed', release: row.id, revision: row.revision, address: row.address, reapplied: true };
      await verify();
      return { state: 'deployed', release: row.id, revision: row.revision, address: row.address };
    } catch (err) {
      if (err instanceof CloudProviderError && (err.status === 429 || err.status >= 500) && err.code !== 'egress_refused') throw err;
      await s.cloud.deployments.setState(d.id, 'failed');
      return { state: 'failed', error: String((err as Error).message ?? err).slice(0, 500) };
    }
  }

  /** The plan that waited for the load balancer's address, made again and applied as the person who applied it. */
  private async reapply(d: Deployment, planId: string, userId: string | null): Promise<boolean> {
    const s = this.s();
    const failed = await s.cloud.plans.load(planId);
    if (!failed || !userId) return false;
    const p = await loadPrincipal(s, d.tenantId, userId, {});
    if (!p) return false;
    const actor = { principal: p, ip: null };
    const plan = await s.cloud.plans.create(actor, d.id, failed.desired, { purpose: failed.purpose });
    if (!plan.applicable) return false;
    await s.cloud.plans.apply(actor, plan.id, plan.hash);
    return true;
  }

  /** Back to an earlier revision of the release (an upgrade whose verify failed), recorded as its own revision. */
  async rollbackTo(d: Deployment, to: ReleaseRecord, o: { upgradeId: string | null; by: string | null; actor: CloudAuditActor }): Promise<ReleaseRecord> {
    const s = this.s();
    const session = await this.session(d);
    await this.kubeconfig(session, (kubeconfig) => this.helm.rollback({ release: RELEASE_NAME, namespace: RELEASE_NAMESPACE, revision: to.revision, kubeconfig, timeoutSeconds: this.options.timeoutSeconds }));
    const history = await this.kubeconfig(session, (kubeconfig) => this.helm.history({ release: RELEASE_NAME, namespace: RELEASE_NAMESPACE, kubeconfig })).catch(() => []);
    const revision = history.length ? history[history.length - 1]!.revision : to.revision + 1;
    await s.db('cloud_releases').where({ deployment_id: d.id, state: 'deployed' }).update({ state: 'rolled_back' });
    const row: ReleaseRecord = { ...to, id: ulid(), revision, state: 'deployed', reason: 'rollback', upgradeId: o.upgradeId, error: null, createdBy: o.by, createdAt: Date.now() };
    await s.db('cloud_releases').insert({ id: row.id, deployment_id: d.id, tenant_id: d.tenantId, release: row.release, namespace: row.namespace, revision: row.revision, chart_version: row.chartVersion, repository: row.repository, digest: row.digest, values_hash: row.valuesHash, state: 'deployed', reason: 'rollback', upgrade_id: row.upgradeId, address: row.address, error: null, created_by: row.createdBy, created_at: row.createdAt });
    await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.release.rolled_back', actor: o.actor, deploymentId: d.id, deploymentName: d.name, label: d.label, detail: { release: row.release, revision, toRevision: to.revision, image: `${to.repository}@${to.digest}`, ...(o.upgradeId ? { upgrade: o.upgradeId } : {}) } });
    return row;
  }
}

/** A deployment rendered from a spec with the Kubernetes shape. */
export function isKubernetes(d: Pick<Deployment, 'spec'>): boolean {
  return (d.spec as { compute?: { shape?: string } } | null)?.compute?.shape === 'kubernetes';
}
