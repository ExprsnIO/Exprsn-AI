import { Router, type NextFunction, type Request, type Response } from 'express';
import { cloudCredentials } from '../cloud/credentials.js';
import { DISCOVERY_NAME, JWKS_NAME } from '../cloud/issuer.js';
import type { Services } from '../services.js';

/*
 * 1.9.99-final, Sprint 56 (B-10005, open decision 2's alternative): the federation issuer's two public documents,
 * served by the console itself when the publication target is `console`. Mounted outside `/api`, unauthenticated:
 * they hold public keys only. With any other target they answer 404 (the documents live in the bucket), so the
 * console exposes nothing extra unless the operator chose this.
 *
 *   GET /cloud-issuer/.well-known/openid-configuration
 *   GET /cloud-issuer/jwks.json
 *
 * The paths are fixed: with the console target the issuer URL is PUBLIC_URL followed by /cloud-issuer (leave
 * CLOUD_ISSUER_URL unset, or set it to that, or to the same path on a public origin that proxies to this one).
 */
export function cloudIssuerPublicRoutes(s: Services): Router {
  const r = Router();
  const serve = (name: typeof DISCOVERY_NAME | typeof JWKS_NAME) => async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const issuer = cloudCredentials(s).issuer;
      if (!(await issuer.installed()) || (await issuer.state()).target.kind !== 'console') return next();
      res.set('cache-control', 'public, max-age=300');
      if (name === JWKS_NAME) res.type('application/jwk-set+json').send(JSON.stringify(await issuer.jwks()));
      else res.json(issuer.discovery());
    } catch (err) {
      next(err);
    }
  };
  r.get(`/cloud-issuer/${DISCOVERY_NAME}`, serve(DISCOVERY_NAME));
  r.get(`/cloud-issuer/${JWKS_NAME}`, serve(JWKS_NAME));
  return r;
}
