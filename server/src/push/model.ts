import { z } from 'zod';
import { parseAllowList, type AllowList } from '../mcp/hosts.js';
import { SECRET_FIELD, SECRET_HEADER } from '../platform/secret-names.js';
import { isPublicAddress, toolAddressProblem, type ServicePolicy } from '../platform/egress.js';
import { isSecretRef } from '../vault/policy.js';

/*
 * 1.9.0 (B-151): push providers as configuration. A provider row is either a platform default (scope `platform`, no
 * tenant, managed with `platform:manage`) or a tenant's override (scope `tenant`, managed with `tenant:manage`). For
 * one delivery the tenant's enabled provider of the device's kind (and app id, when it names one) wins over the
 * platform's.
 *
 * Every credential is a `vault:` reference (fields ending in `Ref`, an HTTP vendor's secret-named headers); a literal
 * is refused when the provider is saved. Tenant references resolve as the admin who saved the provider
 * (`VaultService.resolveFor`, so a revoked grant or a disabled admin stops them); platform references live in the
 * vault's platform scope under `sys/kv/push/...` and resolve as the internal service `push`.
 */

export const PUSH_KINDS = ['apns', 'fcm', 'webpush', 'http', 'websocket'] as const;
export type PushKind = (typeof PUSH_KINDS)[number];
export const PUSH_SCOPES = ['platform', 'tenant'] as const;
export type PushScope = (typeof PUSH_SCOPES)[number];

/** The vault service subject platform providers read their references as. */
export const PUSH_SERVICE = 'push';
/** The platform-scope KV prefix platform providers' references must sit under. */
export const PLATFORM_REF_PREFIX = 'push/';

const ref = z.string().trim().min(8).max(400).refine(isSecretRef, 'A vault reference: vault:<path>#<key>.');

/** Status codes as a list, or ranges written `500-599`. */
const codes = z.array(z.union([z.number().int().min(100).max(599), z.string().regex(/^[1-5]\d\d-[1-5]\d\d$/)])).max(40);
export type Codes = z.infer<typeof codes>;
export const codeMatches = (list: Codes, status: number): boolean => list.some((c) => (typeof c === 'number' ? c === status : (([a, b]) => status >= Number(a) && status <= Number(b))(c.split('-'))));

const authSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).strict(),
  z.object({ type: z.literal('bearer'), tokenRef: ref }).strict(),
  z.object({ type: z.literal('header'), header: z.string().regex(/^[A-Za-z0-9-]{1,100}$/), valueRef: ref }).strict(),
  z.object({ type: z.literal('basic'), username: z.string().trim().max(200).optional(), usernameRef: ref.optional(), passwordRef: ref }).strict()
]);
export type PushAuth = z.infer<typeof authSchema>;

/** What an answer means: status codes and, optionally, a JSON pointer whose value is one of the listed strings. */
const outcomeRule = z
  .object({
    status: codes.default([]),
    pointer: z.string().max(300).regex(/^(\/.*)?$/, 'A JSON pointer starts with /').optional(),
    equals: z.array(z.string().max(200)).max(20).optional()
  })
  .strict();
export type OutcomeRule = z.infer<typeof outcomeRule>;

export const responseMappingSchema = z
  .object({
    success: outcomeRule.default({ status: ['200-299'] }),
    retry: outcomeRule.default({ status: [429, '500-599'] }),
    gone: outcomeRule.default({ status: [404, 410] })
  })
  .strict();
export type ResponseMapping = z.infer<typeof responseMappingSchema>;
const DEFAULT_MAPPING: ResponseMapping = { success: { status: ['200-299'] }, retry: { status: [429, '500-599'] }, gone: { status: [404, 410] } };

/** Placeholders a body template may use; each becomes a JSON value (a string, a number, an object or null). */
export const TEMPLATE_FIELDS = ['title', 'body', 'data', 'token', 'collapseId', 'ttl', 'priority', 'route', 'kind', 'link'] as const;

const contentLabel = z.enum(['public', 'internal']).default('public');

export const apnsConfig = z
  .object({
    auth: z.enum(['token', 'certificate']).default('token'),
    keyRef: ref.optional(),
    keyId: z.string().regex(/^[A-Z0-9]{10}$/, 'The key id is the 10 characters Apple shows.').optional(),
    teamId: z.string().regex(/^[A-Z0-9]{10}$/, 'The team id is the 10 characters Apple shows.').optional(),
    certificateRef: ref.optional(),
    certificateKeyRef: ref.optional(),
    topic: z.string().trim().regex(/^[A-Za-z0-9.-]{1,155}$/, 'The topic is the app bundle id.'),
    environment: z.enum(['production', 'sandbox']).default('production'),
    contentLabel
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.auth === 'token' && (!c.keyRef || !c.keyId || !c.teamId)) ctx.addIssue({ code: 'custom', message: 'Token auth needs keyRef (the .p8 key in the vault), keyId and teamId.' });
    if (c.auth === 'certificate' && (!c.certificateRef || !c.certificateKeyRef)) ctx.addIssue({ code: 'custom', message: 'Certificate auth needs certificateRef and certificateKeyRef (PEM, in the vault).' });
  });

export const fcmConfig = z
  .object({
    serviceAccountRef: ref,
    projectId: z.string().trim().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/, 'A Firebase project id.').optional(),
    contentLabel
  })
  .strict();

export const webpushConfig = z
  .object({
    publicKey: z.string().trim().regex(/^[A-Za-z0-9_-]{86,88}$/, 'The VAPID public key: 65 bytes as base64url.'),
    privateKeyRef: ref,
    subject: z.string().trim().max(300).regex(/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/, 'A mailto: address or an https:// URL the push service can reach you at.'),
    contentLabel
  })
  .strict();

export const httpConfig = z
  .object({
    url: z.string().trim().url().max(2000).regex(/^https?:\/\//),
    method: z.enum(['POST', 'PUT']).default('POST'),
    auth: authSchema.default({ type: 'none' }),
    headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,100}$/), z.string().max(2000)).default({}),
    body: z.string().min(2).max(20_000),
    contentType: z.string().trim().max(100).default('application/json'),
    response: responseMappingSchema.default(DEFAULT_MAPPING),
    timeoutMs: z.number().int().min(500).max(60_000).default(10_000),
    contentLabel
  })
  .strict();

export const websocketConfig = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('socketio'), ackTimeoutMs: z.number().int().min(500).max(60_000).default(5000), contentLabel }).strict(),
  z
    .object({
      mode: z.literal('external'),
      url: z.string().trim().url().max(2000).regex(/^wss?:\/\//),
      auth: authSchema.default({ type: 'none' }),
      headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,100}$/), z.string().max(2000)).default({}),
      body: z.string().min(2).max(20_000),
      /** A reply's JSON mapped as HTTP answers are (`status` codes compare with the reply's `/status`, when it has one). */
      response: responseMappingSchema.default({ success: { status: [], pointer: '/ok', equals: ['true'] }, retry: { status: [] }, gone: { status: [] } }),
      timeoutMs: z.number().int().min(500).max(60_000).default(10_000),
      contentLabel
    })
    .strict()
]);

export const CONFIG_SCHEMAS = { apns: apnsConfig, fcm: fcmConfig, webpush: webpushConfig, http: httpConfig, websocket: websocketConfig } as const;
export type ApnsConfig = z.infer<typeof apnsConfig>;
export type FcmConfig = z.infer<typeof fcmConfig>;
export type WebPushConfig = z.infer<typeof webpushConfig>;
export type HttpConfig = z.infer<typeof httpConfig>;
export type WebSocketConfig = z.infer<typeof websocketConfig>;
export type ProviderConfig = ApnsConfig | FcmConfig | WebPushConfig | HttpConfig | WebSocketConfig;

export interface ProviderRow {
  id: string;
  scope: PushScope;
  tenant_id: string | null;
  kind: PushKind;
  name: string;
  /** The app the provider serves (APNs topic, FCM project, or a vendor's app id); devices name it. */
  app_id: string | null;
  enabled: boolean | number;
  config: string;
  owner_id: string | null;
  last_check_at: number | null;
  last_check_ok: boolean | number | null;
  last_check_detail: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

/** Parses a saved or submitted config for its kind; throws a plain message. */
export function parseConfig(kind: PushKind, raw: unknown): ProviderConfig {
  const r = CONFIG_SCHEMAS[kind].safeParse(raw);
  if (!r.success) throw new Error(r.error.issues.slice(0, 4).map((i) => `${i.path.join('.') || 'config'}: ${i.message}`).join('; '));
  return r.data;
}

const PLACEHOLDER = /\{([A-Za-z_][\w-]{0,62})\}/g;

/** Every vault reference in a config. */
export function configRefs(c: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (v: unknown, key: string) => {
    if (typeof v === 'string' && /Ref$/.test(key)) out.push(v);
    else if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k);
  };
  walk(c, '');
  for (const v of Object.values((c.headers ?? {}) as Record<string, string>)) {
    const m = /^((?:Bearer|Basic|Token) )?(vault:\S+)$/.exec(v);
    if (m) out.push(m[2]!);
  }
  return [...new Set(out)];
}

/**
 * What else is wrong with a config: a literal credential in a header or the body, placeholders a template may not
 * use, credentials in a URL, a platform reference outside `push/`.
 */
export function configProblems(kind: PushKind, c: ProviderConfig, scope: PushScope): string[] {
  const out: string[] = [];
  const x = c as Record<string, unknown>;
  const url = typeof x.url === 'string' ? x.url : null;
  if (url) {
    try {
      const u = new URL(url);
      if (u.username || u.password) out.push('Credentials do not belong in the URL; use the auth settings with a vault reference.');
      for (const [k, v] of u.searchParams) if (SECRET_FIELD.test(k) && !/^\{[\w-]+\}$/.test(v)) out.push(`The query parameter ${k} carries a credential; send it with the auth settings as a vault reference.`);
    } catch {
      out.push('The URL is not a URL.');
    }
  }
  for (const [k, v] of Object.entries((x.headers ?? {}) as Record<string, string>)) {
    if (/^(host|content-length|transfer-encoding|connection|upgrade|te|trailer|authorization)$/i.test(k)) out.push(`The header ${k} is set by the transport or the auth settings.`);
    else if (SECRET_HEADER.test(k) && !/^((?:Bearer|Basic|Token) )?vault:\S+$/.test(v)) out.push(`The header ${k} carries a credential: use a vault reference, never a literal.`);
  }
  if (typeof x.body === 'string') {
    const unknown = [...new Set([...x.body.matchAll(PLACEHOLDER)].map((m) => m[1]!).filter((n) => !(TEMPLATE_FIELDS as readonly string[]).includes(n)))];
    if (unknown.length) out.push(`${unknown.map((n) => `{${n}}`).join(', ')}: a body template may use ${TEMPLATE_FIELDS.map((f) => `{${f}}`).join(', ')}.`);
    for (const m of x.body.matchAll(/"([^"\\]{1,100})"\s*:\s*"([^"\\]*)"/g)) if (SECRET_FIELD.test(m[1]!) && m[2]!.length) out.push(`The body field ${m[1]} carries a credential literal; vendors' keys go in the auth settings.`);
  }
  if (scope === 'platform') for (const r of configRefs(x)) if (!r.startsWith(`vault:${PLATFORM_REF_PREFIX}`)) out.push(`${r.slice(0, 120)}: a platform provider reads the vault's platform scope, under vault:${PLATFORM_REF_PREFIX}…`);
  return [...new Set(out)];
}

/** The app id a provider serves, from its config (APNs topic, FCM project). */
export function appIdOf(kind: PushKind, c: ProviderConfig): string | null {
  if (kind === 'apns') return (c as ApnsConfig).topic;
  if (kind === 'fcm') return (c as FcmConfig).projectId ?? null;
  return null;
}

// ---------- hosts ----------

/** The hosts each built-in kind talks to (public, and named by the kind itself, so no allow-list entry is needed). */
export const BUILTIN_HOSTS: Record<'apns' | 'fcm' | 'webpush', string> = {
  apns: 'api.push.apple.com,api.sandbox.push.apple.com',
  fcm: 'fcm.googleapis.com,oauth2.googleapis.com',
  // The browsers' push services (Chrome and Edge through FCM, Firefox, Safari, Windows).
  webpush: 'fcm.googleapis.com,*.push.services.mozilla.com,updates.push.services.mozilla.com,web.push.apple.com,*.push.apple.com,*.notify.windows.com'
};

const builtinLists = new Map<string, AllowList>();
const builtinList = (kind: PushKind): AllowList | null => {
  if (kind === 'http' || kind === 'websocket') return null;
  let l = builtinLists.get(kind);
  if (!l) builtinLists.set(kind, (l = parseAllowList(BUILTIN_HOSTS[kind])));
  return l;
};

const named = (h: string, l: AllowList) => l.hosts.some((x) => (x.startsWith('*.') ? h.endsWith(x.slice(1)) : h === x));

/**
 * Why a push call may not reach this address, or null. Cloud metadata, unspecified, multicast and broadcast addresses
 * never; internal addresses only when the operator names them in SERVICE_ALLOWED_HOSTS; public addresses when the
 * kind names the host (APNs, FCM, the browsers' push services), or when the allowed hosts name it: the tenant's list
 * for a tenant provider, SERVICE_ALLOWED_HOSTS for a platform provider.
 */
export function pushAddressProblem(ip: string, h: string, kind: PushKind, policy: ServicePolicy, allowed: AllowList | null): string | null {
  const p = toolAddressProblem(ip, h, policy, allowed);
  if (!p) return null;
  const builtin = builtinList(kind);
  if (builtin && isPublicAddress(ip) && named(h, builtin)) return null;
  return p.replace('HTTP tools reach', 'Push providers reach').replace("A tenant admin adds it under Registry, Allowed hosts.", 'A tenant admin adds it under Registry, Allowed hosts (a platform provider: SERVICE_ALLOWED_HOSTS).');
}

// ---------- what a delivery carries ----------

export type Priority = 'high' | 'normal' | 'low';

/** One message for one device, as the senders see it. Never logged. */
export interface PushMessage {
  title: string;
  body: string | null;
  route: string | null;
  link: string;
  kind: string;
  data: Record<string, string>;
  collapseId: string | null;
  ttlSeconds: number;
  priority: Priority;
}

/** What a provider made of one send. */
export interface SendResult {
  outcome: 'sent' | 'retry' | 'gone' | 'failed';
  status: number | null;
  /** A short machine reason (APNs reason, FCM error status, "timeout"); never the token or the payload. */
  reason: string | null;
  retryAfterMs?: number | null;
}

/** RFC 9110 Retry-After: seconds or an HTTP date; null when absent or unreadable. Capped at a day. */
export function retryAfterMs(v: string | undefined | null, now = Date.now()): number | null {
  if (!v) return null;
  const s = v.trim();
  if (/^\d+$/.test(s)) return Math.min(Number(s) * 1000, 86_400_000);
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.min(Math.max(0, t - now), 86_400_000) : null;
}
