import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../../audit/chain.js';
import { LABELS } from '../../authz/labels.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import { CAPABILITIES } from '../../plugins/capabilities.js';
import { ACTION_CAPABILITY } from '../../plugins/manifest.js';
import { manifestView, pluginView, type PluginActor } from '../../plugins/service.js';
import type { Services } from '../../services.js';

const ref = z.string().trim().min(2).max(63);
const grants = z.array(z.string().trim().min(1).max(60)).max(30);
const reason = z.string().trim().max(500).optional();

/**
 * Plugins (B-2002): the capability vocabulary, manifest checks, per-tenant installs and their lifecycle
 * (`plugins:manage`). A plugin is data; installing or enabling one loads no code.
 */
export function pluginAdminRoutes(s: Services): Router {
  const r = Router();
  r.use('/plugins', noStore, requireAuth(), requirePermission(s, 'plugins:manage'));

  const actor = (req: Request): PluginActor => {
    const p = principalOf(req);
    return { userId: p.userId, clearance: p.clearance, audit: actorFrom(p, ip(req)), traceId: req.traceId };
  };
  const pathId = (req: Request) => parseBody(ref, req.params.id);

  r.get('/plugins/capabilities', (_req, res) => {
    res.json({ capabilities: CAPABILITIES, actions: ACTION_CAPABILITY });
  });

  r.post('/plugins/validate', (req, res) => {
    const { manifest } = parseBody(z.object({ manifest: z.unknown() }).strict(), req.body);
    const m = s.plugins.check(manifest);
    res.json({ valid: true, manifest: manifestView(m) });
  });

  r.get('/plugins', async (req, res) => {
    const p = principalOf(req);
    const q = parseBody(z.object({ removed: z.enum(['true', 'false']).optional() }).strict(), req.query);
    res.json({ plugins: (await s.plugins.list(p.tenantId, p.clearance, { removed: q.removed === 'true' })).map(pluginView) });
  });

  r.post('/plugins', async (req, res) => {
    const p = principalOf(req);
    const b = parseBody(z.object({ manifest: z.unknown(), grants: grants.optional(), maxLabel: z.enum(LABELS).default('internal'), config: z.record(z.string(), z.unknown()).optional(), reason }).strict(), req.body);
    const row = await s.plugins.install(p.tenantId, actor(req), { manifest: b.manifest, maxLabel: b.maxLabel, ...(b.grants ? { grants: b.grants } : {}), ...(b.config ? { config: b.config } : {}), reason: b.reason ?? null });
    res.status(201).json(pluginView(row));
  });

  r.get('/plugins/:id', async (req, res) => {
    const p = principalOf(req);
    const row = await s.plugins.get(p.tenantId, pathId(req), p.clearance);
    res.json({ ...pluginView(row), manifest: manifestView(row.manifest), transitions: await s.plugins.transitions(p.tenantId, row.id) });
  });

  for (const event of ['enable', 'disable'] as const) {
    r.post(`/plugins/:id/${event}`, async (req, res) => {
      const p = principalOf(req);
      const b = parseBody(z.object({ reason }).strict(), req.body ?? {});
      res.json(pluginView(await s.plugins.transition(p.tenantId, actor(req), pathId(req), event, b.reason ?? null)));
    });
  }

  r.delete('/plugins/:id', async (req, res) => {
    const p = principalOf(req);
    const q = parseBody(z.object({ reason }).strict(), req.query);
    await s.plugins.transition(p.tenantId, actor(req), pathId(req), 'remove', q.reason ?? null);
    res.status(204).end();
  });

  r.put('/plugins/:id/grants', async (req, res) => {
    const p = principalOf(req);
    const b = parseBody(z.object({ grants, reason }).strict(), req.body);
    res.json(pluginView(await s.plugins.setGrants(p.tenantId, actor(req), pathId(req), b.grants, b.reason ?? null)));
  });

  r.get('/plugins/:id/transitions', async (req, res) => {
    const p = principalOf(req);
    const row = await s.plugins.get(p.tenantId, pathId(req), p.clearance);
    res.json({ transitions: await s.plugins.transitions(p.tenantId, row.id) });
  });

  return r;
}
