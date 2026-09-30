import { Router } from 'express';
import type { Services } from '../../services.js';

/** Platform: import bundles, mirrors, certificates, backups and restore drills (Sprint 9). */
export function platformAdminRoutes(_s: Services): Router {
  const r = Router();
  return r;
}
