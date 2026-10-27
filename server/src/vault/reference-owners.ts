import { ulid } from 'ulid';
import { actorFrom } from '../audit/chain.js';
import { clears, isLabel, type Label } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { sha256 } from '../crypto/index.js';
import { badRequest, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import { evaluate, kvPolicyPath, parseVaultRef, type Subjects } from './policy.js';
import type { VaultCaller } from './service.js';

/*
 * 1.7.0 (B-9209, VLT-10): a workspace or a service as the owner of a saved vault reference.
 *
 * A `vault:<path>#<key>` reference an integration keeps (a data connection's password, a user store's bind password,
 * an MCP server's token, a channel's mail password and so on) resolves as the person who saved it: their state, their
 * `secrets:read` and their path policy are asked at every use. Disable that person and the integration stops.
 *
 * A holder of `secrets:admin` may hand one such reference to a workspace or to a named service. From then on it
 * resolves under that owner's path policy and no person is asked:
 *
 * - a workspace owner reads with the grants made to the workspace (the ones its members already read with);
 * - a service owner (`integration.<name>`) reads with the grants made to that service subject in the tenant.
 *
 * Handing over grants nothing. The owner must already hold `read` on the secret's path, the admin must be able to read
 * the reference themselves, and the reference reads at no higher a label than the admin's clearance and the secret's
 * label at that moment (a secret relabelled above it stops resolving). It is one reference of one person at a time,
 * audited, and undone by removing the row: the reference then resolves as the person again.
 *
 * A reference that takes an API-key lease (`vault:apikey:...`) issues a key that belongs to a person, so it cannot be
 * handed over.
 */

export const REFERENCE_OWNER_KINDS = ['workspace', 'service'] as const;
export type ReferenceOwnerKind = (typeof REFERENCE_OWNER_KINDS)[number];
/** A service that owns references in a tenant; other service names exist in the platform scope only (B-9201). */
export const TENANT_SERVICE = /^integration\.[a-z0-9][a-z0-9.-]{0,50}$/;

export interface ReferenceOwnerRow {
  id: string;
  tenant_id: string;
  saved_by: string;
  ref: string;
  ref_key: string;
  owner_kind: ReferenceOwnerKind;
  owner: string;
  clearance: Label;
  created_by: string;
  created_at: number;
}

const from = (r: Record<string, unknown>): ReferenceOwnerRow => ({ ...(r as unknown as ReferenceOwnerRow), clearance: isLabel(r.clearance) ? r.clearance : 'public', created_at: Number(r.created_at) });
const view = (r: ReferenceOwnerRow, names: { savedBy?: string | null; owner?: string | null } = {}) => ({
  id: r.id,
  savedBy: r.saved_by,
  savedByName: names.savedBy ?? null,
  ref: r.ref,
  owner: { kind: r.owner_kind, id: r.owner, name: names.owner ?? null },
  clearance: r.clearance,
  createdBy: r.created_by,
  createdAt: r.created_at
});

const subjectsOf = (kind: ReferenceOwnerKind, owner: string): Subjects => ({ userId: null, groups: [], workspaces: kind === 'workspace' ? [owner] : [], apiKeyId: null, service: kind === 'service' ? owner : null });

export class ReferenceOwners {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  /** The owner a person's reference was handed to, if any. */
  async find(tenantId: string, savedBy: string, ref: string): Promise<ReferenceOwnerRow | null> {
    const r = await this.db('vault_reference_owners').where({ tenant_id: tenantId, saved_by: savedBy, ref_key: sha256(ref) }).first();
    return r ? from(r) : null;
  }

  /** The caller a handed-over reference resolves as: the owner's policy subjects, no person. */
  async caller(row: ReferenceOwnerRow, ctx: { via: string; traceId?: string | null }): Promise<VaultCaller> {
    if (row.owner_kind === 'workspace' && !(await this.db('workspaces').where({ tenant_id: row.tenant_id, id: row.owner }).first('id'))) {
      throw forbidden('The workspace that owns this vault reference no longer exists, so it does not resolve. Hand it to another owner.', { step: 'vault-owner' });
    }
    return {
      tenantId: row.tenant_id,
      clearance: row.clearance,
      subjects: subjectsOf(row.owner_kind, row.owner),
      // Who read it: the owner, named with what uses the reference (the audit actor has no person).
      actor: { service: 'vault.reference', name: `${row.owner_kind}:${row.owner}`, via: ctx.via },
      traceId: ctx.traceId ?? null,
      denialKey: `${row.tenant_id}:ref-owner:${row.owner_kind}:${row.owner}`
    };
  }

  async list(p: Principal) {
    const rows = ((await this.db('vault_reference_owners').where({ tenant_id: p.tenantId }).orderBy('created_at', 'desc').limit(1000)) as Record<string, unknown>[]).map(from);
    const users = new Map(((await this.db('users').where({ tenant_id: p.tenantId }).whereIn('id', [...new Set(rows.map((r) => r.saved_by))]).select('id', 'display_name', 'username', 'state')) as { id: string; display_name: string | null; username: string; state: string }[]).map((u) => [u.id, u]));
    const spaces = new Map(((await this.db('workspaces').where({ tenant_id: p.tenantId }).whereIn('id', rows.filter((r) => r.owner_kind === 'workspace').map((r) => r.owner)).select('id', 'name')) as { id: string; name: string }[]).map((w) => [w.id, w.name]));
    return rows.map((r) => {
      const u = users.get(r.saved_by);
      return { ...view(r, { savedBy: u ? u.display_name || u.username : null, owner: r.owner_kind === 'workspace' ? (spaces.get(r.owner) ?? null) : r.owner }), savedByActive: u?.state === 'active' };
    });
  }

  /**
   * Hands one reference saved by one person to a workspace or a service. Refused unless the admin can read the
   * reference now and the new owner already holds `read` on its path.
   */
  async set(p: Principal, input: { savedBy: string; ref: string; owner: { kind: ReferenceOwnerKind; id: string } }, ctx: { ip?: string | null; traceId?: string | null } = {}) {
    const s = this.s();
    const parsed = parseVaultRef(input.ref);
    if (!parsed) throw badRequest('Only a reference to a secret, vault:<path>#<key>, can be handed to a workspace or a service. A reference that takes an API-key lease issues a key that belongs to a person.');
    if (!(await this.db('users').where({ tenant_id: p.tenantId, id: input.savedBy }).first('id'))) throw badRequest(`No user ${input.savedBy} in this tenant.`);
    let owner = input.owner.id;
    if (input.owner.kind === 'workspace') {
      if (!(await this.db('workspaces').where({ tenant_id: p.tenantId, id: owner }).first('id'))) throw badRequest(`No workspace ${owner} in this tenant.`);
    } else {
      owner = owner.trim().toLowerCase();
      if (!TENANT_SERVICE.test(owner)) throw badRequest('A service that owns references is named integration.<name>: lower-case letters, digits, dot and dash.');
    }
    // The admin hands over nothing they could not read themselves (their permission, policy and clearance).
    await s.vault.assertRefsReadable(p, [input.ref], ctx);
    const secret = (await this.db('vault_secrets').where({ tenant_id: p.tenantId, path: parsed.path }).first('label')) as { label: string } | undefined;
    if (!secret) throw notFound('Secret');
    const label: Label = isLabel(secret.label) ? secret.label : 'internal';
    if (!clears(p.clearance, label)) throw forbidden(`Your clearance ${p.clearance} does not reach vault:${parsed.path}.`, { step: 'clearance' });
    // The new owner must hold the grant already: handing over never widens who may read a secret.
    const subjects = subjectsOf(input.owner.kind, owner);
    const d = evaluate(await s.vault.grantsOf(p.tenantId, subjects), subjects, kvPolicyPath(parsed.path), 'read');
    if (!d.allow) {
      throw new HttpProblem(409, 'Conflict', `${input.owner.kind === 'workspace' ? 'The workspace' : `The service ${owner}`} has no vault policy that allows read on kv/${parsed.path}. Grant it under Policies first; handing a reference over grants nothing.`, { extensions: { step: 'vault-policy', path: kvPolicyPath(parsed.path), reason: d.reason } });
    }
    const before = await this.find(p.tenantId, input.savedBy, input.ref);
    const row: ReferenceOwnerRow = { id: before?.id ?? ulid(), tenant_id: p.tenantId, saved_by: input.savedBy, ref: input.ref, ref_key: sha256(input.ref), owner_kind: input.owner.kind, owner, clearance: label, created_by: p.userId, created_at: Date.now() };
    if (before) await this.db('vault_reference_owners').where({ id: before.id }).update({ owner_kind: row.owner_kind, owner: row.owner, clearance: row.clearance, created_by: row.created_by, created_at: row.created_at });
    else await this.db('vault_reference_owners').insert(row);
    await s.audit.append({
      tenantId: p.tenantId,
      action: 'vault.reference.owner.set',
      kind: 'admin',
      actor: actorFrom(p, ctx.ip ?? null),
      target: { reference: row.id, path: parsed.path, savedBy: input.savedBy },
      label,
      detail: { before: before ? { kind: before.owner_kind, owner: before.owner } : { kind: 'user', owner: input.savedBy }, after: { kind: row.owner_kind, owner: row.owner }, clearance: label, grant: d.grant?.id ?? null },
      traceId: ctx.traceId ?? null
    });
    return view(row);
  }

  /** The reference resolves as the person who saved it again. */
  async remove(p: Principal, id: string, ctx: { ip?: string | null; traceId?: string | null } = {}): Promise<void> {
    const r = await this.db('vault_reference_owners').where({ tenant_id: p.tenantId, id }).first();
    if (!r) throw notFound('Reference owner');
    const row = from(r);
    await this.db('vault_reference_owners').where({ id }).delete();
    await this.s().audit.append({
      tenantId: p.tenantId,
      action: 'vault.reference.owner.removed',
      kind: 'admin',
      actor: actorFrom(p, ctx.ip ?? null),
      target: { reference: row.id, path: parseVaultRef(row.ref)?.path ?? null, savedBy: row.saved_by },
      label: row.clearance,
      detail: { before: { kind: row.owner_kind, owner: row.owner }, after: { kind: 'user', owner: row.saved_by } },
      traceId: ctx.traceId ?? null
    });
  }

  /** Whether the caller may manage reference owners at all (the routes ask `secrets:admin`; this is for the view). */
  canManage(p: Principal): boolean {
    return effectivePermissions(p).has('secrets:admin');
  }
}
