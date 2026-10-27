import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, openSync, readSync, writeSync, closeSync, fstatSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Server as SshServer, utils as sshUtils, type Connection } from 'ssh2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FtpConnector, plainFtpProblem } from '../src/files/locations/connectors/ftp.js';
import { IpfsConnector } from '../src/files/locations/connectors/ipfs.js';
import { SftpConnector, sshFingerprint } from '../src/files/locations/connectors/sftp.js';
import { RemoteError, type AddressCheck, type ConnectorContext } from '../src/files/locations/model.js';

/*
 * 2.0.0, linked locations: the SFTP, FTP and IPFS connectors against in-process servers (an ssh2 SFTP server on a
 * temporary directory, a small FTP server, a fake Kubo RPC API and gateway).
 */

const allow: AddressCheck = () => null;
const refuse: AddressCheck = (a) => `${a} is refused by the test.`;
const ctx = (check: AddressCheck = allow): ConnectorContext => ({ check, timeoutMs: 5_000 });

async function collect(s: AsyncIterable<Buffer>): Promise<string> {
  const parts: Buffer[] = [];
  for await (const c of s) parts.push(Buffer.from(c));
  return Buffer.concat(parts).toString('utf8');
}
const chunks = (text: string) => (async function* () { yield Buffer.from(text); })();

// ---------- an SFTP server on a temporary directory ----------

const { STATUS_CODE, OPEN_MODE } = sshUtils.sftp;

function sftpServer(dir: string, hostKey: string, password: string): { server: SshServer; connections: () => number } {
  let connections = 0;
  const server = new SshServer({ hostKeys: [hostKey] }, (client: Connection) => {
    connections++;
    // A client that drops the handshake (a refused host key) ends the connection with an error here.
    client.on('error', () => undefined);
    client.on('authentication', (c) => (c.method === 'password' && c.username === 'ann' && c.password === password ? c.accept() : c.reject(['password'])));
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          const handles = new Map<number, { fd?: number; dir?: string; done?: boolean }>();
          let next = 0;
          const real = (p: string) => path.join(dir, path.posix.normalize(p).replace(/^\/+/, ''));
          const handle = (h: Buffer) => h.readUInt32BE(0);
          const newHandle = (v: { fd?: number; dir?: string }) => {
            const b = Buffer.alloc(4);
            b.writeUInt32BE(next);
            handles.set(next++, v);
            return b;
          };
          const attrs = (st: Stats) => ({ mode: st.mode, uid: 0, gid: 0, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) });
          const guard = (reqid: number, fn: () => void) => {
            try {
              fn();
            } catch (err) {
              sftp.status(reqid, (err as NodeJS.ErrnoException).code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE);
            }
          };
          sftp.on('REALPATH', (reqid, p) => sftp.name(reqid, [{ filename: path.posix.normalize(p.startsWith('/') ? p : `/${p}`), longname: '', attrs: {} as never }]));
          sftp.on('STAT', (reqid, p) => guard(reqid, () => sftp.attrs(reqid, attrs(statSync(real(p))))));
          sftp.on('LSTAT', (reqid, p) => guard(reqid, () => sftp.attrs(reqid, attrs(statSync(real(p))))));
          sftp.on('OPENDIR', (reqid, p) => guard(reqid, () => (statSync(real(p)).isDirectory() ? sftp.handle(reqid, newHandle({ dir: real(p) })) : sftp.status(reqid, STATUS_CODE.FAILURE))));
          sftp.on('READDIR', (reqid, h) => {
            const x = handles.get(handle(h));
            if (!x?.dir || x.done) return sftp.status(reqid, STATUS_CODE.EOF);
            x.done = true;
            sftp.name(reqid, readdirSync(x.dir).map((n) => ({ filename: n, longname: n, attrs: attrs(statSync(path.join(x.dir!, n))) as never })));
          });
          sftp.on('OPEN', (reqid, p, flags) => guard(reqid, () => sftp.handle(reqid, newHandle({ fd: openSync(real(p), flags & OPEN_MODE.WRITE ? 'w' : 'r') }))));
          sftp.on('READ', (reqid, h, offset, length) => {
            const x = handles.get(handle(h))!;
            const buf = Buffer.alloc(length);
            const n = readSync(x.fd!, buf, 0, length, offset);
            if (!n) return sftp.status(reqid, STATUS_CODE.EOF);
            sftp.data(reqid, buf.subarray(0, n));
          });
          sftp.on('WRITE', (reqid, h, offset, data) => {
            writeSync(handles.get(handle(h))!.fd!, data, 0, data.length, offset);
            sftp.status(reqid, STATUS_CODE.OK);
          });
          sftp.on('FSTAT', (reqid, h) => sftp.attrs(reqid, attrs(fstatSync(handles.get(handle(h))!.fd!))));
          sftp.on('CLOSE', (reqid, h) => {
            const x = handles.get(handle(h));
            if (x?.fd != null) closeSync(x.fd);
            handles.delete(handle(h));
            sftp.status(reqid, STATUS_CODE.OK);
          });
          sftp.on('RENAME', (reqid, a, b) => guard(reqid, () => (renameSync(real(a), real(b)), sftp.status(reqid, STATUS_CODE.OK))));
          sftp.on('REMOVE', (reqid, p) => guard(reqid, () => (unlinkSync(real(p)), sftp.status(reqid, STATUS_CODE.OK))));
        });
      });
    });
  });
  return { server, connections: () => connections };
}

describe('SFTP connector', () => {
  let dir: string;
  let srv: ReturnType<typeof sftpServer>;
  let port: number;
  const key = sshUtils.generateKeyPairSync('ed25519');
  const fp = sshFingerprint(sshUtils.parseKey(key.public) instanceof Error ? Buffer.alloc(0) : (sshUtils.parseKey(key.public) as { getPublicSSH(): Buffer }).getPublicSSH());

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'exprsn-sftp-'));
    mkdirSync(path.join(dir, 'data', 'reports'), { recursive: true });
    writeFileSync(path.join(dir, 'data', 'a.txt'), 'alpha');
    writeFileSync(path.join(dir, 'data', 'reports', 'q3.csv'), 'x,y\n1,2\n');
    srv = sftpServer(dir, key.private, 'secret');
    await new Promise<void>((r) => srv.server.listen(0, '127.0.0.1', () => r()));
    port = (srv.server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await new Promise<void>((r) => srv.server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  const cfg = (o: Partial<{ hostKey: string | null; root: string }> = {}) => ({ host: '127.0.0.1', port, username: 'ann', root: o.root ?? '/data', hostKey: o.hostKey ?? null });

  it('lists, stats, reads and writes below its root, learning the host key on first use', async () => {
    const c = new SftpConnector(cfg(), { password: 'secret' }, ctx());
    try {
      const t = await c.test();
      expect(t.detail).toContain(fp);
      expect(c.hostKey).toBe(fp);
      const l = await c.list('');
      expect(l.entries.map((e) => [e.name, e.dir])).toEqual([['reports', true], ['a.txt', false]]);
      expect((await c.list('reports')).entries[0]).toMatchObject({ path: 'reports/q3.csv', size: 8, dir: false });
      expect(await c.stat('a.txt')).toMatchObject({ size: 5, dir: false });
      expect(await c.stat('missing.txt')).toBeNull();
      expect(await collect((await c.read('reports/q3.csv')).stream)).toBe('x,y\n1,2\n');
      await c.write('reports/new.md', chunks('# New\n'), 6, 'text/markdown');
      expect(readFileSync(path.join(dir, 'data', 'reports', 'new.md'), 'utf8')).toBe('# New\n');
      await c.write('a.txt', chunks('replaced'), 8, null);
      expect(readFileSync(path.join(dir, 'data', 'a.txt'), 'utf8')).toBe('replaced');
      expect(readdirSync(path.join(dir, 'data')).some((n) => n.includes('exprsn-part'))).toBe(false);
      await expect(c.list('../etc')).rejects.toThrow(/valid path/);
    } finally {
      await c.close();
    }
  });

  it('refuses a changed host key, a wrong password, a read-only write and a refused address', async () => {
    const pinned = new SftpConnector(cfg({ hostKey: 'SHA256:not-the-key' }), { password: 'secret' }, ctx());
    await expect(pinned.test()).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/host key changed/) });
    await pinned.close();
    const ok = new SftpConnector(cfg({ hostKey: fp }), { password: 'secret' }, ctx(), { readOnly: true });
    await ok.test();
    await expect(ok.write('x.txt', chunks('x'), 1, null)).rejects.toMatchObject({ status: 403 });
    await ok.close();
    const bad = new SftpConnector(cfg(), { password: 'wrong' }, ctx());
    await expect(bad.test()).rejects.toMatchObject({ status: 403 });
    await bad.close();
    const before = srv.connections();
    const blocked = new SftpConnector(cfg(), { password: 'secret' }, ctx(refuse));
    await expect(blocked.test()).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/refused by the test/) });
    expect(srv.connections()).toBe(before);
  });
});

// ---------- a small FTP server ----------

function ftpServer(dir: string): { server: TcpServer; connections: () => number } {
  let connections = 0;
  const server = createTcpServer((sock: Socket) => {
    connections++;
    let cwd = '/';
    let user = '';
    let renameFrom: string | null = null;
    let data: Promise<Socket> | null = null;
    let dataServer: TcpServer | null = null;
    const reply = (line: string) => sock.write(`${line}\r\n`);
    const real = (p: string) => path.join(dir, path.posix.resolve(cwd, p || '.').replace(/^\/+/, ''));
    const openData = (): Promise<string> =>
      new Promise((resolve) => {
        dataServer?.close();
        const ds = createTcpServer();
        dataServer = ds;
        data = new Promise<Socket>((res) => ds.once('connection', (s) => res(s)));
        ds.listen(0, '127.0.0.1', () => resolve(String((ds.address() as AddressInfo).port)));
      });
    const send = async (payload: Buffer | string) => {
      const s = await data!;
      reply('150 Opening data connection');
      s.end(payload, () => reply('226 Transfer complete'));
    };
    const ls = (st: Stats, name: string) => `${st.isDirectory() ? 'd' : '-'}rw-r--r-- 1 owner group ${st.size} Jan 02 03:04 ${name}`;
    reply('220 fake ftp');
    let buf = '';
    sock.on('data', async (chunk) => {
      buf += chunk.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const [cmd, ...rest] = line.split(' ');
        const arg = rest.join(' ');
        try {
          switch (cmd!.toUpperCase()) {
            case 'USER': user = arg; reply('331 Password required'); break;
            case 'PASS': reply(user === 'ann' && arg === 'secret' ? '230 Logged in' : '530 Login incorrect'); break;
            case 'FEAT': reply('211 End'); break;
            case 'TYPE': case 'STRU': case 'OPTS': reply('200 OK'); break;
            case 'PWD': reply(`257 "${cwd}"`); break;
            case 'CWD': cwd = path.posix.resolve(cwd, arg); reply('250 OK'); break;
            case 'EPSV': reply(`229 Entering Extended Passive Mode (|||${await openData()}|)`); break;
            case 'PASV': { const p = Number(await openData()); reply(`227 Entering Passive Mode (127,0,0,1,${p >> 8},${p & 255})`); break; }
            case 'LIST': {
              const target = real(arg.replace(/^-a\s*/, '').trim());
              const st = statSync(target);
              const lines = st.isDirectory() ? readdirSync(target).map((n) => ls(statSync(path.join(target, n)), n)) : [ls(st, path.basename(target))];
              await send(lines.join('\r\n') + (lines.length ? '\r\n' : ''));
              break;
            }
            case 'RETR': await send(readFileSync(real(arg))); break;
            case 'STOR': {
              const s = await data!;
              reply('150 Ok to send data');
              const parts: Buffer[] = [];
              s.on('data', (c: Buffer) => parts.push(c));
              s.on('end', () => {
                writeFileSync(real(arg), Buffer.concat(parts));
                reply('226 Transfer complete');
              });
              break;
            }
            case 'SIZE': reply(`213 ${statSync(real(arg)).size}`); break;
            case 'MDTM': reply('213 20260102030400'); break;
            case 'DELE': unlinkSync(real(arg)); reply('250 Deleted'); break;
            case 'RNFR': statSync(real(arg)); renameFrom = real(arg); reply('350 Ready'); break;
            case 'RNTO': renameSync(renameFrom!, real(arg)); renameFrom = null; reply('250 Renamed'); break;
            case 'QUIT': reply('221 Bye'); sock.end(); break;
            default: reply('502 Not implemented');
          }
        } catch {
          reply('550 Failed');
        }
      }
    });
    sock.on('close', () => dataServer?.close());
    sock.on('error', () => undefined);
  });
  return { server, connections: () => connections };
}

describe('FTP connector', () => {
  let dir: string;
  let srv: ReturnType<typeof ftpServer>;
  let port: number;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'exprsn-ftp-'));
    mkdirSync(path.join(dir, 'pub', 'docs'), { recursive: true });
    writeFileSync(path.join(dir, 'pub', 'readme.txt'), 'hello ftp');
    srv = ftpServer(dir);
    await new Promise<void>((r) => srv.server.listen(0, '127.0.0.1', () => r()));
    port = (srv.server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await new Promise<void>((r) => srv.server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  const cfg = { host: '127.0.0.1', port: 0, username: 'ann', root: '/pub', tls: 'none' as const };

  it('lists, reads and writes over plain FTP to an internal address', async () => {
    const c = new FtpConnector({ ...cfg, port }, { password: 'secret' }, ctx());
    try {
      expect((await c.test()).detail).toMatch(/plain FTP/);
      const l = await c.list('');
      expect(l.entries.map((e) => [e.name, e.dir])).toEqual([['docs', true], ['readme.txt', false]]);
      expect(await c.stat('readme.txt')).toMatchObject({ size: 9, dir: false });
      expect(await c.stat('nope.txt')).toBeNull();
      expect(await collect((await c.read('readme.txt')).stream)).toBe('hello ftp');
      await c.write('docs/out.csv', chunks('a,b\n'), 4, 'text/csv');
      expect(readFileSync(path.join(dir, 'pub', 'docs', 'out.csv'), 'utf8')).toBe('a,b\n');
      expect(readdirSync(path.join(dir, 'pub', 'docs'))).toEqual(['out.csv']);
    } finally {
      await c.close();
    }
  });

  it('refuses plain FTP to a public address, a wrong password and a refused address', async () => {
    expect(plainFtpProblem('8.8.8.8')).toMatch(/FTPS/);
    expect(plainFtpProblem('127.0.0.1')).toBeNull();
    expect(plainFtpProblem('10.1.2.3')).toBeNull();
    const bad = new FtpConnector({ ...cfg, port }, { password: 'nope' }, ctx());
    await expect(bad.test()).rejects.toMatchObject({ status: 403 });
    await bad.close();
    const before = srv.connections();
    const blocked = new FtpConnector({ ...cfg, port }, { password: 'secret' }, ctx(refuse));
    await expect(blocked.test()).rejects.toBeInstanceOf(RemoteError);
    expect(srv.connections()).toBe(before);
  });
});

// ---------- a fake Kubo RPC API and gateway ----------

const CID_DIR = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const CID_FILE = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';

function kubo(): { server: HttpServer; added: string[]; hits: () => number } {
  const added: string[] = [];
  let hits = 0;
  const files: Record<string, string> = { [`/ipfs/${CID_DIR}/notes.md`]: '# Notes\n', [`/ipfs/${CID_FILE}`]: 'raw bytes' };
  const server = createHttpServer((req, res) => {
    hits++;
    const u = new URL(req.url!, 'http://x');
    const arg = u.searchParams.get('arg') ?? '';
    const json = (o: unknown, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (u.pathname.startsWith('/api/v0/') && req.method !== 'POST') return json({ Message: 'POST only' }, 405);
    switch (u.pathname) {
      case '/api/v0/version': return json({ Version: '0.32.1' });
      case '/api/v0/id': return json({ ID: '12D3KooWFake' });
      case '/api/v0/ls':
        if (arg !== `/ipfs/${CID_DIR}`) return json({ Message: 'no link named' }, 500);
        return json({ Objects: [{ Hash: CID_DIR, Links: [{ Name: 'notes.md', Hash: CID_FILE, Size: 8, Type: 2 }, { Name: 'img', Hash: CID_DIR, Size: 0, Type: 1 }] }] });
      case '/api/v0/files/stat':
        if (files[arg] == null) return json({ Message: 'not found' }, 500);
        return json({ Hash: CID_FILE, Size: files[arg]!.length, Type: 'file' });
      case '/api/v0/cat':
        if (files[arg] == null) return json({ Message: 'no link named' }, 500);
        res.writeHead(200, { 'content-type': 'text/plain', 'x-content-length': String(files[arg]!.length) });
        return res.end(files[arg]);
      case '/api/v0/add': {
        const parts: Buffer[] = [];
        req.on('data', (c: Buffer) => parts.push(c));
        req.on('end', () => {
          const body = Buffer.concat(parts).toString('utf8');
          added.push(body);
          const content = body.split('\r\n\r\n')[1]!.split('\r\n--')[0]!;
          const hash = 'bafkrei' + createHash('sha256').update(content).digest('hex').slice(0, 52);
          json({ Name: 'f', Hash: hash, Size: String(content.length) });
        });
        return;
      }
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const p = decodeURIComponent(u.pathname);
      if (p === `/ipfs/${CID_DIR}` && req.headers.accept === 'application/vnd.ipld.dag-json') {
        res.writeHead(200, { 'content-type': 'application/vnd.ipld.dag-json' });
        return res.end(JSON.stringify({ Links: [{ Name: 'notes.md', Hash: { '/': CID_FILE }, Tsize: 8 }] }));
      }
      if (files[p] != null) {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(files[p]!.length) });
        return res.end(req.method === 'HEAD' ? undefined : files[p]);
      }
    }
    res.writeHead(404);
    res.end();
  });
  return { server, added, hits: () => hits };
}

describe('IPFS connector', () => {
  let k: ReturnType<typeof kubo>;
  let endpoint: string;
  beforeEach(async () => {
    k = kubo();
    await new Promise<void>((r) => k.server.listen(0, '127.0.0.1', () => r()));
    endpoint = `http://127.0.0.1:${(k.server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => k.server.close(() => r()));
  });

  it('lists, stats, reads and adds through a Kubo RPC API', async () => {
    const c = new IpfsConnector({ mode: 'rpc', endpoint, root: CID_DIR, pin: true }, null, ctx());
    try {
      expect((await c.test()).detail).toMatch(/Kubo 0\.32\.1.*12D3KooWFake/);
      const l = await c.list('');
      expect(l.entries.map((e) => [e.name, e.dir, e.etag])).toEqual([['img', true, CID_DIR], ['notes.md', false, CID_FILE]]);
      expect(await c.stat('notes.md')).toMatchObject({ size: 8, etag: CID_FILE });
      expect(await c.stat('gone.md')).toBeNull();
      expect(await collect((await c.read('notes.md')).stream)).toBe('# Notes\n');
      const out = await c.write('upload.txt', chunks('hello ipfs'), 10, 'text/plain');
      expect(out.cid).toMatch(/^bafkrei/);
      expect(k.added[0]).toContain('filename="upload.txt"');
      expect(k.added[0]).toContain('hello ipfs');
    } finally {
      await c.close();
    }
  });

  it('fetches by CID without a root, and a gateway reads and lists but never writes', async () => {
    const bare = new IpfsConnector({ mode: 'rpc', endpoint, root: '', pin: false }, null, ctx());
    expect(await collect((await bare.read(CID_FILE)).stream)).toBe('raw bytes');
    await expect(bare.read('not-a-cid')).rejects.toMatchObject({ status: 400 });
    expect((await bare.list('')).entries).toEqual([]);
    await bare.close();
    const gw = new IpfsConnector({ mode: 'gateway', endpoint, root: CID_DIR, pin: false }, { authorization: 'Bearer x' }, ctx());
    expect(gw.writable).toBe(false);
    expect(await collect((await gw.read('notes.md')).stream)).toBe('# Notes\n');
    expect((await gw.list('')).entries.map((e) => e.name)).toEqual(['notes.md']);
    expect(await gw.stat('notes.md')).toMatchObject({ size: 8 });
    await expect(gw.write('x', chunks('x'), 1, null)).rejects.toMatchObject({ status: 403 });
    await gw.close();
  });

  it('never reaches a refused address', async () => {
    const before = k.hits();
    const c = new IpfsConnector({ mode: 'rpc', endpoint, root: CID_DIR, pin: false }, null, ctx(refuse));
    await expect(c.test()).rejects.toMatchObject({ status: 403 });
    await expect(c.read('notes.md')).rejects.toMatchObject({ status: 403 });
    expect(k.hits()).toBe(before);
    await c.close();
  });
});
