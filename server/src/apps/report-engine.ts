import { z } from 'zod';
import { badRequest } from '../http/problem.js';
import { compileFormula, FormulaError, MAX_FORMULA_LENGTH, type Formula } from './formula.js';
import { OPS } from './query.js';

/*
 * 1.8.0 (B-122): reports, computed. A report is a definition (never SQL): a source (an entity with an optional saved
 * view and filters, a saved connection query, or a REST endpoint), typed parameters bound into the source's filters or
 * parameters, computed columns in the safe formula language (`formula.ts`), sorting, a layout (a table; a grouped
 * table with group headers, subtotals and a grand total; or a cross-tab with row fields, one column field, values and
 * totals, its distinct columns capped), conditional formatting from a small vocabulary, a title, notes and a page
 * setup.
 *
 * This module is pure: `computeReport` takes the rows the source gave the viewer (`apps/reports.ts` reads them as the
 * viewer, through the record grant, the saved query's or the endpoint's own rights) and lays them out. Every cell is
 * computed from those rows only. A column the viewer sees masked (or may not read) stays masked through everything
 * built on it: an aggregate over it, a computed column reading it and a formatting rule testing it give a masked cell,
 * never a value, a colour or an icon that would tell something about the hidden value.
 */

export const PARAM_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const COLUMN_KEY = /^[A-Za-z_][A-Za-z0-9_.]{0,69}$/;
const key = z.string().regex(COLUMN_KEY, 'a column name');
const scalar = z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]);
const paramRef = z.object({ param: z.string().regex(PARAM_NAME) }).strict();

export const PARAM_TYPES = ['text', 'number', 'date', 'boolean', 'choice'] as const;
export const AGG_OPS = ['count', 'sum', 'avg', 'min', 'max'] as const;
export type AggOp = (typeof AGG_OPS)[number];
export const RULE_OPS = ['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'between', 'contains', 'empty', 'notEmpty'] as const;
export const RULE_STYLES = ['good', 'warn', 'bad', 'info', 'muted', 'strong'] as const;
export const RULE_ICONS = ['none', 'up', 'down', 'warn', 'check', 'flag', 'dot'] as const;

/** A filter condition of an entity source; its value may name a parameter (`{"param": "region"}`). */
const reportLeaf = z
  .object({
    field: z.string().min(1).max(70),
    op: z.enum(OPS).refine((o) => o !== 'matches', 'matches is not offered in reports'),
    value: z.union([scalar, z.array(scalar).max(100), paramRef]).optional()
  })
  .strict();
export type ReportLeaf = z.infer<typeof reportLeaf>;

const sourceParams = z.record(z.string().max(63), z.union([scalar, paramRef])).refine((o) => Object.keys(o).length <= 30, 'at most 30 parameters');

export const reportSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('entity'),
      entity: z.string().min(1).max(63),
      /** A saved view of the entity: its filters, search, state filter and columns come first. */
      view: z.string().length(26).nullable().default(null),
      filters: z.array(reportLeaf).max(30).default([]),
      filterMode: z.enum(['and', 'or']).default('and'),
      q: z.string().trim().max(200).default(''),
      state: z.string().min(1).max(60).nullable().default(null)
    })
    .strict(),
  z.object({ kind: z.literal('query'), query: z.string().min(1).max(63), params: sourceParams.default({}) }).strict(),
  z.object({ kind: z.literal('rest'), connection: z.string().min(1).max(63), endpoint: z.string().min(1).max(63), params: sourceParams.default({}) }).strict()
]);
export type ReportSource = z.infer<typeof reportSourceSchema>;

export const reportParamSchema = z
  .object({
    name: z.string().regex(PARAM_NAME, 'lower-case letters, digits and _, starting with a letter'),
    title: z.string().trim().max(100).optional(),
    type: z.enum(PARAM_TYPES).default('text'),
    required: z.boolean().default(false),
    default: scalar.optional(),
    options: z.array(z.string().trim().min(1).max(100)).max(50).optional()
  })
  .strict();
export type ReportParam = z.infer<typeof reportParamSchema>;

const aggSchema = z.object({ op: z.enum(AGG_OPS), column: key.optional() }).strict();
export type Agg = z.infer<typeof aggSchema>;

export const reportLayoutSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('table') }).strict(),
  z
    .object({
      kind: z.literal('grouped'),
      groupBy: z.array(key).min(1).max(3),
      aggregates: z.array(aggSchema).max(10).default([{ op: 'count' }]),
      subtotals: z.boolean().default(true),
      grandTotal: z.boolean().default(true)
    })
    .strict(),
  z
    .object({
      kind: z.literal('crosstab'),
      rows: z.array(key).min(1).max(3),
      column: key,
      values: z.array(aggSchema).min(1).max(4),
      rowTotals: z.boolean().default(true),
      columnTotals: z.boolean().default(true),
      /** Distinct values of the column field shown as columns; the rest are added up in one "Other" column. */
      maxColumns: z.number().int().min(1).max(50).default(20)
    })
    .strict()
]);
export type ReportLayout = z.infer<typeof reportLayoutSchema>;

export const formatRuleSchema = z
  .object({
    column: key,
    when: z.enum(RULE_OPS),
    value: scalar.optional(),
    value2: z.number().optional(),
    style: z.enum(RULE_STYLES),
    icon: z.enum(RULE_ICONS).default('none'),
    /** Words shown with the value, so the meaning never rests on colour alone. */
    text: z.string().trim().min(1).max(40).optional()
  })
  .strict();
export type FormatRule = z.infer<typeof formatRuleSchema>;

export const pageSetupSchema = z
  .object({
    size: z.enum(['a4', 'letter']).default('a4'),
    orientation: z.enum(['portrait', 'landscape']).default('portrait'),
    /** PDF: each top-level group of a grouped report starts a new page. */
    breakGroups: z.boolean().default(false)
  })
  .strict();
export type PageSetup = z.infer<typeof pageSetupSchema>;

export const REPORT_ROW_CAP_MAX = 50_000;

export const reportDefinitionSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    notes: z.string().max(4000).default(''),
    source: reportSourceSchema,
    parameters: z.array(reportParamSchema).max(10).default([]),
    /** The columns shown, in order; none: every column the source gives. */
    columns: z.array(z.object({ key, title: z.string().trim().max(100).optional(), decimals: z.number().int().min(0).max(6).optional() }).strict()).max(60).default([]),
    computed: z.array(z.object({ name: z.string().regex(PARAM_NAME), title: z.string().trim().max(100).optional(), formula: z.string().min(1).max(MAX_FORMULA_LENGTH) }).strict()).max(20).default([]),
    layout: reportLayoutSchema.default({ kind: 'table' }),
    sort: z.array(z.object({ column: key, dir: z.enum(['asc', 'desc']).default('asc') }).strict()).max(5).default([]),
    formatting: z.array(formatRuleSchema).max(20).default([]),
    page: pageSetupSchema.default({ size: 'a4', orientation: 'portrait', breakGroups: false }),
    /** Source rows read at most; more makes the result `truncated`. */
    rowCap: z.number().int().min(1).max(REPORT_ROW_CAP_MAX).default(10_000),
    /** How long a run's result stays cached (sealed); 0 keeps none. */
    cacheMinutes: z.number().int().min(0).max(1440).default(15)
  })
  .strict()
  .superRefine((d, ctx) => {
    const names = new Set<string>();
    for (const p of d.parameters) {
      if (names.has(p.name)) ctx.addIssue({ code: 'custom', message: `Parameter ${p.name} is defined twice.` });
      names.add(p.name);
      if (p.type === 'choice' && !p.options?.length) ctx.addIssue({ code: 'custom', message: `Parameter ${p.name} is a choice and lists its options.` });
    }
    const refs: string[] = [];
    if (d.source.kind === 'entity') for (const f of d.source.filters) if (f.value && typeof f.value === 'object' && !Array.isArray(f.value)) refs.push(f.value.param);
    if (d.source.kind !== 'entity') for (const v of Object.values(d.source.params)) if (v && typeof v === 'object') refs.push(v.param);
    for (const r of refs) if (!names.has(r)) ctx.addIssue({ code: 'custom', message: `The source names parameter ${r}, which the report does not define.` });
    const computed = new Set<string>();
    for (const c of d.computed) {
      if (computed.has(c.name)) ctx.addIssue({ code: 'custom', message: `Computed column ${c.name} is defined twice.` });
      computed.add(c.name);
    }
  });
export type ReportDefinition = z.infer<typeof reportDefinitionSchema>;

// ---------- parameters ----------

export type ParamValues = Record<string, string | number | boolean | null>;

/** The parameters of a run: given values checked against their types, defaults for the rest; unknown names refused. */
export function bindReportParams(defs: readonly ReportParam[], given: Record<string, unknown> | null | undefined): ParamValues {
  const input = given ?? {};
  for (const k of Object.keys(input)) if (!defs.some((d) => d.name === k)) throw badRequest(`${k} is not a parameter of this report.`);
  const out: ParamValues = {};
  for (const d of defs) {
    const raw = Object.hasOwn(input, d.name) ? input[d.name] : d.default;
    const label = d.title || d.name;
    if (raw === undefined || raw === null || raw === '') {
      if (d.required) throw badRequest(`${label} is required.`);
      out[d.name] = null;
      continue;
    }
    switch (d.type) {
      case 'number': {
        const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
        if (!Number.isFinite(n)) throw badRequest(`${label} is a number.`);
        out[d.name] = n;
        break;
      }
      case 'boolean':
        if (typeof raw === 'boolean') out[d.name] = raw;
        else if (raw === 'true' || raw === 'false') out[d.name] = raw === 'true';
        else throw badRequest(`${label} is true or false.`);
        break;
      case 'date': {
        const s = String(raw);
        if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?)?$/.test(s) || Number.isNaN(Date.parse(s))) throw badRequest(`${label} is a date (YYYY-MM-DD).`);
        out[d.name] = s;
        break;
      }
      case 'choice': {
        const s = String(raw);
        if (!(d.options ?? []).includes(s)) throw badRequest(`${label} is one of ${(d.options ?? []).join(', ')}.`);
        out[d.name] = s;
        break;
      }
      default: {
        if (typeof raw === 'object') throw badRequest(`${label} is text.`);
        const s = String(raw);
        if (s.length > 500) throw badRequest(`${label} is at most 500 characters.`);
        out[d.name] = s;
      }
    }
  }
  return out;
}

const isRef = (v: unknown): v is { param: string } => !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { param?: unknown }).param === 'string';

/** The entity source's conditions with parameters filled in; a condition whose parameter is empty is left out. */
export function boundLeaves(leaves: readonly ReportLeaf[], params: ParamValues): { field: string; op: (typeof OPS)[number]; value?: unknown }[] {
  const out: { field: string; op: (typeof OPS)[number]; value?: unknown }[] = [];
  for (const l of leaves) {
    if (isRef(l.value)) {
      const v = params[l.value.param];
      if (v === null || v === undefined) continue;
      out.push({ field: l.field, op: l.op, value: l.op === 'in' && typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : v });
    } else out.push({ field: l.field, op: l.op, ...(l.value !== undefined ? { value: l.value } : {}) });
  }
  return out;
}

/** A saved query's or endpoint's parameters with the report's parameters filled in (empty ones left out). */
export function boundSourceParams(src: Record<string, unknown>, params: ParamValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (isRef(v)) {
      const x = params[v.param];
      if (x !== null && x !== undefined) out[k] = x;
    } else if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

// ---------- the result ----------

export type ColumnType = 'text' | 'number' | 'date' | 'datetime' | 'boolean';

/** A column the source gives: its key, title and type, and whether the viewer sees it masked (or not at all). */
export interface SourceColumn {
  key: string;
  title: string;
  type: ColumnType;
  masked?: boolean;
  /** Offered (to sort, group, compute or show by name) but not among the columns shown by default (system columns). */
  extra?: boolean;
}

export interface ReportColumn {
  key: string;
  title: string;
  type: ColumnType;
  /** The source column (or `count`) the values come from, which formatting rules name. */
  source: string;
  decimals?: number;
  masked?: boolean;
  computed?: boolean;
}

export interface ReportCell {
  v: string | number | boolean | null;
  /** The viewer sees this value masked: no value, colour or icon is derived from it. */
  masked?: boolean;
  /** The index of the formatting rule that matched (in `ReportResult.formats`). */
  fmt?: number;
}

export interface ReportLine {
  kind: 'row' | 'group' | 'subtotal' | 'total';
  level: number;
  /** A group header's or a total's words ("Region: West", "Subtotal West", "Grand total"). */
  label?: string;
  /** The rows a group, subtotal or total covers. */
  count?: number;
  cells: ReportCell[];
}

export interface ReportResult {
  title: string;
  notes: string;
  layout: ReportLayout['kind'];
  columns: ReportColumn[];
  lines: ReportLine[];
  formats: { style: FormatRule['style']; icon: FormatRule['icon']; text: string | null }[];
  /** Source rows read (at most the cap) and whether more matched. */
  rowsRead: number;
  rowCap: number;
  truncated: boolean;
  /** Cross-tab: distinct column values added up in "Other" (beyond `maxColumns`). */
  columnsFolded: number;
  params: ParamValues;
  page: PageSetup;
  generatedAt: string;
}

export interface ReportInput {
  def: ReportDefinition;
  columns: SourceColumn[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  params: ParamValues;
  /** Lines at most (the live preview's 200). */
  lineCap?: number;
  now?: Date;
}

type V = string | number | boolean | null;
const MASKED: ReportCell = { v: null, masked: true };

const asV = (v: unknown): V => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  if (Array.isArray(v)) return v.map((x) => (x == null ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ');
  return JSON.stringify(v);
};

const numOf = (v: V): number | null => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/** Values in one order for every layout: empty last, numbers by value, text by code point, case-insensitively first. */
export function compareValues(a: V, b: V): number {
  if (a === b) return 0;
  if (a === null || a === '') return b === null || b === '' ? 0 : 1;
  if (b === null || b === '') return -1;
  const na = typeof a === 'number' || typeof a === 'boolean' ? Number(a) : null;
  const nb = typeof b === 'number' || typeof b === 'boolean' ? Number(b) : null;
  if (na !== null && nb !== null) return na - nb;
  if (na !== null) return -1;
  if (nb !== null) return 1;
  const sa = String(a);
  const sb = String(b);
  const la = sa.toLowerCase();
  const lb = sb.toLowerCase();
  return la < lb ? -1 : la > lb ? 1 : sa < sb ? -1 : sa > sb ? 1 : 0;
}

const typeOf = (v: V): ColumnType => (typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'text');

class Acc {
  n = 0;
  sum = 0;
  nums = 0;
  min: V = null;
  max: V = null;
  masked = false;
  add(v: V, masked: boolean): void {
    this.n++;
    if (masked) {
      this.masked = true;
      return;
    }
    const x = numOf(v);
    if (x !== null) {
      this.sum += x;
      this.nums++;
    }
    if (v !== null && v !== '') {
      if (this.min === null || compareValues(v, this.min) < 0) this.min = v;
      if (this.max === null || compareValues(v, this.max) > 0) this.max = v;
    }
  }
  merge(o: Acc): void {
    this.n += o.n;
    this.sum += o.sum;
    this.nums += o.nums;
    this.masked ||= o.masked;
    if (o.min !== null && (this.min === null || compareValues(o.min, this.min) < 0)) this.min = o.min;
    if (o.max !== null && (this.max === null || compareValues(o.max, this.max) > 0)) this.max = o.max;
  }
  value(op: AggOp): ReportCell {
    if (op === 'count') return { v: this.n };
    if (this.masked) return MASKED;
    if (op === 'sum') return { v: this.nums ? round(this.sum) : null };
    if (op === 'avg') return { v: this.nums ? round(this.sum / this.nums) : null };
    return { v: op === 'min' ? this.min : this.max };
  }
}

/** Float sums printed as people expect (0.1 + 0.2 is 0.3). */
const round = (x: number): number => Math.round(x * 1e9) / 1e9;

interface Row {
  v: Map<string, V>;
  /** Masked columns as the viewer is shown them (last four, a hash, or nothing): displayed, never computed from. */
  shown: Map<string, V>;
}

/** Lays out a report's rows. Throws a 400 for a definition the source's columns cannot satisfy. */
export function computeReport(input: ReportInput): ReportResult {
  const { def } = input;
  const byKey = new Map(input.columns.map((c) => [c.key, c]));
  const masked = new Set(input.columns.filter((c) => c.masked).map((c) => c.key));
  const types = new Map<string, ColumnType>(input.columns.map((c) => [c.key, c.type]));
  const titles = new Map<string, string>(input.columns.map((c) => [c.key, c.title]));

  // Computed columns, in order: each reads the source's columns and the computed columns before it.
  const formulas: { name: string; f: Formula }[] = [];
  const readable = new Set(input.columns.map((c) => c.key));
  for (const c of def.computed) {
    if (readable.has(c.name)) throw badRequest(`Computed column ${c.name} has the name of a source column.`);
    let f: Formula;
    try {
      f = compileFormula(c.formula, readable);
    } catch (err) {
      if (err instanceof FormulaError) throw badRequest(`Computed column ${c.name}: ${err.message}`);
      throw err;
    }
    formulas.push({ name: c.name, f });
    if (f.refs.some((r) => masked.has(r))) masked.add(c.name);
    readable.add(c.name);
    titles.set(c.name, c.title || c.name);
  }

  const rows: Row[] = input.rows.map((raw) => {
    const v = new Map<string, V>();
    const shown = new Map<string, V>();
    for (const c of input.columns) {
      v.set(c.key, c.masked ? null : asV(raw[c.key]));
      if (c.masked) shown.set(c.key, asV(raw[c.key]));
    }
    for (const { name, f } of formulas) {
      if (masked.has(name)) {
        v.set(name, null);
        continue;
      }
      let out: V;
      try {
        out = f.evaluate(v);
      } catch {
        out = null;
      }
      v.set(name, out);
    }
    return { v, shown };
  });
  for (const { name } of formulas) {
    const first = rows.map((r) => r.v.get(name)).find((x) => x !== null && x !== undefined && x !== '');
    types.set(name, first === undefined || first === null ? 'text' : typeOf(first));
  }

  const known = (k: string, where: string) => {
    if (!readable.has(k)) throw badRequest(`${where}: ${k} is not a column of this report's source${byKey.size ? ` (${[...readable].slice(0, 12).join(', ')}${readable.size > 12 ? ', …' : ''})` : ''}.`);
  };
  for (const s of def.sort) known(s.column, 'Sort');
  for (const r of def.formatting) if (r.column !== 'count') known(r.column, 'Formatting');
  for (const c of def.columns) known(c.key, 'Columns');

  // Sorting: the report's sort, steady (rows that compare equal keep the source's order).
  const ordered = rows.map((r, i) => ({ r, i }));
  const sortBy = (keys: { column: string; dir: 'asc' | 'desc' }[]) =>
    ordered.sort((a, b) => {
      for (const k of keys) {
        const c = compareValues(a.r.v.get(k.column) ?? null, b.r.v.get(k.column) ?? null);
        if (c) return k.dir === 'desc' ? -c : c;
      }
      return a.i - b.i;
    });

  const formats = def.formatting.map((r) => ({ style: r.style, icon: r.icon, text: r.text ?? null }));
  const fmtOf = (source: string, cell: ReportCell): ReportCell => {
    if (cell.masked || cell.v === undefined) return cell;
    const i = def.formatting.findIndex((r) => r.column === source && ruleMatches(r, cell.v));
    return i >= 0 ? { ...cell, fmt: i } : cell;
  };
  const cellOf = (row: Row, key: string): ReportCell => (masked.has(key) ? { v: row.shown.get(key) ?? null, masked: true } : { v: row.v.get(key) ?? null });
  const colOf = (k: string, extra: Partial<ReportColumn> = {}): ReportColumn => {
    const spec = def.columns.find((c) => c.key === k);
    return {
      key: k,
      title: spec?.title || titles.get(k) || k,
      type: types.get(k) ?? 'text',
      source: k,
      ...(spec?.decimals !== undefined ? { decimals: spec.decimals } : {}),
      ...(masked.has(k) ? { masked: true } : {}),
      ...(formulas.some((f) => f.name === k) ? { computed: true } : {}),
      ...extra
    };
  };

  const lineCap = input.lineCap ?? Infinity;
  let capped = false;
  const lines: ReportLine[] = [];
  const push = (l: ReportLine): boolean => {
    if (lines.length >= lineCap) {
      capped = true;
      return false;
    }
    lines.push(l);
    return true;
  };

  const shown = def.columns.length ? def.columns.map((c) => c.key) : [...input.columns.filter((c) => !c.extra).map((c) => c.key), ...formulas.map((f) => f.name)];
  const layout = def.layout;
  let columns: ReportColumn[] = [];
  let folded = 0;

  if (layout.kind === 'table') {
    sortBy(def.sort);
    columns = shown.map((k) => colOf(k));
    for (const { r } of ordered) if (!push({ kind: 'row', level: 0, cells: columns.map((c) => fmtOf(c.source, cellOf(r, c.key))) })) break;
  } else if (layout.kind === 'grouped') {
    for (const g of layout.groupBy) known(g, 'Group by');
    for (const a of layout.aggregates) {
      if (a.op !== 'count' && !a.column) throw badRequest(`Totals: ${a.op} names a column.`);
      if (a.column) known(a.column, 'Totals');
    }
    const groupDirs = layout.groupBy.map((g) => ({ column: g, dir: def.sort.find((s) => s.column === g)?.dir ?? ('asc' as const) }));
    sortBy([...groupDirs, ...def.sort.filter((s) => !layout.groupBy.includes(s.column))]);
    columns = shown.filter((k) => !layout.groupBy.includes(k)).map((k) => colOf(k));
    if (!columns.length) columns = [colOf(layout.groupBy[0]!)];
    // A total sits under its column; count (and a total over a column not shown) goes in the label.
    const aggs = layout.aggregates.map((a) => ({ ...a, at: a.column ? columns.findIndex((c) => c.key === a.column) : -1 }));
    const totalCells = (accs: Acc[]): ReportCell[] => {
      const cells: ReportCell[] = columns.map(() => ({ v: null }));
      aggs.forEach((a, i) => {
        if (a.at < 0 || cells[a.at]!.v !== null || cells[a.at]!.masked) return;
        cells[a.at] = fmtOf(a.column!, accs[i]!.value(a.op));
      });
      return cells;
    };
    const extraLabel = (accs: Acc[]): string => {
      const parts: string[] = [];
      aggs.forEach((a, i) => {
        if (a.op === 'count') parts.push(`${accs[i]!.n} row${accs[i]!.n === 1 ? '' : 's'}`);
        else if (a.at < 0) {
          const c = accs[i]!.value(a.op);
          parts.push(`${a.op} of ${titles.get(a.column!) ?? a.column}: ${c.masked ? 'masked' : c.v === null ? '-' : String(c.v)}`);
        }
      });
      return parts.length ? ` (${parts.join('; ')})` : '';
    };
    const accRow = (accs: Acc[], r: Row) => aggs.forEach((a, i) => accs[i]!.add(a.column ? (r.v.get(a.column) ?? null) : null, !!a.column && masked.has(a.column)));
    const fresh = () => aggs.map(() => new Acc());
    const depth = layout.groupBy.length;
    const grand = fresh();
    // open groups: their key and accumulators, outermost first
    let grandN = 0;
    const open: { key: V; masked: boolean; accs: Acc[]; n: number }[] = [];
    const close = (to: number) => {
      while (open.length > to) {
        const g = open.pop()!;
        const lvl = open.length;
        if (layout.subtotals) push({ kind: 'subtotal', level: lvl, label: `Subtotal ${groupWord(g.key, g.masked)}${extraLabel(g.accs)}`, count: g.n, cells: totalCells(g.accs) });
        if (open.length) {
          const up = open[open.length - 1]!;
          up.accs.forEach((a, i) => a.merge(g.accs[i]!));
          up.n += g.n;
        } else {
          grand.forEach((a, i) => a.merge(g.accs[i]!));
          grandN += g.n;
        }
      }
    };
    const counts = groupCounts(ordered.map((o) => o.r), layout.groupBy, masked);
    let prev: V[] | null = null;
    for (const { r } of ordered) {
      if (capped) break;
      const keys = layout.groupBy.map((g) => (masked.has(g) ? null : (r.v.get(g) ?? null)));
      let same = 0;
      if (prev) while (same < depth && compareValues(prev[same]!, keys[same]!) === 0) same++;
      if (!prev || same < depth) {
        close(same);
        for (let l = same; l < depth; l++) {
          const g = layout.groupBy[l]!;
          const path = keys.slice(0, l + 1);
          push({ kind: 'group', level: l, label: `${titles.get(g) ?? g}: ${groupWord(keys[l]!, masked.has(g))}`, count: counts.get(JSON.stringify(path)) ?? 0, cells: [] });
          open.push({ key: keys[l]!, masked: masked.has(g), accs: fresh(), n: 0 });
        }
      }
      prev = keys;
      push({ kind: 'row', level: depth, cells: columns.map((c) => fmtOf(c.source, cellOf(r, c.key))) });
      const leaf = open[open.length - 1]!;
      accRow(leaf.accs, r);
      leaf.n++;
    }
    close(0);
    if (layout.grandTotal) push({ kind: 'total', level: 0, label: `Grand total${extraLabel(grand)}`, count: grandN, cells: totalCells(grand) });
  } else {
    for (const g of layout.rows) known(g, 'Rows');
    known(layout.column, 'Column');
    for (const a of layout.values) {
      if (a.op !== 'count' && !a.column) throw badRequest(`Values: ${a.op} names a column.`);
      if (a.column) known(a.column, 'Values');
    }
    const colMasked = masked.has(layout.column);
    const colKey = (r: Row): V => (colMasked ? null : (r.v.get(layout.column) ?? null));
    const distinct: V[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const k = colKey(r);
      const s = JSON.stringify(k);
      if (!seen.has(s)) {
        seen.add(s);
        distinct.push(k);
      }
    }
    distinct.sort(compareValues);
    const kept = distinct.slice(0, layout.maxColumns);
    folded = Math.max(0, distinct.length - kept.length);
    const slot = new Map(kept.map((k, i) => [JSON.stringify(k), i]));
    const OTHER = kept.length;
    const nslots = kept.length + (folded ? 1 : 0);
    const vals = layout.values;
    const valTitle = (a: Agg) => (a.op === 'count' ? 'Count' : `${a.op[0]!.toUpperCase()}${a.op.slice(1)} of ${titles.get(a.column!) ?? a.column}`);
    const one = vals.length === 1;
    const colName = (k: V, isOther: boolean) => (isOther ? 'Other' : groupWord(k, colMasked));
    columns = layout.rows.map((g) => colOf(g));
    for (let sIdx = 0; sIdx < nslots; sIdx++) {
      const isOther = sIdx === OTHER;
      for (let vi = 0; vi < vals.length; vi++) {
        const a = vals[vi]!;
        columns.push({ key: `c${sIdx}_${vi}`, title: one ? colName(kept[sIdx] ?? null, isOther) : `${colName(kept[sIdx] ?? null, isOther)} · ${valTitle(a)}`, type: a.op === 'count' ? 'number' : a.op === 'min' || a.op === 'max' ? (types.get(a.column!) ?? 'number') : 'number', source: a.op === 'count' ? 'count' : a.column!, ...(a.column && masked.has(a.column) && a.op !== 'count' ? { masked: true } : {}) });
      }
    }
    if (layout.rowTotals) vals.forEach((a, vi) => columns.push({ key: `t_${vi}`, title: one ? 'Total' : `Total · ${valTitle(a)}`, type: a.op === 'count' ? 'number' : a.op === 'min' || a.op === 'max' ? (types.get(a.column!) ?? 'number') : 'number', source: a.op === 'count' ? 'count' : a.column!, ...(a.column && masked.has(a.column) && a.op !== 'count' ? { masked: true } : {}) }));

    // one entry per combination of row fields: accumulators per column slot and value, plus the row's totals
    const rowDirs = layout.rows.map((g) => ({ column: g, dir: def.sort.find((s) => s.column === g)?.dir ?? ('asc' as const) }));
    const groups = new Map<string, { keys: V[]; cells: Acc[][]; total: Acc[] }>();
    const colTotals: Acc[][] = Array.from({ length: nslots }, () => vals.map(() => new Acc()));
    const grand = vals.map(() => new Acc());
    for (const r of rows) {
      const keys = layout.rows.map((g) => (masked.has(g) ? null : (r.v.get(g) ?? null)));
      const id = JSON.stringify(keys);
      let g = groups.get(id);
      if (!g) {
        g = { keys, cells: Array.from({ length: nslots }, () => vals.map(() => new Acc())), total: vals.map(() => new Acc()) };
        groups.set(id, g);
      }
      const s = slot.get(JSON.stringify(colKey(r))) ?? OTHER;
      vals.forEach((a, vi) => {
        const v = a.column ? (r.v.get(a.column) ?? null) : null;
        const m = !!a.column && masked.has(a.column);
        g!.cells[s]![vi]!.add(v, m);
        g!.total[vi]!.add(v, m);
        colTotals[s]![vi]!.add(v, m);
        grand[vi]!.add(v, m);
      });
    }
    const list = [...groups.values()].sort((a, b) => {
      for (let i = 0; i < rowDirs.length; i++) {
        const c = compareValues(a.keys[i]!, b.keys[i]!);
        if (c) return rowDirs[i]!.dir === 'desc' ? -c : c;
      }
      return 0;
    });
    const valueCells = (cellAccs: Acc[][], total: Acc[]): ReportCell[] => {
      const out: ReportCell[] = [];
      for (let sIdx = 0; sIdx < nslots; sIdx++) vals.forEach((a, vi) => out.push(fmtOf(a.op === 'count' ? 'count' : a.column!, cellAccs[sIdx]![vi]!.n || a.op === 'count' ? cellAccs[sIdx]![vi]!.value(a.op) : { v: null })));
      if (layout.rowTotals) vals.forEach((a, vi) => out.push(fmtOf(a.op === 'count' ? 'count' : a.column!, total[vi]!.value(a.op))));
      return out;
    };
    for (const g of list) {
      const head = layout.rows.map((k, i) => (masked.has(k) ? MASKED : { v: g.keys[i]! }));
      if (!push({ kind: 'row', level: 0, count: g.total[0]?.n ?? 0, cells: [...head, ...valueCells(g.cells, g.total)] })) break;
    }
    if (layout.columnTotals) push({ kind: 'total', level: 0, label: 'Total', count: rows.length, cells: [...layout.rows.map((_, i) => ({ v: i === 0 ? 'Total' : null })), ...valueCells(colTotals, grand)] });
  }

  return {
    title: def.title,
    notes: def.notes,
    layout: layout.kind,
    columns,
    lines,
    formats,
    rowsRead: input.rows.length,
    rowCap: def.rowCap,
    truncated: input.truncated || capped,
    columnsFolded: folded,
    params: input.params,
    page: def.page,
    generatedAt: (input.now ?? new Date()).toISOString()
  };
}

function groupWord(v: V, isMasked: boolean): string {
  if (isMasked) return '(masked)';
  if (v === null || v === '') return '(empty)';
  return typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v);
}

/** How many rows each group path holds (a group header says it before its rows are written). */
function groupCounts(rows: Row[], groupBy: string[], masked: Set<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const keys = groupBy.map((g) => (masked.has(g) ? null : (r.v.get(g) ?? null)));
    for (let l = 1; l <= keys.length; l++) {
      const id = JSON.stringify(keys.slice(0, l));
      out.set(id, (out.get(id) ?? 0) + 1);
    }
  }
  return out;
}

/** Whether a formatting rule matches a value (never called for a masked one). */
export function ruleMatches(r: FormatRule, v: V): boolean {
  const empty = v === null || v === '';
  if (r.when === 'empty') return empty;
  if (r.when === 'notEmpty') return !empty;
  if (empty) return false;
  const n = numOf(v);
  const target = r.value === undefined ? null : r.value;
  const tn = typeof target === 'number' ? target : typeof target === 'string' && target.trim() !== '' && Number.isFinite(Number(target)) ? Number(target) : null;
  switch (r.when) {
    case 'contains':
      return target !== null && String(v).toLowerCase().includes(String(target).toLowerCase());
    case 'eq':
      return n !== null && tn !== null ? n === tn : String(v).toLowerCase() === String(target ?? '').toLowerCase();
    case 'ne':
      return n !== null && tn !== null ? n !== tn : String(v).toLowerCase() !== String(target ?? '').toLowerCase();
    case 'between':
      return n !== null && tn !== null && r.value2 !== undefined && n >= Math.min(tn, r.value2) && n <= Math.max(tn, r.value2);
    default: {
      if (n !== null && tn !== null) return r.when === 'gt' ? n > tn : r.when === 'gte' ? n >= tn : r.when === 'lt' ? n < tn : n <= tn;
      if (target === null) return false;
      const c = compareValues(String(v), String(target));
      return r.when === 'gt' ? c > 0 : r.when === 'gte' ? c >= 0 : r.when === 'lt' ? c < 0 : c <= 0;
    }
  }
}

/** A cell as text for CSV, PDF and plain renderings (numbers with the column's decimals). */
export function cellText(c: ReportCell, col: ReportColumn | undefined): string {
  if (c.masked) return c.v === null || c.v === undefined ? '(masked)' : String(c.v);
  if (c.v === null || c.v === undefined) return '';
  if (typeof c.v === 'number') return col?.decimals !== undefined ? c.v.toFixed(col.decimals) : String(c.v);
  if (typeof c.v === 'boolean') return c.v ? 'Yes' : 'No';
  return c.v;
}
