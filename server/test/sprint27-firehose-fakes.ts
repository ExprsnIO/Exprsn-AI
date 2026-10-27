import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { cborEncode } from '../src/atproto/cbor.js';
import { Cid, varint } from '../src/atproto/encoding.js';

/*
 * Test double for Sprint 27 (B-1908): a firehose on 127.0.0.1 that speaks either Jetstream (JSON text messages) or a
 * relay's com.atproto.sync.subscribeRepos (binary frames of two DAG-CBOR values, records in a CAR file). It records
 * every connection's URL (path, filters and cursor) and lets the test send messages to, or drop, the newest one.
 */

export interface FakeConnection {
  url: URL;
  ws: WebSocket;
  closed: boolean;
}

export class FakeFirehose {
  url = '';
  readonly connections: FakeConnection[] = [];
  private wss: WebSocketServer | null = null;

  async start(): Promise<void> {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const c: FakeConnection = { url: new URL(req.url ?? '/', 'ws://127.0.0.1'), ws, closed: false };
      ws.on('close', () => (c.closed = true));
      this.connections.push(c);
    });
    this.wss = wss;
    this.url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  }

  get latest(): FakeConnection | undefined {
    return this.connections.at(-1);
  }

  get open(): FakeConnection[] {
    return this.connections.filter((c) => !c.closed);
  }

  /** Sends to the newest connection: an object as a Jetstream JSON message, a Buffer as a binary frame. */
  send(msg: Record<string, unknown> | Buffer): void {
    const c = this.latest;
    if (!c || c.closed) throw new Error('no open firehose connection');
    c.ws.send(Buffer.isBuffer(msg) ? msg : JSON.stringify(msg), { binary: Buffer.isBuffer(msg) });
  }

  /** Drops the newest connection abruptly (as a relay does to a slow consumer, or a network failure). */
  drop(): void {
    this.latest?.ws.terminate();
  }

  async stop(): Promise<void> {
    for (const c of this.connections) c.ws.terminate();
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
  }
}

/** A Jetstream commit event. */
export function jetCommit(timeUs: number, did: string, collection: string, rkey: string, record: Record<string, unknown> | null, operation: 'create' | 'update' | 'delete' = 'create'): Record<string, unknown> {
  return { did, time_us: timeUs, kind: 'commit', commit: { rev: `rev${timeUs}`, operation, collection, rkey, ...(record ? { record: { $type: collection, ...record }, cid: Cid.ofCbor(cborEncode(record)).toString() } : {}) } };
}

/** A CAR v1 file holding the given DAG-CBOR blocks. */
export function car(blocks: Buffer[]): Buffer {
  const cids = blocks.map((b) => Cid.ofCbor(b));
  const header = cborEncode({ version: 1, roots: cids.slice(0, 1) });
  const parts = [varint(header.length), header];
  blocks.forEach((b, i) => {
    const cid = cids[i]!.bytes;
    parts.push(varint(cid.length + b.length), cid, b);
  });
  return Buffer.concat(parts);
}

/** A subscribeRepos `#commit` frame with its records in the blocks. */
export function repoCommit(seq: number, did: string, ops: { collection: string; rkey: string; record: Record<string, unknown> | null; action?: 'create' | 'update' | 'delete' }[]): Buffer {
  const blocks: Buffer[] = [];
  const wireOps = ops.map((o) => {
    if (!o.record) return { action: o.action ?? 'delete', path: `${o.collection}/${o.rkey}`, cid: null };
    const block = cborEncode({ $type: o.collection, ...o.record });
    blocks.push(block);
    return { action: o.action ?? 'create', path: `${o.collection}/${o.rkey}`, cid: Cid.ofCbor(block) };
  });
  const commit = cborEncode({ did, rev: `r${seq}`, version: 3 });
  return Buffer.concat([cborEncode({ op: 1, t: '#commit' }), cborEncode({ seq, repo: did, rev: `r${seq}`, commit: Cid.ofCbor(commit), ops: wireOps, blocks: car([commit, ...blocks]), time: new Date().toISOString(), tooBig: false, rebase: false, blobs: [] })]);
}

/** Any other subscribeRepos frame (`#identity`, `#info`, an error with `op: -1`). */
export function repoFrame(header: Record<string, unknown>, body: Record<string, unknown>): Buffer {
  return Buffer.concat([cborEncode(header), cborEncode(body)]);
}
