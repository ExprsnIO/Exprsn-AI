import { Router } from 'express';
import { z } from 'zod';
import { actorFrom, type AuditEvent } from '../../audit/chain.js';
import { clears, type Label } from '../../authz/labels.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import type { Services } from '../../services.js';

/** Events above the reader's clearance keep their place in the chain but lose their content. */
const redact = (e: AuditEvent, clearance: Label) =>
  clears(clearance, e.label) ? e : { id: e.id, seq: e.seq, ts: e.ts, action: e.action, kind: e.kind, label: e.label, hash: e.hash, prev_hash: e.prev_hash, redacted: true };

export function auditAdminRoutes(s: Services): Router {
  const r = Router();
  r.use('/audit', noStore, requireAuth(), requirePermission(s, 'audit:read'));

  r.get('/audit', async (req, res) => {
    const p = principalOf(req);
    const q = parseBody(
      z.object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        before: z.coerce.number().int().min(1).optional(),
        kind: z.enum(['auth', 'decision', 'admin', 'correction', 'system']).optional(),
        action: z.string().max(100).regex(/^[a-z0-9._]*$/).optional()
      }),
      req.query
    );
    const events = await s.audit.list(p.tenantId, q);
    res.json(events.map((e) => redact(e, p.clearance)));
  });

  r.post('/audit/verify', async (req, res) => {
    const p = principalOf(req);
    const result = await s.audit.verify(p.tenantId);
    await s.audit.append({ tenantId: p.tenantId, action: 'audit.chain.verified', kind: 'system', actor: actorFrom(p, ip(req)), detail: { status: result.status, checked: result.checked, ...(result.brokenAt ? { brokenAt: result.brokenAt } : {}) }, traceId: req.traceId });
    if (result.status === 'broken') s.log.error({ tenant: p.tenantId, brokenAt: result.brokenAt }, 'audit chain verification failed');
    res.json(result);
  });

  return r;
}
