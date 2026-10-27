import { spawn } from 'node:child_process';

/*
 * The media worker's process boundary. Every command is an argument array handed to spawn without a shell; presets
 * build those arrays from typed, allow-listed parameters, so no user text ever becomes an option. The ffmpeg adapter
 * runs the binaries on this host; tests use an in-process fake with the same interface.
 */

export interface ProbeResult {
  /** The demuxer ffprobe used (e.g. `mov,mp4,m4a,3gp,3g2,mj2`). */
  format: string;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  streams: { type: string; codec: string }[];
}

export interface RunOptions {
  signal: AbortSignal;
  /** Length of the media being processed, to turn ffmpeg's position into a fraction. */
  durationMs?: number | null;
  onProgress?: (fraction: number) => void;
  cwd?: string;
}

export type MediaTool = 'ffmpeg' | 'whisper';

export interface MediaRunner {
  readonly name: string;
  /** Probes a file whose container was already recognised from its bytes; `demuxer` is forced. */
  probe(file: string, demuxer: string, signal: AbortSignal): Promise<ProbeResult>;
  run(tool: MediaTool, args: string[], o: RunOptions): Promise<void>;
  /** Whether this host's ffmpeg has the NVENC H.264 encoder. */
  nvenc(): Promise<boolean>;
}

export class MediaToolError extends Error {}

/** Arguments every ffmpeg run starts with: no stdin, no banner, progress on stdout, local files only. */
export const FFMPEG_PREFIX = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1'];

export class FfmpegRunner implements MediaRunner {
  readonly name = 'ffmpeg';
  private nvencCached: Promise<boolean> | null = null;

  constructor(private readonly o: { ffmpeg: string; ffprobe: string; whisper?: string }) {}

  private exec(bin: string, args: string[], o: RunOptions & { onStdout?: (line: string) => void; onStderr?: (line: string) => void }): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      if (o.signal.aborted) return reject(o.signal.reason as Error);
      const child = spawn(bin, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], ...(o.cwd ? { cwd: o.cwd } : {}), env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
      let stdout = '';
      let stderr = '';
      let outBuf = '';
      let errBuf = '';
      const lines = (buf: string, chunk: string, fn?: (l: string) => void): string => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          fn?.(buf.slice(0, i).trim());
          buf = buf.slice(i + 1);
        }
        return buf;
      };
      child.stdout.setEncoding('utf8').on('data', (c: string) => {
        if (stdout.length < 1_000_000) stdout += c;
        outBuf = lines(outBuf, c, o.onStdout);
      });
      child.stderr.setEncoding('utf8').on('data', (c: string) => {
        stderr = (stderr + c).slice(-4000);
        errBuf = lines(errBuf.replace(/\r/g, '\n'), c.replace(/\r/g, '\n'), o.onStderr);
      });
      const abort = () => child.kill('SIGKILL');
      o.signal.addEventListener('abort', abort, { once: true });
      child.on('error', (err) => {
        o.signal.removeEventListener('abort', abort);
        reject(new MediaToolError(`${bin} could not start: ${err.message}`));
      });
      child.on('close', (code) => {
        o.signal.removeEventListener('abort', abort);
        if (o.signal.aborted) return reject(o.signal.reason as Error);
        if (code === 0) resolve({ stdout, stderr });
        else reject(new MediaToolError(`${bin} exited with ${code}: ${stderr.trim().split('\n').slice(-3).join(' ').slice(0, 500) || 'no message'}`));
      });
    });
  }

  async probe(file: string, demuxer: string, signal: AbortSignal): Promise<ProbeResult> {
    const { stdout } = await this.exec(this.o.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file', '-f', demuxer, '-print_format', 'json', '-show_format', '-show_streams', file], { signal });
    const j = JSON.parse(stdout) as { format?: { format_name?: string; duration?: string }; streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string; disposition?: { attached_pic?: number } }[] };
    const streams = (j.streams ?? []).filter((s) => !s.disposition?.attached_pic);
    const video = streams.find((s) => s.codec_type === 'video');
    const dur = Number(j.format?.duration ?? video?.duration ?? NaN);
    return {
      format: j.format?.format_name ?? demuxer,
      durationMs: Number.isFinite(dur) ? Math.round(dur * 1000) : null,
      width: video?.width ?? null,
      height: video?.height ?? null,
      streams: streams.map((s) => ({ type: s.codec_type ?? 'data', codec: s.codec_name ?? 'unknown' }))
    };
  }

  async run(tool: MediaTool, args: string[], o: RunOptions): Promise<void> {
    if (tool === 'ffmpeg') {
      await this.exec(this.o.ffmpeg, [...FFMPEG_PREFIX, ...args], {
        ...o,
        onStdout: (l) => {
          // -progress writes key=value lines; out_time_us is the position in the output.
          const m = /^out_time_(?:us|ms)=(\d+)$/.exec(l);
          if (m && o.durationMs) o.onProgress?.(Math.min(1, Number(m[1]) / 1000 / o.durationMs));
          if (l === 'progress=end') o.onProgress?.(1);
        }
      });
      return;
    }
    if (!this.o.whisper) throw new MediaToolError('whisper.cpp is not configured on this server (MEDIA_WHISPER_BIN).');
    await this.exec(this.o.whisper, args, {
      ...o,
      onStderr: (l) => {
        const m = /progress\s*=\s*(\d+)%/.exec(l);
        if (m) o.onProgress?.(Number(m[1]) / 100);
      }
    });
  }

  nvenc(): Promise<boolean> {
    this.nvencCached ??= this.exec(this.o.ffmpeg, ['-hide_banner', '-encoders'], { signal: AbortSignal.timeout(10_000) })
      .then(({ stdout }) => /\bh264_nvenc\b/.test(stdout))
      .catch(() => false);
    return this.nvencCached;
  }
}

/** Containers accepted as media, recognised from the first bytes, and the demuxer ffprobe and ffmpeg are forced to. */
export interface Container {
  demuxer: string;
  kind: 'video' | 'audio' | 'image';
  /** The muxer and extension used when the file is re-written without metadata. */
  muxer: string;
  ext: string;
}

export function sniffContainer(b: Buffer): Container | null {
  const ascii = (from: number, to: number) => b.subarray(from, to).toString('latin1');
  if (b.length < 12) return null;
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand === 'M4A ' || brand === 'M4B ') return { demuxer: 'mov', kind: 'audio', muxer: 'ipod', ext: 'm4a' };
    return brand === 'qt  ' ? { demuxer: 'mov', kind: 'video', muxer: 'mov', ext: 'mov' } : { demuxer: 'mov', kind: 'video', muxer: 'mp4', ext: 'mp4' };
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { demuxer: 'matroska', kind: 'video', muxer: 'matroska', ext: 'mkv' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return { demuxer: 'wav', kind: 'audio', muxer: 'wav', ext: 'wav' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { demuxer: 'webp_pipe', kind: 'image', muxer: 'image2', ext: 'png' };
  if (ascii(0, 4) === 'OggS') return { demuxer: 'ogg', kind: 'audio', muxer: 'ogg', ext: 'ogg' };
  if (ascii(0, 4) === 'fLaC') return { demuxer: 'flac', kind: 'audio', muxer: 'flac', ext: 'flac' };
  if (ascii(0, 3) === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe6) === 0xe2)) return { demuxer: 'mp3', kind: 'audio', muxer: 'mp3', ext: 'mp3' };
  if (b[0] === 0xff && (b[1]! & 0xf6) === 0xf0) return { demuxer: 'aac', kind: 'audio', muxer: 'adts', ext: 'aac' };
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { demuxer: 'png_pipe', kind: 'image', muxer: 'image2', ext: 'png' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { demuxer: 'jpeg_pipe', kind: 'image', muxer: 'image2', ext: 'jpg' };
  return null;
}
