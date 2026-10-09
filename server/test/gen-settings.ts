/*
 * B-4205: the settings descriptor (`server/src/config/settings.generated.ts`) is generated from
 * `server/src/config/index.ts`: every variable of the environment schema with its section, type and constraints,
 * default, whether it is a secret, whether a change applies hot or at the next restart, whether the Configuration
 * screen may override it, and the description from the comment above it. The suite fails when the file differs from
 * what the configuration says (settings.test.ts). Regenerate it with:
 *
 *   npm run gen:settings -w server
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FIELDS, FILE_VARS } from '../src/config/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_SOURCE = path.resolve(here, '../src/config/index.ts');
export const SETTINGS_FILE = path.resolve(here, '../src/config/settings.generated.ts');
/** The variables table in docs/deploy.md describes the settings whose source line has no comment above it. */
const DEPLOY_DOC = path.resolve(here, '../../docs/deploy.md');
/** Defaults computed from where the checkout is (WEB_ROOT) are written relative to it, so the file is the same everywhere. */
const REPO_ROOT = path.resolve(here, '../..');

/** Secrets: the `<NAME>_FILE` variables, and two that carry credentials without a file form. */
const SECRETS = new Set<string>([...FILE_VARS, 'S3_ACCESS_KEY_ID', 'OTEL_EXPORTER_OTLP_HEADERS']);

/**
 * Settings read through the live configuration object each time they are used (checked by reading their callers),
 * so an approved override applies without a restart. Everything else is read once at start, into a constructor, a
 * schedule or a listener, and applies at the next restart. LOG_LEVEL is applied to the logger when it changes.
 */
const HOT = new Set<string>([
  'LOG_LEVEL',
  'ZONES_AIR_GAPPED', 'ZONES_CORPORATE_CIDRS', 'ZONE_HEALTH_TIMEOUT_MS', 'ZONE_HEALTH_FAILURES',
  'PLATFORM_BUNDLE_MAX_BYTES', 'PLATFORM_KEY_ROTATION_DAYS', 'PLATFORM_BACKUP_RETAIN', 'PLATFORM_DRILL_DIR', 'PLATFORM_BUNDLE_REQUIRE_CHECKS', 'PLATFORM_BACKUP_BLOBS',
  'ACME_CONTACT', 'ACME_RENEW_DAYS', 'ACME_DNS_WAIT_SECONDS', 'ACME_CERT_DIR', 'ACME_RELOAD_COMMANDS', 'ACME_HOOK_TIMEOUT_MS',
  'OIDC_KEY_ROTATION_DAYS', 'OIDC_KEY_OVERLAP_DAYS', 'SAML_ASSERTION_MINUTES', 'FEDERATION_ALLOWED_HOSTS', 'DPOP_PROOF_MAX_AGE_SECONDS', 'DPOP_NONCE_SECONDS',
  'PASSWORD_RESET_MINUTES', 'PASSWORD_RESET_PER_HOUR', 'PASSWORD_INVITE_HOURS', 'SIGNIN_NOTICES', 'EMAIL_VERIFY_HOURS', 'SIGNUP_PER_HOUR', 'USER_IMPORT_MAX_ROWS', 'MFA_EMAIL_CODE_MINUTES',
  'MEDIA_URL_TTL_SECONDS',
  'TRAINER_PLAINTEXT_FALLBACK', 'TRAINER_KEY_TTL_SECONDS', 'TRAINER_CLIENT_CERT_SHA256', 'TRAINER_ARTIFACT_MAX_BYTES',
  'STRIPE_WEBHOOK_TOLERANCE_SECONDS',
  'PLUGIN_CONCURRENCY', 'PLUGIN_MAX_DEPTH', 'PLUGIN_SCRIPT_TIMEOUT_SECONDS', 'PLUGIN_SCRIPT_MEMORY_MB', 'PLUGIN_MAX_CALLS', 'PLUGINS_REQUIRE_SIGNED',
  'HTTP_SIGNATURE_MAX_AGE_SECONDS', 'ATPROTO_SUBSCRIBERS_MAX', 'MODERATION_EXTERNAL_PROVIDERS',
  'PDS_ZONE', 'PDS_BACKFILL_HOURS', 'PDS_SUBSCRIBERS_MAX', 'PDS_IMPORT_MAX_BYTES',
  'APPS_HELD_MAX_PER_FORM', 'VAULT_ANOMALY_BURST', 'VAULT_ANOMALY_BURST_SECONDS', 'VAULT_ANOMALY_HISTORY_DAYS', 'VAULT_ANOMALY_MIN_HISTORY', 'VAULT_SHARE_MAX_DAYS', 'DLP_MAX_TEXT_BYTES', 'COMPLIANCE_EXPORT_MAX_ROWS', 'COMPLIANCE_EXPORT_MAX_DAYS',
  'IDENTITY_SCIM_MAX_RESULTS', 'IDENTITY_SCIM_TOKEN_MAX_DAYS',
  'APP_EMBED_MAX_TTL_SECONDS', 'APP_EMBED_SESSION_PER_MINUTE',
  'WORKFLOW_EVENT_MAX_DEPTH',
  'CHANNELS_SESSION_HOURS', 'CHANNELS_REPLY_TIMEOUT_MS', 'CHANNELS_IMAP_BATCH', 'CHANNELS_WEBHOOK_PER_MINUTE', 'CHANNELS_WEBHOOK_TOLERANCE_SECONDS',
  'FEED_TRENDING_HOURS', 'FEED_DIGEST_PROFILE',
  'IMPORT_PART_BYTES', 'IMPORT_HARVEST_MAX_ITEMS', 'IMPORT_BACKOFF_MAX_MINUTES', 'IMPORT_DATASET_QUOTA_GB',
  'BLOBS_ORPHAN_GRACE_HOURS', 'BLOBS_DRY_RUN_MINUTES'
]);

/** Never overridden from the database: what is needed to reach the database, and the switch itself. */
const FIXED: Record<string, string> = {
  NODE_ENV: 'Read before anything else; set it in the environment.',
  DB_CLIENT: 'Needed to reach the database the overrides live in.',
  DATABASE_URL: 'Needed to reach the database the overrides live in.',
  SQLITE_FILENAME: 'Needed to reach the database the overrides live in.',
  DB_POOL_MAX: 'Needed to reach the database the overrides live in.',
  DB_MIGRATE_ON_START: 'Read before the overrides are loaded.',
  PLATFORM_SETTINGS_OVERRIDES: 'The switch for overrides is set in the environment only.',
  INSTANCE_NAME: 'Names one instance; set it in that instance\'s environment.'
};

/** Sections, in the order of docs/deploy.md; the first matching rule wins. */
const SECTIONS: [string, RegExp][] = [
  ['Database', /^(DB_|DATABASE_URL|SQLITE_)/],
  ['Keys and KMS', /^(DATA_KEY|KMS_|OPENBAO_|SIGNER_)/],
  ['Blob store and files', /^(BLOB_STORE|BLOB_DIR|BLOBS_|S3_|FILES_|ATTACHMENT_|CLAMD_)/],
  ['Jobs and cache', /^(REDIS_URL|JOB_|WORKERS_|CACHE_)/],
  ['Federation', /^(FEDERATION_|OIDC_|DPOP_|DEVICE_|KERBEROS_|SAML_|API_PUBLIC_URL)/],
  ['Identity and sessions', /^(SESSION_IDLE|SESSION_ABSOLUTE|LOCKOUT_|MFA_|BREACHED_|STEPUP_|PASSWORD_|SIGNIN_|SIGNUP_|EMAIL_VERIFY|INVITATION_|USER_IMPORT_|DIRECTORY_|AUDIT_|DEFAULT_TENANT|IDENTITY_|SECRET_REF_|WEBAUTHN_)/],
  ['Gateway and Ollama', /^(OLLAMA_|CHAT_STREAM|SHARE_|OPENAI_|HTTP_SIGNATURE_)/],
  ['Guardrails and moderation', /^(CHAT_GUARD|CHAT_RETENTION|MODERATION_)/],
  ['Knowledge and connections', /^(KNOWLEDGE_|CONNECTIONS_|MCP_)/],
  ['Agents, workflows and scripts', /^(SCRIPT_|WORKFLOW_|CHAIN_|AGENT_)/],
  ['Media and images', /^(MEDIA_|IMAGE_)/],
  ['Training', /^(TRAINER_|TRAINING_)/],
  ['Zones', /^ZONE/],
  ['PKI and ACME', /^(ACME_|PKI_)/],
  ['Vault', /^VAULT_/],
  ['Channels and email', /^(SMTP_|CHANNELS_)/],
  ['Social and messaging', /^(MESSAGING_|FEED_|GROUP_|CALENDAR_|ROOM_)/],
  ['Apps and plugins', /^(APPS_|PLUGIN|WEBHOOK_)/],
  ['AT-Protocol', /^(ATPROTO_|FIREHOSE_|FEEDS_|PDS_)/],
  ['Observability', /^(OTEL_|METRICS_|SIEM_|SCHEMA_CHECK|RATELIMIT_)/],
  ['Billing', /^(BILLING_|STRIPE_)/],
  ['Platform operations', /^(PLATFORM_|NTP_|SERVICE_|REQUIRE_BACKEND_TLS|BACKEND_TLS_|IMPORT_|INSTANCE_NAME)/]
];
export const SECTION_ORDER = ['Server and HTTP', ...SECTIONS.map(([s]) => s)];
const sectionOf = (name: string) => SECTIONS.find(([, re]) => re.test(name))?.[0] ?? 'Server and HTTP';

type Def = { type: string; innerType?: Schema; defaultValue?: unknown; in?: Schema; out?: Schema; options?: string[]; entries?: Record<string, string>; format?: string };
type Schema = { def: Def; minValue?: number | null; maxValue?: number | null; isInt?: boolean; minLength?: number | null; maxLength?: number | null; format?: string | null };

const unit = (name: string) => (/_MS$/.test(name) ? 'ms' : /_SECONDS$|_S$/.test(name) ? 'seconds' : /_MINUTES$/.test(name) ? 'minutes' : /_HOURS$/.test(name) ? 'hours' : /_DAYS$/.test(name) ? 'days' : '');
const text = (v: unknown): string | null => (v === undefined || v === null ? null : Array.isArray(v) ? v.join(',') : String(v));
const n = (x: number) => (Math.abs(x) >= 10_000 ? x.toLocaleString('en-US') : String(x));

/** Type, constraint and default from the zod field. */
function shape(name: string, field: Schema): { type: string; constraint: string; def: string | null; options?: string[] } {
  let s = field;
  let def: string | null = null;
  for (let i = 0; i < 6; i++) {
    const d = s.def;
    if (d.type === 'default') {
      def = text(typeof d.defaultValue === 'function' ? (d.defaultValue as () => unknown)() : d.defaultValue);
      if (def && def.startsWith(REPO_ROOT + path.sep)) def = path.relative(REPO_ROOT, def).split(path.sep).join('/');
      s = d.innerType!;
    } else if (d.type === 'optional') s = d.innerType!;
    else break;
  }
  if (s.def.type === 'pipe') {
    const inner = s.def.in!;
    const enumIn = inner.def.type === 'enum' ? inner : null;
    if (enumIn && (enumIn.def.entries ? Object.values(enumIn.def.entries) : enumIn.def.options ?? []).includes('true')) return { type: 'boolean', constraint: 'true or false', def };
    // A comma list turned into an array.
    let x = inner;
    while (x.def.type === 'default' || x.def.type === 'pipe') {
      if (x.def.type === 'default') def = def ?? text(x.def.defaultValue);
      x = x.def.type === 'default' ? x.def.innerType! : x.def.in!;
    }
    return { type: 'list', constraint: 'comma separated', def };
  }
  if (s.def.type === 'number') {
    const u = unit(name);
    const range = s.minValue != null && s.maxValue != null ? `${n(s.minValue)} to ${n(s.maxValue)}` : s.minValue != null ? `at least ${n(s.minValue)}` : '';
    return { type: s.isInt === false ? 'number' : u ? 'duration' : 'integer', constraint: [range, u].filter(Boolean).join(' '), def };
  }
  if (s.def.type === 'enum') {
    const options = s.def.entries ? Object.values(s.def.entries) : s.def.options ?? [];
    return { type: 'enum', constraint: options.join(', '), def, options };
  }
  if (s.def.type === 'boolean') return { type: 'boolean', constraint: 'true or false', def };
  const fmt = s.format ?? s.def.format ?? null;
  if (fmt === 'url') return { type: 'url', constraint: 'a URL', def };
  if (fmt === 'email') return { type: 'email', constraint: 'an email address', def };
  const len = s.minLength != null ? `at least ${s.minLength} characters` : '';
  return { type: 'string', constraint: len, def };
}

/** The comment that describes each variable: the JSDoc above it, shared by the keys that follow without a gap. */
function descriptions(source: string): Map<string, string> {
  const start = source.indexOf('const base = z.object({');
  const end = source.indexOf('/** B-4205: the fields of the environment schema');
  const lines = source.slice(start, end).split('\n');
  const out = new Map<string, string>();
  let pending = '';
  let inDoc = false;
  let doc: string[] = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (inDoc) {
      if (l.endsWith('*/')) {
        doc.push(l.replace(/\*\/$/, '').replace(/^\*\s?/, ''));
        pending = doc.join(' ').replace(/\s+/g, ' ').trim();
        inDoc = false;
      } else doc.push(l.replace(/^\*\s?/, ''));
      continue;
    }
    if (l.startsWith('/**')) {
      if (l.endsWith('*/')) pending = l.slice(3, -2).trim();
      else {
        inDoc = true;
        doc = [l.slice(3)];
      }
      continue;
    }
    if (l === '' || l.startsWith('// ---')) {
      pending = '';
      continue;
    }
    const m = /^([A-Z][A-Z0-9_]+):/.exec(l);
    if (m) out.set(m[1]!, pending);
  }
  return out;
}

export interface GeneratedSetting {
  name: string;
  section: string;
  type: string;
  constraint: string;
  default: string | null;
  options?: string[];
  secret: boolean;
  file: boolean;
  applies: 'hot' | 'restart';
  overridable: boolean;
  fixedReason?: string;
  description: string;
}

/** `| \`NAME\` | default | description |` rows of docs/deploy.md. */
function deployDocs(): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of readFileSync(DEPLOY_DOC, 'utf8').matchAll(/^\| `([A-Z][A-Z0-9_]+)` \|[^|]*\| (.+?) \|\s*$/gm)) if (!out.has(m[1]!)) out.set(m[1]!, m[2]!.replace(/`/g, '').trim());
  return out;
}

/** The few settings neither the source nor docs/deploy.md describes on their own line. */
const BASICS: Record<string, string> = {
  HOST: 'The address the HTTP server listens on.',
  PORT: 'The port the HTTP server listens on.',
  DATABASE_URL: 'Where the application database is (PostgreSQL or MySQL). The password inside it is why the whole value is a secret.',
  DB_POOL_MAX: 'Connections each instance may hold open to the database.',
  DIRECTORY_SYNC_MINUTES: 'How often directory.sync pulls groups from every tenant\'s user stores (0 turns it off).',
  AUDIT_CHECKPOINT_MINUTES: 'How often each tenant\'s audit chain is checkpointed and signed (0 turns it off).',
  COOKIE_SECURE: 'Mark cookies Secure behind a TLS proxy; derived from PUBLIC_URL when unset.',
  LOCKOUT_MAX_ATTEMPTS: 'Failed sign-ins in the window that lock an account.',
  LOCKOUT_WINDOW_MINUTES: 'The window failed sign-ins are counted in.',
  LOCKOUT_DURATION_MINUTES: 'How long a locked account stays locked.',
  WEBAUTHN_RP_ID: 'The WebAuthn relying party id (default the host of PUBLIC_URL).',
  WEBAUTHN_RP_NAME: 'The relying party name passkey prompts show.',
  WEB_ROOT: 'The directory the console is served from.',
  METRICS_TOKEN: 'The bearer token Prometheus presents at /metrics.'
};

/** "1.5.0, Sprint 31 (B-2901 to B-2906): the PDS…" reads "The PDS…" on the screen. */
const clean = (d: string) => {
  const t = d.replace(/^(\d+\.\d+\.\d+, )?(Sprint \w+( \([^)]*\))?|B-\d+( to B-\d+)?)(, [^:]{0,40})?: /, '').trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
};

export function generatedSettings(): GeneratedSetting[] {
  const docs = descriptions(readFileSync(CONFIG_SOURCE, 'utf8'));
  const deploy = deployDocs();
  const fileVars = new Set<string>(FILE_VARS);
  const out: GeneratedSetting[] = [];
  for (const [name, field] of Object.entries(CONFIG_FIELDS)) {
    const sh = shape(name, field as unknown as Schema);
    const secret = SECRETS.has(name);
    const overridable = !secret && !FIXED[name];
    out.push({
      name,
      section: sectionOf(name),
      type: secret ? 'secret' : sh.type,
      constraint: sh.constraint,
      default: secret ? null : sh.def,
      ...(sh.options && !secret ? { options: sh.options } : {}),
      secret,
      file: fileVars.has(name),
      applies: HOT.has(name) ? 'hot' : 'restart',
      overridable,
      ...(secret ? { fixedReason: 'A secret: rotate it where it is stored and restart.' } : FIXED[name] ? { fixedReason: FIXED[name] } : {}),
      description: clean(docs.get(name) || deploy.get(name) || BASICS[name] || '')
    });
  }
  return out;
}

export function settingsSource(): string {
  const list = generatedSettings();
  const missing = [...HOT].filter((h) => !list.some((s) => s.name === h));
  if (missing.length) throw new Error(`HOT names settings the configuration does not have: ${missing.join(', ')}`);
  return [
    '// Generated by server/test/gen-settings.ts from server/src/config/index.ts (B-4205). Do not edit; run',
    '// `npm run gen:settings -w server` after changing the configuration.',
    '',
    'export interface SettingDescriptor {',
    '  name: string;',
    '  section: string;',
    '  type: string;',
    '  constraint: string;',
    '  default: string | null;',
    '  options?: string[];',
    '  secret: boolean;',
    '  /** May be given as `<NAME>_FILE`. */',
    '  file: boolean;',
    '  applies: \'hot\' | \'restart\';',
    '  overridable: boolean;',
    '  fixedReason?: string;',
    '  description: string;',
    '}',
    '',
    `export const SETTING_SECTIONS: readonly string[] = ${JSON.stringify(SECTION_ORDER)};`,
    '',
    'export const SETTINGS: readonly SettingDescriptor[] = [',
    ...list.map((s, i) => `  ${JSON.stringify(s)}${i < list.length - 1 ? ',' : ''}`),
    '];',
    ''
  ].join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) && process.argv.includes('--write')) {
  writeFileSync(SETTINGS_FILE, settingsSource());
  process.stdout.write(`wrote ${path.relative(process.cwd(), SETTINGS_FILE)}\n`);
}
