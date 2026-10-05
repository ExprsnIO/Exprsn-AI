import { Router, type Request, type RequestHandler } from 'express';
import { actorFrom } from '../audit/chain.js';
import { z } from 'zod';
import { LABELS } from '../authz/labels.js';
import { effectivePermissions } from '../authz/policy.js';
import { CHANNEL_KINDS, REVIEW_MODES, SESSION_STATES, TARGET_KINDS, type Ctx } from '../channels/service.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { badRequest } from '../http/problem.js';
import type { Services } from '../services.js';

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
const name = z.string().trim().min(1).max(200);
const host = z.string().trim().min(1).max(253);
const vaultRef = z.string().trim().regex(/^vault:[^#\s]+#[A-Za-z0-9_.-]{1,128}$/, 'a vault reference (vault:<path>#<key>)');
const address = z.string().trim().toLowerCase().max(320).regex(/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/, 'an email address');

const email = z
  .object({
    address,
    fromName: z.string().trim().max(200).nullable().default(null),
    imap: z.object({ host, port: z.number().int().min(1).max(65_535).default(993), secure: z.boolean().default(true), user: z.string().trim().min(1).max(320), passwordRef: vaultRef, mailbox: z.string().trim().min(1).max(200).default('INBOX') }).strict().nullable().default(null),
    smtp: z.object({ host, port: z.number().int().min(1).max(65_535).default(465), secure: z.boolean().default(true), user: z.string().trim().min(1).max(320), passwordRef: vaultRef }).strict().nullable().default(null),
    mailgunKeyRef: vaultRef.nullable().default(null)
  })
  .strict();

const fields = {
  name,
  label: z.enum(LABELS),
  target: z.object({ kind: z.enum(TARGET_KINDS), name: z.string().trim().min(1).max(200) }).strict(),
  instructions: z.string().trim().max(10_000).nullable().optional(),
  reviewMode: z.enum(REVIEW_MODES).optional(),
  allowAnonymous: z.boolean().optional(),
  messagesPerMinute: z.number().int().min(1).max(1000).optional(),
  sessionsPerHour: z.number().int().min(1).max(100_000).optional(),
  retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
  greeting: z.string().trim().max(2000).nullable().optional(),
  email: email.nullable().optional()
};

const time = (v: string | undefined): number | undefined => {
  if (v == null) return undefined;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) throw badRequest(`${v} is not an ISO 8601 time.`);
  return ms;
};

/**
 * Customer-service channels (Sprint 28a, B-2301 to B-2304). `channels:manage` creates and changes channels (their
 * binding, label, review mode, limits, retention, mail settings and secrets); `channels:review` works their sessions:
 * transcripts, held replies (approve, edit, reject), replies as a person, closing, CSV exports and bounces. Everything
 * inside the caller's workspaces and clearance.
 */
export function channelRoutes(s: Services): Router {
  const r = Router();
  r.use('/channels', noStore, requireAuth());
  const manage = requirePermission(s, 'channels:manage');
  const review = requirePermission(s, 'channels:review');
  const ch = s.channels;
  const ctx = (req: Request): Ctx => ({ p: principalOf(req), ip: ip(req), traceId: req.traceId ?? null });
  const idOf = (req: Request, key = 'id') => parseBody(id26, (req.params as Record<string, string>)[key]);
  // Reading a channel: either permission (a refusal is recorded as a `channels:review` denial).
  const either: RequestHandler = (req, res, next) => (effectivePermissions(principalOf(req)).has('channels:manage') ? manage(req, res, next) : review(req, res, next));

  r.get('/channels', either, async (req, res) => {
    const q = parseBody(z.object({ workspace: id26.optional() }), req.query);
    res.json(await ch.list(principalOf(req), q.workspace ?? null));
  });

  r.post('/channels', manage, async (req, res) => {
    const body = parseBody(z.object({ workspaceId: id26.optional(), kind: z.enum(CHANNEL_KINDS), ...fields }).strict(), req.body);
    res.status(201).json(await ch.create(ctx(req), body));
  });

  r.get('/channels/held', review, async (req, res) => {
    res.json(await ch.heldQueue(principalOf(req)));
  });

  r.post('/channels/held/:id/decide', review, async (req, res) => {
    const body = parseBody(z.object({ decision: z.enum(['approve', 'edit', 'reject']), text: z.string().trim().min(1).max(8000).optional(), reason: z.string().trim().max(500).nullable().optional() }).strict(), req.body);
    res.json(await ch.decideHeld(ctx(req), idOf(req), body));
  });

  r.get('/channels/exports/:id', review, async (req, res) => {
    const out = await ch.exportDownload(ctx(req), idOf(req));
    res.setHeader('Content-Disposition', `attachment; filename="${out.name}"`);
    res.type('text/csv; charset=utf-8').send(out.body);
  });

  r.get('/channels/:id', either, async (req, res) => {
    res.json(await ch.view(await ch.visible(principalOf(req), idOf(req))));
  });

  r.patch('/channels/:id', manage, async (req, res) => {
    const body = parseBody(
      z
        .object({ ...fields, name: name.optional(), label: z.enum(LABELS).optional(), target: fields.target.optional(), state: z.enum(['active', 'paused']).optional() })
        .strict()
        .refine((b) => Object.keys(b).length > 0, 'Change at least one field.'),
      req.body
    );
    res.json(await ch.update(ctx(req), idOf(req), body));
  });

  r.delete('/channels/:id', manage, async (req, res) => {
    res.json(await ch.remove(ctx(req), idOf(req)));
  });

  r.post('/channels/:id/secrets', manage, async (req, res) => {
    const body = parseBody(z.object({ which: z.enum(['identity', 'webhook']) }).strict(), req.body);
    res.json(await ch.rotateSecret(ctx(req), idOf(req), body.which));
  });

  r.post('/channels/:id/poll', manage, async (req, res) => {
    const c = await ch.visible(principalOf(req), idOf(req));
    if (c.kind !== 'email' || !c.settings.email?.imap) throw badRequest('Only email channels with an IMAP mailbox are polled.');
    const job = await s.jobs.enqueue({ tenantId: c.tenant_id, type: 'channels.imap-poll', payload: { channelId: c.id }, createdBy: principalOf(req).userId, maxAttempts: 1 });
    await s.audit.append({ tenantId: c.tenant_id, action: 'channel.poll.requested', kind: 'admin', actor: actorFrom(principalOf(req), ip(req)), target: { channel: c.id, workspace: c.workspace_id, job: job.id }, label: c.label, traceId: req.traceId });
    res.status(202).json({ jobId: job.id });
  });

  r.post('/channels/:id/purge', manage, async (req, res) => {
    res.status(202).json(await ch.purgeNow(ctx(req), idOf(req)));
  });

  r.get('/channels/:id/bounces', review, async (req, res) => {
    const c = await ch.visible(principalOf(req), idOf(req));
    res.json(await ch.mail.bounces(c));
  });

  r.post('/channels/:id/exports', review, async (req, res) => {
    const body = parseBody(z.object({ from: z.string().max(40).optional(), to: z.string().max(40).optional() }).strict(), req.body ?? {});
    res.status(202).json(await ch.startExport(ctx(req), idOf(req), { ...(body.from ? { from: time(body.from)! } : {}), ...(body.to ? { to: time(body.to)! } : {}) }));
  });

  r.get('/channels/:id/sessions', review, async (req, res) => {
    const q = parseBody(z.object({ state: z.enum(SESSION_STATES).optional(), before: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }), req.query);
    res.json(await ch.sessions(principalOf(req), idOf(req), q));
  });

  r.get('/channels/:id/sessions/:sessionId', review, async (req, res) => {
    res.json(await ch.transcript(principalOf(req), idOf(req), idOf(req, 'sessionId')));
  });

  r.get('/channels/:id/sessions/:sessionId/transcript.csv', review, async (req, res) => {
    const out = await ch.transcriptCsv(ctx(req), idOf(req), idOf(req, 'sessionId'));
    res.setHeader('Content-Disposition', `attachment; filename="${out.name}"`);
    res.type('text/csv; charset=utf-8').send(out.body);
  });

  r.post('/channels/:id/sessions/:sessionId/messages', review, async (req, res) => {
    const body = parseBody(z.object({ text: z.string().trim().min(1).max(8000) }).strict(), req.body);
    res.status(201).json(await ch.agentReply(ctx(req), idOf(req), idOf(req, 'sessionId'), body.text));
  });

  r.post('/channels/:id/sessions/:sessionId/close', review, async (req, res) => {
    res.json(await ch.closeByReviewer(ctx(req), idOf(req), idOf(req, 'sessionId')));
  });

  return r;
}
