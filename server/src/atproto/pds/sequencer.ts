import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Knex } from 'knex';
import { WebSocket, WebSocketServer } from 'ws';
import { cborDecode, cborEncode, type CborValue } from '../cbor.js';
import { frame } from '../stream.js';
import { Limiter } from '../../platform/ratelimit.js';
import type { Services } from '../../services.js';

/*
 * The PDS's outbound firehose (B-2904): `com.atproto.sync.subscribeRepos` over a plain WebSocket, in the event-stream
 * framing of `stream.ts` (a DAG-CBOR header and body per binary message).
 *
 * The sequencer. Every repo commit and every identity or account change is an event with the next `seq`, written in
 * the same database transaction as the change itself. The seq is taken from a counter row as the transaction's last
 * statement, so the row lock (PostgreSQL, MySQL) or the single writer (SQLite) makes events commit in seq order: a
 * reader that has seen seq N never sees an event below N appear later. The event body is stored without `seq` and
 * `time`, which are added when it is sent.
 *
 * Subscribers. Without a cursor a subscriber gets new events only. With `cursor=N` it gets every event after N and
 * then follows live; a cursor past the newest event is a `FutureCursor` error, and one older than the backfill window
 * (PDS_BACKFILL_HOURS) gets an `#info OutdatedCursor` message and then the oldest event still kept. New events are
 * announced over the bus, so a subscriber on any instance receives events sequenced on any other. A consumer that
 * falls more than SLOW_BYTES behind is dropped with `ConsumerTooSlow` and reconnects from its cursor.
 */

export const SEQ_TOPIC = 'pds.sequenced';
export const SUBSCRIBE_REPOS_PATH = '/xrpc/com.atproto.sync.subscribeRepos';
const SLOW_BYTES = 16 * 1024 * 1024;
const PAGE = 200;

export type SeqType = 'commit' | 'sync' | 'identity' | 'account';

export interface SeqInput {
  did: string;
  type: SeqType;
  body: Record<string, CborValue | undefined>;
}

export interface SeqRow {
  seq: number;
  did: string;
  type: SeqType;
  body: Buffer;
  time: string;
  created_at: number;
}

const rowFrom = (r: Record<string, unknown>): SeqRow => ({ seq: Number(r.seq), did: String(r.did), type: r.type as SeqType, body: Buffer.from(String(r.body), 'base64'), time: String(r.time), created_at: Number(r.created_at) });

/**
 * Appends events in a transaction; call it last, just before the transaction commits (it takes the counter's lock).
 * Returns their seqs.
 */
export async function sequence(trx: Knex.Transaction, events: SeqInput[]): Promise<number[]> {
  if (!events.length) return [];
  await trx('pds_counters').where({ name: 'seq' }).increment('value', events.length);
  const r = (await trx('pds_counters').where({ name: 'seq' }).first('value')) as { value: number | string };
  const last = Number(r.value);
  const first = last - events.length + 1;
  const now = Date.now();
  const time = new Date(now).toISOString();
  await trx('pds_events').insert(events.map((e, i) => ({ seq: first + i, did: e.did, type: e.type, body: cborEncode(e.body).toString('base64'), time, created_at: now })));
  return events.map((_, i) => first + i);
}

/** The wire message of an event: `{ op: 1, t: '#commit' }` and the body with its seq and time. */
export function eventFrame(e: SeqRow): Buffer {
  const body = cborDecode(e.body) as Record<string, CborValue>;
  return frame({ op: 1, t: `#${e.type}` }, { ...body, seq: e.seq, time: e.time });
}

export async function newestSeq(db: Knex): Promise<number> {
  const r = (await db('pds_events').max({ n: 'seq' }).first()) as { n: number | string | null } | undefined;
  return Number(r?.n ?? 0);
}

export async function eventsAfter(db: Knex, seq: number, limit: number): Promise<SeqRow[]> {
  return ((await db('pds_events').where('seq', '>', seq).orderBy('seq', 'asc').limit(limit)) as Record<string, unknown>[]).map(rowFrom);
}

interface Subscriber {
  ws: WebSocket;
  last: number;
  pumping: boolean;
  again: boolean;
}

/** Attaches subscribeRepos to the HTTP server's upgrade event. */
export function attachRepoStream(server: Server, s: Services): { close(): Promise<void>; readonly count: number } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  const subs = new Set<Subscriber>();
  const limiter = new Limiter(s.counters, 'pds-xrpc', s.cfg.PDS_RATE_PER_MINUTE, 60_000);

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
          const rows = await eventsAfter(s.db, sub.last, PAGE);
          for (const e of rows) {
            if (sub.ws.bufferedAmount > SLOW_BYTES) return fail(sub.ws, 'ConsumerTooSlow', 'The subscriber fell too far behind; reconnect with a cursor.');
            sub.ws.send(eventFrame(e));
            sub.last = e.seq;
          }
          if (rows.length < PAGE) break;
        }
      } while (sub.again);
    } catch (err) {
      s.log.warn({ err }, 'subscribeRepos: sending events failed');
      fail(sub.ws, 'InternalError', 'The PDS could not read its event stream.');
    } finally {
      sub.pumping = false;
    }
  };

  const off = s.bus.on(SEQ_TOPIC, () => {
    for (const sub of subs) void pump(sub);
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
    if (url.pathname !== SUBSCRIBE_REPOS_PATH) return; // another upgrade (Socket.io, subscribeLabels) handles it
    const refuse = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    void (async () => {
      const ip = req.socket.remoteAddress ?? 'unknown';
      if (!(await limiter.consume(ip)).allowed) return refuse(429, 'Too Many Requests');
      if (subs.size >= s.cfg.PDS_SUBSCRIBERS_MAX) return refuse(503, 'Service Unavailable');
      const rawCursor = url.searchParams.get('cursor');
      wss.handleUpgrade(req, socket, head, (ws) => {
        void (async () => {
          const newest = await newestSeq(s.db);
          let last = newest;
          if (rawCursor !== null) {
            if (!/^\d{1,15}$/.test(rawCursor)) return fail(ws, 'InvalidRequest', 'cursor must be a non-negative integer.');
            const c = Number(rawCursor);
            if (c > newest) return fail(ws, 'FutureCursor', 'Cursor in the future.');
            last = c;
            const windowStart = Date.now() - s.cfg.PDS_BACKFILL_HOURS * 3600_000;
            const next = (await eventsAfter(s.db, c, 1))[0];
            if (next && next.created_at < windowStart) {
              ws.send(frame({ op: 1, t: '#info' }, { name: 'OutdatedCursor', message: 'Requested cursor exceeded limit. Possibly missing events' }));
              const first = (await s.db('pds_events').where('created_at', '>=', windowStart).orderBy('seq', 'asc').first('seq')) as { seq: number | string } | undefined;
              last = first ? Number(first.seq) - 1 : newest;
            }
          }
          const sub: Subscriber = { ws, last, pumping: false, again: false };
          subs.add(sub);
          (ws as WebSocket & { alive?: boolean }).alive = true;
          ws.on('pong', () => ((ws as WebSocket & { alive?: boolean }).alive = true));
          ws.on('message', () => undefined); // nothing is expected from a subscriber
          ws.on('close', () => subs.delete(sub));
          ws.on('error', () => subs.delete(sub));
          await pump(sub);
        })().catch((err: unknown) => {
          s.log.warn({ err }, 'subscribeRepos failed');
          fail(ws, 'InternalError', 'The PDS could not start the stream.');
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
