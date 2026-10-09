import { ulid } from 'ulid';
import { z } from 'zod';
import { clears, labelRank, LABELS, type Label } from '../authz/labels.js';
import { getRole, PERMISSIONS, permissionsFor, type Permission } from '../authz/permissions.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { actorFrom } from '../audit/chain.js';
import { json } from '../db/knex.js';
import { badRequest, conflict, forbidden, notFound } from '../http/problem.js';
import type { ApiKeyRow } from '../identity/apikeys.js';
import type { Services } from '../services.js';

/*
 * 1.6.0, Sprint 38b (B-7701): agent identities. An agent (by name, across its versions) can be a principal of its
 * own: roles, a label ceiling and scoped API keys. Whatever runs the agent, the run acts within both grants: the
 * user's permissions narrowed to what the agent's roles grant (as credential scopes, so the policy pipeline's scope
 * step decides and the denial names it), and the lower of the user's clearance and the agent's ceiling. So an agent
 * whose roles grant `knowledge:read` cannot write through a tool even when an admin runs it. Audit events made during
 * the run carry the agent beside the user (`actor.agent`). A key minted for the identity authenticates requests as
 * the agent on behalf of the key's owner, within the identity's grants, the owner's and the key's scopes.
 * Capability tokens (B-50) were dropped on 2026-10-07; scoped keys and the identity's roles take their place.
 */

export const identityBody = z.object({
  roles: z.array(z.string().trim().min(1).max(63)).min(1).max(16),
  ceiling: z.enum(LABELS),
  enabled: z.boolean().default(true)
});
export type IdentityInput = z.infer<typeof identityBody>;

export const identityKeyBody = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(PERMISSIONS)).min(1).max(PERMISSIONS.length),
  ttlDays: z.union([z.literal(30), z.literal(90), z.literal(180), z.literal(365)])
});

export interface IdentityRow {
  id: string;
  tenant_id: string;
  agent_name: string;
  roles: string[];
  ceiling: Label;
  enabled: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

const fromRow = (r: Record<string, unknown>): IdentityRow => ({ ...(r as unknown as IdentityRow), roles: json<string[]>(r.roles, []), enabled: !!r.enabled, created_at: Number(r.created_at), updated_at: Number(r.updated_at) });

export class AgentIdentityService {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  async get(tenantId: string, agentName: string): Promise<IdentityRow | null> {
    const r = (await this.db('agent_identities').where({ tenant_id: tenantId, agent_name: agentName }).first()) as Record<string, unknown> | undefined;
    return r ? fromRow(r) : null;
  }

  async byId(id: string): Promise<IdentityRow | null> {
    const r = (await this.db('agent_identities').where({ id }).first()) as Record<string, unknown> | undefined;
    return r ? fromRow(r) : null;
  }

  async list(tenantId: string): Promise<IdentityRow[]> {
    return ((await this.db('agent_identities').where({ tenant_id: tenantId }).orderBy('agent_name')) as Record<string, unknown>[]).map(fromRow);
  }

  view(x: IdentityRow) {
    const perms = [...permissionsFor(x.roles, x.tenant_id)].sort();
    return { id: x.id, agent: x.agent_name, roles: x.roles, roleNames: x.roles.map((r) => getRole(r, x.tenant_id)?.name ?? r), permissions: perms, ceiling: x.ceiling, enabled: x.enabled, createdAt: x.created_at, updatedAt: x.updated_at };
  }

  /** The agent must exist in the tenant's registry (any version but retired). */
  private async agentExists(tenantId: string, name: string): Promise<boolean> {
    return (await this.s().registry.list(tenantId, { kind: 'agent' })).some((e) => e.name === name && e.status !== 'retired');
  }

  async set(p: Principal, agentName: string, input: IdentityInput) {
    if (!(await this.agentExists(p.tenantId, agentName))) throw notFound('Agent');
    const unknown = input.roles.filter((r) => !getRole(r, p.tenantId));
    if (unknown.length) throw badRequest(`Unknown role${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`);
    if (!clears(p.clearance, input.ceiling)) throw forbidden(`Your clearance is ${p.clearance}; an agent ceiling of ${input.ceiling} is above it.`, { step: 'clearance' });
    // Roles never widen the person who grants them: every permission the identity gets, its author holds.
    const held = effectivePermissions(p);
    const extra = [...permissionsFor(input.roles, p.tenantId)].filter((x) => !held.has(x));
    if (extra.length) throw forbidden(`These roles grant ${extra.join(', ')}, which you do not hold.`, { step: 'role' });
    const now = Date.now();
    const existing = await this.get(p.tenantId, agentName);
    const row: IdentityRow = existing
      ? { ...existing, roles: [...new Set(input.roles)], ceiling: input.ceiling, enabled: input.enabled, updated_by: p.userId, updated_at: now }
      : { id: ulid(), tenant_id: p.tenantId, agent_name: agentName, roles: [...new Set(input.roles)], ceiling: input.ceiling, enabled: input.enabled, created_by: p.userId, updated_by: p.userId, created_at: now, updated_at: now };
    const data = { ...row, roles: JSON.stringify(row.roles) };
    if (existing) await this.db('agent_identities').where({ id: row.id }).update(data);
    else await this.db('agent_identities').insert(data);
    // A key minted for the identity stays within the identity's roles: scopes the roles no longer grant are dropped.
    if (existing) {
      const perms = permissionsFor(row.roles, p.tenantId);
      for (const k of await this.s().apiKeys.listForAgent(row.id)) {
        const kept = k.scopes.filter((sc) => perms.has(sc));
        if (kept.length !== k.scopes.length) await this.db('api_keys').where({ id: k.id }).update({ scopes: JSON.stringify(kept) });
      }
    }
    await this.s().audit.append({ tenantId: p.tenantId, action: existing ? 'agent.identity.updated' : 'agent.identity.created', kind: 'admin', actor: actorFrom(p), target: { identity: row.id, agent: agentName }, detail: { roles: row.roles, ceiling: row.ceiling, enabled: row.enabled } });
    return this.view(row);
  }

  /**
   * The principal a run of `agentName` acts as on behalf of `p`: `p`'s permissions narrowed to the identity's roles
   * (as scopes) and the lower clearance, with the agent named for the audit. No identity, or one that is off: `p`.
   */
  async narrow(p: Principal, agentName: string): Promise<Principal> {
    const x = await this.get(p.tenantId, agentName);
    if (!x || !x.enabled) return p;
    return this.narrowTo(p, x);
  }

  narrowTo(p: Principal, x: IdentityRow): Principal {
    const agentPerms = permissionsFor(x.roles, p.tenantId);
    const scopes = [...effectivePermissions(p)].filter((perm) => agentPerms.has(perm)).sort() as Permission[];
    const clearance: Label = labelRank(x.ceiling) < labelRank(p.clearance) ? x.ceiling : p.clearance;
    return { ...p, scopes, clearance, agent: { id: x.id, name: x.agent_name } };
  }

  // ---------- keys ----------

  async createKey(p: Principal, agentName: string, input: z.infer<typeof identityKeyBody>) {
    const x = await this.get(p.tenantId, agentName);
    if (!x) throw notFound('Agent identity');
    if (!x.enabled) throw conflict(`The identity of ${agentName} is off; turn it on before minting a key.`);
    const perms = permissionsFor(x.roles, p.tenantId);
    const held = effectivePermissions(p);
    const extra = input.scopes.filter((sc) => !perms.has(sc) || !held.has(sc));
    if (extra.length) throw forbidden(`Scopes never widen the identity or its author: ${extra.join(', ')}.`, { step: 'scope' });
    const { key, row } = await this.s().apiKeys.create({ tenantId: p.tenantId, userId: p.userId, name: input.name, scopes: input.scopes as Permission[], ttlDays: input.ttlDays, agentId: x.id });
    await this.s().audit.append({ tenantId: p.tenantId, action: 'agent.identity.key.created', kind: 'admin', actor: actorFrom(p), target: { identity: x.id, agent: agentName, key: row.id, prefix: row.prefix }, detail: { scopes: row.scopes, expiresAt: row.expires_at } });
    return { id: row.id, key, prefix: `exai_k1_${row.prefix}`, scopes: row.scopes, expiresAt: row.expires_at, notice: 'This is the only time the key is shown.' };
  }

  async keys(tenantId: string, agentName: string) {
    const x = await this.get(tenantId, agentName);
    if (!x) return [];
    const owners = new Map<string, string>();
    const rows = await this.s().apiKeys.listForAgent(x.id);
    for (const k of rows) {
      if (owners.has(k.user_id)) continue;
      const u = (await this.db('users').where({ id: k.user_id }).first('display_name')) as { display_name: string } | undefined;
      owners.set(k.user_id, u?.display_name ?? k.user_id);
    }
    return rows.map((k) => this.keyView(k, owners.get(k.user_id) ?? null));
  }

  keyView(k: ApiKeyRow, owner: string | null) {
    return { id: k.id, name: k.name, prefix: `exai_k1_${k.prefix}`, scopes: k.scopes, expiresAt: k.expires_at, lastUsedAt: k.last_used_at, revokedAt: k.revoked_at, createdAt: k.created_at, owner: k.user_id, ownerName: owner, state: k.revoked_at ? 'revoked' : k.expires_at <= Date.now() ? 'expired' : 'active' };
  }

  async revokeKey(p: Principal, agentName: string, keyId: string) {
    const x = await this.get(p.tenantId, agentName);
    if (!x) throw notFound('Agent identity');
    if (!(await this.s().apiKeys.revokeForAgent(x.id, keyId))) throw notFound('API key');
    await this.s().audit.append({ tenantId: p.tenantId, action: 'agent.identity.key.revoked', kind: 'admin', actor: actorFrom(p), target: { identity: x.id, agent: agentName, key: keyId } });
  }
}
