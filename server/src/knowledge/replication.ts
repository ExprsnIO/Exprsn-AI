import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import type { Db } from '../db/knex.js';
import type { ConnectionService, MaskedChange, MaskedReplicationStream } from '../connections/service.js';
import type { SourceRow } from './service.js';

/*
 * Logical replication for PostgreSQL knowledge sources (B-1003). A source added with `replication: true` gets a
 * slot (`exprsn_<source id>`) on its connection and one stream, held by one instance at a time through a lease in
 * `knowledge_replication` that the holder renews on every tick. Each committed transaction that touches the table
 * is applied to the knowledge base at once (rows become documents, deletes remove them, a truncate empties the
 * source) and only then acknowledged, so the slot resends anything not applied. When the stream cannot start or
 * fails (no REPLICATION attribute, no publication, a view, wal_level below logical) the source is marked
 * `fallback` with the reason and keeps syncing by watermark on its schedule; the stream is tried again with
 * backoff. The watermark schedule keeps running beside a healthy stream as a safety net: unchanged rows are
 * skipped by content hash.
 */

export interface ReplicationRow {
  source_id: string;
  tenant_id: string;
  slot: string;
  publication: string;
  state: 'starting' | 'streaming' | 'fallback' | 'stopped';
  holder: string | null;
  lease_until: number | null;
  lsn: string | null;
  last_change_at: number | null;
  changes: number;
  error: string | null;
  created_at: number;
  updated_at: number;
}

/** What the manager needs from the knowledge service. */
export interface ReplicationHost {
  db: Db;
  connections: ConnectionService;
  log: Logger;
  sources(): Promise<SourceRow[]>;
  apply(s: SourceRow, changes: MaskedChange[]): Promise<unknown>;
}

export const slotFor = (sourceId: string): string => `exprsn_${sourceId.toLowerCase()}`;

export const replicationView = (r: ReplicationRow | undefined) =>
  r ? { state: r.state, slot: r.slot, publication: r.publication, lsn: r.lsn, lastChangeAt: r.last_change_at == null ? null : Number(r.last_change_at), changes: Number(r.changes ?? 0), error: r.error, holder: r.holder ? 'held' : null } : null;

export class ReplicationManager {
  readonly instance = randomBytes(8).toString('hex');
  private readonly streams = new Map<string, { stream: MaskedReplicationStream; source: SourceRow }>();
  private readonly retryAt = new Map<string, { at: number; failures: number }>();
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly h: ReplicationHost,
    private readonly o: { enabled: boolean; tickMs: number }
  ) {}

  /** Starts the periodic tick on this instance (workers only). */
  start(): void {
    if (!this.o.enabled || this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((err: unknown) => this.h.log.warn({ err }, 'knowledge replication tick failed')), this.o.tickMs);
    this.timer.unref();
    void this.tick().catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.ticking?.catch(() => undefined);
    const ids = [...this.streams.keys()];
    await Promise.all(ids.map((id) => this.stopLocal(id)));
    // Give the leases back so another instance takes over at once.
    if (ids.length) await this.h.db('knowledge_replication').whereIn('source_id', ids).andWhere({ holder: this.instance }).update({ holder: null, lease_until: null }).catch(() => undefined);
  }

  /** Whether this instance streams a source now (tests and the view). */
  running(sourceId: string): boolean {
    return this.streams.has(sourceId);
  }

  async row(sourceId: string): Promise<ReplicationRow | undefined> {
    return (await this.h.db('knowledge_replication').where({ source_id: sourceId }).first()) as ReplicationRow | undefined;
  }

  /** One pass: claim or renew leases, start streams this instance holds, stop streams for sources that are gone. */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.pass().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async pass(): Promise<void> {
    if (!this.o.enabled || this.closed) return;
    const db = this.h.db;
    const now = Date.now();
    const wanted = (await this.h.sources()).filter((s) => s.kind === 'database' && s.config.replication && (s.config.engine ?? 'postgres') === 'postgres');
    const ids = new Set(wanted.map((s) => s.id));
    for (const [id, { source }] of [...this.streams.entries()]) {
      if (!ids.has(id)) {
        // Removed while this instance held the stream: stop it and drop the slot now that it is free.
        await this.stopLocal(id);
        await db('knowledge_replication').where({ source_id: id }).delete();
        await this.h.connections.dropReplicationSlot(source.tenant_id, source.config.connectionId!, slotFor(id)).catch((err: unknown) => this.h.log.warn({ source: id, err: (err as Error).message }, 'could not drop the replication slot; drop it on the database'));
      }
    }
    for (const s of wanted) {
      let r = await this.row(s.id);
      if (!r) {
        await db('knowledge_replication')
          .insert({ source_id: s.id, tenant_id: s.tenant_id, slot: slotFor(s.id), publication: s.config.publication ?? 'exprsn_knowledge', state: 'starting', holder: null, lease_until: null, lsn: null, last_change_at: null, changes: 0, error: null, created_at: now, updated_at: now })
          .catch(() => undefined); // another instance inserted it first
        r = await this.row(s.id);
        if (!r) continue;
      }
      const lease = now + this.o.tickMs * 3;
      const claimed = await db('knowledge_replication')
        .where({ source_id: s.id })
        .andWhere((q) => q.whereNull('holder').orWhere({ holder: this.instance }).orWhere('lease_until', '<', now))
        .update({ holder: this.instance, lease_until: lease });
      if (claimed !== 1) {
        // Someone else holds it: make sure this instance is not streaming too.
        if (this.streams.has(s.id)) await this.stopLocal(s.id);
        continue;
      }
      if (this.streams.has(s.id)) continue;
      const retry = this.retryAt.get(s.id);
      if (retry && retry.at > now) continue;
      await this.startLocal(s, r);
    }
  }

  private async startLocal(s: SourceRow, r: ReplicationRow): Promise<void> {
    const db = this.h.db;
    let stream: MaskedReplicationStream;
    try {
      stream = await this.h.connections.replicate(s.tenant_id, s.config.connectionId!, s.config.object!, { slot: r.slot, publication: r.publication, startLsn: r.lsn, rawColumn: s.config.accessColumn ?? null });
    } catch (err) {
      await this.failed(s.id, err as Error);
      return;
    }
    this.streams.set(s.id, { stream, source: s });
    await db('knowledge_replication').where({ source_id: s.id }).update({ state: 'starting', updated_at: Date.now() });
    const ready = () => void db('knowledge_replication').where({ source_id: s.id }).update({ state: 'streaming', error: null, updated_at: Date.now() }).catch(() => undefined);
    void stream
      .run(async (b) => {
        const cur = (await this.h.sources()).find((x) => x.id === s.id);
        if (!cur) return;
        await this.h.apply(cur, b.changes);
        await db('knowledge_replication')
          .where({ source_id: s.id })
          .update({ lsn: b.lsn, last_change_at: Date.now(), changes: db.raw('changes + ?', [b.changes.length]), updated_at: Date.now() });
      }, ready)
      .then(
        () => {
          if (this.streams.get(s.id)?.stream === stream) this.streams.delete(s.id);
        },
        async (err: Error) => {
          const mine = this.streams.get(s.id)?.stream === stream;
          if (mine) this.streams.delete(s.id);
          if (mine && !this.closed) await this.failed(s.id, err).catch(() => undefined);
        }
      );
    this.retryAt.delete(s.id);
  }

  /** The stream could not start or broke: fall back to watermarks and try again later (30 s, doubling to 10 min). */
  private async failed(sourceId: string, err: Error): Promise<void> {
    const prev = this.retryAt.get(sourceId);
    const failures = (prev?.failures ?? 0) + 1;
    this.retryAt.set(sourceId, { at: Date.now() + Math.min(30_000 * 2 ** (failures - 1), 600_000), failures });
    const message = err.message.slice(0, 1000);
    this.h.log.warn({ source: sourceId, err: message }, 'knowledge replication unavailable; the source syncs by watermark');
    await this.h.db('knowledge_replication').where({ source_id: sourceId }).update({ state: 'fallback', error: message, updated_at: Date.now() });
  }

  private async stopLocal(sourceId: string): Promise<void> {
    const st = this.streams.get(sourceId);
    this.streams.delete(sourceId);
    await st?.stream.stop().catch(() => undefined);
  }

  /**
   * A source is removed (or its knowledge base): stop its stream here and drop its slot, so the database stops
   * keeping WAL for it. An instance that holds the stream elsewhere stops it on its next tick and drops the slot
   * then; until that tick the slot is in use and is left alone.
   */
  async release(s: SourceRow): Promise<{ slotDropped: boolean }> {
    if (!s.config.replication) return { slotDropped: false };
    await this.stopLocal(s.id);
    const r = await this.row(s.id);
    await this.h.db('knowledge_replication').where({ source_id: s.id }).delete();
    let dropped = false;
    try {
      dropped = await this.h.connections.dropReplicationSlot(s.tenant_id, s.config.connectionId!, r?.slot ?? slotFor(s.id));
    } catch (err) {
      this.h.log.warn({ source: s.id, err: (err as Error).message }, 'could not drop the replication slot; drop it on the database');
    }
    return { slotDropped: dropped };
  }
}
