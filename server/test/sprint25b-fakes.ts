import { createECDH, createPrivateKey, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { cborEncode } from '../src/atproto/cbor.js';
import { compressPublicKey, formatDidKey, normaliseLowS, type Curve } from '../src/atproto/crypto.js';
import { didDocument, plcDidForGenesis, plcOperationCid, verifyPlcOperation, type PlcOperation } from '../src/atproto/did.js';

/*
 * Test doubles for Sprint 25 (B-1609 to B-1611): a PLC directory that checks every operation as plc.directory does
 * (genesis DID derivation, `prev` chaining, a signature by a rotation key in force) and serves DID documents, and an
 * external labeler that serves `com.atproto.label.subscribeLabels` frames from a cursor. Both listen on 127.0.0.1.
 */

/** A key pair on an AT-Protocol curve, made in the test (the server's own keys are never in-process). */
export function testKey(curve: Curve = 'secp256k1'): { privateKey: KeyObject; didKey: string; multikey: string; sign(data: Buffer): Buffer } {
  const pair = generateKeyPairSync('ec', { namedCurve: curve === 'secp256k1' ? 'secp256k1' : 'P-256' });
  const c = compressPublicKey(pair.publicKey);
  const didKey = formatDidKey(curve, c.compressed);
  return { privateKey: pair.privateKey, didKey, multikey: didKey.slice('did:key:'.length), sign: (data) => normaliseLowS(curve, cryptoSign('sha256', data, { key: pair.privateKey, dsaEncoding: 'ieee-p1363' })) };
}

/** A private key from its raw 32-byte scalar (for known-answer vectors). */
export function keyFromScalar(curve: Curve, d: Buffer): { privateKey: KeyObject; compressed: Buffer } {
  const ecdh = createECDH(curve === 'secp256k1' ? 'secp256k1' : 'prime256v1');
  ecdh.setPrivateKey(d);
  const pub = ecdh.getPublicKey();
  const privateKey = createPrivateKey({ key: { kty: 'EC', crv: curve === 'secp256k1' ? 'secp256k1' : 'P-256', d: d.toString('base64url'), x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  return { privateKey, compressed: ecdh.getPublicKey(null, 'compressed') };
}

export class FakePlcDirectory {
  url = '';
  /** Every operation accepted, per DID, in order. */
  readonly log = new Map<string, PlcOperation[]>();
  readonly refused: { did: string; reason: string }[] = [];
  /** Documents served for DIDs registered directly (external parties in tests). */
  readonly documents = new Map<string, unknown>();
  private server: Server | null = null;

  private accept(did: string, op: PlcOperation): string | null {
    if (op.type !== 'plc_operation' || !op.sig || !Array.isArray(op.rotationKeys) || !op.rotationKeys.length) return 'malformed operation';
    const ops = this.log.get(did) ?? [];
    if (!ops.length) {
      if (op.prev !== null) return 'genesis must have prev null';
      if (plcDidForGenesis(op) !== did) return 'the DID does not match the genesis operation';
      if (!verifyPlcOperation(op, op.rotationKeys)) return 'invalid signature';
    } else {
      const last = ops.at(-1)!;
      if (op.prev !== plcOperationCid(last)) return 'prev does not match the last operation';
      if (!verifyPlcOperation(op, last.rotationKeys)) return 'invalid signature: not a rotation key in force';
    }
    this.log.set(did, [...ops, op]);
    return null;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const send = (status: number, data: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(data));
        };
        const m = /^\/(did:plc:[a-z2-7]{24})(\/log)?$/.exec(req.url ?? '');
        if (!m) return send(404, { message: 'not found' });
        const did = m[1]!;
        if (req.method === 'POST' && !m[2]) {
          let op: PlcOperation;
          try {
            op = JSON.parse(body) as PlcOperation;
          } catch {
            return send(400, { message: 'bad json' });
          }
          const problem = this.accept(did, op);
          if (problem) {
            this.refused.push({ did, reason: problem });
            return send(400, { message: problem });
          }
          return send(200, {});
        }
        if (req.method === 'GET' && m[2]) return send(200, this.log.get(did) ?? []);
        if (req.method === 'GET') {
          const direct = this.documents.get(did);
          if (direct) return send(200, direct);
          const last = this.log.get(did)?.at(-1);
          if (!last) return send(404, { message: `DID not registered: ${did}` });
          return send(200, didDocument(did, last));
        }
        send(405, { message: 'method not allowed' });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

/** An external labeler: a DID (registered in the fake PLC directory) and a subscribeLabels stream. */
export class FakeLabeler {
  url = '';
  readonly did = `did:plc:${'fakelabeler'.padEnd(24, 'a').replace(/[^a-z2-7]/g, 'a')}`;
  key = testKey('secp256k1');
  /** Messages: seq and the labels (CBOR-ready objects) it carries. */
  readonly events: { seq: number; labels: Record<string, unknown>[] }[] = [];
  readonly cursors: (string | null)[] = [];
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;

  constructor(private readonly plc: FakePlcDirectory) {}

  document() {
    return didDocument(this.did, { alsoKnownAs: ['at://labeler.example.org'], verificationMethods: { atproto_label: this.key.didKey }, services: { atproto_labeler: { type: 'AtprotoLabeler', endpoint: this.url } } });
  }

  /** Publishes the current document (after start, and after a key rotation). */
  publish(): void {
    this.plc.documents.set(this.did, this.document());
  }

  rotate(): void {
    this.key = testKey('secp256k1');
    this.publish();
  }

  /** A label signed by the labeler's key (or by `signWith`, to make a bad signature). */
  label(uri: string, val: string, o: { neg?: boolean; signWith?: ReturnType<typeof testKey> } = {}): Record<string, unknown> {
    const l = { ver: 1, src: this.did, uri, val, neg: o.neg ?? false, cts: new Date().toISOString() };
    return { ...l, sig: (o.signWith ?? this.key).sign(cborEncode(l)) };
  }

  add(labels: Record<string, unknown>[]): number {
    const seq = (this.events.at(-1)?.seq ?? 0) + 1;
    this.events.push({ seq, labels });
    return seq;
  }

  async start(): Promise<void> {
    this.server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    this.wss = new WebSocketServer({ server: this.server, path: '/xrpc/com.atproto.label.subscribeLabels' });
    this.wss.on('connection', (ws: WebSocket, req) => {
      const cursor = new URL(req.url ?? '/', 'http://x').searchParams.get('cursor');
      this.cursors.push(cursor);
      const from = cursor === null ? (this.events.at(-1)?.seq ?? 0) : Number(cursor);
      for (const e of this.events) if (e.seq > from) ws.send(Buffer.concat([cborEncode({ op: 1, t: '#labels' }), cborEncode({ seq: e.seq, labels: e.labels })]));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    this.publish();
  }

  async stop(): Promise<void> {
    for (const c of this.wss?.clients ?? []) c.terminate();
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
