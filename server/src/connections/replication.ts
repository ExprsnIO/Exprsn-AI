import { isIP } from 'node:net';
import pg from 'pg';

/*
 * PostgreSQL logical replication with the `pgoutput` plugin (B-1003), over node-postgres alone: a connection opened
 * with `replication=database` runs START_REPLICATION, the server answers CopyBoth, and every CopyData message carries
 * either WAL data (`w`) or a keepalive (`k`). WAL data holds pgoutput messages (protocol version 1): relations,
 * begin and commit, and row inserts, updates, deletes and truncates with their column values in text form. After a
 * transaction's changes are applied the stream acknowledges its end LSN with a standby status update (`r`), so the
 * slot keeps everything not yet applied across restarts.
 */

/** One change to a row of a published table, with values in the column order of the relation. */
export interface RowChange {
  op: 'insert' | 'update' | 'delete' | 'truncate';
  /** `schema.table`. */
  relation: string;
  columns: string[];
  /** The new row (insert, update), or null. Values are parsed as node-postgres parses query results. */
  values: unknown[] | null;
  /** The old key or old row (delete, and update when the key changed), or null. */
  old: unknown[] | null;
}

/** The changes of one committed transaction, and the LSN that acknowledges it. */
export interface ReplicationBatch {
  lsn: string;
  changes: RowChange[];
}

export interface ReplicationOptions {
  slot: string;
  publication: string;
  /** The table the stream is for: the publication must include it. */
  table: string;
  /** Where to resume; null starts from the slot's confirmed position. */
  startLsn: string | null;
  timeoutMs: number;
}

/** A running stream. `run` resolves when the stream stops, and rejects when it fails. */
export interface ReplicationStream {
  /** `onReady` is called once the slot exists and replication has started. */
  run(onBatch: (b: ReplicationBatch) => Promise<void>, onReady?: () => void): Promise<void>;
  stop(): Promise<void>;
}

// ---------- LSNs ----------

export const lsnToBig = (lsn: string): bigint => {
  const [hi, lo] = lsn.split('/');
  return (BigInt(`0x${hi || '0'}`) << 32n) + BigInt(`0x${lo || '0'}`);
};
export const bigToLsn = (n: bigint): string => `${(n >> 32n).toString(16).toUpperCase()}/${(n & 0xffffffffn).toString(16).toUpperCase()}`;

/** Microseconds since 2000-01-01, the protocol's clock. */
const pgNow = (): bigint => BigInt(Date.now() - 946_684_800_000) * 1000n;

// ---------- pgoutput decoding ----------

export interface RelationInfo {
  id: number;
  name: string;
  columns: { name: string; type: number; key: boolean }[];
}

export type PgOutputMessage =
  | { tag: 'begin'; finalLsn: string; xid: number }
  | { tag: 'commit'; commitLsn: string; endLsn: string }
  | { tag: 'relation'; relation: RelationInfo }
  | { tag: 'insert'; relationId: number; values: (string | null | undefined)[] }
  | { tag: 'update'; relationId: number; old: (string | null | undefined)[] | null; values: (string | null | undefined)[] }
  | { tag: 'delete'; relationId: number; old: (string | null | undefined)[] }
  | { tag: 'truncate'; relationIds: number[] }
  | { tag: 'other'; code: string };

class Reader {
  pos = 0;
  constructor(private readonly b: Buffer) {}
  u8(): number {
    return this.b.readUInt8(this.pos++);
  }
  i16(): number {
    const v = this.b.readInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  i32(): number {
    const v = this.b.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  u64(): bigint {
    const v = this.b.readBigUInt64BE(this.pos);
    this.pos += 8;
    return v;
  }
  lsn(): string {
    return bigToLsn(this.u64());
  }
  str(): string {
    const end = this.b.indexOf(0, this.pos);
    if (end < 0) throw new Error('pgoutput: unterminated string');
    const s = this.b.toString('utf8', this.pos, end);
    this.pos = end + 1;
    return s;
  }
  bytes(n: number): Buffer {
    const v = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  /** TupleData: text values; null for SQL NULL, undefined for an unchanged TOASTed value. */
  tuple(): (string | null | undefined)[] {
    const n = this.i16();
    const out: (string | null | undefined)[] = [];
    for (let i = 0; i < n; i++) {
      const kind = String.fromCharCode(this.u8());
      if (kind === 'n') out.push(null);
      else if (kind === 'u') out.push(undefined);
      else if (kind === 't' || kind === 'b') out.push(this.bytes(this.i32()).toString('utf8'));
      else throw new Error(`pgoutput: unknown tuple value kind ${kind}`);
    }
    return out;
  }
}

/** Decodes one pgoutput message (the payload of an XLogData). */
export function decodePgOutput(buf: Buffer): PgOutputMessage {
  const r = new Reader(buf);
  const code = String.fromCharCode(r.u8());
  switch (code) {
    case 'B': {
      const finalLsn = r.lsn();
      r.u64(); // commit time
      return { tag: 'begin', finalLsn, xid: r.i32() };
    }
    case 'C': {
      r.u8(); // flags
      const commitLsn = r.lsn();
      const endLsn = r.lsn();
      return { tag: 'commit', commitLsn, endLsn };
    }
    case 'R': {
      const id = r.i32();
      const ns = r.str();
      const rel = r.str();
      r.u8(); // replica identity setting
      const n = r.i16();
      const columns: RelationInfo['columns'] = [];
      for (let i = 0; i < n; i++) {
        const flags = r.u8();
        const name = r.str();
        const type = r.i32();
        r.i32(); // type modifier
        columns.push({ name, type, key: (flags & 1) === 1 });
      }
      return { tag: 'relation', relation: { id, name: `${ns === '' ? 'pg_catalog' : ns}.${rel}`, columns } };
    }
    case 'I': {
      const relationId = r.i32();
      r.u8(); // 'N'
      return { tag: 'insert', relationId, values: r.tuple() };
    }
    case 'U': {
      const relationId = r.i32();
      let kind = String.fromCharCode(r.u8());
      let old: (string | null | undefined)[] | null = null;
      if (kind === 'K' || kind === 'O') {
        old = r.tuple();
        kind = String.fromCharCode(r.u8());
      }
      if (kind !== 'N') throw new Error(`pgoutput: update without a new tuple (${kind})`);
      return { tag: 'update', relationId, old, values: r.tuple() };
    }
    case 'D': {
      const relationId = r.i32();
      r.u8(); // 'K' or 'O'
      return { tag: 'delete', relationId, old: r.tuple() };
    }
    case 'T': {
      const n = r.i32();
      r.u8(); // options
      const relationIds: number[] = [];
      for (let i = 0; i < n; i++) relationIds.push(r.i32());
      return { tag: 'truncate', relationIds };
    }
    default:
      return { tag: 'other', code };
  }
}

/** Parses a text value the way node-postgres parses a query result of that type, so both paths agree. */
const parseText = (type: number, v: string | null | undefined): unknown => (v == null ? null : pg.types.getTypeParser(type, 'text')(v));

/**
 * Turns pgoutput messages into committed batches. Changes are held until their transaction commits; unchanged
 * TOASTed values (undefined) are kept as null, so a row whose large value did not change carries no value for it.
 */
export class PgOutputDecoder {
  private readonly relations = new Map<number, RelationInfo>();
  private pending: RowChange[] = [];

  push(msg: PgOutputMessage): ReplicationBatch | null {
    switch (msg.tag) {
      case 'relation':
        this.relations.set(msg.relation.id, msg.relation);
        return null;
      case 'begin':
        this.pending = [];
        return null;
      case 'insert':
      case 'update':
      case 'delete': {
        const rel = this.relations.get(msg.relationId);
        if (!rel) throw new Error(`pgoutput: change for unknown relation ${msg.relationId}`);
        const cols = rel.columns.map((c) => c.name);
        const parse = (t: (string | null | undefined)[] | null) => (t ? t.map((v, i) => parseText(rel.columns[i]?.type ?? 25, v)) : null);
        this.pending.push({ op: msg.tag, relation: rel.name, columns: cols, values: msg.tag === 'delete' ? null : parse(msg.values), old: msg.tag === 'insert' ? null : parse(msg.old) });
        return null;
      }
      case 'truncate':
        for (const id of msg.relationIds) {
          const rel = this.relations.get(id);
          if (rel) this.pending.push({ op: 'truncate', relation: rel.name, columns: rel.columns.map((c) => c.name), values: null, old: null });
        }
        return null;
      case 'commit': {
        const b = { lsn: msg.endLsn, changes: this.pending };
        this.pending = [];
        return b;
      }
      default:
        return null;
    }
  }
}

// ---------- the stream ----------

const SLOT = /^[a-z0-9_]{1,63}$/;
const quoteLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;

export interface PgEndpoint {
  host: string;
  /** The checked address to dial (TLS still verifies `host`). */
  address: string;
  port: number;
  database: string | null;
  user: string | null;
  password: string | null;
  tls: boolean;
}

/** Drops a slot this platform created (when its source is removed), on an ordinary connection. */
export async function dropSlot(ep: PgEndpoint, slot: string, timeoutMs: number): Promise<boolean> {
  if (!SLOT.test(slot)) throw new Error('Invalid slot name.');
  const c = new pg.Client(clientConfig(ep, timeoutMs, false));
  await c.connect();
  try {
    const r = await c.query<{ n: string }>('SELECT count(*) AS n FROM pg_replication_slots WHERE slot_name = $1 AND NOT active', [slot]);
    if (Number(r.rows[0]?.n ?? 0) === 0) return false;
    await c.query('SELECT pg_drop_replication_slot($1)', [slot]);
    return true;
  } finally {
    await c.end().catch(() => undefined);
  }
}

function clientConfig(ep: PgEndpoint, timeoutMs: number, replication: boolean): pg.ClientConfig {
  return {
    host: ep.address,
    port: ep.port,
    database: ep.database ?? undefined,
    user: ep.user ?? undefined,
    password: ep.password ?? undefined,
    ssl: ep.tls ? { rejectUnauthorized: true, ...(isIP(ep.host) ? {} : { servername: ep.host }) } : undefined,
    connectionTimeoutMillis: Math.min(timeoutMs, 10_000),
    application_name: replication ? 'exprsn-ai-replication' : 'exprsn-ai',
    ...(replication ? { replication: 'database' } : {})
  } as pg.ClientConfig;
}

interface CopyDataConnection {
  on(event: 'copyData', fn: (msg: { chunk: Buffer }) => void): void;
  sendCopyFromChunk(chunk: Buffer): void;
}

/**
 * A logical replication stream from one slot. Creates the slot (pgoutput, no snapshot) when it does not exist,
 * checks that the publication includes the table, then streams. Transactions are applied one at a time, in commit
 * order; the stream acknowledges a transaction only after `onBatch` resolved for it, and answers keepalives with the
 * last acknowledged position. The account needs the REPLICATION attribute; the publication is created by the
 * database owner (`CREATE PUBLICATION exprsn_knowledge FOR TABLE …`).
 */
export class PgReplicationStream implements ReplicationStream {
  private client: pg.Client | null = null;
  private stopping = false;
  private applied = 0n;
  private received = 0n;
  private chain: Promise<void> = Promise.resolve();
  private statusTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ep: PgEndpoint,
    private readonly o: ReplicationOptions
  ) {
    if (!SLOT.test(o.slot)) throw new Error('A slot name is lower-case letters, digits and _.');
    if (!SLOT.test(o.publication)) throw new Error('A publication name is lower-case letters, digits and _.');
  }

  async run(onBatch: (b: ReplicationBatch) => Promise<void>, onReady?: () => void): Promise<void> {
    const c = new pg.Client(clientConfig(this.ep, this.o.timeoutMs, true));
    this.client = c;
    await c.connect();
    const [schema, table] = this.o.table.includes('.') ? [this.o.table.slice(0, this.o.table.indexOf('.')), this.o.table.slice(this.o.table.indexOf('.') + 1)] : ['public', this.o.table];
    // Walsender connections take the simple query protocol only: every value here is checked or quoted.
    const pub = await c.query(`SELECT count(*) AS n FROM pg_publication_tables WHERE pubname = ${quoteLiteral(this.o.publication)} AND schemaname = ${quoteLiteral(schema!)} AND tablename = ${quoteLiteral(table!)}`);
    if (Number((pub.rows[0] as { n: string } | undefined)?.n ?? 0) === 0) {
      await c.end().catch(() => undefined);
      throw new Error(`Publication ${this.o.publication} does not include ${this.o.table}. Ask the database owner to run: CREATE PUBLICATION ${this.o.publication} FOR TABLE ${this.o.table}; (or ALTER PUBLICATION … ADD TABLE).`);
    }
    const slot = await c.query(`SELECT plugin, confirmed_flush_lsn FROM pg_replication_slots WHERE slot_name = ${quoteLiteral(this.o.slot)}`);
    if (!slot.rows.length) await c.query(`CREATE_REPLICATION_SLOT ${this.o.slot} LOGICAL pgoutput NOEXPORT_SNAPSHOT`);
    else if ((slot.rows[0] as { plugin: string }).plugin !== 'pgoutput') throw new Error(`Slot ${this.o.slot} exists with another output plugin.`);

    const decoder = new PgOutputDecoder();
    const conn = (c as unknown as { connection: CopyDataConnection }).connection;
    let failed: Error | null = null;
    let finish: (err?: Error) => void = () => undefined;
    const done = new Promise<void>((resolve, reject) => {
      finish = (err) => (err ? reject(err) : resolve());
    });
    const fail = (err: Error) => {
      if (failed || this.stopping) return;
      failed = err;
      finish(err);
      void this.stop();
    };
    conn.on('copyData', (msg) => {
      const chunk = msg.chunk;
      const kind = String.fromCharCode(chunk[0]!);
      if (kind === 'k') {
        const walEnd = chunk.readBigUInt64BE(1);
        if (walEnd > this.received) this.received = walEnd;
        if (chunk[17] === 1) this.status();
        return;
      }
      if (kind !== 'w') return;
      const end = chunk.readBigUInt64BE(9);
      if (end > this.received) this.received = end;
      let msgOut: PgOutputMessage;
      try {
        msgOut = decodePgOutput(chunk.subarray(25));
      } catch (err) {
        fail(err as Error);
        return;
      }
      let batch: ReplicationBatch | null;
      try {
        batch = decoder.push(msgOut);
      } catch (err) {
        fail(err as Error);
        return;
      }
      if (!batch) return;
      const b = batch;
      // One transaction at a time, in commit order; acknowledge only what was applied.
      this.chain = this.chain.then(async () => {
        if (failed || this.stopping) return;
        try {
          if (b.changes.length) await onBatch(b);
          const at = lsnToBig(b.lsn);
          if (at > this.applied) this.applied = at;
          this.status();
        } catch (err) {
          fail(err as Error);
        }
      });
    });
    c.on('error', (err) => fail(err));
    c.on('end', () => {
      if (failed) return;
      if (this.stopping) finish();
      else fail(new Error('The replication connection closed.'));
    });
    this.applied = this.o.startLsn ? lsnToBig(this.o.startLsn) : 0n;
    c.query(`START_REPLICATION SLOT ${this.o.slot} LOGICAL ${this.o.startLsn ?? '0/0'} (proto_version '1', publication_names ${quoteLiteral(this.o.publication)})`, (err: Error | null) => {
      if (err) fail(err);
      else if (!this.stopping) fail(new Error('The server ended replication.'));
    });
    this.statusTimer = setInterval(() => this.status(), 10_000);
    this.statusTimer.unref();
    onReady?.();
    return done;
  }

  /** Standby status update: written and flushed up to what was received, applied up to what was applied. */
  private status(): void {
    const c = this.client;
    if (!c || this.stopping) return;
    const b = Buffer.alloc(34);
    b.write('r', 0);
    const applied = this.applied;
    // The flush position is what the slot keeps: only what was applied.
    b.writeBigUInt64BE(this.received > applied ? this.received : applied, 1);
    b.writeBigUInt64BE(applied, 9);
    b.writeBigUInt64BE(applied, 17);
    b.writeBigUInt64BE(pgNow(), 25);
    b.writeUInt8(0, 33);
    try {
      (c as unknown as { connection: CopyDataConnection }).connection.sendCopyFromChunk(b);
    } catch {
      // the connection is going away; the next run resumes from the slot
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.statusTimer) clearInterval(this.statusTimer);
    const c = this.client;
    this.client = null;
    await this.chain.catch(() => undefined);
    await c?.end().catch(() => undefined);
  }
}
