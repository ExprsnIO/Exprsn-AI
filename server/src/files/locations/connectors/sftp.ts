import { createHash, randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Client, type ConnectConfig, type FileEntryWithStats, type SFTPWrapper, type Stats } from 'ssh2';
import { cleanPath, LOCATION_LIMITS, RemoteError, type Connector, type ConnectorContext, type Listing, type ReadResult, type RemoteEntry, type SftpConfig, type SftpSecret } from '../model.js';
import { resolveChecked } from '../net.js';

/*
 * An SFTP server as a linked location (ssh2). The connection dials the address `resolveChecked` approved, never the
 * name. The server's host key is pinned: the fingerprint (`SHA256:…`, as OpenSSH prints it) must match the one stored
 * with the location; a location without one accepts the first key it sees and exposes it as `hostKey`, which the
 * service stores (trust on first use). SHA-1 host key signatures (ssh-rsa) and DSA keys are refused.
 *
 * Paths are below the location's root; `cleanPath` already refuses `..`, so a joined path cannot leave the root by
 * name. A symbolic link on the server may still point elsewhere: what the account can read is the server's to limit.
 */

/** The OpenSSH fingerprint of a public key blob. */
export const sshFingerprint = (key: Buffer): string => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;

const isDir = (a: Stats): boolean => (typeof a.isDirectory === 'function' ? a.isDirectory() : (a.mode & S_IFMT) === S_IFDIR);

const fail = (err: unknown, what: string): RemoteError => {
  if (err instanceof RemoteError) return err;
  const e = err as { code?: number | string; message?: string };
  if (e.code === 2) return new RemoteError(`${what}: not found.`, 404);
  if (e.code === 3) return new RemoteError(`${what}: permission denied.`, 403);
  return new RemoteError(`${what}: ${e.message ?? String(err)}`);
};

export class SftpConnector implements Connector {
  readonly kind = 'sftp' as const;
  readonly writable: boolean;
  /** The fingerprint of the server's host key, once connected. */
  hostKey: string | null = null;
  private conn: Promise<{ client: Client; sftp: SFTPWrapper }> | null = null;

  constructor(
    private readonly config: SftpConfig,
    private readonly secret: SftpSecret,
    private readonly ctx: ConnectorContext,
    o: { readOnly?: boolean } = {}
  ) {
    this.writable = !o.readOnly;
  }

  /** The login folder, read once connected; the root when the location names none. */
  private home: string | null = null;

  private root(): string {
    if (!this.config.root) {
      if (this.home == null) throw new RemoteError('Not connected yet.');
      return this.home;
    }
    const r = posix.normalize(`/${this.config.root}`).replace(/\/+$/, '');
    return r || '/';
  }

  private full(path: string): string {
    const root = this.root();
    const p = cleanPath(path);
    const joined = p ? posix.join(root, p) : root;
    if (joined !== root && !joined.startsWith(root === '/' ? '/' : `${root}/`)) throw new RemoteError('The path leaves the location.', 400);
    return joined;
  }

  private open(): Promise<{ client: Client; sftp: SFTPWrapper }> {
    this.conn ??= (async () => {
      const { address } = await resolveChecked(this.config.host, this.ctx.check);
      const client = new Client();
      let refused: RemoteError | null = null;
      const cfg: ConnectConfig = {
        host: address,
        port: this.config.port || 22,
        username: this.config.username,
        readyTimeout: this.ctx.timeoutMs,
        algorithms: { serverHostKey: { remove: ['ssh-rsa', 'ssh-dss'] } } as unknown as ConnectConfig['algorithms'],
        hostVerifier: ((key: Buffer) => {
          const fp = sshFingerprint(key);
          this.hostKey = fp;
          if (this.config.hostKey && this.config.hostKey !== fp) {
            refused = new RemoteError(`The server's host key changed: it is ${fp}, the location expects ${this.config.hostKey}. If the server was rebuilt, test the location and save the new key.`, 403);
            return false;
          }
          return true;
        }) as ConnectConfig['hostVerifier'],
        ...('password' in this.secret ? { password: this.secret.password } : { privateKey: this.secret.privateKey, ...(this.secret.passphrase ? { passphrase: this.secret.passphrase } : {}) })
      };
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          client.end();
          reject(new RemoteError('Cancelled.'));
        };
        this.ctx.signal?.addEventListener('abort', onAbort, { once: true });
        client.once('ready', () => resolve());
        client.once('error', (err: Error & { level?: string }) => {
          this.ctx.signal?.removeEventListener('abort', onAbort);
          if (refused) return reject(refused);
          if (err.level === 'client-authentication') return reject(new RemoteError('The SFTP server refused the user name or the key or password.', 403));
          reject(new RemoteError(`SFTP connection to ${this.config.host}: ${err.message}`));
        });
        client.connect(cfg);
      });
      const sftp = await new Promise<SFTPWrapper>((resolve, reject) => client.sftp((err, s) => (err ? reject(fail(err, 'SFTP')) : resolve(s))));
      this.home ??= posix.normalize(await new Promise<string>((resolve) => sftp.realpath('.', (err, p) => resolve(err ? '/' : p))));
      return { client, sftp };
    })();
    this.conn.catch(() => {
      this.conn = null;
    });
    return this.conn;
  }

  private async call<T>(fn: (sftp: SFTPWrapper, cb: (err: Error | null | undefined, v?: T) => void) => void, what: string): Promise<T> {
    const { sftp } = await this.open();
    return new Promise<T>((resolve, reject) => fn(sftp, (err, v) => (err ? reject(fail(err, what)) : resolve(v as T))));
  }

  async test(): Promise<{ ok: true; detail: string }> {
    await this.open();
    const root = this.root();
    const real = await this.call<string>((s, cb) => s.realpath(root, cb), root);
    const list = await this.call<FileEntryWithStats[]>((s, cb) => s.readdir(root, cb), root);
    return { ok: true, detail: `Connected to ${this.config.host} as ${this.config.username}; ${real} holds ${list.length} entr${list.length === 1 ? 'y' : 'ies'}. Host key ${this.hostKey ?? 'unknown'}.` };
  }

  private entry(dirRel: string, name: string, a: Stats): RemoteEntry {
    return { path: dirRel ? `${dirRel}/${name}` : name, name, dir: isDir(a), size: isDir(a) ? null : Number(a.size ?? 0), modified: a.mtime ? Number(a.mtime) * 1000 : null };
  }

  async list(dir: string, cursor?: string | null): Promise<Listing> {
    await this.open();
    const rel = cleanPath(dir);
    const all = (await this.call<FileEntryWithStats[]>((s, cb) => s.readdir(this.full(rel), cb), rel || '/'))
      .filter((e) => e.filename !== '.' && e.filename !== '..')
      .map((e) => this.entry(rel, e.filename, e.attrs))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    const from = Math.max(0, Number(cursor ?? 0) || 0);
    const to = from + LOCATION_LIMITS.pageSize;
    return { entries: all.slice(from, to), next: to < all.length ? String(to) : null };
  }

  async stat(path: string): Promise<RemoteEntry | null> {
    await this.open();
    const rel = cleanPath(path);
    try {
      const a = await this.call<Stats>((s, cb) => s.stat(this.full(rel), cb), rel);
      const name = rel.split('/').pop() ?? '';
      const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      return this.entry(parent, name, a);
    } catch (err) {
      if (err instanceof RemoteError && err.status === 404) return null;
      throw err;
    }
  }

  async read(path: string): Promise<ReadResult> {
    await this.open();
    const rel = cleanPath(path);
    const st = await this.stat(rel);
    if (!st) throw new RemoteError(`${rel}: not found.`, 404);
    if (st.dir) throw new RemoteError(`${rel} is a folder.`, 400);
    const { sftp } = await this.open();
    const stream = sftp.createReadStream(this.full(rel)) as unknown as AsyncIterable<Buffer>;
    return { stream, size: st.size, type: null };
  }

  async write(path: string, data: AsyncIterable<Buffer>, _size: number, _type: string | null): Promise<{ etag?: string | null; cid?: string | null }> {
    if (!this.writable) throw new RemoteError('This location is read-only.', 403);
    const rel = cleanPath(path);
    if (!rel) throw new RemoteError('Give a file name.', 400);
    const { sftp } = await this.open();
    const target = this.full(rel);
    const tmp = `${target}.exprsn-part-${randomBytes(6).toString('hex')}`;
    // Missing folders below the root are made, one level at a time (the root itself must exist).
    const parts = rel.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const dir = this.full(parts.slice(0, i).join('/'));
      const exists = await this.call((s, cb) => s.stat(dir, cb), dir).then(() => true, () => false);
      if (!exists) await this.call((s, cb) => s.mkdir(dir, cb), dir);
    }
    try {
      await pipeline(Readable.from(data), sftp.createWriteStream(tmp) as unknown as NodeJS.WritableStream);
    } catch (err) {
      await this.call((s, cb) => s.unlink(tmp, cb), tmp).catch(() => undefined);
      throw fail(err, rel);
    }
    const posixRename = (sftp as unknown as { ext_openssh_rename?: (a: string, b: string, cb: (err?: Error | null) => void) => void }).ext_openssh_rename;
    try {
      if (posixRename) await new Promise<void>((res, rej) => posixRename.call(sftp, tmp, target, (err) => (err ? rej(err) : res())));
      else throw new Error('no posix-rename');
    } catch {
      await this.call((s, cb) => s.unlink(target, cb), rel).catch(() => undefined);
      try {
        await this.call((s, cb) => s.rename(tmp, target, cb), rel);
      } catch (err) {
        await this.call((s, cb) => s.unlink(tmp, cb), tmp).catch(() => undefined);
        throw err;
      }
    }
    return { etag: null };
  }

  async close(): Promise<void> {
    const c = this.conn;
    this.conn = null;
    if (!c) return;
    try {
      (await c).client.end();
    } catch {
      // never connected
    }
  }
}
