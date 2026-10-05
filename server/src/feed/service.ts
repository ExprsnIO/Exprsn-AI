import type { Knex } from 'knex';
import { ulid } from 'ulid';
import { actorFrom, isUniqueViolation } from '../audit/chain.js';
import { clears, highest, isLabel, LABELS, labelRank, type Label } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { flagRef } from '../guardrails/flags.js';
import type { GuardDecision } from '../guardrails/types.js';
import { workspacesFor } from '../http/middleware.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { TOPICS, type IntegrationEvent } from '../platform/bus.js';
import type { Workspace } from '../repos/tenants.js';
import type { Services } from '../services.js';
import { FeedDigests } from './digest.js';
import { extractTags, normaliseTag } from './tags.js';

/*
 * The workspace feed (B-2701 to B-2704): a feed for a workspace or a group, not a public social network. Workspace
 * membership stays the outer boundary, as for groups and files: every read starts from the workspaces the caller may
 * act in now and their clearance.
 *
 * - A post belongs to one workspace, and may be targeted at a group of that workspace (the group feed). Group posts of
 *   Sprint 27 (`group_posts`, B-2505) stay as they are: the group's short notices with their own routes; the group
 *   feed is made of feed posts targeted at the group, with the group's rights (read to see it, post to write in it,
 *   moderate to remove posts and comments). There is one feed, and one notice board.
 * - Bodies and comments are sealed with the tenant key. A post's label is the high-water mark of what it carries: the
 *   label asked for (default internal, never above the workspace ceiling or the author's clearance), its media (files
 *   from the file store that passed quarantine), and the group's label for a group post. A repost carries the
 *   original's label and stays in the original's workspace and group, so it never widens the audience.
 * - Relations come from the shared social module (030b): a block (either way) hides posts, comments and reposts in
 *   every feed and refuses comments, reactions and reposts, as if the other person's posts did not exist; a mute
 *   takes the person's posts out of the muter's home feed only. Socket events are raised through
 *   `social.emitToRoom`, which leaves out everyone in a block with the author.
 * - Posts pass the `user-input` guardrail checkpoint before publishing (B-2704): a block refuses, a redaction is what
 *   is stored, and a hold keeps the post `held` (seen by its author only) with a hold flag in the review queue, until a
 *   reviewer approves (it is published then) or rejects it.
 */

export const POST_OBJECT = 'feed-post';
export const COMMENT_OBJECT = 'feed-comment';
export const REACTIONS = ['like', 'celebrate', 'support', 'insightful', 'funny'] as const;
export type Reaction = (typeof REACTIONS)[number];
export const MAX_MEDIA = 10;
export const PAGE_MAX = 100;

export type PostState = 'held' | 'published' | 'rejected' | 'hidden' | 'deleted';

export interface PostRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  group_id: string | null;
  author_id: string;
  body: string | null;
  label: Label;
  state: PostState;
  repost_of: string | null;
  repost_key: string | null;
  flag_id: string | null;
  created_at: number;
  updated_at: number;
  published_at: number | null;
  edited_at: number | null;
}

export interface CommentRow {
  id: string;
  tenant_id: string;
  post_id: string;
  parent_id: string | null;
  author_id: string;
  body: string;
  label: Label;
  state: 'published' | 'hidden' | 'deleted';
  created_at: number;
  updated_at: number;
}

export interface Ctx {
  p: Principal;
  ip: string | null;
  traceId?: string | null;
}

/** What the caller may read now: workspaces, groups (with whether they moderate them), clearance and rights. */
export interface Scope {
  p: Principal;
  workspaces: Map<string, Workspace>;
  groups: Map<string, { workspaceId: string; label: Label; moderate: boolean; post: boolean }>;
  labels: Label[];
  manage: boolean;
}

export interface PageQuery {
  cursor?: string | undefined;
  limit?: number | undefined;
}

const num = (v: unknown) => (v == null ? null : Number(v));
export const postFrom = (r: Record<string, unknown>): PostRow => ({
  ...(r as unknown as PostRow),
  label: isLabel(r.label) ? r.label : 'restricted',
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at),
  published_at: num(r.published_at),
  edited_at: num(r.edited_at)
});
const commentFrom = (r: Record<string, unknown>): CommentRow => ({ ...(r as unknown as CommentRow), label: isLabel(r.label) ? r.label : 'restricted', created_at: Number(r.created_at), updated_at: Number(r.updated_at) });

/** Opaque cursors: the sort key of the last item (`<time>.<id>`), base64url. */
export const encodeCursor = (t: number, id: string) => Buffer.from(`${t}.${id}`, 'utf8').toString('base64url');
export function decodeCursor(c: string | undefined): { t: number; id: string } | null {
  if (!c) return null;
  const m = /^(\d{1,16})\.([0-9A-HJKMNP-TV-Z]{26})$/.exec(Buffer.from(c, 'base64url').toString('utf8'));
  if (!m) throw badRequest('The cursor is not one this server gave out.');
  return { t: Number(m[1]), id: m[2]! };
}

const DELETED_POST = 'The post was deleted; it takes no comments, reactions or reposts.';

export class FeedService {
  private started = false;
  /** Trending tags and weekly digests (B-2705). */
  readonly digests: FeedDigests;

  constructor(private readonly s: () => Services) {
    this.digests = new FeedDigests(s);
  }

  private get db() {
    return this.s().db;
  }

  private get cfg() {
    return this.s().cfg;
  }

  // ---------- wiring ----------

  /** Registers the feed room authoriser (B-2101) and posts and comments as moderation object types (B-1902). */
  init(): void {
    if (this.started) return;
    this.started = true;
    const s = this.s();
    s.rooms.register('feed', async (p, id) => {
      if (!effectivePermissions(p).has('feed:read')) return null;
      // The caller's own home room: posts from the people they follow.
      if (id === p.userId) return { label: 'public', workspaceId: null };
      const ws = await workspacesFor(s, p);
      // A workspace feed: events carry ids only, and leave out people below the post's label (see `deliver`).
      if (ws.some((w) => w.id === id)) return { label: 'public', workspaceId: id };
      const a = await s.groups.accessOrNull(p, id, ws.map((w) => w.id));
      return a?.read ? { label: a.group.label, workspaceId: a.group.workspace_id } : null;
    });
    this.registerModeration();
  }

  private async audit(ctx: Ctx, action: string, target: Record<string, unknown>, detail: Record<string, unknown> | undefined, label: Label): Promise<void> {
    await this.s().audit.append({ tenantId: ctx.p.tenantId, action, kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target, ...(detail ? { detail } : {}), label, traceId: ctx.traceId ?? null });
  }

  /** A catalogue event (`post.*`, B-2001): ids only. */
  private event(x: PostRow, type: 'post.created' | 'post.updated' | 'post.deleted' | 'post.held', actor: string | null, extra: Record<string, unknown> = {}): void {
    const data = { post: x.id, feed: x.group_id ? 'group' : 'workspace', workspace: x.workspace_id, group: x.group_id, actor, ...extra };
    this.s().bus.emitLocal(TOPICS.integrationEvent, { tenantId: x.tenant_id, type, label: x.label, id: `${type}:${ulid()}`, data } satisfies IntegrationEvent);
  }

  // ---------- scope ----------

  /** The workspaces and groups the caller may read now, with their clearance and rights. */
  async scope(p: Principal): Promise<Scope> {
    const s = this.s();
    const perms = effectivePermissions(p);
    const ws = await workspacesFor(s, p);
    const workspaces = new Map(ws.map((w) => [w.id, w]));
    const groups: Scope['groups'] = new Map();
    if (ws.length) {
      const manager = perms.has('groups:manage');
      const roles = new Map(((await this.db('group_members').where({ tenant_id: p.tenantId, user_id: p.userId }).select('group_id', 'role')) as { group_id: string; role: string }[]).map((m) => [m.group_id, m.role]));
      const rows = (await this.db('social_groups').where({ tenant_id: p.tenantId, state: 'active' }).whereIn('workspace_id', [...workspaces.keys()]).select('id', 'workspace_id', 'visibility', 'label')) as { id: string; workspace_id: string; visibility: string; label: string }[];
      for (const g of rows) {
        const label: Label = isLabel(g.label) ? g.label : 'restricted';
        const role = roles.get(g.id) ?? null;
        if (!clears(p.clearance, label) || !(manager || role || g.visibility === 'public')) continue;
        groups.set(g.id, { workspaceId: g.workspace_id, label, moderate: manager || role === 'owner' || role === 'moderator', post: manager || !!role });
      }
    }
    return { p, workspaces, groups, labels: LABELS.filter((l) => clears(p.clearance, l)), manage: perms.has('feed:manage') };
  }

  /** May the scope read this post's place (workspace or group) and label? (State and blocks are checked apart.) */
  private inScope(sc: Scope, x: Pick<PostRow, 'workspace_id' | 'group_id' | 'label'>): boolean {
    if (!sc.labels.includes(x.label)) return false;
    return x.group_id ? sc.groups.has(x.group_id) : sc.workspaces.has(x.workspace_id);
  }

  /** May the caller remove this post or its comments (beyond their own)? */
  private moderates(sc: Scope, x: Pick<PostRow, 'workspace_id' | 'group_id'>): boolean {
    if (sc.manage && sc.workspaces.has(x.workspace_id)) return true;
    return !!x.group_id && !!sc.groups.get(x.group_id)?.moderate;
  }

  private async row(tenantId: string, id: string): Promise<PostRow | null> {
    const r = await this.db('feed_posts').where({ tenant_id: tenantId, id }).first();
    return r ? postFrom(r) : null;
  }

  /**
   * A post the caller may see: in their scope, not in a block with its author, published (or held or rejected and
   * their own). A deleted post the caller could otherwise read is answered as deleted (409) when `deleted` says so;
   * everything else is 404, as if it did not exist.
   */
  private async visible(sc: Scope, id: string, o: { deleted?: 'conflict' } = {}): Promise<PostRow> {
    const x = await this.row(sc.p.tenantId, id);
    if (!x || !this.inScope(sc, x)) throw notFound('Post');
    const own = x.author_id === sc.p.userId;
    if (!own && (await this.s().social.isBlocked(sc.p.tenantId, sc.p.userId, x.author_id))) throw notFound('Post');
    if (x.state === 'deleted') {
      if (o.deleted === 'conflict') throw conflict(DELETED_POST);
      throw notFound('Post');
    }
    if (x.state === 'published') return x;
    if (own && (x.state === 'held' || x.state === 'rejected')) return x;
    if (x.state === 'hidden' && this.moderates(sc, x)) return x;
    throw notFound('Post');
  }

  /** A published post to act on (comment, react, repost, bookmark): a deleted one is refused as deleted. */
  private async live(sc: Scope, id: string): Promise<PostRow> {
    const x = await this.visible(sc, id, { deleted: 'conflict' });
    if (x.state !== 'published') throw conflict(x.state === 'held' ? 'The post waits for review.' : `The post is ${x.state}.`);
    return x;
  }

  // ---------- views ----------

  private async names(tenantId: string, ids: string[]): Promise<Map<string, { username: string; displayName: string }>> {
    const out = new Map<string, { username: string; displayName: string }>();
    const list = [...new Set(ids)];
    for (let i = 0; i < list.length; i += 500) {
      const rows = (await this.db('users').where({ tenant_id: tenantId }).whereIn('id', list.slice(i, i + 500)).select('id', 'username', 'display_name')) as { id: string; username: string; display_name: string }[];
      for (const r of rows) out.set(r.id, { username: r.username, displayName: r.display_name });
    }
    return out;
  }

  private async open(tenantId: string, sealed: string | null, aad: string): Promise<string | null> {
    return sealed == null ? null : ((await this.s().keys.open(tenantId, sealed, aad)) ?? '');
  }

  /** Posts as the caller sees them: text, media, the original of a repost, counts and their own reactions. */
  async views(sc: Scope, rows: PostRow[]) {
    if (!rows.length) return [];
    const p = sc.p;
    // The originals of reposts, as the caller may see them now (else `original: null`).
    const origIds = [...new Set(rows.map((x) => x.repost_of).filter((v): v is string => !!v))];
    const originals = new Map<string, PostRow>();
    if (origIds.length) {
      const blocked = await this.s().social.blockedWith(p.tenantId, p.userId);
      for (const r of (await this.db('feed_posts').where({ tenant_id: p.tenantId, state: 'published' }).whereIn('id', origIds)) as Record<string, unknown>[]) {
        const o = postFrom(r);
        if (this.inScope(sc, o) && !blocked.has(o.author_id)) originals.set(o.id, o);
      }
    }
    const all = [...rows, ...originals.values()];
    const ids = [...new Set(all.map((x) => x.id))];
    const [who, media, tags, reactions, comments, reposts, mine, marks, myReposts] = await Promise.all([
      this.names(p.tenantId, all.map((x) => x.author_id)),
      this.db('feed_post_media as m').leftJoin('files as f', 'f.id', 'm.file_id').whereIn('m.post_id', ids).orderBy('m.position').select('m.post_id', 'm.file_id', 'f.name', 'f.type', 'f.size', 'f.state', 'f.trashed_at') as Promise<{ post_id: string; file_id: string; name: string | null; type: string | null; size: number | null; state: string | null; trashed_at: number | null }[]>,
      this.db('feed_hashtags').whereIn('post_id', ids).select('post_id', 'tag') as Promise<{ post_id: string; tag: string }[]>,
      this.db('feed_reactions').whereIn('post_id', ids).groupBy('post_id', 'kind').select('post_id', 'kind').count({ n: '*' }) as Promise<{ post_id: string; kind: string; n: number | string }[]>,
      this.db('feed_comments').whereIn('post_id', ids).andWhere({ state: 'published' }).groupBy('post_id').select('post_id').count({ n: '*' }) as Promise<{ post_id: string; n: number | string }[]>,
      this.db('feed_posts').where({ tenant_id: p.tenantId, state: 'published' }).whereIn('repost_of', ids).groupBy('repost_of').select('repost_of').count({ n: '*' }) as Promise<{ repost_of: string; n: number | string }[]>,
      this.db('feed_reactions').whereIn('post_id', ids).andWhere({ user_id: p.userId }).select('post_id', 'kind') as Promise<{ post_id: string; kind: string }[]>,
      this.db('feed_bookmarks').whereIn('post_id', ids).andWhere({ user_id: p.userId }).select('post_id') as Promise<{ post_id: string }[]>,
      this.db('feed_posts').where({ tenant_id: p.tenantId, author_id: p.userId, state: 'published' }).whereIn('repost_key', ids).select('repost_key') as Promise<{ repost_key: string }[]>
    ]);
    const group = <T extends { post_id: string }>(list: T[]) => {
      const m = new Map<string, T[]>();
      for (const x of list) m.set(x.post_id, [...(m.get(x.post_id) ?? []), x]);
      return m;
    };
    const mediaBy = group(media);
    const tagsBy = group(tags);
    const reactBy = group(reactions);
    const mineBy = group(mine);
    const commentsBy = new Map(comments.map((c) => [c.post_id, Number(c.n)]));
    const repostsBy = new Map(reposts.map((c) => [c.repost_of, Number(c.n)]));
    const marked = new Set(marks.map((b) => b.post_id));
    const reposted = new Set(myReposts.map((r) => r.repost_key));
    const one = async (x: PostRow) => {
      const author = who.get(x.author_id);
      const counts: Record<string, number> = {};
      for (const r of reactBy.get(x.id) ?? []) counts[r.kind] = Number(r.n);
      return {
        id: x.id,
        workspaceId: x.workspace_id,
        groupId: x.group_id,
        author: { id: x.author_id, username: author?.username ?? null, displayName: author?.displayName ?? null },
        body: x.state === 'published' || x.author_id === p.userId ? await this.open(x.tenant_id, x.body, `feed-post:${x.id}`) : null,
        label: x.label,
        state: x.state,
        repostOf: x.repost_of,
        media: (mediaBy.get(x.id) ?? []).map((m) => ({ fileId: m.file_id, name: m.name, type: m.type, size: m.size == null ? null : Number(m.size), available: m.state === 'ready' && m.trashed_at == null })),
        tags: (tagsBy.get(x.id) ?? []).map((t) => t.tag),
        counts: { comments: commentsBy.get(x.id) ?? 0, reposts: repostsBy.get(x.id) ?? 0, reactions: counts },
        mine: { reactions: (mineBy.get(x.id) ?? []).map((r) => r.kind), bookmarked: marked.has(x.id), reposted: reposted.has(x.id) },
        createdAt: x.created_at,
        publishedAt: x.published_at,
        editedAt: x.edited_at
      };
    };
    const out = [];
    for (const x of rows) {
      const o = x.repost_of ? originals.get(x.repost_of) : undefined;
      out.push({ ...(await one(x)), original: x.repost_of ? (o ? await one(o) : null) : undefined });
    }
    return out;
  }

  /** Views of the given posts that the caller may see now (published, in scope, no block), by id. */
  async visibleViews(p: Principal, ids: string[], sc?: Scope): Promise<Map<string, unknown>> {
    if (!ids.length) return new Map();
    const scope = sc ?? (await this.scope(p));
    const blocked = await this.s().social.blockedWith(p.tenantId, p.userId);
    const rows = ((await this.db('feed_posts').where({ tenant_id: p.tenantId, state: 'published' }).whereIn('id', ids)) as Record<string, unknown>[]).map(postFrom).filter((x) => this.inScope(scope, x) && !blocked.has(x.author_id));
    return new Map((await this.views(scope, rows)).map((v) => [v.id, v as unknown]));
  }

  async view(p: Principal, id: string) {
    const sc = await this.scope(p);
    const x = await this.visible(sc, id);
    return (await this.views(sc, [x]))[0]!;
  }

  // ---------- feeds (B-2703) ----------

  /**
   * One page of published posts the caller may read, newest first, by (published_at, id): `filter` narrows the query
   * (a workspace, a group, authors, a tag); people in a block with the caller are always left out, and `hide` leaves
   * out more (the people they muted, for the home feed).
   */
  private async page(sc: Scope, q: PageQuery, filter: (qb: Knex.QueryBuilder) => void, hide: Set<string> = new Set()) {
    const p = sc.p;
    const limit = Math.min(Math.max(q.limit ?? 20, 1), PAGE_MAX);
    const cursor = decodeCursor(q.cursor);
    const blocked = await this.s().social.blockedWith(p.tenantId, p.userId);
    const out = [...new Set([...blocked, ...hide])].filter((u) => u !== p.userId);
    const groups = [...sc.groups.keys()];
    const qb = this.db('feed_posts as x')
      .where({ 'x.tenant_id': p.tenantId, 'x.state': 'published' })
      .whereIn('x.label', sc.labels)
      .andWhere((b) => b.where((w) => w.whereNull('x.group_id').whereIn('x.workspace_id', [...sc.workspaces.keys()])).orWhereIn('x.group_id', groups));
    filter(qb);
    for (let i = 0; i < out.length; i += 1000) qb.whereNotIn('x.author_id', out.slice(i, i + 1000));
    if (cursor) qb.andWhere((b) => b.where('x.published_at', '<', cursor.t).orWhere((e) => e.where('x.published_at', '=', cursor.t).andWhere('x.id', '<', cursor.id)));
    const rows = ((await qb.orderBy([{ column: 'x.published_at', order: 'desc' }, { column: 'x.id', order: 'desc' }]).limit(limit + 1).select('x.*')) as Record<string, unknown>[]).map(postFrom);
    const more = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return { items: await this.views(sc, items), nextCursor: more && last ? encodeCursor(last.published_at ?? 0, last.id) : null };
  }

  /** Home: the caller's own posts and those of the people they follow, minus the people they muted (B-2702). */
  async home(p: Principal, q: PageQuery) {
    const sc = await this.scope(p);
    const social = this.s().social;
    const [following, muted] = await Promise.all([social.following(p.tenantId, p.userId), social.mutedBy(p.tenantId, p.userId)]);
    const authors = [p.userId, ...[...following].filter((u) => !muted.has(u))];
    return this.page(sc, q, (qb) => {
      qb.andWhere((b) => {
        for (let i = 0; i < authors.length; i += 1000) b.orWhereIn('x.author_id', authors.slice(i, i + 1000));
      });
    }, muted);
  }

  /** A workspace's feed: its posts not targeted at a group. */
  async workspace(p: Principal, workspaceId: string, q: PageQuery) {
    const sc = await this.scope(p);
    if (!sc.workspaces.has(workspaceId)) throw notFound('Workspace');
    return this.page(sc, q, (qb) => void qb.whereNull('x.group_id').andWhere('x.workspace_id', workspaceId));
  }

  /** A group's feed: the feed posts targeted at the group (its notices stay at /api/groups/{id}/posts). */
  async group(p: Principal, groupId: string, q: PageQuery) {
    await this.s().groups.require(p, groupId, 'read');
    const sc = await this.scope(p);
    if (!sc.groups.has(groupId)) throw notFound('Group');
    return this.page(sc, q, (qb) => void qb.where('x.group_id', groupId));
  }

  /** A person's posts that the caller may read; someone in a block with the caller, or sharing no workspace, is unknown. */
  async user(p: Principal, userId: string, q: PageQuery) {
    const social = this.s().social;
    if (userId !== p.userId) {
      if (await social.isBlocked(p.tenantId, p.userId, userId)) throw notFound('User');
      if (!(await social.sharedWorkspaces(p, userId)).length) throw notFound('User');
    }
    const sc = await this.scope(p);
    return this.page(sc, q, (qb) => void qb.where('x.author_id', userId));
  }

  /** The posts of the people on one of the caller's lists (B-2702). */
  async list(p: Principal, listId: string, q: PageQuery) {
    const members = await this.s().social.listMembers(p.tenantId, p.userId, listId);
    if (!members) throw notFound('List');
    const sc = await this.scope(p);
    return this.page(sc, q, (qb) => {
      qb.andWhere((b) => {
        b.whereRaw('1 = 0');
        for (let i = 0; i < members.length; i += 1000) b.orWhereIn('x.author_id', members.slice(i, i + 1000));
      });
    });
  }

  /** Posts with a hashtag, in one workspace or all the caller's. */
  async tag(p: Principal, rawTag: string, workspaceId: string | null, q: PageQuery) {
    const tag = normaliseTag(rawTag);
    if (!tag) throw badRequest('That is not a hashtag.');
    const sc = await this.scope(p);
    if (workspaceId && !sc.workspaces.has(workspaceId)) throw notFound('Workspace');
    const posts = this.db('feed_hashtags').where({ tenant_id: p.tenantId, tag }).modify((b) => (workspaceId ? b.andWhere({ workspace_id: workspaceId }) : b)).select('post_id');
    return this.page(sc, q, (qb) => void qb.whereIn('x.id', posts));
  }

  /** The caller's bookmarks, most recently saved first (posts they can no longer see are left out). */
  async bookmarks(p: Principal, q: PageQuery) {
    const sc = await this.scope(p);
    const limit = Math.min(Math.max(q.limit ?? 20, 1), PAGE_MAX);
    const cursor = decodeCursor(q.cursor);
    const rows = (await this.db('feed_bookmarks')
      .where({ tenant_id: p.tenantId, user_id: p.userId })
      .modify((b) => {
        if (cursor) b.andWhere((w) => w.where('created_at', '<', cursor.t).orWhere((e) => e.where('created_at', '=', cursor.t).andWhere('post_id', '<', cursor.id)));
      })
      .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'post_id', order: 'desc' }])
      .limit(limit + 1)
      .select('post_id', 'created_at')) as { post_id: string; created_at: number | string }[];
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const blocked = await this.s().social.blockedWith(p.tenantId, p.userId);
    const posts = new Map(((page.length ? await this.db('feed_posts').where({ tenant_id: p.tenantId, state: 'published' }).whereIn('id', page.map((r) => r.post_id)) : []) as Record<string, unknown>[]).map(postFrom).map((x) => [x.id, x]));
    const keep = page.map((r) => posts.get(r.post_id)).filter((x): x is PostRow => !!x && this.inScope(sc, x) && !blocked.has(x.author_id));
    const last = page[page.length - 1];
    return { items: await this.views(sc, keep), nextCursor: more && last ? encodeCursor(Number(last.created_at), last.post_id) : null };
  }

  // ---------- posts (B-2701, B-2704) ----------

  /** The `user-input` checkpoint for a post or comment: refusals throw; a hold is returned when it may wait for review. */
  private async guard(p: Principal, x: { id: string; workspaceId: string; groupId: string | null; label: Label }, text: string, kind: 'post' | 'comment', holdable: boolean): Promise<{ text: string; hold: GuardDecision | null; action: string }> {
    const s = this.s();
    const d = await s.guardrails.check({ tenantId: p.tenantId, workspaceId: x.workspaceId, checkpoint: 'user-input', text, label: x.label, principal: p, source: { kind: kind === 'post' ? POST_OBJECT : COMMENT_OBJECT, id: x.id }, meta: { objectType: kind === 'post' ? POST_OBJECT : COMMENT_OBJECT, via: 'feed', workspace: x.workspaceId, group: x.groupId, tokens: Math.ceil(text.length / 4) } });
    // A hold from a check that could not run is not a reviewer's to decide: it stays a refusal.
    const reviewable = d.action === 'require-approval' && holdable && d.findings.some((f) => f.stage === 'enforce' && f.action === 'require-approval' && !f.detail?.startsWith('unavailable:'));
    if (reviewable) return { text: d.text, hold: d, action: d.action };
    if (d.action === 'block' || d.action === 'require-approval') {
      const rules = [...new Set(d.findings.filter((f) => f.stage === 'enforce' && f.action === d.action).map((f) => f.ruleName))];
      throw new HttpProblem(422, d.action === 'block' ? 'Blocked by guardrail' : 'Held by guardrail', d.reason ?? `A guardrail refused this ${kind}.`, { extensions: { step: 'guardrail', action: d.action, rules } });
    }
    return { text: d.action === 'redact' ? d.text : text, hold: null, action: d.action };
  }

  private checkLength(text: string): void {
    if (text.length > this.cfg.FEED_POST_MAX_CHARS) throw new HttpProblem(422, 'Too long', `Posts and comments are at most ${this.cfg.FEED_POST_MAX_CHARS} characters (FEED_POST_MAX_CHARS).`);
  }

  /** Where a new post goes and the label it starts from: a group of the caller's, or a workspace of theirs. */
  private async target(sc: Scope, input: { workspaceId?: string | undefined; groupId?: string | undefined; label?: Label | undefined }): Promise<{ workspaceId: string; groupId: string | null; ceiling: Label; label: Label }> {
    const p = sc.p;
    if (input.groupId) {
      const a = await this.s().groups.require(p, input.groupId, 'post');
      if (a.group.state !== 'active') throw conflict('The group is not open for posts.');
      if (input.workspaceId && input.workspaceId !== a.group.workspace_id) throw new HttpProblem(422, 'Wrong workspace', 'The group belongs to another workspace.');
      const label = input.label ?? a.group.label;
      return { workspaceId: a.group.workspace_id, groupId: a.group.id, ceiling: a.group.label, label };
    }
    const id = input.workspaceId ?? p.workspaceId ?? null;
    if (!id) throw new HttpProblem(422, 'No workspace', 'Name the workspace (or group) to post in.');
    const w = sc.workspaces.get(id);
    if (!w) throw notFound('Workspace');
    const label = input.label ?? (labelRank(w.label_ceiling) < labelRank('internal') ? w.label_ceiling : 'internal');
    return { workspaceId: w.id, groupId: null, ceiling: w.label_ceiling, label };
  }

  /** Files to attach: readable, through quarantine (ready), in the post's workspace. Raises the label to theirs. */
  private async media(p: Principal, fileIds: string[], workspaceId: string): Promise<{ ids: string[]; label: Label }> {
    const s = this.s();
    const ids = [...new Set(fileIds)];
    if (ids.length > MAX_MEDIA) throw new HttpProblem(422, 'Too many files', `A post carries at most ${MAX_MEDIA} files.`);
    let label: Label = 'public';
    for (const id of ids) {
      const { file } = await s.files.readable(p, id);
      if (file.workspace_id !== workspaceId) throw new HttpProblem(422, 'File from another workspace', `${file.name} is in another workspace; attach files from the post's workspace.`);
      if (file.state !== 'ready') throw conflict(file.state === 'pending' ? `${file.name} is still in quarantine; attach it once its scan has finished.` : `${file.name} was rejected by the scan and cannot be attached.`);
      label = highest(label, file.label);
    }
    return { ids, label };
  }

  async createPost(ctx: Ctx, input: { workspaceId?: string | undefined; groupId?: string | undefined; body?: string | undefined; media?: string[] | undefined; label?: Label | undefined }) {
    const s = this.s();
    const p = ctx.p;
    const sc = await this.scope(p);
    const body = input.body?.trim() ?? '';
    if (!body && !input.media?.length) throw new HttpProblem(422, 'Empty post', 'Write something or attach a file.');
    this.checkLength(body);
    const t = await this.target(sc, input);
    const m = await this.media(p, input.media ?? [], t.workspaceId);
    const label = highest(t.label, m.label);
    if (labelRank(label) > labelRank(t.ceiling)) throw new HttpProblem(422, 'Label above the ceiling', `${t.groupId ? 'The group' : 'The workspace'} allows posts up to ${t.ceiling}; this one would be ${label}.`);
    if (!clears(p.clearance, label)) throw forbidden(`The post would be ${label}, above your clearance of ${p.clearance}.`, { step: 'clearance' });
    const id = ulid();
    const g = body ? await this.guard(p, { id, workspaceId: t.workspaceId, groupId: t.groupId, label }, body, 'post', true) : { text: '', hold: null, action: 'allow' };
    const now = Date.now();
    const row: PostRow = { id, tenant_id: p.tenantId, workspace_id: t.workspaceId, group_id: t.groupId, author_id: p.userId, body: g.text ? await s.keys.seal(p.tenantId, g.text, `feed-post:${id}`) : null, label, state: g.hold ? 'held' : 'published', repost_of: null, repost_key: null, flag_id: null, created_at: now, updated_at: now, published_at: g.hold ? null : now, edited_at: null };
    await this.db.transaction(async (trx) => {
      await trx('feed_posts').insert(row);
      if (m.ids.length) await trx('feed_post_media').insert(m.ids.map((fileId, i) => ({ post_id: id, tenant_id: p.tenantId, file_id: fileId, position: i })));
    });
    if (g.hold) await this.hold(ctx, row, g.text, g.hold);
    else await this.published(ctx, row, g.text, { guardrails: g.action, media: m.ids.length });
    return (await this.views(sc, [row]))[0]!;
  }

  /** Files a held post in the review queue (B-2704): nobody but its author sees it until a reviewer approves it. */
  private async hold(ctx: Ctx, x: PostRow, text: string, d: GuardDecision): Promise<void> {
    const f = d.findings.find((y) => y.stage === 'enforce' && y.action === 'require-approval');
    const flag = await this.s().guard.flags.create({
      tenantId: x.tenant_id,
      workspaceId: x.workspace_id,
      kind: 'hold',
      checkpoint: 'user-input',
      ruleId: f?.ruleId ?? null,
      ruleName: f?.ruleName ?? 'Held for review',
      setId: f?.setId ?? null,
      stage: 'enforce',
      action: 'require-approval',
      severity: 'medium',
      label: x.label,
      text,
      span: f?.span ?? null,
      note: d.reason ?? 'A guardrail held this post for review before it is published.',
      actor: { user: ctx.p.userId, name: ctx.p.displayName, via: 'feed' },
      source: { kind: POST_OBJECT, id: x.id }
    });
    await this.db('feed_posts').where({ id: x.id }).update({ flag_id: flag.id });
    x.flag_id = flag.id;
    await this.audit(ctx, 'feed.post.held', { post: x.id, workspace: x.workspace_id, group: x.group_id, flag: flagRef(flag) }, { rule: f?.ruleName ?? null }, x.label);
    this.event(x, 'post.held', ctx.p.userId, { flag: flagRef(flag) });
  }

  /** What follows publishing: hashtags, the audit entry, the catalogue event and the live feeds. */
  private async published(ctx: Ctx | null, x: PostRow, text: string, detail: Record<string, unknown>): Promise<void> {
    await this.indexTags(x, text);
    if (ctx) await this.audit(ctx, 'feed.post.created', { post: x.id, workspace: x.workspace_id, group: x.group_id, ...(x.repost_of ? { repostOf: x.repost_of } : {}) }, { length: text.length, ...detail }, x.label);
    this.event(x, 'post.created', x.author_id);
    await this.deliver(x, 'feed.post.created');
  }

  private async indexTags(x: PostRow, text: string): Promise<void> {
    await this.db('feed_hashtags').where({ post_id: x.id }).delete();
    const tags = x.state === 'published' ? extractTags(text) : [];
    const rows = tags.map((tag) => ({ post_id: x.id, tenant_id: x.tenant_id, workspace_id: x.workspace_id, tag, published_at: x.published_at ?? Date.now() }));
    if (!rows.length) return;
    try {
      await this.db('feed_hashtags').insert(rows);
    } catch (err) {
      // MySQL's default collation folds accents (`café` and `cafe` are one key): keep the first of each.
      if (!isUniqueViolation(err)) throw err;
      for (const r of rows) await this.db('feed_hashtags').insert(r).catch((e: unknown) => {
        if (!isUniqueViolation(e)) throw e;
      });
    }
  }

  /** Users of the tenant whose clearance does not reach a label (left out of room events about it). */
  private async below(tenantId: string, label: Label): Promise<string[]> {
    if (label === 'public') return [];
    const lower = LABELS.filter((l) => labelRank(l) < labelRank(label));
    return ((await this.db('users').where({ tenant_id: tenantId }).whereIn('clearance', lower).select('id')) as { id: string }[]).map((u) => u.id);
  }

  /**
   * Live feeds (B-2703): the workspace or group feed room, and the home rooms of the author's followers who may read
   * the post and did not mute the author. Events carry ids only; clients fetch the post through the API, which applies
   * clearance and blocks again. People in a block with the author are left out (`social.emitToRoom`).
   */
  private async deliver(x: PostRow, event: 'feed.post.created' | 'feed.post.updated' | 'feed.post.deleted'): Promise<void> {
    const s = this.s();
    const data = { postId: x.id, authorId: x.author_id, workspaceId: x.workspace_id, groupId: x.group_id, repostOf: x.repost_of };
    const below = await this.below(x.tenant_id, x.label);
    await s.social.emitToRoom({ tenantId: x.tenant_id, kind: 'feed', id: x.group_id ?? x.workspace_id, event, data, exceptUserId: x.author_id, ...(below.length ? { exceptUserIds: below } : {}) }, x.author_id);
    if (event !== 'feed.post.created' || this.cfg.FEED_HOME_FANOUT_MAX === 0) return;
    const followers = [...(await s.social.followers(x.tenant_id, x.author_id))];
    if (!followers.length) return;
    const blocked = await s.social.blockedWith(x.tenant_id, x.author_id);
    const now = Date.now();
    const muting = new Set(((await this.db('social_mutes').where({ tenant_id: x.tenant_id, target_id: x.author_id }).andWhere((q) => q.whereNull('expires_at').orWhere('expires_at', '>', now)).select('user_id')) as { user_id: string }[]).map((r) => r.user_id));
    const lowSet = new Set(below);
    const candidates = followers.filter((u) => !blocked.has(u) && !muting.has(u) && !lowSet.has(u));
    const readers = await this.audienceAmong(x, candidates);
    for (const u of readers.slice(0, this.cfg.FEED_HOME_FANOUT_MAX)) s.rooms.emit({ tenantId: x.tenant_id, kind: 'feed', id: u, event, data: { ...data, feed: 'home' } });
  }

  /** Of these users, those whose workspace (or group) membership lets them read the post. */
  private async audienceAmong(x: PostRow, userIds: string[]): Promise<string[]> {
    if (!userIds.length) return [];
    const ws = (await this.db('workspaces').where({ tenant_id: x.tenant_id, id: x.workspace_id }).first('visibility', 'state')) as { visibility: string; state: string } | undefined;
    if (!ws || ws.state !== 'active') return [];
    const inWs = async (ids: string[]) => (ws.visibility === 'tenant' ? new Set(ids) : new Set(((await this.db('workspace_members').where({ workspace_id: x.workspace_id }).whereIn('user_id', ids).distinct('user_id')) as { user_id: string }[]).map((r) => r.user_id)));
    const out: string[] = [];
    for (let i = 0; i < userIds.length; i += 500) {
      const chunk = userIds.slice(i, i + 500);
      let ok = await inWs(chunk);
      if (x.group_id) {
        const g = (await this.db('social_groups').where({ id: x.group_id }).first('visibility')) as { visibility: string } | undefined;
        if (g?.visibility !== 'public') {
          const members = new Set(((await this.db('group_members').where({ group_id: x.group_id }).whereIn('user_id', chunk).select('user_id')) as { user_id: string }[]).map((r) => r.user_id));
          ok = new Set([...ok].filter((u) => members.has(u)));
        }
      }
      out.push(...chunk.filter((u) => ok.has(u)));
    }
    return out;
  }

  /** A reviewer's decision on a held post (from the flag queue): approving publishes it, rejecting withdraws it. */
  async resolveHold(p: Principal, postId: string, decision: 'approved' | 'rejected'): Promise<{ postId: string; state: PostState }> {
    const x = await this.row(p.tenantId, postId);
    if (!x) throw notFound('Post');
    // The author deleted it meanwhile: nothing to publish, the flag records the decision.
    if (x.state === 'deleted') return { postId: x.id, state: x.state };
    if (x.state !== 'held') throw conflict(`The post is ${x.state}, not waiting for review.`);
    if (x.author_id === p.userId) throw forbidden('You cannot decide on your own post.', { step: 'dual-control' });
    const now = Date.now();
    const state: PostState = decision === 'approved' ? 'published' : 'rejected';
    const n = await this.db('feed_posts').where({ id: x.id, state: 'held' }).update({ state, updated_at: now, ...(state === 'published' ? { published_at: now } : {}) });
    if (!n) throw conflict('The post changed meanwhile.');
    const after: PostRow = { ...x, state, updated_at: now, published_at: state === 'published' ? now : null };
    const s = this.s();
    if (state === 'published') {
      const text = (await this.open(x.tenant_id, x.body, `feed-post:${x.id}`)) ?? '';
      await this.published(null, after, text, {});
    }
    await s.notifications.notify({ tenantId: x.tenant_id, userIds: [x.author_id], kind: 'feed', title: state === 'published' ? 'Your post was approved and published' : 'Your post held for review was rejected', route: `feed?post=${x.id}`, label: x.label });
    return { postId: x.id, state };
  }

  async updatePost(ctx: Ctx, id: string, body: string) {
    const s = this.s();
    const p = ctx.p;
    const sc = await this.scope(p);
    const x = await this.visible(sc, id);
    if (x.author_id !== p.userId) throw forbidden('Only the author edits a post.', { step: 'owner' });
    if (x.state !== 'published') throw conflict(`The post is ${x.state}.`);
    if (x.repost_of && x.body == null) throw conflict('A plain repost has no text to edit.');
    const text = body.trim();
    if (!text && !(await this.db('feed_post_media').where({ post_id: x.id }).first('file_id'))) throw new HttpProblem(422, 'Empty post', 'Write something or delete the post.');
    this.checkLength(text);
    // An edit is checked again; it cannot wait for review (it is refused instead).
    const g = text ? await this.guard(p, { id: x.id, workspaceId: x.workspace_id, groupId: x.group_id, label: x.label }, text, 'post', false) : { text: '', action: 'allow' };
    const now = Date.now();
    const sealed = g.text ? await s.keys.seal(p.tenantId, g.text, `feed-post:${x.id}`) : null;
    const n = await this.db('feed_posts').where({ id: x.id, state: 'published' }).update({ body: sealed, updated_at: now, edited_at: now });
    if (!n) throw conflict('The post changed meanwhile.');
    const after: PostRow = { ...x, body: sealed, updated_at: now, edited_at: now };
    await this.indexTags(after, g.text);
    await this.audit(ctx, 'feed.post.updated', { post: x.id, workspace: x.workspace_id, group: x.group_id }, { length: g.text.length, guardrails: g.action }, x.label);
    this.event(after, 'post.updated', p.userId);
    await this.deliver(after, 'feed.post.updated');
    return (await this.views(sc, [after]))[0]!;
  }

  async deletePost(ctx: Ctx, id: string) {
    const p = ctx.p;
    const sc = await this.scope(p);
    const x = await this.visible(sc, id);
    const own = x.author_id === p.userId;
    if (!own && !this.moderates(sc, x)) throw forbidden('Only the author, a moderator of the group or a holder of feed:manage removes a post.', { step: 'owner' });
    const n = await this.db('feed_posts').where({ id: x.id, state: x.state }).update({ state: 'deleted', repost_key: null, updated_at: Date.now() });
    if (!n) throw conflict('The post changed meanwhile.');
    await this.db('feed_hashtags').where({ post_id: x.id }).delete();
    await this.audit(ctx, 'feed.post.deleted', { post: x.id, workspace: x.workspace_id, group: x.group_id }, { by: own ? 'author' : 'moderator', author: x.author_id, was: x.state }, x.label);
    if (x.state === 'published') {
      this.event(x, 'post.deleted', p.userId);
      await this.deliver({ ...x, state: 'deleted' }, 'feed.post.deleted');
    }
    return { id: x.id, state: 'deleted' as const };
  }

  // ---------- reposts ----------

  /**
   * Reposts a post into its own workspace or group (the audience never widens), with text of one's own or plain. A
   * plain repost of a plain repost reposts the original; reposting plainly twice gives the first repost back.
   */
  async repost(ctx: Ctx, id: string, body?: string) {
    const s = this.s();
    const p = ctx.p;
    const sc = await this.scope(p);
    let orig = await this.live(sc, id);
    if (orig.repost_of && orig.body == null) orig = await this.live(sc, orig.repost_of);
    if (orig.group_id && !sc.groups.get(orig.group_id)?.post) throw forbidden('Join the group to repost in it.', { step: 'group-role' });
    const text = body?.trim() ?? '';
    this.checkLength(text);
    if (!text) {
      const prior = (await this.db('feed_posts').where({ tenant_id: p.tenantId, author_id: p.userId, repost_key: orig.id }).first()) as Record<string, unknown> | undefined;
      if (prior) return { created: false, post: (await this.views(sc, [postFrom(prior)]))[0]! };
    }
    const newId = ulid();
    const g = text ? await this.guard(p, { id: newId, workspaceId: orig.workspace_id, groupId: orig.group_id, label: orig.label }, text, 'post', true) : { text: '', hold: null, action: 'allow' };
    const now = Date.now();
    const row: PostRow = { id: newId, tenant_id: p.tenantId, workspace_id: orig.workspace_id, group_id: orig.group_id, author_id: p.userId, body: g.text ? await s.keys.seal(p.tenantId, g.text, `feed-post:${newId}`) : null, label: orig.label, state: g.hold ? 'held' : 'published', repost_of: orig.id, repost_key: text ? null : orig.id, flag_id: null, created_at: now, updated_at: now, published_at: g.hold ? null : now, edited_at: null };
    try {
      await this.db('feed_posts').insert(row);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const prior = (await this.db('feed_posts').where({ tenant_id: p.tenantId, author_id: p.userId, repost_key: orig.id }).first()) as Record<string, unknown>;
      return { created: false, post: (await this.views(sc, [postFrom(prior)]))[0]! };
    }
    if (g.hold) await this.hold(ctx, row, g.text, g.hold);
    else await this.published(ctx, row, g.text, { guardrails: g.action });
    return { created: true, post: (await this.views(sc, [row]))[0]! };
  }

  /** Takes back the caller's plain repost of a post. */
  async unrepost(ctx: Ctx, id: string) {
    const p = ctx.p;
    const r = (await this.db('feed_posts').where({ tenant_id: p.tenantId, author_id: p.userId, repost_key: id }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Repost');
    return this.deletePost(ctx, String(r.id));
  }

  // ---------- comments ----------

  private async commentViews(tenantId: string, rows: CommentRow[]) {
    const who = await this.names(tenantId, rows.map((c) => c.author_id));
    return Promise.all(
      rows.map(async (c) => {
        const a = who.get(c.author_id);
        return { id: c.id, postId: c.post_id, parentId: c.parent_id, author: { id: c.author_id, username: a?.username ?? null, displayName: a?.displayName ?? null }, body: c.state === 'published' ? await this.open(c.tenant_id, c.body, `feed-comment:${c.id}`) : null, state: c.state, createdAt: c.created_at };
      })
    );
  }

  /** A post's comments, oldest first, with their parents (threads are built by the client from `parentId`). */
  async comments(p: Principal, postId: string, q: PageQuery) {
    const sc = await this.scope(p);
    const x = await this.visible(sc, postId);
    if (x.state !== 'published') return { items: [], nextCursor: null };
    const limit = Math.min(Math.max(q.limit ?? 50, 1), PAGE_MAX);
    const cursor = decodeCursor(q.cursor);
    const blocked = [...(await this.s().social.blockedWith(p.tenantId, p.userId))];
    const qb = this.db('feed_comments').where({ post_id: x.id, state: 'published' });
    for (let i = 0; i < blocked.length; i += 1000) qb.whereNotIn('author_id', blocked.slice(i, i + 1000));
    if (cursor) qb.andWhere((b) => b.where('created_at', '>', cursor.t).orWhere((e) => e.where('created_at', '=', cursor.t).andWhere('id', '>', cursor.id)));
    const rows = ((await qb.orderBy([{ column: 'created_at', order: 'asc' }, { column: 'id', order: 'asc' }]).limit(limit + 1)) as Record<string, unknown>[]).map(commentFrom);
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: await this.commentViews(p.tenantId, page), nextCursor: more && last ? encodeCursor(last.created_at, last.id) : null };
  }

  /** Comments on a published post; a comment on a deleted post is refused (B-2701). */
  async comment(ctx: Ctx, postId: string, input: { body: string; parentId?: string | undefined }) {
    const s = this.s();
    const p = ctx.p;
    const sc = await this.scope(p);
    const x = await this.live(sc, postId);
    if (x.group_id && !sc.groups.get(x.group_id)?.post) throw forbidden('Join the group to comment in it.', { step: 'group-role' });
    if (input.parentId) {
      const parent = (await this.db('feed_comments').where({ id: input.parentId, post_id: x.id }).first('id', 'state', 'author_id')) as { id: string; state: string; author_id: string } | undefined;
      if (!parent || parent.state !== 'published' || (await s.social.isBlocked(p.tenantId, p.userId, parent.author_id))) throw notFound('Comment');
    }
    const text = input.body.trim();
    if (!text) throw new HttpProblem(422, 'Empty comment', 'Write something.');
    this.checkLength(text);
    const id = ulid();
    // Comments are checked like posts; a hold refuses (comments do not wait for review).
    const g = await this.guard(p, { id, workspaceId: x.workspace_id, groupId: x.group_id, label: x.label }, text, 'comment', false);
    const now = Date.now();
    const row: CommentRow = { id, tenant_id: p.tenantId, post_id: x.id, parent_id: input.parentId ?? null, author_id: p.userId, body: await s.keys.seal(p.tenantId, g.text, `feed-comment:${id}`), label: x.label, state: 'published', created_at: now, updated_at: now };
    await this.db('feed_comments').insert(row);
    await this.audit(ctx, 'feed.comment.created', { post: x.id, comment: id, ...(row.parent_id ? { parent: row.parent_id } : {}) }, { length: g.text.length, guardrails: g.action }, x.label);
    const below = await this.below(x.tenant_id, x.label);
    await s.social.emitToRoom({ tenantId: x.tenant_id, kind: 'feed', id: x.group_id ?? x.workspace_id, event: 'feed.comment.created', data: { postId: x.id, commentId: id, parentId: row.parent_id, authorId: p.userId }, exceptUserId: p.userId, ...(below.length ? { exceptUserIds: below } : {}) }, p.userId);
    return (await this.commentViews(p.tenantId, [row]))[0]!;
  }

  async deleteComment(ctx: Ctx, commentId: string) {
    const p = ctx.p;
    const r = await this.db('feed_comments').where({ tenant_id: p.tenantId, id: commentId }).first();
    if (!r) throw notFound('Comment');
    const c = commentFrom(r);
    const sc = await this.scope(p);
    const x = await this.row(p.tenantId, c.post_id);
    if (!x || !this.inScope(sc, x) || c.state === 'deleted') throw notFound('Comment');
    const own = c.author_id === p.userId;
    // The author of the comment, the author of the post, a moderator of its group, or feed:manage.
    if (!own && x.author_id !== p.userId && !this.moderates(sc, x)) throw forbidden('Only the comment’s author, the post’s author or a moderator removes a comment.', { step: 'owner' });
    const n = await this.db('feed_comments').where({ id: c.id, state: c.state }).update({ state: 'deleted', updated_at: Date.now() });
    if (!n) throw conflict('The comment changed meanwhile.');
    await this.audit(ctx, 'feed.comment.deleted', { post: x.id, comment: c.id }, { by: own ? 'author' : x.author_id === p.userId ? 'post-author' : 'moderator', author: c.author_id }, c.label);
    return { id: c.id, state: 'deleted' as const };
  }

  // ---------- reactions and bookmarks ----------

  async react(ctx: Ctx, postId: string, kind: Reaction) {
    const p = ctx.p;
    const sc = await this.scope(p);
    const x = await this.live(sc, postId);
    let added = true;
    try {
      await this.db('feed_reactions').insert({ post_id: x.id, tenant_id: p.tenantId, user_id: p.userId, kind, created_at: Date.now() });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      added = false;
    }
    if (added) await this.audit(ctx, 'feed.reaction.added', { post: x.id }, { kind }, x.label);
    return { postId: x.id, kind, added };
  }

  async unreact(ctx: Ctx, postId: string, kind: Reaction) {
    const p = ctx.p;
    const sc = await this.scope(p);
    const x = await this.visible(sc, postId);
    const n = await this.db('feed_reactions').where({ post_id: x.id, user_id: p.userId, kind }).delete();
    if (!n) throw notFound('Reaction');
    await this.audit(ctx, 'feed.reaction.removed', { post: x.id }, { kind }, x.label);
    return { postId: x.id, kind, removed: true };
  }

  async bookmark(ctx: Ctx, postId: string) {
    const p = ctx.p;
    const sc = await this.scope(p);
    const x = await this.live(sc, postId);
    let added = true;
    try {
      await this.db('feed_bookmarks').insert({ tenant_id: p.tenantId, user_id: p.userId, post_id: x.id, created_at: Date.now() });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      added = false;
    }
    if (added) await this.audit(ctx, 'feed.bookmark.added', { post: x.id }, undefined, x.label);
    return { postId: x.id, bookmarked: true, added };
  }

  async unbookmark(ctx: Ctx, postId: string) {
    const p = ctx.p;
    // A bookmark can be removed even when its post is gone.
    const n = await this.db('feed_bookmarks').where({ tenant_id: p.tenantId, user_id: p.userId, post_id: postId }).delete();
    if (!n) throw notFound('Bookmark');
    await this.audit(ctx, 'feed.bookmark.removed', { post: postId }, undefined, 'internal');
    return { postId, bookmarked: false };
  }

  // ---------- moderation object types (B-1902) ----------

  private registerModeration(): void {
    const s = this.s();
    const reg = s.moderation.registry;
    const db = () => this.s().db;
    const readable = async (p: Principal, postId: string, workspaces: string[]) => {
      const x = await this.row(p.tenantId, postId);
      if (!x || x.state !== 'published' || !clears(p.clearance, x.label)) return false;
      if (x.author_id !== p.userId && (await s.social.isBlocked(p.tenantId, p.userId, x.author_id))) return false;
      if (!x.group_id) return workspaces.includes(x.workspace_id);
      return !!(await s.groups.accessOrNull(p, x.group_id, workspaces))?.read;
    };
    const casHide = async (table: string, id: string, tenantId: string, from: string | null): Promise<string | null> => {
      if (from !== 'published') return null;
      const n = await db()(table).where({ id, tenant_id: tenantId, state: 'published' }).update({ state: 'hidden', updated_at: Date.now() });
      return n ? 'published' : null;
    };
    const casRestore = async (table: string, id: string, tenantId: string, prev: string) => (await db()(table).where({ id, tenant_id: tenantId, state: 'hidden' }).update({ state: prev, updated_at: Date.now() })) > 0;

    if (!reg.get(POST_OBJECT))
      reg.register({
        type: POST_OBJECT,
        description: 'A post in a workspace or group feed (a hidden post leaves every feed)',
        resolve: async (tenantId, id) => {
          const x = await this.row(tenantId, id);
          return x ? { type: POST_OBJECT, id: x.id, tenantId, workspaceId: x.workspace_id, label: x.label, ownerId: x.author_id, state: x.state } : null;
        },
        canRead: (p, o, workspaces) => readable(p, o.id, workspaces),
        text: async (o) => {
          const x = await this.row(o.tenantId, o.id);
          return x ? ((await this.open(o.tenantId, x.body, `feed-post:${x.id}`)) ?? '') : '';
        },
        hide: async (o) => {
          const prev = await casHide('feed_posts', o.id, o.tenantId, o.state);
          const x = prev ? await this.row(o.tenantId, o.id) : null;
          if (x) await this.deliver(x, 'feed.post.deleted');
          return prev;
        },
        restore: (o, prev) => casRestore('feed_posts', o.id, o.tenantId, prev)
      });

    if (!reg.get(COMMENT_OBJECT))
      reg.register({
        type: COMMENT_OBJECT,
        description: 'A comment on a feed post (a hidden comment is shown to nobody)',
        resolve: async (tenantId, id) => {
          const r = (await db()('feed_comments as c').join('feed_posts as x', 'x.id', 'c.post_id').where({ 'c.tenant_id': tenantId, 'c.id': id }).first('c.id', 'c.state', 'c.label', 'c.author_id', 'x.workspace_id')) as { id: string; state: string; label: string; author_id: string; workspace_id: string } | undefined;
          return r ? { type: COMMENT_OBJECT, id: r.id, tenantId, workspaceId: r.workspace_id, label: isLabel(r.label) ? r.label : 'restricted', ownerId: r.author_id, state: r.state } : null;
        },
        canRead: async (p, o, workspaces) => {
          if (o.state !== 'published' || !clears(p.clearance, o.label)) return false;
          if (o.ownerId && o.ownerId !== p.userId && (await s.social.isBlocked(p.tenantId, p.userId, o.ownerId))) return false;
          const c = (await db()('feed_comments').where({ id: o.id }).first('post_id')) as { post_id: string } | undefined;
          return !!c && (await readable(p, c.post_id, workspaces));
        },
        text: async (o) => {
          const c = (await db()('feed_comments').where({ id: o.id }).first('body')) as { body: string } | undefined;
          return c ? ((await this.open(o.tenantId, c.body, `feed-comment:${o.id}`)) ?? '') : '';
        },
        hide: (o) => casHide('feed_comments', o.id, o.tenantId, o.state),
        restore: (o, prev) => casRestore('feed_comments', o.id, o.tenantId, prev)
      });
  }
}
