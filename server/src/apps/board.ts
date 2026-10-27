import { z } from 'zod';
import type { Principal } from '../authz/policy.js';
import { badRequest } from '../http/problem.js';
import { filterSchema, sortSchema, type Filter, type Sort } from './query.js';
import type { Field } from './schema.js';
import type { AppService, EntityRow } from './service.js';

/*
 * The Board view's columns, paged on the server (the exprsn-platform low-code port, docs/decisions/lowcode-port.md,
 * follow-up 4). A board groups an entity's records by its state (`@state`) or by an indexed enum or static-lookup
 * field. Each column is one ordinary records query (`AppService.query`) with the column's condition added to the
 * reader's filter, so the reader's grant, clearance and hidden-record rules are the ones every read has; the counts are
 * one aggregate over the same match. A column pages with the cursor of its own query ("Load more").
 *
 * Nothing here writes: moves stay transitions and versioned updates through the records routes.
 */

/** The key of a column: a state or option value, or null for records without one. */
const columnKey = z.union([z.string().min(1).max(100), z.null()]);

export const boardSchema = z
  .object({
    /** `@state`, or the name of an indexed enum or static-lookup field. */
    by: z.string().min(1).max(63),
    filter: filterSchema.optional(),
    q: z.string().trim().min(1).max(200).optional(),
    sort: sortSchema.optional(),
    /** Cards per column and page. */
    limit: z.number().int().min(1).max(100).default(25),
    /** Only these columns, each from its cursor (the "Load more" of one column); every column when absent. */
    columns: z.array(z.object({ value: columnKey, cursor: z.string().min(1).max(16_000).optional() }).strict()).min(1).max(20).optional()
  })
  .strict();
export type BoardInput = z.infer<typeof boardSchema>;

/** Columns whose first page is read in one call; the rest come back unloaded and load on request. */
export const BOARD_LOADED_COLUMNS = 40;

export interface BoardColumn {
  value: string | null;
  label: string;
  total: number;
  loaded: boolean;
  records: unknown[];
  nextCursor: string | null;
}

/** What a board of this entity can group by, or why not. */
export function boardGrouping(entity: EntityRow, by: string): { field: Field | null; columns: { value: string; label: string }[] } {
  const def = entity.definition;
  if (by === '@state') {
    if (!def.states) throw badRequest(`${entity.name} has no state machine to group by.`);
    return { field: null, columns: def.states.states.map((s) => ({ value: s.name, label: s.title ?? s.name })) };
  }
  const f = def.fields.find((x) => x.name === by);
  if (!f) throw badRequest(`There is no field ${by}.`);
  const options = f.type === 'enum' ? f.options : f.type === 'lookup' && f.source === 'static' ? (f.options ?? []) : null;
  if (!options) throw badRequest(`A board groups by the state, an enum field or a static lookup; ${by} is a ${f.type} field.`);
  if (!f.indexed && !f.unique) throw badRequest(`${by} is not indexed, so a board cannot page its columns. A designer can mark it indexed.`);
  return { field: f, columns: options.map((o) => ({ value: o.value, label: o.label ?? o.value })) };
}

/** The reader's filter with one more condition, without nesting deeper when the filter is already an `and`. */
function withCondition(filter: Filter | undefined, cond: Filter): Filter {
  if (!filter) return cond;
  if ('and' in filter) return { and: [...filter.and, cond] };
  return { and: [filter, cond] };
}

export async function boardColumns(apps: AppService, p: Principal, appRef: string, entityRef: string, input: BoardInput): Promise<{ by: string; limit: number; total: number; columns: BoardColumn[] }> {
  const { entity } = await apps.resolve(p, appRef, entityRef);
  const { field, columns: declared } = boardGrouping(entity, input.by);
  const name = field ? field.name : 'state';
  const sort: Sort = input.sort?.length ? input.sort : [{ field: 'updatedAt', dir: 'desc' }];
  // One count per column over the reader's match (the grant applies, and a hidden group field is refused there).
  const agg = await apps.aggregate(p, appRef, entityRef, { ...(input.filter ? { filter: input.filter } : {}), ...(input.q ? { q: input.q } : {}), groupBy: name, metrics: [{ op: 'count' }] });
  const counts = new Map<string | null, number>();
  const spell = (v: string | number | null): string | null => {
    if (v == null) return null;
    const s = String(v);
    return declared.find((c) => c.value.toLowerCase() === s.toLowerCase())?.value ?? s;
  };
  for (const g of agg.groups) {
    const k = spell(g.key);
    counts.set(k, (counts.get(k) ?? 0) + (g.values[0] ?? 0));
  }
  // Declared columns in order, then values outside the options (an option removed later), then "no value".
  const all: { value: string | null; label: string }[] = [...declared];
  for (const k of counts.keys()) if (k != null && !all.some((c) => c.value === k)) all.push({ value: k, label: k });
  all.push({ value: null, label: 'No value' });
  const total = [...counts.values()].reduce((a, b) => a + b, 0);

  const wanted = input.columns ? input.columns.map((c) => ({ ...c, label: all.find((x) => x.value === c.value)?.label ?? String(c.value ?? 'No value') })) : all.map((c) => ({ ...c, cursor: undefined as string | undefined }));
  let loads = 0;
  const out: BoardColumn[] = [];
  for (const c of wanted) {
    const n = counts.get(c.value) ?? 0;
    const load = input.columns ? true : n > 0 && loads < BOARD_LOADED_COLUMNS;
    if (!load) {
      out.push({ value: c.value, label: c.label, total: n, loaded: n === 0, records: [], nextCursor: null });
      continue;
    }
    loads++;
    const cond: Filter = c.value == null ? { field: name, op: 'exists', value: false } : { field: name, op: 'eq', value: c.value };
    const page = await apps.query(p, appRef, entityRef, { filter: withCondition(input.filter, cond), sort, ...(input.q ? { q: input.q } : {}), limit: input.limit, ...(c.cursor ? { cursor: c.cursor } : {}), count: false });
    out.push({ value: c.value, label: c.label, total: n, loaded: true, records: page.records, nextCursor: page.nextCursor });
  }
  return { by: input.by, limit: input.limit, total, columns: out };
}
