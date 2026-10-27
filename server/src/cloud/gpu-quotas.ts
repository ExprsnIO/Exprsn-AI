import { createHash } from 'node:crypto';
import { signV4 } from '../platform/blob.js';
import type { Services } from '../services.js';
import type { DeploymentContext } from './deployments.js';
import type { DesiredResource, GraphResource, PlanStep } from './graph.js';
import type { CloudTransport } from './providers/transport.js';
import { CloudProviderError, type OperationResult, type ResourceSpec } from './providers/types.js';

/*
 * 1.9.99-final, Sprint 60 (B-10405): GPU quotas at plan time and capacity at apply.
 *
 * Quotas. A plan that creates or grows a GPU node group or GPU VM (and only such a plan: nothing is read otherwise)
 * reads the account's quota for that family in the region and what is in use, and is refused (a blocker; the plan is
 * not applicable) when the request does not fit, naming the quota, the requested and available numbers and where to
 * ask for more:
 *   AWS          Service Quotas `GetServiceQuota` (ec2 `L-DB2E81BA` "Running On-Demand G and VT instances",
 *                `L-417A185B` "Running On-Demand P instances", in vCPUs); in use: the running and pending G/VT or P
 *                instances' vCPUs (EC2 `DescribeInstances`)
 *   Azure        Compute usages of the region (`Microsoft.Compute/locations/<region>/usages`): the VM family's vCPUs
 *                (`standardNCADSH100v5Family`, `standardNVADSA10v5Family`...), limit and current value
 *   DigitalOcean the account's `droplet_limit` (`/v2/account`) against its droplets (`/v2/droplets`); GPU Droplet
 *                access itself is granted per team and refused at create, which the capacity fallback handles
 * A quota that cannot be read (no permission, the API down) is not a refusal: the plan carries a note and the
 * provider decides at create time.
 *
 * Capacity. A create of a GPU node group or VM that the provider refuses for capacity (InsufficientInstanceCapacity,
 * SkuNotAvailable, ZonalAllocationFailed, a DigitalOcean region out of a size) is tried again with the next allowed
 * instance type (`capacity.sizes`, from `gpuPools[].fallbackTypes`), then the next zone (`capacity.zones`), each with
 * its own idempotency key. The type that had capacity is what the graph records; the planner accepts any size in
 * `capacity.sizes` as satisfying the spec, so a fallback is not drift.
 */

export interface QuotaFinding {
  key: string;
  provider: string;
  quota: string;
  code: string | null;
  unit: 'vCPUs' | 'droplets';
  requested: number;
  available: number;
  limit: number;
  inUse: number;
  region: string;
  requestUrl: string;
}

const sha256 = (b: string) => createHash('sha256').update(b).digest('hex');

/** EC2 GPU families and their quotas (on-demand, vCPUs). */
export const AWS_GPU_QUOTAS = {
  g: { code: 'L-DB2E81BA', name: 'Running On-Demand G and VT instances' },
  p: { code: 'L-417A185B', name: 'Running On-Demand P instances' }
} as const;

/** The quota family of an EC2 type (`g6.xlarge` → g, `p5.48xlarge` → p), or null for a non-GPU type. */
export function awsGpuFamily(type: string): 'g' | 'p' | null {
  if (/^(g\d|vt\d)/.test(type)) return 'g';
  if (/^p\d/.test(type)) return 'p';
  return null;
}

/** vCPUs of an EC2 type from its size (`xlarge` 4, `Nxlarge` 4N, `large` 2, `medium` 1). */
export function awsVcpus(type: string): number {
  const size = type.split('.')[1] ?? '';
  const m = /^(\d+)?xlarge$/.exec(size);
  if (m) return 4 * Number(m[1] ?? 1);
  return size === 'large' ? 2 : size === 'medium' ? 1 : 4;
}

/** Azure: the usage name of a VM size's family and its vCPUs (`Standard_NC40ads_H100_v5` → standardNCADSH100v5Family, 40). */
export function azureFamily(size: string): { family: string; vcpus: number } {
  const parts = size.replace(/^Standard_/, '').split('_');
  const head = parts[0] ?? '';
  const vcpus = Number(/\d+/.exec(head)?.[0] ?? 1);
  return { family: `standard${head.replace(/\d+/, '').toUpperCase()}${parts.slice(1).join('')}Family`, vcpus };
}

const CAPACITY = /InsufficientInstanceCapacity|InsufficientCapacity|InsufficientFreeAddresses|SkuNotAvailable|ZonalAllocationFailed|AllocationFailed|OverconstrainedAllocationRequest|capacity|not available in (this|the) region|is not available/i;

/** Whether a create failed for lack of capacity (and another type or zone may succeed). */
export function isCapacityError(err: unknown): boolean {
  if (!(err instanceof CloudProviderError)) return false;
  return CAPACITY.test(`${err.code ?? ''} ${err.message}`);
}

type GpuSpec = { role?: string; size?: string; max?: number; count?: number; min?: number; capacity?: { sizes?: string[]; zones?: string[] } };

/** The GPU node groups and VMs a plan creates or grows, with how many nodes each adds. */
export function gpuRequests(steps: PlanStep[], desired: DesiredResource[], current: GraphResource[]): { key: string; type: 'node_group' | 'vm'; size: string; nodes: number; region: string }[] {
  const out: { key: string; type: 'node_group' | 'vm'; size: string; nodes: number; region: string }[] = [];
  for (const st of steps) {
    if (st.type !== 'node_group' && st.type !== 'vm') continue;
    if (st.action === 'noop' || st.action === 'delete') continue;
    const want = desired.find((r) => r.key === st.key);
    const p = (want?.spec ?? {}) as GpuSpec;
    if (p.role !== 'gpu' || !p.size) continue;
    const row = current.find((r) => r.key === st.key);
    const had = st.action === 'replace' || !row?.observed ? 0 : st.type === 'vm' ? 1 : Number(row.observed.props.max ?? row.observed.props.count ?? 0) || 0;
    const wantNodes = st.type === 'vm' ? 1 : Math.max(Number(p.max ?? 0), Number(p.count ?? 0), Number(p.min ?? 0));
    const nodes = Math.max(0, wantNodes - had);
    if (nodes > 0) out.push({ key: st.key, type: st.type, size: p.size, nodes, region: st.region });
  }
  return out;
}

export class GpuQuotas {
  constructor(private readonly s: () => Services) {}

  /** The plan's quota refusals (and notes for quotas that could not be read); nothing is called without a GPU request. */
  async check(c: DeploymentContext, steps: PlanStep[], desired: DesiredResource[], current: GraphResource[]): Promise<{ findings: QuotaFinding[]; notes: string[] }> {
    const reqs = gpuRequests(steps, desired, current);
    if (!reqs.length) return { findings: [], notes: [] };
    const provider = c.account.provider;
    const findings: QuotaFinding[] = [];
    const notes: string[] = [];
    try {
      if (provider === 'aws') findings.push(...(await this.aws(c, reqs)));
      else if (provider === 'azure') findings.push(...(await this.azure(c, reqs)));
      else if (provider === 'digitalocean') findings.push(...(await this.digitalocean(c, reqs)));
    } catch (err) {
      notes.push(`The GPU quota could not be read (${String((err as Error).message ?? err).slice(0, 200)}); the provider decides at create time.`);
    }
    return { findings: findings.filter((f) => f.requested > f.available), notes };
  }

  /** The blocker text of a refused quota. */
  static message(f: QuotaFinding): string {
    return `${f.key}: the GPU quota "${f.quota}"${f.code ? ` (${f.code})` : ''} in ${f.region} does not fit: requested ${f.requested} ${f.unit}, available ${f.available} (limit ${f.limit}, in use ${f.inUse}). Ask for an increase: ${f.requestUrl}`;
  }

  // ---------- AWS ----------

  private awsKeys(c: DeploymentContext) {
    if (c.cred.kind !== 'aws') throw new CloudProviderError('An AWS account needs an AWS credential.', 'aws', 400, 'wrong_credential');
    return c.cred;
  }

  /** The account's adapter itself (its transport and endpoints), not the registry's lazy stand-in. */
  private async adapter<T>(c: DeploymentContext): Promise<T & { transport: CloudTransport }> {
    return (await this.s().cloud.providers.adapter(c.account.provider)) as unknown as T & { transport: CloudTransport };
  }

  private async aws(c: DeploymentContext, reqs: ReturnType<typeof gpuRequests>): Promise<QuotaFinding[]> {
    const a = await this.adapter<{ serviceEndpoint(svc: 'ec2' | 'servicequotas', region: string): string }>(c);
    const keys = this.awsKeys(c);
    const out: QuotaFinding[] = [];
    const byRegionFamily = new Map<string, { region: string; family: 'g' | 'p'; vcpus: number; keys: string[] }>();
    for (const r of reqs) {
      const fam = awsGpuFamily(r.size);
      if (!fam) continue;
      const k = `${r.region}|${fam}`;
      const e = byRegionFamily.get(k) ?? { region: r.region, family: fam, vcpus: 0, keys: [] };
      e.vcpus += r.nodes * awsVcpus(r.size);
      e.keys.push(r.key);
      byRegionFamily.set(k, e);
    }
    for (const e of byRegionFamily.values()) {
      const q = AWS_GPU_QUOTAS[e.family];
      const url = new URL('/', `${a.serviceEndpoint('servicequotas', e.region)}/`);
      const body = JSON.stringify({ ServiceCode: 'ec2', QuotaCode: q.code });
      const headers: Record<string, string> = { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'ServiceQuotasV20190624.GetServiceQuota', ...(keys.sessionToken ? { 'x-amz-security-token': keys.sessionToken } : {}) };
      const signed = signV4({ method: 'POST', url, headers, payloadHash: sha256(body), region: e.region, service: 'servicequotas', accessKeyId: keys.accessKeyId, secretAccessKey: keys.secretAccessKey, date: new Date() });
      delete signed.host;
      const r = await a.transport.json<{ Quota?: { Value?: number; QuotaName?: string } }>({ method: 'POST', url, headers: signed, body, accountId: c.account.id, apiClass: 'read' }, (status, b) => ({ message: `Service Quotas answered ${status}: ${String((b as { message?: string })?.message ?? '').slice(0, 200)}`, code: String((b as { __type?: string })?.__type ?? '') || null }));
      const limit = Number(r.body.Quota?.Value ?? 0);
      const inUse = await this.awsInUse(c, e.region, e.family);
      out.push({ key: e.keys.join(', '), provider: 'aws', quota: r.body.Quota?.QuotaName ?? q.name, code: q.code, unit: 'vCPUs', requested: e.vcpus, available: Math.max(0, limit - inUse), limit, inUse, region: e.region, requestUrl: `https://${e.region}.console.aws.amazon.com/servicequotas/home/services/ec2/quotas/${q.code}` });
    }
    return out;
  }

  /** vCPUs of running and pending instances of a GPU family (EC2 DescribeInstances, the query API). */
  private async awsInUse(c: DeploymentContext, region: string, family: 'g' | 'p'): Promise<number> {
    const a = await this.adapter<{ serviceEndpoint(svc: 'ec2' | 'servicequotas', region: string): string }>(c);
    const keys = this.awsKeys(c);
    let total = 0;
    let next: string | null = null;
    for (let page = 0; page < 20; page++) {
      const params = new URLSearchParams({ Action: 'DescribeInstances', Version: '2016-11-15', 'Filter.1.Name': 'instance-state-name', 'Filter.1.Value.1': 'running', 'Filter.1.Value.2': 'pending', MaxResults: '1000', ...(next ? { NextToken: next } : {}) });
      const body = params.toString();
      const url = new URL('/', `${a.serviceEndpoint('ec2', region)}/`);
      const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8', ...(keys.sessionToken ? { 'x-amz-security-token': keys.sessionToken } : {}) };
      const signed = signV4({ method: 'POST', url, headers, payloadHash: sha256(body), region, service: 'ec2', accessKeyId: keys.accessKeyId, secretAccessKey: keys.secretAccessKey, date: new Date() });
      delete signed.host;
      const res = await a.transport.send({ method: 'POST', url, headers: signed, body, accountId: c.account.id, apiClass: 'read' });
      const text = res.body.toString('utf8');
      if (res.status !== 200) throw new CloudProviderError(`EC2 DescribeInstances answered ${res.status}.`, 'aws', res.status, /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? null);
      for (const m of text.matchAll(/<instanceType>([^<]+)<\/instanceType>/g)) if (awsGpuFamily(m[1]!) === family) total += awsVcpus(m[1]!);
      next = /<nextToken>([^<]+)<\/nextToken>/.exec(text)?.[1] ?? null;
      if (!next) break;
    }
    return total;
  }

  // ---------- Azure ----------

  private async azure(c: DeploymentContext, reqs: ReturnType<typeof gpuRequests>): Promise<QuotaFinding[]> {
    if (c.cred.kind !== 'azure') throw new CloudProviderError('An Azure account needs an Azure credential.', 'azure', 400, 'wrong_credential');
    const a = await this.adapter<{ arm: string }>(c);
    const sub = c.account.providerIds.azureSubscriptionId;
    if (!sub) throw new CloudProviderError(`${c.account.name} has no subscription id.`, 'azure', 400, 'no_subscription');
    const token = (await c.cred.getToken('https://management.azure.com/.default')).token;
    const out: QuotaFinding[] = [];
    const byRegion = new Map<string, ReturnType<typeof gpuRequests>>();
    for (const r of reqs) byRegion.set(r.region, [...(byRegion.get(r.region) ?? []), r]);
    for (const [region, list] of byRegion) {
      const url = `${a.arm}/subscriptions/${encodeURIComponent(sub)}/providers/Microsoft.Compute/locations/${encodeURIComponent(region)}/usages?api-version=2024-07-01`;
      const r = await a.transport.json<{ value?: { name?: { value?: string; localizedValue?: string }; currentValue?: number; limit?: number }[] }>({ method: 'GET', url, headers: { authorization: `Bearer ${token}` }, accountId: c.account.id, apiClass: 'read' }, (status, b) => ({ message: `ARM answered ${status} for the compute usages: ${String((b as { error?: { message?: string } })?.error?.message ?? '').slice(0, 200)}`, code: (b as { error?: { code?: string } })?.error?.code ?? null }));
      const usages = r.body.value ?? [];
      const byFamily = new Map<string, { vcpus: number; keys: string[] }>();
      for (const q of list) {
        const f = azureFamily(q.size);
        const e = byFamily.get(f.family) ?? { vcpus: 0, keys: [] };
        e.vcpus += q.nodes * f.vcpus;
        e.keys.push(q.key);
        byFamily.set(f.family, e);
      }
      for (const [family, e] of byFamily) {
        const u = usages.find((x) => (x.name?.value ?? '').toLowerCase() === family.toLowerCase());
        if (!u) continue;
        const limit = Number(u.limit ?? 0);
        const inUse = Number(u.currentValue ?? 0);
        out.push({ key: e.keys.join(', '), provider: 'azure', quota: u.name?.localizedValue ?? family, code: u.name?.value ?? family, unit: 'vCPUs', requested: e.vcpus, available: Math.max(0, limit - inUse), limit, inUse, region, requestUrl: `https://portal.azure.com/#view/Microsoft_Azure_Capacity/QuotaMenuBlade/~/myQuotas` });
      }
    }
    return out;
  }

  // ---------- DigitalOcean ----------

  private async digitalocean(c: DeploymentContext, reqs: ReturnType<typeof gpuRequests>): Promise<QuotaFinding[]> {
    if (c.cred.kind !== 'token') throw new CloudProviderError('A DigitalOcean account needs its token.', 'digitalocean', 400, 'wrong_credential');
    const a = await this.adapter<{ apiBase: string }>(c);
    const headers = { authorization: `Bearer ${c.cred.token}` };
    const describe = (status: number) => ({ message: `DigitalOcean answered ${status} for the account limits.`, code: null });
    const acct = await a.transport.json<{ account?: { droplet_limit?: number } }>({ method: 'GET', url: `${a.apiBase}/v2/account`, headers, accountId: c.account.id, apiClass: 'read' }, describe);
    const drops = await a.transport.json<{ meta?: { total?: number }; droplets?: unknown[] }>({ method: 'GET', url: `${a.apiBase}/v2/droplets?per_page=1`, headers, accountId: c.account.id, apiClass: 'read' }, describe);
    const limit = Number(acct.body.account?.droplet_limit ?? 0);
    const inUse = Number(drops.body.meta?.total ?? drops.body.droplets?.length ?? 0);
    const requested = reqs.reduce((n, r) => n + r.nodes, 0);
    return [{ key: reqs.map((r) => r.key).join(', '), provider: 'digitalocean', quota: 'Droplet limit', code: 'droplet_limit', unit: 'droplets', requested, available: Math.max(0, limit - inUse), limit, inUse, region: reqs[0]!.region, requestUrl: 'https://cloud.digitalocean.com/account/team/droplet_limit_increase' }];
  }

  // ---------- capacity ----------

  /**
   * Runs a GPU create, falling back to the next allowed size, then zone, on a capacity refusal. `onFallback` hears
   * each switch (the audit and the journal note). Anything other than a capacity error is thrown as it came.
   */
  static async withFallback(spec: ResourceSpec, create: (spec: ResourceSpec) => Promise<OperationResult>, onFallback?: (from: { size: string; zone: string | null }, to: { size: string; zone: string | null }, err: CloudProviderError) => Promise<void> | void): Promise<OperationResult> {
    const p = spec.props as GpuSpec & { zone?: string };
    if (p.role !== 'gpu' || !p.size) return create(spec);
    const sizes = [...new Set([p.size, ...(p.capacity?.sizes ?? [])])];
    const zones: (string | null)[] = p.capacity?.zones?.length ? p.capacity.zones : [p.zone ?? null];
    const tries: { size: string; zone: string | null }[] = [];
    for (const z of zones) for (const sz of sizes) tries.push({ size: sz, zone: z });
    let last: CloudProviderError | null = null;
    for (const [i, t] of tries.entries()) {
      const attempt: ResourceSpec = i === 0 && t.zone === (p.zone ?? null) ? spec : { ...spec, idempotencyKey: `${spec.idempotencyKey}#c${i}`, props: { ...spec.props, size: t.size, ...(t.zone ? { zone: t.zone } : {}) } as ResourceSpec['props'] };
      try {
        return await create(attempt);
      } catch (err) {
        if (!isCapacityError(err) || i === tries.length - 1) throw err;
        last = err as CloudProviderError;
        await onFallback?.(t, tries[i + 1]!, last);
      }
    }
    throw last ?? new CloudProviderError('No allowed instance type or zone had capacity.', 'aws', 503, 'no_capacity');
  }
}
