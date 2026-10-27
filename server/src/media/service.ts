import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import type { Logger } from 'pino';
import { json, type Db } from '../db/knex.js';
import { clears, labelRank, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import type { AuditLog } from '../audit/chain.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { BlobStore } from '../platform/blob.js';
import { TOPICS, type Bus } from '../platform/bus.js';
import type { DataKeys } from '../platform/datakeys.js';
import type { JobContext, JobQueue } from '../platform/jobs.js';
import type { Notifications } from '../platform/notifications.js';
import type { QuotaService } from '../tenancy/quotas.js';
import type { Guardrails } from '../guardrails/types.js';
import type { ImageSafety } from '../images/safety.js';
import { checkSpan, fmtTime, ingestSteps, parseTime, presetById, PRESETS, type Encoder, type MediaKind, type Step } from './presets.js';
import { MediaToolError, sniffContainer, type MediaRunner } from './runner.js';

export interface MediaCaps {
  maxBytes: number;
  maxDurationMs: number;
  maxWidth: number;
  maxHeight: number;
  maxStreams: number;
}

export interface MediaDeps {
  db: Db;
  keys: DataKeys;
  blobs: BlobStore;
  jobs: JobQueue;
  bus: Bus;
  audit: AuditLog;
  quotas: QuotaService;
  notifications: Notifications;
  log: Logger;
  runner: MediaRunner;
  safety: () => ImageSafety;
  safetyThreshold: number;
  /** IMAGE_SAFETY_REQUIRED (B-1007): without a classifier, sampled frames are withheld. */
  safetyRequired?: boolean;
  guardrails: () => Guardrails;
  caps: MediaCaps;
  encoder: 'auto' | 'nvenc' | 'cpu';
  workDir?: string;
  whisper?: { bin: string; model: string };
}

export interface AssetRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  user_id: string;
  name: string;
  kind: MediaKind | null;
  format: string | null;
  size: number;
  sha256: string;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  streams: { type: string; codec: string }[];
  previews: number;
  state: 'quarantined' | 'probing' | 'ready' | 'refused' | 'hidden';
  label: Label;
  reason: string | null;
  blob_key: string | null;
  created_at: number;
}

export interface MediaJobRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  user_id: string;
  asset_id: string;
  preset: string;
  params: Record<string, string>;
  encoder: Encoder | null;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  stage: string | null;
  progress: number;
  job_id: string | null;
  node: string | null;
  outputs: { name: string; type: string; size: number; key: string }[];
  result: { words?: number; frames?: number; withheld?: number; withheldAt?: string[]; masked?: number; classifier?: string | null } | null;
  label: Label;
  error: string | null;
  created_at: number;
  finished_at: number | null;
}

const n0 = (v: unknown) => (v == null ? null : Number(v));
const assetFrom = (r: Record<string, unknown>): AssetRow => ({ ...(r as unknown as AssetRow), size: Number(r.size), duration_ms: n0(r.duration_ms), width: n0(r.width), height: n0(r.height), previews: Number(r.previews ?? 0), streams: json(r.streams, []), created_at: Number(r.created_at) });
const jobFrom = (r: Record<string, unknown>): MediaJobRow => ({ ...(r as unknown as MediaJobRow), params: json(r.params, {}), outputs: json(r.outputs, []), result: json(r.result, null), progress: Number(r.progress ?? 0), created_at: Number(r.created_at), finished_at: n0(r.finished_at) });

export const assetView = (a: AssetRow, names?: Map<string, string>) => ({
  id: a.id,
  name: a.name,
  kind: a.kind,
  format: a.format,
  size: a.size,
  durationMs: a.duration_ms,
  width: a.width,
  height: a.height,
  streams: a.streams,
  previews: a.previews,
  state: a.state,
  label: a.label,
  reason: a.reason,
  uploadedBy: a.user_id,
  uploadedByName: names?.get(a.user_id) ?? null,
  createdAt: a.created_at
});

/**
 * An SRT transcript as plain text for a knowledge base: one line per cue, starting with the cue's start time
 * (`[00:01:02] …`), without the cue numbers and end times.
 */
export function transcriptText(srt: string): string {
  return srt
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((cue) => {
      const lines = cue.split('\n').filter((l) => l.trim());
      const at = lines.findIndex((l) => /-->/.test(l));
      if (at < 0) return '';
      const start = /(\d{1,2}:\d{2}:\d{2})/.exec(lines[at]!)?.[1] ?? '';
      const text = lines.slice(at + 1).join(' ').trim();
      return text ? `[${start}] ${text}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

export const mediaJobView = (j: MediaJobRow) => ({ id: j.id, assetId: j.asset_id, preset: j.preset, params: j.params, encoder: j.encoder, state: j.state, stage: j.stage, progress: j.progress, node: j.node, outputs: j.outputs.map((o, i) => ({ index: i, name: o.name, type: o.type, size: o.size })), result: j.result, label: j.label, error: j.error, createdAt: j.created_at, finishedAt: j.finished_at });

/**
 * Media: uploads go to sealed quarantine, then an ingest job recognises the container from its bytes, probes it,
 * refuses anything above the caps before any processing starts, rewrites it without metadata and draws previews.
 * Presets run as jobs with progress parsed from ffmpeg; outputs are sealed in the blob store with the asset's label.
 */
export class MediaService {
  constructor(private readonly d: MediaDeps) {
    d.jobs.register('media.ingest', (p, ctx) => this.ingest(String(p.id), ctx), { timeoutMs: 30 * 60_000 });
    d.jobs.register('media.process', (p, ctx) => this.process(String(p.id), ctx), { timeoutMs: 3 * 3_600_000 });
  }

  get caps(): MediaCaps {
    return this.d.caps;
  }

  presets() {
    return PRESETS.map((p) => {
      const missing = p.requires === 'whisper' && !this.d.whisper;
      return { id: p.id, sub: p.sub, kinds: p.kinds, fields: p.fields, encodes: p.encodes, available: !missing, reason: missing ? 'Transcription needs whisper.cpp on the media worker (MEDIA_WHISPER_BIN and MEDIA_WHISPER_MODEL).' : null, model: p.requires === 'whisper' && this.d.whisper ? path.basename(this.d.whisper.model) : null };
    });
  }

  async encoderFor(preset: { encodes: boolean }): Promise<Encoder> {
    if (!preset.encodes) return 'cpu';
    if (this.d.encoder === 'cpu') return 'cpu';
    if (this.d.encoder === 'nvenc') return 'nvenc';
    return (await this.d.runner.nvenc()) ? 'nvenc' : 'cpu';
  }

  // ---------- sealing and blobs ----------

  private async putSealed(tenantId: string, key: string, data: Buffer): Promise<void> {
    await this.d.blobs.put(key, Buffer.from(await this.d.keys.sealBytes(tenantId, data, `media:${key}`)));
  }

  private async getSealed(tenantId: string, key: string): Promise<Buffer> {
    const sealed = await this.d.blobs.get(key);
    if (!sealed) throw notFound('Media content');
    return this.d.keys.openBytes(tenantId, sealed.toString(), `media:${key}`);
  }

  private emit(userId: string, event: string, data: Record<string, unknown>): void {
    this.d.bus.publish(TOPICS.chatEvent, { userId, event, data });
  }

  // ---------- assets ----------

  private scope(p: Principal) {
    return { tenant_id: p.tenantId, workspace_id: p.workspaceId ?? null };
  }

  async asset(p: Principal, id: string): Promise<AssetRow> {
    const r = await this.d.db('media_assets').where({ ...this.scope(p), id }).first();
    if (!r) throw notFound('Asset');
    const a = assetFrom(r);
    if (!clears(p.clearance, a.label)) throw notFound('Asset');
    return a;
  }

  async names(ids: string[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids)];
    if (!uniq.length) return new Map();
    const rows = (await this.d.db('users').whereIn('id', uniq).select('id', 'display_name', 'username')) as { id: string; display_name: string | null; username: string }[];
    return new Map(rows.map((u) => [u.id, u.display_name || u.username]));
  }

  /** Assets in the caller's workspace, up to their clearance. */
  async list(p: Principal) {
    const rows = ((await this.d.db('media_assets').where(this.scope(p)).orderBy('created_at', 'desc').limit(200)) as Record<string, unknown>[]).map(assetFrom).filter((a) => clears(p.clearance, a.label));
    const names = await this.names(rows.map((a) => a.user_id));
    return rows.map((a) => assetView(a, names));
  }

  /** Stores an upload (already streamed to `file`) in sealed quarantine and starts the ingest job. */
  async upload(p: Principal, input: { name: string; label: Label; file: string; size: number; sha256: string }): Promise<AssetRow> {
    if (!clears(p.clearance, input.label)) throw forbidden('Above your clearance.', { step: 'clearance' });
    if (p.workspaceId) {
      const ws = (await this.d.db('workspaces').where({ id: p.workspaceId }).first('label_ceiling')) as { label_ceiling: Label } | undefined;
      if (ws && labelRank(input.label) > labelRank(ws.label_ceiling)) throw forbidden(`This workspace's ceiling is ${ws.label_ceiling}.`, { step: 'zone' });
    }
    const id = ulid();
    const key = `media/quarantine/${p.tenantId}/${id}`;
    await this.putSealed(p.tenantId, key, await readFile(input.file));
    const row: AssetRow = { id, tenant_id: p.tenantId, workspace_id: p.workspaceId ?? null, user_id: p.userId, name: input.name.slice(0, 255), kind: null, format: null, size: input.size, sha256: input.sha256, duration_ms: null, width: null, height: null, streams: [], previews: 0, state: 'quarantined', label: input.label, reason: null, blob_key: key, created_at: Date.now() };
    await this.d.db('media_assets').insert({ ...row, streams: null });
    await this.d.jobs.enqueue({ tenantId: p.tenantId, type: 'media.ingest', payload: { id }, createdBy: p.userId, maxAttempts: 2 });
    return row;
  }

  async content(a: AssetRow): Promise<Buffer> {
    if (a.state !== 'ready' || !a.blob_key) throw conflict(`${a.name} is ${a.state}.`);
    return this.getSealed(a.tenant_id, a.blob_key);
  }

  async preview(a: AssetRow, i: number): Promise<{ data: Buffer; type: string }> {
    if (a.state !== 'ready' || i < 0 || i >= a.previews) throw notFound('Preview');
    const data = await this.getSealed(a.tenant_id, `media/${a.tenant_id}/${a.id}/preview-${i}`);
    return { data, type: data[0] === 0x89 ? 'image/png' : 'image/jpeg' };
  }

  typeOf(a: AssetRow): string {
    const f = a.format ?? '';
    if (a.kind === 'image') return f.includes('png') || f.includes('webp') ? 'image/png' : 'image/jpeg';
    if (f.includes('matroska')) return a.kind === 'audio' ? 'audio/webm' : 'video/webm';
    if (f.includes('mp4') || f.includes('mov')) return a.kind === 'audio' ? 'audio/mp4' : 'video/mp4';
    return { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac' }[f] ?? 'application/octet-stream';
  }

  private async refuse(a: AssetRow, reason: string): Promise<{ state: 'refused'; reason: string }> {
    if (a.blob_key) await this.d.blobs.delete(a.blob_key).catch(() => undefined);
    await this.d.db('media_assets').where({ id: a.id }).update({ state: 'refused', reason: reason.slice(0, 500), blob_key: null });
    this.emit(a.user_id, 'media.asset', { id: a.id, state: 'refused', reason });
    await this.d.audit.append({ tenantId: a.tenant_id, action: 'media.refused', kind: 'system', actor: { service: 'media' }, target: { asset: a.id, name: a.name }, label: a.label, detail: { reason } });
    return { state: 'refused', reason };
  }

  /** Probe, caps, metadata removal and previews. Nothing above a cap is processed any further. */
  private async ingest(id: string, ctx: JobContext): Promise<unknown> {
    const row = await this.d.db('media_assets').where({ id }).first();
    if (!row) return { skipped: 'missing' };
    const a = assetFrom(row);
    if (a.state === 'ready' || a.state === 'refused') return { state: a.state };
    await this.d.db('media_assets').where({ id }).update({ state: 'probing' });
    this.emit(a.user_id, 'media.asset', { id, state: 'probing' });
    const dir = await mkdtemp(path.join(this.d.workDir ?? tmpdir(), 'exprsn-media-'));
    try {
      const data = await this.getSealed(a.tenant_id, a.blob_key!);
      const c = sniffContainer(data);
      if (!c) return await this.refuse(a, 'Not an accepted media type. Accepted: MP4, MOV, MKV, WebM, MP3, M4A, WAV, OGG, FLAC, AAC, PNG, JPEG, WebP.');
      const caps = this.d.caps;
      if (data.length > caps.maxBytes) return await this.refuse(a, `The file is ${(data.length / 1e6).toFixed(0)} MB; the cap is ${(caps.maxBytes / 1e6).toFixed(0)} MB, set by the system admin.`);
      const input = path.join(dir, `input.${c.ext}`);
      await writeFile(input, data, { mode: 0o600 });
      await ctx.progress(10, 'Probing');
      let probe;
      try {
        probe = await this.d.runner.probe(input, c.demuxer, ctx.signal);
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        return await this.refuse(a, `The file could not be read as ${c.demuxer}: ${(err as Error).message.slice(0, 200)}`);
      }
      const hasVideo = probe.streams.some((s) => s.type === 'video');
      const kind: MediaKind | null = c.kind === 'image' ? 'image' : hasVideo ? 'video' : probe.streams.some((s) => s.type === 'audio') ? 'audio' : null;
      if (!kind) return await this.refuse(a, 'The file has no audio or video stream.');
      if (kind !== 'image' && probe.durationMs != null && probe.durationMs > caps.maxDurationMs) return await this.refuse(a, `ffprobe reports ${fmtTime(probe.durationMs)} and the duration cap is ${fmtTime(caps.maxDurationMs)}. Caps are set by the system admin under Platform.`);
      if (probe.width && probe.height && kind !== 'image') {
        const fits = (probe.width <= caps.maxWidth && probe.height <= caps.maxHeight) || (probe.width <= caps.maxHeight && probe.height <= caps.maxWidth);
        if (!fits) return await this.refuse(a, `ffprobe reports ${probe.width} x ${probe.height} and the resolution cap is ${caps.maxWidth} x ${caps.maxHeight}. Nothing was queued. Caps are set by the system admin under Platform.`);
      }
      if (probe.streams.length > caps.maxStreams) return await this.refuse(a, `The file has ${probe.streams.length} streams; the cap is ${caps.maxStreams}, set by the system admin.`);

      const steps = ingestSteps({ input, demuxer: c.demuxer, muxer: c.muxer, ext: c.ext, kind, outDir: dir, durationMs: probe.durationMs });
      await this.runSteps(steps, ctx, (pct, stage) => ctx.progress(10 + pct * 0.8, stage));
      const clean = await readFile(path.join(dir, `clean.${c.ext}`));
      const base = `media/${a.tenant_id}/${a.id}`;
      await this.putSealed(a.tenant_id, `${base}/source`, clean);
      const previews = (await readdir(dir)).filter((f) => /^preview-\d+\.(jpg|png)$/.test(f)).sort();
      for (const [i, f] of previews.entries()) await this.putSealed(a.tenant_id, `${base}/preview-${i}`, await readFile(path.join(dir, f)));
      await this.d.blobs.delete(a.blob_key!).catch(() => undefined);
      const upd = { state: 'ready', kind, format: probe.format.slice(0, 60), size: clean.length, duration_ms: kind === 'image' ? null : probe.durationMs, width: probe.width, height: probe.height, streams: JSON.stringify(probe.streams), previews: previews.length, blob_key: `${base}/source`, reason: null };
      await this.d.db('media_assets').where({ id }).update(upd);
      this.emit(a.user_id, 'media.asset', { id, state: 'ready' });
      return { state: 'ready', kind, durationMs: probe.durationMs, width: probe.width, height: probe.height };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---------- jobs ----------

  async runPreset(p: Principal, assetId: string, presetId: string, raw: Record<string, unknown>): Promise<MediaJobRow> {
    const a = await this.asset(p, assetId);
    if (a.state !== 'ready') throw conflict(a.state === 'refused' ? `Refused at probe: ${a.reason}` : a.state === 'hidden' ? `${a.name} is hidden by moderation.` : `${a.name} is still being probed.`);
    const preset = presetById(presetId);
    if (!preset) throw notFound('Preset');
    if (!preset.kinds.includes(a.kind!)) throw conflict(`${preset.id} does not apply to ${a.kind} files.`);
    if (preset.requires === 'whisper' && !this.d.whisper) throw new HttpProblem(409, 'Preset unavailable', 'Transcription needs whisper.cpp on the media worker; an administrator sets MEDIA_WHISPER_BIN and MEDIA_WHISPER_MODEL.');
    const r = preset.schema.safeParse(raw);
    if (!r.success) throw badRequest('The parameters did not validate against the preset.', { errors: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    const spanError = checkSpan(r.data, a.duration_ms);
    if (spanError) throw badRequest(spanError);
    const encoder = await this.encoderFor(preset);
    if (encoder === 'nvenc') await this.admit(p);
    const row: MediaJobRow = { id: ulid(), tenant_id: a.tenant_id, workspace_id: a.workspace_id, user_id: p.userId, asset_id: a.id, preset: preset.id, params: r.data, encoder, state: 'queued', stage: 'Queued', progress: 0, job_id: null, node: null, outputs: [], result: null, label: a.label, error: null, created_at: Date.now(), finished_at: null };
    await this.d.db('media_jobs').insert({ ...row, params: JSON.stringify(row.params), outputs: null, result: null });
    const job = await this.d.jobs.enqueue({ tenantId: a.tenant_id, type: 'media.process', payload: { id: row.id }, createdBy: p.userId, maxAttempts: 2 });
    await this.d.db('media_jobs').where({ id: row.id }).update({ job_id: job.id });
    row.job_id = job.id;
    return row;
  }

  private async admit(p: Principal): Promise<void> {
    const [tenant, ws] = await Promise.all([this.d.db('tenants').where({ id: p.tenantId }).first('name'), p.workspaceId ? this.d.db('workspaces').where({ id: p.workspaceId }).first('name') : undefined]);
    await this.d.quotas.admit(p.tenantId, p.workspaceId ?? null, { tenantName: tenant?.name, workspaceName: ws?.name });
  }

  async jobs(p: Principal, assetId: string): Promise<MediaJobRow[]> {
    const a = await this.asset(p, assetId);
    return ((await this.d.db('media_jobs').where({ asset_id: a.id }).orderBy('created_at', 'desc').limit(100)) as Record<string, unknown>[]).map(jobFrom);
  }

  async job(p: Principal, id: string): Promise<MediaJobRow> {
    const r = await this.d.db('media_jobs').where({ tenant_id: p.tenantId, id }).first();
    if (!r) throw notFound('Media job');
    const j = jobFrom(r);
    await this.asset(p, j.asset_id); // same workspace and cleared for its label
    return j;
  }

  async cancel(p: Principal, id: string): Promise<MediaJobRow> {
    const j = await this.job(p, id);
    if (j.state !== 'queued' && j.state !== 'running') return j;
    if (j.user_id !== p.userId) throw forbidden('Only the person who queued the job can cancel it.', { step: 'role' });
    if (j.job_id) await this.d.jobs.cancel(j.tenant_id, j.job_id);
    const after = await this.d.db('media_jobs').where({ id: j.id }).whereIn('state', ['queued', 'running']).update({ state: 'cancelled', stage: `Cancelled at ${j.progress}%`, finished_at: Date.now() });
    if (after) this.emit(j.user_id, 'media.job', { id: j.id, assetId: j.asset_id, state: 'cancelled', progress: j.progress });
    return jobFrom(await this.d.db('media_jobs').where({ id: j.id }).first());
  }

  async output(p: Principal, id: string, index: number): Promise<{ data: Buffer; name: string; type: string; job: MediaJobRow }> {
    const j = await this.job(p, id);
    const o = j.outputs[index];
    if (j.state !== 'succeeded' || !o) throw notFound('Output');
    return { data: await this.getSealed(j.tenant_id, o.key), name: o.name, type: o.type, job: j };
  }

  private async update(j: MediaJobRow, patch: Partial<MediaJobRow>): Promise<void> {
    const row: Record<string, unknown> = { ...patch };
    if (patch.outputs) row.outputs = JSON.stringify(patch.outputs);
    if (patch.result) row.result = JSON.stringify(patch.result);
    await this.d.db('media_jobs').where({ id: j.id }).update(row);
    Object.assign(j, patch);
    this.emit(j.user_id, 'media.job', { id: j.id, assetId: j.asset_id, preset: j.preset, state: j.state, stage: j.stage, progress: j.progress, encoder: j.encoder, error: j.error, result: j.result });
  }

  /** Runs steps in order; `report` gets overall progress 0–100 across their weights and the current stage. */
  private async runSteps(steps: Step[], ctx: JobContext, report: (pct: number, stage: string) => Promise<void>): Promise<void> {
    const total = steps.reduce((s, x) => s + x.weight, 0) || 1;
    let done = 0;
    for (const s of steps) {
      let last = 0;
      await report((done / total) * 100, s.stage);
      await this.d.runner.run(s.tool, s.args, {
        signal: ctx.signal,
        durationMs: s.durationMs,
        onProgress: (f) => {
          const now = Date.now();
          if (now - last < 1000 && f < 1) return;
          last = now;
          void report(((done + f * s.weight) / total) * 100, s.stage).catch(() => undefined);
        }
      });
      done += s.weight;
    }
  }

  private async process(id: string, ctx: JobContext): Promise<unknown> {
    const r = await this.d.db('media_jobs').where({ id }).first();
    if (!r) return { skipped: 'missing' };
    const j = jobFrom(r);
    if (j.state === 'cancelled' || j.state === 'succeeded') return { state: j.state };
    const a = assetFrom(await this.d.db('media_assets').where({ id: j.asset_id }).first());
    const preset = presetById(j.preset)!;
    const started = Date.now();
    await this.update(j, { state: 'running', stage: 'Preparing', progress: 0, node: hostname().slice(0, 100) });
    const dir = await mkdtemp(path.join(this.d.workDir ?? tmpdir(), 'exprsn-media-'));
    try {
      const ext = a.kind === 'image' ? (a.format?.includes('png') || a.format?.includes('webp') ? 'png' : 'jpg') : 'bin';
      const input = path.join(dir, `input.${ext}`);
      await writeFile(input, await this.content(a), { mode: 0o600 });
      const c = sniffContainer(await readFile(input).then((b) => b.subarray(0, 64)));
      if (!c) throw new MediaToolError('The stored file is not a recognised container.');
      const report = async (pct: number, stage: string) => {
        const progress = Math.round(Math.min(99, pct * 0.9));
        await ctx.progress(progress, stage);
        await this.update(j, { stage, progress });
      };
      const build = (encoder: Encoder) => preset.build(j.params, { input, demuxer: c.demuxer, outDir: dir, durationMs: a.duration_ms, height: a.height, encoder, ...(this.d.whisper ? { whisperModel: this.d.whisper.model } : {}) });
      try {
        await this.runSteps(build(j.encoder ?? 'cpu'), ctx, report);
      } catch (err) {
        if (ctx.signal.aborted || j.encoder !== 'nvenc') throw err;
        // NVENC can be listed but unusable (no GPU in this container, all sessions busy): fall back to the CPU encoder.
        this.d.log.warn({ job: j.id, err: (err as Error).message }, 'NVENC failed; retrying with libx264');
        await this.update(j, { encoder: 'cpu', stage: 'NVENC unavailable; encoding on the CPU' });
        await this.runSteps(build('cpu'), ctx, report);
      }

      const files = (await readdir(dir)).filter(preset.output.match).sort();
      if (!files.length) throw new MediaToolError('The preset produced no output.');
      const result: NonNullable<MediaJobRow['result']> = {};
      const keep: { name: string; data: Buffer; type: string }[] = [];
      if (preset.output.kind === 'frames') {
        await report(92, 'Checking frames with the image-safety classifier');
        const safety = this.d.safety();
        const fps = Number(j.params.fps ?? '1');
        const start = j.params.start ? parseTime(j.params.start) : 0;
        result.withheld = 0;
        result.withheldAt = [];
        result.classifier = safety.name === 'none' ? null : safety.name;
        const unclassifiedWithheld = !!this.d.safetyRequired && safety.name === 'none';
        for (const [i, f] of files.entries()) {
          const data = await readFile(path.join(dir, f));
          const v = unclassifiedWithheld ? null : await safety.classify(data, 'image/jpeg', ctx.signal);
          if (unclassifiedWithheld || (v && v.score >= this.d.safetyThreshold)) {
            result.withheld++;
            result.withheldAt.push(fmtTime(start + (i / fps) * 1000));
            continue;
          }
          keep.push({ name: f, data, type: preset.output.type });
        }
        result.frames = keep.length;
        if (result.withheld) {
          await this.d.audit.append({ tenantId: j.tenant_id, action: 'media.frames.withheld', kind: 'system', actor: { service: 'media' }, target: { asset: a.id, job: j.id }, label: j.label, detail: { withheld: result.withheld, at: result.withheldAt, classifier: result.classifier, ...(unclassifiedWithheld ? { reason: 'not classified', required: true } : {}) } });
        }
      } else if (preset.output.kind === 'subtitles') {
        await report(95, 'Checking the transcript with guardrails');
        const text = (await readFile(path.join(dir, files[0]!))).toString('utf8');
        const d = await this.d.guardrails().check({ tenantId: j.tenant_id, workspaceId: j.workspace_id, checkpoint: 'media', text, label: j.label, source: { kind: 'media-job', id: j.id }, meta: { preset: j.preset, asset: a.id } });
        if (d.action === 'block' || d.action === 'require-approval') throw new MediaToolError(`The transcript was blocked by guardrails${d.reason ? `: ${d.reason}` : '.'}`);
        const out = d.action === 'redact' ? d.text : text;
        result.masked = d.action === 'redact' ? Math.max(1, d.findings.filter((f) => f.action === 'redact' && f.stage === 'enforce').length) : 0;
        result.words = out.split('\n').filter((l) => l && !/^\d+$/.test(l.trim()) && !/-->/.test(l)).join(' ').split(/\s+/).filter(Boolean).length;
        keep.push({ name: files[0]!, data: Buffer.from(out, 'utf8'), type: preset.output.type });
      } else {
        for (const f of files) keep.push({ name: f, data: await readFile(path.join(dir, f)), type: f.endsWith('.m4a') ? 'audio/mp4' : preset.output.type });
      }
      const outputs: MediaJobRow['outputs'] = [];
      for (const o of keep) {
        const key = `media/${j.tenant_id}/${a.id}/jobs/${j.id}/${o.name}`;
        await this.putSealed(j.tenant_id, key, o.data);
        outputs.push({ name: o.name, type: o.type, size: o.data.length, key });
      }
      const gpuMs = j.encoder === 'nvenc' ? Date.now() - started : 0;
      if (gpuMs) await this.d.quotas.record({ tenantId: j.tenant_id, workspaceId: j.workspace_id, userId: j.user_id, kind: 'media', model: `ffmpeg ${j.preset}`, gpuMs });
      const stage = preset.output.kind === 'frames' ? `Done, ${result.frames} frame${result.frames === 1 ? '' : 's'}${result.withheld ? `, ${result.withheld} withheld` : ''}` : preset.output.kind === 'subtitles' ? `Done, ${result.words!.toLocaleString('en-US')} words` : 'Done';
      await this.update(j, { state: 'succeeded', stage, progress: 100, outputs, result, finished_at: Date.now() });
      return { outputs: outputs.length, ...result };
    } catch (err) {
      const reason = String((ctx.signal.reason as Error | undefined)?.message ?? '');
      if (ctx.signal.aborted && /cancel/.test(reason)) {
        await this.update(j, { state: 'cancelled', stage: `Cancelled at ${j.progress}%`, finished_at: Date.now() });
        throw err;
      }
      if (ctx.signal.aborted) {
        await this.update(j, { state: 'queued', stage: 'Waiting for a media worker' });
        throw err;
      }
      const message = err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message;
      await this.update(j, { state: 'failed', stage: 'Failed', error: message.slice(0, 1000), finished_at: Date.now() });
      return { state: 'failed', error: message };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
