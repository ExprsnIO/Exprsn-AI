import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { SHARE_TOKEN, UPLOAD_TOKEN } from '../files/album-links.js';
import { ip, noStore, parseBody } from '../http/middleware.js';
import { tooManyRequests } from '../http/problem.js';
import { sandboxHeaders } from '../media/origin.js';
import { Limiter } from '../platform/ratelimit.js';
import type { Services } from '../services.js';
import { sendZip } from './albums.js';
import { contentDisposition, nameSchema, sendFile } from './files.js';
import { sendBytes } from './media.js';

/** An uploader's name as they give it: 1 to 80 characters, no control characters. */
const uploaderSchema = z.string().trim().min(1).max(80).refine((n) => ![...n].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127), 'a name without control characters');

/**
 * 1.9.0, Sprint 53 (B-178): album share links and upload links, at `/api/public`, without a session: no cookie is
 * read or set. Tokens travel in the body (share links) or a header (uploads), never in a URL; the media addresses an
 * open mints are short-lived signatures. Opens, media and uploads are rate-limited per address in the shared counters
 * (SHARE_ANONYMOUS_PER_MINUTE; media at ten times that, a page shows many pictures). Every refusal of a link is the
 * same 404.
 */
export function publicAlbumRoutes(s: Services): Router {
  const r = Router();
  const per = s.cfg.SHARE_ANONYMOUS_PER_MINUTE;
  const opens = new Limiter(s.counters, 'album-link-anon', per, 60_000);
  const media = new Limiter(s.counters, 'album-media-anon', per * 10, 60_000);
  const uploads = new Limiter(s.counters, 'album-upload-anon', per, 60_000);
  const robots = (_req: Request, res: express.Response, next: express.NextFunction) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  };
  const limit = (l: Limiter, what: string) => async (req: Request, _res: express.Response, next: express.NextFunction) => {
    const got = await l.consume(ip(req) ?? 'unknown');
    if (!got.allowed) throw tooManyRequests(`Too many ${what} from this address; try again in a minute.`, got.resetMs / 1000);
    next();
  };
  const small = express.json({ limit: '4kb', strict: true });
  const ctx = (req: Request) => ({ ip: ip(req), traceId: req.traceId });
  const al = () => s.files.albums;
  const shareBody = z.object({ token: z.string().regex(SHARE_TOKEN), password: z.string().max(200).optional() }).strict();

  r.post('/album-links/open', noStore, robots, small, limit(opens, 'shared albums opened'), async (req, res) => {
    const b = parseBody(shareBody, req.body);
    res.json(await al().links.open(b.token, b.password ?? null, ctx(req)));
  });

  r.post('/album-links/download', noStore, robots, small, limit(opens, 'shared albums opened'), async (req, res) => {
    const b = parseBody(shareBody, req.body);
    const out = await al().links.downloadZip(b.token, b.password ?? null, ctx(req));
    await sendZip(res, out.name, out.stream);
  });

  r.get('/album-links/media/:cap', noStore, robots, limit(media, 'pictures opened'), async (req, res) => {
    const cap = parseBody(z.string().max(200), req.params.cap);
    const got = await al().links.media(cap, ctx(req));
    res.setHeader('Cache-Control', 'private, no-store');
    if (got.data) {
      sendBytes(req, res, got.data, got.type, 'inline');
      return;
    }
    if (got.kind === 'download') {
      await sendFile(res, { name: got.name, type: got.type, size: got.size, stream: got.stream! });
      return;
    }
    // Inline (the slideshow and video player): sandboxed, never cached.
    sandboxHeaders(res);
    res.setHeader('Content-Type', got.type);
    res.setHeader('Content-Disposition', contentDisposition('inline', got.name));
    if (got.size != null) res.setHeader('Content-Length', String(got.size));
    await pipeline(Readable.from(got.stream!), res);
  });

  r.post('/album-uploads/open', noStore, robots, small, limit(opens, 'upload links opened'), async (req, res) => {
    const { token } = parseBody(z.object({ token: z.string().regex(UPLOAD_TOKEN) }).strict(), req.body);
    res.json(await al().links.openUpload(token));
  });

  /** One file through an upload link: the raw body, the token in `X-Upload-Token`, the name and uploader in the query. */
  r.put('/album-uploads', noStore, robots, limit(uploads, 'uploads'), async (req, res) => {
    const token = parseBody(z.string().regex(UPLOAD_TOKEN), req.header('x-upload-token') ?? '');
    const q = parseBody(z.object({ name: nameSchema, uploader: uploaderSchema }), req.query);
    const n = Number(req.header('content-length') ?? NaN);
    const out = await al().links.receive(token, { name: q.name, uploader: q.uploader, declaredType: req.header('content-type') ?? null, declaredBytes: Number.isFinite(n) && n >= 0 ? n : null }, req, ctx(req));
    res.status(202).json(out);
  });

  return r;
}
