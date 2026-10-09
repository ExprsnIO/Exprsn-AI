import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { authorize } from '../authz/policy.js';
import { LABELS } from '../authz/labels.js';
import type { Permission } from '../authz/permissions.js';
import { ip, noStore, parseBody, principalOf, requireAnyPermission, requireAuth, requirePermission } from '../http/middleware.js';
import { notFound } from '../http/problem.js';
import { MAX_BUDGETS } from '../registry/service.js';
import { rootHeld } from '../chain/view.js';
import type { Services } from '../services.js';

const budgets = z.object({ steps: z.number().int().min(1).max(MAX_BUDGETS.steps), tokens: z.number().int().min(100).max(MAX_BUDGETS.tokens), wallSeconds: z.number().int().min(5).max(MAX_BUDGETS.wallSeconds), toolCalls: z.number().int().min(0).max(MAX_BUDGETS.toolCalls) }).partial();

/**
 * Agent runs, and the per-user MCP token vault. Runs belong to their owner; agent and tool admins may see every run
 * in the tenant within their clearance, and tool admins decide on approvals.
 */
export function agentRoutes(s: Services): Router {
  const r = Router();
  r.use(['/agents', '/runs', '/mcp', '/agent-schedules'], noStore, requireAuth());
  const run = requirePermission(s, 'agents:run');
  const invoke = requirePermission(s, 'tools:invoke');
  /** The first of `perms` the caller holds, checked (and denials audited) like requirePermission. */
  const anyOf = (...perms: Permission[]): RequestHandler => requireAnyPermission(s, perms);
  const audit = (req: Request, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, ...(detail ? { detail } : {}), traceId: req.traceId });
  };

  r.get('/agents', run, async (req, res) => {
    res.json(await s.agents.runnable(principalOf(req)));
  });

  r.get('/runs', anyOf('agents:run', 'tools:manage', 'agents:manage'), async (req, res) => {
    const q = parseBody(z.object({ all: z.enum(['true', 'false']).optional(), state: z.enum(['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'budget']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    const p = principalOf(req);
    // Holders of only an admin permission see the tenant's runs; members their own.
    const all = q.all === 'true' || !authorize(p, 'agents:run').allow;
    res.json(await s.agents.list(p, { all, limit: q.limit, ...(q.state ? { state: q.state } : {}) }));
  });

  r.post('/runs', run, async (req, res) => {
    const b = parseBody(z.object({ agent: z.string().trim().min(1).max(120), input: z.string().trim().min(1).max(100_000), label: z.enum(LABELS).optional(), budgets: budgets.optional() }), req.body);
    const out = await s.agents.start(principalOf(req), { agent: b.agent, input: b.input, ...(b.label ? { label: b.label } : {}), ...(b.budgets ? { budgets: b.budgets } : {}) });
    await audit(req, 'agent.run.started', { run: out.id, agent: out.agent, version: out.agentVersion }, { label: out.label, budgets: out.budgets });
    res.status(202).json(out);
  });

  r.get('/runs/:id', anyOf('agents:run', 'tools:manage', 'agents:manage'), async (req, res) => {
    const p = principalOf(req);
    const v = await s.agents.view(p, String(req.params.id));
    // B-4106: a chain's root shows every call held below it, with its path, to decide from here.
    res.json({ ...v, held: await rootHeld(s, p, v.chain) });
  });

  r.post('/runs/:id/cancel', anyOf('agents:run', 'agents:manage'), async (req, res) => {
    const out = await s.agents.cancel(principalOf(req), String(req.params.id));
    await audit(req, 'agent.run.cancelled', { run: String(req.params.id) });
    res.json(out);
  });

  r.post('/runs/:id/resume', anyOf('agents:run', 'agents:manage'), async (req, res) => {
    const b = parseBody(z.object({ budgets }), req.body);
    const out = await s.agents.resume(principalOf(req), String(req.params.id), b.budgets);
    await audit(req, 'agent.run.resumed', { run: String(req.params.id) }, out);
    res.json(out);
  });

  r.post('/runs/:id/replay', anyOf('agents:run', 'agents:manage'), async (req, res) => {
    const b = parseBody(z.object({ fromStep: z.number().int().min(1).max(1000) }), req.body);
    res.status(202).json(await s.agents.replay(principalOf(req), String(req.params.id), b.fromStep));
  });

  // 1.7.0 (B-11703): the person approves, edits or declines a plan-first run's plan.
  r.post('/runs/:id/plan', anyOf('agents:run', 'agents:manage'), async (req, res) => {
    const body = parseBody(z.object({ decision: z.enum(['approve', 'decline']), steps: z.array(z.object({ title: z.string().trim().min(1).max(200), tools: z.array(z.string().trim().min(1).max(120)).max(8).default([]), data: z.array(z.string().trim().max(200)).max(8).default([]) })).min(1).max(50).optional() }), req.body);
    res.json(await s.agents.decidePlan(principalOf(req), String(req.params.id), body));
  });

  r.post('/runs/:id/steps/:n/decision', anyOf('agents:run', 'tools:manage'), async (req, res) => {
    const b = parseBody(z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(500).nullable().default(null) }), req.body);
    const n = Number.parseInt(String(req.params.n), 10);
    if (!Number.isInteger(n) || n < 1) throw notFound('Step');
    res.json(await s.agents.decide(principalOf(req), String(req.params.id), n, b.decision, b.note));
  });

  // ---------- Sprint 21: scheduled runs (B-1306) ----------

  const cron = z.string().trim().min(9).max(120);
  const scheduleBody = z.object({ name: z.string().trim().min(1).max(120), agent: z.string().trim().min(1).max(120), cron, input: z.string().trim().min(1).max(100_000), label: z.enum(LABELS).default('internal'), budgets: budgets.optional(), enabled: z.boolean().optional() });

  r.get('/agent-schedules', anyOf('agents:run', 'agents:manage'), async (req, res) => {
    const q = parseBody(z.object({ all: z.enum(['true', 'false']).optional() }), req.query);
    const p = principalOf(req);
    res.json(await s.agentSchedules.list(p, { all: q.all === 'true' || !authorize(p, 'agents:run').allow }));
  });

  r.post('/agent-schedules', run, async (req, res) => {
    const b = parseBody(scheduleBody, req.body);
    const out = await s.agentSchedules.create(principalOf(req), { name: b.name, agent: b.agent, cron: b.cron, input: b.input, label: b.label, ...(b.budgets ? { budgets: b.budgets } : {}), ...(b.enabled !== undefined ? { enabled: b.enabled } : {}) });
    await audit(req, 'agent.schedule.created', { schedule: out.id, name: out.name, agent: out.agent }, { cron: out.cron, label: out.label, enabled: out.enabled });
    res.status(201).json(out);
  });

  r.get('/agent-schedules/:id', anyOf('agents:run', 'agents:manage'), async (req, res) => {
    res.json(await s.agentSchedules.get(principalOf(req), String(req.params.id)));
  });

  r.patch('/agent-schedules/:id', anyOf('agents:run', 'agents:manage'), async (req, res) => {
    const b = parseBody(scheduleBody.omit({ name: true }).partial().strict(), req.body);
    const patch = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
    const out = await s.agentSchedules.update(principalOf(req), String(req.params.id), patch);
    await audit(req, 'agent.schedule.updated', { schedule: out.id, name: out.name, agent: out.agent }, { changed: Object.keys(patch), enabled: out.enabled, cron: out.cron });
    res.json(out);
  });

  r.delete('/agent-schedules/:id', anyOf('agents:run', 'agents:manage'), async (req, res) => {
    const sc = await s.agentSchedules.remove(principalOf(req), String(req.params.id));
    await audit(req, 'agent.schedule.deleted', { schedule: sc.id, name: sc.name, agent: sc.agent });
    res.status(204).end();
  });

  r.get('/agent-schedules/:id/history', anyOf('agents:run', 'agents:manage'), async (req, res) => {
    const q = parseBody(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    res.json(await s.agentSchedules.history(principalOf(req), String(req.params.id), q.limit));
  });

  // ---------- the per-user token vault for MCP servers ----------

  /** Servers that act with each user's own token, and whether the caller has connected one. */
  r.get('/mcp/servers', invoke, async (req, res) => {
    const p = principalOf(req);
    const list = (await s.mcp.servers(p.tenantId)).filter((x) => x.state === 'active' && x.auth === 'user');
    res.json(await Promise.all(list.map(async (x) => ({ id: x.id, name: x.name, description: x.description, health: x.health, url: x.url, oauth: !!(await s.mcp.oauth.config(x.id)), ...(await s.mcp.tokenStatus(p, x.id)) }))));
  });

  r.put('/mcp/servers/:id/token', invoke, async (req, res) => {
    const p = principalOf(req);
    const srv = await s.mcp.server(p.tenantId, String(req.params.id));
    const b = parseBody(z.object({ token: z.string().min(8).max(8192), scopes: z.string().trim().max(300).nullable().default(null), expiresAt: z.number().int().nullable().default(null) }), req.body);
    await s.mcp.setToken(p, srv, b.token, b);
    await audit(req, 'mcp.token.connected', { mcpServer: srv.id, name: srv.name }, { scopes: b.scopes, expiresAt: b.expiresAt });
    res.json(await s.mcp.tokenStatus(p, srv.id));
  });

  r.delete('/mcp/servers/:id/token', invoke, async (req, res) => {
    const p = principalOf(req);
    const srv = await s.mcp.server(p.tenantId, String(req.params.id));
    // B-7103: a token from the OAuth flow is revoked at the authorization server before it is forgotten.
    const out = await s.mcp.disconnect(p.userId, srv);
    if (!out.removed) throw notFound('Token');
    await audit(req, 'mcp.token.removed', { mcpServer: srv.id, name: srv.name }, { revoked: out.revoked });
    res.status(204).end();
  });

  return r;
}
