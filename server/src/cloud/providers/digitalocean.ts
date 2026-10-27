import { FEATURES_BY_PROVIDER, type CloudAccount, type CloudFeature, type IdentityResult, type PermissionCheck } from '../types.js';
import { namePrefix } from '../tags.js';
import { DO_CAPABILITIES, DO_FEATURE_SCOPES, snapshotReason } from './capabilities.js';
import { DoksResources } from './do-doks.js';
import { isKubeType } from './kubernetes.js';
import { DoApps } from './do-apps.js';
import { DoCaches } from './do-cache.js';
import { DoDatabases } from './do-databases.js';
import type { CacheAccess } from '../caches.js';
import { bootstrapUserData } from '../compute.js';
import { CloudTransport, type TransportOptions } from './transport.js';
import {
  assertAccount,
  CloudProviderError,
  CloudUnsupported,
  type AdapterCredential,
  type CallContext,
  type ClusterAccess,
  type CloudProvider,
  type FirewallRule,
  type ListFilter,
  type ObservedResource,
  type OperationHandle,
  type OperationResult,
  type PollResult,
  type ResourceOperation,
  type ResourceRef,
  type ResourceSpec,
  type ResourceType,
  type SnapshotResult,
  type Support,
  type DatabaseSnapshot,
  type ExtensionStatus,
  type SnapshotPurpose
} from './types.js';

/*
 * 1.9.99-final, Sprint 56 (B-10101): the DigitalOcean adapter, over the API v2 through `CloudTransport` (so every
 * call goes through the egress guard and the rate limiter, and a 429 waits for `ratelimit-reset` or `Retry-After`).
 * The credential is a custom-scoped token (DigitalOcean offers no federation, B-10009).
 *
 * Idempotency is a lookup before every create: VPCs, firewalls and droplets by their name (`exprsn-<account>-<name>`,
 * droplets also by their `exprsn:name:<name>` tag), domain records by name, type and value. Tags: droplets take
 * DigitalOcean tag strings (`exprsn:account:<value>`); VPCs keep them in their description; firewalls and domain
 * records take none, so their name prefix (and the journal) carry them. Long-running operations: droplets follow
 * their create action (`/v2/actions/<id>`), firewalls their status (`waiting` until `succeeded`).
 *
 * Token scopes (B-10007) are probed without changing anything: a read is a one-item list, a create is an empty body
 * (422 when allowed, 403 when not), an update or delete names an id that cannot exist (404 when allowed, 403 when not).
 */

export interface DigitalOceanEndpoints {
  /** The API origin (default `https://api.digitalocean.com`). */
  api?: string;
}


const PROBE_PATHS: Record<string, string> = { vpc: '/v2/vpcs', firewall: '/v2/firewalls', domain: '/v2/domains', droplet: '/v2/droplets', kubernetes: '/v2/kubernetes/clusters', database: '/v2/databases', tag: '/v2/tags', load_balancer: '/v2/load_balancers', genai: '/v2/gen-ai/agents', billing: '/v2/customers/my/balance', actions: '/v2/actions', account: '/v2/account', app: '/v2/apps' };
const PROBE_ID = '00000000-0000-4000-8000-000000000000';

const ALLOW_OUT: FirewallRule[] = [
  { protocol: 'tcp', ports: 'all', sources: ['0.0.0.0/0', '::/0'] },
  { protocol: 'udp', ports: 'all', sources: ['0.0.0.0/0', '::/0'] },
  { protocol: 'icmp', sources: ['0.0.0.0/0', '::/0'] }
];

interface DoVpc { id: string; name: string; description?: string; region: string; ip_range: string }
interface DoRule { protocol: string; ports?: string; sources?: { addresses?: string[] }; destinations?: { addresses?: string[] } }
interface DoFirewall { id: string; name: string; status: string; inbound_rules: DoRule[]; outbound_rules: DoRule[] }
interface DoRecord { id: number; type: string; name: string; data: string; ttl: number; priority?: number | null }
interface DoDroplet { id: number; name: string; status: string; region?: { slug: string }; size_slug?: string; tags?: string[]; vpc_uuid?: string }

export interface DigitalOceanProviderOptions extends Omit<TransportOptions, 'provider'> {
  endpoints?: DigitalOceanEndpoints;
}

export class DigitalOceanProvider implements CloudProvider {
  readonly kind = 'digitalocean' as const;
  readonly capabilities = DO_CAPABILITIES;
  readonly transport: CloudTransport;
  private endpoints: DigitalOceanEndpoints;

  constructor(o: DigitalOceanProviderOptions) {
    const { endpoints, ...t } = o;
    this.transport = new CloudTransport({ ...t, provider: 'digitalocean' });
    this.endpoints = endpoints ?? {};
  }

  setEndpoints(e: DigitalOceanEndpoints): void {
    this.endpoints = { ...e };
  }

  private get api(): string {
    return (this.endpoints.api ?? 'https://api.digitalocean.com').replace(/\/$/, '');
  }

  /** Sprint 60 (B-10405): the API's base URL, for the account limits read at plan time (`cloud/gpu-quotas.ts`). */
  get apiBase(): string {
    return this.api;
  }

  /** Sprint 58 (B-10203): DOKS clusters, node pools and the cluster's load balancer (`do-doks.ts`), on this adapter's call path. */
  private get kube(): DoksResources {
    return (this.doks ??= new DoksResources({ call: (...a) => this.call(...a), all: (...a) => this.all(...a), doName: (c, n) => this.doName(c, n), region: (c, sp) => this.region(c, sp), tagStrings }));
  }
  private doks: DoksResources | null = null;

  /** Sprint 58 (B-10205): App Platform apps (`do-apps.ts`), on this adapter's call path. */
  private get apps(): DoApps {
    return (this.appPlatform ??= new DoApps({ call: (c, m, p, b) => this.call(c.cred, c.account, m, p, b, c.signal), all: (c, p, k) => this.all(c, p, k), region: (c, sp) => this.region(c, sp) }));
  }
  private appPlatform: DoApps | null = null;

  /** Sprint 59 (B-10305): managed Valkey clusters (`do-cache.ts`). */
  private get caches(): DoCaches {
    return (this.cacheModule ??= new DoCaches({ call: (c, m, p, b) => this.call(c.cred, c.account, m, p, b, c.signal), all: (c, p, k) => this.all(c, p, k), region: (c, sp) => this.region(c, sp) }));
  }
  private cacheModule: DoCaches | null = null;

  /** Sprint 59 (B-10301, B-10303, B-10307): managed PostgreSQL and MySQL clusters (`do-databases.ts`). */
  private get databases(): DoDatabases {
    return (this.dbModule ??= new DoDatabases({ call: (c, m, p, b) => this.call(c.cred, c.account, m, p, b, c.signal), all: (c, p, k) => this.all(c, p, k), region: (c, sp) => this.region(c, sp) }));
  }
  private dbModule: DoDatabases | null = null;

  async listSnapshots(ctx: CallContext, ref: ResourceRef): Promise<DatabaseSnapshot[]> {
    this.assertBuilt('database', 'describe');
    return this.databases.listSnapshots(ctx, ref);
  }

  async deleteSnapshot(ctx: CallContext, ref: ResourceRef, snapshotId: string): Promise<void> {
    this.assertBuilt('database', 'delete');
    return this.databases.deleteSnapshot(ctx, ref, snapshotId);
  }

  /** B-10307: a database snapshot (a backup, a restore point or a fork) restored to a new cluster. */
  async restoreSnapshot(ctx: CallContext, ref: ResourceRef, snapshotId: string, o?: { name?: string; tags?: Record<string, string> }): Promise<SnapshotResult> {
    this.assertBuilt('database', 'create');
    return this.databases.restore(ctx, ref, snapshotId, o);
  }

  /** B-10301: the extension check (DigitalOcean's supported list; no allow-list step). */
  async databaseExtensions(ctx: CallContext, ref: ResourceRef, wanted: string[]): Promise<ExtensionStatus[]> {
    this.assertBuilt('database', 'describe');
    return this.databases.extensions(ctx, ref, wanted);
  }

  /** B-10302: a managed database cluster's CA certificate (PEM), which the app verifies the database with (`cloud/data-tier.ts`). */
  async databaseCa(ctx: CallContext, ref: ResourceRef): Promise<string> {
    const r = await this.call<{ ca?: { certificate?: string } }>(ctx.cred, ctx.account, 'GET', `/v2/databases/${encodeURIComponent(ref.providerId)}/ca`, undefined, ctx.signal);
    const b64 = r.body.ca?.certificate;
    if (!b64) throw new CloudProviderError('DigitalOcean answered without the cluster’s CA certificate.', 'digitalocean', 502, 'malformed');
    return Buffer.from(b64, 'base64').toString('utf8');
  }

  /** B-10305: a Valkey cluster's private host, user and generated password, for `cloud/caches.ts` only. */
  async cacheAccess(ctx: CallContext, ref: ResourceRef): Promise<CacheAccess> {
    this.assertBuilt('cache', 'describe');
    return this.caches.access(ctx, ref);
  }

  /** B-10203: short-lived credentials for a DOKS cluster's API (the credentials endpoint). */
  async kubeAccess(ctx: CallContext, ref: ResourceRef, o?: { seconds?: number }): Promise<ClusterAccess> {
    this.assertBuilt('kubernetes_cluster', 'describe');
    return this.kube.access(ctx, ref, o);
  }

  supports(type: ResourceType, op?: ResourceOperation): Support {
    const c = this.capabilities[type];
    if (c.support !== 'built') return c.support;
    return !op || c.operations.includes(op) ? 'built' : 'not_yet';
  }

  private token(cred: AdapterCredential, account: CloudAccount): string {
    assertAccount('digitalocean', account);
    if (cred.kind !== 'token') throw new CloudProviderError('A DigitalOcean account needs an API token.', 'digitalocean', 400, 'wrong_credential');
    return cred.token;
  }

  private async call<T>(cred: AdapterCredential, account: CloudAccount, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<{ status: number; body: T; headers: Record<string, string>; requestId: string | null }> {
    const token = this.token(cred, account);
    return this.transport.json<T>(
      { method, url: path.startsWith('http') ? path : `${this.api}${path}`, headers: { authorization: `Bearer ${token}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), accountId: account.id, ...(signal ? { signal } : {}) },
      (status, b) => {
        const e = (b ?? {}) as { id?: string; message?: string };
        return { message: `DigitalOcean answered ${status}${e.id ? ` (${e.id})` : ''}: ${(e.message ?? 'no detail').slice(0, 300)}`, code: e.id ?? null };
      }
    );
  }

  /** Every item of a paged list, following `links.pages.next` on the API's own origin only. */
  private async all<T>(ctx: CallContext, path: string, key: string): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = `${path}${path.includes('?') ? '&' : '?'}per_page=200`;
    for (let i = 0; next && i < 100; i++) {
      const r: { body: Record<string, unknown> } = await this.call<Record<string, unknown>>(ctx.cred, ctx.account, 'GET', next, undefined, ctx.signal);
      out.push(...((r.body[key] as T[]) ?? []));
      const link = ((r.body.links as { pages?: { next?: string } } | undefined)?.pages?.next) ?? null;
      next = link && new URL(link).origin === new URL(this.api).origin ? link : null;
    }
    return out;
  }

  // ---------- identity and permissions ----------

  async identity(cred: AdapterCredential, account: CloudAccount): Promise<IdentityResult> {
    try {
      const r = await this.call<{ account: { uuid: string; email?: string; status?: string; team?: { uuid: string; name: string } } }>(cred, account, 'GET', '/v2/account');
      const a = r.body.account;
      if (a.status && a.status !== 'active') return { ok: false, principal: a.uuid, providerAccount: a.team?.uuid, error: `The DigitalOcean account is ${a.status}.` };
      return { ok: true, principal: a.team ? `${a.uuid} (team ${a.team.name})` : a.uuid, ...(a.team?.uuid ? { providerAccount: a.team.uuid } : {}), ...(r.requestId ? { requestId: r.requestId } : {}) };
    } catch (err) {
      if (err instanceof CloudProviderError && (err.status === 401 || err.status === 403)) return { ok: false, error: `DigitalOcean refused the token: ${err.message}`, ...(err.requestId ? { requestId: err.requestId } : {}) };
      throw err;
    }
  }

  /** Whether the token holds a scope, found with a call that changes nothing. */
  private async probe(cred: AdapterCredential, account: CloudAccount, scope: string): Promise<boolean> {
    const [res, verb] = scope.split(':') as [string, string];
    const path = PROBE_PATHS[res];
    if (!path) return false;
    const id = res === 'domain' ? 'exprsn-permission-probe.invalid' : res === 'droplet' ? '0' : res === 'tag' ? 'exprsn-permission-probe' : PROBE_ID;
    const [method, url, body] = verb === 'read' ? ['GET', `${path}${path.includes('?') ? '&' : '?'}per_page=1`, undefined] : verb === 'create' ? ['POST', path, {}] : verb === 'delete' ? ['DELETE', `${path}/${id}`, undefined] : ['PUT', `${path}/${id}`, {}];
    try {
      await this.call(cred, account, method, url, body);
      return true;
    } catch (err) {
      if (!(err instanceof CloudProviderError)) throw err;
      if (err.status === 403) return false;
      if (err.status === 401 || err.status === 429 || err.status >= 500) throw err;
      return true;
    }
  }

  async checkPermissions(cred: AdapterCredential, account: CloudAccount, features: CloudFeature[]): Promise<PermissionCheck[]> {
    const offered = FEATURES_BY_PROVIDER.digitalocean;
    const wanted = features.filter((f) => offered.includes(f) && DO_FEATURE_SCOPES[f]);
    const scopes = [...new Set(wanted.flatMap((f) => DO_FEATURE_SCOPES[f]!))];
    const held = new Map<string, boolean>();
    for (const s of scopes) held.set(s, await this.probe(cred, account, s));
    return features.map((f) => {
      if (!wanted.includes(f)) return { feature: f, required: [], missing: [], unsupported: true };
      const required = DO_FEATURE_SCOPES[f]!;
      return { feature: f, required, missing: required.filter((s) => !held.get(s)) };
    });
  }

  // ---------- resources ----------

  private assertBuilt(type: ResourceType, op: ResourceOperation): void {
    const s = this.supports(type, op);
    if (s !== 'built') throw new CloudUnsupported('digitalocean', type, s, op, this.capabilities[type].note);
  }

  private doName(ctx: CallContext, name: string): string {
    return `${namePrefix(ctx.account.name)}${name}`;
  }

  private region(ctx: CallContext, spec?: ResourceSpec): string {
    return spec?.region ?? ctx.region ?? ctx.account.defaultRegion ?? 'fra1';
  }

  async find(ctx: CallContext, spec: ResourceSpec): Promise<ObservedResource | null> {
    this.assertBuilt(spec.type, 'describe');
    if (isKubeType(spec.type)) return this.kube.find(ctx, spec);
    if (spec.type === 'container_service') return this.apps.find(ctx, spec);
    if (spec.type === 'cache') return this.caches.find(ctx, spec);
    if (spec.type === 'database') return this.databases.find(ctx, spec);
    const name = this.doName(ctx, spec.name);
    switch (spec.type) {
      case 'network': {
        const v = (await this.all<DoVpc>(ctx, '/v2/vpcs', 'vpcs')).find((x) => x.name === name);
        return v ? vpcObserved(v) : null;
      }
      case 'firewall': {
        const f = (await this.all<DoFirewall>(ctx, '/v2/firewalls', 'firewalls')).find((x) => x.name === name);
        return f ? firewallObserved(f, spec.name) : null;
      }
      case 'vm': {
        const d = (await this.all<DoDroplet>(ctx, `/v2/droplets?tag_name=${encodeURIComponent(`exprsn:name:${spec.name}`)}`, 'droplets')).find((x) => x.name === name);
        return d ? dropletObserved(d) : null;
      }
      case 'dns_record': {
        const p = (spec as ResourceSpec<'dns_record'>).props;
        return this.describe(ctx, { type: 'dns_record', providerId: recordSetId(p.zone, p.recordType, p.record) });
      }
    }
    return null;
  }

  async describe(ctx: CallContext, ref: ResourceRef): Promise<ObservedResource | null> {
    this.assertBuilt(ref.type, 'describe');
    if (isKubeType(ref.type)) return this.kube.describe(ctx, ref);
    if (ref.type === 'container_service') return this.apps.describe(ctx, ref);
    if (ref.type === 'cache') return this.caches.describe(ctx, ref);
    if (ref.type === 'database') return this.databases.describe(ctx, ref);
    try {
      switch (ref.type) {
        case 'network':
          return vpcObserved((await this.call<{ vpc: DoVpc }>(ctx.cred, ctx.account, 'GET', `/v2/vpcs/${encodeURIComponent(ref.providerId)}`, undefined, ctx.signal)).body.vpc);
        case 'firewall':
          return firewallObserved((await this.call<{ firewall: DoFirewall }>(ctx.cred, ctx.account, 'GET', `/v2/firewalls/${encodeURIComponent(ref.providerId)}`, undefined, ctx.signal)).body.firewall);
        case 'vm':
          return dropletObserved((await this.call<{ droplet: DoDroplet }>(ctx.cred, ctx.account, 'GET', `/v2/droplets/${encodeURIComponent(ref.providerId)}`, undefined, ctx.signal)).body.droplet);
        case 'dns_record': {
          const [zone, type, record] = splitSetId(ref.providerId);
          const records = await this.records(ctx, zone, type, record);
          return records.length ? recordSetObserved(zone, type, record, records) : null;
        }
      }
    } catch (err) {
      if (err instanceof CloudProviderError && err.status === 404) return null;
      throw err;
    }
    return null;
  }

  private async records(ctx: CallContext, zone: string, type: string, record: string): Promise<DoRecord[]> {
    const full = record === '@' ? zone : `${record}.${zone}`;
    const list = await this.all<DoRecord>(ctx, `/v2/domains/${encodeURIComponent(zone)}/records?type=${encodeURIComponent(type)}&name=${encodeURIComponent(full)}`, 'domain_records');
    return list.filter((r) => r.type === type && r.name === record);
  }

  async list(ctx: CallContext, type: ResourceType, filter: ListFilter = {}): Promise<ObservedResource[]> {
    this.assertBuilt(type, 'list');
    if (type === 'kubernetes_cluster' || type === 'node_group' || type === 'load_balancer') return this.kube.list(ctx, type, filter);
    if (type === 'container_service') return this.apps.list(ctx, !!filter.managedOnly);
    if (type === 'cache') return this.caches.list(ctx, filter);
    if (type === 'database') return this.databases.list(ctx, filter);
    const prefix = namePrefix(ctx.account.name);
    switch (type) {
      case 'network':
        return (await this.all<DoVpc>(ctx, '/v2/vpcs', 'vpcs')).filter((v) => !filter.managedOnly || v.name.startsWith(prefix)).map(vpcObserved);
      case 'firewall':
        return (await this.all<DoFirewall>(ctx, '/v2/firewalls', 'firewalls')).filter((f) => !filter.managedOnly || f.name.startsWith(prefix)).map((f) => firewallObserved(f, f.name.startsWith(prefix) ? f.name.slice(prefix.length) : f.name));
      case 'vm':
        return (await this.all<DoDroplet>(ctx, filter.managedOnly ? `/v2/droplets?tag_name=${encodeURIComponent(`exprsn:account:${ctx.account.name}`)}` : '/v2/droplets', 'droplets')).filter((d) => !filter.networkId || d.vpc_uuid === filter.networkId).map(dropletObserved);
      case 'dns_record': {
        if (!filter.zone) throw new CloudProviderError('Listing domain records needs the domain.', 'digitalocean', 400, 'zone_required');
        const all = await this.all<DoRecord>(ctx, `/v2/domains/${encodeURIComponent(filter.zone)}/records`, 'domain_records');
        const sets = new Map<string, DoRecord[]>();
        for (const r of all) if (r.type !== 'NS' && r.type !== 'SOA') sets.set(`${r.type}|${r.name}`, [...(sets.get(`${r.type}|${r.name}`) ?? []), r]);
        return [...sets.entries()].map(([k, rs]) => {
          const [t, n] = k.split('|') as [string, string];
          return recordSetObserved(filter.zone!, t, n, rs);
        });
      }
    }
    return [];
  }

  async create(ctx: CallContext, spec: ResourceSpec): Promise<OperationResult> {
    this.assertBuilt(spec.type, 'create');
    if (isKubeType(spec.type)) return this.kube.create(ctx, spec);
    if (spec.type === 'container_service') return this.apps.create(ctx, spec as ResourceSpec<'container_service'>, (op, r, kind, token) => this.handle(op, r, kind, token));
    if (spec.type === 'cache') return this.caches.create(ctx, spec, (op, r, kind, token) => this.handle(op, r, kind, token));
    if (spec.type === 'database') return this.databases.create(ctx, spec as ResourceSpec<'database'>, (op, r, kind, token) => this.handle(op, r, kind, token));
    const existing = await this.find(ctx, spec);
    if (existing && spec.type !== 'dns_record') {
      if (existing.state === 'creating' && spec.type === 'firewall') return { done: false, operation: this.handle('create', existing, 'do-firewall', existing.providerId), resource: existing, adopted: true };
      return { done: true, resource: existing, adopted: true };
    }
    const name = this.doName(ctx, spec.name);
    switch (spec.type) {
      case 'network': {
        const p = (spec as ResourceSpec<'network'>).props;
        try {
          const r = await this.call<{ vpc: DoVpc }>(ctx.cred, ctx.account, 'POST', '/v2/vpcs', { name, region: this.region(ctx, spec), ip_range: p.cidr, description: tagText(spec) }, ctx.signal);
          return { done: true, resource: vpcObserved(r.body.vpc), ...(r.requestId ? { requestId: r.requestId } : {}) };
        } catch (err) {
          // Two attempts racing: the name is taken by the other one's VPC, which is ours.
          if (err instanceof CloudProviderError && err.status === 422 && /already/i.test(err.message)) {
            const found = await this.find(ctx, spec);
            if (found) return { done: true, resource: found, adopted: true };
          }
          throw err;
        }
      }
      case 'firewall': {
        const p = (spec as ResourceSpec<'firewall'>).props;
        const r = await this.call<{ firewall: DoFirewall }>(ctx.cred, ctx.account, 'POST', '/v2/firewalls', { name, inbound_rules: p.ingress.flatMap(toDoRules), outbound_rules: ALLOW_OUT.map(toDoOut), tags: [], droplet_ids: [] }, ctx.signal);
        const o = firewallObserved(r.body.firewall, spec.name);
        return o.state === 'ready' ? { done: true, resource: o } : { done: false, operation: this.handle('create', o, 'do-firewall', o.providerId), resource: o, ...(r.requestId ? { requestId: r.requestId } : {}) };
      }
      case 'vm': {
        const p = (spec as ResourceSpec<'vm'>).props;
        const tags = [...tagStrings(spec.tags), `exprsn:name:${spec.name}`];
        // B-10204: an app droplet boots the release installer from cloud-init, with the wrapped token put in now.
        const userData = await bootstrapUserData(p.userData, p.secrets, ctx.secrets);
        if (p.publicIp === false && !spec.parent?.networkId) throw new CloudProviderError('An app droplet lives in the deployment VPC (parent.networkId).', 'digitalocean', 400, 'parent_required');
        const r = await this.call<{ droplet: DoDroplet; links?: { actions?: { id: number }[] } }>(ctx.cred, ctx.account, 'POST', '/v2/droplets', { name, region: this.region(ctx, spec), size: p.size, image: p.image === 'ubuntu-24.04' ? 'ubuntu-24-04-x64' : p.image === 'ubuntu-24.04-gpu' ? 'gpu-h100x1-base' : p.image, tags, ...(spec.parent?.networkId ? { vpc_uuid: spec.parent.networkId } : {}), ...(p.sshKeys?.length ? { ssh_keys: p.sshKeys } : {}), ...(userData ? { user_data: userData } : {}), ...(p.install ? { monitoring: true } : {}) }, ctx.signal);
        const o = dropletObserved(r.body.droplet);
        const action = r.body.links?.actions?.[0]?.id;
        return action != null ? { done: false, operation: this.handle('create', o, 'do-action', String(action)), resource: o, ...(r.requestId ? { requestId: r.requestId } : {}) } : { done: true, resource: o };
      }
      case 'dns_record':
        return this.reconcileRecords(ctx, spec as ResourceSpec<'dns_record'>, Boolean(existing));
    }
    throw new CloudUnsupported('digitalocean', spec.type, 'not_yet', 'create');
  }

  /** Makes the domain's records for a name and type hold exactly the spec's values (one record per value). */
  private async reconcileRecords(ctx: CallContext, spec: ResourceSpec<'dns_record'>, existed: boolean): Promise<OperationResult> {
    const p = spec.props;
    const current = await this.records(ctx, p.zone, p.recordType, p.record);
    const want = new Set(p.values.map((v) => dataOf(p.recordType, v)));
    for (const r of current) {
      if (!want.has(r.data)) await this.call(ctx.cred, ctx.account, 'DELETE', `/v2/domains/${encodeURIComponent(p.zone)}/records/${r.id}`, undefined, ctx.signal);
      else if (p.ttl && r.ttl !== p.ttl) await this.call(ctx.cred, ctx.account, 'PATCH', `/v2/domains/${encodeURIComponent(p.zone)}/records/${r.id}`, { ttl: p.ttl }, ctx.signal);
    }
    const have = new Set(current.map((r) => r.data));
    for (const v of p.values) {
      const data = dataOf(p.recordType, v);
      if (have.has(data)) continue;
      const [prio, rest] = p.recordType === 'MX' ? [Number(v.split(/\s+/)[0]), v.split(/\s+/)[1]] : [undefined, data];
      await this.call(ctx.cred, ctx.account, 'POST', `/v2/domains/${encodeURIComponent(p.zone)}/records`, { type: p.recordType, name: p.record || '@', data: rest, ttl: p.ttl ?? 1800, ...(prio != null ? { priority: prio } : {}) }, ctx.signal);
    }
    const resource = await this.describe(ctx, { type: 'dns_record', providerId: recordSetId(p.zone, p.recordType, p.record) });
    return { done: true, resource, ...(existed ? { adopted: true } : {}) };
  }

  async update(ctx: CallContext, ref: ResourceRef, spec: ResourceSpec): Promise<OperationResult> {
    this.assertBuilt(ref.type, 'update');
    if (isKubeType(ref.type)) return this.kube.update(ctx, ref, spec);
    if (ref.type === 'container_service') return this.apps.update(ctx, ref, spec as ResourceSpec<'container_service'>, (op, r, kind, token) => this.handle(op, r, kind, token));
    if (ref.type === 'cache') return this.caches.update(ctx, ref, spec, (op, r, kind, token) => this.handle(op, r, kind, token));
    if (ref.type === 'database') return this.databases.update(ctx, ref, spec as ResourceSpec<'database'>, (op, r, kind, token) => this.handle(op, r, kind, token));
    switch (ref.type) {
      case 'network': {
        const r = await this.call<{ vpc: DoVpc }>(ctx.cred, ctx.account, 'PATCH', `/v2/vpcs/${encodeURIComponent(ref.providerId)}`, { description: tagText(spec) }, ctx.signal);
        return { done: true, resource: vpcObserved(r.body.vpc) };
      }
      case 'firewall': {
        const p = (spec as ResourceSpec<'firewall'>).props;
        const r = await this.call<{ firewall: DoFirewall }>(ctx.cred, ctx.account, 'PUT', `/v2/firewalls/${encodeURIComponent(ref.providerId)}`, { name: this.doName(ctx, spec.name), inbound_rules: p.ingress.flatMap(toDoRules), outbound_rules: ALLOW_OUT.map(toDoOut), tags: [] }, ctx.signal);
        const o = firewallObserved(r.body.firewall, spec.name);
        return o.state === 'ready' ? { done: true, resource: o } : { done: false, operation: this.handle('update', o, 'do-firewall', o.providerId), resource: o };
      }
      case 'vm': {
        const current = await this.describe(ctx, ref);
        if (!current) throw new CloudProviderError(`Droplet ${ref.providerId} no longer exists.`, 'digitalocean', 404, 'not_found');
        for (const t of [...tagStrings(spec.tags), `exprsn:name:${spec.name}`]) {
          await this.call(ctx.cred, ctx.account, 'POST', '/v2/tags', { name: t }, ctx.signal).catch((err) => {
            if (!(err instanceof CloudProviderError && err.status === 422)) throw err;
          });
          await this.call(ctx.cred, ctx.account, 'POST', `/v2/tags/${encodeURIComponent(t)}/resources`, { resources: [{ resource_id: ref.providerId, resource_type: 'droplet' }] }, ctx.signal);
        }
        return { done: true, resource: await this.describe(ctx, ref) };
      }
      case 'dns_record':
        return this.reconcileRecords(ctx, spec as ResourceSpec<'dns_record'>, true);
    }
    throw new CloudUnsupported('digitalocean', ref.type, 'not_yet', 'update');
  }

  async delete(ctx: CallContext, ref: ResourceRef): Promise<OperationResult> {
    this.assertBuilt(ref.type, 'delete');
    if (isKubeType(ref.type)) return this.kube.delete(ctx, ref);
    if (ref.type === 'container_service') return this.apps.delete(ctx, ref);
    if (ref.type === 'cache') return this.caches.delete(ctx, ref);
    if (ref.type === 'database') return this.databases.delete(ctx, ref, (op, r, kind, token) => this.handle(op, r, kind, token));
    const path = ref.type === 'network' ? `/v2/vpcs/${encodeURIComponent(ref.providerId)}` : ref.type === 'firewall' ? `/v2/firewalls/${encodeURIComponent(ref.providerId)}` : ref.type === 'vm' ? `/v2/droplets/${encodeURIComponent(ref.providerId)}` : null;
    try {
      if (path) {
        await this.call(ctx.cred, ctx.account, 'DELETE', path, undefined, ctx.signal);
        return { done: true, resource: null };
      }
      if (ref.type === 'dns_record') {
        const [zone, type, record] = splitSetId(ref.providerId);
        for (const r of await this.records(ctx, zone, type, record)) await this.call(ctx.cred, ctx.account, 'DELETE', `/v2/domains/${encodeURIComponent(zone)}/records/${r.id}`, undefined, ctx.signal);
        return { done: true, resource: null };
      }
    } catch (err) {
      if (err instanceof CloudProviderError && err.status === 404) return { done: true, resource: null };
      throw err;
    }
    throw new CloudUnsupported('digitalocean', ref.type, 'not_yet', 'delete');
  }

  async poll(ctx: CallContext, h: OperationHandle): Promise<PollResult> {
    if (h.provider !== 'digitalocean') throw new CloudProviderError('That operation is not a DigitalOcean one.', 'digitalocean', 400, 'wrong_provider');
    if (isKubeType(h.type)) return this.kube.poll(ctx, h);
    if (h.kind === 'do-app') return this.apps.poll(ctx, h);
    if (h.type === 'cache') return this.caches.poll(ctx, h);
    if (h.type === 'database') return this.databases.poll(ctx, h);
    if (h.kind === 'do-action') {
      const r = await this.call<{ action: { status: string; type: string } }>(ctx.cred, ctx.account, 'GET', `/v2/actions/${encodeURIComponent(h.token)}`, undefined, ctx.signal);
      if (r.body.action.status === 'completed') return { state: 'succeeded', resource: h.op === 'delete' ? null : await this.describe(ctx, h.ref) };
      if (r.body.action.status === 'errored') return { state: 'failed', error: `The ${r.body.action.type} action errored.`, code: 'action_errored' };
      return { state: 'pending', waitMs: 3000 };
    }
    const o = await this.describe(ctx, h.ref);
    if (h.op === 'delete') return o ? { state: 'pending', waitMs: 2000 } : { state: 'succeeded', resource: null };
    if (!o) return { state: 'failed', error: `${h.ref.providerId} disappeared.`, code: 'not_found' };
    if (o.state === 'failed') return { state: 'failed', error: `The firewall ${h.ref.providerId} failed to apply.`, code: 'firewall_failed' };
    return o.state === 'ready' ? { state: 'succeeded', resource: o } : { state: 'pending', waitMs: 2000 };
  }

  // ---------- final snapshots (B-10107) ----------

  snapshotSupport(type: ResourceType): string | null {
    return snapshotReason('digitalocean', type);
  }

  /** A droplet snapshot (`POST /v2/droplets/<id>/actions` type `snapshot`), followed through its action. */
  async snapshot(ctx: CallContext, ref: ResourceRef, name: string, o?: { purpose?: SnapshotPurpose }): Promise<SnapshotResult> {
    const why = snapshotReason('digitalocean', ref.type);
    if (why) throw new CloudUnsupported('digitalocean', ref.type, 'not_yet', undefined, why);
    // Sprint 59 (B-10307): a database's is a retained fork (final, manual) or a restore point (upgrade).
    if (ref.type === 'database') return this.databases.snapshot(ctx, ref, name, o?.purpose ?? 'final');
    const r = await this.call<{ action: { id: number; status: string } }>(ctx.cred, ctx.account, 'POST', `/v2/droplets/${encodeURIComponent(ref.providerId)}/actions`, { type: 'snapshot', name }, ctx.signal);
    const pending: SnapshotResult = { state: 'pending', name, snapshotId: null, operation: this.handle('update', ref, 'do-action', String(r.body.action.id)), waitMs: 3000, requestId: r.requestId };
    return r.body.action.status === 'completed' ? this.snapshotStatus(ctx, ref, pending) : pending;
  }

  async snapshotStatus(ctx: CallContext, ref: ResourceRef, pending: SnapshotResult): Promise<SnapshotResult> {
    if (pending.state !== 'pending' || !pending.operation) return pending;
    if (ref.type === 'database') return this.databases.snapshotStatus(ctx, ref, pending);
    const a = await this.call<{ action: { status: string } }>(ctx.cred, ctx.account, 'GET', `/v2/actions/${encodeURIComponent(pending.operation.token)}`, undefined, ctx.signal);
    if (a.body.action.status === 'errored') return { ...pending, state: 'failed', error: 'The snapshot action errored.' };
    if (a.body.action.status !== 'completed') return { ...pending, waitMs: 3000 };
    const list = await this.all<{ id: string | number; name: string }>(ctx, `/v2/droplets/${encodeURIComponent(ref.providerId)}/snapshots`, 'snapshots');
    const snap = list.find((x) => x.name === pending.name);
    if (!snap) return { ...pending, state: 'failed', error: `The snapshot action completed but ${pending.name} is not among the droplet's snapshots.` };
    const { operation: _op, ...rest } = pending;
    return { ...rest, state: 'done', snapshotId: String(snap.id) };
  }

  private handle(op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string): OperationHandle {
    return { provider: 'digitalocean', type: ref.type, op, kind, ref: { type: ref.type, providerId: ref.providerId }, token, startedAt: Date.now() };
  }
}

// ---------- mapping ----------

/** The `exprsn:*` tags as DigitalOcean tag strings (`exprsn:account:<value>`, the form `cloud/tags.ts` uses). */
const tagStrings = (tags: Record<string, string>) => Object.entries(tags).map(([k, v]) => `${k}:${v}`);
const tagText = (spec: ResourceSpec) => [...tagStrings(spec.tags), `exprsn:name:${spec.name}`].join(' ').slice(0, 255);

function parseTagStrings(list: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of list) {
    const m = /^(exprsn:[a-z]+):(.*)$/.exec(t);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

function vpcObserved(v: DoVpc): ObservedResource {
  const tags = parseTagStrings((v.description ?? '').split(/\s+/).filter(Boolean));
  const name = tags['exprsn:name'] ?? v.name;
  delete tags['exprsn:name'];
  return { type: 'network', providerId: v.id, name, region: v.region, state: 'ready', tags, props: { cidr: v.ip_range } };
}

function firewallObserved(f: DoFirewall, name?: string): ObservedResource {
  return { type: 'firewall', providerId: f.id, name: name ?? f.name, state: f.status === 'succeeded' ? 'ready' : f.status === 'failed' ? 'failed' : 'creating', tags: {}, props: { ingress: mergeAll(f.inbound_rules.map(fromDoRule)) } };
}

function dropletObserved(d: DoDroplet): ObservedResource {
  const tags = parseTagStrings(d.tags ?? []);
  const name = tags['exprsn:name'] ?? d.name;
  delete tags['exprsn:name'];
  return { type: 'vm', providerId: String(d.id), name, ...(d.region ? { region: d.region.slug } : {}), state: d.status === 'active' ? 'ready' : d.status === 'new' ? 'creating' : 'ready', tags, props: { size: d.size_slug, networkId: d.vpc_uuid, status: d.status } };
}

/**
 * Sprint 58: DigitalOcean firewalls have no "every protocol": a rule for `all` is written as TCP, UDP and ICMP rules
 * for the same sources, and read back as one `all` rule (`mergeAll`), so it compares equal to the desired spec.
 */
function toDoRules(r: FirewallRule): DoRule[] {
  if (r.protocol !== 'all') return [toDoRule(r)];
  return (['tcp', 'udp', 'icmp'] as const).map((protocol) => toDoRule({ ...r, protocol, ...(protocol === 'icmp' ? {} : { ports: 'all' }) }));
}

function mergeAll(rules: FirewallRule[]): FirewallRule[] {
  const key = (r: FirewallRule) => [...r.sources].sort().join(',');
  const out: FirewallRule[] = [];
  const used = new Set<number>();
  rules.forEach((r, i) => {
    if (used.has(i)) return;
    if (r.protocol === 'tcp' && (r.ports ?? 'all') === 'all') {
      const u = rules.findIndex((x, j) => !used.has(j) && j !== i && x.protocol === 'udp' && (x.ports ?? 'all') === 'all' && key(x) === key(r));
      const c = rules.findIndex((x, j) => !used.has(j) && j !== i && x.protocol === 'icmp' && key(x) === key(r));
      if (u >= 0 && c >= 0) {
        used.add(i).add(u).add(c);
        out.push({ protocol: 'all', sources: r.sources });
        return;
      }
    }
    used.add(i);
    out.push(r);
  });
  return out;
}

function toDoRule(r: FirewallRule): DoRule {
  return { protocol: r.protocol === 'all' ? 'tcp' : r.protocol, ...(r.protocol !== 'icmp' ? { ports: r.protocol === 'all' ? 'all' : (r.ports ?? 'all') } : {}), sources: { addresses: r.sources } };
}

function toDoOut(r: FirewallRule): DoRule {
  return { protocol: r.protocol, ...(r.protocol !== 'icmp' ? { ports: r.ports ?? 'all' } : {}), destinations: { addresses: r.sources } };
}

function fromDoRule(r: DoRule): FirewallRule {
  return { protocol: r.protocol as FirewallRule['protocol'], ...(r.ports && r.protocol !== 'icmp' ? { ports: r.ports === '0' ? 'all' : r.ports } : {}), sources: r.sources?.addresses ?? [] };
}

const recordSetId = (zone: string, type: string, record: string) => `${zone}|${type}|${record || '@'}`;
const splitSetId = (id: string): [string, string, string] => {
  const [zone, type, record] = id.split('|');
  return [zone!, type!, record!];
};
const dataOf = (type: string, v: string) => (type === 'MX' ? v.split(/\s+/)[1]! : type === 'CNAME' && !v.endsWith('.') ? `${v}.` : v);

function recordSetObserved(zone: string, type: string, record: string, rs: DoRecord[]): ObservedResource {
  return { type: 'dns_record', providerId: recordSetId(zone, type, record), name: record, state: 'ready', tags: {}, props: { zone, record, recordType: type, values: rs.map((r) => (type === 'MX' ? `${r.priority ?? 0} ${r.data}` : r.data)), ttl: rs[0]?.ttl, ids: rs.map((r) => r.id) } };
}
