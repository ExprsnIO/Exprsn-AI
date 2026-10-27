import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import { actorFrom, isUniqueViolation } from '../../audit/chain.js';
import { clears, labelRank, LABELS } from '../../authz/labels.js';
import { effectivePermissions } from '../../authz/policy.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../../http/problem.js';
import { isClassifierModel, THINK_LEVELS, type InstanceRow, type ModelRow, type ProfileRow, type ThinkLevel } from '../../gateway/repo.js';
import { resolveTemplate, THINKING_TEMPLATES, thinkingOf, type StoredTemplate } from '../../gateway/thinking.js';
import { SERVER_KINDS } from '../../gateway/server.js';
import { parseVaultRef } from '../../vault/policy.js';
import type { Services } from '../../services.js';
import { checkServiceUrl, servicePolicy, ServiceUrlRefused } from '../../platform/egress.js';
import { evalRoutes } from './evals.js';

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
/** B-4302: a Unix socket a Chat Completions server listens on (`fm serve --socket`). */
const socketSchema = z.string().regex(/^\/[^\0]+$/, 'An absolute path on the server').max(300);
const tokenSchema = z.string().min(1).max(4096);
/** A server's model id: what `/v1/models` lists, such as `system`, `mlx-community/Qwen3-4B-4bit` or `qwen2.5-7b.gguf`. */
const serverModelSchema = z.string().trim().regex(/^[\w./:@+-]{1,200}$/, 'A model id as the server lists it');
const thinkRank = (t: ThinkLevel) => THINK_LEVELS.indexOf(t);

/** B-11707: a model's thinking as the console shows it: the mode in force, whether it was recorded, the template. */
export const thinkingView = (m: ModelRow) => {
  const t = thinkingOf(m);
  // A recorded template that no longer resolves is shown as what was recorded, so an admin can see and repair it.
  const broken = m.thinking_mode === 'template' && !t.template;
  return { mode: t.mode, recorded: t.recorded, template: t.template ? { id: t.template.id, name: t.template.name, system: t.template.system, open: t.template.open, close: t.template.close, startsOpen: !!t.template.startsOpen } : null, ...(broken ? { problem: 'The recorded template is not one this server knows; the model does not think until another is chosen.' } : {}) };
};

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
  // B-4304: held by a Chat Completions server: no pull, no digest.
  held: m.format === 'server',
  serverInstanceId: m.server_instance_id,
  serverModel: m.server_model,
  // B-11707: how the model is made to think, and whether someone recorded it or the manifest says so.
  thinking: thinkingView(m),
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
  trustMarking: p.trust_marking !== false,
  chatCapabilities: p.chat_capabilities ?? null,
  cacheTtlSeconds: p.cache_ttl_seconds ?? null,
  cacheLenient: !!p.cache_lenient,
  label: p.label,
  status: p.status,
  version: p.version,
  updatedAt: p.updated_at
});

/** Pools, instances, the model catalogue and tenant profiles. */
export function gatewayAdminRoutes(s: Services): Router {
  const r = Router();
  const g = s.gateway;
  r.use(['/pools', '/instances', '/models', '/model-servers', '/placements', '/profiles', '/profile-defaults'], noStore, requireAuth());
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
    await s.zones.assertPoolFits(body.zone, body.labelCeiling);
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
    if (body.zone !== undefined || body.labelCeiling !== undefined) await s.zones.assertPoolFits(body.zone ?? pool.zone, body.labelCeiling ?? pool.label_ceiling);
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
    const body = parseBody(
      z.object({ name: z.string().trim().regex(/^[a-z0-9][a-z0-9./-]{0,99}$/), kind: z.enum(SERVER_KINDS as [string, ...string[]]).default('ollama'), url: urlSchema.optional(), socketPath: socketSchema.nullable().default(null), token: tokenSchema.optional(), tokenRef: z.string().max(500).nullable().optional(), deploy: z.enum(['docker', 'baremetal']), tls: tlsSchema.default(null), settings: settingsSchema.default({}), cloud: z.union([cloudFlavourSchema, bedrockCloudSchema]).optional() }),
      req.body
    );
    const kind = body.kind as InstanceRow['kind'];
    // 1.9.99-final (B-10501): a Bedrock instance is an AWS account and region, checked against the region's ceiling.
    // 1.9.99-final (B-10502, B-10503, B-10509): a Chat Completions instance with `cloud.flavour` is an Azure OpenAI
    // resource, DigitalOcean's serverless inference or Workers AI, through one of the provider's accounts.
    const cloud = kind === 'bedrock' ? await bedrockTarget(req, pool, body) : kind === 'openai' && body.cloud && 'flavour' in body.cloud ? await flavourTarget(req, pool, { ...body, cloud: body.cloud }) : null;
    if (kind !== 'bedrock' && body.cloud && !('flavour' in body.cloud)) throw badRequest('A Chat Completions instance with a cloud account names its flavour (azure, digitalocean or workers-ai).');
    const url = cloud ? cloud.url : serverTarget(kind, body.url, body.socketPath, body.tls);
    if (!body.socketPath && !cloud) await checkInstanceUrl(url);
    if ((await g.repo.instances(pool.id)).some((i) => i.name === body.name)) throw conflict('An instance with that name exists in the pool.');
    const token = kind === 'openai' ? await saveToken(req, body.token, body.tokenRef) : rejectToken(body.token, body.tokenRef);
    try {
      const inst = await g.repo.createInstance({ poolId: pool.id, name: body.name, url, kind, socketPath: body.socketPath, token: token ?? null, deploy: body.deploy, tls: body.tls, settings: cloud ? { ...body.settings, cloud: cloud.settings } : body.settings });
      const probe = kind === 'openai' ? await s.jobs.enqueue({ tenantId: principalOf(req).tenantId, type: 'instance.probe', payload: { instanceId: inst.id }, createdBy: principalOf(req).userId, maxAttempts: 1 }) : null;
      await audit(req, 'instance.created', { instance: inst.id, name: inst.name, pool: pool.name }, { kind, url: inst.url, socket: inst.socket_path, deploy: inst.deploy, mtls: !!body.tls, token: token ? token.ref : null, probeJob: probe?.id ?? null });
      await g.pollOne(inst.id);
      res.status(201).json({ ...(await g.snapshot()).flatMap((p) => p.instances).find((i) => i.id === inst.id), probeJobId: probe?.id ?? null });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('An instance with that name exists in the pool.');
      throw err;
    }
  });

  /** B-10502, B-10503, B-10509: `cloud` of a `kind: openai` instance on a cloud provider's Chat Completions endpoint. */
  const cloudFlavourSchema = z
    .object({
      flavour: z.enum(['azure', 'digitalocean', 'workers-ai']),
      accountId: z.string().length(26),
      region: z.string().trim().regex(/^[a-z0-9-]{2,40}$/),
      apiVersion: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}(-preview)?$/).optional(),
      resourceId: z.string().trim().regex(/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.CognitiveServices\/accounts\/[^/]+$/i).optional(),
      auth: z.enum(['account', 'key']).optional()
    })
    .strict();
  const FLAVOUR_PROVIDER = { azure: 'azure', digitalocean: 'digitalocean', 'workers-ai': 'cloudflare' } as const;
  const flavourTarget = async (req: Request, pool: { label_ceiling: (typeof LABELS)[number]; name: string }, body: { cloud: z.infer<typeof cloudFlavourSchema>; url?: string | undefined; socketPath: string | null; tls: unknown; token?: string | undefined; tokenRef?: string | null | undefined }) => {
    const c = body.cloud;
    if (body.socketPath || body.tls) throw badRequest('A cloud endpoint has no Unix socket or mutual TLS.');
    const account = await s.cloud.accounts.getFor(principalOf(req), c.accountId);
    // B-10803: pools serve every tenant, so a tenant's own cloud account never backs one (its owner could log another tenant's prompts).
    if (account.scope === 'tenant') throw new HttpProblem(403, 'Forbidden', `${account.name} is a tenant account; gateway pools serve every tenant, so only a platform account backs a pool instance.`, { extensions: { step: 'tenant' } });
    const provider = FLAVOUR_PROVIDER[c.flavour];
    if (account.provider !== provider) throw badRequest(`${account.name} is not a ${provider} account; the ${c.flavour} flavour needs one.`);
    const ownKey = !!(body.token || body.tokenRef);
    const auth = c.auth ?? (ownKey || c.flavour === 'digitalocean' ? 'key' : 'account');
    if (auth === 'key' && !ownKey) throw badRequest(c.flavour === 'digitalocean' ? 'DigitalOcean serverless inference takes a model access key: give it as token or tokenRef.' : 'With auth key the instance needs its API key as token or tokenRef.');
    if (auth === 'account' && ownKey) throw badRequest('With auth account the instance uses the account\'s credential; give no token.');
    if (c.flavour === 'azure' && !body.url) throw badRequest('An Azure OpenAI instance gives its resource endpoint as url (https://<resource>.openai.azure.com).');
    // The pool's ceiling may not exceed the region's (B-10008), as for Bedrock.
    await s.cloud.accounts.assertRegionAllows(account, c.region, pool.label_ceiling, { use: 'models' });
    const cfAccount = account.providerIds.cloudflareAccountId;
    const url = body.url ?? (c.flavour === 'digitalocean' ? 'https://inference.do-ai.run' : `https://api.cloudflare.com/client/v4/accounts/${cfAccount ?? ''}/ai`);
    if (c.flavour === 'workers-ai' && !body.url && !cfAccount) throw badRequest(`${account.name} names no Cloudflare account id.`);
    await checkInstanceUrl(url);
    return { url, settings: { provider, accountId: account.id, region: c.region, flavour: c.flavour, auth, ...(c.apiVersion ? { apiVersion: c.apiVersion } : {}), ...(c.resourceId ? { resourceId: c.resourceId } : {}) } };
  };

  /** B-10501: `cloud` of a `kind: bedrock` instance (the AWS account and the region whose endpoint it calls). */
  const bedrockCloudSchema = z.object({ accountId: z.string().length(26), region: z.string().trim().regex(/^[a-z0-9-]{2,40}$/) }).strict();
  const bedrockTarget = async (req: Request, pool: { label_ceiling: (typeof LABELS)[number]; name: string }, body: { cloud?: { accountId: string; region: string } | undefined; url?: string | undefined; socketPath: string | null; tls: unknown; token?: string | undefined; tokenRef?: string | null | undefined }) => {
    if (!body.cloud) throw badRequest('A Bedrock instance names its AWS cloud account and region (cloud.accountId, cloud.region).');
    if (body.url || body.socketPath || body.tls) throw badRequest('A Bedrock instance has no URL, socket or mutual TLS: it calls the region\'s endpoint with the account\'s credential.');
    if (body.token || body.tokenRef) throw badRequest('A Bedrock instance signs with its cloud account\'s credential; it takes no token.');
    const account = await s.cloud.accounts.getFor(principalOf(req), body.cloud.accountId);
    // B-10803: pools serve every tenant, so a tenant's own cloud account never backs one (its owner could log another tenant's prompts).
    if (account.scope === 'tenant') throw new HttpProblem(403, 'Forbidden', `${account.name} is a tenant account; gateway pools serve every tenant, so only a platform account backs a pool instance.`, { extensions: { step: 'tenant' } });
    if (account.provider !== 'aws') throw badRequest(`${account.name} is not an AWS account; Bedrock needs one.`);
    // The pool's ceiling may not exceed the region's (B-10008): a pool for confidential data is never placed where the region refuses it.
    await s.cloud.accounts.assertRegionAllows(account, body.cloud.region, pool.label_ceiling, { use: 'models' });
    return { url: `https://bedrock-runtime.${body.cloud.region}.amazonaws.com`, settings: { provider: 'aws' as const, accountId: account.id, region: body.cloud.region } };
  };

  /**
   * B-4302: where requests go. An Ollama instance and a Chat Completions server on a port need an http(s) URL that
   * passes the egress check; a server on a Unix socket needs no URL (requests carry `http://localhost`) and no TLS.
   */
  const serverTarget = (kind: InstanceRow['kind'], url: string | undefined, socketPath: string | null, tls: unknown): string => {
    if (socketPath) {
      if (kind !== 'openai') throw badRequest('A Unix socket is for Chat Completions servers (kind openai); Ollama listens on a URL.');
      if (tls) throw badRequest('A Unix socket is local to this host: mutual TLS does not apply.');
      return 'http://localhost';
    }
    if (!url) throw badRequest('Give the server\'s URL, or for a Chat Completions server its Unix socket path.');
    if (tls && !url.startsWith('https://')) throw badRequest('Mutual TLS needs an https:// URL.');
    return url;
  };

  /** B-4302: a raw token goes into the caller's vault (shown once, never returned); a reference is checked as readable. */
  const saveToken = async (req: Request, token: string | undefined, tokenRef: string | null | undefined): Promise<{ ref: string; tenantId: string; ownerId: string } | null | undefined> => {
    const p = principalOf(req);
    if (token && tokenRef) throw badRequest('Give either a token or a vault reference, not both.');
    if (token) {
      // The token is read at use as the person who saved it, so they need secrets:read as well as the write.
      const perms = effectivePermissions(p);
      if (!perms.has('secrets:write') || !perms.has('secrets:read')) throw forbidden('Storing a server token in the vault needs secrets:write and secrets:read; or give a vault reference someone with them saved.', { step: 'role', action: 'secrets:write' });
      const c = await s.vault.callerFor(p, { ip: ip(req), traceId: req.traceId });
      const path = `model-servers/${ulid().toLowerCase()}`;
      await s.vault.write(c, path, { token }, { label: 'confidential' });
      return { ref: `vault:${path}#token`, tenantId: p.tenantId, ownerId: p.userId };
    }
    if (tokenRef === undefined) return undefined;
    if (tokenRef === null) return null;
    if (!parseVaultRef(tokenRef)) throw badRequest('A token reference looks like vault:<path>#<key>.');
    await s.vault.assertRefsReadable(p, [tokenRef], { ip: ip(req), traceId: req.traceId });
    return { ref: tokenRef, tenantId: p.tenantId, ownerId: p.userId };
  };
  const rejectToken = (token: unknown, tokenRef: unknown) => {
    if (token || tokenRef) throw badRequest('A bearer token is for Chat Completions servers (kind openai); Ollama takes mutual TLS.');
    return null;
  };

  /** B-901: link-local, metadata and unspecified addresses are refused; the poller's connections re-check at dial time. */
  const checkInstanceUrl = async (url: string) => {
    try {
      await checkServiceUrl(url, servicePolicy(s.cfg));
    } catch (err) {
      if (err instanceof ServiceUrlRefused) throw badRequest(`The instance URL is refused: ${err.message}`);
      throw err;
    }
  };

  const loadInstance = async (req: Request) => {
    const inst = await g.repo.instance(String(req.params.id));
    if (!inst) throw notFound('Instance');
    return inst;
  };

  r.patch('/instances/:id', pools, async (req, res) => {
    const inst = await loadInstance(req);
    const body = parseBody(z.object({ url: urlSchema.optional(), socketPath: socketSchema.nullable().optional(), token: tokenSchema.optional(), tokenRef: z.string().max(500).nullable().optional(), tls: tlsSchema.optional(), settings: settingsSchema.optional(), state: z.enum(['active', 'disabled']).optional() }).strict(), req.body);
    if (body.url) await checkInstanceUrl(body.url);
    const socketPath = body.socketPath === undefined ? inst.socket_path : body.socketPath;
    // A socket instance's stored URL is only the origin: dropping the socket needs a real URL.
    const nextUrl = body.url ?? (inst.socket_path ? undefined : inst.url);
    if (body.socketPath !== undefined || body.url !== undefined || body.tls !== undefined) serverTarget(inst.kind, socketPath ? undefined : nextUrl, socketPath, body.tls === undefined ? inst.tls : body.tls);
    const token = inst.kind === 'openai' ? await saveToken(req, body.token, body.tokenRef) : rejectToken(body.token, body.tokenRef);
    const patch: Parameters<typeof g.repo.updateInstance>[1] = {};
    if (body.url !== undefined) patch.url = body.url;
    if (body.socketPath !== undefined) {
      patch.socket_path = body.socketPath;
      if (body.socketPath) patch.url = 'http://localhost';
    }
    if (body.tls !== undefined) patch.tls = body.tls;
    if (body.state !== undefined) patch.state = body.state;
    // What the server reported stays with the instance when its recorded settings change.
    if (body.settings !== undefined) patch.settings = { ...body.settings, ...(inst.settings.reported ? { reported: inst.settings.reported } : {}), ...(inst.settings.cloud ? { cloud: inst.settings.cloud } : {}) };
    if (token !== undefined) Object.assign(patch, { token_ref: token?.ref ?? null, token_tenant: token?.tenantId ?? null, token_owner: token?.ownerId ?? null });
    await g.repo.updateInstance(inst.id, patch);
    await audit(req, 'instance.updated', { instance: inst.id, name: inst.name }, { after: { ...body, token: body.token ? 'stored in the vault' : undefined, tokenRef: token === undefined ? undefined : (token?.ref ?? null), tls: body.tls === undefined ? undefined : !!body.tls } });
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

  /** B-4302: asks a Chat Completions server whether tool calls and JSON schema output work (a job). */
  r.post('/instances/:id/probe', pools, async (req, res) => {
    const p = principalOf(req);
    const inst = await loadInstance(req);
    if (inst.kind !== 'openai') throw conflict(`${inst.name} is an Ollama instance; its models are evaluated one by one in the catalogue.`);
    const job = await s.jobs.enqueue({ tenantId: p.tenantId, type: 'instance.probe', payload: { instanceId: inst.id }, createdBy: p.userId, maxAttempts: 1 });
    await audit(req, 'instance.probe.started', { instance: inst.id, name: inst.name }, { job: job.id });
    res.status(202).json({ jobId: job.id });
  });

  r.post('/instances/:id/load', pools, async (req, res) => {
    const p = principalOf(req);
    const inst = await loadInstance(req);
    const body = parseBody(z.object({ model: z.string().min(1).max(200), pinned: z.boolean().default(false) }), req.body);
    const out = await g.load(inst.id, body.model, { pinned: body.pinned, actor: p.username });
    await audit(req, body.pinned ? 'model.pinned' : 'model.loaded', { instance: inst.id, name: inst.name, model: body.model }, { evicted: out.evicted, ...(out.unsupported ? { unsupported: true } : {}) });
    res.json(out);
  });

  r.post('/instances/:id/unload', pools, async (req, res) => {
    const p = principalOf(req);
    const inst = await loadInstance(req);
    const body = parseBody(z.object({ model: z.string().min(1).max(200) }), req.body);
    const out = await g.unload(inst.id, body.model, p.username);
    await audit(req, 'model.unloaded', { instance: inst.id, name: inst.name, model: body.model }, out.unsupported ? { unsupported: true } : undefined);
    res.json({ ok: true, ...(out.unsupported ? { unsupported: true } : {}) });
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
    if (isClassifierModel(model)) throw conflict(`${model.name} is served by the classifier worker, not by a pool.`);
    if (labelRank(model.label) > labelRank(pool.label_ceiling)) throw forbidden(`${model.name} is approved for ${model.label} data but ${pool.name}'s ceiling is ${pool.label_ceiling}.`, { step: 'zone' });
    await s.zones.assertAdmits(pool, model.label);
    const held = await placementRules(model, pool.id, body.residency);
    const pl = await g.repo.place(model.id, pool.id, body.residency, p.userId);
    const job = body.pull && !held ? await s.jobs.enqueue({ tenantId: p.tenantId, type: 'model.pull', payload: { modelId: model.id, poolId: pool.id }, createdBy: p.userId, maxAttempts: 1 }) : null;
    await audit(req, 'model.placed', { model: model.name, pool: pool.name }, { residency: body.residency, pullJob: job?.id ?? null });
    res.status(201).json({ ...pl, jobId: job?.id ?? null });
  });

  /**
   * B-4304: a server-held model goes only where an instance lists it; a pool with Chat Completions servers takes
   * warm placements only (the server decides what stays in memory); an Ollama model cannot be pulled onto a pool whose
   * instances are all such servers. Returns whether the model is server-held (no pull).
   */
  const placementRules = async (model: ModelRow, poolId: string, residency: string): Promise<boolean> => {
    const insts = await g.repo.instances(poolId);
    const servers = insts.filter((i) => i.kind === 'openai' || i.kind === 'bedrock');
    const held = model.format === 'server';
    if ((held || servers.length) && residency !== 'warm') throw conflict(held ? `${model.name} is held by its server, which decides what stays in memory: place it warm.` : 'This pool has Chat Completions servers, which decide what stays in memory: placements on it are warm only.');
    if (held && !(await g.listedOn(poolId, model.server_model ?? model.name)).length) throw conflict(`No instance in this pool lists ${model.server_model ?? model.name}. A server-held model is placed where its server is.`);
    if (!held && insts.length && servers.length === insts.length) throw conflict(`Every instance in this pool is a Chat Completions server, which holds its own models: ${model.name} cannot be pulled onto it.`);
    return held;
  };

  r.patch('/placements/:id', pools, async (req, res) => {
    const pl = (await g.repo.placements()).find((x) => x.id === req.params.id);
    if (!pl) throw notFound('Placement');
    const body = parseBody(z.object({ residency: z.enum(['pinned', 'warm', 'cold']) }), req.body);
    const pm = await g.repo.model(pl.model_id);
    if (pm) await placementRules(pm, pl.pool_id, body.residency);
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
    const [list, placements, pools, profiles, instances] = await Promise.all([g.repo.models(), g.repo.placements(), g.repo.pools(), s.db('profiles').select('id', 'name', 'model_id', 'tenant_id'), g.repo.instances()]);
    const people = [...new Set(list.flatMap((m) => [m.requested_by, m.approved_by]).filter((u): u is string => !!u))];
    const names = new Map((await s.db('users').whereIn('id', people).select('id', 'display_name')).map((u: { id: string; display_name: string }) => [u.id, u.display_name]));
    res.json(
      list.map((m) => ({
        ...modelView(m),
        requestedByName: m.requested_by ? (names.get(m.requested_by) ?? null) : null,
        approvedByName: m.approved_by ? (names.get(m.approved_by) ?? null) : null,
        pools: placements.filter((x) => x.model_id === m.id).map((x) => ({ placementId: x.id, poolId: x.pool_id, pool: pools.find((p) => p.id === x.pool_id)?.name, residency: x.residency })),
        profiles: profiles.filter((x: { model_id: string | null }) => x.model_id === m.id).length,
        server: m.format === 'server' ? serverOf(m, instances) : null
      }))
    );
  });

  /** B-4304: the server a held model was registered from, and what that server reported (no URL or token). */
  const serverOf = (m: ModelRow, instances: InstanceRow[]) => {
    const i = instances.find((x) => x.id === m.server_instance_id);
    const rep = i?.settings.reported ?? {};
    return { instanceId: m.server_instance_id, instance: i?.name ?? null, model: m.server_model, health: i?.health ?? null, reported: { server: rep.server ?? null, contextLength: rep.contextLength ?? null, tools: rep.tools ?? null, jsonSchema: rep.jsonSchema ?? null, embeddings: rep.embeddings ?? null, probedAt: rep.probedAt ?? null } };
  };

  /**
   * B-4304: the import picker's server-held models: every Chat Completions instance with the models it lists, which
   * are available, and which are in the catalogue already.
   */
  r.get('/model-servers', models, async (_req, res) => {
    const [list, pools, catalogue] = await Promise.all([g.serverCandidates(), g.repo.pools(), g.repo.models()]);
    res.json(
      list.map(({ instance: i, report }) => ({
        instanceId: i.id,
        instance: i.name,
        poolId: i.pool_id,
        pool: pools.find((p) => p.id === i.pool_id)?.name ?? null,
        poolCeiling: pools.find((p) => p.id === i.pool_id)?.label_ceiling ?? null,
        transport: i.socket_path ? 'socket' : 'url',
        token: !!i.token_ref,
        state: i.state,
        health: i.health,
        healthDetail: i.health_detail,
        version: i.version,
        reported: { server: report.server ?? null, contextLength: report.contextLength ?? null, tools: report.tools ?? null, jsonSchema: report.jsonSchema ?? null, embeddings: report.embeddings ?? null, probedAt: report.probedAt ?? null, probedModel: report.probedModel ?? null, probeDetail: report.probeDetail ?? null },
        models: (report.models ?? []).map((m) => {
          const c = catalogue.find((x) => x.name === m.id);
          return { id: m.id, available: m.available, reason: m.reason ?? null, ownedBy: m.ownedBy ?? null, catalogued: c ? { id: c.id, state: c.state, held: c.format === 'server' } : null };
        })
      }))
    );
  });

  /** An import request: the model is recorded as a draft and pulled onto a pool by a job. */
  r.post('/models', models, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(
      z.object({
        name: z.string().trim().regex(/^[a-zA-Z0-9][\w./:-]{0,199}$/, 'An Ollama model name such as llama3.1:8b or hf.co/org/repo:Q4_K_M').optional(),
        // B-4304: a model a Chat Completions server holds, registered from its /v1/models listing instead of pulled.
        serverInstanceId: z.string().length(26).optional(),
        serverModel: serverModelSchema.optional(),
        source: z.string().trim().min(1).max(500).default('Ollama library'),
        expectedDigest: z.string().trim().regex(/^(sha256:)?[a-f0-9]{64}$/i).nullable().default(null),
        license: z.object({ name: z.string().trim().max(200), url: z.string().url().max(500).optional(), notes: z.string().max(1000).optional() }).nullable().default(null),
        label: z.enum(LABELS).default('internal'),
        notes: z.string().trim().max(1000).nullable().default(null),
        poolId: z.string().length(26).optional()
      }),
      req.body
    );
    if (body.serverInstanceId || body.serverModel) return importHeld(req, res, body);
    if (!body.name) throw badRequest('Give the model and tag to pull, or a server and the model it holds.');
    const name = body.name;
    if (PICKLE.test(name) || PICKLE.test(body.source)) {
      await audit(req, 'model.import.refused', { model: name }, { reason: 'pickle' });
      throw new HttpProblem(422, 'Import refused', 'The source is a pickle checkpoint (.bin, .pt, .pth, .pkl, .ckpt). Only GGUF and safetensors are accepted.', { extensions: { reason: 'pickle' } });
    }
    if (!clears(p.clearance, body.label)) throw forbidden('You cannot approve a model for data above your clearance.', { step: 'clearance' });
    let m: ModelRow;
    try {
      m = await g.repo.createModel({ name, source: body.source, expectedDigest: body.expectedDigest, license: body.license?.name ? { ...body.license, recordedBy: p.username, recordedAt: Date.now() } : null, label: body.label, notes: body.notes, requestedBy: p.userId, requestedTenant: p.tenantId });
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
      await s.zones.assertAdmits(pool, m.label).catch(async (err: unknown) => {
        await s.db('models').where({ id: m.id }).delete();
        throw err;
      });
      await g.repo.place(m.id, pool.id, 'warm', p.userId);
      jobId = (await s.jobs.enqueue({ tenantId: p.tenantId, type: 'model.pull', payload: { modelId: m.id, poolId: pool.id }, createdBy: p.userId, maxAttempts: 1 })).id;
    }
    await audit(req, 'model.import.requested', { model: m.name }, { source: m.source, expectedDigest: m.expected_digest, label: m.label, pullJob: jobId });
    res.status(201).json({ ...modelView(m), jobId });
  });

  /**
   * B-4304: registers a model a Chat Completions server lists: `format` `server`, no expected digest (the server's
   * model id stands in for it), placed warm on the instance's pool, nothing pulled. The licence, the evaluation and
   * dual-control approval apply as for any model.
   */
  const importHeld = async (req: Request, res: Response, body: { serverInstanceId?: string | undefined; serverModel?: string | undefined; expectedDigest: string | null; license: { name: string; url?: string | undefined; notes?: string | undefined } | null; label: (typeof LABELS)[number]; notes: string | null; poolId?: string | undefined }) => {
    const p = principalOf(req);
    if (!body.serverInstanceId || !body.serverModel) throw badRequest('Give both the server instance and the model id it lists.');
    if (body.expectedDigest) throw badRequest('A server-held model has no digest to pin: the server reports its model id instead.');
    const inst = await g.repo.instance(body.serverInstanceId);
    if (!inst) throw notFound('Instance');
    if (inst.kind !== 'openai') throw conflict(`${inst.name} is an Ollama instance; request an import by name to pull onto it.`);
    if (body.poolId && body.poolId !== inst.pool_id) throw badRequest('A server-held model is placed on its server\'s pool.');
    const modelId = body.serverModel;
    if (PICKLE.test(modelId)) {
      await audit(req, 'model.import.refused', { model: modelId }, { reason: 'pickle', server: inst.name });
      throw new HttpProblem(422, 'Import refused', 'The model id names a pickle checkpoint (.bin, .pt, .pth, .pkl, .ckpt). Only GGUF and safetensors are accepted.', { extensions: { reason: 'pickle' } });
    }
    if (!clears(p.clearance, body.label)) throw forbidden('You cannot approve a model for data above your clearance.', { step: 'clearance' });
    const candidates = (await g.serverCandidates()).find((c) => c.instance.id === inst.id);
    const listed = candidates?.report.models?.find((m) => m.id === modelId);
    if (!listed) throw conflict(`${inst.name} does not list ${modelId}. Check the server's /v1/models.`);
    if (!listed.available) throw conflict(`${inst.name} lists ${modelId} as unavailable: ${listed.reason ?? 'the server refuses it'}.`);
    const pool = await g.repo.pool(inst.pool_id);
    if (!pool) throw notFound('Pool');
    if (labelRank(body.label) > labelRank(pool.label_ceiling)) throw forbidden(`${modelId} is labelled ${body.label} but ${pool.name}'s ceiling is ${pool.label_ceiling}.`, { step: 'zone' });
    await s.zones.assertAdmits(pool, body.label);
    const report = candidates!.report;
    const caps = /embed/i.test(modelId) ? ['embedding'] : ['completion', ...(report.tools ? ['tools'] : [])];
    let m: ModelRow;
    try {
      m = await g.repo.createModel({ name: modelId, source: `server:${inst.name}/${modelId}`, expectedDigest: null, license: body.license?.name ? { ...body.license, recordedBy: p.username, recordedAt: Date.now() } : null, label: body.label, notes: body.notes, requestedBy: p.userId, requestedTenant: p.tenantId, server: { instanceId: inst.id, model: modelId, capabilities: caps, contextLength: report.contextLength ?? null, family: listed.ownedBy ?? null } });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('That model is already in the catalogue.');
      throw err;
    }
    await g.repo.place(m.id, pool.id, 'warm', p.userId);
    await audit(req, 'model.import.requested', { model: m.name }, { source: m.source, format: 'server', server: inst.name, serverModel: modelId, expectedDigest: null, label: m.label, pool: pool.name, pullJob: null });
    res.status(201).json({ ...modelView(m), jobId: null });
  };

  const loadModel = async (req: Request) => {
    const m = await g.repo.model(String(req.params.id));
    if (!m) throw notFound('Model');
    return m;
  };

  // B-11707: how a model is made to think. `mode: null` forgets what was recorded: the manifest decides again.
  const thinkingBody = z
    .object({
      mode: z.enum(['native', 'template', 'none']).nullable(),
      // A built-in template by id, or a custom one. Tags are short and plain, so they cannot swallow an answer.
      template: z
        .union([
          z.string().trim().min(1).max(60),
          z.object({ system: z.string().max(8000).default(''), open: z.string().min(2).max(40).regex(/^\S+$/), close: z.string().min(2).max(40).regex(/^\S+$/), startsOpen: z.boolean().optional() }).strict()
        ])
        .nullable()
        .optional()
    })
    .strict();
  const thinkingPatch = (m: ModelRow, t: z.infer<typeof thinkingBody>): Partial<ModelRow> => {
    if (m.capabilities.includes('embedding') && !m.capabilities.includes('completion') && t.mode && t.mode !== 'none') throw conflict(`${m.name} is an embedding model; it does not think.`);
    if (t.mode !== 'template') {
      if (t.template) throw badRequest('A template goes with the mode template.');
      // Forgetting a template leaves the manifest's word: `thinking` in the stored list came from the template.
      const forget = t.mode === null && m.thinking_mode === 'template';
      return { thinking_mode: t.mode, thinking_template: null, ...(forget ? { capabilities: m.capabilities.filter((c) => c !== 'thinking') } : {}) };
    }
    if (!t.template) throw badRequest('Choose the template the model follows.');
    let stored: StoredTemplate;
    if (typeof t.template === 'string') {
      if (!THINKING_TEMPLATES[t.template]) throw badRequest(`${t.template} is not a built-in thinking template (${Object.keys(THINKING_TEMPLATES).join(', ')}).`);
      stored = { id: t.template };
    } else {
      if (t.template.open === t.template.close) throw badRequest('The opening and closing tags must differ.');
      stored = { system: t.template.system, open: t.template.open, close: t.template.close, ...(t.template.startsOpen ? { startsOpen: true } : {}) };
    }
    if (!resolveTemplate(stored)) throw badRequest('The template is not usable.');
    return { thinking_mode: 'template', thinking_template: stored };
  };

  r.get('/models/thinking-templates', readModels, (_req, res) => {
    res.json(Object.values(THINKING_TEMPLATES).map((t) => ({ id: t.id, name: t.name, system: t.system, open: t.open, close: t.close, startsOpen: !!t.startsOpen })));
  });

  r.patch('/models/:id', models, async (req, res) => {
    const p = principalOf(req);
    const m = await loadModel(req);
    const body = parseBody(z.object({ license: z.object({ name: z.string().trim().min(1).max(200), url: z.string().url().max(500).optional(), notes: z.string().max(1000).optional() }).optional(), label: z.enum(LABELS).optional(), notes: z.string().trim().max(1000).nullable().optional(), thinking: thinkingBody.optional() }).strict(), req.body);
    if (m.state === 'retired') throw conflict('A retired model is read-only.');
    const thinking = body.thinking ? thinkingPatch(m, body.thinking) : {};
    if (body.label && !clears(p.clearance, body.label)) throw forbidden('You cannot approve a model for data above your clearance.', { step: 'clearance' });
    if (body.label && m.state === 'approved' && labelRank(body.label) > labelRank(m.label)) throw conflict('Raising the label of an approved model needs a new approval: deprecate and re-import, or lower it.');
    // B-10504: a cloud model is never labelled above its entry's ceiling (its regions, the account's data terms).
    if (body.label && labelRank(body.label) > labelRank(m.label)) await s.cloud.modelImport.assertEntryAllows(m, body.label);
    await g.repo.updateModel(m.id, { ...(body.license ? { license: { ...body.license, recordedBy: p.username, recordedAt: Date.now() } } : {}), ...(body.label ? { label: body.label } : {}), ...(body.notes !== undefined ? { notes: body.notes } : {}), ...thinking });
    await audit(req, 'model.updated', { model: m.name }, { after: body.thinking ? { ...body, thinking: { mode: body.thinking.mode, template: typeof body.thinking.template === 'string' ? body.thinking.template : body.thinking.template ? 'custom' : null } } : body });
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
    if (isClassifierModel(m)) throw conflict(`${m.name} is served by the classifier worker, not by a pool: there is nothing to pull.`);
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
      // B-10504: a cloud model is approved only within its region's ceiling, and only while its routing regions admit its label.
      await s.cloud.modelImport.assertEntryAllows(m, m.label);
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
  const capNames = z.array(z.string().trim().min(1).max(200)).max(200);
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
    // B-6901: datamark untrusted content for this profile's model (on by default)
    trustMarking: z.boolean(),
    // B-9901: the response cache, off unless a TTL is given (at most 30 days); lenient also caches tool, attachment and warm turns
    cacheTtlSeconds: z.number().int().min(0).max(30 * 86_400).nullable(),
    cacheLenient: z.boolean(),
    // B-4001: what a person may call from a conversation on this profile; a kind left out is not restricted
    chatCapabilities: z
      .object({ tools: capNames, agents: capNames, skills: capNames, workflows: capNames })
      .partial()
      .strict()
      .nullable(),
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
        model: m ? { id: m.id, name: m.name, state: m.state, label: m.label, capabilities: m.capabilities, digest: m.digest, thinking: (({ mode, recorded, template }) => ({ mode, recorded, template: template ? { id: template.id, name: template.name } : null }))(thinkingOf(m)) } : null,
        pool: p.pool_id ? (poolsList.find((x) => x.id === p.pool_id)?.name ?? null) : null,
        canaryModel: p.canary ? (modelsList.find((x) => x.id === p.canary!.modelId)?.name ?? null) : null,
        residency: residency(m?.name, p.pool_id)
      };
    });
  };

  r.get('/profiles', profiles, async (req, res) => {
    res.json(await listProfiles(principalOf(req).tenantId));
  });

  // ---------- default profile of the tenant and its workspaces (2.0.0, gateway/profile-preferences.ts) ----------

  r.get('/profile-defaults', profiles, async (req, res) => {
    const t = principalOf(req).tenantId;
    const [tenant, rows, spaces] = await Promise.all([s.profilePreferences.get(t, 'tenant', t), s.profilePreferences.workspaces(t), s.tenants.workspaces(t)]);
    res.json({
      tenant: { defaultProfile: tenant.defaultProfile, enforced: tenant.enforced, updatedAt: tenant.updatedAt },
      workspaces: spaces.map((w) => {
        const row = rows.find((x) => x.scopeId === w.id);
        return { id: w.id, name: w.name, defaultProfile: row?.defaultProfile ?? null, enforced: row?.enforced ?? false, updatedAt: row?.updatedAt ?? null };
      })
    });
  });

  const defaultBody = z.object({ defaultProfile: z.string().trim().min(1).max(63).nullable(), enforced: z.boolean().default(false) });
  const setDefault = async (req: Request, scope: 'tenant' | 'workspace', scopeId: string) => {
    const p = principalOf(req);
    const body = parseBody(defaultBody, req.body);
    if (body.defaultProfile && !(await g.repo.profiles(p.tenantId)).some((x) => x.name === body.defaultProfile && x.status === 'published')) throw badRequest(`${body.defaultProfile} is not a published profile.`);
    const { before, after } = await s.profilePreferences.set(p.tenantId, scope, scopeId, { defaultProfile: body.defaultProfile, enforced: !!body.defaultProfile && body.enforced }, p.userId);
    await audit(req, 'profile.default.updated', { scope, [scope]: scopeId }, { before: { defaultProfile: before.defaultProfile, enforced: before.enforced }, after: { defaultProfile: after.defaultProfile, enforced: after.enforced } });
    return { defaultProfile: after.defaultProfile, enforced: after.enforced, updatedAt: after.updatedAt };
  };

  r.put('/profile-defaults/tenant', profiles, async (req, res) => {
    res.json(await setDefault(req, 'tenant', principalOf(req).tenantId));
  });

  r.put('/profile-defaults/workspaces/:id', profiles, async (req, res) => {
    const t = principalOf(req).tenantId;
    const id = String(req.params.id);
    if (!(await s.tenants.workspaces(t, { includeArchived: true })).some((w) => w.id === id)) throw notFound('No such workspace.');
    res.json(await setDefault(req, 'workspace', id));
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
    const ceilings = await Promise.all(reachable.map((x) => s.zones.poolCeiling(x)));
    if (!ceilings.some((c) => labelRank(c) >= labelRank(p.label))) throw conflict(`No pool running ${m.name} is cleared for ${p.label} data.`);
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
    // B-11707: a profile inherits how its model thinks. On a model whose catalogue entry records that it thinks
    // (natively or by a template), a profile created without thinking levels thinks; saying `off` still switches it off.
    const inherits = !body.aliasOf && body.modelId ? await g.repo.model(body.modelId) : undefined;
    const thinks = inherits ? thinkingOf(inherits) : null;
    const inherited = !!thinks?.recorded && thinks.mode !== 'none';
    const ceiling: ThinkLevel = body.thinkCeiling ?? (inherited ? 'high' : 'off');
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
      think_default: body.thinkDefault ?? (inherited ? (thinkRank(ceiling) < thinkRank('medium') ? ceiling : 'medium') : 'off'),
      think_ceiling: ceiling,
      system_prompt: body.systemPrompt ?? null,
      fallback: body.fallback ?? null,
      canary: null,
      tools: body.tools ?? [],
      trust_marking: body.trustMarking ?? true,
      chat_capabilities: body.chatCapabilities ?? null,
      cache_ttl_seconds: body.cacheTtlSeconds || null,
      cache_lenient: body.cacheLenient ?? false,
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
    // Sprint 21 (B-1303): a version whose gated evaluations have not passed for its settings is not published.
    await s.evals.gate(p.tenantId, before, next);
    // 1.6.0 (B-7001): and the red-team gate, which no evaluation override opens.
    await s.redteam.gateProfile(p.tenantId, before, next);
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
    const map: [keyof typeof body, keyof ProfileRow][] = [['displayName', 'display_name'], ['description', 'description'], ['modelId', 'model_id'], ['poolId', 'pool_id'], ['numCtx', 'num_ctx'], ['temperature', 'temperature'], ['thinkDefault', 'think_default'], ['thinkCeiling', 'think_ceiling'], ['systemPrompt', 'system_prompt'], ['fallback', 'fallback'], ['tools', 'tools'], ['trustMarking', 'trust_marking'], ['chatCapabilities', 'chat_capabilities'], ['cacheTtlSeconds', 'cache_ttl_seconds'], ['cacheLenient', 'cache_lenient'], ['label', 'label'], ['aliasOf', 'alias_of']];
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

  // Sprint 21 (B-1303): evaluations of a profile.
  r.use(evalRoutes(s));
  return r;
}
