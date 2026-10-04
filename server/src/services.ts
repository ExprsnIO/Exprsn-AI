import type { Logger } from 'pino';
import { FILE_VARS, SERVER_ENV_NAMES, type Config } from './config/index.js';
import type { Db } from './db/knex.js';
import { AuditLog } from './audit/chain.js';
import { AuditCheckpoints } from './audit/checkpoints.js';
import { ExportService } from './audit/exports.js';
import { SiemForwarder } from './audit/siem.js';
import { DenialAudit } from './audit/denials.js';
import { IdentityChain } from './identity/chain.js';
import { configureSecretPolicy, secretPolicy } from './identity/secrets.js';
import { parseAllowList } from './mcp/hosts.js';
import { servicePolicy } from './platform/egress.js';
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
import { Bus, TOPICS, type MembershipEvent } from './platform/bus.js';
import { JobQueue, Scheduler } from './platform/jobs.js';
import { Notifications, type MailTransport } from './platform/notifications.js';
import { AccountService } from './identity/account.js';
import { QuotaService } from './tenancy/quotas.js';
import { Offboarding } from './tenancy/offboarding.js';
import { Gateway } from './gateway/gateway.js';
import { GatewayRepo } from './gateway/repo.js';
import { AttachmentService } from './chat/attachments.js';
import { CalcWorker } from './chat/calc.js';
import { ChatService } from './chat/service.js';
import { DbStreamStore, RedisStreamStore } from './chat/streams.js';
import type { Guardrails } from './guardrails/types.js';
import { createGuardrails, type GuardrailModule } from './guardrails/index.js';
import { RegistryService } from './registry/service.js';
import { ToolDispatcher } from './registry/dispatch.js';
import { McpService } from './mcp/service.js';
import { ScriptService } from './scripts/service.js';
import { createScriptRunner } from './scripts/runner.js';
import { AgentService } from './agents/service.js';
import { AgentSchedules } from './agents/schedules.js';
import { EvalService } from './evals/service.js';
import { loadPrincipal } from './http/middleware.js';
import { WorkflowService } from './workflows/service.js';
import { MediaService } from './media/service.js';
import { FfmpegRunner, type MediaRunner } from './media/runner.js';
import { ImageService } from './images/service.js';
import { createBackends, type ImageBackend } from './images/backends.js';
import { HttpSafety, noSafety, type ImageSafety } from './images/safety.js';
import { createVectorStore, LazyVectorStore, type VectorStore } from './platform/vectors.js';
import { ConnectionService } from './connections/service.js';
import { createDrivers, type DriverFactory } from './connections/drivers.js';
import { createDynamicCredentials, type DynamicCredentials } from './connections/dynamic.js';
import { KnowledgeService } from './knowledge/service.js';
import { CliGit, type GitFetcher } from './knowledge/sources.js';
import { MemoryService } from './memory/service.js';
import { effectivePermissions } from './authz/policy.js';
import { TrainingService } from './training/service.js';
import { createTrainer, type TrainerBackend } from './training/trainer.js';
import { ZoneService } from './zones/service.js';
import { OpsService } from './ops/service.js';
import { createAcme, type AcmeClient } from './ops/acme.js';
import { FederationService } from './federation/service.js';
import { createKerberos, type KerberosVerifier } from './federation/kerberos.js';
import { TenantIntegrations } from './integrations/hosts.js';
import { WebhookService } from './webhooks/service.js';
import { PromptService } from './prompts/service.js';
import { ConversationSharing } from './chat/sharing.js';
import { BillingService } from './billing/service.js';
import { StripeProvider, type BillingProvider } from './billing/stripe.js';
import { OpenAiService } from './openai/service.js';
import { createCounterStore, type CounterStore } from './platform/ratelimit.js';
import { EventCatalogue } from './events/catalogue.js';
import { createCacheStore, TenantCache } from './platform/cache.js';
import { RoomRegistry } from './realtime/rooms.js';
import { PluginService } from './plugins/service.js';
import { PluginRuntime } from './plugins/runtime.js';
import { CheckLimiter } from './guardrails/stream.js';
import { createPreviousKms, withPrevious } from './platform/rewrap.js';
import { instrumentKnex, parseOtlpHeaders, SpanKind, Tracer, tracesUrl, withSpan } from './observability/tracing.js';
import { registerOpsMetrics } from './observability/ops-metrics.js';
import { SchemaGuard } from './db/schema.js';
import { ZoneCluster } from './zones/cluster.js';
import { VaultService } from './vault/service.js';
import { DatabaseLeases } from './vault/leases.js';
import { createDbAdmins, type DbAdminFactory } from './vault/db-engines.js';
import { RotationNotices } from './vault/rotation.js';
import { PkiService } from './pki/service.js';
import { AtprotoService } from './atproto/service.js';
import { ModerationService } from './moderation/service.js';
import type { ModerationProviderClient } from './moderation/providers.js';

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
  /** Authorisation denials, capped per principal so they cannot flood the chain. */
  denials: DenialAudit;
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
  /** Sprint 9: datasets, training jobs, windows, evals and packaging. */
  training: TrainingService;
  trainer: TrainerBackend;
  /** Sprint 9: network zones, ceilings, proposals and rendered configuration. */
  zones: ZoneService;
  /** Sprint 9: import bundles, mirrors, ACME certificates, backups and restore drills. */
  ops: OpsService;
  acme: AcmeClient;
  /** Sprint 9: OIDC provider, SAML IdP, upstream federation, Kerberos SPNEGO and device flow. */
  federation: FederationService;
  kerberos: KerberosVerifier;
  account: AccountService;
  /** Sprint 13: per-tenant integration settings (outbound host allow-list, price book, billing customer). */
  integrations: TenantIntegrations;
  /** Sprint 13: outbound webhooks, signed deliveries as jobs with retries and a circuit breaker. */
  webhooks: WebhookService;
  /** Sprint 13: the prompt library. */
  prompts: PromptService;
  /** Sprint 13: conversation shares and exports. */
  sharing: ConversationSharing;
  /** Sprint 13: price books and monthly statements from the usage meter. */
  billing: BillingService;
  /** Sprint 13: the OpenAI-compatible API behind /v1. */
  openai: OpenAiService;
  /** Sprint 21: scheduled agent runs (B-1306). */
  agentSchedules: AgentSchedules;
  /** Sprint 21: eval sets, runs and the publish gate for profiles (B-1303). */
  evals: EvalService;
  /** Sprint 15: rate-limit, failed-credential and denial-cap counters (Redis when REDIS_URL is set, else memory). */
  counters: CounterStore;
  /** Sprint 22 (B-1401): spans exported over OTLP/HTTP; a no-op without OTEL_EXPORTER_OTLP_ENDPOINT. */
  tracer: Tracer;
  /** Sprint 22 (B-1403): the schema version handshake; an instance older than the database takes no jobs. */
  schema: SchemaGuard;
  /** Sprint 22 (B-1405): zone NetworkPolicies applied through the Kubernetes API, with drift checks. */
  zoneCluster: ZoneCluster;
  /** Sprint 24 (B-1701 to B-1703): the tenant secrets vault (KV secrets, transit keys, path policies). */
  vault: VaultService;
  /** Sprint 24 (B-1601 to B-1604): the certificate authority (issuers, profiles, issuance, CRLs, OCSP). */
  pki: PkiService;
  /** 1.4.0 (B-2001): the event catalogue; every emitted event is checked against its schema. */
  events: EventCatalogue;
  /** 1.4.0 (B-2102): the tenant-scoped read-through cache (Redis when configured, else memory), cleared over the bus. */
  cache: TenantCache;
  /** 1.4.0 (B-2101): authorisers for the domain realtime rooms (conversation, group, feed, channel). */
  rooms: RoomRegistry;
  /** 1.4.0 (B-2002): per-tenant plugin installs (manifests and grants; data, never code). */
  plugins: PluginService;
  /** 1.4.0 (B-2003, B-2004): runs plugins: the event fan-out, declarative actions and the broker for script handlers. */
  pluginRuntime: PluginRuntime;
  /** Sprint 25 (B-1704): database leases from the built-in PostgreSQL and MySQL engines. */
  dbLeases: DatabaseLeases;
  /** Sprint 25 (B-1706): rotation schedules and notices for KV secrets and transit keys. */
  rotation: RotationNotices;
  /** 1.4.0, Sprint 25 (B-1608 to B-1611): service DIDs, their keys, the signed labeler and trusted external labelers. */
  atproto: AtprotoService;
  /** 1.4.0, Sprint 26 (B-1901 to B-1907): moderation checks, reports, actions, appeals, sanctions, queues, providers. */
  moderation: ModerationService;
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
  drivers?: Partial<Record<'postgres' | 'opensearch' | 'mysql', DriverFactory>>;
  /** OpenBao database-engine credentials for data connections (tests point it at a fake). */
  dynamicCredentials?: DynamicCredentials | null;
  git?: GitFetcher;
  trainer?: TrainerBackend;
  acme?: AcmeClient;
  kerberos?: KerberosVerifier;
  /** Email transport (tests record messages instead of sending them). */
  mail?: MailTransport;
  /** Sprint 13: the billing provider (tests use a fake Stripe). */
  billingProvider?: BillingProvider | null;
  /** Sprint 25 (B-1704): the database engines behind leases (tests use an in-memory fake). */
  dbAdmins?: DbAdminFactory;
  /** Sprint 26 (B-1906): external moderation providers (tests use a fake). */
  moderationProviders?: ModerationProviderClient;
}

export function createServices(cfg: Config, db: Db, log: Logger, metrics = new Metrics(), overrides: ServiceOverrides = {}): Services {
  // Sprint 22 (B-1401): tracing, and spans for database queries made inside a trace.
  const tracer = new Tracer({ url: tracesUrl(cfg), serviceName: cfg.OTEL_SERVICE_NAME, serviceVersion: process.env.npm_package_version ?? '', headers: parseOtlpHeaders(cfg.OTEL_EXPORTER_OTLP_HEADERS), ratio: cfg.OTEL_TRACES_SAMPLE_RATIO, maxQueue: cfg.OTEL_BSP_MAX_QUEUE_SIZE, delayMs: cfg.OTEL_BSP_SCHEDULE_DELAY, timeoutMs: cfg.OTEL_EXPORTER_OTLP_TIMEOUT }, log);
  if (tracer.enabled) instrumentKnex(db, cfg.DB_CLIENT === 'pg' ? 'postgresql' : cfg.DB_CLIENT);
  const bus = new Bus(log, cfg.REDIS_URL);
  // Sprint 15: with a previous KEK configured, reads fall back to it until `kms:rewrap` has moved everything.
  const kms = overrides.kms ?? withPrevious(createKms(cfg), createPreviousKms(cfg));
  const keys = new DataKeys(db, kms, cfg.OPENBAO_KEY_PREFIX, cfg.DATA_KEY, bus);
  const blobs = overrides.blobs ?? createBlobStore(cfg);
  const mode = cfg.JOB_QUEUE === 'auto' ? (cfg.REDIS_URL ? 'bullmq' : 'db') : cfg.JOB_QUEUE;
  const jobs = new JobQueue(db, log, bus, { mode, redisUrl: cfg.REDIS_URL, pollMs: cfg.JOB_POLL_MS, concurrency: cfg.JOB_CONCURRENCY });
  const scheduler = new Scheduler(jobs, log);
  const audit = new AuditLog(db);
  const counters = createCounterStore(cfg.REDIS_URL, log);
  const denials = new DenialAudit(audit, 20, 60_000, counters);
  const providers = new ProviderRepo(db);
  const users = new UserRepo(db);
  // Sprint 21 (B-1305): memberships lost through a group mapping or the directory end live shared watches at once.
  users.onMembershipsLost = (userId, workspaceIds) =>
    void db('users')
      .where({ id: userId })
      .first('tenant_id')
      .then((u: { tenant_id: string } | undefined) => u && bus.publish(TOPICS.workspaceMembership, { tenantId: u.tenant_id, userId, workspaceIds } satisfies MembershipEvent))
      .catch((err: Error) => log.warn({ err: err.message }, 'membership event not published'));
  const tenants = new TenantRepo(db);
  const notifications = new Notifications(db, bus, log, { smtpUrl: cfg.SMTP_URL, from: cfg.SMTP_FROM, publicUrl: cfg.PUBLIC_URL, ...(overrides.mail ? { transport: overrides.mail } : {}) });
  configureSecretPolicy(
    secretPolicy({ envAllow: cfg.SECRET_REF_ENV, dirs: cfg.SECRET_REF_DIRS, serverEnvNames: SERVER_ENV_NAMES, serverSecretFiles: FILE_VARS.map((n) => process.env[`${n}_FILE`]) })
  );
  const chain = new IdentityChain(db, providers, log, cfg.NODE_ENV === 'production', {
    allow: parseAllowList(cfg.IDENTITY_ALLOWED_HOSTS),
    refusedSqliteFiles: cfg.DB_CLIENT === 'sqlite' ? [cfg.SQLITE_FILENAME] : []
  });
  const sessions = new SessionService(
    db,
    { secret: cfg.SESSION_SECRET, idleMinutes: cfg.SESSION_IDLE_MINUTES, absoluteHours: cfg.SESSION_ABSOLUTE_HOURS, pendingMinutes: cfg.MFA_PENDING_MINUTES },
    (ids) => bus.publish(TOPICS.sessionsRevoked, ids)
  );
  const apiKeys = new ApiKeyService(db, cfg.SESSION_SECRET);
  const siem = new SiemForwarder(audit, log, { url: cfg.SIEM_URL, token: cfg.SIEM_TOKEN });
  const quotas = new QuotaService(db);
  const gateway = new Gateway(new GatewayRepo(db), bus, log, { pollMs: cfg.OLLAMA_POLL_MS, timeoutMs: cfg.OLLAMA_TIMEOUT_MS, maxInflight: cfg.OLLAMA_MAX_INFLIGHT, maxLoadsPer10Min: cfg.OLLAMA_MAX_LOADS_PER_10_MIN, queueTimeoutMs: cfg.OLLAMA_QUEUE_TIMEOUT_MS, policy: servicePolicy(cfg), loadTimeoutMs: cfg.OLLAMA_LOAD_TIMEOUT_MS }, jobs);
  const attachments = new AttachmentService(db, blobs, keys, jobs, bus, { maxBytes: cfg.ATTACHMENT_MAX_BYTES, ...(cfg.CLAMD_HOST ? { clamd: { host: cfg.CLAMD_HOST, port: cfg.CLAMD_PORT } } : {}) });
  const calc = new CalcWorker();
  const guard = createGuardrails({ db, keys, gateway, bus, notifications, jobs, log });
  const chat = new ChatService(db, keys, gateway, quotas, audit, bus, attachments, calc, log, guard.engine, {
    store: cfg.REDIS_URL ? new RedisStreamStore(cfg.REDIS_URL, keys, log) : new DbStreamStore(db, keys),
    flags: guard.flags,
    notifications,
    leaseMs: cfg.CHAT_STREAM_LEASE_SECONDS * 1000,
    // Sprint 16: a prompt a reviewer approved is answered for its owner; the guard model screens streamed answers.
    principalFor: async (tenantId, userId, workspaceId) => {
      const p = await loadPrincipal(s, tenantId, userId, {});
      if (p) p.workspaceId = workspaceId;
      return p;
    },
    streamModel: { holdback: cfg.CHAT_GUARD_HOLDBACK_SENTENCES, limiter: new CheckLimiter(cfg.CHAT_GUARD_STREAM_CONCURRENCY) }
  });
  // Sprint 21: a held /v1 request (B-1301) is shown from the API's store.
  guard.flags.heldAnswer = (tenantId, messageId, kind) => (kind === 'api-request' ? s.openai.holds.heldText(tenantId, messageId) : chat.heldText(tenantId, messageId));
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
  const workflows = new WorkflowService({ db, keys, gateway, quotas, audit, bus, jobs, notifications, calc, registry, tools, log, guardrails: () => s.guardrails, principalFor: (t, u) => loadPrincipal(s, t, u, {}), http: { hosts: cfg.WORKFLOW_HTTP_HOSTS.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean), allowLoopback: cfg.WORKFLOW_HTTP_ALLOW_LOOPBACK }, tenantHosts: (t) => s.integrations.allowList(t), onCallerDone: async (t, kind, id) => void (kind === 'agent-run' ? await agents.resumeAwaiting(t, id) : undefined), vault: { check: (p, refs) => s.vault.assertRefsReadable(p, refs), read: (p, ref, via) => s.vault.readAs(p, ref, { via }) } });
  tools.useWorkflows(workflows);
  const media = new MediaService({
    db, keys, blobs, jobs, bus, audit, quotas, notifications, log,
    runner: overrides.mediaRunner ?? new FfmpegRunner({ ffmpeg: cfg.MEDIA_FFMPEG, ffprobe: cfg.MEDIA_FFPROBE, ...(cfg.MEDIA_WHISPER_BIN ? { whisper: cfg.MEDIA_WHISPER_BIN } : {}) }),
    safety: () => s.imageSafety,
    safetyThreshold: cfg.IMAGE_SAFETY_THRESHOLD,
    safetyRequired: cfg.IMAGE_SAFETY_REQUIRED,
    guardrails: () => s.guardrails,
    caps: { maxBytes: cfg.MEDIA_MAX_BYTES, maxDurationMs: cfg.MEDIA_MAX_DURATION_S * 1000, maxWidth: cfg.MEDIA_MAX_WIDTH, maxHeight: cfg.MEDIA_MAX_HEIGHT, maxStreams: cfg.MEDIA_MAX_STREAMS },
    encoder: cfg.MEDIA_ENCODER,
    ...(cfg.MEDIA_WORK_DIR ? { workDir: cfg.MEDIA_WORK_DIR } : {}),
    ...(cfg.MEDIA_WHISPER_BIN && cfg.MEDIA_WHISPER_MODEL ? { whisper: { bin: cfg.MEDIA_WHISPER_BIN, model: cfg.MEDIA_WHISPER_MODEL } } : {})
  });
  const images = new ImageService({ db, keys, blobs, jobs, bus, kms, audit, quotas, notifications, log, backends: overrides.imageBackends ?? createBackends(cfg.IMAGE_BACKENDS, servicePolicy(cfg)), safety: () => s.imageSafety, safetyThreshold: cfg.IMAGE_SAFETY_THRESHOLD, safetyRequired: cfg.IMAGE_SAFETY_REQUIRED, guardrails: () => s.guardrails, provenanceKey: `${cfg.OPENBAO_KEY_PREFIX}image-provenance` });
  // Checkpoints go through whatever `s.guardrails` is when they run.
  const checkpoint: Guardrails = { check: (input) => s.guardrails.check(input) };
  const vectors = overrides.vectors ?? new LazyVectorStore(() => createVectorStore(db, cfg.DB_CLIENT, log));
  const connections = new ConnectionService(db, keys, audit, checkpoint, { ...createDrivers(parseAllowList(cfg.CONNECTIONS_ALLOWED_HOSTS)), ...overrides.drivers }, overrides.dynamicCredentials !== undefined ? overrides.dynamicCredentials : createDynamicCredentials(cfg));
  const knowledge = new KnowledgeService(
    { db, keys, blobs, jobs, gateway, vectors, audit, quotas, guard: checkpoint, connections, log, workspaces: async (p) => (effectivePermissions(p).has('tenant:manage') ? await tenants.workspaces(p.tenantId) : await tenants.workspacesForUser(p.tenantId, p.userId)).map((w) => w.id) },
    {
      maxBytes: cfg.ATTACHMENT_MAX_BYTES,
      ...(cfg.CLAMD_HOST ? { clamd: { host: cfg.CLAMD_HOST, port: cfg.CLAMD_PORT } } : {}),
      ...(cfg.S3_ENDPOINT && cfg.S3_ACCESS_KEY_ID && cfg.S3_SECRET_ACCESS_KEY ? { s3: { endpoint: cfg.S3_ENDPOINT, region: cfg.S3_REGION, accessKeyId: cfg.S3_ACCESS_KEY_ID, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY, pathStyle: cfg.S3_FORCE_PATH_STYLE } } : {}),
      git: overrides.git ?? new CliGit({ allowFile: false, timeoutMs: 5 * 60_000 }),
      replication: { enabled: cfg.KNOWLEDGE_REPLICATION === 'on', tickMs: cfg.KNOWLEDGE_REPLICATION_TICK_MS },
      // Sprint 23 (B-1501, B-1502): sources' own S3 endpoints and crawled sites.
      allowedHosts: parseAllowList(cfg.KNOWLEDGE_ALLOWED_HOSTS),
      fetchTimeoutMs: cfg.KNOWLEDGE_FETCH_TIMEOUT_MS
    }
  );
  const memory = new MemoryService({ db, keys, blobs, jobs, gateway, vectors, audit, guard: checkpoint, terms: knowledge.terms, log, embed: (t, m, x, l, u) => knowledge.embed(t, m, x, l, u) });
  chat.contextProviders.push((r) => knowledge.contextFor(r), (r) => memory.contextFor(r));
  agents.memories = (p, agent, label) => memory.forAgent(p, agent, label);
  agents.proposeMemory = (p, input) => memory.proposeForAgent(p, input);
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
    denials,
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
    offboarding: new Offboarding(db, keys, blobs, jobs, sessions),
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
    // Sprint 9 services read their collaborators through `s`.
    training: new TrainingService(() => s),
    trainer: overrides.trainer ?? createTrainer(cfg),
    zones: new ZoneService(() => s),
    ops: new OpsService(() => s),
    acme: overrides.acme ?? createAcme(cfg),
    federation: new FederationService(() => s),
    kerberos: overrides.kerberos ?? createKerberos(cfg),
    // Sprint 11: account self-service.
    account: new AccountService(() => s),
    // Sprint 13 services read their collaborators through `s`.
    integrations: new TenantIntegrations(db),
    webhooks: new WebhookService(() => s, { allowedHosts: cfg.WEBHOOK_ALLOWED_HOSTS, timeoutMs: cfg.WEBHOOK_TIMEOUT_MS, maxAttempts: cfg.WEBHOOK_MAX_ATTEMPTS, retryBaseMs: cfg.WEBHOOK_RETRY_BASE_MS, breakerThreshold: cfg.WEBHOOK_BREAKER_THRESHOLD, breakerCooldownMs: cfg.WEBHOOK_BREAKER_COOLDOWN_MS }),
    prompts: new PromptService(() => s),
    sharing: new ConversationSharing(() => s),
    billing: new BillingService(
      () => s,
      overrides.billingProvider !== undefined ? overrides.billingProvider : cfg.BILLING_PROVIDER === 'stripe' && cfg.STRIPE_SECRET_KEY ? new StripeProvider({ secretKey: cfg.STRIPE_SECRET_KEY, apiUrl: cfg.STRIPE_API_URL, timeoutMs: 30_000, daysUntilDue: cfg.STRIPE_DAYS_UNTIL_DUE }) : null
    ),
    openai: new OpenAiService(() => s, { streamMode: cfg.OPENAI_STREAM_MODE }),
    agentSchedules: new AgentSchedules(() => s),
    evals: new EvalService(() => s),
    counters,
    tracer,
    schema: new SchemaGuard(db, log, cfg.SCHEMA_CHECK_SECONDS * 1000),
    zoneCluster: new ZoneCluster(() => s),
    vault: new VaultService(() => s, { maxVersions: cfg.VAULT_KV_MAX_VERSIONS }),
    pki: new PkiService(() => s),
    // 1.4.0, Sprint 24c: platform core.
    events: new EventCatalogue(metrics.registry, (type, problems) => log.warn({ type, problems: problems.slice(0, 5) }, 'event does not match its catalogue schema')),
    cache: new TenantCache(createCacheStore(cfg.CACHE_STORE, cfg.REDIS_URL, cfg.CACHE_MAX_ENTRIES, log), bus, metrics.registry, { ttlSeconds: { short: cfg.CACHE_TTL_SHORT_SECONDS, medium: cfg.CACHE_TTL_MEDIUM_SECONDS, long: cfg.CACHE_TTL_LONG_SECONDS } }, log),
    rooms: new RoomRegistry(bus),
    plugins: new PluginService(() => s),
    pluginRuntime: new PluginRuntime(() => s, metrics.registry),
    // 1.4.0, Sprint 25c: database leases and rotation schedules.
    dbLeases: new DatabaseLeases(() => s, { admins: overrides.dbAdmins ?? createDbAdmins(parseAllowList(cfg.CONNECTIONS_ALLOWED_HOSTS)), defaultTtlS: cfg.VAULT_LEASE_DEFAULT_TTL_SECONDS, maxTtlS: cfg.VAULT_LEASE_MAX_TTL_SECONDS, sweepSeconds: cfg.VAULT_LEASE_SWEEP_SECONDS }),
    rotation: new RotationNotices(() => s, { checkMinutes: cfg.VAULT_ROTATION_CHECK_MINUTES, noticeDays: cfg.VAULT_ROTATION_NOTICE_DAYS }),
    atproto: new AtprotoService(() => s),
    moderation: new ModerationService(() => s, overrides.moderationProviders),
    close: async () => {
      s.schema.stop();
      scheduler.stop();
      s.webhooks.close();
      s.pluginRuntime.close();
      await denials.flushAll().catch(() => undefined);
      chat.close();
      await chat.store.close();
      await gateway.stop();
      await calc.close();
      siem.close();
      await jobs.stop();
      await chain.close();
      await mcp.close();
      await bus.close();
      await counters.close();
      await s.cache.close();
      await s.atproto.close().catch(() => undefined);
      await s.moderation.close().catch(() => undefined);
      await knowledge.replication.close().catch(() => undefined);
      await connections.close().catch(() => undefined);
      // Sprint 20: the signer connection, when the KMS is the signer.
      (kms as { client?: { close(): void } }).client?.close();
      await tracer.close();
    }
  };
  registerPlatformJobs(s);
  // Sprint 22: jobs join the trace that queued them and wait while this build is older than the schema; guardrail
  // checkpoints are spans (checkpoint and outcome only, never the text).
  jobs.tracer = tracer.enabled ? tracer : null;
  jobs.gate = () => s.schema.refusal();
  if (tracer.enabled) {
    const check = guard.engine.check.bind(guard.engine);
    guard.engine.check = (input) => withSpan('guardrails check', SpanKind.INTERNAL, { 'exprsn.guardrails.checkpoint': input.checkpoint, 'exprsn.label': input.label }, async (span) => {
      const d = await check(input);
      span?.setAttributes({ 'exprsn.guardrails.action': d.action, 'exprsn.guardrails.findings': d.findings.length });
      return d;
    });
  }
  s.zoneCluster.registerJobs();
  registerOpsMetrics(s);
  scripts.registerJobs();
  agents.registerJobs();
  s.training.registerJobs();
  s.zones.registerJobs();
  s.ops.registerJobs();
  s.federation.registerJobs();
  s.webhooks.registerJobs();
  s.webhooks.listen();
  s.sharing.registerJobs();
  s.openai.holds.registerJobs(); // Sprint 21 (B-1301)
  s.agentSchedules.registerJobs(); // Sprint 21 (B-1306)
  s.evals.registerJobs(); // Sprint 21 (B-1303)
  s.pki.registerJobs(); // Sprint 24 (B-1603, B-1604): CRLs and OCSP responders
  s.pluginRuntime.registerJobs(); // Sprint 25 (B-2003, B-2004): plugin invocations
  s.pluginRuntime.listen();
  // Sprint 25 (B-1704 to B-1706): the lease sweeper, rotation checks, and `vault:` references resolved as their owner.
  s.dbLeases.registerJobs();
  s.rotation.registerJobs();
  {
    const vaultRead = (tenantId: string, ownerId: string | null, ref: string, via: string) => s.vault.resolveFor(tenantId, ownerId, ref, { via });
    s.chain.useVaultResolver((row) => (ref) => vaultRead(row.tenant_id, row.vault_owner, ref, `identity-provider:${row.id}`));
    s.connections.vaultResolver = vaultRead;
    s.mcp.vaultResolver = vaultRead;
  }
  s.atproto.registerJobs(); // Sprint 25 (B-1610, B-1611): label pulls; labels withdrawn when their flag is dismissed
  s.moderation.init(); // Sprint 26 (B-1901 to B-1907): object types, provider and sweep jobs, routing, dead letters, sign-in gate
  jobs.register('billing.close', async (p, ctx) => s.billing.closePrevious(String(p.tenantId ?? ctx.job.tenant_id)));
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

  // Sprint 12: conversation retention, and answers whose generating instance stopped.
  s.jobs.register('chat.retention', async (p, ctx) => s.chat.purgeExpired(String(p.tenantId ?? ctx.job.tenant_id)));
  s.jobs.register('chat.sweep', async (p, ctx) => {
    const interrupted = await s.chat.sweepInterrupted(String(p.tenantId ?? ctx.job.tenant_id));
    await s.chat.store.expire(24 * 3_600_000);
    return { interrupted };
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
  s.knowledge.replication.start(); // Sprint 19: logical replication streams for PostgreSQL knowledge sources
  s.scheduler.every('memory.purge', 60 * 60_000, activeTenants);
  s.scheduler.every('chat.retention', s.cfg.CHAT_RETENTION_SWEEP_MINUTES * 60_000, activeTenants);
  s.scheduler.every('chat.sweep', 15 * 60_000, activeTenants);
  s.training.schedule(s.scheduler, activeTenants);
  s.zones.schedule(s.scheduler, activeTenants);
  s.ops.schedule(s.scheduler, activeTenants);
  s.federation.schedule(s.scheduler, activeTenants);
  s.zoneCluster.schedule(s.scheduler); // Sprint 22 (B-1405): drift checks when zones are applied in-cluster
  if (s.cfg.BILLING_CLOSE_MINUTES > 0) s.scheduler.every('billing.close', s.cfg.BILLING_CLOSE_MINUTES * 60_000, activeTenants);
  s.agentSchedules.schedule(s.scheduler); // Sprint 21 (B-1306)
  s.pki.schedule(s.scheduler); // Sprint 24 (B-1603): CRLs for every live issuer
  s.dbLeases.schedule(s.scheduler); // Sprint 25 (B-1704): the lease expiry sweeper
  s.rotation.schedule(s.scheduler); // Sprint 25 (B-1706): rotation notices
  s.atproto.schedule(s.scheduler); // Sprint 25 (B-1611): labels from trusted external labelers
  s.moderation.schedule(); // Sprint 26 (B-1904, B-1905): SLA escalation and sanction expiry
}
