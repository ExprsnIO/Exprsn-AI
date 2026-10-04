import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { Limiter } from '../platform/ratelimit.js';
import { serviceLookup, literalProblem, ServiceUrlRefused, type ServicePolicy } from '../platform/egress.js';
import type { Services } from '../services.js';
import { cborDecodeFirst, cborEncode } from './cbor.js';
import { labelCbor, LABELS_TOPIC } from './labels.js';
import type { IdentityRow } from './service.js';

/*
 * `com.atproto.label.subscribeLabels` (B-1610): an AT-Protocol event stream over a plain WebSocket (not Socket.io).
 * Every message is one binary frame holding two DAG-CBOR values back to back, a header and a body:
 *
 *   { op: 1, t: '#labels' }  { seq, labels: [label] }       one label per message, in seq order
 *   { op: 1, t: '#info' }    { name, message? }
 *   { op: -1 }               { error, message? }             then the server closes
 *
 * With `?cursor=N` the stream replays every label after N and then follows live; without one it starts live. A
 * cursor past the newest label is a `FutureCursor` error. New labels are announced over the bus, so a subscriber on
 * any instance receives labels made on any other; each connection reads them from the database in order. A consumer
 * that falls more than SLOW_BYTES behind is dropped (`ConsumerTooSlow`) and reconnects from its cursor.
 */

export const SUBSCRIBE_PATH = 'com.atproto.label.subscribeLabels';
const SLOW_BYTES = 8 * 1024 * 1024;
const PAGE = 500;

export const frame = (header: Record<string, unknown>, body: Record<string, unknown>): Buffer => Buffer.concat([cborEncode(header), cborEncode(body)]);

/** Splits a frame into its header and body. */
export function readFrame(data: Uint8Array): { header: Record<string, unknown>; body: Record<string, unknown> } {
  const h = cborDecodeFirst(data, 0);
  const b = cborDecodeFirst(data, h.next);
  if (b.next !== data.length) throw new Error('Trailing bytes after the frame body');
  if (!h.value || typeof h.value !== 'object' || Array.isArray(h.value) || !b.value || typeof b.value !== 'object' || Array.isArray(b.value)) throw new Error('A frame is two CBOR maps');
  return { header: h.value as Record<string, unknown>, body: b.value as Record<string, unknown> };
}

interface Subscriber {
  ws: WebSocket;
  identityId: string;
  last: number;
  pumping: boolean;
  again: boolean;
}

/** Attaches the subscribeLabels endpoint to the HTTP server's upgrade event. */
export function attachLabelStream(server: Server, s: Services): { close(): Promise<void>; readonly count: number } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  const subs = new Set<Subscriber>();
  const limiter = new Limiter(s.counters, 'atproto-public', s.cfg.ATPROTO_PUBLIC_RATE_PER_MINUTE, 60_000);

  const fail = (ws: WebSocket, error: string, message: string) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(frame({ op: -1 }, { error, message }));
    ws.close(1008, error.slice(0, 100));
  };

  const pump = async (sub: Subscriber): Promise<void> => {
    if (sub.pumping) {
      sub.again = true;
      return;
    }
    sub.pumping = true;
    try {
      do {
        sub.again = false;
        for (;;) {
          if (sub.ws.readyState !== WebSocket.OPEN) return;
          const rows = await s.atproto.labelsAfter(sub.identityId, sub.last, PAGE);
          for (const l of rows) {
            if (sub.ws.bufferedAmount > SLOW_BYTES) return fail(sub.ws, 'ConsumerTooSlow', 'The subscriber fell too far behind; reconnect with a cursor.');
            sub.ws.send(frame({ op: 1, t: '#labels' }, { seq: l.seq, labels: [labelCbor(l.label)] }));
            sub.last = l.seq;
          }
          if (rows.length < PAGE) break;
        }
      } while (sub.again);
    } catch (err) {
      s.log.warn({ err }, 'subscribeLabels: sending labels failed');
      fail(sub.ws, 'InternalError', 'The labeler could not read its labels.');
    } finally {
      sub.pumping = false;
    }
  };

  const off = s.bus.on<{ identityId?: string }>(LABELS_TOPIC, ({ identityId }) => {
    for (const sub of subs) if (sub.identityId === identityId) void pump(sub);
  });

  const heartbeat = setInterval(() => {
    for (const sub of subs) {
      const w = sub.ws as WebSocket & { alive?: boolean };
      if (w.alive === false) {
        w.terminate();
        continue;
      }
      w.alive = false;
      w.ping();
    }
  }, 30_000);
  heartbeat.unref();

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const m = /^(?:\/atproto\/([a-z0-9-]{1,63}))?\/xrpc\/com\.atproto\.label\.subscribeLabels$/.exec(url.pathname);
    if (!m) return; // another upgrade (Socket.io) handles it
    const refuse = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    void (async () => {
      const ip = req.socket.remoteAddress ?? 'unknown';
      if (!(await limiter.consume(ip)).allowed) return refuse(429, 'Too Many Requests');
      if (subs.size >= s.cfg.ATPROTO_SUBSCRIBERS_MAX) return refuse(503, 'Service Unavailable');
      const identity: IdentityRow | undefined = m[1] ? await s.atproto.identityByPathKey(m[1]) : await s.atproto.identityByHost(String(req.headers.host ?? ''));
      if (!identity || identity.state !== 'active') return refuse(404, 'Not Found');
      const rawCursor = url.searchParams.get('cursor');
      wss.handleUpgrade(req, socket, head, (ws) => {
        void (async () => {
          const newest = await s.atproto.maxSeq(identity.id);
          let last = newest;
          if (rawCursor !== null) {
            if (!/^\d{1,15}$/.test(rawCursor)) return fail(ws, 'InvalidRequest', 'cursor must be a non-negative integer.');
            const c = Number(rawCursor);
            if (c > newest) return fail(ws, 'FutureCursor', 'The cursor is past the newest label.');
            last = c;
          }
          const sub: Subscriber = { ws, identityId: identity.id, last, pumping: false, again: false };
          subs.add(sub);
          (ws as WebSocket & { alive?: boolean }).alive = true;
          ws.on('pong', () => ((ws as WebSocket & { alive?: boolean }).alive = true));
          ws.on('message', () => undefined); // nothing is expected from a subscriber
          ws.on('close', () => subs.delete(sub));
          ws.on('error', () => subs.delete(sub));
          await pump(sub);
        })().catch((err: unknown) => {
          s.log.warn({ err }, 'subscribeLabels failed');
          fail(ws, 'InternalError', 'The labeler could not start the stream.');
        });
      });
    })().catch(() => refuse(500, 'Internal Server Error'));
  };

  server.on('upgrade', onUpgrade);
  return {
    get count() {
      return subs.size;
    },
    close: async () => {
      server.off('upgrade', onUpgrade);
      off();
      clearInterval(heartbeat);
      for (const sub of subs) sub.ws.terminate();
      subs.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  };
}

export interface PullResult {
  cursor: number | null;
  frames: number;
  error: string | null;
}

/**
 * Reads another labeler's subscribeLabels from a cursor (B-1611): connects through the service URL checks (B-901;
 * every DNS answer is checked at connect time, redirects are not followed), hands each `#labels` message to `onLabels`
 * in order, and stops when the stream goes quiet for `idleMs`, after `maxMs`, or after `maxFrames` messages.
 */
export function pullLabelStream(
  endpoint: string,
  cursor: number | null,
  policy: ServicePolicy,
  onLabels: (seq: number, labels: unknown[]) => Promise<void>,
  o: { idleMs?: number; maxMs?: number; maxFrames?: number } = {}
): Promise<PullResult> {
  const base = new URL(endpoint.endsWith('/') ? endpoint : `${endpoint}/`);
  const url = new URL(`xrpc/${SUBSCRIBE_PATH}`, base);
  url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  if (cursor !== null) url.searchParams.set('cursor', String(cursor));
  const refused = literalProblem(base.toString(), policy);
  if (refused) return Promise.reject(new ServiceUrlRefused(refused));
  const idleMs = o.idleMs ?? 2000;
  const maxMs = o.maxMs ?? 30_000;
  const maxFrames = o.maxFrames ?? 5000;
  return new Promise((resolve) => {
    let last = cursor;
    let frames = 0;
    let error: string | null = null;
    let chain = Promise.resolve();
    let done = false;
    let failed = false;
    const ws = new WebSocket(url, { lookup: serviceLookup(policy) as never, handshakeTimeout: 5000, maxPayload: 1024 * 1024, followRedirects: false, perMessageDeflate: false });
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(idle);
      clearTimeout(cap);
      ws.removeAllListeners('message');
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
      void chain.then(() => resolve({ cursor: last, frames, error }));
    };
    let idle = setTimeout(finish, idleMs + 5000);
    const cap = setTimeout(finish, maxMs);
    ws.on('open', () => {
      clearTimeout(idle);
      idle = setTimeout(finish, idleMs);
    });
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      clearTimeout(idle);
      idle = setTimeout(finish, idleMs);
      if (!isBinary) return;
      let f: ReturnType<typeof readFrame>;
      try {
        f = readFrame(data);
      } catch (err) {
        error = `Unreadable frame: ${(err as Error).message}`;
        return finish();
      }
      if (f.header.op === -1) {
        error = `${String(f.body.error ?? 'Error')}: ${String(f.body.message ?? '')}`.slice(0, 300);
        return finish();
      }
      if (f.header.op !== 1 || f.header.t !== '#labels') return;
      const seq = f.body.seq;
      const labels = f.body.labels;
      if (typeof seq !== 'number' || !Array.isArray(labels) || (last !== null && seq <= last)) return;
      frames++;
      // In order; after a failure nothing later is processed, so the cursor stops at the last message handled.
      chain = chain
        .then(async () => {
          if (failed) return;
          await onLabels(seq, labels);
          last = seq;
        })
        .catch((err: unknown) => {
          failed = true;
          error ??= `Processing labels failed: ${(err as Error).message}`.slice(0, 300);
          finish();
        });
      if (frames >= maxFrames) finish();
    });
    ws.on('error', (err) => {
      error ??= err.message.slice(0, 300);
      finish();
    });
    ws.on('close', finish);
  });
}
