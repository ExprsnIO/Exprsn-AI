import { ulid } from 'ulid';
import { json } from '../db/knex.js';
import { permissionsFor } from '../authz/permissions.js';
import { conflict, forbidden, notFound } from '../http/problem.js';
import type { Services } from '../services.js';

/**
 * Federation changes that wait for approval (Sprint 17):
 * - `client.introspect`: letting an OIDC client introspect every client's tokens (a resource server, B-806). An
 *   identity admin proposes it and a second identity admin approves (dual control, as for zones and signer keys).
 * - `metadata.sp` / `metadata.idp`: fetched SAML metadata whose certificates or endpoints changed since they were
 *   last applied (B-807). The refresh job proposes the change and any identity admin approves it; until then the
 *   previous certificates stay in force.
 */
export type ProposalKind = 'client.introspect' | 'metadata.sp' | 'metadata.idp';

export interface FederationProposalRow {
  id: string;
  tenant_id: string;
  kind: ProposalKind;
  target_id: string;
  name: string;
  payload: Record<string, unknown>;
  summary: string | null;
  state: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'superseded';
  proposed_by: string | null;
  proposed_at: number;
  decided_by: string | null;
  decided_at: number | null;
  note: string | null;
}

export interface ProposalActor {
  tenantId: string;
  userId: string;
  username: string;
  ip: string | null;
  traceId?: string;
}

const fromRow = (r: Record<string, unknown>): FederationProposalRow => ({
  ...(r as unknown as FederationProposalRow),
  payload: json<Record<string, unknown>>(r.payload, {}),
  proposed_at: Number(r.proposed_at),
  decided_at: r.decided_at == null ? null : Number(r.decided_at)
});

/** Applies an approved proposal; registered by the owner of each kind. */
export type ProposalApplier = (p: FederationProposalRow, by: ProposalActor) => Promise<void>;

export class FederationProposals {
  private readonly appliers = new Map<ProposalKind, ProposalApplier>();

  constructor(private readonly s: () => Services) {}

  onApprove(kind: ProposalKind, fn: ProposalApplier): void {
    this.appliers.set(kind, fn);
  }

  async list(tenantId: string, opts: { state?: string; limit?: number } = {}): Promise<FederationProposalRow[]> {
    const q = this.s().db('federation_proposals').where({ tenant_id: tenantId }).orderBy('proposed_at', 'desc').limit(opts.limit ?? 100);
    if (opts.state) q.andWhere({ state: opts.state });
    return ((await q) as Record<string, unknown>[]).map(fromRow);
  }

  async get(tenantId: string, id: string): Promise<FederationProposalRow> {
    const r = await this.s().db('federation_proposals').where({ tenant_id: tenantId, id }).first();
    if (!r) throw notFound('Proposal');
    return fromRow(r);
  }

  async pendingFor(tenantId: string, kind: ProposalKind, targetId: string): Promise<FederationProposalRow | null> {
    const r = await this.s().db('federation_proposals').where({ tenant_id: tenantId, kind, target_id: targetId, state: 'pending' }).first();
    return r ? fromRow(r) : null;
  }

  /** The active users of a tenant whose roles include identity:manage. */
  async identityAdmins(tenantId: string): Promise<string[]> {
    const rows = (await this.s().db('users as u').join('user_roles as r', 'r.user_id', 'u.id').where({ 'u.tenant_id': tenantId, 'u.state': 'active' }).select('u.id', 'r.role')) as { id: string; role: string }[];
    const roles = new Map<string, string[]>();
    for (const r of rows) roles.set(r.id, [...(roles.get(r.id) ?? []), r.role]);
    return [...roles].filter(([, list]) => permissionsFor(list).has('identity:manage')).map(([id]) => id);
  }

  /**
   * Records a proposal. `by` null means the metadata refresh proposed it. An earlier pending proposal of the same
   * kind for the same target is superseded (metadata) or refused (a person's proposal).
   */
  async propose(tenantId: string, input: { kind: ProposalKind; targetId: string; name: string; payload: Record<string, unknown>; summary: string }, by: ProposalActor | null): Promise<FederationProposalRow> {
    const s = this.s();
    const earlier = await this.pendingFor(tenantId, input.kind, input.targetId);
    if (earlier) {
      if (by) throw conflict('A change to this is already waiting for approval.');
      await s.db('federation_proposals').where({ id: earlier.id, state: 'pending' }).update({ state: 'superseded', decided_at: Date.now(), note: 'Replaced by newer metadata.' });
    }
    const row = { id: ulid(), tenant_id: tenantId, kind: input.kind, target_id: input.targetId, name: input.name.slice(0, 200), payload: JSON.stringify(input.payload), summary: input.summary.slice(0, 1000), state: 'pending', proposed_by: by?.userId ?? null, proposed_at: Date.now(), decided_by: null, decided_at: null, note: null };
    await s.db('federation_proposals').insert(row);
    await s.audit.append({
      tenantId,
      action: 'federation.proposal.created',
      kind: by ? 'admin' : 'system',
      actor: by ? { user: by.userId, username: by.username, ip: by.ip } : { service: 'federation' },
      target: { proposal: row.id, kind: input.kind, target: input.targetId, name: input.name },
      detail: { summary: input.summary, supersedes: earlier?.id ?? null },
      ...(by?.traceId ? { traceId: by.traceId } : {})
    });
    const admins = (await this.identityAdmins(tenantId)).filter((id) => id !== by?.userId);
    if (admins.length) {
      await s.notifications
        .notify({ tenantId, userIds: admins, kind: 'federation.proposal', title: by ? `${input.name}: a change waits for a second identity admin` : `${input.name}: fetched metadata changed and waits for approval`, body: input.summary.slice(0, 300), route: 'identity', label: 'internal' })
        .catch((err: unknown) => s.log.warn({ err }, 'proposal notice failed'));
    }
    return fromRow(row);
  }

  private async pending(tenantId: string, id: string): Promise<FederationProposalRow> {
    const p = await this.get(tenantId, id);
    if (p.state !== 'pending') throw conflict(`The proposal is ${p.state}.`);
    return p;
  }

  private decide(id: string, state: FederationProposalRow['state'], by: ProposalActor, note: string | null) {
    return this.s().db('federation_proposals').where({ id, state: 'pending' }).update({ state, decided_by: by.userId, decided_at: Date.now(), note });
  }

  private audit(by: ProposalActor, action: string, p: FederationProposalRow, note: string | null) {
    return this.s().audit.append({ tenantId: by.tenantId, action, kind: 'admin', actor: { user: by.userId, username: by.username, ip: by.ip }, target: { proposal: p.id, kind: p.kind, target: p.target_id, name: p.name }, detail: { proposedBy: p.proposed_by, summary: p.summary, note }, ...(by.traceId ? { traceId: by.traceId } : {}) });
  }

  /** Approves and applies. A person's proposal needs another identity admin; the refresh job's needs any one. */
  async approve(by: ProposalActor, id: string, note: string | null): Promise<FederationProposalRow> {
    const p = await this.pending(by.tenantId, id);
    if (p.proposed_by && p.proposed_by === by.userId) throw forbidden('Dual control: you cannot approve your own proposal. Another identity admin must approve it.', { step: 'dual-control' });
    const apply = this.appliers.get(p.kind);
    if (!apply) throw conflict('This kind of change cannot be applied here.');
    // Claim first, so two approvers racing apply it once.
    if (!(await this.decide(id, 'approved', by, note))) throw conflict('The proposal was decided by someone else.');
    try {
      await apply(p, by);
    } catch (err) {
      await this.s().db('federation_proposals').where({ id }).update({ state: 'pending', decided_by: null, decided_at: null, note: null });
      throw err;
    }
    await this.audit(by, 'federation.proposal.approved', p, note);
    return this.get(by.tenantId, id);
  }

  async reject(by: ProposalActor, id: string, note: string | null): Promise<FederationProposalRow> {
    const p = await this.pending(by.tenantId, id);
    if (p.proposed_by && p.proposed_by === by.userId) throw conflict('This is your own proposal: withdraw it instead.');
    if (!(await this.decide(id, 'rejected', by, note))) throw conflict('The proposal was decided by someone else.');
    await this.audit(by, 'federation.proposal.rejected', p, note);
    return this.get(by.tenantId, id);
  }

  async withdraw(by: ProposalActor, id: string): Promise<FederationProposalRow> {
    const p = await this.pending(by.tenantId, id);
    if (p.proposed_by !== by.userId) throw forbidden('Only the admin who proposed a change can withdraw it; reject it instead.', { step: 'dual-control' });
    if (!(await this.decide(id, 'withdrawn', by, null))) throw conflict('The proposal was decided by someone else.');
    await this.audit(by, 'federation.proposal.withdrawn', p, null);
    return this.get(by.tenantId, id);
  }
}
