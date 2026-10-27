import { zip } from '../src/platform/zip-writer.js';

/*
 * Sprint 45 (B-127): workbooks built in memory for the spreadsheet import tests (and, written to disk by
 * `e2e/tests/fixtures/`, the console test). Cells are inline strings, numbers, booleans, or `{ date: serial }` with a
 * date style; rows start at `startRow`.
 */

export type Cell = string | number | boolean | null | { date: number };
export interface SheetSpec {
  name: string;
  rows: Cell[][];
  startRow?: number;
  hidden?: boolean;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const letters = (i: number): string => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

export function sheetXml(rows: Cell[][], startRow = 1): string {
  const body = rows
    .map((cells, i) => {
      const r = startRow + i;
      const cs = cells
        .map((c, j) => {
          const ref = `${letters(j)}${r}`;
          if (c == null) return '';
          if (typeof c === 'number') return `<c r="${ref}"><v>${c}</v></c>`;
          if (typeof c === 'boolean') return `<c r="${ref}" t="b"><v>${c ? 1 : 0}</v></c>`;
          if (typeof c === 'object') return `<c r="${ref}" s="1"><v>${c.date}</v></c>`;
          return `<c r="${ref}" t="inlineStr"><is><t>${esc(c)}</t></is></c>`;
        })
        .join('');
      return `<row r="${r}">${cs}</row>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

export function xlsx(sheets: SheetSpec[], raw: Record<string, string> = {}): Buffer {
  const files: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
    'xl/styles.xml': '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>'
  };
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(s.rows, s.startRow ?? 1);
  });
  return zip(Object.entries({ ...files, ...raw }).map(([name, data]) => ({ name, data })));
}

/** The orders workbook: a cover sheet, then "Orders" whose header is on row 3 under a title. */
export function ordersWorkbook(): Buffer {
  return xlsx([
    { name: 'Cover', rows: [['Quarterly orders'], ['Prepared for the import test']] },
    {
      name: 'Orders',
      startRow: 1,
      rows: [
        ['Orders, Q3 2026'],
        [null],
        ['Order ref', 'Customer', 'Amount', 'Placed', 'Paid', 'Region'],
        ['A-100', 'Contoso', 120.5, { date: 46280 }, true, 'EMEA'],
        ['A-101', 'Fabrikam', 80, { date: 46281 }, false, 'APAC'],
        ['A-102', 'Northwind', 15.25, { date: 46282 }, true, 'EMEA']
      ]
    }
  ]);
}

/** A workbook whose one sheet unpacks to far more than it weighs (repeated rows deflate to almost nothing). */
export function bombWorkbook(rows = 40_000): Buffer {
  const big: Cell[][] = [['a', 'b']];
  for (let i = 0; i < rows; i++) big.push(['xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy']);
  return xlsx([{ name: 'Big', rows: big }]);
}
