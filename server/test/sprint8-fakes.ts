import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MediaRunner, MediaTool, ProbeResult, RunOptions } from '../src/media/runner.js';
import type { GenerateProgress, GenerateRequest, GenerateResult, ImageBackend } from '../src/images/backends.js';
import type { ImageSafety, SafetyVerdict } from '../src/images/safety.js';
import { encodePng } from '../src/images/png.js';
import { createDb, migrate } from '../src/db/knex.js';
import { createApp } from '../src/http/app.js';
import { createLogger, Metrics } from '../src/observability/index.js';
import { createServices, type ServiceOverrides } from '../src/services.js';
import { bootstrap } from '../src/bootstrap.js';
import { testConfig, type Harness } from './helpers.js';

/** Like `harness`, with the media runner, image workers and safety classifier replaced. */
export async function harness8(env: Record<string, string> = {}, overrides: ServiceOverrides = {}): Promise<Harness> {
  const cfg = testConfig(env);
  const db = createDb(cfg);
  await migrate(db);
  const s = createServices(cfg, db, createLogger('silent', false), new Metrics(), overrides);
  await bootstrap(s);
  const tenant = await s.tenants.bySlug(cfg.DEFAULT_TENANT);
  return {
    s,
    app: createApp(s),
    tenantId: tenant!.id,
    close: async () => {
      await s.close();
      await db.destroy();
    }
  };
}

// ---------- media ----------

export interface FakeMeta {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  streams: { type: string; codec: string }[];
}

const MARK = 'FAKEMEDIA';

/** A buffer that starts like an MP4 (so the container is recognised) and carries the probe answer. */
export function fakeMp4(meta: Partial<FakeMeta> = {}, extra = ''): Buffer {
  const m: FakeMeta = { durationMs: 60_000, width: 1280, height: 720, streams: [{ type: 'video', codec: 'h264' }, { type: 'audio', codec: 'aac' }], ...meta };
  return Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(12), Buffer.from(`${MARK}${JSON.stringify(m)}${MARK}${extra}`, 'latin1')]);
}

export function fakeWav(durationMs = 30_000): Buffer {
  const h = Buffer.alloc(12);
  h.write('RIFF', 0, 'latin1');
  h.write('WAVE', 8, 'latin1');
  return Buffer.concat([h, Buffer.from(`${MARK}${JSON.stringify({ durationMs, width: null, height: null, streams: [{ type: 'audio', codec: 'pcm_s16le' }] })}${MARK}`, 'latin1')]);
}

/**
 * Stands in for ffmpeg, ffprobe and whisper.cpp: probes read the JSON embedded by `fakeMp4`, and runs write the
 * output file named by the last argument (numbered patterns get several), reporting progress on the way.
 */
export class FakeMediaRunner implements MediaRunner {
  readonly name = 'fake';
  calls: { tool: MediaTool; args: string[] }[] = [];
  probes: { file: string; demuxer: string }[] = [];
  hasNvenc = false;
  /** Makes runs that use h264_nvenc fail, as on a host without a usable GPU. */
  failNvenc = false;
  transcript = '1\n00:00:01,000 --> 00:00:04,000\nGood morning everyone, welcome to the town hall.\n\n2\n00:00:05,000 --> 00:00:09,000\nCall the desk on +44 20 7946 0958 with questions.\n';
  /** When set, runs wait for it (to test cancellation). */
  hold: Promise<void> | null = null;

  async probe(file: string, demuxer: string): Promise<ProbeResult> {
    this.probes.push({ file, demuxer });
    const text = (await readFile(file)).toString('latin1');
    const a = text.indexOf(MARK);
    const b = text.indexOf(MARK, a + MARK.length);
    if (a < 0 || b < 0) throw new Error('Invalid data found when processing input');
    const m = JSON.parse(text.slice(a + MARK.length, b)) as FakeMeta;
    return { format: demuxer === 'mov' ? 'mov,mp4,m4a,3gp,3g2,mj2' : demuxer, ...m };
  }

  async run(tool: MediaTool, args: string[], o: RunOptions): Promise<void> {
    this.calls.push({ tool, args });
    if (this.failNvenc && args.includes('h264_nvenc')) throw new Error('ffmpeg exited with 1: No NVENC capable devices found');
    o.onProgress?.(0.5);
    if (this.hold) await Promise.race([this.hold, new Promise((_, reject) => o.signal.addEventListener('abort', () => reject(o.signal.reason as Error), { once: true }))]);
    if (o.signal.aborted) throw o.signal.reason as Error;
    if (tool === 'whisper') {
      const base = args[args.indexOf('-of') + 1]!;
      await writeFile(`${base}.srt`, this.transcript);
    } else {
      const out = args[args.length - 1]!;
      const input = args[args.indexOf('-i') + 1]!;
      if (/%0\dd/.test(out)) {
        const n = Number(args[args.indexOf('-frames:v') + 1] ?? 3);
        for (let i = 1; i <= n; i++) await writeFile(out.replace(/%0(\d)d/, (_m, w: string) => String(i).padStart(Number(w), '0')), Buffer.from([0xff, 0xd8, 0xff, 0xe0, i]));
      } else if (out.endsWith('.png') || out.endsWith('.jpg')) {
        await writeFile(out, out.endsWith('.png') ? encodePng(2, 2, Buffer.alloc(12, 200)) : Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]));
      } else {
        // Remux and encodes: keep the bytes (so a probe of the output still works) with a marker of what ran.
        await writeFile(out, Buffer.concat([await readFile(input), Buffer.from(`|${path.basename(out)}`)]));
      }
    }
    o.onProgress?.(1);
  }

  async nvenc(): Promise<boolean> {
    return this.hasNvenc;
  }
}

// ---------- images ----------

export class FakeImageBackend implements ImageBackend {
  readonly kind = 'fake';
  readonly label: string;
  readonly model = 'sdxl-base';
  readonly steps = 4;
  requests: GenerateRequest[] = [];
  hold: Promise<void> | null = null;
  gpuMs = 1500;
  safety: number | undefined;

  constructor(
    readonly id = 'fake-sdxl',
    readonly concurrency = 1
  ) {
    this.label = `fake, ${this.model}`;
  }

  async generate(req: GenerateRequest, o: { signal: AbortSignal; onProgress: (p: GenerateProgress) => void }): Promise<GenerateResult> {
    this.requests.push(req);
    if (this.hold) await Promise.race([this.hold, new Promise((_, reject) => o.signal.addEventListener('abort', () => reject(o.signal.reason as Error), { once: true }))]);
    for (let i = 1; i <= req.steps; i++) o.onProgress({ stage: 'Denoising', step: i, steps: req.steps });
    const px = Buffer.alloc(4 * 4 * 3, req.seed % 251);
    return { image: encodePng(4, 4, px), gpuMs: this.gpuMs, model: this.model, ...(this.safety != null ? { safety: this.safety } : {}) };
  }
}

export class FakeSafety implements ImageSafety {
  readonly name = 'fake-classifier';
  seen = 0;
  constructor(public score: (n: number, image: Buffer) => number = () => 0.02) {}
  async classify(image: Buffer): Promise<SafetyVerdict> {
    const n = this.seen++;
    return { score: this.score(n, image), categories: {}, classifier: this.name };
  }
}
