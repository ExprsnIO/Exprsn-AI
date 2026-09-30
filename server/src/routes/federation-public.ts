import { Router } from 'express';
import type { Services } from '../services.js';

/** Public protocol endpoints mounted at the root, outside /api: OIDC discovery, JWKS, authorize, token, userinfo, device, SAML metadata and SSO (Sprint 9). */
export function federationPublicRoutes(_s: Services): Router {
  const r = Router();
  return r;
}
