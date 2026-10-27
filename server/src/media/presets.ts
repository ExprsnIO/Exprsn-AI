import path from 'node:path';
import { z } from 'zod';
import type { MediaTool } from './runner.js';

/*
 * Media presets. Each one has a typed parameter schema (enums and times only; nothing free-form) and a builder that
 * turns validated parameters into argument arrays. Filter strings are assembled from enum values, never from input.
 */

export type MediaKind = 'video' | 'audio' | 'image';
export type Encoder = 'nvenc' | 'cpu' | 'none';

export interface Step {
  tool: MediaTool;
  args: string[];
  stage: string;
  /** Length of media the step processes (for progress). */
  durationMs: number | null;
  /** Share of the job's progress bar this step covers. */
  weight: number;
}

export interface BuildContext {
  input: string;
  demuxer: string;
  outDir: string;
  durationMs: number | null;
  height: number | null;
  encoder: Encoder;
  whisperModel?: string;
}

export interface FormField {
  name: string;
  label: string;
  type: 'time' | 'select';
  options?: string[];
  default: string;
}

export interface Output {
  /** Files in outDir to keep, by glob-like prefix and extension. */
  match: (file: string) => boolean;
  type: string;
  kind: 'video' | 'audio' | 'frames' | 'subtitles';
}

export interface Preset {
  id: string;
  sub: string;
  kinds: MediaKind[];
  fields: FormField[];
  schema: z.ZodType<Record<string, string>>;
  encodes: boolean;
  requires?: 'whisper';
  output: Output;
  build(p: Record<string, string>, c: BuildContext): Step[];
}

const TIME = /^(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)(?:\.(\d{1,3}))?$/;

/** `HH:MM:SS(.mmm)` or `MM:SS` to milliseconds. */
export function parseTime(t: string): number {
  const m = TIME.exec(t);
  if (!m) throw new Error(`Not a time: ${t}`);
  return (Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 + Number((m[4] ?? '0').padEnd(3, '0'));
}

export const fmtTime = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};

const secs = (ms: number) => (ms / 1000).toFixed(3);
const time = z.string().regex(TIME, 'A time such as 00:09:15');
const input = (c: BuildContext) => ['-protocol_whitelist', 'file', '-f', c.demuxer];

/** Start and end within the media; `end` defaults to its length. */
function span(p: Record<string, string>, c: BuildContext): { start: number; dur: number } {
  const start = p.start ? parseTime(p.start) : 0;
  const end = p.end ? parseTime(p.end) : (c.durationMs ?? 0);
  return { start, dur: Math.max(0, end - start) };
}

export function checkSpan(p: Record<string, string>, durationMs: number | null): string | null {
  if (!p.start && !p.end) return null;
  const start = p.start ? parseTime(p.start) : 0;
  const end = p.end ? parseTime(p.end) : (durationMs ?? 0);
  if (end <= start) return 'The end must be after the start.';
  if (durationMs != null && end > durationMs + 1000) return `The end is after the media ends (${fmtTime(durationMs)}).`;
  return null;
}

const video = (e: Encoder) => (e === 'nvenc' ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', '23'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23']);
const CROPS: Record<string, string | null> = {
  none: null,
  '16:9 centre': "crop='min(iw,ih*16/9)':'min(ih,iw*9/16)'",
  '4:3 centre': "crop='min(iw,ih*4/3)':'min(ih,iw*3/4)'",
  '1:1 centre': "crop='min(iw,ih)':'min(iw,ih)'"
};
const LOUDNESS: Record<string, string> = { '-16 LUFS': '-16', '-14 LUFS': '-14', '-23 LUFS': '-23' };
const PEAK: Record<string, string> = { '-1.5 dBTP': '-1.5', '-1 dBTP': '-1' };
const LANGS = ['auto', 'en', 'de', 'fr', 'es', 'it', 'nl', 'pt'];

export const PRESETS: Preset[] = [
  {
    id: 'clip-720p',
    sub: 'H.264 and AAC',
    kinds: ['video'],
    encodes: true,
    fields: [
      { name: 'start', label: 'Start', type: 'time', default: '00:00:00' },
      { name: 'end', label: 'End', type: 'time', default: '' },
      { name: 'height', label: 'Height', type: 'select', options: ['720', '480', '1080'], default: '720' },
      { name: 'crop', label: 'Crop', type: 'select', options: Object.keys(CROPS), default: 'none' }
    ],
    schema: z.object({ start: time.default('00:00:00'), end: time.optional(), height: z.enum(['720', '480', '1080']).default('720'), crop: z.enum(['none', '16:9 centre', '4:3 centre', '1:1 centre']).default('none') }).strict() as unknown as z.ZodType<Record<string, string>>,
    output: { match: (f) => f === 'clip.mp4', type: 'video/mp4', kind: 'video' },
    build(p, c) {
      const { start, dur } = span(p, c);
      const vf = [CROPS[p.crop ?? 'none'], `scale=-2:${p.height ?? '720'}`].filter(Boolean).join(',');
      return [{ tool: 'ffmpeg', stage: 'Encoding', durationMs: dur, weight: 1, args: ['-ss', secs(start), ...input(c), '-i', c.input, '-t', secs(dur), '-map', '0:v:0', '-map', '0:a:0?', '-vf', vf, ...video(c.encoder), '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-f', 'mp4', path.join(c.outDir, 'clip.mp4')] }];
    }
  },
  {
    id: 'transcribe-srt',
    sub: 'whisper.cpp, SRT',
    kinds: ['video', 'audio'],
    encodes: false,
    requires: 'whisper',
    fields: [{ name: 'language', label: 'Language', type: 'select', options: LANGS, default: 'auto' }],
    schema: z.object({ language: z.enum(LANGS as [string, ...string[]]).default('auto') }).strict() as unknown as z.ZodType<Record<string, string>>,
    output: { match: (f) => f === 'transcript.srt', type: 'application/x-subrip', kind: 'subtitles' },
    build(p, c) {
      const wav = path.join(c.outDir, 'audio.wav');
      return [
        { tool: 'ffmpeg', stage: 'Extracting audio', durationMs: c.durationMs, weight: 0.15, args: [...input(c), '-i', c.input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', wav] },
        { tool: 'whisper', stage: 'Transcribing', durationMs: c.durationMs, weight: 0.85, args: ['-m', c.whisperModel ?? '', '-f', wav, '-l', p.language ?? 'auto', '-osrt', '-of', path.join(c.outDir, 'transcript'), '-pp', '-np'] }
      ];
    }
  },
  {
    id: 'frames-1fps',
    sub: 'for vision captions',
    kinds: ['video'],
    encodes: false,
    fields: [
      { name: 'start', label: 'Start', type: 'time', default: '00:00:00' },
      { name: 'end', label: 'End', type: 'time', default: '' },
      { name: 'fps', label: 'Frames per second', type: 'select', options: ['1', '0.5', '2'], default: '1' },
      { name: 'maxFrames', label: 'Max frames', type: 'select', options: ['48', '96', '200'], default: '48' }
    ],
    schema: z.object({ start: time.default('00:00:00'), end: time.optional(), fps: z.enum(['1', '0.5', '2']).default('1'), maxFrames: z.enum(['48', '96', '200']).default('48') }).strict() as unknown as z.ZodType<Record<string, string>>,
    output: { match: (f) => /^frame-\d{4}\.jpg$/.test(f), type: 'image/jpeg', kind: 'frames' },
    build(p, c) {
      const { start, dur } = span(p, c);
      return [{ tool: 'ffmpeg', stage: 'Sampling frames', durationMs: dur, weight: 1, args: ['-ss', secs(start), ...input(c), '-i', c.input, '-t', secs(dur), '-vf', `fps=${p.fps ?? '1'},scale=-2:480`, '-frames:v', p.maxFrames ?? '48', '-q:v', '3', '-f', 'image2', path.join(c.outDir, 'frame-%04d.jpg')] }];
    }
  },
  {
    id: 'normalise-audio',
    sub: 'loudness to -16 LUFS',
    kinds: ['video', 'audio'],
    encodes: false,
    fields: [
      { name: 'loudness', label: 'Target loudness', type: 'select', options: Object.keys(LOUDNESS), default: '-16 LUFS' },
      { name: 'truePeak', label: 'True peak', type: 'select', options: Object.keys(PEAK), default: '-1.5 dBTP' }
    ],
    schema: z.object({ loudness: z.enum(['-16 LUFS', '-14 LUFS', '-23 LUFS']).default('-16 LUFS'), truePeak: z.enum(['-1.5 dBTP', '-1 dBTP']).default('-1.5 dBTP') }).strict() as unknown as z.ZodType<Record<string, string>>,
    output: { match: (f) => f === 'normalised.mp4' || f === 'normalised.m4a', type: 'video/mp4', kind: 'audio' },
    build(p, c) {
      const af = `loudnorm=I=${LOUDNESS[p.loudness ?? '-16 LUFS']}:TP=${PEAK[p.truePeak ?? '-1.5 dBTP']}:LRA=11`;
      const hasVideo = c.height != null;
      const out = path.join(c.outDir, hasVideo ? 'normalised.mp4' : 'normalised.m4a');
      return [{ tool: 'ffmpeg', stage: 'Measuring and normalising loudness', durationMs: c.durationMs, weight: 1, args: [...input(c), '-i', c.input, '-map', '0:a:0', ...(hasVideo ? ['-map', '0:v:0', '-c:v', 'copy'] : []), '-af', af, '-c:a', 'aac', '-b:a', '192k', '-f', hasVideo ? 'mp4' : 'ipod', out] }];
    }
  }
];

export const presetById = (id: string): Preset | undefined => PRESETS.find((p) => p.id === id);

/** Ingest: the same file rewritten without metadata (GPS, device, author), and preview pictures. */
export function ingestSteps(c: { input: string; demuxer: string; muxer: string; ext: string; kind: MediaKind; outDir: string; durationMs: number | null }): Step[] {
  const inArgs = ['-protocol_whitelist', 'file', '-f', c.demuxer, '-i', c.input];
  const clean = path.join(c.outDir, `clean.${c.ext}`);
  if (c.kind === 'image') {
    const codec = c.ext === 'jpg' ? ['-c:v', 'mjpeg', '-q:v', '2'] : ['-c:v', 'png'];
    return [
      { tool: 'ffmpeg', stage: 'Removing metadata', durationMs: null, weight: 0.5, args: [...inArgs, '-map_metadata', '-1', '-frames:v', '1', ...codec, '-f', 'image2', clean] },
      { tool: 'ffmpeg', stage: 'Drawing a preview', durationMs: null, weight: 0.5, args: [...inArgs, '-vf', "scale='min(800,iw)':-2", '-frames:v', '1', '-q:v', '4', '-f', 'image2', path.join(c.outDir, 'preview-00.jpg')] }
    ];
  }
  const steps: Step[] = [{ tool: 'ffmpeg', stage: 'Removing metadata', durationMs: c.durationMs, weight: 0.6, args: [...inArgs, '-map', '0', '-map_metadata', '-1', '-c', 'copy', '-f', c.muxer, clean] }];
  if (c.kind === 'video') {
    const every = Math.max(0.1, (c.durationMs ?? 14_000) / 1000 / 14);
    steps.push({ tool: 'ffmpeg', stage: 'Drawing the frame strip', durationMs: c.durationMs, weight: 0.4, args: [...inArgs, '-vf', `fps=1/${every.toFixed(3)},scale=160:-2`, '-frames:v', '14', '-q:v', '5', '-f', 'image2', path.join(c.outDir, 'preview-%02d.jpg')] });
  } else {
    steps.push({ tool: 'ffmpeg', stage: 'Drawing the waveform', durationMs: c.durationMs, weight: 0.4, args: [...inArgs, '-filter_complex', 'showwavespic=s=800x160:colors=white', '-frames:v', '1', '-f', 'image2', path.join(c.outDir, 'preview-00.png')] });
  }
  return steps;
}
