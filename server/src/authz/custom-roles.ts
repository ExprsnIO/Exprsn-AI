import { ulid } from 'ulid';
import { actorFrom } from '../audit/chain.js';
import { json } from '../db/knex.js';
import { badRequest, conflict, forbidden, notFound } from '../http/problem.js';
import { TOPICS, type RolesChangedEvent } from '../platform/bus.js';
import type { Services } from '../services.js';
import {
  CUSTOM_ROLE_PREFIX,
  isAdminPermission,
  isPermission,
  isRole,
  mfaFloor,
  PERMISSIONS,
  ROLES,
  rolesGranting,
  setCustomRoles,
  type CustomRoleDef,
  type Permission
} from './permissions.js';
import { effectivePermissions, type Principal } from './policy.js';

/*
 * B-3302: custom roles per tenant. A role is built only from catalogue permissions, and never holds a permission its
 * creator (or, under dual control, its approver) does not hold. `grantableBy` and `requiresMfa` work as for built-in
 * roles; a role holding an admin permission (anything beyond the member baseline) becomes, or changes, only when a
 * second holder of `roles:manage` approves the version. Every version is kept, with a diff between any two, and every
 * change is audited. The versions in force are loaded into `permissions.ts`, so a custom role resolves wherever a
 * built-in one does (policy, effective permissions, explain, grants); other instances reload on `TOPICS.rolesChanged`.
 */

export type CustomRoleState = 'pending' | 'active' | 'retired';
export type VersionState = 'pending' | 'applied' | 'rejected' | 'withdrawn' | 'superseded';

export interface RoleDefinition {
  name: string;
  description: string;
  permissions: Permission[];
  requiresMfa: boolean;
  grantableBy: string[];
}

export interface CustomRoleRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  permissions: Permission[];
  requires_mfa: boolean;
  grantable_by: string[];
  state: CustomRoleState;
  current_version: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface RoleVersionRow {
  role_id: string;
  version: number;
  tenant_id: string;
  name: string;
  description: string;
  permissions: Permission[];
  requires_mfa: boolean;
  grantable_by: string[];
  dual_control: boolean;
  state: VersionState;
  proposed_by: string | null;
  proposed_at: number;
  decided_by: string | null;
  decided_at: number | null;
  note: string | null;
}

export interface ActCtx {
  p: Principal;
  ip: string | null;
  traceId?: string;
}

const perms = (v: unknown): Permission[] => json<string[]>(v, []).filter(isPermission);

const roleFromRow = (r: Record<string, unknown>): CustomRoleRow => ({
  ...(r as unknown as CustomRoleRow),
  permissions: perms(r.permissions),
  grantable_by: json<string[]>(r.grantable_by, []),
  requires_mfa: !!r.requires_mfa,
  current_version: r.current_version == null ? null : Number(r.current_version),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

const versionFromRow = (r: Record<string, unknown>): RoleVersionRow => ({
  ...(r as unknown as RoleVersionRow),
  version: Number(r.version),
  permissions: perms(r.permissions),
  grantable_by: json<string[]>(r.grantable_by, []),
  requires_mfa: !!r.requires_mfa,
  dual_control: !!r.dual_control,
  proposed_at: Number(r.proposed_at),
  decided_at: r.decided_at == null ? null : Number(r.decided_at)
});

export const roleView = (r: CustomRoleRow, pending?: RoleVersionRow | null) => ({
  id: r.id,
  builtIn: false,
  name: r.name,
  description: r.description,
  permissions: r.permissions,
  requiresMfa: r.requires_mfa,
  grantableBy: r.grantable_by,
  state: r.state,
  version: r.current_version,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  pendingVersion: pending ? pending.version : null
});

export const versionView = (v: RoleVersionRow) => ({
  version: v.version,
  name: v.name,
  description: v.description,
  permissions: v.permissions,
  requiresMfa: v.requires_mfa,
  grantableBy: v.grantable_by,
  dualControl: v.dual_control,
  state: v.state,
  proposedBy: v.proposed_by,
  proposedAt: v.proposed_at,
  decidedBy: v.decided_by,
  decidedAt: v.decided_at,
  note: v.note
});

/** What changed from one version to another. */
export function diffVersions(a: RoleVersionRow, b: RoleVersionRow) {
  const fields: Record<string, { from: unknown; to: unknown }> = {};
  if (a.name !== b.name) fields.name = { from: a.name, to: b.name };
  if (a.description !== b.description) fields.description = { from: a.description, to: b.description };
  if (a.requires_mfa !== b.requires_mfa) fields.requiresMfa = { from: a.requires_mfa, to: b.requires_mfa };
  return {
    from: a.version,
    to: b.version,
    permissions: { added: b.permissions.filter((x) => !a.permissions.includes(x)), removed: a.permissions.filter((x) => !b.permissions.includes(x)) },
    grantableBy: { added: b.grantable_by.filter((x) => !a.grantable_by.includes(x)), removed: a.grantable_by.filter((x) => !b.grantable_by.includes(x)) },
    fields
  };
}

/** The catalogue order, without duplicates. */
const ordered = (list: readonly Permission[]): Permission[] => PERMISSIONS.filter((p) => list.includes(p));

export class CustomRoleService {
  /** Resolves once every tenant's roles in force are loaded into the catalogue. */
  ready: Promise<void> = Promise.resolve();

  constructor(private readonly s: () => Services) {}

  /** Loads the roles in force and reloads a tenant's whenever any instance changes them. */
  init(): void {
    const s = this.s();
    s.bus.on<RolesChangedEvent>(TOPICS.rolesChanged, (e) => (e.definitions ? this.reload(e.tenantId) : undefined));
    this.ready = this.loadAll().catch((err: unknown) => s.log.error({ err }, 'custom roles did not load'));
  }

  private async loadAll(): Promise<void> {
    const rows = ((await this.s().db('custom_roles').where({ state: 'active' })) as Record<string, unknown>[]).map(roleFromRow);
    const byTenant = new Map<string, CustomRoleRow[]>();
    for (const r of rows) byTenant.set(r.tenant_id, [...(byTenant.get(r.tenant_id) ?? []), r]);
    for (const [tenantId, list] of byTenant) setCustomRoles(tenantId, list.map(toDef));
  }

  async reload(tenantId: string): Promise<void> {
    const rows = ((await this.s().db('custom_roles').where({ tenant_id: tenantId, state: 'active' })) as Record<string, unknown>[]).map(roleFromRow);
    setCustomRoles(tenantId, rows.map(toDef));
  }

  /** Reloads here at once and tells every other instance. */
  private async changed(tenantId: string): Promise<void> {
    await this.reload(tenantId);
    this.s().bus.publish(TOPICS.rolesChanged, { tenantId, definitions: true } satisfies RolesChangedEvent);
  }

  async list(tenantId: string, opts: { includeRetired?: boolean } = {}): Promise<{ role: CustomRoleRow; pending: RoleVersionRow | null }[]> {
    const q = this.s().db('custom_roles').where({ tenant_id: tenantId }).orderBy('name');
    if (!opts.includeRetired) q.whereNot({ state: 'retired' });
    const roles = ((await q) as Record<string, unknown>[]).map(roleFromRow);
    const pending = roles.length ? ((await this.s().db('custom_role_versions').where({ tenant_id: tenantId, state: 'pending' })) as Record<string, unknown>[]).map(versionFromRow) : [];
    return roles.map((role) => ({ role, pending: pending.find((v) => v.role_id === role.id) ?? null }));
  }

  async get(tenantId: string, id: string): Promise<CustomRoleRow> {
    const r = await this.s().db('custom_roles').where({ tenant_id: tenantId, id }).first();
    if (!r) throw notFound('Role');
    return roleFromRow(r);
  }

  async versions(tenantId: string, id: string): Promise<RoleVersionRow[]> {
    await this.get(tenantId, id);
    return ((await this.s().db('custom_role_versions').where({ tenant_id: tenantId, role_id: id }).orderBy('version', 'desc')) as Record<string, unknown>[]).map(versionFromRow);
  }

  async version(tenantId: string, id: string, version: number): Promise<RoleVersionRow> {
    const r = await this.s().db('custom_role_versions').where({ tenant_id: tenantId, role_id: id, version }).first();
    if (!r) throw notFound('Role version');
    return versionFromRow(r);
  }

  async diff(tenantId: string, id: string, from: number, to: number) {
    return diffVersions(await this.version(tenantId, id, from), await this.version(tenantId, id, to));
  }

  /**
   * Checks a definition against the catalogue and the actor: only catalogue permissions, none the actor does not hold,
   * `grantableBy` naming roles of the tenant, and `requiresMfa` no lower than a built-in role would have.
   */
  private async check(p: Principal, def: RoleDefinition, selfId: string | null): Promise<RoleDefinition> {
    const permissions = ordered(def.permissions);
    if (!permissions.length) throw badRequest('A role needs at least one permission.');
    const held = effectivePermissions(p);
    const beyond = permissions.filter((x) => !held.has(x));
    if (beyond.length) throw forbidden(`You cannot create or change a role holding permissions you do not hold: ${beyond.join(', ')}.`, { step: 'role', permissions: beyond });
    const grantableBy = [...new Set(def.grantableBy)];
    if (!grantableBy.length) throw badRequest('Name at least one role whose holders may grant this role.');
    const unknown = grantableBy.filter((r) => r !== selfId && !isRole(r, p.tenantId));
    if (unknown.length) throw badRequest(`Unknown roles in grantableBy: ${unknown.join(', ')}.`);
    if (!def.requiresMfa && mfaFloor(permissions)) {
      throw badRequest('A role holding these permissions must require a second factor, as the built-in roles that grant them do.', { field: 'requiresMfa' });
    }
    const name = def.name.trim();
    const taken = ROLES.some((r) => r.name.toLowerCase() === name.toLowerCase() || r.id === name.toLowerCase())
      || !!(await this.s().db('custom_roles').where({ tenant_id: p.tenantId }).whereNot({ state: 'retired' }).modify((q) => (selfId ? void q.whereNot({ id: selfId }) : undefined)).select('name')).find((r: { name: string }) => r.name.toLowerCase() === name.toLowerCase());
    if (taken) throw conflict(`A role named ${name} already exists.`);
    return { name, description: def.description.trim(), permissions, requiresMfa: def.requiresMfa, grantableBy };
  }

  private audit(ctx: ActCtx, action: string, role: { id: string; name: string }, detail: Record<string, unknown>) {
    return this.s().audit.append({ tenantId: ctx.p.tenantId, action, kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target: { role: role.id, name: role.name }, detail, traceId: ctx.traceId ?? null });
  }

  /** Tells the other holders of roles:manage that a version waits for them. */
  private async askApprovers(ctx: ActCtx, role: { id: string; name: string }, v: RoleVersionRow): Promise<void> {
    const s = this.s();
    const to = (await s.notifications.usersWithRoles(ctx.p.tenantId, rolesGranting('roles:manage', ctx.p.tenantId))).filter((id) => id !== ctx.p.userId);
    if (!to.length) return;
    await s.notifications
      .notify({ tenantId: ctx.p.tenantId, userIds: to, kind: 'authz.role.proposed', title: `${role.name}: version ${v.version} waits for a second admin`, body: `Permissions: ${v.permissions.join(', ')}`.slice(0, 300), route: 'roles', label: 'internal' })
      .catch((err: unknown) => s.log.warn({ err }, 'role approval notice failed'));
  }

  private versionRow(roleId: string, version: number, tenantId: string, def: RoleDefinition, dual: boolean, by: string): Record<string, unknown> {
    return {
      role_id: roleId,
      version,
      tenant_id: tenantId,
      name: def.name,
      description: def.description,
      permissions: JSON.stringify(def.permissions),
      requires_mfa: def.requiresMfa,
      grantable_by: JSON.stringify(def.grantableBy),
      dual_control: dual,
      state: dual ? 'pending' : 'applied',
      proposed_by: by,
      proposed_at: Date.now(),
      decided_by: dual ? null : by,
      decided_at: dual ? null : Date.now(),
      note: null
    };
  }

  /** Creates a role. One holding an admin permission stays pending until a second admin approves its first version. */
  async create(ctx: ActCtx, input: RoleDefinition): Promise<{ role: CustomRoleRow; version: RoleVersionRow }> {
    const def = await this.check(ctx.p, input, null);
    const dual = def.permissions.some(isAdminPermission);
    const id = `${CUSTOM_ROLE_PREFIX}${ulid().toLowerCase()}`;
    const t = Date.now();
    await this.s().db.transaction(async (trx) => {
      await trx('custom_roles').insert({ id, tenant_id: ctx.p.tenantId, name: def.name, description: def.description, permissions: JSON.stringify(def.permissions), requires_mfa: def.requiresMfa, grantable_by: JSON.stringify(def.grantableBy), state: dual ? 'pending' : 'active', current_version: dual ? null : 1, created_by: ctx.p.userId, created_at: t, updated_at: t });
      await trx('custom_role_versions').insert(this.versionRow(id, 1, ctx.p.tenantId, def, dual, ctx.p.userId));
    });
    const role = await this.get(ctx.p.tenantId, id);
    const version = await this.version(ctx.p.tenantId, id, 1);
    await this.audit(ctx, dual ? 'authz.role.proposed' : 'authz.role.created', role, { version: 1, permissions: def.permissions, requiresMfa: def.requiresMfa, grantableBy: def.grantableBy, dualControl: dual });
    if (dual) await this.askApprovers(ctx, role, version);
    else await this.changed(ctx.p.tenantId);
    return { role, version };
  }

  /** A new version of a role. Under dual control it waits for approval and the version in force stays as it was. */
  async update(ctx: ActCtx, id: string, patch: Partial<RoleDefinition>): Promise<{ role: CustomRoleRow; version: RoleVersionRow }> {
    const role = await this.get(ctx.p.tenantId, id);
    if (role.state === 'retired') throw conflict('The role is retired.');
    if (await this.s().db('custom_role_versions').where({ role_id: id, state: 'pending' }).first('version')) throw conflict('A version of this role already waits for approval. Approve, reject or withdraw it first.');
    const base: RoleDefinition = { name: role.name, description: role.description, permissions: role.permissions, requiresMfa: role.requires_mfa, grantableBy: role.grantable_by };
    const merged = { ...base, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as RoleDefinition;
    // A role whose permissions grow past the MFA floor is raised to it unless the caller said otherwise.
    if (patch.requiresMfa === undefined && mfaFloor(merged.permissions)) merged.requiresMfa = true;
    const def = await this.check(ctx.p, merged, id);
    // Dual control when the role holds an admin permission before or after the change.
    const dual = def.permissions.some(isAdminPermission) || role.permissions.some(isAdminPermission);
    const last = (await this.s().db('custom_role_versions').where({ role_id: id }).max({ v: 'version' }).first()) as { v: number | string | null } | undefined;
    const version = Number(last?.v ?? 0) + 1;
    await this.s().db.transaction(async (trx) => {
      await trx('custom_role_versions').insert(this.versionRow(id, version, ctx.p.tenantId, def, dual, ctx.p.userId));
      if (!dual) await this.applyIn(trx, role, version, def);
    });
    const v = await this.version(ctx.p.tenantId, id, version);
    await this.audit(ctx, dual ? 'authz.role.proposed' : 'authz.role.updated', role, { version, diff: diffVersions(await this.currentOrSelf(role, v), v), dualControl: dual });
    if (dual) await this.askApprovers(ctx, role, v);
    else await this.changed(ctx.p.tenantId);
    return { role: await this.get(ctx.p.tenantId, id), version: v };
  }

  /** The version in force (or, for a role not in force yet, the given one): the base of a diff. */
  private async currentOrSelf(role: CustomRoleRow, v: RoleVersionRow): Promise<RoleVersionRow> {
    if (role.current_version == null || role.current_version === v.version) return { ...v, version: 0, permissions: [], grantable_by: [], name: '', description: '', requires_mfa: false };
    return this.version(role.tenant_id, role.id, role.current_version);
  }

  private async applyIn(trx: Services['db'], role: CustomRoleRow, version: number, def: RoleDefinition): Promise<void> {
    if (role.current_version != null) await trx('custom_role_versions').where({ role_id: role.id, state: 'applied' }).whereNot({ version }).update({ state: 'superseded' });
    await trx('custom_roles').where({ id: role.id }).update({ name: def.name, description: def.description, permissions: JSON.stringify(def.permissions), requires_mfa: def.requiresMfa, grantable_by: JSON.stringify(def.grantableBy), state: 'active', current_version: version, updated_at: Date.now() });
  }

  private async pending(tenantId: string, id: string, version: number): Promise<{ role: CustomRoleRow; v: RoleVersionRow }> {
    const role = await this.get(tenantId, id);
    const v = await this.version(tenantId, id, version);
    if (v.state !== 'pending') throw conflict(`Version ${version} is ${v.state}.`);
    return { role, v };
  }

  /** Dual control: a second holder of roles:manage, who also holds every permission of the version, puts it in force. */
  async approve(ctx: ActCtx, id: string, version: number, note: string | null): Promise<CustomRoleRow> {
    const { role, v } = await this.pending(ctx.p.tenantId, id, version);
    if (v.proposed_by === ctx.p.userId) throw forbidden('Dual control: you cannot approve your own change. Another admin must approve it.', { step: 'dual-control' });
    const held = effectivePermissions(ctx.p);
    const beyond = v.permissions.filter((x) => !held.has(x));
    if (beyond.length) throw forbidden(`You cannot approve a role holding permissions you do not hold: ${beyond.join(', ')}.`, { step: 'role', permissions: beyond });
    if (role.state === 'retired') throw conflict('The role is retired.');
    const def: RoleDefinition = { name: v.name, description: v.description, permissions: v.permissions, requiresMfa: v.requires_mfa, grantableBy: v.grantable_by };
    await this.s().db.transaction(async (trx) => {
      const claimed = await trx('custom_role_versions').where({ role_id: id, version, state: 'pending' }).update({ state: 'applied', decided_by: ctx.p.userId, decided_at: Date.now(), note });
      if (!claimed) throw conflict('Someone else decided this version.');
      await this.applyIn(trx, role, version, def);
    });
    await this.audit(ctx, 'authz.role.approved', role, { version, proposedBy: v.proposed_by, permissions: v.permissions, note, first: role.current_version == null });
    await this.changed(ctx.p.tenantId);
    return this.get(ctx.p.tenantId, id);
  }

  /** Rejects a pending version; its proposer withdraws it instead. A role whose first version is rejected is retired. */
  async reject(ctx: ActCtx, id: string, version: number, note: string | null): Promise<RoleVersionRow> {
    const { role, v } = await this.pending(ctx.p.tenantId, id, version);
    const state: VersionState = v.proposed_by === ctx.p.userId ? 'withdrawn' : 'rejected';
    const n = await this.s().db('custom_role_versions').where({ role_id: id, version, state: 'pending' }).update({ state, decided_by: ctx.p.userId, decided_at: Date.now(), note });
    if (!n) throw conflict('Someone else decided this version.');
    if (role.current_version == null) await this.s().db('custom_roles').where({ id }).update({ state: 'retired', updated_at: Date.now() });
    await this.audit(ctx, state === 'withdrawn' ? 'authz.role.withdrawn' : 'authz.role.rejected', role, { version, proposedBy: v.proposed_by, note });
    return this.version(ctx.p.tenantId, id, version);
  }

  /** Retires a role nobody holds and no group mapping grants; it stops resolving everywhere at once. */
  async retire(ctx: ActCtx, id: string): Promise<CustomRoleRow> {
    const s = this.s();
    const role = await this.get(ctx.p.tenantId, id);
    if (role.state === 'retired') return role;
    const holders = (await s.db('user_roles as r').join('users as u', 'u.id', 'r.user_id').where({ 'u.tenant_id': ctx.p.tenantId, 'r.role': id }).countDistinct({ n: 'r.user_id' }).first()) as { n: number | string } | undefined;
    if (Number(holders?.n ?? 0) > 0) throw conflict(`${Number(holders!.n)} users hold this role. Remove it from them first.`);
    if (await s.db('group_mappings').where({ tenant_id: ctx.p.tenantId, role: id }).first('id')) throw conflict('A group mapping grants this role. Change the mapping first.');
    if (await s.db('invitations').where({ tenant_id: ctx.p.tenantId, state: 'pending' }).andWhere('roles', 'like', `%${id}%`).first('id')) throw conflict('A pending invitation grants this role. Withdraw it first.');
    await s.db.transaction(async (trx) => {
      await trx('custom_role_versions').where({ role_id: id, state: 'pending' }).update({ state: 'withdrawn', decided_by: ctx.p.userId, decided_at: Date.now(), note: 'Role retired' });
      await trx('custom_roles').where({ id }).update({ state: 'retired', updated_at: Date.now() });
    });
    await this.audit(ctx, 'authz.role.retired', role, { version: role.current_version });
    await this.changed(ctx.p.tenantId);
    return this.get(ctx.p.tenantId, id);
  }
}

const toDef = (r: CustomRoleRow): CustomRoleDef => ({
  id: r.id,
  tenantId: r.tenant_id,
  name: r.name,
  description: r.description,
  permissions: r.permissions,
  requiresMfa: r.requires_mfa,
  grantableBy: r.grantable_by,
  version: r.current_version ?? 0
});
