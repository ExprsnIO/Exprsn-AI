import { ulid } from 'ulid';
import { actorFrom } from '../audit/chain.js';
import { clears, isLabel, type Label } from '../authz/labels.js';
import { canGrant } from '../authz/permissions.js';
import type { Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { conflict, notFound } from '../http/problem.js';
import type { ProviderRow } from '../repos/providers.js';
import { resolveMappings } from '../repos/users.js';
import type { Services } from '../services.js';
import { TableCheck } from './directory-state.js';
import { CloudDirectoryClient, type DirectoryUser } from './providers/cloud-directory.js';
import { parseProviderConfig } from './providers/types.js';
import { provision } from './provisioning.js';
import { hasDirectory } from './sync.js';

/*
 * 1.9.9-qa (QA-1, the Sprint 54 leftover of B-183): a full import of a cloud directory's users (Microsoft Entra ID
 * through Graph, Google Workspace through the Directory API) before their first sign-in, as the job
 * `directory.import`.
 *
 * - A dry run comes first: it reads every user and their groups and counts what the run would do, changing nothing.
 *   The run names a dry run of the same store that succeeded in the last 24 hours (409 otherwise).
 * - Accounts are made exactly as just-in-time provisioning makes them at a first sign-in (`provision`): roles,
 *   clearance and workspace memberships from the group mappings (or the store's default roles), linked by the
 *   directory's id; an account the directory has disabled or suspended is not created; one with no mapped group is
 *   not created; a username linked to another store is a conflict, never merged; an account already linked is left
 *   to directory sync. The import does not count as a sign-in (no last sign-in time).
 * - The importer's ceiling: an account whose roles the importer could not grant, or whose clearance is above the
 *   importer's, is refused (the roles and clearance asked at the time are kept on the import).
 * - Progress: reading the users is the first fifth, each user the rest; the counts and a capped report are kept in
 *   `directory_imports` (migration 143). Without that table the import answers 409 "not available".
 */

export const IMPORT_MAX_USERS = 100_000;
const REPORT_ROWS = 1_000;
const DRY_RUN_VALID_MS = 24 * 3_600_000;

export type ImportAction = 'create' | 'link' | 'existing' | 'disabled' | 'no_mapped_group' | 'conflict' | 'refused' | 'error';

export interface DirectoryImportSummary {
  dryRun: boolean;
  users: number;
  create: number;
  link: number;
  existing: number;
  disabled: number;
  noMappedGroup: number;
  conflict: number;
  refused: number;
  error: number;
  /** After a real run: accounts made (or linked) by it. */
  applied: number;
}

export interface DirectoryImportRow {
  username: string;
  externalId: string;
  action: ImportAction;
  roles?: string[];
  clearance?: Label;
  detail?: string;
  outcome?: string;
}

interface ImportRecord {
  id: string;
  tenant_id: string;
  provider_id: string;
  created_by: string | null;
  actor: string | null;
  dry_run: boolean | number;
  from_dry_run: string | null;
  state: string;
  job_id: string | null;
  summary: string | null;
  report: string | null;
  error: string | null;
  created_at: number;
  finished_at: number | null;
}

const empty = (dryRun: boolean): DirectoryImportSummary => ({ dryRun, users: 0, create: 0, link: 0, existing: 0, disabled: 0, noMappedGroup: 0, conflict: 0, refused: 0, error: 0, applied: 0 });

const COUNT: Record<ImportAction, keyof DirectoryImportSummary> = { create: 'create', link: 'link', existing: 'existing', disabled: 'disabled', no_mapped_group: 'noMappedGroup', conflict: 'conflict', refused: 'refused', error: 'error' };

export class DirectoryImports {
  private readonly tables: TableCheck;
  constructor(private readonly s: Services) {
    this.tables = new TableCheck(s.db);
  }

  available(): Promise<boolean> {
    return this.tables.has('directory_imports');
  }

  private async assertAvailable(): Promise<void> {
    if (!(await this.available())) throw conflict('The directory import is not available on this server yet (its migration, 143_directory_sync_state, has not been applied).');
  }

  /** The store's directory client, or a 409 saying why it has none. */
  client(row: ProviderRow): CloudDirectoryClient {
    if (row.state === 'archived') throw conflict('This store is archived; restore it to import.');
    if (!hasDirectory(row)) throw conflict('Only a store with a cloud directory (Microsoft Entra ID through Graph, Google Workspace through the Directory API) can be imported.');
    const provider = this.s.chain.build(row);
    if (!('client' in provider) || !(provider.client instanceof CloudDirectoryClient)) throw conflict('The directory of this store is not available in this process.');
    return provider.client;
  }

  /** Queues a dry run, or a run that names a dry run of the same store. */
  async submit(p: Principal, row: ProviderRow, opts: { dryRun: boolean; fromDryRun?: string }, ctx: { ip: string | null; traceId?: string }): Promise<{ id: string; jobId: string }> {
    await this.assertAvailable();
    this.client(row);
    const db = this.s.db;
    if (!opts.dryRun) {
      const dry = opts.fromDryRun ? ((await db('directory_imports').where({ tenant_id: p.tenantId, id: opts.fromDryRun }).first()) as ImportRecord | undefined) : undefined;
      if (!dry || dry.provider_id !== row.id || !dry.dry_run) throw conflict('Run a dry run of this store first, and name it (fromDryRun).');
      if (dry.state !== 'succeeded') throw conflict('That dry run has not finished successfully.');
      if (Date.now() - dry.created_at > DRY_RUN_VALID_MS) throw conflict('That dry run is more than a day old; run a new one.');
    }
    const running = await db('directory_imports').where({ tenant_id: p.tenantId, provider_id: row.id }).whereIn('state', ['queued', 'running']).first('id');
    if (running) throw conflict(`An import of this store is already queued or running (${(running as { id: string }).id}).`);
    const id = ulid();
    await db('directory_imports').insert({ id, tenant_id: p.tenantId, provider_id: row.id, created_by: p.userId, actor: JSON.stringify({ roles: p.roles, clearance: p.clearance }), dry_run: opts.dryRun, from_dry_run: opts.dryRun ? null : opts.fromDryRun!, state: 'queued', job_id: null, summary: null, report: null, error: null, created_at: Date.now(), finished_at: null });
    const job = await this.s.jobs.enqueue({ tenantId: p.tenantId, type: 'directory.import', payload: { importId: id }, createdBy: p.userId, maxAttempts: 1 });
    await db('directory_imports').where({ id }).update({ job_id: job.id });
    await this.s.audit.append({ tenantId: p.tenantId, action: opts.dryRun ? 'identity.directory_import.dry_run' : 'identity.directory_import.requested', kind: 'admin', actor: actorFrom(p, ctx.ip), target: { provider: row.id, name: row.name, import: id }, detail: { job: job.id, ...(opts.fromDryRun ? { fromDryRun: opts.fromDryRun } : {}) }, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
    return { id, jobId: job.id };
  }

  private view(r: ImportRecord, withReport: boolean) {
    return {
      id: r.id,
      providerId: r.provider_id,
      dryRun: !!r.dry_run,
      fromDryRun: r.from_dry_run,
      state: r.state,
      jobId: r.job_id,
      createdBy: r.created_by,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
      error: r.error,
      summary: json<DirectoryImportSummary | null>(r.summary, null),
      ...(withReport ? { report: json<DirectoryImportRow[]>(r.report, []) } : {})
    };
  }

  async list(tenantId: string, providerId: string) {
    if (!(await this.available())) return { available: false, imports: [] };
    const rows = (await this.s.db('directory_imports').where({ tenant_id: tenantId, provider_id: providerId }).orderBy('created_at', 'desc').limit(20)) as ImportRecord[];
    return { available: true, imports: rows.map((r) => this.view(r, false)) };
  }

  /** One import with its report, and the job's progress while it runs. */
  async get(tenantId: string, providerId: string, id: string) {
    await this.assertAvailable();
    const r = (await this.s.db('directory_imports').where({ tenant_id: tenantId, provider_id: providerId, id }).first()) as ImportRecord | undefined;
    if (!r) throw notFound('Import');
    const job = r.job_id ? await this.s.jobs.get(tenantId, r.job_id) : undefined;
    return { ...this.view(r, true), progress: job ? job.progress : r.state === 'succeeded' ? 100 : 0, message: job?.message ?? null };
  }

  registerJobs(): void {
    this.s.jobs.register('directory.import', async (p, ctx) => this.run(String(p.importId), ctx.progress), { timeoutMs: 6 * 60 * 60_000 });
  }

  /** The job: plan every user, and in a real run make the accounts the plan accepts. */
  async run(id: string, progress: (pct: number, message?: string) => Promise<void> = async () => undefined): Promise<DirectoryImportSummary> {
    const s = this.s;
    const rec = (await s.db('directory_imports').where({ id }).first()) as ImportRecord | undefined;
    if (!rec) throw new Error('The import is gone.');
    const dryRun = !!rec.dry_run;
    await s.db('directory_imports').where({ id }).update({ state: 'running' });
    const summary = empty(dryRun);
    const report: DirectoryImportRow[] = [];
    try {
      const row = await s.providers.get(rec.tenant_id, rec.provider_id);
      if (!row) throw new Error('The store is gone.');
      const client = this.client(row);
      const cfg = parseProviderConfig(row.kind, row.config);
      const actor = json<{ roles: string[]; clearance: string } | null>(rec.actor, null);
      const ceiling: Label = actor && isLabel(actor.clearance) ? actor.clearance : 'public';
      const mappings = await s.users.mappings(rec.tenant_id);

      await progress(1, 'Reading the directory\'s users');
      const all: DirectoryUser[] = [];
      for await (const page of client.listUsers(IMPORT_MAX_USERS)) {
        all.push(...page);
        await progress(Math.min(19, 1 + all.length / 500), `Read ${all.length} users`);
      }
      summary.users = all.length;

      for (const [i, u] of all.entries()) {
        const out: DirectoryImportRow = { username: u.username, externalId: u.id, action: 'error' };
        try {
          if (!u.enabled) {
            out.action = 'disabled';
            out.detail = 'Disabled or suspended in the directory; not created.';
          } else if (await s.users.identity(row.id, u.id)) {
            out.action = 'existing';
            out.detail = 'Already linked; directory sync keeps it current.';
          } else {
            const same = await s.users.byUsername(rec.tenant_id, u.username);
            const others = same ? (await s.users.identitiesFor(same.id)).filter((l) => l.provider_id !== row.id) : [];
            const groups = await client.groupsOf(u.id);
            const mapped = resolveMappings(mappings, row.id, groups);
            const roles = mapped.roles.length ? mapped.roles : cfg.defaultRoles;
            const clearance: Label = mapped.clearance ?? cfg.defaultClearance;
            out.roles = roles;
            out.clearance = clearance;
            if (others.length) {
              out.action = 'conflict';
              out.detail = 'This username is linked to another store; never merged.';
            } else if (!roles.length) {
              out.action = 'no_mapped_group';
              out.detail = `None of the account's ${groups.length} group${groups.length === 1 ? '' : 's'} is mapped, and the store gives no default roles.`;
            } else if (!actor || roles.some((role) => !canGrant(actor.roles, role, rec.tenant_id)) || !clears(ceiling, clearance)) {
              out.action = 'refused';
              out.detail = 'The roles or clearance this account would get are beyond the importer\'s own.';
            } else {
              out.action = same ? 'link' : 'create';
              if (same) out.detail = 'An account with this username and no other store is linked to the directory, as at a first sign-in.';
              if (!dryRun) {
                const prov = await provision(s.users, rec.tenant_id, row, { externalId: u.id, username: u.username, displayName: u.displayName, email: u.email, groups }, { signIn: false });
                if (prov.status === 'ok') {
                  summary.applied++;
                  out.outcome = prov.created ? 'created' : 'linked';
                  await s.audit.append({ tenantId: rec.tenant_id, action: 'user.created', kind: 'system', actor: { service: 'directory-import', ...(rec.created_by ? { user: rec.created_by } : {}) }, target: { user: prov.user.id, username: prov.user.username, provider: row.name }, detail: { via: 'directory-import', import: id, created: prov.created, roles: prov.roles, clearance: prov.user.clearance } });
                } else {
                  out.outcome = `refused: ${prov.reason}`;
                }
              }
            }
          }
        } catch (err) {
          out.action = 'error';
          out.detail = (err as Error).message.slice(0, 300);
        }
        (summary[COUNT[out.action]] as number)++;
        if (report.length < REPORT_ROWS) report.push(out);
        if (i % 25 === 0 || i === all.length - 1) await progress(20 + ((i + 1) / Math.max(1, all.length)) * 79, `${dryRun ? 'Planned' : 'Imported'} ${i + 1} of ${all.length}`);
      }
      await s.db('directory_imports').where({ id }).update({ state: 'succeeded', summary: JSON.stringify(summary), report: JSON.stringify(report), finished_at: Date.now() });
      await s.audit.append({ tenantId: rec.tenant_id, action: 'identity.directory_import.completed', kind: 'system', actor: { service: 'directory-import' }, target: { provider: row.id, name: row.name, import: id }, detail: { ...summary } });
      if (!dryRun && summary.applied) await s.notifications.notify({ tenantId: rec.tenant_id, userIds: rec.created_by ? [rec.created_by] : [], kind: 'directory.sync', title: `Directory import made ${summary.applied} account${summary.applied === 1 ? '' : 's'}`, body: `${row.name}: ${summary.applied} of ${summary.users} directory users.`, route: 'directories' });
      return summary;
    } catch (err) {
      const message = (err as Error).message.slice(0, 500);
      await s.db('directory_imports').where({ id }).update({ state: 'failed', error: message, summary: JSON.stringify(summary), report: JSON.stringify(report), finished_at: Date.now() });
      throw err;
    }
  }
}

/** One per services object, so the routes and the job share it. */
const instances = new WeakMap<Services, DirectoryImports>();
export function directoryImportsFor(s: Services): DirectoryImports {
  let x = instances.get(s);
  if (!x) instances.set(s, (x = new DirectoryImports(s)));
  return x;
}
