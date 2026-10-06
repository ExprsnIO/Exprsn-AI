import type { Readable } from 'node:stream';
import type { BlobObject, BlobStore, ByteSource } from './blob.js';

/**
 * 1.6.0 (B-4204, decision Q16): the blob store every service writes to, able to move to another store while the
 * server runs. A migration copies every object to the target as a job and then switches reads:
 *
 * - `single`: one store, the one the environment configures (or the one a finished migration moved to).
 * - `dual`: writes and deletes also go to the target (`mirror`) while the copy runs, so an object written during the
 *   copy is not missed; reads stay on the current store.
 * - `switched`: the target is the store; reads of an object the target does not have fall back to the old store,
 *   which is kept read-only until an administrator retires it. Deletes go to both.
 *
 * The mode is shared through `platform_state` and every instance applies it (see ops/storage.ts); `kind` is the
 * kind of the store reads and writes go to now.
 */
export type BlobMode = { mode: 'single' } | { mode: 'dual'; migration: string } | { mode: 'switched'; migration: string };

export class SwitchableBlobStore implements BlobStore {
  private primary: BlobStore;
  private mirror: BlobStore | null = null;
  private fallback: BlobStore | null = null;
  private current: BlobMode = { mode: 'single' };
  /** The store the environment configured, which a migration moves away from. */
  readonly configured: BlobStore;

  constructor(store: BlobStore) {
    this.primary = store;
    this.configured = store;
  }

  get kind(): 'fs' | 's3' {
    return this.primary.kind;
  }

  /** The mode and the store reads now come from. */
  get state(): BlobMode {
    return this.current;
  }

  get active(): BlobStore {
    return this.primary;
  }

  /** The store kept for reads after a switch, until it is retired. */
  get previous(): BlobStore | null {
    return this.fallback;
  }

  /** Applies a mode: `stores.from` is the store the copy reads, `stores.to` the target (none for `single`). */
  apply(mode: BlobMode, stores: { from: BlobStore; to: BlobStore | null }): void {
    if (mode.mode === 'single') {
      this.primary = stores.to ?? stores.from;
      this.mirror = null;
      this.fallback = null;
    } else if (mode.mode === 'dual') {
      this.primary = stores.from;
      this.mirror = stores.to;
      this.fallback = null;
    } else {
      this.primary = stores.to ?? stores.from;
      this.mirror = null;
      this.fallback = stores.to ? stores.from : null;
    }
    this.current = mode;
  }

  /** The label instances report, e.g. `dual:01J…`. */
  get label(): string {
    return this.current.mode === 'single' ? 'single' : `${this.current.mode}:${this.current.migration}`;
  }

  async put(key: string, data: Buffer, contentType?: string): Promise<void> {
    await this.primary.put(key, data, contentType);
    if (this.mirror) await this.mirror.put(key, data, contentType);
  }

  async get(key: string): Promise<Buffer | null> {
    const v = await this.primary.get(key);
    if (v || !this.fallback) return v;
    return this.fallback.get(key);
  }

  async delete(key: string): Promise<void> {
    await this.primary.delete(key);
    for (const o of [this.mirror, this.fallback]) if (o) await o.delete(key).catch(() => undefined);
  }

  async deletePrefix(prefix: string): Promise<number> {
    const n = await this.primary.deletePrefix(prefix);
    for (const o of [this.mirror, this.fallback]) if (o) await o.deletePrefix(prefix).catch(() => 0);
    return n;
  }

  health(): Promise<{ ok: boolean; detail: string }> {
    return this.primary.health();
  }

  async putStream(key: string, source: ByteSource, contentType?: string): Promise<{ bytes: number }> {
    const r = await this.primary.putStream(key, source, contentType);
    // While a copy runs the object is copied from the current store once it is complete there.
    if (this.mirror) {
      const got = await this.primary.getStream(key);
      if (got) await this.mirror.putStream(key, got.stream as AsyncIterable<Buffer>, contentType);
    }
    return r;
  }

  async getStream(key: string): Promise<{ stream: Readable; size: number } | null> {
    const v = await this.primary.getStream(key);
    if (v || !this.fallback) return v;
    return this.fallback.getStream(key);
  }

  async *list(prefix: string): AsyncIterable<BlobObject> {
    if (!this.fallback) {
      yield* this.primary.list(prefix);
      return;
    }
    const seen = new Set<string>();
    for await (const o of this.primary.list(prefix)) {
      seen.add(o.key);
      yield o;
    }
    for await (const o of this.fallback.list(prefix)) if (!seen.has(o.key)) yield o;
  }
}
