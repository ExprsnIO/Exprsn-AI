import { ulid } from 'ulid';
import type { AuditActor } from '../audit/chain.js';
import { actorFrom } from '../audit/chain.js';
import { clears, isLabel, LABELS, type Label } from '../authz/labels.js';
import { canGrant, canManage, isRole, rolesRequireMfa } from '../authz/permissions.js';
import type { Principal } from '../authz/policy.js';
import { randomToken } from '../crypto/index.js';
import { json } from '../db/knex.js';
import { badRequest, HttpProblem, notFound } from '../http/problem.js';
import { normaliseGroup, type GroupMapping } from '../repos/users.js';
import type { Services } from '../services.js';
import { loadPrincipal } from '../http/middleware.js';
import { hashPassword } from './passwords.js';
import { USERNAME } from './signup.js';

/*
 * Sprint 26a (B-1805): users, workspace memberships and group mappings from one CSV, imported as a job with a report
 * (ported in design from exprsn-platform's user import service: header-keyed rows, a per-row result, a role ceiling
 * from the importer's own roles; here the work is a job and a dry run writes nothing).
 *
 * One header row, then one row per item; the `kind` column says what a row is:
 *
 *   kind,username,display_name,email,roles,clearance,workspace,provider,group
 *   user,ada,Ada Lovelace,ada@example.com,member;knowledge-curator,internal,,,
 *   membership,ada,,,,,research,,
 *   mapping,,,,flag-reviewer,internal,research,Corporate LDAP,cn=reviewers,ou=groups,dc=example,dc=com
 *
 * - `user` creates a local account (roles separated by `;`), or updates a local account's name, address, direct roles
 *   and clearance. An account linked to another user store is a conflict, never merged. New accounts get a password
 *   nobody knows: an invitation link when asked (`sendInvites`, needs an address and SMTP), or a reset by an admin.
 * - `membership` adds a direct workspace membership (workspace by slug or id).
 * - `mapping` adds a group mapping (one role), or changes its clearance; `provider` names a user store (empty: any).
 *
 * Every row is checked against the importer as the API checks them: roles they may grant, clearance at or below
 * theirs, accounts whose roles they could manage. The plan comes first; a dry run reports it and changes nothing, and
 * a real run applies only the rows the plan accepted, auditing each change. The CLI imports as the operator.
 */

export const IMPORT_COLUMNS = ['kind', 'username', 'display_name', 'email', 'roles', 'clearance', 'workspace', 'provider', 'group'] as const;

export type RowAction = 'create' | 'update' | 'unchanged' | 'conflict' | 'error';

export interface RowResult {
  row: number;
  kind: string;
  key: string;
  action: RowAction;
  detail: string;
  changes?: Record<string, unknown>;
  /** After a real run: what happened (applied, invited, failed). */
  outcome?: string;
}

export interface ImportSummary {
  rows: number;
  create: number;
  update: number;
  unchanged: number;
  conflict: number;
  error: number;
  applied: number;
  dryRun: boolean;
}

/** Who imports: a user (checked like the API) or the operator at the command line (no role ceiling). */
export type Importer = { kind: 'user'; principal: Principal } | { kind: 'cli'; tenantId: string };

const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,255}$/;

/** RFC 4180 CSV: quoted fields with doubled quotes, CRLF or LF line ends, a leading BOM. Throws on an open quote. */
export function parseCsv(text: string, maxRows: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endRow = () => {
    row.push(field);
    field = '';
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
    if (rows.length > maxRows + 1) throw badRequest(`The CSV has more than ${maxRows} rows.`);
  };
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') endRow();
    else if (c === '\r') {
      if (text[i + 1] !== '\n') endRow();
    } else field += c;
  }
  if (quoted) throw badRequest('The CSV has an unterminated quoted field.');
  if (field !== '' || row.length) endRow();
  return rows;
}

interface Parsed {
  row: number;
  kind: string;
  get: (col: (typeof IMPORT_COLUMNS)[number]) => string;
}

function readRows(csv: string, maxRows: number): Parsed[] {
  const rows = parseCsv(csv, maxRows);
  if (!rows.length) throw badRequest('The CSV is empty.');
  const header = rows[0]!.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  if (!header.includes('kind')) throw badRequest(`The first row must be a header naming the columns: ${IMPORT_COLUMNS.join(',')}.`);
  const unknown = header.filter((h) => h && !(IMPORT_COLUMNS as readonly string[]).includes(h));
  if (unknown.length) throw badRequest(`Unknown columns: ${unknown.slice(0, 5).join(', ')}. The columns are ${IMPORT_COLUMNS.join(', ')}.`);
  return rows.slice(1).map((cells, i) => {
    const get = (col: (typeof IMPORT_COLUMNS)[number]) => {
      const k = header.indexOf(col);
      return k >= 0 ? (cells[k] ?? '').trim() : '';
    };
    return { row: i + 2, kind: get('kind').toLowerCase(), get };
  });
}

interface PlanItem extends RowResult {
  apply?: () => Promise<string>;
}

export class UserImportService {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  registerJobs(): void {
    this.s().jobs.register('users.import', async (p, ctx) => {
      const id = String(p.importId);
      await ctx.progress(5, 'Reading the CSV');
      const out = await this.runStored(id, async (pct, msg) => ctx.progress(pct, msg));
      return out.summary;
    }, { timeoutMs: 60 * 60_000 });
  }

  /** Stores an import (CSV sealed with the tenant key) and queues its job. */
  async submit(p: Principal, csv: string, opts: { dryRun: boolean; sendInvites: boolean }, ctx: { ip: string | null; traceId?: string }): Promise<{ id: string; jobId: string }> {
    const s = this.s();
    if (Buffer.byteLength(csv) > s.cfg.USER_IMPORT_MAX_BYTES) throw new HttpProblem(413, 'Too large', `The CSV is larger than ${s.cfg.USER_IMPORT_MAX_BYTES} bytes.`);
    // Reject an unreadable file now, not in the job.
    const rows = readRows(csv, s.cfg.USER_IMPORT_MAX_ROWS);
    const id = ulid();
    await this.db('user_imports').insert({ id, tenant_id: p.tenantId, created_by: p.userId, actor: null, dry_run: opts.dryRun, send_invites: opts.sendInvites, state: 'queued', csv_sealed: await s.keys.seal(p.tenantId, csv, `user_imports:${id}`), rows: rows.length, summary: null, report: null, job_id: null, error: null, created_at: Date.now(), finished_at: null });
    const job = await s.jobs.enqueue({ tenantId: p.tenantId, type: 'users.import', payload: { importId: id }, createdBy: p.userId, maxAttempts: 1 });
    await this.db('user_imports').where({ id }).update({ job_id: job.id });
    await s.audit.append({ tenantId: p.tenantId, action: opts.dryRun ? 'user.import.dry_run' : 'user.import.requested', kind: 'admin', actor: actorFrom(p, ctx.ip), target: { import: id }, detail: { rows: rows.length, sendInvites: opts.sendInvites, job: job.id }, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
    return { id, jobId: job.id };
  }

  async get(tenantId: string, id: string) {
    const r = (await this.db('user_imports').where({ tenant_id: tenantId, id }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Import');
    return this.view(r, true);
  }

  async list(tenantId: string) {
    const rows = (await this.db('user_imports').where({ tenant_id: tenantId }).orderBy('created_at', 'desc').limit(100)) as Record<string, unknown>[];
    return rows.map((r) => this.view(r, false));
  }

  private view(r: Record<string, unknown>, withReport: boolean) {
    return {
      id: String(r.id),
      state: String(r.state),
      dryRun: !!r.dry_run,
      sendInvites: !!r.send_invites,
      rows: Number(r.rows),
      createdBy: (r.created_by as string | null) ?? null,
      jobId: (r.job_id as string | null) ?? null,
      error: (r.error as string | null) ?? null,
      summary: json<ImportSummary | null>(r.summary as string | null, null),
      createdAt: Number(r.created_at),
      finishedAt: r.finished_at == null ? null : Number(r.finished_at),
      ...(withReport ? { report: json<RowResult[]>(r.report as string | null, []) } : {})
    };
  }

  /** Runs a stored import as its submitter (their current roles and clearance). */
  private async runStored(id: string, progress: (pct: number, msg: string) => Promise<void>): Promise<{ summary: ImportSummary; report: RowResult[] }> {
    const s = this.s();
    const r = (await this.db('user_imports').where({ id }).first()) as Record<string, unknown> | undefined;
    if (!r) throw new Error('import not found');
    if (r.state === 'done') return { summary: json<ImportSummary>(r.summary as string, {} as ImportSummary), report: json<RowResult[]>(r.report as string, []) };
    await this.db('user_imports').where({ id }).update({ state: 'running' });
    try {
      const tenantId = String(r.tenant_id);
      const principal = r.created_by ? await loadPrincipal(s, tenantId, String(r.created_by), {}) : null;
      if (!principal) throw new Error('The account that submitted this import is no longer active.');
      const csv = await s.keys.open(tenantId, String(r.csv_sealed), `user_imports:${id}`);
      const out = await this.run({ kind: 'user', principal }, csv, { dryRun: !!r.dry_run, sendInvites: !!r.send_invites }, progress);
      await this.db('user_imports').where({ id }).update({ state: 'done', summary: JSON.stringify(out.summary), report: JSON.stringify(out.report), finished_at: Date.now() });
      await s.audit.append({ tenantId, action: out.summary.dryRun ? 'user.import.dry_run_reported' : 'user.import.completed', kind: 'admin', actor: actorFrom(principal, null), target: { import: id }, detail: { ...out.summary } });
      return out;
    } catch (err) {
      await this.db('user_imports').where({ id }).update({ state: 'failed', error: (err as Error).message.slice(0, 500), finished_at: Date.now() });
      throw err;
    }
  }

  /**
   * Plans an import and, unless it is a dry run, applies the rows the plan accepted. The plan reads only; a dry run
   * returns it and writes nothing at all.
   */
  async run(importer: Importer, csv: string, opts: { dryRun: boolean; sendInvites: boolean }, progress: (pct: number, msg: string) => Promise<void> = async () => undefined): Promise<{ summary: ImportSummary; report: RowResult[] }> {
    const s = this.s();
    const rows = readRows(csv, s.cfg.USER_IMPORT_MAX_ROWS);
    const plan = await this.plan(importer, rows, opts);
    await progress(40, `Planned ${plan.length} rows`);
    let applied = 0;
    if (!opts.dryRun) {
      let done = 0;
      for (const item of plan) {
        if (item.apply) {
          try {
            item.outcome = await item.apply();
            applied++;
          } catch (err) {
            item.outcome = `failed: ${(err as Error).message.slice(0, 200)}`;
          }
        }
        if (++done % 100 === 0) await progress(40 + Math.round((done / plan.length) * 55), `Applied ${done} of ${plan.length}`);
      }
    }
    const report: RowResult[] = plan.map(({ apply: _apply, ...r }) => r).sort((a, b) => a.row - b.row);
    const count = (a: RowAction) => report.filter((r) => r.action === a).length;
    const summary: ImportSummary = { rows: report.length, create: count('create'), update: count('update'), unchanged: count('unchanged'), conflict: count('conflict'), error: count('error'), applied, dryRun: opts.dryRun };
    await progress(100, opts.dryRun ? 'Dry run: nothing was changed' : `Applied ${applied} changes`);
    return { summary, report };
  }

  private async plan(importer: Importer, rows: Parsed[], opts: { sendInvites: boolean }): Promise<PlanItem[]> {
    const s = this.s();
    const tenantId = importer.kind === 'user' ? importer.principal.tenantId : importer.tenantId;
    const actor: AuditActor = importer.kind === 'user' ? actorFrom(importer.principal, null) : { service: 'cli' };
    const mayGrant = (role: string) => importer.kind === 'cli' || canGrant(importer.principal.roles, role);
    const mayClear = (l: Label) => importer.kind === 'cli' || clears(importer.principal.clearance, l);
    const mayManage = (roles: string[]) => importer.kind === 'cli' || canManage(importer.principal.roles, roles);
    const audit = (action: string, target: Record<string, unknown>, detail: Record<string, unknown>) => s.audit.append({ tenantId, action, kind: 'admin', actor, target, detail: { ...detail, via: 'import' } });

    const providers = await s.providers.list(tenantId);
    const local = providers.find((p) => p.kind === 'local');
    const workspaces = await s.tenants.workspaces(tenantId);
    const workspaceOf = (ref: string) => workspaces.find((w) => w.slug === ref.toLowerCase() || w.id === ref);
    const mappings: GroupMapping[] = await s.users.mappings(tenantId);
    const tenant = await s.tenants.byId(tenantId);
    /** Usernames the plan creates, for membership rows later in the file. */
    const planned = new Set<string>();
    const seen = new Map<string, number>();
    const out: PlanItem[] = [];
    const order = (k: string) => (k === 'user' ? 0 : k === 'mapping' ? 1 : k === 'membership' ? 2 : 3);
    const sorted = [...rows].sort((a, b) => order(a.kind) - order(b.kind) || a.row - b.row);

    const roleList = (v: string) => [...new Set(v.split(/[;|]/).map((x) => x.trim()).filter(Boolean))];

    for (const r of sorted) {
      const push = (item: PlanItem) => void out.push(item);
      const fail = (key: string, detail: string, action: RowAction = 'error') => push({ row: r.row, kind: r.kind || '(none)', key, action, detail });
      if (r.kind === 'user') {
        const username = r.get('username').toLowerCase();
        if (!USERNAME.test(username)) {
          fail(username || '(none)', 'The username must start with a letter or digit and use only a-z, 0-9, dot, dash, underscore and @.');
          continue;
        }
        if (seen.has(`user:${username}`)) {
          fail(username, `The username appears again (first on row ${seen.get(`user:${username}`)}).`, 'conflict');
          continue;
        }
        seen.set(`user:${username}`, r.row);
        const email = r.get('email').toLowerCase() || null;
        if (email && !EMAIL.test(email)) {
          fail(username, `${email} is not an email address.`);
          continue;
        }
        const roles = roleList(r.get('roles'));
        const badRole = roles.find((x) => !isRole(x));
        if (badRole) {
          fail(username, `Unknown role ${badRole}.`);
          continue;
        }
        const denied = roles.filter((x) => !mayGrant(x));
        if (denied.length) {
          fail(username, `Your roles cannot grant ${denied.join(', ')}.`);
          continue;
        }
        const clearanceRaw = r.get('clearance').toLowerCase();
        if (clearanceRaw && !isLabel(clearanceRaw)) {
          fail(username, `Unknown clearance ${clearanceRaw}; use one of ${LABELS.join(', ')}.`);
          continue;
        }
        const clearance = (clearanceRaw || 'internal') as Label;
        if (!mayClear(clearance)) {
          fail(username, 'You cannot grant a clearance above your own.');
          continue;
        }
        const displayName = (r.get('display_name') || username).slice(0, 200);
        const existing = await s.users.byUsername(tenantId, username);
        if (email) {
          const other = (await this.db('users').where({ tenant_id: tenantId }).whereRaw('LOWER(email) = ?', [email]).first('id')) as { id: string } | undefined;
          if (other && other.id !== existing?.id) {
            fail(username, `Another account already has the address ${email}.`, 'conflict');
            continue;
          }
          const dup = [...seen.entries()].find(([k, v]) => k === `email:${email}` && v !== r.row);
          if (dup) {
            fail(username, `The address ${email} appears again (first on row ${dup[1]}).`, 'conflict');
            continue;
          }
          seen.set(`email:${email}`, r.row);
        }
        if (!existing) {
          if (!local) {
            fail(username, 'This tenant has no local user store to create accounts in.');
            continue;
          }
          planned.add(username);
          push({
            row: r.row,
            kind: 'user',
            key: username,
            action: 'create',
            detail: `New local account with ${roles.length ? roles.join(', ') : 'no roles'} at ${clearance}.`,
            changes: { displayName, email, roles, clearance },
            apply: async () => {
              const hash = await hashPassword(randomToken(32));
              const u = await this.db.transaction(async (trx) => {
                const users = s.users.within(trx);
                const created = await users.create(tenantId, { username, displayName, email, clearance, mfaRequired: rolesRequireMfa(roles) });
                await users.update(tenantId, created.id, { clearance_direct: clearance });
                if (email) await trx('users').where({ id: created.id }).update({ email_verified_at: Date.now() });
                await trx('local_credentials').insert({ user_id: created.id, password_hash: hash, must_change: false, updated_at: Date.now() });
                await users.upsertIdentity(created.id, local.id, created.id, []);
                await users.setRoles(created.id, 'direct', roles);
                return created;
              });
              await audit('user.created', { user: u.id, username }, { roles, clearance, store: local.name });
              if (opts.sendInvites && email && s.notifications.emailEnabled) {
                const { token } = await s.account.issueToken({ tenantId, userId: u.id, kind: 'invite', ttlMs: s.cfg.PASSWORD_INVITE_HOURS * 3600_000, createdBy: importer.kind === 'user' ? importer.principal.userId : null });
                const sent = await s.notifications.sendTemplate(email, 'invite', { name: displayName, username, actor: importer.kind === 'user' ? importer.principal.displayName : 'An administrator', tenant: tenant?.name ?? '', hours: s.cfg.PASSWORD_INVITE_HOURS, link: s.account.resetLink(token, tenant?.slug ?? s.cfg.DEFAULT_TENANT) });
                await audit('user.invited', { user: u.id, username }, { sent, expiresInHours: s.cfg.PASSWORD_INVITE_HOURS });
                return sent ? 'created, invitation sent' : 'created, invitation not sent';
              }
              return 'created';
            }
          });
          continue;
        }
        const links = await s.users.identitiesFor(existing.id);
        const foreign = links.find((l) => l.provider_id !== local?.id);
        if (foreign || !local || !(await s.account.localCredential(existing.id))) {
          const store = providers.find((p) => p.id === foreign?.provider_id)?.name ?? 'another user store';
          fail(username, `The account exists and is linked to ${store}; it is not changed by an import.`, 'conflict');
          continue;
        }
        const current = await s.users.roles(existing.id);
        if (!mayManage(current.map((x) => x.role))) {
          fail(username, 'The account holds roles you cannot grant, so you cannot change it.');
          continue;
        }
        const direct = current.filter((x) => x.source === 'direct').map((x) => x.role).sort();
        const changes: Record<string, unknown> = {};
        if (existing.display_name !== displayName) changes.displayName = displayName;
        if ((existing.email ?? null) !== email && email) changes.email = email;
        if (JSON.stringify(direct) !== JSON.stringify([...roles].sort())) {
          const removed = direct.filter((x) => !roles.includes(x)).filter((x) => !mayGrant(x));
          if (removed.length) {
            fail(username, `Your roles cannot remove ${removed.join(', ')}.`);
            continue;
          }
          changes.roles = roles;
        }
        if ((existing.clearance_direct ?? null) !== clearance) changes.clearance = clearance;
        if (!Object.keys(changes).length) {
          push({ row: r.row, kind: 'user', key: username, action: 'unchanged', detail: 'The account already matches.' });
          continue;
        }
        push({
          row: r.row,
          kind: 'user',
          key: username,
          action: 'update',
          detail: `Changes ${Object.keys(changes).join(', ')}.`,
          changes,
          apply: async () => {
            const patch: Parameters<typeof s.users.update>[2] = {};
            if (changes.displayName) patch.display_name = displayName;
            if (changes.email) patch.email = email;
            if (changes.clearance) {
              patch.clearance_direct = clearance;
              patch.clearance = clearance;
            }
            if (changes.roles) await s.users.setRoles(existing.id, 'direct', roles);
            const all = await s.users.roleIds(existing.id);
            patch.mfa_required = existing.mfa_required || rolesRequireMfa(all);
            await s.users.update(tenantId, existing.id, patch);
            if (changes.email) await this.db('users').where({ id: existing.id }).update({ email_verified_at: Date.now() });
            // Access changes take effect at once, as for an admin's change.
            const revoked = changes.roles || changes.clearance ? await s.sessions.revokeAllForUser(existing.id) : 0;
            await audit('user.updated', { user: existing.id, username }, { after: changes, sessionsRevoked: revoked });
            return 'updated';
          }
        });
        continue;
      }

      if (r.kind === 'membership') {
        const username = r.get('username').toLowerCase();
        const ws = workspaceOf(r.get('workspace'));
        const key = `${username || '(none)'} in ${r.get('workspace') || '(none)'}`;
        if (!ws) {
          fail(key, `No workspace ${r.get('workspace') || '(empty)'} in this tenant.`);
          continue;
        }
        if (seen.has(`member:${username}:${ws.id}`)) {
          fail(key, `The membership appears again (first on row ${seen.get(`member:${username}:${ws.id}`)}).`, 'conflict');
          continue;
        }
        seen.set(`member:${username}:${ws.id}`, r.row);
        const existing = await s.users.byUsername(tenantId, username);
        if (!existing && !planned.has(username)) {
          fail(key, `No account ${username || '(empty)'} in this tenant or in this file.`);
          continue;
        }
        if (existing && !mayManage(await s.users.roleIds(existing.id))) {
          fail(key, 'The account holds roles you cannot grant, so you cannot change its memberships.');
          continue;
        }
        if (existing && (await this.db('workspace_members').where({ workspace_id: ws.id, user_id: existing.id, source: 'direct' }).first('user_id'))) {
          push({ row: r.row, kind: 'membership', key, action: 'unchanged', detail: 'Already a direct member.' });
          continue;
        }
        push({
          row: r.row,
          kind: 'membership',
          key,
          action: 'create',
          detail: `Joins ${ws.name} directly.`,
          apply: async () => {
            const u = await s.users.byUsername(tenantId, username);
            if (!u) throw new Error('the account was not created');
            await s.tenants.addMember(ws.id, u.id);
            await audit('workspace.member.added', { workspace: ws.id, user: u.id, username }, {});
            return 'added';
          }
        });
        continue;
      }

      if (r.kind === 'mapping') {
        const group = normaliseGroup(r.get('group'));
        const role = r.get('roles').trim();
        const providerName = r.get('provider');
        const wsRef = r.get('workspace');
        const key = `${group || '(none)'} -> ${role || '(none)'}`;
        if (!group || group.length > 512) {
          fail(key, 'A mapping needs a group (up to 512 characters).');
          continue;
        }
        if (!isRole(role)) {
          fail(key, `A mapping names one known role in the roles column; ${role || '(empty)'} is not one.`);
          continue;
        }
        if (!mayGrant(role)) {
          fail(key, `Your roles cannot grant ${role}.`);
          continue;
        }
        const clearanceRaw = r.get('clearance').toLowerCase();
        if (clearanceRaw && !isLabel(clearanceRaw)) {
          fail(key, `Unknown clearance ${clearanceRaw}.`);
          continue;
        }
        const clearance = (clearanceRaw || 'internal') as Label;
        if (!mayClear(clearance)) {
          fail(key, 'You cannot map a clearance above your own.');
          continue;
        }
        const provider = providerName ? providers.find((p) => p.name.toLowerCase() === providerName.toLowerCase() || p.id === providerName) : null;
        if (providerName && !provider) {
          fail(key, `No user store ${providerName} in this tenant.`);
          continue;
        }
        const ws = wsRef ? workspaceOf(wsRef) : null;
        if (wsRef && !ws) {
          fail(key, `No workspace ${wsRef} in this tenant.`);
          continue;
        }
        const id = `mapping:${provider?.id ?? ''}:${group}:${role}:${ws?.id ?? ''}`;
        if (seen.has(id)) {
          fail(key, `The mapping appears again (first on row ${seen.get(id)}).`, 'conflict');
          continue;
        }
        seen.set(id, r.row);
        const same = mappings.find((m) => (m.provider_id ?? null) === (provider?.id ?? null) && m.group_name === group && m.role === role && (m.workspace_id ?? null) === (ws?.id ?? null));
        if (same && same.clearance === clearance) {
          push({ row: r.row, kind: 'mapping', key, action: 'unchanged', detail: 'The mapping exists.' });
          continue;
        }
        if (same) {
          push({
            row: r.row,
            kind: 'mapping',
            key,
            action: 'update',
            detail: `Clearance ${same.clearance} becomes ${clearance}.`,
            changes: { clearance },
            apply: async () => {
              await s.users.updateMapping(tenantId, same.id, { clearance });
              await audit('identity.mapping.updated', { mapping: same.id, group }, { before: { clearance: same.clearance }, after: { clearance } });
              return 'updated';
            }
          });
          continue;
        }
        push({
          row: r.row,
          kind: 'mapping',
          key,
          action: 'create',
          detail: `Members of ${group}${provider ? ` in ${provider.name}` : ''} get ${role} at ${clearance}${ws ? ` and join ${ws.name}` : ''}.`,
          changes: { provider: provider?.name ?? null, group, role, clearance, workspace: ws?.slug ?? null },
          apply: async () => {
            const row = await s.users.addMapping(tenantId, { providerId: provider?.id ?? null, group, role, clearance, workspaceId: ws?.id ?? null });
            await audit('identity.mapping.created', { mapping: row.id, group: row.group_name, role, clearance, workspace: row.workspace_id }, {});
            return 'created';
          }
        });
        continue;
      }

      fail(r.get('username') || '(none)', `Unknown kind ${r.kind || '(empty)'}: use user, membership or mapping.`);
    }
    // In the order they apply: accounts, then mappings, then memberships (the report is sorted by row).
    return out;
  }
}
