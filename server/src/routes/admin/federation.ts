import { Router } from 'express';
import type { Services } from '../../services.js';

/** Identity: OIDC provider keys and clients, SAML IdP, upstream federation, Kerberos and device flow settings (Sprint 9). */
export function federationAdminRoutes(_s: Services): Router {
  const r = Router();
  return r;
}
