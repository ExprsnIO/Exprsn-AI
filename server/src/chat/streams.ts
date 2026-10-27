import { ulid } from 'ulid';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Db } from '../db/knex.js';
import type { DataKeys } from '../platform/datakeys.js';

/** One streamed event of an answer: a text delta, thinking, or a tool step, numbered from 1 per message. */
export interface Chunk {
  seq: number;
  delta?: string;
  thinking?: string;
  tool?: { name: string; expression: string; result?: { fraction: string; decimal: string; exact: boolean }; error?: string; output?: unknown };
}

/**
 * The catch-up buffer for streams (Sprint 12): chunks of answers still generating, shared by every instance, so a
 * client that reconnects to any instance can catch up. The generating instance appends chunks in small batches and,
 * each time it stores a snapshot of the answer at sequence S, trims the batches up to S: a client behind S reads the
 * snapshot, one at or past S reads the batches. The buffer is therefore bounded by what was produced since the last
 * snapshot (about two seconds). Batches are sealed with the tenant key. Redis when `REDIS_URL` is set, otherwise
 * the application database.
 */
export interface StreamStore {
  readonly kind: 'redis' | 'db';
  append(tenantId: string, messageId: string, chunks: Chunk[]): Promise<void>;
  /** Buffered chunks with a sequence number above `after`, in order. */
  after(tenantId: string, messageId: string, after: number): Promise<Chunk[]>;
  /** Drops batches wholly at or below `seq` (covered by a stored snapshot). */
  trim(messageId: string, seq: number): Promise<void>;
  drop(messageIds: string[]): Promise<void>;
  /** Removes batches older than `ms` (streams whose generator died without dropping them). */
  expire(ms: number): Promise<void>;
  close(): Promise<void>;
}

const aad = (messageId: string, from: number) => `stream:${messageId}:${from}`;

export class DbStreamStore implements StreamStore {
  readonly kind = 'db' as const;
  constructor(
    private readonly db: Db,
    private readonly keys: DataKeys
  ) {}

  async append(tenantId: string, messageId: string, chunks: Chunk[]): Promise<void> {
    if (!chunks.length) return;
    const from = chunks[0]!.seq;
    await this.db('chat_stream_chunks').insert({ id: ulid(), tenant_id: tenantId, message_id: messageId, from_seq: from, to_seq: chunks[chunks.length - 1]!.seq, data: await this.keys.seal(tenantId, JSON.stringify(chunks), aad(messageId, from)), created_at: Date.now() });
  }

  async after(tenantId: string, messageId: string, after: number): Promise<Chunk[]> {
    const rows = (await this.db('chat_stream_chunks').where({ tenant_id: tenantId, message_id: messageId }).andWhere('to_seq', '>', after).orderBy('from_seq')) as { from_seq: number; data: string }[];
    const out: Chunk[] = [];
    for (const r of rows) out.push(...(JSON.parse(await this.keys.open(tenantId, r.data, aad(messageId, Number(r.from_seq)))) as Chunk[]).filter((c) => c.seq > after));
    return out;
  }

  async trim(messageId: string, seq: number): Promise<void> {
    await this.db('chat_stream_chunks').where({ message_id: messageId }).andWhere('to_seq', '<=', seq).delete();
  }

  async drop(messageIds: string[]): Promise<void> {
    for (let i = 0; i < messageIds.length; i += 500) await this.db('chat_stream_chunks').whereIn('message_id', messageIds.slice(i, i + 500)).delete();
  }

  async expire(ms: number): Promise<void> {
    await this.db('chat_stream_chunks').where('created_at', '<', Date.now() - ms).delete();
  }

  async close(): Promise<void> {}
}

const KEY = (messageId: string) => `exprsn:stream:${messageId}`;
const REDIS_TTL_S = 3600;

/** Redis lists, one per message, of sealed batches; each list expires an hour after its last write. */
export class RedisStreamStore implements StreamStore {
  readonly kind = 'redis' as const;
  private readonly redis: Redis;

  constructor(
    url: string,
    private readonly keys: DataKeys,
    log: Logger
  ) {
    this.redis = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 });
    this.redis.on('error', (err) => log.warn({ err: err.message }, 'stream buffer error'));
  }

  async append(tenantId: string, messageId: string, chunks: Chunk[]): Promise<void> {
    if (!chunks.length) return;
    const from = chunks[0]!.seq;
    const item = JSON.stringify({ from, to: chunks[chunks.length - 1]!.seq, data: await this.keys.seal(tenantId, JSON.stringify(chunks), aad(messageId, from)) });
    await this.redis.multi().rpush(KEY(messageId), item).ltrim(KEY(messageId), -2000, -1).expire(KEY(messageId), REDIS_TTL_S).exec();
  }

  private async items(messageId: string): Promise<{ from: number; to: number; data: string }[]> {
    return (await this.redis.lrange(KEY(messageId), 0, -1)).map((x) => JSON.parse(x) as { from: number; to: number; data: string });
  }

  async after(tenantId: string, messageId: string, after: number): Promise<Chunk[]> {
    const out: Chunk[] = [];
    for (const it of (await this.items(messageId)).filter((x) => x.to > after)) out.push(...(JSON.parse(await this.keys.open(tenantId, it.data, aad(messageId, it.from))) as Chunk[]).filter((c) => c.seq > after));
    return out;
  }

  async trim(messageId: string, seq: number): Promise<void> {
    const items = await this.items(messageId);
    let n = 0;
    while (n < items.length && items[n]!.to <= seq) n++;
    if (n) await this.redis.ltrim(KEY(messageId), n, -1);
  }

  async drop(messageIds: string[]): Promise<void> {
    if (messageIds.length) await this.redis.del(...messageIds.map(KEY));
  }

  async expire(): Promise<void> {
    // Keys expire on their own.
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}
