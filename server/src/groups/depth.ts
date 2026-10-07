import { ulid } from 'ulid';
import { actorFrom, isUniqueViolation } from '../audit/chain.js';
import { clears, isLabel, LABELS, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { conflict, HttpProblem, notFound } from '../http/problem.js';
import type { Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import type { Near } from './geo.js';
import { groupFrom, type Ctx } from './service.js';

/*
 * Groups depth (1.6.0, B-44): the tenant's group categories (B-4405, decision Q6), discovery of groups to join
 * (B-4402) and trending groups (B-4404). Channels (B-4401) and places (B-4403) live in `GroupService`.
 *
 * - Categories are one list per tenant, managed from Social and messaging (social:manage). A group has at most one;
 *   removing a category leaves its groups uncategorised (never hidden), in one transaction.
 * - Discovery lists the groups the viewer may join now: groups (not channels) they see, are not a member of, that are
 *   active, open or by request (or with an invitation waiting for them), and never labelled above their clearance,
 *   whatever else they may see (a groups:manage holder sees every group, but discovery is about joining). Ranked by
 *   shared members (members of the group the viewer shares another group with) and activity (posts and joins in the
 *   last DISCOVERY_DAYS).
 * - `groups.trending` (every FEED_TRENDING_MINUTES, per tenant, over the last FEED_TRENDING_HOURS, like trending
 *   hashtags) counts joins and posts per group; hidden groups, channels and groups not active do not trend. Readers see
 *   the trending groups of their workspaces they may see and are cleared for.
 */

export const GROUP_TRENDING_JOB = 'groups.trending';
export const DISCOVERY_DAYS = 30;
const TOP_PER_WORKSPACE = 50;
/** Shared members weigh three, a join two, a post one (discovery); a join three, a post one (trending). */
const W = { shared: 3, join: 2, post: 1, trendJoin: 3, trendPost: 1 };

interface CategoryRow {
  id: string;
  tenant_id: string;
  name: string;
  name_key: string;
  description: string | null;
  position: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

const categoryFrom = (r: Record<string, unknown>): CategoryRow => ({ ...(r as unknown as CategoryRow), position: Number(r.position ?? 0), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
const categoryView = (c: CategoryRow, groups?: number) => ({ id: c.id, name: c.name, description: c.description, position: c.position, createdAt: c.created_at, updatedAt: c.updated_at, ...(groups !== undefined ? { groups } : {}) });
const keyOf = (name: string) => name.trim().toLowerCase();

export class GroupDepth {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  private async audit(ctx: Ctx, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>, label?: Label): Promise<void> {
    await this.s().audit.append({ tenantId: ctx.p.tenantId, action, kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target, ...(detail ? { detail } : {}), ...(label ? { label } : {}), traceId: ctx.traceId ?? null });
  }

  registerJobs(): void {
    this.s().jobs.register(GROUP_TRENDING_JOB, async (p, ctx) => this.trendingJob(String(p.tenantId ?? ctx.job.tenant_id)));
  }

  schedule(scheduler: Scheduler, targets: () => Promise<{ tenantId: string; payload?: Record<string, unknown> }[]>): void {
    const minutes = this.s().cfg.FEED_TRENDING_MINUTES;
    if (minutes > 0) scheduler.every(GROUP_TRENDING_JOB, minutes * 60_000, targets);
  }

  // ---------- categories (B-4405) ----------

  /** The tenant's categories in their order; with `countFor`, how many groups (not channels) the caller may count in each. */
  async categories(tenantId: string, countFor?: Principal) {
    const rows = ((await this.db('group_categories').where({ tenant_id: tenantId }).orderBy([{ column: 'position' }, { column: 'name_key' }])) as Record<string, unknown>[]).map(categoryFrom);
    if (!countFor) return rows.map((c) => categoryView(c));
    const labels = LABELS.filter((l) => clears(countFor.clearance, l));
    const counts = (await this.db('social_groups').where({ tenant_id: tenantId }).whereNull('parent_id').whereNot({ state: 'deleted' }).whereIn('label', labels).groupBy('category_id').select('category_id').count({ n: '*' })) as { category_id: string | null; n: number | string }[];
    const by = new Map(counts.map((r) => [r.category_id ?? '', Number(r.n)]));
    return { categories: rows.map((c) => categoryView(c, by.get(c.id) ?? 0)), uncategorised: by.get('') ?? 0 };
  }

  /** A category of the tenant, or 422 (as a field of a group). */
  async category(tenantId: string, id: string): Promise<CategoryRow> {
    const r = await this.db('group_categories').where({ tenant_id: tenantId, id }).first();
    if (!r) throw new HttpProblem(422, 'Unknown category', 'There is no such group category in this tenant.', { extensions: { step: 'category' } });
    return categoryFrom(r);
  }

  async createCategory(ctx: Ctx, input: { name: string; description?: string | null | undefined; position?: number | undefined }) {
    const t = Date.now();
    const position = input.position ?? Number(((await this.db('group_categories').where({ tenant_id: ctx.p.tenantId }).max({ m: 'position' })) as { m: number | string | null }[])[0]?.m ?? -1) + 1;
    const row: CategoryRow = { id: ulid(), tenant_id: ctx.p.tenantId, name: input.name.trim(), name_key: keyOf(input.name), description: input.description?.trim() || null, position, created_by: ctx.p.userId, created_at: t, updated_at: t };
    try {
      await this.db('group_categories').insert(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`There is already a category named ${row.name}.`);
      throw err;
    }
    await this.audit(ctx, 'group.category.created', { category: row.id }, { name: row.name });
    return categoryView(row, 0);
  }

  async updateCategory(ctx: Ctx, id: string, patch: { name?: string | undefined; description?: string | null | undefined; position?: number | undefined }) {
    const before = await this.db('group_categories').where({ tenant_id: ctx.p.tenantId, id }).first();
    if (!before) throw notFound('Category');
    const b = categoryFrom(before);
    const upd: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.name !== undefined) Object.assign(upd, { name: patch.name.trim(), name_key: keyOf(patch.name) });
    if (patch.description !== undefined) upd.description = patch.description?.trim() || null;
    if (patch.position !== undefined) upd.position = patch.position;
    try {
      await this.db('group_categories').where({ tenant_id: ctx.p.tenantId, id }).update(upd);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`There is already a category named ${String(upd.name)}.`);
      throw err;
    }
    const after = categoryFrom((await this.db('group_categories').where({ id }).first())!);
    await this.audit(ctx, 'group.category.updated', { category: id }, { before: { name: b.name, position: b.position }, after: { name: after.name, position: after.position } });
    return categoryView(after);
  }

  /** Removes a category; its groups stay, uncategorised (B-4405's done-when). */
  async removeCategory(ctx: Ctx, id: string) {
    const before = await this.db('group_categories').where({ tenant_id: ctx.p.tenantId, id }).first();
    if (!before) throw notFound('Category');
    let uncategorised = 0;
    await this.db.transaction(async (trx) => {
      uncategorised = await trx('social_groups').where({ tenant_id: ctx.p.tenantId, category_id: id }).update({ category_id: null });
      await trx('group_categories').where({ tenant_id: ctx.p.tenantId, id }).delete();
    });
    await this.audit(ctx, 'group.category.removed', { category: id }, { name: String(before.name), uncategorised });
    return { id, removed: true as const, uncategorised };
  }

  // ---------- discovery (B-4402) ----------

  async discover(p: Principal, q: { workspaceId?: string | null; category?: string | null; near?: Near | null; limit?: number | undefined }) {
    const groups = this.s().groups;
    const seen = await groups.list(p, { workspaceId: q.workspaceId ?? null, category: q.category ?? null, near: q.near ?? null });
    const invited = new Set(((await this.db('group_requests').where({ tenant_id: p.tenantId, user_id: p.userId, kind: 'invite', state: 'pending' }).andWhere('expires_at', '>', Date.now()).select('group_id')) as { group_id: string }[]).map((r) => r.group_id));
    const requested = new Set(((await this.db('group_requests').where({ tenant_id: p.tenantId, user_id: p.userId, kind: 'request', state: 'pending' }).andWhere('expires_at', '>', Date.now()).select('group_id')) as { group_id: string }[]).map((r) => r.group_id));
    // Joinable now, and never above the viewer's clearance (a manager may see such a group, but cannot join it).
    const open = seen.filter((g) => !g.role && g.state === 'active' && clears(p.clearance, g.label) && (g.joinMode !== 'invite' || invited.has(g.id)));
    const ids = open.map((g) => g.id);
    const since = Date.now() - DISCOVERY_DAYS * 86_400_000;
    const shared = new Map<string, number>();
    const posts = new Map<string, number>();
    const joins = new Map<string, number>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      // People the viewer shares a group (or channel) with.
      const mine = this.db('group_members').where({ tenant_id: p.tenantId, user_id: p.userId }).select('group_id');
      const coMembers = this.db('group_members').whereIn('group_id', mine).whereNot({ user_id: p.userId }).select('user_id');
      const [s1, p1, j1] = await Promise.all([
        this.db('group_members').whereIn('group_id', chunk).whereIn('user_id', coMembers).groupBy('group_id').select('group_id').countDistinct({ n: 'user_id' }) as Promise<{ group_id: string; n: number | string }[]>,
        this.db('group_posts').whereIn('group_id', chunk).andWhere({ state: 'published' }).andWhere('created_at', '>=', since).groupBy('group_id').select('group_id').count({ n: '*' }) as Promise<{ group_id: string; n: number | string }[]>,
        this.db('group_members').whereIn('group_id', chunk).andWhere('joined_at', '>=', since).groupBy('group_id').select('group_id').count({ n: '*' }) as Promise<{ group_id: string; n: number | string }[]>
      ]);
      for (const r of s1) shared.set(r.group_id, Number(r.n));
      for (const r of p1) posts.set(r.group_id, Number(r.n));
      for (const r of j1) joins.set(r.group_id, Number(r.n));
    }
    const ranked = open.map((g) => {
      const sm = shared.get(g.id) ?? 0;
      const activity = { posts: posts.get(g.id) ?? 0, joins: joins.get(g.id) ?? 0 };
      return { ...g, sharedMembers: sm, activity, score: W.shared * sm + W.join * activity.joins + W.post * activity.posts, invited: invited.has(g.id), requested: requested.has(g.id) };
    });
    // With a distance filter the nearest come first; otherwise the best ranked.
    if (!q.near) ranked.sort((a, b) => b.score - a.score || (b.members ?? 0) - (a.members ?? 0) || a.name.localeCompare(b.name));
    return { groups: ranked.slice(0, q.limit ?? 50), windowDays: DISCOVERY_DAYS, total: ranked.length };
  }

  // ---------- trending (B-4404) ----------

  async trendingJob(tenantId: string): Promise<{ workspaces: number; groups: number }> {
    const now = Date.now();
    const since = now - this.s().cfg.FEED_TRENDING_HOURS * 3_600_000;
    const live = (q: ReturnType<Services['db']>) => q.where({ 'g.tenant_id': tenantId, 'g.state': 'active' }).whereNull('g.parent_id').whereNot({ 'g.visibility': 'hidden' });
    const [joinRows, postRows] = await Promise.all([
      live(this.db('group_members as m').join('social_groups as g', 'g.id', 'm.group_id')).andWhere('m.joined_at', '>=', since).groupBy('g.id', 'g.workspace_id', 'g.label').select('g.id', 'g.workspace_id', 'g.label').count({ n: '*' }) as Promise<{ id: string; workspace_id: string; label: string; n: number | string }[]>,
      live(this.db('group_posts as x').join('social_groups as g', 'g.id', 'x.group_id')).andWhere({ 'x.state': 'published' }).andWhere('x.created_at', '>=', since).groupBy('g.id', 'g.workspace_id', 'g.label').select('g.id', 'g.workspace_id', 'g.label').count({ n: '*' }) as Promise<{ id: string; workspace_id: string; label: string; n: number | string }[]>
    ]);
    type Count = { group_id: string; workspace_id: string; label: string; joins: number; posts: number };
    const by = new Map<string, Count>();
    for (const r of joinRows) by.set(r.id, { group_id: r.id, workspace_id: r.workspace_id, label: r.label, joins: Number(r.n), posts: 0 });
    for (const r of postRows) {
      const e = by.get(r.id) ?? { group_id: r.id, workspace_id: r.workspace_id, label: r.label, joins: 0, posts: 0 };
      e.posts = Number(r.n);
      by.set(r.id, e);
    }
    const perWs = new Map<string, Count[]>();
    for (const e of by.values()) perWs.set(e.workspace_id, [...(perWs.get(e.workspace_id) ?? []), e]);
    const keep: Record<string, unknown>[] = [];
    for (const list of perWs.values()) {
      const scored = list.map((e) => ({ ...e, score: W.trendJoin * e.joins + W.trendPost * e.posts })).filter((e) => e.score > 0);
      scored.sort((a, b) => b.score - a.score || b.joins - a.joins || a.group_id.localeCompare(b.group_id));
      for (const e of scored.slice(0, TOP_PER_WORKSPACE)) keep.push({ tenant_id: tenantId, workspace_id: e.workspace_id, group_id: e.group_id, label: isLabel(e.label) ? e.label : 'restricted', joins: e.joins, posts: e.posts, score: e.score, window_start: since, computed_at: now });
    }
    await this.db.transaction(async (trx) => {
      await trx('group_trending').where({ tenant_id: tenantId }).delete();
      for (let i = 0; i < keep.length; i += 200) await trx('group_trending').insert(keep.slice(i, i + 200));
    });
    return { workspaces: perWs.size, groups: keep.length };
  }

  /** The trending groups of the caller's workspaces (or one), those they may see now and are cleared for. */
  async trending(p: Principal, q: { workspaceId?: string | null; category?: string | null; limit?: number | undefined }) {
    const groups = this.s().groups;
    const ws = await groups.workspaceIds(p);
    const scope = q.workspaceId ? ws.filter((w) => w === q.workspaceId) : ws;
    const empty = { groups: [] as unknown[], computedAt: null as number | null, windowStart: null as number | null, hours: this.s().cfg.FEED_TRENDING_HOURS };
    if (!scope.length) return empty;
    const labels = LABELS.filter((l) => clears(p.clearance, l));
    const rows = (await this.db('group_trending as t')
      .join('social_groups as g', 'g.id', 't.group_id')
      .where({ 't.tenant_id': p.tenantId, 'g.state': 'active' })
      .whereIn('t.workspace_id', scope)
      .whereIn('g.label', labels)
      .modify((qb) => {
        if (q.category === 'none') qb.whereNull('g.category_id');
        else if (q.category) qb.andWhere({ 'g.category_id': q.category });
      })
      .orderBy([{ column: 't.score', order: 'desc' }, { column: 't.joins', order: 'desc' }])
      .limit(200)
      .select('g.*', 't.joins as t_joins', 't.posts as t_posts', 't.score as t_score', 't.computed_at as t_computed', 't.window_start as t_window')) as Record<string, unknown>[];
    const counts = await groups.memberCounts(rows.map((r) => String(r.id)));
    const out = [];
    for (const r of rows) {
      if (out.length >= (q.limit ?? 20)) break;
      const g = groupFrom(r);
      const a = await groups.accessOrNull(p, g.id, ws, g);
      if (!a?.see || !clears(p.clearance, g.label)) continue;
      out.push({ ...(await groups.present(g, a, { members: counts.get(g.id) ?? 0 })), trend: { joins: Number(r.t_joins), posts: Number(r.t_posts), score: Number(r.t_score) } });
    }
    const first = rows[0];
    return { groups: out, computedAt: first ? Number(first.t_computed) : null, windowStart: first ? Number(first.t_window) : null, hours: this.s().cfg.FEED_TRENDING_HOURS };
  }

  /** Recounts the tenant's trending groups now (Social and messaging). */
  async runTrending(ctx: Ctx): Promise<{ jobId: string }> {
    const job = await this.s().jobs.enqueue({ tenantId: ctx.p.tenantId, type: GROUP_TRENDING_JOB, payload: { tenantId: ctx.p.tenantId }, createdBy: ctx.p.userId, dedupeKey: `${GROUP_TRENDING_JOB}:${ctx.p.tenantId}:manual:${Math.floor(Date.now() / 60_000)}`, maxAttempts: 1 });
    await this.audit(ctx, 'group.trending.requested', { job: job.id });
    return { jobId: job.id };
  }
}
