import { ulid } from 'ulid';
import { json } from '../db/knex.js';
import { clears, highest, isLabel, type Label } from '../authz/labels.js';
import { permissionsFor, type Permission } from '../authz/permissions.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { actorFrom, type AuditActor, type AuditKind } from '../audit/chain.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { normaliseGroup } from '../repos/users.js';
import type { Services } from '../services.js';
import { safeEqual } from '../crypto/index.js';
import { platformTenant } from '../ops/common.js';
import { evaluate, explainGrants, isGrantPath, isKvPath, isSysPath, isSysVaultPath, isVaultPath, kvPolicyPath, parseApiKeyRef, parseVaultRef, sysPath, apiKeyPolicyPath, SYS_SCOPE, transitPolicyPath, type Capability, type Effect, type Grant, type SubjectKind, type Subjects } from './policy.js';
import { ecdsaToDer } from '../pki/x509.js';
import { TENANT_SERVICE } from './reference-owners.js';
import { decryptWith, encryptWith, formatVersioned, generateMaterial, hmacWith, isHmacType, isSigningType, parseVersioned, signWith, transitAad, verifyWith, type TransitKeyType } from './transit.js';

/*
 * The tenant secrets vault (B-1701 to B-1703), on top of the per-tenant data keys.
 *
 * Every operation runs for a `VaultCaller`: the tenant, the caller's clearance, their policy subjects and how to
 * name them in the audit chain. Routes build one from the request's principal; later features that resolve
 * `vault:path#key` references at use time (B-1705) build one for the principal that saves or runs the reference and
 * call `readValue`, so the same policies and audit apply.
 *
 * Authorisation is layered: the route's permission (`secrets:read`, `secrets:write`, `secrets:admin`), then the path
 * policy for the capability (default deny, deny wins), then clearance against the secret's or key's label (a secret
 * above the caller's clearance is reported as not found). Values and plaintext are never written to the audit chain
 * or the log: reveals are audited by path and version only.
 *
 * 1.7.0 (B-9201): the platform scope. A caller whose `tenantId` is `SYS_SCOPE` works on the platform's own secrets and
 * keys: its policy paths start with `sys/` (`sys/transit/session`), its subject is a `service` (an internal caller, no
 * user) or a platform admin acting as `root`, its rows are sealed under the platform data key and its audit entries go
 * to the default tenant's chain. No route builds such a caller from a tenant's principal, so a tenant never lists or
 * reads `sys/`, and a tenant's grants may neither name a `sys/` path nor a service.
 */

export interface VaultCaller {
  tenantId: string;
  clearance: Label;
  subjects: Subjects;
  actor: AuditActor;
  traceId?: string | null;
  /** Policy denials are capped per principal in the audit chain under this key. */
  denialKey: string;
  /** 1.7.0 (B-9201): a platform admin (`platform:manage`) managing the platform scope; the path policy is not asked. */
  root?: boolean;
}

export type KvData = Record<string, string>;

interface SecretRow {
  id: string;
  tenant_id: string;
  path: string;
  label: Label;
  current_version: number;
  max_versions: number;
  cas_required: boolean;
  custom_metadata: string;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  /** Sprint 25 (B-1706): the rotation schedule and the user its notices go to (the creator when unset). */
  rotation_period_ms?: number | null;
  owner_id?: string | null;
}

interface SecretVersionRow {
  id: string;
  tenant_id: string;
  secret_id: string;
  version: number;
  value_sealed: string | null;
  created_by: string | null;
  created_at: number;
  deleted_at: number | null;
  deleted_by: string | null;
  destroyed_at: number | null;
  destroyed_by: string | null;
}

interface KeyRow {
  id: string;
  tenant_id: string;
  name: string;
  type: TransitKeyType;
  label: Label;
  latest_version: number;
  min_decrypt_version: number;
  min_available_version: number;
  deletion_allowed: boolean;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  /** Sprint 25 (B-1706): the rotation schedule; with `auto_rotate` the key is rotated when it falls due. */
  rotation_period_ms?: number | null;
  auto_rotate?: boolean;
  owner_id?: string | null;
  /**
   * 1.7.0 (B-9207): where the private half of a signing key lives. NULL: sealed in `vault_transit_versions` and used
   * in this process (every key from before). `signer`: made and used in the signer process. `openbao`: in OpenBao
   * transit. A held key's version row holds a reference (`signer:<wrapped blob>` or `kms:<name>`), never material.
   */
  custody?: TransitCustody | null;
}

export type TransitCustody = 'signer' | 'openbao';
const HELD_SIGNER = 'signer:';
const HELD_KMS = 'kms:';
const HELD_TYPES = ['ed25519', 'ecdsa-p256'] as const;

interface KeyVersionRow {
  id: string;
  key_id: string;
  version: number;
  material_sealed: string;
  public_key: string | null;
  created_at: number;
}

interface PolicyRow {
  id: string;
  tenant_id: string;
  subject_kind: SubjectKind;
  subject: string;
  path: string;
  capabilities: string;
  effect: Effect;
  description: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  /** 1.6.0 (B-4801): set on the grants that share one KV secret. */
  share_secret_id?: string | null;
  expires_at?: number | string | null;
}

const num = (v: unknown): number => Number(v);
const bool = (v: unknown): boolean => v === true || v === 1 || v === '1';

const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const secretFrom = (r: Record<string, unknown>): SecretRow => ({ ...(r as unknown as SecretRow), current_version: num(r.current_version), max_versions: num(r.max_versions), cas_required: bool(r.cas_required), created_at: num(r.created_at), updated_at: num(r.updated_at), rotation_period_ms: numOrNull(r.rotation_period_ms), owner_id: (r.owner_id as string | null | undefined) ?? null });
const versionFrom = (r: Record<string, unknown>): SecretVersionRow => ({ ...(r as unknown as SecretVersionRow), version: num(r.version), created_at: num(r.created_at), deleted_at: r.deleted_at == null ? null : num(r.deleted_at), destroyed_at: r.destroyed_at == null ? null : num(r.destroyed_at) });
const keyFrom = (r: Record<string, unknown>): KeyRow => ({ ...(r as unknown as KeyRow), latest_version: num(r.latest_version), min_decrypt_version: num(r.min_decrypt_version), min_available_version: num(r.min_available_version), deletion_allowed: bool(r.deletion_allowed), created_at: num(r.created_at), updated_at: num(r.updated_at), rotation_period_ms: numOrNull(r.rotation_period_ms), auto_rotate: bool(r.auto_rotate), owner_id: (r.owner_id as string | null | undefined) ?? null });
const grantFrom = (r: Record<string, unknown>): Grant & { createdBy: string | null; createdAt: number; updatedAt: number } => {
  const p = r as unknown as PolicyRow;
  return { id: p.id, subjectKind: p.subject_kind, subject: p.subject, path: p.path, capabilities: json<Grant['capabilities']>(p.capabilities, []), effect: p.effect, description: p.description, createdBy: p.created_by, createdAt: num(p.created_at), updatedAt: num(p.updated_at), shareSecretId: p.share_secret_id ?? null, expiresAt: p.expires_at == null ? null : num(p.expires_at) };
};

export const DAY_MS = 86_400_000;

/** A rotation schedule as shown: the period in days, when the current version was made and when the next is due. */
export function rotationView(periodMs: number | null | undefined, rotatedAt: number | null, ownerId: string | null | undefined, createdBy: string | null) {
  return {
    rotationPeriodDays: periodMs ? periodMs / DAY_MS : null,
    rotatedAt,
    rotationDueAt: periodMs && rotatedAt != null ? rotatedAt + periodMs : null,
    owner: ownerId ?? createdBy
  };
}

/** The state of one KV version, as shown in metadata. */
export const versionState = (v: Pick<SecretVersionRow, 'deleted_at' | 'destroyed_at'>): 'active' | 'deleted' | 'destroyed' => (v.destroyed_at ? 'destroyed' : v.deleted_at ? 'deleted' : 'active');

/** The role permission each capability sits under (the routes require it before the path policy is asked). */
export function permissionFor(cap: Capability): Permission {
  if (cap === 'write' || cap === 'delete') return 'secrets:write';
  if (cap === 'destroy' || cap === 'manage') return 'secrets:admin';
  return 'secrets:read';
}

export { isKvPath, kvPolicyPath, parseVaultRef, transitPolicyPath };

export const KV_MAX_BYTES = 64 * 1024;
const TRANSIT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const isTransitName = (name: string): boolean => TRANSIT_NAME.test(name) && name !== '.' && name !== '..';

export class VaultService {
  constructor(
    private readonly s: () => Services,
    private readonly opts: { maxVersions: number }
  ) {}

  private get db() {
    return this.s().db;
  }

  // ---- callers and policy ----

  /** The policy subjects of a user (and the API key, when the request carries one). */
  async subjectsFor(tenantId: string, userId: string, apiKeyId: string | null): Promise<Subjects> {
    const links = (await this.db('user_identities').where({ user_id: userId }).select('groups')) as { groups: string }[];
    const groups = [...new Set(links.flatMap((l) => json<string[]>(l.groups, [])).map(normaliseGroup).filter(Boolean))].sort();
    const memberships = await this.s().users.workspaceIds(userId);
    const workspaces = memberships.length ? ((await this.db('workspaces').where({ tenant_id: tenantId }).whereIn('id', memberships).select('id')) as { id: string }[]).map((w) => w.id) : [];
    // 1.7.0 (B-9803): the social groups the user counts as a member of now (an API key acts as its owner here too).
    const socialGroups = [...(await this.s().groups.subjects.ofUser(tenantId, userId))].sort();
    return { userId, groups, workspaces: workspaces.sort(), apiKeyId, ...(socialGroups.length ? { socialGroups } : {}) };
  }

  async callerFor(p: Principal, ctx: { ip?: string | null; traceId?: string | null } = {}): Promise<VaultCaller> {
    return {
      tenantId: p.tenantId,
      clearance: p.clearance,
      subjects: await this.subjectsFor(p.tenantId, p.userId, p.apiKeyId),
      actor: actorFrom(p, ctx.ip ?? null),
      traceId: ctx.traceId ?? null,
      denialKey: `${p.tenantId}:${p.userId ?? p.apiKeyId ?? 'anonymous'}`
    };
  }

  /** The grants that name any of the subjects (the only ones that can matter for them). */
  private async grantsFor(tenantId: string, s: Subjects): Promise<Grant[]> {
    const now = Date.now();
    const rows = (await this.db('vault_policies')
      .where({ tenant_id: tenantId })
      // 1.6.0 (B-4801): a share past its expiry no longer applies, before the sweep removes it.
      .andWhere((q) => q.whereNull('expires_at').orWhere('expires_at', '>', now))
      .andWhere((q) => {
        if (s.userId) q.orWhere((w) => w.where({ subject_kind: 'user', subject: s.userId }));
        if (s.apiKeyId) q.orWhere((w) => w.where({ subject_kind: 'api_key', subject: s.apiKeyId }));
        if (s.groups.length) q.orWhere((w) => w.where({ subject_kind: 'group' }).whereIn('subject', s.groups));
        if (s.workspaces.length) q.orWhere((w) => w.where({ subject_kind: 'workspace' }).whereIn('subject', s.workspaces));
        if (s.service) q.orWhere((w) => w.where({ subject_kind: 'service', subject: s.service }));
        if (s.socialGroups?.length) q.orWhere((w) => w.where({ subject_kind: 'social_group' }).whereIn('subject', s.socialGroups!));
        if (!s.userId && !s.apiKeyId && !s.groups.length && !s.workspaces.length && !s.service && !s.socialGroups?.length) q.whereRaw('1 = 0');
      })) as Record<string, unknown>[];
    return rows.map(grantFrom);
  }

  /** Allows, or throws 403 naming the deciding grant (and writes the denial to the audit chain). */
  private async check(c: VaultCaller, rawPath: string, capability: Capability): Promise<void> {
    const sys = c.tenantId === SYS_SCOPE;
    if (sys && c.root) return;
    const path = sys ? sysPath(rawPath) : rawPath;
    const d = evaluate(await this.grantsFor(c.tenantId, c.subjects), c.subjects, path, capability);
    if (d.allow) return;
    const auditTenant = await this.auditTenant(c);
    if (!auditTenant) throw forbidden(d.reason, { step: 'vault-policy', path, capability });
    await this.s().denials.record(c.denialKey, {
      tenantId: auditTenant,
      action: 'vault.denied',
      kind: 'decision',
      actor: c.actor,
      target: { path, capability },
      decision: { allow: false, step: null, reason: d.reason, policy: 'vault-paths', action: permissionFor(capability), capability, grant: d.grant?.id ?? null },
      traceId: c.traceId ?? null
    });
    throw forbidden(d.reason, { step: 'vault-policy', path, capability, grant: d.grant ? { id: d.grant.id, effect: d.grant.effect, path: d.grant.path, subjectKind: d.grant.subjectKind, subject: d.grant.subject } : null });
  }

  /** Whether the caller may, without auditing a denial (for filtering lists). */
  private async allowed(c: VaultCaller, paths: string[], capability: Capability): Promise<Set<string>> {
    const sys = c.tenantId === SYS_SCOPE;
    if (sys && c.root) return new Set(paths);
    const grants = await this.grantsFor(c.tenantId, c.subjects);
    return new Set(paths.filter((p) => evaluate(grants, c.subjects, sys ? sysPath(p) : p, capability).allow));
  }

  /** The chain a caller's entries go to: its tenant, or the default tenant for the platform scope. */
  private async auditTenant(c: Pick<VaultCaller, 'tenantId'>): Promise<string | null> {
    return c.tenantId === SYS_SCOPE ? platformTenant(this.s()) : c.tenantId;
  }

  /** 1.7.0 (B-9201): an internal caller in the platform scope, named in policies as the `service` subject. */
  serviceCaller(service: string): VaultCaller {
    return { tenantId: SYS_SCOPE, clearance: 'restricted', subjects: { userId: null, groups: [], workspaces: [], apiKeyId: null, service }, actor: { service }, denialKey: `${SYS_SCOPE}:${service}` };
  }

  /** 1.7.0 (B-9201): a platform admin managing the platform scope (the route requires `platform:manage`). */
  rootCaller(p: Principal, ctx: { ip?: string | null; traceId?: string | null } = {}): VaultCaller {
    return { tenantId: SYS_SCOPE, clearance: 'restricted', subjects: { userId: p.userId, groups: [], workspaces: [], apiKeyId: p.apiKeyId }, actor: actorFrom(p, ctx.ip ?? null), traceId: ctx.traceId ?? null, denialKey: `${SYS_SCOPE}:${p.userId ?? 'admin'}`, root: true };
  }

  /** 1.6.0 (B-4801): the grants naming these subjects that apply now (shares past their expiry left out). */
  grantsOf(tenantId: string, s: Subjects): Promise<Grant[]> {
    return this.grantsFor(tenantId, s);
  }

  /** 1.6.0 (B-4801): a KV secret's row as the caller may see it (null when absent or above their clearance). */
  async secretAt(c: VaultCaller, rawPath: string): Promise<{ id: string; path: string; label: Label; ownerId: string | null; createdBy: string | null } | null> {
    const row = await this.secret(c, this.kvPath(rawPath));
    return row ? { id: row.id, path: row.path, label: row.label, ownerId: row.owner_id ?? null, createdBy: row.created_by } : null;
  }

  /** 1.6.0 (B-4801): checks a policy subject exists in the tenant (and normalises a group name). */
  validSubject(tenantId: string, kind: SubjectKind, subject: string): Promise<string> {
    return this.subjectValue(tenantId, kind, subject);
  }

  /** The path policy for other parts of the vault (database leases, B-1704): allows, or throws 403 and audits. */
  authorize(c: VaultCaller, path: string, capability: Capability): Promise<void> {
    return this.check(c, path, capability);
  }

  /** The paths among `paths` the caller may use for `capability`, without auditing denials (for lists). */
  allowedPaths(c: VaultCaller, paths: string[], capability: Capability): Promise<Set<string>> {
    return this.allowed(c, paths, capability);
  }

  private async audit(c: VaultCaller, action: string, kind: AuditKind, target: Record<string, unknown>, label: Label, detail?: Record<string, unknown>) {
    const tenantId = await this.auditTenant(c);
    if (!tenantId) return undefined; // the platform scope before the default tenant exists (first start)
    const sys = c.tenantId === SYS_SCOPE;
    return this.s().audit.append({ tenantId, action, kind, actor: c.actor, target: sys ? { ...target, scope: 'sys' } : target, label, ...(detail ? { detail } : {}), traceId: c.traceId ?? null });
  }

  // ---- policies (B-1703) ----

  async listGrants(tenantId: string) {
    return ((await this.db('vault_policies').where({ tenant_id: tenantId }).orderBy([{ column: 'path', order: 'asc' }, { column: 'id', order: 'asc' }])) as Record<string, unknown>[]).map(grantFrom);
  }

  async getGrant(tenantId: string, id: string) {
    const r = await this.db('vault_policies').where({ tenant_id: tenantId, id }).first();
    if (!r) throw notFound('Vault policy');
    return grantFrom(r);
  }

  /** Checks that the subject exists in the tenant, and normalises group names. */
  private async subjectValue(tenantId: string, kind: SubjectKind, subject: string): Promise<string> {
    if (kind === 'service') {
      // 1.7.0 (B-9209): in a tenant the one kind of service is an owner of saved references, `integration.<name>`.
      if (tenantId !== SYS_SCOPE) {
        if (!TENANT_SERVICE.test(subject)) throw badRequest('A service subject in a tenant is named integration.<name> (an owner of saved vault references); other services exist in the platform scope only.');
        return subject;
      }
      if (!/^[a-z][a-z0-9.-]{0,63}$/.test(subject)) throw badRequest('A service name is lower-case letters, digits, dot and dash.');
      return subject;
    }
    if (tenantId === SYS_SCOPE) throw badRequest('A grant in the platform scope names a service.');
    if (kind === 'group') {
      const g = normaliseGroup(subject);
      if (!g) throw badRequest('The group name is empty.');
      return g;
    }
    // 1.7.0 (B-9803): a social group of the tenant that is not deleted, by id.
    if (kind === 'social_group') {
      if (!(await this.s().groups.subjects.subject(tenantId, subject))) throw badRequest(`No social group ${subject} in this tenant.`);
      return subject;
    }
    const table = kind === 'user' ? 'users' : kind === 'workspace' ? 'workspaces' : 'api_keys';
    if (!(await this.db(table).where({ tenant_id: tenantId, id: subject }).first('id'))) throw badRequest(`No ${kind.replace('_', ' ')} ${subject} in this tenant.`);
    return subject;
  }

  private grantPath(path: string, tenantId: string): string {
    const p = path.replace(/\/+$/, '');
    if (tenantId === SYS_SCOPE) {
      if (p !== '*' && !isSysVaultPath(p)) throw badRequest('A policy path in the platform scope is *, sys, or a path under it such as sys/transit/session.');
      return p;
    }
    if (!isGrantPath(p)) throw badRequest('A policy path is *, kv, transit, database, apikey, or a path under them such as kv/apps/billing, transit/payments, database/orders/readonly or apikey/exprsn/ci.');
    return p;
  }

  async createGrant(c: VaultCaller, input: { subjectKind: SubjectKind; subject: string; path: string; capabilities: (Capability | '*')[]; effect: Effect; description?: string | null }) {
    const now = Date.now();
    const row: PolicyRow = {
      id: ulid(),
      tenant_id: c.tenantId,
      subject_kind: input.subjectKind,
      subject: await this.subjectValue(c.tenantId, input.subjectKind, input.subject),
      path: this.grantPath(input.path, c.tenantId),
      capabilities: JSON.stringify([...new Set(input.capabilities)]),
      effect: input.effect,
      description: input.description ?? null,
      created_by: c.subjects.userId,
      created_at: now,
      updated_at: now
    };
    await this.db('vault_policies').insert(row);
    const g = grantFrom(row as unknown as Record<string, unknown>);
    await this.audit(c, 'vault.policy.created', 'admin', { policy: g.id, path: g.path }, 'internal', { subjectKind: g.subjectKind, subject: g.subject, effect: g.effect, capabilities: g.capabilities });
    return g;
  }

  async updateGrant(c: VaultCaller, id: string, patch: { path?: string; capabilities?: (Capability | '*')[]; effect?: Effect; description?: string | null }) {
    const before = await this.getGrant(c.tenantId, id);
    if (before.shareSecretId) throw conflict('This grant is a share of one secret; revoke it and share again instead of editing it.');
    const upd: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.path !== undefined) upd.path = this.grantPath(patch.path, c.tenantId);
    if (patch.capabilities !== undefined) upd.capabilities = JSON.stringify([...new Set(patch.capabilities)]);
    if (patch.effect !== undefined) upd.effect = patch.effect;
    if (patch.description !== undefined) upd.description = patch.description;
    await this.db('vault_policies').where({ tenant_id: c.tenantId, id }).update(upd);
    const after = await this.getGrant(c.tenantId, id);
    const view = (g: Grant) => ({ path: g.path, effect: g.effect, capabilities: g.capabilities });
    await this.audit(c, 'vault.policy.updated', 'admin', { policy: id, path: after.path }, 'internal', { before: view(before), after: view(after) });
    return after;
  }

  async deleteGrant(c: VaultCaller, id: string): Promise<void> {
    const g = await this.getGrant(c.tenantId, id);
    await this.db('vault_policies').where({ tenant_id: c.tenantId, id }).delete();
    await this.audit(c, 'vault.policy.deleted', 'admin', { policy: id, path: g.path }, 'internal', { subjectKind: g.subjectKind, subject: g.subject, effect: g.effect, capabilities: g.capabilities });
  }

  /** The decision for `subjects` on `path`, every grant that bears on it, and the deciding grant. */
  async explain(tenantId: string, subjects: Subjects, path: string, capability: Capability) {
    if (tenantId === SYS_SCOPE ? !isSysVaultPath(path) : !isVaultPath(path) || isSysPath(path)) throw badRequest(tenantId === SYS_SCOPE ? 'Explain a platform path such as sys/transit/session.' : 'Explain a vault path such as kv/apps/billing, transit/payments or database/orders/readonly.');
    // 1.7.0 (B-9803): the names of the caller's social groups, so explain says which group's grant decided.
    const socialGroupNames = subjects.socialGroups?.length ? Object.fromEntries(await this.s().groups.subjects.names(tenantId, subjects.socialGroups)) : {};
    return { subjects, socialGroupNames, ...explainGrants(await this.grantsFor(tenantId, subjects), subjects, path, capability) };
  }

  // ---- KV secrets (B-1701) ----

  private kvPath(path: string): string {
    const p = path.replace(/^\/+|\/+$/g, '');
    if (!isKvPath(p)) throw badRequest('A secret path is one to sixteen segments of lower-case letters, digits, dot, dash and underscore, separated by /.');
    return p;
  }

  private async secret(c: VaultCaller, path: string): Promise<SecretRow | null> {
    const r = await this.db('vault_secrets').where({ tenant_id: c.tenantId, path }).first();
    if (!r) return null;
    const row = secretFrom(r);
    // Above the caller's clearance: it does not exist for them.
    return clears(c.clearance, row.label) ? row : null;
  }

  private async versions(secretId: string): Promise<SecretVersionRow[]> {
    return ((await this.db('vault_secret_versions').where({ secret_id: secretId }).orderBy('version', 'asc')) as Record<string, unknown>[]).map(versionFrom);
  }

  private metadataView(row: SecretRow, versions: SecretVersionRow[]) {
    return {
      path: row.path,
      label: row.label,
      currentVersion: row.current_version,
      oldestVersion: versions[0]?.version ?? null,
      maxVersions: row.max_versions,
      casRequired: row.cas_required,
      customMetadata: json<Record<string, string>>(row.custom_metadata, {}),
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...rotationView(row.rotation_period_ms, versions.find((v) => v.version === row.current_version)?.created_at ?? null, row.owner_id, row.created_by),
      versions: versions.map((v) => ({ version: v.version, state: versionState(v), createdBy: v.created_by, createdAt: v.created_at, deletedAt: v.deleted_at, destroyedAt: v.destroyed_at }))
    };
  }

  /** Secrets under a prefix that the caller may list (metadata only). */
  async list(c: VaultCaller, prefix?: string) {
    const pre = prefix ? this.kvPath(prefix) : null;
    let q = this.db('vault_secrets').where({ tenant_id: c.tenantId });
    // `_` is a LIKE wildcard, so the pattern may over-match; the exact prefix test below settles it.
    if (pre) q = q.andWhere((b) => b.where('path', pre).orWhere('path', 'like', `${pre}/%`));
    const rows = ((await q.orderBy('path', 'asc').limit(5000)) as Record<string, unknown>[]).map(secretFrom).filter((r) => clears(c.clearance, r.label) && (!pre || r.path === pre || r.path.startsWith(pre + '/')));
    const ok = await this.allowed(c, rows.map((r) => kvPolicyPath(r.path)), 'list');
    return rows.filter((r) => ok.has(kvPolicyPath(r.path))).map((r) => ({ path: r.path, label: r.label, currentVersion: r.current_version, updatedAt: r.updated_at }));
  }

  async metadata(c: VaultCaller, rawPath: string) {
    const path = this.kvPath(rawPath);
    await this.check(c, kvPolicyPath(path), 'list');
    const row = await this.secret(c, path);
    if (!row) throw notFound('Secret');
    return this.metadataView(row, await this.versions(row.id));
  }

  /**
   * Reveals a version (the current one by default). Audited as `vault.secret.read` with the path and version; the
   * values are not in the event. A deleted version answers 410 until it is undeleted; a destroyed one for good.
   */
  async read(c: VaultCaller, rawPath: string, version?: number): Promise<{ path: string; version: number; label: Label; data: KvData; createdAt: number; createdBy: string | null }> {
    const path = this.kvPath(rawPath);
    await this.check(c, kvPolicyPath(path), 'read');
    const row = await this.secret(c, path);
    if (!row || row.current_version === 0) throw notFound('Secret');
    const want = version ?? row.current_version;
    const v = await this.db('vault_secret_versions').where({ secret_id: row.id, version: want }).first();
    if (!v) throw notFound(`Version ${want} of the secret`);
    const ver = versionFrom(v);
    if (ver.destroyed_at || !ver.value_sealed) throw new HttpProblem(410, 'Gone', `Version ${want} of ${path} was destroyed.`, { extensions: { version: want, state: 'destroyed' } });
    if (ver.deleted_at) throw new HttpProblem(410, 'Gone', `Version ${want} of ${path} is deleted; undelete it to read it.`, { extensions: { version: want, state: 'deleted' } });
    const data = JSON.parse(await this.s().keys.open(c.tenantId, ver.value_sealed, `vault-kv:${ver.id}`)) as KvData;
    await this.audit(c, 'vault.secret.read', 'decision', { path, version: want }, row.label, { keys: Object.keys(data).length });
    // 1.6.0 (B-4803): compared with the secret's reveal history; an unusual reveal raises a flag for its owner.
    await this.s().revealWatch.observe(c, row, want).catch((err: unknown) => this.s().log.warn({ err, path }, 'reveal anomaly check failed'));
    return { path, version: want, label: row.label, data, createdAt: ver.created_at, createdBy: ver.created_by };
  }

  /** One value of the current version, for `vault:path#key` references (B-1705). Audited like any read. */
  async readValue(c: VaultCaller, ref: string): Promise<string> {
    // 1.7.0 (B-9301): `vault:apikey:<provider>/<role>#key` takes an API-key lease; each read issues a fresh key.
    const lease = parseApiKeyRef(ref);
    if (lease) return this.s().apiKeyLeases.readRef(c, lease);
    const parsed = parseVaultRef(ref);
    if (!parsed) throw badRequest('Vault references look like vault:<path>#<key>.');
    const r = await this.read(c, parsed.path);
    const v = r.data[parsed.key];
    if (v === undefined) throw notFound(`Key ${parsed.key} in the secret`);
    return v;
  }

  // ---- references from other features (B-1705) ----

  /**
   * A caller for a user who is not making this request: the principal that saved a `vault:` reference, when the
   * reference is used later (a sign-in against a user store, a query on a data connection, an MCP call, a workflow
   * step). Their current state, roles, clearance and policy subjects apply, so a revoked grant or a disabled owner
   * stops the reference from resolving.
   */
  async callerForUser(tenantId: string, userId: string, ctx: { via: string; traceId?: string | null }): Promise<VaultCaller> {
    const user = await this.s().users.get(tenantId, userId);
    if (!user || user.state !== 'active') throw forbidden('The user who saved this vault reference is no longer active, so it does not resolve. Save it again as an active user.', { step: 'vault-owner' });
    if (!permissionsFor(await this.s().users.roleIds(userId)).has('secrets:read')) throw forbidden('The user who saved this vault reference no longer holds secrets:read, so it does not resolve.', { step: 'role', action: 'secrets:read' });
    return {
      tenantId,
      clearance: isLabel(user.clearance) ? user.clearance : 'public',
      subjects: await this.subjectsFor(tenantId, userId, null),
      actor: { user: userId, username: user.username, via: ctx.via },
      traceId: ctx.traceId ?? null,
      denialKey: `${tenantId}:${userId}`
    };
  }

  /**
   * At save: refuses each reference the principal could not read now (the `secrets:read` permission, the path
   * policy's `read`, and the secret's label against their clearance when it exists). A denial is audited like any
   * other; nothing is revealed and nothing is audited when every reference is allowed. A secret that does not exist
   * yet is accepted: it is checked again at use.
   */
  async assertRefsReadable(p: Principal, refs: string[], ctx: { ip?: string | null; traceId?: string | null } = {}): Promise<void> {
    if (!refs.length) return;
    if (!effectivePermissions(p).has('secrets:read')) throw forbidden('Vault references need secrets:read.', { step: 'role', action: 'secrets:read' });
    const c = await this.callerFor(p, ctx);
    for (const ref of [...new Set(refs)]) {
      const lease = parseApiKeyRef(ref);
      if (lease) {
        await this.check(c, apiKeyPolicyPath(lease.provider, lease.role), 'read');
        continue;
      }
      const parsed = parseVaultRef(ref);
      if (!parsed) throw badRequest(`${ref.slice(0, 200)} is not a vault reference: they look like vault:<path>#<key>.`);
      await this.check(c, kvPolicyPath(parsed.path), 'read');
      const row = (await this.db('vault_secrets').where({ tenant_id: c.tenantId, path: parsed.path }).first('label')) as { label: Label } | undefined;
      if (row && !clears(c.clearance, row.label)) throw forbidden(`Your clearance ${c.clearance} does not reach vault:${parsed.path}.`, { step: 'clearance' });
    }
  }

  /** At use: one value for a principal acting now (a workflow run's principal), under their policy and permission. */
  async readAs(p: Principal, ref: string, ctx: { via: string; traceId?: string | null }): Promise<string> {
    if (!effectivePermissions(p).has('secrets:read')) throw forbidden('Vault references need secrets:read.', { step: 'role', action: 'secrets:read' });
    const c = await this.callerFor(p, { traceId: ctx.traceId ?? null });
    return this.readValue({ ...c, actor: { ...c.actor, via: ctx.via } }, ref);
  }

  /**
   * At use: one value for the owner of a saved reference, under their policy (audited as a read). The owner is the
   * person who saved it, unless that reference of theirs was handed to a workspace or a service (1.7.0, B-9209):
   * then that owner's policy is asked and the person's state no longer matters.
   */
  async resolveFor(tenantId: string, ownerId: string | null, ref: string, ctx: { via: string; traceId?: string | null }): Promise<string> {
    if (!ownerId) throw forbidden('This vault reference has no owner (it was not saved through the API), so it does not resolve.', { step: 'vault-owner' });
    const handed = await this.s().referenceOwners.find(tenantId, ownerId, ref);
    if (handed) return this.readValue(await this.s().referenceOwners.caller(handed, ctx), ref);
    return this.readValue(await this.callerForUser(tenantId, ownerId, ctx), ref);
  }

  /**
   * Writes a new version. With `cas`, the write happens only if the current version is `cas` (0: only when the path
   * has no versions yet); a path with `casRequired` refuses writes without it. Versions beyond the path's
   * `maxVersions` are removed, oldest first.
   */
  async write(c: VaultCaller, rawPath: string, data: KvData, opts: { cas?: number; label?: Label } = {}) {
    const path = this.kvPath(rawPath);
    await this.check(c, kvPolicyPath(path), 'write');
    const sealedJson = JSON.stringify(data);
    if (Buffer.byteLength(sealedJson) > KV_MAX_BYTES) throw badRequest(`A secret version holds at most ${KV_MAX_BYTES / 1024} KiB.`);
    if (opts.label && !clears(c.clearance, opts.label)) throw forbidden(`Your clearance ${c.clearance} is below ${opts.label}.`, { step: 'clearance' });
    let row = await this.secret(c, path);
    if (!row) {
      if (await this.db('vault_secrets').where({ tenant_id: c.tenantId, path }).first('id')) throw notFound('Secret');
      const now = Date.now();
      const fresh: SecretRow = { id: ulid(), tenant_id: c.tenantId, path, label: opts.label ?? 'internal', current_version: 0, max_versions: this.opts.maxVersions, cas_required: false, custom_metadata: '{}', created_by: c.subjects.userId, created_at: now, updated_at: now };
      try {
        await this.db('vault_secrets').insert(fresh);
        row = fresh;
      } catch {
        row = await this.secret(c, path); // created at the same moment by another writer
        if (!row) throw conflict('The secret was created concurrently; try again.');
      }
    } else if (opts.label && opts.label !== row.label) {
      throw badRequest('Change a secret\'s label through its metadata, not with a write.');
    }
    if (row.cas_required && opts.cas === undefined) throw badRequest(`${path} requires check-and-set: send cas with the current version (${row.current_version}).`);
    if (opts.cas !== undefined && opts.cas !== row.current_version) throw new HttpProblem(409, 'Conflict', `Check-and-set failed: the current version is ${row.current_version}, not ${opts.cas}.`, { extensions: { currentVersion: row.current_version } });
    const version = row.current_version + 1;
    const id = ulid();
    const sealed = await this.s().keys.seal(c.tenantId, sealedJson, `vault-kv:${id}`);
    const now = Date.now();
    await this.db.transaction(async (trx) => {
      // Optimistic: only the writer that still sees the version it read moves it on.
      const moved = await trx('vault_secrets').where({ id: row.id, current_version: row.current_version }).update({ current_version: version, updated_at: now });
      if (!moved) throw new HttpProblem(409, 'Conflict', 'Another write to this secret landed first; read it and try again.');
      await trx('vault_secret_versions').insert({ id, tenant_id: c.tenantId, secret_id: row.id, version, value_sealed: sealed, created_by: c.subjects.userId, created_at: now, deleted_at: null, deleted_by: null, destroyed_at: null, destroyed_by: null });
      await trx('vault_secret_versions').where({ secret_id: row.id }).andWhere('version', '<=', version - row.max_versions).delete();
    });
    await this.audit(c, 'vault.secret.written', 'admin', { path, version }, row.label, { keys: Object.keys(data).sort() });
    return { path, version, label: row.label, createdAt: now };
  }

  async updateMetadata(c: VaultCaller, rawPath: string, patch: { maxVersions?: number; casRequired?: boolean; customMetadata?: Record<string, string>; label?: Label; rotationPeriodDays?: number | null; owner?: string | null }) {
    const path = this.kvPath(rawPath);
    await this.check(c, kvPolicyPath(path), 'write');
    const row = await this.secret(c, path);
    if (!row) throw notFound('Secret');
    if (patch.label && !clears(c.clearance, patch.label)) throw forbidden(`Your clearance ${c.clearance} is below ${patch.label}.`, { step: 'clearance' });
    const upd: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.maxVersions !== undefined) upd.max_versions = patch.maxVersions;
    if (patch.casRequired !== undefined) upd.cas_required = patch.casRequired;
    if (patch.customMetadata !== undefined) upd.custom_metadata = JSON.stringify(patch.customMetadata);
    if (patch.label !== undefined) upd.label = patch.label;
    if (patch.rotationPeriodDays !== undefined) Object.assign(upd, { rotation_period_ms: patch.rotationPeriodDays == null ? null : Math.round(patch.rotationPeriodDays * DAY_MS), rotation_notice: null, rotation_notice_version: null });
    if (patch.owner !== undefined) upd.owner_id = patch.owner == null ? null : await this.subjectValue(c.tenantId, 'user', patch.owner);
    await this.db('vault_secrets').where({ id: row.id }).update(upd);
    if (patch.maxVersions !== undefined) await this.db('vault_secret_versions').where({ secret_id: row.id }).andWhere('version', '<=', row.current_version - patch.maxVersions).delete();
    await this.audit(c, 'vault.secret.metadata.updated', 'admin', { path }, highest(row.label, patch.label ?? row.label), {
      before: { maxVersions: row.max_versions, casRequired: row.cas_required, label: row.label },
      after: { maxVersions: patch.maxVersions ?? row.max_versions, casRequired: patch.casRequired ?? row.cas_required, label: patch.label ?? row.label },
      customMetadataKeys: patch.customMetadata ? Object.keys(patch.customMetadata).sort() : undefined,
      ...(patch.rotationPeriodDays !== undefined ? { rotationPeriodDays: patch.rotationPeriodDays } : {}),
      ...(patch.owner !== undefined ? { owner: patch.owner } : {})
    });
    return this.metadataView(secretFrom({ ...row, ...upd } as unknown as Record<string, unknown>), await this.versions(row.id));
  }

  private async targetVersions(c: VaultCaller, path: string, versions: number[] | undefined): Promise<{ row: SecretRow; versions: SecretVersionRow[] }> {
    const row = await this.secret(c, path);
    if (!row || row.current_version === 0) throw notFound('Secret');
    const want = versions?.length ? [...new Set(versions)] : [row.current_version];
    const all = await this.versions(row.id);
    const found = all.filter((v) => want.includes(v.version));
    const missing = want.filter((w) => !found.some((v) => v.version === w));
    if (missing.length) throw notFound(`Version ${missing.join(', ')} of the secret`);
    return { row, versions: found };
  }

  /** Soft delete: the versions stop being readable until undeleted. The current version by default. */
  async softDelete(c: VaultCaller, rawPath: string, versions?: number[]) {
    const path = this.kvPath(rawPath);
    await this.check(c, kvPolicyPath(path), 'delete');
    const t = await this.targetVersions(c, path, versions);
    const ids = t.versions.filter((v) => !v.deleted_at && !v.destroyed_at).map((v) => v.id);
    if (ids.length) await this.db('vault_secret_versions').whereIn('id', ids).update({ deleted_at: Date.now(), deleted_by: c.subjects.userId });
    await this.audit(c, 'vault.secret.deleted', 'admin', { path, versions: t.versions.map((v) => v.version) }, t.row.label);
    return { path, versions: t.versions.map((v) => v.version) };
  }

  async undelete(c: VaultCaller, rawPath: string, versions: number[]) {
    const path = this.kvPath(rawPath);
    await this.check(c, kvPolicyPath(path), 'delete');
    const t = await this.targetVersions(c, path, versions);
    const destroyed = t.versions.filter((v) => v.destroyed_at).map((v) => v.version);
    if (destroyed.length) throw new HttpProblem(410, 'Gone', `Version ${destroyed.join(', ')} was destroyed and cannot be undeleted.`);
    await this.db('vault_secret_versions').whereIn('id', t.versions.map((v) => v.id)).update({ deleted_at: null, deleted_by: null });
    await this.audit(c, 'vault.secret.undeleted', 'admin', { path, versions: t.versions.map((v) => v.version) }, t.row.label);
    return { path, versions: t.versions.map((v) => v.version) };
  }

  /** Destroy: the sealed values are removed for good; the version numbers stay in the metadata. */
  async destroyVersions(c: VaultCaller, rawPath: string, versions: number[]) {
    const path = this.kvPath(rawPath);
    await this.check(c, kvPolicyPath(path), 'destroy');
    const t = await this.targetVersions(c, path, versions);
    await this.db('vault_secret_versions').whereIn('id', t.versions.map((v) => v.id)).update({ value_sealed: null, destroyed_at: Date.now(), destroyed_by: c.subjects.userId });
    await this.audit(c, 'vault.secret.destroyed', 'admin', { path, versions: t.versions.map((v) => v.version) }, t.row.label);
    return { path, versions: t.versions.map((v) => v.version) };
  }

  /** Removes the path, its metadata and every version. */
  async deleteAll(c: VaultCaller, rawPath: string) {
    const path = this.kvPath(rawPath);
    await this.check(c, kvPolicyPath(path), 'destroy');
    const row = await this.secret(c, path);
    if (!row) throw notFound('Secret');
    await this.db.transaction(async (trx) => {
      await trx('vault_secret_versions').where({ secret_id: row.id }).delete();
      await trx('vault_secrets').where({ id: row.id }).delete();
      // 1.6.0 (B-4801): its shares go with it, so a secret written later at the same path is not shared by them.
      await trx('vault_policies').where({ tenant_id: c.tenantId, share_secret_id: row.id }).delete();
    });
    await this.audit(c, 'vault.secret.removed', 'admin', { path }, row.label, { versions: row.current_version });
  }

  // ---- transit (B-1702) ----

  private transitName(name: string): string {
    if (!isTransitName(name)) throw badRequest('A transit key name is 1 to 64 lower-case letters, digits, dot, dash and underscore.');
    return name;
  }

  private async key(c: VaultCaller, name: string): Promise<KeyRow> {
    const r = await this.db('vault_transit_keys').where({ tenant_id: c.tenantId, name }).first();
    if (!r) throw notFound('Transit key');
    const k = keyFrom(r);
    if (!clears(c.clearance, k.label)) throw notFound('Transit key');
    return k;
  }

  private async keyVersions(keyId: string): Promise<KeyVersionRow[]> {
    return ((await this.db('vault_transit_versions').where({ key_id: keyId }).orderBy('version', 'asc')) as Record<string, unknown>[]).map((r) => ({ ...(r as unknown as KeyVersionRow), version: num(r.version), created_at: num(r.created_at) }));
  }

  /** Where a key asked to be `held` would live here: the signer when it runs, else OpenBao transit, else nowhere. */
  heldCustody(): TransitCustody | null {
    const kms = this.s().kms;
    if (kms.heldKeys) return 'signer';
    if (kms.kind === 'openbao' && typeof kms.createSigningKey === 'function' && typeof kms.sign === 'function') return 'openbao';
    return null;
  }

  /** The name a held version is bound to: the signer opens its blob under this name only; OpenBao names its key so. */
  private heldName(tenantId: string, k: Pick<KeyRow, 'id' | 'custody'>, version: number): string {
    return k.custody === 'signer' ? `transit:${tenantId}:${k.id}:${version}` : `${this.s().cfg.OPENBAO_KEY_PREFIX}transit-${k.id}-v${version}`.toLowerCase();
  }

  /** Signs with a held key's version: a call to the signer or to OpenBao. ECDSA comes back raw and is made DER, like a sealed key's. */
  private async signHeld(c: VaultCaller, k: KeyRow, version: number, input: Buffer): Promise<Buffer> {
    const v = (await this.db('vault_transit_versions').where({ key_id: k.id, version }).first()) as KeyVersionRow | undefined;
    if (!v) throw badRequest(`Version ${version} of ${k.name} is no longer available.`);
    const kms = this.s().kms;
    const type = k.type as (typeof HELD_TYPES)[number];
    const name = this.heldName(c.tenantId, k, version);
    let raw: Buffer;
    if (v.material_sealed.startsWith(HELD_SIGNER)) {
      if (!kms.heldKeys) throw new HttpProblem(503, 'Signer unavailable', `${k.name} is held by the signer process, which this server is not connected to (SIGNER_SOCKET).`, { extensions: { step: 'key-custody' } });
      raw = await kms.heldKeys.sign(name, type, v.material_sealed.slice(HELD_SIGNER.length), input);
    } else if (v.material_sealed.startsWith(HELD_KMS)) {
      if (typeof kms.sign !== 'function') throw new HttpProblem(503, 'KMS unavailable', `${k.name} is held in OpenBao transit, which this server is not using (KMS_PROVIDER).`, { extensions: { step: 'key-custody' } });
      raw = await kms.sign(v.material_sealed.slice(HELD_KMS.length), type, input);
    } else throw conflict(`${k.name} is marked as held but version ${version} is not a reference.`);
    return type === 'ecdsa-p256' ? ecdsaToDer(raw) : raw;
  }

  private async material(c: VaultCaller, k: KeyRow, version: number): Promise<{ material: Buffer; publicKey: string | null }> {
    // 1.7.0 (B-9207): a held key's private half is in the signer or OpenBao and is never read into this process.
    if (k.custody) throw new HttpProblem(409, 'Conflict', `${k.name} is held ${k.custody === 'signer' ? 'by the signer process' : 'in OpenBao transit'}: its key never leaves it.`, { extensions: { step: 'key-custody' } });
    const v = (await this.db('vault_transit_versions').where({ key_id: k.id, version }).first()) as KeyVersionRow | undefined;
    if (!v) throw badRequest(`Version ${version} of ${k.name} is no longer available.`);
    return { material: await this.s().keys.openBytes(c.tenantId, v.material_sealed, `vault-transit:${k.id}:${version}`), publicKey: v.public_key };
  }

  /** A new version's row, its material sealed (outside any transaction: sealing may create the tenant's data key). */
  private async versionRow(c: VaultCaller, k: Pick<KeyRow, 'id' | 'type' | 'custody'>, version: number) {
    if (k.custody) {
      // Made where it will live; only a reference and the public half come back (B-9207).
      const kms = this.s().kms;
      const name = this.heldName(c.tenantId, k, version);
      const type = k.type as (typeof HELD_TYPES)[number];
      if (k.custody === 'signer') {
        if (!kms.heldKeys) throw new HttpProblem(503, 'Signer unavailable', 'This key is held by the signer process, which this server is not connected to (SIGNER_SOCKET).', { extensions: { step: 'key-custody' } });
        const made = await kms.heldKeys.create(name, type);
        return { id: ulid(), tenant_id: c.tenantId, key_id: k.id, version, material_sealed: `${HELD_SIGNER}${made.wrapped}`, public_key: made.publicKey, created_at: Date.now() };
      }
      if (typeof kms.createSigningKey !== 'function') throw new HttpProblem(503, 'KMS unavailable', 'This key is held in OpenBao transit, which this server is not using (KMS_PROVIDER).', { extensions: { step: 'key-custody' } });
      return { id: ulid(), tenant_id: c.tenantId, key_id: k.id, version, material_sealed: `${HELD_KMS}${name}`, public_key: await kms.createSigningKey(name, type), created_at: Date.now() };
    }
    const m = generateMaterial(k.type);
    return { id: ulid(), tenant_id: c.tenantId, key_id: k.id, version, material_sealed: await this.s().keys.sealBytes(c.tenantId, m.material, `vault-transit:${k.id}:${version}`), public_key: m.publicKey, created_at: Date.now() };
  }

  private async addVersion(c: VaultCaller, k: Pick<KeyRow, 'id' | 'type' | 'custody'>, version: number, trx = this.db): Promise<void> {
    await trx('vault_transit_versions').insert(await this.versionRow(c, k, version));
  }

  private async keyView(k: KeyRow, c?: VaultCaller) {
    const versions = await this.keyVersions(k.id);
    return {
      name: k.name,
      type: k.type,
      label: k.label,
      latestVersion: k.latest_version,
      minDecryptVersion: k.min_decrypt_version,
      minAvailableVersion: k.min_available_version,
      deletionAllowed: k.deletion_allowed,
      supports: isSigningType(k.type) ? ['sign', 'verify'] : ['encrypt', 'decrypt', 'rewrap'],
      // 1.7.0 (B-9207): `sealed` in this server's database, or held by the signer process or OpenBao transit.
      custody: k.custody ?? 'sealed',
      ...(c?.tenantId === SYS_SCOPE ? { scope: 'sys' } : {}),
      createdBy: k.created_by,
      createdAt: k.created_at,
      updatedAt: k.updated_at,
      ...rotationView(k.rotation_period_ms, versions.find((v) => v.version === k.latest_version)?.created_at ?? null, k.owner_id, k.created_by),
      autoRotate: !!k.auto_rotate,
      versions: versions.map((v) => ({ version: v.version, createdAt: v.created_at, ...(v.public_key ? { publicKey: v.public_key } : {}) }))
    };
  }

  async listKeys(c: VaultCaller) {
    const rows = ((await this.db('vault_transit_keys').where({ tenant_id: c.tenantId }).orderBy('name', 'asc')) as Record<string, unknown>[]).map(keyFrom).filter((k) => clears(c.clearance, k.label));
    const ok = await this.allowed(c, rows.map((k) => transitPolicyPath(k.name)), 'list');
    return rows.filter((k) => ok.has(transitPolicyPath(k.name))).map((k) => ({ name: k.name, type: k.type, label: k.label, latestVersion: k.latest_version, minDecryptVersion: k.min_decrypt_version }));
  }

  async getKey(c: VaultCaller, rawName: string) {
    const name = this.transitName(rawName);
    await this.check(c, transitPolicyPath(name), 'list');
    return this.keyView(await this.key(c, name), c);
  }

  async createKey(c: VaultCaller, input: { name: string; type: TransitKeyType; label?: Label; custody?: 'sealed' | 'held' }) {
    const name = this.transitName(input.name);
    await this.check(c, transitPolicyPath(name), 'manage');
    let custody: TransitCustody | null = null;
    if (input.custody === 'held') {
      // 1.7.0 (B-9207): the private half is made and used in the signer or OpenBao; this process never has it.
      if (!(HELD_TYPES as readonly string[]).includes(input.type)) throw badRequest(`Only signing keys (${HELD_TYPES.join(', ')}) can be held by the signer or OpenBao.`);
      custody = this.heldCustody();
      if (!custody) throw new HttpProblem(409, 'Conflict', 'A held key needs the signer process (SIGNER_SOCKET) or OpenBao transit (KMS_PROVIDER=openbao); neither is configured.', { extensions: { step: 'key-custody' } });
    }
    const label = input.label ?? 'internal';
    if (!clears(c.clearance, label)) throw forbidden(`Your clearance ${c.clearance} is below ${label}.`, { step: 'clearance' });
    if (await this.db('vault_transit_keys').where({ tenant_id: c.tenantId, name }).first('id')) throw conflict(`A transit key named ${name} exists.`);
    const now = Date.now();
    const row: KeyRow = { id: ulid(), tenant_id: c.tenantId, name, type: input.type, label, latest_version: 1, min_decrypt_version: 1, min_available_version: 1, deletion_allowed: false, created_by: c.subjects.userId, created_at: now, updated_at: now, ...(custody ? { custody } : {}) };
    // Sprint 26a: sealed before the transaction, which on SQLite holds the only connection the data key would need.
    const first = await this.versionRow(c, row, 1);
    await this.db.transaction(async (trx) => {
      await trx('vault_transit_keys').insert(row);
      await trx('vault_transit_versions').insert(first);
    }).catch((err: unknown) => {
      if (err instanceof HttpProblem) throw err;
      throw conflict(`A transit key named ${name} exists.`);
    });
    await this.audit(c, 'vault.transit.key.created', 'admin', { key: name }, label, { type: input.type, custody: custody ?? 'sealed' });
    return this.keyView(row, c);
  }

  async rotateKey(c: VaultCaller, rawName: string) {
    const name = this.transitName(rawName);
    await this.check(c, transitPolicyPath(name), 'manage');
    const k = await this.key(c, name);
    const next = k.latest_version + 1;
    await this.db.transaction(async (trx) => {
      const moved = await trx('vault_transit_keys').where({ id: k.id, latest_version: k.latest_version }).update({ latest_version: next, updated_at: Date.now() });
      if (!moved) throw conflict('The key was rotated concurrently; read it and try again.');
      await this.addVersion(c, k, next, trx);
    });
    await this.audit(c, 'vault.transit.key.rotated', 'admin', { key: name }, k.label, { from: k.latest_version, to: next });
    return this.keyView({ ...k, latest_version: next }, c);
  }

  /**
   * Sprint 25 (B-1706): rotation by the schedule, for a key with `autoRotate`. No caller: the schedule was set by a
   * holder of `manage` on the key; the audit entry names the rotation service.
   */
  async autoRotateKey(tenantId: string, keyId: string): Promise<{ name: string; from: number; to: number } | null> {
    const r = await this.db('vault_transit_keys').where({ tenant_id: tenantId, id: keyId }).first();
    if (!r) return null;
    const k = keyFrom(r);
    const next = k.latest_version + 1;
    const system: VaultCaller = { tenantId, clearance: 'restricted', subjects: { userId: null, groups: [], workspaces: [], apiKeyId: null }, actor: { service: 'vault.rotation' }, denialKey: `${tenantId}:vault.rotation` };
    const moved = await this.db.transaction(async (trx) => {
      const n = await trx('vault_transit_keys').where({ id: k.id, latest_version: k.latest_version }).update({ latest_version: next, updated_at: Date.now(), rotation_notice: null, rotation_notice_version: null });
      if (n) await this.addVersion(system, k, next, trx);
      return n;
    });
    if (!moved) return null;
    await this.audit(system, 'vault.transit.key.rotated', 'system', { key: k.name }, k.label, { from: k.latest_version, to: next, scheduled: true });
    return { name: k.name, from: k.latest_version, to: next };
  }

  /**
   * The minimum decryption version: ciphertext and signatures from older versions are refused from now on (rewrap
   * them first). It can go back down again, as long as the material is still there (`trim` removes it for good).
   */
  async configureKey(c: VaultCaller, rawName: string, patch: { minDecryptVersion?: number; deletionAllowed?: boolean; rotationPeriodDays?: number | null; autoRotate?: boolean; owner?: string | null }) {
    const name = this.transitName(rawName);
    await this.check(c, transitPolicyPath(name), 'manage');
    const k = await this.key(c, name);
    if (patch.minDecryptVersion !== undefined && (patch.minDecryptVersion > k.latest_version || patch.minDecryptVersion < k.min_available_version)) {
      throw badRequest(`The minimum decryption version must be between ${k.min_available_version} (the oldest version kept) and ${k.latest_version} (the latest).`);
    }
    const upd: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.minDecryptVersion !== undefined) upd.min_decrypt_version = patch.minDecryptVersion;
    if (patch.deletionAllowed !== undefined) upd.deletion_allowed = patch.deletionAllowed;
    if (patch.rotationPeriodDays !== undefined) Object.assign(upd, { rotation_period_ms: patch.rotationPeriodDays == null ? null : Math.round(patch.rotationPeriodDays * DAY_MS), rotation_notice: null, rotation_notice_version: null });
    if (patch.autoRotate !== undefined) upd.auto_rotate = patch.autoRotate;
    if (patch.owner !== undefined) upd.owner_id = patch.owner == null ? null : await this.subjectValue(c.tenantId, 'user', patch.owner);
    await this.db('vault_transit_keys').where({ id: k.id }).update(upd);
    const rotation = { rotationPeriodDays: k.rotation_period_ms ? k.rotation_period_ms / DAY_MS : null, autoRotate: !!k.auto_rotate, owner: k.owner_id ?? null };
    await this.audit(c, 'vault.transit.key.configured', 'admin', { key: name }, k.label, {
      before: { minDecryptVersion: k.min_decrypt_version, deletionAllowed: k.deletion_allowed, ...rotation },
      after: { minDecryptVersion: patch.minDecryptVersion ?? k.min_decrypt_version, deletionAllowed: patch.deletionAllowed ?? k.deletion_allowed, rotationPeriodDays: patch.rotationPeriodDays !== undefined ? patch.rotationPeriodDays : rotation.rotationPeriodDays, autoRotate: patch.autoRotate ?? rotation.autoRotate, owner: patch.owner !== undefined ? patch.owner : rotation.owner }
    });
    return this.keyView(keyFrom({ ...k, ...upd } as unknown as Record<string, unknown>), c);
  }

  /** Destroys the material of every version below `minAvailableVersion`, which may not pass the minimum decryption version. */
  async trimKey(c: VaultCaller, rawName: string, minAvailableVersion: number) {
    const name = this.transitName(rawName);
    await this.check(c, transitPolicyPath(name), 'manage');
    const k = await this.key(c, name);
    if (minAvailableVersion > k.min_decrypt_version) throw badRequest(`Raise the minimum decryption version to ${minAvailableVersion} first (it is ${k.min_decrypt_version}): only versions nothing may decrypt with can be trimmed.`);
    if (minAvailableVersion <= k.min_available_version) return this.keyView(k);
    await this.db.transaction(async (trx) => {
      await trx('vault_transit_versions').where({ key_id: k.id }).andWhere('version', '<', minAvailableVersion).delete();
      await trx('vault_transit_keys').where({ id: k.id }).update({ min_available_version: minAvailableVersion, updated_at: Date.now() });
    });
    await this.audit(c, 'vault.transit.key.trimmed', 'admin', { key: name }, k.label, { from: k.min_available_version, to: minAvailableVersion });
    return this.keyView({ ...k, min_available_version: minAvailableVersion });
  }

  async deleteKey(c: VaultCaller, rawName: string) {
    const name = this.transitName(rawName);
    await this.check(c, transitPolicyPath(name), 'manage');
    const k = await this.key(c, name);
    if (!k.deletion_allowed) throw conflict(`Deletion is not allowed on ${name}: set deletionAllowed first. Everything encrypted with it becomes unreadable.`);
    await this.db.transaction(async (trx) => {
      await trx('vault_transit_versions').where({ key_id: k.id }).delete();
      await trx('vault_transit_keys').where({ id: k.id }).delete();
    });
    await this.audit(c, 'vault.transit.key.deleted', 'admin', { key: name }, k.label, { versions: k.latest_version });
  }

  private requireType(k: KeyRow, signing: boolean): void {
    if (isSigningType(k.type) !== signing) throw badRequest(`${k.name} is a ${k.type} key; it ${signing ? 'cannot sign' : 'only signs and verifies'}.`);
  }

  /** Parses a versioned value and applies the version rules: below the minimum decryption version is refused. */
  private versionOf(k: KeyRow, text: string, what: 'ciphertext' | 'signature'): { version: number; payload: Buffer } {
    const parsed = parseVersioned(text);
    if (!parsed) throw badRequest(`The ${what} is not in the exai:v<version>:<base64> form.`);
    if (parsed.version > k.latest_version) throw badRequest(`The ${what} names version ${parsed.version}, but ${k.name} is at version ${k.latest_version}.`);
    if (parsed.version < k.min_decrypt_version) {
      throw new HttpProblem(400, 'Version below minimum', `The ${what} was made with version ${parsed.version} of ${k.name}, below its minimum decryption version ${k.min_decrypt_version}.`, { extensions: { version: parsed.version, minDecryptVersion: k.min_decrypt_version } });
    }
    return parsed;
  }

  private async encryptOne(c: VaultCaller, k: KeyRow, key: Buffer, plaintext: Buffer, context: Buffer | null): Promise<string> {
    return formatVersioned(k.latest_version, encryptWith(key, transitAad(c.tenantId, k.id, k.latest_version, context), plaintext));
  }

  private async decryptOne(c: VaultCaller, k: KeyRow, ciphertext: string, context: Buffer | null, cache: Map<number, Buffer>): Promise<Buffer> {
    const { version, payload } = this.versionOf(k, ciphertext, 'ciphertext');
    let key = cache.get(version);
    if (!key) cache.set(version, (key = (await this.material(c, k, version)).material));
    try {
      return decryptWith(key, transitAad(c.tenantId, k.id, version, context), payload);
    } catch {
      throw badRequest('The ciphertext does not open with this key and context.');
    }
  }

  /** Encrypts with the latest version. Not audited (nothing is revealed); decrypt, rewrap and sign are. */
  async encrypt(c: VaultCaller, rawName: string, items: { plaintext: Buffer; context: Buffer | null }[]): Promise<string[]> {
    const name = this.transitName(rawName);
    await this.check(c, transitPolicyPath(name), 'encrypt');
    const k = await this.key(c, name);
    this.requireType(k, false);
    const key = (await this.material(c, k, k.latest_version)).material;
    return Promise.all(items.map((i) => this.encryptOne(c, k, key, i.plaintext, i.context)));
  }

  /** Each item decrypts or carries its own error, so one stale ciphertext does not fail a batch. */
  async decrypt(c: VaultCaller, rawName: string, items: { ciphertext: string; context: Buffer | null }[]): Promise<({ plaintext: Buffer } | { error: string; status: number })[]> {
    const name = this.transitName(rawName);
    await this.check(c, transitPolicyPath(name), 'decrypt');
    const k = await this.key(c, name);
    this.requireType(k, false);
    const cache = new Map<number, Buffer>();
    const out: ({ plaintext: Buffer } | { error: string; status: number })[] = [];
    for (const i of items) {
      try {
        out.push({ plaintext: await this.decryptOne(c, k, i.ciphertext, i.context, cache) });
      } catch (err) {
        if (!(err instanceof HttpProblem)) throw err;
        out.push({ error: err.detail ?? err.title, status: err.status });
      }
    }
    const opened = out.filter((o) => 'plaintext' in o).length;
    await this.audit(c, 'vault.transit.decrypted', 'decision', { key: name }, k.label, { items: items.length, opened, refused: items.length - opened });
    return out;
  }

  /** Decrypts and re-encrypts with the latest version inside the server; the plaintext is never returned. */
  async rewrap(c: VaultCaller, rawName: string, items: { ciphertext: string; context: Buffer | null }[]): Promise<({ ciphertext: string } | { error: string; status: number })[]> {
    const name = this.transitName(rawName);
    await this.check(c, transitPolicyPath(name), 'rewrap');
    const k = await this.key(c, name);
    this.requireType(k, false);
    const cache = new Map<number, Buffer>();
    const latest = (await this.material(c, k, k.latest_version)).material;
    const out: ({ ciphertext: string } | { error: string; status: number })[] = [];
    for (const i of items) {
      try {
        const plain = await this.decryptOne(c, k, i.ciphertext, i.context, cache);
        out.push({ ciphertext: await this.encryptOne(c, k, latest, plain, i.context) });
      } catch (err) {
        if (!(err instanceof HttpProblem)) throw err;
        out.push({ error: err.detail ?? err.title, status: err.status });
      }
    }
    const done = out.filter((o) => 'ciphertext' in o).length;
    await this.audit(c, 'vault.transit.rewrapped', 'decision', { key: name }, k.label, { items: items.length, rewrapped: done, refused: items.length - done, toVersion: k.latest_version });
    return out;
  }

  async sign(c: VaultCaller, rawName: string, input: Buffer): Promise<{ signature: string; version: number }> {
    const name = this.transitName(rawName);
    await this.check(c, transitPolicyPath(name), 'sign');
    const k = await this.key(c, name);
    this.requireType(k, true);
    const signature = formatVersioned(k.latest_version, k.custody ? await this.signHeld(c, k, k.latest_version, input) : signWith(k.type, (await this.material(c, k, k.latest_version)).material, input));
    await this.audit(c, 'vault.transit.signed', 'decision', { key: name }, k.label, { version: k.latest_version, bytes: input.length });
    return { signature, version: k.latest_version };
  }

  /** Signatures from versions below the minimum decryption version are refused, like old ciphertext. */
  async verify(c: VaultCaller, rawName: string, input: Buffer, signature: string): Promise<{ valid: boolean; version: number }> {
    const name = this.transitName(rawName);
    await this.check(c, transitPolicyPath(name), 'verify');
    const k = await this.key(c, name);
    this.requireType(k, true);
    const { version, payload } = this.versionOf(k, signature, 'signature');
    if (isHmacType(k.type)) {
      // 1.7.0 (B-9205): recomputed under the version the signature names, so the current and the previous verify.
      const { material } = await this.material(c, k, version);
      return { valid: safeEqual(hmacWith(material, input).toString('base64'), payload.toString('base64')), version };
    }
    const v = (await this.db('vault_transit_versions').where({ key_id: k.id, version }).first('public_key')) as { public_key: string | null } | undefined;
    if (!v) throw badRequest(`Version ${version} of ${k.name} is no longer available.`);
    const publicKey = v.public_key;
    return { valid: !!publicKey && verifyWith(k.type, publicKey, input, payload), version };
  }

  // ---- the platform scope's HMAC keys (B-9201, B-9205) ----

  /**
   * The secrets of a platform HMAC key for the service that may use it, the current version first, down to the
   * minimum decryption version. Platform scope only: the secrets stay in this process (they key the session, API-key
   * and link digests on every request, B-9203), and a tenant's HMAC key signs and verifies through `sign` and `verify`
   * without its material ever leaving the service. The path policy is asked for `sign` and `verify` on the key.
   */
  async hmacSecrets(c: VaultCaller, rawName: string): Promise<{ name: string; latest: number; min: number; secrets: { version: number; secret: string }[] }> {
    if (c.tenantId !== SYS_SCOPE) throw forbidden('Key material is read in the platform scope only.', { step: 'vault-scope' });
    const name = this.transitName(rawName);
    await this.check(c, transitPolicyPath(name), 'sign');
    await this.check(c, transitPolicyPath(name), 'verify');
    const k = await this.key(c, name);
    if (!isHmacType(k.type)) throw badRequest(`${k.name} is a ${k.type} key, not an HMAC key.`);
    const rows = (await this.db('vault_transit_versions').where({ key_id: k.id }).andWhere('version', '>=', k.min_decrypt_version).orderBy('version', 'desc')) as KeyVersionRow[];
    const secrets: { version: number; secret: string }[] = [];
    for (const v of rows) secrets.push({ version: num(v.version), secret: (await this.s().keys.openBytes(c.tenantId, v.material_sealed, `vault-transit:${k.id}:${num(v.version)}`)).toString('utf8') });
    if (!secrets.length || secrets[0]!.version !== k.latest_version) throw conflict(`${k.name} has no material for its latest version.`);
    return { name: k.name, latest: k.latest_version, min: k.min_decrypt_version, secrets };
  }

  /**
   * Creates a platform HMAC key whose first version is `firstSecret`, with the grant that lets `service` use it.
   * Returns false when the key exists already (another instance created it, or an earlier start). 1.7.0 (B-9205): the
   * first secret is the SESSION_SECRET the derivation used before, so everything issued under it stays valid.
   */
  async ensureSysHmacKey(name: string, service: string, firstSecret: string): Promise<boolean> {
    this.transitName(name);
    if (await this.db('vault_transit_keys').where({ tenant_id: SYS_SCOPE, name }).first('id')) return false;
    const now = Date.now();
    const row: KeyRow = { id: ulid(), tenant_id: SYS_SCOPE, name, type: 'hmac-sha256', label: 'restricted', latest_version: 1, min_decrypt_version: 1, min_available_version: 1, deletion_allowed: false, created_by: null, created_at: now, updated_at: now };
    const first = { id: ulid(), tenant_id: SYS_SCOPE, key_id: row.id, version: 1, material_sealed: await this.s().keys.sealBytes(SYS_SCOPE, Buffer.from(firstSecret, 'utf8'), `vault-transit:${row.id}:1`), public_key: null, created_at: now };
    const grant = { id: ulid(), tenant_id: SYS_SCOPE, subject_kind: 'service', subject: service, path: sysPath(transitPolicyPath(name)), capabilities: JSON.stringify(['sign', 'verify']), effect: 'allow', description: `The ${service} service uses the ${name} key.`, created_by: null, created_at: now, updated_at: now };
    try {
      await this.db.transaction(async (trx) => {
        await trx('vault_transit_keys').insert(row);
        await trx('vault_transit_versions').insert(first);
        await trx('vault_policies').insert(grant);
      });
    } catch (err) {
      if (await this.db('vault_transit_keys').where({ tenant_id: SYS_SCOPE, name }).first('id')) return false; // created at the same moment elsewhere
      throw err;
    }
    await this.audit(this.serviceCaller('vault.sys'), 'vault.transit.key.created', 'system', { key: name }, 'restricted', { type: 'hmac-sha256', service, firstVersion: 'previous-session-secret' });
    return true;
  }
}
