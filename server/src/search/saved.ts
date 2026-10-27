import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { badRequest, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import { SOURCE_INFO, SOURCES, type Source } from './everything.js';
import { chatFilters, chatQuery, postFilters, postQuery } from './filters.js';

/*
 * 1.9.9-qa (B-173, the Sprint 52 leftovers): saved searches, `s.search.saved`.
 *
 * - A person saves a query with its source (`all` or one source of the box) and, for chats and posts, its filters;
 *   lists, renames (or changes), deletes and runs them. Saved searches are per person and private: every read and
 *   write is by the caller's own tenant and user, and another person's saved search is not found.
 * - The name, the query and the filters are content: they are sealed together with the tenant key, with the owner
 *   and the row id as associated data (`saved-search:<tenant>:<user>:<id>`). Only the source is plain.
 * - Running one is the same search as typed into the box, as the reader now: the source's permission is asked again
 *   (a source the person lost is 403), the filters are read by the same schemas as the search routes, and every result
 *   is checked again by that search. Runs are not audited (queries are not); creating, changing and deleting are,
 *   without the name or the query.
 * - Until migration `145_saved_searches` is applied, `available()` is false: the list says so, writes answer 503, and
 *   the console hides the feature.
 */

export const SAVED_SOURCES = ['all', ...SOURCES] as const;
export type SavedSource = (typeof SAVED_SOURCES)[number];
export const MAX_SAVED = 100;
export const MAX_SAVED_NAME = 120;
const TABLE = 'saved_searches';
const SCHEMA_RECHECK_MS = 30_000;

/** Filter values as the routes take them: a string, or a list of strings. */
export const rawFilters = z
  .record(z.string().max(32), z.union([z.string().max(65), z.array(z.string().max(16)).max(20)]))
  .refine((o) => Object.keys(o).length <= 20, 'At most 20 filters.');
export type RawFilters = z.infer<typeof rawFilters>;

export interface SavedCtx {
  p: Principal;
  ip: string | null;
  traceId?: string | null;
}

interface Row {
  id: string;
  tenant_id: string;
  user_id: string;
  source: string;
  sealed: string;
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
}

interface Body {
  name: string;
  q: string;
  filters: RawFilters;
}

export interface SavedView {
  id: string;
  name: string;
  q: string;
  source: SavedSource;
  filters: RawFilters;
  createdAt: number;
  updatedAt: number;
  lastRunAt: number | null;
}

/** Like the routes' `parseBody`: 400 with the issues (kept here so the search module does not import the HTTP layer). */
function parseBody<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw badRequest('The request did not validate.', { errors: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  return r.data;
}

const rowFrom = (r: Record<string, unknown>): Row => ({ ...(r as unknown as Row), created_at: Number(r.created_at), updated_at: Number(r.updated_at), last_run_at: r.last_run_at == null ? null : Number(r.last_run_at) });
const isSource = (v: string): v is SavedSource => (SAVED_SOURCES as readonly string[]).includes(v);
const aad = (r: Pick<Row, 'tenant_id' | 'user_id' | 'id'>) => `saved-search:${r.tenant_id}:${r.user_id}:${r.id}`;

/** The filters without empty values, checked by the source's own schema (only chats and posts take filters). */
function cleanFilters(source: SavedSource, filters: RawFilters | undefined): RawFilters {
  const out: RawFilters = {};
  for (const [k, v] of Object.entries(filters ?? {})) {
    const val = Array.isArray(v) ? v.map((x) => x.trim()).filter(Boolean) : v.trim();
    if (Array.isArray(val) ? val.length : val) out[k] = val;
  }
  if (source === 'chats') parseBody(z.object(chatFilters).strict(), out);
  else if (source === 'posts') parseBody(z.object(postFilters).strict(), out);
  else if (Object.keys(out).length) throw badRequest('Only chat and post searches take filters.', { field: 'filters' });
  return out;
}

export class SavedSearches {
  private schema: { ok: boolean; at: number } | null = null;

  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  /** Whether migration 145 is applied; a negative answer is checked again every 30 s. */
  async available(): Promise<boolean> {
    const t = Date.now();
    if (this.schema && (this.schema.ok || t - this.schema.at < SCHEMA_RECHECK_MS)) return this.schema.ok;
    let ok: boolean;
    try {
      ok = await this.db.schema.hasTable(TABLE);
    } catch {
      ok = false;
    }
    this.schema = { ok, at: t };
    return ok;
  }

  /** Forgets the cached schema answer (tests apply the migration by hand). */
  resetSchemaCache(): void {
    this.schema = null;
  }

  private async requireTable(): Promise<void> {
    if (!(await this.available())) throw new HttpProblem(503, 'Saved searches not installed', 'This server has not had migration 145_saved_searches yet. Search works as before; searches cannot be saved.');
  }

  /** The source's permission, as its search asks it. */
  private assertSource(p: Principal, source: SavedSource): void {
    if (source === 'all') return;
    const info = SOURCE_INFO[source];
    if (!effectivePermissions(p).has(info.perm)) throw forbidden(`Your roles do not let you search ${info.title.toLowerCase()}.`, { step: 'permission', permission: info.perm });
  }

  private async audit(ctx: SavedCtx, action: string, id: string, detail: Record<string, unknown>): Promise<void> {
    await this.s().audit.append({ tenantId: ctx.p.tenantId, action, kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target: { savedSearch: id }, label: 'internal', detail, traceId: ctx.traceId ?? null });
  }

  private async view(r: Row): Promise<SavedView> {
    const opened = await this.s().keys.open(r.tenant_id, r.sealed, aad(r));
    let body: Partial<Body>;
    try {
      body = JSON.parse(opened) as Partial<Body>;
    } catch {
      body = {};
    }
    return { id: r.id, name: body.name ?? '', q: body.q ?? '', source: isSource(r.source) ? r.source : 'all', filters: body.filters ?? {}, createdAt: r.created_at, updatedAt: r.updated_at, lastRunAt: r.last_run_at };
  }

  /** One of the caller's own saved searches, or 404 (another person's is not found either). */
  private async own(p: Principal, id: string): Promise<Row> {
    const r = await this.db(TABLE).where({ tenant_id: p.tenantId, user_id: p.userId, id }).first();
    if (!r) throw notFound('Saved search');
    return rowFrom(r as Record<string, unknown>);
  }

  /** The caller's saved searches, the most recently changed or run first. */
  async list(p: Principal): Promise<{ available: boolean; items: SavedView[]; max: number }> {
    if (!(await this.available())) return { available: false, items: [], max: MAX_SAVED };
    const rows = ((await this.db(TABLE).where({ tenant_id: p.tenantId, user_id: p.userId }).orderBy('updated_at', 'desc').orderBy('id', 'desc').limit(MAX_SAVED)) as Record<string, unknown>[]).map(rowFrom);
    const items = await Promise.all(rows.map((r) => this.view(r)));
    items.sort((a, b) => Math.max(b.updatedAt, b.lastRunAt ?? 0) - Math.max(a.updatedAt, a.lastRunAt ?? 0) || (b.id < a.id ? -1 : 1));
    return { available: true, items, max: MAX_SAVED };
  }

  async get(p: Principal, id: string): Promise<SavedView> {
    await this.requireTable();
    return this.view(await this.own(p, id));
  }

  async create(ctx: SavedCtx, input: { name: string; q: string; source: SavedSource; filters?: RawFilters | undefined }): Promise<SavedView> {
    await this.requireTable();
    const p = ctx.p;
    this.assertSource(p, input.source);
    const filters = cleanFilters(input.source, input.filters);
    const n = (await this.db(TABLE).where({ tenant_id: p.tenantId, user_id: p.userId }).count({ n: '*' })) as { n: number | string }[];
    if (Number(n[0]?.n ?? 0) >= MAX_SAVED) throw new HttpProblem(422, 'Too many saved searches', `You can keep at most ${MAX_SAVED} saved searches. Delete one first.`);
    const id = ulid();
    const t = Date.now();
    const key = { id, tenant_id: p.tenantId, user_id: p.userId };
    const sealed = await this.s().keys.seal(p.tenantId, JSON.stringify({ name: input.name, q: input.q, filters } satisfies Body), aad(key));
    await this.db(TABLE).insert({ ...key, source: input.source, sealed, created_at: t, updated_at: t, last_run_at: null });
    await this.audit(ctx, 'search.saved.created', id, { source: input.source, filters: Object.keys(filters).sort() });
    return { id, name: input.name, q: input.q, source: input.source, filters, createdAt: t, updatedAt: t, lastRunAt: null };
  }

  /** Renames, or changes the query, the source or the filters (filters are replaced as a whole). */
  async update(ctx: SavedCtx, id: string, patch: { name?: string | undefined; q?: string | undefined; source?: SavedSource | undefined; filters?: RawFilters | undefined }): Promise<SavedView> {
    await this.requireTable();
    const p = ctx.p;
    const row = await this.own(p, id);
    const cur = await this.view(row);
    const source = patch.source ?? cur.source;
    if (patch.source !== undefined || patch.filters !== undefined) this.assertSource(p, source);
    // A new source drops filters that only the old one takes, unless new ones are given.
    const filters = patch.filters !== undefined ? cleanFilters(source, patch.filters) : source === cur.source ? cur.filters : cleanFilters(source, {});
    const next: Body = { name: patch.name ?? cur.name, q: patch.q ?? cur.q, filters };
    const t = Date.now();
    await this.db(TABLE)
      .where({ id: row.id, tenant_id: p.tenantId, user_id: p.userId })
      .update({ source, sealed: await this.s().keys.seal(p.tenantId, JSON.stringify(next), aad(row)), updated_at: t });
    await this.audit(ctx, 'search.saved.updated', row.id, { renamed: patch.name !== undefined && patch.name !== cur.name, query: patch.q !== undefined && patch.q !== cur.q, source, filters: Object.keys(filters).sort() });
    return { ...cur, ...next, source, updatedAt: t };
  }

  async remove(ctx: SavedCtx, id: string): Promise<{ id: string; deleted: true }> {
    await this.requireTable();
    const row = await this.own(ctx.p, id);
    await this.db(TABLE).where({ id: row.id, tenant_id: ctx.p.tenantId, user_id: ctx.p.userId }).delete();
    await this.audit(ctx, 'search.saved.deleted', row.id, { source: row.source });
    return { id: row.id, deleted: true };
  }

  /** Runs a saved search as the caller now: the same search the box would run, with its filters. */
  async run(p: Principal, id: string, page: { limit?: number | undefined; offset?: number | undefined } = {}) {
    await this.requireTable();
    const row = await this.own(p, id);
    const saved = await this.view(row);
    this.assertSource(p, saved.source);
    const search = this.s().search;
    let results: unknown;
    if (saved.source === 'chats') results = await search.chats.search(p, parseBody(chatQuery, { q: saved.q, ...saved.filters, ...page }));
    else if (saved.source === 'posts') results = await search.posts.search(p, parseBody(postQuery, { q: saved.q, ...saved.filters, ...page }));
    else results = await search.everything.search(p, { q: saved.q, sources: saved.source === 'all' ? undefined : [saved.source as Source], limit: page.limit ? Math.min(page.limit, 20) : saved.source === 'all' ? 5 : 20 });
    const t = Date.now();
    await this.db(TABLE).where({ id: row.id, tenant_id: p.tenantId, user_id: p.userId }).update({ last_run_at: t });
    return { saved: { ...saved, lastRunAt: t }, results };
  }

  /** Deletes every saved search of a person (their account is removed or offboarded). */
  async removeAllOf(tenantId: string, userId: string): Promise<number> {
    if (!(await this.available())) return 0;
    return Number(await this.db(TABLE).where({ tenant_id: tenantId, user_id: userId }).delete());
  }
}
