import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Variables that may instead be given as `<NAME>_FILE` (a path, e.g. a Docker secret or systemd credential). */
export const FILE_VARS = ['SESSION_SECRET', 'DATA_KEY', 'DATABASE_URL', 'METRICS_TOKEN', 'OPENBAO_TOKEN', 'REDIS_URL', 'SMTP_URL', 'S3_SECRET_ACCESS_KEY', 'SIEM_TOKEN', 'TRAINER_TOKEN', 'STRIPE_SECRET_KEY', 'DATA_KEY_PREVIOUS', 'ACME_DNS_WEBHOOK_SECRET', 'ACME_DNS_TSIG_SECRET', 'STRIPE_WEBHOOK_SECRET', 'ACME_EAB_HMAC_KEY', 'SIGNER_TOKEN'] as const;

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
    /** Audit streaming per tenant (1.6.0, B-7501): how many proposed or active SIEM destinations a tenant may have. */
    SIEM_TENANT_MAX_DESTINATIONS: z.coerce.number().int().min(1).max(50).default(5),

    DIRECTORY_SYNC_MINUTES: z.coerce.number().int().min(0).max(24 * 60).default(60),
    AUDIT_CHECKPOINT_MINUTES: z.coerce.number().int().min(0).max(24 * 60).default(60),

    /** Ollama gateway. */
    OLLAMA_POLL_MS: z.coerce.number().int().min(250).max(600_000).default(5000),
    OLLAMA_TIMEOUT_MS: z.coerce.number().int().min(250).max(600_000).default(4000),
    OLLAMA_MAX_INFLIGHT: z.coerce.number().int().min(1).max(256).default(4),
    OLLAMA_MAX_LOADS_PER_10_MIN: z.coerce.number().int().min(1).max(1000).default(6),
    OLLAMA_QUEUE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(3_600_000).default(120_000),
    /** How long chat and embedding requests wait for Ollama's first response, which includes a cold model load. */
    OLLAMA_LOAD_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(300_000),

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
    /**
     * 1.6.0 (B-8901): HTTP tools in the registry. Each call goes through the outbound address guard: internal hosts
     * only as SERVICE_ALLOWED_HOSTS names them, public hosts only from the tenant's list of allowed hosts. A tool's
     * timeout and response cap are at most these.
     */
    HTTP_TOOL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),
    HTTP_TOOL_MAX_RESPONSE_BYTES: z.coerce.number().int().min(1024).max(16 * 1024 * 1024).default(1024 * 1024),
    /**
     * Sprint 32 (B-4101): the chain context. Every invocation (chat turn, agent run, workflow run, tool call, skill load,
     * plugin action, app trigger) is a node in its root's chain; a chain is at most CHAIN_MAX_DEPTH deep across kinds,
     * with WORKFLOW_MAX_DEPTH nested workflow runs and AGENT_MAX_DEPTH nested agent runs as per-kind caps (the plugin
     * and app trigger depths stay as they are). A root without budgets of its own (a chat turn, a plugin action, an app
     * trigger) gets CHAIN_MAX_TOKENS, CHAIN_MAX_STEPS, CHAIN_MAX_WALL_SECONDS and CHAIN_MAX_GPU_SECONDS (the cost meter).
     */
    CHAIN_MAX_DEPTH: z.coerce.number().int().min(2).max(32).default(8),
    WORKFLOW_MAX_DEPTH: z.coerce.number().int().min(1).max(10).default(3),
    AGENT_MAX_DEPTH: z.coerce.number().int().min(1).max(10).default(3),
    CHAIN_MAX_TOKENS: z.coerce.number().int().min(1000).max(10_000_000).default(200_000),
    CHAIN_MAX_STEPS: z.coerce.number().int().min(10).max(100_000).default(400),
    CHAIN_MAX_WALL_SECONDS: z.coerce.number().int().min(10).max(7 * 86_400).default(7200),
    CHAIN_MAX_GPU_SECONDS: z.coerce.number().int().min(1).max(10_000_000).default(3600),

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
    PLATFORM_BUNDLE_MAX_BYTES: z.coerce.number().int().min(1024).max(1024 ** 4).default(1024 ** 3),
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

    // --- Sprint 14: federation (edit only inside this block) ---
    /** How old a DPoP proof may be (RFC 9449 iat window); its jti is remembered this long so it cannot be replayed. */
    DPOP_PROOF_MAX_AGE_SECONDS: z.coerce.number().int().min(10).max(600).default(60),
    // --- end Sprint 14 federation ---
    // --- Sprint 11: account self-service (edit only inside this block) ---
    /** Breached-password check for new passwords: HIBP k-anonymity range API, a local sorted SHA-1 file, both, or off. */
    BREACHED_PASSWORDS: z.enum(['off', 'hibp', 'file', 'both']).default('off'),
    /** Base URL of the range API (GET <url>/range/<first 5 hex of SHA-1>); point it at an internal mirror if you have one. */
    BREACHED_HIBP_URL: z.url().default('https://api.pwnedpasswords.com'),
    BREACHED_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(3000),
    /** Uppercase SHA-1 hashes, one per line and sorted, optionally followed by :count (the HIBP "ordered by hash" download). */
    BREACHED_FILE: z.string().optional(),
    /** Sensitive account changes need a password or factor check this recent (ASVS 3.7.1). */
    STEPUP_WINDOW_SECONDS: z.coerce.number().int().min(30).max(24 * 3600).default(300),
    /** Password reset links by email: lifetime, and requests per hour per identifier and per account (four times that per address). */
    PASSWORD_RESET_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(60),
    PASSWORD_RESET_PER_HOUR: z.coerce.number().int().min(1).max(100).default(5),
    /** Invitations to set a first password (local accounts created with an email instead of a password). */
    PASSWORD_INVITE_HOURS: z.coerce.number().int().min(1).max(30 * 24).default(72),
    // --- end account ---
    // --- Sprint 17: identity and security (edit only inside this block) ---
    /** Notify the account owner of a sign-in from a new browser (device cookie) or a new network (/24, /48). */
    SIGNIN_NOTICES: bool.default(true),
    /** Require server-issued DPoP nonces (RFC 9449 section 8): a proof without the current nonce gets use_dpop_nonce. */
    DPOP_NONCES: bool.default(false),
    /** How long one DPoP nonce is accepted (the previous one stays valid for one more period). */
    DPOP_NONCE_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    /** The public base of the API when a reverse proxy serves it under another origin or path prefix (DPoP `htu`). */
    API_PUBLIC_URL: z.url().optional(),
    /** How often fetched SAML metadata (service providers and upstream identity providers) is refreshed. */
    FEDERATION_METADATA_REFRESH_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24),
    // --- end Sprint 17 ---
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
    // --- Sprint 15: operations (edit only inside this block) ---
    /** The previous key-encryption key, for `kms:rewrap` and for reads until it finishes: a local DATA_KEY, or OpenBao. */
    DATA_KEY_PREVIOUS: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'DATA_KEY_PREVIOUS must be 32 bytes, base64-encoded')
      .optional(),
    KMS_PREVIOUS_PROVIDER: z.enum(['local', 'openbao']).optional(),
    /** Import bundles: refuse to promote a bundle whose scan or staging step did not run. */
    PLATFORM_BUNDLE_REQUIRE_CHECKS: bool.default(false),
    /** Backups also archive the blob store (attachments, exports, media, checkpoints). */
    PLATFORM_BACKUP_BLOBS: bool.default(true),
    /** ACME challenge type; dns-01 publishes TXT records through ACME_DNS_PROVIDER. */
    ACME_CHALLENGE: z.enum(['http-01', 'dns-01']).default('http-01'),
    ACME_DNS_PROVIDER: z.enum(['none', 'webhook', 'rfc2136']).default('none'),
    ACME_DNS_WEBHOOK_URL: z.url().optional(),
    ACME_DNS_WEBHOOK_SECRET: z.string().min(16).optional(),
    /** RFC 2136 dynamic update: the primary server (host or host:port), the zone and the TSIG key. */
    ACME_DNS_RFC2136_SERVER: z.string().optional(),
    ACME_DNS_RFC2136_ZONE: z.string().regex(/^[A-Za-z0-9.-]+\.?$/).optional(),
    ACME_DNS_TSIG_NAME: z.string().regex(/^[A-Za-z0-9.-]+\.?$/).optional(),
    ACME_DNS_TSIG_SECRET: z.string().optional(),
    ACME_DNS_TSIG_ALGORITHM: z.enum(['hmac-sha256', 'hmac-sha512']).default('hmac-sha256'),
    /** Seconds to wait after publishing a TXT record before asking the CA to validate (secondary propagation). */
    ACME_DNS_WAIT_SECONDS: z.coerce.number().int().min(0).max(3600).default(5),
    /** Certificate file sink: every instance writes issued and renewed PEMs here for the reverse proxy. */
    ACME_CERT_DIR: z.string().optional(),
    /** Media previews and downloads from a separate origin through signed, short-lived URLs. */
    MEDIA_ORIGIN: z.url().optional(),
    MEDIA_URL_TTL_SECONDS: z.coerce.number().int().min(10).max(3600).default(300),
    /** SNTP servers (host or host:port, comma-separated; Sprint 22: several give a median and outliers) for the clock-skew check; unset: the database server only. */
    NTP_SERVER: z.string().optional(),
    NTP_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2000),
    /** OpenBao database secrets engine mount for dynamic data-connection credentials. */
    OPENBAO_DATABASE_MOUNT: z.string().regex(/^[a-z0-9_/-]+$/).default('database'),
    // --- end operations ---
    // --- Sprint 18: platform hardening (edit only inside this block) ---
    /** B-901: operator-chosen service URLs (pool instances, zone endpoints, image backends, the trainer). This comma list (hosts, *.domain, CIDRs) admits link-local hosts and, with SERVICE_INTERNAL_ONLY, public ones; metadata addresses are never admitted. */
    SERVICE_ALLOWED_HOSTS: z.string().default(''),
    SERVICE_INTERNAL_ONLY: bool.default(false),
    /** B-902: in production, refuse plaintext links to PostgreSQL, MySQL, Redis, S3 and OpenBao. */
    REQUIRE_BACKEND_TLS: bool.default(false),
    /** Links exempt from REQUIRE_BACKEND_TLS (comma list of database, redis, s3, openbao), e.g. a Redis sidecar on loopback. */
    BACKEND_TLS_EXEMPT: z.string().regex(/^\s*((database|redis|s3|openbao)\s*(,\s*|$))*$/, 'BACKEND_TLS_EXEMPT takes database, redis, s3 and openbao').default(''),
    /** B-904: ACME external account binding (RFC 8555 section 7.3.4): the key id and base64url HMAC key the CA gave out. */
    ACME_EAB_KID: z.string().max(500).optional(),
    ACME_EAB_HMAC_KEY: z.string().regex(/^[A-Za-z0-9_=+/-]+$/, 'ACME_EAB_HMAC_KEY is base64url').optional(),
    /** RFC 2136 transport: auto (UDP, then TCP when the answer is truncated or UDP gets none), udp or tcp. */
    ACME_DNS_RFC2136_TRANSPORT: z.enum(['auto', 'udp', 'tcp']).default('auto'),
    /** Certificate push hooks: named reload commands as JSON {"name": ["/usr/sbin/nginx", "-s", "reload"]} (argument arrays, no shell). */
    ACME_RELOAD_COMMANDS: z.string().default('{}'),
    ACME_HOOK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(30_000),
    /** B-905: training worker contract 2. Where the worker fetches run keys and stores artefacts (defaults to PUBLIC_URL). */
    TRAINER_CALLBACK_URL: z.url().optional(),
    /** Let a contract-1 worker receive dataset rows in plaintext (off: such a worker is refused). */
    TRAINER_PLAINTEXT_FALLBACK: bool.default(false),
    TRAINER_KEY_TTL_SECONDS: z.coerce.number().int().min(30).max(24 * 3600).default(900),
    /** SHA-256 fingerprint of the worker's client certificate; when set, key and artefact calls must present it. */
    TRAINER_CLIENT_CERT_SHA256: z.string().regex(/^([0-9A-Fa-f]{2}:?){31}[0-9A-Fa-f]{2}$/).optional(),
    TRAINER_ARTIFACT_MAX_BYTES: z.coerce.number().int().min(1024).max(1024 ** 4).default(64 * 1024 ** 3),
    /** Mutual TLS from the orchestrator to the worker. */
    TRAINER_CA_FILE: z.string().optional(),
    TRAINER_CERT_FILE: z.string().optional(),
    TRAINER_KEY_FILE: z.string().optional(),
    // --- end Sprint 18 ---

    // --- Sprint 19: knowledge, integrations and workflows ---
    /** Logical replication for PostgreSQL knowledge sources: off, or on for sources that ask for it. */
    KNOWLEDGE_REPLICATION: z.enum(['off', 'on']).default('on'),
    /** How often each instance claims and renews replication streams (ms); a stream's lease is three times this. */
    KNOWLEDGE_REPLICATION_TICK_MS: z.coerce.number().int().min(200).max(300_000).default(10_000),
    /** The Stripe webhook endpoint's signing secret (whsec_…); unset, POST /billing/stripe/webhook answers 404. */
    STRIPE_WEBHOOK_SECRET: z.string().min(8).optional(),
    STRIPE_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().min(10).max(3600).default(300),
    /** Without an image-safety classifier, withhold generated images and sampled frames instead of marking them. */
    IMAGE_SAFETY_REQUIRED: bool.default(false),
    /** An OCI runtime for script containers (runsc for gVisor); the runner passes --runtime and checks it exists. */
    SCRIPT_RUNTIME: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/).optional(),
    // --- end Sprint 19 ---

    // --- Sprint 22: operations, second part ---
    /** B-1401: OTLP/HTTP collector base URL (spans go to <url>/v1/traces); unset: no tracing. */
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
    /** The full traces URL, when the collector does not use /v1/traces under the base. */
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z.url().optional(),
    /** Extra collector request headers: name=value,name2=value2 (values percent-encoded), e.g. an API key. */
    OTEL_EXPORTER_OTLP_HEADERS: z.string().optional(),
    OTEL_EXPORTER_OTLP_TIMEOUT: z.coerce.number().int().min(100).max(120_000).default(10_000),
    OTEL_SERVICE_NAME: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/).default('exprsn-ai'),
    /** Fraction of new traces recorded; a caller's sampled flag in traceparent wins. */
    OTEL_TRACES_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(1),
    OTEL_BSP_MAX_QUEUE_SIZE: z.coerce.number().int().min(16).max(1_000_000).default(2048),
    OTEL_BSP_SCHEDULE_DELAY: z.coerce.number().int().min(10).max(600_000).default(5000),
    /** B-1403: how often each instance compares its migrations with the database's (0: only at start). */
    SCHEMA_CHECK_SECONDS: z.coerce.number().int().min(0).max(3600).default(30),
    /** B-1405: apply rendered zone NetworkPolicies through the Kubernetes API (server-side apply), and report drift. */
    ZONES_APPLY: z.enum(['off', 'kubernetes']).default('off'),
    /** The API server; defaults to https://$KUBERNETES_SERVICE_HOST:$KUBERNETES_SERVICE_PORT inside a pod. */
    ZONES_APPLY_API_URL: z.url().optional(),
    ZONES_APPLY_TOKEN_FILE: z.string().default('/var/run/secrets/kubernetes.io/serviceaccount/token'),
    ZONES_APPLY_CA_FILE: z.string().default('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'),
    ZONES_APPLY_FIELD_MANAGER: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,127}$/).default('exprsn-ai'),
    ZONES_APPLY_DRIFT_MINUTES: z.coerce.number().int().min(0).max(24 * 60).default(15),
    /** B-1406: SNTP servers that disagree with the median of the others by more than this are reported as outliers. */
    NTP_OUTLIER_MS: z.coerce.number().int().min(10).max(3_600_000).default(1000),
    /** B-1407: how often the shared rate-limit counters check that Redis answers. */
    RATELIMIT_PROBE_SECONDS: z.coerce.number().int().min(1).max(600).default(15),
    // --- end Sprint 22 ---
    // --- Sprint 23: knowledge, integrations and accessibility ---
    /**
     * Knowledge sources that fetch over HTTP (an S3-compatible endpoint of a source's own, an internal web site):
     * internal hosts only, unless this comma list (hosts, *.domain, CIDRs) names them. Link-local never.
     */
    KNOWLEDGE_ALLOWED_HOSTS: z.string().default(''),
    /** Per-request timeout for those fetches (ms). */
    KNOWLEDGE_FETCH_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(30_000),
    // --- end Sprint 23 ---
    // --- Sprint 24c (1.4.0): platform core ---
    /** B-2102: where the read-through cache keeps values: Redis when REDIS_URL is set (auto), or this process. */
    CACHE_STORE: z.enum(['auto', 'memory', 'redis']).default('auto'),
    /** TTL tiers (seconds) the cache's callers choose from. */
    CACHE_TTL_SHORT_SECONDS: z.coerce.number().int().min(1).max(3600).default(10),
    CACHE_TTL_MEDIUM_SECONDS: z.coerce.number().int().min(1).max(86_400).default(60),
    CACHE_TTL_LONG_SECONDS: z.coerce.number().int().min(1).max(7 * 86_400).default(600),
    /** Entries the memory store keeps (least recently used go first). */
    CACHE_MAX_ENTRIES: z.coerce.number().int().min(100).max(10_000_000).default(10_000),
    // --- end Sprint 24c ---
    // --- Sprint 25d (1.4.0): plugins that run ---
    /** B-2003: invocations a minute per plugin per tenant; events past it are dropped (counted, audited once a window). */
    PLUGIN_RATE_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(120),
    /** Invocations of one plugin running at once, across every instance; the rest wait their turn as queued jobs. */
    PLUGIN_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(2),
    /** How many plugins one chain of events may pass through (a plugin's action triggering another plugin…). */
    PLUGIN_MAX_DEPTH: z.coerce.number().int().min(1).max(10).default(3),
    /** B-2004: limits for a script handler run in the sandbox. */
    PLUGIN_SCRIPT_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(600).default(30),
    PLUGIN_SCRIPT_MEMORY_MB: z.coerce.number().int().min(64).max(4096).default(256),
    /** Platform calls one handler run may make through its scoped token. */
    PLUGIN_MAX_CALLS: z.coerce.number().int().min(1).max(10_000).default(50),
    /** B-2005: which plugins must come from a signed import bundle: script plugins (default), all, or none. */
    PLUGINS_REQUIRE_SIGNED: z.enum(['scripts', 'all', 'none']).default('scripts'),
    // --- end Sprint 25d ---
    // --- Sprint 26a (1.4.0): identity gaps ---
    /** B-1802: how long an email verification link works. */
    EMAIL_VERIFY_HOURS: z.coerce.number().int().min(1).max(30 * 24).default(48),
    /** B-1801: how long an invitation by a workspace admin works. */
    INVITATION_DAYS: z.coerce.number().int().min(1).max(90).default(7),
    /** B-1801: self-registrations accepted per client address per hour (per address and email too). */
    SIGNUP_PER_HOUR: z.coerce.number().int().min(1).max(1000).default(10),
    /** B-1805: the largest CSV a user import accepts, and its most rows. */
    USER_IMPORT_MAX_BYTES: z.coerce.number().int().min(1024).max(64 * 1024 * 1024).default(2 * 1024 * 1024),
    USER_IMPORT_MAX_ROWS: z.coerce.number().int().min(1).max(100_000).default(5000),
    // --- end Sprint 26a ---

    COOKIE_SECURE: bool.optional(),
    /** Requests a minute per user (or per address when signed out) across `/api`. */
    API_RATE_PER_MINUTE: z.coerce.number().int().min(60).max(100_000).default(600),
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
    METRICS_TOKEN: z.string().min(16).optional(),

    /** Sprint 12, chat: a streaming answer whose instance is silent this long is interrupted (and can be continued). */
    CHAT_STREAM_LEASE_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),
    /**
     * Sprint 16: the guard model and classifiers check streamed answers in the background. Hold-back is how many
     * screened sentence windows may wait for a verdict before generation pauses; 0 releases each window at once and
     * lets a verdict only stop later ones. The concurrency is the most background checks one instance runs at once.
     */
    CHAT_GUARD_HOLDBACK_SENTENCES: z.coerce.number().int().min(0).max(8).default(1),
    CHAT_GUARD_STREAM_CONCURRENCY: z.coerce.number().int().min(1).max(256).default(16),
    /** Sprint 16: anonymous share links opened per client address per minute. */
    SHARE_ANONYMOUS_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(30),
    /** How often each tenant's conversation retention policy is applied. */
    CHAT_RETENTION_SWEEP_MINUTES: z.coerce.number().int().min(0).max(7 * 24 * 60).default(60),

    /**
     * Sprint 20 (B-1201, B-1205): the signer process's UNIX socket. With KMS_PROVIDER=local the key-encryption key and
     * the OIDC, SAML and webhook private keys stay in the signer (`exprsn-ai signer`) and DATA_KEY is not needed here.
     * SIGNER_TOKEN (or SIGNER_TOKEN_FILE) is the shared token the signer expects first on every connection.
     */
    SIGNER_SOCKET: z.string().startsWith('/').optional(),
    SIGNER_TOKEN: z.string().min(32).optional(),
    SIGNER_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5000),
    /** Sprint 20 (B-1203): the clock skew allowed for `created` in RFC 9421 signatures on `/v1` requests. */
    HTTP_SIGNATURE_MAX_AGE_SECONDS: z.coerce.number().int().min(10).max(3600).default(300),
    /** Sprint 21 (B-1306): how often due agent schedules are looked for (a schedule fires at most this late). */
    AGENT_SCHEDULE_TICK_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
    /** Sprint 24 (B-1701): versions a new vault KV secret keeps (each secret's metadata can change it, 1 to 100). */
    VAULT_KV_MAX_VERSIONS: z.coerce.number().int().min(1).max(100).default(10),

    /**
     * Sprint 24 (B-1601 to B-1604): the certificate authority. PKI_PUBLIC_URL is the base its certificates name for
     * CRLs (`/pki/crl/<issuer>.crl`), OCSP (`/pki/ocsp`) and issuer certificates (default PUBLIC_URL). CRLs are signed
     * every PKI_CRL_MINUTES (and at once after a revocation) and are valid for PKI_CRL_VALIDITY_HOURS; OCSP answers are
     * valid for PKI_OCSP_VALIDITY_MINUTES and cached for PKI_OCSP_CACHE_SECONDS; delegated OCSP responder certificates
     * last PKI_OCSP_SIGNER_DAYS. PKI_PUBLIC_RATE_PER_MINUTE caps the public CRL, OCSP and CA routes per address.
     */
    PKI_PUBLIC_URL: z.url().optional(),
    PKI_CRL_MINUTES: z.coerce.number().int().min(0).max(7 * 24 * 60).default(60),
    PKI_CRL_VALIDITY_HOURS: z.coerce.number().int().min(1).max(30 * 24).default(24),
    PKI_OCSP_VALIDITY_MINUTES: z.coerce.number().int().min(1).max(7 * 24 * 60).default(60),
    PKI_OCSP_CACHE_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),
    PKI_OCSP_SIGNER_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    PKI_PUBLIC_RATE_PER_MINUTE: z.coerce.number().int().min(1).max(1_000_000).default(600),

    /**
     * Sprint 25 (B-1704): database leases from the built-in PostgreSQL and MySQL engines. An engine's TTLs default to
     * VAULT_LEASE_DEFAULT_TTL_SECONDS and may not pass VAULT_LEASE_MAX_TTL_SECONDS; the expiry sweeper looks for ended
     * leases every VAULT_LEASE_SWEEP_SECONDS (0 turns it off).
     */
    VAULT_LEASE_DEFAULT_TTL_SECONDS: z.coerce.number().int().min(1).max(31 * 86_400).default(3600),
    VAULT_LEASE_MAX_TTL_SECONDS: z.coerce.number().int().min(1).max(366 * 86_400).default(86_400),
    VAULT_LEASE_SWEEP_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),
    /** Sprint 25 (B-1706): how often rotation schedules are checked (0 turns it off), and how early a notice comes. */
    VAULT_ROTATION_CHECK_MINUTES: z.coerce.number().int().min(0).max(7 * 24 * 60).default(60),
    VAULT_ROTATION_NOTICE_DAYS: z.coerce.number().int().min(0).max(90).default(7),
    /**
     * 1.6.0, Sprint 36b (B-4803): every reveal of a KV secret is kept for VAULT_ANOMALY_HISTORY_DAYS; a reveal
     * from an address the secret was not revealed from in that time, at an hour of day it was never revealed in (once
     * it has at least VAULT_ANOMALY_MIN_HISTORY reveals), or the VAULT_ANOMALY_BURST-th reveal by one principal within
     * VAULT_ANOMALY_BURST_SECONDS raises a flag for the secret's owner. VAULT_ANOMALY_BURST=0 turns detection off.
     */
    VAULT_ANOMALY_BURST: z.coerce.number().int().min(0).max(1000).default(5),
    VAULT_ANOMALY_BURST_SECONDS: z.coerce.number().int().min(1).max(86_400).default(60),
    VAULT_ANOMALY_HISTORY_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    VAULT_ANOMALY_MIN_HISTORY: z.coerce.number().int().min(1).max(10_000).default(20),
    /**
     * 1.6.0, Sprint 37c (B-4801): the longest a KV secret may be shared with a principal, in days; every share then
     * carries an expiry within it (the default expiry when none is asked). 0: shares may be open-ended.
     */
    VAULT_SHARE_MAX_DAYS: z.coerce.number().int().min(0).max(3650).default(0),
    /** 1.6.0, Sprint 38c (B-7601): DLP inspects at most this many characters of an answer, output or upload. */
    DLP_MAX_TEXT_BYTES: z.coerce.number().int().min(10_000).max(50_000_000).default(1_048_576),
    /**
     * 1.6.0, Sprint 38c (B-7603): a compliance export writes at most COMPLIANCE_EXPORT_MAX_ROWS objects (conversations
     * count their messages) and covers at most COMPLIANCE_EXPORT_MAX_DAYS (0: any range).
     */
    COMPLIANCE_EXPORT_MAX_ROWS: z.coerce.number().int().min(100).max(10_000_000).default(100_000),
    COMPLIANCE_EXPORT_MAX_DAYS: z.coerce.number().int().min(0).max(36_500).default(0),
    /**
     * 1.6.0, Sprint 37c (B-7201): SCIM 2.0 provisioning at /scim/v2. A list answers at most IDENTITY_SCIM_MAX_RESULTS
     * resources a page (ServiceProviderConfig `filter.maxResults`); each address is limited to
     * IDENTITY_SCIM_RATE_PER_MINUTE requests; new SCIM tokens expire after IDENTITY_SCIM_TOKEN_MAX_DAYS at most (0: a
     * token may be open-ended, until it is revoked).
     */
    IDENTITY_SCIM_MAX_RESULTS: z.coerce.number().int().min(1).max(1000).default(200),
    IDENTITY_SCIM_RATE_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(1200),
    IDENTITY_SCIM_TOKEN_MAX_DAYS: z.coerce.number().int().min(0).max(3650).default(365),
    /**
     * Sprint 25 (B-1608 to B-1611): AT-Protocol trust. ATPROTO_PUBLIC_URL is the base the platform's did:web and the
     * tenants' path-form DIDs and labeler endpoints live under (default PUBLIC_URL); ATPROTO_PLC_URL is the PLC
     * directory did:plc operations go to and are resolved from (through the service URL checks). The public DID,
     * queryLabels and subscribeLabels routes are capped per address by ATPROTO_PUBLIC_RATE_PER_MINUTE, with at most
     * ATPROTO_SUBSCRIBERS_MAX open label streams per instance; trusted external labelers are read every
     * ATPROTO_LABEL_PULL_MINUTES (0: only on demand).
     */
    ATPROTO_PUBLIC_URL: z.url().optional(),
    ATPROTO_PLC_URL: z.url().default('https://plc.directory'),
    ATPROTO_PUBLIC_RATE_PER_MINUTE: z.coerce.number().int().min(1).max(1_000_000).default(600),
    ATPROTO_SUBSCRIBERS_MAX: z.coerce.number().int().min(1).max(100_000).default(200),
    ATPROTO_LABEL_PULL_MINUTES: z.coerce.number().int().min(0).max(24 * 60).default(5),
    /**
     * Sprint 25 (B-1605): the ACME server at `/pki/acme/<tenant>/directory`. Orders and their pending authorizations
     * last PKI_ACME_ORDER_HOURS; replay nonces PKI_ACME_NONCE_MINUTES. PKI_ACME_RATE_PER_MINUTE caps new accounts,
     * orders and challenge requests per address (on top of PKI_PUBLIC_RATE_PER_MINUTE). http-01 is fetched from
     * port PKI_ACME_HTTP_PORT through the service address checks (cloud metadata and link-local always refused; public
     * addresses refused with PKI_ACME_INTERNAL_ONLY unless PKI_ACME_ALLOWED_HOSTS names them); dns-01 asks
     * PKI_ACME_DNS_SERVERS (host[:port], comma-separated) or the system resolver. PKI_ACME_URL overrides the base
     * the directory's URLs are built on (default PKI_PUBLIC_URL, then PUBLIC_URL).
     */
    PKI_ACME_URL: z.url().optional(),
    PKI_ACME_ORDER_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24),
    PKI_ACME_NONCE_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(60),
    PKI_ACME_RATE_PER_MINUTE: z.coerce.number().int().min(1).max(1_000_000).default(120),
    PKI_ACME_HTTP_PORT: z.coerce.number().int().min(1).max(65_535).default(80),
    PKI_ACME_INTERNAL_ONLY: bool.default(false),
    PKI_ACME_ALLOWED_HOSTS: z.string().default(''),
    PKI_ACME_DNS_SERVERS: z.string().optional(),
    /**
     * Sprint 25 (B-1606): expiry notices. Certificates PKI_EXPIRY_NOTICE_DAYS (comma-separated) days from expiry
     * notify their owner once per threshold; the sweep runs every PKI_EXPIRY_SWEEP_MINUTES (0 turns it off).
     */
    PKI_EXPIRY_NOTICE_DAYS: z.string().regex(/^\s*\d{1,3}(\s*,\s*\d{1,3})*\s*$/, 'comma-separated whole days, such as 30,7').default('30,7'),
    PKI_EXPIRY_SWEEP_MINUTES: z.coerce.number().int().min(0).max(7 * 24 * 60).default(360),
    /**
     * Sprint 26d (B-2401 to B-2404): the file store. FILES_MAX_BYTES caps one upload (streamed, never buffered; ClamAV's
     * StreamMaxLength must be at least this when CLAMD_HOST is set). Trashed files and folders are purged
     * FILES_TRASH_DAYS after they went to the trash, by a job every FILES_PURGE_MINUTES (0 turns it off). Previews
     * (a PNG at most FILES_PREVIEW_PX on its longer side) are drawn for images and PDFs up to FILES_PREVIEW_MAX_BYTES,
     * with MEDIA_FFMPEG for images and FILES_PDFTOPPM (poppler) for PDFs, in FILES_WORK_DIR (default the system
     * temporary directory).
     */
    FILES_MAX_BYTES: z.coerce.number().int().min(1024).max(1024 * 1024 * 1024 * 1024).default(1024 * 1024 * 1024),
    FILES_TRASH_DAYS: z.coerce.number().int().min(0).max(3650).default(30),
    FILES_PURGE_MINUTES: z.coerce.number().int().min(0).max(7 * 24 * 60).default(60),
    FILES_PREVIEW_MAX_BYTES: z.coerce.number().int().min(0).max(1024 * 1024 * 1024).default(50 * 1024 * 1024),
    FILES_PREVIEW_PX: z.coerce.number().int().min(64).max(2048).default(512),
    FILES_PDFTOPPM: z.string().min(1).default('pdftoppm'),
    FILES_WORK_DIR: z.string().optional(),
    /**
     * Sprint 26 (B-1904 to B-1906): moderation. The sweep escalates routed flags past their queue's SLA and ends
     * sanctions past their duration every MODERATION_SWEEP_SECONDS (0 turns it off; enforcement still compares the
     * end time). External moderation providers send content off the site, so they are off unless
     * MODERATION_EXTERNAL_PROVIDERS is set, and then only run in zones with egress; each call waits at most
     * MODERATION_PROVIDER_TIMEOUT_MS.
     */
    MODERATION_SWEEP_SECONDS: z.coerce.number().int().min(0).max(24 * 3600).default(60),
    MODERATION_EXTERNAL_PROVIDERS: bool.default(false),
    MODERATION_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(5000),
    /**
     * Sprint 27 (B-1908): AT-Protocol firehose ingest. Each worker instance's manager claims or renews the lease on
     * running subscriptions every FIREHOSE_TICK_MS (a lease lasts three ticks); a consumer stores its cursor every
     * FIREHOSE_CHECKPOINT_MS and when it stops, pauses its socket when FIREHOSE_QUEUE_MAX messages wait, reconnects
     * with backoff up to FIREHOSE_BACKOFF_MAX_MS, and reconnects after FIREHOSE_IDLE_MS without a message. A tenant has
     * at most FIREHOSE_MAX_PER_TENANT subscriptions.
     */
    FIREHOSE_TICK_MS: z.coerce.number().int().min(50).max(600_000).default(10_000),
    FIREHOSE_CHECKPOINT_MS: z.coerce.number().int().min(50).max(600_000).default(5000),
    FIREHOSE_QUEUE_MAX: z.coerce.number().int().min(1).max(100_000).default(1000),
    FIREHOSE_BACKOFF_MAX_MS: z.coerce.number().int().min(100).max(3_600_000).default(60_000),
    FIREHOSE_IDLE_MS: z.coerce.number().int().min(100).max(3_600_000).default(90_000),
    FIREHOSE_MAX_PER_TENANT: z.coerce.number().int().min(0).max(1000).default(10),
    /**
     * Sprint 31 (B-3604, B-3001 to B-3003): a subscription audits at most FIREHOSE_REJECT_AUDITS relay commits that
     * failed verification a minute (the rest are counted and summed in the next audit). A tenant has at most
     * FEEDS_MAX_PER_TENANT feed generators, each keeping at most FEED_ITEMS_MAX posts; feed indexes are pruned to their
     * retention every FEED_PRUNE_MINUTES (0: never).
     */
    FIREHOSE_REJECT_AUDITS: z.coerce.number().int().min(0).max(10_000).default(20),
    FEEDS_MAX_PER_TENANT: z.coerce.number().int().min(0).max(1000).default(20),
    FEED_ITEMS_MAX: z.coerce.number().int().min(10).max(10_000_000).default(50_000),
    FEED_PRUNE_MINUTES: z.coerce.number().int().min(0).max(24 * 60).default(15),
    /**
     * 1.5.0, Sprint 31 (B-2901 to B-2906): the AT-Protocol personal data server. PDS_PUBLIC_URL is the PDS's public
     * https base (default ATPROTO_PUBLIC_URL, then PUBLIC_URL): accounts' DID documents name it as their
     * `#atproto_pds` and relays crawl it. Handles are `<name>.<tenant>.<PDS_HANDLE_DOMAIN>` (default the PDS host
     * name; the operator points a wildcard DNS record for each tenant at the server). Hosting is enabled per tenant by
     * a platform admin, in PDS_ZONE (the zone must have egress to the network: relays and the PLC directory).
     * PDS_RELAYS (comma-separated https URLs) are asked to crawl the PDS (`requestCrawl`) at most every
     * PDS_CRAWL_MINUTES after a change; subscribeRepos replays PDS_BACKFILL_HOURS of events to a cursor, with at most
     * PDS_SUBSCRIBERS_MAX open streams per instance. Blobs are at most PDS_BLOB_MAX_BYTES (a tenant may lower it) and
     * of the PDS_BLOB_TYPES MIME types. Access tokens last PDS_ACCESS_MINUTES, refresh tokens PDS_REFRESH_DAYS.
     * XRPC calls are capped per address by PDS_RATE_PER_MINUTE and repo writes per account by PDS_WRITES_PER_HOUR. A
     * repo imported by a migration (`importRepo`, read whole to verify it) is at most PDS_IMPORT_MAX_BYTES.
     */
    PDS_PUBLIC_URL: z.url().optional(),
    PDS_HANDLE_DOMAIN: z
      .string()
      .trim()
      .toLowerCase()
      .max(200)
      .regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/)
      .optional(),
    PDS_ZONE: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/).default('edge'),
    PDS_RELAYS: z
      .string()
      .default('')
      .transform((v) => v.split(',').map((x) => x.trim()).filter(Boolean))
      .pipe(z.array(z.url()).max(20)),
    PDS_CRAWL_MINUTES: z.coerce.number().int().min(0).max(24 * 60).default(20),
    PDS_BACKFILL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(72),
    PDS_SUBSCRIBERS_MAX: z.coerce.number().int().min(1).max(100_000).default(200),
    PDS_BLOB_MAX_BYTES: z.coerce.number().int().min(1024).max(1024 * 1024 * 1024).default(50 * 1024 * 1024),
    PDS_BLOB_TYPES: z
      .string()
      .default('image/png,image/jpeg,image/webp,image/gif,video/mp4')
      .transform((v) => v.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)),
    PDS_ACCESS_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(60),
    PDS_REFRESH_DAYS: z.coerce.number().int().min(1).max(365).default(60),
    PDS_RATE_PER_MINUTE: z.coerce.number().int().min(1).max(1_000_000).default(3000),
    PDS_WRITES_PER_HOUR: z.coerce.number().int().min(1).max(1_000_000).default(5000),
    PDS_IMPORT_MAX_BYTES: z.coerce.number().int().min(1024).max(1024 * 1024 * 1024).default(64 * 1024 * 1024),
    /**
     * Sprint 27 (B-2201 to B-2208): low-code apps. Public form submissions are limited per address to
     * APPS_PUBLIC_FORM_PER_MINUTE (each form also has its own limit). A CSV import is at most APPS_IMPORT_MAX_BYTES (it
     * travels in the JSON body, so within the API's 256 kB limit) and APPS_IMPORT_MAX_ROWS rows; an export at most
     * APPS_EXPORT_MAX_ROWS records; a bulk write at most APPS_BULK_MAX operations. Chains of record triggers stop at
     * APPS_TRIGGER_MAX_DEPTH; schedule triggers are checked every APPS_SCHEDULE_TICK_SECONDS (0 turns them off).
     */
    APPS_PUBLIC_FORM_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(10),
    APPS_IMPORT_MAX_BYTES: z.coerce.number().int().min(1024).max(250_000).default(200_000),
    APPS_IMPORT_MAX_ROWS: z.coerce.number().int().min(1).max(100_000).default(10_000),
    APPS_EXPORT_MAX_ROWS: z.coerce.number().int().min(1).max(1_000_000).default(100_000),
    APPS_BULK_MAX: z.coerce.number().int().min(1).max(1000).default(500),
    APPS_TRIGGER_MAX_DEPTH: z.coerce.number().int().min(1).max(10).default(3),
    APPS_SCHEDULE_TICK_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),
    /**
     * 1.6.0, Sprint 36b (B-4701): a public form submission the `user-input` guardrail holds waits for review instead of being
     * refused; at most APPS_HELD_MAX_PER_FORM wait per form (beyond that a held value is refused, as before), and a
     * decided one is deleted APPS_HELD_KEEP_DAYS after its decision (its values are dropped at the decision).
     */
    APPS_HELD_MAX_PER_FORM: z.coerce.number().int().min(0).max(100_000).default(200),
    APPS_HELD_KEEP_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
    /**
     * 1.6.0, Sprint 39c (B-8401, B-8402, B-8501): an edit of a field an AI field reads regenerates it once after
     * APPS_AI_DEBOUNCE_MS of quiet (0: at once, every time); a fill of an AI field over every row covers at most
     * APPS_AI_FILL_MAX_ROWS records; a pull from an outside table reads at most APPS_SOURCE_PULL_MAX_ROWS rows.
     */
    APPS_AI_DEBOUNCE_MS: z.coerce.number().int().min(0).max(600_000).default(2000),
    APPS_AI_FILL_MAX_ROWS: z.coerce.number().int().min(1).max(1_000_000).default(10_000),
    APPS_SOURCE_PULL_MAX_ROWS: z.coerce.number().int().min(1).max(1_000_000).default(10_000),
    /**
     * Sprint 32b (B-3903): workflows started by their own triggers. An event trigger fires at most
     * WORKFLOW_EVENT_RATE_PER_MINUTE times a minute (in the shared counter store), and an event caused by a chain of
     * WORKFLOW_EVENT_MAX_DEPTH workflows is dropped (the cap B-4101's chain context keeps for this kind). Schedule
     * triggers are checked every WORKFLOW_SCHEDULE_TICK_SECONDS (0 turns them off).
     */
    WORKFLOW_EVENT_RATE_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(60),
    WORKFLOW_EVENT_MAX_DEPTH: z.coerce.number().int().min(1).max(10).default(3),
    WORKFLOW_SCHEDULE_TICK_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),
    /**
     * Sprint 27c (B-2501, B-2504): groups and events. Invitations expire after GROUP_INVITE_DAYS and join requests after
     * GROUP_REQUEST_DAYS. Signed calendar feeds are rate-limited per address (CALENDAR_FEED_PER_MINUTE) and show
     * events labelled above CALENDAR_FEED_MAX_LABEL only as busy time (calendar clients copy feeds to other servers).
     */
    GROUP_INVITE_DAYS: z.coerce.number().int().min(1).max(365).default(7),
    GROUP_REQUEST_DAYS: z.coerce.number().int().min(1).max(365).default(14),
    CALENDAR_FEED_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(60),
    CALENDAR_FEED_MAX_LABEL: z.enum(['public', 'internal', 'confidential', 'restricted']).default('internal'),
    /**
     * Sprint 28a (B-2301 to B-2304): customer-service channels. New customer sessions are limited per address across
     * every channel (CHANNELS_SESSIONS_PER_HOUR; each channel also has its own limit); a session token lasts
     * CHANNELS_SESSION_HOURS. A reply waits at most CHANNELS_REPLY_TIMEOUT_MS for the model. IMAP mailboxes are polled
     * every CHANNELS_IMAP_POLL_SECONDS (0 turns polling off) and each poll reads at most CHANNELS_IMAP_BATCH messages;
     * inbound webhooks are limited per channel (CHANNELS_WEBHOOK_PER_MINUTE) and refuse a signature older than
     * CHANNELS_WEBHOOK_TOLERANCE_SECONDS. Retention purges run every CHANNELS_RETENTION_SWEEP_MINUTES.
     */
    CHANNELS_SESSIONS_PER_HOUR: z.coerce.number().int().min(1).max(100_000).default(30),
    CHANNELS_SESSION_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24),
    CHANNELS_REPLY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(60_000),
    CHANNELS_IMAP_POLL_SECONDS: z.coerce.number().int().min(0).max(86_400).default(60),
    CHANNELS_IMAP_BATCH: z.coerce.number().int().min(1).max(500).default(50),
    CHANNELS_WEBHOOK_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(120),
    CHANNELS_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().min(30).max(86_400).default(300),
    CHANNELS_RETENTION_SWEEP_MINUTES: z.coerce.number().int().min(1).max(7 * 24 * 60).default(60),
    /**
     * Sprint 28a (B-1806): email one-time codes as a second factor. A code is valid for MFA_EMAIL_CODE_MINUTES; a user
     * is sent at most MFA_EMAIL_SENDS_PER_HOUR codes. Wrong codes count in the same lockout as wrong TOTP codes.
     */
    MFA_EMAIL_CODE_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
    MFA_EMAIL_SENDS_PER_HOUR: z.coerce.number().int().min(1).max(100).default(5),
    /**
     * Sprint 28b (B-2601 to B-2605): messaging. A group conversation holds at most MESSAGING_MAX_MEMBERS people.
     * MESSAGING_EMBED_MODEL (an approved embedding model) turns on semantic search; without it search is by keyword
     * only. Summaries and catch-up digests use the profile MESSAGING_SUMMARY_PROFILE unless the request names one, over
     * at most MESSAGING_SUMMARY_MAX_MESSAGES messages. ROOM_SIGNALS_PER_MINUTE caps the signals (typing, delivery and
     * read receipts) one socket may send into realtime rooms.
     */
    MESSAGING_MAX_MEMBERS: z.coerce.number().int().min(3).max(10_000).default(256),
    MESSAGING_EMBED_MODEL: z.string().max(200).optional(),
    MESSAGING_SUMMARY_PROFILE: z.string().min(1).max(63).default('general'),
    MESSAGING_SUMMARY_MAX_MESSAGES: z.coerce.number().int().min(10).max(2000).default(200),
    ROOM_SIGNALS_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(60),
    /**
     * Sprint 28c (B-2701 to B-2705): the workspace feed. Posts and comments are at most FEED_POST_MAX_CHARS characters.
     * A new post reaches the open home feeds of at most FEED_HOME_FANOUT_MAX followers live (the others see it on their
     * next load). Hashtags are counted every FEED_TRENDING_MINUTES (0 turns it off) over the last FEED_TRENDING_HOURS.
     * The weekly digest of a workspace lists its FEED_DIGEST_TOP posts of the week labelled up to FEED_DIGEST_MAX_LABEL,
     * summarised by the workspace's digest profile, or FEED_DIGEST_PROFILE when it names none (empty: no digest).
     */
    FEED_POST_MAX_CHARS: z.coerce.number().int().min(100).max(100_000).default(5000),
    FEED_HOME_FANOUT_MAX: z.coerce.number().int().min(0).max(100_000).default(1000),
    FEED_TRENDING_MINUTES: z.coerce.number().int().min(0).max(7 * 24 * 60).default(60),
    FEED_TRENDING_HOURS: z.coerce.number().int().min(1).max(30 * 24).default(72),
    FEED_DIGEST_PROFILE: z.string().trim().max(200).optional(),
    FEED_DIGEST_TOP: z.coerce.number().int().min(1).max(50).default(5),
    FEED_DIGEST_MAX_LABEL: z.enum(['public', 'internal', 'confidential', 'restricted']).default('internal'),
    /**
     * 1.5.0, Sprint 30 (B-3801 to B-3803): imports from public repositories. IMPORT_CONNECTIVITY `bundle` marks an
     * air-gapped instance: requests queue for the weekly signed bundle instead of reaching out. Outbound calls go
     * through IMPORT_PROXY_URL (the staging proxy) when set, and only to the hosts of confirmed repositories plus
     * IMPORT_ALLOWED_HOSTS (which, like SERVICE_ALLOWED_HOSTS, also admits a link-local host; metadata addresses never).
     * Downloads are stored in parts of IMPORT_PART_BYTES so an interrupted one resumes; one import fetches at most
     * IMPORT_MAX_BYTES. A harvest keeps at most IMPORT_HARVEST_MAX_ITEMS items per repository; due harvests are queued
     * every IMPORT_HARVEST_TICK_MINUTES (0 turns schedules off) and promoted bundles are matched to queued requests
     * every IMPORT_BUNDLE_POLL_MINUTES. A rate-limited source backs off up to IMPORT_BACKOFF_MAX_MINUTES. Dataset
     * imports draw on a quota of IMPORT_DATASET_QUOTA_GB per tenant unless a system admin sets another.
     */
    IMPORT_CONNECTIVITY: z.enum(['direct', 'bundle']).default('direct'),
    IMPORT_PROXY_URL: z.string().url().optional(),
    IMPORT_ALLOWED_HOSTS: z.string().default(''),
    IMPORT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(60_000),
    IMPORT_PART_BYTES: z.coerce.number().int().min(1024).max(1024 * 1024 * 1024).default(64 * 1024 * 1024),
    IMPORT_MAX_BYTES: z.coerce.number().int().min(1024).max(10 * 1024 ** 4).default(500 * 1024 ** 3),
    IMPORT_HARVEST_MAX_ITEMS: z.coerce.number().int().min(10).max(1_000_000).default(20_000),
    IMPORT_HARVEST_TICK_MINUTES: z.coerce.number().int().min(0).max(24 * 60).default(5),
    IMPORT_BUNDLE_POLL_MINUTES: z.coerce.number().int().min(0).max(24 * 60).default(15),
    IMPORT_BACKOFF_MAX_MINUTES: z.coerce.number().int().min(1).max(7 * 24 * 60).default(360),
    IMPORT_DATASET_QUOTA_GB: z.coerce.number().int().min(0).max(1_000_000).default(500),
    // --- 1.6.0, Sprint 35c: storage and configuration (edit only inside this block) ---
    /**
     * B-4205: settings the Configuration screen may override from the database, each only after a second platform
     * admin approves (off: settings are managed in the environment only). Every instance reports the values it reads
     * every PLATFORM_INSTANCE_REPORT_SECONDS under INSTANCE_NAME (default the host name), so instances that disagree
     * show as differing.
     */
    PLATFORM_SETTINGS_OVERRIDES: bool.default(true),
    INSTANCE_NAME: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/).optional(),
    PLATFORM_INSTANCE_REPORT_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),
    /**
     * B-4204: the blob integrity check (ops.blobs.verify) runs every BLOBS_VERIFY_MINUTES (0 turns the schedule off;
     * it can still be started from Storage). An object younger than BLOBS_ORPHAN_GRACE_HOURS is never an orphan (an
     * upload may still be writing its row), and a dry run of orphan deletion stays valid for BLOBS_DRY_RUN_MINUTES.
     */
    BLOBS_VERIFY_MINUTES: z.coerce.number().int().min(0).max(30 * 24 * 60).default(24 * 60),
    BLOBS_ORPHAN_GRACE_HOURS: z.coerce.number().int().min(1).max(24 * 365).default(24),
    BLOBS_DRY_RUN_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(60)
    // --- end Sprint 35c ---
  });

/** B-4205: the fields of the environment schema, for the settings descriptor and for checking an override's value. */
export const CONFIG_FIELDS = base.shape;

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
    if (c.KMS_PROVIDER === 'local' && !c.DATA_KEY && !c.SIGNER_SOCKET) {
      ctx.addIssue({ code: 'custom', path: ['DATA_KEY'], message: 'DATA_KEY is required when KMS_PROVIDER=local (or run the signer and set SIGNER_SOCKET)' });
    }
    // Sprint 20 (B-1201, B-1205): the signer serves the local KMS; OpenBao keeps signing in transit.
    if (c.SIGNER_SOCKET && c.KMS_PROVIDER !== 'local') {
      ctx.addIssue({ code: 'custom', path: ['SIGNER_SOCKET'], message: 'SIGNER_SOCKET works with KMS_PROVIDER=local; with OpenBao, transit holds the keys' });
    }
    if (c.SIGNER_SOCKET && !c.SIGNER_TOKEN) {
      ctx.addIssue({ code: 'custom', path: ['SIGNER_TOKEN'], message: 'SIGNER_SOCKET needs SIGNER_TOKEN_FILE (the token the signer expects)' });
    }
    if (c.NODE_ENV === 'production' && c.SIGNER_SOCKET && c.DATA_KEY) {
      ctx.addIssue({ code: 'custom', path: ['DATA_KEY'], message: 'With the signer the key-encryption key lives only in the signer\'s key file: remove DATA_KEY and DATA_KEY_FILE from the app' });
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
    if (c.CACHE_STORE === 'redis' && !c.REDIS_URL) {
      ctx.addIssue({ code: 'custom', path: ['REDIS_URL'], message: 'REDIS_URL is required when CACHE_STORE=redis' });
    }
    if ((c.BREACHED_PASSWORDS === 'file' || c.BREACHED_PASSWORDS === 'both') && !c.BREACHED_FILE) {
      ctx.addIssue({ code: 'custom', path: ['BREACHED_FILE'], message: `BREACHED_FILE is required when BREACHED_PASSWORDS=${c.BREACHED_PASSWORDS}` });
    }
    if (c.BILLING_PROVIDER === 'stripe' && !c.STRIPE_SECRET_KEY) {
      ctx.addIssue({ code: 'custom', path: ['STRIPE_SECRET_KEY'], message: 'STRIPE_SECRET_KEY is required when BILLING_PROVIDER=stripe' });
    }
    if (c.KMS_PREVIOUS_PROVIDER === 'openbao' && (!c.OPENBAO_ADDR || !c.OPENBAO_TOKEN)) {
      ctx.addIssue({ code: 'custom', path: ['KMS_PREVIOUS_PROVIDER'], message: 'KMS_PREVIOUS_PROVIDER=openbao needs OPENBAO_ADDR and OPENBAO_TOKEN' });
    }
    if (c.KMS_PREVIOUS_PROVIDER === 'local' && !c.DATA_KEY_PREVIOUS && (c.KMS_PROVIDER === 'local' || !c.DATA_KEY)) {
      ctx.addIssue({ code: 'custom', path: ['DATA_KEY_PREVIOUS'], message: 'KMS_PREVIOUS_PROVIDER=local needs DATA_KEY_PREVIOUS (the old DATA_KEY)' });
    }
    if (c.ACME_CHALLENGE === 'dns-01' && c.ACME_DNS_PROVIDER === 'none') {
      ctx.addIssue({ code: 'custom', path: ['ACME_DNS_PROVIDER'], message: 'ACME_CHALLENGE=dns-01 needs ACME_DNS_PROVIDER (webhook or rfc2136)' });
    }
    if (c.ACME_DNS_PROVIDER === 'webhook' && (!c.ACME_DNS_WEBHOOK_URL || !c.ACME_DNS_WEBHOOK_SECRET)) {
      ctx.addIssue({ code: 'custom', path: ['ACME_DNS_WEBHOOK_URL'], message: 'ACME_DNS_PROVIDER=webhook needs ACME_DNS_WEBHOOK_URL and ACME_DNS_WEBHOOK_SECRET' });
    }
    // Sprint 18 (B-904): the zone may be left out and is then found from the SOA record.
    if (c.ACME_DNS_PROVIDER === 'rfc2136' && (!c.ACME_DNS_RFC2136_SERVER || !c.ACME_DNS_TSIG_NAME || !c.ACME_DNS_TSIG_SECRET)) {
      ctx.addIssue({ code: 'custom', path: ['ACME_DNS_RFC2136_SERVER'], message: 'ACME_DNS_PROVIDER=rfc2136 needs ACME_DNS_RFC2136_SERVER, ACME_DNS_TSIG_NAME and ACME_DNS_TSIG_SECRET (ACME_DNS_RFC2136_ZONE is optional)' });
    }
    if (!!c.ACME_EAB_KID !== !!c.ACME_EAB_HMAC_KEY) ctx.addIssue({ code: 'custom', path: ['ACME_EAB_KID'], message: 'ACME_EAB_KID and ACME_EAB_HMAC_KEY go together' });
    try {
      const cmds = JSON.parse(c.ACME_RELOAD_COMMANDS) as unknown;
      if (!cmds || typeof cmds !== 'object' || Array.isArray(cmds) || !Object.entries(cmds).every(([k, v]) => /^[a-z0-9][a-z0-9_-]{0,62}$/.test(k) && Array.isArray(v) && v.length > 0 && v.every((a) => typeof a === 'string'))) throw new Error('shape');
    } catch {
      ctx.addIssue({ code: 'custom', path: ['ACME_RELOAD_COMMANDS'], message: 'ACME_RELOAD_COMMANDS is a JSON object of names (lower case) to argument arrays, e.g. {"nginx":["/usr/sbin/nginx","-s","reload"]}' });
    }
    // Sprint 18 (B-902): plaintext links to the backing services are refused in production when asked to.
    if (c.NODE_ENV === 'production' && c.REQUIRE_BACKEND_TLS) {
      for (const p of backendTlsProblems(c)) ctx.addIssue({ code: 'custom', path: [p.path], message: p.message });
    }
    // Sprint 24: a CRL must still be valid when the next scheduled one is signed.
    if (c.VAULT_LEASE_DEFAULT_TTL_SECONDS > c.VAULT_LEASE_MAX_TTL_SECONDS) {
      ctx.addIssue({ code: 'custom', path: ['VAULT_LEASE_DEFAULT_TTL_SECONDS'], message: 'VAULT_LEASE_DEFAULT_TTL_SECONDS cannot be longer than VAULT_LEASE_MAX_TTL_SECONDS' });
    }
    if (c.PKI_CRL_MINUTES > 0 && c.PKI_CRL_MINUTES >= c.PKI_CRL_VALIDITY_HOURS * 60) {
      ctx.addIssue({ code: 'custom', path: ['PKI_CRL_VALIDITY_HOURS'], message: 'PKI_CRL_VALIDITY_HOURS must be longer than PKI_CRL_MINUTES' });
    }
    if (c.NODE_ENV === 'production' && !c.COOKIE_SECURE) {
      ctx.addIssue({ code: 'custom', path: ['COOKIE_SECURE'], message: 'Production requires HTTPS (PUBLIC_URL https://) or COOKIE_SECURE=true behind a TLS proxy' });
    }
  });

export type Config = z.infer<typeof schema>;

/**
 * B-902: which backing-service links would carry plaintext (ASVS 1.9.1). SQLite is a local file and exempt; each
 * other link can be exempted in BACKEND_TLS_EXEMPT (a sidecar on loopback, a service mesh that adds mTLS).
 *   database  PostgreSQL: sslmode require, verify-ca or verify-full (or ssl=true); MySQL: an ssl parameter
 *   redis     rediss://
 *   s3        an https:// S3_ENDPOINT
 *   openbao   an https:// OPENBAO_ADDR
 */
export function backendTlsProblems(c: { DB_CLIENT: string; DATABASE_URL?: string | undefined; REDIS_URL?: string | undefined; BLOB_STORE: string; S3_ENDPOINT?: string | undefined; OPENBAO_ADDR?: string | undefined; BACKEND_TLS_EXEMPT: string }): { path: string; message: string }[] {
  const exempt = new Set(c.BACKEND_TLS_EXEMPT.split(',').map((x) => x.trim()).filter(Boolean));
  const out: { path: string; message: string }[] = [];
  const hint = (link: string) => ` (REQUIRE_BACKEND_TLS is on; add ${link} to BACKEND_TLS_EXEMPT to allow this link in plaintext)`;
  if (c.DB_CLIENT !== 'sqlite' && c.DATABASE_URL && !exempt.has('database')) {
    let q: URLSearchParams | null;
    try {
      q = new URL(c.DATABASE_URL).searchParams;
    } catch {
      q = null;
    }
    if (c.DB_CLIENT === 'pg') {
      const mode = (q?.get('sslmode') ?? '').toLowerCase();
      const ssl = (q?.get('ssl') ?? '').toLowerCase();
      const ok = ['require', 'verify-ca', 'verify-full'].includes(mode) || (!mode && (ssl === 'true' || ssl === '1'));
      if (!ok) out.push({ path: 'DATABASE_URL', message: `PostgreSQL link without TLS (sslmode=${mode || 'unset'}); use sslmode=verify-full${hint('database')}` });
    } else {
      const ssl = q?.get('ssl');
      if (ssl == null || ['', 'false', '0'].includes(ssl.toLowerCase())) out.push({ path: 'DATABASE_URL', message: `MySQL link without TLS; add ?ssl={"rejectUnauthorized":true}${hint('database')}` });
    }
  }
  if (c.REDIS_URL && !exempt.has('redis') && !/^rediss:\/\//i.test(c.REDIS_URL)) out.push({ path: 'REDIS_URL', message: `Redis link without TLS; use rediss://${hint('redis')}` });
  if (c.BLOB_STORE === 's3' && c.S3_ENDPOINT && !exempt.has('s3') && !/^https:\/\//i.test(c.S3_ENDPOINT)) out.push({ path: 'S3_ENDPOINT', message: `S3 endpoint without TLS; use https://${hint('s3')}` });
  if (c.OPENBAO_ADDR && !exempt.has('openbao') && !/^https:\/\//i.test(c.OPENBAO_ADDR)) out.push({ path: 'OPENBAO_ADDR', message: `OpenBao without TLS; use https://${hint('openbao')}` });
  return out;
}

/**
 * Sprint 20 (B-1205): in production the key-encryption key never comes from the environment, where every child
 * process and crash dump sees it: DATA_KEY_FILE (a Docker secret or systemd credential), or the signer.
 */
function inlineKeyProblems(env: NodeJS.ProcessEnv): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const out: string[] = [];
  for (const name of ['DATA_KEY', 'DATA_KEY_PREVIOUS', 'SIGNER_TOKEN'] as const) {
    if (env[name] && !env[`${name}_FILE`]) out.push(`  ${name}: production refuses ${name} given inline in the environment; use ${name}_FILE${name === 'DATA_KEY' ? ' (or the signer, SIGNER_SOCKET)' : ''}`);
  }
  return out;
}

const CONFIG_ENV = Symbol.for('exprsn.config.env');

/**
 * B-4205: the configuration the environment gives with `overrides` (database overrides, as strings) on top, checked
 * by the same schema and cross-field rules as at start. Errors are the schema's messages, one per problem.
 */
export function parseConfigWith(env: NodeJS.ProcessEnv, overrides: Record<string, string>): { ok: true; config: Config } | { ok: false; errors: string[] } {
  const merged = { ...readEnv(env), ...overrides };
  const parsed = schema.safeParse(merged);
  if (parsed.success) return { ok: true, config: parsed.data };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(readEnv(env));
  const inline = inlineKeyProblems(env);
  if (!parsed.success || inline.length) {
    const lines = [...inline, ...(parsed.success ? [] : parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`))];
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  // B-4205: the environment the configuration came from, for the Configuration screen's sources and overrides.
  Object.defineProperty(parsed.data, CONFIG_ENV, { value: env, enumerable: false });
  return parsed.data;
}

/** The environment a configuration was loaded from (process.env when it was not loaded by loadConfig). */
export const envOf = (c: Config): NodeJS.ProcessEnv => ((c as unknown as Record<symbol, NodeJS.ProcessEnv>)[CONFIG_ENV] ?? process.env);
