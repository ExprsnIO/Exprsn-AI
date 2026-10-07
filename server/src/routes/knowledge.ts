import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom, isUniqueViolation } from '../audit/chain.js';
import { LABELS, type Label } from '../authz/labels.js';
import { effectivePermissions } from '../authz/policy.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission, workspacesFor } from '../http/middleware.js';
import { badRequest, conflict, forbidden } from '../http/problem.js';
import { docView, indexView, SCHEDULES, SOURCE_KINDS, sourceView, type LabelFilter } from '../knowledge/service.js';
import { replicationView } from '../knowledge/replication.js';
import { ROLE_NAME } from '../connections/drivers.js';
import { allowed as allowedObject } from '../connections/service.js';
import type { Services } from '../services.js';

const id26 = z.string().length(26);
const chunking = z.object({ tokens: z.number().int().min(100).max(4000), overlap: z.number().int().min(0).max(1000) }).strict();
const modelName = z.string().trim().min(1).max(200);
/** Sprint 36c (B-8803): label filters for image documents. */
const labelName = z.string().trim().min(1).max(100);
const labelFilter = z.object({ any: z.array(labelName).max(20).optional(), all: z.array(labelName).max(20).optional(), minScore: z.number().min(0).max(1).optional() }).strict();
const profileName = z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/, 'a profile name');

/**
 * Knowledge bases, sources, documents, index builds, access and test search. Reading needs `knowledge:read`;
 * changes need `knowledge:manage` or manage access granted on the base. Every change is audited.
 */
export function knowledgeRoutes(s: Services): Router {
  const r = Router();
  r.use(['/knowledge'], noStore, requireAuth());
  const read = requirePermission(s, 'knowledge:read');
  const k = s.knowledge;

  const audit = (req: Request, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>, label?: Label) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, ...(label ? { label } : {}), ...(detail ? { detail } : {}), traceId: req.traceId });
  };

  const detail = async (req: Request, id: string) => {
    const p = principalOf(req);
    const summary = (await k.summaries(p)).find((x) => x.id === id);
    const kb = await k.base(p, id);
    const sources = await k.sources(kb.id);
    const counts = new Map(((await s.db('knowledge_documents').where({ kb_id: kb.id }).whereNot({ state: 'removed' }).groupBy('source_id').select('source_id').count({ n: '*' })) as { source_id: string; n: number }[]).map((x) => [x.source_id, Number(x.n)]));
    const quarantined = Number(((await s.db('knowledge_documents').where({ kb_id: kb.id }).whereIn('state', ['quarantined', 'scanning']).count({ n: '*' })) as { n: number }[])[0]?.n ?? 0);
    return {
      ...summary!,
      quarantined,
      sources: await Promise.all(sources.map(async (x) => ({ ...sourceView(x, counts.get(x.id) ?? 0), replication: x.config.replication ? (replicationView(await k.replication.row(x.id)) ?? { state: 'starting' }) : null }))),
      indexes: (await k.indexes(kb.id)).slice(0, 10).map(indexView),
      vectorStore: s.vectors.kind
    };
  };

  // ---------- models and principals for the forms ----------

  r.get('/knowledge/models', read, async (_req, res) => {
    const models = (await s.gateway.repo.models()).filter((m) => m.state === 'approved' || m.state === 'deprecated');
    // Sprint 36c (B-8801, B-8802): the profiles that can describe images, and the vision classifiers a base may name.
    const p = principalOf(_req);
    const byId = new Map(models.map((m) => [m.id, m]));
    const profiles = (await s.gateway.repo.profiles(p.tenantId)).filter((x) => !x.alias_of && x.status === 'published' && x.model_id && byId.get(x.model_id)?.capabilities.includes('vision'));
    const classifiers = (await s.guard.classifiers.list(p.tenantId)).filter((c) => c.engine === 'vision');
    res.json({
      embedding: models.filter((m) => m.capabilities.includes('embedding')).map((m) => ({ name: m.name, label: m.label, state: m.state })),
      rerankers: models.filter((m) => m.capabilities.includes('completion') && !m.capabilities.includes('embedding')).map((m) => ({ name: m.name, label: m.label, state: m.state })),
      visionProfiles: profiles.map((x) => ({ name: x.name, displayName: x.display_name, model: byId.get(x.model_id!)!.name, label: x.label })),
      imageClassifiers: classifiers.map((c) => ({ id: c.id, slug: c.slug, name: c.name, status: c.status, version: c.version, labels: c.config.labels }))
    });
  });

  r.get('/knowledge/principals', read, async (req, res) => {
    const p = principalOf(req);
    if (!effectivePermissions(p).has('knowledge:manage')) throw forbidden('Sharing needs the knowledge curator role.', { step: 'role', action: 'knowledge:manage' });
    const [workspaces, users, profiles] = await Promise.all([
      s.tenants.workspaces(p.tenantId),
      s.db('users').where({ tenant_id: p.tenantId, state: 'active' }).orderBy('display_name').limit(1000).select('id', 'display_name', 'username'),
      s.gateway.repo.profiles(p.tenantId)
    ]);
    res.json({
      workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, labelCeiling: w.label_ceiling })),
      users: (users as { id: string; display_name: string; username: string }[]).map((u) => ({ id: u.id, name: u.display_name, username: u.username })),
      profiles: profiles.filter((x) => !x.alias_of).map((x) => ({ id: x.id, name: x.display_name, slug: x.name, label: x.label }))
    });
  });

  /** PostgreSQL and MySQL connections a curator may read a table or view through: names and allow-listed objects, never credentials. */
  r.get('/knowledge/connections', read, async (req, res) => {
    const p = principalOf(req);
    if (!effectivePermissions(p).has('knowledge:manage')) throw forbidden('Adding a source needs the knowledge curator role.', { step: 'role', action: 'knowledge:manage' });
    // MongoDB: allow-list entries may be patterns, so the objects listed are the introspected collections they allow.
    res.json((await s.connections.list(p.tenantId)).filter((c) => c.engine === 'postgres' || c.engine === 'mysql' || c.engine === 'mongodb').map((c) => {
      const objs = (c.schema ?? []).filter((o) => (c.engine === 'mongodb' ? allowedObject(c, o.name) : c.allow_list.includes(o.name)));
      return { id: c.id, name: c.name, engine: c.engine, label: c.label, objects: c.engine === 'mongodb' ? objs.map((o) => o.name) : c.allow_list, columns: Object.fromEntries(objs.map((o) => [o.name, o.columns.map((x) => x.name)])) };
    }));
  });

  // ---------- knowledge bases ----------

  r.get('/knowledge/bases', read, async (req, res) => {
    res.json(await k.summaries(principalOf(req)));
  });

  r.post('/knowledge/bases', read, async (req, res) => {
    const p = principalOf(req);
    if (!effectivePermissions(p).has('knowledge:manage')) throw forbidden('Creating a knowledge base needs the knowledge curator role.', { step: 'role', action: 'knowledge:manage' });
    const body = parseBody(
      z.object({ name: z.string().trim().min(1).max(200), description: z.string().trim().max(500).nullable().default(null), label: z.enum(LABELS).default('internal'), embedModel: modelName, reranker: modelName.nullable().default(null), sharing: z.enum(['members', 'curators']).default('members'), workspaceId: id26.nullable().optional(), chunking: chunking.optional() }).strict(),
      req.body
    );
    const workspaceId = body.workspaceId === undefined ? (p.workspaceId ?? null) : body.workspaceId;
    if (workspaceId && !(await workspacesFor(s, p)).some((w) => w.id === workspaceId)) throw forbidden('You cannot act in that workspace.', { step: 'tenant' });
    try {
      const kb = await k.create(p, { ...body, workspaceId });
      await audit(req, 'knowledge.created', { kb: kb.id, name: kb.name }, { embedModel: kb.embed_model, sharing: kb.sharing, workspace: kb.workspace_id }, kb.label);
      res.status(201).json(await detail(req, kb.id));
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('A knowledge base with that name exists.');
      throw err;
    }
  });

  r.get('/knowledge/bases/:id', read, async (req, res) => {
    res.json(await detail(req, String(req.params.id)));
  });

  r.patch('/knowledge/bases/:id', read, async (req, res) => {
    const body = parseBody(
      z.object({ name: z.string().trim().min(1).max(200).optional(), description: z.string().trim().max(500).nullable().optional(), label: z.enum(LABELS).optional(), reranker: modelName.nullable().optional(), sharing: z.enum(['members', 'curators']).optional(), status: z.enum(['draft', 'published']).optional(), chunking: chunking.optional(), visionProfile: profileName.nullable().optional(), imageClassifiers: z.array(z.string().trim().min(1).max(63)).max(10).optional() }).strict(),
      req.body
    );
    try {
      const kb = await k.update(principalOf(req), String(req.params.id), body);
      await audit(req, 'knowledge.updated', { kb: kb.id, name: kb.name }, { changed: Object.keys(body), ...(body.visionProfile !== undefined ? { visionProfile: kb.vision_profile } : {}), ...(body.imageClassifiers ? { imageClassifiers: kb.image_classifiers } : {}) }, kb.label);
      res.json(await detail(req, kb.id));
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('A knowledge base with that name exists.');
      throw err;
    }
  });

  r.delete('/knowledge/bases/:id', read, async (req, res) => {
    const kb = await k.base(principalOf(req), String(req.params.id), 'manage');
    const out = await k.remove(principalOf(req), kb.id);
    await audit(req, 'knowledge.deleted', { kb: kb.id, name: kb.name }, out, kb.label);
    res.status(204).end();
  });

  // ---------- index builds ----------

  r.post('/knowledge/bases/:id/reindex', read, async (req, res) => {
    const body = parseBody(z.object({ embedModel: modelName.optional() }).strict(), req.body);
    const idx = await k.reindex(principalOf(req), String(req.params.id), body);
    await audit(req, 'knowledge.reindex.started', { kb: idx.kb_id, index: idx.id }, { version: idx.version, embedModel: idx.embed_model });
    res.status(202).json(indexView(idx));
  });

  r.post('/knowledge/bases/:id/cancel-build', read, async (req, res) => {
    const idx = await k.cancelBuild(principalOf(req), String(req.params.id));
    await audit(req, 'knowledge.reindex.cancelled', { kb: idx.kb_id, index: idx.id }, { version: idx.version });
    res.json(indexView(idx));
  });

  // ---------- access ----------

  r.get('/knowledge/bases/:id/access', read, async (req, res) => {
    const kb = await k.base(principalOf(req), String(req.params.id));
    res.json(await k.accessList(kb));
  });

  r.post('/knowledge/bases/:id/access', read, async (req, res) => {
    const body = parseBody(z.object({ kind: z.enum(['workspace', 'user', 'profile']), id: id26, access: z.enum(['read', 'manage']).default('read') }).strict(), req.body);
    const kb = await k.grant(principalOf(req), String(req.params.id), body);
    await audit(req, 'knowledge.shared', { kb: kb.id, name: kb.name }, { principal: `${body.kind}:${body.id}`, access: body.access }, kb.label);
    res.status(201).json(await k.accessList(kb));
  });

  r.delete('/knowledge/bases/:id/access/:grant', read, async (req, res) => {
    const kb = await k.revoke(principalOf(req), String(req.params.id), String(req.params.grant));
    await audit(req, 'knowledge.unshared', { kb: kb.id, name: kb.name }, { grant: String(req.params.grant) }, kb.label);
    res.json(await k.accessList(kb));
  });

  // ---------- sources ----------

  r.post('/knowledge/bases/:id/sources', read, async (req, res) => {
    const body = parseBody(
      z
        .object({
          kind: z.enum(SOURCE_KINDS),
          location: z.string().trim().max(500).default(''),
          labelFloor: z.enum(LABELS).optional(),
          schedule: z.enum(SCHEDULES).optional(),
          ref: z.string().trim().regex(/^[A-Za-z0-9._/-]{1,200}$/).nullable().optional(),
          path: z.string().trim().max(300).regex(/^[^\0]*$/).optional(),
          connectionId: id26.optional(),
          idColumn: z.string().trim().max(63).nullable().optional(),
          watermarkColumn: z.string().trim().max(63).nullable().optional(),
          accessColumn: z.string().trim().min(1).max(63).nullable().optional(),
          accessKind: z.enum(['group', 'user']).optional(),
          replication: z.boolean().optional(),
          publication: z.string().trim().regex(/^[a-z_][a-z0-9_]{0,62}$/, 'a publication name: lower-case letters, digits and _').nullable().optional(),
          // Sprint 23: S3-compatible buckets (B-1501), internal web sites (B-1502), row security by role (B-1503).
          include: z.array(z.string().trim().min(1).max(200).regex(/^[^\0]*$/)).max(20).optional(),
          endpoint: z.string().trim().max(500).nullable().optional(),
          region: z.string().trim().regex(/^[a-z0-9-]{1,40}$/).optional(),
          pathStyle: z.boolean().optional(),
          accessKeyId: z.string().trim().min(1).max(200).optional(),
          secretAccessKey: z.string().min(1).max(500).optional(),
          maxDepth: z.number().int().min(0).max(5).optional(),
          maxPages: z.number().int().min(1).max(1000).optional(),
          pathPrefix: z.string().trim().max(300).regex(/^[^\0\s]*$/).optional(),
          sitemap: z.boolean().optional(),
          /** MongoDB collections: the text fields to index (dotted paths allowed). */
          fields: z.array(z.string().trim().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/, 'a field name or dotted path')).min(1).max(50).optional(),
          roleMappings: z.array(z.object({ group: z.string().trim().min(1).max(200), role: z.string().trim().regex(ROLE_NAME, 'a PostgreSQL role name') }).strict()).min(1).max(50).optional()
        })
        .strict(),
      req.body
    );
    if (body.kind !== 'upload' && !body.location) throw badRequest('Give the source a location.');
    const src = await k.addSource(principalOf(req), String(req.params.id), body);
    await audit(req, 'knowledge.source.added', { kb: src.kb_id, source: src.id }, { kind: src.kind, location: src.location, schedule: src.schedule, labelFloor: src.label_floor, ...(src.config.accessColumn ? { accessColumn: src.config.accessColumn, accessKind: src.config.accessKind } : {}), ...(src.config.replication ? { replication: true, publication: src.config.publication } : {}), ...(src.config.include?.length ? { include: src.config.include } : {}), ...(src.config.endpoint ? { endpoint: src.config.endpoint, ownKeys: true } : {}), ...(src.kind === 'web' ? { maxDepth: src.config.maxDepth, maxPages: src.config.maxPages, pathPrefix: src.config.pathPrefix, sitemap: src.config.sitemap } : {}), ...(src.config.roleMappings ? { roleMappings: src.config.roleMappings } : {}), ...(src.config.fields ? { fields: src.config.fields } : {}) }, src.label_floor);
    res.status(201).json(sourceView(src));
  });

  r.post('/knowledge/sources/:id/sync', read, async (req, res) => {
    const p = principalOf(req);
    const src = await k.source(p.tenantId, String(req.params.id));
    await k.base(p, src.kb_id, 'manage');
    const out = await k.sync(p.userId, src);
    await audit(req, 'knowledge.source.synced', { kb: src.kb_id, source: src.id }, { job: out.jobId });
    res.status(202).json(out);
  });

  r.delete('/knowledge/sources/:id', read, async (req, res) => {
    const p = principalOf(req);
    const src = await k.source(p.tenantId, String(req.params.id));
    const out = await k.removeSource(p, src.id);
    await audit(req, 'knowledge.source.removed', { kb: src.kb_id, source: src.id }, { location: src.location, ...out });
    res.json(out);
  });

  // ---------- documents ----------

  r.get('/knowledge/bases/:id/documents', read, async (req, res) => {
    const q = parseBody(z.object({ q: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(1000).default(200), media: z.enum(['image']).optional(), labels: z.string().max(2000).optional(), labelsAll: z.string().max(2000).optional(), minScore: z.coerce.number().min(0).max(1).optional() }), req.query);
    // B-8804: the filter chips, as comma-separated label names.
    const list = (v?: string) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 20) : []);
    const labels: LabelFilter | undefined = q.labels || q.labelsAll ? { any: list(q.labels), all: list(q.labelsAll), ...(q.minScore != null ? { minScore: q.minScore } : {}) } : undefined;
    res.json(await k.documents(principalOf(req), String(req.params.id), { ...(q.q ? { q: q.q } : {}), limit: q.limit, ...(q.media ? { media: q.media } : {}), ...(labels ? { labels } : {}) }));
  });

  /** B-8804: the labels the base's image documents carry, with how many documents carry each (for the filter chips). */
  r.get('/knowledge/bases/:id/labels', read, async (req, res) => {
    res.json(await k.labelCounts(principalOf(req), String(req.params.id)));
  });

  /** B-8802: labels every image of the base again with the classifiers it names (a job). */
  r.post('/knowledge/bases/:id/reclassify', read, async (req, res) => {
    parseBody(z.object({}).strict(), req.body ?? {});
    const out = await k.reclassify(principalOf(req), String(req.params.id));
    await audit(req, 'knowledge.reclassify.started', { kb: String(req.params.id) }, out);
    res.status(202).json(out);
  });

  /** Raw upload (the body is the file) into sealed quarantine; a scan job admits it. */
  r.put('/knowledge/bases/:id/uploads', read, express.raw({ type: () => true, limit: s.cfg.ATTACHMENT_MAX_BYTES }), async (req, res) => {
    const p = principalOf(req);
    const q = parseBody(z.object({ name: z.string().trim().min(1).max(255).regex(/^[^/\\\0]+$/), label: z.enum(LABELS).default('public') }), req.query);
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!data.length) throw badRequest('The file is empty.');
    const doc = await k.upload(p, String(req.params.id), { name: q.name, label: q.label, data });
    await audit(req, 'knowledge.uploaded', { kb: doc.kb_id, document: doc.id }, { name: doc.name, size: doc.size }, doc.label);
    res.status(202).json(docView(doc));
  });

  r.get('/knowledge/documents/:id', read, async (req, res) => {
    const p = principalOf(req);
    const { doc, kb } = await k.documentFor(p, String(req.params.id));
    const src = await k.source(doc.tenant_id, doc.source_id);
    const image = await k.imageDetail(p, doc);
    res.json({ ...docView(doc, src, doc.media === 'image' ? image.labels : undefined), kb: { id: kb.id, name: kb.name, imageClassifiers: kb.image_classifiers.length }, caption: image.caption, text: image.text, visionModel: image.visionModel, parts: image.parts });
  });

  /**
   * B-8803: an image document's picture, for the caller's clearance and row access. The image itself is served (no
   * resizing on the server); HEIC, which browsers do not show, has none.
   */
  r.get('/knowledge/documents/:id/thumbnail', read, async (req, res) => {
    const img = await k.thumbnail(principalOf(req), String(req.params.id));
    res.setHeader('content-type', img.type);
    res.setHeader('content-length', String(img.data.length));
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-security-policy', "default-src 'none'; sandbox");
    res.setHeader('content-disposition', 'inline');
    res.setHeader('cache-control', 'private, no-store');
    res.end(img.data);
  });

  r.post('/knowledge/documents/:id/reclassify', read, async (req, res) => {
    const p = principalOf(req);
    const { doc } = await k.documentFor(p, String(req.params.id), 'manage');
    const out = await k.reclassify(p, doc.kb_id, doc.id);
    await audit(req, 'knowledge.document.reclassify.started', { kb: doc.kb_id, document: doc.id }, { job: out.jobId }, doc.label);
    res.status(202).json(out);
  });

  r.patch('/knowledge/documents/:id', read, async (req, res) => {
    const body = parseBody(z.object({ label: z.enum(LABELS), reason: z.string().trim().max(500).default('') }).strict(), req.body);
    const before = await k.documentFor(principalOf(req), String(req.params.id), 'manage');
    const doc = await k.relabel(principalOf(req), before.doc.id, body.label);
    await audit(req, 'knowledge.document.relabelled', { kb: doc.kb_id, document: doc.id }, { from: before.doc.label, to: doc.label, reason: body.reason || null }, doc.label);
    res.json(docView(doc));
  });

  r.post('/knowledge/documents/:id/reindex', read, async (req, res) => {
    const out = await k.reindexDocument(principalOf(req), String(req.params.id));
    await audit(req, 'knowledge.document.reindexed', { document: String(req.params.id) }, out);
    res.status(202).json(out);
  });

  r.delete('/knowledge/documents/:id', read, async (req, res) => {
    const doc = await k.removeDocument(principalOf(req), String(req.params.id));
    await audit(req, 'knowledge.document.removed', { kb: doc.kb_id, document: doc.id }, { name: doc.name, chunks: doc.chunks }, doc.label);
    res.status(204).end();
  });

  // ---------- test search ----------

  r.post('/knowledge/search', read, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ kbIds: z.array(id26).min(1).max(20), query: z.string().trim().min(1).max(2000), k: z.number().int().min(1).max(50).default(8), rerank: z.boolean().default(true), labels: labelFilter.optional() }).strict(), req.body);
    const kbs = [];
    for (const id of body.kbIds) kbs.push(await k.base(p, id));
    const out = await k.search(p, kbs, body.query, { k: body.k, rerank: body.rerank, withText: true, queryLabel: 'internal', ...(body.labels ? { labels: body.labels } : {}) });
    res.json({ ...out, vectorStore: s.vectors.kind });
  });

  // ---------- conversations ----------

  r.get('/conversations/:id/knowledge', requireAuth(), requirePermission(s, 'context:read'), async (req, res) => {
    const p = principalOf(req);
    await s.chat.conversation(p, String(req.params.id));
    const ids = await k.bindings(String(req.params.id));
    const visible = await k.summaries(p);
    res.json(visible.filter((x) => ids.includes(x.id)).map((x) => ({ id: x.id, name: x.name, label: x.label, status: x.status })));
  });

  r.put('/conversations/:id/knowledge', requireAuth(), requirePermission(s, 'context:write'), async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ kbIds: z.array(id26).max(20) }).strict(), req.body);
    const ids = await k.bind(p, String(req.params.id), body.kbIds);
    await audit(req, 'conversation.knowledge.set', { conversation: String(req.params.id) }, { kbs: ids });
    res.json({ kbIds: ids });
  });

  return r;
}
