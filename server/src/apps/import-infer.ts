import { highest, labelRank, type Label } from '../authz/labels.js';
import { profile } from '../imports/tabular.js';
import type { Row } from './import-transforms.js';
import { INDEX_TEXT_MAX, NAME, RESERVED, type EntityDefinition, type Field } from './schema.js';

/*
 * Sprint 45 (B-127, B-129): "new entity from file". The field types of a proposed entity are inferred from a sample
 * of the rows (after the transformations): booleans, whole and decimal numbers, dates and dates with a time, a short
 * list of repeated values as an enum, e-mail addresses and web addresses as text with a pattern (the schema has no
 * e-mail or URL type), else text with a maxLength rounded up from the longest value. A column with no blank is proposed
 * required; one whose values are all different (and that can be unique) is proposed unique. The PII flags are those
 * of the dataset import's schema preview (`imports/tabular.ts` `profile`): the detectors over the values and the
 * column's name. Nothing is created here: the console shows the proposal, the designer edits it, and the entity is
 * made through `AppService.createEntity` like any other.
 */

export const EMAIL_PATTERN = '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$';
export const URL_PATTERN = '^https?://[^\\s]+$';
const EMAIL = new RegExp(EMAIL_PATTERN);
const URL_RE = new RegExp(URL_PATTERN, 'i');
const BOOL = /^(true|false|yes|no|y|n)$/i;
const INT = /^[+-]?\d{1,15}$/;
const DEC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?$/;
const ENUM_MAX = 12;

export interface ColumnProposal {
  column: string;
  /** The field name proposed (a valid, unreserved, distinct name). */
  name: string;
  title: string;
  /** What the sample looked like, in words. */
  inferred: string;
  field: Field;
  /** Skip the column by default: it had no value in the sample. */
  skip: boolean;
  pii: string | null;
  sample: string | null;
  filled: number;
  distinct: number;
}

export interface Proposal {
  columns: ColumnProposal[];
  /** The proposed title field (the first text column that is not flagged as personal data, else the first text). */
  titleField: string | null;
  /** The proposed label: the source's, raised to confidential when a column is flagged as personal data. */
  label: Label;
  sampled: number;
}

const text = (v: unknown): string => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v));
const blank = (v: unknown) => v == null || (typeof v === 'string' && v.trim() === '');

/** A valid field name from a column header: lower-case ASCII, `_` for the rest, never reserved, never repeated. */
export function fieldName(header: string, taken: Set<string>): string {
  let base = header
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(base)) base = `f_${base}`.replace(/_+$/, '');
  base = base.slice(0, 55) || 'field';
  if (RESERVED.has(base)) base = `${base}_value`;
  let name = base;
  for (let i = 2; taken.has(name) || !NAME.test(name); i++) name = `${base.slice(0, 55)}_${i}`;
  taken.add(name);
  return name;
}

const roundLength = (n: number): number => {
  for (const step of [50, 100, 200, 255, 500, 1000, 2000, 5000, 10_000, 50_000, 100_000]) if (n <= step) return step;
  return 100_000;
};

/** One column's field, from its values in the sample. */
function inferColumn(name: string, values: unknown[]): { field: Field; inferred: string } {
  const filled = values.filter((v) => !blank(v));
  const texts = filled.map(text);
  const base = { name, required: filled.length === values.length && values.length > 0, indexed: false, unique: false };
  const distinct = new Set(texts.map((t) => t.normalize('NFC').toLowerCase()));
  const allDistinct = filled.length >= 2 && distinct.size === filled.length;
  const all = (test: (v: unknown, t: string) => boolean) => filled.length > 0 && filled.every((v, i) => test(v, texts[i]!));
  if (!filled.length) return { field: { ...base, required: false, type: 'string', maxLength: 255 }, inferred: 'empty in the sample' };
  if (filled.some((v) => typeof v === 'object')) return { field: { ...base, type: 'json', maxBytes: 10_000 }, inferred: 'objects or lists' };
  if (all((v, t) => typeof v === 'boolean' || BOOL.test(t))) return { field: { ...base, type: 'boolean' }, inferred: 'true or false' };
  if (all((v, t) => (typeof v === 'number' && Number.isInteger(v)) || INT.test(t))) {
    const unique = allDistinct;
    return { field: { ...base, type: 'number', integer: true, unique, indexed: unique }, inferred: 'whole numbers' };
  }
  if (all((v, t) => typeof v === 'number' || DEC.test(t))) return { field: { ...base, type: 'number', integer: false }, inferred: 'numbers' };
  if (all((_v, t) => DATE.test(t) && Number.isFinite(Date.parse(`${t}T00:00:00Z`)))) return { field: { ...base, type: 'date', withTime: false, unique: false }, inferred: 'dates' };
  if (all((_v, t) => DATETIME.test(t) || DATE.test(t))) return { field: { ...base, type: 'date', withTime: true }, inferred: 'dates with a time' };
  const longest = Math.max(...texts.map((t) => [...t].length));
  const multiline = texts.some((t) => /[\r\n]/.test(t));
  if (all((_v, t) => EMAIL.test(t))) {
    const unique = allDistinct;
    return { field: { ...base, type: 'string', maxLength: Math.min(INDEX_TEXT_MAX, Math.max(longest, 254)), pattern: EMAIL_PATTERN, unique, indexed: true }, inferred: 'e-mail addresses' };
  }
  if (all((_v, t) => URL_RE.test(t))) return { field: { ...base, type: 'string', maxLength: roundLength(Math.max(longest, 200)), pattern: URL_PATTERN }, inferred: 'web addresses' };
  // A few values that repeat: an enum (the dataset preview's "class").
  const opts = [...new Map(texts.map((t) => [t.normalize('NFC').toLowerCase(), t.trim()])).values()];
  if (opts.length >= 1 && opts.length <= ENUM_MAX && filled.length >= opts.length * 2 && opts.every((o) => o.length > 0 && o.length <= 100) && !multiline) {
    return { field: { ...base, type: 'enum', options: opts.sort((a, b) => a.localeCompare(b)).map((value) => ({ value })), indexed: true }, inferred: `one of ${opts.length} value${opts.length === 1 ? '' : 's'}` };
  }
  const maxLength = roundLength(longest);
  const unique = allDistinct && maxLength <= INDEX_TEXT_MAX && !multiline;
  return { field: { ...base, type: 'string', maxLength, ...(multiline ? { multiline: true } : {}), unique, indexed: unique }, inferred: multiline ? 'text on several lines' : 'text' };
}

/** The proposed entity for the rows: a field per column, the PII flags, the title field and the label. */
export function inferEntity(columns: string[], rows: Row[], o: { sourceLabel: Label; ceiling: Label }): Proposal {
  const sample = rows.slice(0, 1000);
  const prof = new Map(profile(sample.map((r) => r.values)).map((p) => [p.name, p]));
  const taken = new Set<string>();
  const out: ColumnProposal[] = columns.slice(0, 200).map((column) => {
    const name = fieldName(column, taken);
    const values = sample.map((r) => r.values[column]);
    const { field, inferred } = inferColumn(name, values);
    const p = prof.get(column);
    const title = column.trim().slice(0, 200) || name;
    const filled = values.filter((v) => !blank(v));
    return { column, name, title, inferred, field: { ...field, title } as Field, skip: filled.length === 0, pii: p?.pii ?? null, sample: p?.sample ?? null, filled: filled.length, distinct: new Set(filled.map(text)).size };
  });
  const strings = out.filter((c) => !c.skip && c.field.type === 'string' && !(c.field as { multiline?: boolean }).multiline);
  const titleField = (strings.find((c) => !c.pii) ?? strings[0])?.name ?? null;
  let label = o.sourceLabel;
  if (out.some((c) => c.pii && !c.skip)) label = highest(label, 'confidential');
  if (labelRank(label) > labelRank(o.ceiling)) label = labelRank(o.sourceLabel) > labelRank(o.ceiling) ? o.sourceLabel : o.ceiling;
  return { columns: out, titleField, label, sampled: sample.length };
}

/** The definition a (possibly edited) proposal stands for: the kept columns' fields, the title field. */
export function definitionOf(fields: Field[], titleField: string | null): EntityDefinition {
  return { fields, ...(titleField && fields.some((f) => f.name === titleField) ? { titleField } : {}) };
}
