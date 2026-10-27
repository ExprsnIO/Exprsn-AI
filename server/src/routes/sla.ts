import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import type { Permission } from '../authz/permissions.js';
import { ip, noStore, parseBody, principalOf, requireAnyPermission, requireAuth, requirePermission } from '../http/middleware.js';
import { policyInput, QUEUE_PERMS, QUEUE_TYPES, routingInput, type QueueType } from '../sla/service.js';
import type { Services } from '../services.js';

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
const type = z.enum(QUEUE_TYPES);

/**
 * Sprint 46 (B-134): SLA policies, routing rules, skills, per-item SLA state and statistics. Each queue type keeps
 * its domain's permissions: its manage permission (`channels:manage` for channel sessions, `moderation:manage` for
 * flags, held writes and appeals, as for the moderation review queues) changes its policies and routing; its review
 * permission (`channels:review`, `flags:review`, `moderation:review`) reads its items, state and statistics. Skills
 * are tags on people: `users:manage` sets them; any of the manage permissions reads them. The route declares the
 * permissions any type needs; the handler then asks for the one of the type in hand.
 */
export function slaRoutes(s: Services): Router {
  const r = Router();
  r.use('/sla', noStore, requireAuth());
  const sla = s.sla;
  const manages = [...new Set(QUEUE_TYPES.map((t) => QUEUE_PERMS[t].manage))] as Permission[];
  const reviews = [...new Set(QUEUE_TYPES.flatMap((t) => [QUEUE_PERMS[t].review, QUEUE_PERMS[t].manage]))] as Permission[];
  const anyManage = requireAnyPermission(s, manages);
  const anyRead = requireAnyPermission(s, reviews);
  const users = requirePermission(s, 'users:manage');
  const anySkillReader = requireAnyPermission(s, ['users:manage', ...manages]);

  /** Asks for the permission of the queue type in hand, as `requirePermission` does (a refusal is recorded). */
  const need = (req: Request, res: Response, perm: Permission) =>
    new Promise<void>((resolve, reject) => {
      Promise.resolve(requirePermission(s, perm)(req, res, (err?: unknown) => (err ? reject(err as Error) : resolve()))).catch(reject);
    });
  const typeOf = (req: Request) => parseBody(z.object({ type }).strict(), { type: (req.query as Record<string, unknown>).type }).type as QueueType;

  r.get('/sla/policies', anyRead, async (req, res) => {
    const q = parseBody(z.object({ type: type.optional() }).strict(), req.query);
    res.json({ items: await sla.policies(principalOf(req), q.type) });
  });

  r.post('/sla/policies', anyManage, async (req, res) => {
    const body = parseBody(policyInput, req.body);
    await need(req, res, QUEUE_PERMS[body.queueType].manage);
    res.status(201).json(await sla.savePolicy(principalOf(req), ip(req), null, body, req.traceId));
  });

  r.put('/sla/policies/:id', anyManage, async (req, res) => {
    const id = parseBody(id26, req.params.id);
    const body = parseBody(policyInput, req.body);
    await need(req, res, QUEUE_PERMS[body.queueType].manage);
    res.json(await sla.savePolicy(principalOf(req), ip(req), id, body, req.traceId));
  });

  r.delete('/sla/policies/:id', anyManage, async (req, res) => {
    await sla.deletePolicy(principalOf(req), ip(req), parseBody(id26, req.params.id), req.traceId);
    res.status(204).end();
  });

  r.get('/sla/routing', anyRead, async (req, res) => {
    const q = parseBody(z.object({ type: type.optional() }).strict(), req.query);
    res.json({ items: await sla.rules(principalOf(req), q.type) });
  });

  r.put('/sla/routing', anyManage, async (req, res) => {
    const body = parseBody(routingInput, req.body);
    await need(req, res, QUEUE_PERMS[body.queueType].manage);
    res.json(await sla.saveRule(principalOf(req), ip(req), body, req.traceId));
  });

  r.delete('/sla/routing/:id', anyManage, async (req, res) => {
    await sla.deleteRule(principalOf(req), ip(req), parseBody(id26, req.params.id), req.traceId);
    res.status(204).end();
  });

  r.get('/sla/skills', anySkillReader, async (req, res) => {
    res.json({ items: await sla.skills(principalOf(req).tenantId) });
  });

  r.put('/sla/skills/:userId', users, async (req, res) => {
    const userId = parseBody(id26, req.params.userId);
    const body = parseBody(z.object({ skills: z.array(z.string().trim().min(1).max(63).regex(/^[A-Za-z0-9][A-Za-z0-9 _.:-]*$/, 'letters, digits, spaces and _ . : -')).max(50) }).strict(), req.body);
    res.json(await sla.setSkills(principalOf(req), ip(req), userId, body.skills, req.traceId));
  });

  r.get('/sla/items', anyRead, async (req, res) => {
    const q = parseBody(z.object({ type, filter: z.enum(['breaching-soon', 'breached']).optional(), scope: z.string().max(63).optional() }).strict(), req.query);
    await need(req, res, QUEUE_PERMS[q.type].review);
    res.json(await sla.items(principalOf(req), q.type, { filter: q.filter, scope: q.scope }));
  });

  r.get('/sla/items/:id', anyRead, async (req, res) => {
    const t = typeOf(req);
    await need(req, res, QUEUE_PERMS[t].review);
    res.json(await sla.item(principalOf(req), t, parseBody(z.string().min(1).max(64), req.params.id)));
  });

  r.get('/sla/stats', anyRead, async (req, res) => {
    const q = parseBody(z.object({ type, days: z.coerce.number().int().min(1).max(365).default(30) }).strict(), req.query);
    await need(req, res, QUEUE_PERMS[q.type].review);
    res.json(await sla.stats(principalOf(req), q.type, q.days));
  });

  /** Runs the tenant's tick now (timers, warn and breach actions, routing), as the schedule would. */
  r.post('/sla/evaluate', anyManage, async (req, res) => {
    const p = principalOf(req);
    const out = await sla.tick(p.tenantId);
    await s.audit.append({ tenantId: p.tenantId, action: 'sla.evaluated', kind: 'admin', actor: actorFrom(p, ip(req)), target: { tenant: p.tenantId }, detail: out, label: 'internal', traceId: req.traceId });
    res.json(out);
  });

  return r;
}
