import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { Client, FTPError, type FileInfo } from 'basic-ftp';
import { isPublicAddress } from '../../../platform/egress.js';
import { cleanPath, LOCATION_LIMITS, RemoteError, type Connector, type ConnectorContext, type FtpConfig, type FtpSecret, type Listing, type ReadResult, type RemoteEntry } from '../model.js';
import { resolveChecked } from '../net.js';

/*
 * An FTP or FTPS server as a linked location (basic-ftp). The control connection dials the address `resolveChecked`
 * approved; TLS checks the certificate against the host name (`servername`). Transfers are passive only, and the data
 * connection goes to the control connection's address: EPSV gives only a port, and PASV is refused when it names
 * another host (basic-ftp's default without `allowSeparateTransferHost`), so the server cannot send the client to an
 * address that was not checked (no FTP bounce). Plain FTP sends the password in the clear, so it is allowed only to
 * an internal address.
 *
 * One control connection serves one operation at a time; operations are queued, and a read holds the connection
 * until its stream has been read to the end.
 */

/** Why plain FTP may not be used to this address, or null. */
export function plainFtpProblem(address: string): string | null {
  return isPublicAddress(address.replace(/^::ffff:/i, '')) ? 'Plain FTP sends the password in the clear; use FTPS for a public server.' : null;
}

const fail = (err: unknown, what: string): RemoteError => {
  if (err instanceof RemoteError) return err;
  if (err instanceof FTPError) {
    if (err.code === 550) return new RemoteError(`${what}: not found or not allowed.`, 404);
    if (err.code === 530) return new RemoteError('The FTP server refused the user name or password.', 403);
    return new RemoteError(`${what}: ${err.code} ${err.message}`);
  }
  return new RemoteError(`${what}: ${(err as Error).message ?? String(err)}`);
};

export class FtpConnector implements Connector {
  readonly kind = 'ftp' as const;
  readonly writable: boolean;
  private client: Client | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: FtpConfig,
    private readonly secret: FtpSecret,
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
    const p = cleanPath(path);
    return p ? posix.join(this.root(), p) : this.root();
  }

  private async connect(): Promise<Client> {
    if (this.client && !this.client.closed) return this.client;
    const { address } = await resolveChecked(this.config.host, this.ctx.check);
    if (this.config.tls === 'none') {
      const problem = plainFtpProblem(address);
      if (problem) throw new RemoteError(problem, 403);
    }
    const client = new Client(this.ctx.timeoutMs, { allowSeparateTransferHost: false });
    try {
      await client.access({
        host: address,
        port: this.config.port || (this.config.tls === 'implicit' ? 990 : 21),
        user: this.config.username,
        password: this.secret.password,
        secure: this.config.tls === 'none' ? false : this.config.tls === 'implicit' ? 'implicit' : true,
        secureOptions: { servername: this.config.host, minVersion: 'TLSv1.2' }
      });
    } catch (err) {
      client.close();
      throw fail(err, `FTP connection to ${this.config.host}`);
    }
    this.home ??= posix.normalize(await client.pwd().catch(() => '/'));
    this.client = client;
    return client;
  }

  /** Runs one operation on the control connection after the ones before it. */
  private run<T>(fn: (c: Client) => Promise<T>, what: string): Promise<T> {
    const next = this.queue.then(async () => {
      try {
        return await fn(await this.connect());
      } catch (err) {
        throw fail(err, what);
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  async test(): Promise<{ ok: true; detail: string }> {
    return this.run(async (c) => {
      const pwd = await c.pwd();
      const list = await c.list(this.root());
      return { ok: true as const, detail: `Connected to ${this.config.host} as ${this.config.username}${this.config.tls === 'none' ? ' (plain FTP)' : ' over TLS'}; working directory ${pwd}; ${this.root()} holds ${list.length} entr${list.length === 1 ? 'y' : 'ies'}.` };
    }, 'FTP');
  }

  private entry(dirRel: string, f: FileInfo): RemoteEntry {
    return { path: dirRel ? `${dirRel}/${f.name}` : f.name, name: f.name, dir: f.isDirectory, size: f.isDirectory ? null : f.size, modified: f.modifiedAt ? f.modifiedAt.getTime() : null };
  }

  async list(dir: string, cursor?: string | null): Promise<Listing> {
    const rel = cleanPath(dir);
    const all = (await this.run((c) => c.list(this.full(rel)), rel || '/'))
      .filter((f) => f.name !== '.' && f.name !== '..')
      .map((f) => this.entry(rel, f))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    const from = Math.max(0, Number(cursor ?? 0) || 0);
    const to = from + LOCATION_LIMITS.pageSize;
    return { entries: all.slice(from, to), next: to < all.length ? String(to) : null };
  }

  async stat(path: string): Promise<RemoteEntry | null> {
    const rel = cleanPath(path);
    if (!rel) return { path: '', name: '', dir: true, size: null, modified: null };
    const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const name = rel.split('/').pop()!;
    try {
      const list = await this.run((c) => c.list(this.full(parent)), parent || '/');
      const hit = list.find((f) => f.name === name);
      return hit ? this.entry(parent, hit) : null;
    } catch (err) {
      if (err instanceof RemoteError && err.status === 404) return null;
      throw err;
    }
  }

  async read(path: string): Promise<ReadResult> {
    const rel = cleanPath(path);
    const st = await this.stat(rel);
    if (!st) throw new RemoteError(`${rel}: not found.`, 404);
    if (st.dir) throw new RemoteError(`${rel} is a folder.`, 400);
    const out = new PassThrough();
    // The download holds the queue until the reader has taken every byte (or the stream is destroyed).
    void this.run((c) => c.downloadTo(out, this.full(rel)), rel).then(
      () => out.end(),
      (err: Error) => out.destroy(err)
    );
    return { stream: out, size: st.size, type: null };
  }

  async write(path: string, data: AsyncIterable<Buffer>, _size: number, _type: string | null): Promise<{ etag?: string | null; cid?: string | null }> {
    if (!this.writable) throw new RemoteError('This location is read-only.', 403);
    const rel = cleanPath(path);
    if (!rel) throw new RemoteError('Give a file name.', 400);
    await this.run(async (c) => {
      const target = this.full(rel);
      const tmp = `${target}.exprsn-part-${randomBytes(6).toString('hex')}`;
      try {
        // Missing folders below the root are made (ensureDir also moves into the folder; paths here are absolute).
        if (rel.includes('/')) await c.ensureDir(posix.dirname(target));
        await c.uploadFrom(Readable.from(data), tmp);
        await c.remove(target, true);
        await c.rename(tmp, target);
      } catch (err) {
        await c.remove(tmp, true).catch(() => undefined);
        throw err;
      }
    }, rel);
    return { etag: null };
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    await this.queue.catch(() => undefined);
    c?.close();
  }
}
