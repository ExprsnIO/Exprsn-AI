import { spawn } from 'node:child_process';
import { readdir, rename } from 'node:fs/promises';
import path from 'node:path';

/*
 * Previews for the file store (B-2404): a PNG of an image or of a PDF's first page, at most `maxPx` on its longer
 * side. The process adapter runs ffmpeg (the media worker's binary) for images and poppler's pdftoppm for PDFs, as
 * argument arrays without a shell, with the input's demuxer forced from the type the quarantine scan detected. Tests
 * use an in-process fake with the same interface.
 */

export type PreviewKind = 'image' | 'pdf';

export interface PreviewRenderer {
  readonly name: string;
  /** Writes a PNG preview of `input` to `output`. Throws `PreviewUnavailable` when the tool is not installed. */
  render(kind: PreviewKind, type: string, input: string, output: string, maxPx: number, signal: AbortSignal): Promise<void>;
}

export class PreviewUnavailable extends Error {}

const DEMUXER: Record<string, string> = { 'image/png': 'png_pipe', 'image/jpeg': 'jpeg_pipe', 'image/webp': 'webp_pipe', 'image/gif': 'gif' };

export class ProcessPreviewRenderer implements PreviewRenderer {
  readonly name = 'process';

  constructor(private readonly o: { ffmpeg: string; pdftoppm: string; timeoutMs?: number }) {}

  private exec(bin: string, args: string[], signal: AbortSignal, cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason as Error);
      const child = spawn(bin, args, { shell: false, cwd, stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), this.o.timeoutMs ?? 60_000);
      const abort = () => child.kill('SIGKILL');
      signal.addEventListener('abort', abort, { once: true });
      child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr = (stderr + c).slice(-2000)));
      child.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        reject(err.code === 'ENOENT' ? new PreviewUnavailable(`${path.basename(bin)} is not installed on this server.`) : err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (signal.aborted) return reject(signal.reason as Error);
        if (code === 0) resolve();
        else reject(new Error(`${path.basename(bin)} exited with ${code}: ${stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300) || 'no message'}`));
      });
    });
  }

  async render(kind: PreviewKind, type: string, input: string, output: string, maxPx: number, signal: AbortSignal): Promise<void> {
    const dir = path.dirname(output);
    if (kind === 'image') {
      const demuxer = DEMUXER[type];
      if (!demuxer) throw new Error(`No preview for ${type}.`);
      const scale = `scale='min(${maxPx},iw)':'min(${maxPx},ih)':force_original_aspect_ratio=decrease`;
      await this.exec(this.o.ffmpeg, ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-protocol_whitelist', 'file', '-f', demuxer, '-i', input, '-frames:v', '1', '-vf', scale, '-f', 'image2', '-c:v', 'png', output], signal, dir);
      return;
    }
    // pdftoppm writes <prefix>.png with -singlefile.
    const prefix = path.join(dir, 'pdf-preview');
    await this.exec(this.o.pdftoppm, ['-png', '-singlefile', '-f', '1', '-l', '1', '-scale-to', String(maxPx), input, prefix], signal, dir);
    const made = (await readdir(dir)).find((f) => f.startsWith('pdf-preview') && f.endsWith('.png'));
    if (!made) throw new Error('pdftoppm wrote no page.');
    await rename(path.join(dir, made), output);
  }
}
