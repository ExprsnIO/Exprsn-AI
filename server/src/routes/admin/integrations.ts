import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../../audit/chain.js';
import { clears, LABELS, type Label } from '../../authz/labels.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import { badRequest, forbidden, HttpProblem } from '../../http/problem.js';
import { HostRefused } from '../../mcp/hosts.js';
import { hostEntryProblem } from '../../integrations/hosts.js';
import { deliveryView, isEventPattern, WEBHOOK_EVENT_GROUPS, webhookView } from '../../webhooks/service.js';
import type { Services } from '../../services.js';

const id26 = z.string().length(26);
const url = z.string().trim().max(2000).refine((u) => /^https?:\/\//i.test(u), 'must start with http:// or https://');
const events = z.array(z.string().trim().min(1).max(120)).min(1).max(50).refine((l) => l.every(isEventPattern), 'each event is a name, a prefix ending in .* or *');

/**
 * Tenant integrations (Sprint 13): the outbound host allow-list (`tenant:manage`) and outbound webhooks
 * (`webhooks:manage`). Secrets are returned once, at creation and rotation.
 */
export function integrationAdminRoutes(s: Services): Router {
  const r = Router();
  r.use(['/integrations', '/webhooks'], noStore, requireAuth());
  const tenant = requirePermission(s, 'tenant:manage');
  const hooks = requirePermission(s, 'webhooks:manage');
  const w = s.webhooks;

  const audit = (req: Request, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>, label: Label = 'internal') => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, label, ...(detail ? { detail } : {}), traceId: req.traceId });
  };

  const refused = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HostRefused) throw new HttpProblem(422, 'Endpoint refused', err.message, { extensions: { step: 'hosts' } });
      throw err;
    }
  };

  // ---------- host allow-list ----------

  r.get('/integrations/hosts', tenant, async (req, res) => {
    const x = await s.integrations.get(principalOf(req).tenantId);
    res.json({ hosts: x.allowedHosts, updatedAt: x.updatedAt, operator: { webhooks: s.cfg.WEBHOOK_ALLOWED_HOSTS ? s.cfg.WEBHOOK_ALLOWED_HOSTS.split(',').map((h) => h.trim()).filter(Boolean) : [], workflows: s.cfg.WORKFLOW_HTTP_HOSTS ? s.cfg.WORKFLOW_HTTP_HOSTS.split(',').map((h) => h.trim()).filter(Boolean) : [] } });
  });

  r.put('/integrations/hosts', tenant, async (req, res) => {
    const p = principalOf(req);
    const { hosts } = parseBody(z.object({ hosts: z.array(z.string().trim().max(253)).max(200) }).strict(), req.body);
    const clean = [...new Set(hosts.map((h) => h.toLowerCase()).filter(Boolean))];
    const problems = clean.map(hostEntryProblem).filter((x): x is string => !!x);
    if (problems.length) throw badRequest(problems[0]!, { errors: problems.map((m) => ({ path: 'hosts', message: m })) });
    const before = await s.integrations.get(p.tenantId);
    const after = await s.integrations.set(p.tenantId, { allowedHosts: clean }, p.userId);
    await audit(req, 'tenant.hosts.updated', { tenant: p.tenantId }, { before: before.allowedHosts, after: after.allowedHosts });
    res.json({ hosts: after.allowedHosts, updatedAt: after.updatedAt });
  });

  // ---------- webhooks ----------

  r.get('/webhooks', hooks, async (req, res) => {
    const p = principalOf(req);
    res.json({ webhooks: (await w.list(p.tenantId)).map((x) => webhookView(x, w.o.breakerCooldownMs)), events: WEBHOOK_EVENT_GROUPS, settings: { maxAttempts: w.o.maxAttempts, retryBaseMs: w.o.retryBaseMs, breakerThreshold: w.o.breakerThreshold, breakerCooldownMs: w.o.breakerCooldownMs, timeoutMs: w.o.timeoutMs } });
  });

  r.post('/webhooks', hooks, async (req, res) => {
    const p = principalOf(req);
    const b = parseBody(z.object({ name: z.string().trim().min(1).max(100), url, events, maxLabel: z.enum(LABELS).default('internal'), ordered: z.boolean().default(false), signing: z.enum(['hmac', 'ed25519']).default('hmac') }).strict(), req.body);
    if (!clears(p.clearance, b.maxLabel)) throw forbidden(`Your clearance is ${p.clearance}; a webhook cannot carry ${b.maxLabel} events.`, { step: 'clearance' });
    if (b.signing === 'ed25519') await ensureKey(req);
    const { row, secret } = await refused(() => w.create(p.tenantId, p.userId, b));
    await audit(req, 'webhook.created', { webhook: row.id, name: row.name }, { url: row.url, events: row.events, maxLabel: row.max_label, ordered: row.ordered, signing: row.signing });
    res.status(201).json({ ...webhookView(row, w.o.breakerCooldownMs), secret });
  });

  r.patch('/webhooks/:id', hooks, async (req, res) => {
    const p = principalOf(req);
    const b = parseBody(z.object({ name: z.string().trim().min(1).max(100).optional(), url: url.optional(), events: events.optional(), maxLabel: z.enum(LABELS).optional(), state: z.enum(['active', 'disabled']).optional(), ordered: z.boolean().optional(), signing: z.enum(['hmac', 'ed25519']).optional() }).strict(), req.body);
    if (b.maxLabel && !clears(p.clearance, b.maxLabel)) throw forbidden(`Your clearance is ${p.clearance}; a webhook cannot carry ${b.maxLabel} events.`, { step: 'clearance' });
    if (b.signing === 'ed25519') await ensureKey(req);
    const { before, after } = await refused(() => w.update(p.tenantId, parseBody(id26, req.params.id), b));
    await audit(req, after.state !== before.state ? (after.state === 'active' ? 'webhook.enabled' : 'webhook.disabled') : 'webhook.updated', { webhook: after.id, name: after.name }, { changed: Object.keys(b), url: after.url, events: after.events, maxLabel: after.max_label, ordered: after.ordered, signing: after.signing });
    res.json(webhookView(after, w.o.breakerCooldownMs));
  });

  // ---------- Ed25519 signing key (B-1004) ----------

  const keyView = async (tenantId: string) => {
    const t = await s.tenants.byId(tenantId);
    const keys = await w.signingKeys(tenantId);
    const active = keys.find((k) => k.state === 'active') ?? null;
    return { active: active ? { kid: active.id, publicKey: active.public_key, createdAt: Number(active.created_at) } : null, retired: keys.filter((k) => k.state === 'retired').map((k) => ({ kid: k.id, publicKey: k.public_key, retiredAt: k.retired_at == null ? null : Number(k.retired_at) })), jwksUrl: `${s.cfg.PUBLIC_URL.replace(/\/$/, '')}/webhooks/keys/${t?.slug ?? tenantId}` };
  };

  /** The first Ed25519 webhook creates the tenant's key pair. */
  const ensureKey = async (req: Request) => {
    const p = principalOf(req);
    if (await w.activeKey(p.tenantId)) return;
    const { row } = await w.createKey(p.tenantId, p.userId);
    await audit(req, 'webhook.signing-key.created', { key: row.id }, { publicKey: row.public_key });
  };

  r.get('/webhooks/signing-key', hooks, async (req, res) => {
    res.json(await keyView(principalOf(req).tenantId));
  });

  r.post('/webhooks/signing-key/rotate', hooks, async (req, res) => {
    const p = principalOf(req);
    const { row, retired } = await w.createKey(p.tenantId, p.userId);
    await audit(req, retired ? 'webhook.signing-key.rotated' : 'webhook.signing-key.created', { key: row.id }, { publicKey: row.public_key, retired });
    res.json(await keyView(p.tenantId));
  });

  r.post('/webhooks/:id/secret', hooks, async (req, res) => {
    const p = principalOf(req);
    const id = parseBody(id26, req.params.id);
    const secret = await w.rotateSecret(p.tenantId, id);
    const x = await w.get(p.tenantId, id);
    await audit(req, 'webhook.secret.rotated', { webhook: x.id, name: x.name });
    res.json({ secret });
  });

  r.delete('/webhooks/:id', hooks, async (req, res) => {
    const p = principalOf(req);
    const x = await w.remove(p.tenantId, parseBody(id26, req.params.id));
    await audit(req, 'webhook.deleted', { webhook: x.id, name: x.name }, { url: x.url });
    res.status(204).end();
  });

  r.post('/webhooks/:id/test', hooks, async (req, res) => {
    const p = principalOf(req);
    const d = await w.ping(p.tenantId, parseBody(id26, req.params.id), p.username);
    await audit(req, 'webhook.tested', { webhook: d.webhook_id, delivery: d.id });
    res.status(202).json(deliveryView(d));
  });

  r.get('/webhooks/:id/deliveries', hooks, async (req, res) => {
    const p = principalOf(req);
    const q = parseBody(z.object({ state: z.enum(['pending', 'succeeded', 'failed']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    const x = await w.get(p.tenantId, parseBody(id26, req.params.id));
    // Deliveries of events above the reader's clearance are counted, not listed.
    const all = await w.deliveries(p.tenantId, x.id, q);
    const shown = all.filter((d) => clears(p.clearance, d.label));
    res.json({ deliveries: shown.map(deliveryView), withheld: all.length - shown.length });
  });

  r.post('/webhooks/:id/deliveries/:did/replay', hooks, async (req, res) => {
    const p = principalOf(req);
    const d = await w.replay(p.tenantId, parseBody(id26, req.params.id), parseBody(id26, req.params.did), p.clearance);
    await audit(req, 'webhook.delivery.replayed', { webhook: d.webhook_id, delivery: d.id, replayOf: d.replay_of }, { event: d.event }, d.label);
    res.status(202).json(deliveryView(d));
  });

  return r;
}
