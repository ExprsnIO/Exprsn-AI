import { loadPrincipal, workspacesFor } from '../http/middleware.js';
import { badRequest, notFound } from '../http/problem.js';
import type { ApiKeyRow } from '../identity/apikeys.js';
import type { Workspace } from '../repos/tenants.js';
import type { Services } from '../services.js';
import { clears, type Label } from './labels.js';
import { PERMISSIONS, rolesGranting, type Permission } from './permissions.js';
import { explain, type Decision, type ExplainedStep, type Principal, type Resource } from './policy.js';

/*
 * B-3303: the effective-access matrix. Users (and, on request, their API keys) × workspaces × permissions, each cell
 * the decision of `policy.explain` for that subject and a resource standing for the workspace: the tenant, the
 * workspace's label ceiling (the most sensitive data it may hold, or a label asked for) and, when a zone is named, the
 * zone's ceiling. Nothing here decides access itself: the subject is the principal `loadPrincipal` builds for a
 * request, and every cell is `explain`'s decision, so a cell always matches `policy.explain` for the same principal and
 * resource. `member` says whether the subject may act in the workspace at all (`workspacesFor`), which is not a policy
 * step. Workspaces whose label ceiling is above the caller's clearance are left out.
 */

export interface AccessQuery {
  workspaceId?: string;
  permissions?: Permission[];
  userId?: string;
  q?: string;
  /** Data label for every cell instead of each workspace's label ceiling. */
  label?: Label;
  /** A zone whose ceiling applies to every cell. */
  zone?: string;
  /** Also a row for each live API key of the users listed (its scopes narrow its owner's roles). */
  keys?: boolean;
  limit: number;
  offset: number;
}

export interface Subject {
  kind: 'user' | 'api_key';
  userId: string;
  username: string;
  displayName: string;
  apiKeyId: string | null;
  apiKeyName: string | null;
  /** False for a disabled or sanctioned account, or a revoked or expired key: nothing is allowed. */
  active: boolean;
  roles: string[];
  clearance: string;
  scopes: string[] | null;
}

export interface Cell {
  member: boolean;
  allow: Permission[];
  deny: Partial<Record<Permission, string>>;
}

const workspaceView = (w: Workspace) => ({ id: w.id, name: w.name, labelCeiling: w.label_ceiling });

export class AccessService {
  constructor(private readonly s: () => Services) {}

  /** The resource a cell stands for. */
  resourceFor(tenantId: string, w: Workspace, label: Label | undefined, zoneCeiling: Label | null): Resource {
    return { tenantId, label: label ?? w.label_ceiling, ...(zoneCeiling ? { zoneCeiling } : {}) };
  }

  private async zoneCeiling(zone: string | undefined): Promise<Label | null> {
    if (!zone) return null;
    const c = await this.s().zones.ceilingOf(zone);
    if (!c) throw badRequest(`There is no zone ${zone}.`);
    return c;
  }

  /** The workspaces of the matrix: one, or every active one the caller is cleared for. */
  private async workspaces(caller: Principal, workspaceId: string | undefined): Promise<Workspace[]> {
    const all = (await this.s().tenants.workspaces(caller.tenantId)).filter((w) => clears(caller.clearance, w.label_ceiling));
    if (!workspaceId) return all.slice(0, 100);
    const w = all.find((x) => x.id === workspaceId);
    if (!w) throw notFound('Workspace');
    return [w];
  }

  /** The principal a request from this user (or with this key) would carry, or null when it would be refused. */
  async subject(tenantId: string, userId: string, key?: ApiKeyRow | null): Promise<{ subject: Subject; principal: Principal | null }> {
    const s = this.s();
    const user = await s.users.get(tenantId, userId);
    if (!user) throw notFound('User');
    const live = !key || (key.revoked_at == null && key.expires_at > Date.now());
    const principal = live ? await loadPrincipal(s, tenantId, userId, key ? { apiKey: key } : {}) : null;
    return {
      principal,
      subject: {
        kind: key ? 'api_key' : 'user',
        userId,
        username: user.username,
        displayName: user.display_name,
        apiKeyId: key?.id ?? null,
        apiKeyName: key?.name ?? null,
        active: !!principal,
        roles: principal?.roles ?? (await s.users.roleIds(userId)),
        clearance: principal?.clearance ?? user.clearance,
        scopes: key ? key.scopes : null
      }
    };
  }

  /** One cell: the decision and every step, as `policy.explain` gives them. */
  cell(principal: Principal | null, action: Permission, resource: Resource): { decision: Decision; steps: ExplainedStep[] } {
    if (!principal) return { decision: { allow: false, step: 'role', reason: 'The account or credential is not active', action, policy: 'baseline-v1' }, steps: [] };
    return explain(principal, action, resource);
  }

  async matrix(caller: Principal, q: AccessQuery) {
    const s = this.s();
    const perms = q.permissions?.length ? PERMISSIONS.filter((p) => q.permissions!.includes(p)) : [...PERMISSIONS];
    const workspaces = await this.workspaces(caller, q.workspaceId);
    const zoneCeiling = await this.zoneCeiling(q.zone);
    let users: { id: string }[];
    let total: number;
    if (q.userId) {
      users = [{ id: q.userId }];
      total = 1;
    } else {
      const base = () => {
        const b = s.db('users').where({ tenant_id: caller.tenantId });
        if (q.q) {
          const like = `%${q.q.toLowerCase().replace(/[%_!]/g, '!$&')}%`;
          b.andWhere((w) => w.whereRaw("LOWER(username) LIKE ? ESCAPE '!'", [like]).orWhereRaw("LOWER(display_name) LIKE ? ESCAPE '!'", [like]));
        }
        return b;
      };
      total = Number(((await base().count({ n: '*' }).first()) as { n: number | string } | undefined)?.n ?? 0);
      users = (await base().orderBy('username').limit(q.limit).offset(q.offset).select('id')) as { id: string }[];
    }
    const rows = [];
    for (const u of users) {
      const subjects = [await this.subject(caller.tenantId, u.id)];
      if (q.keys) for (const k of await s.apiKeys.listForUser(u.id)) if (k.tenant_id === caller.tenantId) subjects.push(await this.subject(caller.tenantId, u.id, k));
      for (const { subject, principal } of subjects) {
        const memberOf = principal ? new Set((await workspacesFor(s, principal)).map((w) => w.id)) : new Set<string>();
        const cells: Record<string, Cell> = {};
        for (const w of workspaces) {
          const resource = this.resourceFor(caller.tenantId, w, q.label, zoneCeiling);
          const c: Cell = { member: memberOf.has(w.id), allow: [], deny: {} };
          for (const p of perms) {
            const d = this.cell(principal, p, resource).decision;
            if (d.allow) c.allow.push(p);
            else c.deny[p] = d.step ?? 'role';
          }
          cells[w.id] = c;
        }
        rows.push({ subject, cells });
      }
    }
    return {
      permissions: perms,
      workspaces: workspaces.map(workspaceView),
      resource: { label: q.label ?? null, zone: q.zone ? { name: q.zone, ceiling: zoneCeiling } : null },
      total,
      limit: q.limit,
      offset: q.offset,
      rows
    };
  }

  /** The `explain` steps behind one cell of the matrix. */
  async explainCell(caller: Principal, q: { userId: string; apiKeyId?: string; workspaceId: string; permission: Permission; label?: Label; zone?: string }) {
    const s = this.s();
    const [w] = await this.workspaces(caller, q.workspaceId);
    let key: ApiKeyRow | null = null;
    if (q.apiKeyId) {
      key = (await s.apiKeys.listForUser(q.userId)).find((k) => k.id === q.apiKeyId && k.tenant_id === caller.tenantId) ?? null;
      if (!key) throw notFound('API key');
    }
    const { subject, principal } = await this.subject(caller.tenantId, q.userId, key);
    const zoneCeiling = await this.zoneCeiling(q.zone);
    const resource = this.resourceFor(caller.tenantId, w!, q.label, zoneCeiling);
    const member = principal ? (await workspacesFor(s, principal)).some((x) => x.id === w!.id) : false;
    return { subject, workspace: { ...workspaceView(w!), member }, resource: { label: resource.label ?? null, zoneCeiling: resource.zoneCeiling ?? null }, ...this.cell(principal, q.permission, resource) };
  }

  /**
   * "Who can": the users holding a role that grants the permission, each with the decision for the resource (a
   * workspace, or the tenant with a label) and whether they may act in the workspace. Allowed ones first.
   */
  async whoCan(caller: Principal, q: { permission: Permission; workspaceId?: string; label?: Label; zone?: string; limit: number; offset: number }) {
    const s = this.s();
    const zoneCeiling = await this.zoneCeiling(q.zone);
    const w = q.workspaceId ? (await this.workspaces(caller, q.workspaceId))[0]! : null;
    const resource: Resource = w ? this.resourceFor(caller.tenantId, w, q.label, zoneCeiling) : { tenantId: caller.tenantId, ...(q.label ? { label: q.label } : {}), ...(zoneCeiling ? { zoneCeiling } : {}) };
    const roles = rolesGranting(q.permission, caller.tenantId);
    const base = () => s.db('users as u').join('user_roles as r', 'r.user_id', 'u.id').where({ 'u.tenant_id': caller.tenantId }).whereIn('r.role', roles);
    const total = Number(((await base().countDistinct({ n: 'u.id' }).first()) as { n: number | string } | undefined)?.n ?? 0);
    const ids = ((await base().distinct('u.id', 'u.username').orderBy('u.username').limit(q.limit).offset(q.offset)) as { id: string }[]).map((r) => r.id);
    const users = [];
    for (const id of ids) {
      const { subject, principal } = await this.subject(caller.tenantId, id);
      const { decision } = this.cell(principal, q.permission, resource);
      const member = w && principal ? (await workspacesFor(s, principal)).some((x) => x.id === w.id) : null;
      users.push({ ...subject, grantedBy: subject.roles.filter((r) => roles.includes(r)), member, decision: { allow: decision.allow, step: decision.step, reason: decision.reason } });
    }
    users.sort((a, b) => Number(b.decision.allow && b.member !== false) - Number(a.decision.allow && a.member !== false));
    return { permission: q.permission, workspace: w ? workspaceView(w) : null, resource: { label: resource.label ?? null, zoneCeiling: resource.zoneCeiling ?? null }, roles, total, limit: q.limit, offset: q.offset, users };
  }
}
