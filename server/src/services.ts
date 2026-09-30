import type { Logger } from 'pino';
import type { Config } from './config/index.js';
import type { Db } from './db/knex.js';
import { AuditLog } from './audit/chain.js';
import { AuditCheckpoints } from './audit/checkpoints.js';
import { ExportService } from './audit/exports.js';
import { SiemForwarder } from './audit/siem.js';
import { IdentityChain } from './identity/chain.js';
import { SessionService } from './identity/sessions.js';
import { ApiKeyService } from './identity/apikeys.js';
import { MfaService } from './identity/mfa.js';
import { LoginThrottle } from './identity/lockout.js';
import { DirectorySync } from './identity/sync.js';
import { ProviderRepo } from './repos/providers.js';
import { TenantRepo } from './repos/tenants.js';
import { UserRepo } from './repos/users.js';
import { Metrics } from './observability/index.js';
import { createKms, type Kms } from './platform/kms.js';
import { DataKeys, PLATFORM_SCOPE } from './platform/datakeys.js';
import { createBlobStore, type BlobStore } from './platform/blob.js';
import { Bus, TOPICS } from './platform/bus.js';
import { JobQueue, Scheduler } from './platform/jobs.js';
import { Notifications } from './platform/notifications.js';
import { QuotaService } from './tenancy/quotas.js';
import { Offboarding } from './tenancy/offboarding.js';
import { Gateway } from './gateway/gateway.js';
import { GatewayRepo } from './gateway/repo.js';
import { AttachmentService } from './chat/attachments.js';
import { CalcWorker } from './chat/calc.js';
import { ChatService } from './chat/service.js';
import type { Guardrails } from './guardrails/types.js';
import { createGuardrails, type GuardrailModule } from './guardrails/index.js';
import { RegistryService } from './registry/service.js';
import { ToolDispatcher } from './registry/dispatch.js';
import { McpService } from './mcp/service.js';
import { ScriptService } from './scripts/service.js';
import { createScriptRunner } from './scripts/runner.js';
import { AgentService } from './agents/service.js';
import { loadPrincipal } from './http/middleware.js';
import { WorkflowService } from './workflows/service.js';
import { MediaService } from './media/service.js';
import { FfmpegRunner, type MediaRunner } from './media/runner.js';
import { ImageService } from './images/service.js';
import { createBackends, type ImageBackend } from './images/backends.js';
import { HttpSafety, noSafety, type ImageSafety } from './images/safety.js';
import { createVectorStore, LazyVectorStore, type VectorStore } from './platform/vectors.js';
import { ConnectionService } from './connections/service.js';
import { defaultDrivers, type DriverFactory } from './connections/drivers.js';
import { KnowledgeService } from './knowledge/service.js';
import { CliGit, type GitFetcher } from './knowledge/sources.js';
import { MemoryService } from './memory/service.js';
import { effectivePermissions } from './authz/policy.js';

export interface Services {
  cfg: Config;
  db: Db;
  log: Logger;
  metrics: Metrics;
  bus: Bus;
  kms: Kms;
  keys: DataKeys;
  blobs: BlobStore;
  jobs: JobQueue;
  scheduler: Scheduler;
  notifications: Notifications;
  audit: AuditLog;
  checkpoints: AuditCheckpoints;
  exports: ExportService;
  siem: SiemForwarder;
  tenants: TenantRepo;
  users: UserRepo;
  providers: ProviderRepo;
  chain: IdentityChain;
  sessions: SessionService;
  apiKeys: ApiKeyService;
  mfa: MfaService;
  throttle: LoginThrottle;
  sync: DirectorySync;
  quotas: QuotaService;
  offboarding: Offboarding;
  gateway: Gateway;
  attachments: AttachmentService;
  calc: CalcWorker;
  chat: ChatService;
  /** The guardrail checkpoints (`guardrails/types.ts`); every feature that handles tenant text calls `check`. */
  guardrails: Guardrails;
  /** Rule sets, flags and classifiers behind the checkpoints (Sprint 5). */
  guard: GuardrailModule;
  /** Sprint 7: the registry, MCP servers, the tool dispatcher (chat, agents, test harness), scripts and agent runs. */
  registry: RegistryService;
  mcp: McpService;
  scripts: ScriptService;
  tools: ToolDispatcher;
  agents: AgentService;
  /** Workflow graphs, versions and durable runs (Sprint 8). */
  workflows: WorkflowService;
  /** Media assets, presets and ffmpeg jobs (Sprint 8). */
  media: MediaService;
  /** Image generation on ComfyUI or diffusers workers (Sprint 8). */
  images: ImageService;
  /** The image-safety classifier for generated images and sampled video frames. */
  imageSafety: ImageSafety;
  /** Vectors for retrieval: pgvector on PostgreSQL with the extension, else a table scan (`platform/vectors.ts`). */
  vectors: VectorStore;
  connections: ConnectionService;
  knowledge: KnowledgeService;
  memory: MemoryService;
  /** Stops background work and closes connections (Redis, SMTP, identity stores). */
  close(): Promise<void>;
}

export interface ServiceOverrides {
  kms?: Kms;
  blobs?: BlobStore;
  mediaRunner?: MediaRunner;
  imageBackends?: ImageBackend[];
  imageSafety?: ImageSafety;
  vectors?: VectorStore;
  /** Data connection drivers by engine (tests use in-process fakes). */
  drivers?: Partial<Record<'postgres' | 'opensearch', DriverFactory>>;
  git?: GitFetcher;
}

export function createServices(cfg: Config, db: Db, log: Logger, metrics = new Metrics(), overrides: ServiceOverrides = {}): Services {
  const bus = new Bus(log, cfg.REDIS_URL);
  const kms = overrides.kms ?? createKms(cfg);
  const keys = new DataKeys(db, kms, cfg.OPENBAO_KEY_PREFIX, cfg.DATA_KEY, bus);
  const blobs = overrides.blobs ?? createBlobStore(cfg);
  const mode = cfg.JOB_QUEUE === 'auto' ? (cfg.REDIS_URL ? 'bullmq' : 'db') : cfg.JOB_QUEUE;
  const jobs = new JobQueue(db, log, bus, { mode, redisUrl: cfg.REDIS_URL, pollMs: cfg.JOB_POLL_MS, concurrency: cfg.JOB_CONCURRENCY });
  const scheduler = new Scheduler(jobs, log);
  const audit = new AuditLog(db);
  const providers = new ProviderRepo(db);
  const users = new UserRepo(db);
  const tenants = new TenantRepo(db);
  const notifications = new Notifications(db, bus, log, { smtpUrl: cfg.SMTP_URL, from: cfg.SMTP_FROM, publicUrl: cfg.PUBLIC_URL });
  const chain = new IdentityChain(db, providers, log, cfg.NODE_ENV === 'production');
  const sessions = new SessionService(
    db,
    { secret: cfg.SESSION_SECRET, idleMinutes: cfg.SESSION_IDLE_MINUTES, absoluteHours: cfg.SESSION_ABSOLUTE_HOURS, pendingMinutes: cfg.MFA_PENDING_MINUTES },
    (ids) => bus.publish(TOPICS.sessionsRevoked, ids)
  );
  const apiKeys = new ApiKeyService(db, cfg.SESSION_SECRET);
  const siem = new SiemForwarder(audit, log, { url: cfg.SIEM_URL, token: cfg.SIEM_TOKEN });
  const quotas = new QuotaService(db);
  const gateway = new Gateway(new GatewayRepo(db), bus, log, { pollMs: cfg.OLLAMA_POLL_MS, timeoutMs: cfg.OLLAMA_TIMEOUT_MS, maxInflight: cfg.OLLAMA_MAX_INFLIGHT, maxLoadsPer10Min: cfg.OLLAMA_MAX_LOADS_PER_10_MIN, queueTimeoutMs: cfg.OLLAMA_QUEUE_TIMEOUT_MS }, jobs);
  const attachments = new AttachmentService(db, blobs, keys, jobs, bus, { maxBytes: cfg.ATTACHMENT_MAX_BYTES, ...(cfg.CLAMD_HOST ? { clamd: { host: cfg.CLAMD_HOST, port: cfg.CLAMD_PORT } } : {}) });
  const calc = new CalcWorker();
  const guard = createGuardrails({ db, keys, gateway, bus, notifications, jobs, log });
  const chat = new ChatService(db, keys, gateway, quotas, audit, bus, attachments, calc, log, guard.engine);
  const registry = new RegistryService(db);
  const mcp = new McpService(db, keys, registry, audit, notifications, log, { allowedHosts: cfg.MCP_ALLOWED_HOSTS, timeoutMs: cfg.MCP_TIMEOUT_MS });
  const scripts = new ScriptService(db, keys, jobs, bus, registry, () => s.guardrails, createScriptRunner(cfg), log);
  const tools = new ToolDispatcher(registry, mcp, scripts, calc, () => s.guardrails);
  chat.useTools(tools);
  const agents = new AgentService(db, keys, gateway, registry, tools, quotas, audit, bus, jobs, notifications, async (tenantId, userId, workspaceId) => {
    const p = await loadPrincipal(s, tenantId, userId, {});
    if (p) p.workspaceId = workspaceId;
    return p;
  }, log);
  // Sprint 8 services read the guardrails and the safety classifier through `s`, so a later replacement is used.
  const workflows = new WorkflowService({ db, keys, gateway, quotas, audit, bus, jobs, notifications, calc, registry, tools, log, guardrails: () => s.guardrails, principalFor: (t, u) => loadPrincipal(s, t, u, {}), http: { hosts: cfg.WORKFLOW_HTTP_HOSTS.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean), allowLoopback: cfg.WORKFLOW_HTTP_ALLOW_LOOPBACK } });
  tools.useWorkflows(workflows);
  const media = new MediaService({
    db, keys, blobs, jobs, bus, audit, quotas, notifications, log,
    runner: overrides.mediaRunner ?? new FfmpegRunner({ ffmpeg: cfg.MEDIA_FFMPEG, ffprobe: cfg.MEDIA_FFPROBE, ...(cfg.MEDIA_WHISPER_BIN ? { whisper: cfg.MEDIA_WHISPER_BIN } : {}) }),
    safety: () => s.imageSafety,
    safetyThreshold: cfg.IMAGE_SAFETY_THRESHOLD,
    guardrails: () => s.guardrails,
    caps: { maxBytes: cfg.MEDIA_MAX_BYTES, maxDurationMs: cfg.MEDIA_MAX_DURATION_S * 1000, maxWidth: cfg.MEDIA_MAX_WIDTH, maxHeight: cfg.MEDIA_MAX_HEIGHT, maxStreams: cfg.MEDIA_MAX_STREAMS },
    encoder: cfg.MEDIA_ENCODER,
    ...(cfg.MEDIA_WORK_DIR ? { workDir: cfg.MEDIA_WORK_DIR } : {}),
    ...(cfg.MEDIA_WHISPER_BIN && cfg.MEDIA_WHISPER_MODEL ? { whisper: { bin: cfg.MEDIA_WHISPER_BIN, model: cfg.MEDIA_WHISPER_MODEL } } : {})
  });
  const images = new ImageService({ db, keys, blobs, jobs, bus, kms, audit, quotas, notifications, log, backends: overrides.imageBackends ?? createBackends(cfg.IMAGE_BACKENDS), safety: () => s.imageSafety, safetyThreshold: cfg.IMAGE_SAFETY_THRESHOLD, guardrails: () => s.guardrails, provenanceKey: `${cfg.OPENBAO_KEY_PREFIX}image-provenance` });
  // Checkpoints go through whatever `s.guardrails` is when they run.
  const checkpoint: Guardrails = { check: (input) => s.guardrails.check(input) };
  const vectors = overrides.vectors ?? new LazyVectorStore(() => createVectorStore(db, cfg.DB_CLIENT, log));
  const connections = new ConnectionService(db, keys, audit, checkpoint, { ...defaultDrivers, ...overrides.drivers });
  const knowledge = new KnowledgeService(
    { db, keys, blobs, jobs, gateway, vectors, audit, quotas, guard: checkpoint, connections, log, workspaces: async (p) => (effectivePermissions(p).has('tenant:manage') ? await tenants.workspaces(p.tenantId) : await tenants.workspacesForUser(p.tenantId, p.userId)).map((w) => w.id) },
    {
      maxBytes: cfg.ATTACHMENT_MAX_BYTES,
      ...(cfg.CLAMD_HOST ? { clamd: { host: cfg.CLAMD_HOST, port: cfg.CLAMD_PORT } } : {}),
      ...(cfg.S3_ENDPOINT && cfg.S3_ACCESS_KEY_ID && cfg.S3_SECRET_ACCESS_KEY ? { s3: { endpoint: cfg.S3_ENDPOINT, region: cfg.S3_REGION, accessKeyId: cfg.S3_ACCESS_KEY_ID, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY, pathStyle: cfg.S3_FORCE_PATH_STYLE } } : {}),
      git: overrides.git ?? new CliGit({ allowFile: false, timeoutMs: 5 * 60_000 })
    }
  );
  const memory = new MemoryService({ db, keys, blobs, jobs, gateway, vectors, audit, guard: checkpoint, terms: knowledge.terms, log, embed: (t, m, x, l, u) => knowledge.embed(t, m, x, l, u) });
  chat.contextProviders.push((r) => knowledge.contextFor(r), (r) => memory.contextFor(r));
  agents.memories = (p, agent, label) => memory.forAgent(p, agent, label);
  chat.answerListeners.push((e) => memory.onAnswer(e));
  const s: Services = {
    cfg,
    db,
    log,
    metrics,
    bus,
    kms,
    keys,
    blobs,
    jobs,
    scheduler,
    notifications,
    audit,
    checkpoints: new AuditCheckpoints(db, audit, kms, blobs, `${cfg.OPENBAO_KEY_PREFIX}audit-checkpoints`),
    exports: new ExportService(db, audit, blobs, keys, jobs),
    siem,
    tenants,
    users,
    providers,
    chain,
    sessions,
    apiKeys,
    mfa: new MfaService(db, keys.sealer(PLATFORM_SCOPE), { issuer: 'Exprsn-AI', rpId: cfg.WEBAUTHN_RP_ID, rpName: cfg.WEBAUTHN_RP_NAME, origin: cfg.ORIGIN, secret: cfg.SESSION_SECRET }),
    throttle: new LoginThrottle(db, { maxAttempts: cfg.LOCKOUT_MAX_ATTEMPTS, windowMinutes: cfg.LOCKOUT_WINDOW_MINUTES, durationMinutes: cfg.LOCKOUT_DURATION_MINUTES }),
    sync: new DirectorySync(db, providers, users, chain, sessions, apiKeys, audit, notifications, log),
    quotas,
    offboarding: new Offboarding(db, keys, blobs, jobs),
    gateway,
    attachments,
    calc,
    chat,
    guardrails: guard.engine,
    guard,
    registry,
    mcp,
    scripts,
    tools,
    agents,
    workflows,
    media,
    images,
    imageSafety: overrides.imageSafety ?? (cfg.IMAGE_SAFETY_URL ? new HttpSafety(cfg.IMAGE_SAFETY_URL) : noSafety),
    vectors,
    connections,
    knowledge,
    memory,
    close: async () => {
      scheduler.stop();
      chat.close();
      await gateway.stop();
      await calc.close();
      siem.close();
      await jobs.stop();
      await chain.close();
      await mcp.close();
      await bus.close();
    }
  };
  registerPlatformJobs(s);
  scripts.registerJobs();
  agents.registerJobs();
  jobs.register('mcp.poll', async (p, ctx) => mcp.pollTenant(String(p.tenantId ?? ctx.job.tenant_id), ctx.progress, ctx.signal));
  return s;
}

/** Job handlers for the platform's own recurring work. */
function registerPlatformJobs(s: Services): void {
  s.jobs.register('directory.sync', async (p, ctx) => {
    const tenantId = String(p.tenantId ?? ctx.job.tenant_id);
    if (p.providerId) {
      const row = await s.providers.get(tenantId, String(p.providerId));
      return row ? [await s.sync.syncProvider(row)] : [];
    }
    return s.sync.syncTenant(tenantId, ctx.progress);
  });

  s.jobs.register('audit.checkpoint', async (p, ctx) => {
    const c = await s.checkpoints.create(String(p.tenantId ?? ctx.job.tenant_id), 'scheduler');
    return c ? { seq: c.seq, hash: c.hash } : { skipped: 'head already checkpointed' };
  });
}

/** Recurring schedules: directory sync and audit checkpoints for every active tenant. */
export function startSchedules(s: Services): void {
  const activeTenants = async () => (await s.tenants.list()).filter((t) => t.state === 'active').map((t) => ({ tenantId: t.id, payload: { tenantId: t.id } }));
  s.scheduler.every('directory.sync', s.cfg.DIRECTORY_SYNC_MINUTES * 60_000, activeTenants);
  s.scheduler.every('audit.checkpoint', s.cfg.AUDIT_CHECKPOINT_MINUTES * 60_000, activeTenants);
  s.scheduler.every('guardrails.sweep', 2 * 60_000, activeTenants);
  s.scheduler.every('mcp.poll', s.cfg.MCP_POLL_MINUTES * 60_000, activeTenants);
  s.scheduler.every('knowledge.sync-due', 5 * 60_000, activeTenants);
  s.scheduler.every('memory.purge', 60 * 60_000, activeTenants);
}
