import { createHash, randomInt } from 'node:crypto';
import { hostname } from 'node:os';
import { ulid } from 'ulid';
import type { Logger } from 'pino';
import type { Db } from '../db/knex.js';
import { canonicalJson } from '../crypto/index.js';
import { clears, labelRank, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import type { AuditLog } from '../audit/chain.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { BlobStore } from '../platform/blob.js';
import { TOPICS, type Bus } from '../platform/bus.js';
import type { DataKeys } from '../platform/datakeys.js';
import type { JobContext, JobQueue } from '../platform/jobs.js';
import type { Kms } from '../platform/kms.js';
import type { Notifications } from '../platform/notifications.js';
import type { QuotaService } from '../tenancy/quotas.js';
import type { Guardrails } from '../guardrails/types.js';
import type { ImageBackend } from './backends.js';
import type { ImageSafety, SafetyVerdict } from './safety.js';
import { addText, isPng, readText } from './png.js';
import { withoutManifest, type VerifyResult } from './c2pa.js';
import type { C2paSummary, ContentCredentials } from './content-credentials.js';

export interface ImageDeps {
  db: Db;
  keys: DataKeys;
  blobs: BlobStore;
  jobs: JobQueue;
  bus: Bus;
  kms: Kms;
  audit: AuditLog;
  quotas: QuotaService;
  notifications: Notifications;
  log: Logger;
  backends: ImageBackend[];
  safety: () => ImageSafety;
  safetyThreshold: number;
  /** IMAGE_SAFETY_REQUIRED (B-1007): an image nothing classified is withheld, not stored as "not classified". */
  safetyRequired?: boolean;
  guardrails: () => Guardrails;
  /** KMS key that signs provenance manifests. */
  provenanceKey: string;
  /** 1.6.0 (B-7901): C2PA content credentials, signed by the tenant CA; null when the feature is not wired. */
  c2pa?: ContentCredentials | null;
}

export type ImageState = 'queued' | 'running' | 'succeeded' | 'withheld' | 'failed' | 'cancelled' | 'hidden';

interface ImageRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  user_id: string;
  batch_id: string;
  prompt: string;
  prompt_hash: string;
  backend: string;
  model: string | null;
  width: number;
  height: number;
  seed: number;
  steps: number;
  state: ImageState;
  stage: string | null;
  step: number;
  gpu_ms: number;
  safety_score: number | null;
  label: Label;
  blob_key: string | null;
  provenance: string | null;
  /** JSON `C2paSummary` (1.6.0, B-7901). */
  c2pa?: string | null;
  job_id: string | null;
  node: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface Provenance {
  version: 1;
  job: string;
  tenant: string;
  workspace: string | null;
  user: string;
  username: string;
  createdAt: string;
  backend: string;
  model: string | null;
  seed: number;
  steps: number;
  width: number;
  height: number;
  promptSha256: string;
  label: Label;
  safety: { score: number; classifier: string } | null;
  imageSha256: string;
  generator: 'Exprsn-AI';
}

const n0 = (v: unknown) => (v == null ? null : Number(v));
const rowFrom = (r: Record<string, unknown>): ImageRow => ({ ...(r as unknown as ImageRow), width: Number(r.width), height: Number(r.height), seed: Number(r.seed), steps: Number(r.steps), step: Number(r.step ?? 0), gpu_ms: Number(r.gpu_ms ?? 0), safety_score: n0(r.safety_score), created_at: Number(r.created_at), started_at: n0(r.started_at), finished_at: n0(r.finished_at) });
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
/** tEXt chunks are Latin-1: keep the JSON ASCII. */
export const asciiJson = (v: unknown) => JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
export const PROVENANCE_KEYWORD = 'exprsn-provenance';

/** At most `n` jobs at once per worker on this instance ("one job per GPU"). */
class Slots {
  private busy = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly n: number) {}
  async acquire(signal: AbortSignal): Promise<() => void> {
    while (this.busy >= this.n) {
      await new Promise<void>((resolve, reject) => {
        const w = () => resolve();
        this.waiting.push(w);
        signal.addEventListener('abort', () => (this.waiting.splice(this.waiting.indexOf(w), 1), reject(signal.reason as Error)), { once: true });
      });
    }
    this.busy++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.busy--;
      this.waiting.shift()?.();
    };
  }
}

/**
 * Image generation. The prompt passes the `image` guardrail checkpoint and the GPU-second quota before any job is
 * queued; each image is a job on a worker (ComfyUI or diffusers), classified for safety when it comes back (unsafe
 * output is discarded, metered and raised to reviewers), signed with a provenance manifest (embedded in the PNG and
 * kept beside it), and sealed at rest with the tenant key.
 */
export class ImageService {
  private readonly slots = new Map<string, Slots>();

  constructor(private readonly d: ImageDeps) {
    for (const b of d.backends) this.slots.set(b.id, new Slots(b.concurrency));
    d.jobs.register('image.generate', (p, ctx) => this.run(String(p.id), ctx), { timeoutMs: 60 * 60_000 });
  }

  backends() {
    return this.d.backends.map((b) => ({ id: b.id, kind: b.kind, label: b.label, model: b.model, concurrency: b.concurrency, steps: b.steps }));
  }

  private backend(id: string): ImageBackend {
    const b = this.d.backends.find((x) => x.id === id);
    if (!b) throw notFound('Image backend');
    return b;
  }

  /** The GPU-second quota that applies: the workspace's when it has one, otherwise the tenant's. */
  async quota(p: Principal) {
    const scopes = p.workspaceId ? [p.workspaceId, null] : [null];
    let fallback = null;
    for (const ws of scopes) {
      const v = await this.d.quotas.view(p.tenantId, ws);
      const out = { scope: v.scope, used: v.used.gpuSecondsMonth, limit: v.gpuSecondsPerMonth, resetsAt: v.resets.monthly, raisedBy: v.scope === 'workspace' ? 'a tenant admin' : 'a system admin' };
      if (v.gpuSecondsPerMonth != null) return out;
      fallback ??= out;
    }
    return fallback!;
  }

  // ---------- requests ----------

  async generate(p: Principal, input: { prompt: string; negative?: string; backend: string; width: number; height: number; count: number; seed?: number; steps?: number; label: Label }) {
    const backend = this.backend(input.backend);
    if (!clears(p.clearance, input.label)) throw forbidden('Above your clearance.', { step: 'clearance' });
    if (p.workspaceId) {
      const ws = (await this.d.db('workspaces').where({ id: p.workspaceId }).first('label_ceiling')) as { label_ceiling: Label } | undefined;
      if (ws && labelRank(input.label) > labelRank(ws.label_ceiling)) throw forbidden(`This workspace's ceiling is ${ws.label_ceiling}.`, { step: 'zone' });
    }
    // The prompt passes the image checkpoint before any GPU time is spent.
    const g = await this.d.guardrails().check({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, checkpoint: 'image', text: input.prompt, label: input.label, principal: p, source: { kind: 'image-prompt', id: 'new' }, meta: { backend: backend.id, count: input.count } });
    if (g.action === 'block' || g.action === 'require-approval') {
      const rule = g.findings.find((f) => f.stage === 'enforce' && (f.action === 'block' || f.action === 'require-approval'));
      await this.d.audit.append({ tenantId: p.tenantId, action: 'image.prompt.blocked', kind: 'decision', actor: { user: p.userId, username: p.username }, target: { backend: backend.id }, label: input.label, detail: { action: g.action, rule: rule?.ruleName ?? null, promptSha256: sha(input.prompt) } });
      throw new HttpProblem(422, 'Prompt blocked', g.reason ?? 'The prompt failed the image guardrails. No GPU time was spent.', { extensions: { action: g.action, rule: rule?.ruleName ?? null, ruleId: rule?.ruleId ?? null } });
    }
    const prompt = g.action === 'redact' ? g.text : input.prompt;
    const [tenant, ws] = await Promise.all([this.d.db('tenants').where({ id: p.tenantId }).first('name'), p.workspaceId ? this.d.db('workspaces').where({ id: p.workspaceId }).first('name') : undefined]);
    await this.d.quotas.admit(p.tenantId, p.workspaceId ?? null, { tenantName: tenant?.name, workspaceName: ws?.name });

    const batch = ulid();
    const base = input.seed ?? randomInt(0, 2 ** 31 - input.count);
    const rows: ImageRow[] = [];
    for (let i = 0; i < input.count; i++) {
      const id = ulid();
      const row: ImageRow = { id, tenant_id: p.tenantId, workspace_id: p.workspaceId ?? null, user_id: p.userId, batch_id: batch, prompt: await this.d.keys.seal(p.tenantId, prompt, `imgprompt:${id}`), prompt_hash: sha(prompt), backend: backend.id, model: backend.model, width: input.width, height: input.height, seed: base + i, steps: input.steps ?? backend.steps, state: 'queued', stage: 'Queued', step: 0, gpu_ms: 0, safety_score: null, label: input.label, blob_key: null, provenance: null, job_id: null, node: null, error: null, created_at: Date.now() + i, started_at: null, finished_at: null };
      await this.d.db('image_jobs').insert(row);
      const job = await this.d.jobs.enqueue({ tenantId: p.tenantId, type: 'image.generate', payload: { id }, createdBy: p.userId, maxAttempts: 2 });
      await this.d.db('image_jobs').where({ id }).update({ job_id: job.id });
      rows.push({ ...row, job_id: job.id });
    }
    return { batch, redacted: g.action === 'redact', images: await Promise.all(rows.map((r) => this.view(p, r))) };
  }

  private async row(p: Principal, id: string): Promise<ImageRow> {
    const r = await this.d.db('image_jobs').where({ tenant_id: p.tenantId, id }).first();
    if (!r) throw notFound('Image');
    const x = rowFrom(r);
    if (x.user_id !== p.userId || !clears(p.clearance, x.label)) throw notFound('Image');
    return x;
  }

  async list(p: Principal, limit = 60) {
    const q = this.d.db('image_jobs').where({ tenant_id: p.tenantId, user_id: p.userId });
    if (p.workspaceId) q.andWhere({ workspace_id: p.workspaceId });
    else q.whereNull('workspace_id');
    const rows = ((await q.orderBy('created_at', 'desc').limit(limit)) as Record<string, unknown>[]).map(rowFrom).filter((r) => clears(p.clearance, r.label));
    return Promise.all(rows.map((r) => this.view(p, r)));
  }

  async get(p: Principal, id: string) {
    return this.view(p, await this.row(p, id));
  }

  /** Queue position among jobs waiting for the same worker, and a wait measured from its recent jobs. */
  private async position(r: ImageRow): Promise<{ position: number; etaMs: number | null }> {
    const ahead = (await this.d.db('image_jobs').where({ backend: r.backend, state: 'queued' }).andWhere('created_at', '<', r.created_at).count({ n: '*' }).first()) as { n: number | string } | undefined;
    const running = (await this.d.db('image_jobs').where({ backend: r.backend, state: 'running' }).count({ n: '*' }).first()) as { n: number | string } | undefined;
    const recent = (await this.d.db('image_jobs').where({ backend: r.backend, state: 'succeeded' }).whereNotNull('started_at').orderBy('finished_at', 'desc').limit(10).select('started_at', 'finished_at')) as { started_at: number; finished_at: number }[];
    const position = Number(ahead?.n ?? 0) + 1;
    const conc = this.d.backends.find((b) => b.id === r.backend)?.concurrency ?? 1;
    const avg = recent.length ? recent.reduce((s, x) => s + (Number(x.finished_at) - Number(x.started_at)), 0) / recent.length : null;
    return { position, etaMs: avg == null ? null : Math.round(avg * Math.ceil((position + Number(running?.n ?? 0)) / conc)) };
  }

  private async view(p: Principal, r: ImageRow) {
    const b = this.d.backends.find((x) => x.id === r.backend);
    const prov = r.provenance ? (JSON.parse(r.provenance) as Provenance & { signature: string }) : null;
    return {
      id: r.id,
      batchId: r.batch_id,
      state: r.state,
      stage: r.stage,
      step: r.step,
      steps: r.steps,
      width: r.width,
      height: r.height,
      seed: r.seed,
      backend: r.backend,
      backendLabel: b?.label ?? r.backend,
      model: r.model,
      node: r.node,
      gpuSeconds: Math.round(r.gpu_ms / 100) / 10,
      safety: r.safety_score == null ? null : { score: r.safety_score, classifier: prov?.safety?.classifier ?? null },
      classified: prov ? prov.safety != null : r.safety_score != null,
      label: r.label,
      prompt: clears(p.clearance, r.label) ? await this.d.keys.open(r.tenant_id, r.prompt, `imgprompt:${r.id}`) : null,
      provenance: prov ? { signed: true, createdAt: prov.createdAt, imageSha256: prov.imageSha256 } : null,
      contentCredentials: r.c2pa ? (JSON.parse(r.c2pa) as C2paSummary) : null,
      error: r.error,
      createdAt: r.created_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      ...(r.state === 'queued' ? await this.position(r) : {})
    };
  }

  async cancel(p: Principal, id: string) {
    const r = await this.row(p, id);
    if (r.state !== 'queued' && r.state !== 'running') return this.view(p, r);
    if (r.job_id) await this.d.jobs.cancel(r.tenant_id, r.job_id);
    await this.d.db('image_jobs').where({ id: r.id }).whereIn('state', ['queued', 'running']).update({ state: 'cancelled', stage: 'Cancelled', finished_at: Date.now() });
    this.emit(r.user_id, { id: r.id, state: 'cancelled' });
    return this.view(p, rowFrom(await this.d.db('image_jobs').where({ id: r.id }).first()));
  }

  /** The stored image (with its provenance chunk) and the signed sidecar. */
  async image(p: Principal, id: string): Promise<{ data: Buffer; type: string; row: ImageRow; provenance: (Provenance & { signature: string; key: string }) | null }> {
    const r = await this.row(p, id);
    if (r.state !== 'succeeded' || !r.blob_key) throw conflict(r.state === 'withheld' ? (r.safety_score == null ? 'This image was withheld because no image-safety classifier is configured, and not stored.' : 'This image was withheld by the image-safety classifier and not stored.') : `This image is ${r.state}.`);
    const sealed = await this.d.blobs.get(r.blob_key);
    if (!sealed) throw notFound('Image content');
    const data = await this.d.keys.openBytes(r.tenant_id, sealed.toString(), `image:${r.id}`);
    return { data, type: isPng(data) ? 'image/png' : 'image/jpeg', row: r, provenance: r.provenance ? JSON.parse(r.provenance) : null };
  }

  /** Checks the manifest's HMAC and that it describes these bytes. */
  async verify(p: Principal, id: string) {
    const { data, provenance } = await this.image(p, id);
    if (!provenance) return { verified: false, reason: 'No provenance manifest.' };
    const { signature, key, ...manifest } = provenance;
    const signed = await this.d.kms.verifyHmac(key, canonicalJson(manifest), signature).catch(() => false);
    const embedded = isPng(data) ? readText(data)[PROVENANCE_KEYWORD] : undefined;
    const bytesMatch = sha(isPng(data) ? this.withoutProvenance(withoutManifest(data)) : data) === manifest.imageSha256;
    return { verified: signed && bytesMatch, signature: signed, bytesMatch, embedded: embedded != null, manifest };
  }

  /** 1.6.0 (B-7901): reads the C2PA manifest back from the stored bytes and checks it against the tenant's CA. */
  async verifyContentCredentials(p: Principal, id: string): Promise<VerifyResult & { summary: C2paSummary | null }> {
    const { data, row } = await this.image(p, id);
    const summary = row.c2pa ? (JSON.parse(row.c2pa) as C2paSummary) : null;
    if (!this.d.c2pa || !isPng(data)) return { present: false, verified: false, checks: { claimHashes: false, dataHash: false, signature: false, chain: false, anchor: null, certificateValid: false }, problems: ['The image carries no C2PA manifest.'], manifest: null, signer: null, summary };
    return { ...(await this.d.c2pa.verify(row.tenant_id, data)), summary };
  }

  private withoutProvenance(png: Buffer): Buffer {
    // The manifest describes the image before its own chunk was added: remove the tEXt chunk to compare.
    let i = 8;
    const parts: Buffer[] = [png.subarray(0, 8)];
    while (i + 8 <= png.length) {
      const len = png.readUInt32BE(i);
      const type = png.subarray(i + 4, i + 8).toString('latin1');
      const whole = png.subarray(i, i + 12 + len);
      const isOurs = type === 'tEXt' && png.subarray(i + 8, i + 8 + PROVENANCE_KEYWORD.length + 1).toString('latin1') === `${PROVENANCE_KEYWORD}\0`;
      if (!isOurs) parts.push(whole);
      i += 12 + len;
    }
    return Buffer.concat(parts);
  }

  // ---------- the job ----------

  private emit(userId: string, data: Record<string, unknown>): void {
    this.d.bus.publish(TOPICS.chatEvent, { userId, event: 'image.job', data });
  }

  private async update(r: ImageRow, patch: Partial<ImageRow>): Promise<void> {
    await this.d.db('image_jobs').where({ id: r.id }).update(patch);
    Object.assign(r, patch);
    this.emit(r.user_id, { id: r.id, state: r.state, stage: r.stage, step: r.step, steps: r.steps, node: r.node, error: r.error });
  }

  private async run(id: string, ctx: JobContext): Promise<unknown> {
    const raw = await this.d.db('image_jobs').where({ id }).first();
    if (!raw) return { skipped: 'missing' };
    const r = rowFrom(raw);
    if (r.state !== 'queued' && r.state !== 'running') return { state: r.state };
    const backend = this.d.backends.find((b) => b.id === r.backend);
    if (!backend) {
      await this.update(r, { state: 'failed', stage: 'Failed', error: `The image worker ${r.backend} is no longer configured.`, finished_at: Date.now() });
      return { state: 'failed' };
    }
    const release = await this.slots.get(backend.id)!.acquire(ctx.signal);
    const started = Date.now();
    try {
      await this.update(r, { state: 'running', stage: 'Starting', started_at: started, node: `${backend.id} via ${hostname()}`.slice(0, 100) });
      const prompt = await this.d.keys.open(r.tenant_id, r.prompt, `imgprompt:${r.id}`);
      let last = 0;
      const result = await backend.generate(
        { prompt, width: r.width, height: r.height, seed: r.seed, steps: r.steps },
        {
          signal: ctx.signal,
          onProgress: (pr) => {
            const now = Date.now();
            if (now - last < 500 && pr.step !== pr.steps) return;
            last = now;
            const patch: Partial<ImageRow> = { stage: pr.stage };
            if (pr.step != null) patch.step = pr.step;
            if (pr.steps != null) patch.steps = pr.steps;
            void this.update(r, patch).catch(() => undefined);
            if (pr.step != null && pr.steps) void ctx.progress((pr.step / pr.steps) * 100, `${pr.stage}, step ${pr.step} of ${pr.steps}`).catch(() => undefined);
          }
        }
      );
      const gpuMs = result.gpuMs ?? Date.now() - started;
      // Withheld or not, the GPU time was spent: meter it.
      await this.d.quotas.record({ tenantId: r.tenant_id, workspaceId: r.workspace_id, userId: r.user_id, kind: 'image', model: result.model ?? r.model ?? backend.id, gpuMs });

      await this.update(r, { stage: 'Checking the image' });
      const safety = this.d.safety();
      let verdict: SafetyVerdict | null = await safety.classify(result.image, isPng(result.image) ? 'image/png' : 'image/jpeg', ctx.signal);
      if (!verdict && result.safety != null) verdict = { score: result.safety, categories: {}, classifier: `${backend.id} safety checker` };
      if (verdict && verdict.score >= this.d.safetyThreshold) {
        await this.update(r, { state: 'withheld', stage: 'Withheld by the image-safety classifier', safety_score: verdict.score, gpu_ms: gpuMs, step: r.steps, finished_at: Date.now() });
        await this.d.audit.append({ tenantId: r.tenant_id, action: 'image.withheld', kind: 'system', actor: { service: 'images' }, target: { image: r.id, backend: backend.id }, label: r.label, detail: { score: verdict.score, classifier: verdict.classifier, categories: verdict.categories, seed: r.seed, promptSha256: r.prompt_hash } });
        const reviewers = await this.d.notifications.usersWithRoles(r.tenant_id, ['flag-reviewer', 'guardrail-admin']);
        await this.d.notifications.notify({ tenantId: r.tenant_id, userIds: reviewers, kind: 'flag', title: 'Generated image withheld', body: `Image ${r.id.slice(-6)} scored ${verdict.score.toFixed(2)} on ${verdict.classifier} and was discarded.`, route: 'flags', label: r.label });
        return { state: 'withheld', score: verdict.score };
      }

      if (!verdict && this.d.safetyRequired) {
        // No classifier looked at it and the operator requires one: it is not stored.
        await this.update(r, { state: 'withheld', stage: 'Withheld: no image-safety classifier is configured', safety_score: null, gpu_ms: gpuMs, step: r.steps, finished_at: Date.now() });
        await this.d.audit.append({ tenantId: r.tenant_id, action: 'image.withheld', kind: 'system', actor: { service: 'images' }, target: { image: r.id, backend: backend.id }, label: r.label, detail: { reason: 'not classified', required: true, seed: r.seed, promptSha256: r.prompt_hash } });
        return { state: 'withheld', reason: 'not classified' };
      }

      const manifest: Provenance = {
        version: 1,
        job: r.id,
        tenant: r.tenant_id,
        workspace: r.workspace_id,
        user: r.user_id,
        username: String(((await this.d.db('users').where({ id: r.user_id }).first('username')) as { username?: string } | undefined)?.username ?? ''),
        createdAt: new Date().toISOString(),
        backend: backend.id,
        model: result.model ?? r.model,
        seed: r.seed,
        steps: r.steps,
        width: r.width,
        height: r.height,
        promptSha256: r.prompt_hash,
        label: r.label,
        safety: verdict ? { score: verdict.score, classifier: verdict.classifier } : null,
        imageSha256: sha(result.image),
        generator: 'Exprsn-AI'
      };
      const signature = await this.d.kms.hmac(this.d.provenanceKey, canonicalJson(manifest));
      const sidecar = { ...manifest, signature, key: this.d.provenanceKey };
      let stored = isPng(result.image) ? addText(result.image, PROVENANCE_KEYWORD, asciiJson(sidecar)) : result.image;
      // 1.6.0 (B-7901): the C2PA manifest goes in last, over the file with its HMAC chunk, signed by the tenant CA.
      let c2pa: C2paSummary | null = null;
      if (this.d.c2pa) {
        const out = await this.d.c2pa.sign(r.tenant_id, stored, { job: r.id, tenant: r.tenant_id, workspace: r.workspace_id, user: r.user_id, username: manifest.username, model: manifest.model, profile: null, backend: backend.id, seed: r.seed, steps: r.steps, width: r.width, height: r.height, promptSha256: r.prompt_hash, label: r.label, createdAt: manifest.createdAt });
        stored = out.png;
        c2pa = out.summary;
      }
      const key = `images/${r.tenant_id}/${r.id}`;
      await this.d.blobs.put(key, Buffer.from(await this.d.keys.sealBytes(r.tenant_id, stored, `image:${r.id}`)));
      await this.update(r, { state: 'succeeded', stage: 'Done', step: r.steps, gpu_ms: gpuMs, safety_score: verdict?.score ?? null, blob_key: key, provenance: JSON.stringify(sidecar), ...(c2pa ? { c2pa: JSON.stringify(c2pa) } : {}), finished_at: Date.now() });
      return { state: 'succeeded', gpuMs };
    } catch (err) {
      const reason = String((ctx.signal.reason as Error | undefined)?.message ?? '');
      if (ctx.signal.aborted && /cancel/.test(reason)) {
        await this.update(r, { state: 'cancelled', stage: 'Cancelled', finished_at: Date.now() });
        throw err;
      }
      if (ctx.signal.aborted) {
        await this.update(r, { state: 'queued', stage: 'Queued' });
        throw err;
      }
      const message = err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message;
      this.d.log.warn({ image: r.id, err: message }, 'image generation failed');
      await this.update(r, { state: 'failed', stage: 'Failed', error: message.slice(0, 1000), finished_at: Date.now() });
      return { state: 'failed', error: message };
    } finally {
      release();
    }
  }
}
