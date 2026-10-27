import type { ClientHttp2Session } from 'node:http2';
import { guardedHttp2Connect, guardedHttp2Request, type GuardedHttp2Request } from '../platform/egress.js';

/*
 * 1.9.0 (B-152): one HTTP/2 session per provider and origin, opened through the egress guard, shared by every send to
 * that origin (HTTP/2 multiplexes the streams), and closed once it has had no stream for `idleMs`. A session the
 * server closes (GOAWAY, an error, a TLS failure) leaves the pool and the next send opens a new one; a send on a session
 * that closed under it is tried once more on a fresh session.
 */

interface Entry {
  key: string;
  session: Promise<ClientHttp2Session>;
  active: number;
  idle: NodeJS.Timeout | null;
}

export interface H2Target {
  /** The provider (and credential set) the session belongs to: a client certificate pins a session to its provider. */
  providerId: string;
  origin: string;
  check: (address: string, host: string) => string | null;
  ca?: string | Buffer;
  cert?: string | Buffer;
  key?: string | Buffer;
}

export class H2Pool {
  private readonly entries = new Map<string, Entry>();
  /** Sessions opened since start (tests check reuse). */
  opened = 0;

  constructor(private readonly o: { idleMs: number; connectTimeoutMs: number }) {}

  get size(): number {
    return this.entries.size;
  }

  private entry(t: H2Target): Entry {
    const key = `${t.providerId}|${t.origin}`;
    const hit = this.entries.get(key);
    if (hit) return hit;
    const e: Entry = { key, active: 0, idle: null, session: Promise.resolve(null as unknown as ClientHttp2Session) };
    e.session = guardedHttp2Connect({ url: new URL(t.origin), check: t.check, connectTimeoutMs: this.o.connectTimeoutMs, ...(t.ca ? { ca: t.ca } : {}), ...(t.cert ? { cert: t.cert } : {}), ...(t.key ? { key: t.key } : {}) }).then(
      ({ session }) => {
        this.opened++;
        const gone = () => {
          if (this.entries.get(key) === e) this.entries.delete(key);
          if (e.idle) clearTimeout(e.idle);
        };
        session.once('close', gone);
        session.once('goaway', () => {
          gone();
          session.close();
        });
        session.once('error', gone);
        return session;
      },
      (err: unknown) => {
        if (this.entries.get(key) === e) this.entries.delete(key);
        throw err;
      }
    );
    this.entries.set(key, e);
    return e;
  }

  private release(e: Entry): void {
    e.active--;
    if (e.active > 0) return;
    if (e.idle) clearTimeout(e.idle);
    e.idle = setTimeout(() => {
      if (e.active > 0) return;
      if (this.entries.get(e.key) === e) this.entries.delete(e.key);
      void e.session.then((s) => s.close()).catch(() => undefined);
    }, this.o.idleMs);
    e.idle.unref();
  }

  /** One request on the target's session. */
  async request(t: H2Target, r: GuardedHttp2Request): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    for (let attempt = 0; ; attempt++) {
      const e = this.entry(t);
      e.active++;
      if (e.idle) {
        clearTimeout(e.idle);
        e.idle = null;
      }
      try {
        const session = await e.session;
        if (session.closed || session.destroyed) throw Object.assign(new Error('The HTTP/2 session is closed.'), { stale: true });
        return await guardedHttp2Request(session, r);
      } catch (err) {
        const stale = (err as { stale?: boolean }).stale || /session is closed|GOAWAY|ERR_HTTP2_INVALID_SESSION|ERR_HTTP2_GOAWAY_SESSION/.test(`${(err as Error).message} ${(err as { code?: string }).code ?? ''}`);
        if (stale && attempt === 0) {
          if (this.entries.get(e.key) === e) this.entries.delete(e.key);
          continue;
        }
        throw err;
      } finally {
        this.release(e);
      }
    }
  }

  /** Closes every session (shutdown, or a provider changed: `prefix` its id). */
  async close(providerId?: string): Promise<void> {
    const all = [...this.entries.values()].filter((e) => !providerId || e.key.startsWith(`${providerId}|`));
    for (const e of all) {
      this.entries.delete(e.key);
      if (e.idle) clearTimeout(e.idle);
    }
    await Promise.all(all.map((e) => e.session.then((s) => new Promise<void>((r) => (s.closed ? r() : s.close(() => r())))).catch(() => undefined)));
  }
}
