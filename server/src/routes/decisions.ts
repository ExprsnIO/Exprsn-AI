import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { LABELS, type Label } from '../authz/labels.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { definitionFrom, tableName } from '../decisions/service.js';
import { checkDefinition } from '../decisions/table.js';
import type { Services } from '../services.js';

const version = z.union([z.number().int().min(1), z.literal('draft'), z.literal('published')]);
const inputs = z.record(z.string().max(63), z.unknown()).refine((v) => Object.keys(v).length <= 30, 'At most 30 inputs').default({});

/**
 * Decision tables (Sprint 46, B-131). Reading tables, checking a definition and evaluating (the test panel) need
 * `agents:run`, as reading and running workflows do; creating, saving drafts, publishing, deleting, exporting and
 * importing need `workflows:manage`, as designing workflows does. Every table is filtered by clearance (a table above
 * it is a 404). Every change is audited as `decision.*`.
 */
export function decisionRoutes(s: Services): Router {
  const r = Router();
  r.use('/decision-tables', noStore, requireAuth());
  const read = requirePermission(s, 'agents:run');
  const manage = requirePermission(s, 'workflows:manage');
  const d = s.decisions;

  const audit = (req: Request, action: string, target: Record<string, unknown>, label?: Label, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, ...(label ? { label } : {}), ...(detail ? { detail } : {}), traceId: req.traceId });
  };
  const id = (req: Request) => String(req.params.id);

  r.get('/decision-tables', read, async (req, res) => {
    res.json(await d.list(principalOf(req)));
  });

  r.post('/decision-tables', manage, async (req, res) => {
    const body = parseBody(z.object({ name: tableName, title: z.string().trim().max(200).nullable().default(null), description: z.string().trim().max(500).nullable().default(null), label: z.enum(LABELS).default('internal'), definition: z.unknown().optional() }).strict(), req.body);
    const p = principalOf(req);
    const t = await d.create(p, { name: body.name, title: body.title, description: body.description, label: body.label, ...(body.definition !== undefined ? { definition: definitionFrom(body.definition) } : {}) });
    await audit(req, 'decision.created', { decisionTable: t.id, name: t.name }, t.label);
    res.status(201).json(await d.view(p, t.id));
  });

  /** An export (`exprsn-decision/1`) as a new table whose draft is the exported definition; never published. */
  r.post('/decision-tables/import', manage, async (req, res) => {
    const body = parseBody(z.object({ export: z.unknown(), name: tableName.optional() }).strict(), req.body);
    const p = principalOf(req);
    const t = await d.import(p, body.export, { ...(body.name ? { name: body.name } : {}) });
    await audit(req, 'decision.imported', { decisionTable: t.id, name: t.name }, t.label);
    res.status(201).json(await d.view(p, t.id));
  });

  r.get('/decision-tables/:id', read, async (req, res) => {
    res.json(await d.view(principalOf(req), id(req)));
  });

  /** Saves the draft; `rev` is the revision the editor loaded (409 if someone saved since). Cells may be text. */
  r.put('/decision-tables/:id/draft', manage, async (req, res) => {
    const body = parseBody(z.object({ definition: z.unknown().optional(), rev: z.number().int().min(1).optional(), title: z.string().trim().max(200).nullable().optional(), description: z.string().trim().max(500).nullable().optional(), label: z.enum(LABELS).optional() }).strict(), req.body);
    const definition = body.definition !== undefined ? definitionFrom(body.definition) : undefined;
    const v = await d.saveDraft(principalOf(req), id(req), { ...(definition ? { definition } : {}), ...(body.rev ? { rev: body.rev } : {}), ...(body.title !== undefined ? { title: body.title } : {}), ...(body.description !== undefined ? { description: body.description } : {}), ...(body.label ? { label: body.label } : {}) });
    await audit(req, 'decision.draft.saved', { decisionTable: v.id, name: v.name }, v.label, { rev: v.draftRev, rules: v.draft.rules.length, hitPolicy: v.draft.hitPolicy, ...(body.label ? { label: body.label } : {}) });
    res.json(v);
  });

  /** Checks a definition (the draft when none is given) without saving it: what publishing would say. */
  r.post('/decision-tables/:id/check', read, async (req, res) => {
    const body = parseBody(z.object({ definition: z.unknown().optional() }).strict(), req.body);
    const v = await d.view(principalOf(req), id(req));
    const def = body.definition !== undefined ? definitionFrom(body.definition) : v.draft;
    res.json({ ...checkDefinition(def), definition: def });
  });

  r.post('/decision-tables/:id/publish', manage, async (req, res) => {
    const body = parseBody(z.object({ note: z.string().trim().max(500).nullable().default(null) }).strict(), req.body);
    const p = principalOf(req);
    const t = await d.table(p, id(req));
    try {
      const out = await d.publish(p, t.id, body.note);
      await audit(req, 'decision.published', { decisionTable: t.id, name: t.name }, t.label, { version: out.version, warnings: out.check.warnings.length });
      res.json({ version: out.version, warnings: out.check.warnings, table: await d.view(p, t.id) });
    } catch (err) {
      await audit(req, 'decision.publish.refused', { decisionTable: t.id, name: t.name }, t.label, { detail: (err as Error).message.slice(0, 300) });
      throw err;
    }
  });

  r.get('/decision-tables/:id/versions/:version', read, async (req, res) => {
    const v = parseBody(z.object({ version: z.coerce.number().int().min(1) }), { version: req.params.version });
    res.json(await d.version(principalOf(req), id(req), v.version));
  });

  /** The test panel: evaluates sample inputs against the draft, a version or the latest published one. */
  r.post('/decision-tables/:id/test', read, async (req, res) => {
    const body = parseBody(z.object({ version: version.default('draft'), inputs }).strict(), req.body);
    const out = await d.evaluateAs(principalOf(req), id(req), body.version, body.inputs);
    await audit(req, 'decision.tested', { decisionTable: out.table.id, name: out.table.name }, out.table.label, { version: out.version ?? 'draft', matched: out.result.matched.map((m) => m.rule).slice(0, 50) });
    res.json({ version: out.version, ...out.result });
  });

  r.get('/decision-tables/:id/used-by', read, async (req, res) => {
    const t = await d.table(principalOf(req), id(req));
    const usedBy = await d.usedBy(t);
    res.json({ id: t.id, name: t.name, usedBy, deleteBlocked: usedBy.length > 0 });
  });

  /** The published version (or the draft, with `?version=draft`, or a version number) as `exprsn-decision/1` JSON. */
  r.get('/decision-tables/:id/export', manage, async (req, res) => {
    const q = parseBody(z.object({ version: z.union([z.coerce.number().int().min(1), z.literal('draft')]).optional() }), req.query);
    const p = principalOf(req);
    const t = await d.table(p, id(req));
    const which = q.version ?? (t.published_version ? 'published' : 'draft');
    const def = await d.definitionOf(t, which);
    const doc = d.exportOf(t, def.version, def.definition);
    await audit(req, 'decision.exported', { decisionTable: t.id, name: t.name }, t.label, { version: def.version ?? 'draft', rules: def.definition.rules.length });
    res.setHeader('Content-Disposition', `attachment; filename="${t.name}.decision.json"`);
    res.json(doc);
  });

  r.delete('/decision-tables/:id', manage, async (req, res) => {
    const t = await d.remove(principalOf(req), id(req));
    await audit(req, 'decision.deleted', { decisionTable: t.id, name: t.name }, t.label);
    res.status(204).end();
  });

  return r;
}
