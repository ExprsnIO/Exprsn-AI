/*
 * Editable documents in the file store (2.0.0, file management). A document is read from a file's current version into
 * one of two JSON models, edited in the console, and written back as a new version of the file, which goes through
 * quarantine and the scan like any upload. Nothing here touches storage: the converters are pure functions of bytes and
 * models (`markdown.ts`, `odt.ts`, `sheets.ts`, `normalize.ts`); `service.ts` reads and writes the file store.
 *
 * - RichDoc: Markdown and OpenDocument text (`.odt`). Blocks of runs; a run is text with inline marks. The console
 *   draws it as DOM nodes (never as HTML from the server), so no stored markup ever runs in the console.
 * - Workbook: CSV, Excel (`.xlsx`) and OpenDocument spreadsheets (`.ods`). Sheets of rows of cells; a cell has a value
 *   and may have a formula and bold or italic. CSV is one sheet whose first row is the header.
 *
 * A conversion that cannot keep something (an image in an ODT, a merged cell, a chart) keeps the text and says so in
 * `notes`, which the console shows before the first save.
 */

// ---------- rich text ----------

export interface Run {
  text: string;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  /** Struck through. */
  s?: boolean;
  /** Inline code. */
  code?: boolean;
  /** A link: http, https or mailto only (anything else is dropped to plain text by `safeHref`). */
  href?: string;
}

export interface ListItem {
  runs: Run[];
  /** A task list item: true or false; absent for an ordinary item. */
  checked?: boolean;
  /** A nested list under this item. */
  children?: { ordered: boolean; items: ListItem[] };
}

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; runs: Run[] }
  | { type: 'paragraph'; runs: Run[] }
  | { type: 'list'; ordered: boolean; start?: number; items: ListItem[] }
  | { type: 'quote'; runs: Run[] }
  | { type: 'code'; lang?: string; text: string }
  /** `rows[r][c]` is a cell's runs; the first row is a header row when `header` is true. */
  | { type: 'table'; header: boolean; rows: Run[][][] }
  | { type: 'hr' };

export interface RichDoc {
  blocks: Block[];
}

// ---------- spreadsheets ----------

export type CellValue = string | number | boolean | null;

export interface Cell {
  /** The value shown (for a formula, its last computed value when the file had one, else null). */
  v: CellValue;
  /** A formula without its leading `=`, as Excel writes it (`SUM(A1:A3)`). */
  f?: string;
  b?: boolean;
  i?: boolean;
}

export const COLUMN_TYPES = ['text', 'number', 'integer', 'date', 'datetime', 'boolean', 'email', 'url'] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

export interface Column {
  /** For a sheet with a header row, the header cell's text; otherwise the column's letter. */
  name: string;
  type: ColumnType;
  /** Width in characters (spreadsheets only). */
  width?: number;
  /** Normalising reports an empty cell in a required column. */
  required?: boolean;
}

export interface Sheet {
  name: string;
  /** Row 0 holds the column names (always true for CSV). */
  header: boolean;
  /** One per column, in order; may be shorter than the widest row (missing ones are `text`). */
  columns: Column[];
  /** Every row of the grid, the header row included when `header` is true. Rows may be ragged. */
  rows: Cell[][];
}

export interface Workbook {
  sheets: Sheet[];
}

// ---------- kinds and limits ----------

/** `xls` (Excel 97-2003) is read only: it opens in the editor and is saved as an .xlsx copy (`xls.ts`). */
export const DOC_KINDS = ['markdown', 'text', 'csv', 'xlsx', 'ods', 'odt', 'xls'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export const MIME = {
  markdown: 'text/markdown',
  text: 'text/plain',
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odt: 'application/vnd.oasis.opendocument.text',
  xls: 'application/vnd.ms-excel'
} as const satisfies Record<DocKind, string>;

export const EXT: Record<DocKind, string> = { markdown: '.md', text: '.txt', csv: '.csv', xlsx: '.xlsx', ods: '.ods', odt: '.odt', xls: '.xls' };

/** What a document may hold, checked on every read and write (413 past them). */
export const DOC_LIMITS = {
  /** Bytes of the stored file that are read to open it. */
  maxBytes: 16 * 1024 * 1024,
  /** Characters of Markdown or plain text. */
  maxChars: 4_000_000,
  maxBlocks: 50_000,
  maxSheets: 50,
  maxCells: 500_000,
  maxColumns: 1_000,
  maxCellChars: 32_767
};

/** Text-like kinds go through the text editor as well as their own. */
export const isSheetKind = (k: DocKind): k is 'csv' | 'xlsx' | 'ods' | 'xls' => k === 'csv' || k === 'xlsx' || k === 'ods' || k === 'xls';
/** Kinds read here but never written back: a save goes to a copy of `saveKindOf` instead. */
export const saveKindOf = (k: DocKind): DocKind => (k === 'xls' ? 'xlsx' : k);
export const isRichKind = (k: DocKind): k is 'markdown' | 'odt' => k === 'markdown' || k === 'odt';

/** A link target a document may keep: http, https and mailto. */
export function safeHref(href: string | undefined | null): string | undefined {
  if (!href) return undefined;
  const h = href.trim();
  return /^(https?:\/\/|mailto:)/i.test(h) && h.length <= 2048 ? h : undefined;
}

/** The kind of a stored file from its detected type and name, or null when it is not editable here. */
export function kindOf(type: string | null, name: string): DocKind | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (type === MIME.xlsx) return 'xlsx';
  if (type === MIME.ods) return 'ods';
  if (type === MIME.odt) return 'odt';
  if (type === MIME.xls) return 'xls';
  if (type === 'text/csv' || ((type === 'text/plain' || type == null) && (ext === 'csv' || ext === 'tsv'))) return 'csv';
  if (type === 'text/markdown' || ((type === 'text/plain' || type == null) && (ext === 'md' || ext === 'markdown'))) return 'markdown';
  if (type === 'text/plain') return 'text';
  return null;
}

/** An error in a document's content (400 to the caller): a model that breaks the limits or bytes that cannot be read. */
export class DocumentError extends Error {}

/*
 * ---------- the HTTP contract (routes/files-documents.ts) ----------
 *
 * GET  /api/files/:id/document
 *      → { file: fileView, kind, version, editable, saveKind, text?, doc?, workbook?, delimiter?, notes: string[] }
 *        `saveKind` is the kind a save writes: the file's own, or `xlsx` for an `.xls` file, which is saved as a copy.
 *        `text` for markdown (its source) and text; `doc` for markdown and odt; `workbook` for csv, xlsx, ods.
 *        409 while no version is ready; 415 for a type that is not editable.
 * PUT  /api/files/:id/document   { kind, baseVersion, text? | doc? | workbook?, delimiter? }
 *      → 202 { file: fileView, version: versionView }  (409 { latest } when a newer version exists than baseVersion)
 *        For markdown, `doc` wins over `text` when both are sent. The new version is scanned before the answer when
 *        it can be within a few seconds (`version.state` says ready, or quarantined/scanning while it carries on).
 * POST /api/files/documents      { name, kind, label?, folderId?, workspaceId?, text? | doc? | workbook? }
 *      → 202 { ...fileView, version } ; the name gets the kind's extension when it has none.
 * POST /api/files/document-convert  { kind: 'markdown', text } → { doc }  |  { kind: 'markdown', doc } → { text }
 * POST /api/files/table/normalize   { sheet, options } → { sheet, report }   (normalize.ts)
 * POST /api/files/table/infer       { sheet } → { columns }
 */
