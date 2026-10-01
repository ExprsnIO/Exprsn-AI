import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer, type Socket as TcpSocket } from 'node:net';
import { createSocket, type Socket } from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { writeTimestamp } from '../src/platform/ntp.js';

const body = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });

/** An OTLP/HTTP collector that keeps every JSON export request it receives. */
export class FakeCollector {
  readonly bodies: string[] = [];
  private server: Server | null = null;
  url = '';
  status = 200;

  async start(): Promise<this> {
    this.server = createServer(async (req, res) => {
      const text = await body(req);
      if (req.method === 'POST' && req.url === '/v1/traces' && /application\/json/.test(String(req.headers['content-type']))) this.bodies.push(text);
      res.writeHead(this.status, { 'Content-Type': 'application/json' }).end('{}');
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  /** Every exported span, flattened. */
  spans(): { traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number; attributes: { key: string; value: Record<string, unknown> }[]; status: { code: number } }[] {
    return this.bodies.flatMap((b) => (JSON.parse(b) as { resourceSpans: { scopeSpans: { spans: never[] }[] }[] }).resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)));
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise((r) => this.server?.close(r));
  }
}

/**
 * A Kubernetes API server for NetworkPolicies: server-side apply (PATCH with application/apply-patch+yaml, a field
 * manager and force) creates or replaces the object, GET reads it, 404 when absent. Bearer token checked.
 */
export class FakeKubeApi {
  readonly objects = new Map<string, Record<string, unknown>>();
  readonly requests: { method: string; path: string; query: string; contentType: string | undefined }[] = [];
  private server: Server | null = null;
  url = '';
  private rv = 1;

  constructor(readonly token = 'test-token') {}

  async start(): Promise<this> {
    this.server = createServer(async (req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      const text = await body(req);
      this.requests.push({ method: req.method ?? '', path: u.pathname, query: u.search, contentType: req.headers['content-type'] });
      const send = (status: number, obj: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj));
      if (req.headers.authorization !== `Bearer ${this.token}`) return send(401, { kind: 'Status', status: 'Failure', reason: 'Unauthorized', code: 401 });
      const m = /^\/apis\/networking\.k8s\.io\/v1\/namespaces\/([^/]+)\/networkpolicies\/([^/]+)$/.exec(u.pathname);
      if (!m) return send(404, { kind: 'Status', reason: 'NotFound', code: 404 });
      const key = `${m[1]}/${m[2]}`;
      if (req.method === 'GET') {
        const o = this.objects.get(key);
        return o ? send(200, o) : send(404, { kind: 'Status', reason: 'NotFound', message: `networkpolicies "${m[2]}" not found`, code: 404 });
      }
      if (req.method === 'PATCH') {
        if (req.headers['content-type'] !== 'application/apply-patch+yaml') return send(415, { kind: 'Status', reason: 'UnsupportedMediaType', code: 415 });
        if (!u.searchParams.get('fieldManager')) return send(422, { kind: 'Status', reason: 'Invalid', message: 'fieldManager is required for apply', code: 422 });
        const obj = JSON.parse(text) as { metadata: Record<string, unknown> };
        const existed = this.objects.has(key);
        const live = { ...obj, metadata: { ...obj.metadata, uid: `uid-${key}`, resourceVersion: String(this.rv++), managedFields: [{ manager: u.searchParams.get('fieldManager'), operation: 'Apply' }] } };
        this.objects.set(key, live);
        return send(existed ? 200 : 201, live);
      }
      return send(405, { kind: 'Status', reason: 'MethodNotAllowed', code: 405 });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise((r) => this.server?.close(r));
  }
}

/** An SNTP server whose clock is `offsetMs` away from ours (a liar when the offset is large). */
export async function fakeSntp(offsetMs: number): Promise<{ spec: string; socket: Socket; close(): Promise<void> }> {
  const socket = createSocket('udp4');
  socket.on('message', (msg, rinfo) => {
    if (msg.length < 48) return;
    const reply = Buffer.alloc(48);
    reply[0] = (0 << 6) | (4 << 3) | 4; // LI 0, version 4, server
    reply[1] = 2; // stratum
    reply.write('LOCL', 12, 'ascii');
    msg.copy(reply, 24, 40, 48); // originate = the client's transmit nonce
    const now = Date.now() + offsetMs;
    writeTimestamp(reply, 32, now);
    writeTimestamp(reply, 40, now);
    socket.send(reply, rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => socket.bind(0, '127.0.0.1', r));
  return { spec: `127.0.0.1:${socket.address().port}`, socket, close: () => new Promise<void>((r) => socket.close(() => r())) };
}

/**
 * Enough of the Redis protocol for the rate-limit counters: PING, INFO (ready check), EVALSHA/EVAL of the counter
 * script (INCRBY with a window), and +OK for the rest. `stop` closes the listener and every connection, as a
 * stopped Redis would.
 */
export class FakeRedis {
  private server: TcpServer | null = null;
  private readonly sockets = new Set<TcpSocket>();
  private readonly counts = new Map<string, { n: number; ends: number }>();
  port = 0;

  async start(port = 0): Promise<this> {
    this.server = createTcpServer((sock) => {
      this.sockets.add(sock);
      sock.on('close', () => this.sockets.delete(sock));
      sock.on('error', () => undefined);
      let buf = Buffer.alloc(0);
      sock.on('data', (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          const parsed = parseCommand(buf);
          if (!parsed) break;
          buf = buf.subarray(parsed.used);
          sock.write(this.answer(parsed.args));
        }
      });
    });
    await new Promise<void>((r) => this.server!.listen(port, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  private answer(args: string[]): string {
    const cmd = (args[0] ?? '').toUpperCase();
    if (cmd === 'PING') return '+PONG\r\n';
    if (cmd === 'INFO') {
      const info = '# Server\r\nredis_version:7.2.0\r\nloading:0\r\n';
      return `$${Buffer.byteLength(info)}\r\n${info}\r\n`;
    }
    if (cmd === 'EVALSHA' || cmd === 'EVAL') {
      const key = args[3]!;
      const windowMs = Number(args[4]);
      const cost = Number(args[5]);
      const now = Date.now();
      let c = this.counts.get(key);
      if (!c || c.ends <= now) c = { n: 0, ends: now + windowMs };
      c.n += cost;
      this.counts.set(key, c);
      return `*2\r\n:${c.n}\r\n:${c.ends - now}\r\n`;
    }
    return '+OK\r\n';
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise((r) => this.server?.close(r));
  }
}

function parseCommand(buf: Buffer): { args: string[]; used: number } | null {
  if (!buf.length || buf[0] !== 0x2a) return null; // '*'
  let pos = buf.indexOf('\r\n');
  if (pos < 0) return null;
  const n = Number(buf.subarray(1, pos).toString());
  pos += 2;
  const args: string[] = [];
  for (let i = 0; i < n; i++) {
    if (buf[pos] !== 0x24) return null; // '$'
    const end = buf.indexOf('\r\n', pos);
    if (end < 0) return null;
    const len = Number(buf.subarray(pos + 1, end).toString());
    const start = end + 2;
    if (buf.length < start + len + 2) return null;
    args.push(buf.subarray(start, start + len).toString());
    pos = start + len + 2;
  }
  return { args, used: pos };
}
