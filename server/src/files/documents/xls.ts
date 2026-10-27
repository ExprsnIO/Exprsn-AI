import { serialDate } from '../../imports/xlsx.js';
import { DOC_LIMITS, DocumentError, type Cell, type CellValue, type Sheet, type Workbook } from './model.js';
import { Budget, BUILTIN_DATE, checkText, finishSheet, isDateFormat, sheetName, tooMany } from './sheets.js';

/*
 * Legacy Excel workbooks (.xls, Excel 97 to 2003 and Excel 5.0/95), read only. The file is a Compound File (an OLE2
 * container of sectors and a FAT); the workbook is its `Workbook` stream (`Book` in Excel 5.0/95), a sequence of BIFF
 * records. What is read: sheet names, shared and inline strings, numbers, RK and MULRK numbers, booleans, errors as
 * their text, and the cached result of every formula (a formula's own tokens are not decompiled, so formulas come in
 * as values). Dates are told from the cell's number format as in xlsx. Encrypted workbooks are refused.
 *
 * Every offset is checked against the buffer and every chain is bounded by the number of sectors, so a damaged or
 * hostile file ends in a DocumentError, never a loop or a read outside the buffer. Saving goes to .xlsx (the console's
 * Save as), never back to .xls.
 */

export const XLS_MIME = 'application/vnd.ms-excel';
const MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const END = 0xfffffffe;
const FREE = 0xffffffff;
const L = DOC_LIMITS;

const bad = (what: string) => new DocumentError(`The file is not a readable Excel 97-2003 workbook: ${what}.`);

/** The Compound File signature at the start of `b` (enough to tell the type; `compoundStreams` checks the rest). */
export const hasCompoundMagic = (b: Buffer): boolean => b.length >= 8 && b.subarray(0, 8).equals(MAGIC);
export const isCompoundFile = (b: Buffer): boolean => b.length >= 512 && hasCompoundMagic(b);

// ---------- the Compound File container ----------

interface DirEntry {
  name: string;
  type: number;
  start: number;
  size: number;
}

/** The streams of a Compound File by name (lower case), each read whole on demand. */
export function compoundStreams(buf: Buffer): Map<string, () => Buffer> {
  if (!isCompoundFile(buf)) throw bad('it is not a Compound File');
  const shift = buf.readUInt16LE(0x1e);
  const miniShift = buf.readUInt16LE(0x20);
  if (shift !== 9 && shift !== 12) throw bad('its sector size is not 512 or 4096 bytes');
  if (miniShift !== 6) throw bad('its mini sector size is not 64 bytes');
  const size = 1 << shift;
  const miniSize = 1 << miniShift;
  const sectors = Math.floor((buf.length - size) / size) + (buf.length % size ? 1 : 0);
  const nFat = buf.readUInt32LE(0x2c);
  const dirStart = buf.readUInt32LE(0x30);
  const cutoff = buf.readUInt32LE(0x38);
  const miniFatStart = buf.readUInt32LE(0x3c);
  const nMiniFat = buf.readUInt32LE(0x40);
  let difatSector = buf.readUInt32LE(0x44);
  const nDifat = buf.readUInt32LE(0x48);
  if (nFat > sectors + 1 || nDifat > sectors + 1 || nMiniFat > sectors + 1) throw bad('its header counts more sectors than the file holds');

  const sectorAt = (n: number): Buffer => {
    if (n >= sectors) throw bad(`it points at sector ${n} past its end`);
    const from = (n + 1) * size;
    const s = buf.subarray(from, from + size);
    // A short last sector reads as if padded with zeros.
    return s.length === size ? s : Buffer.concat([s, Buffer.alloc(size - s.length)]);
  };

  // The FAT's own sectors: 109 in the header, the rest in the DIFAT chain.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109 && fatSectors.length < nFat; i++) fatSectors.push(buf.readUInt32LE(0x4c + i * 4));
  for (let k = 0; k < nDifat && fatSectors.length < nFat; k++) {
    if (difatSector === END || difatSector === FREE) break;
    const s = sectorAt(difatSector);
    const per = size / 4 - 1;
    for (let i = 0; i < per && fatSectors.length < nFat; i++) fatSectors.push(s.readUInt32LE(i * 4));
    difatSector = s.readUInt32LE(per * 4);
  }
  const fat = new Uint32Array(fatSectors.length * (size / 4));
  fatSectors.forEach((fs, i) => {
    const s = sectorAt(fs);
    for (let j = 0; j < size / 4; j++) fat[i * (size / 4) + j] = s.readUInt32LE(j * 4);
  });

  const chain = (start: number, table: Uint32Array, limit: number): number[] => {
    const out: number[] = [];
    for (let n = start; n !== END; ) {
      if (n === FREE || n >= table.length || out.length > limit) throw bad('a sector chain is broken');
      out.push(n);
      n = table[n]!;
    }
    return out;
  };
  const read = (start: number, len: number): Buffer => {
    if (len > L.maxBytes) throw new DocumentError(`A stream of the workbook is larger than ${L.maxBytes.toLocaleString('en-US')} bytes.`);
    const parts = chain(start, fat, sectors).map(sectorAt);
    const all = Buffer.concat(parts);
    if (all.length < len) throw bad('a stream is shorter than its directory entry says');
    return all.subarray(0, len);
  };

  // The directory: 128-byte entries in the directory chain.
  const dirBytes = Buffer.concat(chain(dirStart, fat, sectors).map(sectorAt));
  const entries: DirEntry[] = [];
  for (let off = 0; off + 128 <= dirBytes.length; off += 128) {
    const nameLen = Math.min(64, dirBytes.readUInt16LE(off + 64));
    const type = dirBytes[off + 66]!;
    const name = dirBytes.subarray(off, off + Math.max(0, nameLen - 2)).toString('utf16le');
    entries.push({ name, type, start: dirBytes.readUInt32LE(off + 116), size: dirBytes.readUInt32LE(off + 120) });
  }
  const root = entries[0];
  if (!root || root.type !== 5) throw bad('it has no root entry');

  // Small streams live in the mini stream (the root's data), in 64-byte sectors chained by the mini FAT.
  let miniFat: Uint32Array | null = null;
  let miniStream: Buffer | null = null;
  const mini = () => {
    if (!miniFat) {
      const mf = nMiniFat && miniFatStart !== END ? Buffer.concat(chain(miniFatStart, fat, sectors).map(sectorAt)) : Buffer.alloc(0);
      miniFat = new Uint32Array(mf.length / 4);
      for (let i = 0; i < miniFat.length; i++) miniFat[i] = mf.readUInt32LE(i * 4);
      miniStream = root.start === END ? Buffer.alloc(0) : read(root.start, root.size);
    }
    return { miniFat: miniFat, miniStream: miniStream! };
  };
  const readMini = (start: number, len: number): Buffer => {
    const m = mini();
    const parts = chain(start, m.miniFat, m.miniFat.length).map((n) => {
      const from = n * miniSize;
      if (from + miniSize > m.miniStream.length) throw bad('a mini sector is past the mini stream');
      return m.miniStream.subarray(from, from + miniSize);
    });
    const all = Buffer.concat(parts);
    if (all.length < len) throw bad('a stream is shorter than its directory entry says');
    return all.subarray(0, len);
  };

  const out = new Map<string, () => Buffer>();
  for (const e of entries.slice(1)) {
    if (e.type !== 2) continue;
    const { start, size: len } = e;
    out.set(e.name.toLowerCase(), () => (len < cutoff ? readMini(start, len) : read(start, len)));
  }
  return out;
}

/** True when a Compound File holds an Excel workbook (not a Word or PowerPoint file). Never throws. */
export function isXlsWorkbook(buf: Buffer): boolean {
  try {
    const s = compoundStreams(buf);
    return s.has('workbook') || s.has('book');
  } catch {
    return false;
  }
}

// ---------- BIFF records ----------

interface Rec {
  type: number;
  data: Buffer;
  /** CONTINUE records that follow it, in order. */
  cont: Buffer[];
}

const R = {
  BOF: 0x0809,
  BOF_OLD: 0x0409,
  EOF: 0x000a,
  CONTINUE: 0x003c,
  FILEPASS: 0x002f,
  DATEMODE: 0x0022,
  BOUNDSHEET: 0x0085,
  SST: 0x00fc,
  FORMAT: 0x041e,
  FORMAT_OLD: 0x001e,
  XF: 0x00e0,
  LABELSST: 0x00fd,
  LABEL: 0x0204,
  RSTRING: 0x00d6,
  NUMBER: 0x0203,
  RK: 0x027e,
  MULRK: 0x00bd,
  BOOLERR: 0x0205,
  FORMULA: 0x0006,
  STRING: 0x0207,
  MERGECELLS: 0x00e5,
  NOTE: 0x001c,
  OBJ: 0x005d
} as const;

/** The records of a stream from `at`, up to and including the EOF of that substream. */
function records(s: Buffer, at: number): Rec[] {
  const out: Rec[] = [];
  let off = at;
  while (off + 4 <= s.length) {
    const type = s.readUInt16LE(off);
    const len = s.readUInt16LE(off + 2);
    if (off + 4 + len > s.length) throw bad('a record runs past the end of the stream');
    const data = s.subarray(off + 4, off + 4 + len);
    off += 4 + len;
    if (type === R.CONTINUE && out.length) out[out.length - 1]!.cont.push(data);
    else out.push({ type, data, cont: [] });
    if (type === R.EOF) break;
  }
  return out;
}

/** Reads across a record and its CONTINUE records; a string's characters restart with a flags byte at each boundary. */
class Reader {
  private part = 0;
  private off = 0;
  constructor(private readonly parts: Buffer[]) {}
  private get cur(): Buffer {
    return this.parts[this.part]!;
  }
  private next(): void {
    if (this.part + 1 >= this.parts.length) throw bad('a record ends early');
    this.part++;
    this.off = 0;
  }
  private need(): void {
    while (this.off >= this.cur.length) this.next();
  }
  u8(): number {
    this.need();
    return this.cur[this.off++]!;
  }
  u16(): number {
    return this.u8() | (this.u8() << 8);
  }
  u32(): number {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }
  skip(n: number): void {
    for (let left = n; left > 0; ) {
      this.need();
      const take = Math.min(left, this.cur.length - this.off);
      this.off += take;
      left -= take;
    }
  }
  /** BIFF8 characters: `n` of them, one or two bytes each, the width set again at every CONTINUE boundary. */
  chars(n: number, high: boolean): string {
    let out = '';
    let wide = high;
    let left = n;
    while (left > 0) {
      if (this.off >= this.cur.length) {
        this.next();
        wide = (this.u8() & 1) === 1;
      }
      const w = wide ? 2 : 1;
      const fit = Math.min(left, Math.floor((this.cur.length - this.off) / w));
      if (fit <= 0) throw bad('a string is cut inside a character');
      const bytes = this.cur.subarray(this.off, this.off + fit * w);
      out += wide ? bytes.toString('utf16le') : bytes.toString('latin1');
      this.off += fit * w;
      left -= fit;
    }
    return out;
  }
  /** XLUnicodeRichExtendedString (SST items) or XLUnicodeString (16-bit count) in BIFF8. */
  str16(): string {
    const cch = this.u16();
    const flags = this.u8();
    const rich = flags & 0x08 ? this.u16() : 0;
    const ext = flags & 0x04 ? this.u32() : 0;
    const s = this.chars(cch, (flags & 1) === 1);
    if (rich) this.skip(rich * 4);
    if (ext) this.skip(ext);
    return s;
  }
}

const rk = (v: number): number => {
  let n: number;
  if (v & 0x02) n = v >> 2;
  else {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(0, 0);
    b.writeUInt32LE((v & 0xfffffffc) >>> 0, 4);
    n = b.readDoubleLE(0);
  }
  return v & 0x01 ? n / 100 : n;
};

const ERRORS: Record<number, string> = { 0x00: '#NULL!', 0x07: '#DIV/0!', 0x0f: '#VALUE!', 0x17: '#REF!', 0x1d: '#NAME?', 0x24: '#NUM!', 0x2a: '#N/A' };

/** A legacy Excel workbook as the Workbook model, with what it could not keep. */
export function xlsToWorkbook(buf: Buffer): { workbook: Workbook; notes: string[] } {
  const streams = compoundStreams(buf);
  const get = streams.get('workbook') ?? streams.get('book');
  if (!get) throw bad('it holds no Workbook stream (it may be a Word or PowerPoint file)');
  const s = get();
  const globals = records(s, 0);
  const bof = globals[0];
  if (!bof || (bof.type !== R.BOF && bof.type !== R.BOF_OLD) || bof.data.length < 4) throw bad('the workbook stream does not start with a BOF record');
  const version = bof.data.readUInt16LE(0);
  const biff8 = version === 0x0600;
  if (!biff8 && version !== 0x0500) throw new DocumentError('Only Excel 5.0 and later (.xls) workbooks are read here; this one is older. Open it in a spreadsheet and save it as .xlsx.');

  const notes = new Set<string>();
  if (!biff8) notes.add('An Excel 5.0/95 workbook: text is read as Western European (Windows-1252).');
  let date1904 = false;
  const formats = new Map<number, string>();
  const xfDate: boolean[] = [];
  const sst: string[] = [];
  const sheetsAt: { name: string; at: number; hidden: boolean }[] = [];
  const text8 = (b: Buffer, from: number, n: number) => b.subarray(from, from + n).toString('latin1');

  for (const r of globals) {
    switch (r.type) {
      case R.FILEPASS:
        throw new DocumentError('The workbook is protected with a password. Remove the password in a spreadsheet and upload it again.');
      case R.DATEMODE:
        date1904 = r.data.length >= 2 && r.data.readUInt16LE(0) === 1;
        break;
      case R.FORMAT:
      case R.FORMAT_OLD: {
        const rd = new Reader([r.data, ...r.cont]);
        const id = rd.u16();
        formats.set(id, biff8 ? rd.str16() : text8(r.data, 3, rd.u8()));
        break;
      }
      case R.XF: {
        if (r.data.length < 4) break;
        const fmt = r.data.readUInt16LE(2);
        const custom = formats.get(fmt);
        xfDate.push(custom != null ? isDateFormat(custom) : BUILTIN_DATE.has(fmt));
        break;
      }
      case R.BOUNDSHEET: {
        if (r.data.length < 8) break;
        const at = r.data.readUInt32LE(0);
        const hidden = (r.data[4]! & 0x03) !== 0;
        const kind = r.data[5]!;
        // A count byte, then (BIFF8) a flags byte before the characters, or (BIFF5) 8-bit characters.
        const rd = new Reader([r.data.subarray(6)]);
        const cch = rd.u8();
        const name = biff8 ? rd.chars(cch, (rd.u8() & 1) === 1) : text8(r.data, 7, cch);
        if (kind === 0) sheetsAt.push({ name, at, hidden });
        else notes.add('Chart sheets and macro sheets are left out.');
        break;
      }
      case R.SST: {
        if (!biff8) break;
        const rd = new Reader([r.data, ...r.cont]);
        rd.u32();
        const unique = rd.u32();
        if (unique > L.maxCells) throw tooMany('strings', L.maxCells);
        for (let i = 0; i < unique; i++) sst.push(rd.str16());
        break;
      }
    }
  }
  if (sheetsAt.length > L.maxSheets) throw tooMany('sheets', L.maxSheets);

  const budget = new Budget();
  const taken = new Set<string>();
  const sheets: Sheet[] = [];
  for (const sh of sheetsAt) {
    if (sh.at >= s.length) throw bad(`the sheet ${sh.name} starts past the end of the stream`);
    if (sh.hidden) notes.add(`The sheet ${sh.name} is hidden in the workbook; it is shown here.`);
    const rows: Cell[][] = [];
    const put = (r: number, c: number, v: CellValue, xf: number) => {
      if (c >= L.maxColumns) throw tooMany('columns', L.maxColumns);
      if (r >= L.maxCells) throw tooMany('rows', L.maxCells);
      if (v == null) return;
      if (typeof v === 'number' && xfDate[xf]) v = serialDate(v, date1904) ?? v;
      if (typeof v === 'string') checkText(v);
      while (rows.length <= r) rows.push([]);
      const row = rows[r]!;
      while (row.length < c) row.push({ v: null });
      if (row.length === c) budget.add(1);
      row[c] = { v };
    };
    let pendingString: { r: number; c: number; xf: number } | null = null;
    let formulas = false;
    for (const r of records(s, sh.at).slice(1)) {
      const d = r.data;
      if (pendingString && r.type !== R.STRING) pendingString = null;
      switch (r.type) {
        case R.LABELSST:
          if (d.length >= 10) put(d.readUInt16LE(0), d.readUInt16LE(2), sst[d.readUInt32LE(6)] ?? '', d.readUInt16LE(4));
          break;
        case R.LABEL:
        case R.RSTRING: {
          if (d.length < 8) break;
          let v: string;
          if (biff8) {
            const rd = new Reader([d.subarray(6), ...r.cont]);
            const cch = rd.u16();
            const fl = rd.u8();
            v = rd.chars(cch, (fl & 1) === 1);
          } else v = text8(d, 8, d.readUInt16LE(6));
          put(d.readUInt16LE(0), d.readUInt16LE(2), v, d.readUInt16LE(4));
          break;
        }
        case R.NUMBER:
          if (d.length >= 14) put(d.readUInt16LE(0), d.readUInt16LE(2), d.readDoubleLE(6), d.readUInt16LE(4));
          break;
        case R.RK:
          if (d.length >= 10) put(d.readUInt16LE(0), d.readUInt16LE(2), rk(d.readUInt32LE(6)), d.readUInt16LE(4));
          break;
        case R.MULRK: {
          if (d.length < 6) break;
          const row = d.readUInt16LE(0);
          const first = d.readUInt16LE(2);
          const n = Math.floor((d.length - 6) / 6);
          for (let i = 0; i < n; i++) put(row, first + i, rk(d.readUInt32LE(4 + i * 6 + 2)), d.readUInt16LE(4 + i * 6));
          break;
        }
        case R.BOOLERR:
          if (d.length >= 8) put(d.readUInt16LE(0), d.readUInt16LE(2), d[7] ? (ERRORS[d[6]!] ?? '#ERROR') : d[6] === 1, d.readUInt16LE(4));
          break;
        case R.FORMULA: {
          if (d.length < 20) break;
          formulas = true;
          const row = d.readUInt16LE(0);
          const col = d.readUInt16LE(2);
          const xf = d.readUInt16LE(4);
          if (d.readUInt16LE(12) === 0xffff) {
            const kind = d[6];
            if (kind === 0) pendingString = { r: row, c: col, xf };
            else if (kind === 1) put(row, col, d[8] === 1, xf);
            else if (kind === 2) put(row, col, ERRORS[d[8]!] ?? '#ERROR', xf);
          } else put(row, col, d.readDoubleLE(6), xf);
          break;
        }
        case R.STRING: {
          if (!pendingString) break;
          let v: string;
          if (biff8) v = new Reader([d, ...r.cont]).str16();
          else v = text8(d, 2, d.readUInt16LE(0));
          put(pendingString.r, pendingString.c, v, pendingString.xf);
          pendingString = null;
          break;
        }
        case R.MERGECELLS:
          notes.add('Merged cells are shown as separate cells.');
          break;
        case R.NOTE:
        case R.OBJ:
          notes.add('Charts, images and comments are not shown.');
          break;
      }
    }
    if (formulas) notes.add('Formulas in .xls files are read as their last calculated values.');
    budget.add(rows.reduce((n, r) => n + r.filter((c) => c.v == null).length, 0));
    sheets.push(finishSheet(sheetName(sh.name, taken), rows, []));
  }
  if (!sheets.length) sheets.push({ name: 'Sheet1', header: false, columns: [], rows: [] });
  notes.add('Saving writes an Excel (.xlsx) copy; the .xls file itself is not changed.');
  return { workbook: { sheets }, notes: [...notes] };
}
