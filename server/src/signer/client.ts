import { connect, type Socket } from 'node:net';
import { safeEqual } from '../crypto/index.js';
import type { HeldKeys, HeldKeyType, Kms, SigningKeyType } from '../platform/kms.js';
import { encodeFrame, FrameReader, type SignerOp, type SignerResponse } from './protocol.js';

interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * The app's side of the signer socket (B-1201): one connection, opened on first use and again after it drops, with
 * requests matched to answers by id. The `hello` with the shared token goes first on every new connection.
 */
export class SignerClient {
  private sock: Socket | null = null;
  private ready: Promise<void> | null = null;
  private next = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly socketPath: string,
    private readonly token: string,
    private readonly timeoutMs = 5000
  ) {}

  private fail(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
    this.sock?.destroy();
    this.sock = null;
    this.ready = null;
  }

  private send(op: SignerOp, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sock = this.sock;
    if (!sock) return Promise.reject(new Error('The signer is not connected'));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The signer did not answer ${op} within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      sock.write(encodeFrame({ id, op, ...args }));
    });
  }

  private connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const sock = connect(this.socketPath);
      const reader = new FrameReader();
      sock.once('error', (err) => {
        reject(new Error(`The signer at ${this.socketPath} is not reachable: ${err.message}`));
        this.fail(new Error(`The signer connection failed: ${err.message}`));
      });
      sock.on('close', () => this.fail(new Error('The signer closed the connection')));
      sock.on('data', (chunk: Buffer) => {
        let frames: unknown[];
        try {
          frames = reader.push(chunk);
        } catch (err) {
          this.fail(err as Error);
          return;
        }
        for (const f of frames) {
          const r = f as SignerResponse;
          const p = this.pending.get(r.id);
          if (!p) continue;
          this.pending.delete(r.id);
          clearTimeout(p.timer);
          if (r.ok) p.resolve(r.result);
          else p.reject(new Error(`Signer: ${r.error}`));
        }
      });
      sock.once('connect', () => {
        this.sock = sock;
        this.send('hello', { token: this.token }).then(() => resolve(), (err: Error) => {
          this.fail(err);
          reject(err);
        });
      });
    });
    this.ready.catch(() => undefined);
    return this.ready;
  }

  async call(op: SignerOp, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    await this.connect();
    return this.send(op, args);
  }

  close(): void {
    this.fail(new Error('Closed'));
  }
}

/**
 * The local KMS through the signer (B-1205): wrap, unwrap and HMAC happen in the signer with the key-encryption key
 * this process never holds, and `heldKeys` creates and uses the private keys the signer keeps (B-1201). Values are
 * the same as LocalKms's, so data keys wrapped before the signer ran (with the same key) still open.
 */
export class SignerKms implements Kms {
  readonly kind = 'local' as const;
  readonly heldKeys: HeldKeys;

  constructor(readonly client: SignerClient) {
    const c = client;
    this.heldKeys = {
      async create(name: string, type: HeldKeyType, certificate?: { commonName: string; organization: string; days: number }) {
        const r = await c.call('keygen', { name, type, ...(certificate ? { certificate } : {}) });
        return { publicKey: String(r.publicKey), wrapped: String(r.wrapped), certificate: r.certificate == null ? null : String(r.certificate) };
      },
      async sign(name: string, type: SigningKeyType, wrapped: string, data: Buffer) {
        return Buffer.from(String((await c.call('sign', { name, type, wrapped, data: data.toString('base64') })).signature), 'base64');
      },
      async decrypt(name: string, wrapped: string, ciphertext: Buffer, oaepHash: 'sha1' | 'sha256') {
        return Buffer.from(String((await c.call('decrypt', { name, wrapped, ciphertext: ciphertext.toString('base64'), oaepHash })).plaintext), 'base64');
      }
    };
  }

  async ensureKey(): Promise<void> {}

  async wrap(name: string, plaintext: Buffer, aad: string): Promise<string> {
    return String((await this.client.call('wrap', { name, plaintext: plaintext.toString('base64'), aad })).wrapped);
  }

  async unwrap(name: string, wrapped: string, aad: string): Promise<Buffer> {
    return Buffer.from(String((await this.client.call('unwrap', { name, wrapped, aad })).plaintext), 'base64');
  }

  async hmac(name: string, data: string): Promise<string> {
    return String((await this.client.call('hmac', { name, data })).mac);
  }

  async verifyHmac(name: string, data: string, mac: string): Promise<boolean> {
    return safeEqual(await this.hmac(name, data), mac);
  }

  async destroyKey(): Promise<void> {
    // As with LocalKms: derived KEKs cannot be deleted; the caller deletes the only wrapped copy of the data key.
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const r = await this.client.call('health');
      return { ok: r.ok === true, detail: `signer: ${String(r.detail)}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }
}
