import { crc32, deflateRawSync } from 'node:zlib';

/*
 * A small ZIP writer for documents built in memory (the Word and OpenDocument chat exports). Stored or deflated
 * members, no Zip64 (every member and the whole archive stay well under 4 GB), names in UTF-8 (general purpose bit 11).
 * `imports/zip.ts` is the reader.
 */

export interface ZipMember {
  name: string;
  data: Buffer | string;
  /** Stored without compression (OpenDocument's `mimetype` must be the first member and stored). */
  store?: boolean;
}

/** DOS date and time of a JavaScript date (local fields, as archivers expect). */
function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2), date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

export function zip(members: ZipMember[], when = new Date()): Buffer {
  const { time, date } = dosTime(when);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const m of members) {
    const name = Buffer.from(m.name, 'utf8');
    const raw = Buffer.isBuffer(m.data) ? m.data : Buffer.from(m.data, 'utf8');
    const crc = crc32(raw) >>> 0;
    const body = m.store ? raw : deflateRawSync(raw, { level: 9 });
    const method = m.store ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, dir, end]);
}

/** 1.9.0 (B-177): one member of a streamed archive; `open` is called when the member's turn comes. */
export interface ZipStreamMember {
  name: string;
  open(): Promise<AsyncIterable<Buffer>>;
  when?: Date;
}

/** What a streamed archive holds at most: no Zip64, so each member and the whole stay under 4 GiB. */
export const ZIP_STREAM_MAX_BYTES = 0xffff_fff0;

/**
 * 1.9.0 (B-177): a ZIP written as it is read, for members that are streams (album downloads). Members are stored (the
 * photos and videos are compressed already) with a data descriptor after each (general purpose bit 3), so nothing is
 * held in memory but the central directory. `onMember` hears each member written, with its size; a member whose
 * `open` throws is left out and `onSkip` is told why. Throws past ZIP_STREAM_MAX_BYTES.
 */
export async function* zipStream(members: AsyncIterable<ZipStreamMember> | Iterable<ZipStreamMember>, o: { onMember?: (name: string, size: number) => void; onSkip?: (name: string, err: Error) => void } = {}): AsyncGenerator<Buffer> {
  const centrals: Buffer[] = [];
  let offset = 0;
  let count = 0;
  for await (const m of members) {
    let stream: AsyncIterable<Buffer>;
    try {
      stream = await m.open();
    } catch (err) {
      o.onSkip?.(m.name, err as Error);
      continue;
    }
    const { time, date } = dosTime(m.when ?? new Date());
    const name = Buffer.from(m.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0808, 6); // data descriptor, UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    // crc and sizes are in the data descriptor
    local.writeUInt16LE(name.length, 26);
    yield Buffer.concat([local, name]);
    let crc = 0;
    let size = 0;
    for await (const chunk of stream) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += b.length;
      if (offset + 30 + name.length + size > ZIP_STREAM_MAX_BYTES) throw new Error('The archive would pass 4 GiB, which this writer does not do (no Zip64).');
      crc = crc32(b, crc);
      yield b;
    }
    const desc = Buffer.alloc(16);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crc >>> 0, 4);
    desc.writeUInt32LE(size, 8);
    desc.writeUInt32LE(size, 12);
    yield desc;
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0808, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + size + 16;
    count++;
    o.onMember?.(m.name, size);
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  yield Buffer.concat([dir, end]);
}
