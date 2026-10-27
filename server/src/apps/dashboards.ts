import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { clears, LABELS, labelRank, type Label } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { parseMarkdown, type Run } from '../chat/export-doc.js';
import { toPdf, type PdfBlock } from '../chat/export-pdf.js';
import { json } from '../db/knex.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import { chartSvg, toPdfDrawing } from './chart-render.js';
import { entityFilter, formatNumber, viewFilter, type AppliedFilter, type ChartData } from './charts.js';
import type { Filter } from './query.js';
import type { Actor, AppRow, AppService } from './service.js';

/*
 * 1.8.0, Sprint 44 (B-121): dashboards per app (`app_dashboards`, migration 101).
 *
 * A dashboard is a grid of cards in order, each at a preset size: a chart or number tile (`app_charts`, B-120), a
 * saved view's table (the first rows of an entity's records through a view), or a text card in Markdown (rendered
 * here, escaped: no HTML, links or pictures). Its filters (a date range on a field, or one value of a field) apply to
 * every card whose source has that field; the others say they are unfiltered. It is private to its owner, or shared
 * with the app's readers, which needs `apps:design` and the app's label within the designer's clearance; only its
 * owner or such a designer changes a shared one.
 *
 * Every card is computed as the person viewing it, never stored: a chart through `AppCharts.dataFor` (the reader's
 * grant, clearance and rights on the chart's source), a view's table through `AppService.query` (the reader's grant
 * and masks), so a shared dashboard never shows more than the reader may read, and a card they cannot read says "Not
 * available to you". `render` makes a static HTML or PDF snapshot computed the same way, for downloads, exports
 * (`s.appExports`) and scheduled delivery.
 */

export const CARD_SIZES = ['small', 'medium', 'large', 'wide', 'full'] as const;
export const REFRESH_SECONDS = [0, 30, 60, 300, 900, 3600] as const;
const MAX_CARDS = 24;
const MAX_OWN = 50;
const MAX_SHARED = 50;

const ref = z.string().min(1).max(63);
const id26 = z.string().length(26);
const cardId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const title = z.string().trim().max(120).nullable().default(null);
const size = z.enum(CARD_SIZES).default('medium');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date, YYYY-MM-DD');

export const cardSchema = z.discriminatedUnion('kind', [
  z.object({ id: cardId, kind: z.literal('chart'), chart: id26, title, size }).strict(),
  z.object({ id: cardId, kind: z.literal('view'), entity: ref, view: id26.nullable().default(null), rows: z.number().int().min(1).max(50).default(10), title, size }).strict(),
  z.object({ id: cardId, kind: z.literal('text'), markdown: z.string().max(5000), title, size }).strict()
]);
export type Card = z.infer<typeof cardSchema>;

const filterValue = z.union([z.string().max(200), z.number(), z.boolean(), z.null()]);
export const dashboardFilterSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,30}$/),
    kind: z.enum(['date', 'value']),
    field: z.string().min(1).max(70),
    label: z.string().trim().min(1).max(80),
    /** What the filter starts at: a range for a date, a value for a field. */
    default: z.object({ from: day.nullable().optional(), to: day.nullable().optional(), value: filterValue.optional() }).strict().nullable().default(null)
  })
  .strict();

export const filterValuesSchema = z.record(z.string().max(31), z.object({ from: day.nullable().optional(), to: day.nullable().optional(), value: filterValue.optional() }).strict()).refine((v) => Object.keys(v).length <= 6, 'at most 6 filters');
export type FilterValues = z.infer<typeof filterValuesSchema>;

const layoutShape = {
  description: z.string().trim().max(1000).nullable().default(null),
  cards: z.array(cardSchema).max(MAX_CARDS).default([]),
  filters: z.array(dashboardFilterSchema).max(6).default([]),
  /** Seconds between automatic refreshes in the console; 0 for none. */
  refresh: z
    .number()
    .int()
    .refine((n) => (REFRESH_SECONDS as readonly number[]).includes(n), `one of ${REFRESH_SECONDS.join(', ')}`)
    .default(0)
};
export const dashboardInputSchema = z
  .object({ name: z.string().trim().min(1).max(100), shared: z.boolean().default(false), label: z.enum(LABELS).optional(), ...layoutShape })
  .strict()
  .superRefine(uniqueIds);
export const dashboardPatchSchema = z
  .object({
    rev: z.number().int().min(1).optional(),
    name: z.string().trim().min(1).max(100).optional(),
    shared: z.boolean().optional(),
    label: z.enum(LABELS).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    cards: z.array(cardSchema).max(MAX_CARDS).optional(),
    filters: z.array(dashboardFilterSchema).max(6).optional(),
    refresh: layoutShape.refresh.optional()
  })
  .strict()
  .refine((v) => Object.keys(v).filter((k) => k !== 'rev').length > 0, 'nothing to change')
  .superRefine(uniqueIds);

function uniqueIds(v: { cards?: { id: string }[]; filters?: { id: string }[] }, ctx: z.RefinementCtx) {
  for (const [what, list] of [['card', v.cards ?? []], ['filter', v.filters ?? []]] as const) {
    const seen = new Set<string>();
    for (const x of list) {
      if (seen.has(x.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Two ${what}s have the id ${x.id}.` });
      seen.add(x.id);
    }
  }
}

interface Layout {
  name: string;
  description: string | null;
  cards: Card[];
  filters: z.infer<typeof dashboardFilterSchema>[];
  refresh: number;
}

interface DashboardRow {
  id: string;
  tenant_id: string;
  app_id: string;
  owner_id: string;
  shared: boolean;
  label: Label;
  rev: number;
  data: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
}
const rowFrom = (r: Record<string, unknown>): DashboardRow => ({ ...(r as unknown as DashboardRow), shared: !!r.shared, rev: Number(r.rev), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
const aad = (id: string) => `app-dashboard:${id}`;

export interface CardResult {
  id: string;
  kind: Card['kind'];
  size: Card['size'];
  title: string;
  state: 'ok' | 'unavailable' | 'error';
  reason?: string;
  detail?: string;
  chart?: ChartData;
  /** A view's table: the columns and the first rows as text, as the reader may read them. */
  table?: { entity: string; columns: { name: string; label: string }[]; rows: string[][]; total: number | null; filtersApplied: string[] };
  /** A text card, as safe HTML (everything escaped). */
  html?: string;
}

// ---------- Markdown, escaped ----------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const runsHtml = (runs: Run[]) => runs.map((r) => (r.code ? `<code>${esc(r.text)}</code>` : r.bold && r.italic ? `<strong><em>${esc(r.text)}</em></strong>` : r.bold ? `<strong>${esc(r.text)}</strong>` : r.italic ? `<em>${esc(r.text)}</em>` : esc(r.text))).join('');

/** A text card's Markdown as HTML: headings, paragraphs, lists, code, tables and rules; every character escaped. */
export function markdownHtml(src: string): string {
  const blocks = parseMarkdown(src, 3);
  let h = '';
  let list: 'ul' | 'ol' | null = null;
  const close = () => {
    if (list) h += `</${list}>`;
    list = null;
  };
  for (const b of blocks) {
    if (b.kind === 'item') {
      const tag = b.ordered ? 'ol' : 'ul';
      if (list !== tag) {
        close();
        h += `<${tag}>`;
        list = tag;
      }
      h += `<li>${runsHtml(b.runs)}</li>`;
      continue;
    }
    close();
    switch (b.kind) {
      case 'heading': {
        const level = Math.min(6, b.level + 1);
        h += `<h${level}>${esc(b.text)}</h${level}>`;
        break;
      }
      case 'para':
        h += b.tone === 'quote' ? `<blockquote>${runsHtml(b.runs)}</blockquote>` : `<p>${runsHtml(b.runs)}</p>`;
        break;
      case 'code':
        h += `<pre><code>${esc(b.text)}</code></pre>`;
        break;
      case 'table':
        h += `<table>${b.header ? `<thead><tr>${b.header.map((c) => `<th scope="col">${runsHtml(c)}</th>`).join('')}</tr></thead>` : ''}<tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${runsHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
        break;
      case 'rule':
        h += '<hr>';
        break;
      default:
        break;
    }
  }
  close();
  return h;
}

function cellText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return formatNumber(v);
  if (Array.isArray(v)) return v.map(cellText).join(', ');
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 200);
  return String(v).slice(0, 500);
}

/** A chart's data as a table: the categories and one column per series (or the points, or the number). */
export function chartTable(d: ChartData): { header: string[]; rows: string[][] } {
  if (d.type === 'number') return { header: [d.series[0]?.name ?? 'Value', ...(d.compare ? [d.compare.label, 'Change'] : [])], rows: [[formatNumber(d.value ?? null), ...(d.compare ? [formatNumber(d.compare.value), d.compare.delta == null ? '' : `${d.compare.delta >= 0 ? '+' : '-'}${formatNumber(Math.abs(d.compare.delta))}`] : [])]] };
  if (d.type === 'scatter') return { header: [d.dimension?.label ?? 'Point', d.axes.x, d.axes.y], rows: (d.points ?? []).map((p) => [p.label, formatNumber(p.x), formatNumber(p.y)]) };
  return { header: [d.dimension?.label ?? '', ...d.series.map((s) => s.name)], rows: d.categories.map((c, i) => [c.label, ...d.series.map((s) => formatNumber(s.values[i] ?? null))]) };
}

export class AppDashboards {
  constructor(
    private readonly s: () => Services,
    private readonly apps: AppService
  ) {}

  private get db() {
    return this.s().db;
  }

  private designer(p: Principal): boolean {
    return effectivePermissions(p).has('apps:design');
  }

  private canEdit(p: Principal, app: AppRow, d: DashboardRow): boolean {
    if (!clears(p.clearance, d.label)) return false;
    if (d.owner_id === p.userId) return true;
    return d.shared && this.designer(p) && clears(p.clearance, app.label);
  }

  private async open(d: DashboardRow): Promise<Layout> {
    const raw = json<Record<string, unknown>>(await this.s().keys.open(d.tenant_id, d.data, aad(d.id)), {});
    const parsed = z.object({ name: z.string().default(''), ...layoutShape }).safeParse(raw);
    return parsed.success ? parsed.data : { name: String(raw.name ?? ''), description: null, cards: [], filters: [], refresh: 0 };
  }

  private seal(tenantId: string, id: string, l: Layout): Promise<string> {
    return this.s().keys.seal(tenantId, JSON.stringify(l), aad(id));
  }

  private async present(p: Principal, app: AppRow, d: DashboardRow) {
    const l = await this.open(d);
    return { id: d.id, app: app.name, appId: app.id, name: l.name, description: l.description, cards: l.cards, filters: l.filters, refresh: l.refresh, shared: d.shared, label: d.label, ownerId: d.owner_id, mine: d.owner_id === p.userId, canEdit: this.canEdit(p, app, d), rev: d.rev, updatedBy: d.updated_by, createdAt: d.created_at, updatedAt: d.updated_at };
  }

  private async visibleRows(p: Principal, app: AppRow): Promise<DashboardRow[]> {
    const rows = ((await this.db('app_dashboards').where({ tenant_id: p.tenantId, app_id: app.id }).andWhere((q) => q.where({ owner_id: p.userId }).orWhere({ shared: true })).orderBy('created_at')) as Record<string, unknown>[]).map(rowFrom);
    return rows.filter((d) => clears(p.clearance, d.label));
  }

  private async visible(p: Principal, app: AppRow, id: string): Promise<DashboardRow> {
    const r = (await this.db('app_dashboards').where({ tenant_id: p.tenantId, app_id: app.id, id }).first()) as Record<string, unknown> | undefined;
    const d = r ? rowFrom(r) : null;
    if (!d || !clears(p.clearance, d.label) || (!d.shared && d.owner_id !== p.userId)) throw notFound('Dashboard');
    return d;
  }

  private assertShare(p: Principal, app: AppRow): void {
    if (!this.designer(p)) throw forbidden("Sharing a dashboard with the app's readers needs apps:design.", { step: 'role' });
    if (!clears(p.clearance, app.label)) throw forbidden(`The app holds records up to ${app.label}; your clearance is ${p.clearance}.`, { step: 'clearance' });
  }

  private label(p: Principal, app: AppRow, wanted: Label | undefined): Label {
    const l = wanted ?? (labelRank(app.label) < labelRank('internal') ? app.label : 'internal');
    if (labelRank(l) > labelRank(app.label)) throw badRequest(`The app's label is ${app.label}; a dashboard cannot be above it.`);
    if (!clears(p.clearance, l)) throw forbidden(`Your clearance is ${p.clearance}; a ${l} dashboard is above it.`, { step: 'clearance' });
    return l;
  }

  /** Cards name charts the author can see and entities of the app; filters name fields. */
  private async check(p: Principal, app: AppRow, cards: Card[]): Promise<void> {
    const problems: string[] = [];
    for (const c of cards) {
      if (c.kind === 'chart' && !(await this.apps.charts.visible(p, app, c.chart))) problems.push(`Card ${c.id}: the chart is not one you can see in this app.`);
      if (c.kind === 'view') {
        const ent = await this.apps.entityOf(app, c.entity).catch(() => null);
        if (!ent) problems.push(`Card ${c.id}: ${c.entity} is not an entity of ${app.name}.`);
        else if (c.view && !(await this.apps.views.list(p, app.id, ent.id)).views.some((v) => v.id === c.view)) problems.push(`Card ${c.id}: the saved view is not one you can see on ${ent.name}.`);
      }
    }
    if (problems.length) throw new HttpProblem(400, 'Invalid dashboard', problems[0]!, { extensions: { problems } });
  }

  // ---------- CRUD ----------

  async list(p: Principal, appRef: string) {
    const app = await this.apps.app(p, appRef);
    const rows = await this.visibleRows(p, app);
    const dashboards = await Promise.all(rows.map((d) => this.present(p, app, d)));
    dashboards.sort((a, b) => Number(b.mine) - Number(a.mine) || a.name.localeCompare(b.name));
    return { dashboards, canShare: this.designer(p) && clears(p.clearance, app.label) };
  }

  async get(p: Principal, appRef: string, id: string) {
    const app = await this.apps.app(p, appRef);
    return this.present(p, app, await this.visible(p, app, id));
  }

  async create(actor: Actor & { principal: Principal }, appRef: string, input: z.infer<typeof dashboardInputSchema>) {
    const p = actor.principal;
    const app = await this.apps.app(p, appRef);
    if (input.shared) this.assertShare(p, app);
    const lab = this.label(p, app, input.label);
    await this.check(p, app, input.cards);
    const counted = await this.db('app_dashboards').where({ tenant_id: p.tenantId, app_id: app.id }).andWhere(input.shared ? { shared: true } : { owner_id: p.userId, shared: false }).count({ n: '*' });
    if (Number((counted as Record<string, unknown>[])[0]?.n ?? 0) >= (input.shared ? MAX_SHARED : MAX_OWN)) throw conflict(`At most ${input.shared ? `${MAX_SHARED} shared dashboards` : `${MAX_OWN} dashboards of yours`} in one app.`);
    const id = ulid();
    const now = Date.now();
    const layout: Layout = { name: input.name, description: input.description, cards: input.cards, filters: input.filters, refresh: input.refresh };
    const row = { id, tenant_id: p.tenantId, app_id: app.id, owner_id: p.userId, shared: input.shared, label: lab, rev: 1, data: await this.seal(p.tenantId, id, layout), updated_by: p.userId, created_at: now, updated_at: now };
    await this.db('app_dashboards').insert(row);
    await this.audit(actor, 'app.dashboard.created', { app: app.id, dashboard: id }, lab, { shared: input.shared, cards: input.cards.length, filters: input.filters.length });
    return this.present(p, app, rowFrom(row));
  }

  async update(actor: Actor & { principal: Principal }, appRef: string, id: string, patch: z.infer<typeof dashboardPatchSchema>) {
    const p = actor.principal;
    const app = await this.apps.app(p, appRef);
    const d = await this.visible(p, app, id);
    if (!this.canEdit(p, app, d)) throw forbidden(d.shared ? 'Only its owner or a designer of the app changes a shared dashboard.' : 'Only its owner changes a dashboard.', { step: 'owner' });
    if (patch.rev !== undefined && patch.rev !== d.rev) throw new HttpProblem(409, 'Conflict', `The dashboard changed since version ${patch.rev}; it is at version ${d.rev}. Reload it and try again.`, { extensions: { rev: d.rev } });
    if (patch.shared !== undefined && patch.shared !== d.shared) this.assertShare(p, app);
    const cur = await this.open(d);
    if (patch.cards) await this.check(p, app, patch.cards);
    const layout: Layout = { name: patch.name ?? cur.name, description: patch.description !== undefined ? patch.description : cur.description, cards: patch.cards ?? cur.cards, filters: patch.filters ?? cur.filters, refresh: patch.refresh ?? cur.refresh };
    const shared = patch.shared ?? d.shared;
    const lab = patch.label ? this.label(p, app, patch.label) : d.label;
    const now = Date.now();
    const upd = { shared, label: lab, rev: d.rev + 1, data: await this.seal(d.tenant_id, d.id, layout), updated_by: p.userId, updated_at: now };
    const n = await this.db('app_dashboards').where({ id: d.id, rev: d.rev }).update(upd);
    if (!n) throw conflict('The dashboard changed meanwhile; reload it and try again.');
    const changed = Object.keys(patch).filter((k) => k !== 'rev');
    await this.audit(actor, 'app.dashboard.updated', { app: app.id, dashboard: d.id }, lab, { changed, rev: upd.rev, shared, ...(d.owner_id !== p.userId ? { owner: d.owner_id } : {}) });
    return this.present(p, app, { ...d, ...upd });
  }

  async remove(actor: Actor & { principal: Principal }, appRef: string, id: string): Promise<void> {
    const p = actor.principal;
    const app = await this.apps.app(p, appRef);
    const d = await this.visible(p, app, id);
    if (!this.canEdit(p, app, d)) throw forbidden(d.shared ? 'Only its owner or a designer of the app deletes a shared dashboard.' : 'Only its owner deletes a dashboard.', { step: 'owner' });
    await this.db('app_dashboards').where({ id: d.id }).delete();
    await this.audit(actor, 'app.dashboard.deleted', { app: app.id, dashboard: d.id }, d.label, { shared: d.shared, ...(d.owner_id !== p.userId ? { owner: d.owner_id } : {}) });
  }

  // ---------- computing ----------

  /** The dashboard's filters with the values given (else their defaults), as they apply to cards. */
  static applied(l: Pick<Layout, 'filters'>, values: FilterValues | undefined): AppliedFilter[] {
    const out: AppliedFilter[] = [];
    for (const f of l.filters) {
      const v = values && Object.hasOwn(values, f.id) ? values[f.id]! : (f.default ?? {});
      if (f.kind === 'date') {
        if (v.from && v.to && v.from > v.to) throw badRequest(`${f.label}: the start is after the end.`);
        if (v.from || v.to) out.push({ id: f.id, kind: 'date', field: f.field, from: v.from ?? null, to: v.to ?? null });
      } else if (v.value !== undefined && v.value !== '') out.push({ id: f.id, kind: 'value', field: f.field, value: v.value });
    }
    return out;
  }

  /** Every card as `p` may see it, with the dashboard's filters. */
  async data(p: Principal, appRef: string, id: string, o: { filters?: FilterValues; fresh?: boolean } = {}) {
    const app = await this.apps.app(p, appRef);
    const d = await this.visible(p, app, id);
    const l = await this.open(d);
    const applied = AppDashboards.applied(l, o.filters);
    const cards = await this.cards(p, app, l, applied, !!o.fresh);
    return { id: d.id, name: l.name, label: d.label, rev: d.rev, refresh: l.refresh, applied, cards, computedAt: Date.now() };
  }

  private async cards(p: Principal, app: AppRow, l: Layout, applied: AppliedFilter[], fresh: boolean): Promise<CardResult[]> {
    return Promise.all(l.cards.map((c) => this.card(p, app, c, applied, fresh)));
  }

  private async card(p: Principal, app: AppRow, c: Card, applied: AppliedFilter[], fresh: boolean): Promise<CardResult> {
    const head = { id: c.id, kind: c.kind, size: c.size };
    if (c.kind === 'text') return { ...head, title: c.title ?? '', state: 'ok', html: markdownHtml(c.markdown) };
    if (c.kind === 'chart') {
      const r = await this.apps.charts.dataFor(p, app, c.chart, { filters: applied, fresh });
      if (r.state === 'ok') return { ...head, title: c.title ?? r.data.title, state: 'ok', chart: r.data };
      if (r.state === 'unavailable') return { ...head, title: c.title ?? 'Chart', state: 'unavailable', reason: r.reason };
      return { ...head, title: c.title ?? 'Chart', state: 'error', detail: r.detail };
    }
    try {
      const { entity } = await this.apps.resolve(p, app.id, c.entity);
      const parts: Filter[] = [];
      let q: string | undefined;
      let sort: { field: string; dir: 'asc' | 'desc' }[] = [];
      let fields: string[] | null = null;
      let viewName: string | null = null;
      if (c.view) {
        const v = (await this.apps.views.list(p, app.id, entity.id)).views.find((x) => x.id === c.view);
        if (!v) return { ...head, title: c.title ?? entity.title ?? entity.name, state: 'unavailable', reason: 'The saved view is not shared with you.' };
        viewName = v.name;
        const vf = viewFilter(v.settings);
        if (vf) parts.push(vf);
        if (v.settings.q) q = v.settings.q;
        sort = v.settings.sort;
        fields = v.settings.columns?.fields ?? null;
      }
      const used: string[] = [];
      for (const f of applied) {
        const x = entityFilter(entity, f);
        if (x) {
          parts.push(x);
          used.push(f.id);
        }
      }
      const filter: Filter | undefined = parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : { and: parts };
      const res = await this.apps.query(p, app.id, entity.id, { ...(filter ? { filter } : {}), ...(q ? { q } : {}), sort, limit: c.rows, count: true });
      const byName = new Map(entity.definition.fields.map((f) => [f.name, f]));
      const cols = (fields ?? entity.definition.fields.filter((f) => f.type !== 'json' && f.type !== 'relation').map((f) => f.name)).filter((n) => byName.has(n)).slice(0, 8);
      // A column the reader's policy hides is left out for them (it would be empty on every row).
      const shown = cols.filter((n) => res.records.some((r) => Object.hasOwn(r.values, n)) || !res.records.length);
      return {
        ...head,
        title: c.title ?? viewName ?? entity.title ?? entity.name,
        state: 'ok',
        table: { entity: entity.name, columns: shown.map((n) => ({ name: n, label: byName.get(n)?.title ?? n })), rows: res.records.map((r) => shown.map((n) => cellText(r.values[n]))), total: res.total, filtersApplied: used }
      };
    } catch (err) {
      if (err instanceof HttpProblem) {
        if (err.status === 401 || err.status === 403 || err.status === 404) return { ...head, title: c.title ?? c.entity, state: 'unavailable', reason: err.status === 404 ? 'Its records are not available to you.' : (err.detail ?? err.title) };
        return { ...head, title: c.title ?? c.entity, state: 'error', detail: err.detail ?? err.title };
      }
      throw err;
    }
  }

  // ---------- snapshots ----------

  /**
   * A static snapshot of a dashboard computed as `principal` (B-121): HTML with the charts as SVG and a table beside
   * each, or PDF with the charts as vector drawings and tables. Audited as `app.dashboard.rendered`. Called by the
   * console's download, by `s.appExports` and by scheduled delivery, always as the person it is for.
   */
  async render(principal: Principal, dashboardId: string, o: { format: 'html' | 'pdf'; filters?: FilterValues; ip?: string | null; traceId?: string | null }): Promise<{ filename: string; contentType: string; bytes: Buffer }> {
    const p = principal;
    const r = (await this.db('app_dashboards').where({ tenant_id: p.tenantId, id: dashboardId }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Dashboard');
    const app = await this.apps.app(p, String(r.app_id)).catch(() => {
      throw notFound('Dashboard');
    });
    const data = await this.data(p, app.id, dashboardId, { ...(o.filters ? { filters: o.filters } : {}), fresh: true });
    const d = await this.visible(p, app, dashboardId);
    const l = await this.open(d);
    const at = new Date(data.computedAt);
    const stamp = at.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    const slug = (l.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'dashboard').slice(0, 60);
    const filterLine = data.applied.length ? data.applied.map((f) => `${l.filters.find((x) => x.id === f.id)?.label ?? f.id}: ${f.kind === 'date' ? `${f.from ?? '…'} to ${f.to ?? '…'}` : String(f.value)}`).join('; ') : 'none';
    const meta: [string, string][] = [
      ['App', app.title || app.name],
      ['Label', d.label],
      ['Computed for', p.displayName],
      ['At', at.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'],
      ['Filters', filterLine]
    ];
    let out: { filename: string; contentType: string; bytes: Buffer };
    if (o.format === 'pdf') {
      const blocks: PdfBlock[] = [];
      if (l.description) blocks.push({ kind: 'para', runs: [{ text: l.description }] });
      for (const c of data.cards) {
        blocks.push({ kind: 'heading', level: 2, text: c.title || (c.kind === 'text' ? 'Note' : 'Card') });
        if (c.state !== 'ok') {
          blocks.push({ kind: 'para', runs: [{ text: c.state === 'unavailable' ? 'Not available to you.' : `Could not be computed: ${c.detail ?? ''}` }], tone: 'muted' });
          continue;
        }
        if (c.kind === 'text') {
          const src = l.cards.find((x) => x.id === c.id);
          if (src?.kind === 'text') blocks.push(...parseMarkdown(src.markdown, 3));
        }
        if (c.chart) {
          const drawing = toPdfDrawing(c.chart, 483);
          if (drawing) blocks.push({ kind: 'drawing', ...drawing, alt: c.chart.summary });
          else blocks.push({ kind: 'para', runs: [{ text: c.chart.summary }], tone: 'muted' });
          const t = chartTable(c.chart);
          blocks.push({ kind: 'table', header: t.header.map((h) => [{ text: h }]), rows: t.rows.map((row) => row.map((v) => [{ text: v }])) });
          if (c.chart.truncated) blocks.push({ kind: 'para', runs: [{ text: `Showing the first ${c.chart.categories.length} of ${c.chart.groups}.` }], tone: 'muted' });
        }
        if (c.table) {
          blocks.push({ kind: 'table', header: c.table.columns.map((x) => [{ text: x.label }]), rows: c.table.rows.map((row) => row.map((v) => [{ text: v }])) });
          blocks.push({ kind: 'para', runs: [{ text: `${c.table.rows.length} of ${c.table.total ?? c.table.rows.length} records.` }], tone: 'muted' });
        }
      }
      out = { filename: `${slug}-${stamp}.pdf`, contentType: 'application/pdf', bytes: toPdf({ title: l.name, meta, blocks, label: d.label, author: p.displayName, createdAt: at.toISOString() }) };
    } else out = { filename: `${slug}-${stamp}.html`, contentType: 'text/html; charset=utf-8', bytes: Buffer.from(snapshotHtml(l, d.label, meta, data.cards), 'utf8') };
    await this.s().audit.append({ tenantId: p.tenantId, action: 'app.dashboard.rendered', kind: 'admin', actor: actorFrom(p, o.ip ?? null), target: { app: app.id, dashboard: d.id }, label: d.label, detail: { format: o.format, cards: data.cards.length, unavailable: data.cards.filter((c) => c.state !== 'ok').length, filters: data.applied.map((f) => f.id), bytes: out.bytes.length }, traceId: o.traceId ?? null });
    return out;
  }

  private audit(actor: Actor & { principal: Principal }, action: string, target: Record<string, unknown>, lab: Label, detail?: Record<string, unknown>) {
    return this.s().audit.append({ tenantId: actor.principal.tenantId, action, kind: 'admin', actor: actorFrom(actor.principal, actor.ip ?? null), target, label: lab, ...(detail ? { detail } : {}), traceId: actor.traceId ?? null });
  }
}

const SNAPSHOT_STYLE = [
  ':root{--bg:#fff;--panel:#fff;--fg:#16181d;--fg2:#3d4250;--muted:#565b66;--line:#d9dce3;--accent:#2457c5;--info-fg:#1b4c8c;--ok-fg:#1c6a38;--warn-fg:#7a5200;--danger-fg:#a01e18;color-scheme:light dark}',
  '@media (prefers-color-scheme:dark){:root{--bg:#121418;--panel:#1a1d23;--fg:#eef0f4;--fg2:#c5cad4;--muted:#aab0bc;--line:#3a3f4a;--accent:#8fb0ff;--info-fg:#8cc0ff;--ok-fg:#7fd49a;--warn-fg:#f0c060;--danger-fg:#ff9a90}}',
  'body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}main{max-width:1180px;margin:0 auto;padding:24px 16px}',
  'h1{font-size:24px;margin:0 0 4px}dl.meta{display:flex;flex-wrap:wrap;gap:4px 16px;margin:0 0 20px;color:var(--muted);font-size:13px}dl.meta dt{font-weight:600}dl.meta dd{margin:0}',
  '.grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:16px}.card{border:1px solid var(--line);border-radius:8px;padding:14px;background:var(--panel);min-width:0;overflow-wrap:anywhere}',
  '.small{grid-column:span 3}.medium{grid-column:span 4}.large{grid-column:span 6}.wide{grid-column:span 8}.full{grid-column:span 12}@media (max-width:900px){.card{grid-column:span 12}}',
  'h2{font-size:16px;margin:0 0 8px}.summary,.muted{color:var(--muted);font-size:13px}.na{color:var(--fg2);font-style:italic}',
  'table{border-collapse:collapse;width:100%;font-size:13px;margin:8px 0}th,td{border:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top}th{font-weight:600}',
  '.tw{overflow-x:auto}.value{font-size:36px;font-weight:700}ul.legend{display:flex;flex-wrap:wrap;gap:4px 14px;list-style:none;padding:0;margin:6px 0;font-size:13px}ul.legend li{display:flex;align-items:center;gap:6px}',
  'details summary{cursor:pointer;color:var(--accent)}pre{background:var(--bg);padding:8px;overflow-x:auto}'
].join('');

function snapshotHtml(l: Layout, label: Label, meta: [string, string][], cards: CardResult[]): string {
  const table = (header: string[], rows: string[][], caption: string) => `<div class="tw"><table><caption class="muted">${esc(caption)}</caption><thead><tr>${header.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  const body = cards
    .map((c, i) => {
      let inner = '';
      if (c.state === 'unavailable') inner = '<p class="na">Not available to you.</p>';
      else if (c.state === 'error') inner = `<p class="na">Could not be computed: ${esc(c.detail ?? '')}</p>`;
      else if (c.html !== undefined) inner = c.html;
      else if (c.chart) {
        const t = chartTable(c.chart);
        inner = c.chart.type === 'number' ? `<p class="value">${esc(formatNumber(c.chart.value ?? null))}</p><p class="summary">${esc(c.chart.summary)}</p>` : c.chart.type === 'table' ? table(t.header, t.rows, c.chart.summary) : `${chartSvg(c.chart, `c${i}`)}<p class="summary">${esc(c.chart.summary)}</p><details><summary>View as table</summary>${table(t.header, t.rows, c.chart.title)}</details>`;
      } else if (c.table) inner = `${table(c.table.columns.map((x) => x.label), c.table.rows, `${c.table.rows.length} of ${c.table.total ?? c.table.rows.length} records`)}`;
      return `<section class="card ${c.size}" aria-labelledby="h${i}"><h2 id="h${i}">${esc(c.title || 'Note')}</h2>${inner}</section>`;
    })
    .join('\n');
  return (
    '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">` +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="generator" content="Exprsn-AI">' +
    `<title>${esc(l.name)}</title><style>${SNAPSHOT_STYLE}</style></head>\n<body><main>\n<h1>${esc(l.name)}</h1>\n` +
    (l.description ? `<p>${esc(l.description)}</p>` : '') +
    `<dl class="meta">${meta.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>\n<div class="grid">\n${body}\n</div>\n<p class="muted">A snapshot from Exprsn-AI, computed for the person named above. Label: ${esc(label)}.</p>\n</main></body></html>\n`
  );
}
