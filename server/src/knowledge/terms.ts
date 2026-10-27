import { randomBytes } from 'node:crypto';
import { hmac } from '../crypto/index.js';
import type { Db } from '../db/knex.js';
import type { DataKeys } from '../platform/datakeys.js';

/**
 * Keyword terms for full-text ranking. Chunk text is sealed, so the keyword index stores a keyed hash of each
 * normalised word (HMAC with a per-tenant key that is itself sealed with the tenant key), never the word. The same
 * key hashes chunk text for the embedding cache. Destroying the tenant key makes both meaningless.
 */
const STOP = new Set(
  'a an and are as at be but by for from has have i in is it its of on or that the this to was were will with we you your our their they them he she his her not no do does did so if then than there these those which who what when where how can could should would may might been being into over under about after before also only other such any each more most very just'.split(' ')
);

/** Lower-cased, accent-folded words without stop words, with a light plural fold ("overruns" → "overrun"). */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || raw.length > 40 || STOP.has(raw)) continue;
    out.push(raw.length > 3 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw);
  }
  return out;
}

export function termCounts(text: string): { counts: Map<string, number>; length: number } {
  const counts = new Map<string, number>();
  const words = tokenize(text);
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  return { counts, length: words.length };
}

/** Okapi BM25 for one document: `tf` per query term, `df` per term, `n` documents, `avgdl` average length. */
export function bm25(terms: string[], tf: Map<string, number>, df: Map<string, number>, n: number, dl: number, avgdl: number, k1 = 1.2, b = 0.75): number {
  let score = 0;
  for (const t of terms) {
    const f = tf.get(t) ?? 0;
    if (!f) continue;
    const d = df.get(t) ?? 0;
    const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
    score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * dl) / (avgdl || 1)));
  }
  return score;
}

/** Reciprocal rank fusion of several ranked lists of ids (k = 60). */
export function rrf(lists: string[][], k = 60): Map<string, number> {
  const out = new Map<string, number>();
  for (const list of lists) list.forEach((id, i) => out.set(id, (out.get(id) ?? 0) + 1 / (k + i + 1)));
  return out;
}

export class TermKeys {
  private readonly cache = new Map<string, Promise<Buffer>>();

  constructor(
    private readonly db: Db,
    private readonly keys: DataKeys
  ) {}

  private key(tenantId: string): Promise<Buffer> {
    let k = this.cache.get(tenantId);
    if (!k) {
      k = (async () => {
        const row = (await this.db('knowledge_keys').where({ tenant_id: tenantId }).first()) as { sealed: string } | undefined;
        if (row) return Buffer.from(await this.keys.open(tenantId, row.sealed, `knowledge-key:${tenantId}`), 'base64');
        const fresh = randomBytes(32);
        try {
          await this.db('knowledge_keys').insert({ tenant_id: tenantId, sealed: await this.keys.seal(tenantId, fresh.toString('base64'), `knowledge-key:${tenantId}`), created_at: Date.now() });
          return fresh;
        } catch {
          // Another instance created it first.
          const again = (await this.db('knowledge_keys').where({ tenant_id: tenantId }).first()) as { sealed: string };
          return Buffer.from(await this.keys.open(tenantId, again.sealed, `knowledge-key:${tenantId}`), 'base64');
        }
      })();
      k.catch(() => this.cache.delete(tenantId));
      this.cache.set(tenantId, k);
    }
    return k;
  }

  /** Keyed hash of a term (32 hex characters). */
  async term(tenantId: string, word: string): Promise<string> {
    return hmac(await this.key(tenantId), `t:${word}`).slice(0, 32);
  }

  async terms(tenantId: string, words: string[]): Promise<Map<string, string>> {
    const key = await this.key(tenantId);
    return new Map(words.map((w) => [w, hmac(key, `t:${w}`).slice(0, 32)]));
  }

  /** Keyed hash of a text, for caches and duplicate checks. */
  async text(tenantId: string, scope: string, text: string): Promise<string> {
    return hmac(await this.key(tenantId), `${scope}:${text}`);
  }

  /** Drops a tenant's cached key (after offboarding). */
  forget(tenantId: string): void {
    this.cache.delete(tenantId);
  }
}
