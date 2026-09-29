import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Variables that may instead be given as `<NAME>_FILE` (a path, e.g. a Docker secret or systemd credential). */
const FILE_VARS = ['SESSION_SECRET', 'DATA_KEY', 'DATABASE_URL', 'METRICS_TOKEN', 'OPENBAO_TOKEN', 'REDIS_URL', 'SMTP_URL', 'S3_SECRET_ACCESS_KEY', 'SIEM_TOKEN'] as const;

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

const schema = z
  .object({
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

    COOKIE_SECURE: bool.optional(),
    SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(30),
    SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(12),
    MFA_PENDING_MINUTES: z.coerce.number().int().min(1).max(30).default(5),

    LOCKOUT_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(50).default(5),
    LOCKOUT_WINDOW_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(15),
    LOCKOUT_DURATION_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(15),

    DEFAULT_TENANT: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).default('default'),
    IDENTITY_CONFIG: z.string().optional(),

    WEBAUTHN_RP_ID: z.string().optional(),
    WEBAUTHN_RP_NAME: z.string().default('Exprsn-AI'),

    WEB_ROOT: z.string().default(defaultWebRoot),
    METRICS_TOKEN: z.string().min(16).optional()
  })
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
