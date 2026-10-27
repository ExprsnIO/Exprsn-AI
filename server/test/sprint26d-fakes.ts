import { writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { PreviewUnavailable, type PreviewKind, type PreviewRenderer } from '../src/files/preview.js';

/**
 * A clamd that speaks zINSTREAM on 127.0.0.1: it collects the chunks and answers FOUND when the stream contains one
 * of `signatures`, else OK. Signatures can change between scans, as ClamAV's database does.
 */
export class FakeClamd {
  private server: Server | null = null;
  port = 0;
  signatures: string[] = [];
  scans: { bytes: number; found: string | null }[] = [];

  async start(): Promise<this> {
    this.server = createServer((sock: Socket) => {
      let buf = Buffer.alloc(0);
      let started = false;
      const data: Buffer[] = [];
      sock.on('data', (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        if (!started) {
          const nul = buf.indexOf(0);
          if (nul < 0) return;
          if (buf.subarray(0, nul).toString() !== 'zINSTREAM') {
            sock.end('UNKNOWN COMMAND\0');
            return;
          }
          started = true;
          buf = buf.subarray(nul + 1);
        }
        while (buf.length >= 4) {
          const len = buf.readUInt32BE(0);
          if (len === 0) {
            const all = Buffer.concat(data).toString('latin1');
            const hit = this.signatures.find((sig) => all.includes(sig)) ?? null;
            this.scans.push({ bytes: all.length, found: hit });
            sock.end(hit ? `stream: Test.Signature.${hit.length} FOUND\0` : 'stream: OK\0');
            buf = Buffer.alloc(0);
            return;
          }
          if (buf.length < 4 + len) return;
          data.push(Buffer.from(buf.subarray(4, 4 + len)));
          buf = buf.subarray(4 + len);
        }
      });
      sock.on('error', () => undefined);
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.port = (this.server!.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise((r) => this.server?.close(r));
  }
}

/** A tiny valid PNG (1x1, grey). */
export const TINY_PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010800000000376ef9240000000a49444154789c636000000002000154a24f5d0000000049454e44ae426082', 'hex');

/** A preview renderer that records its calls and writes a tiny PNG (or says it is not installed). */
export class FakePreviewRenderer implements PreviewRenderer {
  readonly name = 'fake';
  calls: { kind: PreviewKind; type: string; maxPx: number }[] = [];
  unavailable = false;

  async render(kind: PreviewKind, type: string, _input: string, output: string, maxPx: number): Promise<void> {
    this.calls.push({ kind, type, maxPx });
    if (this.unavailable) throw new PreviewUnavailable('pdftoppm is not installed on this server.');
    await writeFile(output, TINY_PNG);
  }
}
