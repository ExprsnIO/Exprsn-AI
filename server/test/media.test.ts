import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkSpan, parseTime, presetById } from '../src/media/presets.js';
import { FfmpegRunner, sniffContainer } from '../src/media/runner.js';
import type { Guardrails } from '../src/guardrails/types.js';
import { localUser, login, type Client, type Harness } from './helpers.js';
import { FakeMediaRunner, FakeSafety, fakeMp4, fakeWav, harness8 } from './sprint8-fakes.js';

const upload = (c: Client, name: string, data: Buffer, label = 'internal') =>
  c.agent.put(`/api/media/assets?name=${encodeURIComponent(name)}&label=${label}`).set('x-csrf-token', c.csrf).set('content-type', 'application/octet-stream').send(data);

describe('media presets', () => {
  it('builds argument arrays from typed parameters only', () => {
    const clip = presetById('clip-720p')!;
    const params = clip.schema.parse({ start: '00:09:15', end: '00:22:20', height: '480', crop: '16:9 centre' });
    const [step] = clip.build(params, { input: '/w/input.mp4', demuxer: 'mov', outDir: '/w', durationMs: 2_530_000, height: 1080, encoder: 'nvenc' });
    expect(step!.args).toEqual(['-ss', '555.000', '-protocol_whitelist', 'file', '-f', 'mov', '-i', '/w/input.mp4', '-t', '785.000', '-map', '0:v:0', '-map', '0:a:0?', '-vf', "crop='min(iw,ih*16/9)':'min(ih,iw*9/16)',scale=-2:480", '-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-f', 'mp4', '/w/clip.mp4']);
    expect(step!.durationMs).toBe(785_000);
    expect(clip.schema.safeParse({ height: '720; rm -rf /' }).success).toBe(false);
    expect(clip.schema.safeParse({ extra: '-i /etc/passwd' }).success).toBe(false);
    expect(clip.schema.safeParse({ start: '9:15; x' }).success).toBe(false);
    expect(parseTime('01:02:03.5')).toBe(3_723_500);
    expect(checkSpan({ start: '00:10:00', end: '00:05:00' }, 2_530_000)).toMatch(/after the start/);
    expect(checkSpan({ start: '00:00:00', end: '01:00:00' }, 2_530_000)).toMatch(/after the media ends/);
  });

  it('recognises containers from their bytes and nothing else', () => {
    expect(sniffContainer(fakeMp4())).toMatchObject({ demuxer: 'mov', kind: 'video' });
    expect(sniffContainer(fakeWav())).toMatchObject({ demuxer: 'wav', kind: 'audio' });
    expect(sniffContainer(Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\nfile:///etc/passwd\n'))).toBeNull();
    expect(sniffContainer(Buffer.from('ffconcat version 1.0\nfile /etc/passwd\n'))).toBeNull();
  });
});

describe('media', () => {
  let h: Harness;
  let runner: FakeMediaRunner;
  let safety: FakeSafety;
  afterEach(async () => {
    await h.close();
  });

  async function setup(env: Record<string, string> = {}) {
    runner = new FakeMediaRunner();
    safety = new FakeSafety();
    h = await harness8({ MEDIA_ENCODER: 'auto', ...env }, { mediaRunner: runner, imageSafety: safety });
    await localUser(h, 'mem', ['member']);
    return login(h, 'mem');
  }

  it('probes an upload, strips metadata, draws previews and seals everything at rest', async () => {
    const m = await setup();
    const caps = (await m.agent.get('/api/media/caps').expect(200)).body;
    expect(caps.caps).toMatchObject({ maxWidth: 1920, maxHeight: 1080, maxDurationMs: 7_200_000, maxStreams: 4 });
    expect(caps.presets.find((p: { id: string }) => p.id === 'transcribe-srt')).toMatchObject({ available: false });

    const a = (await upload(m, 'town-hall.mp4', fakeMp4({ durationMs: 2_530_000, width: 1920, height: 1080 }, 'GPS 51.5N')).expect(202)).body;
    expect(a.state).toBe('quarantined');
    await h.s.jobs.runDue();
    const view = (await m.agent.get(`/api/media/assets/${a.id}`).expect(200)).body;
    expect(view).toMatchObject({ state: 'ready', kind: 'video', durationMs: 2_530_000, width: 1920, height: 1080, previews: 14, uploadedByName: 'MEM', jobs: [] });
    expect(runner.probes[0]!.demuxer).toBe('mov');
    const remux = runner.calls[0]!.args;
    expect(remux).toEqual(expect.arrayContaining(['-protocol_whitelist', 'file', '-f', 'mov', '-map_metadata', '-1', '-c', 'copy']));
    // Stored sealed: the blob never holds the plain bytes.
    const row = await h.s.db('media_assets').where({ id: a.id }).first();
    const blob = (await h.s.blobs.get(row.blob_key))!.toString();
    expect(blob).toMatch(/^v2\./);
    expect(blob).not.toContain('FAKEMEDIA');
    const content = await m.agent.get(`/api/media/assets/${a.id}/content`).buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on('data', (c: Buffer) => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); }).expect(200);
    expect(content.headers['content-type']).toBe('video/mp4');
    expect((content.body as Buffer).toString('latin1')).toContain('FAKEMEDIA');
    const range = await m.agent.get(`/api/media/assets/${a.id}/content`).set('range', 'bytes=4-11').expect(206);
    expect(range.headers['content-range']).toMatch(/^bytes 4-11\//);
    await m.agent.get(`/api/media/assets/${a.id}/previews/13`).expect(200);
    await m.agent.get(`/api/media/assets/${a.id}/previews/14`).expect(404);
    expect((await m.agent.get('/api/media/assets').expect(200)).body.map((x: { id: string }) => x.id)).toEqual([a.id]);
  });

  it('refuses a file above a cap before any processing, naming the cap and who sets it', async () => {
    const m = await setup();
    const a = (await upload(m, 'site-walk.mov', fakeMp4({ width: 3840, height: 2160 })).expect(202)).body;
    const junk = (await upload(m, 'playlist.m3u8', Buffer.from('#EXTM3U\nfile:///etc/passwd\n')).expect(202)).body;
    await h.s.jobs.runDue();
    const view = (await m.agent.get(`/api/media/assets/${a.id}`).expect(200)).body;
    expect(view.state).toBe('refused');
    expect(view.reason).toBe('ffprobe reports 3840 x 2160 and the resolution cap is 1920 x 1080. Nothing was queued. Caps are set by the system admin under Platform.');
    expect((await m.agent.get(`/api/media/assets/${junk.id}`).expect(200)).body.reason).toMatch(/^Not an accepted media type/);
    expect(runner.calls).toHaveLength(0); // nothing ran
    expect(await h.s.db('media_assets').whereNotNull('blob_key')).toHaveLength(0);
    const r = await m.agent.post(`/api/media/assets/${a.id}/jobs`).set('x-csrf-token', m.csrf).send({ preset: 'clip-720p', params: {} }).expect(409);
    expect(r.body.detail).toMatch(/^Refused at probe/);

    // "Ask for a higher cap" notifies the system admins.
    await localUser(h, 'root', ['system-admin']);
    const asked = (await m.agent.post('/api/media/caps/request').set('x-csrf-token', m.csrf).send({ assetId: a.id }).expect(200)).body;
    expect(asked.notified).toBe(1);

    // The size cap is checked on upload.
    await h.close();
    const m2 = await setup({ MEDIA_MAX_BYTES: '2048' });
    const big = await upload(m2, 'big.mp4', Buffer.alloc(4096, 1)).expect(413);
    expect(big.body.detail).toMatch(/upload cap/);
  });

  it('runs a preset as a job with progress, NVENC with a CPU fallback, and stores the output sealed', async () => {
    const m = await setup();
    runner.hasNvenc = true;
    const a = (await upload(m, 'town-hall.mp4', fakeMp4({ durationMs: 2_530_000 })).expect(202)).body;
    await h.s.jobs.runDue();
    const post = (body: object) => m.agent.post(`/api/media/assets/${a.id}/jobs`).set('x-csrf-token', m.csrf).send(body);
    expect((await post({ preset: 'clip-720p', params: { start: '00:09:15', end: '00:22:20', height: '4320' } }).expect(400)).body.errors[0].path).toBe('height');
    expect((await post({ preset: 'clip-720p', params: { start: '00:09:15', end: '01:30:00' } }).expect(400)).body.detail).toMatch(/after the media ends/);
    await post({ preset: 'clip-720p', params: { vf: 'movie=/etc/passwd' } }).expect(400);
    await post({ preset: 'transcribe-srt', params: {} }).expect(409);

    const events: { event: string; data: Record<string, unknown> }[] = [];
    h.s.bus.on<{ event: string; data: Record<string, unknown> }>('chat.event', (e) => events.push(e));
    const job = (await post({ preset: 'clip-720p', params: { start: '00:09:15', end: '00:22:20', height: '720', crop: 'none' } }).expect(202)).body;
    expect(job).toMatchObject({ state: 'queued', encoder: 'nvenc', preset: 'clip-720p' });
    runner.failNvenc = true;
    await h.s.jobs.runDue();
    const done = (await m.agent.get(`/api/media/jobs/${job.id}`).expect(200)).body;
    expect(done).toMatchObject({ state: 'succeeded', encoder: 'cpu', progress: 100, stage: 'Done', outputs: [{ index: 0, name: 'clip.mp4', type: 'video/mp4' }] });
    const encodes = runner.calls.filter((c) => c.args.includes('-vf') && c.args.includes('scale=-2:720'));
    expect(encodes.map((c) => c.args.includes('h264_nvenc'))).toEqual([true, false]);
    expect(encodes[1]!.args).toEqual(expect.arrayContaining(['libx264']));
    const progress = events.filter((e) => e.event === 'media.job' && e.data.id === job.id).map((e) => e.data.state);
    expect(progress).toEqual(expect.arrayContaining(['running', 'succeeded']));
    const out = await m.agent.get(`/api/media/jobs/${job.id}/outputs/0?download=1`).expect(200);
    expect(out.headers['content-disposition']).toBe('attachment; filename="clip.mp4"');
    expect(await h.s.db('audit_events').where({ action: 'media.output.downloaded' })).toHaveLength(1);
    const blobKey = (await h.s.db('media_jobs').where({ id: job.id }).first()).outputs;
    expect(JSON.parse(blobKey)[0].key).toMatch(new RegExp(`^media/${h.tenantId}/${a.id}/jobs/${job.id}/clip.mp4$`));
    // Only an NVENC run is GPU time; this one fell back to the CPU.
    expect(await h.s.db('usage_records').where({ kind: 'media' })).toHaveLength(0);
  });

  it('withholds frames that fail the image-safety classifier and redacts transcripts through guardrails', async () => {
    const m = await setup({ MEDIA_WHISPER_BIN: '/opt/whisper/whisper-cli', MEDIA_WHISPER_MODEL: '/opt/whisper/ggml-large-v3.bin' });
    safety.score = (n) => (n === 1 || n === 3 ? 0.91 : 0.02);
    h.s.guardrails = {
      check: async (i) => (i.checkpoint === 'media' ? { action: 'redact', text: i.text.replace(/\+44 20 7946 0958/g, '[phone redacted]'), findings: [{ ruleId: 'r1', ruleName: 'pii-phone', action: 'redact', stage: 'enforce' }] } : { action: 'allow', text: i.text, findings: [] })
    } satisfies Guardrails;
    const a = (await upload(m, 'town-hall.mp4', fakeMp4({ durationMs: 120_000 })).expect(202)).body;
    await h.s.jobs.runDue();
    const run = (preset: string, params: object) => m.agent.post(`/api/media/assets/${a.id}/jobs`).set('x-csrf-token', m.csrf).send({ preset, params }).expect(202);
    const frames = (await run('frames-1fps', { fps: '1', maxFrames: '48', start: '00:00:10', end: '00:00:16' })).body;
    const words = (await run('transcribe-srt', { language: 'en' })).body;
    await h.s.jobs.runDue();
    const f = (await m.agent.get(`/api/media/jobs/${frames.id}`).expect(200)).body;
    expect(f).toMatchObject({ state: 'succeeded', result: { frames: 46, withheld: 2, withheldAt: ['00:00:11', '00:00:13'], classifier: 'fake-classifier' }, stage: 'Done, 46 frames, 2 withheld' });
    expect(f.outputs).toHaveLength(46);
    const t = (await m.agent.get(`/api/media/jobs/${words.id}`).expect(200)).body;
    expect(t).toMatchObject({ state: 'succeeded', result: { masked: 1 } });
    expect(t.stage).toMatch(/^Done, \d+ words$/);
    const whisper = runner.calls.find((c) => c.tool === 'whisper')!;
    expect(whisper.args.slice(0, 6)).toEqual(['-m', '/opt/whisper/ggml-large-v3.bin', '-f', expect.stringMatching(/audio\.wav$/), '-l', 'en']);
    const srt = (await m.agent.get(`/api/media/jobs/${words.id}/outputs/0`).expect(200)).text;
    expect(srt).toContain('[phone redacted]');
    expect(srt).not.toContain('7946');
    expect(await h.s.db('audit_events').where({ action: 'media.frames.withheld' })).toHaveLength(1);
  });

  it('keeps assets within the workspace and clearance, and lets only the owner cancel a job', async () => {
    const m = await setup();
    const a = (await upload(m, 'call.wav', fakeWav(), 'internal').expect(202)).body;
    await upload(m, 'secret.wav', fakeWav(), 'confidential').expect(403);
    await h.s.jobs.runDue();
    expect((await m.agent.get(`/api/media/assets/${a.id}`).expect(200)).body).toMatchObject({ kind: 'audio', previews: 1 });
    await localUser(h, 'conf', ['member'], 'confidential');
    const c = await login(h, 'conf');
    const secret = (await upload(c, 'secret.wav', fakeWav(), 'confidential').expect(202)).body;
    await h.s.jobs.runDue();
    await m.agent.get(`/api/media/assets/${secret.id}`).expect(404);
    expect((await m.agent.get('/api/media/assets').expect(200)).body.map((x: { id: string }) => x.id)).toEqual([a.id]);
    runner.hold = new Promise(() => undefined);
    await localUser(h, 'other', ['member']);
    const o = await login(h, 'other');
    const job = (await m.agent.post(`/api/media/assets/${a.id}/jobs`).set('x-csrf-token', m.csrf).send({ preset: 'normalise-audio', params: {} }).expect(202)).body;
    await o.agent.post(`/api/media/jobs/${job.id}/cancel`).set('x-csrf-token', o.csrf).expect(403);
    expect((await m.agent.post(`/api/media/jobs/${job.id}/cancel`).set('x-csrf-token', m.csrf).expect(200)).body.state).toBe('cancelled');
    await h.s.jobs.runDue();
    expect((await m.agent.get(`/api/media/jobs/${job.id}`).expect(200)).body.state).toBe('cancelled');
  });
});

// The real adapter, when this machine has ffmpeg: a generated test clip goes through ingest and two presets.
const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-hide_banner', '-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)('media with the real ffmpeg', () => {
  let h: Harness;
  let dir: string;
  afterEach(async () => {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('ingests a generated clip and runs clip-720p and frames-1fps', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'exprsn-ffmpeg-test-'));
    const src = path.join(dir, 'src.mp4');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-metadata', 'location=+51.5-000.1/', '-shortest', src]);
    h = await harness8({ MEDIA_ENCODER: 'cpu' }, { mediaRunner: new FfmpegRunner({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }), imageSafety: new FakeSafety() });
    await localUser(h, 'mem', ['member']);
    const m = await login(h, 'mem');
    const a = (await upload(m, 'test.mp4', readFileSync(src)).expect(202)).body;
    await h.s.jobs.runDue();
    const view = (await m.agent.get(`/api/media/assets/${a.id}`).expect(200)).body;
    expect(view).toMatchObject({ state: 'ready', kind: 'video', width: 640, height: 360 });
    expect(view.durationMs).toBeGreaterThan(3500);
    expect(view.previews).toBeGreaterThan(0);
    const job = (await m.agent.post(`/api/media/assets/${a.id}/jobs`).set('x-csrf-token', m.csrf).send({ preset: 'clip-720p', params: { start: '00:00:01', end: '00:00:03', height: '480' } }).expect(202)).body;
    const frames = (await m.agent.post(`/api/media/assets/${a.id}/jobs`).set('x-csrf-token', m.csrf).send({ preset: 'frames-1fps', params: { fps: '2', maxFrames: '48' } }).expect(202)).body;
    await h.s.jobs.runDue();
    const done = (await m.agent.get(`/api/media/jobs/${job.id}`).expect(200)).body;
    expect(done).toMatchObject({ state: 'succeeded', encoder: 'cpu' });
    expect(done.outputs[0].size).toBeGreaterThan(1000);
    const f = (await m.agent.get(`/api/media/jobs/${frames.id}`).expect(200)).body;
    expect(f.state).toBe('succeeded');
    expect(f.result.frames).toBeGreaterThanOrEqual(7);
  }, 60_000);
});
