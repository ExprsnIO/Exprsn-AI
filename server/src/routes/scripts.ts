import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { authorize } from '../authz/policy.js';
import { LABELS } from '../authz/labels.js';
import type { Permission } from '../authz/permissions.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { entryView, SIDE_EFFECTS } from '../registry/service.js';
import { DEFAULT_LIMITS, LANGUAGES, MAX_LIMITS } from '../scripts/runner.js';
import type { Services } from '../services.js';

const limits = z.object({
  timeoutSeconds: z.number().int().min(1).max(MAX_LIMITS.timeoutSeconds),
  memoryMb: z.number().int().min(32).max(MAX_LIMITS.memoryMb),
  cpus: z.number().min(0.1).max(MAX_LIMITS.cpus),
  pids: z.number().int().min(8).max(MAX_LIMITS.pids),
  outputKb: z.number().int().min(1).max(MAX_LIMITS.outputKb)
});
const source = z.string().min(1).max(200_000);

/** Scripts in the current workspace: versions, checks, sandboxed runs and promotion to a registry tool. */
export function scriptRoutes(s: Services): Router {
  const r = Router();
  r.use(['/scripts', '/script-runs'], noStore, requireAuth());
  const run = requirePermission(s, 'scripts:run');
  const anyOf = (...perms: Permission[]): RequestHandler => async (req, res, next) => {
    const p = principalOf(req);
    await requirePermission(s, perms.find((x) => authorize(p, x).allow) ?? perms[0]!)(req, res, next);
  };
  const scripts = s.scripts;
  const load = (req: Request) => scripts.get(principalOf(req), String(req.params.id));
  const audit = (req: Request, action: string, sc: { id: string; name: string }, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target: { script: sc.id, name: sc.name }, ...(detail ? { detail } : {}), traceId: req.traceId });
  };

  r.get('/scripts', run, async (req, res) => {
    const list = await scripts.list(principalOf(req));
    res.json(list.map((x) => ({ id: x.id, name: x.name, language: x.language, label: x.label, status: x.status, version: x.version, updatedAt: Number(x.updated_at) })));
  });

  /** Which sandbox runs scripts here, and whether it answers. */
  r.get('/scripts/runtime', run, async (_req, res) => {
    res.json({ runner: scripts.runner.name, available: await scripts.runner.available(), defaults: DEFAULT_LIMITS, max: MAX_LIMITS, languages: LANGUAGES });
  });

  r.post('/scripts', run, async (req, res) => {
    const b = parseBody(z.object({ name: z.string().trim().regex(/^[\w][\w.-]{0,119}$/, 'Letters, digits, . _ -'), language: z.enum(LANGUAGES), source, label: z.enum(LABELS).default('internal'), limits: limits.default(DEFAULT_LIMITS) }), req.body);
    const sc = await scripts.create(principalOf(req), b);
    await audit(req, 'script.created', sc, { language: sc.language, label: sc.label });
    res.status(201).json(await scripts.view(sc));
  });

  r.get('/scripts/:id', run, async (req, res) => {
    res.json(await scripts.view(await load(req)));
  });

  /** A new version: the old one stays. */
  r.patch('/scripts/:id', run, async (req, res) => {
    const sc = await load(req);
    const b = parseBody(z.object({ source: source.optional(), limits: limits.optional(), label: z.enum(LABELS).optional(), note: z.string().trim().max(300).nullable().optional() }).strict(), req.body);
    const next = await scripts.update(principalOf(req), sc, b);
    await audit(req, 'script.updated', sc, { version: next.version, changed: Object.keys(b) });
    res.json(await scripts.view(next));
  });

  r.get('/scripts/:id/versions', run, async (req, res) => {
    res.json(await scripts.versions(await load(req)));
  });

  r.get('/scripts/:id/versions/:v', run, async (req, res) => {
    const sc = await load(req);
    res.json(await scripts.version(sc, parseBody(z.coerce.number().int().min(1), req.params.v)));
  });

  r.post('/scripts/:id/restore', run, async (req, res) => {
    const sc = await load(req);
    const b = parseBody(z.object({ version: z.number().int().min(1) }), req.body);
    const next = await scripts.restore(principalOf(req), sc, b.version);
    await audit(req, 'script.restored', sc, { from: b.version, version: next.version });
    res.json(await scripts.view(next));
  });

  r.post('/scripts/:id/checks', run, async (req, res) => {
    const sc = await load(req);
    res.json(await scripts.recheck(principalOf(req), sc));
  });

  r.post('/scripts/:id/run', run, async (req, res) => {
    const sc = await load(req);
    const b = parseBody(z.object({ stdin: z.string().max(1_000_000).nullable().default(null) }), req.body);
    const out = await scripts.run(principalOf(req), sc, b.stdin);
    await audit(req, 'script.run.started', sc, { version: sc.version, run: out.runId, job: out.jobId });
    res.status(202).json(out);
  });

  r.get('/scripts/:id/runs', run, async (req, res) => {
    res.json(await scripts.runs(await load(req)));
  });

  r.get('/script-runs/:id', run, async (req, res) => {
    res.json(await scripts.runView(principalOf(req), String(req.params.id)));
  });

  /** Promotion: a tested script becomes a draft registry tool, submitted for a tool admin's review. */
  r.post('/scripts/:id/promote', run, anyOf('workflows:manage', 'tools:manage'), async (req, res) => {
    const sc = await load(req);
    const b = parseBody(
      z.object({
        toolName: z.string().trim().regex(/^[a-z0-9][a-z0-9_.:-]{0,119}$/i),
        version: z.string().trim().regex(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/).default('0.1.0'),
        description: z.string().trim().min(1).max(2000),
        sideEffect: z.enum(SIDE_EFFECTS).default('read'),
        label: z.enum(LABELS).optional(),
        inputSchema: z.record(z.string(), z.unknown()),
        outputSchema: z.record(z.string(), z.unknown()).nullable().default(null)
      }),
      req.body
    );
    const entry = await scripts.promote(principalOf(req), sc, { ...b, label: b.label ?? sc.label });
    await audit(req, 'script.promotion.submitted', sc, { tool: entry.name, version: entry.version, registryEntry: entry.id });
    res.status(201).json(entryView(entry));
  });

  return r;
}
