import { zip } from '../platform/zip-writer.js';

/*
 * 1.8.0 (B-123): a small xlsx writer, the other half of `xlsx.ts` (which reads what this writes). A workbook is a zip
 * archive (`platform/zip-writer.ts`) of SpreadsheetML parts: the content types, the package and workbook relations,
 * the workbook, one styles part, the shared strings and one part per worksheet.
 *
 * Cells are typed: text as shared strings (`t="s"`), numbers as numbers, booleans as `t="b"`, dates and date-times as
 * serial numbers with a date or date-time number format, so a spreadsheet sorts and sums them. A text cell is never a
 * formula, so a value starting with `=` stays text (no formula injection, unlike CSV). Each sheet may freeze its header
 * row (and leading columns), set column widths, and mark rows as group headers, subtotals or totals: those are bold,
 * and detail rows carry an outline level so a spreadsheet can fold the groups.
 */

export type XlsxValue = string | number | boolean | Date | null | undefined;

export interface XlsxColumn {
  title: string;
  /** In characters; computed from the content when left out (8 to 60). */
  width?: number;
  /** How a string that looks like a date is written: `date` and `datetime` columns write ISO strings as dates. */
  type?: 'text' | 'number' | 'date' | 'datetime' | 'boolean';
}

export interface XlsxRow {
  cells: XlsxValue[];
  /** `group` (a group's header line), `subtotal` and `total` are bold; `row` is a detail row. */
  kind?: 'row' | 'group' | 'subtotal' | 'total';
  /** Outline level (0 to 7): detail rows of a grouped report sit one level below their group. */
  level?: number;
}

export interface XlsxSheet {
  name: string;
  columns: XlsxColumn[];
  rows: XlsxRow[];
  /** Rows and columns frozen at the top and left; the header row is frozen unless `header` is false. */
  freeze?: { rows?: number; cols?: number };
  /** Write the column titles as the first row (default true). */
  header?: boolean;
}

export interface XlsxWorkbook {
  sheets: XlsxSheet[];
  title?: string;
  author?: string;
  created?: Date;
}

/** Characters XML 1.0 does not allow (and unpaired surrogates) become U+FFFD; the five markup characters are escaped. */
// eslint-disable-next-line no-control-regex
const XML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export const xmlText = (s: string): string => s.replace(XML_BAD, '�').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A column's letters (0 → A, 26 → AA). */
export function columnName(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** A date as a spreadsheet serial number (1900 date system, UTC). */
export function dateSerial(d: Date): number {
  return d.getTime() / 86_400_000 + 25_569;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** A sheet name a spreadsheet accepts: at most 31 characters, none of []:*?/\, not empty, unique in the workbook. */
function sheetName(raw: string, taken: Set<string>): string {
  let base = raw.replace(/[[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || 'Sheet';
  let name = base;
  for (let i = 2; taken.has(name.toLowerCase()); i++) {
    const suffix = ` (${i})`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  base = name;
  taken.add(base.toLowerCase());
  return base;
}

/*
 * Styles (cellXfs): 0 general, 1 header (bold, fill, bottom border), 2 date, 3 date-time, 4 bold, 5 bold date,
 * 6 bold date-time.
 */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7ECF3"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="14" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

class SharedStrings {
  readonly list: string[] = [];
  private readonly index = new Map<string, number>();
  count = 0;
  id(s: string): number {
    this.count++;
    let i = this.index.get(s);
    if (i === undefined) {
      i = this.list.length;
      this.list.push(s);
      this.index.set(s, i);
    }
    return i;
  }
  xml(): string {
    const items = this.list.map((s) => `<si><t${/^\s|\s$|\n/.test(s) ? ' xml:space="preserve"' : ''}>${xmlText(s)}</t></si>`).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${this.count}" uniqueCount="${this.list.length}">${items}</sst>`;
  }
}

/** Text a cell holds at most (Excel's limit). */
const CELL_TEXT_MAX = 32_767;

function cellXml(ref: string, v: XlsxValue, col: XlsxColumn | undefined, bold: boolean, sst: SharedStrings): string {
  if (v === null || v === undefined || v === '') return '';
  let date: Date | null = null;
  let withTime = false;
  if (v instanceof Date) {
    date = v;
    withTime = col?.type === 'datetime' || v.getUTCHours() + v.getUTCMinutes() + v.getUTCSeconds() > 0;
  } else if (typeof v === 'string' && (col?.type === 'date' || col?.type === 'datetime')) {
    if (ISO_DATE.test(v)) date = new Date(`${v}T00:00:00Z`);
    else if (ISO_DATETIME.test(v)) {
      date = new Date(v.replace(' ', 'T'));
      withTime = true;
    }
    if (date && Number.isNaN(date.getTime())) date = null;
  }
  if (date) {
    const s = withTime ? (bold ? 6 : 3) : bold ? 5 : 2;
    return `<c r="${ref}" s="${s}"><v>${dateSerial(date)}</v></c>`;
  }
  const s = bold ? ' s="4"' : '';
  if (typeof v === 'number') return Number.isFinite(v) ? `<c r="${ref}"${s}><v>${v}</v></c>` : '';
  if (typeof v === 'boolean') return `<c r="${ref}"${s} t="b"><v>${v ? 1 : 0}</v></c>`;
  const text = String(v).slice(0, CELL_TEXT_MAX);
  return `<c r="${ref}"${s} t="s"><v>${sst.id(text)}</v></c>`;
}

/** The width a column needs for its title and its first 500 rows, in characters. */
function autoWidth(sheet: XlsxSheet, i: number): number {
  let w = sheet.columns[i]!.title.length + 2;
  for (const r of sheet.rows.slice(0, 500)) {
    const v = r.cells[i];
    const len = v == null ? 0 : v instanceof Date ? 16 : typeof v === 'number' ? String(Math.round(v * 100) / 100).length + 1 : String(v).split('\n')[0]!.length;
    if (len + 2 > w) w = len + 2;
  }
  return Math.max(8, Math.min(60, w));
}

function sheetXml(sheet: XlsxSheet, sst: SharedStrings): string {
  const header = sheet.header !== false;
  const ncols = Math.max(1, sheet.columns.length, ...sheet.rows.map((r) => r.cells.length));
  const freezeRows = sheet.freeze?.rows ?? (header ? 1 : 0);
  const freezeCols = sheet.freeze?.cols ?? 0;
  let pane = '';
  if (freezeRows || freezeCols) {
    const top = `${columnName(freezeCols)}${freezeRows + 1}`;
    const active = freezeRows && freezeCols ? 'bottomRight' : freezeRows ? 'bottomLeft' : 'topRight';
    pane = `<pane${freezeCols ? ` xSplit="${freezeCols}"` : ''}${freezeRows ? ` ySplit="${freezeRows}"` : ''} topLeftCell="${top}" activePane="${active}" state="frozen"/><selection pane="${active}" activeCell="${top}" sqref="${top}"/>`;
  }
  const maxLevel = Math.min(7, Math.max(0, ...sheet.rows.map((r) => r.level ?? 0)));
  const cols = Array.from({ length: ncols }, (_, i) => {
    const c = sheet.columns[i];
    const w = c?.width ?? (c ? autoWidth(sheet, i) : 10);
    return `<col min="${i + 1}" max="${i + 1}" width="${Math.round(w * 100) / 100}" customWidth="1"/>`;
  }).join('');
  const rows: string[] = [];
  let r = 0;
  if (header) {
    r++;
    rows.push(`<row r="${r}">${sheet.columns.map((c, i) => `<c r="${columnName(i)}${r}" s="1" t="s"><v>${sst.id(c.title.slice(0, CELL_TEXT_MAX))}</v></c>`).join('')}</row>`);
  }
  for (const row of sheet.rows) {
    r++;
    const bold = row.kind === 'group' || row.kind === 'subtotal' || row.kind === 'total';
    const level = Math.min(7, Math.max(0, Math.floor(row.level ?? 0)));
    const cells = row.cells.map((v, i) => cellXml(`${columnName(i)}${r}`, v, sheet.columns[i], bold, sst)).join('');
    rows.push(`<row r="${r}"${level ? ` outlineLevel="${level}"` : ''}>${cells}</row>`);
  }
  const lastRef = `${columnName(ncols - 1)}${Math.max(1, r)}`;
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    (maxLevel ? '<sheetPr><outlinePr summaryBelow="1"/></sheetPr>' : '') +
    `<dimension ref="A1:${lastRef}"/>` +
    `<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"${maxLevel ? ` outlineLevelRow="${maxLevel}"` : ''}/>` +
    `<cols>${cols}</cols>` +
    `<sheetData>${rows.join('')}</sheetData>` +
    (header && sheet.rows.length ? `<autoFilter ref="A1:${lastRef}"/>` : '') +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
    '</worksheet>'
  );
}

/** The workbook as xlsx bytes. */
export function toXlsx(wb: XlsxWorkbook): Buffer {
  if (!wb.sheets.length) throw new Error('A workbook has at least one sheet.');
  const sst = new SharedStrings();
  const taken = new Set<string>();
  const names = wb.sheets.map((s) => sheetName(s.name, taken));
  const sheets = wb.sheets.map((s) => sheetXml(s, sst));
  const created = (wb.created ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const n = wb.sheets.length;
  const filters = wb.sheets.map((s, i) => (s.header !== false && s.rows.length ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${names[i]!.replace(/'/g, "''")}'!$A$1:$${columnName(Math.max(1, s.columns.length) - 1)}$${s.rows.length + 1}</definedName>` : '')).join('');
  return zip([
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        wb.sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
        '</Types>'
    },
    {
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
        '</Relationships>'
    },
    {
      name: 'docProps/core.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
        `<dc:title>${xmlText(wb.title ?? '')}</dc:title><dc:creator>${xmlText(wb.author ?? '')}</dc:creator>` +
        `<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created></cp:coreProperties>`
    },
    {
      name: 'docProps/app.xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Exprsn-AI</Application></Properties>'
    },
    {
      name: 'xl/workbook.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<bookViews><workbookView/></bookViews><sheets>' +
        names.map((nm, i) => `<sheet name="${xmlText(nm)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        `</sheets>${filters ? `<definedNames>${filters}</definedNames>` : ''}</workbook>`
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        wb.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        `<Relationship Id="rId${n + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
        '</Relationships>'
    },
    { name: 'xl/styles.xml', data: STYLES },
    ...sheets.map((x, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: x })),
    // written last: the sheets add to it as they are written
    { name: 'xl/sharedStrings.xml', data: sst.xml() }
  ]);
}
