import { describe, expect, it } from 'vitest';
import { zipEntries } from '../src/knowledge/extract.js';
import { zip } from '../src/platform/zip-writer.js';
import { DOC_LIMITS, DocumentError, type Cell, type Sheet, type Workbook } from '../src/files/documents/model.js';
import { inferColumns, inferColumnType, normalizeSheet, parseDate, parseNumber, validateNormalizeOptions } from '../src/files/documents/normalize.js';
import { csvToWorkbook, fromOdfFormula, odsToWorkbook, toOdfFormula, validateWorkbook, workbookToCsv, workbookToOds, workbookToXlsx, xlsxToWorkbook } from '../src/files/documents/sheets.js';

/*
 * Editable spreadsheets (2.0.0, file management): CSV, xlsx and ods read into the Workbook model and written back,
 * workbook validation, column type inference and normalising.
 */

const values = (s: Sheet) => s.rows.map((r) => r.map((c) => c.v));
const cells = (rows: (string | number | boolean | null)[][]): Cell[][] => rows.map((r) => r.map((v) => ({ v })));
const part = (buf: Buffer, name: string) => zipEntries(buf).get(name)!().toString('utf8');

describe('CSV', () => {
  it('reads quoted fields, doubled quotes, line breaks in quotes, CRLF and a BOM', () => {
    const { workbook, delimiter } = csvToWorkbook('﻿name,note\r\n"Ann ""A"" Lee","line one\nline two"\r\nBob,,\r\n');
    expect(delimiter).toBe(',');
    const s = workbook.sheets[0]!;
    expect(s.name).toBe('Sheet1');
    expect(s.header).toBe(true);
    expect(values(s)).toEqual([
      ['name', 'note'],
      ['Ann "A" Lee', 'line one\nline two'],
      ['Bob', '', '']
    ]);
    expect(s.columns.map((c) => c.name)).toEqual(['name', 'note', 'C']);
  });

  it('keeps a trailing empty field and does not add a row for the final line end', () => {
    expect(values(csvToWorkbook('a,b,\n1,2,\n').workbook.sheets[0]!)).toEqual([
      ['a', 'b', ''],
      ['1', '2', '']
    ]);
    expect(csvToWorkbook('').workbook.sheets[0]!.rows).toEqual([]);
  });

  it('sniffs the delimiter from the first lines, quotes aside', () => {
    expect(csvToWorkbook('a;b;c\n1;2;3\n').delimiter).toBe(';');
    expect(csvToWorkbook('a\tb\n"x,y"\t2\n').delimiter).toBe('\t');
    expect(csvToWorkbook('a|b\n1|2\n').delimiter).toBe('|');
    expect(csvToWorkbook('"a;b",c\n"1;2",3\n').delimiter).toBe(',');
    expect(csvToWorkbook('a,b\n1,2', { delimiter: ';' }).workbook.sheets[0]!.rows[0]![0]!.v).toBe('a,b');
  });

  it('infers column types from the data rows', () => {
    const s = csvToWorkbook('id,price,when,ok,mail\n1,"1,200.50",2024-03-01,yes,a@b.org\n2,3.5,2024-03-02,no,c@d.org\n').workbook.sheets[0]!;
    expect(s.columns.map((c) => c.type)).toEqual(['integer', 'number', 'date', 'boolean', 'email']);
  });

  it('writes what it reads (round trip), quoting only when needed', () => {
    const text = 'name,note,n\r\n"A, B","say ""hi""",1\r\nplain,"two\nlines",=SUM(A1)\r\n';
    const s = csvToWorkbook(text).workbook.sheets[0]!;
    expect(workbookToCsv(s)).toBe(text);
    expect(workbookToCsv({ ...s, rows: [[{ v: 1e-7 }, { v: true }, { v: null }, { v: 12.5 }]] })).toBe('0.0000001,true,,12.5\r\n');
    expect(workbookToCsv(s, ';')).toContain('A, B;');
  });

  it('refuses a file past the limits', () => {
    expect(() => csvToWorkbook(Array.from({ length: DOC_LIMITS.maxColumns + 1 }, () => 'x').join(','))).toThrow(DocumentError);
    expect(() => csvToWorkbook(`"${'x'.repeat(DOC_LIMITS.maxCellChars + 1)}"`)).toThrow(DocumentError);
  });
});

describe('xlsx', () => {
  const book: Workbook = {
    sheets: [
      {
        name: 'Sales',
        header: true,
        columns: [
          { name: 'Item', type: 'text', width: 20 },
          { name: 'Qty', type: 'integer' },
          { name: 'Price', type: 'number' },
          { name: 'Day', type: 'date' },
          { name: 'At', type: 'datetime' },
          { name: 'Paid', type: 'boolean' }
        ],
        rows: [
          [{ v: 'Item' }, { v: 'Qty' }, { v: 'Price' }, { v: 'Day' }, { v: 'At' }, { v: 'Paid' }],
          [{ v: 'Tea  & <cake>', b: true }, { v: 2 }, { v: 3.25, i: true }, { v: '2024-03-01' }, { v: '2024-03-01T10:30:00' }, { v: true }],
          [{ v: ' lead' }, { v: 5, f: 'B2+3' }, { v: null, f: 'SUM(C2:C2)' }, { v: null }, { v: null }, { v: false }]
        ]
      },
      { name: 'Notes', header: false, columns: [], rows: [[{ v: 'line one\nline two' }]] }
    ]
  };

  it('round trips strings, numbers, booleans, formulas, bold and italic, widths, dates and sheets', () => {
    const buf = workbookToXlsx(book);
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(part(buf, 'xl/worksheets/sheet1.xml')).toContain('<f>B2+3</f>');
    expect(part(buf, 'xl/workbook.xml')).toContain('fullCalcOnLoad="1"');
    const { workbook, notes } = xlsxToWorkbook(buf);
    expect(notes).toEqual([]);
    expect(workbook.sheets.map((s) => s.name)).toEqual(['Sales', 'Notes']);
    const s = workbook.sheets[0]!;
    expect(s.header).toBe(true);
    expect(values(s)).toEqual([
      ['Item', 'Qty', 'Price', 'Day', 'At', 'Paid'],
      ['Tea  & <cake>', 2, 3.25, '2024-03-01', '2024-03-01T10:30:00', true],
      [' lead', 5, null, null, null, false]
    ]);
    expect(s.rows[1]![0]!.b).toBe(true);
    expect(s.rows[1]![2]!.i).toBe(true);
    // The header row is written bold.
    expect(s.rows[0]!.every((c) => c.b)).toBe(true);
    expect(s.rows[2]![1]).toEqual({ v: 5, f: 'B2+3' });
    expect(s.rows[2]![2]).toEqual({ v: null, f: 'SUM(C2:C2)' });
    expect(s.columns[0]!.width).toBe(20);
    expect(s.columns.map((c) => c.type).slice(1, 4)).toEqual(['integer', 'number', 'date']);
    expect(values(workbook.sheets[1]!)).toEqual([['line one\nline two']]);
    expect(workbook.sheets[1]!.header).toBe(false);
  });

  it('reads a workbook written elsewhere: shared and inline strings, sparse cells, errors, shared formulas, merged cells', () => {
    const x = (s: string) => `<?xml version="1.0" encoding="UTF-8"?>\n${s}`;
    const buf = zip([
      { name: 'xl/workbook.xml', data: x('<x:workbook xmlns:x="m" xmlns:r="r"><x:sheets><x:sheet name="Data" sheetId="1" r:id="rId1"/><x:sheet name="Old" sheetId="2" r:id="rId2" state="hidden"/></x:sheets></x:workbook>') },
      { name: 'xl/_rels/workbook.xml.rels', data: x('<Relationships><Relationship Id="rId1" Target="worksheets/a.xml"/><Relationship Id="rId2" Target="/xl/worksheets/b.xml"/></Relationships>') },
      { name: 'xl/sharedStrings.xml', data: x('<sst><si><t>Name</t></si><si><r><t>Ri</t></r><r><t xml:space="preserve">ch </t></r><rPh><t>skip</t></rPh></si></sst>') },
      { name: 'xl/styles.xml', data: x('<styleSheet><numFmts><numFmt numFmtId="170" formatCode="d/m/yyyy"/></numFmts><fonts><font/><font><b/></font></fonts><cellXfs><xf numFmtId="0" fontId="0"/><xf numFmtId="170" fontId="1"/></cellXfs></styleSheet>') },
      {
        name: 'xl/worksheets/a.xml',
        data: x(
          '<x:worksheet xmlns:x="m"><x:cols><x:col min="2" max="3" width="14.5"/></x:cols><x:sheetData>' +
            '<x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="C1" t="inlineStr"><x:is><x:t>Inline &amp; more</x:t></x:is></x:c></x:row>' +
            '<x:row r="3"><x:c r="B3" t="s"><x:v>1</x:v></x:c><x:c r="C3" s="1"><x:v>45352</x:v></x:c><x:c r="D3" t="e"><x:v>#DIV/0!</x:v></x:c>' +
            '<x:c r="E3"><x:f t="shared" ref="E3:E4" si="0">C3*2</x:f><x:v>90704</x:v></x:c></x:row>' +
            '<x:row r="4"><x:c r="E4"><x:f t="shared" si="0"/><x:v>7</x:v></x:c><x:c r="F4" t="b"><x:v>1</x:v></x:c></x:row>' +
            '</x:sheetData><x:mergeCells count="1"><x:mergeCell ref="A1:B1"/></x:mergeCells><x:drawing r:id="d"/></x:worksheet>'
        )
      },
      { name: 'xl/worksheets/b.xml', data: x('<worksheet><sheetData><row><c><v>1</v></c><c><v>2</v></c></row></sheetData></worksheet>') }
    ]);
    const { workbook, notes } = xlsxToWorkbook(buf);
    const [a, b] = workbook.sheets;
    expect(a!.header).toBe(false);
    expect(values(a!)).toEqual([['Name', null, 'Inline & more'], [], [null, 'Rich ', '2024-03-01', '#DIV/0!', 90704], [null, null, null, null, 7, true]]);
    expect(a!.rows[2]![2]!.b).toBe(true);
    expect(a!.rows[2]![4]!.f).toBe('C3*2');
    expect(a!.rows[3]![4]!.f).toBeUndefined();
    expect(a!.columns.map((c) => c.width)).toEqual([undefined, 14.5, 14.5, undefined, undefined, undefined]);
    expect(values(b!)).toEqual([[1, 2]]);
    expect(notes.join(' ')).toMatch(/hidden/);
    expect(notes.join(' ')).toMatch(/Merged cells/);
    expect(notes.join(' ')).toMatch(/Charts, images/);
    expect(notes.join(' ')).toMatch(/shared formulas/);
  });

  it('refuses a DOCTYPE, a file that is not a workbook, and a cell past the column limit', () => {
    const bomb = zip([{ name: 'xl/workbook.xml', data: '<!DOCTYPE x [<!ENTITY a "aaaa">]><workbook><sheets/></workbook>' }]);
    expect(() => xlsxToWorkbook(bomb)).toThrow(/DOCTYPE/);
    expect(() => xlsxToWorkbook(Buffer.from('not a zip'))).toThrow(DocumentError);
    expect(() => xlsxToWorkbook(zip([{ name: 'a.txt', data: 'x' }]))).toThrow(/no xl\/workbook.xml/);
    const wide = zip([
      { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="S"/></sheets></workbook>' },
      { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData><row r="1"><c r="ZZZ1"><v>1</v></c></row></sheetData></worksheet>' }
    ]);
    expect(() => xlsxToWorkbook(wide)).toThrow(/columns/);
  });
});

describe('ods', () => {
  it('converts formulas between OpenFormula and spreadsheet notation', () => {
    expect(fromOdfFormula('of:=SUM([.A1:.A3];[$Sheet2.B1])')).toBe('SUM(A1:A3,Sheet2!B1)');
    expect(fromOdfFormula("of:=[$'My Sheet'.$A$1]*2")).toBe("'My Sheet'!$A$1*2");
    expect(toOdfFormula('SUM(A1:A3,Sheet2!B1)')).toBe('of:=SUM([.A1:.A3];[$Sheet2.B1])');
    expect(toOdfFormula('IF(A1>0,"a,b",LOG10(B2))')).toBe('of:=IF([.A1]>0;"a,b";LOG10([.B2]))');
    for (const f of ['SUM(A1:A3)', 'IF($A$1>0,"x;y",B2*2)', "'My Sheet'!C3+1"]) expect(fromOdfFormula(toOdfFormula(f))).toBe(f);
  });

  it('round trips values, formulas, styles, widths, spaces and several sheets', () => {
    const wb: Workbook = {
      sheets: [
        {
          name: 'Budget',
          header: true,
          columns: [
            { name: 'Item', type: 'text', width: 12 },
            { name: 'Cost', type: 'number' },
            { name: 'Due', type: 'date' },
            { name: 'Done', type: 'boolean' }
          ],
          rows: [
            [{ v: 'Item' }, { v: 'Cost' }, { v: 'Due' }, { v: 'Done' }],
            [{ v: '  two  spaces\tand tab', i: true }, { v: 10.5, b: true }, { v: '2024-05-06' }, { v: false }],
            [{ v: 'line\nbreak' }, { v: 21, f: 'B2*2' }, { v: null }, { v: true }],
            [],
            [{ v: null }, { v: null }, { v: 'end' }]
          ]
        },
        { name: 'Other', header: false, columns: [], rows: [[{ v: 'x' }]] }
      ]
    };
    const buf = workbookToOds(wb);
    const entries = zipEntries(buf);
    expect([...entries.keys()][0]).toBe('mimetype');
    expect(entries.get('mimetype')!().toString()).toBe('application/vnd.oasis.opendocument.spreadsheet');
    expect(part(buf, 'content.xml')).toContain('table:formula="of:=[.B2]*2"');
    const { workbook, notes } = odsToWorkbook(buf);
    expect(notes).toEqual([]);
    const s = workbook.sheets[0]!;
    expect(values(s)).toEqual([
      ['Item', 'Cost', 'Due', 'Done'],
      ['  two  spaces\tand tab', 10.5, '2024-05-06', false],
      ['line\nbreak', 21, null, true],
      [],
      [null, null, 'end']
    ]);
    expect(s.rows[2]![1]!.f).toBe('B2*2');
    expect(s.rows[1]![0]!.i).toBe(true);
    expect(s.rows[1]![1]!.b).toBe(true);
    expect(s.columns[0]!.width).toBeCloseTo(12, 1);
    expect(workbook.sheets[1]!.name).toBe('Other');
  });

  it('expands repeated cells and rows only where something follows, and notes covered cells', () => {
    const content =
      '<?xml version="1.0"?><office:document-content xmlns:office="o" xmlns:table="t" xmlns:text="x"><office:body><office:spreadsheet><table:table table:name="R">' +
      '<table:table-row><table:table-cell office:value-type="float" office:value="1" table:number-columns-repeated="3"/><table:table-cell table:number-columns-repeated="1000"/></table:table-row>' +
      '<table:table-row table:number-rows-repeated="2"><table:table-cell table:number-columns-repeated="5"/></table:table-row>' +
      '<table:table-row><table:table-cell table:number-columns-repeated="2"/><table:table-cell office:value-type="string"><text:p>a<text:s text:c="2"/>b</text:p><text:p>c</text:p></table:table-cell><table:covered-table-cell/></table:table-row>' +
      '<table:table-row table:number-rows-repeated="1048000"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>' +
      '</table:table></office:spreadsheet></office:body></office:document-content>';
    const { workbook, notes } = odsToWorkbook(zip([{ name: 'mimetype', data: 'application/vnd.oasis.opendocument.spreadsheet', store: true }, { name: 'content.xml', data: content }]));
    expect(values(workbook.sheets[0]!)).toEqual([[1, 1, 1], [], [], [null, null, 'a  b\nc']]);
    expect(notes.join(' ')).toMatch(/Merged cells/);
  });

  it('refuses another OpenDocument type and repeats past the limits', () => {
    expect(() => odsToWorkbook(zip([{ name: 'mimetype', data: 'application/vnd.oasis.opendocument.text', store: true }, { name: 'content.xml', data: '<x/>' }]))).toThrow(/not an OpenDocument spreadsheet|opendocument.text/);
    const big = '<office:document-content><office:body><office:spreadsheet><table:table><table:table-row table:number-rows-repeated="1000000"><table:table-cell office:value-type="float" office:value="1"/></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>';
    expect(() => odsToWorkbook(zip([{ name: 'content.xml', data: big }]))).toThrow(DocumentError);
  });
});

describe('validateWorkbook', () => {
  const ok: Workbook = { sheets: [{ name: 'S', header: true, columns: [{ name: 'a', type: 'text' }], rows: [[{ v: 'a' }]] }] };
  it('accepts a model and refuses bad shapes, types, names and sizes', () => {
    expect(validateWorkbook(ok)).toEqual(ok);
    expect(() => validateWorkbook({ sheets: [] })).toThrow(DocumentError);
    expect(() => validateWorkbook({ sheets: [{ ...ok.sheets[0], columns: [{ name: 'a', type: 'money' }] }] })).toThrow(/columns/);
    expect(() => validateWorkbook({ sheets: [{ ...ok.sheets[0], rows: [[{ v: {} }]] }] })).toThrow(DocumentError);
    expect(() => validateWorkbook({ sheets: [{ ...ok.sheets[0], rows: [[{ v: 'x', extra: 1 }]] }] })).toThrow(DocumentError);
    expect(() => validateWorkbook({ sheets: [{ ...ok.sheets[0], name: 'a/b' }] })).toThrow(/sheet name/);
    expect(() => validateWorkbook({ sheets: [ok.sheets[0], { ...ok.sheets[0], name: 's' }] })).toThrow(/Two sheets/);
    expect(() => validateWorkbook({ sheets: [{ ...ok.sheets[0], name: 'x'.repeat(32) }] })).toThrow(DocumentError);
    const many = Array.from({ length: 3 }, (_, i) => ({ name: `S${i}`, header: false, columns: [], rows: Array.from({ length: 200 }, () => Array.from({ length: 1000 }, () => ({ v: 1 }))) }));
    expect(() => validateWorkbook({ sheets: many })).toThrow(/cells/);
  });
});

describe('column types', () => {
  it('infers each type when at least 90% of the values read as it', () => {
    expect(inferColumnType(['1', '2', '-3', '1,000'])).toBe('integer');
    expect(inferColumnType(['1.5', '2', '$3.20', '(4)'])).toBe('number');
    expect(inferColumnType(['007', '012'])).toBe('text');
    expect(inferColumnType(['0', '1', '1'])).toBe('integer');
    expect(inferColumnType(['yes', 'no', 'Y'])).toBe('boolean');
    expect(inferColumnType(['2024-03-01', '01/02/2024', '12 Mar 2024', 'Mar 12, 2024'])).toBe('date');
    expect(inferColumnType(['2024-03-01 10:00', '2024-03-02T11:30:15Z'])).toBe('datetime');
    expect(inferColumnType(['a@b.org', 'c.d@e.co.uk'])).toBe('email');
    expect(inferColumnType(['https://x.org/a', 'www.y.com'])).toBe('url');
    expect(inferColumnType(Array.from({ length: 10 }, (_, i) => (i === 9 ? 'n/a' : String(i + 2))))).toBe('integer');
    expect(inferColumnType(['1', 'x', 'y'])).toBe('text');
    expect(inferColumnType(['', null, ' '])).toBe('text');
    expect(inferColumnType([1, 2.5, null])).toBe('number');
    expect(inferColumnType([true, false])).toBe('boolean');
  });

  it('reads numbers and dates written by people', () => {
    expect(parseNumber('1.234,56')).toBe(1234.56);
    expect(parseNumber('€ 12')).toBe(12);
    expect(parseNumber('(1,000)')).toBe(-1000);
    expect(parseNumber('12abc')).toBeNull();
    expect(parseDate('03/04/2024')).toBe('2024-03-04');
    expect(parseDate('03/04/2024', true)).toBe('2024-04-03');
    expect(parseDate('31/04/2024')).toBeNull();
    expect(parseDate('13/04/2024')).toBe('2024-04-13');
  });

  it('names columns from the header, keeps widths and required flags', () => {
    const cols = inferColumns({ name: 'S', header: true, columns: [{ name: 'old', type: 'text', width: 9, required: true }], rows: cells([['Qty', ''], ['1', 'x']]) });
    expect(cols).toEqual([
      { name: 'Qty', type: 'integer', width: 9, required: true },
      { name: 'B', type: 'text' }
    ]);
  });
});

describe('normalizeSheet', () => {
  const sheet = (rows: (string | number | boolean | null)[][], columns: Sheet['columns'] = []): Sheet => ({ name: 'S', header: true, columns, rows: cells(rows) });

  it('trims, collapses spaces, clears empty markers and converts to the column types', () => {
    const s = sheet(
      [
        ['Name', 'Amount', 'Day', 'Ok', 'Mail'],
        ['  Ann   Lee ', '1,200', '03/04/2024', 'yes', 'ANN@X.ORG'],
        ['Bob', 'N/A', '2024-05-06', 'n', 'b@x.org'],
        ['Cy', 'lots', 'soon', 'maybe', 'nope']
      ],
      [
        { name: 'Name', type: 'text' },
        { name: 'Amount', type: 'number' },
        { name: 'Day', type: 'date' },
        { name: 'Ok', type: 'boolean' },
        { name: 'Mail', type: 'email' }
      ]
    );
    const before = JSON.stringify(s);
    const { sheet: out, report } = normalizeSheet(s);
    expect(JSON.stringify(s)).toBe(before);
    expect(values(out)).toEqual([
      ['Name', 'Amount', 'Day', 'Ok', 'Mail'],
      ['Ann Lee', 1200, '2024-03-04', true, 'ann@x.org'],
      ['Bob', '', '2024-05-06', false, 'b@x.org'],
      ['Cy', 'lots', 'soon', 'maybe', 'nope']
    ]);
    expect(report.changedCells).toBe(7);
    expect(report.invalidCount).toBe(4);
    expect(report.invalid.map((x) => [x.row, x.col, x.reason])).toEqual([
      [3, 1, 'not a number'],
      [3, 2, 'not a date'],
      [3, 3, 'not true or false'],
      [3, 4, 'not an email address']
    ]);
    expect(normalizeSheet(s, { dayFirst: true }).sheet.rows[1]![2]!.v).toBe('2024-04-03');
    expect(normalizeSheet(s, { coerce: false }).sheet.rows[1]![1]!.v).toBe('1,200');
  });

  it('turns percentages into fractions only when the whole column is written with %', () => {
    const all = normalizeSheet(sheet([['p'], ['50%'], ['12.5%']], [{ name: 'p', type: 'number' }])).sheet;
    expect(values(all).slice(1)).toEqual([[0.5], [0.125]]);
    const mixed = normalizeSheet(sheet([['p'], ['50%'], ['3']], [{ name: 'p', type: 'number' }])).sheet;
    expect(values(mixed).slice(1)).toEqual([[50], [3]]);
  });

  it('removes empty and duplicate rows and empty columns, pads ragged rows, and places problems in the result', () => {
    const s = sheet(
      [
        ['a', 'b', 'c'],
        ['1', '', 'x'],
        ['', '', ''],
        ['1', '', 'x'],
        ['zz'],
        ['2', '', 'q']
      ],
      [
        { name: 'a', type: 'integer' },
        { name: 'b', type: 'text' },
        { name: 'c', type: 'text' }
      ]
    );
    const { sheet: out, report } = normalizeSheet(s, { dedupe: true, removeEmptyColumns: true });
    expect(values(out)).toEqual([
      ['a', 'c'],
      ['1', 'x'],
      ['zz', null],
      ['2', 'q']
    ].map((r, i) => (i === 0 ? r : [i === 2 ? 'zz' : Number(r[0]), r[1]])));
    expect(out.columns.map((c) => c.name)).toEqual(['a', 'c']);
    expect(report.removedRows).toBe(1);
    expect(report.duplicateRows).toBe(1);
    expect(report.removedColumns).toBe(1);
    expect(report.invalid).toEqual([{ row: 2, col: 0, column: 'a', value: 'zz', reason: 'not a number' }]);
    expect(normalizeSheet(s, { removeEmptyRows: false, padRows: false }).sheet.rows[4]).toHaveLength(1);
  });

  it('changes the case of text and headers, reports required cells, and leaves formulas alone', () => {
    const s: Sheet = {
      name: 'S',
      header: true,
      columns: [
        { name: 'Full Name', type: 'text', required: true },
        { name: 'totalCost', type: 'number' }
      ],
      rows: [[{ v: 'Full Name' }, { v: 'totalCost' }], [{ v: 'ann LEE' }, { v: ' 2 ', f: 'A1*2' }], [{ v: '' }, { v: '3' }]]
    };
    const { sheet: out, report } = normalizeSheet(s, { textCase: 'title', headerCase: 'snake' });
    expect(values(out)).toEqual([
      ['full_name', 'total_cost'],
      ['Ann Lee', ' 2 '],
      ['', 3]
    ]);
    expect(out.columns.map((c) => c.name)).toEqual(['full_name', 'total_cost']);
    expect(report.requiredMissing).toBe(1);
    expect(report.invalid).toEqual([{ row: 2, col: 0, column: 'full_name', value: '', reason: 'required' }]);
    expect(values(normalizeSheet(s, { textCase: 'upper', headerCase: 'title' }).sheet)[0]).toEqual(['Full Name', 'Totalcost']);
  });

  it('validates its options strictly', () => {
    expect(validateNormalizeOptions({ dedupe: true, textCase: 'lower' })).toEqual({ dedupe: true, textCase: 'lower' });
    expect(validateNormalizeOptions(undefined)).toEqual({});
    expect(() => validateNormalizeOptions({ textCase: 'shout' })).toThrow();
    expect(() => validateNormalizeOptions({ unknown: true })).toThrow();
  });
});
