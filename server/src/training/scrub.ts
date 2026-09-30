import { createHash } from 'node:crypto';
import { detectPii, PII_KINDS } from '../guardrails/detectors.js';

/*
 * Dataset rows and the PII scrub. A row is a JSON object with prompt and completion, instruction and output,
 * messages, or text. Every string in it goes through the same deterministic detectors as the guardrails' `pii`
 * mechanism; each finding is replaced by a placeholder naming its kind. The report counts findings by kind and names
 * the rows and fields, never the values.
 */

export type Row = Record<string, unknown>;

export interface ScrubReport {
  masked: number;
  rowsAffected: number;
  byKind: Record<string, number>;
  /** Up to 200 findings: row number (1-based), field path and kind. */
  findings: { row: number; field: string; kind: string }[];
  detectors: string[];
}

const hasContent = (r: Row): boolean =>
  (typeof r.prompt === 'string' && typeof r.completion === 'string') ||
  (typeof r.instruction === 'string' && typeof r.output === 'string') ||
  (Array.isArray(r.messages) && r.messages.length > 0 && r.messages.every((m) => m && typeof m === 'object' && typeof (m as Row).role === 'string' && typeof (m as Row).content === 'string')) ||
  typeof r.text === 'string';

/** Parses JSON Lines; throws with the first bad line's number. Blank lines are ignored. */
export function parseRows(jsonl: string): Row[] {
  const rows: Row[] = [];
  const lines = jsonl.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      throw new Error(`Line ${i + 1} is not valid JSON.`);
    }
    if (!v || typeof v !== 'object' || Array.isArray(v) || !hasContent(v as Row)) throw new Error(`Line ${i + 1} needs prompt and completion, instruction and output, messages (role and content), or text.`);
    rows.push(v as Row);
  }
  if (!rows.length) throw new Error('The dataset has no rows.');
  return rows;
}

export const toJsonl = (rows: Row[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** Replaces each detected span with `[KIND]`, from the end so earlier offsets stay valid. */
export function maskText(text: string): { text: string; kinds: string[] } {
  const found = detectPii(text, PII_KINDS).sort((a, b) => a.span[0] - b.span[0]);
  const keep: typeof found = [];
  for (const d of found) if (!keep.length || d.span[0] >= keep[keep.length - 1]!.span[1]) keep.push(d);
  let out = text;
  for (const d of [...keep].reverse()) out = out.slice(0, d.span[0]) + `[${d.kind.toUpperCase()}]` + out.slice(d.span[1]);
  return { text: out, kinds: keep.map((d) => d.kind) };
}

export function scrubRows(rows: Row[]): { rows: Row[]; report: ScrubReport } {
  const report: ScrubReport = { masked: 0, rowsAffected: 0, byKind: {}, findings: [], detectors: [...PII_KINDS] };
  const walk = (v: unknown, path: string, row: number, hits: { n: number }): unknown => {
    if (typeof v === 'string') {
      const m = maskText(v);
      for (const k of m.kinds) {
        report.masked++;
        hits.n++;
        report.byKind[k] = (report.byKind[k] ?? 0) + 1;
        if (report.findings.length < 200) report.findings.push({ row, field: path, kind: k });
      }
      return m.text;
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`, row, hits));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Row).map(([k, x]) => [k, walk(x, path ? `${path}.${k}` : k, row, hits)]));
    return v;
  };
  const out = rows.map((r, i) => {
    const hits = { n: 0 };
    const clean = walk(r, '', i + 1, hits) as Row;
    if (hits.n) report.rowsAffected++;
    return clean;
  });
  return { rows: out, report };
}

export const sha256 = (data: Buffer | string): string => `sha256:${createHash('sha256').update(data).digest('hex')}`;

/** Row counts per split from percentages (validation and test round down; train takes the rest). */
export function splitCounts(rows: number, pct: { train: number; val: number; test: number }): { train: number; val: number; test: number } {
  const val = Math.floor((rows * pct.val) / 100);
  const test = Math.floor((rows * pct.test) / 100);
  return { train: rows - val - test, val, test };
}
