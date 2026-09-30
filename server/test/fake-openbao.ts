import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

interface TransitKey {
  type: string;
  secret?: Buffer;
  privateKey?: KeyObject;
  publicPem?: string;
}

/**
 * An in-process OpenBao transit engine for tests: enough of its HTTP API for the KMS adapter's data keys (keys,
 * encrypt, decrypt, hmac, verify) and for asymmetric signing (ecdsa-p256 and rsa-2048 keys, read of the public
 * key, sign with the JWS marshaling or PKCS#1 v1.5). Private signing keys stay inside this fake, as in OpenBao.
 */
export class FakeOpenBao {
  url = '';
  readonly token = 'fake-root-token';
  readonly keys = new Map<string, TransitKey>();
  /** Every sign call, by key name. */
  readonly signed: string[] = [];
  private server: Server | null = null;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const send = (status: number, data?: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(data === undefined ? '' : JSON.stringify(data));
        };
        if (req.url === '/v1/sys/health') return send(200, { initialized: true, sealed: false });
        if (req.headers['x-vault-token'] !== this.token) return send(403, { errors: ['permission denied'] });
        const m = /^\/v1\/transit\/(keys|encrypt|decrypt|hmac|verify|sign)\/([^/]+)(?:\/(config|sha2-256))?$/.exec(req.url ?? '');
        if (!m) return send(404, { errors: ['no handler'] });
        const [, op, name] = m;
        const b = body ? (JSON.parse(body) as Record<string, string>) : {};
        const key = this.keys.get(name!);
        switch (op) {
          case 'keys': {
            if (req.method === 'DELETE') {
              this.keys.delete(name!);
              return send(204);
            }
            if (req.method === 'GET') {
              if (!key?.publicPem) return send(404, { errors: ['no such key'] });
              return send(200, { data: { type: key.type, latest_version: 1, keys: { '1': { public_key: key.publicPem } } } });
            }
            if (m[3] || key) return send(204);
            const type = b.type ?? 'aes256-gcm96';
            if (type === 'ecdsa-p256' || type === 'rsa-2048') {
              const pair = type === 'ecdsa-p256' ? generateKeyPairSync('ec', { namedCurve: 'P-256' }) : generateKeyPairSync('rsa', { modulusLength: 2048 });
              this.keys.set(name!, { type, privateKey: pair.privateKey, publicPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() });
            } else this.keys.set(name!, { type, secret: randomBytes(32) });
            return send(204);
          }
          case 'sign': {
            if (!key?.privateKey) return send(400, { errors: ['not a signing key'] });
            this.signed.push(name!);
            const input = Buffer.from(b.input ?? '', 'base64');
            if (key.type === 'ecdsa-p256') {
              const sig = sign('sha256', input, { key: key.privateKey, dsaEncoding: b.marshaling_algorithm === 'jws' ? 'ieee-p1363' : 'der' });
              return send(200, { data: { signature: `vault:v1:${b.marshaling_algorithm === 'jws' ? sig.toString('base64url') : sig.toString('base64')}` } });
            }
            if (b.signature_algorithm !== 'pkcs1v15') return send(400, { errors: ['this fake signs RSA with pkcs1v15 only'] });
            return send(200, { data: { signature: `vault:v1:${sign('sha256', input, key.privateKey).toString('base64')}` } });
          }
          case 'encrypt':
            if (!key?.secret) return send(400, { errors: ['no key'] });
            return send(200, { data: { ciphertext: 'vault:v1:' + Buffer.concat([key.secret.subarray(0, 4), Buffer.from(b.plaintext ?? '', 'base64')]).toString('base64') } });
          case 'decrypt': {
            if (!key?.secret) return send(400, { errors: ['no key'] });
            const raw = Buffer.from(String(b.ciphertext).slice(9), 'base64');
            if (!raw.subarray(0, 4).equals(key.secret.subarray(0, 4))) return send(400, { errors: ['bad ciphertext'] });
            return send(200, { data: { plaintext: raw.subarray(4).toString('base64') } });
          }
          case 'hmac':
            return send(200, { data: { hmac: 'vault:v1:' + Buffer.from(name + (b.input ?? '')).toString('base64') } });
          case 'verify':
            return send(200, { data: { valid: b.hmac === 'vault:v1:' + Buffer.from(name + (b.input ?? '')).toString('base64') } });
        }
        send(404, { errors: ['no handler'] });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', () => resolve()));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
