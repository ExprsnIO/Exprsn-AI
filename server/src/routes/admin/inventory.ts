import { Router } from 'express';
import { z } from 'zod';
import { actorFrom } from '../../audit/chain.js';
import { INVENTORY_KINDS } from '../../governance/inventory.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import type { Services } from '../../services.js';

const text = (max: number) => z.string().trim().max(max).nullable().optional();

/** 1.6.0, Sprint 38a (B-7301, B-7302): the AI system inventory, on the Models screen's Inventory tab (models:manage). */
export function inventoryAdminRoutes(s: Services): Router {
  const r = Router();
  r.use('/inventory', noStore, requireAuth(), requirePermission(s, 'models:manage'));

  r.get('/inventory', async (req, res) => {
    const p = principalOf(req);
    const items = await s.inventory.list(p.tenantId);
    res.json({ items, counts: { total: items.length, incomplete: items.filter((x) => !x.complete).length, withIssues: items.filter((x) => x.issues.flags + x.issues.failedEvals > 0).length } });
  });

  r.get('/inventory/settings', async (req, res) => {
    res.json(await s.inventory.settings(principalOf(req).tenantId));
  });

  r.put('/inventory/settings', async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ requireOwner: z.boolean() }).strict(), req.body);
    res.json(await s.inventory.setSettings(p, body, req.traceId));
  });

  r.patch('/inventory/:kind/:id', async (req, res) => {
    const p = principalOf(req);
    const { kind, id } = parseBody(z.object({ kind: z.enum(INVENTORY_KINDS), id: z.string().min(1).max(100) }), req.params);
    const body = parseBody(z.object({ ownerId: z.string().length(26).nullable().optional(), oversightRole: text(100), provenance: text(2000), lineageNote: text(2000), knownIssuesNote: text(4000), impactAssessment: text(8000) }).strict(), req.body);
    res.json(await s.inventory.set(p, kind, id, body, req.traceId));
  });

  /** The register (B-7302): CSV or JSON, every system with its lineage and impact assessment. Audited. */
  r.get('/inventory/register', async (req, res) => {
    const p = principalOf(req);
    const { format } = parseBody(z.object({ format: z.enum(['csv', 'json']).default('csv') }).passthrough(), req.query);
    const out = await s.inventory.register(p.tenantId, format);
    await s.audit.append({ tenantId: p.tenantId, action: 'inventory.exported', kind: 'admin', actor: actorFrom(p, ip(req)), target: { format }, detail: { rows: out.rows }, traceId: req.traceId });
    res.setHeader('Content-Type', out.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="ai-inventory-${p.tenantSlug}-${new Date().toISOString().slice(0, 10)}.${format}"`);
    res.send(out.body);
  });

  return r;
}
