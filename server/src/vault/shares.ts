import { ulid } from 'ulid';
import { PLATFORM_TENANT } from '../audit/chain.js';
import { clears, isLabel, type Label } from '../authz/labels.js';
import { permissionsFor } from '../authz/permissions.js';
import { badRequest, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import { evaluate, kvPolicyPath, subjectMatches, type Grant, type SubjectKind } from './policy.js';
import { DAY_MS, type VaultCaller } from './service.js';

/*
 * 1.6.0 (B-4801): sharing one KV secret with a principal.
 *
 * A share is a vault policy grant (B-1703), not a second access path: `allow read, list` on the secret's exact path
 * (`kv/<path>`) to one subject (a user, a directory group, a workspace's members or an API key), marked with the
 * secret it shares (`share_secret_id`) and an optional expiry. So everything the policies decide still applies:
 *
 * - a deny that names the grantee wins over the share (deny wins), so a share never reaches anyone the policy denies;
 *   sharing with a user an explicit deny names is refused up front, with the deciding grant;
 * - the secret's label still has to clear the grantee's clearance (a user below it is refused up front; a member of a
 *   shared group or workspace below it does not see the secret, as for any grant);
 * - explain names the share as the deciding grant, and the Policies tab lists it with its expiry.
 *
 * Who shares: a holder of `secrets:write` whose policy allows both `read` and `write` on the path (sharing widens who
 * reads, so it needs more than reading). The sharer, anyone who may share the secret, or a vault administrator (by
 * deleting the grant under Policies) revokes it; an expired share stops applying at once (the policy query leaves it
 * out) and the `vault.shares.expire` job removes it and audits the end. Removing the secret removes its shares.
 * Reveals by a grantee are audited and watched like any other (B-4803), so the owner hears of unusual ones.
 */

export const EXPIRE_JOB = 'vault.shares.expire';
const SHARE_CAPS = ['read', 'list'] as const;

interface ShareRow {
  id: string;
  tenant_id: string;
  subject_kind: SubjectKind;
  subject: string;
  path: string;
  description: string | null;
  created_by: string | null;
  created_at: number | string;
  share_secret_id: string;
  expires_at: number | string | null;
}

export interface ShareInput {
  subjectKind: SubjectKind;
  subject: string;
  expiresInDays?: number | null | undefined;
  note?: string | null | undefined;
}

const num = (v: unknown): number => Number(v);

export class VaultShares {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  registerJobs(): void {
    this.s().jobs.register(EXPIRE_JOB, async (_p, ctx) => {
      const n = await this.expire();
      await ctx.progress(100, `${n} share${n === 1 ? '' : 's'} ended`);
      return { ended: n };
    });
  }

  schedule(scheduler: Scheduler): void {
    scheduler.every(EXPIRE_JOB, 300_000, async () => {
      const due = await this.db('vault_policies').whereNotNull('share_secret_id').andWhere('expires_at', '<=', Date.now()).first('id');
      return due ? [{ tenantId: PLATFORM_TENANT, key: 'all' }] : [];
    });
  }

  private audit(c: VaultCaller, action: string, target: Record<string, unknown>, label: Label, detail?: Record<string, unknown>) {
    return this.s().audit.append({ tenantId: c.tenantId, action, kind: 'admin', actor: c.actor, target, label, ...(detail ? { detail } : {}), traceId: c.traceId ?? null });
  }

  /** The secret a share names, as the caller may see it, after checking they may share it (read and write on it). */
  private async shareable(c: VaultCaller, rawPath: string) {
    const v = this.s().vault;
    const secret = await v.secretAt(c, rawPath);
    const policyPath = kvPolicyPath(secret?.path ?? rawPath.replace(/^\/+|\/+$/g, ''));
    await v.authorize(c, policyPath, 'read');
    await v.authorize(c, policyPath, 'write');
    if (!secret) throw notFound('Secret');
    return { secret, policyPath };
  }

  private async names(tenantId: string, rows: ShareRow[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const users = [...new Set(rows.flatMap((r) => [r.created_by, r.subject_kind === 'user' ? r.subject : null]).filter((x): x is string => !!x))];
    if (users.length) for (const u of (await this.db('users').where({ tenant_id: tenantId }).whereIn('id', users).select('id', 'username', 'display_name')) as { id: string; username: string; display_name: string }[]) out.set(`user:${u.id}`, u.display_name || u.username);
    const ws = rows.filter((r) => r.subject_kind === 'workspace').map((r) => r.subject);
    if (ws.length) for (const w of (await this.db('workspaces').where({ tenant_id: tenantId }).whereIn('id', ws).select('id', 'name')) as { id: string; name: string }[]) out.set(`workspace:${w.id}`, w.name);
    const keys = rows.filter((r) => r.subject_kind === 'api_key').map((r) => r.subject);
    if (keys.length) for (const k of (await this.db('api_keys').where({ tenant_id: tenantId }).whereIn('id', keys).select('id', 'name')) as { id: string; name: string }[]) out.set(`api_key:${k.id}`, k.name);
    return out;
  }

  private view(r: ShareRow, names: Map<string, string>, path: string) {
    const expiresAt = r.expires_at == null ? null : num(r.expires_at);
    return {
      id: r.id,
      path,
      subjectKind: r.subject_kind,
      subject: r.subject,
      subjectName: r.subject_kind === 'group' ? r.subject : (names.get(`${r.subject_kind}:${r.subject}`) ?? null),
      capabilities: [...SHARE_CAPS],
      note: r.description,
      sharedBy: r.created_by,
      sharedByName: r.created_by ? (names.get(`user:${r.created_by}`) ?? null) : null,
      sharedAt: num(r.created_at),
      expiresAt,
      state: expiresAt != null && expiresAt <= Date.now() ? ('expired' as const) : ('active' as const)
    };
  }

  /** The shares of one secret (for those who may share it). */
  async list(c: VaultCaller, rawPath: string) {
    const { secret } = await this.shareable(c, rawPath);
    const rows = (await this.db('vault_policies').where({ tenant_id: c.tenantId, share_secret_id: secret.id }).orderBy('created_at', 'asc')) as ShareRow[];
    const names = await this.names(c.tenantId, rows);
    return rows.map((r) => this.view(r, names, secret.path));
  }

  /**
   * Shares the secret at `rawPath` with one subject. Sharing again with the same subject moves the expiry (and the
   * note) of the existing share instead of adding a second grant.
   */
  async share(c: VaultCaller, rawPath: string, input: ShareInput) {
    const s = this.s();
    const { secret, policyPath } = await this.shareable(c, rawPath);
    const subject = await s.vault.validSubject(c.tenantId, input.subjectKind, input.subject);
    if (input.subjectKind === 'user' && subject === c.subjects.userId) throw badRequest('You can already read this secret; share it with someone else.');
    const max = s.cfg.VAULT_SHARE_MAX_DAYS;
    let days = input.expiresInDays ?? null;
    if (max > 0) {
      if (days != null && days > max) throw badRequest(`A share lasts at most ${max} days on this server (VAULT_SHARE_MAX_DAYS).`);
      days = days ?? max;
    }
    const expiresAt = days != null ? Date.now() + Math.round(days * DAY_MS) : null;

    // The grantee as the policy sees them: a user's clearance and any deny that names them.
    if (input.subjectKind === 'user') {
      const user = await s.users.get(c.tenantId, subject);
      if (!user || user.state !== 'active') throw badRequest('That user is not active.');
      const clearance: Label = isLabel(user.clearance) ? user.clearance : 'public';
      if (!clears(clearance, secret.label)) throw new HttpProblem(422, 'Below the secret\'s label', `${user.display_name || user.username} is cleared for ${clearance}; the secret is ${secret.label}, so a share would not let them read it.`, { extensions: { step: 'clearance' } });
      if (!permissionsFor(await s.users.roleIds(subject), c.tenantId).has('secrets:read')) throw new HttpProblem(422, 'No vault access', `${user.display_name || user.username} does not hold secrets:read, so a share would not let them read it.`, { extensions: { step: 'role', action: 'secrets:read' } });
      const subjects = await s.vault.subjectsFor(c.tenantId, subject, null);
      const deny = evaluate((await s.vault.grantsOf(c.tenantId, subjects)).filter((g) => g.effect === 'deny'), subjects, policyPath, 'read');
      if (deny.grant) throw new HttpProblem(409, 'Denied by policy', `A vault policy denies ${user.display_name || user.username} read on ${policyPath} (grant ${deny.grant.id}); a deny wins over a share, so it would not apply.`, { extensions: { step: 'vault-policy', grant: deny.grant.id } });
    }

    const existing = (await this.db('vault_policies').where({ tenant_id: c.tenantId, share_secret_id: secret.id, subject_kind: input.subjectKind, subject }).first()) as ShareRow | undefined;
    const now = Date.now();
    let row: ShareRow;
    if (existing) {
      await this.db('vault_policies').where({ id: existing.id }).update({ expires_at: expiresAt, description: input.note ?? existing.description, updated_at: now });
      row = { ...existing, expires_at: expiresAt, description: input.note ?? existing.description };
    } else {
      row = { id: ulid(), tenant_id: c.tenantId, subject_kind: input.subjectKind, subject, path: policyPath, description: input.note ?? null, created_by: c.subjects.userId, created_at: now, share_secret_id: secret.id, expires_at: expiresAt };
      await this.db('vault_policies').insert({ ...row, capabilities: JSON.stringify(SHARE_CAPS), effect: 'allow', updated_at: now });
    }
    await this.audit(c, existing ? 'vault.secret.share.updated' : 'vault.secret.shared', { path: secret.path, share: row.id }, secret.label, { subjectKind: input.subjectKind, subject, expiresAt, capabilities: SHARE_CAPS });
    if (input.subjectKind === 'user' && !existing) {
      await s.notifications
        .notify({ tenantId: c.tenantId, userIds: [subject], kind: 'vault', title: `A secret was shared with you: ${secret.path}`, body: expiresAt ? `You may read it until ${new Date(expiresAt).toISOString()}.` : 'You may read it until the share is revoked.', route: `vault?path=${encodeURIComponent(secret.path)}`, label: secret.label })
        .catch(() => undefined);
    }
    const names = await this.names(c.tenantId, [row]);
    return this.view(row, names, secret.path);
  }

  /** Revokes a share: its sharer, anyone who may share the secret, or a vault administrator. */
  async revoke(c: VaultCaller, id: string, isAdmin: boolean) {
    const r = (await this.db('vault_policies').where({ tenant_id: c.tenantId, id }).whereNotNull('share_secret_id').first()) as ShareRow | undefined;
    if (!r) throw notFound('Share');
    const secret = (await this.db('vault_secrets').where({ tenant_id: c.tenantId, id: r.share_secret_id }).first('path', 'label')) as { path: string; label: string } | undefined;
    const label: Label = secret && isLabel(secret.label) ? secret.label : 'restricted';
    if (secret && !clears(c.clearance, label)) throw notFound('Share');
    if (!isAdmin && r.created_by !== c.subjects.userId) {
      if (!secret) throw notFound('Share');
      await this.shareable(c, secret.path).catch(() => {
        throw forbidden('Only whoever shared it, someone who may share the secret, or a vault administrator revokes a share.', { step: 'owner' });
      });
    }
    await this.db('vault_policies').where({ id: r.id }).delete();
    await this.audit(c, 'vault.secret.share.revoked', { path: secret?.path ?? r.path.replace(/^kv\//, ''), share: r.id }, label, { subjectKind: r.subject_kind, subject: r.subject });
    return { id: r.id, revoked: true };
  }

  /** The secrets shared with the caller (any of their subjects) that they may read now. */
  async sharedWithMe(c: VaultCaller) {
    const grants = await this.s().vault.grantsOf(c.tenantId, c.subjects);
    const shares = grants.filter((g): g is Grant & { shareSecretId: string } => !!g.shareSecretId && subjectMatches(g, c.subjects));
    if (!shares.length) return [];
    const secrets = new Map(((await this.db('vault_secrets').where({ tenant_id: c.tenantId }).whereIn('id', [...new Set(shares.map((g) => g.shareSecretId))]).select('id', 'path', 'label', 'current_version', 'updated_at')) as { id: string; path: string; label: string; current_version: number | string; updated_at: number | string }[]).map((r) => [r.id, r]));
    const rows = (await this.db('vault_policies').whereIn('id', shares.map((g) => g.id))) as ShareRow[];
    const names = await this.names(c.tenantId, rows);
    const out = [];
    for (const r of rows) {
      const sec = secrets.get(r.share_secret_id);
      if (!sec || !isLabel(sec.label) || !clears(c.clearance, sec.label)) continue;
      const readable = evaluate(grants, c.subjects, kvPolicyPath(sec.path), 'read').allow;
      out.push({ ...this.view(r, names, sec.path), label: sec.label, currentVersion: num(sec.current_version), updatedAt: num(sec.updated_at), readable });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Removes every share past its expiry (they already stopped applying) and audits each end. */
  async expire(): Promise<number> {
    const now = Date.now();
    const due = (await this.db('vault_policies').whereNotNull('share_secret_id').andWhere('expires_at', '<=', now).limit(1000)) as ShareRow[];
    let n = 0;
    for (const r of due) {
      const gone = await this.db('vault_policies').where({ id: r.id }).delete();
      if (!gone) continue;
      n++;
      const secret = (await this.db('vault_secrets').where({ id: r.share_secret_id }).first('path', 'label')) as { path: string; label: string } | undefined;
      await this.s().audit.append({ tenantId: r.tenant_id, action: 'vault.secret.share.expired', kind: 'system', actor: { service: 'vault.shares' }, target: { path: secret?.path ?? r.path.replace(/^kv\//, ''), share: r.id }, label: secret && isLabel(secret.label) ? secret.label : 'internal', detail: { subjectKind: r.subject_kind, subject: r.subject, expiresAt: num(r.expires_at) } });
    }
    return n;
  }
}

