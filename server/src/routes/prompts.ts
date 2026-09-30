import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { LABELS, type Label } from '../authz/labels.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { PROMPT_STATES, templateView } from '../prompts/service.js';
import type { Services } from '../services.js';

const id26 = z.string().length(26);
const variable = z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,40}$/), description: z.string().trim().max(200).nullable().optional(), default: z.string().max(4000).nullable().optional() }).strict();
const body = z.string().min(1).max(50_000);

/**
 * The prompt library (Sprint 13). Reading and filling templates needs `chat:read`; writing them `prompts:manage`.
 * Every change is audited with the template's label.
 */
export function promptRoutes(s: Services): Router {
  const r = Router();
  r.use('/prompts', noStore, requireAuth());
  const read = requirePermission(s, 'chat:read');
  const manage = requirePermission(s, 'prompts:manage');
  const pr = s.prompts;

  const audit = (req: Request, action: string, target: Record<string, unknown>, label: Label, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, label, ...(detail ? { detail } : {}), traceId: req.traceId });
  };

  r.get('/prompts', read, async (req, res) => {
    const p = principalOf(req);
    const q = parseBody(z.object({ retired: z.enum(['true', 'false']).optional() }), req.query);
    const list = await pr.list(p, { includeRetired: q.retired === 'true' });
    const names = new Map((await s.tenants.workspaces(p.tenantId)).map((w) => [w.id, w.name]));
    res.json({ canManage: pr.canManage(p), templates: list.map((t) => ({ ...templateView(t), workspace: t.workspace_id ? (names.get(t.workspace_id) ?? null) : null })) });
  });

  r.get('/prompts/:id', read, async (req, res) => {
    const p = principalOf(req);
    const t = await pr.get(p, parseBody(id26, req.params.id));
    res.json({ ...templateView(t), versions: await pr.versions(p, t.id) });
  });

  r.post('/prompts', manage, async (req, res) => {
    const p = principalOf(req);
    const b = parseBody(z.object({ name: z.string().trim().min(1).max(100), description: z.string().trim().max(500).nullable().optional(), workspaceId: id26.nullable().default(null), label: z.enum(LABELS).default('internal'), body, variables: z.array(variable).max(50).optional(), notes: z.string().trim().max(500).nullable().optional() }).strict(), req.body);
    const t = await pr.create(p, b);
    await audit(req, 'prompt.created', { prompt: t.id, name: t.name }, t.label, { scope: t.workspace_id ? 'workspace' : 'tenant', workspace: t.workspace_id });
    res.status(201).json(templateView(t));
  });

  r.patch('/prompts/:id', manage, async (req, res) => {
    const p = principalOf(req);
    const b = parseBody(z.object({ name: z.string().trim().min(1).max(100).optional(), description: z.string().trim().max(500).nullable().optional(), label: z.enum(LABELS).optional() }).strict(), req.body);
    const { before, after } = await pr.update(p, parseBody(id26, req.params.id), b);
    await audit(req, 'prompt.updated', { prompt: after.id, name: after.name }, after.label, { before: { name: before.name, label: before.label }, after: { name: after.name, label: after.label } });
    res.json(templateView(after));
  });

  r.post('/prompts/:id/versions', manage, async (req, res) => {
    const p = principalOf(req);
    const b = parseBody(z.object({ body, variables: z.array(variable).max(50).optional(), notes: z.string().trim().max(500).nullable().optional() }).strict(), req.body);
    const t = await pr.addVersion(p, parseBody(id26, req.params.id), b);
    await audit(req, 'prompt.version.added', { prompt: t.id, name: t.name, version: t.version }, t.label);
    res.status(201).json(templateView(t));
  });

  r.post('/prompts/:id/state', manage, async (req, res) => {
    const p = principalOf(req);
    const b = parseBody(z.object({ state: z.enum(PROMPT_STATES), version: z.number().int().min(1).optional() }).strict(), req.body);
    const { before, after } = await pr.transition(p, parseBody(id26, req.params.id), b.state, b.version);
    await audit(req, `prompt.${b.state}`, { prompt: after.id, name: after.name }, after.label, { from: before.state, version: after.published_version });
    res.json(templateView(after));
  });

  r.post('/prompts/:id/render', read, async (req, res) => {
    const p = principalOf(req);
    const b = parseBody(z.object({ variables: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,40}$/), z.string().max(20_000)).default({}), version: z.number().int().min(1).optional() }).strict(), req.body ?? {});
    res.json(await pr.render(p, parseBody(id26, req.params.id), b.variables, b.version));
  });

  return r;
}
