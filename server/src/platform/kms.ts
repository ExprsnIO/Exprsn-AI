import { createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import type { Config } from '../config/index.js';
import { safeEqual, SecretBox } from '../crypto/index.js';

/**
 * Key management. The KMS holds key-encryption keys (KEKs) by name and never hands them out: callers ask it to
 * wrap and unwrap data keys and to compute HMACs. Two adapters:
 *   - local:   KEKs derived from DATA_KEY with HKDF; "destroying" a key is done by deleting the wrapped data key
 *   - openbao: OpenBao (or Vault) transit; destroying deletes the transit key itself
 */
export interface Kms {
  readonly kind: 'local' | 'openbao';
  /** Creates the named KEK if the KMS needs it to exist first. Idempotent. */
  ensureKey(name: string): Promise<void>;
  wrap(name: string, plaintext: Buffer, aad: string): Promise<string>;
  unwrap(name: string, wrapped: string, aad: string): Promise<Buffer>;
  hmac(name: string, data: string): Promise<string>;
  verifyHmac(name: string, data: string, mac: string): Promise<boolean>;
  destroyKey(name: string): Promise<void>;
  health(): Promise<{ ok: boolean; detail: string }>;
}

export class LocalKms implements Kms {
  readonly kind = 'local' as const;
  private readonly master: Buffer;

  constructor(dataKeyBase64: string) {
    this.master = Buffer.from(dataKeyBase64, 'base64');
    if (this.master.length !== 32) throw new Error('DATA_KEY must be 32 bytes');
  }

  private derive(name: string, purpose: string): Buffer {
    return Buffer.from(hkdfSync('sha256', this.master, Buffer.alloc(0), `exprsn-kms:${purpose}:${name}`, 32));
  }

  async ensureKey(): Promise<void> {}

  async wrap(name: string, plaintext: Buffer, aad: string): Promise<string> {
    return new SecretBox(this.derive(name, 'wrap').toString('base64')).seal(plaintext.toString('base64'), aad);
  }

  async unwrap(name: string, wrapped: string, aad: string): Promise<Buffer> {
    return Buffer.from(new SecretBox(this.derive(name, 'wrap').toString('base64')).open(wrapped, aad), 'base64');
  }

  async hmac(name: string, data: string): Promise<string> {
    return 'local:v1:' + createHmac('sha256', this.derive(name, 'hmac')).update(data).digest('base64');
  }

  async verifyHmac(name: string, data: string, mac: string): Promise<boolean> {
    return safeEqual(await this.hmac(name, data), mac);
  }

  async destroyKey(): Promise<void> {
    // Derived KEKs cannot be deleted; the caller deletes the only wrapped copy of the data key instead.
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: 'local key-encryption key from DATA_KEY' };
  }
}

type BaoFetch = (url: string, init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; dispatcher?: Dispatcher }) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

/** OpenBao / Vault transit engine over its HTTP API. */
export class OpenBaoKms implements Kms {
  readonly kind = 'openbao' as const;
  private readonly known = new Set<string>();
  private readonly agent: Agent | undefined;

  constructor(
    private readonly addr: string,
    private readonly token: () => string,
    private readonly mount = 'transit',
    caFile?: string,
    private readonly doFetch: BaoFetch = undiciFetch as unknown as BaoFetch
  ) {
    this.agent = caFile ? new Agent({ connect: { ca: readFileSync(caFile) } }) : undefined;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.doFetch(`${this.addr.replace(/\/$/, '')}/v1/${this.mount}/${path}`, {
      method,
      headers: { 'X-Vault-Token': this.token(), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
      ...(this.agent ? { dispatcher: this.agent } : {})
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!res.ok) throw new Error(`OpenBao ${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async ensureKey(name: string): Promise<void> {
    if (this.known.has(name)) return;
    await this.call('POST', `keys/${encodeURIComponent(name)}`, { type: 'aes256-gcm96' });
    // Offboarding destroys tenant keys, which transit refuses unless deletion is allowed on the key.
    await this.call('POST', `keys/${encodeURIComponent(name)}/config`, { deletion_allowed: true });
    this.known.add(name);
  }

  async wrap(name: string, plaintext: Buffer, aad: string): Promise<string> {
    await this.ensureKey(name);
    // The AAD is bound by prefixing it; transit's own "context" requires derived keys.
    const payload = Buffer.concat([Buffer.from(aad + '\n'), plaintext]).toString('base64');
    const r = await this.call<{ data: { ciphertext: string } }>('POST', `encrypt/${encodeURIComponent(name)}`, { plaintext: payload });
    return r.data.ciphertext;
  }

  async unwrap(name: string, wrapped: string, aad: string): Promise<Buffer> {
    const r = await this.call<{ data: { plaintext: string } }>('POST', `decrypt/${encodeURIComponent(name)}`, { ciphertext: wrapped });
    const buf = Buffer.from(r.data.plaintext, 'base64');
    const nl = buf.indexOf(0x0a);
    if (nl < 0 || buf.subarray(0, nl).toString() !== aad) throw new Error('Wrapped key does not belong to this context');
    return buf.subarray(nl + 1);
  }

  async hmac(name: string, data: string): Promise<string> {
    await this.ensureKey(name);
    const r = await this.call<{ data: { hmac: string } }>('POST', `hmac/${encodeURIComponent(name)}/sha2-256`, { input: Buffer.from(data).toString('base64') });
    return r.data.hmac;
  }

  async verifyHmac(name: string, data: string, mac: string): Promise<boolean> {
    const r = await this.call<{ data: { valid: boolean } }>('POST', `verify/${encodeURIComponent(name)}/sha2-256`, { input: Buffer.from(data).toString('base64'), hmac: mac });
    return r.data.valid === true;
  }

  async destroyKey(name: string): Promise<void> {
    try {
      await this.call('POST', `keys/${encodeURIComponent(name)}/config`, { deletion_allowed: true });
      await this.call('DELETE', `keys/${encodeURIComponent(name)}`);
    } finally {
      this.known.delete(name);
    }
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await this.doFetch(`${this.addr.replace(/\/$/, '')}/v1/sys/health`, { method: 'GET', signal: AbortSignal.timeout(3000), ...(this.agent ? { dispatcher: this.agent } : {}) });
      return { ok: res.status === 200 || res.status === 429, detail: `OpenBao ${res.status}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }
}

export function createKms(cfg: Config): Kms {
  if (cfg.KMS_PROVIDER === 'openbao') {
    const token = cfg.OPENBAO_TOKEN as string;
    return new OpenBaoKms(cfg.OPENBAO_ADDR as string, () => token, cfg.OPENBAO_TRANSIT_MOUNT, cfg.OPENBAO_CA_FILE);
  }
  return new LocalKms(cfg.DATA_KEY as string);
}

export const newDataKey = (): Buffer => randomBytes(32);
