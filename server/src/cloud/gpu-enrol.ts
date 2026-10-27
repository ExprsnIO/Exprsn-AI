import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, X509Certificate } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { ulid } from 'ulid';
import { z } from 'zod';
import { HttpProblem } from '../http/problem.js';
import type { Scheduler } from '../platform/jobs.js';
import { fromPem } from '../pki/asn1.js';
import type { PkiActor, ProfileRow } from '../pki/service.js';
import { parseCsr, spkiOf } from '../pki/x509.js';
import type { Services } from '../services.js';
import type { TlsMaterial } from '../gateway/ollama.js';
import type { InstanceRow } from '../gateway/repo.js';
import { cloudAudit } from './audit.js';
import { providerName } from './deployments.js';
import type { Deployment, GraphResource } from './graph.js';
import { ENROL_PATH, ENROL_SECRET, GPU_NAMESPACE, gpuDaemonSet, mirrorHost, mirrorRef, mirrorRefProblem, NODE_TLS_PORT, type EnrolPayload } from './gpu-node.js';
import { linkFrom, type CloudGpuPools, type GpuPoolLink } from './gpu-pools.js';
import { deploymentSpecSchema, PROVIDER_SKUS, type DeploymentSpec } from './spec.js';

/*
 * 1.9.99-final, Sprint 60 (B-10401, B-10404): the node side of GPU pools, `s.cloud.gpuPools.nodes`.
 *
 * Links. After an apply of a deployment with GPU pools succeeds, `ensureLinks` makes (once) per pool: the gateway
 * pool its nodes join (`<deployment>-<pool>`, accelerator cuda, the inference zone, the deployment's label as the
 * ceiling), the link row, the two PKI profiles of the deployment (`gpu-nodes-<deployment>`: server certificates for IP
 * names inside the deployment's network range; `gpu-gateway-<deployment>`: the gateway's client certificate, a
 * `exprsn-gpu://` URI name), and the gateway's client identity for the pool (a P-256 key made here, sealed with the
 * tenant key under `cloud-gpu-client:<link id>`, loaded into memory for the gateway's `tlsResolver`). Without an
 * active intermediate in the tenant's CA the link is `pki_missing` and no node can enrol until one exists.
 *
 * Enrolment. A single-use token (`exe1_` + 32 random bytes, only its SHA-256 kept, 30 minutes) is minted for each GPU
 * VM at create time (the secret broker's `enrol`, into the user data) and for each node of a node group by the
 * reconcile job (into the Secret `exprsn-enrol`, bound to the node's name and private address). The node exchanges it
 * once (`POST /cloud/gpu/v1/enrol`, outside `/api`: the token is the credential) with a CSR for its own key: the token
 * is spent in one conditional update (used, expired, unknown and replayed tokens are refused and audited), the address
 * must be the bound one and inside the deployment's network, and the server certificate names exactly that address.
 * The instance is registered in the pool (`deploy: cloud`, `https://<address>:11435`, `tls.identity` the pool's
 * client identity, `tls.pinSha256` the node's certificate), and the answer carries the CA chain, the gateway client
 * certificate's SHA-1 (nginx pins it) and the warm-up list.
 *
 * Warm-up (B-10404). The pool's approved placements, each as a reference on the model mirror (Platform › Mirrors,
 * kind `models`); a reference not on the mirror is never listed (`mirrorRefProblem`), and the node's egress guard
 * refuses it too. Boot to healthy: a row per node in `cloud_gpu_boot_timings` (booted: the node's own boot time,
 * clamped to the token's life; enrolled; healthy: when the gateway first sees the instance healthy with every
 * approved placement listed), read per node group by `timings`.
 */

const TOKEN_TTL_MS = 30 * 60_000;
const TOKEN_RE = /^exe1_[A-Za-z0-9_-]{43}$/;
const tokenHash = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
const GIB = 1024 ** 3;
const GPU_MEMORY: Record<string, number> = { l4: 24 * GIB, a10: 24 * GIB, h100: 80 * GIB };

export const enrolSchema = z
  .object({
    token: z.string().max(200),
    csr: z.string().min(100).max(8000),
    address: z.string().refine((a) => isIP(a) === 4, 'an IPv4 address'),
    node: z.string().trim().max(253).regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/, 'a node name').optional(),
    bootedAt: z.number().int().positive().optional(),
    /** The node's mTLS port (default 11435); a node with one Ollama per GPU enrols each on its own port. */
    port: z.number().int().min(1024).max(65535).optional()
  })
  .strict();
export type EnrolInput = z.infer<typeof enrolSchema>;

export type EnrolRefusal = 'unknown' | 'expired' | 'replayed' | 'node_mismatch' | 'address_mismatch' | 'address_outside' | 'link_unavailable' | 'bad_csr';

export class EnrolRefused extends HttpProblem {
  constructor(readonly why: EnrolRefusal, detail: string) {
    super(why === 'link_unavailable' ? 409 : why === 'bad_csr' ? 400 : 401, 'Enrolment refused', detail, { extensions: { reason: 'enrolment_refused', why } });
  }
}

export interface EnrolResponse {
  instance: { id: string; name: string; url: string };
  certificate: string;
  chain: string[];
  gateway: { caChain: string[]; clientSha1: string; clientSha256: string };
  warmup: { source: 'mirror' | 'snapshot'; mirror: string | null; models: { name: string; ref: string; digest: string | null }[]; problem?: string };
}

export interface BootTiming {
  node: string | null;
  instanceId: string;
  source: string;
  bootedAt: number;
  enrolledAt: number;
  healthyAt: number | null;
  seconds: number | null;
}

interface KubeNode {
  metadata: { name: string; creationTimestamp?: string; labels?: Record<string, string> };
  status?: { addresses?: { type: string; address: string }[] };
}

const inCidr = (addr: string, cidr: string): boolean => {
  const [net, len] = cidr.split('/');
  if (!net || isIP(net) !== 4) return false;
  const b = new BlockList();
  b.addSubnet(net, Number(len), 'ipv4');
  return b.check(addr, 'ipv4');
};

const instanceName = (d: Deployment, pool: string, node: string) => `${d.name}-${pool}-${node}`.toLowerCase().replace(/[^a-z0-9./-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 100);

export class GpuPoolNodes {
  /** Client identities by `gpu-pool:<link id>` (this server's memory only; the sealed key is in the link row). */
  private readonly material = new Map<string, TlsMaterial>();
  private registered = false;
  options = { tokenTtlMs: TOKEN_TTL_MS, now: () => Date.now(), enrolBase: null as string | null };

  constructor(
    private readonly s: () => Services,
    private readonly pools: CloudGpuPools
  ) {}

  private get db() {
    return this.s().db;
  }

  private by(tenantId: string): PkiActor {
    return { tenantId, userId: null, actor: { service: 'cloud.gpu' } };
  }

  /** The enrolment URL a node is given (this server's public URL). */
  enrolUrl(): string {
    return `${(this.options.enrolBase ?? this.s().cfg.PUBLIC_URL).replace(/\/$/, '')}${ENROL_PATH}`;
  }

  // ---------- the gateway's client identities ----------

  /** For `Gateway.tlsResolver`: the identity's material, when loaded on this server. */
  tlsMaterial(identity: string): TlsMaterial | null {
    const m = this.material.get(identity);
    if (m) return m;
    // Made on another server: loaded from the sealed row (at most every 10 s); the gateway rebuilds the client then.
    const now = Date.now();
    if (now - this.lastLoad > 10_000) {
      this.lastLoad = now;
      void this.loadIdentities().catch(() => undefined);
    }
    return null;
  }
  private lastLoad = 0;

  /** Loads every live link's client identity (at start, and by the reconcile job on other instances). */
  async loadIdentities(): Promise<number> {
    if (!(await this.pools.installed())) return 0;
    const rows = (await this.db('cloud_gpu_pool_links').whereNot({ state: 'removed' }).whereNotNull('client_key_sealed')) as Record<string, unknown>[];
    for (const r of rows) {
      const id = `gpu-pool:${String(r.id)}`;
      if (this.material.has(id)) continue;
      try {
        await this.loadIdentity(linkFrom(r), String(r.client_key_sealed));
      } catch (err) {
        this.s().log.warn({ link: r.id, err: (err as Error).message }, 'GPU pool client identity could not be loaded');
      }
    }
    return this.material.size;
  }

  private async loadIdentity(link: GpuPoolLink, sealed: string): Promise<void> {
    const pki = this.s().pki;
    const cert = link.clientCertId ? await pki.certificate(link.tenantId, link.clientCertId) : undefined;
    if (!cert) return;
    const der = await this.s().keys.openBytes(link.tenantId, sealed, `cloud-gpu-client:${link.id}`);
    const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }).export({ type: 'pkcs8', format: 'pem' }).toString();
    const chain = await pki.chainOf(cert);
    this.material.set(`gpu-pool:${link.id}`, { ca: chain.join(''), cert: cert.certificate_pem, key });
  }

  // ---------- links ----------

  /** The deployment's spec, parsed, or null (no spec, or no GPU pools). */
  specOf(d: Deployment): DeploymentSpec | null {
    const parsed = deploymentSpecSchema.safeParse(d.spec ?? {});
    return parsed.success && parsed.data.gpuPools.length && parsed.data.compute.shape !== 'container' ? parsed.data : null;
  }

  /** Makes (or brings up to date) the links, gateway pools, profiles and client identities of a deployment's GPU pools. */
  async ensureLinks(d: Deployment, onBehalfOf: string | null): Promise<GpuPoolLink[]> {
    const spec = this.specOf(d);
    if (!spec || !(await this.pools.installed())) return [];
    const s = this.s();
    const resources = await s.cloud.deployments.resources(d.id);
    const out: GpuPoolLink[] = [];
    const now = this.options.now();
    const pki = await this.pkiFor(d, spec);
    for (const g of spec.gpuPools) {
      const sku = PROVIDER_SKUS[spec.target.provider].gpu[g.gpu];
      if (!sku) continue;
      const kind = spec.compute.shape === 'kubernetes' ? 'node_group' : 'vm';
      const key = kind === 'node_group' ? `gpu-${g.name}` : `gpu-${g.name}-`;
      const row = resources.find((r) => (kind === 'node_group' ? r.key === key : r.key.startsWith(key)) && r.type === kind);
      const observedSize = row?.observed?.props?.size;
      const instanceType = typeof observedSize === 'string' && observedSize ? observedSize : sku.sku;
      const skuKey = `${spec.target.provider === 'aws' ? 'ec2' : spec.target.provider === 'azure' ? 'vm' : 'droplet'}:${instanceType}`;
      const price = await s.cloud.prices?.lookup(spec.target.provider, spec.target.region, skuKey, 'hour', { account: null, currency: 'USD', fetch: false }).catch(() => null);
      const existing = (await this.db('cloud_gpu_pool_links').where({ deployment_id: d.id, pool_name: g.name }).first()) as Record<string, unknown> | undefined;
      let poolId = (existing?.gateway_pool_id as string | null) ?? null;
      if (!poolId) {
        const name = `${d.name}-${g.name}`.slice(0, 63);
        const pool = (await s.gateway.repo.pools()).find((p) => p.name === name) ?? (await s.gateway.repo.createPool({ name, description: `Cloud GPU pool ${g.name} of ${d.name} (${spec.target.provider} ${sku.sku})`, accelerator: 'cuda', zone: spec.zones.inference, labelCeiling: d.label }));
        poolId = pool.id;
      }
      const base = {
        provider: spec.target.provider,
        resource_key: kind === 'node_group' ? key : key,
        kind,
        provider_id: kind === 'node_group' ? (row?.providerId ?? null) : null,
        gateway_pool_id: poolId,
        gpu: g.gpu,
        instance_type: instanceType,
        instance_types: JSON.stringify([...new Set([sku.sku, ...g.fallbackTypes])]),
        zones: JSON.stringify(g.zones),
        min_nodes: g.min,
        max_nodes: g.max,
        price_hourly: price ? Number(price.price) : null,
        currency: price ? price.currency : null,
        server_profile_id: pki?.server.id ?? null,
        client_profile_id: pki?.client.id ?? null,
        warmup: JSON.stringify(g.warmup),
        state: pki ? 'active' : 'pki_missing',
        state_detail: pki ? null : `The tenant has no active intermediate in its certificate authority; the nodes of ${g.name} cannot enrol until one exists (Certificates).`,
        updated_at: now
      };
      let id: string;
      if (existing) {
        id = String(existing.id);
        await this.db('cloud_gpu_pool_links').where({ id }).update(base);
      } else {
        id = ulid();
        await this.db('cloud_gpu_pool_links').insert({ id, tenant_id: d.tenantId, deployment_id: d.id, pool_name: g.name, desired_nodes: null, client_cert_id: null, client_key_sealed: null, created_at: now, ...base });
        await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.gpu.pool.linked', actor: { service: 'cloud.gpu', onBehalfOf }, deploymentId: d.id, deploymentName: d.name, resource: { key, type: kind, providerId: base.provider_id }, label: d.label, detail: { pool: g.name, gatewayPool: poolId, instanceType, min: g.min, max: g.max, warmup: g.warmup.source, priceHourly: base.price_hourly } });
      }
      let link = (await this.pools.get(id))!;
      if (pki && !link.clientCertId) link = await this.makeClientIdentity(d, link, pki.client);
      out.push(link);
    }
    return out;
  }

  /** The deployment's node and gateway profiles under the tenant's active intermediate (made once), or null. */
  private async pkiFor(d: Deployment, spec: DeploymentSpec): Promise<{ server: ProfileRow; client: ProfileRow } | null> {
    const pki = this.s().pki;
    const issuer = await pki.activeIntermediate(d.tenantId);
    if (!issuer) return null;
    const by = this.by(d.tenantId);
    const have = await pki.profiles(d.tenantId);
    const named = (n: string) => have.find((p) => p.name === n);
    // B-10403: node certificates carry clientAuth too, so the node's spot watcher posts its interruption notices with it.
    let server = named(`gpu-nodes-${d.name}`) ?? (await pki.createProfile(by, { name: `gpu-nodes-${d.name}`, kind: 'server', policy: { domains: [], allowWildcard: false, ipRanges: [spec.network.cidr], emailDomains: [], uriPrefixes: [], keyTypes: ['ec-p256', 'ec-p384'], clientAuth: true }, maxDays: 90, defaultDays: 30 }));
    if (!server.policy.clientAuth) server = await pki.updateProfile(by, server, { policy: { ...server.policy, clientAuth: true } });
    const client = named(`gpu-gateway-${d.name}`) ?? (await pki.createProfile(by, { name: `gpu-gateway-${d.name}`, kind: 'client', policy: { domains: [], allowWildcard: false, ipRanges: [], emailDomains: [], uriPrefixes: ['exprsn-gpu://gateway/'], keyTypes: ['ec-p256'] }, maxDays: 398, defaultDays: 90 }));
    return { server, client };
  }

  private async makeClientIdentity(d: Deployment, link: GpuPoolLink, profile: ProfileRow): Promise<GpuPoolLink> {
    const s = this.s();
    const issuer = await s.pki.activeIntermediate(d.tenantId);
    if (!issuer) return link;
    const kp = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const out = await s.pki.issueKey(this.by(d.tenantId), issuer, profile, { spki: spkiOf(kp.publicKey), keyType: 'ec-p256', commonName: `gateway-${d.name}-${link.poolName}`.slice(0, 64), sans: [{ type: 'uri', value: `exprsn-gpu://gateway/${d.name}/${link.poolName}` }], keyGenerated: true });
    const sealed = await s.keys.sealBytes(d.tenantId, kp.privateKey.export({ type: 'pkcs8', format: 'der' }), `cloud-gpu-client:${link.id}`);
    await this.db('cloud_gpu_pool_links').where({ id: link.id }).update({ client_cert_id: out.cert.id, client_key_sealed: sealed, updated_at: this.options.now() });
    this.material.set(`gpu-pool:${link.id}`, { ca: out.chain.join(''), cert: out.cert.certificate_pem, key: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
    return (await this.pools.get(link.id))!;
  }

  // ---------- tokens ----------

  /** A single-use enrolment token for a link (bound to a node name and address when given); shown once. */
  async mint(link: GpuPoolLink, o: { node?: string | null; address?: string | null; createdBy?: string | null } = {}): Promise<EnrolPayload> {
    const token = `exe1_${randomBytes(32).toString('base64url')}`;
    const now = this.options.now();
    const expiresAt = now + this.options.tokenTtlMs;
    await this.db('cloud_gpu_enrolments').insert({ id: ulid(), link_id: link.id, token_hash: tokenHash(token), node: o.node ?? null, address: o.address ?? null, expires_at: expiresAt, used_at: null, instance_id: null, certificate_id: null, created_by: o.createdBy ?? null, created_at: now });
    return { token, url: this.enrolUrl(), mirror: await this.mirrorHostFor(link), expiresAt };
  }

  /** The secret broker's hook: a token for one GPU VM of a deployment's pool (null: no link yet, no migration). */
  async enrolForVm(d: Deployment, pool: string, key: string): Promise<EnrolPayload | null> {
    if (!(await this.pools.installed())) return null;
    let link = (await this.pools.nodeGroupsFor(d.id)).find((l) => l.poolName === pool) ?? null;
    // The VMs are created in the same apply that makes the deployment: the link is made now, before the first VM boots.
    if (!link) link = (await this.ensureLinks(d, d.createdBy)).find((l) => l.poolName === pool) ?? null;
    if (!link || link.state !== 'active') return null;
    return this.mint(link, { node: key });
  }

  private async mirrorHostFor(_link: GpuPoolLink): Promise<string | null> {
    const mirrors = await this.s().ops.mirrors.byKind('models').catch(() => []);
    return mirrorHost(mirrors[0]?.url ?? null);
  }

  // ---------- enrolment ----------

  private async refuse(link: GpuPoolLink | null, why: EnrolRefusal, detail: string, ip: string | null, extra: Record<string, unknown> = {}): Promise<never> {
    if (link) {
      const d = await this.s().cloud.deployments.get(link.deploymentId).catch(() => null);
      await cloudAudit(this.s(), { tenantId: link.tenantId, action: 'cloud.gpu.node.refused', actor: { service: 'cloud.gpu' }, deploymentId: link.deploymentId, deploymentName: d?.name ?? null, detail: { pool: link.poolName, why, ip, ...extra } }).catch(() => undefined);
    }
    throw new EnrolRefused(why, detail);
  }

  /** A node exchanges its single-use token and CSR for its certificate and joins its pool. */
  async enrol(input: EnrolInput, ip: string | null): Promise<EnrolResponse> {
    await this.pools.need();
    const s = this.s();
    const now = this.options.now();
    if (!TOKEN_RE.test(input.token)) throw new EnrolRefused('unknown', 'The enrolment token is not one this server issued.');
    const hash = tokenHash(input.token);
    // Spent in one conditional update: two nodes presenting the same token cannot both succeed.
    // B-10803: the token's node and address bindings are part of the update, so a token presented for another node
    // (by any pod that can read the enrolment Secret) is refused without being spent.
    const spent = await this.db('cloud_gpu_enrolments')
      .where({ token_hash: hash })
      .whereNull('used_at')
      .andWhere('expires_at', '>', now)
      .andWhere((q) => void q.whereNull('node').orWhere('node', input.node ?? ''))
      .andWhere((q) => void q.whereNull('address').orWhere('address', input.address))
      .update({ used_at: now });
    const row = (await this.db('cloud_gpu_enrolments').where({ token_hash: hash }).first()) as Record<string, unknown> | undefined;
    const link = row ? await this.pools.get(String(row.link_id)) : null;
    if (!row) throw new EnrolRefused('unknown', 'The enrolment token is not one this server issued.');
    if (!spent) {
      if (row.used_at == null && Number(row.expires_at) > now && row.node != null && input.node !== row.node) return this.refuse(link, 'node_mismatch', 'The token belongs to another node.', ip, { node: input.node ?? null });
      if (row.used_at == null && Number(row.expires_at) > now && row.address != null && input.address !== row.address) return this.refuse(link, 'address_mismatch', 'The token belongs to another address.', ip, { address: input.address });
      if (row.used_at != null) return this.refuse(link, 'replayed', 'The enrolment token was used already; each token enrols one node once.', ip, { node: input.node ?? null });
      return this.refuse(link, 'expired', 'The enrolment token expired; the node gets a new one from the next reconcile, or mint one.', ip, { node: input.node ?? null });
    }
    if (!link || link.state !== 'active' || !link.gatewayPoolId || !link.serverProfileId) return this.refuse(link, 'link_unavailable', `The GPU pool is ${link?.state ?? 'gone'}${link?.stateDetail ? `: ${link.stateDetail}` : ''}.`, ip);
    if (row.node != null && input.node !== row.node) return this.refuse(link, 'node_mismatch', 'The token belongs to another node.', ip, { node: input.node ?? null });
    if (row.address != null && input.address !== row.address) return this.refuse(link, 'address_mismatch', 'The token belongs to another address.', ip, { address: input.address });
    const d = await s.cloud.deployments.get(link.deploymentId);
    const spec = d ? this.specOf(d) : null;
    if (!d || !spec) return this.refuse(link, 'link_unavailable', 'The deployment of this GPU pool is gone.', ip);
    if (!inCidr(input.address, spec.network.cidr)) return this.refuse(link, 'address_outside', `${input.address} is outside the deployment's network ${spec.network.cidr}.`, ip, { address: input.address });

    let csr;
    try {
      csr = parseCsr(fromPem(input.csr, 'CERTIFICATE REQUEST', 'NEW CERTIFICATE REQUEST'));
    } catch (err) {
      return this.refuse(link, 'bad_csr', `The CSR could not be read: ${(err as Error).message}`, ip);
    }
    // B-10803: a token bound to no node may not take over an instance another node enrolled at another address (it
    // would redirect that node's traffic and replace its pin); a bound token re-enrolling its own node may.
    if (row.node == null) {
      const n = input.node ?? input.address.replace(/\./g, '-');
      const nm = instanceName(d, link.poolName, (input.port ?? NODE_TLS_PORT) === NODE_TLS_PORT ? n : `${n}-${input.port}`);
      const taken = (await s.gateway.repo.instances(link.gatewayPoolId)).find((i) => i.name === nm);
      if (taken && taken.url !== `https://${input.address}:${input.port ?? NODE_TLS_PORT}`) return this.refuse(link, 'node_mismatch', `${nm} is another node's instance; an unbound token cannot take it over.`, ip, { node: input.node ?? null, address: input.address });
    }
    const issuer = await s.pki.activeIntermediate(link.tenantId);
    const profile = issuer ? await s.pki.issuableProfile(this.by(link.tenantId), issuer, link.serverProfileId) : null;
    if (!issuer || !profile) return this.refuse(link, 'link_unavailable', 'The tenant has no active intermediate.', ip);
    const issued = await s.pki.issueKey(this.by(link.tenantId), issuer, profile, { spki: csr.spki, keyType: csr.keyType, commonName: input.address, sans: [{ type: 'ip', value: input.address }] });

    // The instance: registered by the node itself, trusted by the certificate it just got.
    const node = input.node ?? (row.node as string | null) ?? input.address.replace(/\./g, '-');
    const port = input.port ?? NODE_TLS_PORT;
    const name = instanceName(d, link.poolName, port === NODE_TLS_PORT ? node : `${node}-${port}`);
    const url = `https://${input.address}:${port}`;
    const gpus = PROVIDER_SKUS[spec.target.provider].gpu[link.gpu as 'l4']?.gpus ?? 1;
    const tls = { identity: `gpu-pool:${link.id}`, pinSha256: issued.cert.fingerprint };
    const settings = { memoryBytes: (GPU_MEMORY[link.gpu] ?? 24 * GIB) * gpus, hardware: `${gpus}× ${link.gpu.toUpperCase()} (${link.instanceType})`, node, parallel: 4, maxLoaded: 2, keepAlive: '30m' };
    const g = s.gateway.repo;
    const before = (await g.instances(link.gatewayPoolId)).find((i) => i.name === name);
    let inst: InstanceRow;
    if (before) {
      await g.updateInstance(before.id, { url, tls, settings: { ...before.settings, ...settings }, state: 'active', health: 'unknown', health_detail: null });
      inst = (await g.instance(before.id))!;
    } else inst = await g.createInstance({ poolId: link.gatewayPoolId, name, url, deploy: 'cloud', tls, settings });
    await this.db('cloud_gpu_enrolments').where({ id: row.id }).update({ instance_id: inst.id, certificate_id: issued.cert.id });

    // Boot to healthy: the node's own boot time, never before its token was minted (less an hour of clock skew) or after now.
    const minted = Number(row.created_at);
    const bootedAt = Math.min(now, Math.max(minted - 3_600_000, input.bootedAt ?? minted));
    await this.db('cloud_gpu_boot_timings').where({ instance_id: inst.id }).delete();
    await this.db('cloud_gpu_boot_timings').insert({ id: ulid(), link_id: link.id, instance_id: inst.id, node, source: link.warmup.source, booted_at: bootedAt, enrolled_at: now, healthy_at: null, seconds: null });
    await cloudAudit(s, { tenantId: link.tenantId, action: 'cloud.gpu.node.enrolled', actor: { service: 'cloud.gpu' }, deploymentId: d.id, deploymentName: d.name, resource: { key: link.resourceKey, type: link.kind, providerId: link.providerId }, label: d.label, detail: { pool: link.poolName, instance: inst.id, name, address: input.address, node, certificate: issued.cert.id, serial: issued.cert.serial, fingerprint: issued.cert.fingerprint, ip, replaced: !!before } });

    const clientCert = link.clientCertId ? await s.pki.certificate(link.tenantId, link.clientCertId) : undefined;
    if (!clientCert) return this.refuse(link, 'link_unavailable', 'The pool has no gateway client certificate yet.', ip);
    const x = new X509Certificate(clientCert.certificate_pem);
    const caChain = await s.pki.chainOf(clientCert);
    void s.gateway.pollOne(inst.id).catch(() => undefined);
    return {
      instance: { id: inst.id, name, url },
      certificate: issued.cert.certificate_pem,
      chain: issued.chain,
      gateway: { caChain, clientSha1: x.fingerprint.replace(/:/g, '').toLowerCase(), clientSha256: x.fingerprint256.replace(/:/g, '').toLowerCase() },
      warmup: await this.warmup(link)
    };
  }

  /** B-10404: the pool's approved placements as references on the model mirror; nothing outside it is ever listed. */
  async warmup(link: GpuPoolLink): Promise<EnrolResponse['warmup']> {
    const s = this.s();
    const host = await this.mirrorHostFor(link);
    const g = s.gateway.repo;
    const placements = (await g.placements()).filter((p) => p.pool_id === link.gatewayPoolId);
    const models: EnrolResponse['warmup']['models'] = [];
    const refused: string[] = [];
    for (const p of placements) {
      const m = await g.model(p.model_id);
      if (!m || m.state !== 'approved' || m.format === 'server') continue;
      const ref = host ? mirrorRef(host, m.name) : m.name;
      const problem = mirrorRefProblem(host, ref);
      if (problem) refused.push(problem);
      else models.push({ name: m.name, ref, digest: m.digest ?? m.expected_digest ?? null });
    }
    return { source: link.warmup.source, mirror: host, models, ...(refused.length ? { problem: refused.slice(0, 5).join('; ') } : {}) };
  }

  // ---------- reconcile: node groups' tokens and DaemonSet, timings ----------

  registerJobs(): void {
    const s = this.s();
    s.jobs.register('cloud.gpu.reconcile', async (p) => this.reconcileAll(p.deploymentId ? String(p.deploymentId) : null), { timeoutMs: 10 * 60_000 });
    if (this.registered) return;
    this.registered = true;
    s.cloud.engine.followUps.push(async ({ deployment, plan, state, run }) => {
      if (state !== 'applied' || plan.purpose === 'destroy' || !this.specOf(deployment) || !(await this.pools.installed())) return false;
      await this.ensureLinks(deployment, run.onBehalfOf ?? null);
      await s.jobs.enqueue({ tenantId: deployment.tenantId, type: 'cloud.gpu.reconcile', payload: { deploymentId: deployment.id }, createdBy: run.onBehalfOf ?? null, dedupeKey: `cloud.gpu.reconcile:${plan.id}`, maxAttempts: 3 });
      return false; // verify (or the release) runs as before
    });
  }

  schedule(scheduler: Scheduler): void {
    // One job a minute while any link exists (claimed once across instances by the scheduler); none otherwise.
    scheduler.every('cloud.gpu.reconcile', 60_000, async () => {
      if (!(await this.pools.installed())) return [];
      const any = (await this.db('cloud_gpu_pool_links').whereNot({ state: 'removed' }).first('tenant_id')) as { tenant_id: string } | undefined;
      return any ? [{ tenantId: any.tenant_id, payload: {}, key: 'all' }] : [];
    });
  }

  async reconcileAll(deploymentId: string | null): Promise<{ links: number; minted: number; healthy: number }> {
    await this.loadIdentities();
    const links = deploymentId ? await this.pools.nodeGroupsFor(deploymentId) : await this.pools.all();
    let minted = 0;
    for (const l of links) {
      if (l.kind !== 'node_group' || l.state !== 'active') continue;
      try {
        minted += await this.reconcileNodeGroup(l);
      } catch (err) {
        await this.db('cloud_gpu_pool_links').where({ id: l.id }).update({ state_detail: `Reconcile failed: ${(err as Error).message}`.slice(0, 500), updated_at: this.options.now() });
      }
    }
    const healthy = await this.observe();
    return { links: links.length, minted, healthy };
  }

  /** One node group: the DaemonSet, and a live token for every node that has not enrolled. Returns the tokens minted. */
  async reconcileNodeGroup(link: GpuPoolLink): Promise<number> {
    const s = this.s();
    const d = await s.cloud.deployments.get(link.deploymentId);
    const spec = d ? this.specOf(d) : null;
    if (!d || !spec) return 0;
    const pool = spec.gpuPools.find((g) => g.name === link.poolName);
    const res = (await s.cloud.deployments.resources(d.id)).find((r) => r.key === link.resourceKey) as GraphResource | undefined;
    if (!pool || !res?.providerId) return 0;
    if (res.providerId !== link.providerId) await this.db('cloud_gpu_pool_links').where({ id: link.id }).update({ provider_id: res.providerId, updated_at: this.options.now() });
    const session = await s.cloud.releases.session(d);
    const kube = session.kube;
    const groupName = providerName(d, res.desired);
    const sku = PROVIDER_SKUS[spec.target.provider].gpu[pool.gpu];
    let detail: string | null = null;
    if (pool.images) for (const o of gpuDaemonSet({ deployment: d.name, pool: pool.name, warmup: pool.warmup, nodeGroup: groupName, gpus: sku?.gpus ?? 1, images: pool.images })) await kube.apply(o);
    else detail = 'The node group has no DaemonSet images (gpuPools[].images: the Ollama and proxy images by digest); its nodes cannot bootstrap.';
    const list = await kube.get<{ items?: KubeNode[] }>(`/api/v1/nodes?labelSelector=${encodeURIComponent(`exprsn.ai/node-group=${groupName}`)}`);
    const nodes = list?.items ?? [];
    const now = this.options.now();
    const enrolled = new Set(((await this.db('cloud_gpu_enrolments').where({ link_id: link.id }).whereNotNull('instance_id').select('node')) as { node: string | null }[]).map((r) => r.node));
    // What the Secret holds now: an entry whose token is still live is kept (tokens cannot be shown twice).
    const secretPath = `/api/v1/namespaces/${GPU_NAMESPACE}/secrets/${ENROL_SECRET}`;
    const current = await kube.get<{ data?: Record<string, string>; stringData?: Record<string, string> }>(secretPath);
    const entries = new Map<string, string>(Object.entries(current?.stringData ?? {}));
    for (const [k, v] of Object.entries(current?.data ?? {})) entries.set(k, Buffer.from(v, 'base64').toString('utf8'));
    const next: Record<string, string> = {};
    let minted = 0;
    for (const n of nodes) {
      const name = n.metadata.name;
      if (enrolled.has(name)) continue;
      const address = n.status?.addresses?.find((a) => a.type === 'InternalIP')?.address ?? null;
      const had = entries.get(name);
      if (had) {
        try {
          const t = (JSON.parse(had) as { token?: string }).token ?? '';
          const live = await this.db('cloud_gpu_enrolments').where({ token_hash: tokenHash(t), link_id: link.id }).whereNull('used_at').andWhere('expires_at', '>', now + 5 * 60_000).first();
          if (live) {
            next[name] = had;
            continue;
          }
        } catch {
          /* replaced below */
        }
      }
      await this.db('cloud_gpu_enrolments').where({ link_id: link.id, node: name }).whereNull('used_at').delete();
      const payload = await this.mint(link, { node: name, address });
      // The node's boot time for the timing: when Kubernetes registered it.
      next[name] = JSON.stringify(payload);
      minted++;
    }
    await kube.apply({ apiVersion: 'v1', kind: 'Secret', metadata: { name: ENROL_SECRET, namespace: GPU_NAMESPACE, labels: { 'exprsn.ai/managed': 'true' } }, type: 'Opaque', stringData: next });
    await this.db('cloud_gpu_pool_links').where({ id: link.id }).update({ state_detail: detail, desired_nodes: link.desired, updated_at: now });
    return minted;
  }

  /** Marks enrolled nodes healthy (instance healthy, every approved placement listed). Returns how many became healthy. */
  async observe(): Promise<number> {
    if (!(await this.pools.installed())) return 0;
    const s = this.s();
    const pending = (await this.db('cloud_gpu_boot_timings').whereNull('healthy_at')) as Record<string, unknown>[];
    let n = 0;
    for (const t of pending) {
      const inst = await s.gateway.repo.instance(String(t.instance_id));
      if (!inst || inst.state !== 'active' || inst.health !== 'healthy') continue;
      const link = await this.pools.get(String(t.link_id));
      if (!link) continue;
      const wanted = (await this.warmup(link)).models.map((m) => m.name);
      const listed = s.gateway.listedModels(inst.id);
      if (!listed || !wanted.every((w) => listed.some((l) => l === w || l === `${w}:latest` || `${l}:latest` === w))) continue;
      const at = this.options.now();
      await this.db('cloud_gpu_boot_timings').where({ id: t.id }).update({ healthy_at: at, seconds: Math.max(0, Math.round((at - Number(t.booted_at)) / 1000)) });
      n++;
    }
    return n;
  }

  /** Boot-to-healthy per node of a link, newest first. */
  async timings(linkId: string): Promise<BootTiming[]> {
    if (!(await this.pools.installed())) return [];
    return ((await this.db('cloud_gpu_boot_timings').where({ link_id: linkId }).orderBy('enrolled_at', 'desc').limit(100)) as Record<string, unknown>[]).map((r) => ({ node: (r.node as string | null) ?? null, instanceId: String(r.instance_id), source: String(r.source), bootedAt: Number(r.booted_at), enrolledAt: Number(r.enrolled_at), healthyAt: r.healthy_at == null ? null : Number(r.healthy_at), seconds: r.seconds == null ? null : Number(r.seconds) }));
  }

  /** Enrolled instances of a link (for the metrics' joined count and the routes). */
  async instancesOf(link: GpuPoolLink): Promise<InstanceRow[]> {
    if (!link.gatewayPoolId) return [];
    const ids = new Set(((await this.db('cloud_gpu_enrolments').where({ link_id: link.id }).whereNotNull('instance_id').select('instance_id')) as { instance_id: string }[]).map((r) => r.instance_id));
    return (await this.s().gateway.repo.instances(link.gatewayPoolId)).filter((i) => ids.has(i.id));
  }
}
