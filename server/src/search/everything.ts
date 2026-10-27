import { clears, type Label } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import type { Permission } from '../authz/permissions.js';
import { titleFieldOf } from '../apps/schema.js';
import { HttpProblem } from '../http/problem.js';
import type { Services } from '../services.js';
import type { ChatSearch } from './chats.js';
import { completions, parseQuery, snippet } from './normalise.js';
import type { PostSearch } from './posts.js';

/*
 * 1.9.0, Sprint 52 (B-173): one search box. One query goes to every source the reader holds the permission of, each
 * through that source's own search as the reader (chats and posts through B-171 and B-172; files, knowledge, groups,
 * people, app records and the reader's own assistant chats through their existing searches), and the answer is grouped
 * by source. A source the reader may not use is left out, not asked; a source that fails reports itself unavailable
 * and the others still answer. Nothing here reads a table a source's search does not: search never widens access.
 *
 * Type-ahead (`suggest`) asks the same sources for a few results with the last word read as a prefix, and the words of
 * the reader's own results that complete it. Knowledge answers type-ahead by document name only (no model call per
 * key press).
 */

export const SOURCES = ['chats', 'posts', 'files', 'knowledge', 'groups', 'people', 'apps', 'assistant'] as const;
export type Source = (typeof SOURCES)[number];

export const SOURCE_INFO: Record<Source, { title: string; perm: Permission; route: string }> = {
  chats: { title: 'Chats', perm: 'messages:read', route: 'search?source=chats' },
  posts: { title: 'Posts and comments', perm: 'feed:read', route: 'search?source=posts' },
  files: { title: 'Files', perm: 'files:read', route: 'files' },
  knowledge: { title: 'Knowledge', perm: 'knowledge:read', route: 'knowledge' },
  groups: { title: 'Groups', perm: 'groups:read', route: 'groups' },
  people: { title: 'People', perm: 'social:read', route: 'messages' },
  apps: { title: 'App records', perm: 'records:read', route: 'apps' },
  assistant: { title: 'Assistant chats', perm: 'chat:read', route: 'chat' }
};

/** What the route asks first: any one of the sources' permissions. */
export const SEARCH_PERMISSIONS: Permission[] = [...new Set(SOURCES.map((x) => SOURCE_INFO[x].perm))];

export interface Item {
  id: string;
  title: string;
  sub: string | null;
  snippet: string | null;
  highlights: [number, number][];
  label: Label | null;
  at: number | null;
  route: string;
}

export interface Group {
  source: Source;
  title: string;
  items: Item[];
  total: number | null;
  error: string | null;
  route: string;
}

const APP_LIMIT = 10;
const ENTITY_LIMIT = 20;

export class SearchEverything {
  constructor(
    private readonly s: () => Services,
    private readonly chats: ChatSearch,
    private readonly posts: PostSearch
  ) {}

  /** The sources this reader may search (their permission, as the source's own routes ask it). */
  sourcesFor(p: Principal): Source[] {
    const held = effectivePermissions(p);
    return SOURCES.filter((x) => held.has(SOURCE_INFO[x].perm));
  }

  private plain(q: string): string {
    return q.replace(/["*]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private async one(p: Principal, src: Source, q: string, limit: number, typeahead: boolean): Promise<{ items: Item[]; total: number | null }> {
    const s = this.s();
    const plain = this.plain(q);
    const pq = parseQuery(q, { typeahead });
    switch (src) {
      case 'chats': {
        const r = await this.chats.search(p, { q, limit, typeahead, mode: 'keyword' });
        return { total: r.total, items: r.items.map((h) => ({ id: h.id, title: h.conversation.title ?? (h.conversation.kind === 'direct' ? 'Direct conversation' : 'Group conversation'), sub: h.authorName, snippet: h.snippet, highlights: h.highlights, label: h.label, at: h.createdAt, route: h.route })) };
      }
      case 'posts': {
        const r = await this.posts.search(p, { q, limit, typeahead });
        return { total: r.total, items: r.items.map((h) => ({ id: h.id, title: h.kind === 'comment' ? `Comment by ${h.authorName ?? 'someone'}` : `Post by ${h.authorName ?? 'someone'}`, sub: h.tags.length ? h.tags.map((t) => `#${t}`).join(' ') : null, snippet: h.snippet, highlights: h.highlights, label: h.label, at: h.createdAt, route: h.route })) };
      }
      case 'files': {
        if (!plain) return { items: [], total: 0 };
        const rows = (await s.files.search(p, { q: plain, limit: limit + 1 })) as { id: string; name: string; label: Label; workspaceName: string | null; updatedAt?: number; folderId?: string | null }[];
        return { total: null, items: rows.slice(0, limit).map((f) => ({ id: f.id, title: f.name, sub: f.workspaceName, snippet: null, highlights: [], label: f.label, at: f.updatedAt ?? null, route: `files?file=${f.id}` })) };
      }
      case 'knowledge': {
        if (!plain) return { items: [], total: 0 };
        const bases = (await s.knowledge.visible(p)).map((v) => v.kb).filter((kb) => clears(p.clearance, kb.label));
        const items: Item[] = [];
        // Document names first (what type-ahead answers), then passages by keyword and meaning for a full search.
        for (const kb of bases) {
          if (items.length >= limit) break;
          const docs = (await s.knowledge.documents(p, kb.id, { q: plain, limit })) as { id: string; name: string; label: Label; updatedAt?: number }[];
          for (const d of docs.slice(0, limit - items.length)) items.push({ id: d.id, title: d.name, sub: kb.name, snippet: null, highlights: [], label: d.label, at: d.updatedAt ?? null, route: `knowledge?kb=${kb.id}` });
        }
        if (!typeahead && items.length < limit && bases.length) {
          const out = await s.knowledge.search(p, bases.slice(0, 20), plain, { k: limit, rerank: false, withText: true, lenient: true, queryLabel: 'internal' });
          for (const h of out.hits) {
            if (items.length >= limit) break;
            if (items.some((x) => x.id === h.documentId)) continue;
            const sn = h.text ? snippet(h.text, pq) : null;
            items.push({ id: h.documentId, title: h.document, sub: h.heading ? `${h.kb} · ${h.heading}` : h.kb, snippet: sn?.text ?? null, highlights: sn?.highlights ?? [], label: h.label, at: null, route: `knowledge?kb=${h.kbId}` });
          }
        }
        return { total: null, items };
      }
      case 'groups': {
        if (!plain) return { items: [], total: 0 };
        const rows = (await s.groups.list(p, { workspaceId: null, mine: false, category: null, near: null, search: plain })) as { id: string; name: string; label: Label; description?: string | null; members?: number }[];
        return { total: rows.length, items: rows.slice(0, limit).map((g) => ({ id: g.id, title: g.name, sub: g.description ?? null, snippet: null, highlights: [], label: g.label, at: null, route: `groups?group=${g.id}` })) };
      }
      case 'people': {
        if (!plain) return { items: [], total: 0 };
        const rows = await s.social.directory(p, plain, 200);
        return { total: rows.length, items: rows.slice(0, limit).map((u) => ({ id: u.userId, title: u.displayName || u.username, sub: `@${u.username}`, snippet: null, highlights: [], label: null, at: null, route: `person?user=${u.userId}` })) };
      }
      case 'apps': {
        if (!plain) return { items: [], total: 0 };
        const items: Item[] = [];
        let entities = 0;
        for (const app of (await s.apps.list(p)).slice(0, APP_LIMIT)) {
          for (const entity of await s.apps.entities(app)) {
            if (items.length >= limit || entities >= ENTITY_LIMIT) break;
            if (!clears(p.clearance, entity.label)) continue;
            entities++;
            try {
              const out = await s.apps.query(p, app.id, entity.id, { q: plain, limit: limit - items.length, count: false });
              const tf = titleFieldOf(entity.definition);
              for (const r of out.records) items.push({ id: r.id, title: String((tf ? r.values[tf] : null) ?? `${entity.title} ${r.id.slice(-6)}`), sub: `${app.name} · ${entity.title}`, snippet: null, highlights: [], label: r.label, at: r.updatedAt ?? null, route: `apps?app=${app.id}` });
            } catch (err) {
              // An entity the reader's policies keep them out of answers 403 or 404: it has nothing for them.
              if (!(err instanceof HttpProblem)) throw err;
            }
          }
        }
        return { total: null, items };
      }
      case 'assistant': {
        if (!plain) return { items: [], total: 0 };
        const needle = plain.toLowerCase();
        const rows = (await s.chat.listConversations(p, { limit: 200 })).filter((c) => clears(p.clearance, c.label) && (c.title ?? '').toLowerCase().includes(needle));
        return { total: rows.length, items: rows.slice(0, limit).map((c) => ({ id: c.id, title: c.title ?? 'Untitled', sub: null, snippet: null, highlights: [], label: c.label, at: c.updatedAt, route: `chat?id=${c.id}` })) };
      }
    }
  }

  /** The one search: results grouped by source, in the order of SOURCES. */
  async search(p: Principal, input: { q: string; sources?: Source[] | undefined; limit?: number | undefined; typeahead?: boolean | undefined }): Promise<{ q: string; groups: Group[]; engine: 'index' | 'fallback' }> {
    const s = this.s();
    const allowed = this.sourcesFor(p);
    const want = input.sources?.length ? allowed.filter((x) => input.sources!.includes(x)) : allowed;
    const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
    const groups = await Promise.all(
      want.map(async (src): Promise<Group> => {
        const info = SOURCE_INFO[src];
        try {
          const r = await this.one(p, src, input.q, limit, !!input.typeahead);
          return { source: src, title: info.title, items: r.items, total: r.total, error: null, route: src === 'chats' || src === 'posts' ? `search?q=${encodeURIComponent(input.q)}&source=${src}` : info.route };
        } catch (err) {
          s.log.debug({ err: (err as Error).message, source: src }, 'search source unavailable');
          const status = err instanceof HttpProblem ? err.status : 500;
          return { source: src, title: info.title, items: [], total: null, error: status === 403 || status === 404 ? 'Nothing you can read here.' : 'This source could not be searched just now.', route: info.route };
        }
      })
    );
    const engine = (await s.search.index.readVersion(p.tenantId)) != null ? 'index' : 'fallback';
    return { q: input.q, groups, engine };
  }

  /** Type-ahead: a few results per source with the last word as a prefix, and words that complete it. */
  async suggest(p: Principal, q: string, sources?: Source[]) {
    const out = await this.search(p, { q, sources, limit: 3, typeahead: true });
    const pq = parseQuery(q, { typeahead: true });
    const words = new Map<string, number>();
    for (const g of out.groups) for (const it of g.items) for (const w of [...completions(it.snippet ?? '', pq), ...completions(it.title, pq)]) words.set(w, (words.get(w) ?? 0) + 1);
    const completed = [...words].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([w]) => w);
    return { ...out, completions: completed };
  }
}
