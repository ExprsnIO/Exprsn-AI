import { hostname } from 'node:os';
import type { Logger } from 'pino';
import { FILE_VARS, SERVER_ENV_NAMES, type Config } from './config/index.js';
import type { Db } from './db/knex.js';
import { AuditLog } from './audit/chain.js';
import { AuditCheckpoints } from './audit/checkpoints.js';
import { ExportService } from './audit/exports.js';
import { SiemForwarder } from './audit/siem.js';
import { SiemDestinations } from './audit/siem-destinations.js';
import { InventoryService } from './governance/inventory.js';
import { AnalyticsService } from './tenancy/analytics.js';
import { DenialAudit } from './audit/denials.js';
import { IdentityChain } from './identity/chain.js';
import { configureSecretPolicy, secretPolicy } from './identity/secrets.js';
import { parseAllowList } from './mcp/hosts.js';
import { servicePolicy } from './platform/egress.js';
import { SessionService } from './identity/sessions.js';
import { ApiKeyService, apiKeyPrefix } from './identity/apikeys.js';
import { securityAlert } from './identity/security-alerts.js';
import { MfaService } from './identity/mfa.js';
import { LoginThrottle } from './identity/lockout.js';
import { DirectorySync } from './identity/sync.js';
import { directoryImportsFor } from './identity/directory-import.js';
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
import { PushDevices } from './platform/push-devices.js';
import { NotificationPrefs } from './platform/notification-prefs.js';
import { PushService, type PushOverrides } from './push/service.js';
import { AccountService } from './identity/account.js';
import { LeakedPasswords } from './identity/leaked/service.js';
import { PasswordDenyWords } from './identity/deny-words.js';
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
import { McpServerService } from './mcp/server/service.js';
import { McpService } from './mcp/service.js';
import { ScriptService } from './scripts/service.js';
import { createScriptRunner } from './scripts/runner.js';
import { AgentService } from './agents/service.js';
import { AgentSchedules } from './agents/schedules.js';
import { EvalService } from './evals/service.js';
import { RedTeamService } from './redteam/service.js';
import { AgentIdentityService } from './agents/identity.js';
import { loadPrincipal } from './http/middleware.js';
import { WorkflowService } from './workflows/service.js';
import { DecisionService } from './decisions/service.js';
import type { HttpStepNet } from './workflows/http.js';
import { ChainRefs } from './chain/refs.js';
import { ChainService } from './chain/context.js';
import { WorkflowBundles } from './workflows/bundles.js';
import { WorkflowDeadLetters } from './workflows/dead-letters.js';
import { WorkflowTriggers } from './workflows/triggers.js';
import { WorkflowHooks } from './workflows/hooks.js';
import { WorkflowRetention } from './workflows/retention.js';
import { WorkflowTemplates } from './workflows/templates.js';
import { WorkflowAnalytics } from './workflows/analytics.js';
import { WorkflowTags } from './workflows/tags.js';
import { DesignLocks } from './realtime/design-locks.js';
import { MediaService } from './media/service.js';
import { FfmpegRunner, type MediaRunner } from './media/runner.js';
import { ImageService } from './images/service.js';
import { ImageExports } from './images/export.js';
import { ContentCredentials } from './images/content-credentials.js';
import { createBackends, HttpImageEditor, type ImageBackend, type ImageEditor } from './images/backends.js';
import { HttpSafety, noSafety, type ImageSafety } from './images/safety.js';
import { createVectorStore, LazyVectorStore, type VectorStore } from './platform/vectors.js';
import { ConnectionService } from './connections/service.js';
import { SavedQueries } from './connections/saved-queries.js';
import { RestConnections } from './connections/rest.js';
import { ExternalKnowledgeSources } from './connections/external-sources.js';
import { createDrivers, type DriverFactory } from './connections/drivers.js';
import type { Engine } from './connections/engines.js';
import { createDynamicCredentials, type DynamicCredentials } from './connections/dynamic.js';
import { KnowledgeService } from './knowledge/service.js';
import { CALLER_KIND as REVISION_CALLER, KnowledgeRevisions } from './knowledge/revisions.js';
import { CliGit, type GitFetcher } from './knowledge/sources.js';
import { MemoryService } from './memory/service.js';
import { effectivePermissions } from './authz/policy.js';
import { TrainingService } from './training/service.js';
import { createTrainer, type TrainerBackend } from './training/trainer.js';
import { createClassifierWorker, type ClassifierWorker } from './guardrails/classifier-worker.js';
import { ZoneService } from './zones/service.js';
import { createCloud, type CloudServices } from './cloud/service.js';
import { CloudCredentials } from './cloud/credentials.js';
import { OpsService } from './ops/service.js';
import { createAcme, type AcmeClient } from './ops/acme.js';
import { FederationService } from './federation/service.js';
import { createKerberos, type KerberosVerifier } from './federation/kerberos.js';
import { TenantIntegrations } from './integrations/hosts.js';
import { WebhookService } from './webhooks/service.js';
import { PromptService } from './prompts/service.js';
import { ConversationSharing } from './chat/sharing.js';
import { ChatArtifacts } from './chat/artifacts.js';
import { ChatCapabilities } from './chat/capabilities.js';
import { ProfilePreferences } from './gateway/profile-preferences.js';
import { CHAT_CALLER } from './agents/service.js';
import { BillingService } from './billing/service.js';
import { PlanCatalogue } from './billing/plans.js';
import { SubscriptionService } from './billing/subscriptions.js';
import { FeatureFlagService } from './flags/service.js';
import { StripeProvider, type BillingProvider } from './billing/stripe.js';
import { OpenAiService } from './openai/service.js';
import { createCounterStore, type CounterStore } from './platform/ratelimit.js';
import { EventCatalogue } from './events/catalogue.js';
import { createCacheStore, TenantCache } from './platform/cache.js';
import { InstanceRegistry } from './ops/instances.js';
import { JobsAdmin } from './ops/jobs-admin.js';
import { PlatformOverview } from './ops/overview.js';
import { OverviewCards } from './ops/overview-cards.js';
import { RoomRegistry } from './realtime/rooms.js';
import { PluginService } from './plugins/service.js';
import { IdentityPolicies } from './identity/policy.js';
import { SignupService } from './identity/signup.js';
import { UserImportService } from './identity/user-import.js';
import { governanceFor } from './identity/store-governance.js';
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
import { VaultShares } from './vault/shares.js';
import { ReferenceOwners } from './vault/reference-owners.js';
import { PluginSurfaces } from './plugins/surfaces.js';
import { PluginDrafts } from './plugins/drafts.js';
import { KnowledgeFeedback } from './knowledge/feedback.js';
import { KnowledgeTree } from './knowledge/tree.js';
import { DocsService } from './docs/service.js';
import { ResponseCache } from './chat/response-cache.js';
import { CredentialMoves } from './vault/credential-moves.js';
import { SigningKeyRegistry } from './vault/signing-keys.js';
import { SystemKeys } from './vault/keyring.js';
import { VaultSeal } from './vault/seal.js';
import { SecurityScans } from './security/scans.js';
import { GenericLeases } from './vault/generic-leases.js';
import { ApiKeyLeases } from './vault/apikey-leases.js';
import { builtinApiKeyProviders, type ApiKeyProviders } from './vault/apikey-providers.js';
import { ScimService } from './identity/scim/service.js';
import { DlpService } from './compliance/dlp.js';
import { LegalHolds } from './compliance/holds.js';
import { EvidenceService } from './compliance/evidence.js';
import { ComplianceExports } from './compliance/exports.js';
import { PkiService } from './pki/service.js';
import { PkiSettings } from './pki/settings.js';
import { CaTokens } from './pki/tokens.js';
import { MemberCertificates } from './pki/members.js';
import { AtprotoService } from './atproto/service.js';
import { AtprotoAccounts } from './atproto/accounts.js';
import { clears } from './authz/labels.js';
import { FileService } from './files/service.js';
import { ProcessPreviewRenderer, type PreviewRenderer } from './files/preview.js';
import { HeldWrites } from './moderation/held.js';
import { ModerationService } from './moderation/service.js';
import { ModerationMetrics } from './spam/metrics.js';
import { SpamService } from './spam/service.js';
import { FirehoseService } from './atproto/firehose.js';
import { FeedGenerators } from './atproto/feeds.js';
import { PdsService } from './atproto/pds/service.js';
import { AppService } from './apps/service.js';
import { AppExports } from './apps/exports.js';
import { AppReports } from './apps/reports.js';
import type { ModerationProviderClient } from './moderation/providers.js';
import { GroupService } from './groups/service.js';
import { CalendarService } from './groups/calendar.js';
import { GroupGovernance } from './groups/governance.js';
import { DavService } from './dav/service.js';
import { ChannelService } from './channels/service.js';
import type { ChannelIo, ChannelMailer } from './channels/mail.js';
import nodemailer from 'nodemailer';
import { SocialService } from './social/service.js';
import { PresenceService } from './profiles/presence.js';
import { SlaService } from './sla/service.js';
import { ProfileService } from './profiles/service.js';
import { MessagingService } from './messaging/service.js';
import { MessagingInsights } from './messaging/insights.js';
import { MessagingFolders } from './messaging/folders.js';
import { FeedService } from './feed/service.js';
import { SearchService } from './search/service.js';
import { SocialAdmin } from './social/admin.js';
import { BuiltinTools } from './registry/builtin/index.js';
import { WorkflowStepKit } from './workflows/steps/index.js';
import { CustomRoleService } from './authz/custom-roles.js';
import { AccessService } from './authz/access.js';
import { AccessReviewService } from './authz/reviews.js';
import { ImportService } from './imports/service.js';
import { InjectionDefence } from './guardrails/injection.js';
import { HttpToolRunner } from './registry/http-tool.js';

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
  /** 1.6.0, Sprint 38a (B-7501): per-tenant audit streaming under dual control. */
  siemDestinations: SiemDestinations;
  /** 1.6.0, Sprint 38a (B-7301, B-7302): the AI system inventory. */
  inventory: InventoryService;
  /** 1.6.0, Sprint 38a (B-7401, B-7402): usage and cost analytics. */
  analytics: AnalyticsService;
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
  /** 1.6.0 (B-8901): `impl: http` registry tools through the outbound address guard. */
  httpTools: HttpToolRunner;
  /** 1.6.0 (B-6902): the untrusted-content checkpoint, its counts per source and audit. */
  injection: InjectionDefence;
  agents: AgentService;
  /** Workflow graphs, versions and durable runs (Sprint 8). */
  workflows: WorkflowService;
  /** Sprint 46 (B-131): decision tables, evaluated by workflow steps, app flows and `decision.evaluate`. */
  decisions: DecisionService;
  /** Sprint 32 (B-4101): the chain context every invocation records itself in. */
  chains: ChainService;
  /** Sprint 34 (B-4105): the reference graph across agents, skills, tools and workflows. */
  chainRefs: ChainRefs;
  /** Media assets, presets and ffmpeg jobs (Sprint 8). */
  media: MediaService;
  /** Image generation on ComfyUI or diffusers workers (Sprint 8). */
  images: ImageService;
  /** Exports of generated images as WebP, GIF, JPEG XL, JPEG, PNG or PDF, downloaded or saved into Files (images/export.ts). */
  imageExports: ImageExports;
  /** 1.6.0 (B-7901): C2PA content credentials for generated images. */
  contentCredentials: ContentCredentials;
  /** 1.6.0 (B-8001): versioned artifacts of chat answers. */
  chatArtifacts: ChatArtifacts;
  /** 1.7.0 (B-40): what a conversation may call, the calls made from its composer and its skills. */
  chatCapabilities: ChatCapabilities;
  /** 2.0.0: default profile by tenant, workspace and person; profiles a person hides. */
  profilePreferences: ProfilePreferences;
  /** The image-safety classifier for generated images and sampled video frames. */
  imageSafety: ImageSafety;
  /** Vectors for retrieval: pgvector on PostgreSQL with the extension, else a table scan (`platform/vectors.ts`). */
  vectors: VectorStore;
  connections: ConnectionService;
  /** 1.8.0 (B-125): saved, parameterised connection queries and their read API. */
  savedQueries: SavedQueries;
  /** 1.8.0 (B-126): REST connections, their endpoints and their read API. */
  restConnections: RestConnections;
  knowledge: KnowledgeService;
  /** Migration 045: references under version control, their revisions and review. */
  knowledgeRevisions: KnowledgeRevisions;
  /** 1.8.0, Sprint 48 (B-149): "was this helpful" on documents, references and citations; stats, curation, eval seed. */
  knowledgeFeedback: KnowledgeFeedback;
  /** 1.8.0, Sprint 48 (B-149): the reference tree, breadcrumbs and backlinks. */
  knowledgeTree: KnowledgeTree;
  /** 2.0.x: documentation sites over knowledge bases (`docs/service.ts`). */
  docs: DocsService;
  memory: MemoryService;
  /** Sprint 9: datasets, training jobs, windows, evals and packaging. */
  training: TrainingService;
  trainer: TrainerBackend;
  /** 1.7.0 (B-3806): the worker that serves imported text-classification models. */
  classifierWorker: ClassifierWorker;
  /** Sprint 9: network zones, ceilings, proposals and rendered configuration. */
  zones: ZoneService;
  /** Sprint 9: import bundles, mirrors, ACME certificates, backups and restore drills. */
  ops: OpsService;
  acme: AcmeClient;
  /** Sprint 9: OIDC provider, SAML IdP, upstream federation, Kerberos SPNEGO and device flow. */
  federation: FederationService;
  kerberos: KerberosVerifier;
  account: AccountService;
  /** 1.9.0, Sprint 55 (B-192, B-193): leaked-password lists and the checks against them (`check`, `atSignIn`). */
  leakedPasswords: LeakedPasswords;
  /** 1.9.0, Sprint 55 (B-194): the words a tenant forbids inside passwords (`check`). */
  passwordDenyWords: PasswordDenyWords;
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
  /** 1.9.0, Sprint 51 (B-162): the plan catalogue (dual control) and tenants' subscriptions with their history. */
  plans: PlanCatalogue;
  subscriptions: SubscriptionService;
  /** 1.9.0, Sprint 52 (B-167 to B-169): feature flags, `s.flags.on(ctx, key)` / `value(ctx, key)`, cached and cleared over the bus. */
  flags: FeatureFlagService;
  /** Sprint 13: the OpenAI-compatible API behind /v1. */
  openai: OpenAiService;
  /** Sprint 21: scheduled agent runs (B-1306). */
  agentSchedules: AgentSchedules;
  /** Sprint 21: eval sets, runs and the publish gate for profiles (B-1303). */
  evals: EvalService;
  /** 1.6.0 Sprint 38b: red-team suites (B-7001, B-7002). */
  redteam: RedTeamService;
  /** 1.6.0 Sprint 38b: agent identities (B-7701). */
  agentIdentities: AgentIdentityService;
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
  /** 1.8.0, Sprint 48 (B-148): each admin's Overview cards and the optional cards' figures. */
  overviewCards: OverviewCards;
  /** 1.9.0, Sprint 49 (B-150): each person's push devices; `forDelivery` and `markGone` for the delivery job. */
  pushDevices: PushDevices;
  /** 1.9.0, Sprint 49 (B-153): notification preferences, tenant defaults and digests; `decide` for every delivery path. */
  notificationPrefs: NotificationPrefs;
  /** 1.9.0, Sprint 49 (B-151, B-152): push providers, delivery over providers and the console's socket, the log. */
  push: PushService;
  /** 1.6.0 (B-4203): Jobs and queues: job types, jobs, schedules, dead letters and the tenant cache. */
  jobsAdmin: JobsAdmin;
  /** Sprint 24 (B-1701 to B-1703): the tenant secrets vault (KV secrets, transit keys, path policies). */
  vault: VaultService;
  /** Sprint 24 (B-1601 to B-1604): the certificate authority (issuers, profiles, issuance, CRLs, OCSP). */
  pki: PkiService;
  /** 1.9.0 (B-187): the CA's settings (Certificates › Settings) with the environment as default and floor. */
  pkiSettings: PkiSettings;
  /** 1.9.0 (B-188): CA tokens and one-time tickets, signed in custody. */
  caTokens: CaTokens;
  /** 1.9.0 (B-189): member certificates, certificate sign-in and mTLS. */
  memberCerts: MemberCertificates;
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
  /** 1.6.0, Sprint 37c (B-4801): KV secrets shared with a principal, as policy grants. */
  vaultShares: VaultShares;
  /** 1.7.0 (B-9209): a workspace or a service as the owner of a saved vault reference. */
  referenceOwners: ReferenceOwners;
  /** 1.7.0 (B-9207): the other domains' signing keys registered with the vault by reference. */
  signingKeys: SigningKeyRegistry;
  /** 1.7.0 (B-9208): third-party credentials moved to vault paths, and the integrations' way to read them. */
  credentialMoves: CredentialMoves;
  /** 1.7.0 (B-99): the answer cache of chat and /v1 turns. */
  responseCache: ResponseCache;
  /** 1.7.0 (B-112): plugin UI surfaces and their bridge. */
  pluginSurfaces: PluginSurfaces;
  /** 1.8.0, Sprint 48 (B-147): the plugin creator's drafts (manifests only; nothing is loaded). */
  pluginDrafts: PluginDrafts;
  /** 1.7.0 (B-9201, B-9203, B-9205): the platform's named HMAC keys, read from the vault's platform scope and cached. */
  sysKeys: SystemKeys;
  /** 1.8.0, Sprint 48 (B-145): the emergency vault seal: dual control or break-glass, unsealed by the escrow quorum. */
  vaultSeal: VaultSeal;
  /** 1.8.0, Sprint 48 (B-144): security scan results attached to artefacts, and the promotion gate. */
  securityScans: SecurityScans;
  /** 1.7.0 (B-9204): the generic lease table (`vault_leases`). */
  leases: GenericLeases;
  /** 1.7.0 (B-9301, B-9302): dynamic API-key leases: the built-in `exprsn` provider and outside providers. */
  apiKeyLeases: ApiKeyLeases;
  /** 1.6.0, Sprint 37c (B-7201, B-7202): SCIM 2.0 users and groups pushed to a tenant's SCIM store. */
  scim: ScimService;
  /** 1.6.0, Sprint 38c (B-7601): DLP rules and patterns; answers, outputs and uploads classified and acted on. */
  dlp: DlpService;
  /** 1.6.0, Sprint 38c (B-7602): legal holds on users and workspaces, under dual control, suspending purges. */
  legalHolds: LegalHolds;
  /** 1.6.0, Sprint 38c (B-7603): compliance exports for eDiscovery, as sealed JSON Lines. */
  complianceExports: ComplianceExports;
  /** 1.7.0 (B-9502, B-9504): what purges must keep (open moderation cases, case and object holds), and its export. */
  evidence: EvidenceService;
  /** 1.4.0, Sprint 25 (B-1608 to B-1611): service DIDs, their keys, the signed labeler and trusted external labelers. */
  atproto: AtprotoService;
  /** 1.4.0, Sprint 26 (B-1807, B-1808): user DIDs and handles, and sign-in with AT-Protocol accounts. */
  atprotoAccounts: AtprotoAccounts;
  /** 1.4.0, Sprint 26d (B-2401 to B-2405): workspace folders and files, versions, trash, shares, quotas, previews. */
  files: FileService;
  /** 1.4.0, Sprint 26 (B-1901 to B-1907): moderation checks, reports, actions, appeals, sanctions, queues, providers. */
  moderation: ModerationService;
  /** 1.9.0, Sprint 50 (B-159 to B-161): rate signals, spam patterns and graduated responses. */
  spam: SpamService;
  /** 1.9.0, Sprint 50 (B-158): guardrail and moderation metrics per day. */
  moderationMetrics: ModerationMetrics;
  /** 1.7.0 (B-9401 to B-9403): writes the user-input guardrail holds for review instead of refusing. */
  held: HeldWrites;
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
  /** 1.8.0, Sprint 44 (B-122): reports of an app, computed as the viewer, with run history and sealed, expiring results. */
  appReports: AppReports;
  /** 1.8.0, Sprint 44 (B-123): XLSX, PDF, CSV and HTML exports of records, views, reports and dashboards; `render`. */
  appExports: AppExports;
  /** 1.4.0, Sprint 27c (B-2501, B-2505): groups in workspaces, members, requests, invitations, posts and their moderation. */
  groups: GroupService;
  /** 1.4.0, Sprint 27c (B-2502 to B-2504): group events, RSVPs, check-in, reminders and signed iCalendar feeds. */
  calendar: CalendarService;
  /** 1.9.0, Sprint 53 (B-174 to B-176): group proposals, voting, carrying out decisions, and the group budget. */
  groupGovernance: GroupGovernance;
  /** 1.4.0, Sprint 28a (B-2301 to B-2304): customer-service channels: sessions, held replies, email, retention. */
  channels: ChannelService;
  /** 1.4.0, Sprint 28b (B-2606 with B-2702): blocks, mutes, follows, lists and contact rules, shared by messaging and the feed. */
  social: SocialService;
  /** 1.5.0, Sprint 34c (B-5801): profiles: pronouns, bio and an avatar from the file store, visible by workspace and clearance. */
  people: ProfileService;
  /** 1.5.0, Sprint 34c (B-5802): presence status, chosen or derived from connections and idle time. */
  presence: PresenceService;
  /** Sprint 46 (B-134): SLA timers and assignment routing for channel sessions, flags, held writes and appeals. */
  sla: SlaService;
  /** 1.4.0, Sprint 28b (B-2601 to B-2604): direct and group conversations, sealed messages, receipts, presence, mutes. */
  messaging: MessagingService;
  /** 1.4.0, Sprint 28b (B-2605): keyword and semantic search, thread summaries and catch-up digests. */
  messagingInsights: MessagingInsights;
  /** Each person's own folders for the conversations they are in (Inbox, Archive and custom folders). */
  messagingFolders: MessagingFolders;
  /** 1.4.0, Sprint 28c (B-2701 to B-2705): the workspace feed: posts, comments, reactions, reposts, bookmarks, feeds, trending tags and digests. */
  feed: FeedService;
  /** 1.9.0, Sprint 52 (B-170 to B-173): the blind search index, search across chats and posts, and the one search box. */
  search: SearchService;
  /** 1.6.0 (B-4206): the Social and messaging screen: workspace policies, digest settings, legal-hold exports, realtime counts. */
  socialAdmin: SocialAdmin;
  /** 1.6.0, Sprint 37b (B-7101): each workspace's MCP server: publications, the tool catalogue, calls and held calls. */
  mcpServer: McpServerService;
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
  /** 1.8.0, Sprint 46 (B-130, B-135): every workflow's signed webhook trigger, and run retention. */
  workflowHooks: WorkflowHooks;
  workflowRetention: WorkflowRetention;
  /** 1.8.0, Sprint 47 (B-136, B-139): the template gallery, and workflow analytics with the running-now board. */
  workflowTemplates: WorkflowTemplates;
  workflowAnalytics: WorkflowAnalytics;
  /** 1.8.0, Sprint 47 (B-137, B-140): workflow tags and favourites; presence and edit locks in the designers. */
  workflowTags: WorkflowTags;
  designLocks: DesignLocks;
  /** 1.6.0, Sprint 35c (B-4205): settings each instance reads, overrides under dual control. */
  settings: SettingsService;
  /** 1.6.0, Sprint 35c (B-4204): stores, usage, quarantine, integrity, purges and blob store migration. */
  storage: StorageService;
  /** 1.9.99-final, Sprint 56 (B-100): the cloud plane: accounts, regions, validation (and, from their modules, credentials and provider adapters). */
  cloud: CloudServices;
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
  /** 1.7.0: the CPU image editor (tests use a fake). */
  imageEditor?: ImageEditor;
  imageSafety?: ImageSafety;
  vectors?: VectorStore;
  /** Data connection drivers by engine (tests use in-process fakes). */
  drivers?: Partial<Record<Engine, DriverFactory>>;
  /** OpenBao database-engine credentials for data connections (tests point it at a fake). */
  dynamicCredentials?: DynamicCredentials | null;
  git?: GitFetcher;
  /** 1.6.0 (B-8204): git options for app packages (tests allow file:// repositories). */
  appGit?: { allowFile: boolean; timeoutMs: number };
  trainer?: TrainerBackend;
  classifierWorker?: ClassifierWorker;
  acme?: AcmeClient;
  kerberos?: KerberosVerifier;
  /** Email transport (tests record messages instead of sending them). */
  mail?: MailTransport;
  /** Sprint 13: the billing provider (tests use a fake Stripe). */
  billingProvider?: BillingProvider | null;
  /** Sprint 25 (B-1704): the database engines behind leases (tests use an in-memory fake). */
  dbAdmins?: DbAdminFactory;
  /** 1.7.0 (B-9302): more outside API-key providers by kind, beside the built-in ones (tests may add a fake). */
  apiKeyProviders?: ApiKeyProviders;
  /** Sprint 26d (B-2404): the file store's preview renderer (tests use an in-process fake). */
  previewRenderer?: PreviewRenderer;
  /** Sprint 26 (B-1906): external moderation providers (tests use a fake). */
  moderationProviders?: ModerationProviderClient;
  /** Sprint 28a (B-2303): the channels' IMAP fetcher and SMTP transports (tests use fakes; never a real mailbox). */
  channelIo?: Partial<ChannelIo>;
  /** 1.7.0 (B-9101): DNS and routing for workflow HTTP steps (tests serve a "public" host on loopback). */
  workflowHttpNet?: HttpStepNet;
  /** 1.7.0 (B-9203): a bus shared by two service sets in one process, as Redis shares it between instances (tests). */
  bus?: Bus;
  /** 1.9.0 (B-152): push delivery's clock, fake provider origins and their CA (tests only). */
  push?: PushOverrides;
}

export function createServices(cfg: Config, db: Db, log: Logger, metrics = new Metrics(), overrides: ServiceOverrides = {}): Services {
  // Sprint 22 (B-1401): tracing, and spans for database queries made inside a trace.
  const tracer = new Tracer({ url: tracesUrl(cfg), serviceName: cfg.OTEL_SERVICE_NAME, serviceVersion: process.env.npm_package_version ?? '', headers: parseOtlpHeaders(cfg.OTEL_EXPORTER_OTLP_HEADERS), ratio: cfg.OTEL_TRACES_SAMPLE_RATIO, maxQueue: cfg.OTEL_BSP_MAX_QUEUE_SIZE, delayMs: cfg.OTEL_BSP_SCHEDULE_DELAY, timeoutMs: cfg.OTEL_EXPORTER_OTLP_TIMEOUT }, log);
  if (tracer.enabled) instrumentKnex(db, cfg.DB_CLIENT === 'pg' ? 'postgresql' : cfg.DB_CLIENT);
  const bus = overrides.bus ?? new Bus(log, cfg.REDIS_URL);
  // 1.7.0 (B-9205): the named keys that replace the SESSION_SECRET derivations; version 1 of each is that secret.
  const sysKeys = new SystemKeys(() => s, { bootstrapSecret: cfg.SESSION_SECRET, refreshSeconds: cfg.VAULT_SYS_REFRESH_SECONDS });
  // Sprint 15: with a previous KEK configured, reads fall back to it until `kms:rewrap` has moved everything.
  // 1.8.0 (B-145): every key operation goes through the seal's gate; while sealed it answers 503 "Vault sealed".
  const vaultSeal = new VaultSeal(() => s);
  const kms = vaultSeal.guardKms(overrides.kms ?? withPrevious(createKms(cfg), createPreviousKms(cfg)));
  const keys = new DataKeys(db, kms, cfg.OPENBAO_KEY_PREFIX, cfg.DATA_KEY, bus);
  keys.sealCheck = () => vaultSeal.assertOpen();
  // 1.6.0 (B-4204): the store can move to another one while the server runs (ops/storage.ts).
  const blobs = new SwitchableBlobStore(overrides.blobs ?? createBlobStore(cfg));
  const mode = cfg.JOB_QUEUE === 'auto' ? (cfg.REDIS_URL ? 'bullmq' : 'db') : cfg.JOB_QUEUE;
  // JOB_TYPE_LIMITS: how many of the instance's slots one job type may take (`knowledge.sync=2`).
  const typeLimits = Object.fromEntries(cfg.JOB_TYPE_LIMITS.split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const [type, n] = x.split('='); return [type!.trim(), Number(n)]; }));
  const jobs = new JobQueue(db, log, bus, { mode, redisUrl: cfg.REDIS_URL, pollMs: cfg.JOB_POLL_MS, concurrency: cfg.JOB_CONCURRENCY, typeLimits });
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
    // 1.7.0 (B-9206): CREDENTIAL_STORE=leases makes a new session (and a new API key) a lease; both stores are read.
    { secret: sysKeys.key('session'), idleMinutes: cfg.SESSION_IDLE_MINUTES, absoluteHours: cfg.SESSION_ABSOLUTE_HOURS, pendingMinutes: cfg.MFA_PENDING_MINUTES, store: cfg.CREDENTIAL_STORE, leases: () => s.leases },
    (ids) => bus.publish(TOPICS.sessionsRevoked, ids)
  );
  const apiKeys = new ApiKeyService(db, sysKeys.key('api-key'), async (leaseId) => (await s.leases.check({ id: leaseId })) != null, {
    store: cfg.CREDENTIAL_STORE,
    leases: () => s.leases,
    // 1.8.0 (B-146): a use-limited key that spent its last use was revoked: audited, and its owner told.
    onExhausted: async (k) => {
      await s.audit.append({ tenantId: k.tenant_id, action: 'apikey.exhausted', kind: 'auth', actor: { service: 'identity.api-keys' }, target: { key: k.id, prefix: k.prefix, ...(k.agent_id ? { agent: k.agent_id } : {}) }, detail: { maxUses: k.max_uses, store: k.store_lease_id ? 'lease' : 'table' } });
      await securityAlert(s, { tenantId: k.tenant_id, userId: k.user_id, event: 'api_key.exhausted', detail: `Key "${k.name}" (${apiKeyPrefix(k)}…) was used ${k.max_uses} time${k.max_uses === 1 ? '' : 's'}, its limit.` });
    }
  });
  const siem = new SiemForwarder(audit, log, { url: cfg.SIEM_URL, token: cfg.SIEM_TOKEN });
  const quotas = new QuotaService(db);
  const gateway = new Gateway(new GatewayRepo(db), bus, log, { pollMs: cfg.OLLAMA_POLL_MS, timeoutMs: cfg.OLLAMA_TIMEOUT_MS, maxInflight: cfg.OLLAMA_MAX_INFLIGHT, maxLoadsPer10Min: cfg.OLLAMA_MAX_LOADS_PER_10_MIN, queueTimeoutMs: cfg.OLLAMA_QUEUE_TIMEOUT_MS, policy: servicePolicy(cfg), loadTimeoutMs: cfg.OLLAMA_LOAD_TIMEOUT_MS }, jobs);
  const attachments = new AttachmentService(db, blobs, keys, jobs, bus, { maxBytes: cfg.ATTACHMENT_MAX_BYTES, ...(cfg.CLAMD_HOST ? { clamd: { host: cfg.CLAMD_HOST, port: cfg.CLAMD_PORT } } : {}) });
  const calc = new CalcWorker();
  const guard = createGuardrails({ db, keys, gateway, bus, notifications, jobs, log });
  // 1.6.0, Sprint 38c: DLP and legal holds read their collaborators lazily; chat, uploads, memory and files take them now.
  const dlp = new DlpService(() => s);
  const legalHolds = new LegalHolds(() => s);
  const evidence = new EvidenceService(() => s);
  attachments.dlp = dlp;
  const chat = new ChatService(db, keys, gateway, quotas, audit, bus, attachments, calc, log, guard.engine, {
    store: cfg.REDIS_URL ? new RedisStreamStore(cfg.REDIS_URL, keys, log) : new DbStreamStore(db, keys),
    flags: guard.flags,
    notifications,
    dlp,
    legalHolds,
    evidence,
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
  guard.flags.heldAnswer = (tenantId, messageId, kind) => (kind === 'api-request' ? s.openai.holds.heldText(tenantId, messageId) : kind === 'channel-message' ? s.channels.heldText(tenantId, messageId) : kind === 'app-form-submission' ? s.apps.forms.held.heldText(tenantId, messageId) : kind === CHAT_CALLER ? s.chatCapabilities.heldText(tenantId, messageId) : kind === 'held-write' ? s.held.heldText(tenantId, messageId) : chat.heldText(tenantId, messageId));
  const registry = new RegistryService(db);
  const chainRefs = new ChainRefs(db, registry);
  registry.useRefs(chainRefs);
  const mcp = new McpService(db, keys, registry, audit, notifications, log, { allowedHosts: cfg.MCP_ALLOWED_HOSTS, timeoutMs: cfg.MCP_TIMEOUT_MS, secret: sysKeys.key('federation'), callbackUrl: `${cfg.PUBLIC_URL.replace(/\/+$/, '')}/api/mcp-oauth/callback` });
  const scripts = new ScriptService(db, keys, jobs, bus, registry, () => s.guardrails, createScriptRunner(cfg), log);
  const tools = new ToolDispatcher(registry, mcp, scripts, calc, () => s.guardrails);
  chat.useTools(tools);
  // 1.7.0 (B-4005): the skills added to a conversation join each turn's system prompt.
  chat.turnSkills = (p, c, profile, messageId) => s.chatCapabilities.turnSkills(p, c, profile, messageId);
  // 1.6.0 (B-6902, B-8901): tool results pass the untrusted-content checkpoint; HTTP tools go through the address guard.
  const injection = new InjectionDefence(db, () => s.guardrails, audit);
  tools.useInjection(injection);
  const httpTools = new HttpToolRunner({ db, audit, log, policy: servicePolicy(cfg), tenantHosts: (t) => s.integrations.allowList(t), vault: (t, owner, ref, via) => s.vault.resolveFor(t, owner, ref, { via }), maxTimeoutMs: cfg.HTTP_TOOL_TIMEOUT_MS, maxResponseBytes: cfg.HTTP_TOOL_MAX_RESPONSE_BYTES });
  tools.useHttp(httpTools);
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
  const decisions = new DecisionService(db);
  const workflows = new WorkflowService({ db, keys, gateway, quotas, audit, bus, jobs, notifications, calc, registry, tools, log, guardrails: () => s.guardrails, flags: () => s.flags, principalFor: (t, u) => loadPrincipal(s, t, u, {}), http: { hosts: cfg.WORKFLOW_HTTP_HOSTS.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean), allowLoopback: cfg.WORKFLOW_HTTP_ALLOW_LOOPBACK, ...(overrides.workflowHttpNet ? { net: overrides.workflowHttpNet } : {}) }, tenantHosts: (t) => s.integrations.allowList(t), onCallerDone: async (t, kind, id) => void (kind === 'agent-run' ? await agents.resumeAwaiting(t, id) : kind === CHAT_CALLER ? await s.chatCapabilities.callerDone(t, id) : kind === 'app-deployment' ? await s.apps.pipelines.approvalDone(t, id) : kind === REVISION_CALLER ? await s.knowledgeRevisions.approvalDone(t, id) : undefined), vault: { check: (p, refs) => s.vault.assertRefsReadable(p, refs), read: (p, ref, via) => s.vault.readAs(p, ref, { via }) }, chains, agents: () => agents, scripts: () => scripts, refs: chainRefs, decisions: () => decisions });
  tools.useWorkflows(workflows);
  // Sprint 34 (B-4102): agents delegate to agents through the dispatcher.
  tools.useAgents(agents);
  // Sprint 32: agent runs join chains, and an agent run a workflow step awaits resumes that workflow run when it ends.
  agents.chains = chains;
  agents.onCallerDone = async (t, kind, id) => void (kind === 'workflow-run' ? await workflows.resumeFromCaller(t, id) : kind === CHAT_CALLER ? await s.chatCapabilities.callerDone(t, id) : kind === 'redteam-run' ? await s.redteam.childDone(t, id) : undefined);
  // 1.6.0 Sprint 38b (B-7701): a run of an agent with an identity acts within the identity's roles and ceiling.
  agents.identity = (p, agentName) => s.agentIdentities.narrow(p, agentName);
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
  const images = new ImageService({ get c2pa() { return s.contentCredentials; }, db, keys, blobs, jobs, bus, kms, audit, quotas, notifications, log, backends: overrides.imageBackends ?? createBackends(cfg.IMAGE_BACKENDS, servicePolicy(cfg)), safety: () => s.imageSafety, safetyThreshold: cfg.IMAGE_SAFETY_THRESHOLD, safetyRequired: cfg.IMAGE_SAFETY_REQUIRED, guardrails: () => s.guardrails, provenanceKey: `${cfg.OPENBAO_KEY_PREFIX}image-provenance`, editor: overrides.imageEditor ?? (cfg.IMAGE_EDIT_URL ? new HttpImageEditor(cfg.IMAGE_EDIT_URL, servicePolicy(cfg)) : null), attachments: () => s.attachments, preference: cfg.IMAGE_PREFERENCE.split(',').map((v) => v.trim()).filter(Boolean) });
  // Checkpoints go through whatever `s.guardrails` is when they run.
  const checkpoint: Guardrails = { check: (input) => s.guardrails.check(input) };
  const vectors = overrides.vectors ?? new LazyVectorStore(() => createVectorStore(db, cfg.DB_CLIENT, log));
  const connections = new ConnectionService(db, keys, audit, checkpoint, { ...createDrivers(parseAllowList(cfg.CONNECTIONS_ALLOWED_HOSTS), { azureAuthority: cfg.CLOUD_AZURE_AUTHORITY }), ...overrides.drivers }, overrides.dynamicCredentials !== undefined ? overrides.dynamicCredentials : createDynamicCredentials(cfg));
  const knowledge = new KnowledgeService(
    { db, keys, blobs, jobs, gateway, vectors, audit, quotas, guard: checkpoint, connections, log, workspaces: async (p) => (effectivePermissions(p).has('tenant:manage') ? await tenants.workspaces(p.tenantId) : await tenants.workspacesForUser(p.tenantId, p.userId)).map((w) => w.id), socialGroups: async (p) => [...(await s.groups.subjects.of(p))], safety: () => s.imageSafety, safetyThreshold: cfg.IMAGE_SAFETY_THRESHOLD, safetyRequired: cfg.IMAGE_SAFETY_REQUIRED, classifiers: guard.classifiers, injection: () => s.injection },
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
  // Migration 045: an approved revision's document was indexed or refused.
  knowledge.settled.push((doc) => s.knowledgeRevisions.docSettled(doc));
  // 1.8.0, Sprint 48 (B-149): after that, a just-published reference's links are written again (backlinks).
  knowledge.settled.push((doc) => s.knowledgeTree.docSettled(doc));
  const memory = new MemoryService({ db, keys, blobs, jobs, gateway, vectors, audit, guard: checkpoint, terms: knowledge.terms, log, embed: (t, m, x, l, u, o) => knowledge.embed(t, m, x, l, u, o), holds: legalHolds });
  agents.dlp = dlp; // 1.6.0, Sprint 38c (B-7601): run outputs classified
  agents.guard = () => s.guardrails; // an agent's own rule sets on a run's task and answer
  chat.contextProviders.push((r) => knowledge.contextFor(r), (r) => memory.contextFor(r));
  agents.memories = (p, agent, label) => memory.forAgent(p, agent, label);
  agents.proposeMemory = (p, input) => memory.proposeForAgent(p, input);
  agents.memoryExtract = (e) => memory.onRun(e);
  memory.runTexts = (t, id) => agents.runTexts(t, id);
  chat.answerListeners.push((e) => memory.onAnswer(e));
  // 1.6.0 (B-8001): fenced blocks in a finished answer become artifacts (or versions of them).
  chat.answerListeners.push((e) => void s.chatArtifacts.onAnswer(e).catch((err: Error) => log.warn({ err: err.message, message: e.messageId }, 'artifact extraction failed')));
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
    siemDestinations: new SiemDestinations(db, audit, keys, log, { policy: servicePolicy(cfg), hostname: hostname(), maxPerTenant: cfg.SIEM_TENANT_MAX_DESTINATIONS }),
    inventory: new InventoryService(db, audit),
    analytics: new AnalyticsService(db),
    tenants,
    users,
    providers,
    chain,
    sessions,
    apiKeys,
    mfa: new MfaService(db, keys.sealer(PLATFORM_SCOPE), { issuer: 'Exprsn-AI', rpId: cfg.WEBAUTHN_RP_ID, rpName: cfg.WEBAUTHN_RP_NAME, origin: cfg.ORIGIN, origins: cfg.ORIGINS, secret: sysKeys.key('mfa') }),
    throttle: new LoginThrottle(db, { maxAttempts: cfg.LOCKOUT_MAX_ATTEMPTS, windowMinutes: cfg.LOCKOUT_WINDOW_MINUTES, durationMinutes: cfg.LOCKOUT_DURATION_MINUTES }),
    sync: new DirectorySync(db, providers, users, chain, sessions, apiKeys, audit, notifications, log),
    quotas,
    offboarding: new Offboarding(db, keys, blobs, jobs, sessions, apiKeys),
    gateway,
    attachments,
    calc,
    chat,
    guardrails: guard.engine,
    guard,
    registry,
    injection,
    httpTools,
    mcp,
    scripts,
    tools,
    agents,
    workflows,
    decisions,
    chains,
    chainRefs,
    media,
    images,
    imageSafety: overrides.imageSafety ?? (cfg.IMAGE_SAFETY_URL ? new HttpSafety(cfg.IMAGE_SAFETY_URL) : noSafety),
    vectors,
    connections,
    savedQueries: new SavedQueries(() => s),
    restConnections: new RestConnections(() => s),
    imageExports: new ImageExports(() => s),
    knowledge,
    knowledgeRevisions: new KnowledgeRevisions(() => s),
    knowledgeFeedback: new KnowledgeFeedback(() => s),
    knowledgeTree: new KnowledgeTree(() => s),
    docs: new DocsService(() => s),
    memory,
    // Sprint 9 services read their collaborators through `s`.
    training: new TrainingService(() => s),
    trainer: overrides.trainer ?? createTrainer(cfg),
    classifierWorker: overrides.classifierWorker ?? createClassifierWorker(cfg),
    zones: new ZoneService(() => s),
    cloud: createCloud(() => s),
    ops: new OpsService(() => s),
    acme: overrides.acme ?? createAcme(cfg),
    federation: new FederationService(() => s),
    kerberos: overrides.kerberos ?? createKerberos(cfg),
    // Sprint 11: account self-service.
    account: new AccountService(() => s),
    // 1.9.0, Sprint 55 (B-192 to B-194): leaked-password lists and tenant deny words.
    leakedPasswords: new LeakedPasswords(() => s),
    passwordDenyWords: new PasswordDenyWords(() => s),
    // Sprint 13 services read their collaborators through `s`.
    integrations: new TenantIntegrations(db),
    webhooks: new WebhookService(() => s, { allowedHosts: cfg.WEBHOOK_ALLOWED_HOSTS, timeoutMs: cfg.WEBHOOK_TIMEOUT_MS, maxAttempts: cfg.WEBHOOK_MAX_ATTEMPTS, retryBaseMs: cfg.WEBHOOK_RETRY_BASE_MS, breakerThreshold: cfg.WEBHOOK_BREAKER_THRESHOLD, breakerCooldownMs: cfg.WEBHOOK_BREAKER_COOLDOWN_MS, endpointConcurrency: Math.max(1, Math.floor(cfg.JOB_CONCURRENCY / 2)) }),
    prompts: new PromptService(() => s),
    sharing: new ConversationSharing(() => s),
    chatArtifacts: new ChatArtifacts(() => s),
    chatCapabilities: new ChatCapabilities(() => s),
    profilePreferences: new ProfilePreferences(db),
    contentCredentials: new ContentCredentials(() => s),
    plans: new PlanCatalogue(() => s),
    subscriptions: new SubscriptionService(() => s),
    flags: new FeatureFlagService(() => s),
    billing: new BillingService(
      () => s,
      overrides.billingProvider !== undefined ? overrides.billingProvider : cfg.BILLING_PROVIDER === 'stripe' && cfg.STRIPE_SECRET_KEY ? new StripeProvider({ secretKey: cfg.STRIPE_SECRET_KEY, apiUrl: cfg.STRIPE_API_URL, timeoutMs: 30_000, daysUntilDue: cfg.STRIPE_DAYS_UNTIL_DUE }) : null
    ),
    openai: new OpenAiService(() => s, { streamMode: cfg.OPENAI_STREAM_MODE }),
    agentSchedules: new AgentSchedules(() => s),
    evals: new EvalService(() => s),
    redteam: new RedTeamService(() => s),
    agentIdentities: new AgentIdentityService(() => s),
    counters,
    tracer,
    schema: new SchemaGuard(db, log, cfg.SCHEMA_CHECK_SECONDS * 1000),
    zoneCluster: new ZoneCluster(() => s),
    instances: new InstanceRegistry(() => s, bus, { heartbeatMs: 30_000, id: overrides.instanceId ?? jobs.workerId }),
    overview: new PlatformOverview(() => s),
    overviewCards: new OverviewCards(() => s),
    pushDevices: new PushDevices(() => s),
    notificationPrefs: new NotificationPrefs(() => s),
    push: new PushService(() => s, overrides.push ?? {}),
    jobsAdmin: new JobsAdmin(() => s),
    vault: new VaultService(() => s, { maxVersions: cfg.VAULT_KV_MAX_VERSIONS }),
    pki: new PkiService(() => s),
    pkiSettings: new PkiSettings(() => s),
    caTokens: new CaTokens(() => s),
    memberCerts: new MemberCertificates(() => s),
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
    vaultShares: new VaultShares(() => s),
    referenceOwners: new ReferenceOwners(() => s),
    signingKeys: new SigningKeyRegistry(() => s),
    credentialMoves: new CredentialMoves(() => s),
    responseCache: new ResponseCache(() => s),
    pluginSurfaces: new PluginSurfaces(() => s),
    pluginDrafts: new PluginDrafts(() => s),
    sysKeys,
    vaultSeal,
    securityScans: new SecurityScans(() => s),
    leases: new GenericLeases(() => s, { cacheMs: cfg.VAULT_LEASE_CACHE_MS, sweepSeconds: cfg.VAULT_LEASE_SWEEP_SECONDS }),
    apiKeyLeases: new ApiKeyLeases(() => s, { providers: { ...builtinApiKeyProviders(), ...(overrides.apiKeyProviders ?? {}) }, policy: servicePolicy(cfg), defaultTtlS: cfg.VAULT_LEASE_DEFAULT_TTL_SECONDS, maxTtlS: cfg.VAULT_LEASE_MAX_TTL_SECONDS, maxActive: cfg.VAULT_APIKEY_LEASES_MAX }),
    scim: new ScimService(() => s),
    dlp,
    legalHolds,
    complianceExports: new ComplianceExports(() => s),
    evidence,
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
    spam: new SpamService(() => s),
    moderationMetrics: new ModerationMetrics(() => s),
    held: new HeldWrites(() => s),
    identityPolicy: new IdentityPolicies(() => s),
    signup: new SignupService(() => s),
    userImports: new UserImportService(() => s),
    // 1.4.0, Sprint 27: the firehose.
    firehose: new FirehoseService(() => s, { tickMs: cfg.FIREHOSE_TICK_MS, checkpointMs: cfg.FIREHOSE_CHECKPOINT_MS, queueMax: cfg.FIREHOSE_QUEUE_MAX, backoffMaxMs: cfg.FIREHOSE_BACKOFF_MAX_MS, idleMs: cfg.FIREHOSE_IDLE_MS, maxPerTenant: cfg.FIREHOSE_MAX_PER_TENANT, rejectAudits: cfg.FIREHOSE_REJECT_AUDITS }),
    feedGenerators: new FeedGenerators(() => s, { maxPerTenant: cfg.FEEDS_MAX_PER_TENANT, itemsMax: cfg.FEED_ITEMS_MAX }),
    // 1.5.0, Sprint 31: the PDS.
    pds: new PdsService(() => s),
    apps: new AppService(() => s, { maxImportBytes: cfg.APPS_IMPORT_MAX_BYTES, maxImportRows: cfg.APPS_IMPORT_MAX_ROWS, maxExportRows: cfg.APPS_EXPORT_MAX_ROWS, maxBulk: cfg.APPS_BULK_MAX, triggerMaxDepth: cfg.APPS_TRIGGER_MAX_DEPTH, git: overrides.appGit ?? { allowFile: cfg.APPS_GIT_ALLOW_FILE, timeoutMs: cfg.APPS_GIT_TIMEOUT_MS } }),
    appReports: new AppReports(() => s),
    appExports: new AppExports(() => s),
    // 1.4.0, Sprint 27c: groups and events.
    groups: new GroupService(() => s, { inviteDays: cfg.GROUP_INVITE_DAYS, requestDays: cfg.GROUP_REQUEST_DAYS }),
    calendar: new CalendarService(() => s, { feedMaxLabel: cfg.CALENDAR_FEED_MAX_LABEL }),
    groupGovernance: new GroupGovernance(() => s),
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
    sla: new SlaService(() => s),
    messaging: new MessagingService(() => s, { maxMembers: cfg.MESSAGING_MAX_MEMBERS, embedModel: cfg.MESSAGING_EMBED_MODEL || null }),
    messagingInsights: new MessagingInsights(() => s, { summaryProfile: cfg.MESSAGING_SUMMARY_PROFILE, maxMessages: cfg.MESSAGING_SUMMARY_MAX_MESSAGES }),
    messagingFolders: new MessagingFolders(() => s),
    // 1.4.0, Sprint 28c: the workspace feed.
    feed: new FeedService(() => s),
    search: new SearchService(() => s),
    socialAdmin: new SocialAdmin(() => s),
    mcpServer: new McpServerService(() => s),
    // 1.5.0, Sprint 29: custom roles, effective access and access reviews.
    customRoles: new CustomRoleService(() => s),
    access: new AccessService(() => s),
    accessReviews: new AccessReviewService(() => s),
    // 1.5.0, Sprint 30: CalDAV and CardDAV.
    dav: new DavService(() => s, db, sysKeys.key('app-password')),
    // 1.5.0, Sprint 30: the import wizard's server side.
    imports: new ImportService(() => s, cfg),
    // 1.5.0, Sprint 32b: workflows started by events and schedules, dead letters, bundles.
    workflowTriggers: new WorkflowTriggers(() => s, metrics.registry),
    workflowDeadLetters: new WorkflowDeadLetters(() => s),
    workflowBundles: new WorkflowBundles(() => s),
    workflowHooks: new WorkflowHooks(() => s),
    workflowRetention: new WorkflowRetention(() => s),
    workflowTemplates: new WorkflowTemplates(() => s),
    workflowAnalytics: new WorkflowAnalytics(() => s),
    workflowTags: new WorkflowTags(() => s),
    designLocks: new DesignLocks(() => s),
    settings: new SettingsService(() => s),
    storage: new StorageService(() => s),
    close: async () => {
      s.vaultSeal.stop(); // 1.8.0 (B-145): the poll of the persisted seal
      await s.sysKeys.close(); // 1.7.0 (B-9203): the uses counted since the last minute are written
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
      await s.siemDestinations.close(); // 1.6.0, Sprint 38a (B-7501)
      await s.instances.stop();
      await jobs.stop();
      await chain.close();
      await mcp.close();
      await bus.close();
      await s.spam.settle().catch(() => undefined);
      await counters.close();
      await s.cache.close();
      await s.atproto.close().catch(() => undefined);
      await s.moderation.close().catch(() => undefined);
      await knowledge.replication.close().catch(() => undefined);
      await connections.close().catch(() => undefined);
      await s.push.close().catch(() => undefined);
      // Sprint 20: the signer connection, when the KMS is the signer.
      (kms as { client?: { close(): void } }).client?.close();
      await tracer.close();
    }
  };
  registerPlatformJobs(s);
  // Sprint 22: jobs join the trace that queued them and wait while this build is older than the schema; guardrail
  // checkpoints are spans (checkpoint and outcome only, never the text).
  jobs.tracer = tracer.enabled ? tracer : null;
  // 1.8.0 (B-145): and while the vault is sealed.
  // 1.9.99-final (B-10302): nothing is claimed while a database move holds its read-only window.
  jobs.gate = () => s.schema.refusal() ?? s.instances.drainReason() ?? s.vaultSeal.refusal() ?? s.cloud.dbMoves.window.refusal();
  vaultSeal.listen(); // 1.8.0 (B-145): a seal or unseal on any instance reaches this one
  // 1.8.0 (B-144): a script runner image passes the security gate when its SCRIPT_IMAGE_* override is proposed and
  // approved; a result matches only an image pinned by digest (<repository>@sha256:…).
  s.settings.valueGates.push(async (by, name, value) => {
    if (!name.startsWith('SCRIPT_IMAGE_') || value == null) return;
    await s.securityScans.gate({ tenantId: by.tenantId, userId: by.userId, clearance: 'restricted', audit: by.actor, traceId: by.traceId ?? null }, { kind: 'script-image', digest: SecurityScans.imageDigest(value), ref: value, name: `${name}=${value.split('@')[0]}` }, 'script-image');
  });
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
  s.chatCapabilities.registerJobs(); // 1.7.0 (B-4002): chat.tool
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
  s.redteam.registerJobs(); // 1.6.0 Sprint 38b (B-7001)
  s.pki.registerJobs(); // Sprint 24 (B-1603, B-1604): CRLs and OCSP responders
  // 1.9.0 (B-187 to B-189): CA settings (read once now, kept fresh over the bus), CA tokens and member certificates.
  s.pkiSettings.listen();
  void s.pkiSettings.prime();
  s.caTokens.registerJobs();
  s.memberCerts.registerJobs();
  s.offboarding.startListeners.push((tenantId) => s.memberCerts.revokeTenant(tenantId));
  s.pluginRuntime.registerJobs(); // Sprint 25 (B-2003, B-2004): plugin invocations
  s.pluginRuntime.listen();
  // Sprint 25 (B-1704 to B-1706): the lease sweeper, rotation checks, and `vault:` references resolved as their owner.
  s.dbLeases.registerJobs();
  s.rotation.registerJobs();
  s.revealWatch.registerJobs(); // 1.6.0, Sprint 36b (B-4803): reveal history pruned
  s.vaultShares.registerJobs(); // 1.6.0, Sprint 37c (B-4801): expired shares removed
  s.leases.registerJobs(); // 1.7.0 (B-9204): the generic lease sweeper
  s.responseCache.registerJobs(); // 1.7.0 (B-9901): the response cache sweeper
  // 1.7.0 (B-9208): the services built before the vault read moved credentials through it.
  s.mcp.credentialVault = s.credentialMoves;
  s.mcp.oauth.credentialVault = s.credentialMoves;
  // 1.7.0 (B-9901): answers of profiles that opt in are cached.
  s.chat.responseCache = s.responseCache;
  s.connections.credentialVault = s.credentialMoves;
  // 1.9.99-final (B-10306): connections made from a cloud account take their credentials through its link.
  s.connections.cloud = s.cloud.discovery.hooks();
  // 1.9.99-final, Sprint 60 (B-10402, B-10403): the cold-start wait and preemptible leases for cloud GPU pools.
  s.cloud.autoscale.attach();
  // 1.8.0 (B-125, B-126): saved queries and REST endpoints as knowledge sources and app lookups.
  {
    const ext = new ExternalKnowledgeSources(() => s);
    s.knowledge.external = { 'saved-query': ext.provider('saved-query'), rest: ext.provider('rest') };
  }
  s.knowledge.credentialVault = s.credentialMoves;
  // 1.7.0 (B-9206): sessions and API keys that are leases; registered whichever store new ones go to, so both are read.
  s.sessions.registerLeaseKind();
  s.apiKeys.registerLeaseKind();
  s.apiKeyLeases.register(); // 1.7.0 (B-9301): a lease that ends revokes its key
  s.exports.checkpoints = s.checkpoints; // 1.6.0, Sprint 38a (B-7501): JSONL exports sign their window's end
  s.registry.publishGate = (t, kind, id) => s.inventory.assertPublishable(t, kind, id); // 1.6.0, Sprint 38a (B-7301)
  void s.siemDestinations.start().catch((err) => log.warn({ err: (err as Error).message }, 'SIEM destinations did not start')); // 1.6.0, Sprint 38a (B-7501)
  s.scim.registerJobs(); // 1.6.0, Sprint 37c (B-7202): group mappings re-applied to a SCIM store
  s.complianceExports.registerJobs(); // 1.6.0, Sprint 38c (B-7603): compliance exports written
  s.evidence.registerJobs(); // 1.7.0 (B-9504): the export of a held case's or object's content
  {
    const vaultRead = (tenantId: string, ownerId: string | null, ref: string, via: string) => s.vault.resolveFor(tenantId, ownerId, ref, { via });
    s.chain.useVaultResolver((row) => (ref) => vaultRead(row.tenant_id, row.vault_owner, ref, `identity-provider:${row.id}`));
    s.connections.vaultResolver = vaultRead;
    s.mcp.vaultResolver = vaultRead;
    // 1.6.0, Sprint 35a (B-4302): a Chat Completions instance's bearer token, read as the administrator who saved it.
    s.gateway.tokenResolver = vaultRead;
  }
  // 1.9.99-final, Sprint 60 (B-10401): an enrolled cloud GPU node's pool identity (mTLS to the node), from memory.
  s.gateway.tlsResolver = (identity) => s.cloud.gpuPools.nodes.tlsMaterial(identity);
  // 1.9.99-final, Sprint 60 (B-10502, B-10503, B-10509): cloud Chat Completions endpoints (auth, Azure deployments,
  // content-filter decisions), Workers AI neurons at metering, DigitalOcean agents as tools.
  s.cloud.modelBackends.install();
  // 1.7.0 (B-3806): imported classifier engines: the `imported` engine and the conformance run of its models.
  s.guard.classifiers.imported = s.imports.classifierModels;
  s.gateway.classifierConformance = (model, signal) => s.imports.classifierModels.conformance(model, signal);
  // 1.9.99-final (B-10501): `kind: bedrock` instances get their server from the cloud plane (account, region, transport).
  s.gateway.cloudServer = (row, onDropped) => s.cloud.bedrock.serverFor(row, onDropped);
  // 1.9.99-final, Sprint 61 (B-10908): Cloudflare AI Gateway in front of cloud instances that name one.
  s.cloud.aiGateway.install();
  // 1.9.99-final, Sprint 61 (B-10507): every call on a cloud instance is checked for residency and egress with the
  // request's own label (cross-region and global models serve nothing above internal; the egress zone).
  s.gateway.cloudResidency = (row, model, label) => s.cloud.modelResidency.check(row, model, label);
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
      description: 'A file in a workspace folder (a taken-down file is served to nobody, is not in the trash its members see, and its shares are revoked)',
      resolve: async (tenantId, id) => {
        const f = await s.files.moderationTarget(tenantId, id);
        return f ? { type: 'file', id: f.id, tenantId, workspaceId: f.workspaceId, label: f.label, ownerId: f.ownerId, state: f.takenDown ? 'hidden' : f.state } : null;
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
  s.appReports.registerJobs(); // 1.8.0, Sprint 44 (B-122): apps.report-cache.sweep
  s.appExports.registerJobs(); // 1.8.0, Sprint 44 (B-123): apps.export-file, apps.export-file.sweep
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
  s.groupGovernance.registerJobs(); // 1.9.0, Sprint 53 (B-175): closing votes and reminders
  // Sprint 28a (B-2301 to B-2304): channel jobs (replies, IMAP polls, the outbox, retention, exports); sessions and
  // their messages as moderation objects.
  s.channels.init();
  // Sprint 28b (B-2601 to B-2605): the conversation room (authoriser, signals, presence), embeddings, messages as
  // moderation objects.
  s.messaging.init();
  // Sprint 28c (B-2701 to B-2705): the feed room authoriser, posts and comments as moderation objects, trending and digests.
  s.feed.init();
  s.feed.digests.registerJobs();
  s.search.init(); // 1.9.0, Sprint 52 (B-170): index writes after messages, posts and comments; backfill and retry jobs
  // 1.9.0, Sprint 49 (B-150, B-153): devices end with sessions; preferences decide the inbox and email paths.
  s.sessions.devices = { end: (scope) => s.pushDevices.endWithSessions(scope), moved: (from, to) => s.pushDevices.sessionMoved(from, to) };
  // 1.9.0 (B-190): a tenant's sign-in policy may shorten session lifetimes (null: the platform's, as before).
  s.sessions.policy = { lifetimes: (tenantId) => s.account.policy.sessionLifetimes(tenantId) };
  s.pushDevices.registerJobs();
  s.notificationPrefs.listen();
  s.notificationPrefs.registerJobs();
  // 1.9.0 (B-151, B-152): push delivery for each stored notification, acknowledgements and provider changes.
  s.push.registerJobs();
  s.push.listen();
  s.notifications.pushHook = (rows, input) => s.push.enqueue(rows, input);
  s.notifications.prefs = s.notificationPrefs;
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
  s.workflowRetention.install(); // 1.8.0, Sprint 46 (B-135): runs as moderated objects (legal holds), the retention job
  s.workflowRetention.registerJobs();
  s.held.registerJobs(); // 1.7.0, Sprint 41 (B-9403): held writes re-screened when the guard answers, decided ones purged
  s.sla.registerJobs(); // Sprint 46 (B-134): the SLA tick (timers, warn and breach actions, routing)
  s.leakedPasswords.registerJobs(); // 1.9.0, Sprint 55 (B-192): passwords.list.build, passwords.list.mirror
  s.spam.init(); // 1.9.0, Sprint 50 (B-161): the sweep job, the appeal listener, the spam-score detector source
  s.moderationMetrics.registerJobs(); // 1.9.0, Sprint 50 (B-158)
  s.moderation.init(); // Sprint 26 (B-1901 to B-1907): object types, provider and sweep jobs, routing, dead letters, sign-in gate
  s.userImports.registerJobs(); // Sprint 26a (B-1805)
  governanceFor(s).registerJobs(); // QA-1 (B-185, B-186): scheduled store backups, users export
  jobs.register('billing.close', async (p, ctx) => s.billing.closePrevious(String(p.tenantId ?? ctx.job.tenant_id)));
  s.subscriptions.registerJobs(); // 1.9.0, Sprint 51 (B-162): trial ends, renewals and cancellations written to the history
  s.flags.init(); // 1.9.0, Sprint 52 (B-168): flag caches cleared over the bus and on subscription changes
  jobs.register('mcp.poll', async (p, ctx) => mcp.pollTenant(String(p.tenantId ?? ctx.job.tenant_id), ctx.progress, ctx.signal));
  return s;
}

/** Job handlers for the platform's own recurring work. */
function registerPlatformJobs(s: Services): void {
  // 1.9.9-qa (QA-1): the full import of a cloud directory's users before their first sign-in.
  directoryImportsFor(s).registerJobs();
  // 1.9.99-final, Sprint 56 (B-10005, B-10006): the cloud issuer check and the credential sweep.
  if (s.cloud.credentials instanceof CloudCredentials) s.cloud.credentials.registerJobs();
  s.cloud.engine.registerJobs(); // 1.9.99-final, Sprint 57 (B-10104, B-10105): cloud.apply, cloud.poll, cloud.verify
  s.cloud.lifecycle.registerJobs(); // 1.9.99-final, Sprint 57 (B-10106, B-10107): cloud.drift, cloud.destroy, cloud.rollback, cloud.orphans
  s.cloud.releases.registerJobs(); // 1.9.99-final, Sprint 58 (B-10203, B-10207): cloud.release, cloud.upgrade, cloud.snapshot.restore
  s.cloud.prices?.registerJobs(); // 1.9.99-final, Sprint 57 (B-10601): the daily price refresh
  s.cloud.budgets.registerJobs(); // 1.9.99-final, Sprint 58 (B-10602): budget alerts and override expiry
  s.cloud.databases.registerJobs(); // 1.9.99-final, Sprint 59 (B-10307): cloud.db.snapshot, cloud.db.restore, cloud.db.schedules
  s.cloud.dbMoves.registerJobs(); // 1.9.99-final, Sprint 59 (B-10302): cloud.db.move, the approved move of this install's database
  s.cloud.costs.registerJobs(); // 1.9.99-final, Sprint 59 (B-10603): cloud.costs.ingest
  s.cloud.showback.registerJobs(); // 1.9.99-final, Sprint 61 (B-10604): cloud.showback.compute
  s.cloud.anomalies.registerJobs(); // 1.9.99-final, Sprint 62 (B-10606): cloud.anomalies.detect
  s.cloud.gpuPools.nodes.registerJobs(); // 1.9.99-final, Sprint 60 (B-10401, B-10404): cloud.gpu.reconcile and the links after an apply
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
    // 1.7.0 (B-4003): approval cards nobody decided in time expire, recorded.
    await s.chatCapabilities.expire(String(p.tenantId ?? ctx.job.tenant_id));
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
  s.subscriptions.schedule(); // 1.9.0, Sprint 51 (B-162): only tenants with a live subscription that time moved on
  s.agentSchedules.schedule(s.scheduler); // Sprint 21 (B-1306)
  s.pki.schedule(s.scheduler); // Sprint 24 (B-1603): CRLs for every live issuer
  s.caTokens.schedule(s.scheduler); // 1.9.0 (B-188): token-signer rotation
  s.memberCerts.schedule(s.scheduler); // 1.9.0 (B-189): member certificate renewal and revocation
  s.dbLeases.schedule(s.scheduler); // Sprint 25 (B-1704): the lease expiry sweeper
  s.leases.schedule(s.scheduler); // 1.7.0 (B-9204): generic leases past their expiry
  s.responseCache.schedule(s.scheduler); // 1.7.0 (B-9901): expired response cache entries
  s.appReports.schedule(s.scheduler); // 1.8.0, Sprint 44 (B-122): expired cached report results
  s.appExports.schedule(s.scheduler); // 1.8.0, Sprint 44 (B-123): expired export files
  s.rotation.schedule(s.scheduler); // Sprint 25 (B-1706): rotation notices
  s.revealWatch.schedule(s.scheduler); // 1.6.0, Sprint 36b (B-4803): reveal history pruned
  s.vaultShares.schedule(s.scheduler); // 1.6.0, Sprint 37c (B-4801)
  s.atproto.schedule(s.scheduler); // Sprint 25 (B-1611): labels from trusted external labelers
  s.feedGenerators.schedule(s.scheduler); // Sprint 31 (B-3003): feed indexes pruned to their retention
  s.files.schedule(s.cfg.FILES_PURGE_MINUTES, activeTenants); // Sprint 26d (B-2401): the trash purge; 1.7.0 (B-9503): file retention and the version cap
  s.held.schedule(); // 1.7.0, Sprint 41 (B-9403)
  s.sla.schedule(); // Sprint 46 (B-134)
  s.spam.schedule(); // 1.9.0, Sprint 50 (B-161): expiry and pruning
  s.moderationMetrics.schedule(); // 1.9.0, Sprint 50 (B-158): the daily aggregates
  s.moderation.schedule(); // Sprint 26 (B-1904, B-1905): SLA escalation and sanction expiry
  s.pds.schedule(); // 1.5.0, Sprint 31 (B-2904): events past the backfill window and unused blobs
  s.firehose.start(); // Sprint 27 (B-1908): firehose consumers, one instance per subscription through a lease
  s.apps.triggers.schedule(s.scheduler, s.cfg.APPS_SCHEDULE_TICK_SECONDS * 1000); // Sprint 27 (B-2206): schedule triggers
  s.apps.sources.schedule(s.scheduler, s.cfg.APPS_SCHEDULE_TICK_SECONDS * 1000); // 1.6.0, Sprint 39c (B-8501): pulls from outside tables
  s.apps.sheetImport.schedule(s.scheduler, s.cfg.APPS_SCHEDULE_TICK_SECONDS * 1000); // 1.8.0, Sprint 45 (B-129): scheduled imports from connections
  s.apps.subscriptions.schedule(s.scheduler, s.cfg.APPS_SCHEDULE_TICK_SECONDS * 1000); // 1.8.0, Sprint 44 (B-124): scheduled deliveries
  s.workflowTriggers.schedule(s.scheduler); // 1.5.0, Sprint 32b (B-3903): workflow schedule triggers
  s.workflows.scheduleApprovals(s.scheduler, s.cfg.WORKFLOW_SCHEDULE_TICK_SECONDS * 1000); // Sprint 46 (B-133): approval deadlines
  s.workflowRetention.schedule(s.scheduler); // 1.8.0, Sprint 46 (B-135): run retention
  if (s.cfg.PUSH_DEVICE_IDLE_DAYS > 0) s.scheduler.every('push.devices.prune', 24 * 60 * 60_000, activeTenants); // 1.9.0 (B-150)
  if (s.cfg.NOTIFICATION_DIGEST_MINUTES > 0) s.scheduler.every('notifications.digest', s.cfg.NOTIFICATION_DIGEST_MINUTES * 60_000, activeTenants); // 1.9.0 (B-153)
  s.channels.schedule(); // Sprint 28a (B-2303, B-2304): IMAP polls and retention purges
  s.feed.digests.schedule(s.scheduler, activeTenants); // Sprint 28c (B-2705): trending hashtags and weekly digests
  s.groups.depth.schedule(s.scheduler, activeTenants); // 1.6.0, Sprint 36a (B-4404): trending groups
  s.groups.ownership.schedule(s.scheduler, activeTenants); // 1.7.0, Sprint 43 (B-9801): groups whose owners left
  s.groupGovernance.schedule(s.scheduler, activeTenants); // 1.9.0, Sprint 53 (B-175): votes that close, reminders
  s.accessReviews.schedule(s.scheduler); // 1.5.0, Sprint 29 (B-3305): campaigns that open, and overdue escalation
  s.imports.schedule(s.scheduler, activeTenants); // 1.5.0, Sprint 30 (B-3801, B-3803): due harvests, promoted bundles
  s.apps.forms.held.schedule(s.scheduler); // 1.6.0, Sprint 36b (B-4701): decided held submissions purged
  s.push.schedule(s.scheduler); // 1.9.0 (B-152): the 30-day sweep of the push delivery log
  governanceFor(s).schedule(s.scheduler); // QA-1 (B-186): due store backup schedules
  if (s.cloud.credentials instanceof CloudCredentials) s.cloud.credentials.schedule(s.scheduler); // 1.9.99-final, Sprint 56 (B-10005, B-10006)
  s.cloud.prices?.schedule(s.scheduler); // 1.9.99-final, Sprint 57 (B-10601): prices cached daily
  s.cloud.lifecycle.schedule(s.scheduler); // 1.9.99-final, Sprint 57 (B-10106, B-10107): drift per deployment, orphans per account
  s.cloud.budgets.schedule(s.scheduler, s.cfg.CLOUD_BUDGET_CHECK_MINUTES); // 1.9.99-final, Sprint 58 (B-10602): budget alerts
  s.cloud.databases.schedule(s.scheduler); // 1.9.99-final, Sprint 59 (B-10307): database snapshot schedules (none until one is set)
  s.cloud.costs.schedule(s.scheduler); // 1.9.99-final, Sprint 59 (B-10603): billing ingestion, daily
  s.cloud.showback.schedule(s.scheduler); // 1.9.99-final, Sprint 61 (B-10604): showback, daily
  s.cloud.anomalies.schedule(s.scheduler); // 1.9.99-final, Sprint 62 (B-10606): spend anomalies, daily (and after each ingest)
  s.cloud.gpuPools.nodes.schedule(s.scheduler); // 1.9.99-final, Sprint 60 (B-10401): node group tokens and boot timings (nothing without a link)
  void s.cloud.gpuPools.nodes.loadIdentities().catch(() => undefined);
}
