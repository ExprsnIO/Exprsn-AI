import { createPublicKey, verify, X509Certificate, type KeyObject } from 'node:crypto';
import { isIP } from 'node:net';
import WebSocket from 'ws';
import { lookup as dnsLookup } from 'node:dns';
import { guardedRequest, ServiceUrlRefused } from '../platform/egress.js';
import { jsonPointer } from '../registry/http-tool.js';
import type { H2Pool } from './h2-pool.js';
import { GOOGLE_TOKEN_URL, privateKeyFrom, serviceAccountAssertion, fromB64url, type ApnsTokens, type Clock, type OAuthTokens } from './jwt.js';
import { codeMatches, retryAfterMs, type ApnsConfig, type FcmConfig, type HttpConfig, type OutcomeRule, type PushAuth, type PushKind, type PushMessage, type ResponseMapping, type SendResult, type WebPushConfig, type WebSocketConfig } from './model.js';
import { encryptPayload, parseSubscription, vapidAuthorization, vapidPrivateKey } from './webpush.js';

/*
 * 1.9.0 (B-151, B-152): one sender per provider kind. A sender gets the provider's parsed config, a way to read its
 * vault references, the device's opened token and the message, and answers what happened (`SendResult`): sent, retry
 * (429 and 5xx, with Retry-After), gone (the provider says the token is dead) or failed. It never logs the token, the
 * payload or a credential; reasons are the provider's short codes.
 *
 * Every connection goes through the egress guard with `check` (pushAddressProblem for the provider's kind and scope):
 * APNs and FCM over the shared HTTP/2 sessions of `H2Pool`, the FCM token endpoint, Web Push and HTTP vendors through
 * `guardedRequest`, and external WebSockets with a lookup that dials only checked addresses.
 */

export interface SendContext {
  providerId: string;
  check: (address: string, host: string) => string | null;
  /** Reads one of the provider's vault references (cached by the caller). */
  secret: (ref: string) => Promise<string>;
}

export interface SenderDeps {
  pool: H2Pool;
  clock: Clock;
  apnsTokens: ApnsTokens;
  oauth: OAuthTokens;
  /** Tests only: the fake servers' origins and their certificate authority. */
  endpoints: { apns?: string; apnsSandbox?: string; fcm?: string; googleToken?: string };
  ca?: string;
  timeoutMs: number;
  maxResponseBytes: number;
}

const short = (s: unknown, n = 80): string | null => (typeof s === 'string' && s ? s.replace(/[^\w .:/-]/g, '').slice(0, n) : null);
const parseJson = (b: Buffer): unknown => {
  try {
    return JSON.parse(b.toString('utf8')) as unknown;
  } catch {
    return null;
  }
};

const refused = (err: unknown): SendResult => {
  const m = (err as Error).message;
  if (err instanceof ServiceUrlRefused) return /No answer within|No HTTP\/2 connection/.test(m) ? { outcome: 'retry', status: null, reason: 'timeout' } : /larger than/.test(m) ? { outcome: 'failed', status: null, reason: 'answer too large' } : { outcome: 'failed', status: null, reason: 'egress refused' };
  // A connection that failed or was reset: worth another try.
  return { outcome: 'retry', status: null, reason: short((err as { code?: string }).code) ?? 'connection failed' };
};

// ---------- APNs ----------

const APNS_PRIORITY = { high: '10', normal: '5', low: '1' } as const;

export class Senders {
  constructor(private readonly d: SenderDeps) {}

  private apnsOrigin(c: ApnsConfig): string {
    return c.environment === 'sandbox' ? (this.d.endpoints.apnsSandbox ?? 'https://api.sandbox.push.apple.com') : (this.d.endpoints.apns ?? 'https://api.push.apple.com');
  }

  private async apnsAuth(ctx: SendContext, c: ApnsConfig): Promise<{ headers: Record<string, string>; cert?: string; key?: string }> {
    if (c.auth === 'certificate') return { headers: {}, cert: await ctx.secret(c.certificateRef!), key: await ctx.secret(c.certificateKeyRef!) };
    const key = privateKeyFrom(await ctx.secret(c.keyRef!), 'ec');
    return { headers: { authorization: `bearer ${this.d.apnsTokens.token({ teamId: c.teamId!, keyId: c.keyId!, key })}` } };
  }

  async apns(ctx: SendContext, c: ApnsConfig, token: string, m: PushMessage): Promise<SendResult> {
    if (!/^[0-9a-fA-F]{32,200}$/.test(token)) return { outcome: 'gone', status: null, reason: 'BadDeviceToken' };
    const auth = await this.apnsAuth(ctx, c);
    const payload = JSON.stringify({ aps: { alert: { title: m.title, ...(m.body ? { body: m.body } : {}) }, sound: 'default', ...(m.priority === 'low' ? { 'content-available': 1 } : {}) }, kind: m.kind, ...(m.route ? { route: m.route } : {}), link: m.link, ...(Object.keys(m.data).length ? { data: m.data } : {}) });
    if (Buffer.byteLength(payload) > 4096) return { outcome: 'failed', status: null, reason: 'PayloadTooLarge' };
    const now = this.d.clock();
    const headers: Record<string, string> = {
      ...auth.headers,
      'apns-topic': c.topic,
      'apns-push-type': m.priority === 'low' ? 'background' : 'alert',
      'apns-priority': APNS_PRIORITY[m.priority],
      'apns-expiration': m.ttlSeconds > 0 ? String(Math.floor(now / 1000) + m.ttlSeconds) : '0',
      'content-type': 'application/json',
      ...(m.collapseId ? { 'apns-collapse-id': m.collapseId.slice(0, 64) } : {})
    };
    let res;
    try {
      res = await this.d.pool.request({ providerId: ctx.providerId, origin: this.apnsOrigin(c), check: ctx.check, ...(this.d.ca ? { ca: this.d.ca } : {}), ...(auth.cert ? { cert: auth.cert, key: auth.key! } : {}) }, { method: 'POST', path: `/3/device/${token.toLowerCase()}`, headers, body: payload, timeoutMs: this.d.timeoutMs, maxBytes: this.d.maxResponseBytes });
    } catch (err) {
      return refused(err);
    }
    const reason = short((parseJson(res.body) as { reason?: unknown } | null)?.reason);
    if (res.status === 200) return { outcome: 'sent', status: 200, reason: null };
    if (res.status === 410 || (res.status === 400 && reason === 'BadDeviceToken')) return { outcome: 'gone', status: res.status, reason: reason ?? 'Unregistered' };
    if (res.status === 403 && reason === 'ExpiredProviderToken' && c.auth === 'token') {
      this.d.apnsTokens.drop(c.teamId!, c.keyId!);
      return { outcome: 'retry', status: 403, reason, retryAfterMs: 0 };
    }
    if (res.status === 429 || res.status >= 500) return { outcome: 'retry', status: res.status, reason, retryAfterMs: retryAfterMs(res.headers['retry-after'], now) };
    return { outcome: 'failed', status: res.status, reason };
  }

  /** Validates APNs credentials without sending: the token is minted and its signature verified, or the certificate read. */
  async checkApns(ctx: SendContext, c: ApnsConfig): Promise<string> {
    if (c.auth === 'certificate') {
      const pem = await ctx.secret(c.certificateRef!);
      const keyPem = await ctx.secret(c.certificateKeyRef!);
      let cert: X509Certificate;
      try {
        cert = new X509Certificate(pem);
      } catch {
        throw new Error('The APNs certificate is not a PEM certificate.');
      }
      let key: KeyObject;
      try {
        key = privateKeyFrom(keyPem, cert.publicKey.asymmetricKeyType === 'rsa' ? 'rsa' : 'ec');
      } catch (err) {
        throw new Error(`The certificate's key: ${(err as Error).message}`, { cause: err });
      }
      if (!cert.checkPrivateKey(key)) throw new Error('The private key does not belong to the certificate.');
      const until = Date.parse(cert.validTo);
      if (until < this.d.clock()) throw new Error(`The certificate expired on ${cert.validTo}.`);
      return `Certificate read; valid until ${new Date(until).toISOString().slice(0, 10)}. Topic ${c.topic}, ${c.environment}.`;
    }
    const key = privateKeyFrom(await ctx.secret(c.keyRef!), 'ec');
    this.d.apnsTokens.drop(c.teamId!, c.keyId!);
    const jwt = this.d.apnsTokens.token({ teamId: c.teamId!, keyId: c.keyId!, key });
    const [h, p, s] = jwt.split('.');
    if (!verify('sha256', Buffer.from(`${h}.${p}`), { key: createPublicKey(key), dsaEncoding: 'ieee-p1363' }, fromB64url(s!))) throw new Error('The minted token does not verify.');
    return `ES256 provider token minted for key ${c.keyId}, team ${c.teamId}. Topic ${c.topic}, ${c.environment}.`;
  }

  // ---------- FCM ----------

  private async serviceAccount(ctx: SendContext, c: FcmConfig): Promise<{ clientEmail: string; key: KeyObject; keyId: string | null; projectId: string }> {
    const raw = await ctx.secret(c.serviceAccountRef);
    let sa: { type?: unknown; client_email?: unknown; private_key?: unknown; private_key_id?: unknown; project_id?: unknown };
    try {
      sa = JSON.parse(raw) as typeof sa;
    } catch {
      throw new Error('The service account is not JSON (paste the whole key file into the vault).');
    }
    if (sa.type !== 'service_account' || typeof sa.client_email !== 'string' || typeof sa.private_key !== 'string') throw new Error('The JSON is not a Google service account key (type, client_email, private_key).');
    const projectId = c.projectId ?? (typeof sa.project_id === 'string' ? sa.project_id : '');
    if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId)) throw new Error('No Firebase project id: set projectId or use a key with project_id.');
    return { clientEmail: sa.client_email, key: privateKeyFrom(sa.private_key, 'rsa'), keyId: typeof sa.private_key_id === 'string' ? sa.private_key_id : null, projectId };
  }

  private async fcmToken(ctx: SendContext, sa: { clientEmail: string; key: KeyObject; keyId: string | null }): Promise<string> {
    const tokenUrl = this.d.endpoints.googleToken ?? GOOGLE_TOKEN_URL;
    return this.d.oauth.get(`${ctx.providerId}:${sa.clientEmail}`, async () => {
      const assertion = serviceAccountAssertion({ clientEmail: sa.clientEmail, key: sa.key, keyId: sa.keyId, tokenUrl, now: this.d.clock() });
      const res = await guardedRequest({ method: 'POST', url: new URL(tokenUrl), headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(), timeoutMs: this.d.timeoutMs, maxBytes: 64 * 1024, check: ctx.check });
      const j = parseJson(res.body) as { access_token?: unknown; expires_in?: unknown; error?: unknown } | null;
      if (res.status !== 200 || typeof j?.access_token !== 'string') throw new Error(`The token endpoint answered ${res.status}${j?.error ? ` (${short(j.error)})` : ''}.`);
      return { token: j.access_token, expiresInS: typeof j.expires_in === 'number' ? j.expires_in : 3600 };
    });
  }

  async fcm(ctx: SendContext, c: FcmConfig, token: string, m: PushMessage): Promise<SendResult> {
    const sa = await this.serviceAccount(ctx, c);
    let access: string;
    try {
      access = await this.fcmToken(ctx, sa);
    } catch (err) {
      return err instanceof ServiceUrlRefused ? refused(err) : { outcome: 'retry', status: null, reason: 'oauth token' };
    }
    const data: Record<string, string> = { ...m.data, kind: m.kind, link: m.link, ...(m.route ? { route: m.route } : {}) };
    const message = {
      token,
      notification: { title: m.title, ...(m.body ? { body: m.body } : {}) },
      data,
      android: { priority: m.priority === 'high' ? 'HIGH' : 'NORMAL', ttl: `${m.ttlSeconds}s`, ...(m.collapseId ? { collapse_key: m.collapseId.slice(0, 64) } : {}) },
      apns: { headers: { 'apns-priority': APNS_PRIORITY[m.priority], ...(m.collapseId ? { 'apns-collapse-id': m.collapseId.slice(0, 64) } : {}), ...(m.ttlSeconds > 0 ? { 'apns-expiration': String(Math.floor(this.d.clock() / 1000) + m.ttlSeconds) } : {}) } },
      webpush: { headers: { TTL: String(m.ttlSeconds), Urgency: m.priority === 'high' ? 'high' : m.priority === 'low' ? 'low' : 'normal', ...(m.collapseId ? { Topic: topicOf(m.collapseId) } : {}) } }
    };
    let res;
    try {
      res = await this.d.pool.request({ providerId: ctx.providerId, origin: this.d.endpoints.fcm ?? 'https://fcm.googleapis.com', check: ctx.check, ...(this.d.ca ? { ca: this.d.ca } : {}) }, { method: 'POST', path: `/v1/projects/${encodeURIComponent(sa.projectId)}/messages:send`, headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' }, body: JSON.stringify({ message }), timeoutMs: this.d.timeoutMs, maxBytes: this.d.maxResponseBytes });
    } catch (err) {
      return refused(err);
    }
    if (res.status === 200) return { outcome: 'sent', status: 200, reason: null };
    const err = (parseJson(res.body) as { error?: { status?: unknown; message?: unknown; details?: { errorCode?: unknown; fieldViolations?: { field?: unknown }[] }[] } } | null)?.error;
    const code = err?.details?.map((d) => d.errorCode).find((x) => typeof x === 'string') as string | undefined;
    const reason = short(code ?? err?.status) ?? null;
    if (code === 'UNREGISTERED' || (res.status === 404 && err?.status === 'NOT_FOUND')) return { outcome: 'gone', status: res.status, reason: 'UNREGISTERED' };
    // INVALID_ARGUMENT drops the device only when it is about the token, not about our message.
    const aboutToken = (err?.details ?? []).some((d) => (d.fieldViolations ?? []).some((v) => v.field === 'message.token')) || /registration token/i.test(String(err?.message ?? ''));
    if (res.status === 400 && (code === 'INVALID_ARGUMENT' || err?.status === 'INVALID_ARGUMENT') && aboutToken) return { outcome: 'gone', status: 400, reason: 'INVALID_ARGUMENT' };
    if (res.status === 401) {
      this.d.oauth.drop(`${ctx.providerId}:${sa.clientEmail}`);
      return { outcome: 'retry', status: 401, reason: reason ?? 'UNAUTHENTICATED', retryAfterMs: 0 };
    }
    if (res.status === 429 || res.status >= 500) return { outcome: 'retry', status: res.status, reason, retryAfterMs: retryAfterMs(res.headers['retry-after'], this.d.clock()) };
    return { outcome: 'failed', status: res.status, reason };
  }

  /** Validates FCM credentials without sending: the assertion is signed and an OAuth token fetched. */
  async checkFcm(ctx: SendContext, c: FcmConfig): Promise<string> {
    const sa = await this.serviceAccount(ctx, c);
    this.d.oauth.drop(`${ctx.providerId}:${sa.clientEmail}`);
    await this.fcmToken(ctx, sa);
    return `OAuth token fetched for ${sa.clientEmail}. Project ${sa.projectId}.`;
  }

  // ---------- Web Push ----------

  async webpush(ctx: SendContext, c: WebPushConfig, token: string, m: PushMessage): Promise<SendResult> {
    let sub;
    try {
      sub = parseSubscription(token);
    } catch {
      return { outcome: 'gone', status: null, reason: 'bad subscription' };
    }
    const key = vapidPrivateKey(await ctx.secret(c.privateKeyRef), c.publicKey);
    const payload = Buffer.from(JSON.stringify({ title: m.title, body: m.body, route: m.route, link: m.link, kind: m.kind, ...(m.collapseId ? { tag: m.collapseId } : {}) }), 'utf8');
    let body: Buffer;
    try {
      body = encryptPayload(sub, payload);
    } catch {
      return { outcome: 'failed', status: null, reason: 'PayloadTooLarge' };
    }
    const now = this.d.clock();
    let res;
    try {
      res = await guardedRequest({
        method: 'POST',
        url: new URL(sub.endpoint),
        headers: { authorization: vapidAuthorization({ endpoint: sub.endpoint, subject: c.subject, publicKey: c.publicKey, key, now }), ttl: String(m.ttlSeconds), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', urgency: m.priority === 'high' ? 'high' : m.priority === 'low' ? 'low' : 'normal', ...(m.collapseId ? { topic: topicOf(m.collapseId) } : {}) },
        body,
        timeoutMs: this.d.timeoutMs,
        maxBytes: this.d.maxResponseBytes,
        check: ctx.check
      });
    } catch (err) {
      return refused(err);
    }
    if (res.status >= 200 && res.status < 300) return { outcome: 'sent', status: res.status, reason: null };
    if (res.status === 404 || res.status === 410) return { outcome: 'gone', status: res.status, reason: 'subscription gone' };
    if (res.status === 429 || res.status >= 500) return { outcome: 'retry', status: res.status, reason: null, retryAfterMs: retryAfterMs(res.headers['retry-after'], now) };
    return { outcome: 'failed', status: res.status, reason: res.status === 413 ? 'PayloadTooLarge' : null };
  }

  async checkWebpush(ctx: SendContext, c: WebPushConfig): Promise<string> {
    const key = vapidPrivateKey(await ctx.secret(c.privateKeyRef), c.publicKey);
    vapidAuthorization({ endpoint: 'https://push.example/check', subject: c.subject, publicKey: c.publicKey, key, now: this.d.clock() });
    return 'The VAPID key pair parses and matches; a VAPID token was signed.';
  }

  // ---------- HTTP vendors and external WebSockets ----------

  private async authHeaders(ctx: SendContext, a: PushAuth, headers: Record<string, string>): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      const r = /^((?:Bearer|Basic|Token) )?(vault:\S+)$/.exec(v);
      out[k.toLowerCase()] = r ? (r[1] ?? '') + (await ctx.secret(r[2]!)) : v;
    }
    if (a.type === 'bearer') out.authorization = `Bearer ${await ctx.secret(a.tokenRef)}`;
    else if (a.type === 'header') out[a.header.toLowerCase()] = await ctx.secret(a.valueRef);
    else if (a.type === 'basic') out.authorization = `Basic ${Buffer.from(`${a.usernameRef ? await ctx.secret(a.usernameRef) : (a.username ?? '')}:${await ctx.secret(a.passwordRef)}`).toString('base64')}`;
    return out;
  }

  async http(ctx: SendContext, c: HttpConfig, token: string, m: PushMessage): Promise<SendResult> {
    const vars = templateVars(token, m);
    const url = new URL(renderUrl(c.url, vars));
    const headers = { ...(await this.authHeaders(ctx, c.auth, c.headers)), 'content-type': c.contentType, accept: 'application/json, */*;q=0.5' };
    const now = this.d.clock();
    let res;
    try {
      res = await guardedRequest({ method: c.method, url, headers, body: renderTemplate(c.body, vars), timeoutMs: Math.min(c.timeoutMs, this.d.timeoutMs * 6), maxBytes: this.d.maxResponseBytes, check: ctx.check });
    } catch (err) {
      return refused(err);
    }
    const r = classify(c.response, res.status, parseJson(res.body));
    return { ...r, ...(r.outcome === 'retry' ? { retryAfterMs: retryAfterMs(res.headers['retry-after'], now) } : {}) };
  }

  async websocket(ctx: SendContext, c: Extract<WebSocketConfig, { mode: 'external' }>, token: string, m: PushMessage): Promise<SendResult> {
    const vars = templateVars(token, m);
    const url = new URL(renderUrl(c.url, vars));
    const headers = await this.authHeaders(ctx, c.auth, c.headers);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    // The address dialled is the one checked: resolve and check here, then pin the lookup to it.
    let target: string;
    try {
      target = await checkedAddress(host, ctx.check);
    } catch (err) {
      return refused(err);
    }
    const family = isIP(target) === 6 ? 6 : 4;
    return new Promise<SendResult>((resolve) => {
      let settled = false;
      const done = (r: SendResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.terminate();
        } catch {
          /* closed already */
        }
        resolve(r);
      };
      const ws = new WebSocket(url, {
        headers,
        handshakeTimeout: c.timeoutMs,
        maxPayload: this.d.maxResponseBytes,
        followRedirects: false,
        ...(this.d.ca ? { ca: this.d.ca } : {}),
        lookup: ((_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => (opts?.all ? cb(null, [{ address: target, family }]) : cb(null, target, family))) as never
      } as WebSocket.ClientOptions);
      const timer = setTimeout(() => done({ outcome: 'retry', status: null, reason: 'timeout' }), c.timeoutMs);
      timer.unref();
      ws.on('open', () => ws.send(renderTemplate(c.body, vars)));
      ws.on('message', (data: Buffer) => {
        const doc = parseJson(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
        const st = typeof (doc as { status?: unknown } | null)?.status === 'number' ? Number((doc as { status: number }).status) : 0;
        done(classify(c.response, st, doc));
      });
      ws.on('unexpected-response', (_req, res) => done({ outcome: (res.statusCode ?? 0) === 429 || (res.statusCode ?? 0) >= 500 ? 'retry' : 'failed', status: res.statusCode ?? null, reason: 'handshake refused' }));
      ws.on('error', (err) => done(refused(err)));
      ws.on('close', () => done({ outcome: 'retry', status: null, reason: 'closed without a reply' }));
    });
  }

  /** HTTP vendor and external WebSocket: the references read, the host passes the guard (no request is made). */
  async checkEndpoint(ctx: SendContext, url: string, auth: PushAuth, headers: Record<string, string>): Promise<string> {
    await this.authHeaders(ctx, auth, headers);
    const u = new URL(renderUrl(url, templateVars('check', { title: '', body: null, route: null, link: '', kind: 'check', data: {}, collapseId: null, ttlSeconds: 0, priority: 'normal' })));
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const a = await checkedAddress(host, ctx.check);
    return `Credentials read from the vault; ${host} resolves to ${a}, which the egress guard allows. Nothing was sent.`;
  }

  /** The sender for a device of a provider kind. */
  send(kind: PushKind, ctx: SendContext, config: unknown, token: string, m: PushMessage): Promise<SendResult> {
    switch (kind) {
      case 'apns':
        return this.apns(ctx, config as ApnsConfig, token, m);
      case 'fcm':
        return this.fcm(ctx, config as FcmConfig, token, m);
      case 'webpush':
        return this.webpush(ctx, config as WebPushConfig, token, m);
      case 'http':
        return this.http(ctx, config as HttpConfig, token, m);
      case 'websocket': {
        const w = config as WebSocketConfig;
        if (w.mode !== 'external') return Promise.resolve({ outcome: 'failed', status: null, reason: 'socket channel has no devices' });
        return this.websocket(ctx, w, token, m);
      }
    }
  }
}

/** An RFC 8030 Topic: at most 32 characters of the URL-safe base64 alphabet. */
export const topicOf = (collapseId: string): string => {
  const clean = collapseId.replace(/[^A-Za-z0-9_-]/g, '');
  return (clean.length ? clean : Buffer.from(collapseId).toString('base64url')).slice(0, 32);
};

async function checkedAddress(host: string, check: (a: string, h: string) => string | null): Promise<string> {
  const addresses = isIP(host)
    ? [host]
    : await new Promise<string[]>((resolve, reject) => dnsLookup(host, { all: true, verbatim: true }, (err, list) => (err ? reject(new ServiceUrlRefused(`${host} does not resolve: ${err.code ?? err.message}.`)) : resolve(list.map((x) => x.address)))));
  if (!addresses.length) throw new ServiceUrlRefused(`${host} does not resolve.`);
  for (const a of addresses) {
    const p = check(a, host);
    if (p) throw new ServiceUrlRefused(p);
  }
  return addresses[0]!;
}

// ---------- templates and response mapping ----------

const PLACEHOLDER = /\{([A-Za-z_][\w-]{0,62})\}/g;

export function templateVars(token: string, m: PushMessage): Record<string, unknown> {
  return { title: m.title, body: m.body, data: m.data, token, collapseId: m.collapseId, ttl: m.ttlSeconds, priority: m.priority, route: m.route, kind: m.kind, link: m.link };
}

/**
 * A body template with `{name}` placeholders, each replaced by the value as JSON (a string in quotes, a number, an
 * object or null), as the registry's HTTP tools render a body template. Unknown names were refused when saved.
 */
export function renderTemplate(t: string, vars: Record<string, unknown>): string {
  return t.replace(PLACEHOLDER, (_m, name: string) => JSON.stringify(vars[name] ?? null));
}

/** A URL with `{name}` placeholders, each value percent-encoded (only the path and query take placeholders). */
export function renderUrl(t: string, vars: Record<string, unknown>): string {
  const [, scheme, rest] = /^([a-z]+:\/\/[^/?#]*)(.*)$/is.exec(t) ?? [null, t, ''];
  return scheme + (rest ?? '').replace(PLACEHOLDER, (_m, name: string) => encodeURIComponent(vars[name] == null ? '' : typeof vars[name] === 'object' ? JSON.stringify(vars[name]) : String(vars[name])));
}

const ruleMatches = (r: OutcomeRule, status: number, doc: unknown): boolean => {
  const byStatus = r.status.length > 0 && codeMatches(r.status, status);
  if (!r.pointer) return byStatus;
  const v = jsonPointer(doc, r.pointer);
  const text = v === undefined ? undefined : typeof v === 'string' ? v : JSON.stringify(v);
  const byPointer = text !== undefined && (!r.equals?.length || r.equals.includes(text));
  // Both given: the status must match (when it lists any) and the pointer must match.
  return r.status.length ? byStatus && byPointer : byPointer;
};

/** A vendor's answer through its mapping: "token gone" first, then retry, then success; anything else failed. */
export function classify(map: ResponseMapping, status: number, doc: unknown): SendResult {
  if (ruleMatches(map.gone, status, doc)) return { outcome: 'gone', status: status || null, reason: 'mapped: token gone' };
  if (ruleMatches(map.retry, status, doc)) return { outcome: 'retry', status: status || null, reason: 'mapped: retry' };
  if (ruleMatches(map.success, status, doc)) return { outcome: 'sent', status: status || null, reason: null };
  return { outcome: 'failed', status: status || null, reason: 'mapped: not a success' };
}
