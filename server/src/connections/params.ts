import { z } from 'zod';
import { HttpProblem } from '../http/problem.js';

/*
 * 1.8.0 (B-125, B-126): typed named parameters of saved connection queries and REST endpoints. A definition says
 * the type (string, number, boolean, date, list, or an identifier picked from a fixed list), whether it is required,
 * its default, and the values or range it allows. `bindParams` turns what a caller gives into typed values or a 400
 * naming every parameter that is wrong; the values are then bound by the driver (or encoded into a URL), never pasted
 * into query text.
 */

export const PARAM_TYPES = ['string', 'number', 'boolean', 'date', 'list', 'identifier'] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

const PARAM_NAME = /^[a-z][a-z0-9_]{0,62}$/;
/** An identifier a parameter may stand for: a plain column or table name, quoted when it is used. */
export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}(\.[A-Za-z_][A-Za-z0-9_]{0,62})?$/;

const scalar = z.union([z.string().max(2000), z.number().finite(), z.boolean()]);

export const paramSchema = z
  .object({
    name: z.string().regex(PARAM_NAME, 'lower-case letters, digits and _, starting with a letter'),
    type: z.enum(PARAM_TYPES),
    title: z.string().trim().max(200).optional(),
    required: z.boolean().default(false),
    default: z.union([scalar, z.array(scalar).max(500)]).nullable().optional(),
    /** The values allowed (for an identifier: the only names it may stand for). */
    allowed: z.array(z.union([z.string().max(200), z.number().finite()])).max(500).optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    /** Text length bounds for strings. */
    maxLength: z.number().int().min(1).max(2000).optional(),
    /** A list's items. */
    itemType: z.enum(['string', 'number']).optional(),
    maxItems: z.number().int().min(1).max(500).optional()
  })
  .strict();
export type ParamDef = z.infer<typeof paramSchema>;

export const paramsSchema = z.array(paramSchema).max(30);

/** Problems with a set of definitions (duplicates, an identifier without its list, a range upside down). */
export function paramProblems(defs: readonly ParamDef[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of defs) {
    if (seen.has(d.name)) out.push(`Two parameters are called ${d.name}.`);
    seen.add(d.name);
    if (d.type === 'identifier') {
      if (!d.allowed?.length) out.push(`${d.name}: an identifier parameter lists the names it may stand for.`);
      for (const a of d.allowed ?? []) if (typeof a !== 'string' || !IDENTIFIER.test(a)) out.push(`${d.name}: ${String(a)} is not a plain column or table name.`);
    }
    if (d.min != null && d.max != null && d.min > d.max) out.push(`${d.name}: min is above max.`);
    if (d.type === 'list' && !d.itemType) out.push(`${d.name}: a list says whether its items are strings or numbers (itemType).`);
    if (d.default != null) {
      try {
        bindOne(d, d.default);
      } catch (err) {
        out.push(`${d.name}: the default ${(err as Error).message}.`);
      }
    }
  }
  return out;
}

const DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function bindScalar(d: ParamDef, type: 'string' | 'number' | 'boolean' | 'date', v: unknown): string | number | boolean {
  switch (type) {
    case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      if (!Number.isFinite(n)) throw new Error('should be a number');
      if (d.min != null && n < d.min) throw new Error(`is below ${d.min}`);
      if (d.max != null && n > d.max) throw new Error(`is above ${d.max}`);
      return n;
    }
    case 'boolean':
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 1 || v === '1') return true;
      if (v === 'false' || v === 0 || v === '0') return false;
      throw new Error('should be true or false');
    case 'date': {
      if (typeof v !== 'string' || !DATE.test(v) || Number.isNaN(new Date(v).getTime())) throw new Error('should be a date (YYYY-MM-DD) or a date and time');
      if (d.min != null && new Date(v).getTime() < d.min) throw new Error('is before the earliest allowed');
      if (d.max != null && new Date(v).getTime() > d.max) throw new Error('is after the latest allowed');
      return v;
    }
    default: {
      if (typeof v !== 'string' && typeof v !== 'number') throw new Error('should be text');
      const s = String(v).normalize('NFC');
      if (s.length > (d.maxLength ?? 2000)) throw new Error(`is longer than ${d.maxLength ?? 2000} characters`);
      if (/\0/.test(s)) throw new Error('holds a NUL character');
      return s;
    }
  }
}

const inAllowed = (d: ParamDef, v: string | number | boolean) => !d.allowed?.length || d.allowed.some((a) => (typeof a === 'number' ? a === v : String(a) === String(v)));

/** One parameter's value in its bound form, or an Error naming what is wrong. */
export function bindOne(d: ParamDef, v: unknown): unknown {
  if (d.type === 'list') {
    const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : [v];
    if (arr.length > (d.maxItems ?? 500)) throw new Error(`has more than ${d.maxItems ?? 500} items`);
    if (!arr.length) throw new Error('is empty');
    return arr.map((x) => {
      const b = bindScalar(d, d.itemType ?? 'string', x);
      if (!inAllowed(d, b)) throw new Error(`holds ${String(b)}, which is not one of the allowed values`);
      return b;
    });
  }
  if (d.type === 'identifier') {
    if (typeof v !== 'string') throw new Error('should be one of the allowed names');
    const hit = (d.allowed ?? []).find((a) => typeof a === 'string' && a === v);
    if (hit === undefined) throw new Error(`should be one of ${(d.allowed ?? []).slice(0, 10).join(', ')}`);
    return hit;
  }
  const b = bindScalar(d, d.type, v);
  if (!inAllowed(d, b)) throw new Error(`should be one of ${(d.allowed ?? []).slice(0, 10).join(', ')}`);
  return b;
}

/**
 * Typed values for every defined parameter: the given value, else the default, else null (a required one missing
 * is a problem). A value given for a parameter that is not defined is refused, so a typo is not silently dropped.
 */
export function bindParams(defs: readonly ParamDef[], given: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const problems: { param: string; message: string }[] = [];
  const out: Record<string, unknown> = {};
  const known = new Set(defs.map((d) => d.name));
  for (const k of Object.keys(given ?? {})) if (!known.has(k)) problems.push({ param: k, message: 'is not a parameter of this query' });
  for (const d of defs) {
    const raw = given?.[d.name];
    const v = raw === undefined || raw === null || raw === '' ? (d.default ?? null) : raw;
    if (v === null) {
      if (d.required) problems.push({ param: d.name, message: 'is required' });
      out[d.name] = null;
      continue;
    }
    try {
      out[d.name] = bindOne(d, v);
    } catch (err) {
      problems.push({ param: d.name, message: (err as Error).message });
    }
  }
  if (problems.length) throw new HttpProblem(400, 'Invalid parameters', problems.map((p) => `${p.param} ${p.message}`).join('; ') + '.', { extensions: { errors: problems.map((p) => ({ path: p.param, message: p.message })) } });
  return out;
}

/** A value of the type for checking a query's shape when it is saved: the default, else an allowed value, else a stand-in. */
export function sampleValue(d: ParamDef): unknown {
  if (d.default != null) return bindOne(d, d.default);
  if (d.type === 'identifier') return d.allowed?.[0] ?? 'id';
  const first = d.allowed?.[0];
  switch (d.type) {
    case 'number':
      return typeof first === 'number' ? first : (d.min ?? 0);
    case 'boolean':
      return false;
    case 'date':
      return '2000-01-01';
    case 'list':
      return [first ?? (d.itemType === 'number' ? 0 : 'x')];
    default:
      return first !== undefined ? String(first) : 'x';
  }
}
