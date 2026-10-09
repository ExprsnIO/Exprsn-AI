import { Router } from 'express';
import { z } from 'zod';
import { noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import type { Services } from '../../services.js';
import { THINKING_VISIBILITIES } from '../../thinking/service.js';

/**
 * 1.7.0, Sprint 41c (B-11701, B-11702): the thinking policy per tenant and per workspace (who sees thinking, its
 * retention, exports, the workspace's thinking-token budget), managed by profile admins from the Profiles screen.
 */
export function thinkingAdminRoutes(s: Services): Router {
  const r = Router();
  r.use('/thinking', noStore, requireAuth(), requirePermission(s, 'profiles:manage'));

  r.get('/thinking/policy', async (req, res) => {
    const q = parseBody(z.object({ workspace: z.string().length(26).optional() }), req.query);
    const p = principalOf(req);
    res.json(await s.thinking.policies(p.tenantId, q.workspace ?? p.workspaceId ?? null));
  });

  r.put('/thinking/policy', async (req, res) => {
    const body = parseBody(
      z
        .object({
          workspace: z.string().length(26).nullable().default(null),
          visibility: z.enum(THINKING_VISIBILITIES as [string, ...string[]]).optional(),
          retentionDays: z.number().int().min(0).max(3650).nullable().optional(),
          exports: z.boolean().optional(),
          budgetTokensPerDay: z.number().int().min(100).max(1_000_000_000).nullable().optional(),
          /** Removes a workspace's own policy so it inherits the tenant's. */
          reset: z.boolean().default(false)
        })
        .strict(),
      req.body
    );
    const { workspace, reset, ...patch } = body;
    res.json(await s.thinking.setPolicy(principalOf(req), workspace, patch as Parameters<typeof s.thinking.setPolicy>[2], reset));
  });

  return r;
}
