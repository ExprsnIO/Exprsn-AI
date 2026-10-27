import { createCipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ulid } from 'ulid';
import { HttpProblem } from '../http/problem.js';
import { openFromBlob, sealToBlob } from '../ops/restore.js';
import type { ByteSource } from '../platform/blob.js';
import type { Services } from '../services.js';
import { ARTIFACT_REF, type SealedDataset } from './trainer.js';

/*
 * Training data protection, worker contract 2 (B-905).
 *
 * - The dataset rows leave the platform encrypted: each submit encrypts the scrubbed JSON Lines with a fresh
 *   AES-256-GCM run key. The key is sealed with the tenant key in a one-time grant; the worker fetches it once
 *   (`POST /trainer/v1/keys/<grant>` with the grant's bearer token, over mTLS when TRAINER_CLIENT_CERT_SHA256 is set)
 *   within TRAINER_KEY_TTL_SECONDS. A second fetch, a wrong token or an expired grant is refused and audited.
 * - Checkpoints and GGUF files come back to the platform: `PUT /trainer/v1/artifacts/<grant>/<name>` streams them
 *   into the blob store encrypted with a per-artefact key that is sealed with the tenant key; `GET` streams them back
 *   to the worker to resume or convert. The artefact grant lasts for the run (its maximum duration plus a day).
 *
 * Tokens are 256-bit random values stored as SHA-256 digests.
 */

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

interface GrantRow {
  id: string;
  tenant_id: string;
  job_id: string;
  kind: 'key' | 'artifacts';
  token_hash: string;
  key_sealed: string | null;
  used_at: number | null;
  expires_at: number;
}

const grantFrom = (r: Record<string, unknown>): GrantRow => ({ ...(r as unknown as GrantRow), used_at: r.used_at == null ? null : Number(r.used_at), expires_at: Number(r.expires_at) });

export interface ArtifactRow {
  id: string;
  tenant_id: string;
  job_id: string;
  name: string;
  kind: 'checkpoint' | 'gguf' | 'other';
  blob_key: string;
  key_sealed: string;
  iv: string;
  tag: string;
  sha256: string;
  bytes: number;
  created_at: number;
}

/** What the caller of a worker endpoint presented: the bearer token and, when it can be known, the client certificate. */
export interface WorkerCaller {
  token: string | null;
  /** Hex SHA-256 of the client certificate (direct TLS, or a trusted proxy's header), or null. */
  certSha256: string | null;
  ip: string | null;
}

const normFp = (fp: string) => fp.replace(/:/g, '').toLowerCase();

export class TrainingWorkerGate {
  constructor(private readonly s: () => Services) {}

  private base(): string {
    const cfg = this.s().cfg;
    return (cfg.TRAINER_CALLBACK_URL ?? cfg.PUBLIC_URL).replace(/\/+$/, '');
  }

  private async grant(tenantId: string, jobId: string, kind: GrantRow['kind'], ttlMs: number, keySealed: (id: string) => Promise<string | null>): Promise<{ id: string; token: string; expiresAt: number }> {
    const id = ulid();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + ttlMs;
    await this.s().db('training_worker_grants').insert({ id, tenant_id: tenantId, job_id: jobId, kind, token_hash: sha(token), key_sealed: await keySealed(id), used_at: null, expires_at: expiresAt, created_at: Date.now() });
    return { id, token, expiresAt };
  }

  /** Encrypts the rows for one submit and opens the key and artefact grants. The plaintext never leaves this call. */
  async seal(job: { id: string; tenant_id: string; max_hours: number }, rows: number, plaintext: Buffer): Promise<SealedDataset> {
    const s = this.s();
    // One live artefact grant per job: a resubmit (resume) replaces it; unused key grants of earlier submits go too.
    await s.db('training_worker_grants').where({ job_id: job.id }).andWhere((q) => q.where({ kind: 'artifacts' }).orWhereNull('used_at')).delete();
    const runKey = randomBytes(32);
    const key = await this.grant(job.tenant_id, job.id, 'key', s.cfg.TRAINER_KEY_TTL_SECONDS * 1000, (id) => s.keys.sealBytes(job.tenant_id, runKey, `training-run-key:${id}`));
    const artifacts = await this.grant(job.tenant_id, job.id, 'artifacts', job.max_hours * 3_600_000 + 86_400_000, async () => null);
    const iv = randomBytes(12);
    const aad = `exprsn-train:${job.id}:${key.id}`;
    const c = createCipheriv('aes-256-gcm', runKey, iv);
    c.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([c.update(plaintext), c.final()]);
    runKey.fill(0);
    return {
      contract: 2,
      cipher: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: c.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      aad,
      sha256: sha(plaintext),
      rows,
      key: { url: `${this.base()}/trainer/v1/keys/${key.id}`, token: key.token, expiresAt: key.expiresAt },
      artifacts: { url: `${this.base()}/trainer/v1/artifacts/${artifacts.id}`, token: artifacts.token, expiresAt: artifacts.expiresAt }
    };
  }

  private async audit(g: Pick<GrantRow, 'tenant_id' | 'job_id'> | null, action: string, detail: Record<string, unknown>, caller: WorkerCaller): Promise<void> {
    const s = this.s();
    const tenantId = g?.tenant_id ?? (await s.tenants.bySlug(s.cfg.DEFAULT_TENANT))?.id;
    if (!tenantId) return;
    await s.audit.append({ tenantId, action, kind: 'system', actor: { service: 'training-worker', ip: caller.ip }, target: g ? { job: g.job_id } : {}, detail });
  }

  /** Checks a grant and its caller; throws a problem (401, 403, 410) and audits the refusal. */
  private async check(id: string, kind: GrantRow['kind'], caller: WorkerCaller): Promise<GrantRow> {
    const s = this.s();
    const r = (await s.db('training_worker_grants').where({ id, kind }).first()) as Record<string, unknown> | undefined;
    const g = r ? grantFrom(r) : null;
    const refuse = async (status: number, reason: string) => {
      await this.audit(g, kind === 'key' ? 'training.worker.key.refused' : 'training.worker.artifact.refused', { grant: id, reason }, caller);
      return new HttpProblem(status, status === 410 ? 'Gone' : status === 403 ? 'Forbidden' : 'Unauthorized', reason);
    };
    const presented = caller.token ? Buffer.from(sha(caller.token), 'hex') : Buffer.alloc(32);
    if (!g || !timingSafeEqual(presented, Buffer.from(g.token_hash, 'hex'))) throw await refuse(401, 'Unknown grant or wrong token.');
    const want = s.cfg.TRAINER_CLIENT_CERT_SHA256;
    if (want && (!caller.certSha256 || normFp(caller.certSha256) !== normFp(want))) throw await refuse(403, 'The worker must present its client certificate (TRAINER_CLIENT_CERT_SHA256).');
    if (g.expires_at < Date.now()) throw await refuse(410, 'The grant has expired.');
    if (kind === 'key' && g.used_at != null) throw await refuse(410, 'The run key was already fetched; it is released once.');
    return g;
  }

  /** Releases a run key once. */
  async releaseKey(id: string, caller: WorkerCaller): Promise<{ key: string; cipher: 'aes-256-gcm' }> {
    const s = this.s();
    const g = await this.check(id, 'key', caller);
    const n = await s.db('training_worker_grants').where({ id, used_at: null }).update({ used_at: Date.now() });
    if (!n) throw new HttpProblem(410, 'Gone', 'The run key was already fetched; it is released once.');
    const key = await s.keys.openBytes(g.tenant_id, g.key_sealed!, `training-run-key:${id}`);
    await s.db('training_worker_grants').where({ id }).update({ key_sealed: null });
    await this.audit(g, 'training.worker.key.released', { grant: id }, caller);
    return { key: key.toString('base64'), cipher: 'aes-256-gcm' };
  }

  /** Stores an artefact the worker uploads, encrypted under a key sealed with the tenant key. */
  async putArtifact(id: string, name: string, kind: string, body: ByteSource, caller: WorkerCaller): Promise<{ ref: string; name: string; sha256: string; bytes: number }> {
    const g = await this.check(id, 'artifacts', caller);
    const out = await this.storeArtifact(g.tenant_id, g.job_id, name, kind, body);
    await this.audit(g, 'training.worker.artifact.stored', { grant: id, name, kind: out.kind, bytes: out.bytes, sha256: out.sha256 }, caller);
    return { ref: out.ref, name, sha256: out.sha256, bytes: out.bytes };
  }

  /**
   * 1.5.0 (B-3803): an artefact grant for work that is not a training run (an import's GGUF conversion): the worker
   * reads the staged files and uploads the GGUF with it, exactly as for a run.
   */
  async artifactGrant(tenantId: string, jobId: string, ttlMs: number): Promise<{ url: string; token: string; expiresAt: number }> {
    await this.s().db('training_worker_grants').where({ job_id: jobId, kind: 'artifacts' }).delete();
    const g = await this.grant(tenantId, jobId, 'artifacts', ttlMs, async () => null);
    return { url: `${this.base()}/trainer/v1/artifacts/${g.id}`, token: g.token, expiresAt: g.expiresAt };
  }

  /** Seals bytes into an artefact of a job (the worker's upload, or an import's staged file); replaces one of the same name. */
  async storeArtifact(tenantId: string, jobId: string, name: string, kind: string, body: ByteSource): Promise<{ ref: string; kind: ArtifactRow['kind']; sha256: string; bytes: number }> {
    const s = this.s();
    const g = { tenant_id: tenantId, job_id: jobId };
    if (!NAME.test(name)) throw new HttpProblem(400, 'Invalid request', 'An artefact name is letters, digits, dots, dashes and underscores.');
    const k: ArtifactRow['kind'] = kind === 'checkpoint' || kind === 'gguf' ? kind : 'other';
    const blobKey = `training/${g.tenant_id}/jobs/${g.job_id}/artifacts/${name}`;
    const dek = randomBytes(32);
    const iv = randomBytes(12);
    const hash = createHash('sha256');
    const max = s.cfg.TRAINER_ARTIFACT_MAX_BYTES;
    let size = 0;
    const counted = async function* () {
      for await (const c of body) {
        size += c.length;
        if (size > max) throw new HttpProblem(413, 'Payload too large', `The artefact is above TRAINER_ARTIFACT_MAX_BYTES (${max} bytes).`);
        hash.update(c);
        yield c;
      }
    };
    const sealed = await sealToBlob({ blobs: s.blobs, key: blobKey, plain: counted(), gzip: false, dek, iv, aad: `training-artifact:${g.job_id}:${name}` });
    const row = { id: ulid(), tenant_id: g.tenant_id, job_id: g.job_id, name, kind: k, blob_key: blobKey, key_sealed: await s.keys.sealBytes(g.tenant_id, dek, `training-artifact:${g.job_id}:${name}`), iv: iv.toString('base64'), tag: sealed.tag, sha256: hash.digest('hex'), bytes: size, created_at: Date.now() };
    dek.fill(0);
    await s.db('training_artifacts').where({ job_id: g.job_id, name }).delete();
    await s.db('training_artifacts').insert(row);
    return { ref: `${ARTIFACT_REF}${name}`, kind: k, sha256: row.sha256, bytes: size };
  }

  /** Streams an artefact back to the worker (to resume from a checkpoint, or to convert). */
  async getArtifact(id: string, name: string, caller: WorkerCaller): Promise<{ stream: AsyncIterable<Buffer>; bytes: number; sha256: string; done: () => Promise<void> }> {
    const s = this.s();
    const g = await this.check(id, 'artifacts', caller);
    const a = (await s.db('training_artifacts').where({ job_id: g.job_id, name }).first()) as ArtifactRow | undefined;
    if (!a) throw new HttpProblem(404, 'Not found', 'No artefact of that name for this job.');
    const dek = await s.keys.openBytes(g.tenant_id, a.key_sealed, `training-artifact:${g.job_id}:${name}`);
    const src = await openFromBlob({ blobs: s.blobs, key: a.blob_key, dek, iv: a.iv, tag: a.tag, aad: `training-artifact:${g.job_id}:${name}`, sha256: a.sha256, gunzip: false });
    await this.audit(g, 'training.worker.artifact.read', { grant: id, name }, caller);
    return { stream: src.stream, bytes: Number(a.bytes), sha256: a.sha256, done: src.done };
  }

  /** The artefacts stored for a job (for the model card). */
  async artifacts(tenantId: string, jobId: string): Promise<{ name: string; kind: string; bytes: number; sha256: string; createdAt: number }[]> {
    return ((await this.s().db('training_artifacts').where({ tenant_id: tenantId, job_id: jobId }).orderBy('created_at')) as ArtifactRow[]).map((a) => ({ name: a.name, kind: a.kind, bytes: Number(a.bytes), sha256: a.sha256, createdAt: Number(a.created_at) }));
  }
}
