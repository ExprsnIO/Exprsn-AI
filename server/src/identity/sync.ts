import type { Logger } from 'pino';
import { highest, type Label } from '../authz/labels.js';
import { rolesRequireMfa } from '../authz/permissions.js';
import type { AuditLog } from '../audit/chain.js';
import type { Db } from '../db/knex.js';
import type { Notifications } from '../platform/notifications.js';
import type { ProviderRepo, ProviderRow } from '../repos/providers.js';
import { resolveMappings, type UserRepo } from '../repos/users.js';
import type { ApiKeyService } from './apikeys.js';
import type { IdentityChain } from './chain.js';
import { parseProviderConfig, signsInByRedirect, type ProviderKind } from './providers/types.js';
import { CloudDirectoryClient } from './providers/cloud-directory.js';
import { DirectoryState, type DeltaLinks } from './directory-state.js';

/** 1.9.0 (B-183): an upstream OIDC store with a cloud directory (Graph, Google) has users to pull, like LDAP. */
export const hasDirectory = (p: { kind: ProviderKind; config: Record<string, unknown> }): boolean => p.kind === 'oidc' && !!p.config.directory;
import type { SessionService } from './sessions.js';

export interface SyncReport {
  provider: string;
  checked: number;
  updated: number;
  disabled: { username: string; reason: string; sessionsRevoked: number }[];
  errors: string[];
  aborted?: string;
  /**
   * 1.9.9-qa (QA-1): `delta` when only the accounts a Graph delta named were looked up, `full` otherwise; `fullBecause`
   * says why a store with delta links was pulled in full (the link expired, a group was deleted, …).
   */
  mode?: 'full' | 'delta';
  fullBecause?: string;
}

/**
 * Directory sync. For every user linked to an LDAP or SQL store: look them up without a password and
 *   - if the store no longer knows them, or none of their groups is mapped any more (and the store gives no default
 *     roles and they have no direct role), disable them and revoke their sessions and API keys;
 *   - otherwise refresh their groups, mapped roles, workspaces and clearance.
 * A store that cannot be reached disables nobody. If more than half of a store's users (and more than five) would be
 * disabled in one run, the run stops without changing anyone: that is far more likely a broken filter than a purge.
 */
export class DirectorySync {
  constructor(
    private readonly db: Db,
    private readonly providers: ProviderRepo,
    private readonly users: UserRepo,
    private readonly chain: IdentityChain,
    private readonly sessions: SessionService,
    private readonly apiKeys: ApiKeyService,
    private readonly audit: AuditLog,
    private readonly notifications: Notifications,
    private readonly log: Logger
  ) {
    this.state = new DirectoryState(db);
  }

  /** 1.9.9-qa (QA-1): Graph delta links per store (migration 143); absent, every run is a full pull. */
  readonly state: DirectoryState;

  async syncTenant(tenantId: string, progress?: (pct: number, m?: string) => Promise<void>): Promise<SyncReport[]> {
    // Local accounts have no directory; upstream (OIDC, SAML) providers are only asked at sign-in.
    // 1.6.0 (B-7201): a SCIM store is pushed to, never read from.
    const stores = (await this.providers.list(tenantId)).filter((p) => p.enabled && p.state !== 'archived' && p.kind !== 'local' && p.kind !== 'scim' && (!signsInByRedirect(p.kind) || hasDirectory(p)));
    const reports: SyncReport[] = [];
    for (const [i, p] of stores.entries()) {
      reports.push(await this.syncProvider(p));
      await progress?.(((i + 1) / stores.length) * 100, `${p.name} synced`);
    }
    return reports;
  }

  async syncProvider(row: ProviderRow): Promise<SyncReport> {
    const report: SyncReport = { provider: row.name, checked: 0, updated: 0, disabled: [], errors: [] };
    const tenantId = row.tenant_id;
    // 1.9.0 (B-185): an archived store is kept read-only; nobody is changed from it until it is restored.
    if (row.state === 'archived') return { ...report, aborted: 'This store is archived; restore it to sync.' };
    if (row.kind === 'local' || (signsInByRedirect(row.kind) && !hasDirectory(row))) return { ...report, aborted: 'This store has no directory to sync with.' };
    if (row.kind === 'scim') return { ...report, aborted: 'A SCIM store is kept current by its identity provider; there is nothing to pull.' };
    const links = (await this.db('user_identities as i')
      .join('users as u', 'u.id', 'i.user_id')
      .where({ 'i.provider_id': row.id, 'u.tenant_id': tenantId, 'u.state': 'active' })
      .select('u.id as user_id', 'u.username', 'i.external_id')) as { user_id: string; username: string; external_id: string }[];
    if (!links.length) return report;

    let provider;
    try {
      provider = this.chain.build(row);
    } catch (err) {
      report.errors.push((err as Error).message);
      return report;
    }
    // 1.9.0 (B-183): a directory store built without its directory (no lookups here) must never read as "everyone left".
    if (hasDirectory(row) && !provider.lookupById) return { ...report, aborted: 'The directory of this store is not available in this process; nobody was changed.' };
    const cfg = parseProviderConfig(row.kind, row.config);
    const mappings = await this.users.mappings(tenantId);

    // 1.9.9-qa (QA-1): a Graph directory with saved delta links looks up only the accounts that changed. The links for
    // the next run are taken before a full pull, so nothing that changes during it is missed.
    const graph = hasDirectory(row) && 'client' in provider && provider.client instanceof CloudDirectoryClient && provider.client.api === 'msgraph' ? provider.client : null;
    let only: Set<string> | null = null;
    let nextLinks: DeltaLinks | null = null;
    if (graph && (await this.state.available())) {
      try {
        const saved = await this.state.links(row.id);
        if (saved) {
          const d = await graph.deltaChanges(saved);
          if (d.kind === 'changes') {
            only = d.ids;
            nextLinks = d.links;
          } else report.fullBecause = d.kind === 'expired' ? 'The delta link expired (410); pulled in full.' : `${d.why[0]!.toUpperCase()}${d.why.slice(1)}; pulled in full.`;
        }
        if (!only) nextLinks = await graph.deltaLatest();
      } catch (err) {
        // The delta could not be read: a full pull decides, and the next run starts its links again.
        only = null;
        nextLinks = null;
        report.fullBecause = `The delta could not be read (${(err as Error).message}); pulled in full.`;
      }
    }
    report.mode = only ? 'delta' : 'full';

    type Plan = { userId: string; username: string; action: 'disable'; reason: string } | { userId: string; username: string; action: 'update'; groups: string[]; externalId: string; manager: string | null | undefined };
    const plans: Plan[] = [];
    for (const link of links) {
      if (only && !only.has(link.external_id)) continue;
      report.checked++;
      try {
        // 1.9.0 (B-182, B-183): by the stable id where the store has one, so a renamed account stays linked.
        const ext = provider.lookupById ? await provider.lookupById(link.external_id) : await provider.lookup(link.username);
        if (!ext || ext.externalId !== link.external_id) {
          plans.push({ userId: link.user_id, username: link.username, action: 'disable', reason: 'Not found in the directory' });
          continue;
        }
        const mapped = resolveMappings(mappings, row.id, ext.groups);
        const direct = (await this.users.roles(link.user_id)).filter((r) => r.source === 'direct');
        if (!mapped.roles.length && !cfg.defaultRoles.length && !direct.length) {
          plans.push({ userId: link.user_id, username: link.username, action: 'disable', reason: 'No longer in any mapped group' });
          continue;
        }
        plans.push({ userId: link.user_id, username: link.username, action: 'update', groups: ext.groups, externalId: ext.externalId, manager: ext.manager });
      } catch (err) {
        // An unreachable store must never read as "everyone was removed".
        report.errors.push(`${link.username}: ${(err as Error).message}`);
        report.aborted = 'The store could not be read; nobody was changed.';
        return report;
      }
    }

    const toDisable = plans.filter((p) => p.action === 'disable');
    if (toDisable.length > 5 && toDisable.length > links.length / 2) {
      report.aborted = `${toDisable.length} of ${links.length} users would be disabled; stopped without changes. Check the store's filters.`;
      this.log.error({ provider: row.name, tenant: tenantId, wouldDisable: toDisable.length }, 'directory sync aborted by the safety limit');
      await this.audit.append({ tenantId, action: 'identity.sync.aborted', kind: 'system', actor: { service: 'directory-sync' }, target: { provider: row.id, name: row.name }, detail: { wouldDisable: toDisable.length, users: links.length } });
      return report;
    }

    for (const plan of plans) {
      if (plan.action === 'disable') {
        await this.users.update(tenantId, plan.userId, { state: 'disabled', disabled_reason: `Directory sync: ${plan.reason}` });
        const revoked = await this.sessions.revokeAllForUser(plan.userId);
        const keys = await this.apiKeys.revokeAllForUser(plan.userId);
        report.disabled.push({ username: plan.username, reason: plan.reason, sessionsRevoked: revoked });
        await this.audit.append({
          tenantId,
          action: 'user.disabled',
          kind: 'system',
          actor: { service: 'directory-sync' },
          target: { user: plan.userId, username: plan.username, provider: row.name },
          detail: { reason: plan.reason, revoked: { sessions: revoked, apiKeys: keys } }
        });
      } else {
        const user = await this.users.get(tenantId, plan.userId);
        if (!user) continue;
        const mapped = resolveMappings(mappings, row.id, plan.groups);
        const roles = mapped.roles.length ? mapped.roles : cfg.defaultRoles;
        const mappedClearance: Label = mapped.clearance ?? cfg.defaultClearance;
        const clearance = user.clearance_direct ? highest(mappedClearance, user.clearance_direct) : mappedClearance;
        const before = { roles: (await this.users.roles(user.id)).filter((r) => r.source === 'mapping').map((r) => r.role).sort(), clearance: user.clearance };
        await this.users.upsertIdentity(user.id, row.id, plan.externalId, plan.groups, plan.manager);
        await this.users.setRoles(user.id, 'mapping', roles);
        await this.users.setWorkspaceMemberships(user.id, 'mapping', mapped.workspaces);
        const allRoles = await this.users.roleIds(user.id);
        await this.users.update(tenantId, user.id, { clearance, mfa_required: user.mfa_required || rolesRequireMfa(allRoles) });
        if (before.clearance !== clearance || before.roles.join() !== [...roles].sort().join()) {
          report.updated++;
          // Access narrowed or widened: end sessions so the next request is evaluated with the new roles.
          const revoked = await this.sessions.revokeAllForUser(user.id);
          await this.audit.append({ tenantId, action: 'user.synced', kind: 'system', actor: { service: 'directory-sync' }, target: { user: user.id, username: user.username, provider: row.name }, detail: { before, after: { roles, clearance }, sessionsRevoked: revoked } });
        }
      }
    }

    if (report.disabled.length) {
      const admins = await this.notifications.usersWithRoles(tenantId, ['tenant-admin', 'identity-admin']);
      await this.notifications.notify({
        tenantId,
        userIds: admins,
        kind: 'directory.sync',
        title: `Directory sync disabled ${report.disabled.length} user${report.disabled.length === 1 ? '' : 's'}`,
        body: report.disabled.map((d) => `${d.username}: ${d.reason}`).join('; '),
        route: 'tenants'
      });
    }
    // The links are saved only after a run that changed what it found, so an aborted run reads the same changes again.
    if (graph) await this.state.save(tenantId, row.id, nextLinks, report.mode ?? 'full').catch((err: Error) => this.log.warn({ provider: row.id, err: err.message }, 'directory delta links not saved'));
    await this.audit.append({ tenantId, action: 'identity.sync.completed', kind: 'system', actor: { service: 'directory-sync' }, target: { provider: row.id, name: row.name }, detail: { checked: report.checked, updated: report.updated, disabled: report.disabled.length, ...(report.mode ? { mode: report.mode } : {}) } });
    return report;
  }
}
