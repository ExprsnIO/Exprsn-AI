/*
 * 1.9.99-final, Sprint 60 (B-10501): the AWS event-stream framing (`application/vnd.amazon.eventstream`) that
 * Bedrock's ConverseStream and InvokeModelWithResponseStream answer with. Each message is
 *
 *   total length (u32 BE) | headers length (u32 BE) | prelude CRC32 (u32 BE, of the first 8 bytes)
 *   | headers | payload | message CRC32 (u32 BE, of everything before it)
 *
 * and each header is a name (u8 length, UTF-8) and a typed value (u8 type: 0 true, 1 false, 2 i8, 3 i16, 4 i32, 5 i64,
 * 6 bytes and 7 string with a u16 length, 8 timestamp as i64 milliseconds, 9 UUID). `EventStreamDecoder` takes bytes
 * as they arrive, split anywhere (a frame across two reads, or many frames in one), checks both CRCs and the limits,
 * and hands back whole messages. A stream that ends inside a frame, a CRC mismatch or a frame over the limits is an
 * `EventStreamError`: never a partial message.
 */

export class EventStreamError extends Error {
  constructor(
    message: string,
    readonly code: 'crc' | 'truncated' | 'too_large' | 'malformed'
  ) {
    super(message);
  }
}

export type HeaderValue = boolean | number | bigint | string | Buffer | Date;

export interface EventStreamMessage {
  headers: Record<string, HeaderValue>;
  payload: Buffer;
}

/** The largest frame accepted (AWS caps a message at 16 MiB; Bedrock's are a few KB). */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const PRELUDE = 12;
const MAX_HEADERS_BYTES = 128 * 1024;

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE 802.3), as the framing uses it. */
export function crc32(buf: Uint8Array, start = 0, end = buf.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function readHeaders(buf: Buffer): Record<string, HeaderValue> {
  const out: Record<string, HeaderValue> = {};
  let i = 0;
  const need = (n: number) => {
    if (i + n > buf.length) throw new EventStreamError('An event-stream header runs past its frame.', 'malformed');
  };
  while (i < buf.length) {
    need(1);
    const nameLen = buf.readUInt8(i);
    i += 1;
    need(nameLen + 1);
    const name = buf.toString('utf8', i, i + nameLen);
    i += nameLen;
    const type = buf.readUInt8(i);
    i += 1;
    let value: HeaderValue;
    switch (type) {
      case 0:
        value = true;
        break;
      case 1:
        value = false;
        break;
      case 2:
        need(1);
        value = buf.readInt8(i);
        i += 1;
        break;
      case 3:
        need(2);
        value = buf.readInt16BE(i);
        i += 2;
        break;
      case 4:
        need(4);
        value = buf.readInt32BE(i);
        i += 4;
        break;
      case 5:
        need(8);
        value = buf.readBigInt64BE(i);
        i += 8;
        break;
      case 6:
      case 7: {
        need(2);
        const len = buf.readUInt16BE(i);
        i += 2;
        need(len);
        value = type === 6 ? Buffer.from(buf.subarray(i, i + len)) : buf.toString('utf8', i, i + len);
        i += len;
        break;
      }
      case 8:
        need(8);
        value = new Date(Number(buf.readBigInt64BE(i)));
        i += 8;
        break;
      case 9:
        need(16);
        value = buf.subarray(i, i + 16).toString('hex');
        i += 16;
        break;
      default:
        throw new EventStreamError(`Unknown event-stream header type ${type}.`, 'malformed');
    }
    out[name] = value;
  }
  return out;
}

/** Bytes in, whole messages out. */
export class EventStreamDecoder {
  private buf: Buffer = Buffer.alloc(0);

  constructor(private readonly maxFrame = MAX_FRAME_BYTES) {}

  /** Adds bytes; returns every message they complete (none while a frame is still partial). */
  push(chunk: Uint8Array): EventStreamMessage[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const out: EventStreamMessage[] = [];
    for (;;) {
      if (this.buf.length < PRELUDE) break;
      const total = this.buf.readUInt32BE(0);
      const headersLen = this.buf.readUInt32BE(4);
      if (crc32(this.buf, 0, 8) !== this.buf.readUInt32BE(8)) throw new EventStreamError('An event-stream prelude failed its CRC check.', 'crc');
      if (total > this.maxFrame) throw new EventStreamError(`An event-stream frame of ${total} bytes is over the ${this.maxFrame}-byte limit.`, 'too_large');
      if (total < PRELUDE + 4 || headersLen > MAX_HEADERS_BYTES || PRELUDE + headersLen + 4 > total) throw new EventStreamError('An event-stream frame has impossible lengths.', 'malformed');
      if (this.buf.length < total) break;
      if (crc32(this.buf, 0, total - 4) !== this.buf.readUInt32BE(total - 4)) throw new EventStreamError('An event-stream message failed its CRC check.', 'crc');
      const headers = readHeaders(this.buf.subarray(PRELUDE, PRELUDE + headersLen));
      const payload = Buffer.from(this.buf.subarray(PRELUDE + headersLen, total - 4));
      out.push({ headers, payload });
      this.buf = this.buf.subarray(total);
    }
    return out;
  }

  /** The stream ended: anything left over is a frame cut short. */
  end(): void {
    if (this.buf.length) throw new EventStreamError(`The event stream ended inside a frame (${this.buf.length} bytes left over).`, 'truncated');
  }
}

/** Decodes a byte stream into messages as they complete. */
export async function* decodeEventStream(body: AsyncIterable<Uint8Array>, maxFrame = MAX_FRAME_BYTES): AsyncGenerator<EventStreamMessage> {
  const d = new EventStreamDecoder(maxFrame);
  for await (const chunk of body) yield* d.push(chunk);
  d.end();
}

/** An `exception` or `error` message from the service, raised mid-stream (throttling, validation, a model error). */
export class EventStreamException extends Error {
  constructor(
    message: string,
    /** `throttlingException`, `validationException`, `modelStreamErrorException`... or the `:error-code`. */
    readonly type: string
  ) {
    super(message);
  }
}

/**
 * The `event` messages of a stream as `{ type, body }` (the JSON payload); an `exception` or `error` message throws
 * `EventStreamException` with the service's own message.
 */
export async function* events(messages: AsyncIterable<EventStreamMessage>): AsyncGenerator<{ type: string; body: Record<string, unknown> }> {
  for await (const m of messages) {
    const kind = String(m.headers[':message-type'] ?? 'event');
    if (kind === 'exception' || kind === 'error') {
      let message = kind === 'error' ? String(m.headers[':error-message'] ?? '') : '';
      const type = String(m.headers[':exception-type'] ?? m.headers[':error-code'] ?? 'error');
      if (!message) {
        try {
          const j = JSON.parse(m.payload.toString('utf8')) as { message?: string; Message?: string };
          message = j.message ?? j.Message ?? '';
        } catch {
          message = m.payload.toString('utf8').slice(0, 300);
        }
      }
      throw new EventStreamException(message || `The stream failed (${type}).`, type);
    }
    let body: Record<string, unknown> = {};
    if (m.payload.length) {
      try {
        const v = JSON.parse(m.payload.toString('utf8')) as unknown;
        if (v && typeof v === 'object' && !Array.isArray(v)) body = v as Record<string, unknown>;
      } catch {
        throw new EventStreamError(`An event-stream ${String(m.headers[':event-type'] ?? 'event')} payload is not JSON.`, 'malformed');
      }
    }
    yield { type: String(m.headers[':event-type'] ?? ''), body };
  }
}
