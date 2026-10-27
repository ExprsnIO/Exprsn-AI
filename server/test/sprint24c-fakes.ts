import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

/**
 * Enough of Redis for two Exprsn-AI instances in one test: the bus (SUBSCRIBE and PUBLISH, with pushed messages) and
 * the cache's Redis store (GET, SET with PX, DEL, INCR). Strings only, RESP2. Listens on 127.0.0.1.
 */
export class MiniRedis {
  private server: Server | null = null;
  private readonly kv = new Map<string, { v: string; expires: number | null }>();
  private readonly subs = new Map<string, Set<Socket>>();
  private readonly sockets = new Set<Socket>();
  readonly commands: string[][] = [];
  port = 0;

  get url(): string {
    return `redis://127.0.0.1:${this.port}`;
  }

  async start(): Promise<this> {
    this.server = createServer((sock) => {
      this.sockets.add(sock);
      sock.on('error', () => undefined);
      sock.on('close', () => {
        this.sockets.delete(sock);
        for (const set of this.subs.values()) set.delete(sock);
      });
      let buf = Buffer.alloc(0);
      sock.on('data', (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          const parsed = parseCommand(buf);
          if (!parsed) break;
          buf = buf.subarray(parsed.used);
          this.commands.push(parsed.args);
          sock.write(this.answer(sock, parsed.args));
        }
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  private live(key: string): string | null {
    const e = this.kv.get(key);
    if (!e) return null;
    if (e.expires != null && e.expires <= Date.now()) {
      this.kv.delete(key);
      return null;
    }
    return e.v;
  }

  private answer(sock: Socket, args: string[]): string {
    const cmd = (args[0] ?? '').toUpperCase();
    switch (cmd) {
      case 'PING':
        return '+PONG\r\n';
      case 'HELLO':
        // Speak RESP2 only, as Redis 5 does: clients fall back from RESP3.
        return "-ERR unknown command 'HELLO'\r\n";
      case 'INFO': {
        const info = '# Server\r\nredis_version:7.2.0\r\nloading:0\r\n';
        return bulk(info);
      }
      case 'GET':
        return bulk(this.live(args[1]!));
      case 'SET': {
        const px = args.findIndex((a, i) => i > 2 && a.toUpperCase() === 'PX');
        this.kv.set(args[1]!, { v: args[2]!, expires: px > 0 ? Date.now() + Number(args[px + 1]) : null });
        return '+OK\r\n';
      }
      case 'DEL': {
        let n = 0;
        for (const k of args.slice(1)) if (this.kv.delete(k)) n++;
        return `:${n}\r\n`;
      }
      case 'INCR': {
        const n = Number(this.live(args[1]!) ?? 0) + 1;
        this.kv.set(args[1]!, { v: String(n), expires: null });
        return `:${n}\r\n`;
      }
      case 'SUBSCRIBE': {
        let out = '';
        args.slice(1).forEach((ch, i) => {
          if (!this.subs.has(ch)) this.subs.set(ch, new Set());
          this.subs.get(ch)!.add(sock);
          out += `*3\r\n${bulk('subscribe')}${bulk(ch)}:${i + 1}\r\n`;
        });
        return out;
      }
      case 'PUBLISH': {
        const set = this.subs.get(args[1]!) ?? new Set();
        for (const s of set) s.write(`*3\r\n${bulk('message')}${bulk(args[1]!)}${bulk(args[2]!)}`);
        return `:${set.size}\r\n`;
      }
      default:
        return '+OK\r\n';
    }
  }

  /** The keys currently held (for assertions). */
  keys(): string[] {
    return [...this.kv.keys()].filter((k) => this.live(k) != null);
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise((r) => this.server?.close(r));
    this.server = null;
  }
}

function bulk(s: string | null): string {
  return s == null ? '$-1\r\n' : `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
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
