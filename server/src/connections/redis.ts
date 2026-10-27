import { isIP } from 'node:net';
import { Redis } from 'ioredis';
import { checkHost, parseAllowList, type AllowList } from '../mcp/hosts.js';
import type { Classification } from './classify.js';
import type { DdlPlan } from './ddl.js';
import type { DescribeKind, DocumentDescription } from './ddl-edit-types.js';
import { hostPort, type ConnectionSpec, type DataDriver, type QueueInfo, type QueryResult, type SchemaObject, type TestResult } from './drivers.js';
import type { NonSqlContext } from './nonsql.js';
import { hasGlob } from './patterns.js';

/*
 * 1.9.0: Redis as a read-only data connection.
 *
 * - A query is one command from a fixed read set, as a redis-cli line (`HGETALL user:42`, "…" and '…' quoting with
 *   backslash escapes) or as JSON `{"command": "HGETALL", "args": ["user:42"]}` (so saved queries bind parameters with
 *   `{"$param": …}`). Writes are refused as `write`; everything else (KEYS, scripts, CONFIG, ACL, SELECT, pub/sub,
 *   transactions, unknown commands) as `denied`. The objects are the keys a command reads, and for SCAN its MATCH
 *   pattern, checked by the service against the allow-list of key names and globs (patterns.ts).
 * - The driver sends only the classified command (`op`), on its own connection to the checked address (TLS verifies
 *   the name), in RESP2, with no offline queue and no retries. Ranges are capped to the row limit before they are
 *   sent; SCAN walks cursors until the limit or the connection's scan limit.
 * - `test` asks ACL DRYRUN whether the user could SET: an account that could, or whose ACL cannot be read, shows as
 *   not read-only (Redis has no read-only transaction: use an ACL user with +@read -@write).
 * - 2.0.x: the query box still only reads. `queues` (the Queues tab) sends only reads on the read account: SCAN with
 *   MATCH per allow-list glob, TYPE, LLEN, ZCARD, HGET, XINFO STREAM and XINFO GROUPS, PUBSUB CHANNELS and NUMSUB
 *   (skipped when the ACL refuses them). Lists, streams with their consumer groups, delayed-looking sorted sets, BullMQ
 *   queues (`<prefix>:<queue>`, found by their `:meta` hash or `:id` counter) and pub/sub channels are listed when the
 *   allow-list accepts them. Making a stream consumer group (XGROUP CREATE) happens only through a previewed schema
 *   plan (`applyDdl`), on the connection's separate admin account, which needs `+xgroup|create` on the stream keys;
 *   the read account never needs it.
 * - 2.0.x editing: a plan may also remove a group (XGROUP DESTROY) or move its last-delivered id (XGROUP SETID), on
 *   the admin account, which then needs `+xgroup|destroy` and `+xgroup|setid` too. `describe` reads a stream's groups
 *   on the read account with TYPE and XINFO GROUPS only (`+type +xinfo|groups`), nothing else.
 */

export interface RedisOp extends Record<string, unknown> {
  command: string;
  args: string[];
}

type Keys = (args: string[]) => string[] | string;

const first: Keys = (a) => (a.length ? [a[0]!] : 'needs a key');
const all: Keys = (a) => (a.length ? a : 'needs at least one key');

/** The read set and where each command's keys are. A string answer is the problem with the arguments. */
const READ: Record<string, { keys: Keys; min: number; max?: number }> = {
  GET: { keys: first, min: 1, max: 1 },
  MGET: { keys: all, min: 1 },
  STRLEN: { keys: first, min: 1, max: 1 },
  GETRANGE: { keys: first, min: 3, max: 3 },
  EXISTS: { keys: all, min: 1 },
  TYPE: { keys: first, min: 1, max: 1 },
  TTL: { keys: first, min: 1, max: 1 },
  PTTL: { keys: first, min: 1, max: 1 },
  HGET: { keys: first, min: 2, max: 2 },
  HMGET: { keys: first, min: 2 },
  HGETALL: { keys: first, min: 1, max: 1 },
  HKEYS: { keys: first, min: 1, max: 1 },
  HVALS: { keys: first, min: 1, max: 1 },
  HLEN: { keys: first, min: 1, max: 1 },
  HEXISTS: { keys: first, min: 2, max: 2 },
  HSCAN: { keys: first, min: 2 },
  LRANGE: { keys: first, min: 3, max: 3 },
  LLEN: { keys: first, min: 1, max: 1 },
  LINDEX: { keys: first, min: 2, max: 2 },
  SMEMBERS: { keys: first, min: 1, max: 1 },
  SISMEMBER: { keys: first, min: 2, max: 2 },
  SCARD: { keys: first, min: 1, max: 1 },
  SSCAN: { keys: first, min: 2 },
  ZRANGE: { keys: first, min: 3 },
  ZRANGEBYSCORE: { keys: first, min: 3 },
  ZREVRANGE: { keys: first, min: 3 },
  ZCARD: { keys: first, min: 1, max: 1 },
  ZSCORE: { keys: first, min: 2, max: 2 },
  ZSCAN: { keys: first, min: 2 },
  XRANGE: { keys: first, min: 3 },
  XREVRANGE: { keys: first, min: 3 },
  XLEN: { keys: first, min: 1, max: 1 },
  'XINFO STREAM': { keys: first, min: 1 },
  'JSON.GET': { keys: first, min: 1 },
  'TS.RANGE': { keys: first, min: 3 },
  'TS.REVRANGE': { keys: first, min: 3 },
  'TS.GET': { keys: first, min: 1, max: 1 },
  'TS.INFO': { keys: first, min: 1, max: 2 },
  SCAN: { keys: () => [], min: 1 }
};

const WRITE = new Set(
  (
    'SET SETNX SETEX PSETEX MSET MSETNX APPEND INCR INCRBY INCRBYFLOAT DECR DECRBY DEL UNLINK EXPIRE EXPIREAT PEXPIRE PEXPIREAT PERSIST RENAME RENAMENX COPY MOVE ' +
    'GETDEL GETEX GETSET HSET HSETNX HMSET HDEL HINCRBY HINCRBYFLOAT HEXPIRE HPEXPIRE HPERSIST HGETDEL HGETEX HSETEX LPUSH LPUSHX RPUSH RPUSHX LPOP RPOP BLPOP BRPOP BLMOVE LMOVE LMPOP BLMPOP LSET LREM LTRIM ' +
    'LINSERT RPOPLPUSH BRPOPLPUSH SADD SREM SPOP SMOVE ZADD ZREM ZINCRBY ZPOPMIN ZPOPMAX BZPOPMIN BZPOPMAX ZMPOP BZMPOP ZREMRANGEBYSCORE ZREMRANGEBYRANK ZREMRANGEBYLEX ' +
    'XADD XDEL XTRIM XGROUP XACK XCLAIM XAUTOCLAIM XREADGROUP XSETID PFADD PFMERGE PFCOUNT SETBIT SETRANGE BITOP BITFIELD SORT GEOADD GEORADIUS GEORADIUSBYMEMBER ' +
    'PUBLISH SPUBLISH TOUCH JSON.SET JSON.DEL JSON.FORGET JSON.MSET JSON.MERGE JSON.NUMINCRBY JSON.NUMMULTBY JSON.STRAPPEND JSON.ARRAPPEND JSON.ARRINSERT JSON.ARRPOP JSON.ARRTRIM JSON.CLEAR JSON.TOGGLE ' +
    'TS.ADD TS.MADD TS.CREATE TS.DEL TS.ALTER TS.INCRBY TS.DECRBY TS.CREATERULE TS.DELETERULE'
  ).split(' ')
);

const DENIED = new Set(
  (
    'KEYS EVAL EVALSHA EVAL_RO EVALSHA_RO FCALL FCALL_RO SCRIPT FUNCTION CONFIG DEBUG MODULE CLIENT MONITOR SUBSCRIBE PSUBSCRIBE SSUBSCRIBE UNSUBSCRIBE PUNSUBSCRIBE SUNSUBSCRIBE ' +
    'SELECT SWAPDB MIGRATE DUMP RESTORE RESTORE-ASKING SHUTDOWN FLUSHALL FLUSHDB ACL CLUSTER REPLICAOF SLAVEOF OBJECT MEMORY WAIT WAITAOF MULTI EXEC DISCARD WATCH UNWATCH ' +
    'SAVE BGSAVE BGREWRITEAOF AUTH HELLO QUIT RESET LATENCY SLOWLOG COMMAND SYNC PSYNC FAILOVER LOLWUT INFO PING'
  ).split(' ')
);

/** Splits a redis-cli line: whitespace between arguments, "…" with backslash escapes, '…' with \' only. */
export function splitCommandLine(line: string): string[] | string {
  const out: string[] = [];
  let i = 0;
  const s = line.trim();
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (i >= s.length) break;
    let arg = '';
    let quoted = false;
    while (i < s.length && !/\s/.test(s[i]!)) {
      const c = s[i]!;
      if (c === '"') {
        quoted = true;
        i++;
        let closed = false;
        while (i < s.length) {
          const d = s[i]!;
          if (d === '\\' && i + 1 < s.length) {
            const e = s[i + 1]!;
            if (e === 'x' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 2, i + 4))) {
              arg += String.fromCharCode(parseInt(s.slice(i + 2, i + 4), 16));
              i += 4;
            } else {
              arg += ({ n: '\n', r: '\r', t: '\t', b: '\b', a: '\x07' } as Record<string, string>)[e] ?? e;
              i += 2;
            }
          } else if (d === '"') {
            i++;
            closed = true;
            break;
          } else {
            arg += d;
            i++;
          }
        }
        if (!closed) return 'an unterminated "…" string';
      } else if (c === "'") {
        quoted = true;
        i++;
        let closed = false;
        while (i < s.length) {
          if (s[i] === '\\' && s[i + 1] === "'") {
            arg += "'";
            i += 2;
          } else if (s[i] === "'") {
            i++;
            closed = true;
            break;
          } else arg += s[i++];
        }
        if (!closed) return "an unterminated '…' string";
      } else {
        arg += c;
        i++;
      }
    }
    if (arg || quoted) out.push(arg);
  }
  return out;
}

/** The command line or JSON as a command and its arguments; a string is why it could not be read. */
function parse(query: string): { command: string; args: string[] } | string {
  const t = query.trim();
  if (!t) return 'The query is empty.';
  let parts: string[];
  if (t.startsWith('{')) {
    let doc: unknown;
    try {
      doc = JSON.parse(t);
    } catch {
      return 'The JSON form is not valid JSON.';
    }
    const d = doc as { command?: unknown; args?: unknown };
    if (!d || typeof d !== 'object' || typeof d.command !== 'string' || (d.args !== undefined && !Array.isArray(d.args))) return 'The JSON form is {"command": "HGETALL", "args": ["user:42"]}.';
    if (Object.keys(d).some((k) => k !== 'command' && k !== 'args')) return 'The JSON form takes command and args only.';
    const args = (d.args as unknown[] | undefined) ?? [];
    if (args.some((a) => a === null || (typeof a !== 'string' && typeof a !== 'number' && typeof a !== 'boolean'))) return 'Arguments are strings or numbers.';
    parts = [...d.command.trim().split(/\s+/), ...args.map((a) => String(a))];
  } else {
    const split = splitCommandLine(t);
    if (typeof split === 'string') return `The command has ${split}.`;
    parts = split;
  }
  if (!parts.length || !parts[0]) return 'The query names no command.';
  if (parts.length > 1001) return 'At most 1,000 arguments.';
  if (parts.some((p) => p.length > 65_536)) return 'An argument is longer than 64 KB.';
  let command = parts[0]!.toUpperCase();
  let args = parts.slice(1);
  if (command === 'XINFO' && args.length) {
    command = `XINFO ${args[0]!.toUpperCase()}`;
    args = args.slice(1);
  }
  return { command, args };
}

const optionValue = (args: string[], name: string): string | null => {
  for (let i = 0; i < args.length - 1; i++) if (args[i]!.toUpperCase() === name) return args[i + 1]!;
  return null;
};

/** One Redis command, read-only, from the fixed set. */
export function classifyRedis(query: string, object: string | null, _ctx?: NonSqlContext): Classification {
  const p = parse(query);
  if (typeof p === 'string') return { kind: 'unparsed', verb: null, objects: [], reason: p };
  const { command } = p;
  let { args } = p;
  const base = command.split(' ')[0]!;
  if (WRITE.has(base) || /STORE$/.test(base)) return { kind: 'write', verb: command, objects: [], reason: `${command} changes data. Redis connections only read.` };
  if (base === 'XINFO' && command !== 'XINFO STREAM') return { kind: 'denied', verb: command, objects: [], denied: command, reason: 'Only XINFO STREAM is read.' };
  const spec = READ[command];
  if (!spec) {
    const why = base === 'KEYS' ? 'KEYS walks the whole keyspace in one call; use SCAN with MATCH.' : base === 'INFO' || base === 'PING' ? `${base} is sent by the connection test only.` : DENIED.has(base) ? `${base} is not allowed on a connection.` : `${command} is not one of the read commands a Redis connection runs.`;
    return { kind: 'denied', verb: command, objects: [], denied: command, reason: why };
  }
  // The key picked in the schema tree stands in for a missing one.
  if (command !== 'SCAN' && args.length < spec.min && object && !/[*?[]/.test(object)) args = [object, ...args];
  if (command === 'SCAN' && args.length === 0) args = ['0'];
  if (command === 'SCAN' && object && !optionValue(args, 'MATCH')) args = [...args, 'MATCH', object];
  if (args.length < spec.min || (spec.max !== undefined && args.length > spec.max)) return { kind: 'unparsed', verb: command, objects: [], reason: `${command} takes ${spec.max === spec.min ? spec.min : spec.max === undefined ? `at least ${spec.min}` : `${spec.min} to ${spec.max}`} argument${spec.min === 1 && spec.max === 1 ? '' : 's'}.` };
  if (/^[HSZ]SCAN$/.test(command) || command === 'SCAN') {
    const cursorAt = command === 'SCAN' ? 0 : 1;
    if (!/^\d+$/.test(args[cursorAt] ?? '')) return { kind: 'unparsed', verb: command, objects: [], reason: `${command}'s cursor is a number.` };
    const opts = args.slice(cursorAt + 1);
    for (let i = 0; i < opts.length; i += 2) {
      const o = opts[i]!.toUpperCase();
      const allowedOpts = command === 'SCAN' ? ['MATCH', 'COUNT', 'TYPE'] : ['MATCH', 'COUNT', 'NOVALUES'];
      if (!allowedOpts.includes(o)) return { kind: 'unparsed', verb: command, objects: [], reason: `${command} takes ${allowedOpts.join(', ')}.` };
      if (o === 'NOVALUES') {
        i--;
        continue;
      }
      if (opts[i + 1] === undefined) return { kind: 'unparsed', verb: command, objects: [], reason: `${o} needs a value.` };
      if (o === 'COUNT') {
        const n = Number(opts[i + 1]);
        if (!Number.isInteger(n) || n < 1) return { kind: 'unparsed', verb: command, objects: [], reason: 'COUNT is a positive number.' };
        opts[i + 1] = String(Math.min(n, 1000));
      }
    }
    args = [...args.slice(0, cursorAt + 1), ...opts];
  }
  if (command === 'SCAN') {
    const match = optionValue(args, 'MATCH');
    if (!match) return { kind: 'denied', verb: command, objects: [], denied: 'SCAN', reason: 'SCAN needs MATCH with a pattern under the allow-list (pick a key pattern in the schema tree).' };
    return { kind: 'read', verb: command, objects: [match], op: { command, args } satisfies RedisOp };
  }
  const keys = spec.keys(args);
  if (typeof keys === 'string') return { kind: 'unparsed', verb: command, objects: [], reason: `${command} ${keys}.` };
  return { kind: 'read', verb: command, objects: [...new Set(keys)], op: { command, args } satisfies RedisOp };
}

// ---------- the driver ----------

const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8,})$/i;

/** A key's pattern for the schema tree: its last id-like `:` segment as `*` (the key itself when it has none). */
export function keyPattern(key: string): string {
  const segs = key.split(':');
  for (let i = segs.length - 1; i >= 0; i--) {
    if (ID_SEGMENT.test(segs[i]!)) {
      segs[i] = '*';
      return segs.join(':');
    }
  }
  return key;
}

const str = (v: unknown): unknown => (Buffer.isBuffer(v) ? v.toString('utf8') : v);
const pairs = (flat: unknown[]): [unknown, unknown][] => {
  const out: [unknown, unknown][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([str(flat[i]), str(flat[i + 1])]);
  return out;
};
const nested = (v: unknown): unknown => (Array.isArray(v) ? Object.fromEntries(pairs(v).map(([k, x]) => [String(k), Array.isArray(x) ? nested(x) : x])) : str(v));

export class RedisDriver implements DataDriver {
  constructor(
    private readonly spec: ConnectionSpec,
    private readonly allow: AllowList = parseAllowList('')
  ) {}

  private get scanLimit(): number {
    const n = Number(this.spec.options?.scanLimit ?? 10_000);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 100_000) : 10_000;
  }

  private async client<T>(timeoutMs: number, fn: (r: Redis) => Promise<T>): Promise<T> {
    const { host, port } = hostPort(this.spec.endpoint, 6379);
    const db = this.spec.database == null || this.spec.database === '' ? 0 : Number(this.spec.database);
    if (!Number.isInteger(db) || db < 0 || db > 15) throw new Error('The database number is 0 to 15.');
    // Resolve and check once, then dial the checked address (TLS still verifies the name), so DNS cannot rebind.
    const { addresses } = await checkHost(host, this.allow);
    const r = new Redis({
      host: addresses[0]!,
      port,
      db,
      ...(this.spec.username ? { username: this.spec.username } : {}),
      ...(this.spec.password ? { password: this.spec.password } : {}),
      ...(this.spec.tls ? { tls: { rejectUnauthorized: true, ...(isIP(host) ? {} : { servername: host }) } } : {}),
      protocol: 2,
      disableClientInfo: true,
      enableReadyCheck: false,
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      reconnectOnError: () => false,
      autoResubscribe: false,
      connectTimeout: Math.min(timeoutMs, 10_000),
      commandTimeout: timeoutMs
    });
    r.on('error', () => undefined);
    try {
      await r.connect();
      return await fn(r);
    } finally {
      await r.quit().catch(() => r.disconnect());
    }
  }

  async test(timeoutMs: number): Promise<TestResult> {
    return this.client(timeoutMs, async (r) => {
      await r.call('PING');
      const info = String(await r.call('INFO', 'server'));
      const version = /redis_version:([^\r\n]+)/.exec(info)?.[1]?.trim() ?? /valkey_version:([^\r\n]+)/.exec(info)?.[1]?.trim() ?? 'unknown';
      let readOnly = false;
      let detail: string;
      try {
        const user = String(await r.call('ACL', 'WHOAMI'));
        const dry = String(await r.call('ACL', 'DRYRUN', user, 'SET', 'exprsn:write-probe', 'x'));
        readOnly = dry !== 'OK';
        detail = readOnly ? `ACL user ${user} may not write (ACL DRYRUN refuses SET).` : `ACL user ${user} may write (ACL DRYRUN allows SET). Only read commands are sent; use an ACL user with +@read -@write.`;
      } catch {
        detail = 'The account\'s ACL could not be read (Redis before 7, or ACL not permitted), so it may be able to write. Only read commands are sent; use an ACL user with +@read -@write.';
      }
      return { version: `Redis ${version}`, readOnly, health: 'healthy', detail };
    });
  }

  async introspect(timeoutMs: number): Promise<SchemaObject[]> {
    return this.client(timeoutMs, async (r) => {
      const groups = new Map<string, { count: number; sample: string }>();
      let cursor = '0';
      let walked = 0;
      do {
        const [next, keys] = (await r.call('SCAN', cursor, 'COUNT', '1000')) as [string, unknown[]];
        cursor = String(next);
        for (const k of keys.map((x) => String(str(x)))) {
          walked++;
          const p = keyPattern(k);
          const g = groups.get(p);
          if (g) g.count++;
          else if (groups.size < 500) groups.set(p, { count: 1, sample: k });
        }
      } while (cursor !== '0' && walked < this.scanLimit);
      const list = [...groups.entries()];
      const pipe = r.pipeline();
      for (const [, g] of list) pipe.call('TYPE', g.sample);
      const types = ((await pipe.exec()) ?? []).map(([err, v]) => (err ? 'unknown' : String(v)));
      return list
        .map(([name, g], i) => ({ name, kind: 'keyspace' as const, columns: [{ name: 'type', type: types[i] ?? 'unknown' }, { name: 'keys', type: `${g.count}${cursor !== '0' ? '+' : ''}` }] }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
    });
  }

  async query(c: Classification, _text: string, opts: { limit: number; timeoutMs: number; params?: unknown[]; offset?: number }): Promise<QueryResult> {
    const op = c.op as RedisOp | undefined;
    if (c.kind !== 'read' || !op || typeof op.command !== 'string' || !Array.isArray(op.args)) throw new Error('Only a classified read command is sent to Redis.');
    const limit = Math.max(1, opts.limit);
    return this.client(opts.timeoutMs, (r) => this.run(r, op, limit));
  }

  private async run(r: Redis, op: RedisOp, limit: number): Promise<QueryResult> {
    const { command } = op;
    const args = [...op.args];
    const send = (cmd: string, a: string[]) => r.call(...(cmd.split(' ') as [string, ...string[]]), ...a) as Promise<unknown>;
    const done = (columns: string[], rows: unknown[][], more = false): QueryResult => ({ columns, rows: rows.slice(0, limit), capped: more || rows.length > limit, estimate: null });
    const key = args[0] ?? '';
    switch (command) {
      case 'GET':
      case 'GETRANGE':
      case 'STRLEN':
      case 'TYPE':
      case 'TTL':
      case 'PTTL':
      case 'HLEN':
      case 'LLEN':
      case 'SCARD':
      case 'ZCARD':
      case 'XLEN':
      case 'EXISTS':
        return done(['key', 'value'], [[command === 'EXISTS' ? args.join(' ') : key, str(await send(command, args))]]);
      case 'HGET':
      case 'HEXISTS':
      case 'SISMEMBER':
      case 'ZSCORE':
      case 'LINDEX':
        return done(['key', ({ HGET: 'field', HEXISTS: 'field', SISMEMBER: 'member', ZSCORE: 'member', LINDEX: 'index' } as Record<string, string>)[command]!, 'value'], [[key, args[1], str(await send(command, args))]]);
      case 'MGET': {
        const keys = args.slice(0, limit + 1);
        const vals = (await send('MGET', keys)) as unknown[];
        return done(['key', 'value'], keys.map((k, i) => [k, str(vals[i])]), args.length > keys.length);
      }
      case 'HMGET': {
        const vals = (await send('HMGET', args)) as unknown[];
        return done(['field', 'value'], args.slice(1).map((f, i) => [f, str(vals[i])]));
      }
      case 'HGETALL':
        return done(['field', 'value'], pairs((await send('HGETALL', args)) as unknown[]));
      case 'HKEYS':
        return done(['field'], ((await send('HKEYS', args)) as unknown[]).map((x) => [str(x)]));
      case 'HVALS':
        return done(['value'], ((await send('HVALS', args)) as unknown[]).map((x) => [str(x)]));
      case 'SMEMBERS':
        return done(['member'], ((await send('SMEMBERS', args)) as unknown[]).map((x) => [str(x)]));
      case 'LRANGE': {
        const [start, stop] = this.clampRange(args[1]!, args[2]!, limit);
        const vals = (await send('LRANGE', [key, start, stop])) as unknown[];
        const from = Number(start) >= 0 ? Number(start) : 0;
        return done(['index', 'value'], vals.map((v, i) => [from + i, str(v)]));
      }
      case 'ZRANGE':
      case 'ZREVRANGE':
      case 'ZRANGEBYSCORE': {
        const upper = args.map((a) => a.toUpperCase());
        const byScore = command === 'ZRANGEBYSCORE' || upper.includes('BYSCORE') || upper.includes('BYLEX');
        const a2 = [...args];
        if (!byScore) [a2[1], a2[2]] = this.clampRange(args[1]!, args[2]!, limit);
        else if (!upper.includes('LIMIT')) a2.push('LIMIT', '0', String(limit + 1));
        const scores = upper.includes('WITHSCORES');
        const vals = (await send(command, a2)) as unknown[];
        return scores ? done(['member', 'score'], pairs(vals).map(([m, s]) => [m, Number(s)])) : done(['member'], vals.map((v) => [str(v)]));
      }
      case 'XRANGE':
      case 'XREVRANGE': {
        const a2 = [...args];
        const at = a2.findIndex((x) => x.toUpperCase() === 'COUNT');
        if (at >= 0) a2[at + 1] = String(Math.min(Number(a2[at + 1]) || limit + 1, limit + 1));
        else a2.push('COUNT', String(limit + 1));
        const entries = (await send(command, a2)) as [unknown, unknown[]][];
        const columns = ['id'];
        const docs = entries.map(([id, flat]) => {
          const o = Object.fromEntries(pairs(flat ?? []).map(([k, v]) => [String(k), v]));
          for (const k of Object.keys(o)) if (!columns.includes(k) && columns.length < 200) columns.push(k);
          return { id: str(id), o };
        });
        return done(columns, docs.map((d) => columns.map((col) => (col === 'id' ? d.id : (d.o[col] ?? null)))));
      }
      case 'XINFO STREAM':
      case 'TS.INFO':
        return done(['field', 'value'], pairs((await send(command, args)) as unknown[]).map(([k, v]) => [k, Array.isArray(v) ? nested(v) : v]));
      case 'JSON.GET': {
        const raw = str(await send('JSON.GET', args));
        let value: unknown = raw;
        try {
          value = raw == null ? null : JSON.parse(String(raw));
        } catch {
          // left as text
        }
        return done(['key', 'value'], [[key, value]]);
      }
      case 'TS.RANGE':
      case 'TS.REVRANGE': {
        const a2 = [...args];
        const at = a2.findIndex((x) => x.toUpperCase() === 'COUNT');
        if (at >= 0) a2[at + 1] = String(Math.min(Number(a2[at + 1]) || limit + 1, limit + 1));
        else a2.splice(3, 0, 'COUNT', String(limit + 1));
        const points = (await send(command, a2)) as [unknown, unknown][];
        return done(['timestamp', 'value'], points.map(([t, v]) => [new Date(Number(t)).toISOString(), Number(str(v))]));
      }
      case 'TS.GET': {
        const p = (await send('TS.GET', args)) as [unknown, unknown] | [];
        return done(['timestamp', 'value'], p.length ? [[new Date(Number(p[0])).toISOString(), Number(str(p[1]))]] : []);
      }
      case 'HSCAN':
      case 'SSCAN':
      case 'ZSCAN':
        return this.walkCollection(send, command, args, limit);
      case 'SCAN':
        return this.walkKeys(r, send, args, limit);
      default:
        throw new Error(`${command} is not sent.`);
    }
  }

  /** An index range no longer than the row limit (+1 to know it is capped). */
  private clampRange(start: string, stop: string, limit: number): [string, string] {
    const a = Number(start);
    const b = Number(stop);
    if (!Number.isInteger(a) || !Number.isInteger(b)) return [start, stop];
    if (a >= 0 && (b < 0 || b - a > limit)) return [String(a), String(a + limit)];
    return [start, stop];
  }

  private async walkCollection(send: (cmd: string, a: string[]) => Promise<unknown>, command: string, args: string[], limit: number): Promise<QueryResult> {
    const rows: unknown[][] = [];
    let cursor = args[1]!;
    const rest = args.slice(2);
    const novalues = rest.some((x) => x.toUpperCase() === 'NOVALUES');
    let walked = 0;
    do {
      const [next, items] = (await send(command, [args[0]!, cursor, ...rest])) as [unknown, unknown[]];
      cursor = String(next);
      walked += items.length;
      if (command === 'SSCAN' || novalues) rows.push(...items.map((x) => [str(x)]));
      else rows.push(...pairs(items).map(([k, v]) => [k, command === 'ZSCAN' ? Number(v) : v]));
    } while (cursor !== '0' && rows.length <= limit && walked < this.scanLimit);
    const columns = command === 'SSCAN' ? ['member'] : command === 'ZSCAN' ? ['member', 'score'] : novalues ? ['field'] : ['field', 'value'];
    return { columns, rows: rows.slice(0, limit), capped: rows.length > limit || cursor !== '0', estimate: null };
  }

  private async walkKeys(r: Redis, send: (cmd: string, a: string[]) => Promise<unknown>, args: string[], limit: number): Promise<QueryResult> {
    let cursor = args[0]!;
    const rest = args.slice(1);
    const countAt = rest.findIndex((x) => x.toUpperCase() === 'COUNT');
    if (countAt < 0) rest.push('COUNT', '500');
    const count = countAt < 0 ? 500 : Number(rest[countAt + 1]) || 500;
    const keys: string[] = [];
    let walked = 0;
    let calls = 0;
    do {
      const [next, batch] = (await send('SCAN', [cursor, ...rest])) as [unknown, unknown[]];
      cursor = String(next);
      calls++;
      walked += count;
      keys.push(...batch.map((x) => String(str(x))));
    } while (cursor !== '0' && keys.length <= limit && walked < this.scanLimit && calls < 10_000);
    const shown = keys.slice(0, limit);
    // TYPE of each key shown: every one matched the classified MATCH pattern, which is under the allow-list.
    const pipe = r.pipeline();
    for (const k of shown) pipe.call('TYPE', k);
    const types = shown.length ? ((await pipe.exec()) ?? []).map(([err, v]) => (err ? null : String(v))) : [];
    return { columns: ['key', 'type'], rows: shown.map((k, i) => [k, types[i] ?? null]), capped: keys.length > limit || cursor !== '0', estimate: null };
  }

  async rows(): Promise<QueryResult> {
    throw new Error('Redis keys are not a knowledge source.');
  }

  /**
   * 2.0.x: a schema plan's operations, on the admin account: XGROUP CREATE only, each sent as exactly that one
   * command. Called by the service with a driver made from the connection's admin account spec.
   */
  async applyDdl(plan: DdlPlan, timeoutMs: number): Promise<{ applied: number; detail?: string }> {
    const known = new Set(['redis.xgroupCreate', 'redis.xgroupDestroy', 'redis.xgroupSetId']);
    for (const op of plan.ops) if (!known.has(op.op)) throw new Error(`Redis connections do not perform ${op.op}.`);
    if (!plan.ops.length) throw new Error('The plan has no Redis operations.');
    const ID = /^(\$|0|\d+(-\d+)?)$/;
    return this.client(timeoutMs, async (r) => {
      let applied = 0;
      const done: string[] = [];
      for (const op of plan.ops) {
        if (op.op !== 'redis.xgroupCreate' && op.op !== 'redis.xgroupDestroy' && op.op !== 'redis.xgroupSetId') continue;
        const sub = op.op === 'redis.xgroupCreate' ? 'CREATE' : op.op === 'redis.xgroupDestroy' ? 'DESTROY' : 'SETID';
        if (!op.key || !op.group) throw new Error(`XGROUP ${sub} needs a key and a group.`);
        if (op.op !== 'redis.xgroupDestroy' && !ID.test(op.id)) throw new Error(`XGROUP ${sub} needs ${op.op === 'redis.xgroupCreate' ? 'a start id' : 'an id'} ($, 0 or an entry id).`);
        try {
          if (op.op === 'redis.xgroupCreate') {
            await r.call('XGROUP', 'CREATE', op.key, op.group, op.id, ...(op.mkstream ? ['MKSTREAM'] : []));
            done.push(`created group ${op.group} on ${op.key}`);
          } else if (op.op === 'redis.xgroupDestroy') {
            const n = Number(await r.call('XGROUP', 'DESTROY', op.key, op.group));
            if (n === 0) throw new Error('The group does not exist.');
            done.push(`removed group ${op.group} from ${op.key}`);
          } else {
            await r.call('XGROUP', 'SETID', op.key, op.group, op.id);
            done.push(`set group ${op.group} on ${op.key} to ${op.id}`);
          }
        } catch (err) {
          const msg = (err as Error).message;
          const why = /BUSYGROUP/.test(msg)
            ? 'The group already exists.'
            : /NOGROUP/.test(msg)
              ? 'The group does not exist.'
              : /requires the key to exist|no such key/i.test(msg)
                ? `The stream ${op.key} does not exist${op.op === 'redis.xgroupCreate' ? ' (create it with MKSTREAM)' : ''}.`
                : /NOPERM/.test(msg)
                  ? `The admin account may not run XGROUP ${sub} on ${op.key}: ${msg}`
                  : msg;
          throw new Error(plan.ops.length > 1 ? `${why} (${applied} of ${plan.ops.length} operations were applied before it.)` : why, { cause: err });
        }
        applied++;
      }
      const only = plan.ops.every((o) => o.op === 'redis.xgroupCreate');
      const text = done.join(', ');
      return { applied, detail: only ? `Consumer group${applied === 1 ? '' : 's'} created.` : `${text.charAt(0).toUpperCase()}${text.slice(1)}.` };
    });
  }

  /**
   * 2.0.x editing: a stream's consumer groups (`describe('<key>', 'stream-group')`): TYPE and XINFO GROUPS on the read
   * account, nothing else; null when the key does not exist.
   */
  async describe(object: string, kind: DescribeKind, timeoutMs: number): Promise<DocumentDescription | null> {
    if (kind !== 'stream-group') throw new Error(`Redis connections describe stream groups, not ${kind}.`);
    if (!object) throw new Error('Name the stream key.');
    return this.client(timeoutMs, async (r) => {
      const type = String(str(await r.call('TYPE', object)));
      if (type === 'none') return null;
      if (type !== 'stream') throw new Error(`${object} is a ${type}, not a stream.`);
      const raw = (await r.call('XINFO', 'GROUPS', object)) as unknown[];
      const groups = raw.map((g) => {
        const o = Object.fromEntries(pairs(g as unknown[]).map(([k, x]) => [String(str(k)), str(x)]));
        return { name: String(o.name ?? ''), lastDeliveredId: String(o['last-delivered-id'] ?? ''), consumers: Number(o.consumers ?? 0), pending: Number(o.pending ?? 0) };
      });
      return { kind: 'stream-group', name: object, definition: { key: object, groups } };
    });
  }

  /**
   * 2.0.x: the queues the read account can see (see the header). Only read commands are sent, on one connection.
   * Exact allow-list names are probed directly; globs are walked with SCAN MATCH (within the scan limit).
   */
  async queues(opts: { allowed: (name: string) => boolean; patterns: string[]; limit: number; timeoutMs: number }): Promise<{ queues: QueueInfo[]; outside: number; capped: boolean }> {
    const limit = Math.max(1, opts.limit);
    const deadline = Date.now() + Math.max(500, opts.timeoutMs * 0.8);
    return this.client(opts.timeoutMs, async (r) => {
      let capped = false;
      let outside = 0;
      const seen = new Set<string>();
      const exact: string[] = [];
      let walked = 0;
      const maxKeys = Math.max(limit * 50, 5000);
      for (const p of [...new Set(opts.patterns)].filter(Boolean)) {
        if (!hasGlob(p)) {
          exact.push(p);
          continue;
        }
        let cursor = '0';
        do {
          if (walked >= this.scanLimit || Date.now() > deadline || seen.size >= maxKeys) {
            capped = true;
            break;
          }
          const [next, keys] = (await r.call('SCAN', cursor, 'MATCH', p, 'COUNT', '500')) as [unknown, unknown[]];
          cursor = String(next);
          walked += 500;
          for (const k of keys) seen.add(String(str(k)));
        } while (cursor !== '0');
      }
      // Exact names: the key itself, and the state keys of a BullMQ queue named so.
      const probes = [...new Set(exact.flatMap((e) => [e, `${e}:meta`, `${e}:id`, `${e}:wait`]))].filter((k) => !seen.has(k));
      if (probes.length) {
        const pipe = r.pipeline();
        for (const k of probes) pipe.call('EXISTS', k);
        const res = (await pipe.exec()) ?? [];
        probes.forEach((k, i) => {
          if (!res[i]?.[0] && Number(res[i]?.[1]) > 0) seen.add(k);
        });
      }

      // BullMQ queues: a base with a `:meta` hash, or an `:id` counter next to a state key.
      const state = /^(.+):(meta|id|wait|active|paused|delayed|prioritized|completed|failed|waiting-children|events|marker|stalled|stalled-check|pc|limiter|repeat)$/;
      const parts = new Map<string, Set<string>>();
      for (const k of seen) {
        const m = state.exec(k);
        if (m) parts.set(m[1]!, (parts.get(m[1]!) ?? new Set()).add(m[2]!));
      }
      const bases = [...parts].filter(([, p]) => p.has('meta') || (p.has('id') && ['wait', 'active', 'completed', 'failed', 'delayed', 'events', 'paused', 'prioritized'].some((x) => p.has(x)))).map(([b]) => b);
      // The longest base wins, so a queue whose name has colons is not swallowed by a shorter one.
      bases.sort((a, b) => b.length - a.length);
      const bullOf = (k: string) => bases.find((b) => k.startsWith(b + ':'));
      const bullAllowed = (b: string) => opts.allowed(b) || opts.allowed(`${b}:wait`);

      const allowedBull = new Set<string>();
      const plain: string[] = [];
      for (const k of [...seen].sort()) {
        const b = bullOf(k);
        if (b) {
          if (bullAllowed(b)) allowedBull.add(b);
          else outside++;
          continue;
        }
        if (opts.allowed(k)) plain.push(k);
        else outside++;
      }

      const out: QueueInfo[] = [];
      const room = () => out.length < limit;

      // Plain keys: lists, streams, delayed-looking sorted sets.
      const shown = plain.slice(0, Math.max(limit * 4, 200));
      if (shown.length < plain.length) capped = true;
      if (shown.length) {
        const pipe = r.pipeline();
        for (const k of shown) pipe.call('TYPE', k);
        const types = ((await pipe.exec()) ?? []).map(([err, v]) => (err ? 'none' : String(v)));
        const lists: string[] = [];
        const streams: string[] = [];
        const zsets: string[] = [];
        shown.forEach((k, i) => {
          if (types[i] === 'list') lists.push(k);
          else if (types[i] === 'stream') streams.push(k);
          else if (types[i] === 'zset' && /(delay|schedul|retry|defer|later|timer|due)/i.test(k)) zsets.push(k);
        });
        const p2 = r.pipeline();
        for (const k of lists) p2.call('LLEN', k).call('PTTL', k);
        for (const k of zsets) p2.call('ZCARD', k).call('PTTL', k);
        const res = ((await p2.exec()) ?? []).map(([err, v]) => (err ? null : Number(v)));
        let i = 0;
        const ttl = (ms: number | null) => (ms != null && ms >= 0 ? { ttlSeconds: Math.ceil(ms / 1000) } : {});
        for (const k of lists) {
          const [n, t] = [res[i++] ?? null, res[i++] ?? null];
          out.push({ name: k, kind: 'list', depth: n, inFlight: null, consumers: null, state: null, rateIn: null, rateOut: null, details: { ...ttl(t) } });
        }
        for (const k of zsets) {
          const [n, t] = [res[i++] ?? null, res[i++] ?? null];
          out.push({ name: k, kind: 'zset', depth: n, inFlight: null, consumers: null, state: null, rateIn: null, rateOut: null, details: { ...ttl(t) } });
        }
        for (const k of streams) {
          if (!room() || Date.now() > deadline) {
            capped = true;
            break;
          }
          out.push(await this.streamInfo(r, k));
        }
      }

      for (const b of [...allowedBull].sort()) {
        if (!room() || Date.now() > deadline) {
          capped = true;
          break;
        }
        out.push(await this.bullInfo(r, b));
      }

      // Pub/sub channels with subscribers (skipped silently when the ACL refuses PUBSUB).
      for (const p of [...new Set(opts.patterns)].filter(Boolean)) {
        if (!room()) break;
        let channels: string[];
        try {
          channels = ((await r.call('PUBSUB', 'CHANNELS', p)) as unknown[]).map((c) => String(str(c)));
        } catch {
          break;
        }
        const ok = channels.filter((c) => {
          if (opts.allowed(c)) return true;
          outside++;
          return false;
        });
        if (!ok.length) continue;
        const counts = new Map<string, number>();
        try {
          const flat = (await r.call('PUBSUB', 'NUMSUB', ...ok)) as unknown[];
          for (const [c, n] of pairs(flat)) counts.set(String(c), Number(n));
        } catch {
          // counts unknown
        }
        for (const c of ok.sort()) {
          if (out.some((q) => q.kind === 'pubsub' && q.name === c)) continue;
          out.push({ name: c, kind: 'pubsub', depth: null, inFlight: null, consumers: counts.get(c) ?? null, state: null, rateIn: null, rateOut: null });
        }
      }

      if (out.length > limit) capped = true;
      return { queues: out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).slice(0, limit), outside, capped };
    });
  }

  private async streamInfo(r: Redis, key: string): Promise<QueueInfo> {
    const info = await r
      .call('XINFO', 'STREAM', key)
      .then((v) => Object.fromEntries(pairs(v as unknown[]).map(([k, x]) => [String(k), x])))
      .catch(() => ({}) as Record<string, unknown>);
    const groupsRaw = (await r.call('XINFO', 'GROUPS', key).catch(() => [])) as unknown[];
    const groups = groupsRaw.map((g) => {
      const o = Object.fromEntries(pairs(g as unknown[]).map(([k, x]) => [String(k), x]));
      return { name: String(o.name ?? ''), consumers: Number(o.consumers ?? 0), pending: Number(o.pending ?? 0), lastDeliveredId: String(o['last-delivered-id'] ?? ''), lag: o.lag == null ? null : Number(o.lag) };
    });
    const entryId = (e: unknown) => (Array.isArray(e) && e.length ? String(str(e[0])) : null);
    const length = info.length == null ? null : Number(info.length);
    return {
      name: key,
      kind: 'stream',
      depth: length,
      inFlight: groups.length ? groups.reduce((n, g) => n + g.pending, 0) : 0,
      consumers: groups.reduce((n, g) => n + g.consumers, 0),
      state: null,
      rateIn: null,
      rateOut: null,
      groups,
      details: { firstEntryId: entryId(info['first-entry']), lastEntryId: entryId(info['last-entry']), lastGeneratedId: info['last-generated-id'] == null ? null : String(info['last-generated-id']) }
    };
  }

  /** BullMQ's state keys of one queue (missing keys count 0; a key of another type too). */
  private async bullInfo(r: Redis, base: string): Promise<QueueInfo> {
    const lists = ['wait', 'active', 'paused'];
    const zsets = ['delayed', 'prioritized', 'completed', 'failed', 'waiting-children'];
    const pipe = r.pipeline();
    for (const l of lists) pipe.call('LLEN', `${base}:${l}`);
    for (const z of zsets) pipe.call('ZCARD', `${base}:${z}`);
    pipe.call('HGET', `${base}:meta`, 'paused');
    const res = (await pipe.exec()) ?? [];
    const counts: Record<string, number> = {};
    [...lists, ...zsets].forEach((name, i) => {
      const [err, v] = res[i] ?? [null, 0];
      counts[name] = err ? 0 : Number(v) || 0;
    });
    const paused = String(str(res[lists.length + zsets.length]?.[1]) ?? '') === '1';
    return {
      name: base,
      kind: 'bullmq',
      depth: counts.wait! + counts.prioritized! + counts.paused!,
      inFlight: counts.active!,
      consumers: null,
      state: paused ? 'paused' : 'running',
      rateIn: null,
      rateOut: null,
      counts
    };
  }
}
