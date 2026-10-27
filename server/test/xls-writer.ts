/*
 * A minimal Excel 97-2003 (.xls) writer for the tests of `files/documents/xls.ts`: a Compound File (512-byte sectors,
 * one FAT sector) holding a BIFF8 `Workbook` stream. Strings go to the shared string table, which is split into
 * CONTINUE records the way Excel splits it (a flags byte starts the rest of a string cut at a record boundary).
 * Cells: text (LABELSST), numbers (NUMBER; integers as RK), booleans and errors (BOOLERR), dates (NUMBER with a date
 * format), and formulas with a cached number or text result (FORMULA, STRING).
 */

export type XlsValue = string | number | boolean | null | { date: number } | { formula: number | string } | { error: number };
export interface XlsSheet {
  name: string;
  rows: XlsValue[][];
  hidden?: boolean;
}

const MAX_REC = 8224;

function rec(type: number, data: Buffer): Buffer {
  const h = Buffer.alloc(4);
  h.writeUInt16LE(type, 0);
  h.writeUInt16LE(data.length, 2);
  return Buffer.concat([h, data]);
}

const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
const f64 = (n: number) => { const b = Buffer.alloc(8); b.writeDoubleLE(n, 0); return b; };
const wide = (s: string) => [...s].some((c) => c.charCodeAt(0) > 255);
const strBytes = (s: string, w: boolean) => (w ? Buffer.from(s, 'utf16le') : Buffer.from(s, 'latin1'));

/** The SST as an SST record and its CONTINUE records. */
function sstRecords(strings: string[], total: number): Buffer {
  const recs: Buffer[][] = [[u32(total), u32(strings.length)]];
  let size = 8;
  const room = () => MAX_REC - size;
  const push = (b: Buffer) => { recs[recs.length - 1]!.push(b); size += b.length; };
  const next = () => { recs.push([]); size = 0; };
  for (const s of strings) {
    const w = wide(s);
    if (room() < 3 + (w ? 2 : 1)) next();
    push(Buffer.concat([u16(s.length), Buffer.from([w ? 1 : 0])]));
    let chars = [...s];
    while (chars.length) {
      const per = w ? 2 : 1;
      const fit = Math.floor(room() / per);
      if (fit <= 0) {
        next();
        push(Buffer.from([w ? 1 : 0]));
        continue;
      }
      const part = chars.slice(0, fit).join('');
      push(strBytes(part, w));
      chars = chars.slice(fit);
      if (chars.length) {
        next();
        push(Buffer.from([w ? 1 : 0]));
      }
    }
  }
  return Buffer.concat(recs.map((parts, i) => rec(i === 0 ? 0x00fc : 0x003c, Buffer.concat(parts))));
}

function biffString16(s: string): Buffer {
  const w = wide(s);
  return Buffer.concat([u16(s.length), Buffer.from([w ? 1 : 0]), strBytes(s, w)]);
}

/** The BIFF8 Workbook stream. */
export function workbookStream(sheets: XlsSheet[], o: { date1904?: boolean; password?: boolean } = {}): Buffer {
  const strings: string[] = [];
  const at = new Map<string, number>();
  let total = 0;
  const sst = (s: string) => { total++; if (!at.has(s)) { at.set(s, strings.length); strings.push(s); } return at.get(s)!; };

  const bof = (dt: number) => rec(0x0809, Buffer.concat([u16(0x0600), u16(dt), u16(0x0dbb), u16(0x07cc), u32(0), u32(0)]));
  const xf = (ifmt: number) => { const d = Buffer.alloc(20); d.writeUInt16LE(ifmt, 2); return rec(0x00e0, d); };

  const sheetStreams = sheets.map((sh) => {
    const parts: Buffer[] = [bof(0x0010)];
    sh.rows.forEach((row, r) => row.forEach((v, c) => {
      if (v == null) return;
      const head = Buffer.concat([u16(r), u16(c)]);
      if (typeof v === 'string') parts.push(rec(0x00fd, Buffer.concat([head, u16(0), u32(sst(v))])));
      else if (typeof v === 'boolean') parts.push(rec(0x0205, Buffer.concat([head, u16(0), Buffer.from([v ? 1 : 0, 0])])));
      else if (typeof v === 'number') {
        if (Number.isInteger(v) && Math.abs(v) < 2 ** 29) parts.push(rec(0x027e, Buffer.concat([head, u16(0), u32(((v << 2) | 0x02) >>> 0)])));
        else parts.push(rec(0x0203, Buffer.concat([head, u16(0), f64(v)])));
      } else if ('date' in v) parts.push(rec(0x0203, Buffer.concat([head, u16(1), f64(v.date)])));
      else if ('error' in v) parts.push(rec(0x0205, Buffer.concat([head, u16(0), Buffer.from([v.error, 1])])));
      else {
        const tokens = Buffer.from([0x1e, 0x01, 0x00]); // ptgInt 1: the formula's own tokens are never read
        const result = typeof v.formula === 'number' ? f64(v.formula) : Buffer.from([0, 0, 0, 0, 0, 0, 0xff, 0xff]);
        parts.push(rec(0x0006, Buffer.concat([head, u16(0), result, u16(0), u32(0), u16(tokens.length), tokens])));
        if (typeof v.formula === 'string') parts.push(rec(0x0207, biffString16(v.formula)));
      }
    }));
    parts.push(rec(0x000a, Buffer.alloc(0)));
    return Buffer.concat(parts);
  });

  const boundsheet = (sh: XlsSheet, pos: number) => {
    const w = wide(sh.name);
    return rec(0x0085, Buffer.concat([u32(pos), Buffer.from([sh.hidden ? 1 : 0, 0, sh.name.length, w ? 1 : 0]), strBytes(sh.name, w)]));
  };
  const head: Buffer[] = [bof(0x0005)];
  if (o.password) head.push(rec(0x002f, Buffer.alloc(6)));
  head.push(rec(0x0022, u16(o.date1904 ? 1 : 0)), xf(0), xf(14));
  const tail = Buffer.concat([sstRecords(strings, total), rec(0x000a, Buffer.alloc(0))]);
  // Offsets of the sheets are known once the globals' length is: BOUNDSHEET records have a fixed size per name.
  const bsLen = sheets.reduce((n, sh) => n + boundsheet(sh, 0).length, 0);
  let pos = Buffer.concat(head).length + bsLen + tail.length;
  const bss = sheets.map((sh, i) => { const b = boundsheet(sh, pos); pos += sheetStreams[i]!.length; return b; });
  return Buffer.concat([...head, ...bss, tail, ...sheetStreams]);
}

const END = 0xfffffffe;
const FREE = 0xffffffff;

/** A Compound File holding one stream; `name` is the stream's name (Workbook, or WordDocument to test refusal). */
export function compoundFile(stream: Buffer, o: { name?: string; mini?: boolean } = {}): Buffer {
  const S = 512;
  const name = o.name ?? 'Workbook';
  const mini = o.mini ?? stream.length < 4096;
  const padTo = (b: Buffer, n: number) => (b.length % n ? Buffer.concat([b, Buffer.alloc(n - (b.length % n))]) : b);
  // Sectors: 0 FAT, 1 directory, then the stream (or the mini FAT and the mini stream).
  const fat: number[] = [0xfffffffd, END];
  const sectors: Buffer[] = [];
  const chain = (count: number): number => {
    const first = fat.length;
    for (let i = 0; i < count; i++) fat.push(i === count - 1 ? END : first + i + 1);
    return first;
  };
  let streamStart: number;
  let rootStart = END;
  let rootSize = 0;
  let miniFatStart = END;
  let nMiniFat = 0;
  const data: Buffer[] = [];
  if (!mini) {
    const body = padTo(stream, S);
    streamStart = chain(body.length / S);
    data.push(body);
  } else {
    const body = padTo(stream, 64);
    const n = body.length / 64;
    const mf = Buffer.alloc(S, 0xff);
    for (let i = 0; i < n; i++) mf.writeUInt32LE(i === n - 1 ? END : i + 1, i * 4);
    miniFatStart = chain(1);
    nMiniFat = 1;
    data.push(mf);
    const ms = padTo(body, S);
    rootStart = chain(ms.length / S);
    rootSize = body.length;
    data.push(ms);
    streamStart = 0;
  }
  const dir = Buffer.alloc(S);
  const entry = (i: number, n: string, type: number, start: number, size: number, child = FREE) => {
    const off = i * 128;
    dir.write(n, off, 'utf16le');
    dir.writeUInt16LE((n.length + 1) * 2, off + 64);
    dir[off + 66] = type;
    dir[off + 67] = 1;
    dir.writeUInt32LE(FREE, off + 68);
    dir.writeUInt32LE(FREE, off + 72);
    dir.writeUInt32LE(child, off + 76);
    dir.writeUInt32LE(start, off + 116);
    dir.writeUInt32LE(size, off + 120);
  };
  entry(0, 'Root Entry', 5, rootStart, rootSize, 1);
  entry(1, name, 2, streamStart, stream.length);
  const fatSector = Buffer.alloc(S, 0xff);
  fat.forEach((v, i) => fatSector.writeUInt32LE(v >>> 0, i * 4));
  sectors.push(fatSector, dir, ...data);
  const header = Buffer.alloc(S);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0);
  header.writeUInt16LE(0x3e, 0x18);
  header.writeUInt16LE(3, 0x1a);
  header.writeUInt16LE(0xfffe, 0x1c);
  header.writeUInt16LE(9, 0x1e);
  header.writeUInt16LE(6, 0x20);
  header.writeUInt32LE(1, 0x2c);
  header.writeUInt32LE(1, 0x30);
  header.writeUInt32LE(4096, 0x38);
  header.writeUInt32LE(miniFatStart, 0x3c);
  header.writeUInt32LE(nMiniFat, 0x40);
  header.writeUInt32LE(END, 0x44);
  header.writeUInt32LE(0, 0x48);
  for (let i = 0; i < 109; i++) header.writeUInt32LE(i === 0 ? 0 : FREE, 0x4c + i * 4);
  return Buffer.concat([header, ...sectors]);
}

export const xlsFile = (sheets: XlsSheet[], o: { mini?: boolean; date1904?: boolean; password?: boolean } = {}) => compoundFile(workbookStream(sheets, o), { mini: o.mini });
