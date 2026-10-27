import { clears, isLabel, LABELS, labelRank, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { conflict, HttpProblem } from '../http/problem.js';
import { rrf, tokenize } from '../knowledge/terms.js';
import { messageFrom, VECTOR_COLLECTION, type Access, type MessageRow } from '../messaging/service.js';
import type { Services } from '../services.js';
import type { SearchIndex } from './indexer.js';
import { matchesText, parseQuery, snippet, hasLink, type ParsedQuery } from './normalise.js';
import type { IndexReader } from './query.js';

/*
 * 1.9.0, Sprint 52 (B-171): search across every conversation the reader is in.
 *
 * - Scope first: the conversations where the reader is a member now, active, at a label they clear, from the time they
 *   could see (`visible_from`), without the people in a block with them. A conversation they left is not in it.
 * - Filters: who wrote it, one conversation, a group's linked conversation, a workspace, dates, has a file or a link,
 *   the label; applied before anything is counted.
 * - Keyword: the blind index (B-170) once the tenant's backfill finished; before that, the per-conversation keyed terms
 *   of B-2605 across the same conversations (no positions: phrases and prefixes are checked on the opened text).
 *   Meaning: the `messaging.embed` vectors in the same conversations, when MESSAGING_EMBED_MODEL is set; fused with
 *   the keyword ranking by reciprocal rank.
 * - Every result is checked again as the reader (`accessOrNull`, clearance, `sees`) before its text is opened; the
 *   answer is a snippet around the match, never the stored text of anything the reader cannot read.
 */

export const CHAT_MODES = ['keyword', 'semantic', 'hybrid'] as const;
export type ChatMode = (typeof CHAT_MODES)[number];
const SCAN_FALLBACK = 2000;

export interface ChatQuery {
  q: string;
  from?: string | undefined;
  conversation?: string | undefined;
  group?: string | undefined;
  workspace?: string | undefined;
  after?: number | undefined;
  before?: number | undefined;
  has?: ('file' | 'link')[] | undefined;
  label?: Label | undefined;
  mode?: ChatMode | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  typeahead?: boolean | undefined;
}

interface Scope {
  convs: Map<string, { visibleFrom: number; label: Label }>;
  blocked: Set<string>;
}

export interface ChatHit {
  kind: 'message';
  id: string;
  conversationId: string;
  conversation: { kind: 'direct' | 'group'; title: string | null; groupId: string | null };
  authorId: string;
  authorName: string | null;
  threadId: string | null;
  createdAt: number;
  label: Label;
  hasFile: boolean;
  snippet: string;
  highlights: [number, number][];
  route: string;
  score: { fused: number; keyword: number | null; semantic: number | null };
}

export class ChatSearch {
  constructor(
    private readonly s: () => Services,
    private readonly index: SearchIndex,
    private readonly reader: IndexReader
  ) {}

  private get db() {
    return this.s().db;
  }

  /** The conversations the reader may search now, by the cheap test (each result is checked in full again). */
  private async scope(p: Principal, q: ChatQuery): Promise<Scope> {
    const s = this.s();
    const cleared = LABELS.filter((l) => clears(p.clearance, l));
    const rows = (await this.db('dm_members as m')
      .join('dm_conversations as c', 'c.id', 'm.conversation_id')
      .where({ 'm.tenant_id': p.tenantId, 'm.user_id': p.userId, 'c.state': 'active' })
      .whereIn('c.label', cleared)
      .modify((qb) => {
        if (q.conversation) qb.andWhere('c.id', q.conversation);
        if (q.workspace) qb.andWhere('c.workspace_id', q.workspace);
        if (q.group) qb.whereIn('c.id', this.db('group_conversations').where({ tenant_id: p.tenantId, group_id: q.group }).select('conversation_id'));
      })
      .select('c.id', 'c.label', 'm.visible_from')) as { id: string; label: string; visible_from: number | string }[];
    const convs = new Map(rows.map((r) => [r.id, { visibleFrom: Number(r.visible_from), label: (isLabel(r.label) ? r.label : 'restricted') as Label }]));
    return { convs, blocked: await s.social.blockedWith(p.tenantId, p.userId) };
  }

  private metaOk(sc: Scope, q: ChatQuery, m: { conversation: string; author: string; created: number; label: string; hasFile: boolean; hasLink: boolean | null }): boolean {
    const c = sc.convs.get(m.conversation);
    if (!c || m.created < c.visibleFrom || sc.blocked.has(m.author)) return false;
    if (q.from && m.author !== q.from) return false;
    if (q.after != null && m.created < q.after) return false;
    if (q.before != null && m.created > q.before) return false;
    if (q.label && m.label !== q.label) return false;
    if (q.has?.includes('file') && !m.hasFile) return false;
    if (q.has?.includes('link') && m.hasLink === false) return false;
    return true;
  }

  /** Keyword ranking from the blind index: message ids best first, and how many matched. */
  private async keywordIndexed(p: Principal, q: ChatQuery, pq: ParsedQuery, sc: Scope, version: number): Promise<{ ids: string[]; scores: Map<string, number> }> {
    const out = await this.reader.search({
      tenantId: p.tenantId,
      version,
      pq,
      kinds: ['message'],
      scopes: [...sc.convs.keys()],
      where: (qb) => {
        if (q.from) qb.andWhere({ author_id: q.from });
        if (q.after != null) qb.andWhere('created_at', '>=', q.after);
        if (q.before != null) qb.andWhere('created_at', '<=', q.before);
        if (q.label) qb.andWhere({ label: q.label });
        if (q.has?.includes('file')) qb.andWhere({ has_file: true });
        if (q.has?.includes('link')) qb.andWhere({ has_link: true });
        if (sc.blocked.size && sc.blocked.size <= 900) qb.whereNotIn('author_id', [...sc.blocked]);
      }
    });
    const kept = out.ranked.filter((r) => this.metaOk(sc, q, { conversation: r.meta.scope_id, author: r.meta.author_id, created: r.meta.created_at, label: r.meta.label, hasFile: r.meta.has_file, hasLink: r.meta.has_link }));
    return { ids: kept.map((r) => r.meta.doc_id), scores: new Map(kept.map((r) => [r.meta.doc_id, r.score])) };
  }

  /** Before the index is ready: the keyed terms of B-2605 across the scope's conversations (every word must match). */
  private async keywordFallback(p: Principal, q: ChatQuery, pq: ParsedQuery, sc: Scope): Promise<{ ids: string[]; scores: Map<string, number> }> {
    const s = this.s();
    const words = [...new Set(pq.units.flatMap((u) => (u.kind === 'term' ? tokenize(u.term) : u.kind === 'phrase' ? u.terms.flatMap((t) => tokenize(t)) : tokenize(u.folded))))];
    const convIds = [...sc.convs.keys()];
    if (!words.length || !convIds.length) return { ids: [], scores: new Map() };
    const hashed = await s.knowledge.terms.terms(p.tenantId, words);
    const found = new Map<string, { terms: Set<string>; tf: number }>();
    for (let i = 0; i < convIds.length; i += 500) {
      const rows = (await this.db('dm_terms').whereIn('conversation_id', convIds.slice(i, i + 500)).whereIn('term', [...hashed.values()]).select('message_id', 'term', 'tf')) as { message_id: string; term: string; tf: number }[];
      for (const r of rows) {
        const f = found.get(r.message_id) ?? { terms: new Set<string>(), tf: 0 };
        f.terms.add(r.term);
        f.tf += Number(r.tf);
        found.set(r.message_id, f);
      }
    }
    const all = [...found].filter(([, f]) => f.terms.size === hashed.size).map(([id]) => id);
    const metas = new Map<string, MessageRow>();
    for (let i = 0; i < all.length; i += 500) for (const r of (await this.db('dm_messages').where({ tenant_id: p.tenantId, state: 'sent' }).whereIn('id', all.slice(i, i + 500))) as Record<string, unknown>[]) metas.set(String(r.id), messageFrom(r));
    const kept = all.filter((id) => {
      const m = metas.get(id);
      return !!m && this.metaOk(sc, q, { conversation: m.conversation_id, author: m.author_id, created: m.created_at, label: m.label, hasFile: m.attachments.length > 0, hasLink: null });
    });
    const scores = new Map(kept.map((id) => [id, found.get(id)!.terms.size + Math.min(found.get(id)!.tf, 20) / 1000]));
    kept.sort((a, b) => scores.get(b)! - scores.get(a)! || (b < a ? -1 : 1));
    return { ids: kept.slice(0, SCAN_FALLBACK), scores };
  }

  /** Meaning: the message vectors of the scope's conversations, filtered like the rest. */
  private async semantic(p: Principal, q: ChatQuery, sc: Scope): Promise<{ ids: string[]; scores: Map<string, number> }> {
    const s = this.s();
    const model = s.messaging.embedModel;
    if (!model || !sc.convs.size) return { ids: [], scores: new Map() };
    let vector: number[];
    try {
      const top = [...sc.convs.values()].reduce<Label>((hi, c) => (labelRank(c.label) > labelRank(hi) ? c.label : hi), 'public');
      [vector] = (await s.knowledge.embed(p.tenantId, model, [q.q], top, p.userId, { workspaceId: p.workspaceId ?? null })) as [number[]];
    } catch (err) {
      throw new HttpProblem(503, 'Model unavailable', `The embedding model could not be reached: ${(err as Error).message}`);
    }
    const hits = await s.vectors.search(VECTOR_COLLECTION, { tenantId: p.tenantId, vector, k: 100, maxLabelRank: labelRank(p.clearance), partitions: [...sc.convs.keys()] });
    const rows = new Map<string, MessageRow>();
    const ids = hits.map((h) => h.id);
    for (let i = 0; i < ids.length; i += 500) for (const r of (await this.db('dm_messages').where({ tenant_id: p.tenantId, state: 'sent' }).whereIn('id', ids.slice(i, i + 500))) as Record<string, unknown>[]) rows.set(String(r.id), messageFrom(r));
    const kept = hits.filter((h) => {
      const m = rows.get(h.id);
      return !!m && this.metaOk(sc, q, { conversation: m.conversation_id, author: m.author_id, created: m.created_at, label: m.label, hasFile: m.attachments.length > 0, hasLink: null });
    });
    return { ids: kept.map((h) => h.id), scores: new Map(kept.map((h) => [h.id, h.score])) };
  }

  async search(p: Principal, q: ChatQuery): Promise<{ items: ChatHit[]; total: number; mode: ChatMode; engine: 'index' | 'fallback' }> {
    const s = this.s();
    const model = s.messaging.embedModel;
    const mode: ChatMode = q.mode ?? (model && !q.typeahead ? 'hybrid' : 'keyword');
    if (mode !== 'keyword' && !model) throw conflict('Search by meaning is not set up here (MESSAGING_EMBED_MODEL); search by keyword.');
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 100);
    const offset = Math.max(q.offset ?? 0, 0);
    const pq = parseQuery(q.q, { typeahead: !!q.typeahead });
    const version = await this.index.readVersion(p.tenantId);
    const engine = version != null ? 'index' : 'fallback';
    const sc = await this.scope(p, q);
    if (!sc.convs.size) return { items: [], total: 0, mode, engine };
    const lists: string[][] = [];
    let keyword = { ids: [] as string[], scores: new Map<string, number>() };
    let meaning = { ids: [] as string[], scores: new Map<string, number>() };
    if (mode !== 'semantic' && pq.units.length) {
      keyword = version != null ? await this.keywordIndexed(p, q, pq, sc, version) : await this.keywordFallback(p, q, pq, sc);
      lists.push(keyword.ids);
    }
    if (mode !== 'keyword') {
      meaning = await this.semantic(p, q, sc);
      lists.push(meaning.ids);
    }
    const fused = rrf(lists);
    const ranked = [...fused].sort((a, b) => b[1] - a[1] || (b[0] < a[0] ? -1 : 1)).map(([id]) => id);
    // The text decides what the index cannot: exact phrases, whole prefixes, links (fallback), for keyword-only hits.
    const textChecked = (id: string) => keyword.scores.has(id) && !meaning.scores.has(id);
    const needsText = engine === 'fallback' || pq.units.some((u) => u.kind !== 'term');
    const items: ChatHit[] = [];
    const access = new Map<string, Access | null>();
    const titles = new Map<string, ChatHit['conversation']>();
    let dropped = 0;
    let skipped = 0;
    for (const id of ranked) {
      if (items.length >= limit) break;
      const m = await s.messaging.messageRow(p.tenantId, id);
      if (!m || m.state !== 'sent') {
        dropped++;
        continue;
      }
      if (!access.has(m.conversation_id)) access.set(m.conversation_id, await s.messaging.accessOrNull(p, m.conversation_id));
      const a = access.get(m.conversation_id)!;
      if (!a || !clears(p.clearance, a.conv.label) || !clears(p.clearance, m.label) || !s.messaging.sees(a, m)) {
        dropped++;
        continue;
      }
      const text = (await s.messaging.openBody(m)) ?? '';
      if (textChecked(id) && needsText && !matchesText(text, pq)) {
        dropped++;
        continue;
      }
      if (q.has?.includes('link') && !hasLink(text)) {
        dropped++;
        continue;
      }
      if (skipped < offset) {
        skipped++;
        continue;
      }
      if (!titles.has(a.conv.id)) titles.set(a.conv.id, await this.conversationTitle(p, a));
      const author = (await this.db('users').where({ tenant_id: p.tenantId, id: m.author_id }).first('display_name')) as { display_name: string } | undefined;
      const sn = snippet(text, pq);
      items.push({
        kind: 'message',
        id: m.id,
        conversationId: m.conversation_id,
        conversation: titles.get(a.conv.id)!,
        authorId: m.author_id,
        authorName: author?.display_name ?? null,
        threadId: m.thread_id,
        createdAt: m.created_at,
        label: m.label,
        hasFile: m.attachments.length > 0,
        snippet: sn.text,
        highlights: sn.highlights,
        route: `messages?convo=${m.conversation_id}&message=${m.id}`,
        score: { fused: Number((fused.get(id) ?? 0).toFixed(5)), keyword: keyword.scores.has(id) ? Number(keyword.scores.get(id)!.toFixed(4)) : null, semantic: meaning.scores.has(id) ? Number(meaning.scores.get(id)!.toFixed(4)) : null }
      });
    }
    return { items, total: Math.max(items.length + offset, ranked.length - dropped), mode, engine };
  }

  /**
   * Where a message is, for a link that opens it in its conversation (1.9.9-qa): its conversation, time and thread
   * when the reader can see it now, `deleted` or `hidden` (a tombstone the reader still sees in the timeline), and
   * `unavailable` for anything else: gone, never theirs, a conversation they left, before they joined, from someone in
   * a block with them, above their clearance. The text is never part of the answer.
   */
  async locate(p: Principal, id: string): Promise<{ id: string; state: 'sent' | 'deleted' | 'hidden' | 'held' | 'unavailable'; conversationId: string | null; createdAt: number | null; threadId: string | null }> {
    const s = this.s();
    const none = { id, state: 'unavailable' as const, conversationId: null, createdAt: null, threadId: null };
    const m = await s.messaging.messageRow(p.tenantId, id);
    if (!m) return none;
    const a = await s.messaging.accessOrNull(p, m.conversation_id);
    if (!a || !clears(p.clearance, a.conv.label) || !s.messaging.sees(a, m)) return none;
    if (m.state === 'sent' && !clears(p.clearance, m.label)) return none;
    const state = m.state === 'rejected' ? 'held' : m.state;
    return { id: m.id, state, conversationId: m.conversation_id, createdAt: m.created_at, threadId: m.thread_id };
  }

  private async conversationTitle(p: Principal, a: Access): Promise<ChatHit['conversation']> {
    const s = this.s();
    const link = a.conv.kind === 'group' ? await s.groups.conversations.ofConversation(a.conv.id) : null;
    if (a.conv.kind === 'group') return { kind: 'group', title: (await s.messaging.openTitle(a.conv)) ?? null, groupId: link?.group_id ?? null };
    const other = (await this.db('dm_members as m').join('users as u', 'u.id', 'm.user_id').where({ 'm.conversation_id': a.conv.id }).whereNot('m.user_id', p.userId).first('u.display_name')) as { display_name: string } | undefined;
    return { kind: 'direct', title: other?.display_name ?? null, groupId: null };
  }
}

