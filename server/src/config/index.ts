import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Variables that may instead be given as `<NAME>_FILE` (a path, e.g. a Docker secret or systemd credential). */
export const FILE_VARS = ['SESSION_SECRET', 'DATA_KEY', 'DATABASE_URL', 'METRICS_TOKEN', 'OPENBAO_TOKEN', 'REDIS_URL', 'SMTP_URL', 'S3_SECRET_ACCESS_KEY', 'SIEM_TOKEN', 'TRAINER_TOKEN', 'STRIPE_SECRET_KEY'] as const;

/** Configuration comes from the environment; a `<NAME>_FILE` for the secrets above wins over the plain variable. */
function readEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  // An empty variable means "not set" (Compose passes ${VAR:-} through as an empty string).
  for (const k of Object.keys(out)) if (out[k] === '') delete out[k];
  for (const name of FILE_VARS) {
    const file = env[`${name}_FILE`];
    if (file) out[name] = readFileSync(file, 'utf8').trim();
  }
  return out;
}

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultWebRoot = path.resolve(here, '../../../web');

const base = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    PUBLIC_URL: z.url().default('http://localhost:8080'),
    TRUST_PROXY: z.string().default('loopback'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    DB_CLIENT: z.enum(['pg', 'mysql', 'sqlite']).default('sqlite'),
    DATABASE_URL: z.string().optional(),
    SQLITE_FILENAME: z.string().default('./data/exprsn-ai.sqlite'),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
    DB_MIGRATE_ON_START: bool.default(true),

    /** HMAC key for session ids, CSRF tokens and API keys. 32+ bytes of randomness. */
    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
    /**
     * Local KMS master key (AES-256-GCM key-encryption key), base64-encoded 32 bytes. Wraps the per-tenant data keys.
     * Required with KMS_PROVIDER=local; optional with OpenBao, where it only opens values sealed before the switch.
     */
    DATA_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'DATA_KEY must be 32 bytes, base64-encoded')
      .optional(),
    KMS_PROVIDER: z.enum(['local', 'openbao']).default('local'),
    OPENBAO_ADDR: z.url().optional(),
    OPENBAO_TOKEN: z.string().optional(),
    OPENBAO_TRANSIT_MOUNT: z.string().regex(/^[a-z0-9_-]+$/).default('transit'),
    OPENBAO_KEY_PREFIX: z.string().regex(/^[a-z0-9_-]*$/).default('exprsn-'),
    OPENBAO_CA_FILE: z.string().optional(),

    /** Blob storage for exports, attachments and audit checkpoints. */
    BLOB_STORE: z.enum(['fs', 's3']).default('fs'),
    BLOB_DIR: z.string().default('./data/blobs'),
    S3_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: bool.default(true),

    /** Redis: enables the BullMQ job queue, the Socket.io adapter and the cross-instance bus. */
    REDIS_URL: z.string().optional(),
    JOB_QUEUE: z.enum(['auto', 'db', 'bullmq']).default('auto'),
    JOB_POLL_MS: z.coerce.number().int().min(50).max(60_000).default(1000),
    JOB_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
    WORKERS_ENABLED: bool.default(true),

    /** Notifications by email. smtp://user:pass@host:587 or smtps://…; unset means socket delivery only. */
    SMTP_URL: z.string().optional(),
    SMTP_FROM: z.string().default('Exprsn-AI <no-reply@localhost>'),

    /** SIEM stream: audit events are POSTed as NDJSON batches to this URL. */
    SIEM_URL: z.url().optional(),
    SIEM_TOKEN: z.string().optional(),

    DIRECTORY_SYNC_MINUTES: z.coerce.number().int().min(0).max(24 * 60).default(60),
    AUDIT_CHECKPOINT_MINUTES: z.coerce.number().int().min(0).max(24 * 60).default(60),

    /** Ollama gateway. */
    OLLAMA_POLL_MS: z.coerce.number().int().min(250).max(600_000).default(5000),
    OLLAMA_TIMEOUT_MS: z.coerce.number().int().min(250).max(600_000).default(4000),
    OLLAMA_MAX_INFLIGHT: z.coerce.number().int().min(1).max(256).default(4),
    OLLAMA_MAX_LOADS_PER_10_MIN: z.coerce.number().int().min(1).max(1000).default(6),
    OLLAMA_QUEUE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(3_600_000).default(120_000),

    /** Chat. */
    ATTACHMENT_MAX_BYTES: z.coerce.number().int().min(1024).max(512 * 1024 * 1024).default(10 * 1024 * 1024),
    CLAMD_HOST: z.string().optional(),
    CLAMD_PORT: z.coerce.number().int().min(1).max(65535).default(3310),

    /** MCP servers: internal hosts only, unless a host or CIDR is on this comma-separated allow-list. */
    MCP_ALLOWED_HOSTS: z.string().default(''),
    /** Data connections (PostgreSQL, OpenSearch): internal hosts only, unless this comma list (hosts, *.domain, CIDRs) names them. */
    CONNECTIONS_ALLOWED_HOSTS: z.string().default(''),
    MCP_TIMEOUT_MS: z.coerce.number().int().min(250).max(600_000).default(15_000),
    MCP_POLL_MINUTES: z.coerce.number().int().min(0).max(24 * 60).default(15),
    /** Script sandbox: docker or podman CLI (auto picks whichever is installed), or none. */
    SCRIPT_RUNNER: z.enum(['auto', 'docker', 'podman', 'none']).default('auto'),
    SCRIPT_IMAGE_PYTHON: z.string().default('python:3.13-slim'),
    SCRIPT_IMAGE_NODE: z.string().default('node:22-slim'),

    /** Workflows: HTTP steps only call internal (private) addresses; this comma list narrows the hosts further. */
    WORKFLOW_HTTP_HOSTS: z.string().default(''),
    WORKFLOW_HTTP_ALLOW_LOOPBACK: bool.default(false),

    /** Media: ffmpeg and ffprobe binaries, encoder choice, caps, and whisper.cpp for transcripts. */
    MEDIA_FFMPEG: z.string().default('ffmpeg'),
    MEDIA_FFPROBE: z.string().default('ffprobe'),
    MEDIA_ENCODER: z.enum(['auto', 'nvenc', 'cpu']).default('auto'),
    MEDIA_WORK_DIR: z.string().optional(),
    MEDIA_MAX_BYTES: z.coerce.number().int().min(1024).max(16 * 1024 ** 3).default(512 * 1024 ** 2),
    MEDIA_MAX_DURATION_S: z.coerce.number().int().min(1).max(24 * 3600).default(7200),
    MEDIA_MAX_WIDTH: z.coerce.number().int().min(16).max(16_384).default(1920),
    MEDIA_MAX_HEIGHT: z.coerce.number().int().min(16).max(16_384).default(1080),
    MEDIA_MAX_STREAMS: z.coerce.number().int().min(1).max(64).default(4),
    MEDIA_WHISPER_BIN: z.string().optional(),
    MEDIA_WHISPER_MODEL: z.string().optional(),

    /** Images: generation backends as JSON ([{id, kind: comfyui|diffusers, url, label?, model?, workflow?, concurrency?}]). */
    IMAGE_BACKENDS: z.string().default('[]'),
    IMAGE_SAFETY_URL: z.url().optional(),
    IMAGE_SAFETY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),

    // --- Sprint 9: training (edit only inside this block) ---
    /** Training: the Python GPU worker's base URL (unset: training jobs queue and say no worker is configured). */
    TRAINER_URL: z.url().optional(),
    /** Bearer token the worker expects, when it expects one. */
    TRAINER_TOKEN: z.string().optional(),
    TRAINER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(30_000),
    /** How often the orchestrator syncs runs, opens and closes windows, fires recurring jobs and dispatches the queue. */
    TRAINING_TICK_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),
    // --- end training ---

    // --- Sprint 9: zones (edit only inside this block) ---
    /** Air-gapped posture: no zone may have internet egress and the external zone stays empty. */
    ZONES_AIR_GAPPED: bool.default(true),
    /** Comma-separated CIDRs of the corporate network, rendered where a zone accepts traffic from it. */
    ZONES_CORPORATE_CIDRS: z.string().default(''),
    /** Health checks of registered zone endpoints: interval (0 turns the sweep off), timeout, failures to unhealthy. */
    ZONE_HEALTH_MINUTES: z.coerce.number().int().min(0).max(24 * 60).default(1),
    ZONE_HEALTH_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(3000),
    ZONE_HEALTH_FAILURES: z.coerce.number().int().min(1).max(20).default(3),
    // --- end zones ---

    // --- Sprint 9: platform operations (edit only inside this block) ---
    /** Import bundles: size cap, Trivy for the SBOM scan (unset: reported as not configured), licence allow-list, staging hook. */
    PLATFORM_BUNDLE_MAX_BYTES: z.coerce.number().int().min(1024).max(2 * 1024 ** 3 - 1).default(1024 ** 3),
    PLATFORM_TRIVY_BIN: z.string().optional(),
    PLATFORM_TRIVY_CACHE_DIR: z.string().optional(),
    PLATFORM_SCAN_FAIL_SEVERITY: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).default('HIGH'),
    PLATFORM_LICENCE_ALLOW: z.string().default('MIT,Apache-2.0,BSD-2-Clause,BSD-3-Clause,ISC,0BSD,Unlicense,CC0-1.0,Zlib,MPL-2.0,Python-2.0,PSF-2.0,BlueOak-1.0.0,OpenSSL'),
    PLATFORM_STAGING_URL: z.url().optional(),
    PLATFORM_STAGING_TIMEOUT_MS: z.coerce.number().int().min(1000).max(4 * 3600_000).default(30 * 60_000),
    /** Mirrors, the staging hook and ACME must be internal hosts; this comma list (hosts, *.domain, CIDRs) adds exceptions. */
    PLATFORM_ALLOWED_HOSTS: z.string().default(''),
    PLATFORM_MIRROR_CHECK_MINUTES: z.coerce.number().int().min(0).max(24 * 60).default(60),
    PLATFORM_KEY_ROTATION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
    /** ACME (RFC 8555) for platform certificates: the internal CA's directory, http-01 answered by this server. */
    ACME_DIRECTORY_URL: z.url().optional(),
    ACME_CONTACT: z.email().optional(),
    ACME_CA_FILE: z.string().optional(),
    ACME_RENEW_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    ACME_CHECK_MINUTES: z.coerce.number().int().min(0).max(24 * 60).default(360),
    ACME_POLL_MS: z.coerce.number().int().min(10).max(60_000).default(2000),
    /** Backups of the application database into the blob store, and restore drills into a scratch SQLite database. */
    PLATFORM_BACKUP_MINUTES: z.coerce.number().int().min(0).max(7 * 24 * 60).default(24 * 60),
    PLATFORM_BACKUP_RETAIN: z.coerce.number().int().min(1).max(1000).default(14),
    PLATFORM_BACKUP_RPO_MINUTES: z.coerce.number().int().min(1).max(30 * 24 * 60).default(24 * 60),
    PLATFORM_BACKUP_RTO_MINUTES: z.coerce.number().int().min(1).max(30 * 24 * 60).default(4 * 60),
    PLATFORM_DRILL_MINUTES: z.coerce.number().int().min(0).max(90 * 24 * 60).default(7 * 24 * 60),
    PLATFORM_DRILL_DIR: z.string().optional(),
    // --- end platform operations ---

    // --- Sprint 9: federation (edit only inside this block) ---
    /** OIDC issuer and SAML IdP base; defaults to PUBLIC_URL. Other tenants use <issuer>/t/<tenant>. */
    FEDERATION_ISSUER: z.url().optional(),
    /** Signing keys rotate on this schedule; the next key is published this many days before it signs. */
    OIDC_KEY_ROTATION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
    OIDC_KEY_OVERLAP_DAYS: z.coerce.number().int().min(0).max(365).default(14),
    /** RFC 8628 device codes: lifetime and the minimum polling interval. */
    DEVICE_CODE_MINUTES: z.coerce.number().int().min(1).max(60).default(15),
    DEVICE_POLL_SECONDS: z.coerce.number().int().min(1).max(60).default(5),
    SAML_ASSERTION_MINUTES: z.coerce.number().int().min(1).max(60).default(5),
    /** Upstream identity providers must be internal hosts unless this comma list (hosts, *.domain, CIDRs) names them. */
    FEDERATION_ALLOWED_HOSTS: z.string().default(''),
    FEDERATION_TIMEOUT_MS: z.coerce.number().int().min(250).max(60_000).default(5000),
    /** Kerberos SPNEGO: service principal (HTTP@host) and keytab; needs the optional kerberos module. */
    KERBEROS_SERVICE: z.string().optional(),
    KERBEROS_KEYTAB: z.string().optional(),
    // --- end federation ---

    // --- Sprint 13: integrations (edit only inside this block) ---
    /** The OpenAI-compatible API at /v1: `checked` streams the answer after the output guardrail; `live` streams tokens as generated. */
    OPENAI_STREAM_MODE: z.enum(['checked', 'live']).default('checked'),
    /** Webhooks: internal hosts only, unless this comma list (hosts, *.domain, CIDRs) names them; tenants narrow further. */
    WEBHOOK_ALLOWED_HOSTS: z.string().default(''),
    WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(250).max(60_000).default(10_000),
    WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(6),
    /** First retry after this long, doubling each attempt (capped at six hours). */
    WEBHOOK_RETRY_BASE_MS: z.coerce.number().int().min(10).max(3_600_000).default(30_000),
    /** Consecutive failed attempts that open an endpoint's breaker, and how long it stays open before a trial. */
    WEBHOOK_BREAKER_THRESHOLD: z.coerce.number().int().min(1).max(100).default(5),
    WEBHOOK_BREAKER_COOLDOWN_MS: z.coerce.number().int().min(10).max(24 * 3_600_000).default(5 * 60_000),
    /** Billing: `none` keeps statements local; `stripe` can push a finished month as a Stripe invoice. */
    BILLING_PROVIDER: z.enum(['none', 'stripe']).default('none'),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_API_URL: z.url().default('https://api.stripe.com'),
    STRIPE_DAYS_UNTIL_DUE: z.coerce.number().int().min(0).max(365).default(30),
    /** How often the scheduler checks that last month's statements are closed (0 turns it off). */
    BILLING_CLOSE_MINUTES: z.coerce.number().int().min(0).max(7 * 24 * 60).default(6 * 60),
    // --- end integrations ---

    COOKIE_SECURE: bool.optional(),
    SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(30),
    SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(12),
    MFA_PENDING_MINUTES: z.coerce.number().int().min(1).max(30).default(5),

    LOCKOUT_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(50).default(5),
    LOCKOUT_WINDOW_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(15),
    LOCKOUT_DURATION_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(15),

    DEFAULT_TENANT: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).default('default'),
    IDENTITY_CONFIG: z.string().optional(),
    /**
     * Secret references in user stores and upstream IdPs. `env:` names must match this comma list of names or
     * `PREFIX*` patterns (empty: no env: references); the server's own configuration variables are always refused.
     */
    SECRET_REF_ENV: z.string().default(''),
    /** `file:` references must resolve (symlinks followed) inside one of these absolute directories. */
    SECRET_REF_DIRS: z.string().default('/run/secrets,/run/credentials,/etc/exprsn-ai/credentials'),
    /** LDAP and SQL user stores must be internal hosts unless this comma list (hosts, *.domain, CIDRs) names them. */
    IDENTITY_ALLOWED_HOSTS: z.string().default(''),

    WEBAUTHN_RP_ID: z.string().optional(),
    WEBAUTHN_RP_NAME: z.string().default('Exprsn-AI'),

    WEB_ROOT: z.string().default(defaultWebRoot),
    METRICS_TOKEN: z.string().min(16).optional()
  });

/** Every variable the server reads for its own configuration (and the `<NAME>_FILE` forms of the secrets). */
export const SERVER_ENV_NAMES: ReadonlySet<string> = new Set([...Object.keys(base.shape), ...FILE_VARS.map((n) => `${n}_FILE`)]);

const schema = base
  .transform((c) => {
    const url = new URL(c.PUBLIC_URL);
    return {
      ...c,
      COOKIE_SECURE: c.COOKIE_SECURE ?? url.protocol === 'https:',
      WEBAUTHN_RP_ID: c.WEBAUTHN_RP_ID ?? url.hostname,
      ORIGIN: url.origin
    };
  })
  .superRefine((c, ctx) => {
    if (c.DB_CLIENT !== 'sqlite' && !c.DATABASE_URL) {
      ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: `DATABASE_URL is required when DB_CLIENT=${c.DB_CLIENT}` });
    }
    if (c.KMS_PROVIDER === 'local' && !c.DATA_KEY) {
      ctx.addIssue({ code: 'custom', path: ['DATA_KEY'], message: 'DATA_KEY is required when KMS_PROVIDER=local' });
    }
    if (c.KMS_PROVIDER === 'openbao' && (!c.OPENBAO_ADDR || !c.OPENBAO_TOKEN)) {
      ctx.addIssue({ code: 'custom', path: ['OPENBAO_ADDR'], message: 'OPENBAO_ADDR and OPENBAO_TOKEN are required when KMS_PROVIDER=openbao' });
    }
    if (c.BLOB_STORE === 's3' && (!c.S3_ENDPOINT || !c.S3_BUCKET || !c.S3_ACCESS_KEY_ID || !c.S3_SECRET_ACCESS_KEY)) {
      ctx.addIssue({ code: 'custom', path: ['S3_ENDPOINT'], message: 'S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required when BLOB_STORE=s3' });
    }
    if (c.JOB_QUEUE === 'bullmq' && !c.REDIS_URL) {
      ctx.addIssue({ code: 'custom', path: ['REDIS_URL'], message: 'REDIS_URL is required when JOB_QUEUE=bullmq' });
    }
    if (c.BILLING_PROVIDER === 'stripe' && !c.STRIPE_SECRET_KEY) {
      ctx.addIssue({ code: 'custom', path: ['STRIPE_SECRET_KEY'], message: 'STRIPE_SECRET_KEY is required when BILLING_PROVIDER=stripe' });
    }
    if (c.NODE_ENV === 'production' && !c.COOKIE_SECURE) {
      ctx.addIssue({ code: 'custom', path: ['COOKIE_SECURE'], message: 'Production requires HTTPS (PUBLIC_URL https://) or COOKIE_SECURE=true behind a TLS proxy' });
    }
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(readEnv(env));
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
