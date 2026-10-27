import { randomBytes } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, lstat, mkdir, open, readdir, realpath, rename, stat, statfs, unlink } from 'node:fs/promises';
import path from 'node:path';
import { cleanPath, LOCATION_LIMITS, RemoteError, type Connector, type ConnectorContext, type Listing, type LocalConfig, type ReadResult, type RemoteEntry } from '../model.js';

/*
 * A directory on this server as a linked location: a subdirectory of a root an operator offers under Storage › Local
 * stores (`ctx.localRoot`). Every path is resolved to its real path and must stay inside the location's base, so a
 * symbolic link cannot lead out of it; links that point outside are left out of listings and refused when named.
 * A write goes to a temporary file in the same directory, is synced, and then renamed over the target, so a reader
 * never sees half a file.
 */

const TEMP_PREFIX = '.exprsn-upload-';
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const inside = (base: string, p: string) => p === base || p.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
const code = (err: unknown) => (err as NodeJS.ErrnoException).code;

export class LocalConnector implements Connector {
  readonly kind = 'local' as const;
  readonly writable: boolean;
  private baseDir: string | null = null;

  constructor(
    private readonly config: LocalConfig,
    private readonly ctx: ConnectorContext,
    o: { readOnly?: boolean } = {}
  ) {
    this.writable = !o.readOnly && !ctx.localRoot?.readOnly;
  }

  /** The real path of the location's base: the operator's root and the location's subdirectory. */
  private async base(): Promise<string> {
    if (this.baseDir) return this.baseDir;
    const root = this.ctx.localRoot;
    if (!root) throw new RemoteError('This local store is not offered on this server any more. An operator offers local stores under Storage, Local stores.', 409);
    let rootReal: string;
    try {
      rootReal = await realpath(root.path);
    } catch {
      throw new RemoteError('The local store\'s directory does not exist on this server.', 409);
    }
    const sub = cleanPath(this.config.path ?? '');
    let real: string;
    try {
      real = await realpath(path.join(rootReal, sub));
    } catch {
      throw new RemoteError(`The directory ${sub || '/'} does not exist in the local store.`, 404);
    }
    if (!inside(rootReal, real)) throw new RemoteError('The directory leads outside the local store.', 403);
    this.baseDir = real;
    return real;
  }

  /** The real path of an existing entry inside the base. */
  private async resolve(rel: string): Promise<string> {
    const base = await this.base();
    const p = cleanPath(rel);
    let real: string;
    try {
      real = await realpath(path.join(base, p));
    } catch (err) {
      if (code(err) === 'ENOENT' || code(err) === 'ENOTDIR') throw new RemoteError(`Not found: ${p || '/'}.`, 404);
      throw new RemoteError(`${p || '/'} could not be read: ${(err as Error).message}`);
    }
    if (!inside(base, real)) throw new RemoteError(`${p} leads outside this location.`, 403);
    return real;
  }

  private entry(rel: string, st: { isDirectory(): boolean; size: number; mtimeMs: number }): RemoteEntry {
    const dir = st.isDirectory();
    return { path: rel, name: rel.split('/').pop() ?? rel, dir, size: dir ? null : st.size, modified: Math.round(st.mtimeMs) };
  }

  async test(): Promise<{ ok: true; detail: string }> {
    const base = await this.base();
    try {
      await access(base, constants.R_OK | (this.writable ? constants.W_OK : 0));
    } catch {
      throw new RemoteError(`The server cannot ${this.writable ? 'read and write' : 'read'} ${base}.`, 403);
    }
    let free = '';
    try {
      const fs = await statfs(base);
      free = `; ${(Number(fs.bavail) * Number(fs.bsize) / 1024 ** 3).toFixed(1)} GB free`;
    } catch {
      // statfs is not available everywhere
    }
    return { ok: true, detail: `${base} is ${this.writable ? 'readable and writable' : 'readable (read-only)'}${free}.` };
  }

  async list(dir: string, cursor?: string | null): Promise<Listing> {
    const d = cleanPath(dir);
    const real = await this.resolve(d);
    const base = await this.base();
    let names;
    try {
      names = await readdir(real, { withFileTypes: true });
    } catch (err) {
      if (code(err) === 'ENOTDIR') throw new RemoteError(`${d} is a file, not a folder.`, 409);
      throw new RemoteError(`${d || '/'} could not be listed: ${(err as Error).message}`);
    }
    const entries: RemoteEntry[] = [];
    for (const n of names) {
      if (CONTROL.test(n.name) || n.name.startsWith(TEMP_PREFIX)) continue;
      const rel = d ? `${d}/${n.name}` : n.name;
      const full = path.join(real, n.name);
      try {
        if (n.isSymbolicLink()) {
          const target = await realpath(full);
          if (!inside(base, target)) continue;
        } else if (!n.isFile() && !n.isDirectory()) continue;
        const st = await stat(full);
        if (!st.isFile() && !st.isDirectory()) continue;
        entries.push(this.entry(rel, st));
      } catch {
        // gone meanwhile, or a dangling link
      }
    }
    entries.sort((a, b) => (a.dir === b.dir ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.dir ? -1 : 1));
    const from = Math.max(0, Number(cursor) || 0);
    const to = from + LOCATION_LIMITS.pageSize;
    return { entries: entries.slice(from, to), next: to < entries.length ? String(to) : null };
  }

  async stat(p: string): Promise<RemoteEntry | null> {
    const rel = cleanPath(p);
    let real: string;
    try {
      real = await this.resolve(rel);
    } catch (err) {
      if (err instanceof RemoteError && err.status === 404) return null;
      throw err;
    }
    return this.entry(rel, await stat(real));
  }

  async read(p: string): Promise<ReadResult> {
    const rel = cleanPath(p);
    if (!rel) throw new RemoteError('Choose a file, not the root.', 400);
    const real = await this.resolve(rel);
    const st = await stat(real);
    if (!st.isFile()) throw new RemoteError(`${rel} is a folder, not a file.`, 409);
    return { stream: createReadStream(real) as AsyncIterable<Buffer>, size: st.size, type: null };
  }

  async write(p: string, data: AsyncIterable<Buffer>, size: number, _type: string | null): Promise<{ etag?: string | null; cid?: string | null }> {
    if (!this.writable) throw new RemoteError('This location is read-only.', 403);
    const rel = cleanPath(p);
    if (!rel) throw new RemoteError('Give the file a name.', 400);
    const name = rel.split('/').pop()!;
    if (CONTROL.test(name) || name.startsWith(TEMP_PREFIX)) throw new RemoteError(`Not a valid file name: ${name}`, 400);
    const parentRel = rel.split('/').slice(0, -1).join('/');
    const base = await this.base();
    // Missing folders are made, each checked to stay inside the base.
    let parent = base;
    for (const seg of parentRel ? parentRel.split('/') : []) {
      const next = path.join(parent, seg);
      try {
        await mkdir(next, { mode: 0o750 });
      } catch (err) {
        if (code(err) !== 'EEXIST') throw new RemoteError(`The folder ${seg} could not be made: ${(err as Error).message}`);
      }
      parent = await realpath(next);
      if (!inside(base, parent)) throw new RemoteError(`${parentRel} leads outside this location.`, 403);
      if (!(await stat(parent)).isDirectory()) throw new RemoteError(`${seg} is a file, not a folder.`, 409);
    }
    const target = path.join(parent, name);
    try {
      const l = await lstat(target);
      if (l.isSymbolicLink()) throw new RemoteError(`${rel} is a symbolic link; it is not written through.`, 409);
      if (l.isDirectory()) throw new RemoteError(`${rel} is a folder.`, 409);
    } catch (err) {
      if (err instanceof RemoteError) throw err;
      if (code(err) !== 'ENOENT') throw new RemoteError(`${rel} could not be checked: ${(err as Error).message}`);
    }
    const temp = path.join(parent, `${TEMP_PREFIX}${randomBytes(8).toString('hex')}`);
    const fh = await open(temp, 'wx', 0o640);
    let written = 0;
    try {
      for await (const c of data) {
        const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
        written += b.length;
        if (written > size) throw new RemoteError(`More than the ${size} bytes announced arrived.`, 400);
        await fh.write(b);
      }
      if (written !== size) throw new RemoteError(`${written} bytes arrived of the ${size} announced.`, 400);
      await fh.sync();
      await fh.close();
      await rename(temp, target);
    } catch (err) {
      await fh.close().catch(() => undefined);
      await unlink(temp).catch(() => undefined);
      throw err instanceof RemoteError ? err : new RemoteError(`${rel} could not be written: ${(err as Error).message}`);
    }
    return { etag: null };
  }

  async close(): Promise<void> {
    // nothing held open
  }
}
