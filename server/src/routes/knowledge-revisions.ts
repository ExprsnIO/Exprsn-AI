import { Router } from 'express';
import { z } from 'zod';
import { LABELS } from '../authz/labels.js';
import { noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { BUMPS, MAX_CONTENT, referenceView, revisionView } from '../knowledge/revisions.js';
import type { Services } from '../services.js';

const id26 = z.string().length(26);
const text = (max: number) => z.string().trim().min(1).max(max);
const content = z.string().min(1).max(MAX_CONTENT);

/**
 * References, revisions and review of a knowledge base (migration 045, `knowledge/revisions.ts`). Reading needs
 * `knowledge:read`; proposing needs to be an editor of the base, deciding an approver, and the review settings manage
 * access to it. The service writes the audit entry of every change.
 */
export function knowledgeRevisionRoutes(s: Services): Router {
  const r = Router();
  const read = requirePermission(s, 'knowledge:read');
  const k = s.knowledgeRevisions;
  r.use(['/knowledge'], noStore, requireAuth());

  // ---------- review settings, editors and approvers ----------

  r.get('/knowledge/bases/:id/review', read, async (req, res) => {
    res.json(await k.settings(principalOf(req), String(req.params.id)));
  });

  r.patch('/knowledge/bases/:id/review', read, async (req, res) => {
    const body = parseBody(z.object({ review: z.enum(['off', 'required']).optional(), workflowId: id26.nullable().optional(), fourEyes: z.boolean().optional() }).strict(), req.body);
    res.json(await k.setSettings(principalOf(req), String(req.params.id), body));
  });

  r.post('/knowledge/bases/:id/reviewers', read, async (req, res) => {
    const body = parseBody(z.object({ duty: z.enum(['editor', 'approver']), kind: z.enum(['user', 'role']), id: z.string().trim().min(1).max(63) }).strict(), req.body);
    res.status(201).json(await k.addReviewer(principalOf(req), String(req.params.id), body));
  });

  r.delete('/knowledge/bases/:id/reviewers/:reviewer', read, async (req, res) => {
    res.json(await k.removeReviewer(principalOf(req), String(req.params.id), String(req.params.reviewer)));
  });

  // ---------- references ----------

  r.get('/knowledge/bases/:id/references', read, async (req, res) => {
    res.json(await k.references(principalOf(req), String(req.params.id)));
  });

  r.get('/knowledge/references/:id', read, async (req, res) => {
    res.json(await k.reference(principalOf(req), String(req.params.id)));
  });

  r.delete('/knowledge/references/:id', read, async (req, res) => {
    res.json(referenceView(await k.retire(principalOf(req), String(req.params.id))));
  });

  // ---------- revisions ----------

  /** Revisions waiting on the caller as an approver, and the caller's own open ones. */
  r.get('/knowledge/reviews', read, async (req, res) => {
    res.json(await k.reviews(principalOf(req)));
  });

  r.post('/knowledge/bases/:id/revisions', read, async (req, res) => {
    const body = parseBody(
      z.object({ reference: text(200).optional(), title: text(300).optional(), content, summary: text(4000), bump: z.enum(BUMPS).optional(), version: text(40).optional(), feature: z.string().trim().max(300).nullable().optional(), label: z.enum(LABELS).optional(), categories: z.array(z.string().max(400)).max(12).optional(), submit: z.boolean().optional() }).strict(),
      req.body
    );
    const p = principalOf(req);
    const { submit, ...input } = body;
    const draft = await k.propose(p, { ...input, kbId: String(req.params.id) });
    res.status(201).json(revisionView(submit ? await k.submit(p, draft.id) : draft));
  });

  r.get('/knowledge/revisions/:id', read, async (req, res) => {
    res.json(await k.revision(principalOf(req), String(req.params.id), { content: true, diff: true }));
  });

  r.patch('/knowledge/revisions/:id', read, async (req, res) => {
    const body = parseBody(z.object({ content: content.optional(), summary: text(4000).optional(), title: text(300).optional(), bump: z.enum(BUMPS).optional(), feature: z.string().trim().max(300).nullable().optional() }).strict(), req.body);
    res.json(revisionView(await k.edit(principalOf(req), String(req.params.id), body)));
  });

  r.post('/knowledge/revisions/:id/submit', read, async (req, res) => {
    parseBody(z.object({}).strict(), req.body ?? {});
    res.json(revisionView(await k.submit(principalOf(req), String(req.params.id))));
  });

  r.post('/knowledge/revisions/:id/withdraw', read, async (req, res) => {
    parseBody(z.object({}).strict(), req.body ?? {});
    res.json(revisionView(await k.withdraw(principalOf(req), String(req.params.id))));
  });

  r.post('/knowledge/revisions/:id/decision', read, async (req, res) => {
    const body = parseBody(z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(2000).nullable().optional() }).strict(), req.body);
    const out = await k.decide(principalOf(req), String(req.params.id), body);
    res.json({ ...revisionView(out), settling: !!out.settling });
  });

  return r;
}
