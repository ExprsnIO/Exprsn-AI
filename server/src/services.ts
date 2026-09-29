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
import { allowAll, type Guardrails } from './guardrails/types.js';
import { loadPrincipal } from './http/middleware.js';
import { WorkflowService } from './workflows/service.js';
import { MediaService } from './media/service.js';
import { FfmpegRunner, type MediaRunner } from './media/runner.js';
import { ImageService } from './images/service.js';
import { createBackends, type ImageBackend } from './images/backends.js';
import { HttpSafety, noSafety, type ImageSafety } from './images/safety.js';

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
  /** Workflow graphs, versions and durable runs (Sprint 8). */
  workflows: WorkflowService;
  /** Media assets, presets and ffmpeg jobs (Sprint 8). */
  media: MediaService;
  /** Image generation on ComfyUI or diffusers workers (Sprint 8). */
  images: ImageService;
  /** The image-safety classifier for generated images and sampled video frames. */
  imageSafety: ImageSafety;
  /** Stops background work and closes connections (Redis, SMTP, identity stores). */
  close(): Promise<void>;
}

export interface ServiceOverrides {
  kms?: Kms;
  blobs?: BlobStore;
  mediaRunner?: MediaRunner;
  imageBackends?: ImageBackend[];
  imageSafety?: ImageSafety;
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
  const chat = new ChatService(db, keys, gateway, quotas, audit, bus, attachments, calc, log);
  // Sprint 8 services read the guardrails and the safety classifier through `s`, so a later replacement is used.
  const workflows = new WorkflowService({ db, keys, gateway, quotas, audit, bus, jobs, notifications, calc, log, guardrails: () => s.guardrails, principalFor: (t, u) => loadPrincipal(s, t, u, {}), http: { hosts: cfg.WORKFLOW_HTTP_HOSTS.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean), allowLoopback: cfg.WORKFLOW_HTTP_ALLOW_LOOPBACK } });
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
    guardrails: allowAll,
    workflows,
    media,
    images,
    imageSafety: overrides.imageSafety ?? (cfg.IMAGE_SAFETY_URL ? new HttpSafety(cfg.IMAGE_SAFETY_URL) : noSafety),
    close: async () => {
      scheduler.stop();
      chat.close();
      await gateway.stop();
      await calc.close();
      siem.close();
      await jobs.stop();
      await chain.close();
      await bus.close();
    }
  };
  registerPlatformJobs(s);
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
}
