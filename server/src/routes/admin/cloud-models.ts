import { Router } from 'express';
import { z } from 'zod';
import { isUniqueViolation } from '../../audit/chain.js';
import { agentToolSchema } from '../../cloud/model-backends.js';
import { conflict } from '../../http/problem.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import type { Services } from '../../services.js';

/*
 * 1.9.99-final, Sprint 60 (B-10503): a DigitalOcean GenAI agent of a cloud account as a registry tool
 * (`cloud/model-backends.ts`). Needs `cloud:read` (the account, one the caller may see) and `tools:manage` (the
 * entry). The entry is a draft (`impl: cloud-agent`, side effect `read`, input `{ prompt }`), published through the
 * registry like any tool; the agent's access key is given only as a vault reference the caller can read.
 *
 *   POST /admin/cloud/accounts/:id/agent-tools   { agent, name, description?, keyRef, label?, ratePerHour? } → 201 the entry
 */

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');

export function cloudModelRoutes(s: Services): Router {
  const r = Router();
  const both = [noStore, requireAuth(), requirePermission(s, 'cloud:read'), requirePermission(s, 'tools:manage')];

  r.post('/cloud/accounts/:id/agent-tools', ...both, async (req, res) => {
    const body = parseBody(agentToolSchema, req.body);
    try {
      const e = await s.cloud.modelBackends.publishAgent(principalOf(req), parseBody(id26, req.params.id), body, { ip: ip(req), traceId: req.traceId });
      res.status(201).json({ id: e.id, kind: e.kind, name: e.name, version: e.version, impl: e.impl, status: e.status, label: e.label, sideEffect: e.side_effect, inputSchema: e.input_schema, definition: { provider: 'digitalocean', accountId: e.definition.accountId, agentUuid: e.definition.agentUuid, agentName: e.definition.agentName, endpoint: e.definition.endpoint, keyRef: e.definition.keyRef }, checks: e.checks });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('A tool with that name and version exists.');
      throw err;
    }
  });

  return r;
}
