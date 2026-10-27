import { ulid } from 'ulid';
import { z } from 'zod';
import type { Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { conflict, HttpProblem, notFound } from '../http/problem.js';
import { platformTenant } from '../ops/common.js';
import type { Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import type { CloudActor } from './accounts.js';
import { cloudAudit } from './audit.js';
import type { LifecycleSchema } from './drift.js';
import { keyFor } from './drift.js';
import type { DesiredResource, GraphResource, ObservedResource } from './graph.js';
import { idempotencyKey } from './journal.js';
import { CloudProviderError, type CallContext, type CloudProvider, type ResourceType } from './providers/types.js';
import type { CloudAccount } from './types.js';
import { providerProblem } from './validate.js';

/*
 * 1.9.99-final, Sprint 57 (B-10107): the orphan sweep. `cloud.orphans` (every CLOUD_ORPHAN_SWEEP_HOURS, one job per
 * active account; also `POST .../orphans/sweep`) lists, in every region of the account's allow-list, what carries
 * the account's `exprsn:*` tags (or, where a provider keeps no tags, its `exprsn-<account>-` name prefix), and keeps
 * what no graph and no journal knows: no live resource row holds its provider id, and no journal step of a deployment
 * that is not destroyed recorded it. These are the leftovers of a crash or a lost response. Each orphan is adopted
 * into a deployment of the same account (its observed state becomes the desired one), deleted (journalled under the
 * deployment, a recent sign-in and `cloud:admin`), or ignored. A protected type (a database) is never deleted here:
 * adopt it and destroy the deployment, which takes the snapshot and the second admin's approval.
 */

export const ORPHAN_STATES = ['open', 'adopted', 'deleted', 'ignored', 'gone'] as const;
export type OrphanState = (typeof ORPHAN_STATES)[number];

export interface Orphan {
  id: string;
  accountId: string;
  tenantId: string;
  provider: string;
  type: ResourceType;
  providerId: string;
  name: string;
  region: string | null;
  /** Its `exprsn:deployment` tag, when it has one. */
  deploymentName: string | null;
  tags: Record<string, string>;
  observed: ObservedResource;
  state: OrphanState;
  deploymentId: string | null;
  decidedBy: string | null;
  decidedAt: number | null;
  firstSeen: number;
  lastSeen: number;
}

export const orphanListSchema = z.object({ state: z.enum(ORPHAN_STATES).optional() }).strict();

/** Types the sweep lists (DNS records need their zone, so they are found through their deployments' graphs only). */
const SWEPT: readonly ResourceType[] = ['network', 'subnet', 'firewall', 'bucket', 'vm', 'tunnel', 'kubernetes_cluster', 'node_group', 'container_service', 'database', 'cache', 'load_balancer', 'secret'];
const NEVER_DELETED: readonly ResourceType[] = ['database'];
const MIN = 60_000;

function orphanFrom(r: Record<string, unknown>): Orphan {
  return {
    id: String(r.id),
    accountId: String(r.account_id),
    tenantId: String(r.tenant_id),
    provider: String(r.provider),
    type: r.resource_type as ResourceType,
    providerId: String(r.provider_id),
    name: String(r.name),
    region: (r.region as string | null) ?? null,
    deploymentName: (r.deployment_name as string | null) ?? null,
    tags: json(r.tags, {}),
    observed: json<ObservedResource>(r.observed, { type: r.resource_type as ResourceType, providerId: String(r.provider_id), name: String(r.name), state: 'ready', tags: {}, props: {} }),
    state: r.state as OrphanState,
    deploymentId: (r.deployment_id as string | null) ?? null,
    decidedBy: (r.decided_by as string | null) ?? null,
    decidedAt: r.decided_at == null ? null : Number(r.decided_at),
    firstSeen: Number(r.first_seen),
    lastSeen: Number(r.last_seen)
  };
}

export class CloudOrphans {
  /** Polls of one delete operation before the delete is reported as still running. */
  pollRounds = 30;
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());

  constructor(
    private readonly s: () => Services,
    private readonly schema: LifecycleSchema
  ) {}

  private async tenantOf(account: CloudAccount): Promise<string | null> {
    return account.tenantId ?? (await platformTenant(this.s()));
  }

  private async callContext(account: CloudAccount, purpose: 'read' | 'deploy'): Promise<{ provider: CloudProvider; ctx: (region?: string) => CallContext }> {
    const s = this.s();
    if (account.state === 'pending' || account.state === 'disabled') throw conflict(`${account.name} is ${account.state}; nothing is called on it.`);
    const credentials = s.cloud.credentials;
    if (!credentials) throw new HttpProblem(503, 'Not available', 'Cloud credentials are not available in this build.', { extensions: { reason: 'cloud_component_missing' } });
    let cred: CallContext['cred'];
    try {
      cred = (await credentials.for(account, purpose)) as CallContext['cred'];
    } catch (err) {
      throw err instanceof HttpProblem ? err : providerProblem(account, err);
    }
    return { provider: s.cloud.providers.providerFor(account.provider), ctx: (region) => ({ account, cred, ...(region ? { region } : {}) }) };
  }

  /** Provider ids a live graph row holds or a journal step of a deployment that is not destroyed recorded. */
  private async known(accountId: string): Promise<Set<string>> {
    const db = this.s().db;
    const graph = (await db('cloud_resources as r').join('cloud_deployments as d', 'd.id', 'r.deployment_id').where('d.account_id', accountId).whereNot('r.state', 'deleted').whereNotNull('r.provider_id').select('r.provider_id as id')) as { id: string }[];
    const journal = (await db('cloud_operations as o').join('cloud_deployments as d', 'd.id', 'o.deployment_id').where('d.account_id', accountId).whereNot('d.state', 'destroyed').whereNotNull('o.provider_id').distinct('o.provider_id as id')) as { id: string }[];
    return new Set([...graph, ...journal].map((r) => r.id));
  }

  /** Sweeps one account; returns the open orphans. */
  async sweep(account: CloudAccount, actor: CloudActor | null = null): Promise<{ found: Orphan[]; fresh: number; gone: number }> {
    await this.schema.need();
    const s = this.s();
    const tenantId = await this.tenantOf(account);
    if (!tenantId) return { found: [], fresh: 0, gone: 0 };
    const { provider, ctx } = await this.callContext(account, 'read');
    const regions = [...new Set([account.defaultRegion, ...account.regions.map((r) => r.region)].filter((r): r is string => !!r))];
    const seen = new Map<string, ObservedResource>();
    try {
      for (const type of SWEPT) {
        if (provider.supports(type, 'list') !== 'built') continue;
        for (const region of regions.length ? regions : [undefined]) {
          let list: ObservedResource[];
          try {
            list = await provider.list(ctx(region), type, { managedOnly: true });
          } catch (err) {
            if (err instanceof CloudProviderError && err.status === 400) continue;
            throw err;
          }
          for (const o of list) seen.set(`${o.type}|${o.providerId}`, { ...o, ...(o.region || !region ? {} : { region }) });
        }
      }
    } catch (err) {
      if (err instanceof HttpProblem) throw err;
      throw providerProblem(account, err);
    }
    const known = await this.known(account.id);
    const now = Date.now();
    const db = s.db;
    let fresh = 0;
    const still = new Set<string>();
    const newly: Orphan[] = [];
    for (const o of seen.values()) {
      if (known.has(o.providerId)) continue;
      const row = (await db('cloud_orphans').where({ account_id: account.id, resource_type: o.type, provider_id: o.providerId }).first()) as Record<string, unknown> | undefined;
      const patch = { name: (o.name || o.providerId).slice(0, 200), region: o.region ?? null, deployment_name: o.tags['exprsn:deployment']?.slice(0, 63) ?? null, tags: JSON.stringify(o.tags ?? {}), observed: JSON.stringify(o), last_seen: now };
      if (row) {
        still.add(String(row.id));
        if (row.state === 'deleted' || row.state === 'adopted') {
          // Seen again after a decision: an adopted one is known by now; a deleted one came back.
          await db('cloud_orphans').where({ id: row.id }).update({ ...patch, state: 'open', decided_by: null, decided_at: null, deployment_id: null });
        } else await db('cloud_orphans').where({ id: row.id }).update({ ...patch, ...(row.state === 'gone' ? { state: 'open' } : {}) });
        continue;
      }
      const id = ulid();
      await db('cloud_orphans').insert({ id, account_id: account.id, tenant_id: tenantId, provider: account.provider, resource_type: o.type, provider_id: o.providerId, state: 'open', deployment_id: null, decided_by: null, decided_at: null, first_seen: now, ...patch });
      still.add(id);
      fresh++;
      newly.push((await this.get(id))!);
    }
    const goneRows = (await db('cloud_orphans').where({ account_id: account.id }).whereIn('state', ['open', 'ignored']).select('id')) as { id: string }[];
    const gone = goneRows.filter((r) => !still.has(r.id)).map((r) => r.id);
    if (gone.length) await db('cloud_orphans').whereIn('id', gone).update({ state: 'gone', decided_at: now });
    if (newly.length) {
      await cloudAudit(s, { tenantId, action: 'cloud.orphan.found', actor: actor ?? { service: 'cloud.orphans' }, label: 'internal', detail: { account: account.id, accountName: account.name, orphans: newly.slice(0, 50).map((x) => ({ id: x.id, type: x.type, providerId: x.providerId, name: x.name, deployment: x.deploymentName })) } });
      const admins = await s.cloud.accounts.cloudAdmins(tenantId, account.scope === 'platform');
      if (admins.length)
        await s.notifications
          .notify({ tenantId, userIds: admins, kind: 'cloud.orphan', title: `Untracked cloud resources on ${account.name}`, body: `${newly.length} resource${newly.length === 1 ? '' : 's'} tagged for Exprsn-AI that no deployment knows (${newly.slice(0, 3).map((x) => `${x.type} ${x.name}`).join(', ')}). Adopt or delete them.`.slice(0, 300), route: 'deployments', label: 'internal' })
          .catch((err: unknown) => s.log.warn({ err }, 'cloud orphan notice failed'));
    }
    const found = ((await db('cloud_orphans').where({ account_id: account.id, state: 'open' }).orderBy('first_seen', 'desc')) as Record<string, unknown>[]).map(orphanFrom);
    return { found, fresh, gone: gone.length };
  }

  async get(id: string): Promise<Orphan | null> {
    const r = await this.s().db('cloud_orphans').where({ id }).first();
    return r ? orphanFrom(r as Record<string, unknown>) : null;
  }

  /** The orphans of a deployment's account: those tagged for it, and those tagged for no deployment there is. */
  async forDeployment(p: Principal, deploymentId: string, opts: { state?: OrphanState } = {}): Promise<Orphan[]> {
    await this.schema.need();
    const s = this.s();
    const d = await s.cloud.deployments.getFor(p, deploymentId);
    const names = new Set(((await s.db('cloud_deployments').where({ account_id: d.accountId }).select('name')) as { name: string }[]).map((r) => r.name));
    let q = s.db('cloud_orphans').where({ account_id: d.accountId });
    q = opts.state ? q.andWhere({ state: opts.state }) : q.whereIn('state', ['open', 'ignored']);
    const rows = ((await q.orderBy('first_seen', 'desc').limit(500)) as Record<string, unknown>[]).map(orphanFrom);
    return rows.filter((o) => o.deploymentName === d.name || !o.deploymentName || !names.has(o.deploymentName) || o.deploymentId === d.id);
  }

  private async decidable(a: CloudActor, deploymentId: string, orphanId: string) {
    await this.schema.need();
    const s = this.s();
    const d = await s.cloud.deployments.getFor(a.principal, deploymentId);
    s.cloud.deployments.assertCanDeploy(a.principal, d);
    const o = await this.get(orphanId);
    if (!o || o.accountId !== d.accountId) throw notFound('Orphan');
    if (o.state !== 'open' && o.state !== 'ignored') throw conflict(`The orphan is ${o.state}.`);
    return { d, o };
  }

  /** Takes an orphan into a deployment's graph, its observed state becoming the desired one. */
  async adopt(a: CloudActor, deploymentId: string, orphanId: string): Promise<{ orphan: Orphan; resource: GraphResource }> {
    const { d, o } = await this.decidable(a, deploymentId, orphanId);
    const s = this.s();
    if (d.state === 'destroying' || d.state === 'destroyed') throw conflict(`${d.name} is ${d.state}.`);
    const all = await s.cloud.deployments.resources(d.id, { includeDeleted: true });
    const key = keyFor(o.observed.name || o.name, new Set(all.map((r) => r.key)));
    const net = o.observed.locator?.networkId ?? (typeof o.observed.props.networkId === 'string' ? o.observed.props.networkId : null);
    const netRow = net ? all.find((r) => r.type === 'network' && r.providerId === net && r.state !== 'deleted') : undefined;
    const desired: DesiredResource = { key, type: o.type, spec: { ...o.observed.props }, dependsOn: [], protect: o.type === 'database', region: o.region, ...(netRow ? { network: netRow.key } : {}) };
    const resource = await s.cloud.deployments.upsertResource(d.id, desired, o.region ?? d.region, { providerId: o.providerId, locator: o.observed.locator ?? null, observed: o.observed, state: o.observed.state === 'ready' ? 'ready' : o.observed.state, tags: o.tags });
    await s.cloud.deployments.bump(d.id);
    await s.db('cloud_orphans').where({ id: o.id }).update({ state: 'adopted', deployment_id: d.id, decided_by: a.principal.userId, decided_at: Date.now() });
    await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.orphan.adopted', actor: a, deploymentId: d.id, deploymentName: d.name, resource: { key, type: o.type, providerId: o.providerId }, label: d.label, detail: { orphan: o.id } });
    return { orphan: (await this.get(o.id))!, resource };
  }

  async ignore(a: CloudActor, deploymentId: string, orphanId: string): Promise<Orphan> {
    const { d, o } = await this.decidable(a, deploymentId, orphanId);
    await this.s().db('cloud_orphans').where({ id: o.id }).update({ state: 'ignored', decided_by: a.principal.userId, decided_at: Date.now() });
    await cloudAudit(this.s(), { tenantId: d.tenantId, action: 'cloud.orphan.ignored', actor: a, deploymentId: d.id, deploymentName: d.name, resource: { key: '-', type: o.type, providerId: o.providerId }, label: d.label, detail: { orphan: o.id } });
    return (await this.get(o.id))!;
  }

  /** Deletes an orphan at the provider, journalled under the deployment. */
  async delete(a: CloudActor, deploymentId: string, orphanId: string): Promise<{ orphan: Orphan; done: boolean }> {
    const { d, o } = await this.decidable(a, deploymentId, orphanId);
    const s = this.s();
    if (NEVER_DELETED.includes(o.type)) throw new HttpProblem(409, 'Conflict', `A ${o.type} is never deleted as an orphan: adopt it into a deployment and destroy that, which takes a final snapshot and a second admin's approval.`, { extensions: { reason: 'protected_type' } });
    const account = await s.cloud.accounts.get(d.accountId);
    if (!account) throw conflict(`The account of ${d.name} no longer exists.`);
    const { provider, ctx } = await this.callContext(account, 'deploy');
    if (provider.supports(o.type, 'delete') !== 'built') throw new HttpProblem(409, 'Conflict', `This build cannot delete ${o.type.replace(/_/g, ' ')} resources on ${account.provider}.`, { extensions: { reason: 'unsupported' } });
    const key = `orphan-${o.id.slice(-10).toLowerCase()}`;
    const ikey = idempotencyKey(d.id, null, key, 'delete');
    const journal = s.cloud.journal;
    const started = await journal.append({ deploymentId: d.id, planId: null, resourceKey: key, step: 'delete', idempotencyKey: ikey, attempt: 1, state: 'started', providerId: o.providerId });
    const ref = { type: o.type, providerId: o.providerId, ...(o.region ? { region: o.region } : {}), ...(o.observed.locator ? { locator: o.observed.locator } : {}) };
    let done = false;
    let requestId: string | null;
    try {
      const r = await provider.delete(ctx(o.region ?? undefined), ref);
      requestId = r.requestId ?? null;
      if (r.done) done = true;
      else {
        await journal.append({ deploymentId: d.id, planId: null, resourceKey: key, step: 'delete', idempotencyKey: ikey, attempt: 1, state: 'pending', handle: r.operation, providerId: o.providerId, providerRequestId: requestId });
        for (let i = 0; i < this.pollRounds && !done; i++) {
          const p = await provider.poll(ctx(o.region ?? undefined), r.operation);
          if (p.state === 'succeeded') done = true;
          else if (p.state === 'failed') throw new CloudProviderError(p.error, account.provider, 502, p.code ?? null);
          else await this.sleep(Math.min(5000, p.waitMs));
        }
      }
    } catch (err) {
      await journal.append({ deploymentId: d.id, planId: null, resourceKey: key, step: 'delete', idempotencyKey: ikey, attempt: 1, state: 'failed', error: String((err as Error).message ?? err), providerId: o.providerId, providerRequestId: err instanceof CloudProviderError ? err.requestId : null });
      throw err instanceof HttpProblem ? err : providerProblem(account, err);
    }
    const audit = await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.orphan.deleted', actor: a, deploymentId: d.id, deploymentName: d.name, resource: { key, type: o.type, providerId: o.providerId }, operationId: started.id, providerRequestId: requestId, label: d.label, detail: { orphan: o.id, done } });
    if (done) await journal.append({ deploymentId: d.id, planId: null, resourceKey: key, step: 'delete', idempotencyKey: ikey, attempt: 1, state: 'succeeded', providerId: o.providerId, providerRequestId: requestId, auditId: audit.id });
    await s.db('cloud_orphans').where({ id: o.id }).update({ state: done ? 'deleted' : 'open', deployment_id: d.id, decided_by: a.principal.userId, decided_at: Date.now() });
    return { orphan: (await this.get(o.id))!, done };
  }

  /** `cloud.orphans` for one account. */
  async run(accountId: string): Promise<Record<string, unknown>> {
    if (!(await this.schema.installed())) return { skipped: 'migration 149_cloud_lifecycle is not applied' };
    const account = await this.s().cloud.accounts.get(accountId);
    if (!account || account.state === 'pending' || account.state === 'disabled') return { skipped: 'the account is not active' };
    const out = await this.sweep(account);
    return { open: out.found.length, fresh: out.fresh, gone: out.gone };
  }

  async targets(): Promise<{ tenantId: string; payload: Record<string, unknown>; key: string }[]> {
    const s = this.s();
    if (!(await this.schema.installed()) || !(await s.cloud.accounts.installed()) || !(await s.cloud.deployments.installed())) return [];
    const used = (await s.db('cloud_deployments').distinct('account_id')) as { account_id: string }[];
    if (!used.length) return [];
    const platform = await platformTenant(s);
    const rows = (await s.db('cloud_accounts').whereIn('id', used.map((r) => r.account_id)).whereIn('state', ['active', 'attention']).select('id', 'tenant_id')) as { id: string; tenant_id: string | null }[];
    return rows.flatMap((r) => (r.tenant_id ?? platform ? [{ tenantId: (r.tenant_id ?? platform)!, payload: { accountId: r.id }, key: r.id }] : []));
  }

  schedule(scheduler: Scheduler, hours: number): void {
    if (hours > 0) scheduler.every('cloud.orphans', hours * 60 * MIN, () => this.targets());
  }
}
