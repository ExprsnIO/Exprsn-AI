import { ulid } from 'ulid';
import { actorFrom } from '../audit/chain.js';
import type { Principal } from '../authz/policy.js';
import { rolesGranting } from '../authz/permissions.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';

/*
 * Legal holds (1.6.0, B-7602). A hold on a user or on a workspace suspends every retention purge of what is theirs:
 * conversations (chat retention), memories (expiry), files (the trash purge) and, when one exists, agent runs. It is
 * placed under dual control: a holder of `compliance:manage` asks, naming another holder as approver, and nothing is
 * suspended until that person approves; the requester may withdraw a pending request. A hold is released by any
 * holder of the permission (audited) and the next purge treats the content as before. The reason is sealed with the
 * tenant key. Retention jobs ask `held(tenantId)` for the users and workspaces under an active hold and leave their
 * rows alone; the people concerned are not told.
 */

export const HOLD_SCOPES = ['user', 'workspace'] as const;
export type HoldScope = (typeof HOLD_SCOPES)[number];
export type HoldState = 'pending' | 'active' | 'rejected' | 'withdrawn' | 'released';

export interface HoldRow {
  id: string;
  tenant_id: string;
  scope: HoldScope;
  scope_id: string;
  reason: string;
  state: HoldState;
  requested_by: string;
  approver_id: string;
  decided_by: string | null;
  decided_at: number | null;
  released_by: string | null;
  released_at: number | null;
  note: string | null;
  created_at: number;
  updated_at: number;
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const holdFrom = (r: Record<string, unknown>): HoldRow => ({ ...(r as unknown as HoldRow), decided_at: num(r.decided_at), released_at: num(r.released_at), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });

export interface Held {
  users: string[];
  workspaces: string[];
}

/** What retention jobs need of legal holds. */
export interface HoldLookup {
  held(tenantId: string): Promise<Held>;
}

export const noHolds: HoldLookup = { held: async () => ({ users: [], workspaces: [] }) };

export interface HoldCtx {
  p: Principal;
  ip: string | null;
  traceId?: string;
}

export class LegalHolds implements HoldLookup {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  private audit(ctx: HoldCtx, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>) {
    return this.s().audit.append({ tenantId: ctx.p.tenantId, action, kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target, ...(detail ? { detail } : {}), traceId: ctx.traceId ?? null });
  }

  /** The users and workspaces under an active hold. */
  async held(tenantId: string): Promise<Held> {
    const rows = (await this.db('legal_holds').where({ tenant_id: tenantId, state: 'active' }).select('scope', 'scope_id')) as { scope: HoldScope; scope_id: string }[];
    return { users: rows.filter((r) => r.scope === 'user').map((r) => r.scope_id), workspaces: rows.filter((r) => r.scope === 'workspace').map((r) => r.scope_id) };
  }

  /** Whether a user (or their workspace) is under an active hold. */
  async isHeld(tenantId: string, who: { userId?: string | null; workspaceId?: string | null }): Promise<boolean> {
    const h = await this.held(tenantId);
    return (!!who.userId && h.users.includes(who.userId)) || (!!who.workspaceId && h.workspaces.includes(who.workspaceId));
  }

  /** Other holders of `compliance:manage` in the tenant, who may approve a request. */
  async approvers(p: Principal): Promise<{ userId: string; displayName: string; username: string }[]> {
    const s = this.s();
    const ids = (await s.notifications.usersWithRoles(p.tenantId, rolesGranting('compliance:manage', p.tenantId))).filter((id) => id !== p.userId);
    if (!ids.length) return [];
    const rows = (await this.db('users').where({ tenant_id: p.tenantId }).whereIn('id', ids).select('id', 'display_name', 'username')) as { id: string; display_name: string; username: string }[];
    return rows.map((u) => ({ userId: u.id, displayName: u.display_name, username: u.username })).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  private async names(tenantId: string, ids: (string | null)[]): Promise<Map<string, { displayName: string; username: string }>> {
    const want = [...new Set(ids.filter((x): x is string => !!x))];
    if (!want.length) return new Map();
    const rows = (await this.db('users').where({ tenant_id: tenantId }).whereIn('id', want).select('id', 'display_name', 'username')) as { id: string; display_name: string; username: string }[];
    return new Map(rows.map((u) => [u.id, { displayName: u.display_name, username: u.username }]));
  }

  private async view(h: HoldRow, who?: Map<string, { displayName: string; username: string }>) {
    const s = this.s();
    const names = who ?? (await this.names(h.tenant_id, [h.requested_by, h.approver_id, h.decided_by, h.released_by, h.scope === 'user' ? h.scope_id : null]));
    const subject = h.scope === 'user' ? (names.get(h.scope_id)?.displayName ?? h.scope_id) : ((await s.tenants.workspace(h.tenant_id, h.scope_id))?.name ?? h.scope_id);
    const person = (id: string | null) => (id ? { id, displayName: names.get(id)?.displayName ?? null, username: names.get(id)?.username ?? null } : null);
    return {
      id: h.id,
      scope: h.scope,
      scopeId: h.scope_id,
      subject,
      reason: await s.keys.open(h.tenant_id, h.reason, `legal-hold:${h.id}`),
      state: h.state,
      requestedBy: person(h.requested_by),
      approver: person(h.approver_id),
      decidedBy: person(h.decided_by),
      decidedAt: h.decided_at,
      releasedBy: person(h.released_by),
      releasedAt: h.released_at,
      note: h.note,
      createdAt: h.created_at,
      updatedAt: h.updated_at
    };
  }

  async list(p: Principal) {
    const rows = ((await this.db('legal_holds').where({ tenant_id: p.tenantId }).orderBy('created_at', 'desc').limit(500)) as Record<string, unknown>[]).map(holdFrom);
    const who = await this.names(p.tenantId, rows.flatMap((h) => [h.requested_by, h.approver_id, h.decided_by, h.released_by, h.scope === 'user' ? h.scope_id : null]));
    return Promise.all(rows.map((h) => this.view(h, who)));
  }

  private async row(tenantId: string, id: string): Promise<HoldRow> {
    const r = await this.db('legal_holds').where({ tenant_id: tenantId, id }).first();
    if (!r) throw notFound('Legal hold');
    return holdFrom(r);
  }

  async get(p: Principal, id: string) {
    return this.view(await this.row(p.tenantId, id));
  }

  /** Asks for a hold; nothing is suspended until the approver, another holder of `compliance:manage`, approves. */
  async request(ctx: HoldCtx, input: { scope: HoldScope; scopeId: string; reason: string; approverId: string }) {
    const s = this.s();
    const p = ctx.p;
    if (input.approverId === p.userId) throw forbidden('Dual control: you cannot approve your own request. Name another compliance manager.', { step: 'dual-control' });
    if (!(await this.approvers(p)).some((a) => a.userId === input.approverId)) throw new HttpProblem(422, 'Not an approver', 'The approver must be another holder of compliance:manage in this tenant.', { extensions: { field: 'approverId' } });
    if (input.scope === 'user' && !(await s.users.get(p.tenantId, input.scopeId))) throw notFound('User');
    if (input.scope === 'workspace' && !(await s.tenants.workspace(p.tenantId, input.scopeId))) throw notFound('Workspace');
    if (await this.db('legal_holds').where({ tenant_id: p.tenantId, scope: input.scope, scope_id: input.scopeId }).whereIn('state', ['pending', 'active']).first('id')) throw conflict('A hold on them already exists or waits for approval.');
    const id = ulid();
    const t = Date.now();
    await this.db('legal_holds').insert({ id, tenant_id: p.tenantId, scope: input.scope, scope_id: input.scopeId, reason: await s.keys.seal(p.tenantId, input.reason, `legal-hold:${id}`), state: 'pending', requested_by: p.userId, approver_id: input.approverId, decided_by: null, decided_at: null, released_by: null, released_at: null, note: null, created_at: t, updated_at: t });
    await this.audit(ctx, 'legal_hold.requested', { hold: id, [input.scope]: input.scopeId, approver: input.approverId }, { reason: input.reason.slice(0, 500) });
    await s.notifications.notify({ tenantId: p.tenantId, userIds: [input.approverId], kind: 'compliance', title: `${p.displayName} asks you to approve a legal hold`, body: input.reason.slice(0, 300), route: 'settings', label: 'internal' });
    return this.get(p, id);
  }

  /** The approver decides: approved suspends the purges at once; rejected ends the request. */
  async decide(ctx: HoldCtx, id: string, decision: 'approved' | 'rejected', note: string | null) {
    const s = this.s();
    const p = ctx.p;
    const h = await this.row(p.tenantId, id);
    if (h.requested_by === p.userId) throw forbidden('Dual control: you cannot approve your own request. Another compliance manager must decide it.', { step: 'dual-control' });
    if (h.state !== 'pending') throw conflict(`The request was already ${h.state}.`);
    const t = Date.now();
    const n = await this.db('legal_holds').where({ id: h.id, state: 'pending' }).update({ state: decision === 'approved' ? 'active' : 'rejected', decided_by: p.userId, decided_at: t, note: note?.slice(0, 500) ?? null, updated_at: t });
    if (!n) throw conflict('The request was decided by someone else.');
    await this.audit(ctx, decision === 'approved' ? 'legal_hold.approved' : 'legal_hold.rejected', { hold: h.id, [h.scope]: h.scope_id, requestedBy: h.requested_by }, note ? { note } : undefined);
    await s.notifications.notify({ tenantId: p.tenantId, userIds: [h.requested_by], kind: 'compliance', title: decision === 'approved' ? 'Your legal hold request was approved; retention is suspended' : 'Your legal hold request was rejected', body: note ?? '', route: 'settings', label: 'internal' });
    return this.get(p, id);
  }

  async withdraw(ctx: HoldCtx, id: string) {
    const h = await this.row(ctx.p.tenantId, id);
    if (h.requested_by !== ctx.p.userId) throw forbidden('Only the person who asked for a hold can withdraw the request.', { step: 'owner' });
    if (h.state !== 'pending') throw conflict(`The request was already ${h.state}.`);
    await this.db('legal_holds').where({ id: h.id, state: 'pending' }).update({ state: 'withdrawn', updated_at: Date.now() });
    await this.audit(ctx, 'legal_hold.withdrawn', { hold: h.id, [h.scope]: h.scope_id });
    return this.get(ctx.p, id);
  }

  /** Ends an active hold: the next purge treats the content as before. */
  async release(ctx: HoldCtx, id: string, note: string | null) {
    const h = await this.row(ctx.p.tenantId, id);
    if (h.state !== 'active') throw conflict(`The hold is ${h.state}, not active.`);
    const t = Date.now();
    await this.db('legal_holds').where({ id: h.id, state: 'active' }).update({ state: 'released', released_by: ctx.p.userId, released_at: t, note: note?.slice(0, 500) ?? h.note, updated_at: t });
    await this.audit(ctx, 'legal_hold.released', { hold: h.id, [h.scope]: h.scope_id }, note ? { note } : undefined);
    return this.get(ctx.p, id);
  }
}
