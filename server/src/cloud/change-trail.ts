import { json } from '../db/knex.js';
import type { Services } from '../services.js';
import type { DeploymentContext } from './deployments.js';
import type { DriftFinding } from './drift.js';
import type { Deployment, ObservedResource } from './graph.js';
import { CloudProviderError, type ChangeEvent, type CloudProvider } from './providers/types.js';
import type { CloudAccount } from './types.js';

/*
 * 1.9.99-final, Sprint 62 (B-10703): the out-of-band change trail. For each open drift finding, who changed the
 * resource and when, from the provider's own record of it:
 *
 *   AWS           CloudTrail `LookupEvents` by resource name, in the resource's region (`cloudtrail:LookupEvents`)
 *   Azure         the Activity Log's administrative events by `resourceUri` (`Microsoft.Insights/eventtypes/values/read`)
 *   Cloudflare    the account's audit logs, matched by the resource's ids or DNS name ("Account Settings Read")
 *   DigitalOcean  no trail this build reads (`unsupported`, nothing is called)
 *
 * Bounded, as CloudTrail allows two lookups a second per account and region: only resources with open findings are
 * looked up, only in the window before the finding was first seen (24 hours up to its first sighting), at most ten
 * lookups per drift run, each through the adapter's transport (the egress guard, the per-account limiter and breaker).
 * Trails arrive late (CloudTrail delivers within about 15 minutes), so a finding with nothing found yet is asked again
 * on later runs, at most four times and for six hours after it was first seen; then it is `not_found`. A change made
 * by Exprsn-AI's own credential (the principal the account's last validation saw) is kept but not chosen while
 * another principal's change is in the window.
 *
 * Results are cached per finding in `cloud_change_trail` (migration 165, not registered yet); without it nothing is
 * looked up and every finding answers `changedBy: null` with the trail `unavailable`. A failed lookup never fails the
 * drift run: the finding's trail says `error` and the next run tries again.
 */

export const TRAIL_STATES = ['pending', 'found', 'not_found', 'unsupported', 'error', 'unavailable'] as const;
export type TrailState = (typeof TRAIL_STATES)[number];

/** Who changed the resource, as the drift finding's API answer carries it. */
export interface ChangedBy {
  principal: string;
  principalType: string | null;
  /** When the change was made (ms since the epoch). */
  at: number;
  action: string;
  source: string;
  eventId: string | null;
  sourceIp: string | null;
  /** The change was made with Exprsn-AI's own credential (shown, never preferred over another principal's). */
  byExprsn: boolean;
}

export interface ChangeTrail {
  state: TrailState;
  provider: string | null;
  attempts: number;
  /** The window asked about (ms since the epoch), or null before any lookup. */
  window: { from: number; to: number } | null;
  /** Up to five changes found in the window, newest first. */
  events: (ChangeEvent & { byExprsn: boolean })[];
  checkedAt: number | null;
  error: string | null;
}

export interface TrailOptions {
  /** How far before the finding's first sighting the window opens (default 24 h). */
  windowMs: number;
  /** Lookups at most per drift run (default 10). */
  maxLookups: number;
  /** Lookups at most per finding (default 4). */
  maxAttempts: number;
  /** How long after its first sighting a finding with nothing found is asked again (default 6 h). */
  retryForMs: number;
  now: () => number;
}

const HOUR = 3_600_000;
const SCHEMA_RECHECK_MS = 30_000;
/** Clock skew between the provider's event times and this server's. */
const SLACK_MS = 2 * 60_000;
const PROVIDERS_WITH_TRAIL = new Set(['aws', 'azure', 'cloudflare']);

const unavailable = (): ChangeTrail => ({ state: 'unavailable', provider: null, attempts: 0, window: null, events: [], checkedAt: null, error: null });

/** The AWS role an assumed-role session belongs to (two sessions of one role are one principal). */
const principalKey = (p: string): string => {
  const m = /^arn:(aws[\w-]*):sts::(\d{12}):assumed-role\/([^/]+)\/.+$/.exec(p);
  return (m ? `arn:${m[1]}:iam::${m[2]}:role/${m[3]}` : p).toLowerCase();
};

export class CloudChangeTrail {
  readonly options: TrailOptions = { windowMs: 24 * HOUR, maxLookups: 10, maxAttempts: 4, retryForMs: 6 * HOUR, now: () => Date.now() };
  private schema: { ok: boolean; at: number } | null = null;

  constructor(private readonly s: () => Services) {}

  async installed(): Promise<boolean> {
    const t = Date.now();
    if (this.schema && (this.schema.ok || t - this.schema.at < SCHEMA_RECHECK_MS)) return this.schema.ok;
    let ok: boolean;
    try {
      ok = await this.s().db.schema.hasTable('cloud_change_trail');
    } catch {
      ok = false;
    }
    this.schema = { ok, at: t };
    return ok;
  }

  resetSchemaCache(): void {
    this.schema = null;
  }

  /** The window a finding's trail is read in: up to `windowMs` before its first sighting, to that sighting. */
  windowFor(f: Pick<DriftFinding, 'firstSeen'>): { from: number; to: number } {
    return { from: f.firstSeen - this.options.windowMs, to: f.firstSeen + SLACK_MS };
  }

  /** The findings with their "changed by" and trail (from the cache; nothing is called). */
  async decorate<T extends DriftFinding>(findings: T[]): Promise<(T & { changedBy: ChangedBy | null; trail: ChangeTrail })[]> {
    if (!findings.length) return [];
    if (!(await this.installed())) return findings.map((f) => ({ ...f, changedBy: null, trail: unavailable() }));
    const rows = new Map<string, Record<string, unknown>>();
    const ids = findings.map((f) => f.id);
    for (let i = 0; i < ids.length; i += 200) for (const r of (await this.s().db('cloud_change_trail').whereIn('finding_id', ids.slice(i, i + 200))) as Record<string, unknown>[]) rows.set(String(r.finding_id), r);
    return findings.map((f) => {
      const r = rows.get(f.id);
      return { ...f, ...(r ? fromRow(r) : { changedBy: null, trail: { ...unavailable(), state: 'pending' as const } }) };
    });
  }

  /**
   * Looks up the trail of the open findings that still need one (no row yet, or pending or failed with attempts and
   * time left), at most `maxLookups` of them, newest findings first. Never throws: a failure is the finding's `error`.
   */
  async lookup(d: Deployment, open: DriftFinding[], c: DeploymentContext): Promise<{ looked: number; found: number }> {
    if (!open.length || !(await this.installed())) return { looked: 0, found: 0 };
    const s = this.s();
    const now = this.options.now();
    const provider = c.account.provider;
    const have = new Map<string, Record<string, unknown>>();
    for (const r of (await s.db('cloud_change_trail').whereIn('finding_id', open.map((f) => f.id))) as Record<string, unknown>[]) have.set(String(r.finding_id), r);
    const due = open
      .filter((f) => f.providerId)
      .filter((f) => {
        const r = have.get(f.id);
        if (!r) return true;
        const state = String(r.state);
        if (state !== 'pending' && state !== 'error') return false;
        return Number(r.attempts) < this.options.maxAttempts && now - f.firstSeen < this.options.retryForMs;
      })
      .sort((a, b) => b.firstSeen - a.firstSeen);
    if (!due.length) return { looked: 0, found: 0 };
    if (!PROVIDERS_WITH_TRAIL.has(provider)) {
      for (const f of due) if (!have.has(f.id)) await this.store(d, f, provider, { state: 'unsupported', attempts: 0, window: null, events: [], error: `${provider === 'digitalocean' ? 'DigitalOcean' : provider} keeps no change trail this build reads.` }, now);
      return { looked: 0, found: 0 };
    }
    let adapter: CloudProvider;
    try {
      adapter = (await s.cloud.providers.adapter(provider)) as CloudProvider;
    } catch {
      return { looked: 0, found: 0 };
    }
    if (!adapter.changeEvents) return { looked: 0, found: 0 };
    const ours = principalKey(String(c.account.validation?.identity?.principal ?? '')) || null;
    const rows = await s.cloud.deployments.resources(d.id, { includeDeleted: true });
    let looked = 0;
    let found = 0;
    for (const f of due.slice(0, this.options.maxLookups)) {
      const prev = have.get(f.id);
      const attempts = Number(prev?.attempts ?? 0) + 1;
      const window = this.windowFor(f);
      const row = f.key ? rows.find((r) => r.key === f.key) : rows.find((r) => r.providerId === f.providerId);
      const observed = (f.kind === 'unmanaged' ? (f.observed as ObservedResource | null) : row?.observed) ?? null;
      const region = observed?.region ?? row?.region ?? (f.kind === 'unmanaged' ? undefined : d.region);
      const recordIds = Array.isArray(observed?.props?.ids) ? (observed!.props.ids as unknown[]).map(String) : [];
      const dnsName = f.type === 'dns_record' ? String(observed?.props?.record ?? (row?.desired.spec as { record?: string } | undefined)?.record ?? '') || undefined : undefined;
      looked++;
      try {
        const events = await adapter.changeEvents(c.ctx(region), { type: f.type, providerId: f.providerId!, ...(region ? { region } : {}), locator: observed?.locator ?? row?.locator ?? null, ids: recordIds, ...(dnsName ? { name: dnsName } : {}), from: window.from, to: Math.min(window.to, now), limit: 20 });
        const marked = events.filter((e) => e.at >= window.from && e.at <= window.to).map((e) => ({ ...e, byExprsn: !!ours && principalKey(e.principal) === ours }));
        const chosen = marked.find((e) => !e.byExprsn) ?? marked[0] ?? null;
        if (chosen) found++;
        const exhausted = attempts >= this.options.maxAttempts || now - f.firstSeen >= this.options.retryForMs;
        await this.store(d, f, provider, { state: chosen ? 'found' : exhausted ? 'not_found' : 'pending', attempts, window, events: marked.slice(0, 5), chosen, error: null }, now);
      } catch (err) {
        const msg = err instanceof CloudProviderError ? err.message : err instanceof Error ? err.message : String(err);
        s.log.warn({ deployment: d.id, finding: f.id, provider }, 'cloud change trail lookup failed');
        await this.store(d, f, provider, { state: 'error', attempts, window, events: [], error: msg.slice(0, 500) }, now);
      }
    }
    return { looked, found };
  }

  private async store(d: Deployment, f: DriftFinding, provider: string, x: { state: TrailState; attempts: number; window: { from: number; to: number } | null; events: (ChangeEvent & { byExprsn: boolean })[]; chosen?: (ChangeEvent & { byExprsn: boolean }) | null; error: string | null }, now: number): Promise<void> {
    const db = this.s().db;
    const c = x.chosen ?? null;
    const clip = (v: string | null | undefined, n: number) => (v == null ? null : String(v).slice(0, n));
    const row = {
      deployment_id: d.id,
      provider,
      state: x.state,
      attempts: x.attempts,
      window_from: x.window?.from ?? null,
      window_to: x.window?.to ?? null,
      principal: clip(c?.principal, 500),
      principal_type: clip(c?.principalType, 60),
      action: clip(c?.action, 200),
      source: clip(c?.source, 200),
      event_id: clip(c?.eventId, 200),
      source_ip: clip(c?.sourceIp, 100),
      changed_at: c?.at ?? null,
      by_exprsn: c?.byExprsn ?? false,
      events: JSON.stringify(x.events),
      error: clip(x.error, 500),
      checked_at: now
    };
    const n = await db('cloud_change_trail').where({ finding_id: f.id }).update(row);
    if (!n) await db('cloud_change_trail').insert({ finding_id: f.id, ...row });
  }
}

function fromRow(r: Record<string, unknown>): { changedBy: ChangedBy | null; trail: ChangeTrail } {
  const changedBy: ChangedBy | null = r.principal ? { principal: String(r.principal), principalType: (r.principal_type as string | null) ?? null, at: Number(r.changed_at), action: String(r.action ?? ''), source: String(r.source ?? ''), eventId: (r.event_id as string | null) ?? null, sourceIp: (r.source_ip as string | null) ?? null, byExprsn: !!r.by_exprsn } : null;
  return {
    changedBy,
    trail: {
      state: r.state as TrailState,
      provider: String(r.provider),
      attempts: Number(r.attempts ?? 0),
      window: r.window_from == null ? null : { from: Number(r.window_from), to: Number(r.window_to) },
      events: json<(ChangeEvent & { byExprsn: boolean })[]>(r.events, []),
      checkedAt: Number(r.checked_at),
      error: (r.error as string | null) ?? null
    }
  };
}

/** The account a deployment's trail is read on (exported for the tests' wording). */
export type TrailAccount = Pick<CloudAccount, 'provider' | 'validation'>;
