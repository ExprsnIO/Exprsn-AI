import { isIP } from 'node:net';
import { fetch, type Dispatcher } from 'undici';
import { addressProblem, HostRefused, type AllowList } from './hosts.js';

/** Protocol revisions spoken over streamable HTTP. 2024-11-05 used the older HTTP+SSE transport and is refused. */
export const PROTOCOL_VERSION = '2025-06-18';
export const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26'];
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpCallResult {
  content: { type: string; text?: string; [k: string]: unknown }[];
  structuredContent?: unknown;
  isError?: boolean;
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly kind: 'rpc' | 'http' | 'transport' | 'incompatible' | 'refused' = 'rpc'
  ) {
    super(message);
  }
}

interface RpcMessage {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Reads a text/event-stream body and yields each event's data. */
async function* sseData(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = '';
  let data: string[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > MAX_RESPONSE_BYTES) throw new McpError('The server\'s response is too large.', null, 'transport');
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line === '') {
        if (data.length) yield data.join('\n');
        data = [];
      } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (data.length) yield data.join('\n');
}

/**
 * A client for one MCP server over the streamable HTTP transport: JSON-RPC 2.0 requests POSTed to the endpoint,
 * answered with JSON or a server-sent event stream; the session id from `initialize` goes on every later request.
 * Connections go through a dispatcher that refuses non-internal addresses (see hosts.ts).
 */
export class McpClient {
  private nextId = 1;
  private sessionId: string | null = null;
  protocolVersion: string | null = null;
  serverInfo: { name?: string; version?: string } | null = null;
  capabilities: Record<string, unknown> = {};

  constructor(
    private readonly url: string,
    private readonly o: { dispatcher: Dispatcher; allow: AllowList; timeoutMs: number; token?: string | null }
  ) {}

  private guard(): void {
    const host = new URL(this.url).hostname.replace(/^\[|\]$/g, '');
    // Names are checked in the dispatcher's DNS lookup; an address literal never reaches a lookup, so check it here.
    if (isIP(host)) {
      const p = addressProblem(host, host, this.o.allow);
      if (p) throw new McpError(p, null, 'refused');
    }
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.protocolVersion ? { 'mcp-protocol-version': this.protocolVersion } : {}),
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      ...(this.o.token ? { authorization: `Bearer ${this.o.token}` } : {})
    };
  }

  private async post(body: RpcMessage, signal?: AbortSignal) {
    this.guard();
    const timeout = AbortSignal.timeout(this.o.timeoutMs);
    try {
      return await fetch(this.url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), dispatcher: this.o.dispatcher, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' });
    } catch (err) {
      const cause = (err as { cause?: unknown }).cause;
      if (cause instanceof HostRefused) throw new McpError(cause.message, null, 'refused');
      if (signal?.aborted) throw signal.reason as Error;
      if (timeout.aborted) throw new McpError(`No response in ${Math.round(this.o.timeoutMs / 1000)} s.`, null, 'transport');
      throw new McpError(`Connection failed: ${(cause as Error | undefined)?.message ?? (err as Error).message}`, null, 'transport');
    }
  }

  /** Sends a request and waits for the response with the same id. */
  async request<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: '2.0', id, method, params }, signal);
    if (res.status === 404 && this.sessionId && method !== 'initialize') {
      // The server forgot the session: start a new one and retry once.
      await res.body?.cancel().catch(() => undefined);
      this.sessionId = null;
      await this.initialize(signal);
      return this.request(method, params, signal);
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid && method === 'initialize') this.sessionId = sid;
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => undefined);
      throw new McpError(res.status === 401 ? 'The server wants credentials: connect a token for this server.' : 'The server refused the credentials.', res.status, 'http');
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300);
      throw new McpError(`HTTP ${res.status} from the server${text ? `: ${text}` : ''}`, res.status, 'http');
    }
    const type = res.headers.get('content-type') ?? '';
    let msg: RpcMessage | undefined;
    if (type.includes('text/event-stream')) {
      if (!res.body) throw new McpError('Empty event stream.', null, 'transport');
      for await (const data of sseData(res.body)) {
        let parsed: RpcMessage | RpcMessage[];
        try {
          parsed = JSON.parse(data) as RpcMessage | RpcMessage[];
        } catch {
          continue;
        }
        const hit = (Array.isArray(parsed) ? parsed : [parsed]).find((m) => m.id === id && (m.result !== undefined || m.error));
        if (hit) {
          msg = hit;
          break;
        }
      }
    } else if (type.includes('application/json')) {
      const text = await res.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new McpError('The server\'s response is too large.', null, 'transport');
      const parsed = JSON.parse(text) as RpcMessage | RpcMessage[];
      msg = (Array.isArray(parsed) ? parsed : [parsed]).find((m) => m.id === id);
    } else {
      await res.body?.cancel().catch(() => undefined);
      throw new McpError(`Unexpected content type ${type || 'none'}; streamable HTTP answers JSON or an event stream.`, null, 'incompatible');
    }
    if (!msg) throw new McpError(`No response to ${method}.`, null, 'transport');
    if (msg.error) throw new McpError(msg.error.message, msg.error.code, 'rpc');
    return msg.result as T;
  }

  async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    const res = await this.post({ jsonrpc: '2.0', method, params });
    await res.body?.cancel().catch(() => undefined);
  }

  /** The handshake: initialize, then the initialized notification. Refuses protocol revisions it does not speak. */
  async initialize(signal?: AbortSignal): Promise<{ protocolVersion: string; serverInfo: { name?: string; version?: string } | null }> {
    this.protocolVersion = null;
    const r = await this.request<{ protocolVersion?: string; serverInfo?: { name?: string; version?: string }; capabilities?: Record<string, unknown> }>(
      'initialize',
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'exprsn-ai', version: '1.0' } },
      signal
    );
    const v = r.protocolVersion ?? '';
    if (!SUPPORTED_VERSIONS.includes(v)) throw new McpError(`The server speaks protocol ${v || 'unknown'}; streamable HTTP needs ${SUPPORTED_VERSIONS.join(' or ')}.`, null, 'incompatible');
    this.protocolVersion = v;
    this.serverInfo = r.serverInfo ?? null;
    this.capabilities = r.capabilities ?? {};
    await this.notify('notifications/initialized');
    return { protocolVersion: v, serverInfo: this.serverInfo };
  }

  /** Every tool the server announces, following pagination cursors. */
  async listTools(signal?: AbortSignal): Promise<McpToolInfo[]> {
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await this.request<{ tools?: McpToolInfo[]; nextCursor?: string }>('tools/list', cursor ? { cursor } : {}, signal);
      out.push(...(r.tools ?? []).filter((t) => t && typeof t.name === 'string'));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    return out;
  }

  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    return this.request<McpCallResult>('tools/call', { name, arguments: args }, signal);
  }
}
