import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import type { Label } from '../authz/labels.js';
import { ip, noStore, parseBody, principalOf, requireAnyPermission, requireAuth } from '../http/middleware.js';
import { chainTree, decideHeld, replayNode } from '../chain/view.js';
import type { Services } from '../services.js';

const ulidParam = z.string().regex(/^[0-9A-Z]{26}$/, 'A chain or node id');

/**
 * Sprint 34 (B-4106, B-4107): the chain view, held calls decided from the chain, and replay from a node. A chain is
 * visible to its principal and to agent, tool and workflow admins within their clearance; a held call is decided by
 * whoever may decide it where it waits (the service there checks).
 */
export function chainRoutes(s: Services): Router {
  const r = Router();
  r.use('/chains', noStore, requireAuth());
  const read = requireAnyPermission(s, ['agents:run', 'agents:manage', 'tools:manage', 'workflows:manage']);
  const decide = requireAnyPermission(s, ['agents:run', 'tools:manage', 'agents:manage', 'workflows:manage']);
  const replay = requireAnyPermission(s, ['agents:run', 'agents:manage']);
  const audit = (req: Request, action: string, target: Record<string, unknown>, label: Label | undefined, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, ...(label ? { label } : {}), ...(detail ? { detail } : {}), traceId: req.traceId });
  };

  r.get('/chains/:id', read, async (req, res) => {
    const id = parseBody(ulidParam, req.params.id);
    res.json(await chainTree(s, principalOf(req), id));
  });

  r.post('/chains/:id/held/:node/decision', decide, async (req, res) => {
    const id = parseBody(ulidParam, req.params.id);
    const node = parseBody(ulidParam, req.params.node);
    const b = parseBody(z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(1000).nullable().default(null), step: z.number().int().min(1).max(1000).optional(), approval: ulidParam.optional() }).strict(), req.body);
    const out = await decideHeld(s, principalOf(req), id, node, b, ip(req));
    if (out.held.at.kind === 'workflow-run' && 'workflow' in out && out.workflow) {
      // As the approvals route records it.
      await audit(req, out.workflow.state === 'approved' ? 'workflow.approval.approved' : 'workflow.approval.rejected', { workflow: out.workflow.workflowId, run: out.workflow.run, approval: out.workflow.approval }, out.workflow.label, { reason: b.note ? 'given' : null, via: 'chain' });
    }
    await audit(req, 'chain.held.decided', { chain: id, node, ...(out.held.at.kind === 'agent-run' ? { run: out.held.at.run, step: out.held.at.step } : { run: out.held.at.run, approval: out.held.at.approval }) }, undefined, { decision: b.decision, tool: out.held.tool, sideEffect: out.held.sideEffect, depth: out.held.path.length - 1, path: out.held.path.map((x) => `${x.kind}:${x.name ?? x.ref}`) });
    res.json({ chain: id, node, at: out.held.at, path: out.held.path, decision: b.decision === 'approve' ? 'approved' : 'rejected' });
  });

  r.post('/chains/:id/nodes/:node/replay', replay, async (req, res) => {
    const id = parseBody(ulidParam, req.params.id);
    const node = parseBody(ulidParam, req.params.node);
    const b = parseBody(z.object({ fromStep: z.number().int().min(1).max(1000).optional(), fromNode: z.string().min(1).max(63).optional() }).strict(), req.body);
    const out = await replayNode(s, principalOf(req), id, node, b);
    await audit(req, 'chain.node.replayed', { chain: id, node, run: out.run }, out.label, { kind: out.kind, ...(b.fromStep ? { fromStep: b.fromStep } : {}), ...(b.fromNode ? { fromNode: b.fromNode } : {}), newChain: out.chain });
    res.status(202).json(out);
  });

  return r;
}
