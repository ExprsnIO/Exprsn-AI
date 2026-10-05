import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { LABELS } from '../authz/labels.js';
import type { Permission } from '../authz/permissions.js';
import { CHECKPOINTS } from '../guardrails/types.js';
import { ip, noStore, parseBody, principalOf, requireAnyPermission, requireAuth, requirePermission, requireRecentAuth } from '../http/middleware.js';
import { OBJECT_TYPE } from '../moderation/registry.js';
import { ModerationService, providerView, queueView, type ModCtx } from '../moderation/service.js';
import type { Principal } from '../authz/policy.js';
import type { Services } from '../services.js';

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const objectType = z.string().regex(OBJECT_TYPE, 'an object type: lower-case letters, digits, dots and hyphens');
const objectId = z.string().trim().min(1).max(512);
const checkItem = z
  .object({
    type: objectType,
    id: objectId,
    text: z.string().max(200_000).optional(),
    workspaceId: id26.nullable().optional(),
    label: z.enum(LABELS).optional(),
    checkpoint: z.enum(CHECKPOINTS).optional(),
    subject: z.string().trim().min(3).max(2048).optional(),
    apply: z.boolean().optional()
  })
  .strict();
const level = z.enum(['workspace', 'tenant', 'platform']);
const queueBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    workspaceId: id26.nullable().optional(),
    rules: z.array(z.string().trim().min(1).max(200)).max(50).nullable().optional(),
    labels: z.array(z.enum(LABELS)).max(4).nullable().optional(),
    kinds: z.array(z.string().trim().min(1).max(60)).max(20).nullable().optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
    slaMinutes: z.number().int().min(1).max(30 * 24 * 60),
    escalateTo: level,
    escalationSlaMinutes: z.number().int().min(1).max(30 * 24 * 60).optional(),
    enabled: z.boolean().optional()
  })
  .strict();
const providerBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    kind: z.enum(['json', 'openai']).default('json'),
    url: z.url().max(500),
    secret: z.string().min(1).max(4096).nullable().optional(),
    zone: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
    mode: z.enum(['shadow', 'enforce']).default('shadow'),
    enabled: z.boolean().default(false),
    objectTypes: z.array(objectType).max(50).nullable().optional(),
    threshold: z.number().min(0).max(1).optional()
  })
  .strict();

/**
 * Moderation (Sprint 26, B-1901 to B-1907) under `/api/moderation`, on top of the flag queue in `guardrails.ts`.
 * Checks need `moderation:check`; reports `moderation:report` and appeals `moderation:appeal` (members hold both);
 * actions, queues and appeal decisions `moderation:review`; sanctions `moderation:sanction` with a recent sign-in;
 * review-queue configuration, external providers and the dead-letter queue `moderation:manage`.
 */
export function moderationRoutes(s: Services): Router {
  const r = Router();
  r.use('/moderation', noStore, requireAuth());
  const m = s.moderation;
  const perm = (x: Permission) => requirePermission(s, x);
  const check = perm('moderation:check');
  const report = perm('moderation:report');
  const appealPerm = perm('moderation:appeal');
  const review = perm('moderation:review');
  const sanction = perm('moderation:sanction');
  const manage = perm('moderation:manage');
  // Sanctions change who may sign in: a browser session that recently proved its owner (step-up), never a key.
  const stepUp: RequestHandler[] = [requireAuth({ sessionOnly: true }), requireRecentAuth(s)];
  const anyOf = (...perms: Permission[]): RequestHandler => requireAnyPermission(s, perms);
  const ctx = (req: Request): ModCtx & { principal: Principal } => ModerationService.ctxFor(principalOf(req), ip(req), req.traceId) as ModCtx & { principal: Principal };

  // ---------- B-1901: checks ----------

  r.get('/moderation/types', anyOf('moderation:check', 'moderation:report'), (_req, res) => {
    res.json({ items: m.registry.list() });
  });

  r.post('/moderation/check', check, async (req, res) => {
    const body = parseBody(checkItem, req.body);
    res.json(await m.check(ctx(req), body));
  });

  r.post('/moderation/batch', check, async (req, res) => {
    const body = parseBody(z.object({ items: z.array(checkItem).min(1).max(100) }).strict(), req.body);
    res.json(await m.batch(ctx(req), body.items));
  });

  // ---------- B-1902: reports ----------

  r.post('/moderation/reports', report, async (req, res) => {
    const body = parseBody(z.object({ type: objectType, id: objectId, reason: z.string().trim().min(1).max(200), note: z.string().trim().max(1000).optional(), severity: z.enum(['high', 'medium', 'low']).default('medium') }).strict(), req.body);
    const out = await m.report(ctx(req), body);
    res.status(out.duplicate ? 200 : 201).json(out);
  });

  // ---------- B-1903: actions and appeals ----------

  r.post('/moderation/flags/:ref/action', review, async (req, res) => {
    const body = parseBody(z.object({ action: z.literal('hide'), reason: z.string().trim().min(1).max(500) }).strict(), req.body);
    res.status(201).json(await m.actOnFlag(ctx(req), String(req.params.ref), body.reason));
  });

  r.get('/moderation/actions', review, async (req, res) => {
    const q = parseBody(z.object({ type: objectType.optional(), id: objectId.optional(), ownerId: id26.optional() }).strict(), req.query);
    res.json({ items: await m.actions(principalOf(req), q) });
  });

  r.get('/moderation/mine', appealPerm, async (req, res) => {
    res.json(await m.mine(principalOf(req)));
  });

  // A reviewer may also file one for someone who cannot sign in (forUserId).
  r.post('/moderation/appeals', anyOf('moderation:appeal', 'moderation:review'), async (req, res) => {
    const body = parseBody(z.object({ actionId: id26.optional(), sanctionId: id26.optional(), statement: z.string().trim().min(1).max(4000), forUserId: id26.optional() }).strict(), req.body);
    res.status(201).json(await m.appeal(ctx(req), body));
  });

  r.get('/moderation/appeals', review, async (req, res) => {
    const q = parseBody(z.object({ state: z.enum(['pending', 'reviewing', 'upheld', 'denied']).optional() }).strict(), req.query);
    res.json({ items: await m.appeals(principalOf(req), q.state) });
  });

  r.get('/moderation/appeals/:ref', anyOf('moderation:review', 'moderation:appeal'), async (req, res) => {
    res.json(await m.appealFor(principalOf(req), String(req.params.ref)));
  });

  r.post('/moderation/appeals/:ref/review', review, async (req, res) => {
    res.json(await m.startReview(ctx(req), String(req.params.ref)));
  });

  r.post('/moderation/appeals/:ref/decide', review, async (req, res) => {
    const body = parseBody(z.object({ decision: z.enum(['upheld', 'denied']), note: z.string().trim().max(1000).nullable().optional() }).strict(), req.body);
    res.json(await m.decideAppeal(ctx(req), String(req.params.ref), body.decision, body.note ?? null));
  });

  // ---------- B-1904: sanctions ----------

  r.get('/moderation/sanctions', sanction, async (req, res) => {
    const q = parseBody(z.object({ userId: id26.optional(), state: z.enum(['active', 'expired', 'lifted', 'reversed']).optional() }).strict(), req.query);
    res.json({ items: await m.sanctions(principalOf(req), q) });
  });

  r.post('/moderation/sanctions', sanction, ...stepUp, async (req, res) => {
    const body = parseBody(z.object({ userId: id26, kind: z.enum(['warn', 'suspend', 'ban']), durationMinutes: z.number().int().min(1).max(5 * 365 * 24 * 60).optional(), reason: z.string().trim().min(1).max(1000), flag: z.string().trim().min(1).max(40).optional() }).strict(), req.body);
    res.status(201).json(await m.sanction(ctx(req), body));
  });

  r.post('/moderation/sanctions/:id/lift', sanction, ...stepUp, async (req, res) => {
    const body = parseBody(z.object({ reason: z.string().trim().max(500).nullable().optional() }).strict(), req.body ?? {});
    res.json(await m.lift(ctx(req), parseBody(id26, req.params.id), body.reason ?? null));
  });

  // ---------- B-1905: routed queues and the dead-letter queue ----------

  r.get('/moderation/queues', anyOf('moderation:review', 'moderation:manage'), async (req, res) => {
    res.json({ items: (await m.queues(principalOf(req).tenantId)).map(queueView) });
  });

  r.post('/moderation/queues', manage, async (req, res) => {
    res.status(201).json(queueView(await m.saveQueue(ctx(req), null, parseBody(queueBody, req.body))));
  });

  r.patch('/moderation/queues/:id', manage, async (req, res) => {
    const id = parseBody(id26, req.params.id);
    const before = await m.queue(principalOf(req).tenantId, id);
    const patch = parseBody(queueBody.partial(), req.body);
    res.json(queueView(await m.saveQueue(ctx(req), id, { name: before.name, workspaceId: before.workspace_id, rules: before.rules, labels: before.labels, kinds: before.kinds, priority: before.priority, slaMinutes: before.sla_minutes, escalateTo: before.escalate_to, escalationSlaMinutes: before.escalation_sla_minutes, enabled: before.enabled, ...stripUndefined(patch) })));
  });

  r.delete('/moderation/queues/:id', manage, async (req, res) => {
    await m.deleteQueue(ctx(req), parseBody(id26, req.params.id));
    res.status(204).end();
  });

  r.get('/moderation/queues/:id/flags', review, async (req, res) => {
    res.json(await m.queueFlags(principalOf(req), parseBody(id26, req.params.id)));
  });

  r.get('/moderation/dead-letters', manage, async (req, res) => {
    const q = parseBody(z.object({ state: z.enum(['open', 'redriven']).optional() }).strict(), req.query);
    res.json({ items: await m.deadLetters(principalOf(req).tenantId, q.state) });
  });

  r.post('/moderation/dead-letters/:id/redrive', manage, async (req, res) => {
    res.status(201).json(await m.redrive(ctx(req), parseBody(id26, req.params.id)));
  });

  // ---------- B-1906: external providers ----------

  r.get('/moderation/providers', manage, async (req, res) => {
    res.json({ items: (await m.providerList(principalOf(req).tenantId)).map(providerView), enabled: s.cfg.MODERATION_EXTERNAL_PROVIDERS });
  });

  r.post('/moderation/providers', manage, async (req, res) => {
    res.status(201).json(providerView(await m.saveProvider(ctx(req), null, parseBody(providerBody, req.body))));
  });

  r.patch('/moderation/providers/:id', manage, async (req, res) => {
    const id = parseBody(id26, req.params.id);
    const patch = parseBody(providerBody.partial().omit({ kind: true }).extend({ kind: z.enum(['json', 'openai']).optional(), mode: z.enum(['shadow', 'enforce']).optional(), enabled: z.boolean().optional() }), req.body);
    res.json(providerView(await m.saveProvider(ctx(req), id, patch)));
  });

  r.delete('/moderation/providers/:id', manage, async (req, res) => {
    await m.deleteProvider(ctx(req), parseBody(id26, req.params.id));
    res.status(204).end();
  });

  r.get('/moderation/providers/:id/verdicts', manage, async (req, res) => {
    res.json({ items: await m.verdicts(principalOf(req).tenantId, parseBody(id26, req.params.id)) });
  });

  return r;
}

function stripUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
