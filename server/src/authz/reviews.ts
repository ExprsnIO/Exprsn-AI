import { ulid } from 'ulid';
import { actorFrom, type AuditActor } from '../audit/chain.js';
import { json } from '../db/knex.js';
import { badRequest, conflict, forbidden, notFound } from '../http/problem.js';
import { TOPICS, type RolesChangedEvent } from '../platform/bus.js';
import type { Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import { canGrant, getRole, rolesGranting } from './permissions.js';
import { effectivePermissions, type Principal } from './policy.js';

/*
 * B-3305: access reviews. A campaign certifies the direct grants in its scope (roles, workspace memberships, or both;
 * optionally only some roles, or only the members of one workspace): when it opens, every grant becomes an item, and
 * the campaign's reviewers confirm or revoke each one. A revoke removes the grant at once (roles and memberships are
 * read on every request, so it is gone on the member's next request) and tells every instance to re-decide the
 * member's socket rooms. Campaigns open on schedule, and repeat every `everyDays`; an open campaign past its due date
 * is escalated once to the holders of `roles:manage`. Every step is in the audit chain.
 *
 * Grants that come from a group mapping or the directory are not items: they are reviewed at their mapping, since a
 * removed row would come back at the next sign-in or sync. A campaign's creator must be able to grant every role in
 * its scope, and a reviewer never decides their own grant.
 */

export type ReviewState = 'scheduled' | 'open' | 'closed' | 'cancelled';
export type ItemDecision = 'pending' | 'confirmed' | 'revoked' | 'expired';
export type GrantKind = 'role' | 'workspace';

export interface ReviewScope {
  kinds: GrantKind[];
  roles: string[] | null;
  workspaceId: string | null;
}

export interface ReviewRow {
  id: string;
  tenant_id: string;
  name: string;
  state: ReviewState;
  scope: ReviewScope;
  reviewers: string[];
  opens_at: number;
  due_days: number;
  due_at: number | null;
  every_days: number | null;
  escalated_at: number | null;
  items_total: number;
  items_decided: number;
  next_id: string | null;
  created_by: string | null;
  created_at: number;
  opened_at: number | null;
  closed_at: number | null;
}

export interface ItemRow {
  id: string;
  review_id: string;
  tenant_id: string;
  user_id: string;
  kind: GrantKind;
  grant_ref: string;
  decision: ItemDecision;
  decided_by: string | null;
  decided_at: number | null;
  note: string | null;
  removed: boolean;
}

export interface ReviewInput {
  name: string;
  kinds: GrantKind[];
  roles?: string[] | null;
  workspaceId?: string | null;
  reviewerIds: string[];
  opensAt?: number | null;
  dueDays: number;
  everyDays?: number | null;
}

/** Items a campaign may hold; a larger scope is refused (narrow it by role or workspace). */
export const MAX_ITEMS = 5000;
const DAY = 86_400_000;
export const SWEEP_JOB = 'authz.reviews';

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const reviewFromRow = (r: Record<string, unknown>): ReviewRow => ({
  ...(r as unknown as ReviewRow),
  scope: json<ReviewScope>(r.scope, { kinds: ['role', 'workspace'], roles: null, workspaceId: null }),
  reviewers: json<string[]>(r.reviewers, []),
  opens_at: Number(r.opens_at),
  due_days: Number(r.due_days),
  due_at: num(r.due_at),
  every_days: num(r.every_days),
  escalated_at: num(r.escalated_at),
  items_total: Number(r.items_total),
  items_decided: Number(r.items_decided),
  created_at: Number(r.created_at),
  opened_at: num(r.opened_at),
  closed_at: num(r.closed_at)
});
const itemFromRow = (r: Record<string, unknown>): ItemRow => ({ ...(r as unknown as ItemRow), removed: !!r.removed, decided_at: num(r.decided_at) });

export const reviewView = (r: ReviewRow) => ({
  id: r.id,
  name: r.name,
  state: r.state,
  scope: r.scope,
  reviewers: r.reviewers,
  opensAt: r.opens_at,
  dueDays: r.due_days,
  dueAt: r.due_at,
  everyDays: r.every_days,
  overdue: r.state === 'open' && r.due_at != null && r.due_at < Date.now(),
  escalatedAt: r.escalated_at,
  counts: { total: r.items_total, decided: r.items_decided },
  nextId: r.next_id,
  createdBy: r.created_by,
  createdAt: r.created_at,
  openedAt: r.opened_at,
  closedAt: r.closed_at
});

const SYSTEM: AuditActor = { service: 'access-reviews' };

export class AccessReviewService {
  constructor(private readonly s: () => Services) {}

  registerJobs(): void {
    this.s().jobs.register(SWEEP_JOB, async (p, ctx) => this.sweep(String(p.tenantId ?? ctx.job.tenant_id)));
  }

  /** Every five minutes per active tenant: open what is due, escalate what is overdue. */
  schedule(scheduler: Scheduler): void {
    const s = this.s();
    scheduler.every(SWEEP_JOB, 5 * 60_000, async () => {
      const due = (await s.db('access_reviews').whereIn('state', ['scheduled', 'open']).distinct('tenant_id')) as { tenant_id: string }[];
      return due.map((r) => ({ tenantId: r.tenant_id, payload: { tenantId: r.tenant_id } }));
    });
  }

  private audit(tenantId: string, actor: AuditActor, action: string, target: Record<string, unknown>, detail: Record<string, unknown>, traceId?: string | null) {
    return this.s().audit.append({ tenantId, action, kind: actor.service ? 'system' : 'admin', actor, target, detail, traceId: traceId ?? null });
  }

  async list(p: Principal, opts: { state?: ReviewState; limit: number; offset: number }): Promise<ReviewRow[]> {
    const q = this.s().db('access_reviews').where({ tenant_id: p.tenantId }).orderBy('created_at', 'desc').limit(opts.limit).offset(opts.offset);
    if (opts.state) q.andWhere({ state: opts.state });
    const rows = ((await q) as Record<string, unknown>[]).map(reviewFromRow);
    return this.manages(p) ? rows : rows.filter((r) => r.reviewers.includes(p.userId));
  }

  private manages(p: Principal): boolean {
    return effectivePermissions(p).has('roles:manage');
  }

  async get(tenantId: string, id: string): Promise<ReviewRow> {
    const r = await this.s().db('access_reviews').where({ tenant_id: tenantId, id }).first();
    if (!r) throw notFound('Access review');
    return reviewFromRow(r);
  }

  /** A campaign the caller manages or reviews (anyone else gets 404). */
  async visible(p: Principal, id: string): Promise<ReviewRow> {
    const r = await this.get(p.tenantId, id);
    if (!this.manages(p) && !r.reviewers.includes(p.userId)) throw notFound('Access review');
    return r;
  }

  async items(r: ReviewRow, opts: { decision?: ItemDecision; limit: number; offset: number }) {
    const s = this.s();
    const q = s.db('access_review_items').where({ review_id: r.id }).orderBy(['user_id', 'kind', 'grant_ref']).limit(opts.limit).offset(opts.offset);
    if (opts.decision) q.andWhere({ decision: opts.decision });
    const rows = ((await q) as Record<string, unknown>[]).map(itemFromRow);
    const users = new Map(((await s.db('users').whereIn('id', [...new Set(rows.map((i) => i.user_id))]).select('id', 'username', 'display_name')) as { id: string; username: string; display_name: string }[]).map((u) => [u.id, u]));
    const ws = new Map((await s.tenants.workspaces(r.tenant_id, { includeArchived: true })).map((w) => [w.id, w.name]));
    return rows.map((i) => ({
      id: i.id,
      user: { id: i.user_id, username: users.get(i.user_id)?.username ?? null, displayName: users.get(i.user_id)?.display_name ?? null },
      kind: i.kind,
      grant: { id: i.grant_ref, name: i.kind === 'role' ? (getRole(i.grant_ref, r.tenant_id)?.name ?? i.grant_ref) : (ws.get(i.grant_ref) ?? i.grant_ref) },
      decision: i.decision,
      decidedBy: i.decided_by,
      decidedAt: i.decided_at,
      note: i.note,
      removed: i.removed
    }));
  }

  async create(p: Principal, input: ReviewInput, ip: string | null, traceId?: string): Promise<ReviewRow> {
    const s = this.s();
    const kinds = [...new Set(input.kinds)];
    if (!kinds.length) throw badRequest('Choose roles, workspace memberships or both.');
    const roles = input.roles?.length ? [...new Set(input.roles)] : null;
    for (const role of roles ?? []) {
      if (!getRole(role, p.tenantId)) throw badRequest(`There is no role ${role}.`);
      if (!canGrant(p.roles, role, p.tenantId)) throw forbidden(`Your roles cannot grant ${role}, so you cannot review it.`, { step: 'role' });
    }
    if (input.workspaceId && !(await s.tenants.workspace(p.tenantId, input.workspaceId))) throw notFound('Workspace');
    const reviewers = [...new Set(input.reviewerIds)];
    const found = (await s.db('users').where({ tenant_id: p.tenantId, state: 'active' }).whereIn('id', reviewers).select('id')) as { id: string }[];
    if (found.length !== reviewers.length) throw badRequest('Every reviewer must be an active user of this tenant.');
    const now = Date.now();
    const row = {
      id: ulid(),
      tenant_id: p.tenantId,
      name: input.name.trim(),
      state: 'scheduled',
      scope: JSON.stringify({ kinds, roles, workspaceId: input.workspaceId ?? null } satisfies ReviewScope),
      reviewers: JSON.stringify(reviewers),
      opens_at: input.opensAt ?? now,
      due_days: input.dueDays,
      due_at: null,
      every_days: input.everyDays ?? null,
      escalated_at: null,
      items_total: 0,
      items_decided: 0,
      next_id: null,
      created_by: p.userId,
      created_at: now,
      opened_at: null,
      closed_at: null
    };
    await s.db('access_reviews').insert(row);
    await this.audit(p.tenantId, actorFrom(p, ip), 'authz.review.created', { review: row.id, name: row.name }, { scope: json(row.scope, {}), reviewers, opensAt: row.opens_at, dueDays: row.due_days, everyDays: row.every_days }, traceId);
    const r = reviewFromRow(row);
    return r.opens_at <= now ? this.open(r, actorFrom(p, ip), traceId) : r;
  }

  /** The roles a campaign covers: those named, else every role its creator may grant (built-in and custom). */
  private reviewableRoles(r: ReviewRow, creatorRoles: string[]): (role: string) => boolean {
    if (r.scope.roles) return (role) => r.scope.roles!.includes(role);
    return (role) => canGrant(creatorRoles, role, r.tenant_id);
  }

  /** Snapshots the grants in scope as items and tells the reviewers. */
  async open(r: ReviewRow, actor: AuditActor, traceId?: string): Promise<ReviewRow> {
    const s = this.s();
    if (r.state !== 'scheduled') throw conflict(`The review is ${r.state}.`);
    const creatorRoles = r.created_by ? await s.users.roleIds(r.created_by) : [];
    const inScope = this.reviewableRoles(r, creatorRoles);
    const users = s.db('users').where({ tenant_id: r.tenant_id, state: 'active' }).select('id');
    const members = r.scope.workspaceId ? s.db('workspace_members').where({ workspace_id: r.scope.workspaceId }).select('user_id') : null;
    const grants: { user_id: string; kind: GrantKind; grant_ref: string }[] = [];
    if (r.scope.kinds.includes('role')) {
      const q = s.db('user_roles').whereIn('user_id', users).where({ source: 'direct' }).select('user_id', 'role');
      if (members) q.whereIn('user_id', members);
      for (const g of (await q) as { user_id: string; role: string }[]) if (inScope(g.role)) grants.push({ user_id: g.user_id, kind: 'role', grant_ref: g.role });
    }
    if (r.scope.kinds.includes('workspace')) {
      const ws = (await s.tenants.workspaces(r.tenant_id)).map((w) => w.id);
      const q = s.db('workspace_members').whereIn('user_id', users).where({ source: 'direct' }).whereIn('workspace_id', r.scope.workspaceId ? [r.scope.workspaceId] : ws).distinct('user_id', 'workspace_id');
      for (const g of (await q) as { user_id: string; workspace_id: string }[]) grants.push({ user_id: g.user_id, kind: 'workspace', grant_ref: g.workspace_id });
    }
    if (grants.length > MAX_ITEMS) throw conflict(`The review would hold ${grants.length} grants; at most ${MAX_ITEMS}. Narrow it to some roles or one workspace.`);
    const now = Date.now();
    const dueAt = now + r.due_days * DAY;
    await s.db.transaction(async (trx) => {
      const n = await trx('access_reviews').where({ id: r.id, state: 'scheduled' }).update({ state: 'open', opened_at: now, due_at: dueAt, items_total: grants.length, items_decided: 0 });
      if (!n) throw conflict('The review was opened by someone else.');
      for (let i = 0; i < grants.length; i += 200) {
        await trx('access_review_items').insert(grants.slice(i, i + 200).map((g) => ({ id: ulid(), review_id: r.id, tenant_id: r.tenant_id, ...g, decision: 'pending', decided_by: null, decided_at: null, note: null, removed: false })));
      }
    });
    await this.audit(r.tenant_id, actor, 'authz.review.opened', { review: r.id, name: r.name }, { items: grants.length, dueAt }, traceId);
    if (r.reviewers.length) {
      await s.notifications
        .notify({ tenantId: r.tenant_id, userIds: r.reviewers, kind: 'authz.review.opened', title: `Access review: ${r.name}`, body: `${grants.length} grants to confirm or revoke by ${new Date(dueAt).toISOString().slice(0, 10)}.`, route: 'roles', label: 'internal', email: true })
        .catch((err: unknown) => s.log.warn({ err }, 'access review notice failed'));
    }
    const opened = await this.get(r.tenant_id, r.id);
    return grants.length ? opened : this.close(opened, actor, traceId);
  }

  /** A reviewer confirms or revokes one grant. A revoke takes the grant away at once. */
  async decide(p: Principal, reviewId: string, itemId: string, decision: 'confirm' | 'revoke', note: string | null, ip: string | null, traceId?: string) {
    const s = this.s();
    const r = await this.visible(p, reviewId);
    if (!r.reviewers.includes(p.userId)) throw forbidden('Only the reviewers of this campaign decide its grants.', { step: 'reviewer' });
    if (r.state !== 'open') throw conflict(`The review is ${r.state}.`);
    const row = await s.db('access_review_items').where({ review_id: r.id, id: itemId }).first();
    if (!row) throw notFound('Review item');
    const item = itemFromRow(row);
    if (item.user_id === p.userId) throw forbidden('You cannot review your own access. Another reviewer must decide it.', { step: 'self' });
    if (item.decision !== 'pending') throw conflict(`This grant was already ${item.decision}.`);
    let removed = false;
    if (decision === 'revoke') removed = await this.removeGrant(item);
    const n = await s.db('access_review_items').where({ id: item.id, decision: 'pending' }).update({ decision: decision === 'confirm' ? 'confirmed' : 'revoked', decided_by: p.userId, decided_at: Date.now(), note, removed });
    if (!n) throw conflict('Someone else decided this grant.');
    await s.db('access_reviews').where({ id: r.id }).increment('items_decided', 1);
    await this.audit(p.tenantId, actorFrom(p, ip), decision === 'confirm' ? 'authz.review.confirmed' : 'authz.review.revoked', { review: r.id, item: item.id, user: item.user_id, kind: item.kind, grant: item.grant_ref }, { note, removed }, traceId);
    if (removed) s.bus.publish(TOPICS.rolesChanged, { tenantId: r.tenant_id, userIds: [item.user_id] } satisfies RolesChangedEvent);
    const after = await this.get(p.tenantId, r.id);
    if (after.items_decided >= after.items_total && after.state === 'open') await this.close(after, actorFrom(p, ip), traceId);
    return (await s.db('access_review_items').where({ id: item.id }).first().then((x: Record<string, unknown>) => itemFromRow(x)));
  }

  /** Removes a direct grant; false when it was already gone. */
  private async removeGrant(item: ItemRow): Promise<boolean> {
    const users = this.s().users;
    if (item.kind === 'role') {
      const direct = (await users.roles(item.user_id)).filter((x) => x.source === 'direct').map((x) => x.role);
      if (!direct.includes(item.grant_ref)) return false;
      await users.setRoles(item.user_id, 'direct', direct.filter((x) => x !== item.grant_ref));
      return true;
    }
    const direct = ((await this.s().db('workspace_members').where({ user_id: item.user_id, source: 'direct' }).select('workspace_id')) as { workspace_id: string }[]).map((x) => x.workspace_id);
    if (!direct.includes(item.grant_ref)) return false;
    await users.setWorkspaceMemberships(item.user_id, 'direct', direct.filter((x) => x !== item.grant_ref));
    return true;
  }

  /** Closes a campaign (undecided grants expire and stay as they are) and schedules the next one when it repeats. */
  async close(r: ReviewRow, actor: AuditActor, traceId?: string): Promise<ReviewRow> {
    const s = this.s();
    if (r.state === 'closed' || r.state === 'cancelled') throw conflict(`The review is ${r.state}.`);
    const state: ReviewState = r.state === 'scheduled' ? 'cancelled' : 'closed';
    const now = Date.now();
    const next = r.every_days && state === 'closed' ? ulid() : null;
    await s.db.transaction(async (trx) => {
      const n = await trx('access_reviews').where({ id: r.id }).whereIn('state', ['scheduled', 'open']).update({ state, closed_at: now, next_id: next });
      if (!n) throw conflict('The review was closed by someone else.');
      await trx('access_review_items').where({ review_id: r.id, decision: 'pending' }).update({ decision: 'expired' });
      if (next) {
        await trx('access_reviews').insert({ id: next, tenant_id: r.tenant_id, name: r.name, state: 'scheduled', scope: JSON.stringify(r.scope), reviewers: JSON.stringify(r.reviewers), opens_at: (r.opened_at ?? now) + r.every_days! * DAY, due_days: r.due_days, due_at: null, every_days: r.every_days, escalated_at: null, items_total: 0, items_decided: 0, next_id: null, created_by: r.created_by, created_at: now, opened_at: null, closed_at: null });
      }
    });
    const counts = (await s.db('access_review_items').where({ review_id: r.id }).groupBy('decision').select('decision').count({ n: '*' })) as { decision: string; n: number | string }[];
    await this.audit(r.tenant_id, actor, state === 'closed' ? 'authz.review.closed' : 'authz.review.cancelled', { review: r.id, name: r.name }, { decisions: Object.fromEntries(counts.map((c) => [c.decision, Number(c.n)])), next }, traceId);
    return this.get(r.tenant_id, r.id);
  }

  /** Opens campaigns that are due and escalates open ones past their due date (once). */
  async sweep(tenantId: string, now = Date.now()): Promise<{ opened: number; escalated: number }> {
    const s = this.s();
    let opened = 0;
    let escalated = 0;
    const due = ((await s.db('access_reviews').where({ tenant_id: tenantId, state: 'scheduled' }).andWhere('opens_at', '<=', now)) as Record<string, unknown>[]).map(reviewFromRow);
    for (const r of due) {
      try {
        await this.open(r, SYSTEM);
        opened++;
      } catch (err) {
        s.log.warn({ err, review: r.id }, 'access review did not open');
      }
    }
    const overdue = ((await s.db('access_reviews').where({ tenant_id: tenantId, state: 'open' }).whereNull('escalated_at').andWhere('due_at', '<', now)) as Record<string, unknown>[]).map(reviewFromRow);
    for (const r of overdue) {
      const n = await s.db('access_reviews').where({ id: r.id }).whereNull('escalated_at').update({ escalated_at: now });
      if (!n) continue;
      escalated++;
      const pending = r.items_total - r.items_decided;
      const admins = await s.notifications.usersWithRoles(tenantId, rolesGranting('roles:manage', tenantId));
      const to = [...new Set([...admins, ...r.reviewers])];
      await this.audit(tenantId, SYSTEM, 'authz.review.escalated', { review: r.id, name: r.name }, { pending, dueAt: r.due_at, notified: to.length });
      if (to.length) {
        await s.notifications
          .notify({ tenantId, userIds: to, kind: 'authz.review.overdue', title: `Access review overdue: ${r.name}`, body: `${pending} grants are still undecided.`, route: 'roles', label: 'internal', email: true })
          .catch((err: unknown) => s.log.warn({ err }, 'access review escalation notice failed'));
      }
    }
    return { opened, escalated };
  }
}
