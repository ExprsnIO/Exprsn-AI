import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { cborDecode, type CborValue } from '../src/atproto/cbor.js';
import { parseMultikey } from '../src/atproto/crypto.js';
import type { Cid } from '../src/atproto/encoding.js';
import { readCarVerified } from '../src/atproto/pds/car.js';
import { decodeNode } from '../src/atproto/pds/mst.js';
import { decodeCommit, verifyCommit } from '../src/atproto/pds/repo.js';
import { readFrame } from '../src/atproto/stream.js';

/*
 * Sprint 31 (B-2904): a relay double. It answers `com.atproto.sync.requestCrawl` (recording who asked), and crawls a
 * PDS the way a relay does: subscribeRepos from a cursor, each `#commit` checked as sync 1.1 asks (the CAR's hashes,
 * the commit signed by the key the DID document names, and every operation proven against the new tree with the
 * blocks the event carries), and the records kept per repo. A commit that fails a check is recorded as rejected.
 */

export interface RelayEvent {
  seq: number;
  type: string;
  body: Record<string, unknown>;
}

/** Looks a key up in an MST using only the blocks given; `missing` when the proof lacks a node on the path. */
export function proveKey(blocks: Map<string, Buffer>, root: Cid, key: string): { found: Cid | null } | { missing: string } {
  let cid: Cid | null = root;
  while (cid) {
    const bytes = blocks.get(cid.toString());
    if (!bytes) return { missing: cid.toString() };
    const n = decodeNode(bytes);
    let next: Cid | null = n.left;
    for (const e of n.entries) {
      const c = Buffer.compare(Buffer.from(key), Buffer.from(e.key));
      if (c === 0) return { found: e.value };
      if (c < 0) break;
      next = e.right;
    }
    cid = next;
  }
  return { found: null };
}

export class FakeRelay {
  url = '';
  readonly crawlRequests: { hostname: string }[] = [];
  readonly events: RelayEvent[] = [];
  readonly rejected: { seq: number; reason: string }[] = [];
  /** Records per repo, as the relay saw them: `collection/rkey` → record. */
  readonly repos = new Map<string, Map<string, Record<string, unknown>>>();
  cursor: number | null = null;
  private server: Server | null = null;

  constructor(private readonly didKey: (did: string) => Promise<string>) {}

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/xrpc/com.atproto.sync.requestCrawl') {
          try {
            this.crawlRequests.push(JSON.parse(body) as { hostname: string });
          } catch {
            res.writeHead(400).end();
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
          return;
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise((r) => this.server?.close(r));
  }

  private async check(body: Record<string, unknown>): Promise<string | null> {
    const car = readCarVerified(body.blocks as Buffer);
    const commitCid = body.commit as Cid;
    const cb = car.blocks.get(commitCid.toString());
    if (!cb) return 'commit block missing';
    const commit = decodeCommit(cb);
    if (commit.did !== body.repo || commit.rev !== body.rev) return 'commit does not match the event';
    const { curve, key } = parseMultikey(await this.didKey(commit.did));
    if (!verifyCommit(commit, curve, key)) return 'bad signature';
    const repo = this.repos.get(commit.did) ?? new Map<string, Record<string, unknown>>();
    for (const op of body.ops as { action: string; path: string; cid: Cid | null }[]) {
      const proof = proveKey(car.blocks, commit.data, op.path);
      if ('missing' in proof) return `proof of ${op.path} lacks ${proof.missing}`;
      if (op.action === 'delete') {
        if (proof.found) return `${op.path} still in the tree`;
        repo.delete(op.path);
      } else {
        if (!proof.found || !op.cid || !proof.found.equals(op.cid)) return `${op.path} not in the tree as stated`;
        const rec = car.blocks.get(op.cid.toString());
        if (!rec) return `record ${op.path} missing`;
        repo.set(op.path, cborDecode(rec) as Record<string, unknown>);
      }
    }
    this.repos.set(commit.did, repo);
    return null;
  }

  /** Subscribes to a PDS from a cursor (or live) and handles events until `count` arrive or `ms` pass quietly. */
  crawl(wsUrl: string, o: { cursor?: number | null; count?: number; ms?: number } = {}): Promise<{ frames: number; error: string | null; infos: string[] }> {
    const url = new URL(`${wsUrl.replace(/\/$/, '')}/xrpc/com.atproto.sync.subscribeRepos`);
    const cursor = o.cursor === undefined ? this.cursor : o.cursor;
    if (cursor !== null) url.searchParams.set('cursor', String(cursor));
    return new Promise((resolve) => {
      const ws = new WebSocket(url);
      let frames = 0;
      let error: string | null = null;
      const infos: string[] = [];
      let chain = Promise.resolve();
      let idle: NodeJS.Timeout;
      const finish = () => {
        clearTimeout(idle);
        ws.removeAllListeners('message');
        ws.terminate();
        void chain.then(() => resolve({ frames, error, infos }));
      };
      const arm = () => {
        clearTimeout(idle);
        idle = setTimeout(finish, o.ms ?? 500);
      };
      arm();
      ws.on('message', (data: Buffer) => {
        arm();
        const f = readFrame(data);
        if (f.header.op === -1) {
          error = String(f.body.error);
          return finish();
        }
        if (f.header.t === '#info') {
          infos.push(String(f.body.name));
          return;
        }
        frames++;
        const seq = f.body.seq as number;
        chain = chain.then(async () => {
          const ev: RelayEvent = { seq, type: String(f.header.t).slice(1), body: f.body as Record<string, CborValue> as Record<string, unknown> };
          this.events.push(ev);
          if (ev.type === 'commit') {
            const problem = await this.check(ev.body).catch((err: unknown) => (err as Error).message);
            if (problem) this.rejected.push({ seq, reason: problem });
          }
          this.cursor = seq;
        });
        if (o.count && frames >= o.count) finish();
      });
      ws.on('error', (err) => {
        error ??= err.message;
        finish();
      });
      ws.on('close', finish);
    });
  }
}
