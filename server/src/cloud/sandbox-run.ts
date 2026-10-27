import { ulid } from 'ulid';
import { platformTenant } from '../ops/common.js';
import type { Services } from '../services.js';
import type { CloudActor } from './accounts.js';
import { cloudAudit } from './audit.js';
import type { Deployment, DesiredResource } from './graph.js';
import { CloudProviderError, type CallContext, type CloudProvider, type ObservedResource, type ResourceType } from './providers/types.js';
import { isManagedBy } from './tags.js';
import type { CloudAccount, Provider } from './types.js';

/*
 * 1.9.99-final, Sprint 62 (B-10804): the nightly sandbox job, `exprsn-ai cloud:sandbox-run` (`cli/cloud-sandbox.ts`)
 * and `.github/workflows/cloud-nightly.yml`. On each dedicated sandbox account (open decision 18) it runs one cycle
 * through the same services a person uses from Deployments: deploy a small graph (plan, apply by hash, the queued
 * verify), introduce drift at the provider by hand, detect it, revert it, upgrade (a reviewed plan that changes the
 * graph in place, then verify again), destroy, and finally check that nothing tagged for the account is left. A
 * sweeper runs before and after the cycle and deletes what carries the account's `exprsn:managed` and
 * `exprsn:account` tags and is older than a day: a crashed earlier run's leftovers.
 *
 * Safety, checked before any provider call and again where it matters:
 * - Only accounts marked `sandbox` (migration `167_cloud_sandbox_flag`); without the column every account is refused.
 * - Only accounts with a monthly budget, and never at or past it (actual or forecast); the budget is asked again
 *   before each stage that adds cost, and an override never counts. Past the budget the cycle goes straight to
 *   destroy and the sweep (they remove cost).
 * - The sweeper deletes only what the provider reports with both tags for this account (the adapters' managedOnly
 *   listing, checked again here), only older than `maxAgeMs`, never a database (destroy takes its final snapshot).
 *   A resource whose age the provider does not report is first recorded (`cloud_sandbox_seen`) and deleted a day later.
 * - `dryRun` makes no change anywhere: the checks, and the listing of what the sweeper would delete.
 *
 * Tests only ever run it against the fakes (`server/test/cloud-sandbox-run.test.ts`); nothing here is run against a
 * real cloud until the owner's sandbox accounts exist.
 */

export const SANDBOX_STAGES = ['preflight', 'sweep', 'deploy', 'verify', 'drift', 'revert', 'upgrade', 'verify-upgrade', 'destroy', 'sweep-after', 'leftovers'] as const;
export type SandboxStage = (typeof SANDBOX_STAGES)[number];
export type StageStatus = 'passed' | 'failed' | 'skipped' | 'dry_run';

export interface SandboxStageResult {
  stage: SandboxStage;
  status: StageStatus;
  detail: string;
  at: number;
}

export interface SweptResource {
  type: ResourceType;
  providerId: string;
  name: string;
  region: string | null;
  ageMs: number | null;
  /** Why it was kept (too young, a database, unsupported), or null when it was (or would be) deleted. */
  kept: string | null;
}

export interface SweepReport {
  deleted: SweptResource[];
  kept: SweptResource[];
  failed: { type: ResourceType; providerId: string; error: string }[];
}

export interface SandboxAccountReport {
  accountId: string;
  name: string | null;
  provider: Provider | null;
  status: 'passed' | 'failed' | 'refused' | 'dry_run';
  /** Why the account was refused (`sandbox_flag_missing`, `not_sandbox`, `no_budget`, `budget_exceeded`, ...). */
  refusal: string | null;
  deploymentId: string | null;
  stages: SandboxStageResult[];
  sweeps: SweepReport[];
  /** Tagged resources still in the account after the cycle (the done-when is zero). */
  leftovers: number;
}

export interface SandboxRunReport {
  runId: string;
  dryRun: boolean;
  startedAt: number;
  finishedAt: number;
  ok: boolean;
  accounts: SandboxAccountReport[];
}

export interface SandboxRunOptions {
  accountIds: string[];
  /** The person the cycle acts as (a cloud admin; a platform account also needs platform:manage). */
  actor: CloudActor;
  dryRun?: boolean;
  /** The sweeper's age limit (default a day). */
  maxAgeMs?: number;
  /** How long one stage may wait for its jobs (default 45 minutes). */
  stageTimeoutMs?: number;
  /** Wait between job rounds (default 5 s; tests 0). */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Progress lines (the CLI prints them). */
  log?: (line: string) => void;
}

export const SANDBOX_MAX_AGE_MS = 24 * 60 * 60_000;
/** Types the sweeper lists, dependents first, so a network goes after what lives in it. */
const SWEEP_ORDER: readonly ResourceType[] = ['vm', 'node_group', 'kubernetes_cluster', 'container_service', 'load_balancer', 'cache', 'database', 'firewall', 'subnet', 'network', 'bucket', 'tunnel', 'secret'];
/** Never deleted by the sweeper: destroy takes their final snapshot under dual control. */
const NEVER_SWEPT: readonly ResourceType[] = ['database'];

/** The small graph per provider: zero-cost or near-zero resources that still exercise create, update and delete. */
export interface SandboxProfile {
  deploy: DesiredResource[];
  upgrade: DesiredResource[];
  /** `rule`: open SSH on `driftKey` by hand; `delete`: delete `driftKey` by hand (Cloudflare buckets change nothing in place). */
  drift: 'rule' | 'delete';
  driftKey: string;
}

const net = (cidr: string): DesiredResource => ({ key: 'core', type: 'network', spec: { cidr }, dependsOn: [], protect: false, region: null });
const web = (ports: string[], inNetwork: boolean): DesiredResource => ({
  key: 'web',
  type: 'firewall',
  spec: { ingress: ports.map((p) => ({ protocol: 'tcp', ports: p, sources: ['10.0.0.0/8'] })) },
  dependsOn: [],
  ...(inNetwork ? { network: 'core' } : {}),
  protect: false,
  region: null
});
const bucket = (key: string): DesiredResource => ({ key, type: 'bucket', spec: { publicAccess: false }, dependsOn: [], protect: false, region: null });

export function sandboxProfile(provider: Provider): SandboxProfile {
  if (provider === 'cloudflare') return { deploy: [bucket('assets')], upgrade: [bucket('assets'), bucket('assets-next')], drift: 'delete', driftKey: 'assets' };
  // DigitalOcean firewalls are not inside a VPC; AWS security groups and Azure NSGs are created in the network.
  const inNetwork = provider !== 'digitalocean';
  return { deploy: [net('10.77.0.0/20'), web(['443'], inNetwork)], upgrade: [net('10.77.0.0/20'), web(['443', '8443'], inNetwork)], drift: 'rule', driftKey: 'web' };
}

/** Carries this account's `exprsn:*` tags, or (on a type the provider keeps no tags for) came from the name-prefix listing. */
const managed = (provider: CloudProvider, type: ResourceType, account: CloudAccount, r: ObservedResource): boolean => isManagedBy(account.name, r.tags ?? {}) || provider.capabilities[type]?.tagging === 'name';

const stamp = (t: number) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');

export class CloudSandboxRun {
  constructor(private readonly s: () => Services) {}

  /** True when migration 167 is applied. */
  async installed(): Promise<boolean> {
    const db = this.s().db;
    return (await db.schema.hasTable('cloud_accounts')) && (await db.schema.hasColumn('cloud_accounts', 'sandbox')) && (await db.schema.hasTable('cloud_sandbox_runs'));
  }

  /** Why an account may not be used (null: it may). Calls no provider. */
  async refusal(accountId: string, o: { dryRun?: boolean } = {}): Promise<{ reason: string; detail: string; account: CloudAccount | null } | null> {
    const s = this.s();
    if (!(await this.installed())) return { reason: 'sandbox_flag_missing', detail: 'Migration 167_cloud_sandbox_flag is not applied, so no account is marked sandbox.', account: null };
    const account = await s.cloud.accounts.get(accountId);
    if (!account) return { reason: 'unknown_account', detail: `No cloud account ${accountId}.`, account: null };
    const row = (await s.db('cloud_accounts').where({ id: accountId }).first('sandbox')) as { sandbox?: unknown } | undefined;
    if (!row || !(row.sandbox === true || row.sandbox === 1 || row.sandbox === '1')) return { reason: 'not_sandbox', detail: `${account.name} is not marked as a sandbox account; the job never runs on any other.`, account };
    if (account.state !== 'active' && account.state !== 'attention') return { reason: 'account_not_active', detail: `${account.name} is ${account.state}.`, account };
    const over = await this.overBudget(account);
    if (over) return { ...over, account };
    void o;
    return null;
  }

  /** The budget check: a budget must exist, and spend (actual and forecast) must be under it. Overrides never count. */
  async overBudget(account: CloudAccount): Promise<{ reason: string; detail: string } | null> {
    const budgets = this.s().cloud.budgets;
    if (!(await budgets.installed())) return { reason: 'no_budget', detail: 'Migration 152_cloud_budgets is not applied, so the account has no budget cap.' };
    const b = await budgets.get(account.id);
    if (!b) return { reason: 'no_budget', detail: `${account.name} has no monthly budget; a sandbox account needs a cap (open decision 18).` };
    const st = await budgets.statusOf(b);
    if (st.pctActual >= 100 || st.pctForecast >= 100) return { reason: 'budget_exceeded', detail: `${account.name} is at ${st.pctActual} % actual and ${st.pctForecast} % forecast of its ${b.amount} ${b.currency} budget.` };
    return null;
  }

  private async tenantOf(account: CloudAccount): Promise<string | null> {
    return account.tenantId ?? (await platformTenant(this.s()));
  }

  private async callContext(account: CloudAccount, purpose: 'read' | 'deploy'): Promise<{ provider: CloudProvider; ctx: (region?: string) => CallContext }> {
    const s = this.s();
    const credentials = s.cloud.credentials;
    if (!credentials) throw new Error('Cloud credentials are not available in this build.');
    const cred = (await credentials.for(account, purpose)) as CallContext['cred'];
    return { provider: s.cloud.providers.providerFor(account.provider), ctx: (region) => ({ account, cred, ...(region ? { region } : {}) }) };
  }

  /** The age of a tagged resource: the graph row that made it, the provider's own date, or when the sweeper first saw it. */
  private async ageOf(account: CloudAccount, o: ObservedResource, now: number, dryRun: boolean): Promise<number | null> {
    const db = this.s().db;
    const row = (await db('cloud_resources as r').join('cloud_deployments as d', 'd.id', 'r.deployment_id').where('d.account_id', account.id).andWhere('r.provider_id', o.providerId).min({ at: 'r.created_at' }).first()) as { at?: unknown } | undefined;
    const fromGraph = row?.at == null ? null : Number(row.at);
    const p = o.props as Record<string, unknown>;
    const raw = p.createdAt ?? p.created_at ?? p.creationDate ?? p.creation_date ?? p.createTime;
    const fromProvider = typeof raw === 'number' ? raw : typeof raw === 'string' && !Number.isNaN(Date.parse(raw)) ? Date.parse(raw) : null;
    const seen = (await db('cloud_sandbox_seen').where({ account_id: account.id, resource_type: o.type, provider_id: o.providerId }).first('first_seen')) as { first_seen?: unknown } | undefined;
    let fromSeen = seen?.first_seen == null ? null : Number(seen.first_seen);
    if (fromSeen == null && fromGraph == null && fromProvider == null) {
      if (!dryRun) await db('cloud_sandbox_seen').insert({ account_id: account.id, resource_type: o.type, provider_id: o.providerId, first_seen: now }).catch(() => undefined);
      fromSeen = null;
    }
    const known = [fromGraph, fromProvider, fromSeen].filter((x): x is number => x != null);
    return known.length ? now - Math.min(...known) : null;
  }

  /**
   * Deletes what carries this account's `exprsn:*` tags and is older than `maxAgeMs`. Untagged resources are never
   * touched, whatever the adapter's listing returned; a database is never deleted here.
   */
  async sweep(account: CloudAccount, o: { actor: CloudActor; dryRun?: boolean; maxAgeMs?: number; now?: number } = {} as never): Promise<SweepReport> {
    const refused = await this.refusal(account.id);
    if (refused && !(refused.reason === 'budget_exceeded')) throw new Error(`sandbox_refused: ${refused.reason}: ${refused.detail}`);
    const s = this.s();
    const now = o.now ?? Date.now();
    const maxAge = o.maxAgeMs ?? SANDBOX_MAX_AGE_MS;
    const { provider, ctx } = await this.callContext(account, o.dryRun ? 'read' : 'deploy');
    const regions = [...new Set([account.defaultRegion, ...account.regions.map((r) => r.region)].filter((r): r is string => !!r))];
    const out: SweepReport = { deleted: [], kept: [], failed: [] };
    const tenantId = await this.tenantOf(account);
    for (const type of SWEEP_ORDER) {
      if (provider.supports(type, 'list') !== 'built') continue;
      const seen = new Map<string, ObservedResource>();
      for (const region of regions.length ? regions : [undefined]) {
        let list: ObservedResource[];
        try {
          list = await provider.list(ctx(region), type, { managedOnly: true });
        } catch (err) {
          if (err instanceof CloudProviderError && err.status === 400) continue;
          throw err;
        }
        for (const r of list) seen.set(r.providerId, { ...r, ...(r.region || !region ? {} : { region }) });
      }
      for (const r of seen.values()) {
        // The listing asked for managed resources only; the tags are checked again here, so an adapter or a provider
        // that ignored the filter can never make the sweeper delete something Exprsn-AI did not tag. Where the
        // provider keeps no tags on the type (DigitalOcean firewalls, Cloudflare), the mark is the `exprsn-<account>-`
        // name prefix the adapter's managed listing filters on.
        if (!managed(provider, type, account, r)) continue;
        const age = await this.ageOf(account, r, now, !!o.dryRun);
        const item: SweptResource = { type, providerId: r.providerId, name: r.name, region: r.region ?? null, ageMs: age, kept: null };
        if (NEVER_SWEPT.includes(type)) item.kept = 'a database is deleted only by destroy, after its final snapshot';
        else if (age == null) item.kept = 'age unknown: first seen now, deleted once a day old';
        else if (age < maxAge) item.kept = `younger than ${Math.round(maxAge / 3_600_000)} h`;
        else if (provider.supports(type, 'delete') !== 'built') item.kept = `this build cannot delete ${type} on ${account.provider}`;
        if (item.kept) {
          out.kept.push(item);
          continue;
        }
        if (o.dryRun) {
          out.deleted.push(item);
          continue;
        }
        try {
          const res = await provider.delete(ctx(r.region ?? undefined), { type, providerId: r.providerId, ...(r.region ? { region: r.region } : {}), ...(r.locator ? { locator: r.locator } : {}) });
          if (!res.done) {
            for (let i = 0; i < 60; i++) {
              const p = await provider.poll(ctx(r.region ?? undefined), res.operation);
              if (p.state === 'succeeded') break;
              if (p.state === 'failed') throw new Error(p.error);
              await (this.sleepFn ?? ((ms: number) => new Promise((x) => setTimeout(x, ms))))(Math.min(5000, p.waitMs));
            }
          }
          await s.db('cloud_resources as r').whereIn('r.deployment_id', s.db('cloud_deployments').where({ account_id: account.id }).select('id')).andWhere('r.provider_id', r.providerId).update({ state: 'deleted', updated_at: Date.now() });
          await s.db('cloud_sandbox_seen').where({ account_id: account.id, resource_type: type, provider_id: r.providerId }).delete();
          out.deleted.push(item);
          if (tenantId) await cloudAudit(s, { tenantId, action: 'cloud.sandbox.swept', actor: o.actor, resource: { key: r.name || r.providerId, type, providerId: r.providerId }, providerRequestId: res.requestId ?? null, label: 'internal', detail: { account: account.id, ageMs: age } });
        } catch (err) {
          out.failed.push({ type, providerId: r.providerId, error: String((err as Error).message ?? err).slice(0, 300) });
        }
      }
    }
    return out;
  }

  /** Tagged resources left in the account (any age), for the done-when "nothing left in the accounts". */
  async leftovers(account: CloudAccount): Promise<{ type: ResourceType; providerId: string; name: string }[]> {
    const { provider, ctx } = await this.callContext(account, 'read');
    const regions = [...new Set([account.defaultRegion, ...account.regions.map((r) => r.region)].filter((r): r is string => !!r))];
    const out = new Map<string, { type: ResourceType; providerId: string; name: string }>();
    for (const type of SWEEP_ORDER) {
      if (provider.supports(type, 'list') !== 'built') continue;
      for (const region of regions.length ? regions : [undefined]) {
        try {
          for (const r of await provider.list(ctx(region), type, { managedOnly: true })) if (managed(provider, type, account, r)) out.set(`${type}|${r.providerId}`, { type, providerId: r.providerId, name: r.name });
        } catch (err) {
          if (err instanceof CloudProviderError && err.status === 400) continue;
          throw err;
        }
      }
    }
    return [...out.values()];
  }

  private sleepFn: ((ms: number) => Promise<void>) | null = null;

  /** Runs due jobs (this process is a worker too) until `until` holds or the stage's time is up. */
  private async settle(until: () => Promise<boolean>, o: SandboxRunOptions): Promise<boolean> {
    const s = this.s();
    const end = Date.now() + (o.stageTimeoutMs ?? 45 * 60_000);
    const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (;;) {
      await s.jobs.runDue();
      await s.cloud.lifecycle.idle();
      if (await until()) return true;
      if (Date.now() > end) return false;
      await sleep(o.pollMs ?? 5000);
    }
  }

  private async applyAndWait(o: SandboxRunOptions, d: Deployment, desired: DesiredResource[]): Promise<{ ok: boolean; detail: string; planId: string }> {
    const s = this.s();
    const plan = await s.cloud.plans.create(o.actor, d.id, desired);
    if (!plan.applicable) return { ok: false, detail: `The plan is not applicable: ${plan.blockers.slice(0, 5).join('; ')}`, planId: plan.id };
    await s.cloud.plans.apply(o.actor, plan.id, plan.hash);
    const done = await this.settle(async () => {
      const p = await s.cloud.plans.load(plan.id);
      const dep = await s.cloud.deployments.get(d.id);
      return !!p && ['applied', 'failed', 'cancelled'].includes(p.state) && !!dep && dep.state !== 'applying';
    }, o);
    const after = await s.cloud.plans.load(plan.id);
    if (!done || after?.state !== 'applied') return { ok: false, detail: `Plan ${plan.id} ended ${after?.state ?? 'unknown'}${done ? '' : ' (timed out)'}.`, planId: plan.id };
    return { ok: true, detail: `Plan ${plan.id} applied (${JSON.stringify(plan.summary)}).`, planId: plan.id };
  }

  private async verified(o: SandboxRunOptions, d: Deployment): Promise<{ ok: boolean; detail: string }> {
    const s = this.s();
    await this.settle(async () => {
      const dep = await s.cloud.deployments.get(d.id);
      return !!dep && ['ready', 'degraded'].includes(dep.state);
    }, o);
    const dep = await s.cloud.deployments.get(d.id);
    return dep?.state === 'ready' && dep.health === 'healthy' ? { ok: true, detail: 'Verify passed; the deployment is ready.' } : { ok: false, detail: `Verify did not pass: the deployment is ${dep?.state ?? 'gone'} (${dep?.health ?? 'unknown'}).` };
  }

  /** Changes a resource at the provider outside any plan, as a person would by hand. */
  private async introduceDrift(o: SandboxRunOptions, d: Deployment, profile: SandboxProfile): Promise<string> {
    const s = this.s();
    const row = await s.cloud.deployments.resource(d.id, profile.driftKey);
    if (!row?.providerId) throw new Error(`${profile.driftKey} has no provider id.`);
    const c = await s.cloud.deployments.context(d, 'deploy');
    const ref = { type: row.type, providerId: row.providerId, region: row.region, ...(row.locator ? { locator: row.locator } : {}) };
    let res;
    if (profile.drift === 'delete') res = await c.provider.delete(c.ctx(row.region), ref);
    else {
      const rows = await s.cloud.deployments.resources(d.id);
      const ids = new Map(rows.map((r) => [r.key, r.providerId]));
      const spec = s.cloud.deployments.specFor(d, c.account, row.desired, `sandbox-drift-${d.id}`, ids);
      const ingress = [...((row.desired.spec as { ingress?: unknown[] }).ingress ?? []), { protocol: 'tcp', ports: '22', sources: ['10.0.0.0/8'] }];
      res = await c.provider.update(c.ctx(row.region), ref, { ...spec, props: { ...(spec.props as Record<string, unknown>), ingress } as never });
    }
    if (!res.done) {
      for (let i = 0; i < 60; i++) {
        const p = await c.provider.poll(c.ctx(row.region), res.operation);
        if (p.state !== 'pending') break;
        await (o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(Math.min(5000, p.waitMs));
      }
    }
    await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.sandbox.drift', actor: o.actor, deploymentId: d.id, deploymentName: d.name, resource: { key: row.key, type: row.type, providerId: row.providerId }, providerRequestId: res.requestId ?? null, label: d.label, detail: { how: profile.drift } });
    return profile.drift === 'delete' ? `Deleted ${row.key} (${row.providerId}) at the provider by hand.` : `Opened port 22 on ${row.key} (${row.providerId}) at the provider by hand.`;
  }

  /** One account's cycle. */
  async runAccount(accountId: string, o: SandboxRunOptions): Promise<SandboxAccountReport> {
    const s = this.s();
    this.sleepFn = o.sleep ?? null;
    const report: SandboxAccountReport = { accountId, name: null, provider: null, status: 'failed', refusal: null, deploymentId: null, stages: [], sweeps: [], leftovers: 0 };
    const log = (line: string) => o.log?.(`[${accountId}] ${line}`);
    const stage = (name: SandboxStage, status: StageStatus, detail: string) => {
      report.stages.push({ stage: name, status, detail: detail.slice(0, 1000), at: Date.now() });
      log(`${name}: ${status}: ${detail}`);
      return status;
    };
    const refused = await this.refusal(accountId);
    if (refused) {
      report.name = refused.account?.name ?? null;
      report.provider = refused.account?.provider ?? null;
      report.status = 'refused';
      report.refusal = refused.reason;
      stage('preflight', 'failed', `${refused.reason}: ${refused.detail}`);
      return report;
    }
    const account = (await s.cloud.accounts.get(accountId))!;
    report.name = account.name;
    report.provider = account.provider;
    stage('preflight', 'passed', `${account.name} (${account.provider}) is a sandbox account under its budget.`);
    const profile = sandboxProfile(account.provider);

    if (o.dryRun) {
      const sw = await this.sweep(account, { actor: o.actor, dryRun: true, ...(o.maxAgeMs != null ? { maxAgeMs: o.maxAgeMs } : {}) });
      report.sweeps.push(sw);
      stage('sweep', 'dry_run', `Would delete ${sw.deleted.length}, keep ${sw.kept.length}.`);
      for (const name of SANDBOX_STAGES.slice(2, -2)) stage(name, 'dry_run', name === 'deploy' ? `Would plan ${profile.deploy.map((r) => `${r.type} ${r.key}`).join(', ')}.` : 'Not run (dry run).');
      report.status = 'dry_run';
      return report;
    }

    let d: Deployment | null = null;
    let failed = false;
    const fail = (name: SandboxStage, detail: string) => {
      failed = true;
      stage(name, 'failed', detail);
    };
    try {
      const sw = await this.sweep(account, { actor: o.actor, ...(o.maxAgeMs != null ? { maxAgeMs: o.maxAgeMs } : {}) });
      report.sweeps.push(sw);
      stage('sweep', sw.failed.length ? 'failed' : 'passed', `Deleted ${sw.deleted.length} tagged resources older than the limit, kept ${sw.kept.length}${sw.failed.length ? `, ${sw.failed.length} failed` : ''}.`);

      const budgetStop = async (name: SandboxStage): Promise<boolean> => {
        const over = await this.overBudget(account);
        if (over) fail(name, `${over.reason}: ${over.detail} Nothing more that adds cost runs; the cycle goes to destroy.`);
        return !!over;
      };

      if (!(await budgetStop('deploy'))) {
        d = await s.cloud.deployments.create(o.actor, { name: `sandbox-${stamp(Date.now())}-${ulid().slice(-6).toLowerCase()}`, accountId: account.id, label: 'internal', description: 'B-10804 nightly sandbox cycle' });
        report.deploymentId = d.id;
        const dep = await this.applyAndWait(o, d, profile.deploy);
        if (!dep.ok) fail('deploy', dep.detail);
        else stage('deploy', 'passed', dep.detail);
      }

      if (d && !failed) {
        const v = await this.verified(o, d);
        if (v.ok) stage('verify', 'passed', v.detail);
        else fail('verify', v.detail);
      }

      if (d && !failed) {
        const how = await this.introduceDrift(o, d, profile);
        const found = await s.cloud.lifecycle.drift.detect((await s.cloud.deployments.get(d.id))!);
        const mine = found.open.filter((f) => f.key === profile.driftKey);
        if (!mine.length) fail('drift', `${how} Drift detection found nothing.`);
        else {
          stage('drift', 'passed', `${how} Found ${mine.map((f) => `${f.kind} ${f.path ?? ''}`.trim()).join(', ')}.`);
          const decided = await s.cloud.lifecycle.drift.decide(o.actor, d.id, mine[0]!.id, { decision: 'revert', apply: true });
          const planId = decided.plan?.id;
          const ok = await this.settle(async () => {
            const p = planId ? await s.cloud.plans.load(planId) : null;
            return !p || ['applied', 'failed', 'cancelled'].includes(p.state);
          }, o);
          const clean = await s.cloud.lifecycle.drift.detect((await s.cloud.deployments.get(d.id))!);
          const p = planId ? await s.cloud.plans.load(planId) : null;
          if (!ok || p?.state !== 'applied' || clean.open.length) fail('revert', `The revert plan ended ${p?.state ?? 'unknown'}; ${clean.open.length} drift findings are still open.`);
          else stage('revert', 'passed', `Reverted by plan ${planId}; no drift is open.`);
        }
      }

      if (d && !failed && !(await budgetStop('upgrade'))) {
        const up = await this.applyAndWait(o, (await s.cloud.deployments.get(d.id))!, profile.upgrade);
        if (!up.ok) fail('upgrade', up.detail);
        else {
          stage('upgrade', 'passed', up.detail);
          const v = await this.verified(o, d);
          if (v.ok) stage('verify-upgrade', 'passed', v.detail);
          else fail('verify-upgrade', v.detail);
        }
      }
    } catch (err) {
      fail(report.stages.length ? SANDBOX_STAGES[Math.min(report.stages.length, SANDBOX_STAGES.length - 1)]! : 'preflight', `Stopped: ${String((err as Error).message ?? err).slice(0, 500)}`);
    }

    // Destroy and sweep always run: they remove cost, whatever happened above and whatever the budget says.
    try {
      if (d) {
        const cur = await s.cloud.deployments.get(d.id);
        if (cur && cur.state !== 'destroyed') {
          await this.settle(async () => {
            const x = await s.cloud.deployments.get(d!.id);
            return !!x && x.state !== 'applying';
          }, o);
          await s.cloud.lifecycle.destroys.request(o.actor, d.id, { reason: 'B-10804 nightly sandbox cycle' });
          const gone = await this.settle(async () => (await s.cloud.deployments.get(d!.id))?.state === 'destroyed', o);
          if (gone) stage('destroy', 'passed', `${d.name} is destroyed.`);
          else fail('destroy', `${d.name} is ${(await s.cloud.deployments.get(d.id))?.state ?? 'gone'} after the destroy.`);
        }
      } else stage('destroy', 'skipped', 'Nothing was deployed.');
    } catch (err) {
      fail('destroy', `Stopped: ${String((err as Error).message ?? err).slice(0, 500)}`);
    }
    try {
      const sw = await this.sweep(account, { actor: o.actor, ...(o.maxAgeMs != null ? { maxAgeMs: o.maxAgeMs } : {}) });
      report.sweeps.push(sw);
      if (sw.failed.length) fail('sweep-after', `${sw.failed.length} deletions failed.`);
      else stage('sweep-after', 'passed', `Deleted ${sw.deleted.length}, kept ${sw.kept.length}.`);
      const left = await this.leftovers(account);
      report.leftovers = left.length;
      if (left.length) fail('leftovers', `${left.length} tagged resources are left: ${left.slice(0, 10).map((r) => `${r.type} ${r.providerId}`).join(', ')}.`);
      else stage('leftovers', 'passed', 'Nothing tagged for the account is left.');
    } catch (err) {
      fail('sweep-after', `Stopped: ${String((err as Error).message ?? err).slice(0, 500)}`);
    }
    report.status = failed ? 'failed' : 'passed';
    return report;
  }

  /** The nightly run over several accounts; each account's report is kept in `cloud_sandbox_runs`. */
  async run(o: SandboxRunOptions): Promise<SandboxRunReport> {
    const s = this.s();
    const runId = ulid();
    const startedAt = Date.now();
    const accounts: SandboxAccountReport[] = [];
    for (const id of [...new Set(o.accountIds)]) {
      const t0 = Date.now();
      const r = await this.runAccount(id, o);
      accounts.push(r);
      if (await this.installed()) await s.db('cloud_sandbox_runs').insert({ id: ulid(), run_id: runId, account_id: id.slice(0, 26), status: r.status, dry_run: !!o.dryRun, report: JSON.stringify(r), leftovers: r.leftovers, started_at: t0, finished_at: Date.now() });
      const account = await s.cloud.accounts.get(id).catch(() => null);
      const tenantId = account ? await this.tenantOf(account) : await platformTenant(s);
      if (tenantId) await cloudAudit(s, { tenantId, action: 'cloud.sandbox.run', actor: o.actor, deploymentId: r.deploymentId, label: 'internal', detail: { run: runId, account: id, status: r.status, refusal: r.refusal, dryRun: !!o.dryRun, leftovers: r.leftovers, stages: r.stages.map((x) => `${x.stage}:${x.status}`) } });
    }
    const ok = accounts.length > 0 && accounts.every((a) => a.status === 'passed' || a.status === 'dry_run');
    return { runId, dryRun: !!o.dryRun, startedAt, finishedAt: Date.now(), ok, accounts };
  }

  /** The last runs of an account, newest first, and how many in a row passed with nothing left. */
  async history(accountId: string, limit = 14): Promise<{ runs: { runId: string; status: string; leftovers: number; startedAt: number; dryRun: boolean }[]; consecutivePasses: number }> {
    if (!(await this.installed())) return { runs: [], consecutivePasses: 0 };
    const rows = (await this.s().db('cloud_sandbox_runs').where({ account_id: accountId, dry_run: false }).orderBy('started_at', 'desc').limit(limit)) as Record<string, unknown>[];
    const runs = rows.map((r) => ({ runId: String(r.run_id), status: String(r.status), leftovers: Number(r.leftovers), startedAt: Number(r.started_at), dryRun: !!r.dry_run }));
    let consecutivePasses = 0;
    for (const r of runs) {
      if (r.status !== 'passed' || r.leftovers) break;
      consecutivePasses++;
    }
    return { runs, consecutivePasses };
  }

  /**
   * Marks or unmarks an account as a sandbox (the CLI's `--mark`, `--unmark`; the operator on the host). Marking needs
   * a budget and refuses an account with a deployment the sandbox job did not make, so a production account is never
   * marked by mistake.
   */
  async mark(accountId: string, on: boolean, actor: CloudActor | { service: string }): Promise<CloudAccount> {
    const s = this.s();
    if (!(await this.installed())) throw new Error('Migration 167_cloud_sandbox_flag is not applied.');
    const account = await s.cloud.accounts.get(accountId);
    if (!account) throw new Error(`No cloud account ${accountId}.`);
    if (on) {
      if (!(await s.cloud.budgets.installed()) || !(await s.cloud.budgets.get(account.id))) throw new Error(`${account.name} has no monthly budget: set its cap first (open decision 18).`);
      if (await s.cloud.deployments.installed()) {
        const other = (await s.db('cloud_deployments').where({ account_id: account.id }).whereNot('state', 'destroyed').select('name')) as { name: string }[];
        const foreign = other.filter((r) => !r.name.startsWith('sandbox-'));
        if (foreign.length) throw new Error(`${account.name} has deployments the sandbox job did not make (${foreign.slice(0, 5).map((r) => r.name).join(', ')}); a sandbox account holds nothing else.`);
      }
    }
    await s.db('cloud_accounts').where({ id: account.id }).update({ sandbox: on, updated_at: Date.now() });
    const tenantId = await this.tenantOf(account);
    if (tenantId) await cloudAudit(s, { tenantId, action: on ? 'cloud.sandbox.marked' : 'cloud.sandbox.unmarked', actor, label: 'internal', detail: { account: account.id, name: account.name } });
    return (await s.cloud.accounts.get(account.id))!;
  }
}
