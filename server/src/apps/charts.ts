import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { clears, highest, LABELS, labelRank, type Label } from '../authz/labels.js';
import { authorize, effectivePermissions, type Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import { filterSchema, type AggregateInput, type DateBucket, type Filter } from './query.js';
import type { Field } from './schema.js';
import type { Actor, AppRow, AppService, EntityRow } from './service.js';
import type { ViewSettings } from './views.js';

/*
 * 1.8.0, Sprint 44 (B-120): charts over app records, saved connection queries and REST endpoints.
 *
 * A chart is its own object of an app (`app_charts`, migration 100), not part of the entity design or the app package:
 * it is made and changed by people who read the app, private to its owner or shared with the app's readers, like a
 * saved view (sharing, and changing someone else's shared chart, needs `apps:design` and the app's label within the
 * designer's clearance). Each save is a version (`rev`, `app_chart_versions`). The name and the definition are sealed
 * with the tenant key (`app-chart:<id>`).
 *
 * A chart stores a definition, never data. Its series are computed as the person who looks at it:
 *
 * - an entity source goes through `AppService.aggregate` (the reader's grant, clearance and hidden rules: a row the
 *   reader may not read is never counted), after an optional saved view's filters (the view must be visible to the
 *   reader) and the dashboard's filters; a field a policy hides or masks from the reader makes the chart unavailable
 *   to them, as grouping or summing it would show its values;
 * - a saved query (`s.savedQueries.run`) or a REST endpoint (`s.restConnections.read`) is read as the reader, who needs
 *   `connections:query` and clearance for its label, at most at the app's label; at most `ROW_CAP` rows are grouped
 *   here.
 *
 * Results are capped (`limit`, at most 200 categories, 8 series), and kept for `TTL_MS` keyed by the reader, their
 * permissions, clearance and grant, the chart's version and the filters. A chart the reader cannot read computes to
 * `{ state: 'unavailable' }`, which cards show as "Not available to you".
 */

export const CHART_TYPES = ['bar', 'line', 'area', 'pie', 'donut', 'scatter', 'number', 'table'] as const;
export type ChartType = (typeof CHART_TYPES)[number];
/** Series colours: names of the console theme's CSS variables (`accent` is `--accent`, `info` is `--info-fg`...). */
export const CHART_COLORS = ['accent', 'info', 'ok', 'warn', 'danger', 'fg2'] as const;
export type ChartColor = (typeof CHART_COLORS)[number];
export const BUCKETS = ['day', 'week', 'month', 'quarter', 'year'] as const;

export const ROW_CAP = 5000;
export const MAX_CATEGORIES = 200;
export const MAX_SERIES = 8;
const TTL_MS = 15_000;
const CACHE_MAX = 500;
const MAX_OWN = 100;
const MAX_SHARED = 100;

const ref = z.string().min(1).max(63);
const id26 = z.string().length(26);
const fieldName = z.string().min(1).max(70);
const paramValue = z.union([z.string().max(1000), z.number(), z.boolean(), z.null(), z.array(z.union([z.string().max(200), z.number()])).max(100)]);
const paramsSchema = z.record(z.string().max(63), paramValue).refine((v) => Object.keys(v).length <= 30, 'at most 30 parameters');

export const chartSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('entity'), entity: ref, view: id26.nullable().default(null), filter: filterSchema.optional(), q: z.string().trim().min(1).max(200).optional() }).strict(),
  z.object({ kind: z.literal('query'), query: ref, params: paramsSchema.default({}) }).strict(),
  z.object({ kind: z.literal('rest'), connection: ref, endpoint: ref, params: paramsSchema.default({}) }).strict()
]);
export type ChartSource = z.infer<typeof chartSourceSchema>;

const label = z.string().trim().max(80).nullable().default(null);
const measureSchema = z.union([z.object({ op: z.literal('count'), label }).strict(), z.object({ op: z.enum(['sum', 'avg', 'min', 'max']), field: fieldName, label }).strict()]);
export type Measure = z.infer<typeof measureSchema>;

export const chartDefinitionSchema = z
  .object({
    type: z.enum(CHART_TYPES),
    source: chartSourceSchema,
    /** The categories: a field (or a column), a date by a bucket; null for a number tile or a single row. */
    dimension: z.object({ field: fieldName, bucket: z.enum(BUCKETS).optional() }).strict().nullable().default(null),
    /** A second field that splits one measure into series (stacked or grouped bars, several lines). */
    split: z.object({ field: fieldName }).strict().nullable().default(null),
    measures: z.array(measureSchema).min(1).max(5),
    orientation: z.enum(['vertical', 'horizontal']).default('vertical'),
    stacking: z.enum(['grouped', 'stacked']).default('grouped'),
    /** A number tile's comparison: the previous period of a date, or a target. */
    compare: z
      .union([z.object({ kind: z.literal('previous'), field: fieldName, period: z.enum(BUCKETS) }).strict(), z.object({ kind: z.literal('target'), value: z.number().finite() }).strict()])
      .nullable()
      .default(null),
    sort: z.object({ by: z.enum(['key', 'value']).default('key'), dir: z.enum(['asc', 'desc']).default('asc') }).strict().default({ by: 'key', dir: 'asc' }),
    limit: z.number().int().min(1).max(MAX_CATEGORIES).default(50),
    colors: z.array(z.enum(CHART_COLORS)).max(8).default([]),
    labels: z
      .object({ title: z.string().trim().max(200).nullable().default(null), x: label, y: label, values: z.boolean().default(false), legend: z.boolean().default(true) })
      .strict()
      .default({ title: null, x: null, y: null, values: false, legend: true })
  })
  .strict()
  .superRefine((d, ctx) => {
    const say = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (d.type === 'number') {
      if (d.dimension || d.split) say('A number tile has no dimension or split.');
      if (d.measures.length !== 1) say('A number tile shows one measure.');
    } else {
      if (d.compare) say('Only a number tile has a comparison.');
      if (!d.dimension && d.type !== 'table') say(`A ${d.type} chart needs a dimension.`);
    }
    if ((d.type === 'pie' || d.type === 'donut') && (d.measures.length !== 1 || d.split)) say('A pie or donut shows one measure without a split.');
    if (d.type === 'scatter' && (d.split || d.measures.length > 2)) say('A scatter plots one measure against its numeric dimension, or two measures against each other.');
    if (d.split && d.measures.length !== 1) say('A split shows one measure as several series.');
    if (d.split && d.dimension && d.split.field === d.dimension.field) say('The split is another field than the dimension.');
  });
export type ChartDefinition = z.infer<typeof chartDefinitionSchema>;

export const chartInputSchema = z.object({ name: z.string().trim().min(1).max(100), shared: z.boolean().default(false), label: z.enum(LABELS).optional(), definition: chartDefinitionSchema }).strict();
export const chartPatchSchema = z
  .object({ rev: z.number().int().min(1).optional(), name: z.string().trim().min(1).max(100).optional(), shared: z.boolean().optional(), label: z.enum(LABELS).optional(), definition: chartDefinitionSchema.optional() })
  .strict()
  .refine((v) => Object.keys(v).filter((k) => k !== 'rev').length > 0, 'nothing to change');

/** A dashboard filter as applied to a chart: a date range (`from`, `to`, inclusive days) or one value of a field. */
export interface AppliedFilter {
  id: string;
  kind: 'date' | 'value';
  field: string;
  from?: string | null;
  to?: string | null;
  value?: string | number | boolean | null;
}

export interface ChartData {
  type: ChartType;
  title: string;
  orientation: 'vertical' | 'horizontal';
  stacking: 'grouped' | 'stacked';
  dimension: { field: string; bucket: DateBucket | null; label: string } | null;
  categories: { key: string | number | null; label: string }[];
  series: { name: string; values: (number | null)[] }[];
  /** Scatter: one point per category. */
  points?: { x: number; y: number; label: string }[];
  axes: { x: string; y: string };
  /** A number tile. */
  value?: number | null;
  compare?: { kind: 'previous' | 'target'; label: string; value: number | null; delta: number | null; pct: number | null };
  colors: ChartColor[];
  showValues: boolean;
  legend: boolean;
  /** More categories (or series, or rows) than the chart shows. */
  truncated: boolean;
  /** Categories before the limit. */
  groups: number;
  rowsRead?: number;
  /** The dashboard filters that applied to this chart. */
  filtersApplied: string[];
  summary: string;
  label: Label;
  computedAt: number;
  cached: boolean;
}

export type ChartResult = { state: 'ok'; data: ChartData } | { state: 'unavailable'; reason: string } | { state: 'error'; title: string; detail: string };

export interface ChartRow {
  id: string;
  tenant_id: string;
  app_id: string;
  owner_id: string;
  shared: boolean;
  label: Label;
  source_kind: string;
  entity_id: string | null;
  rev: number;
  data: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
}
const rowFrom = (r: Record<string, unknown>): ChartRow => ({ ...(r as unknown as ChartRow), shared: !!r.shared, rev: Number(r.rev), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
const aad = (id: string) => `app-chart:${id}`;
const aadVersion = (id: string, rev: number) => `app-chart:${id}:${rev}`;

const SYSTEM_DATES = new Set(['createdAt', 'updatedAt']);
const SYSTEM = new Set(['id', 'state', 'createdAt', 'updatedAt', 'createdBy']);
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 24);
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A date bucket's key for an instant, as `bucketSql` spells it (UTC). */
export function bucketKey(ms: number, bucket: DateBucket): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  switch (bucket) {
    case 'day':
      return isoDay(ms);
    case 'week': {
      const wd = (d.getUTCDay() + 6) % 7;
      return isoDay(Date.UTC(y, m, d.getUTCDate() - wd));
    }
    case 'month':
      return `${y}-${String(m + 1).padStart(2, '0')}`;
    case 'quarter':
      return `${y}-Q${Math.floor(m / 3) + 1}`;
    case 'year':
      return String(y);
  }
}

/** A bucket key as people read it: `16 Oct 2026`, `Week of 12 Oct 2026`, `Oct 2026`, `Q4 2026`, `2026`. */
export function bucketLabel(key: string, bucket: DateBucket): string {
  const dmy = (k: string) => {
    const [y, m, d] = k.split('-');
    return `${Number(d)} ${MONTHS[Number(m) - 1] ?? m} ${y}`;
  };
  switch (bucket) {
    case 'day':
      return DAY.test(key) ? dmy(key) : key;
    case 'week':
      return DAY.test(key) ? `Week of ${dmy(key)}` : key;
    case 'month': {
      const [y, m] = key.split('-');
      return `${MONTHS[Number(m) - 1] ?? m} ${y}`;
    }
    case 'quarter': {
      const [y, q] = key.split('-');
      return `${q} ${y}`;
    }
    case 'year':
      return key;
  }
}

/** The start of the period an instant is in (UTC), and of the one before it. */
export function periodStarts(now: number, period: DateBucket): { current: number; previous: number } {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  switch (period) {
    case 'day': {
      const c = Date.UTC(y, m, d.getUTCDate());
      return { current: c, previous: c - 86_400_000 };
    }
    case 'week': {
      const c = Date.UTC(y, m, d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return { current: c, previous: c - 7 * 86_400_000 };
    }
    case 'month':
      return { current: Date.UTC(y, m, 1), previous: Date.UTC(y, m - 1, 1) };
    case 'quarter': {
      const q = Math.floor(m / 3) * 3;
      return { current: Date.UTC(y, q, 1), previous: Date.UTC(y, q - 3, 1) };
    }
    case 'year':
      return { current: Date.UTC(y, 0, 1), previous: Date.UTC(y - 1, 0, 1) };
  }
}

const fmt = (n: number | null | undefined): string => (n == null ? 'no value' : Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 2 }));
export const formatNumber = fmt;

/** The sentence a screen reader hears for a chart (its `role="img"` name) and the snapshot prints under it. */
export function chartSummary(d: Omit<ChartData, 'summary' | 'computedAt' | 'cached'>): string {
  const kind = d.type === 'number' ? 'Number' : d.type === 'table' ? 'Table' : `${d.type[0]!.toUpperCase()}${d.type.slice(1)} chart`;
  const head = `${kind}: ${d.title}.`;
  if (d.type === 'number') {
    const c = d.compare;
    return `${head} ${fmt(d.value)}${c ? `; ${c.label} ${fmt(c.value)}${c.delta != null ? `, ${c.delta >= 0 ? 'up' : 'down'} ${fmt(Math.abs(c.delta))}${c.pct != null ? ` (${fmt(Math.abs(c.pct))} %)` : ''}` : ''}` : ''}.`;
  }
  if (d.type === 'scatter') {
    const pts = d.points ?? [];
    return `${head} ${pts.length} point${pts.length === 1 ? '' : 's'} of ${d.axes.y} against ${d.axes.x}.${d.truncated ? ' Not every point is shown.' : ''}`;
  }
  const n = d.categories.length;
  const parts = [`${head} ${n} ${n === 1 ? 'category' : 'categories'}${d.dimension ? ` of ${d.dimension.label}` : ''}, ${d.series.length === 1 ? d.series[0]!.name : `${d.series.length} series: ${d.series.map((s) => s.name).join(', ')}`}.`];
  if (n && d.series.length) {
    const totals = d.categories.map((_, i) => d.series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
    let hi = 0;
    let lo = 0;
    totals.forEach((t, i) => {
      if (t > totals[hi]!) hi = i;
      if (t < totals[lo]!) lo = i;
    });
    if (n > 1) parts.push(`Highest ${d.categories[hi]!.label} at ${fmt(totals[hi])}, lowest ${d.categories[lo]!.label} at ${fmt(totals[lo])}.`);
    else parts.push(`${d.categories[0]!.label} at ${fmt(totals[0])}.`);
  }
  if (d.truncated) parts.push(`Showing the first ${n} of ${d.groups}.`);
  return parts.join(' ');
}

type Group = { key: string | number | null; values: (number | null)[] };

/** Groups rows of a query or REST read in memory: the same groups `aggregate` makes of records. */
export function groupRows(rows: Record<string, unknown>[], o: { dimension: { field: string; bucket?: DateBucket } | null; measures: Measure[]; filter?: (r: Record<string, unknown>) => boolean }): Group[] {
  const groups = new Map<string, { key: string | number | null; acc: { n: number; sum: number; min: number | null; max: number | null; count: number }[] }>();
  for (const r of rows) {
    if (o.filter && !o.filter(r)) continue;
    let key: string | number | null = null;
    if (o.dimension) {
      const raw = r[o.dimension.field];
      if (o.dimension.bucket) {
        const t = instant(raw);
        key = t == null ? null : bucketKey(t, o.dimension.bucket);
      } else key = raw == null || raw === '' ? null : typeof raw === 'number' ? raw : typeof raw === 'boolean' ? String(raw) : String(raw).slice(0, 200);
    }
    const k = `${typeof key}:${String(key)}`;
    let g = groups.get(k);
    if (!g) {
      if (groups.size >= 1000) throw badRequest('More than 1000 groups; filter the rows or group by another column.');
      g = { key, acc: o.measures.map(() => ({ n: 0, sum: 0, min: null, max: null, count: 0 })) };
      groups.set(k, g);
    }
    o.measures.forEach((m, i) => {
      const a = g!.acc[i]!;
      a.count++;
      if (m.op === 'count') return;
      const v = num(r[m.field]);
      if (v == null) return;
      a.n++;
      a.sum += v;
      a.min = a.min == null ? v : Math.min(a.min, v);
      a.max = a.max == null ? v : Math.max(a.max, v);
    });
  }
  return [...groups.values()].map((g) => ({
    key: g.key,
    values: o.measures.map((m, i) => {
      const a = g.acc[i]!;
      if (m.op === 'count') return a.count;
      if (!a.n) return null;
      return m.op === 'sum' ? a.sum : m.op === 'avg' ? a.sum / a.n : m.op === 'min' ? a.min : a.max;
    })
  }));
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** An instant from a column value: epoch milliseconds, or an ISO date or date-time. */
function instant(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const t = Date.parse(DAY.test(v) ? `${v}T00:00:00Z` : v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

const nextDay = (day: string) => isoDay(Date.parse(`${day}T00:00:00Z`) + 86_400_000);

export class AppCharts {
  private readonly cache = new Map<string, { at: number; data: ChartData }>();

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

  canEdit(p: Principal, app: AppRow, c: Pick<ChartRow, 'label' | 'owner_id' | 'shared'>): boolean {
    if (!clears(p.clearance, c.label)) return false;
    if (c.owner_id === p.userId) return true;
    return c.shared && this.designer(p) && clears(p.clearance, app.label);
  }

  private async open(c: ChartRow): Promise<{ name: string; definition: ChartDefinition | null }> {
    const d = json<{ name?: string; definition?: unknown }>(await this.s().keys.open(c.tenant_id, c.data, aad(c.id)), {});
    const parsed = chartDefinitionSchema.safeParse(d.definition ?? {});
    return { name: String(d.name ?? ''), definition: parsed.success ? parsed.data : null };
  }

  private seal(tenantId: string, a: string, name: string, definition: ChartDefinition): Promise<string> {
    return this.s().keys.seal(tenantId, JSON.stringify({ name, definition }), a);
  }

  async present(p: Principal, app: AppRow, c: ChartRow) {
    const { name, definition } = await this.open(c);
    return { id: c.id, app: app.name, appId: app.id, name, shared: c.shared, label: c.label, ownerId: c.owner_id, mine: c.owner_id === p.userId, canEdit: this.canEdit(p, app, c), rev: c.rev, sourceKind: c.source_kind, definition, updatedBy: c.updated_by, createdAt: c.created_at, updatedAt: c.updated_at };
  }

  /** The charts of an app a reader sees: their own and the shared ones, at labels their clearance clears. */
  private async visibleRows(p: Principal, app: AppRow): Promise<ChartRow[]> {
    const rows = ((await this.db('app_charts').where({ tenant_id: p.tenantId, app_id: app.id }).andWhere((q) => q.where({ owner_id: p.userId }).orWhere({ shared: true })).orderBy('created_at')) as Record<string, unknown>[]).map(rowFrom);
    return rows.filter((c) => clears(p.clearance, c.label));
  }

  /** One chart a reader sees, or null (someone else's private chart, or above their clearance, does not exist for them). */
  async visible(p: Principal, app: AppRow, id: string): Promise<ChartRow | null> {
    const r = (await this.db('app_charts').where({ tenant_id: p.tenantId, app_id: app.id, id }).first()) as Record<string, unknown> | undefined;
    if (!r) return null;
    const c = rowFrom(r);
    if (!clears(p.clearance, c.label) || (!c.shared && c.owner_id !== p.userId)) return null;
    return c;
  }

  private async mustSee(p: Principal, app: AppRow, id: string): Promise<ChartRow> {
    const c = await this.visible(p, app, id);
    if (!c) throw notFound('Chart');
    return c;
  }

  private assertShare(p: Principal, app: AppRow): void {
    if (!this.designer(p)) throw forbidden("Sharing a chart with the app's readers needs apps:design.", { step: 'role' });
    if (!clears(p.clearance, app.label)) throw forbidden(`The app holds records up to ${app.label}; your clearance is ${p.clearance}.`, { step: 'clearance' });
  }

  /**
   * Checks a definition against its source as its author (who must be able to read it) and returns the lowest label
   * the chart may carry: the entity's, the saved query's or the REST connection's.
   */
  private async checkSource(p: Principal, app: AppRow, d: ChartDefinition): Promise<{ floor: Label; entity: EntityRow | null }> {
    const src = d.source;
    if (src.kind === 'entity') {
      const { entity } = await this.apps.resolve(p, app.id, src.entity);
      const problems = this.definitionProblems(entity, d);
      if (problems.length) throw new HttpProblem(400, 'Invalid chart', problems[0]!, { extensions: { problems } });
      if (src.view) {
        const views = await this.apps.views.list(p, app.id, entity.id);
        if (!views.views.some((v) => v.id === src.view)) throw badRequest('The saved view is not one you can see on this entity.');
      }
      return { floor: entity.label, entity };
    }
    const d2 = authorize(p, 'connections:query', { tenantId: p.tenantId });
    if (!d2.allow) throw forbidden(`A chart over a ${src.kind === 'query' ? 'saved query' : 'REST endpoint'} needs connections:query: ${d2.reason}.`, { step: d2.step });
    const s = this.s();
    if (src.kind === 'query') {
      const q = await s.savedQueries.get(p.tenantId, src.query).catch(() => null);
      if (!q || !clears(p.clearance, q.label)) throw notFound('Saved query');
      return { floor: q.label, entity: null };
    }
    const c = await s.restConnections.get(p.tenantId, src.connection).catch(() => null);
    if (!c || !clears(p.clearance, c.label)) throw notFound('REST connection');
    await s.restConnections.endpoint(c, src.endpoint);
    return { floor: c.label, entity: null };
  }

  /** Every problem with a definition over an entity: fields that are not there, not indexed or of the wrong type. */
  definitionProblems(entity: EntityRow, d: ChartDefinition): string[] {
    const out: string[] = [];
    const byName = new Map(entity.definition.fields.map((f) => [f.name, f]));
    const groupable = (n: string, bucket: boolean, what: string) => {
      if (SYSTEM_DATES.has(n)) {
        if (!bucket) out.push(`${what}: ${n} groups by a date bucket (day, week, month, quarter or year).`);
        return;
      }
      if (n === 'state') {
        if (!entity.definition.states) out.push(`${what}: ${entity.name} has no state machine.`);
        if (bucket) out.push(`${what}: only a date groups by a bucket.`);
        return;
      }
      const f = byName.get(n);
      if (!f) return out.push(`${what}: ${n} is not a field of ${entity.name}.`);
      if (!(f.indexed || f.unique)) out.push(`${what}: ${n} is not indexed; mark it indexed to chart by it.`);
      if (bucket && f.type !== 'date') out.push(`${what}: only a date groups by a bucket; ${n} is ${f.type}.`);
      if (!bucket && f.type === 'json') out.push(`${what}: ${n} is JSON.`);
    };
    if (d.dimension) groupable(d.dimension.field, !!d.dimension.bucket, 'Dimension');
    if (d.split) {
      groupable(d.split.field, false, 'Split');
      if (byName.get(d.split.field)?.type === 'date') out.push('Split: a date does not split a chart; use it as the dimension.');
    }
    for (const m of d.measures) {
      if (m.op === 'count') continue;
      if (m.field.endsWith('.count')) continue;
      const f = byName.get(m.field);
      if (!f) out.push(`Measure: ${m.field} is not a field of ${entity.name}.`);
      else if (!['number', 'date', 'boolean', 'formula'].includes(f.type)) out.push(`Measure: ${m.op} works on number, date and boolean fields; ${m.field} is ${f.type}.`);
      else if (!(f.indexed || f.unique)) out.push(`Measure: ${m.field} is not indexed.`);
    }
    if (d.compare?.kind === 'previous') {
      const n = d.compare.field;
      if (!SYSTEM_DATES.has(n) && byName.get(n)?.type !== 'date') out.push(`Comparison: ${n} is not a date of ${entity.name}.`);
      else if (!SYSTEM_DATES.has(n) && !(byName.get(n)?.indexed || byName.get(n)?.unique)) out.push(`Comparison: ${n} is not indexed.`);
    }
    if (d.type === 'scatter' && d.measures.length === 1 && d.dimension) {
      const f = byName.get(d.dimension.field);
      if (d.dimension.bucket || !f || !['number', 'date', 'formula'].includes(f.type)) out.push('Scatter: with one measure the dimension is a number or a date (without a bucket).');
    }
    return out;
  }

  private label(p: Principal, app: AppRow, floor: Label, wanted: Label | undefined): Label {
    const l = wanted ?? floor;
    if (labelRank(l) < labelRank(floor)) throw badRequest(`The chart's source is labelled ${floor}; the chart is ${floor} at least.`);
    if (labelRank(l) > labelRank(app.label)) throw badRequest(`The app's label is ${app.label}; a chart cannot be above it.`);
    if (!clears(p.clearance, l)) throw forbidden(`Your clearance is ${p.clearance}; a ${l} chart is above it.`, { step: 'clearance' });
    return l;
  }

  // ---------- CRUD ----------

  async list(p: Principal, appRef: string) {
    const app = await this.apps.app(p, appRef);
    const rows = await this.visibleRows(p, app);
    const charts = await Promise.all(rows.map((c) => this.present(p, app, c)));
    charts.sort((a, b) => Number(b.mine) - Number(a.mine) || a.name.localeCompare(b.name));
    return { charts, canShare: this.designer(p) && clears(p.clearance, app.label) };
  }

  async get(p: Principal, appRef: string, id: string) {
    const app = await this.apps.app(p, appRef);
    return this.present(p, app, await this.mustSee(p, app, id));
  }

  async versions(p: Principal, appRef: string, id: string) {
    const app = await this.apps.app(p, appRef);
    const c = await this.mustSee(p, app, id);
    const rows = (await this.db('app_chart_versions').where({ chart_id: c.id }).orderBy('rev', 'desc').limit(50)) as { rev: number; data: string; created_by: string; created_at: number }[];
    const versions = await Promise.all(
      rows.map(async (v) => {
        const d = json<{ name?: string; definition?: unknown }>(await this.s().keys.open(c.tenant_id, v.data, aadVersion(c.id, Number(v.rev))), {});
        return { rev: Number(v.rev), name: String(d.name ?? ''), definition: d.definition ?? null, by: v.created_by, at: Number(v.created_at) };
      })
    );
    return { versions };
  }

  async create(actor: Actor & { principal: Principal }, appRef: string, input: z.infer<typeof chartInputSchema>) {
    const p = actor.principal;
    const app = await this.apps.app(p, appRef);
    if (input.shared) this.assertShare(p, app);
    const { floor, entity } = await this.checkSource(p, app, input.definition);
    const lab = this.label(p, app, floor, input.label);
    const counted = await this.db('app_charts').where({ tenant_id: p.tenantId, app_id: app.id }).andWhere(input.shared ? { shared: true } : { owner_id: p.userId, shared: false }).count({ n: '*' });
    if (Number((counted as Record<string, unknown>[])[0]?.n ?? 0) >= (input.shared ? MAX_SHARED : MAX_OWN)) throw conflict(`At most ${input.shared ? `${MAX_SHARED} shared charts` : `${MAX_OWN} charts of yours`} in one app.`);
    const id = ulid();
    const now = Date.now();
    const row = { id, tenant_id: p.tenantId, app_id: app.id, owner_id: p.userId, shared: input.shared, label: lab, source_kind: input.definition.source.kind, entity_id: entity?.id ?? null, rev: 1, data: await this.seal(p.tenantId, aad(id), input.name, input.definition), updated_by: p.userId, created_at: now, updated_at: now };
    await this.db.transaction(async (trx) => {
      await trx('app_charts').insert(row);
      await trx('app_chart_versions').insert({ chart_id: id, rev: 1, tenant_id: p.tenantId, app_id: app.id, data: await this.seal(p.tenantId, aadVersion(id, 1), input.name, input.definition), created_by: p.userId, created_at: now });
    });
    await this.audit(actor, 'app.chart.created', { app: app.id, chart: id }, lab, { shared: input.shared, type: input.definition.type, source: input.definition.source.kind });
    return this.present(p, app, rowFrom(row));
  }

  async update(actor: Actor & { principal: Principal }, appRef: string, id: string, patch: z.infer<typeof chartPatchSchema>) {
    const p = actor.principal;
    const app = await this.apps.app(p, appRef);
    const c = await this.mustSee(p, app, id);
    if (!this.canEdit(p, app, c)) throw forbidden(c.shared ? 'Only its owner or a designer of the app changes a shared chart.' : 'Only its owner changes a chart.', { step: 'owner' });
    if (patch.rev !== undefined && patch.rev !== c.rev) throw new HttpProblem(409, 'Conflict', `The chart changed since version ${patch.rev}; it is at version ${c.rev}. Reload it and try again.`, { extensions: { rev: c.rev } });
    if (patch.shared !== undefined && patch.shared !== c.shared) this.assertShare(p, app);
    const cur = await this.open(c);
    const definition = patch.definition ?? cur.definition;
    if (!definition) throw badRequest('The stored definition is no longer valid; send a new one.');
    const name = patch.name ?? cur.name;
    const shared = patch.shared ?? c.shared;
    const { floor, entity } = patch.definition || patch.label ? await this.checkSource(p, app, definition) : { floor: c.label, entity: null };
    const lab = patch.label || patch.definition ? this.label(p, app, floor, patch.label ?? (labelRank(c.label) >= labelRank(floor) ? c.label : floor)) : c.label;
    const now = Date.now();
    const rev = c.rev + 1;
    const data = await this.seal(c.tenant_id, aad(c.id), name, definition);
    const upd = { shared, label: lab, rev, data, updated_by: p.userId, updated_at: now, ...(patch.definition ? { source_kind: definition.source.kind, entity_id: entity?.id ?? null } : {}) };
    await this.db.transaction(async (trx) => {
      const n = await trx('app_charts').where({ id: c.id, rev: c.rev }).update(upd);
      if (!n) throw conflict('The chart changed meanwhile; reload it and try again.');
      await trx('app_chart_versions').insert({ chart_id: c.id, rev, tenant_id: c.tenant_id, app_id: c.app_id, data: await this.seal(c.tenant_id, aadVersion(c.id, rev), name, definition), created_by: p.userId, created_at: now });
    });
    this.forget(c.id);
    const changed = [...(patch.name !== undefined ? ['name'] : []), ...(patch.definition ? ['definition'] : []), ...(patch.shared !== undefined ? ['shared'] : []), ...(patch.label ? ['label'] : [])];
    await this.audit(actor, 'app.chart.updated', { app: app.id, chart: c.id }, lab, { changed, rev, shared, ...(c.owner_id !== p.userId ? { owner: c.owner_id } : {}) });
    return this.present(p, app, { ...c, ...upd } as ChartRow);
  }

  async remove(actor: Actor & { principal: Principal }, appRef: string, id: string): Promise<void> {
    const p = actor.principal;
    const app = await this.apps.app(p, appRef);
    const c = await this.mustSee(p, app, id);
    if (!this.canEdit(p, app, c)) throw forbidden(c.shared ? 'Only its owner or a designer of the app deletes a shared chart.' : 'Only its owner deletes a chart.', { step: 'owner' });
    await this.db.transaction(async (trx) => {
      await trx('app_chart_versions').where({ chart_id: c.id }).delete();
      await trx('app_charts').where({ id: c.id }).delete();
    });
    this.forget(c.id);
    await this.audit(actor, 'app.chart.deleted', { app: app.id, chart: c.id }, c.label, { shared: c.shared, ...(c.owner_id !== p.userId ? { owner: c.owner_id } : {}) });
  }

  // ---------- computing ----------

  private forget(chartId: string): void {
    for (const k of this.cache.keys()) if (k.includes(`|${chartId}:`)) this.cache.delete(k);
  }

  /** A saved chart's series as `p` may see them (cached briefly per reader, grant, version and filters). */
  async data(p: Principal, appRef: string, id: string, o: { filters?: AppliedFilter[]; fresh?: boolean } = {}): Promise<ChartResult> {
    const app = await this.apps.app(p, appRef);
    return this.dataFor(p, app, id, o);
  }

  async dataFor(p: Principal, app: AppRow, id: string, o: { filters?: AppliedFilter[]; fresh?: boolean } = {}): Promise<ChartResult> {
    const c = await this.visible(p, app, id);
    if (!c) return { state: 'unavailable', reason: 'The chart is not shared with you.' };
    const { name, definition } = await this.open(c);
    if (!definition) return { state: 'error', title: 'Invalid chart', detail: 'The stored definition is no longer valid; its owner saves it again.' };
    return this.compute(p, app, { id: c.id, rev: c.rev, name, label: c.label, definition }, o);
  }

  /** An unsaved definition, for the builder's live preview (never cached; problems are thrown, not returned). */
  async preview(p: Principal, appRef: string, name: string, definition: ChartDefinition): Promise<ChartData> {
    const app = await this.apps.app(p, appRef);
    const { floor } = await this.checkSource(p, app, definition);
    const r = await this.compute(p, app, { id: null, rev: 0, name, label: floor, definition }, { fresh: true, raise: true });
    if (r.state !== 'ok') throw r.state === 'unavailable' ? forbidden(r.reason) : badRequest(r.detail);
    return r.data;
  }

  private async cacheKey(p: Principal, app: AppRow, chart: { id: string | null; rev: number }, d: ChartDefinition, filters: AppliedFilter[] | undefined): Promise<string | null> {
    if (!chart.id) return null;
    let grant = '';
    if (d.source.kind === 'entity') {
      const entity = await this.apps.entityOf(app, d.source.entity).catch(() => null);
      if (entity) {
        const g = await this.apps.grantFor(p, entity);
        grant = g.policed ? hash({ rows: g.rows, matched: g.matched.map((m) => m.id), none: g.none, fields: [...this.namedFields(d)].map((n) => g.field(n)) }) : 'open';
      }
    }
    const perms = hash([...effectivePermissions(p)].sort());
    return `${p.tenantId}|${p.userId}|${p.clearance}|${perms}|${grant}|${chart.id}:${chart.rev}|${hash(filters ?? [])}`;
  }

  private namedFields(d: ChartDefinition): Set<string> {
    const out = new Set<string>();
    if (d.dimension) out.add(d.dimension.field);
    if (d.split) out.add(d.split.field);
    for (const m of d.measures) if (m.op !== 'count') out.add(m.field.endsWith('.count') ? m.field.slice(0, -'.count'.length) : m.field);
    if (d.compare?.kind === 'previous') out.add(d.compare.field);
    return out;
  }

  async compute(p: Principal, app: AppRow, chart: { id: string | null; rev: number; name: string; label: Label; definition: ChartDefinition }, o: { filters?: AppliedFilter[]; fresh?: boolean; raise?: boolean } = {}): Promise<ChartResult> {
    const d = chart.definition;
    const key = await this.cacheKey(p, app, chart, d, o.filters).catch(() => null);
    if (key && !o.fresh) {
      const hit = this.cache.get(key);
      if (hit && Date.now() - hit.at < TTL_MS) return { state: 'ok', data: { ...hit.data, cached: true } };
    }
    try {
      const data = d.source.kind === 'entity' ? await this.fromEntity(p, app, chart, o.filters ?? []) : await this.fromRows(p, app, chart, o.filters ?? []);
      if (key) {
        if (this.cache.size >= CACHE_MAX) {
          const now = Date.now();
          for (const [k, v] of this.cache) if (now - v.at >= TTL_MS) this.cache.delete(k);
          while (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
        }
        this.cache.set(key, { at: Date.now(), data });
      }
      return { state: 'ok', data };
    } catch (err) {
      if (err instanceof Unavailable) return { state: 'unavailable', reason: err.message };
      if (err instanceof HttpProblem) {
        if (err.status === 401 || err.status === 403 || err.status === 404) return { state: 'unavailable', reason: err.status === 404 ? 'Its source is not available to you.' : (err.detail ?? err.title) };
        if (o.raise) throw err;
        return { state: 'error', title: err.title, detail: err.detail ?? err.title };
      }
      throw err;
    }
  }

  private async fromEntity(p: Principal, app: AppRow, chart: { name: string; label: Label; definition: ChartDefinition }, applied: AppliedFilter[]): Promise<ChartData> {
    const d = chart.definition;
    const src = d.source as Extract<ChartSource, { kind: 'entity' }>;
    const { entity } = await this.apps.resolve(p, app.id, src.entity);
    const problems = this.definitionProblems(entity, d);
    if (problems.length) throw badRequest(problems[0]!);
    // A field a policy hides or masks from the reader is not grouped, summed or compared for them.
    const grant = await this.apps.grantFor(p, entity);
    if (grant.none) throw new Unavailable('No policy of this app lets you read these records.');
    if (grant.policed)
      for (const n of this.namedFields(d)) {
        if (SYSTEM.has(n)) continue;
        const g = grant.field(n);
        if (!g.read || !g.unmasked) throw new Unavailable(`A policy ${g.read ? 'masks' : 'hides'} ${n} from you.`);
      }
    const conds: Filter[] = [];
    let q = src.q;
    if (src.filter) conds.push(src.filter);
    if (src.view) {
      const views = await this.apps.views.list(p, app.id, entity.id);
      const v = views.views.find((x) => x.id === src.view);
      if (!v) throw new Unavailable('The saved view it reads is not shared with you.');
      const vf = viewFilter(v.settings);
      if (vf) conds.push(vf);
      if (!q && v.settings.q) q = v.settings.q;
    }
    const used: string[] = [];
    for (const f of applied) {
      const c = entityFilter(entity, f);
      if (c) {
        conds.push(c);
        used.push(f.id);
      }
    }
    const filter: Filter | undefined = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : { and: conds };
    const agg = (input: Omit<AggregateInput, 'filter' | 'q'>, extra?: Filter) => {
      const f = extra ? (filter ? { and: [filter, extra] } : extra) : filter;
      return this.apps.aggregate(p, app.id, entity.id, { ...input, ...(f ? { filter: f } : {}), ...(q ? { q } : {}) });
    };
    const metrics = d.measures.map((m) => (m.op === 'count' ? { op: 'count' as const } : { op: m.op, field: m.field }));
    const byName = new Map(entity.definition.fields.map((f) => [f.name, f]));
    const dimField = d.dimension ? (byName.get(d.dimension.field) ?? null) : null;
    const keyLabel = (k: string | number | null) => keyText(k, d.dimension, dimField);
    const base = this.shell(chart, d, used, d.dimension ? { field: d.dimension.field, bucket: d.dimension.bucket ?? null, label: d.labels.x ?? dimField?.title ?? d.dimension.field } : null);

    if (d.type === 'number') {
      const value = (await agg({ metrics })).groups[0]?.values[0] ?? null;
      let compare: ChartData['compare'];
      if (d.compare?.kind === 'target') compare = { kind: 'target', label: 'target', value: d.compare.value, delta: value == null ? null : value - d.compare.value, pct: value == null || !d.compare.value ? null : ((value - d.compare.value) / Math.abs(d.compare.value)) * 100 };
      let shown = value;
      if (d.compare?.kind === 'previous') {
        const { current, previous } = periodStarts(Date.now(), d.compare.period);
        const field = d.compare.field;
        const f = byName.get(field);
        const at = (ms: number) => (SYSTEM_DATES.has(field) ? ms : f && 'withTime' in f && f.withTime ? new Date(ms).toISOString() : isoDay(ms));
        shown = (await agg({ metrics }, { field, op: 'gte', value: at(current) })).groups[0]?.values[0] ?? null;
        const prev = (await agg({ metrics }, { and: [{ field, op: 'gte', value: at(previous) }, { field, op: 'lt', value: at(current) }] })).groups[0]?.values[0] ?? null;
        compare = { kind: 'previous', label: `previous ${d.compare.period}`, value: prev, delta: shown == null || prev == null ? null : shown - prev, pct: shown == null || prev == null || !prev ? null : ((shown - prev) / Math.abs(prev)) * 100 };
      }
      return this.finish({ ...base, value: shown, ...(compare ? { compare } : {}), series: [{ name: measureName(d.measures[0]!, byName), values: [shown] }] });
    }

    let groups: Group[];
    let seriesNames: string[];
    let seriesTruncated = false;
    if (d.split) {
      const split = d.split;
      const splitField = byName.get(split.field) ?? null;
      const top = (await agg({ groupBy: split.field, metrics: [{ op: 'count' }] })).groups.sort((a, b) => (b.values[0] ?? 0) - (a.values[0] ?? 0));
      seriesTruncated = top.length > MAX_SERIES;
      const keys = top.slice(0, MAX_SERIES).map((g) => g.key);
      const perSeries = await Promise.all(keys.map((k) => agg({ ...(d.dimension ? { groupBy: d.dimension.field, ...(d.dimension.bucket ? { bucket: d.dimension.bucket } : {}) } : {}), metrics }, k == null ? { field: split.field, op: 'exists', value: false } : { field: split.field, op: 'eq', value: k })));
      seriesNames = keys.map((k) => keyText(k, { field: split.field }, splitField));
      groups = mergeSeries(perSeries.map((r) => r.groups));
    } else {
      const r = await agg({ ...(d.dimension ? { groupBy: d.dimension.field, ...(d.dimension.bucket ? { bucket: d.dimension.bucket } : {}) } : {}), metrics });
      groups = r.groups;
      seriesNames = d.measures.map((m) => measureName(m, byName));
    }
    return this.finish(this.arrange(base, d, groups, seriesNames, keyLabel, seriesTruncated));
  }

  private async fromRows(p: Principal, app: AppRow, chart: { name: string; label: Label; definition: ChartDefinition }, applied: AppliedFilter[]): Promise<ChartData> {
    const d = chart.definition;
    const src = d.source as Exclude<ChartSource, { kind: 'entity' }>;
    const s = this.s();
    const opts = { limit: ROW_CAP, ceiling: app.label, via: 'app-chart' };
    const res = src.kind === 'query' ? await s.savedQueries.run(p, src.query, src.params, opts) : await s.restConnections.read(p, src.connection, src.endpoint, src.params, opts);
    const cols = new Set(res.columns.map((c) => c.name));
    for (const n of this.namedFields(d)) if (!cols.has(n)) throw badRequest(`${n} is not a column of the ${src.kind === 'query' ? 'saved query' : 'REST endpoint'}'s result (${[...cols].slice(0, 20).join(', ')}).`);
    const used: string[] = [];
    const tests: ((r: Record<string, unknown>) => boolean)[] = [];
    for (const f of applied) {
      if (!cols.has(f.field)) continue;
      used.push(f.id);
      if (f.kind === 'date') {
        const from = f.from ? Date.parse(`${f.from}T00:00:00Z`) : null;
        const to = f.to ? Date.parse(`${nextDay(f.to)}T00:00:00Z`) : null;
        tests.push((r) => {
          const t = instant(r[f.field]);
          return t != null && (from == null || t >= from) && (to == null || t < to);
        });
      } else tests.push((r) => (f.value == null ? r[f.field] == null || r[f.field] === '' : String(r[f.field]) === String(f.value)));
    }
    const filter = tests.length ? (r: Record<string, unknown>) => tests.every((t) => t(r)) : undefined;
    const base = { ...this.shell({ ...chart, label: highest(chart.label, res.label) }, d, used, d.dimension ? { field: d.dimension.field, bucket: d.dimension.bucket ?? null, label: d.labels.x ?? d.dimension.field } : null), rowsRead: res.rows.length, truncated: res.truncated };
    const keyLabel = (k: string | number | null) => keyText(k, d.dimension, null);

    if (d.type === 'number') {
      let value = groupRows(res.rows, { dimension: null, measures: d.measures, ...(filter ? { filter } : {}) })[0]?.values[0] ?? null;
      if (!res.rows.length && d.measures[0]!.op === 'count') value = 0;
      let compare: ChartData['compare'];
      if (d.compare?.kind === 'target') compare = { kind: 'target', label: 'target', value: d.compare.value, delta: value == null ? null : value - d.compare.value, pct: value == null || !d.compare.value ? null : ((value - d.compare.value) / Math.abs(d.compare.value)) * 100 };
      if (d.compare?.kind === 'previous') {
        const { current, previous } = periodStarts(Date.now(), d.compare.period);
        const field = d.compare.field;
        const within = (a: number, b: number) => (r: Record<string, unknown>) => {
          const t = instant(r[field]);
          return t != null && t >= a && t < b && (!filter || filter(r));
        };
        const cur = groupRows(res.rows, { dimension: null, measures: d.measures, filter: within(current, Number.MAX_SAFE_INTEGER) })[0]?.values[0] ?? (d.measures[0]!.op === 'count' ? 0 : null);
        const prev = groupRows(res.rows, { dimension: null, measures: d.measures, filter: within(previous, current) })[0]?.values[0] ?? (d.measures[0]!.op === 'count' ? 0 : null);
        value = cur;
        compare = { kind: 'previous', label: `previous ${d.compare.period}`, value: prev, delta: cur == null || prev == null ? null : cur - prev, pct: cur == null || prev == null || !prev ? null : ((cur - prev) / Math.abs(prev)) * 100 };
      }
      return this.finish({ ...base, value, ...(compare ? { compare } : {}), series: [{ name: measureName(d.measures[0]!, new Map()), values: [value] }] });
    }

    let groups: Group[];
    let names: string[];
    let seriesTruncated = false;
    if (d.split) {
      const split = d.split;
      const counts = groupRows(res.rows, { dimension: { field: split.field }, measures: [{ op: 'count', label: null }], ...(filter ? { filter } : {}) }).sort((a, b) => (b.values[0] ?? 0) - (a.values[0] ?? 0));
      seriesTruncated = counts.length > MAX_SERIES;
      const keys = counts.slice(0, MAX_SERIES).map((g) => g.key);
      const same = (r: Record<string, unknown>, k: string | number | null) => {
        const v = r[split.field];
        return k == null ? v == null || v === '' : typeof k === 'number' ? v === k : String(v) === k;
      };
      groups = mergeSeries(keys.map((k) => groupRows(res.rows, { dimension: d.dimension, measures: d.measures, filter: (r) => same(r, k) && (!filter || filter(r)) })));
      names = keys.map((k) => keyText(k, { field: split.field }, null));
    } else {
      groups = groupRows(res.rows, { dimension: d.dimension, measures: d.measures, ...(filter ? { filter } : {}) });
      names = d.measures.map((m) => measureName(m, new Map()));
    }
    return this.finish(this.arrange(base, d, groups, names, keyLabel, seriesTruncated));
  }

  private shell(chart: { name: string; label: Label }, d: ChartDefinition, used: string[], dimension: ChartData['dimension']): Omit<ChartData, 'summary' | 'computedAt' | 'cached'> {
    return {
      type: d.type,
      title: d.labels.title || chart.name,
      orientation: d.orientation,
      stacking: d.stacking,
      dimension,
      categories: [],
      series: [],
      axes: { x: d.labels.x ?? dimension?.label ?? '', y: d.labels.y ?? '' },
      colors: d.colors.length ? d.colors : [...CHART_COLORS],
      showValues: d.labels.values,
      legend: d.labels.legend,
      truncated: false,
      groups: 0,
      filtersApplied: used,
      label: chart.label
    };
  }

  /** Sorts and limits the groups into categories and series; a scatter becomes points. */
  private arrange(base: Omit<ChartData, 'summary' | 'computedAt' | 'cached'>, d: ChartDefinition, groups: Group[], names: string[], keyLabel: (k: string | number | null) => string, seriesTruncated: boolean): Omit<ChartData, 'summary' | 'computedAt' | 'cached'> {
    const total = (g: Group) => g.values.reduce<number>((a, v) => a + (v ?? 0), 0);
    const cmpKey = (a: Group, b: Group) => (a.key === b.key ? 0 : a.key == null ? 1 : b.key == null ? -1 : typeof a.key === 'number' && typeof b.key === 'number' ? a.key - b.key : String(a.key).localeCompare(String(b.key), 'en', { numeric: true }));
    const sorted = [...groups].sort((a, b) => {
      const c = d.sort.by === 'value' ? total(a) - total(b) || cmpKey(a, b) : cmpKey(a, b);
      return d.sort.dir === 'desc' ? -c : c;
    });
    if (d.sort.by === 'key') {
      // Empty keys stay last in both directions.
      const empty = sorted.filter((g) => g.key == null);
      sorted.splice(0, sorted.length, ...sorted.filter((g) => g.key != null), ...empty);
    }
    const shown = sorted.slice(0, d.limit);
    const out = { ...base, groups: groups.length, truncated: base.truncated || groups.length > shown.length || seriesTruncated, categories: shown.map((g) => ({ key: g.key, label: keyLabel(g.key) })), series: names.map((name, i) => ({ name, values: shown.map((g) => g.values[i] ?? null) })) };
    if (d.type === 'scatter') {
      const pts = shown.flatMap((g) => {
        const x = d.measures.length === 2 ? g.values[0] : typeof g.key === 'number' ? g.key : null;
        const y = d.measures.length === 2 ? g.values[1] : g.values[0];
        return x == null || y == null ? [] : [{ x, y, label: keyLabel(g.key) }];
      });
      out.points = pts;
      out.axes = { x: d.labels.x ?? (d.measures.length === 2 ? names[0]! : base.dimension?.label ?? 'x'), y: d.labels.y ?? names[d.measures.length === 2 ? 1 : 0]! };
    } else if (!out.axes.y) out.axes = { ...out.axes, y: names.length === 1 ? names[0]! : '' };
    return out;
  }

  private finish(d: Omit<ChartData, 'summary' | 'computedAt' | 'cached'>): ChartData {
    return { ...d, summary: chartSummary(d), computedAt: Date.now(), cached: false };
  }

  private audit(actor: Actor & { principal: Principal }, action: string, target: Record<string, unknown>, lab: Label, detail?: Record<string, unknown>) {
    return this.s().audit.append({ tenantId: actor.principal.tenantId, action, kind: 'admin', actor: actorFrom(actor.principal, actor.ip ?? null), target, label: lab, ...(detail ? { detail } : {}), traceId: actor.traceId ?? null });
  }
}

/** Thrown inside a computation when the reader may not see the chart (shown as "Not available to you"). */
export class Unavailable extends Error {}

/** A saved view's settings as one record filter: its conditions (and or or), and its state. */
export function viewFilter(s: ViewSettings): Filter | null {
  const leaves = s.filters as Filter[];
  const parts: Filter[] = [];
  if (leaves.length === 1) parts.push(leaves[0]!);
  else if (leaves.length > 1) parts.push(s.filterMode === 'or' ? { or: leaves } : { and: leaves });
  if (s.state != null) parts.push({ field: 'state', op: 'eq', value: s.state });
  return parts.length === 0 ? null : parts.length === 1 ? parts[0]! : { and: parts };
}

/** A dashboard filter as a record filter on an entity, or null when the entity has no such (queryable) field. */
export function entityFilter(entity: EntityRow, f: AppliedFilter): Filter | null {
  const def = entity.definition;
  const field = def.fields.find((x) => x.name === f.field);
  if (f.kind === 'date') {
    if (!f.from && !f.to) return null;
    const sys = SYSTEM_DATES.has(f.field);
    if (!sys && (!field || field.type !== 'date' || !(field.indexed || field.unique))) return null;
    const at = (day: string) => (sys ? Date.parse(`${day}T00:00:00Z`) : field && 'withTime' in field && field.withTime ? `${day}T00:00:00Z` : day);
    const parts: Filter[] = [];
    if (f.from) parts.push({ field: f.field, op: 'gte', value: at(f.from) });
    if (f.to) parts.push({ field: f.field, op: 'lt', value: at(nextDay(f.to)) });
    return parts.length === 1 ? parts[0]! : { and: parts };
  }
  if (f.field === 'state') return def.states ? (f.value == null ? { field: 'state', op: 'exists', value: false } : { field: 'state', op: 'eq', value: String(f.value) }) : null;
  if (!field || !(field.indexed || field.unique) || field.type === 'json' || field.type === 'relation') return null;
  if (f.value == null || f.value === '') return { field: f.field, op: 'exists', value: false };
  const v = field.type === 'number' && typeof f.value === 'string' ? Number(f.value) : f.value;
  return { field: f.field, op: 'eq', value: v };
}

/** Merges per-series groups (one list per series, one value each) into groups with a value per series. */
function mergeSeries(perSeries: Group[][]): Group[] {
  const keys = new Map<string, { key: string | number | null; values: (number | null)[] }>();
  perSeries.forEach((gs, si) => {
    for (const g of gs) {
      const k = `${typeof g.key}:${String(g.key)}`;
      let e = keys.get(k);
      if (!e) {
        e = { key: g.key, values: perSeries.map(() => null) };
        keys.set(k, e);
      }
      e.values[si] = g.values[0] ?? null;
    }
  });
  return [...keys.values()];
}

function measureName(m: Measure, byName: Map<string, Field>): string {
  if (m.label) return m.label;
  if (m.op === 'count') return 'Count';
  const t = byName.get(m.field)?.title ?? m.field;
  return `${{ sum: 'Sum', avg: 'Average', min: 'Minimum', max: 'Maximum' }[m.op]} of ${t}`;
}

/** A category's label: a bucket, a date, yes or no, an enum option's label, or the value. */
function keyText(k: string | number | null, dim: { field: string; bucket?: DateBucket | undefined } | null, f: Field | null): string {
  if (k == null) return 'No value';
  if (dim?.bucket) return bucketLabel(String(k), dim.bucket);
  if (f?.type === 'date' && typeof k === 'number') return f.withTime ? new Date(k).toISOString().slice(0, 16).replace('T', ' ') : isoDay(k);
  if (f?.type === 'boolean') return k === 1 || k === 'true' ? 'Yes' : 'No';
  if (f && (f.type === 'enum' || (f.type === 'lookup' && f.source === 'static'))) {
    const o = (f.options ?? []).find((x) => x.value === k);
    if (o) return o.label ?? o.value;
  }
  return typeof k === 'number' ? fmt(k) : k;
}
