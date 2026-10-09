import { Router, type Request } from 'express';
import { z } from 'zod';
import { clears, LABELS } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { ip, noStore, parseBody, principalOf, requireAnyPermission, requireAuth, requirePermission } from '../http/middleware.js';
import { badRequest, forbidden, notFound } from '../http/problem.js';
import { draft, draftSchema } from '../apps/drafts.js';
import { fillView } from '../apps/ai-fills.js';
import { modelApplySchema, modelDraftSchema } from '../apps/model-drafts.js';
import { sourceInputSchema } from '../apps/sources.js';
import { formDefinitionSchema, formView } from '../apps/forms.js';
import { aggregateSchema, filterSchema, sortSchema, type Filter, type Sort } from '../apps/query.js';
import { entityDefinitionSchema, nameSchema } from '../apps/schema.js';
import { PACKAGE_FORMAT, packageView } from '../apps/packages.js';
import { appScopeGuard } from '../apps/key-scope.js';
import { AppPolicies, policyInputSchema, policyView } from '../apps/policies.js';
import { appView, entityView, type Actor } from '../apps/service.js';
import type { Services } from '../services.js';

const id26 = z.string().length(26);
const ref = z.string().min(1).max(63);
const label = z.enum(LABELS);
const values = z.record(z.string().max(63), z.unknown()).refine((v) => Object.keys(v).length <= 200, 'at most 200 fields');

const queryBody = z
  .object({
    filter: filterSchema.optional(),
    sort: sortSchema.optional(),
    q: z.string().trim().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().min(0).max(100_000).default(0),
    cursor: z.string().min(1).max(16_000).optional()
  })
  .strict();

/** `sort=name:asc,createdAt:desc` from a query string. */
function sortParam(raw: unknown): Sort | undefined {
  if (raw == null || raw === '') return undefined;
  if (typeof raw !== 'string') throw badRequest('sort is field:asc or field:desc, comma-separated.');
  return parseBody(
    sortSchema,
    raw.split(',').map((x) => {
      const [field, dir] = x.split(':');
      return { field: field?.trim() ?? '', dir: dir?.trim() || 'asc' };
    })
  );
}

function filterParam(raw: unknown): Filter | undefined {
  if (raw == null || raw === '') return undefined;
  if (typeof raw !== 'string') throw badRequest('filter is a JSON object.');
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw badRequest('filter is not valid JSON.');
  }
  return parseBody(filterSchema, v);
}

/**
 * Low-code data apps (Sprint 27, B-2201 to B-2208). Reading apps and records needs `records:read`, writing records
 * `records:write`, and designing apps, entities, forms and triggers (and bundles and drafts) `apps:design`. Everything
 * acts inside the caller's workspaces and clearance; record changes are audited by the service, design changes too.
 */
export function appRoutes(s: Services): Router {
  const r = Router();
  // 1.6.0 (B-8601, B-8702): a credential limited to one app or entity is refused beyond it, here as on the entity API.
  r.use('/apps', noStore, requireAuth(), appScopeGuard(s));
  const read = requirePermission(s, 'records:read');
  const write = requirePermission(s, 'records:write');
  const design = requirePermission(s, 'apps:design');
  const a = s.apps;

  const actor = (req: Request): Actor & { principal: Principal } => ({ principal: principalOf(req), source: 'api', ip: ip(req), traceId: req.traceId });
  const param = (req: Request, k: string) => parseBody(ref, req.params[k]);

  // ---------- held submissions (1.6.0, B-4701) ----------
  // Before `/apps/:app`: public submissions the user-input guardrail held, for reviewers of the flag and moderation queues.

  const reviewHeld = requireAnyPermission(s, ['flags:review', 'moderation:review']);

  r.get('/apps/held', reviewHeld, async (req, res) => {
    const q = parseBody(z.object({ state: z.enum(['held', 'accepted', 'rejected', 'all']).default('held') }).strict(), req.query);
    res.json({ items: await a.forms.held.list(principalOf(req), q.state) });
  });

  r.get('/apps/held/:id', reviewHeld, async (req, res) => {
    res.json(await a.forms.held.detail(principalOf(req), parseBody(id26, req.params.id)));
  });

  r.post('/apps/held/:id/decide', reviewHeld, async (req, res) => {
    const body = parseBody(z.object({ decision: z.enum(['accept', 'reject']), reason: z.string().trim().max(500).nullable().optional() }).strict(), req.body);
    res.json(await a.forms.held.decide(principalOf(req), parseBody(id26, req.params.id), body.decision, body.reason || null, { ip: ip(req), traceId: req.traceId ?? null }));
  });

  // ---------- packages, pipelines and deployments (1.6.0, B-8201 to B-8204) ----------
  // Before `/apps/:app`: the routes that name no app, or name one under a fixed first segment.

  const gitBody = z.object({ url: z.string().url().max(500), ref: z.string().trim().min(1).max(120).nullable().default(null), path: z.string().trim().min(1).max(200), credential: z.string().trim().max(300).nullable().default(null), username: z.string().trim().min(1).max(100).default('x-access-token') });

  r.post('/apps/packages/import', design, async (req, res) => {
    const body = parseBody(z.object({ package: z.unknown(), name: nameSchema.optional(), workspaceId: id26.nullable().optional() }).strict(), req.body);
    const pkg = await a.packages.verify(actor(req), body.package);
    const out = await a.packages.importNew(actor(req), pkg, { ...(body.name ? { name: body.name } : {}), ...(body.workspaceId !== undefined ? { workspaceId: body.workspaceId } : {}) });
    res.status(201).json({ ...appView(out.app), report: out.report, package: packageView(out.row) });
  });

  r.post('/apps/packages/git-import', design, async (req, res) => {
    const body = parseBody(gitBody.extend({ name: nameSchema.optional(), workspaceId: id26.nullable().optional() }).strict(), req.body);
    const { raw, commit } = await a.packages.gitRead(actor(req), { url: body.url, ref: body.ref, path: body.path, credential: body.credential, username: body.username });
    const pkg = await a.packages.verify(actor(req), raw);
    const out = await a.packages.importNew(actor(req), pkg, { ...(body.name ? { name: body.name } : {}), ...(body.workspaceId !== undefined ? { workspaceId: body.workspaceId } : {}), source: 'git' });
    res.status(201).json({ ...appView(out.app), report: out.report, package: packageView(out.row), commit });
  });

  const pipelineInput = z.object({ name: z.string().trim().min(1).max(100), development: ref, test: ref, production: ref, approvalWorkflow: z.string().trim().min(1).max(120).nullable().optional() }).strict();

  r.get('/apps/pipelines', design, async (req, res) => {
    const p = principalOf(req);
    const rows = await a.pipelines.list(p);
    res.json({ pipelines: await Promise.all(rows.map((row) => a.pipelines.view(p, row))) });
  });

  r.post('/apps/pipelines', design, async (req, res) => {
    const body = parseBody(pipelineInput, req.body);
    const row = await a.pipelines.create(actor(req), body);
    res.status(201).json(await a.pipelines.view(principalOf(req), row));
  });

  r.get('/apps/pipelines/:id', design, async (req, res) => {
    const p = principalOf(req);
    res.json(await a.pipelines.view(p, await a.pipelines.get(p, parseBody(id26, req.params.id))));
  });

  r.patch('/apps/pipelines/:id', design, async (req, res) => {
    const body = parseBody(pipelineInput.partial(), req.body);
    const row = await a.pipelines.update(actor(req), parseBody(id26, req.params.id), body);
    res.json(await a.pipelines.view(principalOf(req), row));
  });

  r.delete('/apps/pipelines/:id', design, async (req, res) => {
    await a.pipelines.remove(actor(req), parseBody(id26, req.params.id));
    res.status(204).end();
  });

  r.get('/apps/pipelines/:id/deployments', design, async (req, res) => {
    const q = parseBody(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).strict(), req.query);
    res.json({ deployments: await a.pipelines.history(principalOf(req), parseBody(id26, req.params.id), q.limit) });
  });

  r.post('/apps/pipelines/:id/promote', design, async (req, res) => {
    const body = parseBody(z.object({ to: z.enum(['test', 'production']), note: z.string().trim().max(500).nullable().optional() }).strict(), req.body);
    res.status(202).json(await a.pipelines.promote(actor(req), parseBody(id26, req.params.id), { to: body.to, note: body.note ?? null }));
  });

  r.get('/apps/deployments/:id', design, async (req, res) => {
    res.json(await a.pipelines.deploymentFor(principalOf(req), parseBody(id26, req.params.id)));
  });

  r.post('/apps/deployments/:id/rollback', design, async (req, res) => {
    const body = parseBody(z.object({ note: z.string().trim().max(500).nullable().optional() }).strict(), req.body ?? {});
    res.status(202).json(await a.pipelines.rollback(actor(req), parseBody(id26, req.params.id), body.note ?? null));
  });

  // ---------- apps ----------

  r.get('/apps', read, async (req, res) => {
    res.json({ apps: (await a.list(principalOf(req))).map(appView) });
  });

  r.post('/apps', design, async (req, res) => {
    const body = parseBody(z.object({ name: nameSchema, title: z.string().trim().min(1).max(200).optional(), description: z.string().max(5000).nullable().optional(), label: label.default('internal'), workspaceId: id26.nullable().optional() }).strict(), req.body);
    res.status(201).json(appView(await a.create(actor(req), body)));
  });

  r.post('/apps/import', design, async (req, res) => {
    const body = parseBody(z.object({ bundle: z.unknown(), name: nameSchema.optional(), workspaceId: id26.nullable().optional() }).strict(), req.body);
    if (body.bundle && typeof body.bundle === 'object' && (body.bundle as { format?: unknown }).format === PACKAGE_FORMAT) {
      // 1.6.0 (B-8201): a package (the bundle's successor) imports through the same door.
      const pkg = await a.packages.verify(actor(req), body.bundle);
      const out = await a.packages.importNew(actor(req), pkg, { ...(body.name ? { name: body.name } : {}), ...(body.workspaceId !== undefined ? { workspaceId: body.workspaceId } : {}) });
      res.status(201).json({ ...appView(out.app), report: out.report, package: packageView(out.row) });
      return;
    }
    const app = await a.bundles.import(actor(req), body.bundle, { ...(body.name ? { name: body.name } : {}), ...(body.workspaceId !== undefined ? { workspaceId: body.workspaceId } : {}) });
    res.status(201).json(appView(app));
  });

  r.post('/apps/drafts', design, async (req, res) => {
    const body = parseBody(draftSchema.extend({ label: label.default('internal') }), req.body);
    const p = principalOf(req);
    if (!clears(p.clearance, body.label)) throw badRequest(`Your clearance is ${p.clearance}; a ${body.label} draft is above it.`);
    res.json(await draft(s, actor(req), { kind: body.kind, prompt: body.prompt, profile: body.profile }, body.label));
  });

  r.get('/apps/transfers/:id', read, async (req, res) => {
    res.json(await a.transfer(principalOf(req), parseBody(id26, req.params.id)));
  });

  r.get('/apps/transfers/:id/download', read, async (req, res) => {
    const out = await a.download(actor(req), parseBody(id26, req.params.id));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${out.name.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(out.body);
  });

  r.get('/apps/:app', read, async (req, res) => {
    const p = principalOf(req);
    const app = await a.app(p, param(req, 'app'));
    const entities = await a.entities(app);
    const forms = await a.forms.list(app);
    const designer = effectivePermissions(p).has('apps:design');
    const sources = designer ? await Promise.all((await a.sources.list(app)).map((x) => a.sources.view(x, entities.find((e) => e.id === x.entity_id)?.name ?? ''))) : [];
    res.json({ ...appView(app), entities: entities.map(entityView), forms: forms.map((f) => formView(f.form, f.entity)), ...(designer ? { triggers: await a.triggers.list(app), sources } : {}) });
  });

  r.patch('/apps/:app', design, async (req, res) => {
    const body = parseBody(z.object({ title: z.string().trim().min(1).max(200).optional(), description: z.string().max(5000).nullable().optional(), label: label.optional() }).strict(), req.body);
    res.json(appView(await a.update(actor(req), param(req, 'app'), body)));
  });

  r.delete('/apps/:app', design, async (req, res) => {
    await a.remove(actor(req), param(req, 'app'));
    res.status(204).end();
  });

  r.get('/apps/:app/packages', design, async (req, res) => {
    const app = await a.app(principalOf(req), param(req, 'app'));
    const stage = await a.pipelines.stageOf(app.tenant_id, app.id);
    res.json({ packages: (await a.packages.list(app)).map(packageView), stage });
  });

  r.post('/apps/:app/packages', design, async (req, res) => {
    const body = parseBody(z.object({ withData: z.boolean().default(false), note: z.string().trim().max(500).nullable().optional() }).strict(), req.body ?? {});
    const app = await a.designable(principalOf(req), param(req, 'app'));
    const { row, pkg } = await a.packages.create(actor(req), app, { withData: body.withData, note: body.note ?? null });
    res.status(201).json({ ...packageView(row), package: pkg });
  });

  r.get('/apps/:app/packages/:id', design, async (req, res) => {
    const app = await a.app(principalOf(req), param(req, 'app'));
    const { row, pkg } = await a.packages.open(app.tenant_id, parseBody(id26, req.params.id));
    if (row.app_id !== app.id) throw notFound('Package');
    res.json({ ...packageView(row), package: pkg });
  });

  r.post('/apps/:app/packages/:id/git', design, async (req, res) => {
    const body = parseBody(gitBody.extend({ message: z.string().trim().max(500).nullable().default(null) }).strict(), req.body);
    const app = await a.designable(principalOf(req), param(req, 'app'));
    const { row, pkg } = await a.packages.open(app.tenant_id, parseBody(id26, req.params.id));
    if (row.app_id !== app.id) throw notFound('Package');
    res.json(await a.packages.gitPush(actor(req), app, pkg, { url: body.url, ref: body.ref, path: body.path, message: body.message, credential: body.credential, username: body.username }));
  });

  r.get('/apps/:app/export', design, async (req, res) => {
    const bundle = await a.bundles.export(actor(req), param(req, 'app'));
    res.setHeader('Content-Disposition', `attachment; filename="${bundle.app.name}.app.json"`);
    res.json(bundle);
  });

  // ---------- data model drafts (1.6.0, B-8301) ----------
  // A description becomes a draft of the app's whole data model, shown as a diff; accepting it applies the diff.

  r.post('/apps/:app/model/draft', design, async (req, res) => {
    const body = parseBody(modelDraftSchema.extend({ label: label.default('internal') }), req.body);
    const p = principalOf(req);
    if (!clears(p.clearance, body.label)) throw badRequest(`Your clearance is ${p.clearance}; a ${body.label} draft is above it.`);
    const app = await a.designable(p, param(req, 'app'));
    res.json(await a.modelDrafts.draft(actor(req), app, { prompt: body.prompt, profile: body.profile }, body.label));
  });

  r.post('/apps/:app/model/apply', design, async (req, res) => {
    const app = await a.designable(principalOf(req), param(req, 'app'));
    res.json(await a.modelDrafts.apply(actor(req), app, parseBody(modelApplySchema, req.body)));
  });

  // ---------- entities ----------

  const entityBody = z.object({ name: nameSchema, title: z.string().trim().min(1).max(200).optional(), label: label.optional(), definition: entityDefinitionSchema }).strict();

  r.post('/apps/:app/entities', design, async (req, res) => {
    const out = await a.createEntity(actor(req), param(req, 'app'), parseBody(entityBody, req.body));
    res.status(201).json(entityView(out.entity));
  });

  r.get('/apps/:app/entities/:entity', read, async (req, res) => {
    const { entity } = await a.resolve(principalOf(req), param(req, 'app'), param(req, 'entity'));
    res.json(entityView(entity));
  });

  r.patch('/apps/:app/entities/:entity', design, async (req, res) => {
    const body = parseBody(z.object({ title: z.string().trim().min(1).max(200).optional(), label: label.optional(), definition: entityDefinitionSchema.optional(), rev: z.number().int().min(1).optional() }).strict(), req.body);
    const out = await a.updateEntity(actor(req), param(req, 'app'), param(req, 'entity'), body);
    res.json({ ...entityView(out.entity), reindexJob: out.reindex });
  });

  r.delete('/apps/:app/entities/:entity', design, async (req, res) => {
    await a.removeEntity(actor(req), param(req, 'app'), param(req, 'entity'));
    res.status(204).end();
  });

  r.get('/apps/:app/entities/:entity/fields/:field/options', read, async (req, res) => {
    const q = parseBody(z.object({ q: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }), req.query);
    res.json({ options: await a.options(principalOf(req), param(req, 'app'), param(req, 'entity'), param(req, 'field'), q.q ?? null, q.limit) });
  });

  // ---------- AI fills over every row (1.6.0, B-8402) ----------

  const fillBody = z.object({ field: nameSchema, scope: z.enum(['empty', 'all']).default('empty') }).strict();

  r.post('/apps/:app/entities/:entity/ai/estimate', design, async (req, res) => {
    const body = parseBody(fillBody, req.body);
    const { app, entity } = await a.resolve(principalOf(req), param(req, 'app'), param(req, 'entity'));
    res.json(await a.aiFills.estimate(principalOf(req), app, entity, body.field, body.scope));
  });

  r.get('/apps/:app/entities/:entity/ai/fills', design, async (req, res) => {
    const { entity } = await a.resolve(principalOf(req), param(req, 'app'), param(req, 'entity'));
    res.json({ fills: (await a.aiFills.list(entity)).map(fillView) });
  });

  r.post('/apps/:app/entities/:entity/ai/fills', design, async (req, res) => {
    const body = parseBody(fillBody, req.body);
    const { app, entity } = await a.resolve(principalOf(req), param(req, 'app'), param(req, 'entity'));
    res.status(202).json(fillView(await a.aiFills.start(actor(req), app, entity, body.field, body.scope)));
  });

  r.get('/apps/:app/entities/:entity/ai/fills/:id', design, async (req, res) => {
    const { entity } = await a.resolve(principalOf(req), param(req, 'app'), param(req, 'entity'));
    res.json(fillView(await a.aiFills.get(entity, parseBody(id26, req.params.id))));
  });

  r.post('/apps/:app/entities/:entity/ai/fills/:id/cancel', design, async (req, res) => {
    const { app, entity } = await a.resolve(principalOf(req), param(req, 'app'), param(req, 'entity'));
    res.json(fillView(await a.aiFills.cancel(actor(req), app, entity, parseBody(id26, req.params.id))));
  });

  // ---------- outside tables (1.6.0, B-8501) ----------
  // Attaching a table reads it unmasked through its connection, so the designer must also manage connections.

  const attach = (req: Request) => {
    if (!effectivePermissions(principalOf(req)).has('connections:manage')) throw forbidden('Attaching an outside table needs connections:manage as well as apps:design.', { step: 'permission' });
  };

  r.get('/apps/:app/entities/:entity/source', design, async (req, res) => {
    const { entity } = await a.resolve(principalOf(req), param(req, 'app'), param(req, 'entity'));
    const src = await a.sources.of(entity);
    if (!src) throw notFound('Source');
    res.json(await a.sources.view(src, entity.name));
  });

  r.put('/apps/:app/entities/:entity/source', design, async (req, res) => {
    attach(req);
    const body = parseBody(sourceInputSchema, req.body);
    const { app, entity } = await a.resolve(principalOf(req), param(req, 'app'), param(req, 'entity'));
    res.json(await a.sources.view(await a.sources.set(actor(req), app, entity, body), entity.name));
  });

  r.delete('/apps/:app/entities/:entity/source', design, async (req, res) => {
    attach(req);
    const { app, entity } = await a.resolve(principalOf(req), param(req, 'app'), param(req, 'entity'));
    await a.sources.remove(actor(req), app, entity);
    res.status(204).end();
  });

  r.post('/apps/:app/entities/:entity/source/pull', design, async (req, res) => {
    const { app, entity } = await a.resolve(principalOf(req), param(req, 'app'), param(req, 'entity'));
    res.status(202).json(await a.sources.pullNow(actor(req), app, entity));
  });

  // ---------- records ----------

  const list = async (req: Request, input: { filter?: Filter; sort?: Sort; q?: string; limit: number; offset: number; cursor?: string | undefined }) => {
    const { cursor, ...rest } = input;
    const out = await a.query(principalOf(req), param(req, 'app'), param(req, 'entity'), { ...rest, ...(cursor ? { cursor } : {}) });
    return { total: out.total, limit: out.limit, offset: out.offset, nextCursor: out.nextCursor, records: out.records };
  };

  r.get('/apps/:app/entities/:entity/records', read, async (req, res) => {
    const q = parseBody(z.object({ filter: z.string().max(20_000).optional(), sort: z.string().max(300).optional(), q: z.string().trim().max(200).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).max(100_000).default(0), cursor: z.string().min(1).max(16_000).optional() }), req.query);
    const filter = filterParam(q.filter);
    const sort = sortParam(q.sort);
    res.json(await list(req, { ...(filter ? { filter } : {}), ...(sort ? { sort } : {}), ...(q.q ? { q: q.q } : {}), ...(q.cursor ? { cursor: q.cursor } : {}), limit: q.limit, offset: q.offset }));
  });

  r.post('/apps/:app/entities/:entity/records/query', read, async (req, res) => {
    res.json(await list(req, parseBody(queryBody, req.body)));
  });

  r.post('/apps/:app/entities/:entity/records/aggregate', read, async (req, res) => {
    res.json(await a.aggregate(principalOf(req), param(req, 'app'), param(req, 'entity'), parseBody(aggregateSchema, req.body)));
  });

  r.post('/apps/:app/entities/:entity/records', write, async (req, res) => {
    const body = parseBody(z.object({ values, label: label.optional() }).strict(), req.body);
    const { app, entity } = await a.resolve(principalOf(req), param(req, 'app'), param(req, 'entity'));
    res.status(201).json(await a.createRecord(actor(req), app, entity, body));
  });

  r.post('/apps/:app/entities/:entity/records/bulk', write, async (req, res) => {
    const body = parseBody(
      z
        .object({
          create: z.array(z.object({ values, label: label.optional() }).strict()).max(1000).optional(),
          update: z.array(z.object({ id: id26, values, version: z.number().int().min(1).optional() }).strict()).max(1000).optional(),
          delete: z.array(id26).max(1000).optional()
        })
        .strict(),
      req.body
    );
    const { app, entity } = await a.resolve(principalOf(req), param(req, 'app'), param(req, 'entity'));
    res.json(await a.bulk(actor(req), app, entity, body));
  });

  r.post('/apps/:app/entities/:entity/records/import', write, async (req, res) => {
    const body = parseBody(z.object({ csv: z.string().min(1).max(1024 * 1024), dryRun: z.boolean().default(false) }).strict(), req.body);
    const { app, entity } = await a.resolve(principalOf(req), param(req, 'app'), param(req, 'entity'));
    res.status(202).json(await a.submitImport(actor(req), app, entity, body.csv, body.dryRun));
  });

  r.post('/apps/:app/entities/:entity/records/export', read, async (req, res) => {
    const body = parseBody(z.object({ filter: filterSchema.optional(), q: z.string().trim().min(1).max(200).optional(), sort: sortSchema.optional() }).strict(), req.body ?? {});
    const { app, entity } = await a.resolve(principalOf(req), param(req, 'app'), param(req, 'entity'));
    res.status(202).json(await a.submitExport(actor(req), app, entity, body));
  });

  r.get('/apps/:app/entities/:entity/records/:id', read, async (req, res) => {
    res.json(await a.get(principalOf(req), param(req, 'app'), param(req, 'entity'), parseBody(id26, req.params.id)));
  });

  r.patch('/apps/:app/entities/:entity/records/:id', write, async (req, res) => {
    const body = parseBody(z.object({ values, version: z.number().int().min(1).optional() }).strict(), req.body);
    const { app, entity } = await a.resolve(principalOf(req), param(req, 'app'), param(req, 'entity'));
    res.json(await a.updateRecord(actor(req), app, entity, parseBody(id26, req.params.id), body));
  });

  r.delete('/apps/:app/entities/:entity/records/:id', write, async (req, res) => {
    const { app, entity } = await a.resolve(principalOf(req), param(req, 'app'), param(req, 'entity'));
    await a.removeRecord(actor(req), app, entity, parseBody(id26, req.params.id));
    res.status(204).end();
  });

  r.post('/apps/:app/entities/:entity/records/:id/transition', write, async (req, res) => {
    const body = parseBody(z.object({ to: z.string().min(1).max(60), version: z.number().int().min(1).optional(), note: z.string().max(300).nullable().optional() }).strict(), req.body);
    const { app, entity } = await a.resolve(principalOf(req), param(req, 'app'), param(req, 'entity'));
    res.json(await a.transition(actor(req), app, entity, parseBody(id26, req.params.id), body.to, { ...(body.version ? { version: body.version } : {}), note: body.note ?? null }));
  });

  // ---------- forms ----------

  r.get('/apps/:app/forms', read, async (req, res) => {
    const app = await a.app(principalOf(req), param(req, 'app'));
    res.json({ forms: (await a.forms.list(app)).map((f) => formView(f.form, f.entity)) });
  });

  r.post('/apps/:app/forms', design, async (req, res) => {
    const body = parseBody(z.object({ name: nameSchema, title: z.string().trim().min(1).max(200).optional(), entity: ref, definition: formDefinitionSchema, ratePerMinute: z.number().int().min(1).max(10_000).optional() }).strict(), req.body);
    const out = await a.forms.create(actor(req), param(req, 'app'), body);
    res.status(201).json(formView(out.form, out.entity));
  });

  r.get('/apps/:app/forms/:form', read, async (req, res) => {
    const { entity, form } = await a.forms.form(principalOf(req), param(req, 'app'), param(req, 'form'));
    res.json({ ...formView(form, entity), shown: a.forms.describe(entity, form) });
  });

  r.patch('/apps/:app/forms/:form', design, async (req, res) => {
    const body = parseBody(z.object({ title: z.string().trim().min(1).max(200).optional(), definition: formDefinitionSchema.optional(), ratePerMinute: z.number().int().min(1).max(10_000).optional() }).strict(), req.body);
    const out = await a.forms.update(actor(req), param(req, 'app'), param(req, 'form'), body);
    res.json(formView(out.form, out.entity));
  });

  r.delete('/apps/:app/forms/:form', design, async (req, res) => {
    await a.forms.remove(actor(req), param(req, 'app'), param(req, 'form'));
    res.status(204).end();
  });

  r.post('/apps/:app/forms/:form/public', design, async (req, res) => {
    const body = parseBody(z.object({ enabled: z.boolean() }).strict(), req.body);
    const out = await a.forms.setPublic(actor(req), param(req, 'app'), param(req, 'form'), body.enabled);
    res.json({ public: body.enabled, token: out.token });
  });

  r.post('/apps/:app/forms/:form/submit', write, async (req, res) => {
    const body = parseBody(z.object({ values }).strict(), req.body);
    const out = await a.forms.submitSignedIn(actor(req), param(req, 'app'), param(req, 'form'), body.values);
    res.status(201).json({ id: out.id, dropped: out.dropped });
  });

  // ---------- triggers ----------

  r.get('/apps/:app/triggers', design, async (req, res) => {
    const app = await a.app(principalOf(req), param(req, 'app'));
    res.json({ triggers: await a.triggers.list(app) });
  });

  r.post('/apps/:app/triggers', design, async (req, res) => {
    const body = parseBody(z.object({ entity: ref, kind: z.enum(['record', 'schedule']), events: z.array(z.enum(['created', 'updated', 'deleted', 'transitioned'])).max(4).optional(), cron: z.string().max(120).optional(), workflow: z.string().min(1).max(100), enabled: z.boolean().optional() }).strict(), req.body);
    res.status(201).json(await a.triggers.create(actor(req), param(req, 'app'), body));
  });

  r.patch('/apps/:app/triggers/:id', design, async (req, res) => {
    const body = parseBody(z.object({ enabled: z.boolean().optional(), events: z.array(z.enum(['created', 'updated', 'deleted', 'transitioned'])).max(4).optional(), cron: z.string().max(120).optional() }).strict(), req.body);
    res.json(await a.triggers.update(actor(req), param(req, 'app'), parseBody(id26, req.params.id), { ...(body.enabled !== undefined ? { enabled: body.enabled } : {}), ...(body.events ? { events: body.events } : {}), ...(body.cron ? { cron: body.cron } : {}) }));
  });

  r.delete('/apps/:app/triggers/:id', design, async (req, res) => {
    await a.triggers.remove(actor(req), param(req, 'app'), parseBody(id26, req.params.id));
    res.status(204).end();
  });

  // ---------- policies (1.6.0, B-8101 to B-8103) ----------
  // Row and field policies of an app, kept by its designers; explain shows what one reader gets and why.

  r.get('/apps/:app/policies', design, async (req, res) => {
    const app = await a.designable(principalOf(req), param(req, 'app'));
    res.json({ policies: (await a.policies.list(app)).map((x) => policyView(x.policy, x.entityName)), placeholders: [...AppPolicies.placeholders()] });
  });

  r.post('/apps/:app/policies', design, async (req, res) => {
    const app = await a.designable(principalOf(req), param(req, 'app'));
    const body = parseBody(policyInputSchema, req.body);
    const created = await a.policies.create(actor(req), app, body);
    res.status(201).json(policyView(created, body.entity));
  });

  r.put('/apps/:app/policies/:id', design, async (req, res) => {
    const app = await a.designable(principalOf(req), param(req, 'app'));
    const body = parseBody(policyInputSchema, req.body);
    res.json(policyView(await a.policies.update(actor(req), app, parseBody(id26, req.params.id), body), body.entity));
  });

  r.delete('/apps/:app/policies/:id', design, async (req, res) => {
    const app = await a.designable(principalOf(req), param(req, 'app'));
    await a.policies.remove(actor(req), app, parseBody(id26, req.params.id));
    res.status(204).end();
  });

  r.post('/apps/:app/entities/:entity/policies/explain', design, async (req, res) => {
    const { app, entity } = await a.resolve(principalOf(req), param(req, 'app'), param(req, 'entity'));
    const body = parseBody(z.object({ userId: id26.optional(), username: z.string().trim().min(1).max(100).optional(), recordId: id26.nullable().optional(), field: nameSchema.nullable().optional() }).strict().refine((b) => b.userId || b.username, 'userId or username'), req.body);
    const userId = body.userId ?? (await s.users.byUsername(principalOf(req).tenantId, body.username!))?.id;
    if (!userId) throw notFound('User');
    res.json(await a.policies.explain(app, entity, { userId, recordId: body.recordId ?? null, field: body.field ?? null }));
  });

  return r;
}
