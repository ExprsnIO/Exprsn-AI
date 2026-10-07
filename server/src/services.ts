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
import { SwitchableBlobStore } from './platform/blob-switch.js';
import { SettingsService } from './config/settings.js';
import { StorageService } from './ops/storage.js';
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
import { ChainRefs } from './chain/refs.js';
import { ChainService } from './chain/context.js';
import { WorkflowBundles } from './workflows/bundles.js';
import { WorkflowDeadLetters } from './workflows/dead-letters.js';
import { WorkflowTriggers } from './workflows/triggers.js';
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
import { InstanceRegistry } from './ops/instances.js';
import { JobsAdmin } from './ops/jobs-admin.js';
import { PlatformOverview } from './ops/overview.js';
import { RoomRegistry } from './realtime/rooms.js';
import { PluginService } from './plugins/service.js';
import { IdentityPolicies } from './identity/policy.js';
import { SignupService } from './identity/signup.js';
import { UserImportService } from './identity/user-import.js';
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
import { RevealWatch } from './vault/anomalies.js';
import { PkiService } from './pki/service.js';
import { AtprotoService } from './atproto/service.js';
import { AtprotoAccounts } from './atproto/accounts.js';
import { clears } from './authz/labels.js';
import { FileService } from './files/service.js';
import { ProcessPreviewRenderer, type PreviewRenderer } from './files/preview.js';
import { ModerationService } from './moderation/service.js';
import { FirehoseService } from './atproto/firehose.js';
import { FeedGenerators } from './atproto/feeds.js';
import { PdsService } from './atproto/pds/service.js';
import { AppService } from './apps/service.js';
import type { ModerationProviderClient } from './moderation/providers.js';
import { GroupService } from './groups/service.js';
import { CalendarService } from './groups/calendar.js';
import { DavService } from './dav/service.js';
import { ChannelService } from './channels/service.js';
import type { ChannelIo, ChannelMailer } from './channels/mail.js';
import nodemailer from 'nodemailer';
import { SocialService } from './social/service.js';
import { PresenceService } from './profiles/presence.js';
import { ProfileService } from './profiles/service.js';
import { MessagingService } from './messaging/service.js';
import { MessagingInsights } from './messaging/insights.js';
import { FeedService } from './feed/service.js';
import { SocialAdmin } from './social/admin.js';
import { BuiltinTools } from './registry/builtin/index.js';
import { WorkflowStepKit } from './workflows/steps/index.js';
import { CustomRoleService } from './authz/custom-roles.js';
import { AccessService } from './authz/access.js';
import { AccessReviewService } from './authz/reviews.js';
import { ImportService } from './imports/service.js';

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
  /** Sprint 32 (B-4101): the chain context every invocation records itself in. */
  chains: ChainService;
  /** Sprint 34 (B-4105): the reference graph across agents, skills, tools and workflows. */
  chainRefs: ChainRefs;
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
  /** 1.6.0 (B-4202): this server instance's heartbeat, every instance's readiness, and drain. */
  instances: InstanceRegistry;
  /** 1.6.0 (B-4202): the Overview's alerts, counters, recent audit and capacity. */
  overview: PlatformOverview;
  /** 1.6.0 (B-4203): Jobs and queues: job types, jobs, schedules, dead letters and the tenant cache. */
  jobsAdmin: JobsAdmin;
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
  /** 1.6.0, Sprint 36b (B-4803): reveal history and anomaly flags for secret owners. */
  revealWatch: RevealWatch;
  /** 1.4.0, Sprint 25 (B-1608 to B-1611): service DIDs, their keys, the signed labeler and trusted external labelers. */
  atproto: AtprotoService;
  /** 1.4.0, Sprint 26 (B-1807, B-1808): user DIDs and handles, and sign-in with AT-Protocol accounts. */
  atprotoAccounts: AtprotoAccounts;
  /** 1.4.0, Sprint 26d (B-2401 to B-2405): workspace folders and files, versions, trash, shares, quotas, previews. */
  files: FileService;
  /** 1.4.0, Sprint 26 (B-1901 to B-1907): moderation checks, reports, actions, appeals, sanctions, queues, providers. */
  moderation: ModerationService;
  /** 1.4.0, Sprint 26a (B-1801, B-1803): per-tenant signup and MFA policies, trusted devices. */
  identityPolicy: IdentityPolicies;
  /** 1.4.0, Sprint 26a (B-1801, B-1802): self-registration, email verification, invitations by workspace admins. */
  signup: SignupService;
  /** 1.4.0, Sprint 26a (B-1805): users, memberships and group mappings imported from CSV as a job. */
  userImports: UserImportService;
  /** 1.4.0, Sprint 27 (B-1908): AT-Protocol firehose subscriptions and their single-instance consumers. */
  firehose: FirehoseService;
  /** 1.5.0, Sprint 31 (B-3001 to B-3003): custom feed generators over the firehose, served under the tenant's DID. */
  feedGenerators: FeedGenerators;
  /** 1.5.0, Sprint 31 (B-2901 to B-2906, B-3004): the AT-Protocol personal data server. */
  pds: PdsService;
  /** 1.4.0, Sprint 27 (B-2201 to B-2208): low-code apps: entities, sealed records, forms, triggers, AI fields, bundles. */
  apps: AppService;
  /** 1.4.0, Sprint 27c (B-2501, B-2505): groups in workspaces, members, requests, invitations, posts and their moderation. */
  groups: GroupService;
  /** 1.4.0, Sprint 27c (B-2502 to B-2504): group events, RSVPs, check-in, reminders and signed iCalendar feeds. */
  calendar: CalendarService;
  /** 1.4.0, Sprint 28a (B-2301 to B-2304): customer-service channels: sessions, held replies, email, retention. */
  channels: ChannelService;
  /** 1.4.0, Sprint 28b (B-2606 with B-2702): blocks, mutes, follows, lists and contact rules, shared by messaging and the feed. */
  social: SocialService;
  /** 1.5.0, Sprint 34c (B-5801): profiles: pronouns, bio and an avatar from the file store, visible by workspace and clearance. */
  people: ProfileService;
  /** 1.5.0, Sprint 34c (B-5802): presence status, chosen or derived from connections and idle time. */
  presence: PresenceService;
  /** 1.4.0, Sprint 28b (B-2601 to B-2604): direct and group conversations, sealed messages, receipts, presence, mutes. */
  messaging: MessagingService;
  /** 1.4.0, Sprint 28b (B-2605): keyword and semantic search, thread summaries and catch-up digests. */
  messagingInsights: MessagingInsights;
  /** 1.4.0, Sprint 28c (B-2701 to B-2705): the workspace feed: posts, comments, reactions, reposts, bookmarks, feeds, trending tags and digests. */
  feed: FeedService;
  /** 1.6.0 (B-4206): the Social and messaging screen: workspace policies, digest settings, legal-hold exports, realtime counts. */
  socialAdmin: SocialAdmin;
  /** 1.5.0, Sprint 29 (B-3302): tenant-defined roles, versioned, under dual control when they hold admin permissions. */
  customRoles: CustomRoleService;
  /** 1.5.0, Sprint 29 (B-3303): the effective-access matrix, `explain` per cell, and "who can". */
  access: AccessService;
  /** 1.5.0, Sprint 29 (B-3305): access review campaigns. */
  accessReviews: AccessReviewService;
  /** 1.5.0, Sprint 30 (B-31): DAV app passwords, personal calendars and address books, dead properties. */
  dav: DavService;
  /** 1.5.0, Sprint 30 (B-3801 to B-3803): import repositories, the catalogue and model import. */
  imports: ImportService;
  /** 1.5.0, Sprint 32b (B-3903, B-3906, B-3909): workflow triggers, dead letters and bundles. */
  workflowTriggers: WorkflowTriggers;
  workflowDeadLetters: WorkflowDeadLetters;
  workflowBundles: WorkflowBundles;
  /** 1.6.0, Sprint 35c (B-4205): settings each instance reads, overrides under dual control. */
  settings: SettingsService;
  /** 1.6.0, Sprint 35c (B-4204): stores, usage, quarantine, integrity, purges and blob store migration. */
  storage: StorageService;
  /** Stops background work and closes connections (Redis, SMTP, identity stores). */
  close(): Promise<void>;
}

export interface ServiceOverrides {
  /** 1.6.0 (B-4202): this instance's id (default: the job queue's worker id), so tests run two instances in one process. */
  instanceId?: string;
  kms?: Kms;
  blobs?: BlobStore;
  mediaRunner?: MediaRunner;
  imageBackends?: ImageBackend[];
  imageSafety?: ImageSafety;
  vectors?: VectorStore;
  /** Data connection drivers by engine (tests use in-process fakes). */
  drivers?: Partial<Record<'postgres' | 'opensearch' | 'mysql' | 'mongodb', DriverFactory>>;
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
  /** Sprint 26d (B-2404): the file store's preview renderer (tests use an in-process fake). */
  previewRenderer?: PreviewRenderer;
  /** Sprint 26 (B-1906): external moderation providers (tests use a fake). */
  moderationProviders?: ModerationProviderClient;
  /** Sprint 28a (B-2303): the channels' IMAP fetcher and SMTP transports (tests use fakes; never a real mailbox). */
  channelIo?: Partial<ChannelIo>;
}

export function createServices(cfg: Config, db: Db, log: Logger, metrics = new Metrics(), overrides: ServiceOverrides = {}): Services {
  // Sprint 22 (B-1401): tracing, and spans for database queries made inside a trace.
  const tracer = new Tracer({ url: tracesUrl(cfg), serviceName: cfg.OTEL_SERVICE_NAME, serviceVersion: process.env.npm_package_version ?? '', headers: parseOtlpHeaders(cfg.OTEL_EXPORTER_OTLP_HEADERS), ratio: cfg.OTEL_TRACES_SAMPLE_RATIO, maxQueue: cfg.OTEL_BSP_MAX_QUEUE_SIZE, delayMs: cfg.OTEL_BSP_SCHEDULE_DELAY, timeoutMs: cfg.OTEL_EXPORTER_OTLP_TIMEOUT }, log);
  if (tracer.enabled) instrumentKnex(db, cfg.DB_CLIENT === 'pg' ? 'postgresql' : cfg.DB_CLIENT);
  const bus = new Bus(log, cfg.REDIS_URL);
  // Sprint 15: with a previous KEK configured, reads fall back to it until `kms:rewrap` has moved everything.
  const kms = overrides.kms ?? withPrevious(createKms(cfg), createPreviousKms(cfg));
  const keys = new DataKeys(db, kms, cfg.OPENBAO_KEY_PREFIX, cfg.DATA_KEY, bus);
  // 1.6.0 (B-4204): the store can move to another one while the server runs (ops/storage.ts).
  const blobs = new SwitchableBlobStore(overrides.blobs ?? createBlobStore(cfg));
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
  guard.flags.heldAnswer = (tenantId, messageId, kind) => (kind === 'api-request' ? s.openai.holds.heldText(tenantId, messageId) : kind === 'channel-message' ? s.channels.heldText(tenantId, messageId) : kind === 'app-form-submission' ? s.apps.forms.held.heldText(tenantId, messageId) : chat.heldText(tenantId, messageId));
  const registry = new RegistryService(db);
  const chainRefs = new ChainRefs(db, registry);
  registry.useRefs(chainRefs);
  const mcp = new McpService(db, keys, registry, audit, notifications, log, { allowedHosts: cfg.MCP_ALLOWED_HOSTS, timeoutMs: cfg.MCP_TIMEOUT_MS });
  const scripts = new ScriptService(db, keys, jobs, bus, registry, () => s.guardrails, createScriptRunner(cfg), log);
  const tools = new ToolDispatcher(registry, mcp, scripts, calc, () => s.guardrails);
  chat.useTools(tools);
  const chains = new ChainService(db, {
    maxDepth: cfg.CHAIN_MAX_DEPTH,
    kindCaps: { 'workflow-run': cfg.WORKFLOW_MAX_DEPTH, 'agent-run': cfg.AGENT_MAX_DEPTH },
    defaults: { tokens: cfg.CHAIN_MAX_TOKENS, steps: cfg.CHAIN_MAX_STEPS, wallMs: cfg.CHAIN_MAX_WALL_SECONDS * 1000, gpuMs: cfg.CHAIN_MAX_GPU_SECONDS * 1000 }
  }, audit);
  tools.useChains(chains);
  const agents = new AgentService(db, keys, gateway, registry, tools, quotas, audit, bus, jobs, notifications, async (tenantId, userId, workspaceId) => {
    const p = await loadPrincipal(s, tenantId, userId, {});
    if (p) p.workspaceId = workspaceId;
    return p;
  }, log);
  // Sprint 8 services read the guardrails and the safety classifier through `s`, so a later replacement is used.
  const workflows = new WorkflowService({ db, keys, gateway, quotas, audit, bus, jobs, notifications, calc, registry, tools, log, guardrails: () => s.guardrails, principalFor: (t, u) => loadPrincipal(s, t, u, {}), http: { hosts: cfg.WORKFLOW_HTTP_HOSTS.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean), allowLoopback: cfg.WORKFLOW_HTTP_ALLOW_LOOPBACK }, tenantHosts: (t) => s.integrations.allowList(t), onCallerDone: async (t, kind, id) => void (kind === 'agent-run' ? await agents.resumeAwaiting(t, id) : undefined), vault: { check: (p, refs) => s.vault.assertRefsReadable(p, refs), read: (p, ref, via) => s.vault.readAs(p, ref, { via }) }, chains, agents: () => agents, refs: chainRefs });
  tools.useWorkflows(workflows);
  // Sprint 34 (B-4102): agents delegate to agents through the dispatcher.
  tools.useAgents(agents);
  // Sprint 32: agent runs join chains, and an agent run a workflow step awaits resumes that workflow run when it ends.
  agents.chains = chains;
  agents.onCallerDone = async (t, kind, id) => void (kind === 'workflow-run' ? await workflows.resumeFromCaller(t, id) : undefined);
  tools.useBuiltins(new BuiltinTools(() => s)); // B-3904: the domain built-ins act through the services as the caller
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
    { db, keys, blobs, jobs, gateway, vectors, audit, quotas, guard: checkpoint, connections, log, workspaces: async (p) => (effectivePermissions(p).has('tenant:manage') ? await tenants.workspaces(p.tenantId) : await tenants.workspacesForUser(p.tenantId, p.userId)).map((w) => w.id), safety: () => s.imageSafety, safetyThreshold: cfg.IMAGE_SAFETY_THRESHOLD, safetyRequired: cfg.IMAGE_SAFETY_REQUIRED, classifiers: guard.classifiers },
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
  // Sprint 36c (B-8802, B-8805): image cases of classifier datasets, and new vision classifier versions re-label images.
  guard.classifiers.blobs = blobs;
  guard.classifiers.onVersion.push(async (c) => void (await knowledge.classifierVersioned(c)));
  const memory = new MemoryService({ db, keys, blobs, jobs, gateway, vectors, audit, guard: checkpoint, terms: knowledge.terms, log, embed: (t, m, x, l, u) => knowledge.embed(t, m, x, l, u) });
  chat.contextProviders.push((r) => knowledge.contextFor(r), (r) => memory.contextFor(r));
  agents.memories = (p, agent, label) => memory.forAgent(p, agent, label);
  agents.proposeMemory = (p, input) => memory.proposeForAgent(p, input);
  agents.memoryExtract = (e) => memory.onRun(e);
  memory.runTexts = (t, id) => agents.runTexts(t, id);
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
    chains,
    chainRefs,
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
    webhooks: new WebhookService(() => s, { allowedHosts: cfg.WEBHOOK_ALLOWED_HOSTS, timeoutMs: cfg.WEBHOOK_TIMEOUT_MS, maxAttempts: cfg.WEBHOOK_MAX_ATTEMPTS, retryBaseMs: cfg.WEBHOOK_RETRY_BASE_MS, breakerThreshold: cfg.WEBHOOK_BREAKER_THRESHOLD, breakerCooldownMs: cfg.WEBHOOK_BREAKER_COOLDOWN_MS, endpointConcurrency: Math.max(1, Math.floor(cfg.JOB_CONCURRENCY / 2)) }),
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
    instances: new InstanceRegistry(() => s, bus, { heartbeatMs: 30_000, id: overrides.instanceId ?? jobs.workerId }),
    overview: new PlatformOverview(() => s),
    jobsAdmin: new JobsAdmin(() => s),
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
    revealWatch: new RevealWatch(() => s),
    atproto: new AtprotoService(() => s),
    atprotoAccounts: new AtprotoAccounts(() => s),
    // 1.4.0, Sprint 26d: the file store.
    files: new FileService(() => s, {
      maxBytes: cfg.FILES_MAX_BYTES,
      trashDays: cfg.FILES_TRASH_DAYS,
      previewMaxBytes: cfg.FILES_PREVIEW_MAX_BYTES,
      previewPx: cfg.FILES_PREVIEW_PX,
      ...(cfg.CLAMD_HOST ? { clamd: { host: cfg.CLAMD_HOST, port: cfg.CLAMD_PORT } } : {}),
      ...(cfg.FILES_WORK_DIR ? { workDir: cfg.FILES_WORK_DIR } : {}),
      renderer: overrides.previewRenderer ?? new ProcessPreviewRenderer({ ffmpeg: cfg.MEDIA_FFMPEG, pdftoppm: cfg.FILES_PDFTOPPM })
    }),
    moderation: new ModerationService(() => s, overrides.moderationProviders),
    identityPolicy: new IdentityPolicies(() => s),
    signup: new SignupService(() => s),
    userImports: new UserImportService(() => s),
    // 1.4.0, Sprint 27: the firehose.
    firehose: new FirehoseService(() => s, { tickMs: cfg.FIREHOSE_TICK_MS, checkpointMs: cfg.FIREHOSE_CHECKPOINT_MS, queueMax: cfg.FIREHOSE_QUEUE_MAX, backoffMaxMs: cfg.FIREHOSE_BACKOFF_MAX_MS, idleMs: cfg.FIREHOSE_IDLE_MS, maxPerTenant: cfg.FIREHOSE_MAX_PER_TENANT, rejectAudits: cfg.FIREHOSE_REJECT_AUDITS }),
    feedGenerators: new FeedGenerators(() => s, { maxPerTenant: cfg.FEEDS_MAX_PER_TENANT, itemsMax: cfg.FEED_ITEMS_MAX }),
    // 1.5.0, Sprint 31: the PDS.
    pds: new PdsService(() => s),
    apps: new AppService(() => s, { maxImportBytes: cfg.APPS_IMPORT_MAX_BYTES, maxImportRows: cfg.APPS_IMPORT_MAX_ROWS, maxExportRows: cfg.APPS_EXPORT_MAX_ROWS, maxBulk: cfg.APPS_BULK_MAX, triggerMaxDepth: cfg.APPS_TRIGGER_MAX_DEPTH }),
    // 1.4.0, Sprint 27c: groups and events.
    groups: new GroupService(() => s, { inviteDays: cfg.GROUP_INVITE_DAYS, requestDays: cfg.GROUP_REQUEST_DAYS }),
    calendar: new CalendarService(() => s, { feedMaxLabel: cfg.CALENDAR_FEED_MAX_LABEL }),
    // 1.4.0, Sprint 28a: customer-service channels. Without SMTP settings of its own a channel sends through SMTP_URL.
    channels: new ChannelService(() => s, {
      platform: overrides.mail ? { sendMail: (m) => overrides.mail!.sendMail(m) } : cfg.SMTP_URL ? (nodemailer.createTransport(cfg.SMTP_URL) as unknown as ChannelMailer) : null,
      ...overrides.channelIo
    }),
    // 1.4.0, Sprint 28b: social relations.
    social: new SocialService(() => s),
    // 1.5.0, Sprint 34c: profiles and presence.
    people: new ProfileService(() => s),
    presence: new PresenceService(() => s, { heartbeatMs: 30_000, leaseMs: 90_000 }),
    messaging: new MessagingService(() => s, { maxMembers: cfg.MESSAGING_MAX_MEMBERS, embedModel: cfg.MESSAGING_EMBED_MODEL || null }),
    messagingInsights: new MessagingInsights(() => s, { summaryProfile: cfg.MESSAGING_SUMMARY_PROFILE, maxMessages: cfg.MESSAGING_SUMMARY_MAX_MESSAGES }),
    // 1.4.0, Sprint 28c: the workspace feed.
    feed: new FeedService(() => s),
    socialAdmin: new SocialAdmin(() => s),
    // 1.5.0, Sprint 29: custom roles, effective access and access reviews.
    customRoles: new CustomRoleService(() => s),
    access: new AccessService(() => s),
    accessReviews: new AccessReviewService(() => s),
    // 1.5.0, Sprint 30: CalDAV and CardDAV.
    dav: new DavService(() => s, db, cfg.SESSION_SECRET),
    // 1.5.0, Sprint 30: the import wizard's server side.
    imports: new ImportService(() => s, cfg),
    // 1.5.0, Sprint 32b: workflows started by events and schedules, dead letters, bundles.
    workflowTriggers: new WorkflowTriggers(() => s, metrics.registry),
    workflowDeadLetters: new WorkflowDeadLetters(() => s),
    workflowBundles: new WorkflowBundles(() => s),
    settings: new SettingsService(() => s),
    storage: new StorageService(() => s),
    close: async () => {
      s.settings.stop();
      s.storage.stop();
      s.schema.stop();
      scheduler.stop();
      // B-1908: firehose consumers store their cursors and give their leases back while the database is still open.
      await s.firehose.close().catch(() => undefined);
      s.webhooks.close();
      s.pluginRuntime.close();
      s.workflowTriggers.close();
      await denials.flushAll().catch(() => undefined);
      chat.close();
      await chat.store.close();
      await gateway.stop();
      await calc.close();
      siem.close();
      await s.instances.stop();
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
  jobs.gate = () => s.schema.refusal() ?? s.instances.drainReason();
  // 1.6.0 (B-4203): paused job types and schedules, read again by every poll and every scheduler tick.
  jobs.pausesLoader = async () => ((await db('job_type_pauses').select('type')) as { type: string }[]).map((r) => r.type);
  scheduler.isPaused = async (name) => !!(await db('schedule_pauses').where({ name }).first('name'));
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
  s.storage.registerJobs(); // 1.6.0, Sprint 35c (B-4204): ops.blobs.verify, ops.blobs.migrate, ops.storage.sample
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
  s.revealWatch.registerJobs(); // 1.6.0, Sprint 36b (B-4803): reveal history pruned
  {
    const vaultRead = (tenantId: string, ownerId: string | null, ref: string, via: string) => s.vault.resolveFor(tenantId, ownerId, ref, { via });
    s.chain.useVaultResolver((row) => (ref) => vaultRead(row.tenant_id, row.vault_owner, ref, `identity-provider:${row.id}`));
    s.connections.vaultResolver = vaultRead;
    s.mcp.vaultResolver = vaultRead;
    // 1.6.0, Sprint 35a (B-4302): a Chat Completions instance's bearer token, read as the administrator who saved it.
    s.gateway.tokenResolver = vaultRead;
  }
  s.pds.registerJobs(); // 1.5.0, Sprint 31 (B-2904, B-2905): requestCrawl, the event and blob trim, repos as moderation objects
  s.atproto.registerJobs(); // Sprint 25 (B-1610, B-1611): label pulls; labels withdrawn when their flag is dismissed
  s.feedGenerators.registerJobs(); // Sprint 31 (B-3003): feed index retention; feed caches dropped on a change
  // Sprint 26d (B-2401 to B-2405): quarantine scans, previews and the trash purge; folders as knowledge sources.
  s.files.registerJobs();
  s.knowledge.folders = s.files.folderSource();
  // Files as moderation objects (B-1902 with B-2401): a takedown trashes the file and revokes its shares; an upheld
  // appeal takes it out of the trash again (if not purged meanwhile).
  if (!s.moderation.registry.get('file')) {
    const MODERATION = 'moderation';
    s.moderation.registry.register({
      type: 'file',
      description: 'A file in a workspace folder (a taken-down file is in the trash and its shares are revoked)',
      resolve: async (tenantId, id) => {
        const f = await s.files.moderationTarget(tenantId, id);
        return f ? { type: 'file', id: f.id, tenantId, workspaceId: f.workspaceId, label: f.label, ownerId: f.ownerId, state: f.trashed ? 'hidden' : f.state } : null;
      },
      canRead: async (p, o, workspaces) => clears(p.clearance, o.label) && (o.ownerId === p.userId || (!!o.workspaceId && workspaces.includes(o.workspaceId))),
      text: async (o) => (await s.files.moderationTarget(o.tenantId, o.id))?.name ?? '',
      hide: async (o) => (o.state === 'hidden' || !(await s.files.takeDown(o.tenantId, o.id, MODERATION)) ? null : (o.state ?? 'ready')),
      restore: (o) => s.files.undoTakeDown(o.tenantId, o.id, MODERATION)
    });
  }
  // Sprint 27 (B-2201 to B-2208): AI fills, reindexing, CSV imports and exports, triggers; workflows' record steps;
  // records as moderation objects (a takedown hides the record from every list and read; an upheld appeal shows it).
  s.apps.registerJobs();
  s.apps.forms.held.registerJobs(); // 1.6.0, Sprint 36b (B-4701): decided held submissions purged
  s.workflows.useRecords(s.apps.triggers);
  s.workflows.useStepKit(new WorkflowStepKit(() => s)); // Sprint 32c (B-3907, B-3908): notify and webhook steps, approval forms
  if (!s.moderation.registry.get('record')) {
    s.moderation.registry.register({
      type: 'record',
      description: 'A record of a low-code app (a taken-down record is hidden from every list and read)',
      resolve: async (tenantId, id) => {
        const r = await s.apps.moderationTarget(tenantId, id);
        return r ? { type: 'record', id: r.id, tenantId, workspaceId: r.workspaceId, label: r.label, ownerId: r.ownerId, state: r.hidden ? 'hidden' : 'visible' } : null;
      },
      canRead: async (p, o, workspaces) => clears(p.clearance, o.label) && effectivePermissions(p).has('records:read') && (!o.workspaceId || workspaces.includes(o.workspaceId)),
      text: (o) => s.apps.moderationText(o.tenantId, o.id),
      hide: async (o) => (o.state === 'hidden' || !(await s.apps.setHidden(o.tenantId, o.id, true)) ? null : 'visible'),
      restore: (o) => s.apps.setHidden(o.tenantId, o.id, false)
    });
  }
  // Sprint 27c (B-2501 to B-2505): the group room authoriser, group content as moderation objects, reminder jobs.
  s.groups.init();
  s.calendar.registerJobs();
  // Sprint 28a (B-2301 to B-2304): channel jobs (replies, IMAP polls, the outbox, retention, exports); sessions and
  // their messages as moderation objects.
  s.channels.init();
  // Sprint 28b (B-2601 to B-2605): the conversation room (authoriser, signals, presence), embeddings, messages as
  // moderation objects.
  s.messaging.init();
  // Sprint 28c (B-2701 to B-2705): the feed room authoriser, posts and comments as moderation objects, trending and digests.
  s.feed.init();
  s.feed.digests.registerJobs();
  s.socialAdmin.registerJobs(); // 1.6.0 (B-4206): legal-hold conversation exports
  // 1.5.0, Sprint 29 (B-3302, B-3305): custom roles in force (reloaded from the bus), the access review sweep.
  s.customRoles.init();
  s.accessReviews.registerJobs();
  s.imports.registerJobs(); // 1.5.0, Sprint 30 (B-3801 to B-3803): harvests, model imports, bundle matching
  // 1.5.0, Sprint 32b (B-3903, B-3906): event and schedule triggers on workflows, dead letters of failed runs.
  s.workflowTriggers.install();
  s.workflowTriggers.registerJobs();
  s.workflowTriggers.listen();
  s.workflowDeadLetters.install();
  s.moderation.init(); // Sprint 26 (B-1901 to B-1907): object types, provider and sweep jobs, routing, dead letters, sign-in gate
  s.userImports.registerJobs(); // Sprint 26a (B-1805)
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
  s.scheduler.every('memory.consolidate', 24 * 60 * 60_000, activeTenants); // Sprint 30 (B-3702)
  s.scheduler.every('chat.retention', s.cfg.CHAT_RETENTION_SWEEP_MINUTES * 60_000, activeTenants);
  s.scheduler.every('chat.sweep', 15 * 60_000, activeTenants);
  s.training.schedule(s.scheduler, activeTenants);
  s.zones.schedule(s.scheduler, activeTenants);
  s.ops.schedule(s.scheduler, activeTenants);
  s.storage.schedule(s.scheduler); // 1.6.0, Sprint 35c (B-4204): the integrity check and usage samples
  s.federation.schedule(s.scheduler, activeTenants);
  s.zoneCluster.schedule(s.scheduler); // Sprint 22 (B-1405): drift checks when zones are applied in-cluster
  if (s.cfg.BILLING_CLOSE_MINUTES > 0) s.scheduler.every('billing.close', s.cfg.BILLING_CLOSE_MINUTES * 60_000, activeTenants);
  s.agentSchedules.schedule(s.scheduler); // Sprint 21 (B-1306)
  s.pki.schedule(s.scheduler); // Sprint 24 (B-1603): CRLs for every live issuer
  s.dbLeases.schedule(s.scheduler); // Sprint 25 (B-1704): the lease expiry sweeper
  s.rotation.schedule(s.scheduler); // Sprint 25 (B-1706): rotation notices
  s.revealWatch.schedule(s.scheduler); // 1.6.0, Sprint 36b (B-4803): reveal history pruned
  s.atproto.schedule(s.scheduler); // Sprint 25 (B-1611): labels from trusted external labelers
  s.feedGenerators.schedule(s.scheduler); // Sprint 31 (B-3003): feed indexes pruned to their retention
  s.files.schedule(s.cfg.FILES_PURGE_MINUTES, activeTenants); // Sprint 26d (B-2401): the trash purge
  s.moderation.schedule(); // Sprint 26 (B-1904, B-1905): SLA escalation and sanction expiry
  s.pds.schedule(); // 1.5.0, Sprint 31 (B-2904): events past the backfill window and unused blobs
  s.firehose.start(); // Sprint 27 (B-1908): firehose consumers, one instance per subscription through a lease
  s.apps.triggers.schedule(s.scheduler, s.cfg.APPS_SCHEDULE_TICK_SECONDS * 1000); // Sprint 27 (B-2206): schedule triggers
  s.workflowTriggers.schedule(s.scheduler); // 1.5.0, Sprint 32b (B-3903): workflow schedule triggers
  s.channels.schedule(); // Sprint 28a (B-2303, B-2304): IMAP polls and retention purges
  s.feed.digests.schedule(s.scheduler, activeTenants); // Sprint 28c (B-2705): trending hashtags and weekly digests
  s.accessReviews.schedule(s.scheduler); // 1.5.0, Sprint 29 (B-3305): campaigns that open, and overdue escalation
  s.imports.schedule(s.scheduler, activeTenants); // 1.5.0, Sprint 30 (B-3801, B-3803): due harvests, promoted bundles
  s.apps.forms.held.schedule(s.scheduler); // 1.6.0, Sprint 36b (B-4701): decided held submissions purged
}
