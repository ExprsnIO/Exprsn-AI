import { constants, createPrivateKey, generateKeyPairSync, hkdfSync, privateDecrypt, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';
import { safeEqual, SecretBox } from '../crypto/index.js';
import { selfSignedCertificate } from '../federation/x509.js';
import { LocalKms, type HeldKeyType } from '../platform/kms.js';
import { encodeFrame, FrameReader, MAX_SIGN_BYTES, PROTOCOL_VERSION, type SignerRequest, type SignerResponse } from './protocol.js';

/*
 * The signer process (B-1201, B-1205): `exprsn-ai signer`. It holds the local key-encryption key (what DATA_KEY was)
 * and every private key the app asks it to create — OIDC (ES256), SAML (RS256), the SAML SP decryption key
 * (RSA-OAEP) and webhook Ed25519 keys — and answers on a UNIX socket. The app never sees any of them: it stores the
 * opaque wrapped blob a key comes back as (sealed under a key derived from the KEK, bound to the key's name and
 * type) and hands it back with every request, so any signer holding the same key file can serve any app instance.
 *
 * Who may connect: Node cannot read a UNIX socket peer's credentials (SO_PEERCRED / getpeereid are not exposed), so
 * the check is layered instead:
 *   1. the socket lives in a directory only the signer's user (and, with mode 0660, its group) can enter,
 *   2. the socket itself is mode 0600 (or 0660 for a shared group),
 *   3. the first frame on every connection must carry the shared token from a file readable only by the app user;
 *      a wrong token closes the connection.
 * Run the signer as its own user (see deploy/baremetal/exprsn-signer.service), so the app's user cannot read the
 * signer's key file even though it can reach the socket.
 */

const NAME_RE = /^[A-Za-z0-9:._-]{1,200}$/;
const HELD_TYPES: readonly HeldKeyType[] = ['ecdsa-p256', 'rsa-2048', 'ed25519', 'rsa-oaep-2048'];

export interface SignerOptions {
  socketPath: string;
  /** The key-encryption key, base64 (32 bytes). */
  key: string;
  /** The shared token the app presents (at least 32 characters). */
  token: string;
  /** 0o600 (default) or 0o660 when the app runs as another user in the socket's group. */
  socketMode?: number;
  log?: (msg: string) => void;
}

export interface RunningSigner {
  socketPath: string;
  /** How many requests were served, by operation (tests). */
  readonly served: Record<string, number>;
  close(): Promise<void>;
}

/**
 * Reads a secret file and refuses it when group or others may read it (POSIX). `allowGroupRead` is for Kubernetes,
 * where a secret volume is always group-readable by the pod's fsGroup but is mounted into the signer container only.
 */
export function readPrivateFile(file: string, what: string, allowGroupRead = false): string {
  const st = statSync(file);
  const mask = allowGroupRead ? 0o037 : 0o077;
  if (process.platform !== 'win32' && (st.mode & mask) !== 0) throw new Error(`${what} ${file} must not be readable by ${allowGroupRead ? 'others' : 'group or others'} (chmod 600).`);
  return readFileSync(file, 'utf8').trim();
}

/** Makes the socket's directory (0700, or 0750 for a group socket), or checks an existing one is not open to others. */
function prepareDirectory(dir: string, groupAccess: boolean): void {
  const want = groupAccess ? 0o750 : 0o700;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: want });
  if (process.platform === 'win32') return;
  const st = statSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`The socket directory ${dir} must belong to the signer's user.`);
  if ((st.mode & 0o002) !== 0 || (st.mode & 0o020) !== 0) throw new Error(`The socket directory ${dir} must not be writable by group or others.`);
  if ((st.mode & 0o007) !== 0) chmodSync(dir, st.mode & ~0o007 & 0o7777);
  if (!groupAccess && (st.mode & 0o070) !== 0) chmodSync(dir, 0o700);
}

/** True when something already answers on the socket path. */
function inUse(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = connect(socketPath);
    c.once('connect', () => {
      c.destroy();
      resolve(true);
    });
    c.once('error', () => resolve(false));
  });
}

const b64 = (v: unknown, what: string): Buffer => {
  if (typeof v !== 'string') throw new Error(`${what} is required`);
  return Buffer.from(v, 'base64');
};
const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v) throw new Error(`${what} is required`);
  return v;
};

export class SignerCore {
  private readonly kek: LocalKms;
  private readonly held: SecretBox;
  private readonly cache = new Map<string, KeyObject>();

  constructor(keyBase64: string) {
    this.kek = new LocalKms(keyBase64);
    const master = Buffer.from(keyBase64, 'base64');
    this.held = new SecretBox(Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'exprsn-signer:held-keys', 32)).toString('base64'));
  }

  private name(v: unknown): string {
    const n = str(v, 'name');
    if (!NAME_RE.test(n)) throw new Error('Invalid key name');
    return n;
  }

  private type(v: unknown): HeldKeyType {
    if (!HELD_TYPES.includes(v as HeldKeyType)) throw new Error('Unknown key type');
    return v as HeldKeyType;
  }

  /** Opens a wrapped key; it only opens under the name and type it was created for. */
  private open(name: string, type: HeldKeyType, wrapped: unknown): KeyObject {
    const w = str(wrapped, 'wrapped');
    const id = `${type}:${name}:${w}`;
    const hit = this.cache.get(id);
    if (hit) return hit;
    let der: Buffer;
    try {
      der = Buffer.from(this.held.open(w, `held:${type}:${name}`), 'base64');
    } catch {
      throw new Error('The wrapped key does not open under this name and type.');
    }
    const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    if (this.cache.size > 512) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(id, key);
    return key;
  }

  async handle(req: SignerRequest): Promise<Record<string, unknown>> {
    switch (req.op) {
      case 'health':
        return { ok: true, detail: 'signer holds the local key-encryption key' };
      case 'wrap':
        return { wrapped: await this.kek.wrap(this.name(req.name), b64(req.plaintext, 'plaintext'), str(req.aad, 'aad')) };
      case 'unwrap':
        return { plaintext: (await this.kek.unwrap(this.name(req.name), str(req.wrapped, 'wrapped'), str(req.aad, 'aad'))).toString('base64') };
      case 'hmac':
        if (typeof req.data !== 'string') throw new Error('data is required');
        return { mac: await this.kek.hmac(this.name(req.name), req.data) };
      case 'keygen': {
        const name = this.name(req.name);
        const type = this.type(req.type);
        const pair = type === 'ecdsa-p256' ? generateKeyPairSync('ec', { namedCurve: 'P-256' }) : type === 'ed25519' ? generateKeyPairSync('ed25519') : generateKeyPairSync('rsa', { modulusLength: 2048 });
        const der = pair.privateKey.export({ type: 'pkcs8', format: 'der' });
        const wrapped = this.held.seal(der.toString('base64'), `held:${type}:${name}`);
        let certificate: string | null = null;
        const c = req.certificate as { commonName?: unknown; organization?: unknown; days?: unknown } | undefined;
        if (c) {
          if (type !== 'rsa-2048' && type !== 'rsa-oaep-2048') throw new Error('Certificates are made for RSA keys only');
          const days = Number(c.days);
          if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('certificate.days must be 1 to 3650');
          certificate = selfSignedCertificate({ publicKey: pair.publicKey, privateKey: pair.privateKey, commonName: str(c.commonName, 'certificate.commonName').slice(0, 64), organization: str(c.organization, 'certificate.organization').slice(0, 64), days }).toString('base64');
        }
        return { publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), wrapped, certificate };
      }
      case 'sign': {
        const name = this.name(req.name);
        const type = this.type(req.type);
        if (type === 'rsa-oaep-2048') throw new Error('A decryption key does not sign');
        const data = b64(req.data, 'data');
        if (data.length > MAX_SIGN_BYTES) throw new Error('Too much data to sign');
        const key = this.open(name, type, req.wrapped);
        const sig = type === 'ecdsa-p256' ? cryptoSign('sha256', data, { key, dsaEncoding: 'ieee-p1363' }) : type === 'ed25519' ? cryptoSign(null, data, key) : cryptoSign('sha256', data, key);
        return { signature: sig.toString('base64') };
      }
      case 'decrypt': {
        const name = this.name(req.name);
        const key = this.open(name, 'rsa-oaep-2048', req.wrapped);
        const hash = req.oaepHash === 'sha1' || req.oaepHash === 'sha256' ? req.oaepHash : null;
        if (!hash) throw new Error('oaepHash must be sha1 or sha256');
        const ct = b64(req.ciphertext, 'ciphertext');
        if (ct.length > 1024) throw new Error('Ciphertext too long');
        return { plaintext: privateDecrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: hash }, ct).toString('base64') };
      }
      default:
        throw new Error('Unknown operation');
    }
  }
}

/** Starts the signer on `socketPath`. */
export async function startSigner(o: SignerOptions): Promise<RunningSigner> {
  if (o.token.length < 32) throw new Error('The signer token must be at least 32 characters.');
  const mode = o.socketMode ?? 0o600;
  if (mode !== 0o600 && mode !== 0o660) throw new Error('The socket mode must be 0600 or 0660.');
  const core = new SignerCore(o.key);
  const log = o.log ?? (() => undefined);
  const socketPath = path.resolve(o.socketPath);
  prepareDirectory(path.dirname(socketPath), mode === 0o660);
  if (existsSync(socketPath)) {
    if (!lstatSync(socketPath).isSocket()) throw new Error(`${socketPath} exists and is not a socket.`);
    if (await inUse(socketPath)) throw new Error(`A signer already answers on ${socketPath}.`);
    unlinkSync(socketPath);
  }
  const served: Record<string, number> = {};
  const sockets = new Set<Socket>();
  const server: Server = createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    const reader = new FrameReader();
    let authed = false;
    let chain = Promise.resolve();
    const reply = (r: SignerResponse) => {
      if (!sock.destroyed) sock.write(encodeFrame(r));
    };
    sock.on('error', () => sock.destroy());
    sock.on('data', (chunk: Buffer) => {
      let frames: unknown[];
      try {
        frames = reader.push(chunk);
      } catch {
        sock.destroy();
        return;
      }
      for (const f of frames) {
        const req = f as SignerRequest;
        const id = typeof req?.id === 'number' ? req.id : 0;
        if (!authed) {
          if (req?.op !== 'hello' || typeof req.token !== 'string' || !safeEqual(req.token, o.token)) {
            log('signer: refused a connection without the right token');
            reply({ id, ok: false, error: 'Not authorised' });
            sock.end();
            return;
          }
          authed = true;
          reply({ id, ok: true, result: { version: PROTOCOL_VERSION } });
          continue;
        }
        // Requests on one connection are answered in order.
        chain = chain.then(async () => {
          try {
            const result = await core.handle(req);
            served[req.op] = (served[req.op] ?? 0) + 1;
            reply({ id, ok: true, result });
          } catch (err) {
            reply({ id, ok: false, error: (err as Error).message.slice(0, 300) });
          }
        });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  if (process.platform !== 'win32') chmodSync(socketPath, mode);
  log(`signer: listening on ${socketPath}`);
  return {
    socketPath,
    served,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        unlinkSync(socketPath);
      } catch {
        /* already gone */
      }
    }
  };
}
