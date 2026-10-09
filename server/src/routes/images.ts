import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { labelRank, LABELS, type Label } from '../authz/labels.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { attachmentView } from '../chat/attachments.js';
import { sendBytes } from './media.js';
import type { Services } from '../services.js';
import { redirectToMedia } from '../media/origin.js';

const dim = z.number().int().min(256).max(2048).refine((v) => v % 8 === 0, 'A multiple of 8');

/** Image generation: every route needs `images:generate`; sending an image to chat also needs `chat:write`. */
export function imageRoutes(s: Services): Router {
  const r = Router();
  r.use('/images', noStore, requireAuth());
  const gen = requirePermission(s, 'images:generate');
  const chatWrite = requirePermission(s, 'chat:write');
  const im = s.images;

  const audit = (req: Request, action: string, target: Record<string, unknown>, label?: Label, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, ...(label ? { label } : {}), ...(detail ? { detail } : {}), traceId: req.traceId });
  };

  r.get('/images/backends', gen, (_req, res) => {
    res.json({ backends: im.backends(), safety: { classifier: s.imageSafety.name === 'none' ? null : s.imageSafety.name, threshold: s.cfg.IMAGE_SAFETY_THRESHOLD, required: s.cfg.IMAGE_SAFETY_REQUIRED } });
  });

  r.get('/images/quota', gen, async (req, res) => {
    res.json(await im.quota(principalOf(req)));
  });

  r.get('/images', gen, async (req, res) => {
    res.json(await im.list(principalOf(req)));
  });

  const genSchema = z.object({ prompt: z.string().trim().min(1).max(4000), backend: z.string().min(1).max(63), width: dim, height: dim, count: z.number().int().min(1).max(8).default(1), seed: z.number().int().min(0).max(2 ** 31 - 9).optional(), steps: z.number().int().min(1).max(150).optional(), label: z.enum(LABELS).default('internal') }).strict();

  r.post('/images', gen, async (req, res) => {
    const body = parseBody(genSchema, req.body);
    const out = await im.generate(principalOf(req), body);
    await audit(req, 'image.requested', { batch: out.batch, backend: body.backend }, body.label, { count: body.count, width: body.width, height: body.height, redacted: out.redacted });
    res.status(202).json(out);
  });

  r.get('/images/:id', gen, async (req, res) => {
    res.json(await im.get(principalOf(req), String(req.params.id)));
  });

  r.post('/images/:id/cancel', gen, async (req, res) => {
    const v = await im.cancel(principalOf(req), String(req.params.id));
    await audit(req, 'image.cancelled', { image: v.id }, v.label);
    res.json(v);
  });

  /** A variation: the same prompt, size and worker with the next seed. */
  r.post('/images/:id/vary', gen, async (req, res) => {
    const p = principalOf(req);
    const v = await im.get(p, String(req.params.id));
    const out = await im.generate(p, { prompt: v.prompt ?? '', backend: v.backend, width: v.width, height: v.height, count: 1, seed: v.seed + 1, steps: v.steps, label: v.label });
    await audit(req, 'image.requested', { batch: out.batch, backend: v.backend, variationOf: v.id }, v.label, { count: 1 });
    res.status(202).json(out);
  });

  r.get('/images/:id/image', gen, async (req, res) => {
    const out = await im.image(principalOf(req), String(req.params.id));
    if (redirectToMedia(s, req, res, { kind: 'image', id: out.row.id, download: false })) return;
    sendBytes(req, res, out.data, out.type, 'inline');
  });

  /** Downloads carry the provenance chunk; every download is written to the audit chain with its label. */
  r.get('/images/:id/download', gen, async (req, res) => {
    const out = await im.image(principalOf(req), String(req.params.id));
    await audit(req, 'image.downloaded', { image: out.row.id }, out.row.label, { imageSha256: out.provenance?.imageSha256 ?? null, highLabel: labelRank(out.row.label) >= labelRank('confidential') });
    if (redirectToMedia(s, req, res, { kind: 'image', id: out.row.id, download: true })) return;
    sendBytes(req, res, out.data, out.type, `attachment; filename="image-${out.row.id.toLowerCase()}.${out.type === 'image/png' ? 'png' : 'jpg'}"`);
  });

  r.get('/images/:id/provenance', gen, async (req, res) => {
    res.json(await im.verify(principalOf(req), String(req.params.id)));
  });

  /** 1.6.0 (B-7901): the C2PA manifest read back from the stored bytes and checked against the tenant's CA. */
  r.get('/images/:id/content-credentials', gen, async (req, res) => {
    res.json(await im.verifyContentCredentials(principalOf(req), String(req.params.id)));
  });

  /** Sends the image to chat as an attachment (it is scanned like any upload). */
  r.post('/images/:id/attach', gen, chatWrite, async (req, res) => {
    const p = principalOf(req);
    const out = await im.image(p, String(req.params.id));
    const a = await s.attachments.upload({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, userId: p.userId, name: `image-${out.row.id.toLowerCase()}.${out.type === 'image/png' ? 'png' : 'jpg'}`, declaredType: out.type, label: out.row.label, data: out.data });
    await audit(req, 'image.attached', { image: out.row.id, attachment: a.id }, out.row.label);
    res.status(202).json(attachmentView(a));
  });

  /** Reports a blocked prompt or a withheld image as a possible false positive, for the reviewers. */
  r.post('/images/report', gen, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ kind: z.enum(['prompt', 'output']), imageId: z.string().length(26).optional(), rule: z.string().max(200).nullable().default(null), note: z.string().trim().max(2000).default('') }).strict(), req.body);
    let label: Label = 'internal';
    if (body.imageId) label = (await im.get(p, body.imageId)).label;
    const reviewers = await s.notifications.usersWithRoles(p.tenantId, ['flag-reviewer', 'guardrail-admin']);
    await s.notifications.notify({ tenantId: p.tenantId, userIds: reviewers, kind: 'flag', title: body.kind === 'prompt' ? 'Blocked image prompt reported' : 'Withheld image reported', body: `${p.displayName} reports a possible false positive${body.rule ? ` on ${body.rule}` : ''}.${body.note ? ` ${body.note}` : ''}`.slice(0, 1000), route: 'flags', label });
    await audit(req, 'image.reported', { kind: body.kind, ...(body.imageId ? { image: body.imageId } : {}) }, label, { rule: body.rule, note: body.note ? 'given' : null });
    res.json({ notified: reviewers.length });
  });

  return r;
}
