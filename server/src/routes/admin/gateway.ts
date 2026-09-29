import { Router, type Request } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import { actorFrom, isUniqueViolation } from '../../audit/chain.js';
import { clears, labelRank, LABELS } from '../../authz/labels.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../../http/problem.js';
import { THINK_LEVELS, type ModelRow, type ProfileRow, type ThinkLevel } from '../../gateway/repo.js';
import type { Services } from '../../services.js';

const PICKLE = /\.(bin|pt|pth|pkl|pickle|ckpt)(\?|$)/i;
const secretPath = z.string().regex(/^\/[^\0]+$/, 'An absolute path on the server').max(500);
const settingsSchema = z
  .object({
    memoryBytes: z.number().int().min(0).max(2 ** 50).optional(),
    hardware: z.string().max(100).optional(),
    node: z.string().max(100).optional(),
    device: z.string().max(200).optional(),
    parallel: z.number().int().min(1).max(256).optional(),
    maxLoaded: z.number().int().min(1).max(64).optional(),
    numCtx: z.number().int().min(256).max(1_048_576).optional(),
    kvCacheType: z.enum(['f16', 'q8_0', 'q4_0']).optional(),
    keepAlive: z.string().regex(/^(-1|\d+[smh]?)$/).optional()
  })
  .strict();
const tlsSchema = z.object({ caFile: secretPath.optional(), certFile: secretPath.optional(), keyFile: secretPath.optional() }).strict().nullable();
const urlSchema = z.string().url().refine((u) => /^https?:\/\//.test(u), 'http:// or https:// URL');
const thinkRank = (t: ThinkLevel) => THINK_LEVELS.indexOf(t);

export const modelView = (m: ModelRow) => ({
  id: m.id,
  name: m.name,
  family: m.family,
  parameterSize: m.parameter_size,
  quantization: m.quantization,
  format: m.format,
  sizeBytes: m.size_bytes,
  contextLength: m.context_length,
  capabilities: m.capabilities,
  source: m.source,
  expectedDigest: m.expected_digest,
  digest: m.digest,
  license: m.license,
  label: m.label,
  state: m.state,
  importState: m.import_state,
  importError: m.import_error,
  evaluation: m.evaluation,
  requestedBy: m.requested_by,
  approvedBy: m.approved_by,
  approvedAt: m.approved_at,
  retireAt: m.retire_at,
  notes: m.notes,
  createdAt: m.created_at,
  updatedAt: m.updated_at
});

export const profileView = (p: ProfileRow) => ({
  id: p.id,
  name: p.name,
  displayName: p.display_name,
  description: p.description,
  aliasOf: p.alias_of,
  modelId: p.model_id,
  poolId: p.pool_id,
  numCtx: p.num_ctx,
  temperature: p.temperature,
  thinkDefault: p.think_default,
  thinkCeiling: p.think_ceiling,
  systemPrompt: p.system_prompt,
  fallback: p.fallback,
  canary: p.canary,
  tools: p.tools,
  label: p.label,
  status: p.status,
  version: p.version,
  updatedAt: p.updated_at
});

/** Pools, instances, the model catalogue and tenant profiles. */
export function gatewayAdminRoutes(s: Services): Router {
  const r = Router();
  const g = s.gateway;
  r.use(['/pools', '/instances', '/models', '/placements', '/profiles'], noStore, requireAuth());
  const pools = requirePermission(s, 'pools:manage');
  const models = requirePermission(s, 'models:manage');
  const readModels = requirePermission(s, 'models:read');
  const profiles = requirePermission(s, 'profiles:manage');

  const audit = (req: Request, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, ...(detail ? { detail } : {}), traceId: req.traceId });
  };

  // ---------- pools and instances ----------

  r.get('/pools', pools, async (_req, res) => {
    res.json(await g.snapshot());
  });

  r.post('/pools', pools, async (req, res) => {
    const body = parseBody(
      z.object({ name: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), description: z.string().trim().max(500).nullable().default(null), accelerator: z.enum(['cuda', 'rocm', 'metal', 'cpu']), zone: z.string().trim().regex(/^[a-z0-9-]{1,63}$/).default('inference'), labelCeiling: z.enum(LABELS).default('internal') }),
      req.body
    );
    try {
      const p = await g.repo.createPool(body);
      await audit(req, 'pool.created', { pool: p.id, name: p.name }, { accelerator: p.accelerator, zone: p.zone, labelCeiling: p.label_ceiling });
      res.status(201).json(p);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('A pool with that name exists.');
      throw err;
    }
  });

  r.patch('/pools/:id', pools, async (req, res) => {
    const pool = await g.repo.pool(String(req.params.id));
    if (!pool) throw notFound('Pool');
    const body = parseBody(z.object({ description: z.string().trim().max(500).nullable().optional(), zone: z.string().regex(/^[a-z0-9-]{1,63}$/).optional(), labelCeiling: z.enum(LABELS).optional(), accelerator: z.enum(['cuda', 'rocm', 'metal', 'cpu']).optional() }).strict(), req.body);
    await g.repo.updatePool(pool.id, body);
    await audit(req, 'pool.updated', { pool: pool.id, name: pool.name }, { before: { zone: pool.zone, labelCeiling: pool.label_ceiling }, after: body });
    res.json(await g.repo.pool(pool.id));
  });

  r.delete('/pools/:id', pools, async (req, res) => {
    const pool = await g.repo.pool(String(req.params.id));
    if (!pool) throw notFound('Pool');
    if ((await g.repo.instances(pool.id)).length) throw conflict('Remove the pool\'s instances first.');
    if ((await s.db('profiles').where({ pool_id: pool.id }).first())) throw conflict('Profiles route to this pool.');
    await g.repo.deletePool(pool.id);
    await audit(req, 'pool.deleted', { pool: pool.id, name: pool.name });
    res.status(204).end();
  });

  /** Starts a rolling Ollama upgrade job across the pool. */
  r.post('/pools/:id/upgrade', pools, async (req, res) => {
    const p = principalOf(req);
    const pool = await g.repo.pool(String(req.params.id));
    if (!pool) throw notFound('Pool');
    const body = parseBody(z.object({ targetVersion: z.string().regex(/^\d+\.\d+\.\d+([-.][\w.]+)?$/), waitMinutes: z.number().int().min(1).max(240).default(30) }), req.body);
    const job = await s.jobs.enqueue({ tenantId: p.tenantId, type: 'pool.upgrade', payload: { poolId: pool.id, targetVersion: body.targetVersion, waitMs: body.waitMinutes * 60_000 }, createdBy: p.userId, maxAttempts: 1, dedupeKey: `pool.upgrade:${pool.id}:${body.targetVersion}:${Date.now()}` });
    await audit(req, 'pool.upgrade.started', { pool: pool.id, name: pool.name }, { targetVersion: body.targetVersion, job: job.id });
    res.status(202).json({ jobId: job.id });
  });

  r.post('/pools/:id/instances', pools, async (req, res) => {
    const pool = await g.repo.pool(String(req.params.id));
    if (!pool) throw notFound('Pool');
    const body = parseBody(z.object({ name: z.string().trim().regex(/^[a-z0-9][a-z0-9./-]{0,99}$/), url: urlSchema, deploy: z.enum(['docker', 'baremetal']), tls: tlsSchema.default(null), settings: settingsSchema.default({}) }), req.body);
    if (body.tls && !body.url.startsWith('https://')) throw badRequest('Mutual TLS needs an https:// URL.');
    try {
      const inst = await g.repo.createInstance({ poolId: pool.id, ...body });
      await audit(req, 'instance.created', { instance: inst.id, name: inst.name, pool: pool.name }, { url: inst.url, deploy: inst.deploy, mtls: !!body.tls });
      await g.pollOne(inst.id);
      res.status(201).json((await g.snapshot()).flatMap((p) => p.instances).find((i) => i.id === inst.id));
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('An instance with that name exists in the pool.');
      throw err;
    }
  });

  const loadInstance = async (req: Request) => {
    const inst = await g.repo.instance(String(req.params.id));
    if (!inst) throw notFound('Instance');
    return inst;
  };

  r.patch('/instances/:id', pools, async (req, res) => {
    const inst = await loadInstance(req);
    const body = parseBody(z.object({ url: urlSchema.optional(), tls: tlsSchema.optional(), settings: settingsSchema.optional(), state: z.enum(['active', 'disabled']).optional() }).strict(), req.body);
    await g.repo.updateInstance(inst.id, body);
    await audit(req, 'instance.updated', { instance: inst.id, name: inst.name }, { after: { ...body, tls: body.tls === undefined ? undefined : !!body.tls } });
    await g.pollOne(inst.id);
    res.json((await g.snapshot()).flatMap((p) => p.instances).find((i) => i.id === inst.id));
  });

  r.delete('/instances/:id', pools, async (req, res) => {
    const inst = await loadInstance(req);
    await g.repo.deleteInstance(inst.id);
    await audit(req, 'instance.deleted', { instance: inst.id, name: inst.name });
    await g.pollAll();
    res.status(204).end();
  });

  r.get('/instances/:id/plan', pools, async (req, res) => {
    const inst = await loadInstance(req);
    const q = parseBody(z.object({ model: z.string().min(1).max(200) }), req.query);
    res.json(await g.plan(inst.id, q.model));
  });

  r.get('/instances/:id/events', pools, async (req, res) => {
    const inst = await loadInstance(req);
    res.json(await g.repo.events(inst.id, 50));
  });

  r.post('/instances/:id/load', pools, async (req, res) => {
    const p = principalOf(req);
    const inst = await loadInstance(req);
    const body = parseBody(z.object({ model: z.string().min(1).max(200), pinned: z.boolean().default(false) }), req.body);
    const out = await g.load(inst.id, body.model, { pinned: body.pinned, actor: p.username });
    await audit(req, body.pinned ? 'model.pinned' : 'model.loaded', { instance: inst.id, name: inst.name, model: body.model }, { evicted: out.evicted });
    res.json(out);
  });

  r.post('/instances/:id/unload', pools, async (req, res) => {
    const p = principalOf(req);
    const inst = await loadInstance(req);
    const body = parseBody(z.object({ model: z.string().min(1).max(200) }), req.body);
    await g.unload(inst.id, body.model, p.username);
    await audit(req, 'model.unloaded', { instance: inst.id, name: inst.name, model: body.model });
    res.json({ ok: true });
  });

  r.post('/instances/:id/drain', pools, async (req, res) => {
    const p = principalOf(req);
    const inst = await loadInstance(req);
    const out = await g.drain(inst.id, p.username);
    await audit(req, 'instance.drained', { instance: inst.id, name: inst.name }, out);
    res.json(out);
  });

  r.post('/instances/:id/undrain', pools, async (req, res) => {
    const inst = await loadInstance(req);
    await g.undrain(inst.id);
    await audit(req, 'instance.undrained', { instance: inst.id, name: inst.name });
    res.json({ ok: true });
  });

  // ---------- placements ----------

  r.post('/placements', pools, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ modelId: z.string().length(26), poolId: z.string().length(26), residency: z.enum(['pinned', 'warm', 'cold']).default('warm'), pull: z.boolean().default(true) }), req.body);
    const [model, pool] = await Promise.all([g.repo.model(body.modelId), g.repo.pool(body.poolId)]);
    if (!model) throw notFound('Model');
    if (!pool) throw notFound('Pool');
    if (model.state === 'retired') throw conflict('A retired model cannot be placed.');
    if (labelRank(model.label) > labelRank(pool.label_ceiling)) throw forbidden(`${model.name} is approved for ${model.label} data but ${pool.name}'s ceiling is ${pool.label_ceiling}.`, { step: 'zone' });
    const pl = await g.repo.place(model.id, pool.id, body.residency, p.userId);
    const job = body.pull ? await s.jobs.enqueue({ tenantId: p.tenantId, type: 'model.pull', payload: { modelId: model.id, poolId: pool.id }, createdBy: p.userId, maxAttempts: 1 }) : null;
    await audit(req, 'model.placed', { model: model.name, pool: pool.name }, { residency: body.residency, pullJob: job?.id ?? null });
    res.status(201).json({ ...pl, jobId: job?.id ?? null });
  });

  r.patch('/placements/:id', pools, async (req, res) => {
    const pl = (await g.repo.placements()).find((x) => x.id === req.params.id);
    if (!pl) throw notFound('Placement');
    const body = parseBody(z.object({ residency: z.enum(['pinned', 'warm', 'cold']) }), req.body);
    await g.repo.place(pl.model_id, pl.pool_id, body.residency, principalOf(req).userId);
    await audit(req, 'model.placement.updated', { placement: pl.id }, { residency: body.residency });
    res.json({ ...pl, residency: body.residency });
  });

  r.delete('/placements/:id', pools, async (req, res) => {
    const pl = (await g.repo.placements()).find((x) => x.id === req.params.id);
    if (!pl) throw notFound('Placement');
    await g.repo.unplace(pl.id);
    await audit(req, 'model.unplaced', { placement: pl.id, model: pl.model_id, pool: pl.pool_id });
    res.status(204).end();
  });

  // ---------- model catalogue ----------

  r.get('/models', readModels, async (_req, res) => {
    const [list, placements, pools, profiles] = await Promise.all([g.repo.models(), g.repo.placements(), g.repo.pools(), s.db('profiles').select('id', 'name', 'model_id', 'tenant_id')]);
    const people = [...new Set(list.flatMap((m) => [m.requested_by, m.approved_by]).filter((u): u is string => !!u))];
    const names = new Map((await s.db('users').whereIn('id', people).select('id', 'display_name')).map((u: { id: string; display_name: string }) => [u.id, u.display_name]));
    res.json(
      list.map((m) => ({
        ...modelView(m),
        requestedByName: m.requested_by ? (names.get(m.requested_by) ?? null) : null,
        approvedByName: m.approved_by ? (names.get(m.approved_by) ?? null) : null,
        pools: placements.filter((x) => x.model_id === m.id).map((x) => ({ placementId: x.id, poolId: x.pool_id, pool: pools.find((p) => p.id === x.pool_id)?.name, residency: x.residency })),
        profiles: profiles.filter((x: { model_id: string | null }) => x.model_id === m.id).length
      }))
    );
  });

  /** An import request: the model is recorded as a draft and pulled onto a pool by a job. */
  r.post('/models', models, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(
      z.object({
        name: z.string().trim().regex(/^[a-zA-Z0-9][\w./:-]{0,199}$/, 'An Ollama model name such as llama3.1:8b or hf.co/org/repo:Q4_K_M'),
        source: z.string().trim().min(1).max(500).default('Ollama library'),
        expectedDigest: z.string().trim().regex(/^(sha256:)?[a-f0-9]{64}$/i).nullable().default(null),
        license: z.object({ name: z.string().trim().max(200), url: z.string().url().max(500).optional(), notes: z.string().max(1000).optional() }).nullable().default(null),
        label: z.enum(LABELS).default('internal'),
        notes: z.string().trim().max(1000).nullable().default(null),
        poolId: z.string().length(26).optional()
      }),
      req.body
    );
    if (PICKLE.test(body.name) || PICKLE.test(body.source)) {
      await audit(req, 'model.import.refused', { model: body.name }, { reason: 'pickle' });
      throw new HttpProblem(422, 'Import refused', 'The source is a pickle checkpoint (.bin, .pt, .pth, .pkl, .ckpt). Only GGUF and safetensors are accepted.', { extensions: { reason: 'pickle' } });
    }
    if (!clears(p.clearance, body.label)) throw forbidden('You cannot approve a model for data above your clearance.', { step: 'clearance' });
    let m: ModelRow;
    try {
      m = await g.repo.createModel({ name: body.name, source: body.source, expectedDigest: body.expectedDigest, license: body.license?.name ? { ...body.license, recordedBy: p.username, recordedAt: Date.now() } : null, label: body.label, notes: body.notes, requestedBy: p.userId, requestedTenant: p.tenantId });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('That model is already in the catalogue.');
      throw err;
    }
    let jobId: string | null = null;
    if (body.poolId) {
      const pool = await g.repo.pool(body.poolId);
      if (!pool) throw notFound('Pool');
      if (labelRank(m.label) > labelRank(pool.label_ceiling)) {
        await s.db('models').where({ id: m.id }).delete();
        throw forbidden(`${m.name} is labelled ${m.label} but ${pool.name}'s ceiling is ${pool.label_ceiling}.`, { step: 'zone' });
      }
      await g.repo.place(m.id, pool.id, 'warm', p.userId);
      jobId = (await s.jobs.enqueue({ tenantId: p.tenantId, type: 'model.pull', payload: { modelId: m.id, poolId: pool.id }, createdBy: p.userId, maxAttempts: 1 })).id;
    }
    await audit(req, 'model.import.requested', { model: m.name }, { source: m.source, expectedDigest: m.expected_digest, label: m.label, pullJob: jobId });
    res.status(201).json({ ...modelView(m), jobId });
  });

  const loadModel = async (req: Request) => {
    const m = await g.repo.model(String(req.params.id));
    if (!m) throw notFound('Model');
    return m;
  };

  r.patch('/models/:id', models, async (req, res) => {
    const p = principalOf(req);
    const m = await loadModel(req);
    const body = parseBody(z.object({ license: z.object({ name: z.string().trim().min(1).max(200), url: z.string().url().max(500).optional(), notes: z.string().max(1000).optional() }).optional(), label: z.enum(LABELS).optional(), notes: z.string().trim().max(1000).nullable().optional() }).strict(), req.body);
    if (m.state === 'retired') throw conflict('A retired model is read-only.');
    if (body.label && !clears(p.clearance, body.label)) throw forbidden('You cannot approve a model for data above your clearance.', { step: 'clearance' });
    if (body.label && m.state === 'approved' && labelRank(body.label) > labelRank(m.label)) throw conflict('Raising the label of an approved model needs a new approval: deprecate and re-import, or lower it.');
    await g.repo.updateModel(m.id, { ...(body.license ? { license: { ...body.license, recordedBy: p.username, recordedAt: Date.now() } } : {}), ...(body.label ? { label: body.label } : {}), ...(body.notes !== undefined ? { notes: body.notes } : {}) });
    await audit(req, 'model.updated', { model: m.name }, { after: body });
    res.json(modelView((await g.repo.model(m.id))!));
  });

  r.post('/models/:id/evaluate', models, async (req, res) => {
    const p = principalOf(req);
    const m = await loadModel(req);
    if (m.import_state !== 'pulled') throw conflict('Pull the model onto a pool before evaluating it.');
    const job = await s.jobs.enqueue({ tenantId: p.tenantId, type: 'model.evaluate', payload: { modelId: m.id }, createdBy: p.userId, maxAttempts: 1 });
    await audit(req, 'model.evaluation.started', { model: m.name }, { job: job.id });
    res.status(202).json({ jobId: job.id });
  });

  r.post('/models/:id/pull', models, async (req, res) => {
    const p = principalOf(req);
    const m = await loadModel(req);
    const body = parseBody(z.object({ poolId: z.string().length(26) }), req.body);
    if (!(await g.repo.pool(body.poolId))) throw notFound('Pool');
    const job = await s.jobs.enqueue({ tenantId: p.tenantId, type: 'model.pull', payload: { modelId: m.id, poolId: body.poolId }, createdBy: p.userId, maxAttempts: 1 });
    await audit(req, 'model.pull.started', { model: m.name }, { job: job.id });
    res.status(202).json({ jobId: job.id });
  });

  /**
   * Lifecycle: draft → evaluated → approved → deprecated → retired. Approval is dual control (someone other than
   * the requester) and needs a recorded licence and a passing evaluation.
   */
  r.post('/models/:id/lifecycle', models, async (req, res) => {
    const p = principalOf(req);
    const m = await loadModel(req);
    const body = parseBody(z.object({ to: z.enum(['approved', 'deprecated', 'retired']), retireAt: z.number().int().optional(), reason: z.string().trim().max(500).optional() }), req.body);
    const from = m.state;
    if (body.to === 'approved') {
      if (from !== 'evaluated') throw conflict(from === 'draft' ? 'Run the evaluation first; only evaluated models can be approved.' : `An ${from} model cannot be approved again.`);
      if (!m.license?.name) throw conflict('Record the licence before approving.');
      if (m.requested_by === p.userId) throw forbidden('Dual control: someone other than the requester must approve.', { step: 'dual-control' });
      if (!clears(p.clearance, m.label)) throw forbidden('You cannot approve a model for data above your clearance.', { step: 'clearance' });
      await g.repo.updateModel(m.id, { state: 'approved', approved_by: p.userId, approved_at: Date.now() });
    } else if (body.to === 'deprecated') {
      if (from !== 'approved') throw conflict('Only approved models can be deprecated.');
      await g.repo.updateModel(m.id, { state: 'deprecated', retire_at: body.retireAt ?? null });
    } else {
      if (from !== 'deprecated' && from !== 'draft' && from !== 'evaluated') throw conflict('Deprecate the model before retiring it.');
      await g.repo.updateModel(m.id, { state: 'retired', retire_at: Date.now() });
      // Retired models stay in the catalogue for audit but leave routing: their placements go.
      for (const pl of (await g.repo.placements()).filter((x) => x.model_id === m.id)) await g.repo.unplace(pl.id);
    }
    await audit(req, `model.${body.to}`, { model: m.name }, { from, reason: body.reason ?? null });
    res.json(modelView((await g.repo.model(m.id))!));
  });

  // ---------- profiles ----------

  const fallbackSchema = z.object({ profileId: z.string().length(26), afterQueueWaitMs: z.number().int().min(0).max(600_000).default(8000) }).nullable();
  const profileBody = z.object({
    displayName: z.string().trim().min(1).max(200),
    description: z.string().trim().max(500).nullable(),
    modelId: z.string().length(26).nullable(),
    poolId: z.string().length(26).nullable(),
    numCtx: z.number().int().min(256).max(1_048_576).nullable(),
    temperature: z.number().min(0).max(2).nullable(),
    thinkDefault: z.enum(['off', 'low', 'medium', 'high']),
    thinkCeiling: z.enum(['off', 'low', 'medium', 'high']),
    systemPrompt: z.string().max(20_000).nullable(),
    fallback: fallbackSchema,
    // calculate, or published registry and MCP tools by name (Sprint 7)
    tools: z.array(z.string().trim().regex(/^[A-Za-z0-9][\w.:-]{0,119}$/)).max(32),
    label: z.enum(LABELS)
  });

  const listProfiles = async (tenantId: string) => {
    const [list, modelsList, poolsList] = await Promise.all([g.repo.profiles(tenantId), g.repo.models(), g.repo.pools()]);
    const snap = await g.snapshot();
    const residency = (modelName: string | undefined, poolId: string | null) => {
      if (!modelName) return 'none';
      const insts = snap.filter((p) => !poolId || p.id === poolId).flatMap((p) => p.instances);
      if (insts.some((i) => i.loaded.some((l) => l.name === modelName || l.name === `${modelName}:latest`))) return 'loaded';
      if (insts.some((i) => i.available.some((a) => a.name === modelName || a.name === `${modelName}:latest`))) return 'cold';
      return 'unavailable';
    };
    return list.map((p) => {
      const m = modelsList.find((x) => x.id === p.model_id);
      return {
        ...profileView(p),
        model: m ? { id: m.id, name: m.name, state: m.state, label: m.label, capabilities: m.capabilities, digest: m.digest } : null,
        pool: p.pool_id ? (poolsList.find((x) => x.id === p.pool_id)?.name ?? null) : null,
        canaryModel: p.canary ? (modelsList.find((x) => x.id === p.canary!.modelId)?.name ?? null) : null,
        residency: residency(m?.name, p.pool_id)
      };
    });
  };

  r.get('/profiles', profiles, async (req, res) => {
    res.json(await listProfiles(principalOf(req).tenantId));
  });

  const validate = async (tenantId: string, p: ProfileRow, forPublish: boolean) => {
    if (p.alias_of) return;
    if (thinkRank(p.think_default) > thinkRank(p.think_ceiling)) throw badRequest('The default thinking level cannot be above the ceiling.');
    if (p.fallback) {
      if (p.fallback.profileId === p.id) throw badRequest('A profile cannot fall back to itself.');
      if (!(await g.repo.profile(tenantId, p.fallback.profileId))) throw notFound('Fallback profile');
    }
    const m = p.model_id ? await g.repo.model(p.model_id) : undefined;
    if (p.model_id && !m) throw notFound('Model');
    if (p.pool_id && !(await g.repo.pool(p.pool_id))) throw notFound('Pool');
    if (!forPublish) return;
    if (!m) throw conflict('Choose a model before publishing.');
    if (m.state !== 'approved' && !(m.state === 'deprecated' && p.status === 'published')) throw conflict(`${m.name} is ${m.state}; profiles publish only with an approved model.`);
    if (labelRank(p.label) > labelRank(m.label)) throw conflict(`${m.name} is approved for ${m.label} data; the profile's label is ${p.label}.`);
    const pls = (await g.repo.placements()).filter((x) => x.model_id === m.id);
    if (!pls.length) throw conflict(`${m.name} is not placed on any pool.`);
    if (p.pool_id && !pls.some((x) => x.pool_id === p.pool_id)) throw conflict(`${m.name} is not placed on the chosen pool.`);
    const poolsList = await g.repo.pools();
    const reachable = poolsList.filter((x) => pls.some((y) => y.pool_id === x.id) && (!p.pool_id || x.id === p.pool_id));
    if (!reachable.some((x) => labelRank(x.label_ceiling) >= labelRank(p.label))) throw conflict(`No pool running ${m.name} is cleared for ${p.label} data.`);
    if (p.think_ceiling !== 'off' && !m.capabilities.includes('thinking')) throw conflict(`${m.name} does not support thinking; set the ceiling to off.`);
    if (p.tools.length && (!m.capabilities.includes('tools') || m.evaluation?.toolsWithheld)) throw conflict(`${m.name} has no tools capability${m.evaluation?.toolsWithheld ? ' (withheld until its tool-calling test passes)' : ''}.`);
  };

  r.post('/profiles', profiles, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(
      profileBody.partial().extend({ name: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), displayName: z.string().trim().min(1).max(200), aliasOf: z.string().length(26).nullable().default(null) }),
      req.body
    );
    if (body.label && !clears(p.clearance, body.label)) throw forbidden('You cannot label a profile above your clearance.', { step: 'clearance' });
    if (body.aliasOf) {
      const target = await g.repo.profile(p.tenantId, body.aliasOf);
      if (!target) throw notFound('Profile');
      if (target.alias_of) throw badRequest('An alias must point at a real profile, not another alias.');
    }
    const t = Date.now();
    const row: ProfileRow = {
      id: ulid(),
      tenant_id: p.tenantId,
      name: body.name,
      display_name: body.displayName,
      description: body.description ?? null,
      alias_of: body.aliasOf,
      model_id: body.aliasOf ? null : (body.modelId ?? null),
      pool_id: body.aliasOf ? null : (body.poolId ?? null),
      num_ctx: body.numCtx ?? null,
      temperature: body.temperature ?? null,
      think_default: body.thinkDefault ?? 'off',
      think_ceiling: body.thinkCeiling ?? 'off',
      system_prompt: body.systemPrompt ?? null,
      fallback: body.fallback ?? null,
      canary: null,
      tools: body.tools ?? [],
      label: body.label ?? 'internal',
      status: body.aliasOf ? 'published' : 'draft',
      version: 1,
      updated_by: p.userId,
      created_at: t,
      updated_at: t
    };
    if (row.model_id) {
      const m = await g.repo.model(row.model_id);
      if (m && (m.state === 'deprecated' || m.state === 'retired')) throw conflict(`${m.name} is ${m.state}; new profiles cannot pick it.`);
    }
    await validate(p.tenantId, row, false);
    try {
      await g.repo.createProfile(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('A profile with that name exists.');
      throw err;
    }
    await g.repo.snapshot(row, 'Created', p.userId);
    await audit(req, 'profile.created', { profile: row.id, name: row.name }, { aliasOf: row.alias_of, model: row.model_id });
    res.status(201).json(profileView(row));
  });

  const loadProfile = async (req: Request) => {
    const x = await g.repo.profile(principalOf(req).tenantId, String(req.params.id));
    if (!x) throw notFound('Profile');
    return x;
  };

  /** Every change is a new version; the previous one stays available for rollback. */
  const saveVersion = async (req: Request, before: ProfileRow, patch: Partial<ProfileRow>, note: string) => {
    const p = principalOf(req);
    const next: ProfileRow = { ...before, ...patch, version: before.version + 1, updated_by: p.userId, updated_at: Date.now() };
    await validate(p.tenantId, next, next.status === 'published');
    await g.repo.updateProfile(p.tenantId, before.id, { ...patch, version: next.version, updated_by: p.userId });
    await g.repo.snapshot(next, note, p.userId);
    return next;
  };

  r.patch('/profiles/:id', profiles, async (req, res) => {
    const p = principalOf(req);
    const before = await loadProfile(req);
    const body = parseBody(profileBody.partial().extend({ aliasOf: z.string().length(26).optional(), note: z.string().trim().max(300).optional() }).strict(), req.body);
    if (body.label && !clears(p.clearance, body.label)) throw forbidden('You cannot label a profile above your clearance.', { step: 'clearance' });
    if (body.aliasOf !== undefined && !before.alias_of) throw badRequest('Only an alias can be repointed.');
    if (body.aliasOf) {
      const target = await g.repo.profile(p.tenantId, body.aliasOf);
      if (!target || target.alias_of || target.id === before.id) throw badRequest('An alias must point at a real profile.');
    }
    const patch: Partial<ProfileRow> = {};
    const map: [keyof typeof body, keyof ProfileRow][] = [['displayName', 'display_name'], ['description', 'description'], ['modelId', 'model_id'], ['poolId', 'pool_id'], ['numCtx', 'num_ctx'], ['temperature', 'temperature'], ['thinkDefault', 'think_default'], ['thinkCeiling', 'think_ceiling'], ['systemPrompt', 'system_prompt'], ['fallback', 'fallback'], ['tools', 'tools'], ['label', 'label'], ['aliasOf', 'alias_of']];
    for (const [a, b] of map) if (body[a] !== undefined) (patch as Record<string, unknown>)[b] = body[a];
    if (patch.model_id && patch.model_id !== before.model_id) {
      const m = await g.repo.model(patch.model_id);
      if (m && (m.state === 'deprecated' || m.state === 'retired')) throw conflict(`${m.name} is ${m.state}; profiles cannot switch to it.`);
    }
    const next = await saveVersion(req, before, patch, body.note ?? 'Edited');
    await audit(req, 'profile.updated', { profile: before.id, name: before.name }, { version: next.version, changed: Object.keys(patch) });
    res.json(profileView(next));
  });

  r.post('/profiles/:id/publish', profiles, async (req, res) => {
    const before = await loadProfile(req);
    if (before.alias_of) throw badRequest('Aliases are always published.');
    const body = parseBody(z.object({ status: z.enum(['published', 'disabled', 'draft']).default('published') }), req.body);
    const next = await saveVersion(req, before, { status: body.status }, body.status === 'published' ? 'Published' : body.status === 'disabled' ? 'Disabled' : 'Back to draft');
    await audit(req, `profile.${body.status}`, { profile: before.id, name: before.name }, { version: next.version });
    res.json(profileView(next));
  });

  /** Canary: a share of requests goes to another approved model, then is promoted or rolled back. */
  r.put('/profiles/:id/canary', profiles, async (req, res) => {
    const before = await loadProfile(req);
    const body = parseBody(z.object({ modelId: z.string().length(26), percent: z.number().int().min(1).max(50) }), req.body);
    const m = await g.repo.model(body.modelId);
    if (!m) throw notFound('Model');
    if (m.state !== 'approved') throw conflict('A canary must be an approved model.');
    if (labelRank(before.label) > labelRank(m.label)) throw conflict(`${m.name} is approved for ${m.label} data; the profile's label is ${before.label}.`);
    if (!(await g.repo.placements()).some((x) => x.model_id === m.id && (!before.pool_id || x.pool_id === before.pool_id))) throw conflict(`${m.name} is not placed where this profile routes.`);
    const next = await saveVersion(req, before, { canary: { modelId: m.id, percent: body.percent } }, `Canary ${m.name} at ${body.percent}%`);
    await audit(req, 'profile.canary.started', { profile: before.id, name: before.name }, { model: m.name, percent: body.percent });
    res.json(profileView(next));
  });

  r.post('/profiles/:id/canary/promote', profiles, async (req, res) => {
    const before = await loadProfile(req);
    if (!before.canary) throw conflict('No canary is running.');
    const next = await saveVersion(req, before, { model_id: before.canary.modelId, canary: null }, 'Canary promoted');
    await audit(req, 'profile.canary.promoted', { profile: before.id, name: before.name }, { from: before.model_id, to: before.canary.modelId });
    res.json(profileView(next));
  });

  r.delete('/profiles/:id/canary', profiles, async (req, res) => {
    const before = await loadProfile(req);
    if (!before.canary) throw conflict('No canary is running.');
    const next = await saveVersion(req, before, { canary: null }, 'Canary stopped');
    await audit(req, 'profile.canary.stopped', { profile: before.id, name: before.name }, { model: before.canary.modelId });
    res.json(profileView(next));
  });

  r.get('/profiles/:id/versions', profiles, async (req, res) => {
    const x = await loadProfile(req);
    const versions = await g.repo.versions(x.id);
    const names = new Map((await s.db('users').whereIn('id', versions.map((v) => v.created_by).filter((u): u is string => !!u)).select('id', 'display_name')).map((u: { id: string; display_name: string }) => [u.id, u.display_name]));
    res.json(versions.map((v) => ({ version: v.version, note: v.note, createdBy: v.created_by, createdByName: v.created_by ? (names.get(v.created_by) ?? null) : null, createdAt: v.created_at, profile: profileView(v.snapshot) })));
  });

  r.post('/profiles/:id/rollback', profiles, async (req, res) => {
    const before = await loadProfile(req);
    const body = parseBody(z.object({ version: z.number().int().min(1) }), req.body);
    const v = (await g.repo.versions(before.id)).find((x) => x.version === body.version);
    if (!v) throw notFound('Version');
    const snap = v.snapshot;
    const patch: Partial<ProfileRow> = { display_name: snap.display_name, description: snap.description, alias_of: snap.alias_of, model_id: snap.model_id, pool_id: snap.pool_id, num_ctx: snap.num_ctx, temperature: snap.temperature, think_default: snap.think_default, think_ceiling: snap.think_ceiling, system_prompt: snap.system_prompt, fallback: snap.fallback, canary: snap.canary, tools: snap.tools, label: snap.label, status: snap.status };
    const next = await saveVersion(req, before, patch, `Rolled back to version ${body.version}`);
    await audit(req, 'profile.rolled_back', { profile: before.id, name: before.name }, { to: body.version, version: next.version });
    res.json(profileView(next));
  });

  r.delete('/profiles/:id', profiles, async (req, res) => {
    const p = principalOf(req);
    const x = await loadProfile(req);
    const dependants = (await g.repo.profiles(p.tenantId)).filter((y) => y.alias_of === x.id || y.fallback?.profileId === x.id);
    if (dependants.length) throw conflict(`${dependants.map((d) => d.name).join(', ')} point${dependants.length === 1 ? 's' : ''} at this profile.`);
    await g.repo.deleteProfile(p.tenantId, x.id);
    await audit(req, 'profile.deleted', { profile: x.id, name: x.name });
    res.status(204).end();
  });

  return r;
}
