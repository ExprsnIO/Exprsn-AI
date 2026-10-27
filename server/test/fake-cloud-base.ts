/*
 * 1.9.99-final, Sprint 56 (B-10109): what the four cloud fakes share. Each fake is one HTTP server on 127.0.0.1 in
 * this process that records every request and can be told to throttle or fail the next calls, so the cloud suites
 * run with no network access. They are never the real services.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  /** The path without the query. */
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: string;
  /** The body's bytes (B-10208: blob uploads are binary). */
  raw?: Buffer;
  /** The fake's own label for the call (an AWS service and action, an ARM type, a DigitalOcean route...). */
  op: string;
  at: number;
}

export interface Reply {
  status: number;
  headers?: Record<string, string>;
  /** A string or a Buffer is sent as is; anything else as JSON. */
  body?: unknown;
  /** 1.9.99-final (B-10501): sent piece by piece (a streamed answer), each after `gapMs`; `body` is then ignored. */
  chunks?: Buffer[];
  gapMs?: number;
}

interface Injection {
  match: (r: RecordedRequest) => boolean;
  reply: (r: RecordedRequest) => Reply;
  times: number;
}

export abstract class FakeCloudBase {
  url = '';
  readonly requests: RecordedRequest[] = [];
  private readonly injections: Injection[] = [];
  private server: Server | null = null;
  private seq = 0;

  /** The fake's label for a request, recorded as `op` (and used by `throttle`/`fail` matchers). */
  protected abstract classify(r: Omit<RecordedRequest, 'op'>): string;
  protected abstract handle(r: RecordedRequest): Reply | Promise<Reply>;
  /** The provider's own throttling answer. */
  protected abstract throttleReply(r: RecordedRequest, retryAfterS: number): Reply;

  protected nextId(prefix = ''): string {
    this.seq += 1;
    return `${prefix}${this.seq.toString(16).padStart(8, '0')}`;
  }

  /** The next `times` requests (matching `op` when given) answer with the provider's throttling signal. */
  throttle(times = 1, o: { retryAfterS?: number; op?: string | RegExp } = {}): this {
    const retry = o.retryAfterS ?? 1;
    this.injections.push({ match: matcher(o.op), reply: (r) => this.throttleReply(r, retry), times });
    return this;
  }

  /** The next `times` requests (matching `op` when given) answer `status` with `body`. */
  fail(status: number, body: unknown, o: { op?: string | RegExp; times?: number; headers?: Record<string, string> } = {}): this {
    this.injections.push({ match: matcher(o.op), reply: () => ({ status, body, ...(o.headers ? { headers: o.headers } : {}) }), times: o.times ?? 1 });
    return this;
  }

  /** Recorded requests whose `op` matches. */
  calls(op: string | RegExp): RecordedRequest[] {
    const m = matcher(op);
    return this.requests.filter(m);
  }

  reset(): void {
    this.requests.length = 0;
    this.injections.length = 0;
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.serve(req, res));
    this.url = await new Promise<string>((resolve) => this.server!.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`)));
    return this;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise((r) => this.server!.close(r));
    this.server = null;
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const u = new URL(req.url ?? '/', 'http://fake');
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')]));
    const raw = Buffer.concat(chunks);
    const base = { method: req.method ?? 'GET', path: u.pathname, query: u.searchParams, headers, body: raw.toString('utf8'), raw, at: Date.now() };
    let op = 'unknown';
    try {
      op = this.classify(base);
    } catch {
      /* unknown */
    }
    const r: RecordedRequest = { ...base, op };
    this.requests.push(r);
    let reply: Reply;
    try {
      const inj = this.injections.find((i) => i.times > 0 && i.match(r));
      if (inj) {
        inj.times -= 1;
        reply = inj.reply(r);
      } else reply = await this.handle(r);
    } catch (err) {
      reply = { status: 500, body: { error: (err as Error).message } };
    }
    const isText = typeof reply.body === 'string' || Buffer.isBuffer(reply.body);
    const out = reply.body === undefined ? '' : isText ? (reply.body as string | Buffer) : JSON.stringify(reply.body);
    res.writeHead(reply.status, { ...(reply.body !== undefined && !isText ? { 'content-type': 'application/json' } : {}), ...(reply.headers ?? {}) });
    if (reply.chunks) {
      for (const c of reply.chunks) {
        res.write(c);
        await new Promise((r) => setTimeout(r, reply.gapMs ?? 2));
      }
      res.end();
      return;
    }
    res.end(out);
  }
}

const matcher = (op: string | RegExp | undefined) => (r: RecordedRequest) => (op === undefined ? true : typeof op === 'string' ? r.op === op : op.test(r.op));

export const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const json = (r: RecordedRequest): Record<string, unknown> => {
  if (!r.body) return {};
  try {
    return JSON.parse(r.body) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** The claims of a JWT (unverified; the fakes record them for the tests to check). */
export const jwtClaims = (jwt: string): Record<string, unknown> | null => {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};
