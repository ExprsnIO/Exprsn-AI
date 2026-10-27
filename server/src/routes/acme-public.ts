import express, { Router, type Request, type Response } from 'express';
import { Limiter } from '../platform/ratelimit.js';
import type { AcmeContext, AcmeReply } from '../pki/acme.js';
import { AcmeProblem, malformed } from '../pki/jws.js';
import type { Services } from '../services.js';

/*
 * The ACME server's public endpoints (B-1605, RFC 8555), under `/pki/acme/<tenant slug>/` outside /api: no session,
 * no CSRF; every POST is a JWS whose signature is the authentication. Mounted from `pki-public.ts`, so the CA's
 * per-address limit (PKI_PUBLIC_RATE_PER_MINUTE) applies, and new accounts, orders, challenge requests, finalize,
 * revocation and key changes also count against PKI_ACME_RATE_PER_MINUTE per address.
 *
 *   GET  directory              HEAD|GET new-nonce
 *   POST new-account            POST acct/<id>            POST acct/<id>/orders      POST key-change
 *   POST new-order              POST order/<id>           POST order/<id>/finalize
 *   POST authz/<id>             POST chall/<id>           POST cert/<id>             POST revoke-cert
 *
 * Every answer carries a fresh Replay-Nonce and `Link: <directory>;rel="index"`; errors are RFC 8555 problem
 * documents (`application/problem+json`, `urn:ietf:params:acme:error:*`).
 */

const ID = '([0-9A-HJKMNP-TV-Z]{26})';
const MAX_BODY = 64 * 1024;

export function acmePublicRoutes(s: Services): Router {
  const r = Router();
  const acme = s.pki.acme;
  const writes = new Limiter(s.counters, 'pki-acme', s.cfg.PKI_ACME_RATE_PER_MINUTE, 60_000);
  const raw = express.raw({ type: () => true, limit: MAX_BODY });

  const common = async (res: Response, ctx: AcmeContext | null) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Replay-Nonce', await acme.newNonce());
    if (ctx) res.append('Link', `<${ctx.urls.directory}>;rel="index"`);
  };

  const fail = async (res: Response, ctx: AcmeContext | null, err: unknown) => {
    const p = err instanceof AcmeProblem ? err : new AcmeProblem(500, 'serverInternal', 'The server could not complete the request.');
    if (!(err instanceof AcmeProblem)) s.log.warn({ err: (err as Error).message }, 'ACME request failed');
    await common(res, ctx).catch(() => undefined);
    if (p.location) res.setHeader('Location', p.location);
    if (p.status === 429) res.setHeader('Retry-After', '60');
    res.status(p.status).type('application/problem+json').send(JSON.stringify(p.body()));
  };

  const send = async (res: Response, ctx: AcmeContext, reply: AcmeReply) => {
    await common(res, ctx);
    if (reply.location) res.setHeader('Location', reply.location);
    for (const l of reply.links ?? []) res.append('Link', l);
    if (reply.pem !== undefined) res.status(reply.status).type('application/pem-certificate-chain').send(reply.pem);
    else if (reply.body === undefined) res.status(reply.status).end();
    else res.status(reply.status).type('application/json').send(JSON.stringify(reply.body));
  };

  const bodyOf = (req: Request): unknown => {
    const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/jose+json') throw new AcmeProblem(415, 'malformed', 'POST bodies must be application/jose+json.');
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    try {
      return JSON.parse(buf.toString('utf8')) as unknown;
    } catch {
      throw malformed('The body is not JSON.');
    }
  };

  r.get('/pki/acme/:tenant/directory', async (req, res) => {
    let ctx: AcmeContext | null = null;
    try {
      ctx = await acme.context(String(req.params.tenant));
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.type('application/json').send(JSON.stringify(acme.directory(ctx)));
    } catch (err) {
      await fail(res, ctx, err);
    }
  });

  const nonce = (status: number) => async (req: Request, res: Response) => {
    let ctx: AcmeContext | null = null;
    try {
      ctx = await acme.context(String(req.params.tenant));
      await common(res, ctx);
      res.status(status).end();
    } catch (err) {
      await fail(res, ctx, err);
    }
  };
  r.head('/pki/acme/:tenant/new-nonce', nonce(200));
  r.get('/pki/acme/:tenant/new-nonce', nonce(204));

  /** Dispatches a POST under the tenant's directory to the service by its path. */
  r.post('/pki/acme/:tenant/*rest', raw, async (req, res, next) => {
    let ctx: AcmeContext | null = null;
    try {
      ctx = await acme.context(String(req.params.tenant));
      const parts = (req.params as { rest?: string[] | string }).rest;
      const rest = Array.isArray(parts) ? parts.join('/') : String(parts ?? '');
      // Polling (POST-as-GET of orders, authorizations and challenges) is not counted here.
      const write = /^(new-account|new-order|key-change|revoke-cert)$/.test(rest) || new RegExp(`^(chall/${ID}|order/${ID}/finalize)$`).test(rest);
      if (write && !(await writes.consume(req.ip ?? 'unknown')).allowed) throw new AcmeProblem(429, 'rateLimited', 'Too many ACME requests from this address; try again in a minute.');
      const body = bodyOf(req);
      let m: RegExpExecArray | null;
      let reply: AcmeReply;
      if (rest === 'new-account') reply = await acme.newAccount(ctx, body, req.ip ?? null);
      else if (rest === 'new-order') reply = await acme.newOrder(ctx, body);
      else if (rest === 'revoke-cert') reply = await acme.revoke(ctx, body);
      else if (rest === 'key-change') reply = await acme.keyChange(ctx, body);
      else if ((m = new RegExp(`^acct/${ID}$`).exec(rest))) reply = await acme.updateAccount(ctx, m[1]!, body);
      else if ((m = new RegExp(`^acct/${ID}/orders$`).exec(rest))) reply = await acme.accountOrders(ctx, m[1]!, body);
      else if ((m = new RegExp(`^order/${ID}$`).exec(rest))) reply = await acme.getOrder(ctx, m[1]!, body);
      else if ((m = new RegExp(`^order/${ID}/finalize$`).exec(rest))) reply = await acme.finalize(ctx, m[1]!, body);
      else if ((m = new RegExp(`^authz/${ID}$`).exec(rest))) reply = await acme.getAuthz(ctx, m[1]!, body);
      else if ((m = new RegExp(`^chall/${ID}$`).exec(rest))) reply = await acme.challenge(ctx, m[1]!, body);
      else if ((m = new RegExp(`^cert/${ID}$`).exec(rest))) reply = await acme.certificate(ctx, m[1]!, body);
      else throw new AcmeProblem(404, 'malformed', 'No such ACME resource.');
      await send(res, ctx, reply);
    } catch (err) {
      if (res.headersSent) return next(err);
      await fail(res, ctx, err);
    }
  });

  // A body over the limit, or anything else that fails before the handler: still an ACME problem.
  r.use('/pki/acme', (err: unknown, _req: Request, res: Response, next: (e?: unknown) => void) => {
    if (res.headersSent) return next(err);
    const status = (err as { status?: number }).status;
    void fail(res, null, err instanceof AcmeProblem ? err : status === 413 ? new AcmeProblem(413, 'malformed', 'The request body is too large.') : err);
  });

  return r;
}
