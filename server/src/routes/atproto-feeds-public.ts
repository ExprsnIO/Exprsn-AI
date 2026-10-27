import { Router, type Request, type RequestHandler, type Response } from 'express';
import client from 'prom-client';
import { z } from 'zod';
import { FeedError } from '../atproto/feeds.js';
import type { IdentityRow } from '../atproto/service.js';
import { ServiceJwtRefused } from '../atproto/service-jwt.js';
import { tooManyRequests } from '../http/problem.js';
import { Limiter } from '../platform/ratelimit.js';
import type { Services } from '../services.js';

/*
 * The feed generator's XRPC endpoints (Sprint 31, B-3001, B-3003), mounted at the root outside /api: no session, no
 * CSRF. An AppView calls them at the `#bsky_fg` endpoint of the tenant's DID document: the tenant's own host, or the
 * path-form `/atproto/<key>` under ATPROTO_PUBLIC_URL.
 *
 *   GET /xrpc/app.bsky.feed.describeFeedGenerator          the generator's DID and its feeds
 *   GET /xrpc/app.bsky.feed.getFeedSkeleton?feed&limit&cursor
 *   GET /atproto/<key>/xrpc/app.bsky.feed.describeFeedGenerator
 *   GET /atproto/<key>/xrpc/app.bsky.feed.getFeedSkeleton
 *
 * getFeedSkeleton takes an inter-service JWT (`Authorization: Bearer`, `service-jwt.ts`): one that does not verify is
 * refused with 401 whatever the feed; a feed with `auth: required` also refuses a request without one. Each address is
 * rate-limited with the other public AT-Protocol endpoints (ATPROTO_PUBLIC_RATE_PER_MINUTE), and each feed by its own
 * `ratePerMinute`. Errors are XRPC's `{ error, message }`.
 */

const KEY_RE = /^[a-z0-9-]{1,63}$/;
const METHOD = 'app.bsky.feed.getFeedSkeleton';

const skeletonQuery = z.object({
  feed: z.string().min(1).max(3000),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional()
});

export function atprotoFeedPublicRoutes(s: Services): Router {
  const r = Router();
  const limiter = new Limiter(s.counters, 'atproto-public', s.cfg.ATPROTO_PUBLIC_RATE_PER_MINUTE, 60_000);
  const reg = s.metrics.registry;
  const requests = (reg.getSingleMetric('exprsn_feed_requests_total') as client.Counter<'method' | 'result'> | undefined) ?? new client.Counter({ name: 'exprsn_feed_requests_total', help: 'Feed generator requests by method and outcome (ok, unknown, refused, unauthenticated, limited, invalid)', labelNames: ['method', 'result'], registers: [reg] });

  const limit: RequestHandler = async (req, _res, next) => {
    const l = await limiter.consume(req.ip ?? 'unknown');
    if (!l.allowed) throw tooManyRequests('Too many requests to the AT-Protocol endpoints from this address.', l.resetMs / 1000);
    next();
  };
  const paths = ['/xrpc/app.bsky.feed.describeFeedGenerator', '/xrpc/app.bsky.feed.getFeedSkeleton', '/atproto/:key/xrpc/app.bsky.feed.describeFeedGenerator', '/atproto/:key/xrpc/app.bsky.feed.getFeedSkeleton'];
  r.use(paths, limit);

  const xrpcError = (res: Response, status: number, error: string, message: string) => res.status(status).json({ error, message });

  const identityFor = async (req: Request): Promise<IdentityRow | undefined> => {
    if (req.params.key !== undefined) {
      const key = String(req.params.key);
      return KEY_RE.test(key) ? s.atproto.identityByPathKey(key) : undefined;
    }
    return s.atproto.identityByHost(String(req.headers.host ?? ''));
  };

  const describe = async (req: Request, res: Response) => {
    const identity = await identityFor(req);
    res.setHeader('Cache-Control', 'no-store');
    if (!identity) {
      requests.inc({ method: 'describeFeedGenerator', result: 'unknown' });
      return xrpcError(res, 404, 'NotFound', 'No feed generator is served here.');
    }
    requests.inc({ method: 'describeFeedGenerator', result: 'ok' });
    res.json(await s.feedGenerators.describe(identity));
  };

  const skeleton = async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const count = (result: string) => requests.inc({ method: 'getFeedSkeleton', result });
    const identity = await identityFor(req);
    const q = skeletonQuery.safeParse(req.query);
    if (!q.success) {
      count('invalid');
      return xrpcError(res, 400, 'InvalidRequest', q.error.issues.map((i) => `${i.path.join('.') || 'query'}: ${i.message}`).join('; ').slice(0, 500));
    }
    const row = identity?.tenant_id ? await s.feedGenerators.resolveFeed(identity.tenant_id, q.data.feed) : undefined;
    if (!identity || !row) {
      count('unknown');
      return xrpcError(res, 400, 'UnknownFeed', 'This generator does not serve that feed.');
    }
    const auth = String(req.headers.authorization ?? '');
    if (auth) {
      const m = /^Bearer ([A-Za-z0-9_.-]{1,8192})$/.exec(auth);
      try {
        if (!m) throw new ServiceJwtRefused('BadJwt', 'The Authorization header is not a Bearer token.');
        await s.feedGenerators.jwt.verify(m[1]!, { audiences: [identity.did, `${identity.did}#bsky_fg`], lxm: METHOD });
      } catch (err) {
        if (!(err instanceof ServiceJwtRefused)) throw err;
        count('refused');
        res.setHeader('WWW-Authenticate', 'Bearer');
        return xrpcError(res, 401, err.error, err.message);
      }
    } else if (row.auth === 'required') {
      count('unauthenticated');
      res.setHeader('WWW-Authenticate', 'Bearer');
      return xrpcError(res, 401, 'AuthenticationRequired', 'This feed needs a service JWT from an AppView.');
    }
    const l = await new Limiter(s.counters, 'atproto-feed', row.rate_per_minute, 60_000).consume(row.id);
    if (!l.allowed) {
      count('limited');
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(l.resetMs / 1000))));
      return xrpcError(res, 429, 'RateLimitExceeded', 'This feed is asked for more often than its limit allows.');
    }
    try {
      const page = await s.feedGenerators.skeleton(row, { limit: q.data.limit, cursor: q.data.cursor ?? null });
      count('ok');
      res.json(page);
    } catch (err) {
      if (err instanceof FeedError && err.status === 400) {
        count('invalid');
        return xrpcError(res, 400, String(err.extensions.error ?? 'InvalidRequest'), err.message);
      }
      throw err;
    }
  };

  r.get('/xrpc/app.bsky.feed.describeFeedGenerator', describe);
  r.get('/atproto/:key/xrpc/app.bsky.feed.describeFeedGenerator', describe);
  r.get('/xrpc/app.bsky.feed.getFeedSkeleton', skeleton);
  r.get('/atproto/:key/xrpc/app.bsky.feed.getFeedSkeleton', skeleton);
  return r;
}
