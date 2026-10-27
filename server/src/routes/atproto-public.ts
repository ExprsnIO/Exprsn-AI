import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { labelJson } from '../atproto/labels.js';
import type { IdentityRow } from '../atproto/service.js';
import { tooManyRequests } from '../http/problem.js';
import { Limiter } from '../platform/ratelimit.js';
import type { Services } from '../services.js';

/*
 * AT-Protocol's public endpoints (Sprint 25, B-1609, B-1610), mounted at the root outside /api: no session, no CSRF.
 * Everything served is public by design (DID documents, signed labels). Each address is rate-limited
 * (ATPROTO_PUBLIC_RATE_PER_MINUTE, shared with subscribeLabels).
 *
 *   GET /.well-known/did.json                      the did:web document of the identity on this host
 *   GET /.well-known/atproto-did                   the DID whose handle is this host (text/plain): a labeler
 *                                                  identity or, since 1.5.0, an account the PDS hosts
 *   GET /atproto/<key>/did.json                    a tenant's path-form did:web document
 *   GET /xrpc/com.atproto.label.queryLabels        labels of the identity on this host
 *   GET /atproto/<key>/xrpc/com.atproto.label.queryLabels
 *
 * XRPC errors are AT-Protocol's `{ error, message }` with status 400 or 404, not problem details.
 */

const KEY_RE = /^[a-z0-9-]{1,63}$/;

const queryLabels = z
  .object({
    uriPatterns: z.union([z.string().min(1).max(2048), z.array(z.string().min(1).max(2048)).min(1).max(50)]).transform((v) => (Array.isArray(v) ? v : [v])),
    sources: z.union([z.string().max(300), z.array(z.string().max(300)).max(50)]).optional().transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
    limit: z.coerce.number().int().min(1).max(250).default(50),
    cursor: z.string().regex(/^\d{1,15}$/).optional()
  })
  .strict();

export function atprotoPublicRoutes(s: Services): Router {
  const r = Router();
  const limiter = new Limiter(s.counters, 'atproto-public', s.cfg.ATPROTO_PUBLIC_RATE_PER_MINUTE, 60_000);
  const limit: RequestHandler = async (req, res, next) => {
    const l = await limiter.consume(req.ip ?? 'unknown');
    if (!l.allowed) throw tooManyRequests('Too many requests to the AT-Protocol endpoints from this address.', l.resetMs / 1000);
    // Public, read-only and signed: any origin may read them.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  };
  r.use(['/.well-known/did.json', '/.well-known/atproto-did', '/atproto', '/xrpc/com.atproto.label.queryLabels'], limit);

  const xrpcError = (res: Response, status: number, error: string, message: string) => res.status(status).json({ error, message });
  const host = (req: Request): string => String(req.headers.host ?? '');

  const sendDocument = async (res: Response, identity: IdentityRow | undefined) => {
    if (!identity || identity.method !== 'web') return xrpcError(res, 404, 'NotFound', 'No did:web is served here.');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.type('application/did+json').send(JSON.stringify(await s.atproto.document(identity)));
  };

  r.get('/.well-known/did.json', async (req, res) => {
    const identity = await s.atproto.identityByHost(host(req));
    // A tenant's own host serves its did:web; the base host serves the platform's (path-form DIDs live below it).
    await sendDocument(res, identity && (identity.host !== null || identity.tenant_id === null) ? identity : undefined);
  });

  r.get('/atproto/:key/did.json', async (req, res) => {
    const key = String(req.params.key);
    await sendDocument(res, KEY_RE.test(key) ? await s.atproto.identityByPathKey(key) : undefined);
  });

  // 1.5.0 (B-2901): a handle hosted by the PDS resolves here too (its tenant's wildcard DNS points at this server).
  const pdsAccount = async (host: string): Promise<{ did: string } | undefined> => {
    const a = host ? await s.pds.accountByHandle(host) : undefined;
    return a && a.state !== 'takendown' && (await s.pds.hosting(a.tenant_id))?.enabled ? { did: a.did } : undefined;
  };

  r.get('/.well-known/atproto-did', async (req, res) => {
    const identity = (await s.atproto.identityByHandle(req.hostname ?? '')) ?? (await pdsAccount(req.hostname ?? ''));
    if (!identity) {
      res.status(404).type('text/plain').send('No AT-Protocol handle here.');
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.type('text/plain').send(identity.did);
  });

  const query = async (req: Request, res: Response, identity: IdentityRow | undefined) => {
    if (!identity) return xrpcError(res, 404, 'NotFound', 'No labeler is served here.');
    const q = queryLabels.safeParse(req.query);
    if (!q.success) return xrpcError(res, 400, 'InvalidRequest', q.error.issues.map((i) => `${i.path.join('.') || 'query'}: ${i.message}`).join('; ').slice(0, 500));
    const out = await s.atproto.query(identity, { uriPatterns: q.data.uriPatterns, ...(q.data.sources ? { sources: q.data.sources } : {}), limit: q.data.limit, cursor: q.data.cursor ? Number(q.data.cursor) : null });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...(out.cursor ? { cursor: out.cursor } : {}), labels: out.labels.map((l) => labelJson(l.label)) });
  };

  r.get('/xrpc/com.atproto.label.queryLabels', async (req, res) => query(req, res, await s.atproto.identityByHost(host(req))));
  r.get('/atproto/:key/xrpc/com.atproto.label.queryLabels', async (req, res) => {
    const key = String(req.params.key);
    await query(req, res, KEY_RE.test(key) ? await s.atproto.identityByPathKey(key) : undefined);
  });

  return r;
}
