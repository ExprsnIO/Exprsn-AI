import { actorFrom } from '../audit/chain.js';
import type { AuditEvent } from '../audit/chain.js';
import { isLabel } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { conflict, HttpProblem } from '../http/problem.js';
import { TOPICS, type IntegrationEvent } from '../platform/bus.js';
import type { JobContext } from '../platform/jobs.js';
import type { Services } from '../services.js';
import { prefixHash, SearchKeys, termHash } from './keys.js';
import { hasLink, prefixesOf, terms } from './normalise.js';

/*
 * 1.9.0, Sprint 52 (B-170): the blind index, written at write and by a backfill.
 *
 * - What is indexed: sent messages (`dm_messages`), published posts (`feed_posts`) and published comments
 *   (`feed_comments`). Anything else (held, rejected, hidden, deleted, in a deleted conversation, on a post that is
 *   not published) has no postings and no `search_docs` row: syncing a document makes its index rows match its source
 *   now, so the same call indexes, re-indexes and removes.
 * - When: after each write, from the `message.*` and `post.*` integration events and from the audit entries of
 *   comments, conversation deletes and moderation hides and restores (`listen`). Indexing runs after the write has
 *   committed and never fails it: an error is logged and the document is queued again as the job `search.index.doc`.
 *   Nothing is written while the tenant has not turned the index on (no `search_state` row) or while migrations 138
 *   and 139 are not applied.
 * - The backfill (`search.backfill`) walks messages, then posts, then comments by id, 200 at a time, writing one key
 *   version; its cursor and counts are saved after every batch, so a retried or resumed job carries on where it
 *   stopped. When it reaches the end, its version becomes the one queries use and the version before it (after a
 *   rotation or a rebuild) is removed with its key. Writes meanwhile go to both versions.
 * - A document changed while the backfill held its old text is caught by comparing its `updated_at` after the batch
 *   and syncing it again.
 */

export const DOC_KINDS = ['message', 'post', 'comment'] as const;
export type DocKind = (typeof DOC_KINDS)[number];
export const BACKFILL_JOB = 'search.backfill';
export const RETRY_JOB = 'search.index.doc';
const BATCH = 200;
const CHUNK = 400;
/** The most terms one document contributes (a message is at most 10,000 characters; a post as long). */
const MAX_TERMS = 4000;
const SCHEMA_RECHECK_MS = 30_000;
const TABLES = ['search_postings', 'search_prefixes', 'search_docs', 'search_keys', 'search_state'] as const;

export interface StateRow {
  tenant_id: string;
  state: 'building' | 'ready';
  active_version: number | null;
  building_version: number | null;
  cursor: string | null;
  processed: number;
  total: number;
  job_id: string | null;
  started_at: number | null;
  finished_at: number | null;
  updated_by: string | null;
  updated_at: number;
  error: string | null;
}

interface Cursor {
  kind: DocKind;
  after: string;
}

interface SourceDoc {
  kind: DocKind;
  id: string;
  tenantId: string;
  text: string;
  stamp: number;
  meta: { scope_id: string; parent_id: string | null; workspace_id: string | null; group_id: string | null; author_id: string; label: string; visibility: string | null; created_at: number; has_file: boolean };
}

const numOrNull = (v: unknown) => (v == null ? null : Number(v));
const stateFrom = (r: Record<string, unknown>): StateRow => ({ ...(r as unknown as StateRow), active_version: numOrNull(r.active_version), building_version: numOrNull(r.building_version), processed: Number(r.processed ?? 0), total: Number(r.total ?? 0), started_at: numOrNull(r.started_at), finished_at: numOrNull(r.finished_at), updated_at: Number(r.updated_at) });
const chunks = <T>(xs: T[], n = CHUNK): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};
const parseIds = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== 'string' || !v) return [];
  try {
    const x = JSON.parse(v) as unknown;
    return Array.isArray(x) ? x.map(String) : [];
  } catch {
    return [];
  }
};

export interface AdminCtx {
  p: Principal;
  ip: string | null;
  traceId?: string | null;
}

export class SearchIndex {
  readonly keys: SearchKeys;
  private schema: { ok: boolean; at: number } | null = null;
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private listening = false;
  private registered = false;

  constructor(private readonly s: () => Services) {
    this.keys = new SearchKeys(
      () => s().db,
      () => s().keys
    );
  }

  private get db() {
    return this.s().db;
  }

  // ---------- schema and state ----------

  /** Whether migrations 138 and 139 are applied; a negative answer is checked again every 30 s. */
  async installed(): Promise<boolean> {
    const t = Date.now();
    if (this.schema && (this.schema.ok || t - this.schema.at < SCHEMA_RECHECK_MS)) return this.schema.ok;
    let ok = true;
    try {
      for (const name of TABLES) if (!(await this.db.schema.hasTable(name))) ok = false;
    } catch {
      ok = false;
    }
    this.schema = { ok, at: t };
    return ok;
  }

  /** Forgets the cached schema answer (tests apply the migrations by hand). */
  resetSchemaCache(): void {
    this.schema = null;
  }

  async state(tenantId: string): Promise<StateRow | null> {
    if (!(await this.installed())) return null;
    const r = await this.db('search_state').where({ tenant_id: tenantId }).first();
    return r ? stateFrom(r) : null;
  }

  /** The key versions written at write: the active one and the one a backfill is building. */
  private versionsOf(st: StateRow | null): number[] {
    if (!st) return [];
    return [...new Set([st.active_version, st.building_version].filter((v): v is number => v != null))];
  }

  /** The version queries read, or null while the index is off or its first backfill has not finished. */
  async readVersion(tenantId: string): Promise<number | null> {
    const st = await this.state(tenantId);
    return st?.active_version ?? null;
  }

  // ---------- sources ----------

  /** The live documents among `ids` (others are absent from the answer), opened. */
  private async sources(tenantId: string, kind: DocKind, ids: string[]): Promise<Map<string, SourceDoc>> {
    const s = this.s();
    const out = new Map<string, SourceDoc>();
    if (!ids.length) return out;
    if (kind === 'message') {
      const rows = (await this.db('dm_messages').where({ tenant_id: tenantId, state: 'sent' }).whereIn('id', ids)) as Record<string, unknown>[];
      const convIds = [...new Set(rows.map((r) => String(r.conversation_id)))];
      const convs = new Map(((convIds.length ? await this.db('dm_conversations').whereIn('id', convIds).andWhere({ state: 'active' }).select('id', 'workspace_id') : []) as { id: string; workspace_id: string | null }[]).map((c) => [c.id, c]));
      const links = new Map(((convIds.length ? await this.db('group_conversations').whereIn('conversation_id', convIds).select('conversation_id', 'group_id') : []) as { conversation_id: string; group_id: string }[]).map((l) => [l.conversation_id, l.group_id]));
      for (const r of rows) {
        const conv = convs.get(String(r.conversation_id));
        if (!conv || r.body == null) continue;
        const text = (await s.keys.open(tenantId, String(r.body), `dm-message:${String(r.id)}`)) ?? '';
        out.set(String(r.id), { kind, id: String(r.id), tenantId, text, stamp: Number(r.updated_at), meta: { scope_id: conv.id, parent_id: (r.thread_id as string | null) ?? null, workspace_id: conv.workspace_id, group_id: links.get(conv.id) ?? null, author_id: String(r.author_id), label: isLabel(r.label) ? r.label : 'restricted', visibility: null, created_at: Number(r.created_at), has_file: parseIds(r.attachments).length > 0 } });
      }
      return out;
    }
    if (kind === 'post') {
      const rows = (await this.db('feed_posts').where({ tenant_id: tenantId, state: 'published' }).whereIn('id', ids)) as Record<string, unknown>[];
      const media = new Set(((await this.db('feed_post_media').whereIn('post_id', ids).distinct('post_id')) as { post_id: string }[]).map((m) => m.post_id));
      for (const r of rows) {
        if (r.body == null) continue;
        const text = (await s.keys.open(tenantId, String(r.body), `feed-post:${String(r.id)}`)) ?? '';
        if (!text.trim()) continue;
        out.set(String(r.id), { kind, id: String(r.id), tenantId, text, stamp: Number(r.updated_at), meta: { scope_id: String(r.group_id ?? r.workspace_id), parent_id: null, workspace_id: String(r.workspace_id), group_id: (r.group_id as string | null) ?? null, author_id: String(r.author_id), label: isLabel(r.label) ? r.label : 'restricted', visibility: (r.visibility as string | null) ?? 'workspace', created_at: Number(r.published_at ?? r.created_at), has_file: media.has(String(r.id)) } });
      }
      return out;
    }
    const rows = (await this.db('feed_comments').where({ tenant_id: tenantId, state: 'published' }).whereIn('id', ids)) as Record<string, unknown>[];
    const postIds = [...new Set(rows.map((r) => String(r.post_id)))];
    const posts = new Map(((postIds.length ? await this.db('feed_posts').where({ tenant_id: tenantId, state: 'published' }).whereIn('id', postIds).select('id', 'workspace_id', 'group_id', 'visibility') : []) as { id: string; workspace_id: string; group_id: string | null; visibility: string | null }[]).map((x) => [x.id, x]));
    for (const r of rows) {
      const x = posts.get(String(r.post_id));
      if (!x || r.body == null) continue;
      const text = (await s.keys.open(tenantId, String(r.body), `feed-comment:${String(r.id)}`)) ?? '';
      out.set(String(r.id), { kind, id: String(r.id), tenantId, text, stamp: Number(r.updated_at), meta: { scope_id: x.group_id ?? x.workspace_id, parent_id: x.id, workspace_id: x.workspace_id, group_id: x.group_id, author_id: String(r.author_id), label: isLabel(r.label) ? r.label : 'restricted', visibility: x.visibility ?? 'workspace', created_at: Number(r.created_at), has_file: false } });
    }
    return out;
  }

  private stampTable(kind: DocKind): string {
    return kind === 'message' ? 'dm_messages' : kind === 'post' ? 'feed_posts' : 'feed_comments';
  }

  // ---------- writing ----------

  /**
   * Makes the index rows of these documents match their sources for the given versions: live ones are (re)written,
   * gone ones lose their rows in every version. Returns the ids changed since they were read (to sync again).
   */
  async writeBatch(tenantId: string, kind: DocKind, ids: string[], versions: number[]): Promise<{ indexed: number; removed: number; stale: string[] }> {
    if (!ids.length || !versions.length) return { indexed: 0, removed: 0, stale: [] };
    const docs = await this.sources(tenantId, kind, ids);
    const gone = ids.filter((id) => !docs.has(id));
    // Hash outside the transaction (the key may need a read of its own).
    const keyed = await Promise.all(versions.map(async (v) => ({ v, key: await this.keys.key(tenantId, v) })));
    const postings: Record<string, unknown>[] = [];
    const prefixes = new Map<string, Record<string, unknown>>();
    const meta: Record<string, unknown>[] = [];
    const now = Date.now();
    for (const d of docs.values()) {
      const list = terms(d.text).slice(0, MAX_TERMS);
      meta.push({ doc_kind: kind, doc_id: d.id, tenant_id: tenantId, ...d.meta, length: list.length, has_link: hasLink(d.text), indexed_at: now });
      const distinct = [...new Set(list)];
      for (const { v, key } of keyed) {
        const hashed = new Map(distinct.map((t) => [t, termHash(key, t)]));
        list.forEach((t, pos) => postings.push({ tenant_id: tenantId, key_version: v, term: hashed.get(t)!, doc_kind: kind, doc_id: d.id, scope_id: d.meta.scope_id, pos }));
        for (const t of distinct) {
          for (const pre of prefixesOf(t)) {
            const ph = prefixHash(key, pre);
            const th = hashed.get(t)!;
            prefixes.set(`${v}:${ph}:${th}`, { tenant_id: tenantId, key_version: v, prefix: ph, term: th });
          }
        }
      }
    }
    const all = [...ids];
    await this.db.transaction(async (trx) => {
      for (const c of chunks(all)) await trx('search_postings').where({ doc_kind: kind }).whereIn('doc_id', c).whereIn('key_version', versions).delete();
      for (const c of chunks(gone)) await trx('search_postings').where({ doc_kind: kind }).whereIn('doc_id', c).delete();
      for (const c of chunks(all)) await trx('search_docs').where({ doc_kind: kind }).whereIn('doc_id', c).delete();
      for (const c of chunks(meta, 200)) await trx('search_docs').insert(c);
      for (const c of chunks(postings, 500)) await trx('search_postings').insert(c);
      for (const c of chunks([...prefixes.values()], 500)) await trx('search_prefixes').insert(c).onConflict(['tenant_id', 'key_version', 'prefix', 'term']).ignore();
    });
    // What changed while it was being read is synced again.
    const stale: string[] = [];
    const live = [...docs.values()];
    for (const c of chunks(live.map((d) => d.id))) {
      const now = new Map(((await this.db(this.stampTable(kind)).whereIn('id', c).select('id', 'updated_at')) as { id: string; updated_at: number | string }[]).map((r) => [r.id, Number(r.updated_at)]));
      for (const id of c) if (now.get(id) !== docs.get(id)!.stamp) stale.push(id);
    }
    return { indexed: docs.size, removed: gone.length, stale };
  }

  /** Syncs one document with its source in every version written now (a no-op while the index is off). */
  async sync(tenantId: string, kind: DocKind, id: string): Promise<void> {
    const versions = this.versionsOf(await this.state(tenantId));
    if (!versions.length) return;
    for (let i = 0; i < 3; i++) {
      const out = await this.writeBatch(tenantId, kind, [id], versions);
      if (!out.stale.length) return;
    }
  }

  /** Removes every document of a conversation (it was deleted). */
  async removeScope(tenantId: string, kind: DocKind, scopeId: string): Promise<void> {
    if (!(await this.installed())) return;
    const ids = ((await this.db('search_docs').where({ tenant_id: tenantId, doc_kind: kind, scope_id: scopeId }).select('doc_id')) as { doc_id: string }[]).map((r) => r.doc_id);
    await this.db.transaction(async (trx) => {
      for (const c of chunks(ids)) {
        await trx('search_postings').where({ doc_kind: kind }).whereIn('doc_id', c).delete();
        await trx('search_docs').where({ doc_kind: kind }).whereIn('doc_id', c).delete();
      }
    });
  }

  /** A post changed: its comments follow its visibility, and leave the index with it. */
  private async postChanged(tenantId: string, postId: string): Promise<void> {
    if (!(await this.installed())) return;
    const ids = ((await this.db('search_docs').where({ tenant_id: tenantId, doc_kind: 'comment', parent_id: postId }).select('doc_id')) as { doc_id: string }[]).map((r) => r.doc_id);
    for (const id of ids) this.onWrite(tenantId, 'comment', id);
  }

  /**
   * After a write: syncs the document in the background, once at a time per document (a write meanwhile runs it again).
   * Never throws; a failure is logged and retried as a job.
   */
  onWrite(tenantId: string, kind: DocKind, id: string): void {
    const k = `${kind}:${id}`;
    if (this.inflight.has(k)) {
      this.again.add(k);
      return;
    }
    const run = async () => {
      try {
        do {
          this.again.delete(k);
          await this.sync(tenantId, kind, id);
        } while (this.again.has(k));
      } catch (err) {
        const s = this.s();
        s.log.warn({ err: (err as Error).message, kind, id }, 'search index write failed; queued again');
        await s.jobs.enqueue({ tenantId, type: RETRY_JOB, payload: { tenantId, kind, id }, maxAttempts: 5, dedupeKey: `${RETRY_JOB}:${k}:${Date.now()}` }).catch(() => undefined);
      } finally {
        this.inflight.delete(k);
        this.again.delete(k);
      }
    };
    this.inflight.set(k, run());
  }

  /** Waits for the background syncs (tests, shutdown). */
  async drain(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight.values()]);
  }

  /** Index writes follow the domain events (integration events and audit entries), on the instance that wrote. */
  listen(): void {
    if (this.listening) return;
    this.listening = true;
    const s = this.s();
    s.bus.on<IntegrationEvent>(TOPICS.integrationEvent, (e) => {
      const d = e.data ?? {};
      if (e.type === 'message.sent' || e.type === 'message.edited' || e.type === 'message.deleted') {
        if (typeof d.message === 'string') this.onWrite(e.tenantId, 'message', d.message);
      } else if (e.type === 'post.created' || e.type === 'post.updated' || e.type === 'post.deleted') {
        if (typeof d.post === 'string') {
          this.onWrite(e.tenantId, 'post', d.post);
          void this.postChanged(e.tenantId, d.post).catch(() => undefined);
        }
      }
    });
    s.audit.onAppend((e: AuditEvent) => {
      const t = e.target ?? {};
      if (e.action === 'feed.comment.created' || e.action === 'feed.comment.deleted') {
        if (typeof t.comment === 'string') this.onWrite(e.tenant_id, 'comment', t.comment);
      } else if (e.action === 'feed.post.visibility' && typeof t.post === 'string') {
        void this.postChanged(e.tenant_id, t.post).catch(() => undefined);
      } else if (e.action === 'messaging.conversation.deleted' && typeof t.conversation === 'string') {
        // Tracked like a write so drain() waits for it (on PostgreSQL and MySQL the removal lost the race to settle()).
        const k = `scope:${e.tenant_id}:message:${t.conversation}`;
        const done = this.removeScope(e.tenant_id, 'message', t.conversation)
          .catch((err: Error) => s.log.warn({ err: err.message }, 'search index scope removal failed'))
          .finally(() => this.inflight.delete(k));
        this.inflight.set(k, done);
      } else if ((e.action === 'moderation.action.applied' || e.action === 'moderation.action.reversed') && typeof t.id === 'string') {
        const kind: DocKind | null = t.object === 'dm-message' ? 'message' : t.object === 'feed-post' ? 'post' : t.object === 'feed-comment' ? 'comment' : null;
        if (kind) this.onWrite(e.tenant_id, kind, t.id);
      }
    });
  }

  registerJobs(): void {
    if (this.registered) return;
    this.registered = true;
    const s = this.s();
    s.jobs.register(RETRY_JOB, async (payload) => {
      const kind = String(payload.kind ?? '') as DocKind;
      if (!DOC_KINDS.includes(kind)) return { skipped: 'kind' };
      await this.sync(String(payload.tenantId ?? ''), kind, String(payload.id ?? ''));
      return { synced: payload.id };
    });
    s.jobs.register(BACKFILL_JOB, (payload, ctx) => this.runBackfill(String(payload.tenantId ?? ''), Number(payload.version), ctx), { timeoutMs: 6 * 60 * 60_000 });
  }

  // ---------- the backfill ----------

  private async counts(tenantId: string): Promise<number> {
    const n = async (table: string, state: string) => Number(((await this.db(table).where({ tenant_id: tenantId, state }).count({ n: '*' })) as { n: number | string }[])[0]?.n ?? 0);
    return (await n('dm_messages', 'sent')) + (await n('feed_posts', 'published')) + (await n('feed_comments', 'published'));
  }

  private nextIds(kind: DocKind, tenantId: string, after: string): Promise<{ id: string }[]> {
    const table = this.stampTable(kind);
    const state = kind === 'message' ? 'sent' : 'published';
    return this.db(table).where({ tenant_id: tenantId, state }).andWhere('id', '>', after).orderBy('id').limit(BATCH).select('id') as Promise<{ id: string }[]>;
  }

  /**
   * Runs batches of the backfill of `version` from its saved cursor; stops after `maxBatches` (tests stand in for an
   * interrupted job with it), when the job is cancelled, or when the version is no longer the one being built.
   */
  async backfillStep(tenantId: string, version: number, o: { maxBatches?: number; signal?: AbortSignal; progress?: JobContext['progress'] } = {}): Promise<{ done: boolean; processed: number; total: number }> {
    let batches = 0;
    for (;;) {
      const st = await this.state(tenantId);
      if (!st || st.building_version !== version) return { done: true, processed: st?.processed ?? 0, total: st?.total ?? 0 };
      const cur: Cursor = st.cursor ? (JSON.parse(st.cursor) as Cursor) : { kind: 'message', after: '' };
      const rows = await this.nextIds(cur.kind, tenantId, cur.after);
      let next: Cursor;
      let processed = st.processed;
      if (rows.length) {
        const ids = rows.map((r) => r.id);
        const versions = this.versionsOf(st);
        const out = await this.writeBatch(tenantId, cur.kind, ids, versions);
        for (const id of out.stale) await this.sync(tenantId, cur.kind, id);
        processed += ids.length;
        next = { kind: cur.kind, after: ids[ids.length - 1]! };
      } else {
        const i = DOC_KINDS.indexOf(cur.kind);
        if (i === DOC_KINDS.length - 1) {
          await this.finish(tenantId, version, st);
          return { done: true, processed, total: st.total };
        }
        next = { kind: DOC_KINDS[i + 1]!, after: '' };
      }
      const n = await this.db('search_state').where({ tenant_id: tenantId, building_version: version }).update({ cursor: JSON.stringify(next), processed, updated_at: Date.now(), error: null });
      if (!n) return { done: true, processed, total: st.total };
      if (o.progress && st.total) await o.progress(Math.min(99, (processed / st.total) * 100), `Indexed ${processed} of about ${st.total}`);
      if (o.signal?.aborted) return { done: false, processed, total: st.total };
      if (o.maxBatches != null && ++batches >= o.maxBatches) return { done: false, processed, total: st.total };
    }
  }

  private async runBackfill(tenantId: string, version: number, ctx: JobContext): Promise<unknown> {
    try {
      const out = await this.backfillStep(tenantId, version, { signal: ctx.signal, progress: (pct, m) => ctx.progress(pct, m) });
      return out;
    } catch (err) {
      await this.db('search_state').where({ tenant_id: tenantId, building_version: version }).update({ error: String((err as Error).message).slice(0, 500), updated_at: Date.now() }).catch(() => undefined);
      throw err;
    }
  }

  /** The backfill reached the end: its version serves; the previous one goes, with its key. */
  private async finish(tenantId: string, version: number, st: StateRow): Promise<void> {
    const previous = st.active_version;
    const n = await this.db('search_state').where({ tenant_id: tenantId, building_version: version }).update({ state: 'ready', active_version: version, building_version: null, cursor: null, finished_at: Date.now(), updated_at: Date.now(), error: null });
    if (!n) return;
    await this.keys.setState(tenantId, version, 'active');
    if (previous != null && previous !== version) await this.retire(tenantId, previous);
    await this.s().audit.append({ tenantId, action: 'search.index.ready', kind: 'system', actor: { service: 'search' }, target: { version }, detail: { previous, documents: st.processed } });
  }

  /** Removes a version's postings and prefixes, then its key. */
  private async retire(tenantId: string, version: number): Promise<void> {
    await this.keys.setState(tenantId, version, 'retiring');
    await this.db('search_postings').where({ tenant_id: tenantId, key_version: version }).delete();
    await this.db('search_prefixes').where({ tenant_id: tenantId, key_version: version }).delete();
    await this.keys.remove(tenantId, version);
  }

  // ---------- administration ----------

  private async need(): Promise<void> {
    if (!(await this.installed())) throw new HttpProblem(503, 'Search index not installed', 'This server has not had migrations 138_search_index and 139_search_state yet. Search works as before, without the index.');
  }

  private async audit(ctx: AdminCtx, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>): Promise<void> {
    await this.s().audit.append({ tenantId: ctx.p.tenantId, action, kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target, ...(detail ? { detail } : {}), traceId: ctx.traceId ?? null });
  }

  private async nextVersion(tenantId: string): Promise<number> {
    const r = (await this.db('search_keys').where({ tenant_id: tenantId }).max({ v: 'version' })) as { v: number | string | null }[];
    const st = await this.state(tenantId);
    return Math.max(Number(r[0]?.v ?? 0), st?.active_version ?? 0, st?.building_version ?? 0) + 1;
  }

  /** Starts building a new version (a first build, a rebuild or a rotation) and queues its backfill. */
  private async build(ctx: AdminCtx, st: StateRow | null): Promise<{ version: number; jobId: string }> {
    const s = this.s();
    const tenantId = ctx.p.tenantId;
    // A version still building is dropped (its postings and key): the new one starts from the beginning.
    if (st?.building_version != null) await this.retire(tenantId, st.building_version);
    const version = await this.nextVersion(tenantId);
    await this.keys.create(tenantId, version);
    const total = await this.counts(tenantId);
    const t = Date.now();
    const row = { state: st?.active_version != null ? 'ready' : 'building', active_version: st?.active_version ?? null, building_version: version, cursor: null, processed: 0, total, job_id: null, started_at: t, finished_at: null, updated_by: ctx.p.userId, updated_at: t, error: null };
    if (st) await this.db('search_state').where({ tenant_id: tenantId }).update(row);
    else await this.db('search_state').insert({ tenant_id: tenantId, ...row });
    const job = await s.jobs.enqueue({ tenantId, type: BACKFILL_JOB, payload: { tenantId, version }, createdBy: ctx.p.userId, maxAttempts: 5, dedupeKey: `${BACKFILL_JOB}:${tenantId}:${version}` });
    await this.db('search_state').where({ tenant_id: tenantId }).update({ job_id: job.id });
    return { version, jobId: job.id };
  }

  /** Turns the index on for the caller's tenant: writes start now, and the backfill covers what exists. */
  async enable(ctx: AdminCtx) {
    await this.need();
    const st = await this.state(ctx.p.tenantId);
    if (st) throw conflict('The search index is already on. Rebuild or rotate it instead.');
    const out = await this.build(ctx, null);
    await this.audit(ctx, 'search.index.enabled', { version: out.version }, { job: out.jobId });
    return this.status(ctx.p.tenantId);
  }

  /**
   * Resumes a backfill that stopped (`restart: false`, the default while one is building), or builds the whole index
   * again under a new version (`restart: true`, or when nothing is building). Queries keep the current version until
   * the new one is complete.
   */
  async rebuild(ctx: AdminCtx, o: { restart?: boolean } = {}) {
    await this.need();
    const s = this.s();
    const st = await this.state(ctx.p.tenantId);
    if (!st) throw conflict('The search index is off. Turn it on first.');
    if (st.building_version != null && !o.restart) {
      const job = await s.jobs.enqueue({ tenantId: ctx.p.tenantId, type: BACKFILL_JOB, payload: { tenantId: ctx.p.tenantId, version: st.building_version }, createdBy: ctx.p.userId, maxAttempts: 5, dedupeKey: `${BACKFILL_JOB}:${ctx.p.tenantId}:${st.building_version}:resume:${Date.now()}` });
      await this.db('search_state').where({ tenant_id: ctx.p.tenantId }).update({ job_id: job.id, updated_by: ctx.p.userId, updated_at: Date.now(), error: null });
      await this.audit(ctx, 'search.index.resumed', { version: st.building_version }, { job: job.id, processed: st.processed });
      return this.status(ctx.p.tenantId);
    }
    const out = await this.build(ctx, st);
    await this.audit(ctx, 'search.index.rebuilt', { version: out.version }, { job: out.jobId, previous: st.active_version });
    return this.status(ctx.p.tenantId);
  }

  /** A new search key: everything is indexed again under it, then the old key and its postings are removed. */
  async rotate(ctx: AdminCtx) {
    await this.need();
    const st = await this.state(ctx.p.tenantId);
    if (!st) throw conflict('The search index is off. Turn it on first.');
    const out = await this.build(ctx, st);
    await this.audit(ctx, 'search.key.rotated', { version: out.version }, { job: out.jobId, previous: st.active_version });
    return this.status(ctx.p.tenantId);
  }

  /** Turns the index off and removes all of it (postings, prefixes, documents, keys). Search works as before. */
  async disable(ctx: AdminCtx) {
    await this.need();
    const tenantId = ctx.p.tenantId;
    const st = await this.state(tenantId);
    if (!st) throw conflict('The search index is already off.');
    await this.purgeTenant(tenantId);
    await this.audit(ctx, 'search.index.disabled', {}, { activeVersion: st.active_version, buildingVersion: st.building_version });
    return this.status(tenantId);
  }

  /** Deletes a tenant's whole index (disable, offboarding). */
  async purgeTenant(tenantId: string): Promise<void> {
    if (!(await this.installed())) return;
    await this.db('search_state').where({ tenant_id: tenantId }).delete();
    for (const t of ['search_postings', 'search_prefixes', 'search_docs', 'search_keys']) await this.db(t).where({ tenant_id: tenantId }).delete();
    this.keys.forget(tenantId);
  }

  async status(tenantId: string) {
    const installed = await this.installed();
    if (!installed) return { installed, enabled: false, state: 'off' as const, activeVersion: null, buildingVersion: null, progress: null, jobId: null, error: null, documents: 0, keys: [], writeIndexing: false };
    const st = await this.state(tenantId);
    const docs = Number(((await this.db('search_docs').where({ tenant_id: tenantId }).count({ n: '*' })) as { n: number | string }[])[0]?.n ?? 0);
    const cur = st?.cursor ? (JSON.parse(st.cursor) as Cursor) : null;
    return {
      installed,
      enabled: !!st,
      state: (st?.state ?? 'off') as 'off' | 'building' | 'ready',
      activeVersion: st?.active_version ?? null,
      buildingVersion: st?.building_version ?? null,
      progress: st?.building_version != null ? { processed: st.processed, total: st.total, percent: st.total ? Math.min(100, Math.round((st.processed / st.total) * 100)) : 0, at: cur?.kind ?? 'message' } : null,
      jobId: st?.job_id ?? null,
      error: st?.error ?? null,
      startedAt: st?.started_at ?? null,
      finishedAt: st?.finished_at ?? null,
      documents: docs,
      keys: await this.keys.versions(tenantId),
      writeIndexing: !!st
    };
  }
}

