import { createHash, createHmac, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import type { Config } from '../config/index.js';
import { dns01Value, type DnsProvider } from './dns.js';

/** Where the client publishes http-01 key authorizations; the server answers them at /.well-known/acme-challenge/<token>. */
export interface AcmeChallengeStore {
  publish(token: string, keyAuthorization: string): Promise<void>;
  remove(token: string): Promise<void>;
}

export interface AcmeIssueInput {
  /** The account key (ECDSA P-256) and the account URL returned by `register`. */
  key: KeyObject;
  kid: string;
  domains: string[];
  /** DER-encoded PKCS#10 request (`buildCsr`). */
  csr: Buffer;
  challenges: AcmeChallengeStore;
  /** Sprint 15: answer dns-01 through this provider instead of http-01. */
  dns?: DnsProvider | null;
  /** How long to wait after publishing a TXT record before asking the CA to validate. */
  dnsWaitMs?: number;
  signal?: AbortSignal;
  progress?: (pct: number, message: string) => Promise<void>;
}

/** RFC 8555 ACME client used for platform certificates (tests run it against an in-process fake directory). */
export interface AcmeClient {
  readonly directoryUrl: string | null;
  /** Creates the account for this key, or finds the existing one; returns the account URL (the JWS `kid`). */
  register(key: KeyObject, contact?: string): Promise<string>;
  /** Places an order, answers http-01 (or dns-01) for every authorization, finalizes with the CSR and returns the PEM chain. */
  issue(input: AcmeIssueInput): Promise<{ chainPem: string; orderUrl: string }>;
  revoke(input: { key: KeyObject; kid: string; certDer: Buffer; reason?: number }): Promise<void>;
}

export class AcmeError extends Error {
  constructor(
    message: string,
    readonly type?: string,
    readonly status?: number
  ) {
    super(message);
  }
}

interface Directory {
  newNonce: string;
  newAccount: string;
  newOrder: string;
  revokeCert: string;
  meta?: { externalAccountRequired?: boolean };
}

/** B-904: an external account binding key from the CA (RFC 8555 section 7.3.4). */
export interface ExternalAccountKey {
  kid: string;
  /** The MAC key, base64url as CAs hand it out. */
  hmacKey: string;
}

/** The `externalAccountBinding` JWS: the account's public JWK, MACed with the CA-issued key (HS256). */
export function externalAccountBinding(eab: ExternalAccountKey, accountKey: KeyObject, newAccountUrl: string): { protected: string; payload: string; signature: string } {
  const p = b64u(JSON.stringify({ alg: 'HS256', kid: eab.kid, url: newAccountUrl }));
  const payload = b64u(JSON.stringify(publicJwk(accountKey)));
  const signature = b64u(createHmac('sha256', Buffer.from(eab.hmacKey, 'base64url')).update(`${p}.${payload}`).digest());
  return { protected: p, payload, signature };
}

interface Order {
  status: 'pending' | 'ready' | 'processing' | 'valid' | 'invalid';
  authorizations: string[];
  finalize: string;
  certificate?: string;
  error?: { detail?: string; type?: string };
}

interface Authorization {
  status: 'pending' | 'valid' | 'invalid' | 'deactivated' | 'expired' | 'revoked';
  identifier: { type: string; value: string };
  wildcard?: boolean;
  challenges: { type: string; url: string; token: string; status: string; error?: { detail?: string } }[];
}

type AcmeFetch = (url: string, init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; dispatcher?: Dispatcher }) => Promise<{ status: number; ok: boolean; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

/** The public JWK of an EC P-256 key with members in the order RFC 7638 needs for the thumbprint. */
export function publicJwk(key: KeyObject): { crv: string; kty: string; x: string; y: string } {
  const j = createPublicKey(key).export({ format: 'jwk' }) as { crv: string; kty: string; x: string; y: string };
  if (j.kty !== 'EC' || j.crv !== 'P-256') throw new Error('ACME account keys must be ECDSA P-256');
  return { crv: j.crv, kty: j.kty, x: j.x, y: j.y };
}

export const thumbprint = (key: KeyObject): string => b64u(createHash('sha256').update(JSON.stringify(publicJwk(key))).digest());

export const keyAuthorization = (token: string, key: KeyObject): string => `${token}.${thumbprint(key)}`;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason as Error);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason as Error);
    }, { once: true });
  });

export class HttpAcmeClient implements AcmeClient {
  private dir: Directory | null = null;
  private nonces: string[] = [];
  private readonly agent: Agent | undefined;

  constructor(
    readonly directoryUrl: string | null,
    private readonly o: { caFile?: string; pollMs: number; timeoutMs?: number; production?: boolean; fetch?: AcmeFetch; eab?: ExternalAccountKey } = { pollMs: 2000 }
  ) {
    this.agent = o.caFile ? new Agent({ connect: { ca: readFileSync(o.caFile) } }) : undefined;
  }

  private get doFetch(): AcmeFetch {
    return this.o.fetch ?? (undiciFetch as unknown as AcmeFetch);
  }

  private async request(url: string, init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) {
    const res = await this.doFetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(this.o.timeoutMs ?? 30_000), ...(this.agent ? { dispatcher: this.agent } : {}) });
    const nonce = res.headers.get('replay-nonce');
    if (nonce) this.nonces.push(nonce);
    return res;
  }

  private async directory(): Promise<Directory> {
    if (this.dir) return this.dir;
    if (!this.directoryUrl) throw new AcmeError('ACME is not configured. Set ACME_DIRECTORY_URL to the internal CA\'s directory.');
    if (this.o.production && !this.directoryUrl.startsWith('https:')) throw new AcmeError('The ACME directory must be https:// in production.');
    const res = await this.request(this.directoryUrl, { method: 'GET' });
    if (!res.ok) throw new AcmeError(`The ACME directory answered ${res.status}.`, undefined, res.status);
    const d = JSON.parse(await res.text()) as Partial<Directory>;
    if (!d.newNonce || !d.newAccount || !d.newOrder || !d.revokeCert) throw new AcmeError('The ACME directory is missing required URLs.');
    this.dir = d as Directory;
    return this.dir;
  }

  private async nonce(): Promise<string> {
    const n = this.nonces.pop();
    if (n) return n;
    const res = await this.request((await this.directory()).newNonce, { method: 'HEAD' });
    const fresh = res.headers.get('replay-nonce');
    this.nonces.pop();
    if (!fresh) throw new AcmeError('The ACME server returned no nonce.');
    return fresh;
  }

  /** A JWS-signed POST (payload null means POST-as-GET). Retries once on badNonce, as RFC 8555 section 6.5 asks. */
  private async post(url: string, payload: unknown, key: KeyObject, kid: string | null, opts: { accept?: string; signal?: AbortSignal } = {}) {
    for (let attempt = 0; ; attempt++) {
      const header = { alg: 'ES256', nonce: await this.nonce(), url, ...(kid ? { kid } : { jwk: publicJwk(key) }) };
      const p = b64u(JSON.stringify(header));
      const body = payload === null ? '' : b64u(JSON.stringify(payload));
      const signature = b64u(sign('sha256', Buffer.from(`${p}.${body}`), { key, dsaEncoding: 'ieee-p1363' }));
      const res = await this.request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/jose+json', ...(opts.accept ? { accept: opts.accept } : {}) },
        body: JSON.stringify({ protected: p, payload: body, signature }),
        ...(opts.signal ? { signal: opts.signal } : {})
      });
      const text = await res.text();
      if (res.ok) return { status: res.status, location: res.headers.get('location'), text, json: <T>() => JSON.parse(text) as T };
      let problem: { type?: string; detail?: string } = {};
      try {
        problem = JSON.parse(text) as typeof problem;
      } catch {
        // not a problem document
      }
      if (problem.type === 'urn:ietf:params:acme:error:badNonce' && attempt < 2) continue;
      throw new AcmeError(`ACME ${res.status}: ${problem.detail ?? (text.slice(0, 200) || 'request failed')}`, problem.type, res.status);
    }
  }

  async register(key: KeyObject, contact?: string): Promise<string> {
    const d = await this.directory();
    if (d.meta?.externalAccountRequired && !this.o.eab) throw new AcmeError('The CA requires external account binding: set ACME_EAB_KID and ACME_EAB_HMAC_KEY to the key it issued.', 'urn:ietf:params:acme:error:externalAccountRequired');
    const eab = this.o.eab ? { externalAccountBinding: externalAccountBinding(this.o.eab, key, d.newAccount) } : {};
    const r = await this.post(d.newAccount, { termsOfServiceAgreed: true, ...(contact ? { contact: [`mailto:${contact}`] } : {}), ...eab }, key, null);
    if (!r.location) throw new AcmeError('The ACME server returned no account URL.');
    return r.location;
  }

  private async poll<T extends { status: string }>(url: string, key: KeyObject, kid: string, done: (t: T) => boolean, signal?: AbortSignal): Promise<T> {
    const deadline = Date.now() + 10 * 60_000;
    for (;;) {
      const t = (await this.post(url, null, key, kid, { ...(signal ? { signal } : {}) })).json<T>();
      if (done(t)) return t;
      if (Date.now() > deadline) throw new AcmeError(`Timed out waiting on ${url} (status ${t.status}).`);
      await sleep(this.o.pollMs, signal);
    }
  }

  async issue(input: AcmeIssueInput): Promise<{ chainPem: string; orderUrl: string }> {
    const { key, kid, signal } = input;
    const d = await this.directory();
    const created = await this.post(d.newOrder, { identifiers: input.domains.map((value) => ({ type: 'dns', value })) }, key, kid);
    const orderUrl = created.location;
    if (!orderUrl) throw new AcmeError('The ACME server returned no order URL.');
    let order = created.json<Order>();
    await input.progress?.(20, 'Order placed');
    const published: string[] = [];
    const records: { domain: string; value: string }[] = [];
    const type = input.dns ? 'dns-01' : 'http-01';
    try {
      for (const [i, authzUrl] of order.authorizations.entries()) {
        const authz = (await this.post(authzUrl, null, key, kid)).json<Authorization>();
        if (authz.status === 'valid') continue;
        const ch = authz.challenges.find((c) => c.type === type);
        if (!ch) throw new AcmeError(`The CA offered no ${type} challenge for ${authz.identifier.value}.`);
        const ka = keyAuthorization(ch.token, key);
        if (input.dns) {
          // The record goes on the base name, also for a wildcard (the CA reports it without the `*.`).
          const value = dns01Value(ka);
          await input.dns.present(authz.identifier.value, value);
          records.push({ domain: authz.identifier.value, value });
          if (input.dnsWaitMs) await sleep(input.dnsWaitMs, signal);
        } else {
          await input.challenges.publish(ch.token, ka);
          published.push(ch.token);
        }
        await this.post(ch.url, {}, key, kid);
        const final = await this.poll<Authorization>(authzUrl, key, kid, (a) => a.status !== 'pending', signal);
        if (final.status !== 'valid') {
          const why = final.challenges.find((c) => c.type === type)?.error?.detail;
          throw new AcmeError(`Authorization for ${authz.identifier.value} is ${final.status}${why ? `: ${why}` : ''}.`);
        }
        await input.progress?.(20 + Math.round((40 * (i + 1)) / order.authorizations.length), `Authorized ${authz.identifier.value}`);
      }
    } finally {
      for (const t of published) await input.challenges.remove(t).catch(() => undefined);
      for (const r of records) await input.dns?.cleanup(r.domain, r.value).catch(() => undefined);
    }
    order = await this.poll<Order>(orderUrl, key, kid, (o) => o.status !== 'pending', signal);
    if (order.status === 'invalid') throw new AcmeError(`The order is invalid${order.error?.detail ? `: ${order.error.detail}` : ''}.`);
    if (order.status === 'ready') {
      await this.post(order.finalize, { csr: b64u(input.csr) }, key, kid);
      await input.progress?.(75, 'Finalized with the certificate request');
      order = await this.poll<Order>(orderUrl, key, kid, (o) => o.status === 'valid' || o.status === 'invalid', signal);
    }
    if (order.status !== 'valid' || !order.certificate) throw new AcmeError(`The order ended ${order.status}${order.error?.detail ? `: ${order.error.detail}` : ''}.`);
    const cert = await this.post(order.certificate, null, key, kid, { accept: 'application/pem-certificate-chain' });
    if (!cert.text.includes('-----BEGIN CERTIFICATE-----')) throw new AcmeError('The CA returned no PEM certificate chain.');
    await input.progress?.(90, 'Certificate downloaded');
    return { chainPem: cert.text, orderUrl };
  }

  async revoke(input: { key: KeyObject; kid: string; certDer: Buffer; reason?: number }): Promise<void> {
    const d = await this.directory();
    await this.post(d.revokeCert, { certificate: b64u(input.certDer), ...(input.reason !== undefined ? { reason: input.reason } : {}) }, input.key, input.kid);
  }
}

export function createAcme(cfg: Config): AcmeClient {
  return new HttpAcmeClient(cfg.ACME_DIRECTORY_URL ?? null, { ...(cfg.ACME_CA_FILE ? { caFile: cfg.ACME_CA_FILE } : {}), pollMs: cfg.ACME_POLL_MS, production: cfg.NODE_ENV === 'production', ...(cfg.ACME_EAB_KID && cfg.ACME_EAB_HMAC_KEY ? { eab: { kid: cfg.ACME_EAB_KID, hmacKey: cfg.ACME_EAB_HMAC_KEY } } : {}) });
}
