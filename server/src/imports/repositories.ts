import { ulid } from 'ulid';
import { actorFrom, isUniqueViolation } from '../audit/chain.js';
import { rolesGranting } from '../authz/permissions.js';
import type { Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { hostEntryProblem } from '../integrations/hosts.js';
import type { JobContext } from '../platform/jobs.js';
import { parseVaultRef } from '../vault/policy.js';
import type { Services } from '../services.js';
import { ADAPTERS, type AdapterContext } from './adapters/index.js';
import type { ImportFetcher, RepoAccess } from './fetcher.js';
import { NeedsCredential, RateLimited, REPO_TYPE_INFO, SourceError, type CatalogItem, type ImportKind, type RepoType } from './types.js';

/*
 * B-3801: the repository registry. A repository is proposed by one holder of `imports:repositories` and confirmed by
 * another (dual control): only then do its hosts join the staging-proxy allow-list and its first harvest run. The
 * credential is a `vault:` reference (or a value written into the vault at `imports/repositories/<id>` on the way in),
 * resolved under the vault policy of the user who saved it, and sent only to the repository's own host. Harvests run
 * as jobs on the repository's schedule; a source that rate-limits backs off exponentially, and browsing falls back to
 * the snapshot meanwhile.
 */

export type RepoState = 'pending' | 'active' | 'disabled' | 'rejected';
export type RepoStatus = 'unknown' | 'reachable' | 'rate limited' | 'unreachable' | 'needs token';

export interface RepositoryRow {
  id: string;
  tenant_id: string;
  name: string;
  type: RepoType;
  base_url: string;
  host: string;
  extra_hosts: string[];
  region: string;
  kinds: ImportKind[];
  options: Record<string, unknown>;
  credential_ref: string | null;
  credential_owner: string | null;
  licence_policy: string | null;
  harvest_minutes: number | null;
  next_harvest_at: number | null;
  state: RepoState;
  status: RepoStatus;
  status_detail: string | null;
  backoff_until: number | null;
  backoff_count: number;
  snapshot_at: number | null;
  snapshot_items: number;
  harvest_job: string | null;
  requested_by: string;
  decided_by: string | null;
  decided_at: number | null;
  decision_note: string | null;
  created_at: number;
  updated_at: number;
}

const n = (v: unknown): number | null => (v == null ? null : Number(v));

export const repoFrom = (r: Record<string, unknown>): RepositoryRow => ({
  ...(r as unknown as RepositoryRow),
  extra_hosts: json<string[]>(r.extra_hosts, []),
  kinds: json<ImportKind[]>(r.kinds, []),
  options: json<Record<string, unknown>>(r.options, {}),
  harvest_minutes: n(r.harvest_minutes),
  next_harvest_at: n(r.next_harvest_at),
  backoff_until: n(r.backoff_until),
  backoff_count: Number(r.backoff_count ?? 0),
  snapshot_at: n(r.snapshot_at),
  snapshot_items: Number(r.snapshot_items ?? 0),
  decided_at: n(r.decided_at),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

export const repoView = (r: RepositoryRow, now = Date.now()) => ({
  id: r.id,
  name: r.name,
  type: r.type,
  typeName: REPO_TYPE_INFO[r.type].name,
  protocol: REPO_TYPE_INFO[r.type].protocol,
  baseUrl: r.base_url,
  host: r.host,
  extraHosts: r.extra_hosts,
  region: r.region,
  kinds: r.kinds,
  options: r.options,
  credential: { recorded: !!r.credential_ref, ref: r.credential_ref, required: REPO_TYPE_INFO[r.type].credentialRequired, kind: REPO_TYPE_INFO[r.type].credential },
  licencePolicy: r.licence_policy,
  harvestMinutes: r.harvest_minutes,
  nextHarvestAt: r.next_harvest_at,
  state: r.state,
  status: r.state === 'disabled' ? 'disabled' : r.backoff_until && r.backoff_until > now ? 'rate limited' : r.status,
  statusDetail: r.status_detail,
  backoffUntil: r.backoff_until && r.backoff_until > now ? r.backoff_until : null,
  liveSearch: REPO_TYPE_INFO[r.type].liveSearch,
  modelImport: REPO_TYPE_INFO[r.type].modelImport,
  snapshotAt: r.snapshot_at,
  snapshotItems: r.snapshot_items,
  harvestJob: r.harvest_job,
  requestedBy: r.requested_by,
  decidedBy: r.decided_by,
  decidedAt: r.decided_at,
  decisionNote: r.decision_note,
  createdAt: r.created_at,
  updatedAt: r.updated_at
});

export interface RepoInput {
  name: string;
  type: RepoType;
  baseUrl?: string | null;
  region: string;
  kinds?: ImportKind[];
  extraHosts?: string[];
  options?: Record<string, unknown>;
  credentialRef?: string | null;
  credential?: string | null;
  licencePolicy?: string | null;
  harvestMinutes?: number | null;
}

export interface RepoPatch {
  name?: string;
  region?: string;
  options?: Record<string, unknown>;
  credentialRef?: string | null;
  credential?: string | null;
  licencePolicy?: string | null;
  harvestMinutes?: number | null;
}

const BUNDLE_URL = 'bundle://promoted';

export class RepositoryRegistry {
  constructor(
    private readonly s: () => Services,
    readonly fetcher: ImportFetcher
  ) {}

  private get db() {
    return this.s().db;
  }

  private async audit(p: Principal | null, tenantId: string, action: string, target: Record<string, unknown>, detail: Record<string, unknown>, traceId?: string | null) {
    await this.s().audit.append({ tenantId, action, kind: p ? 'admin' : 'system', actor: p ? actorFrom(p) : { service: 'imports' }, target, detail, traceId: traceId ?? null });
  }

  async list(tenantId: string): Promise<RepositoryRow[]> {
    return ((await this.db('import_repositories').where({ tenant_id: tenantId }).orderBy('name')) as Record<string, unknown>[]).map(repoFrom);
  }

  async get(tenantId: string, id: string): Promise<RepositoryRow> {
    const r = await this.db('import_repositories').where({ tenant_id: tenantId, id }).first();
    if (!r) throw notFound('Repository');
    return repoFrom(r);
  }

  /** A repository that is confirmed and enabled (browsing and importing need one). */
  async active(tenantId: string, id: string): Promise<RepositoryRow> {
    const r = await this.get(tenantId, id);
    if (r.state === 'pending') throw conflict(`${r.name} waits for a second admin to confirm it; it is not harvested or browsable until then.`);
    if (r.state !== 'active') throw conflict(`${r.name} is ${r.state}.`);
    return r;
  }

  private async patch(id: string, u: Record<string, unknown>): Promise<void> {
    const out: Record<string, unknown> = { updated_at: Date.now() };
    for (const [k, v] of Object.entries(u)) out[k] = ['extra_hosts', 'kinds', 'options'].includes(k) ? JSON.stringify(v) : v;
    await this.db('import_repositories').where({ id }).update(out);
  }

  /** Validates a credential and stores a raw one in the vault (as the caller); returns the reference. */
  private async credentialRef(p: Principal, repoId: string, input: { credentialRef?: string | null; credential?: string | null }, traceId?: string | null): Promise<string | null | undefined> {
    if (input.credential) {
      const s = this.s();
      const c = await s.vault.callerFor(p, { traceId: traceId ?? null });
      const path = `imports/repositories/${repoId.toLowerCase()}`;
      await s.vault.write(c, path, { credential: input.credential }, { label: 'confidential' });
      return `vault:${path}#credential`;
    }
    if (input.credentialRef === undefined) return undefined;
    if (input.credentialRef === null) return null;
    if (!parseVaultRef(input.credentialRef)) throw badRequest('A credential reference looks like vault:<path>#<key>.');
    await this.s().vault.assertRefsReadable(p, [input.credentialRef], { traceId: traceId ?? null });
    return input.credentialRef;
  }

  private async notifyAdmins(tenantId: string, except: string, title: string, body: string): Promise<void> {
    const s = this.s();
    const users = (await s.notifications.usersWithRoles(tenantId, rolesGranting('imports:repositories', tenantId))).filter((u) => u !== except);
    if (users.length) await s.notifications.notify({ tenantId, userIds: users, kind: 'import.repository', title, body, route: '#/import?tab=repos' });
  }

  async propose(p: Principal, input: RepoInput, traceId?: string | null): Promise<RepositoryRow> {
    const info = REPO_TYPE_INFO[input.type];
    let baseUrl = BUNDLE_URL;
    let host = 'bundle';
    if (input.type !== 'bundle') {
      baseUrl = (input.baseUrl ?? info.example ?? '').trim().replace(/\/+$/, '');
      if (!baseUrl) throw badRequest('This repository type needs a base URL.');
      const problem = this.fetcher.baseUrlProblem(baseUrl);
      if (problem) throw badRequest(problem);
      host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    }
    const extra = [...new Set((input.extraHosts ?? (input.type === 'bundle' ? [] : info.defaultHosts)).map((h) => h.trim().toLowerCase()).filter(Boolean))];
    for (const h of extra) {
      const problem = hostEntryProblem(h);
      if (problem || h.includes('/')) throw badRequest(problem ?? `${h}: name a host or *.domain, not a network.`);
    }
    const kinds = input.kinds?.length ? input.kinds.filter((k) => info.kinds.includes(k)) : info.kinds;
    if (!kinds.length) throw badRequest(`A ${info.name} offers ${info.kinds.join(' and ')}s.`);
    if (input.harvestMinutes != null && input.harvestMinutes < 15) throw badRequest('Harvest at most every 15 minutes.');
    const id = ulid();
    const credential = await this.credentialRef(p, id, input, traceId);
    const t = Date.now();
    const row = {
      id,
      tenant_id: p.tenantId,
      name: input.name,
      type: input.type,
      base_url: baseUrl,
      host,
      extra_hosts: JSON.stringify(extra),
      region: input.region,
      kinds: JSON.stringify(kinds),
      options: JSON.stringify(input.options ?? {}),
      credential_ref: credential ?? null,
      credential_owner: credential ? p.userId : null,
      licence_policy: input.licencePolicy ?? null,
      harvest_minutes: input.harvestMinutes ?? null,
      next_harvest_at: null,
      state: 'pending',
      status: 'unknown',
      status_detail: null,
      backoff_until: null,
      backoff_count: 0,
      snapshot_at: null,
      snapshot_items: 0,
      harvest_job: null,
      requested_by: p.userId,
      decided_by: null,
      decided_at: null,
      decision_note: null,
      created_at: t,
      updated_at: t
    };
    try {
      await this.db('import_repositories').insert(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A repository named ${input.name} already exists.`);
      throw err;
    }
    await this.audit(p, p.tenantId, 'import.repository.proposed', { repository: id, name: input.name }, { type: input.type, baseUrl, hosts: [host, ...extra], region: input.region, kinds, credential: credential ?? null, harvestMinutes: input.harvestMinutes ?? null }, traceId);
    await this.notifyAdmins(p.tenantId, p.userId, 'Repository waiting for confirmation', `${p.displayName} proposed ${input.name} (${info.name}, ${host}). A second admin confirms it before its hosts join the allow-list and it is harvested.`);
    return this.get(p.tenantId, id);
  }

  async confirm(p: Principal, id: string, note: string | null, traceId?: string | null): Promise<{ repository: RepositoryRow; jobId: string | null }> {
    const r = await this.get(p.tenantId, id);
    if (r.state !== 'pending') throw conflict(`${r.name} is ${r.state}; only a proposed repository is confirmed.`);
    if (r.requested_by === p.userId) throw forbidden('Dual control: a second admin, not the one who proposed it, confirms a repository.', { step: 'dual-control' });
    const t = Date.now();
    const n = await this.db('import_repositories').where({ id, state: 'pending' }).update({ state: 'active', decided_by: p.userId, decided_at: t, decision_note: note, next_harvest_at: r.harvest_minutes ? t + r.harvest_minutes * 60_000 : null, updated_at: t });
    if (!n) throw conflict(`${r.name} was decided by someone else just now.`);
    await this.audit(p, p.tenantId, 'import.repository.confirmed', { repository: id, name: r.name }, { hosts: [r.host, ...r.extra_hosts], proposedBy: r.requested_by, note }, traceId);
    const jobId = await this.harvestNow(p, id, traceId, true);
    return { repository: await this.get(p.tenantId, id), jobId };
  }

  async reject(p: Principal, id: string, note: string | null, traceId?: string | null): Promise<RepositoryRow> {
    const r = await this.get(p.tenantId, id);
    if (r.state !== 'pending') throw conflict(`${r.name} is ${r.state}; only a proposed repository is rejected.`);
    await this.patch(id, { state: 'rejected', decided_by: p.userId, decided_at: Date.now(), decision_note: note });
    await this.audit(p, p.tenantId, 'import.repository.rejected', { repository: id, name: r.name }, { note }, traceId);
    return this.get(p.tenantId, id);
  }

  async update(p: Principal, id: string, patch: RepoPatch, traceId?: string | null): Promise<RepositoryRow> {
    const r = await this.get(p.tenantId, id);
    if (r.state === 'rejected') throw conflict('A rejected repository is read-only; propose it again.');
    const u: Record<string, unknown> = {};
    if (patch.name !== undefined) u.name = patch.name;
    if (patch.region !== undefined) u.region = patch.region;
    if (patch.options !== undefined) u.options = patch.options;
    if (patch.licencePolicy !== undefined) u.licence_policy = patch.licencePolicy;
    if (patch.harvestMinutes !== undefined) {
      if (patch.harvestMinutes != null && patch.harvestMinutes < 15) throw badRequest('Harvest at most every 15 minutes.');
      u.harvest_minutes = patch.harvestMinutes;
      u.next_harvest_at = patch.harvestMinutes && r.state === 'active' ? Date.now() + patch.harvestMinutes * 60_000 : null;
    }
    const cred = await this.credentialRef(p, id, patch, traceId);
    if (cred !== undefined) {
      u.credential_ref = cred;
      u.credential_owner = cred ? p.userId : null;
      if (r.status === 'needs token') u.status = 'unknown';
    }
    try {
      await this.patch(id, u);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A repository named ${patch.name} already exists.`);
      throw err;
    }
    await this.audit(p, p.tenantId, 'import.repository.updated', { repository: id, name: r.name }, { changed: Object.keys(u), credential: cred === undefined ? undefined : cred }, traceId);
    return this.get(p.tenantId, id);
  }

  async setEnabled(p: Principal, id: string, enabled: boolean, traceId?: string | null): Promise<RepositoryRow> {
    const r = await this.get(p.tenantId, id);
    if (enabled ? r.state !== 'disabled' : r.state !== 'active') throw conflict(`${r.name} is ${r.state}.`);
    await this.patch(id, { state: enabled ? 'active' : 'disabled', next_harvest_at: enabled && r.harvest_minutes ? Date.now() + r.harvest_minutes * 60_000 : null });
    await this.audit(p, p.tenantId, enabled ? 'import.repository.enabled' : 'import.repository.disabled', { repository: id, name: r.name }, {}, traceId);
    return this.get(p.tenantId, id);
  }

  async remove(p: Principal, id: string, traceId?: string | null): Promise<void> {
    const r = await this.get(p.tenantId, id);
    const live = await this.db('import_jobs').where({ tenant_id: p.tenantId, repository_id: id }).whereIn('state', ['queued', 'waiting on licence', 'queued for bundle', 'running']).first('id');
    if (live) throw conflict(`${r.name} has imports in the queue; cancel them first.`);
    await this.db.transaction(async (trx) => {
      await trx('import_catalog_facets').where({ repository_id: id }).delete();
      await trx('import_catalog').where({ repository_id: id }).delete();
      await trx('import_gates').where({ repository_id: id }).delete();
      await trx('import_repositories').where({ id }).delete();
    });
    await this.audit(p, p.tenantId, 'import.repository.deleted', { repository: id, name: r.name }, { type: r.type, host: r.host }, traceId);
  }

  // ---------- access, status and backoff ----------

  access(r: RepositoryRow): RepoAccess {
    const s = this.s();
    return {
      host: r.host,
      hosts: [r.host, ...r.extra_hosts],
      auth: async (): Promise<Record<string, string>> => {
        if (!r.credential_ref) return {};
        const v = await s.vault.resolveFor(r.tenant_id, r.credential_owner, r.credential_ref, { via: `import repository ${r.name}` });
        switch (r.type) {
          case 'kaggle':
          case 'ollama':
            return { authorization: `Basic ${Buffer.from(v).toString('base64')}` };
          case 'ckan':
            return { authorization: v };
          case 'openml':
            return { 'x-api-key': v };
          default:
            return { authorization: `Bearer ${v}` };
        }
      }
    };
  }

  context(r: RepositoryRow, signal?: AbortSignal): AdapterContext {
    return {
      repo: { id: r.id, tenantId: r.tenant_id, type: r.type, baseUrl: r.base_url, kinds: r.kinds, options: r.options, hasCredential: !!r.credential_ref },
      fetcher: this.fetcher,
      access: this.access(r),
      ...(signal ? { signal } : {}),
      maxItems: this.s().cfg.IMPORT_HARVEST_MAX_ITEMS,
      s: this.s()
    };
  }

  /** True while a rate-limited repository backs off (live search and downloads wait). */
  backingOff(r: RepositoryRow, now = Date.now()): boolean {
    return !!r.backoff_until && r.backoff_until > now;
  }

  async markOk(r: RepositoryRow, detail: string): Promise<void> {
    await this.patch(r.id, { status: 'reachable', status_detail: detail.slice(0, 500), backoff_until: null, backoff_count: 0 });
  }

  /** Exponential backoff: the source's Retry-After when longer, doubling from a minute, capped. Returns the time it ends. */
  async markRateLimited(r: RepositoryRow, err: RateLimited): Promise<number> {
    const fresh = repoFrom(await this.db('import_repositories').where({ id: r.id }).first());
    const base = 60_000 * 2 ** Math.min(fresh.backoff_count, 16);
    const delay = Math.min(Math.max(base, err.retryAfterMs ?? 0), this.s().cfg.IMPORT_BACKOFF_MAX_MINUTES * 60_000);
    const until = Date.now() + delay;
    await this.patch(r.id, { status: 'rate limited', status_detail: err.message.slice(0, 500), backoff_until: until, backoff_count: fresh.backoff_count + 1 });
    return until;
  }

  async markError(r: RepositoryRow, err: unknown): Promise<void> {
    if (err instanceof RateLimited) {
      await this.markRateLimited(r, err);
      return;
    }
    const status: RepoStatus = err instanceof NeedsCredential ? 'needs token' : 'unreachable';
    await this.patch(r.id, { status, status_detail: (err as Error).message.slice(0, 500) });
  }

  // ---------- harvests ----------

  async harvestNow(p: Principal, id: string, traceId?: string | null, quiet = false): Promise<string> {
    const r = await this.active(p.tenantId, id);
    const job = await this.s().jobs.enqueue({ tenantId: p.tenantId, type: 'imports.harvest', payload: { repositoryId: id }, createdBy: p.userId, maxAttempts: 1, dedupeKey: `imports.harvest:${id}:${Math.floor(Date.now() / 10_000)}` });
    await this.patch(id, { harvest_job: job.id });
    if (!quiet) await this.audit(p, p.tenantId, 'import.repository.harvest.requested', { repository: id, name: r.name }, { job: job.id }, traceId);
    return job.id;
  }

  /** The harvest job: the whole catalogue from the adapter, then the snapshot replaced in one transaction. */
  async harvestJob(repositoryId: string, ctx: JobContext): Promise<unknown> {
    const s = this.s();
    const raw = await this.db('import_repositories').where({ id: repositoryId }).first();
    if (!raw) return { skipped: 'gone' };
    const r = repoFrom(raw);
    if (r.state !== 'active') return { skipped: r.state };
    if (this.backingOff(r)) return { skipped: `backing off until ${new Date(r.backoff_until!).toISOString()}` };
    const adapter = ADAPTERS[r.type];
    const items = new Map<string, CatalogItem>();
    try {
      await ctx.progress(1, `Harvesting ${r.name}`);
      for await (const it of adapter.harvest(this.context(r, ctx.signal))) {
        if (!r.kinds.includes(it.kind) || !it.itemId) continue;
        const key = `${it.kind}\u0000${it.itemId}`;
        if (!items.has(key)) items.set(key, it);
        if (items.size % 500 === 0) await ctx.progress(Math.min(80, 1 + items.size / 250), `${items.size} items`);
      }
    } catch (err) {
      await this.markError(r, err);
      if (err instanceof RateLimited) {
        const fresh = await this.get(r.tenant_id, r.id);
        if (r.harvest_minutes) await this.patch(r.id, { next_harvest_at: fresh.backoff_until });
      }
      await this.audit(null, r.tenant_id, 'import.repository.harvest.failed', { repository: r.id, name: r.name }, { error: (err as Error).message.slice(0, 500), status: err instanceof RateLimited ? 'rate limited' : err instanceof NeedsCredential ? 'needs token' : 'unreachable' });
      throw err instanceof SourceError || err instanceof RateLimited ? new Error((err as Error).message, { cause: err }) : err;
    }
    await ctx.progress(85, `Writing ${items.size} items`);
    const count = await s.imports.catalog.replace(r, [...items.values()]);
    const t = Date.now();
    await this.patch(r.id, { snapshot_at: t, snapshot_items: count, status: 'reachable', status_detail: `Harvested ${count} items.`, backoff_until: null, backoff_count: 0, next_harvest_at: r.harvest_minutes ? t + r.harvest_minutes * 60_000 : null });
    await this.audit(null, r.tenant_id, 'import.repository.harvested', { repository: r.id, name: r.name }, { items: count, job: ctx.job.id });
    await ctx.progress(100, `${count} items`);
    return { items: count };
  }

  /** Scheduled: queues the harvests that are due in a tenant. */
  async harvestDue(tenantId: string): Promise<{ queued: number }> {
    const now = Date.now();
    const due = ((await this.db('import_repositories').where({ tenant_id: tenantId, state: 'active' }).whereNotNull('harvest_minutes').andWhere('next_harvest_at', '<=', now)) as Record<string, unknown>[]).map(repoFrom);
    let queued = 0;
    for (const r of due) {
      if (this.backingOff(r, now)) {
        await this.patch(r.id, { next_harvest_at: r.backoff_until });
        continue;
      }
      const job = await this.s().jobs.enqueue({ tenantId, type: 'imports.harvest', payload: { repositoryId: r.id }, maxAttempts: 1, dedupeKey: `imports.harvest:${r.id}:due:${r.next_harvest_at}` });
      await this.patch(r.id, { harvest_job: job.id, next_harvest_at: now + (r.harvest_minutes ?? 1440) * 60_000 });
      queued++;
    }
    return { queued };
  }

  /** The staging proxy's allow-list: every confirmed repository's hosts plus IMPORT_ALLOWED_HOSTS, for one tenant or all. */
  async allowList(tenantId: string | null): Promise<{ host: string; repositories: string[] }[]> {
    const q = this.db('import_repositories').where({ state: 'active' }).whereNot({ type: 'bundle' });
    if (tenantId) q.andWhere({ tenant_id: tenantId });
    const rows = ((await q) as Record<string, unknown>[]).map(repoFrom);
    const hosts = new Map<string, Set<string>>();
    for (const r of rows) for (const h of [r.host, ...r.extra_hosts]) hosts.set(h, (hosts.get(h) ?? new Set()).add(r.name));
    for (const h of this.s().cfg.IMPORT_ALLOWED_HOSTS.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)) hosts.set(h, (hosts.get(h) ?? new Set()).add('IMPORT_ALLOWED_HOSTS'));
    return [...hosts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([host, names]) => ({ host, repositories: [...names].sort() }));
  }

  /** Checks a repository answers now (and its credential works); updates its status. */
  async probe(p: Principal, id: string): Promise<RepositoryRow> {
    const r = await this.get(p.tenantId, id);
    if (r.state === 'rejected') throw conflict('A rejected repository is not checked.');
    try {
      await this.markOk(r, await ADAPTERS[r.type].probe(this.context(r)));
    } catch (err) {
      if (err instanceof HttpProblem) throw err;
      await this.markError(r, err);
    }
    return this.get(p.tenantId, id);
  }
}
