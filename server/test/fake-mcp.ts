import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

export interface FakeTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  /** Returns the tool result; throwing gives an isError result. */
  run?: (args: Record<string, unknown>, auth: string | null) => unknown;
}

/**
 * An MCP server stand-in speaking the streamable HTTP transport: JSON-RPC 2.0 over POST, answered with JSON or
 * (with `sse`) an event stream, a session id from initialize, `tools/list` with pagination and `tools/call`.
 * `token` makes it require a bearer token; `protocolVersion` lets a test play an older server.
 */
export class FakeMcp {
  tools: FakeTool[] = [];
  sse = false;
  token: string | null = null;
  /** With a token: required on every request, or only on tools/call (servers that list tools openly). */
  tokenFor: 'all' | 'call' = 'all';
  protocolVersion = '2025-06-18';
  pageSize = 0;
  down = false;
  calls: { name: string; arguments: Record<string, unknown>; auth: string | null }[] = [];
  /** Sprint 32: a delay before every tools/call answer, and the most calls that were in flight at once. */
  callDelayMs = 0;
  inFlight = 0;
  peak = 0;
  requests: { method: string; session: string | null; protocol: string | null }[] = [];
  private sessions = new Set<string>();
  server: Server;
  url = '';

  constructor() {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => this.handle(req, res, raw));
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/mcp`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }

  private send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    if (this.sse && status === 200) {
      res.writeHead(200, { 'content-type': 'text/event-stream', ...headers });
      // A notification first, as real servers interleave progress messages before the response.
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'working' } })}\n\n`);
      res.end(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  }

  private handle(req: IncomingMessage, res: ServerResponse, raw: string) {
    if (this.down) {
      req.socket.destroy();
      return;
    }
    if (req.method !== 'POST' || !req.url?.startsWith('/mcp')) {
      res.writeHead(405).end();
      return;
    }
    const auth = req.headers.authorization ?? null;
    const msg = JSON.parse(raw) as { id?: number; method: string; params?: Record<string, unknown> };
    if (this.token && auth !== `Bearer ${this.token}` && (this.tokenFor === 'all' || msg.method === 'tools/call')) {
      res.writeHead(401, { 'www-authenticate': 'Bearer' }).end();
      return;
    }
    const session = (req.headers['mcp-session-id'] as string | undefined) ?? null;
    this.requests.push({ method: msg.method, session, protocol: (req.headers['mcp-protocol-version'] as string | undefined) ?? null });
    if (msg.method === 'initialize') {
      const sid = randomUUID();
      this.sessions.add(sid);
      return this.send(res, 200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: this.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fake-mcp', version: '1.0.0' } } }, { 'mcp-session-id': sid });
    }
    if (!session || !this.sessions.has(session)) {
      res.writeHead(404).end();
      return;
    }
    if (msg.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const reply = (result: unknown) => this.send(res, 200, { jsonrpc: '2.0', id: msg.id, result });
    switch (msg.method) {
      case 'tools/list': {
        const all = this.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema ?? { type: 'object', properties: {} }, ...(t.annotations ? { annotations: t.annotations } : {}) }));
        if (!this.pageSize) return reply({ tools: all });
        const start = Number(msg.params?.cursor ?? 0);
        const page = all.slice(start, start + this.pageSize);
        return reply({ tools: page, ...(start + this.pageSize < all.length ? { nextCursor: String(start + this.pageSize) } : {}) });
      }
      case 'tools/call': {
        const name = String(msg.params?.name);
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        this.calls.push({ name, arguments: args, auth });
        const t = this.tools.find((x) => x.name === name);
        if (!t) return this.send(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `Unknown tool ${name}` } });
        const answer = () => {
          try {
            const out = t.run ? t.run(args, auth) : { ok: true };
            return reply({ content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out });
          } catch (err) {
            return reply({ content: [{ type: 'text', text: (err as Error).message }], isError: true });
          }
        };
        if (!this.callDelayMs) return answer();
        this.inFlight++;
        this.peak = Math.max(this.peak, this.inFlight);
        setTimeout(() => {
          this.inFlight--;
          answer();
        }, this.callDelayMs);
        return;
      }
      default:
        return this.send(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
    }
  }
}
