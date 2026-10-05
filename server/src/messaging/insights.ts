import { actorFrom } from '../audit/chain.js';
import { labelRank } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { generate, ModelUnavailable } from '../apps/ai.js';
import { conflict, HttpProblem, notFound } from '../http/problem.js';
import { rrf, tokenize } from '../knowledge/terms.js';
import type { Services } from '../services.js';
import { messageFrom, VECTOR_COLLECTION, type Access, type Ctx, type MessageRow } from './service.js';

/*
 * Search, summaries and catch-up digests in a conversation (B-2605). Everything starts from what the reader can see
 * in it now: messages since they joined, not deleted or hidden, and none from people in a block with them. Search
 * ranks by keyword (keyed-hash terms, like knowledge) and, when MESSAGING_EMBED_MODEL is set, by meaning (vectors in
 * the conversation's partition), fused by reciprocal rank. Summaries and digests send only those messages, numbered,
 * to a profile through the gateway; citations in the answer are kept only when they name one of those numbers, so a
 * summary never points at a message its reader cannot see.
 */

export const SEARCH_MODES = ['keyword', 'semantic', 'hybrid'] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

const SYSTEM = [
  'You summarise a workplace conversation for one of its members.',
  'Use only the numbered messages below; do not add facts.',
  'After each point, cite the messages it comes from by their numbers in square brackets, like [2] or [3][5].',
  'Never cite a number that is not in the list. Be brief: a few short points.'
].join(' ');

const PER_MESSAGE = 2000;

export interface Citation {
  n: number;
  messageId: string;
}

/** Keeps the citations that name a given message and removes the others from the text. */
export function citeOnly(text: string, ids: string[]): { text: string; citations: Citation[] } {
  const seen = new Map<number, string>();
  const out = text.replace(/\[(\d{1,5})\]/g, (whole, digits: string) => {
    const n = Number(digits);
    const id = n >= 1 && n <= ids.length ? ids[n - 1] : undefined;
    if (!id) return '';
    seen.set(n, id);
    return whole;
  });
  return { text: out.replace(/[ \t]+([.,;:])/g, '$1').trim(), citations: [...seen].sort((a, b) => a[0] - b[0]).map(([n, messageId]) => ({ n, messageId })) };
}

export class MessagingInsights {
  constructor(
    private readonly s: () => Services,
    private readonly o: { summaryProfile: string; maxMessages: number }
  ) {}

  private get db() {
    return this.s().db;
  }

  private get svc() {
    return this.s().messaging;
  }

  /** Messages by id, in the given order, that the reader can see and that are live. */
  private async visible(a: Access, ids: string[]): Promise<MessageRow[]> {
    if (!ids.length) return [];
    const rows = ((await this.db('dm_messages').where({ conversation_id: a.conv.id, state: 'sent' }).whereIn('id', ids)) as Record<string, unknown>[]).map(messageFrom);
    const byId = new Map(rows.filter((m) => this.svc.sees(a, m)).map((m) => [m.id, m]));
    return ids.map((id) => byId.get(id)).filter((m): m is MessageRow => !!m);
  }

  async search(p: Principal, id: string, q: { q: string; mode?: SearchMode | undefined; limit?: number | undefined }) {
    const s = this.s();
    const a = await this.svc.require(p, id, 'read');
    const model = this.svc.embedModel;
    const mode: SearchMode = q.mode ?? (model ? 'hybrid' : 'keyword');
    if (mode !== 'keyword' && !model) throw conflict('Semantic search is not set up here (MESSAGING_EMBED_MODEL); search by keyword.');
    const limit = Math.min(q.limit ?? 20, 100);
    const lists: string[][] = [];
    const keyword = new Map<string, number>();
    const semantic = new Map<string, number>();
    if (mode !== 'semantic') {
      const words = [...new Set(tokenize(q.q))];
      if (words.length) {
        const hashed = await s.knowledge.terms.terms(p.tenantId, words);
        const rows = (await this.db('dm_terms').where({ conversation_id: id }).whereIn('term', [...hashed.values()]).select('message_id', 'term', 'tf')) as { message_id: string; term: string; tf: number }[];
        const terms = new Map<string, Set<string>>();
        const tf = new Map<string, number>();
        for (const r of rows) {
          terms.set(r.message_id, (terms.get(r.message_id) ?? new Set()).add(r.term));
          tf.set(r.message_id, (tf.get(r.message_id) ?? 0) + Number(r.tf));
        }
        // More of the words first, then how often; newer first on a tie (ULIDs sort by time).
        for (const [mid, set] of terms) keyword.set(mid, set.size / words.length + Math.min(tf.get(mid) ?? 0, 20) / 1000);
        lists.push([...keyword].sort((x, y) => y[1] - x[1] || (y[0] < x[0] ? -1 : 1)).slice(0, 200).map(([mid]) => mid));
      }
    }
    if (mode !== 'keyword' && model) {
      let vector: number[];
      try {
        [vector] = (await s.knowledge.embed(p.tenantId, model, [q.q], a.conv.label, p.userId)) as [number[]];
      } catch (err) {
        throw new HttpProblem(503, 'Model unavailable', `The embedding model could not be reached: ${(err as Error).message}`);
      }
      const hits = await s.vectors.search(VECTOR_COLLECTION, { tenantId: p.tenantId, vector, k: 100, maxLabelRank: labelRank(p.clearance), partitions: [id] });
      for (const h of hits) semantic.set(h.id, h.score);
      lists.push(hits.map((h) => h.id));
    }
    const fused = rrf(lists);
    const ranked = [...fused].sort((x, y) => y[1] - x[1]).map(([mid]) => mid);
    const rows = (await this.visible(a, ranked)).slice(0, limit);
    const views = await this.svc.views(a, rows);
    return views.map((v) => ({ ...v, score: { fused: Number((fused.get(v.id) ?? 0).toFixed(5)), keyword: keyword.has(v.id) ? Number(keyword.get(v.id)!.toFixed(4)) : null, semantic: semantic.has(v.id) ? Number(semantic.get(v.id)!.toFixed(4)) : null } }));
  }

  /** Summarises a thread, or the latest messages, from what the caller can see. */
  async summary(ctx: Ctx, id: string, input: { threadId?: string | undefined; profile?: string | undefined; limit?: number | undefined }) {
    const p = ctx.p;
    const a = await this.svc.require(p, id, 'read');
    const limit = Math.min(input.limit ?? this.o.maxMessages, this.o.maxMessages);
    let rows: MessageRow[];
    if (input.threadId) {
      const root = await this.svc.messageRow(p.tenantId, input.threadId);
      if (!root || !this.svc.sees(a, root)) throw notFound('Thread');
      const rootId = root.thread_id ?? root.id;
      rows = ((await this.db('dm_messages').where({ conversation_id: id, state: 'sent' }).andWhere((q) => q.where({ id: rootId }).orWhere({ thread_id: rootId })).orderBy('created_at').orderBy('id').limit(limit * 2)) as Record<string, unknown>[]).map(messageFrom);
    } else {
      rows = ((await this.db('dm_messages').where({ conversation_id: id, state: 'sent' }).andWhere('created_at', '>=', a.me.visible_from).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit * 2)) as Record<string, unknown>[]).map(messageFrom).reverse();
    }
    rows = rows.filter((m) => this.svc.sees(a, m)).slice(-limit);
    return this.summarise(ctx, a, rows, input.threadId ? 'thread' : 'recent', input.profile);
  }

  /** A catch-up digest of what the caller has not read yet (from others), oldest first. */
  async digest(ctx: Ctx, id: string, input: { profile?: string | undefined }) {
    const p = ctx.p;
    const a = await this.svc.require(p, id, 'read');
    let after = a.me.visible_from;
    if (a.me.last_read_id) {
      const r = (await this.db('dm_messages').where({ id: a.me.last_read_id }).first('created_at')) as { created_at: number } | undefined;
      if (r) after = Math.max(after, Number(r.created_at) + 1);
    }
    const rows = ((await this.db('dm_messages').where({ conversation_id: id, state: 'sent' }).andWhere('created_at', '>=', after).whereNot({ author_id: p.userId }).orderBy('created_at').orderBy('id').limit(this.o.maxMessages * 2)) as Record<string, unknown>[])
      .map(messageFrom)
      .filter((m) => this.svc.sees(a, m))
      .slice(0, this.o.maxMessages);
    return this.summarise(ctx, a, rows, 'digest', input.profile);
  }

  private async summarise(ctx: Ctx, a: Access, rows: MessageRow[], kind: 'thread' | 'recent' | 'digest', profileName?: string) {
    const s = this.s();
    const p = ctx.p;
    const profile = profileName ?? this.o.summaryProfile;
    const base = { conversationId: a.conv.id, kind, profile, messages: rows.length, from: rows[0]?.created_at ?? null, to: rows[rows.length - 1]?.created_at ?? null };
    if (!rows.length) return { ...base, summary: null, citations: [] as Citation[] };
    const names = new Map(((await this.db('users').where({ tenant_id: p.tenantId }).whereIn('id', [...new Set(rows.map((m) => m.author_id))]).select('id', 'display_name')) as { id: string; display_name: string }[]).map((u) => [u.id, u.display_name]));
    const lines: string[] = [];
    for (const [i, m] of rows.entries()) {
      const text = ((await this.svc.openBody(m)) ?? '').replace(/\s+/g, ' ').slice(0, PER_MESSAGE);
      lines.push(`[${i + 1}] ${names.get(m.author_id) ?? 'Someone'} (${new Date(m.created_at).toISOString().slice(0, 16).replace('T', ' ')} UTC): ${text}`);
    }
    const what = kind === 'digest' ? 'Write a catch-up digest of these unread messages.' : kind === 'thread' ? 'Summarise this thread.' : 'Summarise these recent messages.';
    let answer: string;
    try {
      answer = await generate(s, { tenantId: p.tenantId, workspaceId: a.conv.workspace_id, profile, system: SYSTEM, prompt: `${what}\n\nMessages:\n${lines.join('\n')}`, label: a.conv.label, principal: p, userId: p.userId, source: { kind: 'dm-summary', id: a.conv.id } });
    } catch (err) {
      if (err instanceof HttpProblem) throw err;
      if (err instanceof ModelUnavailable) throw new HttpProblem(503, 'Model unavailable', err.message);
      throw new HttpProblem(503, 'Model unavailable', `The model could not be reached: ${(err as Error).message}`);
    }
    const cited = citeOnly(answer, rows.map((m) => m.id));
    await s.audit.append({ tenantId: p.tenantId, action: 'messaging.summary.created', kind: 'admin', actor: actorFrom(p, ctx.ip), target: { conversation: a.conv.id }, label: a.conv.label, detail: { kind, profile, messages: rows.length, citations: cited.citations.length }, traceId: ctx.traceId ?? null });
    return { ...base, summary: cited.text, citations: cited.citations };
  }
}
