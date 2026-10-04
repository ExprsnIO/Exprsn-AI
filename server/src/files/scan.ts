import { once } from 'node:events';
import { connect } from 'node:net';
import { highest, type Label } from '../authz/labels.js';
import { classify } from '../chat/attachments.js';
import { zipEntries } from '../knowledge/extract.js';

/*
 * The file store's quarantine checks (B-2401), the attachment pipeline's checks (Sprint 4) made to stream: the type
 * is detected from the bytes, never from the name or the declared type; text must be UTF-8 without NUL bytes and is
 * classified for personal and financial data; then ClamAV sees every byte through INSTREAM. Nothing here holds a
 * whole file in memory, except a zip archive (to find out whether it is an Office document), up to ZIP_MAX_BYTES.
 */

export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const ZIP_MAX_BYTES = 32 * 1024 * 1024;
const JSON_MAX_CHARS = 16 * 1024 * 1024;
const CLASSIFY_WINDOW = 1024 * 1024;

export const ACCEPTED_DESCRIPTION = 'text, Markdown, CSV, JSON, HTML, PDF, Word, Excel, PowerPoint, PNG, JPEG, WebP and GIF';

export type Inspection = { type: string; label: Label; detections: Record<string, number> } | { rejected: string };

const head = (b: Buffer, from: number, to: number) => b.subarray(from, to).toString('latin1');

function binaryType(b: Buffer): string | null {
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (head(b, 0, 4) === 'RIFF' && head(b, 8, 12) === 'WEBP') return 'image/webp';
  if (head(b, 0, 6) === 'GIF87a' || head(b, 0, 6) === 'GIF89a') return 'image/gif';
  if (head(b, 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

/**
 * Detects the type of a file from its bytes and classifies text. `label` is the label asked for at upload; the result
 * is that label raised by what the classifier found.
 */
export async function inspect(source: AsyncIterable<Buffer>, name: string, label: Label): Promise<Inspection> {
  const it = source[Symbol.asyncIterator]();
  // Read enough of the start to recognise a signature.
  let first = Buffer.alloc(0);
  let ended = false;
  while (first.length < 16) {
    const n = await it.next();
    if (n.done) {
      ended = true;
      break;
    }
    first = Buffer.concat([first, n.value]);
  }
  const rest = async function* (): AsyncGenerator<Buffer> {
    if (first.length) yield first;
    if (ended) return;
    for (;;) {
      const n = await it.next();
      if (n.done) return;
      yield n.value;
    }
  };
  // Stops reading (and closes the stored stream) once the answer is known.
  const close = async () => {
    await it.return?.(undefined);
  };

  const bin = binaryType(first);
  if (bin) {
    await close();
    return { type: bin, label, detections: {} };
  }

  if (first.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    const parts: Buffer[] = [];
    let n = 0;
    for await (const c of rest()) {
      n += c.length;
      if (n > ZIP_MAX_BYTES) {
        await close().catch(() => undefined);
        return { rejected: `A zip archive larger than ${ZIP_MAX_BYTES / 1024 / 1024} MiB cannot be checked. Accepted: ${ACCEPTED_DESCRIPTION}.` };
      }
      parts.push(c);
    }
    try {
      const entries = zipEntries(Buffer.concat(parts, n));
      if (entries.has('word/document.xml')) return { type: DOCX, label, detections: {} };
      if (entries.has('xl/workbook.xml')) return { type: XLSX, label, detections: {} };
      if (entries.has('ppt/presentation.xml')) return { type: PPTX, label, detections: {} };
    } catch {
      // not a readable zip
    }
    return { rejected: `A zip archive that is not an Office document. Accepted: ${ACCEPTED_DESCRIPTION}.` };
  }

  // Text: UTF-8, no NUL bytes, classified window by window (cut at line ends so a match is not split).
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  const detections: Record<string, number> = {};
  let found: Label = label;
  let window = '';
  let json: string | null = ext === 'json' ? '' : null;
  let start = '';
  const classifyText = (t: string) => {
    if (!t) return;
    const c = classify(t);
    for (const [k, v] of Object.entries(c.detections)) detections[k] = (detections[k] ?? 0) + v;
    found = highest(found, c.label);
  };
  try {
    for await (const c of rest()) {
      if (c.includes(0)) {
        await close().catch(() => undefined);
        return { rejected: `Binary content of a type that is not accepted. Accepted: ${ACCEPTED_DESCRIPTION}.` };
      }
      const t = decoder.decode(c, { stream: true });
      if (start.length < 512) start += t.slice(0, 512);
      if (json !== null) json = json.length + t.length <= JSON_MAX_CHARS ? json + t : null;
      window += t;
      if (window.length >= CLASSIFY_WINDOW) {
        const cut = window.lastIndexOf('\n');
        const at = cut > 0 ? cut + 1 : window.length;
        classifyText(window.slice(0, at));
        window = window.slice(at);
      }
    }
    const tail = decoder.decode();
    window += tail;
    if (json !== null) json += tail;
  } catch (err) {
    if (err instanceof TypeError) return { rejected: 'The text is not valid UTF-8.' };
    throw err;
  }
  classifyText(window);
  let type = ext === 'md' || ext === 'markdown' ? 'text/markdown' : ext === 'csv' ? 'text/csv' : 'text/plain';
  if (ext === 'json') {
    if (json !== null) {
      try {
        JSON.parse(json);
        type = 'application/json';
      } catch {
        return { rejected: 'The file is named .json but is not valid JSON.' };
      }
    }
  } else if (ext === 'html' || ext === 'htm' || /^\s*(<!doctype html|<html[\s>])/i.test(start)) type = 'text/html';
  return { type, label: found, detections };
}

/**
 * ClamAV clamd INSTREAM over a stream: null when clean, the signature name when infected. Chunks go out as they come
 * (with back-pressure), so the file is never held in memory. clamd refuses streams above its StreamMaxLength
 * (25 MB by default), which fails the scan: raise it to the file store's FILES_MAX_BYTES.
 */
export async function clamStream(host: string, port: number, source: AsyncIterable<Buffer>, timeoutMs = 10 * 60_000): Promise<string | null> {
  const sock = connect({ host, port });
  let answer = '';
  const done = new Promise<string>((resolve, reject) => {
    sock.on('data', (d: Buffer) => (answer += d.toString()));
    sock.on('end', () => resolve(answer));
    sock.on('close', () => resolve(answer));
    sock.on('error', reject);
  });
  done.catch(() => undefined);
  const timer = setTimeout(() => sock.destroy(new Error('clamd did not answer in time')), timeoutMs);
  try {
    await once(sock, 'connect');
    const write = async (b: Buffer) => {
      if (sock.destroyed) throw new Error(`clamd closed the stream: ${answer.replace(/\0/g, '').trim() || 'no answer'}`);
      if (!sock.write(b)) await Promise.race([once(sock, 'drain'), done.then(() => undefined)]);
    };
    await write(Buffer.from('zINSTREAM\0'));
    for await (const c of source) {
      for (let i = 0; i < c.length; i += 64 * 1024) {
        const part = c.subarray(i, i + 64 * 1024);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(part.length);
        await write(Buffer.concat([len, part]));
      }
    }
    await write(Buffer.alloc(4));
    const a = (await done).replace(/\0/g, '').trim();
    if (/OK$/.test(a)) return null;
    if (/FOUND$/.test(a)) return a.replace(/^stream:\s*/, '').replace(/\s*FOUND$/, '');
    throw new Error(`clamd: ${a || 'no answer'}`);
  } finally {
    clearTimeout(timer);
    sock.destroy();
  }
}
