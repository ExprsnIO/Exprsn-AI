import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { clears, highest, labelRank, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';

/*
 * 1.8.0, Sprint 48 (B-149): "Was this helpful?" on knowledge. A reader answers thumbs up or down, with an optional
 * comment, about a document, a reference or a document a chat answer cited. The comment passes the `user-input`
 * guardrail like a post (a block or a hold refuses it, a redaction is what is kept) and is sealed with the row id as
 * associated data (`kfb:<id>`); for a citation the reader may also let curators use the question they asked as a test
 * case (sealed the same way, `kfbq:<id>`). One answer per person and target: answering again replaces it.
 *
 * Who sees what:
 * - Anyone who may read the target may answer, and sees their own answer.
 * - The counts, the comments, the curation list and the eval seed are for the base's editors and curators
 *   (`KnowledgeRevisions.duties`: manage access or a named editor), and only over the documents and references they
 *   can read now (label, row access, unpublished references), so feedback never reveals a page.
 *
 * The eval seed is the negative answers as an eval set in the shape `POST /api/admin/profiles/:id/eval-sets` takes
 * (`evals/service.ts` `evalSetBody`): one case per answer, a rubric for a judge profile, not gating. It is a seed: a
 * profile admin picks the profile and the judge and saves it there, where the evaluation service checks it again.
 */

export const FEEDBACK_ORIGINS = ['document', 'reference', 'citation'] as const;
export type FeedbackOrigin = (typeof FEEDBACK_ORIGINS)[number];
const MAX_COMMENT = 1000;
const RECENT_MS = 30 * 24 * 3600_000;
/** Low helpfulness: at least this many answers, and fewer than this share helpful. */
export const CURATION = { minAnswers: 3, below: 0.5 } as const;

const id26 = z.string().regex(/^[0-9A-Za-z]{26}$/);
export const feedbackTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('document'), id: id26 }).strict(),
  z.object({ kind: z.literal('reference'), id: id26 }).strict(),
  z.object({ kind: z.literal('citation'), conversationId: id26, messageId: id26, n: z.number().int().min(1).max(100) }).strict()
]);
export type FeedbackTarget = z.infer<typeof feedbackTarget>;
export const feedbackBody = z.object({ target: feedbackTarget, helpful: z.boolean(), comment: z.string().trim().max(MAX_COMMENT).optional(), shareQuestion: z.boolean().optional() }).strict();

interface Resolved {
  kbId: string;
  kbName: string;
  documentId: string | null;
  referenceId: string | null;
  title: string;
  label: Label;
  messageId: string | null;
  targetKey: string;
  question: string | null;
}

interface FeedbackRow {
  id: string;
  tenant_id: string;
  kb_id: string;
  document_id: string | null;
  reference_id: string | null;
  origin: FeedbackOrigin;
  message_id: string | null;
  target_key: string;
  user_id: string;
  user_name: string;
  helpful: boolean;
  comment: string | null;
  question: string | null;
  label: Label;
  created_at: number;
  updated_at: number;
}
const fromRow = (r: Record<string, unknown>): FeedbackRow => ({ ...(r as unknown as FeedbackRow), helpful: r.helpful === true || r.helpful === 1 || r.helpful === '1', created_at: Number(r.created_at), updated_at: Number(r.updated_at) });

export class KnowledgeFeedback {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  /** The reference a document serves now, if any. */
  private async referenceOfDoc(tenantId: string, documentId: string): Promise<{ id: string; title: string; label: Label } | null> {
    const r = (await this.db('knowledge_references').where({ tenant_id: tenantId, document_id: documentId }).whereNot({ state: 'retired' }).first('id', 'title', 'label')) as { id: string; title: string; label: Label } | undefined;
    return r ?? null;
  }

  /** What the feedback is about, checked readable by the caller. */
  private async resolve(p: Principal, t: FeedbackTarget, shareQuestion: boolean): Promise<Resolved> {
    const s = this.s();
    if (t.kind === 'document') {
      const { doc, kb } = await s.knowledge.documentFor(p, t.id);
      if (doc.state === 'hidden' || doc.state === 'removed') throw notFound('Document');
      const ref = await this.referenceOfDoc(p.tenantId, doc.id);
      return { kbId: kb.id, kbName: kb.name, documentId: doc.id, referenceId: ref?.id ?? null, title: ref?.title ?? doc.name, label: doc.label, messageId: null, targetKey: ref ? `ref:${ref.id}` : `doc:${doc.id}`, question: null };
    }
    if (t.kind === 'reference') {
      const ref = (await s.knowledgeRevisions.reference(p, t.id)) as { id: string; kbId: string; kb: string; title: string; label: Label; documentId: string | null; state: string };
      if (ref.state !== 'published') throw new HttpProblem(409, 'Conflict', 'Only a published reference takes feedback.');
      return { kbId: ref.kbId, kbName: ref.kb, documentId: ref.documentId, referenceId: ref.id, title: ref.title, label: ref.label, messageId: null, targetKey: `ref:${ref.id}`, question: null };
    }
    // A citation of an answer in one of the caller's own conversations.
    const conv = await s.chat.conversation(p, t.conversationId);
    const m = (await this.db('messages').where({ conversation_id: conv.id, id: t.messageId, role: 'assistant' }).first('id', 'tenant_id', 'parent_id', 'citations', 'label', 'state')) as { id: string; tenant_id: string; parent_id: string | null; citations: string | null; label: Label; state: string } | undefined;
    if (!m || m.state === 'held' || m.state === 'hidden') throw notFound('Message');
    const cites = m.citations ? json<{ n: number; kind?: string; documentId?: string }[]>(await s.keys.open(m.tenant_id, m.citations, `citations:${m.id}`), []) : [];
    const c = cites.find((x) => Number(x.n) === t.n && x.kind === 'knowledge' && typeof x.documentId === 'string');
    if (!c) throw notFound('Citation');
    // The reader must still be able to read the document the answer cited.
    const { doc, kb } = await s.knowledge.documentFor(p, c.documentId!);
    const ref = await this.referenceOfDoc(p.tenantId, doc.id);
    let question: string | null = null;
    if (shareQuestion && m.parent_id) {
      const q = (await this.db('messages').where({ conversation_id: conv.id, id: m.parent_id, role: 'user' }).first('id', 'tenant_id', 'content')) as { id: string; tenant_id: string; content: string | null } | undefined;
      if (q?.content) question = (await s.keys.open(q.tenant_id, q.content, `content:${q.id}`)).slice(0, 4000);
    }
    return { kbId: kb.id, kbName: kb.name, documentId: doc.id, referenceId: ref?.id ?? null, title: ref?.title ?? doc.name, label: question ? highest(doc.label, m.label) : doc.label, messageId: m.id, targetKey: `cite:${m.id}:${doc.id}`, question };
  }

  /** Screens a comment at `user-input`; returns the text to keep. */
  private async screen(p: Principal, text: string, label: Label, kbId: string): Promise<string> {
    const d = await this.s().guardrails.check({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, checkpoint: 'user-input', text, label, principal: p, source: { kind: 'knowledge-feedback', id: kbId }, meta: { objectType: 'knowledge-feedback', kb: kbId } });
    if (d.action === 'block' || d.action === 'require-approval') throw new HttpProblem(422, 'Blocked by guardrails', d.reason ?? 'Your comment was blocked by a guardrail rule.', { extensions: { step: 'guardrails', action: d.action, field: 'comment' } });
    return d.action === 'redact' ? d.text : text;
  }

  private async view(r: FeedbackRow, withText: boolean) {
    const k = this.s().keys;
    return {
      id: r.id,
      kbId: r.kb_id,
      documentId: r.document_id,
      referenceId: r.reference_id,
      origin: r.origin,
      helpful: r.helpful,
      comment: withText && r.comment ? await k.open(r.tenant_id, r.comment, `kfb:${r.id}`) : null,
      hasComment: !!r.comment,
      label: r.label,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    };
  }

  /** Records (or replaces) the caller's answer about a target. */
  async give(p: Principal, input: z.infer<typeof feedbackBody>, ctx: { ip?: string | null; traceId?: string | null } = {}) {
    const s = this.s();
    const t = await this.resolve(p, input.target, !!input.shareQuestion);
    const comment = input.comment ? await this.screen(p, input.comment, t.label, t.kbId) : '';
    const existing = (await this.db('knowledge_feedback').where({ tenant_id: p.tenantId, user_id: p.userId, target_key: t.targetKey }).first()) as Record<string, unknown> | undefined;
    const id = existing ? String(existing.id) : ulid();
    const now = Date.now();
    const row = {
      tenant_id: p.tenantId,
      kb_id: t.kbId,
      document_id: t.documentId,
      reference_id: t.referenceId,
      origin: input.target.kind,
      message_id: t.messageId,
      target_key: t.targetKey,
      user_id: p.userId,
      user_name: (p.displayName || p.username || p.userId).slice(0, 200),
      helpful: input.helpful,
      comment: comment ? await s.keys.seal(p.tenantId, comment, `kfb:${id}`) : null,
      question: t.question ? await s.keys.seal(p.tenantId, t.question, `kfbq:${id}`) : null,
      label: t.label,
      updated_at: now
    };
    if (existing) await this.db('knowledge_feedback').where({ id }).update(row);
    else await this.db('knowledge_feedback').insert({ id, ...row, created_at: now });
    await s.audit.append({ tenantId: p.tenantId, action: existing ? 'knowledge.feedback.changed' : 'knowledge.feedback.given', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { kb: t.kbId, feedback: id, ...(t.documentId ? { document: t.documentId } : {}), ...(t.referenceId ? { reference: t.referenceId } : {}), ...(t.messageId ? { message: t.messageId } : {}) }, label: t.label, detail: { origin: input.target.kind, helpful: input.helpful, comment: !!comment, redacted: !!comment && comment !== input.comment, question: !!t.question }, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
    return this.view(fromRow((await this.db('knowledge_feedback').where({ id }).first()) as Record<string, unknown>), true);
  }

  /** The caller's own answer about a target, or null. */
  async mine(p: Principal, t: FeedbackTarget) {
    const r = await this.resolve(p, t, false);
    const row = (await this.db('knowledge_feedback').where({ tenant_id: p.tenantId, user_id: p.userId, target_key: r.targetKey }).first()) as Record<string, unknown> | undefined;
    return { target: { kbId: r.kbId, documentId: r.documentId, referenceId: r.referenceId, title: r.title }, mine: row ? await this.view(fromRow(row), true) : null };
  }

  /** Withdraws one of the caller's answers. */
  async withdraw(p: Principal, id: string, ctx: { ip?: string | null; traceId?: string | null } = {}): Promise<void> {
    const r = (await this.db('knowledge_feedback').where({ tenant_id: p.tenantId, user_id: p.userId, id }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Feedback');
    const row = fromRow(r);
    await this.db('knowledge_feedback').where({ id }).delete();
    await this.s().audit.append({ tenantId: p.tenantId, action: 'knowledge.feedback.withdrawn', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { kb: row.kb_id, feedback: id }, label: row.label, detail: { origin: row.origin }, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
  }

  // ---------- for editors and curators ----------

  /** The base's documents and references the caller can read now, and whether they may see feedback at all. */
  private async readable(p: Principal, kbId: string) {
    const s = this.s();
    const d = await s.knowledgeRevisions.duties(p, kbId);
    if (!d.edit) throw forbidden('Feedback on a knowledge base is for its editors and curators.', { step: 'role', action: 'knowledge:manage' });
    const docs = new Map(((await s.knowledge.documents(p, kbId, { limit: 1000 })) as { id: string; name: string; label: Label }[]).map((x) => [x.id, x]));
    const refs = new Map(((await s.knowledgeRevisions.references(p, kbId)) as { id: string; slug: string; title: string; label: Label; documentId: string | null }[]).map((x) => [x.id, x]));
    return { kb: d.kb, docs, refs };
  }

  /** Rows of the base the caller may see: their label cleared and their document or reference readable. */
  private async rowsFor(p: Principal, kbId: string) {
    const u = await this.readable(p, kbId);
    const rows = ((await this.db('knowledge_feedback').where({ tenant_id: p.tenantId, kb_id: kbId }).orderBy('updated_at', 'desc')) as Record<string, unknown>[]).map(fromRow).filter((r) => clears(p.clearance, r.label) && (r.reference_id ? u.refs.has(r.reference_id) : !!r.document_id && u.docs.has(r.document_id)));
    return { ...u, rows };
  }

  private groupKey = (r: FeedbackRow) => (r.reference_id ? `ref:${r.reference_id}` : `doc:${r.document_id}`);

  /** Counts per document or reference, and the curation list. */
  async stats(p: Principal, kbId: string) {
    const { kb, docs, refs, rows } = await this.rowsFor(p, kbId);
    const now = Date.now();
    const groups = new Map<string, { key: string; documentId: string | null; referenceId: string | null; title: string; slug: string | null; label: Label; up: number; down: number; comments: number; recentNegative: number; lastNegativeAt: number | null; lastAt: number }>();
    for (const r of rows) {
      const key = this.groupKey(r);
      let g = groups.get(key);
      if (!g) {
        const ref = r.reference_id ? refs.get(r.reference_id) : undefined;
        const doc = r.document_id ? docs.get(r.document_id) : undefined;
        g = { key, documentId: ref?.documentId ?? r.document_id, referenceId: r.reference_id, title: ref?.title ?? doc?.name ?? 'Document', slug: ref?.slug ?? null, label: r.label, up: 0, down: 0, comments: 0, recentNegative: 0, lastNegativeAt: null, lastAt: 0 };
        groups.set(key, g);
      }
      if (labelRank(r.label) > labelRank(g.label)) g.label = r.label;
      if (r.helpful) g.up++;
      else {
        g.down++;
        g.lastNegativeAt = Math.max(g.lastNegativeAt ?? 0, r.updated_at);
        if (r.comment && now - r.updated_at <= RECENT_MS) g.recentNegative++;
      }
      if (r.comment) g.comments++;
      g.lastAt = Math.max(g.lastAt, r.updated_at);
    }
    const items = [...groups.values()].map((g) => ({ ...g, total: g.up + g.down, helpfulness: g.up + g.down ? g.up / (g.up + g.down) : null }));
    const curation = items
      .map((g) => ({ ...g, reasons: [...(g.total >= CURATION.minAnswers && (g.helpfulness ?? 1) < CURATION.below ? ['low helpfulness'] : []), ...(g.recentNegative ? ['recent negative comment'] : [])] }))
      .filter((g) => g.reasons.length)
      .sort((a, b) => (a.helpfulness ?? 1) - (b.helpfulness ?? 1) || (b.lastNegativeAt ?? 0) - (a.lastNegativeAt ?? 0));
    items.sort((a, b) => b.total - a.total || a.title.localeCompare(b.title));
    return { kbId: kb.id, kb: kb.name, rule: { minAnswers: CURATION.minAnswers, below: CURATION.below, recentDays: RECENT_MS / 86_400_000 }, totals: { answers: rows.length, helpful: rows.filter((r) => r.helpful).length, notHelpful: rows.filter((r) => !r.helpful).length }, items, curation };
  }

  /** The answers about one document or reference, with their comments, newest first. */
  async comments(p: Principal, kbId: string, of: { documentId?: string | undefined; referenceId?: string | undefined }) {
    const { rows } = await this.rowsFor(p, kbId);
    const pick = rows.filter((r) => (of.referenceId ? r.reference_id === of.referenceId : of.documentId ? r.document_id === of.documentId && !r.reference_id : true));
    return Promise.all(pick.slice(0, 200).map(async (r) => ({ ...(await this.view(r, true)), by: r.user_name, question: !!r.question })));
  }

  /**
   * The negative answers as an eval-set seed (`evalSetBody`): one case per answer with a comment or a shared
   * question, at most 100, newest first. Audited, since it hands the comments on.
   */
  async evalSeed(p: Principal, kbId: string, ctx: { ip?: string | null; traceId?: string | null } = {}) {
    const s = this.s();
    const { kb, docs, refs, rows } = await this.rowsFor(p, kbId);
    const negative = rows.filter((r) => !r.helpful && (r.comment || r.question)).slice(0, 100);
    let label: Label = 'public';
    const cases = [];
    for (const [i, r] of negative.entries()) {
      const ref = r.reference_id ? refs.get(r.reference_id) : undefined;
      const title = ref?.title ?? (r.document_id ? docs.get(r.document_id)?.name : undefined) ?? 'the document';
      const comment = r.comment ? (await s.keys.open(r.tenant_id, r.comment, `kfb:${r.id}`)).replace(/\s+/g, ' ').trim() : '';
      const question = r.question ? (await s.keys.open(r.tenant_id, r.question, `kfbq:${r.id}`)).trim() : '';
      label = highest(label, r.label);
      cases.push({
        id: `feedback-${i + 1}`,
        name: `${title}: ${comment || 'answer marked unhelpful'}`.slice(0, 200),
        prompt: (question || `Using the knowledge base ${kb.name}, what does "${title}" say${comment ? ` about this: ${comment}` : ''}?`).slice(0, 20_000),
        checks: [{ kind: 'judge' as const, rubric: `The answer draws on "${title}"${ref ? ` (reference ${ref.slug})` : ''} in the knowledge base ${kb.name} and gives the reader what they needed. A reader marked an earlier answer unhelpful${comment ? `, saying: "${comment}"` : ''}.`.slice(0, 4000), minScore: 0.6 }]
      });
    }
    const seed = { name: `Knowledge feedback: ${kb.name}`.slice(0, 120), description: `Negative feedback on ${kb.name} up to ${new Date().toISOString().slice(0, 10)}, from the knowledge feedback export.`.slice(0, 500), label, threshold: 0.8, gate: false, judgeProfile: null, cases };
    await s.audit.append({ tenantId: p.tenantId, action: 'knowledge.feedback.exported', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { kb: kb.id, name: kb.name }, label, detail: { cases: cases.length, format: 'eval-set-seed' }, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
    return { seed, cases: cases.length, use: 'Choose the profile to test and a judge profile, set judgeProfile, and save it as an eval set of that profile (POST /api/admin/profiles/:id/eval-sets, or Profiles, Evaluations). The evaluation service checks it again there.' };
  }
}
