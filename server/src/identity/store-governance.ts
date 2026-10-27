import { ulid } from 'ulid';
import { actorFrom } from '../audit/chain.js';
import { csvLine } from '../audit/exports.js';
import { clears, isLabel } from '../authz/labels.js';
import { authorize, type Principal } from '../authz/policy.js';
import { canonicalJson } from '../crypto/index.js';
import { json } from '../db/knex.js';
import { forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Scheduler } from '../platform/jobs.js';
import type { ProviderRow } from '../repos/providers.js';
import type { Services } from '../services.js';
import { storeKind } from './providers/kinds.js';
import { diffVersions, storeAdminFor, type ConfigChange, type StoreAdmin } from './store-admin.js';
import { backupsMissing, storeBackupsFor, type RestoreReport, type StoreBackups } from './store-backups.js';

/*
 * 1.9.9-qa, Sprint QA-1 (Sprint 54 leftovers: B-181, B-185, B-186): governance of user stores.
 *
 * - Dual control: a change of a store's connection or attribute configuration, restoring a saved backup, purging an
 *   archived store and turning dual control off are proposals that a second identity admin approves (with a recent
 *   sign-in, and `platform:manage` too for a platform store). The proposer cannot approve; they can withdraw. Name,
 *   sign-in order and enable/disable stay single-admin. The tenant's setting is `auto` (on when the tenant has two or
 *   more identity admins, else off with a warning on the screen), `on` or `off`. This follows the pattern of
 *   `federation/proposals.ts`, in a table of its own so the federation routes never decide a store change.
 * - Purge: an archived store may be removed once `purge_after_days` (default 30) have passed since it was archived;
 *   before then removal is refused (409) with the date. Its identity links, group mappings, versions and backup
 *   schedule go; the accounts stay (they lose that store's identity); saved backups are kept.
 * - Scheduled backups: per store daily or weekly, run by the Scheduler as the job `identity.store.backups.due`, saved
 *   to the blob store with origin `schedule`, pruned to a count and an age (never the newest); a failure notifies the
 *   tenant's identity admins.
 * - CSV export of a store's users (accounts linked to it, no secrets), only those within the requester's clearance;
 *   inline up to EXPORT_INLINE_MAX rows, else the job `identity.store.users.export` writes it sealed to the blob store.
 *
 * Needs migration 142_identity_store_governance. Until it is applied every feature here reports itself unavailable
 * (503 `migration_pending`) and stores are changed, restored and removed exactly as before.
 */

const SCHEMA_RECHECK_MS = 30_000;
const DAY = 24 * 60 * 60_000;
export const PURGE_DEFAULT_DAYS = 30;
export const EXPORT_INLINE_MAX = 1000;
export const STORE_BACKUP_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
const PERIOD = { daily: DAY, weekly: 7 * DAY } as const;

export const DUAL_CONTROL_MODES = ['auto', 'on', 'off'] as const;
export type DualControlMode = (typeof DUAL_CONTROL_MODES)[number];
export const STORE_PROPOSAL_KINDS = ['store.config', 'store.restore', 'store.purge', 'settings'] as const;
export type StoreProposalKind = (typeof STORE_PROPOSAL_KINDS)[number];
export type BackupFrequency = keyof typeof PERIOD;

export const governanceMissing = () => new HttpProblem(503, 'Not installed', 'Dual control, purge rules, scheduled backups and user exports of stores need the database migration 142_identity_store_governance, which has not been applied.', { extensions: { reason: 'migration_pending' } });

export interface GovActor {
  principal: Principal;
  ip: string | null;
  traceId?: string;
}

export interface StoreSettings {
  dualControl: DualControlMode;
  purgeAfterDays: number;
  updatedBy: string | null;
  updatedAt: number | null;
}

export interface DualControlState {
  available: boolean;
  mode: DualControlMode;
  on: boolean;
  identityAdmins: number;
  warning: string | null;
}

export interface StoreProposal {
  id: string;
  tenantId: string;
  kind: StoreProposalKind;
  providerId: string | null;
  name: string;
  payload: Record<string, unknown>;
  summary: string | null;
  state: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'superseded';
  proposedBy: string;
  proposedAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  note: string | null;
}

export interface BackupSchedule {
  providerId: string;
  frequency: BackupFrequency;
  keepCount: number | null;
  keepDays: number | null;
  enabled: boolean;
  nextRunAt: number;
  lastRunAt: number | null;
  lastStatus: 'ok' | 'failed' | null;
  lastError: string | null;
  lastBackupId: string | null;
  failures: number;
  updatedAt: number;
}

const proposalFrom = (r: Record<string, unknown>): StoreProposal => ({
  id: String(r.id),
  tenantId: String(r.tenant_id),
  kind: r.kind as StoreProposalKind,
  providerId: (r.provider_id as string | null) ?? null,
  name: String(r.name),
  payload: json<Record<string, unknown>>(r.payload, {}),
  summary: (r.summary as string | null) ?? null,
  state: r.state as StoreProposal['state'],
  proposedBy: String(r.proposed_by),
  proposedAt: Number(r.proposed_at),
  decidedBy: (r.decided_by as string | null) ?? null,
  decidedAt: r.decided_at == null ? null : Number(r.decided_at),
  note: (r.note as string | null) ?? null
});

const scheduleFrom = (r: Record<string, unknown>): BackupSchedule => ({
  providerId: String(r.provider_id),
  frequency: r.frequency === 'weekly' ? 'weekly' : 'daily',
  keepCount: r.keep_count == null ? null : Number(r.keep_count),
  keepDays: r.keep_days == null ? null : Number(r.keep_days),
  enabled: !!r.enabled,
  nextRunAt: Number(r.next_run_at),
  lastRunAt: r.last_run_at == null ? null : Number(r.last_run_at),
  lastStatus: (r.last_status as 'ok' | 'failed' | null) ?? null,
  lastError: (r.last_error as string | null) ?? null,
  lastBackupId: (r.last_backup_id as string | null) ?? null,
  failures: Number(r.failures ?? 0),
  updatedAt: Number(r.updated_at)
});

const conflictWith = (detail: string, extensions: Record<string, unknown>) => new HttpProblem(409, 'Conflict', detail, { extensions });
const iso = (t: number | null) => (t == null ? '' : new Date(t).toISOString());

/** `platform:manage` too, for a kind the registry marks as a platform store (as `assertKindAllowed` on the routes). */
export function assertPlatformKind(p: Principal, kind: string): void {
  if (storeKind(kind)?.platform && !authorize(p, 'platform:manage').allow) throw forbidden('Stores of this kind are platform stores; changing one also needs platform:manage.', { step: 'role', action: 'platform:manage' });
}

export class StoreGovernance {
  private schema: { ok: boolean; at: number } | null = null;

  constructor(
    private readonly s: Services,
    private readonly admin: StoreAdmin,
    private readonly backups: StoreBackups
  ) {}

  /** Whether migration 142 is applied (cached; rechecked every 30 seconds while it is not). */
  async installed(): Promise<boolean> {
    const t = Date.now();
    if (this.schema && (this.schema.ok || t - this.schema.at < SCHEMA_RECHECK_MS)) return this.schema.ok;
    let ok: boolean;
    try {
      const db = this.s.db;
      ok = (await db.schema.hasTable('identity_store_settings')) && (await db.schema.hasTable('identity_store_proposals')) && (await db.schema.hasTable('identity_store_backup_schedules'));
    } catch {
      ok = false;
    }
    this.schema = { ok, at: t };
    return ok;
  }

  resetSchemaCache(): void {
    this.schema = null;
  }

  async need(): Promise<void> {
    if (!(await this.installed())) throw governanceMissing();
  }

  private audit(a: GovActor | null, action: string, target: Record<string, unknown>, detail: Record<string, unknown>, tenantId?: string) {
    const tid = a?.principal.tenantId ?? tenantId!;
    return this.s.audit.append({ tenantId: tid, action, kind: a ? 'admin' : 'system', actor: a ? actorFrom(a.principal, a.ip) : { service: 'identity' }, target, detail, ...(a?.traceId ? { traceId: a.traceId } : {}) });
  }

  private notify(tenantId: string, userIds: string[], title: string, body: string, kind = 'identity.store.proposal'): Promise<void> {
    if (!userIds.length) return Promise.resolve();
    return this.s.notifications
      .notify({ tenantId, userIds, kind, title, body: body.slice(0, 300), route: 'directories', label: 'internal' })
      .then(() => undefined)
      .catch((err: unknown) => this.s.log.warn({ err }, 'store governance notice failed'));
  }

  // ---------- settings ----------

  async settings(tenantId: string): Promise<StoreSettings> {
    const fallback: StoreSettings = { dualControl: 'auto', purgeAfterDays: PURGE_DEFAULT_DAYS, updatedBy: null, updatedAt: null };
    if (!(await this.installed())) return fallback;
    const r = (await this.s.db('identity_store_settings').where({ tenant_id: tenantId }).first()) as Record<string, unknown> | undefined;
    if (!r) return fallback;
    const mode = (DUAL_CONTROL_MODES as readonly string[]).includes(String(r.dual_control)) ? (r.dual_control as DualControlMode) : 'auto';
    return { dualControl: mode, purgeAfterDays: Number(r.purge_after_days ?? PURGE_DEFAULT_DAYS), updatedBy: (r.updated_by as string | null) ?? null, updatedAt: r.updated_at == null ? null : Number(r.updated_at) };
  }

  /** The tenant's active users whose roles include identity:manage. */
  identityAdmins(tenantId: string): Promise<string[]> {
    return this.s.federation.proposals.identityAdmins(tenantId);
  }

  private effective(mode: DualControlMode, admins: number): boolean {
    return mode === 'on' || (mode === 'auto' && admins >= 2);
  }

  /** Whether store changes need a second admin now. Without migration 142: never (as before). */
  async dualControl(tenantId: string): Promise<DualControlState> {
    if (!(await this.installed())) return { available: false, mode: 'auto', on: false, identityAdmins: 0, warning: null };
    const { dualControl: mode } = await this.settings(tenantId);
    const admins = (await this.identityAdmins(tenantId)).length;
    const on = this.effective(mode, admins);
    let warning: string | null = null;
    if (!on && mode === 'off') warning = 'Dual control is turned off: one identity admin alone can change a store\'s connection or attributes, restore a backup and purge an archived store.';
    else if (!on) warning = 'Dual control is off because this tenant has only one identity admin: that admin alone can change a store\'s connection or attributes, restore a backup and purge an archived store. It turns on by itself when a second identity admin exists.';
    else if (admins < 2) warning = 'Dual control is on but this tenant has only one identity admin: proposals wait until a second identity admin can approve them.';
    return { available: true, mode, on, identityAdmins: admins, warning };
  }

  /**
   * Changes the settings. The retention applies at once; turning dual control off while it is in force is itself a
   * proposal for a second admin (so one admin cannot switch it off and then act alone).
   */
  async setSettings(a: GovActor, input: { dualControl?: DualControlMode; purgeAfterDays?: number; reason?: string }): Promise<{ settings: StoreSettings; proposal: StoreProposal | null }> {
    await this.need();
    const tenantId = a.principal.tenantId;
    const before = await this.settings(tenantId);
    const state = await this.dualControl(tenantId);
    let proposal: StoreProposal | null = null;
    let mode = before.dualControl;
    if (input.dualControl && input.dualControl !== before.dualControl) {
      const after = this.effective(input.dualControl, state.identityAdmins);
      if (state.on && !after) proposal = await this.propose(a, { kind: 'settings', providerId: null, name: 'Store governance settings', payload: { dualControl: input.dualControl }, summary: `Turn dual control for user stores ${input.dualControl === 'off' ? 'off' : 'to automatic (off with one identity admin)'}.${input.reason ? ` Reason: ${input.reason}` : ''}` });
      else mode = input.dualControl;
    }
    const purgeAfterDays = input.purgeAfterDays ?? before.purgeAfterDays;
    await this.write(tenantId, { dual_control: mode, purge_after_days: purgeAfterDays }, a.principal.userId ?? null);
    const settings = await this.settings(tenantId);
    if (mode !== before.dualControl || purgeAfterDays !== before.purgeAfterDays) await this.audit(a, 'identity.store.settings.updated', { settings: 'identity-stores' }, { before: { dualControl: before.dualControl, purgeAfterDays: before.purgeAfterDays }, after: { dualControl: settings.dualControl, purgeAfterDays: settings.purgeAfterDays }, ...(input.reason ? { reason: input.reason } : {}) });
    return { settings, proposal };
  }

  private async write(tenantId: string, patch: { dual_control?: DualControlMode; purge_after_days?: number }, by: string | null): Promise<void> {
    const db = this.s.db;
    const t = Date.now();
    const n = await db('identity_store_settings').where({ tenant_id: tenantId }).update({ ...patch, updated_by: by, updated_at: t });
    if (!n) {
      try {
        await db('identity_store_settings').insert({ tenant_id: tenantId, dual_control: patch.dual_control ?? 'auto', purge_after_days: patch.purge_after_days ?? PURGE_DEFAULT_DAYS, updated_by: by, updated_at: t });
      } catch {
        await db('identity_store_settings').where({ tenant_id: tenantId }).update({ ...patch, updated_by: by, updated_at: t });
      }
    }
  }

  // ---------- proposals ----------

  async list(tenantId: string, opts: { state?: string; providerId?: string; limit?: number } = {}): Promise<StoreProposal[]> {
    if (!(await this.installed())) return [];
    const q = this.s.db('identity_store_proposals').where({ tenant_id: tenantId }).orderBy('proposed_at', 'desc').limit(opts.limit ?? 100);
    if (opts.state) q.andWhere({ state: opts.state });
    if (opts.providerId) q.andWhere({ provider_id: opts.providerId });
    return ((await q) as Record<string, unknown>[]).map(proposalFrom);
  }

  async get(tenantId: string, id: string): Promise<StoreProposal> {
    await this.need();
    const r = await this.s.db('identity_store_proposals').where({ tenant_id: tenantId, id }).first();
    if (!r) throw notFound('Proposal');
    return proposalFrom(r);
  }

  /** What the console shows: the proposal, whether it is the caller's own, and for a configuration change its diff. */
  view(p: StoreProposal, viewer: string | null): StoreProposal & { mine: boolean; changes: ConfigChange[] | null } {
    let changes: ConfigChange[] | null = null;
    if (p.kind === 'store.config') {
      const before = (p.payload.before ?? {}) as Record<string, unknown>;
      const after = (p.payload.config ?? {}) as Record<string, unknown>;
      changes = diffVersions({ name: p.name, position: 0, enabled: true, config: before }, { name: p.name, position: 0, enabled: true, config: after });
    }
    return { ...p, mine: p.proposedBy === viewer, changes };
  }

  /** Records a proposal and tells the other identity admins. One pending proposal of a kind per store. */
  async propose(a: GovActor, input: { kind: StoreProposalKind; providerId: string | null; name: string; payload: Record<string, unknown>; summary: string }): Promise<StoreProposal> {
    await this.need();
    const tenantId = a.principal.tenantId;
    const by = a.principal.userId;
    if (!by) throw forbidden('Only a person can propose a store change.', { step: 'credential' });
    const db = this.s.db;
    const q = db('identity_store_proposals').where({ tenant_id: tenantId, kind: input.kind, state: 'pending' });
    if (input.providerId) q.andWhere({ provider_id: input.providerId });
    else q.whereNull('provider_id');
    if (await q.first('id')) throw new HttpProblem(409, 'Conflict', 'A change of this kind is already waiting for approval; approve, reject or withdraw it first.', { extensions: { reason: 'proposal_pending' } });
    const row = { id: ulid(), tenant_id: tenantId, kind: input.kind, provider_id: input.providerId, name: input.name.slice(0, 200), payload: JSON.stringify(input.payload), summary: input.summary.slice(0, 1000), state: 'pending', proposed_by: by, proposed_at: Date.now(), decided_by: null, decided_at: null, note: null };
    await db('identity_store_proposals').insert(row);
    await this.audit(a, 'identity.store.proposal.created', { proposal: row.id, kind: input.kind, provider: input.providerId, name: input.name }, { summary: row.summary });
    await this.notify(tenantId, (await this.identityAdmins(tenantId)).filter((id) => id !== by), `${input.name}: a change waits for a second identity admin`, input.summary);
    return proposalFrom(row);
  }

  private async pending(tenantId: string, id: string): Promise<StoreProposal> {
    const p = await this.get(tenantId, id);
    if (p.state !== 'pending') throw new HttpProblem(409, 'Conflict', `The proposal is ${p.state}.`);
    return p;
  }

  private decide(id: string, state: StoreProposal['state'], by: string | null, note: string | null) {
    return this.s.db('identity_store_proposals').where({ id, state: 'pending' }).update({ state, decided_by: by, decided_at: Date.now(), note });
  }

  /**
   * Approves and applies a proposal as `a`, who must not be its proposer (the route has checked identity:manage and a
   * recent sign-in). A proposal whose store changed since is superseded, not applied.
   */
  async approve(a: GovActor, id: string, note: string | null): Promise<{ proposal: StoreProposal; result: unknown }> {
    await this.need();
    const tenantId = a.principal.tenantId;
    const p = await this.pending(tenantId, id);
    if (p.proposedBy === a.principal.userId) throw forbidden('Dual control: you cannot approve your own proposal. Another identity admin must approve it.', { step: 'dual-control' });
    const row = p.providerId ? ((await this.s.providers.get(tenantId, p.providerId)) ?? null) : null;
    if (p.providerId && !row) {
      await this.decide(p.id, 'superseded', a.principal.userId ?? null, 'The store no longer exists.');
      throw new HttpProblem(409, 'Conflict', 'The store no longer exists; the proposal was closed.');
    }
    if (row) assertPlatformKind(a.principal, row.kind);
    if (p.kind === 'store.config' && row && canonicalJson(row.config) !== canonicalJson(p.payload.before ?? {})) {
      await this.decide(p.id, 'superseded', a.principal.userId ?? null, 'The store changed since it was proposed.');
      await this.audit(a, 'identity.store.proposal.superseded', { proposal: p.id, kind: p.kind, provider: p.providerId, name: p.name }, { reason: 'store changed' });
      throw new HttpProblem(409, 'Conflict', 'The store\'s configuration changed since this was proposed; the proposal was closed. Propose the change again.', { extensions: { reason: 'stale' } });
    }
    // Claim first, so two approvers racing apply it once.
    if (!(await this.decide(p.id, 'approved', a.principal.userId ?? null, note))) throw new HttpProblem(409, 'Conflict', 'The proposal was decided by someone else.');
    let result: unknown;
    try {
      result = await this.apply(a, p, row);
    } catch (err) {
      await this.s.db('identity_store_proposals').where({ id: p.id }).update({ state: 'pending', decided_by: null, decided_at: null, note: null });
      throw err;
    }
    await this.audit(a, 'identity.store.proposal.approved', { proposal: p.id, kind: p.kind, provider: p.providerId, name: p.name }, { proposedBy: p.proposedBy, summary: p.summary, note });
    await this.notify(tenantId, [p.proposedBy], `${p.name}: your change was approved`, p.summary ?? '');
    return { proposal: await this.get(tenantId, p.id), result };
  }

  private async apply(a: GovActor, p: StoreProposal, row: ProviderRow | null): Promise<unknown> {
    const s = this.s;
    const tenantId = a.principal.tenantId;
    if (p.kind === 'store.config') {
      if (!row) throw notFound('User store');
      if (row.state === 'archived') throw new HttpProblem(409, 'Conflict', 'This store is archived; restore it first.');
      const vaultOwner = (p.payload.vaultOwner as string | null | undefined) ?? null;
      const updated = (await s.providers.update(tenantId, row.id, { config: p.payload.config as Record<string, unknown>, vaultOwner }))!;
      const reason = (p.payload.reason as string | undefined) ?? null;
      const version = await this.admin.recordVersion(updated, `${reason ? reason + '; ' : ''}approved by ${a.principal.username}`.slice(0, 500), p.proposedBy);
      await this.audit(a, 'identity.provider.updated', { provider: row.id, name: row.name }, { before: { config: row.config }, after: { config: updated.config }, version, proposal: p.id, proposedBy: p.proposedBy, ...(reason ? { reason } : {}) });
      return { store: updated.id, version };
    }
    if (p.kind === 'store.restore') {
      const archive = await this.backups.read(tenantId, String(p.payload.backupId));
      assertPlatformKind(a.principal, archive.source.store.kind);
      const mode = p.payload.mode === 'new' ? 'new' : 'same';
      const report: RestoreReport = await this.backups.restore(a.principal, archive, { mode, ...(typeof p.payload.name === 'string' ? { name: p.payload.name } : {}), dryRun: false, ctx: { ip: a.ip, traceId: a.traceId ?? null } });
      await this.audit(a, 'identity.store.backup.restored', { backup: archive.id, provider: report.target.id, name: report.target.name }, { mode, created: report.target.created, sourceTenant: archive.source.tenant.id, summary: report.summary, proposal: p.id, proposedBy: p.proposedBy });
      return report;
    }
    if (p.kind === 'store.purge') {
      if (!row) throw notFound('User store');
      return this.purge(a, row, p.id);
    }
    // settings
    const mode = p.payload.dualControl as DualControlMode;
    const before = await this.settings(tenantId);
    await this.write(tenantId, { dual_control: mode }, a.principal.userId ?? null);
    await this.audit(a, 'identity.store.settings.updated', { settings: 'identity-stores' }, { before: { dualControl: before.dualControl }, after: { dualControl: mode }, proposal: p.id, proposedBy: p.proposedBy });
    return { settings: await this.settings(tenantId) };
  }

  async reject(a: GovActor, id: string, note: string | null): Promise<StoreProposal> {
    await this.need();
    const p = await this.pending(a.principal.tenantId, id);
    if (p.proposedBy === a.principal.userId) throw new HttpProblem(409, 'Conflict', 'This is your own proposal: withdraw it instead.');
    if (!(await this.decide(p.id, 'rejected', a.principal.userId ?? null, note))) throw new HttpProblem(409, 'Conflict', 'The proposal was decided by someone else.');
    await this.audit(a, 'identity.store.proposal.rejected', { proposal: p.id, kind: p.kind, provider: p.providerId, name: p.name }, { proposedBy: p.proposedBy, note });
    await this.notify(a.principal.tenantId, [p.proposedBy], `${p.name}: your change was rejected`, note ?? p.summary ?? '');
    return this.get(a.principal.tenantId, p.id);
  }

  async withdraw(a: GovActor, id: string): Promise<StoreProposal> {
    await this.need();
    const p = await this.pending(a.principal.tenantId, id);
    if (p.proposedBy !== a.principal.userId) throw forbidden('Only the admin who proposed a change can withdraw it; reject it instead.', { step: 'dual-control' });
    if (!(await this.decide(p.id, 'withdrawn', a.principal.userId ?? null, null))) throw new HttpProblem(409, 'Conflict', 'The proposal was decided by someone else.');
    await this.audit(a, 'identity.store.proposal.withdrawn', { proposal: p.id, kind: p.kind, provider: p.providerId, name: p.name }, {});
    return this.get(a.principal.tenantId, p.id);
  }

  // ---------- purge ----------

  /** When an archived store may be purged (null when it is not archived). */
  purgeableAt(row: ProviderRow, days: number): number | null {
    if (row.state !== 'archived' || row.archived_at == null) return null;
    return Number(row.archived_at) + days * DAY;
  }

  /** Refuses (409) removing a store that is not archived, or archived less than the retention period ago. */
  async assertPurgeable(row: ProviderRow, now = Date.now()): Promise<void> {
    const { purgeAfterDays } = await this.settings(row.tenant_id);
    if (row.state !== 'archived') throw conflictWith(`Archive this store first; it can be removed ${purgeAfterDays} day${purgeAfterDays === 1 ? '' : 's'} after it was archived.`, { reason: 'not_archived', purgeAfterDays });
    const at = this.purgeableAt(row, purgeAfterDays)!;
    if (now < at) throw conflictWith(`This store was archived on ${iso(row.archived_at)} and can be removed from ${iso(at)} (${purgeAfterDays} days after archiving).`, { reason: 'retention', purgeableAt: at, purgeAfterDays });
  }

  /**
   * Removes an archived store past its retention: its identity links (the accounts stay and lose this store's
   * identity), group mappings, versions, backup schedule and pending proposals; saved backups are kept.
   */
  async purge(a: GovActor, row: ProviderRow, proposalId: string | null = null): Promise<{ links: number; mappings: number; versions: number }> {
    await this.assertPurgeable(row);
    const s = this.s;
    const versioned = await this.admin.installed();
    let out = { links: 0, mappings: 0, versions: 0 };
    await s.db.transaction(async (trx) => {
      const links = await trx('user_identities').where({ provider_id: row.id }).delete();
      const mappings = await trx('group_mappings').where({ tenant_id: row.tenant_id, provider_id: row.id }).delete();
      const versions = versioned ? await trx('identity_provider_versions').where({ tenant_id: row.tenant_id, provider_id: row.id }).delete() : 0;
      await trx('identity_store_backup_schedules').where({ tenant_id: row.tenant_id, provider_id: row.id }).delete();
      const pending = trx('identity_store_proposals').where({ tenant_id: row.tenant_id, provider_id: row.id, state: 'pending' });
      if (proposalId) pending.whereNot({ id: proposalId });
      await pending.update({ state: 'superseded', decided_at: Date.now(), note: 'The store was purged.' });
      await trx('identity_providers').where({ tenant_id: row.tenant_id, id: row.id }).delete();
      out = { links: Number(links), mappings: Number(mappings), versions: Number(versions) };
    });
    if (row.kind === 'scim') await s.scim.forget(row.tenant_id, row.id);
    await this.audit(a, 'identity.store.purged', { provider: row.id, name: row.name, kind: row.kind }, { archivedAt: row.archived_at, ...out, ...(proposalId ? { proposal: proposalId } : {}) });
    return out;
  }

  // ---------- scheduled backups ----------

  async scheduleOf(tenantId: string, providerId: string): Promise<BackupSchedule | null> {
    if (!(await this.installed())) return null;
    const r = await this.s.db('identity_store_backup_schedules').where({ tenant_id: tenantId, provider_id: providerId }).first();
    return r ? scheduleFrom(r) : null;
  }

  async schedules(tenantId: string): Promise<BackupSchedule[]> {
    if (!(await this.installed())) return [];
    return ((await this.s.db('identity_store_backup_schedules').where({ tenant_id: tenantId }).orderBy('next_run_at')) as Record<string, unknown>[]).map(scheduleFrom);
  }

  async setSchedule(a: GovActor, row: ProviderRow, input: { frequency: BackupFrequency; keepCount: number | null; keepDays: number | null; enabled: boolean }): Promise<BackupSchedule> {
    await this.need();
    if (!(await this.backups.installed())) throw backupsMissing();
    const db = this.s.db;
    const t = Date.now();
    const before = await this.scheduleOf(row.tenant_id, row.id);
    const keepCount = input.keepCount ?? (input.keepDays == null ? 7 : null);
    // A new schedule runs at the next tick; a changed frequency counts from the last run.
    const nextRunAt = !before ? t : before.frequency !== input.frequency ? (before.lastRunAt ?? t) + PERIOD[input.frequency] : before.nextRunAt;
    const values = { tenant_id: row.tenant_id, frequency: input.frequency, keep_count: keepCount, keep_days: input.keepDays, enabled: input.enabled, next_run_at: nextRunAt, updated_by: a.principal.userId ?? null, updated_at: t };
    if (before) await db('identity_store_backup_schedules').where({ tenant_id: row.tenant_id, provider_id: row.id }).update(values);
    else await db('identity_store_backup_schedules').insert({ provider_id: row.id, ...values, failures: 0 });
    const after = (await this.scheduleOf(row.tenant_id, row.id))!;
    await this.audit(a, 'identity.store.backup.schedule.updated', { provider: row.id, name: row.name }, { before: before ? { frequency: before.frequency, keepCount: before.keepCount, keepDays: before.keepDays, enabled: before.enabled } : null, after: { frequency: after.frequency, keepCount: after.keepCount, keepDays: after.keepDays, enabled: after.enabled } });
    return after;
  }

  async removeSchedule(a: GovActor, row: ProviderRow): Promise<boolean> {
    await this.need();
    const n = await this.s.db('identity_store_backup_schedules').where({ tenant_id: row.tenant_id, provider_id: row.id }).delete();
    if (n) await this.audit(a, 'identity.store.backup.schedule.removed', { provider: row.id, name: row.name }, {});
    return n > 0;
  }

  /** Runs every due schedule of a tenant (claimed once across instances). Returns what each run did. */
  async runDue(tenantId: string, now = Date.now()): Promise<{ providerId: string; ok: boolean; backupId?: string; pruned?: number; error?: string }[]> {
    if (!(await this.installed()) || !(await this.backups.installed())) return [];
    const db = this.s.db;
    const due = ((await db('identity_store_backup_schedules').where({ tenant_id: tenantId, enabled: true }).andWhere('next_run_at', '<=', now)) as Record<string, unknown>[]).map(scheduleFrom);
    const out: { providerId: string; ok: boolean; backupId?: string; pruned?: number; error?: string }[] = [];
    for (const sch of due) {
      const claimed = await db('identity_store_backup_schedules').where({ provider_id: sch.providerId, next_run_at: sch.nextRunAt }).update({ next_run_at: Math.max(now, sch.nextRunAt) + PERIOD[sch.frequency] });
      if (!claimed) continue;
      out.push(await this.runOne(tenantId, sch, now));
    }
    return out;
  }

  /** One scheduled backup of a store now: saved, then the schedule's retention pruned; a failure tells the admins. */
  async runOne(tenantId: string, sch: BackupSchedule, now = Date.now()): Promise<{ providerId: string; ok: boolean; backupId?: string; pruned?: number; error?: string }> {
    const db = this.s.db;
    const row = await this.s.providers.get(tenantId, sch.providerId);
    if (!row) {
      await db('identity_store_backup_schedules').where({ tenant_id: tenantId, provider_id: sch.providerId }).delete();
      return { providerId: sch.providerId, ok: false, error: 'store removed' };
    }
    try {
      const saved = await this.backups.save(row, null, 'schedule');
      const pruned = await this.prune(tenantId, row, sch, now);
      await db('identity_store_backup_schedules').where({ tenant_id: tenantId, provider_id: row.id }).update({ last_run_at: now, last_status: 'ok', last_error: null, last_backup_id: saved.id, failures: 0 });
      await this.audit(null, 'identity.store.backup.created', { provider: row.id, name: row.name, backup: saved.id }, { where: 'blob', origin: 'schedule', bytes: saved.bytes, sha256: saved.sha256, counts: saved.counts, pruned }, tenantId);
      return { providerId: row.id, ok: true, backupId: saved.id, pruned };
    } catch (err) {
      const message = ((err as Error).message || 'failed').slice(0, 500);
      await db('identity_store_backup_schedules').where({ tenant_id: tenantId, provider_id: row.id }).update({ last_run_at: now, last_status: 'failed', last_error: message, failures: sch.failures + 1 });
      await this.audit(null, 'identity.store.backup.failed', { provider: row.id, name: row.name }, { origin: 'schedule', error: message, failures: sch.failures + 1 }, tenantId);
      await this.notify(tenantId, await this.identityAdmins(tenantId), `${row.name}: the scheduled backup failed`, message, 'identity.store.backup.failed');
      return { providerId: row.id, ok: false, error: message };
    }
  }

  /** Deletes the store's scheduled backups beyond the count or older than the age kept; never the newest. */
  async prune(tenantId: string, row: ProviderRow, sch: Pick<BackupSchedule, 'keepCount' | 'keepDays'>, now = Date.now()): Promise<number> {
    if (!(await this.backups.hasOrigin())) return 0;
    const list = (await this.backups.list(tenantId, row.id)).filter((b) => b.origin === 'schedule');
    const gone = list.filter((b, i) => i > 0 && ((sch.keepCount != null && i >= sch.keepCount) || (sch.keepDays != null && b.createdAt < now - sch.keepDays * DAY)));
    for (const b of gone) await this.backups.remove(tenantId, b.id);
    if (gone.length) await this.audit(null, 'identity.store.backup.pruned', { provider: row.id, name: row.name }, { backups: gone.map((b) => b.id), keepCount: sch.keepCount, keepDays: sch.keepDays }, tenantId);
    return gone.length;
  }

  // ---------- CSV export of a store's users ----------

  /** The accounts linked to a store, within `clearance`, as CSV (no secrets: no hashes, factors or keys). */
  async exportCsv(tenantId: string, providerId: string, clearance: string): Promise<{ csv: string; rows: number; omitted: number }> {
    const rows = (await this.s.db('user_identities as i')
      .join('users as u', 'u.id', 'i.user_id')
      .where({ 'i.provider_id': providerId, 'u.tenant_id': tenantId })
      .orderBy('u.username')
      .select('u.username', 'u.display_name', 'u.email', 'u.state', 'u.clearance', 'u.last_login_at', 'i.groups')) as Record<string, unknown>[];
    const cap = isLabel(clearance) ? clearance : 'public';
    let csv = csvLine(['username', 'display_name', 'email', 'state', 'groups', 'last_sign_in']);
    let n = 0;
    let omitted = 0;
    for (const r of rows) {
      if (!clears(cap, isLabel(r.clearance) ? r.clearance : 'restricted')) {
        omitted++;
        continue;
      }
      csv += csvLine([r.username, r.display_name, r.email ?? '', r.state, json<string[]>(r.groups, []).join('; '), iso(r.last_login_at == null ? null : Number(r.last_login_at))]);
      n++;
    }
    return { csv, rows: n, omitted };
  }

  async linkCount(tenantId: string, providerId: string): Promise<number> {
    const r = (await this.s.db('user_identities as i').join('users as u', 'u.id', 'i.user_id').where({ 'i.provider_id': providerId, 'u.tenant_id': tenantId }).count({ n: '*' }).first()) as { n: number | string } | undefined;
    return Number(r?.n ?? 0);
  }

  static exportKey(tenantId: string, jobId: string): string {
    return `identity/store-exports/${tenantId}/${jobId}.csv.sealed`;
  }

  /** A finished export job's CSV, for the admin who asked for it only. */
  async exportFile(tenantId: string, jobId: string, userId: string | null): Promise<{ csv: string; name: string; rows: number; omitted: number; providerId: string }> {
    const job = await this.s.jobs.get(tenantId, jobId);
    if (!job || job.type !== 'identity.store.users.export' || job.created_by !== userId) throw notFound('Export');
    if (job.state !== 'succeeded') throw new HttpProblem(409, 'Conflict', `The export is ${job.state}.`, { extensions: { state: job.state } });
    const result = (job.result ?? {}) as { blobKey?: string; name?: string; rows?: number; omitted?: number; providerId?: string };
    const sealed = result.blobKey ? await this.s.blobs.get(result.blobKey) : null;
    if (!sealed) throw new HttpProblem(410, 'Gone', 'The export file is no longer in the blob store.');
    const csv = (await this.s.keys.openBytes(tenantId, sealed.toString('utf8'), `store-export:${jobId}`)).toString('utf8');
    return { csv, name: result.name ?? 'store-users.csv', rows: Number(result.rows ?? 0), omitted: Number(result.omitted ?? 0), providerId: String(result.providerId ?? '') };
  }

  // ---------- jobs and the schedule ----------

  registerJobs(): void {
    const s = this.s;
    s.jobs.register('identity.store.backups.due', async (p, ctx) => ({ runs: await this.runDue(String(p.tenantId ?? ctx.job.tenant_id)) }));
    s.jobs.register('identity.store.backup.run', async (p, ctx) => {
      const tenantId = String(p.tenantId ?? ctx.job.tenant_id);
      const sch = await this.scheduleOf(tenantId, String(p.providerId));
      if (!sch) return { skipped: 'no schedule' };
      return this.runOne(tenantId, sch);
    });
    s.jobs.register('identity.store.users.export', async (p, ctx) => {
      const tenantId = ctx.job.tenant_id;
      const providerId = String(p.providerId);
      const row = await s.providers.get(tenantId, providerId);
      if (!row) throw new Error('The store no longer exists.');
      await ctx.progress(10, 'Reading the accounts');
      const out = await this.exportCsv(tenantId, providerId, String(p.clearance));
      const key = StoreGovernance.exportKey(tenantId, ctx.job.id);
      await s.blobs.put(key, Buffer.from(await s.keys.sealBytes(tenantId, Buffer.from(out.csv, 'utf8'), `store-export:${ctx.job.id}`)));
      await ctx.progress(100, `${out.rows} accounts`);
      return { blobKey: key, name: exportName(row.name), rows: out.rows, omitted: out.omitted, providerId };
    });
  }

  /** Every 15 minutes, the tenants with a due backup schedule get one `identity.store.backups.due` job. */
  schedule(scheduler: Scheduler): void {
    scheduler.every(
      'identity.store.backups',
      15 * 60_000,
      async () => {
        if (!(await this.installed())) return [];
        const rows = (await this.s.db('identity_store_backup_schedules').where({ enabled: true }).andWhere('next_run_at', '<=', Date.now()).distinct('tenant_id')) as { tenant_id: string }[];
        return rows.map((r) => ({ tenantId: r.tenant_id, payload: { tenantId: r.tenant_id } }));
      },
      'identity.store.backups.due'
    );
  }
}

export const exportName = (store: string) => `store-${store.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-users.csv`;

const governors = new WeakMap<Services, StoreGovernance>();

/** The one `StoreGovernance` of a `Services`. */
export function storeGovernanceFor(s: Services, admin: StoreAdmin, backups: StoreBackups): StoreGovernance {
  let g = governors.get(s);
  if (!g) governors.set(s, (g = new StoreGovernance(s, admin, backups)));
  return g;
}

/** The same, with the `StoreAdmin` and `StoreBackups` of `s`. */
export function governanceFor(s: Services): StoreGovernance {
  const admin = storeAdminFor(s);
  return storeGovernanceFor(s, admin, storeBackupsFor(s, admin));
}
