import type { Knex } from 'knex';
import { isLabel, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { notFound } from '../http/problem.js';
import { normaliseTag } from '../feed/tags.js';
import { postFrom, type PostRow, type Scope } from '../feed/service.js';
import type { Services } from '../services.js';
import type { SearchIndex } from './indexer.js';
import { matchesText, parseQuery, snippet, type ParsedQuery } from './normalise.js';
import type { IndexReader } from './query.js';

/*
 * 1.9.0, Sprint 52 (B-172): full-text search of posts and comments in the feed, groups and lists.
 *
 * - Scope: the feed's own (`FeedService.scope`): the workspaces and groups the reader may read now, at labels they
 *   clear. Visibility: an unlisted post (and its comments) is in no feed, so it is found only by its author. Blocks
 *   (either way) and mutes take the other person's posts and comments out, as they do in the home feed. All of it is
 *   applied before results are counted.
 * - Filters: words, "phrases" and prefixes; author, a tag (the post's, for a comment its post's), a group, a
 *   workspace, one of the reader's lists (its people), dates, posts or comments only.
 * - The blind index (B-170) once the tenant's backfill finished. Before that, the newest SCAN posts and comments in
 *   scope are opened and matched one by one, and the answer says it is partial.
 * - Every result is checked again (published, in scope, no block or mute, its post still readable for a comment)
 *   before its text is opened for the snippet.
 */

export const POST_KINDS = ['post', 'comment', 'all'] as const;
export type PostKind = (typeof POST_KINDS)[number];
const SCAN = 1000;

export interface PostQuery {
  q: string;
  author?: string | undefined;
  tag?: string | undefined;
  group?: string | undefined;
  workspace?: string | undefined;
  list?: string | undefined;
  after?: number | undefined;
  before?: number | undefined;
  kind?: PostKind | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  typeahead?: boolean | undefined;
}

export interface PostHit {
  kind: 'post' | 'comment';
  id: string;
  postId: string;
  authorId: string;
  authorName: string | null;
  workspaceId: string;
  groupId: string | null;
  createdAt: number;
  label: Label;
  tags: string[];
  snippet: string;
  highlights: [number, number][];
  route: string;
  score: number;
}

interface Ctx {
  sc: Scope;
  hidden: Set<string>;
  authors: Set<string> | null;
  tag: string | null;
}

interface Candidate {
  kind: 'post' | 'comment';
  id: string;
  score: number;
}

export class PostSearch {
  constructor(
    private readonly s: () => Services,
    private readonly index: SearchIndex,
    private readonly reader: IndexReader
  ) {}

  private get db() {
    return this.s().db;
  }

  private inScope(sc: Scope, x: Pick<PostRow, 'workspace_id' | 'group_id' | 'label'>): boolean {
    if (!sc.labels.includes(x.label)) return false;
    return x.group_id ? sc.groups.has(x.group_id) : sc.workspaces.has(x.workspace_id);
  }

  private async context(p: Principal, q: PostQuery): Promise<Ctx> {
    const s = this.s();
    const sc = await s.feed.scope(p);
    const hidden = await s.social.hiddenFor(p.tenantId, p.userId);
    hidden.delete(p.userId);
    let authors: Set<string> | null = null;
    if (q.list) {
      const members = await s.social.listMembers(p.tenantId, p.userId, q.list);
      if (!members) throw notFound('List');
      authors = new Set(members);
    }
    if (q.author) authors = authors ? new Set([...authors].filter((a) => a === q.author)) : new Set([q.author]);
    const tag = q.tag ? normaliseTag(q.tag) : null;
    return { sc, hidden, authors, tag };
  }

  private partitions(c: Ctx, q: PostQuery): string[] {
    if (q.group) return c.sc.groups.has(q.group) ? [q.group] : [];
    const ws = [...c.sc.workspaces.keys()].filter((w) => !q.workspace || w === q.workspace);
    const groups = [...c.sc.groups].filter(([, g]) => !q.workspace || g.workspaceId === q.workspace).map(([id]) => id);
    return [...ws, ...groups];
  }

  private kinds(q: PostQuery): ('post' | 'comment')[] {
    return q.kind === 'post' ? ['post'] : q.kind === 'comment' ? ['comment'] : ['post', 'comment'];
  }

  private async indexed(p: Principal, q: PostQuery, pq: ParsedQuery, c: Ctx, version: number): Promise<{ list: Candidate[]; total: number }> {
    const db = this.db;
    const out = await this.reader.search({
      tenantId: p.tenantId,
      version,
      pq,
      kinds: this.kinds(q),
      scopes: this.partitions(c, q),
      where: (qb: Knex.QueryBuilder) => {
        qb.whereIn('label', c.sc.labels);
        qb.andWhere((b) => b.whereNot('visibility', 'unlisted').orWhereNull('visibility').orWhere('author_id', p.userId));
        if (q.workspace) qb.andWhere({ workspace_id: q.workspace });
        if (c.authors) qb.whereIn('author_id', c.authors.size ? [...c.authors] : ['']);
        if (c.hidden.size && c.hidden.size <= 900) qb.whereNotIn('author_id', [...c.hidden]);
        if (q.after != null) qb.andWhere('created_at', '>=', q.after);
        if (q.before != null) qb.andWhere('created_at', '<=', q.before);
        if (c.tag) {
          const tagged = db('feed_hashtags').where({ tenant_id: p.tenantId, tag: c.tag }).select('post_id');
          qb.andWhere((b) => b.where((x) => x.where({ doc_kind: 'post' }).whereIn('doc_id', tagged)).orWhere((x) => x.where({ doc_kind: 'comment' }).whereIn('parent_id', db('feed_hashtags').where({ tenant_id: p.tenantId, tag: c.tag! }).select('post_id'))));
        }
      }
    });
    const list = out.ranked.filter((r) => !c.hidden.has(r.meta.author_id)).map((r) => ({ kind: r.meta.doc_kind as 'post' | 'comment', id: r.meta.doc_id, score: r.score }));
    return { list, total: list.length };
  }

  /** Before the index is ready: the newest posts and comments in scope, opened and matched here. */
  private async scanned(p: Principal, q: PostQuery, pq: ParsedQuery, c: Ctx): Promise<{ list: Candidate[]; total: number; partial: boolean }> {
    const s = this.s();
    const parts = this.partitions(c, q);
    if (!parts.length) return { list: [], total: 0, partial: false };
    const ws = parts.filter((x) => c.sc.workspaces.has(x));
    const gs = parts.filter((x) => c.sc.groups.has(x));
    const posts = this.db('feed_posts as x')
      .where({ 'x.tenant_id': p.tenantId, 'x.state': 'published' })
      .whereIn('x.label', c.sc.labels)
      .andWhere((b) => b.where((w) => w.whereNull('x.group_id').whereIn('x.workspace_id', ws.length ? ws : [''])).orWhereIn('x.group_id', gs.length ? gs : ['']))
      .andWhere((b) => b.whereNot('x.visibility', 'unlisted').orWhere('x.author_id', p.userId));
    if (c.authors) posts.whereIn('x.author_id', c.authors.size ? [...c.authors] : ['']);
    if (c.tag) posts.whereIn('x.id', this.db('feed_hashtags').where({ tenant_id: p.tenantId, tag: c.tag }).select('post_id'));
    const list: Candidate[] = [];
    let seen = 0;
    const kinds = this.kinds(q);
    if (kinds.includes('post')) {
      const rows = ((await posts.clone().modify((b) => this.dates(b, q, 'x.published_at')).orderBy('x.published_at', 'desc').limit(SCAN).select('x.*')) as Record<string, unknown>[]).map(postFrom);
      seen += rows.length;
      for (const x of rows) {
        if (c.hidden.has(x.author_id) || !x.body) continue;
        const text = (await s.keys.open(x.tenant_id, x.body, `feed-post:${x.id}`)) ?? '';
        if (matchesText(text, pq)) list.push({ kind: 'post', id: x.id, score: 1 });
      }
    }
    if (kinds.includes('comment')) {
      const rows = (await this.db('feed_comments as cm')
        .where({ 'cm.tenant_id': p.tenantId, 'cm.state': 'published' })
        .whereIn('cm.post_id', posts.clone().select('x.id'))
        .modify((b) => {
          this.dates(b, q, 'cm.created_at');
          if (c.authors) b.whereIn('cm.author_id', c.authors.size ? [...c.authors] : ['']);
        })
        .orderBy('cm.created_at', 'desc')
        .limit(SCAN)
        .select('cm.id', 'cm.tenant_id', 'cm.author_id', 'cm.body')) as { id: string; tenant_id: string; author_id: string; body: string }[];
      seen += rows.length;
      for (const r of rows) {
        if (c.hidden.has(r.author_id)) continue;
        const text = (await s.keys.open(r.tenant_id, r.body, `feed-comment:${r.id}`)) ?? '';
        if (matchesText(text, pq)) list.push({ kind: 'comment', id: r.id, score: 1 });
      }
    }
    return { list, total: list.length, partial: seen >= SCAN };
  }

  private dates(b: Knex.QueryBuilder, q: PostQuery, col: string): void {
    if (q.after != null) b.andWhere(col, '>=', q.after);
    if (q.before != null) b.andWhere(col, '<=', q.before);
  }

  async search(p: Principal, q: PostQuery): Promise<{ items: PostHit[]; total: number; engine: 'index' | 'fallback'; partial: boolean }> {
    const s = this.s();
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 100);
    const offset = Math.max(q.offset ?? 0, 0);
    const pq = parseQuery(q.q, { typeahead: !!q.typeahead });
    if (q.group) await s.groups.require(p, q.group, 'read');
    const c = await this.context(p, q);
    if (q.tag && !c.tag) return { items: [], total: 0, engine: 'fallback', partial: false };
    if (!pq.units.length) return { items: [], total: 0, engine: 'fallback', partial: false };
    const version = await this.index.readVersion(p.tenantId);
    const found = version != null ? { ...(await this.indexed(p, q, pq, c, version)), partial: false } : await this.scanned(p, q, pq, c);
    const engine = version != null ? 'index' : 'fallback';
    const needsText = engine === 'index' && pq.units.some((u) => u.kind !== 'term');
    const items: PostHit[] = [];
    let dropped = 0;
    let skipped = 0;
    const names = new Map<string, string | null>();
    for (const cand of found.list) {
      if (items.length >= limit) break;
      const hit = await this.recheck(p, c, cand);
      if (!hit || (needsText && !matchesText(hit.text, pq))) {
        dropped++;
        continue;
      }
      if (skipped < offset) {
        skipped++;
        continue;
      }
      if (!names.has(hit.authorId)) names.set(hit.authorId, ((await this.db('users').where({ tenant_id: p.tenantId, id: hit.authorId }).first('display_name')) as { display_name: string } | undefined)?.display_name ?? null);
      const tags = ((await this.db('feed_hashtags').where({ post_id: hit.post.id }).select('tag')) as { tag: string }[]).map((t) => t.tag);
      const sn = snippet(hit.text, pq);
      items.push({ kind: cand.kind, id: cand.id, postId: hit.post.id, authorId: hit.authorId, authorName: names.get(hit.authorId) ?? null, workspaceId: hit.post.workspace_id, groupId: hit.post.group_id, createdAt: hit.createdAt, label: hit.label, tags, snippet: sn.text, highlights: sn.highlights, route: cand.kind === 'comment' ? `messages?post=${hit.post.id}&comment=${cand.id}` : `messages?post=${hit.post.id}`, score: Number(cand.score.toFixed(4)) });
    }
    return { items, total: Math.max(items.length + offset, found.total - dropped), engine, partial: found.partial };
  }

  /** The result as the reader may read it now, with its text, or null. */
  private async recheck(p: Principal, c: Ctx, cand: Candidate): Promise<{ post: PostRow; text: string; authorId: string; createdAt: number; label: Label } | null> {
    const s = this.s();
    const readable = async (postId: string): Promise<PostRow | null> => {
      const r = await this.db('feed_posts').where({ tenant_id: p.tenantId, id: postId, state: 'published' }).first();
      if (!r) return null;
      const x = postFrom(r);
      if (!this.inScope(c.sc, x) || c.hidden.has(x.author_id)) return null;
      if (x.visibility === 'unlisted' && x.author_id !== p.userId) return null;
      return x;
    };
    if (cand.kind === 'post') {
      const x = await readable(cand.id);
      if (!x || !x.body) return null;
      return { post: x, text: (await s.keys.open(x.tenant_id, x.body, `feed-post:${x.id}`)) ?? '', authorId: x.author_id, createdAt: x.published_at ?? x.created_at, label: x.label };
    }
    const r = (await this.db('feed_comments').where({ tenant_id: p.tenantId, id: cand.id, state: 'published' }).first()) as Record<string, unknown> | undefined;
    if (!r || c.hidden.has(String(r.author_id))) return null;
    const x = await readable(String(r.post_id));
    if (!x) return null;
    const label: Label = isLabel(r.label) ? r.label : 'restricted';
    if (!c.sc.labels.includes(label)) return null;
    return { post: x, text: (await s.keys.open(p.tenantId, String(r.body), `feed-comment:${String(r.id)}`)) ?? '', authorId: String(r.author_id), createdAt: Number(r.created_at), label };
  }
}
