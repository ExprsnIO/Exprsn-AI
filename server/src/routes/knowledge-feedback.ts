import { Router, type Request } from 'express';
import { z } from 'zod';
import { badRequest } from '../http/problem.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { feedbackBody, type FeedbackTarget } from '../knowledge/feedback.js';
import type { Services } from '../services.js';

const id26 = z.string().regex(/^[0-9A-Za-z]{26}$/);

/**
 * 1.8.0, Sprint 48 (B-149): knowledge feedback and the reference tree. Every route needs `knowledge:read`, the
 * permission that reads knowledge at all; the services then apply the base's own access: answering needs the target
 * readable, the counts, comments, curation list and eval seed need to be an editor or curator of the base, and moving a
 * reference needs to be its editor. Nothing a reader cannot read is listed. Changes are audited
 * (`knowledge.feedback.given`, `.changed`, `.withdrawn`, `.exported`, `knowledge.reference.moved`).
 */
export function knowledgeFeedbackRoutes(s: Services): Router {
  const r = Router();
  const read = requirePermission(s, 'knowledge:read');
  r.use(['/knowledge/feedback', '/knowledge/bases/:id/feedback', '/knowledge/bases/:id/tree', '/knowledge/references/:id/tree'], noStore, requireAuth(), read);
  const ctx = (req: Request) => ({ ip: ip(req), traceId: req.traceId ?? null });
  const kbId = (req: Request) => parseBody(id26, req.params.id);

  // ---------- answering ----------

  r.post('/knowledge/feedback', async (req, res) => {
    const b = parseBody(feedbackBody, req.body);
    res.status(201).json(await s.knowledgeFeedback.give(principalOf(req), b, ctx(req)));
  });

  // The caller's own answer about a target: ?document=, ?reference=, or ?conversation=&message=&n= for a citation.
  r.get('/knowledge/feedback/mine', async (req, res) => {
    const q = parseBody(z.object({ document: id26.optional(), reference: id26.optional(), conversation: id26.optional(), message: id26.optional(), n: z.coerce.number().int().min(1).max(100).optional() }).strict(), req.query);
    const target: FeedbackTarget | null = q.document ? { kind: 'document', id: q.document } : q.reference ? { kind: 'reference', id: q.reference } : q.conversation && q.message && q.n ? { kind: 'citation', conversationId: q.conversation, messageId: q.message, n: q.n } : null;
    if (!target) throw badRequest('Name a document, a reference, or a conversation, message and citation number.');
    res.json(await s.knowledgeFeedback.mine(principalOf(req), target));
  });

  r.delete('/knowledge/feedback/:fid', async (req, res) => {
    await s.knowledgeFeedback.withdraw(principalOf(req), parseBody(id26, req.params.fid), ctx(req));
    res.status(204).end();
  });

  // ---------- for the base's editors and curators ----------

  r.get('/knowledge/bases/:id/feedback', async (req, res) => {
    res.json(await s.knowledgeFeedback.stats(principalOf(req), kbId(req)));
  });

  r.get('/knowledge/bases/:id/feedback/comments', async (req, res) => {
    const q = parseBody(z.object({ document: id26.optional(), reference: id26.optional() }).strict(), req.query);
    res.json({ comments: await s.knowledgeFeedback.comments(principalOf(req), kbId(req), { documentId: q.document, referenceId: q.reference }) });
  });

  r.get('/knowledge/bases/:id/feedback/eval-seed', async (req, res) => {
    res.json(await s.knowledgeFeedback.evalSeed(principalOf(req), kbId(req), ctx(req)));
  });

  // ---------- the reference tree ----------

  r.get('/knowledge/bases/:id/tree', async (req, res) => {
    res.json(await s.knowledgeTree.tree(principalOf(req), kbId(req)));
  });

  r.get('/knowledge/references/:id/tree', async (req, res) => {
    res.json(await s.knowledgeTree.context(principalOf(req), parseBody(id26, req.params.id)));
  });

  r.put('/knowledge/references/:id/tree', async (req, res) => {
    const b = parseBody(z.object({ parentId: id26.nullable(), position: z.number().int().min(0).max(10_000).optional() }).strict(), req.body);
    res.json(await s.knowledgeTree.move(principalOf(req), parseBody(id26, req.params.id), b, ctx(req)));
  });

  return r;
}
