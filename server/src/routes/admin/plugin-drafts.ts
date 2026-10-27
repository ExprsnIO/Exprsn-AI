import { Router, type Request } from 'express';
import { z } from 'zod';
import { LABELS } from '../../authz/labels.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import { checkWizard, vocabulary, wizardSchema } from '../../plugins/drafts.js';
import { pluginView } from '../../plugins/service.js';
import type { Services } from '../../services.js';

const id26 = z.string().regex(/^[0-9A-Za-z]{26}$/);

/**
 * 1.8.0, Sprint 48 (B-147): the plugin creator's drafts. Everything needs `plugins:manage`, the permission that
 * installs plugins (a draft is a manifest being written, and installing it is an install); a draft is its author's
 * only. Checking a wizard changes nothing. Installing goes through `PluginService.install` with no grants, so the
 * existing grant and enable flow and the signing policy decide what happens next. Audited as `plugin.draft.*`.
 */
export function pluginDraftRoutes(s: Services): Router {
  const r = Router();
  r.use('/plugin-drafts', noStore, requireAuth(), requirePermission(s, 'plugins:manage'));
  const ctx = (req: Request) => ({ ip: ip(req), traceId: req.traceId ?? null });
  const pathId = (req: Request) => parseBody(id26, req.params.id);

  r.get('/plugin-drafts/vocabulary', (_req, res) => {
    res.json({ ...vocabulary(), signing: { policy: s.cfg.PLUGINS_REQUIRE_SIGNED } });
  });

  // Builds and checks a manifest from the wizard's state; nothing is saved.
  r.post('/plugin-drafts/check', (req, res) => {
    const b = parseBody(z.object({ wizard: wizardSchema }).strict(), req.body);
    res.json(checkWizard(b.wizard));
  });

  r.get('/plugin-drafts', async (req, res) => {
    const p = principalOf(req);
    res.json({ drafts: (await s.pluginDrafts.list(p)).map((d) => s.pluginDrafts.view(d)) });
  });

  r.post('/plugin-drafts', async (req, res) => {
    const p = principalOf(req);
    const b = parseBody(z.object({ wizard: wizardSchema.default({}) }).strict(), req.body ?? {});
    res.status(201).json(s.pluginDrafts.view(await s.pluginDrafts.create(p, b.wizard, ctx(req))));
  });

  r.get('/plugin-drafts/:id', async (req, res) => {
    res.json(s.pluginDrafts.view(await s.pluginDrafts.get(principalOf(req), pathId(req))));
  });

  r.put('/plugin-drafts/:id', async (req, res) => {
    const b = parseBody(z.object({ wizard: wizardSchema.optional(), step: z.number().int().min(1).max(5).optional() }).strict(), req.body);
    res.json(s.pluginDrafts.view(await s.pluginDrafts.save(principalOf(req), pathId(req), b, ctx(req))));
  });

  r.delete('/plugin-drafts/:id', async (req, res) => {
    await s.pluginDrafts.remove(principalOf(req), pathId(req), ctx(req));
    res.status(204).end();
  });

  // The plugin file, or (the default) an unsigned import bundle carrying it, to sign offline and import.
  r.get('/plugin-drafts/:id/download', async (req, res) => {
    const q = parseBody(z.object({ format: z.enum(['bundle', 'manifest']).default('bundle') }).strict(), req.query);
    const out = await s.pluginDrafts.export(principalOf(req), pathId(req), q.format, ctx(req));
    res.setHeader('Content-Type', out.type);
    res.setHeader('Content-Disposition', `attachment; filename="${out.name.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    res.send(out.data);
  });

  // Installs the manifest as a plugin with nothing granted: grant and enable it under Plugins and events.
  r.post('/plugin-drafts/:id/install', async (req, res) => {
    const b = parseBody(z.object({ maxLabel: z.enum(LABELS).default('internal'), reason: z.string().trim().max(500).optional() }).strict(), req.body ?? {});
    const row = await s.pluginDrafts.install(principalOf(req), pathId(req), { maxLabel: b.maxLabel, reason: b.reason ?? null }, ctx(req));
    res.status(201).json(pluginView(row));
  });

  return r;
}
