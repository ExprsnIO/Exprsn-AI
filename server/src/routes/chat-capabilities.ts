import { Router, type Request } from 'express';
import { z } from 'zod';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { forbidden } from '../http/problem.js';
import { effectivePermissions } from '../authz/policy.js';
import { CHAT_BUDGET_LIMITS } from '../chat/capabilities.js';
import type { Services } from '../services.js';

const id26 = z.string().regex(/^[0-9A-Z]{26}$/, 'An id');
const profile = z.string().trim().min(1).max(63).optional();
const name = z.string().trim().min(1).max(200);
const budgets = z.object({ steps: z.number().int().min(1).max(CHAT_BUDGET_LIMITS.steps), tokens: z.number().int().min(100).max(CHAT_BUDGET_LIMITS.tokens), wallSeconds: z.number().int().min(5).max(CHAT_BUDGET_LIMITS.wallSeconds), toolCalls: z.number().int().min(0).max(CHAT_BUDGET_LIMITS.toolCalls) }).partial();

/**
 * 1.7.0, Sprint 40 (B-40): agents, tools and skills in chat. What a conversation may call, the calls a person makes
 * from its composer (`/tool`, `@agent`, `/workflow`) with their approval cards, and the skills added to it. Everything
 * is scoped to the caller's own conversations in their current workspace; the service audits every call and decision.
 */
export function chatCapabilityRoutes(s: Services): Router {
  const r = Router();
  r.use('/conversations', noStore, requireAuth());
  const read = requirePermission(s, 'chat:read');
  const write = requirePermission(s, 'chat:write');
  const tools = requirePermission(s, 'tools:invoke');
  const run = requirePermission(s, 'agents:run');
  const caps = s.chatCapabilities;
  const at = (req: Request) => ({ ip: ip(req), traceId: req.traceId });
  const conv = (req: Request) => parseBody(id26, req.params.id);

  /** B-4001. `new` stands for the conversation the composer's next message would start. */
  r.get('/conversations/:id/capabilities', read, async (req, res) => {
    const q = parseBody(z.object({ profile }), req.query);
    const id = req.params.id === 'new' ? null : conv(req);
    res.json(await caps.capabilities(principalOf(req), id, q.profile ?? null));
  });

  r.get('/conversations/:id/invocations', read, async (req, res) => {
    res.json(await caps.list(principalOf(req), conv(req)));
  });

  /** B-4002: `/tool`, with arguments from the form, or text the profile's model turns into arguments. */
  r.post('/conversations/:id/tools', write, tools, async (req, res) => {
    const b = parseBody(
      z
        .object({ tool: name, arguments: z.record(z.string().max(200), z.unknown()).optional(), text: z.string().trim().min(1).max(20_000).optional(), profile, parentId: id26.nullable().optional() })
        .strict()
        .refine((x) => x.arguments === undefined || x.text === undefined, 'Send arguments or text, not both.'),
      req.body
    );
    const p = principalOf(req);
    if (b.text !== undefined && b.arguments === undefined && !effectivePermissions(p).has('inference:invoke')) throw forbidden('Turning text into arguments calls the model, which your roles do not allow; fill in the form instead.', { step: 'role', action: 'inference:invoke' });
    res.status(202).json(await caps.callTool(p, conv(req), b, at(req)));
  });

  /** B-4003: the caller's own decision on a pending approval card. */
  r.post('/conversations/:id/invocations/:iid/decision', write, tools, async (req, res) => {
    const b = parseBody(z.object({ decision: z.enum(['approve', 'deny']), note: z.string().trim().max(500).nullable().default(null) }).strict(), req.body);
    res.json(await caps.decide(principalOf(req), conv(req), parseBody(id26, req.params.iid), b.decision, b.note, at(req)));
  });

  r.post('/conversations/:id/invocations/:iid/cancel', write, async (req, res) => {
    res.json(await caps.cancel(principalOf(req), conv(req), parseBody(id26, req.params.iid), at(req)));
  });

  /** B-4009: a call held anywhere in the run's chain, decided from the conversation's card. */
  r.post('/conversations/:id/invocations/:iid/held', write, run, async (req, res) => {
    const b = parseBody(z.object({ node: id26, decision: z.enum(['approve', 'reject']), note: z.string().trim().max(1000).nullable().default(null), step: z.number().int().min(1).max(1000).optional(), approval: id26.optional() }).strict(), req.body);
    res.json(await caps.decideHeld(principalOf(req), conv(req), parseBody(id26, req.params.iid), b, at(req)));
  });

  /** B-4004: `@agent`. */
  r.post('/conversations/:id/agents', write, run, async (req, res) => {
    const b = parseBody(z.object({ agent: name, input: z.string().trim().min(1).max(100_000), context: z.number().int().min(0).max(20).optional(), budgets: budgets.optional(), profile, parentId: id26.nullable().optional() }).strict(), req.body);
    res.status(202).json(await caps.startAgent(principalOf(req), conv(req), b, at(req)));
  });

  /** B-4009: `/workflow`. */
  r.post('/conversations/:id/workflows', write, run, async (req, res) => {
    const b = parseBody(z.object({ workflow: name, input: z.record(z.string().max(63), z.unknown()).default({}), profile, parentId: id26.nullable().optional() }).strict(), req.body);
    res.status(202).json(await caps.startWorkflow(principalOf(req), conv(req), b, at(req)));
  });

  /** B-4005: `+skill`. */
  r.put('/conversations/:id/skills/:name', write, async (req, res) => {
    const b = parseBody(z.object({ mode: z.enum(['sticky', 'once']).default('sticky'), profile }).strict(), req.body ?? {});
    res.json(await caps.addSkill(principalOf(req), conv(req), parseBody(name, req.params.name), b.mode, b.profile ?? null, at(req)));
  });

  r.delete('/conversations/:id/skills/:name', write, async (req, res) => {
    res.json(await caps.removeSkill(principalOf(req), conv(req), parseBody(name, req.params.name), at(req)));
  });

  return r;
}
