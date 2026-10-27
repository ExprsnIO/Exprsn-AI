import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { LABELS, type Label } from '../authz/labels.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { badRequest, conflict, HttpProblem } from '../http/problem.js';
import { docView } from '../knowledge/service.js';
import { assetView, mediaJobView, transcriptText } from '../media/service.js';
import type { Services } from '../services.js';
import { redirectToMedia, sandboxHeaders } from '../media/origin.js';

const safeName = (n: string) => n.replace(/[^\w.() -]+/g, '_').slice(0, 120) || 'media';

/**
 * Sends a buffer, honouring a single `Range: bytes=a-b` so video and audio elements can seek. The response is
 * sandboxed (CSP `sandbox`, `nosniff`): a stored file can never run script with the console's origin.
 */
export function sendBytes(req: Request, res: Response, data: Buffer, type: string, disposition: string): void {
  sandboxHeaders(res);
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', disposition);
  res.setHeader('Accept-Ranges', 'bytes');
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.header('range') ?? '');
  if (m && (m[1] || m[2])) {
    const size = data.length;
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end || start >= size) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
      return;
    }
    res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.end(data.subarray(start, end + 1));
    return;
  }
  res.end(data);
}

/**
 * Media assets and preset jobs, scoped to the caller's workspace and clearance. Reading needs `chat:read`; uploading
 * and running presets need `chat:write`. The upload body is the file, streamed to disk under the size cap.
 */
export function mediaRoutes(s: Services): Router {
  const r = Router();
  r.use('/media', noStore, requireAuth());
  const read = requirePermission(s, 'chat:read');
  const write = requirePermission(s, 'chat:write');
  const m = s.media;

  const audit = (req: Request, action: string, target: Record<string, unknown>, label?: Label, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, ...(label ? { label } : {}), ...(detail ? { detail } : {}), traceId: req.traceId });
  };

  r.get('/media/caps', read, async (_req, res) => {
    const c = m.caps;
    res.json({ caps: { maxBytes: c.maxBytes, maxDurationMs: c.maxDurationMs, maxWidth: c.maxWidth, maxHeight: c.maxHeight, maxStreams: c.maxStreams }, presets: m.presets(), encoder: { setting: s.cfg.MEDIA_ENCODER, video: await m.encoderFor({ encodes: true }) } });
  });

  r.get('/media/assets', read, async (req, res) => {
    res.json(await m.list(principalOf(req)));
  });

  r.put('/media/assets', write, async (req, res) => {
    const p = principalOf(req);
    const q = parseBody(z.object({ name: z.string().trim().min(1).max(255).regex(/^[^/\\\0]+$/), label: z.enum(LABELS).default('internal') }), req.query);
    const max = m.caps.maxBytes;
    const declared = Number(req.header('content-length') ?? NaN);
    const tooBig = () => new HttpProblem(413, 'Payload too large', `The file is above the upload cap of ${(max / 1e6).toFixed(0)} MB, set by the system admin.`, { extensions: { cap: 'size', max } });
    if (Number.isFinite(declared) && declared > max) throw tooBig();
    const dir = await mkdtemp(path.join(s.cfg.MEDIA_WORK_DIR ?? tmpdir(), 'exprsn-upload-'));
    try {
      const file = path.join(dir, 'upload');
      const hash = createHash('sha256');
      let size = 0;
      await pipeline(
        req,
        new Transform({
          transform(chunk: Buffer, _enc, cb) {
            size += chunk.length;
            if (size > max) return cb(tooBig());
            hash.update(chunk);
            cb(null, chunk);
          }
        }),
        createWriteStream(file, { mode: 0o600 })
      );
      if (!size) throw badRequest('The file is empty.');
      const a = await m.upload(p, { name: q.name, label: q.label, file, size, sha256: hash.digest('hex') });
      await audit(req, 'media.uploaded', { asset: a.id, name: a.name }, a.label, { size, sha256: a.sha256 });
      res.status(202).json(assetView(a));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  r.get('/media/assets/:id', read, async (req, res) => {
    const p = principalOf(req);
    const a = await m.asset(p, String(req.params.id));
    const names = await m.names([a.user_id]);
    res.json({ ...assetView(a, names), jobs: (await m.jobs(p, a.id)).map(mediaJobView) });
  });

  r.get('/media/assets/:id/content', read, async (req, res) => {
    const a = await m.asset(principalOf(req), String(req.params.id));
    if (redirectToMedia(s, req, res, { kind: 'asset', id: a.id })) return;
    sendBytes(req, res, await m.content(a), m.typeOf(a), `inline; filename="${safeName(a.name)}"`);
  });

  r.get('/media/assets/:id/previews/:i', read, async (req, res) => {
    const a = await m.asset(principalOf(req), String(req.params.id));
    if (redirectToMedia(s, req, res, { kind: 'preview', id: a.id, i: Number(req.params.i) })) return;
    const pv = await m.preview(a, Number(req.params.i));
    sendBytes(req, res, pv.data, pv.type, 'inline');
  });

  r.post('/media/assets/:id/jobs', write, async (req, res) => {
    const body = parseBody(z.object({ preset: z.string().min(1).max(40), params: z.record(z.string(), z.string().max(40)).default({}) }).strict(), req.body);
    const j = await m.runPreset(principalOf(req), String(req.params.id), body.preset, body.params);
    await audit(req, 'media.job.queued', { asset: j.asset_id, job: j.id, preset: j.preset }, j.label, { params: j.params, encoder: j.encoder });
    res.status(202).json(mediaJobView(j));
  });

  r.get('/media/jobs/:id', read, async (req, res) => {
    res.json(mediaJobView(await m.job(principalOf(req), String(req.params.id))));
  });

  r.post('/media/jobs/:id/cancel', write, async (req, res) => {
    const j = await m.cancel(principalOf(req), String(req.params.id));
    await audit(req, 'media.job.cancelled', { asset: j.asset_id, job: j.id, preset: j.preset }, j.label);
    res.json(mediaJobView(j));
  });

  r.get('/media/jobs/:id/outputs/:i', read, async (req, res) => {
    const q = parseBody(z.object({ download: z.enum(['1', 'true']).optional() }), req.query);
    const out = await m.output(principalOf(req), String(req.params.id), Number(req.params.i));
    if (q.download) await audit(req, 'media.output.downloaded', { asset: out.job.asset_id, job: out.job.id, output: out.name }, out.job.label);
    if (redirectToMedia(s, req, res, { kind: 'output', id: out.job.id, i: Number(req.params.i), download: !!q.download })) return;
    sendBytes(req, res, out.data, out.type, `${q.download ? 'attachment' : 'inline'}; filename="${safeName(out.name)}"`);
  });

  /**
   * Send transcript to a knowledge base: the transcript of a finished transcription job becomes a document in the
   * base's uploads, as text with a start time per line, keeping the job's label (the classifier may raise it, never
   * lower it). The base must be one the caller can curate; the document is scanned and indexed like any upload.
   */
  r.post('/media/jobs/:id/knowledge', write, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ kbId: z.string().length(26) }).strict(), req.body);
    const out = await m.output(p, String(req.params.id), 0);
    if (out.job.preset !== 'transcribe-srt' || out.job.state !== 'succeeded') throw conflict('Only the transcript of a finished transcription job can be sent to a knowledge base.');
    const text = transcriptText(out.data.toString('utf8'));
    if (!text) throw conflict('The transcript is empty.');
    const a = await m.asset(p, out.job.asset_id);
    const name = `${a.name.replace(/\.[^.]+$/, '')} transcript.txt`;
    const doc = await s.knowledge.upload(p, body.kbId, { name, label: out.job.label, data: Buffer.from(text, 'utf8') });
    await audit(req, 'media.transcript.sent', { asset: a.id, job: out.job.id, kb: doc.kb_id, document: doc.id }, doc.label, { name: doc.name, size: doc.size });
    const kb = await s.knowledge.base(p, doc.kb_id);
    res.status(202).json({ ...docView(doc), kb: { id: kb.id, name: kb.name } });
  });

  /** "Ask for a higher cap": tells the system admins, with the probe result. */
  r.post('/media/caps/request', write, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ assetId: z.string().length(26), note: z.string().trim().max(1000).default('') }).strict(), req.body);
    const a = await m.asset(p, body.assetId);
    const admins = await s.notifications.usersWithRoles(p.tenantId, ['system-admin']);
    await s.notifications.notify({ tenantId: p.tenantId, userIds: admins, kind: 'media', title: 'Media cap increase requested', body: `${p.displayName}: ${a.name} was refused (${a.reason ?? 'above a cap'}).${body.note ? ` ${body.note}` : ''}`.slice(0, 1000), route: 'platform', label: a.label });
    await audit(req, 'media.cap.requested', { asset: a.id, name: a.name }, a.label, { reason: a.reason });
    res.json({ notified: admins.length });
  });

  return r;
}
