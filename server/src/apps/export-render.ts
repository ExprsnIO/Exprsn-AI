import type { ExportDoc, Run } from '../chat/export-doc.js';
import { toPdf } from '../chat/export-pdf.js';
import { toXlsx, type XlsxRow, type XlsxValue } from '../imports/xlsx-writer.js';
import { cellText, type ReportCell, type ReportColumn, type ReportLine, type ReportResult } from './report-engine.js';
import { csvCell } from './service.js';

/*
 * 1.8.0 (B-123): one report result (`report-engine.ts`; records and saved views are laid out as a table result too)
 * written as XLSX (`imports/xlsx-writer.ts`: typed cells, the header frozen, widths, grouped rows bold with outline
 * levels, a second sheet saying what the file holds), PDF (the chat exports' writer, `chat/export-pdf.ts`: the page
 * setup, the header repeated on each page, a page per top-level group when asked), CSV (cells made inert for
 * spreadsheets) or HTML (one self-contained page, everything escaped, a CSP that allows nothing else).
 *
 * Masked values are written masked: the cell holds what the viewer was shown (the last four, a hash) or "(masked)".
 * Conditional formatting is carried by words and a symbol wherever colour is used, never by colour alone.
 */

export const EXPORT_FILE_FORMATS = ['xlsx', 'pdf', 'csv', 'html'] as const;
export type ExportFileFormat = (typeof EXPORT_FILE_FORMATS)[number];

export const FILE_INFO: Record<ExportFileFormat, { ext: string; type: string }> = {
  xlsx: { ext: 'xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  pdf: { ext: 'pdf', type: 'application/pdf' },
  csv: { ext: 'csv', type: 'text/csv; charset=utf-8' },
  html: { ext: 'html', type: 'text/html; charset=utf-8' }
};

export interface RenderMeta {
  /** The label of what the file holds, repeated in its footer and properties. */
  label: string;
  /** Who it was made for (their username). */
  by: string;
  /** What it was made from ("Report Pipeline by region in CRM"). */
  subtitle: string;
}

const ICON_WORD: Record<string, string> = { up: 'up', down: 'down', warn: 'warning', check: 'ok', flag: 'flagged', dot: 'note', none: '' };
const STYLE_WORD: Record<string, string> = { good: 'good', warn: 'warning', bad: 'attention', info: 'note', muted: 'low', strong: 'key' };
const ICON_GLYPH: Record<string, string> = { up: '▲', down: '▼', warn: '⚠', check: '✓', flag: '⚑', dot: '●', none: '' };

/** The words a formatting rule adds to a cell: its own text, else its icon's or style's word. */
function fmtWords(r: ReportResult, c: ReportCell): string | null {
  if (c.fmt === undefined) return null;
  const f = r.formats[c.fmt];
  if (!f) return null;
  return f.text ?? (ICON_WORD[f.icon] || STYLE_WORD[f.style] || null);
}

/** Grouped reports get a leading column for the group headers' and totals' words. */
const hasGroupColumn = (r: ReportResult) => r.layout === 'grouped';

/** A date-time as people read it in a document (CSV keeps the ISO form). */
const readable = (t: string, col: ReportColumn): string => (col.type === 'datetime' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(t) ? `${t.slice(0, 10)} ${t.slice(11, 16)}` : t);

/** The text of one line, as the columns of a flat rendering (CSV, PDF). */
function lineTexts(r: ReportResult, l: ReportLine, withFmt: boolean): string[] {
  const vals = r.columns.map((col, i) => {
    const c = l.cells[i];
    if (!c) return '';
    const t = withFmt && !c.masked ? readable(cellText(c, col), col) : cellText(c, col);
    const w = withFmt ? fmtWords(r, c) : null;
    return w ? `${t} [${w}]` : t;
  });
  if (!hasGroupColumn(r)) return vals;
  const indent = '  '.repeat(Math.max(0, l.level));
  return [l.kind === 'row' ? '' : `${indent}${l.label ?? ''}`, ...vals];
}

const headerTitles = (r: ReportResult) => [...(hasGroupColumn(r) ? ['Group'] : []), ...r.columns.map((c) => c.title)];

const paramsText = (r: ReportResult): string =>
  Object.entries(r.params)
    .map(([k, v]) => `${k}: ${v === null ? '(none)' : String(v)}`)
    .join(', ');

const rowsText = (r: ReportResult): string => `${r.rowsRead} source row${r.rowsRead === 1 ? '' : 's'}${r.truncated ? ` (truncated: more matched than the cap of ${r.rowCap})` : ''}${r.columnsFolded ? `; ${r.columnsFolded} column values added up as Other` : ''}`;

// ---------- CSV ----------

export function toCsv(r: ReportResult): Buffer {
  const out = [headerTitles(r).map(csvCell).join(',')];
  for (const l of r.lines) out.push(lineTexts(r, l, false).map(csvCell).join(','));
  return Buffer.from(`${out.join('\r\n')}\r\n`, 'utf8');
}

// ---------- XLSX ----------

function xlsxValue(c: ReportCell | undefined, col: ReportColumn): XlsxValue {
  if (!c) return null;
  if (c.masked) return c.v === null || c.v === undefined ? '(masked)' : String(c.v);
  if (c.v === null || c.v === undefined) return null;
  if (typeof c.v === 'number') return col.decimals !== undefined ? Number(c.v.toFixed(col.decimals)) : c.v;
  return c.v;
}

export function toReportXlsx(r: ReportResult, meta: RenderMeta): Buffer {
  const group = hasGroupColumn(r);
  const rows: XlsxRow[] = r.lines.map((l) => {
    const cells = r.columns.map((col, i) => xlsxValue(l.cells[i], col));
    const label = l.kind === 'row' ? null : (l.label ?? null);
    const kind = l.kind;
    // detail rows one outline level below their innermost group; group headers and subtotals at their group's level
    const level = l.kind === 'row' ? l.level : l.kind === 'total' ? 0 : l.level;
    return { cells: group ? [label, ...cells] : cells, kind, level };
  });
  const columns = [...(group ? [{ title: 'Group', type: 'text' as const }] : []), ...r.columns.map((c) => ({ title: c.title, type: c.masked ? ('text' as const) : c.type }))];
  const about: XlsxRow[] = [
    { cells: ['Title', r.title] },
    { cells: ['From', meta.subtitle] },
    ...(r.notes ? [{ cells: ['Notes', r.notes] as XlsxValue[] }] : []),
    { cells: ['Label', meta.label] },
    { cells: ['Made for', meta.by] },
    { cells: ['Generated', new Date(r.generatedAt)] },
    ...(Object.keys(r.params).length ? [{ cells: ['Parameters', paramsText(r)] as XlsxValue[] }] : []),
    { cells: ['Rows', rowsText(r)] },
    { cells: ['Truncated', r.truncated] }
  ];
  return toXlsx({
    title: r.title,
    author: meta.by,
    created: new Date(r.generatedAt),
    sheets: [
      { name: r.title.slice(0, 31) || 'Report', columns, rows, freeze: { rows: 1, cols: group ? 1 : 0 } },
      { name: 'About', columns: [{ title: 'Item', width: 14 }, { title: 'Value', width: 80, type: 'datetime' }], rows: about }
    ]
  });
}

// ---------- PDF ----------

export function reportDoc(r: ReportResult, meta: RenderMeta): ExportDoc {
  const titles = headerTitles(r);
  const header: Run[][] = titles.map((t) => [{ text: t }]);
  const group = hasGroupColumn(r);
  const align = [...(group ? ['left' as const] : []), ...r.columns.map((c) => (c.type === 'number' ? ('right' as const) : ('left' as const)))];
  // widths from the titles and the first 200 lines' text: at least the longest word (so words are not broken where
  // the page has room), at most 30 characters
  const sample = r.lines.slice(0, 200).map((l) => lineTexts(r, l, true));
  const longestWord = (s: string) => Math.max(0, ...s.split(/\s+/).map((w) => w.length));
  const widths = titles.map((t, i) => {
    const texts = [t, ...sample.map((s) => s[i] ?? '')];
    return Math.max(4, Math.min(30, Math.max(...texts.map((x) => x.length))), Math.min(16, Math.max(...texts.map(longestWord))));
  });
  const asRows = (lines: ReportLine[]) => ({
    rows: lines.map((l) => lineTexts(r, l, true).map((t) => [{ text: t, ...(l.kind !== 'row' ? { bold: true } : {}) }] as Run[])),
    shade: lines.map((l) => l.kind !== 'row')
  });
  const blocks: ExportDoc['blocks'] = [];
  if (r.notes) for (const p of r.notes.split(/\n{2,}/)) blocks.push({ kind: 'para', runs: [{ text: p }] });
  if (r.truncated) blocks.push({ kind: 'para', tone: 'muted', runs: [{ text: `Truncated: more rows matched than the report reads (${r.rowCap}). Totals cover the rows read.` }] });
  const parts: ReportLine[][] = [];
  if (group && r.page.breakGroups) {
    let cur: ReportLine[] = [];
    for (const l of r.lines) {
      if (l.kind === 'group' && l.level === 0 && cur.length) {
        parts.push(cur);
        cur = [];
      }
      cur.push(l);
    }
    if (cur.length) parts.push(cur);
  } else parts.push(r.lines);
  parts.forEach((lines, i) => {
    const t = asRows(lines);
    blocks.push({ kind: 'table', header, rows: t.rows, shade: t.shade, widths, align, repeatHeader: true, ...(i > 0 ? { breakBefore: true } : {}), ...(titles.length > 8 ? { size: 7.5 } : {}) });
  });
  if (!r.lines.length) blocks.push({ kind: 'para', tone: 'muted', runs: [{ text: 'No rows.' }] });
  return {
    title: r.title,
    meta: [['From', meta.subtitle], ['Label', meta.label], ['Made for', meta.by], ['Generated', r.generatedAt.replace('T', ' ').slice(0, 19) + ' UTC'], ...(Object.keys(r.params).length ? [['Parameters', paramsText(r)] as [string, string]] : []), ['Rows', rowsText(r)]],
    blocks,
    label: meta.label,
    author: meta.by,
    createdAt: r.generatedAt
  };
}

export function toReportPdf(r: ReportResult, meta: RenderMeta): Buffer {
  return toPdf(reportDoc(r, meta), { size: r.page.size, orientation: r.page.orientation });
}

// ---------- HTML ----------

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const HTML_STYLE =
  ':root{--fg:#1d2330;--muted:#5b6475;--line:#d5dae3;--head:#eef1f6;--sub:#f6f7fa;--good:#1d6b35;--good-bg:#e5f4ea;--warn:#7a4f00;--warn-bg:#fdf1d8;--bad:#a1232b;--bad-bg:#fbe7e8;--info:#1f4f9c;--info-bg:#e6eefb;--low:#5b6475}' +
  '@media (prefers-color-scheme:dark){:root{--fg:#e6e9ef;--muted:#a7afbf;--line:#3a4252;--head:#252b36;--sub:#1e232c;--good:#7fd69b;--good-bg:#173323;--warn:#f0c46a;--warn-bg:#3a2e12;--bad:#f2a0a5;--bad-bg:#3c1c1f;--info:#9dbcf2;--info-bg:#1a2a45;--low:#a7afbf}body{background:#14181f}}' +
  'body{font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--fg);margin:0;padding:16px}' +
  'h1{font-size:20px;margin:0 0 4px}.meta{color:var(--muted);font-size:12px;margin:0 0 12px}.notes{white-space:pre-wrap;margin:0 0 12px}' +
  '.wrap{overflow-x:auto}table{border-collapse:collapse;min-width:100%;font-size:13px}th,td{border:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}' +
  'thead th{background:var(--head)}td.num{text-align:right;font-variant-numeric:tabular-nums}tr.group th{background:var(--sub);text-align:left}' +
  'tr.subtotal td,tr.total td,tr.subtotal th,tr.total th{font-weight:600;background:var(--sub)}tr.total td,tr.total th{border-top:2px solid var(--fg)}' +
  '.masked{color:var(--muted);font-style:italic}.f{border-radius:4px;padding:0 4px}.f-good{color:var(--good);background:var(--good-bg)}.f-warn{color:var(--warn);background:var(--warn-bg)}' +
  '.f-bad{color:var(--bad);background:var(--bad-bg)}.f-info{color:var(--info);background:var(--info-bg)}.f-muted{color:var(--low)}.f-strong{font-weight:700}.ft{font-size:11px;margin-left:4px}' +
  '.note{color:var(--muted);font-size:12px;margin:8px 0}footer{color:var(--muted);font-size:11px;margin-top:12px}';

function htmlCell(r: ReportResult, c: ReportCell | undefined, col: ReportColumn): string {
  if (!c) return '<td></td>';
  const num = col.type === 'number' && !c.masked;
  const text = esc(c.masked ? cellText(c, col) : readable(cellText(c, col), col));
  if (c.masked) return `<td class="masked" title="Masked for you">${text}</td>`;
  const f = c.fmt !== undefined ? r.formats[c.fmt] : undefined;
  if (!f) return `<td${num ? ' class="num"' : ''}>${text}</td>`;
  const words = fmtWords(r, c) ?? '';
  const glyph = ICON_GLYPH[f.icon] ?? '';
  return `<td${num ? ' class="num"' : ''}><span class="f f-${f.style}">${glyph ? `<span aria-hidden="true">${glyph}</span> ` : ''}${text}</span>${words ? `<span class="ft">${esc(words)}</span>` : ''}</td>`;
}

export function toReportHtml(r: ReportResult, meta: RenderMeta): Buffer {
  const group = hasGroupColumn(r);
  const span = r.columns.length + (group ? 1 : 0);
  const head = `<tr>${headerTitles(r)
    .map((t) => `<th scope="col">${esc(t)}</th>`)
    .join('')}</tr>`;
  const body = r.lines
    .map((l) => {
      if (l.kind === 'group') return `<tr class="group"><th scope="rowgroup" colspan="${span}" style="padding-left:${8 + l.level * 16}px">${esc(l.label ?? '')} <span class="ft">${l.count ?? 0} row${l.count === 1 ? '' : 's'}</span></th></tr>`;
      const lead = group ? (l.kind === 'row' ? '<td></td>' : `<th scope="row" style="padding-left:${8 + l.level * 16}px">${esc(l.label ?? '')}</th>`) : '';
      return `<tr class="${l.kind}">${lead}${r.columns.map((col, i) => htmlCell(r, l.cells[i], col)).join('')}</tr>`;
    })
    .join('\n');
  const html =
    '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">` +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<meta name="generator" content="Exprsn-AI"><title>${esc(r.title)}</title><style>${HTML_STYLE}</style></head>\n<body><main>\n` +
    `<h1>${esc(r.title)}</h1>\n<p class="meta">${esc(meta.subtitle)} · ${esc(meta.label)} · made for ${esc(meta.by)} · ${esc(r.generatedAt.replace('T', ' ').slice(0, 19))} UTC${Object.keys(r.params).length ? ` · ${esc(paramsText(r))}` : ''}</p>\n` +
    (r.notes ? `<p class="notes">${esc(r.notes)}</p>\n` : '') +
    (r.truncated ? `<p class="note" role="note">Truncated: more rows matched than the report reads (${r.rowCap}). Totals cover the rows read.</p>\n` : '') +
    `<div class="wrap"><table><caption class="note">${esc(rowsText(r))}</caption><thead>${head}</thead><tbody>\n${body}\n</tbody></table></div>\n` +
    `<footer>Exported from Exprsn-AI. Label: ${esc(meta.label)}.</footer>\n</main></body></html>\n`;
  return Buffer.from(html, 'utf8');
}

/** The result in one of the export formats. */
export function renderReport(r: ReportResult, format: ExportFileFormat, meta: RenderMeta): Buffer {
  switch (format) {
    case 'xlsx':
      return toReportXlsx(r, meta);
    case 'pdf':
      return toReportPdf(r, meta);
    case 'csv':
      return toCsv(r);
    case 'html':
      return toReportHtml(r, meta);
  }
}
